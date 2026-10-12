import { canonicalJson } from '@agentcomms/core';
import {
  catalogueEntry,
  classifyMapped,
  compileMapping,
  evaluateMapping,
  type JsonValue,
  type MappedClassification,
  type MappedValue,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import type { EventDatabase } from '../store/database.ts';
import {
  assertJudgeReservationStillInFlight,
  beginJudgeTransport,
  JudgeBudgetError,
  type JudgeReservation,
  releaseJudgeWork,
  reserveJudgeWork,
  settleJudgeWork,
} from './judge-budget.ts';
import { JudgeTransport, type JudgeTransportResult, prepareJudgeTransportRequest } from './judge-transport.ts';
import { type EventTaintRecorder, sanitiseSenderFields } from './untrusted.ts';

const QUESTION_NAME = 'decision';
const INPUT_ENVELOPE_VERSION = 1;

export interface JudgeInput {
  readonly state: string;
  readonly classification: MappedClassification;
}

/** The sole coordinator-owned request envelope shape a future local adapter may receive. */
export interface JudgeExecutionRequest {
  readonly state: string;
  readonly questionName: string;
  readonly instructions: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/** The bounded answer shape adapters return to the existing coordinator settlement path. */
export interface JudgeAnswer {
  readonly value: number;
  readonly valueLabel: 'probability' | 'uncalibrated-score';
  readonly actualInputTokens: number;
}

export interface JudgeCoordinatorOptions {
  readonly store: EventDatabase;
  readonly taint: EventTaintRecorder;
  readonly transport?: JudgeTransport | undefined;
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
  /** B3's secret slot is read only at the hosted request boundary and is never retained here. */
  readonly hostedApiKeyFor?:
    | ((input: { readonly judgeId: string; readonly judgeVersion: number }) => Promise<string | null>)
    | undefined;
}

export type JudgeCoordinatorResult =
  | {
      readonly kind: 'completed';
      readonly outcome: 'matched' | 'no-match' | 'hold';
      readonly value: number;
      readonly valueLabel: 'probability' | 'uncalibrated-score';
      readonly actualInputTokens: number;
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly reservationId: string;
    }
  | { readonly kind: 'closed'; readonly reason: string; readonly reservationId: string | null }
  /** A pause or pre-I/O authority change leaves its encrypted projection for a resumed evaluator. */
  | { readonly kind: 'deferred'; readonly reservationId: string | null }
  /** Another live reservation owns this projection's only decision and recovery path. */
  | { readonly kind: 'owner-held' }
  | { readonly kind: 'not-applicable' };

function inputTemplate(inputs: readonly string[]): JsonValue {
  return {
    version: INPUT_ENVELOPE_VERSION,
    inputs: inputs.map((pointer) => ({ pointer, value: { $path: pointer } })),
  };
}

/**
 * Builds the judge's typed envelope by running the same mapping/provenance implementation used for external
 * deliveries.  Constants (the version and pointer labels) have constant provenance; copied values retain scalar,
 * parent and subtree provenance from their exact declared input pointers.
 */
export function buildJudgeInput(rule: CanonicalFullRuleDocument, event: Record<string, unknown>): JudgeInput | null {
  const agentic = rule.agentic;
  if (agentic === undefined) return null;
  const found = catalogueEntry(rule.event.type, rule.event.version);
  if (!found.ok) throw new Error(found.issues[0]?.message ?? 'the stored rule event definition is unavailable');
  const compiled = compileMapping(found.value as never, inputTemplate(agentic.inputs));
  if (!compiled.ok) throw new Error(compiled.issues[0]?.message ?? 'the stored judge input mapping is unavailable');
  const sanitised = sanitiseSenderFields(found.value, event);
  const mapped: MappedValue = evaluateMapping(compiled.value, sanitised);
  const classification = classifyMapped(found.value as never, sanitised as never, mapped);
  const state = canonicalJson(mapped.data);
  return { state, classification };
}

function uncertainOutcome(rule: CanonicalFullRuleDocument, value: number): 'matched' | 'no-match' | 'hold' {
  const agentic = rule.agentic;
  if (agentic === undefined) return 'no-match';
  if (value >= agentic.threshold) return 'matched';
  const uncertainFloor = agentic.threshold >= 0.1 ? agentic.threshold - 0.1 : 0;
  return value >= uncertainFloor && agentic.onUncertain === 'hold' ? 'hold' : 'no-match';
}

function closedReason(result: JudgeTransportResult): string {
  if (result.kind === 'answer') return 'completed';
  return result.code.toLowerCase().replaceAll('_', '-');
}

/**
 * The sole agentic execution coordinator.  It owns no ledger transition and no socket path: Task 5's budget
 * functions and Task 6's sealed transport remain the only owners of those effects.
 */
export class JudgeCoordinator {
  readonly #store: EventDatabase;
  readonly #taint: EventTaintRecorder;
  readonly #transport: JudgeTransport;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #hostedApiKeyFor: NonNullable<JudgeCoordinatorOptions['hostedApiKeyFor']>;

  constructor(options: JudgeCoordinatorOptions) {
    this.#store = options.store;
    this.#taint = options.taint;
    this.#transport = options.transport ?? new JudgeTransport();
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#hostedApiKeyFor = options.hostedApiKeyFor ?? (async () => null);
  }

  async evaluate(input: {
    readonly eventId: string;
    readonly accountId: string;
    readonly rule: CanonicalFullRuleDocument;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly event: Record<string, unknown>;
    readonly switchGeneration: number;
  }): Promise<JudgeCoordinatorResult> {
    const agentic = input.rule.agentic;
    if (agentic === undefined) return { kind: 'not-applicable' };
    let envelope: JudgeInput | null;
    try {
      envelope = buildJudgeInput(input.rule, input.event);
    } catch {
      // A stale/incomplete projection must not become a wider judge input, a reservation, or an I/O attempt.
      return { kind: 'closed', reason: 'invalid-judge-input', reservationId: null };
    }
    if (envelope === null) return { kind: 'not-applicable' };

    // Flush is deliberately before the reservation: a failed event-origin taint write has no transport bytes and no
    // durable judge charge.  Callers recheck account/lifecycle after this await before committing a result.
    await this.#taint.record({
      eventId: input.eventId,
      accountId: input.accountId,
      classification: envelope.classification,
    });

    // The hosted key is material only at this boundary.  It participates in the exact request bytes, so a rule never
    // reserves the body while the sealed writer later sends a longer Authorization-bearing HTTP request.
    let hostedApiKey: string | null | undefined;
    try {
      hostedApiKey =
        agentic.judge.kind === 'typesafe'
          ? await this.#hostedApiKeyFor({ judgeId: agentic.judge.judgeId, judgeVersion: agentic.judge.version })
          : undefined;
    } catch {
      return { kind: 'closed', reason: 'hosted-key-unavailable', reservationId: null };
    }
    if (agentic.judge.kind === 'typesafe' && (typeof hostedApiKey !== 'string' || hostedApiKey.length === 0))
      return { kind: 'closed', reason: 'hosted-key-unavailable', reservationId: null };

    const call = {
      judge: agentic.judge,
      state: envelope.state,
      questionName: QUESTION_NAME,
      instructions: agentic.question,
      maxInputTokens: agentic.maxInputTokens,
      maxOutputTokens: agentic.maxOutputTokens,
      ...(hostedApiKey === null || hostedApiKey === undefined ? {} : { hostedApiKey }),
    } as const;
    const prepared = prepareJudgeTransportRequest(call);
    if ('kind' in prepared) return { kind: 'closed', reason: closedReason(prepared), reservationId: null };

    let reservation: JudgeReservation;
    try {
      reservation = reserveJudgeWork({
        store: this.#store,
        id: this.#newId(),
        workId: `judge:${input.eventId}:${input.ruleId}:${input.ruleVersion}`,
        scope: {
          scope: 'source-owned',
          source: input.rule.source.channel,
          accountId: input.accountId,
          eventId: input.eventId,
          ruleId: input.ruleId,
          ruleVersion: input.ruleVersion,
          judgeId: agentic.judge.judgeId,
          judgeVersion: agentic.judge.version,
        },
        judge: agentic.judge,
        limits: {
          callsPerRollingHour: agentic.callsPerRollingHour,
          inputTokensPerRolling30Days: agentic.inputTokensPerRolling30Days,
          concurrency: agentic.concurrency,
          maxInputTokens: agentic.maxInputTokens,
        },
        finalEnvelope: prepared.request,
        switchGeneration: input.switchGeneration,
        now: this.#now(),
      });
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error ? String((error as JudgeBudgetError).code) : 'budget-refused';
      if (code === 'JUDGE_PAUSED') return { kind: 'deferred', reservationId: null };
      if (code === 'JUDGE_WORK_OWNER_HELD') return { kind: 'owner-held' };
      return { kind: 'closed', reason: code, reservationId: null };
    }

    try {
      if (!beginJudgeTransport({ store: this.#store, reservationId: reservation.id, now: this.#now() })) {
        return { kind: 'closed', reason: 'reservation-lost', reservationId: reservation.id };
      }
    } catch (error) {
      if (error instanceof JudgeBudgetError && error.code === 'JUDGE_PAUSED')
        return { kind: 'deferred', reservationId: reservation.id };
      return {
        kind: 'closed',
        reason:
          error instanceof Error && 'code' in error ? String((error as JudgeBudgetError).code) : 'authority-changed',
        reservationId: reservation.id,
      };
    }

    const result = await this.#transport.execute(call, {
      // The sealed transport invokes this synchronous authority recheck directly beside every physical
      // DNS/TCP/TLS/write action; no await can sit between it and that I/O.
      finalGate: () => {
        assertJudgeReservationStillInFlight({ store: this.#store, reservationId: reservation.id });
        return undefined;
      },
      preparedRequest: prepared,
    });

    if (result.kind !== 'answer') {
      if (result.preIo === true) {
        releaseJudgeWork({ store: this.#store, reservationId: reservation.id, now: this.#now(), beforeIo: true });
        return { kind: 'deferred', reservationId: reservation.id };
      }
      const settlement =
        result.code === 'OUTPUT_TOKEN_LIMIT_EXCEEDED'
          ? 'output-token-limit'
          : result.code === 'NETWORK_DEADLINE_EXCEEDED'
            ? 'timeout'
            : 'unknown';
      settleJudgeWork({ store: this.#store, reservationId: reservation.id, result: settlement, now: this.#now() });
      return { kind: 'closed', reason: closedReason(result), reservationId: reservation.id };
    }

    return {
      kind: 'completed',
      outcome: uncertainOutcome(input.rule, result.value),
      value: result.value,
      valueLabel: result.valueLabel,
      actualInputTokens: result.usage.inputTokens,
      reservationId: reservation.id,
      metadata: {
        judgeId: agentic.judge.judgeId,
        judgeVersion: agentic.judge.version,
        provider: agentic.judge.provider,
        model: agentic.judge.model,
        promptTemplate: agentic.judge.promptTemplate,
        threshold: agentic.threshold,
        value: result.value,
        valueLabel: result.valueLabel,
      },
    };
  }
}
