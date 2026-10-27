import { createHash } from 'node:crypto';
import {
  type ConfigStore,
  isClaudeCodeSessionId,
  NOTICE_TITLE,
  type Notifier,
  offerWaitMs,
  offerWaitsUntil,
  readTakingSettings,
  TAKE_OFFER_MS,
  TAKE_OFFER_WAIT_MS,
  type TakeLine,
  type TakeMessage,
  type TakeRecord,
  type TakeStore,
  type TakeWindow,
  takingFor,
} from '@agentcomms/core';
import { sqlTargetLane } from '../domain/lanes.ts';
import type { EventDatabase } from '../store/database.ts';
import { parseEventSource } from './event-source.ts';

/**
 * Taking messages in the event service (design 2026-10-26-taking-messages, T3, T4 and §8). The service opens core on its
 * own state folder, so it writes into core's take store — and only offers: it never writes `taken`.
 *
 * - **Offers (T4).** After a delivery commits, as its "told" lines are, a delivery to a lane offers the message to the
 *   window bound to that lane, by its Claude Code session id and its activity key; a session target's dispatch offers it
 *   to the relay session its prompt was posted to, by that session's `nativeSessionId`. Best-effort: an offer that cannot
 *   be written never fails, delays past its write, or undoes a delivery. An offer is exclusive while the item waits for
 *   its window, then for `TAKE_OFFER_MS` after the window was handed it — woken for it, or its prompt posted — and then it
 *   lapses, open again. An offer whose item no longer waits (closed, gone, its lane bound to another window) lapses at
 *   the next sweep, and one whose window is never woken for it lapses by itself at the account's reminder window
 *   (core's `offerWait`; security review of 0.35.0, M5) — a wake after that names no offer. Only accounts that ask a session to take a message first (`taking.required`) are offered anything:
 *   with it off, an offer would refuse other sessions' acts, and nothing changes until the person turns taking on (§14).
 * - **The words the session reads.** The prompt's fixed frame and the lane's pointer carry one fixed line of ours with
 *   the offer's clock time — only once the offer is known to be written, or about to be with a time already chosen.
 * - **The "nobody took it" sweep (§8), once a minute.** For each account with taking required, every
 *   `gmail.message.received`, `slack.message.posted` and `resend.email.received` event a rule matched and delivered to a
 *   lane, a session or the Queue, that has waited `unclaimed.afterMinutes` with no take, no done and no live offer: the
 *   clock starts when the event service saw it, and again when it was last handed back, released, or a take of it
 *   lapsed — an offer that ran out counts from when it was made (`reopenedLine`), so a lane offer its window was never
 *   woken for counts as soon as it lapses; a `needs-the-person` hand-back counts at once. With `unclaimed.notify` on and collection on, one content-free notice per
 *   sweep per account, through core's notifier, for the messages not yet reminded of. It writes the `ended` and
 *   `expired` lines first (T3). It makes no queue item: the app's Not taken tab shows them (§8, "Put it in the Queue").
 * - **Nothing a sender wrote** is read here: ids from an event's dedupe key, the rule's and the delivery's ids, the
 *   window's ids and folder, and closed words. A notice names the account and counts.
 */

/** The events a take can be about: each channel's inbound message (§8). */
export const TAKEABLE_EVENT_TYPES: readonly [
  'gmail.message.received',
  'slack.message.posted',
  'resend.email.received',
] = Object.freeze(['gmail.message.received', 'slack.message.posted', 'resend.email.received'] as const);

/** How often the sweep runs (§8). */
export const TAKE_SWEEP_INTERVAL_MS = 60_000;
/** How far back the sweep looks for a message nobody took: a reminder about one older than a day reminds nobody. */
export const TAKE_SWEEP_LOOKBACK_MS: number = 24 * 60 * 60_000;

const TAKEABLE_SQL = TAKEABLE_EVENT_TYPES.map((type) => `'${type}'`).join(', ');
/** The lines that put a message back to open: "nobody took it" counts again from each (§6). */
const REOPENED: ReadonlySet<TakeLine['kind']> = new Set(['handed-back', 'released', 'expired', 'ended']);
/** The lines that set what state a record is in; an acknowledgement does not. */
const STATE_LINES: ReadonlySet<TakeLine['kind']> = new Set([...REOPENED, 'offered', 'given', 'taken', 'kept', 'done']);

