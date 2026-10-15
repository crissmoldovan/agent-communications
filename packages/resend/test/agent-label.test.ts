import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { asV2, CommsError, UNLABELLED_PREVIEW_LINE } from '@agentcomms/core';
import type { SendInput } from '../src/compose/message.ts';
import { beginSendApproval, executeSend, prepareSend } from '../src/operations/send.ts';
import { type Harness, newHarness, setAgentLabel } from './support/harness.ts';

/**
 * R1 (design 2026-10-15-agent-label §6): for identity `agent`, prepare composes From from L1 — the caller's name, or
 * the core's name setting when the caller gave only an address, followed by ` (<word>)`; for `me`, From is as the
 * caller gave it. The preview shows it, and the approval binds it. Every send here goes to the loopback fake, with a
 * fake key.
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

async function ready(): Promise<void> {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
}

/** The From Resend was asked to send from, by the one send that reached the fake. */
function sentFrom(): string {
  const sends = harness.fake.sends();
  assert.equal(sends.length, 1, 'exactly one send reached the fake');
  return String((JSON.parse(sends[0]?.body ?? '{}') as { from?: unknown }).from);
}

const firstLine = (preview: string): string => preview.split('\n')[0] ?? '';

test('an agent send carries the caller’s name and the word, shown in the preview and sent as shown', async () => {
  await ready();
  const context = harness.context('mcp');
  const prepared = await prepareSend(context, 'acme/resend', email());
  assert.equal(prepared.identity, 'agent');
  assert.match(firstLine(prepared.preview), /^Sent as Acme \(agent\)/, 'the first line states the identity');
  assert.match(prepared.preview, /^From: +"Acme \(agent\)" <hello@acme\.test>$/m);

  await executeSend(context, 'acme/resend', { approvalId: prepared.approvalId });
  assert.equal(sentFrom(), '"Acme (agent)" <hello@acme.test>', 'what Resend was given is what the preview showed');
});

test('a bare address takes the core’s name; with neither, prepare refuses naming `label name` and prepares nothing', async () => {
  await ready();
  const context = harness.context('mcp');
  await setAgentLabel(harness, { name: 'Jo Example' });
  const named = await prepareSend(context, 'acme/resend', email({ from: 'hello@acme.test' }));
  assert.match(named.preview, /^From: +"Jo Example \(agent\)" <hello@acme\.test>$/m);

  await setAgentLabel(harness, {});
  const before = (await harness.core.approvals.list()).length;
  await assert.rejects(prepareSend(context, 'acme/resend', email({ from: 'hello@acme.test' })), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'USAGE');
    assert.match(`${error.message} ${error.hint ?? ''}`, /`label name`/);
    return true;
  });
  assert.equal((await harness.core.approvals.list()).length, before, 'no approval was prepared');
  assert.equal(harness.fake.sends().length, 0);
});

test('the word is the person’s, a name already labelled is not labelled twice, and over 100 characters is refused', async () => {
  await ready();
  const context = harness.context('mcp');
  await setAgentLabel(harness, { word: 'minion' });
  const minion = await prepareSend(context, 'acme/resend', email());
  assert.match(minion.preview, /^From: +"Acme \(minion\)" <hello@acme\.test>$/m);
  const twice = await prepareSend(context, 'acme/resend', email({ from: '"Acme (minion)" <hello@acme.test>' }));
  assert.match(twice.preview, /^From: +"Acme \(minion\)" <hello@acme\.test>$/m);

  // 92 characters and " (minion)" is 101: refused, never cut short.
  await assert.rejects(
    prepareSend(context, 'acme/resend', email({ from: `${'A'.repeat(92)} <hello@acme.test>` })),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'USAGE');
      assert.match(error.message, /100 characters/);
      return true;
    },
  );
});

test('`as: "me"` sends From as the caller gave it, and the preview’s first line says it is unlabelled', async () => {
  await ready();
  const context = harness.context('mcp');
  const prepared = await prepareSend(context, 'acme/resend', { ...email(), as: 'me' });
  assert.equal(prepared.identity, 'me');
  assert.equal(firstLine(prepared.preview), UNLABELLED_PREVIEW_LINE);
  assert.match(prepared.preview, /^From: +Acme <hello@acme\.test>$/m);
  await executeSend(context, 'acme/resend', { approvalId: prepared.approvalId });
  assert.equal(sentFrom(), 'Acme <hello@acme.test>');

  await assert.rejects(
    prepareSend(context, 'acme/resend', { ...email(), as: 'robot' }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );
});

test('a rule on @domain applies only when every recipient is in it, under a confirm policy too', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send', sendPolicy: 'confirm' });
  const context = harness.context('mcp');
  await setAgentLabel(harness, { rules: [{ account: 'acme/resend', conversation: '@partner.test', as: 'me' }] });

  const inside = await prepareSend(context, 'acme/resend', email({ cc: ['ana@partner.test'] }));
  assert.equal(inside.identity, 'me');
  assert.equal(firstLine(inside.preview), UNLABELLED_PREVIEW_LINE);
  // The person's approval at the terminal is shown the same first line, and binds the same From.
  const prompt = await beginSendApproval(context, inside.approvalId);
  assert.equal(firstLine(prompt.preview), UNLABELLED_PREVIEW_LINE);

  const mixed = await prepareSend(context, 'acme/resend', email({ bcc: ['someone@elsewhere.test'] }));
  assert.equal(mixed.identity, 'agent', 'one recipient outside the domain and the rule does not apply');
  assert.match(mixed.preview, /^From: +"Acme \(agent\)" <hello@acme\.test>$/m);
  assert.match(firstLine((await beginSendApproval(context, mixed.approvalId)).preview), /^Sent as Acme \(agent\)/);
});

test('the approval binds the From: a stored message whose From lost its label is refused, and nothing is sent', async () => {
  await ready();
  const context = harness.context('mcp');
  const prepared = await prepareSend(context, 'acme/resend', email());
  const record = asV2(await harness.core.approvals.get(prepared.approvalId));
  assert.ok(record);
  const file = join(harness.core.paths.stateDir, 'resend', 'prepared', `${record.draftId}.json`);
  const stored = JSON.parse(readFileSync(file, 'utf8')) as { message: { from: string } };
  assert.equal(stored.message.from, '"Acme (agent)" <hello@acme.test>');
  stored.message.from = 'Acme <hello@acme.test>';
  writeFileSync(file, JSON.stringify(stored));

  await assert.rejects(
    executeSend(context, 'acme/resend', { approvalId: prepared.approvalId }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
  );
  assert.equal(harness.fake.sends().length, 0, 'nothing reached the fake');
});
