import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { CommsError } from '../errors.ts';
import { FILE_MODE } from '../fs.ts';
import type { SearchChannel, SearchDirection, SearchInboxLine, SearchSeenBy } from './capture.ts';
import { openSearchRecord, type SearchKey, sealSearchRecord } from './crypto.ts';
import type { SearchPaths } from './folder.ts';
import { loadSearchSqlite, probeSearchSqlite, WORDS_TABLE_COLUMNS, WORDS_TABLE_OPTIONS } from './sqlite.ts';
import { WordHasher } from './words.ts';

/**
 * The index (design 2026-10-26-local-search §4): one SQLite file, written by the indexer alone (S8).
 *
 * - `messages`: one row a message, its id the words index's rowid, its text, subject, sender's name and line sealed
 *   in `encrypted_record` — bound to the row by its source id, channel, account and direction.
 * - `words`: FTS5, contentless (`content=''`), deleting (`contentless_delete=1`) and with no positions (`detail=none`).
 *   It holds keyed hashes of each message's words (`words.ts`), never the words: the review of 2026-10-27 (M2) read a
 *   message back, in order, from the tokens of the table schema 1 kept. An index of schema 1 — a 0.35 test build's — is
 *   rebuilt on its first open (`openSearchStore`).
 * - `vectors`: one Float32 vector a message for each generation — a model and its digest — so the vectors of the last
 *   complete set can serve while a new one is made (§5). The design draws one vector a message; this keeps two while
 *   a rebuild runs, and drops the old set the moment the new one is complete.
 * - `people` and `handles`: a person is a set of exact handles (S5). A person's label and a handle's latest name are
 *   sealed.
 *
 * Opened as the event service opens its own: WAL, `synchronous = FULL`, `secure_delete = ON`, `foreign_keys = ON`;
 * the file is made owner-only before SQLite opens it, and SQLite gives its WAL and SHM the same mode.
 */

/** 2 from 2026-10-27: the words index holds keyed hashes, with no positions (1 held the words). */
export const SEARCH_SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  linked INTEGER NOT NULL CHECK (linked IN (0, 1)),
  encrypted_label BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS handles (
  handle TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  encrypted_name BLOB,
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS handles_person ON handles(person_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE,
  event_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('gmail', 'slack')),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  account_id TEXT NOT NULL,
  thread_id TEXT,
  reply_to TEXT,
  handle TEXT REFERENCES handles(handle),
  at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  seen_by TEXT NOT NULL CHECK (seen_by IN ('agent', 'event', 'send')),
  partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
  flags INTEGER NOT NULL DEFAULT 0,
  line_state TEXT NOT NULL CHECK (line_state IN ('off', 'pending', 'done', 'failed')),
  encrypted_record BLOB NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS messages_account_at ON messages(account_id, at);
CREATE INDEX IF NOT EXISTS messages_handle ON messages(handle);
CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to);
CREATE INDEX IF NOT EXISTS messages_seen_at ON messages(seen_at);
CREATE TABLE IF NOT EXISTS vectors (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (message_id, generation)
) STRICT;
CREATE INDEX IF NOT EXISTS vectors_generation ON vectors(generation);
`;

/** The words index, as schema 2 makes it. */
const WORDS_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(${WORDS_TABLE_COLUMNS}, ${WORDS_TABLE_OPTIONS})`;

/** Set while the words index waits to be made again from the sealed text: it needs the key, which upkeep never asks for. */
const WORDS_REBUILD = 'wordsRebuild';

/**
 * A word's weight in a search: how rare it is among the kept messages, as bm25 weighs it — `ln((N − n + ½) / (n + ½))`,
 * and never less than a millionth, as FTS5's own bm25 has it.
 */
function rarity(total: number, holding: number): number {
  const weight = Math.log((total - holding + 0.5) / (holding + 0.5));
  return weight > 0 ? weight : 1e-6;
}

/** Slack's two flags, as `flags` keeps them. */
export const FLAG_MISMATCH = 1;
export const FLAG_UNRENDERABLE = 2;

/** What a message's sealed record holds. */
export interface SearchRecord {
  readonly subject?: string | undefined;
  readonly fromName?: string | undefined;
  readonly text: string;
  /** One line about it: the Gmail subject, or a Slack message's first sentence — at most 120 characters. */
  readonly line: string;
}

