import { CommsError } from '@agentcomms/core';
import { type GmailEventMessageMetadata, type GmailEventSource, normaliseGmailEventMetadata } from '@agentcomms/gmail';
import type { EventDatabase } from '../store/database.ts';

type GmailMaterialisationSource = Pick<GmailEventSource, 'getMessage'> &
  Partial<Pick<GmailEventSource, 'getAttachment'>>;

export interface GmailMaterialisationRequest {
  readonly occurrenceKey: string;
  readonly messageId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  /** `body`, `attachments`, or one attachment-byte read required by a later projection. */
  readonly materializationKey: string;
  readonly stageExpiresAt: number;
}

export type GmailMaterialisationResult =
  | { readonly state: 'ready'; readonly message: GmailEventMessageMetadata }
  | { readonly state: 'pending'; readonly retryAt: number }
  | { readonly state: 'vanished' | 'unresolvable' | 'retention-expired' };

export interface GmailMaterialisationRetryState {
  readonly first_failed_at: number;
  readonly next_retry_at: number;
  readonly attempts: number;
  readonly error_code: string;
}

const MAX_RETRY_MS = 86_400_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;

function outcomeOf(value: string): Extract<GmailMaterialisationResult, { readonly state: string }> {
  if (value === 'vanished' || value === 'unresolvable' || value === 'retention-expired') return { state: value };
  throw new Error('invalid persisted Gmail materialisation outcome');
}

function errorCode(error: unknown): string {
  return error instanceof CommsError ? error.code : 'MATERIALISATION_FAILED';
}

/**
 * Resolves a body or attachment only for a projection that needs it. Its retry row is content-free; the first failure
 * fixes the retry horizon, and a terminal row prevents a later poll from fetching the same vanished message again.
 */
export class GmailMaterialiser {
  readonly #store: EventDatabase;
  readonly #accountId: string;
  readonly #source: GmailMaterialisationSource;
  readonly #assertDisclosable: () => Promise<void>;
  readonly #encryptState: (value: GmailMaterialisationRetryState) => Promise<Uint8Array>;
  readonly #decryptState: (stored: Uint8Array) => Promise<GmailMaterialisationRetryState>;
  readonly #now: () => number;

  constructor(options: {
    readonly store: EventDatabase;
    readonly accountId: string;
    readonly source: GmailMaterialisationSource;
    /** The same live source fence used before staging and projection. */
    readonly assertDisclosable: () => Promise<void>;
    /** Retry continuations use the same encrypted source state as raw Gmail pages. */
    readonly encryptState: (value: GmailMaterialisationRetryState) => Promise<Uint8Array>;
    readonly decryptState: (stored: Uint8Array) => Promise<GmailMaterialisationRetryState>;
    readonly now?: (() => number) | undefined;
  }) {
    this.#store = options.store;
    this.#accountId = options.accountId;
    this.#source = options.source;
    this.#assertDisclosable = options.assertDisclosable;
    this.#encryptState = options.encryptState;
    this.#decryptState = options.decryptState;
    this.#now = options.now ?? Date.now;
  }

