import {
  canonicalDisclosureBinding,
  canonicalJson,
  type DisclosureActivationKind,
  type DisclosureBinding,
  type DisclosureVersionKind,
  neutralise,
} from '@agentcomms/core';
import { describeRule, isJsonValue, type JsonValue, WORKFLOW_EVENT_CATALOGUE_V1 } from '@agentcomms/events';
import {
  type ActivationDocumentV1,
  type CanonicalFullRuleDocument,
  canonicalFullRuleDocument,
  canonicalJudge,
  canonicalSubscriber,
  canonicalTarget,
  type JudgeBudgetDocument,
  normaliseActivationDocument,
  type SessionTargetDocument,
  type SubscriberDocument,
  type TargetDocument,
  targetLane,
} from '../domain/activation-documents.ts';
import { ACTIVATION_FAILURE_CODES, type ActivationFailureCode } from '../domain/activation-failure-codes.ts';
import { ANALYSE_PROVIDERS, ANALYSE_ROUTES, type AnalyseProvider } from '../domain/analyse-model.ts';
import { PERSON_CHANGE_APPROVERS, type SetupJudgeKind } from '../domain/judge-setup.ts';
import type { CanonicalJudgeDocument, JevProvider } from '../domain/judges.ts';
import {
  isActivityKey,
  isClaudeCodeSessionId,
  isLaneName,
  type LaneBindingV1,
  type LaneBindResultV1,
  type LaneListResultV1,
  type LaneUnbindResultV1,
} from '../domain/lanes.ts';
import { JUDGE_KIND_LOCAL_ENDPOINT, JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';
import { linearChangeTargetDisclosure } from '../domain/linear-change-target.ts';
import { isLinearId, linearTargetDisclosure } from '../domain/linear-target.ts';
import {
  isEventId,
  isMessagesCursor,
  MESSAGE_DECISION_OUTCOMES,
  MESSAGE_DELIVERY_STATES,
  MESSAGE_TARGET_KINDS,
  MESSAGES_LIST_MAX_LIMIT,
  type MessageShowResultV1,
  type MessagesListResultV1,
} from '../domain/messages.ts';
import {
  PROJECT_SCAN_SKIP_REASONS,
  type ProjectRemoveResultV1,
  type ProjectScanResultV1,
  type ProjectsListResultV1,
  type ProjectV1,
} from '../domain/projects.ts';
import { type EventSecretProvider, isEventSecretProvider } from '../domain/providers.ts';
import {
  isQueueItemId,
  QUEUE_CHANNELS,
  QUEUE_JUDGE_ANSWERS,
  QUEUE_JUDGE_STATES,
  QUEUE_LINK_KINDS,
  QUEUE_STATES,
  type QueueChannel,
  type QueueStateFilter,
} from '../domain/queue-target.ts';
import { ANALYSE_WINDOW_DAYS, RULE_ANALYSE_PARTS, type RuleAnalyseResultV1 } from '../domain/rule-analyse.ts';
import type { AgentSessionsIntegrationV1 } from '../runtime/agent-sessions.ts';
import {
  type B3ControlWireOperation,
  type DesktopControlWireOperation,
  isB3ControlWireOperation,
  OWNER_CONTROL_WIRE_OPERATIONS,
} from '../runtime/control-operation-registry.ts';
import type { DeliveryShowResultV1 } from '../runtime/delivery-show.ts';
import type { WorkflowEventsListResultV1, WorkflowEventsShowResultV1 } from '../runtime/events/catalogue.ts';
import type {
  EnableAllApprovalResultV1,
  JudgeSetupResultV1,
  ProviderKeyResultV1,
  ProviderListResultV1,
  RuleApprovalResultV1,
  SubscriptionApprovalResultV1,
} from '../runtime/judge-setup.ts';
import type { JudgeShowResultV1 } from '../runtime/judge-show.ts';
import type { IntegrationShowResultV1 } from '../runtime/linear-integration.ts';
import type {
  QueueClearResultV1,
  QueueCountsResultV1,
  QueueItemsResultV1,
  QueueItemV1,
  QueueListResultV1,
  QueueStateChangeResultV1,
} from '../runtime/queue.ts';
import type { TighteningPreview } from '../runtime/queue-tightening.ts';
import type { SessionQueueDropResultV1, SessionQueueListResultV1 } from '../runtime/session-queue.ts';
import type { DeliveryRepresentation } from '../runtime/target-delivery.ts';
import { renderLayaJudgePreviewV3 } from './b3-control-v3.ts';
import type { DoctorReportV1 } from './doctor.ts';

/**
 * The data-only promise B3 makes before any public B3 registration exists. Task 5 consumes these rows when it wires
 * Commander and MCP; Task 9 adds the language-neutral schema and vectors without changing their vocabulary.
 */
export const B3_EXCEPTION_REASON_SECRET =
  'secret material must never enter model input or output; the person completes this operation at the terminal or app.';

/** C may replace this only after the daemon verifies its future non-forgeable secret-window capability. */
export const B3_SECRET_TERMINAL_ORIGIN = 'interactive-terminal';

/** The data-only capability rows have exactly these publication states. */
export const B3_CAPABILITY_STATUSES: readonly ['both', 'exception'] = Object.freeze(['both', 'exception'] as const);
export type B3CapabilityStatus = (typeof B3_CAPABILITY_STATUSES)[number];

export interface B3CapabilityContract {
  readonly id: `events-daemon.${string}`;
  readonly cli: string;
  readonly mcp: string | null;
  readonly operation: string;
  readonly status: B3CapabilityStatus;
  readonly reason?: string | undefined;
  readonly secret?: true | undefined;
}

/** Closed by the owner dispatcher’s registry; registrar/owner seams cannot invent a second control wire name. */
export type B3ControlOperation = B3ControlWireOperation;

/**
 * The complete set of daemon capabilities a desktop control client can invoke. `run` and the MCP-server entry
 * point are deliberately absent: they start processes rather than call a running owner's control protocol. The
 * contract drift test derives this set from capabilities.json, which is the repository-wide authority.
 */
export const B3_DESKTOP_CONTROL_OPERATIONS: readonly DesktopControlWireOperation[] = Object.freeze(
  OWNER_CONTROL_WIRE_OPERATIONS.filter((entry) => entry.desktopCallable).map(
    ({ wireOperation }) => wireOperation as DesktopControlWireOperation,
  ),
);

export type B3DesktopControlOperation = DesktopControlWireOperation;

const both = <
  const Id extends `events-daemon.${string}`,
  const Cli extends string,
  const Mcp extends string,
  const Operation extends B3ControlOperation,
>(
  id: Id,
  cli: Cli,
  mcp: Mcp,
  operation: Operation,
) =>
  ({
    id,
    cli,
    mcp,
    operation,
    status: 'both',
  }) as const satisfies B3CapabilityContract;

const exception = <
  const Id extends `events-daemon.${string}`,
  const Cli extends string,
  const Operation extends B3ControlOperation,
>(
  id: Id,
  cli: Cli,
  operation: Operation,
  reason: string,
  secret?: true,
): B3CapabilityContract & { readonly id: Id; readonly cli: Cli; readonly operation: Operation } =>
  ({
    id,
    cli,
    mcp: null,
    operation,
    status: 'exception',
    reason,
    ...(secret ? { secret } : {}),
  }) as const;

export const B3_CAPABILITIES: readonly B3CapabilityContract[] = Object.freeze([
  both(
    'events-daemon.approval.view',
    'approval view <approval-id> --digest <digest>',
    'events_approval_view',
    'approvalView',
  ),
  both('events-daemon.rule.test', 'workflow test <document> <catalogue-example>', 'events_rule_test', 'ruleTest'),
  exception(
    'events-daemon.rule.test-retained',
    'workflow test-retained <event-id> --workflow <workflow-id> --version <n>',
    'ruleTestRetained',
    'Retained sender content may be selected only by a person outside model context.',
  ),
  both('events-daemon.target.test', 'target test <target-id> --version <n>', 'events_target_test', 'targetTest'),
  exception(
    'events-daemon.target.resume',
    'target resume <target-id> --version <n>',
    'targetResume',
    'A person, not model context, decides to reopen a degraded target reset barrier.',
  ),
  both('events-daemon.subscribers.list', 'subscribers list', 'events_subscribers_list', 'subscribersList'),
  both('events-daemon.subscriber.add', 'subscriber add <document>', 'events_subscriber_add', 'addSubscriber'),
  both(
    'events-daemon.subscriber.update',
    'subscriber update <document>',
    'events_subscriber_update',
    'updateSubscriber',
  ),
  both(
    'events-daemon.subscriber.remove',
    'subscriber remove <subscriber-id>',
    'events_subscriber_remove',
    'removeSubscriber',
  ),
  both('events-daemon.judges.list', 'judges list', 'events_judges_list', 'judgesList'),
  both('events-daemon.judge.add', 'judge add <document>', 'events_judge_add', 'addJudge'),
  both('events-daemon.judge.update', 'judge update <document>', 'events_judge_update', 'updateJudge'),
  both('events-daemon.judge.remove', 'judge remove <judge-id>', 'events_judge_remove', 'removeJudge'),
  both('events-daemon.judge.test', 'judge test <judge-id> --version <n>', 'events_judge_test', 'judgeTest'),
  both('events-daemon.budget.show', 'budget show', 'events_budget_show', 'budgetShow'),
  both('events-daemon.budget.update', 'budget update <document>', 'events_budget_update', 'updateBudget'),
  both('events-daemon.judge-kinds.list', 'judge kinds list', 'events_judge_kinds_list', 'judgeKindsList'),
  both('events-daemon.judge-kind.enable', 'judge kind enable <kind>', 'events_judge_kind_enable', 'enableJudgeKind'),
  both(
    'events-daemon.judge-kind.disable',
    'judge kind disable <kind>',
    'events_judge_kind_disable',
    'disableJudgeKind',
  ),
  both('events-daemon.judge-model.status', 'judge model status', 'events_judge_model_status', 'judgeModelStatus'),
  both('events-daemon.judge-model.remove', 'judge model remove', 'events_judge_model_remove', 'removeJudgeModel'),
  both('events-daemon.deliveries.list', 'deliveries list', 'events_deliveries_list', 'deliveriesList'),
  both('events-daemon.delivery.retry', 'delivery retry <delivery-id>', 'events_delivery_retry', 'retryDelivery'),
  both('events-daemon.delivery.drop', 'delivery drop <delivery-id>', 'events_delivery_drop', 'dropDelivery'),
  both('events-daemon.held.list', 'held list', 'events_held_list', 'heldList'),
  exception(
    'events-daemon.held.decide',
    'held decide <decision-id> <accept|reject>',
    'decideHeld',
    'A held model decision can be resolved only by a person at terminal/app, never by model context.',
  ),
  exception(
    'events-daemon.target-secret.create',
    'target secret create <target-id> --version <n>',
    'targetSecretCreate',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.target-secret.rotate',
    'target secret rotate <target-id> --version <n>',
    'targetSecretRotate',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.target-url.set',
    'target url set <target-id> (--predecessor-version <n> | --draft <inert-target-document>) --new-version <n>',
    'targetUrlSet',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.subscriber-token.create',
    'subscriber token create <subscriber-id> --version <n>',
    'subscriberTokenCreate',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.subscriber-token.rotate',
    'subscriber token rotate <subscriber-id> --version <n>',
    'subscriberTokenRotate',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.subscriber-secret.create',
    'subscriber secret create <subscriber-id> --version <n>',
    'subscriberSecretCreate',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.subscriber-secret.rotate',
    'subscriber secret rotate <subscriber-id> --version <n>',
    'subscriberSecretRotate',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.subscriber-url.set',
    'subscriber url set <subscriber-id> --version <n>',
    'subscriberUrlSet',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.judge-key.set',
    'judge key set <judge-id> --version <n>',
    'judgeKeySet',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.judge-key.rotate',
    'judge key rotate <judge-id> --version <n>',
    'judgeKeyRotate',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
  exception(
    'events-daemon.secrets.migrate',
    'secrets migrate --to keychain|file',
    'migrateSecrets',
    B3_EXCEPTION_REASON_SECRET,
    true,
  ),
]);

export const B3_SECRET_OPERATIONS: ReadonlySet<B3ControlOperation> = new Set(
  B3_CAPABILITIES.filter((capability) => capability.secret === true).map(
    ({ operation }) => operation as B3ControlOperation,
  ),
);

/** The owner accepts only the B3 operation vocabulary that its future CLI/MCP registrars may expose. */
export function isB3ControlOperation(value: string): value is B3ControlOperation {
  return isB3ControlWireOperation(value);
}

export function isB3SecretOperation(value: B3ControlOperation): boolean {
  return B3_SECRET_OPERATIONS.has(value);
}

export const B3_APPROVAL_VIEW_VARIANTS: readonly ['READY', 'STALE_APPROVAL', 'DIGEST_MISMATCH', 'CHALLENGE_EXPIRED'] =
  Object.freeze(['READY', 'STALE_APPROVAL', 'DIGEST_MISMATCH', 'CHALLENGE_EXPIRED'] as const);

export type B3ApprovalViewVariant = (typeof B3_APPROVAL_VIEW_VARIANTS)[number];

/** Human-only held-decision actions; C consumes this vocabulary without re-declaring it. */
export const B3_HELD_DECISIONS: readonly ['accept', 'reject'] = Object.freeze(['accept', 'reject'] as const);
export type B3HeldDecision = (typeof B3_HELD_DECISIONS)[number];

/** Secret-store destinations are data-only labels, never a secret value or credential. */
export const B3_SECRET_BACKENDS: readonly ['file', 'keychain'] = Object.freeze(['file', 'keychain'] as const);
export type B3SecretBackend = (typeof B3_SECRET_BACKENDS)[number];

/** The one pending-target request is only valid on a person-facing approval surface. */
export const B3_PENDING_TARGET_APPROVAL_SURFACES: readonly ['terminal-approval', 'app-approval-screen'] = Object.freeze(
  ['terminal-approval', 'app-approval-screen'] as const,
);
export type B3PendingTargetApprovalSurface = (typeof B3_PENDING_TARGET_APPROVAL_SURFACES)[number];

/** An owner-built binding to one target in a still-pending rule activation. */
export interface B3PendingTargetSelectorV1 {
  readonly kind: 'pending-activation';
  readonly activationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
}

export const B3_JUDGE_UNAVAILABLE_VARIANTS: readonly [
  { readonly code: 'E_REQUIRED'; readonly phase: 'E' },
  { readonly code: 'E2_REQUIRED'; readonly phase: 'E2' },
] = Object.freeze([
  { code: 'E_REQUIRED', phase: 'E' },
  { code: 'E2_REQUIRED', phase: 'E2' },
] as const);

export type B3JudgeUnavailable = (typeof B3_JUDGE_UNAVAILABLE_VARIANTS)[number];

/** The closed result discriminants which E/E2 later produce behind these same operations. */
export const B3_UNAVAILABLE_RESULT_KINDS: readonly ['unavailable'] = Object.freeze(['unavailable'] as const);
export type B3UnavailableResultKind = (typeof B3_UNAVAILABLE_RESULT_KINDS)[number];

export type B3JudgeUnavailableV1 = Readonly<{ readonly kind: B3UnavailableResultKind } & B3JudgeUnavailable>;
export type B3ERequiredUnavailableV1 = Extract<B3JudgeUnavailableV1, { readonly code: 'E_REQUIRED' }>;
export type B3E2RequiredUnavailableV1 = Extract<B3JudgeUnavailableV1, { readonly code: 'E2_REQUIRED' }>;

/** Before E there are no held decisions, but this remains a typed result rather than a missing operation. */
export const B3_HELD_LIST_RESULTS: readonly [{ readonly kind: 'held-list'; readonly decisions: readonly [] }] =
  Object.freeze([{ kind: 'held-list', decisions: [] }] as const);
export type B3HeldListV1 = (typeof B3_HELD_LIST_RESULTS)[number];

/** `held decide` remains a human-only B3 exception and has no pre-E producer. */
export const B3_HOLDS_UNAVAILABLE_RESULTS: readonly [
  { readonly kind: 'unavailable'; readonly code: 'HOLDS_UNAVAILABLE'; readonly phase: 'E' },
] = Object.freeze([{ kind: 'unavailable', code: 'HOLDS_UNAVAILABLE', phase: 'E' }] as const);
export type B3HoldsUnavailableV1 = (typeof B3_HOLDS_UNAVAILABLE_RESULTS)[number];

/** The only data secret controls can expose before C supplies a verified capability. */
export const B3_SECRET_CAPABILITY_UNAVAILABLE_RESULTS: readonly [
  { readonly kind: 'unavailable'; readonly code: 'APP_SECRET_CAPABILITY_UNAVAILABLE' },
] = Object.freeze([{ kind: 'unavailable', code: 'APP_SECRET_CAPABILITY_UNAVAILABLE' }] as const);
export type B3SecretCapabilityUnavailableV1 = (typeof B3_SECRET_CAPABILITY_UNAVAILABLE_RESULTS)[number];

type B3ApprovalViewReadyV1 = {
  readonly kind: Extract<B3ApprovalViewVariant, 'READY'>;
  readonly approvalId: string;
  readonly digest: string;
  readonly preview: ActivationDocumentV1;
  /**
   * A subscription's preview (0.36.0, W29): the subscriber version it names, and what it receives, in which namespaces,
   * where it goes and whether it gets what senders wrote. Present only for a subscription.
   */
  readonly subscription?: { readonly subscriber: SubscriberDocument; readonly words: string } | undefined;
  /** One complete owner-built selector for each target in a pending rule preview; enable-all has none. */
  readonly pendingTargetSelectors: readonly B3PendingTargetSelectorV1[];
  readonly challenge: {
    readonly approvalId: string;
    readonly digest: string;
    readonly challenge: string;
    readonly expiresAt: number;
  };
};

type B3ApprovalViewTerminalV1 = {
  readonly [Kind in Exclude<B3ApprovalViewVariant, 'READY'>]: { readonly kind: Kind };
}[Exclude<B3ApprovalViewVariant, 'READY'>];

/** Every approval discriminant is obtained from B3_APPROVAL_VIEW_VARIANTS, never duplicated here. */
export type B3ApprovalViewResultV1 = B3ApprovalViewReadyV1 | B3ApprovalViewTerminalV1;

export const B3_OWNER_STATES: readonly ['running', 'not-running'] = Object.freeze(['running', 'not-running'] as const);
export type B3OwnerState = (typeof B3_OWNER_STATES)[number];
export const B3_ACTIVATION_STATUSES: readonly ['pending', 'pending-completion', 'completed', 'failed', 'cancelled'] =
  Object.freeze(['pending', 'pending-completion', 'completed', 'failed', 'cancelled'] as const);
export type B3ActivationStatus = (typeof B3_ACTIVATION_STATUSES)[number];
/** The activation document vocabulary is also `ActivationRuntime`'s `IntentKind`. */
export const B3_INTENT_KINDS: readonly ['rule', 'judge-budget', 'judge-kind', 'enable-all', 'subscription'] =
  Object.freeze(['rule', 'judge-budget', 'judge-kind', 'enable-all', 'subscription'] as const);
export type B3IntentKind = (typeof B3_INTENT_KINDS)[number];

/** The core disclosure grammar is the binding authority; B3 only publishes its exact closed vocabulary. */
export const B3_DISCLOSURE_ACTIVATION_KINDS: readonly [
  'rule',
  'judge-budget',
  'judge-kind',
  'enable-all',
  'subscription',
] = Object.freeze([
  'rule',
  'judge-budget',
  'judge-kind',
  'enable-all',
  'subscription',
] as const satisfies readonly DisclosureActivationKind[]);
export type B3DisclosureActivationKind = (typeof B3_DISCLOSURE_ACTIVATION_KINDS)[number];
export const B3_DISCLOSURE_VERSION_KINDS: readonly [
  'rule',
  'target',
  'subscriber',
  'judge',
  'judge-budget',
  'judge-kind',
] = Object.freeze([
  'rule',
  'target',
  'subscriber',
  'judge',
  'judge-budget',
  'judge-kind',
] as const satisfies readonly DisclosureVersionKind[]);
export type B3DisclosureVersionKind = (typeof B3_DISCLOSURE_VERSION_KINDS)[number];
/** The status summary intentionally shares the writer/doctor failure-code source. */
export const B3_ACTIVATION_FAILURE_CODES: readonly ActivationFailureCode[] = ACTIVATION_FAILURE_CODES;
export type B3ActivationFailureCode = (typeof B3_ACTIVATION_FAILURE_CODES)[number];
export const B3_OWNER_RESULT_KINDS: readonly ['delivery-retried', 'delivery-dropped'] = Object.freeze([
  'delivery-retried',
  'delivery-dropped',
] as const);
export type B3OwnerResultKind = (typeof B3_OWNER_RESULT_KINDS)[number];
export const B3_RULE_TEST_AGENTIC_RESULTS: readonly ['not-evaluated'] = Object.freeze(['not-evaluated'] as const);
export type B3RuleTestAgenticResult = (typeof B3_RULE_TEST_AGENTIC_RESULTS)[number];
export const B3_RULE_TEST_OUTCOMES: readonly ['matched', 'condition-false', 'mapping-rejected'] = Object.freeze([
  'matched',
  'condition-false',
  'mapping-rejected',
] as const);
export type B3RuleTestOutcome = (typeof B3_RULE_TEST_OUTCOMES)[number];
export const B3_DELIVERY_REPRESENTATIONS: readonly ['plain', 'enveloped'] = Object.freeze([
  'plain',
  'enveloped',
] as const satisfies readonly DeliveryRepresentation[]);
export type B3DeliveryRepresentation = (typeof B3_DELIVERY_REPRESENTATIONS)[number];

type B3LifecycleResultV1 = Readonly<{ enabled: boolean; paused: boolean; switchGeneration: number }>;
type B3DisclosureBindingResultV1 = Readonly<{
  digest: string;
  activationIntentId: string;
  activationKind: B3DisclosureActivationKind;
  versions: readonly Readonly<{ kind: B3DisclosureVersionKind; id: string; version: number }>[];
}>;
type B3PreparedActivationResultV1 = Readonly<{
  intentId: string;
  approvalId: string;
  binding: B3DisclosureBindingResultV1;
  kind: B3IntentKind;
  status: 'pending';
  replacementOfVersion?: string | undefined;
}>;
type B3VersionResultV1<Kind extends 'rule' | 'target' | 'subscriber', Document> = Readonly<{
  id: string;
  kind: Kind;
  objectId: string;
  version: number;
  document: Document;
  digest: string;
  state: null;
}>;
/** A created rule version; one that narrows the active version carries its tightening's preview (action queue Q6). */
type B3RuleVersionResultV1 = B3VersionResultV1<'rule', CanonicalFullRuleDocument> &
  Readonly<{ tightening?: TighteningPreview }>;
type B3RuleTestResultV1 = Readonly<{
  agentic: B3RuleTestAgenticResult;
  outcome: B3RuleTestOutcome;
  rendered: string;
}>;
type B3TargetTestResultV1 = Readonly<{
  attempts: number;
  targetId: string;
  targetVersion: number;
}>;
type B3TargetResumeResultV1 = Readonly<{
  id: string;
  resetEpoch: number;
}>;
type B3DeliveryRetryResultV1 = Readonly<{
  kind: Extract<B3OwnerResultKind, 'delivery-retried'>;
  deliveryId: string;
  nextAt: number;
}>;
type B3DeliveryDropResultV1 = Readonly<{
  kind: Extract<B3OwnerResultKind, 'delivery-dropped'>;
  deliveryId: string;
}>;
type B3DryRunShowResultV1 = Readonly<{
  deliveryId: string;
  ruleId: string;
  ruleVersion: number;
  targetId: string;
  targetVersion: number;
  eventId: string;
  accountId: string;
  deliveredAt: number;
  expiresAt: number;
  record: Readonly<{
    cloudEventBytes: string;
    untrusted: readonly string[];
    representation: B3DeliveryRepresentation;
  }>;
}>;

/** Every formerly-generic owner result is now attached to its exact owner control wire. */
type B3OrdinaryControlResultsByOperationV1 = {
  readonly status: Readonly<{
    owner: B3OwnerState;
    enabled: boolean;
    paused: boolean;
    switchGeneration: number;
    activationIntents: readonly Readonly<{
      status: B3ActivationStatus;
      failureCode: B3ActivationFailureCode | null;
      count: number;
    }>[];
  }>;
  readonly stop: Readonly<{ stopping: true }>;
  readonly pause: B3LifecycleResultV1;
  readonly resume: B3LifecycleResultV1;
  readonly 'disable-all': B3LifecycleResultV1;
  readonly 'enable-all': B3PreparedActivationResultV1;
  readonly 'catalogue-list': readonly Readonly<{ type: string; version: number }>[];
  readonly 'catalogue-show': Readonly<{ type: string; version: number; channel: string }>;
  readonly 'sources-list': readonly Readonly<{ source: string; accounts: readonly JsonValue[] }>[];
  readonly 'source-show': Readonly<{ source: string; accounts: readonly JsonValue[] }>;
  readonly 'rules-list': readonly JsonValue[];
  readonly 'rule-show': readonly JsonValue[];
  readonly 'rule-create': B3RuleVersionResultV1;
  readonly 'rule-update': B3RuleVersionResultV1;
  readonly 'rule-enable': B3PreparedActivationResultV1;
  readonly 'rule-disable': Readonly<{ ruleId: string; disabled: true }>;
  readonly 'rule-remove': Readonly<{ ruleId: string; disabled: true }>;
  readonly 'targets-list': readonly JsonValue[];
  readonly 'target-add': B3VersionResultV1<'target', TargetDocument>;
  readonly 'target-update': B3VersionResultV1<'target', TargetDocument>;
  readonly 'target-remove': Readonly<{ targetId: string; removed: true }>;
  readonly approve: Readonly<{ intentId: string; status: 'completed'; usedAt: string }>;
  readonly ruleTest: B3RuleTestResultV1;
  readonly ruleTestRetained: B3RuleTestResultV1;
  readonly targetTest: B3TargetTestResultV1;
  readonly targetResume: B3TargetResumeResultV1;
  readonly subscribersList: readonly JsonValue[];
  readonly addSubscriber: B3VersionResultV1<'subscriber', SubscriberDocument>;
  readonly updateSubscriber: B3VersionResultV1<'subscriber', SubscriberDocument>;
  readonly removeSubscriber: Readonly<{ subscriberId: string; removed: true }>;
  readonly deliveriesList: readonly JsonValue[];
  readonly retryDelivery: B3DeliveryRetryResultV1;
  readonly dropDelivery: B3DeliveryDropResultV1;
  readonly 'dryrun-list': readonly JsonValue[];
  readonly 'dryrun-show': B3DryRunShowResultV1;
  readonly 'delivery-show': DeliveryShowResultV1;
  readonly 'queue-list': QueueListResultV1;
  readonly 'queue-show': Readonly<{ item: QueueItemV1 }>;
  readonly 'queue-items': QueueItemsResultV1;
  readonly 'queue-counts': QueueCountsResultV1;
  readonly 'queue-done': QueueStateChangeResultV1;
  readonly 'queue-dismiss': QueueStateChangeResultV1;
  readonly 'queue-reopen': QueueStateChangeResultV1;
  readonly 'queue-clear': QueueClearResultV1;
  readonly 'lane-list': LaneListResultV1;
  readonly 'lane-bind': LaneBindResultV1;
  readonly 'lane-unbind': LaneUnbindResultV1;
  readonly 'messages-list': MessagesListResultV1;
  readonly 'message-show': MessageShowResultV1;
  readonly 'judge-setup': JudgeSetupResultV1;
  readonly 'rule-approve': RuleApprovalResultV1;
  readonly 'enable-all-approve': EnableAllApprovalResultV1;
  readonly 'provider-list': ProviderListResultV1;
  readonly 'provider-key-set': ProviderKeyResultV1;
  readonly 'provider-key-remove': ProviderKeyResultV1;
  readonly 'integration-show': IntegrationShowResultV1 | AgentSessionsIntegrationV1;
  readonly 'projects-list': ProjectsListResultV1;
  readonly 'project-show': ProjectV1;
  readonly 'project-add': ProjectV1;
  readonly 'project-update': ProjectV1;
  readonly 'project-remove': ProjectRemoveResultV1;
  readonly 'project-scan': ProjectScanResultV1;
  readonly 'integration-set': AgentSessionsIntegrationV1;
  readonly 'session-queue-list': SessionQueueListResultV1;
  readonly 'session-queue-drop': SessionQueueDropResultV1;
  readonly 'rule-analyse': RuleAnalyseResultV1;
  readonly 'judge-show': JudgeShowResultV1;
  readonly 'subscriber-enable': B3PreparedActivationResultV1;
  readonly 'subscriber-approve': SubscriptionApprovalResultV1;
  readonly 'workflow-events-list': WorkflowEventsListResultV1;
  readonly 'workflow-events-show': WorkflowEventsShowResultV1;
};

/**
 * A result is not interchangeable merely because its JSON shape happens to be valid.  This is the TypeScript half
 * of the schema's per-operation result union: a desktop consumer cannot attach, for example, a doctor report to
 * `status` or an E2 state to `approvalView`.
 */
type B3SpecialControlResultsByOperationV1 = {
  readonly approvalView: B3ApprovalViewResultV1;
  readonly doctor: DoctorReportV1;
  readonly judgesList: B3ERequiredUnavailableV1;
  readonly addJudge: B3ERequiredUnavailableV1;
  readonly updateJudge: B3ERequiredUnavailableV1;
  readonly removeJudge: B3ERequiredUnavailableV1;
  readonly judgeTest: B3ERequiredUnavailableV1;
  readonly budgetShow: B3ERequiredUnavailableV1;
  readonly updateBudget: B3ERequiredUnavailableV1;
  readonly judgeKindsList: B3ERequiredUnavailableV1;
  readonly enableJudgeKind: B3JudgeUnavailableV1;
  readonly disableJudgeKind: B3JudgeUnavailableV1;
  readonly judgeModelStatus: B3E2RequiredUnavailableV1;
  readonly removeJudgeModel: B3E2RequiredUnavailableV1;
  readonly heldList: B3HeldListV1;
  readonly decideHeld: B3HoldsUnavailableV1;
  readonly targetSecretCreate: B3SecretCapabilityUnavailableV1;
  readonly targetSecretRotate: B3SecretCapabilityUnavailableV1;
  readonly targetUrlSet: B3SecretCapabilityUnavailableV1;
  readonly subscriberTokenCreate: B3SecretCapabilityUnavailableV1;
  readonly subscriberTokenRotate: B3SecretCapabilityUnavailableV1;
  readonly subscriberSecretCreate: B3SecretCapabilityUnavailableV1;
  readonly subscriberSecretRotate: B3SecretCapabilityUnavailableV1;
  readonly subscriberUrlSet: B3SecretCapabilityUnavailableV1;
  readonly judgeKeySet: B3SecretCapabilityUnavailableV1;
  readonly judgeKeyRotate: B3SecretCapabilityUnavailableV1;
  readonly migrateSecrets: B3SecretCapabilityUnavailableV1;
};

/** Every desktop control has one closed result branch; no JSON-object catch-all remains. */
export type B3ControlResultByOperationV1 = {
  readonly [Operation in B3DesktopControlOperation]: Operation extends keyof B3SpecialControlResultsByOperationV1
    ? B3SpecialControlResultsByOperationV1[Operation]
    : Operation extends keyof B3OrdinaryControlResultsByOperationV1
      ? B3OrdinaryControlResultsByOperationV1[Operation]
      : never;
};

export type B3ControlResultV1 = B3ControlResultByOperationV1[B3DesktopControlOperation];

/** Runtime coverage source: a desktop wire has exactly one result branch and vector. */
export const B3_CONTROL_V1_RESULT_OPERATIONS: readonly B3DesktopControlOperation[] = B3_DESKTOP_CONTROL_OPERATIONS;

export type B3ControlResultOperationV1 = (typeof B3_CONTROL_V1_RESULT_OPERATIONS)[number];

/** The stable data-only error vocabulary; messages and provider detail deliberately do not cross this contract. */
export const B3_CONTROL_ERROR_CODES: readonly ['USAGE', 'BAD_DATA', 'APPROVAL_VOID', 'NOT_FOUND', 'CONFIG'] =
  Object.freeze(['USAGE', 'BAD_DATA', 'APPROVAL_VOID', 'NOT_FOUND', 'CONFIG'] as const);

export type B3ControlErrorCodeV1 = (typeof B3_CONTROL_ERROR_CODES)[number];

export interface B3ControlErrorV1 {
  readonly code: B3ControlErrorCodeV1;
}

/**
 * The desktop-visible argument shapes. Secret bytes are deliberately absent: these rows let C identify the operation
 * and its immutable owner only, while B3 itself accepts the real value solely from the interactive terminal.
 */
export interface B3ControlRequestArgumentsV1 {
  readonly approvalView: { readonly approvalId: string; readonly digest: string };
  readonly ruleTest: {
    readonly document: CanonicalFullRuleDocument;
    readonly catalogue: { readonly type: string; readonly version: number; readonly exampleIndex: number };
  };
  readonly ruleTestRetained: { readonly eventId: string; readonly ruleId: string; readonly ruleVersion: number };
  readonly targetTest: { readonly targetId: string; readonly targetVersion: number };
  readonly targetResume: { readonly targetId: string; readonly targetVersion: number };
  readonly subscribersList: Record<string, never>;
  readonly addSubscriber: { readonly document: SubscriberDocument };
  readonly updateSubscriber: { readonly document: SubscriberDocument };
  readonly removeSubscriber: { readonly subscriberId: string };
  readonly judgesList: Record<string, never>;
  readonly addJudge: { readonly document: CanonicalJudgeDocument };
  readonly updateJudge: { readonly document: CanonicalJudgeDocument };
  readonly removeJudge: { readonly judgeId: string };
  readonly judgeTest: { readonly judgeId: string; readonly version: number };
  readonly budgetShow: Record<string, never>;
  readonly updateBudget: { readonly document: JudgeBudgetDocument };
  readonly judgeKindsList: Record<string, never>;
  readonly enableJudgeKind: { readonly kind: string };
  readonly disableJudgeKind: { readonly kind: string };
  readonly judgeModelStatus: Record<string, never>;
  readonly removeJudgeModel: Record<string, never>;
  readonly deliveriesList: Record<string, never>;
  readonly retryDelivery: { readonly deliveryId: string };
  readonly dropDelivery: { readonly deliveryId: string };
  readonly heldList: Record<string, never>;
  readonly decideHeld: { readonly decisionId: string; readonly decision: B3HeldDecision };
  readonly targetSecretCreate: { readonly targetId: string; readonly version: number };
  readonly targetSecretRotate: { readonly targetId: string; readonly version: number };
  readonly targetUrlSet: {
    readonly targetId: string;
    readonly predecessorVersion?: number | undefined;
    readonly inertDraft?: TargetDocument | undefined;
    readonly newVersion: number;
  };
  readonly subscriberTokenCreate: { readonly subscriberId: string; readonly version: number };
  readonly subscriberTokenRotate: { readonly subscriberId: string; readonly version: number };
  readonly subscriberSecretCreate: { readonly subscriberId: string; readonly version: number };
  readonly subscriberSecretRotate: { readonly subscriberId: string; readonly version: number };
  /** The new version to make; its URL is the person's hidden input, never an argument here. */
  readonly subscriberUrlSet: { readonly subscriberId: string; readonly version: number };
  readonly judgeKeySet: { readonly judgeId: string; readonly version: number };
  readonly judgeKeyRotate: { readonly judgeId: string; readonly version: number };
  readonly migrateSecrets: { readonly to: B3SecretBackend };
}

/** The non-B3-delta operations desktop also reaches through the owner control protocol. */
export interface B3DesktopControlRequestArgumentsV1 extends B3ControlRequestArgumentsV1 {
  readonly status: Record<string, never>;
  readonly stop: Record<string, never>;
  readonly pause: Record<string, never>;
  readonly resume: Record<string, never>;
  readonly 'disable-all': Record<string, never>;
  readonly 'enable-all': Record<string, never>;
  readonly doctor: Record<string, never>;
  readonly 'catalogue-list': Record<string, never>;
  readonly 'catalogue-show': { readonly type: string };
  readonly 'sources-list': Record<string, never>;
  readonly 'source-show': { readonly source: string };
  readonly 'rules-list': Record<string, never>;
  readonly 'rule-show': { readonly ruleId: string };
  readonly 'rule-create': { readonly document: CanonicalFullRuleDocument };
  readonly 'rule-update': { readonly document: CanonicalFullRuleDocument };
  readonly 'rule-enable': { readonly ruleId: string; readonly version: number };
  readonly 'rule-disable': { readonly ruleId: string };
  readonly 'rule-remove': { readonly ruleId: string };
  readonly 'targets-list': Record<string, never>;
  readonly 'target-add': { readonly document: TargetDocument };
  readonly 'target-update': { readonly document: TargetDocument };
  readonly 'target-remove': { readonly targetId: string };
  readonly approve: { readonly approvalId: string; readonly answer: string };
  readonly 'dryrun-list': Record<string, never>;
  readonly 'dryrun-show': { readonly deliveryId: string };
  /** One delivery's details (0.32.0, owner feedback §3.5): the person's, from the CLI and the app. */
  readonly 'delivery-show': { readonly deliveryId: string };
  readonly 'queue-list': B3QueueListArgumentsV1;
  readonly 'queue-show': { readonly itemId: string };
  readonly 'queue-items': Omit<B3QueueListArgumentsV1, 'since'>;
  readonly 'queue-counts': Record<string, never>;
  readonly 'queue-done': { readonly itemId: string };
  readonly 'queue-dismiss': { readonly itemId: string };
  readonly 'queue-reopen': { readonly itemId: string };
  readonly 'queue-clear': Record<string, never>;
  /** Routing's lanes (0.31.0): the person's three, at a terminal or in the app. */
  readonly 'lane-list': Record<string, never>;
  readonly 'lane-bind': { readonly lane: string; readonly window: string };
  readonly 'lane-unbind': { readonly lane: string };
  /** A story per message (0.32.0): the person's read, at a terminal or in the app. */
  readonly 'messages-list': B3MessagesListArgumentsV1;
  readonly 'message-show': { readonly eventId: string };
  /**
   * The person's own setup (owner decision 2026-10-26). A provider key travels on the wire beside these arguments,
   * from the person's hidden input, and is no part of the contract: no vector, result or audit line holds it.
   */
  readonly 'judge-setup': {
    readonly kind: SetupJudgeKind;
    readonly provider?: JevProvider | undefined;
    readonly url?: string | undefined;
    readonly model?: string | undefined;
  };
  /**
   * A rule's activation, approved by the person in the app after its preview (0.33.0 design §3.1): the approval `rule
   * enable` prepared, and the digest the preview showed. No challenge is in it: the owner issues and answers its own.
   */
  readonly 'rule-approve': { readonly approvalId: string; readonly digest: string };
  /**
   * Switching the event service on, approved by the person in the app after its preview (0.34.0 design B4): the
   * approval `enable-all` prepared, and the digest the preview showed. No challenge is in it, as for `rule-approve`.
   */
  readonly 'enable-all-approve': { readonly approvalId: string; readonly digest: string };
  readonly 'provider-list': Record<string, never>;
  readonly 'provider-key-set': { readonly provider: EventSecretProvider };
  readonly 'provider-key-remove': { readonly provider: EventSecretProvider };
  /** Settings → Integrations (0.33.0 design §3.4): what the person's Linear key can see, and one team's labels. */
  readonly 'integration-show':
    | { readonly integration: 'linear'; readonly team?: string | undefined }
    | { readonly integration: 'agent-sessions' };
  /**
   * Projects (0.36.0 workflows design §8.1): the person's alone, from the app or their terminal. A document is
   * `canonicalProject`'s; a scan's roots are at most 8 absolute folders.
   */
  readonly 'projects-list': Record<string, never>;
  readonly 'project-show': { readonly projectId: string };
  readonly 'project-add': { readonly document: Readonly<Record<string, JsonValue>> };
  readonly 'project-update': { readonly document: Readonly<Record<string, JsonValue>> };
  readonly 'project-remove': { readonly projectId: string };
  readonly 'project-scan': { readonly roots?: readonly string[] | undefined };
  /**
   * Agent sessions through claude-stream (0.33.0 §3.5): where the person's relay is, theirs to see and to set from the
   * app or their terminal; and the busy queue, theirs to read and to drop from. No token is in any of them.
   */
  readonly 'integration-set': {
    readonly integration: 'agent-sessions';
    readonly relayHome?: string | undefined;
    readonly relayPort?: number | 'default' | undefined;
    readonly allowFolders?: readonly string[] | undefined;
    readonly removeFolders?: readonly string[] | undefined;
  };
  readonly 'session-queue-list': Record<string, never>;
  readonly 'session-queue-drop': { readonly deliveryId: string };
  /**
   * Analyse (0.33.0 design §3.3): the person's view of one rule, or a draft of it from the editor, and the provider its
   * model runs on when they pick one. It writes nothing.
   */
  /** One judge version's exact canonical document (0.33.0), the newest live one unless a version is named. */
  readonly 'judge-show': { readonly judgeId: string; readonly version?: number | undefined };
  /** A subscriber version's events, prepared for the person's approval (0.36.0, W29), as `rule-enable` prepares a rule. */
  readonly 'subscriber-enable': { readonly subscriberId: string; readonly version: number };
  /** That approval, from the app after its preview: the approval and the digest the preview showed. */
  readonly 'subscriber-approve': { readonly approvalId: string; readonly digest: string };
  /** The step event catalogue (W25), content-free. */
  readonly 'workflow-events-list': Record<string, never>;
  readonly 'workflow-events-show': { readonly schema: string };
  readonly 'rule-analyse': {
    readonly ruleId: string;
    readonly draft?: Readonly<Record<string, JsonValue>> | undefined;
    readonly provider?: AnalyseProvider | undefined;
  };
}

/** `messages list`'s closed argument shape (0.32.0 spec §3.6); every field is optional. */
export interface B3MessagesListArgumentsV1 {
  /** Whole milliseconds since 1970; 30 days back by default. */
  readonly since?: number | undefined;
  /** Whole milliseconds since 1970, or a page's `next` cursor (`<ms>:<eventId>`). */
  readonly before?: number | string | undefined;
  /** 1 to 500; 100 by default. */
  readonly limit?: number | undefined;
}

/** `queue list`'s closed filter shape (action queue design §8); every field is optional. */
export interface B3QueueListArgumentsV1 {
  readonly state?: QueueStateFilter | undefined;
  readonly rule?: string | undefined;
  readonly channel?: QueueChannel | undefined;
  /** An ISO time, or a span back from now such as `7d` or `12h`. */
  readonly since?: string | undefined;
  readonly limit?: number | undefined;
}

type AssertNever<Value extends never> = Value;
type _B3ControlRequestArgumentsCoverEveryOperation = AssertNever<
  Exclude<B3ControlOperation, keyof B3ControlRequestArgumentsV1>
>;
type _B3ControlRequestArgumentsContainNoUnknownOperation = AssertNever<
  Exclude<keyof B3ControlRequestArgumentsV1, B3ControlOperation>
>;
type _B3DesktopControlRequestArgumentsCoverEveryOperation = AssertNever<
  Exclude<B3DesktopControlOperation, keyof B3DesktopControlRequestArgumentsV1>
>;
type _B3DesktopControlRequestArgumentsContainNoUnknownOperation = AssertNever<
  Exclude<keyof B3DesktopControlRequestArgumentsV1, B3DesktopControlOperation>
>;

export type B3ControlRequestV1 = {
  [Operation in B3ControlOperation]: {
    readonly operation: Operation;
    readonly args: B3ControlRequestArgumentsV1[Operation];
    /** Origin is authenticated control metadata, never request data. */
    readonly origin?: string | undefined;
  };
}[B3ControlOperation];

export type B3DesktopControlRequestV1 = {
  [Operation in B3DesktopControlOperation]: {
    readonly operation: Operation;
    readonly args: B3DesktopControlRequestArgumentsV1[Operation];
    /** Origin is authenticated control metadata, never request data. */
    readonly origin?: string | undefined;
  };
}[B3DesktopControlOperation];

/** The one pending-target selector that C may use, only while rendering an approval screen. */
export interface B3PendingTargetApprovalRequestV1 {
  readonly surface: B3PendingTargetApprovalSurface;
  readonly operation: 'targetTest';
  readonly selector: B3PendingTargetSelectorV1;
}

type B3ControlRequestVectorV1 = {
  readonly name: string;
  readonly request: B3DesktopControlRequestV1;
  readonly result?: never | undefined;
  readonly error?: never | undefined;
};

type B3ControlResultVectorV1 = {
  [Operation in B3ControlResultOperationV1]: {
    readonly name: string;
    readonly request: Extract<B3DesktopControlRequestV1, { readonly operation: Operation }>;
    readonly result: B3ControlResultByOperationV1[Operation];
    readonly error?: never | undefined;
  };
}[B3ControlResultOperationV1];

type B3ControlErrorVectorV1 = {
  readonly name: string;
  readonly request: B3DesktopControlRequestV1;
  readonly error: B3ControlErrorV1;
  readonly result?: never | undefined;
};

export type B3ControlContractVectorV1 =
  | B3ControlRequestVectorV1
  | B3ControlResultVectorV1
  | B3ControlErrorVectorV1
  | { readonly name: string; readonly request: B3PendingTargetApprovalRequestV1 };

export const B3_CONTROL_V1_SCHEMA_VERSION = 'b3-control-v1' as const;

/** Kept beside the union so a TypeScript change cannot silently leave the language-neutral schema/vector set behind. */
export const B3_CONTROL_V1_OPERATION_SPECS: readonly {
  readonly operation: B3DesktopControlOperation;
  readonly desktopCallable: boolean;
  readonly secret: boolean;
}[] = Object.freeze(
  B3_DESKTOP_CONTROL_OPERATIONS.map((operation) => ({
    operation,
    desktopCallable: true,
    secret: B3_SECRET_OPERATIONS.has(operation as B3ControlOperation),
  })),
);

/** E owns this gate; B3 records the obligation without pretending a temporary fixture proves future build/shipping. */
export const B3_CONTROL_V1_SUCCESSOR_REQUIREMENT =
  'E imports its real code and this contract, lands the build/ship negative gate before any owner registration or callable judge, and requires B3 merged.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const B3_DESKTOP_CONTROL_OPERATION_SET: ReadonlySet<B3DesktopControlOperation> = new Set(B3_DESKTOP_CONTROL_OPERATIONS);

function isB3DesktopControlOperation(value: string): value is B3DesktopControlOperation {
  return B3_DESKTOP_CONTROL_OPERATION_SET.has(value as B3DesktopControlOperation);
}

function assertClosedRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TypeError(`${name} must be a closed object`);
}

const B3_ORDINARY_RESULT_ARRAY_OPERATIONS = new Set<string>([
  'catalogue-list',
  'sources-list',
  'rules-list',
  'rule-show',
  'targets-list',
  'subscribersList',
  'deliveriesList',
  'dryrun-list',
]);

const QUEUE_SUMMARY_FIELDS = ['id', 'state', 'stateAt', 'arrivedAt', 'expiresAt', 'rule', 'channel', 'account', 'lane'];

function assertIsoTime(value: unknown, name: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new TypeError(`${name} must be an ISO 8601 UTC time`);
}

function assertQueueItemSummary(value: unknown, name: string, extra: readonly string[] = []): void {
  if (!isRecord(value)) throw new TypeError(`${name} must be a closed object`);
  const optional = ['subject', 'text', 'link'].filter((key) => Object.hasOwn(value, key));
  assertClosedRecord(value, [...QUEUE_SUMMARY_FIELDS, ...extra, ...optional], name);
  if (!isQueueItemId(value.id)) throw new TypeError(`${name} has a malformed item id`);
  if (!QUEUE_STATES.includes(value.state as never)) throw new TypeError(`${name} has an unknown state`);
  for (const field of ['stateAt', 'arrivedAt', 'expiresAt']) assertIsoTime(value[field], `${name} ${field}`);
  assertClosedRecord(value.rule, ['id', 'version', 'name'], `${name} rule`);
  assertText(value.rule.id, `${name} rule id`);
  assertPositiveInteger(value.rule.version, `${name} rule version`);
  assertText(value.rule.name, `${name} rule name`);
  if (!QUEUE_CHANNELS.includes(value.channel as never)) throw new TypeError(`${name} has an unknown channel`);
  assertClosedRecord(value.account, ['id', 'alias'], `${name} account`);
  assertText(value.account.id, `${name} account id`);
  if (value.account.alias !== null) assertText(value.account.alias, `${name} account alias`);
  if (value.lane !== null && !isLaneName(value.lane)) throw new TypeError(`${name} has a malformed lane`);
}

/** A content item: its sender-written fields are envelope strings; its judge part is closed per state (Q3). */
function assertQueueItem(value: unknown, name: string): void {
  assertQueueItemSummary(value, name, ['from', 'judge']);
  const item = value as Record<string, unknown>;
  if (!isRecord(item.from) || Object.keys(item.from).some((key) => key !== 'name' && key !== 'address'))
    throw new TypeError(`${name} from must be a closed object`);
  for (const field of [item.from.name, item.from.address, item.subject, item.text])
    if (field !== undefined && (typeof field !== 'string' || !field.startsWith('<untrusted-content ')))
      throw new TypeError(`${name} sender-written fields must be enveloped`);
  if (item.link !== undefined) {
    assertClosedRecord(item.link, ['kind', 'url'], `${name} link`);
    if (!QUEUE_LINK_KINDS.includes(item.link.kind as never)) throw new TypeError(`${name} has an unknown link kind`);
    const host = item.link.kind === 'gmail' ? 'https://mail.google.com/' : 'https://app.slack.com/';
    if (typeof item.link.url !== 'string' || !item.link.url.startsWith(host))
      throw new TypeError(`${name} link leaves its provider's web host`);
  }
  if (!isRecord(item.judge) || !QUEUE_JUDGE_STATES.includes(item.judge.state as never))
    throw new TypeError(`${name} has an unknown judge state`);
  const judge = item.judge;
  const keys =
    judge.state === 'none'
      ? ['state']
      : judge.state === 'answered'
        ? ['state', 'id', 'kind', 'model', 'question', 'answer', 'confidence', 'uncalibrated']
        : ['state', 'id', 'kind', 'model', 'question'];
  assertClosedRecord(judge, keys, `${name} judge`);
  if (judge.state === 'answered') {
    if (!QUEUE_JUDGE_ANSWERS.includes(judge.answer as never)) throw new TypeError(`${name} has an unknown answer`);
    if (typeof judge.confidence !== 'number' || !Number.isFinite(judge.confidence))
      throw new TypeError(`${name} judge confidence must be a finite number`);
    if (typeof judge.uncalibrated !== 'boolean') throw new TypeError(`${name} judge uncalibrated must be a boolean`);
  }
}

function assertQueueStateChange(value: Readonly<Record<string, unknown>>, name: string): void {
  assertClosedRecord(value.item, ['id', 'state', 'stateAt'], `${name} item`);
  if (!isQueueItemId(value.item.id)) throw new TypeError(`${name} has a malformed item id`);
  if (!QUEUE_STATES.includes(value.item.state as never)) throw new TypeError(`${name} has an unknown state`);
  assertIsoTime(value.item.stateAt, `${name} stateAt`);
}

const DELIVERY_ROW_FIELDS = [
  'deliveryId',
  'accountId',
  'ruleId',
  'ruleVersion',
  'targetId',
  'targetVersion',
  'subscriberId',
  'subscriberVersion',
  'attempts',
  'nextAt',
  'expiresAt',
  'state',
  'switchGeneration',
  'deadLetterExpiresAt',
  'targetKind',
  'lastErrorCode',
  'lastStatus',
  'decisionId',
  'eventId',
  'deliveredAt',
  'deadLetteredAt',
];
const DELIVERY_TARGET_KINDS = ['dry-run', 'webhook', 'sse', 'queue', 'linear', 'session'];

function assertNullable<T>(value: unknown, check: (value: unknown, name: string) => T, name: string): void {
  if (value !== null) check(value, name);
}

/** An event's source ids (`runtime/event-source.ts`): one closed shape per channel, ids only, as `messages list`'s. */
function assertEventSource(value: unknown, name: string): void {
  if (!isRecord(value)) throw new TypeError(`${name} must be a closed object`);
  const keys = typeof value.channel === 'string' ? MESSAGE_SOURCE_FIELDS[value.channel] : undefined;
  if (keys === undefined) throw new TypeError(`${name} has an unknown channel`);
  assertClosedRecord(value, keys, name);
  for (const key of keys) assertText(value[key], `${name} ${key}`);
}

/** A Linear delivery's issue (0.33.0 design §3.4): its identifier and its linear.app address, and only on one. */
function assertDeliveryRowLinear(row: unknown): void {
  if (!isRecord(row) || !Object.hasOwn(row, 'linear')) return;
  if (row.targetKind !== 'linear') throw new TypeError('only a Linear delivery shows a Linear issue');
  assertClosedRecord(row.linear, ['identifier', 'url'], 'a delivery’s Linear issue');
  if (typeof row.linear.identifier !== 'string' || !/^[A-Za-z0-9_]{1,32}-[0-9]{1,10}$/u.test(row.linear.identifier))
    throw new TypeError('a Linear issue identifier is a team key and a number');
  if (typeof row.linear.url !== 'string' || !row.linear.url.startsWith('https://linear.app/'))
    throw new TypeError('a Linear issue address is on linear.app');
}

/** `delivery show` (0.32.0, owner feedback §3.5): content-free ids, times and the judge's yes or no. */
function assertDeliveryShow(value: Readonly<Record<string, unknown>>): void {
  const row = value.delivery;
  assertDeliveryRowLinear(row);
  assertClosedRecord(
    row,
    [...DELIVERY_ROW_FIELDS, ...(isRecord(row) && Object.hasOwn(row, 'linear') ? ['linear'] : [])],
    'a shown delivery row',
  );
  for (const field of ['deliveryId', 'accountId', 'ruleId', 'targetId', 'state', 'decisionId'])
    assertText(row[field], `a shown delivery ${field}`);
  for (const field of ['ruleVersion', 'targetVersion']) assertPositiveInteger(row[field], `a shown delivery ${field}`);
  for (const field of ['attempts', 'expiresAt', 'switchGeneration'])
    assertNonNegativeInteger(row[field], `a shown delivery ${field}`);
  for (const field of [
    'subscriberVersion',
    'nextAt',
    'deadLetterExpiresAt',
    'lastStatus',
    'deliveredAt',
    'deadLetteredAt',
  ])
    assertNullable(row[field], assertNonNegativeInteger, `a shown delivery ${field}`);
  for (const field of ['subscriberId', 'lastErrorCode', 'eventId'])
    assertNullable(row[field], assertText, `a shown delivery ${field}`);
  if (!DELIVERY_TARGET_KINDS.includes(row.targetKind as string))
    throw new TypeError('a shown delivery has an unknown target kind');
  if (value.decision !== null) {
    assertClosedRecord(value.decision, ['outcome', 'decidedAt', 'judge'], 'a shown decision');
    assertText(value.decision.outcome, 'a shown decision outcome');
    assertNullable(value.decision.decidedAt, assertNonNegativeInteger, 'a shown decision time');
    const judge = value.decision.judge;
    if (judge !== null) {
      assertClosedRecord(judge, ['kind', 'answer', 'confidence', 'calibrated'], 'a shown judge');
      assertText(judge.kind, 'a shown judge kind');
      if (judge.answer !== null && judge.answer !== 'yes' && judge.answer !== 'no')
        throw new TypeError('a shown judge answer is yes, no or null');
      if (judge.confidence !== null && (typeof judge.confidence !== 'number' || !Number.isFinite(judge.confidence)))
        throw new TypeError('a shown judge confidence is a finite number or null');
      if (judge.calibrated !== null && typeof judge.calibrated !== 'boolean')
        throw new TypeError('a shown judge says whether it is calibrated');
    }
  }
  if (value.event !== null) {
    assertClosedRecord(
      value.event,
      ['eventId', 'type', 'accountId', 'occurredAt', 'observedAt', 'source'],
      'a shown event',
    );
    for (const field of ['eventId', 'type', 'accountId']) assertText(value.event[field], `a shown event ${field}`);
    for (const field of ['occurredAt', 'observedAt'])
      assertNonNegativeInteger(value.event[field], `a shown event ${field}`);
    assertNullable(value.event.source, assertEventSource, 'a shown event source');
  }
  if (!isRecord(value.target)) throw new TypeError('a shown target must be a closed object');
  const target = value.target;
  assertClosedRecord(
    target,
    ['kind', 'id', 'version', ...['host', 'lane'].filter((key) => Object.hasOwn(target, key))],
    'a shown target',
  );
  if (!DELIVERY_TARGET_KINDS.includes(target.kind as string)) throw new TypeError('a shown target has an unknown kind');
  assertText(target.id, 'a shown target id');
  assertPositiveInteger(target.version, 'a shown target version');
  if (target.host !== undefined && (target.kind !== 'webhook' || typeof target.host !== 'string' || target.host === ''))
    throw new TypeError('only a webhook target shows its host');
  if (target.lane !== undefined && ((target.kind !== 'queue' && target.kind !== 'session') || !isLaneName(target.lane)))
    throw new TypeError('only a queue or session target shows its lane');
  if (value.dryRun !== null) {
    assertClosedRecord(value.dryRun, ['expiresAt'], 'a shown dry-run entry');
    if (target.kind !== 'dry-run') throw new TypeError('only a dry-run delivery shows a log entry');
    assertNullable(value.dryRun.expiresAt, assertNonNegativeInteger, 'a shown dry-run expiry');
  }
}

/**
 * `integration show linear` (0.33.0 design §3.4): whether a Linear key is kept, the workspace and teams it sees, and one
 * team's labels when asked. Ids are Linear's; names are the workspace's own, one line each.
 */
function assertIntegrationShow(value: Readonly<Record<string, unknown>>): void {
  assertClosedRecord(
    value,
    ['integration', 'connected', 'workspace', 'teams', ...(Object.hasOwn(value, 'labels') ? ['labels'] : [])],
    'an integration show result',
  );
  if (value.integration !== 'linear') throw new TypeError('an integration show result names Linear');
  if (typeof value.connected !== 'boolean')
    throw new TypeError('an integration show result says whether it is connected');
  if (value.connected) assertText(value.workspace, 'a Linear workspace');
  else if (value.workspace !== null) throw new TypeError('an unconnected integration has no workspace');
  if (!Array.isArray(value.teams)) throw new TypeError('an integration show result lists its teams');
  if (!value.connected && (value.teams.length > 0 || Object.hasOwn(value, 'labels')))
    throw new TypeError('an unconnected integration lists nothing');
  for (const team of value.teams) {
    assertClosedRecord(team, ['id', 'key', 'name'], 'a Linear team');
    if (!isLinearId(team.id)) throw new TypeError('a Linear team id is a Linear id');
    for (const field of ['key', 'name']) assertText(team[field], `a Linear team ${field}`);
  }
  if (!Object.hasOwn(value, 'labels')) return;
  if (!Array.isArray(value.labels)) throw new TypeError('an integration show result lists its labels');
  for (const label of value.labels) {
    assertClosedRecord(label, ['id', 'name'], 'a Linear label');
    if (!isLinearId(label.id)) throw new TypeError('a Linear label id is a Linear id');
    assertText(label.name, 'a Linear label name');
  }
}

/** `judge setup`'s result (owner decision 2026-10-26): what it set up and approved, and never a key. */
function assertJudgeSetupResult(value: Readonly<Record<string, unknown>>): void {
  if (value.kind !== JUDGE_KIND_TYPESAFE && value.kind !== JUDGE_KIND_LOCAL_ENDPOINT)
    throw new TypeError('a judge setup kind is unknown');
  if (value.enabled !== true || typeof value.enabledNow !== 'boolean')
    throw new TypeError('a judge setup result says the kind is on');
  assertClosedRecord(value.judge, ['judgeId', 'version', 'provider', 'model', 'endpoint', 'created'], 'a set-up judge');
  for (const field of ['judgeId', 'provider', 'model', 'endpoint']) assertText(value.judge[field], field);
  assertPositiveInteger(value.judge.version, 'a set-up judge version');
  if (typeof value.judge.created !== 'boolean') throw new TypeError('a set-up judge says whether it is new');
  assertClosedRecord(value.budget, ['version', 'approvedNow', 'global', 'provider'], 'a set-up budget');
  assertPositiveInteger(value.budget.version, 'a set-up budget version');
  if (typeof value.budget.approvedNow !== 'boolean') throw new TypeError('a set-up budget says whether it is new');
  assertClosedRecord(
    value.budget.global,
    ['callsPerRollingHour', 'inputTokensPerRolling30Days', 'concurrency'],
    'a set-up global budget',
  );
  assertClosedRecord(
    value.budget.provider,
    ['provider', 'callsPerRollingHour', 'inputTokensPerRolling30Days', 'concurrency'],
    'a set-up provider budget',
  );
  for (const limits of [value.budget.global, value.budget.provider])
    for (const field of ['callsPerRollingHour', 'inputTokensPerRolling30Days', 'concurrency'])
      assertPositiveInteger(limits[field], field);
  if (value.key !== 'stored' && value.key !== 'unchanged' && value.key !== 'none')
    throw new TypeError('a judge setup key state is unknown');
  assertText(value.destination, 'a judge setup destination');
  // Where the person was (0.32.0, the second look at the release): the release app, the test build, or a terminal. On
  // Windows and Linux nothing attests the app, so a setup there is made at a terminal (0.33.0, the second look).
  if (!(PERSON_CHANGE_APPROVERS as readonly unknown[]).includes(value.approvedBy))
    throw new TypeError('a judge setup is approved by the person, in the app or at a terminal');
}

/** `integration show|set agent-sessions` (0.33.0 §3.5): the settings and what the relay said; never its token. */
function assertAgentSessionsIntegration(value: Readonly<Record<string, unknown>>): void {
  assertClosedRecord(value, ['integration', 'settings', 'relay', 'waiting'], 'the agent sessions integration');
  if (value.integration !== 'agent-sessions') throw new TypeError('an integration result names agent-sessions');
  assertClosedRecord(value.settings, ['relayHome', 'relayPort', 'allowedFolders'], 'agent session settings');
  assertNullable(value.settings.relayHome, assertText, 'the relay home setting');
  assertNullable(value.settings.relayPort, assertPositiveInteger, 'the relay port setting');
  if (!Array.isArray(value.settings.allowedFolders) || value.settings.allowedFolders.some((f) => typeof f !== 'string'))
    throw new TypeError('the allowed folders are a list of folders');
  assertClosedRecord(
    value.relay,
    ['found', 'home', 'source', 'url', 'ready', 'version', 'allowedRoots', 'problem'],
    'the relay as found',
  );
  const relay = value.relay;
  for (const field of ['found', 'ready'])
    if (typeof relay[field] !== 'boolean') throw new TypeError(`the relay's ${field} is true or false`);
  for (const field of ['home', 'url', 'version', 'problem'])
    assertNullable(relay[field], assertText, `the relay ${field}`);
  if (relay.source !== null && !['setting', 'default', 'pilot'].includes(relay.source as string))
    throw new TypeError("the relay's home is the setting's, the default or the Pilot app's");
  if (typeof relay.url === 'string' && !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/u.test(relay.url))
    throw new TypeError('the relay is reached on loopback only');
  if (
    relay.allowedRoots !== null &&
    (!Array.isArray(relay.allowedRoots) || relay.allowedRoots.some((r) => typeof r !== 'string'))
  )
    throw new TypeError("the relay's allowed roots are a list of folders");
  assertNonNegativeInteger(value.waiting, 'the items waiting for a busy session');
}

const PROJECT_RESULT_FIELDS: readonly string[] = Object.freeze([
  'projectId',
  'name',
  'repo',
  'profile',
  'profileBy',
  'profileAt',
  'hints',
  'folders',
  'createdAt',
  'updatedAt',
]);

/** One project (0.36.0 §8.1), as `project show` gives it: closed, its folders absolute. */
function assertProject(value: unknown): void {
  assertClosedRecord(value, PROJECT_RESULT_FIELDS, 'a project');
  for (const field of ['projectId', 'name', 'repo']) assertText(value[field], `a project's ${field}`);
  if (typeof value.profile !== 'string') throw new TypeError("a project's profile is text");
  if (value.profileBy !== null && value.profileBy !== 'person')
    throw new TypeError("a project's profile is the person's");
  assertNullable(value.profileAt, assertNonNegativeInteger, "when a project's profile was written");
  assertClosedRecord(value.hints, ['senderDomains', 'slackConversations', 'people'], "a project's hints");
  for (const list of Object.values(value.hints))
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string'))
      throw new TypeError("a project's hints are lists of words");
  if (!Array.isArray(value.folders)) throw new TypeError("a project's folders are a list");
  for (const folder of value.folders) {
    assertClosedRecord(folder, ['folder', 'kind', 'defaultBranch', 'worktreeRoot'], "a project's folder");
    if (typeof folder.folder !== 'string' || !folder.folder.startsWith('/'))
      throw new TypeError("a project's folder is absolute");
    if (folder.kind !== 'checkout' && folder.kind !== 'worktree')
      throw new TypeError("a project's folder is a checkout or a worktree");
    assertNullable(folder.defaultBranch, assertText, "a folder's default branch");
    assertNullable(folder.worktreeRoot, assertText, "a checkout's worktree root");
  }
  for (const field of ['createdAt', 'updatedAt']) assertNonNegativeInteger(value[field], `a project's ${field}`);
}

/** `project scan`'s result: the roots, the repositories found by origin, and the folders passed over. */
function assertProjectScan(value: Readonly<Record<string, unknown>>): void {
  if (!Array.isArray(value.roots) || value.roots.some((root) => typeof root !== 'string'))
    throw new TypeError("a scan's roots are folders");
  if (!Array.isArray(value.repos)) throw new TypeError("a scan's repositories are a list");
  for (const repo of value.repos) {
    assertClosedRecord(repo, ['repo', 'known', 'folders'], 'a scanned repository');
    assertText(repo.repo, 'a scanned repository');
    assertNullable(repo.known, assertText, 'the project that names a scanned repository');
    if (!Array.isArray(repo.folders)) throw new TypeError("a scanned repository's folders are a list");
    for (const folder of repo.folders) {
      assertClosedRecord(folder, ['folder', 'kind', 'defaultBranch'], 'a scanned folder');
      assertText(folder.folder, 'a scanned folder');
      if (folder.kind !== 'checkout' && folder.kind !== 'worktree')
        throw new TypeError('a scanned folder is a checkout or a worktree');
      assertNullable(folder.defaultBranch, assertText, "a scanned checkout's branch");
    }
  }
  if (!Array.isArray(value.skipped)) throw new TypeError("a scan's passed-over folders are a list");
  for (const entry of value.skipped) {
    assertClosedRecord(entry, ['folder', 'reason'], 'a folder a scan passed over');
    assertText(entry.folder, 'a folder a scan passed over');
    if (!(PROJECT_SCAN_SKIP_REASONS as readonly unknown[]).includes(entry.reason))
      throw new TypeError('a scan passes a folder over for a closed reason');
  }
}

/** One `session-queue list` item: ids, a lane and times, content-free. */
function assertSessionQueueItem(value: unknown): void {
  assertClosedRecord(
    value,
    [
      'deliveryId',
      'relaySessionId',
      'ruleId',
      'ruleVersion',
      'targetId',
      'targetVersion',
      'lane',
      'queuedAt',
      'released',
      'expiresAt',
    ],
    'a waiting session item',
  );
  for (const field of ['deliveryId', 'ruleId', 'targetId']) assertText(value[field], `a waiting session item ${field}`);
  if (typeof value.relaySessionId !== 'string' || !/^sess_[0-9a-f-]{36}$/u.test(value.relaySessionId))
    throw new TypeError('a waiting session item names its relay session');
  for (const field of ['ruleVersion', 'targetVersion'])
    assertPositiveInteger(value[field], `a waiting session item ${field}`);
  if (value.lane !== null && !isLaneName(value.lane))
    throw new TypeError('a waiting session item has a malformed lane');
  assertIsoTime(value.queuedAt, 'a waiting session item queuedAt');
  assertIsoTime(value.expiresAt, 'a waiting session item expiresAt');
  if (typeof value.released !== 'boolean') throw new TypeError('a waiting session item says whether it was let go');
}

/** A lane's binding, as `lane list` and `lane bind` give it (routing design §6's JSON contract). */
function assertLaneBinding(value: unknown, name: string): void {
  assertClosedRecord(value, ['window', 'since'], name);
  assertClosedRecord(value.window, ['sessionId', 'activityKey', 'folder', 'folderShown', 'client'], `${name} window`);
  const window = value.window;
  if (window.sessionId !== null && !isClaudeCodeSessionId(window.sessionId))
    throw new TypeError(`${name} has a malformed session id`);
  if (window.activityKey !== null && !isActivityKey(window.activityKey))
    throw new TypeError(`${name} has a malformed activity key`);
  if (window.sessionId === null && window.activityKey === null) throw new TypeError(`${name} names no window`);
  if (window.folder !== null) assertText(window.folder, `${name} folder`);
  if (window.folderShown !== null) assertText(window.folderShown, `${name} folder as shown`);
  if ((window.folder === null) !== (window.folderShown === null))
    throw new TypeError(`${name} shows a folder only when it has one`);
  if (window.client !== null) {
    if (!isRecord(window.client)) throw new TypeError(`${name} client must be a closed object`);
    assertClosedRecord(window.client, Object.hasOwn(window.client, 'version') ? ['name', 'version'] : ['name'], name);
    assertText(window.client.name, `${name} client name`);
    if (window.client.version !== undefined) assertText(window.client.version, `${name} client version`);
  }
  assertIsoTime(value.since, `${name} since`);
}

const MESSAGE_SOURCE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  gmail: ['channel', 'messageId'],
  slack: ['channel', 'channelId', 'ts'],
  whatsapp: ['channel', 'chatId', 'messageId'],
  resend: ['channel', 'emailId'],
});
const MESSAGE_HISTORY_KINDS = ['woken', 'read', 'done', 'dismissed', 'reopened'];

