import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { gmailMessageReceivedV1 } from '@agentcomms/events';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  type ActivationDocumentV1,
  canonicalFullRuleDocument,
  disclosureBindingFor,
} from '../src/domain/activation-documents.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { purgeJudgeKindRuleWork } from '../src/runtime/replacements.ts';
import { stepContextFor } from '../src/runtime/workflow/context.ts';
import type { StepResult } from '../src/runtime/workflow/contracts.ts';
import { flowJudge } from '../src/runtime/workflow/judge-call.ts';
import { createRunInTransaction, prepareFlowRun, readRun, runViewOf } from '../src/runtime/workflow/runs.ts';
import { judgeExecutor } from '../src/runtime/workflow/steps/judge.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { MemorySecretStore } from './support/stand-ins.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

assertLoopbackSeal();

/*
 * B3 (workflows plan): a judge inside a workflow — a judge step, and the one judging call a route makes. It is charged
 * exactly as the gate's judge is: the same source-owned reservation, ledger and gate, with no budget of its own, its
 * authority the live run and the judge its step asks. Only the step's inputs reach the provider, enveloped; a provider
 * that does not answer is unsure, never yes; a spent budget waits for its window. A flow's judges are bound into the
 * approval beside the gate's, each a stored version of an enabled kind.
 */

const ACCOUNT = 'ibx_B3FLOWJUDGE';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const JUDGE = {
  judgeId: 'judge-b3',
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'nimble',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'],
  promptTemplate: 'ollama-noul-v1',
  protocol: 'noul' as const,
};

function ask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    judge: JUDGE,
    question: 'Is this person asking for a change to one of our sites?',
    inputs: ['/text'],
    threshold: 0.7,
    onUncertain: 'no-match',
    callsPerRollingHour: 10,
    inputTokensPerRolling30Days: 100_000,
    concurrency: 1,
    maxInputTokens: 10_000,
    maxOutputTokens: 64,
    ...overrides,
  };
}

function flowRule(stepAsk: Record<string, unknown> = ask(), extra: Record<string, unknown> = {}) {
  return {
    ruleId: 'rule-b3',
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: [ACCOUNT],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { text: { $path: '/subject' }, author: { name: { $path: '/from/name' } } },
    targets: [],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention: {
      ingestMs: HOUR,
      holdMs: HOUR,
      deliveryMs: HOUR,
      dryrunMs: HOUR,
      sseReplayMs: HOUR,
      deadLetterMs: HOUR,
      decisionMetadataMs: HOUR,
    },
    flow: {
      flowVersion: 1,
      start: 'ask',
      steps: { ask: { kind: 'judge', ask: stepAsk, next: {} } },
      limits: {
        runsPerHour: 10,
        concurrentRuns: 2,
        sessionsPerHour: 2,
        worktreesPerDay: 5,
        linearWritesPerHour: 30,
        eventsPerHour: 120,
        runMs: 259_200_000,
      },
    },
    ...extra,
  };
}

