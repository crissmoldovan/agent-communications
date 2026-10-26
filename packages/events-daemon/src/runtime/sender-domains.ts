import type { DatabaseSync } from 'node:sqlite';
import type { EncryptedRecordLocation } from '../store/records.ts';

/**
 * A judged decision's sending domain, kept for Analyse's per-domain counts (0.33.0 design §3.3) on its own and
 * encrypted, until its projection's deadline: the rule's content (ingest) retention, never the 90 days of the
 * decision's metadata (security review of 0.33.0, finding 9). The expiry sweep deletes it at that deadline, a retention
 * tightening shortens it, and it goes at once with the decision's metadata, by the table's trigger, or the decision.
 */

/** Where a decision's sending domain is sealed: its own table and column, bound to the decision's id. */
export function senderDomainLocation(decisionId: string): EncryptedRecordLocation {
  return { table: 'decision_sender_domains', column: 'encryptedDomain', key: [{ type: 'text', value: decisionId }] };
}

/**
 * Keeps a committed decision's sealed domain until `expiresAt`, which the expiry sweep holds it to. A decision that was
 * not written, or whose record is already cleared, keeps nothing; this never fails the decision it follows.
 */
export function keepSenderDomain(
  database: DatabaseSync,
  input: {
    readonly decisionId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly expiresAt: number;
    readonly sealed: Uint8Array;
  },
): void {
  try {
    database
      .prepare(
        `INSERT OR IGNORE INTO decision_sender_domains (decision_id, rule_id, rule_version, expires_at, encrypted_domain)
         SELECT ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM decisions WHERE id = ? AND encrypted_record IS NOT NULL)`,
      )
      .run(input.decisionId, input.ruleId, input.ruleVersion, input.expiresAt, input.sealed, input.decisionId);
  } catch {
    // The domain only feeds Analyse's counts: a decision stands without it.
  }
}
