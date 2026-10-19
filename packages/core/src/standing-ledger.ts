import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNT_ID_PATTERN } from './config.ts';
import { CommsError } from './errors.ts';
import { appendPrivateLine } from './fs.ts';
import { withFileLock } from './lock.ts';
import type { StandingAct } from './standing.ts';

/**
 * The acknowledgement ledger (design 2026-10-19-standing-approvals, S6, S9): one JSONL file per account,
 * `<state>/standing/<accountId>.jsonl`, shared by every process and locked at `<path>.lock`.
 *
 * Every use of a standing approval of the account is a `use` line, written under the lock before its one-shot child
 * is minted; what became of the act is an `outcome` line after it. The counts — per thread across every standing
 * approval of the account, per hour and per day of each one — are read from the `use` lines alone, so nothing an
 * outcome says frees one, and nothing ever removes a line. A count is spent when it is written, never refunded.
 */

/** One use: which standing approval, which child, which content, where, and what the acknowledged message said. */
export interface AckUse {
  kind: 'use';
  at: string;
  standingId: string;
  childId: string;
  act: StandingAct;
  contentDigest: string;
  channel: string;
  ts: string;
  /** The thread the message is in — its parent's `ts` — or the message's own `ts` outside one. */
  thread: string;
  /** SHA-256 of the acknowledged message's text at the act, so an edit since shows. */
  targetDigest: string;
  edited: boolean;
}

/** What became of one use's act. It records; it frees nothing. */
export interface AckOutcome {
  kind: 'outcome';
  at: string;
  childId: string;
  outcome: 'sent' | 'failed' | 'unknown';
  link?: string;
  notice: string;
}

type AckEntry = AckUse | AckOutcome;

/** Exactly what `Date.prototype.toISOString` writes. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OUTCOMES: readonly string[] = ['sent', 'failed', 'unknown'];

const isString = (value: unknown): value is string => typeof value === 'string';
const isTime = (value: unknown): value is string =>
  isString(value) && ISO.test(value) && !Number.isNaN(Date.parse(value));

/** One line as an entry, or null when it is not one this release wrote. */
function entryOf(line: string): AckEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (!isTime(entry.at)) return null;
  if (entry.kind === 'use') {
    const fields = ['standingId', 'childId', 'contentDigest', 'channel', 'ts', 'thread', 'targetDigest'] as const;
    if (!fields.every((field) => isString(entry[field]) && entry[field] !== '')) return null;
    if (entry.act !== 'reaction' && entry.act !== 'reply') return null;
    if (typeof entry.edited !== 'boolean') return null;
    return {
      kind: 'use',
      at: entry.at,
      standingId: entry.standingId as string,
      childId: entry.childId as string,
      act: entry.act,
      contentDigest: entry.contentDigest as string,
      channel: entry.channel as string,
      ts: entry.ts as string,
      thread: entry.thread as string,
      targetDigest: entry.targetDigest as string,
      edited: entry.edited,
    };
  }
  if (entry.kind === 'outcome') {
    if (!isString(entry.childId) || !isString(entry.outcome) || !OUTCOMES.includes(entry.outcome)) return null;
    if (!isString(entry.notice) || (entry.link !== undefined && !isString(entry.link))) return null;
    return {
      kind: 'outcome',
      at: entry.at,
      childId: entry.childId,
      outcome: entry.outcome as AckOutcome['outcome'],
      ...(entry.link === undefined ? {} : { link: entry.link as string }),
      notice: entry.notice,
    };
  }
  return null;
}

