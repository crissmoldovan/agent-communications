import { CommsError, canonicalJson } from '@agentcomms/core';
import type { EventDatabase } from '../store/database.ts';

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
      key.chatJid === 'status@broadcast' || key.chatJid.endsWith('@status') ? 'status' : 'direct',
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

  /** The sealed-frame gate has no await after the final list check and invokes a hidden frame writer never. */
  async withCurrentSseFrameVisibility<T>(
    input: Readonly<{ accountId: string; whatsappMessageId: string }>,
    writeFrame: () => T,
  ): Promise<T | undefined> {
    return this.withCurrentVisibility({ accountId: input.accountId }, (visibility) => {
      if (hidden(visibility, input.whatsappMessageId)) return undefined;
      return writeFrame();
    });
  }

  /** A dry-run append or show has one synchronous final visibility callback under the live list lock. */
  async withCurrentDryRunVisibility<T>(
    input: Readonly<{ accountId: string; whatsappMessageId: string }>,
    commit: () => T,
  ): Promise<T | undefined> {
    return this.withCurrentVisibility({ accountId: input.accountId }, (visibility) => {
      if (hidden(visibility, input.whatsappMessageId)) return undefined;
      return commit();
    });
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
      if (newlyHidden.length === 0) return;
      const marks = newlyHidden.map(() => '?').join(', ');
      const stageIds = hiddenRows.flatMap((row) => (row.staged_payload_ref === null ? [] : [row.staged_payload_ref]));
      // Snapshot keys retain their tuple columns, so the canonical id is compared by tuple rather than an index id.
      for (const messageId of newlyHidden) {
        const key = parseRawKey(messageId);
        if (key === null) continue;
        this.#store.database
          .prepare(
            `DELETE FROM whatsapp_snapshot_keys
              WHERE account_id = ? AND chat_jid = ? AND sender_jid_raw = ? AND stanza_id = ?`,
          )
          .run(accountId, key.chatJid, key.senderJidRaw, key.stanzaId);
      }
      this.#store.database
        .prepare(
          `UPDATE whatsapp_occurrences
              SET staged_payload_ref = NULL, stage_expires_at = NULL, event_id = NULL
            WHERE account_id = ? AND message_id IN (${marks})`,
        )
        .run(accountId, ...newlyHidden);
      if (stageIds.length > 0) {
        const stageMarks = stageIds.map(() => '?').join(', ');
        this.#store.database.prepare(`DELETE FROM source_scan_state WHERE id IN (${stageMarks})`).run(...stageIds);
      }
      this.#store.database
        .prepare(
          `UPDATE whatsapp_rule_admissions
              SET admission = 'suppressed', admitted_at = ?
            WHERE account_id = ? AND message_id IN (${marks}) AND admission = 'admitted'`,
        )
        .run(at, accountId, ...newlyHidden);
      this.#store.database
        .prepare(`DELETE FROM ingest_rules WHERE whatsapp_message_id IN (${marks})`)
        .run(...newlyHidden);
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
