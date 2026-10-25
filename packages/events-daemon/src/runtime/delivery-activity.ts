import {
  type ActivityOutcome,
  type ActivitySession,
  type ConfigStore,
  type Core,
  recordActivity,
  sessionIdentity,
} from '@agentcomms/core';
import type { EventDatabase } from '../store/database.ts';
import { connectedEventAccounts } from './account-fence.ts';

/**
 * The event service's own "told" lines in agent-communications' activity log (activity design S1, §8 Task 2c): one
 * line for what each delivery came to — delivered, failed, or dropped — naming the rule, the account its events came
 * from, how many events, the target, and the outcome.
 *
 * - **Never content.** A line is built only from a delivery's rule id, account id, target id and closed terminal
 *   state. No payload, CloudEvent, sender, subject, event id or provider error text is read, so none can be written
 *   (events design D7, D8 and Appendix A keep every payload out of every log). A target is named by its id, never its
 *   URL or a secret.
 * - **After the outcome is durable.** The outcome is read back from the committed `deliveries` row; every delivery
 *   transaction is synchronous, so no read here sees one half-done, and a pass inside an open transaction waits for
 *   the next.
 * - **Once.** Each delivery is counted in exactly one line: the first terminal state it is seen in. A dead letter
 *   whose payload is later purged, or dropped, is not counted again. Deliveries already finished when this process
 *   started were counted by the process that finished them.
 * - **Grouped.** Outcomes seen in one pass with the same rule, account, target and outcome are one line, whose count
 *   is how many events they were ("Delivered 3 events from david-on-slack to my-hook").
 * - **Best effort, as every activity line is (§4.6).** Recording never changes or delays a delivery, never throws, and
 *   a line lost to a crash between a delivery's commit and the next pass is not written later: the event database
 *   stays the record of what was delivered.
 */

/** The activity log's operation for a delivery outcome. Not a capability: no CLI or MCP call makes it. */
export const DELIVERY_ACTIVITY_OPERATION = 'events.delivery';
/** The channel word a delivery outcome is recorded under: the event service's. */
export const DELIVERY_ACTIVITY_CHANNEL = 'events';
/** How often the owner records the outcomes reached since its last pass, by default. */
export const DELIVERY_ACTIVITY_INTERVAL_MS = 5_000;

/** Deliveries that may still be delivered; every other state is an outcome. */
const OPEN_STATES = "('queued', 'retryable', 'disclosing')";

/**
 * Each terminal delivery state as an activity outcome:
 * - `ok`: delivered;
 * - `failed`: every attempt failed, its deadline passed first, or its stored copy could not be read;
 * - `refused`: dropped before it was delivered, because its rule, target, subscriber or account was removed, collection
 *   was switched off, or its chat was hidden.
 */
const OUTCOMES: Readonly<Record<string, ActivityOutcome>> = Object.freeze({
  delivered: 'ok',
  'dead-lettered': 'failed',
  'retention-expired': 'failed',
  'content-unreadable': 'failed',
  cancelled: 'refused',
  'in-flight-at-disable': 'refused',
  'in-flight-at-account-removal': 'refused',
});

interface DeliveryRow {
  readonly seq: number;
  readonly rule_id: string;
  readonly account_id: string;
  readonly target_id: string;
  readonly state: string;
  readonly dead_lettered_at: number | null;
}

/** One delivery's outcome, as it is counted. */
interface Settled {
  readonly rule: string;
  readonly accountId: string;
  readonly target: string;
  readonly outcome: ActivityOutcome;
  /** The closed terminal state, for an outcome other than `ok`. */
  readonly reason: string | undefined;
}

export interface DeliveryActivityOptions {
  readonly store: Pick<EventDatabase, 'database'>;
  /** The core whose activity log the lines go to. */
  readonly core: Pick<Core, 'activity'>;
  /** Where an account's name is read, at the time of each line. */
  readonly config: Pick<ConfigStore, 'load'>;
  /** The event service's session; `sessionIdentity('daemon')`, worked out once, when left out. */
  readonly session?: (() => Promise<ActivitySession>) | undefined;
}

export class DeliveryActivity {
  readonly #store: Pick<EventDatabase, 'database'>;
  readonly #core: Pick<Core, 'activity'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #sessionOf: () => Promise<ActivitySession>;
  #session: Promise<ActivitySession> | undefined;
  /** The highest delivery row seen; every row above it is new since the last pass. */
  #high: number;
  /** Rows seen while they could still be delivered. */
  readonly #open = new Set<number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #writing: Promise<void> = Promise.resolve();
  #stopped = false;
  /** Set when the baseline could not be read: this process then records nothing. */
  #blind = false;

