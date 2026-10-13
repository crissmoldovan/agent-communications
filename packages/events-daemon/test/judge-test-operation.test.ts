import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { JudgeTestControl } from '../src/runtime/judge-test.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const now = 1_800_000_000_000;
const judge = {
  judgeId: 'judge-e9-test',
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'judge-test-model',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'] as const,
  promptTemplate: 'judge-test-v1',
  protocol: 'noul' as const,
};
const target = { targetId: 'target-e9-test', version: 1, kind: 'dry-run' as const, retentionMs: 60_000 };

function responseSocket(requests: Buffer[]) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  return {
    write(bytes: Uint8Array) {
      requests.push(Buffer.from(bytes));
      queueMicrotask(() => {
        listeners.get('data')?.(
          Buffer.from(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"judge-test":{"type":"noul","noul":0.75}},"model":"judge-test-model","usage":{"input_tokens":3,"output_tokens":2}}',
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

test('E9 judge test: the fixed synthetic input is tainted, globally reserved and sent through the sealed transport', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e9-judge-test-');
  const store = await openEventDatabase({ stateDir });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createJudge(judge);
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 20_000, concurrency: 1 },
      providers: [],
    });
    versions.createJudgeKind({
      id: 'judge-kind:local-endpoint',
      kind: 'local-endpoint',
      version: 1,
    });
    versions.createRule({
      ruleId: 'rule-e9-test',
      version: 1,
      source: {
        channel: 'gmail',
        accountIds: ['ibx_E9TEST'],
        options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/subject', op: 'exists' },
      agentic: {
        judge,
        question: 'Score the fixed synthetic event.',
        inputs: ['/subject'],
        threshold: 0.5,
        onUncertain: 'no-match',
        callsPerRollingHour: 1,
        inputTokensPerRolling30Days: 1,
        concurrency: 1,
        maxInputTokens: 20_000,
        maxOutputTokens: 512,
      },
      mapping: { constant: 'safe' },
      targets: [target],
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
    });
    store.database.exec(`
      UPDATE rule_versions
         SET state = 'active', approval_id = 'approval-e9-test', authorization_activation_id = 'activation-e9-test', activated_at = ${now}
       WHERE rule_id = 'rule-e9-test' AND version = 1;
      INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
      VALUES ('judge-budget', 'judge-budget', 1, 'judge-budget@1', ${now}),
             ('judge-kind', 'local-endpoint', 1, 'judge-kind:local-endpoint@1', ${now}),
             ('rule', 'rule-e9-test', 1, 'rule-e9-test@1', ${now});
    `);
    const taint: unknown[] = [];
    const requests: Buffer[] = [];
    const result = await new JudgeTestControl({
      store,
      now: () => now,
      newId: () => 'judge-test-reservation',
      taint: { record: async (input) => void taint.push(input) },
      transport: new JudgeTransport({ tcpConnect: async () => responseSocket(requests) as never }),
    }).test({ judgeId: judge.judgeId, version: judge.version });

    assert.deepEqual(result, {
      kind: 'completed',
      judgeId: judge.judgeId,
      version: judge.version,
      value: 0.75,
      valueLabel: 'probability',
      reservationId: 'judge-test-reservation',
    });
    assert.equal(taint.length, 1, 'the fixed input takes the ordinary taint-before-reservation path');
    assert.equal(requests.length, 1, 'only the sealed local loopback transport receives a request');
    assert.match(requests[0]?.toString('utf8') ?? '', /io\.agentcomms\.test\.v1/u);
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM judge_test_charges').get() as { count: number }).count,
      1,
      'the exact immutable judge version receives one unrefundable test charge',
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT state, provider, actual_input_tokens FROM judge_budget_reservations')
          .get() as { state: string; provider: string | null; actual_input_tokens: number | null }),
      },
      { state: 'settled', provider: null, actual_input_tokens: 3 },
      'synthetic tests settle through the global-only reservation ledger',
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            'SELECT test_authority_rule_id, test_authority_rule_version, test_authority_activation_id FROM judge_budget_reservations WHERE id = ?',
          )
          .get('judge-test-reservation') as object),
      },
      {
        test_authority_rule_id: 'rule-e9-test',
        test_authority_rule_version: 1,
        test_authority_activation_id: null,
      },
      'the synthetic reservation durably binds its exact active rule authority for every later transport gate',
    );
    const revokedRequests: Buffer[] = [];
    let enteredTcp: (() => void) | undefined;
    const tcpEntered = new Promise<void>((resolve) => {
      enteredTcp = resolve;
    });
    let releaseTcp: ((socket: ReturnType<typeof responseSocket>) => void) | undefined;
    const pausedTransport = new JudgeTransport({
      tcpConnect: async () => {
        enteredTcp?.();
        return new Promise<ReturnType<typeof responseSocket>>((resolve) => {
          releaseTcp = resolve;
        }) as never;
      },
    });
    const revokedWhileTcpWaits = new JudgeTestControl({
      store,
      now: () => now,
      newId: () => 'judge-test-revoked-during-tcp',
      taint: { record: async () => undefined },
      transport: pausedTransport,
    }).test({ judgeId: judge.judgeId, version: judge.version });
    await tcpEntered;
    store.database.exec(`
      DELETE FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-e9-test' AND version = 1;
      UPDATE rule_versions SET state = 'revoked' WHERE rule_id = 'rule-e9-test' AND version = 1;
    `);
    releaseTcp?.(responseSocket(revokedRequests));
    assert.deepEqual(await revokedWhileTcpWaits, {
      kind: 'deferred',
      judgeId: judge.judgeId,
      version: judge.version,
      code: 'NETWORK_FENCE_REFUSED',
      reservationId: 'judge-test-revoked-during-tcp',
    });
    assert.equal(revokedRequests.length, 0, 'revoking the only authorising rule during TCP blocks every later byte');
    const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() }, now: () => now + 1 });
    assert.deepEqual(await control.handle({ operation: 'removeJudge', args: { judgeId: judge.judgeId } }), {
      judgeId: judge.judgeId,
      removed: true,
    });
    assert.equal(
      (
        store.database
          .prepare('SELECT state FROM rule_versions WHERE rule_id = ? AND version = ?')
          .get('rule-e9-test', 1) as { state: string }
      ).state,
      'revoked',
      'judge revocation delegates rule work to the shared purge closure',
    );
    assert.equal(
      (
        store.database
          .prepare("SELECT count(*) AS count FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-e9-test'")
          .get() as { count: number }
      ).count,
      0,
      'a rule bound to a revoked immutable judge has no live pointer',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E9 judge test: an unapproved exact version reaches neither taint nor network', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e9-judge-test-refused-');
  const store = await openEventDatabase({ stateDir });
  try {
    const taint: unknown[] = [];
    let connections = 0;
    const result = await new JudgeTestControl({
      store,
      taint: { record: async (input) => void taint.push(input) },
      transport: new JudgeTransport({
        tcpConnect: async () => {
          connections += 1;
          throw new Error('the unapproved test must not reach transport');
        },
      }),
    }).test({ judgeId: judge.judgeId, version: judge.version });
    assert.deepEqual(result, {
      kind: 'refused',
      judgeId: judge.judgeId,
      version: judge.version,
      code: 'JUDGE_AUTHORITY_CHANGED',
    });
    assert.equal(taint.length, 0, 'a missing active exact rule is refused before the ordinary taint write');
    assert.equal(connections, 0, 'an unapproved judge test has zero network attempts');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
