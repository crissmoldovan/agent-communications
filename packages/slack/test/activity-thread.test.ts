import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { type ActivityLine, EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type Script, scriptedSlack } from './support/amend.ts';
import { type Harness, newHarness } from './support/harness.ts';

/*
 * 0.32.0, Task E (design 2026-10-26-owner-feedback-0320 §3.6): Slack's activity lines carry the ids that join them to
 * the message an event names, `<channelId>/<ts>`. A post records the thread it went into — the parent's ts, or null
 * for a new message — and the conversation's id; a history read records the conversation's id beside the name it
 * already kept. Against a scripted Slack given as the client's fetch: nothing here reaches Slack or posts anywhere.
 */

const THEIRS = '1700000005.000100';
const POSTED_TS = '1700000009.000100';
const WORDS = 'the reply the agent wrote, never in a line';
const BODY = 'Davids message body, never in a line';

function script(): Script {
  return {
    'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
    'conversations.history': () => ({ ok: true, messages: [{ type: 'message', user: 'U2', text: BODY, ts: THEIRS }] }),
    'conversations.replies': () => ({
      ok: true,
      messages: [{ type: 'message', user: 'U2', text: BODY, ts: THEIRS, thread_ts: THEIRS }],
    }),
    'users.info': (params) => ({ ok: true, user: { id: params.get('user'), profile: { display_name: 'David' } } }),
    'chat.postMessage': () => ({ ok: true, channel: 'C1', ts: POSTED_TS }),
    'auth.test': () => ({
      ok: true,
      url: 'https://acme.slack.com/',
      team: 'Acme',
      user: 'jo',
      team_id: 'T0001',
      user_id: 'U0001',
    }),
  };
}

interface World {
  readonly harness: Harness;
  readonly fetch: ReturnType<typeof scriptedSlack>['fetch'];
  added(call: () => Promise<unknown>): Promise<ActivityLine[]>;
  raw(): string;
}

async function world(): Promise<World> {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const { fetch } = scriptedSlack(script());
  const folder = join(harness.core.paths.stateDir, 'activity');
  const raw = () =>
    existsSync(folder)
      ? readdirSync(folder)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
          .map((name) => readFileSync(join(folder, name), 'utf8'))
          .join('')
      : '';
  const lines = () =>
    raw()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ActivityLine);
  return {
    harness,
    fetch,
    raw,
    async added(call) {
      const before = lines().length;
      await call();
      return lines().slice(before);
    },
  };
}

type Call = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ isError?: boolean; structuredContent?: unknown }>;

async function connect(w: World, t: TestContext): Promise<Call> {
  const { server } = await createSlackMcpServer({
    core: w.harness.core,
    env: w.harness.env,
    fetch: w.fetch,
    platform: 'darwin',
    notify: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'activity-thread-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(() => Promise.all([client.close(), server.close()]));
  return async (name, args) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown };
}

/** `agent-slack`, as an agent's shell runs it. */
async function cli(w: World, argv: string[]): Promise<number> {
  const quiet = () => Object.assign(new PassThrough(), { isTTY: false });
  return run(argv, {
    core: w.harness.core,
    env: w.harness.env,
    exchange: (params) => w.harness.exchange(params),
    streams: { stdout: quiet(), stderr: quiet(), stdin: quiet() },
    openBrowser: () => undefined,
    probe: (input, init) => w.harness.probe(input, init),
    platform: 'darwin',
    read: w.fetch,
    notify: null,
  });
}

function only(lines: ActivityLine[], operation: string): ActivityLine {
  assert.equal(lines.length, 1, JSON.stringify(lines));
  const [line] = lines as [ActivityLine];
  assert.equal(line.operation, operation);
  return line;
}

async function post(call: Call, args: Record<string, unknown>): Promise<{ approvalId: string; draftId: string }> {
  const prepared = await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: WORDS, ...args });
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared.structuredContent));
  return prepared.structuredContent as { approvalId: string; draftId: string };
}

test('a post into a thread names the thread it answers and the conversation by its id', async (t) => {
  const w = await world();
  const call = await connect(w, t);
  const { approvalId, draftId } = await post(call, { threadTs: THEIRS });
  const lines = await w.added(async () => {
    const sent = await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' });
    assert.notEqual(sent.isError, true, JSON.stringify(sent.structuredContent));
  });
  const line = only(lines, 'slack.post.send');
  assert.equal(line.outcome, 'ok');
  assert.equal(line.thread, THEIRS);
  assert.equal(line.channelId, 'C1');
  assert.deepEqual(line.items, [{ id: POSTED_TS, conversation: 'C1' }]);
  assert.equal(w.raw().includes(WORDS), false, 'a post’s words are never in a line');
});

test('a new message names no thread — null, said — and the conversation by its id', async (t) => {
  const w = await world();
  const call = await connect(w, t);
  const { approvalId, draftId } = await post(call, {});
  const line = only(
    await w.added(() => call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' })),
    'slack.post.send',
  );
  assert.equal(line.outcome, 'ok');
  assert.equal(line.thread, null);
  assert.ok('thread' in line, 'a new message says it is one: thread is null, not left out');
  assert.equal(line.channelId, 'C1');
});

test('a history read names the conversation by its id beside its name, on each surface', async (t) => {
  const w = await world();
  const call = await connect(w, t);

  const tool = only(await w.added(() => call('slack_read', { workspace: 'acme', channel: 'C1' })), 'slack.read');
  assert.equal(tool.channelId, 'C1');
  assert.deepEqual(tool.items, [{ id: THEIRS, from: { name: 'David' }, conversation: 'eng' }]);

  const command = only(
    await w.added(async () => {
      assert.equal(await cli(w, ['--json', 'read', 'C1', '--workspace', 'acme']), EXIT_CODES.OK);
    }),
    'slack.read',
  );
  assert.equal(command.channelId, 'C1');
  assert.equal(w.raw().includes(BODY), false, 'a message’s words are never in a line');
});
