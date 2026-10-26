import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withActivity } from '../activity.ts';
import { readActivitySettings } from '../activity-settings.ts';
import type { GatedChange } from '../change-flow.ts';
import type { ChangeSurface } from '../changes.ts';
import { isDangerous } from '../chars.ts';
import { agentMarker } from '../cli-runtime.ts';
import { type Config, secretsStoreOf } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { remedy } from '../handoffs.ts';
import { withFileLock } from '../lock.ts';
import { MCP_SERVER_MARKER, mcpServerOf } from '../mcp-marker.ts';
import { homeDirectory } from '../paths.ts';
import {
  CAPTURE_FAILURE_FILE,
  ownHandles,
  SEARCH_HANDLE,
  type SearchChannel,
  type SearchDirection,
} from '../search/capture.ts';
import { deleteSearchKey, ensureSearchKey, readSearchKey, searchSecretStore } from '../search/crypto.ts';
import { searchEndpoint } from '../search/endpoint-rule.ts';
import {
  type BackupState,
  backupState,
  type DiskEncryptionState,
  diskEncryptionState,
  ensureSearchFolder,
  folderIsShared,
  type SearchPaths,
  searchPaths,
} from '../search/folder.ts';
import {
  type IndexRunResult,
  keptAccounts,
  keptFrom,
  pruneSearchIndex,
  runSearchIndex,
  type SearchDeps,
  searchSystem,
} from '../search/indexer.ts';
import { DEFAULT_SEARCH_MODEL, SEARCH_MODELS, searchModelName, searchModelProfile } from '../search/models.ts';
import { OllamaClient, type SearchModelCheck, type SearchModelState } from '../search/ollama.ts';
import { excerpt, fuse, nearest, queryTerms, wordsExpression } from '../search/rank.ts';
import { readSearchSettings, type SearchModelSetting, type SearchSettings, storedSearch } from '../search/settings.ts';
import { loadSearchSqlite, probeSearchSqlite } from '../search/sqlite.ts';
import {
  FLAG_MISMATCH,
  FLAG_UNRENDERABLE,
  type MessageRow,
  openSearchStore,
  PERSON_ID,
  type RowFilter,
  type SearchStore,
} from '../search/store.ts';
import { wrapUntrusted } from '../untrusted.ts';
import type { DoctorCheck } from './maintenance.ts';

/**
 * Search on this machine (design 2026-10-26-local-search): what each person asked, found by words and by meaning, from
 * what Agent Comms already had in hand — the person's view, at a terminal and in the app, and nobody else's.
 *
 * **Who may (S13).** Every command here but `status` and the tightenings — `off`, `accounts remove`, `model none`,
 * `delete` — is refused inside an MCP server's process (its marker, `AGENTCOMMS_MCP_SERVER`) and under an agent's
 * environment marker, as `activity items` and the event service's person-only reads are. No MCP tool reads the index:
 * a year of everyone's mail, searchable by meaning, is the widest read there is. The marker check is a speed bump
 * against agents, not a boundary: a shell runs as the person, and code running as the person can read what the person
 * can. `status` is content-free, so doctor — and `comms_doctor` — may show it.
 *
 * **What comes back.** Everything a sender wrote — a name, a subject, a line, an excerpt, a message's text — only
 * inside the untrusted-content envelope, each field with a boundary of its own. A search writes one activity line —
 * its words and a count, with no items — so the Messages join never shows the person's search as an agent's read.
 */

// ── Who may ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Refuses, as exit 10, inside an MCP server's process and under an agent's marker: a person's search, or a change to
 * what Search keeps that only they make.
 */
export function refuseSearchToAgents(env: NodeJS.ProcessEnv, what: string): void {
  if (mcpServerOf(env) !== undefined) {
    throw new CommsError(
      'APPROVAL_REQUIRED',
      `only a person can ${what}, at a terminal or in the app — an MCP server's process cannot`,
      {
        hint: 'No tool reads what Search keeps. Agents search each account live, with gmail_search and slack_search.',
        details: { reason: 'MCP_SERVER_PROCESS', marker: MCP_SERVER_MARKER },
      },
    );
  }
  const marker = agentMarker(env);
  if (marker !== null) {
    throw new CommsError('APPROVAL_REQUIRED', `only a person can ${what}, at a terminal or in the app, not an agent`, {
      hint: 'Ask the person to do it in the Agent Comms app, or in their own terminal. Agents search each account live, with gmail_search and slack_search.',
      details: { reason: 'AGENT_MARKER', marker },
    });
  }
}

/** What every operation here takes besides its request: the environment it is refused by, and stand-ins for tests. */
export interface SearchOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly deps?: SearchDeps | undefined;
}

function envOf(options: SearchOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function nowOf(options: SearchOptions): number {
  return (options.deps?.now ?? Date.now)();
}

function secretsOf(core: Core, options: SearchOptions) {
  return (options.deps?.secrets ?? (() => searchSecretStore(core)))();
}

// ── Status (content-free) ──────────────────────────────────────────────────────────────────────────────────────

export interface SearchAccountView {
  readonly id: string;
  readonly alias: string;
  readonly channel: SearchChannel;
}

export interface SearchStatus {
  readonly on: boolean;
  /** The accounts whose messages are kept, by id and their name now. */
  readonly accounts: readonly SearchAccountView[];
  /** Activity's days: what is kept goes when they pass (S12). */
  readonly retentionDays: number;
  readonly folder: string;
  /** What is held: counts, size and the oldest day — never what any of it says. */
  readonly kept: {
    readonly messages: number;
    readonly asked: number;
    readonly answered: number;
    readonly people: number;
    /** Captures waiting in the inbox for the next index run. */
    readonly waiting: number;
    readonly bytes: number;
    readonly oldestDay: string | null;
  };
  /** Whether this Node can hold the words index: Node 22.18 or newer. */
  readonly words: 'ready' | 'needs-newer-node';
  readonly model: {
    readonly address: string;
    readonly name: string;
    readonly state: SearchModelState;
    readonly digest: string | null;
    readonly detail: string;
    /** What a person runs to get it: Agent Comms downloads nothing itself. */
    readonly pull: string;
    /** Whether Ollama's local-only mode is set where this can see it: `OLLAMA_NO_CLOUD`, or `disable_ollama_cloud`. */
    readonly localOnly: boolean;
  } | null;
  /** The reviewed models, the default first. */
  readonly models: readonly { readonly name: string; readonly download: string; readonly licence: string }[];
  readonly backups: BackupState;
  readonly diskEncryption: DiskEncryptionState;
  /** Where the key is: the Keychain, or a file beside the data — which protects only a copy of the folder alone. */
  readonly keyStore: 'keychain' | 'file';
  readonly key: 'present' | 'none' | 'unknown';
  /** The last capture that could not be kept, and when — never what it was. */
  readonly lastCaptureFailure: { readonly at: string; readonly message: string } | null;
  /** Sentences a screen shows: what is not encrypted, what is not checked. */
  readonly notes: readonly string[];
  /** Values in config.json read as something stricter. */
  readonly problems: readonly string[];
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      total += info.isDirectory() ? await folderBytes(path) : info.size;
    } catch {
      // Gone since it was listed.
    }
  }
  return total;
}

