import { CommsError } from '@agentcomms/core';
import {
  isEventId,
  isMessagesCursor,
  MESSAGES_LIST_DEFAULT_LIMIT,
  MESSAGES_LIST_DEFAULT_SPAN_MS,
  MESSAGES_LIST_MAX_LIMIT,
  type MessageDecisionOutcome,
  type MessageDecisionV1,
  type MessageDeliveryState,
  type MessageDeliveryV1,
  type MessageEntryV1,
  type MessageJudgeV1,
  type MessageKeptV1,
  type MessageQueueItemV1,
  type MessageShowResultV1,
  type MessagesListResultV1,
  type MessageTargetKind,
  messagesCursor,
  parseMessagesCursor,
} from '../domain/messages.ts';
import type { QueueState } from '../domain/queue-target.ts';
import type { EventDatabase } from '../store/database.ts';
import { type EventRecordCipher, RecordStorageError } from '../store/records.ts';
import { parseEventSource } from './event-source.ts';
import { EventExpiry } from './expiry.ts';
import type { QueueStore } from './queue.ts';
import { latestQueueHistory, type QueueHistoryLineV1, queueItemHistory } from './queue-history.ts';

/**
 * `messages list` and `message show` (0.32.0 spec §3.6): one owner read that joins what the event service keeps of each
 * message it observed — its ingest row, each rule's decision, each delivery, and the queue item it became — by event id.
 *
 * - **The person's.** The CLI refuses both inside an MCP server's process, and no MCP tool reaches them (§4).
 * - **Ids, times and closed words.** A source is the ids its dedupe key holds; a judge is its kind, answer and number,
 *   read from the decision while its metadata is kept (action queue Q3). The one exception is `kept`: the sender and
 *   subject a `show: summary` queue item keeps, read through the queue's own fences and enveloped as `queue show` gives
 *   them.
 * - **Newest first,** by the time the event service observed each event and then its id, so a page that ends inside one
 *   millisecond's events loses none: `next` is where it ended, for `--before`.
 */

export interface MessagesQuery {
  readonly since: number;
  readonly before?: { readonly observedAt: number; readonly eventId?: string } | undefined;
  readonly limit: number;
}

function usage(message: string): never {
  throw new CommsError('USAGE', message);
}

function isMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The one parser for `messages list`'s arguments, used by the CLI before it asks and by the owner when it answers. */
export function parseMessagesQuery(args: Readonly<Record<string, unknown>>, now: number): MessagesQuery {
  for (const key of Object.keys(args))
    if (!['since', 'before', 'limit'].includes(key)) usage(`messages list takes no ${key.slice(0, 40)}`);
  const since = args.since ?? Math.max(0, now - MESSAGES_LIST_DEFAULT_SPAN_MS);
  if (!isMilliseconds(since)) usage('--since is a time in whole milliseconds since 1970');
  let before: MessagesQuery['before'];
  if (args.before !== undefined) {
    if (isMilliseconds(args.before)) before = { observedAt: args.before };
    else if (isMessagesCursor(args.before)) before = parseMessagesCursor(args.before) ?? undefined;
    else usage('--before is a time in whole milliseconds since 1970, or the next a page gave');
  }
  const limit = args.limit ?? MESSAGES_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MESSAGES_LIST_MAX_LIMIT)
    usage(`--limit is a whole number from 1 to ${MESSAGES_LIST_MAX_LIMIT}`);
  return { since: since as number, ...(before === undefined ? {} : { before }), limit: limit as number };
}

/** An event id, or the contract's bad-argument refusal (64) before anything is read. */
export function requireEventId(value: unknown): string {
  if (!isEventId(value)) usage('an event id is 32 lowercase hexadecimal characters');
  return value;
}

interface IngestRow {
  readonly event_id: string;
  readonly type: string;
  readonly account_id: string;
  readonly dedupe_key: string;
  readonly occurred_at: number;
  readonly observed_at: number;
}

interface DecisionRow {
  readonly id: string;
  readonly event_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly outcome: MessageDecisionOutcome;
  readonly metadata_state: string;
  readonly encrypted_record: Uint8Array | null;
  readonly judge_kind: string | null;
}

