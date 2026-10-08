import { CommsError } from '@agentcomms/core';
import { ImmutableVersions } from '../domain/versions.ts';
import type { EventDatabase } from '../store/database.ts';
import type { ActivationRuntime } from './activations.ts';
import { purgeRevokedRuleWork } from './replacements.ts';

/** The revoking pointer mutations: they cancel any claimed completion they bind, then revoke in one transaction. */
type Revoker = Pick<ActivationRuntime, 'cancelForRevocation'>;

export async function disableRule(
  database: EventDatabase,
  activations: Revoker,
  ruleId: string,
): Promise<{ readonly ruleId: string; readonly disabled: true }> {
  await activations.cancelForRevocation({ ruleId });
  database.immediate(() => {
    const active = new ImmutableVersions(database.database).activeVersion('rule', ruleId);
    if (!active) throw new CommsError('NOT_FOUND', 'the rule has no active version to disable');
    // D2: disabling a rule revokes its standing authorisation, so a superseded version still holding retained work is
    // revoked with the active one; neither may cross another disclosure boundary.
    const live = (
      database.database
        .prepare("SELECT version FROM rule_versions WHERE rule_id = ? AND state IN ('active', 'superseded')")
        .all(ruleId) as Array<{ version: number }>
    ).map((row) => row.version);
    database.database
      .prepare(
        "UPDATE rule_versions SET state = 'revoked', revoked_at = ? WHERE rule_id = ? AND state IN ('active', 'superseded')",
      )
      .run(Date.now(), ruleId);
    purgeRevokedRuleWork(database.database, ruleId, live);
    database.database.prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = ?").run(ruleId);
  });
  return { ruleId, disabled: true };
}

export async function removeTarget(
  database: EventDatabase,
  activations: Revoker,
  targetId: string,
): Promise<{ readonly targetId: string; readonly removed: true }> {
  await activations.cancelForRevocation({ targetId });
  database.immediate(() => {
    const revokedAt = Date.now();
    const rows = database.database
      .prepare('SELECT version FROM target_versions WHERE target_id = ? AND revoked_at IS NULL')
      .all(targetId) as Array<{ version: number }>;
    if (rows.length === 0) throw new CommsError('NOT_FOUND', 'the target has no live version to remove');
    for (const row of rows) {
      database.database
        .prepare('UPDATE target_versions SET revoked_at = ? WHERE target_id = ? AND version = ?')
        .run(revokedAt, targetId, row.version);
      database.database
        .prepare('INSERT OR REPLACE INTO object_revocations (kind, object_id, version, revoked_at) VALUES (?, ?, ?, ?)')
        .run('target', targetId, row.version, revokedAt);
    }
    const boundRules = database.database
      .prepare("SELECT rule_id, version, document FROM rule_versions WHERE state IN ('active', 'superseded')")
      .all() as Array<{ rule_id: string; version: number; document: string }>;
    for (const rule of boundRules) {
      const document = JSON.parse(rule.document) as { targets?: Array<{ targetId?: unknown }> };
      if (!document.targets?.some((target) => target.targetId === targetId)) continue;
      database.database
        .prepare("UPDATE rule_versions SET state = 'revoked', revoked_at = ? WHERE rule_id = ? AND version = ?")
        .run(revokedAt, rule.rule_id, rule.version);
      purgeRevokedRuleWork(database.database, rule.rule_id, [rule.version]);
      database.database
        .prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = ? AND version = ?")
        .run(rule.rule_id, rule.version);
    }
  });
  return { targetId, removed: true };
}