/**
 * One message's story (0.32.0 spec §3.6): ids, times in milliseconds and closed words; `kept` is the only sender text,
 * and each of its strings is an untrusted-content envelope.
 */
function assertMessageEntry(value: unknown, name: string): void {
  assertClosedRecord(
    value,
    [
      'eventId',
      'type',
      'channel',
      'accountId',
      'occurredAt',
      'observedAt',
      'source',
      'decisions',
      'deliveries',
      'queueItem',
      'kept',
    ],
    name,
  );
  if (!isEventId(value.eventId)) throw new TypeError(`${name} has a malformed event id`);
  for (const field of ['type', 'channel', 'accountId']) assertText(value[field], `${name} ${field}`);
  for (const field of ['occurredAt', 'observedAt']) assertNonNegativeInteger(value[field], `${name} ${field}`);
  if (value.source !== null) {
    if (!isRecord(value.source) || typeof value.source.channel !== 'string')
      throw new TypeError(`${name} source must be a closed object`);
    const fields = MESSAGE_SOURCE_FIELDS[value.source.channel];
    if (fields === undefined) throw new TypeError(`${name} source has an unknown channel`);
    assertClosedRecord(value.source, fields, `${name} source`);
    for (const field of fields.slice(1)) assertText(value.source[field], `${name} source ${field}`);
  }
  if (!Array.isArray(value.decisions)) throw new TypeError(`${name} needs its decisions`);
  for (const decision of value.decisions) {
    assertClosedRecord(decision, ['ruleId', 'ruleVersion', 'outcome', 'judge'], `${name} decision`);
    assertText(decision.ruleId, `${name} decision rule id`);
    assertPositiveInteger(decision.ruleVersion, `${name} decision rule version`);
    if (!MESSAGE_DECISION_OUTCOMES.includes(decision.outcome as never))
      throw new TypeError(`${name} decision has an unknown outcome`);
    if (decision.judge !== null) {
      assertClosedRecord(decision.judge, ['kind', 'answer', 'confidence', 'calibrated'], `${name} judge`);
      assertText(decision.judge.kind, `${name} judge kind`);
      if (!QUEUE_JUDGE_ANSWERS.includes(decision.judge.answer as never))
        throw new TypeError(`${name} judge has an unknown answer`);
      if (typeof decision.judge.confidence !== 'number' || !Number.isFinite(decision.judge.confidence))
        throw new TypeError(`${name} judge confidence must be a finite number`);
      if (typeof decision.judge.calibrated !== 'boolean') throw new TypeError(`${name} judge calibrated is a boolean`);
    }
  }
  if (!Array.isArray(value.deliveries)) throw new TypeError(`${name} needs its deliveries`);
  for (const delivery of value.deliveries) {
    assertClosedRecord(delivery, ['deliveryId', 'targetKind', 'targetId', 'lane', 'state'], `${name} delivery`);
    assertText(delivery.deliveryId, `${name} delivery id`);
    if (!MESSAGE_TARGET_KINDS.includes(delivery.targetKind as never))
      throw new TypeError(`${name} delivery has an unknown target kind`);
    assertText(delivery.targetId, `${name} delivery target id`);
    if (delivery.lane !== null && !isLaneName(delivery.lane)) throw new TypeError(`${name} delivery has a bad lane`);
    if (!MESSAGE_DELIVERY_STATES.includes(delivery.state as never))
      throw new TypeError(`${name} delivery has an unknown state`);
  }
  if (value.queueItem !== null) {
    const item = value.queueItem;
    assertClosedRecord(item, ['itemId', 'state', 'stateAt', 'lane', 'history'], `${name} queue item`);
    if (!isQueueItemId(item.itemId)) throw new TypeError(`${name} queue item has a malformed id`);
    if (!QUEUE_STATES.includes(item.state as never)) throw new TypeError(`${name} queue item has an unknown state`);
    assertNonNegativeInteger(item.stateAt, `${name} queue item stateAt`);
    if (item.lane !== null && !isLaneName(item.lane)) throw new TypeError(`${name} queue item has a bad lane`);
    if (!Array.isArray(item.history)) throw new TypeError(`${name} queue item needs its history`);
    for (const line of item.history) {
      assertClosedRecord(line, ['at', 'kind', 'actor', 'windowKey'], `${name} history line`);
      assertNonNegativeInteger(line.at, `${name} history time`);
      if (!MESSAGE_HISTORY_KINDS.includes(line.kind as string))
        throw new TypeError(`${name} history line has an unknown kind`);
      if (line.actor === 'window') {
        if (!isActivityKey(line.windowKey)) throw new TypeError(`${name} history line names no window`);
      } else if (line.actor !== 'person' || line.windowKey !== null)
        throw new TypeError(`${name} history line has an unknown actor`);
    }
  }
  if (value.kept !== null) {
    const kept = value.kept;
    if (!isRecord(kept)) throw new TypeError(`${name} kept must be a closed object`);
    assertClosedRecord(kept, Object.hasOwn(kept, 'subject') ? ['from', 'subject'] : ['from'], `${name} kept`);
    if (!isRecord(kept.from) || Object.keys(kept.from).some((key) => key !== 'name' && key !== 'address'))
      throw new TypeError(`${name} kept from must be a closed object`);
    for (const field of [kept.from.name, kept.from.address, kept.subject])
      if (field !== undefined && (typeof field !== 'string' || !field.startsWith('<untrusted-content ')))
        throw new TypeError(`${name} kept sender text must be enveloped`);
  }
}

