import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { asV2, EXIT_CODES, handoffText } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { compose } from '../src/compose/blocks.ts';
import { openDraftStore } from '../src/compose/drafts.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { approveCommand, changedOutsideHint, refileCommand, waitingHint } from '../src/operations/send.ts';
import {
  assertNoBareCommand,
  slackCommand,
  slackHandoffs,
  slackInline,
  slackInlineToFill,
  TEST_PATHS,
} from './support/handoffs.ts';
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
    platform: 'darwin',
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

test('send handoff commands use the selected shell platform, located from this installation (7d)', () => {
  const windows = slackHandoffs(TEST_PATHS, 'win32');
  // The commands themselves, written out as their text where they leave (`handoffText`, or JSON).
  const approve = handoffText(approveCommand('7', windows));
  assert.equal(approve, slackCommand(TEST_PATHS, ['approve', '7'], 'win32'));
  assert.equal(JSON.parse(JSON.stringify({ command: approveCommand('7', windows) })).command, approve);
  const refile = handoffText(refileCommand('8/slack', '9', windows));
  assert.equal(
    refile,
    slackCommand(TEST_PATHS, ['draft', 'update', '9', '--workspace', '8/slack', '--file', '<path…>'], 'win32'),
  );
  // `<path…>` has no line every Windows shell reads alike, so it is the command's words, to be typed.
  assert.ok(refile.includes('"draft","update","9","--workspace","8/slack","--file","<path\\u2026>"]'), refile);
  assert.match(refile, /the command's words, written as JSON/);
  const changed = changedOutsideHint('10', windows);
  assert.equal(
    changed,
    `It was changed outside agent-communications. Delete it with ${slackInlineToFill(TEST_PATHS, ['draft', 'delete', '10', '--workspace'], ['<name>'], 'win32')} and compose it again.`,
  );
  // The name for the agent to fill in is left as written, outside the quoting: `--workspace <name>`.
  assert.match(changed, / draft delete "10" --workspace <name>` and compose it again\.$/);
  for (const text of [approve, refile, changed]) assertNoBareCommand(text);
});

test('a post, a reaction, an edit or a deletion waiting for a person names its approve and the wait — slack_approval_wait over MCP, the located `approval wait` at the command line — quoted for each shell (D7-a)', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const handoffs = slackHandoffs(TEST_PATHS, platform);
    const approve = slackInline(TEST_PATHS, ['approve', '7'], platform);
    for (const surface of ['mcp', 'cli'] as const) {
      const wait =
        surface === 'mcp' ? 'slack_approval_wait' : slackInline(TEST_PATHS, ['approval', 'wait', '7'], platform);
      const again = {
        post:
          surface === 'mcp'
            ? 'call `slack_post_send` again with the same arguments'
            : 'run the same post send command again',
        reaction:
          surface === 'mcp'
            ? 'call `slack_react_send` with approvalId 7 and the same channel, ts and emoji'
            : 'run the same react command again with `--approval 7` added',
      };
      assert.equal(
        waitingHint('post', surface, '7', handoffs),
        `Show the user the preview, then ask them to run ${approve} in their own terminal; learn when they have with ${wait}, then ${again.post}. You cannot approve this yourself.`,
        `${platform} ${surface}`,
      );
      assert.equal(
        waitingHint('reaction', surface, '7', handoffs),
        `Tell the user which emoji and which message, then ask them to run ${approve} in their own terminal; learn when they have with ${wait}, then ${again.reaction}. You cannot approve this yourself.`,
        `${platform} ${surface}`,
      );
      assertNoBareCommand(waitingHint('post', surface, '7', handoffs));
      // An edit and a deletion are sent as a post is: shown first, then the same call made again (design 2026-10-06).
      for (const [kind, tool, command] of [
        ['edit', 'slack_edit_send', 'edit send'],
        ['delete', 'slack_delete_send', 'delete send'],
      ] as const) {
        const next =
          surface === 'mcp'
            ? `call \`${tool}\` again with the same arguments`
            : `run the same ${command} command again`;
        assert.equal(
          waitingHint(kind, surface, '7', handoffs),
          `Show the user the preview, then ask them to run ${approve} in their own terminal; learn when they have with ${wait}, then ${next}. You cannot approve this yourself.`,
          `${platform} ${surface} ${kind}`,
        );
        assertNoBareCommand(waitingHint(kind, surface, '7', handoffs));
      }
    }
  }
});

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
    platform: 'darwin',
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
  // Only the two ids: the rest of the answer — the preview, the policy — is for the person, and `slack_post_send`
  // takes no key it does not declare, so spreading the whole answer into it is refused.
  const { draftId, approvalId } = result.structuredContent as { draftId: string; approvalId: string };
  return { draftId, approvalId };
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
    const { approval, ...result } = posted.structuredContent as { approval: { state: string; sentMessageId: string } };
    assert.deepEqual(result, { approvalId, channel: 'C1', ts: '1700000000.000100' });
    // Where the approval stands (design 2026-10-05 §D8): used, with the message's ts.
    assert.equal(approval.state, 'used');
    assert.equal(approval.sentMessageId, '1700000000.000100');
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
    // This installation's own approve, located: the one command a person runs (CUE-403).
    const approve = slackCommand(harness.core.paths, ['approve', approvalId], 'darwin');
    assert.equal(error.details?.command, approve, 'the one command a person runs');
    assert.ok(error.hint?.includes(`\`${approve}\``), error.hint ?? undefined);
    assertNoBareCommand(error.hint ?? '');
    assert.match(error.hint ?? '', /slack_post_send/, 'and what the agent does once they have');
    assert.doesNotMatch(error.hint ?? '', /post send command/, 'not a command for a shell the agent is not in');
    assert.equal(fake.count('chat.postMessage'), 0, 'nothing is posted while it waits');

    const record = asV2(await harness.core.approvals.get(approvalId));
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
    await openDraftStore(harness.core.paths.stateDir, () => new Date(), slackHandoffs(harness.core.paths)).update(
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
    assert.match(error?.hint ?? '', /run the same post send command again/);
    assertNoBareCommand(error?.hint ?? '');
    assert.match(tool.hint ?? '', /slack_post_send/);
    // Each names the wait that learns when the person has approved, as its surface takes it (D7-a).
    assert.ok(tool.hint?.includes('; learn when they have with slack_approval_wait, then'), tool.hint ?? undefined);
    const wait = slackInline(harness.core.paths, ['approval', 'wait', approvalId], 'darwin');
    assert.ok(error?.hint?.includes(`; learn when they have with ${wait}, then`), error?.hint);
  } finally {
    await close();
  }
});

