import type { EventDatabase } from '../store/database.ts';
import { fixedDeadline } from '../store/retention.ts';
import { purgeExpiredB2StreamRecords } from './phase-d-b2-retention.ts';
import { degradeResetBarrier } from './system-reset-outbox.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';

export interface DeadLetterInput {
  readonly deliveryId: string;
  readonly deadLetterRetentionMs: number;
  readonly now?: number | undefined;
}

/**
 * Starts the dead-letter clock exactly once. A retry after a crash reads the persisted clock and does not turn a
 * terminal or expired row back into disclosure work.
 */
export function deadLetterDelivery(store: EventDatabase, input: DeadLetterInput): void {
  const now = input.now ?? Date.now();
  store.immediate(() => {
    const row = store.database
      .prepare('SELECT state, dead_lettered_at, dead_letter_expires_at FROM deliveries WHERE id = ?')
      .get(input.deliveryId) as
      | { state: string; dead_lettered_at: number | null; dead_letter_expires_at: number | null }
      | undefined;
    if (!row) throw new Error('delivery is missing');
    if (row.dead_lettered_at !== null && row.dead_letter_expires_at !== null) return;
    if (!['queued', 'retryable', 'disclosing'].includes(row.state)) return;
    const deadline = fixedDeadline(now, input.deadLetterRetentionMs);
    store.database
      .prepare(
        `UPDATE deliveries
         SET state = 'dead-lettered', dead_lettered_at = ?, dead_letter_expires_at = ?, lease_until = NULL
         WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing')
           AND dead_lettered_at IS NULL AND dead_letter_expires_at IS NULL`,
      )
      .run(now, deadline, input.deliveryId);
  });
}

export interface ExpirySweepResult {
  readonly deliveries: number;
  readonly localRecords: number;
  readonly streamRecords: number;
  readonly projections: number;
  readonly decisionMetadata: number;
  readonly sourceStages: number;
}

/** Source-specific expiry that needs to decrypt a staged record before it can derive content-free terminal keys. */
export interface AsyncSourceStageExpiry {
  sweep(): Promise<number>;
}

/** Runs every source-specific decrypted expiry before any adapter can inspect a retained source record. */
export class SourceStageExpiryGroup implements AsyncSourceStageExpiry {
  readonly #sources: readonly AsyncSourceStageExpiry[];

  constructor(sources: readonly AsyncSourceStageExpiry[]) {
    this.#sources = sources;
  }

  async sweep(): Promise<number> {
    let expired = 0;
    for (const source of this.#sources) expired += await source.sweep();
    return expired;
  }
}

/** Deletes B1 content at its durable deadline without waiting for a later delivery or read. */
export class EventExpiry {
  readonly #store: EventDatabase;
  readonly #now: () => number;
  readonly #asyncSourceStages: AsyncSourceStageExpiry | undefined;

  constructor(
    store: EventDatabase,
    now: () => number = Date.now,
    asyncSourceStages?: AsyncSourceStageExpiry | undefined,
  ) {
    this.#store = store;
    this.#now = now;
    this.#asyncSourceStages = asyncSourceStages;
  }

  /** Runs synchronous and decrypted source-stage expiry before the owner starts source, control, or replay work. */
  async sweepAll(): Promise<ExpirySweepResult> {
    const swept = this.sweep();
    const sourceStages = (await this.#asyncSourceStages?.sweep()) ?? 0;
    return { ...swept, sourceStages: swept.sourceStages + sourceStages };
  }

  sweep(): ExpirySweepResult {
    const now = this.#now();
    return this.#store.immediate(() => {
      const database = this.#store.database;
      const expiring = database
        .prepare(
          `SELECT id FROM deliveries
           WHERE (state IN ('queued', 'retryable', 'disclosing') AND expires_at <= ?)
              OR (state = 'dead-lettered' AND dead_letter_expires_at IS NOT NULL AND dead_letter_expires_at <= ?)`,
        )
        .all(now, now) as Array<{ id: string }>;
      const deliveries = Number(
        database
          .prepare(
            `UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL, next_at = NULL
             WHERE (state IN ('queued', 'retryable', 'disclosing') AND expires_at <= ?)
                OR (state = 'dead-lettered' AND dead_letter_expires_at IS NOT NULL AND dead_letter_expires_at <= ?)`,
          )
          .run(now, now).changes,
      );
      for (const delivery of expiring) {
        const targets = removeRetainedDeliveryTargetReference(database, delivery.id);
        for (const target of targets) purgeUnreferencedSystemTargets(database, { ...target, now });
      }
      // A reset notice at its 24-hour deadline ends `retention-expired` with its barrier degraded — exactly as the
      // claim path ends it — so whichever of the sweep and a claim gets there first leaves the same state.
      const expiredResets = database
        .prepare(
          `SELECT id, reset_epoch, target_id, target_version FROM system_reset_outbox
           WHERE state IN ('queued', 'retryable', 'disclosing') AND expires_at <= ?`,
        )
        .all(now) as Array<{ id: string; reset_epoch: number; target_id: string; target_version: number }>;
      for (const reset of expiredResets) {
        const changed = database
          .prepare(
            `UPDATE system_reset_outbox
             SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL, next_at = NULL
             WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing') AND expires_at <= ?`,
          )
          .run(reset.id, now).changes;
        if (changed === 1)
          degradeResetBarrier(
            database,
            {
              id: reset.id,
              resetEpoch: reset.reset_epoch,
              targetId: reset.target_id,
              targetVersion: reset.target_version,
            },
            now,
          );
      }
      const localRecords = Number(database.prepare('DELETE FROM dryrun_log WHERE expires_at <= ?').run(now).changes);
      const streamRecords = purgeExpiredB2StreamRecords(database, now);
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
      const sourceStages = this.#expireSourceStages(database, now);
      return { deliveries, localRecords, streamRecords, projections, decisionMetadata, sourceStages };
    });
  }

  /** Purges due source bytes before another source step could inspect or retry them. */
  #expireSourceStages(database: EventDatabase['database'], now: number): number {
    const whatsapp = database
      .prepare(
        `SELECT account_id, message_id
         FROM whatsapp_occurrences
         WHERE stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
      )
      .all(now) as Array<{ account_id: string; message_id: string }>;
    for (const occurrence of whatsapp) {
      database
        .prepare(
          `UPDATE whatsapp_rule_admissions
           SET admission = 'expired', admitted_at = ?
           WHERE account_id = ? AND message_id = ? AND admission != 'baseline'`,
        )
        .run(now, occurrence.account_id, occurrence.message_id);
      database
        .prepare(
          `UPDATE whatsapp_occurrences
           SET staged_payload_ref = NULL, stage_expires_at = NULL
           WHERE account_id = ? AND message_id = ?`,
        )
        .run(occurrence.account_id, occurrence.message_id);
    }
    // Gmail, Slack and Resend stages are decrypted by their registered source-specific sweepers. The old generic
    // branch could only name an opaque stage id, which both lost the durable continuation and allowed re-admission.
    return whatsapp.length;
  }
}
