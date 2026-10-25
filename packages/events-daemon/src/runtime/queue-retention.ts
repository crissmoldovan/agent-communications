import type { DatabaseSync } from 'node:sqlite';

/**
 * The action queue's purge and retention participants (action queue design §4.3, Q2, Q6). Each runs inside the
 * caller's already-open transaction — the same one that purges the matching dry-run rows — and never opens its own.
 */

/** A revocation of exact rule versions removes their items, content and row, as it removes their dry-run rows (D7). */
export function purgeQueueItemsForRuleVersions(
  transaction: DatabaseSync,
  input: Readonly<{ ruleId: string; ruleVersions: readonly number[] }>,
): void {
  const remove = transaction.prepare('DELETE FROM queue_items WHERE rule_id = ? AND rule_version = ?');
  for (const version of input.ruleVersions) remove.run(input.ruleId, version);
}

/** `disable-all` removes every item, as it removes every dry-run row (D12). */
export function purgeAllQueueItems(transaction: DatabaseSync): void {
  transaction.exec('DELETE FROM queue_items');
}

/** An account removal removes that account's items on that source (D9). */
export function purgeQueueItemsForAccount(
  transaction: DatabaseSync,
  input: Readonly<{ source: string; accountId: string }>,
): void {
  transaction
    .prepare('DELETE FROM queue_items WHERE account_id = ? AND channel = ?')
    .run(input.accountId, input.source);
}

/** A WhatsApp chat or sender the person's lists newly hide takes its items with it (D9's visibility seam). */
export function purgeQueueItemsForWhatsAppMessages(
  transaction: DatabaseSync,
  input: Readonly<{ accountId: string; whatsappMessageIds: readonly string[] }>,
): void {
  const messageIds = [...new Set(input.whatsappMessageIds)];
  if (messageIds.length === 0) return;
  transaction
    .prepare(
      `DELETE FROM queue_items WHERE account_id = ? AND whatsapp_message_id IN (${messageIds.map(() => '?').join(', ')})`,
    )
    .run(input.accountId, ...messageIds);
}

/**
 * Expiry, by database time: an item's content goes at its deadline whatever its state, and its content-free row one
 * retention later. Neither deadline is ever extended.
 */
export function expireQueueItems(
  transaction: DatabaseSync,
  now: number,
): { readonly content: number; readonly rows: number } {
  const content = Number(
    transaction
      .prepare('UPDATE queue_items SET encrypted_record = NULL WHERE encrypted_record IS NOT NULL AND expires_at <= ?')
      .run(now).changes,
  );
  const rows = Number(transaction.prepare('DELETE FROM queue_items WHERE row_expires_at <= ?').run(now).changes);
  return { content, rows };
}

/**
 * A shortened `queueMs` (Q2) shortens, and never lengthens, every retained item of the rule's versions: the effective
 * retention becomes the lesser of the old one and the new `queueMs`, from the item's own append. An item already past
 * its new content deadline loses its content in the same transaction; one past its new row deadline goes.
 */
export function shortenQueueItemDeadlines(
  transaction: DatabaseSync,
  input: Readonly<{ ruleId: string; queueMs: number; now: number }>,
): void {
  const rows = transaction
    .prepare('SELECT id, appended_at, retention_ms, expires_at, row_expires_at FROM queue_items WHERE rule_id = ?')
    .all(input.ruleId) as Array<{
    id: string;
    appended_at: number;
    retention_ms: number;
    expires_at: number;
    row_expires_at: number;
  }>;
  for (const row of rows) {
    const retentionMs = Math.min(row.retention_ms, input.queueMs);
    const expiresAt = Math.min(row.expires_at, row.appended_at + retentionMs);
    const rowExpiresAt = Math.min(row.row_expires_at, expiresAt + retentionMs);
    if (rowExpiresAt <= input.now) {
      transaction.prepare('DELETE FROM queue_items WHERE id = ?').run(row.id);
      continue;
    }
    transaction
      .prepare(
        `UPDATE queue_items
            SET retention_ms = ?, expires_at = ?, row_expires_at = ?,
                encrypted_record = CASE WHEN ? <= ? THEN NULL ELSE encrypted_record END
          WHERE id = ?`,
      )
      .run(retentionMs, expiresAt, rowExpiresAt, expiresAt, input.now, row.id);
  }
}

/** Content-free: how many open items exact rule versions hold — what a tightening that revokes them will remove (Q6). */
export function openQueueItemCount(
  database: DatabaseSync,
  input: Readonly<{ ruleId: string; ruleVersions: readonly number[] }>,
): number {
  let open = 0;
  const count = database.prepare(
    "SELECT COUNT(*) AS count FROM queue_items WHERE rule_id = ? AND rule_version = ? AND state = 'open'",
  );
  for (const version of input.ruleVersions) open += (count.get(input.ruleId, version) as { count: number }).count;
  return open;
}
