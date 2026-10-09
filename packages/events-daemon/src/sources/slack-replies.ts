import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import { assertSlackTimestamp } from './slack.ts';

interface SlackReplyBarrier {
  readonly kind: 'slack-reply-barrier-v1';
  readonly through: string;
  readonly topLevelCovered: boolean;
}

interface StoredBarrier {
  readonly id: string;
  readonly value: SlackReplyBarrier;
  readonly record: Uint8Array;
}

interface SlackRepliesReader {
  replies(
    input: Readonly<{
      conversationId: string;
      parentTs: string;
      latest: string;
      cursor?: string | undefined;
    }>,
  ): Promise<Readonly<{ nextCursor: string | null }>>;
}

const SEVEN_DAYS_MICROS = 7n * 24n * 60n * 60n * 1_000_000n;

function timestampMicros(value: string): bigint {
  const [seconds, micros] = assertSlackTimestamp(value).split('.') as [string, string];
  return BigInt(seconds) * 1_000_000n + BigInt(micros);
}

function wallClockSlackTimestamp(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new CommsError('BAD_DATA', 'the Slack reply clock is invalid');
  const seconds = Math.floor(now / 1_000);
  const micros = (now % 1_000) * 1_000;
  return `${seconds}.${String(micros).padStart(6, '0')}`;
}

/** A parent is eligible only while its own top-level occurrence is at most seven days old. */
export function isSlackReplyEligible(parentTs: string, through: string, observedAt: string): boolean {
  const parent = timestampMicros(parentTs);
  const upper = timestampMicros(through);
  const observed = timestampMicros(observedAt);
  return parent <= upper && parent <= observed && observed - parent <= SEVEN_DAYS_MICROS;
}

function barrierId(intentId: string, accountId: string, conversationId: string): string {
  return `slack-reply-barrier:${Buffer.from(JSON.stringify([intentId, accountId, conversationId])).toString('base64url')}`;
}

/** Durable per-parent reply scans plus the aggregate top-level/replies replacement barrier. */
export class SlackReplyDrains {
  readonly #database: DatabaseSync;
  readonly #source: SlackRepliesReader;
  readonly #now: () => number;
  readonly #nowTimestamp: () => string;
  readonly #assertLive: () => void;
  readonly #encrypt: (value: unknown, id: string) => Promise<Uint8Array>;
  readonly #decrypt: (record: Uint8Array, id: string) => Promise<unknown>;

  constructor(
    options: Readonly<{
      database: DatabaseSync;
      source: SlackRepliesReader;
      /** Source-owner fence re-check run in the write that follows a provider or crypto await. */
      assertLive: () => void;
      now?: (() => number) | undefined;
      nowTimestamp?: (() => string) | undefined;
      encryptState: (value: unknown, id: string) => Promise<Uint8Array>;
      decryptState: (record: Uint8Array, id: string) => Promise<unknown>;
    }>,
  ) {
    this.#database = options.database;
    this.#source = options.source;
    this.#assertLive = options.assertLive;
    this.#now = options.now ?? Date.now;
    this.#nowTimestamp = options.nowTimestamp ?? (() => wallClockSlackTimestamp(this.#now()));
    // Reply-barrier state contains only provider cursors and is still stored through the caller's record cipher.
    this.#encrypt = options.encryptState;
    this.#decrypt = options.decryptState;
  }

