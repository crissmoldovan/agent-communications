import type { DatabaseSync } from 'node:sqlite';

/**
 * Seeds the rows a raised event stands on, for tests that need one before the engine (B2) exists: an ingest record, its
 * decision, a run, and then events and deliveries. Content-free: a sealed record is whatever bytes the test gives.
 */

let ordinal = 0;

/** A `wfr_` or `wfe_` id of 26 Crockford characters, stable per call order. */
export function testId(prefix: 'wfr_' | 'wfe_'): string {
  ordinal += 1;
  return `${prefix}${String(ordinal).padStart(26, '0')}`;
}

export function seedRun(
  database: DatabaseSync,
  input: {
    readonly runId?: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly accountId: string;
    readonly switchGeneration?: number;
    readonly now?: number;
  },
): string {
  const runId = input.runId ?? testId('wfr_');
  const now = input.now ?? Date.now();
  const eventId = `event-${runId}`;
  const decisionId = `decision-${runId}`;
  database
    .prepare(
      `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, 'installation', 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
    )
    .run(eventId, input.accountId, `dedupe-${runId}`, now, now, now);
  database
    .prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES (?, ?, ?, ?, ?, 'matched', ?, 'retained')`,
    )
    .run(decisionId, eventId, input.accountId, input.ruleId, input.ruleVersion, now + 86_400_000);
  database
    .prepare(
      `INSERT INTO workflow_runs
         (id, decision_id, rule_id, rule_version, account_id, event_id, state, started_at, updated_at, expires_at,
          switch_generation, encrypted_record)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL)`,
    )
    .run(
      runId,
      decisionId,
      input.ruleId,
      input.ruleVersion,
      input.accountId,
      eventId,
      now,
      now,
      now + 86_400_000,
      input.switchGeneration ?? 0,
    );
  return runId;
}

/** A raised event, open with a stand-in sealed record, and one queued delivery per subscriber version given. */
export function seedEvent(
  database: DatabaseSync,
  input: {
    readonly runId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly accountId: string;
    readonly type?: string;
    readonly sequence?: number;
    readonly now?: number;
    readonly deliveries: readonly {
      readonly subscriberId: string;
      readonly version: number;
      readonly kind: 'sse' | 'webhook';
    }[];
  },
): string {
  const eventId = testId('wfe_');
  const now = input.now ?? Date.now();
  database
    .prepare(
      `INSERT INTO workflow_events
         (id, run_id, step_id, rule_id, rule_version, account_id, type, schema, sequence, raised_at, expires_at, state,
          encrypted_record)
       VALUES (?, ?, 'issue', ?, ?, ?, ?, 'step.deliver.linear', ?, ?, ?, 'open', X'00')`,
    )
    .run(
      eventId,
      input.runId,
      input.ruleId,
      input.ruleVersion,
      input.accountId,
      input.type ?? 'acme.client-asks.issue.created',
      input.sequence ?? 1,
      now,
      now + 86_400_000,
    );
  for (const delivery of input.deliveries) {
    const { next } = database
      .prepare(
        `SELECT COALESCE(MAX(ordering_sequence), 0) + 1 AS next FROM event_deliveries
          WHERE subscriber_id = ? AND subscriber_version = ?`,
      )
      .get(delivery.subscriberId, delivery.version) as { next: number };
    database
      .prepare(
        `INSERT INTO event_deliveries (event_id, subscriber_id, subscriber_version, kind, state, ordering_sequence)
         VALUES (?, ?, ?, ?, 'queued', ?)`,
      )
      .run(eventId, delivery.subscriberId, delivery.version, delivery.kind, next);
  }
  return eventId;
}
