/**
 * RFC 3339 instants, parsed and compared exactly, never through `Date` (events phase A plan, decision 14).
 *
 * `date-time` is RFC 3339's `date-time` as JSON Schema 2020-12 reads it: `T` and `Z` in either case, an offset
 * required, any number of fraction digits, real calendar days of the proleptic Gregorian calendar, and a leap second
 * only where the UTC equivalent is 23:59:60. An instant is compared as a UTC day, a second of that day and its
 * fraction digits, all exactly, so a Slack `ts`'s microseconds are kept and `.1` equals `.100000`. A leap second sorts
 * after 23:59:59.999… and before the next midnight.
 */

import { EventsError } from '../result.ts';

/** An instant in UTC: days since 1970-01-01, the second of that day (86 400 for a leap second), and the fraction. */
interface Instant {
  readonly day: number;
  readonly second: number;
  /** The fraction's digits, trailing zeros dropped, so equal fractions are equal strings. */
  readonly fraction: string;
}

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

/** The `width`-digit decimal number at `at` in `text`, or -1 if any of them is not an ASCII digit. */
function digits(text: string, at: number, width: number): number {
  let value = 0;
  for (let i = at; i < at + width; i += 1) {
    const code = text.charCodeAt(i);
    if (!isDigit(code)) return -1;
    value = value * 10 + (code - 0x30);
  }
  return value;
}

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days from 1970-01-01 to a proleptic Gregorian date (H. Hinnant's `days_from_civil`). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** `text` as a UTC instant, or `undefined` when it is not an RFC 3339 `date-time`. */
function parseInstant(text: string): Instant | undefined {
  // YYYY-MM-DDTHH:MM:SS, then an optional fraction, then Z or ±HH:MM.
  if (text.length < 20) return undefined;
  const year = digits(text, 0, 4);
  const month = digits(text, 5, 2);
  const day = digits(text, 8, 2);
  const hour = digits(text, 11, 2);
  const minute = digits(text, 14, 2);
  const second = digits(text, 17, 2);
  if (text[4] !== '-' || text[7] !== '-' || text[13] !== ':' || text[16] !== ':') return undefined;
  if (text[10] !== 'T' && text[10] !== 't') return undefined;
  if (year < 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 60) return undefined;
  let at = 19;
  let fraction = '';
  if (text[at] === '.') {
    const start = at + 1;
    at = start;
    while (at < text.length && isDigit(text.charCodeAt(at))) at += 1;
    if (at === start) return undefined;
    fraction = text.slice(start, at);
  }
  let offset: number;
  if (text[at] === 'Z' || text[at] === 'z') {
    if (at + 1 !== text.length) return undefined;
    offset = 0;
  } else if (text[at] === '+' || text[at] === '-') {
    if (at + 6 !== text.length || text[at + 3] !== ':') return undefined;
    const hours = digits(text, at + 1, 2);
    const minutes = digits(text, at + 4, 2);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
    offset = (text[at] === '+' ? 1 : -1) * (hours * 3600 + minutes * 60);
  } else {
    return undefined;
  }
  // To UTC. A leap second is placed by its 23:59:59 neighbour, which must be 23:59:59 UTC, and then follows it.
  const local = daysFromCivil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + Math.min(second, 59) - offset;
  const utcDay = Math.floor(local / 86_400);
  let utcSecond = local - utcDay * 86_400;
  if (second === 60) {
    if (utcSecond !== 86_399) return undefined;
    utcSecond = 86_400;
  }
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === '0') end -= 1;
  return { day: utcDay, second: utcSecond, fraction: fraction.slice(0, end) };
}

/** Whether `value` is an RFC 3339 `date-time` as decision 14 reads it. */
export function isInstant(value: unknown): value is string {
  return typeof value === 'string' && parseInstant(value) !== undefined;
}

const sign = (difference: number) => (difference < 0 ? -1 : difference > 0 ? 1 : 0);

/** Two fractions' digits, compared as the decimals they are: `1` equals `100000`, and `000999` is below `001`. */
function compareFractions(a: string, b: string): number {
  const length = Math.max(a.length, b.length);
  const left = a.padEnd(length, '0');
  const right = b.padEnd(length, '0');
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Orders two RFC 3339 instants by the moment each denotes: -1, 0 or 1, whatever their offsets and fraction lengths.
 * Throws `EventsError` (`FORMAT_INVALID`) for a value that is not one: callers compare values that already validated.
 */
export function compareInstants(a: string, b: string): -1 | 0 | 1 {
  const left = parseInstant(a);
  const right = parseInstant(b);
  if (left === undefined || right === undefined) {
    throw new EventsError('FORMAT_INVALID', `compareInstants was given a value that is not an RFC 3339 date-time`);
  }
  return (sign(left.day - right.day) ||
    sign(left.second - right.second) ||
    compareFractions(left.fraction, right.fraction)) as -1 | 0 | 1;
}
