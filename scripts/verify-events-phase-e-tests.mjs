#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import { JUDGE_KINDS } from '../packages/events-daemon/src/domain/lifecycle.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'packages/events-daemon/test/fixtures/judges/case-manifest.json';
const GATE_SCRIPTS = ['scripts/verify-events-phase-e-prerequisites.mjs', 'scripts/verify-events-phase-e-tests.mjs'];

/**
 * These are the only strict runners which own Phase-E mutation declarations. A manifest cannot merely name a
 * runner: the verifier below also proves that its mutation id is in that runner's iterated collection.
 */
const STRICT_RUNNERS = Object.freeze({
  'judge-kind-mutants': {
    test: 'packages/events-daemon/test/judge-kind-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-kind-mutants.ts',
    collection: 'JUDGE_KIND_MUTATIONS',
    helper: 'expectJudgeKindMutationToFail',
  },
  'judge-budget-mutants': {
    test: 'packages/events-daemon/test/judge-budget-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-budget-mutants.ts',
    collection: 'JUDGE_BUDGET_MUTATIONS',
    helper: 'expectJudgeBudgetMutationToFail',
  },
  'judge-task5-mutants': {
    test: 'packages/events-daemon/test/judge-task5-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-task5-mutants.ts',
    collection: 'JUDGE_TASK5_MUTATIONS',
    helper: 'expectJudgeTask5MutationToFail',
  },
  'judge-task4-mutants': {
    test: 'packages/events-daemon/test/judge-task4-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-task4-mutants.ts',
    collection: 'JUDGE_TASK4_MUTATIONS',
    helper: 'expectJudgeTask4MutationToFail',
  },
  'judge-mutants': {
    test: 'packages/events-daemon/test/judge-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-mutants.ts',
    collection: 'PHASE_E_GATE_MUTATIONS',
    helper: 'expectJudgeMutationToFail',
  },
  'judge-transport-mutants': {
    test: 'packages/events-daemon/test/judge-transport.test.ts',
    support: 'packages/events-daemon/test/support/judge-transport-mutants.ts',
    collection: 'JUDGE_TRANSPORT_MUTATION_IDS',
    loopCollection: 'JUDGE_TRANSPORT_MUTATIONS',
    helper: 'expectTransportMutationToFail',
  },
  'judge-hold-mutants': {
    test: 'packages/events-daemon/test/judge-hold-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-hold-mutants.ts',
    collection: 'JUDGE_HOLD_MUTATIONS',
    helper: 'expectJudgeHoldMutationToFail',
  },
  'judge-adversarial-mutants': {
    test: 'packages/events-daemon/test/judge-adversarial-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-adversarial-mutants.ts',
    collection: 'JUDGE_ADVERSARIAL_MUTATIONS',
    helper: 'expectJudgeAdversarialMutationToFail',
  },
  'judge-final-mutants': {
    test: 'packages/events-daemon/test/judge-final-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-final-mutants.ts',
    collection: 'JUDGE_FINAL_MUTATIONS',
    helper: 'expectJudgeFinalMutationToFail',
  },
});

const COPIED_TREE_BASELINE_RUNNERS = new Set([
  'judge-kind-mutants',
  'judge-budget-mutants',
  'judge-task5-mutants',
  'judge-task4-mutants',
  'judge-mutants',
  'judge-transport-mutants',
  'judge-adversarial-mutants',
]);

