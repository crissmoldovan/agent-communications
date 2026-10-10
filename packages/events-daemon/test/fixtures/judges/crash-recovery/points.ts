/** Every interruption point Task 5 must leave recoverable through the real durable ledger. */
export const JUDGE_CRASH_POINTS = [
  'after-reserve',
  'before-transport',
  'after-transport',
  'after-response-persistence',
  'after-settlement',
  'after-terminal-decision',
  'after-delivery-insert',
  'after-projection-purge',
  'before-commit',
] as const;

export type JudgeCrashPoint = (typeof JUDGE_CRASH_POINTS)[number];
