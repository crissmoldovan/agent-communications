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
      readonly judgeKind?: string | undefined;
    }
  | {
      readonly scope: 'source-event';
      readonly source: 'gmail' | 'slack' | 'resend' | 'whatsapp';
      readonly accountId: string;
      readonly eventId: string;
    }
  | {
      readonly scope: 'source-event-rule';
      readonly source: 'gmail' | 'slack' | 'resend' | 'whatsapp';
      readonly accountId: string;
      readonly eventId: string;
      readonly ruleId: string;
      readonly ruleVersion: number;
    }
  | {
      readonly scope: 'rule';
      readonly source: 'gmail' | 'slack' | 'resend' | 'whatsapp';
      readonly accountId: string;
      readonly ruleId: string;
      readonly ruleVersion?: number | undefined;
    }
  | { readonly scope: 'synthetic-test'; readonly testWorkId: string; readonly judgeKind?: string | undefined };

export interface JudgeRecoveryResult {
  readonly released: number;
  readonly settled: number;
}

function matchingReservationIds(
  database: DatabaseSync,
  selector: Exclude<JudgeRecoverySelector, { readonly scope: 'all' | 'judge-kind' }>,
): Array<{ id: string }> {
  switch (selector.scope) {
    case 'source-account':
      return database
        .prepare(
          `SELECT id FROM judge_budget_reservations
            WHERE state IN ('reserved', 'in-flight')
              AND work_scope = 'source-owned' AND source = ? AND account_id = ?${selector.judgeKind === undefined ? '' : ' AND judge_kind = ?'}
            ORDER BY id`,
        )
        .all(
          selector.source,
          selector.accountId,
          ...(selector.judgeKind === undefined ? [] : [selector.judgeKind]),
        ) as Array<{ id: string }>;
    case 'source-event':
      return database
        .prepare(
          `SELECT id FROM judge_budget_reservations
            WHERE state IN ('reserved', 'in-flight')
              AND work_scope = 'source-owned' AND source = ? AND account_id = ? AND event_id = ?
            ORDER BY id`,
        )
        .all(selector.source, selector.accountId, selector.eventId) as Array<{ id: string }>;
    case 'source-event-rule':
      return database
        .prepare(
          `SELECT id FROM judge_budget_reservations
            WHERE state IN ('reserved', 'in-flight')
              AND work_scope = 'source-owned' AND source = ? AND account_id = ? AND event_id = ?
              AND rule_id = ? AND rule_version = ?
            ORDER BY id`,
        )
        .all(selector.source, selector.accountId, selector.eventId, selector.ruleId, selector.ruleVersion) as Array<{
        id: string;
      }>;
    case 'rule':
      return database
        .prepare(
          `SELECT id FROM judge_budget_reservations
            WHERE state IN ('reserved', 'in-flight')
              AND work_scope = 'source-owned' AND source = ? AND account_id = ? AND rule_id = ?${selector.ruleVersion === undefined ? '' : ' AND rule_version = ?'}
            ORDER BY id`,
        )
        .all(
          selector.source,
          selector.accountId,
          selector.ruleId,
          ...(selector.ruleVersion === undefined ? [] : [selector.ruleVersion]),
        ) as Array<{ id: string }>;
    case 'synthetic-test':
      return database
        .prepare(
          `SELECT id FROM judge_budget_reservations
            WHERE state IN ('reserved', 'in-flight')
              AND work_scope = 'synthetic-test' AND test_work_id = ?${selector.judgeKind === undefined ? '' : ' AND judge_kind = ?'}
            ORDER BY id`,
        )
        .all(selector.testWorkId, ...(selector.judgeKind === undefined ? [] : [selector.judgeKind])) as Array<{
        id: string;
      }>;
  }
}

function recoverEnumeratedJudgeWork(input: {
  readonly database: DatabaseSync;
  readonly now: number;
  readonly judgeKind?: string | undefined;
}): JudgeRecoveryResult {
  const rows = input.database
    .prepare(
      `SELECT DISTINCT work_scope, source, account_id, test_work_id
         FROM judge_budget_reservations
        WHERE state IN ('reserved', 'in-flight')
          AND (
            (work_scope = 'source-owned' AND source IS NOT NULL AND account_id IS NOT NULL)
            OR (work_scope = 'synthetic-test' AND test_work_id IS NOT NULL)
          )${input.judgeKind === undefined ? '' : ' AND judge_kind = ?'}`,
    )
    .all(...(input.judgeKind === undefined ? [] : [input.judgeKind])) as Array<{
    work_scope: 'source-owned' | 'synthetic-test';
    source: 'gmail' | 'slack' | 'resend' | 'whatsapp' | null;
    account_id: string | null;
    test_work_id: string | null;
  }>;
  let released = 0;
  let settled = 0;
  for (const row of rows) {
    const result =
      row.work_scope === 'source-owned'
        ? recoverJudgeWork({
            database: input.database,
            now: input.now,
            selector: {
              scope: 'source-account',
              source: row.source as 'gmail' | 'slack' | 'resend' | 'whatsapp',
              accountId: row.account_id as string,
              judgeKind: input.judgeKind,
            },
          })
        : recoverJudgeWork({
            database: input.database,
            now: input.now,
            selector: {
              scope: 'synthetic-test',
              testWorkId: row.test_work_id as string,
              judgeKind: input.judgeKind,
            },
          });
    released += result.released;
    settled += result.settled;
  }
  return { released, settled };
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
  const selector = input.selector ?? { scope: 'all' };
  if (selector.scope === 'all') return recoverEnumeratedJudgeWork({ database: input.database, now: input.now });
  if (selector.scope === 'judge-kind')
    return recoverEnumeratedJudgeWork({ database: input.database, now: input.now, judgeKind: selector.judgeKind });
  const rows = matchingReservationIds(input.database, selector);
  let released = 0;
  let settled = 0;
  for (const row of rows) {
    const outcome = recoverOneJudgeReservationInTransaction(input.database, row.id, input.now);
    if (outcome === 'released') released += 1;
    if (outcome === 'settled') settled += 1;
  }
  return { released, settled };
}