// ── Outcomes nobody knows, and posts with no id ───────────────────────────────────────────────────────────────

test('a post or reaction whose outcome Slack left unknown is SEND_OUTCOME_UNKNOWN from both surfaces at once, exit 10, still sending', async () => {
  /*
   * Design 2026-10-05 §D2 (§5 D2pt-c): an answer that does not say whether Slack acted is its own code, never
   * retryable — before this release it was `TRANSIENT`, which a caller may retry, and a retry of a post that happened
   * is a second post. Its approval object says it is still being sent, and when it will read unknown.
   */
  for (const kind of ['post', 'reaction'] as const) {
    const harness = await newHarness();
    await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
    const fake = slack();
    fake.script[kind === 'post' ? 'chat.postMessage' : 'reactions.add'] = { ok: false, error: 'internal_error' };
    const { call, close } = await connect(harness, fake.read);
    try {
      let tool: Failure;
      let terminal: Awaited<ReturnType<typeof cli>>;
      if (kind === 'post') {
        const { draftId, approvalId } = await prepared(call);
        tool = failure(await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' }));
        const again = await prepared(call);
        terminal = await cli(
          harness,
          [
            '--json',
            'post',
            'send',
            '--workspace',
            'acme',
            '--draft',
            again.draftId,
            '--approval',
            again.approvalId,
            '--expect-channel',
            'C1',
          ],
          { read: fake.read },
        );
      } else {
        tool = failure(await call('slack_react', REACTION));
        terminal = await cli(
          harness,
          ['--json', 'react', '--workspace', 'acme', '--channel', 'C1', '--ts', '1.1', '--emoji', 'tada'],
          { read: fake.read },
        );
      }
      const error = terminal.json<Envelope<never>>().error;
      for (const [surface, said] of [
        ['mcp', tool],
        ['cli', error],
      ] as const) {
        const what = `${kind} over ${surface}`;
        assert.equal(said?.code, 'SEND_OUTCOME_UNKNOWN', what);
        assert.match(said?.message ?? '', /is not known: /, what);
        const approval = said?.details?.approval as { state: string; claimable: boolean; unknownAt?: string };
        assert.equal(approval?.state, 'sending', what);
        assert.equal(approval?.claimable, false, what);
        assert.ok(approval?.unknownAt, `${what}: no unknownAt`);
      }
      assert.equal(terminal.code, EXIT_CODES.APPROVAL, terminal.stdout);
      assert.equal(EXIT_CODES.APPROVAL, 10);
    } finally {
      await close();
    }
  }
});

test('a post Slack accepted without a ts says "sent; the provider returned no id" from both surfaces, and gives no ts', async () => {
  // §5 D8o-f: never a ts made up, never `used`; the approval stays sending.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  fake.script['chat.postMessage'] = { ok: true };
  const { call, close } = await connect(harness, fake.read);
  try {
    const { draftId, approvalId } = await prepared(call);
    const posted = await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' });
    assert.notEqual(posted.isError, true, JSON.stringify(posted.structuredContent));
    const { approval, ...result } = posted.structuredContent as { approval: { state: string } };
    assert.deepEqual(result, { approvalId, channel: 'C1', note: 'sent; the provider returned no id' });
    assert.equal(approval.state, 'sending');

    const viaJson = await prepared(call);
    const send = ['post', 'send', '--workspace', 'acme', '--draft', viaJson.draftId, '--approval', viaJson.approvalId];
    const json = await cli(harness, ['--json', ...send, '--expect-channel', 'C1'], { read: fake.read });
    assert.equal(json.code, EXIT_CODES.OK, json.stdout + json.stderr);
    const data = json.json<Envelope<Record<string, unknown>>>().data ?? {};
    assert.equal(data.note, 'sent; the provider returned no id');
    assert.equal('ts' in data, false, 'a ts was reported that Slack never gave');

    const viaTerminal = await prepared(call);
    const human = await cli(
      harness,
      [
        'post',
        'send',
        '--workspace',
        'acme',
        '--draft',
        viaTerminal.draftId,
        '--approval',
        viaTerminal.approvalId,
        '--expect-channel',
        'C1',
      ],
      { read: fake.read },
    );
    assert.equal(human.code, EXIT_CODES.OK, human.stdout + human.stderr);
    assert.equal(human.stdout, 'Posted to C1. Sent; the provider returned no id.\n');
    for (const id of [approvalId, viaJson.approvalId, viaTerminal.approvalId]) {
      assert.equal(asV2(await harness.core.approvals.get(id))?.state, 'sending', 'never used without an id');
    }
  } finally {
    await close();
  }
});

// ── Where a post goes ──────────────────────────────────────────────────────────────────────────────────────────

/** The refusal of a user id as a post's destination, and the step it offers: the DM's own id, and where to find it. */
function refusedAsUserId(error: { code?: string; message?: string; hint?: string | null } | undefined, id: string) {
  assert.equal(error?.code, 'USAGE', JSON.stringify(error));
  assert.match(error?.message ?? '', new RegExp(`^"${id}" is a user id: a post goes to a conversation id`));
  assert.match(error?.hint ?? '', /use the DM’s id \(D…\)/);
  // Slack's own channel list, located: never a bare `agent-slack` (CUE-403).
  assert.match(error?.hint ?? '', / channels --workspace acme` and slack_channels list/);
  assertNoBareCommand(error?.hint ?? '');
  assert.match(error?.hint ?? '', /slack_channels/);
}

test('a user id is refused as where a post goes: on draft create, draft update and prepare, from both surfaces', async () => {
  /*
   * Issue #43. A post goes to a conversation, and a person is not one: a direct message has an id of its own, `D…`,
   * which the channel list gives. Refused before anything is written and before Slack is asked anything — whatever
   * Slack would make of a user id there, it is not the conversation the preview could show. Mentions are another field,
   * and take user ids as they always did.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const written = await cli(
      harness,
      ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', 'hi', '--mention', 'U024BE7LH'],
      { read: fake.read },
    );
    assert.equal(written.code, EXIT_CODES.OK, written.stdout + written.stderr);
    const draft = written.json<Envelope<{ draftId: string; revision: string }>>().data;
    const draftId = draft?.draftId ?? '';

    for (const id of ['U024BE7LH', 'W012A3CDE']) {
      const created = await cli(
        harness,
        ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', id, '--text', 'hi'],
        { read: fake.read },
      );
      assert.equal(created.code, EXIT_CODES.USAGE, created.stdout);
      refusedAsUserId(created.json<Envelope<never>>().error, id);
      refusedAsUserId(failure(await call('slack_draft_create', { workspace: 'acme', channel: id, text: 'hi' })), id);

      const updated = await cli(
        harness,
        ['--json', 'draft', 'update', draftId, '--workspace', 'acme', '--channel', id],
        { read: fake.read },
      );
      assert.equal(updated.code, EXIT_CODES.USAGE, updated.stdout);
      refusedAsUserId(updated.json<Envelope<never>>().error, id);
      refusedAsUserId(failure(await call('slack_draft_update', { workspace: 'acme', draftId, channel: id })), id);

      refusedAsUserId(failure(await call('slack_post_prepare', { workspace: 'acme', channel: id, text: 'hi' })), id);
    }

    const store = openDraftStore(harness.core.paths.stateDir, () => new Date(), slackHandoffs(harness.core.paths));
    const kept = await store.list();
    assert.deepEqual(
      kept.map((one) => [one.draftId, one.revision, one.payload.channel]),
      [[draftId, draft?.revision, 'C1']],
      'a refused create or update wrote something',
    );
    assert.equal(fake.count('conversations.info'), 0, 'Slack was asked about a post that was refused');
  } finally {
    await close();
  }
});

test('a channel, a private channel and a DM are all somewhere a post can go', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.read);
  try {
    for (const id of ['C024BE7LR', 'G024BE7LR', 'D024BE7LR']) {
      fake.script['conversations.info'] = {
        ok: true,
        channel: id.startsWith('D')
          ? { id, is_im: true, user: 'U024BE7LH' }
          : { id, name: 'eng', num_members: 4, is_member: true },
      };
      const created = await call('slack_draft_create', { workspace: 'acme', channel: 'C1', text: 'hi' });
      assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
      const { draftId } = created.structuredContent as { draftId: string };
      const moved = await call('slack_draft_update', { workspace: 'acme', draftId, channel: id });
      assert.notEqual(moved.isError, true, JSON.stringify(moved.structuredContent));
      const prepared = await call('slack_post_prepare', { workspace: 'acme', channel: id, text: 'hi' });
      assert.notEqual(prepared.isError, true, JSON.stringify(prepared.structuredContent));
    }
  } finally {
    await close();
  }
});

// ── Reactions ──────────────────────────────────────────────────────────────────────────────────────────────────

const REACTION = { workspace: 'acme', channel: 'C1', ts: '1.1', emoji: 'tada' };
const NO_REACTION_NOTE =
  'Slack says this account had no such reaction on the message, so there was nothing of yours to remove; reactions other people added are not affected.';

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

    const record = asV2(
      await harness.core.approvals.get((made.structuredContent as { approvalId: string }).approvalId),
    );
    assert.equal(record?.state, 'used', 'through a real approval, spent by the reaction it permitted');
  } finally {
    await close();
  }
});

test('no_reaction removal is success with the ownership note through CLI JSON and MCP', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  fake.script['reactions.remove'] = { ok: false, error: 'no_reaction' };

  const terminal = await cli(
    harness,
    ['--json', 'react', '--workspace', 'acme', '--channel', 'C1', '--ts', '1.1', '--emoji', 'tada', '--remove'],
    { read: fake.read },
  );
  assert.equal(terminal.code, EXIT_CODES.OK, terminal.stdout + terminal.stderr);
  assert.equal(terminal.json<Envelope<{ note: string }>>().data?.note, NO_REACTION_NOTE);

  const { call, close } = await connect(harness, fake.read);
  try {
    const result = await call('slack_react', { ...REACTION, remove: true });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal((result.structuredContent as { note?: string }).note, NO_REACTION_NOTE);
    assert.equal(fake.count('reactions.remove'), 2);
  } finally {
    await close();
  }
});

test('no_reaction removal has one full stop in the CLI human result', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  fake.script['reactions.remove'] = { ok: false, error: 'no_reaction' };

  const terminal = await cli(
    harness,
    ['react', '--workspace', 'acme', '--channel', 'C1', '--ts', '1.1', '--emoji', 'tada', '--remove'],
    { read: fake.read },
  );
  assert.equal(terminal.code, EXIT_CODES.OK, terminal.stdout + terminal.stderr);
  assert.equal(terminal.stdout, `:tada: on 1.1. ${NO_REACTION_NOTE}\n`);
  assert.equal(fake.count('reactions.remove'), 1);
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
    // Waiting for the person: pending, and not claimable on a yes in the chat.
    const waiting = error.details?.approval as { state?: string; claimable?: boolean } | undefined;
    assert.equal(waiting?.state, 'pending');
    assert.equal(waiting?.claimable, false);
    assert.equal(error.details?.command, slackCommand(harness.core.paths, ['approve', approvalId], 'darwin'));
    assert.match(error.hint ?? '', /slack_react_send/, 'the tool that uses the approval once it is given');
    assert.doesNotMatch(error.hint ?? '', /--approval/, 'not a flag for a command the agent is not running');
    assert.equal(fake.count('reactions.add'), 0);

    // Tried again before the person has approved: still waiting, and on the same approval — not a new one nobody saw.
    const early = await call('slack_react_send', { ...REACTION, approvalId });
    assert.equal(failure(early).code, 'APPROVAL_PENDING');
    assert.equal(failure(early).details?.approvalId, approvalId);
    assert.equal((await harness.core.approvals.list()).length, 1, 'no second approval was made');
    assert.equal(asV2(await harness.core.approvals.get(approvalId))?.state, 'pending', 'and none was approved');

    await personApproves(harness, approvalId, fake.read);

    const made = await call('slack_react_send', { ...REACTION, approvalId });
    assert.notEqual(made.isError, true, JSON.stringify(made.structuredContent));
    const { approval, ...result } = made.structuredContent as { approval: { state: string } };
    assert.deepEqual(result, { approvalId });
    assert.equal(approval.state, 'used', 'where the approval stands (design 2026-10-05 §D8)');
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

test('a reaction held for a person is the same refusal from the react command and slack_react', async () => {
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
    assert.equal(
      error?.details?.command,
      slackCommand(harness.core.paths, ['approve', String(error?.details?.approvalId)], 'darwin'),
    );
    assert.deepEqual(Object.keys(error?.details ?? {}).sort(), Object.keys(tool.details ?? {}).sort());
    assert.match(error?.hint ?? '', /--approval/, 'the CLI names its own next step');
  } finally {
    await close();
  }
});