function assertTighteningPreview(value: unknown): void {
  if (!isRecord(value)) throw new TypeError('a tightening preview must be a closed object');
  assertClosedRecord(
    value,
    ['editKind', 'appliesWhen', 'openQueueItemsRemoved', ...(Object.hasOwn(value, 'notice') ? ['notice'] : [])],
    'a tightening preview',
  );
  assertText(value.editKind, 'a tightening edit kind');
  if (value.appliesWhen !== 'rule enable') throw new TypeError('a tightening applies when its version is enabled');
  assertNonNegativeInteger(value.openQueueItemsRemoved, 'a tightening open queue item count');
  if (value.notice !== undefined) assertText(value.notice, 'a tightening notice');
}

const B3_ORDINARY_RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  status: ['owner', 'enabled', 'paused', 'switchGeneration', 'activationIntents'],
  stop: ['stopping'],
  pause: ['enabled', 'paused', 'switchGeneration'],
  resume: ['enabled', 'paused', 'switchGeneration'],
  'disable-all': ['enabled', 'paused', 'switchGeneration'],
  'enable-all': ['intentId', 'approvalId', 'binding', 'kind', 'status', 'replacementOfVersion'],
  'catalogue-show': ['type', 'version', 'channel'],
  'source-show': ['source', 'accounts'],
  'rule-create': ['id', 'kind', 'objectId', 'version', 'document', 'digest', 'state'],
  'rule-update': ['id', 'kind', 'objectId', 'version', 'document', 'digest', 'state'],
  'rule-enable': ['intentId', 'approvalId', 'binding', 'kind', 'status', 'replacementOfVersion'],
  'rule-disable': ['ruleId', 'disabled'],
  'rule-remove': ['ruleId', 'disabled'],
  'target-add': ['id', 'kind', 'objectId', 'version', 'document', 'digest', 'state'],
  'target-update': ['id', 'kind', 'objectId', 'version', 'document', 'digest', 'state'],
  'target-remove': ['targetId', 'removed'],
  approve: ['intentId', 'status', 'usedAt'],
  ruleTest: ['agentic', 'outcome', 'rendered'],
  ruleTestRetained: ['agentic', 'outcome', 'rendered'],
  targetTest: ['attempts', 'targetId', 'targetVersion'],
  targetResume: ['id', 'resetEpoch'],
  addSubscriber: ['id', 'kind', 'objectId', 'version', 'document', 'digest', 'state'],
  updateSubscriber: ['id', 'kind', 'objectId', 'version', 'document', 'digest', 'state'],
  removeSubscriber: ['subscriberId', 'removed'],
  retryDelivery: ['kind', 'deliveryId', 'nextAt'],
  dropDelivery: ['kind', 'deliveryId'],
  'queue-list': ['items', 'more'],
  'queue-show': ['item'],
  'queue-items': ['items', 'more'],
  'queue-counts': ['open', 'done', 'dismissed', 'byRule'],
  'queue-done': ['item'],
  'queue-dismiss': ['item'],
  'queue-reopen': ['item'],
  'queue-clear': ['cleared'],
  'lane-list': ['lanes'],
  'lane-bind': ['lane', 'binding'],
  'lane-unbind': ['lane', 'unbound'],
  'delivery-show': ['delivery', 'decision', 'event', 'target', 'dryRun'],
  'messages-list': ['messages', 'next'],
  'message-show': ['message'],
  'judge-setup': ['kind', 'enabled', 'enabledNow', 'judge', 'budget', 'key', 'destination', 'approvedBy'],
  'rule-approve': ['approvalId', 'ruleId', 'version', 'approved', 'approvedBy', 'completion'],
  'enable-all-approve': ['approvalId', 'approved', 'approvedBy', 'ruleVersions', 'completion'],
  'provider-list': ['providers'],
  'provider-key-set': ['provider', 'hasKey', 'judges'],
  'provider-key-remove': ['provider', 'hasKey', 'judges'],
  'integration-show': ['integration', 'connected', 'workspace', 'teams'],
  'projects-list': ['projects'],
  'project-show': PROJECT_RESULT_FIELDS,
  'project-add': PROJECT_RESULT_FIELDS,
  'project-update': PROJECT_RESULT_FIELDS,
  'project-remove': ['projectId', 'removed'],
  'project-scan': ['roots', 'repos', 'skipped'],
  'integration-set': ['integration', 'settings', 'relay', 'waiting'],
  'session-queue-list': ['items'],
  'session-queue-drop': ['deliveryId', 'dropped'],
  'rule-analyse': ['ruleId', 'analysed', 'counts', 'suggestions', 'model'],
  'judge-show': ['judgeId', 'version', 'document', 'digest', 'state'],
  'subscriber-enable': ['intentId', 'approvalId', 'binding', 'kind', 'status', 'replacementOfVersion'],
  'subscriber-approve': ['approvalId', 'subscriberId', 'version', 'approved', 'approvedBy', 'completion'],
  'workflow-events-list': ['catalogueVersion', 'schemas'],
  'workflow-events-show': ['catalogueVersion', 'schema', 'standard', 'own', 'outputs'],
  'dryrun-show': [
    'deliveryId',
    'ruleId',
    'ruleVersion',
    'targetId',
    'targetVersion',
    'eventId',
    'accountId',
    'deliveredAt',
    'expiresAt',
    'record',
  ],
});

