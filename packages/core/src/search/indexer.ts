import { randomBytes } from 'node:crypto';
import { access, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { searchRetentionDays } from '../activity-settings.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { writeFileAtomic } from '../fs.ts';
import { withFileLock } from '../lock.ts';
import type { SecretStore } from '../secrets.ts';
import {
  INBOX_AAD,
  noteKeyId,
  pruneInboxDays,
  SEARCH_HANDLE,
  type SearchInboxLine,
  searchSourceId,
} from './capture.ts';
import { ensureSearchKey, openSearchRecord, type SearchKey, searchSecretStore } from './crypto.ts';
import {
  type BackupState,
  ensureSearchFolder,
  type SearchPaths,
  type SearchSystem,
  searchPaths,
  systemRunner,
} from './folder.ts';
import { type LoopbackExchange, OllamaClient, type SearchModelCheck } from './ollama.ts';
import { readSearchSettings, type SearchSettings } from './settings.ts';
import { openSearchStore, type SearchStore, type VectorGeneration } from './store.ts';

/**
 * The indexer (design 2026-10-26-local-search, S8, S10 and §5): the one writer of the database, run when someone
 * looks — `search index`, every search first for up to two seconds, the app every five minutes while it is open — and
 * never as a job of its own. One run at a time, by a lock beside the database.
 *
 * A run: takes the inbox's files by renaming each; opens and checks each line; keeps them (`SearchStore.upsert`), a
 * file's lines in one transaction, the file deleted only once they commit; makes the vectors still missing, 32 at a
 * time, while its budget lasts; prunes what Activity's days no longer keep and what accounts no longer kept had; and
 * checkpoints the WAL. Each step resumes after a crash: a taken file left behind is taken again.
 *
 * While Search is off nothing is taken or made — captures wait, encrypted, and go by their day all the same — but what
 * is kept still goes when its days pass.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 32;
const INBOX_FILE = /^\d{4}-\d{2}-\d{2}-\d{1,10}\.jsonl$/;
const TAKEN_FILE = /^taken-[0-9a-f]{12}-\d{4}-\d{2}-\d{2}-\d{1,10}\.jsonl$/;

/** What a run takes besides the core: stand-ins for tests — the secret store, the model server, the system, the clock. */
export interface SearchDeps {
  readonly secrets?: (() => Promise<SecretStore>) | undefined;
  readonly exchange?: LoopbackExchange | undefined;
  readonly system?: SearchSystem | undefined;
  readonly now?: (() => number) | undefined;
}

export interface IndexRunResult {
  /** False when there was nothing to run: Search was never on here. */
  readonly ran: boolean;
  /** True when another run held the lock for longer than this one would wait. */
  readonly busy: boolean;
  /** Lines taken from the inbox, and of them: kept new, kept over a partial one, already held, refused. */
  readonly taken: number;
  readonly inserted: number;
  readonly replaced: number;
  readonly unchanged: number;
  readonly refused: number;
  /** Rows deleted because their days passed or their account is no longer kept. */
  readonly pruned: number;
  /** Vectors made, and rows still without one in the set being made. */
  readonly embedded: number;
  readonly pending: number;
  /** The model's state, as checked this run; null when none is set or Search is off. */
  readonly model: SearchModelCheck | null;
  /** Whether the folder is left out of backups. */
  readonly backups: BackupState;
  /** True when Delete everything asked this run to stop. */
  readonly stopped: boolean;
  readonly ms: number;
}

/** The accounts whose rows are kept: those Search keeps that are still connected, Gmail or Slack. */
export function keptAccounts(
  config: Config,
  settings: SearchSettings,
): Map<string, { alias: string; channel: 'gmail' | 'slack' }> {
  const kept = new Map<string, { alias: string; channel: 'gmail' | 'slack' }>();
  for (const [alias, inbox] of Object.entries(config.inboxes)) {
    if (inbox.provider === 'gmail' && settings.accounts.includes(inbox.id))
      kept.set(inbox.id, { alias, channel: 'gmail' });
  }
  for (const [alias, account] of Object.entries(config.accounts)) {
    if (account.platform === 'slack' && settings.accounts.includes(account.id))
      kept.set(account.id, { alias, channel: 'slack' });
  }
  return kept;
}

/**
 * Whether Search keeps message words here: on, or off with an index still holding what was kept until its days pass.
 * What Activity's days change for Search, which keeps a message while Activity keeps its day (S12).
 */
export async function searchHoldsWords(core: Pick<Core, 'paths'>, config: Config): Promise<boolean> {
  return readSearchSettings(config).enabled === 'on' || (await exists(searchPaths(core.paths.stateDir).database));
}

/** The oldest `seen_at` Activity's days keep now — 30 days where they cannot be read (`searchRetentionDays`). */
export function keptFrom(config: Config, now: number): number {
  return now - searchRetentionDays(config) * DAY_MS;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A line, opened and checked field by field; undefined for one that is not a line Search wrote. */
export function openInboxLine(master: SearchKey, raw: string): SearchInboxLine | undefined {
  let sealed: unknown;
  try {
    sealed = (JSON.parse(raw) as { v?: unknown; sealed?: unknown }).sealed;
  } catch {
    return undefined;
  }
  if (typeof sealed !== 'string') return undefined;
  let line: Partial<SearchInboxLine>;
  try {
    line = JSON.parse(openSearchRecord(master, 'inbox', INBOX_AAD, Buffer.from(sealed, 'base64')).toString('utf8'));
  } catch {
    return undefined;
  }
  const channel = line.channel;
  if (line.v !== 1 || (channel !== 'gmail' && channel !== 'slack')) return undefined;
  if (line.direction !== 'in' && line.direction !== 'out') return undefined;
  if (searchSourceId(channel, line.sourceId) === undefined) return undefined;
  if (typeof line.accountId !== 'string' || !/^(?:ibx|acc)_[A-Za-z0-9]{1,64}$/.test(line.accountId)) return undefined;
  if (line.handle !== undefined && (typeof line.handle !== 'string' || !SEARCH_HANDLE.test(line.handle)))
    return undefined;
  if (line.direction === 'in' && line.handle === undefined) return undefined;
  if (typeof line.text !== 'string' || typeof line.at !== 'number' || typeof line.seenAt !== 'number') return undefined;
  if (line.seenBy !== 'agent' && line.seenBy !== 'send') return undefined;
  const optional = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const threadId = optional(line.threadId);
  const replyTo = optional(line.replyTo);
  const fromName = optional(line.fromName);
  const subject = optional(line.subject);
  return {
    v: 1,
    channel,
    direction: line.direction,
    accountId: line.accountId,
    sourceId: line.sourceId as string,
    ...(threadId === undefined ? {} : { threadId }),
    ...(replyTo === undefined || searchSourceId(channel, replyTo) === undefined ? {} : { replyTo }),
    ...(line.handle === undefined ? {} : { handle: line.handle }),
    ...(fromName === undefined ? {} : { fromName }),
    ...(subject === undefined ? {} : { subject }),
    text: line.text,
    at: line.at,
    seenAt: line.seenAt,
    seenBy: line.seenBy,
    partial: line.partial === true,
    mismatch: line.mismatch === true,
    unrenderable: line.unrenderable === true,
  };
}

/** The process's own system unless a test brings one. */
export function searchSystem(deps: SearchDeps): SearchSystem {
  return deps.system ?? { platform: process.platform, run: systemRunner };
}

/**
 * The generation the current model makes vectors for: the one in the file when it was made by this model, digest and
 * size, otherwise a new one — the last number plus one — whose set is then made from the kept text.
 */
function targetGeneration(
  store: SearchStore,
  address: string,
  name: string,
  digest: string,
  dimensions: number,
): VectorGeneration {
  const target = store.generation('target');
  // The weights are what a vector is made by — name, digest and size — not where the server listens.
  if (target !== null && target.name === name && target.digest === digest && target.dimensions === dimensions) {
    if (target.address !== address) {
      const moved = { ...target, address };
      store.setGeneration('target', moved);
      return moved;
    }
    return target;
  }
  const serving = store.generation('serving');
  const next: VectorGeneration = {
    generation: Math.max(target?.generation ?? 0, serving?.generation ?? 0) + 1,
    address,
    name,
    digest,
    dimensions,
  };
  store.setGeneration('target', next);
  return next;
}

/** Starts a new set of vectors for the model in force: Rebuild. The old set serves until the new one is complete. */
export function startNewGeneration(store: SearchStore): void {
  const target = store.generation('target');
  if (target === null) return;
  const serving = store.generation('serving');
  store.setGeneration('target', {
    ...target,
    generation: Math.max(target.generation, serving?.generation ?? 0) + 1,
  });
}

/**
 * One run. `budgetMs` bounds the vectors made (the inbox is always taken whole); `waitMs` how long to wait for another
 * run to finish. Throws only what the person must act on: a Node that cannot hold the index, a key that is gone.
 */
export async function runSearchIndex(
  core: Pick<Core, 'config' | 'paths' | 'secrets'>,
  options: { budgetMs: number; waitMs: number; rebuild?: boolean | undefined },
  deps: SearchDeps = {},
): Promise<IndexRunResult> {
  const started = Date.now();
  const now = (deps.now ?? Date.now)();
  const paths = searchPaths(core.paths.stateDir);
  const config = await core.config.load();
  const settings = readSearchSettings(config);
  const empty = (overrides: Partial<IndexRunResult>): IndexRunResult => ({
    ran: false,
    busy: false,
    taken: 0,
    inserted: 0,
    replaced: 0,
    unchanged: 0,
    refused: 0,
    pruned: 0,
    embedded: 0,
    pending: 0,
    model: null,
    backups: 'unknown',
    stopped: false,
    ms: Date.now() - started,
    ...overrides,
  });
  if (settings.enabled !== 'on' && !(await exists(paths.dir))) return empty({});
  try {
    return await withFileLock(paths.indexLock, () => run(core, config, settings, paths, now, options, deps, started), {
      timeoutMs: options.waitMs,
      maxWaitMs: options.waitMs,
      staleMs: 30_000,
      renewMs: 5_000,
    });
  } catch (error) {
    if (error instanceof CommsError && error.code === 'LOCK_TIMEOUT') return empty({ busy: true });
    throw error;
  }
}

async function run(
  core: Pick<Core, 'config' | 'paths' | 'secrets'>,
  config: Config,
  settings: SearchSettings,
  paths: SearchPaths,
  now: number,
  options: { budgetMs: number; rebuild?: boolean | undefined },
  deps: SearchDeps,
  started: number,
): Promise<IndexRunResult> {
  const on = settings.enabled === 'on';
  const backups = on ? await ensureSearchFolder(paths, searchSystem(deps)) : 'unknown';
  const retentionDays = searchRetentionDays(config);
  await pruneInboxDays(paths, retentionDays, now);
  // Off, the key is not asked for at all: a prune needs none, and nothing is taken or made.
  const master = on
    ? await ensureSearchKey(await (deps.secrets ?? (() => searchSecretStore(core)))(), paths.keyLock)
    : null;
  // Every capturing process compares the key it remembers with this one, and reads the key again when it changed.
  if (master !== null) await noteKeyId(paths, master.keyId);
  const counts = { taken: 0, inserted: 0, replaced: 0, unchanged: 0, refused: 0, pruned: 0, embedded: 0, pending: 0 };
  let model: SearchModelCheck | null = null;
  let stopped = false;
  const index = await openSearchStore(paths, master, { create: on });
  if (index === null) return { ran: true, busy: false, ...counts, model, backups, stopped, ms: Date.now() - started };
  try {
    const kept = keptAccounts(config, settings);
    if (master !== null) {
      const taken = await takeInbox(paths);
      for (const file of taken) {
        if (await exists(paths.stop)) {
          stopped = true;
          break;
        }
        let text: string;
        try {
          text = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n').filter((raw) => raw.trim() !== '');
        index.transaction(() => {
          for (const raw of lines) {
            counts.taken += 1;
            const line = openInboxLine(master, raw);
            // An account Search no longer keeps, or one no longer connected, keeps nothing of what waited for it.
            if (line === undefined || !kept.has(line.accountId) || kept.get(line.accountId)?.channel !== line.channel) {
              counts.refused += 1;
              continue;
            }
            const outcome = index.upsert(line);
            if (outcome === 'inserted') counts.inserted += 1;
            else if (outcome === 'replaced') counts.replaced += 1;
            else counts.unchanged += 1;
          }
        });
        // Deleted only once its lines are committed.
        await rm(file, { force: true });
      }
    }
    counts.pruned = index.transaction(() => index.prune(keptFrom(config, now), [...kept.keys()]));
    if (settings.model === null) {
      // No model: words only, and no vector is kept from one set before.
      index.transaction(() => {
        index.dropAllVectors();
        index.setGeneration('target', null);
        index.setGeneration('serving', null);
      });
    } else if (master !== null && !stopped) {
      const client = new OllamaClient(settings.model.address, settings.model.name, { exchange: deps.exchange });
      model = await client.check();
      if (model.state === 'running' && model.digest !== undefined) {
        const target = index.transaction(() => {
          if (options.rebuild === true) {
            targetGeneration(
              index,
              client.endpoint.address,
              client.profile.name,
              model?.digest ?? '',
              client.profile.dimensions,
            );
            startNewGeneration(index);
          }
          return targetGeneration(
            index,
            client.endpoint.address,
            client.profile.name,
            model?.digest ?? '',
            client.profile.dimensions,
          );
        });
        const deadline = started + options.budgetMs;
        while (Date.now() < deadline) {
          if (await exists(paths.stop)) {
            stopped = true;
            break;
          }
          const rows = index.rowsWithoutVector(target.generation, BATCH);
          if (rows.length === 0) break;
          const documents = rows.map((row) => {
            try {
              const record = index.record(row);
              return client.profile.document(record.subject, record.text.slice(0, 2_000));
            } catch {
              // A record that no longer opens is never shown; its vector is of nothing.
              return client.profile.document(undefined, '-');
            }
          });
          let vectors: Float32Array[];
          try {
            vectors = await client.embed(documents);
          } catch {
            break;
          }
          index.transaction(() => {
            rows.forEach((row, at) => {
              const vector = vectors[at];
              if (vector !== undefined) index.putVector(row.id, target.generation, vector);
            });
          });
          counts.embedded += rows.length;
        }
        counts.pending = index.countWithoutVector(target.generation);
        if (counts.pending === 0) {
          index.transaction(() => {
            index.setGeneration('serving', target);
            index.dropOtherGenerations(target.generation);
          });
        }
      } else {
        const target = index.generation('target');
        counts.pending = target === null ? index.counts().messages : index.countWithoutVector(target.generation);
      }
    }
    index.checkpoint();
  } finally {
    index.close();
  }
  return { ran: true, busy: false, ...counts, model, backups, stopped, ms: Date.now() - started };
}

/**
 * Upkeep with no key (S12, §7): what Activity's days no longer keep, and what an account no longer kept had, deleted
 * now — rows, their words and their vectors — and with no model, every vector. Opens no record, so it asks no secret
 * store. Returns how many rows went; 0 where nothing was ever kept.
 */
export async function pruneSearchIndex(
  core: Pick<Core, 'config' | 'paths'>,
  deps: Pick<SearchDeps, 'now'> = {},
  waitMs = 10_000,
): Promise<number> {
  const paths = searchPaths(core.paths.stateDir);
  if (!(await exists(paths.database))) return 0;
  const now = (deps.now ?? Date.now)();
  return withFileLock(
    paths.indexLock,
    async () => {
      const config = await core.config.load();
      const settings = readSearchSettings(config);
      await pruneInboxDays(paths, searchRetentionDays(config), now);
      const index = await openSearchStore(paths, null, { create: false });
      if (index === null) return 0;
      try {
        const deleted = index.transaction(() => {
          const pruned = index.prune(keptFrom(config, now), [...keptAccounts(config, settings).keys()]);
          if (settings.model === null) {
            index.dropAllVectors();
            index.setGeneration('target', null);
            index.setGeneration('serving', null);
          }
          return pruned;
        });
        index.checkpoint();
        return deleted;
      } finally {
        index.close();
      }
    },
    { timeoutMs: waitMs, maxWaitMs: waitMs, staleMs: 30_000, renewMs: 5_000 },
  );
}

/** The marker of the last day a core command pruned Search, beside the folder. */
const PRUNED_DAY_FILE = '.pruned-day';

/**
 * The day's prune (S10: the first core call each day prunes, as activity does): the first `agentcomms` command of the
 * day — never an MCP server, never a channel's read — deletes what Activity's days no longer keep, where there is an
 * index to prune. Best effort and bounded: a run that holds the index prunes anyway.
 */
export async function dailySearchPrune(
  core: Pick<Core, 'config' | 'paths'>,
  deps: Pick<SearchDeps, 'now'> = {},
): Promise<void> {
  const paths = searchPaths(core.paths.stateDir);
  if (!(await exists(paths.database))) return;
  const today = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
  const marker = join(paths.dir, PRUNED_DAY_FILE);
  const said = await readFile(marker, 'utf8').catch(() => '');
  if (said.trim() === today) return;
  await writeFileAtomic(marker, `${today}\n`).catch(() => undefined);
  await pruneSearchIndex(core, deps, 1_000).catch(() => 0);
}

/**
 * The inbox's files, each renamed so that the next line its process writes goes to a new file: its name with this
 * run's word before it. A file a run before this one took and did not finish is taken as it is.
 */
async function takeInbox(paths: SearchPaths): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(paths.inbox);
  } catch {
    return [];
  }
  const run = randomBytes(6).toString('hex');
  const taken: string[] = [];
  for (const name of names.sort()) {
    if (TAKEN_FILE.test(name)) {
      taken.push(join(paths.inbox, name));
      continue;
    }
    if (!INBOX_FILE.test(name)) continue;
    const to = join(paths.inbox, `taken-${run}-${name}`);
    try {
      await rename(join(paths.inbox, name), to);
      taken.push(to);
    } catch {
      // Held for a moment by its writer on Windows: the next run takes it.
    }
  }
  return taken;
}
