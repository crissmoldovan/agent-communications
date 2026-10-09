import {
  canonicalDisclosureBinding,
  canonicalJson,
  type DisclosureBinding,
  type DisclosureVersion,
  sha256Hex,
} from '@agentcomms/core';
import {
  type CanonicalCondition,
  canonicaliseCondition,
  catalogueEntry,
  compileMapping,
  isJsonValue,
  type JsonValue,
  TEST_CLOUD_EVENT,
  validateCloudEventType,
} from '@agentcomms/events';
import { EventDomainError, isJudgeKind, type JudgeKind } from './lifecycle.ts';
import { normaliseSourceOptions, type SourceOptions } from './source-options.ts';
import {
  canonicalSseSubscriber,
  canonicalSseTarget,
  type SseSubscriberDocument,
  type SseTargetDocument,
} from './sse-subscriber.ts';
import { canonicalWebhookTarget, type WebhookTargetDocument } from './webhook-target.ts';

export interface DryRunTargetDocument {
  readonly targetId: string;
  readonly version: number;
  readonly kind: 'dry-run';
  readonly retentionMs: number;
}

export type TargetDocument = DryRunTargetDocument | WebhookTargetDocument | SseTargetDocument;

export interface JudgeDocument {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: JudgeKind;
  readonly provider: string;
  readonly model: string;
  readonly [field: string]: unknown;
}

export type SubscriberDocument = SseSubscriberDocument;

export interface RuleRetentionDocument {
  readonly ingestMs: number;
  readonly holdMs: number;
  readonly deliveryMs: number;
  readonly dryrunMs: number;
  readonly sseReplayMs: number;
  readonly deadLetterMs: number;
  readonly decisionMetadataMs: number;
}

export type CanonicalRuleSource =
  | {
      readonly channel: 'gmail';
      readonly accountIds: readonly string[];
      readonly options: Extract<SourceOptions, { channel: 'gmail' }>;
    }
  | {
      readonly channel: 'slack';
      readonly accountIds: readonly string[];
      readonly options: Extract<SourceOptions, { channel: 'slack' }>;
    }
  | {
      readonly channel: 'resend';
      readonly accountIds: readonly string[];
      readonly options: Extract<SourceOptions, { channel: 'resend' }>;
    }
  | {
      readonly channel: 'whatsapp';
      readonly accountIds: readonly string[];
      readonly options: Extract<SourceOptions, { channel: 'whatsapp' }>;
    };

export interface CanonicalFullRuleDocument {
  readonly ruleId: string;
  readonly version: number;
  readonly source: CanonicalRuleSource;
  readonly event: { readonly type: string; readonly version: number };
  readonly condition: CanonicalCondition;
  readonly mapping: JsonValue;
  /** D2/D6: the optional exact CloudEvent `type` override, part of the approval when present; absent means the default. */
  readonly cloudEventType?: string;
  readonly targets: readonly TargetDocument[];
  readonly subscribers: readonly SubscriberDocument[];
  readonly judges: readonly JudgeDocument[];
  readonly deliveryRateCap: number;
  readonly retention: RuleRetentionDocument;
}

export interface JudgeBudgetDocument {
  readonly budgetId: string;
  readonly version: number;
  readonly [field: string]: unknown;
}

export interface JudgeKindEnablementDocument {
  readonly kind: JudgeKind;
  readonly version: number;
  readonly [field: string]: unknown;
}