/** E owns these rows rather than allowing a mutable manifest to define which completed-task guards matter. */
const REQUIRED_GUARD_ROWS = Object.freeze([
  'task-1-canonical-documents',
  'task-2-durable-schema',
  'phase-e-b3-prerequisite-gate',
  'phase-e-b3-secret-origin',
  'phase-e-b3-pending-target-origin',
  'phase-e-source-scope',
  'phase-e-synthetic-scope',
  'e1-prepare-disabled-kind',
  'e1-claim-before-core-disabled-kind',
  'e1-local-claim-transaction-disabled-kind',
  'e1-finalise-transaction-disabled-kind',
  'e5-rolling-includes-reserved',
  'e5-rolling-includes-in-flight',
  'e5-concurrency-excludes-settled',
  'e5-stable-rule-key',
  'e5-input-max-before-io',
  'e5-byte-estimate',
  'e5-no-active-singleton',
  'e5-unparsed-outcome-never-refunds',
  'e5-omitted-result-never-defaults-completed',
  'e5-terminal-decision-is-no-match',
  'e5-terminal-projection-purge',
  'e5-single-transport-entry',
  'e5-concurrency-release',
  'e5-double-settle',
  'e5-owner-start-recovery',
  'e5-v1-literal-judge-kinds',
  'e5-released-retry-new-attempt',
  'e5-released-terminal-transition',
  'e5-inflight-never-releases',
  'e5-inflight-at-physical-io',
  'e6-reference-date',
  'e6-header-allowlist',
  'e6-single-line-hosted-key',
  'e6-request-cap',
  'e6-response-cap',
  'e6-streaming-response-cap',
  'e6-output-token-limit',
  'e6-provider-match',
  'e6-score-clamp',
  'e6-closed-score-pointer',
  'e6-dns-final-gate',
  'e6-tcp-final-gate',
  'e6-tls-final-gate',
  'e6-write-final-gate',
  'e6-write-gate-adjacency',
  'e6-no-http-client',
  'e6-no-proxy-path',
  'e6-no-redirect',
  'e6-literal-loopback-only',
  'e6-attempt-deadline',
  'e6-post-gate-deadline',
  'e6-final-gate-deadline',
  'e6-synchronous-final-gate',
  'e6-response-deadline',
  'e6-fatal-utf8',
  'e6-a-accept-non-global',
  'e6-a-skip-embedded-addresses',
  'e6-a-allow-global-only-non-typesafe',
  'e6-m-accept-alias',
  'e6-m-substitute-constant-model',
  'e4-no-pointer-at-prepare',
  'e4-final-pointer-drift',
  'e4-claim-pointer-drift',
  'e4-disabled-judge-add',
  'e4-kind-disable-recovery',
  'e4-laya-before-intent',
  'e4-budget-digest-prepare',
  'e4-kind-digest-prepare',
  'e4-budget-digest-claim',
  'e4-kind-digest-claim',
  'e4-budget-digest-finalise',
  'e4-kind-digest-finalise',
  'e4-budget-digest-live-reservation',
  'e4-kind-digest-live-reservation',
  'e4-first-enablement-disable',
  'e4-absent-kind-disable-generation',
  'e4-expiry-rule-version',
  'e4-tightening-rule-version',
  'e4-unscoped-kind-static-guard',
  'e4-primary-key-exemption',
  'e4-required-guard-rows',
  'e7-deterministic-first',
  'e7-taint-before-reserve',
  'e7-exact-input-provenance',
  'e7-settlement-token',
  'e7-pause-fence',
  'e7-full-request-estimate',
  'e7-single-decision-owner',
  'e7-deterministic-shared-route',
  'e7-evaluator-writer-lease',
  'e8-sqlite-hold-clock',
  'e8-ingest-tie',
  'e8-lease-recovery',
  'e8-expiry-before-control',
  'e8-decision-bound-token',
  'e8-final-resolution-recheck',
  'e8-account-purge-claim',
  'e8-evaluator-db-clock',
  'e8-hold-write-expiry',
  'e8-held-whatsapp-live-fence',
  'e8-held-whatsapp-journal-version',
  'e8-legacy-hold-ingest-cap',
  'e8-legacy-hold-repeated-tightening',
  'e8-held-final-live-account-fence',
  'e9-fixed-synthetic-judge-input',
  'e9-judge-key-rotate-current-generation',
  'e9-mcp-kind-enable-no-active-pointer',
  'e9-pending-rule-judge-origin',
  'e11-provider-match-authority',
  'e11-envelope-provenance',
  'e11-range-token-cap',
  'e11-wrong-type-score',
  'e11-host-drift-before-byte',
  'e11-journal-exactness',
  'e11-refusal-content-free',
  'e11-late-hold-response',
  'e11-corpus-integrity-allowlist',
  'e11-response-fixture-pinning',
  'e11-corpus-manifest-pairing',
  'e12-target-remove-purge',
  'e12-subscriber-remove-purge',
  'e12-judge-remove-purge',
  'e12-account-remove-readd-purge',
  'e12-whatsapp-hide-purge',
  'e12-rule-disable-purge',
  'e12-disable-all-purge',
  'e12-account-rule-revoke',
  'e12-derived-parent-revoke',
  'e12-account-source-purge',
  'e12-judge-key-generation-fence',
  'e12-judge-kind-literal-guard',
  'e12-audit-matrix',
  'e12-static-network-path',
  'e12-purge-caller-registry',
  'e12-corpus-dependency-closure',
  'e12-held-purge-race',
  'e12-hold-claim-expiry-call',
  'e12-hold-api-expiry-call',
  'e12-hold-resolution-expiry-call',
  'e13-required-release-gate',
  'e13-b3-capability-row',
  'e13-doctor-hold-clock',
  'e13-laya-typed-unavailable',
  'e13-kind-enablement-approval',
  'e-review-kind-disable-enable-all',
  'e-review-revoked-judge-activation',
  'e-review-prepare-bound-rule-authority',
  'e-review-prepare-plan-before-intent',
  'e-review-prepare-plan-after-disclosure',
]);

const auditRows = (category, rows) => rows.map(([id, owner]) => Object.freeze({ category, id, owner }));

