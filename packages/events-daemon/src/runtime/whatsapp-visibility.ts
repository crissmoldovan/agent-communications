import { CommsError, canonicalJson } from '@agentcomms/core';
import { chatKindOf } from '@agentcomms/whatsapp';
import type { EventDatabase } from '../store/database.ts';
import type { WhatsAppVisibilityRecheck } from './phase-d-whatsapp-seam.ts';
import { purgeWhatsAppStagedPayload } from './whatsapp-staged-payload.ts';

export interface CurrentWhatsAppEventVisibility {
  /** The channel file format version; the daemon journal version is stored separately. */
  readonly version: number;
  readonly digest: string;
  readonly seesMessage: (chatJid: string, chatKind: string, senderJidRaw: string, fromMe: boolean) => boolean;
}

export type WithCurrentWhatsAppEventVisibility = <T>(
  input: Readonly<{ accountId: string }>,
  work: (visibility: CurrentWhatsAppEventVisibility) => Promise<T> | T,
) => Promise<T>;

interface RawKey {
  readonly chatJid: string;
  readonly senderJidRaw: string;
  readonly stanzaId: string;
}

interface ListChangeHooks {
  dispatchWhatsAppListChangeInTransaction?: (
    tx: EventDatabase['database'],
    input: Readonly<{
      accountId: string;
      newlyHiddenMessageIds: readonly string[];
      visibilityVersion: number;
      changedAt: string;
    }>,
  ) => void;
}

function parseRawKey(value: string): RawKey | null {
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== 'wa-msg' ||
      !parsed.slice(1).every((part) => typeof part === 'string' && part.length > 0) ||
      canonicalJson(parsed) !== value
    )
      return null;
    return { chatJid: parsed[1] as string, senderJidRaw: parsed[2] as string, stanzaId: parsed[3] as string };
  } catch {
    return null;
  }
}

function hidden(visibility: CurrentWhatsAppEventVisibility, messageId: string): boolean {
  const key = parseRawKey(messageId);
  return (
    key === null ||
    !visibility.seesMessage(
      key.chatJid,
      // The channel's own vocabulary, as intake classifies the raw tuple: a raw JID keeps its case and padding.
      chatKindOf(key.chatJid),
      key.senderJidRaw,
      false,
    )
  );
}

/**
 * The daemon-owned half of D9's recoverable list journal.  The channel holds the list-file lock, and this class
 * applies that file's digest and all D-owned purges in one SQLite transaction before a source or disclosure proceeds.
 */
export class WhatsAppVisibilityFence {
  readonly #store: EventDatabase;
  readonly #withCurrent: WithCurrentWhatsAppEventVisibility;
  readonly #hooks: ListChangeHooks;
  readonly #now: () => number;

  constructor(options: {
    readonly store: EventDatabase;
    readonly withCurrentEventVisibility: WithCurrentWhatsAppEventVisibility;
    readonly retainedContentHooks?: ListChangeHooks | undefined;
    readonly now?: (() => number) | undefined;
  }) {
    this.#store = options.store;
    this.#withCurrent = options.withCurrentEventVisibility;
    this.#hooks = options.retainedContentHooks ?? {};
    this.#now = options.now ?? Date.now;
  }

