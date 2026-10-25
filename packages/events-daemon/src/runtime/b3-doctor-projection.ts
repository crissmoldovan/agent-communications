import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalStore, ConfigStore } from '@agentcomms/core';
import { isActivationFailureCode } from '../domain/activation-failure-codes.ts';
import { JUDGE_KIND_LAYA, JUDGE_KINDS, type JudgeKind } from '../domain/lifecycle.ts';
import {
  assertDoctorReportV1,
  assertDoctorReportV2,
  assertDoctorReportV3,
  type DoctorActivationFailureCode,
  type DoctorActivationKind,
  type DoctorDerivationEditKind,
  type DoctorLineageFailureCode,
  type DoctorReportV1,
  type DoctorReportV2,
  type DoctorReportV3,
  type DoctorSource,
} from '../operations/doctor.ts';
import { phaseDSourceRegistry } from '../sources/registry.ts';
import type { B3ControlPorts } from './b3-control-ports.ts';
import { type LineageFailureCode, type RuleLineageRow, validateRuleLineage } from './disclosure-fence.ts';
import type { LayaArtifactManager } from './laya/manager.ts';

export const DOCTOR_REPORT_V1_SCHEMA_VERSION = 'doctor-v1' as const;

function preEJudgeBoundary(kind: JudgeKind): DoctorReportV1['judgeBoundary'][number] {
  return kind === JUDGE_KIND_LAYA
    ? { kind, code: 'E2_REQUIRED', phase: 'E2' }
    : { kind, code: 'E_REQUIRED', phase: 'E' };
}

interface DoctorProjectionInput {
  readonly database: DatabaseSync;
  readonly installationId: string;
  readonly lifecycle: { readonly enabled: boolean; readonly paused: boolean; readonly switchGeneration: number };
  readonly protocolVersions: readonly number[];
  readonly ports: Pick<B3ControlPorts, 'assertObjectSecretReady'>;
  readonly config: Pick<ConfigStore, 'load'>;
  /** Owner-only source state decryptor. Its AAD is the exact source_scan_state id the writers use. */
  readonly decryptSourceState: (stored: Uint8Array, stateId: string) => Promise<unknown>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly now?: (() => number) | undefined;
}

interface StoredRule extends RuleLineageRow {
  readonly rule_id: string;
  readonly version: number;
  readonly document: string;
  readonly approval_id: string;
  readonly authorization_activation_id: string;
  readonly activated_at: number;
  readonly current_cutover_id: string | null;
}

interface SourceAccount {
  readonly source: DoctorSource;
  readonly accountId: string;
  readonly scopeId: string;
}

const SOURCES = new Set<DoctorSource>(['gmail', 'slack', 'resend', 'whatsapp']);

function asSource(value: string): DoctorSource | undefined {
  return SOURCES.has(value as DoctorSource) ? (value as DoctorSource) : undefined;
}

function asTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function count(database: DatabaseSync, sql: string, ...values: readonly (string | number | null)[]): number {
  const row = database.prepare(sql).get(...values) as { count?: number } | undefined;
  return typeof row?.count === 'number' && row.count >= 0 ? row.count : 0;
}

function retainedWork(database: DatabaseSync, ruleId: string, ruleVersion: number): number {
  return count(
    database,
    `SELECT count(*) AS count FROM (
       SELECT 1 FROM deliveries
        WHERE rule_id = ? AND rule_version = ?
          AND (state IN ('queued', 'retryable', 'disclosing', 'in-flight-at-disable', 'in-flight-at-account-removal')
               OR encrypted_record IS NOT NULL)
       UNION ALL
       SELECT 1 FROM dryrun_log WHERE rule_id = ? AND rule_version = ?
       UNION ALL
       SELECT 1 FROM stream_log WHERE rule_id = ? AND rule_version = ?
       UNION ALL
       SELECT 1 FROM decisions WHERE rule_id = ? AND rule_version = ? AND outcome = 'hold'
       UNION ALL
       SELECT 1 FROM queue_items WHERE rule_id = ? AND rule_version = ? AND encrypted_record IS NOT NULL
     )`,
    ruleId,
    ruleVersion,
    ruleId,
    ruleVersion,
    ruleId,
    ruleVersion,
    ruleId,
    ruleVersion,
    ruleId,
    ruleVersion,
  );
}

