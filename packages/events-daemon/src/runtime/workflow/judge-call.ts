import { canonicalJson, newBoundary, wrapUntrusted } from '@agentcomms/core';
import type { AgenticConditionV1, JsonValue } from '@agentcomms/events';
import type { CanonicalJudgeDocument, LayaJudgeDocument } from '../../domain/judges.ts';
import { JUDGE_KIND_LAYA, JUDGE_KIND_TYPESAFE } from '../../domain/lifecycle.ts';
import type { EventDatabase } from '../../store/database.ts';
import {
  FLOW_JUDGE_WORK_PREFIX,
  finalizeJudgeTransportRefusal,
  JUDGE_CALL_WINDOW_MS,
  JUDGE_TOKEN_WINDOW_MS,
  JudgeBudgetError,
  type JudgeReservation,
  JudgeReservationIoGate,
  reserveJudgeWork,
  type SourceJudgeWork,
  settleJudgeWork,
} from '../judge-budget.ts';
import { type HostedJudgeCredential, JudgeTransport, prepareJudgeTransportRequest } from '../judge-transport.ts';
import { layaJudgeExecutorFor } from '../laya/worker-supervisor.ts';
import type { JudgeAnswer, StepContext } from './contracts.ts';
import type { JudgedAttempt } from './engine.ts';

/*
 * The one judging call a workflow's steps make (workflows design §6.1, W3; plan B3): a judge step's question, and each
 * of a route's. It charges the workflow's judge exactly as the gate's judge is charged — the same source-owned
 * reservation in the same ledger, under the same budget, kind and provider ceilings, with the same gate beside the one
 * physical I/O — and adds no budget. Its work names the run and step, so its authority is the live run and the judge
 * that step asks. What reaches the provider is the step's inputs alone, each value a sender may have written inside the
 * untrusted envelope. A provider that does not answer is never a yes: it is a failure, which the step reads as unsure.
 */

const QUESTION_NAME = 'decision';
const INPUT_ENVELOPE_VERSION = 1;
/** How soon a judge that waits for a concurrent call, a pause or another owner of its work is asked again. */
const SHORT_WAIT_MS = 30_000;

export interface FlowJudgeDeps {
  readonly store: EventDatabase;
  readonly attempt: JudgedAttempt;
  readonly transport?: JudgeTransport | undefined;
  /** The hosted judge's current key, read only at the request boundary and never kept. */
  readonly hostedApiKeyFor?:
    | ((input: { readonly judgeId: string; readonly judgeVersion: number }) => Promise<HostedJudgeCredential | null>)
    | undefined;
  readonly now: () => number;
  readonly newId?: (() => string) | undefined;
}

/** The judge's typed envelope over the step's inputs: each string inside `wrapUntrusted`'s envelope, by its pointer. */
function inputEnvelope(inputs: Readonly<Record<string, JsonValue>>): string {
  const boundary = newBoundary();
  const wrap = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return wrapUntrusted(value, { field: 'judge-input' }, boundary);
    if (Array.isArray(value)) return value.map(wrap);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, wrap(entry as JsonValue)]));
    return value;
  };
  return canonicalJson({
    version: INPUT_ENVELOPE_VERSION,
    inputs: Object.keys(inputs)
      .sort()
      .map((pointer) => ({ pointer, value: wrap(inputs[pointer] as JsonValue) })),
  });
}

/** The answer a value comes to at the step's bar: yes at it, unsure in the band below it where it holds, else no. */
function said(ask: AgenticConditionV1, value: number): 'yes' | 'no' | 'unsure' {
  if (value >= ask.threshold) return 'yes';
  const floor = ask.threshold >= 0.1 ? ask.threshold - 0.1 : 0;
  return value >= floor && ask.onUncertain === 'hold' ? 'unsure' : 'no';
}

