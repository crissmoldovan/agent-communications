import { canonicalJson } from '@agentcomms/core';
import { parsePointer } from '@agentcomms/events';
import { assertApprovedAddressSet, parseIpLiteral } from '../network/address-policy.ts';
import { validateLocalEndpoint } from '../network/local-endpoint.ts';
import {
  EventDomainError,
  JUDGE_KIND_LAYA,
  JUDGE_KIND_LOCAL_ENDPOINT,
  JUDGE_KIND_TYPESAFE,
  JUDGE_KINDS,
  type JudgeKind,
} from './lifecycle.ts';

export const TYPESAFE_SYSTEM_ONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JUDGE_BUDGET_ID = 'judge-budget';
/** Provider record: docs/superpowers/plans/2026-10-10-events-phase-e-provider-record.md, read 2026-10-10. */
export const APPROVED_TYPESAFE_MODELS = ['jev-1.13.0'] as const;
type ApprovedTypeSafeModel = (typeof APPROVED_TYPESAFE_MODELS)[number];

export type JudgeProtocol =
  | { readonly protocol: 'noul' }
  | { readonly protocol: 'json-score'; readonly scorePointer: string };

export interface TypeSafeJudgeDocument {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: typeof JUDGE_KIND_TYPESAFE;
  readonly provider: typeof JUDGE_KIND_TYPESAFE;
  readonly model: ApprovedTypeSafeModel;
  readonly endpoint: typeof TYPESAFE_SYSTEM_ONE_ENDPOINT;
  readonly promptTemplate: string;
  readonly protocol: 'noul';
}

interface LocalEndpointJudgeBase {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: typeof JUDGE_KIND_LOCAL_ENDPOINT;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly approvedAddressSet: readonly [string];
  readonly promptTemplate: string;
}

export type LocalEndpointJudgeDocument =
  | (LocalEndpointJudgeBase & { readonly protocol: 'noul' })
  | (LocalEndpointJudgeBase & { readonly protocol: 'json-score'; readonly scorePointer: string });

export type CanonicalJudgeDocument = TypeSafeJudgeDocument | LocalEndpointJudgeDocument;

export interface JudgeBudgetLimits {
  readonly callsPerRollingHour: number;
  readonly inputTokensPerRolling30Days: number;
  readonly concurrency: number;
}

export interface CanonicalJudgeBudgetDocument {
  readonly budgetId: typeof JUDGE_BUDGET_ID;
  readonly version: number;
  readonly global: JudgeBudgetLimits;
  readonly providers: readonly (JudgeBudgetLimits & { readonly provider: string })[];
}

export type CanonicalJudgeKindEnablementDocument =
  | {
      readonly id: 'judge-kind:typesafe';
      readonly kind: typeof JUDGE_KIND_TYPESAFE;
      readonly version: number;
      readonly endpoint: typeof TYPESAFE_SYSTEM_ONE_ENDPOINT;
    }
  | {
      readonly id: 'judge-kind:local-endpoint';
      readonly kind: typeof JUDGE_KIND_LOCAL_ENDPOINT;
      readonly version: number;
    };

export interface JudgeKindDefinition {
  readonly kind: JudgeKind;
  readonly availability: 'available' | 'unavailable';
  readonly unavailableCode?: 'E2_REQUIRED';
}

/** Phase E's closed registry. The lifecycle module owns the literal vocabulary; this registry owns its availability. */
export const JUDGE_KIND_DEFINITIONS: readonly JudgeKindDefinition[] = [
  { kind: JUDGE_KINDS[0], availability: 'available' },
  { kind: JUDGE_KINDS[1], availability: 'unavailable', unavailableCode: 'E2_REQUIRED' },
  { kind: JUDGE_KINDS[2], availability: 'available' },
];

