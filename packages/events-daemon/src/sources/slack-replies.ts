import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import { type SourceScope, type SourceStageDebt, sourceStageRetentionForDebts } from './contracts.ts';
import {
  assertSlackTimestamp,
  compareSlackTimestamp,
  type SlackCandidate,
  type SlackSourceMessage,
  type SlackSourcePage,
} from './slack.ts';

interface SlackReplyBarrier {
  readonly kind: 'slack-reply-barrier-v1';
  readonly through: string;
  readonly topLevelCovered: boolean;
}

interface SlackReplyReconciliationState {
  readonly kind: 'slack-reply-reconciliation-v1';
  readonly parentTs: string;
  /** Wall-clock observation time, not a provider timestamp. */
  readonly observedAt: number;
  /** This moves only on a fully admitted final reply page. */
  readonly watermark: string;
  /** The fixed upper edge of an in-progress scan. */
  readonly latest: string | null;
  readonly cursor: string | null;
  readonly generation: number;
  /** Lower values receive the next per-scope reply turn. */
  readonly turn: number;
}

interface SlackReplyPageStage {
  readonly kind: 'slack-reply-page-v1';
  readonly owner: string;
  readonly parentTs: string;
  readonly generation: number;
  readonly cursorBefore: string | null;
  readonly latest: string;
  readonly nextCursor: string | null;
  readonly retainedHistoryBoundary: boolean;
  readonly messages: readonly SlackSourceMessage[];
  readonly completed: readonly string[];
}

interface StoredBarrier {
  readonly id: string;
  readonly value: SlackReplyBarrier;
  readonly record: Uint8Array;
}

interface StoredReconciliation {
  readonly id: string;
  readonly value: SlackReplyReconciliationState;
  readonly record: Uint8Array;
}

interface StoredReplyPage {
  readonly id: string;
  readonly value: SlackReplyPageStage;
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
  ): Promise<SlackSourcePage>;
}

export interface SlackReplyStageHooks {
  readonly scope: SourceScope;
  readonly debts: () => readonly SourceStageDebt[];
  readonly admit: (input: Readonly<{ candidate: SlackCandidate; stageId: string }>) => Promise<'terminal' | 'pending'>;
}

const SEVEN_DAYS_MICROS = 7n * 24n * 60n * 60n * 1_000_000n;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

function timestampMicros(value: string): bigint {
  const [seconds, micros] = assertSlackTimestamp(value).split('.') as [string, string];
  return BigInt(seconds) * 1_000_000n + BigInt(micros);
}

function wallClockSlackTimestamp(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new CommsError('BAD_DATA', 'the Slack reply clock is invalid');
  return `${Math.floor(now / 1_000)}.${String((now % 1_000) * 1_000).padStart(6, '0')}`;
}

function assertTaintedMessage(message: SlackSourceMessage): void {
  if (!/^<untrusted-content\b[^>]*>[\s\S]*<\/untrusted-content(?:\s[^>]*)?>$/u.test(message.text))
    throw new CommsError('BAD_DATA', 'a Slack reply arrived without its untrusted-content envelope');
}

function isInvalidCursor(error: unknown): boolean {
  if (error instanceof CommsError) return error.code === 'BAD_DATA' && error.details?.slackError === 'invalid_cursor';
  const candidate = error as { code?: unknown; slackError?: unknown; details?: { slackError?: unknown } };
  return (
    candidate?.code === 'BAD_DATA' &&
    (candidate.slackError === 'invalid_cursor' || candidate.details?.slackError === 'invalid_cursor')
  );
}

function immediate<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
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

function reconciliationId(accountId: string, conversationId: string, parentTs: string): string {
  return `slack-reply-reconciliation:${Buffer.from(JSON.stringify([accountId, conversationId, parentTs])).toString('base64url')}`;
}

function replyPageId(input: {
  readonly owner: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly parentTs: string;
  readonly generation: number;
  readonly cursorBefore: string | null;
  readonly nextCursor: string | null;
  readonly retainedHistoryBoundary: boolean;
}): string {
  return `slack-reply-page:${Buffer.from(
    JSON.stringify([
      input.owner,
      input.accountId,
      input.conversationId,
      input.parentTs,
      input.generation,
      input.cursorBefore,
      input.nextCursor,
      input.retainedHistoryBoundary,
    ]),
  ).toString('base64url')}`;
}

