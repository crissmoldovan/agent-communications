import type { ApprovalStore, ConfigStore } from '@agentcomms/core';
import type { EventDatabase } from '../store/database.ts';
import type { EncryptedRecordLocation, EventRecordCipher } from '../store/records.ts';
import { assertLiveEventAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import { assertEventDisclosable, type EventDisclosure, eventDisclosureIsCurrent } from './events/event-fence.ts';
import { PassThroughSseFrameVisibilityGate, type SseFrameVisibilityGate } from './phase-d-whatsapp-seam.ts';
import { hasLiveSseLineage, type SealedSseFrameWrite, streamLocation, writeLiveSseFrame } from './sse-dispatcher.ts';

/** Replay has its own writer entry point so Last-Event-ID frames cannot bypass the same synchronous D visibility seam. */
export async function writeReplaySseFrame(input: SealedSseFrameWrite): Promise<boolean> {
  if (input.whatsappMessageId === null) {
    input.writeFrame(input.frame);
    return true;
  }
  if (!input.hasConcreteWhatsAppVisibilityFence) return false;
  let wrote = false;
  await input.visibilityGate.withCurrentSseFrameVisibility(
    { accountId: input.accountId, whatsappMessageId: input.whatsappMessageId },
    input.recheck ?? (async () => {}),
    () => {
      input.writeFrame(input.frame);
      wrote = true;
    },
  );
  return wrote;
}

/** One subscriber's frame of a raised workflow event (0.36.0, W31): sealed as this subscriber may see it. */
interface EventStreamLogRow {
  readonly id: string;
  readonly event_id: string;
  readonly subscriber_id: string;
  readonly subscriber_version: number;
  readonly encrypted_record: Uint8Array;
  readonly delivered_at: number;
  readonly expires_at: number;
}

/** The sealed location of one subscriber's event frame (§4.3). */
export function eventStreamLocation(id: string): EncryptedRecordLocation {
  return { table: 'event_stream_log', column: 'encryptedRecord', key: [{ type: 'text', value: id }] };
}

/** An event's SSE frame (W31): `id: <event id>`, `event: <type>`, `data: <the CloudEvent>`. */
export function eventSseFrame(eventId: string, type: string, text: string): string {
  return `id: ${eventId}\nevent: ${type}\ndata: ${text}\n\n`;
}

interface StreamLogRow {
  readonly id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly subscriber_id: string;
  readonly subscriber_version: number;
  readonly account_id: string;
  readonly whatsapp_message_id: string | null;
  readonly encrypted_record: Uint8Array;
  readonly delivered_at: number;
  readonly expires_at: number;
  readonly switch_generation: number;
}

export interface StreamReplayOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly now?: (() => number) | undefined;
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  readonly visibilityGate?: SseFrameVisibilityGate | undefined;
  readonly hasConcreteWhatsAppVisibilityFence?: boolean | undefined;
}

/** Last-Event-ID replay boundary. It reads content only after the current version/account fence and repeats it after decryption. */
export class StreamReplay {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #now: () => number;
  readonly #fence: (request: ActiveDisclosableRequest) => Promise<unknown>;
  readonly #visibilityGate: SseFrameVisibilityGate;
  readonly #hasConcreteWhatsAppVisibilityFence: boolean;

  constructor(options: StreamReplayOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
    this.#fence = options.fence ?? assertDisclosable;
    this.#visibilityGate = options.visibilityGate ?? new PassThroughSseFrameVisibilityGate();
    this.#hasConcreteWhatsAppVisibilityFence = options.hasConcreteWhatsAppVisibilityFence ?? false;
  }

  /** The listener delegates its live writer here so replay and live frames share the same retained-content authority. */
  async writeLive(input: {
    readonly streamLogId: string;
    readonly frame: string;
    readonly isStreamCurrent: () => boolean;
    readonly writeFrame: (frame: string) => void;
  }): Promise<boolean> {
    const row = this.#row(input.streamLogId);
    if (row === undefined) return false;
    try {
      await this.#fence(this.#fenceRequest(row));
      await assertLiveEventAccount(this.#config, {
        source: sourceOfStreamRow(this.#store, row),
        accountId: row.account_id,
      });
    } catch (error) {
      if (isRemovedAccountError(error))
        this.#store.immediate(() =>
          purgeRemovedAccountWork(
            this.#store.database,
            {
              source: sourceOfStreamRow(this.#store, row),
              accountId: row.account_id,
            },
            this.#now(),
          ),
        );
      return false;
    }
    let written = false;
    let accepted: boolean;
    let recheckStarted = false;
    let recheckCompleted = false;
    try {
      accepted = await writeLiveSseFrame({
        frame: input.frame,
        accountId: row.account_id,
        whatsappMessageId: row.whatsapp_message_id,
        visibilityGate: this.#visibilityGate,
        hasConcreteWhatsAppVisibilityFence: this.#hasConcreteWhatsAppVisibilityFence,
        writeFrame: (frame) => {
          this.#store.immediate(() => {
            if (!this.#isFrameCurrent(row) || !input.isStreamCurrent()) return;
            input.writeFrame(frame);
            written = true;
          });
        },
        recheck: async () => {
          recheckStarted = true;
          await this.#recheck(row);
          recheckCompleted = true;
        },
      });
    } catch (error) {
      if (isRemovedAccountError(error))
        this.#store.immediate(() =>
          purgeRemovedAccountWork(
            this.#store.database,
            { source: sourceOfStreamRow(this.#store, row), accountId: row.account_id },
            this.#now(),
          ),
        );
      else if (recheckStarted && !recheckCompleted) return false;
      else throw error;
      return false;
    }
    return accepted && written;
  }