/**
 * The line after which a message was last open to every session again, for "nobody took it" (§8): a hand-back, the
 * person's release, or a take or an offer that lapsed. An offer that ran out counts from when it was made, not from when
 * it ran out (security review of 0.35.0, M5): being offered to one window is no session taking it, so the clock runs on
 * through the offer — and a lane offer its window was never woken for counts as not taken as soon as it lapses.
 */
export function reopenedLine(history: readonly TakeLine[]): TakeLine | undefined {
  const index = history.findLastIndex((line) => REOPENED.has(line.kind));
  if (index < 0) return undefined;
  const line = history[index] as TakeLine;
  if (line.kind !== 'expired') return line;
  for (let before = index - 1; before >= 0; before -= 1) {
    const earlier = history[before] as TakeLine;
    if (earlier.kind === 'offered' || earlier.kind === 'given') return { ...line, at: earlier.at };
    if (STATE_LINES.has(earlier.kind)) break;
  }
  return line;
}

/** When a lane offer still waiting for its window lapses by itself (M5), in milliseconds; never, for any other record. */
function waitingLapse(record: TakeRecord, waitMs: number): number {
  const until = offerWaitsUntil(record, waitMs);
  return until === null ? Number.POSITIVE_INFINITY : Date.parse(until);
}

/** An offer a delivery makes: the message, the window, the rule and delivery it came with, and until when. */
export interface PlannedOffer {
  readonly message: TakeMessage;
  readonly window: TakeWindow;
  readonly by: { readonly rule: string; readonly delivery: string };
  /** Null while the item waits for its window (a lane's); a time once the window was handed it. */
  readonly until: string | null;
}

/** What a session target's dispatcher asks of the offers: an offer planned before its prompt, written after it. */
export interface SessionOfferPort {
  /**
   * The offer this delivery makes to the relay session it is about to post to, or null — none for an event a take is
   * not about, an account that does not ask for takes, or a session the relay names no Claude Code session id for.
   * `handedAt` is when the prompt is posted: the offer lasts fifteen minutes from it.
   */
  planSession(
    deliveryId: string,
    session: { readonly nativeSessionId?: string | undefined; readonly cwd: string },
    handedAt: number,
  ): Promise<PlannedOffer | null>;
  /** Writes a planned offer, after its delivery commits. Never throws. */
  write(offer: PlannedOffer): Promise<boolean>;
  /** A lane item a delivery committed: offered to the lane's bound window while it waits. Never throws. */
  offerLaneItem(deliveryId: string): Promise<void>;
}

/** What the lane service asks when it wakes a window: the offer's time, for the pointer's line, or null. */
export interface LaneOfferPort {
  handedToLane(
    itemId: string,
    window: { readonly sessionId: string | null; readonly activityKey: string | null },
    at: number,
  ): string | null;
}

/** One account's notice in a sweep: how many messages it named. */
export interface TakeSweepNotice {
  readonly accountId: string;
  readonly account: string;
  readonly waited: number;
  readonly needsThePerson: number;
  readonly body: string;
  readonly raised: boolean;
}

export interface TakeSweepReport {
  readonly ended: number;
  readonly expired: number;
  /** Offers whose item no longer waited for their window. */
  readonly offersLapsed: number;
  readonly notices: readonly TakeSweepNotice[];
}

export interface TakeOffersOptions {
  readonly store: EventDatabase;
  readonly takes: Pick<TakeStore, 'offer' | 'handOffer' | 'lapseOffer' | 'lapse' | 'list'>;
  readonly config: Pick<ConfigStore, 'load'>;
  /** Raises the sweep's notices; none is raised without one. */
  readonly notify?: Notifier | undefined;
  readonly now?: (() => number) | undefined;
}

interface LaneEntry {
  readonly message: TakeMessage;
  readonly delivery: string;
  readonly window: { readonly sessionId: string | null; readonly key: string | null };
  /** When the offer lapses by itself if its window is not woken for it first (M5). */
  readonly lapsesAt: number;
}

interface DeliveryMessageRow {
  readonly type: string;
  readonly dedupe_key: string;
  readonly account_id: string;
  readonly rule_id: string;
}

interface LaneItemRow extends DeliveryMessageRow {
  readonly item_id: string;
  readonly item_state: string;
  readonly kept: number;
  readonly expires_at: number;
  readonly arrived_at: number;
  readonly appended_at: number;
  readonly lane: string | null;
}

