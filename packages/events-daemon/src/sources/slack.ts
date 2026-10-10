import { CommsError } from '@agentcomms/core';
import { normaliseSlackSourceOptions } from '../domain/source-options.ts';
import type { CutoverFailpoint } from '../runtime/cutover-failpoint.ts';
import type { AsyncSourceStageExpiry, PreparedSourceStageTerminalisation } from '../runtime/expiry.ts';
import type { EventDatabase } from '../store/database.ts';
import type { LocalEventSource } from './contracts.ts';
import {
  assertSourceWriteStillLive,
  type SourceScope,
  type SourceStageDebt,
  type SourceWriteSnapshot,
  StaleSourceWriteError,
  sourceStageRetentionForDebts,
} from './contracts.ts';
import type { SourceScopeLock } from './scope-lock.ts';

const SLACK_TIMESTAMP = /^[0-9]+\.[0-9]{6}$/u;

export interface SlackSourceMessage {
  readonly ts: string;
  readonly threadTs: string | null;
  readonly replyCount: number;
  readonly text: string;
  readonly [field: string]: unknown;
}

export interface SlackSourcePage {
  readonly messages: readonly SlackSourceMessage[];
  readonly nextCursor: string | null;
  readonly retainedHistoryBoundary: boolean;
}

export interface SlackHistoryReader {
  history(
    input: Readonly<{
      conversationId: string;
      oldest: string;
      latest: string;
      cursor?: string | undefined;
    }>,
  ): Promise<SlackSourcePage>;
}

export interface SlackHistoryRule extends SourceStageDebt {}

export interface SlackCandidate {
  readonly conversationId: string;
  readonly message: SlackSourceMessage;
}

interface SlackScanState {
  readonly kind: 'slack-history-scan-v1';
  readonly oldest: string;
  readonly latest: string;
  readonly cursor: string | null;
  readonly generation: number;
}

interface SlackPageStage {
  readonly kind: 'slack-history-page-v1';
  readonly scanGeneration: number;
  readonly cursorBefore: string | null;
  readonly nextCursor: string | null;
  readonly page: SlackSourcePage;
  readonly completed: readonly string[];
}

interface StoredScan {
  readonly state: SlackScanState;
  readonly record: Uint8Array;
}

interface StoredStage {
  readonly id: string;
  readonly value: SlackPageStage;
  readonly record: Uint8Array;
}

interface SlackWriteSnapshot extends SourceWriteSnapshot {
  readonly paused: number;
}

/**
 * A replacement drain observes the durable history state machine rather than inferring reply safety from its cursor.
 * The observer is intentionally narrow: discovery runs for top-level parents only, and coverage is announced only
 * after the final cursor transaction commits.
 */
export interface SlackReplacementObserver {
  onTopLevel(message: SlackSourceMessage): Promise<void>;
  onHistoryCovered(): Promise<void>;
}

export function assertSlackTimestamp(value: string): string {
  if (!SLACK_TIMESTAMP.test(value)) throw new CommsError('BAD_DATA', 'a Slack timestamp must have six decimal digits');
  return value;
}

/** Compares every timestamp digit exactly; numbers would conflate distinct Slack occurrences above 2^53. */
export function compareSlackTimestamp(left: string, right: string): -1 | 0 | 1 {
  const [leftSeconds, leftMicros] = assertSlackTimestamp(left).split('.') as [string, string];
  const [rightSeconds, rightMicros] = assertSlackTimestamp(right).split('.') as [string, string];
  const a = leftSeconds.replace(/^0+(?=\d)/u, '');
  const b = rightSeconds.replace(/^0+(?=\d)/u, '');
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  if (leftMicros === rightMicros) return 0;
  return leftMicros < rightMicros ? -1 : 1;
}

export function slackConversationScope(accountId: string, conversationId: string): SourceScope {
  if (accountId === '' || conversationId === '')
    throw new CommsError('BAD_DATA', 'a Slack conversation scope needs account and conversation ids');
  return { source: 'slack', accountId, scopeId: `slack:${accountId}:${conversationId}` };
}

/** The registered Slack adapter is deliberately structural: it owns scopes and locks, never a provider client. */
export function createSlackLocalEventSource(): LocalEventSource {
  return {
    source: 'slack',
    canonicalise: normaliseSlackSourceOptions,
    scopesFor: ({ accountId, options }) => {
      if (options === undefined) return [];
      const selected = normaliseSlackSourceOptions(options);
      return selected.conversations.map((conversationId) => slackConversationScope(accountId, conversationId));
    },
    withScopes: (lock, scopes, work) => lock.withScopes(scopes, work),
    baseline: (sample) => sample(),
    resume: (step) => step(),
    describeCursor: (cursor) => cursor,
    cleanup: (_kind, work) => Promise.resolve(work()),
  };
}

