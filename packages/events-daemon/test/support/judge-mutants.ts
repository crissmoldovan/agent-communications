import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runStrictMutationChild } from './strict-mutation-child.ts';

export interface JudgeMutation {
  readonly id: string;
  readonly source: string;
  readonly before: string;
  readonly after: string;
  readonly test: string;
  readonly testName: string;
  readonly killingAssertion?: string | undefined;
}

const phaseEGateMutations: readonly JudgeMutation[] = [
  {
    id: 'e3-b3-contract-version',
    source: 'packages/events-daemon/src/operations/b3-contract.ts',
    before: "export const B3_CONTROL_V1_SCHEMA_VERSION = 'b3-control-v1' as const;",
    after: "export const B3_CONTROL_V1_SCHEMA_VERSION = 'stubbed-b3-control-v1' as const;",
    test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
    testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
  },
  {
    id: 'e3-b3-unavailable-variants',
    source: 'packages/events-daemon/src/operations/b3-contract.ts',
    before: "  { code: 'E2_REQUIRED', phase: 'E2' },",
    after: "  { code: 'E2_REQUIRED', phase: 'E' },",
    test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
    testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
  },
  {
    id: 'e3-b3-vector-schema-validation',
    source: 'packages/events-daemon/src/operations/b3-contract.ts',
    before: '!isB3DesktopControlOperation(request.operation) ||\n    !isRecord(request.args)',
    after: 'false',
    test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
    testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
  },
  {
    id: 'e3-scope-account-source',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    before: '      if (value === "\'source-owned\'") {',
    after: '  if (false) {',
    test: 'packages/events-daemon/test/judge-scope.test.ts',
    testName:
      'E3 scope: static guards reject hollow manifests, missing runners, unsealed network tests and test-local models',
  },
  {
    id: 'e3-scope-synthetic-work',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    before: '      } else if (value === "\'synthetic-test\'") {',
    after: '      } else if (false) {',
    test: 'packages/events-daemon/test/judge-scope.test.ts',
    testName:
      'E3 scope: static guards reject hollow manifests, missing runners, unsealed network tests and test-local models',
  },
  {
    id: 'e7-deterministic-first',
    source: 'packages/events-daemon/src/runtime/evaluate.ts',
    before: 'if (!matchesRuleCondition(rule, projection.event)) {',
    after: 'if (false) {',
    test: 'packages/events-daemon/test/judge-evaluation.test.ts',
    testName: 'E7: deterministic false creates no judge provenance, taint, reservation, or request bytes',
  },
  {
    id: 'e7-taint-before-reserve',
    source: 'packages/events-daemon/src/runtime/judge-coordinator.ts',
    before: 'await this.#taint.record({',
    after: 'await ({ record: async () => undefined } as EventTaintRecorder).record({',
    test: 'packages/events-daemon/test/judge-evaluation.test.ts',
    testName: 'E7: a failed taint flush emits zero judge bytes and leaves no reservation',
  },
  {
    id: 'e7-exact-input-provenance',
    source: 'packages/events-daemon/src/runtime/judge-coordinator.ts',
    before: 'value: { $path: pointer }',
    after: "value: { $path: '/subject' }",
    test: 'packages/events-daemon/test/judge-taint.test.ts',
    testName:
      'E7 taint: exact judge input preserves copied scalar, parent and subtree provenance while constants inherit none',
  },
  {
    id: 'e7-settlement-token',
    source: 'packages/events-daemon/src/runtime/evaluate.ts',
    before: 'actualInputTokens: judged.actualInputTokens,',
    after: 'actualInputTokens: 0,',
    test: 'packages/events-daemon/test/judge-evaluation.test.ts',
    testName:
      'E7: evaluator taints exact judge input, reserves, uses sealed transport, and atomically commits a matched decision',
  },
  {
    id: 'e7-pause-fence',
    source: 'packages/events-daemon/src/runtime/judge-budget.ts',
    before:
      "if (settings?.paused === 1) refusal('JUDGE_PAUSED', 'the event switch is paused before the judge boundary');",
    after:
      "if (false && settings?.paused === 1) refusal('JUDGE_PAUSED', 'the event switch is paused before the judge boundary');",
    test: 'packages/events-daemon/test/judge-evaluation.test.ts',
    testName: 'E7: pause fences reserved judge I/O and completed-response decision writes',
  },
  {
    id: 'e7-full-request-estimate',
    source: 'packages/events-daemon/src/runtime/judge-coordinator.ts',
    before: 'finalEnvelope: prepared.request,',
    after: 'finalEnvelope: prepared.body,',
    test: 'packages/events-daemon/test/judge-evaluation.test.ts',
    testName: 'E7: admission reserves the full HTTP request before transport can refuse it',
  },
  {
    id: 'e7-single-decision-owner',
    source: 'packages/events-daemon/src/runtime/judge-budget.ts',
    before: 'if (prior !== null)',
    after: 'if (false && prior !== null)',
    test: 'packages/events-daemon/test/judge-evaluation.test.ts',
    testName: 'E7: a concurrent evaluation leaves a live judge work item to its one decision owner',
  },
  {
    id: 'e7-deterministic-shared-route',
    source: 'packages/events-daemon/src/runtime/decisions.ts',
    before: 'if (input.settlement !== undefined && input.disclosure !== undefined) {',
    after: 'if (input.disclosure !== undefined) {',
    test: 'packages/events-daemon/test/evaluation.test.ts',
    testName: 'EVAL-B1: one deterministic projection maps to exact CloudEvent bytes and one dry-run delivery',
  },
  {
    id: 'e7-evaluator-writer-lease',
    source: 'packages/events-daemon/src/runtime/evaluate.ts',
    before: 'return this.#writerQuiescer === undefined ? work() : withEventWriterLease(this.#writerQuiescer, work);',
    after: 'return work();',
    test: 'packages/events-daemon/test/b3-writer-quiescer.test.ts',
    testName: 'B3 writer inventory is exact and every discovered cipher or secret-store path is leased',
  },
  {
    id: 'e9-fixed-synthetic-judge-input',
    source: 'packages/events-daemon/src/runtime/judge-test.ts',
    before: '      state: canonicalJson(TEST_CLOUD_EVENT),',
    after: "      state: canonicalJson({ type: 'caller-controlled' }),",
    test: 'packages/events-daemon/test/judge-test-operation.test.ts',
    testName:
      'E9 judge test: the fixed synthetic input is tainted, globally reserved and sent through the sealed transport',
  },
  {
    id: 'e9-judge-key-rotate-current-generation',
    source: 'packages/events-daemon/src/runtime/b3-secret-control.ts',
    before: "      const prior = this.#requiredCurrent(owner, 'judge-key');",
    after: '      const prior = null;',
    test: 'packages/events-daemon/test/b3-secrets.test.ts',
    testName: 'B3 secret slots create and rotate only exact immutable owners with content-free receipts',
    killingAssertion: 'the expected prior secret generation is no longer current',
  },
  {
    id: 'e9-mcp-kind-enable-no-active-pointer',
    source: 'packages/events-daemon/src/runtime/b3-operator-control.ts',
    before:
      '    return new JudgeKinds({ store: this.#store, now: this.#now, activations }).prepareEnable({\n      kind: available,\n      version,\n    });',
    after:
      '    this.#store.database\n      .prepare(\n        "INSERT OR REPLACE INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES (?, ?, ?, NULL, ?)",\n      )\n      .run(\'judge-kind\', available, version, this.#now());\n    return new JudgeKinds({ store: this.#store, now: this.#now, activations }).prepareEnable({\n      kind: available,\n      version,\n    });',
    test: 'packages/events-daemon/test/b3-operator-control.test.ts',
    testName: 'E9 operator control creates immutable subscriber and judge versions while retaining the E2 model seam',
  },
  {
    id: 'e9-pending-rule-judge-origin',
    source: 'packages/events-daemon/src/runtime/owner.ts',
    before:
      "function pendingRuleJudgeTestOrigin(origin: string | undefined): PendingRuleJudgeTestOrigin | undefined {\n  if (origin === 'terminal-approval' || origin === 'app-approval-screen') return origin;",
    after:
      "function pendingRuleJudgeTestOrigin(origin: string | undefined): PendingRuleJudgeTestOrigin | undefined {\n  if (origin === 'terminal-approval' || origin === 'app-approval-screen' || origin === 'mcp') return 'terminal-approval';",
    test: 'packages/events-daemon/test/pending-rule-judge-test.test.ts',
    testName:
      'E9 pending-rule judge test is terminal/app-only and binds one live pending approval before a tester is reached',
  },
  {
    id: 'e12-target-remove-purge',
    source: 'packages/events-daemon/src/runtime/revocations.ts',
    before: 'purgeRevokedRuleWork(database.database, rule.rule_id, [rule.version], revokedAt);',
    after: 'void rule;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 purge closure: target remove uses the production participant',
    killingAssertion: 'target remove: the real purge caller settles in-flight judge work',
  },
  {
    id: 'e12-subscriber-remove-purge',
    source: 'packages/events-daemon/src/runtime/b3-operator-control.ts',
    before: 'purgeRevokedRuleWork(this.#store.database, rule.rule_id, [rule.version], now);',
    after: 'void rule;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 purge closure: subscriber remove uses the production participant',
    killingAssertion: 'subscriber remove: the real purge caller settles in-flight judge work',
  },
  {
    id: 'e12-judge-remove-purge',
    source: 'packages/events-daemon/src/runtime/b3-operator-control.ts',
    before: `new JudgePurgeParticipant({ database: this.#store.database, now: () => revokedAt }).judge({
        judgeId,
        versions: [...removedVersions],
      });`,
    after: 'void removedVersions;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 purge closure: judge remove uses the production participant',
    killingAssertion: 'judge remove enumerates and settles exact synthetic-test work independently of bound rules',
  },
  {
    id: 'e12-account-remove-readd-purge',
    source: 'packages/events-daemon/src/runtime/account-fence.ts',
    before: 'new JudgePurgeParticipant({ database, now: () => now }).account({ source, accountId });',
    after: 'void source; void accountId;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 purge closure: account remove and re-add use the production participant',
    killingAssertion: 'account remove: the real purge caller settles in-flight judge work',
  },
  {
    id: 'e12-whatsapp-hide-purge',
    source: 'packages/events-daemon/src/runtime/whatsapp-visibility.ts',
    before:
      "for (const event of affectedEvents) judgePurge.event({ source: 'whatsapp', accountId, eventId: event.event_id });",
    after: 'void judgePurge; void affectedEvents;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 purge closure: WhatsApp hide uses the production participant',
    killingAssertion: 'WhatsApp hide: the real purge caller settles in-flight judge work',
  },
  {
    id: 'e12-rule-disable-purge',
    source: 'packages/events-daemon/src/runtime/revocations.ts',
    before: 'purgeRevokedRuleWork(database.database, ruleId, live, revokedAt);',
    after: 'void live;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 purge closure: rule disable uses the production participant',
    killingAssertion: 'rule disable: the real purge caller settles in-flight judge work',
  },
  {
    id: 'e12-disable-all-purge',
    source: 'packages/events-daemon/src/runtime/lifecycle.ts',
    before: 'new JudgePurgeParticipant({ database, now: this.now }).all();',
    after: 'void database;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 purge closure: disable all uses the production participant',
    killingAssertion: 'disable all: the real purge caller settles in-flight judge work',
  },
  {
    id: 'e12-account-rule-revoke',
    source: 'packages/events-daemon/src/runtime/account-fence.ts',
    before: 'purgeRevokedRuleWork(database, version.rule_id, [version.version], now);',
    after: 'void version;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 purge closure: single-account rule revoke uses the production participant',
    killingAssertion: 'single-account rule revoke settles synthetic work bound to the revoked rule',
  },
  {
    id: 'e12-derived-parent-revoke',
    source: 'packages/events-daemon/src/runtime/replacements.ts',
    before: 'purgeRevokedRuleWork(database, input.parent.ruleId, [input.parent.version], input.now);',
    after: 'void input.parent;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E4 purge closure: retention tightening settles only rule A on an event shared with live rule B work',
    killingAssertion: 'derived parent revoke settles synthetic work bound to the revoked parent',
  },
  {
    id: 'e12-account-source-purge',
    source: 'packages/events-daemon/src/runtime/account-fence.ts',
    before: 'const sourceEventIds = `SELECT event_id FROM ingest WHERE account_id = ? AND type GLOB ?`;',
    after: 'const sourceEventIds = `SELECT event_id FROM ingest WHERE account_id = ? AND ? IS NOT NULL`;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E12 account scope: removing Gmail preserves same-id Slack work and its final reservation authority',
    killingAssertion: 'removing Gmail leaves the same-id Slack reservation authorised at the final fence',
  },
  {
    id: 'e12-judge-key-generation-fence',
    source: 'packages/events-daemon/src/runtime/judge-budget.ts',
    before: '  if (hostedKey === undefined) return;',
    after: '  if (true) return;',
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E12 judge race: hosted-key rotation during DNS refuses the retired generation before any request byte',
    killingAssertion: 'a DNS-paused synthetic test refuses after its prepared hosted-key generation is retired',
  },
  {
    id: 'e12-judge-kind-literal-guard',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    before: "  if (file !== 'packages/events-daemon/src/domain/lifecycle.ts' && hasJudgeKindLiteral(text)) {",
    after: "  if (false && file !== 'packages/events-daemon/src/domain/lifecycle.ts' && hasJudgeKindLiteral(text)) {",
    test: 'packages/events-daemon/test/judge-scope.test.ts',
    testName: 'E3 scope: static guards analyse each kind literal and each SQL statement independently',
    killingAssertion: 'separate constants cannot split the closed judge-kind vocabulary past the guard',
  },
  {
    id: 'e12-audit-matrix',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    before: "    ['activation-approval-claim-to-pointer', 'e4-final-pointer-drift'],\n",
    after: '',
    test: 'packages/events-daemon/test/judge-scope.test.ts',
    testName: 'E12 scope: the audit matrix and explicit Task 10 deferral are structural, not manifest-defined',
    killingAssertion: 'the immutable audit matrix digest must stay exact',
  },
  {
    id: 'e12-static-network-path',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    before: `  else if (judgePath && /\\bfetch\\b/u.test(executableText))
    problems.push(\`\${file}: judge paths must not reference fetch\`);`,
    after: `  else if (false && judgePath && /\\bfetch\\b/u.test(executableText))
    problems.push(\`\${file}: judge paths must not reference fetch\`);`,
    test: 'packages/events-daemon/test/judge-scope.test.ts',
    testName: 'E12 scope: judge paths reject alternate HTTP clients and every lifecycle purge caller is structural',
    killingAssertion: 'judge helper names and raw-client aliases cannot escape the static network boundary',
  },
  {
    id: 'e12-purge-caller-registry',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    before: `  [
    'target-remove',
    'packages/events-daemon/src/runtime/revocations.ts',
    'purgeRevokedRuleWork(database.database, rule.rule_id, [rule.version], revokedAt);',
  ],`,
    after: '',
    test: 'packages/events-daemon/test/judge-scope.test.ts',
    testName: 'E12 scope: judge paths reject alternate HTTP clients and every lifecycle purge caller is structural',
    killingAssertion: "deleting target removal's purge caller must fail closed",
  },
  {
    id: 'e12-corpus-dependency-closure',
    source: 'scripts/verify-events-adversarial-corpus.mjs',
    before: '  return [...discovered];',
    after: '  return [...roots];',
    test: 'packages/events-daemon/test/judge-corpus-integrity.test.ts',
    testName:
      'E12 adversarial corpus integrity: a registered helper re-export cannot escape dependency-closed scanning',
    killingAssertion: 'a transitive helper dependency must be registered and scanned',
  },
  {
    id: 'e12-held-purge-race',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before: "      if (error instanceof StaleDecisionError) return { kind: 'stale' };",
    after: "      if (error instanceof StaleDecisionError) return { kind: 'resolved', outcome: 'matched' };",
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName:
      'E12 judge race: paused held resolution loses to target, subscriber, judge, account re-add, WhatsApp hide and expiry purges',
    killingAssertion: 'target remove: resumed stale work is refused',
  },
  {
    id: 'e12-hold-claim-expiry-call',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before: "      expireHeldDecisionsInTransaction(database);\n      return { kind: 'expired' };",
    after: "      void database;\n      return { kind: 'expired' };",
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E12 hold claim expiry caller terminalises through its exact production operation',
    killingAssertion: 'claim path: the held decision reaches its exact terminal outcome',
  },
  {
    id: 'e12-hold-api-expiry-call',
    source: 'packages/events-daemon/src/runtime/holds.ts',
    before: '  return store.immediate(() => expireHeldDecisionsInTransaction(store.database));',
    after: '  return 0;',
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E12 hold expiry API caller terminalises through its exact production operation',
    killingAssertion: 'the public expiry API terminalises one expired hold',
  },
  {
    id: 'e12-hold-resolution-expiry-call',
    source: 'packages/events-daemon/src/runtime/decisions.ts',
    before: '      expireHeldDecisionsInTransaction(database);\n      return true;',
    after: '      void database;\n      return true;',
    test: 'packages/events-daemon/test/judge-races.test.ts',
    testName: 'E12 final hold-resolution expiry caller commits terminal purge before reporting stale',
    killingAssertion: 'final resolution: the held decision reaches its exact terminal outcome',
  },
  {
    id: 'e-review-judge-input-envelope',
    source: 'packages/events-daemon/src/runtime/judge-coordinator.ts',
    before: `data: applyRepresentation(mapped.data, plainClassification, {
      kind: 'enveloped',
      envelope: (text) => wrapUntrusted(text, { field: 'judge-input' }, boundary),
    }),`,
    after: 'data: mapped.data,',
    test: 'packages/events-daemon/test/judge-taint.test.ts',
    testName:
      'E7 taint: exact judge input preserves copied scalar, parent and subtree provenance while constants inherit none',
    killingAssertion: 'appears only inside an untrusted-content envelope',
  },
  {
    id: 'e-review-event-taint-platform',
    source: 'packages/events-daemon/src/runtime/untrusted.ts',
    before:
      'input.classification.handles.map((entry) => ({ platform: input.channel, scope: entry.workspace, id: entry.id }))',
    after: "input.classification.handles.map((entry) => ({ platform: 'gmail', scope: entry.workspace, id: entry.id }))",
    test: 'packages/events-daemon/test/event-taint-platform.test.ts',
    testName: 'E7 taint platform: real Slack and WhatsApp delivery commits see the channel-scoped handle first',
    killingAssertion: 'the exact platform-scoped key exists before the outbox write',
  },
  {
    id: 'e-review-kind-disable-work-closure',
    source: 'packages/events-daemon/src/runtime/judge-kinds.ts',
    before: '      purgeJudgeKindRuleWork(this.#store.database, enabledKind, this.#now());',
    after: '      void enabledKind;',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E4 purge closure: kind disable removes every bound work class and re-enable resumes nothing',
    killingAssertion: 'judge kind disable: the real purge caller removes the encrypted projection',
  },
  {
    id: 'e-review-kind-disable-keeps-rule-authority',
    source: 'packages/events-daemon/src/runtime/replacements.ts',
    before:
      '  for (const row of rows) purgeRevokedRuleWork(database, row.rule_id, [row.version], now, { keepAuthority: true });',
    after:
      '  for (const row of rows) purgeRevokedRuleWork(database, row.rule_id, [row.version], now, { keepAuthority: false });',
    test: 'packages/events-daemon/test/judge-purge-closure.test.ts',
    testName: 'E4 purge closure: kind disable removes every bound work class and re-enable resumes nothing',
    killingAssertion:
      'kind disable keeps the bound rule able to resume: its activation point and target references stay',
  },
  {
    id: 'e-review-preio-release-commit',
    source: 'packages/events-daemon/src/runtime/judge-budget.ts',
    before: "         WHERE id = ? AND concurrency_owned = 1 AND state = 'reserved'`,",
    after: "         WHERE id = ? AND concurrency_owned = 1 AND state = 'reserved' AND 0 = 1`,",
    test: 'packages/events-daemon/test/pending-rule-judge-test.test.ts',
    testName:
      'E9 pending-rule judge test is terminal/app-only and binds one live pending approval before a tester is reached',
    killingAssertion: 'the pre-I/O refusal commits its reservation release and frees the concurrency slot',
  },
  {
    id: 'e-review-response-owner-recovery',
    source: 'packages/events-daemon/src/runtime/evaluate.ts',
    before: 'recoverJudgeReservation({ store: this.#store, reservationId: judged.reservationId, now: this.#now() });',
    after: 'void judged.reservationId;',
    test: 'packages/events-daemon/test/judge-evaluation.test.ts',
    testName: 'E7: pause fences reserved judge I/O and completed-response decision writes',
    killingAssertion:
      'pessimistic recovery closes the response content-free instead of leaving retryable owner-held work',
  },
  {
    id: 'e-review-valid-mcp-kind-disable-parity',
    source: 'packages/events-daemon/src/mcp/server.ts',
    before: `    (args) => {
      const kind = args.kind as string;
      return b3('disableJudgeKind', { kind }, () => disableJudgeKind(kind, options));
    },`,
    after: `    (args) => {
      const kind = args.kind === 'typesafe' ? 'local-endpoint' : (args.kind as string);
      return b3('disableJudgeKind', { kind }, () => disableJudgeKind(kind, options));
    },`,
    test: 'packages/events-daemon/test/b3-e2e-surface.test.ts',
    testName: 'B3 judge mutation parity: valid isolated inputs succeed through real Commander and MCP adapters',
    killingAssertion: 'events-daemon.judge-kind.disable: mcp disables the requested valid kind',
  },
  {
    id: 'e-review-b3-capability-row-removal',
    source: 'packages/events-daemon/src/operations/b3-contract.ts',
    before: `  both(
    'events-daemon.judge-kind.disable',
    'judge kind disable <kind>',
    'events_judge_kind_disable',
    'disableJudgeKind',
  ),`,
    after: '',
    test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
    testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
    killingAssertion: 'Phase E prerequisite failed: exact B3 capability inventory',
  },
  {
    id: 'e-review-b3-capability-operation',
    source: 'packages/events-daemon/src/operations/b3-contract.ts',
    before: `  both(
    'events-daemon.judge-kind.disable',
    'judge kind disable <kind>',
    'events_judge_kind_disable',
    'disableJudgeKind',
  ),`,
    after: `  both(
    'events-daemon.judge-kind.disable',
    'judge kind disable <kind>',
    'events_judge_kind_disable',
    'stubbedDisableJudgeKind',
  ),`,
    test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
    testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
    killingAssertion: 'Phase E prerequisite failed: exact B3 capability inventory',
  },
];

