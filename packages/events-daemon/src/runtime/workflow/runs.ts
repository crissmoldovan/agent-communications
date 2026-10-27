import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import type { FlowDocumentV1, FlowLimits, JsonValue, StepId } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../domain/activation-documents.ts';
import type { ProjectionCipher } from '../projections.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from '../target-version-references.ts';
import type { Output, RunView, WaitKind, WakeReason } from './contracts.ts';
import { newRunId } from './ids.ts';
import { chargeInTransaction, concurrencyAllowsInTransaction, globalConcurrencyAllowsInTransaction } from './limits.ts';

/*
 * A workflow's runs in the event service's database (workflows design §4.3, §5, §7): the run a match makes, in the
 * decision's own transaction; the claim of one step, with an attempt and a lease, as a delivery is claimed; and the
 * settle, which must prove the claim is still this attempt's or change nothing. Content is sealed in the run's record —
 * the mapped values — and purged in the transaction that ends the run; everything else here is content-free.
 */

/** How long a claimed step is this attempt's before another may claim it again. */
export const RUN_STEP_LEASE_MS = 30_000;

/** A run's sealed record: the mapped values its steps read, and later a session's summary and a chain's trigger. */
export interface RunRecord {
  readonly kind: 'workflow-run';
  readonly fields: JsonValue;
  readonly summaries?: Readonly<Record<StepId, string>>;
  readonly trigger?: Output;
}

/** Where a run's sealed record lives: bound to its table, column and primary key, the run's id. */
export function runRecordLocation(runId: string): {
  readonly table: 'workflow_runs';
  readonly column: 'encryptedRecord';
  readonly key: readonly [{ readonly type: 'text'; readonly value: string }];
} {
  return { table: 'workflow_runs', column: 'encryptedRecord', key: [{ type: 'text', value: runId }] };
}

/** Seals a run's record for its row, outside any transaction, as a delivery's record is sealed. */
export async function sealRunRecord(cipher: ProjectionCipher, runId: string, record: RunRecord): Promise<Buffer> {
  return cipher.encrypt(runRecordLocation(runId), Buffer.from(JSON.stringify(record)));
}

/** A run made ready to commit: its id, chosen before sealing so the record binds it, and the sealed record. */
export interface PreparedFlowRun {
  readonly runId: string;
  readonly sealedRecord: Buffer;
  readonly rule: CanonicalFullRuleDocument;
  /** When the match was made, on the evaluator's clock: the run's start and the base of its deadline. */
  readonly createdAt: number;
  /** A chained run's (W34): the run that raised the event that started it, and its depth, the parent's plus 1. */
  readonly parentRunId?: string | undefined;
  readonly depth?: number | undefined;
}

/**
 * For a match of a workflow with a flow: the run it makes, its record sealed (W7). A workflow without a flow makes
 * none, and fans out to its targets as before.
 */
export async function prepareFlowRun(input: {
  readonly cipher: ProjectionCipher;
  readonly rule: CanonicalFullRuleDocument;
  readonly data: JsonValue;
  readonly createdAt: number;
  /** A chained run's: the raised event's closed data, sealed with the fields as `/trigger` (W34). */
  readonly trigger?: Output | undefined;
  readonly parentRunId?: string | undefined;
  readonly depth?: number | undefined;
  readonly newRunId?: (() => string) | undefined;
}): Promise<PreparedFlowRun | undefined> {
  if (input.rule.flow === undefined) return undefined;
  const runId = (input.newRunId ?? newRunId)();
  const sealedRecord = await sealRunRecord(input.cipher, runId, {
    kind: 'workflow-run',
    fields: input.data,
    ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
  });
  return {
    runId,
    sealedRecord,
    rule: input.rule,
    createdAt: input.createdAt,
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId, depth: input.depth ?? 1 }),
  };
}

/** A `workflow_runs` row, as the engine reads it. */
export interface RunRow {
  readonly id: string;
  readonly decision_id: string;
  readonly parent_run_id: string | null;
  readonly depth: number;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly account_id: string;
  readonly event_id: string;
  readonly state: 'held' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'expired';
  readonly started_at: number;
  readonly updated_at: number;
  readonly expires_at: number;
  readonly switch_generation: number;
  readonly shadow: number;
  readonly executed_steps: number;
  readonly events_not_raised: number;
  readonly end_code: string | null;
  readonly encrypted_record: Uint8Array | null;
}

