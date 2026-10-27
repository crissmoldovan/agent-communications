import { canonicalJudge, JUDGE_KIND_DEFINITIONS } from '../domain/judges.ts';
import { JUDGE_KIND_LAYA, JUDGE_KIND_LOCAL_ENDPOINT, JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';
import {
  B3_CAPABILITIES,
  B3_CONTROL_CONTRACT,
  B3_CONTROL_V1_OPERATION_SPECS,
  B3_CONTROL_V1_SCHEMA_VERSION,
  B3_JUDGE_UNAVAILABLE_VARIANTS,
} from '../operations/b3-contract.ts';

/** The E-owned prerequisite contract is intentionally unregistered and has no owner or operation dependency. */
export const PHASE_E_PREREQUISITE_VERSION = 1;

interface PhaseEB3CapabilityInventoryRow {
  readonly id: string;
  readonly cli: string;
  readonly mcp: string | null;
  readonly operation: string;
  readonly status: 'both' | 'exception';
  readonly reason: string | null;
  readonly secret: boolean;
}

const SECRET_REASON =
  'secret material must never enter model input or output; the person completes this operation at the terminal or app.';

/** E's independent, exact B3 capability prerequisite; B3 cannot weaken this list by deleting its own row. */
export const PHASE_E_B3_CAPABILITY_INVENTORY: readonly PhaseEB3CapabilityInventoryRow[] = Object.freeze([
  {
    id: 'events-daemon.approval.view',
    cli: 'approval view <approval-id> --digest <digest>',
    mcp: 'events_approval_view',
    operation: 'approvalView',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.rule.test',
    cli: 'workflow test <document> <catalogue-example>',
    mcp: 'events_rule_test',
    operation: 'ruleTest',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.rule.test-retained',
    cli: 'workflow test-retained <event-id> --workflow <workflow-id> --version <n>',
    mcp: null,
    operation: 'ruleTestRetained',
    status: 'exception',
    reason: 'Retained sender content may be selected only by a person outside model context.',
    secret: false,
  },
  {
    id: 'events-daemon.target.test',
    cli: 'target test <target-id> --version <n>',
    mcp: 'events_target_test',
    operation: 'targetTest',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.target.resume',
    cli: 'target resume <target-id> --version <n>',
    mcp: null,
    operation: 'targetResume',
    status: 'exception',
    reason: 'A person, not model context, decides to reopen a degraded target reset barrier.',
    secret: false,
  },
  {
    id: 'events-daemon.subscribers.list',
    cli: 'subscribers list',
    mcp: 'events_subscribers_list',
    operation: 'subscribersList',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.subscriber.add',
    cli: 'subscriber add <document>',
    mcp: 'events_subscriber_add',
    operation: 'addSubscriber',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.subscriber.update',
    cli: 'subscriber update <document>',
    mcp: 'events_subscriber_update',
    operation: 'updateSubscriber',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.subscriber.remove',
    cli: 'subscriber remove <subscriber-id>',
    mcp: 'events_subscriber_remove',
    operation: 'removeSubscriber',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judges.list',
    cli: 'judges list',
    mcp: 'events_judges_list',
    operation: 'judgesList',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge.add',
    cli: 'judge add <document>',
    mcp: 'events_judge_add',
    operation: 'addJudge',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge.update',
    cli: 'judge update <document>',
    mcp: 'events_judge_update',
    operation: 'updateJudge',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge.remove',
    cli: 'judge remove <judge-id>',
    mcp: 'events_judge_remove',
    operation: 'removeJudge',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge.test',
    cli: 'judge test <judge-id> --version <n>',
    mcp: 'events_judge_test',
    operation: 'judgeTest',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.budget.show',
    cli: 'budget show',
    mcp: 'events_budget_show',
    operation: 'budgetShow',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.budget.update',
    cli: 'budget update <document>',
    mcp: 'events_budget_update',
    operation: 'updateBudget',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge-kinds.list',
    cli: 'judge kinds list',
    mcp: 'events_judge_kinds_list',
    operation: 'judgeKindsList',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge-kind.enable',
    cli: 'judge kind enable <kind>',
    mcp: 'events_judge_kind_enable',
    operation: 'enableJudgeKind',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge-kind.disable',
    cli: 'judge kind disable <kind>',
    mcp: 'events_judge_kind_disable',
    operation: 'disableJudgeKind',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge-model.status',
    cli: 'judge model status',
    mcp: 'events_judge_model_status',
    operation: 'judgeModelStatus',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.judge-model.remove',
    cli: 'judge model remove',
    mcp: 'events_judge_model_remove',
    operation: 'removeJudgeModel',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.deliveries.list',
    cli: 'deliveries list',
    mcp: 'events_deliveries_list',
    operation: 'deliveriesList',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.delivery.retry',
    cli: 'delivery retry <delivery-id>',
    mcp: 'events_delivery_retry',
    operation: 'retryDelivery',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.delivery.drop',
    cli: 'delivery drop <delivery-id>',
    mcp: 'events_delivery_drop',
    operation: 'dropDelivery',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.held.list',
    cli: 'held list',
    mcp: 'events_held_list',
    operation: 'heldList',
    status: 'both',
    reason: null,
    secret: false,
  },
  {
    id: 'events-daemon.held.decide',
    cli: 'held decide <decision-id> <accept|reject>',
    mcp: null,
    operation: 'decideHeld',
    status: 'exception',
    reason: 'A held model decision can be resolved only by a person at terminal/app, never by model context.',
    secret: false,
  },
  {
    id: 'events-daemon.target-secret.create',
    cli: 'target secret create <target-id> --version <n>',
    mcp: null,
    operation: 'targetSecretCreate',
    status: 'exception',
    reason: SECRET_REASON,
    secret: true,
  },
  {
    id: 'events-daemon.target-secret.rotate',
    cli: 'target secret rotate <target-id> --version <n>',
    mcp: null,
    operation: 'targetSecretRotate',
    status: 'exception',
    reason: SECRET_REASON,
    secret: true,
  },
  {
    id: 'events-daemon.target-url.set',
    cli: 'target url set <target-id> (--predecessor-version <n> | --draft <inert-target-document>) --new-version <n>',
    mcp: null,
    operation: 'targetUrlSet',
    status: 'exception',
    reason: SECRET_REASON,
    secret: true,
  },
  {
    id: 'events-daemon.subscriber-token.create',
    cli: 'subscriber token create <subscriber-id> --version <n>',
    mcp: null,
    operation: 'subscriberTokenCreate',
    status: 'exception',
    reason: SECRET_REASON,
    secret: true,
  },
  {
    id: 'events-daemon.subscriber-token.rotate',
    cli: 'subscriber token rotate <subscriber-id> --version <n>',
    mcp: null,
    operation: 'subscriberTokenRotate',
    status: 'exception',
    reason: SECRET_REASON,
    secret: true,
  },
  {
    id: 'events-daemon.judge-key.set',
    cli: 'judge key set <judge-id> --version <n>',
    mcp: null,
    operation: 'judgeKeySet',
    status: 'exception',
    reason: SECRET_REASON,
    secret: true,
  },
  {
    id: 'events-daemon.judge-key.rotate',
    cli: 'judge key rotate <judge-id> --version <n>',
    mcp: null,
    operation: 'judgeKeyRotate',
    status: 'exception',
    reason: SECRET_REASON,
    secret: true,
  },
  {
    id: 'events-daemon.secrets.migrate',
    cli: 'secrets migrate --to keychain|file',
    mcp: null,
    operation: 'migrateSecrets',
    status: 'exception',
    reason: SECRET_REASON,
    secret: true,
  },
]);

function required(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Phase E prerequisite failed: ${message}`);
}

const VALID_JUDGES = [
  {
    judgeId: 'phase-e-prerequisite-typesafe',
    version: 1,
    kind: JUDGE_KIND_TYPESAFE,
    provider: JUDGE_KIND_TYPESAFE,
    model: 'jev-1.13.0',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    promptTemplate: 'typesafe-jev-noul-v1',
    protocol: 'noul',
  },
  {
    judgeId: 'phase-e-prerequisite-local',
    version: 1,
    kind: JUDGE_KIND_LOCAL_ENDPOINT,
    provider: 'synthetic-local',
    model: 'noul',
    endpoint: 'http://127.0.0.1:11434/v1/decide',
    approvedAddressSet: ['127.0.0.1'],
    promptTemplate: 'local-noul-v1',
    protocol: 'noul',
  },
] as const;
const INVALID_JUDGES: readonly unknown[] = [
  { ...VALID_JUDGES[0], protocol: 'json-score', scorePointer: '/score' },
  { ...VALID_JUDGES[1], approvedAddressSet: ['203.0.113.1'] },
  { ...VALID_JUDGES[0], kind: JUDGE_KIND_LAYA },
];
function requireCanonicalJudgeRefusal(value: unknown): void {
  try {
    canonicalJudge(value);
  } catch {
    return;
  }
  throw new Error('Phase E prerequisite failed: canonical judge parser accepts an invalid document');
}

/**
 * Loads both Phase E's actual canonical authority code and B3's data-only contract before any E owner or operation
 * can be registered.  The repository verifier also checks B3's checked-in schema and consumer vectors.
 */
export function assertPhaseEPrerequisites(): void {
  required(B3_CONTROL_V1_SCHEMA_VERSION === 'b3-control-v1', 'B3 control contract version');
  required(B3_CONTROL_CONTRACT.version === B3_CONTROL_V1_SCHEMA_VERSION, 'B3 control contract constant');
  required(
    B3_CONTROL_V1_OPERATION_SPECS.every((spec) => spec.desktopCallable === true),
    'B3 operation specification constants',
  );
  required(
    B3_JUDGE_UNAVAILABLE_VARIANTS.some((variant) => variant.code === 'E_REQUIRED' && variant.phase === 'E'),
    'B3 pre-E unavailable result',
  );
  required(
    B3_JUDGE_UNAVAILABLE_VARIANTS.some((variant) => variant.code === 'E2_REQUIRED' && variant.phase === 'E2'),
    'B3 pre-E2 unavailable result',
  );
  required(
    JSON.stringify(
      B3_CAPABILITIES.map((entry) => ({
        id: entry.id,
        cli: entry.cli,
        mcp: entry.mcp,
        operation: entry.operation,
        status: entry.status,
        reason: entry.reason ?? null,
        secret: entry.secret === true,
      })),
    ) === JSON.stringify(PHASE_E_B3_CAPABILITY_INVENTORY),
    'exact B3 capability inventory',
  );

  required(
    JUDGE_KIND_DEFINITIONS.length === 3 &&
      JUDGE_KIND_DEFINITIONS.some(
        (entry) => entry.kind === JUDGE_KIND_TYPESAFE && entry.availability === 'available',
      ) &&
      JUDGE_KIND_DEFINITIONS.some(
        (entry) => entry.kind === JUDGE_KIND_LOCAL_ENDPOINT && entry.availability === 'available',
      ) &&
      JUDGE_KIND_DEFINITIONS.some(
        (entry) =>
          entry.kind === JUDGE_KIND_LAYA &&
          entry.availability === 'unavailable' &&
          entry.unavailableCode === 'E2_REQUIRED' &&
          entry.implementation !== undefined,
      ),
    'Phase E judge-kind registry',
  );
  for (const document of VALID_JUDGES) {
    const canonical = canonicalJudge(document);
    required(canonical.kind === document.kind, 'canonical judge parser returns its validated kind');
  }
  for (const document of INVALID_JUDGES) requireCanonicalJudgeRefusal(document);
}