/** A row as the queries read it, before its record is opened. */
export interface MessageRow {
  readonly id: number;
  readonly sourceId: string;
  readonly eventId: string | null;
  readonly channel: SearchChannel;
  readonly direction: SearchDirection;
  readonly accountId: string;
  readonly threadId: string | null;
  readonly replyTo: string | null;
  readonly handle: string | null;
  readonly at: number;
  readonly seenAt: number;
  readonly seenBy: SearchSeenBy;
  readonly partial: boolean;
  readonly flags: number;
  readonly record: Uint8Array;
}

/** What `messages` rows are narrowed to before words or meaning are looked at (§6, step 1). */
export interface RowFilter {
  /** Accounts by id; none is no row. */
  readonly accounts: readonly string[];
  /** The oldest `seen_at` kept: retention, in force even before a prune has run. */
  readonly keptFrom: number;
  readonly channel?: SearchChannel | undefined;
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  /** `in` alone unless asked: what people asked. */
  readonly direction?: SearchDirection | 'any' | undefined;
  /** A person's handles; none is no row. */
  readonly handles?: readonly string[] | undefined;
}

/** A generation of vectors: the model and digest it was made with. */
export interface VectorGeneration {
  readonly generation: number;
  readonly address: string;
  readonly name: string;
  readonly digest: string;
  readonly dimensions: number;
}

const ROW_COLUMNS =
  'id, source_id, event_id, channel, direction, account_id, thread_id, reply_to, handle, at, seen_at, seen_by, partial, flags, encrypted_record';

function rowOf(raw: Record<string, SQLInputValue>): MessageRow {
  return {
    id: Number(raw.id),
    sourceId: String(raw.source_id),
    eventId: raw.event_id === null ? null : String(raw.event_id),
    channel: raw.channel as SearchChannel,
    direction: raw.direction as SearchDirection,
    accountId: String(raw.account_id),
    threadId: raw.thread_id === null ? null : String(raw.thread_id),
    replyTo: raw.reply_to === null ? null : String(raw.reply_to),
    handle: raw.handle === null ? null : String(raw.handle),
    at: Number(raw.at),
    seenAt: Number(raw.seen_at),
    seenBy: raw.seen_by as SearchSeenBy,
    partial: Number(raw.partial) === 1,
    flags: Number(raw.flags),
    record: raw.encrypted_record as Uint8Array,
  };
}

/** The first sentence of a text, or its start: at most 120 characters, one line. */
export function firstLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/u.exec(flat)?.[1] ?? flat;
  const chars = [...sentence];
  return chars.length <= max ? sentence : `${chars.slice(0, max - 1).join('')}…`;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A person's id: `p_` and 26 characters, 130 random bits. */
export const PERSON_ID: RegExp = /^p_[0-9A-HJKMNP-TV-Z]{26}$/;

