/**
 * The grammars an argument is checked against before the UI hands it to Rust, read from `grammar.json`, which the Rust
 * side reads too (`src-tauri/src/grammar.rs`): a form says what is wrong while the person types, and Rust refuses it
 * again whatever the UI said. `src/test/grammar.test.ts` checks the file agrees with core.
 */
import { z } from 'zod';
import grammar from '../grammar.json';

const LIMIT: number = grammar.limit;
const APPROVAL_ID = new RegExp(grammar.approvalId, 'u');
const ALIAS = new RegExp(grammar.alias, 'u');
const NAME = new RegExp(grammar.name, 'u');
const SLACK_CONVERSATION = new RegExp(grammar.slackConversation, 'u');
const MAIL_CONVERSATION = new RegExp(grammar.mailConversation, 'u');
const RESERVED: readonly string[] = grammar.reserved;
const ACTS: readonly string[] = grammar.acts;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/** Not empty, not starting with `-`, no control or format character, and at most 320 characters. */
export function isPlainValue(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && [...value].length <= LIMIT && !CONTROL_OR_FORMAT.test(value);
}

/** `ap_` and 26 of Crockford's letters. */
export function isApprovalId(value: string): boolean {
  return isPlainValue(value) && APPROVAL_ID.test(value);
}

/** `organisation/platform[-qualifier]`, its organisation not a word Windows reserves, or a version-1 alias. */
export function isAccountName(value: string): boolean {
  if (!isPlainValue(value)) return false;
  if (ALIAS.test(value)) return true;
  const parts = NAME.exec(value);
  return parts !== null && !RESERVED.includes(parts[1] ?? '');
}

/** A Slack conversation or person, or an address or `@domain`. */
export function isConversation(value: string): boolean {
  return isPlainValue(value) && (SLACK_CONVERSATION.test(value) || MAIL_CONVERSATION.test(value));
}

/** `none`, or a comma list of known acts, each at most once. */
export function isActs(value: string): boolean {
  if (!isPlainValue(value)) return false;
  if (value === 'none') return true;
  const listed = value.split(',');
  return listed.every((act, index) => ACTS.includes(act) && !listed.slice(0, index).includes(act));
}

/** The acts a rule can allow, in the order the form shows them. */
export const KNOWN_ACTS: readonly string[] = ACTS;

/** For a form's `Field`: each refusal is an issue, as every Standard Schema validator reports one. */
export const approvalIdSchema = z.string().refine(isApprovalId, { message: 'That is not an approval id.' });
export const accountNameSchema = z
  .string()
  .refine(isAccountName, { message: 'Names look like organisation/platform, such as example/gmail.' });
export const conversationSchema = z
  .string()
  .refine(isConversation, { message: 'A Slack channel or person id, or an address or @domain.' });
export const actsSchema = z.string().refine(isActs, { message: 'none, or acts from the list, each once.' });