function replyPageIdentity(id: string): {
  readonly owner: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly parentTs: string;
  readonly generation: number;
  readonly cursorBefore: string | null;
  readonly nextCursor: string | null;
  readonly retainedHistoryBoundary: boolean;
} | null {
  if (!id.startsWith('slack-reply-page:')) return null;
  try {
    const value = JSON.parse(
      Buffer.from(id.slice('slack-reply-page:'.length), 'base64url').toString('utf8'),
    ) as unknown;
    if (!Array.isArray(value) || value.length !== 8) return null;
    const [owner, accountId, conversationId, parentTs, generation, cursorBefore, nextCursor, retainedHistoryBoundary] =
      value;
    if (
      typeof owner !== 'string' ||
      typeof accountId !== 'string' ||
      typeof conversationId !== 'string' ||
      typeof parentTs !== 'string' ||
      !Number.isSafeInteger(generation) ||
      (cursorBefore !== null && typeof cursorBefore !== 'string') ||
      (nextCursor !== null && typeof nextCursor !== 'string') ||
      typeof retainedHistoryBoundary !== 'boolean'
    )
      return null;
    assertSlackTimestamp(parentTs);
    return {
      owner,
      accountId,
      conversationId,
      parentTs,
      generation,
      cursorBefore,
      nextCursor,
      retainedHistoryBoundary,
    };
  } catch {
    return null;
  }
}

/** Shared D3/D8 reply-page staging used by ordinary reconciliation and replacement drains. */
class SlackReplyPageStager {
  readonly #database: DatabaseSync;
  readonly #hooks: SlackReplyStageHooks;
  readonly #assertLive: () => void;
  readonly #now: () => number;
  readonly #encrypt: (value: unknown, id: string) => Promise<Uint8Array>;
  readonly #decrypt: (record: Uint8Array, id: string) => Promise<unknown>;

  constructor(input: {
    readonly database: DatabaseSync;
    readonly hooks: SlackReplyStageHooks;
    readonly assertLive: () => void;
    readonly now: () => number;
    readonly encrypt: (value: unknown, id: string) => Promise<Uint8Array>;
    readonly decrypt: (record: Uint8Array, id: string) => Promise<unknown>;
  }) {
    this.#database = input.database;
    this.#hooks = input.hooks;
    this.#assertLive = input.assertLive;
    this.#now = input.now;
    this.#encrypt = input.encrypt;
    this.#decrypt = input.decrypt;
  }

  async load(input: {
    readonly owner: string;
    readonly accountId: string;
    readonly conversationId: string;
    readonly parentTs: string;
    readonly generation: number;
    readonly cursorBefore: string | null;
  }): Promise<StoredReplyPage | null> {
    const rows = this.#database
      .prepare(
        "SELECT id, encrypted_record FROM source_scan_state WHERE source = 'slack' AND id LIKE 'slack-reply-page:%'",
      )
      .all() as Array<{ id: string; encrypted_record: Uint8Array }>;
    const row = rows.find((candidate) => {
      const identity = replyPageIdentity(candidate.id);
      return (
        identity !== null &&
        identity.owner === input.owner &&
        identity.accountId === input.accountId &&
        identity.conversationId === input.conversationId &&
        identity.parentTs === input.parentTs &&
        identity.generation === input.generation &&
        identity.cursorBefore === input.cursorBefore
      );
    });
    return row === undefined ? null : this.#decode(row.id, row.encrypted_record);
  }