async function waitingLines(paths: SearchPaths): Promise<number> {
  let names: string[];
  try {
    names = await readdir(paths.inbox);
  } catch {
    return 0;
  }
  let lines = 0;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const text = await readFile(join(paths.inbox, name), 'utf8');
      lines += text.split('\n').filter((line) => line.trim() !== '').length;
    } catch {
      // Taken since it was listed.
    }
  }
  return lines;
}

/** Counts kept, read without opening any record: the database's own numbers. Null when there is none. */
async function heldCounts(
  paths: SearchPaths,
): Promise<{ messages: number; in: number; out: number; people: number; oldestSeenAt: number | null } | null> {
  try {
    await stat(paths.database);
  } catch {
    return null;
  }
  const sqlite = await loadSearchSqlite();
  let db: InstanceType<typeof sqlite.DatabaseSync>;
  try {
    db = new sqlite.DatabaseSync(paths.database, { readOnly: true });
  } catch {
    return null;
  }
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    const row = db
      .prepare(
        `SELECT count(*) AS n, sum(direction = 'in') AS inbound, sum(direction = 'out') AS outbound, min(seen_at) AS oldest,
           (SELECT count(*) FROM people) AS people FROM messages`,
      )
      .get() as { n: number; inbound: number | null; outbound: number | null; oldest: number | null; people: number };
    return {
      messages: Number(row.n),
      in: Number(row.inbound ?? 0),
      out: Number(row.outbound ?? 0),
      people: Number(row.people),
      oldestSeenAt: row.oldest === null ? null : Number(row.oldest),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function localOnlyMode(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env.OLLAMA_NO_CLOUD !== undefined && env.OLLAMA_NO_CLOUD !== '' && env.OLLAMA_NO_CLOUD !== '0') return true;
  try {
    const raw = await readFile(join(homeDirectory(env), '.ollama', 'server.json'), 'utf8');
    return (JSON.parse(raw) as { disable_ollama_cloud?: unknown }).disable_ollama_cloud === true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether Search was ever switched on here: on now, or its folder is still there. */
export async function searchEverUsed(core: Core): Promise<boolean> {
  return (
    readSearchSettings(await core.config.load()).enabled === 'on' ||
    (await exists(searchPaths(core.paths.stateDir).dir))
  );
}

/** The accounts Search keeps, by id, with their name now. */
function accountViews(config: Config, settings: SearchSettings): SearchAccountView[] {
  return [...keptAccounts(config, settings).entries()].map(([id, account]) => ({ id, ...account }));
}

/**
 * Where Search stands, content-free (§8, `status`): on or off, the accounts, the days kept, what is held by count and
 * size, the model's state, the backup exclusion, FileVault and where the key is. Reads nothing any message says, makes
 * nothing, and asks the model server only for its list. Allowed anywhere.
 */
export async function searchStatus(core: Core, options: SearchOptions = {}): Promise<SearchStatus> {
  const env = envOf(options);
  const config = await core.config.load();
  const settings = readSearchSettings(config);
  const paths = searchPaths(core.paths.stateDir);
  const system = searchSystem(options.deps ?? {});
  let words: SearchStatus['words'] = 'ready';
  try {
    await probeSearchSqlite();
  } catch {
    words = 'needs-newer-node';
  }
  const held = words === 'ready' ? await heldCounts(paths).catch(() => null) : null;
  // The secret store is asked only where Search has been used: a machine that never switched it on has no key.
  let key: SearchStatus['key'] = 'none';
  if (settings.enabled === 'on' || (await exists(paths.dir))) {
    try {
      key = (await readSearchKey(await secretsOf(core, options))) === null ? 'none' : 'present';
    } catch {
      key = 'unknown';
    }
  }
  let model: SearchStatus['model'] = null;
  if (settings.model !== null) {
    const client = new OllamaClient(settings.model.address, settings.model.name, { exchange: options.deps?.exchange });
    const check = await client.check();
    model = {
      address: settings.model.address,
      name: settings.model.name,
      state: check.state,
      digest: check.digest ?? null,
      detail: check.detail,
      pull: `ollama pull ${settings.model.name}`,
      localOnly: await localOnlyMode(env),
    };
  }
  let lastCaptureFailure: SearchStatus['lastCaptureFailure'] = null;
  try {
    const failure = JSON.parse(await readFile(join(paths.dir, CAPTURE_FAILURE_FILE), 'utf8')) as {
      at?: unknown;
      message?: unknown;
    };
    if (typeof failure.at === 'string' && typeof failure.message === 'string') {
      lastCaptureFailure = { at: failure.at, message: failure.message };
    }
  } catch {
    lastCaptureFailure = null;
  }
  const keyStore = secretsStoreOf(config);
  const backups = await backupState(paths, system);
  const diskEncryption = await diskEncryptionState(system);
  const notes = [
    'Treat this folder like your mail: the words index and the vectors are not encrypted, and vectors can be turned back into text close to what was said.',
    ...(keyStore === 'file'
      ? [
          'The key is kept in a file beside the data, so the encryption protects only a copy of the search folder alone.',
        ]
      : []),
    ...(system.platform === 'darwin' ? [] : ['Backups and disk encryption are not checked on this platform.']),
    ...(diskEncryption === 'off' ? ['FileVault is off: the disk itself is not encrypted.'] : []),
  ];
  return {
    on: settings.enabled === 'on',
    accounts: accountViews(config, settings),
    retentionDays: readActivitySettings(config).retentionDays,
    folder: paths.dir,
    kept: {
      messages: held?.messages ?? 0,
      asked: held?.in ?? 0,
      answered: held?.out ?? 0,
      people: held?.people ?? 0,
      waiting: await waitingLines(paths),
      bytes: await folderBytes(paths.dir),
      oldestDay:
        held === null || held.oldestSeenAt === null ? null : new Date(held.oldestSeenAt).toISOString().slice(0, 10),
    },
    words,
    model,
    models: SEARCH_MODELS.map((profile) => ({
      name: profile.name,
      download: profile.download,
      licence: profile.licence,
    })),
    backups,
    diskEncryption,
    keyStore,
    key,
    lastCaptureFailure,
    notes,
    problems: settings.problems,
  };
}

// ── Searching ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The longest a query may be, in characters, and the most hits one answer holds. */
export const MAX_QUERY_CHARS = 500;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

/** A query as the grammar takes it: 1 to 500 characters, none of them a control or a bidi character. */
export function searchQueryText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CommsError('USAGE', 'a search needs words to look for', {
      hint: 'Give them after the command, or after -- when they start with a dash.',
    });
  }
  const chars = [...value];
  if (chars.length > MAX_QUERY_CHARS) {
    throw new CommsError('USAGE', `a search is at most ${MAX_QUERY_CHARS} characters, not ${chars.length}`);
  }
  for (const char of chars) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || isDangerous(code)) {
      throw new CommsError('USAGE', 'a search cannot hold a control character, a line break or a bidi character');
    }
  }
  return value.trim();
}

