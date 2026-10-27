import {
  canonicalDisclosureBinding,
  canonicalJson,
  type DisclosureBinding,
  type DisclosureVersion,
  sha256Hex,
} from '@agentcomms/core';
import {
  type AgenticConditionV1,
  type CanonicalCondition,
  canonicaliseAgenticCondition,
  canonicaliseCondition,
  catalogueEntry,
  compileMapping,
  type FlowDocumentV1,
  isJsonValue,
  type JsonValue,
  TEST_CLOUD_EVENT,
  targetQueues,
  validateCloudEventType,
} from '@agentcomms/events';
import {
  assertFlowDocumentSize,
  assertNoFlowOnlyTargets,
  canonicalFlowInRule,
  isClosedSlot,
  type RuleWithoutFlow,
} from './flow.ts';
import {
  type CanonicalJudgeBudgetDocument,
  type CanonicalJudgeDocument,
  type CanonicalJudgeKindEnablementDocument,
  canonicalJudge,
  canonicalJudgeBudget,
  canonicalJudgeKindEnablement,
  type LayaEnablementInputs,
} from './judges.ts';
import { EventDomainError } from './lifecycle.ts';
import {
  canonicalLinearChangeTarget,
  type LinearChangeTargetDocument,
  linearChangeSlots,
} from './linear-change-target.ts';
import {
  assertLinearSlotsMapped,
  canonicalLinearTarget,
  type LinearTargetDocument,
  mappedFields,
  slotOrigin,
} from './linear-target.ts';
import {
  assertQueueMapping,
  canonicalQueueTarget,
  isQueueRetention,
  type QueueTargetDocument,
} from './queue-target.ts';
import {
  assertSessionMapping,
  assertSessionStepParts,
  canonicalSessionTarget,
  type SessionTargetDocument,
} from './session-target.ts';
import { normaliseSourceOptions, type SourceOptions } from './source-options.ts';
import {
  canonicalSseSubscriber,
  canonicalSseTarget,
  type SseSubscriberDocument,
  type SseTargetDocument,
} from './sse-subscriber.ts';
import { canonicalWebhookSubscriber, type WebhookSubscriberDocument } from './webhook-subscriber.ts';
import { canonicalWebhookTarget, type WebhookTargetDocument } from './webhook-target.ts';

export interface DryRunTargetDocument {
  readonly targetId: string;
  readonly version: number;
  readonly kind: 'dry-run';
  readonly retentionMs: number;
}

export type TargetDocument =
  | DryRunTargetDocument
  | WebhookTargetDocument
  | SseTargetDocument
  | QueueTargetDocument
  | SessionTargetDocument
  | LinearTargetDocument
  | LinearChangeTargetDocument;

export type { LinearChangeTargetDocument } from './linear-change-target.ts';
export type { LinearTargetDocument } from './linear-target.ts';
export type { QueueTargetDocument } from './queue-target.ts';
export type { SessionTargetDocument } from './session-target.ts';

/**
 * The lane a target carries (routing design B5): a queue target's lane, or the lane an agent-session target finds its
 * session by (0.33.0 design §3.5) — its items fall back to that lane's queue, so it carries the lane as a queue does.
 */
export function targetLane(target: TargetDocument): string | undefined {
  if (target.kind === 'queue') return target.lane?.name;
  if (target.kind === 'session' && 'lane' in target.find) return target.find.lane;
  return undefined;
}

export type JudgeDocument = CanonicalJudgeDocument;

export type CanonicalAgenticCondition = Omit<AgenticConditionV1, 'judge'> & {
  readonly judge: CanonicalJudgeDocument;
};

/** A subscriber version: live on this Mac (`sse`), or off it by signed webhook (`webhook`, 0.36.0, W29). */
export type SubscriberDocument = SseSubscriberDocument | WebhookSubscriberDocument;

export interface RuleRetentionDocument {
  readonly ingestMs: number;
  readonly holdMs: number;
  readonly deliveryMs: number;
  readonly dryrunMs: number;
  readonly sseReplayMs: number;
  readonly deadLetterMs: number;
  readonly decisionMetadataMs: number;
  /**
   * The action queue's item retention (action queue design Q2): present exactly when the rule has a queue target, and
   * omitted from the canonical form otherwise, so every rule stored before it keeps its bytes and its digest.
   */
  readonly queueMs?: number;
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
  /** An optional exact judge authority; deterministic matching remains mandatory without it. */
  readonly agentic?: CanonicalAgenticCondition;
  readonly mapping: JsonValue;
  /** D2/D6: the optional exact CloudEvent `type` override, part of the approval when present; absent means the default. */
  readonly cloudEventType?: string;
  readonly targets: readonly TargetDocument[];
  /** The SSE subscribers this workflow's SSE targets bind; a webhook subscriber is never bound by a target. */
  readonly subscribers: readonly SseSubscriberDocument[];
  readonly judges: readonly JudgeDocument[];
  readonly deliveryRateCap: number;
  readonly retention: RuleRetentionDocument;
  /**
   * A workflow's graph (workflows design W1, §4.1): present, its steps replace the straight fan-out to every target;
   * absent, the workflow is today's straight line, and every document stored before it keeps its bytes and its digest.
   */
  readonly flow?: FlowDocumentV1;
}

