import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openCore, type SecretStore, TaintStore } from '@agentcomms/core';
import { gmailMessageReceivedV1 } from '@agentcomms/events';
import { assertLoopbackSeal, loopbackSealAttempts } from '../../../test/helpers/loopback-seal-preload.mjs';
import { resolveEndpoints } from '../../gmail/src/auth/endpoints.ts';
import { buildAuthUrl, exchangeCode, newPkce } from '../../gmail/src/auth/oauth.ts';
import { SCOPES } from '../../gmail/src/auth/scopes.ts';
import { clientSecretRef, refreshTokenRef } from '../../gmail/src/auth/session.ts';
import { GMAIL_CALLER } from '../../gmail/src/caller.ts';
import { GmailContext } from '../../gmail/src/context.ts';
import { createGmailEventSource } from '../../gmail/src/operations/events.ts';
import { DRAFT_SEND_PATH, startFakeGoogle } from '../../gmail/test/support/fake-google.ts';
import { EventControlClient } from '../src/control/client.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { projectE9Doctor } from '../src/runtime/b3-doctor-projection.ts';
import { DryRunDispatcher } from '../src/runtime/dispatcher.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { JudgeCoordinator } from '../src/runtime/judge-coordinator.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { assertObjectSecretReady } from '../src/runtime/object-secret-readiness.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { type EventTaintRecorder, recordEventTaint } from '../src/runtime/untrusted.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { startLoopbackReceiver } from './support/loopback-receiver.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

assertLoopbackSeal();

const refusedNetwork = loopbackSealAttempts();

const NOW = 1_800_000_000_000;
const ACCOUNT = 'ibx_E13AAAAAAAAAAAA';
const RULE_ID = 'rule-e13-final';
const JUDGE_ID = 'judge-e13-final';
const TARGET_ID = 'target-e13-final';
const TEST_CLIENT_ID = 'e13-client.apps.googleusercontent.com';
const TEST_CLIENT_SECRET = 'e13-test-client-secret-not-a-real-credential';

function ownerIds(outcome: 'match' | 'hold') {
  const suffix = outcome === 'match' ? 'match' : 'hold';
  return {
    accountId: outcome === 'match' ? 'ibx_E13MATCHAAAAAAAA' : 'ibx_E13HOLDAAAAAAAAA',
    ruleId: `rule-e13-owner-${suffix}`,
    judgeId: `judge-e13-owner-${suffix}`,
    targetId: `target-e13-owner-${suffix}`,
  } as const;
}

async function startSystemOneFake(value: number) {
  const requests: Buffer[] = [];
  const receiver = await startLoopbackReceiver((socket) => {
    let request = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (chunk: Buffer) => {
      if (answered) return;
      request = Buffer.concat([request, chunk]);
      const boundary = request.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const header = request.subarray(0, boundary).toString('utf8');
      const length = Number(/\r\nContent-Length: ([0-9]+)\r\n/iu.exec(`\r\n${header}\r\n`)?.[1] ?? '0');
      const complete = boundary + 4 + length;
      if (request.length < complete) return;
      answered = true;
      requests.push(request.subarray(0, complete));
      const body = Buffer.from(
        JSON.stringify({
          answers: { decision: { type: 'noul', noul: value } },
          model: 'e13-owner-model',
          usage: { input_tokens: 9, output_tokens: 1 },
        }),
      );
      socket.end(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
          ),
          body,
        ]),
      );
    });
  });
  return { ...receiver, requests };
}

