/** Durable activation boundaries exercised by restart/recovery tests. */
export const ACTIVATION_CRASH_BOUNDARIES = [
  'intent-inserted',
  'disclosure-created',
  'approval-attached',
  'disclosure-approved',
  'disclosure-used',
  'claimed-at-copied',
  'baseline-persisted',
  'pointer-committed',
  'intent-completed',
] as const;

export type ActivationCrashBoundary = (typeof ACTIVATION_CRASH_BOUNDARIES)[number];