  async materialise(request: GmailMaterialisationRequest): Promise<GmailMaterialisationResult> {
    const terminal = this.#terminal(request);
    if (terminal !== null) return terminal;
    const now = this.#now();
    if (now >= request.stageExpiresAt) return this.#terminalise(request, 'retention-expired', 'STAGE_EXPIRED');
    const retry = await this.#retry(request);
    const horizon =
      retry === null ? request.stageExpiresAt : Math.min(retry.first_failed_at + MAX_RETRY_MS, request.stageExpiresAt);
    if (now >= horizon) {
      return this.#terminalise(
        request,
        horizon === request.stageExpiresAt ? 'retention-expired' : 'unresolvable',
        'RETRY_EXHAUSTED',
      );
    }
    if (retry !== null && now < retry.next_retry_at) return { state: 'pending', retryAt: retry.next_retry_at };
    await this.#assertDisclosable();
    try {
      const message = await this.#source.getMessage(request.messageId);
      const normalised = normaliseGmailEventMetadata(message, { includeBody: true });
      this.#store.immediate(() => {
        this.#store.database.prepare('DELETE FROM source_scan_state WHERE id = ?').run(this.#stateId(request));
      });
      return { state: 'ready', message: normalised };
    } catch (error) {
      if (error instanceof CommsError && error.code === 'NOT_FOUND')
        return this.#terminalise(request, 'vanished', 'NOT_FOUND');
      return this.#recordRetry(request, retry, errorCode(error));
    }
  }

  #terminal(request: GmailMaterialisationRequest): GmailMaterialisationResult | null {
    const row = this.#store.database
      .prepare(
        `SELECT outcome FROM source_projection_resolutions
         WHERE source = 'gmail' AND account_id = ? AND occurrence_key = ? AND rule_id = ? AND rule_version = ? AND materialization_key = ?`,
      )
      .get(this.#accountId, request.occurrenceKey, request.ruleId, request.ruleVersion, request.materializationKey) as
      | { outcome: string }
      | undefined;
    return row === undefined ? null : outcomeOf(row.outcome);
  }

  async #retry(request: GmailMaterialisationRequest): Promise<GmailMaterialisationRetryState | null> {
    const row = this.#store.database
      .prepare(
        `SELECT encrypted_record FROM source_scan_state
         WHERE id = ? AND source = 'gmail' AND account_id = ? AND cursor_scope = 'materialisation'`,
      )
      .get(this.#stateId(request), this.#accountId) as { encrypted_record: Uint8Array } | undefined;
    return row === undefined ? null : this.#decryptState(row.encrypted_record);
  }

  #terminalise(
    request: GmailMaterialisationRequest,
    outcome: 'vanished' | 'unresolvable' | 'retention-expired',
    code: string,
  ): GmailMaterialisationResult {
    const now = this.#now();
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          `INSERT OR IGNORE INTO source_projection_resolutions
           (source, account_id, occurrence_key, rule_id, rule_version, materialization_key, outcome, resolved_at, error_code)
           VALUES ('gmail', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#accountId,
          request.occurrenceKey,
          request.ruleId,
          request.ruleVersion,
          request.materializationKey,
          outcome,
          now,
          code,
        );
      this.#store.database.prepare('DELETE FROM source_scan_state WHERE id = ?').run(this.#stateId(request));
      if (outcome === 'unresolvable') {
        this.#store.database
          .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
          .run(`gmail-materialisation-gap:${this.#accountId}:${request.occurrenceKey}`, 'agentcomms.source.gap', now);
      }
    });
    return { state: outcome };
  }

  async #recordRetry(
    request: GmailMaterialisationRequest,
    previous: GmailMaterialisationRetryState | null,
    code: string,
  ): Promise<GmailMaterialisationResult> {
    const now = this.#now();
    const firstFailedAt = previous?.first_failed_at ?? now;
    const attempts = (previous?.attempts ?? 0) + 1;
    const horizon = Math.min(firstFailedAt + MAX_RETRY_MS, request.stageExpiresAt);
    if (now >= horizon)
      return this.#terminalise(
        request,
        horizon === request.stageExpiresAt ? 'retention-expired' : 'unresolvable',
        'RETRY_EXHAUSTED',
      );
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(attempts - 1, 8), MAX_BACKOFF_MS);
    const retryAt = Math.min(now + backoff, horizon);
    const state: GmailMaterialisationRetryState = {
      first_failed_at: firstFailedAt,
      next_retry_at: retryAt,
      attempts,
      error_code: code,
    };
    const encrypted = await this.#encryptState(state);
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          `INSERT INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES (?, 'gmail', ?, 'materialisation', NULL, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET encrypted_record = excluded.encrypted_record, updated_at = excluded.updated_at`,
        )
        .run(this.#stateId(request), this.#accountId, encrypted, now);
    });
    return { state: 'pending', retryAt };
  }

  #stateId(request: GmailMaterialisationRequest): string {
    return `gmail-materialisation:${this.#accountId}:${request.occurrenceKey}:${request.ruleId}:${request.ruleVersion}:${request.materializationKey}`;
  }
}
