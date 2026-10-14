import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type EventPaths, ensureEventPaths, ensureOwnerOnlyFile, eventPaths } from '../runtime/paths.ts';
import { loadSqlite } from '../runtime/sqlite.ts';
import { applyMigrations, recordedSchemaVersion, refuseNewerSchema, refuseNewerVersion } from './migrations.ts';

export interface EventDatabase {
  readonly database: DatabaseSync;
  readonly paths: EventPaths;
  readonly installationId: string;
  immediate<T>(work: () => T): T;
  close(): void;
}

export interface OpenEventDatabaseOptions {
  readonly stateDir: string;
}

function readMeta(database: DatabaseSync, key: string): string | null {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function installationIdFor(database: DatabaseSync): string {
  const existing = readMeta(database, 'installation_id');
  if (existing !== null) return existing;
  const created = randomBytes(16).toString('hex');
  database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('installation_id', created);
  return created;
}

/** SQLite's primary result code for a read that has to write first: recovering what a crash interrupted. */
const SQLITE_READONLY = 8;

/**
 * The schema version a database records, read through a read-only connection, so that a database a newer agent-events
 * migrated is refused without this release ever opening it for writing. It waits out a lock as the writable opener
 * would. Null only when SQLite must first recover an interrupted transaction, which takes a writable connection: the
 * opener checks again there. Any other failure, a lock held past the wait among them, refuses the open as it is.
 */
export function recordedVersionReadOnly(
  Database: typeof DatabaseSync,
  path: string,
  busyTimeoutMs = 5_000,
): number | null {
  try {
    const probe = new Database(path, { readOnly: true });
    try {
      probe.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
      return recordedSchemaVersion(probe);
    } finally {
      probe.close();
    }
  } catch (error) {
    const code = (error as { errcode?: unknown }).errcode;
    if (typeof code === 'number' && (code & 0xff) === SQLITE_READONLY) return null;
    throw error;
  }
}

/** Opens the daemon’s one local authority after the Task 4 owner-only path checks have succeeded. */
export async function openEventDatabase(options: OpenEventDatabaseOptions): Promise<EventDatabase> {
  const { DatabaseSync: Database } = await loadSqlite();
  const paths = await ensureEventPaths(eventPaths(options.stateDir));
  // Created owner-only before SQLite opens it: SQLite gives the WAL and shared-memory files the database file's mode.
  await ensureOwnerOnlyFile(paths.database);
  const recorded = recordedVersionReadOnly(Database, paths.database);
  if (recorded !== null) refuseNewerVersion(recorded);
  const database = new Database(paths.database);
  try {
    // Connection settings only, then the check again, before anything agent-events writes: the journal mode is written
    // into the database itself. Only SQLite's own recovery of an interrupted transaction, which the newer release would
    // also run on its next start and which changes no committed data, can come first.
    database.exec('PRAGMA busy_timeout = 5000');
    refuseNewerSchema(database);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
    // Expiry and revocation delete encrypted content; SQLite must scrub released pages rather than retain old bytes.
    database.exec('PRAGMA secure_delete = ON');
    applyMigrations(database);
    const installationId = installationIdFor(database);
    return {
      database,
      paths,
      installationId,
      immediate<T>(work: () => T): T {
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = work();
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
      close(): void {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