function scanId(accountId: string, conversationId: string): string {
  return `slack-history-scan:${Buffer.from(JSON.stringify([accountId, conversationId])).toString('base64url')}`;
}

function pageId(accountId: string, conversationId: string, state: SlackScanState, nextCursor: string | null): string {
  return `slack-history-page:${Buffer.from(
    JSON.stringify([accountId, conversationId, state.generation, state.cursor, nextCursor]),
  ).toString('base64url')}`;
}

function isInvalidCursor(error: unknown): boolean {
  if (error instanceof CommsError) return error.code === 'BAD_DATA' && error.details?.slackError === 'invalid_cursor';
  const candidate = error as { code?: unknown; slackError?: unknown; details?: { slackError?: unknown } };
  return (
    candidate?.code === 'BAD_DATA' &&
    (candidate.slackError === 'invalid_cursor' || candidate.details?.slackError === 'invalid_cursor')
  );
}

function topLevel(message: SlackSourceMessage): boolean {
  return message.threadTs === null || message.threadTs === message.ts;
}

export function slackOccurrenceKey(conversationId: string, timestamp: string): string {
  return JSON.stringify([conversationId, timestamp]);
}

function historyPageIdentity(id: string): {
  readonly accountId: string;
  readonly conversationId: string;
  readonly generation: number;
  readonly cursorBefore: string | null;
  readonly nextCursor: string | null;
} | null {
  if (!id.startsWith('slack-history-page:')) return null;
  try {
    const values = JSON.parse(
      Buffer.from(id.slice('slack-history-page:'.length), 'base64url').toString('utf8'),
    ) as unknown;
    if (!Array.isArray(values) || values.length !== 5) return null;
    const [accountId, conversationId, generation, cursorBefore, nextCursor] = values;
    if (
      typeof accountId !== 'string' ||
      typeof conversationId !== 'string' ||
      !Number.isSafeInteger(generation) ||
      (cursorBefore !== null && typeof cursorBefore !== 'string') ||
      (nextCursor !== null && typeof nextCursor !== 'string')
    )
      return null;
    return { accountId, conversationId, generation, cursorBefore, nextCursor };
  } catch {
    return null;
  }
}

/** Common start-up/tick expiry for Slack history pages, including their content-free scan continuation. */
export class SlackHistoryStageExpiry implements AsyncSourceStageExpiry {
  readonly #store: EventDatabase;
  readonly #lock: SourceScopeLock;
  readonly #decrypt: (record: Uint8Array, id: string) => Promise<unknown>;
  readonly #encrypt: (value: unknown, id: string) => Promise<Uint8Array>;
  readonly #now: () => number;

  constructor(
    input: Readonly<{
      store: EventDatabase;
      lock: SourceScopeLock;
      decrypt: (record: Uint8Array, id: string) => Promise<unknown>;
      encrypt: (value: unknown, id: string) => Promise<Uint8Array>;
      now?: (() => number) | undefined;
    }>,
  ) {
    this.#store = input.store;
    this.#lock = input.lock;
    this.#decrypt = input.decrypt;
    this.#encrypt = input.encrypt;
    this.#now = input.now ?? Date.now;
  }

