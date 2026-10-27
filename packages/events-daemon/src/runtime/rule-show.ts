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

  /**
   * Every version of the workflow, oldest first; or with `version`, that one version alone (0.36.0, plan B7), as a run
   * of it draws its graph: a run keeps its version's, whatever was saved since.
   */
  async show(ruleId: string, version?: number): Promise<readonly RuleShowEntryV1[]> {
    const all = this.#store.database
      .prepare(
        `SELECT version, document, digest, state, approval_id, authorization_activation_id, activated_at, superseded_at,
                revoked_at
           FROM rule_versions WHERE rule_id = ? ORDER BY version`,
      )
      .all(ruleId) as unknown as RuleVersionRow[];
    if (all.length === 0) throw new CommsError('NOT_FOUND', 'the requested workflow does not exist');
    const rows = version === undefined ? all : all.filter((row) => row.version === version);
    if (rows.length === 0)
      throw new CommsError('NOT_FOUND', `the workflow ${ruleId} has no version ${version}`, {
        details: { reason: 'VERSION_UNKNOWN' },
      });
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

/**
 * A workflow document as an agent reads it (security review of 0.36.0, M3; spec §8.1, taking design T7): a route
 * step's candidates are bound by value (W12), and a project's folders and worktree root name a client, so each
 * candidate keeps its `projectId` and `name`, its `folders` become `[]` and its `worktreeRoot` `null`, and it gains
 * `foldersHidden`, how many folders it has. Everything else is as stored, and a document with no route step is returned
 * as it is. The person's own view — no caller, no agent's marker — is never passed through here.
 */
export function withRouteFoldersHidden(document: unknown): unknown {
  if (!isRecord(document) || !isRecord(document.flow) || !isRecord(document.flow.steps)) return document;
  const steps = document.flow.steps;
  let changed = false;
  const shown = Object.fromEntries(
    Object.entries(steps).map(([stepId, step]) => {
      if (!isRecord(step) || step.kind !== 'route' || !Array.isArray(step.candidates)) return [stepId, step];
      changed = true;
      return [
        stepId,
        {
          ...step,
          candidates: step.candidates.map((candidate: unknown) =>
            isRecord(candidate)
              ? {
                  ...candidate,
                  folders: [],
                  worktreeRoot: null,
                  foldersHidden: Array.isArray(candidate.folders) ? candidate.folders.length : 0,
                }
              : candidate,
          ),
        },
      ];
    }),
  );
  return changed ? { ...document, flow: { ...document.flow, steps: shown } } : document;
}

/**
 * `rule show`'s entries as an agent reads them (M3): each version's document with its route candidates' folders
 * hidden. The owner gives an agent window's call this through `ruleVersionsForWindow`; an agent's shell, whose call
 * names no window, gets it from the command line, as its approval view is.
 */
export function ruleShowForAgent(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry: unknown) =>
    isRecord(entry) && Object.hasOwn(entry, 'document')
      ? { ...entry, document: withRouteFoldersHidden(entry.document) }
      : entry,
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
