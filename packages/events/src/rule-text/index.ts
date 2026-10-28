/**
 * The rule text (0.33.0 design §3.2): a small language a person reads and edits, which prints a rule document and
 * parses back to exactly the same one. `GRAMMAR.md` beside this file is its grammar.
 */
export { parseRuleText, ruleTextRawSites } from './parse.ts';
export { printRuleText } from './print.ts';
export type { RuleTextError, RuleTextParseResult, RuleTextRawSite } from './types.ts';
