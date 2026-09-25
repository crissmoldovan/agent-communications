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

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Slack, as a script of replies by method.
 *
 * Every server built here gets one, whether or not the test is about Slack: the prepare test used to be built
 * without it and quietly asked slack.com for `conversations.info`, passing or failing on somebody's network.
 */
function slackReplies(script: Record<string, unknown> = {}): FakeFetch {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    return new Response(JSON.stringify(script[method] ?? { ok: false, error: 'unknown_method' }));
  };
}

async function connect(harness: Harness, options: { workspace?: string; fetch?: FakeFetch } = {}) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    fetch: options.fetch ?? slackReplies(),
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

test('preparing a post writes a draft, returns a preview, audits it, and posts nothing', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const methods: string[] = [];
  const replies = slackReplies({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'general', num_members: 4, is_member: true } },
  });
  const fetch: FakeFetch = async (input, init) => {
    methods.push(String(input instanceof Request ? input.url : input).split('/api/')[1] ?? '');
    return replies(input, init);
  };
  const { client, close } = await connect(harness, { fetch });
  try {
    const result = (await client.callTool({
      name: 'slack_post_prepare',
      arguments: { workspace: 'acme', channel: 'C1', text: 'ready when you are' },
    })) as ToolResult;
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const data = result.structuredContent as { approvalId: string; draftId: string };
    assert.match(data.approvalId, /^ap_/);
    assert.ok(
      methods.every((method) => !/^(chat|reactions|files)\./.test(method)),
      `nothing but reads reached Slack: ${methods.join(', ')}`,
    );

    /*
     * The same record `agent-slack post prepare` writes. The MCP handler built its gate without the audit sink,
     * so every prepare an agent made was invisible to `audit tail` while the CLI's were not.
     */
    const records = await harness.core.audit.tail({ limit: 20 });
    assert.ok(
      records.some((record) => record.operation.startsWith('slack.post.prepare') && record.surface === 'mcp'),
      `a prepare record from MCP: ${JSON.stringify(records.map((r) => [r.operation, r.surface]))}`,
    );
  } finally {
    await close();
  }
});

// ── Parity with the CLI, and the tools that are absent on purpose ──────────────────────────────────────────────

test('the tools that post, react, approve or change a workspace’s connection do not exist', async () => {
  /*
   * Each of these is either a message in front of people or a change to what this software may do, and both are a
   * person's to make at a terminal. A tool added for any of them — however well gated — is an agent doing it.
   */
  const harness = await newHarness();
  const { client, close } = await connect(harness);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    // `slack_post_prepare` is the one `post` tool, and it posts nothing; any other is a way to put words in a room.
    const forbidden = names.filter((name) =>
      /^slack_(post_(?!prepare$)|send|approve|react|reaction|workspace_(add|reauth|remove|finish)|mode_(send|widen|set))/.test(
        name,
      ),
    );
    assert.deepEqual(forbidden, [], 'posting, reacting, approving and connecting stay off the MCP surface');
    for (const expected of ['slack_draft_list', 'slack_draft_get', 'slack_draft_delete', 'slack_post_prepare']) {
      assert.ok(names.includes(expected), `${expected} is part of the agent's surface`);
    }
  } finally {
    await close();
  }
});

test('every tool says whether it writes and whether it reaches Slack', async () => {
  const harness = await newHarness();
  const { client, close } = await connect(harness);
  try {
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} declares readOnlyHint`);
      assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} declares openWorldHint`);
    }
    const writers = tools.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name);
    assert.deepEqual(writers.sort(), ['slack_draft_delete', 'slack_post_prepare']);
    const deleting = tools.find((tool) => tool.name === 'slack_draft_delete');
    assert.equal(deleting?.annotations?.destructiveHint, true);
  } finally {
    await close();
  }
});

test('drafts can be listed, read and deleted, and only within their own workspace', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001', userId: 'U0001' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', userId: 'U0002' });
  const fetch = slackReplies({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'general', num_members: 4, is_member: true } },
  });
  const { client, close } = await connect(harness, { fetch });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  try {
    const prepared = await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'first' });
    const draftId = (prepared.structuredContent as { draftId: string }).draftId;

    const mine = await call('slack_draft_list', { workspace: 'acme' });
    const listed = (mine.structuredContent as { drafts: { draftId: string }[] }).drafts.map((d) => d.draftId);
    assert.deepEqual(listed, [draftId]);
    const theirs = await call('slack_draft_list', { workspace: 'zeta' });
    assert.deepEqual((theirs.structuredContent as { drafts: unknown[] }).drafts, [], 'zeta sees none of acme’s');

    const got = await call('slack_draft_get', { workspace: 'acme', draftId });
    assert.equal((got.structuredContent as { draft: { source: string } }).draft.source, 'first');
    const peeked = await call('slack_draft_get', { workspace: 'zeta', draftId });
    assert.equal(peeked.isError, true, 'another workspace’s draft is not readable by id');

    const stolen = await call('slack_draft_delete', { workspace: 'zeta', draftId });
    assert.equal(stolen.isError, true, 'nor deletable');
    assert.equal((await call('slack_draft_get', { workspace: 'acme', draftId })).isError, undefined, 'still there');

    const deleted = await call('slack_draft_delete', { workspace: 'acme', draftId });
    assert.notEqual(deleted.isError, true);
    const gone = await call('slack_draft_list', { workspace: 'acme' });
    assert.deepEqual((gone.structuredContent as { drafts: unknown[] }).drafts, []);
  } finally {
    await close();
  }
});

test('a pinned server refuses another workspace on every tool that takes one', async () => {
  /*
   * The pin is checked in `resolve`, which every tool calls — and a tool that forgot to call it would act on
   * whichever workspace it was handed. The design asks for a test that walks all of them, so this one does: any
   * tool with a `workspace` argument, called on a pinned server with another name, must refuse.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', userId: 'U0002' });
  const { client, close } = await connect(harness, { workspace: 'acme' });
  // Just enough of each tool's required arguments to get past the schema to the pin.
  const filler: Record<string, unknown> = {
    channel: 'C1',
    ts: '1.0',
    query: 'x',
    text: 'x',
    draftId: 'dft_AAAAAAAAAAAAAAAAAAAAAA',
  };
  try {
    const tools = (await client.listTools()).tools;
    const scoped = tools.filter((tool) => 'workspace' in (tool.inputSchema.properties ?? {}));
    assert.ok(scoped.length >= 12, `most tools take a workspace (${scoped.length})`);
    for (const tool of scoped) {
      const required = (tool.inputSchema.required ?? []) as string[];
      const args: Record<string, unknown> = { workspace: 'zeta' };
      for (const key of required) if (key in filler) args[key] = filler[key];
      const result = (await client.callTool({ name: tool.name, arguments: args })) as ToolResult;
      assert.equal(result.isError, true, `${tool.name} acted on another workspace`);
      assert.match(JSON.stringify(result.structuredContent), /pinned to/, `${tool.name} refused for the pin`);
    }
  } finally {
    await close();
  }
});
