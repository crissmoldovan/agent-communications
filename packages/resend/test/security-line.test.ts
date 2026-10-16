import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { updateCheckPath } from '@agentcomms/core';
import { type Harness, newHarness, ok } from './support/harness.ts';

/*
 * The security line on Resend's send preview (design 2026-10-16, U7): a release declaring a security fix, on a machine
 * that does not install it on its own, puts one line first in the next send preview — once — and the person's yes to
 * that preview sends. Resend is the loopback fake; npm is never asked.
 */

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

const LINE = 'A security fix is out (99.0.0): update first, or approve to send anyway';

function securityOut(at: Harness): void {
  at.env.AGENT_COMMS_UPDATE_CHECK = 'on';
  at.env.npm_config_registry = 'http://127.0.0.1:9/';
  const stateDir = at.core.paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(stateDir),
    JSON.stringify({
      lastChecked: new Date().toISOString(),
      latest: '99.0.0',
      behind: true,
      release: { version: '99.0.0', security: true, needsDecision: false },
    }),
  );
}

const message = {
  account: 'acme/resend',
  from: 'hello@acme.test',
  to: ['sam@partner.test'],
  subject: 'Hi',
  text: 'Hi',
};

test('a security release puts its line first in the next send preview, once, and the person’s yes to it sends', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  securityOut(harness);
  const { call, close } = await harness.mcp();
  try {
    const prepared = ok<{ approvalId: string; preview: string }>(await call('resend_send_prepare', message));
    assert.equal(prepared.preview.split('\n')[0], LINE);
    assert.match(prepared.preview, /SEND PREVIEW|PREVIEW/, 'the preview is all there below it');
    ok(await call('resend_send_execute', { account: 'acme/resend', approvalId: prepared.approvalId }));
    assert.equal(harness.fake.sends().length, 1, 'the person’s yes to that preview sent it');
    const next = ok<{ preview: string }>(await call('resend_send_prepare', message));
    assert.doesNotMatch(next.preview, /security fix/, 'asked twice');
  } finally {
    await close();
  }
});
