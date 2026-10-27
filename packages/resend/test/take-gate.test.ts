import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { asV2, CommsError, type Config, type TakeCaller, type TakeHolder } from '@agentcomms/core';
import type { SendInput } from '../src/compose/message.ts';
import { ResendContext } from '../src/context.ts';
import { listReceived, showReceived } from '../src/operations/read.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import { takeMessage } from '../src/operations/take.ts';
import { type Harness, newHarness } from './support/harness.ts';

/*
 * Taking messages, for Resend (design 2026-10-26-taking-messages §6, T7): a reply — a send with In-Reply-To — needs
 * the take of the received email it answers, at prepare and again before the claim; another session's take is
 * respected whether or not a take is required; and reads say who has each email in closed words. Everything runs
 * against the loopback fake with fake keys, a temporary home and synthetic sessions: nothing reaches Resend, and
 * nothing reads the real home.
 */

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

const RECEIVED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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

async function requireTaking(on: boolean): Promise<void> {
  const accountId = (await harness.core.config.load()).accounts['acme/resend']?.id;
  await harness.core.config.update(
    (config): Config => ({ ...config, taking: { accounts: [{ accountId, account: 'acme/resend', required: on }] } }),
    on ? {} : { consent: { kind: 'loosening-consent', paths: ['taking.acme/resend.required'] } },
  );
}

const reply = (over: Partial<SendInput> = {}): SendInput => ({
  from: 'Acme <hello@acme.test>',
  to: ['david@client.test'],
  subject: 'Re: Invoice 7',
  text: 'Here it is again.',
  inReplyTo: `<${MESSAGE_ID}>`,
  ...over,
});

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

// ── A reply needs the take (§6), and reads say who has it ─────────────────────────────────────────────────────

test('with a take required, a reply is refused at prepare until the session takes the email it answers', async () => {
  await ready();
  await requireTaking(true);
  const alice = as(ALICE);
  const approvals = (await harness.core.approvals.list()).length;
  const refused = await refusal(prepareSend(alice, 'acme/resend', reply()));
  assert.equal(refused.code, 'TAKE_REQUIRED');
  assert.equal(refused.exitCode, 10);
  assert.equal(refused.details?.reason, 'NOT_TAKEN');
  assert.equal(refused.details?.act, 'resend.send.prepare');
  assert.equal(refused.details?.inReplyTo, MESSAGE_ID);
  assert.match(refused.hint ?? '', /resend_take \(step "take"\)/);
  assert.equal((await harness.core.approvals.list()).length, approvals, 'no approval was made');
  assert.equal(harness.fake.sends().length, 0);

  await takeMessage(alice, 'acme/resend', RECEIVED, { step: 'take' });
  const prepared = await prepareSend(alice, 'acme/resend', reply());
  assert.match(prepared.preview, /^Taken by this session at \d\d:\d\d\.$/m);
  const [listed] = await harness.core.takes.list();
  assert.ok(listed !== undefined && 'record' in listed);
  assert.deepEqual(listed.record.pins, [prepared.approvalId], 'the take is pinned while the approval waits');
  await executeSend(alice, 'acme/resend', { approvalId: prepared.approvalId });
  assert.equal(harness.fake.sends().length, 1);
});

test('a take released between prepare and send means nothing is sent, and the approval is not spent', async () => {
  await ready();
  await requireTaking(true);
  const alice = as(ALICE);
  await takeMessage(alice, 'acme/resend', RECEIVED, { step: 'take' });
  const prepared = await prepareSend(alice, 'acme/resend', reply());
  const ref = {
    channel: 'resend' as const,
    accountId: (await harness.core.config.load()).accounts['acme/resend']?.id as string,
    id: RECEIVED,
  };
  await harness.core.takes.release(ref, { folder: null, ancestors: [] });
  const refused = await refusal(executeSend(alice, 'acme/resend', { approvalId: prepared.approvalId }));
  assert.equal(refused.code, 'TAKE_REQUIRED');
  assert.equal(refused.details?.act, 'resend.send.execute');
  assert.equal(harness.fake.sends().length, 0, 'nothing was sent');
  assert.equal(
    asV2(await harness.core.approvals.get(prepared.approvalId))?.state,
    'pending',
    'the approval is unspent',
  );

  // Kept by the person in between: refused the same way, in their words.
  await takeMessage(alice, 'acme/resend', RECEIVED, { step: 'take' });
  await harness.core.takes.keep({ ...ref, thread: null }, { folder: null, ancestors: [] });
  const kept = await refusal(executeSend(alice, 'acme/resend', { approvalId: prepared.approvalId }));
  assert.equal(kept.code, 'TAKEN_ELSEWHERE');
  assert.equal(kept.details?.reason, 'PERSON');
  // A refusal before the claim says where the approval stands: unspent.
  assert.equal((kept.details?.approval as { state?: string } | undefined)?.state, 'pending');
  assert.equal(harness.fake.sends().length, 0);
});

