import { CommsError, neutralise, sanitizeHtmlToText, sanitizePlainText, stripInvisible } from '@agentcomms/core';
import { normaliseResendSourceOptions } from '../domain/source-options.ts';
import type { CutoverFailpoint } from '../runtime/cutover-failpoint.ts';
import type { AsyncSourceStageExpiry } from '../runtime/expiry.ts';
import type { EventDatabase } from '../store/database.ts';
import { DAY_MS, resolveStageRetryDeadline } from '../store/retention.ts';
import type { LocalEventSource, SourceScope, SourceStageDebt } from './contracts.ts';
import { sourceStageRetentionForDebts } from './contracts.ts';
import { SourceScopeLock } from './scope-lock.ts';
import { isSourceScopeFenced } from './source-scope-fence.ts';

export interface ResendReceivedCandidate {
  readonly emailId: string;
  readonly receivedAt: string;
  readonly subject: string;
  readonly body?: string | undefined;
  readonly bodyTruncated?: boolean | undefined;
  /** The channel reader supplies these already-sanitised plain candidate facts. */
  readonly from?: Readonly<{ address: string; name: string | null }> | null | undefined;
  readonly replyTo?: readonly Readonly<{ address: string; name: string | null }>[] | undefined;
  readonly to?: readonly string[] | undefined;
  readonly cc?: readonly string[] | undefined;
  readonly receivedFor?: readonly string[] | undefined;
  readonly messageId?: string | null | undefined;
  readonly attachmentCount?: number | undefined;
  readonly attachments?:
    | readonly Readonly<{
        id: string;
        filename: string;
        riskFlags: readonly string[];
        contentType: string | null;
        size: number | null;
        inline: boolean;
      }>[]
    | undefined;
  readonly authentication?:
    | Readonly<{ spf: string | null; dkim: string | null; dmarc: string | null; evaluatedBy: 'resend' | null }>
    | undefined;
}

export interface ResendSentItem {
  readonly id: string;
  readonly lastEvent: string;
  readonly from: Readonly<{ address: string; name: string | null }> | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly createdAt: string | null;
  readonly scheduledAt: string | null;
  readonly messageId: string | null;
}

export interface ResendEventReader {
  listReceived(after?: string): Promise<Readonly<{ emails: readonly Readonly<{ id: string }>[]; next: string | null }>>;
  getReceived(
    id: string,
  ): Promise<Readonly<{ kind: 'candidate'; candidate: ResendReceivedCandidate }> | Readonly<{ kind: 'vanished' }>>;
  listSent(after?: string): Promise<
    Readonly<{
      emails: readonly ResendSentItem[];
      next: string | null;
    }>
  >;
}

interface ReceivedState {
  readonly anchorId: string;
  readonly cycleHeadId: string | null;
  readonly after: string | null;
  readonly pagesScanned: number;
  readonly items: readonly string[];
  readonly candidate?: ResendReceivedCandidate | undefined;
  readonly retry?:
    | Readonly<{ emailId: string; firstFailedAt: number; nextRetryAt: number; attempts: number; errorCode: string }>
    | undefined;
}

const RECEIVED_SCOPE = 'received';
const EMPTY = 'empty';
const MAX_PAGES = 10;

/**
 * Common start-up/tick expiry for Resend's encrypted received stages. It keeps only the durable anchor/cycle
 * continuation, resolves every still-unsettled received id, and never asks the provider to reconstruct expired data.
 */
export class ResendReceivedStageExpiry implements AsyncSourceStageExpiry {
  readonly #store: EventDatabase;
  readonly #decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
  readonly #encrypt: (value: ReceivedState, id: string) => Promise<Uint8Array>;
  readonly #lock: SourceScopeLock;
  readonly #now: () => number;

  constructor(
    input: Readonly<{
      store: EventDatabase;
      decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
      encrypt: (value: ReceivedState, id: string) => Promise<Uint8Array>;
      lock: SourceScopeLock;
      now?: (() => number) | undefined;
    }>,
  ) {
    this.#store = input.store;
    this.#decrypt = input.decrypt;
    this.#encrypt = input.encrypt;
    this.#lock = input.lock;
    this.#now = input.now ?? Date.now;
  }

