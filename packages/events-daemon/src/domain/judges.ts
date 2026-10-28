import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@agentcomms/core';
import { parsePointer } from '@agentcomms/events';
import { assertApprovedAddressSet, parseIpLiteral } from '../network/address-policy.ts';
import { validateLocalEndpoint } from '../network/local-endpoint.ts';
import {
  type CanonicalLayaEnablement,
  createLayaJudgeKindDefinition,
  LayaContractError,
  type LayaJudgeKindDefinition,
  type LayaJudgeTerms,
  type LayaPlatformProbe,
  type LayaReviewedAssetSource,
} from '../runtime/laya/contracts.ts';
import { isLayaTemplateId, LAYA_RUNNABLE_TEMPLATE_IDS, type LayaTemplateId } from '../runtime/laya/templates.ts';
import {
  EventDomainError,
  JUDGE_KIND_LAYA,
  JUDGE_KIND_LOCAL_ENDPOINT,
  JUDGE_KIND_TYPESAFE,
  JUDGE_KINDS,
  type JudgeKind,
} from './lifecycle.ts';

export type {
  LayaJudgeKindDefinition,
  LayaJudgeTerms,
  LayaPlatformProbe,
  LayaReviewedAssetSource,
} from '../runtime/laya/contracts.ts';

export const TYPESAFE_SYSTEM_ONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JUDGE_BUDGET_ID = 'judge-budget';
/** Provider record: docs/superpowers/plans/2026-10-10-events-phase-e-provider-record.md, read 2026-10-10. */
export const APPROVED_TYPESAFE_MODELS = ['jev-1.13.0'] as const;
type ApprovedTypeSafeModel = (typeof APPROVED_TYPESAFE_MODELS)[number];

/**
 * Jev through OpenRouter (owner decision 2026-10-26): the same System One request as TypeSafe's own endpoint, at
 * OpenRouter's (https://openrouter.ai/docs/guides/community/jev, read 2026-10-26). Only the concrete model id is
 * approved; the `~typesafe/jev-latest` alias could change under an approval and is refused, as `jev-latest` is.
 */
export const OPENROUTER_SYSTEM_ONE_ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
export const APPROVED_OPENROUTER_JEV_MODELS = ['typesafe/jev-1.14'] as const;
type ApprovedOpenRouterJevModel = (typeof APPROVED_OPENROUTER_JEV_MODELS)[number];

/** Who serves a Jev judge: TypeSafe itself, or OpenRouter, which passes the request to TypeSafe's Jev. */
export const JEV_PROVIDERS: readonly [typeof JUDGE_KIND_TYPESAFE, 'openrouter'] = [JUDGE_KIND_TYPESAFE, 'openrouter'];
export type JevProvider = (typeof JEV_PROVIDERS)[number];

export function isJevProvider(value: unknown): value is JevProvider {
  return typeof value === 'string' && (JEV_PROVIDERS as readonly string[]).includes(value);
}

/** The endpoint and model each Jev provider's judge document names; the provider sets both. */
export const JEV_PROVIDER_ROUTES: Readonly<
  Record<JevProvider, { readonly endpoint: string; readonly model: string; readonly name: string }>
> = Object.freeze({
  typesafe: { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT, model: APPROVED_TYPESAFE_MODELS[0], name: 'TypeSafe' },
  openrouter: {
    endpoint: OPENROUTER_SYSTEM_ONE_ENDPOINT,
    model: APPROVED_OPENROUTER_JEV_MODELS[0],
    name: 'OpenRouter',
  },
});

export type JudgeProtocol =
  | { readonly protocol: 'noul' }
  | { readonly protocol: 'json-score'; readonly scorePointer: string };

interface JevJudgeBase {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: typeof JUDGE_KIND_TYPESAFE;
  readonly promptTemplate: string;
  readonly protocol: 'noul';
}