  /**
   * Turns an expired raw page into its content-free cursor continuation. A prior EventExpiry sweep has the same
   * durable resolution row, so both restart paths advance the exact saved next cursor without another provider call.
   */
  expiredContinuation(input: {
    readonly owner: string;
    readonly accountId: string;
    readonly conversationId: string;
    readonly parentTs: string;
    readonly generation: number;
    readonly cursorBefore: string | null;
  }): Readonly<{ nextCursor: string | null; retainedHistoryBoundary: boolean }> | null {
    const matches = (id: string) => {
      const identity = replyPageIdentity(id);
      return (
        identity !== null &&
        identity.owner === input.owner &&
        identity.accountId === input.accountId &&
        identity.conversationId === input.conversationId &&
        identity.parentTs === input.parentTs &&
        identity.generation === input.generation &&
        identity.cursorBefore === input.cursorBefore
      );
    };
    const stage = (
      this.#database
        .prepare(
          "SELECT id, encrypted_record FROM source_scan_state WHERE source = 'slack' AND id LIKE 'slack-reply-page:%'",
        )
        .all() as Array<{ id: string; encrypted_record: Uint8Array }>
    ).find((row) => matches(row.id));
    if (stage !== undefined) {
      const row = this.#database.prepare('SELECT stage_expires_at FROM source_scan_state WHERE id = ?').get(stage.id) as
        | { stage_expires_at: number | null }
        | undefined;
      if (
        row?.stage_expires_at !== null &&
        row?.stage_expires_at !== undefined &&
        row.stage_expires_at <= this.#now()
      ) {
        const identity = replyPageIdentity(stage.id);
        if (identity === null) throw new CommsError('BAD_DATA', 'an expired Slack reply stage has no cursor identity');
        this.#assertLive();
        immediate(this.#database, () => {
          this.#assertLive();
          const deleted = this.#database
            .prepare(
              `DELETE FROM source_scan_state
               WHERE id = ? AND encrypted_record = ? AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
            )
            .run(stage.id, stage.encrypted_record, this.#now());
          if (Number(deleted.changes) !== 1)
            throw new CommsError('APPROVAL_VOID', 'the expired Slack reply stage changed before its continuation');
          this.#database
            .prepare(
              `INSERT OR IGNORE INTO source_occurrence_resolutions
               (source, account_id, occurrence_key, outcome, resolved_at, error_code)
               VALUES ('slack', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
            )
            .run(input.accountId, stage.id, this.#now());
        });
        return { nextCursor: identity.nextCursor, retainedHistoryBoundary: identity.retainedHistoryBoundary };
      }
      return null;
    }
    const resolution = (
      this.#database
        .prepare("SELECT occurrence_key FROM source_occurrence_resolutions WHERE source = 'slack' AND account_id = ?")
        .all(input.accountId) as Array<{ occurrence_key: string }>
    ).find((row) => matches(row.occurrence_key));
    const identity = resolution === undefined ? null : replyPageIdentity(resolution.occurrence_key);
    return identity === null
      ? null
      : { nextCursor: identity.nextCursor, retainedHistoryBoundary: identity.retainedHistoryBoundary };
  }

  async stage(input: {
    readonly owner: string;
    readonly accountId: string;
    readonly conversationId: string;
    readonly parentTs: string;
    readonly generation: number;
    readonly cursorBefore: string | null;
    readonly latest: string;
    readonly page: SlackSourcePage;
    readonly lowerExclusive: string | null;
  }): Promise<StoredReplyPage> {
    for (const message of input.page.messages) {
      assertSlackTimestamp(message.ts);
      assertTaintedMessage(message);
    }
    const existing = await this.load(input);
    if (existing !== null) return existing;
    const messages = input.page.messages.filter(
      (message) =>
        message.ts !== input.parentTs &&
        message.threadTs === input.parentTs &&
        compareSlackTimestamp(message.ts, input.latest) <= 0 &&
        (input.lowerExclusive === null || compareSlackTimestamp(message.ts, input.lowerExclusive) > 0),
    );
    const id = replyPageId({
      ...input,
      nextCursor: input.page.nextCursor,
      retainedHistoryBoundary: input.page.retainedHistoryBoundary,
    });
    const value: SlackReplyPageStage = {
      kind: 'slack-reply-page-v1',
      owner: input.owner,
      parentTs: input.parentTs,
      generation: input.generation,
      cursorBefore: input.cursorBefore,
      latest: input.latest,
      nextCursor: input.page.nextCursor,
      retainedHistoryBoundary: input.page.retainedHistoryBoundary,
      messages,
      completed: [],
    };
    const record = await this.#encrypt(value, id);
    const retention = sourceStageRetentionForDebts(this.#now(), this.#hooks.debts());
    this.#assertLive();
    immediate(this.#database, () => {
      this.#assertLive();
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES (?, 'slack', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.accountId,
          this.#hooks.scope.scopeId,
          retention.stagedAt,
          retention.stageExpiresAt,
          record,
          this.#now(),
        );
      for (const debt of this.#hooks.debts()) {
        this.#database
          .prepare('INSERT OR IGNORE INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, ?)')
          .run(id, debt.ruleId, debt.ruleVersion);
      }
    });
    const persisted = this.#database.prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?').get(id) as
      | { encrypted_record: Uint8Array }
      | undefined;
    if (persisted === undefined)
      throw new CommsError('APPROVAL_VOID', 'the Slack reply stage disappeared while it was written');
    return this.#decode(id, persisted.encrypted_record);
  }

  async admit(
    input: Readonly<{ stage: StoredReplyPage; conversationId: string }>,
  ): Promise<Readonly<{ outcome: 'terminal' | 'pending'; stage: StoredReplyPage }>> {
    let current = input.stage;
    for (const message of current.value.messages) {
      if (current.value.completed.includes(message.ts)) continue;
      const outcome = await this.#hooks.admit({
        candidate: { conversationId: input.conversationId, message },
        stageId: current.id,
      });
      if (outcome === 'pending') return { outcome, stage: current };
      const next: SlackReplyPageStage = { ...current.value, completed: [...current.value.completed, message.ts] };
      const record = await this.#encrypt(next, current.id);
      this.#assertLive();
      immediate(this.#database, () => {
        this.#assertLive();
        const updated = this.#database
          .prepare(
            'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
          )
          .run(record, this.#now(), current.id, current.record);
        if (Number(updated.changes) !== 1)
          throw new CommsError('APPROVAL_VOID', 'the Slack reply stage changed while a candidate was admitted');
      });
      current = { id: current.id, value: next, record };
    }
    return { outcome: 'terminal', stage: current };
  }

  clearInTransaction(stage: StoredReplyPage): void {
    const deleted = this.#database
      .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
      .run(stage.id, stage.record);
    if (Number(deleted.changes) !== 1)
      throw new CommsError('APPROVAL_VOID', 'the Slack reply stage changed before its cursor moved');
  }

  async #decode(id: string, record: Uint8Array): Promise<StoredReplyPage> {
    const value = (await this.#decrypt(record, id)) as Partial<SlackReplyPageStage>;
    if (
      value.kind !== 'slack-reply-page-v1' ||
      typeof value.owner !== 'string' ||
      typeof value.parentTs !== 'string' ||
      !Number.isSafeInteger(value.generation) ||
      (value.cursorBefore !== null && typeof value.cursorBefore !== 'string') ||
      typeof value.latest !== 'string' ||
      (value.nextCursor !== null && typeof value.nextCursor !== 'string') ||
      typeof value.retainedHistoryBoundary !== 'boolean' ||
      !Array.isArray(value.messages) ||
      !Array.isArray(value.completed)
    )
      throw new CommsError('BAD_DATA', 'a Slack reply page stage is malformed');
    assertSlackTimestamp(value.parentTs);
    assertSlackTimestamp(value.latest);
    for (const message of value.messages) {
      if (typeof message !== 'object' || message === null)
        throw new CommsError('BAD_DATA', 'a staged Slack reply is malformed');
      assertSlackTimestamp((message as SlackSourceMessage).ts);
      assertTaintedMessage(message as SlackSourceMessage);
    }
    if (!value.completed.every((timestamp) => typeof timestamp === 'string'))
      throw new CommsError('BAD_DATA', 'a staged Slack reply completion is malformed');
    return { id, value: value as SlackReplyPageStage, record };
  }
}