  /** Runs `work` only after the durable journal has caught up with the live file under its lock. */
  async withCurrentVisibility<T>(
    input: Readonly<{ accountId: string }>,
    work: (visibility: CurrentWhatsAppEventVisibility) => Promise<T> | T,
  ): Promise<T> {
    return this.#withCurrent(input, async (visibility) => {
      this.applyCurrentVisibility(input.accountId, visibility);
      return work(visibility);
    });
  }

  /**
   * Applies current visibility under the held list lock, then makes one fresh asynchronous authority read before the
   * synchronous final gate/write.  The callback is intentionally synchronous: there is no await after `recheck`.
   */
  async withCurrentVisibleWrite<T>(
    input: Readonly<{ accountId: string; whatsappMessageId: string }>,
    recheck: WhatsAppVisibilityRecheck,
    write: () => T,
  ): Promise<T | undefined> {
    return this.withCurrentVisibility({ accountId: input.accountId }, async (visibility) => {
      if (hidden(visibility, input.whatsappMessageId)) return undefined;
      await recheck();
      return write();
    });
  }

  /** The sealed-frame gate has no await after the final list check and invokes a hidden frame writer never. */
  async withCurrentSseFrameVisibility<T>(
    input: Readonly<{ accountId: string; whatsappMessageId: string }>,
    recheck: WhatsAppVisibilityRecheck,
    writeFrame: () => T,
  ): Promise<T | undefined> {
    return this.withCurrentVisibleWrite(input, recheck, writeFrame);
  }

  /** A dry-run append or show has one synchronous final visibility callback under the live list lock. */
  async withCurrentDryRunVisibility<T>(
    input: Readonly<{ accountId: string; whatsappMessageId: string }>,
    recheck: WhatsAppVisibilityRecheck,
    commit: () => T,
  ): Promise<T | undefined> {
    return this.withCurrentVisibleWrite(input, recheck, commit);
  }

  /** Visible raw tuples alone may enter the candidate/head transaction. */
  async withCurrentCandidateVisibility<T>(
    input: Readonly<{ accountId: string; whatsappMessageId: string }>,
    commit: (visibility: CurrentWhatsAppEventVisibility) => T,
  ): Promise<T | undefined> {
    return this.withCurrentVisibility({ accountId: input.accountId }, (visibility) => {
      if (hidden(visibility, input.whatsappMessageId)) return undefined;
      return commit(visibility);
    });
  }

  private applyCurrentVisibility(accountId: string, visibility: CurrentWhatsAppEventVisibility): void {
    if (!/^[0-9a-f]{64}$/u.test(visibility.digest))
      throw new CommsError('BAD_DATA', 'the WhatsApp list visibility digest is not a lowercase SHA-256 value');
    this.#store.immediate(() => {
      const current = this.#store.database
        .prepare('SELECT version, lists_digest FROM whatsapp_visibility WHERE account_id = ?')
        .get(accountId) as { version: number; lists_digest: string } | undefined;
      if (current?.lists_digest === visibility.digest) return;
      const version = (current?.version ?? 0) + 1;
      const at = this.#now();
      const changedAt = new Date(at).toISOString();
      const rows = this.#store.database
        .prepare(
          `SELECT message_id, staged_payload_ref
             FROM whatsapp_occurrences
            WHERE account_id = ?
            ORDER BY message_id`,
        )
        .all(accountId) as Array<{ message_id: string; staged_payload_ref: string | null }>;
      const hiddenRows = rows.filter((row) => hidden(visibility, row.message_id));
      const newlyHidden = hiddenRows.map((row) => row.message_id);
      // D9's raw snapshot is authoritative independently of the occurrence ledger: a key that no version owed
      // still has to disappear when a list narrowing hides it. Scan every retained generation defensively; ordinary
      // head switching keeps this set to the single current generation.
      const hiddenSnapshotKeys = (
        this.#store.database
          .prepare(
            `SELECT chat_jid, sender_jid_raw, stanza_id
               FROM whatsapp_snapshot_keys
              WHERE account_id = ?`,
          )
          .all(accountId) as Array<{ chat_jid: string; sender_jid_raw: string; stanza_id: string }>
      )
        .map((key) => ({ chatJid: key.chat_jid, senderJidRaw: key.sender_jid_raw, stanzaId: key.stanza_id }))
        .filter((key) => hidden(visibility, canonicalJson(['wa-msg', key.chatJid, key.senderJidRaw, key.stanzaId])));
      if (current === undefined) {
        this.#store.database
          .prepare(
            'INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, ?, ?, ?)',
          )
          .run(accountId, version, visibility.digest, at);
      } else {
        this.#store.database
          .prepare('UPDATE whatsapp_visibility SET version = ?, lists_digest = ?, changed_at = ? WHERE account_id = ?')
          .run(version, visibility.digest, at, accountId);
      }
      // Snapshot keys retain their tuple columns, so the canonical id is compared by tuple rather than an index id.
      for (const key of hiddenSnapshotKeys) {
        this.#store.database
          .prepare(
            `DELETE FROM whatsapp_snapshot_keys
              WHERE account_id = ? AND chat_jid = ? AND sender_jid_raw = ? AND stanza_id = ?`,
          )
          .run(accountId, key.chatJid, key.senderJidRaw, key.stanzaId);
      }
      if (newlyHidden.length === 0) return;
      const marks = newlyHidden.map(() => '?').join(', ');
      for (const messageId of newlyHidden) purgeWhatsAppStagedPayload(this.#store.database, { accountId, messageId });
      this.#store.database
        .prepare(
          `UPDATE whatsapp_occurrences
              SET event_id = NULL
            WHERE account_id = ? AND message_id IN (${marks})`,
        )
        .run(accountId, ...newlyHidden);
      this.#store.database
        .prepare(
          `UPDATE whatsapp_rule_admissions
              SET admission = 'suppressed', admitted_at = ?
            WHERE account_id = ? AND message_id IN (${marks}) AND admission = 'admitted'`,
        )
        .run(at, accountId, ...newlyHidden);
      this.#store.database
        // The raw tuple identity carries no account: two linked accounts can share it, so scope by the ingest's account.
        .prepare(
          `DELETE FROM ingest_rules
            WHERE whatsapp_message_id IN (${marks})
              AND event_id IN (SELECT event_id FROM ingest WHERE account_id = ?)`,
        )
        .run(...newlyHidden, accountId);
      this.#store.database
        .prepare(`DELETE FROM dryrun_log WHERE account_id = ? AND whatsapp_message_id IN (${marks})`)
        .run(accountId, ...newlyHidden);
      this.#store.database
        .prepare(
          `UPDATE deliveries
              SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL
            WHERE account_id = ? AND whatsapp_message_id IN (${marks})
              AND state IN ('queued', 'retryable', 'disclosing')`,
        )
        .run(accountId, ...newlyHidden);
      this.#store.database
        .prepare(
          `UPDATE decisions
              SET outcome = 'cancelled', encrypted_record = NULL, hold_expires_at = NULL, hold_bound_by = NULL
            WHERE account_id = ? AND whatsapp_message_id IN (${marks})`,
        )
        .run(accountId, ...newlyHidden);
      // Admissions are identity/authority rows. Keeping them prevents a later widening from backfilling hidden content.
      this.#hooks.dispatchWhatsAppListChangeInTransaction?.(this.#store.database, {
        accountId,
        newlyHiddenMessageIds: newlyHidden,
        visibilityVersion: version,
        changedAt,
      });
    });
  }
}