/** Jev, the TypeSafe judge kind: served by TypeSafe itself, or through OpenRouter (2026-10-26). */
export type TypeSafeJudgeDocument =
  | (JevJudgeBase & {
      readonly provider: typeof JUDGE_KIND_TYPESAFE;
      readonly model: ApprovedTypeSafeModel;
      readonly endpoint: typeof TYPESAFE_SYSTEM_ONE_ENDPOINT;
    })
  | (JevJudgeBase & {
      readonly provider: 'openrouter';
      readonly model: ApprovedOpenRouterJevModel;
      readonly endpoint: typeof OPENROUTER_SYSTEM_ONE_ENDPOINT;
    });

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

/**
 * A Laya judge (D2, D11): the canonical Laya provider, the reviewed manifest entry in the endpoint's place — with one
 * model per entry it is also the model, so the document names it once, as `model` — and one of the two immutable
 * prompt templates. Execution refuses it unless that entry is the enabled one and lists the template.
 */
export interface LayaJudgeDocument {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: typeof JUDGE_KIND_LAYA;
  readonly provider: typeof JUDGE_KIND_LAYA;
  readonly model: string;
  readonly promptTemplate: LayaTemplateId;
}

export type CanonicalJudgeDocument = TypeSafeJudgeDocument | LocalEndpointJudgeDocument | LayaJudgeDocument;

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
    }
  | CanonicalLayaEnablement;

export interface JudgeKindDefinition {
  readonly kind: JudgeKind;
  readonly availability: 'available' | 'unavailable';
  readonly unavailableCode?: 'E2_REQUIRED';
  /** E2's concrete implementation occupies only the slot Phase E reserved for it. */
  readonly implementation?: LayaJudgeKindDefinition | undefined;
}

/** Tests may replace only exact reviewed asset bytes and the content-free boundary-spawn seam. */
export interface LayaEnablementInputs {
  readonly layaAssetSource?: LayaReviewedAssetSource | undefined;
  readonly layaPlatformProbe?: LayaPlatformProbe | undefined;
}

const layaInputsByDatabase = new WeakMap<DatabaseSync, LayaEnablementInputs>();

/**
 * One owner registers the Laya inputs its own activation path validates with, for its database, as it registers E's
 * purge listener: so E's budget fence, settlement and every other reader of that database's Laya kind document use
 * the same reviewed bytes. Production's inputs are empty — the shipped assets and this process's platform.
 */
export function registerLayaEnablementInputs(database: DatabaseSync, inputs: LayaEnablementInputs): () => void {
  if (layaInputsByDatabase.has(database)) throw new Error('Laya enablement inputs are already registered');
  layaInputsByDatabase.set(database, inputs);
  return () => {
    if (layaInputsByDatabase.get(database) === inputs) layaInputsByDatabase.delete(database);
  };
}

/** The inputs registered for one database, or none: the shipped assets and this process's platform. */
export function layaEnablementInputsFor(database: DatabaseSync): LayaEnablementInputs {
  return layaInputsByDatabase.get(database) ?? {};
}

const LAYA_JUDGE_KIND_DEFINITION: LayaJudgeKindDefinition = {
  kind: JUDGE_KINDS[1],
  availability: () => shippedLayaDefinition().availability(),
  judgeTerms: () => shippedLayaDefinition().judgeTerms(),
  prepareEnablement: (input) => shippedLayaDefinition().prepareEnablement(input),
  canonicalEnablement: (value) => shippedLayaDefinition().canonicalEnablement(value),
  preview: (input) => shippedLayaDefinition().preview(input),
  onEnabled: (enablement, activation) => shippedLayaDefinition().onEnabled(enablement, activation),
  execute: (request, reservation) => shippedLayaDefinition().execute(request, reservation),
  onWorkPurged: (scope) => shippedLayaDefinition().onWorkPurged(scope),
  onDisabled: () => shippedLayaDefinition().onDisabled(),
  status: () => shippedLayaDefinition().status(),
  removeWhenDisabled: () => shippedLayaDefinition().removeWhenDisabled(),
};

