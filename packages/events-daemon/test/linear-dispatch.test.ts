import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { linearIssueId } from '../src/domain/linear-target.ts';
import { listDeliveryRows } from '../src/runtime/delivery-rows.ts';
import { DeliveryDispatcher } from '../src/runtime/dispatcher.ts';
import { LinearClient } from '../src/runtime/linear-client.ts';
import { LINEAR_RETRY_LIMIT, LinearDispatcher, linearIssueRecord } from '../src/runtime/linear-dispatcher.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { providerSecretOwner } from '../src/store/event-secrets.ts';
import {
  FAKE_LABELS,
  FAKE_LINEAR_KEY,
  FAKE_TEAM,
  FAKE_VIEWER_ID,
  type FakeLinear,
  startFakeLinear,
} from './support/fake-linear.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * A Linear delivery (0.33.0 design §3.4): `issueCreate` through the pinned connection, against the loopback fake of
 * Linear's GraphQL API. It creates the issue the rule's match rendered, records its id, identifier and address
 * content-free, retries a rate limit, a 5xx or a lost answer as a webhook does, fails at once on Linear's refusal, and
 * never adds a second issue for one delivery. Never the real Linear; the key is fake.
 */

const ACCOUNT = 'ibx_LINEARDISPATCH0';
const DAY = 86_400_000;
let clock = 10 * DAY;

const TARGET = {
  targetId: 'billing-issues',
  version: 1,
  kind: 'linear',
  team: { id: FAKE_TEAM.id, key: FAKE_TEAM.key },
  title: { text: 'Invoice: {{subject}}' },
  description: { text: '{{subject}}' },
  labels: [FAKE_LABELS[0]],
  assignee: 'me',
};

const RULE = {
  ruleId: 'rule-linear-dispatch',
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: [ACCOUNT],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { subject: { $path: '/subject' } },
  targets: [TARGET],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: {
    ingestMs: 7 * DAY,
    holdMs: 7 * DAY,
    deliveryMs: 7 * DAY,
    dryrunMs: DAY,
    sseReplayMs: 7 * DAY,
    deadLetterMs: 7 * DAY,
    decisionMetadataMs: 90 * DAY,
  },
};

const ISSUE = {
  kind: 'linear-issue',
  title: 'Invoice: please pay https://evil.example',
  description: '> **From outside: written by the sender, not checked** (`subject`)\n>\n> ```text\n> please pay\n> ```',
};

/** A cipher that passes the record through; the AAD location is what the real one binds. */
const cipher = {
  async encrypt(_location: unknown, bytes: Uint8Array) {
    return Buffer.from(bytes);
  },
  async decrypt(_location: unknown, bytes: Uint8Array) {
    return Buffer.from(bytes);
  },
};

