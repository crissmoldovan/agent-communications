import {
  type ApprovalObject,
  type ApprovalRecord,
  ackNotice,
  beginsAsAgentLabelled,
  CommsError,
  canonicalJson,
  type ExactPlace,
  type Expectation,
  effectiveAccountSendPolicy,
  effectiveStanding,
  ensureSendEpochConfig,
  handoffSentence,
  type LegacyDrainReport,
  mintStandingUse,
  STANDING_BIG_ROOM,
  STANDING_FRESH_MS,
  STANDING_THREAD_LOOKBACK_MS,
  type StandingAct,
  type StandingBinding,
  type StandingContent,
  type StandingNotice,
  type StandingRefusal,
  sha256Hex,
  standingRefused,
  truncateDisplay,
} from '@agentcomms/core';
import { callSlack, type SlackCall } from '../api/call.ts';
import { escapeForSlack, payloadOf } from '../compose/blocks.ts';
import { openDraftStore, type SlackDraft } from '../compose/drafts.ts';
import type { SlackContext } from '../context.ts';
import { actRefusal, requireAllowed } from './behaviour.ts';
import { type GateDeps, gateDepsFor } from './gate.ts';
import { AS_AGENT, botIsMember, decideLabel, REACTS_AS_APP, reactionLine } from './label.ts';
import { requireMessageAt } from './message.ts';
import { NameBook } from './people.ts';
import { isGuest, type PlaceFacts, readPlace } from './places.ts';
import {
  expectationFor,
  type LabelView,
  labelView,
  messageOf,
  postPrepared,
  reactionApprovalFields,
  reactPrepared,
  risksOf,
  roomOf,
  viewPost,
} from './send.ts';
import type { SessionDeps } from './session.ts';
import { onlyStaticBlocks } from './static-blocks.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * Using a standing approval: `agent-slack ack` and `slack_ack` (design 2026-10-19-standing-approvals, S4–S10), one
 * operation for both.
 *
 * The agent chooses whether to acknowledge a message that has just arrived, and with which of the contents the person
 * wrote — named by its digest. It never writes the words, and it cannot pick an old message, one among many, or a new
 * place: what just happened fixes the target. The gate builds the payload itself, from the content, the channel and the
 * thread, and the act goes out as the agent.
 *
 * In order (S9):
 * 1. **Before anything is read:** the content is a digest; the workspace's send policy is not `never`; the standing
 *    approval is this workspace's, approved, and holds that content.
 * 2. **The Slack reads, with no lock held:** the message and its thread (S4) — the message from another person, by
 *    allow-list, and its thread's parent from another person too, or the person's own when they posted it themselves;
 *    nothing to press; fresh; the newest from someone else — the place and its members (S5), who the act goes as (S7),
 *    and spec 2's rules (`allowedAct`).
 * 3. **The mint** (`mintStandingUse`), under the account's acknowledgement ledger lock and then the standing record's:
 *    the count is spent there, never refunded, and a one-shot child minted.
 * 4. **The pause:** 5 to 30 seconds from the CSPRNG (`standingPause`), so the moment an acknowledgement appears is
 *    not the agent's to choose; the act's own time is recorded beside the decision's.
 * 5. **The newest-message read again**, since it is one call: refused now, the child is revoked and the count stays
 *    spent.
 * 6. **The act, through the existing path:** `postPrepared` or `reactPrepared`, whose claim (`claimOrHandOver`) asks
 *    the rules again — and core reads the standing approval again — and takes a child only from here.
 * 7. **After it:** the outcome in the ledger, a notice on the person's screen, and the audit — none of which ever fails
 *    the act.
 *
 * There is no new send path: the child is claimed and sent as every Slack act is.
 */

/** One acknowledgement: which standing approval, the message, and the content by its digest. Nothing else. */
export interface AckRequest {
  readonly standingId: string;
  readonly channel: string;
  readonly ts: string;
  /** The content's digest, as `standing list` and `comms_standing` show it — never its position, never its words. */
  readonly content: string;
}

export interface AckResult {
  readonly act: StandingAct;
  readonly standingId: string;
  /** The one-shot child the act was sent under. */
  readonly approvalId: string;
  readonly channel: string;
  readonly ts: string;
  /** For a reply: the message it posted, when Slack said which. */
  readonly posted?: { readonly ts?: string | undefined } | undefined;
  /** Who it went out as: the app, or the person labelled (S7). Never the person unlabelled. */
  readonly label?: LabelView | undefined;
  /** What became of the notice on the person's screen: `raised`, `failed: <why>`, or `none` with no notifier. */
  readonly notice: string;
  /** Where the child stands now that the act is made. */
  readonly approval: ApprovalObject;
  readonly legacyDrain?: LegacyDrainReport | undefined;
}