/** Durable per-parent replacement scans plus the aggregate top-level/replies barrier. */
export class SlackReplyDrains {
  readonly #database: DatabaseSync;
  readonly #source: SlackRepliesReader;
  readonly #now: () => number;
  readonly #nowTimestamp: () => string;
  readonly #assertLive: () => void;
  readonly #encrypt: (value: unknown, id: string) => Promise<Uint8Array>;
  readonly #decrypt: (record: Uint8Array, id: string) => Promise<unknown>;
  readonly #stager: SlackReplyPageStager;

  constructor(
    options: Readonly<{
      database: DatabaseSync;
      source: SlackRepliesReader;
      assertLive: () => void;
      now?: (() => number) | undefined;
      nowTimestamp?: (() => string) | undefined;
      encryptState: (value: unknown, id: string) => Promise<Uint8Array>;
      decryptState: (record: Uint8Array, id: string) => Promise<unknown>;
      stage: SlackReplyStageHooks;
    }>,
  ) {
    this.#database = options.database;
    this.#source = options.source;
    this.#assertLive = options.assertLive;
    this.#now = options.now ?? Date.now;
    this.#nowTimestamp = options.nowTimestamp ?? (() => wallClockSlackTimestamp(this.#now()));
    this.#encrypt = options.encryptState;
    this.#decrypt = options.decryptState;
    this.#stager = new SlackReplyPageStager({
      database: options.database,
      hooks: options.stage,
      assertLive: options.assertLive,
      now: this.#now,
      encrypt: options.encryptState,
      decrypt: options.decryptState,
    });
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
    const record = await this.#encrypt(
      { kind: 'slack-reply-barrier-v1', through: input.through, topLevelCovered: false },
      id,
    );
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
    input: Readonly<{ intentId: string; accountId: string; conversationId: string; parentTs: string }>,
  ): Promise<void> {
    assertSlackTimestamp(input.parentTs);
    const barrier = await this.#require(input);
    const existing = this.#database
      .prepare(
        `SELECT 1 AS present FROM slack_reply_drains
         WHERE intent_id = ? AND account_id = ? AND conversation_id = ? AND thread_ts = ?`,
      )
      .get(input.intentId, input.accountId, input.conversationId, input.parentTs);
    // Reopening a durable owner may rediscover a parent it put in this drain
    // before top-level coverage. That idempotent no-op is safe; a distinct
    // parent after coverage would make the aggregate proof incomplete.
    if (existing !== undefined) return;
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
      .run(input.intentId, input.accountId, input.conversationId, input.parentTs, input.parentTs);
  }

  async topLevelCovered(
    input: Readonly<{ intentId: string; accountId: string; conversationId: string }>,
  ): Promise<void> {
    const barrier = await this.#require(input);
    if (barrier.value.topLevelCovered) return;
    const record = await this.#encrypt({ ...barrier.value, topLevelCovered: true }, barrier.id);
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
    const barrier = await this.#require(input);
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
    const owner = `drain:${input.intentId}`;
    const stager = this.#stager;
    const expired = stager.expiredContinuation({
      owner,
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentTs: row.thread_ts,
      generation: 1,
      cursorBefore: row.cursor,
    });
    if (expired !== null) {
      if (expired.retainedHistoryBoundary) return false;
      return this.#advanceExpired(input, row, barrier, expired);
    }
    let stage = await stager.load({
      owner,
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentTs: row.thread_ts,
      generation: 1,
      cursorBefore: row.cursor,
    });
    if (stage === null) {
      let page: SlackSourcePage;
      try {
        page = await this.#source.replies({
          conversationId: input.conversationId,
          parentTs: row.thread_ts,
          latest: barrier.value.through,
          ...(row.cursor === null ? {} : { cursor: row.cursor }),
        });
      } catch (error) {
        if (!isInvalidCursor(error)) throw error;
        this.#assertLive();
        const reset = this.#database
          .prepare(
            `UPDATE slack_reply_drains SET cursor = NULL
             WHERE intent_id = ? AND account_id = ? AND conversation_id = ? AND thread_ts = ? AND cursor IS ? AND drained_at IS NULL`,
          )
          .run(input.intentId, input.accountId, input.conversationId, row.thread_ts, row.cursor);
        if (Number(reset.changes) !== 1)
          throw new CommsError('APPROVAL_VOID', 'the Slack reply drain changed while its cursor was reset');
        return false;
      }
      stage = await stager.stage({
        owner,
        accountId: input.accountId,
        conversationId: input.conversationId,
        parentTs: row.thread_ts,
        generation: 1,
        cursorBefore: row.cursor,
        latest: barrier.value.through,
        page,
        lowerExclusive: row.thread_ts,
      });
    }
    if (stage === null) throw new CommsError('BAD_DATA', 'a Slack reply page was not staged before its cursor moved');
    const admission = await stager.admit({ stage, conversationId: input.conversationId });
    if (admission.outcome === 'pending') return false;
    stage = admission.stage;
    if (stage.value.retainedHistoryBoundary) return false;
    immediate(this.#database, () => {
      this.#assertLive();
      const updated = this.#database
        .prepare(
          `UPDATE slack_reply_drains SET cursor = ?, covered_through = ?, drained_at = ?
           WHERE intent_id = ? AND account_id = ? AND conversation_id = ? AND thread_ts = ? AND cursor IS ? AND drained_at IS NULL`,
        )
        .run(
          stage.value.nextCursor,
          stage.value.nextCursor === null ? barrier.value.through : row.covered_through,
          stage.value.nextCursor === null ? this.#now() : null,
          input.intentId,
          input.accountId,
          input.conversationId,
          row.thread_ts,
          row.cursor,
        );
      if (Number(updated.changes) !== 1)
        throw new CommsError('APPROVAL_VOID', 'the Slack reply drain changed while a page was admitted');
      stager.clearInTransaction(stage);
    });
    return stage.value.nextCursor === null;
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

  #advanceExpired(
    input: Readonly<{ intentId: string; accountId: string; conversationId: string }>,
    row: Readonly<{ thread_ts: string; cursor: string | null; covered_through: string }>,
    barrier: StoredBarrier,
    page: Readonly<{ nextCursor: string | null }>,
  ): boolean {
    this.#assertLive();
    const update = this.#database
      .prepare(
        `UPDATE slack_reply_drains SET cursor = ?, covered_through = ?, drained_at = ?
         WHERE intent_id = ? AND account_id = ? AND conversation_id = ? AND thread_ts = ? AND cursor IS ? AND drained_at IS NULL`,
      )
      .run(
        page.nextCursor,
        page.nextCursor === null ? barrier.value.through : row.covered_through,
        page.nextCursor === null ? this.#now() : null,
        input.intentId,
        input.accountId,
        input.conversationId,
        row.thread_ts,
        row.cursor,
      );
    if (Number(update.changes) !== 1)
      throw new CommsError('APPROVAL_VOID', 'the expired Slack reply stage changed before its cursor moved');
    return page.nextCursor === null;
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

/** Durable ordinary reply watermarks for parents observed in the preceding seven days. */
export class SlackReplyReconciler {
  readonly #database: DatabaseSync;
  readonly #source: SlackRepliesReader;
  readonly #scope: SourceScope;
  readonly #now: () => number;
  readonly #assertLive: () => void;
  readonly #encrypt: (value: unknown, id: string) => Promise<Uint8Array>;
  readonly #decrypt: (record: Uint8Array, id: string) => Promise<unknown>;
  readonly #stager: SlackReplyPageStager;

  constructor(input: {
    readonly database: DatabaseSync;
    readonly source: SlackRepliesReader;
    readonly assertLive: () => void;
    readonly now?: (() => number) | undefined;
    readonly encryptState: (value: unknown, id: string) => Promise<Uint8Array>;
    readonly decryptState: (record: Uint8Array, id: string) => Promise<unknown>;
    readonly stage: SlackReplyStageHooks;
  }) {
    this.#database = input.database;
    this.#source = input.source;
    this.#scope = input.stage.scope;
    this.#assertLive = input.assertLive;
    this.#now = input.now ?? Date.now;
    this.#encrypt = input.encryptState;
    this.#decrypt = input.decryptState;
    this.#stager = new SlackReplyPageStager({
      database: input.database,
      hooks: input.stage,
      assertLive: input.assertLive,
      now: this.#now,
      encrypt: input.encryptState,
      decrypt: input.decryptState,
    });
  }

  async discoverParent(
    input: Readonly<{ accountId: string; conversationId: string; parentTs: string }>,
  ): Promise<void> {
    assertSlackTimestamp(input.parentTs);
    const id = reconciliationId(input.accountId, input.conversationId, input.parentTs);
    if (this.#database.prepare('SELECT 1 AS present FROM source_scan_state WHERE id = ?').get(id) !== undefined) return;
    const value: SlackReplyReconciliationState = {
      kind: 'slack-reply-reconciliation-v1',
      parentTs: input.parentTs,
      observedAt: this.#now(),
      watermark: input.parentTs,
      latest: null,
      cursor: null,
      generation: 1,
      turn: 0,
    };
    const record = await this.#encrypt(value, id);
    this.#assertLive();
    immediate(this.#database, () => {
      this.#assertLive();
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES (?, 'slack', ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(id, input.accountId, this.#scope.scopeId, record, this.#now());
    });
  }

  /**
   * Parents already eligible for ordinary reconciliation which fall in a
   * replacement's frozen interval. History may have advanced beyond P before
   * the replacement begins, so its reply drain must inherit these parents
   * instead of relying on a later history page to rediscover them.
   */
  async parentsAtOrBefore(
    input: Readonly<{ accountId: string; conversationId: string; through: string }>,
  ): Promise<readonly string[]> {
    assertSlackTimestamp(input.through);
    const now = this.#now();
    return (await this.#states(input))
      .filter(
        (state) =>
          now - state.value.observedAt <= SEVEN_DAYS_MS &&
          compareSlackTimestamp(state.value.parentTs, input.through) <= 0,
      )
      .map((state) => state.value.parentTs)
      .sort(compareSlackTimestamp);
  }

  async resumeOne(input: Readonly<{ accountId: string; conversationId: string; latest: string }>): Promise<boolean> {
    assertSlackTimestamp(input.latest);
    const states = await this.#states(input);
    const now = this.#now();
    const eligible: StoredReconciliation[] = [];
    for (const state of states) {
      if (now - state.value.observedAt <= SEVEN_DAYS_MS || (await this.#hasStagedSettlement(input, state))) {
        eligible.push(state);
      } else {
        this.#dropExpired(state);
      }
    }
    const state = eligible.sort(
      (left, right) => left.value.turn - right.value.turn || left.id.localeCompare(right.id),
    )[0];
    if (state === undefined) return true;
    const turn = this.#nextTurn(eligible);
    let current = state;
    if (current.value.latest === null) {
      current = await this.#replace(current, {
        ...current.value,
        latest: input.latest,
        cursor: null,
        generation: current.value.generation + 1,
      });
    }
    const latest = current.value.latest;
    if (latest === null) throw new CommsError('BAD_DATA', 'a Slack reply scan lost its frozen boundary');
    const owner = `reconcile:${current.id}`;
    const expired = this.#stager.expiredContinuation({
      owner,
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentTs: current.value.parentTs,
      generation: current.value.generation,
      cursorBefore: current.value.cursor,
    });
    if (expired !== null) {
      if (expired.retainedHistoryBoundary) return false;
      const next: SlackReplyReconciliationState = {
        ...current.value,
        cursor: expired.nextCursor,
        watermark: expired.nextCursor === null ? latest : current.value.watermark,
        latest: expired.nextCursor === null ? null : latest,
        turn,
      };
      await this.#replace(current, next);
      return expired.nextCursor === null;
    }
    let stage = await this.#stager.load({
      owner,
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentTs: current.value.parentTs,
      generation: current.value.generation,
      cursorBefore: current.value.cursor,
    });
    if (stage === null) {
      let page: SlackSourcePage;
      try {
        page = await this.#source.replies({
          conversationId: input.conversationId,
          parentTs: current.value.parentTs,
          latest,
          ...(current.value.cursor === null ? {} : { cursor: current.value.cursor }),
        });
      } catch (error) {
        if (!isInvalidCursor(error)) throw error;
        await this.#replace(current, { ...current.value, cursor: null, generation: current.value.generation + 1 });
        return false;
      }
      stage = await this.#stager.stage({
        owner,
        accountId: input.accountId,
        conversationId: input.conversationId,
        parentTs: current.value.parentTs,
        generation: current.value.generation,
        cursorBefore: current.value.cursor,
        latest,
        page,
        lowerExclusive: current.value.watermark,
      });
    }
    const admission = await this.#stager.admit({ stage, conversationId: input.conversationId });
    if (admission.outcome === 'pending') return false;
    stage = admission.stage;
    if (stage.value.retainedHistoryBoundary) return false;
    const next: SlackReplyReconciliationState = {
      ...current.value,
      cursor: stage.value.nextCursor,
      watermark: stage.value.nextCursor === null ? latest : current.value.watermark,
      latest: stage.value.nextCursor === null ? null : latest,
      turn,
    };
    const record = await this.#encrypt(next, current.id);
    this.#assertLive();
    immediate(this.#database, () => {
      this.#assertLive();
      const updated = this.#database
        .prepare(
          'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
        )
        .run(record, this.#now(), current.id, current.record);
      if (Number(updated.changes) !== 1)
        throw new CommsError('APPROVAL_VOID', 'the Slack reply reconciliation changed while a page was admitted');
      this.#stager.clearInTransaction(stage);
    });
    return stage.value.nextCursor === null;
  }

  async #states(input: Readonly<{ accountId: string; conversationId: string }>): Promise<StoredReconciliation[]> {
    const rows = this.#database
      .prepare(
        "SELECT id, encrypted_record FROM source_scan_state WHERE source = 'slack' AND account_id = ? AND cursor_scope = ? AND id LIKE 'slack-reply-reconciliation:%'",
      )
      .all(input.accountId, this.#scope.scopeId) as Array<{ id: string; encrypted_record: Uint8Array }>;
    return Promise.all(rows.map((row) => this.#decode(row.id, row.encrypted_record, input.conversationId)));
  }

  async #hasStagedSettlement(
    input: Readonly<{ accountId: string; conversationId: string }>,
    state: StoredReconciliation,
  ): Promise<boolean> {
    if (state.value.latest === null) return false;
    const stageInput = {
      owner: `reconcile:${state.id}`,
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentTs: state.value.parentTs,
      generation: state.value.generation,
      cursorBefore: state.value.cursor,
    };
    if ((await this.#stager.load(stageInput)) !== null) return true;
    return this.#stager.expiredContinuation(stageInput) !== null;
  }

  #dropExpired(state: StoredReconciliation): void {
    immediate(this.#database, () => {
      this.#assertLive();
      const deleted = this.#database
        .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
        .run(state.id, state.record);
      if (Number(deleted.changes) !== 1)
        throw new CommsError('APPROVAL_VOID', 'the expired Slack reply reconciliation changed before it was pruned');
    });
  }

  async #replace(state: StoredReconciliation, next: SlackReplyReconciliationState): Promise<StoredReconciliation> {
    const record = await this.#encrypt(next, state.id);
    this.#assertLive();
    immediate(this.#database, () => {
      this.#assertLive();
      const updated = this.#database
        .prepare(
          'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
        )
        .run(record, this.#now(), state.id, state.record);
      if (Number(updated.changes) !== 1)
        throw new CommsError('APPROVAL_VOID', 'the Slack reply reconciliation changed while it was resumed');
    });
    return { id: state.id, value: next, record };
  }

  #nextTurn(states: readonly StoredReconciliation[]): number {
    const highest = Math.max(...states.map((state) => state.value.turn));
    if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER - 1)
      throw new CommsError('BAD_DATA', 'the Slack reply fair-order counter is invalid');
    return highest + 1;
  }

  async #decode(id: string, record: Uint8Array, conversationId: string): Promise<StoredReconciliation> {
    const prefix = 'slack-reply-reconciliation:';
    if (!id.startsWith(prefix)) throw new CommsError('BAD_DATA', 'a Slack reply reconciliation id is malformed');
    const value = (await this.#decrypt(record, id)) as Partial<SlackReplyReconciliationState>;
    if (
      value.kind !== 'slack-reply-reconciliation-v1' ||
      typeof value.parentTs !== 'string' ||
      !Number.isSafeInteger(value.observedAt) ||
      typeof value.watermark !== 'string' ||
      (value.latest !== null && typeof value.latest !== 'string') ||
      (value.cursor !== null && typeof value.cursor !== 'string') ||
      !Number.isSafeInteger(value.generation) ||
      !Number.isSafeInteger(value.turn)
    )
      throw new CommsError('BAD_DATA', 'a Slack reply reconciliation record is malformed');
    const identity = JSON.parse(Buffer.from(id.slice(prefix.length), 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(identity) ||
      identity.length !== 3 ||
      identity[1] !== conversationId ||
      identity[2] !== value.parentTs
    )
      throw new CommsError('BAD_DATA', 'a Slack reply reconciliation state has the wrong parent');
    assertSlackTimestamp(value.parentTs);
    assertSlackTimestamp(value.watermark);
    if (value.latest !== null) assertSlackTimestamp(value.latest);
    return { id, value: value as SlackReplyReconciliationState, record };
  }
}
