import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CommsError, type TakeCaller, type TakeHolder } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ResendContext } from '../src/context.ts';
import { createResendMcpServer } from '../src/mcp/server.ts';
import { takeMessage, takenMessages } from '../src/operations/take.ts';
import { type Harness, newHarness, ok, refused, type ToolResult } from './support/harness.ts';

/*
 * Taking messages, for Resend (design 2026-10-26-taking-messages §5, T5, T7): a session takes a received email before
 * it replies to it, hands one back or marks it done, and asks who has an email — the take reads the email first, and
 * another session learns only closed words. Everything runs against the loopback fake with fake keys, a temporary home
 * and synthetic sessions: nothing reaches Resend, and nothing reads the real home.
 */

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

const RECEIVED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MESSAGE_ID = 'invoice-7@client.test';

const ALICE: TakeHolder = {
  key: 'aaaaaaaaaaaaaaaa',
  grouped: true,
  process: 'a1a1a1a1a1a1',
  sessionId: null,
  parent: null,
  folder: '/example/home/work/acme-site',
  client: { name: 'claude-code', version: '2.1.0' },
};
const BOB: TakeHolder = {
  key: 'bbbbbbbbbbbbbbbb',
  grouped: true,
  process: 'b2b2b2b2b2b2',
  sessionId: '11111111-2222-4333-8444-555555555555',
  parent: null,
  folder: '/example/home/work/client-secret-project',
  client: { name: 'other-client', version: '9.9.9' },
};

async function ready(): Promise<void> {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send', sendPolicy: 'chat' });
  harness.fake.received = [
    {
      id: RECEIVED,
      from: 'David Park <david@client.test>',
      to: ['hello@acme.test'],
      subject: 'Invoice 7',
      text: 'Could you resend invoice 7?',
      message_id: `<${MESSAGE_ID}>`,
    },
    {
      id: OTHER,
      from: 'Sam Lee <sam@partner.test>',
      to: ['hello@acme.test'],
      subject: 'Plan',
      text: 'Hello team.',
      message_id: '<plan-1@partner.test>',
    },
  ];
}

/** A context for one session — or, `null`, the person at their own terminal. */
function as(caller: TakeCaller, surface: 'mcp' | 'cli' = 'mcp'): ResendContext {
  return new ResendContext({
    core: harness.core,
    env: harness.env,
    fetch: harness.fake.fetch,
    throttle: { intervalMs: 0 },
    surface,
    platform: 'darwin',
    takeIdentity: async () => caller,
  });
}

async function refusal(promise: Promise<unknown>): Promise<CommsError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CommsError, String(error));
    return error;
  }
  assert.fail('expected a refusal');
}

/** Asserts that `value`, as JSON, names nothing of Bob's session. */
function namesNoneOfBob(value: unknown): void {
  const text = JSON.stringify(value);
  for (const field of [
    BOB.key,
    BOB.process,
    BOB.sessionId,
    BOB.folder,
    'client-secret-project',
    'other-client',
    '9.9.9',
  ]) {
    assert.equal(text.includes(field as string), false, `it names ${field}: ${text}`);
  }
}

// ── The take and who has it (T5, T7) ──────────────────────────────────────────────────────────────────────────

test('a take reads the email first: one this account did not receive, or sent, is refused; a received one is taken', async () => {
  await ready();
  const sentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  harness.fake.sent.push({
    id: sentId,
    from: 'hello@acme.test',
    to: ['david@client.test'],
    cc: [],
    bcc: [],
    reply_to: [],
    subject: 'Out',
    html: null,
    text: 'out',
    last_event: 'delivered',
    scheduled_at: null,
    created_at: '2026-09-25T10:00:00.000Z',
    message_id: '<out-1@acme.test>',
    tags: [],
    headers: {},
    attachments: [],
  });
  const alice = as(ALICE);
  for (const id of [MISSING, sentId]) {
    const missing = await refusal(takeMessage(alice, 'acme/resend', id, { step: 'take' }));
    assert.equal(missing.code, 'NOT_FOUND', missing.message);
  }
  assert.equal((await refusal(takeMessage(alice, 'acme/resend', 'not-an-id', { step: 'take' }))).code, 'USAGE');
  const taken = await takeMessage(alice, 'acme/resend', RECEIVED.toUpperCase(), { step: 'take' });
  assert.equal(taken.account, 'acme/resend');
  assert.equal(taken.message, RECEIVED);
  assert.equal(taken.thread, null);
  assert.equal(taken.state, 'taken');
  assert.equal(taken.you, true);
  assert.deepEqual(taken.taken, { state: 'taken', by: 'you', since: taken.taken?.since, leaseUntil: taken.leaseUntil });
  const [listed] = await harness.core.takes.list();
  assert.ok(listed !== undefined && 'record' in listed);
  assert.equal(listed.record.message.rfc822Id, MESSAGE_ID, 'its Message-ID, so a reply finds its take');
  const sample = JSON.stringify(taken);
  assert.equal(sample.includes('Invoice 7') || sample.includes('david@'), false, 'nothing the sender wrote');
});

