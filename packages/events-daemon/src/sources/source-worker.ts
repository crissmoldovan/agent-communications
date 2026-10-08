import { createHash } from 'node:crypto';
import { CommsError } from '@agentcomms/core';
import {
  eventId,
  eventIdPreimage,
  gmailMessageLabelledV1,
  gmailMessageReceivedV1,
  gmailMessageSentV1,
  validateEvent,
} from '@agentcomms/events';
import { type GmailEventMessageMetadata, type GmailEventSource, normaliseGmailEventMetadata } from '@agentcomms/gmail';
import type { GmailSourceOptions } from '../domain/source-options.ts';
import { isRemovedAccountError, purgeRemovedAccountWork } from '../runtime/account-fence.ts';
import type { GmailReplacementDrains } from '../runtime/replacements.ts';
import type { EventDatabase } from '../store/database.ts';
import {
  classifyGmailLabelChange,
  classifyGmailMessage,
  type GmailHistoryOccurrence,
  occurrencesFromHistory,
} from './gmail.ts';
import type { MailboxLock } from './mailbox-lock.ts';
import type { GmailMaterialisationRequest, GmailMaterialisationResult } from './materialise.ts';

type GmailSource = Pick<GmailEventSource, 'listHistory' | 'getMessageMetadata'> &
  Partial<Pick<GmailEventSource, 'getProfile' | 'getMessage'>>;

export interface GmailSourceRule {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly eventType: 'gmail.message.received' | 'gmail.message.sent' | 'gmail.message.labelled';
  readonly options: GmailSourceOptions;
  readonly ingestRetentionMs: number;
  /** The exact immutable rule's Gmail lazy fields. B1 Gmail currently supports only `body`. */
  readonly lazyFields?: readonly string[] | undefined;
}

export interface GmailSourceOccurrence {
  readonly event: Record<string, unknown>;
  readonly eventId: string;
  readonly preimage: string;
  readonly rule: GmailSourceRule;
  readonly stageId: string;
  readonly observedAt: string;
}

export interface GmailSourceWorkerOptions {
  readonly store: EventDatabase;
  readonly source: GmailSource;
  readonly mailbox: { readonly accountId: string; readonly name: string };
  readonly mailboxLock: MailboxLock;
  /** Reads the exact active source versions; never a broad mailbox-level eligibility shortcut. */
  readonly rules: () => readonly GmailSourceRule[];
  /** The shared live authority fence, reached before an event becomes an admitted projection candidate. */
  readonly assertDisclosable: (rule: GmailSourceRule) => Promise<void>;
  /** Task 12 continues the terminal ingest/projection path; Task 10 keeps its result durable at this boundary. */
  readonly admit: (occurrence: GmailSourceOccurrence) => Promise<'terminal' | 'pending'>;
  /** Source staging is encrypted before, never inside, the write transaction. */
  readonly encryptStage: (value: StoredHistoryPage, stageId?: string) => Promise<Uint8Array>;
  readonly decryptStage?: ((stored: Uint8Array, stageId?: string) => Promise<StoredHistoryPage>) | undefined;
  /** Test-only collision injection; production uses Phase A's SHA-256 event identity function. */
  readonly eventIdFor?: ((input: Parameters<typeof eventId>[0]) => Promise<string>) | undefined;
  /** Deterministic test failpoints for the mailbox-lock interleaving contract. */
  readonly onPageStaged?: ((stageId: string) => Promise<void> | void) | undefined;
  readonly beforeCursorCommit?: (() => Promise<void> | void) | undefined;
  /** The real replacement fence holds post-P content inside its encrypted source stage until the pointer swap. */
  readonly replacementDrains?:
    | Pick<GmailReplacementDrains, 'shouldWithhold' | 'isAfterActivePoint' | 'markPageDrained'>
    | undefined;
  /**
   * D9: the account is read from core's configuration at each boundary, never cached. Called immediately before every
   * write that keeps provider content or moves the cursor; throws the ACCOUNT_REMOVED refusal once the account is gone.
   */
  readonly accountLive?: (() => Promise<void>) | undefined;
  readonly materialise?:
    | ((requests: readonly GmailMaterialisationRequest[]) => Promise<readonly GmailMaterialisationResult[]>)
    | undefined;
  readonly now?: (() => number) | undefined;
}

