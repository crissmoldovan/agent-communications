import { CommsError, neutralise, sanitizeHtmlToText, sanitizePlainText, stripInvisible } from '@agentcomms/core';
import { normaliseResendSourceOptions } from '../domain/source-options.ts';
import type { CutoverFailpoint } from '../runtime/cutover-failpoint.ts';
import type { AsyncSourceStageExpiry, PreparedSourceStageTerminalisation } from '../runtime/expiry.ts';
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

/** A candidate's durable newest-first position within the received scan cycle. */
export interface ResendReceivedPosition {
  readonly orderedIds: readonly string[];
  readonly candidateIndex: number;
}

/** Content-free certificate retained until every active rule point has settled this completed scan cycle. */
export interface ResendReceivedCycle {
  /** The first provider id in this complete newest-first listing. */
  readonly cycleHeadId: string;
  /** Complete newest-first listing, including ids skipped by a replacement cap. */
  readonly orderedIds: readonly string[];
  /** The shared anchor written when this cycle completed; it may be below the listing head when a drain caps it. */
  readonly advancedAnchorId: string;
  /** True only when a drain cap present in this listing chose `advancedAnchorId`. */
  readonly capped: boolean;
  /** The prior shared anchor was absent, so this listing intentionally materialised no candidates. */
  readonly anchorLost: boolean;
  /** Local instant when this fixed listing began; compares a replacement P with an older in-flight cycle. */
  readonly startedAt: number;
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
  readonly cycleStartedAt?: number | undefined;
  /** The replacement P that capped this cycle, if it was present in the completed chain. */
  readonly cycleCapId?: string | undefined;
  readonly after: string | null;
  readonly pagesScanned: number;
  /** Listing is content-free and must reach the fixed anchor before any item is materialised. */
  readonly listingComplete?: boolean | undefined;
  /** The bounded listing did not contain its old anchor and will record its gap only after every listed id settles. */
  readonly anchorLost?: boolean | undefined;
  /** Complete effective newest-first listing, retained when a replacement cap trims `items` for materialisation. */
  readonly listedIds?: readonly string[] | undefined;
  readonly items: readonly string[];
  /** IDs already consumed in this bounded newest-first cycle. */
  readonly seenIds?: readonly string[] | undefined;
  /** A completed cycle awaits the owner-side, per-rule point settlement before another provider page may be read. */
  readonly completedCycle?: ResendReceivedCycle | undefined;
  readonly candidate?: ResendReceivedCandidate | undefined;
  readonly candidatePosition?: ResendReceivedPosition | undefined;
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

  async prepareRetentionTightening(input: {
    readonly ruleId: string;
    readonly ingestRetentionMs: number;
    readonly now: number;
  }): Promise<readonly PreparedSourceStageTerminalisation[]> {
    const accounts = this.#store.database
      .prepare(
        `SELECT DISTINCT state.account_id
           FROM source_scan_state AS state
          WHERE state.source = 'resend' AND state.cursor_scope = 'received'
            AND state.staged_at IS NOT NULL AND state.staged_at + ? <= ?
            AND EXISTS (
              SELECT 1 FROM source_stage_rule_debts AS debt
               WHERE debt.stage_id = state.id AND debt.rule_id = ?
            )`,
      )
      .all(input.ingestRetentionMs, input.now, input.ruleId) as Array<{ account_id: string }>;
    const prepared: PreparedSourceStageTerminalisation[] = [];
    for (const { account_id: accountId } of accounts) {
      const terminalisation = await this.#prepareTerminalisation(accountId, input.now, false);
      if (terminalisation !== undefined) prepared.push(terminalisation);
    }
    return prepared;
  }

