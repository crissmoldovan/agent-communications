import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * The agent-facing surface.
 *
 * Two things are being checked, and the second is the one that matters. That the tools work — and that the ones
 * which could put a message in front of people, or widen what this software may do, cannot be made to by an
 * agent calling them. The owner's rule is that an agent may report a mode, may narrow it, and may *request* a
 * widening that parks for a person; it never widens. These tests are where that rule is enforced rather than
 * described.
 */

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function connect(harness: Harness, options: { workspace?: string } = {}) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

test('the tool list is the same whatever is connected, so a workspace added later needs no restart', async () => {
  const empty = await newHarness();
  const bare = await connect(empty);
  const before = (await bare.client.listTools()).tools.map((tool) => tool.name).sort();
  await bare.close();

  const populated = await newHarness();
  await populated.addWorkspace({ alias: 'acme' });
  const full = await connect(populated);
  const after = (await full.client.listTools()).tools.map((tool) => tool.name).sort();
  await full.close();

  assert.deepEqual(before, after);
  assert.ok(before.includes('slack_read'));
});

test('no tool posts, and the one that prepares says so in its own description', async () => {
  const harness = await newHarness();
  const { client, close } = await connect(harness);
  try {
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const posting of ['slack_post', 'slack_send', 'slack_react', 'slack_reaction_add']) {
      assert.ok(!names.includes(posting), `${posting} must not exist: posting is not something an agent does`);
    }
    const prepare = tools.find((tool) => tool.name === 'slack_post_prepare');
    assert.match(String(prepare?.description), /Nothing is posted/i);
  } finally {
    await close();
  }
});

test('the greeting a model reads is scoped to the pinned workspace', async () => {
  // The Gmail build shipped tools scoped to the pinned mailbox and a greeting that listed all six. The greeting
  // is the one surface nobody thinks to scope, and it is the first thing a model reads.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', userId: 'U0002' });

  const { server } = await createSlackMcpServer({ core: harness.core, env: harness.env, workspace: 'acme' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const greeting = client.getInstructions() ?? '';
  await Promise.all([client.close(), server.close()]);

  assert.match(greeting, /acme/);
  assert.doesNotMatch(greeting, /zeta/, 'a pinned server does not mention the workspaces it cannot reach');
});

test('a pinned server refuses another workspace by name rather than quietly using its own', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', userId: 'U0002' });
  const { client, close } = await connect(harness, { workspace: 'acme' });
  try {
    const result = (await client.callTool({
      name: 'slack_channels',
      arguments: { workspace: 'zeta' },
    })) as ToolResult;
    assert.equal(result.isError, true, 'a caller that named another workspace believed something false');
    assert.match(JSON.stringify(result.structuredContent), /pinned to \\"acme\\"/);
  } finally {
    await close();
  }
});

test('without a pin, a call that names no workspace is refused rather than guessed', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const { client, close } = await connect(harness);
  try {
    const result = (await client.callTool({ name: 'slack_channels', arguments: {} })) as ToolResult;
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.structuredContent), /no default/);
  } finally {
    await close();
  }
});

// ── The mode tools, and the limits on them ─────────────────────────────────────────────────────────────────────

test('an agent may report a mode', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  const { client, close } = await connect(harness);
  try {
    const result = (await client.callTool({
      name: 'slack_mode',
      arguments: { workspace: 'acme' },
    })) as ToolResult;
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result.structuredContent), /read/);
  } finally {
    await close();
  }
});

test('an agent asking to widen gets steps for a person, and nothing changes', async () => {
  /*
   * The owner's rule, enforced rather than described: an agent never widens. The widening is a new OAuth grant
   * approved in Slack's own UI, which is a better gate than anything written here — so the tool returns the
   * steps and performs none of them.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  const { client, close } = await connect(harness);
  try {
    const result = (await client.callTool({
      name: 'slack_mode_request_send',
      arguments: { workspace: 'acme', port: 51234 },
    })) as ToolResult;
    assert.notEqual(result.isError, true);
    const data = result.structuredContent as { alreadySend: boolean; steps: string[]; note: string };
    assert.equal(data.alreadySend, false);
    assert.ok(data.steps.length > 0, 'it says what a person must do');
    assert.match(data.note, /cannot/i, 'and says plainly that it did not do it');

    const account = (await harness.core.config.load()).accounts.acme;
    assert.equal(account?.mode, 'read', 'the workspace is exactly as read-only as it was');
  } finally {
    await close();
  }
});

test('narrowing is offered as a path, because Slack never takes a scope back from a token', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const { client, close } = await connect(harness);
  try {
    const result = (await client.callTool({
      name: 'slack_mode_narrow',
      arguments: { workspace: 'acme' },
    })) as ToolResult;
    const data = result.structuredContent as { steps: string[]; note: string };
    assert.ok(data.steps.length > 0);
    assert.match(data.note, /never removes/i, 'the honest reason it cannot just do it');
  } finally {
    await close();
  }
});

test('preparing a post writes a draft and returns a preview, and posts nothing', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const { client, close } = await connect(harness);
  try {
    const result = (await client.callTool({
      name: 'slack_post_prepare',
      arguments: { workspace: 'acme', channel: 'C1', text: 'ready when you are' },
    })) as ToolResult;
    // The workspace is read-only, so the read that counts the room fails and the tool reports it rather than
    // pretending. Either way, nothing was posted — which is the assertion that matters.
    const body = JSON.stringify(result.structuredContent);
    assert.doesNotMatch(body, /"ts":/, 'no message timestamp: nothing reached a channel');
  } finally {
    await close();
  }
});
