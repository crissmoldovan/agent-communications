import { randomBytes, randomUUID } from 'node:crypto';
import { type ApprovalStore, CommsError, type ConfigStore } from '@agentcomms/core';
import {
  FAILURE_OUTCOMES,
  type FlowDocumentV1,
  type FlowStep,
  nextSteps,
  STEP_OUTCOMES,
  type StepId,
  stepOrder,
  unreachableAfter,
} from '@agentcomms/events';
import { type CanonicalFullRuleDocument, canonicalFullRuleDocument } from '../../domain/activation-documents.ts';
import type { EventDatabase } from '../../store/database.ts';
import { isRemovedAccountError } from '../account-fence.ts';
import { assertDisclosable } from '../disclosure-fence.ts';
import type { ProjectionCipher } from '../projections.ts';
import { type WriterQuiescer, withEventWriterLease } from '../writer-quiescer.ts';
import { stepContextFor } from './context.ts';
import {
  type FlowActivationCheck,
  type FlowDeliveryRequest,
  NO_WORKFLOW_EVENTS,
  type Output,
  type PreparedEvents,
  type RunTransition,
  type RunView,
  type StepContext,
  type StepExecutors,
  type StepResult,
  type StepTransition,
  type WaitKind,
  type WorkflowEventSink,
} from './contracts.ts';
import { STEP_KIND_UNAVAILABLE } from './executors.ts';
import { type FlowAnswer, type FlowTestResultV1, TRY_READING_KINDS, tryRetainedFlow } from './flow-test.ts';
import { limitInTransaction } from './limits.ts';
import {
  anyRunMayStartInTransaction,
  type ClaimedStep,
  claimableSteps,
  claimStepInTransaction,
  endRunInTransaction,
  isCurrentStepClaim,
  RUN_STEP_LEASE_MS,
  type RunRow,
  readRun,
  readSteps,
  runViewOf,
  type SettlePlan,
  type StepRow,
  settleStepInTransaction,
  startRunInTransaction,
  stepOutput,
  stepStates,
  takeRunsEndedElsewhere,
} from './runs.ts';
import { insertShadowRecordInTransaction, type PreparedShadowRecord, shadowHandles, shadowStep } from './shadow.ts';
import { SPLIT_OUTCOME } from './steps/split.ts';

/*
 * The workflow engine (workflows design §5, §7): inside the event service's owner, beside the dispatcher, under the same
 * writer lease, driven by the scheduler's tick and woken when something a run waits on changes. One step at a time per
 * branch: claim it (an attempt, a lease token, a lease), fence the version's authority and its account, run it through
 * its kind's executor, and settle it in one transaction that proves the claim is still this attempt's — its outcome,
 * its closed output, the steps it makes ready, the steps it leaves unreachable as skipped, and every transition's
 * ticked events through the sink, prepared before the transaction and written inside it. A run starts in turn as its
 * limits allow and is never dropped; it ends done, failed, cancelled or expired, and its sealed record goes with it.
 */

/** Where a test may stop the engine, as a crash would: after a claim, after an effect, or just before a settle commits. */
export type WorkflowFailpoint = 'after-claim' | 'after-effect' | 'before-settle-commit';

/** `runs cancel`'s result (plan I6). */
export interface RunCancelResultV1 {
  readonly runId: string;
  readonly state: 'cancelled';
  readonly cancelledDeliveries: number;
  readonly cancelledEvents: number;
  readonly interrupted: boolean;
}

/** B4's seam: a deliver step's delivery row, sealed before the settle and inserted inside it. */
export interface FlowDeliveries {
  prepare(input: {
    readonly run: RunView;
    readonly rule: CanonicalFullRuleDocument;
    readonly request: FlowDeliveryRequest;
    readonly context: StepContext;
  }): Promise<{ readonly deliveryId: string }>;
  insertInTransaction(database: EventDatabase['database'], prepared: { readonly deliveryId: string }): void;
}

export interface WorkflowEngineOptions {
  readonly store: EventDatabase;
  readonly cipher: ProjectionCipher;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly executors: StepExecutors;
  readonly sink?: WorkflowEventSink | undefined;
  readonly onRunEnded?: readonly ((run: RunView) => Promise<void>)[] | undefined;
  readonly activationChecks?: readonly FlowActivationCheck[] | undefined;
  /** B3's judging call; until it is composed, every judge fails closed. */
  readonly judge?: StepContext['judge'] | undefined;
  /** B4's deliveries; until they are composed, a deliver step fails closed. */
  readonly deliveries?: FlowDeliveries | undefined;
  /** B6's turn interrupt through the relay, for `runs cancel --interrupt`. */
  readonly interrupt?: ((run: RunView) => Promise<boolean>) | undefined;
  /** The owner's writer lease, held by the ticks a wake starts, as by the scheduler's own. */
  readonly writerQuiescer?: WriterQuiescer | undefined;
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
  readonly leaseMs?: number | undefined;
  /** How many steps one round of a tick claims at most. */
  readonly batch?: number | undefined;
  /** Test seam only: throwing here is a crash at that point. Production never supplies it. */
  readonly failpoint?: ((point: WorkflowFailpoint) => void) | undefined;
}

