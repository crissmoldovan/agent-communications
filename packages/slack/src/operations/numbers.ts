import { wholeNumber } from '@agentcomms/core';

/** A number an operation takes: what it is called on each surface, and the range the operation works in. */
export interface NumberOption {
  /** As a command line spells it: `--limit`. */
  readonly flag: string;
  /** As a tool call spells it: `limit`. */
  readonly arg: string;
  readonly min: number;
  /** The most it may be. Left out, any whole number from `min` up. */
  readonly max?: number | undefined;
}

/**
 * A number option as given, checked by the operation for both surfaces: the number, `undefined` when none was given,
 * or a USAGE refusal naming the option as its caller spells it, and the range — core's `wholeNumber`, as Gmail's
 * `numberOption` calls it.
 *
 * In the operation rather than in each surface's parser, so the command and the tool refuse the same number in the
 * same words. `search` and `files` clamped a limit above the page they read, on both surfaces, and said nothing:
 * `slack_search {limit: 500}` searched 100, where `gmail_search {limit: 500}` is refused.
 */
export function numberOption(
  surface: 'cli' | 'mcp' | undefined,
  raw: unknown,
  option: NumberOption,
): number | undefined {
  return wholeNumber(raw, {
    name: surface === 'mcp' ? option.arg : option.flag,
    min: option.min,
    max: option.max,
  });
}
