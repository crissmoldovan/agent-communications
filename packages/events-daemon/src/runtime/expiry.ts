import type { EventDatabase } from '../store/database.ts';
import { fixedDeadline } from '../store/retention.ts';
import { expireHeldDecisionsInTransaction } from './holds.ts';
import { JudgePurgeParticipant } from './judge-purge.ts';
import { purgeExpiredB2StreamRecords } from './phase-d-b2-retention.ts';
import { expireQueueItems } from './queue-retention.ts';
import { degradeResetBarrier } from './system-reset-outbox.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';
import { purgeWhatsAppStagedPayload } from './whatsapp-staged-payload.ts';

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
  /** Queue items whose content expired in this sweep; their content-free rows stay one retention more. */
  readonly queueContent: number;
  /** Content-free queue rows that reached their own end in this sweep. */
  readonly queueRows: number;
  /** Ended workflow runs whose history went with their decision's metadata in this sweep. */
  readonly runHistory: number;
}

/** How many ended runs' history one sweep purges at most; the next sweep takes the rest. */
const RUN_HISTORY_BATCH = 500;

/**
 * A run's history is content-free, and it is kept as long as its decision's metadata (workflows design W7): once that
 * metadata's deadline has passed, an ended run goes — its steps and waits, its events, their deliveries and replay
 * frames — in the transaction that purges the metadata (security review of 0.36.0, L4). Nothing still needed goes:
 * - never a live run (held, running or waiting), nor one another run or a chain request still names as its parent;
 * - never a run with an event still open, with a delivery still queued, retrying or being sent, with a dead letter
 *   still kept, or that a chain may still start from; nor one with a target delivery still to make.
 * A worktree's row goes only once nothing is left to clean up — it was removed, or never made — and its run has gone;
 * a row of a worktree that may still be on disk (being made, made or kept) stays, for its cleanup and its sessions.
 * Once its run has gone, a `made` or `kept` row is looked at on disk and by git, apart from this transaction
 * (`WorktreeRecordSweep`, 0.37.0 §2). Returns how many runs went.
 */
function purgeRunHistoryInTransaction(database: EventDatabase['database'], now: number): number {
  const due = database
    .prepare(
      `SELECT run.id FROM workflow_runs AS run
         JOIN decisions AS decision ON decision.id = run.decision_id
        WHERE run.state IN ('done', 'failed', 'cancelled', 'expired')
          AND decision.metadata_expires_at <= ?
          AND NOT EXISTS (SELECT 1 FROM workflow_runs AS child WHERE child.parent_run_id = run.id)
          AND NOT EXISTS (SELECT 1 FROM workflow_chain_requests AS chain WHERE chain.parent_run_id = run.id)
          AND NOT EXISTS (
            SELECT 1 FROM deliveries AS delivery
             WHERE delivery.run_id = run.id AND delivery.state IN ('queued', 'retryable', 'disclosing'))
          AND NOT EXISTS (
            SELECT 1 FROM workflow_events AS event
             WHERE event.run_id = run.id
               AND (event.state = 'open'
                    OR EXISTS (SELECT 1 FROM workflow_chain_requests AS chain WHERE chain.workflow_event_id = event.id)
                    OR EXISTS (
                      SELECT 1 FROM event_deliveries AS delivery
                       WHERE delivery.event_id = event.id
                         AND (delivery.state IN ('queued', 'retryable', 'disclosing')
                              OR (delivery.state = 'dead-lettered'
                                  AND (delivery.dead_letter_expires_at IS NULL
                                       OR delivery.dead_letter_expires_at > ?))))))
        ORDER BY decision.metadata_expires_at
        LIMIT ?`,
    )
    .all(now, now, RUN_HISTORY_BATCH) as Array<{ id: string }>;
  const ofRun = 'SELECT id FROM workflow_events WHERE run_id = ?';
  for (const { id } of due) {
    database.prepare(`DELETE FROM event_stream_log WHERE event_id IN (${ofRun})`).run(id);
    database.prepare(`DELETE FROM event_deliveries WHERE event_id IN (${ofRun})`).run(id);
    database.prepare('DELETE FROM workflow_events WHERE run_id = ?').run(id);
    // Its steps go with it, and their waits with them (ON DELETE CASCADE).
    database.prepare('DELETE FROM workflow_runs WHERE id = ?').run(id);
  }
  database
    .prepare(
      `DELETE FROM workflow_worktrees
        WHERE state IN ('refused', 'removed')
          AND NOT EXISTS (SELECT 1 FROM workflow_runs AS run WHERE run.id = workflow_worktrees.run_id)`,
    )
    .run();
  return due.length;
}

/** Source-specific expiry that needs to decrypt a staged record before it can derive content-free terminal keys. */
export interface AsyncSourceStageExpiry {
  sweep(): Promise<number>;
  /**
   * Decrypts a stage before a retention-tightening transaction.  The returned closures run inside that pointer
   * transaction, after its deadline update, so source-specific continuations and real occurrence keys survive the
   * same atomic cut-over as the ciphertext purge.
   */
  prepareRetentionTightening?(
    input: Readonly<{ ruleId: string; ingestRetentionMs: number; now: number }>,
  ): Promise<readonly PreparedSourceStageTerminalisation[]>;
}

/** A decrypted source-stage expiry whose writes must share the derived-tightening transaction. */
export interface PreparedSourceStageTerminalisation {
  terminaliseInTransaction(): number;
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

