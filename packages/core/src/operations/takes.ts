import { agentMarker } from '../cli-runtime.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { MCP_SERVER_MARKER, mcpServerOf } from '../mcp-marker.ts';
import { formerNameRefusal } from '../names.ts';
import {
  isClaudeCodeSessionId,
  isSessionKey,
  isTakeState,
  personTakeView,
  TAKE_ID_PATTERN,
  TAKE_LEASE_MS,
  TAKE_STATES,
  type TakeMessageRef,
  type TakeRecord,
  type TakeState,
  type TakeTerminal,
  type TakeWindow,
  takeMessageKey,
  takeTerminal,
} from '../takes.ts';
import { type TakingChannel, takingAccountsOf } from '../taking.ts';
import { newBoundary } from '../untrusted.ts';
import { activitySince } from './activity.ts';

/**
 * Taking messages, the person's side (design 2026-10-26-taking-messages §5, §10): `agentcomms takes list|release|give|
 * keep`, each the CLI's alone — and the desktop app's through it. A session must not read, end or give another's take,
 * and its own hand-back is the channel's tool; so each refuses inside an MCP server's process, as `activity items`
 * does, and in a shell a known coding agent marks (`agentMarker`), as the event service's person-only acts do — and no
 * tool reaches it (each row in `capabilities.json` is an exception).
 *
 * A speed bump, not a boundary: a shell without a marker runs as the person, and so does any code running as them.
 * Each act is a history line `by: person` with the terminal it came from, so the story says where it came from.
 */

export interface TakesReadOptions {
  /** The environment the MCP server's mark is read from; the process's own by default. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
  /** For a test: the terminal a person's act is recorded as coming from. */
  readonly terminal?: TakeTerminal | undefined;
}

const AGENT_HINT =
  'Over MCP, a channel’s take tool takes, hands back or finishes this session’s own, and its taken tool says who has a message. The person can do this in Agent Comms → Messages, or at their own terminal.';

/**
 * Refuses, as exit 10, inside an MCP server's process or one it started, and in a shell a known coding agent marks:
 * these are the person's.
 */
function refuseUnlessPerson(env: NodeJS.ProcessEnv): void {
  if (mcpServerOf(env) !== undefined) {
    throw new CommsError(
      'APPROVAL_REQUIRED',
      "who has each message, and ending, giving or keeping one, is for a person, at a terminal or in the app — an MCP server's process cannot do it",
      { hint: AGENT_HINT, details: { reason: 'MCP_SERVER_PROCESS', marker: MCP_SERVER_MARKER } },
    );
  }
  const marker = agentMarker(env);
  if (marker !== null) {
    throw new CommsError(
      'APPROVAL_REQUIRED',
      'who has each message, and ending, giving or keeping one, is for a person, in the app or at their terminal, not an agent',
      { hint: AGENT_HINT, details: { reason: 'AGENT_SHELL', marker } },
    );
  }
}

const SLACK_MESSAGE = /^[CDG][A-Z0-9]{1,40}\/\d{1,12}\.\d{1,8}$/;

/** The account a person names, connected now and one that takes messages; a former name is refused with its new one. */
function accountNamed(config: Config, name: string): { id: string; account: string; channel: TakingChannel } {
  const found = takingAccountsOf(config).find((account) => account.account === name);
  if (found !== undefined) return found;
  const renamed = formerNameRefusal(config, 'account', name) ?? formerNameRefusal(config, 'inbox', name);
  if (renamed) throw renamed;
  const known = takingAccountsOf(config).map((account) => account.account);
  throw new CommsError('NOT_FOUND', `no mailbox or account that takes messages is called "${name}"`, {
    hint: known.length > 0 ? `They are: ${known.join(', ')}.` : 'Nothing that takes messages is connected yet.',
  });
}

/** A message as the person names it: Gmail's message id, Slack's `<channelId>/<ts>`, Resend's received email id. */
function messageNamed(channel: TakingChannel, accountId: string, message: string): TakeMessageRef {
  const ok = channel === 'slack' ? SLACK_MESSAGE.test(message) : TAKE_ID_PATTERN.test(message);
  if (typeof message !== 'string' || !ok) {
    throw new CommsError('USAGE', `"${String(message).slice(0, 40)}" is not a message there`, {
      hint:
        channel === 'slack'
          ? 'A Slack message is <channelId>/<ts>, as Messages and activity items name it: C0123/1729936800.000100.'
          : channel === 'gmail'
            ? 'A Gmail message is its id, as Messages and activity items name it.'
            : 'A Resend message is its received email id.',
    });
  }
  return { channel, accountId, id: message };
}

