/**
 * The data-only promise B3 makes before any public B3 registration exists. Task 5 consumes these rows when it wires
 * Commander and MCP; Task 9 adds the language-neutral schema and vectors without changing their vocabulary.
 */
export const B3_EXCEPTION_REASON_SECRET =
  'secret material must never enter model input or output; the person completes this operation at the terminal or app.';

export interface B3CapabilityContract {
  readonly id: `events-daemon.${string}`;
  readonly cli: string;
  readonly mcp: string | null;
  readonly operation: string;
  readonly status: 'both' | 'exception';
  readonly reason?: string | undefined;
  readonly secret?: true | undefined;
}

/** Closed by the B3-2 capability contract; registrar/owner seams cannot invent a second control name. */
export type B3ControlOperation =
  | 'addJudge'
  | 'addSubscriber'
  | 'approvalView'
  | 'budgetShow'
  | 'decideHeld'
  | 'deliveriesList'
  | 'disableJudgeKind'
  | 'dropDelivery'
  | 'enableJudgeKind'
  | 'heldList'
  | 'judgeKeyRotate'
  | 'judgeKeySet'
  | 'judgeKindsList'
  | 'judgeModelStatus'
  | 'judgeTest'
  | 'judgesList'
  | 'migrateSecrets'
  | 'removeJudge'
  | 'removeJudgeModel'
  | 'removeSubscriber'
  | 'retryDelivery'
  | 'ruleTest'
  | 'ruleTestRetained'
  | 'subscribersList'
  | 'subscriberTokenCreate'
  | 'subscriberTokenRotate'
  | 'targetResume'
  | 'targetSecretCreate'
  | 'targetSecretRotate'
  | 'targetTest'
  | 'targetUrlSet'
  | 'updateBudget'
  | 'updateJudge'
  | 'updateSubscriber';

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

const B3_CONTROL_OPERATIONS: ReadonlySet<B3ControlOperation> = new Set(
  B3_CAPABILITIES.map(({ operation }) => operation as B3ControlOperation),
);

/** The owner accepts only the B3 operation vocabulary that its future CLI/MCP registrars may expose. */
export function isB3ControlOperation(value: string): value is B3ControlOperation {
  return B3_CONTROL_OPERATIONS.has(value as B3ControlOperation);
}

export type B3ApprovalViewVariant = 'READY' | 'STALE_APPROVAL' | 'DIGEST_MISMATCH' | 'CHALLENGE_EXPIRED';

export const B3_APPROVAL_VIEW_VARIANTS: readonly B3ApprovalViewVariant[] = Object.freeze([
  'READY',
  'STALE_APPROVAL',
  'DIGEST_MISMATCH',
  'CHALLENGE_EXPIRED',
] as const);

export interface B3JudgeUnavailable {
  readonly code: 'E_REQUIRED' | 'E2_REQUIRED';
  readonly phase: 'E' | 'E2';
}

export const B3_JUDGE_UNAVAILABLE_VARIANTS: readonly B3JudgeUnavailable[] = Object.freeze([
  { code: 'E_REQUIRED', phase: 'E' },
  { code: 'E2_REQUIRED', phase: 'E2' },
] as const);

export interface B3ControlContract {
  readonly version: 'b3-control-v1';
  readonly capabilities: readonly B3CapabilityContract[];
  readonly approvalView: readonly B3ApprovalViewVariant[];
  readonly judgeUnavailable: readonly B3JudgeUnavailable[];
}

export interface B3OwnerRequest {
  readonly operation: B3ControlOperation;
  readonly args: Readonly<Record<string, unknown>>;
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
  version: 'b3-control-v1',
  capabilities: B3_CAPABILITIES,
  approvalView: B3_APPROVAL_VIEW_VARIANTS,
  judgeUnavailable: B3_JUDGE_UNAVAILABLE_VARIANTS,
});
