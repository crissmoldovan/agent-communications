import type { DatabaseSync } from 'node:sqlite';

/**
 * D12's activation-completion scope fence. A claimed activation that has sampled P for a mailbox but not yet installed
 * its point there — a first activation, or a replacement's scope with no old-version drain (a new-only scope, or one the
 * old version had gone dark for) — pauses every commit on that mailbox until finalisation installs the point and drops
 * the baseline in one transaction. Otherwise another rule's scan, or the scheduler's initial-cursor install, could move
 * the shared cursor past P and the new version, starting at P, would never see what was consumed. A scope with an old-
 * version drain is not paused: the drain withholds after-P work itself, and the old version must reach P. A stuck claim
 * fails at its completion deadline, which drops the baseline and lifts the fence.
 */
export function isMailboxFenced(database: DatabaseSync, accountId: string): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present
         FROM activation_baselines JOIN activation_intents ON activation_intents.id = activation_baselines.intent_id
         WHERE activation_baselines.source = 'gmail' AND activation_baselines.account_id = ?
           AND activation_baselines.position_scope = 'mailbox'
           AND activation_intents.status = 'pending-completion'
           AND NOT EXISTS (
             SELECT 1 FROM replacement_drains
             WHERE replacement_drains.intent_id = activation_baselines.intent_id
               AND replacement_drains.source = activation_baselines.source
               AND replacement_drains.account_id = activation_baselines.account_id
               AND replacement_drains.position_scope = activation_baselines.position_scope
           )`,
      )
      .get(accountId) !== undefined
  );
}