export class AckLedger {
  readonly directory: string;
  readonly #now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.directory = join(stateDir, 'standing');
    this.#now = now;
  }

  /** The clock this ledger was opened with: what a use is timed by, and its counts' windows measured from. */
  now(): Date {
    return this.#now();
  }

  /** The account's ledger file. Refuses anything but an account id, so no name can reach another path. */
  #path(accountId: string): string {
    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new CommsError('USAGE', `"${String(accountId)}" is not an account id`, {
        hint: 'A standing approval’s ledger is kept per account, by the account’s id.',
      });
    }
    return join(this.directory, `${accountId}.jsonl`);
  }

  /** Every line, read: the entries, and the number — from 1 — of each line this release cannot read. */
  async #read(path: string): Promise<{ entries: AckEntry[]; unreadable: number[] }> {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entries: AckEntry[] = [];
    const unreadable: number[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trim() === '') continue;
      const entry = entryOf(line);
      if (entry === null) unreadable.push(index + 1);
      else entries.push(entry);
    }
    return { entries, unreadable };
  }

  /** Where an account's ledger is kept: `<state>/standing/<accountId>.jsonl`, for a person told to move it aside. */
  pathOf(accountId: string): string {
    return this.#path(accountId);
  }

  /**
   * Every account's ledger on this machine that holds a line this release cannot read, with the number of each such
   * line, for the doctor (design 2026-10-19-standing-approvals, the lead's call after review): while one does, no
   * standing approval of that account can be used — what it counts cannot be known — and nothing else says so. Reads
   * without the lock: a look, and every line it reads was written whole.
   */
  async unreadable(): Promise<{ accountId: string; path: string; lines: number[] }[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const found: { accountId: string; path: string; lines: number[] }[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.jsonl')) continue;
      const accountId = name.slice(0, -'.jsonl'.length);
      if (!ACCOUNT_ID_PATTERN.test(accountId)) continue;
      const path = this.#path(accountId);
      const { unreadable } = await this.#read(path);
      if (unreadable.length > 0) found.push({ accountId, path, lines: unreadable });
    }
    return found;
  }

  /**
   * Runs `fn` under the account's ledger lock, with every entry as it reads there and `append`, which writes a `use`
   * line under the lock already held. `fn` must never take this lock again.
   *
   * A line this release cannot read refuses the whole call, BAD_DATA, before `fn` runs: a count read without it could
   * be lower than the truth, and a count is never guessed downwards.
   */
  withLock<T>(
    accountId: string,
    fn: (entries: (AckUse | AckOutcome)[], append: (entry: AckUse) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    let path: string;
    try {
      path = this.#path(accountId);
    } catch (error) {
      return Promise.reject(error);
    }
    return withFileLock(`${path}.lock`, async () => {
      const { entries, unreadable } = await this.#read(path);
      if (unreadable.length > 0) {
        throw new CommsError(
          'BAD_DATA',
          'nothing was sent: this account’s standing acknowledgement ledger has a line that cannot be read',
          {
            hint: 'No standing approval of this account can be used until the ledger reads whole: what it counts cannot be known. Ask the person instead; the doctor says which line, and how to recover.',
            details: { unreadable: unreadable.length, lines: unreadable },
          },
        );
      }
      const append = async (entry: AckUse): Promise<void> => {
        if (entry.kind !== 'use' || entryOf(JSON.stringify(entry)) === null) {
          throw new CommsError('UNEXPECTED', 'a standing use is written whole, or not at all', {
            hint: 'This is a bug — please report it.',
          });
        }
        await appendPrivateLine(path, JSON.stringify(entry), { durable: true });
      };
      return fn(entries, append);
    });
  }

  /** Records what became of a use's act, taking the lock itself. It never frees a count. */
  async recordOutcome(accountId: string, entry: AckOutcome): Promise<void> {
    const path = this.#path(accountId);
    const written: AckOutcome = { ...entry, kind: 'outcome', at: entry.at ?? this.#now().toISOString() };
    if (entryOf(JSON.stringify(written)) === null) {
      throw new CommsError('UNEXPECTED', 'a standing outcome is written whole, or not at all', {
        hint: 'This is a bug — please report it.',
      });
    }
    await withFileLock(`${path}.lock`, () => appendPrivateLine(path, JSON.stringify(written), { durable: true }));
  }

  /** Every entry this release can read, oldest first, for a report: a line it cannot read is left out of it. */
  async entries(accountId: string): Promise<(AckUse | AckOutcome)[]> {
    return (await this.#read(this.#path(accountId))).entries;
  }
}
