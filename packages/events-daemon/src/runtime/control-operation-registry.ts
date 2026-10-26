/**
 * The owner control protocol's complete wire vocabulary. Capability rows deliberately name operation *functions*,
 * while authenticated control frames name these wires. The owner dispatcher, contract schema and vectors consume this
 * one registry instead of recreating either vocabulary at a protocol boundary.
 */
export const OWNER_CONTROL_WIRE_OPERATIONS = [
  { capabilityOperation: 'status', wireOperation: 'status', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'stop', wireOperation: 'stop', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'pause', wireOperation: 'pause', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'resume', wireOperation: 'resume', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'disableAll', wireOperation: 'disable-all', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'enableAll', wireOperation: 'enable-all', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'doctor', wireOperation: 'doctor', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'catalogueList', wireOperation: 'catalogue-list', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'catalogueShow', wireOperation: 'catalogue-show', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'sourcesList', wireOperation: 'sources-list', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'sourceShow', wireOperation: 'source-show', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'rulesList', wireOperation: 'rules-list', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'ruleShow', wireOperation: 'rule-show', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'createRule', wireOperation: 'rule-create', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'updateRule', wireOperation: 'rule-update', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'enableRule', wireOperation: 'rule-enable', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'disableRule', wireOperation: 'rule-disable', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'removeRule', wireOperation: 'rule-remove', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'targetsList', wireOperation: 'targets-list', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'addTarget', wireOperation: 'target-add', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'updateTarget', wireOperation: 'target-update', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'removeTarget', wireOperation: 'target-remove', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'approve', wireOperation: 'approve', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'approvalView', wireOperation: 'approvalView', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'ruleTest', wireOperation: 'ruleTest', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'ruleTestRetained', wireOperation: 'ruleTestRetained', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'targetTest', wireOperation: 'targetTest', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'targetResume', wireOperation: 'targetResume', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'subscribersList', wireOperation: 'subscribersList', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'addSubscriber', wireOperation: 'addSubscriber', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'updateSubscriber', wireOperation: 'updateSubscriber', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'removeSubscriber', wireOperation: 'removeSubscriber', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'judgesList', wireOperation: 'judgesList', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'addJudge', wireOperation: 'addJudge', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'updateJudge', wireOperation: 'updateJudge', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'removeJudge', wireOperation: 'removeJudge', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'judgeTest', wireOperation: 'judgeTest', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'budgetShow', wireOperation: 'budgetShow', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'updateBudget', wireOperation: 'updateBudget', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'judgeKindsList', wireOperation: 'judgeKindsList', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'enableJudgeKind', wireOperation: 'enableJudgeKind', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'disableJudgeKind', wireOperation: 'disableJudgeKind', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'judgeModelStatus', wireOperation: 'judgeModelStatus', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'removeJudgeModel', wireOperation: 'removeJudgeModel', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'deliveriesList', wireOperation: 'deliveriesList', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'retryDelivery', wireOperation: 'retryDelivery', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'dropDelivery', wireOperation: 'dropDelivery', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'heldList', wireOperation: 'heldList', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'decideHeld', wireOperation: 'decideHeld', desktopCallable: true, family: 'b3' },
  {
    capabilityOperation: 'targetSecretCreate',
    wireOperation: 'targetSecretCreate',
    desktopCallable: true,
    family: 'b3',
  },
  {
    capabilityOperation: 'targetSecretRotate',
    wireOperation: 'targetSecretRotate',
    desktopCallable: true,
    family: 'b3',
  },
  { capabilityOperation: 'targetUrlSet', wireOperation: 'targetUrlSet', desktopCallable: true, family: 'b3' },
  {
    capabilityOperation: 'subscriberTokenCreate',
    wireOperation: 'subscriberTokenCreate',
    desktopCallable: true,
    family: 'b3',
  },
  {
    capabilityOperation: 'subscriberTokenRotate',
    wireOperation: 'subscriberTokenRotate',
    desktopCallable: true,
    family: 'b3',
  },
  { capabilityOperation: 'judgeKeySet', wireOperation: 'judgeKeySet', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'judgeKeyRotate', wireOperation: 'judgeKeyRotate', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'migrateSecrets', wireOperation: 'migrateSecrets', desktopCallable: true, family: 'b3' },
  { capabilityOperation: 'dryrunList', wireOperation: 'dryrun-list', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'dryrunShow', wireOperation: 'dryrun-show', desktopCallable: true, family: 'owner' },
  // The action queue (0.30.0). list and show carry item content and are CLI-only; the rest are content-free.
  { capabilityOperation: 'queueList', wireOperation: 'queue-list', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'queueShow', wireOperation: 'queue-show', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'queueItems', wireOperation: 'queue-items', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'queueCounts', wireOperation: 'queue-counts', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'queueDone', wireOperation: 'queue-done', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'queueDismiss', wireOperation: 'queue-dismiss', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'queueReopen', wireOperation: 'queue-reopen', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'queueClear', wireOperation: 'queue-clear', desktopCallable: true, family: 'owner' },
  // Routing's lanes (0.31.0). The person's three — list, bind and unbind — are the app's and the CLI's; the rest are an
  // agent window's own, reached only through the event service's MCP server, and so not desktop calls.
  { capabilityOperation: 'laneList', wireOperation: 'lane-list', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'laneBind', wireOperation: 'lane-bind', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'laneUnbind', wireOperation: 'lane-unbind', desktopCallable: true, family: 'owner' },
  { capabilityOperation: 'laneWhoami', wireOperation: 'lane-whoami', desktopCallable: false, family: 'owner' },
  { capabilityOperation: 'laneWatch', wireOperation: 'lane-watch', desktopCallable: false, family: 'owner' },
  { capabilityOperation: 'laneTaskGet', wireOperation: 'lane-task-get', desktopCallable: false, family: 'owner' },
  {
    capabilityOperation: 'laneTaskCancel',
    wireOperation: 'lane-task-cancel',
    desktopCallable: false,
    family: 'owner',
  },
  { capabilityOperation: 'laneWait', wireOperation: 'lane-wait', desktopCallable: false, family: 'owner' },
  { capabilityOperation: 'laneItem', wireOperation: 'lane-item', desktopCallable: false, family: 'owner' },
  {
    capabilityOperation: 'approveChallenge',
    wireOperation: 'approve-challenge',
    desktopCallable: false,
    family: 'owner',
  },
] as const;