const SPAN = /^(\d{1,4})([dh])$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EPOCH_MS = /^\d{1,16}$/;

/** A time as milliseconds: milliseconds since 1970, an ISO time, or a span back from now — `7d`, `12h`. */
export function searchTime(value: string | number | undefined, now: number, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (EPOCH_MS.test(text) && Number(text) <= 8.64e15) return Number(text);
  const span = SPAN.exec(text);
  if (span !== null) return now - Number(span[1]) * (span[2] === 'd' ? 86_400_000 : 3_600_000);
  const at = ISO.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isFinite(at)) return at;
  throw new CommsError(
    'USAGE',
    `${flag} takes milliseconds since 1970, an ISO time, or a span back from now such as 7d or 12h — not "${text.slice(0, 40)}"`,
  );
}

export interface SearchQueryRequest {
  readonly text: string;
  /** A person's id: only what they sent. */
  readonly person?: string | undefined;
  /** Accounts by name; every account Search keeps when left out. */
  readonly accounts?: readonly string[] | undefined;
  readonly channel?: string | undefined;
  readonly since?: string | number | undefined;
  readonly until?: string | number | undefined;
  readonly limit?: number | undefined;
  /** `in` (what people asked) unless asked: `out` for what was sent, `any` for both. */
  readonly direction?: string | undefined;
}

/** A hit: what a screen shows of one message, and what joins it to its story. */
export interface SearchHit {
  readonly sourceId: string;
  readonly eventId: string | null;
  readonly channel: SearchChannel;
  readonly account: { readonly id: string; readonly alias: string };
  readonly direction: SearchDirection;
  /** When it was sent, in milliseconds. */
  readonly at: number;
  readonly person: { readonly id: string; readonly linked: boolean } | null;
  /** The sender's handle — `email:<address>` or `slack:<team>/<user>` — plain when it is a plain one, else enveloped. */
  readonly handle: string | null;
  readonly from: string | null;
  readonly subject: string | null;
  readonly line: string;
  readonly excerpt: string;
  /** Slack's `mismatch` and `unrenderable`, shown on the hit. */
  readonly flags: readonly ('mismatch' | 'unrenderable')[];
  readonly partial: boolean;
  /** The replies Agent Comms sent to it. */
  readonly answeredBy: readonly { readonly sourceId: string; readonly at: number }[];
  /** Where it ranked in each list, 1-based, or null for a list it was not in. */
  readonly rank: { readonly words: number | null; readonly meaning: number | null };
}

export interface SearchQueryResult {
  /** `hybrid` when meaning was looked at too; `words` with no model, or one that failed its check. */
  readonly mode: 'hybrid' | 'words';
  /** Nothing left this machine: words only, or the local model checked this run. */
  readonly searchedOnThisMac: true;
  /** Kept messages with no vector yet in the set searched by meaning. */
  readonly pending: number;
  readonly model: { readonly name: string; readonly digest: string } | null;
  /** Why meaning was not looked at, when a model is set and it was not. */
  readonly modelNote: string | null;
  /** How many kept messages the filters left to look through. */
  readonly looked: number;
  readonly ms: number;
  readonly hits: readonly SearchHit[];
}

const PLAIN_ADDRESS = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
const PLAIN_SLACK = /^slack:[A-Z0-9]{1,40}\/[A-Z0-9]{1,40}$/;

/** A handle as an answer gives it: bare when it is a plain address or a Slack id, enveloped otherwise. */
function shownHandle(handle: string | null): string | null {
  if (handle === null) return null;
  if (PLAIN_SLACK.test(handle)) return handle;
  if (handle.startsWith('email:') && PLAIN_ADDRESS.test(handle.slice('email:'.length))) return handle;
  return wrapUntrusted(handle, { field: 'handle' });
}

function wrapped(text: string | undefined, field: string, row: MessageRow, alias: string): string | null {
  if (text === undefined || text === '') return null;
  return wrapUntrusted(text, {
    field,
    id: row.sourceId,
    ...(/^[A-Za-z0-9._:@/-]{1,128}$/.test(alias) ? { inbox: alias } : {}),
  });
}

function flagsOf(row: MessageRow): ('mismatch' | 'unrenderable')[] {
  return [
    ...((row.flags & FLAG_MISMATCH) !== 0 ? (['mismatch'] as const) : []),
    ...((row.flags & FLAG_UNRENDERABLE) !== 0 ? (['unrenderable'] as const) : []),
  ];
}

interface OpenedIndex {
  readonly store: SearchStore;
  readonly config: Config;
  readonly settings: SearchSettings;
  readonly kept: Map<string, { alias: string; channel: SearchChannel }>;
  readonly keptFrom: number;
}

/** The index opened for a person's read, or null when nothing is kept yet. */
async function openForReading(core: Core, options: SearchOptions): Promise<OpenedIndex | null> {
  const config = await core.config.load();
  const settings = readSearchSettings(config);
  await probeSearchSqlite();
  const master = await readSearchKey(await secretsOf(core, options));
  if (master === null) return null;
  const store = await openSearchStore(searchPaths(core.paths.stateDir), master, { create: false });
  if (store === null) return null;
  return { store, config, settings, kept: keptAccounts(config, settings), keptFrom: keptFrom(config, nowOf(options)) };
}

function channelOf(value: string | undefined): SearchChannel | undefined {
  if (value === undefined) return undefined;
  if (value === 'gmail' || value === 'slack') return value;
  throw new CommsError('USAGE', `--channel is gmail or slack, not "${value.slice(0, 40)}"`);
}

function directionOf(value: string | undefined): SearchDirection | 'any' {
  if (value === undefined) return 'in';
  if (value === 'in' || value === 'out' || value === 'any') return value;
  throw new CommsError('USAGE', `--direction is in, out or any, not "${value.slice(0, 40)}"`);
}

function limitOf(value: number | undefined, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new CommsError('USAGE', `--limit is a whole number from 1 to ${max}, not ${String(value).slice(0, 20)}`);
  }
  return value;
}

function personIdOf(value: unknown): string {
  if (typeof value !== 'string' || !PERSON_ID.test(value)) {
    throw new CommsError('USAGE', `"${String(value).slice(0, 40)}" is not a person's id`, {
      hint: 'A person is p_ and 26 letters and digits, as search people lists them.',
    });
  }
  return value;
}

