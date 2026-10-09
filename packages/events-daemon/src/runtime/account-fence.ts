import type { DatabaseSync } from 'node:sqlite';
import { CommsError, type ConfigStore } from '@agentcomms/core';
import type { SourceOptions } from '../domain/source-options.ts';
import type { SourceScope } from '../sources/contracts.ts';
import { purgeRevokedRuleWork } from './replacements.ts';

export interface EventAccountScope {
  readonly source: SourceOptions['channel'];
  readonly accountId: string;
}

/** Source workers and schedulers carry a concrete scope; account liveness deliberately ignores only its cursor id. */
export async function assertLiveSourceScope(config: Pick<ConfigStore, 'load'>, scope: SourceScope): Promise<void> {
  await assertLiveEventAccount(config, { source: scope.source, accountId: scope.accountId });
}

function accountIsLive(
  current: Awaited<ReturnType<Pick<ConfigStore, 'load'>['load']>>,
  scope: EventAccountScope,
): boolean {
  if (scope.source === 'gmail') {
    return Object.values(current.inboxes).some((inbox) => inbox.id === scope.accountId && inbox.provider === 'gmail');
  }
  return Object.values(current.accounts).some(
    (account) => account.id === scope.accountId && account.platform === scope.source,
  );
}

/** Reads core's live source-specific registry at the boundary; the daemon retains no account identity cache. */
export async function assertLiveEventAccount(
  config: Pick<ConfigStore, 'load'>,
  scope: EventAccountScope,
): Promise<void> {
  const current = await config.load();
  if (accountIsLive(current, scope)) return;
  throw new CommsError('NOT_FOUND', 'the account bound to this event work is no longer connected', {
    details: { reason: 'ACCOUNT_REMOVED', accountId: scope.accountId, source: scope.source },
  });
}

/** The current stable ids for one source, loaded afresh at the boundary. */
export async function liveEventAccountIds(
  config: Pick<ConfigStore, 'load'>,
  source: SourceOptions['channel'],
): Promise<ReadonlySet<string>> {
  const current = await config.load();
  if (source === 'gmail') {
    return new Set(
      Object.values(current.inboxes)
        .filter((inbox) => inbox.provider === 'gmail')
        .map((inbox) => inbox.id),
    );
  }
  return new Set(
    Object.values(current.accounts)
      .filter((account) => account.platform === source)
      .map((account) => account.id),
  );
}

/** Reads the configuration for every boundary; event account identity is never cached by the daemon. */
export async function assertLiveGmailAccount(config: Pick<ConfigStore, 'load'>, accountId: string): Promise<void> {
  await assertLiveEventAccount(config, { source: 'gmail', accountId });
}

/** The Gmail account ids core's configuration names now; read at the boundary, never cached. */
export async function liveGmailAccountIds(config: Pick<ConfigStore, 'load'>): Promise<ReadonlySet<string>> {
  return liveEventAccountIds(config, 'gmail');
}

/** The same stable reason crosses source, evaluation, dispatch and terminal-read boundaries unchanged. */
export function isRemovedAccountError(error: unknown): error is CommsError {
  return error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED';
}

/** D9's account-removal cleanup is content-free after it has purged account-bound work. */
export function purgeRemovedAccountWork(
  database: DatabaseSync,
  account: EventAccountScope | string,
  now: number,
): void {
  const scope: EventAccountScope = typeof account === 'string' ? { source: 'gmail', accountId: account } : account;
  const { accountId, source } = scope;
  if (source === 'whatsapp') {
    // stream_log carries the optional WhatsApp occurrence foreign key, so retained frames must go before their parent
    // occurrence ledger when a re-check observes account removal under the list lock.
    database.prepare('DELETE FROM stream_log WHERE account_id = ?').run(accountId);
    database.prepare('DELETE FROM whatsapp_rule_admissions WHERE account_id = ?').run(accountId);
    database.prepare('DELETE FROM whatsapp_snapshot_keys WHERE account_id = ?').run(accountId);
    database.prepare('DELETE FROM whatsapp_snapshot_heads WHERE account_id = ?').run(accountId);
    database.prepare('DELETE FROM whatsapp_occurrences WHERE account_id = ?').run(accountId);
    database.prepare('DELETE FROM whatsapp_visibility WHERE account_id = ?').run(accountId);
  }
  if (source === 'slack') database.prepare('DELETE FROM slack_reply_drains WHERE account_id = ?').run(accountId);
  if (source === 'resend') database.prepare('DELETE FROM resend_status_state WHERE account_id = ?').run(accountId);
  database.prepare('DELETE FROM source_scan_state WHERE source = ? AND account_id = ?').run(source, accountId);
  database.prepare('DELETE FROM cursors WHERE source = ? AND account_id = ?').run(source, accountId);
  database.prepare('DELETE FROM activation_baselines WHERE source = ? AND account_id = ?').run(source, accountId);
  database.prepare('DELETE FROM replacement_drains WHERE source = ? AND account_id = ?').run(source, accountId);
  database
    .prepare('DELETE FROM ingest_rules WHERE event_id IN (SELECT event_id FROM ingest WHERE account_id = ?)')
    .run(accountId);
  database.prepare('DELETE FROM dryrun_log WHERE account_id = ?').run(accountId);
  if (source !== 'whatsapp') database.prepare('DELETE FROM stream_log WHERE account_id = ?').run(accountId);
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
  database.prepare('DELETE FROM rule_activation_points WHERE source = ? AND account_id = ?').run(source, accountId);
  database
    .prepare('DELETE FROM source_occurrence_resolutions WHERE source = ? AND account_id = ?')
    .run(source, accountId);
  database
    .prepare('DELETE FROM source_projection_resolutions WHERE source = ? AND account_id = ?')
    .run(source, accountId);
  database
    .prepare(
      "UPDATE decisions SET outcome = 'cancelled', hold_expires_at = NULL, hold_bound_by = NULL, encrypted_record = NULL WHERE account_id = ? AND outcome = 'hold'",
    )
    .run(accountId);
  database.prepare('UPDATE decisions SET encrypted_record = NULL WHERE account_id = ?').run(accountId);
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
    const document = JSON.parse(version.document) as { source?: { channel?: unknown; accountIds?: unknown } };
    const accountIds = document.source?.accountIds;
    if (
      (document.source?.channel ?? 'gmail') !== source ||
      !Array.isArray(accountIds) ||
      accountIds.length === 0 ||
      !accountIds.every((id) => id === accountId)
    )
      continue;
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
