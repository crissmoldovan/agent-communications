import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type SecretStore, TaintStore } from '@agentcomms/core';
import { gmailMessageReceivedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { buildJudgeInput, JudgeCoordinator } from '../src/runtime/judge-coordinator.ts';
import { recoverJudgeWork } from '../src/runtime/judge-recovery.ts';
import { buildJudgeWireRequest, JudgeTransport, prepareJudgeTransportRequest } from '../src/runtime/judge-transport.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { type EventTaintRecorder, recordEventTaint } from '../src/runtime/untrusted.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

const ACCOUNT = 'ibx_E7COORDINATOR';
const NOW = 1_800_000_000_000;

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

const target = { targetId: 'target-e7', version: 1, kind: 'dry-run' as const, retentionMs: 60_000 };
const retention = () => ({
  ingestMs: 60_000,
  holdMs: 60_000,
  deliveryMs: 60_000,
  dryrunMs: 60_000,
  sseReplayMs: 60_000,
  deadLetterMs: 60_000,
  decisionMetadataMs: 60_000,
});
function judge(port: number) {
  return {
    judgeId: 'judge-e7',
    version: 1,
    kind: 'local-endpoint' as const,
    provider: 'ollama',
    model: 'nimble',
    endpoint: `http://127.0.0.1:${port}/v1/systemone`,
    approvedAddressSet: ['127.0.0.1'] as const,
    promptTemplate: 'ollama-noul-v1',
    protocol: 'noul' as const,
  };
}
function rule(
  port: number,
  condition: unknown = { path: '/subject', op: 'exists' },
  agenticOptions: Readonly<{
    threshold?: number;
    onUncertain?: 'no-match' | 'hold';
    maxInputTokens?: number;
    maxOutputTokens?: number;
  }> = {},
) {
  const judgeDocument = judge(port);
  return {
    ruleId: 'rule-e7',
    version: 1,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition,
    agentic: {
      judge: judgeDocument,
      question: 'Does this synthetic message require attention?',
      inputs: ['/subject'],
      threshold: agenticOptions.threshold ?? 0.5,
      onUncertain: agenticOptions.onUncertain ?? 'no-match',
      callsPerRollingHour: 10,
      inputTokensPerRolling30Days: 10_000,
      concurrency: 1,
      maxInputTokens: agenticOptions.maxInputTokens ?? 10_000,
      maxOutputTokens: agenticOptions.maxOutputTokens ?? 64,
    },
    mapping: { subject: { $path: '/subject' } },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention: retention(),
  };
}
async function fixture(
  port: number,
  condition?: unknown,
  agenticOptions?: Readonly<{
    threshold?: number;
    onUncertain?: 'no-match' | 'hold';
    maxInputTokens?: number;
    maxOutputTokens?: number;
  }>,
) {
  const stateDir = await shortTempDir('events-e7-evaluation-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7 WHERE singleton = 1');
  await selectEventSecretStore(store.database, 'file');
  const secrets = await openEventSecretStore({
    database: store.database,
    paths: store.paths,
    configDir: '/srv/config',
    stores: { file: new MemorySecretStore() },
  });
  const cipher = new EventRecordCipher(store.database, secrets, testWriterQuiescer());
  const versions = new ImmutableVersions(store.database);
  const judgeDocument = judge(port);
  const ruleDocument = rule(port, condition, agenticOptions);
  versions.createTarget(target);
  versions.createJudge(judgeDocument);
  versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 },
    providers: [{ provider: 'ollama', callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 }],
  });
  versions.createRule(ruleDocument);
  store.database.exec(
    `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-kind', 'local-endpoint', 1, 'kind-e7', ${NOW}); INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, 'budget-e7', ${NOW}); UPDATE rule_versions SET state = 'active', approval_id = 'approval', authorization_activation_id = 'activation', activated_at = ${NOW} WHERE rule_id = 'rule-e7' AND version = 1;`,
  );
  const event = {
    ...gmailMessageReceivedV1.examples[1],
    id: 'e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7',
    account: { name: 'Synthetic', id: ACCOUNT, channel: 'gmail' as const },
    subject: 'sender@example.test requests attention',
    from: { address: 'sender@example.test', name: 'Synthetic Sender' },
  };
  (
    store.database.prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, 'e7', ?, ?, ?)`,
    ) as unknown as { run(...values: unknown[]): void }
  ).run(event.id, store.installationId, event.type, ACCOUNT, NOW, NOW, NOW);
  return { stateDir, store, cipher, event };
}
const fence = async () => ({
  approvalId: 'approval',
  authorizationActivationId: 'activation',
  usedAt: 'now',
  switchGeneration: 7,
});
function response(value: number, outputTokens = 1): Buffer {
  return Buffer.from(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"decision":{"type":"noul","noul":${value}}},"model":"nimble","usage":{"input_tokens":9,"output_tokens":${outputTokens}}}`,
  );
}
function respondingSocket(requests: Buffer[], responseBytes = response(0.75)) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  return {
    write(bytes: Uint8Array) {
      requests.push(Buffer.from(bytes));
      queueMicrotask(() => {
        listeners.get('data')?.(responseBytes);
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

function hangingSocket(requests: Buffer[]) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  return {
    write(bytes: Uint8Array) {
      requests.push(Buffer.from(bytes));
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

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => (resolve = next)), resolve };
}

function blockedResponseSocket(requests: Buffer[]) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  const wrote = deferred<void>();
  return {
    wrote: wrote.promise,
    respond(responseBytes: Buffer) {
      listeners.get('data')?.(responseBytes);
      listeners.get('end')?.();
    },
    socket: {
      write(bytes: Uint8Array) {
        requests.push(Buffer.from(bytes));
        wrote.resolve();
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
    },
  };
}

function productionTaintRecorder(
  stateDir: string,
  observed?: EventTaintRecorder['record'] extends (input: infer Input) => Promise<void> ? Input[] : never,
  root = stateDir,
): EventTaintRecorder {
  const store = new TaintStore(root, () => new Date(NOW));
  return {
    async record(input) {
      observed?.push(input);
      await recordEventTaint(store, { ownAddresses: [], internalDomains: [] }, input);
    },
  };
}

function evaluatorFor(
  setup: Awaited<ReturnType<typeof fixture>>,
  transport: JudgeTransport,
  taint: EventTaintRecorder,
) {
  let sequence = 0;
  const coordinator = new JudgeCoordinator({
    store: setup.store,
    now: () => NOW,
    newId: () => `reservation-scenario-${++sequence}`,
    taint,
    transport,
  });
  return new EventEvaluator({
    store: setup.store,
    cipher: setup.cipher,
    now: () => NOW,
    newId: () => `decision-scenario-${++sequence}`,
    fence,
    taint,
    judgeCoordinator: coordinator,
  });
}

test('E7: deterministic false creates no judge provenance, taint, reservation, or request bytes', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture(11434, { path: '/subject', op: 'equals', value: 'does not match', caseSensitive: false });
  try {
    const observed: Parameters<EventTaintRecorder['record']>[0][] = [];
    const taint = productionTaintRecorder(setup.stateDir, observed);
    const evaluator = new EventEvaluator({ store: setup.store, cipher: setup.cipher, now: () => NOW, fence, taint });
    assert.equal(
      await evaluator.admit({
        event: setup.event,
        eventId: setup.event.id,
        ruleId: 'rule-e7',
        ruleVersion: 1,
        stagedAt: NOW,
      }),
      'terminal',
    );
    assert.equal(observed.length, 0);
    for (const table of ['judge_budget_reservations', 'deliveries'] as const)
      assert.equal(
        (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        0,
      );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E7: evaluator taints exact judge input, reserves, uses sealed transport, and atomically commits a matched decision', {
  skip: WINDOWS_SKIP,
}, async () => {
  const requests: Buffer[] = [];
  const setup = await fixture(11434);
  try {
    const taintInputs: Parameters<EventTaintRecorder['record']>[0][] = [];
    let sequence = 0;
    const taint = productionTaintRecorder(setup.stateDir, taintInputs);
    const coordinator = new JudgeCoordinator({
      store: setup.store,
      now: () => NOW,
      newId: () => `reservation-${++sequence}`,
      taint,
      transport: new JudgeTransport({ tcpConnect: async () => respondingSocket(requests) as never }),
    });
    const evaluator = new EventEvaluator({
      store: setup.store,
      cipher: setup.cipher,
      now: () => NOW,
      newId: () => `decision-${++sequence}`,
      fence,
      taint,
      judgeCoordinator: coordinator,
    });
    assert.equal(
      await evaluator.admit({
        event: setup.event,
        eventId: setup.event.id,
        ruleId: 'rule-e7',
        ruleVersion: 1,
        stagedAt: NOW,
      }),
      'terminal',
    );
    assert.equal(requests.length, 1);
    assert.equal(
      taintInputs.length,
      2,
      'the judge envelope and the final delivery mapping each flush their own provenance',
    );
    const reservation = setup.store.database
      .prepare('SELECT state, actual_input_tokens, concurrency_owned FROM judge_budget_reservations')
      .get() as { state: string; actual_input_tokens: number; concurrency_owned: number };
    assert.equal(reservation.state, 'settled');
    assert.equal(reservation.actual_input_tokens, 9);
    assert.equal(reservation.concurrency_owned, 0);
    const decision = setup.store.database.prepare('SELECT outcome, encrypted_record FROM decisions').get() as {
      outcome: string;
      encrypted_record: Uint8Array;
    };
    assert.equal(decision.outcome, 'matched');
    assert.ok(decision.encrypted_record instanceof Uint8Array);
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E7: pause fences reserved judge I/O and completed-response decision writes', { skip: WINDOWS_SKIP }, async () => {
  {
    const requests: Buffer[] = [];
    const setup = await fixture(11434);
    try {
      const lifecycle = new EventLifecycle(setup.store, () => NOW);
      class PausingTransport extends JudgeTransport {
        override async execute(...input: Parameters<JudgeTransport['execute']>) {
          await lifecycle.pause();
          return super.execute(...input);
        }
      }
      const evaluator = evaluatorFor(
        setup,
        new PausingTransport({ tcpConnect: async () => respondingSocket(requests) as never }),
        productionTaintRecorder(setup.stateDir),
      );
      assert.equal(
        await evaluator.admit({
          event: setup.event,
          eventId: setup.event.id,
          ruleId: 'rule-e7',
          ruleVersion: 1,
          stagedAt: NOW,
        }),
        'pending',
      );
      assert.equal(requests.length, 0, 'the pause wins before the first physical transport action');
      assert.deepEqual(
        {
          ...(setup.store.database
            .prepare('SELECT state, concurrency_owned FROM judge_budget_reservations')
            .get() as object),
        },
        { state: 'released', concurrency_owned: 0 },
      );
      assert.equal(
        (setup.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
        1,
      );
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  }

  {
    const requests: Buffer[] = [];
    const setup = await fixture(11434);
    try {
      const lifecycle = new EventLifecycle(setup.store, () => NOW);
      const taintStore = new TaintStore(setup.stateDir, () => new Date(NOW));
      let taintWrites = 0;
      const taint: EventTaintRecorder = {
        async record(input) {
          await recordEventTaint(taintStore, { ownAddresses: [], internalDomains: [] }, input);
          taintWrites += 1;
          if (taintWrites === 2) await lifecycle.pause();
        },
      };
      const evaluator = evaluatorFor(
        setup,
        new JudgeTransport({ tcpConnect: async () => respondingSocket(requests) as never }),
        taint,
      );
      assert.equal(
        await evaluator.admit({
          event: setup.event,
          eventId: setup.event.id,
          ruleId: 'rule-e7',
          ruleVersion: 1,
          stagedAt: NOW,
        }),
        'pending',
      );
      assert.equal(requests.length, 1, 'the response existed before the operational pause');
      assert.equal(
        (setup.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (setup.store.database.prepare('SELECT state FROM judge_budget_reservations').get() as { state: string }).state,
        'in-flight',
        'a response that crossed I/O remains Task-5 recovery work rather than being released as free',
      );
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  }
});

test('E7: admission reserves the full HTTP request before transport can refuse it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const requests: Buffer[] = [];
  const shape = await fixture(11434);
  let maxInputTokens = 0;
  try {
    const ruleDocument = rule(11434);
    const envelope = buildJudgeInput(ruleDocument as never, shape.event);
    assert.ok(envelope);
    const wire = buildJudgeWireRequest({
      adapter: 'ollama',
      model: 'nimble',
      state: envelope.state,
      questionName: 'decision',
      instructions: 'Does this synthetic message require attention?',
    });
    const prepared = prepareJudgeTransportRequest({
      judge: ruleDocument.agentic.judge,
      state: envelope.state,
      questionName: 'decision',
      instructions: 'Does this synthetic message require attention?',
      maxInputTokens: 10_000,
      maxOutputTokens: 64,
    });
    if (!('request' in prepared)) throw new Error('synthetic request preparation refused');
    maxInputTokens = Math.floor((wire.body.byteLength + prepared.request.byteLength) / 2);
    assert.ok(
      wire.body.byteLength < maxInputTokens && maxInputTokens < prepared.request.byteLength,
      'the approved ceiling sits strictly between the body and the full HTTP request',
    );
  } finally {
    shape.store.close();
    await rm(shape.stateDir, { recursive: true, force: true });
  }

  const setup = await fixture(11434, undefined, { maxInputTokens });
  try {
    const evaluator = evaluatorFor(
      setup,
      new JudgeTransport({ tcpConnect: async () => respondingSocket(requests) as never }),
      productionTaintRecorder(setup.stateDir),
    );
    assert.equal(
      await evaluator.admit({
        event: setup.event,
        eventId: setup.event.id,
        ruleId: 'rule-e7',
        ruleVersion: 1,
        stagedAt: NOW,
      }),
      'terminal',
    );
    assert.equal(requests.length, 0, 'an input that cannot reserve the complete request never reaches the socket');
    assert.equal(
      (
        setup.store.database.prepare('SELECT COUNT(*) AS count FROM judge_budget_reservations').get() as {
          count: number;
        }
      ).count,
      0,
      'a rejected full request creates no in-flight or charged reservation',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string }).outcome,
      'no-match',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E7: a concurrent evaluation leaves a live judge work item to its one decision owner', {
  skip: WINDOWS_SKIP,
}, async () => {
  const requests: Buffer[] = [];
  const setup = await fixture(11434);
  const blocked = blockedResponseSocket(requests);
  let first: Promise<'terminal' | 'pending'> | undefined;
  try {
    const taint = productionTaintRecorder(setup.stateDir);
    const evaluator = evaluatorFor(
      setup,
      new JudgeTransport({ tcpConnect: async () => blocked.socket as never }),
      taint,
    );
    first = evaluator.admit({
      event: setup.event,
      eventId: setup.event.id,
      ruleId: 'rule-e7',
      ruleVersion: 1,
      stagedAt: NOW,
    });
    await blocked.wrote;
    assert.equal(
      await evaluator.evaluate({ eventId: setup.event.id, ruleId: 'rule-e7', ruleVersion: 1 }),
      'pending',
      "the contender must not terminalise or purge its owner's work",
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      1,
    );
    assert.equal(requests.length, 1, 'the contender cannot start a second transport');
    blocked.respond(response(0.75));
    assert.equal(await first, 'terminal');
    assert.deepEqual(
      {
        ...(setup.store.database.prepare('SELECT outcome FROM decisions').get() as object),
      },
      { outcome: 'matched' },
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      1,
    );
  } finally {
    blocked.respond(response(0.75));
    await first?.catch(() => undefined);
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E7: a post-I/O decision failpoint recovers once as content-free judge-io-unknown without a second transport', {
  skip: WINDOWS_SKIP,
}, async () => {
  const requests: Buffer[] = [];
  const setup = await fixture(11434);
  try {
    let sequence = 0;
    const taint = productionTaintRecorder(setup.stateDir);
    const coordinator = new JudgeCoordinator({
      store: setup.store,
      now: () => NOW,
      newId: () => `reservation-crash-${++sequence}`,
      taint,
      transport: new JudgeTransport({ tcpConnect: async () => respondingSocket(requests) as never }),
    });
    const evaluator = new EventEvaluator({
      store: setup.store,
      cipher: setup.cipher,
      now: () => NOW,
      newId: () => `decision-crash-${++sequence}`,
      fence,
      taint,
      judgeCoordinator: coordinator,
      failpoint: (point) => {
        if (point === 'after-decision') throw new Error('crash after decision');
      },
    });
    await assert.rejects(
      evaluator.admit({
        event: setup.event,
        eventId: setup.event.id,
        ruleId: 'rule-e7',
        ruleVersion: 1,
        stagedAt: NOW,
      }),
      /crash after decision/u,
    );
    assert.equal(requests.length, 1);
    setup.store.immediate(() => recoverJudgeWork({ database: setup.store.database, now: NOW + 1 }));
    setup.store.immediate(() => recoverJudgeWork({ database: setup.store.database, now: NOW + 2 }));
    assert.equal(requests.length, 1, 'recovery terminalises the in-flight reservation instead of re-asking');
    assert.equal(await evaluator.evaluate({ eventId: setup.event.id, ruleId: 'rule-e7', ruleVersion: 1 }), 'terminal');
    assert.equal(requests.length, 1, 'a retry observes the durable terminal decision and never re-asks');
    const recovered = setup.store.database.prepare('SELECT outcome, metadata_state FROM decisions').get() as {
      outcome: string;
      metadata_state: string;
    };
    assert.equal(recovered.outcome, 'no-match');
    assert.equal(recovered.metadata_state, 'judge-io-unknown');
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E7: every post-I/O atomic-decision failpoint recovers one charge, one terminal and no retry', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  for (const point of [
    'after-settlement',
    'after-decision',
    'after-delivery',
    'after-projection-purge',
    'before-commit',
  ] as const) {
    await context.test(point, async () => {
      const requests: Buffer[] = [];
      const setup = await fixture(11434);
      try {
        let sequence = 0;
        const taint = productionTaintRecorder(setup.stateDir);
        const coordinator = new JudgeCoordinator({
          store: setup.store,
          now: () => NOW,
          newId: () => `reservation-atomic-${++sequence}`,
          taint,
          transport: new JudgeTransport({ tcpConnect: async () => respondingSocket(requests) as never }),
        });
        const evaluator = new EventEvaluator({
          store: setup.store,
          cipher: setup.cipher,
          now: () => NOW,
          newId: () => `decision-atomic-${++sequence}`,
          fence,
          taint,
          judgeCoordinator: coordinator,
          failpoint: (at) => {
            if (at === point) throw new Error(`crash ${point}`);
          },
        });
        await assert.rejects(
          evaluator.admit({
            event: setup.event,
            eventId: setup.event.id,
            ruleId: 'rule-e7',
            ruleVersion: 1,
            stagedAt: NOW,
          }),
          new RegExp(`crash ${point}`, 'u'),
        );
        assert.equal(requests.length, 1);
        assert.equal(
          (setup.store.database.prepare('SELECT state FROM judge_budget_reservations').get() as { state: string })
            .state,
          'in-flight',
          'the failed transaction cannot erase post-I/O uncertainty',
        );
        setup.store.immediate(() => recoverJudgeWork({ database: setup.store.database, now: NOW + 1 }));
        setup.store.immediate(() => recoverJudgeWork({ database: setup.store.database, now: NOW + 2 }));
        assert.equal(
          (setup.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
          1,
        );
        assert.equal(
          (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
          0,
        );
        assert.equal(
          (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
          0,
        );
        assert.equal(
          await evaluator.evaluate({ eventId: setup.event.id, ruleId: 'rule-e7', ruleVersion: 1 }),
          'terminal',
        );
        assert.equal(requests.length, 1, 'a recovery terminal is final and must never re-ask');
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('E7: a failed taint flush emits zero judge bytes and leaves no reservation', { skip: WINDOWS_SKIP }, async () => {
  const requests: Buffer[] = [];
  const setup = await fixture(11434);
  try {
    const blocked = join(setup.stateDir, 'taint-blocked');
    await writeFile(blocked, 'not a directory');
    const evaluator = evaluatorFor(
      setup,
      new JudgeTransport({ tcpConnect: async () => respondingSocket(requests) as never }),
      productionTaintRecorder(setup.stateDir, undefined, blocked),
    );
    await assert.rejects(
      evaluator.admit({
        event: setup.event,
        eventId: setup.event.id,
        ruleId: 'rule-e7',
        ruleVersion: 1,
        stagedAt: NOW,
      }),
      /ENOTDIR|not a directory/u,
    );
    assert.equal(requests.length, 0);
    assert.equal(
      (
        setup.store.database.prepare('SELECT COUNT(*) AS count FROM judge_budget_reservations').get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E7: no-match, uncertain no-match and hold are durable derived outcomes with no stray delivery', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  const scenarios: readonly [string, number, 'no-match' | 'hold', 'no-match' | 'hold', number][] = [
    ['no-match', 0.2, 'no-match', 'no-match', 0],
    ['uncertain no-match', 0.45, 'no-match', 'no-match', 0],
    ['uncertain hold', 0.45, 'hold', 'hold', 1],
  ];
  for (const [name, value, onUncertain, expectedOutcome, expectedPurged] of scenarios) {
    await context.test(name, async () => {
      const requests: Buffer[] = [];
      const setup = await fixture(11434, undefined, { onUncertain });
      try {
        const evaluator = evaluatorFor(
          setup,
          new JudgeTransport({ tcpConnect: async () => respondingSocket(requests, response(value)) as never }),
          productionTaintRecorder(setup.stateDir),
        );
        assert.equal(
          await evaluator.admit({
            event: setup.event,
            eventId: setup.event.id,
            ruleId: 'rule-e7',
            ruleVersion: 1,
            stagedAt: NOW,
          }),
          'terminal',
        );
        assert.equal(requests.length, 1);
        assert.equal(
          (setup.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string }).outcome,
          expectedOutcome,
        );
        assert.equal(
          (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
          0,
        );
        assert.equal(
          (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
          expectedPurged,
        );
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('E7: malformed, output-limited, exhausted and timed-out calls close no-match without a delivery', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  const scenarios: readonly [
    string,
    (requests: Buffer[]) => JudgeTransport,
    ((database: Awaited<ReturnType<typeof fixture>>['store']['database']) => void) | undefined,
  ][] = [
    [
      'malformed response',
      (requests) =>
        new JudgeTransport({
          tcpConnect: async () => respondingSocket(requests, Buffer.from('HTTP/1.1 200 OK\r\n\r\n{}')) as never,
        }),
      undefined,
    ],
    [
      'over output limit',
      (requests) =>
        new JudgeTransport({ tcpConnect: async () => respondingSocket(requests, response(0.75, 65)) as never }),
      undefined,
    ],
    [
      'exhausted budget',
      (requests) => new JudgeTransport({ tcpConnect: async () => respondingSocket(requests) as never }),
      (database) =>
        database.exec("DELETE FROM active_versions WHERE kind = 'judge-budget' AND object_id = 'judge-budget'"),
    ],
    [
      'deadline',
      (requests) =>
        new JudgeTransport({
          tcpConnect: async () => hangingSocket(requests) as never,
          clock: {
            now: () => 0,
            setTimeout: (callback) => {
              queueMicrotask(callback);
              return undefined;
            },
            clearTimeout() {},
          },
        }),
      undefined,
    ],
  ];
  for (const [name, transportFor, before] of scenarios) {
    await context.test(name, async () => {
      const requests: Buffer[] = [];
      const setup = await fixture(11434);
      try {
        before?.(setup.store.database);
        const evaluator = evaluatorFor(setup, transportFor(requests), productionTaintRecorder(setup.stateDir));
        assert.equal(
          await evaluator.admit({
            event: setup.event,
            eventId: setup.event.id,
            ruleId: 'rule-e7',
            ruleVersion: 1,
            stagedAt: NOW,
          }),
          'terminal',
        );
        assert.equal(
          (setup.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string }).outcome,
          'no-match',
        );
        assert.equal(
          (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
          0,
        );
        if (name === 'exhausted budget') assert.equal(requests.length, 0);
        else assert.equal(requests.length, 1);
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});