/** A `workflow_steps` row, as the engine reads it. */
export interface StepRow {
  readonly run_id: string;
  readonly step_id: StepId;
  readonly state: 'ready' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'cancelled';
  readonly outcome: string | null;
  readonly delivery_id: string | null;
  readonly attempt_id: string | null;
  readonly lease_token: string | null;
  readonly lease_until: number | null;
  readonly attempts: number;
  readonly next_at: number | null;
  readonly started_at: number | null;
  readonly settled_at: number | null;
  readonly settle_seq: number | null;
  readonly last_error_code: string | null;
  readonly output: string | null;
}

/** The states a run may still change from. */
export const LIVE_RUN_STATES: readonly ['held', 'running', 'waiting'] = Object.freeze([
  'held',
  'running',
  'waiting',
] as const);

/** The states a step is still on the way through. */
export const LIVE_STEP_STATES: readonly ['ready', 'running', 'waiting'] = Object.freeze([
  'ready',
  'running',
  'waiting',
] as const);

export function readRun(database: DatabaseSync, runId: string): RunRow | undefined {
  return database.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as RunRow | undefined;
}

export function readSteps(database: DatabaseSync, runId: string): readonly StepRow[] {
  return database
    .prepare('SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_id')
    .all(runId) as unknown as StepRow[];
}

/** A run as an executor sees it: content-free. */
export function runViewOf(row: RunRow): RunView {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    accountId: row.account_id,
    eventId: row.event_id,
    depth: row.depth,
    parentRunId: row.parent_run_id,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    shadow: row.shadow === 1,
  };
}

/** A step's stored closed output, or null. */
export function stepOutput(row: StepRow): Output | null {
  return row.output === null ? null : (JSON.parse(row.output) as Output);
}

/**
 * The run a match of a workflow with a flow makes (§5), inside the decision's own transaction: held, with its sealed
 * record and no step yet, so the engine starts it in turn — oldest first, as its limits allow — and never drops it.
 * Its deadline is its version's `runMs` from now.
 */