// ── list ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TakesListRequest {
  /** Only records changed since: an ISO time, or a span back from now (`7d`, `12h`). */
  readonly since?: string | undefined;
  /** Only this account's, by name. */
  readonly account?: string | undefined;
  /** Only records in this state: open, offered, taken or done. */
  readonly state?: string | undefined;
}

/**
 * One record as the person reads it: every field — the holder's folder and client, the history with each window and
 * terminal — with each note enveloped. `account` is its name now, or null for one no connected account holds.
 */
export type TakeListEntry = TakeRecord & {
  readonly key: string;
  readonly account: string | null;
  /** When the take lapses with no further act, or null while an approval holds it or nobody has it. */
  readonly leaseUntil: string | null;
};

export interface TakesListResult {
  readonly since: string | null;
  readonly takes: TakeListEntry[];
  /** Files that cannot be read: each counts as held by another session until the person releases it. */
  readonly unreadable: { readonly account: string | null; readonly accountId: string; readonly file: string }[];
}

/**
 * Every take record — every session, project and account — newest change first, with full holders and notes
 * enveloped. Refused inside an MCP server's process.
 */
export async function listTakes(
  core: Core,
  request: TakesListRequest = {},
  options: TakesReadOptions = {},
): Promise<TakesListResult> {
  refuseUnlessPerson(options.env ?? process.env);
  const now = (options.now ?? (() => new Date()))();
  let since: string | undefined;
  try {
    since = activitySince(request.since, now);
  } catch {
    throw new CommsError(
      'USAGE',
      `--since takes an ISO time or a span back from now such as 7d or 12h — not "${String(request.since).slice(0, 40)}"`,
    );
  }
  if (request.state !== undefined && !isTakeState(request.state)) {
    throw new CommsError('USAGE', `--state is one of ${TAKE_STATES.join(', ')}`);
  }
  const config = await core.config.load();
  const names = new Map(takingAccountsOf(config).map((account) => [account.id, account.account]));
  const only = request.account === undefined ? undefined : accountNamed(config, request.account).id;
  const listed = await core.takes.list(only === undefined ? {} : { accountId: only });
  const boundary = newBoundary();
  const takes: TakeListEntry[] = [];
  const unreadable: TakesListResult['unreadable'] = [];
  for (const entry of listed) {
    if ('unreadable' in entry) {
      unreadable.push({ account: names.get(entry.unreadable.accountId) ?? null, ...entry.unreadable });
      continue;
    }
    const record = entry.record;
    if (since !== undefined && record.updatedAt < since) continue;
    if (request.state !== undefined && record.state !== (request.state as TakeState)) continue;
    const leaseUntil =
      record.state === 'taken' &&
      record.lastActAt !== null &&
      record.pins.length === 0 &&
      !('person' in (record.holder ?? {}))
        ? new Date(Date.parse(record.lastActAt) + TAKE_LEASE_MS).toISOString()
        : null;
    takes.push({
      key: takeMessageKey(record.message),
      account: names.get(record.message.accountId) ?? null,
      ...personTakeView(record, boundary),
      leaseUntil,
    });
  }
  takes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { since: since ?? null, takes, unreadable };
}

// ── release, give, keep ───────────────────────────────────────────────────────────────────────────────────────

export interface TakeTarget {
  readonly account: string;
  /** Gmail's message id; Slack's `<channelId>/<ts>`; Resend's received email id. */
  readonly message: string;
}

/** What a person's act did: the message, where it stands now, and whether anything changed. */
export interface TakePersonResult {
  readonly account: string;
  readonly message: string;
  readonly state: TakeState;
  readonly changed: boolean;
  readonly take: TakeRecord | null;
}

async function resolved(core: Core, target: TakeTarget): Promise<{ account: string; ref: TakeMessageRef }> {
  if (typeof target.account !== 'string' || target.account === '')
    throw new CommsError('USAGE', 'name the account: organisation/platform');
  const config = await core.config.load();
  const account = accountNamed(config, target.account);
  return { account: account.account, ref: messageNamed(account.channel, account.id, target.message) };
}

