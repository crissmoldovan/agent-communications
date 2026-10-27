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
const SESSION_KEY = new RegExp(grammar.sessionKey, 'u');
const QUEUE_ITEM_ID = new RegExp(grammar.queueItemId, 'u');
const RULE_ID = new RegExp(grammar.ruleId, 'u');
const LANE_NAME = new RegExp(grammar.laneName, 'u');
const WINDOW_ID = new RegExp(grammar.windowId, 'u');
const DELIVERY_ID = new RegExp(grammar.deliveryId, 'u');
const LOOPBACK_URL = new RegExp(grammar.loopbackUrl, 'u');
const LOCAL_MODEL = new RegExp(grammar.localModel, 'u');
const PERSON_ID = new RegExp(grammar.personId, 'u');
const SEARCH_HANDLE = new RegExp(grammar.searchHandle, 'u');
const SEARCH_MODEL_ADDRESS = new RegExp(grammar.searchModelAddress, 'u');
const REFUSED_IN_TEXT: readonly (readonly number[])[] = grammar.searchText.refused;
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

/** A Slack channel, DM or person, as Slack shows its id (0.34.0's "In one conversation"). */
export function isSlackConversation(value: string): boolean {
  return isPlainValue(value) && SLACK_CONVERSATION.test(value);
}

/** An address, or `@domain` for everyone there (0.34.0's "For some people"). */
export function isMailConversation(value: string): boolean {
  return isPlainValue(value) && MAIL_CONVERSATION.test(value);
}

/** `none`, or a comma list of known acts, each at most once. */
export function isActs(value: string): boolean {
  if (!isPlainValue(value)) return false;
  if (value === 'none') return true;
  const listed = value.split(',');
  return listed.every((act, index) => ACTS.includes(act) && !listed.slice(0, index).includes(act));
}

/** An activity session's key, as core makes it: sixteen lowercase hex digits. */
export function isSessionKey(value: string): boolean {
  return isPlainValue(value) && SESSION_KEY.test(value);
}

/** A queue item's id, as the event service makes it: `qi_` and 26 of Crockford's letters. */
export function isQueueItemId(value: string): boolean {
  return isPlainValue(value) && QUEUE_ITEM_ID.test(value);
}

/**
 * A rule's id, as the Queue screen filters by one: a letter or digit, then up to 127 letters, digits, `.`, `_`, `:`,
 * `@` or `-`. A rule whose id is outside it is shown, and never offered as a filter.
 */
export function isRuleId(value: string): boolean {
  return isPlainValue(value) && RULE_ID.test(value);
}

/**
 * A lane's name, as the event service takes one (design 2026-10-25-routing §3.1): 1 to 40 lowercase letters, digits and
 * `-`. A lane whose name is outside it is shown, and the app never names it in a call.
 */
export function isLaneName(value: string): boolean {
  return isPlainValue(value) && LANE_NAME.test(value);
}

/**
 * The agent window a lane is bound to, as `lane bind --window` takes it (B1): a Claude Code session id, a lowercase
 * UUID; or an activity session's key, sixteen lowercase hex digits.
 */
export function isWindowId(value: string): boolean {
  return isPlainValue(value) && WINDOW_ID.test(value);
}

/**
 * A delivery's id, as the Deliveries screen names one (0.32.0): a letter or digit, then up to 127 letters, digits, `_`
 * or `-`. The event service makes each a lowercase UUID; a delivery whose id is outside it is shown, and never opened.
 */
export function isDeliveryId(value: string): boolean {
  return isPlainValue(value) && DELIVERY_ID.test(value);
}

/**
 * A local model server's URL, as `judge setup local-endpoint --url` takes it (0.32.0): plain HTTP to the literal
 * 127.0.0.1 or [::1], a port from 1 to 65535, and no path but `/` or `/v1/systemone`.
 */
export function isLoopbackUrl(value: string): boolean {
  if (!isPlainValue(value)) return false;
  const port = LOOPBACK_URL.exec(value)?.[1];
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65_535;
}

/** A local model's name: a letter or digit, then up to 127 letters, digits, `.`, `_`, `:`, `/` or `-`. */
export function isLocalModel(value: string): boolean {
  return isPlainValue(value) && LOCAL_MODEL.test(value);
}

/** A person's id, as core makes one (0.35.0, design 2026-10-26-local-search S5): `p_` and 26 of Crockford's letters. */
export function isPersonId(value: string): boolean {
  return isPlainValue(value) && PERSON_ID.test(value);
}

/** A handle, as `search people` lists one and `search unlink` takes it: `email:<address>` or `slack:<team>/<user>`. */
export function isSearchHandle(value: string): boolean {
  return isPlainValue(value) && SEARCH_HANDLE.test(value);
}

/**
 * Search's local model server (0.35.0, S9), as `search model set` takes it: plain HTTP to the literal 127.0.0.1 or
 * [::1], a port from 1 to 65535, and no path but `/`.
 */
export function isSearchModelAddress(value: string): boolean {
  if (!isPlainValue(value)) return false;
  const port = SEARCH_MODEL_ADDRESS.exec(value)?.[1];
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65_535;
}

/**
 * Whether core refuses a character in a search's words or a person's label: a control (a line break and a tab among
 * them), DEL, a C1 control, or one of the invisible and bidi characters core's `chars.ts` names.
 */
export function refusedInSearchText(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return REFUSED_IN_TEXT.some(([from = 0, to = 0]) => code >= from && code <= to);
}

/** A search's words (0.35.0, §8): 1 to 500 characters, not only spaces, and none core refuses. It may start with `-`. */
export function isSearchQuery(value: string): boolean {
  const chars = [...value];
  return value.trim() !== '' && chars.length <= grammar.searchText.queryLimit && !chars.some(refusedInSearchText);
}

/** The name a person gives someone (0.35.0, `search label`): 1 to 80 characters, no space at either end, none refused. */
export function isPersonLabel(value: string): boolean {
  const chars = [...value];
  return (
    value !== '' &&
    value.trim() === value &&
    chars.length <= grammar.searchText.labelLimit &&
    !chars.some(refusedInSearchText)
  );
}

/** The longest search, in characters, and the longest label. */
export const SEARCH_QUERY_LIMIT: number = grammar.searchText.queryLimit;
export const PERSON_LABEL_LIMIT: number = grammar.searchText.labelLimit;

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
