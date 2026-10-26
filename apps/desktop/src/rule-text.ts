/**
 * The rule as text (0.33.0, design 2026-10-26-rules-that-act-0330 §3.2): `@agentcomms/events`' own printer and parser,
 * from the package's source, so the text the editor shows is exactly the one the event service's language defines and
 * round-trips. They have no I/O and import nothing but each other: what the bundle gains is that module alone. The
 * canonical JSON stays what is approved; the text is a view of it.
 */
export {
  parseRuleText,
  printRuleText,
  type RuleTextError,
  type RuleTextParseResult,
} from '../../../packages/events/src/rule-text/index.ts';
