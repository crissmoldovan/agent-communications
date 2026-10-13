import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { type SecretStore, TaintStore } from '@agentcomms/core';
import { gmailMessageReceivedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { projectE9Doctor } from '../src/runtime/b3-doctor-projection.ts';
import { DryRunDispatcher } from '../src/runtime/dispatcher.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { JudgeCoordinator } from '../src/runtime/judge-coordinator.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { assertObjectSecretReady } from '../src/runtime/object-secret-readiness.ts';
import { type EventTaintRecorder, recordEventTaint } from '../src/runtime/untrusted.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

const NOW = 1_800_000_000_000;
const ACCOUNT = 'ibx_E13AAAAAAAAAAAA';
const RULE_ID = 'rule-e13-final';
const JUDGE_ID = 'judge-e13-final';
const TARGET_ID = 'target-e13-final';

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly #values = new Map<string, string>();

  async get(ref: string): Promise<string | null> {
    return this.#values.get(ref) ?? null;
  }

  async set(ref: string, value: string): Promise<void> {
    this.#values.set(ref, value);
  }

  async delete(ref: string): Promise<boolean> {
    return this.#values.delete(ref);
  }

  invalidate(): void {}
}

const target = { targetId: TARGET_ID, version: 1, kind: 'dry-run' as const, retentionMs: 60_000 };
const localJudge = {
  judgeId: JUDGE_ID,
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'e13-synthetic-model',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'] as const,
  promptTemplate: 'ollama-noul-v1',
  protocol: 'noul' as const,
};
const hostedJudge = {
  judgeId: 'judge-e13-hosted-missing-key',
  version: 1,
  kind: 'typesafe' as const,
  provider: 'typesafe',
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul' as const,
};