export const PHASE_E_GATE_MUTATIONS: readonly (JudgeMutation & { readonly killingAssertion: string })[] =
  phaseEGateMutations.map((mutation): JudgeMutation & { readonly killingAssertion: string } => ({
    ...mutation,
    killingAssertion: mutation.killingAssertion ?? 'ERR_ASSERTION',
  }));

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`;
}

function namedTapFailure(output: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^not ok \\d+ - ${escaped}(?:\\s|$)([^\\n]*)`, 'mu').test(output);
}

function namedTapPass(output: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^ok \\d+ - ${escaped}(?:\\s|$)([^\\n]*)`, 'mu').test(output);
}

function tapSummary(output: string, label: 'tests' | 'pass' | 'fail', value: number): boolean {
  return new RegExp(`^# ${label} ${value}\\s*$`, 'mu').test(output);
}

/**
 * Copy only the module/test closure used by the named E3 cases.  Test paths retain their repository shape so the
 * verifiers see the copied B3 contract and fixtures rather than the source checkout.
 */
async function copyMutationClosure(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const copiedPackage = join(root, 'packages', 'events-daemon');
  await Promise.all([
    mkdir(copiedPackage, { recursive: true }),
    mkdir(join(root, 'scripts'), { recursive: true }),
    mkdir(join(root, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    cp(join(packageRoot, 'src'), join(copiedPackage, 'src'), { recursive: true }),
    cp(join(packageRoot, 'test'), join(copiedPackage, 'test'), { recursive: true }),
    cp(join(packageRoot, 'package.json'), join(copiedPackage, 'package.json')),
    cp(join(repositoryRoot, 'capabilities.json'), join(root, 'capabilities.json')),
    cp(join(repositoryRoot, 'package.json'), join(root, 'package.json')),
    cp(
      join(repositoryRoot, 'scripts', 'verify-events-phase-e-prerequisites.mjs'),
      join(root, 'scripts', 'verify-events-phase-e-prerequisites.mjs'),
    ),
    cp(
      join(repositoryRoot, 'scripts', 'verify-events-phase-e-tests.mjs'),
      join(root, 'scripts', 'verify-events-phase-e-tests.mjs'),
    ),
    cp(
      join(repositoryRoot, 'scripts', 'verify-b3-writer-inventory.mjs'),
      join(root, 'scripts', 'verify-b3-writer-inventory.mjs'),
    ),
    cp(
      join(repositoryRoot, 'scripts', 'verify-events-adversarial-corpus.mjs'),
      join(root, 'scripts', 'verify-events-adversarial-corpus.mjs'),
    ),
    cp(join(repositoryRoot, 'test', 'helpers'), join(root, 'test', 'helpers'), { recursive: true }),
  ]);
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  await symlink(join(packageRoot, 'node_modules'), join(copiedPackage, 'node_modules'), 'dir').catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

/** Runs exactly one named test in a copied production closure and accepts only one TAP failure. */
export async function expectJudgeMutationToFail(mutation: JudgeMutation): Promise<void> {
  const mutationRoot = join(mutantsRoot, mutation.id);
  const root = join(mutationRoot, 'tree');
  try {
    await rm(mutationRoot, { recursive: true, force: true });
    await copyMutationClosure(root);
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(occurrences(original, mutation.before), 1, `${mutation.id}: mutation source matches exactly once`);
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const args = [
      '--import',
      pathToFileURL(join(root, 'test/helpers/loopback-seal-preload.mjs')).href,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern',
      exactTestName(mutation.testName),
      join(root, mutation.test),
    ];
    const baseline = await runStrictMutationChild({
      command: process.execPath,
      args,
      cwd: root,
      env: environment,
      timeoutMs: 30_000,
    });
    if (baseline.output.includes('EPERM')) throw new Error(`${mutation.id}: baseline is blocked by EPERM`);
    if (
      baseline.code !== 0 ||
      !namedTapPass(baseline.output, mutation.testName) ||
      !tapSummary(baseline.output, 'tests', 1) ||
      !tapSummary(baseline.output, 'pass', 1) ||
      !tapSummary(baseline.output, 'fail', 0)
    )
      throw new Error(`${mutation.id}: unmutated named test did not pass\n${baseline.output.slice(-2000)}`);

    await writeFile(
      target,
      `${original.replace(mutation.before, mutation.after)}\n${target.endsWith('.ts') ? `(globalThis as { readonly [key: symbol]: unknown })` : 'globalThis'}[Symbol.for('agentcomms.e3-mutant.loaded')]?.(${JSON.stringify(mutation.id)});\n`,
    );
    const observer = join(root, 'e3-mutant-observer.mjs');
    await writeFile(
      observer,
      "globalThis[Symbol.for('agentcomms.e3-mutant.loaded')] = (id) => process.stdout.write('E3_MUTANT_LOADED:' + id + '\\n');\n",
    );
    const result = await runStrictMutationChild({
      command: process.execPath,
      args: ['--import', pathToFileURL(observer).href, ...args],
      cwd: root,
      env: environment,
      timeoutMs: 30_000,
    });
    assert.ok(
      result.output.includes(`E3_MUTANT_LOADED:${mutation.id}`),
      `${mutation.id}: the copied mutant source was not loaded\n${result.output}`,
    );
    assert.notEqual(result.code, 0, `${mutation.id}: ${mutation.testName} unexpectedly accepted its mutant`);
    assert.ok(
      namedTapFailure(result.output, mutation.testName),
      `${mutation.id}: named test did not fail\n${result.output}`,
    );
    assert.ok(tapSummary(result.output, 'tests', 1), `${mutation.id}: more than one test ran\n${result.output}`);
    assert.ok(
      tapSummary(result.output, 'fail', 1),
      `${mutation.id}: named test did not fail exactly once\n${result.output}`,
    );
    assert.equal(
      typeof mutation.killingAssertion === 'string' && result.output.includes(mutation.killingAssertion),
      true,
      `${mutation.id}: its named guard assertion did not kill the mutant\n${result.output}`,
    );
  } finally {
    await rm(mutationRoot, { recursive: true, force: true });
  }
}
