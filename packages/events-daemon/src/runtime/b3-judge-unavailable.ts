import type { B3ControlOperation } from '../operations/b3-contract.ts';

export interface JudgeUnavailableV1 {
  readonly kind: 'unavailable';
  readonly code: 'E_REQUIRED' | 'E2_REQUIRED';
  readonly phase: 'E' | 'E2';
}

export interface HeldListV1 {
  readonly kind: 'held-list';
  readonly decisions: readonly [];
}

export interface HoldsUnavailableV1 {
  readonly kind: 'unavailable';
  readonly code: 'HOLDS_UNAVAILABLE';
  readonly phase: 'E';
}

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
): JudgeUnavailableV1 | undefined {
  if (operation === 'judgeModelStatus' || operation === 'removeJudgeModel') return unavailableE2();
  if (!E_OPERATIONS.has(operation)) return undefined;
  if ((operation === 'enableJudgeKind' || operation === 'disableJudgeKind') && args.kind === 'laya')
    return unavailableE2();
  return unavailableE();
}

export function heldListUnavailable(): HeldListV1 {
  return { kind: 'held-list', decisions: [] };
}

export function decideHeldUnavailable(): HoldsUnavailableV1 {
  return { kind: 'unavailable', code: 'HOLDS_UNAVAILABLE', phase: 'E' };
}

function unavailableE(): JudgeUnavailableV1 {
  return { kind: 'unavailable', code: 'E_REQUIRED', phase: 'E' };
}

function unavailableE2(): JudgeUnavailableV1 {
  return { kind: 'unavailable', code: 'E2_REQUIRED', phase: 'E2' };
}