/** The accounts a read is narrowed to: those named, each one Search keeps, or every one it keeps. */
function accountFilter(opened: OpenedIndex, names: readonly string[] | undefined): string[] {
  if (names === undefined || names.length === 0) return [...opened.kept.keys()];
  return names.map((name) => {
    const found = [...opened.kept.entries()].find(([, account]) => account.alias === name);
    if (found === undefined) {
      throw new CommsError('USAGE', `Search keeps nothing for "${name.slice(0, 60)}"`, {
        hint: 'search status lists the accounts Search keeps.',
      });
    }
    return found[0];
  });
}

/** The person's handles, or NOT_FOUND. */
function handlesOfPerson(store: SearchStore, id: string, own: ReadonlySet<string>): string[] {
  if (store.person(id) === undefined) throw new CommsError('NOT_FOUND', `no person ${id} is kept`);
  return store
    .handlesOf(id)
    .map((entry) => entry.handle)
    .filter((handle) => !own.has(handle));
}

/** Every handle that is an account's own, from the configuration: never shown as a person. */
function ownHandleSet(config: Config): Set<string> {
  const own = new Set<string>();
  for (const inbox of Object.values(config.inboxes)) for (const handle of ownHandles(config, inbox.id)) own.add(handle);
  for (const account of Object.values(config.accounts)) {
    for (const handle of ownHandles(config, account.id)) own.add(handle);
  }
  return own;
}

/** Which vectors a query is compared with, and how many kept rows have none there yet. */
function servingGeneration(
  store: SearchStore,
  model: SearchModelSetting,
  check: SearchModelCheck,
): { generation: number; note: string | null } | null {
  if (check.state !== 'running') return null;
  const serving = store.generation('serving');
  // The same model at a new digest: the set it made before serves until the new one is complete (§5).
  if (serving !== null && serving.name === model.name) {
    return { generation: serving.generation, note: null };
  }
  const target = store.generation('target');
  if (target !== null && target.name === model.name) {
    return { generation: target.generation, note: null };
  }
  return null;
}

/**
 * A person's search (§6): first the inbox is indexed, for up to two seconds; then the filters, in SQL; the words, by
 * bm25; the meaning, by an exact scan of the current vectors against the query embedded by the local model; the two
 * fused by reciprocal rank. With no model, or one that fails its check, by words only, and it says so.
 */