type Raw = Record<string, unknown>;

const HEX64 = /^[0-9a-f]{64}$/;
/** A person's Slack id: `U…`, or `W…` on Enterprise Grid. Slackbot's is one of these, and is refused by name. */
const PERSON = /^[UW][A-Z0-9]{2,}$/;
const SLACKBOT = 'USLACKBOT';
/** At most this many pages of a thread are read: a thread that needs more is not read at all. */
const THREAD_PAGES = 10;
const PAGE_SIZE = 200;
/** How many of the channel's messages since the target are read: more than this, and it is not the newest. */
const CHANNEL_SINCE = 100;
const DAY_MS = 86_400_000;

/**
 * What a legacy attachment can carry for a person to press, or a form to fill: looked for however deep, beside the
 * allow-list of blocks (`onlyStaticBlocks`), which is what decides.
 */
const INTERACTIVE = new Set([
  'actions',
  'input',
  'button',
  'checkboxes',
  'radio_buttons',
  'overflow',
  'datepicker',
  'datetimepicker',
  'timepicker',
  'plain_text_input',
  'email_text_input',
  'number_text_input',
  'url_text_input',
  'rich_text_input',
  'file_input',
  'static_select',
  'external_select',
  'users_select',
  'conversations_select',
  'channels_select',
  'multi_static_select',
  'multi_external_select',
  'multi_users_select',
  'multi_conversations_select',
  'multi_channels_select',
  'workflow_button',
]);

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** Slack's ts order: the seconds, then the sequence within them. */
function compareTs(a: string, b: string): number {
  const [aSeconds = '0', aSequence = '0'] = a.split('.');
  const [bSeconds = '0', bSequence = '0'] = b.split('.');
  const seconds = Number(aSeconds) - Number(bSeconds);
  return seconds !== 0 ? seconds : Number(aSequence.padEnd(6, '0')) - Number(bSequence.padEnd(6, '0'));
}

/** When a ts says its message arrived, in milliseconds. */
function msOf(ts: string): number {
  const [seconds = '0', sequence = '0'] = ts.split('.');
  return Number(seconds) * 1000 + Math.floor(Number(sequence.padEnd(6, '0').slice(0, 6)) / 1000);
}

/**
 * What an agent is told when a standing approval does not cover an act: stop, and ask the person — with the located
 * `standing list`, which shows what each covers, and never a command that makes or widens one.
 */
function askInstead(context: SlackContext): string {
  return handoffSentence(
    context.handoffs.core(['standing', 'list']),
    (command) =>
      `Stop, and ask the person instead: ${command}, or comms_standing, shows what each standing approval covers. Do not try again.`,
    {
      instead:
        'Stop, and ask the person instead; comms_standing shows what each standing approval covers. Do not try again.',
    },
  );
}

/** The digest a content is named by, before anything is read: USAGE for anything that is not one. */
function contentDigestOf(content: unknown): string {
  if (typeof content === 'string' && HEX64.test(content)) return content;
  throw new CommsError('USAGE', 'name the content by its digest: 64 hex characters, as standing list shows it', {
    hint: 'A standing approval names each content by its digest, never by its position or its words: take it from comms_standing, or the standing list command.',
    details: { reason: 'not-a-digest' },
  });
}

/** The standing approval as it stands, read before Slack is asked anything; the mint reads it again under its lock. */
async function standingInForce(
  context: SlackContext,
  gate: GateDeps,
  request: AckRequest,
  digest: string,
): Promise<{ record: ApprovalRecord; inForce: StandingBinding; content: StandingContent }> {
  const { outcome } = await context.core.approvals.inspect(
    request.standingId,
    { kind: 'standing', owner: gate.accountId },
    { action: 'claim' },
  );
  if (outcome.error) throw outcome.error;
  const record = outcome.record;
  if (record?.state === 'pending') {
    throw new CommsError('APPROVAL_PENDING', 'nothing was sent: this standing approval waits for the person', {
      hint: 'It is approved only with the code typed at a terminal. Ask the person instead of acting.',
      details: { approvalId: request.standingId, state: record.state },
    });
  }
  if (record === null || record === undefined || record.state !== 'approved' || record.standing === undefined) {
    throw new CommsError('APPROVAL_VOID', 'nothing was sent: this standing approval is not in force', {
      hint: askInstead(context),
      details: { approvalId: request.standingId, state: record?.state ?? null },
    });
  }
  const inForce = effectiveStanding(record.standing, record.narrowed);
  const content = inForce.contents.find((held) => held.digest === digest);
  if (content === undefined) throw standingRefused('content-not-held', askInstead(context));
  return { record, inForce, content };
}