function assertNullableNumber(value: unknown, name: string): void {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
    throw new TypeError(`${name} must be a number or null`);
}

/**
 * Analyse's result (0.33.0 design §3.3): what was analysed, the counts — numbers, closed words and, for each listed
 * sending domain, the domain inside the untrusted-content envelope — the suggestions and what the model did.
 */
function assertRuleAnalyseResult(value: Readonly<Record<string, unknown>>): void {
  assertText(value.ruleId, 'an analysed rule id');
  if (!isRecord(value.analysed)) throw new TypeError('an analysis says what it analysed');
  if (value.analysed.source === 'stored') {
    assertClosedRecord(value.analysed, ['source', 'version'], 'an analysed stored version');
    assertPositiveInteger(value.analysed.version, 'an analysed version');
  } else assertClosedRecord(value.analysed, ['source'], 'an analysed draft');
  if (value.analysed.source !== 'stored' && value.analysed.source !== 'draft')
    throw new TypeError('an analysis analysed a stored version or a draft');
  const counts = value.counts;
  assertClosedRecord(
    counts,
    ['windowDays', 'since', 'decisions', 'outcomes', 'judge', 'domainsKnown', 'domains', 'queue'],
    'analysed counts',
  );
  if (counts.windowDays !== ANALYSE_WINDOW_DAYS) throw new TypeError('analysed counts cover 30 days');
  for (const field of ['since', 'decisions', 'domainsKnown']) assertNonNegativeInteger(counts[field], field);
  assertClosedRecord(counts.outcomes, MESSAGE_DECISION_OUTCOMES, 'analysed outcomes');
  for (const outcome of MESSAGE_DECISION_OUTCOMES) assertNonNegativeInteger(counts.outcomes[outcome], outcome);
  if (counts.judge !== null) {
    assertClosedRecord(
      counts.judge,
      ['answered', 'yes', 'no', 'held', 'spread', 'lowest', 'highest'],
      "analysed judge's answers",
    );
    for (const field of ['answered', 'yes', 'no', 'held']) assertNonNegativeInteger(counts.judge[field], field);
    if (!Array.isArray(counts.judge.spread) || counts.judge.spread.length !== 10)
      throw new TypeError("the judge's spread is ten bands");
    for (const band of counts.judge.spread) assertNonNegativeInteger(band, 'a spread band');
    assertNullableNumber(counts.judge.lowest, 'the lowest answer');
    assertNullableNumber(counts.judge.highest, 'the highest answer');
  }
  if (!Array.isArray(counts.domains)) throw new TypeError('analysed domains are a list');
  for (const entry of counts.domains) {
    assertClosedRecord(entry, ['domain', 'judged', 'yes', 'no'], 'an analysed domain');
    if (typeof entry.domain !== 'string' || !entry.domain.startsWith('<untrusted-content '))
      throw new TypeError('a sending domain is inside the untrusted-content envelope');
    for (const field of ['judged', 'yes', 'no']) assertNonNegativeInteger(entry[field], field);
  }
  assertClosedRecord(counts.queue, ['open', 'done', 'dismissed', 'lowestDone', 'highestDismissed'], 'analysed queue');
  for (const field of ['open', 'done', 'dismissed']) assertNonNegativeInteger(counts.queue[field], field);
  assertNullableNumber(counts.queue.lowestDone, 'the lowest kept score');
  assertNullableNumber(counts.queue.highestDismissed, 'the highest dismissed score');
  if (!Array.isArray(value.suggestions)) throw new TypeError('suggestions are a list');
  for (const suggestion of value.suggestions) {
    assertClosedRecord(suggestion, ['part', 'before', 'after', 'why', 'evidence'], 'a suggestion');
    if (!(RULE_ANALYSE_PARTS as readonly unknown[]).includes(suggestion.part))
      throw new TypeError('a suggestion names a part of the rule');
    for (const field of ['before', 'after'])
      if (suggestion[field] !== null && typeof suggestion[field] !== 'string')
        throw new TypeError(`a suggestion's ${field} is text or null`);
    assertText(suggestion.why, "a suggestion's why");
    if (!isRecord(suggestion.evidence) || (suggestion.evidence.by !== 'counts' && suggestion.evidence.by !== 'model'))
      throw new TypeError('a suggestion says what it rests on');
  }
  const model = value.model;
  assertClosedRecord(model, ['provider', 'name', 'model', 'ran', 'reason', 'noKey', 'sent', 'parts'], 'the model part');
  if (model.provider !== null && !(ANALYSE_PROVIDERS as readonly unknown[]).includes(model.provider))
    throw new TypeError("the model's provider is one of Analyse's");
  if (typeof model.ran !== 'boolean') throw new TypeError('the model part says whether it ran');
  if (model.reason !== null && model.reason !== 'NO_KEY' && model.reason !== 'NO_MODEL_PARTS')
    throw new TypeError('the model part says why it did not run in closed words');
  if (
    !Array.isArray(model.noKey) ||
    model.noKey.some((entry) => !(ANALYSE_PROVIDERS as readonly unknown[]).includes(entry))
  )
    throw new TypeError('the providers without a key are Analyse providers');
  assertText(model.sent, 'what the model was sent');
  if (!Array.isArray(model.parts)) throw new TypeError("the model's parts are a list");
  for (const part of model.parts) {
    assertClosedRecord(part, ['part', 'at', 'outcome'], "a model's part");
    assertText(part.outcome, "a model part's outcome");
  }
}

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${name} must be a non-negative integer`);
}

function assertPendingTargetSelector(value: unknown, name: string): asserts value is B3PendingTargetSelectorV1 {
  assertClosedRecord(
    value,
    ['kind', 'activationId', 'ruleId', 'ruleVersion', 'targetId', 'targetVersion', 'approvalId', 'digest', 'challenge'],
    name,
  );
  if (value.kind !== 'pending-activation') throw new TypeError(`${name} has an unknown selector kind`);
  for (const field of ['activationId', 'ruleId', 'targetId', 'approvalId', 'digest', 'challenge'])
    assertText(value[field], `${name} ${field}`);
  assertPositiveInteger(value.ruleVersion, `${name} rule version`);
  assertPositiveInteger(value.targetVersion, `${name} target version`);
}

function assertB3ActivationBinding(value: unknown, intentId: string, kind: B3IntentKind): void {
  assertClosedRecord(value, ['digest', 'activationIntentId', 'activationKind', 'versions'], 'an activation binding');
  if (!Array.isArray(value.versions)) throw new TypeError('an activation binding needs version entries');
  for (const version of value.versions) {
    assertClosedRecord(version, ['kind', 'id', 'version'], 'an activation binding version');
    if (!B3_DISCLOSURE_VERSION_KINDS.includes(version.kind as B3DisclosureVersionKind))
      throw new TypeError('an activation binding has an unknown version kind');
    assertText(version.id, 'an activation binding version id');
    assertPositiveInteger(version.version, 'an activation binding version');
  }
  if (
    !B3_DISCLOSURE_ACTIVATION_KINDS.includes(value.activationKind as B3DisclosureActivationKind) ||
    value.activationIntentId !== intentId ||
    value.activationKind !== kind
  ) {
    throw new TypeError('an activation binding does not match its prepared intent');
  }
  try {
    canonicalDisclosureBinding(value as unknown as DisclosureBinding);
  } catch {
    throw new TypeError('an activation binding is not core-canonical');
  }
}

function assertB3PreparedActivation(
  value: Record<string, unknown>,
  operation: 'enable-all' | 'rule-enable' | 'subscriber-enable',
): void {
  const fields = B3_ORDINARY_RESULT_FIELDS[operation] ?? [];
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new TypeError(`a ${operation} result must be a closed object`);
  for (const field of ['intentId', 'approvalId', 'binding', 'kind', 'status']) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`a ${operation} result must be a closed object`);
  }
  assertText(value.intentId, 'an activation intent id');
  assertText(value.approvalId, 'an activation approval id');
  if (!B3_INTENT_KINDS.includes(value.kind as B3IntentKind))
    throw new TypeError(`a ${operation} result has an unknown activation kind`);
  if (value.status !== 'pending') throw new TypeError(`a ${operation} result is not pending`);
  if (Object.hasOwn(value, 'replacementOfVersion')) assertText(value.replacementOfVersion, 'a replacement version id');
  assertB3ActivationBinding(value.binding, value.intentId, value.kind as B3IntentKind);
}

function assertB3PendingVersion(value: Record<string, unknown>, kind: 'rule' | 'target' | 'subscriber'): void {
  if (value.kind !== kind) throw new TypeError(`a pending ${kind} version has the wrong kind`);
  assertText(value.id, `a pending ${kind} version id`);
  assertText(value.objectId, `a pending ${kind} object id`);
  assertPositiveInteger(value.version, `a pending ${kind} version`);
  if (value.id !== `${value.objectId}@${value.version}`)
    throw new TypeError(`a pending ${kind} version id does not name its object version`);
  assertText(value.digest, `a pending ${kind} digest`);
  if (value.state !== null) throw new TypeError(`a pending ${kind} version must be inert`);
  switch (kind) {
    case 'rule':
      canonicalFullRuleDocument(value.document);
      return;
    case 'target':
      canonicalTarget(value.document);
      return;
    case 'subscriber':
      canonicalSubscriber(value.document);
      return;
  }
}

/** One schema of the step event catalogue, exactly as `@agentcomms/events` holds it (Appendix W.3). */
function assertWorkflowEventSchemaEntry(value: unknown, name: string): void {
  assertClosedRecord(value, ['schema', 'standard', 'own', 'outputs'], name);
  const known = (WORKFLOW_EVENT_CATALOGUE_V1 as Readonly<Record<string, unknown>>)[value.schema as string];
  if (typeof value.schema !== 'string' || known === undefined) throw new TypeError(`${name} names a known schema`);
  if (
    canonicalJson({ ...(known as object) } as never) !==
    canonicalJson({ standard: value.standard, own: value.own, outputs: value.outputs } as never)
  )
    throw new TypeError(`${name} is Appendix W.3's, exactly`);
}