interface DeliveryRow {
  readonly id: string;
  readonly event_id: string;
  readonly target_kind: MessageTargetKind;
  readonly target_id: string;
  readonly state: MessageDeliveryState;
  readonly lane: string | null;
}

interface ItemRow {
  readonly id: string;
  readonly event_id: string;
  readonly state: QueueState;
  readonly state_at: number;
  readonly lane: string | null;
}

const INGEST_COLUMNS = 'event_id, type, account_id, dedupe_key, occurred_at, observed_at';

export interface MessagesStoreOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly queue: Pick<QueueStore, 'keptSummaries'>;
  readonly expiry?: EventExpiry | undefined;
  readonly now?: (() => number) | undefined;
}

export class MessagesStore {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly #queue: Pick<QueueStore, 'keptSummaries'>;
  readonly #expiry: EventExpiry;
  readonly #now: () => number;

  constructor(options: MessagesStoreOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#queue = options.queue;
    this.#now = options.now ?? Date.now;
    this.#expiry = options.expiry ?? new EventExpiry(options.store, this.#now);
  }

  /** `messages list`: the events observed since `since` (30 days back by default), newest first, `limit` a page. */
  async list(args: Readonly<Record<string, unknown>> = {}): Promise<MessagesListResultV1> {
    const query = parseMessagesQuery(args, this.#now());
    this.#expiry.sweep();
    const where = ['observed_at >= ?'];
    const values: Array<string | number> = [query.since];
    if (query.before !== undefined) {
      if (query.before.eventId === undefined) {
        where.push('observed_at < ?');
        values.push(query.before.observedAt);
      } else {
        where.push('(observed_at < ? OR (observed_at = ? AND event_id < ?))');
        values.push(query.before.observedAt, query.before.observedAt, query.before.eventId);
      }
    }
    const rows = this.#store.database
      .prepare(
        `SELECT ${INGEST_COLUMNS} FROM ingest WHERE ${where.join(' AND ')}
          ORDER BY observed_at DESC, event_id DESC LIMIT ?`,
      )
      .all(...values, query.limit + 1) as unknown as IngestRow[];
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const messages = await this.#entries(page, 'latest');
    return {
      messages,
      next: rows.length > query.limit && last !== undefined ? messagesCursor(last.observed_at, last.event_id) : null,
    };
  }

  /** `message show <eventId>`: one message's entry, its queue item with every line of its history. */
  async show(eventId: unknown): Promise<MessageShowResultV1> {
    const id = requireEventId(eventId);
    this.#expiry.sweep();
    const row = this.#store.database.prepare(`SELECT ${INGEST_COLUMNS} FROM ingest WHERE event_id = ?`).get(id) as
      | IngestRow
      | undefined;
    if (row === undefined)
      throw new CommsError('NOT_FOUND', 'the event service has observed no message with that event id', {
        hint: 'messages list gives every message it has observed, by event id.',
      });
    const [message] = await this.#entries([row], 'all');
    return { message: message as MessageEntryV1 };
  }

  async #entries(rows: readonly IngestRow[], history: 'latest' | 'all'): Promise<MessageEntryV1[]> {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((row) => row.event_id));
    const database = this.#store.database;
    const decisions = database
      .prepare(
        `SELECT d.id, d.event_id, d.rule_id, d.rule_version, d.outcome, d.metadata_state, d.encrypted_record,
                json_extract(rv.document, '$.agentic.judge.kind') AS judge_kind
           FROM decisions d
           LEFT JOIN rule_versions rv ON rv.rule_id = d.rule_id AND rv.version = d.rule_version
          WHERE d.event_id IN (SELECT value FROM json_each(?))
          ORDER BY d.event_id, d.rule_id, d.rule_version, d.id`,
      )
      .all(ids) as unknown as DecisionRow[];
    const deliveries = database
      .prepare(
        `SELECT del.id, d.event_id, del.target_kind, del.target_id, del.state,
                CASE WHEN del.target_kind = 'queue' THEN json_extract(tv.document, '$.lane.name') END AS lane
           FROM deliveries del
           JOIN decisions d ON d.id = del.decision_id
           LEFT JOIN target_versions tv ON tv.target_id = del.target_id AND tv.version = del.target_version
          WHERE d.event_id IN (SELECT value FROM json_each(?))
          ORDER BY d.event_id, del.rule_id, del.rule_version, del.target_id, del.id`,
      )
      .all(ids) as unknown as DeliveryRow[];
    // An event's queue item is the first its deliveries made: one per event in all but a rule set that queues one
    // message twice.
    const items = database
      .prepare(
        `SELECT id, event_id, state, state_at, lane FROM (
           SELECT qi.id, qi.event_id, qi.state, qi.state_at,
                  json_extract(tv.document, '$.lane.name') AS lane,
                  ROW_NUMBER() OVER (PARTITION BY qi.event_id ORDER BY qi.appended_at, qi.id) AS rank
             FROM queue_items qi
             LEFT JOIN target_versions tv ON tv.target_id = qi.target_id AND tv.version = qi.target_version
            WHERE qi.event_id IN (SELECT value FROM json_each(?))
         ) WHERE rank = 1`,
      )
      .all(ids) as unknown as ItemRow[];
    const itemIds = items.map((item) => item.id);
    const lines: ReadonlyMap<string, readonly QueueHistoryLineV1[]> =
      history === 'all'
        ? new Map(itemIds.map((itemId) => [itemId, queueItemHistory(database, itemId)]))
        : latestQueueHistory(database, itemIds);
    const kept = await this.#queue.keptSummaries(itemIds);
    const judges = new Map<string, MessageJudgeV1 | null>();
    for (const decision of decisions) judges.set(decision.id, await this.#judge(decision));
    return rows.map((row) => {
      const item = items.find((entry) => entry.event_id === row.event_id);
      const queueItem: MessageQueueItemV1 | null =
        item === undefined
          ? null
          : {
              itemId: item.id,
              state: item.state,
              stateAt: item.state_at,
              lane: item.lane ?? null,
              history: lines.get(item.id) ?? [],
            };
      const summary: MessageKeptV1 | null = item === undefined ? null : (kept.get(item.id) ?? null);
      return {
        eventId: row.event_id,
        type: row.type,
        channel: row.type.split('.')[0] as string,
        accountId: row.account_id,
        occurredAt: row.occurred_at,
        observedAt: row.observed_at,
        source: parseEventSource(row.type, row.dedupe_key),
        decisions: decisions
          .filter((decision) => decision.event_id === row.event_id)
          .map(
            (decision): MessageDecisionV1 => ({
              ruleId: decision.rule_id,
              ruleVersion: decision.rule_version,
              outcome: decision.outcome,
              judge: judges.get(decision.id) ?? null,
            }),
          ),
        deliveries: deliveries
          .filter((delivery) => delivery.event_id === row.event_id)
          .map(
            (delivery): MessageDeliveryV1 => ({
              deliveryId: delivery.id,
              targetKind: delivery.target_kind,
              targetId: delivery.target_id,
              lane: delivery.lane ?? null,
              state: delivery.state,
            }),
          ),
        queueItem,
        kept: summary,
      };
    });
  }

  /** Q3: the judge's answer from the decision while its metadata is kept; null with no judge, or none kept. */
  async #judge(decision: DecisionRow): Promise<MessageJudgeV1 | null> {
    if (decision.judge_kind === null || decision.metadata_state === 'purged' || decision.encrypted_record === null)
      return null;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(
        (
          await this.#cipher.decrypt(
            { table: 'decisions', column: 'encryptedRecord', key: [{ type: 'text', value: decision.id }] },
            decision.encrypted_record,
          )
        ).toString('utf8'),
      ) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RecordStorageError || error instanceof SyntaxError) return null;
      throw error;
    }
    const { value, threshold } = metadata;
    if (typeof value !== 'number' || !Number.isFinite(value) || typeof threshold !== 'number') return null;
    return {
      kind: decision.judge_kind,
      answer: value >= threshold ? 'yes' : 'no',
      confidence: value,
      calibrated: metadata.valueLabel === 'probability',
    };
  }
}