/** Phase E's closed registry. The lifecycle module owns the literal vocabulary; this registry owns its availability. */
export const JUDGE_KIND_DEFINITIONS: readonly JudgeKindDefinition[] = [
  { kind: JUDGE_KINDS[0], availability: 'available' },
  // The static Phase E state stays unavailable; E2's typed implementation supplies the dynamic platform/lock
  // reason and is the only concrete replacement for that slot.
  {
    kind: JUDGE_KINDS[1],
    availability: 'unavailable',
    unavailableCode: 'E2_REQUIRED',
    implementation: LAYA_JUDGE_KIND_DEFINITION,
  },
  { kind: JUDGE_KINDS[2], availability: 'available' },
];

function fail(message: string, code: EventDomainError['code'] = 'VERSION_DOCUMENT_INVALID'): never {
  throw new EventDomainError(code, message);
}

/**
 * The daemon package's root, where its three reviewed Laya assets ship: two levels above this module in the source
 * tree (`src/domain/`), one above the bundle that carries it (`dist/`), by the same rule as the worker entry.
 */
const SHIPPED_PACKAGE_ROOT: string = import.meta.dirname.endsWith(`${sep}dist`)
  ? join(import.meta.dirname, '..')
  : join(import.meta.dirname, '..', '..');

/** The production assets remain blocked until Task 10's owner-only lock gate replaces the placeholder. */
function shippedLayaAssetSource(): LayaReviewedAssetSource {
  return {
    manifestBytes: readFileSync(join(SHIPPED_PACKAGE_ROOT, 'laya-manifest.json')),
    runtimeLockBytes: readFileSync(join(SHIPPED_PACKAGE_ROOT, 'laya-runtime.json')),
    disclosuresBytes: readFileSync(join(SHIPPED_PACKAGE_ROOT, 'laya-enablement-disclosures.json')),
  };
}

function shippedLayaDefinition(inputs: LayaEnablementInputs = {}): LayaJudgeKindDefinition {
  return createLayaJudgeKindDefinition({
    assets: inputs.layaAssetSource ?? shippedLayaAssetSource(),
    platform: inputs.layaPlatformProbe ?? { platform: process.platform, architecture: process.arch },
  });
}

/**
 * The one reviewed Laya definition for exactly the inputs E's activation path validates against: the shipped asset
 * bytes and this process's platform in production, the same strict-parsed fixture bytes in tests.
 */
export function layaJudgeKindDefinitionFor(inputs: LayaEnablementInputs = {}): LayaJudgeKindDefinition {
  return shippedLayaDefinition(inputs);
}

function layaEnablement(value: unknown, inputs: LayaEnablementInputs = {}): CanonicalLayaEnablement {
  try {
    const implementation =
      inputs.layaAssetSource === undefined && inputs.layaPlatformProbe === undefined
        ? judgeKindDefinition(JUDGE_KINDS[1]).implementation
        : shippedLayaDefinition(inputs);
    if (implementation === undefined) return fail('the Laya registry implementation is absent');
    return implementation.canonicalEnablement(value);
  } catch (error) {
    if (error instanceof LayaContractError) {
      if (error.code === 'E2_EXTERNAL_REFERENCE_BLOCKED')
        return fail('the reviewed Laya runtime lock is blocked', 'E2_EXTERNAL_REFERENCE_BLOCKED');
      if (error.code === 'LAYA_PLATFORM_UNAVAILABLE')
        return fail('Laya is unavailable on this platform', 'LAYA_PLATFORM_UNAVAILABLE');
      if (error.code === 'LAYA_SANDBOX_UNAVAILABLE')
        return fail('the macOS Laya boundary is unavailable', 'LAYA_SANDBOX_UNAVAILABLE');
    }
    return fail('the Laya enablement is not its exact reviewed document');
  }
}

