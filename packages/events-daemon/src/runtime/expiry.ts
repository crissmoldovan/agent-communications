import type { EventDatabase } from '../store/database.ts';

export interface ExpirySweepResult {
  readonly deliveries: number;
  readonly localRecords: number;
  readonly projections: number;
  readonly decisionMetadata: number;
}

/** Deletes B1 content at its durable deadline without waiting for a later delivery or read. */
export class EventExpiry {
  readonly #store: EventDatabase;
  readonly #now: () => number;

  constructor(store: EventDatabase, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  sweep(): ExpirySweepResult {
    const now = this.#now();
    return this.#store.immediate(() => {
      const database = this.#store.database;
      const deliveries = Number(
        database
          .prepare(
            `UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL
             WHERE state IN ('queued', 'retryable', 'disclosing') AND expires_at <= ?`,
          )
          .run(now).changes,
      );
      const localRecords = Number(database.prepare('DELETE FROM dryrun_log WHERE expires_at <= ?').run(now).changes);
      // D8: an expired projection ends with its content-free terminal outcome, recorded in the same transaction as
      // the purge, so a sweep never makes an outcome disappear. Evaluation records the same outcome when it gets
      // there first; the unique (event, rule, version) decision keeps them one.
      database
        .prepare(
          `INSERT OR IGNORE INTO decisions
           (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
           SELECT 'expired:' || p.event_id || ':' || p.rule_id || ':' || p.rule_version, p.event_id, i.account_id,
                  p.rule_id, p.rule_version, 'retention-expired',
                  ? + COALESCE(json_extract(r.document, '$.retention.decisionMetadataMs'), 0), 'retained'
           FROM ingest_rules p
           JOIN ingest i ON i.event_id = p.event_id
           LEFT JOIN rule_versions r ON r.rule_id = p.rule_id AND r.version = p.rule_version
           WHERE p.decision_deadline <= ?`,
        )
        .run(now, now);
      const projections = Number(
        database.prepare('DELETE FROM ingest_rules WHERE decision_deadline <= ?').run(now).changes,
      );
      const decisionMetadata = Number(
        database
          .prepare(
            `UPDATE decisions SET encrypted_record = NULL, metadata_state = 'purged', purged_at = ?
             WHERE metadata_state != 'purged' AND metadata_expires_at <= ?`,
          )
          .run(now, now).changes,
      );
      return { deliveries, localRecords, projections, decisionMetadata };
    });
  }
}