function response(value: number): Buffer {
  return Buffer.from(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"decision":{"type":"noul","noul":${value}}},"model":"nimble","usage":{"input_tokens":9,"output_tokens":1}}`,
  );
}

function socket(requests: Buffer[], bytes: Buffer | null) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  return {
    write(written: Uint8Array) {
      requests.push(Buffer.from(written));
      queueMicrotask(() => {
        if (bytes === null) listeners.get('error')?.(new Error('connection reset'));
        else {
          listeners.get('data')?.(bytes);
          listeners.get('end')?.();
        }
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

/** A store with the judge, its kind and a budget active, the workflow active, and one live run of it. */
async function fixture(stepAsk: Record<string, unknown> = ask()) {
  const stateDir = await shortTempDir('events-b3-flow-judge-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7 WHERE singleton = 1');
  await selectEventSecretStore(store.database, 'file');
  const secrets = await openEventSecretStore({
    database: store.database,
    paths: store.paths,
    configDir: '/example/config',
    stores: { file: new MemorySecretStore('file') as SecretStore as never },
  });
  const cipher = new EventRecordCipher(store.database, secrets, testWriterQuiescer());
  const versions = new ImmutableVersions(store.database);
  versions.createJudge(JUDGE);
  versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 100_000, concurrency: 1 },
    providers: [{ provider: 'ollama', callsPerRollingHour: 10, inputTokensPerRolling30Days: 100_000, concurrency: 1 }],
  });
  versions.createRule(flowRule(stepAsk));
  store.database.exec(
    `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-kind', 'local-endpoint', 1, 'kind-b3', ${NOW});
     INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, 'budget-b3', ${NOW});
     INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-b3', 1, 'cutover-b3', ${NOW});
     UPDATE rule_versions SET state = 'active', approval_id = 'approval', authorization_activation_id = 'activation', activated_at = ${NOW} WHERE rule_id = 'rule-b3' AND version = 1;`,
  );
  const eventId = 'b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3';
  store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, 'b3', ?, ?, ?)`,
    )
    .run(eventId, store.installationId, gmailMessageReceivedV1.type, ACCOUNT, NOW, NOW, NOW);
  store.database
    .prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision-b3', ?, ?, 'rule-b3', 1, 'matched', ?, 'retained')`,
    )
    .run(eventId, ACCOUNT, NOW + HOUR);
  const rule = canonicalFullRuleDocument(flowRule(stepAsk));
  const prepared = await prepareFlowRun({
    cipher,
    rule,
    data: { text: 'SENTINEL-TEXT please change the banner', author: { name: 'SENTINEL-AUTHOR' } },
    createdAt: NOW,
  });
  if (prepared === undefined) throw new Error('a flow rule prepares a run');
  store.immediate(() =>
    createRunInTransaction(store.database, {
      runId: prepared.runId,
      decisionId: 'decision-b3',
      rule,
      accountId: ACCOUNT,
      eventId,
      sealedRecord: prepared.sealedRecord,
      now: NOW,
    }),
  );
  store.database.prepare("UPDATE workflow_runs SET state = 'running' WHERE id = ?").run(prepared.runId);
  return { stateDir, store, cipher, rule, runId: prepared.runId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One attempt of the judge step, through the real context and the real judging call over `transport`. */
async function judgeOnce(
  setup: Fixture,
  transport: JudgeTransport,
  input: { readonly attempt?: number; readonly now?: number } = {},
): Promise<StepResult> {
  const row = readRun(setup.store.database, setup.runId);
  if (row === undefined) throw new Error('the run is there');
  const step = setup.rule.flow?.steps.ask;
  if (step === undefined) throw new Error('the judge step is there');
  const now = () => input.now ?? NOW;
  const attempt = { id: `attempt-${input.attempt ?? 1}`, number: input.attempt ?? 1 };
  const context = stepContextFor({
    store: setup.store,
    cipher: setup.cipher,
    run: runViewOf(row),
    rule: setup.rule,
    stepId: 'ask',
    step,
    attempt,
    now,
    sealedRecord: row.encrypted_record,
    outputs: new Map(),
    judge: flowJudge({
      store: setup.store,
      attempt: {
        run: runViewOf(row),
        stepId: 'ask',
        attemptId: attempt.id,
        switchGeneration: 7,
        source: 'gmail',
      },
      transport,
      now,
    }),
    fence: async () => undefined,
  });
  return judgeExecutor.run(context);
}

async function withFixture(stepAsk: Record<string, unknown>, work: (setup: Fixture) => Promise<void>): Promise<void> {
  const setup = await fixture(stepAsk);
  try {
    await work(setup);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
}

const answering = (requests: Buffer[], value: number) =>
  new JudgeTransport({ tcpConnect: async () => socket(requests, response(value)) as never });

test('B3: a judge step says yes at its bar and no below it, and records its score', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withFixture(ask(), async (setup) => {
    const requests: Buffer[] = [];
    assert.deepEqual(await judgeOnce(setup, answering(requests, 0.8)), {
      kind: 'settled',
      outcome: 'yes',
      output: { score: 0.8 },
    });
    assert.deepEqual(await judgeOnce(setup, answering(requests, 0.5), { attempt: 2 }), {
      kind: 'settled',
      outcome: 'no',
      output: { score: 0.5 },
    });
    const reservations = setup.store.database
      .prepare(
        'SELECT work_id, work_scope, rule_id, state, actual_input_tokens FROM judge_budget_reservations ORDER BY reserved_at, id',
      )
      .all() as Array<{
      work_id: string;
      work_scope: string;
      rule_id: string;
      state: string;
      actual_input_tokens: number;
    }>;
    assert.equal(reservations.length, 2, 'each call is one reservation in the gate judge’s ledger');
    for (const reservation of reservations) {
      assert.match(reservation.work_id, new RegExp(`^flow-judge:${setup.runId}:ask:attempt-\\d:1$`, 'u'));
      assert.equal(reservation.work_scope, 'source-owned');
      assert.equal(reservation.rule_id, 'rule-b3');
      assert.equal(reservation.state, 'settled');
      assert.equal(reservation.actual_input_tokens, 9);
    }
  });
  await withFixture(ask({ onUncertain: 'hold' }), async (setup) => {
    assert.deepEqual(await judgeOnce(setup, answering([], 0.65)), {
      kind: 'settled',
      outcome: 'unsure',
      output: { score: 0.65 },
    });
  });
});

test('B3: no budget waits (limit), and resumes when the window frees', { skip: WINDOWS_SKIP }, async () => {
  await withFixture(ask({ callsPerRollingHour: 1 }), async (setup) => {
    const requests: Buffer[] = [];
    assert.equal((await judgeOnce(setup, answering(requests, 0.9))).kind, 'settled');
    const waited = await judgeOnce(setup, answering(requests, 0.9), { attempt: 2, now: NOW + 1_000 });
    assert.deepEqual(waited, { kind: 'wait', wait: 'limit', key: null, wakeAt: NOW + HOUR + 1 });
    assert.equal(requests.length, 1, 'nothing reached the provider while the budget was spent');
    const resumed = await judgeOnce(setup, answering(requests, 0.9), { attempt: 3, now: NOW + HOUR + 1 });
    assert.deepEqual(resumed, { kind: 'settled', outcome: 'yes', output: { score: 0.9 } });
  });
});

test('B3: a transport failure is unsure, never yes', { skip: WINDOWS_SKIP }, async () => {
  await withFixture(ask({ threshold: 0 }), async (setup) => {
    const failing = new JudgeTransport({ tcpConnect: async () => socket([], null) as never });
    assert.deepEqual(await judgeOnce(setup, failing), { kind: 'settled', outcome: 'unsure', output: { score: null } });
    const garbled = new JudgeTransport({
      tcpConnect: async () => socket([], Buffer.from('HTTP/1.1 200 OK\r\n\r\n{"answers":{}}')) as never,
    });
    assert.deepEqual(await judgeOnce(setup, garbled, { attempt: 2 }), {
      kind: 'settled',
      outcome: 'unsure',
      output: { score: null },
    });
  });
});

test('B3: only the step’s inputs reach the provider, inside the envelope', { skip: WINDOWS_SKIP }, async () => {
  await withFixture(ask(), async (setup) => {
    const requests: Buffer[] = [];
    await judgeOnce(setup, answering(requests, 0.9));
    const [request] = requests.map((bytes) => bytes.toString('utf8'));
    assert.ok(request !== undefined);
    assert.match(request, /\\"pointer\\":\\"\/text\\"|"pointer":"\/text"/u);
    assert.match(request, /SENTINEL-TEXT/u);
    assert.match(request, /untrusted-content/u, 'what the sender wrote is enveloped');
    assert.doesNotMatch(request, /SENTINEL-AUTHOR/u, 'a field the step does not name never leaves');
  });
});

test('B3: a judge whose run is no longer live is refused at the reservation, and the step is unsure', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withFixture(ask({ threshold: 0 }), async (setup) => {
    setup.store.database.prepare("UPDATE workflow_runs SET state = 'waiting' WHERE id = ?").run(setup.runId);
    const requests: Buffer[] = [];
    // A waiting run is live: its judge may be asked when it resumes.
    assert.equal((await judgeOnce(setup, answering(requests, 0.9))).kind, 'settled');
    setup.store.database
      .prepare("UPDATE workflow_runs SET state = 'cancelled', encrypted_record = NULL WHERE id = ?")
      .run(setup.runId);
    const row = setup.store.database.prepare('SELECT COUNT(*) AS count FROM judge_budget_reservations').get() as {
      count: number;
    };
    const before = requests.length;
    const refused = await judgeOnce(setup, answering(requests, 0.9), { attempt: 2 });
    assert.deepEqual(refused, { kind: 'settled', outcome: 'unsure', output: { score: null } });
    assert.equal(requests.length, before, 'nothing reached the provider');
    assert.equal(
      (
        setup.store.database.prepare('SELECT COUNT(*) AS count FROM judge_budget_reservations').get() as {
          count: number;
        }
      ).count,
      row.count,
      'and nothing was reserved',
    );
  });
});