interface BindingRow {
  readonly session_id: string | null;
  readonly activity_key: string | null;
  readonly folder: string | null;
  readonly client_name: string | null;
  readonly client_version: string | null;
  readonly since: number;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** The message a take would be about, from an event's type and dedupe key — or null for any other event (§4). */
export function takeMessageOfEvent(type: string, dedupeKey: string, accountId: string): TakeMessage | null {
  if (!(TAKEABLE_EVENT_TYPES as readonly string[]).includes(type)) return null;
  const source = parseEventSource(type, dedupeKey);
  if (source === null) return null;
  switch (source.channel) {
    case 'gmail':
      return { channel: 'gmail', accountId, id: source.messageId, thread: null };
    case 'slack':
      return { channel: 'slack', accountId, id: `${source.channelId}/${source.ts}`, thread: null };
    case 'resend':
      return { channel: 'resend', accountId, id: source.emailId, thread: null };
    default:
      return null;
  }
}

/** The words of a sweep's notice: the account and counts, never a sender, a subject or a session (§8). */
export function unclaimedNoticeText(input: {
  readonly account: string;
  readonly waited: number;
  readonly afterMinutes: number;
  readonly needsThePerson: number;
}): string {
  const messages = (count: number) => `${count} ${count === 1 ? 'message' : 'messages'}`;
  const minutes = `${input.afterMinutes} ${input.afterMinutes === 1 ? 'minute' : 'minutes'}`;
  const waited =
    input.waited === 0
      ? ''
      : `${messages(input.waited)} in ${input.account} ${input.waited === 1 ? 'has' : 'have'} waited ${minutes} and no session took ${input.waited === 1 ? 'it' : 'them'}`;
  if (input.needsThePerson === 0) return `${waited}.`;
  const handed = `${input.needsThePerson === 1 ? 'was' : 'were'} handed back as needing you`;
  if (input.waited === 0)
    return `${messages(input.needsThePerson)} in ${input.account} ${handed}, and no session took ${input.needsThePerson === 1 ? 'it' : 'them'}.`;
  return `${waited}, and ${input.needsThePerson} more ${handed}.`;
}

function sameWindow(
  offered: { readonly sessionId: string | null; readonly key: string | null },
  bound: { readonly sessionId: string | null; readonly activityKey: string | null },
): boolean {
  return offered.sessionId === bound.sessionId && offered.key === bound.activityKey;
}

/** The file core's take store keeps a message's record in, by its key (takes design T1). */
function recordFileOf(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

function deliveryOf(record: TakeRecord): string | null {
  const by = record.offer?.by;
  return by === undefined || 'person' in by ? null : by.delivery;
}

export class TakeOffers implements SessionOfferPort, LaneOfferPort {
  readonly #store: EventDatabase;
  readonly #takes: TakeOffersOptions['takes'];
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #notify: Notifier | undefined;
  readonly #now: () => number;
  /** Lane offers written and still waiting for their window's wake, by item id. Rebuilt by `reconcile`. */
  readonly #lane = new Map<string, LaneEntry>();
  /** Each message a notice named, by its key, with the time its clock started: one notice per message (§11). */
  readonly #reminded = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #sweeping: Promise<TakeSweepReport> | undefined;
  #stopped = false;

  constructor(options: TakeOffersOptions) {
    this.#store = options.store;
    this.#takes = options.takes;
    this.#config = options.config;
    this.#notify = options.notify;
    this.#now = options.now ?? Date.now;
  }

  // ── Offers ───────────────────────────────────────────────────────────────────────────────────────────────────

  async planSession(
    deliveryId: string,
    session: { readonly nativeSessionId?: string | undefined; readonly cwd: string },
    handedAt: number,
  ): Promise<PlannedOffer | null> {
    try {
      // "Once the relay names one" (T4): a session it names no Claude Code session id for is offered nothing.
      if (!isClaudeCodeSessionId(session.nativeSessionId)) return null;
      const row = this.#deliveryMessage(deliveryId);
      if (row === null) return null;
      const message = takeMessageOfEvent(row.type, row.dedupe_key, row.account_id);
      if (message === null || !(await this.#required(message.accountId))) return null;
      return {
        message,
        window: { sessionId: session.nativeSessionId, key: null, parent: null, folder: session.cwd, client: null },
        by: { rule: row.rule_id, delivery: deliveryId },
        until: iso(handedAt + TAKE_OFFER_MS),
      };
    } catch {
      return null;
    }
  }

  async write(offer: PlannedOffer): Promise<boolean> {
    try {
      const written = await this.#takes.offer(offer.message, offer.window, offer.by, offer.until);
      return written.changed || (written.record !== null && deliveryOf(written.record) === offer.by.delivery);
    } catch {
      // Best-effort (§8): the delivery stands, offered or not.
      return false;
    }
  }

  async offerLaneItem(deliveryId: string): Promise<void> {
    try {
      const found = this.#laneItem(deliveryId);
      if (found === null) return;
      const { row, binding, message } = found;
      const config = await this.#config.load();
      if (!takingFor(config, message.accountId).required) return;
      const window: TakeWindow = {
        sessionId: binding.session_id,
        key: binding.activity_key,
        parent: null,
        folder: binding.folder,
        client:
          binding.client_name === null
            ? null
            : {
                name: binding.client_name,
                ...(binding.client_version === null ? {} : { version: binding.client_version }),
              },
      };
      const by = { rule: row.rule_id, delivery: deliveryId };
      const written = await this.#takes.offer(message, window, by, null);
      // Only this delivery's offer, still waiting for its window, waits for the wake.
      const record = written.record;
      if (record?.state !== 'offered' || record.offer?.until !== null || deliveryOf(record) !== deliveryId) return;
      this.#afterLaneOffer(
        row.item_id,
        {
          message,
          delivery: deliveryId,
          window: { sessionId: binding.session_id, key: binding.activity_key },
          lapsesAt: waitingLapse(record, offerWaitMs(config, message.accountId)),
        },
        row.appended_at,
      );
    } catch {
      // Best-effort (§8).
    }
  }

  handedToLane(
    itemId: string,
    window: { readonly sessionId: string | null; readonly activityKey: string | null },
    at: number,
  ): string | null {
    const entry = this.#lane.get(itemId);
    if (entry === undefined || !sameWindow(entry.window, window)) return null;
    this.#lane.delete(itemId);
    // M5: woken only after the offer lapsed by itself — nothing is offered any more, and the pointer names nothing.
    if (at >= entry.lapsesAt) return null;
    const until = iso(at + TAKE_OFFER_MS);
    void this.#takes.handOffer(entry.message, entry.delivery, until).catch(() => undefined);
    return until;
  }

  /**
   * A lane offer just written: its window may have been woken for the item while it was written — the wake then named
   * no offer — so its fifteen minutes start from that wake; otherwise the next wake starts them. A wake only after the
   * offer lapsed by itself (M5) starts nothing.
   */
  #afterLaneOffer(itemId: string, entry: LaneEntry, offeredAfter: number): void {
    const woken = this.#firstWake(itemId, offeredAfter);
    if (woken === null) {
      this.#lane.set(itemId, entry);
      return;
    }
    this.#lane.delete(itemId);
    if (woken >= entry.lapsesAt) return;
    void this.#takes.handOffer(entry.message, entry.delivery, iso(woken + TAKE_OFFER_MS)).catch(() => undefined);
  }

  #firstWake(itemId: string, since: number): number | null {
    const row = this.#store.database
      .prepare("SELECT MIN(at) AS at FROM queue_item_history WHERE item_id = ? AND kind = 'woken' AND at >= ?")
      .get(itemId, since) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  async #required(accountId: string): Promise<boolean> {
    return takingFor(await this.#config.load(), accountId).required;
  }

  #deliveryMessage(deliveryId: string): DeliveryMessageRow | null {
    return (
      (this.#store.database
        .prepare(
          `SELECT i.type, i.dedupe_key, i.account_id, d.rule_id
             FROM deliveries d
             JOIN decisions decision ON decision.id = d.decision_id
             JOIN ingest i ON i.event_id = decision.event_id
            WHERE d.id = ?`,
        )
        .get(deliveryId) as DeliveryMessageRow | undefined) ?? null
    );
  }

  /** A delivery's lane item, its message and the lane's binding, when the item is one that binding's window is woken for. */
  #laneItem(
    deliveryId: string,
  ): { readonly row: LaneItemRow; readonly binding: BindingRow; readonly message: TakeMessage } | null {
    const row = this.#store.database
      .prepare(
        `SELECT qi.id AS item_id, qi.state AS item_state, (qi.encrypted_record IS NOT NULL) AS kept, qi.expires_at,
                qi.arrived_at, qi.appended_at, i.type, i.dedupe_key, qi.account_id, qi.rule_id,
                ${sqlTargetLane('tv.document')} AS lane
           FROM queue_items qi
           JOIN ingest i ON i.event_id = qi.event_id
           LEFT JOIN target_versions tv ON tv.target_id = qi.target_id AND tv.version = qi.target_version
          WHERE qi.delivery_id = ?
          ORDER BY qi.appended_at, qi.id LIMIT 1`,
      )
      .get(deliveryId) as LaneItemRow | undefined;
    if (row === undefined || row.lane === null) return null;
    const binding = this.#binding(row.lane);
    // The lane's window is woken only for items that arrived after it was bound (routing B3).
    if (binding === null || row.arrived_at <= binding.since || row.appended_at <= binding.since) return null;
    const message = takeMessageOfEvent(row.type, row.dedupe_key, row.account_id);
    return message === null ? null : { row, binding, message };
  }

