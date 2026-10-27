import type { FlowStep, JsonValue } from '@agentcomms/events';
import type { LinearChangeTargetDocument } from '../../../domain/linear-change-target.ts';
import type { EventDatabase } from '../../../store/database.ts';
import { insertFlowDeliveryInTransaction, type PreparedFlowDelivery, prepareFlowDelivery } from '../../deliveries.ts';
import { linearChangeKinds } from '../../linear-change-dispatcher.ts';
import type { ProjectionCipher } from '../../projections.ts';
import { openRunRecord } from '../context.ts';
import type { FlowDeliveryRequest, Output, StepContext, StepExecutor, StepResult, WakeReason } from '../contracts.ts';
import type { FlowDeliveries } from '../engine.ts';

/*
 * The deliver step (workflows design W5, §5, §6.4; plan B4): it sends to a target version through today's delivery
 * machinery — the claim and its lease, every fence again just before anything leaves, retries, dead letters, the
 * Deliveries screen and the rate cap — by inserting one delivery row of its run and waiting for it to settle. A session
 * target found by `{ flow: true }` gives the turn to the session the flow chose: the first of its named find or start
 * steps whose output holds one. A Linear change acts on the issue the step it names created. What the delivery came to
 * is the step's outcome: delivered is `done`; one left in the Queue or a lane is `left-in-queue`; a dead letter, an
 * expiry, an unreadable record or a cancellation is `failed`. A busy session is no outcome: the delivery waits in the
 * busy queue, and so does the step. A Linear write is charged to the workflow's `linearWritesPerHour` as the step asks
 * for it.
 */

/** The deliveries' settled states that are `failed` (a dead letter, an expiry, an unreadable record, a cancellation). */
const DELIVERED = 'delivered';
const LEFT = new Set(['LEFT_IN_QUEUE', 'LEFT_IN_LANE']);

type DeliverStep = Extract<FlowStep, { kind: 'deliver' }>;

/** The session the flow chose for a deliver step: the first named find or start step whose output holds one. */
function chosenSession(ctx: StepContext, step: DeliverStep): string | null {
  if (step.to === undefined || !('session' in step.to)) return null;
  for (const stepId of step.to.session) {
    const session = ctx.output(stepId)?.session;
    if (typeof session === 'string' && session.length > 0) return session;
  }
  return null;
}

/** The issue a deliver step's `to.issue` names: the one that step's Linear create made, by its output. */
function namedIssue(ctx: StepContext, step: DeliverStep): NonNullable<FlowDeliveryRequest['issue']> | null {
  if (step.to === undefined || !('issue' in step.to)) return null;
  const issue = ctx.output(step.to.issue)?.issue;
  if (typeof issue !== 'object' || issue === null || Array.isArray(issue)) return null;
  const { id, identifier, url } = issue as Readonly<Record<string, JsonValue>>;
  return typeof id === 'string' && typeof identifier === 'string' && typeof url === 'string'
    ? { id, identifier, url }
    : null;
}

interface DeliveryRow {
  readonly id: string;
  readonly target_kind: string;
  readonly state: string;
  readonly last_error_code: string | null;
  readonly last_status: number | null;
  readonly linear_issue_id: string | null;
  readonly linear_identifier: string | null;
  readonly linear_url: string | null;
}

/**
 * The step's closed output for its settled delivery (plan I5), by the delivery's target kind. A Linear change's says
 * what its approved target changes and the state it sets — by name, and by type for its event's word (`closed`).
 */
function deliveredOutput(store: EventDatabase, row: DeliveryRow, change: LinearChangeTargetDocument | null): Output {
  const base = { delivery: row.id };
  switch (row.target_kind) {
    case 'session': {
      const chosen = store.database
        .prepare('SELECT relay_session_id, run_id FROM session_deliveries WHERE delivery_id = ?')
        .get(row.id) as { relay_session_id: string; run_id: string | null } | undefined;
      return { ...base, session: chosen?.relay_session_id ?? null, turn: chosen?.run_id ?? null, ahead: 0 };
    }
    case 'linear':
    case 'linear-change': {
      const issue =
        row.linear_issue_id === null || row.linear_identifier === null || row.linear_url === null
          ? null
          : { id: row.linear_issue_id, identifier: row.linear_identifier, url: row.linear_url };
      if (row.target_kind === 'linear') return { ...base, issue };
      return {
        ...base,
        issue,
        changed: change === null ? [] : [...linearChangeKinds(change)],
        state: change?.state?.name ?? null,
        stateType: change?.state?.type ?? null,
      };
    }
    case 'webhook':
      return { ...base, status: row.last_status };
    default:
      return base;
  }
}