function assertB3OrdinaryControlResultV1(operation: B3DesktopControlOperation, value: unknown): void {
  if (B3_ORDINARY_RESULT_ARRAY_OPERATIONS.has(operation)) {
    if (Array.isArray(value) && value.every(isJsonValue)) return;
    throw new TypeError(`a ${operation} result must be a JSON array`);
  }
  const fields = B3_ORDINARY_RESULT_FIELDS[operation];
  if (fields === undefined) throw new TypeError(`a ${operation} result has no ordinary result grammar`);
  if (operation === 'enable-all' || operation === 'rule-enable' || operation === 'subscriber-enable') {
    if (!isRecord(value)) throw new TypeError(`a ${operation} result must be a closed object`);
    assertB3PreparedActivation(value, operation);
    return;
  }
  if ((operation === 'rule-create' || operation === 'rule-update') && isRecord(value) && 'tightening' in value) {
    const { tightening, ...version } = value;
    assertTighteningPreview(tightening);
    assertB3OrdinaryControlResultV1(operation, version);
    return;
  }
  if (operation === 'integration-show' && isRecord(value)) {
    if (value.integration === 'agent-sessions') assertAgentSessionsIntegration(value);
    else assertIntegrationShow(value);
    return;
  }
  assertClosedRecord(value, fields, `a ${operation} result`);
  switch (operation) {
    case 'status': {
      if (!B3_OWNER_STATES.includes(value.owner as B3OwnerState))
        throw new TypeError('a status result has an unknown owner state');
      if (typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean')
        throw new TypeError('a status result needs lifecycle booleans');
      assertNonNegativeInteger(value.switchGeneration, 'a status switch generation');
      if (!Array.isArray(value.activationIntents)) throw new TypeError('a status result needs activation summaries');
      for (const intent of value.activationIntents) {
        assertClosedRecord(intent, ['status', 'failureCode', 'count'], 'an activation intent summary');
        if (!B3_ACTIVATION_STATUSES.includes(intent.status as B3ActivationStatus))
          throw new TypeError('an activation intent summary has an unknown status');
        if (
          intent.failureCode !== null &&
          !B3_ACTIVATION_FAILURE_CODES.includes(intent.failureCode as B3ActivationFailureCode)
        )
          throw new TypeError('an activation intent summary has an unknown failure code');
        assertNonNegativeInteger(intent.count, 'an activation intent summary count');
      }
      return;
    }
    case 'rule-create':
    case 'rule-update':
      assertB3PendingVersion(value, 'rule');
      return;
    case 'target-add':
    case 'target-update':
      assertB3PendingVersion(value, 'target');
      return;
    case 'addSubscriber':
    case 'updateSubscriber':
      assertB3PendingVersion(value, 'subscriber');
      return;
    case 'rule-remove':
    case 'rule-disable':
      assertText(value.ruleId, `a ${operation} rule id`);
      if (value.disabled !== true) throw new TypeError(`a ${operation} result must disable the rule`);
      return;
    case 'approve':
      assertText(value.intentId, 'an approval intent id');
      if (value.status !== 'completed') throw new TypeError('an approve result must be completed');
      assertText(value.usedAt, 'an approval completion timestamp');
      return;
    case 'ruleTest':
    case 'ruleTestRetained':
      if (value.agentic !== 'not-evaluated' || !B3_RULE_TEST_OUTCOMES.includes(value.outcome as B3RuleTestOutcome))
        throw new TypeError(`a ${operation} result has an unknown rule-test outcome`);
      assertText(value.rendered, `a ${operation} rendered result`);
      return;
    case 'targetTest':
      assertPositiveInteger(value.attempts, 'a target-test attempt count');
      assertText(value.targetId, 'a target-test target id');
      assertPositiveInteger(value.targetVersion, 'a target-test target version');
      return;
    case 'targetResume':
      assertText(value.id, 'a target-resume reset id');
      assertPositiveInteger(value.resetEpoch, 'a target-resume reset epoch');
      return;
    case 'retryDelivery':
      if (value.kind !== 'delivery-retried') throw new TypeError('a retryDelivery result has an unknown result kind');
      assertText(value.deliveryId, 'a retry delivery id');
      assertNonNegativeInteger(value.nextAt, 'a retry delivery next time');
      return;
    case 'dropDelivery':
      if (value.kind !== 'delivery-dropped') throw new TypeError('a dropDelivery result has an unknown result kind');
      assertText(value.deliveryId, 'a dropped delivery id');
      return;
    case 'queue-list':
    case 'queue-items': {
      if (!Array.isArray(value.items) || typeof value.more !== 'boolean')
        throw new TypeError(`a ${operation} result needs items and more`);
      for (const item of value.items)
        if (operation === 'queue-list') assertQueueItem(item, 'a queue list item');
        else assertQueueItemSummary(item, 'a queue items entry');
      return;
    }
    case 'queue-show':
      assertQueueItem(value.item, 'a queue show item');
      return;
    case 'queue-counts': {
      for (const field of ['open', 'done', 'dismissed'])
        assertNonNegativeInteger(value[field], `a queue ${field} count`);
      if (!Array.isArray(value.byRule)) throw new TypeError('a queue counts result needs its per-rule counts');
      for (const entry of value.byRule) {
        assertClosedRecord(entry, ['ruleId', 'name', 'open'], 'a per-rule queue count');
        assertText(entry.ruleId, 'a per-rule queue count rule id');
        assertText(entry.name, 'a per-rule queue count name');
        assertNonNegativeInteger(entry.open, 'a per-rule open count');
      }
      return;
    }
    case 'queue-done':
    case 'queue-dismiss':
    case 'queue-reopen':
      assertQueueStateChange(value, `a ${operation} result`);
      return;
    case 'queue-clear':
      assertNonNegativeInteger(value.cleared, 'a queue clear count');
      return;
    case 'lane-list': {
      if (!Array.isArray(value.lanes)) throw new TypeError('a lane list result needs its lanes');
      for (const lane of value.lanes) {
        assertClosedRecord(lane, ['name', 'rules', 'channels', 'open', 'binding'], 'a listed lane');
        if (!isLaneName(lane.name)) throw new TypeError('a listed lane has a malformed name');
        if (!Array.isArray(lane.rules)) throw new TypeError('a listed lane needs its rules');
        for (const rule of lane.rules) {
          assertClosedRecord(rule, ['id'], 'a listed lane rule');
          assertText(rule.id, 'a listed lane rule id');
        }
        if (!Array.isArray(lane.channels) || lane.channels.some((channel) => !QUEUE_CHANNELS.includes(channel)))
          throw new TypeError('a listed lane has an unknown channel');
        assertNonNegativeInteger(lane.open, 'a listed lane open count');
        if (lane.binding !== null) assertLaneBinding(lane.binding, 'a listed lane binding');
      }
      return;
    }
    case 'lane-bind':
      if (!isLaneName(value.lane)) throw new TypeError('a lane bind result has a malformed lane name');
      assertLaneBinding(value.binding, 'a lane bind binding');
      return;
    case 'lane-unbind':
      if (!isLaneName(value.lane)) throw new TypeError('a lane unbind result has a malformed lane name');
      if (value.unbound !== true) throw new TypeError('a lane unbind result says it unbound');
      return;
    case 'delivery-show':
      assertDeliveryShow(value);
      return;
    case 'messages-list':
      if (!Array.isArray(value.messages)) throw new TypeError('a messages list result needs its messages');
      if (value.messages.length > MESSAGES_LIST_MAX_LIMIT) throw new TypeError('a messages list page is too long');
      for (const entry of value.messages) assertMessageEntry(entry, 'a listed message');
      if (value.next !== null && !isMessagesCursor(value.next))
        throw new TypeError('a messages list result has a malformed next cursor');
      return;
    case 'message-show':
      assertMessageEntry(value.message, 'a shown message');
      return;
    case 'judge-setup':
      assertJudgeSetupResult(value);
      return;
    case 'rule-approve':
      assertText(value.approvalId, 'an approved approval id');
      assertText(value.ruleId, 'an approved rule id');
      assertPositiveInteger(value.version, 'an approved rule version');
      if (value.approved !== true) throw new TypeError('a rule approval says it approved');
      if (
        typeof value.approvedBy !== 'string' ||
        value.approvedBy === 'terminal' ||
        !(PERSON_CHANGE_APPROVERS as readonly string[]).includes(value.approvedBy)
      )
        throw new TypeError('a rule approval names the app it came from');
      assertClosedRecord(value.completion, ['intentId', 'status', 'usedAt'], "a rule approval's completion");
      assertText(value.completion.intentId, 'a completed activation');
      if (value.completion.status !== 'completed') throw new TypeError('an approved activation is completed');
      assertText(value.completion.usedAt, 'when the approval was used');
      return;
    case 'subscriber-approve':
      assertText(value.approvalId, 'an approved approval id');
      assertText(value.subscriberId, 'an approved subscriber id');
      assertPositiveInteger(value.version, 'an approved subscriber version');
      if (value.approved !== true) throw new TypeError("a subscriber's approval says it approved");
      if (
        typeof value.approvedBy !== 'string' ||
        value.approvedBy === 'terminal' ||
        !(PERSON_CHANGE_APPROVERS as readonly string[]).includes(value.approvedBy)
      )
        throw new TypeError("a subscriber's approval names the app it came from");
      assertClosedRecord(value.completion, ['intentId', 'status', 'usedAt'], "a subscriber approval's completion");
      assertText(value.completion.intentId, 'a completed activation');
      if (value.completion.status !== 'completed') throw new TypeError('an approved activation is completed');
      assertText(value.completion.usedAt, 'when the approval was used');
      return;
    case 'workflow-events-list':
      if (value.catalogueVersion !== 1 || !Array.isArray(value.schemas))
        throw new TypeError('the step event catalogue is version 1, with its schemas');
      for (const entry of value.schemas) assertWorkflowEventSchemaEntry(entry, 'a catalogue schema');
      return;
    case 'workflow-events-show': {
      const { catalogueVersion, ...entry } = value;
      if (catalogueVersion !== 1) throw new TypeError('the step event catalogue is version 1');
      assertWorkflowEventSchemaEntry(entry, 'a shown catalogue schema');
      return;
    }
    case 'enable-all-approve':
      assertText(value.approvalId, 'an approved approval id');
      if (value.approved !== true) throw new TypeError('switching on says it approved');
      if (
        typeof value.approvedBy !== 'string' ||
        value.approvedBy === 'terminal' ||
        !(PERSON_CHANGE_APPROVERS as readonly string[]).includes(value.approvedBy)
      )
        throw new TypeError('switching on names the app it came from');
      if (!Array.isArray(value.ruleVersions)) throw new TypeError('switching on lists the rule versions it covers');
      for (const entry of value.ruleVersions) {
        assertClosedRecord(entry, ['ruleId', 'ruleVersion'], 'a rule version switching on covers');
        assertText(entry.ruleId, 'a covered rule id');
        assertPositiveInteger(entry.ruleVersion, 'a covered rule version');
      }
      assertClosedRecord(value.completion, ['intentId', 'status', 'usedAt'], "switching on's completion");
      assertText(value.completion.intentId, 'a completed activation');
      if (value.completion.status !== 'completed') throw new TypeError('an approved activation is completed');
      assertText(value.completion.usedAt, 'when the approval was used');
      return;
    case 'provider-list':
      if (!Array.isArray(value.providers)) throw new TypeError('a provider list result needs its providers');
      for (const entry of value.providers) {
        assertClosedRecord(entry, ['id', 'name', 'hasKey'], 'a listed provider');
        if (!isEventSecretProvider(entry.id)) throw new TypeError('a listed provider is unknown');
        assertText(entry.name, 'a listed provider name');
        if (typeof entry.hasKey !== 'boolean') throw new TypeError('a listed provider says whether it has a key');
      }
      return;
    case 'rule-analyse':
      assertRuleAnalyseResult(value);
      return;
    case 'judge-show': {
      assertText(value.judgeId, 'a shown judge id');
      assertPositiveInteger(value.version, 'a shown judge version');
      if (value.state !== 'live' && value.state !== 'revoked') throw new TypeError('a shown judge is live or revoked');
      if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.digest))
        throw new TypeError("a shown judge's digest is a SHA-256");
      // The document is exactly a canonical judge document: closed, with no field a key could ride in.
      const document = canonicalJudge(value.document);
      if (canonicalJson(document as never) !== canonicalJson(value.document as never))
        throw new TypeError('a shown judge document is canonical');
      if (document.judgeId !== value.judgeId || document.version !== value.version)
        throw new TypeError('a shown judge document is that judge version');
      return;
    }
    case 'provider-key-set':
    case 'provider-key-remove':
      if (!isEventSecretProvider(value.provider)) throw new TypeError('a provider key result names a known provider');
      if (value.hasKey !== (operation === 'provider-key-set'))
        throw new TypeError('a provider key result says whether the provider has a key now');
      assertNonNegativeInteger(value.judges, 'a provider key judge count');
      return;
    case 'projects-list':
      if (!Array.isArray(value.projects)) throw new TypeError('a project list needs its projects');
      for (const project of value.projects) assertProject(project);
      return;
    case 'project-show':
    case 'project-add':
    case 'project-update':
      assertProject(value);
      return;
    case 'project-remove':
      assertText(value.projectId, 'a removed project');
      if (value.removed !== true) throw new TypeError('a project removal says it removed the project');
      return;
    case 'project-scan':
      assertProjectScan(value);
      return;
    case 'integration-set':
      assertAgentSessionsIntegration(value);
      return;
    case 'session-queue-list':
      if (!Array.isArray(value.items)) throw new TypeError('a session queue list needs its items');
      for (const item of value.items) assertSessionQueueItem(item);
      return;
    case 'session-queue-drop':
      assertText(value.deliveryId, 'a dropped session item id');
      if (value.dropped !== true) throw new TypeError('a session queue drop says it dropped the item');
      return;
    case 'dryrun-show':
      for (const field of ['deliveryId', 'ruleId', 'targetId', 'eventId', 'accountId']) assertText(value[field], field);
      for (const field of ['ruleVersion', 'targetVersion']) assertPositiveInteger(value[field], field);
      for (const field of ['deliveredAt', 'expiresAt']) assertNonNegativeInteger(value[field], field);
      assertClosedRecord(value.record, ['cloudEventBytes', 'untrusted', 'representation'], 'a dry-run record');
      assertText(value.record.cloudEventBytes, 'a dry-run cloud event');
      if (!Array.isArray(value.record.untrusted) || value.record.untrusted.some((path) => typeof path !== 'string'))
        throw new TypeError('a dry-run record has malformed untrusted paths');
      if (!B3_DELIVERY_REPRESENTATIONS.includes(value.record.representation as B3DeliveryRepresentation))
        throw new TypeError('a dry-run record has an unknown representation');
      return;
    default:
      return;
  }
}

