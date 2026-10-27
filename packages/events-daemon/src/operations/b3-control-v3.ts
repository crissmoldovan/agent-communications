import { neutralise } from '@agentcomms/core';
import {
  type ActivationDocumentV1,
  type CanonicalFullRuleDocument,
  canonicalFullRuleDocument,
  canonicalJudge,
} from '../domain/activation-documents.ts';
import type { CanonicalJudgeDocument, LayaJudgeDocument, LayaJudgeTerms } from '../domain/judges.ts';
import { JUDGE_KIND_LAYA, JUDGE_KINDS, type JudgeKind } from '../domain/lifecycle.ts';
import type { JudgeDocumentContract } from '../domain/versions.ts';
import { LAYA_NOUL_TEMPLATE_ID, LAYA_RUNNABLE_TEMPLATE_IDS } from '../runtime/laya/templates.ts';
import type { B3ApprovalViewResultV1 } from './b3-contract.ts';

/**
 * B3 control v3 is v2 with a Laya judge variant. A Laya judge document is exactly
 * `{ judgeId, version, kind, provider, model, promptTemplate }`, with the Laya kind as both kind and provider and the
 * reviewed manifest id as the model (E2 Task 8), and v3 accepts one wherever a judge document goes: `judge add`,
 * `judge update`, and inside the rule documents of `rule create`, `rule update` and `rule test`. A Laya judge is configuration, created whatever Laya's state here, and
 * it evaluates only once Laya is enabled and ready; only `laya-noul-v1` is created while `laya-choice2-v1` is refused.
 * v3 replaces exactly the results that carry a judge document or inventory — `judgesList`, `addJudge`, `updateJudge`,
 * `rule-create`, `rule-update` — and adds the D11 Laya limits to the approval view of a rule naming a Laya judge
 * (`contracts/b3-control-v3.schema.json`, vectors in `test/fixtures/b3-control-contract-v3/`). Every other operation
 * answers as v2, and so v1, does. An owner composed without E2's artifact manager still answers v1.
 */
export const B3_CONTROL_V3_SCHEMA_VERSION: Extract<JudgeDocumentContract, 'b3-control-v3'> = 'b3-control-v3';

/** The operations whose request document B3 control v3 widens with a Laya judge. */
export const B3_CONTROL_V3_LAYA_DOCUMENT_REQUESTS: readonly [
  'addJudge',
  'updateJudge',
  'rule-create',
  'rule-update',
  'ruleTest',
] = Object.freeze(['addJudge', 'updateJudge', 'rule-create', 'rule-update', 'ruleTest'] as const);

/** The operations whose result B3 control v3 replaces; every other result is v2's. */
export const B3_CONTROL_V3_LAYA_JUDGE_OPERATIONS: readonly [
  'judgesList',
  'addJudge',
  'updateJudge',
  'rule-create',
  'rule-update',
  'approvalView',
] = Object.freeze(['judgesList', 'addJudge', 'updateJudge', 'rule-create', 'rule-update', 'approvalView'] as const);

export type B3ControlV3LayaJudgeOperation = (typeof B3_CONTROL_V3_LAYA_JUDGE_OPERATIONS)[number];

/**
 * The closed reasons a v3 Laya refusal carries, as `details.reason` with `BAD_DATA` and named in its message: a Laya
 * judge naming another manifest or a template this release does not run is refused when created, and a rule naming a
 * Laya judge is refused when enabled wherever this release or platform does not offer Laya.
 */
export const B3_CONTROL_V3_LAYA_JUDGE_REFUSALS: readonly [
  'E2_EXTERNAL_REFERENCE_BLOCKED',
  'LAYA_PLATFORM_UNAVAILABLE',
  'LAYA_SANDBOX_UNAVAILABLE',
  'LAYA_MANIFEST_NOT_REVIEWED',
  'LAYA_TEMPLATE_BLOCKED',
] = Object.freeze([
  'E2_EXTERNAL_REFERENCE_BLOCKED',
  'LAYA_PLATFORM_UNAVAILABLE',
  'LAYA_SANDBOX_UNAVAILABLE',
  'LAYA_MANIFEST_NOT_REVIEWED',
  'LAYA_TEMPLATE_BLOCKED',
] as const);

export type B3LayaJudgeRefusalReasonV3 = (typeof B3_CONTROL_V3_LAYA_JUDGE_REFUSALS)[number];

/** A creatable Laya judge document: the binary template only. */
export type B3LayaJudgeDocumentV3 = LayaJudgeDocument & { readonly promptTemplate: typeof LAYA_NOUL_TEMPLATE_ID };

/** One content-free inventory row, the same for every kind; a Laya judge's model is its reviewed manifest id. */
export interface B3JudgeInventoryEntryV3 {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: JudgeKind;
  readonly provider: string;
  readonly model: string;
  readonly revokedAt: number | null;
}

