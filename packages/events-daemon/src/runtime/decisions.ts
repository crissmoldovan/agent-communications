import { CommsError } from '@agentcomms/core';
import type { EventDatabase } from '../store/database.ts';
import type { PreparedDelivery } from './deliveries.ts';

export interface DecisionCommitInput {
  readonly id: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly outcome: 'matched' | 'no-match' | 'mapping-rejected' | 'retention-expired';
  readonly metadataExpiresAt: number;
  readonly switchGeneration: number;
  readonly deliveries: readonly PreparedDelivery[];
}

export type DecisionFailpoint = 'after-decision' | 'after-delivery' | 'after-projection-purge' | 'before-commit';

/** Why a decision did not commit: the work it would complete was purged, or the switch moved, after the fence. */
export class StaleDecisionError extends CommsError {
  constructor(reason: 'PROJECTION_GONE' | 'STALE_GENERATION') {
    super('APPROVAL_VOID', 'the evaluated work changed before its decision could commit', { details: { reason } });
  }
}

/**
 * One transactional terminalisation: the decision, complete outbox and projection purge commit together or not at
 * all. The fence ran before decryption and the awaits that followed, so the transaction re-checks what could have
 * changed since: the projection must still exist (a disable, revocation or account removal purges it), and work that
 * may disclose needs the switch still on at the fenced generation. A commit can never recreate purged work (D12).
 */
export function commitDecisionOutbox(
  store: EventDatabase,
  input: DecisionCommitInput,
  failpoint?: (point: DecisionFailpoint) => void,
): void {
  store.immediate(() => {
    const projection = store.database
      .prepare('SELECT 1 AS present FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
      .get(input.eventId, input.ruleId, input.ruleVersion);
    if (projection === undefined) throw new StaleDecisionError('PROJECTION_GONE');
    if (input.outcome !== 'retention-expired') {
      const settings = store.database
        .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
        .get() as { enabled: number; switch_generation: number } | undefined;
      if (settings?.enabled !== 1 || settings.switch_generation !== input.switchGeneration)
        throw new StaleDecisionError('STALE_GENERATION');
    }
    store.database
      .prepare(
        `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'retained')`,
      )
      .run(
        input.id,
        input.eventId,
        input.accountId,
        input.ruleId,
        input.ruleVersion,
        input.outcome,
        input.metadataExpiresAt,
      );
    failpoint?.('after-decision');
    for (const delivery of input.deliveries) {
      store.database
        .prepare(
          `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
            encrypted_record, expires_at, state, switch_generation, next_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          delivery.id,
          input.id,
          input.accountId,
          input.ruleId,
          input.ruleVersion,
          delivery.targetKey,
          delivery.target.targetId,
          delivery.target.targetVersion,
          delivery.encryptedRecord,
          delivery.expiresAt,
          input.switchGeneration,
          0,
        );
      failpoint?.('after-delivery');
    }
    store.database
      .prepare('DELETE FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
      .run(input.eventId, input.ruleId, input.ruleVersion);
    failpoint?.('after-projection-purge');
    failpoint?.('before-commit');
  });
}