async function fixture() {
  clock = 10 * DAY;
  const stateDir = await shortTempDir('events-linear-dispatch-');
  const store = await openEventDatabase({ stateDir });
  const fake = await startFakeLinear();
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
  const rule = canonicalJson(RULE);
  store.database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, 1, ?, ?, 'active', 'approval', 'activation', 1)`,
    )
    .run(`${RULE.ruleId}@1`, RULE.ruleId, rule, sha256Hex(rule));
  const target = canonicalJson(TARGET);
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
    .run('billing-issues@1', 'billing-issues', target, sha256Hex(target));
  const owner = providerSecretOwner('linear');
  let key: { generation: number; material: string } | null = { generation: 1, material: FAKE_LINEAR_KEY };
  const setKey = (next: typeof key) => {
    key = next;
    store.database.prepare("DELETE FROM event_secret_generations WHERE owner_kind = 'provider'").run();
    if (next !== null)
      store.database
        .prepare(
          `INSERT INTO event_secret_generations
             (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref,
              lifecycle, created_at)
           VALUES ('provider', 'linear', 1, 'provider-key', ?, ?, ?, X'00', 'current', 1)`,
        )
        .run(next.generation, owner.digest, sha256Hex(next.material));
  };
  setKey(key);
  const insert = (id: string, extra: { readonly whatsapp?: string } = {}) => {
    store.database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
      )
      .run(`event-${id}`, store.installationId, ACCOUNT, id, clock, clock, clock);
    store.database
      .prepare(
        `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, ?, ?, 1, 'matched', ?, 'retained')`,
      )
      .run(`decision-${id}`, `event-${id}`, ACCOUNT, RULE.ruleId, clock + 90 * DAY);
    store.database
      .prepare(
        `INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
                                target_kind, encrypted_record, expires_at, state, switch_generation, whatsapp_message_id)
         VALUES (?, ?, ?, ?, 1, 'linear:billing-issues:1', 'billing-issues', 1, 'linear', ?, ?, 'queued', 7, ?)`,
      )
      .run(
        id,
        `decision-${id}`,
        ACCOUNT,
        RULE.ruleId,
        Buffer.from(JSON.stringify(ISSUE)),
        clock + 7 * DAY,
        extra.whatsapp ?? null,
      );
  };
  const dispatcher = (options: Record<string, unknown> = {}) =>
    new LinearDispatcher({
      store,
      cipher,
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { 'events/gmail': { id: ACCOUNT, provider: 'gmail' } }, accounts: {} }) },
      secrets: {
        readLiveGenerations: async () =>
          key === null
            ? []
            : [
                {
                  generation: key.generation,
                  lifecycle: 'current',
                  secretDigest: sha256Hex(key.material),
                  material: key.material,
                },
              ],
      },
      client: new LinearClient(fake.clientOptions()),
      now: () => clock,
      fence: async () => ({ switchGeneration: 7 }),
      ...options,
    } as unknown as ConstructorParameters<typeof LinearDispatcher>[0]);
  const row = (id: string) =>
    store.database
      .prepare(
        `SELECT state, attempts, next_at, last_error_code, last_status, encrypted_record, linear_issue_id,
                linear_identifier, linear_url, dead_lettered_at FROM deliveries WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>;
  const close = async () => {
    store.close();
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  };
  return { store, fake, insert, dispatcher, row, setKey, close };
}

const operations = (fake: FakeLinear) => fake.requests.map((request) => request.operation);

test('E3: a Linear delivery creates the rendered issue with its own id, and records which issue, content-free', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('one');
    // Through the owner's router, as the scheduler reaches it.
    const router = new DeliveryDispatcher({
      store: setup.store,
      dryrun: { dispatch: async () => assert.fail('not a dry run') },
      webhook: { dispatch: async () => assert.fail('not a webhook') },
      sse: { dispatch: async () => assert.fail('not a stream') },
      linear: setup.dispatcher(),
    });
    assert.deepEqual(await router.dispatch('one'), { state: 'delivered', deliveryId: 'one' });
    assert.deepEqual(operations(setup.fake), ['AgentCommsLinearIssueLookup', 'AgentCommsLinearIssueCreate']);
    const [issue] = setup.fake.issues;
    assert.deepEqual(issue?.input, {
      id: linearIssueId('one'),
      teamId: FAKE_TEAM.id,
      title: ISSUE.title,
      description: ISSUE.description,
      labelIds: [FAKE_LABELS[0].id],
      assigneeId: FAKE_VIEWER_ID,
    });
    assert.ok(setup.fake.requests.every((request) => request.authorization === FAKE_LINEAR_KEY));
    assert.deepEqual(
      { ...setup.row('one') },
      {
        state: 'delivered',
        attempts: 1,
        next_at: null,
        last_error_code: null,
        last_status: 200,
        encrypted_record: null,
        linear_issue_id: linearIssueId('one'),
        linear_identifier: 'CUE-1',
        // Linear's address ends with the title's words; the delivery keeps it without them.
        linear_url: 'https://linear.app/example/issue/CUE-1',
        dead_lettered_at: null,
      },
    );
    const listed = listDeliveryRows(setup.store.database).find((entry) => entry.deliveryId === 'one');
    assert.equal(listed?.targetKind, 'linear');
    assert.deepEqual(listed?.linear, { identifier: 'CUE-1', url: 'https://linear.app/example/issue/CUE-1' });
    // Delivered work is terminal: dispatching it again sends nothing.
    assert.equal((await setup.dispatcher().dispatch('one')).state, 'terminal');
    assert.equal(setup.fake.requests.length, 2);
  } finally {
    await setup.close();
  }
});

