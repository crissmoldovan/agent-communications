import type { CutoverFailpoint } from '../runtime/cutover-failpoint.ts';
import type { AsyncSourceStageExpiry } from '../runtime/expiry.ts';
import type { EventDatabase } from '../store/database.ts';
import { type SourceScope, type SourceStageDebt, sourceStageRetentionForDebts } from './contracts.ts';
import type { ResendEventReader, ResendSentItem } from './resend.ts';
import { SourceScopeLock } from './scope-lock.ts';
import { isSourceScopeFenced } from './source-scope-fence.ts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_PAGE_BUDGET = 10;
const STATUS = new Set([
  'scheduled',
  'sent',
  'delivered',
  'delivery_delayed',
  'bounced',
  'complained',
  'opened',
  'clicked',
  'failed',
  'suppressed',
  'canceled',
  'queued',
]);

export interface ResendStatusChange {
  readonly emailId: string;
  readonly previous: string;
  readonly current: string;
  readonly observedAt: string;
  readonly from: ResendSentItem['from'];
  readonly to: ResendSentItem['to'];
  readonly cc: ResendSentItem['cc'];
  readonly bcc: ResendSentItem['bcc'];
  readonly subject: string;
  readonly createdAt: string | null;
  readonly scheduledAt: string | null;
  readonly messageId: string | null;
}

interface PendingStatusStage {
  readonly change: ResendStatusChange;
}

interface StatusScanContinuation {
  readonly after: string;
}

type StatusStoredRecord = PendingStatusStage | StatusScanContinuation;

interface LoadedPendingStatusStage {
  readonly id: string;
  readonly encryptedRecord: Uint8Array;
  readonly value: PendingStatusStage;
}

/** Common start-up/tick expiry for encrypted Resend status deltas. */
export class ResendStatusStageExpiry implements AsyncSourceStageExpiry {
  readonly #store: EventDatabase;
  readonly #decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
  readonly #lock: SourceScopeLock;
  readonly #now: () => number;

  constructor(
    input: Readonly<{
      store: EventDatabase;
      decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
      lock: SourceScopeLock;
      now?: (() => number) | undefined;
    }>,
  ) {
    this.#store = input.store;
    this.#decrypt = input.decrypt;
    this.#lock = input.lock;
    this.#now = input.now ?? Date.now;
  }