const ruleDocument = (stepAsk: Record<string, unknown>, extra: Record<string, unknown> = {}): ActivationDocumentV1 => ({
  documentVersion: 1,
  kind: 'rule',
  rule: canonicalFullRuleDocument(flowRule(stepAsk, extra)),
});

test('B3: a flow’s judges are bound into the approval, each once, beside the gate’s', () => {
  const versions = (document: ActivationDocumentV1) =>
    disclosureBindingFor('intent-b3', document).versions.filter((version) => version.kind === 'judge');
  assert.deepEqual(versions(ruleDocument(ask())), [{ kind: 'judge', id: 'judge-b3', version: 1 }]);
  // The gate asks the same judge version: it is bound once.
  const gate = {
    agentic: {
      ...ask(),
      inputs: ['/subject'],
    },
  };
  assert.deepEqual(versions(ruleDocument(ask(), gate)), [{ kind: 'judge', id: 'judge-b3', version: 1 }]);
  // Another version of it in the flow is bound beside the gate's.
  const other = ask({ judge: { ...JUDGE, version: 2 } });
  assert.deepEqual(versions(ruleDocument(other, gate)), [
    { kind: 'judge', id: 'judge-b3', version: 1 },
    { kind: 'judge', id: 'judge-b3', version: 2 },
  ]);
});