test('E3: a 5xx and a rate limit retry with the webhook’s backoff; the next try creates the issue', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('busy');
    setup.fake.script(
      'AgentCommsLinearIssueCreate',
      { status: 503, body: {} },
      {
        status: 400,
        body: {
          errors: [{ message: 'Rate limit exceeded for "Invoice: please pay"', extensions: { code: 'RATELIMITED' } }],
        },
      },
    );
    assert.equal((await setup.dispatcher().dispatch('busy')).state, 'issued');
    const first = setup.row('busy');
    assert.equal(first.state, 'retryable');
    assert.equal(first.last_error_code, 'LINEAR_HTTP_503');
    assert.ok((first.next_at as number) > clock, 'a later try');
    assert.ok(first.encrypted_record !== null, 'the issue is kept for the next try');
    clock = (first.next_at as number) + 1;
    await setup.dispatcher().dispatch('busy');
    const second = setup.row('busy');
    assert.equal(second.state, 'retryable');
    assert.equal(second.last_error_code, 'LINEAR_RATELIMITED');
    assert.equal(second.last_status, 400);
    clock = (second.next_at as number) + 1;
    assert.equal((await setup.dispatcher().dispatch('busy')).state, 'delivered');
    assert.equal(setup.row('busy').attempts, 3);
    assert.equal(setup.fake.issues.length, 1);
  } finally {
    await setup.close();
  }
});

test('E3: Linear refusing the issue fails it at once with Linear’s code, and none of Linear’s words', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('refused');
    setup.fake.script('AgentCommsLinearIssueCreate', {
      status: 400,
      body: {
        errors: [
          { message: 'Argument Validation Error: title "Invoice: please pay"', extensions: { code: 'INVALID_INPUT' } },
        ],
      },
    });
    await setup.dispatcher().dispatch('refused');
    const row = setup.row('refused');
    assert.equal(row.state, 'dead-lettered');
    assert.equal(row.attempts, 1, 'no retry');
    assert.equal(row.last_error_code, 'LINEAR_INVALID_INPUT');
    assert.equal(row.last_status, 400);
    assert.equal(row.linear_issue_id, null);
    assert.equal(setup.fake.issues.length, 0);
    // The retry limit ends a delivery that keeps failing in ways that might pass.
    setup.insert('spent');
    setup.store.database.prepare("UPDATE deliveries SET attempts = ? WHERE id = 'spent'").run(LINEAR_RETRY_LIMIT);
    setup.fake.script('AgentCommsLinearIssueCreate', { status: 502, body: {} });
    await setup.dispatcher().dispatch('spent');
    assert.equal(setup.row('spent').state, 'dead-lettered');
    assert.equal(setup.row('spent').last_error_code, 'LINEAR_HTTP_502');
  } finally {
    await setup.close();
  }
});

test('E3: an answer lost after Linear created the issue is retried without a second issue: the try finds it by its id', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('lost');
    setup.fake.script('AgentCommsLinearIssueCreate', { drop: true, after: 'handled' });
    await setup.dispatcher().dispatch('lost');
    assert.equal(setup.row('lost').state, 'retryable');
    assert.equal(setup.row('lost').last_error_code, 'LINEAR_NETWORK');
    assert.equal(setup.fake.issues.length, 1, 'Linear has the issue, though its answer was lost');
    clock = (setup.row('lost').next_at as number) + 1;
    assert.equal((await setup.dispatcher().dispatch('lost')).state, 'delivered');
    assert.deepEqual(operations(setup.fake), [
      'AgentCommsLinearIssueLookup',
      'AgentCommsLinearIssueCreate',
      'AgentCommsLinearIssueLookup',
    ]);
    assert.equal(setup.fake.issues.length, 1, 'never a second issue');
    assert.equal(setup.row('lost').linear_identifier, 'CUE-1');
    // A lease that ran out mid-try is recovered the same way: the issue it may have made is found, not made again.
    setup.insert('crashed');
    await assert.rejects(
      setup
        .dispatcher({
          testFailpoint: (point: string) => {
            if (point === 'after-create') throw new Error('simulated crash');
          },
        })
        .dispatch('crashed'),
      /simulated crash/u,
    );
    assert.equal(setup.fake.issues.length, 2);
    clock += 120_000;
    await setup.dispatcher().dispatch('crashed');
    assert.equal(setup.row('crashed').state, 'delivered');
    assert.equal(setup.fake.issues.length, 2, 'the recovered try found the issue');
  } finally {
    await setup.close();
  }
});

