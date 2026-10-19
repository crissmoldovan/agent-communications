import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { approvalCount, type BehaviourWorld, behaviourWorld, ENG, MINE, setRules } from './support/behaviour.ts';
import { LISTENER_COMMAND } from './support/listener.ts';

/**
 * What an agent may do in Slack, refused at prepare through both surfaces (design 2026-10-19-agent-behaviour-rules,
 * §4: "Enforcement at prepare, for every act of every channel, through the CLI and MCP: refused with ACT_NOT_ALLOWED,
 * with no preview and no approval created"). Each act is prepared from the command line and from its tool, against the
 * loopback fake: nothing here reaches the real Slack, and Slack is never asked to write anything.
 */

/** Every Slack method that puts something in front of people. None may be asked once a rule refuses the act. */
const WRITES = [
  'chat.postMessage',
  'reactions.add',
  'reactions.remove',
  'chat.update',
  'chat.delete',
  'files.getUploadURLExternal',
  'files.completeUploadExternal',
];

interface Failure {
  readonly code: string;
  readonly message: string;
  readonly hint?: string | null;
  readonly details?: Record<string, unknown>;
}

interface Envelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: Failure;
}

/** The CLI as an agent runs it: `--json`, no terminal, against the world's loopback Slack. */
async function cli(w: BehaviourWorld, argv: string[]): Promise<{ code: number; envelope: Envelope }> {
  let stdout = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const code = await run(['--json', ...argv], {
    core: w.harness.core,
    env: { ...w.harness.env, CLAUDECODE: '1' },
    platform: 'darwin',
    exchange: (params) => w.harness.exchange(params),
    streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
    openBrowser: () => undefined,
    listenerCommand: LISTENER_COMMAND,
    read: w.fake.fetch,
  });
  return { code, envelope: JSON.parse(stdout) as Envelope };
}

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

/** The tools, over an in-memory transport, against the world's loopback Slack. */
async function tools(t: TestContext, w: BehaviourWorld) {
  const { server } = await createSlackMcpServer({
    core: w.harness.core,
    env: w.harness.env,
    platform: 'darwin',
    exchange: (params) => w.harness.exchange(params),
    listenerCommand: LISTENER_COMMAND,
    fetch: w.fake.fetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(() => Promise.all([client.close(), server.close()]));
  return async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** B4's refusal, as each surface carries it, with no preview beside it. */
function assertRefused(error: Failure | undefined, act: string, what: string): void {
  assert.ok(error, `${what}: no refusal`);
  assert.equal(error.code, 'ACT_NOT_ALLOWED', `${what}: ${error.message}`);
  assert.equal(error.details?.act, act, what);
  assert.equal(error.message, 'this agent may only reply in #eng (acme)', what);
  assert.match(error.hint ?? '', /behaviour/, `${what}: the hint does not name what shows the rules`);
}

async function nothingMade(w: BehaviourWorld, what: string): Promise<void> {
  assert.equal(await approvalCount(w.harness), 0, `${what}: an approval was made for an act no rule allows`);
  for (const method of WRITES) assert.equal(w.asked(method), 0, `${what}: Slack was asked ${method}`);
}

/** A world where this account may only reply in #eng: a post, a reaction, an edit and a deletion there are refused. */
async function onlyReplies(t: TestContext): Promise<BehaviourWorld> {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: ENG, acts: ['reply'] }]);
  return w;
}

/** A draft written at the command line, as an agent would before preparing it: drafts reach nobody, and are allowed. */
async function draftOf(w: BehaviourWorld, words: string[]): Promise<string> {
  const { code, envelope } = await cli(w, ['draft', 'create', '--workspace', 'acme', '--channel', ENG, ...words]);
  assert.equal(code, EXIT_CODES.OK, JSON.stringify(envelope));
  return (envelope.data as { draftId: string }).draftId;
}

const CLI_CASES: readonly { name: string; act: string; argv: (w: BehaviourWorld) => Promise<string[]> }[] = [
  {
    name: 'a post',
    act: 'post',
    argv: async (w) => ['post', 'prepare', '--workspace', 'acme', '--draft', await draftOf(w, ['--text', 'shipping'])],
  },
  {
    // A reply whose thread is no message in #eng is the post Slack makes of it (review of spec 2, finding 9).
    name: 'a reply to no message, which Slack posts as new,',
    act: 'post',
    argv: async (w) => [
      'post',
      'prepare',
      '--workspace',
      'acme',
      '--draft',
      await draftOf(w, ['--text', 'shipping', '--thread', '1700000000.009999']),
    ],
  },
  {
    name: 'a reaction',
    act: 'reaction',
    argv: async () => ['react', '--workspace', 'acme', '--channel', ENG, '--ts', MINE, '--emoji', 'eyes'],
  },
  {
    name: 'an edit',
    act: 'edit',
    argv: async (w) => [
      'edit',
      'prepare',
      '--workspace',
      'acme',
      '--draft',
      await draftOf(w, ['--text', 'shipping in ten minutes']),
      '--ts',
      MINE,
    ],
  },
  {
    name: 'a deletion',
    act: 'delete',
    argv: async () => ['delete', 'prepare', '--workspace', 'acme', '--channel', ENG, '--ts', MINE],
  },
];

for (const each of CLI_CASES) {
  test(`at the command line, ${each.name} that a rule forbids is refused at prepare: exit 10, no preview, no approval`, async (t) => {
    const w = await onlyReplies(t);
    const argv = await each.argv(w);
    const { code, envelope } = await cli(w, argv);
    assert.equal(code, 10, `${argv.join(' ')}: ${JSON.stringify(envelope)}`);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data, undefined, 'a preview came back beside the refusal');
    assertRefused(envelope.error, each.act, argv.join(' '));
    await nothingMade(w, argv.join(' '));
  });
}

const TOOL_CASES: readonly { name: string; act: string; tool: string; args: Record<string, unknown> }[] = [
  { name: 'a post', act: 'post', tool: 'slack_post_prepare', args: { channel: ENG, text: 'shipping' } },
  {
    name: 'a reply to no message, which Slack posts as new,',
    act: 'post',
    tool: 'slack_post_prepare',
    args: { channel: ENG, text: 'shipping', threadTs: '1700000000.009999' },
  },
  { name: 'a reaction', act: 'reaction', tool: 'slack_react', args: { channel: ENG, ts: MINE, emoji: 'eyes' } },
  {
    name: 'an edit',
    act: 'edit',
    tool: 'slack_edit_prepare',
    args: { channel: ENG, ts: MINE, text: 'shipping in ten minutes' },
  },
  { name: 'a deletion', act: 'delete', tool: 'slack_delete_prepare', args: { channel: ENG, ts: MINE } },
];

for (const each of TOOL_CASES) {
  const what = `${each.tool}, ${each.name}`;
  test(`over MCP, ${each.name} that a rule forbids is refused by ${each.tool}: no preview, no approval`, async (t) => {
    const w = await onlyReplies(t);
    const call = await tools(t, w);
    const result = await call(each.tool, { workspace: 'acme', ...each.args });
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    const content = result.structuredContent ?? {};
    assert.equal(content.preview, undefined, 'a preview came back beside the refusal');
    assert.equal(content.approvalId, undefined, 'an approval id came back beside the refusal');
    assertRefused(content.error as Failure | undefined, each.act, what);
    await nothingMade(w, what);
  });
}
