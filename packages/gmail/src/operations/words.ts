import { CommsError } from '@agentcomms/core';

/**
 * A word an argument takes, checked against the words there are: the word, `undefined` when none was given, or the
 * USAGE refusal naming the choices.
 *
 * The tools take these arguments as strings and leave the check to the operation — as `gmail_inbox_policy` and
 * `gmail_inbox_reauth` do with `sendPolicy`, `changePolicy` and `tier` — because a schema enum refused a word that is
 * not one with the SDK's "Input validation error", which carries no `error.code` for an agent to act on, while the
 * command refused the same word as USAGE. Checked here, both surfaces refuse it with the same code, and the words
 * each accepts come from one list.
 */
export function oneOf<const T extends string>(
  value: string | undefined,
  words: readonly T[],
  what: string,
): T | undefined {
  if (value === undefined) return undefined;
  if ((words as readonly string[]).includes(value)) return value as T;
  throw new CommsError('USAGE', `"${value}" is not ${what}`, { hint: `Use ${spoken(words)}.` });
}

/**
 * A list of words, each checked as {@link oneOf} checks one: the list, `undefined` when none was given, or the USAGE
 * refusal of the first that is not one of the words there are — not a list with it quietly left out.
 */
export function allOf<const T extends string>(
  values: readonly string[] | undefined,
  words: readonly T[],
  what: string,
): T[] | undefined {
  if (values === undefined) return undefined;
  return values.map((value) => oneOf(value, words, what) as T);
}

/** `a`, `a or b`, `a, b or c`: the choices as a person would say them. */
export function spoken(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}
