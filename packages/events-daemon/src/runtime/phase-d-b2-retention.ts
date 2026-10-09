import type { DatabaseSync } from 'node:sqlite';
import type { EventDatabase } from '../store/database.ts';
import { fixedDeadline } from '../store/retention.ts';
import type {
  DSourceRetentionParticipant,
  DSourceRetentionTighteningInput,
  WhatsAppListChangeParticipant,
} from './phase-d-whatsapp-seam.ts';

type RetainedRuleVersionsInput = Readonly<{
  readonly ruleId: string;
  readonly ruleVersions: readonly number[];
}>;

type RetentionShorteningInput = RetainedRuleVersionsInput &
  Readonly<{
    readonly durationMs: number;
    readonly at: number;
  }>;

/** Removes SSE bytes at their durable expiry. The caller already owns the encompassing transaction. */
export function purgeExpiredB2StreamRecords(transaction: DatabaseSync, now: number): number {
  return Number(transaction.prepare('DELETE FROM stream_log WHERE expires_at <= ?').run(now).changes);
}

/** Removes every retained B2 stream record for a global disable, within that disable's transaction. */
export function purgeAllB2StreamRecords(transaction: DatabaseSync): void {
  transaction.exec('DELETE FROM stream_log');
}

/** Purges the B2 retained records owned by exact revoked rule versions, never by rule id alone. */
export function purgeB2RetainedContentForRuleVersions(
  transaction: DatabaseSync,
  input: RetainedRuleVersionsInput,
): void {
  for (const version of input.ruleVersions) {
    transaction.prepare('DELETE FROM stream_log WHERE rule_id = ? AND rule_version = ?').run(input.ruleId, version);
    transaction
      .prepare(
        "UPDATE deliveries SET encrypted_record = NULL WHERE rule_id = ? AND rule_version = ? AND state = 'dead-lettered'",
      )
      .run(input.ruleId, version);
  }
}

/**
 * D's list transaction calls this only after its migration has added the matching nullable delivery tuple. B2 does
 * not create that column: before D, no persisted WhatsApp row can reach this participant.
 */
export function purgeB2RetainedContentForWhatsAppMessages(
  transaction: DatabaseSync,
  input: Readonly<{ readonly accountId: string; readonly whatsappMessageIds: readonly string[] }>,
): void {
  const messageIds = [...new Set(input.whatsappMessageIds)];
  if (messageIds.length === 0) return;
  const placeholders = messageIds.map(() => '?').join(', ');
  transaction
    .prepare(
      `DELETE FROM stream_log
       WHERE account_id = ? AND whatsapp_message_id IN (${placeholders})`,
    )
    .run(input.accountId, ...messageIds);
  transaction
    .prepare(
      `UPDATE deliveries SET encrypted_record = NULL
       WHERE account_id = ? AND state = 'dead-lettered' AND whatsapp_message_id IN (${placeholders})`,
    )
    .run(input.accountId, ...messageIds);
}

/** Shortens B2 stream deadlines from their fixed delivery clock, deleting content that is already due. */
export function shortenB2SseReplayDeadlines(transaction: DatabaseSync, input: RetentionShorteningInput): void {
  for (const version of input.ruleVersions) {
    const rows = transaction
      .prepare(
        `SELECT id, delivered_at, expires_at FROM stream_log
         WHERE rule_id = ? AND rule_version = ?`,
      )
      .all(input.ruleId, version) as Array<{ id: string; delivered_at: number; expires_at: number }>;
    for (const row of rows) {
      const expiresAt = Math.min(row.expires_at, fixedDeadline(row.delivered_at, input.durationMs));
      if (expiresAt <= input.at) transaction.prepare('DELETE FROM stream_log WHERE id = ?').run(row.id);
      else transaction.prepare('UPDATE stream_log SET expires_at = ? WHERE id = ?').run(expiresAt, row.id);
    }
  }
}