/** How many rounds of claims one tick makes: a settle that makes a step ready is run in the same tick. */
const ROUNDS_PER_TICK = 16;
/** How many settle plans a step makes before it gives the settle up to a later tick. */
const SETTLE_TRIES = 3;
/** How many times an executor that throws is tried again before its step fails. */
const THROWN_TRIES = 3;
const LIVE = new Set(['ready', 'running', 'waiting']);
const SETTLED = new Set(['done', 'failed', 'skipped', 'cancelled']);

function isAuthorityGone(error: unknown): error is CommsError {
  return error instanceof CommsError && (error.code === 'APPROVAL_VOID' || isRemovedAccountError(error));
}

function reasonOf(error: CommsError): string {
  const reason = error.details?.reason;
  return typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(reason) ? reason : error.code;
}

function isOutputObject(value: unknown): value is Output {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class WorkflowEngine {
  /** Each composition's activation check, which the activation runtime runs after the flow's own. */
  readonly activationChecks: readonly FlowActivationCheck[];
  readonly #store: EventDatabase;
  readonly #cipher: ProjectionCipher;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #executors: StepExecutors;
  readonly #sink: WorkflowEventSink;
  readonly #onRunEnded: readonly ((run: RunView) => Promise<void>)[];
  readonly #judge: StepContext['judge'] | undefined;
  readonly #deliveries: FlowDeliveries | undefined;
  readonly #interrupt: WorkflowEngineOptions['interrupt'];
  readonly #quiescer: WriterQuiescer | undefined;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #leaseMs: number;
  readonly #batch: number;
  readonly #failpoint: WorkflowEngineOptions['failpoint'];
  readonly #rules = new Map<string, CanonicalFullRuleDocument>();
  #queue: Promise<unknown> = Promise.resolve();
  #wakeScheduled = false;

  constructor(options: WorkflowEngineOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#executors = options.executors;
    this.#sink = options.sink ?? NO_WORKFLOW_EVENTS;
    this.#onRunEnded = options.onRunEnded ?? [];
    this.activationChecks = options.activationChecks ?? [];
    this.#judge = options.judge;
    this.#deliveries = options.deliveries;
    this.#interrupt = options.interrupt;
    this.#quiescer = options.writerQuiescer;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => randomBytes(16).toString('hex'));
    this.#leaseMs = options.leaseMs ?? RUN_STEP_LEASE_MS;
    this.#batch = options.batch ?? 100;
    this.#failpoint = options.failpoint;
  }

  /**
   * One pass: expired runs end, held runs start in turn, and every step whose time has come runs and settles. Content
   * expiry runs whatever the switch; nothing is claimed while collection is off or paused. Returns how many steps ran.
   */
  tick(): Promise<number> {
    const work = this.#queue.then(() => this.#tick());
    this.#queue = work.catch(() => undefined);
    return work;
  }

  /** Something a run waits on changed: look again soon, under the owner's writer lease. Never throws. */
  wake(_runId: string): void {
    if (this.#wakeScheduled) return;
    this.#wakeScheduled = true;
    setImmediate(() => {
      this.#wakeScheduled = false;
      const pass = () => this.tick();
      void (this.#quiescer === undefined ? pass() : withEventWriterLease(this.#quiescer, pass)).catch(() => undefined);
    });
  }

  /**
   * The person cancels a live run (§7.6), a tightening, at once: its waiting deliveries and undelivered events are
   * cancelled, its waits dropped and its record purged. Its session's turn is interrupted only when asked.
   */
  cancel(runId: string, input: { readonly interrupt: boolean }): Promise<RunCancelResultV1> {
    const work = this.#queue.then(() => this.#cancel(runId, input));
    this.#queue = work.catch(() => undefined);
    return work;
  }

  /**
   * `workflow test-retained` for a workflow with a flow (§7.7): the person's try on a recent message. A condition, a
   * judge, Which project? and a find answer for real, through this engine's own executors, reading only — a find by
   * thread with the message's own ids; every effect and event is a "would". No run is made and nothing is written.
   */
  tryRetained(input: {
    readonly rule: CanonicalFullRuleDocument;
    readonly event: Record<string, unknown>;
    readonly eventId: string;
  }): Promise<FlowTestResultV1> {
    return tryRetainedFlow({
      rule: input.rule,
      event: input.event,
      eventId: input.eventId,
      answer: this.#answer(input.rule),
      installationId: this.#store.installationId,
      now: this.#now,
    });
  }

  /** A try's reading steps, answered by their executors with a context that charges, fences and keeps nothing. */
  #answer(rule: CanonicalFullRuleDocument): FlowAnswer {
    return async ({ run, message, fields, stepId, step, outputs }) => {
      if (!TRY_READING_KINDS.has(step.kind)) return null;
      try {
        const executor = this.#executors.get(step.kind);
        const context: StepContext = {
          run,
          rule,
          stepId,
          step,
          attempt: { id: 'workflow-try', number: 1 },
          now: this.#now,
          fields: async () => fields,
          trigger: async () => null,
          message: async () => message,
          output: (id) => outputs.get(id) ?? null,
          // A try makes nothing, so nothing counts against a limit.
          charge: () => ({ ok: true }),
          judge: this.#judge ?? (async () => ({ kind: 'failed', code: 'JUDGE_NOT_COMPOSED' })),
          fence: async () => {},
        };
        const result = await executor.run(context);
        return result.kind === 'settled' ? { outcome: result.outcome, output: result.output } : null;
      } catch {
        // A kind not composed here, or one that cannot answer now, takes the outcome named for it, or its first.
        return null;
      }
    };
  }

  async #cancel(runId: string, input: { readonly interrupt: boolean }): Promise<RunCancelResultV1> {
    const row = readRun(this.#store.database, runId);
    if (row === undefined || !['held', 'running', 'waiting'].includes(row.state))
      throw new CommsError('NOT_FOUND', 'no run that is still going has this id', {
        details: { reason: 'RUN_NOT_LIVE' },
      });
    const rule = this.#ruleOf(row);
    const prepared = await this.#sink.prepare([this.#runTransition(row, rule, 'run-cancelled', 'CANCELLED_BY_PERSON')]);
    const ending = this.#store.immediate(() => {
      const ended = endRunInTransaction(this.#store.database, {
        runId,
        state: 'cancelled',
        code: 'CANCELLED_BY_PERSON',
        now: this.#now(),
      });
      if (ended !== null) this.#sink.commitInTransaction(this.#store.database, prepared);
      return ended;
    });
    if (ending === null)
      throw new CommsError('NOT_FOUND', 'no run that is still going has this id', {
        details: { reason: 'RUN_NOT_LIVE' },
      });
    await this.#ended(row, rule, 'cancelled');
    const interrupted =
      input.interrupt && this.#interrupt !== undefined ? await this.#interrupt(runViewOf(row)) : false;
    return { runId, state: 'cancelled', ...ending, interrupted };
  }

  async #tick(): Promise<number> {
    await this.#finishEndedElsewhere();
    await this.#expire();
    if (!this.#collecting()) return 0;
    let ran = 0;
    for (let round = 0; round < ROUNDS_PER_TICK; round += 1) {
      await this.#startHeld();
      const candidates = claimableSteps(this.#store.database, this.#now(), this.#batch);
      let progressed = 0;
      for (const candidate of candidates) {
        try {
          if (await this.#runStep(candidate.runId, candidate.stepId)) progressed += 1;
        } catch {
          // One step's failure never holds back the others: its claim lapses and a later tick claims it again, each
          // claim counted, so a step that always fails ends its run at the step limit.
        }
      }
      ran += progressed;
      if (progressed === 0) break;
    }
    return ran;
  }

  /**
   * The runs an ending of authority cancelled outside the engine — a revocation, disable-all or an account's removal,
   * each in its own transaction, raising no event (W10) — finish here, after that commit: each step they ran gets its
   * executor's `finish`, as a run the engine ends does. Best-effort, whatever the switch: a run still live (its
   * transaction rolled back) is passed over, and a finish that fails changes nothing about the cancel.
   */
  async #finishEndedElsewhere(): Promise<void> {
    for (const id of takeRunsEndedElsewhere(this.#store.database)) {
      try {
        const row = readRun(this.#store.database, id);
        if (row?.state !== 'cancelled') continue;
        await this.#ended(row, this.#ruleOf(row), 'cancelled');
      } catch {
        // A run whose version cannot be read finishes nothing; it stays cancelled.
      }
    }
  }

  #collecting(): boolean {
    const settings = this.#store.database
      .prepare('SELECT enabled, paused FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; paused: number } | undefined;
    return settings?.enabled === 1 && settings.paused === 0;
  }

  /** A run's version, canonical, read once: a run finishes under the version it started on (W10). */
  #ruleOf(row: Pick<RunRow, 'rule_id' | 'rule_version'>): CanonicalFullRuleDocument {
    const key = `${row.rule_id}@${row.rule_version}`;
    const cached = this.#rules.get(key);
    if (cached !== undefined) return cached;
    const stored = this.#store.database
      .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
      .get(row.rule_id, row.rule_version) as { document: string } | undefined;
    if (stored === undefined) throw new CommsError('NOT_FOUND', 'the run’s workflow version is not stored');
    const rule = canonicalFullRuleDocument(JSON.parse(stored.document));
    if (rule.flow === undefined) throw new CommsError('BAD_DATA', 'the run’s workflow version has no flow');
    this.#rules.set(key, rule);
    return rule;
  }

  /** Runs past their deadline end expired (§5): their steps cancelled, their waiting deliveries too, their record purged. */
  async #expire(): Promise<void> {
    const now = this.#now();
    const due = this.#store.database
      .prepare(
        "SELECT id FROM workflow_runs WHERE state IN ('held', 'running', 'waiting') AND expires_at <= ? ORDER BY expires_at, id LIMIT ?",
      )
      .all(now, this.#batch) as Array<{ id: string }>;
    for (const { id } of due) await this.#expireOne(id).catch(() => undefined);
  }

  /** One expired run, on its own: a run that cannot be read holds back no other's expiry. */
  async #expireOne(id: string): Promise<void> {
    const row = readRun(this.#store.database, id);
    if (row === undefined) return;
    const rule = this.#ruleOf(row);
    const prepared = await this.#sink.prepare([this.#runTransition(row, rule, 'run-expired', 'RUN_EXPIRED')]);
    const ended = this.#store.immediate(() => {
      const current = readRun(this.#store.database, id);
      if (current === undefined || current.expires_at > this.#now()) return false;
      const ending = endRunInTransaction(this.#store.database, {
        runId: id,
        state: 'expired',
        code: 'RUN_EXPIRED',
        now: this.#now(),
      });
      if (ending === null) return false;
      this.#sink.commitInTransaction(this.#store.database, prepared);
      return true;
    });
    if (ended) await this.#ended(row, rule, 'expired');
  }

  /**
   * Held runs start in turn, oldest first (§5): each as its workflow's and every workflow's concurrent runs, and its
   * hour's runs, allow. A run held for the first time is announced once; one that starts is announced started.
   */
  async #startHeld(): Promise<void> {
    const database = this.#store.database;
    const held = database
      .prepare("SELECT id FROM workflow_runs WHERE state = 'held' ORDER BY started_at, id LIMIT ?")
      .all(this.#batch) as Array<{ id: string }>;
    for (const { id } of held) {
      if (!anyRunMayStartInTransaction(database)) return;
      await this.#startOne(id).catch(() => undefined);
    }
  }

  /** One held run, on its own: a run that cannot be read holds back no other's start. */
  async #startOne(id: string): Promise<void> {
    const database = this.#store.database;
    const row = readRun(database, id);
    if (row === undefined || row.state !== 'held') return;
    const rule = this.#ruleOf(row);
    const flow = rule.flow as FlowDocumentV1;
    const first = readSteps(database, id).length === 0;
    const now = this.#now();
    // Read only: whether it would start, so a run its hour still holds costs nothing until it frees.
    const own = database
      .prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE rule_id = ? AND state IN ('running', 'waiting')")
      .get(row.rule_id) as { count: number };
    const startable =
      own.count < flow.limits.concurrentRuns && limitInTransaction(database, row.rule_id, 'run', flow.limits, now).ok;
    if (!startable && !first) return;
    const started = startable ? await this.#sink.prepare([this.#runTransition(row, rule, 'run-started', null)]) : null;
    const announced =
      first && !startable ? await this.#sink.prepare([this.#runTransition(row, rule, 'run-held', null)]) : null;
    this.#store.immediate(() => {
      const outcome = startRunInTransaction(database, { runId: id, flow, now: this.#now() });
      if (outcome === 'started' && started !== null) this.#sink.commitInTransaction(database, started);
      if (outcome === 'held-first' && announced !== null) this.#sink.commitInTransaction(database, announced);
    });
  }

  /** One step: claimed, fenced, run through its executor, and settled once. True when it ran. */
  async #runStep(runId: string, stepId: StepId): Promise<boolean> {
    const database = this.#store.database;
    const row = readRun(database, runId);
    if (row === undefined || (row.state !== 'running' && row.state !== 'waiting')) return false;
    const rule = this.#ruleOf(row);
    const flow = rule.flow as FlowDocumentV1;
    const step = flow.steps[stepId];
    if (step === undefined) return false;
    const before = readSteps(database, runId);
    const first = (before.find((entry) => entry.step_id === stepId)?.attempts ?? 0) === 0;
    const startedEvents = first
      ? await this.#sink.prepare([this.#stepTransition(row, rule, before, stepId, 'started', { attempt: 1 })])
      : null;
    const claim = this.#store.immediate(() => {
      const claimed = claimStepInTransaction(database, {
        runId,
        stepId,
        now: this.#now(),
        leaseMs: this.#leaseMs,
        attemptId: this.#newId(),
        leaseToken: this.#newId(),
      });
      if (typeof claimed !== 'string' && claimed.first && startedEvents !== null)
        this.#sink.commitInTransaction(database, startedEvents);
      return claimed;
    });
    if (claim === 'none') return false;
    if (claim === 'step-limit') {
      await this.#endRun(row, rule, 'failed', 'STEP_LIMIT');
      return true;
    }
    this.#failpoint?.('after-claim');
    const fence = () => this.#fence(row);
    try {
      await fence();
    } catch (error) {
      if (isAuthorityGone(error)) await this.#cancelForAuthority(row, rule, reasonOf(error));
      else this.#release(claim);
      return isAuthorityGone(error);
    }
    const outputs = new Map<StepId, Output>();
    for (const entry of before) {
      const output = entry.state === 'done' ? stepOutput(entry) : null;
      if (output !== null) outputs.set(entry.step_id, output);
    }
    const context = stepContextFor({
      store: this.#store,
      cipher: this.#cipher,
      run: runViewOf(row),
      rule,
      stepId,
      step,
      attempt: { id: claim.attemptId, number: claim.attempt },
      now: this.#now,
      sealedRecord: row.encrypted_record,
      outputs,
      judge: this.#judge,
      fence,
    });
    let result: StepResult;
    let shadowRecord: PreparedShadowRecord | null = null;
    try {
      if (row.shadow === 1 && shadowHandles(step)) {
        // A shadow version (§7.7) runs no effect: each becomes a dry-run record, and a wait times out at once.
        const shadowed = await shadowStep({
          cipher: this.#cipher,
          run: runViewOf(row),
          rule,
          stepId,
          step,
          fields: await context.fields(),
          outputs,
          path: this.#path(before, null, false),
          installationId: this.#store.installationId,
          now: this.#now(),
          newDeliveryId: () => randomUUID(),
        });
        result = shadowed.result;
        shadowRecord = shadowed.record;
      } else {
        const executor = this.#executors.get(step.kind);
        result = claim.wake === null ? await executor.run(context) : await executor.resume(context, claim.wake);
      }
    } catch (error) {
      if (isAuthorityGone(error)) {
        await this.#cancelForAuthority(row, rule, reasonOf(error));
        return true;
      }
      result =
        error instanceof CommsError && error.details?.reason === STEP_KIND_UNAVAILABLE
          ? { kind: 'failed', code: STEP_KIND_UNAVAILABLE }
          : claim.attempt < THROWN_TRIES
            ? { kind: 'retry', at: this.#now() + 1_000 * 2 ** claim.attempt, code: 'STEP_THREW' }
            : { kind: 'failed', code: 'STEP_THREW' };
    }
    this.#failpoint?.('after-effect');
    let delivery: { readonly deliveryId: string } | null = null;
    if (result.kind === 'deliver') {
      if (this.#deliveries === undefined || step.kind !== 'deliver')
        result = { kind: 'failed', code: 'DELIVER_NOT_COMPOSED' };
      else {
        delivery = await this.#deliveries.prepare({ run: runViewOf(row), rule, request: result.delivery, context });
      }
    }
    await this.#settle(row, rule, claim, result, delivery, shadowRecord);
    return true;
  }

  /** The engine's fence before each step (§5, step 2): the version's authority and generation, the account, not paused. */
  async #fence(row: RunRow): Promise<void> {
    await assertDisclosable({
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: row.account_id,
      boundary: 'dispatch',
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      switchGeneration: row.switch_generation,
    });
    if (!this.#collecting())
      throw new CommsError('TRANSIENT', 'collection is paused or off', { details: { reason: 'COLLECTION_PAUSED' } });
  }

  /** Gives a claim back unused: the step is as it was, and nothing counts as executed. */
  #release(claim: ClaimedStep): void {
    this.#store.immediate(() => {
      const database = this.#store.database;
      if (!isCurrentStepClaim(database, claim)) return;
      const back = claim.wake === null ? 'ready' : 'waiting';
      database
        .prepare(
          `UPDATE workflow_steps SET state = ?, attempt_id = NULL, lease_token = NULL, lease_until = NULL
            WHERE run_id = ? AND step_id = ? AND attempt_id = ? AND lease_token = ?`,
        )
        .run(back, claim.runId, claim.stepId, claim.attemptId, claim.leaseToken);
      database
        .prepare('UPDATE workflow_runs SET executed_steps = MAX(executed_steps - 1, 0) WHERE id = ?')
        .run(claim.runId);
    });
  }

  /** The settle (§5, step 5): planned from the run's steps as read, committed only if nothing moved since. */
  async #settle(
    row: RunRow,
    rule: CanonicalFullRuleDocument,
    claim: ClaimedStep,
    result: StepResult,
    delivery: { readonly deliveryId: string } | null,
    shadowRecord: PreparedShadowRecord | null = null,
  ): Promise<void> {
    const database = this.#store.database;
    for (let tries = 0; tries < SETTLE_TRIES; tries += 1) {
      const steps = readSteps(database, row.id);
      const planned = this.#plan(row, rule, steps, claim, result, delivery);
      const prepared: PreparedEvents = await this.#sink.prepare(planned.transitions);
      const settled = this.#store.immediate(() => {
        if (!settleStepInTransaction(database, planned.settle)) return false;
        if (delivery !== null) this.#deliveries?.insertInTransaction(database, delivery);
        if (shadowRecord !== null) insertShadowRecordInTransaction(database, row, shadowRecord);
        this.#sink.commitInTransaction(database, prepared);
        this.#failpoint?.('before-settle-commit');
        return true;
      });
      if (settled) {
        if (planned.settle.run.state === 'done' || planned.settle.run.state === 'failed')
          await this.#ended(row, rule, planned.settle.run.state);
        return;
      }
      // Lost to a later attempt, or to the run's end: the settle is dropped. Otherwise a step moved: plan again.
      if (!this.#store.immediate(() => isCurrentStepClaim(database, claim))) return;
    }
  }

  /** What a settle writes and which transitions it raises, from the run's steps as `steps` holds them. */
  #plan(
    row: RunRow,
    rule: CanonicalFullRuleDocument,
    steps: readonly StepRow[],
    claim: ClaimedStep,
    result: StepResult,
    delivery: { readonly deliveryId: string } | null,
  ): { readonly settle: SettlePlan; readonly transitions: readonly StepTransition[] } {
    const flow = rule.flow as FlowDocumentV1;
    const step = flow.steps[claim.stepId] as FlowStep;
    const now = this.#now();
    const states = new Map(steps.map((entry) => [entry.step_id, entry.state as string]));
    const outcomes = new Map(steps.map((entry) => [entry.step_id, entry.outcome]));
    const durationMs = Math.max(0, now - claim.startedAt);
    const transitions: StepTransition[] = [];
    let ready: StepId[] = [];
    let update: SettlePlan['step'];
    const settledResult = this.#checked(step, result);
    switch (settledResult.kind) {
      case 'settled': {
        update = { state: 'done', outcome: settledResult.outcome, output: settledResult.output };
        states.set(claim.stepId, 'done');
        outcomes.set(claim.stepId, settledResult.outcome);
        ready = nextSteps(step, settledResult.outcome).filter((id) => !states.has(id) && flow.steps[id] !== undefined);
        for (const id of ready) states.set(id, 'ready');
        const failure = FAILURE_OUTCOMES[step.kind]?.includes(settledResult.outcome) === true;
        transitions.push(
          this.#stepTransition(row, rule, steps, claim.stepId, failure ? 'failed' : 'succeeded', {
            outcome: settledResult.outcome,
            output: settledResult.output,
            attempt: claim.attempt,
            durationMs,
            settled: true,
          }),
        );
        break;
      }
      case 'failed':
        update = { state: 'failed', code: settledResult.code };
        states.set(claim.stepId, 'failed');
        transitions.push(
          this.#stepTransition(row, rule, steps, claim.stepId, 'failed', {
            attempt: claim.attempt,
            durationMs,
            error: settledResult.code,
            settled: true,
          }),
        );
        break;
      case 'wait': {
        const wakeAt = Math.min(settledResult.wakeAt, row.expires_at);
        update = {
          state: 'waiting',
          wait: { kind: settledResult.wait, key: settledResult.key, wakeAt },
          deliveryId: null,
          output: settledResult.output ?? null,
        };
        states.set(claim.stepId, 'waiting');
        transitions.push(
          this.#stepTransition(row, rule, steps, claim.stepId, 'waiting', {
            attempt: claim.attempt,
            output: settledResult.output ?? null,
            wait: { kind: settledResult.wait, since: now },
          }),
        );
        break;
      }
      case 'deliver':
        update = { state: 'waiting', wait: null, deliveryId: delivery?.deliveryId ?? null, output: null };
        states.set(claim.stepId, 'waiting');
        transitions.push(this.#stepTransition(row, rule, steps, claim.stepId, 'waiting', { attempt: claim.attempt }));
        break;
      case 'retry':
        update = { state: 'ready', nextAt: Math.min(settledResult.at, row.expires_at), code: settledResult.code };
        states.set(claim.stepId, 'ready');
        transitions.push(
          this.#stepTransition(row, rule, steps, claim.stepId, 'retrying', {
            attempt: claim.attempt,
            error: settledResult.code,
            nextAt: settledResult.at,
          }),
        );
        break;
    }
    const live = new Set([...states].filter(([, state]) => LIVE.has(state)).map(([id]) => id));
    const settledIds = new Set([...states].filter(([, state]) => SETTLED.has(state)).map(([id]) => id));
    const skipped = unreachableAfter(flow, live, settledIds);
    for (const id of skipped) {
      states.set(id, 'skipped');
      transitions.push(this.#stepTransition(row, rule, steps, id, 'skipped', {}));
    }
    let run: SettlePlan['run'];
    if (live.size > 0) run = { state: [...live].some((id) => states.get(id) !== 'waiting') ? 'running' : 'waiting' };
    else {
      const failing = [...states].find(([id, state]) => {
        if (state === 'failed') return true;
        const outcome = outcomes.get(id);
        const entry = flow.steps[id];
        return (
          state === 'done' &&
          outcome !== null &&
          outcome !== undefined &&
          entry !== undefined &&
          FAILURE_OUTCOMES[entry.kind]?.includes(outcome) === true &&
          nextSteps(entry, outcome).length === 0
        );
      });
      run =
        failing === undefined
          ? { state: 'done', endCode: null }
          : {
              state: 'failed',
              endCode:
                failing[0] === claim.stepId && update.state === 'failed'
                  ? update.code
                  : (steps.find((entry) => entry.step_id === failing[0])?.last_error_code ?? 'STEP_FAILED'),
            };
      transitions.push(
        this.#runTransition(
          { ...row, executed_steps: row.executed_steps },
          rule,
          run.state === 'done' ? 'run-finished' : 'run-failed',
          run.endCode,
          this.#path(steps, claim.stepId, update.state === 'done' || update.state === 'failed'),
        ),
      );
    }
    return {
      settle: {
        runId: row.id,
        stepId: claim.stepId,
        attemptId: claim.attemptId,
        leaseToken: claim.leaseToken,
        expected: stepStates(steps, claim.stepId),
        step: update,
        ready,
        skipped,
        run,
        now,
      },
      transitions,
    };
  }

  /** A result an executor gave, held to its step: an outcome the step has, and a closed output that is an object. */
  #checked(step: FlowStep, result: StepResult): StepResult {
    if (result.kind !== 'settled') return result;
    const outcomes = step.kind === 'split' ? [SPLIT_OUTCOME] : (STEP_OUTCOMES[step.kind] ?? []);
    if (!outcomes.includes(result.outcome)) return { kind: 'failed', code: 'OUTCOME_UNKNOWN' };
    if (!isOutputObject(result.output)) return { kind: 'failed', code: 'OUTPUT_INVALID' };
    return result;
  }

  /** The run's path so far (W.2): its settled steps in the order they settled, and this one when it settles now. */
  #path(steps: readonly StepRow[], stepId: StepId | null, settlesNow: boolean): readonly StepId[] {
    const path = steps
      .filter((entry) => (entry.state === 'done' || entry.state === 'failed') && entry.settle_seq !== null)
      .sort((left, right) => (left.settle_seq as number) - (right.settle_seq as number))
      .map((entry) => entry.step_id);
    return stepId !== null && settlesNow && !path.includes(stepId) ? [...path, stepId] : path;
  }

  #stepTransition(
    row: RunRow,
    rule: CanonicalFullRuleDocument,
    steps: readonly StepRow[],
    stepId: StepId,
    transition: StepTransition['transition'],
    detail: {
      readonly outcome?: string;
      readonly output?: Output | null;
      readonly attempt?: number;
      readonly durationMs?: number;
      readonly error?: string;
      readonly nextAt?: number;
      readonly wait?: { readonly kind: WaitKind; readonly since: number };
      readonly settled?: boolean;
    },
  ): StepTransition {
    const flow = rule.flow as FlowDocumentV1;
    return {
      run: runViewOf(row),
      rule,
      stepId,
      transition,
      outcome: detail.outcome ?? null,
      output: detail.output ?? null,
      attempt: detail.attempt ?? 0,
      index: stepOrder(flow).indexOf(stepId) + 1,
      path: this.#path(steps, stepId, detail.settled === true),
      durationMs: detail.durationMs ?? null,
      error: detail.error ?? null,
      nextAt: detail.nextAt ?? null,
      wait: detail.wait ?? null,
      at: this.#now(),
    };
  }

  #runTransition(
    row: RunRow,
    rule: CanonicalFullRuleDocument,
    transition: RunTransition,
    endCode: string | null,
    path?: readonly StepId[],
  ): StepTransition {
    return {
      run: runViewOf(row),
      rule,
      stepId: null,
      transition,
      outcome: null,
      output: { steps: row.executed_steps, endCode },
      attempt: 0,
      index: 0,
      path: path ?? this.#path(readSteps(this.#store.database, row.id), null, false),
      durationMs: null,
      error: endCode,
      nextAt: null,
      wait: null,
      at: this.#now(),
    };
  }

  /** Ends a run failed or done outside a settle — its 64 executed steps reached (§7.5) — with its event. */
  async #endRun(row: RunRow, rule: CanonicalFullRuleDocument, state: 'failed', code: string): Promise<void> {
    const prepared = await this.#sink.prepare([this.#runTransition(row, rule, 'run-failed', code)]);
    const ended = this.#store.immediate(() => {
      const database = this.#store.database;
      const changed = database
        .prepare(
          `UPDATE workflow_runs SET state = ?, end_code = ?, encrypted_record = NULL, updated_at = ?
            WHERE id = ? AND state IN ('running', 'waiting')`,
        )
        .run(state, code, this.#now(), row.id);
      if (changed.changes !== 1) return false;
      database
        .prepare(
          `UPDATE workflow_steps SET state = 'cancelled', outcome = NULL, attempt_id = NULL, lease_token = NULL,
                  lease_until = NULL, next_at = NULL, settled_at = ?
            WHERE run_id = ? AND state IN ('ready', 'running', 'waiting')`,
        )
        .run(this.#now(), row.id);
      database.prepare('DELETE FROM workflow_waits WHERE run_id = ?').run(row.id);
      this.#sink.commitInTransaction(database, prepared);
      return true;
    });
    if (ended) await this.#ended(row, rule, state);
  }

  /** A run whose authority is gone (W10): cancelled at once, with no event, since nothing of it may go out. */
  async #cancelForAuthority(row: RunRow, rule: CanonicalFullRuleDocument, code: string): Promise<void> {
    const ended = this.#store.immediate(() =>
      endRunInTransaction(this.#store.database, { runId: row.id, state: 'cancelled', code, now: this.#now() }),
    );
    if (ended !== null) await this.#ended(row, rule, 'cancelled');
  }

  /** After a run ends: each step's executor finishes (a worktree's cleanup), then every composition's hook. Never throws. */
  async #ended(row: RunRow, rule: CanonicalFullRuleDocument, state: 'done' | 'failed' | 'cancelled' | 'expired') {
    const flow = rule.flow as FlowDocumentV1;
    const view = runViewOf(row);
    const steps = readSteps(this.#store.database, row.id);
    const outputs = new Map<StepId, Output>();
    for (const entry of steps) {
      const output = stepOutput(entry);
      if (output !== null) outputs.set(entry.step_id, output);
    }
    for (const entry of steps) {
      if (entry.attempts === 0) continue;
      const step = flow.steps[entry.step_id];
      if (step === undefined) continue;
      try {
        const executor = this.#executors.get(step.kind);
        if (executor.finish === undefined) continue;
        await executor.finish(
          stepContextFor({
            store: this.#store,
            cipher: this.#cipher,
            run: view,
            rule,
            stepId: entry.step_id,
            step,
            attempt: { id: entry.attempt_id ?? '', number: entry.attempts },
            now: this.#now,
            sealedRecord: null,
            outputs,
            judge: this.#judge,
            fence: () => this.#fence(row),
          }),
          state,
        );
      } catch {
        // A finish never throws by contract; one that does leaves the run ended as it is.
      }
    }
    for (const hook of this.#onRunEnded) {
      try {
        await hook(view);
      } catch {
        // A composition's hook is its own; the run has ended whatever it does.
      }
    }
  }
}