function lineageCode(value: LineageFailureCode): DoctorLineageFailureCode {
  return value;
}

function derivation(
  value: Extract<Awaited<ReturnType<typeof validateRuleLineage>>, { readonly valid: true }>,
): DoctorReportV1['lineages'][number]['derivation'] {
  return value.derivation.map((edge) => ({
    versionId: edge.versionId,
    parentApprovalId: edge.parentApprovalId,
    parentVersionId: edge.parentVersionId,
    editKind: edge.editKind as DoctorDerivationEditKind,
  }));
}

function safeFailureCode(value: unknown): DoctorActivationFailureCode | null {
  if (value === null) return null;
  return isActivationFailureCode(value) ? value : 'UNRECOGNISED';
}

function activationKind(value: string): DoctorActivationKind {
  return value === 'rule' || value === 'enable-all' ? value : 'unknown';
}

function resolutionCode(value: unknown): 'vanished' | 'unresolvable' | 'retentionExpired' | null {
  if (value === 'vanished' || value === 'unresolvable') return value;
  return value === 'retention-expired' ? 'retentionExpired' : null;
}

type DoctorResolutionCategory = 'metadata' | 'materialisation';
type DoctorResolutionTable = 'source_occurrence_resolutions' | 'source_projection_resolutions';

interface DoctorResolutionHealth {
  readonly vanished: number;
  readonly unresolvable: number;
  readonly retentionExpired: number;
  readonly last: { readonly code: 'vanished' | 'unresolvable' | 'retentionExpired'; readonly at: number } | null;
}

function resolutionTable(source: DoctorSource, category: DoctorResolutionCategory): DoctorResolutionTable | undefined {
  if (source === 'gmail')
    return category === 'metadata' ? 'source_occurrence_resolutions' : 'source_projection_resolutions';
  if (source === 'resend' && category === 'materialisation') return 'source_occurrence_resolutions';
  return undefined;
}

/**
 * Maps the two durable resolution ledgers by their writer semantics, not their table names. Gmail's occurrence rows
 * are metadata reads, Gmail's projection rows are lazy materialisation, and Resend's received-detail rows are lazy
 * materialisation even though they share the occurrence ledger.
 */