export function createRunInTransaction(
  database: DatabaseSync,
  input: {
    /** Chosen before the record was sealed: the record's location binds it. */
    readonly runId: string;
    readonly decisionId: string;
    readonly rule: CanonicalFullRuleDocument;
    readonly accountId: string;
    readonly eventId: string;
    readonly sealedRecord: Buffer;
    readonly parentRunId?: string | undefined;
    readonly depth?: number | undefined;
    readonly now: number;
  },
): RunView {
  const flow = input.rule.flow;
  if (flow === undefined) throw new CommsError('BAD_DATA', 'only a workflow with a flow makes a run');
  const settings = database.prepare('SELECT switch_generation FROM event_settings WHERE singleton = 1').get() as
    | { switch_generation: number }
    | undefined;
  if (settings === undefined) throw new CommsError('CONFIG', 'the local event switch is unavailable');
  const depth = input.depth ?? 0;
  const parentRunId = input.parentRunId ?? null;
  const expiresAt = input.now + flow.limits.runMs;
  database
    .prepare(
      `INSERT INTO workflow_runs
       (id, decision_id, parent_run_id, depth, rule_id, rule_version, account_id, event_id, state, started_at,
        updated_at, expires_at, switch_generation, shadow, encrypted_record)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.decisionId,
      parentRunId,
      depth,
      input.rule.ruleId,
      input.rule.version,
      input.accountId,
      input.eventId,
      input.now,
      input.now,
      expiresAt,
      settings.switch_generation,
      flow.shadow === true ? 1 : 0,
      input.sealedRecord,
    );
  return {
    id: input.runId,
    ruleId: input.rule.ruleId,
    ruleVersion: input.rule.version,
    accountId: input.accountId,
    eventId: input.eventId,
    depth,
    parentRunId,
    startedAt: input.now,
    expiresAt,
    shadow: flow.shadow === true,
  };
}

/** What starting a held run came to: started, still held, or held for the first time (W.3's `held`). */
export type RunStart = 'started' | 'held' | 'held-first' | 'gone';

/**
 * Starts a held run when its limits allow (§5, §7.5): one more live run of its workflow and of all, and one more in its
 * hour's `runsPerHour`, which it is then charged. Otherwise the run stays held, its start step waiting on the limit —
 * from its first look, so a run is announced held once — until the window frees or a run ends.
 */
export function startRunInTransaction(
  database: DatabaseSync,
  input: { readonly runId: string; readonly flow: FlowDocumentV1; readonly now: number },
): RunStart {
  const run = database.prepare('SELECT rule_id, state FROM workflow_runs WHERE id = ?').get(input.runId) as
    | { rule_id: string; state: string }
    | undefined;
  if (run?.state !== 'held') return 'gone';
  const start = input.flow.start;
  const existing = database
    .prepare('SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?')
    .get(input.runId, start) as { state: string } | undefined;
  const limits: FlowLimits = input.flow.limits;
  let until: number | null = null;
  let allowed = concurrencyAllowsInTransaction(database, run.rule_id, limits);
  if (allowed) {
    const charged = chargeInTransaction(database, run.rule_id, 'run', limits, input.now);
    if (!charged.ok) {
      allowed = false;
      until = charged.until;
    }
  }
  if (!allowed) {
    // A run that waits for a concurrent one looks again at each tick; one that waits for its hour, when it frees.
    const wakeAt = until ?? input.now;
    if (existing === undefined) {
      database
        .prepare("INSERT INTO workflow_steps (run_id, step_id, state, started_at) VALUES (?, ?, 'waiting', NULL)")
        .run(input.runId, start);
      database
        .prepare("INSERT INTO workflow_waits (run_id, step_id, kind, key, wake_at) VALUES (?, ?, 'limit', NULL, ?)")
        .run(input.runId, start, wakeAt);
      database.prepare('UPDATE workflow_runs SET updated_at = ? WHERE id = ?').run(input.now, input.runId);
      return 'held-first';
    }
    database
      .prepare('UPDATE workflow_waits SET wake_at = ? WHERE run_id = ? AND step_id = ?')
      .run(wakeAt, input.runId, start);
    return 'held';
  }
  database.prepare('DELETE FROM workflow_waits WHERE run_id = ? AND step_id = ?').run(input.runId, start);
  if (existing === undefined)
    database
      .prepare("INSERT INTO workflow_steps (run_id, step_id, state, next_at) VALUES (?, ?, 'ready', NULL)")
      .run(input.runId, start);
  else
    database
      .prepare("UPDATE workflow_steps SET state = 'ready', next_at = NULL WHERE run_id = ? AND step_id = ?")
      .run(input.runId, start);
  database
    .prepare("UPDATE workflow_runs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'held'")
    .run(input.now, input.runId);
  return 'started';
}

/** Whether another run of any workflow could start now: the global ceiling, read only. */
export function anyRunMayStartInTransaction(database: DatabaseSync): boolean {
  return globalConcurrencyAllowsInTransaction(database);
}

/** The delivery states after which a waiting deliver step resumes: every state but those still on the way. */
const DELIVERY_ON_THE_WAY = "('queued', 'retryable', 'disclosing')";

/** A claimed step: its attempt, and whether it runs, or resumes from a wait — with why. */
export interface ClaimedStep {
  readonly runId: string;
  readonly stepId: StepId;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly leaseUntil: number;
  /** This claim's number: the step's attempts, this one included. */
  readonly attempt: number;
  /** The step's first claim (W.3's `started`). */
  readonly first: boolean;
  readonly startedAt: number;
  readonly wake: WakeReason | null;
}

/** Why a step could not be claimed: nothing to do, or the run has reached its 64 executed steps (§7.5). */
export type ClaimRefusal = 'none' | 'step-limit';

/** The most steps one run executes, every claim counted (W4, §7.5). */
export const EXECUTED_STEPS_MAX = 64;

/**
 * Claims one step of a live run, as `claimDeliveryInTransaction` claims a delivery (§5): a ready step whose time has
 * come, a waiting step whose wait or delivery is over, or a running step whose lease has lapsed after a crash. The
 * claim writes a fresh attempt id, lease token and lease, and counts one executed step. A lapsed claim of a step still
 * waiting goes back to waiting; nothing is claimed while collection is off or paused.
 */
export function claimStepInTransaction(
  database: DatabaseSync,
  input: {
    readonly runId: string;
    readonly stepId: StepId;
    readonly now: number;
    readonly leaseMs: number;
    readonly attemptId: string;
    readonly leaseToken: string;
  },
): ClaimedStep | ClaimRefusal {
  const settings = database.prepare('SELECT enabled, paused FROM event_settings WHERE singleton = 1').get() as
    | { enabled: number; paused: number }
    | undefined;
  if (settings?.enabled !== 1 || settings.paused === 1) return 'none';
  const run = database.prepare('SELECT state, executed_steps FROM workflow_runs WHERE id = ?').get(input.runId) as
    | { state: string; executed_steps: number }
    | undefined;
  if (run === undefined || (run.state !== 'running' && run.state !== 'waiting')) return 'none';
  const step = database
    .prepare('SELECT * FROM workflow_steps WHERE run_id = ? AND step_id = ?')
    .get(input.runId, input.stepId) as StepRow | undefined;
  if (step === undefined) return 'none';
  const wait = database
    .prepare('SELECT kind, wake_at FROM workflow_waits WHERE run_id = ? AND step_id = ?')
    .get(input.runId, input.stepId) as { kind: WaitKind; wake_at: number } | undefined;
  const delivery =
    step.delivery_id === null
      ? undefined
      : (database.prepare('SELECT state, last_error_code FROM deliveries WHERE id = ?').get(step.delivery_id) as
          | { state: string; last_error_code: string | null }
          | undefined);
  const deliveryOver = delivery !== undefined && !['queued', 'retryable', 'disclosing'].includes(delivery.state);
  let wake: WakeReason | null = null;
  const waiting = step.state === 'waiting' || (step.state === 'running' && (step.lease_until ?? 0) <= input.now);
  if (step.state === 'ready') {
    if (step.next_at !== null && step.next_at > input.now) return 'none';
  } else if (waiting && (wait !== undefined || step.delivery_id !== null)) {
    if (wait !== undefined && wait.wake_at <= input.now) wake = { kind: wait.kind === 'limit' ? 'limit' : 'time' };
    else if (step.delivery_id !== null && deliveryOver)
      wake = {
        kind: 'delivery',
        deliveryId: step.delivery_id,
        state: delivery?.state ?? 'missing',
        code: delivery?.last_error_code ?? null,
      };
    else {
      // A lapsed claim of a step that is still waiting: it waits again, and nothing runs.
      if (step.state === 'running')
        database
          .prepare(
            `UPDATE workflow_steps SET state = 'waiting', attempt_id = NULL, lease_token = NULL, lease_until = NULL
              WHERE run_id = ? AND step_id = ? AND state = 'running'`,
          )
          .run(input.runId, input.stepId);
      return 'none';
    }
  } else if (!(step.state === 'running' && (step.lease_until ?? 0) <= input.now)) return 'none';
  if (run.executed_steps >= EXECUTED_STEPS_MAX) return 'step-limit';
  const leaseUntil = input.now + input.leaseMs;
  const claimed = database
    .prepare(
      `UPDATE workflow_steps
          SET state = 'running', attempt_id = ?, lease_token = ?, lease_until = ?, attempts = attempts + 1,
              started_at = COALESCE(started_at, ?), next_at = NULL
        WHERE run_id = ? AND step_id = ? AND state IN ('ready', 'running', 'waiting')`,
    )
    .run(input.attemptId, input.leaseToken, leaseUntil, input.now, input.runId, input.stepId);
  if (claimed.changes !== 1) return 'none';
  database
    .prepare(
      "UPDATE workflow_runs SET executed_steps = executed_steps + 1, state = 'running', updated_at = ? WHERE id = ?",
    )
    .run(input.now, input.runId);
  return {
    runId: input.runId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    leaseToken: input.leaseToken,
    leaseUntil,
    attempt: step.attempts + 1,
    first: step.attempts === 0,
    startedAt: step.started_at ?? input.now,
    wake,
  };
}

/** The steps a tick may claim, oldest run first. */
export function claimableSteps(
  database: DatabaseSync,
  now: number,
  limit: number,
): readonly { readonly runId: string; readonly stepId: StepId }[] {
  return (
    database
      .prepare(
        `SELECT s.run_id, s.step_id FROM workflow_steps AS s JOIN workflow_runs AS r ON r.id = s.run_id
          WHERE r.state IN ('running', 'waiting') AND (
                (s.state = 'ready' AND (s.next_at IS NULL OR s.next_at <= ?))
             OR (s.state = 'running' AND s.lease_until <= ?)
             OR (s.state = 'waiting' AND EXISTS (SELECT 1 FROM workflow_waits AS w
                   WHERE w.run_id = s.run_id AND w.step_id = s.step_id AND w.wake_at <= ?))
             OR (s.state = 'waiting' AND s.delivery_id IS NOT NULL AND EXISTS (SELECT 1 FROM deliveries AS d
                   WHERE d.id = s.delivery_id AND d.state NOT IN ${DELIVERY_ON_THE_WAY})))
          ORDER BY r.started_at, r.id, s.step_id
          LIMIT ?`,
      )
      .all(now, now, now, limit) as Array<{ run_id: string; step_id: string }>
  ).map((row) => ({ runId: row.run_id, stepId: row.step_id }));
}

/** The one write a settle makes, as the engine planned it from the run's steps it read before. */
export interface SettlePlan {
  readonly runId: string;
  readonly stepId: StepId;
  readonly attemptId: string;
  readonly leaseToken: string;
  /** The run's other steps' states, as the plan read them: the settle is dropped if any has changed since. */
  readonly expected: string;
  readonly step:
    | { readonly state: 'done'; readonly outcome: string; readonly output: Output }
    | { readonly state: 'failed'; readonly code: string }
    | {
        readonly state: 'waiting';
        readonly wait: { readonly kind: WaitKind; readonly key: string | null; readonly wakeAt: number } | null;
        readonly deliveryId: string | null;
        readonly output: Output | null;
      }
    | { readonly state: 'ready'; readonly nextAt: number; readonly code: string };
  readonly ready: readonly StepId[];
  readonly skipped: readonly StepId[];
  /** The run's state after the settle, and its end code when it ends. */
  readonly run:
    | { readonly state: 'running' | 'waiting' }
    | { readonly state: 'done' | 'failed'; readonly endCode: string | null };
  readonly now: number;
}

/** The run's other steps' states, in one string a settle compares to prove nothing moved since it read them. */
export function stepStates(steps: readonly Pick<StepRow, 'step_id' | 'state'>[], except: StepId): string {
  return steps
    .filter((step) => step.step_id !== except)
    .map((step) => `${step.step_id}:${step.state}`)
    .sort()
    .join(',');
}

/** Whether `claim` is still this attempt's: the same attempt id and lease token on a running step of a live run. */
export function isCurrentStepClaim(
  database: DatabaseSync,
  claim: Pick<ClaimedStep, 'runId' | 'stepId' | 'attemptId' | 'leaseToken'>,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present FROM workflow_steps AS s JOIN workflow_runs AS r ON r.id = s.run_id
          WHERE s.run_id = ? AND s.step_id = ? AND s.state = 'running' AND s.attempt_id = ? AND s.lease_token = ?
            AND r.state IN ('running', 'waiting')`,
      )
      .get(claim.runId, claim.stepId, claim.attemptId, claim.leaseToken) !== undefined
  );
}

