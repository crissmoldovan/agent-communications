import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENCRYPTED_EVENT_COLUMNS } from '../src/store/aad.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { RECORD_LAYOUTS } from '../src/store/records.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('SEC-B1: a fresh event database is one strict SQLite authority with durable identity and settings', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-database-'));
  const backupStateDir = await mkdtemp(join(tmpdir(), 'events-daemon-database-backup-'));
  try {
    const first = await openEventDatabase({ stateDir });
    try {
      assert.match(first.installationId, /^[0-9a-f]{32}$/);
      const foreignKeys = first.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
      const journalMode = first.database.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined;
      const synchronous = first.database.prepare('PRAGMA synchronous').get() as { synchronous: number } | undefined;
      const strict = first.database.prepare("SELECT strict FROM pragma_table_list WHERE name = 'ingest'").get() as
        | { strict: number }
        | undefined;
      assert.ok(foreignKeys);
      assert.ok(journalMode);
      assert.ok(synchronous);
      assert.ok(strict);
      assert.equal(foreignKeys.foreign_keys, 1);
      assert.equal(journalMode.journal_mode, 'wal');
      assert.equal(synchronous.synchronous, 2);
      assert.equal(strict.strict, 1);
      const encryptedColumns = first.database
        .prepare("SELECT name FROM pragma_table_xinfo('source_scan_state')")
        .all() as Array<{
        name: string;
      }>;
      assert.deepEqual(
        encryptedColumns.filter((column) => /^(nonce|tag)(?:_|$)/i.test(column.name)),
        [],
        'a packed encrypted record has no sibling nonce or tag column',
      );
      const settings = first.database.prepare('SELECT enabled, paused, switch_generation FROM event_settings').get() as
        | {
            enabled: number;
            paused: number;
            switch_generation: number;
          }
        | undefined;
      assert.ok(settings);
      assert.equal(settings.enabled, 0);
      assert.equal(settings.paused, 0);
      assert.equal(settings.switch_generation, 0);
      const schemaMeta = first.database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      const resetMeta = first.database.prepare("SELECT value FROM meta WHERE key = 'reset_epoch'").get() as
        | { value: string }
        | undefined;
      assert.equal(schemaMeta?.value, '8');
      assert.equal(resetMeta?.value, '0');

      first.immediate(() => {
        first.database
          .prepare("INSERT INTO operational_records (id, kind, created_at) VALUES ('op-1', 'health', 1)")
          .run();
      });
      const records = first.database.prepare('SELECT COUNT(*) AS count FROM operational_records').get() as
        | { count: number }
        | undefined;
      assert.ok(records);
      assert.equal(records.count, 1);
    } finally {
      first.close();
    }

    await mkdir(join(backupStateDir, 'events'), { mode: 0o700 });
    await copyFile(join(stateDir, 'events', 'events.sqlite'), join(backupStateDir, 'events', 'events.sqlite'));

    const restarted = await openEventDatabase({ stateDir });
    try {
      assert.equal(restarted.installationId, first.installationId, 'an ordinary restart keeps the installation id');
      const records = restarted.database.prepare('SELECT COUNT(*) AS count FROM operational_records').get() as
        | { count: number }
        | undefined;
      assert.ok(records);
      assert.equal(records.count, 1);
    } finally {
      restarted.close();
    }

    const restored = await openEventDatabase({ stateDir: backupStateDir });
    try {
      assert.equal(restored.installationId, first.installationId, 'a database backup preserves the installation id');
    } finally {
      restored.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(backupStateDir, { recursive: true, force: true });
  }
});

test('CRY-B1: every encrypted column binds the primary key its table declares, in declared order, and is a BLOB', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-aad-keys-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      assert.deepEqual(
        RECORD_LAYOUTS.map((layout) => `${layout.table}.${layout.column}`).sort(),
        Object.keys(ENCRYPTED_EVENT_COLUMNS).sort(),
        'the record layouts and the AAD encoder name the same encrypted columns',
      );
      for (const layout of RECORD_LAYOUTS) {
        const columns = opened.database
          .prepare(`SELECT name, type, "notnull" AS required, pk FROM pragma_table_info('${layout.table}')`)
          .all() as Array<{ name: string; type: string; required: number; pk: number }>;
        const declared = columns
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name);
        assert.deepEqual(layout.keyColumns, declared, `${layout.table}'s AAD components follow its declared key`);
        assert.equal(ENCRYPTED_EVENT_COLUMNS[`${layout.table}.${layout.column}`], declared.length);
        const encrypted = columns.find((column) => column.name === layout.sqlColumn);
        assert.equal(encrypted?.type, 'BLOB', `${layout.table}.${layout.sqlColumn} is a BLOB`);
      }
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: the database, its WAL and its shared-memory file are owner-only from their creation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-database-modes-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      opened.immediate(() => {
        opened.database
          .prepare("INSERT INTO operational_records (id, kind, created_at) VALUES ('op-mode', 'health', 1)")
          .run();
      });
      for (const path of [opened.paths.database, opened.paths.databaseWal, opened.paths.databaseShm]) {
        assert.equal((await stat(path)).mode & 0o777, 0o600, `${path} is 0600`);
      }
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
