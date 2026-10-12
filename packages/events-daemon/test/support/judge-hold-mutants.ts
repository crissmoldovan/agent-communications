import { expectJudgeMutationToFail, type JudgeMutation } from './judge-mutants.ts';

export const JUDGE_HOLD_MUTATIONS: readonly JudgeMutation[] = [
  {
    id: 'e8-sqlite-hold-clock',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before: '"SELECT CAST((julianday(\'now\') - 2440587.5) * 86400000 AS INTEGER) AS now"',
    after: "'SELECT 0 AS now'",
    test: 'packages/events-daemon/test/judge-holds.test.ts',
    testName: 'E8: a hold uses the SQLite transaction clock and retention wins its deadline tie',
  },
  {
    id: 'e8-ingest-tie',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before: 'ingestRetention <= holdWindow',
    after: 'ingestRetention < holdWindow',
    test: 'packages/events-daemon/test/judge-holds.test.ts',
    testName: 'E8: a hold uses the SQLite transaction clock and retention wins its deadline tie',
  },
  {
    id: 'e8-lease-recovery',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before:
      "return Number(database.prepare('DELETE FROM hold_resolution_claims WHERE lease_expires_at <= ?').run(now).changes);",
    after: 'return 0;',
    test: 'packages/events-daemon/test/judge-holds.test.ts',
    testName: 'E8: a DB-time claim is decision-bound, expires for recovery, and cannot claim at the hold deadline',
  },
  {
    id: 'e8-expiry-before-control',
    source: 'packages/events-daemon/src/runtime/expiry.ts',
    before: 'expireHeldDecisionsInTransaction(database);',
    after: 'void database;',
    test: 'packages/events-daemon/test/judge-hold-retention.test.ts',
    testName: 'E8: expiry uses SQLite time before control despite process-clock rollback and cannot leave a late hold',
  },
  {
    id: 'e8-decision-bound-token',
    source: 'packages/events-daemon/src/runtime/decisions.ts',
    before: 'AND claim.claim_token = ? AND claim.lease_expires_at > ?',
    after: 'AND 1 = 1 AND claim.lease_expires_at > ?',
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E8: final hold resolution refuses a mismatched decision-bound claim token before any delivery write',
  },
  {
    id: 'e8-final-resolution-recheck',
    source: 'packages/events-daemon/src/runtime/decisions.ts',
    before: 'if (!heldResolutionSwitchIsLive)',
    after: 'if (false && !heldResolutionSwitchIsLive)',
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E8: resolution rechecks its authority after decrypt and refuses a disabled hold without a delivery',
  },
  {
    id: 'e8-account-purge-claim',
    source: 'packages/events-daemon/src/runtime/judge-purge.ts',
    before: "purgeHeldDecisionsInTransaction(this.#database, { scope: 'source-account', ...input });",
    after: "if (false) purgeHeldDecisionsInTransaction(this.#database, { scope: 'source-account', ...input });",
    test: 'packages/events-daemon/test/judge-hold-retention.test.ts',
    testName: 'E8: tightening recomputes creation-bound hold limits and purge removes the held claim',
  },
  {
    id: 'e8-evaluator-db-clock',
    source: 'packages/events-daemon/src/runtime/evaluate.ts',
    before: 'const expiryNow = rule.agentic === undefined ? this.#now() : dbNow;',
    after: 'const expiryNow = this.#now();',
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E8 P1: a fast evaluator clock cannot expire a hold before its SQLite ingest deadline',
  },
  {
    id: 'e8-hold-write-expiry',
    source: 'packages/events-daemon/src/runtime/decisions.ts',
    before: "if (deadline.holdExpiresAt <= holdCreatedAt) outcome = 'retention-expired';",
    after: "if (false) outcome = 'retention-expired';",
    test: 'packages/events-daemon/test/judge-holds.test.ts',
    testName:
      'E8 P1: the final hold writer terminalises from its SQLite transaction time when ingest has already ended',
  },
  {
    id: 'e8-held-whatsapp-live-fence',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before: 'const resolved = await this.#whatsappVisibilityFence.withCurrentVisibleRead(',
    after:
      "const resolved = await (async (_input, read) => read({ version: 1, journalVersion: 1, digest: 'a'.repeat(64), seesMessage: () => true } as FencedWhatsAppEventVisibility))(",
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E8 P1: held WhatsApp resolution applies the shared live-list fence before it reads retained content',
  },
  {
    id: 'e8-held-whatsapp-journal-version',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before: 'whatsappVisibilityVersion: whatsappVisibility.journalVersion',
    after: 'whatsappVisibilityVersion: whatsappVisibility.version',
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E8 P2: held WhatsApp resolution commits against the journal head after a visible list change',
  },
  {
    id: 'e8-legacy-hold-ingest-cap',
    source: 'packages/events-daemon/src/runtime/replacements.ts',
    before: 'const deadline = Math.min(held.hold_expires_at, holdWindow, ingestCap);',
    after: 'const deadline = Math.min(held.hold_expires_at, holdWindow);',
    test: 'packages/events-daemon/test/tightening.test.ts',
    testName: 'APR-B1: a retention tightening moves every persisted B1 deadline only earlier',
  },
  {
    id: 'e8-legacy-hold-repeated-tightening',
    source: 'packages/events-daemon/src/runtime/replacements.ts',
    before: 'AND decision.hold_created_at IS NULL',
    after: 'AND decision.hold_created_at IS NULL\n          AND decision.hold_bound_by IS NULL',
    test: 'packages/events-daemon/test/retention-tightening-phase-d.test.ts',
    testName: 'D4a: every retention tightening recomputes a live legacy hold from its current deadline',
  },
  {
    id: 'e8-held-final-live-account-fence',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before:
      '// synchronous final decision transaction, so a removed account cannot gain a delivery between those awaits.\n    await this.#accountLive({ source: after.rule.source.channel, accountId: after.accountId });',
    after:
      '// synchronous final decision transaction, so a removed account cannot gain a delivery between those awaits.\n    if (false) await this.#accountLive({ source: after.rule.source.channel, accountId: after.accountId });',
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName:
      'E8 P1: held resolution rechecks the live account after delivery encryption and taint before its final write',
  },
];

export function expectJudgeHoldMutationToFail(mutation: JudgeMutation): Promise<void> {
  return expectJudgeMutationToFail(mutation);
}