  /** Takes the baseline: what is already finished was counted by the process that finished it. */
  constructor(options: DeliveryActivityOptions) {
    this.#store = options.store;
    this.#core = options.core;
    this.#config = options.config;
    this.#sessionOf = options.session ?? (() => sessionIdentity('daemon'));
    try {
      const database = this.#store.database;
      this.#high = Number(
        (database.prepare('SELECT coalesce(max(rowid), 0) AS high FROM deliveries').get() as { high: number }).high,
      );
      for (const row of database
        .prepare(`SELECT rowid AS seq FROM deliveries WHERE state IN ${OPEN_STATES}`)
        .all() as Array<{ seq: number }>)
        this.#open.add(Number(row.seq));
    } catch {
      // No baseline, no lines: an owner never fails to start for its activity, and never counts an old outcome.
      this.#high = 0;
      this.#blind = true;
    }
  }

  /** Records the outcomes reached since the last pass every `intervalMs`, until `stop`. */
  start(intervalMs: number = DELIVERY_ACTIVITY_INTERVAL_MS): void {
    if (this.#timer !== undefined || this.#stopped || this.#blind) return;
    this.#timer = setInterval(() => {
      void this.record();
    }, intervalMs);
    this.#timer.unref?.();
  }

  /**
   * Records every outcome reached since the last pass, and resolves once its lines are written. Never throws. The
   * rows are read and marked counted at once, before anything awaits, so two passes never count one delivery twice.
   */
  record(): Promise<void> {
    if (this.#blind) return this.#writing;
    let settled: readonly Settled[];
    try {
      settled = this.#settle();
    } catch {
      // A database closed or unreadable here leaves the delivery as it is; it is only not recorded.
      settled = [];
    }
    if (settled.length > 0) this.#writing = this.#writing.then(() => this.#write(settled));
    return this.#writing;
  }

  /** Stops the timer and records what the last work finished. Call it before the event database closes. */
  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#stopped) return this.#writing;
    this.#stopped = true;
    return this.record();
  }

  #settle(): Settled[] {
    const database = this.#store.database;
    // Every delivery transaction here is synchronous, so none can be open now; should one be, wait for its commit.
    if (database.isTransaction) return [];
    const columns = 'd.rowid AS seq, d.rule_id, d.account_id, d.target_id, d.state, d.dead_lettered_at';
    const watched =
      this.#open.size === 0
        ? []
        : (database
            .prepare(`SELECT ${columns} FROM json_each(?) AS watching JOIN deliveries d ON d.rowid = watching.value`)
            .all(JSON.stringify([...this.#open])) as unknown as DeliveryRow[]);
    const fresh = database
      .prepare(`SELECT ${columns} FROM deliveries d WHERE d.rowid > ? ORDER BY d.rowid`)
      .all(this.#high) as unknown as DeliveryRow[];
    const seen = new Set<number>();
    const settled: Settled[] = [];
    for (const row of [...watched, ...fresh]) {
      const seq = Number(row.seq);
      if (seen.has(seq)) continue;
      seen.add(seq);
      if (seq > this.#high) this.#high = seq;
      const outcome = OUTCOMES[row.state];
      if (outcome === undefined) {
        this.#open.add(seq);
        continue;
      }
      this.#open.delete(seq);
      settled.push({
        rule: row.rule_id,
        accountId: row.account_id,
        target: row.target_id,
        outcome,
        // A dead letter is that, even if its payload's own retention ended before this pass saw it.
        reason: outcome === 'ok' ? undefined : row.dead_lettered_at !== null ? 'dead-lettered' : row.state,
      });
    }
    // A row that is no longer there is no longer watched.
    for (const seq of this.#open) if (!seen.has(seq)) this.#open.delete(seq);
    return settled;
  }

  async #write(settled: readonly Settled[]): Promise<void> {
    try {
      const groups = new Map<string, Settled & { count: number }>();
      for (const one of settled) {
        const key = JSON.stringify([one.rule, one.accountId, one.target, one.outcome, one.reason ?? null]);
        const group = groups.get(key);
        if (group === undefined) groups.set(key, { ...one, count: 1 });
        else group.count += 1;
      }
      const aliases = new Map<string, string>();
      try {
        for (const account of await connectedEventAccounts(this.#config))
          aliases.set(account.accountId, account.account);
      } catch {
        // Unreadable configuration: the lines name each account by its id alone.
      }
      this.#session ??= this.#sessionOf();
      const session = await this.#session;
      for (const group of groups.values()) {
        await recordActivity(this.#core, {
          channel: DELIVERY_ACTIVITY_CHANNEL,
          account: { id: group.accountId, alias: aliases.get(group.accountId) ?? '' },
          operation: DELIVERY_ACTIVITY_OPERATION,
          kind: 'told',
          outcome: group.outcome,
          ...(group.reason === undefined ? {} : { reason: group.reason }),
          session,
          ms: 0,
          count: group.count,
          told: { rule: group.rule, target: group.target },
        });
      }
    } catch {
      // Recording never fails the event service (§4.6).
    }
  }
}
