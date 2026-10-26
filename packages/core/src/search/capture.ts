import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readActivitySettings } from '../activity-settings.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { appendPrivateLine, writeFileAtomic } from '../fs.ts';
import type { SecretStore } from '../secrets.ts';
import { canonicalAddress } from '../taint.ts';
import { ensureSearchKey, type SearchKey, sealSearchRecord, searchSecretStore } from './crypto.ts';
import { type SearchPaths, searchPaths } from './folder.ts';
import { readSearchSettings, searchKeeps } from './settings.ts';

/**
 * The capture (design 2026-10-26-local-search, S2, S3, S8 and §5): in the process that had a message in hand — an
 * agent's read, or a reply Agent Comms sent — after the call succeeded, one encrypted line appended to that process's
 * own file in `<state>/search/inbox/`. Nothing is fetched for Search, and only the indexer writes the database.
 *
 * - **Only while Search keeps the account:** on, and the account included. Read afresh each call — the store answers
 *   from its cache while `config.json` is unchanged — so off applies at once in every process.
 * - **Never the person's own:** a message from the account's own address, its send-as addresses or its own Slack user
 *   is not an ask, and is not kept as one. Replies sent are kept as `out` (S3).
 * - **Never in the way:** it never throws, never changes a result, and is bounded in time; a failure is said once per
 *   process on stderr and kept beside the folder for doctor.
 * - **A line is one write** to a file only this process writes (`<UTC day>-<pid>.jsonl`), so a large line cannot
 *   interleave with another's. Its words, subject and sender are sealed with the inbox's subkey: the file holds no text.
 */

export type SearchChannel = 'gmail' | 'slack';
export type SearchDirection = 'in' | 'out';

/** One message in hand, as a channel hands it over: what a person would search, and the ids that tie it to its story. */
export interface SearchCapture {
  readonly channel: SearchChannel;
  readonly direction: SearchDirection;
  /** The id the Messages join uses: a Gmail message id, or a Slack `<channelId>/<ts>`. */
  readonly sourceId: string;
  /** A Gmail thread id, or a Slack `<channelId>/<parent ts>`. */
  readonly threadId?: string | undefined;
  /** An `out` message's: the source id it answers. */
  readonly replyTo?: string | undefined;
  /** An `in` message's sender: an address for Gmail, a user (and their team, when Slack named it) for Slack. */
  readonly from?:
    | {
        readonly address?: string | undefined;
        readonly name?: string | undefined;
        readonly userId?: string | undefined;
        readonly teamId?: string | undefined;
      }
    | undefined;
  readonly subject?: string | undefined;
  /** The sanitised visible text, as the read returned it. */
  readonly text: string;
  /** When it was sent, in milliseconds. */
  readonly at: number;
  /** A snippet, or a read cut short: a full read later replaces it, never the reverse. */
  readonly partial: boolean;
  /** Slack's: the two halves said different things; a part could not be shown (§7). */
  readonly mismatch?: boolean | undefined;
  readonly unrenderable?: boolean | undefined;
}

/** Who saw it: an agent's read, or a send. Phase 2 adds the event service's `event`. */
export type SearchSeenBy = 'agent' | 'send';

/** A line, opened: what the indexer reads. Rebuilt field by field, so nothing else a caller handed over is kept. */
export interface SearchInboxLine {
  readonly v: 1;
  readonly channel: SearchChannel;
  readonly direction: SearchDirection;
  readonly accountId: string;
  readonly sourceId: string;
  readonly threadId?: string | undefined;
  readonly replyTo?: string | undefined;
  readonly handle?: string | undefined;
  readonly fromName?: string | undefined;
  readonly subject?: string | undefined;
  readonly text: string;
  readonly at: number;
  readonly seenAt: number;
  readonly seenBy: SearchSeenBy;
  readonly partial: boolean;
  readonly mismatch: boolean;
  readonly unrenderable: boolean;
}

/** How much of a message is kept: 32 KiB of its text, a subject's line, a name. */
export const MAX_TEXT_BYTES: number = 32 * 1024;
export const MAX_SUBJECT_CHARS = 998;
export const MAX_NAME_CHARS = 200;

const GMAIL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const SLACK_MESSAGE = /^[CDG][A-Z0-9]{1,40}\/\d{1,12}\.\d{1,8}$/;
const SLACK_PART = /^[A-Z0-9]{1,40}$/;
const ACCOUNT_ID = /^(?:ibx|acc)_[A-Za-z0-9]{1,64}$/;
const ADDRESS = /^[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]{1,255}$/;
/** A handle: `email:<canonical address>` or `slack:<teamId>/<userId>`. */
export const SEARCH_HANDLE: RegExp =
  /^(?:email:[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]{1,255}|slack:[A-Z0-9]{1,40}\/[A-Z0-9]{1,40})$/;

/** A message's id, as the join names it, for its channel: valid or undefined. */
export function searchSourceId(channel: SearchChannel, id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  return (channel === 'gmail' ? GMAIL_ID : SLACK_MESSAGE).test(id) ? id : undefined;
}

