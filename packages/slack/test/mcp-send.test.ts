import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { compose } from '../src/compose/blocks.ts';
import { openDraftStore } from '../src/compose/drafts.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * Posting and reacting over MCP, through the gate the CLI uses.
 *
 * The owner's rule of 2026-09-25 put these on the MCP surface: every capability is reachable from both. The rule under
 * it did not move — nothing reaches Slack unless a person approved that exact content, in the conversation under
 * `chat` and at their own terminal under `confirm` — so most of what follows is about what the tools refuse, and about
 * the one thing no tool may do: approve. Each test drives the tools in the order an agent and a person would, with a
 * scripted Slack that counts what it was asked and never reaches the real one.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface Failure {
  code: string;
  message: string;
  hint: string | null;
  details?: Record<string, unknown>;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

/** Slack as a script of replies by method, counting what it was asked. The script can be changed mid-test. */
function scripted(script: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const read: FakeFetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    asked.push(method);
    return new Response(JSON.stringify(script[method] ?? { ok: false, error: 'unknown_method' }));
  };
  return { read, script, count: (method: string) => asked.filter((name) => name === method).length };
}

const ROOM = { ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } };

function slack() {
  return scripted({
    'conversations.info': ROOM,
    'chat.postMessage': { ok: true, ts: '1700000000.000100' },
    'reactions.add': { ok: true },
    'reactions.remove': { ok: true },
  });
}

async function connect(harness: Harness, fetch: FakeFetch, options: { workspace?: string } = {}) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    fetch,
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

const failure = (result: ToolResult): Failure => (result.structuredContent as { error: Failure }).error;

/** The CLI, as a person at a terminal runs it: the approval code is read off the prompt and typed back. */
async function cli(
  harness: Harness,
  argv: string[],
  options: { read?: FakeFetch; tty?: boolean; answerChallenge?: boolean } = {},
) {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  const input = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  let answered = false;
  err.on('data', (chunk) => {
    stderr += String(chunk);
    if (options.answerChallenge && !answered) {
      const asked = /Type (\S+) to approve/.exec(stderr);
      if (asked) {
        answered = true;
        input.write(`${asked[1]}\n`);
      }
    }
  });
  const code = await run(argv, {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: {
      stdout: Object.assign(out, { isTTY: options.tty ?? false }),
      stderr: Object.assign(err, { isTTY: options.tty ?? false }),
      stdin: Object.assign(input, { isTTY: options.tty ?? false }),
    },
    openBrowser: () => undefined,
    probe: (probeInput, init) => harness.probe(probeInput, init),
    // Always a scripted Slack: a test that forgot it would reach the real one.
    read: options.read ?? scripted().read,
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

/** A person approving at their own terminal — the one step no tool takes. */
async function personApproves(harness: Harness, approvalId: string, read: FakeFetch): Promise<void> {
  const approved = await cli(harness, ['approve', approvalId], { read, tty: true, answerChallenge: true });
  assert.equal(approved.code, EXIT_CODES.OK, approved.stdout + approved.stderr);
}

async function prepared(
  call: Awaited<ReturnType<typeof connect>>['call'],
  args: Record<string, unknown> = {},
): Promise<{ draftId: string; approvalId: string }> {
  const result = await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'shipping now', ...args });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent as { draftId: string; approvalId: string };
}

// ── Posting ────────────────────────────────────────────────────────────────────────────────────────────────────

test('under `chat`, slack_post_send posts the prepared draft once, and records that the agent did', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const { draftId, approvalId } = await prepared(call);
    assert.equal(fake.count('chat.postMessage'), 0, 'preparing posts nothing');

    const posted = await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' });
    assert.notEqual(posted.isError, true, JSON.stringify(posted.structuredContent));
    assert.deepEqual(posted.structuredContent, { approvalId, channel: 'C1', ts: '1700000000.000100' });
    assert.equal(fake.count('chat.postMessage'), 1);

    const again = await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' });
    assert.equal(again.isError, true, 'an approval is spent by the post it permits');
    assert.match(failure(again).message, /nothing was sent/);
    assert.equal(fake.count('chat.postMessage'), 1, 'so a second call reaches nothing');

    const records = await harness.core.audit.tail({ limit: 20 });
    assert.ok(
      records.some(
        (record) => record.operation === 'slack.post' && record.outcome === 'ok' && record.surface === 'mcp',
      ),
      `the post is in the audit trail as the agent's: ${JSON.stringify(records.map((r) => [r.operation, r.surface]))}`,
    );
  } finally {
    await close();
  }
});