export type ActivationDocumentV1 =
  | { readonly documentVersion: 1; readonly kind: 'rule'; readonly rule: CanonicalFullRuleDocument }
  | { readonly documentVersion: 1; readonly kind: 'judge-budget'; readonly budget: JudgeBudgetDocument }
  | { readonly documentVersion: 1; readonly kind: 'judge-kind'; readonly enablement: JudgeKindEnablementDocument }
  | {
      readonly documentVersion: 1;
      readonly kind: 'enable-all';
      readonly switchGeneration: number;
      ruleVersions: readonly { readonly ruleId: string; readonly ruleVersion: number }[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, code: EventDomainError['code'] = 'VERSION_DOCUMENT_INVALID'): never {
  throw new EventDomainError(code, message);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(`${name} is a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(`${name} is a positive safe integer`);
  return value as number;
}

function cloneJsonRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) return fail(`${name} is a JSON object`);
  try {
    return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  } catch {
    return fail(`${name} is canonical JSON`);
  }
}

function canonicalJsonValue(value: unknown, name: string): JsonValue {
  if (!isJsonValue(value)) return fail(`${name} is a JSON value`);
  try {
    return JSON.parse(canonicalJson(value)) as JsonValue;
  } catch {
    return fail(`${name} is canonical JSON`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStringSet(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return fail(`${name} is a non-empty array`);
  const values = value.map((entry) => requiredText(entry, name));
  const sorted = [...new Set(values)].sort(compareText);
  if (sorted.length !== values.length) return fail(`${name} has no duplicate values`);
  return sorted;
}

/** The canonical immutable target document — stored, and embedded in every rule that names it. */
export function canonicalTarget(value: unknown): TargetDocument {
  const target = cloneJsonRecord(value, 'a target document');
  switch (target.kind) {
    case 'dry-run': {
      const retentionMs = positiveInteger(target.retentionMs, 'a dry-run retention');
      if (retentionMs > 86_400_000) return fail('a dry-run retention is at most 24 hours');
      return {
        targetId: requiredText(target.targetId, 'a target id'),
        version: positiveInteger(target.version, 'a target version'),
        kind: 'dry-run',
        retentionMs,
      };
    }
    case 'webhook':
      return canonicalWebhookTarget(target);
    case 'sse':
      return canonicalSseTarget(target);
    default:
      return fail('a target document has a known kind');
  }
}

/** The one canonical form of a judge version — stored, and embedded in every rule that names it. */
export function canonicalJudge(value: unknown): JudgeDocument {
  const judge = cloneJsonRecord(value, 'a judge document');
  if (!isJudgeKind(judge.kind)) return fail('a judge document has a known judge kind');
  return {
    ...judge,
    judgeId: requiredText(judge.judgeId, 'a judge id'),
    version: positiveInteger(judge.version, 'a judge version'),
    kind: judge.kind,
    provider: requiredText(judge.provider, 'a judge provider'),
    model: requiredText(judge.model, 'a judge model'),
  };
}

/** The one canonical form of a subscriber version — stored, and embedded in every rule that names it. */
export function canonicalSubscriber(value: unknown): SubscriberDocument {
  const subscriber = cloneJsonRecord(value, 'a subscriber document');
  if (subscriber.kind !== 'sse') return fail('a subscriber document has a known kind');
  return canonicalSseSubscriber(subscriber);
}

function canonicalRetention(value: unknown): RuleRetentionDocument {
  const retention = cloneJsonRecord(value, 'rule retention');
  const result = {
    ingestMs: positiveInteger(retention.ingestMs, 'ingest retention'),
    holdMs: positiveInteger(retention.holdMs, 'hold retention'),
    deliveryMs: positiveInteger(retention.deliveryMs, 'delivery retention'),
    dryrunMs: positiveInteger(retention.dryrunMs, 'dry-run retention'),
    sseReplayMs: positiveInteger(retention.sseReplayMs, 'SSE replay retention'),
    deadLetterMs: positiveInteger(retention.deadLetterMs, 'dead-letter retention'),
    decisionMetadataMs: positiveInteger(retention.decisionMetadataMs, 'decision metadata retention'),
  };
  if (result.holdMs > result.ingestMs) return fail('hold retention cannot outlive ingest retention');
  if (result.dryrunMs > 86_400_000) return fail('dry-run retention is at most 24 hours');
  return result;
}

function canonicalRuleSource(value: unknown): CanonicalRuleSource {
  const source = cloneJsonRecord(value, 'rule source');
  const options = normaliseSourceOptions(source.options);
  if (source.channel !== options.channel) return fail('rule source channel and source options channel agree');
  const accountIds = canonicalStringSet(source.accountIds, 'rule account ids');
  switch (options.channel) {
    case 'gmail':
      return { channel: 'gmail', accountIds, options };
    case 'slack':
      return { channel: 'slack', accountIds, options };
    case 'resend':
      return { channel: 'resend', accountIds, options };
    case 'whatsapp':
      return { channel: 'whatsapp', accountIds, options };
  }
}

/** Validates a Phase-D full rule shape and returns its canonical data-only form. */
export function canonicalFullRuleDocument(value: unknown): CanonicalFullRuleDocument {
  const rule = cloneJsonRecord(value, 'a rule document');
  const source = canonicalRuleSource(rule.source);
  const event = cloneJsonRecord(rule.event, 'rule event');
  const eventType = requiredText(event.type, 'an event type');
  if (eventType === TEST_CLOUD_EVENT.type || eventType === 'io.agentcomms.control.installation-reset.v1') {
    return fail(
      'operational, test and reset controls are not selectable rule event types',
      'EVENT_TYPE_NOT_SELECTABLE',
    );
  }
  const eventVersion = positiveInteger(event.version, 'an event version');
  const definition = catalogueEntry(eventType, eventVersion);
  if (!definition.ok)
    return fail(
      definition.issues[0]?.message ?? 'the event type is not selectable',
      definition.issues[0]?.code as EventDomainError['code'],
    );
  if (!eventType.startsWith(`${source.channel}.`))
    return fail('a rule event type belongs to its source channel', 'SOURCE_CHANNEL_UNSUPPORTED');
  const condition = canonicaliseCondition(definition.value, rule.condition);
  if (!condition.ok) return fail(condition.issues[0]?.message ?? 'the rule condition is not valid');
  const mapping = canonicalJsonValue(rule.mapping, 'rule mapping');
  const compiledMapping = compileMapping(definition.value, mapping);
  if (!compiledMapping.ok) return fail(compiledMapping.issues[0]?.message ?? 'the rule mapping is not valid');

  const targets = Array.isArray(rule.targets) ? rule.targets.map(canonicalTarget) : fail('rule targets are an array');
  if (targets.length === 0) return fail('a B1 rule has at least one dry-run target');
  const subscribers = Array.isArray(rule.subscribers)
    ? rule.subscribers.map(canonicalSubscriber)
    : fail('rule subscribers are an array');
  for (const target of targets) {
    if (target.kind !== 'sse') continue;
    const bound = subscribers.find(
      (subscriber) =>
        subscriber.subscriberId === target.subscriberId && subscriber.version === target.subscriberVersion,
    );
    if (bound === undefined) return fail('an SSE target embeds its exact subscriber version');
  }
  const judges = Array.isArray(rule.judges) ? rule.judges.map(canonicalJudge) : fail('rule judges are an array');
  let cloudEventType: string | undefined;
  if (rule.cloudEventType !== undefined) {
    const chosen = validateCloudEventType(rule.cloudEventType);
    if (!chosen.ok) return fail(chosen.issues[0]?.message ?? 'the rule cloudEventType is not valid');
    cloudEventType = chosen.value;
  }
  return {
    ruleId: requiredText(rule.ruleId, 'a rule id'),
    version: positiveInteger(rule.version, 'a rule version'),
    source,
    event: { type: eventType, version: eventVersion },
    condition: condition.value,
    mapping,
    ...(cloudEventType === undefined ? {} : { cloudEventType }),
    targets,
    subscribers,
    judges,
    deliveryRateCap: positiveInteger(rule.deliveryRateCap, 'rule delivery rate cap'),
    retention: canonicalRetention(rule.retention),
  };
}

function canonicalBudget(value: unknown): JudgeBudgetDocument {
  const budget = cloneJsonRecord(value, 'a judge budget document');
  return {
    ...budget,
    budgetId: requiredText(budget.budgetId, 'a judge budget id'),
    version: positiveInteger(budget.version, 'a judge budget version'),
  };
}

function canonicalEnablement(value: unknown): JudgeKindEnablementDocument {
  const enablement = cloneJsonRecord(value, 'a judge-kind document');
  if (!isJudgeKind(enablement.kind)) return fail('a judge-kind document has a known judge kind');
  return { ...enablement, kind: enablement.kind, version: positiveInteger(enablement.version, 'a judge-kind version') };
}

function canonicalEnableAll(value: unknown): Extract<ActivationDocumentV1, { kind: 'enable-all' }> {
  const document = cloneJsonRecord(value, 'an enable-all document');
  if (!Array.isArray(document.ruleVersions)) return fail('enable-all rule versions are an array');
  const ruleVersions = document.ruleVersions.map((entry) => {
    const row = cloneJsonRecord(entry, 'an enable-all rule version');
    return {
      ruleId: requiredText(row.ruleId, 'an enable-all rule id'),
      ruleVersion: positiveInteger(row.ruleVersion, 'an enable-all rule version'),
    };
  });
  const sorted = [...ruleVersions].sort(
    (left, right) => compareText(left.ruleId, right.ruleId) || left.ruleVersion - right.ruleVersion,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as (typeof sorted)[number];
    const current = sorted[index] as (typeof sorted)[number];
    if (previous.ruleId === current.ruleId && previous.ruleVersion === current.ruleVersion)
      return fail('enable-all rule versions are duplicate-free');
  }
  return {
    documentVersion: 1,
    kind: 'enable-all',
    switchGeneration:
      Number.isSafeInteger(document.switchGeneration) && (document.switchGeneration as number) >= 0
        ? (document.switchGeneration as number)
        : fail('an enable-all switch generation is a non-negative safe integer'),
    ruleVersions: sorted,
  };
}

/** Validates exactly one v1 activation document and normalises only D2's unordered enable-all list. */
export function normaliseActivationDocument(value: unknown): ActivationDocumentV1 {
  const document = cloneJsonRecord(value, 'an activation document');
  if (document.documentVersion !== 1) return fail('an activation document has documentVersion 1');
  if (Object.hasOwn(document, 'versions')) return fail('activation-document versions are derived, never supplied');
  switch (document.kind) {
    case 'rule':
      return { documentVersion: 1, kind: 'rule', rule: canonicalFullRuleDocument(document.rule) };
    case 'judge-budget':
      return { documentVersion: 1, kind: 'judge-budget', budget: canonicalBudget(document.budget) };
    case 'judge-kind':
      return { documentVersion: 1, kind: 'judge-kind', enablement: canonicalEnablement(document.enablement) };
    case 'enable-all':
      return canonicalEnableAll(document);
    default:
      return fail('an activation document has a known kind');
  }
}

/** Core's recursively key-sorted canonical JSON for a complete v1 activation document. */
export function canonicalActivationDocument(document: ActivationDocumentV1): string {
  return canonicalJson(normaliseActivationDocument(document));
}

/** The lowercase SHA-256 disclosure digest of one canonical activation document. */
export function activationDocumentDigest(document: ActivationDocumentV1): string {
  return sha256Hex(canonicalActivationDocument(document));
}

function compareVersions(left: DisclosureVersion, right: DisclosureVersion): number {
  return compareText(left.kind, right.kind) || compareText(left.id, right.id) || left.version - right.version;
}

function derivedVersions(document: ActivationDocumentV1): DisclosureVersion[] {
  switch (document.kind) {
    case 'rule':
      return [
        { kind: 'rule', id: document.rule.ruleId, version: document.rule.version },
        ...document.rule.targets.map((target) => ({
          kind: 'target' as const,
          id: target.targetId,
          version: target.version,
        })),
        ...document.rule.subscribers.map((subscriber) => ({
          kind: 'subscriber' as const,
          id: subscriber.subscriberId,
          version: subscriber.version,
        })),
        ...document.rule.judges.map((judge) => ({ kind: 'judge' as const, id: judge.judgeId, version: judge.version })),
      ];
    case 'judge-budget':
      return [{ kind: 'judge-budget', id: document.budget.budgetId, version: document.budget.version }];
    case 'judge-kind':
      return [{ kind: 'judge-kind', id: document.enablement.kind, version: document.enablement.version }];
    case 'enable-all':
      return document.ruleVersions.map((rule) => ({ kind: 'rule', id: rule.ruleId, version: rule.ruleVersion }));
  }
}

/** Derives, rather than accepts, the exact core standing-disclosure binding for an activation intent. */
export function disclosureBindingFor(activationIntentId: string, input: ActivationDocumentV1): DisclosureBinding {
  const document = normaliseActivationDocument(input);
  const versions = derivedVersions(document).sort(compareVersions);
  for (let index = 1; index < versions.length; index += 1) {
    if (compareVersions(versions[index - 1] as DisclosureVersion, versions[index] as DisclosureVersion) === 0) {
      return fail('an activation document cannot derive duplicate disclosure versions');
    }
  }
  return canonicalDisclosureBinding({
    activationIntentId: requiredText(activationIntentId, 'an activation intent id'),
    activationKind: document.kind,
    digest: sha256Hex(canonicalJson(document)),
    versions,
  });
}