interface StoredHistoryPage {
  readonly cursorBefore: string;
  readonly page: {
    readonly historyId: string;
    readonly nextPageToken: string | undefined;
    readonly history: readonly {
      readonly id: string;
      readonly messagesAdded: readonly {
        readonly message: { readonly id: string; readonly threadId?: string | undefined };
      }[];
      readonly labelsAdded: readonly {
        readonly message: { readonly id: string; readonly threadId?: string | undefined };
        readonly labelIds: readonly string[];
      }[];
      readonly labelsRemoved: readonly {
        readonly message: { readonly id: string; readonly threadId?: string | undefined };
        readonly labelIds: readonly string[];
      }[];
    }[];
  };
  /** Raw history is durable before metadata classification. A message gets observedAt only after that read succeeds. */
  readonly stagedObservedAt: string;
  readonly messageStates: Readonly<Record<string, StoredMessageState>>;
  /** Terminal siblings of a held post-P occurrence must not be admitted again when the staged page resumes. */
  readonly completedOccurrenceKeys?: readonly string[] | undefined;
}

interface StoredMessageState {
  readonly metadata?: GmailEventMessageMetadata | undefined;
  readonly observedAt?: string | undefined;
  readonly firstFailedAt?: number | undefined;
  readonly nextRetryAt?: number | undefined;
  readonly attempts?: number | undefined;
  readonly errorCode?: string | undefined;
}

interface StagedPage {
  readonly id: string;
  value: StoredHistoryPage;
}

function sourceStageId(accountId: string, cursor: string, pageIndex: number): string {
  return `gmail-history:${accountId}:${cursor}:${pageIndex}`;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asMilliseconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds))
    throw new CommsError('BAD_DATA', 'a Gmail event time is not an exact instant');
  return milliseconds;
}

const MAX_RETRY_MS = 86_400_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;

function retryErrorCode(error: unknown): string {
  return error instanceof CommsError ? error.code : 'METADATA_FAILED';
}

/** A stable small jitter prevents many recoveries from retrying in the same millisecond without changing tests. */
function retryJitter(occurrenceKey: string, attempts: number): number {
  let hash = attempts;
  for (const character of occurrenceKey) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 251;
}