  async begin(
    input: Readonly<{ intentId: string; accountId: string; conversationId: string; through: string }>,
  ): Promise<void> {
    assertSlackTimestamp(input.through);
    const id = barrierId(input.intentId, input.accountId, input.conversationId);
    const existing = this.#database.prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?').get(id) as
      | { encrypted_record: Uint8Array }
      | undefined;
    if (existing !== undefined) {
      const barrier = await this.#load(id, existing.encrypted_record);
      if (barrier.value.through !== input.through)
        throw new CommsError('BAD_DATA', 'a Slack reply drain changed its fixed upper bound');
      return;
    }
    const value: SlackReplyBarrier = { kind: 'slack-reply-barrier-v1', through: input.through, topLevelCovered: false };
    const record = await this.#encrypt(value, id);
    this.#assertLive();
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO source_scan_state
         (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
         VALUES (?, 'slack', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, input.accountId, `slack:${input.accountId}:${input.conversationId}`, record, this.#now());
  }

  async discoverParent(
    input: Readonly<{
      intentId: string;
      accountId: string;
      conversationId: string;
      parentTs: string;
    }>,
  ): Promise<void> {
    assertSlackTimestamp(input.parentTs);
    const barrier = await this.#require(input);
    if (barrier.value.topLevelCovered)
      throw new CommsError('APPROVAL_VOID', 'the Slack reply-parent set is frozen after top-level coverage');
    if (!isSlackReplyEligible(input.parentTs, barrier.value.through, this.#nowTimestamp())) return;
    this.#assertLive();
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO slack_reply_drains
         (intent_id, account_id, conversation_id, thread_ts, cursor, covered_through, drained_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(input.intentId, input.accountId, input.conversationId, input.parentTs, barrier.value.through);
  }

  async topLevelCovered(
    input: Readonly<{ intentId: string; accountId: string; conversationId: string }>,
  ): Promise<void> {
    const barrier = await this.#require(input);
    if (barrier.value.topLevelCovered) return;
    const next: SlackReplyBarrier = { ...barrier.value, topLevelCovered: true };
    const record = await this.#encrypt(next, barrier.id);
    this.#assertLive();
    const updated = this.#database
      .prepare(
        'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
      )
      .run(record, this.#now(), barrier.id, barrier.record);
    if (Number(updated.changes) !== 1)
      throw new CommsError('APPROVAL_VOID', 'the Slack reply barrier changed while it was frozen');
  }

  async resumeOne(input: Readonly<{ intentId: string; accountId: string; conversationId: string }>): Promise<boolean> {
    await this.#require(input);
    const row = this.#database
      .prepare(
        `SELECT thread_ts, cursor, covered_through FROM slack_reply_drains
         WHERE intent_id = ? AND account_id = ? AND conversation_id = ? AND drained_at IS NULL
         ORDER BY CASE WHEN cursor IS NULL THEN 0 ELSE 1 END, thread_ts LIMIT 1`,
      )
      .get(input.intentId, input.accountId, input.conversationId) as
      | { thread_ts: string; cursor: string | null; covered_through: string }
      | undefined;
    if (row === undefined) return true;
    const page = await this.#source.replies({
      conversationId: input.conversationId,
      parentTs: row.thread_ts,
      latest: row.covered_through,
      ...(row.cursor === null ? {} : { cursor: row.cursor }),
    });
    // The update is conditional on the exact cursor read before the await. A stale response cannot complete a parent
    // another scan/reset already moved.
    this.#assertLive();
    const update = this.#database
      .prepare(
        `UPDATE slack_reply_drains
         SET cursor = ?, drained_at = ?
         WHERE intent_id = ? AND account_id = ? AND conversation_id = ? AND thread_ts = ? AND cursor IS ? AND drained_at IS NULL`,
      )
      .run(
        page.nextCursor,
        page.nextCursor === null ? this.#now() : null,
        input.intentId,
        input.accountId,
        input.conversationId,
        row.thread_ts,
        row.cursor,
      );
    if (Number(update.changes) !== 1)
      throw new CommsError('APPROVAL_VOID', 'the Slack reply drain changed while a page was read');
    return page.nextCursor === null;
  }

  async complete(input: Readonly<{ intentId: string; accountId: string; conversationId: string }>): Promise<boolean> {
    const barrier = await this.#require(input);
    if (!barrier.value.topLevelCovered) return false;
    return (
      this.#database
        .prepare(
          `SELECT 1 AS present FROM slack_reply_drains
           WHERE intent_id = ? AND account_id = ? AND conversation_id = ? AND drained_at IS NULL`,
        )
        .get(input.intentId, input.accountId, input.conversationId) === undefined
    );
  }

  async #require(
    input: Readonly<{ intentId: string; accountId: string; conversationId: string }>,
  ): Promise<StoredBarrier> {
    const id = barrierId(input.intentId, input.accountId, input.conversationId);
    const row = this.#database.prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?').get(id) as
      | { encrypted_record: Uint8Array }
      | undefined;
    if (row === undefined) throw new CommsError('BAD_DATA', 'the Slack reply barrier was not started');
    return this.#load(id, row.encrypted_record);
  }

  async #load(id: string, record: Uint8Array): Promise<StoredBarrier> {
    const value = (await this.#decrypt(record, id)) as Partial<SlackReplyBarrier>;
    if (
      value.kind !== 'slack-reply-barrier-v1' ||
      typeof value.through !== 'string' ||
      typeof value.topLevelCovered !== 'boolean'
    )
      throw new CommsError('BAD_DATA', 'a Slack reply barrier record is malformed');
    assertSlackTimestamp(value.through);
    return { id, value: value as SlackReplyBarrier, record };
  }
}