export async function searchQuery(
  core: Core,
  request: SearchQueryRequest,
  options: SearchOptions = {},
): Promise<SearchQueryResult> {
  refuseSearchToAgents(envOf(options), 'search what Search on this machine keeps');
  const started = Date.now();
  const text = searchQueryText(request.text);
  const channel = channelOf(request.channel);
  const direction = directionOf(request.direction);
  const limit = limitOf(request.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  const now = nowOf(options);
  const since = searchTime(request.since, now, '--since');
  const until = searchTime(request.until, now, '--until');
  const person = request.person === undefined ? undefined : personIdOf(request.person);
  const run = async (): Promise<SearchQueryResult> => {
    const indexed = await runSearchIndex(core, { budgetMs: 2_000, waitMs: 2_000 }, options.deps ?? {});
    const opened = await openForReading(core, options);
    const empty = (note: string | null): SearchQueryResult => ({
      mode: 'words',
      searchedOnThisMac: true,
      pending: 0,
      model: null,
      modelNote: note,
      looked: 0,
      ms: Date.now() - started,
      hits: [],
    });
    if (opened === null) return empty(null);
    const { store, config, settings } = opened;
    try {
      const own = ownHandleSet(config);
      const filter: RowFilter = {
        accounts: accountFilter(opened, request.accounts),
        keptFrom: opened.keptFrom,
        ...(channel === undefined ? {} : { channel }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        direction,
        ...(person === undefined ? {} : { handles: handlesOfPerson(store, person, own) }),
      };
      const terms = queryTerms(text);
      const expression = wordsExpression(terms);
      const words = expression === undefined ? [] : store.wordsMatch(expression, filter, MAX_SEARCH_LIMIT);
      let meaning: number[] = [];
      let mode: SearchQueryResult['mode'] = 'words';
      let modelNote: string | null = null;
      let pending = 0;
      let usedModel: SearchQueryResult['model'] = null;
      const looked = store.countRows(filter);
      if (settings.model !== null) {
        const client = new OllamaClient(settings.model.address, settings.model.name, {
          exchange: options.deps?.exchange,
        });
        const check = indexed.model ?? (await client.check());
        const serving = servingGeneration(store, settings.model, check);
        if (serving === null) {
          modelNote = check.state === 'running' ? 'no message has a vector from this model yet' : check.detail;
          pending = looked;
        } else {
          try {
            const [queryVector] = await client.embed([client.profile.query(text)]);
            if (queryVector !== undefined) {
              meaning = nearest(queryVector, store.vectors(serving.generation, filter), MAX_SEARCH_LIMIT);
              mode = 'hybrid';
              usedModel = { name: settings.model.name, digest: check.digest ?? '' };
            }
          } catch {
            modelNote = 'the local model could not read the question, so this is by words only';
          }
          const target = store.generation('target');
          pending = store.countWithoutVector(target?.generation ?? serving.generation);
        }
      }
      const found = store.rowsById([...new Set([...words, ...meaning])]);
      const atOf = new Map([...found.values()].map((row) => [row.id, row.at]));
      const fused = fuse(words, meaning, atOf).slice(0, limit);
      const rows = new Map(
        fused.flatMap((entry) => {
          const row = found.get(entry.id);
          return row === undefined ? [] : [[entry.id, row] as const];
        }),
      );
      const answers = store.answers([...rows.values()]);
      const hits: SearchHit[] = [];
      for (const entry of fused) {
        const row = rows.get(entry.id);
        if (row === undefined) continue;
        const account = opened.kept.get(row.accountId);
        if (account === undefined) continue;
        let record: ReturnType<SearchStore['record']>;
        try {
          record = store.record(row);
        } catch {
          continue;
        }
        const who = row.handle === null ? undefined : store.personOf(row.handle);
        hits.push({
          sourceId: row.sourceId,
          eventId: row.eventId,
          channel: row.channel,
          account: { id: row.accountId, alias: account.alias },
          direction: row.direction,
          at: row.at,
          person: who === undefined ? null : who,
          handle: shownHandle(row.handle),
          from: wrapped(record.fromName, 'from-name', row, account.alias),
          subject: wrapped(record.subject, 'subject', row, account.alias),
          line: wrapped(record.line, 'line', row, account.alias) ?? '',
          excerpt: wrapped(excerpt(record.text, terms), 'excerpt', row, account.alias) ?? '',
          flags: flagsOf(row),
          partial: row.partial,
          answeredBy: answers.get(row.sourceId) ?? [],
          rank: { words: entry.words, meaning: entry.meaning },
        });
      }
      return {
        mode,
        searchedOnThisMac: true,
        pending,
        model: usedModel,
        modelNote,
        looked,
        ms: Date.now() - started,
        hits,
      };
    } finally {
      store.close();
    }
  };
  // One activity line: the words and a count, never an item — so no message reads as an agent's after a search.
  return withActivity(
    { core, channel: 'core', surface: 'cli', account: { id: '', alias: '' }, query: text },
    'core.search.query',
    'read',
    run,
    (result) => ({ count: result.hits.length }),
  );
}

// ── People ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SearchPersonView {
  readonly id: string;
  /** True once the person joined or separated handles themselves. */
  readonly linked: boolean;
  /** The name the person gave them: the person's own words, shown as they are. */
  readonly label: string | null;
  /** The latest name a sender gave, enveloped: a suggestion, never proof of who they are. */
  readonly name: string | null;
  readonly handles: readonly { readonly handle: string | null; readonly name: string | null }[];
  /** Messages kept from them in the time asked, and when the newest was sent. */
  readonly count: number;
  readonly lastAt: number | null;
}

function personView(
  store: SearchStore,
  entry: { id: string; linked: boolean; label: string | undefined; count: number; lastAt: number | null },
  own: ReadonlySet<string>,
): SearchPersonView {
  const handles = store.handlesOf(entry.id).filter((handle) => !own.has(handle.handle));
  const newest = [...handles].sort((a, b) => b.lastSeenAt - a.lastSeenAt).find((handle) => handle.name !== undefined);
  const name = (text: string | undefined) => (text === undefined ? null : wrapUntrusted(text, { field: 'from-name' }));
  return {
    id: entry.id,
    linked: entry.linked,
    label: entry.label ?? null,
    name: name(newest?.name),
    handles: handles.map((handle) => ({ handle: shownHandle(handle.handle), name: name(handle.name) })),
    count: entry.count,
    lastAt: entry.lastAt,
  };
}

/** Every person something is kept from (S5, §6): their handles, latest name, count and when they last wrote. */
export async function searchPeople(
  core: Core,
  request: { readonly since?: string | number | undefined } = {},
  options: SearchOptions = {},
): Promise<{ readonly people: readonly SearchPersonView[] }> {
  refuseSearchToAgents(envOf(options), 'list the people Search on this machine keeps messages from');
  const since = searchTime(request.since, nowOf(options), '--since');
  await runSearchIndex(core, { budgetMs: 0, waitMs: 2_000 }, options.deps ?? {});
  const opened = await openForReading(core, options);
  if (opened === null) return { people: [] };
  const { store, config } = opened;
  try {
    const own = ownHandleSet(config);
    const filter: RowFilter = {
      accounts: [...opened.kept.keys()],
      keptFrom: opened.keptFrom,
      direction: 'in',
      ...(since === undefined ? {} : { since }),
    };
    const people = store
      .people(filter)
      .filter((entry) => entry.count > 0 || entry.linked || entry.label !== undefined)
      .map((entry) => personView(store, entry, own))
      .filter((view) => view.handles.length > 0);
    return { people };
  } finally {
    store.close();
  }
}

export interface SearchPersonMessage {
  readonly sourceId: string;
  readonly eventId: string | null;
  readonly channel: SearchChannel;
  readonly account: { readonly id: string; readonly alias: string };
  readonly at: number;
  readonly line: string;
  readonly subject: string | null;
  readonly flags: readonly ('mismatch' | 'unrenderable')[];
  readonly partial: boolean;
  readonly answeredBy: readonly { readonly sourceId: string; readonly at: number }[];
}

/** One person: their handles, and what they sent, newest first, one line each (§6). */
export async function searchPerson(
  core: Core,
  id: string,
  request: { readonly since?: string | number | undefined; readonly limit?: number | undefined } = {},
  options: SearchOptions = {},
): Promise<{
  readonly person: SearchPersonView;
  readonly messages: readonly SearchPersonMessage[];
  readonly more: boolean;
}> {
  refuseSearchToAgents(envOf(options), 'read what Search on this machine keeps from a person');
  const person = personIdOf(id);
  const limit = limitOf(request.limit, 200, 50);
  const since = searchTime(request.since, nowOf(options), '--since');
  await runSearchIndex(core, { budgetMs: 0, waitMs: 2_000 }, options.deps ?? {});
  const opened = await openForReading(core, options);
  if (opened === null) throw new CommsError('NOT_FOUND', `no person ${person} is kept`);
  const { store, config } = opened;
  try {
    const own = ownHandleSet(config);
    const handles = handlesOfPerson(store, person, own);
    const filter: RowFilter = {
      accounts: [...opened.kept.keys()],
      keptFrom: opened.keptFrom,
      direction: 'in',
      handles,
      ...(since === undefined ? {} : { since }),
    };
    const rows = store.rows(filter, limit + 1);
    const answers = store.answers(rows);
    const messages = rows.slice(0, limit).flatMap((row): SearchPersonMessage[] => {
      const account = opened.kept.get(row.accountId);
      if (account === undefined) return [];
      let record: ReturnType<SearchStore['record']>;
      try {
        record = store.record(row);
      } catch {
        return [];
      }
      return [
        {
          sourceId: row.sourceId,
          eventId: row.eventId,
          channel: row.channel,
          account: { id: row.accountId, alias: account.alias },
          at: row.at,
          line: wrapped(record.line, 'line', row, account.alias) ?? '',
          subject: wrapped(record.subject, 'subject', row, account.alias),
          flags: flagsOf(row),
          partial: row.partial,
          answeredBy: answers.get(row.sourceId) ?? [],
        },
      ];
    });
    const entry = store.people({ ...filter, handles: undefined }).find((each) => each.id === person);
    const held = store.person(person);
    const view = personView(
      store,
      entry ?? { id: person, linked: held?.linked ?? false, label: held?.label, count: messages.length, lastAt: null },
      own,
    );
    return { person: view, messages, more: rows.length > limit };
  } finally {
    store.close();
  }
}

/** One kept message in full: its text, subject and sender enveloped, and the replies sent to it (§8, `show`). */
export async function searchShow(
  core: Core,
  sourceId: string,
  options: SearchOptions = {},
): Promise<{
  readonly message: SearchHit & {
    readonly text: string;
    readonly threadId: string | null;
    readonly replyTo: string | null;
  };
}> {
  refuseSearchToAgents(envOf(options), 'read a message Search on this machine keeps');
  if (typeof sourceId !== 'string' || !/^[A-Za-z0-9._:/@+=-]{1,400}$/.test(sourceId)) {
    throw new CommsError('USAGE', `"${String(sourceId).slice(0, 40)}" is not a message's id`, {
      hint: 'A Gmail message id, or a Slack message as <channelId>/<ts>, as a search returns it.',
    });
  }
  await runSearchIndex(core, { budgetMs: 0, waitMs: 2_000 }, options.deps ?? {});
  const opened = await openForReading(core, options);
  const notFound = () => new CommsError('NOT_FOUND', `Search keeps no message ${sourceId}`);
  if (opened === null) throw notFound();
  const { store } = opened;
  try {
    const row = store.rowBySource(sourceId);
    const account = row === undefined ? undefined : opened.kept.get(row.accountId);
    if (row === undefined || account === undefined || row.seenAt < opened.keptFrom) throw notFound();
    const record = store.record(row);
    const who = row.handle === null ? undefined : store.personOf(row.handle);
    return {
      message: {
        sourceId: row.sourceId,
        eventId: row.eventId,
        channel: row.channel,
        account: { id: row.accountId, alias: account.alias },
        direction: row.direction,
        at: row.at,
        person: who ?? null,
        handle: shownHandle(row.handle),
        from: wrapped(record.fromName, 'from-name', row, account.alias),
        subject: wrapped(record.subject, 'subject', row, account.alias),
        line: wrapped(record.line, 'line', row, account.alias) ?? '',
        excerpt: wrapped(excerpt(record.text, []), 'excerpt', row, account.alias) ?? '',
        text: wrapped(record.text, 'text', row, account.alias) ?? '',
        threadId: row.threadId,
        replyTo: row.replyTo,
        flags: flagsOf(row),
        partial: row.partial,
        answeredBy: store.answers([row]).get(row.sourceId) ?? [],
        rank: { words: null, meaning: null },
      },
    };
  } finally {
    store.close();
  }
}

// ── Upkeep ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The longest `search index --budget` may run, in seconds. */
export const MAX_INDEX_BUDGET_SECONDS = 600;
export const DEFAULT_INDEX_BUDGET_SECONDS = 30;

/** One index run (S10): the inbox taken, vectors made while the budget lasts, what is past its days pruned. */
export async function searchIndex(
  core: Core,
  request: { readonly budgetSeconds?: number | undefined } = {},
  options: SearchOptions = {},
): Promise<IndexRunResult> {
  refuseSearchToAgents(envOf(options), 'run the indexer of Search on this machine');
  const budget = request.budgetSeconds ?? DEFAULT_INDEX_BUDGET_SECONDS;
  if (!Number.isInteger(budget) || budget < 0 || budget > MAX_INDEX_BUDGET_SECONDS) {
    throw new CommsError('USAGE', `--budget is a whole number of seconds from 0 to ${MAX_INDEX_BUDGET_SECONDS}`);
  }
  await probeSearchSqlite();
  return runSearchIndex(core, { budgetMs: budget * 1000, waitMs: 5_000 }, options.deps ?? {});
}

/**
 * Rebuild (§5): a new set of vectors is started for the model in force, and made from the kept text while the budget
 * lasts; the set before serves until the new one is complete, and `search index` goes on with it. Words keep working.
 */
export async function searchRebuild(
  core: Core,
  request: { readonly budgetSeconds?: number | undefined } = {},
  options: SearchOptions = {},
): Promise<IndexRunResult> {
  refuseSearchToAgents(envOf(options), 'rebuild what Search on this machine keeps');
  const budget = request.budgetSeconds ?? DEFAULT_INDEX_BUDGET_SECONDS;
  if (!Number.isInteger(budget) || budget < 0 || budget > MAX_INDEX_BUDGET_SECONDS) {
    throw new CommsError('USAGE', `--budget is a whole number of seconds from 0 to ${MAX_INDEX_BUDGET_SECONDS}`);
  }
  await probeSearchSqlite();
  return runSearchIndex(core, { budgetMs: budget * 1000, waitMs: 5_000, rebuild: true }, options.deps ?? {});
}

/** The index opened to change a person: under the index lock, since only one writer may write. */
async function withWritableIndex<T>(
  core: Core,
  options: SearchOptions,
  fn: (store: SearchStore, opened: OpenedIndex) => T,
): Promise<T> {
  const paths = searchPaths(core.paths.stateDir);
  await probeSearchSqlite();
  return withFileLock(
    paths.indexLock,
    async () => {
      const opened = await openForReading(core, options);
      if (opened === null) throw new CommsError('NOT_FOUND', 'Search keeps nothing yet');
      try {
        return opened.store.transaction(() => fn(opened.store, opened));
      } finally {
        opened.store.close();
      }
    },
    { timeoutMs: 10_000, staleMs: 30_000 },
  );
}

/**
 * The person's own act (S5): two people are one — every handle of `other` joins `into`. Names never join anything;
 * only this does, and `unlink` undoes it.
 */
export async function searchLink(
  core: Core,
  into: string,
  other: string,
  options: SearchOptions = {},
): Promise<{ readonly person: string; readonly joined: string; readonly handles: readonly (string | null)[] }> {
  refuseSearchToAgents(envOf(options), 'join two people in Search on this machine');
  const a = personIdOf(into);
  const b = personIdOf(other);
  if (a === b) throw new CommsError('USAGE', 'a person is already the same person as themselves');
  return withWritableIndex(core, options, (store) => {
    if (store.person(a) === undefined) throw new CommsError('NOT_FOUND', `no person ${a} is kept`);
    if (store.person(b) === undefined) throw new CommsError('NOT_FOUND', `no person ${b} is kept`);
    store.link(a, b, nowOf(options));
    return { person: a, joined: b, handles: store.handlesOf(a).map((entry) => shownHandle(entry.handle)) };
  });
}

/** The person's own act: one handle becomes a person of its own again. */
export async function searchUnlink(
  core: Core,
  handle: string,
  options: SearchOptions = {},
): Promise<{ readonly handle: string | null; readonly person: string; readonly from: string }> {
  refuseSearchToAgents(envOf(options), 'separate people in Search on this machine');
  if (typeof handle !== 'string' || !SEARCH_HANDLE.test(handle)) {
    throw new CommsError('USAGE', `"${String(handle).slice(0, 60)}" is not a handle`, {
      hint: 'A handle is email:<address> or slack:<team>/<user>, as search people lists them.',
    });
  }
  return withWritableIndex(core, options, (store) => {
    const held = store.personOf(handle);
    if (held === undefined) throw new CommsError('NOT_FOUND', 'Search keeps no such handle');
    if (store.handleCount(held.id) < 2) {
      throw new CommsError('USAGE', 'that handle is the only one its person has, so there is nothing to separate');
    }
    const person = store.unlink(handle, nowOf(options));
    return { handle: shownHandle(handle), person, from: held.id };
  });
}

/** The longest label, in characters. */
export const MAX_LABEL_CHARS = 80;

/** The person's own act: the name they know someone by — kept sealed, shown as theirs. */
export async function searchLabel(
  core: Core,
  id: string,
  label: string,
  options: SearchOptions = {},
): Promise<{ readonly person: string; readonly label: string }> {
  refuseSearchToAgents(envOf(options), 'name a person in Search on this machine');
  const person = personIdOf(id);
  const text = typeof label === 'string' ? label.trim() : '';
  const chars = [...text];
  if (
    chars.length === 0 ||
    chars.length > MAX_LABEL_CHARS ||
    chars.some((char) => isDangerous(char.codePointAt(0) ?? 0) || (char.codePointAt(0) ?? 0) < 0x20)
  ) {
    throw new CommsError('USAGE', `a label is 1 to ${MAX_LABEL_CHARS} characters, with no control or bidi character`);
  }
  return withWritableIndex(core, options, (store) => {
    if (store.person(person) === undefined) throw new CommsError('NOT_FOUND', `no person ${person} is kept`);
    store.setLabel(person, text, nowOf(options));
    return { person, label: text };
  });
}

// ── The settings ───────────────────────────────────────────────────────────────────────────────────────────────

export type SearchSettingsRequest =
  | { readonly enabled: 'on' | 'off' }
  | { readonly account: string; readonly include: boolean }
  | { readonly model: { readonly address: string; readonly name?: string | undefined } | null };

export interface SearchSettingsResult {
  /** False when the settings already said this, and nothing was written. */
  readonly changed: boolean;
  readonly on: boolean;
  readonly accounts: readonly SearchAccountView[];
  readonly model: SearchModelSetting | null;
  /** Rows deleted at once: an account no longer kept loses its rows now. */
  readonly deleted: number;
  /** What the person runs next, when there is something: `ollama pull <model>` for a model this machine may not have. */
  readonly next: string | null;
}

/** Whether a request only tightens: off, an account taken out, no model. These apply at once, from anywhere. */
export function searchRequestTightens(request: SearchSettingsRequest): boolean {
  if ('enabled' in request) return request.enabled === 'off';
  if ('account' in request) return !request.include;
  return request.model === null;
}

/** The account an alias names, Gmail or Slack, or a refusal saying what can be kept. */
function searchableAccount(config: Config, alias: string): { id: string; alias: string } {
  const inbox = Object.hasOwn(config.inboxes, alias) ? config.inboxes[alias] : undefined;
  if (inbox !== undefined) {
    if (inbox.provider !== 'gmail') {
      throw new CommsError('USAGE', `${alias} is not a Gmail mailbox: Search keeps Gmail and Slack only`);
    }
    return { id: inbox.id, alias };
  }
  const account = Object.hasOwn(config.accounts, alias) ? config.accounts[alias] : undefined;
  if (account !== undefined) {
    if (account.platform !== 'slack') {
      throw new CommsError('USAGE', `${alias} is not a Slack workspace: Search keeps Gmail and Slack only`, {
        hint: 'Never WhatsApp: its visibility rule leaves no trace of a chat it hides.',
      });
    }
    return { id: account.id, alias };
  }
  throw new CommsError('NOT_FOUND', `no Gmail mailbox or Slack workspace is called "${alias.slice(0, 60)}"`, {
    hint: 'search status lists the accounts Search keeps; agentcomms paths and the channels list the connected ones.',
  });
}

const SEARCH_SUMMARIES = {
  on: 'Keep the words of new messages agents read, and the replies sent, on this machine — encrypted, for as long as Activity keeps its days — so you can search them',
  off: 'Stop keeping the words of new messages on this machine for Search',
} as const;

/**
 * One change to what Search keeps, through the one flow every change goes through (S1, §8): `on`, an account added
 * and a model set are loosenings, shown first and approved — at a terminal, or in the attested app with
 * `--app-approval`; `off`, an account removed and no model are tightenings and apply at once. Removing an account
 * deletes its rows at once; no model drops every vector.
 */
export function searchSettingsChange(
  core: Core,
  request: SearchSettingsRequest,
  surface: ChangeSurface,
  options: SearchOptions = {},
): GatedChange<SearchSettingsResult> {
  const shape = request as { enabled?: unknown; account?: unknown; include?: unknown; model?: unknown };
  const given = ['enabled', 'account', 'model'].filter((key) => (shape as Record<string, unknown>)[key] !== undefined);
  if (given.length !== 1) {
    throw new CommsError('USAGE', 'one change to Search at a time: on or off, an account, or the model');
  }
  if (!searchRequestTightens(request)) refuseSearchToAgents(envOf(options), 'let Search on this machine keep more');
  if ('enabled' in request && request.enabled !== 'on' && request.enabled !== 'off') {
    throw new CommsError('USAGE', `Search is on or off, not "${String(request.enabled).slice(0, 40)}"`);
  }
  let model: SearchModelSetting | null | undefined;
  if ('model' in request && request.model !== null) {
    const endpoint = searchEndpoint(request.model.address);
    const name = request.model.name ?? DEFAULT_SEARCH_MODEL;
    const known = searchModelName(name);
    if (known === undefined) {
      throw new CommsError('USAGE', `"${String(name).slice(0, 60)}" is not on the reviewed list of models`, {
        hint: `Search uses one of: ${SEARCH_MODELS.map((profile) => profile.name).join(', ')} — run on this machine by Ollama. A model whose name ends in cloud never is.`,
      });
    }
    model = { address: endpoint.address, name: known };
  } else if ('model' in request) {
    model = null;
  }
  const edit = (config: Config): Config => {
    const stored = { ...(storedSearch(config) ?? {}) } as Record<string, unknown>;
    if ('enabled' in request) stored.enabled = request.enabled;
    else if ('account' in request) {
      const { id } = searchableAccount(config, request.account);
      const accounts = readSearchSettings(config).accounts.filter((each) => each !== id);
      stored.accounts = request.include ? [...accounts, id] : accounts;
    } else stored.model = model;
    return { ...config, search: stored };
  };
  const summary = (config: Config): string => {
    if ('enabled' in request) return SEARCH_SUMMARIES[request.enabled];
    if ('account' in request) {
      const { alias } = searchableAccount(config, request.account);
      return request.include
        ? `Keep the words of new messages agents read in ${alias} on this machine, to search them`
        : `Stop keeping ${alias}'s messages for Search, and delete what is kept of them now`;
    }
    return model === null || model === undefined
      ? 'Search by words only: no model, and no vector kept'
      : `Make kept messages searchable by meaning with ${model.name}, run by the model server at ${model.address} on this machine`;
  };
  const same = (before: Config, after: Config): boolean =>
    JSON.stringify(storedSearch(before) ?? {}) === JSON.stringify(storedSearch(after) ?? {}) &&
    JSON.stringify(readSearchSettings(before)) === JSON.stringify(readSearchSettings(after));
  return {
    plan: (config) => {
      const after = edit(config);
      return { before: config, after: same(config, after) ? config : after, summary: summary(config) };
    },
    apply: async (consent, planned) => {
      const report = async (config: Config, changed: boolean, deleted: number): Promise<SearchSettingsResult> => {
        const settings = readSearchSettings(config);
        return {
          changed,
          on: settings.enabled === 'on',
          accounts: accountViews(config, settings),
          model: settings.model,
          deleted,
          next: settings.model === null ? null : `ollama pull ${settings.model.name}`,
        };
      };
      if (planned.after === planned.before) return report(planned.before, false, 0);
      const written = await core.config.update(edit, consent ? { consent } : {});
      await core.audit.append({
        inboxId: '',
        operation:
          'enabled' in request
            ? `search.${request.enabled}`
            : 'account' in request
              ? request.include
                ? 'search.accounts.add'
                : 'search.accounts.remove'
              : model === null
                ? 'search.model.none'
                : 'search.model.set',
        outcome: 'ok',
        surface,
        ...('account' in request ? { reason: searchableAccount(written, request.account).alias } : {}),
      });
      let deleted = 0;
      const paths = searchPaths(core.paths.stateDir);
      if ('enabled' in request && request.enabled === 'on') {
        // The folder made private and left out of backups, and the key made, before anything is kept.
        await ensureSearchFolder(paths, searchSystem(options.deps ?? {}));
        await ensureSearchKey(await secretsOf(core, options), paths.keyLock);
      }
      if (searchRequestTightens(request) && !('enabled' in request)) {
        // An account taken out loses its rows now, and no model drops every vector now: upkeep, which needs no key.
        deleted = await pruneSearchIndex(core, options.deps ?? {}).catch(() => 0);
      }
      return report(written, true, deleted);
    },
  };
}

// ── Delete everything ──────────────────────────────────────────────────────────────────────────────────────────

export interface SearchDeleteResult {
  /** The folder that was deleted. */
  readonly folder: string;
  /** How many files were in it. */
  readonly files: number;
  /** Whether the key was deleted from the secret store: any copy of the folder left anywhere now opens for nobody. */
  readonly keyDeleted: boolean;
}

async function filesIn(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if ((await stat(path)).isDirectory()) found.push(...(await filesIn(path)));
      else found.push(path);
    } catch {
      // Gone since it was listed.
    }
  }
  return found;
}

