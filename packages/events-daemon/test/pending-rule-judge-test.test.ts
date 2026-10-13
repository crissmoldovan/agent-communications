import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { activationDocumentDigest } from '../src/domain/activation-documents.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import {
  isPendingRuleJudgeTestSelector,
  verifyPendingRuleJudgeTestContext,
} from '../src/runtime/b3-pending-rule-judge-test.ts';
import { JudgeTestControl } from '../src/runtime/judge-test.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { createOwnerB3ControlService } from '../src/runtime/owner.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const NOW = 1_800_000_000_000;
const ACCOUNT = 'ibx_EPENDINGRULE';
const judge = {
  judgeId: 'judge-pending-rule',
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'pending-rule-model',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'] as const,
  promptTemplate: 'pending-rule-v1',
  protocol: 'noul' as const,
};

test('E9 pending-rule judge selector stays byte-for-byte aligned with its checked schema vectors', async () => {
  const [schema, vectors] = await Promise.all([
    readFile(join(import.meta.dirname, '../src/operations/contracts/pending-rule-judge-test-v1.schema.json'), 'utf8'),
    readFile(join(import.meta.dirname, 'fixtures/pending-rule-judge-test-vectors.json'), 'utf8'),
  ]);
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    JSON.parse(schema) as Record<string, unknown>,
  );
  const parsed = JSON.parse(vectors) as {
    readonly valid: unknown;
    readonly invalid: readonly { readonly name: string; readonly value: unknown }[];
  };

  assert.equal(validate(parsed.valid), true, JSON.stringify(validate.errors));
  assert.equal(isPendingRuleJudgeTestSelector(parsed.valid), true);
  for (const vector of parsed.invalid) {
    assert.equal(validate(vector.value), false, `${vector.name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(isPendingRuleJudgeTestSelector(vector.value), false, vector.name);
  }
});

function responseSocket(requests: Buffer[]) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  return {
    write(bytes: Uint8Array) {
      requests.push(Buffer.from(bytes));
      queueMicrotask(() => {
        listeners.get('data')?.(
          Buffer.from(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"judge-test":{"type":"noul","noul":0.75}},"model":"pending-rule-model","usage":{"input_tokens":3,"output_tokens":2}}',
          ),
        );
        listeners.get('end')?.();
      });
      return true;
    },
    destroy() {},
    once(event: string, listener: (value?: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
    on(event: string, listener: (value?: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
  };
}

function activation() {
  return {
    documentVersion: 1 as const,
    kind: 'rule' as const,
    rule: {
      ruleId: 'pending-rule-judge-test',
      version: 2,
      source: {
        channel: 'gmail' as const,
        accountIds: [ACCOUNT],
        options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/subject', op: 'exists' as const },
      agentic: {
        judge,
        question: 'Score the fixed pending-rule synthetic event.',
        inputs: ['/subject'],
        threshold: 0.5,
        onUncertain: 'no-match' as const,
        callsPerRollingHour: 1,
        inputTokensPerRolling30Days: 10_000,
        concurrency: 1,
        maxInputTokens: 10_000,
        maxOutputTokens: 512,
      },
      mapping: { constant: 'safe' },
      targets: [{ targetId: 'pending-rule-dry-run', version: 1, kind: 'dry-run' as const, retentionMs: 60_000 }],
      subscribers: [],
      judges: [],
      deliveryRateCap: 1,
      retention: {
        ingestMs: 60_000,
        holdMs: 60_000,
        deliveryMs: 60_000,
        dryrunMs: 60_000,
        sseReplayMs: 60_000,
        deadLetterMs: 60_000,
        decisionMetadataMs: 60_000,
      },
    },
  };
}

test('E9 pending-rule judge test is terminal/app-only and binds one live pending approval before a tester is reached', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e9-pending-rule-test-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = activation();
    const digest = activationDocumentDigest(document);
    const selector = {
      kind: 'pending-rule-judge-test' as const,
      activationId: 'activation-pending-rule-test',
      ruleId: document.rule.ruleId,
      ruleVersion: document.rule.version,
      judgeId: judge.judgeId,
      judgeVersion: judge.version,
      approvalId: 'approval-pending-rule-test',
      digest,
      challenge: 'pending-rule-challenge',
    };
    store.database
      .prepare(`INSERT INTO activation_intents
        (id, kind, document, digest, effect, required_points, acquisition_scopes, status, approval_id, created_at, updated_at)
        VALUES (?, 'rule', ?, ?, '{}', '[]', '[]', 'pending', ?, ?, ?)`)
      .run(selector.activationId, canonicalJson(document), digest, selector.approvalId, NOW, NOW);
    store.database
      .prepare(
        `INSERT INTO activation_view_challenges (approval_id, state, origin, challenge_hash, expires_at, updated_at)
         VALUES (?, 'active', 'terminal', ?, NULL, ?)`,
      )
      .run(selector.approvalId, sha256Hex(selector.challenge), NOW);
    const versions = new ImmutableVersions(store.database);
    versions.createJudge(judge);
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 20_000, concurrency: 1 },
      providers: [],
    });
    versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
    store.database.exec(`
      INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
      VALUES ('judge-budget', 'judge-budget', 1, 'judge-budget@1', ${NOW}),
             ('judge-kind', 'local-endpoint', 1, 'judge-kind:local-endpoint@1', ${NOW});
    `);

    const verified = await verifyPendingRuleJudgeTestContext({
      database: store.database,
      selector,
      origin: 'terminal-approval',
      now: () => NOW,
      approvalView: async () => ({
        approvalId: selector.approvalId,
        digest,
        challenge: selector.challenge,
        expiresAt: Number.MAX_SAFE_INTEGER,
      }),
    });
    assert.deepEqual(verified, {
      activationId: selector.activationId,
      ruleId: selector.ruleId,
      ruleVersion: selector.ruleVersion,
      judge,
      question: document.rule.agentic.question,
      maxInputTokens: document.rule.agentic.maxInputTokens,
      maxOutputTokens: document.rule.agentic.maxOutputTokens,
      challenge: {
        approvalId: selector.approvalId,
        hash: sha256Hex(selector.challenge),
        origin: 'terminal',
        expiresAt: null,
      },
    });

    const requests: Buffer[] = [];
    const service = createOwnerB3ControlService({
      store,
      ports: {
        quiescer: new WriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
      config: { load: async () => ({ inboxes: {}, accounts: {} }) as never },
      activations: { issueApprovalViewChallenge: async () => null },
      cipher: { encrypt: async () => Buffer.alloc(0) },
      judgeTest: new JudgeTestControl({
        store,
        now: () => NOW,
        newId: () => 'pending-rule-judge-reservation',
        taint: { record: async () => undefined },
        transport: new JudgeTransport({ tcpConnect: async () => responseSocket(requests) as never }),
      }),
      now: () => NOW,
    });
    assert.deepEqual(await service.handle({ operation: 'judgeTest', args: selector, origin: 'terminal-approval' }), {
      kind: 'completed',
      judgeId: judge.judgeId,
      version: judge.version,
      value: 0.75,
      valueLabel: 'probability',
      reservationId: 'pending-rule-judge-reservation',
    });
    assert.equal(requests.length, 1, 'the terminal approval flow reaches the real fixed-input judge tester');
    assert.match(requests[0]?.toString('utf8') ?? '', /io\.agentcomms\.test\.v1/u);
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM judge_test_charges').get() as { count: number }).count,
      1,
      'the pending approval test consumes the ordinary exact-version ten-per-hour charge',
    );
    for (const origin of ['mcp', 'cli', 'events-cli', 'events-mcp'] as const) {
      await assert.rejects(
        () => service.handle({ operation: 'judgeTest', args: selector, origin }),
        /pending rule judge test|approval/i,
      );
    }
    assert.equal(requests.length, 1, 'ordinary CLI and MCP selectors are refused before a test can attempt network');

    store.database
      .prepare("UPDATE activation_view_challenges SET origin = 'view', expires_at = ? WHERE approval_id = ?")
      .run(NOW + 1, selector.approvalId);
    const expiringViewAuthority = await verifyPendingRuleJudgeTestContext({
      database: store.database,
      selector,
      origin: 'app-approval-screen',
      now: () => NOW,
      approvalView: async () => ({
        approvalId: selector.approvalId,
        digest,
        challenge: selector.challenge,
        expiresAt: NOW + 1,
      }),
    });
    let deadlineReads = 0;
    const deadlineResult = await new JudgeTestControl({
      store,
      now: () => (deadlineReads++ === 0 ? NOW : NOW + 1),
      newId: () => 'pending-rule-deadline-before-gate',
      taint: { record: async () => undefined },
      transport: new JudgeTransport({
        tcpConnect: async () => {
          throw new Error('an expired view challenge must release before TCP');
        },
      }),
    }).testPending(expiringViewAuthority);
    assert.deepEqual(
      deadlineResult,
      {
        kind: 'refused',
        judgeId: judge.judgeId,
        version: judge.version,
        code: 'JUDGE_AUTHORITY_CHANGED',
      },
      'a view challenge expiring between reservation and the final pre-I/O gate is refused',
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT state, concurrency_owned FROM judge_budget_reservations WHERE id = ?')
          .get('pending-rule-deadline-before-gate') as Record<string, unknown>),
      },
      { state: 'released', concurrency_owned: 0 },
      'the pre-I/O refusal commits its reservation release and frees the concurrency slot',
    );
    assert.equal(
      (
        store.database
          .prepare('SELECT COUNT(*) AS count FROM judge_budget_reservations WHERE concurrency_owned = 1')
          .get() as { count: number }
      ).count,
      0,
      'no synthetic judge reservation retains the only global concurrency slot after refusal',
    );
    store.database
      .prepare("UPDATE activation_view_challenges SET origin = 'terminal', expires_at = NULL WHERE approval_id = ?")
      .run(selector.approvalId);

    const pausedRequests: Buffer[] = [];
    let enteredTcp: (() => void) | undefined;
    const tcpEntered = new Promise<void>((resolve) => {
      enteredTcp = resolve;
    });
    let releaseTcp: ((socket: ReturnType<typeof responseSocket>) => void) | undefined;
    const pausedService = createOwnerB3ControlService({
      store,
      ports: {
        quiescer: new WriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
      config: { load: async () => ({ inboxes: {}, accounts: {} }) as never },
      activations: { issueApprovalViewChallenge: async () => null },
      cipher: { encrypt: async () => Buffer.alloc(0) },
      judgeTest: new JudgeTestControl({
        store,
        now: () => NOW,
        newId: () => 'pending-rule-judge-revoked-during-tcp',
        taint: { record: async () => undefined },
        transport: new JudgeTransport({
          tcpConnect: async () => {
            enteredTcp?.();
            return new Promise<ReturnType<typeof responseSocket>>((resolve) => {
              releaseTcp = resolve;
            }) as never;
          },
        }),
      }),
      now: () => NOW,
    });
    store.database
      .prepare("UPDATE activation_view_challenges SET origin = 'view', expires_at = ? WHERE approval_id = ?")
      .run(NOW + 1, selector.approvalId);
    const expiredWhileTcpWaits = pausedService.handle({
      operation: 'judgeTest',
      args: selector,
      origin: 'app-approval-screen',
    });
    await tcpEntered;
    store.database
      .prepare("UPDATE activation_view_challenges SET state = 'expired' WHERE approval_id = ?")
      .run(selector.approvalId);
    releaseTcp?.(responseSocket(pausedRequests));
    assert.deepEqual(await expiredWhileTcpWaits, {
      kind: 'deferred',
      judgeId: judge.judgeId,
      version: judge.version,
      code: 'NETWORK_FENCE_REFUSED',
      reservationId: 'pending-rule-judge-revoked-during-tcp',
    });
    assert.equal(pausedRequests.length, 0, 'an expired pending approval permits no later request byte');

    store.database
      .prepare("UPDATE activation_view_challenges SET state = 'active', expires_at = ? WHERE approval_id = ?")
      .run(NOW + 1, selector.approvalId);
    let revokedEnteredTcp: (() => void) | undefined;
    const revokedTcpEntered = new Promise<void>((resolve) => {
      revokedEnteredTcp = resolve;
    });
    let releaseRevokedTcp: ((socket: ReturnType<typeof responseSocket>) => void) | undefined;
    const revokedRequests: Buffer[] = [];
    const revokedService = createOwnerB3ControlService({
      store,
      ports: {
        quiescer: new WriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
      config: { load: async () => ({ inboxes: {}, accounts: {} }) as never },
      activations: { issueApprovalViewChallenge: async () => null },
      cipher: { encrypt: async () => Buffer.alloc(0) },
      judgeTest: new JudgeTestControl({
        store,
        now: () => NOW,
        newId: () => 'pending-rule-judge-revoked-authority-during-tcp',
        taint: { record: async () => undefined },
        transport: new JudgeTransport({
          tcpConnect: async () => {
            revokedEnteredTcp?.();
            return new Promise<ReturnType<typeof responseSocket>>((resolve) => {
              releaseRevokedTcp = resolve;
            }) as never;
          },
        }),
      }),
      now: () => NOW,
    });
    const revokedWhileTcpWaits = revokedService.handle({
      operation: 'judgeTest',
      args: selector,
      origin: 'app-approval-screen',
    });
    await revokedTcpEntered;
    store.database
      .prepare("UPDATE activation_intents SET status = 'cancelled' WHERE id = ?")
      .run(selector.activationId);
    releaseRevokedTcp?.(responseSocket(revokedRequests));
    assert.deepEqual(await revokedWhileTcpWaits, {
      kind: 'deferred',
      judgeId: judge.judgeId,
      version: judge.version,
      code: 'NETWORK_FENCE_REFUSED',
      reservationId: 'pending-rule-judge-revoked-authority-during-tcp',
    });
    assert.equal(revokedRequests.length, 0, 'a revoked pending approval permits no later request byte');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