export interface B3PendingVersionV3<Kind extends 'judge' | 'rule', Document> {
  readonly id: string;
  readonly kind: Kind;
  readonly objectId: string;
  readonly version: number;
  readonly document: Document;
  readonly digest: string;
  readonly state: null;
}

/**
 * D11's limits for a Laya judge in a rule's approval view: its template and manifest id, the reviewed English-only,
 * 512-token, CPU-only, macOS-only and one-at-a-time texts and the two stated limitations — the same reviewed texts the
 * enablement embeds — and no input text.
 */
export interface B3LayaJudgePreviewV3 {
  readonly judgeId: string;
  readonly version: number;
  readonly promptTemplate: typeof LAYA_NOUL_TEMPLATE_ID;
  readonly manifestId: string;
  readonly limits: Readonly<{
    readonly englishCpu: string;
    readonly macosBoundary: string;
    readonly oneAtATime: string;
  }>;
  readonly limitations: LayaJudgeTerms['limitations'];
}

export type B3LayaRuleApprovalReadyV3 = Extract<B3ApprovalViewResultV1, { readonly kind: 'READY' }> & {
  readonly layaJudge: B3LayaJudgePreviewV3;
};

export interface B3ControlV3LayaJudgeResultsByOperation {
  readonly judgesList: readonly B3JudgeInventoryEntryV3[];
  readonly addJudge: B3PendingVersionV3<'judge', CanonicalJudgeDocument>;
  readonly updateJudge: B3PendingVersionV3<'judge', CanonicalJudgeDocument>;
  readonly 'rule-create': B3PendingVersionV3<'rule', CanonicalFullRuleDocument>;
  readonly 'rule-update': B3PendingVersionV3<'rule', CanonicalFullRuleDocument>;
  readonly approvalView: B3ApprovalViewResultV1 | B3LayaRuleApprovalReadyV3;
}

/** A v3 Laya refusal as a vector records it: the control error's code and its `details.reason`. */
export interface B3LayaJudgeRefusalV3 {
  readonly code: 'BAD_DATA';
  readonly reason: B3LayaJudgeRefusalReasonV3;
}

/**
 * The Laya limits of one rule activation preview, from the reviewed terms of this database's Laya inputs, or
 * undefined when the preview is not a rule naming a Laya judge. It reads only ids and reviewed texts.
 */
export function layaJudgePreviewFor(
  preview: ActivationDocumentV1,
  terms: LayaJudgeTerms,
): B3LayaJudgePreviewV3 | undefined {
  if (preview.kind !== 'rule') return undefined;
  const judge = preview.rule.agentic?.judge;
  if (judge?.kind !== JUDGE_KIND_LAYA) return undefined;
  return {
    judgeId: judge.judgeId,
    version: judge.version,
    promptTemplate: judge.promptTemplate as typeof LAYA_NOUL_TEMPLATE_ID,
    manifestId: judge.model,
    limits: {
      englishCpu: terms.facts.englishCpu,
      macosBoundary: terms.facts.macosBoundary,
      oneAtATime: terms.facts.oneAtATime,
    },
    limitations: terms.limitations,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closed(value: unknown, keys: readonly string[], name: string): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TypeError(`${name} must be a closed object`);
}

function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is a non-empty string`);
}

function positive(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${name} is a positive integer`);
}

/** A Laya judge document B3 v3 can carry: canonical, and naming the one template this release runs. */
function assertCarriedJudge(value: unknown, name: string): void {
  let judge: CanonicalJudgeDocument;
  try {
    judge = canonicalJudge(value);
  } catch {
    throw new TypeError(`${name} is not a canonical judge document`);
  }
  if (judge.kind === JUDGE_KIND_LAYA && !LAYA_RUNNABLE_TEMPLATE_IDS.includes(judge.promptTemplate))
    throw new TypeError(`${name} names a Laya template this release does not run`);
}

function assertPendingVersion(value: unknown, kind: 'judge' | 'rule'): void {
  closed(value, ['id', 'kind', 'objectId', 'version', 'document', 'digest', 'state'], `a pending ${kind} version`);
  if (value.kind !== kind) throw new TypeError(`a pending ${kind} version has the wrong kind`);
  text(value.objectId, `a pending ${kind} object id`);
  positive(value.version, `a pending ${kind} version`);
  if (value.id !== `${value.objectId}@${value.version}`)
    throw new TypeError(`a pending ${kind} version id does not name its object version`);
  if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest))
    throw new TypeError(`a pending ${kind} digest is lowercase SHA-256`);
  if (value.state !== null) throw new TypeError(`a pending ${kind} version must be inert`);
  if (kind === 'judge') {
    assertCarriedJudge(value.document, 'a pending judge document');
    return;
  }
  let rule: CanonicalFullRuleDocument;
  try {
    rule = canonicalFullRuleDocument(value.document);
  } catch {
    throw new TypeError('a pending workflow document is not canonical');
  }
  if (rule.agentic !== undefined) assertCarriedJudge(rule.agentic.judge, 'a pending workflow judge');
}

