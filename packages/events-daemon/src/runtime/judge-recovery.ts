import type { DatabaseSync } from 'node:sqlite';
import { recoverOneJudgeReservationInTransaction } from './judge-budget.ts';

/** A closed selector keeps every recovery/purge caller scoped by account/source, kind, or exact synthetic work. */
export type JudgeRecoverySelector =
  | { readonly scope: 'all' }
  | { readonly scope: 'judge-kind'; readonly judgeKind: string }
  | {
      readonly scope: 'source-account';
      readonly source: 'gmail' | 'slack' | 'resend' | 'whatsapp';
      readonly accountId: string;
    }
  | {
      readonly scope: 'rule';
      readonly source: 'gmail' | 'slack' | 'resend' | 'whatsapp';
      readonly accountId: string;
      readonly ruleId: string;
    }
  | { readonly scope: 'synthetic-test'; readonly testWorkId: string };

export interface JudgeRecoveryResult {
  readonly released: number;
  readonly settled: number;
}

function selection(selector: JudgeRecoverySelector): { readonly sql: string; readonly args: readonly string[] } {
  switch (selector.scope) {
    case 'all':
      return { sql: '', args: [] };
    case 'judge-kind':
      return { sql: ' AND judge_kind = ?', args: [selector.judgeKind] };
    case 'source-account':
      return {
        sql: " AND work_scope = 'source-owned' AND source = ? AND account_id = ?",
        args: [selector.source, selector.accountId],
      };
    case 'rule':
      return {
        sql: " AND work_scope = 'source-owned' AND source = ? AND account_id = ? AND rule_id = ?",
        args: [selector.source, selector.accountId, selector.ruleId],
      };
    case 'synthetic-test':
      return { sql: " AND work_scope = 'synthetic-test' AND test_work_id = ?", args: [selector.testWorkId] };
  }
}

/**
 * The sole idempotent crash/purge transition: pre-I/O rows release; post-I/O rows pessimistically settle, close one
 * content-free no-match decision, and purge their projection. The caller owns the surrounding immediate transaction.
 */
export function recoverJudgeWork(input: {
  readonly database: DatabaseSync;
  readonly now: number;
  readonly selector?: JudgeRecoverySelector | undefined;
}): JudgeRecoveryResult {
  const chosen = selection(input.selector ?? { scope: 'all' });
  const rows = input.database
    .prepare(
      `SELECT id FROM judge_budget_reservations WHERE state IN ('reserved', 'in-flight')${chosen.sql} ORDER BY id`,
    )
    .all(...chosen.args) as Array<{ id: string }>;
  let released = 0;
  let settled = 0;
  for (const row of rows) {
    const outcome = recoverOneJudgeReservationInTransaction(input.database, row.id, input.now);
    if (outcome === 'released') released += 1;
    if (outcome === 'settled') settled += 1;
  }
  return { released, settled };
}