/** Task 12's immutable audit inventory. Cases are the matrix rows; each owner already has one strict mutation. */
export const PHASE_E_AUDIT_MATRIX = Object.freeze([
  ...auditRows('await-write', [
    ['activation-approval-claim-to-pointer', 'e4-final-pointer-drift'],
    ['secret-store-to-key-completion', 'e9-judge-key-rotate-current-generation'],
    ['hosted-key-read-to-transport-gates', 'e12-judge-key-generation-fence'],
    ['decrypt-evaluate-to-reservation', 'e7-settlement-token'],
    ['taint-flush-to-reservation', 'e7-taint-before-reserve'],
    ['authority-read-to-in-flight', 'e5-inflight-at-physical-io'],
    ['dns-gate-to-lookup', 'e6-dns-final-gate'],
    ['tcp-gate-to-connect', 'e6-tcp-final-gate'],
    ['tls-gate-to-handshake', 'e6-tls-final-gate'],
    ['write-gate-to-request-byte', 'e6-write-final-gate'],
    ['response-parser-to-settlement', 'e7-pause-fence'],
    ['hold-decrypt-map-encrypt-to-resolution', 'e8-final-resolution-recheck'],
    ['recovery-config-load-to-cleanup', 'e5-owner-start-recovery'],
    ['purge-preparation-to-purge', 'e8-held-whatsapp-journal-version'],
    ['approval-view-to-synthetic-judge-call', 'e9-pending-rule-judge-origin'],
  ]),
  ...auditRows('external-identity', [
    ['source', 'e3-scope-account-source'],
    ['account-id', 'e3-scope-account-source'],
    ['event-id', 'e4-expiry-rule-version'],
    ['rule-id', 'e5-stable-rule-key'],
    ['rule-version', 'e4-tightening-rule-version'],
    ['judge-id', 'e9-fixed-synthetic-judge-input'],
    ['judge-version', 'e9-judge-key-rotate-current-generation'],
    ['budget-id', 'e4-budget-digest-live-reservation'],
    ['budget-version', 'e4-budget-digest-finalise'],
    ['provider-id', 'e5-stable-rule-key'],
    ['installation-key', 'e5-rolling-includes-reserved'],
    ['decision-id', 'e8-decision-bound-token'],
    ['reservation-id', 'e5-double-settle'],
    ['target-id', 'e12-target-remove-purge'],
    ['target-version', 'e12-target-remove-purge'],
    ['subscriber-id', 'e12-subscriber-remove-purge'],
    ['subscriber-version', 'e12-subscriber-remove-purge'],
    ['test-work-id', 'e3-scope-synthetic-work'],
    ['judge-kind', 'e4-kind-disable-recovery'],
    ['approval-id', 'e4-budget-digest-claim'],
    ['authorization-activation-id', 'e7-settlement-token'],
    ['switch-generation', 'e7-pause-fence'],
    ['visibility-version', 'e8-held-whatsapp-journal-version'],
    ['claim-token', 'e8-decision-bound-token'],
  ]),
  ...auditRows('alias', [
    ['account-remove-readd', 'e12-account-remove-readd-purge'],
    ['same-looking-cross-source-id', 'e12-account-source-purge'],
    ['stable-rule-id-across-version', 'e5-stable-rule-key'],
    ['unique-work-id', 'e5-double-settle'],
    ['provider-from-embedded-judge', 'e5-stable-rule-key'],
    ['active-pointer-to-immutable-version', 'e4-final-pointer-drift'],
    ['stable-row-id-after-alias-resolution', 'e8-decision-bound-token'],
  ]),
  ...auditRows('scope-variant', [
    ['work-source-owned', 'e3-scope-account-source'],
    ['work-synthetic-test', 'e3-scope-synthetic-work'],
    ['selector-all', 'e5-owner-start-recovery'],
    ['selector-judge-kind', 'e4-kind-disable-recovery'],
    ['selector-source-account', 'e12-account-remove-readd-purge'],
    ['selector-source-event', 'e12-whatsapp-hide-purge'],
    ['selector-source-event-rule', 'e4-expiry-rule-version'],
    ['selector-rule', 'e4-tightening-rule-version'],
    ['selector-synthetic-test', 'e9-fixed-synthetic-judge-input'],
  ]),
  ...auditRows('purge-caller', [
    ['kind-disable', 'e4-kind-disable-recovery'],
    ['judge-remove', 'e12-judge-remove-purge'],
    ['rule-disable-revoke', 'e12-rule-disable-purge'],
    ['target-remove', 'e12-target-remove-purge'],
    ['subscriber-remove', 'e12-subscriber-remove-purge'],
    ['disable-all', 'e12-disable-all-purge'],
    ['account-remove', 'e12-account-remove-readd-purge'],
    ['account-single-rule-revoke', 'e12-account-rule-revoke'],
    ['whatsapp-hide', 'e12-whatsapp-hide-purge'],
    ['projection-expiry', 'e4-expiry-rule-version'],
    ['ingest-expiry', 'e4-expiry-rule-version'],
    ['hold-expiry', 'e8-expiry-before-control'],
    ['hold-claim-expiry', 'e12-hold-claim-expiry-call'],
    ['hold-api-expiry', 'e12-hold-api-expiry-call'],
    ['hold-resolution-expiry', 'e12-hold-resolution-expiry-call'],
    ['expiry-held-sweep', 'e8-expiry-before-control'],
    ['retention-tightening', 'e4-tightening-rule-version'],
    ['tightening-held-sweep', 'e8-legacy-hold-repeated-tightening'],
    ['retained-projection-shortening', 'e4-tightening-rule-version'],
    ['derived-parent-revoke', 'e12-derived-parent-revoke'],
  ]),
  ...auditRows('section-5', [
    ['b3-hard-gate-and-unavailable-contract', 'e3-b3-prerequisite-gate'],
    ['judge-test-no-unapproved-network', 'e9-fixed-synthetic-judge-input'],
    ['durable-accounting-and-recovery', 'e5-unparsed-outcome-never-refunds'],
    ['sealed-vectors-and-answer-bounds', 'e6-header-allowlist'],
    ['one-terminal-decision', 'e7-single-decision-owner'],
    ['kinds-off-disable-and-late-result', 'e4-kind-disable-recovery'],
    ['activation-digest-and-wrong-kind-claims', 'e4-budget-digest-claim'],
    ['hold-retention-and-expiry', 'e8-expiry-before-control'],
    ['parity-and-human-only-surfaces', 'e9-pending-rule-judge-origin'],
  ]),
  ...auditRows('corpus-case', [
    ['provider-match-is-not-authority', 'e11-journal-exactness'],
    ['provider-match-low-score-refusal', 'e11-provider-match-authority'],
    ['exact-input-envelope-injection', 'e11-envelope-provenance'],
    ['exact-input-control-unicode', 'e11-envelope-provenance'],
    ['exact-input-provenance', 'e11-envelope-provenance'],
    ['truncated-json-refusal', 'e11-range-token-cap'],
    ['multiple-json-refusal', 'e11-range-token-cap'],
    ['nan-score-refusal', 'e11-range-token-cap'],
    ['infinite-score-refusal', 'e11-range-token-cap'],
    ['range-score-refusal', 'e11-range-token-cap'],
    ['wrong-type-score-refusal', 'e11-wrong-type-score'],
    ['provider-tool-refusal', 'e11-refusal-content-free'],
    ['hostile-reason-refusal', 'e11-refusal-content-free'],
    ['redirect-refusal', 'e11-journal-exactness'],
    ['oversize-response-refusal', 'e11-journal-exactness'],
    ['output-token-refusal', 'e11-range-token-cap'],
    ['input-token-refusal', 'e7-full-request-estimate'],
    ['request-cap-refusal', 'e7-full-request-estimate'],
    ['disabled-kind-refusal', 'e4-kind-disable-recovery'],
    ['kind-disable-race', 'e4-kind-disable-recovery'],
    ['rule-revocation-race', 'e7-pause-fence'],
    ['inactive-budget-refusal', 'e5-no-active-singleton'],
    ['budget-owner-race', 'e4-final-pointer-drift'],
    ['post-io-unknown', 'e5-unparsed-outcome-never-refunds'],
    ['response-to-hold', 'e8-decision-bound-token'],
    ['response-after-hold-expiry', 'e8-expiry-before-control'],
    ['late-response-after-expiry', 'e11-late-hold-response'],
    ['userinfo-endpoint-refusal', 'e6-no-redirect'],
    ['path-host-drift-refusal', 'e11-host-drift-before-byte'],
    ['host-drift-write-fence-refusal', 'e11-host-drift-before-byte'],
    ['dns-rebinding-refusal', 'e6-dns-final-gate'],
  ]),
]);

