import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type net from 'node:net';
import { Duplex } from 'node:stream';
import { type SecretStore, TaintStore } from '@agentcomms/core';
import { assertLoopbackSeal, loopbackSealAttempts } from '../../../../test/helpers/loopback-seal-preload.mjs';
import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';
import { ImmutableVersions } from '../../src/domain/versions.ts';
import { EventEvaluator } from '../../src/runtime/evaluate.ts';
import { EventExpiry } from '../../src/runtime/expiry.ts';
import { sqliteTransactionNow } from '../../src/runtime/holds.ts';
import { JudgeCoordinator } from '../../src/runtime/judge-coordinator.ts';
import { recoverJudgeWork } from '../../src/runtime/judge-recovery.ts';
import {
  JudgeTransport,
  type JudgeTransportOptions,
  type JudgeTransportResult,
} from '../../src/runtime/judge-transport.ts';
import { type EventTaintRecorder, recordEventTaint } from '../../src/runtime/untrusted.ts';
import { openEventDatabase } from '../../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../../src/store/event-secrets.ts';
import { EventRecordCipher } from '../../src/store/records.ts';
import { shortTempDir } from './short-temp.ts';
import { testWriterQuiescer } from './writer-quiescer.ts';

const ACCOUNT = 'ibx_E11SYNTHETIC0000';
const NOW = 1_800_000_000_000;
const SCHEMA = 'agentcomms.events.judge-adversarial-v1';
const INJECTED_HOST = '127.0.0.1';
const INJECTED_PORT = 49_152;

export interface AdversarialCorpusCase {
  readonly schema: typeof SCHEMA;
  readonly id: string;
  readonly category: string;
  readonly response:
    | 'noul-low'
    | 'noul-hold'
    | 'noul-match'
    | 'provider-match-low'
    | 'wrong-type-score'
    | 'truncated'
    | 'multiple-json'
    | 'nan'
    | 'infinite'
    | 'range-high'
    | 'tool'
    | 'hostile-reason'
    | 'redirect'
    | 'oversize'
    | 'output-limit';
  readonly scenario?:
    | 'exact-input'
    | 'input-token-limit'
    | 'request-cap'
    | 'kind-disabled'
    | 'kind-disable-race'
    | 'rule-revocation-race'
    | 'budget-inactive'
    | 'budget-race'
    | 'post-io-unknown'
    | 'hold'
    | 'hold-expiry'
    | 'late-response-expiry'
    | 'endpoint-userinfo'
    | 'endpoint-host-drift'
    | 'endpoint-host-drift-race'
    | 'dns-rebinding'
    | undefined;
  readonly subject?: string | undefined;
  readonly expected: Readonly<{
    outcome: 'matched' | 'no-match' | 'hold' | 'hold-expired' | 'missing';
    reservation: 'settled' | 'released' | 'none';
    projection: 'purged' | 'retained';
    taint: boolean;
    requests: number;
    transportCalls: number;
    connectionAttempts: number;
    responseAccepted: boolean;
    decisionCount: number;
    deliveryCount: number;
    metadataState: string;
    refusal?: string | undefined;
  }>;
}

export interface AdversarialRun {
  readonly actualRequests: readonly Buffer[];
  readonly destination: string;
  readonly transportCalls: number;
  readonly connectionAttempts: number;
  readonly responseAccepted: boolean;
  readonly refusal: string | null;
  readonly newSealAttempts: readonly string[];
  readonly outcome: string;
  readonly decisionCount: number;
  readonly projectionCount: number;
  readonly reservation: string | null;
  readonly taintInputs: readonly Parameters<EventTaintRecorder['record']>[0][];
  readonly metadataState: string | null;
  readonly encryptedMetadata: Uint8Array | null;
  readonly deliveryCount: number;
  readonly dryrunCount: number;
  readonly streamCount: number;
  readonly expirySweepBeforeResponse: boolean;
  readonly lateResponseArrived: boolean;
  readonly evaluationFailure: string | null;
  readonly durableContent: string;
}

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