/**
 * The settle (§5, step 5), inside the caller's transaction: the `UPDATE … WHERE attempt_id = ? AND lease_token = ?`
 * must change one row of a live run whose other steps are as the plan read them, or nothing is written and the settle
 * is dropped. Then the steps it makes ready, those now unreachable as skipped, and the run's state; a run that ends
 * has its sealed record purged here.
 */
export function settleStepInTransaction(database: DatabaseSync, plan: SettlePlan): boolean {
  if (!isCurrentStepClaim(database, plan)) return false;
  if (stepStates(readSteps(database, plan.runId), plan.stepId) !== plan.expected) return false;
  const step = plan.step;
  const nextSeq = () =>
    (
      database
        .prepare('SELECT COALESCE(MAX(settle_seq), 0) + 1 AS next FROM workflow_steps WHERE run_id = ?')
        .get(plan.runId) as { next: number }
    ).next;
  const where = 'WHERE run_id = ? AND step_id = ? AND attempt_id = ? AND lease_token = ?';
  const claim = [plan.runId, plan.stepId, plan.attemptId, plan.leaseToken] as const;
  let changed: number | bigint;
  switch (step.state) {
    case 'done':
      changed = database
        .prepare(
          `UPDATE workflow_steps SET state = 'done', outcome = ?, output = ?, settled_at = ?, settle_seq = ?,
                  lease_token = NULL, lease_until = NULL ${where}`,
        )
        .run(step.outcome, JSON.stringify(step.output), plan.now, nextSeq(), ...claim).changes;
      break;
    case 'failed':
      changed = database
        .prepare(
          `UPDATE workflow_steps SET state = 'failed', last_error_code = ?, settled_at = ?, settle_seq = ?,
                  lease_token = NULL, lease_until = NULL ${where}`,
        )
        .run(step.code, plan.now, nextSeq(), ...claim).changes;
      break;
    case 'waiting':
      changed = database
        .prepare(
          `UPDATE workflow_steps SET state = 'waiting', delivery_id = COALESCE(?, delivery_id),
                  output = COALESCE(?, output), lease_token = NULL, lease_until = NULL ${where}`,
        )
        .run(step.deliveryId, step.output === null ? null : JSON.stringify(step.output), ...claim).changes;
      break;
    case 'ready':
      changed = database
        .prepare(
          `UPDATE workflow_steps SET state = 'ready', next_at = ?, last_error_code = ?, lease_token = NULL,
                  lease_until = NULL ${where}`,
        )
        .run(step.nextAt, step.code, ...claim).changes;
      break;
  }
  if (changed !== 1) return false;
  database.prepare('DELETE FROM workflow_waits WHERE run_id = ? AND step_id = ?').run(plan.runId, plan.stepId);
  if (step.state === 'waiting' && step.wait !== null)
    database
      .prepare('INSERT INTO workflow_waits (run_id, step_id, kind, key, wake_at) VALUES (?, ?, ?, ?, ?)')
      .run(plan.runId, plan.stepId, step.wait.kind, step.wait.key, step.wait.wakeAt);
  for (const id of plan.ready)
    database
      .prepare(
        "INSERT INTO workflow_steps (run_id, step_id, state, next_at) VALUES (?, ?, 'ready', NULL) ON CONFLICT DO NOTHING",
      )
      .run(plan.runId, id);
  for (const id of plan.skipped)
    database
      .prepare(
        "INSERT INTO workflow_steps (run_id, step_id, state, settled_at) VALUES (?, ?, 'skipped', ?) ON CONFLICT DO NOTHING",
      )
      .run(plan.runId, id, plan.now);
  if (plan.run.state === 'done' || plan.run.state === 'failed')
    database
      .prepare(
        `UPDATE workflow_runs SET state = ?, end_code = ?, encrypted_record = NULL, updated_at = ?
          WHERE id = ? AND state IN ('running', 'waiting')`,
      )
      .run(plan.run.state, plan.run.endCode, plan.now, plan.runId);
  else
    database
      .prepare(`UPDATE workflow_runs SET state = ?, updated_at = ? WHERE id = ? AND state IN ('running', 'waiting')`)
      .run(plan.run.state, plan.now, plan.runId);
  return true;
}