const PHASE_E_AUDIT_MATRIX_SHA256 = '9eea5ef6f645a1faf543263df80b10b0b5fa500b5ed48f54033e18a8a3d80e41';
const REQUIRED_CORPUS_ROWS = Object.freeze(
  PHASE_E_AUDIT_MATRIX.filter((row) => row.category === 'corpus-case').map((row) => row.id),
);

const REQUIRED_PURGE_CALLERS = Object.freeze([
  ['kind-disable', 'packages/events-daemon/src/runtime/judge-kinds.ts', ').kind(enabledKind);'],
  ['judge-remove', 'packages/events-daemon/src/runtime/b3-operator-control.ts', ').judge({'],
  [
    'rule-disable-revoke',
    'packages/events-daemon/src/runtime/revocations.ts',
    'purgeRevokedRuleWork(database.database, ruleId, live, revokedAt);',
  ],
  [
    'target-remove',
    'packages/events-daemon/src/runtime/revocations.ts',
    'purgeRevokedRuleWork(database.database, rule.rule_id, [rule.version], revokedAt);',
  ],
  [
    'subscriber-remove',
    'packages/events-daemon/src/runtime/b3-operator-control.ts',
    'purgeRevokedRuleWork(this.#store.database, rule.rule_id, [rule.version], now);',
  ],
  ['disable-all', 'packages/events-daemon/src/runtime/lifecycle.ts', ').all();'],
  ['account-remove', 'packages/events-daemon/src/runtime/account-fence.ts', ').account({ source, accountId });'],
  [
    'account-single-rule-revoke',
    'packages/events-daemon/src/runtime/account-fence.ts',
    'purgeRevokedRuleWork(database, version.rule_id, [version.version], now);',
  ],
  ['whatsapp-hide', 'packages/events-daemon/src/runtime/whatsapp-visibility.ts', 'judgePurge.event({'],
  ['projection-expiry', 'packages/events-daemon/src/runtime/expiry.ts', 'judgePurge.event({'],
  [
    'hold-claim-expiry',
    'packages/events-daemon/src/runtime/holds.ts',
    "expireHeldDecisionsInTransaction(database);\n      return { kind: 'expired' };",
  ],
  [
    'hold-api-expiry',
    'packages/events-daemon/src/runtime/holds.ts',
    'return store.immediate(() => expireHeldDecisionsInTransaction(store.database));',
  ],
  [
    'hold-resolution-expiry',
    'packages/events-daemon/src/runtime/decisions.ts',
    'expireHeldDecisionsInTransaction(database);\n      return true;',
  ],
  [
    'expiry-held-sweep',
    'packages/events-daemon/src/runtime/expiry.ts',
    'expireHeldDecisionsInTransaction(database);\n      const expiringJudgeWork',
  ],
  [
    'tightening-held-sweep',
    'packages/events-daemon/src/runtime/replacements.ts',
    'expireHeldDecisionsInTransaction(database);\n  const retainedVersions',
  ],
  ['retention-tightening', 'packages/events-daemon/src/runtime/replacements.ts', ').retainedProjection({'],
  [
    'derived-parent-revoke',
    'packages/events-daemon/src/runtime/replacements.ts',
    'purgeRevokedRuleWork(database, input.parent.ruleId, [input.parent.version], input.now);',
  ],
]);

async function source(root, file) {
  return readFile(join(root, file), 'utf8').catch(() => undefined);
}

async function tsFiles(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    // Rule exemptions name repository paths with `/` on every platform; `join` would give `\` on Windows.
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await tsFiles(root, file)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const text = await source(root, file);
      if (text !== undefined) files.push({ file, source: text });
    }
  }
  return files;
}

const EXPRESSION_END_TOKENS = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.TemplateTail,
]);
const CONTROL_PAREN_TOKENS = new Set([
  SyntaxKind.IfKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.WithKeyword,
  SyntaxKind.SwitchKeyword,
  SyntaxKind.CatchKeyword,
]);

function contextualTokens(text) {
  const scanner = createScanner(true, undefined, text);
  const templateBraceDepths = [];
  const controlParens = [];
  const tokens = [];
  let expressionMayStart = true;
  let previousToken;
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    const expressionCouldStartBeforeToken = expressionMayStart;
    if (expressionMayStart && (token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken))
      token = scanner.reScanSlashToken();
    if (token === SyntaxKind.TemplateHead) templateBraceDepths.push(0);
    else if (templateBraceDepths.length > 0 && token === SyntaxKind.OpenBraceToken)
      templateBraceDepths[templateBraceDepths.length - 1] += 1;
    else if (templateBraceDepths.length > 0 && token === SyntaxKind.CloseBraceToken) {
      const depth = templateBraceDepths.length - 1;
      if (templateBraceDepths[depth] > 0) templateBraceDepths[depth] -= 1;
      else if (scanner.reScanTemplateToken() === SyntaxKind.TemplateTail) templateBraceDepths.pop();
    }
    // A context-free scanner reports a zero-width private identifier for a bare `#` in a regular expression.
    // Rescanning it as an invalid identifier preserves progress without treating regex contents as strings.
    if (scanner.getTokenEnd() === scanner.getTokenStart()) scanner.reScanInvalidIdentifier();
    tokens.push({ kind: token, value: scanner.getTokenValue() });

    if (token === SyntaxKind.OpenParenToken) {
      controlParens.push(CONTROL_PAREN_TOKENS.has(previousToken));
      expressionMayStart = true;
    } else if (token === SyntaxKind.CloseParenToken) {
      expressionMayStart = controlParens.pop() === true;
    } else if (token === SyntaxKind.CloseBraceToken) {
      // A block can be followed by an expression statement. Treat the ambiguous object/block case as a regex so
      // quote characters inside that regex cannot corrupt every token that follows it.
      expressionMayStart = true;
    } else if (token === SyntaxKind.PlusPlusToken || token === SyntaxKind.MinusMinusToken) {
      expressionMayStart = expressionCouldStartBeforeToken;
    } else if (token === SyntaxKind.ExclamationToken && !expressionCouldStartBeforeToken) {
      expressionMayStart = false;
    } else {
      expressionMayStart = !EXPRESSION_END_TOKENS.has(token);
    }
    previousToken = token;
  }
  return tokens;
}