test('without a take required nothing is demanded, but another session’s take is still respected', async () => {
  await ready();
  const alice = as(ALICE);
  const bob = as(BOB);
  // Nobody has it: a reply goes as before.
  const free = await prepareSend(alice, 'acme/resend', reply());
  assert.doesNotMatch(free.preview, /Taken by this session/);
  // Bob takes it: Alice's reply is refused at prepare, and her prepared one at the claim.
  await takeMessage(bob, 'acme/resend', RECEIVED, { step: 'take' });
  const atPrepare = await refusal(prepareSend(alice, 'acme/resend', reply()));
  assert.equal(atPrepare.code, 'TAKEN_ELSEWHERE');
  namesNoneOfBob({ message: atPrepare.message, hint: atPrepare.hint, details: atPrepare.details });
  const atClaim = await refusal(executeSend(alice, 'acme/resend', { approvalId: free.approvalId }));
  assert.equal(atClaim.code, 'TAKEN_ELSEWHERE');
  assert.equal(harness.fake.sends().length, 0);
});

test('two received emails with one Message-ID: a reply answers both, so it passes only where its session may act on each', async () => {
  // Security review of 0.35.0 (LOW): the reply's take was found by Message-ID alone, and the first record found decided —
  // so a session holding a forged copy that carries David's Message-ID could reply into David's thread, which another
  // session held. Each copy is now asked by its own account and id.
  await ready();
  const FORGED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  harness.fake.received.push({
    id: FORGED,
    from: 'Someone <someone@elsewhere.test>',
    to: ['hello@acme.test'],
    subject: 'Re: Invoice 7',
    text: 'Reply here instead.',
    message_id: `<${MESSAGE_ID}>`,
  });
  const alice = as(ALICE);
  const bob = as(BOB);
  await takeMessage(alice, 'acme/resend', RECEIVED, { step: 'take' });
  await takeMessage(bob, 'acme/resend', FORGED, { step: 'take' });
  for (const required of [false, true]) {
    await requireTaking(required);
    for (const [who, context] of [
      ['Bob', bob],
      ['Alice', alice],
    ] as const) {
      const refused = await refusal(prepareSend(context, 'acme/resend', reply()));
      assert.equal(refused.code, 'TAKEN_ELSEWHERE', `${who}, required ${required}: ${refused.message}`);
      assert.equal(refused.details?.reason, 'HELD');
    }
  }
  assert.equal(harness.fake.sends().length, 0);
  // Once one session holds every copy, its reply goes.
  await takeMessage(bob, 'acme/resend', FORGED, { step: 'hand-back', reason: 'duplicate' });
  await takeMessage(alice, 'acme/resend', FORGED, { step: 'take' });
  const prepared = await prepareSend(alice, 'acme/resend', reply());
  assert.match(prepared.preview, /^Taken by this session at \d\d:\d\d\.$/m);
  await assert.rejects(prepareSend(bob, 'acme/resend', reply()), { code: 'TAKEN_ELSEWHERE' });
});

test('a new email answers nobody, and is not gated; the person at a terminal is never held to taking', async () => {
  await ready();
  await requireTaking(true);
  const fresh = await prepareSend(as(ALICE), 'acme/resend', reply({ inReplyTo: undefined, subject: 'Hello' }));
  assert.match(fresh.approvalId, /^ap_/);
  const person = await prepareSend(as(null, 'cli'), 'acme/resend', reply());
  assert.match(person.approvalId, /^ap_/);
});

test('the received list and one received email say who has each, in closed words', async () => {
  await ready();
  await takeMessage(as(BOB), 'acme/resend', RECEIVED, { step: 'take' });
  const alice = as(ALICE);
  const listed = await listReceived(alice, 'acme/resend');
  assert.ok(listed.available);
  const byId = Object.fromEntries(listed.emails.map((email) => [email.id, email.taken]));
  assert.deepEqual(byId[OTHER], null);
  assert.equal(byId[RECEIVED]?.by, 'another session');
  namesNoneOfBob(byId);
  const shown = await showReceived(alice, 'acme/resend', RECEIVED);
  assert.ok(shown.available);
  assert.equal((shown.email.taken as { by?: string } | null)?.by, 'another session');
  const mine = await showReceived(as(BOB), 'acme/resend', RECEIVED);
  assert.ok(mine.available);
  assert.equal((mine.email.taken as { by?: string } | null)?.by, 'you');
});