/** Performs only the content-free availability probe before an activation can create its first intent. */
export function assertLayaJudgeKindAvailable(inputs: LayaEnablementInputs = {}): void {
  const implementation =
    inputs.layaAssetSource === undefined && inputs.layaPlatformProbe === undefined
      ? judgeKindDefinition(JUDGE_KINDS[1]).implementation
      : shippedLayaDefinition(inputs);
  if (implementation === undefined) fail('the Laya registry implementation is absent');
  const availability = implementation.availability();
  if (availability.available) return;
  if (availability.code === 'E2_EXTERNAL_REFERENCE_BLOCKED')
    fail('the reviewed Laya runtime lock is blocked', 'E2_EXTERNAL_REFERENCE_BLOCKED');
  if (availability.code === 'LAYA_PLATFORM_UNAVAILABLE')
    fail('Laya is unavailable on this platform', 'LAYA_PLATFORM_UNAVAILABLE');
  fail('the macOS Laya boundary is unavailable', 'LAYA_SANDBOX_UNAVAILABLE');
}

/** The reviewed terms a Laya judge is created under, for exactly the inputs E's activation path validates with. */
export function layaJudgeTermsFor(inputs: LayaEnablementInputs = {}): LayaJudgeTerms {
  try {
    const implementation =
      inputs.layaAssetSource === undefined && inputs.layaPlatformProbe === undefined
        ? judgeKindDefinition(JUDGE_KINDS[1]).implementation
        : shippedLayaDefinition(inputs);
    if (implementation === undefined) return fail('the Laya registry implementation is absent');
    return implementation.judgeTerms();
  } catch (error) {
    if (error instanceof LayaContractError) return fail('the reviewed Laya manifest cannot be read');
    throw error;
  }
}

/**
 * B3 control v3 (D2, D11): a Laya judge is configuration, kept whatever Laya's state on this machine or in this release,
 * and it evaluates only once Laya is enabled and ready. It may name only what this release could run: the reviewed
 * manifest entry, and a template that entry lists and the worker runs. The reason is in each message, because the
 * message is all the CLI and MCP show.
 */
export function assertCreatableLayaJudge(
  judge: CanonicalJudgeDocument | undefined,
  inputs: LayaEnablementInputs = {},
): void {
  if (judge?.kind !== JUDGE_KIND_LAYA) return;
  const terms = layaJudgeTermsFor(inputs);
  if (judge.model !== terms.manifestId)
    fail(
      `a Laya judge names this release's reviewed manifest, ${terms.manifestId} (LAYA_MANIFEST_NOT_REVIEWED)`,
      'LAYA_MANIFEST_NOT_REVIEWED',
    );
  if (
    !terms.promptTemplates.includes(judge.promptTemplate) ||
    !LAYA_RUNNABLE_TEMPLATE_IDS.includes(judge.promptTemplate)
  )
    fail(
      `a Laya judge uses ${LAYA_RUNNABLE_TEMPLATE_IDS.join(' or ')}; ${judge.promptTemplate} is not offered (LAYA_TEMPLATE_BLOCKED)`,
      'LAYA_TEMPLATE_BLOCKED',
    );
}

/**
 * D11: a rule naming a Laya judge is activated only where this release and platform offer Laya. Anywhere else its
 * judge could never evaluate, so preparing, claiming or finalising the rule is refused with Laya's own closed reason,
 * before the kind's state: never a rule that silently cannot ask.
 */
