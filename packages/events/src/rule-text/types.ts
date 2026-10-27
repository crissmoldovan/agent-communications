import type { JsonObject } from '../json.ts';

/** A problem in a rule's text: where it is, 1-based, and what to do about it. */
export interface RuleTextError {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** Where a rule's text wrote JSON for itself with `raw`: the line and column of the word, 1-based. */
export interface RuleTextRawSite {
  readonly line: number;
  readonly column: number;
}

/**
 * What `parseRuleText` returns. A parsed document is the rule document the text says, field for field; it is not yet
 * checked against the catalogue, the accounts or the targets that exist. The event service does that when the
 * document is submitted, as it does for any rule document.
 */
export type RuleTextParseResult =
  | { readonly ok: true; readonly doc: JsonObject }
  | { readonly ok: false; readonly errors: readonly RuleTextError[] };