function retention(row: AdversarialCorpusCase) {
  return {
    ingestMs: 60_000,
    holdMs: row.scenario === 'hold-expiry' ? 1 : 60_000,
    deliveryMs: 60_000,
    dryrunMs: 60_000,
    sseReplayMs: 60_000,
    deadLetterMs: 60_000,
    decisionMetadataMs: 60_000,
  };
}

/**
 * The real transport owns its gates, pinning, raw write and parser. This injected peer is only a sealed stand-in for
 * the literal-loopback socket, which lets this corpus run where a development sandbox forbids every `listen` call.
 */
class InjectedJournalSocket extends Duplex {
  readonly #requests: Buffer[];
  readonly #response: Buffer;
  readonly #responseGate: Promise<void> | undefined;
  readonly #onWrite: (() => void) | undefined;
  readonly #onResponse: (() => void) | undefined;

  constructor(
    requests: Buffer[],
    response: Buffer,
    responseGate?: Promise<void>,
    onWrite?: () => void,
    onResponse?: () => void,
  ) {
    super();
    this.#requests = requests;
    this.#response = response;
    this.#responseGate = responseGate;
    this.#onWrite = onWrite;
    this.#onResponse = onResponse;
    this.on('error', () => undefined);
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#requests.push(Buffer.from(chunk));
    this.#onWrite?.();
    void (this.#responseGate ?? Promise.resolve()).then(() =>
      queueMicrotask(() => {
        if (this.destroyed) return;
        this.#onResponse?.();
        this.push(this.#response);
        this.push(null);
      }),
    );
    callback();
  }
}

function deferred(): { readonly ready: Promise<void>; readonly resolve: () => void } {
  let resolve: (() => void) | undefined;
  const ready = new Promise<void>((fulfil) => {
    resolve = fulfil;
  });
  return {
    ready,
    resolve: () => {
      assert.ok(resolve, 'the adversarial deferred gate has one resolver');
      resolve();
    },
  };
}

function createJournal(): { readonly destination: string; readonly requests: Buffer[]; connectionAttempts: number } {
  return { destination: `${INJECTED_HOST}:${INJECTED_PORT}`, requests: [], connectionAttempts: 0 };
}

class ObservedJudgeTransport extends JudgeTransport {
  readonly results: JudgeTransportResult[] = [];
  readonly #beforeExecute: (() => void) | undefined;
  calls = 0;

  constructor(options: JudgeTransportOptions, beforeExecute?: () => void) {
    super(options);
    this.#beforeExecute = beforeExecute;
  }

  override async execute(
    call: Parameters<JudgeTransport['execute']>[0],
    hooks: Parameters<JudgeTransport['execute']>[1],
  ): Promise<JudgeTransportResult> {
    this.calls += 1;
    this.#beforeExecute?.();
    const result = await super.execute(call, hooks);
    this.results.push(result);
    return result;
  }
}

class ObservedJudgeCoordinator extends JudgeCoordinator {
  readonly results: Awaited<ReturnType<JudgeCoordinator['evaluate']>>[] = [];