test('a sending-only key has no received email to take', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', tier: 'sending_access' });
  const refused = await refusal(takeMessage(as(ALICE), 'acme/resend', RECEIVED, { step: 'take' }));
  assert.equal(refused.code, 'SCOPE_MISSING');
  assert.equal(harness.fake.requests.length, 0, 'Resend was asked nothing');
});

test('the person at their own terminal takes nothing, and is told to keep the email instead', async () => {
  await ready();
  const result = await harness.cli(['--json', 'take', RECEIVED, '--account', 'acme/resend']);
  assert.equal(result.code, 64, result.stdout + result.stderr);
  assert.match(result.json().error?.hint ?? '', /takes keep/);
});

test('only the holder hands back or finishes; another session is refused, and learns nothing of the holder', async () => {
  await ready();
  const alice = as(ALICE);
  const bob = as(BOB);
  await takeMessage(bob, 'acme/resend', RECEIVED, { step: 'take' });
  for (const step of [{ step: 'take' }, { step: 'hand-back', reason: 'not-mine' }, { step: 'done' }]) {
    const elsewhere = await refusal(takeMessage(alice, 'acme/resend', RECEIVED, step));
    assert.equal(elsewhere.code, 'TAKEN_ELSEWHERE');
    assert.equal(elsewhere.exitCode, 10);
    assert.deepEqual(elsewhere.details, { reason: 'HELD' });
    namesNoneOfBob({ message: elsewhere.message, hint: elsewhere.hint, details: elsewhere.details });
  }
  const seen = await takenMessages(alice, 'acme/resend', [RECEIVED, OTHER]);
  assert.deepEqual(seen.messages, [
    { id: RECEIVED, taken: { state: 'taken', by: 'another session', since: seen.messages[0]?.taken?.since } },
    { id: OTHER, taken: null },
  ]);
  namesNoneOfBob(seen);
  // Bob hands it back, with a reason Alice sees and a note she never does.
  const back = await takeMessage(bob, 'acme/resend', RECEIVED, {
    step: 'hand-back',
    reason: 'not-mine',
    note: 'about the billing site',
  });
  assert.equal(back.state, 'open');
  const after = await takenMessages(alice, 'acme/resend', [RECEIVED]);
  assert.deepEqual(after.messages, [{ id: RECEIVED, taken: { state: 'open', handedBack: ['not-mine'] } }]);
  assert.equal(JSON.stringify(after).includes('billing'), false);
  // Alice takes it and finishes it; Bob stays refused.
  await takeMessage(alice, 'acme/resend', RECEIVED, { step: 'take' });
  const done = await takeMessage(alice, 'acme/resend', RECEIVED, { step: 'done', note: 'resent invoice 7' });
  assert.equal(done.state, 'done');
  assert.deepEqual((await refusal(takeMessage(bob, 'acme/resend', RECEIVED, { step: 'take' }))).details, {
    reason: 'DONE',
  });
  // With no ids, a session's own.
  assert.deepEqual(
    (await takenMessages(alice, 'acme/resend')).messages.map((entry) => entry.id),
    [RECEIVED],
  );
  assert.deepEqual((await takenMessages(bob, 'acme/resend')).messages, []);
});

async function mcpAs(caller: TakeCaller) {
  const { server } = await createResendMcpServer({
    core: harness.core,
    env: harness.env,
    fetch: harness.fake.fetch,
    throttle: { intervalMs: 0 },
    platform: 'darwin',
    takeIdentity: async () => caller,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

test('resend_take and resend_taken: the session is the server’s own, never an argument', async () => {
  await ready();
  const alice = await mcpAs(ALICE);
  try {
    const { tools } = await alice.client.listTools();
    const take = tools.find((tool) => tool.name === 'resend_take');
    const taken = tools.find((tool) => tool.name === 'resend_taken');
    assert.equal(take?.annotations?.readOnlyHint, false);
    assert.equal(take?.annotations?.openWorldHint, false);
    assert.equal(taken?.annotations?.readOnlyHint, true);
    for (const smuggled of [{ session: BOB.sessionId }, { key: BOB.key }]) {
      const result = await alice.call('resend_take', { account: 'acme/resend', email: RECEIVED, ...smuggled });
      assert.equal(refused(result).code, 'USAGE');
    }
    const result = ok(await alice.call('resend_take', { account: 'acme/resend', email: RECEIVED }));
    assert.equal(result.you, true);
    assert.equal(result.step, 'take');
    const seen = ok<{ messages: unknown[] }>(await alice.call('resend_taken', { account: 'acme/resend' }));
    assert.equal(seen.messages.length, 1);
    const back = ok(
      await alice.call('resend_take', {
        account: 'acme/resend',
        email: RECEIVED,
        step: 'hand-back',
        reason: 'duplicate',
      }),
    );
    assert.equal(back.state, 'open');
  } finally {
    await alice.close();
  }
  const bob = await mcpAs(BOB);
  try {
    // The command and the tool give one answer.
    const tool = ok(await bob.call('resend_taken', { account: 'acme/resend', emails: [RECEIVED] }));
    const command = await harness.cli(['--json', 'taken', RECEIVED, '--account', 'acme/resend']);
    assert.equal(command.code, 0, command.stdout + command.stderr);
    assert.deepEqual(command.json().data, tool);
  } finally {
    await bob.close();
  }
});