export type OwnerControlWireOperation = (typeof OWNER_CONTROL_WIRE_OPERATIONS)[number]['wireOperation'];
type OwnerControlCapabilityOperation = Exclude<
  (typeof OWNER_CONTROL_WIRE_OPERATIONS)[number]['capabilityOperation'],
  undefined
>;
export type DesktopControlWireOperation = Extract<
  (typeof OWNER_CONTROL_WIRE_OPERATIONS)[number],
  { readonly desktopCallable: true }
>['wireOperation'];
export type B3ControlWireOperation = Extract<
  (typeof OWNER_CONTROL_WIRE_OPERATIONS)[number],
  { readonly family: 'b3' }
>['wireOperation'];

/** The owner switch reads its case labels from the registry above; it introduces no second wire vocabulary. */
export const OWNER_CONTROL_WIRES: Readonly<Record<OwnerControlCapabilityOperation, OwnerControlWireOperation>> =
  Object.freeze(
    Object.fromEntries(
      OWNER_CONTROL_WIRE_OPERATIONS.flatMap(({ capabilityOperation, wireOperation }) =>
        capabilityOperation === undefined ? [] : [[capabilityOperation, wireOperation]],
      ),
    ) as Record<OwnerControlCapabilityOperation, OwnerControlWireOperation>,
  );

const OWNER_CONTROL_WIRE_OPERATION_SET: ReadonlySet<OwnerControlWireOperation> = new Set(
  OWNER_CONTROL_WIRE_OPERATIONS.map(({ wireOperation }) => wireOperation),
);
const B3_CONTROL_WIRE_OPERATION_SET: ReadonlySet<B3ControlWireOperation> = new Set(
  OWNER_CONTROL_WIRE_OPERATIONS.filter((entry) => entry.family === 'b3').map(
    ({ wireOperation }) => wireOperation as B3ControlWireOperation,
  ),
);

export function isOwnerControlWireOperation(value: string): value is OwnerControlWireOperation {
  return OWNER_CONTROL_WIRE_OPERATION_SET.has(value as OwnerControlWireOperation);
}

export function isB3ControlWireOperation(value: string): value is B3ControlWireOperation {
  return B3_CONTROL_WIRE_OPERATION_SET.has(value as B3ControlWireOperation);
}