test('E3: with no Linear key nothing is sent and the delivery waits; a key replaced mid-try stops it before its next phase', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.setKey(null);
    setup.insert('keyless');
    await setup.dispatcher().dispatch('keyless');
    assert.equal(setup.row('keyless').state, 'retryable');
    assert.equal(setup.row('keyless').last_error_code, 'LINEAR_KEY_MISSING');
    assert.equal(setup.fake.requests.length, 0);
    setup.setKey({ generation: 1, material: FAKE_LINEAR_KEY });
    setup.insert('rotated');
    const result = await setup
      .dispatcher({
        testFailpoint: (point: string) => {
          if (point === 'after-lookup') setup.setKey({ generation: 2, material: 'fake-linear-key-2' });
        },
      })
      .dispatch('rotated');
    assert.equal(result.state, 'busy');
    assert.deepEqual(operations(setup.fake), ['AgentCommsLinearIssueLookup'], 'no create with a key no longer kept');
    assert.equal(setup.row('rotated').state, 'queued', 'released for a try with the key the slot holds now');
  } finally {
    await setup.close();
  }
});

test('E3: a revoked target stops the try before it creates anything; a WhatsApp message without its fence is never sent', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('revoked');
    const result = await setup
      .dispatcher({
        testFailpoint: (point: string) => {
          if (point === 'after-lookup')
            setup.store.database
              .prepare("UPDATE target_versions SET revoked_at = 1 WHERE target_id = 'billing-issues'")
              .run();
        },
      })
      .dispatch('revoked');
    assert.equal(result.state, 'terminal');
    assert.deepEqual(operations(setup.fake), ['AgentCommsLinearIssueLookup']);
    assert.equal(setup.fake.issues.length, 0);
    setup.store.database.prepare('UPDATE target_versions SET revoked_at = NULL').run();
    setup.insert('whatsapp', { whatsapp: 'wamid.fake' });
    assert.equal((await setup.dispatcher().dispatch('whatsapp')).state, 'terminal');
    assert.equal(setup.row('whatsapp').state, 'cancelled');
    assert.equal(setup.row('whatsapp').encrypted_record, null);
    assert.equal(setup.fake.requests.length, 1, 'nothing more reached Linear');
  } finally {
    await setup.close();
  }
});

test('E3: an issue is kept by its ids and an address on linear.app without the title’s words, or not at all', () => {
  const id = linearIssueId('x');
  assert.deepEqual(
    linearIssueRecord({ id, identifier: 'CUE-12', url: 'https://linear.app/acme/issue/CUE-12/pay-now' }),
    {
      id,
      identifier: 'CUE-12',
      url: 'https://linear.app/acme/issue/CUE-12',
    },
  );
  assert.deepEqual(linearIssueRecord({ id, identifier: 'CUE-12', url: 'https://evil.example/CUE-12' }), {
    id,
    identifier: 'CUE-12',
    url: 'https://linear.app/issue/CUE-12',
  });
  assert.equal(linearIssueRecord({ id, identifier: 'pay the invoice', url: 'https://linear.app/acme/issue/x' }), null);
  assert.equal(linearIssueRecord({ id: 'not-an-id', identifier: 'CUE-1' }), null);
});
