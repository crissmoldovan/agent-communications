import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * The agent-facing surface.
 *
 * Two things are being checked, and the second is the one that matters. That the tools work — and that the ones
 * which put a message in front of people do so only through the gate the CLI uses, and that none of them approves.
 * An agent may report a mode and read the steps to change it; it widens a workspace only through a change a person
 * approved (`mcp-changes.test.ts`), and it never approves its own post. These tests, with `mcp-send.test.ts` and
 * `mcp-changes.test.ts`, are where those rules are enforced rather than described.
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

test('the tools that reach people say what approval they need, and the one that prepares says it posts nothing', async () => {
  /*
   * Posting and reacting are tools since the owner's rule of 2026-09-25, through the gate the CLI uses. The
   * description is what a model reads before calling one, so each says that a person's yes comes first, and that
   * under `confirm` the approval is a command a person runs — not something the tool can do.
   */
  const harness = await newHarness();
  const { client, close } = await connect(harness);
  try {
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const posting of ['slack_post', 'slack_send', 'slack_reaction_add']) {
      assert.ok(!names.includes(posting), `${posting} is a way round the prepared post`);
    }
    for (const outward of ['slack_post_send', 'slack_react', 'slack_react_send']) {
      const tool = tools.find((candidate) => candidate.name === outward);
      assert.ok(tool, `${outward} is part of the agent's surface`);
      assert.match(String(tool.description), /agent-slack approve/, `${outward} names the command a person runs`);
      assert.match(String(tool.description), /cannot approve/i, `${outward} says the agent cannot approve`);
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

test('the greeting says how a post is approved under each policy, and that the agent cannot approve one', async () => {
  // The first thing a model reads. It said no tool posts; that stopped being true, and a greeting that is wrong about
  // posting is wrong about the one thing it most needs to get right.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const { server } = await createSlackMcpServer({ core: harness.core, env: harness.env, fetch: slackReplies() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const greeting = client.getInstructions() ?? '';
  await Promise.all([client.close(), server.close()]);

  assert.doesNotMatch(greeting, /no tool here posts/i);
  for (const said of [/slack_post_send/, /`chat`/, /`confirm`/, /`never`/, /agent-slack approve/, /cannot approve/i]) {
    assert.match(greeting, said);
  }
});

test('the greeting stays under 2 KB with many workspaces, and what must not be lost comes first', async () => {
  /*
   * Claude Code cuts a server's instructions at 2,048 bytes (design 2026-09-18 §11; Gmail's test holds the same
   * line). This greeting reached 2.7 KB with nothing connected, and what fell off the end was "you cannot approve
   * it yourself", `never`, which workspaces can post and "pass `workspace`". Twelve workspaces, nine of which can
   * post, fill both lists past their cap — the longest this greeting gets on a machine that is not contrived.
   */
  const harness = await newHarness();
  const names = [
    'beamtech-slack',
    'cue-slack',
    'cueplusplus-slack-support',
    'discovrx-slack',
    'personal-slack',
    'reprezent-slack',
    'rgc-labs-slack',
    'rgc-slack',
    'rgc-slack-clients',
    'studio-lasers-slack',
    'wherefrom-slack',
    'wherefrom-slack-tech',
  ];
  for (const [index, alias] of names.entries()) {
    await harness.addWorkspace({
      alias,
      workspaceId: `T${1000 + index}`,
      userId: `U${1000 + index}`,
      mode: index % 4 === 3 ? 'read' : 'send',
    });
  }
  const { client, close } = await connect(harness);
  const greeting = client.getInstructions() ?? '';
  await close();

  assert.ok(Buffer.byteLength(greeting) < 2048, `${Buffer.byteLength(greeting)} bytes; Claude Code keeps 2,048`);
  assert.match(greeting, /Workspaces that could post if a person approves: [^\n]*, and 1 more\./);
  assert.match(greeting, /Known workspaces: [^\n]*, and 4 more\./);
  // In order: what is data, what a post needs, who can post, which workspace — and only then how a change is made.
  const order = [
    /<untrusted-content>/,
    /`mismatch`/,
    /`unrenderable`/,
    /@channel, @here or a room of 50 or more/,
    /agent-slack approve <id>/,
    /you cannot approve it yourself/,
    /Under `never` nothing posts/,
    /Workspaces that could post/,
    /Pass `workspace` on every call/,
    /Known workspaces/,
    /Changing a workspace/,
  ].map((said) => {
    const at = greeting.search(said);
    assert.ok(at >= 0, `the greeting says ${said}`);
    return at;
  });
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'the lines a model must not lose come before the ones it can do without',
  );
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

test('an agent asking for the steps to widen gets them, and nothing changes', async () => {
  /*
   * The steps as text, for a person who wants to read them first — `workspace mode <name> send` stopped before any
   * change is asked for. Making the move is `slack_mode_set`, through a change a person approves; this tool performs
   * none of it, and says which one does.
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
    const data = result.structuredContent as {
      changed: boolean;
      appUpdateNeeded: boolean;
      steps: string[];
      manifest: { port: number; manifestUrl: string };
    };
    assert.equal(data.changed, false, 'it says plainly that it did not do it');
    assert.equal(data.appUpdateNeeded, true);
    assert.ok(data.steps.length > 0, 'it says what has to happen');
    assert.match(data.steps[0] ?? '', /apps\/A0001\/app-manifest/, 'the app step links the workspace’s own app');
    assert.match(data.steps.join('\n'), /slack_mode_set/, 'and which tool makes the move');
    assert.equal(data.manifest.port, 51234);

    const account = (await harness.core.config.load()).accounts.acme;
    assert.equal(account?.mode, 'read', 'the workspace is exactly as read-only as it was');
    assert.deepEqual(await harness.core.approvals.list(), [], 'and nobody was asked anything');
  } finally {
    await close();
  }
});

test('narrowing is offered as a path, because Slack never takes a scope back from a token', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', redirectPort: 50123 });
  const { client, close } = await connect(harness);
  try {
    const result = (await client.callTool({
      name: 'slack_mode_narrow',
      arguments: { workspace: 'acme' },
    })) as ToolResult;
    const data = result.structuredContent as { changed: boolean; steps: string[] };
    assert.equal(data.changed, false);
    assert.ok(data.steps.length > 0);
    assert.match(data.steps.join('\n'), /Remove app/, 'the one step that actually takes posting away');
  } finally {
    await close();
  }
});

test('the mode steps name the port the workspace signed in with, and never guess one', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'known', mode: 'send', redirectPort: 50123 });
  await harness.addWorkspace({ alias: 'unknown' });
  const { client, close } = await connect(harness);
  try {
    const narrow = (await client.callTool({
      name: 'slack_mode_narrow',
      arguments: { workspace: 'known' },
    })) as ToolResult;
    assert.match((narrow.structuredContent as { steps: string[] }).steps.join('\n'), /--port 50123/);

    // No port recorded and none given: refused, as `workspace mode unknown send` refuses it, rather than naming one.
    const widen = (await client.callTool({
      name: 'slack_mode_request_send',
      arguments: { workspace: 'unknown' },
    })) as ToolResult;
    assert.equal(widen.isError, true);
    const error = (widen.structuredContent as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /loopback port is needed/);

    // The report names no port it does not have: its steps say `<port>`, as the command's do.
    const report = (await client.callTool({ name: 'slack_mode', arguments: { workspace: 'unknown' } })) as ToolResult;
    const toSend = (report.structuredContent as { toSend: string[] }).toSend.join('\n');
    assert.match(toSend, /--port <port>/);
    assert.doesNotMatch(toSend, /51234/);
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

test('no tool approves, and the only tools that change a workspace are the named few behind a change approval', async () => {
  /*
   * Approving is the one act that stays at a terminal whatever else moves to chat: under `confirm` it is what the
   * policy means, and a tool that approved would make it mean nothing. The posting tools are the named few that
   * claim a prepared post or reaction through the gate; any other name for putting words in a room is a way round it.
   * The same for changing a workspace: the named tools run core's change flow (`mcp-changes.test.ts`), and a tool
   * that widened by another name would be a way round that. Changing the Slack app itself stays off entirely: it
   * needs an app configuration token, and a chat's transcript would keep one.
   */
  const harness = await newHarness();
  const { client, close } = await connect(harness);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    const forbidden = names.filter((name) =>
      /approv|^slack_(post_(?!prepare$|send$)|send|react_(?!send$)|reaction|app_|workspace_(?!add$|finish$|reauth$|remove$|policy$|show$)|mode_(?!narrow$|request_send$|set$))/.test(
        name,
      ),
    );
    assert.deepEqual(forbidden, [], 'approving, changing the app, and any other way to change a workspace stay off');
    for (const expected of [
      'slack_workspace_add',
      'slack_workspace_finish',
      'slack_workspace_reauth',
      'slack_workspace_remove',
      'slack_workspace_policy',
      'slack_mode_set',
      'slack_draft_list',
      'slack_draft_get',
      'slack_draft_delete',
      'slack_post_prepare',
      'slack_post_send',
      'slack_react',
      'slack_react_send',
      'slack_doctor',
      'slack_manifest',
      'slack_workspace_show',
    ]) {
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
    assert.deepEqual(writers.sort(), [
      'slack_draft_delete',
      'slack_mode_set',
      'slack_post_prepare',
      'slack_post_send',
      'slack_react',
      'slack_react_send',
      'slack_workspace_add',
      'slack_workspace_finish',
      'slack_workspace_policy',
      'slack_workspace_reauth',
      'slack_workspace_remove',
    ]);
    // A post cannot be taken back once people have read it, nor a deleted token, and a client that asks before such a
    // call must know.
    for (const irreversible of [
      'slack_draft_delete',
      'slack_post_send',
      'slack_react',
      'slack_react_send',
      'slack_workspace_remove',
    ]) {
      const tool = tools.find((candidate) => candidate.name === irreversible);
      assert.equal(tool?.annotations?.destructiveHint, true, `${irreversible} is marked destructive`);
      assert.equal(tool?.annotations?.idempotentHint ?? false, false, `${irreversible} is not safe to repeat`);
    }
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

test('an unreadable draft can be deleted through the tool, and only from the workspace it still names', async () => {
  /*
   * The tool read the draft to check whose it was, and a draft it could not read stopped the delete there — while
   * `slack_draft_list` skipped it, so an agent could neither see it nor clear it up. The CLI has the same test in
   * `cli-parity.test.ts`; both call one function, and this proves the tool is on it.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001' });
  const zeta = await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002' });
  const directory = join(harness.core.paths.stateDir, 'slack', 'drafts');
  await mkdir(directory, { recursive: true });
  const nameless = 'dft_AAAAAAAAAAAAAAAAAAAAAA';
  const zetas = 'dft_BBBBBBBBBBBBBBBBBBBBBB';
  await writeFile(join(directory, `${nameless}.json`), '{not json');
  await writeFile(
    join(directory, `${zetas}.json`),
    `{\n  "draftId": "${zetas}",\n  "accountId": "${zeta.id}",\n  "pay`,
  );

  const { client, close } = await connect(harness);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  try {
    const deleted = await call('slack_draft_delete', { workspace: 'acme', draftId: nameless });
    assert.notEqual(deleted.isError, true, JSON.stringify(deleted.structuredContent));
    assert.deepEqual(deleted.structuredContent, {
      draftId: nameless,
      deleted: true,
      unreadable: true,
      workspaceConfirmed: false,
    });
    await assert.rejects(access(join(directory, `${nameless}.json`)));

    const stolen = await call('slack_draft_delete', { workspace: 'acme', draftId: zetas });
    assert.equal(stolen.isError, true, 'another workspace’s damaged draft is not this one’s to delete');
    await access(join(directory, `${zetas}.json`));
    const own = await call('slack_draft_delete', { workspace: 'zeta', draftId: zetas });
    assert.notEqual(own.isError, true, JSON.stringify(own.structuredContent));
    assert.equal((own.structuredContent as { workspaceConfirmed: boolean }).workspaceConfirmed, true);
  } finally {
    await close();
  }
});

test('a draft that names its workspace and nothing else is skipped by the list tool and deleted by the delete tool', async () => {
  // The CLI has the same test in `cli-parity.test.ts`; both read drafts through one store.
  const harness = await newHarness();
  const acme = await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001' });
  const fetch = slackReplies({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'general', num_members: 4, is_member: true } },
  });
  const directory = join(harness.core.paths.stateDir, 'slack', 'drafts');
  const { client, close } = await connect(harness, { fetch });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  try {
    const prepared = await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'first' });
    const real = (prepared.structuredContent as { draftId: string }).draftId;
    const damaged = 'dft_AAAAAAAAAAAAAAAAAAAAAA';
    await writeFile(join(directory, `${damaged}.json`), JSON.stringify({ accountId: acme.id }));

    const listed = await call('slack_draft_list', { workspace: 'acme' });
    assert.notEqual(listed.isError, true, JSON.stringify(listed.structuredContent));
    assert.deepEqual(
      (listed.structuredContent as { drafts: { draftId: string }[] }).drafts.map((d) => d.draftId),
      [real],
    );
    const got = await call('slack_draft_get', { workspace: 'acme', draftId: damaged });
    assert.equal(got.isError, true, 'not returned as though it were a draft');

    const deleted = await call('slack_draft_delete', { workspace: 'acme', draftId: damaged });
    assert.deepEqual(deleted.structuredContent, {
      draftId: damaged,
      deleted: true,
      unreadable: true,
      workspaceConfirmed: true,
    });
    await assert.rejects(access(join(directory, `${damaged}.json`)));
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
    approvalId: 'ap_AAAAAAAAAAAAAAAAAAAAAA',
    expectChannel: 'C1',
    emoji: 'eyes',
    mode: 'send',
    flowId: 'sfl_AAAAAAAAAAAAAAAAAAAAAA',
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
