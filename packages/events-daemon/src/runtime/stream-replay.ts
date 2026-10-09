import type { ApprovalStore, ConfigStore } from '@agentcomms/core';
import type { EventDatabase } from '../store/database.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { assertLiveGmailAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import { PassThroughSseFrameVisibilityGate, type SseFrameVisibilityGate } from './phase-d-whatsapp-seam.ts';
import { hasLiveSseLineage, type SealedSseFrameWrite, streamLocation } from './sse-dispatcher.ts';

/** Replay has its own writer entry point so Last-Event-ID frames cannot bypass the same synchronous D visibility seam. */
export function writeReplaySseFrame(input: SealedSseFrameWrite): boolean {
  if (input.whatsappMessageId === null) {
    input.writeFrame(input.frame);
    return true;
  }
  if (!input.hasConcreteWhatsAppVisibilityFence) return false;
  input.visibilityGate.withCurrentSseFrameVisibility(
    { accountId: input.accountId, whatsappMessageId: input.whatsappMessageId },
    () => input.writeFrame(input.frame),
  );
  return true;
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

  async replay(input: {
    readonly subscriberId: string;
    readonly subscriberVersion: number;
    readonly afterId: string | null;
    readonly writeFrame: (frame: string) => void;
  }): Promise<number> {
    const rows = this.#rows(input.subscriberId, input.subscriberVersion, input.afterId);
    let delivered = 0;
    for (const row of rows) {
      const request = this.#fenceRequest(row);
      try {
        await this.#fence(request);
        await assertLiveGmailAccount(this.#config, row.account_id);
      } catch (error) {
        if (isRemovedAccountError(error))
          this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, row.account_id, this.#now()));
        continue;
      }
      // Do not decrypt a row that has already lost its retained-content authority. The same synchronous check repeats
      // after decrypt because an expiry, revocation, pause, or disable can win while that await is in flight.
      if (!this.#store.immediate(() => this.#isFrameCurrent(row))) continue;
      let bytes: Buffer;
      try {
        bytes = await this.#cipher.decrypt(streamLocation(row.id), row.encrypted_record);
      } catch {
        this.#store.immediate(() => this.#store.database.prepare('DELETE FROM stream_log WHERE id = ?').run(row.id));
        continue;
      }
      try {
        await this.#fence(request);
        await assertLiveGmailAccount(this.#config, row.account_id);
      } catch (error) {
        if (isRemovedAccountError(error))
          this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, row.account_id, this.#now()));
        continue;
      }
      const frame = `id: ${row.id}\ndata: ${bytes.toString('utf8')}\n\n`;
      const allowed = this.#store.immediate(() => this.#isFrameCurrent(row));
      if (!allowed) continue;
      // Task 9 passes the physical socket callback through writeReplaySseFrame; this Task 8 path is non-WhatsApp only.
      if (
        writeReplaySseFrame({
          frame,
          accountId: row.account_id,
          whatsappMessageId: row.whatsapp_message_id,
          visibilityGate: this.#visibilityGate,
          hasConcreteWhatsAppVisibilityFence: this.#hasConcreteWhatsAppVisibilityFence,
          writeFrame: input.writeFrame,
        })
      )
        delivered += 1;
    }
    return delivered;
  }

  #rows(subscriberId: string, subscriberVersion: number, afterId: string | null): readonly StreamLogRow[] {
    if (afterId === null) {
      return this.#store.database
        .prepare(
          `SELECT id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, account_id,
                  whatsapp_message_id, encrypted_record, delivered_at, expires_at, switch_generation
           FROM stream_log WHERE subscriber_id = ? AND subscriber_version = ? ORDER BY delivered_at, id`,
        )
        .all(subscriberId, subscriberVersion) as unknown as StreamLogRow[];
    }
    const cursor = this.#store.database
      .prepare('SELECT delivered_at, id FROM stream_log WHERE id = ? AND subscriber_id = ? AND subscriber_version = ?')
      .get(afterId, subscriberId, subscriberVersion) as { delivered_at: number; id: string } | undefined;
    if (cursor === undefined) return [];
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

  #isFrameCurrent(row: StreamLogRow): boolean {
    if (row.expires_at <= this.#now()) {
      this.#store.database.prepare('DELETE FROM stream_log WHERE id = ? AND expires_at <= ?').run(row.id, this.#now());
      return false;
    }
    const settings = this.#store.database
      .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
    if (settings?.enabled !== 1 || settings.paused === 1 || settings.switch_generation !== row.switch_generation)
      return false;
    return hasLiveSseLineage(this.#store, {
      id: row.id,
      decision_id: '',
      account_id: row.account_id,
      rule_id: row.rule_id,
      rule_version: row.rule_version,
      target_id: row.target_id,
      target_version: row.target_version,
      subscriber_id: row.subscriber_id,
      subscriber_version: row.subscriber_version,
      target_kind: 'sse',
      encrypted_record: null,
      expires_at: row.expires_at,
      switch_generation: row.switch_generation,
      event_id: '',
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