  async sweep(): Promise<number> {
    const accounts = this.#store.database
      .prepare(
        `SELECT DISTINCT account_id FROM source_scan_state
         WHERE source = 'resend' AND cursor_scope = 'received'
           AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
      )
      .all(this.#now()) as Array<{ account_id: string }>;
    let expired = 0;
    for (const { account_id: accountId } of accounts)
      expired += await this.#lock.withScope({ source: 'resend', accountId, scopeId: RECEIVED_SCOPE }, () =>
        this.#expireAccount(accountId),
      );
    return expired;
  }

  async #expireAccount(accountId: string): Promise<number> {
    const id = sourceId(accountId);
    const row = this.#store.database
      .prepare(
        `SELECT encrypted_record, stage_expires_at FROM source_scan_state
         WHERE id = ? AND source = 'resend' AND account_id = ? AND cursor_scope = 'received'
           AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
      )
      .get(id, accountId, this.#now()) as { encrypted_record: Uint8Array; stage_expires_at: number } | undefined;
    if (row === undefined) return 0;
    const state = (await this.#decrypt(row.encrypted_record, id)) as ReceivedState;
    const terminal = receivedOccurrenceKeys(state);
    const next: ReceivedState = { ...state, candidate: undefined, retry: undefined };
    const encrypted = await this.#encrypt(next, id);
    return this.#store.immediate(() => {
      const present = this.#store.database
        .prepare(
          `SELECT 1 AS present FROM source_scan_state
           WHERE id = ? AND encrypted_record = ? AND stage_expires_at = ? AND stage_expires_at <= ?`,
        )
        .get(id, row.encrypted_record, row.stage_expires_at, this.#now()) as { present: number } | undefined;
      if (present === undefined) return 0;
      const now = this.#now();
      const resolution = this.#store.database.prepare(
        `INSERT OR IGNORE INTO source_occurrence_resolutions
         (source, account_id, occurrence_key, outcome, resolved_at, error_code)
         VALUES ('resend', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
      );
      for (const occurrenceKey of terminal) resolution.run(accountId, occurrenceKey, now);
      const updated = this.#store.database
        .prepare(
          `UPDATE source_scan_state SET staged_at = NULL, stage_expires_at = NULL, encrypted_record = ?, updated_at = ?
           WHERE id = ? AND encrypted_record = ? AND stage_expires_at = ?`,
        )
        .run(encrypted, now, id, row.encrypted_record, row.stage_expires_at);
      if (Number(updated.changes) !== 1) return 0;
      this.#store.database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(id);
      this.#store.database
        .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
        .run(`source-retention-expired:resend:${accountId}:${id}`, 'event.source.retention-expired', now);
      return 1;
    });
  }
}

function receivedOccurrenceKeys(state: ReceivedState): readonly string[] {
  return [state.candidate?.emailId, ...state.items]
    .filter((value): value is string => value !== undefined && value !== EMPTY && value !== state.anchorId)
    .filter((value, index, values) => values.indexOf(value) === index);
}

/** The registry adapter fixes the two source scopes without exposing a Resend transport. */
export function createResendLocalEventSource(): LocalEventSource {
  return {
    source: 'resend',
    canonicalise: normaliseResendSourceOptions,
    scopesFor: ({ accountId, options }) => {
      if (options === undefined) return [];
      const selected = normaliseResendSourceOptions(options);
      return selected.kinds.map((kind) => ({ source: 'resend', accountId, scopeId: kind }));
    },
    withScopes: (lock, scopes, work) => lock.withScopes(scopes, work),
    baseline: (sample) => sample(),
    resume: (step) => step(),
    describeCursor: (cursor) => cursor,
    cleanup: (_kind, work) => Promise.resolve(work()),
  };
}

interface TerminalResolution {
  readonly occurrenceKey: string;
  readonly outcome: 'vanished' | 'unresolvable' | 'retention-expired';
  readonly code: string;
  readonly gap?: boolean | undefined;
}

function sourceId(accountId: string): string {
  return `resend-received:${accountId}`;
}

function clean(value: string): string {
  return neutralise(stripInvisible(value).text).text;
}

function cleanAddress(
  value: Readonly<{ address: string; name: string | null }>,
): Readonly<{ address: string; name: string | null }> {
  return { address: clean(value.address), name: value.name === null ? null : clean(value.name) };
}

/** Source-facing normalisation does not envelope: the daemon applies the one target-specific envelope at disclosure. */
export function normaliseResendEventCandidate(input: ResendReceivedCandidate): ResendReceivedCandidate {
  const body =
    input.body === undefined
      ? undefined
      : input.body.trimStart().startsWith('<')
        ? clean(sanitizeHtmlToText(input.body).text)
        : clean(sanitizePlainText(input.body).text);
  return {
    ...input,
    emailId: input.emailId,
    subject: clean(input.subject),
    ...(input.from === undefined ? {} : { from: input.from === null ? null : cleanAddress(input.from) }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo.map(cleanAddress) }),
    ...(input.to === undefined ? {} : { to: input.to.map(clean) }),
    ...(input.cc === undefined ? {} : { cc: input.cc.map(clean) }),
    ...(input.receivedFor === undefined ? {} : { receivedFor: input.receivedFor.map(clean) }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId === null ? null : clean(input.messageId) }),
    ...(input.attachments === undefined
      ? {}
      : {
          attachments: input.attachments.map((attachment) => ({
            ...attachment,
            id: clean(attachment.id),
            filename: clean(attachment.filename),
            contentType: attachment.contentType === null ? null : clean(attachment.contentType),
            riskFlags: [...new Set(attachment.riskFlags.map(clean))].sort(),
          })),
        }),
    ...(body === undefined ? {} : { body, bodyTruncated: input.bodyTruncated === true }),
    receivedAt: input.receivedAt,
  };
}

/** Resumable newest-first received-mail cycle. The stored page is always encrypted before its transaction links it. */
export class ResendReceivedSource {
  readonly #store: EventDatabase;
  readonly #accountId: string;
  readonly #reader: ResendEventReader;
  readonly #encrypt: (value: ReceivedState, id: string) => Promise<Uint8Array>;
  readonly #decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
  readonly #debts: () => readonly SourceStageDebt[];
  readonly #admit: (candidate: ResendReceivedCandidate) => Promise<'terminal' | 'pending'>;
  readonly #assertWriteStillLive: () => void;
  readonly #now: () => number;
  readonly #scopeLock: SourceScopeLock;
  readonly #scope: SourceScope;
  readonly #failpoint: CutoverFailpoint | undefined;
  #currentAnchor: string | null = null;

  constructor(
    input: Readonly<{
      store: EventDatabase;
      accountId: string;
      reader: ResendEventReader;
      encrypt: (value: ReceivedState, id: string) => Promise<Uint8Array>;
      decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
      debts: () => readonly SourceStageDebt[];
      admit: (candidate: ResendReceivedCandidate) => Promise<'terminal' | 'pending'>;
      assertWriteStillLive?: (() => void) | undefined;
      scopeLock?: SourceScopeLock | undefined;
      now?: (() => number) | undefined;
      /** Optional D8 crash seam; omitted in production. */
      failpoint?: CutoverFailpoint | undefined;
    }>,
  ) {
    this.#store = input.store;
    this.#accountId = input.accountId;
    this.#reader = input.reader;
    this.#encrypt = input.encrypt;
    this.#decrypt = input.decrypt;
    this.#debts = input.debts;
    this.#admit = input.admit;
    this.#assertWriteStillLive = input.assertWriteStillLive ?? (() => undefined);
    this.#now = input.now ?? Date.now;
    this.#scopeLock = input.scopeLock ?? new SourceScopeLock();
    this.#scope = { source: 'resend', accountId: input.accountId, scopeId: RECEIVED_SCOPE };
    this.#failpoint = input.failpoint;
  }

  anchorId(): string | null {
    return this.#currentAnchor === EMPTY ? null : this.#currentAnchor;
  }

  async baseline(): Promise<string> {
    return this.#scopeLock.withScope(this.#scope, () => this.#baseline());
  }

  async #baseline(): Promise<string> {
    this.#assertUnfenced();
    const page = await this.#reader.listReceived();
    const anchor = page.emails[0]?.id ?? EMPTY;
    await this.seedAnchor(anchor);
    return anchor;
  }

  async seedAnchor(anchorId: string): Promise<void> {
    await this.#save({ anchorId, cycleHeadId: null, after: null, pagesScanned: 0, items: [] }, false);
  }

  async scan(): Promise<Readonly<{ pending: boolean; anchorId: string | null }>> {
    return this.#scopeLock.withScope(this.#scope, () => this.#scan());
  }

  /** Source-specific expiry preserves the cursor/anchor while deleting the encrypted candidate and recording only its terminal fact. */
  async expireDue(): Promise<number> {
    return this.#scopeLock.withScope(this.#scope, async () => {
      const id = sourceId(this.#accountId);
      const row = this.#store.database
        .prepare(
          `SELECT encrypted_record, stage_expires_at FROM source_scan_state
           WHERE id = ? AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
        )
        .get(id, this.#now()) as { encrypted_record: Uint8Array; stage_expires_at: number } | undefined;
      if (row === undefined) return 0;
      const state = (await this.#decrypt(row.encrypted_record, id)) as ReceivedState;
      const terminal = receivedOccurrenceKeys(state);
      const next: ReceivedState = {
        ...state,
        candidate: undefined,
        retry: undefined,
      };
      const encrypted = await this.#encrypt(next, id);
      this.#store.immediate(() => {
        const present = this.#store.database
          .prepare(
            'SELECT 1 AS present FROM source_scan_state WHERE id = ? AND encrypted_record = ? AND stage_expires_at = ?',
          )
          .get(id, row.encrypted_record, row.stage_expires_at);
        if (present === undefined) throw new Error('stale Resend received expiry');
        const now = this.#now();
        const resolution = this.#store.database.prepare(
          `INSERT OR IGNORE INTO source_occurrence_resolutions
           (source, account_id, occurrence_key, outcome, resolved_at, error_code)
           VALUES ('resend', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
        );
        for (const occurrenceKey of terminal) resolution.run(this.#accountId, occurrenceKey, now);
        this.#store.database
          .prepare(
            `UPDATE source_scan_state SET staged_at = NULL, stage_expires_at = NULL, encrypted_record = ?, updated_at = ?
             WHERE id = ? AND encrypted_record = ? AND stage_expires_at = ?`,
          )
          .run(encrypted, now, id, row.encrypted_record, row.stage_expires_at);
        this.#store.database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(id);
      });
      return 1;
    });
  }

  async #scan(): Promise<Readonly<{ pending: boolean; anchorId: string | null }>> {
    this.#assertUnfenced();
    for (;;) {
      const state = await this.#load();
      if (state === null) throw new Error('the received source needs a baseline before scanning');
      if (state.candidate !== undefined) {
        if (this.#isResolved(state.candidate.emailId)) {
          await this.#save({ ...state, candidate: undefined, retry: undefined, items: state.items.slice(1) }, false);
          continue;
        }
        const admitted = await this.#admit(state.candidate);
        if (admitted === 'pending') return { pending: true, anchorId: this.anchorId() };
        await this.#save({ ...state, candidate: undefined, items: state.items.slice(1) }, state.items.length > 1);
        continue;
      }
      const item = state.items[0];
      if (item !== undefined) {
        if (item === state.anchorId) {
          const nextAnchor = state.cycleHeadId ?? state.anchorId;
          await this.#save({ anchorId: nextAnchor, cycleHeadId: null, after: null, pagesScanned: 0, items: [] }, false);
          return { pending: false, anchorId: nextAnchor === EMPTY ? null : nextAnchor };
        }
        if (item !== EMPTY && this.#isResolved(item)) {
          await this.#save({ ...state, candidate: undefined, retry: undefined, items: state.items.slice(1) }, false);
          continue;
        }
        const retry = state.retry?.emailId === item ? state.retry : undefined;
        if (retry !== undefined) {
          const stageExpiresAt = this.#stageExpiry();
          if (stageExpiresAt === null) throw new Error('a Resend detail retry lost its stage deadline');
          const resolution = resolveStageRetryDeadline({
            now: this.#now(),
            firstFailedAt: retry.firstFailedAt,
            stageExpiresAt,
            retryWindowMs: DAY_MS,
          });
          if (resolution.state !== 'retry') {
            await this.#save({ ...state, retry: undefined, items: state.items.slice(1) }, state.items.length > 1, {
              occurrenceKey: item,
              outcome: resolution.state,
              code: resolution.state === 'unresolvable' ? 'RETRY_EXHAUSTED' : 'STAGE_EXPIRED',
              gap: resolution.state === 'unresolvable',
            });
            continue;
          }
          if (this.#now() < retry.nextRetryAt) return { pending: true, anchorId: this.anchorId() };
        }
        this.#assertUnfenced();
        let detail: Awaited<ReturnType<ResendEventReader['getReceived']>>;
        try {
          detail = await this.#reader.getReceived(item);
        } catch (error) {
          const stageExpiresAt = this.#stageExpiry();
          if (stageExpiresAt === null) throw error;
          const firstFailedAt = retry?.firstFailedAt ?? this.#now();
          const resolution = resolveStageRetryDeadline({
            now: this.#now(),
            firstFailedAt,
            stageExpiresAt,
            retryWindowMs: DAY_MS,
          });
          if (resolution.state !== 'retry') {
            await this.#save({ ...state, retry: undefined, items: state.items.slice(1) }, state.items.length > 1, {
              occurrenceKey: item,
              outcome: resolution.state,
              code: resolution.state === 'unresolvable' ? 'RETRY_EXHAUSTED' : 'STAGE_EXPIRED',
              gap: resolution.state === 'unresolvable',
            });
            continue;
          }
          const attempts = (retry?.attempts ?? 0) + 1;
          const nextRetryAt = Math.min(
            this.#now() + Math.min(1_000 * 2 ** Math.min(attempts - 1, 8), 300_000),
            resolution.deadline,
          );
          await this.#save(
            {
              ...state,
              retry: {
                emailId: item,
                firstFailedAt,
                nextRetryAt,
                attempts,
                errorCode: error instanceof CommsError ? error.code : 'DETAIL_FAILED',
              },
            },
            true,
          );
          return { pending: true, anchorId: this.anchorId() };
        }
        if (detail.kind === 'vanished') {
          await this.#save({ ...state, items: state.items.slice(1) }, state.items.length > 1, {
            occurrenceKey: item,
            outcome: 'vanished',
            code: 'NOT_FOUND',
          });
          continue;
        }
        await this.#save(
          { ...state, retry: undefined, candidate: normaliseResendEventCandidate(detail.candidate) },
          true,
        );
        continue;
      }
      this.#assertUnfenced();
      const page = await this.#reader.listReceived(state.after ?? undefined);
      const cycleHeadId = state.cycleHeadId ?? page.emails[0]?.id ?? null;
      const pagesScanned = state.pagesScanned + 1;
      const foundAnchor = page.emails.some((item) => item.id === state.anchorId);
      const startedEmpty = state.anchorId === EMPTY;
      if (!startedEmpty && (pagesScanned >= MAX_PAGES || (page.next === null && !foundAnchor))) {
        const nextAnchor = cycleHeadId ?? state.anchorId;
        await this.#save(
          { anchorId: nextAnchor, cycleHeadId: null, after: null, pagesScanned: 0, items: [] },
          false,
          undefined,
          `resend-anchor-gap:${this.#accountId}:${state.anchorId}:${nextAnchor}`,
        );
        return { pending: false, anchorId: nextAnchor === EMPTY ? null : nextAnchor };
      }
      await this.#save(
        {
          ...state,
          cycleHeadId,
          after: page.next,
          pagesScanned,
          // `empty` is a durable activation point rather than an id Resend can return.  At the final page it is the
          // completion marker that lets a first post-empty cycle stage every new item before its anchor moves.
          items: [...page.emails.map((item) => item.id), ...(startedEmpty && page.next === null ? [EMPTY] : [])],
        },
        page.emails.length > 0,
      );
    }
  }

  #assertUnfenced(): void {
    if (isSourceScopeFenced(this.#store.database, this.#scope))
      throw new Error('the Resend received scope is fenced by an unpublished activation');
  }

  async #load(): Promise<ReceivedState | null> {
    const row = this.#store.database
      .prepare("SELECT encrypted_record FROM source_scan_state WHERE id = ? AND source = 'resend' AND account_id = ?")
      .get(sourceId(this.#accountId), this.#accountId) as { encrypted_record: Uint8Array } | undefined;
    if (row === undefined) return null;
    const value = await this.#decrypt(row.encrypted_record, sourceId(this.#accountId));
    return value as ReceivedState;
  }

  #isResolved(occurrenceKey: string): boolean {
    return (
      this.#store.database
        .prepare(
          `SELECT 1 AS present FROM source_occurrence_resolutions
           WHERE source = 'resend' AND account_id = ? AND occurrence_key = ?`,
        )
        .get(this.#accountId, occurrenceKey) !== undefined
    );
  }

  async #save(
    state: ReceivedState,
    content: boolean,
    terminal?: TerminalResolution | undefined,
    operationalGapId?: string | undefined,
  ): Promise<void> {
    // A received candidate is the durable stage.  Every other save advances
    // its resumable anchor/cycle state, so D8 can independently restart on
    // either side of that move without changing production behaviour.
    this.#failpoint?.(content ? 'before-stage' : 'before-move');
    const id = sourceId(this.#accountId);
    const previous = this.#store.database
      .prepare('SELECT encrypted_record, staged_at, stage_expires_at FROM source_scan_state WHERE id = ?')
      .get(id) as
      | { encrypted_record: Uint8Array; staged_at: number | null; stage_expires_at: number | null }
      | undefined;
    const encrypted = await this.#encrypt(state, id);
    const now = this.#now();
    const retention = content
      ? previous?.staged_at !== null && previous?.staged_at !== undefined && previous.stage_expires_at !== null
        ? { stagedAt: previous.staged_at, stageExpiresAt: previous.stage_expires_at }
        : sourceStageRetentionForDebts(now, this.#debts())
      : null;
    this.#store.immediate(() => {
      this.#assertWriteStillLive();
      this.#assertUnfenced();
      const changes =
        previous === undefined
          ? Number(
              this.#store.database
                .prepare(
                  `INSERT OR IGNORE INTO source_scan_state
                   (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
                   VALUES (?, 'resend', ?, 'received', ?, ?, ?, ?)`,
                )
                .run(
                  id,
                  this.#accountId,
                  retention?.stagedAt ?? null,
                  retention?.stageExpiresAt ?? null,
                  encrypted,
                  now,
                ).changes,
            )
          : Number(
              this.#store.database
                .prepare(
                  `UPDATE source_scan_state
                   SET staged_at = ?, stage_expires_at = ?, encrypted_record = ?, updated_at = ?
                   WHERE id = ? AND encrypted_record = ? AND staged_at IS ? AND stage_expires_at IS ?`,
                )
                .run(
                  retention?.stagedAt ?? null,
                  retention?.stageExpiresAt ?? null,
                  encrypted,
                  now,
                  id,
                  previous.encrypted_record,
                  previous.staged_at,
                  previous.stage_expires_at,
                ).changes,
            );
      if (changes !== 1) throw new Error('stale Resend received stage');
      if (retention !== null) {
        const debt = this.#store.database.prepare(
          'INSERT OR IGNORE INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, ?)',
        );
        for (const rule of this.#debts()) debt.run(id, rule.ruleId, rule.ruleVersion);
      } else {
        this.#store.database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(id);
      }
      if (terminal !== undefined) {
        this.#store.database
          .prepare(
            `INSERT OR IGNORE INTO source_occurrence_resolutions
             (source, account_id, occurrence_key, outcome, resolved_at, error_code) VALUES ('resend', ?, ?, ?, ?, ?)`,
          )
          .run(this.#accountId, terminal.occurrenceKey, terminal.outcome, now, terminal.code);
        if (terminal.gap === true) {
          this.#store.database
            .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
            .run(`resend-detail-gap:${this.#accountId}:${terminal.occurrenceKey}`, 'agentcomms.source.gap', now);
        }
      }
      if (operationalGapId !== undefined) {
        this.#store.database
          .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
          .run(operationalGapId, 'agentcomms.source.gap', now);
      }
    });
    this.#currentAnchor = state.anchorId;
    this.#failpoint?.(content ? 'after-stage' : 'after-move');
  }

  #stageExpiry(): number | null {
    const row = this.#store.database
      .prepare('SELECT stage_expires_at FROM source_scan_state WHERE id = ?')
      .get(sourceId(this.#accountId)) as { stage_expires_at: number | null } | undefined;
    return row?.stage_expires_at ?? null;
  }
}
