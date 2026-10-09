import type { DatabaseSync } from 'node:sqlite';

/**
 * Removes the encrypted first representation that a WhatsApp occurrence owns.  The caller already owns the
 * transaction that makes the occurrence terminal or hidden, so a crash cannot leave a cleared pointer to retained
 * ciphertext (or its rule debts).
 */
export function purgeWhatsAppStagedPayload(
  database: DatabaseSync,
  input: Readonly<{ accountId: string; messageId: string }>,
): void {
  const occurrence = database
    .prepare(
      `SELECT staged_payload_ref
       FROM whatsapp_occurrences
       WHERE account_id = ? AND message_id = ?`,
    )
    .get(input.accountId, input.messageId) as { staged_payload_ref: string | null } | undefined;
  const stageId = occurrence?.staged_payload_ref;
  if (stageId !== null && stageId !== undefined) {
    // Be explicit even though the stage's foreign-key cascade also covers this path: the invariant is that no debt
    // can outlive the ciphertext it describes.
    database.prepare('DELETE FROM source_stage_rule_debts WHERE stage_id = ?').run(stageId);
    database.prepare('DELETE FROM source_scan_state WHERE id = ?').run(stageId);
  }
  database
    .prepare(
      `UPDATE whatsapp_occurrences
       SET staged_payload_ref = NULL, stage_expires_at = NULL
       WHERE account_id = ? AND message_id = ?`,
    )
    .run(input.accountId, input.messageId);
}