/** Shortens B2 dead-letter payload deadlines from their immutable dead-lettered-at clock. */
export function shortenB2DeadLetterDeadlines(transaction: DatabaseSync, input: RetentionShorteningInput): void {
  for (const version of input.ruleVersions) {
    const rows = transaction
      .prepare(
        `SELECT id, dead_lettered_at, dead_letter_expires_at FROM deliveries
         WHERE rule_id = ? AND rule_version = ? AND state = 'dead-lettered'
           AND dead_lettered_at IS NOT NULL AND dead_letter_expires_at IS NOT NULL`,
      )
      .all(input.ruleId, version) as Array<{
      id: string;
      dead_lettered_at: number;
      dead_letter_expires_at: number;
    }>;
    for (const row of rows) {
      const expiresAt = Math.min(row.dead_letter_expires_at, fixedDeadline(row.dead_lettered_at, input.durationMs));
      if (expiresAt <= input.at) {
        transaction
          .prepare(
            `UPDATE deliveries
             SET dead_letter_expires_at = ?, state = 'retention-expired', encrypted_record = NULL, lease_until = NULL
             WHERE id = ? AND state = 'dead-lettered'`,
          )
          .run(expiresAt, row.id);
      } else {
        transaction
          .prepare("UPDATE deliveries SET dead_letter_expires_at = ? WHERE id = ? AND state = 'dead-lettered'")
          .run(expiresAt, row.id);
      }
    }
  }
}

function ruleVersionsForIds(
  transaction: DatabaseSync,
  ruleId: string,
  versionIds: readonly string[],
): readonly number[] {
  const ids = [...new Set(versionIds)];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return (
    transaction
      .prepare(`SELECT version FROM rule_versions WHERE rule_id = ? AND id IN (${placeholders})`)
      .all(ruleId, ...ids) as Array<{ version: number }>
  ).map((row) => row.version);
}

function transactionTime(value: string): number {
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at)) throw new RangeError('the retention transaction time must be an ISO instant');
  return at;
}

function durationFor(input: DSourceRetentionTighteningInput, retention: 'sse-replay' | 'dead-letter'): number | null {
  const durations = input.changes.filter((change) => change.retention === retention).map((change) => change.durationMs);
  return durations.length === 0 ? null : Math.min(...durations);
}

const listParticipant: WhatsAppListChangeParticipant = {
  purgeNewlyHiddenInTransaction(transaction, input): void {
    purgeB2RetainedContentForWhatsAppMessages(transaction, {
      accountId: input.accountId,
      whatsappMessageIds: input.newlyHiddenMessageIds,
    });
  },
};

const retentionParticipant: DSourceRetentionParticipant = {
  shortenOrPurgeInTransaction(transaction, input): void {
    const at = transactionTime(input.at);
    const affectedVersions = ruleVersionsForIds(transaction, input.ruleId, input.affectedVersionIds);
    const sseReplayDuration = durationFor(input, 'sse-replay');
    if (sseReplayDuration !== null) {
      shortenB2SseReplayDeadlines(transaction, {
        ruleId: input.ruleId,
        ruleVersions: affectedVersions,
        durationMs: sseReplayDuration,
        at,
      });
    }
    const deadLetterDuration = durationFor(input, 'dead-letter');
    if (deadLetterDuration !== null) {
      shortenB2DeadLetterDeadlines(transaction, {
        ruleId: input.ruleId,
        ruleVersions: affectedVersions,
        durationMs: deadLetterDuration,
        at,
      });
    }
    purgeB2RetainedContentForRuleVersions(transaction, {
      ruleId: input.ruleId,
      ruleVersions: ruleVersionsForIds(transaction, input.ruleId, [input.revokedVersionId]),
    });
  },
};

/**
 * Builds B2's structural Phase-D participants. Registration is deliberately outside this factory: Phase D Task 7's
 * production composition is their one registration site, while B2 keeps its default registry inert.
 */
export function createB2RetainedContentParticipants(
  input: Readonly<{ database: EventDatabase }>,
): Readonly<{ list: WhatsAppListChangeParticipant; retention: DSourceRetentionParticipant }> {
  // The factory shape is shared with Phase D, but each participant may touch only the supplied already-open tx.
  void input;
  return { list: listParticipant, retention: retentionParticipant };
}