test('under `confirm`, slack_post_send waits for a person, hands over the terminal command, and never approves', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const { draftId, approvalId } = await prepared(call);
    const send = { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' };

    const held = await call('slack_post_send', send);
    assert.equal(held.isError, true);
    const error = failure(held);
    assert.equal(error.code, 'APPROVAL_PENDING', 'waiting, not refused');
    assert.equal(error.details?.approvalId, approvalId);
    assert.equal(error.details?.command, `agent-slack approve ${approvalId}`, 'the one command a person runs');
    assert.match(error.hint ?? '', new RegExp(`agent-slack approve ${approvalId}`));
    assert.match(error.hint ?? '', /slack_post_send/, 'and what the agent does once they have');
    assert.doesNotMatch(error.hint ?? '', /agent-slack post send/, 'not a command for a shell the agent is not in');
    assert.equal(fake.count('chat.postMessage'), 0, 'nothing is posted while it waits');

    const record = await harness.core.approvals.get(approvalId);
    assert.equal(record?.state, 'pending', 'asking did not approve it');
    assert.equal(record?.approvedVia, undefined);

    await personApproves(harness, approvalId, fake.read);
    assert.equal(fake.count('chat.postMessage'), 0, 'approving does not post');

    const posted = await call('slack_post_send', send);
    assert.notEqual(posted.isError, true, JSON.stringify(posted.structuredContent));
    assert.equal(fake.count('chat.postMessage'), 1, 'the person’s approval posts it, once');
  } finally {
    await close();
  }
});

test('an @channel needs a person at a terminal even where the workspace says `chat`', async () => {
  // The people it interrupts are not in the conversation to object, so a yes in the chat is not theirs to give.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const { draftId, approvalId } = await prepared(call, { broadcast: 'channel' });
    const held = await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' });
    assert.equal(failure(held).code, 'APPROVAL_PENDING');
    assert.equal(fake.count('chat.postMessage'), 0);
  } finally {
    await close();
  }
});

test('under `never`, slack_post_send refuses and nothing is posted', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const { draftId, approvalId } = await prepared(call);
    // Tightened after the preview, which needs nobody's consent: the policy in force when it posts is what counts.
    await harness.core.config.update((config) => {
      const acme = config.accounts.acme;
      assert.ok(acme);
      return { ...config, accounts: { ...config.accounts, acme: { ...acme, sendPolicy: 'never' } } };
    });
    const refused = await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' });
    assert.equal(failure(refused).code, 'POLICY_NEVER');
    assert.equal(fake.count('chat.postMessage'), 0);
  } finally {
    await close();
  }
});

test('slack_post_send refuses what `post send` refuses: another channel, an edited draft, another workspace’s draft', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat', workspaceId: 'T0001' });
  await harness.addWorkspace({ alias: 'zeta', mode: 'send', sendPolicy: 'chat', workspaceId: 'T0002', userId: 'U2' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    // The channel the caller believes it is posting to is checked, not filled in from the draft.
    const first = await prepared(call);
    const elsewhere = await call('slack_post_send', { workspace: 'acme', ...first, expectChannel: 'C2' });
    assert.equal(failure(elsewhere).code, 'APPROVAL_VOID');
    assert.match(failure(elsewhere).message, /posts to C1, not C2/);

    // The approval binds the bytes the person read.
    const second = await prepared(call);
    await openDraftStore(harness.core.paths.stateDir, () => new Date()).update(
      second.draftId,
      compose({ channel: 'C1', text: 'something else' }),
      'something else',
    );
    const edited = await call('slack_post_send', { workspace: 'acme', ...second, expectChannel: 'C1' });
    assert.equal(failure(edited).code, 'APPROVAL_VOID');

    // A draft of another workspace is absent here, as it is to `post send`.
    const third = await prepared(call);
    const stolen = await call('slack_post_send', { workspace: 'zeta', ...third, expectChannel: 'C1' });
    assert.equal(failure(stolen).code, 'NOT_FOUND');

    assert.equal(fake.count('chat.postMessage'), 0, 'none of them reached Slack');
  } finally {
    await close();
  }
});