/** The fields a workflow document may hold, and no other (workflows design W19's hardening). */
const RULE_DOCUMENT_KEYS: readonly string[] = [
  'ruleId',
  'version',
  'source',
  'event',
  'condition',
  'agentic',
  'mapping',
  'cloudEventType',
  'targets',
  'subscribers',
  'judges',
  'deliveryRateCap',
  'retention',
  'flow',
];

export type JudgeBudgetDocument = CanonicalJudgeBudgetDocument;

export type JudgeKindEnablementDocument = CanonicalJudgeKindEnablementDocument;

export type ActivationDocumentV1 =
  | { readonly documentVersion: 1; readonly kind: 'rule'; readonly rule: CanonicalFullRuleDocument }
  | { readonly documentVersion: 1; readonly kind: 'judge-budget'; readonly budget: JudgeBudgetDocument }
  | { readonly documentVersion: 1; readonly kind: 'judge-kind'; readonly enablement: JudgeKindEnablementDocument }
  | {
      readonly documentVersion: 1;
      readonly kind: 'enable-all';
      readonly switchGeneration: number;
      ruleVersions: readonly { readonly ruleId: string; readonly ruleVersion: number }[];
    }
  /**
   * One subscriber version's events, approved by the person (0.36.0, W29): the exact version, bound by its stored
   * document's digest, so the approval names what it receives, in which namespaces, with or without senders' words.
   */
  | {
      readonly documentVersion: 1;
      readonly kind: 'subscription';
      readonly subscription: { readonly subscriberId: string; readonly version: number; readonly digest: string };
    };

/** Synthetic fixtures can replace only reviewed Laya asset bytes in an otherwise production path. */
export interface ActivationDocumentCanonicalisationOptions extends LayaEnablementInputs {}

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
    case 'queue':
      return canonicalQueueTarget(target);
    case 'session':
      return canonicalSessionTarget(target);
    case 'linear':
      return canonicalLinearTarget(target);
    case 'linear-change':
      return canonicalLinearChangeTarget(target);
    default:
      return fail('a target document has a known kind');
  }
}

export { canonicalJudge } from './judges.ts';

/** The one canonical form of a subscriber version — stored, and embedded in every rule that names it. */
export function canonicalSubscriber(value: unknown): SubscriberDocument {
  const subscriber = cloneJsonRecord(value, 'a subscriber document');
  if (subscriber.kind === 'sse') return canonicalSseSubscriber(subscriber);
  if (subscriber.kind === 'webhook') return canonicalWebhookSubscriber(subscriber);
  return fail('a subscriber document has a known kind');
}

