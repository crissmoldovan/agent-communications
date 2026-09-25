import { CommsError } from './errors.ts';

/**
 * A whole number as it was given: a string of digits and nothing else (surrounding spaces aside), or a number that is
 * whole — and `NaN` for anything else.
 *
 * `Number.parseInt` read `abc` as NaN, `12abc` as 12 and `1e2` as 1; `Number` reads `1e2` as 100, `0x10` as 16 and an
 * empty string as 0. Each of those is a number nobody typed, so none of them is read as one here. A value too large to
 * hold exactly is not one either: it would be used as some other number.
 */
export function readWholeNumber(raw: unknown): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

/** The range a number option takes, and what it is called where it was given. */
export interface WholeNumberRule {
  /** The option as its caller spells it: `--limit` on a command line, `limit` in a tool call. */
  name: string;
  min: number;
  /** The most it may be. Left out, any whole number from `min` up. */
  max?: number | undefined;
  /** What the number means where the range alone does not say — that 0 picks a free port, say. */
  hint?: string | undefined;
}

/**
 * A number option, checked rather than coerced: the number, `undefined` when none was given, or a USAGE refusal that
 * names the option and its range.
 *
 * One check for every command line's number options — `agentcomms`, `agent-gmail` and `agent-slack` — and for the
 * operations those commands share with their tools, so a number the command refuses is refused by the tool in the
 * same words, and nothing reads `--limit 1e2` as 1 or `--port abc` as no port at all.
 */
export function wholeNumber(raw: unknown, rule: WholeNumberRule): number | undefined {
  if (raw === undefined) return undefined;
  const value = readWholeNumber(raw);
  if (Number.isNaN(value) || value < rule.min || (rule.max !== undefined && value > rule.max)) {
    const range = rule.max === undefined ? `of ${rule.min} or more` : `from ${rule.min} to ${rule.max}`;
    const hint = rule.hint ?? (Number.isNaN(value) ? 'Digits only: no sign, decimal point, exponent or unit.' : null);
    throw new CommsError(
      'USAGE',
      `${rule.name} "${String(raw)}" is not a whole number ${range}`,
      hint === null ? {} : { hint },
    );
  }
  return value;
}
