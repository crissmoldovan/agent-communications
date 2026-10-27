import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { TaintStore } from '@agentcomms/core';
import { FLOW_LIMIT_DEFAULTS, gmailMessageReceivedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { HoldResolver } from '../src/runtime/holds.ts';
import { JudgeCoordinator } from '../src/runtime/judge-coordinator.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { type EventTaintRecorder, recordEventTaint } from '../src/runtime/untrusted.ts';
import { type RunRecord, runRecordLocation } from '../src/runtime/workflow/runs.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { MemorySecretStore } from './support/stand-ins.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

/*
 * A held message the person lets through, into a workflow that looks for the session that took its conversation
 * (workflows design W36): the release path seals the message's id and thread into the run's record, as the evaluator
 * does for a match it decides itself. A stand-in secret store, a stand-in judge on a socket of the test's own, a
 * synthetic Gmail message; nothing leaves the process.
 */

const ACCOUNT = 'ibx_HELDTHREAD0001';
const target = { targetId: 'held-thread-dry-run', version: 1, kind: 'dry-run' as const, retentionMs: 3_600_000 };
const judge = {
  judgeId: 'judge-held-thread',
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'nimble',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'] as const,
  promptTemplate: 'ollama-noul-v1',
  protocol: 'noul' as const,
};

/** A held Gmail workflow whose flow first finds the session that took the conversation, then delivers. */
const rule = {
  ruleId: 'held-thread',
  version: 1,
  source: {
    channel: 'gmail' as const,
    accountIds: [ACCOUNT],
    options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  agentic: {
    judge,
    question: 'Does this synthetic message need the person?',
    inputs: ['/subject'],
    threshold: 0.5,
    onUncertain: 'hold' as const,
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
    ingestMs: 3_600_000,
    holdMs: 3_600_000,
    deliveryMs: 3_600_000,
    dryrunMs: 3_600_000,
    sseReplayMs: 3_600_000,
    deadLetterMs: 3_600_000,
    decisionMetadataMs: 3_600_000,
  },
  flow: {
    flowVersion: 1,
    start: 'thread',
    limits: FLOW_LIMIT_DEFAULTS,
    steps: {
      thread: { kind: 'find-session', in: { thread: true }, provider: 'claude', next: { otherwise: 'give' } },
      give: { kind: 'deliver', target: { targetId: target.targetId, version: 1 }, next: {} },
    },
  },
};

/** The judge's answer, unsure below the bar: the match is held for the person. */
function unsureSocket() {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  return {
    write() {
      queueMicrotask(() => {
        listeners.get('data')?.(
          Buffer.from(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"decision":{"type":"noul","noul":0.45}},"model":"nimble","usage":{"input_tokens":9,"output_tokens":1}}',
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

test("a held message let through into a workflow that finds by thread keeps its message and thread in the run's record", {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-held-thread-');
  const store = await openEventDatabase({ stateDir });
  try {
    const stagedAt = Date.now();
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 8 WHERE singleton = 1');
    await selectEventSecretStore(store.database, 'file');
    const secrets = await openEventSecretStore({
      database: store.database,
      paths: store.paths,
      configDir: '/example/config',
      stores: { file: new MemorySecretStore('file') },
    });
    const cipher = new EventRecordCipher(store.database, secrets, testWriterQuiescer());
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createJudge(judge);
    versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 },
      providers: [{ provider: 'ollama', callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 }],
    });
    versions.createRule(rule);
    store.database.exec(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
         VALUES ('judge-kind', 'local-endpoint', 1, 'kind-held', ${stagedAt}),
                ('judge-budget', 'judge-budget', 1, 'budget-held', ${stagedAt});
       UPDATE rule_versions
          SET state = 'active', approval_id = 'approval-held', authorization_activation_id = 'activation-held',
              activated_at = ${stagedAt}
        WHERE rule_id = 'held-thread' AND version = 1;`,
    );
    const event = {
      ...gmailMessageReceivedV1.examples[1],
      id: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
      account: { name: 'Synthetic', id: ACCOUNT, channel: 'gmail' as const },
      subject: 'a synthetic question',
    };
    store.database
      .prepare(
        "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, 'held-thread', ?, ?, ?)",
      )
      .run(event.id, store.installationId, String(event.type), ACCOUNT, stagedAt, stagedAt, stagedAt);
    const taintStore = new TaintStore(stateDir, () => new Date(stagedAt));
    const taint: EventTaintRecorder = {
      record: (input) => recordEventTaint(taintStore, { ownAddresses: [], internalDomains: [] }, input),
    };
    const authorised = {
      approvalId: 'approval-held',
      authorizationActivationId: 'activation-held',
      usedAt: 'synthetic',
      switchGeneration: 8,
    };
    let ids = 0;
    const evaluator = new EventEvaluator({
      store,
      cipher,
      taint,
      now: () => stagedAt,
      newId: () => `held-decision-${++ids}`,
      fence: async () => authorised,
      judgeCoordinator: new JudgeCoordinator({
        store,
        taint,
        now: () => stagedAt,
        newId: () => `held-reservation-${++ids}`,
        transport: new JudgeTransport({ tcpConnect: async () => unsureSocket() as never }),
      }),
    });
    assert.equal(
      await evaluator.admit({ event, eventId: event.id, ruleId: rule.ruleId, ruleVersion: 1, stagedAt }),
      'terminal',
    );
    const held = store.database.prepare('SELECT id, outcome FROM decisions').get() as { id: string; outcome: string };
    assert.equal(held.outcome, 'hold');
    const resolver = new HoldResolver({
      store,
      cipher,
      taint,
      newId: () => `held-delivery-${++ids}`,
      accountLive: async () => undefined,
      authorise: async () => authorised,
    } as never);
    assert.deepEqual(await resolver.resolve({ decisionId: held.id, decision: 'accept' }), {
      kind: 'resolved',
      outcome: 'matched',
    });
    const run = store.database.prepare('SELECT id, encrypted_record FROM workflow_runs').get() as
      | { id: string; encrypted_record: Uint8Array }
      | undefined;
    assert.ok(run, 'the released match is a run');
    const record = JSON.parse(
      (await cipher.decrypt(runRecordLocation(run.id), run.encrypted_record)).toString('utf8'),
    ) as RunRecord;
    assert.deepEqual(record.message, { id: event.messageId, thread: event.threadId });
    assert.deepEqual(record.fields, { subject: 'a synthetic question' });
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