function resolutionHealth(
  database: DatabaseSync,
  source: DoctorSource,
  accountId: string,
  category: DoctorResolutionCategory,
): DoctorResolutionHealth {
  const table = resolutionTable(source, category);
  if (table === undefined) return { vanished: 0, unresolvable: 0, retentionExpired: 0, last: null };
  const projectionTieBreak =
    table === 'source_projection_resolutions'
      ? ', latest.rule_id DESC, latest.rule_version DESC, latest.materialization_key DESC'
      : '';
  const row = database
    .prepare(
      `SELECT sum(resolution.outcome = 'vanished') AS vanished,
              sum(resolution.outcome = 'unresolvable') AS unresolvable,
              sum(resolution.outcome = 'retention-expired') AS retention_expired,
              (SELECT latest.outcome FROM ${table} AS latest
                WHERE latest.source = ? AND latest.account_id = ?
                ORDER BY latest.resolved_at DESC, latest.occurrence_key DESC${projectionTieBreak} LIMIT 1) AS latest_outcome,
              (SELECT latest.resolved_at FROM ${table} AS latest
                WHERE latest.source = ? AND latest.account_id = ?
                ORDER BY latest.resolved_at DESC, latest.occurrence_key DESC${projectionTieBreak} LIMIT 1) AS latest_at
         FROM ${table} AS resolution WHERE resolution.source = ? AND resolution.account_id = ?`,
    )
    .get(source, accountId, source, accountId, source, accountId) as {
    vanished: number | null;
    unresolvable: number | null;
    retention_expired: number | null;
    latest_outcome: unknown;
    latest_at: unknown;
  };
  const code = resolutionCode(row.latest_outcome);
  const at = asTime(row.latest_at);
  return {
    vanished: row.vanished ?? 0,
    unresolvable: row.unresolvable ?? 0,
    retentionExpired: row.retention_expired ?? 0,
    last: code === null || at === null ? null : { code, at },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

interface PendingRetry {
  readonly firstFailedAt: number;
  readonly attempts: number;
}

interface RetryHealth {
  readonly retryAgeMs: number | null;
  readonly retryCount: number;
  readonly maxAttempts: number;
  readonly unreadable: number;
}

function retry(
  value: Readonly<Record<string, unknown>>,
  first: string,
  next: string,
  attempts: string,
): PendingRetry | null {
  const firstFailedAt = asTime(value[first]);
  const nextAt = asTime(value[next]);
  const attemptCount = asTime(value[attempts]);
  return firstFailedAt === null || nextAt === null || attemptCount === null || attemptCount < 1
    ? null
    : { firstFailedAt, attempts: attemptCount };
}

/** Extracts only retry timing/count fields and immediately discards the decrypted source continuation. */
function retriesFromState(
  source: DoctorSource,
  cursorScope: string,
  state: unknown,
  category: 'metadata' | 'materialisation',
): readonly PendingRetry[] {
  const decrypted = record(state);
  if (decrypted === null) return [];
  if (category === 'metadata') {
    if (source !== 'gmail' || cursorScope !== 'mailbox') return [];
    const states = record(decrypted.messageStates);
    return states === null
      ? []
      : Object.values(states).flatMap((message) => {
          const values = record(message);
          const pending = values === null ? null : retry(values, 'firstFailedAt', 'nextRetryAt', 'attempts');
          return pending === null ? [] : [pending];
        });
  }
  if (source === 'gmail' && cursorScope === 'materialisation') {
    const pending = retry(decrypted, 'first_failed_at', 'next_retry_at', 'attempts');
    return pending === null ? [] : [pending];
  }
  if (source === 'resend' && cursorScope === 'received') {
    const values = record(decrypted.retry);
    const pending = values === null ? null : retry(values, 'firstFailedAt', 'nextRetryAt', 'attempts');
    return pending === null ? [] : [pending];
  }
  return [];
}

async function retryHealth(
  input: Pick<DoctorProjectionInput, 'database' | 'decryptSourceState'>,
  source: DoctorSource,
  accountId: string,
  category: 'metadata' | 'materialisation',
  now: number,
): Promise<RetryHealth> {
  const rows = input.database
    .prepare(
      `SELECT id, cursor_scope, encrypted_record FROM source_scan_state
       WHERE source = ? AND account_id = ? ORDER BY id`,
    )
    .all(source, accountId) as Array<{ id: string; cursor_scope: string; encrypted_record: Uint8Array }>;
  const pending: PendingRetry[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const mayContain =
      (category === 'metadata' && source === 'gmail' && row.cursor_scope === 'mailbox') ||
      (category === 'materialisation' &&
        ((source === 'gmail' && row.cursor_scope === 'materialisation') ||
          (source === 'resend' && row.cursor_scope === 'received')));
    if (!mayContain) continue;
    try {
      pending.push(
        ...retriesFromState(
          source,
          row.cursor_scope,
          await input.decryptSourceState(row.encrypted_record, row.id),
          category,
        ),
      );
    } catch {
      // Decrypt errors are opaque content-bearing failures. Doctor records only their count.
      unreadable += 1;
    }
  }
  const earliest = pending.reduce<number | null>(
    (oldest, entry) => (oldest === null || entry.firstFailedAt < oldest ? entry.firstFailedAt : oldest),
    null,
  );
  return {
    retryAgeMs: earliest === null ? null : Math.max(0, now - earliest),
    retryCount: pending.length,
    maxAttempts: pending.reduce((maximum, entry) => Math.max(maximum, entry.attempts), 0),
    unreadable,
  };
}

function documentAccounts(row: StoredRule): readonly SourceAccount[] {
  try {
    const document = JSON.parse(row.document) as {
      source?: { channel?: unknown; accountIds?: unknown; options?: unknown };
    };
    const source = typeof document.source?.channel === 'string' ? asSource(document.source.channel) : undefined;
    if (source === undefined || !Array.isArray(document.source?.accountIds)) return [];
    const sources = phaseDSourceRegistry();
    const options = sources.require(source).canonicalise(document.source.options);
    return document.source.accountIds.flatMap((accountId) => {
      if (typeof accountId !== 'string' || accountId === '') return [];
      return sources
        .require(source)
        .scopesFor({ accountId, options })
        .map((scope) => ({
          source,
          accountId,
          scopeId: scope.scopeId,
        }));
    });
  } catch {
    return [];
  }
}

function configuredAccounts(config: Awaited<ReturnType<ConfigStore['load']>>): ReadonlySet<string> {
  const live = new Set<string>();
  for (const inbox of Object.values(config.inboxes)) if (inbox.provider === 'gmail') live.add(`gmail\u0000${inbox.id}`);
  for (const account of Object.values(config.accounts)) live.add(`${account.platform}\u0000${account.id}`);
  return live;
}

/**
 * The Task-7 read model is deliberately narrower than status: it exposes only stable identifiers, enums, counts and
 * times. In particular, it never returns an encrypted position, cursor, document, alias, secret state, digest or
 * provider response. The owner supplies Task 2's readiness port rather than reimplementing its secret boundary.
 */
export async function projectB3Doctor(input: DoctorProjectionInput): Promise<DoctorReportV1> {
  const now = input.now?.() ?? Date.now();
  const activeRows = input.database
    .prepare(
      `SELECT rule_versions.id, rule_versions.rule_id, rule_versions.version, rule_versions.document, rule_versions.digest,
              rule_versions.state, rule_versions.approval_id, rule_versions.authorization_activation_id,
              rule_versions.revoked_at, rule_versions.activated_at, active_versions.current_cutover_id
         FROM rule_versions JOIN active_versions
           ON active_versions.kind = 'rule' AND active_versions.object_id = rule_versions.rule_id
          AND active_versions.version = rule_versions.version
        WHERE rule_versions.state = 'active'
        ORDER BY rule_versions.rule_id, rule_versions.version`,
    )
    .all() as unknown as StoredRule[];
  const live = configuredAccounts(await input.config.load());
  const lineages = await Promise.all(
    activeRows.map(async (row) => {
      const result = await validateRuleLineage(input.database, input.approvals, row);
      return {
        ruleId: row.rule_id,
        ruleVersion: row.version,
        status: 'active' as const,
        approvalId: row.approval_id,
        authorizationActivationId: row.authorization_activation_id,
        currentCutoverId: row.current_cutover_id,
        activatedAt: row.activated_at,
        retainedWork: retainedWork(input.database, row.rule_id, row.version),
        validation: result.valid
          ? ({ status: 'valid' as const } as const)
          : { status: 'invalid' as const, code: lineageCode(result.code) },
        derivation: result.valid ? derivation(result) : [],
      };
    }),
  );
  const superseded = (
    input.database
      .prepare("SELECT rule_id, version FROM rule_versions WHERE state = 'superseded' ORDER BY rule_id, version")
      .all() as Array<{ rule_id: string; version: number }>
  ).flatMap((row) => {
    const retained = retainedWork(input.database, row.rule_id, row.version);
    return retained === 0 ? [] : [{ ruleId: row.rule_id, ruleVersion: row.version, retainedWork: retained }];
  });
  const points = (
    input.database
      .prepare(
        `SELECT points.activation_id, points.rule_id, points.rule_version, points.source, points.account_id,
              points.position_scope, points.created_at
         FROM rule_activation_points AS points JOIN active_versions AS active
           ON active.kind = 'rule' AND active.object_id = points.rule_id AND active.version = points.rule_version
          AND active.current_cutover_id = points.activation_id
        ORDER BY points.rule_id, points.rule_version, points.source, points.account_id, points.position_scope`,
      )
      .all() as Array<{
      activation_id: string;
      rule_id: string;
      rule_version: number;
      source: string;
      account_id: string;
      position_scope: string;
      created_at: number;
    }>
  ).flatMap((row) => {
    const source = asSource(row.source);
    return source === undefined
      ? []
      : [
          {
            activationId: row.activation_id,
            ruleId: row.rule_id,
            ruleVersion: row.rule_version,
            source,
            accountId: row.account_id,
            scopeId: row.position_scope,
            status: 'active' as const,
            createdAt: row.created_at,
          },
        ];
  });
  const awaitingReapproval = activeRows
    .flatMap((row) => documentAccounts(row).map((account) => ({ row, account })))
    .filter(({ account }) => live.has(`${account.source}\u0000${account.accountId}`))
    .filter(
      ({ account }) =>
        input.database
          .prepare(
            `SELECT 1 FROM account_revocations
              WHERE account_id = ? AND (source IS NULL OR source = ?)`,
          )
          .get(account.accountId, account.source) !== undefined,
    )
    .filter(
      ({ row, account }) =>
        input.database
          .prepare(
            `SELECT 1 FROM rule_activation_points
             WHERE activation_id IS ? AND rule_id = ? AND rule_version = ? AND source = ? AND account_id = ?`,
          )
          .get(row.current_cutover_id, row.rule_id, row.version, account.source, account.accountId) === undefined,
    )
    .map(({ account }) => ({
      accountId: account.accountId,
      scopeId: account.scopeId,
      status: 'awaitingReapproval' as const,
    }))
    .sort((left, right) =>
      `${left.accountId}\u0000${left.scopeId}`.localeCompare(`${right.accountId}\u0000${right.scopeId}`),
    );
  const activationIntents = (
    input.database
      .prepare(
        `SELECT id, kind, status, claimed_at, completion_deadline, failure_code
         FROM activation_intents ORDER BY created_at, id`,
      )
      .all() as Array<{
      id: string;
      kind: string;
      status: DoctorReportV1['activationIntents'][number]['status'];
      claimed_at: unknown;
      completion_deadline: unknown;
      failure_code: unknown;
    }>
  ).map((row) => ({
    id: row.id,
    kind: activationKind(row.kind),
    status: row.status,
    claimedAt: asTime(row.claimed_at),
    completionDeadline: asTime(row.completion_deadline),
    failureCode: safeFailureCode(row.failure_code),
    baselines: count(input.database, 'SELECT count(*) AS count FROM activation_baselines WHERE intent_id = ?', row.id),
    draining: count(
      input.database,
      'SELECT count(*) AS count FROM replacement_drains WHERE intent_id = ? AND drained_at IS NULL',
      row.id,
    ),
  }));
  const sourceRows = input.database
    .prepare(
      `SELECT source, account_id FROM cursors
       UNION SELECT source, account_id FROM source_occurrence_resolutions
       UNION SELECT source, account_id FROM source_projection_resolutions
       UNION SELECT source, account_id FROM source_scan_state
       ORDER BY source, account_id`,
    )
    .all() as Array<{ source: string; account_id: string }>;
  const sources = (
    await Promise.all(
      sourceRows.map(async (row) => {
        const source = asSource(row.source);
        if (source === undefined) return [];
        const metadata = resolutionHealth(input.database, source, row.account_id, 'metadata');
        const materialisation = resolutionHealth(input.database, source, row.account_id, 'materialisation');
        const cursor = input.database
          .prepare('SELECT min(updated_at) AS oldest FROM cursors WHERE source = ? AND account_id = ?')
          .get(source, row.account_id) as { oldest: unknown };
        const metadataRetry = await retryHealth(input, source, row.account_id, 'metadata', now);
        const materialisationRetry = await retryHealth(input, source, row.account_id, 'materialisation', now);
        const oldestCursor = asTime(cursor.oldest);
        return [
          {
            source,
            accountId: row.account_id,
            metadata: {
              ...metadataRetry,
              resolutions: metadata,
            },
            materialisation: {
              ...materialisationRetry,
              resolutions: materialisation,
            },
            lagMs: oldestCursor === null ? null : Math.max(0, now - oldestCursor),
          },
        ];
      }),
    )
  ).flat();
  const resetBarriers = (
    input.database
      .prepare('SELECT state, count(*) AS count FROM reset_barriers GROUP BY state ORDER BY state')
      .all() as Array<{ state: 'open' | 'closed' | 'degraded'; count: number }>
  ).map((row) => ({
    state: row.state,
    count: row.count,
  }));
  const candidates = [
    ...(
      input.database
        .prepare(
          'SELECT target_id AS id, version FROM target_versions WHERE revoked_at IS NULL ORDER BY target_id, version',
        )
        .all() as Array<{ id: string; version: number }>
    ).map((row) => ({ kind: 'target' as const, ...row })),
    ...(
      input.database
        .prepare(
          'SELECT subscriber_id AS id, version FROM subscriber_versions WHERE revoked_at IS NULL ORDER BY subscriber_id, version',
        )
        .all() as Array<{ id: string; version: number }>
    ).map((row) => ({ kind: 'subscriber' as const, ...row })),
    ...(
      input.database
        .prepare(
          'SELECT judge_id AS id, version FROM judge_versions WHERE revoked_at IS NULL ORDER BY judge_id, version',
        )
        .all() as Array<{ id: string; version: number }>
    ).map((row) => ({ kind: 'judge' as const, ...row })),
  ];
  const missingSecrets: DoctorReportV1['recovery']['missingSecrets'][number][] = [];
  for (const candidate of candidates) {
    try {
      await input.ports.assertObjectSecretReady({ owner: candidate });
    } catch {
      // The port's internal detail is deliberately not a doctor field: only an enum kind and stable object identity
      // are useful to an operator and neither can reveal material or a provider response.
      missingSecrets.push(candidate);
    }
  }
  missingSecrets.sort((left, right) =>
    `${left.kind}\u0000${left.id}\u0000${left.version}`.localeCompare(
      `${right.kind}\u0000${right.id}\u0000${right.version}`,
    ),
  );
  return assertDoctorReportV1({
    schemaVersion: DOCTOR_REPORT_V1_SCHEMA_VERSION,
    owner: { status: 'running', protocolVersions: [...input.protocolVersions], installationId: input.installationId },
    switch: {
      status: input.lifecycle.enabled ? 'enabled' : 'disabled',
      paused: input.lifecycle.paused,
      generation: input.lifecycle.switchGeneration,
    },
    lineages,
    superseded,
    points,
    awaitingReapproval,
    activationIntents,
    sources,
    recovery: {
      leases: count(input.database, 'SELECT count(*) AS count FROM worker_leases'),
      held: count(input.database, "SELECT count(*) AS count FROM decisions WHERE outcome = 'hold'"),
      deadLetters:
        count(input.database, "SELECT count(*) AS count FROM deliveries WHERE state = 'dead-lettered'") +
        count(input.database, "SELECT count(*) AS count FROM system_reset_outbox WHERE state = 'dead-lettered'"),
      deadlines: count(input.database, 'SELECT count(*) AS count FROM ingest_rules WHERE decision_deadline <= ?', now),
      resetBarriers,
      missingSecrets,
    },
    judgeBoundary: [...JUDGE_KINDS]
      .sort((left, right) => preEJudgeBoundary(left).phase.localeCompare(preEJudgeBoundary(right).phase))
      .map(preEJudgeBoundary),
    whatsapp: whatsappHealth(input.database, live),
  });
}

/** Builds the Phase-E successor beside B3's frozen pre-E doctor-v1 projection. */
export async function projectE9Doctor(input: DoctorProjectionInput): Promise<DoctorReportV2> {
  const report = await projectB3Doctor(input);
  const kinds = [...JUDGE_KINDS].map((kind) => {
    if (kind === JUDGE_KIND_LAYA)
      return { kind: JUDGE_KIND_LAYA, state: 'unavailable' as const, code: 'E2_REQUIRED' as const };
    const active = input.database
      .prepare("SELECT version FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?")
      .get(kind) as { version: number } | undefined;
    return {
      kind,
      state: active === undefined ? ('disabled' as const) : ('enabled' as const),
      version: active?.version ?? null,
    };
  });
  const budget = input.database
    .prepare("SELECT version FROM active_versions WHERE kind = 'judge-budget' AND object_id = 'judge-budget'")
    .get() as { version: number } | undefined;
  // Doctor aggregates only after enumerating closed scope identities. That keeps the read path from turning a
  // content-free counter into an unscoped judge-work selector: source work remains source/account-bound and a
  // synthetic test remains exact-test-work-bound even when neither identifier is returned to the caller.
  const reservationScopes = input.database
    .prepare(
      `SELECT DISTINCT work_scope, source, account_id, test_work_id
         FROM judge_budget_reservations
        WHERE (work_scope = 'source-owned' AND source IS NOT NULL AND account_id IS NOT NULL)
           OR (work_scope = 'synthetic-test' AND test_work_id IS NOT NULL)`,
    )
    .all() as Array<{
    work_scope: 'source-owned' | 'synthetic-test';
    source: string | null;
    account_id: string | null;
    test_work_id: string | null;
  }>;
  const reservationCounts = new Map<'reserved' | 'in-flight' | 'settled' | 'released', number>();
  for (const scope of reservationScopes) {
    const rows =
      scope.work_scope === 'source-owned'
        ? (input.database
            .prepare(
              `SELECT state, count(*) AS count FROM judge_budget_reservations
                WHERE work_scope = 'source-owned' AND source = ? AND account_id = ? GROUP BY state`,
            )
            .all(scope.source, scope.account_id) as Array<{ state: string; count: number }>)
        : (input.database
            .prepare(
              `SELECT state, count(*) AS count FROM judge_budget_reservations
                WHERE work_scope = 'synthetic-test' AND test_work_id = ? GROUP BY state`,
            )
            .all(scope.test_work_id) as Array<{ state: string; count: number }>);
    for (const row of rows) {
      if (row.state !== 'reserved' && row.state !== 'in-flight' && row.state !== 'settled' && row.state !== 'released')
        continue;
      reservationCounts.set(row.state, (reservationCounts.get(row.state) ?? 0) + row.count);
    }
  }
  const reservations = [...reservationCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => ({ state, count }));
  const holdClocks = input.database
    .prepare(
      `SELECT count(*) AS count,
              min(hold_created_at) AS oldest_created_at,
              min(hold_expires_at) AS next_expires_at
         FROM decisions
        WHERE outcome = 'hold'`,
    )
    .get() as { count: number; oldest_created_at: number | null; next_expires_at: number | null };
  return assertDoctorReportV2({
    ...report,
    schemaVersion: 'doctor-v2',
    judgeBoundary: [{ kind: JUDGE_KIND_LAYA, code: 'E2_REQUIRED', phase: 'E2' }],
    judge: {
      kinds,
      budget: { activeVersion: budget?.version ?? null },
      reservations,
      holds: {
        count: holdClocks.count,
        oldestCreatedAt: holdClocks.oldest_created_at,
        nextExpiresAt: holdClocks.next_expires_at,
      },
    },
  });
}

/**
 * E2's successor beside the frozen doctor-v1 and doctor-v2 projections: the same v2 report, with no remaining judge
 * boundary, Laya's real kind state, and its content-free artifact entry from the one artifact manager.
 */
export async function projectE2Doctor(
  input: DoctorProjectionInput & { readonly laya: Pick<LayaArtifactManager, 'kindEntry' | 'doctor'> },
): Promise<DoctorReportV3> {
  const report = await projectE9Doctor(input);
  return assertDoctorReportV3({
    ...report,
    schemaVersion: 'doctor-v3',
    judgeBoundary: [],
    judge: {
      ...report.judge,
      kinds: report.judge.kinds.map((entry) => (entry.kind === JUDGE_KIND_LAYA ? input.laya.kindEntry() : entry)),
      laya: await input.laya.doctor(),
    },
    queue: {
      unreadableDeliveries: count(
        input.database,
        "SELECT count(*) AS count FROM deliveries WHERE target_kind = 'queue' AND state = 'content-unreadable'",
      ),
    },
  });
}

function whatsappHealth(database: DatabaseSync, live: ReadonlySet<string>): DoctorReportV1['whatsapp'] {
  const applied = new Map(
    (
      database.prepare('SELECT account_id, changed_at FROM whatsapp_visibility').all() as Array<{
        account_id: string;
        changed_at: number;
      }>
    ).map((row) => [row.account_id, row.changed_at]),
  );
  const accountIds = new Set(
    [...live]
      .filter((identity) => identity.startsWith('whatsapp\u0000'))
      .map((identity) => identity.slice('whatsapp\u0000'.length)),
  );
  for (const accountId of applied.keys()) accountIds.add(accountId);
  return [...accountIds].sort().map((accountId) => {
    const appliedAt = applied.get(accountId);
    return {
      accountId,
      status: appliedAt === undefined ? 'missing' : live.has(`whatsapp\u0000${accountId}`) ? 'applied' : 'stale',
      appliedAt: appliedAt ?? null,
    };
  });
}
