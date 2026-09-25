import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * `slack_doctor`, `slack_manifest` and `slack_workspace_show` against the commands they mirror.
 *
 * Each pair is one operation, so the checks here are the same result from both surfaces for the same input — the
 * JSON a `--json` command prints and the structured content a tool returns — plus the places the MCP side has to be
 * narrower: a server pinned to one workspace says nothing about any other, in a diagnosis as in its greeting.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string };
}

/** Slack refusing everything: none of these tools posts, and a test that reached this for a read would say so. */
const nothing: FakeFetch = async () => new Response(JSON.stringify({ ok: false, error: 'unknown_method' }));

async function connect(harness: Harness, options: { workspace?: string } = {}) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    fetch: nothing,
    probe: (input, init) => harness.probe(input, init),
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

async function cli(harness: Harness, argv: string[]) {
  let stdout = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const code = await run(argv, {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
    openBrowser: () => undefined,
    probe: (input, init) => harness.probe(input, init),
    read: nothing,
  });
  return { code, stdout, json: <T>() => JSON.parse(stdout) as T };
}

// ── doctor ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('slack_doctor returns what `agent-slack doctor --json` returns', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  // A second whose token Slack says belongs to somebody else, so the two results have a failure to agree about too.
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', userId: 'U0002' });
  const { call, close } = await connect(harness);
  try {
    for (const offline of [false, true]) {
      const tool = await call('slack_doctor', { offline });
      assert.notEqual(tool.isError, true, JSON.stringify(tool.structuredContent));
      const command = await cli(harness, ['--json', 'doctor', ...(offline ? ['--offline'] : [])]);
      assert.deepEqual(tool.structuredContent, command.json<Envelope<unknown>>().data, `offline: ${offline}`);
    }
  } finally {
    await close();
  }
});

test('slack_doctor asks Slack who the token is, and with `offline` asks nothing', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  let asked = 0;
  harness.probe = () => {
    asked += 1;
    return Promise.resolve(harness.authTest());
  };
  const { call, close } = await connect(harness);
  type Checks = { checks: { id: string; status: string; detail: string }[] };
  try {
    const online = (await call('slack_doctor', {})).structuredContent as Checks;
    assert.equal(asked, 1);
    assert.equal(online.checks.find((check) => check.id === 'identity')?.status, 'ok');

    const offline = (await call('slack_doctor', { offline: true })).structuredContent as Checks;
    assert.equal(asked, 1, 'offline reached Slack');
    assert.equal(offline.checks.find((check) => check.id === 'identity')?.detail, 'not asked');
  } finally {
    await close();
  }
});

test('a doctor asked about one workspace reports that one, and a pinned server’s says nothing of any other', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', userId: 'U0002' });
  const pinned = await connect(harness, { workspace: 'acme' });
  const open = await connect(harness);
  try {
    const own = await pinned.call('slack_doctor', { offline: true });
    assert.notEqual(own.isError, true, JSON.stringify(own.structuredContent));
    const text = JSON.stringify(own.structuredContent);
    assert.match(text, /acme/);
    assert.doesNotMatch(text, /zeta|T0002|U0002/, 'the pinned server described a workspace it cannot reach');

    // The same scope asked for by name, from either surface, is the same answer.
    const named = await open.call('slack_doctor', { workspace: 'acme', offline: true });
    const command = await cli(harness, ['--json', 'doctor', '--workspace', 'acme', '--offline']);
    assert.equal(command.code, EXIT_CODES.OK);
    assert.deepEqual(named.structuredContent, own.structuredContent);
    assert.deepEqual(command.json<Envelope<unknown>>().data, own.structuredContent);

    const unknown = await open.call('slack_doctor', { workspace: 'nobody', offline: true });
    assert.equal(unknown.isError, true, 'a name that is not connected is not a clean bill of health');
    const unknownCommand = await cli(harness, ['--json', 'doctor', '--workspace', 'nobody', '--offline']);
    assert.equal(unknownCommand.code, EXIT_CODES.NOT_FOUND);
  } finally {
    await pinned.close();
    await open.close();
  }
});

// ── manifest ───────────────────────────────────────────────────────────────────────────────────────────────────