function assertB3ControlResultV1(value: unknown): asserts value is B3ControlResultV1 {
  if (isRecord(value) && value.schemaVersion === 'doctor-v1') {
    assertClosedRecord(
      value,
      [
        'schemaVersion',
        'owner',
        'switch',
        'lineages',
        'superseded',
        'points',
        'awaitingReapproval',
        'activationIntents',
        'sources',
        'recovery',
        'judgeBoundary',
        'whatsapp',
      ],
      'a doctor-v1 result',
    );
    return;
  }
  if (!isRecord(value)) throw new TypeError('a B3 control result needs a closed object');
  if (typeof value.kind !== 'string') throw new TypeError('a B3 control result has no known result kind');
  if (B3_APPROVAL_VIEW_VARIANTS.includes(value.kind as B3ApprovalViewVariant)) {
    if (value.kind === 'READY') {
      assertClosedRecord(
        value,
        ['kind', 'approvalId', 'digest', 'preview', 'pendingTargetSelectors', 'challenge'],
        'a ready approval result',
      );
      if (typeof value.approvalId !== 'string' || typeof value.digest !== 'string' || !isJsonValue(value.preview))
        throw new TypeError('a ready approval result needs identifiers');
      if (!Array.isArray(value.pendingTargetSelectors))
        throw new TypeError('a ready approval result needs pending target selectors');
      for (const selector of value.pendingTargetSelectors)
        assertPendingTargetSelector(selector, 'a ready approval pending target selector');
      assertClosedRecord(value.challenge, ['approvalId', 'digest', 'challenge', 'expiresAt'], 'an approval challenge');
      if (
        typeof value.challenge.approvalId !== 'string' ||
        typeof value.challenge.digest !== 'string' ||
        typeof value.challenge.challenge !== 'string' ||
        typeof value.challenge.expiresAt !== 'number'
      )
        throw new TypeError('an approval challenge is malformed');
      return;
    }
    assertClosedRecord(value, ['kind'], 'an approval result');
    return;
  }
  if (value.kind === 'held-list') {
    assertClosedRecord(value, ['kind', 'decisions'], 'a held-list result');
    if (!Array.isArray(value.decisions) || value.decisions.length !== 0)
      throw new TypeError('a pre-E held-list result must be empty');
    return;
  }
  if (value.kind !== 'unavailable') throw new TypeError('a B3 control result has an unknown kind');
  if (value.code === 'HOLDS_UNAVAILABLE' && value.phase === 'E') {
    assertClosedRecord(value, ['kind', 'code', 'phase'], 'a holds unavailable result');
    return;
  }
  if (value.code === 'APP_SECRET_CAPABILITY_UNAVAILABLE') {
    assertClosedRecord(value, ['kind', 'code'], 'a secret capability unavailable result');
    return;
  }
  if (B3_JUDGE_UNAVAILABLE_VARIANTS.some((variant) => variant.code === value.code && variant.phase === value.phase)) {
    assertClosedRecord(value, ['kind', 'code', 'phase'], 'a judge unavailable result');
    return;
  }
  throw new TypeError('an unavailable result has an unknown code or phase');
}