/** What a deliver step's delivery came to (§5), once it has settled. */
function settled(store: EventDatabase, deliveryId: string, ctx: StepContext): StepResult {
  const row = store.database
    .prepare(
      `SELECT id, target_kind, state, last_error_code, last_status, linear_issue_id, linear_identifier, linear_url
         FROM deliveries WHERE id = ?`,
    )
    .get(deliveryId) as DeliveryRow | undefined;
  if (row === undefined) return { kind: 'settled', outcome: 'failed', output: { delivery: deliveryId } };
  const step = ctx.step.kind === 'deliver' ? ctx.step : null;
  const document = step === null ? undefined : targetOf(ctx, step);
  const output = deliveredOutput(store, row, document?.kind === 'linear-change' ? document : null);
  if (row.state === DELIVERED)
    return {
      kind: 'settled',
      outcome: row.last_error_code !== null && LEFT.has(row.last_error_code) ? 'left-in-queue' : 'done',
      output,
    };
  return { kind: 'settled', outcome: 'failed', output };
}

/** The workflow's target version a deliver step names. */
function targetOf(ctx: StepContext, step: DeliverStep) {
  return ctx.rule.targets.find(
    (candidate) => candidate.targetId === step.target.targetId && candidate.version === step.target.version,
  );
}

async function request(ctx: StepContext): Promise<StepResult> {
  if (ctx.step.kind !== 'deliver') return { kind: 'failed', code: 'STEP_KIND_MISMATCH' };
  const step = ctx.step;
  const target = targetOf(ctx, step);
  if (target === undefined) return { kind: 'failed', code: 'TARGET_UNKNOWN' };
  const session = target.kind === 'session' && 'flow' in target.find ? chosenSession(ctx, step) : null;
  if (target.kind === 'session' && 'flow' in target.find && session === null)
    return { kind: 'settled', outcome: 'failed', output: { delivery: null } };
  const issue = target.kind === 'linear-change' ? namedIssue(ctx, step) : null;
  if (target.kind === 'linear-change' && issue === null)
    return { kind: 'settled', outcome: 'failed', output: { delivery: null } };
  // A Linear write counts the workflow's `linearWritesPerHour` (§6, §7.5) once, as its step asks for it; a reached limit
  // holds the step until the window frees, and the delivery's own retries are not further writes.
  if (target.kind === 'linear' || target.kind === 'linear-change') {
    const charged = ctx.charge('linear-write');
    if (!charged.ok) return { kind: 'wait', wait: 'limit', key: null, wakeAt: charged.until };
  }
  return {
    kind: 'deliver',
    delivery: {
      stepId: ctx.stepId,
      target: { targetId: step.target.targetId, version: step.target.version },
      ...(session === null ? {} : { session }),
      ...(issue === null ? {} : { issue }),
      ...(step.report === undefined ? {} : { report: step.report }),
    },
  };
}

/** The deliver step's executor over the event service's store, which holds each delivery's outcome. */
export function createDeliverExecutor(deps: { readonly store: EventDatabase }): StepExecutor<'deliver'> {
  return {
    kind: 'deliver',
    run: request,
    async resume(ctx: StepContext, wake: WakeReason): Promise<StepResult> {
      if (wake.kind === 'delivery') return settled(deps.store, wake.deliveryId, ctx);
      return request(ctx);
    },
  };
}

/**
 * B4's deliveries for the engine: a deliver step's row sealed outside the settle, from the run's sealed record, and
 * inserted inside it.
 */
export function createFlowDeliveries(deps: {
  readonly store: EventDatabase;
  readonly cipher: ProjectionCipher;
  readonly now: () => number;
}): FlowDeliveries {
  return {
    async prepare(input) {
      const record = await openRunRecord(deps.store, deps.cipher, input.run.id);
      if (record === null) throw new Error('the run has ended');
      const row = deps.store.database
        .prepare(
          `SELECT run.decision_id, run.switch_generation, decision.whatsapp_message_id
             FROM workflow_runs AS run JOIN decisions AS decision ON decision.id = run.decision_id
            WHERE run.id = ?`,
        )
        .get(input.run.id) as
        | { decision_id: string; switch_generation: number; whatsapp_message_id: string | null }
        | undefined;
      if (row === undefined) throw new Error('the run has no decision');
      return prepareFlowDelivery({
        cipher: deps.cipher,
        run: {
          id: input.run.id,
          decisionId: row.decision_id,
          accountId: input.run.accountId,
          switchGeneration: row.switch_generation,
          whatsappMessageId: row.whatsapp_message_id,
        },
        rule: input.rule,
        request: input.request,
        record,
        output: (stepId) => input.context.output(stepId),
        installationId: deps.store.installationId,
        now: deps.now(),
      });
    },
    insertInTransaction(database, prepared) {
      insertFlowDeliveryInTransaction(database, prepared as PreparedFlowDelivery);
    },
  };
}
