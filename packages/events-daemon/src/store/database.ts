import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type EventPaths, ensureEventPaths, ensureOwnerOnlyFile, eventPaths } from '../runtime/paths.ts';
import { loadSqlite } from '../runtime/sqlite.ts';
import { applyMigrations } from './migrations.ts';

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

/** Opens the daemon’s one local authority after the Task 4 owner-only path checks have succeeded. */
export async function openEventDatabase(options: OpenEventDatabaseOptions): Promise<EventDatabase> {
  const { DatabaseSync: Database } = await loadSqlite();
  const paths = await ensureEventPaths(eventPaths(options.stateDir));
  // Created owner-only before SQLite opens it: SQLite gives the WAL and shared-memory files the database file's mode.
  await ensureOwnerOnlyFile(paths.database);
  const database = new Database(paths.database);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA busy_timeout = 5000');
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