/** A sender as a handle: a Gmail address canonical, a Slack user with its team. Undefined when there is none. */
export function handleOf(
  channel: SearchChannel,
  from: SearchCapture['from'],
  workspace: string | undefined,
): string | undefined {
  if (from === undefined) return undefined;
  if (channel === 'gmail') {
    if (typeof from.address !== 'string') return undefined;
    const address = canonicalAddress(from.address);
    return ADDRESS.test(address) ? `email:${address}` : undefined;
  }
  const team = from.teamId ?? workspace;
  if (typeof from.userId !== 'string' || !SLACK_PART.test(from.userId)) return undefined;
  if (typeof team !== 'string' || !SLACK_PART.test(team)) return undefined;
  return `slack:${team}/${from.userId}`;
}

/** The account's own handles, from the configuration: its address, or its Slack user. */
export function ownHandles(config: Config, accountId: string): string[] {
  for (const inbox of Object.values(config.inboxes)) {
    if (inbox.id === accountId) {
      const handle = handleOf('gmail', { address: inbox.email }, undefined);
      return handle === undefined ? [] : [handle];
    }
  }
  for (const account of Object.values(config.accounts)) {
    if (account.id === accountId) {
      const handle = handleOf('slack', { userId: account.userId }, account.workspace);
      return handle === undefined ? [] : [handle];
    }
  }
  return [];
}

/** The account's Slack workspace, for a sender Slack named no team for; undefined for a mailbox. */
function workspaceOf(config: Config, accountId: string): string | undefined {
  return Object.values(config.accounts).find((account) => account.id === accountId)?.workspace;
}

/** Text cut to `bytes` of UTF-8 without splitting a character, and with no control characters but line breaks. */
export function boundedText(text: string, bytes: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed.
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const encoded = Buffer.from(clean, 'utf8');
  if (encoded.byteLength <= bytes) return clean;
  return new TextDecoder('utf-8', { fatal: false }).decode(encoded.subarray(0, bytes)).replace(/�+$/u, '');
}

function cutChars(text: string | undefined, max: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const clean = boundedText(text, max * 4)
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return undefined;
  return [...clean].slice(0, max).join('');
}

/**
 * A capture as a line keeps it, or undefined for one that cannot be kept: an id that is not one, a sender who is the
 * account's own (for `in`), or nothing to search.
 */