/** A subscriber a workflow's SSE targets bind: an SSE one only (§4.2). */
function canonicalBoundSubscriber(value: unknown): SseSubscriberDocument {
  const subscriber = cloneJsonRecord(value, 'a subscriber document');
  if (subscriber.kind !== 'sse') return fail("a workflow's subscribers are SSE subscribers its SSE targets bind");
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
  if (retention.queueMs === undefined) return result;
  if (!isQueueRetention(retention.queueMs)) return fail('queue retention (queueMs) is 1 to 30 days, in milliseconds');
  return { ...result, queueMs: retention.queueMs };
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

/**
 * A lane is its name (routing design B5): within one rule, two different queue targets cannot carry the same lane. The
 * activation check (`ImmutableVersions.prepareRule`) holds the same across every active rule.
 */
function assertOneTargetPerLane(targets: readonly TargetDocument[]): void {
  const carriers = new Map<string, string>();
  for (const target of targets) {
    const lane = targetLane(target);
    if (lane === undefined) continue;
    const carrier = carriers.get(lane);
    if (carrier !== undefined && carrier !== target.targetId)
      fail(
        `lane ${lane} is carried by two targets of this rule; a lane is its name, so one target carries it`,
        'LANE_NAME_IN_USE',
      );
    carriers.set(lane, target.targetId);
  }
}

/** Validates a Phase-D full rule shape and returns its canonical data-only form. */
export function canonicalFullRuleDocument(value: unknown): CanonicalFullRuleDocument {
  const rule = cloneJsonRecord(value, 'a rule document');
  for (const key of Object.keys(rule))
    if (!RULE_DOCUMENT_KEYS.includes(key)) return fail(`a workflow document has no field ${key}`);
  const inFlow = rule.flow !== undefined;
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
  let agentic: CanonicalAgenticCondition | undefined;
  if (rule.agentic !== undefined) {
    const canonical = canonicaliseAgenticCondition(definition.value, condition.value, rule.agentic);
    if (!canonical.ok) return fail(canonical.issues[0]?.message ?? 'the rule agentic condition is not valid');
    agentic = { ...canonical.value, judge: canonicalJudge(canonical.value.judge) };
  }
  const mapping = canonicalJsonValue(rule.mapping, 'rule mapping');
  const compiledMapping = compileMapping(definition.value, mapping);
  if (!compiledMapping.ok) return fail(compiledMapping.issues[0]?.message ?? 'the rule mapping is not valid');

  const targets = Array.isArray(rule.targets) ? rule.targets.map(canonicalTarget) : fail('rule targets are an array');
  // A workflow with a flow names the targets its steps deliver to, which may be none (a flow that only notifies).
  if (targets.length === 0 && !inFlow) return fail('a B1 rule has at least one dry-run target');
  assertOneTargetPerLane(targets);
  const subscribers = Array.isArray(rule.subscribers)
    ? rule.subscribers.map(canonicalBoundSubscriber)
    : fail('rule subscribers are an array');
  for (const target of targets) {
    if (target.kind !== 'sse') continue;
    const bound = subscribers.find(
      (subscriber) =>
        subscriber.subscriberId === target.subscriberId && subscriber.version === target.subscriberVersion,
    );
    if (bound === undefined) return fail('an SSE target embeds its exact subscriber version');
  }
  /* Phase D carried an empty compatibility array. Agentic authority is now exclusively rule.agentic. */
  const judges = Array.isArray(rule.judges) ? rule.judges.map(canonicalJudge) : fail('rule judges are an array');
  if (judges.length !== 0) return fail('rule judges are represented only by the optional agentic sibling');
  const retention = canonicalRetention(rule.retention);
  // Q2 and Q4: a queue target needs its own retention on the rule and a mapping that includes what its items show; so
  // does a session target that can leave an item in the Queue (0.33.0 §3.5), and `targetQueues` is the one test.
  const queued = targets.some(targetQueues);
  // §2's anti-goal: a session receives no field the approved rule does not map.
  for (const target of targets) if (target.kind === 'session') assertSessionMapping(target, mapping);
  // A `{ step, field }` context part reads a flow step's closed output: no step exists outside a flow (0.36 §6.4).
  for (const target of targets) if (target.kind === 'session') assertSessionStepParts(target, inFlow);
  // The session the flow chose, and a Linear change, exist only inside a flow (W5).
  if (!inFlow) assertNoFlowOnlyTargets(targets);
  if (queued && retention.queueMs === undefined) return fail('a rule with a queue target sets retention.queueMs');
  if (!queued && retention.queueMs !== undefined)
    return fail('retention.queueMs applies only to a rule with a queue target');
  if (queued) assertQueueMapping(eventType, mapping);
  // A Linear target's slots name the rule's mapped fields only (0.33.0 design §3.4): nothing else reaches Linear. In a
  // flow a slot may also name the run's own values — its id, a step's closed output — which the flow's checks hold.
  for (const target of targets)
    if (target.kind === 'linear')
      assertLinearSlotsMapped(target, compiledMapping.value, inFlow ? isClosedSlot : undefined);
  for (const target of targets)
    if (target.kind === 'linear-change') assertLinearChangeSlotsMapped(target, compiledMapping.value);
  let cloudEventType: string | undefined;
  if (rule.cloudEventType !== undefined) {
    const chosen = validateCloudEventType(rule.cloudEventType);
    if (!chosen.ok) return fail(chosen.issues[0]?.message ?? 'the rule cloudEventType is not valid');
    cloudEventType = chosen.value;
  }
  const canonical: RuleWithoutFlow = {
    ruleId: requiredText(rule.ruleId, 'a rule id'),
    version: positiveInteger(rule.version, 'a rule version'),
    source,
    event: { type: eventType, version: eventVersion },
    condition: condition.value,
    ...(agentic === undefined ? {} : { agentic }),
    mapping,
    ...(cloudEventType === undefined ? {} : { cloudEventType }),
    targets,
    subscribers,
    judges,
    deliveryRateCap: positiveInteger(rule.deliveryRateCap, 'rule delivery rate cap'),
    retention,
  };
  // W1, W2: `flow` only when the workflow has one, so every document stored before 0.36 keeps its bytes.
  if (!inFlow) return canonical;
  const withFlow: CanonicalFullRuleDocument = { ...canonical, flow: canonicalFlowInRule(canonical, rule.flow) };
  assertFlowDocumentSize(withFlow);
  return withFlow;
}

/**
 * A Linear change's comment names the run's own values or the rule's mapped fields, as a Linear target's description
 * does: a slot naming a field the rule does not keep is refused.
 */
function assertLinearChangeSlotsMapped(
  target: LinearChangeTargetDocument,
  mapping: Parameters<typeof mappedFields>[0],
): void {
  const fields = mappedFields(mapping);
  for (const slot of linearChangeSlots(target)) {
    if (isClosedSlot(slot) || slotOrigin(fields, slot) !== undefined) continue;
    const known = [...fields.keys()];
    fail(
      `Linear change ${target.targetId}'s comment names {{${slot}}}, which the workflow does not keep; ${
        known.length === 0 ? 'it keeps no field' : `it keeps ${known.join(', ')}`
      }`,
      'TEMPLATE_FIELD_NOT_MAPPED',
    );
  }
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

function canonicalSubscription(value: unknown): Extract<ActivationDocumentV1, { kind: 'subscription' }> {
  const document = cloneJsonRecord(value, 'a subscription document');
  for (const key of Object.keys(document))
    if (!['documentVersion', 'kind', 'subscription'].includes(key))
      return fail(`a subscription document has no field ${key}`);
  const subscription = cloneJsonRecord(document.subscription, 'a subscription');
  for (const key of Object.keys(subscription))
    if (!['digest', 'subscriberId', 'version'].includes(key)) return fail(`a subscription has no field ${key}`);
  const digest = requiredText(subscription.digest, "a subscription's subscriber digest");
  if (!/^[0-9a-f]{64}$/.test(digest)) return fail("a subscription's subscriber digest is a lowercase SHA-256");
  return {
    documentVersion: 1,
    kind: 'subscription',
    subscription: {
      subscriberId: requiredText(subscription.subscriberId, "a subscription's subscriber id"),
      version: positiveInteger(subscription.version, "a subscription's subscriber version"),
      digest,
    },
  };
}

/** Validates exactly one v1 activation document and normalises only D2's unordered enable-all list. */
export function normaliseActivationDocument(
  value: unknown,
  options: ActivationDocumentCanonicalisationOptions = {},
): ActivationDocumentV1 {
  const document = cloneJsonRecord(value, 'an activation document');
  if (document.documentVersion !== 1) return fail('an activation document has documentVersion 1');
  if (Object.hasOwn(document, 'versions')) return fail('activation-document versions are derived, never supplied');
  switch (document.kind) {
    case 'rule':
      return { documentVersion: 1, kind: 'rule', rule: canonicalFullRuleDocument(document.rule) };
    case 'judge-budget':
      return { documentVersion: 1, kind: 'judge-budget', budget: canonicalJudgeBudget(document.budget) };
    case 'judge-kind':
      return {
        documentVersion: 1,
        kind: 'judge-kind',
        enablement: canonicalJudgeKindEnablement(document.enablement, options),
      };
    case 'enable-all':
      return canonicalEnableAll(document);
    case 'subscription':
      return canonicalSubscription(document);
    default:
      return fail('an activation document has a known kind');
  }
}

/** Core's recursively key-sorted canonical JSON for a complete v1 activation document. */
export function canonicalActivationDocument(
  document: ActivationDocumentV1,
  options: ActivationDocumentCanonicalisationOptions = {},
): string {
  return canonicalJson(normaliseActivationDocument(document, options));
}

/** The lowercase SHA-256 disclosure digest of one canonical activation document. */
export function activationDocumentDigest(
  document: ActivationDocumentV1,
  options: ActivationDocumentCanonicalisationOptions = {},
): string {
  return sha256Hex(canonicalActivationDocument(document, options));
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
        ...(document.rule.agentic === undefined
          ? []
          : [
              {
                kind: 'judge' as const,
                id: document.rule.agentic.judge.judgeId,
                version: document.rule.agentic.judge.version,
              },
            ]),
      ];
    case 'judge-budget':
      return [{ kind: 'judge-budget', id: document.budget.budgetId, version: document.budget.version }];
    case 'judge-kind':
      return [{ kind: 'judge-kind', id: document.enablement.kind, version: document.enablement.version }];
    case 'enable-all':
      return document.ruleVersions.map((rule) => ({ kind: 'rule', id: rule.ruleId, version: rule.ruleVersion }));
    case 'subscription':
      return [{ kind: 'subscriber', id: document.subscription.subscriberId, version: document.subscription.version }];
  }
}

/** Derives, rather than accepts, the exact core standing-disclosure binding for an activation intent. */
export function disclosureBindingFor(
  activationIntentId: string,
  input: ActivationDocumentV1,
  options: ActivationDocumentCanonicalisationOptions = {},
): DisclosureBinding {
  const document = normaliseActivationDocument(input, options);
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
