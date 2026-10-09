import type { DatabaseSync } from 'node:sqlite';
import { CommsError, type ConfigStore } from '@agentcomms/core';
import { purgeRevokedRuleWork } from './replacements.ts';

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

/** The Gmail account ids core's configuration names now; read at the boundary, never cached. */
export async function liveGmailAccountIds(config: Pick<ConfigStore, 'load'>): Promise<ReadonlySet<string>> {
  const current = await config.load();
  return new Set(
    Object.values(current.inboxes)
      .filter((inbox) => inbox.provider === 'gmail')
      .map((inbox) => inbox.id),
  );
}

/** The same stable reason crosses source, evaluation, dispatch and terminal-read boundaries unchanged. */
export function isRemovedAccountError(error: unknown): error is CommsError {
  return error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED';
}

/** D9's account-removal cleanup is content-free after it has purged account-bound work. */
export function purgeRemovedAccountWork(database: DatabaseSync, accountId: string, now: number): void {
  database.prepare('DELETE FROM source_scan_state WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM cursors WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM activation_baselines WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM replacement_drains WHERE account_id = ?').run(accountId);
  database
    .prepare('DELETE FROM ingest_rules WHERE event_id IN (SELECT event_id FROM ingest WHERE account_id = ?)')
    .run(accountId);
  database.prepare('DELETE FROM dryrun_log WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM stream_log WHERE account_id = ?').run(accountId);
  database
    .prepare(
      "UPDATE deliveries SET state = 'in-flight-at-account-removal', encrypted_record = NULL, lease_until = NULL, next_at = NULL WHERE account_id = ? AND state = 'disclosing'",
    )
    .run(accountId);
  database
    .prepare(
      "UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, next_at = NULL WHERE account_id = ? AND state IN ('queued', 'retryable')",
    )
    .run(accountId);
  database
    .prepare("UPDATE deliveries SET encrypted_record = NULL WHERE account_id = ? AND state = 'dead-lettered'")
    .run(accountId);
  // D9: the account's activation points and source resolutions go too, so a later reconnect of the same stable id can
  // never resume from a cut-over taken before the removal and backfill the mail that arrived meanwhile.
  database.prepare('DELETE FROM rule_activation_points WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM source_occurrence_resolutions WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM source_projection_resolutions WHERE account_id = ?').run(accountId);
  // Its ingest records go with its projections. One a terminal decision still names stays as that content-free
  // decision's identity (the spec keeps the delivery's cancelled or in-flight outcome), and goes when the decision does.
  database
    .prepare(
      `DELETE FROM ingest WHERE account_id = ?
         AND NOT EXISTS (SELECT 1 FROM decisions WHERE decisions.event_id = ingest.event_id)
         AND NOT EXISTS (SELECT 1 FROM dryrun_log WHERE dryrun_log.event_id = ingest.event_id)
         AND NOT EXISTS (SELECT 1 FROM stream_log WHERE stream_log.event_id = ingest.event_id)`,
    )
    .run(accountId);
  // D9: every live rule version whose source scope names only that account is revoked, as a disable revokes it. A
  // multi-account version stays live for its other ids; the account fence stops it polling or disclosing this one.
  const versions = database
    .prepare("SELECT rule_id, version, document FROM rule_versions WHERE state IN ('active', 'superseded')")
    .all() as Array<{ rule_id: string; version: number; document: string }>;
  for (const version of versions) {
    const document = JSON.parse(version.document) as { source?: { accountIds?: unknown } };
    const accountIds = document.source?.accountIds;
    if (!Array.isArray(accountIds) || accountIds.length === 0 || !accountIds.every((id) => id === accountId)) continue;
    database
      .prepare("UPDATE rule_versions SET state = 'revoked', revoked_at = ? WHERE rule_id = ? AND version = ?")
      .run(now, version.rule_id, version.version);
    purgeRevokedRuleWork(database, version.rule_id, [version.version]);
    database
      .prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = ? AND version = ?")
      .run(version.rule_id, version.version);
  }
  database
    .prepare('INSERT OR REPLACE INTO account_revocations (account_id, revoked_at) VALUES (?, ?)')
    .run(accountId, now);
}
