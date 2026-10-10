import type { DatabaseSync } from 'node:sqlite';
import { EVENT_MIGRATIONS, type EventMigration } from '../../src/store/migrations.ts';

export interface JudgeMigrationFixture {
  readonly name: 'B1' | 'B2' | 'D';
  readonly throughVersion: number;
  seed(database: DatabaseSync): void;
  readCiphertext(database: DatabaseSync): Uint8Array;
}

export function migrationsThrough(version: number): readonly EventMigration[] {
  return EVENT_MIGRATIONS.filter((migration) => migration.version <= version);
}

export const JUDGE_MIGRATION_FIXTURES: readonly JudgeMigrationFixture[] = [
  {
    name: 'B1',
    throughVersion: 5,
    seed(database) {
      database
        .prepare(
          `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
           VALUES ('judge-migration-b1-stage', 'gmail', 'account-b1', 'mailbox', X'01020304', 1)`,
        )
        .run();
    },
    readCiphertext(database) {
      return (
        database
          .prepare("SELECT encrypted_record FROM source_scan_state WHERE id = 'judge-migration-b1-stage'")
          .get() as { encrypted_record: Uint8Array }
      ).encrypted_record;
    },
  },
  {
    name: 'B2',
    throughVersion: 9,
    seed(database) {
      database
        .prepare(
          `INSERT INTO system_reset_outbox
             (id, reset_epoch, target_id, target_version, encrypted_record, attempt_limit, expires_at, state,
              switch_generation, created_at)
           VALUES ('judge-migration-b2-reset', 1, 'target-b2', 1, X'05060708', 20, 86400001, 'queued', 0, 1)`,
        )
        .run();
    },
    readCiphertext(database) {
      return (
        database
          .prepare("SELECT encrypted_record FROM system_reset_outbox WHERE id = 'judge-migration-b2-reset'")
          .get() as { encrypted_record: Uint8Array }
      ).encrypted_record;
    },
  },
  {
    name: 'D',
    throughVersion: 13,
    seed(database) {
      database.exec(`INSERT INTO ingest
        (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
        VALUES ('judge-migration-d-event', 'installation-d', 'gmail.message.received', 1, 'account-d', 'dedupe-d', 1, 1, 1);
        INSERT INTO decisions
          (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
        VALUES ('judge-migration-d-decision', 'judge-migration-d-event', 'account-d', 'rule-d', 1, 'matched', 999, 'retained');
        INSERT INTO deliveries
          (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
           encrypted_record, expires_at, state, switch_generation)
        VALUES ('judge-migration-d-delivery', 'judge-migration-d-decision', 'account-d', 'rule-d', 1,
                'sse:target-d:1:subscriber-d:1', 'target-d', 1, X'090A0B0C', 999, 'delivered', 0);
        INSERT INTO stream_log
          (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
           event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
           expires_at, switch_generation)
        VALUES ('judge-migration-d-stream', 'judge-migration-d-delivery', 'rule-d', 1, 'target-d', 1,
                'subscriber-d', 1, 'judge-migration-d-event', 'account-d', NULL, NULL, X'0D0E0F10', 1, 999, 0)`);
    },
    readCiphertext(database) {
      return (
        database.prepare("SELECT encrypted_record FROM stream_log WHERE id = 'judge-migration-d-stream'").get() as {
          encrypted_record: Uint8Array;
        }
      ).encrypted_record;
    },
  },
];