  async #expireAccount(accountId: string): Promise<number> {
    const terminalisation = await this.#prepareTerminalisation(accountId, this.#now());
    return terminalisation === undefined ? 0 : this.#store.immediate(() => terminalisation.terminaliseInTransaction());
  }

  async #prepareTerminalisation(
    accountId: string,
    at: number,
    requireDue = true,
  ): Promise<PreparedSourceStageTerminalisation | undefined> {
    const id = sourceId(accountId);
    const row = this.#store.database
      .prepare(
        `SELECT encrypted_record, stage_expires_at FROM source_scan_state
         WHERE id = ? AND source = 'resend' AND account_id = ? AND cursor_scope = 'received'
           AND stage_expires_at IS NOT NULL AND (? = 0 OR stage_expires_at <= ?)`,
      )
      .get(id, accountId, requireDue ? 1 : 0, at) as
      | { encrypted_record: Uint8Array; stage_expires_at: number }
      | undefined;
    if (row === undefined) return undefined;
    const state = (await this.#decrypt(row.encrypted_record, id)) as ReceivedState;
    const terminal = receivedOccurrenceKeys(state);
    const next: ReceivedState = { ...state, candidate: undefined, retry: undefined };
    const encrypted = await this.#encrypt(next, id);
    return {
      terminaliseInTransaction: () => {
        const present = this.#store.database
          .prepare(
            `SELECT 1 AS present FROM source_scan_state
           WHERE id = ? AND encrypted_record = ? AND stage_expires_at <= ?`,
          )
          .get(id, row.encrypted_record, at) as { present: number } | undefined;
        if (present === undefined) return 0;
        const now = at;
        const resolution = this.#store.database.prepare(
          `INSERT OR IGNORE INTO source_occurrence_resolutions
         (source, account_id, occurrence_key, outcome, resolved_at, error_code)
         VALUES ('resend', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
        );
        for (const occurrenceKey of terminal) resolution.run(accountId, occurrenceKey, now);
        const updated = this.#store.database
          .prepare(
            `UPDATE source_scan_state SET staged_at = NULL, stage_expires_at = NULL, encrypted_record = ?, updated_at = ?
           WHERE id = ? AND encrypted_record = ? AND stage_expires_at <= ?`,
          )
          .run(encrypted, now, id, row.encrypted_record, at);
        if (Number(updated.changes) !== 1) return 0;
        this.#store.database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(id);
        this.#store.database
          .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
          .run(`source-retention-expired:resend:${accountId}:${id}`, 'event.source.retention-expired', now);
        return 1;
      },
    };
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
  readonly #admit: (
    candidate: ResendReceivedCandidate,
    position: ResendReceivedPosition,
  ) => Promise<'terminal' | 'pending'>;
  /** Content-free point gate that runs before the detail/body provider call. */
  readonly #mayFetch: (position: ResendReceivedPosition) => Promise<boolean>;
  readonly #assertWriteStillLive: () => void;
  readonly #now: () => number;
  readonly #scopeLock: SourceScopeLock;
  readonly #scope: SourceScope;
  readonly #failpoint: CutoverFailpoint | undefined;
  readonly #settleCompletedCycle: ((cycle: ResendReceivedCycle) => Promise<void>) | undefined;
  readonly #drainCap: Readonly<{ anchorId: string; capturedAt: number }> | undefined;
  #currentAnchor: string | null = null;
  #lastCompletedCycle: ResendReceivedCycle | undefined;

  constructor(
    input: Readonly<{
      store: EventDatabase;
      accountId: string;
      reader: ResendEventReader;
      encrypt: (value: ReceivedState, id: string) => Promise<Uint8Array>;
      decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
      debts: () => readonly SourceStageDebt[];
      admit: (candidate: ResendReceivedCandidate, position: ResendReceivedPosition) => Promise<'terminal' | 'pending'>;
      mayFetch?: ((position: ResendReceivedPosition) => Promise<boolean>) | undefined;
      assertWriteStillLive?: (() => void) | undefined;
      scopeLock?: SourceScopeLock | undefined;
      now?: (() => number) | undefined;
      /** Records the owner's durable per-version cut-over facts before the cycle certificate is acknowledged. */
      settleCompletedCycle?: ((cycle: ResendReceivedCycle) => Promise<void>) | undefined;
      /** While an exact replacement drains, its old version may process only P through the shared anchor. */
      drainCap?: Readonly<{ anchorId: string; capturedAt: number }> | undefined;
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
    this.#mayFetch = input.mayFetch ?? (async () => this.#debts().length > 0);
    this.#assertWriteStillLive = input.assertWriteStillLive ?? (() => undefined);
    this.#now = input.now ?? Date.now;
    this.#scopeLock = input.scopeLock ?? new SourceScopeLock();
    this.#scope = { source: 'resend', accountId: input.accountId, scopeId: RECEIVED_SCOPE };
    this.#settleCompletedCycle = input.settleCompletedCycle;
    this.#drainCap = input.drainCap;
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
    await this.#save(
      { anchorId, cycleHeadId: null, after: null, pagesScanned: 0, listedIds: [], items: [], seenIds: [] },
      false,
    );
  }

  completedCycle(): ResendReceivedCycle | undefined {
    return this.#lastCompletedCycle;
  }

  async scan(): Promise<Readonly<{ pending: boolean; anchorId: string | null }>> {
    return this.#scopeLock.withScope(this.#scope, () => this.#scan());
  }

  /**
   * The owner settles a durable cycle certificate before it is acknowledged. If a process stops between the two
   * writes, the certificate remains in encrypted source state and is settled idempotently on the next turn.
   */
  async #settleAndAcknowledgeCompletedCycle(cycle: ResendReceivedCycle): Promise<void> {
    await this.#settleCompletedCycle?.(cycle);
    const state = await this.#load();
    if (state?.completedCycle === undefined) return;
    if (!sameCycle(state.completedCycle, cycle)) throw new Error('the Resend received completion certificate changed');
    await this.#save({ ...state, completedCycle: undefined }, false);
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
        candidatePosition: undefined,
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
      if (state.completedCycle !== undefined) {
        const completedCycle = state.completedCycle;
        await this.#settleAndAcknowledgeCompletedCycle(completedCycle);
        this.#lastCompletedCycle = completedCycle;
        return { pending: false, anchorId: state.anchorId === EMPTY ? null : state.anchorId };
      }
      // A candidate's relative position is only safe once the durable newest-first chain includes the shared anchor.
      // In particular, never materialise page one merely because page two has not been listed yet.
      // Older durable records used one fully listed final page as their processing state and have no
      // `listingComplete` marker. Resume that compatible shape without a fresh provider list; a partial old page
      // still has `after` and must first be extended into the complete chain.
      if (!state.listingComplete && !(state.items.length > 0 && state.after === null)) {
        this.#assertUnfenced();
        const page = await this.#reader.listReceived(state.after ?? undefined);
        const cycleHeadId = state.cycleHeadId ?? page.emails[0]?.id ?? null;
        const pagesScanned = state.pagesScanned + 1;
        const foundAnchor = page.emails.some((item) => item.id === state.anchorId);
        const startedEmpty = state.anchorId === EMPTY;
        const anchorLost = !startedEmpty && !foundAnchor && (pagesScanned >= MAX_PAGES || page.next === null);
        const listingComplete = foundAnchor || anchorLost || (startedEmpty && page.next === null);
        const pageIds = page.emails.map((item) => item.id);
        const effectivePageIds = foundAnchor ? pageIds.slice(0, pageIds.indexOf(state.anchorId) + 1) : pageIds;
        const listingTail = startedEmpty && page.next === null ? [EMPTY] : [];
        await this.#save(
          {
            ...state,
            cycleHeadId,
            cycleStartedAt: state.cycleStartedAt ?? this.#now(),
            after: listingComplete ? null : page.next,
            pagesScanned,
            listingComplete,
            anchorLost,
            seenIds: state.seenIds ?? [],
            // `empty` is a durable activation point rather than an id Resend can return. At the final page it marks
            // the end of a first post-empty cycle after every real id has been listed.
            listedIds: [
              ...(state.listedIds ?? [...(state.seenIds ?? []), ...state.items]),
              ...effectivePageIds,
              ...listingTail,
            ],
            items: [...state.items, ...effectivePageIds, ...listingTail],
          },
          page.emails.length > 0,
        );
        continue;
      }
      if (state.anchorLost === true) {
        const cap = this.#drainCap;
        const chain = this.#listedIds(state);
        const capPresent = cap !== undefined && cap.anchorId !== EMPTY && chain.includes(cap.anchorId);
        const nextAnchor = capPresent ? cap.anchorId : (state.cycleHeadId ?? EMPTY);
        const completedCycle = this.#completedCycle(state, nextAnchor, capPresent, true);
        await this.#save(
          {
            anchorId: nextAnchor,
            cycleHeadId: null,
            cycleStartedAt: undefined,
            cycleCapId: undefined,
            after: null,
            pagesScanned: 0,
            listingComplete: undefined,
            anchorLost: undefined,
            listedIds: [],
            items: [],
            seenIds: [],
            completedCycle,
          },
          false,
          undefined,
          `resend-anchor-gap:${this.#accountId}:${state.anchorId}:${nextAnchor}`,
        );
        await this.#settleAndAcknowledgeCompletedCycle(completedCycle);
        this.#lastCompletedCycle = completedCycle;
        return { pending: false, anchorId: nextAnchor === EMPTY ? null : nextAnchor };
      }
      const cap = this.#drainCap;
      if (cap !== undefined && state.cycleCapId === undefined) {
        const seen = state.seenIds ?? [];
        const chain = this.#listedIds(state);
        const capIndex = cap.anchorId === EMPTY ? -1 : chain.indexOf(cap.anchorId);
        if (cap.anchorId === EMPTY || capIndex >= 0) {
          if (cap.anchorId === EMPTY) {
            const completedCycle = this.#completedCycle(state, EMPTY, true, false);
            await this.#save(
              {
                anchorId: EMPTY,
                cycleHeadId: null,
                cycleStartedAt: undefined,
                cycleCapId: undefined,
                after: null,
                pagesScanned: 0,
                listingComplete: undefined,
                anchorLost: undefined,
                listedIds: [],
                items: [],
                seenIds: [],
                completedCycle,
              },
              false,
            );
            await this.#settleAndAcknowledgeCompletedCycle(completedCycle);
            this.#lastCompletedCycle = completedCycle;
            return { pending: false, anchorId: null };
          }
          const itemIndex = Math.max(0, capIndex - seen.length);
          const retainedItems = state.items.slice(itemIndex);
          const retainCandidate = state.candidate?.emailId === retainedItems[0];
          await this.#save(
            {
              ...state,
              cycleCapId: cap.anchorId,
              items: retainedItems,
              candidate: retainCandidate ? state.candidate : undefined,
              candidatePosition: retainCandidate ? state.candidatePosition : undefined,
              retry: retainCandidate ? state.retry : undefined,
            },
            false,
          );
          continue;
        }
        // P was sampled after this listing began, so it is necessarily newer than this old in-flight cycle. Finish
        // that old cycle normally; the next cycle will list from the then-current head down to P.
        if ((state.cycleStartedAt ?? 0) < cap.capturedAt) {
          // Do not set a cap: there is no safe order relation between this old cycle and P yet.
        } else {
          // The bounded post-P listing has no P (deleted or aged out). Fail closed: retain only its content-free
          // chain, let the owner record a per-drain gap, and advance so neither version can admit unknown-order mail.
          const nextAnchor = state.cycleHeadId ?? state.anchorId;
          const completedCycle = this.#completedCycle(state, nextAnchor, false, false);
          await this.#save(
            {
              anchorId: nextAnchor,
              cycleHeadId: null,
              cycleStartedAt: undefined,
              cycleCapId: undefined,
              after: null,
              pagesScanned: 0,
              listingComplete: undefined,
              anchorLost: undefined,
              listedIds: [],
              items: [],
              seenIds: [],
              completedCycle,
            },
            false,
          );
          await this.#settleAndAcknowledgeCompletedCycle(completedCycle);
          this.#lastCompletedCycle = completedCycle;
          return { pending: false, anchorId: nextAnchor === EMPTY ? null : nextAnchor };
        }
      }
      if (state.candidate !== undefined) {
        if (this.#isResolved(state.candidate.emailId)) {
          await this.#save(this.#consumeItem(state), false);
          continue;
        }
        const admitted = await this.#admit(state.candidate, this.#candidatePosition(state));
        if (admitted === 'pending') return { pending: true, anchorId: this.anchorId() };
        await this.#save(this.#consumeItem(state), state.items.length > 1);
        continue;
      }
      const item = state.items[0];
      if (item !== undefined) {
        if (item === state.anchorId) {
          const nextAnchor = state.cycleCapId ?? state.cycleHeadId ?? state.anchorId;
          const completedCycle = this.#completedCycle(state, nextAnchor, state.cycleCapId !== undefined, false);
          await this.#save(
            {
              anchorId: nextAnchor,
              cycleHeadId: null,
              cycleStartedAt: undefined,
              cycleCapId: undefined,
              after: null,
              pagesScanned: 0,
              listingComplete: undefined,
              anchorLost: undefined,
              listedIds: [],
              items: [],
              seenIds: [],
              completedCycle,
            },
            false,
          );
          await this.#settleAndAcknowledgeCompletedCycle(completedCycle);
          this.#lastCompletedCycle = completedCycle;
          return { pending: false, anchorId: nextAnchor === EMPTY ? null : nextAnchor };
        }
        if (item !== EMPTY && this.#isResolved(item)) {
          await this.#save(this.#consumeItem(state), false);
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
            await this.#save(this.#consumeItem(state), state.items.length > 1, {
              occurrenceKey: item,
              outcome: resolution.state,
              code: resolution.state === 'unresolvable' ? 'RETRY_EXHAUSTED' : 'STAGE_EXPIRED',
              gap: resolution.state === 'unresolvable',
            });
            continue;
          }
          if (this.#now() < retry.nextRetryAt) return { pending: true, anchorId: this.anchorId() };
        }
        if (!(await this.#mayFetch(this.#candidatePosition(state)))) {
          await this.#save(this.#consumeItem(state), false);
          continue;
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
            await this.#save(this.#consumeItem(state), state.items.length > 1, {
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
          await this.#save(this.#consumeItem(state), state.items.length > 1, {
            occurrenceKey: item,
            outcome: 'vanished',
            code: 'NOT_FOUND',
          });
          continue;
        }
        await this.#save(
          {
            ...state,
            retry: undefined,
            candidate: normaliseResendEventCandidate(detail.candidate),
            candidatePosition: this.#candidatePosition(state),
          },
          true,
        );
        continue;
      }
      const nextAnchor = state.cycleCapId ?? state.cycleHeadId ?? state.anchorId;
      const completedCycle = this.#completedCycle(state, nextAnchor, state.cycleCapId !== undefined, false);
      await this.#save(
        {
          anchorId: nextAnchor,
          cycleHeadId: null,
          cycleStartedAt: undefined,
          cycleCapId: undefined,
          after: null,
          pagesScanned: 0,
          listingComplete: undefined,
          anchorLost: undefined,
          listedIds: [],
          items: [],
          seenIds: [],
          completedCycle,
        },
        false,
        undefined,
        state.anchorLost ? `resend-anchor-gap:${this.#accountId}:${state.anchorId}:${nextAnchor}` : undefined,
      );
      await this.#settleAndAcknowledgeCompletedCycle(completedCycle);
      this.#lastCompletedCycle = completedCycle;
      return { pending: false, anchorId: nextAnchor === EMPTY ? null : nextAnchor };
    }
  }

  #assertUnfenced(): void {
    if (isSourceScopeFenced(this.#store.database, this.#scope))
      throw new Error('the Resend received scope is fenced by an unpublished activation');
  }

  #candidatePosition(state: ReceivedState): ResendReceivedPosition {
    const seen = state.seenIds ?? [];
    return { orderedIds: [...seen, ...state.items], candidateIndex: seen.length };
  }

  #listedIds(state: ReceivedState): readonly string[] {
    return state.listedIds ?? [...(state.seenIds ?? []), ...state.items];
  }

  #completedCycle(
    state: ReceivedState,
    advancedAnchorId: string,
    capped: boolean,
    anchorLost: boolean,
  ): ResendReceivedCycle {
    return {
      cycleHeadId: state.cycleHeadId ?? advancedAnchorId,
      orderedIds: this.#listedIds(state),
      advancedAnchorId,
      capped,
      anchorLost,
      startedAt: state.cycleStartedAt ?? 0,
    };
  }

  #consumeItem(state: ReceivedState): ReceivedState {
    const item = state.items[0];
    return {
      ...state,
      candidate: undefined,
      candidatePosition: undefined,
      retry: undefined,
      items: state.items.slice(1),
      seenIds: item === undefined ? (state.seenIds ?? []) : [...(state.seenIds ?? []), item],
    };
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

function sameCycle(left: ResendReceivedCycle, right: ResendReceivedCycle): boolean {
  return (
    left.cycleHeadId === right.cycleHeadId &&
    left.advancedAnchorId === right.advancedAnchorId &&
    left.capped === right.capped &&
    left.anchorLost === right.anchorLost &&
    left.startedAt === right.startedAt &&
    left.orderedIds.length === right.orderedIds.length &&
    left.orderedIds.every((value, index) => value === right.orderedIds[index])
  );
}
