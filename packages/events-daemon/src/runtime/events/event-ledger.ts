import type { DatabaseSync } from 'node:sqlite';

/**
 * The raised-event ledger's settlement rules (workflows design W33, §4.3, §7.6): `workflow_events` holds each event's
 * sealed record only while one of its deliveries may still need it, and `event_deliveries` is each subscriber
 * version's at-least-once, ordered queue. Every function here runs inside its caller's transaction and is content-free.
 */

/** A delivery a dispatcher may still claim or is sending. */
export const OPEN_EVENT_DELIVERY_STATES: readonly ['queued', 'retryable', 'disclosing'] = Object.freeze([
  'queued',
  'retryable',
  'disclosing',
] as const);

/** Each subscriber version holds at most this many undelivered events; past it the oldest expire (W33). */
export const SUBSCRIBER_BACKLOG_MAX = 10_000;

const OPEN_SQL = "('queued', 'retryable', 'disclosing')";

/** Which deliveries a cancellation reaches: a subscriber's, a workflow's, an account's, a run's, or one. */
export type EventDeliveryScope =
  | { readonly all: true }
  | { readonly subscriberId: string; readonly subscriberVersion?: number | undefined }
  | { readonly ruleId: string; readonly ruleVersions?: readonly number[] | undefined }
  | { readonly accountId: string; readonly source?: string | undefined }
  | { readonly runId: string }
  | { readonly eventId: string; readonly subscriberId: string; readonly subscriberVersion: number };

function scopeWhere(scope: EventDeliveryScope): { readonly sql: string; readonly args: readonly (string | number)[] } {
  if ('all' in scope) return { sql: '1 = 1', args: [] };
  if ('eventId' in scope)
    return {
      sql: 'delivery.event_id = ? AND delivery.subscriber_id = ? AND delivery.subscriber_version = ?',
      args: [scope.eventId, scope.subscriberId, scope.subscriberVersion],
    };
  if ('subscriberId' in scope)
    return scope.subscriberVersion === undefined
      ? { sql: 'delivery.subscriber_id = ?', args: [scope.subscriberId] }
      : {
          sql: 'delivery.subscriber_id = ? AND delivery.subscriber_version = ?',
          args: [scope.subscriberId, scope.subscriberVersion],
        };
  if ('ruleId' in scope) {
    const versions = scope.ruleVersions;
    if (versions === undefined)
      return { sql: 'delivery.event_id IN (SELECT id FROM workflow_events WHERE rule_id = ?)', args: [scope.ruleId] };
    return {
      sql: `delivery.event_id IN (SELECT id FROM workflow_events WHERE rule_id = ? AND rule_version IN (${versions
        .map(() => '?')
        .join(', ')}))`,
      args: [scope.ruleId, ...versions],
    };
  }
  if ('accountId' in scope)
    return scope.source === undefined
      ? { sql: 'delivery.event_id IN (SELECT id FROM workflow_events WHERE account_id = ?)', args: [scope.accountId] }
      : {
          // An account is removed from one source: its events are those of workflows reading that source.
          sql: `delivery.event_id IN (SELECT event.id FROM workflow_events AS event
                 WHERE event.account_id = ?
                   AND COALESCE((SELECT json_extract(rule.document, '$.source.channel') FROM rule_versions AS rule
                                  WHERE rule.rule_id = event.rule_id AND rule.version = event.rule_version), 'gmail') = ?)`,
          args: [scope.accountId, scope.source],
        };
  return { sql: 'delivery.event_id IN (SELECT id FROM workflow_events WHERE run_id = ?)', args: [scope.runId] };
}

/**
 * Settles every named event none of whose deliveries is still open, or kept as a dead letter that may be retried, and
 * that no chained workflow may still start from (W34): it becomes `done` and its sealed record goes. An event past its
 * own deadline becomes `expired` the same way.
 */