/** When an exhausted budget frees one more call: the oldest charge in its window leaves it. */
function budgetFreesAt(store: EventDatabase, code: string, scope: SourceJudgeWork, provider: string, now: number) {
  const windowMs = code.includes('INPUT_TOKENS') ? JUDGE_TOKEN_WINDOW_MS : JUDGE_CALL_WINDOW_MS;
  const [where, args]: [string, readonly (string | number)[]] = code.startsWith('GLOBAL_')
    ? ['1 = 1', []]
    : code.startsWith('PROVIDER_')
      ? ['provider = ?', [provider]]
      : ['rule_id = ?', [scope.ruleId]];
  const oldest = store.database
    .prepare(
      `SELECT MIN(reserved_at) AS at FROM judge_budget_reservations
        WHERE ${where} AND state IN ('reserved', 'in-flight', 'settled') AND reserved_at >= ?`,
    )
    .get(...args, now - windowMs) as { at: number | null };
  return oldest.at === null ? now + SHORT_WAIT_MS : oldest.at + windowMs + 1;
}

/** A budget refusal: a wait for the window, the concurrent call or the pause; anything else fails closed. */
function refused(
  store: EventDatabase,
  error: unknown,
  scope: SourceJudgeWork,
  provider: string,
  now: number,
): JudgeAnswer {
  const code = error instanceof JudgeBudgetError ? error.code : 'BUDGET_REFUSED';
  if (code.endsWith('_ROLLING_HOUR_EXHAUSTED') || code.endsWith('_ROLLING_30_DAYS_EXHAUSTED'))
    return { kind: 'wait', until: budgetFreesAt(store, code, scope, provider, now) };
  if (code.endsWith('CONCURRENCY_EXHAUSTED') || code === 'JUDGE_PAUSED' || code === 'JUDGE_WORK_OWNER_HELD')
    return { kind: 'wait', until: now + SHORT_WAIT_MS };
  return { kind: 'failed', code };
}

/** The reservation's gate's first refusal, as the step reads it: a pause waits, anything else fails closed. */
function gateRefusal(gate: JudgeReservationIoGate, now: number): JudgeAnswer | null {
  const error = gate.firstGateError;
  if (error === undefined) return null;
  if (error instanceof JudgeBudgetError && error.code === 'JUDGE_PAUSED')
    return { kind: 'wait', until: now + SHORT_WAIT_MS };
  return { kind: 'failed', code: error instanceof JudgeBudgetError ? error.code : 'JUDGE_AUTHORITY_CHANGED' };
}

