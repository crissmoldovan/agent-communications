import { createHash } from 'node:crypto';
import { CommsError, canonicalJson } from '@agentcomms/core';
import { normaliseWhatsAppSourceOptions, type WhatsAppSourceOptions } from '../domain/source-options.ts';
import type { CutoverFailpoint } from '../runtime/cutover-failpoint.ts';
import { insertWhatsAppRuleAdmissions } from '../runtime/whatsapp-admissions.ts';
import type { EventDatabase } from '../store/database.ts';
import { type LocalEventSource, type SourceScope, sourceStageRetentionForDebts } from './contracts.ts';
import type { SourceScopeLock } from './scope-lock.ts';

/** Structural channel operation seam. The daemon never obtains a WhatsApp provider or store handle. */
export interface WhatsAppEventSnapshotOperations {
  withEventSnapshot<T>(
    input: Readonly<{ accountId: string }>,
    work: (snapshot: WhatsAppEventSnapshot) => Promise<T> | T,
  ): Promise<T>;
}

export interface WhatsAppEventVisibility {
  readonly version: number;
  readonly digest: string;
  readonly seesMessage: (chatJid: string, chatKind: string, senderJidRaw: string, fromMe: boolean) => boolean;
}

export interface WhatsAppRawMessage {
  readonly chatJid: string | null;
  readonly chatKind?: string | null | undefined;
  readonly senderJidRaw: string | null;
  readonly stanzaId: string | null;
  readonly fromMe: boolean | null;
  readonly at?: string | null | undefined;
  readonly body?: string | null | undefined;
}

interface EligibleWhatsAppRawMessage extends WhatsAppRawMessage {
  readonly chatJid: string;
  readonly senderJidRaw: string;
  readonly stanzaId: string;
  readonly fromMe: false;
}

export interface WhatsAppEventSnapshot {
  readonly visibility: WhatsAppEventVisibility;
  readonly messages: readonly WhatsAppRawMessage[];
}

export interface WhatsAppSourceRule {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly ingestRetentionMs: number;
  readonly activationId: string;
}

export function rawWhatsAppMessageId(chatJid: string, senderJidRaw: string, stanzaId: string): string {
  return canonicalJson(['wa-msg', chatJid, senderJidRaw, stanzaId]);
}

function stageIdFor(accountId: string, messageId: string): string {
  return `whatsapp:${accountId}:${createHash('sha256').update(messageId, 'utf8').digest('hex')}`;
}

function eligible(
  message: WhatsAppRawMessage,
  visibility: WhatsAppEventVisibility,
): message is EligibleWhatsAppRawMessage {
  return (
    message.fromMe === false &&
    typeof message.chatJid === 'string' &&
    message.chatJid.length > 0 &&
    typeof message.senderJidRaw === 'string' &&
    message.senderJidRaw.length > 0 &&
    typeof message.stanzaId === 'string' &&
    message.stanzaId.length > 0 &&
    visibility.seesMessage(message.chatJid, message.chatKind ?? 'unknown', message.senderJidRaw, false)
  );
}

interface Head {
  readonly committed_generation: number;
  readonly visibility_version: number;
}

/**
 * D4's raw-key snapshot adapter. It writes only D-owned candidate/head/ledger state; event normalisation and
 * delivery remain the generic daemon's later responsibility. A checked-copy operation holds its list gate around
 * this method's callback, so no list update can land between its final visibility read and the SQLite switch.
 */
export class WhatsAppSourceWorker {
  readonly #store: EventDatabase;
  readonly #accountId: string;
  readonly #snapshot: WhatsAppSourceWorkerOptions['snapshot'];
  readonly #stage: WhatsAppSourceWorkerOptions['stage'];
  readonly #rules: WhatsAppSourceWorkerOptions['rules'];
  readonly #now: () => number;
  readonly #assertWrite: (() => void) | undefined;
  readonly #sourceOptions: WhatsAppSourceOptions | undefined;
  readonly #failpoint: CutoverFailpoint | undefined;

  constructor(options: WhatsAppSourceWorkerOptions) {
    this.#store = options.store;
    this.#accountId = options.accountId;
    this.#snapshot = options.snapshot;
    this.#stage = options.stage;
    this.#rules = options.rules;
    this.#now = options.now ?? Date.now;
    this.#assertWrite = options.assertWrite;
    this.#sourceOptions = options.sourceOptions;
    this.#failpoint = options.failpoint;
  }

