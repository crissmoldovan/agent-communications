import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { asV2, CommsError, inlineCommand, isCommand, sendPacing } from '@agentcomms/core';
import type { ResendAccount } from '../src/accounts.ts';
import type { SendInput } from '../src/compose/message.ts';
import { ResendContext } from '../src/context.ts';
import { beginSendApproval, executeSend, finishSendApproval, prepareSend } from '../src/operations/send.ts';
import { setBehaviourRules } from './support/behaviour.ts';
import { resendHandoffs } from './support/handoffs.ts';
import { type Harness, newHarness, refused } from './support/harness.ts';

/**
 * What an agent may do, for Resend (design 2026-10-19-agent-behaviour-rules, B2–B4): a send is the act `send` — a
 * message with In-Reply-To included, since Resend has no threads here — and every recipient, To, Cc and Bcc, is a
 * place the rules must allow it at. It is checked at prepare, before any approval or preview exists, and again at
 * execute against the rules as they are then, before the approval is spent. Every send goes to the loopback fake, with
 * a fake key; nothing here reaches Resend.
 */

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

const email = (over: Partial<SendInput> = {}): SendInput => ({
  from: 'Acme <hello@acme.test>',
  to: ['sam@partner.test'],
  subject: 'Phase 2 plan',
  text: 'Hi Sam, the plan is attached to the thread.',
  ...over,
});

async function ready(sendPolicy: 'chat' | 'confirm' = 'chat'): Promise<ResendAccount> {
  harness = await newHarness();
  return harness.addAccount({ name: 'acme/resend', mode: 'send', sendPolicy });
}

/** Core's `behaviour` report, located from this package and in backticks, as a refusal's hint names it. */
function behaviourReport(): string {
  const handoff = resendHandoffs(harness.core.paths, 'darwin').core(['behaviour']);
  assert.ok(
    isCommand(handoff),
    `core's behaviour report is located here: ${'message' in handoff ? handoff.message : ''}`,
  );
  return inlineCommand(handoff);
}

/** The refusal B4 describes, with this message, for this act at this place. */
function notAllowed(message: string, place: string, rule: Record<string, string>) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'ACT_NOT_ALLOWED', error.message);
    assert.equal(error.exitCode, 10);
    assert.equal(error.retryable, false);
    assert.equal(error.message, message);
    assert.equal(error.details?.act, 'send');
    assert.equal(error.details?.place, place);
    assert.deepEqual(error.details?.rule, rule);
    // The rules are shown, never loosened: that is the person's to start.
    assert.ok(error.hint?.includes(behaviourReport()), error.hint);
    assert.doesNotMatch(error.hint ?? '', /behaviour\S* +\S*(allow|clear)\b/);
    return true;
  };
}

/** Every message stored for a send: none is, for a send that was refused at prepare. */
function preparedFiles(): string[] {
  const directory = join(harness.core.paths.stateDir, 'resend', 'prepared');
  return existsSync(directory) ? readdirSync(directory) : [];
}

/** The line after who it appears to come from: what the rules allow where this send lands. */
const allowedLine = (preview: string): string => preview.split('\n')[1] ?? '';

test('a send no rule allows is refused at prepare, from both surfaces, before any approval and before Resend is asked', async () => {
  const account = await ready();
  await setBehaviourRules(harness, [{ account: 'acme/resend', accountId: account.id, acts: ['reply'] }]);
  const approvals = (await harness.core.approvals.list()).length;
  for (const surface of ['cli', 'mcp'] as const) {
    await assert.rejects(
      prepareSend(harness.context(surface), 'acme/resend', email({ inReplyTo: '<thread-1@partner.test>' })),
      notAllowed('this agent may only reply in sam@partner.test (acme/resend)', 'sam@partner.test', {
        account: 'acme/resend',
      }),
    );
  }

  const { call, close } = await harness.mcp();
  try {
    const refusal = refused(await call('resend_send_prepare', { account: 'acme/resend', ...email() }));
    assert.equal(refusal.code, 'ACT_NOT_ALLOWED');
    assert.equal(refusal.message, 'this agent may only reply in sam@partner.test (acme/resend)');
  } finally {
    await close();
  }
  const cli = await harness.cli([
    '--json',
    'send',
    'prepare',
    '--account',
    'acme/resend',
    '--from',
    'Acme <hello@acme.test>',
    '--to',
    'sam@partner.test',
    '--subject',
    'Phase 2 plan',
    '--text',
    'Hi Sam.',
  ]);
  assert.equal(cli.code, 10, cli.stdout);
  assert.equal(cli.json().error?.code, 'ACT_NOT_ALLOWED');

  assert.equal((await harness.core.approvals.list()).length, approvals, 'no approval was prepared');
  assert.deepEqual(preparedFiles(), [], 'no message was stored');
  assert.equal(harness.fake.requests.length, 0, 'Resend was asked nothing');
});