/** What ending a run cancelled: its deliveries still waiting, and its events not yet delivered. */
export interface RunEnding {
  readonly cancelledDeliveries: number;
  readonly cancelledEvents: number;
}

/**
 * Ends a live run that did not run to its end (§5, §7.6, W10), inside the caller's transaction: cancelled or expired,
 * its steps still on the way cancelled, its waits dropped, its deliveries still waiting cancelled and their records
 * purged, as `session-queue drop` does, and its sealed record purged. A cancelled run's undelivered events are
 * cancelled too: its authority, or the person, ended it. An expired run's raised events still go out. Content-free.
 */
export function endRunInTransaction(
  database: DatabaseSync,
  input: {
    readonly runId: string;
    readonly state: 'cancelled' | 'expired';
    readonly code: string;
    readonly now: number;
  },
): RunEnding | null {
  const ended = database
    .prepare(
      `UPDATE workflow_runs SET state = ?, end_code = ?, encrypted_record = NULL, updated_at = ?
        WHERE id = ? AND state IN ('held', 'running', 'waiting')`,
    )
    .run(input.state, input.code, input.now, input.runId);
  if (ended.changes !== 1) return null;
  database
    .prepare(
      `UPDATE workflow_steps SET state = 'cancelled', outcome = NULL, attempt_id = NULL, lease_token = NULL,
              lease_until = NULL, next_at = NULL, settled_at = ?
        WHERE run_id = ? AND state IN ('ready', 'running', 'waiting')`,
    )
    .run(input.now, input.runId);
  database.prepare('DELETE FROM workflow_waits WHERE run_id = ?').run(input.runId);
  const waiting = database
    .prepare("SELECT id FROM deliveries WHERE run_id = ? AND state IN ('queued', 'retryable')")
    .all(input.runId) as Array<{ id: string }>;
  for (const { id } of waiting) {
    const cancelled = database
      .prepare(
        `UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL, next_at = NULL,
                last_error_code = ?
          WHERE id = ? AND state IN ('queued', 'retryable')`,
      )
      .run(input.state === 'expired' ? 'RUN_EXPIRED' : input.code, id);
    if (cancelled.changes === 1)
      for (const target of removeRetainedDeliveryTargetReference(database, id))
        purgeUnreferencedSystemTargets(database, { ...target, now: input.now });
  }
  let cancelledEvents = 0;
  if (input.state === 'cancelled') {
    database
      .prepare(
        `UPDATE event_deliveries SET state = 'cancelled', lease_until = NULL, next_at = NULL, last_error_code = ?
          WHERE state IN ('queued', 'retryable')
            AND event_id IN (SELECT id FROM workflow_events WHERE run_id = ? AND state = 'open')`,
      )
      .run(input.code, input.runId);
    cancelledEvents = Number(
      database
        .prepare(
          "UPDATE workflow_events SET state = 'cancelled', encrypted_record = NULL WHERE run_id = ? AND state = 'open'",
        )
        .run(input.runId).changes,
    );
  }
  return { cancelledDeliveries: waiting.length, cancelledEvents };
}

