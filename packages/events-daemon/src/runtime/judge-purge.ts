import type { DatabaseSync } from 'node:sqlite';
import type { JudgeKind } from '../domain/lifecycle.ts';
import type { SourceOptions } from '../domain/source-options.ts';
import { purgeHeldDecisionsInTransaction } from './holds.ts';
import { type JudgeRecoveryResult, recoverJudgeWork, recoverRevokedJudgeVersions } from './judge-recovery.ts';

/**
 * The sole judge participant for a caller's already-open immediate transaction. It deliberately performs no
 * reservation transition itself: Task 5's idempotent recovery primitive releases pre-I/O work and terminalises
 * post-I/O work exactly once.
 */
export class JudgePurgeParticipant {
  readonly #database: DatabaseSync;
  readonly #now: () => number;

  constructor(input: { readonly database: DatabaseSync; readonly now?: (() => number) | undefined }) {
    this.#database = input.database;
    this.#now = input.now ?? Date.now;
  }

  all(): JudgeRecoveryResult {
    const result = recoverJudgeWork({ database: this.#database, now: this.#now(), selector: { scope: 'all' } });
    purgeHeldDecisionsInTransaction(this.#database, { scope: 'all' });
    return result;
  }

  kind(judgeKind: JudgeKind): JudgeRecoveryResult {
    const result = recoverJudgeWork({
      database: this.#database,
      now: this.#now(),
      selector: { scope: 'judge-kind', judgeKind },
    });
    purgeHeldDecisionsInTransaction(this.#database, { scope: 'judge-kind', judgeKind });
    return result;
  }

  /** Judge removal is version-exact and delegates each durable identity to the single recovery transition. */
  judge(input: { readonly judgeId: string; readonly versions: readonly number[] }): JudgeRecoveryResult {
    return recoverRevokedJudgeVersions({
      database: this.#database,
      now: this.#now(),
      judgeId: input.judgeId,
      versions: input.versions,
    });
  }

  account(input: { readonly source: SourceOptions['channel']; readonly accountId: string }): JudgeRecoveryResult {
    const result = recoverJudgeWork({
      database: this.#database,
      now: this.#now(),
      selector: { scope: 'source-account', source: input.source, accountId: input.accountId },
    });
    purgeHeldDecisionsInTransaction(this.#database, { scope: 'source-account', ...input });
    return result;
  }

  event(input: {
    readonly source: SourceOptions['channel'];
    readonly accountId: string;
    readonly eventId: string;
    readonly ruleId?: string | undefined;
    readonly ruleVersion?: number | undefined;
  }): JudgeRecoveryResult {
    if ((input.ruleId === undefined) !== (input.ruleVersion === undefined))
      throw new Error('a rule-bound judge event purge needs both rule id and version');
    const result = recoverJudgeWork({
      database: this.#database,
      now: this.#now(),
      selector:
        input.ruleId === undefined
          ? { scope: 'source-event', source: input.source, accountId: input.accountId, eventId: input.eventId }
          : {
              scope: 'source-event-rule',
              source: input.source,
              accountId: input.accountId,
              eventId: input.eventId,
              ruleId: input.ruleId,
              ruleVersion: input.ruleVersion as number,
            },
    });
    if (input.ruleId === undefined)
      purgeHeldDecisionsInTransaction(this.#database, {
        scope: 'source-event',
        source: input.source,
        accountId: input.accountId,
        eventId: input.eventId,
      });
    else
      purgeHeldDecisionsInTransaction(this.#database, {
        scope: 'source-event-rule',
        source: input.source,
        accountId: input.accountId,
        eventId: input.eventId,
        ruleId: input.ruleId,
        ruleVersion: input.ruleVersion as number,
      });
    return result;
  }

  /**
   * Purge judge work for one retained projection without inferring its source from the replacement document.  The
   * reservation is the durable authority for source ownership, and each recovered row remains fenced to its exact
   * account/event/rule/version tuple.
   */
  retainedProjection(input: {
    readonly accountId: string;
    readonly eventId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
  }): JudgeRecoveryResult {
    const rows = this.#database
      .prepare(
        `SELECT DISTINCT source, account_id, rule_version
           FROM judge_budget_reservations
          WHERE work_scope = 'source-owned' AND source IS NOT NULL AND account_id IS NOT NULL
            AND account_id = ? AND event_id = ? AND rule_id = ? AND rule_version = ?`,
      )
      .all(input.accountId, input.eventId, input.ruleId, input.ruleVersion) as Array<{
      source: SourceOptions['channel'];
      account_id: string;
      rule_version: number;
    }>;
    let released = 0;
    let settled = 0;
    for (const row of rows) {
      const result = this.event({ ...input, source: row.source });
      released += result.released;
      settled += result.settled;
    }
    return { released, settled };
  }

  /** Enumerate the raw source/account identities first; each recovery call remains exact and account-scoped. */
  rule(input: { readonly ruleId: string; readonly versions: readonly number[] }): JudgeRecoveryResult {
    const versions = input.versions;
    if (versions.length === 0) return { released: 0, settled: 0 };
    const versionClause = ` AND rule_version IN (${versions.map(() => '?').join(', ')})`;
    const rows = this.#database
      .prepare(
        `SELECT DISTINCT source, account_id, rule_version
           FROM judge_budget_reservations
          WHERE work_scope = 'source-owned' AND source IS NOT NULL AND account_id IS NOT NULL
            AND rule_id = ?${versionClause}`,
      )
      .all(input.ruleId, ...versions) as Array<{
      source: SourceOptions['channel'];
      account_id: string;
      rule_version: number;
    }>;
    let released = 0;
    let settled = 0;
    for (const row of rows) {
      const result = recoverJudgeWork({
        database: this.#database,
        now: this.#now(),
        selector: {
          scope: 'rule',
          source: row.source,
          accountId: row.account_id,
          ruleId: input.ruleId,
          ruleVersion: row.rule_version,
        },
      });
      released += result.released;
      settled += result.settled;
    }
    // Holds have no reservation row once the judge response settled, so enumerate their immutable source/account
    // identities independently. Never give a broad rule purge an account-less delete predicate.
    const held = this.#database
      .prepare(
        `SELECT DISTINCT json_extract(rule.document, '$.source.channel') AS source, decision.account_id,
                         decision.event_id, decision.rule_version
           FROM decisions AS decision
           JOIN rule_versions AS rule ON rule.rule_id = decision.rule_id AND rule.version = decision.rule_version
          WHERE decision.outcome = 'hold' AND decision.rule_id = ?
            AND decision.rule_version IN (${versions.map(() => '?').join(', ')})`,
      )
      .all(input.ruleId, ...versions) as Array<{
      source: SourceOptions['channel'];
      account_id: string;
      event_id: string;
      rule_version: number;
    }>;
    for (const row of held)
      purgeHeldDecisionsInTransaction(this.#database, {
        scope: 'source-event-rule',
        source: row.source,
        accountId: row.account_id,
        eventId: row.event_id,
        ruleId: input.ruleId,
        ruleVersion: row.rule_version,
      });
    return { released, settled };
  }
}