/** Every page of the thread `ts` is in, parent first: `none` when it is in no thread, `null` when it cannot be read. */
async function threadOf(call: SlackCall, channel: string, ts: string): Promise<Raw[] | 'none' | null> {
  const messages: Raw[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < THREAD_PAGES; page += 1) {
    let response: Raw;
    try {
      response = (await callSlack(call, 'conversations.replies', {
        channel,
        ts,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      })) as Raw;
    } catch (error) {
      const notFound = error instanceof CommsError && error.details?.slackError === 'thread_not_found';
      return page === 0 && notFound ? 'none' : null;
    }
    messages.push(...list(response.messages));
    const next = (response.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (typeof next !== 'string' || next === '') return response.has_more === true ? null : messages;
    cursor = next;
  }
  return null;
}

/** The message acknowledged, as Slack has it now: its thread's parent, and the thread when it is in one. */
interface Target {
  readonly message: Raw;
  readonly ts: string;
  /** The message itself outside a thread, or its thread's first message. */
  readonly parent: Raw;
  /** The thread it is in — its parent's ts — or its own ts outside one: what `perThread` counts by. */
  readonly thread: string;
  /** The thread's messages, parent first, when it is in one. */
  readonly messages: Raw[] | null;
}

/**
 * The target and its thread (S4): `conversations.replies` at its ts, which holds the whole thread when it is in one; or,
 * when it is in none, `conversations.history` with `latest` at it, `inclusive`, and `limit` 1. Whatever cannot be read
 * is refused: `unreadable`.
 */
async function readTarget(context: SlackContext, call: SlackCall, channel: string, ts: string): Promise<Target> {
  const unreadable = () => standingRefused('unreadable', askInstead(context));
  const thread = await threadOf(call, channel, ts);
  if (thread === null) throw unreadable();
  if (thread !== 'none') {
    const message = thread.find((each) => each.ts === ts);
    if (message === undefined) throw unreadable();
    const root = str(message.thread_ts);
    if (root === undefined) return { message, ts, parent: message, thread: ts, messages: null };
    const parent = thread.find((each) => each.ts === root);
    if (parent === undefined) throw unreadable();
    return { message, ts, parent, thread: root, messages: thread };
  }
  let history: Raw;
  try {
    history = (await callSlack(call, 'conversations.history', {
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    })) as Raw;
  } catch {
    throw unreadable();
  }
  const message = list(history.messages).find((each) => each.ts === ts);
  // A message the thread read did not find, which says it is in a thread, is not one this can read whole.
  if (message === undefined || str(message.thread_ts) !== undefined) throw unreadable();
  return { message, ts, parent: message, thread: ts, messages: null };
}

/** Whether a message is this account's own: its user, or its app's, by this account's own record. */
async function ours(gate: GateDeps, channel: string, message: Raw): Promise<boolean> {
  if (message.user === gate.postingAs) return true;
  const ts = str(message.ts);
  return ts !== undefined && gate.appPosts !== undefined && (await gate.appPosts.holds({ channel, ts }));
}

/**
 * Whether the target is the newest message from someone else (S4): in its thread, or in its channel from its ts on.
 * `gone` when it is no longer there to be the newest of anything.
 */
async function newest(
  gate: GateDeps,
  channel: string,
  target: Target,
  thread: Raw[] | null,
): Promise<'newest' | 'not-newest' | 'gone' | 'unreadable'> {
  let messages: Raw[];
  if (target.messages !== null) {
    const read = thread ?? (await threadOf(gate.call, channel, target.thread));
    if (read === null || read === 'none') return 'unreadable';
    messages = read;
  } else {
    let history: Raw;
    try {
      history = (await callSlack(gate.call, 'conversations.history', {
        channel,
        oldest: target.ts,
        inclusive: true,
        limit: CHANNEL_SINCE,
      })) as Raw;
    } catch {
      return 'unreadable';
    }
    // More since it than are read: whatever they are, it is not the newest.
    if (history.has_more === true) return 'not-newest';
    messages = list(history.messages);
  }
  if (!messages.some((message) => message.ts === target.ts)) return 'gone';
  for (const message of messages) {
    const ts = str(message.ts);
    if (ts === undefined || compareTs(ts, target.ts) <= 0) continue;
    if (!(await ours(gate, channel, message))) return 'not-newest';
  }
  return 'newest';
}

/** Whether anything in `value` is for a person to press or fill in, however deep in its blocks. Too deep is yes. */
function holdsInteractive(value: unknown, depth: number): boolean {
  if (depth > 16) return true;
  if (Array.isArray(value)) return value.some((each) => holdsInteractive(each, depth + 1));
  if (!isRecord(value)) return false;
  if (typeof value.type === 'string' && INTERACTIVE.has(value.type)) return true;
  return Object.values(value).some((each) => holdsInteractive(each, depth + 1));
}

/**
 * Nothing to press (S4): its blocks, and any a legacy attachment carries, only what the allow-list holds to show and
 * offer nothing (`onlyStaticBlocks`, the lead's call after review) — anything else, a type unknown here among them, is
 * something to press; a legacy attachment's actions or callback; or a message a workflow sent. A reaction on a form or
 * an approval request can read as an answer to it.
 */
function interactive(message: Raw): boolean {
  if (isRecord(message.bot_profile) && message.bot_profile.is_workflow_bot === true) return true;
  if (!onlyStaticBlocks(message.blocks)) return true;
  if (message.attachments !== undefined && !Array.isArray(message.attachments)) return true;
  for (const attachment of list(message.attachments)) {
    if ((Array.isArray(attachment.actions) && attachment.actions.length > 0) || attachment.callback_id !== undefined) {
      return true;
    }
    if (!onlyStaticBlocks(attachment.blocks)) return true;
  }
  // Belt and braces: anything a person could press, however deep in what the attachments hold.
  return holdsInteractive(message.attachments, 0);
}

/** What a message a person typed never carries: any of these, and a bot, an app, a workflow or Slack made it. */
const NOT_TYPED = ['bot_id', 'app_id', 'bot_profile', 'subtype'] as const;

/**
 * Whether Slack says a message came from another team: its `user_team` or `source_team`, where it sets one, not this
 * workspace's (the lead's call, after review). An Enterprise Grid's other workspaces read as other teams too: refused
 * where a person from outside would be, which is the safe way to be wrong.
 */
function fromAnotherTeam(message: Raw, workspaceId: string): boolean {
  return (['user_team', 'source_team'] as const).some((field) => {
    const team = message[field];
    return team !== undefined && team !== workspaceId;
  });
}

/**
 * From another human, by allow-list (S4): a `user` that is a person's id, not Slackbot, not this account; no `bot_id`,
 * `app_id`, `bot_profile` or `subtype` at all, and words that do not begin as an agent's labelled post — another
 * person's agent posting as them is not them (`madeByMachine`); not in this account's app-posts record; and not a bot
 * or an app's user by `users.info`. Whatever cannot be read is not a person: `null`.
 *
 * And whether they are from outside (S5, the lead's call after review): `external` for a guest (`is_restricted`,
 * `is_ultra_restricted`), a stranger, someone whose `team_id` is not this workspace's or who has none, or a message
 * Slack marks as from another team — found here even where a place's members were not read one by one.
 */
async function human(gate: GateDeps, channel: string, message: Raw): Promise<'internal' | 'external' | null> {
  const user = message.user;
  if (typeof user !== 'string' || !PERSON.test(user) || user === SLACKBOT || user === gate.postingAs) return null;
  // Marked as made by a bot, an app, a workflow or Slack — or labelled as an agent's, someone else's agent included.
  if (madeByMachine(message)) return null;
  const ts = str(message.ts);
  if (ts === undefined || gate.appPosts === undefined || (await gate.appPosts.holds({ channel, ts }))) return null;
  let person: Raw;
  try {
    person = ((await callSlack(gate.call, 'users.info', { user })).user as Raw | undefined) ?? {};
  } catch {
    return null;
  }
  const isPerson =
    person.id === user && person.is_bot !== true && person.is_app_user !== true && person.is_workflow_bot !== true;
  if (!isPerson) return null;
  const outside =
    isGuest(person) ||
    person.is_stranger === true ||
    person.team_id !== gate.workspaceId ||
    fromAnotherTeam(message, gate.workspaceId);
  return outside ? 'external' : 'internal';
}

/**
 * The ts of every message this product sent for the person in `channel` since `from`, by the audit's record of what
 * was sent: read from a day before it, so a clock a little behind Slack's misses nothing.
 *
 * Matched by the person, not only by the account (the lead's call, after review): a workspace removed and added again
 * is a new account id, and what the old one sent as them is theirs no more than before. A post is this product's for
 * the person when it was this account's, or its record names their Slack user id and team, or — written by a release
 * that recorded neither — any account's at that channel and ts: one this cannot tell apart counts as this product's.
 */
async function sentByThisProduct(
  context: SlackContext,
  gate: Pick<GateDeps, 'accountId' | 'postingAs' | 'workspaceId'>,
  channel: string,
  from: number,
): Promise<Set<string>> {
  const since = new Date(from - DAY_MS).toISOString();
  const records = await context.core.audit.tail({ since, limit: Number.MAX_SAFE_INTEGER });
  const sent = new Set<string>();
  for (const record of records) {
    const ids = record.ids;
    if (record.operation !== 'slack.post' || ids?.channel !== channel || typeof ids.ts !== 'string') continue;
    const theirs =
      record.inboxId === gate.accountId ||
      (ids.user === gate.postingAs && ids.team === gate.workspaceId) ||
      (ids.user === undefined && ids.team === undefined);
    if (theirs) sent.add(ids.ts);
  }
  return sent;
}

/**
 * Whether a message carries a mark of being made by something other than a person typing (S4): any of `bot_id`,
 * `app_id`, `bot_profile` or `subtype`, or words that begin as an agent's labelled post do (`beginsAsAgentLabelled`,
 * the lead's call after review) — which holds when Slack set none of the marks on a post made with a person's token.
 */
function madeByMachine(message: Raw): boolean {
  if (NOT_TYPED.some((field) => Object.hasOwn(message, field))) return true;
  return typeof message.text === 'string' && beginsAsAgentLabelled(message.text);
}

/**
 * Whether the thread is one the person is in (S5): a message their own user id posted in the last 14 days, with none
 * of `bot_id`, `app_id`, `bot_profile` or `subtype` and not labelled as an agent's (`madeByMachine`), that this product
 * did not send — not in the app-posts record, and not in the audit's record of what was sent. A mention is not a post.
 */
async function personPostedIn(
  context: SlackContext,
  gate: GateDeps,
  channel: string,
  messages: readonly Raw[],
  now: number,
): Promise<boolean> {
  let sent: Set<string> | undefined;
  for (const message of messages) {
    const ts = str(message.ts);
    if (ts === undefined || message.user !== gate.postingAs || madeByMachine(message)) continue;
    if (msOf(ts) < now - STANDING_THREAD_LOOKBACK_MS) continue;
    if (gate.appPosts === undefined || (await gate.appPosts.holds({ channel, ts }))) continue;
    sent ??= await sentByThisProduct(context, gate, channel, now - STANDING_THREAD_LOOKBACK_MS);
    if (!sent.has(ts)) return true;
  }
  return false;
}

/**
 * Whether a thread's parent is the person's own message, which they posted themselves (S4, the lead's call after
 * build): their user id, none of `bot_id`, `app_id`, `bot_profile` or `subtype` and no agent label at the start of its
 * words (`madeByMachine`, after review), and not one this product sent — not
 * in the app-posts record, nor in the audit's record of what was sent, the test `threads-i-am-in` makes of their posts.
 * The audit is read as far back as the parent, however old the thread. A parent from a bot, an app, Slackbot or this
 * account's app is never this; and the message acknowledged is always another person's, never the person's own.
 */
async function startedByPerson(context: SlackContext, gate: GateDeps, channel: string, parent: Raw): Promise<boolean> {
  if (parent.user !== gate.postingAs || madeByMachine(parent)) return false;
  const ts = str(parent.ts);
  // A ts that is no time cannot say how far back to read what this product sent: not the person's, then.
  if (ts === undefined || !Number.isFinite(msOf(ts))) return false;
  if (gate.appPosts === undefined || (await gate.appPosts.holds({ channel, ts }))) return false;
  return !(await sentByThisProduct(context, gate, channel, msOf(ts))).has(ts);
}

/** How a place is named on the person's screen: `#name`, the DM with someone, or its id. Someone in Slack chose it. */
function placeName(facts: PlaceFacts): string {
  if (facts.isIm)
    return facts.name === null ? `the direct message ${facts.id}` : `the direct message with ${facts.name}`;
  return facts.name === null ? facts.id : `#${facts.name}`;
}

/** Raises the notice, best effort: what became of it, never a failure of the act. */
async function raise(context: SlackContext, notice: StandingNotice): Promise<string> {
  if (context.notify === undefined) return 'none';
  try {
    const raised = await context.notify(notice);
    return raised.raised ? 'raised' : `failed: ${truncateDisplay(raised.reason, 200)}`;
  } catch (error) {
    return `failed: ${truncateDisplay(messageOf(error), 200)}`;
  }
}

/** A link to the acknowledged message, best effort: nothing when Slack would not give one. */
async function permalinkOf(call: SlackCall, channel: string, ts: string): Promise<string | undefined> {
  try {
    const link = str((await callSlack(call, 'chat.getPermalink', { channel, message_ts: ts })).permalink);
    return link !== undefined && /^https:\/\//.test(link) ? link : undefined;
  } catch {
    return undefined;
  }
}

/** The fields of a child, as the act it is for is bound: what the claim will compare. */
interface ChildFields {
  readonly draftId: string;
  readonly draftMessageId: string;
  readonly contentDigest: string;
  readonly expect: Expectation;
  readonly riskFlags: string[];
}

/**
 * Acknowledges one message with one content of a standing approval (S9): in the order the module says, refused at the
 * first check that does not hold, and sent — once it is minted — only through the claim every Slack act makes.
 */
export async function ack(
  context: SlackContext,
  alias: string,
  request: AckRequest,
  slack: SessionDeps = {},
): Promise<AckResult> {
  // 1. Before anything is read: what is asked for is a digest, at a message, on a workspace that may send.
  const digest = contentDigestOf(request.content);
  requireMessageAt({ channel: request.channel, ts: request.ts }, alias, context.handoffs);
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const config = await context.config();
  const { alias: name } = requireWorkspace(config, alias, context.handoffs);
  if (effectiveAccountSendPolicy(config, name) === 'never') {
    throw new CommsError('POLICY_NEVER', 'nothing was sent: sending is turned off for this workspace (policy: never)', {
      hint: 'Nothing is sent from it, with a standing approval or without one.',
    });
  }
  const gate = await gateDepsFor(context, name, slack);
  const { channel, ts } = request;
  const store = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
  const book = new NameBook();
  let draft: SlackDraft | undefined;
  let childId: string | undefined;
  const audited = { standingId: request.standingId, channel, ts };
  try {
    const { record, inForce, content } = await standingInForce(context, gate, request, digest);
    const act = content.kind;
    const refuse = (reason: StandingRefusal) => standingRefused(reason, askInstead(context));
    const now = context.core.acks.now().getTime();

    // 2. The Slack reads, with no lock held (S9 step 1). The message and its thread first (S4).
    const target = await readTarget(context, gate.call, channel, ts);
    for (const message of [target.message, target.parent]) if (interactive(message)) throw refuse('interactive');
    // The message from another person; its thread's parent from another person too, or the person's own (S4).
    const author = await human(gate, channel, target.message);
    if (author === null) throw refuse('not-human');
    const authors = [author];
    if (target.parent !== target.message) {
      const parent = await human(gate, channel, target.parent);
      if (parent !== null) authors.push(parent);
      else if (!(await startedByPerson(context, gate, channel, target.parent))) throw refuse('not-human');
    }
    const arrived = msOf(ts);
    if (arrived < Date.parse(record.createdAt) || now - arrived > STANDING_FRESH_MS) throw refuse('not-fresh');
    const first = await newest(gate, channel, target, target.messages);
    if (first !== 'newest') throw refuse(first === 'not-newest' ? 'not-newest' : 'unreadable');

    // The place (S5): named exactly, or a thread the person posted in themselves.
    let exact: ExactPlace | undefined;
    if (inForce.places.kind === 'exact') {
      exact = inForce.places.places.find((place) => place.id === channel);
      if (exact === undefined) throw refuse('place-not-covered');
    } else if (target.messages === null || !(await personPostedIn(context, gate, channel, target.messages, now))) {
      throw refuse('place-not-covered');
    }
    // Who is in it now, against what the person approved: a count that fails closed, and sharing read per member.
    let facts: PlaceFacts;
    try {
      facts = await readPlace(gate.call, channel, gate.workspaceId);
    } catch {
      throw refuse('count-unreadable');
    }
    if (facts.members === null) throw refuse('count-unreadable');
    if (exact !== undefined) {
      if (facts.members >= STANDING_BIG_ROOM && exact.members < STANDING_BIG_ROOM) throw refuse('big-room');
      if (canonicalJson(facts.shared) !== canonicalJson(exact.shared)) throw refuse('shared-state-changed');
    } else {
      if (facts.members >= STANDING_BIG_ROOM) throw refuse('big-room');
      const { extShared, pendingExtShared, externalMembers } = facts.shared;
      if (extShared || pendingExtShared || externalMembers !== false) throw refuse('external');
    }
    /*
     * Who wrote the message and its thread's first message (the lead's call, after review): someone from outside — a
     * guest, a stranger, another team — only where the person approved this place exactly as shared with another
     * organisation. This holds where the members are not read one by one: a big room's guest is found here.
     */
    const sharedAsApproved = exact?.shared.extShared === true || exact?.shared.externalMembers === true;
    if (authors.includes('external') && !sharedAsApproved) throw refuse('external');

    // Who it goes as (S7), and what spec 2's rules allow there (S9, T9) — then the child's fields, bound to both.
    let child: ChildFields;
    let label: LabelView | undefined;
    if (act === 'reply') {
      // The payload, built here from the person's own words: escaped for Slack, in the thread, and nothing else.
      draft = await store.create(
        gate.accountId,
        payloadOf(escapeForSlack(content.text), channel, target.thread),
        content.text,
      );
      const view = await viewPost(gate, draft, book, 'agent');
      // A message sent without the person's yes never looks like their own: the app, or labelled — overriding `me`.
      if (view.label === undefined || view.label.identity !== 'agent' || view.label.route === 'person') {
        throw new CommsError('UNEXPECTED', 'nothing was sent: a standing reply would have gone as you, unlabelled', {
          hint: 'This is a bug — please report it.',
        });
      }
      if (!view.decision.allowed) throw await actRefusal(gate, view.decision, view.check);
      label = labelView(view.label, view.preview.postingAs);
      child = {
        draftId: draft.draftId,
        draftMessageId: draft.revision,
        contentDigest: view.digest,
        expect: expectationFor(view.payload, view.preview.notifies),
        riskFlags: [...risksOf(view.payload, view.preview.notifies, 0), AS_AGENT],
      };
    } else {
      const room = (await roomOf(gate.call, channel)).channel;
      const decided =
        gate.label === undefined
          ? undefined
          : await decideLabel(
              { call: gate.call, postingAs: gate.postingAs, label: gate.label },
              { kind: 'reaction', channelId: channel, room: async () => room, requested: 'agent' },
            );
      // Only as the workspace's agent app: wherever it would go as the person, unlabelled, it does not go at all.
      if (decided?.identity !== 'agent' || decided.route !== 'app') throw refuse('reaction-as-person');
      /*
       * And only where the app is a member (the lead's call, after build): an app post may go to a public channel the
       * app has not joined, but a reaction there would fail after the count is spent. Read before the mint, and a
       * membership that cannot be settled refuses, as one that is known to be missing does.
       */
      const botUserId = decided.botUserId ?? gate.label?.app?.userId;
      if (botUserId === undefined || (await botIsMember(gate.call, channel, botUserId)) !== true) {
        throw refuse('app-not-member');
      }
      const fields = await reactionApprovalFields(gate, { channel, ts, name: content.text }, decided);
      await requireAllowed(gate, fields.check);
      label = labelView(decided, reactionLine(decided));
      child = {
        draftId: fields.draftId,
        draftMessageId: fields.draftMessageId,
        contentDigest: fields.contentDigest,
        expect: fields.expect,
        riskFlags: [REACTS_AS_APP, AS_AGENT],
      };
    }

    // 3. The mint: counted under the account's ledger lock, then the record's — never refunded from here on.
    const message = target.message;
    const minted = await mintStandingUse(context.core, {
      standingId: request.standingId,
      accountId: gate.accountId,
      inboxSub: gate.postingAs,
      act,
      contentDigest: content.digest,
      target: {
        channel,
        ts,
        thread: target.thread,
        textDigest: sha256Hex(typeof message.text === 'string' ? message.text : ''),
        edited: message.edited !== undefined && message.edited !== null,
        // What the place was checked against: the mint refuses it if the record no longer covers it there.
        places: inForce.places.kind,
        // Who wrote it, which `perSender` counts by: a person's id, as `human` has read it.
        sender: message.user as string,
      },
      child,
    });
    childId = minted.child.approvalId;
    const ids: Record<string, string> = {
      standingId: request.standingId,
      childId,
      contentDigest: content.digest,
      channel,
      ts,
      targetDigest: sha256Hex(typeof message.text === 'string' ? message.text : ''),
      edited: String(message.edited !== undefined && message.edited !== null),
    };

    let approval: ApprovalObject;
    let posted: { ts?: string | undefined } | undefined;
    let actAt: string | undefined;
    try {
      /*
       * 4. The pause (the lead's call, after review): 5 to 30 seconds from the CSPRNG between the decision and the act,
       * so the moment an acknowledgement appears is not the agent's to choose. The act's own time is recorded.
       */
      const pausedMs = await context.standingPause();
      actAt = context.core.acks.now().toISOString();
      ids.pausedMs = String(pausedMs);
      ids.actAt = actAt;
      // 5. The newest-message read again, just before the claim: refused now, the count stays spent.
      const again = await newest(gate, channel, target, null);
      if (again !== 'newest') throw refuse(again === 'not-newest' ? 'not-newest' : 'unreadable');
      /*
       * 6. The act, through the existing path: the child is claimed there, once, and only there — with the gate as the
       * configuration is now, as every send's is built at send. A label, a policy or a rule changed since the mint is
       * what the claim sees, so the act it binds is decided again, and a different one is refused.
       */
      const deps = { ...(await gateDepsFor(context, name, slack)), standingUse: { standingId: request.standingId } };
      if (act === 'reply') {
        const done = await postPrepared(deps, draft as SlackDraft, childId, channel, book);
        approval = done.approval;
        posted = { ...(typeof done.ts === 'string' ? { ts: done.ts } : {}) };
      } else {
        approval = (await reactPrepared(deps, childId, { channel, ts, name: content.text })).approval;
      }
    } catch (error) {
      const unknown = error instanceof CommsError && error.code === 'SEND_OUTCOME_UNKNOWN';
      await afterward(context, gate, {
        outcome: unknown ? 'unknown' : 'failed',
        childId,
        ids,
        actAt,
        notice: unknown
          ? ackNotice({ act, text: content.text, place: placeName(facts), standingId: request.standingId })
          : undefined,
        reason: messageOf(error),
      });
      throw error;
    }

    // 7. After it: the ledger's outcome, the notice, the audit — none of them ever fails the act.
    const notice = await afterward(context, gate, {
      outcome: 'sent',
      childId,
      ids,
      actAt,
      notice: ackNotice({ act, text: content.text, place: placeName(facts), standingId: request.standingId }),
    });
    return {
      act,
      standingId: request.standingId,
      approvalId: childId,
      channel,
      ts,
      ...(posted === undefined ? {} : { posted }),
      ...(label === undefined ? {} : { label }),
      notice,
      approval,
      ...(legacyDrain === undefined ? {} : { legacyDrain }),
    };
  } catch (error) {
    if (childId !== undefined) {
      // A child not yet claimed is never left usable: revoking one that was claimed changes nothing.
      await context.core.approvals
        .revoke(childId, `not sent: ${truncateDisplay(messageOf(error), 200)}`, {
          disposition: 'lifecycle',
          expect: { kind: 'send', owner: gate.accountId },
        })
        .catch(() => undefined);
    } else {
      // Refused before anything was counted: said in the audit, so a refusal is never only the agent's to report.
      await context.core.audit
        .append({
          inboxId: gate.accountId,
          alias: gate.workspaceName,
          operation: 'slack.ack',
          outcome: 'refused',
          ids: audited,
          reason: truncateDisplay(messageOf(error), 300),
          surface: gate.surface,
        })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    if (draft !== undefined) await store.remove(draft.draftId).catch(() => undefined);
  }
}

/**
 * What is written once the act is done or has failed (S10): the notice raised when something may have been sent, the
 * ledger's outcome line with a link to the acknowledged message, and the audit record. Each is best effort, and none of
 * them changes what the act was: what became of the notice is returned.
 */
async function afterward(
  context: SlackContext,
  gate: GateDeps,
  done: {
    outcome: 'sent' | 'failed' | 'unknown';
    childId: string;
    ids: Record<string, string>;
    /** When the act started, after the pause: absent when it was refused before then. */
    actAt?: string | undefined;
    notice: StandingNotice | undefined;
    reason?: string | undefined;
  },
): Promise<string> {
  const notice = done.notice === undefined ? 'not raised: nothing was sent' : await raise(context, done.notice);
  const link = await permalinkOf(gate.call, done.ids.channel as string, done.ids.ts as string);
  try {
    await context.core.acks.recordOutcome(gate.accountId, {
      kind: 'outcome',
      at: context.core.acks.now().toISOString(),
      ...(done.actAt === undefined ? {} : { actAt: done.actAt }),
      childId: done.childId,
      outcome: done.outcome,
      ...(link === undefined ? {} : { link }),
      notice,
    });
  } catch {
    // The use is counted whatever this says; a missing outcome reads as pending in the list.
  }
  try {
    await context.core.audit.append({
      inboxId: gate.accountId,
      alias: gate.workspaceName,
      operation: 'slack.ack',
      outcome: done.outcome === 'sent' ? 'ok' : 'failed',
      ids: { ...done.ids, notice },
      approvalId: done.childId,
      ...(done.reason === undefined ? {} : { reason: truncateDisplay(done.reason, 300) }),
      surface: gate.surface,
    });
  } catch {
    // The act happened, or did not, whatever the audit could record.
  }
  return notice;
}