  async sweep(): Promise<number> {
    const rows = this.#store.database
      .prepare(
        `SELECT id, account_id FROM source_scan_state
         WHERE source = 'slack' AND id LIKE 'slack-history-page:%'
           AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
      )
      .all(this.#now()) as Array<{ id: string; account_id: string }>;
    let expired = 0;
    for (const row of rows) {
      const identity = historyPageIdentity(row.id);
      if (identity === null || identity.accountId !== row.account_id) continue;
      expired += await this.#lock.withScope(slackConversationScope(identity.accountId, identity.conversationId), () =>
        this.#expire(row.id, identity),
      );
    }
    return expired;
  }

  async prepareRetentionTightening(input: {
    readonly ruleId: string;
    readonly ingestRetentionMs: number;
    readonly now: number;
  }): Promise<readonly PreparedSourceStageTerminalisation[]> {
    const rows = this.#store.database
      .prepare(
        `SELECT state.id, state.account_id
           FROM source_scan_state AS state
          WHERE state.source = 'slack' AND state.id LIKE 'slack-history-page:%'
            AND state.staged_at IS NOT NULL AND state.staged_at + ? <= ?
            AND EXISTS (
              SELECT 1 FROM source_stage_rule_debts AS debt
               WHERE debt.stage_id = state.id AND debt.rule_id = ?
            )`,
      )
      .all(input.ingestRetentionMs, input.now, input.ruleId) as Array<{ id: string; account_id: string }>;
    const prepared: PreparedSourceStageTerminalisation[] = [];
    for (const row of rows) {
      const identity = historyPageIdentity(row.id);
      if (identity === null || identity.accountId !== row.account_id) continue;
      const terminalisation = await this.#prepareTerminalisation(row.id, identity, input.now, false);
      if (terminalisation !== undefined) prepared.push(terminalisation);
    }
    return prepared;
  }

  async #expire(stageId: string, identity: NonNullable<ReturnType<typeof historyPageIdentity>>): Promise<number> {
    const terminalisation = await this.#prepareTerminalisation(stageId, identity, this.#now());
    return terminalisation === undefined ? 0 : this.#store.immediate(() => terminalisation.terminaliseInTransaction());
  }

  async #prepareTerminalisation(
    stageId: string,
    identity: NonNullable<ReturnType<typeof historyPageIdentity>>,
    at: number,
    requireDue = true,
  ): Promise<PreparedSourceStageTerminalisation | undefined> {
    const row = this.#store.database
      .prepare(
        `SELECT encrypted_record, stage_expires_at FROM source_scan_state
         WHERE id = ? AND stage_expires_at IS NOT NULL
           AND (? = 0 OR stage_expires_at <= ?)`,
      )
      .get(stageId, requireDue ? 1 : 0, at) as { encrypted_record: Uint8Array; stage_expires_at: number } | undefined;
    if (row === undefined) return undefined;
    const value = (await this.#decrypt(row.encrypted_record, stageId)) as SlackPageStage;
    if (
      value.kind !== 'slack-history-page-v1' ||
      value.scanGeneration !== identity.generation ||
      value.cursorBefore !== identity.cursorBefore ||
      value.nextCursor !== identity.nextCursor ||
      !Array.isArray(value.completed)
    )
      throw new CommsError('BAD_DATA', 'an expired Slack history stage is malformed');
    const scanIdForPage = scanId(identity.accountId, identity.conversationId);
    const scan = this.#store.database
      .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
      .get(scanIdForPage) as { encrypted_record: Uint8Array } | undefined;
    if (scan === undefined) return undefined;
    const scanState = (await this.#decrypt(scan.encrypted_record, scanIdForPage)) as SlackScanState;
    if (
      scanState.kind !== 'slack-history-scan-v1' ||
      scanState.generation !== identity.generation ||
      scanState.cursor !== identity.cursorBefore
    )
      return undefined;
    const next = { ...scanState, cursor: identity.nextCursor };
    const continuation = await this.#encrypt(next, scanIdForPage);
    const occurrenceKeys = value.page.messages
      .filter((message) => topLevel(message) && !value.completed.includes(message.ts))
      .map((message) => {
        assertSlackTimestamp(message.ts);
        return slackOccurrenceKey(identity.conversationId, message.ts);
      });
    return {
      terminaliseInTransaction: () => {
        const current = this.#store.database
          .prepare(
            `SELECT 1 AS present FROM source_scan_state
           WHERE id = ? AND encrypted_record = ? AND stage_expires_at <= ?`,
          )
          .get(stageId, row.encrypted_record, at) as { present: number } | undefined;
        if (current === undefined) return 0;
        const scanCurrent = this.#store.database
          .prepare('SELECT 1 AS present FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
          .get(scanIdForPage, scan.encrypted_record) as { present: number } | undefined;
        if (scanCurrent === undefined) return 0;
        const now = at;
        const resolution = this.#store.database.prepare(
          `INSERT OR IGNORE INTO source_occurrence_resolutions
         (source, account_id, occurrence_key, outcome, resolved_at, error_code)
         VALUES ('slack', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
        );
        for (const occurrenceKey of occurrenceKeys) resolution.run(identity.accountId, occurrenceKey, now);
        const advanced = this.#store.database
          .prepare(
            'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
          )
          .run(continuation, now, scanIdForPage, scan.encrypted_record);
        if (Number(advanced.changes) !== 1) return 0;
        const deleted = this.#store.database
          .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ? AND stage_expires_at <= ?')
          .run(stageId, row.encrypted_record, at);
        if (Number(deleted.changes) !== 1) return 0;
        this.#store.database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(stageId);
        if (next.cursor === null) {
          this.#store.database
            .prepare(
              `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, ?, ?)
             ON CONFLICT(source, account_id, cursor_scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
            )
            .run(identity.accountId, `slack:${identity.accountId}:${identity.conversationId}`, next.latest, now);
          this.#store.database
            .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
            .run(scanIdForPage, continuation);
          this.#store.database
            .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
            .run(
              `slack-expired-history:${identity.accountId}:${identity.conversationId}:${next.latest}`,
              'event.source.expired-continuation',
              now,
            );
        }
        this.#store.database
          .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
          .run(
            `source-retention-expired:slack:${identity.accountId}:${stageId}`,
            'event.source.retention-expired',
            now,
          );
        return 1;
      },
    };
  }
}

function assertTaintedMessage(message: SlackSourceMessage): void {
  if (!/^<untrusted-content\b[^>]*>[\s\S]*<\/untrusted-content(?:\s[^>]*)?>$/u.test(message.text))
    throw new CommsError('BAD_DATA', 'a Slack event message arrived without its untrusted-content envelope');
}

/**
 * Resumes one conversation's fixed `[oldest, latest]` history interval. The channel package supplies only
 * normalised pages; this daemon-owned state machine owns stage retention, persistence, and the watermark.
 */
export class SlackHistorySource {
  readonly #store: EventDatabase;
  readonly #accountId: string;
  readonly #source: SlackHistoryReader;
  readonly #lock: SourceScopeLock;
  readonly #rules: () => readonly SlackHistoryRule[];
  readonly #admit: (candidate: SlackCandidate) => Promise<'terminal' | 'pending'>;
  readonly #encryptStage: (value: unknown, id: string) => Promise<Uint8Array>;
  readonly #decryptStage: (record: Uint8Array, id: string) => Promise<unknown>;
  readonly #accountLive: () => Promise<void>;
  readonly #replacementObserver: SlackReplacementObserver | undefined;
  readonly #now: () => number;
  readonly #failpoint: CutoverFailpoint | undefined;

  constructor(
    options: Readonly<{
      store: EventDatabase;
      accountId: string;
      source: SlackHistoryReader;
      lock: SourceScopeLock;
      rules: () => readonly SlackHistoryRule[];
      admit: (candidate: SlackCandidate) => Promise<'terminal' | 'pending'>;
      encryptStage: (value: unknown, id: string) => Promise<Uint8Array>;
      decryptStage: (record: Uint8Array, id: string) => Promise<unknown>;
      /** Re-reads the account from core's current configuration at each provider/write boundary. */
      accountLive: () => Promise<void>;
      /** Optional replacement-drain observer; it cannot advance a history cursor or admit a candidate. */
      replacementObserver?: SlackReplacementObserver | undefined;
      now?: (() => number) | undefined;
      /** Optional D8 crash seam; omitted in production. */
      failpoint?: CutoverFailpoint | undefined;
    }>,
  ) {
    this.#store = options.store;
    this.#accountId = options.accountId;
    this.#source = options.source;
    this.#lock = options.lock;
    this.#rules = options.rules;
    this.#admit = options.admit;
    this.#encryptStage = options.encryptStage;
    this.#decryptStage = options.decryptStage;
    this.#accountLive = options.accountLive;
    this.#replacementObserver = options.replacementObserver;
    this.#now = options.now ?? Date.now;
    this.#failpoint = options.failpoint;
  }

  async scan(
    input: Readonly<{
      conversationId: string;
      latest: string;
      maxPages?: number | undefined;
    }>,
  ): Promise<{ readonly watermark: string | null; readonly pending: boolean }> {
    assertSlackTimestamp(input.latest);
    const scope = slackConversationScope(this.#accountId, input.conversationId);
    return this.#lock.withScope(scope, () => this.#scanLocked(scope, input));
  }

  async #scanLocked(
    scope: SourceScope,
    input: Readonly<{ conversationId: string; latest: string; maxPages?: number | undefined }>,
  ): Promise<{ readonly watermark: string | null; readonly pending: boolean }> {
    const watermark = this.#watermark(scope);
    if (watermark === null) return { watermark: null, pending: false };
    // Only an explicitly expired interval can suppress a same-bound retry. Ordinary completed scans still run their
    // durable-edge checks even when a scheduler happens to sample the same latest timestamp twice.
    if (this.#expiredBoundCovered(scope, input.conversationId, input.latest)) return { watermark, pending: false };
    const rules = this.#rules();
    if (rules.length === 0) return { watermark, pending: false };
    const snapshot = this.#snapshot(rules);
    // Existing content-free expiry continuations must settle after disable/pause. A fresh history scan cannot start.
    if (this.#fenced(scope, snapshot) && !this.#hasScan(scope)) return { watermark, pending: true };
    try {
      let scan = await this.#loadOrBegin(scope, watermark, input.latest, snapshot, rules);
      const maxPages = input.maxPages ?? 10;
      if (!Number.isSafeInteger(maxPages) || maxPages < 1)
        throw new CommsError('BAD_DATA', 'a Slack scan needs a positive page budget');
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const expired = await this.#continueExpiredStage(scope, input.conversationId, scan);
        if (expired !== undefined) {
          if (expired.complete) return { watermark: scan.state.latest, pending: false };
          scan = expired.scan;
          continue;
        }
        if (this.#fenced(scope, snapshot)) return { watermark: scan.state.oldest, pending: true };
        let stage = await this.#loadStage(scope, input.conversationId, scan);
        if (stage === null) {
          try {
            await this.#accountLive();
            const page = await this.#source.history({
              conversationId: input.conversationId,
              oldest: scan.state.oldest,
              latest: scan.state.latest,
              ...(scan.state.cursor === null ? {} : { cursor: scan.state.cursor }),
            });
            this.#failpoint?.('before-stage');
            stage = await this.#stagePage(scope, input.conversationId, scan, page, snapshot, rules);
            this.#failpoint?.('after-stage');
          } catch (error) {
            if (isInvalidCursor(error)) {
              scan = await this.#restartWithoutCursor(scope, scan, snapshot, rules);
              return { watermark: scan.state.oldest, pending: true };
            }
            throw error;
          }
        }
        const result = await this.#processStage(scope, input.conversationId, scan, stage, snapshot, rules);
        if (result.pending) return { watermark: scan.state.oldest, pending: true };
        if (result.complete) return { watermark: scan.state.latest, pending: false };
        scan = result.scan;
      }
      return { watermark: scan.state.oldest, pending: true };
    } catch (error) {
      if (error instanceof StaleSourceWriteError) return { watermark: this.#watermark(scope), pending: true };
      throw error;
    }
  }

  #snapshot(rules: readonly SlackHistoryRule[]): SlackWriteSnapshot {
    const settings = this.#store.database
      .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
    return {
      generation: settings?.switch_generation ?? 0,
      enabled: settings?.enabled ?? 0,
      startedAt: this.#now(),
      paused: settings?.paused ?? 0,
      rules: rules
        .map((rule) => `${rule.ruleId}@${rule.ruleVersion}`)
        .sort()
        .join(','),
    };
  }

  #fenced(scope: SourceScope, snapshot: SlackWriteSnapshot): boolean {
    try {
      if (snapshot.enabled !== 1 || snapshot.paused !== 0) return true;
      assertSourceWriteStillLive(this.#store.database, scope, snapshot, () => this.#rules());
      return false;
    } catch (error) {
      if (error instanceof StaleSourceWriteError) return true;
      throw error;
    }
  }

  #watermark(scope: SourceScope): string | null {
    const row = this.#store.database
      .prepare("SELECT cursor FROM cursors WHERE source = 'slack' AND account_id = ? AND cursor_scope = ?")
      .get(scope.accountId, scope.scopeId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  #hasScan(scope: SourceScope): boolean {
    return (
      this.#store.database
        .prepare('SELECT 1 AS present FROM source_scan_state WHERE id = ?')
        .get(scanId(scope.accountId, this.#conversationFromScope(scope))) !== undefined
    );
  }

  #expiredBoundCovered(scope: SourceScope, conversationId: string, latest: string): boolean {
    return (
      this.#store.database
        .prepare('SELECT 1 AS present FROM operational_records WHERE id = ?')
        .get(`slack-expired-history:${scope.accountId}:${conversationId}:${latest}`) !== undefined
    );
  }

  async #loadOrBegin(
    scope: SourceScope,
    oldest: string,
    latest: string,
    snapshot: SlackWriteSnapshot,
    rules: readonly SlackHistoryRule[],
  ): Promise<StoredScan> {
    const id = scanId(scope.accountId, this.#conversationFromScope(scope));
    const row = this.#store.database.prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?').get(id) as
      | { encrypted_record: Uint8Array }
      | undefined;
    if (row !== undefined) return this.#decodeScan(row.encrypted_record, id);
    const state: SlackScanState = { kind: 'slack-history-scan-v1', oldest, latest, cursor: null, generation: 1 };
    const record = await this.#encryptStage(state, id);
    await this.#accountLive();
    this.#store.immediate(() => {
      this.#assertCurrent(scope, snapshot, rules);
      this.#store.database
        .prepare(
          `INSERT OR IGNORE INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES (?, 'slack', ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(id, scope.accountId, scope.scopeId, record, this.#now());
    });
    const persisted = this.#store.database
      .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
      .get(id) as {
      encrypted_record: Uint8Array;
    };
    return this.#decodeScan(persisted.encrypted_record, id);
  }

  async #decodeScan(record: Uint8Array, id: string): Promise<StoredScan> {
    const value = (await this.#decryptStage(record, id)) as Partial<SlackScanState>;
    if (
      value.kind !== 'slack-history-scan-v1' ||
      typeof value.oldest !== 'string' ||
      typeof value.latest !== 'string' ||
      (value.cursor !== null && typeof value.cursor !== 'string') ||
      !Number.isSafeInteger(value.generation)
    )
      throw new CommsError('BAD_DATA', 'a Slack history scan record is malformed');
    assertSlackTimestamp(value.oldest);
    assertSlackTimestamp(value.latest);
    // Slack pagination cursors are opaque provider bytes, not timestamps.
    return { state: value as SlackScanState, record };
  }

  async #loadStage(scope: SourceScope, conversationId: string, scan: StoredScan): Promise<StoredStage | null> {
    const rows = this.#store.database
      .prepare(
        "SELECT id, encrypted_record FROM source_scan_state WHERE source = 'slack' AND id LIKE 'slack-history-page:%'",
      )
      .all() as Array<{ id: string; encrypted_record: Uint8Array }>;
    const row = rows.find((candidate) => {
      const identity = this.#pageIdentity(candidate.id);
      return (
        identity !== null &&
        identity.accountId === scope.accountId &&
        identity.conversationId === conversationId &&
        identity.generation === scan.state.generation &&
        identity.cursorBefore === scan.state.cursor
      );
    });
    if (row === undefined) return null;
    const value = (await this.#decryptStage(row.encrypted_record, row.id)) as Partial<SlackPageStage>;
    if (
      value.kind !== 'slack-history-page-v1' ||
      value.scanGeneration !== scan.state.generation ||
      value.cursorBefore !== scan.state.cursor ||
      !Array.isArray(value.completed) ||
      value.page === undefined
    )
      throw new CommsError('BAD_DATA', 'a Slack history page stage is malformed');
    return { id: row.id, value: value as SlackPageStage, record: row.encrypted_record };
  }

  async #stagePage(
    scope: SourceScope,
    conversationId: string,
    scan: StoredScan,
    page: SlackSourcePage,
    snapshot: SlackWriteSnapshot,
    rules: readonly SlackHistoryRule[],
  ): Promise<StoredStage> {
    for (const message of page.messages) assertTaintedMessage(message);
    const id = pageId(scope.accountId, conversationId, scan.state, page.nextCursor);
    const current = await this.#loadStage(scope, conversationId, scan);
    if (current !== null) return current;
    const value: SlackPageStage = {
      kind: 'slack-history-page-v1',
      scanGeneration: scan.state.generation,
      cursorBefore: scan.state.cursor,
      nextCursor: page.nextCursor,
      page,
      completed: [],
    };
    const record = await this.#encryptStage(value, id);
    const retention = sourceStageRetentionForDebts(this.#now(), rules);
    await this.#accountLive();
    this.#store.immediate(() => {
      this.#assertCurrent(scope, snapshot, rules);
      const held = this.#store.database
        .prepare('UPDATE source_scan_state SET updated_at = updated_at WHERE id = ? AND encrypted_record = ?')
        .run(scanId(scope.accountId, conversationId), scan.record);
      if (Number(held.changes) !== 1) throw new StaleSourceWriteError();
      this.#store.database
        .prepare(
          `INSERT OR IGNORE INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES (?, 'slack', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, scope.accountId, scope.scopeId, retention.stagedAt, retention.stageExpiresAt, record, this.#now());
      for (const rule of rules) {
        this.#store.database
          .prepare(`INSERT OR IGNORE INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, ?)`)
          .run(id, rule.ruleId, rule.ruleVersion);
      }
    });
    return { id, value, record };
  }

  async #processStage(
    scope: SourceScope,
    conversationId: string,
    scan: StoredScan,
    stage: StoredStage,
    snapshot: SlackWriteSnapshot,
    rules: readonly SlackHistoryRule[],
  ): Promise<{ readonly pending: boolean; readonly complete: boolean; readonly scan: StoredScan }> {
    if (this.#stageExpired(stage.id)) {
      return this.#expireKnownStage(scope, conversationId, scan, stage);
    }
    let current = stage;
    for (const message of current.value.page.messages) {
      assertSlackTimestamp(message.ts);
      if (!topLevel(message)) continue;
      if (
        compareSlackTimestamp(message.ts, scan.state.oldest) <= 0 ||
        compareSlackTimestamp(message.ts, scan.state.latest) > 0 ||
        current.value.completed.includes(message.ts)
      )
        continue;
      if (this.#isResolved(scope, conversationId, message.ts)) {
        const next: SlackPageStage = { ...current.value, completed: [...current.value.completed, message.ts] };
        const encrypted = await this.#encryptStage(next, current.id);
        await this.#accountLive();
        this.#store.immediate(() => {
          this.#assertCurrent(scope, snapshot, rules);
          const updated = this.#store.database
            .prepare(
              'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
            )
            .run(encrypted, this.#now(), current.id, current.record);
          if (Number(updated.changes) !== 1) throw new StaleSourceWriteError();
        });
        current = { id: current.id, value: next, record: encrypted };
        continue;
      }
      const result = await this.#admit({ conversationId, message });
      if (result === 'pending') return { pending: true, complete: false, scan };
      await this.#replacementObserver?.onTopLevel(message);
      const next: SlackPageStage = { ...current.value, completed: [...current.value.completed, message.ts] };
      const encrypted = await this.#encryptStage(next, current.id);
      await this.#accountLive();
      this.#store.immediate(() => {
        this.#assertCurrent(scope, snapshot, rules);
        const updated = this.#store.database
          .prepare(
            'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
          )
          .run(encrypted, this.#now(), current.id, current.record);
        if (Number(updated.changes) !== 1) throw new StaleSourceWriteError();
      });
      current = { id: current.id, value: next, record: encrypted };
    }
    this.#failpoint?.('before-move');
    const result = await this.#advanceAfterStage(scope, conversationId, scan, current, snapshot, rules);
    this.#failpoint?.('after-move');
    return result;
  }

  async #advanceAfterStage(
    scope: SourceScope,
    conversationId: string,
    scan: StoredScan,
    stage: StoredStage,
    snapshot: SlackWriteSnapshot,
    rules: readonly SlackHistoryRule[],
  ): Promise<{ readonly pending: boolean; readonly complete: boolean; readonly scan: StoredScan }> {
    const nextState: SlackScanState = { ...scan.state, cursor: stage.value.nextCursor };
    const nextRecord = await this.#encryptStage(nextState, scanId(scope.accountId, conversationId));
    await this.#accountLive();
    let complete = false;
    this.#store.immediate(() => {
      this.#assertCurrent(scope, snapshot, rules);
      const advanced = this.#store.database
        .prepare(
          'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
        )
        .run(nextRecord, this.#now(), scanId(scope.accountId, conversationId), scan.record);
      if (Number(advanced.changes) !== 1) throw new StaleSourceWriteError();
      this.#store.database
        .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
        .run(stage.id, stage.record);
      if (stage.value.page.retainedHistoryBoundary) {
        this.#store.database
          .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
          .run(
            `slack-retained-history:${scope.accountId}:${conversationId}:${scan.state.oldest}:${scan.state.latest}`,
            'agentcomms.source.gap',
            this.#now(),
          );
      }
      if (nextState.cursor === null) {
        this.#store.database
          .prepare(
            `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, ?, ?)
             ON CONFLICT(source, account_id, cursor_scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
          )
          .run(scope.accountId, scope.scopeId, nextState.latest, this.#now());
        this.#store.database
          .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
          .run(scanId(scope.accountId, conversationId), nextRecord);
        complete = true;
      }
    });
    if (complete) await this.#replacementObserver?.onHistoryCovered();
    return { pending: false, complete, scan: { state: nextState, record: nextRecord } };
  }