test('B3: a flow judge must be a stored version, and activation refuses one whose kind is not enabled', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-flow-judge-activation-');
  const store = await openEventDatabase({ stateDir });
  try {
    const versions = new ImmutableVersions(store.database);
    assert.throws(
      () => versions.createRule(flowRule(ask({ judge: { ...JUDGE, version: 3 } }), { ruleId: 'unstored', version: 1 })),
      (error: unknown) =>
        error instanceof EventDomainError &&
        error.code === 'VERSION_DOCUMENT_INVALID' &&
        /judge-b3 version 3, which is not a stored version/u.test(error.message),
    );
    versions.createJudge(JUDGE);
    versions.createRule(flowRule(ask()));
    assert.throws(
      () => versions.prepareRule('rule-b3', 1),
      (error: unknown) => error instanceof EventDomainError && error.code === 'JUDGE_KIND_DISABLED',
    );
    versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
    store.database.exec(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-kind', 'local-endpoint', 1, 'kind', ${NOW})`,
    );
    assert.equal(versions.prepareRule('rule-b3', 1).rule.ruleId, 'rule-b3');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3: disabling a flow judge’s kind cancels the runs that ask it', { skip: WINDOWS_SKIP }, async () => {
  await withFixture(ask(), async (setup) => {
    setup.store.immediate(() => purgeJudgeKindRuleWork(setup.store.database, 'local-endpoint', NOW));
    const row = readRun(setup.store.database, setup.runId);
    assert.equal(row?.state, 'cancelled');
    assert.equal(row?.end_code, 'AUTHORIZATION_REVOKED');
    assert.equal(row?.encrypted_record, null);
  });
});
