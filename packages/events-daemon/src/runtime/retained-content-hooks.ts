import type { DatabaseSync } from 'node:sqlite';
import { CommsError, canonicalJson } from '@agentcomms/core';

/** The daemon's already-open SQLite transaction; participants may make synchronous SQL calls only. */
export type SqliteTransaction = DatabaseSync;

export interface WhatsAppListChangeParticipant {
  purgeNewlyHiddenInTransaction(
    tx: SqliteTransaction,
    input: Readonly<{
      accountId: string;
      newlyHiddenMessageIds: readonly string[];
      visibilityVersion: number;
      changedAt: string;
    }>,
  ): void;
}

export type DRetentionKind =
  | 'ingest'
  | 'hold'
  | 'delivery'
  | 'dead-letter'
  | 'dry-run'
  | 'sse-replay'
  | 'decision-metadata';

export interface DSourceRetentionParticipant {
  shortenOrPurgeInTransaction(
    tx: SqliteTransaction,
    input: Readonly<{
      ruleId: string;
      affectedVersionIds: readonly string[];
      revokedVersionId: string;
      at: string;
      changes: readonly Readonly<{ readonly retention: DRetentionKind; readonly durationMs: number }>[];
    }>,
  ): void;
}

export interface DSourceRetentionHooks {
  registerWhatsAppListChangeParticipant(participant: WhatsAppListChangeParticipant): void;
  registerRetentionTighteningParticipant(participant: DSourceRetentionParticipant): void;
}

/** The in-transaction half used by the derived-tightening authority path. */
export interface DSourceRetentionTighteningDispatcher {
  dispatchRetentionTighteningInTransaction(
    tx: SqliteTransaction,
    input: Readonly<{
      ruleId: string;
      affectedVersionIds: readonly string[];
      revokedVersionId: string;
      at: string;
      changes: readonly Readonly<{ readonly retention: DRetentionKind; readonly durationMs: number }>[];
    }>,
  ): void;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function invokeSynchronously(action: () => unknown): void {
  if (isPromiseLike(action()))
    throw new CommsError(
      'CONFIG',
      'a retained-content participant must finish synchronously in the supplied transaction',
    );
}

function isCanonicalWhatsAppMessageId(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((part) => typeof part === 'string' && part.length > 0) &&
      parsed[0] === 'wa-msg' &&
      canonicalJson(parsed) === value
    );
  } catch {
    return false;
  }
}

/**
 * The Phase-D seam for retained content owned by a later delivery phase. It owns no B2 schema and never begins or
 * commits a transaction: its caller has already opened the D pointer/list transaction that the participant joins.
 */
export class RetainedContentHooks implements DSourceRetentionHooks, DSourceRetentionTighteningDispatcher {
  #listParticipant: WhatsAppListChangeParticipant | undefined;
  #retentionParticipant: DSourceRetentionParticipant | undefined;

  registerWhatsAppListChangeParticipant(participant: WhatsAppListChangeParticipant): void {
    if (this.#listParticipant !== undefined)
      throw new CommsError('CONFIG', 'a WhatsApp list-change participant is already registered');
    this.#listParticipant = participant;
  }

  registerRetentionTighteningParticipant(participant: DSourceRetentionParticipant): void {
    if (this.#retentionParticipant !== undefined)
      throw new CommsError('CONFIG', 'a retention-tightening participant is already registered');
    this.#retentionParticipant = participant;
  }

  dispatchWhatsAppListChangeInTransaction(
    tx: SqliteTransaction,
    input: Readonly<{
      accountId: string;
      newlyHiddenMessageIds: readonly string[];
      visibilityVersion: number;
      changedAt: string;
    }>,
  ): void {
    if (!Number.isSafeInteger(input.visibilityVersion) || input.visibilityVersion < 1)
      throw new CommsError('BAD_DATA', 'a WhatsApp visibility change needs a positive version');
    if (input.newlyHiddenMessageIds.some((messageId) => !isCanonicalWhatsAppMessageId(messageId)))
      throw new CommsError('BAD_DATA', 'a WhatsApp visibility change has a non-canonical message id');
    if (new Set(input.newlyHiddenMessageIds).size !== input.newlyHiddenMessageIds.length)
      throw new CommsError('BAD_DATA', 'a WhatsApp visibility change has duplicate message ids');
    if (this.#listParticipant === undefined) return;
    invokeSynchronously(() => this.#listParticipant?.purgeNewlyHiddenInTransaction(tx, input));
  }

  dispatchRetentionTighteningInTransaction(
    tx: SqliteTransaction,
    input: Readonly<{
      ruleId: string;
      affectedVersionIds: readonly string[];
      revokedVersionId: string;
      at: string;
      changes: readonly Readonly<{ readonly retention: DRetentionKind; readonly durationMs: number }>[];
    }>,
  ): void {
    if (
      input.affectedVersionIds.length === 0 ||
      new Set(input.affectedVersionIds).size !== input.affectedVersionIds.length
    )
      throw new CommsError('BAD_DATA', 'a retention tightening needs one unique affected version set');
    if (!input.affectedVersionIds.includes(input.revokedVersionId))
      throw new CommsError('BAD_DATA', 'a retention tightening must name its revoked version in the affected set');
    if (input.changes.some((change) => !Number.isSafeInteger(change.durationMs) || change.durationMs <= 0))
      throw new CommsError('BAD_DATA', 'a retention tightening has an invalid duration');
    if (this.#retentionParticipant === undefined) return;
    invokeSynchronously(() => this.#retentionParticipant?.shortenOrPurgeInTransaction(tx, input));
  }
}