function fail(message: string, code: 'VERSION_DOCUMENT_INVALID' | 'E2_REQUIRED' = 'VERSION_DOCUMENT_INVALID'): never {
  throw new EventDomainError(code, message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(`${name} is an object`);
  try {
    return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  } catch {
    return fail(`${name} is canonical JSON`);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const found = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (found.length !== wanted.length || found.some((key, index) => key !== wanted[index])) {
    fail(`${name} has exactly its canonical fields`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(`${name} is a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(`${name} is a positive safe integer`);
  return value as number;
}

function protocol(value: Record<string, unknown>, name: string): JudgeProtocol {
  if (value.protocol === 'noul') {
    exactKeys(value, ['protocol'], name);
    return { protocol: 'noul' };
  }
  if (value.protocol !== 'json-score') return fail(`${name} has protocol noul or json-score`);
  exactKeys(value, ['protocol', 'scorePointer'], name);
  const scorePointer = text(value.scorePointer, `${name} scorePointer`);
  const parsed = parsePointer(scorePointer);
  if (!parsed.ok || parsed.value.includes('*')) return fail(`${name} scorePointer is one concrete JSON Pointer`);
  return { protocol: 'json-score', scorePointer };
}

function identity(
  value: Record<string, unknown>,
  name: string,
): { readonly judgeId: string; readonly version: number } {
  return { judgeId: text(value.judgeId, `${name} id`), version: positiveInteger(value.version, `${name} version`) };
}

function localAddress(value: unknown): readonly [string] {
  if (!Array.isArray(value) || value.length !== 1)
    return fail('a local judge approvedAddressSet has one exact literal');
  const entry = text(value[0], 'a local judge approvedAddressSet entry');
  try {
    assertApprovedAddressSet([entry]);
    return [parseIpLiteral(entry).address];
  } catch {
    return fail('a local judge approvedAddressSet has one valid literal');
  }
}

/** The one canonical, immutable judge document form. E2's laya seam is recognised but intentionally unavailable. */
export function canonicalJudge(value: unknown): CanonicalJudgeDocument {
  const judge = record(value, 'a judge document');
  const kind = judge.kind;
  if (!(JUDGE_KINDS as readonly string[]).includes(kind as string))
    return fail('a judge document has a known judge kind');
  if (kind === JUDGE_KIND_LAYA) return fail('laya is unavailable until E2', 'E2_REQUIRED');
  if (kind === JUDGE_KIND_TYPESAFE) {
    exactKeys(
      judge,
      ['judgeId', 'version', 'kind', 'provider', 'model', 'endpoint', 'promptTemplate', 'protocol'],
      'a typesafe judge document',
    );
    if (judge.provider !== JUDGE_KIND_TYPESAFE) return fail('a typesafe judge names the TypeSafe Jev adapter');
    if (!(APPROVED_TYPESAFE_MODELS as readonly string[]).includes(judge.model as string))
      return fail('a typesafe judge names one concrete model listed in the provider record');
    if (judge.endpoint !== TYPESAFE_SYSTEM_ONE_ENDPOINT)
      return fail('a typesafe judge has its fixed System One endpoint');
    const parsedProtocol = protocol({ protocol: judge.protocol }, 'a typesafe judge document');
    if (parsedProtocol.protocol !== 'noul') return fail('a typesafe judge uses the noul protocol');
    return {
      ...identity(judge, 'a typesafe judge'),
      kind: JUDGE_KIND_TYPESAFE,
      provider: JUDGE_KIND_TYPESAFE,
      model: judge.model as ApprovedTypeSafeModel,
      endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT,
      promptTemplate: text(judge.promptTemplate, 'a typesafe judge prompt template'),
      protocol: 'noul',
    };
  }
  const localProtocol = protocol(
    judge.protocol === 'json-score'
      ? { protocol: judge.protocol, scorePointer: judge.scorePointer }
      : { protocol: judge.protocol },
    'a local judge document',
  );
  exactKeys(
    judge,
    localProtocol.protocol === 'json-score'
      ? [
          'judgeId',
          'version',
          'kind',
          'provider',
          'model',
          'endpoint',
          'approvedAddressSet',
          'promptTemplate',
          'protocol',
          'scorePointer',
        ]
      : [
          'judgeId',
          'version',
          'kind',
          'provider',
          'model',
          'endpoint',
          'approvedAddressSet',
          'promptTemplate',
          'protocol',
        ],
    'a local judge document',
  );
  const approvedAddressSet = localAddress(judge.approvedAddressSet);
  const endpoint = text(judge.endpoint, 'a local judge endpoint');
  try {
    const local = validateLocalEndpoint(endpoint, approvedAddressSet);
    if (local.url.search !== '') return fail('a local judge endpoint has no query');
    return {
      ...identity(judge, 'a local judge'),
      kind: JUDGE_KIND_LOCAL_ENDPOINT,
      provider: text(judge.provider, 'a local judge provider'),
      model: text(judge.model, 'a local judge model'),
      endpoint: local.url.href,
      approvedAddressSet,
      promptTemplate: text(judge.promptTemplate, 'a local judge prompt template'),
      ...localProtocol,
    };
  } catch (error) {
    if (error instanceof EventDomainError) throw error;
    return fail('a local judge has a literal loopback endpoint and its exact approved address');
  }
}

function limits(value: unknown, name: string): JudgeBudgetLimits {
  const limit = record(value, name);
  exactKeys(limit, ['callsPerRollingHour', 'inputTokensPerRolling30Days', 'concurrency'], name);
  return {
    callsPerRollingHour: positiveInteger(limit.callsPerRollingHour, `${name} callsPerRollingHour`),
    inputTokensPerRolling30Days: positiveInteger(
      limit.inputTokensPerRolling30Days,
      `${name} inputTokensPerRolling30Days`,
    ),
    concurrency: positiveInteger(limit.concurrency, `${name} concurrency`),
  };
}

/** The singleton's complete global and per-provider rolling ceilings, with no implicit defaults. */
export function canonicalJudgeBudget(value: unknown): CanonicalJudgeBudgetDocument {
  const budget = record(value, 'a judge budget document');
  exactKeys(budget, ['budgetId', 'version', 'global', 'providers'], 'a judge budget document');
  if (budget.budgetId !== JUDGE_BUDGET_ID) return fail(`a judge budget id is ${JUDGE_BUDGET_ID}`);
  if (!Array.isArray(budget.providers)) return fail('judge budget providers are an array');
  const providers = budget.providers.map((entry) => {
    const provider = record(entry, 'a judge provider budget');
    exactKeys(
      provider,
      ['provider', 'callsPerRollingHour', 'inputTokensPerRolling30Days', 'concurrency'],
      'a judge provider budget',
    );
    return {
      provider: text(provider.provider, 'a judge provider id'),
      callsPerRollingHour: positiveInteger(provider.callsPerRollingHour, 'a judge provider budget callsPerRollingHour'),
      inputTokensPerRolling30Days: positiveInteger(
        provider.inputTokensPerRolling30Days,
        'a judge provider budget inputTokensPerRolling30Days',
      ),
      concurrency: positiveInteger(provider.concurrency, 'a judge provider budget concurrency'),
    };
  });
  const sorted = [...providers].sort((left, right) =>
    left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0,
  );
  if (
    sorted.some((entry, index) => entry.provider !== providers[index]?.provider) ||
    new Set(providers.map((entry) => entry.provider)).size !== providers.length
  ) {
    return fail('judge budget providers are sorted and duplicate-free');
  }
  return {
    budgetId: JUDGE_BUDGET_ID,
    version: positiveInteger(budget.version, 'a judge budget version'),
    global: limits(budget.global, 'a global judge budget'),
    providers,
  };
}

/** The closed kind registry lookup, including E2's intentionally unavailable laya slot. */
export function judgeKindDefinition(kind: JudgeKind): JudgeKindDefinition {
  const definition = JUDGE_KIND_DEFINITIONS.find((candidate) => candidate.kind === kind);
  if (definition === undefined) return fail('a judge kind has a registry definition');
  return definition;
}

/** Canonicalises one inert kind-enablement version; no pointer or availability change happens here. */
export function canonicalJudgeKindEnablement(value: unknown): CanonicalJudgeKindEnablementDocument {
  const enablement = record(value, 'a judge-kind document');
  if (!(JUDGE_KINDS as readonly string[]).includes(enablement.kind as string))
    return fail('a judge-kind document has a known judge kind');
  const kind = enablement.kind as JudgeKind;
  if (judgeKindDefinition(kind).availability === 'unavailable')
    return fail('laya is unavailable until E2', 'E2_REQUIRED');
  const id = `judge-kind:${kind}`;
  if (enablement.id !== id) return fail(`a judge-kind document id is ${id}`);
  if (kind === JUDGE_KIND_TYPESAFE) {
    exactKeys(enablement, ['id', 'kind', 'version', 'endpoint'], 'a typesafe judge-kind document');
    if (enablement.endpoint !== TYPESAFE_SYSTEM_ONE_ENDPOINT)
      return fail('a typesafe judge-kind document has the fixed System One endpoint');
    return {
      id: 'judge-kind:typesafe',
      kind: JUDGE_KIND_TYPESAFE,
      version: positiveInteger(enablement.version, 'a judge-kind version'),
      endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT,
    };
  }
  exactKeys(enablement, ['id', 'kind', 'version'], 'a local-endpoint judge-kind document');
  return {
    id: 'judge-kind:local-endpoint',
    kind: JUDGE_KIND_LOCAL_ENDPOINT,
    version: positiveInteger(enablement.version, 'a judge-kind version'),
  };
}
