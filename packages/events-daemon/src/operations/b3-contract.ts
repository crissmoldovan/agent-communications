import {
  canonicalDisclosureBinding,
  canonicalJson,
  type DisclosureActivationKind,
  type DisclosureBinding,
  type DisclosureVersionKind,
  neutralise,
} from '@agentcomms/core';
import { isJsonValue, type JsonValue } from '@agentcomms/events';
import {
  type ActivationDocumentV1,
  type CanonicalFullRuleDocument,
  canonicalFullRuleDocument,
  canonicalJudge,
  canonicalSubscriber,
  canonicalTarget,
  type JudgeBudgetDocument,
  normaliseActivationDocument,
  type SubscriberDocument,
  type TargetDocument,
} from '../domain/activation-documents.ts';
import { ACTIVATION_FAILURE_CODES, type ActivationFailureCode } from '../domain/activation-failure-codes.ts';
import type { CanonicalJudgeDocument } from '../domain/judges.ts';
import {
  type B3ControlWireOperation,
  type DesktopControlWireOperation,
  isB3ControlWireOperation,
  OWNER_CONTROL_WIRE_OPERATIONS,
} from '../runtime/control-operation-registry.ts';
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
  both('events-daemon.rule.test', 'rule test <document> <catalogue-example>', 'events_rule_test', 'ruleTest'),
  exception(
    'events-daemon.rule.test-retained',
    'rule test-retained <event-id> --rule <rule-id> --version <n>',
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
export const B3_INTENT_KINDS: readonly ['rule', 'judge-budget', 'judge-kind', 'enable-all'] = Object.freeze([
  'rule',
  'judge-budget',
  'judge-kind',
  'enable-all',
] as const);
export type B3IntentKind = (typeof B3_INTENT_KINDS)[number];

/** The core disclosure grammar is the binding authority; B3 only publishes its exact closed vocabulary. */
export const B3_DISCLOSURE_ACTIVATION_KINDS: readonly ['rule', 'judge-budget', 'judge-kind', 'enable-all'] =
  Object.freeze([
    'rule',
    'judge-budget',
    'judge-kind',
    'enable-all',
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
  readonly 'rule-create': B3VersionResultV1<'rule', CanonicalFullRuleDocument>;
  readonly 'rule-update': B3VersionResultV1<'rule', CanonicalFullRuleDocument>;
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

function assertB3PreparedActivation(value: Record<string, unknown>, operation: 'enable-all' | 'rule-enable'): void {
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

function assertB3OrdinaryControlResultV1(operation: B3DesktopControlOperation, value: unknown): void {
  if (B3_ORDINARY_RESULT_ARRAY_OPERATIONS.has(operation)) {
    if (Array.isArray(value) && value.every(isJsonValue)) return;
    throw new TypeError(`a ${operation} result must be a JSON array`);
  }
  const fields = B3_ORDINARY_RESULT_FIELDS[operation];
  if (fields === undefined) throw new TypeError(`a ${operation} result has no ordinary result grammar`);
  if (operation === 'enable-all' || operation === 'rule-enable') {
    if (!isRecord(value)) throw new TypeError(`a ${operation} result must be a closed object`);
    assertB3PreparedActivation(value, operation);
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
export function renderB3ApprovalPreviewV1(value: unknown): B3ApprovalPreviewTerminalView {
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
  normaliseActivationDocument(value.preview as ActivationDocumentV1);
  const laya = Object.hasOwn(value, 'layaJudge') ? renderLayaJudgePreviewV3(value.layaJudge) : [];
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
  };
  return {
    kind: 'READY',
    structured,
    terminal: [
      `Approval ${value.approvalId}`,
      `Digest ${value.digest}`,
      `Preview ${neutralise(canonicalJson(value.preview)).text}`,
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