function assertB3ControlErrorV1(value: unknown): asserts value is B3ControlErrorV1 {
  assertClosedRecord(value, ['code'], 'a B3 control error');
  if (typeof value.code !== 'string' || !B3_CONTROL_ERROR_CODES.includes(value.code as B3ControlErrorCodeV1))
    throw new TypeError('a B3 control error has an unknown code');
}

function assertB3ControlResultForOperationV1(
  operation: B3DesktopControlOperation,
  value: unknown,
): asserts value is B3ControlResultV1 {
  if (operation in B3_ORDINARY_RESULT_FIELDS || B3_ORDINARY_RESULT_ARRAY_OPERATIONS.has(operation)) {
    assertB3OrdinaryControlResultV1(operation, value);
    return;
  }
  assertB3ControlResultV1(value);
  // Keep the operation association on the raw record so TypeScript does not erase variants whose `kind`
  // discriminator overlaps with another member.
  if (!isRecord(value)) throw new TypeError('a B3 control result must be an object');
  const result = value as Readonly<Record<string, unknown>>;
  switch (operation) {
    case 'approvalView':
      if (B3_APPROVAL_VIEW_VARIANTS.includes(result.kind as B3ApprovalViewVariant)) return;
      break;
    case 'doctor':
      if (result.schemaVersion === 'doctor-v1') return;
      break;
    case 'heldList':
      if (result.kind === 'held-list') return;
      break;
    case 'decideHeld':
      if (result.kind === 'unavailable' && result.code === 'HOLDS_UNAVAILABLE' && result.phase === 'E') return;
      break;
    case 'judgesList':
    case 'addJudge':
    case 'updateJudge':
    case 'removeJudge':
    case 'judgeTest':
    case 'budgetShow':
    case 'updateBudget':
    case 'judgeKindsList':
      if (result.kind === 'unavailable' && result.code === 'E_REQUIRED' && result.phase === 'E') return;
      break;
    case 'enableJudgeKind':
    case 'disableJudgeKind':
      if (
        result.kind === 'unavailable' &&
        B3_JUDGE_UNAVAILABLE_VARIANTS.some((variant) => variant.code === result.code && variant.phase === result.phase)
      )
        return;
      break;
    case 'judgeModelStatus':
    case 'removeJudgeModel':
      if (result.kind === 'unavailable' && result.code === 'E2_REQUIRED' && result.phase === 'E2') return;
      break;
    case 'targetSecretCreate':
    case 'targetSecretRotate':
    case 'targetUrlSet':
    case 'subscriberTokenCreate':
    case 'subscriberTokenRotate':
    case 'subscriberSecretCreate':
    case 'subscriberSecretRotate':
    case 'subscriberUrlSet':
    case 'judgeKeySet':
    case 'judgeKeyRotate':
    case 'migrateSecrets':
      if (result.kind === 'unavailable' && result.code === 'APP_SECRET_CAPABILITY_UNAVAILABLE') return;
      break;
    default:
      break;
  }
  throw new TypeError(`a ${operation} vector has a result from another operation`);
}