test('slack_manifest returns the manifest for a mode and a port, as `agent-slack manifest` does', async () => {
  const harness = await newHarness();
  const { call, close } = await connect(harness);
  try {
    for (const mode of ['read', 'send'] as const) {
      const tool = await call('slack_manifest', { mode, port: 51234 });
      assert.notEqual(tool.isError, true, JSON.stringify(tool.structuredContent));
      const command = await cli(harness, ['--json', 'manifest', '--mode', mode, '--port', '51234']);
      assert.deepEqual(tool.structuredContent, command.json<Envelope<unknown>>().data, mode);
      const data = tool.structuredContent as {
        redirectUrl: string;
        manifestUrl: string | null;
        manifest: { oauth_config: { scopes: { user: string[] } } };
      };
      assert.equal(data.redirectUrl, 'http://localhost:51234/slack/callback');
      assert.equal(data.manifest.oauth_config.scopes.user.includes('chat:write'), mode === 'send');
      assert.equal(data.manifestUrl, null, 'no workspace named, so no app to link to');
    }
  } finally {
    await close();
  }
});

test('given a workspace, slack_manifest uses the port it signed in with and links straight to its app’s manifest', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 50123, appId: 'A0ABC123' });
  const { call, close } = await connect(harness);
  try {
    const tool = await call('slack_manifest', { workspace: 'acme', mode: 'send' });
    assert.notEqual(tool.isError, true, JSON.stringify(tool.structuredContent));
    const data = tool.structuredContent as { port: number; workspace: string; appId: string; manifestUrl: string };
    assert.equal(data.port, 50123, 'the recorded port, which is the one the app redirects to');
    assert.equal(data.workspace, 'acme');
    assert.equal(data.appId, 'A0ABC123');
    assert.equal(data.manifestUrl, 'https://api.slack.com/apps/A0ABC123/app-manifest');

    const command = await cli(harness, ['--json', 'manifest', '--workspace', 'acme', '--mode', 'send']);
    assert.deepEqual(command.json<Envelope<unknown>>().data, tool.structuredContent);
    const human = await cli(harness, ['manifest', '--workspace', 'acme', '--mode', 'send']);
    assert.match(human.stdout, /https:\/\/api\.slack\.com\/apps\/A0ABC123\/app-manifest/, 'a person gets the link too');

    // A port given still wins: it is what the person is about to paste.
    const given = await call('slack_manifest', { workspace: 'acme', mode: 'send', port: 50999 });
    assert.equal((given.structuredContent as { port: number }).port, 50999);
  } finally {
    await close();
  }
});

test('a workspace that never recorded its app id gets no link rather than a guessed one', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 50123 });
  // As a workspace connected before the app id was kept: the field is simply not there.
  await harness.core.config.update((config) => {
    const { appId: _dropped, ...acme } = config.accounts.acme ?? assert.fail('acme is connected');
    return { ...config, accounts: { ...config.accounts, acme } };
  });
  const { call, close } = await connect(harness);
  try {
    const data = (await call('slack_manifest', { workspace: 'acme' })).structuredContent as {
      appId: string | null;
      manifestUrl: string | null;
    };
    assert.equal(data.appId, null);
    assert.equal(data.manifestUrl, null);
  } finally {
    await close();
  }
});

test('slack_manifest refuses a missing or impossible port as the CLI does', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const { call, close } = await connect(harness);
  try {
    for (const [args, argv] of [
      [{ mode: 'read' }, ['manifest', '--mode', 'read']],
      // Named, but it signed in before ports were kept: there is no recorded one to fall back on.
      [{ workspace: 'acme' }, ['manifest', '--workspace', 'acme']],
      [{ port: 70000 }, ['manifest', '--port', '70000']],
    ] as const) {
      const tool = await call('slack_manifest', { ...args });
      assert.equal(tool.isError, true, JSON.stringify(args));
      const command = await cli(harness, ['--json', ...argv]);
      assert.equal(command.code, EXIT_CODES.USAGE, argv.join(' '));
      const toolError = (tool.structuredContent as { error: { code: string; message: string } }).error;
      assert.equal(toolError.code, 'USAGE');
      assert.equal(toolError.message, command.json<Envelope<never>>().error?.message, argv.join(' '));
    }
  } finally {
    await close();
  }
});

// ── workspace show ─────────────────────────────────────────────────────────────────────────────────────────────

test('slack_workspace_show is `agent-slack workspace show`', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', redirectPort: 50123 });
  const { call, close } = await connect(harness);
  try {
    const tool = await call('slack_workspace_show', { workspace: 'acme' });
    assert.notEqual(tool.isError, true, JSON.stringify(tool.structuredContent));
    const command = await cli(harness, ['--json', 'workspace', 'show', 'acme']);
    assert.deepEqual(tool.structuredContent, command.json<Envelope<unknown>>().data);
    assert.equal((tool.structuredContent as { mode: string }).mode, 'send');

    const missing = await call('slack_workspace_show', { workspace: 'nobody' });
    assert.equal((missing.structuredContent as { error: { code: string } }).error.code, 'NOT_FOUND');
  } finally {
    await close();
  }
});
