import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderChannelPreview, updateCheckPath } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type Harness, newHarness } from './support/harness.ts';

/*
 * The security line on Slack's post preview (design 2026-10-16, U7): a release declaring a security fix, on a machine
 * that does not install it on its own, puts one line first in the next post preview — once — and the person's yes to
 * that preview posts. Slack is a script of replies that counts what it was asked; npm is never asked.
 */

const LINE = 'A security fix is out (99.0.0): update first, or approve to post anyway';

function securityOut(harness: Harness): void {
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
      release: { version: '99.0.0', security: true, needsDecision: false },
    }),
  );
}

function slack() {
  const asked: string[] = [];
  const script: Record<string, unknown> = {
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } },
    'chat.postMessage': { ok: true, ts: '1700000000.000100' },
  };
  const read = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    asked.push(method);
    return new Response(JSON.stringify(script[method] ?? { ok: false, error: 'unknown_method' }));
  };
  return { read, count: (method: string) => asked.filter((name) => name === method).length };
}

test('a security release puts its line first in the next post preview, once, and the person’s yes to it posts', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  securityOut(harness);
  const fake = slack();
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    fetch: fake.read,
    platform: 'darwin',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
  try {
    const result = await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'shipping now' });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const prepared = result.structuredContent as {
      draftId: string;
      approvalId: string;
      preview: Parameters<typeof renderChannelPreview>[0];
    };
    assert.equal(prepared.preview.security, LINE);
    assert.equal(renderChannelPreview(prepared.preview).split('\n')[0], LINE, 'first, as the person reads it');
    // Not answered yet: a preview prepared before the person says yes to the first asks too.
    const meanwhile = await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'one more thing' });
    assert.equal((meanwhile.structuredContent as { preview: { security?: string } }).preview.security, LINE);
    // The person's yes to that preview posts.
    const posted = await call('slack_post_send', {
      workspace: 'acme',
      draftId: prepared.draftId,
      approvalId: prepared.approvalId,
      expectChannel: 'C1',
    });
    assert.notEqual(posted.isError, true, JSON.stringify(posted.structuredContent));
    assert.equal(fake.count('chat.postMessage'), 1);
    // Asked once: the person's yes to a preview that carried it answered it.
    const next = await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'and again' });
    assert.equal((next.structuredContent as { preview: { security?: string } }).preview.security, undefined);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
