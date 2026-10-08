import type { DatabaseSync } from 'node:sqlite';
import { CommsError, type ConfigStore } from '@agentcomms/core';

/** Reads the configuration for every boundary; event account identity is never cached by the daemon. */
export async function assertLiveGmailAccount(config: Pick<ConfigStore, 'load'>, accountId: string): Promise<void> {
  const current = await config.load();
  const live = Object.values(current.inboxes).some((inbox) => inbox.id === accountId && inbox.provider === 'gmail');
  if (!live) {
    throw new CommsError('NOT_FOUND', 'the Gmail account bound to this event work is no longer connected', {
      details: { reason: 'ACCOUNT_REMOVED', accountId },
    });
  }
}

/** D9's account-removal cleanup is content-free after it has purged account-bound work. */
export function purgeRemovedAccountWork(database: DatabaseSync, accountId: string, now: number): void {
  database.prepare('DELETE FROM source_scan_state WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM activation_baselines WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM replacement_drains WHERE account_id = ?').run(accountId);
  database
    .prepare('DELETE FROM ingest_rules WHERE event_id IN (SELECT event_id FROM ingest WHERE account_id = ?)')
    .run(accountId);
  database.prepare('DELETE FROM dryrun_log WHERE account_id = ?').run(accountId);
  database
    .prepare(
      "UPDATE deliveries SET state = 'in-flight-at-account-removal', encrypted_record = NULL WHERE account_id = ? AND state = 'disclosing'",
    )
    .run(accountId);
  database
    .prepare(
      "UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL WHERE account_id = ? AND state IN ('queued', 'retryable')",
    )
    .run(accountId);
  database
    .prepare('INSERT OR REPLACE INTO account_revocations (account_id, revoked_at) VALUES (?, ?)')
    .run(accountId, now);
}