/** Whether a rule version has been revoked — its immutable row stays, marked, so a revocation is always visible. */
export function isRevokedVersion(store: EventDatabase, ruleId: string, ruleVersion: number): boolean {
  const row = store.database
    .prepare('SELECT state, revoked_at FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, ruleVersion) as { state: string | null; revoked_at: number | null } | undefined;
  return row !== undefined && (row.revoked_at !== null || row.state === 'revoked');
}

/** A scan whose switch or account moved under it: it stops and writes nothing more. */
export class StaleScanError extends CommsError {
  constructor() {
    super('APPROVAL_VOID', 'the event switch or account changed during this mailbox scan', {
      details: { reason: 'STALE_SCAN' },
    });
  }
}

/** One durable, account-scoped Gmail acquisition cursor. It never owns a per-rule cursor. */
export class GmailSourceWorker {
  readonly #store: EventDatabase;
  readonly #source: GmailSource;
  readonly #mailbox: GmailSourceWorkerOptions['mailbox'];
  readonly #mailboxLock: MailboxLock;
  readonly #rules: GmailSourceWorkerOptions['rules'];
  readonly #assertDisclosable: GmailSourceWorkerOptions['assertDisclosable'];
  readonly #admit: GmailSourceWorkerOptions['admit'];
  readonly #encryptStage: GmailSourceWorkerOptions['encryptStage'];
  readonly #decryptStage: GmailSourceWorkerOptions['decryptStage'];
  readonly #eventIdFor: NonNullable<GmailSourceWorkerOptions['eventIdFor']>;
  readonly #onPageStaged: GmailSourceWorkerOptions['onPageStaged'];
  readonly #beforeCursorCommit: GmailSourceWorkerOptions['beforeCursorCommit'];
  readonly #replacementDrains: GmailSourceWorkerOptions['replacementDrains'];
  readonly #accountLive: () => Promise<void>;
  readonly #materialise: GmailSourceWorkerOptions['materialise'];
  readonly #now: () => number;

  constructor(options: GmailSourceWorkerOptions) {
    this.#store = options.store;
    this.#source = options.source;
    this.#mailbox = options.mailbox;
    this.#mailboxLock = options.mailboxLock;
    this.#rules = options.rules;
    this.#assertDisclosable = options.assertDisclosable;
    this.#admit = options.admit;
    this.#encryptStage = options.encryptStage;
    this.#decryptStage = options.decryptStage;
    this.#eventIdFor = options.eventIdFor ?? eventId;
    this.#onPageStaged = options.onPageStaged;
    this.#beforeCursorCommit = options.beforeCursorCommit;
    this.#replacementDrains = options.replacementDrains;
    this.#accountLive = options.accountLive ?? (async () => undefined);
    this.#materialise = options.materialise;
    this.#now = options.now ?? Date.now;
  }

  async scan(): Promise<{ readonly cursor: string | null; readonly pending: boolean }> {
    return this.#mailboxLock.withMailbox(this.#mailbox.accountId, async () => {
      try {
        return await this.#scanLocked();
      } catch (error) {
        // Account removal is a terminal source boundary. Re-throw the original stable error so the owner records no
        // provider detail, but do not let the staged page or a later cursor commit resurrect account-bound work.
        if (isRemovedAccountError(error)) {
          this.#store.immediate(() =>
            purgeRemovedAccountWork(this.#store.database, this.#mailbox.accountId, this.#now()),
          );
        }
        throw error;
      }
    });
  }

  /**
   * The switch and account as they were when this scan started. Provider calls, metadata reads and encryption all
   * await, so a disable-all or an account removal can purge this mailbox's work in between; every write the scan makes
   * re-checks this snapshot inside its own transaction and writes nothing once it has moved (D12's post-provider
   * generation fence) — a stale scan can never recreate purged staging, resolutions or a cursor.
   */
  #snapshot: { readonly generation: number; readonly enabled: number; readonly startedAt: number } | undefined;

  /** For the materialiser and any other writer working inside this scan: throws once the snapshot has moved. */
  assertScanLive(): void {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return;
    const settings = this.#store.database
      .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; switch_generation: number } | undefined;
    const revoked = this.#store.database
      .prepare('SELECT 1 AS present FROM account_revocations WHERE account_id = ? AND revoked_at >= ?')
      .get(this.#mailbox.accountId, snapshot.startedAt);
    if (
      settings === undefined ||
      settings.enabled !== snapshot.enabled ||
      settings.switch_generation !== snapshot.generation ||
      revoked !== undefined
    ) {
      throw new StaleScanError();
    }
  }

  #write<T>(work: () => T): T {
    return this.#store.immediate(() => {
      this.assertScanLive();
      return work();
    });
  }

  async #scanLocked(): Promise<{ readonly cursor: string | null; readonly pending: boolean }> {
    const settings = this.#store.database
      .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; switch_generation: number } | undefined;
    this.#snapshot = {
      generation: settings?.switch_generation ?? 0,
      enabled: settings?.enabled ?? 0,
      startedAt: this.#now(),
    };
    try {
      return await this.#scanFromSnapshot();
    } catch (error) {
      if (error instanceof StaleScanError) return { cursor: this.#cursor(), pending: true };
      throw error;
    } finally {
      this.#snapshot = undefined;
    }
  }

  async #scanFromSnapshot(): Promise<{ readonly cursor: string | null; readonly pending: boolean }> {
    const cursor = this.#cursor();
    if (cursor === null) return { cursor: null, pending: false };
    let pageToken: string | undefined;
    let pageIndex = 0;
    let finalCursor = cursor;
    const pages: StagedPage[] = [];
    try {
      for (;;) {
        const id = sourceStageId(this.#mailbox.accountId, cursor, pageIndex);
        // A page an interrupted scan already staged is resumed as it was: its content, its next page token and its
        // final cursor. Taking the cursor from a fresh listing instead would jump past mail that arrived meanwhile,
        // which no staged page holds.
        const page =
          (await this.#resumeStage(id)) ??
          (await this.#stagePage(
            id,
            cursor,
            await this.#source.listHistory({ historyId: cursor, ...(pageToken ? { pageToken } : {}) }),
          ));
        pages.push(page);
        finalCursor = page.value.page.historyId;
        pageIndex += 1;
        pageToken = page.value.page.nextPageToken;
        if (pageToken === undefined) break;
      }
    } catch (error) {
      // Only Gmail's expired-history NOT_FOUND re-baselines; an account removal (also NOT_FOUND) ends the scan, and
      // must never be answered with another provider call for an account that is gone.
      if (!(error instanceof CommsError) || error.code !== 'NOT_FOUND' || isRemovedAccountError(error)) throw error;
      // A response may have been staged before Gmail aged the cursor out. Drain that durable work first; re-baselining
      // it away would turn a successful acquisition into a silent loss.
      if (!(await this.#resumeStagedPages())) return { cursor, pending: true };
      return this.#rebaselineExpiredCursor();
    }
    let heldAfterPoint = false;
    for (const page of pages) {
      const outcome = await this.#processPage(page);
      if (outcome === 'pending') return { cursor, pending: true };
      if (outcome === 'held') heldAfterPoint = true;
    }
    if (heldAfterPoint) return { cursor, pending: true };
    await this.#beforeCursorCommit?.();
    await this.#accountLive();
    this.#write(() => {
      const remaining = this.#store.database
        .prepare(
          "SELECT 1 AS present FROM source_scan_state WHERE source = 'gmail' AND account_id = ? AND cursor_scope = 'mailbox'",
        )
        .get(this.#mailbox.accountId) as { present: number } | undefined;
      if (remaining !== undefined) return;
      this.#store.database
        .prepare(
          `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', ?, ?)
           ON CONFLICT(source, account_id, cursor_scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .run(this.#mailbox.accountId, finalCursor, this.#now());
    });
    return { cursor: finalCursor, pending: false };
  }

  #cursor(): string | null {
    const row = this.#store.database
      .prepare("SELECT cursor FROM cursors WHERE source = 'gmail' AND account_id = ? AND cursor_scope = 'mailbox'")
      .get(this.#mailbox.accountId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  async #resumeStagedPages(): Promise<boolean> {
    const rows = this.#store.database
      .prepare(
        `SELECT id, encrypted_record FROM source_scan_state
         WHERE source = 'gmail' AND account_id = ? AND cursor_scope = 'mailbox'
         ORDER BY staged_at, id`,
      )
      .all(this.#mailbox.accountId) as Array<{ id: string; encrypted_record: Uint8Array }>;
    if (rows.length === 0) return true;
    if (this.#decryptStage === undefined)
      throw new CommsError('CONFIG', 'the Gmail source worker needs its stage decryptor to resume a durable page');
    await this.#assertAllRules();
    for (const row of rows) {
      const outcome = await this.#processPage({
        id: row.id,
        value: await this.#decryptStage(row.encrypted_record, row.id),
      });
      if (outcome !== 'terminal') return false;
    }
    return true;
  }

  /** The durable page already staged under this id, or null; resuming one passes the shared fence first. */
  async #resumeStage(id: string): Promise<StagedPage | null> {
    const existing = this.#store.database
      .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
      .get(id) as { encrypted_record: Uint8Array } | undefined;
    if (existing === undefined) return null;
    if (this.#decryptStage === undefined)
      throw new CommsError('CONFIG', 'the Gmail source worker needs its stage decryptor to resume a durable page');
    await this.#assertAllRules();
    return { id, value: await this.#decryptStage(existing.encrypted_record, id) };
  }

  async #stagePage(id: string, cursorBefore: string, page: StoredHistoryPage['page']): Promise<StagedPage> {
    const resumed = await this.#resumeStage(id);
    if (resumed !== null) return resumed;
    const stagedAt = this.#now();
    const value: StoredHistoryPage = {
      cursorBefore,
      page: jsonClone(page),
      stagedObservedAt: new Date(stagedAt).toISOString(),
      messageStates: {},
    };
    const encrypted = await this.#encryptStage(value, id);
    const expiresAt = stagedAt + this.#shortestRetention();
    await this.#accountLive();
    this.#write(() => {
      // A page is kept only for the rule versions still live when it is written: one revoked during the provider call
      // or the encryption owes it nothing, and a page no live version owes would have nothing to resume or purge it.
      // A revoked version keeps its immutable row as `revoked`, so a revocation during the await is visible here.
      const live = this.#rules().filter((rule) => !isRevokedVersion(this.#store, rule.ruleId, rule.ruleVersion));
      if (live.length === 0) throw new StaleScanError();
      this.#store.database
        .prepare(
          `INSERT OR IGNORE INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES (?, 'gmail', ?, 'mailbox', ?, ?, ?, ?)`,
        )
        .run(id, this.#mailbox.accountId, stagedAt, expiresAt, encrypted, stagedAt);
      for (const rule of live) {
        this.#store.database
          .prepare(
            `INSERT OR IGNORE INTO source_stage_rule_debts (stage_id, rule_id, rule_version)
             VALUES (?, ?, ?)`,
          )
          .run(id, rule.ruleId, rule.ruleVersion);
      }
    });
    await this.#onPageStaged?.(id);
    return { id, value };
  }

  #shortestRetention(): number {
    const durations = this.#rules()
      .map((rule) => rule.ingestRetentionMs)
      .filter((value) => value > 0);
    if (durations.length === 0) return 86_400_000;
    return Math.min(...durations);
  }

  async #processPage(stage: StagedPage): Promise<'terminal' | 'pending' | 'held'> {
    if (this.#expired(stage.id)) {
      this.#terminaliseExpired(stage);
      return 'terminal';
    }
    const occurrences = occurrencesFromHistory(stage.value.page as Parameters<typeof occurrencesFromHistory>[0]);
    let held = false;
    for (const occurrence of occurrences) {
      if (stage.value.completedOccurrenceKeys?.includes(this.#occurrenceKey(occurrence))) continue;
      const outcome = await this.#processOccurrence(occurrence, stage);
      if (outcome === 'pending') return 'pending';
      if (outcome === 'held') {
        held = true;
        continue;
      }
      await this.#markOccurrenceComplete(stage, occurrence);
    }
    await this.#replacementDrains?.markPageDrained({
      accountId: this.#mailbox.accountId,
      historyId: stage.value.page.historyId,
    });
    if (held) return 'held';
    this.#write(() => {
      this.#store.database.prepare('DELETE FROM source_scan_state WHERE id = ?').run(stage.id);
    });
    return 'terminal';
  }

  #expired(stageId: string): boolean {
    const row = this.#store.database
      .prepare('SELECT stage_expires_at FROM source_scan_state WHERE id = ?')
      .get(stageId) as { stage_expires_at: number | null } | undefined;
    return row?.stage_expires_at !== null && row?.stage_expires_at !== undefined && row.stage_expires_at <= this.#now();
  }

  #terminaliseExpired(stage: StagedPage): void {
    const at = this.#now();
    this.#write(() => {
      for (const occurrence of occurrencesFromHistory(
        stage.value.page as Parameters<typeof occurrencesFromHistory>[0],
      )) {
        this.#store.database
          .prepare(
            `INSERT OR IGNORE INTO source_occurrence_resolutions
             (source, account_id, occurrence_key, outcome, resolved_at, error_code)
             VALUES ('gmail', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
          )
          .run(this.#mailbox.accountId, this.#occurrenceKey(occurrence), at);
      }
      this.#store.database.prepare('DELETE FROM source_scan_state WHERE id = ?').run(stage.id);
    });
  }

  #terminaliseOccurrence(
    occurrence: GmailHistoryOccurrence,
    outcome: 'vanished' | 'retention-expired',
    code: string,
  ): void {
    this.#write(() => {
      this.#store.database
        .prepare(
          `INSERT OR IGNORE INTO source_occurrence_resolutions
           (source, account_id, occurrence_key, outcome, resolved_at, error_code)
           VALUES ('gmail', ?, ?, ?, ?, ?)`,
        )
        .run(this.#mailbox.accountId, this.#occurrenceKey(occurrence), outcome, this.#now(), code);
    });
  }

  async #processOccurrence(
    occurrence: GmailHistoryOccurrence,
    stage: StagedPage,
  ): Promise<'terminal' | 'pending' | 'held'> {
    const candidates = this.#rules().filter((rule) =>
      occurrence.kind === 'labelled'
        ? rule.eventType === 'gmail.message.labelled'
        : rule.eventType === 'gmail.message.received' || rule.eventType === 'gmail.message.sent',
    );
    if (candidates.length === 0) return 'terminal';
    const eligibleCandidates: GmailSourceRule[] = [];
    for (const candidate of candidates) {
      if (
        await this.#replacementDrains?.shouldWithhold({
          accountId: this.#mailbox.accountId,
          ruleId: candidate.ruleId,
          ruleVersion: candidate.ruleVersion,
          historyRecordId: occurrence.historyRecordId,
        })
      ) {
        return 'held';
      }
      if (
        this.#replacementDrains !== undefined &&
        !(await this.#replacementDrains.isAfterActivePoint({
          accountId: this.#mailbox.accountId,
          ruleId: candidate.ruleId,
          ruleVersion: candidate.ruleVersion,
          historyRecordId: occurrence.historyRecordId,
        }))
      ) {
        continue;
      }
      eligibleCandidates.push(candidate);
    }
    if (eligibleCandidates.length === 0) return 'terminal';
    // Metadata determines whether this is sent or received. Until it does, every active candidate can be owed the
    // occurrence, so all of their exact lineages must pass before the provider's sender-controlled metadata is read.
    for (const candidate of eligibleCandidates) await this.#assertDisclosable(candidate);
    const event = await this.#eventFor(occurrence, stage, eligibleCandidates);
    if (event === undefined) return 'pending';
    if (event === null) return 'terminal';
    const selected = eligibleCandidates.filter((rule) => {
      if (rule.eventType !== event.type) return false;
      const selection =
        occurrence.kind === 'message'
          ? classifyGmailMessage(rule.options, { labelIds: event.labels as readonly string[] })
          : classifyGmailLabelChange(rule.options, occurrence);
      return selection.eligible;
    });
    const metadataRules = selected.filter((rule) => !this.#needsLazyField(rule, 'body'));
    for (const rule of metadataRules) {
      if ((await this.#admitEvent(occurrence, stage, event, rule)) !== 'terminal') return 'pending';
    }
    const bodyRules = selected.filter((rule) => this.#needsLazyField(rule, 'body'));
    if (bodyRules.length === 0) return 'terminal';
    if (!this.#materialise)
      throw new CommsError('CONFIG', 'the Gmail source worker needs a materialiser for a body-dependent rule');
    const stageExpiresAt = this.#stageExpiry(stage.id);
    if (stageExpiresAt === null) return 'pending';
    const requiredFields = [...new Set(bodyRules.flatMap((rule) => rule.lazyFields ?? []))].sort();
    const materializationKey = createHash('sha256').update(requiredFields.join(','), 'utf8').digest('hex');
    const requests = bodyRules.map((rule) => ({
      occurrenceKey: this.#occurrenceKey(occurrence),
      messageId: occurrence.messageId,
      ruleId: rule.ruleId,
      ruleVersion: rule.ruleVersion,
      materializationKey,
      stageExpiresAt,
    }));
    const results = await this.#materialise(requests);
    if (results.length !== bodyRules.length)
      throw new CommsError('BAD_DATA', 'the Gmail materialiser did not return one result for each affected projection');
    for (const [index, rule] of bodyRules.entries()) {
      const result = results[index];
      if (!result) throw new CommsError('BAD_DATA', 'the Gmail materialiser returned no projection result');
      if (result.state === 'pending') return 'pending';
      if (result.state !== 'ready') continue;
      // Gmail has sanitised this body already; no metadata-only projection sees it in memory or at rest.
      if ((await this.#admitEvent(occurrence, stage, { ...event, body: result.message.body }, rule)) !== 'terminal')
        return 'pending';
    }
    return 'terminal';
  }

  #needsLazyField(rule: GmailSourceRule, field: string): boolean {
    return (rule.lazyFields ?? []).includes(field);
  }

  async #admitEvent(
    occurrence: GmailHistoryOccurrence,
    stage: StagedPage,
    event: Record<string, unknown>,
    rule: GmailSourceRule,
  ): Promise<'terminal' | 'pending'> {
    const definition = this.#definitionFor(String(event.type));
    const dedupeKey = definition.dedupeKey(event as never, { historyRecordId: occurrence.historyRecordId } as never);
    const identity = {
      installationId: this.#store.installationId,
      accountId: this.#mailbox.accountId,
      eventType: definition.type,
      typeVersion: definition.version,
      dedupeKey,
    };
    const calculated = await this.#eventIdFor(identity);
    const full = { ...event, id: calculated };
    const checked = validateEvent(definition as never, full);
    if (!checked.ok)
      throw new CommsError('BAD_DATA', checked.issues[0]?.message ?? 'the Gmail occurrence is not a catalogue event');
    const validated = checked.value as unknown as Record<string, unknown>;
    this.#recordIdentity(calculated, identity, validated, String(validated.observedAt));
    return this.#admit({
      event: validated,
      eventId: calculated,
      preimage: eventIdPreimage(identity),
      rule,
      stageId: stage.id,
      observedAt: String(validated.observedAt),
    });
  }

  async #markOccurrenceComplete(stage: StagedPage, occurrence: GmailHistoryOccurrence): Promise<void> {
    const completedOccurrenceKeys = [...(stage.value.completedOccurrenceKeys ?? []), this.#occurrenceKey(occurrence)];
    await this.#persistStage(stage, { ...stage.value, completedOccurrenceKeys });
  }

  async #assertAllRules(): Promise<void> {
    for (const rule of this.#rules()) await this.#assertDisclosable(rule);
  }

  async #eventFor(
    occurrence: GmailHistoryOccurrence,
    stage: StagedPage,
    candidates: readonly GmailSourceRule[],
  ): Promise<Record<string, unknown> | null | undefined> {
    if (occurrence.kind === 'labelled') {
      let threadId = occurrence.threadId;
      if (threadId === undefined) {
        const metadata = await this.#metadataFor(occurrence, stage);
        if (metadata === undefined) return undefined;
        if (metadata === null) return null;
        threadId = metadata.threadId;
      }
      if (!threadId) throw new CommsError('BAD_DATA', 'a Gmail labelled history record has no thread id');
      return {
        id: '',
        type: 'gmail.message.labelled',
        version: 1,
        occurredAt: stage.value.stagedObservedAt,
        observedAt: stage.value.stagedObservedAt,
        account: { name: this.#mailbox.name, id: this.#mailbox.accountId, channel: 'gmail' },
        messageId: occurrence.messageId,
        threadId,
        added: occurrence.added,
        removed: occurrence.removed,
      };
    }
    const metadata = await this.#metadataFor(occurrence, stage);
    if (metadata === undefined) return undefined;
    if (metadata === null) return null;
    const type = (
      metadata.labels.includes('SENT') ? 'gmail.message.sent' : 'gmail.message.received'
    ) as GmailSourceRule['eventType'];
    if (!candidates.some((candidate) => candidate.eventType === type)) return null;
    const observedAt = this.#messageState(stage.value, occurrence).observedAt;
    if (observedAt === undefined)
      throw new CommsError('BAD_DATA', 'a classified Gmail occurrence has no durable observation time');
    return {
      id: '',
      type,
      version: 1,
      occurredAt: metadata.date,
      observedAt,
      account: { name: this.#mailbox.name, id: this.#mailbox.accountId, channel: 'gmail' },
      ...metadata,
    };
  }

  #messageState(value: StoredHistoryPage, occurrence: GmailHistoryOccurrence): StoredMessageState {
    return value.messageStates[this.#occurrenceKey(occurrence)] ?? {};
  }

  /**
   * A successful metadata response becomes observable only after its sanitised form and sampled time are encrypted
   * into the page continuation. Retrying an already staged observation never calls the provider or resamples time.
   */
  async #metadataFor(
    occurrence: GmailHistoryOccurrence,
    stage: StagedPage,
  ): Promise<GmailEventMessageMetadata | null | undefined> {
    const current = this.#messageState(stage.value, occurrence);
    if (current.metadata !== undefined) return current.metadata;
    const now = this.#now();
    const stageExpiry = this.#stageExpiry(stage.id);
    if (stageExpiry === null) return undefined;
    const retryDeadline =
      current.firstFailedAt === undefined ? Number.POSITIVE_INFINITY : current.firstFailedAt + MAX_RETRY_MS;
    const horizon = Math.min(stageExpiry, retryDeadline);
    if (now >= horizon) {
      if (horizon === stageExpiry) this.#terminaliseOccurrence(occurrence, 'retention-expired', 'STAGE_EXPIRED');
      else this.#terminaliseUnresolvableMetadata(occurrence, current.errorCode ?? 'METADATA_FAILED');
      return null;
    }
    if (current.nextRetryAt !== undefined && now < current.nextRetryAt) return undefined;
    try {
      const metadata = normaliseGmailEventMetadata(await this.#source.getMessageMetadata(occurrence.messageId));
      const next: StoredHistoryPage = {
        ...stage.value,
        messageStates: {
          ...stage.value.messageStates,
          [this.#occurrenceKey(occurrence)]: {
            metadata,
            observedAt: new Date(now).toISOString(),
          },
        },
      };
      await this.#persistStage(stage, next);
      return metadata;
    } catch (error) {
      if (error instanceof CommsError && error.code === 'NOT_FOUND') {
        this.#terminaliseOccurrence(occurrence, 'vanished', 'NOT_FOUND');
        return null;
      }
      const firstFailedAt = current.firstFailedAt ?? now;
      const attempts = (current.attempts ?? 0) + 1;
      const retryAt = Math.min(
        now +
          Math.min(BASE_BACKOFF_MS * 2 ** Math.min(attempts - 1, 8), MAX_BACKOFF_MS) +
          retryJitter(this.#occurrenceKey(occurrence), attempts),
        horizon,
      );
      const next: StoredHistoryPage = {
        ...stage.value,
        messageStates: {
          ...stage.value.messageStates,
          [this.#occurrenceKey(occurrence)]: {
            firstFailedAt,
            nextRetryAt: retryAt,
            attempts,
            errorCode: retryErrorCode(error),
          },
        },
      };
      await this.#persistStage(stage, next);
      return undefined;
    }
  }

  #stageExpiry(stageId: string): number | null {
    const row = this.#store.database
      .prepare('SELECT stage_expires_at FROM source_scan_state WHERE id = ?')
      .get(stageId) as { stage_expires_at: number | null } | undefined;
    return row?.stage_expires_at ?? null;
  }

  async #persistStage(stage: StagedPage, value: StoredHistoryPage): Promise<void> {
    const encrypted = await this.#encryptStage(value, stage.id);
    await this.#accountLive();
    const now = this.#now();
    this.#write(() => {
      this.#store.database
        .prepare('UPDATE source_scan_state SET encrypted_record = ?, updated_at = ? WHERE id = ?')
        .run(encrypted, now, stage.id);
    });
    stage.value = value;
  }

  #terminaliseUnresolvableMetadata(occurrence: GmailHistoryOccurrence, errorCode: string): void {
    const now = this.#now();
    this.#write(() => {
      this.#store.database
        .prepare(
          `INSERT OR IGNORE INTO source_occurrence_resolutions
           (source, account_id, occurrence_key, outcome, resolved_at, error_code)
           VALUES ('gmail', ?, ?, 'unresolvable', ?, ?)`,
        )
        .run(this.#mailbox.accountId, this.#occurrenceKey(occurrence), now, errorCode);
      this.#store.database
        .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
        .run(
          `gmail-metadata-gap:${this.#mailbox.accountId}:${this.#occurrenceKey(occurrence)}`,
          'agentcomms.source.gap',
          now,
        );
    });
  }

  #definitionFor(type: string) {
    if (type === 'gmail.message.received') return gmailMessageReceivedV1;
    if (type === 'gmail.message.sent') return gmailMessageSentV1;
    if (type === 'gmail.message.labelled') return gmailMessageLabelledV1;
    throw new CommsError('BAD_DATA', 'the Gmail worker produced an unknown catalogue type');
  }

  #recordIdentity(
    id: string,
    identity: {
      readonly installationId: string;
      readonly accountId: string;
      readonly eventType: string;
      readonly typeVersion: number;
      readonly dedupeKey: string;
    },
    event: Record<string, unknown>,
    observedAt: string,
  ): void {
    const existing = this.#identityRow(id);
    if (existing !== undefined) {
      if (!this.#sameIdentity(existing, identity)) this.#degradeForCollision(id);
      return;
    }
    try {
      this.#write(() => {
        this.#store.database
          .prepare(
            `INSERT INTO ingest
             (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            identity.installationId,
            identity.eventType,
            identity.typeVersion,
            identity.accountId,
            identity.dedupeKey,
            asMilliseconds(String(event.occurredAt)),
            asMilliseconds(observedAt),
            asMilliseconds(observedAt),
          );
      });
    } catch (error) {
      // A different mailbox can win a truncated-id insert while this worker is awaiting the identity hash. Compare
      // its complete durable tuple after the constraint race; never let SQLite merge two unequal preimages.
      const raced = this.#identityRow(id);
      if (raced === undefined) throw error;
      if (!this.#sameIdentity(raced, identity)) this.#degradeForCollision(id);
    }
  }

  #identityRow(
    id: string,
  ): { installation_id: string; account_id: string; type: string; version: number; dedupe_key: string } | undefined {
    return this.#store.database
      .prepare('SELECT installation_id, account_id, type, version, dedupe_key FROM ingest WHERE event_id = ?')
      .get(id) as
      | { installation_id: string; account_id: string; type: string; version: number; dedupe_key: string }
      | undefined;
  }

  #sameIdentity(
    stored: {
      readonly installation_id: string;
      readonly account_id: string;
      readonly type: string;
      readonly version: number;
      readonly dedupe_key: string;
    },
    identity: {
      readonly installationId: string;
      readonly accountId: string;
      readonly eventType: string;
      readonly typeVersion: number;
      readonly dedupeKey: string;
    },
  ): boolean {
    return (
      stored.installation_id === identity.installationId &&
      stored.account_id === identity.accountId &&
      stored.type === identity.eventType &&
      stored.version === identity.typeVersion &&
      stored.dedupe_key === identity.dedupeKey
    );
  }

  #degradeForCollision(id: string): never {
    this.#write(() => {
      this.#store.database
        .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
        .run(`gmail-collision:${this.#mailbox.accountId}`, 'source-degraded-event-id-collision', this.#now());
    });
    throw new CommsError('BAD_DATA', 'a Gmail event identity collision stopped this mailbox cursor', {
      details: { reason: 'EVENT_ID_COLLISION', eventId: id },
    });
  }

  async #rebaselineExpiredCursor(): Promise<{ readonly cursor: string; readonly pending: false }> {
    if (!this.#source.getProfile)
      throw new CommsError('CONFIG', 'the Gmail source cannot rebaseline an expired cursor');
    const profile = await this.#source.getProfile();
    await this.#accountLive();
    const now = this.#now();
    this.#write(() => {
      this.#store.database
        .prepare(
          `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', ?, ?)
           ON CONFLICT(source, account_id, cursor_scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .run(this.#mailbox.accountId, profile.historyId, now);
      this.#store.database
        .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
        .run(`gmail-gap:${this.#mailbox.accountId}:${now}`, 'agentcomms.source.gap', now);
    });
    return { cursor: profile.historyId, pending: false };
  }

  #occurrenceKey(occurrence: GmailHistoryOccurrence): string {
    return `${occurrence.historyRecordId}:${occurrence.kind}:${occurrence.messageId}`;
  }
}
