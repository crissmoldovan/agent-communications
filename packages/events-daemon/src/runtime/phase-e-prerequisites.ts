import { canonicalJudge, JUDGE_KIND_DEFINITIONS } from '../domain/judges.ts';
import {
  B3_CAPABILITIES,
  B3_CONTROL_CONTRACT,
  B3_CONTROL_V1_OPERATION_SPECS,
  B3_CONTROL_V1_SCHEMA_VERSION,
  B3_JUDGE_UNAVAILABLE_VARIANTS,
} from '../operations/b3-contract.ts';

/** The E-owned prerequisite contract is intentionally unregistered and has no owner or operation dependency. */
export const PHASE_E_PREREQUISITE_VERSION = 1;

function required(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Phase E prerequisite failed: ${message}`);
}

const VALID_JUDGES = [
  {
    judgeId: 'phase-e-prerequisite-typesafe',
    version: 1,
    kind: 'typesafe',
    provider: 'typesafe',
    model: 'jev-1.13.0',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    promptTemplate: 'typesafe-jev-noul-v1',
    protocol: 'noul',
  },
  {
    judgeId: 'phase-e-prerequisite-local',
    version: 1,
    kind: 'local-endpoint',
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
  { ...VALID_JUDGES[0], kind: 'laya' },
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
  for (const capability of [
    'events-daemon.judge-key.set',
    'events-daemon.judge-key.rotate',
    'events-daemon.secrets.migrate',
    'events-daemon.held.decide',
  ])
    required(
      B3_CAPABILITIES.some((entry) => entry.id === capability),
      `B3 capability ${capability}`,
    );

  required(
    JUDGE_KIND_DEFINITIONS.length === 3 &&
      JUDGE_KIND_DEFINITIONS.some((entry) => entry.kind === 'typesafe' && entry.availability === 'available') &&
      JUDGE_KIND_DEFINITIONS.some((entry) => entry.kind === 'local-endpoint' && entry.availability === 'available') &&
      JUDGE_KIND_DEFINITIONS.some(
        (entry) =>
          entry.kind === 'laya' &&
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