export function assertLayaRuleJudgeOffered(inputs: LayaEnablementInputs = {}): void {
  try {
    assertLayaJudgeKindAvailable(inputs);
  } catch (error) {
    if (error instanceof EventDomainError)
      throw new EventDomainError(
        error.code,
        `this workflow's Laya judge cannot evaluate here: Laya is not offered (${error.code})`,
      );
    throw error;
  }
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

/** The one canonical, immutable judge document form. Laya's separate reviewed kind document is its activation authority. */
export function canonicalJudge(value: unknown): CanonicalJudgeDocument {
  const judge = record(value, 'a judge document');
  const kind = judge.kind;
  if (!(JUDGE_KINDS as readonly string[]).includes(kind as string))
    return fail('a judge document has a known judge kind');
  if (kind === JUDGE_KIND_LAYA) {
    exactKeys(judge, ['judgeId', 'version', 'kind', 'provider', 'model', 'promptTemplate'], 'a Laya judge document');
    if (judge.provider !== JUDGE_KIND_LAYA) return fail('a Laya judge names the canonical Laya provider');
    if (!isLayaTemplateId(judge.promptTemplate)) return fail('a Laya judge names one immutable Laya prompt template');
    return {
      ...identity(judge, 'a Laya judge'),
      kind: JUDGE_KIND_LAYA,
      provider: JUDGE_KIND_LAYA,
      model: text(judge.model, 'a Laya judge manifest id'),
      promptTemplate: judge.promptTemplate,
    };
  }
  if (kind === JUDGE_KIND_TYPESAFE) {
    exactKeys(
      judge,
      ['judgeId', 'version', 'kind', 'provider', 'model', 'endpoint', 'promptTemplate', 'protocol'],
      'a typesafe judge document',
    );
    if (judge.provider === 'openrouter') return openRouterJev(judge);
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

/**
 * Jev through OpenRouter: the provider fixes the endpoint and the one approved concrete model, so a document cannot
 * point an OpenRouter judge anywhere else or at a moving alias.
 */
function openRouterJev(judge: Record<string, unknown>): TypeSafeJudgeDocument {
  if (!(APPROVED_OPENROUTER_JEV_MODELS as readonly string[]).includes(judge.model as string))
    return fail('an OpenRouter Jev judge names one concrete approved model, never an alias');
  if (judge.endpoint !== OPENROUTER_SYSTEM_ONE_ENDPOINT)
    return fail('an OpenRouter Jev judge has its fixed System One endpoint');
  const parsedProtocol = protocol({ protocol: judge.protocol }, 'a typesafe judge document');
  if (parsedProtocol.protocol !== 'noul') return fail('a typesafe judge uses the noul protocol');
  return {
    ...identity(judge, 'a typesafe judge'),
    kind: JUDGE_KIND_TYPESAFE,
    provider: 'openrouter',
    model: judge.model as ApprovedOpenRouterJevModel,
    endpoint: OPENROUTER_SYSTEM_ONE_ENDPOINT,
    promptTemplate: text(judge.promptTemplate, 'a typesafe judge prompt template'),
    protocol: 'noul',
  };
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
    const canonical = {
      provider: text(provider.provider, 'a judge provider id'),
      callsPerRollingHour: positiveInteger(provider.callsPerRollingHour, 'a judge provider budget callsPerRollingHour'),
      inputTokensPerRolling30Days: positiveInteger(
        provider.inputTokensPerRolling30Days,
        'a judge provider budget inputTokensPerRolling30Days',
      ),
      concurrency: positiveInteger(provider.concurrency, 'a judge provider budget concurrency'),
    };
    if (canonical.provider === JUDGE_KINDS[1] && canonical.concurrency > 1)
      return fail('the Laya provider is one-at-a-time');
    return canonical;
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

/** The closed kind registry lookup. E2 replaces only Phase E's Laya slot. */
export function judgeKindDefinition(kind: JudgeKind): JudgeKindDefinition {
  const definition = JUDGE_KIND_DEFINITIONS.find((candidate) => candidate.kind === kind);
  if (definition === undefined) return fail('a judge kind has a registry definition');
  return definition;
}

/** Canonicalises one inert kind-enablement version; no pointer or availability change happens here. */
export function canonicalJudgeKindEnablement(
  value: unknown,
  inputs: LayaEnablementInputs = {},
): CanonicalJudgeKindEnablementDocument {
  const enablement = record(value, 'a judge-kind document');
  if (!(JUDGE_KINDS as readonly string[]).includes(enablement.kind as string))
    return fail('a judge-kind document has a known judge kind');
  const kind = enablement.kind as JudgeKind;
  if (kind === JUDGE_KINDS[1]) return layaEnablement(enablement, inputs);
  if (judgeKindDefinition(kind).availability === 'unavailable')
    return fail('the judge kind is unavailable', 'E2_REQUIRED');
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