  async prepareRetentionTightening(
    input: Readonly<{ ruleId: string; ingestRetentionMs: number; now: number }>,
  ): Promise<readonly PreparedSourceStageTerminalisation[]> {
    const prepared: PreparedSourceStageTerminalisation[] = [];
    for (const source of this.#sources) {
      if (source.prepareRetentionTightening === undefined) continue;
      prepared.push(...(await source.prepareRetentionTightening(input)));
    }
    return prepared;
  }
}

/**
 * What the history sweep starts for the worktree rows of purged runs (0.37.0 §2): `WorktreeRecordSweep`, which reads
 * the disk and git apart from the sweep, and returns at once.
 */
export interface WorktreeRecordsPump {
  pump(): void;
}

/** Deletes B1 content at its durable deadline without waiting for a later delivery or read. */
export class EventExpiry {
  readonly #store: EventDatabase;
  readonly #now: () => number;
  readonly #asyncSourceStages: AsyncSourceStageExpiry | undefined;
  readonly #worktreeRecords: WorktreeRecordsPump | undefined;

  constructor(
    store: EventDatabase,
    now: () => number = Date.now,
    asyncSourceStages?: AsyncSourceStageExpiry | undefined,
    worktreeRecords?: WorktreeRecordsPump | undefined,
  ) {
    this.#store = store;
    this.#now = now;
    this.#asyncSourceStages = asyncSourceStages;
    this.#worktreeRecords = worktreeRecords;
  }

  /** Runs synchronous and decrypted source-stage expiry before the owner starts source, control, or replay work. */
  async sweepAll(): Promise<ExpirySweepResult> {
    const swept = this.sweep();
    // The worktree rows of the runs this sweep, or an earlier one, purged: looked at apart from it, never waited for.
    this.#worktreeRecords?.pump();
    const sourceStages = (await this.#asyncSourceStages?.sweep()) ?? 0;
    return { ...swept, sourceStages: swept.sourceStages + sourceStages };
  }

  sweep(): ExpirySweepResult {
    const now = this.#now();
    return this.#store.immediate(() => {
      const database = this.#store.database;
      // Holds take their own SQLite clock before every other expiry/control/replay action. This is intentionally
      // earlier than the process-clock based legacy projection sweep: at equality the held row chooses its durable
      // hold/ingest reason, removes its resolver claim, and is no longer eligible for the generic path.
      expireHeldDecisionsInTransaction(database);
      const expiringJudgeWork = database
        .prepare(
          `SELECT projection.event_id, projection.rule_id, projection.rule_version, ingest.account_id,
                  json_extract(rule.document, '$.source.channel') AS source
             FROM ingest_rules AS projection
             JOIN ingest ON ingest.event_id = projection.event_id
             JOIN rule_versions AS rule ON rule.rule_id = projection.rule_id AND rule.version = projection.rule_version
            WHERE projection.decision_deadline <= ?
              AND NOT EXISTS (
                SELECT 1
                  FROM decisions AS held
                 WHERE held.event_id = projection.event_id
                   AND held.rule_id = projection.rule_id
                   AND held.rule_version = projection.rule_version
                   AND held.outcome = 'hold'
              )`,
        )
        .all(now) as Array<{
        event_id: string;
        rule_id: string;
        rule_version: number;
        account_id: string;
        source: 'gmail' | 'slack' | 'resend' | 'whatsapp';
      }>;
      const judgePurge = new JudgePurgeParticipant({ database, now: this.#now });
      for (const work of expiringJudgeWork)
        judgePurge.event({
          source: work.source,
          accountId: work.account_id,
          eventId: work.event_id,
          ruleId: work.rule_id,
          ruleVersion: work.rule_version,
        });
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
      const queue = expireQueueItems(database, now);
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
           WHERE p.decision_deadline <= ?
             AND NOT EXISTS (
               SELECT 1
                 FROM decisions AS held
                WHERE held.event_id = p.event_id
                  AND held.rule_id = p.rule_id
                  AND held.rule_version = p.rule_version
                  AND held.outcome = 'hold'
             )`,
        )
        .run(now, now);
      const projections = Number(
        database
          .prepare(
            `DELETE FROM ingest_rules AS projection
              WHERE projection.decision_deadline <= ?
                AND NOT EXISTS (
                  SELECT 1
                    FROM decisions AS held
                   WHERE held.event_id = projection.event_id
                     AND held.rule_id = projection.rule_id
                     AND held.rule_version = projection.rule_version
                     AND held.outcome = 'hold'
                )`,
          )
          .run(now).changes,
      );
      const decisionMetadata = Number(
        database
          .prepare(
            `UPDATE decisions SET encrypted_record = NULL, metadata_state = 'purged', purged_at = ?
             WHERE metadata_state != 'purged' AND metadata_expires_at <= ?`,
          )
          .run(now, now).changes,
      );
      // A workflow run's history goes with its decision's metadata (W7).
      const runHistory = purgeRunHistoryInTransaction(database, now);
      // Analyse's sending domains end with the projection's deadline (security review of 0.33.0, finding 9).
      database.prepare('DELETE FROM decision_sender_domains WHERE expires_at <= ?').run(now);
      const sourceStages = this.#expireSourceStages(database, now);
      return {
        deliveries,
        localRecords,
        streamRecords,
        projections,
        decisionMetadata,
        sourceStages,
        queueContent: queue.content,
        queueRows: queue.rows,
        runHistory,
      };
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
      purgeWhatsAppStagedPayload(database, {
        accountId: occurrence.account_id,
        messageId: occurrence.message_id,
      });
    }
    // Gmail, Slack and Resend stages are decrypted by their registered source-specific sweepers. The old generic
    // branch could only name an opaque stage id, which both lost the durable continuation and allowed re-admission.
    return whatsapp.length;
  }
}