export function settleFinishedEventsInTransaction(
  database: DatabaseSync,
  eventIds: Iterable<string>,
  now: number,
): void {
  for (const eventId of new Set(eventIds)) {
    const open = database
      .prepare(
        `SELECT 1 AS present FROM event_deliveries
          WHERE event_id = ?
            AND (state IN ${OPEN_SQL} OR (state = 'dead-lettered' AND dead_letter_expires_at > ?))
          LIMIT 1`,
      )
      .get(eventId, now);
    if (open !== undefined) continue;
    const chained = database
      .prepare('SELECT 1 AS present FROM workflow_chain_requests WHERE workflow_event_id = ? LIMIT 1')
      .get(eventId);
    if (chained !== undefined) continue;
    database
      .prepare(
        `UPDATE workflow_events
            SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'done' END, encrypted_record = NULL
          WHERE id = ? AND state = 'open'`,
      )
      .run(now, eventId);
  }
}

/**
 * Cancels the open deliveries a scope names — queued, waiting for a retry, or being sent, whose settle then finds them
 * cancelled and sends nothing more — and settles their events. A subscriber's retained frames go with it, and so do
 * those of a revoked workflow, a removed account or a cancelled run: no replay may disclose them again. A cancelled
 * workflow, account or run also cancels its events outright, retained dead letters included.
 */
export function cancelEventDeliveriesInTransaction(
  database: DatabaseSync,
  scope: EventDeliveryScope,
  now: number,
  code = 'CANCELLED',
): number {
  const where = scopeWhere(scope);
  const affected = (
    database
      .prepare(`SELECT DISTINCT delivery.event_id AS event_id FROM event_deliveries AS delivery WHERE ${where.sql}`)
      .all(...where.args) as Array<{ event_id: string }>
  ).map((row) => row.event_id);
  const cancelled = Number(
    database
      .prepare(
        `UPDATE event_deliveries AS delivery
          SET state = 'cancelled', lease_until = NULL, next_at = NULL, attempt_id = NULL, lease_token = NULL,
              last_error_code = ?
        WHERE ${where.sql} AND delivery.state IN ${OPEN_SQL}`,
      )
      .run(code, ...where.args).changes,
  );
  const streamWhere = where.sql.replaceAll('delivery.', 'event_stream_log.');
  database.prepare(`DELETE FROM event_stream_log WHERE ${streamWhere}`).run(...where.args);
  if ('all' in scope || 'ruleId' in scope || 'accountId' in scope || 'runId' in scope) {
    database
      .prepare(
        `UPDATE event_deliveries AS delivery SET dead_letter_expires_at = ?
          WHERE ${where.sql} AND delivery.state = 'dead-lettered'`,
      )
      .run(now, ...where.args);
    for (const eventId of affected)
      database
        .prepare(
          "UPDATE workflow_events SET state = 'cancelled', encrypted_record = NULL WHERE id = ? AND state = 'open'",
        )
        .run(eventId);
    cancelEventsWithoutDeliveriesInTransaction(database, scope);
    return cancelled;
  }
  settleFinishedEventsInTransaction(database, affected, now);
  return cancelled;
}

/** A workflow's, account's or run's open events that no subscriber was given are cancelled too. */
function cancelEventsWithoutDeliveriesInTransaction(
  database: DatabaseSync,
  scope: Extract<EventDeliveryScope, { all: true } | { ruleId: string } | { accountId: string } | { runId: string }>,
): void {
  if ('all' in scope) {
    database.exec("UPDATE workflow_events SET state = 'cancelled', encrypted_record = NULL WHERE state = 'open'");
    return;
  }
  if ('ruleId' in scope) {
    const versions = scope.ruleVersions;
    database
      .prepare(
        `UPDATE workflow_events SET state = 'cancelled', encrypted_record = NULL
          WHERE rule_id = ? AND state = 'open'${
            versions === undefined ? '' : ` AND rule_version IN (${versions.map(() => '?').join(', ')})`
          }`,
      )
      .run(scope.ruleId, ...(versions ?? []));
    return;
  }
  const [column, value] = 'accountId' in scope ? ['account_id', scope.accountId] : ['run_id', scope.runId];
  database
    .prepare(
      `UPDATE workflow_events SET state = 'cancelled', encrypted_record = NULL WHERE ${column} = ? AND state = 'open'`,
    )
    .run(value);
}