  async scan(): Promise<Readonly<{ generation: number; newMessages: number }>> {
    return this.#snapshot(async (snapshot) => {
      const candidates = new Map<string, EligibleWhatsAppRawMessage>();
      for (const message of snapshot.messages) {
        if (!eligible(message, snapshot.visibility)) continue;
        if (this.#sourceOptions?.chats !== undefined && this.#sourceOptions.chats !== 'all-allowed') {
          if (!this.#sourceOptions.chats.includes(message.chatJid)) continue;
        }
        const key = rawWhatsAppMessageId(message.chatJid, message.senderJidRaw, message.stanzaId);
        if (!candidates.has(key)) candidates.set(key, message);
      }
      const { generation, added } = this.prepareCandidate(snapshot.visibility, candidates);
      try {
        // This is the owed-rule snapshot for the complete checked-copy pass. A later activation never turns an
        // already observed key into a new backfill candidate.
        const debts = this.#rules();
        const stageable = debts.length === 0 ? [] : added;
        const encrypted = new Map<string, Uint8Array>();
        this.#failpoint?.('before-stage');
        for (const [messageId, message] of stageable) encrypted.set(messageId, await this.#stage(message));
        this.commitCandidate(snapshot.visibility, generation, stageable, debts, encrypted);
        this.#failpoint?.('after-stage');
        return { generation, newMessages: stageable.length };
      } catch (error) {
        // Candidate keys without an authoritative head have no meaning and must not survive recovery.
        this.#store.immediate(() => {
          this.#store.database
            .prepare(
              `DELETE FROM whatsapp_snapshot_keys
                WHERE account_id = ? AND generation = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM whatsapp_snapshot_heads
                     WHERE account_id = ? AND committed_generation = ?
                  )`,
            )
            .run(this.#accountId, generation, this.#accountId, generation);
        });
        throw error;
      }
    });
  }

  private prepareCandidate(
    visibility: WhatsAppEventVisibility,
    candidates: ReadonlyMap<string, EligibleWhatsAppRawMessage>,
  ): Readonly<{ generation: number; added: readonly (readonly [string, EligibleWhatsAppRawMessage])[] }> {
    return this.#store.immediate(() => {
      const head = this.currentHead();
      // A crash after candidate-key persistence cannot change the source's authority. Discard it before comparing.
      this.#store.database
        .prepare('DELETE FROM whatsapp_snapshot_keys WHERE account_id = ? AND generation > ?')
        .run(this.#accountId, head?.committed_generation ?? 0);
      const persisted = this.ensureVisibility(visibility);
      const currentGeneration = head?.committed_generation ?? 0;
      const present = new Set(
        (
          this.#store.database
            .prepare(
              `SELECT chat_jid, sender_jid_raw, stanza_id
                 FROM whatsapp_snapshot_keys
                WHERE account_id = ? AND generation = ?`,
            )
            .all(this.#accountId, currentGeneration) as Array<{
            chat_jid: string;
            sender_jid_raw: string;
            stanza_id: string;
          }>
        ).map((row) => rawWhatsAppMessageId(row.chat_jid, row.sender_jid_raw, row.stanza_id)),
      );
      const generation = currentGeneration + 1;
      const keys = [...candidates].sort(([left], [right]) => left.localeCompare(right));
      for (const [, message] of keys) {
        this.#store.database
          .prepare(
            `INSERT INTO whatsapp_snapshot_keys
              (account_id, generation, visibility_version, chat_jid, sender_jid_raw, stanza_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(this.#accountId, generation, persisted.version, message.chatJid, message.senderJidRaw, message.stanzaId);
      }
      const added = keys.filter(([messageId]) => !present.has(messageId));
      if (added.length === 0) return { generation, added: [] };
      const marks = added.map(() => '?').join(', ');
      const observed = new Set(
        (
          this.#store.database
            .prepare(
              `SELECT message_id FROM whatsapp_occurrences
                WHERE account_id = ? AND message_id IN (${marks})`,
            )
            .all(this.#accountId, ...added.map(([messageId]) => messageId)) as Array<{ message_id: string }>
        ).map((row) => row.message_id),
      );
      // A tuple that disappeared and reappeared may advance the raw snapshot head, but it has already had its one
      // first representation and its one owed-rule admission snapshot.  Never stage or admit it a second time.
      return { generation, added: added.filter(([messageId]) => !observed.has(messageId)) };
    });
  }

  private commitCandidate(
    visibility: WhatsAppEventVisibility,
    generation: number,
    added: readonly (readonly [string, EligibleWhatsAppRawMessage])[],
    debts: readonly WhatsAppSourceRule[],
    encrypted: ReadonlyMap<string, Uint8Array>,
  ): void {
    const now = this.#now();
    const retention = added.length === 0 ? undefined : sourceStageRetentionForDebts(now, debts);
    this.#failpoint?.('before-move');
    this.#store.immediate(() => {
      this.#assertWrite?.();
      const live = this.#store.database
        .prepare('SELECT version, lists_digest FROM whatsapp_visibility WHERE account_id = ?')
        .get(this.#accountId) as { version: number; lists_digest: string } | undefined;
      if (live === undefined || live.lists_digest !== visibility.digest)
        throw new CommsError('APPROVAL_VOID', 'the WhatsApp visibility changed before the candidate could commit');
      const before = this.currentHead();
      if ((before?.committed_generation ?? 0) !== generation - 1)
        throw new CommsError('APPROVAL_VOID', 'the WhatsApp snapshot head changed before the candidate could commit');
      for (const [messageId, message] of added) {
        if (retention === undefined) throw new CommsError('BAD_DATA', 'a WhatsApp representation has no owed rule');
        const stageId = stageIdFor(this.#accountId, messageId);
        const record = encrypted.get(messageId);
        if (record === undefined) throw new CommsError('BAD_DATA', 'a WhatsApp first representation was not staged');
        this.#store.database
          .prepare(
            `INSERT OR IGNORE INTO source_scan_state
              (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
             VALUES (?, 'whatsapp', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            stageId,
            this.#accountId,
            `chat:${message.chatJid}`,
            retention.stagedAt,
            retention.stageExpiresAt,
            record,
            now,
          );
        for (const debt of debts) {
          this.#store.database
            .prepare(`INSERT OR IGNORE INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, ?)`)
            .run(stageId, debt.ruleId, debt.ruleVersion);
        }
        this.#store.database
          .prepare(
            `INSERT OR IGNORE INTO whatsapp_occurrences
              (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, staged_payload_ref, stage_expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(this.#accountId, messageId, generation, now, live.version, stageId, retention.stageExpiresAt);
        insertWhatsAppRuleAdmissions(this.#store.database, {
          accountId: this.#accountId,
          messageId,
          debts,
          visibilityVersion: live.version,
          admittedAt: now,
        });
      }
      if (before === undefined) {
        this.#store.database
          .prepare(
            'INSERT INTO whatsapp_snapshot_heads (account_id, committed_generation, visibility_version) VALUES (?, ?, ?)',
          )
          .run(this.#accountId, generation, live.version);
      } else {
        this.#store.database
          .prepare(
            `UPDATE whatsapp_snapshot_heads SET committed_generation = ?, visibility_version = ?
              WHERE account_id = ? AND committed_generation = ?`,
          )
          .run(generation, live.version, this.#accountId, before.committed_generation);
      }
    });
    this.#failpoint?.('after-move');
  }

  private ensureVisibility(visibility: WhatsAppEventVisibility): { readonly version: number } {
    const row = this.#store.database
      .prepare('SELECT version, lists_digest FROM whatsapp_visibility WHERE account_id = ?')
      .get(this.#accountId) as { version: number; lists_digest: string } | undefined;
    if (row !== undefined) {
      if (row.lists_digest !== visibility.digest)
        throw new CommsError('APPROVAL_VOID', 'the WhatsApp list journal is stale at candidate preparation');
      return row;
    }
    this.#store.database
      .prepare('INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, ?)')
      .run(this.#accountId, visibility.digest, this.#now());
    return { version: 1 };
  }

  private currentHead(): Head | undefined {
    return this.#store.database
      .prepare('SELECT committed_generation, visibility_version FROM whatsapp_snapshot_heads WHERE account_id = ?')
      .get(this.#accountId) as Head | undefined;
  }
}

export interface WhatsAppSourceWorkerOptions {
  readonly store: EventDatabase;
  readonly accountId: string;
  readonly snapshot: <T>(work: (snapshot: WhatsAppEventSnapshot) => Promise<T> | T) => Promise<T>;
  readonly stage: (message: EligibleWhatsAppRawMessage) => Promise<Uint8Array>;
  readonly rules: () => readonly WhatsAppSourceRule[];
  readonly now?: (() => number) | undefined;
  /** The canonical D4 selector for this rule-version scan; live lists remain the separate D6 capability fence. */
  readonly sourceOptions?: WhatsAppSourceOptions | undefined;
  /** The owner supplies the common post-await account/switch/rule/fence recheck inside the commit transaction. */
  readonly assertWrite?: (() => void) | undefined;
  /** Optional D8 crash seam; omitted in production. */
  readonly failpoint?: CutoverFailpoint | undefined;
}

/** The registry adapter uses Task 3's per-scope locks and never creates a second WhatsApp deadline or fence. */
export function createWhatsAppLocalEventSource(): LocalEventSource {
  return {
    source: 'whatsapp',
    canonicalise: normaliseWhatsAppSourceOptions,
    scopesFor: ({ accountId, options }) => {
      const source = options as WhatsAppSourceOptions | undefined;
      if (source?.channel !== 'whatsapp') return [];
      // The wildcard is still one concrete account-owned scheduling scope. Returning no scope here made an
      // approved all-allowed rule permanently dark: it had neither a D2 point nor an owner turn.
      if (source.chats === 'all-allowed') return [{ source: 'whatsapp', accountId, scopeId: 'all-allowed' }];
      return source.chats.map((chatJid) => ({ source: 'whatsapp', accountId, scopeId: `chat:${chatJid}` }));
    },
    withScopes: (lock: SourceScopeLock, scopes: readonly SourceScope[], work) => lock.withScopes(scopes, work),
    baseline: (sample) => sample(),
    resume: (step) => step(),
    describeCursor: (cursor) => cursor,
    cleanup: (_kind, work) => Promise.resolve(work()),
  };
}