test('one recipient in a forbidden @domain refuses the whole send, naming it, whatever the case of either', async () => {
  const account = await ready();
  await setBehaviourRules(harness, [
    { account: 'acme/resend', accountId: account.id, conversation: '@Client.TEST', acts: [] },
  ]);
  const context = harness.context('mcp');
  for (const over of [
    { cc: ['Bob@Client.TEST'] },
    { bcc: ['bob@CLIENT.test'] },
    { to: ['sam@partner.test', 'BOB@client.test'] },
  ]) {
    await assert.rejects(
      prepareSend(context, 'acme/resend', email(over)),
      notAllowed('this agent may do nothing in bob@client.test (acme/resend)', 'bob@client.test', {
        account: 'acme/resend',
        conversation: '@client.test',
      }),
      JSON.stringify(over),
    );
  }
  assert.deepEqual(preparedFiles(), []);

  // With no one there, nothing rules it.
  const elsewhere = await prepareSend(context, 'acme/resend', email());
  assert.equal(allowedLine(elsewhere.preview), 'Allowed here: everything (no rule)');
  assert.equal(harness.fake.sends().length, 0);
});

for (const policy of ['chat', 'confirm'] as const) {
  test(`tightened after the yes refuses at send, and Resend receives nothing (${policy})`, async () => {
    const account = await ready(policy);
    const context = harness.context(policy === 'chat' ? 'mcp' : 'cli');
    const prepared = await prepareSend(context, 'acme/resend', email({ cc: ['bob@client.test'] }));
    assert.equal(prepared.effectivePolicy, policy);
    if (policy === 'confirm') {
      // The person's yes, at their own terminal.
      const prompt = await beginSendApproval(context, prepared.approvalId);
      await finishSendApproval(context, prepared.approvalId, prompt.challenge);
    }
    const stateBefore = asV2(await harness.core.approvals.get(prepared.approvalId))?.state;

    // A rule that tightens applies at once: from here, only replies to anyone at client.test.
    await setBehaviourRules(harness, [
      { account: 'acme/resend', accountId: account.id, conversation: '@client.test', acts: ['reply'] },
    ]);
    await assert.rejects(
      executeSend(context, 'acme/resend', { approvalId: prepared.approvalId }),
      notAllowed('this agent may only reply in bob@client.test (acme/resend)', 'bob@client.test', {
        account: 'acme/resend',
        conversation: '@client.test',
      }),
    );
    if (policy === 'chat') {
      const { call, close } = await harness.mcp();
      try {
        const refusal = refused(
          await call('resend_send_execute', { account: 'acme/resend', approvalId: prepared.approvalId }),
        );
        assert.equal(refusal.code, 'ACT_NOT_ALLOWED');
      } finally {
        await close();
      }
    }
    assert.equal(harness.fake.sends().length, 0, 'no POST /emails reached the fake');
    assert.equal(
      asV2(await harness.core.approvals.get(prepared.approvalId))?.state,
      stateBefore,
      'refused before the claim: the approval is as the person left it',
    );

    // The person loosens it again, and the same approval sends, once.
    await setBehaviourRules(harness, [], { loosening: true });
    await executeSend(context, 'acme/resend', { approvalId: prepared.approvalId });
    assert.equal(harness.fake.sends().length, 1);
  });
}