/** A successful vector cannot advertise a document the daemon itself would refuse at its owner boundary. */
function assertSuccessfulB3RequestDocument(
  operation: B3DesktopControlOperation,
  args: Readonly<Record<string, unknown>>,
): void {
  switch (operation) {
    case 'rule-create':
    case 'rule-update':
    case 'ruleTest':
      canonicalFullRuleDocument(args.document);
      return;
    case 'target-add':
    case 'target-update':
      canonicalTarget(args.document);
      return;
    case 'targetUrlSet':
      if (args.inertDraft !== undefined) canonicalTarget(args.inertDraft);
      return;
    case 'addSubscriber':
    case 'updateSubscriber':
      canonicalSubscriber(args.document);
      return;
    case 'addJudge':
    case 'updateJudge':
      canonicalJudge(args.document);
      return;
  }
}

/**
 * Runtime companion to the exported TypeScript vector union. It is intentionally narrow: vectors name no secret
 * value, and an ordinary target test cannot carry the pending-activation selector.
 */
export function assertB3ControlContractVectorV1(value: unknown): asserts value is B3ControlContractVectorV1 {
  if (!isRecord(value) || typeof value.name !== 'string' || !isRecord(value.request))
    throw new TypeError('a B3 control v1 vector needs a name and request');
  const request = value.request;
  if (request.surface === 'terminal-approval' || request.surface === 'app-approval-screen') {
    if (request.operation !== 'targetTest')
      throw new TypeError('a pending target vector is only valid in an approval flow');
    assertPendingTargetSelector(request.selector, 'a pending target vector selector');
    return;
  }
  if (
    typeof request.operation !== 'string' ||
    !isB3DesktopControlOperation(request.operation) ||
    !isRecord(request.args)
  )
    throw new TypeError('a B3 control v1 vector needs a desktop-callable operation and object arguments');
  const args = request.args;
  if (
    request.operation === 'targetTest' &&
    Object.keys(args).some((key) => key !== 'targetId' && key !== 'targetVersion')
  )
    throw new TypeError('an ordinary target test vector cannot carry a pending selector');
  if (
    isB3ControlOperation(request.operation) &&
    isB3SecretOperation(request.operation) &&
    ['hidden', 'secret', 'value', 'credential'].some((key) => key in args)
  )
    throw new TypeError('a B3 data contract vector cannot contain a secret value');
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  if (hasResult && hasError) throw new TypeError('a B3 control vector cannot carry both a result and an error');
  if (hasResult) {
    assertSuccessfulB3RequestDocument(request.operation, args);
    assertB3ControlResultForOperationV1(request.operation, value.result);
  }
  if (hasError) assertB3ControlErrorV1(value.error);
}

export interface B3ApprovalPreviewTerminalView {
  readonly kind: B3ApprovalViewVariant;
  readonly structured: Readonly<Record<string, unknown>>;
  readonly terminal: string;
}

/**
 * The terminal and desktop fixture boundary. This formats only daemon-authored identifiers and a canonical, neutralised
 * preview representation; it never consumes a secret operation or claims the approval. A B3 v3 rule preview naming a
 * Laya judge also carries D11's Laya limits, rendered after the preview.
 */
/**
 * What the terminal knows beside a view: each lane's binding, from the person's `lane list`. A preview of a rule that
 * sends to a bound lane names the window that will read it (review of 0.31.0). Never part of the v1 view itself, so no
 * MCP caller is told another window's folder through an approval view (routing B4).
 */
export interface B3ApprovalPreviewContext {
  readonly lanes?: readonly { readonly name: string; readonly binding: LaneBindingV1 | null }[] | undefined;
  /**
   * Whether a Linear key is kept now (second look of 0.33.0). False says the Linear targets' team and labels were not
   * checked against Linear when the rule was prepared; undefined says nothing.
   */
  readonly linearConnected?: boolean | undefined;
}

/** Every character a reader could take for a quote mark, other than the double quote JSON escapes itself. */
const QUOTE_LIKE =
  /['`\u00b4\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u2032\u2033\u2035\u2036\u00ab\u00bb\u2039\u203a\u301d\u301e\u301f\uff02\uff07]/gu;

/**
 * A rule author's string as one JSON string literal in double quotes: JSON escapes every `"`, backslash and control
 * character in it, and every other quote-like character is written as its `\uXXXX` escape, so nothing the author wrote
 * can end the literal, or look as if it did (review of 0.32.0, finding 5).
 */
function authorLiteral(text: string): string {
  return JSON.stringify(neutralise(text).text).replace(
    QUOTE_LIKE,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  );
}

const RULE_SUMMARY_PREFIX = 'In plain words (the rule author\'s own text is in "double quotes"): ';

/**
 * A rule's preview in plain words (0.32.0, owner feedback §3.4), above the canonical JSON, which stays: the JSON is what
 * is approved. Each rule-author part is one literal it cannot close, in place of the single quotes the sentence gives
 * it, so an operand or the judge's question cannot read on as the app's own words or start a line of its own.
 */
/** A subscription's words (W29), daemon-authored from the stored version and neutralised as every preview line is. */
function subscriptionLine(document: ActivationDocumentV1, subscription: unknown): readonly string[] {
  if (document.kind !== 'subscription') return [];
  if (!isRecord(subscription) || typeof subscription.words !== 'string')
    throw new TypeError("a subscription's approval preview names what it receives");
  const subscriber = canonicalSubscriber(subscription.subscriber);
  if (
    subscriber.subscriberId !== document.subscription.subscriberId ||
    subscriber.version !== document.subscription.version
  )
    throw new TypeError("a subscription's preview names its own subscriber version");
  return [`Subscription ${neutralise(subscription.words).text}`];
}

function ruleSummaryLine(document: ActivationDocumentV1): readonly string[] {
  if (document.kind !== 'rule') return [];
  const parts = describeRule(document.rule).map((part) => ({ ...part }));
  for (const [index, part] of parts.entries()) {
    if (part.kind !== 'untrusted') continue;
    const before = parts[index - 1];
    const after = parts[index + 1];
    if (before?.kind === 'plain' && before.text.endsWith("'")) before.text = before.text.slice(0, -1);
    if (after?.kind === 'plain' && after.text.startsWith("'")) after.text = after.text.slice(1);
  }
  const text = parts.map((part) => (part.kind === 'untrusted' ? authorLiteral(part.text) : part.text)).join('');
  return [`${RULE_SUMMARY_PREFIX}${neutralise(text).text}`];
}

/**
 * Where a rule's hosted judge sends the fields the rule names (owner decision 2026-10-26): to TypeSafe's Jev itself, or
 * to OpenRouter, which passes them on to TypeSafe's Jev. A local or Laya judge sends nothing off this machine.
 */
function hostedJudgeDestination(document: ActivationDocumentV1): readonly string[] {
  if (document.kind !== 'rule' || document.rule.agentic === undefined) return [];
  const judge = document.rule.agentic.judge;
  if (judge.kind !== JUDGE_KIND_TYPESAFE) return [];
  const named = `Judge ${judge.judgeId}@${judge.version}`;
  return [
    judge.provider === 'openrouter'
      ? `${named}: the fields it is given are sent to OpenRouter (openrouter.ai), which passes them to TypeSafe's Jev.`
      : `${named}: the fields it is given are sent to TypeSafe's Jev (api.typesafe.ai).`,
  ];
}

const SESSION_PROVIDER_WORDS: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' };
const SESSION_MODE_PREVIEW: Readonly<Record<string, string>> = {
  manual: 'the session asks before it acts',
  acceptEdits: 'the session may edit files without asking, and asks before anything else',
  plan: 'the session only plans, and changes nothing',
};

/** A context part as the preview names it, every rule-author string one literal it cannot close. */
function contextPartPreview(part: SessionTargetDocument['context'][number]): string {
  if ('text' in part) return `fixed text ${authorLiteral(part.text)}`;
  if ('fields' in part) return `the mapped fields ${part.fields.map(authorLiteral).join(', ')}`;
  if ('file' in part) return `the file ${authorLiteral(part.file)}, read when the match is passed on (at most 64 KB)`;
  if ('step' in part)
    return `what the workflow's step ${authorLiteral(part.step)} settled as its ${authorLiteral(part.field)}, from Agent Comms`;
  const route = ANALYSE_ROUTES[part.generate.provider];
  return `what ${authorLiteral(part.generate.model)} writes, asked ${authorLiteral(part.generate.instruction)} — it is sent the mapped fields ${part.generate.from
    .map(authorLiteral)
    .join(', ')} through ${route.name} (${route.host}), on your own key`;
}

/**
 * The agent-session disclosure (0.33.0 §3.5): plainly, that matches' mapped fields and the listed context go to a
 * coding-agent session in the named folder — or the session behind the window bound to a lane — which can act with the
 * named mode; whether one is started, what happens while it is busy, every context part, and its instruction.
 */
function sessionDisclosure(document: ActivationDocumentV1): readonly string[] {
  if (document.kind !== 'rule') return [];
  return document.rule.targets.flatMap((target) => {
    if (target.kind !== 'session') return [];
    const named = `Session ${target.targetId}@${target.version}`;
    const provider = SESSION_PROVIDER_WORDS[target.provider] ?? target.provider;
    const where =
      'folder' in target.find
        ? `a ${provider} session working in ${authorLiteral(target.find.folder)}`
        : 'lane' in target.find
          ? `the ${provider} session behind the agent window bound to lane ${target.find.lane}`
          : `the ${provider} session this workflow's steps found or started`;
    const lines = [
      `${named}: each match's mapped fields and the context below go to ${where}, a coding agent there, which may act: ${SESSION_MODE_PREVIEW[target.mode] ?? target.mode}.`,
      // Security review of 0.33.0: what the relay keeps is outside Agent Comms' retention, and the person is told so.
      `${named}: claude-stream keeps each prompt it is sent, the sender's words included, in its own journal, for as long as claude-stream keeps its journal; Agent Comms' retention does not reach it.`,
      target.ifNone === 'start'
        ? `${named}: if there is no such session, one is started with ${provider} in that folder.`
        : 'lane' in target.find
          ? `${named}: if the bound window is not a session claude-stream runs, the match is a lane item in lane ${target.find.lane}, as today.`
          : `${named}: if there is no such session, the match is left in the Queue.`,
      target.ifBusy === 'queue'
        ? `${named}: while the session is busy, the match waits for it, and goes when its run ends.`
        : `${named}: while the session is busy, the match is left in the Queue.`,
      ...target.context.map((part, index) => `${named}: context part ${index + 1}, ${contextPartPreview(part)}.`),
      ...(target.instruction === undefined ? [] : [`${named}: it is told last ${authorLiteral(target.instruction)}.`]),
    ];
    return lines.map((line) => neutralise(line).text);
  });
}

/**
 * What each Linear target of a rule does (0.33.0 design §3.4): the team, its labels and who it is assigned to, and which
 * mapped fields fill the title and the description. Every value is the approved document's, through `neutralise`.
 */
function linearTargetLines(document: ActivationDocumentV1, linearConnected?: boolean): readonly string[] {
  if (document.kind !== 'rule') return [];
  const lines = document.rule.targets.flatMap((target) =>
    target.kind === 'linear'
      ? [neutralise(linearTargetDisclosure(target)).text]
      : target.kind === 'linear-change'
        ? [neutralise(linearChangeTargetDisclosure(target)).text]
        : [],
  );
  // With no Linear key, activation could not ask Linear whether each team key and label name match their ids.
  if (lines.length > 0 && linearConnected === false)
    lines.push(
      'Linear is not connected, so these teams and labels were not checked against Linear: check the ids yourself, or connect Linear and enable the rule again.',
    );
  return lines;
}

/** "~/work/x (claude-code), since …": the bound window as a person recognises it. */
function boundWindowText(binding: LaneBindingV1): string {
  const folder = binding.window.folderShown ?? binding.window.folder ?? 'a window whose folder is not known';
  const client = binding.window.client === null ? '' : ` (${binding.window.client.name})`;
  return `${folder}${client}, since ${binding.since}`;
}

export function renderB3ApprovalPreviewV1(
  value: unknown,
  context: B3ApprovalPreviewContext = {},
): B3ApprovalPreviewTerminalView {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    !B3_APPROVAL_VIEW_VARIANTS.includes(value.kind as B3ApprovalViewVariant)
  )
    throw new TypeError('an approval preview has an unknown B3 v1 variant');
  if (value.kind !== 'READY')
    return {
      kind: value.kind as Exclude<B3ApprovalViewVariant, 'READY'>,
      structured: {},
      terminal: `Approval view: ${value.kind}`,
    };
  if (
    typeof value.approvalId !== 'string' ||
    typeof value.digest !== 'string' ||
    !isRecord(value.challenge) ||
    typeof value.challenge.approvalId !== 'string' ||
    typeof value.challenge.digest !== 'string' ||
    typeof value.challenge.challenge !== 'string' ||
    typeof value.challenge.expiresAt !== 'number'
  )
    throw new TypeError('a ready approval preview is malformed');
  const document = normaliseActivationDocument(value.preview as ActivationDocumentV1);
  const laya = Object.hasOwn(value, 'layaJudge') ? renderLayaJudgePreviewV3(value.layaJudge) : [];
  // Routing B2: a lane's reading is part of the approved target, so the preview says who may read it.
  const lanes =
    document.kind === 'rule'
      ? [
          ...new Set(
            document.rule.targets.flatMap((target) => {
              const lane = targetLane(target);
              return lane === undefined ? [] : [lane];
            }),
          ),
        ].map((name) => {
          const binding = context.lanes?.find((lane) => lane.name === name)?.binding ?? null;
          return binding === null
            ? `Items in lane ${name} can be read by the agent window you bind to it.`
            : `Items in lane ${name} will be read by the window bound to it: ${boundWindowText(binding)}.`;
        })
      : [];
  const structured = {
    approvalId: value.approvalId,
    digest: value.digest,
    preview: value.preview,
    challenge: {
      approvalId: value.challenge.approvalId,
      digest: value.challenge.digest,
      challenge: value.challenge.challenge,
      expiresAt: value.challenge.expiresAt,
    },
    ...(Object.hasOwn(value, 'layaJudge') ? { layaJudge: value.layaJudge } : {}),
    ...(Object.hasOwn(value, 'subscription') ? { subscription: value.subscription } : {}),
  };
  return {
    kind: 'READY',
    structured,
    terminal: [
      `Approval ${value.approvalId}`,
      `Digest ${value.digest}`,
      ...ruleSummaryLine(document),
      ...subscriptionLine(document, value.subscription),
      `Preview ${neutralise(canonicalJson(value.preview)).text}`,
      ...hostedJudgeDestination(document),
      ...sessionDisclosure(document),
      ...linearTargetLines(document, context.linearConnected),
      ...lanes,
      ...laya,
      `Challenge ${value.challenge.challenge}`,
      `Expires ${new Date(value.challenge.expiresAt).toISOString()}`,
    ].join('\n'),
  };
}

export interface B3ControlContract {
  readonly version: 'b3-control-v1';
  readonly capabilities: readonly B3CapabilityContract[];
  readonly approvalView: readonly B3ApprovalViewVariant[];
  readonly judgeUnavailable: readonly B3JudgeUnavailable[];
}

export interface B3OwnerRequest {
  readonly operation: B3ControlOperation;
  readonly args: Readonly<Record<string, unknown>>;
  /** Captured from the authenticated control hello; request arguments cannot choose it. */
  readonly origin?: string | undefined;
}

export interface B3OwnerService {
  handle(request: B3OwnerRequest): Promise<unknown>;
}

export interface B3CliRegistrar {
  readonly owner: B3OwnerService;
}

export interface B3McpRegistrar {
  readonly owner: B3OwnerService;
}

/** No desktop, secret value, network client or judge implementation crosses this boundary. */
export const B3_CONTROL_CONTRACT: B3ControlContract = Object.freeze({
  version: B3_CONTROL_V1_SCHEMA_VERSION,
  capabilities: B3_CAPABILITIES,
  approvalView: B3_APPROVAL_VIEW_VARIANTS,
  judgeUnavailable: B3_JUDGE_UNAVAILABLE_VARIANTS,
});
