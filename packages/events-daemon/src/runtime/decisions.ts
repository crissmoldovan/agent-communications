import { CommsError } from '@agentcomms/core';
import type { EventDatabase } from '../store/database.ts';
import type { PreparedDelivery } from './deliveries.ts';
import { allocateDeliveryOrderSequence } from './delivery-claim.ts';
import { assertStoredRuleAuthority } from './disclosure-fence.ts';
import { assertJudgeReservationInFlightInTransaction, settleReservationInTransaction } from './judge-budget.ts';
import { addRetainedDeliveryTargetReference } from './target-version-references.ts';

export interface DecisionCommitInput {
  readonly id: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly outcome: 'matched' | 'no-match' | 'mapping-rejected' | 'retention-expired' | 'hold';
  readonly metadataExpiresAt: number;
  readonly switchGeneration: number;
  readonly whatsapp?: Readonly<{ messageId: string; visibilityVersion: number }> | undefined;
  readonly deliveries: readonly PreparedDelivery[];
  /** The coordinator owns a completed response, but settlement and the terminal decision commit atomically here. */
  readonly settlement?: Readonly<{ reservationId: string; actualInputTokens: number; settledAt: number }> | undefined;
  /** Snapshot from the asynchronous disclosure fence, compared to the immutable rule lineage in the final write. */
  readonly disclosure?: Readonly<{ approvalId: string; authorizationActivationId: string }> | undefined;
  /** Judge values, thresholds and provider metadata are always encrypted before this terminal transaction. */
  readonly encryptedMetadata?: Uint8Array | undefined;
  /** Task 8 takes ownership of hold deadlines; until then a hold retains its projection for its resolver. */
  readonly retainProjection?: boolean | undefined;
}

export type DecisionFailpoint =
  | 'after-settlement'
  | 'after-decision'
  | 'after-delivery'
  | 'after-projection-purge'
  | 'before-commit';

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
    // A removal revokes work authorised before (or in the same tick as) it. The revocation row deliberately remains
    // after a stable account id is re-added, so compare it to this exact version's activation rather than treating
    // historical removal as a permanent account ban. Activation gives a post-re-add approval a strictly later
    // created_at even when the wall clock has not advanced.
    const accountRevoked = store.database
      .prepare(
        `SELECT 1 AS present
           FROM account_revocations AS revocation
          WHERE revocation.account_id = ?
            AND revocation.revoked_at >= COALESCE(
              (SELECT intent.created_at
                 FROM rule_versions AS version
                 JOIN activation_intents AS intent ON intent.id = version.authorization_activation_id
                WHERE version.rule_id = ? AND version.version = ?),
              0
            )`,
      )
      .get(input.accountId, input.ruleId, input.ruleVersion);
    if (accountRevoked !== undefined) throw new StaleDecisionError('PROJECTION_GONE');
    if (input.outcome !== 'retention-expired') {
      const settings = store.database
        .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
        .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
      if (settings?.enabled !== 1 || settings.paused === 1 || settings.switch_generation !== input.switchGeneration)
        throw new StaleDecisionError('STALE_GENERATION');
    }
    // Deterministic EVAL-B1 decisions keep their established shared path.  A coordinator-owned response additionally
    // binds the exact disclosure lineage and immutable rule authority in this final settlement transaction.
    if (input.settlement !== undefined && input.disclosure !== undefined) {
      const lineage = store.database
        .prepare(
          `SELECT 1 AS present FROM rule_versions
           WHERE rule_id = ? AND version = ? AND approval_id = ? AND authorization_activation_id = ?
             AND revoked_at IS NULL AND state IN ('active', 'superseded')`,
        )
        .get(input.ruleId, input.ruleVersion, input.disclosure.approvalId, input.disclosure.authorizationActivationId);
      if (lineage === undefined) throw new StaleDecisionError('STALE_GENERATION');
      assertStoredRuleAuthority(store.database, input.ruleId, input.ruleVersion);
    }
    if (input.whatsapp !== undefined && input.disclosure !== undefined) {
      const visible = store.database
        .prepare('SELECT 1 AS present FROM whatsapp_visibility WHERE account_id = ? AND version = ?')
        .get(input.accountId, input.whatsapp.visibilityVersion);
      if (visible === undefined) throw new StaleDecisionError('PROJECTION_GONE');
    }
    if (input.settlement !== undefined) {
      // The response crossed an I/O boundary.  Check the exact durable reservation authority again in this same
      // transaction before it can settle a charge or make a decision visible.
      assertJudgeReservationInFlightInTransaction(store.database, input.settlement.reservationId);
      const settled = settleReservationInTransaction(store.database, {
        reservationId: input.settlement.reservationId,
        result: 'completed',
        actualInputTokens: input.settlement.actualInputTokens,
        now: input.settlement.settledAt,
      });
      if (!settled) throw new StaleDecisionError('PROJECTION_GONE');
      failpoint?.('after-settlement');
    }
    store.database
      .prepare(
        `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record, whatsapp_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'retained', ?, ?)`,
      )
      .run(
        input.id,
        input.eventId,
        input.accountId,
        input.ruleId,
        input.ruleVersion,
        input.outcome,
        input.metadataExpiresAt,
        input.encryptedMetadata ?? null,
        input.whatsapp?.messageId ?? null,
      );
    failpoint?.('after-decision');
    for (const delivery of input.deliveries) {
      // B2-D: rule and target version replacements do not create another ordering stream. The counter's stable
      // identity intentionally excludes both immutable version numbers.
      const orderingSequence = allocateDeliveryOrderSequence(store.database, {
        ruleId: input.ruleId,
        accountId: input.accountId,
        targetId: delivery.target.targetId,
      });
      store.database
        .prepare(
          `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
            target_kind, target_representation, subscriber_id, subscriber_version, encrypted_record, expires_at,
            state, switch_generation, next_at, ordering_sequence, whatsapp_visibility_version, whatsapp_message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
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
          delivery.target.kind,
          delivery.representation,
          delivery.target.kind === 'sse' ? delivery.target.subscriberId : null,
          delivery.target.kind === 'sse' ? delivery.target.subscriberVersion : null,
          delivery.encryptedRecord,
          delivery.expiresAt,
          input.switchGeneration,
          0,
          orderingSequence,
          input.whatsapp?.visibilityVersion ?? null,
          input.whatsapp?.messageId ?? null,
        );
      addRetainedDeliveryTargetReference(store.database, {
        deliveryId: delivery.id,
        ruleId: input.ruleId,
        ruleVersion: input.ruleVersion,
        targetId: delivery.target.targetId,
        targetVersion: delivery.target.targetVersion,
        createdAt: Date.now(),
      });
      failpoint?.('after-delivery');
    }
    if (!input.retainProjection) {
      store.database
        .prepare('DELETE FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
        .run(input.eventId, input.ruleId, input.ruleVersion);
      failpoint?.('after-projection-purge');
    }
    failpoint?.('before-commit');
  });
}
