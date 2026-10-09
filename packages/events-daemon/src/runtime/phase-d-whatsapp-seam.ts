import type { DatabaseSync } from 'node:sqlite';

/** The daemon's already-open SQLite transaction; Phase D participants never begin or commit one themselves. */
export type SqliteTransaction = DatabaseSync;

/** The raw D identity that a visibility fence holds while a physical SSE frame is written. */
export type WhatsAppSseFrameInput = Readonly<{
  readonly accountId: string;
  readonly whatsappMessageId: string;
}>;

/**
 * Phase D supplies the concrete list-lock implementation.  The callback form is deliberately synchronous: the
 * visibility check and physical frame write share one lock acquisition and no promise continuation may escape it.
 */
export interface SseFrameVisibilityGate {
  withCurrentSseFrameVisibility<T>(input: WhatsAppSseFrameInput, writeFrame: () => T): T;
}

export type WhatsAppListChangeInput = Readonly<{
  readonly accountId: string;
  readonly newlyHiddenMessageIds: readonly string[];
  readonly visibilityVersion: number;
  readonly changedAt: string;
}>;

export interface WhatsAppListChangeParticipant {
  purgeNewlyHiddenInTransaction(transaction: SqliteTransaction, input: WhatsAppListChangeInput): void;
}

export type DRetentionKind =
  | 'ingest'
  | 'hold'
  | 'delivery'
  | 'dead-letter'
  | 'dry-run'
  | 'sse-replay'
  | 'decision-metadata';

export type DSourceRetentionTighteningInput = Readonly<{
  readonly ruleId: string;
  readonly affectedVersionIds: readonly string[];
  readonly revokedVersionId: string;
  readonly at: string;
  readonly changes: readonly Readonly<{ readonly retention: DRetentionKind; readonly durationMs: number }>[];
}>;

export interface DSourceRetentionParticipant {
  shortenOrPurgeInTransaction(transaction: SqliteTransaction, input: DSourceRetentionTighteningInput): void;
}

/** The structural registry Phase D owns once it composes its source into the daemon owner. */
export interface DSourceRetentionHooks {
  registerWhatsAppListChangeParticipant(participant: WhatsAppListChangeParticipant): void;
  registerRetentionTighteningParticipant(participant: DSourceRetentionParticipant): void;
}

/** B2's pre-D default: exactly one synchronous callback invocation and no visibility decision of its own. */
export class PassThroughSseFrameVisibilityGate implements SseFrameVisibilityGate {
  withCurrentSseFrameVisibility<T>(_input: WhatsAppSseFrameInput, writeFrame: () => T): T {
    return writeFrame();
  }
}

/** B2 does not register list or retention participants; Phase D's owner composition is their sole registrar. */
export class NoopDSourceRetentionHooks implements DSourceRetentionHooks {
  registerWhatsAppListChangeParticipant(_participant: WhatsAppListChangeParticipant): void {}

  registerRetentionTighteningParticipant(_participant: DSourceRetentionParticipant): void {}
}