  async #restartWithoutCursor(
    scope: SourceScope,
    scan: StoredScan,
    snapshot: SlackWriteSnapshot,
    rules: readonly SlackHistoryRule[],
  ): Promise<StoredScan> {
    const state: SlackScanState = { ...scan.state, cursor: null, generation: scan.state.generation + 1 };
    const record = await this.#encryptStage(state, scanId(scope.accountId, this.#conversationFromScope(scope)));
    await this.#accountLive();
    this.#store.immediate(() => {
      this.#assertCurrent(scope, snapshot, rules);
      const reset = this.#store.database
        .prepare(
          'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
        )
        .run(record, this.#now(), scanId(scope.accountId, this.#conversationFromScope(scope)), scan.record);
      if (Number(reset.changes) !== 1) throw new StaleSourceWriteError();
    });
    return { state, record };
  }

  async #continueExpiredStage(
    scope: SourceScope,
    conversationId: string,
    scan: StoredScan,
  ): Promise<{ readonly complete: boolean; readonly scan: StoredScan } | undefined> {
    const rows = this.#store.database
      .prepare("SELECT occurrence_key FROM source_occurrence_resolutions WHERE source = 'slack' AND account_id = ?")
      .all(scope.accountId) as Array<{ occurrence_key: string }>;
    const row = rows.find((candidate) => {
      const identity = this.#pageIdentity(candidate.occurrence_key);
      return (
        identity !== null &&
        identity.accountId === scope.accountId &&
        identity.conversationId === conversationId &&
        identity.generation === scan.state.generation &&
        identity.cursorBefore === scan.state.cursor
      );
    });
    if (row === undefined) return undefined;
    const decoded = this.#pageIdentity(row.occurrence_key);
    if (decoded === null) return undefined;
    const continuation: SlackPageStage = {
      kind: 'slack-history-page-v1',
      scanGeneration: scan.state.generation,
      cursorBefore: scan.state.cursor,
      nextCursor: decoded.nextCursor,
      page: { messages: [], nextCursor: decoded.nextCursor, retainedHistoryBoundary: false },
      completed: [],
    };
    const fake: StoredStage = { id: row.occurrence_key, value: continuation, record: new Uint8Array() };
    const result = await this.#advanceAfterExpiredContinuation(scope, conversationId, scan, fake);
    return { complete: result.complete, scan: result.scan };
  }

  async #expireKnownStage(
    scope: SourceScope,
    conversationId: string,
    scan: StoredScan,
    stage: StoredStage,
  ): Promise<{ readonly pending: boolean; readonly complete: boolean; readonly scan: StoredScan }> {
    this.#store.immediate(() => {
      const deleted = this.#store.database
        .prepare(
          `DELETE FROM source_scan_state
           WHERE id = ? AND encrypted_record = ? AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
        )
        .run(stage.id, stage.record, this.#now());
      if (Number(deleted.changes) !== 1) throw new StaleSourceWriteError();
      const resolution = this.#store.database.prepare(
        `INSERT OR IGNORE INTO source_occurrence_resolutions
         (source, account_id, occurrence_key, outcome, resolved_at, error_code)
         VALUES ('slack', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
      );
      for (const message of stage.value.page.messages) {
        if (!topLevel(message) || stage.value.completed.includes(message.ts)) continue;
        resolution.run(scope.accountId, slackOccurrenceKey(conversationId, message.ts), this.#now());
      }
      this.#store.database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(stage.id);
    });
    const advanced = await this.#advanceAfterExpiredContinuation(scope, conversationId, scan, stage);
    return { pending: false, ...advanced };
  }

  async #advanceAfterExpiredContinuation(
    scope: SourceScope,
    conversationId: string,
    scan: StoredScan,
    stage: StoredStage,
  ): Promise<{ readonly complete: boolean; readonly scan: StoredScan }> {
    const state: SlackScanState = { ...scan.state, cursor: stage.value.nextCursor };
    const record = await this.#encryptStage(state, scanId(scope.accountId, conversationId));
    this.#store.immediate(() => {
      // This is a content-free expiry continuation, so it must settle even after the ordinary source fence moved.
      const advanced = this.#store.database
        .prepare(
          'UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ? AND encrypted_record = ?',
        )
        .run(record, this.#now(), scanId(scope.accountId, conversationId), scan.record);
      if (Number(advanced.changes) !== 1) throw new StaleSourceWriteError();
      if (state.cursor === null) {
        this.#store.database
          .prepare(
            `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, ?, ?)
             ON CONFLICT(source, account_id, cursor_scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
          )
          .run(scope.accountId, scope.scopeId, state.latest, this.#now());
        this.#store.database
          .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
          .run(scanId(scope.accountId, conversationId), record);
      }
    });
    return { complete: state.cursor === null, scan: { state, record } };
  }

  #stageExpired(id: string): boolean {
    const row = this.#store.database.prepare('SELECT stage_expires_at FROM source_scan_state WHERE id = ?').get(id) as
      | { stage_expires_at: number | null }
      | undefined;
    return row?.stage_expires_at !== null && row?.stage_expires_at !== undefined && row.stage_expires_at <= this.#now();
  }

  #isResolved(scope: SourceScope, conversationId: string, timestamp: string): boolean {
    return (
      this.#store.database
        .prepare(
          `SELECT 1 AS present FROM source_occurrence_resolutions
           WHERE source = 'slack' AND account_id = ? AND occurrence_key = ?`,
        )
        .get(scope.accountId, slackOccurrenceKey(conversationId, timestamp)) !== undefined
    );
  }

  #assertCurrent(scope: SourceScope, snapshot: SlackWriteSnapshot, rules: readonly SlackHistoryRule[]): void {
    const settings = this.#store.database.prepare('SELECT paused FROM event_settings WHERE singleton = 1').get() as
      | { paused: number }
      | undefined;
    if (settings === undefined || settings.paused !== snapshot.paused || settings.paused !== 0)
      throw new StaleSourceWriteError();
    assertSourceWriteStillLive(this.#store.database, scope, snapshot, () => {
      const current = this.#rules();
      // The callback above is the authoritative set. `rules` only keeps the input type visible at the write site.
      void rules;
      return current;
    });
  }

  #conversationFromScope(scope: SourceScope): string {
    const prefix = `slack:${scope.accountId}:`;
    if (!scope.scopeId.startsWith(prefix) || scope.scopeId.length === prefix.length)
      throw new CommsError('BAD_DATA', 'a Slack scope is not a conversation');
    return scope.scopeId.slice(prefix.length);
  }

  #pageIdentity(id: string): {
    readonly accountId: string;
    readonly conversationId: string;
    readonly generation: number;
    readonly cursorBefore: string | null;
    readonly nextCursor: string | null;
  } | null {
    return historyPageIdentity(id);
  }
}
