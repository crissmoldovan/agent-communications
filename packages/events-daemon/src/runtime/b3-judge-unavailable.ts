import type {
  B3ControlOperation,
  B3HeldListV1,
  B3HoldsUnavailableV1,
  B3JudgeUnavailableV1,
} from '../operations/b3-contract.ts';

const E_OPERATIONS: ReadonlySet<B3ControlOperation> = new Set([
  'judgesList',
  'addJudge',
  'updateJudge',
  'removeJudge',
  'judgeTest',
  'budgetShow',
  'updateBudget',
  'judgeKindsList',
  'enableJudgeKind',
  'disableJudgeKind',
]);

/**
 * The complete pre-E implementation.  It deliberately has no store, worker,
 * transport, model or endpoint dependency, so a future producer can replace
 * it behind the same owner operation without a dormant capability becoming
 * callable early.
 */
export function judgeUnavailable(
  operation: B3ControlOperation,
  args: Readonly<Record<string, unknown>>,
): B3JudgeUnavailableV1 | undefined {
  if (operation === 'judgeModelStatus' || operation === 'removeJudgeModel') return unavailableE2();
  if (!E_OPERATIONS.has(operation)) return undefined;
  if ((operation === 'enableJudgeKind' || operation === 'disableJudgeKind') && args.kind === 'laya')
    return unavailableE2();
  return unavailableE();
}

export function heldListUnavailable(): B3HeldListV1 {
  return { kind: 'held-list', decisions: [] };
}

export function decideHeldUnavailable(): B3HoldsUnavailableV1 {
  return { kind: 'unavailable', code: 'HOLDS_UNAVAILABLE', phase: 'E' };
}

function unavailableE(): B3JudgeUnavailableV1 {
  return { kind: 'unavailable', code: 'E_REQUIRED', phase: 'E' };
}

function unavailableE2(): B3JudgeUnavailableV1 {
  return { kind: 'unavailable', code: 'E2_REQUIRED', phase: 'E2' };
}
