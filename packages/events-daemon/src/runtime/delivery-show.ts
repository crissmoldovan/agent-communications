import { CommsError } from '@agentcomms/core';
import type { EventDatabase } from '../store/database.ts';
import { type EventRecordCipher, RecordStorageError } from '../store/records.ts';
import { type DeliveryListRowV1, type DeliveryTargetKind, deliveryRow } from './delivery-rows.ts';
import { type EventSource, parseEventSource } from './event-source.ts';

/**
 * `delivery show <id>` (owner feedback 0.32.0, §3.5): one delivery as the person reads it, in the terminal or the app.
 * It is the person's, never an agent's: the CLI refuses inside an MCP server's process and no tool reaches this wire.
 * Everything here is content-free — ids, times, kinds and the judge's yes or no — and a webhook shows only its host.
 *
 * Earlier tries are not kept one by one: the row's `attempts` and its last answer are all there is.
 */

/** The judge's part of the decision: its kind, and its answer while the decision's metadata is kept. */
export interface DeliveryJudgeV1 {
  readonly kind: string;
  readonly answer: 'yes' | 'no' | null;
  readonly confidence: number | null;
  readonly calibrated: boolean | null;
}

export interface DeliveryShowResultV1 {
  /** The delivery's `deliveries list` row. */
  readonly delivery: DeliveryListRowV1;
  /**
   * The rule's decision. The event service stores no decision time of its own: `decidedAt` is when a judge's answer
   * settled (in the decision's own transaction) or when the decision was held, and null for a rule without a judge,
   * which decides as the event is observed (`event.observedAt`).
   */
  readonly decision: {
    readonly outcome: string;
    readonly decidedAt: number | null;
    readonly judge: DeliveryJudgeV1 | null;
  } | null;
  readonly event: {
    readonly eventId: string;
    readonly type: string;
    readonly accountId: string;
    readonly occurredAt: number;
    readonly observedAt: number;
    readonly source: EventSource | null;
  } | null;
  readonly target: {
    readonly kind: DeliveryTargetKind;
    readonly id: string;
    readonly version: number;
    /** A webhook's host, never its path, query or a secret URL's digest. */
    readonly host?: string;
    /** A queue target's lane, when it is one. */
    readonly lane?: string;
  };
  /** A dry run's log entry: when it goes (24 hours at most), or null once it has gone. Null for every other target. */
  readonly dryRun: { readonly expiresAt: number | null } | null;
}