function rule(onUncertain: 'no-match' | 'hold') {
  return {
    ruleId: RULE_ID,
    version: 1,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received' as const, version: 1 },
    condition: { path: '/subject', op: 'exists' as const },
    agentic: {
      judge: localJudge,
      question: 'Does this synthetic message require attention?',
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain,
      callsPerRollingHour: 10,
      inputTokensPerRolling30Days: 10_000,
      concurrency: 1,
      maxInputTokens: 10_000,
      maxOutputTokens: 64,
    },
    mapping: { subject: { $path: '/subject' } },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention: {
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
  };
}

function lastingResources(): string[] {
  return process
    .getActiveResourcesInfo()
    .filter((name) => !/Req|^WriteWrap$|^ShutdownWrap$/u.test(name))
    .sort();
}

function response(value: number): Buffer {
  return Buffer.from(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"decision":{"type":"noul","noul":${value}}},"model":"e13-synthetic-model","usage":{"input_tokens":9,"output_tokens":1}}`,
  );
}

function respondingSocket(requests: Buffer[], value: number) {
  const listeners = new Map<string, (input?: Buffer | Error) => void>();
  return {
    write(bytes: Uint8Array) {
      requests.push(Buffer.from(bytes));
      queueMicrotask(() => {
        listeners.get('data')?.(response(value));
        listeners.get('end')?.();
      });
      return true;
    },
    destroy() {},
    once(event: string, listener: (input?: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
    on(event: string, listener: (input?: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
  };
}

async function fixture(onUncertain: 'no-match' | 'hold') {
  const stateDir = await shortTempDir('events-e13-final-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 13 WHERE singleton = 1');
  await selectEventSecretStore(store.database, 'file');
  const secrets = await openEventSecretStore({
    database: store.database,
    paths: store.paths,
    configDir: '/synthetic/config',
    stores: { file: new MemorySecretStore() },
  });
  const cipher = new EventRecordCipher(store.database, secrets, testWriterQuiescer());
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  versions.createJudge(localJudge);
  versions.createJudge(hostedJudge);
  versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 },
    providers: [{ provider: 'ollama', callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 }],
  });
  versions.createRule(rule(onUncertain));
  store.database.exec(
    `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-kind', 'local-endpoint', 1, 'kind-e13', ${NOW}),
              ('judge-budget', 'judge-budget', 1, 'budget-e13', ${NOW}),
              ('rule', '${RULE_ID}', 1, 'rule-e13', ${NOW});
     UPDATE rule_versions
        SET state = 'active', approval_id = 'approval-e13', authorization_activation_id = 'rule-e13', activated_at = ${NOW}
      WHERE rule_id = '${RULE_ID}' AND version = 1;`,
  );
  const event = {
    ...gmailMessageReceivedV1.examples[1],
    id: 'e13e13e13e13e13e13e13e13e13e13e1',
    account: { name: 'Synthetic', id: ACCOUNT, channel: 'gmail' as const },
    subject: 'Synthetic sender requests attention',
  };
  (
    store.database.prepare(
      `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, ?, 1, ?, 'e13', ?, ?, ?)`,
    ) as unknown as { run(...values: unknown[]): void }
  ).run(event.id, store.installationId, event.type, ACCOUNT, NOW, NOW, NOW);
  return { stateDir, store, secrets, cipher, event };
}

function exactRequestBody(request: Buffer): unknown {
  const boundary = request.indexOf('\r\n\r\n');
  assert.notEqual(boundary, -1, 'the sealed HTTP request has one header/body boundary');
  return JSON.parse(request.subarray(boundary + 4).toString('utf8')) as unknown;
}

async function evaluate(
  setup: Awaited<ReturnType<typeof fixture>>,
  value: number,
): Promise<{
  readonly requests: readonly Buffer[];
  readonly taint: readonly Parameters<EventTaintRecorder['record']>[0][];
}> {
  const requests: Buffer[] = [];
  const observed: Parameters<EventTaintRecorder['record']>[0][] = [];
  const taintStore = new TaintStore(setup.stateDir, () => new Date(NOW));
  const taint: EventTaintRecorder = {
    async record(input) {
      observed.push(input);
      await recordEventTaint(taintStore, { ownAddresses: [], internalDomains: [] }, input);
    },
  };
  let sequence = 0;
  const coordinator = new JudgeCoordinator({
    store: setup.store,
    now: () => NOW,
    newId: () => `reservation-e13-${++sequence}`,
    taint,
    transport: new JudgeTransport({ tcpConnect: async () => respondingSocket(requests, value) as never }),
  });
  const evaluator = new EventEvaluator({
    store: setup.store,
    cipher: setup.cipher,
    now: () => NOW,
    newId: () => `decision-e13-${++sequence}`,
    fence: async () => ({
      approvalId: 'approval-e13',
      authorizationActivationId: 'rule-e13',
      usedAt: 'now',
      switchGeneration: 13,
    }),
    taint,
    judgeCoordinator: coordinator,
  });
  assert.equal(
    await evaluator.admit({
      event: setup.event,
      eventId: setup.event.id,
      ruleId: RULE_ID,
      ruleVersion: 1,
      stagedAt: NOW,
    }),
    'terminal',
    'the active synthetic rule reaches one terminal decision',
  );
  return { requests, taint: observed };
}

async function reopenCount(stateDir: string, table: string): Promise<number> {
  const reopened = await openEventDatabase({ stateDir });
  try {
    return (reopened.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    reopened.close();
  }
}

test('E13 final E2E: an active matched rule uses exact taint and budget authority, delivers, purges and restarts cleanly', {
  skip: WINDOWS_SKIP,
}, async () => {
  const before = lastingResources();
  const setup = await fixture('no-match');
  try {
    const result = await evaluate(setup, 0.75);
    assert.equal(result.requests.length, 1, 'the sealed judge transport writes exactly one request');
    const body = exactRequestBody(result.requests[0] ?? Buffer.alloc(0)) as { readonly state?: unknown };
    assert.equal(typeof body.state, 'string', 'the sealed request carries the judge state as one typed string');
    assert.deepEqual(
      { ...body, state: JSON.parse(body.state as string) },
      {
        model: 'e13-synthetic-model',
        questions: {
          decision: { instructions: 'Does this synthetic message require attention?', type: 'noul' },
        },
        state: {
          inputs: [{ pointer: '/subject', value: 'Synthetic sender requests attention' }],
          version: 1,
        },
      },
      'the complete sealed body contains only the exact selected input and fixed judge envelope',
    );
    assert.deepEqual(
      result.taint,
      [
        {
          eventId: setup.event.id,
          accountId: ACCOUNT,
          classification: {
            untrusted: [{ pointer: '/inputs/0/value', text: 'Synthetic sender requests attention' }],
            addresses: [],
            handles: [],
          },
        },
        {
          eventId: setup.event.id,
          accountId: ACCOUNT,
          classification: {
            untrusted: [{ pointer: '/subject', text: 'Synthetic sender requests attention' }],
            addresses: [],
            handles: [],
          },
        },
      ],
      'judge input and delivery mapping flush only their complete exact event provenance',
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare('SELECT state, budget_version FROM judge_budget_reservations')
          .get() as object),
      },
      { state: 'settled', budget_version: 1 },
      'the call settles against the approved active budget pointer',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string }).outcome,
      'matched',
      'the bounded answer becomes a matched decision',
    );
    const delivery = setup.store.database.prepare('SELECT id FROM deliveries').get() as { id: string };
    const dispatcher = new DryRunDispatcher({
      store: setup.store,
      cipher: setup.cipher,
      approvals: { get: async () => null },
      config: {
        load: async () => ({ inboxes: { synthetic: { id: ACCOUNT, provider: 'gmail' } }, accounts: {} }),
      } as never,
      now: () => NOW,
      fence: async () => undefined,
    });
    assert.deepEqual(
      await dispatcher.dispatch(delivery.id),
      { state: 'delivered', deliveryId: delivery.id },
      'the matched record reaches its approved local dry-run target',
    );
    new EventExpiry(setup.store, () => NOW + 120_000).sweep();
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM dryrun_log').get() as { count: number }).count,
      0,
      'the delivery retention sweep purges retained judge-derived target content',
    );
  } finally {
    setup.store.close();
  }
  try {
    assert.equal(
      await reopenCount(setup.stateDir, 'dryrun_log'),
      0,
      'purged target content stays absent after restart',
    );
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lastingResources(), before, 'the final matched path leaks no lasting process resource');
});

test('E13 final E2E: no-match purges its projection and remains terminal after restart', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture('no-match');
  try {
    await evaluate(setup, 0.2);
    assert.equal(
      (setup.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string }).outcome,
      'no-match',
      'a bounded below-threshold score becomes no-match',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM deliveries').get() as { count: number }).count,
      0,
      'no-match creates no delivery',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
      'no-match purges the encrypted projection',
    );
  } finally {
    setup.store.close();
  }
  try {
    assert.equal(
      await reopenCount(setup.stateDir, 'ingest_rules'),
      0,
      'the purged projection stays absent after restart',
    );
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E13 final E2E: hold exposes its retention clock, survives restart, and kind disable purges it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture('hold');
  try {
    await evaluate(setup, 0.45);
    const held = setup.store.database
      .prepare('SELECT outcome, hold_created_at, hold_expires_at FROM decisions')
      .get() as {
      outcome: string;
      hold_created_at: number;
      hold_expires_at: number;
    };
    assert.deepEqual(
      {
        outcome: held.outcome,
        hasCreatedAt: Number.isSafeInteger(held.hold_created_at),
        retentionMs: held.hold_expires_at - held.hold_created_at,
      },
      { outcome: 'hold', hasCreatedAt: true, retentionMs: 60_000 },
      'an uncertain hold is durable with its complete retention clock',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM ingest_rules').get() as { count: number }).count,
      1,
      'a held decision retains its projection',
    );
  } finally {
    setup.store.close();
  }
  const reopened = await openEventDatabase({ stateDir: setup.stateDir });
  try {
    assert.equal(
      (
        reopened.database.prepare("SELECT count(*) AS count FROM decisions WHERE outcome = 'hold'").get() as {
          count: number;
        }
      ).count,
      1,
      'the held decision survives restart',
    );
    new JudgeKinds({ store: reopened, now: () => NOW + 1 }).disable('local-endpoint');
    assert.deepEqual(
      {
        ...(reopened.database.prepare('SELECT outcome, encrypted_record FROM decisions').get() as object),
      },
      { outcome: 'cancelled', encrypted_record: null },
      'disabling the kind terminalises the held decision and purges its content',
    );
    assert.equal(
      (reopened.database.prepare('SELECT count(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
      'disabling the kind purges the held projection',
    );
  } finally {
    reopened.close();
  }
  try {
    const final = await openEventDatabase({ stateDir: setup.stateDir });
    try {
      assert.deepEqual(
        { ...(final.database.prepare('SELECT outcome, encrypted_record FROM decisions').get() as object) },
        { outcome: 'cancelled', encrypted_record: null },
        'the content-free cancelled hold remains terminal after restart',
      );
    } finally {
      final.close();
    }
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E13 final doctor reports kind, budget, reservations, hold clocks, a missing key and typed Laya unavailability', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture('hold');
  try {
    await evaluate(setup, 0.45);
    const report = await projectE9Doctor({
      database: setup.store.database,
      installationId: setup.store.installationId,
      lifecycle: { enabled: true, paused: false, switchGeneration: 13 },
      protocolVersions: [1],
      ports: {
        assertObjectSecretReady: ({
          owner,
        }: {
          readonly owner: {
            readonly kind: 'target' | 'subscriber' | 'judge';
            readonly id: string;
            readonly version: number;
          };
        }) =>
          assertObjectSecretReady({
            database: setup.store.database,
            secrets: setup.secrets,
            cipher: setup.cipher,
            owner,
          }),
      } as never,
      config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
      approvals: { get: async () => null } as never,
      decryptSourceState: async () => null,
      now: () => NOW,
    });
    assert.deepEqual(
      report.judge.kinds,
      [
        { kind: 'typesafe', state: 'disabled', version: null },
        { kind: 'laya', state: 'unavailable', code: 'E2_REQUIRED' },
        { kind: 'local-endpoint', state: 'enabled', version: 1 },
      ],
      'doctor exposes the exact kind pointer state and typed Laya E2 boundary',
    );
    assert.deepEqual(report.judge.budget, { activeVersion: 1 }, 'doctor exposes the active budget pointer');
    assert.deepEqual(
      report.judge.reservations,
      [{ state: 'settled', count: 1 }],
      'doctor exposes only content-free reservation counts',
    );
    const held = setup.store.database.prepare('SELECT hold_created_at, hold_expires_at FROM decisions').get() as {
      hold_created_at: number;
      hold_expires_at: number;
    };
    assert.deepEqual(
      report.judge.holds,
      { count: 1, oldestCreatedAt: held.hold_created_at, nextExpiresAt: held.hold_expires_at },
      'doctor exposes the content-free hold count and retention clock',
    );
    assert.deepEqual(
      report.recovery.missingSecrets,
      [{ kind: 'judge', id: hostedJudge.judgeId, version: 1 }],
      'doctor identifies the real missing hosted judge-key slot without exposing secret material',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E13 release gate: every judge kind remains unusable until a person-approved enablement creates its pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e13-release-gate-');
  const store = await openEventDatabase({ stateDir });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createJudgeKind({
      id: 'judge-kind:typesafe',
      kind: 'typesafe',
      version: 1,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
    });
    versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
    for (const kind of ['typesafe', 'local-endpoint', 'laya'] as const)
      assert.equal(
        versions.activeVersion('judge-kind', kind),
        null,
        `${kind} cannot be used before an approved enablement writes its active pointer`,
      );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
