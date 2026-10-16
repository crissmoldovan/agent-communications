import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { updateCheckPath } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { GmailContext } from '../src/context.ts';
import { createGmailMcpServer } from '../src/mcp/server.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { type Harness, newHarness } from './support/harness.ts';

/*
 * The security line on Gmail's send preview (design 2026-10-16, U7): a release declaring a security fix, on a machine
 * that does not install it on its own, puts one line first in the next send preview — once — and the person's yes to
 * that preview sends. Nothing here reaches Gmail but the fake transport, nor npm: the check's file is written by hand.
 */

const LINE = 'A security fix is out (99.0.0): update first, or approve to send anyway';

function securityOut(harness: Harness, security = true): void {
  harness.env.AGENT_COMMS_UPDATE_CHECK = 'on';
  harness.env.npm_config_registry = 'http://127.0.0.1:9/';
  const stateDir = harness.core.paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(stateDir),
    JSON.stringify({
      lastChecked: new Date().toISOString(),
      latest: '99.0.0',
      behind: true,
      release: { version: '99.0.0', security, needsDecision: false },
    }),
  );
}

async function mailbox(): Promise<Harness> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo', isDefault: true, isPrimary: true }],
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'chat' });
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
  );
  return harness;
}

async function draft(harness: Harness): Promise<string> {
  const context = new GmailContext({ core: harness.core, env: harness.env });
  return (await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Tuesday works.' }))
    .draftId;
}

async function connect(harness: Harness) {
  const built = await createGmailMcpServer({ core: harness.core, env: harness.env, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
  return { call, close: async () => Promise.all([client.close(), built.close()]) };
}

test('a security release puts its line first in the next send preview, once, and the person’s yes to it sends', async () => {
  const harness = await mailbox();
  securityOut(harness);
  const { call, close } = await connect(harness);
  try {
    const first = await call('gmail_send_prepare', { inbox: 'work', draftId: await draft(harness) });
    assert.notEqual(first.isError, true, JSON.stringify(first.structuredContent));
    const prepared = first.structuredContent as { approvalId: string; preview: string };
    assert.equal(prepared.preview.split('\n')[0], LINE);
    assert.match(prepared.preview, /SEND PREVIEW/, 'the preview is all there below it');
    // The person's yes to that preview is the answer: it sends.
    const sent = await call('gmail_draft_send', { inbox: 'work', approvalId: prepared.approvalId });
    assert.notEqual(sent.isError, true, JSON.stringify(sent.structuredContent));
    assert.ok((sent.structuredContent as { sentMessageId?: string }).sentMessageId);
    // Asked once: the next preview is as it always was.
    const next = await call('gmail_send_prepare', { inbox: 'work', draftId: await draft(harness) });
    const again = (next.structuredContent as { preview: string }).preview;
    assert.doesNotMatch(again, /security fix/);
  } finally {
    await close();
  }
});

test('with no security release waiting, the send preview is unchanged', async () => {
  const harness = await mailbox();
  securityOut(harness, false);
  const { call, close } = await connect(harness);
  try {
    const result = await call('gmail_send_prepare', { inbox: 'work', draftId: await draft(harness) });
    assert.doesNotMatch((result.structuredContent as { preview: string }).preview, /security fix/);
  } finally {
    await close();
  }
});