function hasJudgeKindLiteral(text) {
  const kinds = new Set(JUDGE_KINDS);
  if (
    contextualTokens(text).some(
      (token) =>
        (token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
        kinds.has(token.value),
    )
  )
    return true;
  // Fail closed if malformed surrounding syntax still confuses contextual tokenisation: scan from every possible
  // literal opener so one earlier token can never swallow a later canonical value.
  for (const match of text.matchAll(/['"`]/gu)) {
    const scanner = createScanner(true, undefined, text.slice(match.index));
    const token = scanner.scan();
    if (
      (token === SyntaxKind.StringLiteral || token === SyntaxKind.NoSubstitutionTemplateLiteral) &&
      kinds.has(scanner.getTokenValue())
    )
      return true;
  }
  return false;
}

function sqlStatements(text) {
  const strings = [];
  const literal = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/gu;
  for (const match of text.matchAll(literal)) {
    const value = match[2];
    if (!value || !/\b(?:SELECT|UPDATE|DELETE)\b/iu.test(value) || !/\bjudge_[a-z_]+\b/iu.test(value)) continue;
    for (const statement of value.split(';')) {
      if (/\b(?:SELECT\b[\s\S]*?\bFROM|UPDATE|DELETE\s+FROM)\s+judge_[a-z_]+\b/iu.test(statement))
        strings.push(statement);
    }
  }
  return strings;
}

function primaryKeyOnly(statement) {
  const match = /\bWHERE\s+([\s\S]*)$/iu.exec(statement);
  if (match === null) return false;
  const predicates = match[1]
    .trim()
    .split(/\s+AND\s+/iu)
    .map((predicate) => predicate.trim());
  if (predicates.length === 0 || /\bOR\b|\(|\)|\bSELECT\b/iu.test(match[1])) return false;
  const primaryKeyEquality = /^(?:[a-z_]+\.)?id\s*=\s*\?$/iu;
  const primaryKeyMentions = /(?:^|\s|\.)(?:[a-z_]+\.)?id\b/iu;
  const primaryKeyPredicates = predicates.filter((predicate) => primaryKeyEquality.test(predicate));
  return (
    primaryKeyPredicates.length === 1 &&
    predicates.every((predicate) => primaryKeyEquality.test(predicate) || !primaryKeyMentions.test(predicate))
  );
}

function hasJudgeWorkScopeLiteral(statement) {
  return /\bwork_scope\s*=\s*'(?:source-owned|synthetic-test)'/iu.test(statement);
}

/**
 * A reservation transition may address exactly one row by its primary key. Every broader judge-work selection must
 * disclose its closed source/account or synthetic-test scope in that SQL statement, before it can feed a mutation.
 */
function unscopedJudgeWorkSelection(statement) {
  if (!/\bjudge_budget_reservations\b/iu.test(statement) || primaryKeyOnly(statement)) return false;
  if (!/^\s*(?:SELECT|UPDATE|DELETE)\b/iu.test(statement)) return false;
  // Rolling-accounting reads interpolate a closed accounting predicate and cannot feed the recovery/purge transition.
  if (/\$\{where\}/u.test(statement)) return false;
  // A migration copy is neither an UPDATE/DELETE nor a selecting read that feeds one.
  if (/^\s*INSERT\b/iu.test(statement)) return false;
  return !hasJudgeWorkScopeLiteral(statement);
}

function isScopeEnumeration(statement) {
  return (
    /^\s*SELECT\s+DISTINCT\s+work_scope\s*,\s*source\s*,\s*account_id\s*,\s*test_work_id\b/iu.test(statement) &&
    /\bwork_scope\s*=\s*'source-owned'\s+AND\s+source\s+IS\s+NOT\s+NULL\s+AND\s+account_id\s+IS\s+NOT\s+NULL/iu.test(
      statement,
    ) &&
    /\bwork_scope\s*=\s*'synthetic-test'\s+AND\s+test_work_id\s+IS\s+NOT\s+NULL/iu.test(statement)
  );
}

function isSourceScopeEnumeration(statement) {
  return (
    /^\s*SELECT\s+DISTINCT\s+source\s*,\s*account_id\s*,\s*rule_version\b/iu.test(statement) &&
    /\bwork_scope\s*=\s*'source-owned'\s+AND\s+source\s+IS\s+NOT\s+NULL\s+AND\s+account_id\s+IS\s+NOT\s+NULL/iu.test(
      statement,
    )
  );
}

function isSyntheticAuthorityEnumeration(statement) {
  return (
    /^\s*SELECT\s+DISTINCT\s+test_work_id\b/iu.test(statement) &&
    /\bwork_scope\s*=\s*'synthetic-test'\s+AND\s+test_work_id\s+IS\s+NOT\s+NULL/iu.test(statement) &&
    /\btest_authority_rule_id\s*=\s*\?/iu.test(statement) &&
    /\btest_authority_rule_version\s+IN\s*\(/iu.test(statement)
  );
}

/**
 * E2 Task 7: the Laya worker's boundary probe calls `fetch` once, on purpose, to prove that the macOS sandbox denies
 * it before the worker may load anything; the worker then seals `fetch` itself. That one loopback call, in that one
 * file, is the only exception to the fetch rule. Elsewhere in the file the word may appear only on the four reviewed
 * lines below, none of which can reach `fetch`; any other use (a second call, `?.(`, `['fetch']`, `.call`, an alias)
 * is refused. Every other rule (no http(s) request or import, no computed specifier) still applies to the file.
 */
const LAYA_BOUNDARY_PROBE = 'packages/events-daemon/src/runtime/laya/worker-boundary-probe.ts';
const LAYA_BOUNDARY_FETCH_ATTEMPT = ['globalThis.fetch(`http://127.0.0.1:', '$', '{port}/laya-boundary-probe`'].join(
  '',
);
const LAYA_BOUNDARY_FETCH_NAMES = new Set([
  "export const PROBE_ATTEMPTS = ['tcp', 'fetch', 'udp', 'uds'] as const;",
  "result.fetch === 'denied' &&",
  "['fetch', () => fetchProbe(input.tcpPort)],",
  "seal(globalThis, 'fetch', async (): Promise<never> => sealedNetwork());",
]);

function layaBoundaryProbeFetchProblems(file, executableText) {
  const named = executableText
    .replace(LAYA_BOUNDARY_FETCH_ATTEMPT, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\bfetch\b/u.test(line));
  const reviewed = named.every((line) => LAYA_BOUNDARY_FETCH_NAMES.has(line)) && new Set(named).size === named.length;
  return reviewed ? [] : [`${file}: the Laya boundary probe may use fetch only in its one loopback attempt`];
}

/**
 * E2 Task 8: the isolated Laya worker loads its runtime only after its own boundary proof, from the extracted tree the
 * daemon verified for that start — an absolute path no source can spell as a literal. That one call, in that one file,
 * is the only exception to the computed-specifier rule: `worker-runtime.ts` may contain it once. Any other computed
 * `import(` or `require(` there — a second copy of the same call among them — and the same call in any other file are
 * still `judge paths must not use computed module specifiers`. Every other rule still applies to the file.
 */
const LAYA_WORKER_RUNTIME = 'packages/events-daemon/src/runtime/laya/worker-runtime.ts';
const LAYA_VERIFIED_RUNTIME_IMPORT = 'await import(pathToFileURL(verifiedEntry).href)';

/** Scan one production source file; exported so fixture-copy tests exercise the exact static rules. */
export function verifyPhaseEJudgeSource({ file, source: text }) {
  const problems = [];
  const judgePath =
    file.startsWith('packages/events-daemon/src/') && file !== 'packages/events-daemon/src/runtime/sse-server.ts';
  const executableText = text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\r\n]*$/gmu, '');
  if (judgePath && file === LAYA_BOUNDARY_PROBE) problems.push(...layaBoundaryProbeFetchProblems(file, executableText));
  else if (judgePath && /\bfetch\s*\(/u.test(executableText)) problems.push(`${file}: judge paths must not call fetch`);
  else if (judgePath && /\bfetch\b/u.test(executableText))
    problems.push(`${file}: judge paths must not reference fetch`);
  if (judgePath && /\bhttp\s*\.\s*request\s*\(/u.test(executableText))
    problems.push(`${file}: judge paths must not call http.request`);
  if (judgePath && /\bhttps\s*\.\s*request\s*\(/u.test(executableText))
    problems.push(`${file}: judge paths must not call https.request`);
  if (judgePath && /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?https?['"]/u.test(executableText))
    problems.push(`${file}: judge paths must not import node:http or node:https`);
  const specifierText =
    file === LAYA_WORKER_RUNTIME ? executableText.replace(LAYA_VERIFIED_RUNTIME_IMPORT, '') : executableText;
  const computedModuleSpecifier = [
    ...specifierText.matchAll(/(?<![\w$.#])(import|require)\s*\(\s*([^\r\n)]*)/gmu),
  ].some((match) => {
    const argument = match[2]?.trim() ?? '';
    if (argument.startsWith("'") || argument.startsWith('"')) return false;
    return match[1] !== 'require' || !/^[A-Za-z_$][\w$]*\s*:/u.test(argument);
  });
  if (judgePath && computedModuleSpecifier)
    problems.push(`${file}: judge paths must not use computed module specifiers`);
  if (judgePath && /\[\s*['"]request['"]\s*\]\s*\(/u.test(executableText))
    problems.push(`${file}: judge paths must not use computed request aliases`);
  if (file !== 'packages/events-daemon/src/domain/lifecycle.ts' && hasJudgeKindLiteral(text)) {
    problems.push(`${file}: judge kind literals must come from domain/lifecycle.ts`);
  }
  for (const statement of sqlStatements(text)) {
    if (unscopedJudgeWorkSelection(statement)) {
      problems.push(
        `${file}: judge work SQL selected by kind, judge, rule, or no selector must bind a literal work_scope with its scope predicates`,
      );
    }
    const scopes = [...statement.matchAll(/\bwork_scope\s*=\s*([^\s)]+)/giu)];
    for (const scope of scopes) {
      const value = scope[1];
      if (value === "'source-owned'") {
        if (
          !isScopeEnumeration(statement) &&
          !isSourceScopeEnumeration(statement) &&
          (!/\baccount_id\s*=\s*\?/iu.test(statement) || !/\bsource\s*=\s*\?/iu.test(statement))
        )
          problems.push(`${file}: source-owned judge SQL must bind account_id and source in the same statement`);
      } else if (value === "'synthetic-test'") {
        if (
          !isScopeEnumeration(statement) &&
          !isSyntheticAuthorityEnumeration(statement) &&
          !/\btest_work_id\s*=\s*\?/iu.test(statement)
        )
          problems.push(`${file}: synthetic judge SQL must bind test_work_id in the same statement`);
      } else {
        problems.push(`${file}: judge SQL work_scope must compare with a source-owned or synthetic-test literal`);
      }
    }
  }
  return problems;
}

/** Covers every daemon TypeScript module plus both executable gates, rather than files whose names happen to say judge. */
export async function verifyPhaseEStaticGuards({ root = ROOT } = {}) {
  const files = await tsFiles(root, 'packages/events-daemon/src');
  for (const file of GATE_SCRIPTS) {
    const text = await source(root, file);
    if (text !== undefined) files.push({ file, source: text });
  }
  const problems = files.flatMap(verifyPhaseEJudgeSource);
  for (const [id, file, marker] of REQUIRED_PURGE_CALLERS) {
    const text = await source(root, file);
    if (text !== undefined && !text.includes(marker)) problems.push(`purge caller ${id} is absent from ${file}`);
  }
  return problems;
}

function importCandidates(file, specifier) {
  const target = normalize(join(dirname(file), specifier));
  return [target, `${target}.ts`, `${target}.mts`, `${target}.mjs`, join(target, 'index.ts')];
}

/** Resolve relative imports recursively, so a named test has to load the actual production entry, not a local model. */
async function importsProduction(root, testFile, productionEntry) {
  const queue = [testFile];
  const seen = new Set();
  const wanted = normalize(productionEntry);
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const text = await source(root, file);
    if (text === undefined) continue;
    for (const match of text.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      for (const candidate of importCandidates(file, specifier)) {
        if (normalize(candidate) === wanted) return true;
        if (!seen.has(candidate) && (await source(root, candidate)) !== undefined) queue.push(candidate);
      }
    }
  }
  return false;
}

async function readRunner(root, runnerName, problems) {
  const runner = STRICT_RUNNERS[runnerName];
  if (!runner) return undefined;
  const [runnerTest, support] = await Promise.all([source(root, runner.test), source(root, runner.support)]);
  if (runnerTest === undefined || support === undefined) {
    problems.push(`${runnerName}: strict runner support or test is unreadable`);
    return undefined;
  }
  let module;
  try {
    module = await import(`${pathToFileURL(join(root, runner.support)).href}?phase-e-manifest=${Date.now()}`);
  } catch (error) {
    problems.push(`${runnerName}: cannot import strict runner support: ${String(error)}`);
    return undefined;
  }
  const collection = module[runner.collection];
  if (
    !Array.isArray(collection) ||
    collection.length === 0 ||
    collection.some((entry) => typeof entry?.id !== 'string')
  ) {
    problems.push(`${runnerName}: strict runner collection is empty or malformed`);
    return undefined;
  }
  const loop = new RegExp(
    `for\\s*\\(\\s*const\\s+mutation\\s+of\\s+${runner.loopCollection ?? runner.collection}\\s*\\)\\s*\\{([\\s\\S]*?)\\}`,
    'u',
  ).exec(runnerTest);
  if (!loop || !new RegExp(`\\b${runner.helper}\\s*\\(\\s*mutation\\s*\\)`, 'u').test(loop[1]))
    problems.push(`${runnerName}: mutation loop does not call ${runner.helper} with its loop mutation`);
  const executable = `${support}\n${runnerTest}`;
  if (COPIED_TREE_BASELINE_RUNNERS.has(runnerName)) {
    const helperStart = executable.search(new RegExp(`(?:export\\s+)?async\\s+function\\s+${runner.helper}\\b`, 'u'));
    const helperSource = helperStart < 0 ? '' : executable.slice(helperStart);
    const mutationWrite = helperSource.search(/writeFile\(\s*target/u);
    const baselineRun = helperSource.indexOf('runStrictMutationChild');
    const baselineAssertion =
      /(?:assert\w*(?:Named)?(?:Mutation)?Pass|baseline\.code|,\s*mutation,\s*true\s*,?\s*\))/u.test(
        mutationWrite < 0 ? helperSource : helperSource.slice(0, mutationWrite),
      );
    if (
      helperStart < 0 ||
      mutationWrite < 0 ||
      baselineRun < 0 ||
      baselineRun > mutationWrite ||
      !baselineAssertion ||
      !helperSource.slice(0, mutationWrite).includes('--test-reporter=tap')
    )
      problems.push(`${runnerName}: strict copied-tree runner must prove one named TAP pass before mutation`);
  }
  return { ids: collection.map((entry) => entry.id), mutations: collection, runner, support, executable };
}

export async function verifyPhaseETestManifest({ root = ROOT, manifest = undefined } = {}) {
  const problems = [];
  let loaded = manifest;
  if (loaded === undefined) {
    const raw = await source(root, MANIFEST);
    if (raw === undefined) {
      problems.push(`missing Phase-E manifest: ${MANIFEST}`);
      loaded = {};
    } else {
      try {
        loaded = JSON.parse(raw);
      } catch {
        problems.push('Phase-E manifest is valid JSON');
        loaded = {};
      }
    }
  }

  const cases = Array.isArray(loaded?.cases) ? loaded.cases : [];
  const guards = Array.isArray(loaded?.guards) ? loaded.guards : [];
  const mutations = Array.isArray(loaded?.mutations) ? loaded.mutations : [];
  if (!cases.length || !guards.length || !mutations.length) {
    problems.push('Phase-E manifest must declare at least one case, guard, and mutation');
  }
  const matrixDigest = createHash('sha256').update(JSON.stringify(PHASE_E_AUDIT_MATRIX)).digest('hex');
  if (matrixDigest !== PHASE_E_AUDIT_MATRIX_SHA256)
    problems.push('Phase-E audit matrix digest does not match its immutable inventory');
  if (typeof loaded?.audit !== 'object' || loaded.audit === null || Array.isArray(loaded.audit)) {
    problems.push('Phase-E audit matrix is missing');
    problems.push('Phase-E audit must declare deferred: Task 10');
  } else {
    if (loaded.audit.matrixVersion !== 1) problems.push('Phase-E audit matrix version must be 1');
    if (loaded.audit.covers !== 'Tasks 3-9 and 11') problems.push('Phase-E audit must cover Tasks 3-9 and 11');
    if (loaded.audit.deferred !== 'Task 10') problems.push('Phase-E audit must declare deferred: Task 10');
  }

  const guardIds = new Set(guards.flatMap((entry) => (typeof entry?.id === 'string' ? [entry.id] : [])));
  const mutationIds = new Set(mutations.flatMap((entry) => (typeof entry?.id === 'string' ? [entry.id] : [])));
  const guardOwners = new Map();
  const mutationOwners = new Map();
  const runnerRows = new Map(Object.keys(STRICT_RUNNERS).map((name) => [name, new Map()]));
  const packageJson = JSON.parse((await source(root, 'packages/events-daemon/package.json')) ?? '{"scripts":{}}');
  const packageTest = String(packageJson?.scripts?.test ?? '');

  for (const entry of cases) {
    const id = typeof entry?.id === 'string' ? entry.id : '<unnamed-case>';
    const coverage = Array.isArray(entry?.coverage) ? entry.coverage.filter((value) => typeof value === 'string') : [];
    if (coverage.length !== 1 || !guardIds.has(coverage[0])) {
      problems.push(`${id}: coverage must name exactly one owned §5/Task guard`);
    } else {
      guardOwners.set(coverage[0], (guardOwners.get(coverage[0]) ?? 0) + 1);
    }

    const mutationId = entry?.mutation?.id;
    if (typeof mutationId !== 'string' || !mutationIds.has(mutationId)) {
      problems.push(`${id}: mutation id is not owned by the manifest`);
    } else {
      mutationOwners.set(mutationId, (mutationOwners.get(mutationId) ?? 0) + 1);
    }

    if (typeof entry?.test !== 'string') problems.push(`${id}: every case must name its test`);
    if (typeof entry?.productionEntry !== 'string') problems.push(`${id}: every case must name its productionEntry`);

    if (typeof entry?.strictRunner !== 'string' || !(entry.strictRunner in STRICT_RUNNERS)) {
      problems.push(`${id}: strict runner is missing or does not execute this case`);
    } else if (typeof mutationId === 'string') {
      runnerRows.get(entry.strictRunner).set(mutationId, id);
    }

    if (typeof entry?.productionEntry === 'string') {
      if (/(?:^|\/)test(?:\/|$)/u.test(entry.productionEntry)) {
        problems.push(`${id}: production entry must not be a test-local implementation substitute`);
      } else if ((await source(root, entry.productionEntry)) === undefined) {
        problems.push(`${id}: production entry does not exist: ${entry.productionEntry}`);
      }
    }

    if (typeof entry?.test === 'string') {
      const namedTest = await source(root, entry.test);
      if (namedTest === undefined) {
        problems.push(`${id}: named production-path test does not exist: ${entry.test}`);
      } else {
        if (typeof entry?.mutation?.test === 'string' && !namedTest.includes(entry.mutation.test)) {
          problems.push(`${id}: mutation test is not named by ${entry.test}`);
        }
        if (
          typeof entry?.productionEntry === 'string' &&
          !(await importsProduction(root, entry.test, entry.productionEntry))
        ) {
          problems.push(`${id}: named test does not import its production entry`);
        }
      }
    }

    if (entry?.network === true && !packageTest.includes('loopback-seal-preload.mjs')) {
      problems.push(`${id}: judge network test requires the loopback-seal preload`);
    }
  }

  const casesById = new Map(cases.flatMap((entry) => (typeof entry?.id === 'string' ? [[entry.id, entry]] : [])));
  const auditIds = PHASE_E_AUDIT_MATRIX.map((row) => `${row.category}:${row.id}`);
  if (new Set(auditIds).size !== auditIds.length) problems.push('Phase-E audit matrix rows must be unique');
  for (const row of PHASE_E_AUDIT_MATRIX) {
    const owner = casesById.get(row.owner);
    if (owner === undefined) {
      problems.push(`audit ${row.category} row ${row.id} has no manifest owner ${row.owner}`);
      continue;
    }
    if (typeof owner?.mutation?.id !== 'string')
      problems.push(`audit ${row.category} row ${row.id} has no strict mutation`);
  }
  const corpusManifest = await source(root, 'packages/events-daemon/test/fixtures/judges/adversarial-v1.manifest.json');
  if (corpusManifest === undefined) {
    problems.push('Phase-E adversarial corpus manifest is missing');
  } else {
    try {
      const corpus = JSON.parse(corpusManifest);
      const corpusIds = Array.isArray(corpus?.cases)
        ? corpus.cases.flatMap((entry) => (typeof entry?.id === 'string' ? [entry.id] : []))
        : [];
      for (const id of REQUIRED_CORPUS_ROWS)
        if (!corpusIds.includes(id)) problems.push(`required Phase-E corpus row is absent: ${id}`);
      for (const id of corpusIds)
        if (!REQUIRED_CORPUS_ROWS.includes(id)) problems.push(`unrecognised Phase-E corpus row: ${id}`);
      if (new Set(corpusIds).size !== corpusIds.length) problems.push('Phase-E corpus row ids must be unique');
    } catch {
      problems.push('Phase-E adversarial corpus manifest is valid JSON');
    }
  }

  for (const [id, count] of guardOwners) {
    if (count !== 1) problems.push(`${id}: guard has ${count} owners`);
  }
  for (const id of guardIds) if (!guardOwners.has(id)) problems.push(`unowned §5 row: ${id}`);
  for (const [id, count] of mutationOwners) {
    if (count !== 1) problems.push(`${id}: mutation has ${count} owners`);
  }
  for (const id of mutationIds) if (!mutationOwners.has(id)) problems.push(`orphan mutation: ${id}`);
  for (const id of REQUIRED_GUARD_ROWS) {
    if (!guardIds.has(id)) problems.push(`required Phase-E guard row is absent: ${id}`);
    else if (!guardOwners.has(id)) problems.push(`unowned §5 row: ${id}`);
  }
  for (const id of Array.isArray(loaded?.requiredCoverage) ? loaded.requiredCoverage : []) {
    if (typeof id === 'string' && !guardOwners.has(id)) problems.push(`unowned §5 row: ${id}`);
  }
  for (const runnerName of Object.keys(STRICT_RUNNERS)) {
    const loadedRunner = await readRunner(root, runnerName, problems);
    if (loadedRunner === undefined) continue;
    const manifestRows = runnerRows.get(runnerName);
    for (const id of loadedRunner.ids) {
      if (!manifestRows.has(id)) problems.push(`${runnerName}: runner mutation has no manifest row: ${id}`);
    }
    for (const id of manifestRows.keys()) {
      if (!loadedRunner.ids.includes(id)) problems.push(`${runnerName}: manifest row mutation is not in runner: ${id}`);
    }
    for (const entry of loadedRunner.mutations) {
      if (typeof entry.killingAssertion !== 'string' || entry.killingAssertion.length === 0)
        problems.push(`${entry.id}: mutation must name its killing assertion`);
      if (
        !/result\.output\.includes\(mutation\.killingAssertion/u.test(loadedRunner.executable) &&
        !/return\s+expectJudgeMutationToFail\(mutation\)/u.test(loadedRunner.executable)
      )
        problems.push(`${runnerName}: strict runner must enforce each killing assertion`);
    }
  }

  problems.push(...(await verifyPhaseEStaticGuards({ root })));
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await verifyPhaseETestManifest();
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  }
}