  #binding(lane: string): BindingRow | null {
    return (
      (this.#store.database
        .prepare(
          'SELECT session_id, activity_key, folder, client_name, client_version, since FROM lane_bindings WHERE lane = ?',
        )
        .get(lane) as BindingRow | undefined) ?? null
    );
  }

  /**
   * Every delivery's offer still waiting for its window, looked at again: one whose item no longer waits for it lapses;
   * one whose window was woken for its item starts its fifteen minutes from that wake; the rest wait for their wake.
   * Run at start and by every sweep, so a restart loses no offer's clock. Returns how many lapsed.
   */
  async reconcile(records?: readonly TakeRecord[]): Promise<number> {
    let lapsed = 0;
    const listed = records ?? (await this.#records());
    const config = await this.#config.load().catch(() => null);
    for (const record of listed) {
      const delivery = deliveryOf(record);
      // An entry whose offer was since taken, handed back, released or handed over is not waiting any more.
      for (const [itemId, entry] of this.#lane)
        if (entry.message.id === record.message.id && entry.message.accountId === record.message.accountId)
          if (record.state !== 'offered' || record.offer?.until !== null || delivery !== entry.delivery)
            this.#lane.delete(itemId);
      if (record.state !== 'offered' || record.offer === null || record.offer.until !== null || delivery === null)
        continue;
      const offer = record.offer;
      const found = this.#laneItem(delivery);
      const waits =
        found !== null &&
        found.row.item_state === 'open' &&
        found.row.kept === 1 &&
        found.row.expires_at > this.#now() &&
        sameWindow(offer.to, { sessionId: found.binding.session_id, activityKey: found.binding.activity_key });
      if (found === null || !waits) {
        const result = await this.#takes.lapseOffer(record.message, delivery).catch(() => null);
        if (result?.changed === true) lapsed += 1;
        for (const [itemId, entry] of this.#lane) if (entry.delivery === delivery) this.#lane.delete(itemId);
        continue;
      }
      const offeredAt = Date.parse(record.history.findLast((line) => line.kind === 'offered')?.at ?? '');
      this.#afterLaneOffer(
        found.row.item_id,
        {
          message: record.message,
          delivery,
          window: { sessionId: offer.to.sessionId, key: offer.to.key },
          lapsesAt: waitingLapse(
            record,
            config === null ? TAKE_OFFER_WAIT_MS : offerWaitMs(config, record.message.accountId),
          ),
        },
        Number.isFinite(offeredAt) ? Math.min(offeredAt, found.row.appended_at) : found.row.appended_at,
      );
    }
    return lapsed;
  }

  async #records(): Promise<TakeRecord[]> {
    return (await this.#listed()).records;
  }

  /** Every record the store holds, and the files it cannot read — each counts as held by another session. */
  async #listed(): Promise<{ readonly records: TakeRecord[]; readonly unreadable: ReadonlySet<string> }> {
    const records: TakeRecord[] = [];
    const unreadable = new Set<string>();
    for (const entry of await this.#takes.list()) {
      if ('record' in entry) records.push(entry.record);
      else unreadable.add(`${entry.unreadable.accountId}/${entry.unreadable.file}`);
    }
    return { records, unreadable };
  }

  // ── The sweep ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Runs the sweep every `intervalMs`, until `stop`. */
  start(intervalMs: number = TAKE_SWEEP_INTERVAL_MS): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.#timer.unref?.();
  }

  /** Stops the timer, and waits for a sweep in flight: call it before the event database closes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#sweeping?.catch(() => undefined);
  }

  /** One sweep (§8); one at a time, and never throws. */
  sweep(): Promise<TakeSweepReport> {
    if (this.#sweeping !== undefined) return this.#sweeping;
    const running = this.#sweep()
      .catch((): TakeSweepReport => ({ ended: 0, expired: 0, offersLapsed: 0, notices: [] }))
      .finally(() => {
        this.#sweeping = undefined;
      });
    this.#sweeping = running;
    return running;
  }

  async #sweep(): Promise<TakeSweepReport> {
    // T3: every lapse written down first, at the time it happened, so the clocks below start from it.
    const lapsed = await this.#takes.lapse().catch(() => ({ ended: 0, expired: 0 }));
    const listed = await this.#listed();
    const offersLapsed = await this.reconcile(listed.records);
    const notices = this.#stopped ? [] : await this.#unclaimed(offersLapsed > 0 ? await this.#listed() : listed);
    return { ...lapsed, offersLapsed, notices };
  }

  /** §8: the messages nobody took, per account with taking required, and one notice each. */
  async #unclaimed(listed: {
    readonly records: readonly TakeRecord[];
    readonly unreadable: ReadonlySet<string>;
  }): Promise<TakeSweepNotice[]> {
    const settings = readTakingSettings(await this.#config.load());
    const now = this.#now();
    const collecting =
      (
        this.#store.database.prepare('SELECT enabled FROM event_settings WHERE singleton = 1').get() as
          | { enabled: number }
          | undefined
      )?.enabled === 1;
    const byMessage = new Map(
      listed.records.map((record) => [
        `${record.message.channel}:${record.message.accountId}:${record.message.id}`,
        record,
      ]),
    );
    const notices: TakeSweepNotice[] = [];
    const seen = new Set<string>();
    for (const account of settings.accounts) {
      if (!account.required) continue;
      const afterMs = account.unclaimed.afterMinutes * 60_000;
      const events = this.#store.database
        .prepare(
          `SELECT i.type, i.dedupe_key, i.observed_at
             FROM ingest i
            WHERE i.account_id = ? AND i.type IN (${TAKEABLE_SQL})
              AND EXISTS (
                SELECT 1 FROM decisions decision
                  JOIN deliveries d ON d.decision_id = decision.id
                 WHERE decision.event_id = i.event_id AND d.state = 'delivered' AND d.target_kind IN ('queue', 'session'))
            ORDER BY i.observed_at, i.event_id`,
        )
        .all(account.accountId) as Array<{ type: string; dedupe_key: string; observed_at: number }>;
      let waited = 0;
      let needsThePerson = 0;
      const due: Array<{ key: string; clock: number }> = [];
      for (const event of events) {
        const message = takeMessageOfEvent(event.type, event.dedupe_key, account.accountId);
        if (message === null || message.channel !== account.channel) continue;
        const key = `${message.channel}:${message.accountId}:${message.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const record = byMessage.get(key);
        // Taken, done, kept by the person or offered: somebody has it, or will. A record that cannot be read counts
        // as held, as the store reads it.
        if (record !== undefined && record.state !== 'open') continue;
        if (record === undefined && listed.unreadable.has(`${message.accountId}/${recordFileOf(key)}`)) continue;
        const reopened = record === undefined ? undefined : reopenedLine(record.history);
        const reopenedAt = reopened === undefined ? Number.NaN : Date.parse(reopened.at);
        const clock = Number.isFinite(reopenedAt) ? Math.max(event.observed_at, reopenedAt) : event.observed_at;
        if (clock < now - TAKE_SWEEP_LOOKBACK_MS) continue;
        const needs = reopened?.kind === 'handed-back' && reopened.reason === 'needs-the-person';
        if (!needs && now - clock < afterMs) continue;
        if (this.#reminded.get(key) === clock) continue;
        due.push({ key, clock });
        if (needs) needsThePerson += 1;
        else waited += 1;
      }
      if (due.length === 0 || !account.unclaimed.notify || !collecting || this.#notify === undefined) continue;
      const body = unclaimedNoticeText({
        account: account.account,
        waited,
        afterMinutes: account.unclaimed.afterMinutes,
        needsThePerson,
      });
      for (const { key, clock } of due) this.#reminded.set(key, clock);
      const raised = await this.#notify({ title: NOTICE_TITLE, body }).catch(() => ({ raised: false as const }));
      notices.push({
        accountId: account.accountId,
        account: account.account,
        waited,
        needsThePerson,
        body,
        raised: raised.raised,
      });
    }
    // A message whose clock is past the lookback is not reminded of again; its entry goes.
    for (const [key, clock] of this.#reminded) if (clock < now - TAKE_SWEEP_LOOKBACK_MS) this.#reminded.delete(key);
    return notices;
  }
}
