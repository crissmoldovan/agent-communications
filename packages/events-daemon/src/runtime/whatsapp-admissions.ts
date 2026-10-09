import type { DatabaseSync } from 'node:sqlite';

/** A frozen owed rule-version set for one raw WhatsApp first representation. */
export interface WhatsAppRuleAdmissionDebt {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly activationId: string;
}

/**
 * Records the exact versions that observed a raw tuple.  This belongs in the candidate/head transaction so a later
 * activation cannot treat a snapshot-deduped historical tuple as a newly admitted message.
 */
export function insertWhatsAppRuleAdmissions(
  database: DatabaseSync,
  input: Readonly<{
    accountId: string;
    messageId: string;
    debts: readonly WhatsAppRuleAdmissionDebt[];
    visibilityVersion: number;
    admittedAt: number;
  }>,
): void {
  for (const debt of input.debts) {
    database
      .prepare(
        `INSERT OR IGNORE INTO whatsapp_rule_admissions
          (account_id, message_id, rule_id, rule_version, admission, activation_id, visibility_version, admitted_at)
         VALUES (?, ?, ?, ?, 'admitted', ?, ?, ?)`,
      )
      .run(
        input.accountId,
        input.messageId,
        debt.ruleId,
        debt.ruleVersion,
        debt.activationId,
        input.visibilityVersion,
        input.admittedAt,
      );
  }
}