interface DecisionRow {
  readonly outcome: string;
  readonly event_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly hold_created_at: number | null;
  readonly metadata_state: string;
  readonly encrypted_record: Uint8Array | null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function storedDocument(database: EventDatabase['database'], sql: string, id: string, version: number) {
  const row = database.prepare(sql).get(id, version) as { document: string } | undefined;
  if (row === undefined) return null;
  try {
    return record(JSON.parse(row.document));
  } catch {
    return null;
  }
}

/** A webhook URL's host: from the plain URL the person approved, or from a secret URL's stored authority. */
function webhookHost(document: Readonly<Record<string, unknown>> | null): string | undefined {
  const url = record(document?.url);
  if (url?.kind === 'secret') return typeof url.host === 'string' && url.host.length > 0 ? url.host : undefined;
  if (url?.kind !== 'plain' || typeof url.value !== 'string') return undefined;
  try {
    const host = new URL(url.value).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

export class DeliveryReader {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly #now: () => number;

  constructor(input: {
    readonly store: EventDatabase;
    readonly cipher: Pick<EventRecordCipher, 'decrypt'>;
    readonly now?: (() => number) | undefined;
  }) {
    this.#store = input.store;
    this.#cipher = input.cipher;
    this.#now = input.now ?? Date.now;
  }

  async show(deliveryId: string): Promise<DeliveryShowResultV1> {
    const database = this.#store.database;
    const delivery = deliveryRow(database, deliveryId);
    if (delivery === undefined) throw new CommsError('NOT_FOUND', 'the delivery does not exist');
    const rule = storedDocument(
      database,
      'SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?',
      delivery.ruleId,
      delivery.ruleVersion,
    );
    const target = storedDocument(
      database,
      'SELECT document FROM target_versions WHERE target_id = ? AND version = ?',
      delivery.targetId,
      delivery.targetVersion,
    );
    return {
      delivery,
      decision: await this.#decision(delivery.decisionId, rule),
      event: this.#event(delivery.eventId),
      target: this.#target(delivery, target),
      dryRun: delivery.targetKind === 'dry-run' ? { expiresAt: this.#dryRunExpiry(delivery.deliveryId) } : null,
    };
  }

  async #decision(
    decisionId: string,
    rule: Readonly<Record<string, unknown>> | null,
  ): Promise<DeliveryShowResultV1['decision']> {
    const row = this.#store.database
      .prepare(
        `SELECT outcome, event_id, rule_id, rule_version, hold_created_at, metadata_state, encrypted_record
           FROM decisions WHERE id = ?`,
      )
      .get(decisionId) as DecisionRow | undefined;
    if (row === undefined) return null;
    const settled = this.#store.database
      .prepare(
        `SELECT max(settled_at) AS settled_at FROM judge_budget_reservations
          WHERE event_id = ? AND rule_id = ? AND rule_version = ? AND state = 'settled'`,
      )
      .get(row.event_id, row.rule_id, row.rule_version) as { settled_at: number | null } | undefined;
    return {
      outcome: row.outcome,
      decidedAt: settled?.settled_at ?? row.hold_created_at ?? null,
      judge: await this.#judge(decisionId, row, rule),
    };
  }

  /** The judge's answer comes from the decision's metadata while it lives, as the queue reads it (Q3). */
  async #judge(
    decisionId: string,
    row: DecisionRow,
    rule: Readonly<Record<string, unknown>> | null,
  ): Promise<DeliveryJudgeV1 | null> {
    const judge = record(record(rule?.agentic)?.judge);
    if (judge === null) return null;
    const kind = typeof judge.kind === 'string' ? judge.kind : 'judge';
    const unknown: DeliveryJudgeV1 = { kind, answer: null, confidence: null, calibrated: null };
    if (row.metadata_state === 'purged' || row.encrypted_record === null) return unknown;
    let metadata: Readonly<Record<string, unknown>> | null;
    try {
      metadata = record(
        JSON.parse(
          (
            await this.#cipher.decrypt(
              { table: 'decisions', column: 'encryptedRecord', key: [{ type: 'text', value: decisionId }] },
              row.encrypted_record,
            )
          ).toString('utf8'),
        ),
      );
    } catch (error) {
      if (error instanceof RecordStorageError || error instanceof SyntaxError) return unknown;
      throw error;
    }
    const value = metadata?.value;
    const threshold = metadata?.threshold;
    if (typeof value !== 'number' || !Number.isFinite(value) || typeof threshold !== 'number') return unknown;
    return {
      kind,
      answer: value >= threshold ? 'yes' : 'no',
      confidence: value,
      calibrated: metadata?.valueLabel === 'probability',
    };
  }

  #event(eventId: string | null): DeliveryShowResultV1['event'] {
    if (eventId === null) return null;
    const row = this.#store.database
      .prepare('SELECT event_id, type, account_id, dedupe_key, occurred_at, observed_at FROM ingest WHERE event_id = ?')
      .get(eventId) as
      | {
          event_id: string;
          type: string;
          account_id: string;
          dedupe_key: string;
          occurred_at: number;
          observed_at: number;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      eventId: row.event_id,
      type: row.type,
      accountId: row.account_id,
      occurredAt: row.occurred_at,
      observedAt: row.observed_at,
      source: parseEventSource(row.type, row.dedupe_key),
    };
  }

  #target(
    delivery: DeliveryListRowV1,
    document: Readonly<Record<string, unknown>> | null,
  ): DeliveryShowResultV1['target'] {
    const base = { kind: delivery.targetKind, id: delivery.targetId, version: delivery.targetVersion };
    if (delivery.targetKind === 'webhook') {
      const host = webhookHost(document);
      return host === undefined ? base : { ...base, host };
    }
    const lane = record(document?.lane)?.name;
    if (delivery.targetKind === 'queue' && typeof lane === 'string') return { ...base, lane };
    // A session found by a lane (0.33.0 §3.5) carries that lane: its fallback items are the lane's.
    const sessionLane = record(document?.find)?.lane;
    if (delivery.targetKind === 'session' && typeof sessionLane === 'string') return { ...base, lane: sessionLane };
    return base;
  }

  #dryRunExpiry(deliveryId: string): number | null {
    const row = this.#store.database
      .prepare('SELECT expires_at FROM dryrun_log WHERE delivery_id = ? AND expires_at > ?')
      .get(deliveryId, this.#now()) as { expires_at: number } | undefined;
    return row?.expires_at ?? null;
  }
}