/** The judging call for one attempt of one step: `StepContext['judge']`. */
export function flowJudge(deps: FlowJudgeDeps): StepContext['judge'] {
  const transport = deps.transport ?? new JudgeTransport();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const { run, stepId, attemptId, switchGeneration, source } = deps.attempt;
  let calls = 0;
  return async (ask, inputs, question) => {
    calls += 1;
    const judge = ask.judge as unknown as CanonicalJudgeDocument;
    const workId = `${FLOW_JUDGE_WORK_PREFIX}${run.id}:${stepId}:${attemptId}:${calls}`;
    const scope: SourceJudgeWork = {
      scope: 'source-owned',
      source,
      accountId: run.accountId,
      eventId: run.eventId,
      ruleId: run.ruleId,
      ruleVersion: run.ruleVersion,
      judgeId: judge.judgeId,
      judgeVersion: judge.version,
    };
    const limits = {
      callsPerRollingHour: ask.callsPerRollingHour,
      inputTokensPerRolling30Days: ask.inputTokensPerRolling30Days,
      concurrency: ask.concurrency,
      maxInputTokens: ask.maxInputTokens,
    };
    const state = inputEnvelope(inputs);
    const instructions = question ?? ask.question;
    const reserve = (finalEnvelope: Uint8Array): JudgeReservation =>
      reserveJudgeWork({
        store: deps.store,
        id: newId(),
        workId,
        scope,
        judge,
        limits,
        finalEnvelope,
        switchGeneration,
        now: deps.now(),
      });
    const answered = (reservationId: string, value: number, inputTokens: number): JudgeAnswer => {
      settleJudgeWork({
        store: deps.store,
        reservationId,
        result: 'completed',
        actualInputTokens: inputTokens,
        now: deps.now(),
      });
      return { kind: 'answer', said: said(ask, value), score: value };
    };

    if (judge.kind === JUDGE_KIND_LAYA) {
      const executor = layaJudgeExecutorFor(deps.store.database);
      if (executor === undefined) return { kind: 'failed', code: 'ADAPTER_REFERENCE_BLOCKED' };
      const laya = executor.prepare({ judge: judge as LayaJudgeDocument, state, instructions });
      if (!laya.ok) return { kind: 'failed', code: laya.code };
      let reservation: JudgeReservation;
      try {
        reservation = reserve(laya.request.body);
      } catch (error) {
        return refused(deps.store, error, scope, judge.provider, deps.now());
      }
      const gate = new JudgeReservationIoGate({
        store: deps.store,
        reservationId: reservation.id,
        judgeKind: judge.kind,
        now: deps.now,
      });
      const result = await executor.execute(laya.request, {
        reservationId: reservation.id,
        finalGate: () => gate.finalGate('write'),
      });
      if (result.kind === 'answer') return answered(reservation.id, result.value, result.inputTokens);
      finalizeJudgeTransportRefusal({
        store: deps.store,
        reservationId: reservation.id,
        result: result.code === 'laya-timeout' ? 'timeout' : 'unknown',
        now: deps.now(),
      });
      return gateRefusal(gate, deps.now()) ?? { kind: 'failed', code: result.code.toUpperCase().replaceAll('-', '_') };
    }

    let hostedApiKey: HostedJudgeCredential | null | undefined;
    if (judge.kind === JUDGE_KIND_TYPESAFE) {
      try {
        hostedApiKey = (await deps.hostedApiKeyFor?.({ judgeId: judge.judgeId, judgeVersion: judge.version })) ?? null;
      } catch {
        hostedApiKey = null;
      }
      if (
        hostedApiKey === null ||
        !Number.isSafeInteger(hostedApiKey.generation) ||
        hostedApiKey.generation < 1 ||
        hostedApiKey.material.length === 0
      )
        return { kind: 'failed', code: 'HOSTED_KEY_UNAVAILABLE' };
    }
    const call = {
      judge,
      state,
      questionName: QUESTION_NAME,
      instructions,
      maxInputTokens: ask.maxInputTokens,
      maxOutputTokens: ask.maxOutputTokens,
      ...(hostedApiKey === null || hostedApiKey === undefined ? {} : { hostedApiKey }),
    } as Parameters<typeof prepareJudgeTransportRequest>[0];
    const prepared = prepareJudgeTransportRequest(call);
    if ('kind' in prepared) return { kind: 'failed', code: prepared.kind === 'refused' ? prepared.code : 'REFUSED' };
    let reservation: JudgeReservation;
    try {
      reservation = reserve(prepared.request);
    } catch (error) {
      return refused(deps.store, error, scope, judge.provider, deps.now());
    }
    const gate = new JudgeReservationIoGate({
      store: deps.store,
      reservationId: reservation.id,
      judgeKind: judge.kind,
      now: deps.now,
      ...(prepared.hostedKeyGeneration === null
        ? {}
        : {
            hostedKey: {
              judgeId: judge.judgeId,
              judgeVersion: judge.version,
              generation: prepared.hostedKeyGeneration,
            },
          }),
    });
    const result = await transport.execute(call, { finalGate: gate.finalGate, preparedRequest: prepared });
    if (result.kind === 'answer') return answered(reservation.id, result.value, result.usage.inputTokens);
    finalizeJudgeTransportRefusal({
      store: deps.store,
      reservationId: reservation.id,
      result:
        result.code === 'OUTPUT_TOKEN_LIMIT_EXCEEDED'
          ? 'output-token-limit'
          : result.code === 'NETWORK_DEADLINE_EXCEEDED'
            ? 'timeout'
            : 'unknown',
      now: deps.now(),
    });
    return gateRefusal(gate, deps.now()) ?? { kind: 'failed', code: result.code };
  };
}
