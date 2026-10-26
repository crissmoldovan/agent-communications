import type { DatabaseSync } from 'node:sqlite';

/** The closed set of target kinds a delivery row can carry (migration 24; Linear from migration 31). */
export type DeliveryTargetKind = 'dry-run' | 'webhook' | 'sse' | 'queue' | 'linear';

/**
 * One `deliveries list` row: content-free metadata only. The fields after `deadLetterExpiresAt` are 0.32.0's (owner
 * feedback §3.5) and additive: the target's kind, the last answer a try got, the decision and event the delivery came
 * from, and when it was delivered. The deliveries table keeps no creation or delivery time of its own, so
 * `deliveredAt` is the time the dry-run log, the SSE replay log or the queue recorded the delivery, while that row is
 * kept, and null otherwise (a webhook's delivery time is not stored). `deadLetteredAt` is when a delivery failed for
 * good (its tries spent), from the table's own column.
 */
export interface DeliveryListRowV1 {
  readonly deliveryId: string;
  readonly accountId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly subscriberId: string | null;
  readonly subscriberVersion: number | null;
  readonly attempts: number;
  readonly nextAt: number | null;
  readonly expiresAt: number;
  readonly state: string;
  readonly switchGeneration: number;
  readonly deadLetterExpiresAt: number | null;
  readonly targetKind: DeliveryTargetKind;
  readonly lastErrorCode: string | null;
  readonly lastStatus: number | null;
  readonly decisionId: string;
  readonly eventId: string | null;
  readonly deliveredAt: number | null;
  readonly deadLetteredAt: number | null;
  /**
   * The Linear issue a Linear delivery added (0.33.0 design §3.4): its identifier (CUE-123) and its address, without
   * the title's words. Present only once there is one; ids, never what the issue says.
   */
  readonly linear?: { readonly identifier: string; readonly url: string };
}

interface DeliveryListSqlRow {
  readonly id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly subscriber_id: string | null;
  readonly subscriber_version: number | null;
  readonly attempts: number;
  readonly next_at: number | null;
  readonly expires_at: number;
  readonly state: string;
  readonly switch_generation: number;
  readonly dead_letter_expires_at: number | null;
  readonly target_kind: DeliveryTargetKind;
  readonly last_error_code: string | null;
  readonly last_status: number | null;
  readonly decision_id: string;
  readonly event_id: string | null;
  readonly delivered_at: number | null;
  readonly dead_lettered_at: number | null;
  readonly linear_identifier: string | null;
  readonly linear_url: string | null;
}

const SELECT_ROWS = `SELECT d.id, d.account_id, d.rule_id, d.rule_version, d.target_id, d.target_version, d.subscriber_id,
         d.subscriber_version, d.attempts, d.next_at, d.expires_at, d.state, d.switch_generation,
         d.dead_letter_expires_at, d.target_kind, d.last_error_code, d.last_status, d.decision_id, x.event_id,
         d.dead_lettered_at, d.linear_identifier, d.linear_url,
         CASE WHEN d.state = 'delivered' THEN COALESCE(l.delivered_at, s.delivered_at, q.appended_at) END AS delivered_at
    FROM deliveries AS d
    LEFT JOIN decisions AS x ON x.id = d.decision_id
    LEFT JOIN dryrun_log AS l ON l.delivery_id = d.id
    LEFT JOIN stream_log AS s ON s.delivery_id = d.id
    LEFT JOIN queue_items AS q ON q.delivery_id = d.id`;

function shape(row: DeliveryListSqlRow): DeliveryListRowV1 {
  return {
    deliveryId: row.id,
    accountId: row.account_id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    targetId: row.target_id,
    targetVersion: row.target_version,
    subscriberId: row.subscriber_id,
    subscriberVersion: row.subscriber_version,
    attempts: row.attempts,
    nextAt: row.next_at,
    expiresAt: row.expires_at,
    state: row.state,
    switchGeneration: row.switch_generation,
    deadLetterExpiresAt: row.dead_letter_expires_at,
    targetKind: row.target_kind,
    lastErrorCode: row.last_error_code,
    lastStatus: row.last_status,
    decisionId: row.decision_id,
    eventId: row.event_id,
    deliveredAt: row.delivered_at,
    deadLetteredAt: row.dead_lettered_at,
    ...(row.linear_identifier === null || row.linear_url === null
      ? {}
      : { linear: { identifier: row.linear_identifier, url: row.linear_url } }),
  };
}

/** Every delivery, in id order, as `deliveries list` returns it. */
export function listDeliveryRows(database: DatabaseSync): readonly DeliveryListRowV1[] {
  return (database.prepare(`${SELECT_ROWS} ORDER BY d.id`).all() as unknown as DeliveryListSqlRow[]).map(shape);
}

/** One delivery's `deliveries list` row, or undefined when there is none with this id. */
export function deliveryRow(database: DatabaseSync, deliveryId: string): DeliveryListRowV1 | undefined {
  const row = database.prepare(`${SELECT_ROWS} WHERE d.id = ?`).get(deliveryId) as unknown as
    | DeliveryListSqlRow
    | undefined;
  return row === undefined ? undefined : shape(row);
}
