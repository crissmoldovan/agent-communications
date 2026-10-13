import { CommsError, canonicalJson } from '@agentcomms/core';
import { TEST_CLOUD_EVENT } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { canonicalFullRuleDocument } from '../domain/activation-documents.ts';
import type { CanonicalJudgeDocument } from '../domain/judges.ts';
import { JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';
import type { EventDatabase } from '../store/database.ts';
import {
  assertPendingRuleJudgeTestAuthority,
  type PendingRuleJudgeTestAuthority,
} from './b3-pending-rule-judge-test.ts';
import {
  assertJudgeReservationStillInFlight,
  beginJudgeTransport,
  JudgeBudgetError,
  releaseJudgeWork,
  reserveJudgeTest,
  settleJudgeWork,
} from './judge-budget.ts';
import { type HostedJudgeCredential, JudgeTransport, prepareJudgeTransportRequest } from './judge-transport.ts';
import type { EventTaintRecorder } from './untrusted.ts';

const TEST_ACCOUNT_ID = 'synthetic-judge-test';
const TEST_EVENT_ID = 'agentcomms-test-v1';
const TEST_QUESTION_NAME = 'judge-test';

interface ActiveRuleAuthority {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly judge: CanonicalJudgeDocument;
  readonly question: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

type JudgeTestAuthority = ActiveRuleAuthority | PendingRuleJudgeTestAuthority;

export type JudgeTestResult =
  | {
      readonly kind: 'completed';
      readonly judgeId: string;
      readonly version: number;
      readonly value: number;
      readonly valueLabel: 'probability' | 'uncalibrated-score';
      readonly reservationId: string;
    }
  | {
      readonly kind: 'refused';
      readonly judgeId: string;
      readonly version: number;
      readonly code: string;
    }
  | {
      readonly kind: 'deferred';
      readonly judgeId: string;
      readonly version: number;
      readonly code: string;
      readonly reservationId: string;
    };

function sameJudge(left: CanonicalJudgeDocument, judgeId: string, version: number): boolean {
  return left.judgeId === judgeId && left.version === version;
}

/**
 * Finds the immutable active rule that grants an ordinary judge test.  A caller cannot choose a prompt, input path,
 * event body or unapproved judge merely by presenting an otherwise valid judge id/version.
 */
function activeRuleAuthority(
  database: EventDatabase['database'],
  judgeId: string,
  version: number,
): ActiveRuleAuthority {
  const rows = database
    .prepare(
      `SELECT rule.rule_id, rule.version, rule.document
         FROM active_versions AS active
         JOIN rule_versions AS rule
           ON active.kind = 'rule' AND active.object_id = rule.rule_id AND active.version = rule.version
        ORDER BY rule.rule_id, rule.version`,
    )
    .all() as Array<{ rule_id: string; version: number; document: string }>;
  for (const row of rows) {
    let rule: CanonicalFullRuleDocument;
    try {
      rule = canonicalFullRuleDocument(JSON.parse(row.document));
    } catch {
      continue;
    }
    const agentic = rule.agentic;
    if (agentic === undefined || !sameJudge(agentic.judge, judgeId, version)) continue;
    return {
      ruleId: row.rule_id,
      ruleVersion: row.version,
      judge: agentic.judge,
      question: agentic.question,
      maxInputTokens: agentic.maxInputTokens,
      maxOutputTokens: agentic.maxOutputTokens,
    };
  }
  throw new JudgeBudgetError('JUDGE_AUTHORITY_CHANGED', 'no active rule grants this exact judge test');
}

function switchGeneration(database: EventDatabase['database']): number {
  const row = database.prepare('SELECT switch_generation FROM event_settings WHERE singleton = 1').get() as
    | { switch_generation: number }
    | undefined;
  return row?.switch_generation ?? 0;
}

function refusal(
  judgeId: string,
  version: number,
  error: unknown,
): Extract<JudgeTestResult, { readonly kind: 'refused' }> {
  const code =
    error instanceof JudgeBudgetError ? error.code : error instanceof CommsError ? error.code : 'JUDGE_TEST_REFUSED';
  return { kind: 'refused', judgeId, version, code };
}

/**
 * Runs the one content-free synthetic judge test through the ordinary taint → durable reservation → sealed
 * transport → settlement path.  It deliberately has no caller-provided state, field selector or prompt override.
 */
export class JudgeTestControl {
  readonly #store: EventDatabase;
  readonly #taint: EventTaintRecorder;
  readonly #transport: JudgeTransport;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #hostedApiKeyFor: (input: {
    readonly judgeId: string;
    readonly judgeVersion: number;
  }) => Promise<HostedJudgeCredential | null>;

  constructor(input: {
    readonly store: EventDatabase;
    readonly taint: EventTaintRecorder;
    readonly transport?: JudgeTransport | undefined;
    readonly now?: (() => number) | undefined;
    readonly newId?: (() => string) | undefined;
    readonly hostedApiKeyFor?:
      | ((input: { readonly judgeId: string; readonly judgeVersion: number }) => Promise<HostedJudgeCredential | null>)
      | undefined;
  }) {
    this.#store = input.store;
    this.#taint = input.taint;
    this.#transport = input.transport ?? new JudgeTransport();
    this.#now = input.now ?? Date.now;
    this.#newId = input.newId ?? (() => crypto.randomUUID());
    this.#hostedApiKeyFor = input.hostedApiKeyFor ?? (async () => null);
  }

  async test(input: { readonly judgeId: string; readonly version: number }): Promise<JudgeTestResult> {
    if (
      typeof input.judgeId !== 'string' ||
      input.judgeId.length === 0 ||
      !Number.isSafeInteger(input.version) ||
      input.version < 1
    )
      throw new CommsError('USAGE', 'judge test needs one exact judge id and positive version');
    let authority: ActiveRuleAuthority;
    try {
      authority = activeRuleAuthority(this.#store.database, input.judgeId, input.version);
    } catch (error) {
      return refusal(input.judgeId, input.version, error);
    }
    return this.#testWithAuthority(input, authority);
  }

  /** The owner calls this only after validating the terminal/app sidecar selector against one pending approval. */
  async testPending(authority: PendingRuleJudgeTestAuthority): Promise<JudgeTestResult> {
    return this.#testWithAuthority({ judgeId: authority.judge.judgeId, version: authority.judge.version }, authority);
  }

  async #testWithAuthority(
    input: { readonly judgeId: string; readonly version: number },
    authority: JudgeTestAuthority,
  ): Promise<JudgeTestResult> {
    // This deliberately records the same ordinary taint phase used by evaluations. The fixed event contains no
    // untrusted observation, so the recorder has nothing content-bearing to persist, but a failed flush still blocks
    // the reservation and network boundary.
    await this.#taint.record({
      eventId: TEST_EVENT_ID,
      accountId: TEST_ACCOUNT_ID,
      classification: { untrusted: [], addresses: [], handles: [] },
    });

    let hostedApiKey: HostedJudgeCredential | undefined;
    if (authority.judge.kind === JUDGE_KIND_TYPESAFE) {
      const key = await this.#hostedApiKeyFor({
        judgeId: authority.judge.judgeId,
        judgeVersion: authority.judge.version,
      });
      if (key === null || !Number.isSafeInteger(key.generation) || key.generation < 1 || key.material.length === 0)
        return { kind: 'refused', judgeId: input.judgeId, version: input.version, code: 'HOSTED_KEY_UNAVAILABLE' };
      hostedApiKey = key;
    }
    const call = {
      judge: authority.judge,
      state: canonicalJson(TEST_CLOUD_EVENT),
      questionName: TEST_QUESTION_NAME,
      instructions: authority.question,
      maxInputTokens: authority.maxInputTokens,
      maxOutputTokens: authority.maxOutputTokens,
      ...(hostedApiKey === undefined ? {} : { hostedApiKey }),
    } as const;
    const prepared = prepareJudgeTransportRequest(call);
    if (!('adapter' in prepared)) {
      if (prepared.kind !== 'refused') throw new Error('a prepared judge transport refusal is malformed');
      return { kind: 'refused', judgeId: input.judgeId, version: input.version, code: prepared.code };
    }

    const reservationId = this.#newId();
    let reservation: ReturnType<typeof reserveJudgeTest>;
    try {
      reservation = reserveJudgeTest({
        store: this.#store,
        id: reservationId,
        workId: `judge-test:${reservationId}`,
        testWorkId: `judge-test:${reservationId}`,
        judge: authority.judge,
        finalEnvelope: prepared.request,
        switchGeneration: switchGeneration(this.#store.database),
        now: this.#now(),
        authority: {
          ruleId: authority.ruleId,
          ruleVersion: authority.ruleVersion,
          ...('activationId' in authority
            ? {
                activationId: authority.activationId,
                approval: authority.challenge,
              }
            : {}),
        },
        // Re-read the active rule or still-pending exact activation inside the reservation transaction after the
        // taint/key awaits. Synthetic tests intentionally do not use that rule's quota fields.
        assertAuthority: (database) => {
          if ('activationId' in authority) {
            const current = assertPendingRuleJudgeTestAuthority({
              database,
              activationId: authority.activationId,
              ruleId: authority.ruleId,
              ruleVersion: authority.ruleVersion,
              judgeId: input.judgeId,
              judgeVersion: input.version,
            });
            if (
              current.question !== authority.question ||
              current.maxInputTokens !== authority.maxInputTokens ||
              current.maxOutputTokens !== authority.maxOutputTokens
            )
              throw new JudgeBudgetError(
                'JUDGE_AUTHORITY_CHANGED',
                'the pending rule authority changed before judge test admission',
              );
            return;
          }
          const current = activeRuleAuthority(database, input.judgeId, input.version);
          if (current.ruleId !== authority.ruleId || current.ruleVersion !== authority.ruleVersion)
            throw new JudgeBudgetError(
              'JUDGE_AUTHORITY_CHANGED',
              'the active rule authority changed before judge test admission',
            );
        },
      });
    } catch (error) {
      return refusal(input.judgeId, input.version, error);
    }
    try {
      if (!beginJudgeTransport({ store: this.#store, reservationId: reservation.id, now: this.#now() }))
        return { kind: 'refused', judgeId: input.judgeId, version: input.version, code: 'JUDGE_AUTHORITY_CHANGED' };
    } catch (error) {
      return refusal(input.judgeId, input.version, error);
    }
    const result = await this.#transport.execute(call, {
      finalGate: () => {
        assertJudgeReservationStillInFlight({
          store: this.#store,
          reservationId: reservation.id,
          now: this.#now(),
          ...(prepared.hostedKeyGeneration === null
            ? {}
            : {
                hostedKey: {
                  judgeId: authority.judge.judgeId,
                  judgeVersion: authority.judge.version,
                  generation: prepared.hostedKeyGeneration,
                },
              }),
        });
        return undefined;
      },
      preparedRequest: prepared,
    });
    if (result.kind === 'answer') {
      settleJudgeWork({
        store: this.#store,
        reservationId: reservation.id,
        result: 'completed',
        actualInputTokens: result.usage.inputTokens,
        now: this.#now(),
      });
      return {
        kind: 'completed',
        judgeId: input.judgeId,
        version: input.version,
        value: result.value,
        valueLabel: result.valueLabel,
        reservationId: reservation.id,
      };
    }
    if (result.preIo) {
      releaseJudgeWork({ store: this.#store, reservationId: reservation.id, now: this.#now(), beforeIo: true });
      return {
        kind: 'deferred',
        judgeId: input.judgeId,
        version: input.version,
        code: result.code,
        reservationId: reservation.id,
      };
    }
    settleJudgeWork({
      store: this.#store,
      reservationId: reservation.id,
      result:
        result.code === 'OUTPUT_TOKEN_LIMIT_EXCEEDED'
          ? 'output-token-limit'
          : result.code === 'NETWORK_DEADLINE_EXCEEDED'
            ? 'timeout'
            : 'transport-failure',
      now: this.#now(),
    });
    return {
      kind: 'deferred',
      judgeId: input.judgeId,
      version: input.version,
      code: result.code,
      reservationId: reservation.id,
    };
  }
}
