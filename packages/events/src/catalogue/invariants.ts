import { compareInstants } from '../formats/instant.ts';
import { canonicalJson, type JsonValue } from '../json.ts';
import { getPointer } from '../pointer.ts';
import type { Issue } from '../result.ts';
import type { CatalogueInvariant } from './types.ts';

const invalid = (rule: string, pointer?: string): Issue =>
  pointer === undefined
    ? { code: 'EVENT_INVARIANT_INVALID', message: `the event does not satisfy the ${rule} invariant` }
    : { code: 'EVENT_INVARIANT_INVALID', pointer, message: `the event does not satisfy the ${rule} invariant` };

function equal(value: JsonValue, pointers: readonly string[]): boolean {
  const values = pointers.map((pointer) => getPointer(value, pointer));
  const first = values[0];
  if (first?.found !== true) return false;
  return (
    values.every((found) => found.found) &&
    values.every((found) => canonicalJson(found.value) === canonicalJson(first.value))
  );
}

function slackInstant(ts: string): string | undefined {
  const match = /^([0-9]+)\.([0-9]{6})$/u.exec(ts);
  if (!match) return undefined;
  const seconds = BigInt(match[1] ?? '');
  const day = seconds / 86_400n;
  const time = seconds % 86_400n;
  const z = day + 719_468n;
  const era = z / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1460n + doe / 36_524n - doe / 146_096n) / 365n;
  let year = yoe + era * 400n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const date = doy - (153n * mp + 2n) / 5n + 1n;
  const month = mp + (mp < 10n ? 3n : -9n);
  if (month <= 2n) year += 1n;
  if (year < 0n || year > 9999n) return undefined;
  const hour = time / 3600n;
  const minute = (time % 3600n) / 60n;
  const second = time % 60n;
  const pad = (number: bigint, width: number) => number.toString().padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(date, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${match[2] ?? ''}Z`;
}

function whatsappKey(value: JsonValue, pointers: readonly string[]): boolean {
  const message = getPointer(value, pointers[0] ?? '/messageId');
  const sender = getPointer(value, pointers[1] ?? '/sender/id');
  if (!message.found || !sender.found || typeof message.value !== 'string' || typeof sender.value !== 'string')
    return false;
  try {
    const key: unknown = JSON.parse(message.value);
    return (
      Array.isArray(key) &&
      key.length === 4 &&
      key.every((part) => typeof part === 'string' && part.length > 0) &&
      key[0] === 'wa-msg' &&
      key[2] === sender.value &&
      canonicalJson(key) === message.value
    );
  } catch {
    return false;
  }
}

/** Appendix A's cross-field rules, after the generated Zod schema accepted the event. */
export function checkInvariants(value: JsonValue, invariants: readonly CatalogueInvariant[]): readonly Issue[] {
  const issues: Issue[] = [];
  for (const invariant of invariants) {
    if (invariant.rule === 'sorted-utf8') continue;
    const [first, second] = invariant.pointers;
    if (invariant.rule === 'same-instant') {
      const a = first === undefined ? { found: false as const } : getPointer(value, first);
      const b = second === undefined ? { found: false as const } : getPointer(value, second);
      if (
        !a.found ||
        !b.found ||
        typeof a.value !== 'string' ||
        typeof b.value !== 'string' ||
        compareInstants(a.value, b.value) !== 0
      )
        issues.push(invalid(invariant.rule, first));
    } else if (invariant.rule === 'identical') {
      if (!equal(value, invariant.pointers)) issues.push(invalid(invariant.rule, first));
    } else if (invariant.rule === 'differs') {
      if (equal(value, invariant.pointers)) issues.push(invalid(invariant.rule, first));
    } else if (invariant.rule === 'non-empty-either') {
      const a = first === undefined ? { found: false as const } : getPointer(value, first);
      const b = second === undefined ? { found: false as const } : getPointer(value, second);
      if (
        !a.found ||
        !b.found ||
        (!Array.isArray(a.value) && !Array.isArray(b.value)) ||
        (Array.isArray(a.value) && Array.isArray(b.value) && a.value.length === 0 && b.value.length === 0)
      )
        issues.push(invalid(invariant.rule, first));
    } else if (invariant.rule === 'disjoint') {
      const a = first === undefined ? { found: false as const } : getPointer(value, first);
      const b = second === undefined ? { found: false as const } : getPointer(value, second);
      if (!a.found || !b.found || !Array.isArray(a.value) || !Array.isArray(b.value)) {
        issues.push(invalid(invariant.rule, first));
      } else {
        const left: readonly JsonValue[] = a.value;
        const right: readonly JsonValue[] = b.value;
        if (left.some((item) => right.some((other) => canonicalJson(item) === canonicalJson(other)))) {
          issues.push(invalid(invariant.rule, first));
        }
      }
    } else if (invariant.rule === 'length-equals') {
      const items = first === undefined ? { found: false as const } : getPointer(value, first);
      const count = second === undefined ? { found: false as const } : getPointer(value, second);
      if (
        items.found &&
        (!Array.isArray(items.value) ||
          !count.found ||
          typeof count.value !== 'number' ||
          items.value.length !== count.value)
      )
        issues.push(invalid(invariant.rule, first));
    } else if (invariant.rule === 'slack-ts-instant') {
      const ts = first === undefined ? { found: false as const } : getPointer(value, first);
      const occurredAt = second === undefined ? { found: false as const } : getPointer(value, second);
      const instant = ts.found && typeof ts.value === 'string' ? slackInstant(ts.value) : undefined;
      if (
        !instant ||
        !occurredAt.found ||
        typeof occurredAt.value !== 'string' ||
        compareInstants(instant, occurredAt.value) !== 0
      )
        issues.push(invalid(invariant.rule, first));
    } else if (invariant.rule === 'whatsapp-message-key' && !whatsappKey(value, invariant.pointers)) {
      issues.push(invalid(invariant.rule, first));
    }
  }
  return issues;
}