  async sweep(): Promise<number> {
    const accounts = this.#store.database
      .prepare(
        `SELECT DISTINCT account_id FROM source_scan_state
         WHERE source = 'resend' AND cursor_scope = 'status'
           AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
      )
      .all(this.#now()) as Array<{ account_id: string }>;
    let expired = 0;
    for (const { account_id: accountId } of accounts)
      expired += await this.#lock.withScope({ source: 'resend', accountId, scopeId: 'status' }, () =>
        this.#expireAccount(accountId),
      );
    return expired;
  }

  async #expireAccount(accountId: string): Promise<number> {
    const rows = this.#store.database
      .prepare(
        `SELECT id, encrypted_record, stage_expires_at FROM source_scan_state
         WHERE source = 'resend' AND account_id = ? AND cursor_scope = 'status'
           AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
      )
      .all(accountId, this.#now()) as Array<{
      id: string;
      encrypted_record: Uint8Array;
      stage_expires_at: number;
    }>;
    let expired = 0;
    for (const row of rows) {
      const value = (await this.#decrypt(row.encrypted_record, row.id)) as PendingStatusStage;
      expired += this.#store.immediate(() => {
        const present = this.#store.database
          .prepare(
            `SELECT 1 AS present FROM source_scan_state
             WHERE id = ? AND encrypted_record = ? AND stage_expires_at = ? AND stage_expires_at <= ?`,
          )
          .get(row.id, row.encrypted_record, row.stage_expires_at, this.#now()) as { present: number } | undefined;
        if (present === undefined) return 0;
        const now = this.#now();
        this.#store.database
          .prepare(
            `INSERT OR IGNORE INTO source_occurrence_resolutions
             (source, account_id, occurrence_key, outcome, resolved_at, error_code)
             VALUES ('resend', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
          )
          .run(accountId, statusOccurrenceKey(value.change), now);
        // The status value is the content-free continuation. Persisting it before removing the staged delta makes
        // an unchanged provider observation terminal on every later scan, rather than re-staging expired content.
        this.#store.database
          .prepare(
            `INSERT INTO resend_status_state (account_id, email_id, last_event, observed_at, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(account_id, email_id) DO UPDATE SET last_event = excluded.last_event,
               observed_at = excluded.observed_at, expires_at = excluded.expires_at`,
          )
          .run(accountId, value.change.emailId, value.change.current, now, now + WEEK_MS);
        const deleted = this.#store.database
          .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ? AND stage_expires_at = ?')
          .run(row.id, row.encrypted_record, row.stage_expires_at);
        if (Number(deleted.changes) !== 1) return 0;
        this.#store.database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(row.id);
        this.#store.database
          .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
          .run(`source-retention-expired:resend:${accountId}:${row.id}`, 'event.source.retention-expired', now);
        return 1;
      });
    }
    return expired;
  }
}

function statusOccurrenceKey(change: ResendStatusChange): string {
  return JSON.stringify([change.emailId, change.current, change.observedAt]);
}

/** The sent-mail observer retains only ids and last observed statuses, never an event payload. */
export class ResendStatusSource {
  readonly #store: EventDatabase;
  readonly #accountId: string;
  readonly #reader: ResendEventReader;
  readonly #admit: (change: ResendStatusChange) => Promise<'terminal' | 'pending'>;
  readonly #encrypt: (value: StatusStoredRecord, id: string) => Promise<Uint8Array>;
  readonly #decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
  readonly #debts: () => readonly SourceStageDebt[];
  readonly #assertWriteStillLive: () => void;
  readonly #now: () => number;
  readonly #scopeLock: SourceScopeLock;
  readonly #scope: SourceScope;
  readonly #failpoint: CutoverFailpoint | undefined;
  readonly #mayAdmit: (change: ResendStatusChange) => boolean;

  constructor(
    input: Readonly<{
      store: EventDatabase;
      accountId: string;
      reader: ResendEventReader;
      admit: (change: ResendStatusChange) => Promise<'terminal' | 'pending'>;
      encrypt: (value: StatusStoredRecord, id: string) => Promise<Uint8Array>;
      decrypt: (stored: Uint8Array, id: string) => Promise<unknown>;
      debts: () => readonly SourceStageDebt[];
      assertWriteStillLive?: (() => void) | undefined;
      scopeLock?: SourceScopeLock | undefined;
      now?: (() => number) | undefined;
      /** The old half of an exact replacement may observe at most values strictly before its durable P instant. */
      mayAdmit?: ((change: ResendStatusChange) => boolean) | undefined;
      /** Optional D8 crash seam; omitted in production. */
      failpoint?: CutoverFailpoint | undefined;
    }>,
  ) {
    this.#store = input.store;
    this.#accountId = input.accountId;
    this.#reader = input.reader;
    this.#admit = input.admit;
    this.#encrypt = input.encrypt;
    this.#decrypt = input.decrypt;
    this.#debts = input.debts;
    this.#assertWriteStillLive = input.assertWriteStillLive ?? (() => undefined);
    this.#now = input.now ?? Date.now;
    this.#scopeLock = input.scopeLock ?? new SourceScopeLock();
    this.#scope = { source: 'resend', accountId: input.accountId, scopeId: 'status' };
    this.#failpoint = input.failpoint;
    this.#mayAdmit = input.mayAdmit ?? (() => true);
  }

  async baseline(): Promise<string> {
    return this.#scopeLock.withScope(this.#scope, () => this.#baseline());
  }

  async #baseline(): Promise<string> {
    this.#assertUnfenced();
    const start = new Date(this.#now()).toISOString();
    this.#store.immediate(() => {
      this.#assertWriteStillLive();
      this.#assertUnfenced();
      this.#store.database
        .prepare(
          `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('resend', ?, 'status', ?, ?)
           ON CONFLICT(source, account_id, cursor_scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .run(this.#accountId, start, this.#now());
    });
    return start;
  }

  async scan(input: Readonly<{ maxPages?: number | undefined }> = {}): Promise<Readonly<{ pending: boolean }>> {
    const maxPages = input.maxPages ?? DEFAULT_PAGE_BUDGET;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1)
      throw new Error('a Resend status scan needs a positive page budget');
    return this.#scopeLock.withScope(this.#scope, () => this.#scan(maxPages));
  }

  async #scan(maxPages: number): Promise<Readonly<{ pending: boolean }>> {
    this.#assertUnfenced();
    let after = (await this.#loadContinuation())?.after;
    for (let pages = 0; pages < maxPages; pages += 1) {
      const page = await this.#reader.listSent(after);
      for (const item of page.emails) {
        if (!STATUS.has(item.lastEvent)) throw new Error('unsupported Resend status');
        const created = item.createdAt === null ? null : Date.parse(item.createdAt);
        if (created !== null && Number.isFinite(created) && created < this.#now() - WEEK_MS) continue;
        const pending = await this.#pending(item.id);
        if (pending !== null) {
          const result = await this.#admit(pending.value.change);
          if (result === 'terminal') {
            this.#settlePending(pending);
          }
          continue;
        }
        const existing = this.#store.database
          .prepare('SELECT last_event FROM resend_status_state WHERE account_id = ? AND email_id = ?')
          .get(this.#accountId, item.id) as { last_event: string } | undefined;
        if (existing === undefined) {
          this.#writeState(item.id, item.lastEvent);
          continue;
        }
        if (existing.last_event === item.lastEvent) {
          this.#writeState(item.id, item.lastEvent);
          continue;
        }
        const observedAt = new Date(this.#now()).toISOString();
        const change: ResendStatusChange = {
          emailId: item.id,
          previous: existing.last_event,
          current: item.lastEvent,
          observedAt,
          from: item.from,
          to: item.to,
          cc: item.cc,
          bcc: item.bcc,
          subject: item.subject,
          createdAt: item.createdAt,
          scheduledAt: item.scheduledAt,
          messageId: item.messageId,
        };
        // A status source has no ordered backlog. Once a replacement sampled P, an old rule may only seed its
        // content-free P state; it cannot consume an observation at/after P. Leaving the old P state intact lets
        // the new version, once installed, see this later change exactly once instead of silently losing it.
        if (!this.#mayAdmit(change)) {
          continue;
        }
        await this.#stage(change);
        const staged = await this.#pending(item.id);
        if (staged === null) continue;
        const result = await this.#admit(staged.value.change);
        if (result === 'terminal') {
          this.#settlePending(staged);
        }
      }
      if (page.next === null) {
        await this.#deleteContinuation();
        return { pending: false };
      }
      if (pages + 1 === maxPages) {
        await this.#saveContinuation({ after: page.next });
        return { pending: true };
      }
      after = page.next;
    }
    throw new Error('a Resend status scan exhausted its page budget unexpectedly');
  }

  pruneExpired(): number {
    return this.#store.immediate(() =>
      Number(
        this.#store.database.prepare('DELETE FROM resend_status_state WHERE expires_at <= ?').run(this.#now()).changes,
      ),
    );
  }

  async expireDue(): Promise<number> {
    return this.#scopeLock.withScope(this.#scope, async () => {
      const rows = this.#store.database
        .prepare(
          `SELECT id, encrypted_record, stage_expires_at FROM source_scan_state
           WHERE source = 'resend' AND account_id = ? AND cursor_scope = 'status'
             AND stage_expires_at IS NOT NULL AND stage_expires_at <= ?`,
        )
        .all(this.#accountId, this.#now()) as Array<{
        id: string;
        encrypted_record: Uint8Array;
        stage_expires_at: number;
      }>;
      let expired = 0;
      for (const row of rows) {
        const value = (await this.#decrypt(row.encrypted_record, row.id)) as PendingStatusStage;
        this.#store.immediate(() => {
          const present = this.#store.database
            .prepare(
              `SELECT 1 AS present FROM source_scan_state
               WHERE id = ? AND encrypted_record = ? AND stage_expires_at = ? AND stage_expires_at <= ?`,
            )
            .get(row.id, row.encrypted_record, row.stage_expires_at, this.#now()) as { present: number } | undefined;
          if (present === undefined) return;
          this.#store.database
            .prepare(
              `INSERT OR IGNORE INTO source_occurrence_resolutions
               (source, account_id, occurrence_key, outcome, resolved_at, error_code)
               VALUES ('resend', ?, ?, 'retention-expired', ?, 'STAGE_EXPIRED')`,
            )
            .run(this.#accountId, statusOccurrenceKey(value.change), this.#now());
          this.#store.database
            .prepare(
              `INSERT INTO resend_status_state (account_id, email_id, last_event, observed_at, expires_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(account_id, email_id) DO UPDATE SET last_event = excluded.last_event,
                 observed_at = excluded.observed_at, expires_at = excluded.expires_at`,
            )
            .run(this.#accountId, value.change.emailId, value.change.current, this.#now(), this.#now() + WEEK_MS);
          const deleted = this.#store.database
            .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ? AND stage_expires_at = ?')
            .run(row.id, row.encrypted_record, row.stage_expires_at);
          if (Number(deleted.changes) !== 1) return;
          this.#store.database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(row.id);
          this.#store.database
            .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
            .run(
              `source-retention-expired:resend:${this.#accountId}:${row.id}`,
              'event.source.retention-expired',
              this.#now(),
            );
          expired += 1;
        });
      }
      return expired;
    });
  }

  async #loadContinuation(): Promise<StatusScanContinuation | null> {
    const id = this.#continuationId();
    const row = this.#store.database
      .prepare("SELECT encrypted_record FROM source_scan_state WHERE id = ? AND cursor_scope = 'status-continuation'")
      .get(id) as { encrypted_record: Uint8Array } | undefined;
    if (row === undefined) return null;
    const value = (await this.#decrypt(row.encrypted_record, id)) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { after?: unknown }).after !== 'string' ||
      (value as { after: string }).after.length === 0
    )
      throw new Error('a Resend status continuation is malformed');
    return value as StatusScanContinuation;
  }

  async #saveContinuation(value: StatusScanContinuation): Promise<void> {
    const id = this.#continuationId();
    const encrypted = await this.#encrypt(value, id);
    this.#store.immediate(() => {
      this.#assertWriteStillLive();
      this.#assertUnfenced();
      this.#store.database
        .prepare(
          `INSERT INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES (?, 'resend', ?, 'status-continuation', NULL, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET encrypted_record = excluded.encrypted_record, updated_at = excluded.updated_at`,
        )
        .run(id, this.#accountId, encrypted, this.#now());
    });
  }

  async #deleteContinuation(): Promise<void> {
    this.#store.immediate(() => {
      this.#assertWriteStillLive();
      this.#assertUnfenced();
      this.#store.database
        .prepare("DELETE FROM source_scan_state WHERE id = ? AND cursor_scope = 'status-continuation'")
        .run(this.#continuationId());
    });
  }

  #writeState(emailId: string, lastEvent: string): void {
    const now = this.#now();
    this.#failpoint?.('before-move');
    this.#store.immediate(() => {
      this.#assertWriteStillLive();
      this.#assertUnfenced();
      this.#store.database
        .prepare(
          `INSERT INTO resend_status_state (account_id, email_id, last_event, observed_at, expires_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id, email_id) DO UPDATE SET last_event = excluded.last_event, observed_at = excluded.observed_at,
             expires_at = excluded.expires_at`,
        )
        .run(this.#accountId, emailId, lastEvent, now, now + WEEK_MS);
    });
    this.#failpoint?.('after-move');
  }

  async #pending(emailId: string): Promise<LoadedPendingStatusStage | null> {
    const id = this.#stageId(emailId);
    const row = this.#store.database
      .prepare(
        `SELECT encrypted_record FROM source_scan_state
         WHERE id = ? AND source = 'resend' AND account_id = ? AND cursor_scope = 'status'`,
      )
      .get(id, this.#accountId) as { encrypted_record: Uint8Array } | undefined;
    if (row === undefined) return null;
    return {
      id,
      encryptedRecord: row.encrypted_record,
      value: (await this.#decrypt(row.encrypted_record, id)) as PendingStatusStage,
    };
  }

  async #stage(change: ResendStatusChange): Promise<void> {
    this.#failpoint?.('before-stage');
    const id = this.#stageId(change.emailId);
    const encrypted = await this.#encrypt({ change }, id);
    const now = this.#now();
    const retention = sourceStageRetentionForDebts(now, this.#debts());
    this.#store.immediate(() => {
      this.#assertWriteStillLive();
      this.#assertUnfenced();
      this.#store.database
        .prepare(
          `INSERT OR IGNORE INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES (?, 'resend', ?, 'status', ?, ?, ?, ?)`,
        )
        .run(id, this.#accountId, retention.stagedAt, retention.stageExpiresAt, encrypted, now);
      const debt = this.#store.database.prepare(
        'INSERT OR IGNORE INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, ?)',
      );
      for (const rule of this.#debts()) debt.run(id, rule.ruleId, rule.ruleVersion);
    });
    this.#failpoint?.('after-stage');
  }

  #settlePending(pending: LoadedPendingStatusStage): void {
    this.#failpoint?.('before-move');
    this.#store.immediate(() => {
      this.#assertWriteStillLive();
      this.#assertUnfenced();
      const present = this.#store.database
        .prepare('SELECT 1 AS present FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
        .get(pending.id, pending.encryptedRecord) as { present: number } | undefined;
      if (present === undefined) throw new Error('stale Resend status stage');
      const now = this.#now();
      this.#store.database
        .prepare(
          `INSERT INTO resend_status_state (account_id, email_id, last_event, observed_at, expires_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id, email_id) DO UPDATE SET last_event = excluded.last_event, observed_at = excluded.observed_at,
             expires_at = excluded.expires_at`,
        )
        .run(this.#accountId, pending.value.change.emailId, pending.value.change.current, now, now + WEEK_MS);
      this.#store.database
        .prepare('DELETE FROM source_scan_state WHERE id = ? AND encrypted_record = ?')
        .run(pending.id, pending.encryptedRecord);
    });
    this.#failpoint?.('after-move');
  }

  #stageId(emailId: string): string {
    return `resend-status:${this.#accountId}:${emailId}`;
  }

  #continuationId(): string {
    return `resend-status-continuation:${this.#accountId}`;
  }

  #assertUnfenced(): void {
    if (isSourceScopeFenced(this.#store.database, this.#scope))
      throw new Error('the Resend status scope is fenced by an unpublished activation');
  }
}