async function terminalOf(core: Core, options: TakesReadOptions): Promise<TakeTerminal> {
  return options.terminal ?? (await takeTerminal(core));
}

function resultOf(
  account: string,
  ref: TakeMessageRef,
  outcome: { record: TakeRecord | null; changed: boolean },
): TakePersonResult {
  const boundary = newBoundary();
  return {
    account,
    message: ref.id,
    state: outcome.record?.state ?? 'open',
    changed: outcome.changed,
    take: outcome.record === null ? null : personTakeView(outcome.record, boundary),
  };
}

/** `takes release`: ends whoever has the message — a take, an offer, a done, the person's own keep — at once. */
export async function releaseTake(
  core: Core,
  target: TakeTarget,
  options: TakesReadOptions = {},
): Promise<TakePersonResult> {
  refuseUnlessPerson(options.env ?? process.env);
  const { account, ref } = await resolved(core, target);
  const outcome = await core.takes.release(ref, await terminalOf(core, options));
  await core.audit.append({
    inboxId: ref.accountId,
    alias: account,
    operation: 'takes.release',
    outcome: 'ok',
    surface: 'cli',
  });
  return resultOf(account, ref, outcome);
}

/** `takes keep`: the person handles the message themselves; every session is refused it until they release it. */
export async function keepTake(
  core: Core,
  target: TakeTarget,
  options: TakesReadOptions = {},
): Promise<TakePersonResult> {
  refuseUnlessPerson(options.env ?? process.env);
  const { account, ref } = await resolved(core, target);
  const outcome = await core.takes.keep({ ...ref, thread: null }, await terminalOf(core, options));
  await core.audit.append({
    inboxId: ref.accountId,
    alias: account,
    operation: 'takes.keep',
    outcome: 'ok',
    surface: 'cli',
  });
  return resultOf(account, ref, outcome);
}

export interface TakeGiveTarget extends TakeTarget {
  /** The window, as `lane bind --window` takes it: a Claude Code session id, or an activity session key. */
  readonly window: string;
}

/** How far back a window's activity is looked for, to name it in the story: a week. */
const WINDOW_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The window a person gives a message to (T4), by the id `lane bind --window` takes: a Claude Code session id, or an
 * activity session key that recorded activity in the last week — its folder, client and parent are read from there,
 * for the story. A key nothing recorded is refused, so a typo offers nothing to nobody.
 */
async function windowNamed(core: Core, id: string, now: Date): Promise<TakeWindow> {
  const value = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (isClaudeCodeSessionId(value)) return { sessionId: value, key: null, parent: null, folder: null, client: null };
  if (!isSessionKey(value)) {
    throw new CommsError(
      'USAGE',
      'a window id is a Claude Code session id (a UUID) or an activity session key (16 hex characters)',
      {
        hint: 'activity sessions lists the windows by key; a window’s events_lane_whoami gives the id it is bound by.',
      },
    );
  }
  const sessions = await core.activity.sessions({ since: new Date(now.getTime() - WINDOW_LOOKBACK_MS).toISOString() });
  const found = sessions.find((session) => session.key === value && session.grouped);
  if (found === undefined) {
    throw new CommsError('NOT_FOUND', `no agent window with the key ${value} has done anything in the last week`, {
      hint: 'activity sessions lists the windows that have, each by its key.',
    });
  }
  return { sessionId: null, key: value, parent: found.parent, folder: found.folder, client: found.client };
}

/**
 * `takes give`: offers the message to one window for fifteen minutes, ending anyone's take; the window must still take
 * it (T4).
 */
export async function giveTake(
  core: Core,
  target: TakeGiveTarget,
  options: TakesReadOptions = {},
): Promise<TakePersonResult> {
  refuseUnlessPerson(options.env ?? process.env);
  const { account, ref } = await resolved(core, target);
  const window = await windowNamed(core, target.window, (options.now ?? (() => new Date()))());
  const outcome = await core.takes.give({ ...ref, thread: null }, window, await terminalOf(core, options));
  await core.audit.append({
    inboxId: ref.accountId,
    alias: account,
    operation: 'takes.give',
    outcome: 'ok',
    surface: 'cli',
  });
  return resultOf(account, ref, outcome);
}