function assertInventoryEntry(value: unknown): void {
  closed(value, ['judgeId', 'version', 'kind', 'provider', 'model', 'revokedAt'], 'a judge inventory entry');
  text(value.judgeId, 'a judge inventory id');
  positive(value.version, 'a judge inventory version');
  if (!(JUDGE_KINDS as readonly unknown[]).includes(value.kind)) throw new TypeError('a judge inventory kind is known');
  text(value.provider, 'a judge inventory provider');
  text(value.model, 'a judge inventory model');
  if (value.kind === JUDGE_KIND_LAYA && value.provider !== JUDGE_KIND_LAYA)
    throw new TypeError('a Laya inventory entry names the canonical Laya provider');
  if (value.revokedAt !== null && (!Number.isSafeInteger(value.revokedAt) || (value.revokedAt as number) < 0))
    throw new TypeError('a judge inventory revocation time is a non-negative integer or null');
}

/** The runtime companion to the schema's `layaJudgePreview`. */
export function assertLayaJudgePreviewV3(value: unknown): asserts value is B3LayaJudgePreviewV3 {
  closed(
    value,
    ['judgeId', 'version', 'promptTemplate', 'manifestId', 'limits', 'limitations'],
    'a Laya judge preview',
  );
  text(value.judgeId, 'a Laya judge preview id');
  positive(value.version, 'a Laya judge preview version');
  if (value.promptTemplate !== LAYA_NOUL_TEMPLATE_ID) throw new TypeError('a Laya judge preview names its template');
  text(value.manifestId, 'a Laya judge preview manifest id');
  closed(value.limits, ['englishCpu', 'macosBoundary', 'oneAtATime'], 'the Laya judge preview limits');
  for (const limit of Object.values(value.limits)) text(limit, 'a Laya judge preview limit');
  closed(value.limitations, ['sandboxDeprecation', 'englishAccuracy'], 'the Laya judge preview limitations');
  for (const limitation of Object.values(value.limitations)) text(limitation, 'a Laya judge preview limitation');
}

/** The terminal lines that follow a rule preview naming a Laya judge; every line is neutralised like the preview. */
export function renderLayaJudgePreviewV3(value: unknown): readonly string[] {
  assertLayaJudgePreviewV3(value);
  return [
    `Laya judge ${value.judgeId}@${value.version}: template ${value.promptTemplate}, manifest ${value.manifestId}`,
    `Laya limits: ${value.limits.englishCpu} ${value.limits.macosBoundary} ${value.limits.oneAtATime}`,
    `Laya limitations: ${value.limitations.sandboxDeprecation} ${value.limitations.englishAccuracy}`,
  ].map((line) => neutralise(line).text);
}

/** Runtime companion to B3ControlV3LayaJudgeResultsByOperation; the schema is the language-neutral half. */
export function assertB3ControlV3LayaJudgeResult(operation: B3ControlV3LayaJudgeOperation, value: unknown): void {
  switch (operation) {
    case 'judgesList':
      if (!Array.isArray(value)) throw new TypeError('the judge inventory is an array');
      value.forEach(assertInventoryEntry);
      return;
    case 'addJudge':
    case 'updateJudge':
      assertPendingVersion(value, 'judge');
      return;
    case 'rule-create':
    case 'rule-update':
      assertPendingVersion(value, 'rule');
      return;
    case 'approvalView': {
      if (!isRecord(value) || value.kind !== 'READY') return;
      const preview = value.preview as ActivationDocumentV1 | undefined;
      const names =
        preview?.kind === 'rule' &&
        (preview as { readonly rule?: CanonicalFullRuleDocument }).rule?.agentic?.judge.kind === JUDGE_KIND_LAYA;
      if (names !== Object.hasOwn(value, 'layaJudge'))
        throw new TypeError('a ready approval view carries Laya limits exactly when its workflow names a Laya judge');
      if (names) assertLayaJudgePreviewV3(value.layaJudge);
      return;
    }
  }
}

/** Runtime companion to the schema's `layaJudgeRefusal`. */
export function assertB3LayaJudgeRefusalV3(value: unknown): asserts value is B3LayaJudgeRefusalV3 {
  closed(value, ['code', 'reason'], 'a Laya judge refusal');
  if (value.code !== 'BAD_DATA') throw new TypeError('a Laya judge refusal is bad data');
  if (!B3_CONTROL_V3_LAYA_JUDGE_REFUSALS.includes(value.reason as B3LayaJudgeRefusalReasonV3))
    throw new TypeError('a Laya judge refusal names its closed reason');
}