/**
 * Delete everything (§7): a tightening, from anywhere, once `--all --confirm` (or the app's confirm) says so. Stops a
 * run in progress; deletes the inbox, the database, its WAL and SHM — the whole folder; deletes the `search-index` key;
 * writes a content-free audit line. Search stays on or off as it was: what it keeps from now on starts empty, under a
 * new key.
 */
export async function searchDeleteEverything(
  core: Core,
  request: { readonly all?: boolean | undefined; readonly confirm?: boolean | undefined },
  surface: ChangeSurface,
  options: SearchOptions = {},
): Promise<SearchDeleteResult> {
  if (request.all !== true || request.confirm !== true) {
    throw new CommsError('USAGE', 'deleting everything Search keeps needs both --all and --confirm', {
      hint: 'It deletes every message, person, vector and capture Search keeps, and its key. Nothing in Slack or Gmail is touched.',
    });
  }
  const paths = searchPaths(core.paths.stateDir);
  const files = (await filesIn(paths.dir)).length;
  try {
    await writeFile(paths.stop, '', { mode: 0o600 });
  } catch {
    // No folder: nothing to stop.
  }
  const removeAll = async () => {
    let names: string[] = [];
    try {
      names = await readdir(paths.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (join(paths.dir, name) === paths.indexLock) continue;
      await rm(join(paths.dir, name), { recursive: true, force: true });
    }
  };
  try {
    await withFileLock(paths.indexLock, removeAll, { timeoutMs: 15_000, staleMs: 30_000 });
  } catch (error) {
    if (!(error instanceof CommsError && error.code === 'LOCK_TIMEOUT')) throw error;
    // A run that does not stop in time is not waited for: what it would write goes with the folder and the key.
    await removeAll();
  }
  await rm(paths.dir, { recursive: true, force: true });
  const keyDeleted = await deleteSearchKey(await secretsOf(core, options));
  await core.audit.append({ inboxId: '', operation: 'search.delete', outcome: 'ok', surface });
  return { folder: paths.dir, files, keyDeleted };
}

// ── The doctor's check ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * `doctor`'s `search` check (§7), content-free: on or off, what is kept by count and size, the oldest day, the model's
 * state, FileVault and the backup exclusion — and that the folder is to be treated like mail.
 */
export async function searchDoctorCheck(core: Core, options: SearchOptions = {}): Promise<DoctorCheck> {
  const name = 'search';
  // Never switched on here: nothing to look at, and nothing — the secret store, tmutil, fdesetup — is asked.
  try {
    if (!(await searchEverUsed(core))) return { name, ok: true, detail: 'off: nothing is kept' };
  } catch {
    return { name, ok: true, warn: true, detail: 'unknown — the configuration could not be read' };
  }
  let status: SearchStatus;
  try {
    status = await searchStatus(core, options);
  } catch {
    return { name, ok: true, warn: true, detail: 'unknown — Search on this machine could not be read' };
  }
  const shared = await folderIsShared(searchPaths(core.paths.stateDir));
  if (shared === true) {
    return {
      name,
      ok: false,
      detail: `${status.folder} can be read by others, and it holds message words`,
      fix: remedy(`make ${status.folder} readable and writable by its owner alone (mode 700)`),
    };
  }
  const kept = `${status.kept.messages} ${status.kept.messages === 1 ? 'message' : 'messages'}`;
  if (!status.on && status.kept.messages === 0 && status.kept.waiting === 0) {
    return { name, ok: true, detail: 'off: nothing is kept' };
  }
  const parts = [
    status.on ? `on for ${status.accounts.map((account) => account.alias).join(', ') || 'no account yet'}` : 'off',
    `${kept} kept for ${status.retentionDays} days${status.kept.oldestDay === null ? '' : `, from ${status.kept.oldestDay}`}`,
    `${Math.round(status.kept.bytes / 1024)} KiB`,
    status.model === null
      ? 'words only, no model'
      : `model ${status.model.name}: ${status.model.state}${status.model.localOnly ? '' : '; Ollama’s local-only mode (OLLAMA_NO_CLOUD=1) is not set'}`,
    status.backups === 'not-checked' ? 'backups not checked here' : `backups: ${status.backups}`,
    status.diskEncryption === 'not-checked'
      ? 'disk encryption not checked here'
      : `FileVault: ${status.diskEncryption}`,
    ...(status.keyStore === 'file' ? ['the key is in a file beside the data'] : []),
    'treat this folder like your mail',
  ];
  const warn =
    status.words === 'needs-newer-node' ||
    status.backups === 'not-excluded' ||
    status.diskEncryption === 'off' ||
    status.keyStore === 'file' ||
    status.problems.length > 0 ||
    (status.model !== null && status.model.state !== 'running');
  return { name, ok: true, ...(warn ? { warn: true as const } : {}), detail: parts.join('; ') };
}

/** For a test: the profile a stored model name has. */
export const SEARCH_MODEL_PROFILE: typeof searchModelProfile = searchModelProfile;