/**
 * Keeps one subscriber version's backlog within its bound: past `SUBSCRIBER_BACKLOG_MAX` undelivered events, the
 * oldest expire with `SUBSCRIBER_BACKLOG` (W33). It never blocks a run. Returns how many expired.
 */
export function expireSubscriberBacklogInTransaction(
  database: DatabaseSync,
  subscriberId: string,
  subscriberVersion: number,
  now: number,
): number {
  const { count } = database
    .prepare(
      `SELECT COUNT(*) AS count FROM event_deliveries
        WHERE subscriber_id = ? AND subscriber_version = ? AND state IN ('queued', 'retryable')`,
    )
    .get(subscriberId, subscriberVersion) as { count: number };
  const excess = count - SUBSCRIBER_BACKLOG_MAX;
  if (excess <= 0) return 0;
  const oldest = database
    .prepare(
      `SELECT event_id FROM event_deliveries
        WHERE subscriber_id = ? AND subscriber_version = ? AND state IN ('queued', 'retryable')
        ORDER BY ordering_sequence LIMIT ?`,
    )
    .all(subscriberId, subscriberVersion, excess) as Array<{ event_id: string }>;
  for (const row of oldest)
    database
      .prepare(
        `UPDATE event_deliveries
            SET state = 'expired', next_at = NULL, lease_until = NULL, last_error_code = 'SUBSCRIBER_BACKLOG'
          WHERE event_id = ? AND subscriber_id = ? AND subscriber_version = ? AND state IN ('queued', 'retryable')`,
      )
      .run(row.event_id, subscriberId, subscriberVersion);
  settleFinishedEventsInTransaction(
    database,
    oldest.map((row) => row.event_id),
    now,
  );
  return oldest.length;
}

/**
 * Settles what time has ended: open deliveries of an event past its deadline expire with it, and an event whose dead
 * letters have outlived their retention loses its sealed record. Returns how many deliveries expired.
 */
export function expireEventsInTransaction(database: DatabaseSync, now: number): number {
  const due = database
    .prepare("SELECT id FROM workflow_events WHERE state = 'open' AND expires_at <= ? ORDER BY expires_at LIMIT 500")
    .all(now) as Array<{ id: string }>;
  let expired = 0;
  for (const event of due) {
    expired += Number(
      database
        .prepare(
          `UPDATE event_deliveries SET state = 'expired', next_at = NULL, lease_until = NULL,
                last_error_code = COALESCE(last_error_code, 'RETENTION_EXPIRED')
          WHERE event_id = ? AND state IN ('queued', 'retryable')`,
        )
        .run(event.id).changes,
    );
    database
      .prepare("UPDATE workflow_events SET state = 'expired', encrypted_record = NULL WHERE id = ? AND state = 'open'")
      .run(event.id);
  }
  const lapsed = database
    .prepare(
      `SELECT DISTINCT event.id AS id FROM workflow_events AS event
         JOIN event_deliveries AS delivery ON delivery.event_id = event.id
        WHERE event.state = 'open' AND delivery.state = 'dead-lettered' AND delivery.dead_letter_expires_at <= ?
        LIMIT 500`,
    )
    .all(now) as Array<{ id: string }>;
  settleFinishedEventsInTransaction(
    database,
    lapsed.map((row) => row.id),
    now,
  );
  database.prepare('DELETE FROM event_stream_log WHERE expires_at <= ?').run(now);
  return expired;
}
