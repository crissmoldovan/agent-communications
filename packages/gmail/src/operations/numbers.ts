import { wholeNumber } from '@agentcomms/core';
import type { GmailContext } from '../context.ts';

/** A number an operation takes: what it is called on each surface, and the range the operation works in. */
export interface NumberOption {
  /** As a command line spells it: `--max-chars`. */
  readonly flag: string;
  /** As a tool call spells it: `maxChars`. */
  readonly arg: string;
  readonly min: number;
  /** The most it may be. Left out, any whole number from `min` up. */
  readonly max?: number | undefined;
  readonly hint?: string | undefined;
}

/**
 * A number option as given, checked by the operation for both surfaces — as `oneOf` checks a word: the number,
 * `undefined` when none was given, or a USAGE refusal naming the option as its caller spells it, and the range.
 *
 * The command handed these over as `Number.parseInt` read them — `--limit abc` as NaN, `--limit 1e2` as 1,
 * `--max-chars 12abc` as 12 — and the operations clamped whatever arrived, so a tool's `limit: 500` searched 50 and
 * said nothing. Checked here, before anything is read, a number is taken as typed or refused, from either surface.
 */
export function numberOption(
  context: Pick<GmailContext, 'surface'>,
  raw: unknown,
  option: NumberOption,
): number | undefined {
  return wholeNumber(raw, {
    name: context.surface === 'mcp' ? option.arg : option.flag,
    min: option.min,
    max: option.max,
    hint: option.hint,
  });
}