  async replay(input: {
    readonly subscriberId: string;
    readonly subscriberVersion: number;
    readonly afterId: string | null;
    readonly writeFrame: (frame: string) => void;
  }): Promise<number> {
    // One order for both kinds of frame (W31): a workflow's rule-target frames and the events it raised, by when each
    // was delivered into this subscriber's log, then by id. A Last-Event-ID names either; an unknown one replays none.
    const cursor = this.#cursor(input.subscriberId, input.subscriberVersion, input.afterId);
    if (cursor === undefined) return 0;
    const frames = [
      ...this.#rows(input.subscriberId, input.subscriberVersion, cursor).map((row) => ({ kind: 'rule' as const, row })),
      ...this.#eventRows(input.subscriberId, input.subscriberVersion, cursor).map((row) => ({
        kind: 'event' as const,
        row,
      })),
    ].sort(
      (left, right) =>
        left.row.delivered_at - right.row.delivered_at ||
        (left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0),
    );
    let delivered = 0;
    for (const frame of frames) {
      const wrote =
        frame.kind === 'rule'
          ? await this.#replayRuleRow(frame.row, input.writeFrame)
          : await this.#replayEventRow(frame.row, () => true, input.writeFrame);
      if (wrote) delivered += 1;
    }
    return delivered;
  }

  async #replayRuleRow(row: StreamLogRow, writeFrame: (frame: string) => void): Promise<boolean> {
    const request = this.#fenceRequest(row);
    try {
      await this.#fence(request);
      await assertLiveEventAccount(this.#config, {
        source: sourceOfStreamRow(this.#store, row),
        accountId: row.account_id,
      });
    } catch (error) {
      if (isRemovedAccountError(error))
        this.#store.immediate(() =>
          purgeRemovedAccountWork(
            this.#store.database,
            {
              source: sourceOfStreamRow(this.#store, row),
              accountId: row.account_id,
            },
            this.#now(),
          ),
        );
      return false;
    }
    // Do not decrypt a row that has already lost its retained-content authority. The same synchronous check repeats
    // after decrypt because an expiry, revocation, pause, or disable can win while that await is in flight.
    if (!this.#store.immediate(() => this.#isFrameCurrent(row))) return false;
    let bytes: Buffer;
    try {
      bytes = await this.#cipher.decrypt(streamLocation(row.id), row.encrypted_record);
    } catch {
      this.#store.immediate(() => this.#store.database.prepare('DELETE FROM stream_log WHERE id = ?').run(row.id));
      return false;
    }
    try {
      await this.#fence(request);
      await assertLiveEventAccount(this.#config, {
        source: sourceOfStreamRow(this.#store, row),
        accountId: row.account_id,
      });
    } catch (error) {
      if (isRemovedAccountError(error))
        this.#store.immediate(() =>
          purgeRemovedAccountWork(
            this.#store.database,
            {
              source: sourceOfStreamRow(this.#store, row),
              accountId: row.account_id,
            },
            this.#now(),
          ),
        );
      return false;
    }
    const frame = `id: ${row.id}\ndata: ${bytes.toString('utf8')}\n\n`;
    const allowed = this.#store.immediate(() => this.#isFrameCurrent(row));
    if (!allowed) return false;
    // Task 9 passes the physical socket callback through writeReplaySseFrame; this Task 8 path is non-WhatsApp only.
    let wrote = false;
    let recheckStarted = false;
    let recheckCompleted = false;
    try {
      const accepted = await writeReplaySseFrame({
        frame,
        accountId: row.account_id,
        whatsappMessageId: row.whatsapp_message_id,
        visibilityGate: this.#visibilityGate,
        hasConcreteWhatsAppVisibilityFence: this.#hasConcreteWhatsAppVisibilityFence,
        recheck: async () => {
          recheckStarted = true;
          await this.#recheck(row);
          recheckCompleted = true;
        },
        writeFrame: (frame) => {
          this.#store.immediate(() => {
            if (!this.#isFrameCurrent(row)) return;
            writeFrame(frame);
            wrote = true;
          });
        },
      });
      return accepted && wrote;
    } catch (error) {
      if (isRemovedAccountError(error))
        this.#store.immediate(() =>
          purgeRemovedAccountWork(
            this.#store.database,
            { source: sourceOfStreamRow(this.#store, row), accountId: row.account_id },
            this.#now(),
          ),
        );
      else if (recheckStarted && !recheckCompleted) return false;
      else throw error;
    }
    return false;
  }

  /**
   * Where a Last-Event-ID leaves off: a rule-target frame's id, or an event's id (its SSE `id:`) in this subscriber's
   * event log. Null replays from the start; undefined, for an id this subscriber version never had, replays nothing.
   */
  #cursor(
    subscriberId: string,
    subscriberVersion: number,
    afterId: string | null,
  ): { readonly delivered_at: number; readonly id: string } | null | undefined {
    if (afterId === null) return null;
    const rule = this.#store.database
      .prepare('SELECT delivered_at, id FROM stream_log WHERE id = ? AND subscriber_id = ? AND subscriber_version = ?')
      .get(afterId, subscriberId, subscriberVersion) as { delivered_at: number; id: string } | undefined;
    if (rule !== undefined) return rule;
    return this.#store.database
      .prepare(
        `SELECT delivered_at, id FROM event_stream_log
          WHERE event_id = ? AND subscriber_id = ? AND subscriber_version = ?`,
      )
      .get(afterId, subscriberId, subscriberVersion) as { delivered_at: number; id: string } | undefined;
  }

  #rows(
    subscriberId: string,
    subscriberVersion: number,
    cursor: { readonly delivered_at: number; readonly id: string } | null,
  ): readonly StreamLogRow[] {
    if (cursor === null) {
      return this.#store.database
        .prepare(
          `SELECT id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, account_id,
                  whatsapp_message_id, encrypted_record, delivered_at, expires_at, switch_generation
           FROM stream_log WHERE subscriber_id = ? AND subscriber_version = ? ORDER BY delivered_at, id`,
        )
        .all(subscriberId, subscriberVersion) as unknown as StreamLogRow[];
    }
    return this.#store.database
      .prepare(
        `SELECT id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, account_id,
                whatsapp_message_id, encrypted_record, delivered_at, expires_at, switch_generation
         FROM stream_log
         WHERE subscriber_id = ? AND subscriber_version = ?
           AND (delivered_at > ? OR (delivered_at = ? AND id > ?))
         ORDER BY delivered_at, id`,
      )
      .all(
        subscriberId,
        subscriberVersion,
        cursor.delivered_at,
        cursor.delivered_at,
        cursor.id,
      ) as unknown as StreamLogRow[];
  }

  #eventRows(
    subscriberId: string,
    subscriberVersion: number,
    cursor: { readonly delivered_at: number; readonly id: string } | null,
  ): readonly EventStreamLogRow[] {
    return this.#store.database
      .prepare(
        `SELECT id, event_id, subscriber_id, subscriber_version, encrypted_record, delivered_at, expires_at
           FROM event_stream_log
          WHERE subscriber_id = ? AND subscriber_version = ?
            AND (? IS NULL OR delivered_at > ? OR (delivered_at = ? AND id > ?))
          ORDER BY delivered_at, id`,
      )
      .all(
        subscriberId,
        subscriberVersion,
        cursor?.delivered_at ?? null,
        cursor?.delivered_at ?? null,
        cursor?.delivered_at ?? null,
        cursor?.id ?? null,
      ) as unknown as EventStreamLogRow[];
  }

  #eventRow(id: string): EventStreamLogRow | undefined {
    return this.#store.database
      .prepare(
        `SELECT id, event_id, subscriber_id, subscriber_version, encrypted_record, delivered_at, expires_at
           FROM event_stream_log WHERE id = ?`,
      )
      .get(id) as EventStreamLogRow | undefined;
  }

  /**
   * One event frame, replayed or live (W31, W35): both authorities fenced before the record is opened and again after,
   * and the frame written only inside the transaction that finds its log row, the switch, the workflow and the
   * subscriber version all still current. A frame whose subscriber was removed, or whose workflow was revoked, has
   * lost its row or its authority by then, and is never written.
   */
  async #replayEventRow(
    row: EventStreamLogRow,
    isStreamCurrent: () => boolean,
    writeFrame: (frame: string) => void,
  ): Promise<boolean> {
    const fence = async () =>
      assertEventDisclosable({
        database: this.#store.database,
        approvals: this.#approvals,
        config: this.#config,
        eventId: row.event_id,
        subscriberId: row.subscriber_id,
        subscriberVersion: row.subscriber_version,
        boundary: 'read',
      });
    let disclosure: EventDisclosure;
    try {
      disclosure = await fence();
    } catch {
      return false;
    }
    if (!this.#store.immediate(() => this.#isEventFrameCurrent(row, disclosure))) return false;
    let text: string;
    try {
      text = (await this.#cipher.decrypt(eventStreamLocation(row.id), row.encrypted_record)).toString('utf8');
    } catch {
      this.#store.immediate(() =>
        this.#store.database.prepare('DELETE FROM event_stream_log WHERE id = ?').run(row.id),
      );
      return false;
    }
    try {
      disclosure = await fence();
    } catch {
      return false;
    }
    const frame = eventSseFrame(row.event_id, disclosure.type, text);
    let wrote = false;
    this.#store.immediate(() => {
      if (!this.#isEventFrameCurrent(row, disclosure) || !isStreamCurrent()) return;
      writeFrame(frame);
      wrote = true;
    });
    return wrote;
  }

  /** The live writer for an event frame: the same gate as replay, and the stream's own current-generation check. */
  async writeEvent(input: {
    readonly eventStreamLogId: string;
    readonly isStreamCurrent: () => boolean;
    readonly writeFrame: (frame: string) => void;
  }): Promise<boolean> {
    const row = this.#eventRow(input.eventStreamLogId);
    if (row === undefined) return false;
    return this.#replayEventRow(row, input.isStreamCurrent, input.writeFrame);
  }

  #isEventFrameCurrent(row: EventStreamLogRow, disclosure: EventDisclosure): boolean {
    const current = this.#eventRow(row.id);
    if (current === undefined) return false;
    const now = this.#now();
    if (current.expires_at <= now) {
      this.#store.database
        .prepare('DELETE FROM event_stream_log WHERE id = ? AND expires_at <= ?')
        .run(current.id, now);
      return false;
    }
    return eventDisclosureIsCurrent(this.#store.database, disclosure);
  }

  #row(id: string): StreamLogRow | undefined {
    return this.#store.database
      .prepare(
        `SELECT id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, account_id,
                whatsapp_message_id, encrypted_record, delivered_at, expires_at, switch_generation
         FROM stream_log WHERE id = ?`,
      )
      .get(id) as StreamLogRow | undefined;
  }

  #isFrameCurrent(row: StreamLogRow): boolean {
    const current = this.#row(row.id);
    if (current === undefined) return false;
    const now = this.#now();
    if (current.expires_at <= now) {
      this.#store.database.prepare('DELETE FROM stream_log WHERE id = ? AND expires_at <= ?').run(current.id, now);
      return false;
    }
    const settings = this.#store.database
      .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
    if (settings?.enabled !== 1 || settings.paused === 1 || settings.switch_generation !== current.switch_generation)
      return false;
    return hasLiveSseLineage(this.#store, {
      id: current.id,
      decision_id: '',
      account_id: current.account_id,
      rule_id: current.rule_id,
      rule_version: current.rule_version,
      target_id: current.target_id,
      target_version: current.target_version,
      subscriber_id: current.subscriber_id,
      subscriber_version: current.subscriber_version,
      target_kind: 'sse',
      encrypted_record: null,
      expires_at: current.expires_at,
      switch_generation: current.switch_generation,
      event_id: '',
      whatsapp_message_id: null,
      whatsapp_visibility_version: null,
    });
  }

  async #recheck(row: StreamLogRow): Promise<void> {
    await this.#fence(this.#fenceRequest(row));
    await assertLiveEventAccount(this.#config, {
      source: sourceOfStreamRow(this.#store, row),
      accountId: row.account_id,
    });
  }

  #fenceRequest(row: StreamLogRow): ActiveDisclosableRequest {
    return {
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: row.account_id,
      boundary: 'read',
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      targetId: row.target_id,
      targetVersion: row.target_version,
      switchGeneration: row.switch_generation,
    };
  }
}

function sourceOfStreamRow(
  store: EventDatabase,
  row: Pick<StreamLogRow, 'rule_id' | 'rule_version'>,
): 'gmail' | 'slack' | 'resend' | 'whatsapp' {
  const stored = store.database
    .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(row.rule_id, row.rule_version) as { document: string } | undefined;
  if (stored === undefined) throw new Error('the stream row has no exact rule version');
  const document = JSON.parse(stored.document) as { source?: { channel?: unknown } };
  // Source-less B2 documents were Gmail-only before D introduced this union. Present malformed values are not legacy.
  if (document.source === undefined) return 'gmail';
  const source = document.source?.channel;
  if (source === 'gmail' || source === 'slack' || source === 'resend' || source === 'whatsapp') return source;
  throw new Error('the stream row has no recognised event source');
}