async function ownerFixture(outcome: 'match' | 'hold') {
  // One clock near real time for the owner, the Gmail fake and stored timestamps: parts of the owner read SQLite's
  // clock, and the file's synthetic future NOW made a fresh delivery look long past its retention.
  const ownerNow = Date.now();
  const root = await shortTempDir(`events-e13-owner-${outcome}-`);
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const ids = ownerIds(outcome);
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({ version: 1, secrets: { store: 'file' } })}\n`);
  const email = `owner-${outcome}@example.test`;
  const subject = `Synthetic owner ${outcome} event`;
  const google = await startFakeGoogle({
    clientId: TEST_CLIENT_ID,
    clientSecret: TEST_CLIENT_SECRET,
    now: () => ownerNow,
    accounts: [
      {
        sub: `e13-owner-${outcome}-subject`,
        email,
        profile: { historyId: '201' },
        history: {
          pages: {
            first: {
              historyId: '202',
              history: [
                {
                  id: '202',
                  messagesAdded: [{ message: { id: `message-e13-owner-${outcome}`, threadId: 'thread-e13-owner' } }],
                },
              ],
            },
          },
        },
        messages: {
          [`message-e13-owner-${outcome}`]: {
            id: `message-e13-owner-${outcome}`,
            threadId: 'thread-e13-owner',
            labelIds: ['INBOX'],
            internalDate: String(ownerNow),
            snippet: subject,
            payload: {
              partId: '',
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Synthetic Sender <sender@example.test>' },
                { name: 'Subject', value: subject },
              ],
              body: { size: 0 },
            },
          },
        },
      },
    ],
  });
  google.server.on('error', () => undefined);
  google.server.on('connection', (socket) => socket.on('error', () => undefined));
  let systemOne: Awaited<ReturnType<typeof startSystemOneFake>> | undefined;
  try {
    systemOne = await startSystemOneFake(outcome === 'match' ? 0.75 : 0.45);
    const env: NodeJS.ProcessEnv = {
      AGENT_COMMS_CONFIG_DIR: configDir,
      AGENT_COMMS_GOOGLE_ROOT_URL: google.url,
      HOME: configDir,
      USERPROFILE: configDir,
      NO_COLOR: '1',
      AGENT_COMMS_CLIENT_CLI_DIRS: '',
      AGENT_COMMS_UPDATE_CHECK: 'off',
    };
    const core = openCore({ env, caller: GMAIL_CALLER, now: () => new Date(ownerNow) });
    const endpoints = resolveEndpoints(env);
    const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
    const redirectUri = 'http://127.0.0.1:5123/';
    const pkce = newPkce();
    const authUrl = buildAuthUrl({
      client,
      endpoints,
      redirectUri,
      scopes: [SCOPES.gmailModify],
      state: 'e13-state',
      codeChallenge: pkce.challenge,
    });
    const code = new URL(google.consent(authUrl)).searchParams.get('code');
    assert.equal(typeof code, 'string', 'the repository Gmail fake issues one synthetic authorisation code');
    const tokens = await exchangeCode({
      client,
      endpoints,
      code: code as string,
      codeVerifier: pkce.verifier,
      redirectUri,
    });
    const secrets = await core.secrets('file');
    await secrets.set(clientSecretRef('default'), TEST_CLIENT_SECRET);
    await secrets.set(refreshTokenRef(ids.accountId), tokens.refreshToken);
    await core.config.update((config) => ({
      ...config,
      secrets: { store: 'file' },
      clients: {
        ...config.clients,
        default: {
          provider: 'gmail',
          clientId: TEST_CLIENT_ID,
          secretRef: clientSecretRef('default'),
          addedAt: new Date(ownerNow).toISOString(),
        },
      },
      inboxes: {
        ...config.inboxes,
        [`owner-${outcome}`]: {
          id: ids.accountId,
          provider: 'gmail',
          email,
          sub: `e13-owner-${outcome}-subject`,
          identity: 'oidc',
          client: 'default',
          tier: 'read',
          contacts: false,
          grantedScopes: [SCOPES.gmailModify],
          secretRef: refreshTokenRef(ids.accountId),
          internalDomains: [],
          createdAt: new Date(ownerNow).toISOString(),
        },
      },
    }));
    const selected = await openEventDatabase({ stateDir });
    try {
      await selectEventSecretStore(selected.database, 'file');
    } finally {
      selected.close();
    }
    const startOwner = () =>
      startEventOwner({
        stateDir,
        configDir,
        tickMs: 60_000,
        pollIntervalMs: 60_000,
        now: () => ownerNow,
        gmailSourceFor: async ({ alias }) =>
          createGmailEventSource({ alias, context: new GmailContext({ core, env }) }),
      });
    return { root, stateDir, ids, subject, google, systemOne, startOwner };
  } catch (error) {
    await systemOne?.close();
    await google.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function approveOwnerIntent(control: EventControlClient, prepared: unknown, description: string): Promise<void> {
  assert.equal(
    typeof (prepared as { readonly approvalId?: unknown }).approvalId,
    'string',
    `${description} returns an approval id from the production owner`,
  );
  const approvalId = (prepared as { readonly approvalId: string }).approvalId;
  const challenge = await control.request('approve-challenge', { approvalId });
  assert.equal(typeof challenge, 'string', `${description} obtains its challenge through the owner control protocol`);
  const completed = (await control.request('approve', { approvalId, answer: challenge })) as {
    readonly status?: unknown;
  };
  assert.equal(completed.status, 'completed', `${description} completes through the owner control protocol`);
}

async function activateOwnerRule(
  control: EventControlClient,
  setup: Awaited<ReturnType<typeof ownerFixture>>,
  onUncertain: 'no-match' | 'hold',
): Promise<void> {
  const target = { targetId: setup.ids.targetId, version: 1, kind: 'dry-run' as const, retentionMs: 3_600_000 };
  const judge = {
    judgeId: setup.ids.judgeId,
    version: 1,
    kind: 'local-endpoint' as const,
    provider: 'ollama',
    model: 'e13-owner-model',
    endpoint: `http://127.0.0.1:${setup.systemOne.port}/v1/systemone`,
    approvedAddressSet: ['127.0.0.1'] as const,
    promptTemplate: 'ollama-noul-v1',
    protocol: 'noul' as const,
  };
  await control.request('target-add', { document: target });
  await control.request('addJudge', { document: judge });
  await approveOwnerIntent(
    control,
    await control.request('enableJudgeKind', { kind: 'local-endpoint' }),
    'local-endpoint kind enablement',
  );
  await approveOwnerIntent(
    control,
    await control.request('updateBudget', {
      document: {
        budgetId: 'judge-budget',
        version: 1,
        global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 },
        providers: [
          { provider: 'ollama', callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 },
        ],
      },
    }),
    'judge budget activation',
  );
  const document = {
    ruleId: setup.ids.ruleId,
    version: 1,
    source: {
      channel: 'gmail' as const,
      accountIds: [setup.ids.accountId],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received' as const, version: 1 },
    condition: { path: '/subject', op: 'exists' as const },
    agentic: {
      judge,
      question: 'Does this synthetic owner event require attention?',
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
      deliveryMs: 3_600_000,
      dryrunMs: 3_600_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
  };
  await control.request('rule-create', { document });
  await approveOwnerIntent(
    control,
    await control.request('rule-enable', { ruleId: document.ruleId, version: 1 }),
    'agentic rule activation',
  );
  await approveOwnerIntent(control, await control.request('enable-all'), 'global event enablement');
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

function assertOwnerJudgeRequest(request: Buffer, subject: string, description: string): void {
  const body = exactRequestBody(request) as { readonly state?: unknown };
  assert.equal(typeof body.state, 'string', `${description} sends one typed System One state string`);
  assert.deepEqual(
    { ...body, state: JSON.parse(body.state as string) },
    {
      model: 'e13-owner-model',
      questions: {
        decision: { instructions: 'Does this synthetic owner event require attention?', type: 'noul' },
      },
      state: { inputs: [{ pointer: '/subject', value: subject }], version: 1 },
    },
    `${description} sends only the approved Gmail subject inside the fixed judge envelope`,
  );
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

test('E13 final owner E2E: Gmail source reaches a local judge match through control approvals and owner restart', {
  skip: WINDOWS_SKIP,
}, async () => {
  const before = lastingResources();
  refusedNetwork.length = 0;
  const setup = await ownerFixture('match');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    owner = await setup.startOwner();
    const control = new EventControlClient({ stateDir: setup.stateDir, clientName: 'events-e13-owner-match' });
    await activateOwnerRule(control, setup, 'no-match');
    // As the Phase D owner E2E does: polling, evaluation, delivery and its dispatch take more than one tick.
    for (let index = 0; index < 4; index += 1) await owner.tick();
    assert.equal(
      setup.systemOne.requests.length,
      1,
      'the owner-level match reaches the production judge coordinator exactly once',
    );
    assertOwnerJudgeRequest(
      setup.systemOne.requests[0] ?? Buffer.alloc(0),
      setup.subject,
      'the production owner match',
    );
    const delivered = (await control.request('dryrun-list')) as readonly { readonly state?: string }[];
    assert.equal(delivered.length, 1, 'the matched owner path reaches its local dry-run target');

    await owner.stop();
    owner = undefined;
    owner = await setup.startOwner();
    const restarted = new EventControlClient({
      stateDir: setup.stateDir,
      clientName: 'events-e13-owner-match-restart',
    });
    await owner.tick();
    assert.equal(
      ((await restarted.request('dryrun-list')) as readonly unknown[]).length,
      1,
      'stopping and starting the owner preserves the matched local delivery',
    );
    assert.equal(
      setup.systemOne.requests.length,
      1,
      'the restarted owner does not re-judge the already terminal Gmail event',
    );
    assert.equal(
      setup.google.requests.filter((request) => request.path.endsWith(DRAFT_SEND_PATH)).length,
      0,
      'the owner-level judge flow never reaches Gmail send',
    );
    assert.deepEqual(refusedNetwork, [], 'the sealed owner-level match makes no non-loopback network attempt');
  } finally {
    await owner?.stop();
    await setup.systemOne.close();
    await setup.google.close();
    await rm(setup.root, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lastingResources(), before, 'the owner-level match closes every owner, server, socket and timer');
});

test('E13 final owner E2E: Gmail source reaches a durable local-judge hold through control approvals and owner restart', {
  skip: WINDOWS_SKIP,
}, async () => {
  const before = lastingResources();
  refusedNetwork.length = 0;
  const setup = await ownerFixture('hold');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    owner = await setup.startOwner();
    const control = new EventControlClient({ stateDir: setup.stateDir, clientName: 'events-e13-owner-hold' });
    await activateOwnerRule(control, setup, 'hold');
    await owner.tick();
    assert.equal(setup.systemOne.requests.length, 1, 'the owner-level hold reaches the production judge exactly once');
    assertOwnerJudgeRequest(setup.systemOne.requests[0] ?? Buffer.alloc(0), setup.subject, 'the production owner hold');
    const held = (await control.request('heldList')) as {
      readonly kind: string;
      readonly decisions: readonly { readonly decisionId: string }[];
    };
    assert.deepEqual(
      { kind: held.kind, count: held.decisions.length },
      { kind: 'held-list', count: 1 },
      'the production owner control protocol exposes one content-free held decision',
    );
    assert.equal(
      ((await control.request('deliveriesList')) as readonly unknown[]).length,
      0,
      'the held owner path creates no target delivery',
    );

    await owner.stop();
    owner = undefined;
    owner = await setup.startOwner();
    const restarted = new EventControlClient({ stateDir: setup.stateDir, clientName: 'events-e13-owner-hold-restart' });
    const afterRestart = (await restarted.request('heldList')) as { readonly decisions: readonly unknown[] };
    assert.equal(
      afterRestart.decisions.length,
      1,
      'stopping and starting the production owner preserves the durable hold',
    );
    await owner.tick();
    assert.equal(
      setup.systemOne.requests.length,
      1,
      'the restarted owner does not re-ask the judge for an already held Gmail event',
    );
    assert.equal(
      setup.google.requests.filter((request) => request.path.endsWith(DRAFT_SEND_PATH)).length,
      0,
      'the owner-level hold flow never reaches Gmail send',
    );
    assert.deepEqual(refusedNetwork, [], 'the sealed owner-level hold makes no non-loopback network attempt');
  } finally {
    await owner?.stop();
    await setup.systemOne.close();
    await setup.google.close();
    await rm(setup.root, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lastingResources(), before, 'the owner-level hold closes every owner, server, socket and timer');
});