/** A draft file rewritten by hand so its blocks say `said` — what anything with a shell can do to it. */
async function rewriteBlocks(harness: Harness, draftId: string, said: string): Promise<void> {
  const path = join(harness.core.paths.stateDir, 'slack', 'drafts', `${draftId}.json`);
  const draft = JSON.parse(await readFile(path, 'utf8')) as { payload: { blocks: unknown[] } };
  draft.payload.blocks = [{ type: 'section', text: { type: 'mrkdwn', text: said } }];
  await writeFile(path, `${JSON.stringify(draft, null, 2)}\n`);
}

/** The scripted Slack, keeping the form of every `chat.postMessage` it was sent. */
function recordingSlack() {
  const fake = slack();
  const posted: URLSearchParams[] = [];
  const read: FakeFetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/chat.postMessage')) posted.push(new URLSearchParams(String(init?.body ?? '')));
    return fake.read(input, init);
  };
  return { ...fake, read, posted };
}

test('a draft whose blocks were rewritten on disk is never previewed from its text, approved, and posted as its blocks', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = recordingSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    // Written the ordinary way, and prepared once while it was still what the composer wrote.
    const first = await prepared(call);
    const hidden = '<!channel> wire the float to account 4471';
    await rewriteBlocks(harness, first.draftId, hidden);

    // Prepared from the file: a preview of `shipping now` would not be what posts, so there is no preview at all.
    const again = await call('slack_post_prepare', { workspace: 'acme', draftId: first.draftId });
    assert.equal(again.isError, true, `previewed from its text: ${JSON.stringify(again.structuredContent)}`);
    assert.equal(failure(again).code, 'BAD_DATA');
    assert.match(failure(again).message, /not what its text composes to/);

    // Nor does the approval given before the rewrite post it, as its blocks or as anything else.
    const posted = await call('slack_post_send', { workspace: 'acme', ...first, expectChannel: 'C1' });
    assert.equal(posted.isError, true);
    assert.match(failure(posted).message, /nothing was sent/);
    assert.equal(fake.count('chat.postMessage'), 0, 'nothing reached Slack');
    assert.ok(
      !fake.posted.some((form) => (form.get('blocks') ?? '').includes('4471')),
      'the rewritten blocks never went',
    );

    // A draft the composer wrote goes as it always did, and what goes is exactly what the preview showed.
    const ordinary = await prepared(call, { text: 'rollout at 3pm' });
    const sent = await call('slack_post_send', { workspace: 'acme', ...ordinary, expectChannel: 'C1' });
    assert.notEqual(sent.isError, true, JSON.stringify(sent.structuredContent));
    assert.equal(fake.posted.length, 1);
    assert.equal(fake.posted[0]?.get('text'), 'rollout at 3pm');
    assert.deepEqual(JSON.parse(fake.posted[0]?.get('blocks') ?? 'null'), [
      { type: 'section', text: { type: 'mrkdwn', text: 'rollout at 3pm' } },
    ]);
  } finally {
    await close();
  }
});

test('a post held for a person is the same refusal on both surfaces, each naming its own next step', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const { draftId, approvalId } = await prepared(call);
    const tool = failure(
      await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' }),
    );
    const send = ['post', 'send', '--workspace', 'acme', '--draft', draftId, '--approval', approvalId];
    const terminal = await cli(harness, ['--json', ...send, '--expect-channel', 'C1'], { read: fake.read });
    assert.equal(terminal.code, EXIT_CODES.APPROVAL, terminal.stdout);
    const error = terminal.json<Envelope<never>>().error;
    assert.equal(error?.code, tool.code);
    assert.equal(error?.message, tool.message);
    assert.deepEqual(error?.details, tool.details, 'the same approval, and the same command for the person');
    assert.match(error?.hint ?? '', /agent-slack post send/);
    assert.match(tool.hint ?? '', /slack_post_send/);
  } finally {
    await close();
  }
});

// ── Reactions ──────────────────────────────────────────────────────────────────────────────────────────────────

const REACTION = { workspace: 'acme', channel: 'C1', ts: '1.1', emoji: 'tada' };