export function newPersonId(): string {
  const bytes = randomBytes(26);
  let out = 'p_';
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export class SearchStore {
  readonly db: DatabaseSync;
  /** Null for upkeep that opens no record — a prune — which needs no key. */
  readonly #key: SearchKey | null;
  #hasher: WordHasher | null = null;

  constructor(db: DatabaseSync, master: SearchKey | null) {
    this.db = db;
    this.#key = master;
  }

  /** The master, for what opens or seals a record; upkeep without one never gets here. */
  get #master(): SearchKey {
    if (this.#key === null) throw new CommsError('UNEXPECTED', 'the search index was opened without its key');
    return this.#key;
  }

  /** The words index's hashes, under this key. */
  get #words(): WordHasher {
    this.#hasher ??= new WordHasher(this.#master);
    return this.#hasher;
  }

  close(): void {
    this.db.close();
  }

  // ── meta ────────────────────────────────────────────────────────────────────────────────────────────────────

  meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  }

  setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else
      this.db
        .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
  }

  /** Runs `fn` in one transaction: all of it commits, or none. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ── records ─────────────────────────────────────────────────────────────────────────────────────────────────

  #recordAad(row: { sourceId: string; channel: string; accountId: string; direction: string }): string {
    return `${row.sourceId}\0${row.channel}\0${row.accountId}\0${row.direction}`;
  }

  /** A row's record, opened. */
  record(row: MessageRow): SearchRecord {
    const opened = openSearchRecord(this.#master, 'messages', this.#recordAad(row), row.record);
    const parsed = JSON.parse(opened.toString('utf8')) as Partial<SearchRecord>;
    return {
      ...(typeof parsed.subject === 'string' ? { subject: parsed.subject } : {}),
      ...(typeof parsed.fromName === 'string' ? { fromName: parsed.fromName } : {}),
      text: typeof parsed.text === 'string' ? parsed.text : '',
      line: typeof parsed.line === 'string' ? parsed.line : '',
    };
  }

  #seal(line: SearchInboxLine): Buffer {
    const record: SearchRecord = {
      ...(line.subject === undefined ? {} : { subject: line.subject }),
      ...(line.fromName === undefined ? {} : { fromName: line.fromName }),
      text: line.text,
      line: line.channel === 'gmail' && line.subject !== undefined ? firstLine(line.subject) : firstLine(line.text),
    };
    return sealSearchRecord(this.#master, 'messages', this.#recordAad(line), JSON.stringify(record));
  }

  // ── writing (the indexer's alone) ───────────────────────────────────────────────────────────────────────────

  /**
   * One line from the inbox, kept: a new message inserted; a full read replacing a partial one, or text that changed
   * (a Slack edit); anything else left as it is — a partial never replaces a full read. The retention clock, `seen_at`,
   * stays the first time it was in hand. Call inside `transaction`.
   */
  upsert(line: SearchInboxLine): 'inserted' | 'replaced' | 'kept' {
    if (line.handle !== undefined) this.#touchHandle(line.handle, line.fromName, line.seenAt);
    const held = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM messages WHERE source_id = ?`).get(line.sourceId) as
      | Record<string, SQLInputValue>
      | undefined;
    const flags = (line.mismatch ? FLAG_MISMATCH : 0) | (line.unrenderable ? FLAG_UNRENDERABLE : 0);
    if (held === undefined) {
      const inserted = this.db
        .prepare(
          `INSERT INTO messages (source_id, channel, direction, account_id, thread_id, reply_to, handle, at, seen_at,
             seen_by, partial, flags, line_state, encrypted_record)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'off', ?)`,
        )
        .run(
          line.sourceId,
          line.channel,
          line.direction,
          line.accountId,
          line.threadId ?? null,
          line.replyTo ?? null,
          line.handle ?? null,
          line.at,
          line.seenAt,
          line.seenBy,
          line.partial ? 1 : 0,
          flags,
          this.#seal(line),
        );
      this.#putWords(Number(inserted.lastInsertRowid), line.subject, line.text);
      return 'inserted';
    }
    const row = rowOf(held);
    // Another account, channel or direction under the same id is not this message: never overwritten by it.
    if (row.accountId !== line.accountId || row.channel !== line.channel || row.direction !== line.direction) {
      return 'kept';
    }
    if (line.partial && !row.partial) return 'kept';
    if (line.partial === row.partial) {
      let same = false;
      try {
        const record = this.record(row);
        same = record.text === line.text && record.subject === line.subject;
      } catch {
        same = false;
      }
      if (same) return 'kept';
    }
    this.db.prepare('DELETE FROM words WHERE rowid = ?').run(row.id);
    this.db.prepare('DELETE FROM vectors WHERE message_id = ?').run(row.id);
    this.db
      .prepare(
        `UPDATE messages SET thread_id = ?, reply_to = ?, handle = ?, at = ?, partial = ?, flags = ?,
           encrypted_record = ? WHERE id = ?`,
      )
      .run(
        line.threadId ?? row.threadId,
        line.replyTo ?? row.replyTo,
        line.handle ?? row.handle,
        line.at,
        line.partial ? 1 : 0,
        flags,
        this.#seal(line),
        row.id,
      );
    this.#putWords(row.id, line.subject, line.text);
    return 'replaced';
  }

  /** A message's words, as the index keeps them: keyed hashes, each once, sorted. */
  #putWords(id: number, subject: string | undefined, text: string): void {
    this.db
      .prepare(`INSERT INTO words(rowid, ${WORDS_TABLE_COLUMNS}) VALUES (?, ?)`)
      .run(id, this.#words.document(subject, text));
  }

  /**
   * The words index made again from every row's sealed text, when it waits for that: once, after an index of schema 1
   * — whose words index held the words — was opened. A record that no longer opens is never shown, and gives no words.
   * Its own transaction; returns how many rows were given words, or null when nothing waited.
   */
  rebuildWordsIfWaiting(): number | null {
    if (this.meta(WORDS_REBUILD) === undefined) return null;
    return this.transaction(() => {
      if (this.meta(WORDS_REBUILD) === undefined) return null;
      this.db.exec("INSERT INTO words(words) VALUES ('delete-all')");
      let given = 0;
      const rows = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM messages`).all() as Record<string, SQLInputValue>[];
      for (const raw of rows) {
        const row = rowOf(raw);
        let record: SearchRecord;
        try {
          record = this.record(row);
        } catch {
          continue;
        }
        this.#putWords(row.id, record.subject, record.text);
        given += 1;
      }
      this.setMeta(WORDS_REBUILD, undefined);
      return given;
    });
  }

  #touchHandle(handle: string, name: string | undefined, seenAt: number): void {
    const held = this.db.prepare('SELECT person_id, last_seen_at FROM handles WHERE handle = ?').get(handle) as
      | { person_id: string; last_seen_at: number }
      | undefined;
    const sealedName =
      name === undefined ? null : sealSearchRecord(this.#master, 'handles', handle, JSON.stringify({ name }));
    if (held === undefined) {
      const person = newPersonId();
      this.db
        .prepare('INSERT INTO people (id, linked, encrypted_label, created_at, updated_at) VALUES (?, 0, NULL, ?, ?)')
        .run(person, seenAt, seenAt);
      this.db
        .prepare('INSERT INTO handles (handle, person_id, encrypted_name, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(handle, person, sealedName, seenAt);
      return;
    }
    // The latest name the sender gave: a newer one replaces it, an older capture does not.
    if (seenAt >= Number(held.last_seen_at)) {
      if (sealedName === null) {
        this.db.prepare('UPDATE handles SET last_seen_at = ? WHERE handle = ?').run(seenAt, handle);
      } else {
        this.db
          .prepare('UPDATE handles SET encrypted_name = ?, last_seen_at = ? WHERE handle = ?')
          .run(sealedName, seenAt, handle);
      }
    }
  }

  /** Deletes rows — words, vectors by cascade — by id. Call inside `transaction`. */
  deleteRows(ids: readonly number[]): number {
    const words = this.db.prepare('DELETE FROM words WHERE rowid = ?');
    const row = this.db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of ids) {
      words.run(id);
      row.run(id);
    }
    return ids.length;
  }

  /**
   * Deletes every row first in hand before `keptFrom`, and every row of an account not in `accounts`; then every
   * person left with no message, unless the person linked or labelled them. Returns how many rows went.
   *
   * When any went, the words index is optimised too (the review of 2026-10-27, M3): a contentless table's delete only
   * marks a row's tokens deleted, and they stay in the file until FTS5 merges the segments that hold them — days of
   * Activity's retention later, or never. Optimising merges every segment into one now, without them; `secure_delete`
   * zeroes the pages that frees, and every caller checkpoints the WAL after.
   */
  prune(keptFrom: number, accounts: readonly string[]): number {
    const old = this.db
      .prepare(
        `SELECT id FROM messages WHERE seen_at < ? OR account_id NOT IN (${accounts.length === 0 ? "''" : placeholders(accounts.length)})`,
      )
      .all(keptFrom, ...accounts) as { id: number }[];
    const deleted = this.deleteRows(old.map((row) => Number(row.id)));
    this.pruneEmptyPeople();
    if (deleted > 0) this.optimizeWords();
    return deleted;
  }

  /** Merges the words index into one segment, leaving out every token of a deleted row. */
  optimizeWords(): void {
    this.db.exec("INSERT INTO words(words) VALUES ('optimize')");
  }

  /** People no message names any more, neither linked nor labelled by the person: deleted, with their handles. */
  pruneEmptyPeople(): void {
    this.db.exec(`
      DELETE FROM handles WHERE handle NOT IN (SELECT handle FROM messages WHERE handle IS NOT NULL)
        AND person_id IN (SELECT id FROM people WHERE linked = 0 AND encrypted_label IS NULL);
      DELETE FROM people WHERE linked = 0 AND encrypted_label IS NULL
        AND id NOT IN (SELECT person_id FROM handles);
    `);
  }

  // ── vectors ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Rows with no vector of `generation`, newest first. */
  rowsWithoutVector(generation: number, limit: number): MessageRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${ROW_COLUMNS} FROM messages m WHERE NOT EXISTS
             (SELECT 1 FROM vectors v WHERE v.message_id = m.id AND v.generation = ?) ORDER BY m.at DESC LIMIT ?`,
        )
        .all(generation, limit) as Record<string, SQLInputValue>[]
    ).map(rowOf);
  }

  countWithoutVector(generation: number): number {
    const row = this.db
      .prepare(
        'SELECT count(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.message_id = m.id AND v.generation = ?)',
      )
      .get(generation) as { n: number };
    return Number(row.n);
  }

  putVector(id: number, generation: number, vector: Float32Array): void {
    this.db
      .prepare('INSERT OR REPLACE INTO vectors (message_id, generation, vector) VALUES (?, ?, ?)')
      .run(id, generation, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
  }

  /** Every vector but `generation`'s: dropped once that set is complete. */
  dropOtherGenerations(generation: number): void {
    this.db.prepare('DELETE FROM vectors WHERE generation <> ?').run(generation);
  }

  dropAllVectors(): void {
    this.db.exec('DELETE FROM vectors');
  }

  generation(key: 'target' | 'serving'): VectorGeneration | null {
    const raw = this.meta(key === 'target' ? 'generation' : 'serving');
    if (raw === undefined) return null;
    try {
      const parsed = JSON.parse(raw) as VectorGeneration;
      return Number.isInteger(parsed.generation) ? parsed : null;
    } catch {
      return null;
    }
  }

  setGeneration(key: 'target' | 'serving', value: VectorGeneration | null): void {
    this.setMeta(key === 'target' ? 'generation' : 'serving', value === null ? undefined : JSON.stringify(value));
  }

  // ── reading ─────────────────────────────────────────────────────────────────────────────────────────────────

  #where(filter: RowFilter): { sql: string; args: SQLInputValue[] } {
    const parts: string[] = [];
    const args: SQLInputValue[] = [];
    parts.push(`m.account_id IN (${filter.accounts.length === 0 ? "''" : placeholders(filter.accounts.length)})`);
    args.push(...filter.accounts);
    parts.push('m.seen_at >= ?');
    args.push(filter.keptFrom);
    if (filter.channel !== undefined) {
      parts.push('m.channel = ?');
      args.push(filter.channel);
    }
    if (filter.since !== undefined) {
      parts.push('m.at >= ?');
      args.push(filter.since);
    }
    if (filter.until !== undefined) {
      parts.push('m.at <= ?');
      args.push(filter.until);
    }
    const direction = filter.direction ?? 'in';
    if (direction !== 'any') {
      parts.push('m.direction = ?');
      args.push(direction);
    }
    if (filter.handles !== undefined) {
      parts.push(`m.handle IN (${filter.handles.length === 0 ? "''" : placeholders(filter.handles.length)})`);
      args.push(...filter.handles);
    }
    return { sql: parts.join(' AND '), args };
  }

  /**
   * The best `limit` rows holding any word of `query` (§6, step 2): each word hashed as the index keeps it, the last
   * whole or as a prefix. A row scores the weight of each word it holds — the rarer among all kept messages, the more —
   * as bm25 weighs a word, without the counts and positions the index no longer keeps; best first, newer first on ties.
   */
  wordsMatch(query: string, filter: RowFilter, limit: number): number[] {
    const terms = this.#words.terms(query);
    if (terms.length === 0) return [];
    const total = Number((this.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n);
    const holding = this.db.prepare('SELECT count(*) AS n FROM words WHERE words MATCH ?');
    const weights = terms.map((term) => rarity(total, Number((holding.get(term) as { n: number }).n)));
    const where = this.#where(filter);
    const score = terms
      .map(() => 'CASE WHEN m.id IN (SELECT rowid FROM words WHERE words MATCH ?) THEN ? ELSE 0 END')
      .join(' + ');
    return (
      this.db
        .prepare(
          `SELECT m.id AS id, (${score}) AS score FROM messages m
           WHERE m.id IN (SELECT rowid FROM words WHERE words MATCH ?) AND ${where.sql}
           ORDER BY score DESC, m.at DESC LIMIT ?`,
        )
        .all(
          ...terms.flatMap((term, index) => [term, weights[index] ?? 1e-6]),
          terms.join(' OR '),
          ...where.args,
          limit,
        ) as { id: number }[]
    ).map((row) => Number(row.id));
  }

  /** Each filtered row's vector of `generation`, for an exact scan in JS. */
  vectors(generation: number, filter: RowFilter): { id: number; at: number; vector: Float32Array }[] {
    const where = this.#where(filter);
    return (
      this.db
        .prepare(
          `SELECT m.id AS id, m.at AS at, v.vector AS vector FROM vectors v JOIN messages m ON m.id = v.message_id
           WHERE v.generation = ? AND ${where.sql}`,
        )
        .all(generation, ...where.args) as { id: number; at: number; vector: Uint8Array }[]
    ).map((row) => {
      const bytes = new Uint8Array(row.vector);
      return {
        id: Number(row.id),
        at: Number(row.at),
        vector: new Float32Array(bytes.buffer, 0, bytes.byteLength / 4),
      };
    });
  }

  rowsById(ids: readonly number[]): Map<number, MessageRow> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM messages WHERE id IN (${placeholders(ids.length)})`)
      .all(...ids) as Record<string, SQLInputValue>[];
    return new Map(rows.map((raw) => [Number(raw.id), rowOf(raw)]));
  }

  rowBySource(sourceId: string): MessageRow | undefined {
    const raw = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM messages WHERE source_id = ?`).get(sourceId) as
      | Record<string, SQLInputValue>
      | undefined;
    return raw === undefined ? undefined : rowOf(raw);
  }

  /** How many rows `filter` keeps. */
  countRows(filter: RowFilter): number {
    const where = this.#where(filter);
    const row = this.db.prepare(`SELECT count(*) AS n FROM messages m WHERE ${where.sql}`).get(...where.args) as {
      n: number;
    };
    return Number(row.n);
  }

  /** Rows, newest first, narrowed by `filter`. */
  rows(filter: RowFilter, limit: number): MessageRow[] {
    const where = this.#where(filter);
    return (
      this.db
        .prepare(`SELECT ${ROW_COLUMNS.split(', ')
          .map((column) => `m.${column}`)
          .join(', ')} FROM messages m
          WHERE ${where.sql} ORDER BY m.at DESC LIMIT ?`)
        .all(...where.args, limit) as Record<string, SQLInputValue>[]
    ).map(rowOf);
  }

  /**
   * The replies Agent Comms sent to each message, oldest first (S3): an `out` row that names it as what it answers —
   * and, where a send could not prove which message it answered (a Gmail reply whose binding needed no proof), one in
   * its thread sent after it and before the next message there that someone else sent.
   */
  answers(
    messages: readonly Pick<MessageRow, 'sourceId' | 'threadId' | 'at' | 'direction'>[],
  ): Map<string, { sourceId: string; at: number }[]> {
    const answered = new Map<string, { sourceId: string; at: number }[]>();
    const asked = messages.filter((message) => message.direction === 'in');
    if (asked.length === 0) return answered;
    const add = (key: string, entry: { sourceId: string; at: number }) => {
      const list = answered.get(key) ?? [];
      if (!list.some((held) => held.sourceId === entry.sourceId)) list.push(entry);
      answered.set(key, list);
    };
    const named = this.db
      .prepare(
        `SELECT reply_to, source_id, at FROM messages WHERE direction = 'out' AND reply_to IN (${placeholders(asked.length)}) ORDER BY at`,
      )
      .all(...asked.map((message) => message.sourceId)) as { reply_to: string; source_id: string; at: number }[];
    for (const row of named) add(row.reply_to, { sourceId: row.source_id, at: Number(row.at) });
    const next = this.db.prepare(
      "SELECT min(at) AS at FROM messages WHERE direction = 'in' AND thread_id = ? AND at > ?",
    );
    const unproven = this.db.prepare(
      "SELECT source_id, at FROM messages WHERE direction = 'out' AND reply_to IS NULL AND thread_id = ? AND at > ? AND at < ? ORDER BY at",
    );
    for (const message of asked) {
      if (message.threadId === null) continue;
      const following = (next.get(message.threadId, message.at) as { at: number | null } | undefined)?.at ?? null;
      const rows = unproven.all(
        message.threadId,
        message.at,
        following === null ? Number.MAX_SAFE_INTEGER : Number(following),
      ) as { source_id: string; at: number }[];
      for (const row of rows) add(message.sourceId, { sourceId: row.source_id, at: Number(row.at) });
    }
    for (const list of answered.values()) list.sort((a, b) => a.at - b.at);
    return answered;
  }

  // ── people ──────────────────────────────────────────────────────────────────────────────────────────────────

  personOf(handle: string): { id: string; linked: boolean } | undefined {
    const row = this.db
      .prepare(
        'SELECT p.id AS id, p.linked AS linked FROM handles h JOIN people p ON p.id = h.person_id WHERE h.handle = ?',
      )
      .get(handle) as { id: string; linked: number } | undefined;
    return row === undefined ? undefined : { id: row.id, linked: Number(row.linked) === 1 };
  }

  person(id: string): { id: string; linked: boolean; label: string | undefined } | undefined {
    const row = this.db.prepare('SELECT id, linked, encrypted_label FROM people WHERE id = ?').get(id) as
      | { id: string; linked: number; encrypted_label: Uint8Array | null }
      | undefined;
    if (row === undefined) return undefined;
    return { id: row.id, linked: Number(row.linked) === 1, label: this.#label(row.id, row.encrypted_label) };
  }

  #label(id: string, sealed: Uint8Array | null): string | undefined {
    if (sealed === null) return undefined;
    try {
      const parsed = JSON.parse(openSearchRecord(this.#master, 'people', id, sealed).toString('utf8')) as {
        label?: unknown;
      };
      return typeof parsed.label === 'string' ? parsed.label : undefined;
    } catch {
      return undefined;
    }
  }

  /** A handle's latest name, as the sender gave it. */
  handleName(handle: string, sealed: Uint8Array | null): string | undefined {
    if (sealed === null) return undefined;
    try {
      const parsed = JSON.parse(openSearchRecord(this.#master, 'handles', handle, sealed).toString('utf8')) as {
        name?: unknown;
      };
      return typeof parsed.name === 'string' ? parsed.name : undefined;
    } catch {
      return undefined;
    }
  }

  handlesOf(personId: string): { handle: string; name: string | undefined; lastSeenAt: number }[] {
    return (
      this.db
        .prepare('SELECT handle, encrypted_name, last_seen_at FROM handles WHERE person_id = ? ORDER BY handle')
        .all(personId) as { handle: string; encrypted_name: Uint8Array | null; last_seen_at: number }[]
    ).map((row) => ({
      handle: row.handle,
      name: this.handleName(row.handle, row.encrypted_name),
      lastSeenAt: Number(row.last_seen_at),
    }));
  }

  /** Every person, with the rows `filter` keeps for them: how many, and the newest. */
  people(
    filter: RowFilter,
  ): { id: string; linked: boolean; label: string | undefined; count: number; lastAt: number | null }[] {
    const where = this.#where(filter);
    const rows = this.db
      .prepare(
        `SELECT p.id AS id, p.linked AS linked, p.encrypted_label AS label,
           (SELECT count(*) FROM messages m JOIN handles h ON h.handle = m.handle WHERE h.person_id = p.id AND ${where.sql}) AS n,
           (SELECT max(m.at) FROM messages m JOIN handles h ON h.handle = m.handle WHERE h.person_id = p.id AND ${where.sql}) AS last
         FROM people p ORDER BY last DESC, p.id`,
      )
      .all(...where.args, ...where.args) as {
      id: string;
      linked: number;
      label: Uint8Array | null;
      n: number;
      last: number | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      linked: Number(row.linked) === 1,
      label: this.#label(row.id, row.label),
      count: Number(row.n),
      lastAt: row.last === null ? null : Number(row.last),
    }));
  }

  /** Moves every handle of `from` to `into`, marks `into` linked by the person, and deletes `from`. */
  link(into: string, from: string, now: number): void {
    this.db.prepare('UPDATE handles SET person_id = ? WHERE person_id = ?').run(into, from);
    const label = this.db.prepare('SELECT encrypted_label FROM people WHERE id = ?').get(from) as
      | { encrypted_label: Uint8Array | null }
      | undefined;
    const kept = this.db.prepare('SELECT encrypted_label FROM people WHERE id = ?').get(into) as
      | { encrypted_label: Uint8Array | null }
      | undefined;
    // A label the person gave the other is kept when this one has none: re-sealed for the person it now names.
    if ((kept?.encrypted_label ?? null) === null && (label?.encrypted_label ?? null) !== null) {
      const text = this.#label(from, label?.encrypted_label ?? null);
      if (text !== undefined) this.setLabel(into, text, now);
    }
    this.db.prepare('UPDATE people SET linked = 1, updated_at = ? WHERE id = ?').run(now, into);
    this.db.prepare('DELETE FROM people WHERE id = ?').run(from);
  }

  /** Moves `handle` to a person of its own, linked by the person so it is not joined again by anything. */
  unlink(handle: string, now: number): string {
    const person = newPersonId();
    this.db
      .prepare('INSERT INTO people (id, linked, encrypted_label, created_at, updated_at) VALUES (?, 1, NULL, ?, ?)')
      .run(person, now, now);
    this.db.prepare('UPDATE handles SET person_id = ? WHERE handle = ?').run(person, handle);
    return person;
  }

  setLabel(id: string, label: string, now: number): void {
    this.db
      .prepare('UPDATE people SET encrypted_label = ?, updated_at = ? WHERE id = ?')
      .run(sealSearchRecord(this.#master, 'people', id, JSON.stringify({ label })), now, id);
  }

  handleCount(personId: string): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM handles WHERE person_id = ?').get(personId) as { n: number };
    return Number(row.n);
  }

  // ── counts, for status ──────────────────────────────────────────────────────────────────────────────────────

  counts(): { messages: number; in: number; out: number; people: number; oldestSeenAt: number | null } {
    const row = this.db
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
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
}

/** Makes the database file owner-only before SQLite opens it; SQLite gives its WAL and SHM the same mode. */
async function privateFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_RDWR, FILE_MODE);
  await handle.close();
}

/**
 * The index, opened for `master` — made when `create` and there is none — or null when there is none to read.
 * Refuses a database kept with another master: Delete everything starts again. With no master it is opened for
 * upkeep alone — a prune, which opens no record — and is never made.
 */
export async function openSearchStore(
  paths: SearchPaths,
  master: SearchKey | null,
  options: { create: boolean },
): Promise<SearchStore | null> {
  if (master === null && options.create) {
    throw new CommsError('UNEXPECTED', 'the search index is never made without its key');
  }
  await probeSearchSqlite();
  const sqlite = await loadSearchSqlite();
  if (!options.create) {
    try {
      await open(paths.database, 'r').then((handle) => handle.close());
    } catch {
      return null;
    }
  } else {
    await privateFile(paths.database);
  }
  const db = new sqlite.DatabaseSync(paths.database);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA secure_delete = ON');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    const store = new SearchStore(db, master);
    const schema = store.meta('schema');
    if (schema === undefined) {
      db.exec(WORDS_TABLE);
      store.setMeta('schema', String(SEARCH_SCHEMA_VERSION));
    } else if (schema === '1') {
      upgradeWords(store);
    } else if (schema === String(SEARCH_SCHEMA_VERSION)) {
      db.exec(WORDS_TABLE);
    } else {
      throw new CommsError('NEEDS_NEWER_RELEASE', 'the search index was made by a later release of Agent Comms', {
        hint: 'Update Agent Comms, or delete everything Search keeps and start again.',
      });
    }
    const keyId = store.meta('keyId');
    if (master === null) return store;
    if (keyId === undefined) store.setMeta('keyId', master.keyId);
    else if (keyId !== master.keyId) {
      throw new CommsError('CONFIG', 'the search index was kept with a key this machine no longer has', {
        hint: 'Delete everything Search keeps (search delete --all --confirm), and it starts again, empty.',
        details: { reason: 'SEARCH_KEY_UNKNOWN' },
      });
    }
    store.rebuildWordsIfWaiting();
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Schema 1 → 2 (a 0.35 test build's index; 0.35.0 was never released with schema 1): its words index, which held the
 * words with their positions, is dropped at once — `secure_delete` zeroes what it held, and the WAL is checkpointed —
 * and made again empty, waiting for the key. Upkeep opens with no key, so the hashes are made at the first open that
 * has one (`rebuildWordsIfWaiting`), before anything is searched. One transaction, read again inside it, so two
 * processes opening it at once upgrade it once.
 */
function upgradeWords(store: SearchStore): void {
  store.transaction(() => {
    if (store.meta('schema') !== '1') return;
    store.db.exec('DROP TABLE IF EXISTS words');
    store.db.exec(WORDS_TABLE);
    store.setMeta(WORDS_REBUILD, 'waiting');
    store.setMeta('schema', String(SEARCH_SCHEMA_VERSION));
  });
  store.checkpoint();
}