test('the approval binds the act and every recipient: a stored check changed after the preview is refused, and nothing is sent', async () => {
  await ready();
  const context = harness.context('mcp');
  const edits: Record<string, (stored: Record<string, unknown>) => void> = {
    'a recipient dropped from the places': (stored) => {
      stored.behaviour = { acts: ['send'], places: [['sam@partner.test']] };
    },
    'the check removed': (stored) => {
      delete stored.behaviour;
    },
  };
  for (const [what, edit] of Object.entries(edits)) {
    const prepared = await prepareSend(context, 'acme/resend', email({ cc: ['Bob@Client.TEST'] }));
    const record = asV2(await harness.core.approvals.get(prepared.approvalId));
    assert.ok(record);
    const file = join(harness.core.paths.stateDir, 'resend', 'prepared', `${record.draftId}.json`);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(
      stored.behaviour,
      { acts: ['send'], places: [['sam@partner.test'], ['bob@client.test']] },
      'what is checked is stored with the message: the act, and each recipient lower-cased',
    );
    edit(stored);
    writeFileSync(file, JSON.stringify(stored));
    await assert.rejects(
      executeSend(context, 'acme/resend', { approvalId: prepared.approvalId }),
      (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
      what,
    );
  }
  assert.equal(harness.fake.sends().length, 0, 'nothing reached the fake');
});

test('every preview says what is allowed where the send lands: the one prepared, and the one a terminal approves', async () => {
  const account = await ready('confirm');
  const context = harness.context('cli');
  const unruled = await prepareSend(context, 'acme/resend', email());
  assert.equal(allowedLine(unruled.preview), 'Allowed here: everything (no rule)');

  await setBehaviourRules(harness, [{ account: 'acme/resend', accountId: account.id, acts: ['send', 'reply'] }]);
  const ruled = await prepareSend(context, 'acme/resend', email());
  assert.equal(allowedLine(ruled.preview), 'Allowed here: reply, send (rule: acme/resend)');

  await setBehaviourRules(harness, [
    { account: 'acme/resend', accountId: account.id, acts: ['send', 'reply'] },
    { account: 'acme/resend', accountId: account.id, conversation: 'Sam@Partner.test', acts: ['send'] },
  ]);
  const narrowed = await prepareSend(context, 'acme/resend', email({ cc: ['ana@elsewhere.test'] }));
  assert.equal(allowedLine(narrowed.preview), 'Allowed here: send (rule: acme/resend, sam@partner.test)');
  const prompt = await beginSendApproval(context, narrowed.approvalId);
  assert.equal(allowedLine(prompt.preview), 'Allowed here: send (rule: acme/resend, sam@partner.test)');
  assert.equal(harness.fake.sends().length, 0);
});

/*
 * The terminal's approval screen showed the line as the rules stood now, and asked for the code anyway: a person typed
 * a yes to a send a tightened rule would refuse. It refuses now, as Gmail's does, and the approval is as it was.
 */
test('the approval screen refuses a send a rule tightened since the prepare forbids, and asks for no code', async () => {
  const account = await ready('confirm');
  const context = harness.context('cli');
  const prepared = await prepareSend(context, 'acme/resend', email({ cc: ['bob@client.test'] }));
  const stateBefore = asV2(await harness.core.approvals.get(prepared.approvalId))?.state;
  await setBehaviourRules(harness, [
    { account: 'acme/resend', accountId: account.id, conversation: '@client.test', acts: ['reply'] },
  ]);
  await assert.rejects(
    beginSendApproval(context, prepared.approvalId),
    notAllowed('this agent may only reply in bob@client.test (acme/resend)', 'bob@client.test', {
      account: 'acme/resend',
      conversation: '@client.test',
    }),
  );
  const record = asV2(await harness.core.approvals.get(prepared.approvalId));
  assert.equal(record?.state, stateBefore, 'the approval is as it was');
  assert.equal(record?.challengeHash, undefined, 'no code was issued');

  // Loosened again, the screen asks, and the yes sends.
  await setBehaviourRules(harness, [], { loosening: true });
  const prompt = await beginSendApproval(context, prepared.approvalId);
  await finishSendApproval(context, prepared.approvalId, prompt.challenge);
  await executeSend(context, 'acme/resend', { approvalId: prepared.approvalId });
  assert.equal(harness.fake.sends().length, 1);
});

/*
 * A send Resend throttled waits and tries again (design 2026-10-08), and the rules were asked only once, before the
 * claim: a rule tightened while the throttle was waited out did not stop the retry. They are asked before every attempt.
 */
test('a rule tightened while a throttle is waited out stops the retry, and nothing is sent', async () => {
  const account = await ready();
  let now = Date.now();
  const context = new ResendContext({
    core: harness.core,
    env: harness.env,
    fetch: harness.fake.fetch,
    throttle: {
      intervalMs: 0,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    sendPacing: () =>
      sendPacing({
        now: () => now,
        sleep: async (ms) => {
          // While the send waits, the person narrows the rule: no new message to anyone at client.test.
          await setBehaviourRules(harness, [
            { account: 'acme/resend', accountId: account.id, conversation: '@client.test', acts: [] },
          ]);
          now += ms;
        },
      }),
  });
  const prepared = await prepareSend(context, 'acme/resend', email({ cc: ['bob@client.test'] }));
  let refusals = 1;
  harness.fake.intercept = (request) =>
    request.method === 'POST' && request.path === '/emails' && refusals-- > 0
      ? {
          status: 429,
          body: { name: 'rate_limit_exceeded', message: 'refused before sending' },
          headers: { 'retry-after': '2' },
        }
      : undefined;
  await assert.rejects(
    executeSend(context, 'acme/resend', { approvalId: prepared.approvalId }),
    notAllowed('this agent may do nothing in bob@client.test (acme/resend)', 'bob@client.test', {
      account: 'acme/resend',
      conversation: '@client.test',
    }),
  );
  assert.equal(harness.fake.sends().length, 1, 'the throttled attempt, and no retry');
  assert.equal(harness.fake.sent.length, 0, 'nothing was accepted');
  assert.notEqual(asV2(await harness.core.approvals.get(prepared.approvalId))?.state, 'used');
});
