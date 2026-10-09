import type { DatabaseSync } from 'node:sqlite';
import type { SourceScope } from './contracts.ts';

export interface PublishedSourcePoint {
  readonly activationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly encryptedPosition: Uint8Array;
}

/** True when a claimed first/new-only activation owns a scope from its baseline until its point is published. */
export function isSourceScopeFenced(database: DatabaseSync, scope: SourceScope): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present
         FROM activation_baselines JOIN activation_intents ON activation_intents.id = activation_baselines.intent_id
         WHERE activation_baselines.source = ? AND activation_baselines.account_id = ?
           AND activation_baselines.position_scope = ?
           AND activation_intents.status = 'pending-completion'
           AND NOT EXISTS (
             SELECT 1 FROM replacement_drains
             WHERE replacement_drains.intent_id = activation_baselines.intent_id
               AND replacement_drains.source = activation_baselines.source
               AND replacement_drains.account_id = activation_baselines.account_id
               AND replacement_drains.position_scope = activation_baselines.position_scope
           )`,
      )
      .get(scope.source, scope.accountId, scope.scopeId) !== undefined
  );
}

/** The canonical published cut-over set, read at the beginning and again inside an initial-cursor insert. */
export function publishedSourcePointSet(database: DatabaseSync, scope: SourceScope): readonly PublishedSourcePoint[] {
  return database
    .prepare(
      `SELECT points.activation_id, points.rule_id, points.rule_version, points.encrypted_position
       FROM rule_activation_points AS points
       JOIN active_versions AS active
         ON active.kind = 'rule' AND active.object_id = points.rule_id AND active.version = points.rule_version
        AND active.current_cutover_id = points.activation_id
       WHERE points.source = ? AND points.account_id = ? AND points.position_scope = ?
       ORDER BY points.rule_id, points.rule_version, points.activation_id`,
    )
    .all(scope.source, scope.accountId, scope.scopeId)
    .map((row) => {
      const value = row as {
        activation_id: string;
        rule_id: string;
        rule_version: number;
        encrypted_position: Uint8Array;
      };
      return {
        activationId: value.activation_id,
        ruleId: value.rule_id,
        ruleVersion: value.rule_version,
        encryptedPosition: value.encrypted_position,
      };
    });
}

function fingerprint(points: readonly PublishedSourcePoint[]): string {
  return points.map((point) => `${point.activationId}:${point.ruleId}@${point.ruleVersion}`).join(',');
}

/** This must execute inside the cursor write transaction, after every asynchronous point decrypt. */
export function initialCursorStillCurrent(
  database: DatabaseSync,
  scope: SourceScope,
  pointsReadBeforeDecrypt: readonly PublishedSourcePoint[],
): boolean {
  return (
    !isSourceScopeFenced(database, scope) &&
    fingerprint(publishedSourcePointSet(database, scope)) === fingerprint(pointsReadBeforeDecrypt)
  );
}