test('under `chat`, slack_react adds the reaction the person said yes to, once', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const made = await call('slack_react', REACTION);
    assert.notEqual(made.isError, true, JSON.stringify(made.structuredContent));
    assert.match(String((made.structuredContent as { approvalId: string }).approvalId), /^ap_/);
    assert.equal(fake.count('reactions.add'), 1);

    const record = await harness.core.approvals.get((made.structuredContent as { approvalId: string }).approvalId);
    assert.equal(record?.state, 'used', 'through a real approval, spent by the reaction it permitted');
  } finally {
    await close();
  }
});

test('under `confirm`, slack_react adds nothing and hands over the command; slack_react_send uses the person’s approval once', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const held = await call('slack_react', REACTION);
    const error = failure(held);
    assert.equal(error.code, 'APPROVAL_PENDING');
    const approvalId = String(error.details?.approvalId);
    assert.match(approvalId, /^ap_/);
    assert.equal(error.details?.command, `agent-slack approve ${approvalId}`);
    assert.match(error.hint ?? '', /slack_react_send/, 'the tool that uses the approval once it is given');
    assert.doesNotMatch(error.hint ?? '', /--approval/, 'not a flag for a command the agent is not running');
    assert.equal(fake.count('reactions.add'), 0);

    // Tried again before the person has approved: still waiting, and on the same approval — not a new one nobody saw.
    const early = await call('slack_react_send', { ...REACTION, approvalId });
    assert.equal(failure(early).code, 'APPROVAL_PENDING');
    assert.equal(failure(early).details?.approvalId, approvalId);
    assert.equal((await harness.core.approvals.list()).length, 1, 'no second approval was made');
    assert.equal((await harness.core.approvals.get(approvalId))?.state, 'pending', 'and none was approved');

    await personApproves(harness, approvalId, fake.read);

    const made = await call('slack_react_send', { ...REACTION, approvalId });
    assert.notEqual(made.isError, true, JSON.stringify(made.structuredContent));
    assert.deepEqual(made.structuredContent, { approvalId });
    assert.equal(fake.count('reactions.add'), 1);

    const again = await call('slack_react_send', { ...REACTION, approvalId });
    assert.equal(again.isError, true, 'single use');
    assert.equal(fake.count('reactions.add'), 1);
  } finally {
    await close();
  }
});

test('slack_react_send is bound to the channel, message and emoji a person approved', async () => {
  const swaps: [string, Record<string, unknown>][] = [
    ['another emoji', { emoji: 'thumbsdown' }],
    ['another channel', { channel: 'C2' }],
    ['another message', { ts: '2.2' }],
    ['taking it off instead', { remove: true }],
  ];
  for (const [what, swap] of swaps) {
    const harness = await newHarness();
    await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
    const fake = slack();
    const { call, close } = await connect(harness, fake.read);
    try {
      const approvalId = String(failure(await call('slack_react', REACTION)).details?.approvalId);
      await personApproves(harness, approvalId, fake.read);
      const swapped = await call('slack_react_send', { ...REACTION, ...swap, approvalId });
      assert.equal(swapped.isError, true, `${what} was allowed`);
      assert.equal(fake.count('reactions.add') + fake.count('reactions.remove'), 0, `${what} reached Slack`);
    } finally {
      await close();
    }
  }
});

test('under `never`, slack_react refuses before an approval is made', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'never' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const refused = await call('slack_react', REACTION);
    assert.equal(failure(refused).code, 'POLICY_NEVER');
    assert.deepEqual(await harness.core.approvals.list(), []);
    assert.equal(fake.count('reactions.add'), 0);
  } finally {
    await close();
  }
});

test('a reaction held for a person is the same refusal from `agent-slack react` and slack_react', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const tool = failure(await call('slack_react', REACTION));
    const terminal = await cli(
      harness,
      ['--json', 'react', '--workspace', 'acme', '--channel', 'C1', '--ts', '1.1', '--emoji', 'tada'],
      { read: fake.read },
    );
    const error = terminal.json<Envelope<never>>().error;
    assert.equal(error?.code, tool.code);
    assert.equal(error?.message, tool.message);
    assert.equal(error?.details?.command, `agent-slack approve ${String(error?.details?.approvalId)}`);
    assert.deepEqual(Object.keys(error?.details ?? {}).sort(), Object.keys(tool.details ?? {}).sort());
    assert.match(error?.hint ?? '', /--approval/, 'the CLI names its own next step');
  } finally {
    await close();
  }
});