/** Which live runs an ending of authority cancels: one workflow's versions, one account's, or every run. */
export type RunScope =
  | { readonly ruleId: string; readonly versions: readonly number[] }
  | { readonly accountId: string; readonly source: string }
  | { readonly all: true };

/**
 * Cancels every live run in `scope` (W10): a version revoked, an account removed, or collection switched off. Called
 * inside the transaction that ends the authority, so no step of such a run can be claimed after it commits.
 */
export function cancelRunsInTransaction(database: DatabaseSync, scope: RunScope, code: string, now: number): number {
  let ids: Array<{ id: string }>;
  if ('all' in scope)
    ids = database
      .prepare("SELECT id FROM workflow_runs WHERE state IN ('held', 'running', 'waiting')")
      .all() as Array<{ id: string }>;
  else if ('ruleId' in scope)
    ids = scope.versions.flatMap(
      (version) =>
        database
          .prepare(
            "SELECT id FROM workflow_runs WHERE rule_id = ? AND rule_version = ? AND state IN ('held', 'running', 'waiting')",
          )
          .all(scope.ruleId, version) as Array<{ id: string }>,
    );
  else
    ids = database
      .prepare(
        `SELECT run.id FROM workflow_runs AS run
          WHERE run.account_id = ? AND run.state IN ('held', 'running', 'waiting')
            AND COALESCE((SELECT json_extract(rule.document, '$.source.channel') FROM rule_versions AS rule
                          WHERE rule.rule_id = run.rule_id AND rule.version = run.rule_version), ?) = ?`,
      )
      .all(scope.accountId, scope.source, scope.source) as Array<{ id: string }>;
  let cancelled = 0;
  for (const { id } of ids)
    if (endRunInTransaction(database, { runId: id, state: 'cancelled', code, now }) !== null) cancelled += 1;
  return cancelled;
}