  override async evaluate(
    input: Parameters<JudgeCoordinator['evaluate']>[0],
  ): ReturnType<JudgeCoordinator['evaluate']> {
    const result = await super.evaluate(input);
    this.results.push(result);
    return result;
  }
}

const TEST_EVENT = Object.freeze({
  id: 'agentcomms-test-v1',
  type: 'gmail.message.received' as const,
  version: 1 as const,
  occurredAt: '2000-01-01T00:00:00Z',
  observedAt: '2000-01-01T00:00:00Z',
  account: { name: 'Synthetic', id: ACCOUNT, channel: 'gmail' as const },
  messageId: 'synthetic-message',
  threadId: 'synthetic-thread',
  labels: [],
  from: { address: 'sender@example.test', name: 'Synthetic Sender' },
  replyTo: [],
  to: [{ address: 'recipient@example.test', name: null }],
  cc: [],
  subject: 'synthetic subject',
  snippet: 'synthetic snippet',
  date: '2000-01-01T00:00:00Z',
  unread: true,
  authentication: {
    evaluatedBy: null,
    spf: null,
    dkim: null,
    dkimDomain: null,
    dmarc: null,
    aligned: null,
    ignoredHeaders: 0,
  },
  warnings: { replyToDiffers: false, replyToDomains: [], displayNameContainsOtherAddress: false, fromDomain: null },
  hasAttachments: false,
  attachments: [],
  body: 'synthetic body',
});

/** Executes one corpus row only through the production evaluator, coordinator, ledger and sealed transport. */
export async function runAdversarialCase(
  row: AdversarialCorpusCase,
  scriptedResponse: Uint8Array,
): Promise<AdversarialRun> {
  assertLoopbackSeal();
  const sealAttempts = loopbackSealAttempts();
  const response = Buffer.from(scriptedResponse);
  const rowRetention = retention(row);
  const journal = createJournal();
  let stateDir: string | undefined;
  let store: Awaited<ReturnType<typeof openEventDatabase>> | undefined;
  try {
    stateDir = await shortTempDir(`events-e11-${row.id.slice(0, 12)}-`);
    store = await openEventDatabase({ stateDir });
    const eventStore = store;
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 11 WHERE singleton = 1');
    await selectEventSecretStore(store.database, 'file');
    const secrets = await openEventSecretStore({
      database: store.database,
      paths: store.paths,
      configDir: '/synthetic/config',
      stores: { file: new MemorySecretStore() },
    });
    const cipher = new EventRecordCipher(store.database, secrets, testWriterQuiescer());
    const localJudge = {
      judgeId: `judge-e11-${row.id}`,
      version: 1,
      kind: 'local-endpoint' as const,
      provider: 'ollama',
      model: 'synthetic-model',
      endpoint: 'http://127.0.0.1:49152/v1/systemone',
      approvedAddressSet: [INJECTED_HOST],
      promptTemplate: 'ollama-noul-v1',
      protocol: 'noul' as const,
    };
    const hostedJudge = {
      judgeId: `judge-e11-${row.id}`,
      version: 1,
      kind: 'typesafe' as const,
      provider: 'typesafe' as const,
      model: 'jev-1.13.0',
      endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT,
      promptTemplate: 'typesafe-jev-v1',
      protocol: 'noul' as const,
    };
    const judge = row.scenario === 'dns-rebinding' ? hostedJudge : localJudge;
    const subject =
      row.scenario === 'request-cap'
        ? 'x'.repeat(66_000)
        : (row.subject ?? 'synthetic sender at sender@example.test asks a synthetic question');
    const rule = {
      ruleId: `rule-e11-${row.id}`,
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
        question: 'Does this synthetic event need attention?',
        inputs: row.scenario === 'exact-input' ? ['/subject', '/from', '/body'] : ['/subject'],
        threshold: 0.5,
        onUncertain: 'hold' as const,
        callsPerRollingHour: 10,
        inputTokensPerRolling30Days: 100_000,
        concurrency: 1,
        maxInputTokens: row.scenario === 'input-token-limit' ? 1 : 100_000,
        maxOutputTokens: 64,
      },
      mapping:
        row.scenario === 'exact-input'
          ? {
              subject: { $path: '/subject' },
              from: { $path: '/from' },
              body: { $path: '/body' },
            }
          : { subject: { $path: '/subject' } },
      targets: [{ targetId: `target-e11-${row.id}`, version: 1, kind: 'dry-run' as const, retentionMs: 60_000 }],
      subscribers: [],
      judges: [],
      deliveryRateCap: 10,
      retention: rowRetention,
    };
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(rule.targets[0]);
    versions.createJudge(judge);
    versions.createJudgeKind({
      id: `judge-kind:${judge.kind}`,
      kind: judge.kind,
      version: 1,
      ...(judge.kind === 'typesafe' ? { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT } : {}),
    });
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 100_000, concurrency: 1 },
      providers: [
        { provider: judge.provider, callsPerRollingHour: 10, inputTokensPerRolling30Days: 100_000, concurrency: 1 },
      ],
    });
    versions.createRule(rule);
    store.database.exec(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-kind', '${judge.kind}', 1, 'kind-e11', ${NOW}),
              ('judge-budget', 'judge-budget', 1, 'budget-e11', ${NOW});
       UPDATE rule_versions
          SET state = 'active', approval_id = 'approval-e11', authorization_activation_id = 'activation-e11', activated_at = ${NOW}
        WHERE rule_id = '${rule.ruleId}' AND version = 1;`,
    );
    if (row.scenario === 'kind-disabled')
      store.database.prepare("DELETE FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?").run(judge.kind);
    if (row.scenario === 'budget-inactive')
      store.database
        .prepare("DELETE FROM active_versions WHERE kind = 'judge-budget' AND object_id = 'judge-budget'")
        .run();
    if (row.scenario === 'endpoint-userinfo' || row.scenario === 'endpoint-host-drift') {
      const stored = store.database
        .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = 1')
        .get(rule.ruleId) as { document: string } | undefined;
      assert.ok(stored, 'the adversarial fixture must have one stored rule document');
      const changed = JSON.parse(stored.document) as { agentic: { judge: { endpoint: string } } };
      if (row.scenario === 'endpoint-userinfo')
        changed.agentic.judge.endpoint = 'http://synthetic@127.0.0.1:49152/v1/systemone';
      else changed.agentic.judge.endpoint = 'http://192.0.2.2:49152/v1/systemone';
      store.database
        .prepare('UPDATE rule_versions SET document = ? WHERE rule_id = ? AND version = 1')
        .run(JSON.stringify(changed), rule.ruleId);
    }
    const event = {
      ...TEST_EVENT,
      id: `e11${row.id
        .replaceAll(/[^a-z0-9]/giu, '')
        .padEnd(29, '0')
        .slice(0, 29)}`,
      account: { name: 'Synthetic', id: ACCOUNT, channel: 'gmail' as const },
      subject,
      from: { address: 'sender@example.test', name: 'Synthetic Sender' },
      body: 'synthetic body from sender@example.test',
    };
    const stagedAt =
      row.scenario === 'hold-expiry' ? eventStore.immediate(() => sqliteTransactionNow(eventStore.database)) : NOW;
    store.database
      .prepare(
        'INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
      )
      .run(event.id, store.installationId, String(event.type), ACCOUNT, `e11:${row.id}`, stagedAt, stagedAt, stagedAt);
    const taintInputs: Parameters<EventTaintRecorder['record']>[0][] = [];
    const taintStore = new TaintStore(stateDir, () => new Date(NOW));
    const taint: EventTaintRecorder = {
      async record(input) {
        taintInputs.push(input);
        await recordEventTaint(taintStore, { ownAddresses: [], internalDomains: [] }, input);
      },
    };
    let ids = 0;
    const budgetRaceGate = row.scenario === 'budget-race' ? deferred() : undefined;
    const firstTransportStarted = row.scenario === 'budget-race' ? deferred() : undefined;
    const lateResponseGate = row.scenario === 'late-response-expiry' ? deferred() : undefined;
    const lateRequestWritten = row.scenario === 'late-response-expiry' ? deferred() : undefined;
    let lateResponseArrived = false;
    let expirySweepBeforeResponse = false;
    const transport = new ObservedJudgeTransport(
      {
        tcpConnect: async (options) => {
          journal.connectionAttempts += 1;
          assert.equal(options.host, INJECTED_HOST, `${row.id}: transport keeps the injected loopback host pinned`);
          assert.equal(options.port, INJECTED_PORT, `${row.id}: transport keeps the injected loopback port pinned`);
          firstTransportStarted?.resolve();
          return new InjectedJournalSocket(
            journal.requests,
            response,
            budgetRaceGate?.ready ?? lateResponseGate?.ready,
            lateRequestWritten?.resolve,
            lateResponseGate === undefined
              ? undefined
              : () => {
                  lateResponseArrived = true;
                },
          ) as unknown as net.Socket;
        },
        ...(row.scenario === 'dns-rebinding'
          ? {
              resolver: {
                async lookup() {
                  return ['203.0.113.17'];
                },
              },
            }
          : {}),
      },
      row.scenario === 'endpoint-host-drift-race'
        ? () => {
            const stored = eventStore.database
              .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = 1')
              .get(rule.ruleId) as { document: string };
            const changed = JSON.parse(stored.document) as { agentic: { judge: { endpoint: string } } };
            changed.agentic.judge.endpoint = 'http://192.0.2.2:49152/v1/systemone';
            eventStore.database
              .prepare('UPDATE rule_versions SET document = ? WHERE rule_id = ? AND version = 1')
              .run(JSON.stringify(changed), rule.ruleId);
          }
        : undefined,
    );
    const coordinator = new ObservedJudgeCoordinator({
      store,
      taint,
      transport,
      now: () => NOW,
      newId: () => `reservation-e11-${++ids}`,
      ...(row.scenario === 'dns-rebinding' ? { hostedApiKeyFor: async () => 'synthetic-boundary-value' } : {}),
    });
    let raceFenceMutated = false;
    const evaluator = new EventEvaluator({
      store,
      cipher,
      taint,
      now: () => NOW,
      newId: () => `decision-e11-${++ids}`,
      fence: async () => {
        if (!raceFenceMutated && row.scenario === 'kind-disable-race') {
          raceFenceMutated = true;
          eventStore.database
            .prepare("DELETE FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?")
            .run(judge.kind);
        }
        if (!raceFenceMutated && row.scenario === 'rule-revocation-race') {
          raceFenceMutated = true;
          eventStore.database
            .prepare("UPDATE rule_versions SET state = 'revoked', revoked_at = ? WHERE rule_id = ? AND version = 1")
            .run(NOW, rule.ruleId);
        }
        return {
          approvalId: 'approval-e11',
          authorizationActivationId: 'activation-e11',
          usedAt: 'synthetic',
          switchGeneration: 11,
        };
      },
      judgeCoordinator: coordinator,
      ...(row.scenario === 'post-io-unknown'
        ? {
            failpoint: (point) => {
              if (point === 'after-decision') throw new Error('synthetic post-I/O interruption');
            },
          }
        : {}),
    });
    const racingEvaluator =
      row.scenario === 'budget-race'
        ? new EventEvaluator({
            store,
            cipher: new EventRecordCipher(store.database, secrets, testWriterQuiescer()),
            taint,
            now: () => NOW,
            newId: () => `race-decision-e11-${++ids}`,
            fence: async () => ({
              approvalId: 'approval-e11',
              authorizationActivationId: 'activation-e11',
              usedAt: 'synthetic',
              switchGeneration: 11,
            }),
            judgeCoordinator: coordinator,
          })
        : undefined;
    const admission = {
      event,
      eventId: event.id,
      ruleId: rule.ruleId,
      ruleVersion: 1,
      stagedAt,
    };
    let evaluationFailure: string | null = null;
    if (row.scenario === 'budget-race') {
      const firstPromise = evaluator.admit(admission);
      assert.ok(firstTransportStarted, 'the budget race has a first transport gate');
      await firstTransportStarted.ready;
      assert.ok(racingEvaluator, 'the budget race has an independent evaluator');
      assert.ok(budgetRaceGate, 'the budget race has a response gate');
      let second: 'terminal' | 'pending';
      try {
        second = await racingEvaluator.evaluate(admission);
      } finally {
        budgetRaceGate.resolve();
      }
      const first = await firstPromise;
      assert.equal(first, 'terminal', 'the reservation owner must terminalise the adversarial race');
      assert.equal(second, 'pending', "the contender must leave the owner's exact work intact");
    } else if (row.scenario === 'endpoint-host-drift-race') {
      try {
        const first = await evaluator.admit(admission);
        if (first === 'pending') await evaluator.evaluate(admission);
      } catch (error) {
        evaluationFailure = error instanceof Error ? error.message : String(error);
      }
    } else if (row.scenario === 'late-response-expiry') {
      assert.ok(lateRequestWritten, 'the late-response scenario has a request-write gate');
      assert.ok(lateResponseGate, 'the late-response scenario has a response gate');
      const pending = evaluator.admit(admission);
      let sweepFailure: unknown;
      try {
        await lateRequestWritten.ready;
        assert.equal(lateResponseArrived, false, `${row.id}: the injected response remains held before expiry`);
        new EventExpiry(store, () => NOW + rowRetention.ingestMs).sweep();
        const remaining = store.database
          .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = 1')
          .get(event.id, rule.ruleId) as { count: number };
        assert.equal(remaining.count, 0, `${row.id}: Task 8 expiry purges the in-flight projection`);
        expirySweepBeforeResponse = true;
      } catch (error) {
        sweepFailure = error;
      } finally {
        lateResponseGate.resolve();
      }
      await pending;
      if (sweepFailure !== undefined) throw sweepFailure;
    } else if (row.scenario === 'post-io-unknown') {
      await assert.rejects(
        () => evaluator.admit(admission),
        /synthetic post-I\/O interruption/u,
        `${row.id}: injected post-I/O interruption reaches recovery`,
      );
      eventStore.immediate(() => recoverJudgeWork({ database: eventStore.database, now: NOW + 1 }));
    } else {
      await evaluator.admit(admission);
    }
    if (row.scenario === 'hold-expiry') {
      const held = store.database
        .prepare(
          'SELECT outcome, hold_expires_at, hold_bound_by FROM decisions WHERE event_id = ? AND rule_id = ? AND rule_version = 1',
        )
        .get(event.id, rule.ruleId) as
        | { outcome: string; hold_expires_at: number | null; hold_bound_by: string | null }
        | undefined;
      assert.equal(held?.outcome, 'hold', `${row.id}: the response first creates the durable hold`);
      assert.notEqual(held?.hold_expires_at, null, `${row.id}: the durable hold has a production deadline`);
      assert.equal(held?.hold_bound_by, 'hold-window', `${row.id}: the short hold is bounded by its hold window`);
      const deadline = held?.hold_expires_at;
      assert.equal(typeof deadline, 'number', `${row.id}: the production hold deadline is numeric`);
      let dbNow = eventStore.immediate(() => sqliteTransactionNow(eventStore.database));
      for (let attempt = 0; dbNow < (deadline ?? 0) && attempt < 250; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        dbNow = eventStore.immediate(() => sqliteTransactionNow(eventStore.database));
      }
      assert.equal(
        dbNow >= (deadline ?? Number.POSITIVE_INFINITY),
        true,
        `${row.id}: SQLite reaches the hold deadline`,
      );
      new EventExpiry(store, () => NOW).sweep();
    }
    const decisions = store.database
      .prepare('SELECT id, outcome, metadata_state, encrypted_record FROM decisions ORDER BY id')
      .all() as Array<{ id: string; outcome: string; metadata_state: string; encrypted_record: Uint8Array | null }>;
    const decision = decisions[0] as
      | { id: string; outcome: string; metadata_state: string; encrypted_record: Uint8Array | null }
      | undefined;
    const reservation = store.database.prepare('SELECT state FROM judge_budget_reservations').get() as
      | { state: string }
      | undefined;
    const projection = store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as
      | { count: number }
      | undefined;
    const deliveries = store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as
      | { count: number }
      | undefined;
    const dryruns = store.database.prepare('SELECT COUNT(*) AS count FROM dryrun_log').get() as
      | { count: number }
      | undefined;
    const streams = store.database.prepare('SELECT COUNT(*) AS count FROM stream_log').get() as
      | { count: number }
      | undefined;
    const coordinatorRefusal = coordinator.results.find((result) => result.kind === 'closed');
    const transportRefusal = transport.results.find((result) => result.kind === 'refused');
    const responseAccepted = transport.results.some((result) => result.kind === 'answer');
    const decryptedMetadata =
      decision?.encrypted_record === null || decision === undefined
        ? null
        : (
            await cipher.decrypt(
              { table: 'decisions', column: 'encryptedRecord', key: [{ type: 'text', value: decision.id }] },
              decision.encrypted_record,
            )
          ).toString('utf8');
    const durableContent = {
      decision: decision
        ? {
            outcome: decision.outcome,
            metadataState: decision.metadata_state,
            metadata: decryptedMetadata,
          }
        : null,
      reservation: reservation?.state ?? null,
      projectionCount: projection?.count ?? -1,
      deliveryCount: deliveries?.count ?? -1,
      dryrunCount: dryruns?.count ?? -1,
      streamCount: streams?.count ?? -1,
      deliveries: store.database.prepare('SELECT id, state, target_kind, target_representation FROM deliveries').all(),
      dryruns: store.database.prepare('SELECT delivery_id, target_id, target_version FROM dryrun_log').all(),
      streams: store.database.prepare('SELECT id, delivery_id, target_id, target_version FROM stream_log').all(),
    };
    return {
      actualRequests: journal.requests,
      destination: journal.destination,
      transportCalls: transport.calls,
      connectionAttempts: journal.connectionAttempts,
      responseAccepted,
      refusal:
        transportRefusal?.kind === 'refused'
          ? transportRefusal.code.toLowerCase().replaceAll('_', '-')
          : coordinatorRefusal?.kind === 'closed'
            ? coordinatorRefusal.reason
            : null,
      newSealAttempts: loopbackSealAttempts()
        .slice(sealAttempts.length)
        .map((attempt) => attempt.target),
      outcome: decision?.outcome ?? 'missing',
      decisionCount: decisions.length,
      projectionCount: projection?.count ?? -1,
      reservation: reservation?.state ?? null,
      taintInputs,
      metadataState: decision?.metadata_state ?? null,
      encryptedMetadata: decision?.encrypted_record ?? null,
      deliveryCount: deliveries?.count ?? -1,
      dryrunCount: dryruns?.count ?? -1,
      streamCount: streams?.count ?? -1,
      expirySweepBeforeResponse,
      lateResponseArrived,
      evaluationFailure,
      durableContent: JSON.stringify(durableContent),
    };
  } finally {
    store?.close();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  }
}

export function assertAdversarialRun(
  row: AdversarialCorpusCase,
  run: AdversarialRun,
  goldenRequests: readonly Buffer[],
): void {
  if (row.scenario === 'hold-expiry')
    assert.equal(run.reservation, 'settled', `${row.id}: Task 8 settles the expired in-flight reservation`);
  if (row.scenario === 'late-response-expiry')
    assert.equal(run.reservation, 'settled', `${row.id}: Task 8 settles the expired in-flight reservation`);
  assert.equal(run.actualRequests.length, row.expected.requests, `${row.id}: sealed network journal write count`);
  assert.equal(run.evaluationFailure, null, `${row.id}: evaluation completes without an uncaught failure`);
  assert.equal(run.transportCalls, row.expected.transportCalls, `${row.id}: JudgeTransport.execute call count`);
  assert.equal(run.connectionAttempts, row.expected.connectionAttempts, `${row.id}: sealed connection attempt count`);
  assert.equal(run.outcome, row.expected.outcome, `${row.id}: durable decision outcome`);
  assert.equal(run.decisionCount, row.expected.decisionCount, `${row.id}: exact durable decision count`);
  assert.equal(run.reservation ?? 'none', row.expected.reservation, `${row.id}: durable reservation state`);
  assert.equal(
    run.projectionCount === 0 ? 'purged' : 'retained',
    row.expected.projection,
    `${row.id}: encrypted projection retention`,
  );
  assert.equal(run.taintInputs.length > 0, row.expected.taint, `${row.id}: final input taint observation`);
  if (row.expected.refusal !== undefined && (row.response === 'tool' || row.response === 'hostile-reason'))
    assert.equal(run.encryptedMetadata, null, `${row.id}: refusal retains no encrypted provider metadata`);
  assert.equal(run.responseAccepted, row.expected.responseAccepted, `${row.id}: provider response acceptance`);
  if (row.expected.refusal !== undefined) {
    if (row.response !== 'tool' && row.response !== 'hostile-reason')
      assert.equal(run.encryptedMetadata, null, `${row.id}: refusal retains no encrypted provider metadata`);
    assert.equal(run.deliveryCount, 0, `${row.id}: refusal creates no delivery`);
    assert.equal(run.dryrunCount, 0, `${row.id}: refusal creates no dry-run projection`);
    assert.equal(run.streamCount, 0, `${row.id}: refusal forwards no stream projection`);
    assert.equal(run.projectionCount, 0, `${row.id}: refusal leaves no projected content`);
    assert.equal(
      /(?:synthetic-tool|ignore synthetic safeguards|"(?:tool|reason|match)"\s*:)/u.test(run.durableContent),
      false,
      `${row.id}: refusal stores, projects and forwards no untrusted provider field`,
    );
    assert.equal(run.responseAccepted, false, `${row.id}: refused provider response is rejected`);
  }
  assert.equal(run.deliveryCount, row.expected.deliveryCount, `${row.id}: exact delivery count`);
  assert.equal(run.metadataState, row.expected.metadataState, `${row.id}: exact durable metadata state`);
  assert.equal(run.refusal, row.expected.refusal ?? null, `${row.id}: exact refusal reason or code`);
  assert.deepEqual(run.newSealAttempts, [], `${row.id}: no unapproved network attempt passed the preload seal`);
  if (row.scenario === 'exact-input') {
    const input = run.taintInputs[0];
    assert.ok(input, `${row.id}: judge provenance was recorded`);
    assert.equal(
      input.classification.addresses.some((entry) => entry.pointer === '/inputs/1/value/address'),
      true,
      `${row.id}: copied object provenance remains in the exact input envelope`,
    );
  }
  assert.equal(goldenRequests.length, row.expected.requests, `${row.id}: fixture-pinned golden request count`);
  assert.deepEqual(
    run.actualRequests,
    goldenRequests,
    `${row.id}: every sealed journal request byte is fixture-pinned and exact`,
  );
  if (row.expected.requests > 0)
    assert.match(run.destination, /^127\.0\.0\.1:[1-9][0-9]*$/u, `${row.id}: sealed journal destination is loopback`);
  if (row.scenario === 'post-io-unknown')
    assert.equal(run.metadataState, 'judge-io-unknown', `${row.id}: post-I/O recovery remains content-free unknown`);
  if (row.scenario === 'hold-expiry') {
    assert.equal(run.lateResponseArrived, false, `${row.id}: the accepted response precedes its durable hold expiry`);
    assert.equal(run.outcome, 'hold-expired', `${row.id}: Task 8 expires the established hold by its stored deadline`);
    assert.equal(run.encryptedMetadata, null, `${row.id}: Task 8 clears expired hold metadata content-free`);
    assert.equal(run.projectionCount, 0, `${row.id}: Task 8 removes the expired held projection`);
  }
  if (row.scenario === 'late-response-expiry') {
    assert.equal(run.expirySweepBeforeResponse, true, `${row.id}: Task 8 expiry runs while the response is held`);
    assert.equal(run.lateResponseArrived, true, `${row.id}: held response arrives only after Task 8 expiry`);
    assert.equal(run.projectionCount, 0, `${row.id}: late response does not recreate the expired projection`);
    assert.equal(run.decisionCount, 1, `${row.id}: late response does not resurrect a second decision`);
    assert.equal(run.deliveryCount, 0, `${row.id}: late response creates no delivery`);
  }
}
