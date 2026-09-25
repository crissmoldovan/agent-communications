import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { LISTENER_COMMAND } from './support/listener.ts';

/*
 * Every Slack tool holds a call to the arguments it declares (design 2026-09-18 §11: "unknown fields are rejected"),
 * and refuses one that fails its schema as USAGE, in the envelope every other refusal uses.
 *
 * The SDK stripped a key a tool did not declare and ran the call without it. `thread_ts` — Slack's own name for what
 * this tool calls `threadTs` — was dropped from `slack_post_prepare`, and the reply was prepared for the channel
 * instead of the thread. And a fraction for `limit`, or a word for `remove`, came back as the SDK's "Input validation
 * error", which carries no code for an agent to act on.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

interface Failure {
  code: string;
  message: string;
  hint: string | null;
  details?: Record<string, unknown>;
}

/** Slack as a script of replies by method, counting everything it was asked. */
function scripted(script: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const read: FakeFetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    asked.push(method);
    return new Response(JSON.stringify(script[method] ?? { ok: false, error: 'unknown_method' }));
  };
  return { read, asked };
}

function slack() {
  return scripted({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } },
    'conversations.history': { ok: true, messages: [{ ts: '1.1', user: 'U2', text: 'hello' }] },
    'chat.postMessage': { ok: true, ts: '1700000000.000100' },
    'reactions.add': { ok: true },
  });
}

async function connect(harness: Harness, fetch: FakeFetch, workspace?: string) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    listenerCommand: LISTENER_COMMAND,
    fetch,
    probe: (input, init) => harness.probe(input, init),
    ...(workspace ? { workspace } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

/** A USAGE refusal in the envelope, with its text block mirroring it — not the SDK's uncoded text. */
function usage(result: ToolResult): Failure {
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(result.structuredContent)}`);
  const error = (result.structuredContent as { error?: Failure } | undefined)?.error;
  assert.ok(error, `refused without a code: ${JSON.stringify(result.content)}`);
  assert.equal(error.code, 'USAGE', JSON.stringify(error));
  assert.deepEqual(JSON.parse(result.content?.[0]?.text ?? 'null'), result.structuredContent);
  return error;
}

const configOf = (harness: Harness) => readFileSync(join(harness.configDir, 'config.json'), 'utf8');
const draftsOf = (harness: Harness) => {
  const directory = join(harness.core.paths.stateDir, 'slack', 'drafts');
  return existsSync(directory) ? readdirSync(directory) : [];
};

test('slack_post_prepare with `thread_ts` for `threadTs` is refused, and nothing is drafted or asked of Slack', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const error = usage(
      await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'on it', thread_ts: '1.1' }),
    );
    assert.match(error.message, /slack_post_prepare does not take `thread_ts`/);
    assert.match(error.hint ?? '', /`threadTs`/, 'the key it does take is named');
    assert.deepEqual(error.details?.unknown, ['thread_ts']);
  } finally {
    await close();
  }
  assert.deepEqual(fake.asked, [], 'Slack was asked nothing');
  assert.deepEqual(draftsOf(harness), [], 'no draft was written');
  assert.deepEqual(await harness.core.approvals.list(), [], 'no approval was prepared');
});

test('slack_workspace_add with a key it does not take is refused before any sign-in or approval', async () => {
  const harness = await newHarness();
  const before = configOf(harness);
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const error = usage(await call('slack_workspace_add', { workspace: 'acme', client_id: '123.456', mode: 'send' }));
    assert.match(error.message, /slack_workspace_add does not take `client_id`/);
    assert.match(error.hint ?? '', /`clientId` \(required\)/);
  } finally {
    await close();
  }
  assert.equal(configOf(harness), before, 'the config is as it was');
  assert.deepEqual(await harness.core.approvals.list(), []);
  assert.deepEqual(harness.calls, [], 'no token was exchanged');
});

test('a fraction, a word for a flag or a missing argument is USAGE naming it, from the Slack server', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const limit = usage(await call('slack_read', { workspace: 'acme', channel: 'C1', limit: 1.5 }));
    assert.match(limit.message, /`limit` takes a whole number of 1 or more/);

    const remove = usage(
      await call('slack_react', { workspace: 'acme', channel: 'C1', ts: '1.1', emoji: 'eyes', remove: 'yes' }),
    );
    assert.match(remove.message, /`remove` takes true or false/);
    assert.match(remove.hint ?? '', /`remove`: take the reaction off/);

    const missing = usage(await call('slack_read', { workspace: 'acme' }));
    assert.match(missing.message, /`channel` is required, and takes a string/);

    const mentions = usage(
      await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'hi', mentionUsers: 'U1' }),
    );
    assert.match(mentions.message, /`mentionUsers` takes a list of strings/);
    assert.deepEqual([...fake.asked], [], 'none of them reached Slack');

    // …and a call that is right still works.
    const read = await call('slack_read', { workspace: 'acme', channel: 'C1', limit: 5 });
    assert.notEqual(read.isError, true, JSON.stringify(read.structuredContent));
    assert.ok(fake.asked.includes('conversations.history'));
  } finally {
    await close();
  }
  assert.deepEqual(await harness.core.approvals.list(), []);
});

test('a pinned Slack server refuses an unknown key before it resolves the pin', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const { call, close } = await connect(harness, slack().read, 'acme');
  try {
    const error = usage(await call('slack_workspace_show', { workspace: 'acme', verbose: true }));
    assert.match(error.message, /slack_workspace_show does not take `verbose`/);
    const shown = await call('slack_workspace_show', {});
    assert.notEqual(shown.isError, true, JSON.stringify(shown.structuredContent));

    // With the workspace gone from under it, a call it takes is answered by the pin, and one it does not by the check
    // first: the arguments are looked at before anything is read, the configuration included.
    const path = join(harness.configDir, 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8')) as { accounts: Record<string, unknown> };
    delete config.accounts.acme;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    const gone = (await call('slack_workspace_show', {})).structuredContent as { error?: Failure } | undefined;
    assert.equal(gone?.error?.code, 'NOT_FOUND', JSON.stringify(gone));
    assert.match(usage(await call('slack_workspace_show', { verbose: true })).message, /does not take `verbose`/);
  } finally {
    await close();
  }
});

test('every Slack tool, pinned or not, refuses a key it does not take and publishes only its own', async () => {
  // By construction: a tool added later is held to this without anyone remembering to.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const before = configOf(harness);
  const fake = slack();
  for (const workspace of [undefined, 'acme']) {
    const { client, call, close } = await connect(harness, fake.read, workspace);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 10, `${tools.length} tools`);
      for (const tool of tools) {
        const label = `${tool.name} (${workspace ?? 'unpinned'})`;
        assert.equal(tool.inputSchema.additionalProperties, false, `${label} publishes additionalProperties: false`);
        const error = usage(await call(tool.name, { zzUnknown: 1 }));
        assert.match(error.message, new RegExp(`${tool.name} does not take \`zzUnknown\``), label);
      }
    } finally {
      await close();
    }
  }
  assert.deepEqual(fake.asked, [], 'nothing reached Slack');
  assert.equal(configOf(harness), before, 'nothing was changed');
  assert.deepEqual(draftsOf(harness), []);
  assert.deepEqual(await harness.core.approvals.list(), []);
});
