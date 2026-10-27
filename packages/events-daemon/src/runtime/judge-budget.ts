import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { canonicalFullRuleDocument } from '../domain/activation-documents.ts';
import type { CanonicalJudgeBudgetDocument, CanonicalJudgeDocument, JudgeBudgetLimits } from '../domain/judges.ts';
import { canonicalJudge, JUDGE_BUDGET_ID } from '../domain/judges.ts';
import { JUDGE_KIND_LAYA, JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import type { EventDatabase } from '../store/database.ts';
import type { JudgeWorkScope } from '../store/records.ts';
import { fixedDeadline } from '../store/retention.ts';
import { assertPendingRuleJudgeTestAuthority } from './b3-pending-rule-judge-test.ts';
import type { JudgeTransportPhase } from './judge-transport.ts';

export const JUDGE_MAX_REQUEST_BYTES: number = 65_536;
export const JUDGE_CALL_WINDOW_MS: number = 60 * 60 * 1000;
export const JUDGE_TOKEN_WINDOW_MS: number = 30 * 24 * JUDGE_CALL_WINDOW_MS;
export const JUDGE_TEST_WINDOW_MS: number = JUDGE_CALL_WINDOW_MS;
export const JUDGE_TEST_LIMIT: number = 10;

const ROLLING_STATES = "('reserved', 'in-flight', 'settled')";
const CONCURRENCY_STATES = "('reserved', 'in-flight')";
const GLOBAL_LEDGER_KEY = 'installation';

export type JudgeBudgetErrorCode =
  | 'NO_ACTIVE_BUDGET'
  | 'JUDGE_KIND_DISABLED'
  | 'JUDGE_AUTHORITY_CHANGED'
  | 'JUDGE_PAUSED'
  | 'JUDGE_WORK_OWNER_HELD'
  | 'INPUT_TOKEN_LIMIT_EXCEEDED'
  | 'JUDGE_REQUEST_TOO_LARGE'
  | 'CALLS_PER_ROLLING_HOUR_EXHAUSTED'
  | 'INPUT_TOKENS_PER_ROLLING_30_DAYS_EXHAUSTED'
  | 'CONCURRENCY_EXHAUSTED'
  | 'GLOBAL_CALLS_PER_ROLLING_HOUR_EXHAUSTED'
  | 'GLOBAL_INPUT_TOKENS_PER_ROLLING_30_DAYS_EXHAUSTED'
  | 'GLOBAL_CONCURRENCY_EXHAUSTED'
  | 'PROVIDER_CALLS_PER_ROLLING_HOUR_EXHAUSTED'
  | 'PROVIDER_INPUT_TOKENS_PER_ROLLING_30_DAYS_EXHAUSTED'
  | 'PROVIDER_CONCURRENCY_EXHAUSTED'
  | 'PROVIDER_BUDGET_UNCONFIGURED'
  | 'JUDGE_TEST_RATE_EXHAUSTED';

/** Content-free budget refusal. Callers must not turn request bytes or provider text into its message. */
export class JudgeBudgetError extends Error {
  readonly code: JudgeBudgetErrorCode;

  constructor(code: JudgeBudgetErrorCode, message: string) {
    super(message);
    this.name = 'JudgeBudgetError';
    this.code = code;
  }
}

export interface JudgeWorkLimits extends JudgeBudgetLimits {
  readonly maxInputTokens: number;
}

export type SourceJudgeWork = Extract<JudgeWorkScope, { readonly scope: 'source-owned' }> & {
  readonly eventId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly judgeId: string;
  readonly judgeVersion: number;
};

export type SyntheticJudgeWork = Extract<JudgeWorkScope, { readonly scope: 'synthetic-test' }>;

export interface JudgeReservation {
  readonly id: string;
  readonly workId: string;
  readonly scope: SourceJudgeWork | SyntheticJudgeWork;
  readonly judgeKind: CanonicalJudgeDocument['kind'];
  readonly budgetVersion: number;
  readonly provider: string | null;
  readonly state: 'reserved' | 'in-flight' | 'settled' | 'released';
  readonly estimatedInputTokens: number;
  readonly actualInputTokens: number | null;
  readonly concurrencyOwned: boolean;
  readonly reservedAt: number;
  readonly inFlightAt: number | null;
  readonly settledAt: number | null;
  readonly releasedAt: number | null;
  readonly switchGeneration: number;
}

export interface ReserveJudgeWorkInput {
  readonly store: EventDatabase;
  readonly id: string;
  readonly workId: string;
  readonly scope: SourceJudgeWork;
  /** The immutable, embedded authority whose bytes are re-read from judge_versions in the transaction. */
  readonly judge: CanonicalJudgeDocument;
  /** Rechecked against the canonical rule's agentic fields; this is never a caller override. */
  readonly limits: JudgeWorkLimits;
  /** The exact final, versioned request envelope. UTF-8 bytes are the conservative token estimate. */
  readonly finalEnvelope: Uint8Array;
  readonly switchGeneration: number;
  readonly now: number;
}

export interface ReserveJudgeTestInput {
  readonly store: EventDatabase;
  readonly id: string;
  readonly workId: string;
  readonly testWorkId: string;
  readonly judge: CanonicalJudgeDocument;
  readonly finalEnvelope: Uint8Array;
  readonly switchGeneration: number;
  readonly now: number;
  /**
   * The immutable rule (or, for a pending terminal/app approval, its activation intent) that authorised this
   * synthetic test.  It is stored with the reservation and re-read at every final transport fence.
   */
  readonly authority: {
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly activationId?: string | undefined;
    readonly approval?:
      | {
          readonly approvalId: string;
          readonly hash: string;
          readonly origin: 'terminal' | 'view';
          readonly expiresAt: number | null;
        }
      | undefined;
  };
  /**
   * The operator's active/pending-rule eligibility is not a budget dimension, but it is still authority.  The
   * caller supplies one synchronous, transaction-local check so an await before synthetic-test admission cannot
   * reserve against a rule that was disabled in the meantime.
   */
  readonly assertAuthority?: ((database: DatabaseSync) => void) | undefined;
}

export type JudgeSettlementResult = 'completed' | 'unknown' | 'timeout' | 'transport-failure' | 'output-token-limit';

type JudgeSettlement =
  | { readonly result: 'completed'; readonly actualInputTokens: number }
  | {
      readonly result: Exclude<JudgeSettlementResult, 'completed'>;
      readonly actualInputTokens?: undefined;
    };

export type JudgeBudgetFailpoint =
  | 'after-transport'
  | 'after-response-persistence'
  | 'after-settlement'
  | 'after-terminal-decision'
  | 'after-delivery-insert'
  | 'after-projection-purge'
  | 'before-commit';

interface SettleJudgeWorkBase {
  readonly store: EventDatabase;
  readonly reservationId: string;
  readonly now: number;
  /** Test seam: an exception rolls back the whole terminalisation, leaving one durable in-flight row to recover. */
  readonly testFailpoint?: ((point: JudgeBudgetFailpoint) => void) | undefined;
}

/** A parsed provider usage accompanies only a completed outcome; callers must name every other outcome explicitly. */
export type SettleJudgeWorkInput = SettleJudgeWorkBase & JudgeSettlement;

interface StoredReservation {
  readonly id: string;
  readonly work_id: string;
  readonly work_scope: 'source-owned' | 'synthetic-test';
  readonly source: 'gmail' | 'slack' | 'resend' | 'whatsapp' | null;
  readonly account_id: string | null;
  readonly event_id: string | null;
  readonly rule_id: string | null;
  readonly rule_version: number | null;
  readonly judge_id: string;
  readonly judge_version: number;
  readonly judge_kind: CanonicalJudgeDocument['kind'];
  readonly test_work_id: string | null;
  readonly test_authority_rule_id: string | null;
  readonly test_authority_rule_version: number | null;
  readonly test_authority_activation_id: string | null;
  readonly test_authority_approval_id: string | null;
  readonly test_authority_challenge_hash: string | null;
  readonly test_authority_challenge_origin: 'terminal' | 'view' | null;
  readonly test_authority_challenge_expires_at: number | null;
  readonly budget_version: number;
  readonly provider: string | null;
  readonly state: JudgeReservation['state'];
  readonly estimated_input_tokens: number;
  readonly actual_input_tokens: number | null;
  readonly concurrency_owned: number;
  readonly reserved_at: number;
  readonly in_flight_at: number | null;
  readonly settled_at: number | null;
  readonly released_at: number | null;
  readonly switch_generation: number;
}

interface ActiveBudget {
  readonly version: number;
  readonly document: CanonicalJudgeBudgetDocument;
}

interface Usage {
  readonly calls: number;
  readonly tokens: number;
  readonly concurrency: number;
}

function refusal(code: JudgeBudgetErrorCode, message: string): never {
  throw new JudgeBudgetError(code, message);
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** The one conservative estimate: exact final-envelope UTF-8 bytes, never a provider tokenizer guess. */
export function estimateJudgeInputTokens(finalEnvelope: Uint8Array): number {
  return Buffer.byteLength(finalEnvelope);
}

function assertInputBound(finalEnvelope: Uint8Array, maxInputTokens: number): number {
  if (!positiveInteger(maxInputTokens))
    refusal('INPUT_TOKEN_LIMIT_EXCEEDED', 'the approved input token maximum is invalid');
  const estimate = estimateJudgeInputTokens(finalEnvelope);
  if (estimate > JUDGE_MAX_REQUEST_BYTES)
    refusal('JUDGE_REQUEST_TOO_LARGE', 'the final judge request exceeds the sealed byte limit');
  if (estimate > maxInputTokens)
    refusal('INPUT_TOKEN_LIMIT_EXCEEDED', 'the final judge request exceeds its approved input token maximum');
  return estimate;
}

function activeBudget(database: DatabaseSync): ActiveBudget {
  const active = database
    .prepare("SELECT version FROM active_versions WHERE kind = 'judge-budget' AND object_id = ?")
    .get(JUDGE_BUDGET_ID) as { version: number } | undefined;
  if (active === undefined) refusal('NO_ACTIVE_BUDGET', 'no approved judge budget is active');
  const document = new ImmutableVersions(database).loadJudgeBudget(active.version);
  if (document.version !== active.version || document.budgetId !== JUDGE_BUDGET_ID)
    refusal('NO_ACTIVE_BUDGET', 'the active judge budget does not bind its immutable singleton');
  return { version: active.version, document };
}

function activeKind(database: DatabaseSync, kind: CanonicalJudgeDocument['kind']): void {
  const row = database
    .prepare("SELECT version FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?")
    .get(kind) as { version: number } | undefined;
  if (row === undefined) refusal('JUDGE_KIND_DISABLED', 'the judge kind is disabled');
  try {
    const document = new ImmutableVersions(database).loadJudgeKind(kind, row.version);
    if (document.kind !== kind || document.version !== row.version)
      refusal('JUDGE_KIND_DISABLED', 'the judge kind is unavailable');
  } catch {
    refusal('JUDGE_KIND_DISABLED', 'the judge kind is unavailable');
  }
}

function immutableJudge(database: DatabaseSync, judgeId: string, judgeVersion: number): CanonicalJudgeDocument {
  const row = database
    .prepare('SELECT document, revoked_at FROM judge_versions WHERE judge_id = ? AND version = ?')
    .get(judgeId, judgeVersion) as { document: string; revoked_at: number | null } | undefined;
  if (row === undefined || row.revoked_at !== null)
    refusal('JUDGE_AUTHORITY_CHANGED', 'the immutable judge authority is unavailable');
  try {
    return canonicalJudge(JSON.parse(row.document));
  } catch {
    return refusal('JUDGE_AUTHORITY_CHANGED', 'the immutable judge authority is invalid');
  }
}

function sourceScope(row: StoredReservation): SourceJudgeWork | null {
  if (
    row.work_scope !== 'source-owned' ||
    row.source === null ||
    row.account_id === null ||
    row.event_id === null ||
    row.rule_id === null ||
    row.rule_version === null
  )
    return null;
  return {
    scope: 'source-owned',
    source: row.source,
    accountId: row.account_id,
    eventId: row.event_id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    judgeId: row.judge_id,
    judgeVersion: row.judge_version,
  };
}

/**
 * A workflow step's judging work (workflows plan B3): `flow-judge:<run>:<step>:<attempt>:<call>`. It is source-owned
 * work like the gate's — the same account, event, rule version, budget and ledger — but its authority is the live run
 * and the judge its step asks, since the message's projection was purged when its decision made the run.
 */
export const FLOW_JUDGE_WORK_PREFIX = 'flow-judge:';

/** A live run of this exact source work, and the limits of the judge its step asks, or a refusal. */
function flowJudgeAuthority(
  database: DatabaseSync,
  scope: SourceJudgeWork,
  judge: CanonicalJudgeDocument,
  workId: string,
): JudgeWorkLimits {
  const [runId, stepId] = workId.slice(FLOW_JUDGE_WORK_PREFIX.length).split(':');
  const run = database
    .prepare('SELECT state, account_id, event_id, rule_id, rule_version FROM workflow_runs WHERE id = ?')
    .get(runId ?? '') as
    | { state: string; account_id: string; event_id: string; rule_id: string; rule_version: number }
    | undefined;
  if (
    run === undefined ||
    (run.state !== 'running' && run.state !== 'waiting') ||
    run.account_id !== scope.accountId ||
    run.event_id !== scope.eventId ||
    run.rule_id !== scope.ruleId ||
    run.rule_version !== scope.ruleVersion
  )
    refusal('JUDGE_AUTHORITY_CHANGED', 'the workflow run that asks this judge is no longer live');
  const row = database
    .prepare('SELECT document, state FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(scope.ruleId, scope.ruleVersion) as { document: string; state: string | null } | undefined;
  if (row === undefined || row.state === 'revoked')
    refusal('JUDGE_AUTHORITY_CHANGED', "the workflow run's immutable version is unavailable");
  let rule: CanonicalFullRuleDocument;
  try {
    rule = canonicalFullRuleDocument(JSON.parse(row.document));
  } catch {
    return refusal('JUDGE_AUTHORITY_CHANGED', "the workflow run's immutable version is invalid");
  }
  const step = rule.flow?.steps[stepId ?? ''];
  const asked = step?.kind === 'judge' ? step.ask : step?.kind === 'route' ? step.judge : undefined;
  if (
    asked === undefined ||
    rule.source.channel !== scope.source ||
    !rule.source.accountIds.includes(scope.accountId) ||
    !sameCanonical(asked.judge, judge)
  )
    refusal('JUDGE_AUTHORITY_CHANGED', "the workflow's step no longer asks this judge");
  return {
    callsPerRollingHour: asked.callsPerRollingHour,
    inputTokensPerRolling30Days: asked.inputTokensPerRolling30Days,
    concurrency: asked.concurrency,
    maxInputTokens: asked.maxInputTokens,
  };
}

function ruleAuthority(
  database: DatabaseSync,
  scope: SourceJudgeWork,
  judge: CanonicalJudgeDocument,
  workId?: string,
): JudgeWorkLimits {
  if (workId?.startsWith(FLOW_JUDGE_WORK_PREFIX) === true) return flowJudgeAuthority(database, scope, judge, workId);
  const projection = database
    .prepare(
      `SELECT 1 AS present FROM ingest_rules p
       JOIN ingest i ON i.event_id = p.event_id
       WHERE p.event_id = ? AND p.rule_id = ? AND p.rule_version = ? AND i.account_id = ?`,
    )
    .get(scope.eventId, scope.ruleId, scope.ruleVersion, scope.accountId) as { present: number } | undefined;
  if (projection === undefined)
    refusal('JUDGE_AUTHORITY_CHANGED', 'the source-owned judge projection is no longer live');
  const row = database
    .prepare('SELECT document, state FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(scope.ruleId, scope.ruleVersion) as { document: string; state: string | null } | undefined;
  if (row === undefined || row.state === 'revoked')
    refusal('JUDGE_AUTHORITY_CHANGED', 'the source-owned immutable rule is unavailable');
  let rule: CanonicalFullRuleDocument;
  try {
    rule = canonicalFullRuleDocument(JSON.parse(row.document));
  } catch {
    return refusal('JUDGE_AUTHORITY_CHANGED', 'the source-owned immutable rule is invalid');
  }
  if (
    rule.agentic === undefined ||
    rule.source.channel !== scope.source ||
    !rule.source.accountIds.includes(scope.accountId) ||
    !sameCanonical(rule.agentic.judge, judge)
  )
    refusal('JUDGE_AUTHORITY_CHANGED', 'the source-owned rule no longer grants this judge authority');
  return {
    callsPerRollingHour: rule.agentic.callsPerRollingHour,
    inputTokensPerRolling30Days: rule.agentic.inputTokensPerRolling30Days,
    concurrency: rule.agentic.concurrency,
    maxInputTokens: rule.agentic.maxInputTokens,
  };
}

function providerLimit(document: CanonicalJudgeBudgetDocument, provider: string): JudgeBudgetLimits {
  const found = document.providers.find((entry) => entry.provider === provider);
  if (found === undefined) refusal('PROVIDER_BUDGET_UNCONFIGURED', 'the judge provider has no approved budget ceiling');
  // The canonical document rejects this too.  Recheck beside the live budget use so a damaged persisted document
  // can never turn the E2 worker supervisor into a multi-request path.
  if (provider === JUDGE_KIND_LAYA && found.concurrency > 1)
    refusal('PROVIDER_BUDGET_UNCONFIGURED', 'the Laya provider budget must remain one-at-a-time');
  return found;
}

function usage(database: DatabaseSync, where: string, args: readonly (string | number)[], now: number): Usage {
  const rolling = database
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(COALESCE(actual_input_tokens, estimated_input_tokens)), 0) AS tokens
       FROM judge_budget_reservations
       WHERE ${where} AND state IN ${ROLLING_STATES} AND reserved_at >= ?`,
    )
    .get(...args, now - JUDGE_CALL_WINDOW_MS) as { calls: number; tokens: number };
  const tokens = database
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(actual_input_tokens, estimated_input_tokens)), 0) AS tokens
       FROM judge_budget_reservations
       WHERE ${where} AND state IN ${ROLLING_STATES} AND reserved_at >= ?`,
    )
    .get(...args, now - JUDGE_TOKEN_WINDOW_MS) as { tokens: number };
  const concurrent = database
    .prepare(
      `SELECT COUNT(*) AS count FROM judge_budget_reservations
       WHERE ${where} AND state IN ${CONCURRENCY_STATES} AND concurrency_owned = 1`,
    )
    .get(...args) as { count: number };
  return { calls: rolling.calls, tokens: tokens.tokens, concurrency: concurrent.count };
}

function assertLimit(
  current: Usage,
  limit: JudgeBudgetLimits,
  estimate: number,
  codes: readonly [JudgeBudgetErrorCode, JudgeBudgetErrorCode, JudgeBudgetErrorCode],
  adding: boolean,
): void {
  const increment = adding ? 1 : 0;
  const tokens = current.tokens + (adding ? estimate : 0);
  if (current.calls + increment > limit.callsPerRollingHour)
    refusal(codes[0], 'the approved rolling call ceiling is exhausted');
  if (tokens > limit.inputTokensPerRolling30Days) refusal(codes[1], 'the approved rolling token ceiling is exhausted');
  if (current.concurrency + increment > limit.concurrency)
    refusal(codes[2], 'the approved concurrent-call ceiling is exhausted');
}

function assertReservationLimits(
  database: DatabaseSync,
  input: {
    readonly scope: SourceJudgeWork | SyntheticJudgeWork;
    readonly budget: ActiveBudget;
    readonly judge: CanonicalJudgeDocument;
    readonly limits?: JudgeWorkLimits;
    readonly estimate: number;
    readonly now: number;
    readonly adding: boolean;
  },
): void {
  const global = usage(database, 'global_ledger_key = ?', [GLOBAL_LEDGER_KEY], input.now);
  assertLimit(
    global,
    input.budget.document.global,
    input.estimate,
    [
      'GLOBAL_CALLS_PER_ROLLING_HOUR_EXHAUSTED',
      'GLOBAL_INPUT_TOKENS_PER_ROLLING_30_DAYS_EXHAUSTED',
      'GLOBAL_CONCURRENCY_EXHAUSTED',
    ],
    input.adding,
  );
  if (input.scope.scope === 'synthetic-test') return;
  const limits = input.limits;
  if (limits === undefined) refusal('JUDGE_AUTHORITY_CHANGED', 'the rule limits are unavailable');
  const rule = usage(database, 'rule_id = ?', [input.scope.ruleId], input.now);
  assertLimit(
    rule,
    limits,
    input.estimate,
    ['CALLS_PER_ROLLING_HOUR_EXHAUSTED', 'INPUT_TOKENS_PER_ROLLING_30_DAYS_EXHAUSTED', 'CONCURRENCY_EXHAUSTED'],
    input.adding,
  );
  const provider = usage(database, 'provider = ?', [input.judge.provider], input.now);
  assertLimit(
    provider,
    providerLimit(input.budget.document, input.judge.provider),
    input.estimate,
    [
      'PROVIDER_CALLS_PER_ROLLING_HOUR_EXHAUSTED',
      'PROVIDER_INPUT_TOKENS_PER_ROLLING_30_DAYS_EXHAUSTED',
      'PROVIDER_CONCURRENCY_EXHAUSTED',
    ],
    input.adding,
  );
}

function insertReservation(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly workId: string;
    readonly scope: SourceJudgeWork | SyntheticJudgeWork;
    readonly judge: CanonicalJudgeDocument;
    readonly budgetVersion: number;
    readonly estimate: number;
    readonly switchGeneration: number;
    readonly now: number;
    readonly testAuthority?: ReserveJudgeTestInput['authority'] | undefined;
  },
): JudgeReservation {
  const source = input.scope.scope === 'source-owned' ? input.scope : null;
  const synthetic = input.scope.scope === 'synthetic-test' ? input.scope : null;
  database
    .prepare(
      `INSERT INTO judge_budget_reservations
       (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
        judge_kind, test_work_id, test_authority_rule_id, test_authority_rule_version, test_authority_activation_id,
        test_authority_approval_id, test_authority_challenge_hash, test_authority_challenge_origin,
        test_authority_challenge_expires_at,
        budget_version, provider, global_ledger_key, state, estimated_input_tokens,
        actual_input_tokens, concurrency_owned, reserved_at, in_flight_at, settled_at, released_at, switch_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, 1, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      input.id,
      input.workId,
      input.scope.scope,
      source?.source ?? null,
      source?.accountId ?? null,
      source?.eventId ?? null,
      source?.ruleId ?? null,
      source?.ruleVersion ?? null,
      input.judge.judgeId,
      input.judge.version,
      input.judge.kind,
      synthetic?.testWorkId ?? null,
      input.testAuthority?.ruleId ?? null,
      input.testAuthority?.ruleVersion ?? null,
      input.testAuthority?.activationId ?? null,
      input.testAuthority?.approval?.approvalId ?? null,
      input.testAuthority?.approval?.hash ?? null,
      input.testAuthority?.approval?.origin ?? null,
      input.testAuthority?.approval?.expiresAt ?? null,
      input.budgetVersion,
      source === null ? null : input.judge.provider,
      GLOBAL_LEDGER_KEY,
      input.estimate,
      input.now,
      input.switchGeneration,
    );
  const row = readReservation(database, input.id);
  if (row === null) throw new Error('a just-inserted judge reservation is missing');
  return reservationView(row);
}

function readReservation(database: DatabaseSync, id: string): StoredReservation | null {
  return (
    (database.prepare('SELECT * FROM judge_budget_reservations WHERE id = ?').get(id) as
      | StoredReservation
      | undefined) ?? null
  );
}

function readReservationForSourceWork(
  database: DatabaseSync,
  workId: string,
  scope: SourceJudgeWork,
): StoredReservation | null {
  return (
    (database
      .prepare(
        `SELECT * FROM judge_budget_reservations
          WHERE work_id = ? AND work_scope = 'source-owned' AND source = ? AND account_id = ?
            AND event_id = ? AND rule_id = ? AND rule_version = ? AND state IN ('reserved', 'in-flight')`,
      )
      .get(workId, scope.source, scope.accountId, scope.eventId, scope.ruleId, scope.ruleVersion) as
      | StoredReservation
      | undefined) ?? null
  );
}

function reservationView(row: StoredReservation): JudgeReservation {
  const scope = sourceScope(row);
  if (scope === null) {
    if (row.test_work_id === null) throw new Error('a synthetic judge reservation lacks its work identity');
    return {
      id: row.id,
      workId: row.work_id,
      scope: {
        scope: 'synthetic-test',
        testWorkId: row.test_work_id,
        judgeId: row.judge_id,
        judgeVersion: row.judge_version,
      },
      judgeKind: row.judge_kind,
      budgetVersion: row.budget_version,
      provider: row.provider,
      state: row.state,
      estimatedInputTokens: row.estimated_input_tokens,
      actualInputTokens: row.actual_input_tokens,
      concurrencyOwned: row.concurrency_owned === 1,
      reservedAt: row.reserved_at,
      inFlightAt: row.in_flight_at,
      settledAt: row.settled_at,
      releasedAt: row.released_at,
      switchGeneration: row.switch_generation,
    };
  }
  return {
    id: row.id,
    workId: row.work_id,
    scope,
    judgeKind: row.judge_kind,
    budgetVersion: row.budget_version,
    provider: row.provider,
    state: row.state,
    estimatedInputTokens: row.estimated_input_tokens,
    actualInputTokens: row.actual_input_tokens,
    concurrencyOwned: row.concurrency_owned === 1,
    reservedAt: row.reserved_at,
    inFlightAt: row.in_flight_at,
    settledAt: row.settled_at,
    releasedAt: row.released_at,
    switchGeneration: row.switch_generation,
  };
}

function assertReservationAuthority(
  database: DatabaseSync,
  row: StoredReservation,
  now: number,
): { readonly budget: ActiveBudget; readonly judge: CanonicalJudgeDocument; readonly limits?: JudgeWorkLimits } {
  const budget = activeBudget(database);
  if (budget.version !== row.budget_version)
    refusal('JUDGE_AUTHORITY_CHANGED', 'the approved judge budget pointer changed before transport');
  const judge = immutableJudge(database, row.judge_id, row.judge_version);
  if (judge.kind !== row.judge_kind || (row.provider !== null && judge.provider !== row.provider))
    refusal('JUDGE_AUTHORITY_CHANGED', 'the durable judge authority no longer agrees with its reservation');
  activeKind(database, judge.kind);
  const scope = sourceScope(row);
  if (scope === null) {
    assertSyntheticTestAuthority(database, row, judge, now);
    return { budget, judge };
  }
  return { budget, judge, limits: ruleAuthority(database, scope, judge, row.work_id) };
}

/** The durable test binding is a real transport authority, not merely admission bookkeeping. */
function assertSyntheticTestAuthority(
  database: DatabaseSync,
  row: StoredReservation,
  judge: CanonicalJudgeDocument,
  now: number,
): void {
  if (row.test_authority_rule_id === null || row.test_authority_rule_version === null)
    refusal('JUDGE_AUTHORITY_CHANGED', 'the synthetic judge test authority is unavailable');
  if (row.test_authority_activation_id !== null) {
    try {
      const pending = assertPendingRuleJudgeTestAuthority({
        database,
        activationId: row.test_authority_activation_id,
        ruleId: row.test_authority_rule_id,
        ruleVersion: row.test_authority_rule_version,
        judgeId: row.judge_id,
        judgeVersion: row.judge_version,
      });
      if (!sameCanonical(pending.judge, judge))
        refusal('JUDGE_AUTHORITY_CHANGED', 'the pending rule no longer grants this judge authority');
      const challenge = database
        .prepare(
          'SELECT state, origin, challenge_hash, expires_at FROM activation_view_challenges WHERE approval_id = ?',
        )
        .get(row.test_authority_approval_id) as
        | {
            readonly state: string;
            readonly origin: string;
            readonly challenge_hash: string | null;
            readonly expires_at: number | null;
          }
        | undefined;
      if (
        row.test_authority_approval_id === null ||
        row.test_authority_challenge_hash === null ||
        row.test_authority_challenge_origin === null ||
        challenge === undefined ||
        challenge.state !== 'active' ||
        challenge.origin !== row.test_authority_challenge_origin ||
        challenge.challenge_hash !== row.test_authority_challenge_hash ||
        (row.test_authority_challenge_origin === 'terminal'
          ? challenge.expires_at !== null || row.test_authority_challenge_expires_at !== null
          : challenge.expires_at === null ||
            challenge.expires_at !== row.test_authority_challenge_expires_at ||
            challenge.expires_at <= now)
      )
        refusal('JUDGE_AUTHORITY_CHANGED', 'the pending approval challenge is no longer live');
      return;
    } catch (error) {
      if (error instanceof JudgeBudgetError) throw error;
      refusal('JUDGE_AUTHORITY_CHANGED', 'the pending rule authority is unavailable');
    }
  }
  const active = database
    .prepare("SELECT 1 AS present FROM active_versions WHERE kind = 'rule' AND object_id = ? AND version = ?")
    .get(row.test_authority_rule_id, row.test_authority_rule_version) as { present: number } | undefined;
  if (active === undefined) refusal('JUDGE_AUTHORITY_CHANGED', 'the synthetic judge test rule is no longer active');
  const rule = database
    .prepare('SELECT document, state FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(row.test_authority_rule_id, row.test_authority_rule_version) as
    | { document: string; state: string | null }
    | undefined;
  if (rule === undefined || rule.state === 'revoked')
    refusal('JUDGE_AUTHORITY_CHANGED', 'the synthetic judge test rule is unavailable');
  try {
    const document = canonicalFullRuleDocument(JSON.parse(rule.document));
    if (document.agentic === undefined || !sameCanonical(document.agentic.judge, judge))
      refusal('JUDGE_AUTHORITY_CHANGED', 'the synthetic judge test rule no longer grants this judge');
  } catch (error) {
    if (error instanceof JudgeBudgetError) throw error;
    refusal('JUDGE_AUTHORITY_CHANGED', 'the synthetic judge test rule is invalid');
  }
}

/** Reserves source-owned work inside the real ledger before a caller may enter a transport boundary. */
export function reserveJudgeWork(input: ReserveJudgeWorkInput): JudgeReservation {
  const estimate = assertInputBound(input.finalEnvelope, input.limits.maxInputTokens);
  return input.store.immediate(() => {
    const budget = activeBudget(input.store.database);
    const judge = immutableJudge(input.store.database, input.scope.judgeId, input.scope.judgeVersion);
    if (!sameCanonical(judge, input.judge))
      refusal('JUDGE_AUTHORITY_CHANGED', 'the supplied judge differs from its immutable stored authority');
    activeKind(input.store.database, judge.kind);
    const limits = ruleAuthority(input.store.database, input.scope, judge, input.workId);
    if (!sameCanonical(limits, input.limits))
      refusal('JUDGE_AUTHORITY_CHANGED', 'the supplied limits differ from the immutable rule authority');
    const prior = readReservationForSourceWork(input.store.database, input.workId, input.scope);
    if (prior !== null) refusal('JUDGE_WORK_OWNER_HELD', 'a live judge reservation already owns this source work');
    assertReservationLimits(input.store.database, {
      scope: input.scope,
      budget,
      judge,
      limits,
      estimate,
      now: input.now,
      adding: true,
    });
    return insertReservation(input.store.database, { ...input, judge, budgetVersion: budget.version, estimate });
  });
}

/** Reserves synthetic judge-test work against only the active global ledger and its exact-version test charge. */
export function reserveJudgeTest(input: ReserveJudgeTestInput): JudgeReservation {
  const estimate = assertInputBound(input.finalEnvelope, JUDGE_MAX_REQUEST_BYTES);
  return input.store.immediate(() => {
    const pendingApprovalInvalid = (() => {
      if (input.authority.activationId === undefined) return false;
      const approval = input.authority.approval;
      return (
        typeof input.authority.activationId !== 'string' ||
        input.authority.activationId.length === 0 ||
        approval === undefined ||
        approval.approvalId.length === 0 ||
        !/^[a-f0-9]{64}$/u.test(approval.hash) ||
        (approval.origin === 'terminal'
          ? approval.expiresAt !== null
          : !Number.isSafeInteger(approval.expiresAt) || (approval.expiresAt as number) <= input.now)
      );
    })();
    if (
      typeof input.authority.ruleId !== 'string' ||
      input.authority.ruleId.length === 0 ||
      !positiveInteger(input.authority.ruleVersion) ||
      pendingApprovalInvalid
    )
      refusal('JUDGE_AUTHORITY_CHANGED', 'the synthetic judge test authority is invalid');
    input.assertAuthority?.(input.store.database);
    const budget = activeBudget(input.store.database);
    const judge = immutableJudge(input.store.database, input.judge.judgeId, input.judge.version);
    if (!sameCanonical(judge, input.judge))
      refusal('JUDGE_AUTHORITY_CHANGED', 'the supplied judge differs from its immutable stored authority');
    activeKind(input.store.database, judge.kind);
    const prior = input.store.database
      .prepare(
        'SELECT COUNT(*) AS count FROM judge_test_charges WHERE judge_id = ? AND judge_version = ? AND charged_at >= ?',
      )
      .get(judge.judgeId, judge.version, input.now - JUDGE_TEST_WINDOW_MS) as { count: number };
    if (prior.count >= JUDGE_TEST_LIMIT)
      refusal('JUDGE_TEST_RATE_EXHAUSTED', 'this immutable judge version has exhausted its rolling test ceiling');
    const scope: SyntheticJudgeWork = {
      scope: 'synthetic-test',
      testWorkId: input.testWorkId,
      judgeId: judge.judgeId,
      judgeVersion: judge.version,
    };
    assertReservationLimits(input.store.database, { scope, budget, judge, estimate, now: input.now, adding: true });
    input.store.database
      .prepare('INSERT INTO judge_test_charges (judge_id, judge_version, charged_at, work_id) VALUES (?, ?, ?, ?)')
      .run(judge.judgeId, judge.version, input.now, input.workId);
    return insertReservation(input.store.database, {
      ...input,
      scope,
      judge,
      budgetVersion: budget.version,
      estimate,
      testAuthority: input.authority,
    });
  });
}

/** Final pre-I/O gate. A refusal releases the provisional reservation in the same transaction and returns false. */
export function beginJudgeTransport(input: {
  readonly store: EventDatabase;
  readonly reservationId: string;
  readonly now: number;
  readonly hostedKey?: Readonly<{ judgeId: string; judgeVersion: number; generation: number }> | undefined;
  readonly assertBeforeTransition?: (() => void) | undefined;
}): boolean {
  let refused = false;
  let refusalError: unknown;
  const began = input.store.immediate(() => {
    const row = readReservation(input.store.database, input.reservationId);
    if (row === null || row.state !== 'reserved') return false;
    try {
      const authority = assertReservationAuthority(input.store.database, row, input.now);
      const source = sourceScope(row);
      const scope =
        source ??
        ({
          scope: 'synthetic-test' as const,
          testWorkId: row.test_work_id as string,
          judgeId: row.judge_id,
          judgeVersion: row.judge_version,
        } satisfies SyntheticJudgeWork);
      if (source !== null) assertSourceReservationBoundary(input.store.database, source, row.switch_generation);
      assertReservationLimits(input.store.database, {
        scope,
        budget: authority.budget,
        judge: authority.judge,
        ...(authority.limits === undefined ? {} : { limits: authority.limits }),
        estimate: row.estimated_input_tokens,
        now: input.now,
        adding: false,
      });
      assertHostedKeyGeneration(input.store.database, row, input.hostedKey);
      input.assertBeforeTransition?.();
    } catch (error) {
      releaseReservationInTransaction(input.store.database, row.id, input.now);
      refused = true;
      refusalError = error;
      return false;
    }
    return (
      input.store.database
        .prepare(
          `UPDATE judge_budget_reservations
           SET state = 'in-flight', in_flight_at = ?
           WHERE id = ? AND state = 'reserved' AND concurrency_owned = 1`,
        )
        .run(input.now, row.id).changes === 1
    );
  });
  if (refused) throw refusalError;
  return began;
}

/**
 * Couples the durable I/O transition to the sealed transport's synchronous gate. Hosted work enters at DNS; a
 * literal-loopback judge has no DNS action and enters at TCP. Every later gate rechecks the complete live authority.
 */
export class JudgeReservationIoGate {
  readonly #store: EventDatabase;
  readonly #reservationId: string;
  readonly #judgeKind: CanonicalJudgeDocument['kind'];
  readonly #now: () => number;
  readonly #hostedKey: Readonly<{ judgeId: string; judgeVersion: number; generation: number }> | undefined;
  #entered = false;
  #firstGateError: unknown | undefined;

  constructor(input: {
    readonly store: EventDatabase;
    readonly reservationId: string;
    readonly judgeKind: CanonicalJudgeDocument['kind'];
    readonly now: () => number;
    readonly hostedKey?: Readonly<{ judgeId: string; judgeVersion: number; generation: number }> | undefined;
  }) {
    this.#store = input.store;
    this.#reservationId = input.reservationId;
    this.#judgeKind = input.judgeKind;
    this.#now = input.now;
    this.#hostedKey = input.hostedKey;
  }

  get firstGateError(): unknown | undefined {
    return this.#firstGateError;
  }

  finalGate = (phase: JudgeTransportPhase, assertBeforeTransition?: () => void): undefined => {
    // Hosted work enters at DNS and a literal-loopback judge at TCP. A Laya request's only physical I/O is the one
    // write of its frame to the isolated worker, so it enters there.
    const firstPhysicalPhase: JudgeTransportPhase =
      this.#judgeKind === JUDGE_KIND_TYPESAFE ? 'dns' : this.#judgeKind === JUDGE_KIND_LAYA ? 'write' : 'tcp';
    if (!this.#entered) {
      if (phase !== firstPhysicalPhase) {
        assertBeforeTransition?.();
        return undefined;
      }
      let deadlineRefused = false;
      try {
        if (
          !beginJudgeTransport({
            store: this.#store,
            reservationId: this.#reservationId,
            now: this.#now(),
            ...(this.#hostedKey === undefined ? {} : { hostedKey: this.#hostedKey }),
            assertBeforeTransition: () => {
              try {
                assertBeforeTransition?.();
              } catch (error) {
                deadlineRefused = true;
                throw error;
              }
            },
          })
        )
          refusal('JUDGE_AUTHORITY_CHANGED', 'the judge reservation was lost before physical I/O');
      } catch (error) {
        if (!deadlineRefused) this.#firstGateError = error;
        throw error;
      }
      this.#entered = true;
      return undefined;
    }
    assertJudgeReservationStillInFlight({
      store: this.#store,
      reservationId: this.#reservationId,
      now: this.#now(),
      ...(this.#hostedKey === undefined ? {} : { hostedKey: this.#hostedKey }),
    });
    assertBeforeTransition?.();
    return undefined;
  };
}

/**
 * The synchronous final transport/decision fence.  It reuses the one reservation authority reader rather than
 * manufacturing a second reservation path, and is safe to call immediately beside each Task-6 I/O action.
 */
export function assertJudgeReservationInFlightInTransaction(
  database: DatabaseSync,
  reservationId: string,
  now: number = Date.now(),
  hostedKey?: Readonly<{ judgeId: string; judgeVersion: number; generation: number }> | undefined,
): void {
  const row = readReservation(database, reservationId);
  if (row === null || row.state !== 'in-flight' || row.concurrency_owned !== 1)
    refusal('JUDGE_AUTHORITY_CHANGED', 'the judge reservation is no longer in flight');
  assertReservationAuthority(database, row, now);
  assertHostedKeyGeneration(database, row, hostedKey);
  const scope = sourceScope(row);
  if (scope === null) return;
  assertSourceReservationBoundary(database, scope, row.switch_generation);
}

function assertHostedKeyGeneration(
  database: DatabaseSync,
  row: StoredReservation,
  hostedKey: Readonly<{ judgeId: string; judgeVersion: number; generation: number }> | undefined,
): void {
  if (hostedKey === undefined) return;
  if (row.judge_id !== hostedKey.judgeId || row.judge_version !== hostedKey.judgeVersion)
    refusal('JUDGE_AUTHORITY_CHANGED', 'the hosted judge key does not belong to this reservation');
  const current = database
    .prepare(
      `SELECT 1 AS present
         FROM event_secret_generations AS generation
         JOIN judge_versions AS judge
           ON judge.judge_id = generation.owner_id AND judge.version = generation.owner_version
        WHERE generation.owner_kind = 'judge' AND generation.purpose = 'judge-key'
          AND generation.owner_id = ? AND generation.owner_version = ? AND generation.generation = ?
          AND generation.lifecycle = 'current' AND generation.owner_digest = judge.digest
          AND judge.revoked_at IS NULL`,
    )
    .get(hostedKey.judgeId, hostedKey.judgeVersion, hostedKey.generation);
  if (current === undefined) refusal('JUDGE_AUTHORITY_CHANGED', 'the hosted judge key generation is no longer current');
}

function assertSourceReservationBoundary(
  database: DatabaseSync,
  scope: SourceJudgeWork,
  switchGeneration: number,
): void {
  const settings = database
    .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
    .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
  if (settings?.paused === 1) refusal('JUDGE_PAUSED', 'the event switch is paused before the judge boundary');
  if (settings?.enabled !== 1 || settings.switch_generation !== switchGeneration)
    refusal('JUDGE_AUTHORITY_CHANGED', 'the event switch changed before the judge boundary');
  const revoked = database
    .prepare(
      `SELECT 1 AS present FROM account_revocations
        WHERE account_id = ? AND (source IS NULL OR source = ?)`,
    )
    .get(scope.accountId, scope.source);
  if (revoked !== undefined)
    refusal('JUDGE_AUTHORITY_CHANGED', 'the event account was removed before the judge boundary');
}

export function assertJudgeReservationStillInFlight(input: {
  readonly store: EventDatabase;
  readonly reservationId: string;
  readonly now?: number | undefined;
  readonly hostedKey?: Readonly<{ judgeId: string; judgeVersion: number; generation: number }> | undefined;
}): void {
  input.store.immediate(() => {
    assertJudgeReservationInFlightInTransaction(input.store.database, input.reservationId, input.now, input.hostedKey);
  });
}

function releaseReservationInTransaction(database: DatabaseSync, reservationId: string, now: number): boolean {
  return (
    database
      .prepare(
        `UPDATE judge_budget_reservations
         SET state = 'released', concurrency_owned = 0, released_at = ?
         WHERE id = ? AND concurrency_owned = 1 AND state = 'reserved'`,
      )
      .run(now, reservationId).changes === 1
  );
}

/** Pre-I/O loss is free. Only a provisional reserved attempt may enter the terminal released state. */
export function releaseJudgeWork(input: {
  readonly store: EventDatabase;
  readonly reservationId: string;
  readonly now: number;
}): boolean {
  return input.store.immediate(() =>
    releaseReservationInTransaction(input.store.database, input.reservationId, input.now),
  );
}

function terminalReason(result: JudgeSettlementResult): string | null {
  if (result === 'unknown' || result === 'timeout' || result === 'transport-failure') return 'judge-io-unknown';
  if (result === 'output-token-limit') return 'output-token-limit-exceeded';
  return null;
}

function terminaliseSourceWork(database: DatabaseSync, row: StoredReservation, reason: string, now: number): void {
  const scope = sourceScope(row);
  if (scope === null) return;
  const rule = database
    .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(scope.ruleId, scope.ruleVersion) as { document: string } | undefined;
  if (rule !== undefined) {
    try {
      const document = canonicalFullRuleDocument(JSON.parse(rule.document));
      database
        .prepare(
          `INSERT OR IGNORE INTO decisions
           (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
           SELECT ?, i.event_id, i.account_id, ?, ?, 'no-match', ?, ?
           FROM ingest i JOIN ingest_rules p ON p.event_id = i.event_id
           WHERE i.event_id = ? AND i.account_id = ? AND p.rule_id = ? AND p.rule_version = ?`,
        )
        .run(
          `judge:${row.id}`,
          scope.ruleId,
          scope.ruleVersion,
          fixedDeadline(now, document.retention.decisionMetadataMs),
          reason,
          scope.eventId,
          scope.accountId,
          scope.ruleId,
          scope.ruleVersion,
        );
    } catch {
      // Authority may have been removed by a tightening. A recovery must never recreate a purged projection just to
      // manufacture a decision, and the settled reservation remains the durable audit of the billed uncertainty.
    }
  }
  database
    .prepare('DELETE FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
    .run(scope.eventId, scope.ruleId, scope.ruleVersion);
}

export function settleReservationInTransaction(
  database: DatabaseSync,
  input: {
    readonly reservationId: string;
    readonly now: number;
    readonly testFailpoint?: ((point: JudgeBudgetFailpoint) => void) | undefined;
  } & JudgeSettlement,
): boolean {
  const row = readReservation(database, input.reservationId);
  if (row === null) return false;
  input.testFailpoint?.('after-transport');
  // Response content is deliberately not persisted here. The response-owning coordinator writes its encrypted
  // decision in Task 7; this primitive owns only the content-free failure closure.
  input.testFailpoint?.('after-response-persistence');
  // A parsed provider answer is the only evidence that can replace the durable reservation estimate.  Every other
  // post-write result remains unknown, even if an upstream caller supplies a number; retaining NULL charges the
  // estimate through the rolling-ledger COALESCE and can never under-charge the provider's reported usage.
  const actual =
    input.result === 'completed' && safeNonNegativeInteger(input.actualInputTokens) ? input.actualInputTokens : null;
  const changed = database
    .prepare(
      `UPDATE judge_budget_reservations
       SET state = 'settled', actual_input_tokens = ?, concurrency_owned = 0, settled_at = ?
       WHERE id = ? AND state = 'in-flight' AND concurrency_owned = 1`,
    )
    .run(actual, input.now, row.id).changes;
  if (changed !== 1) return false;
  input.testFailpoint?.('after-settlement');
  const reason = terminalReason(input.result);
  if (reason !== null) {
    terminaliseSourceWork(database, row, reason, input.now);
    input.testFailpoint?.('after-terminal-decision');
    // Task 5 has no evaluator-created delivery rows; this named seam keeps the single transaction ready for Task 7's
    // prepared deliveries without permitting a separate ledger transition.
    input.testFailpoint?.('after-delivery-insert');
    input.testFailpoint?.('after-projection-purge');
  }
  input.testFailpoint?.('before-commit');
  return true;
}

/** Settles one post-I/O call exactly once. Unknown and bounded-output refusals close source work content-free. */
export function settleJudgeWork(input: SettleJudgeWorkInput): boolean {
  const settlement: JudgeSettlement =
    input.result === 'completed'
      ? { result: input.result, actualInputTokens: input.actualInputTokens }
      : { result: input.result };
  return input.store.immediate(() =>
    settleReservationInTransaction(input.store.database, {
      reservationId: input.reservationId,
      ...settlement,
      now: input.now,
      testFailpoint: input.testFailpoint,
    }),
  );
}

/**
 * Closes a refused transport from the durable boundary state, not from the transport's advisory `preIo` flag. A
 * refusal that reached the synchronous physical-I/O gate is already in flight and must settle pessimistically;
 * every earlier refusal is still reserved and releases without a rolling charge.
 */
export function finalizeJudgeTransportRefusal(input: {
  readonly store: EventDatabase;
  readonly reservationId: string;
  readonly result: Exclude<JudgeSettlementResult, 'completed'>;
  readonly now: number;
}): 'released' | 'settled' | null {
  return input.store.immediate(() => {
    const row = readReservation(input.store.database, input.reservationId);
    if (row === null) return null;
    if (row.state === 'released' || row.state === 'settled') return row.state;
    if (row.state === 'reserved')
      return releaseReservationInTransaction(input.store.database, row.id, input.now) ? 'released' : null;
    return settleReservationInTransaction(input.store.database, {
      reservationId: row.id,
      result: input.result,
      now: input.now,
    })
      ? 'settled'
      : null;
  });
}

/** Used only by the shared recovery closure; no other module may reimplement these state transitions. */
export function recoverOneJudgeReservationInTransaction(
  database: DatabaseSync,
  reservationId: string,
  now: number,
): 'released' | 'settled' | null {
  const row = readReservation(database, reservationId);
  if (row === null) return null;
  if (row.state === 'reserved') return releaseReservationInTransaction(database, row.id, now) ? 'released' : null;
  if (row.state !== 'in-flight') return null;
  return settleReservationInTransaction(database, {
    reservationId: row.id,
    result: 'unknown',
    now,
  })
    ? 'settled'
    : null;
}