export function inboxLineOf(
  capture: SearchCapture,
  accountId: string,
  context: { readonly own: ReadonlySet<string>; readonly workspace?: string | undefined; readonly seenAt: number },
): SearchInboxLine | undefined {
  if (capture.channel !== 'gmail' && capture.channel !== 'slack') return undefined;
  if (capture.direction !== 'in' && capture.direction !== 'out') return undefined;
  const sourceId = searchSourceId(capture.channel, capture.sourceId);
  if (sourceId === undefined || !ACCOUNT_ID.test(accountId)) return undefined;
  const handle = capture.direction === 'in' ? handleOf(capture.channel, capture.from, context.workspace) : undefined;
  // Never the person's own: a message from their own address or user is not an ask.
  if (capture.direction === 'in' && (handle === undefined || context.own.has(handle))) return undefined;
  const text = boundedText(typeof capture.text === 'string' ? capture.text : '', MAX_TEXT_BYTES);
  const subject = cutChars(capture.subject, MAX_SUBJECT_CHARS);
  if (text.trim() === '' && subject === undefined) return undefined;
  const threadId =
    typeof capture.threadId === 'string' &&
    (capture.channel === 'gmail' ? GMAIL_ID : SLACK_MESSAGE).test(capture.threadId)
      ? capture.threadId
      : undefined;
  const replyTo = capture.direction === 'out' ? searchSourceId(capture.channel, capture.replyTo) : undefined;
  const fromName = capture.direction === 'in' ? cutChars(capture.from?.name, MAX_NAME_CHARS) : undefined;
  const at = Number.isFinite(capture.at) && capture.at > 0 ? Math.floor(capture.at) : context.seenAt;
  return {
    v: 1,
    channel: capture.channel,
    direction: capture.direction,
    accountId,
    sourceId,
    ...(threadId === undefined ? {} : { threadId }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(handle === undefined ? {} : { handle }),
    ...(fromName === undefined ? {} : { fromName }),
    ...(subject === undefined ? {} : { subject }),
    text,
    at,
    seenAt: context.seenAt,
    seenBy: capture.direction === 'out' ? 'send' : 'agent',
    partial: capture.partial === true,
    mismatch: capture.mismatch === true,
    unrenderable: capture.unrenderable === true,
  };
}

/** The additional data a line is sealed with. */
export const INBOX_AAD = 'line';

/** One sealed line, as the inbox file holds it. */
export function sealedInboxLine(master: SearchKey, line: SearchInboxLine): string {
  return JSON.stringify({
    v: 1,
    sealed: sealSearchRecord(master, 'inbox', INBOX_AAD, JSON.stringify(line)).toString('base64'),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const INBOX_FILE = /^(\d{4}-\d{2}-\d{2})-\d{1,10}\.jsonl$/;

/** The inbox's files older than the days Activity keeps: captures waiting without the app are pruned all the same. */
export async function pruneInboxDays(paths: SearchPaths, retentionDays: number, now: number): Promise<number> {
  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 10);
  let names: string[];
  try {
    names = await readdir(paths.inbox);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    const day = INBOX_FILE.exec(name)?.[1] ?? /^taken-[0-9a-f]+-(\d{4}-\d{2}-\d{2})-/.exec(name)?.[1];
    if (day === undefined || day >= cutoff) continue;
    await rm(join(paths.inbox, name), { force: true }).catch(() => undefined);
    deleted += 1;
  }
  return deleted;
}

// ── Never in the way ───────────────────────────────────────────────────────────────────────────────────────────

/** How long a capture may hold the call it follows: the master's first read, at most. Later ones are one append. */
const CAPTURE_WAIT_MS = 2_000;

let warned = false;
let prunedDay: string | null = null;
let keyFor: { store: SecretStore; key: Promise<SearchKey> } | null = null;

/** The capture's own failure, kept beside the folder for doctor: when, and what — never any text. */
export const CAPTURE_FAILURE_FILE = 'capture-failure.json';

async function failed(paths: SearchPaths, error: unknown, warn: ((line: string) => void) | undefined): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  if (!warned) {
    warned = true;
    const said = `agent-communications: Search did not keep a message: ${message}`;
    if (warn !== undefined) warn(said);
    else process.stderr.write(`${said}\n`);
  }
  await writeFileAtomic(
    join(paths.dir, CAPTURE_FAILURE_FILE),
    `${JSON.stringify({ at: new Date().toISOString(), message, pid: process.pid })}\n`,
  ).catch(() => undefined);
}

/** What a capture takes besides its messages: stand-ins for tests, and the account's other own handles. */
export interface CaptureOptions {
  /** Handles that are the account's own beyond its configured address or user: Gmail send-as addresses. */
  readonly own?: readonly string[] | undefined;
  readonly now?: (() => number) | undefined;
  /** The secret store the master is in: the configured one unless a test brings its own. */
  readonly secrets?: (() => Promise<SecretStore>) | undefined;
  /** Where the once-a-process line goes: stderr unless a test listens. */
  readonly warn?: ((line: string) => void) | undefined;
}

/**
 * Appends each message in `captures` that Search keeps for `account`, sealed, to this process's inbox file. Never
 * throws and never changes anything the caller has. Returns how many were kept.
 */
export async function captureForSearch(
  core: Pick<Core, 'config' | 'paths' | 'secrets'>,
  account: { readonly id: string },
  captures: readonly SearchCapture[],
  options: CaptureOptions = {},
): Promise<number> {
  if (captures.length === 0 || account.id === '') return 0;
  const paths = searchPaths(core.paths.stateDir);
  try {
    const config = await core.config.load();
    const settings = readSearchSettings(config);
    if (!searchKeeps(settings, account.id)) return 0;
    const now = (options.now ?? Date.now)();
    const own = new Set([...ownHandles(config, account.id), ...(options.own ?? []).map(ownHandle)]);
    const workspace = workspaceOf(config, account.id);
    const lines = captures.flatMap((capture) => {
      try {
        const line = inboxLineOf(capture, account.id, { own, workspace, seenAt: now });
        return line === undefined ? [] : [line];
      } catch {
        return [];
      }
    });
    const today = new Date(now).toISOString().slice(0, 10);
    if (prunedDay !== today) {
      prunedDay = today;
      await pruneInboxDays(paths, readActivitySettings(config).retentionDays, now).catch(() => 0);
    }
    if (lines.length === 0) return 0;
    const store = await (options.secrets ?? (() => searchSecretStore(core)))();
    if (keyFor === null || keyFor.store !== store) {
      const key = ensureSearchKey(store, paths.keyLock);
      keyFor = { store, key };
      key.catch(() => {
        if (keyFor?.key === key) keyFor = null;
      });
    }
    const master = await Promise.race([
      keyFor.key,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('the secret store did not give the key in time')), CAPTURE_WAIT_MS).unref(),
      ),
    ]);
    const file = join(paths.inbox, `${today}-${process.pid}.jsonl`);
    for (const line of lines) await appendPrivateLine(file, sealedInboxLine(master, line));
    return lines.length;
  } catch (error) {
    await failed(paths, error, options.warn);
    return 0;
  }
}

/** A handle the caller gave as an address or as a handle already. */
function ownHandle(value: string): string {
  if (value.startsWith('email:') || value.startsWith('slack:')) return value;
  return handleOf('gmail', { address: value }, undefined) ?? value;
}

/** Forgets what this process remembered — the master, the day pruned, the line said — for a test. */
export function resetCaptureForTests(): void {
  warned = false;
  prunedDay = null;
  keyFor = null;
}
