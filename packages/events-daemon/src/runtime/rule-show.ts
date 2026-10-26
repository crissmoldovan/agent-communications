import { CommsError } from '@agentcomms/core';
import { type DescribableRuleDocument, describeRule, type RulePart } from '@agentcomms/events';
import type { EventDatabase } from '../store/database.ts';
import type { ConnectedEventAccount } from './account-fence.ts';

/** `rule show`'s look back: the last 7 days (owner feedback 0.32.0, §3.4). */
export const RULE_COUNT_WINDOW_MS: number = 7 * 86_400_000;

/**
 * What one rule version did in the last 7 days, counted from its decisions and deliveries. The event service keeps no
 * decision time, so a decision is in the window when its event was observed in it.
 * - `matched`: decisions that passed the message on (its condition matched and, with a judge, the judge said yes or the
 *   person let a held one through);
 * - `judgedYes`: of those, the ones a judge said yes to;
 * - `judgedNo`: decisions whose condition matched and whose judge said no (while the decision's metadata is kept);
 * - `held`: decisions held for the person, whether they are still held or were since decided;
 * - `delivered` and `failed`: the deliveries those decisions made that were delivered, or failed for good.
 */
export interface RuleCounts7dV1 {
  readonly matched: number;
  readonly judgedYes: number;
  readonly judgedNo: number;
  readonly held: number;
  readonly delivered: number;
  readonly failed: number;
}

/**
 * One `rule show` entry: the fields it always had (`document`, `digest`, `state`, `approval_id`,
 * `authorization_activation_id`), then 0.32.0's, additive and content-free.
 */
export interface RuleShowEntryV1 {
  readonly document: unknown;
  readonly digest: string;
  readonly state: string | null;
  readonly approval_id: string | null;
  readonly authorization_activation_id: string | null;
  /** When the version was switched on, replaced by a newer one, and revoked, in ms; null when it never was. */
  readonly activatedAt: number | null;
  readonly supersededAt: number | null;
  readonly revokedAt: number | null;
  /** The version in plain words; rule-author strings are `untrusted` parts. */
  readonly summary: readonly RulePart[];
  readonly counts7d: RuleCounts7dV1;
}

interface RuleVersionRow {
  readonly version: number;
  readonly document: string;
  readonly digest: string;
  readonly state: string | null;
  readonly approval_id: string | null;
  readonly authorization_activation_id: string | null;
  readonly activated_at: number | null;
  readonly superseded_at: number | null;
  readonly revoked_at: number | null;
}

export class RuleReader {
  readonly #store: EventDatabase;
  readonly #now: () => number;
  readonly #accounts: () => Promise<readonly ConnectedEventAccount[]>;

  constructor(input: {
    readonly store: EventDatabase;
    readonly now?: (() => number) | undefined;
    /** The connected accounts, by the alias a person knows each by. */
    readonly accounts?: (() => Promise<readonly ConnectedEventAccount[]>) | undefined;
  }) {
    this.#store = input.store;
    this.#now = input.now ?? Date.now;
    this.#accounts = input.accounts ?? (async () => []);
  }

  async show(ruleId: string): Promise<readonly RuleShowEntryV1[]> {
    const rows = this.#store.database
      .prepare(
        `SELECT version, document, digest, state, approval_id, authorization_activation_id, activated_at, superseded_at,
                revoked_at
           FROM rule_versions WHERE rule_id = ? ORDER BY version`,
      )
      .all(ruleId) as unknown as RuleVersionRow[];
    if (rows.length === 0) throw new CommsError('NOT_FOUND', 'the requested rule does not exist');
    const aliases = Object.fromEntries((await this.#accounts()).map((entry) => [entry.accountId, entry.account]));
    const since = this.#now() - RULE_COUNT_WINDOW_MS;
    return rows.map((row) => {
      const document = JSON.parse(row.document) as DescribableRuleDocument;
      return {
        document,
        digest: row.digest,
        state: row.state,
        approval_id: row.approval_id,
        authorization_activation_id: row.authorization_activation_id,
        activatedAt: row.activated_at,
        supersededAt: row.superseded_at,
        revokedAt: row.revoked_at,
        summary: describeRule(document, { accountNames: aliases }),
        counts7d: this.#counts(ruleId, row.version, document.agentic !== undefined, since),
      };
    });
  }

  #counts(ruleId: string, version: number, judged: boolean, since: number): RuleCounts7dV1 {
    const decisions = this.#store.database
      .prepare(
        `SELECT
            coalesce(sum(d.outcome = 'matched'), 0) AS matched,
            coalesce(sum(d.outcome = 'matched' AND d.hold_created_at IS NULL), 0) AS passed_unheld,
            coalesce(sum(d.outcome = 'no-match' AND d.encrypted_record IS NOT NULL), 0) AS judged_no,
            coalesce(sum(d.outcome = 'hold' OR d.hold_created_at IS NOT NULL), 0) AS held
           FROM decisions AS d JOIN ingest AS i ON i.event_id = d.event_id
          WHERE d.rule_id = ? AND d.rule_version = ? AND i.observed_at >= ?`,
      )
      .get(ruleId, version, since) as { matched: number; passed_unheld: number; judged_no: number; held: number };
    const deliveries = this.#store.database
      .prepare(
        `SELECT
            coalesce(sum(v.state = 'delivered'), 0) AS delivered,
            coalesce(sum(v.state IN ('dead-lettered', 'content-unreadable')), 0) AS failed
           FROM deliveries AS v
           JOIN decisions AS d ON d.id = v.decision_id
           JOIN ingest AS i ON i.event_id = d.event_id
          WHERE v.rule_id = ? AND v.rule_version = ? AND i.observed_at >= ?`,
      )
      .get(ruleId, version, since) as { delivered: number; failed: number };
    return {
      matched: decisions.matched,
      judgedYes: judged ? decisions.passed_unheld : 0,
      judgedNo: judged ? decisions.judged_no : 0,
      held: decisions.held,
      delivered: deliveries.delivered,
      failed: deliveries.failed,
    };
  }
}
