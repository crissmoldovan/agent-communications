import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { openFlowStore } from '../src/auth/flow.ts';
import { run } from '../src/cli/program.ts';
import { payloadOf } from '../src/compose/blocks.ts';
import { openDraftStore } from '../src/compose/drafts.ts';
import { SlackContext } from '../src/context.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { checkedWait } from '../src/operations/signin.ts';
import { type Harness, newHarness, TEST_CLIENT_ID } from './support/harness.ts';
import { LISTENER_COMMAND, stopListeners } from './support/listener.ts';

/**
 * The command and the tool that the capability table pairs, given the same input, give the same answer.
 *
 * Each test here began as a finding of the parity review of 2026-09-25: a tool that could not do what its command did
 * (prepare a draft already written, finish a sign-in from a pasted address), a tool that read the configuration its
 * own way (the mode tools), a word refused by the SDK rather than by the operation, a pinned server that could void
 * another workspace's approval, and a `--broadcast` that composed a mention the preview counted as nobody. Every one
 * is fixed by both surfaces running one operation, so each test drives both and compares them.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
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
  error?: Failure;
}

/** Slack as a script of replies by method; never the real one. */
function scripted(script: Record<string, unknown> = {}): FakeFetch {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    return new Response(JSON.stringify(script[method] ?? { ok: false, error: 'unknown_method' }));
  };
}

const ROOM = { ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } };
const slack = () => scripted({ 'conversations.info': ROOM });

async function connect(harness: Harness, options: { workspace?: string; fetch?: FakeFetch } = {}) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    listenerCommand: LISTENER_COMMAND,
    fetch: options.fetch ?? slack(),
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

function ok<T>(result: ToolResult): T {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent as T;
}

/** A refusal made by this code — with a code — and not the SDK's "Input validation error", which has none. */
function failed(result: ToolResult): Failure {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  const error = (result.structuredContent as { error?: Failure } | undefined)?.error;
  assert.ok(error, `refused without a code: ${JSON.stringify(result.content)}`);
  return error;
}

/** The CLI as an agent runs it: `--json`, no terminal. */
async function cli(harness: Harness, argv: string[], read: FakeFetch = slack()) {
  let stdout = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const code = await run(['--json', ...argv], {
    core: harness.core,
    env: { ...harness.env, CLAUDECODE: '1' },
    exchange: (params) => harness.exchange(params),
    streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
    openBrowser: () => undefined,
    listenerCommand: LISTENER_COMMAND,
    read,
  });
  return { code, envelope: JSON.parse(stdout) as Envelope<unknown> };
}

/** The CLI as a person runs it: what it prints for a person to read. */
async function printed(harness: Harness, argv: string[], read: FakeFetch = slack()): Promise<string> {
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
    listenerCommand: LISTENER_COMMAND,
    read,
  });
  assert.equal(code, 0, stdout);
  return stdout;
}

async function cliData<T>(harness: Harness, argv: string[], read?: FakeFetch): Promise<T> {
  const { code, envelope } = await cli(harness, argv, read);
  assert.equal(code, 0, JSON.stringify(envelope));
  return envelope.data as T;
}

async function cliError(harness: Harness, argv: string[], read?: FakeFetch): Promise<Failure> {
  const { code, envelope } = await cli(harness, argv, read);
  assert.notEqual(code, 0, JSON.stringify(envelope));
  return envelope.error as Failure;
}

/** A port nothing is listening on right now — on `localhost`, the host the listener binds. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((settle) => server.listen(0, 'localhost', () => settle()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((settle) => server.close(() => settle()));
  return port;
}

let strays: number[] = [];
afterEach(async () => {
  const started = strays;
  strays = [];
  await stopListeners(started);
});

async function track(harness: Harness, flowId: string): Promise<void> {
  const flow = await openFlowStore(harness.core.paths.stateDir, () => new Date()).peek(flowId);
  if (flow?.listenerPid) strays.push(flow.listenerPid);
}

const draftsOf = async (harness: Harness) => openDraftStore(harness.core.paths.stateDir, () => new Date()).list();

// ── Preparing a draft already written (P1-4) ─────────────────────────────────────────────────────────────────────

interface Prepared {
  approvalId: string;
  draftId: string;
  preview: { context: Record<string, unknown> } & Record<string, unknown>;
  expect: unknown;
  policy: string;
  requiredPolicy: string;
  riskFlags: string[];
}

/** A prepared post with the one thing that differs between two preparations of it taken out: its own approval. */
function withoutApproval(prepared: Prepared) {
  const { approvalId: _id, ...context } = prepared.preview.context;
  return {
    draftId: prepared.draftId,
    preview: { ...prepared.preview, context },
    expect: prepared.expect,
    policy: prepared.policy,
    requiredPolicy: prepared.requiredPolicy,
    riskFlags: prepared.riskFlags,
  };
}

test('slack_post_prepare prepares a draft written at the terminal, with the preview `post prepare` gives it', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const { call, close } = await connect(harness);
  try {
    const written = await cliData<{ draftId: string }>(harness, [
      'draft',
      'create',
      '--workspace',
      'acme',
      '--channel',
      'C1',
      '--text',
      'the café plan & the rest',
      '--mention',
      'U024BE7LH',
      '--broadcast',
      'here',
    ]);

    const fromCli = await cliData<Prepared>(harness, [
      'post',
      'prepare',
      '--workspace',
      'acme',
      '--draft',
      written.draftId,
    ]);
    const fromTool = ok<Prepared>(await call('slack_post_prepare', { workspace: 'acme', draftId: written.draftId }));

    assert.equal(fromTool.draftId, written.draftId, 'the draft it was given, not a new one');
    assert.deepEqual(withoutApproval(fromTool), withoutApproval(fromCli));
    assert.notEqual(fromTool.approvalId, fromCli.approvalId, 'each preparation is its own approval');
    assert.equal(fromTool.requiredPolicy, 'confirm', 'an @here needs a person at a terminal, from either surface');
    assert.equal((await draftsOf(harness)).length, 1, 'preparing it wrote no second draft');
  } finally {
    await close();
  }
});

test('slack_post_prepare takes a draft or a message — not both, not neither — and not another workspace’s draft', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002' });
  const { call, close } = await connect(harness);
  try {
    const theirs = await cliData<{ draftId: string }>(harness, [
      'draft',
      'create',
      '--workspace',
      'zeta',
      '--channel',
      'C1',
      '--text',
      'theirs',
    ]);

    const both = failed(
      await call('slack_post_prepare', { workspace: 'acme', draftId: theirs.draftId, channel: 'C1', text: 'hi' }),
    );
    assert.equal(both.code, 'USAGE');
    assert.match(both.message, /not both/);

    const neither = failed(await call('slack_post_prepare', { workspace: 'acme', channel: 'C1' }));
    assert.equal(neither.code, 'USAGE');
    assert.match(neither.message, /nothing to prepare/);

    // Another workspace's draft is absent, from the tool exactly as from the command.
    const fromCli = await cliError(harness, ['post', 'prepare', '--workspace', 'acme', '--draft', theirs.draftId]);
    const fromTool = failed(await call('slack_post_prepare', { workspace: 'acme', draftId: theirs.draftId }));
    assert.deepEqual([fromTool.code, fromTool.message], [fromCli.code, fromCli.message]);
    assert.equal(fromTool.code, 'NOT_FOUND');

    assert.equal((await draftsOf(harness)).length, 1, 'no refusal wrote a draft');
    assert.deepEqual(await harness.core.approvals.list(), [], 'or prepared an approval');
  } finally {
    await close();
  }
});

// ── Finishing a sign-in from a pasted address, and how long it waits (P1-5, P2-11) ─────────────────────────────

/** The address Slack sends the browser back to once the person approved, as it would sit in the address bar. */
function landedAt(authUrl: string, override: { state?: string } = {}): string {
  const url = new URL(authUrl);
  const back = new URL(url.searchParams.get('redirect_uri') as string);
  back.searchParams.set('code', 'fake-authorisation-code');
  back.searchParams.set('state', override.state ?? (url.searchParams.get('state') as string));
  return back.href;
}

test('slack_workspace_finish finishes from a pasted address, as `--finish --url` does, and refuses another sign-in’s', async () => {
  const harness = await newHarness();
  const { call, close } = await connect(harness);
  try {
    const started = ok<{ result: { flowId: string; authUrl: string } }>(
      await call('slack_workspace_add', { workspace: 'acme', clientId: TEST_CLIENT_ID, port: await freePort() }),
    ).result;
    await track(harness, started.flowId);

    const wrong = failed(
      await call('slack_workspace_finish', { flowId: started.flowId, url: landedAt(started.authUrl, { state: 'x' }) }),
    );
    assert.equal(wrong.code, 'USAGE');
    assert.match(wrong.message, /a different sign-in/);
    assert.equal(harness.calls.length, 0, 'nothing was exchanged for it');

    // The browser was on another machine: the person pastes where it landed, and nothing waits on a redirect.
    const view = ok<{ alias: string; mode: string }>(
      await call('slack_workspace_finish', { flowId: started.flowId, url: landedAt(started.authUrl) }),
    );
    assert.deepEqual([view.alias, view.mode], ['acme', 'read']);
    assert.equal(harness.calls[0]?.params.code, 'fake-authorisation-code');
    assert.ok(harness.calls[0]?.params.code_verifier, 'the verifier this machine kept, which the pasted code needs');
    assert.equal((await harness.core.config.load()).accounts.acme?.mode, 'read');
  } finally {
    await close();
  }
});

test('the wait is checked by the operation: the same refusal, with a code, and the tool says what it can hold', async () => {
  // The rule itself, for both surfaces.
  assert.equal(checkedWait(undefined, 'mcp'), 60);
  assert.equal(checkedWait('0', 'cli'), 0);
  assert.equal(checkedWait(600, 'cli'), 600);
  assert.equal(checkedWait(120, 'mcp'), 120);
  for (const [raw, surface] of [
    [121, 'mcp'],
    [601, 'cli'],
    [-1, 'mcp'],
    ['soon', 'cli'],
    [Number.POSITIVE_INFINITY, 'mcp'],
  ] as const) {
    assert.throws(() => checkedWait(raw, surface), { code: 'USAGE' }, `${String(raw)} at ${surface}`);
  }

  const harness = await newHarness();
  const { client, call, close } = await connect(harness);
  try {
    const started = ok<{ result: { flowId: string } }>(
      await call('slack_workspace_add', { workspace: 'acme', clientId: TEST_CLIENT_ID, port: await freePort() }),
    ).result;
    await track(harness, started.flowId);

    // Past what a call can hold: refused by the operation, with a code and the reason, not by the SDK.
    const tooLong = failed(await call('slack_workspace_finish', { flowId: started.flowId, waitSeconds: 600 }));
    assert.equal(tooLong.code, 'USAGE');
    assert.match(tooLong.message, /"600" is not a wait/);
    assert.match(tooLong.hint ?? '', /0 to 120/);
    assert.match(tooLong.hint ?? '', /slack_workspace_finish again/);

    const atTerminal = await cliError(harness, ['workspace', 'add', '--finish', started.flowId, '--wait', '601']);
    assert.deepEqual([atTerminal.code, atTerminal.message], ['USAGE', '"601" is not a wait']);

    // `0` looks once. Still waiting, the tool is told to call itself again — not to find a shell.
    const pending = failed(await call('slack_workspace_finish', { flowId: started.flowId, waitSeconds: 0 }));
    assert.equal(pending.code, 'APPROVAL_PENDING');
    assert.match(pending.hint ?? '', new RegExp(`slack_workspace_finish\` with flowId ${started.flowId}`));
    assert.doesNotMatch(pending.hint ?? '', /agent-slack/);

    const pendingAtTerminal = await cliError(harness, ['workspace', 'add', '--finish', started.flowId, '--wait', '0']);
    assert.equal(pendingAtTerminal.code, 'APPROVAL_PENDING');
    assert.match(pendingAtTerminal.hint ?? '', new RegExp(`agent-slack workspace add --finish ${started.flowId}`));

    // The schema a client reads still states the bounds.
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'slack_workspace_finish');
    assert.ok(tool);
    const fields = tool.inputSchema.properties as Record<string, { minimum?: number; maximum?: number }>;
    assert.deepEqual([fields.waitSeconds?.minimum, fields.waitSeconds?.maximum], [0, 120]);
    assert.ok(fields.url, 'and takes the pasted address');
  } finally {
    await close();
  }
});

test('a sign-in for another workspace is refused in the words of the surface that asked', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: await freePort() });
  const { call, close } = await connect(harness);
  try {
    const renewal = ok<{ result: { flowId: string } }>(
      await call('slack_workspace_reauth', { workspace: 'acme' }),
    ).result;
    await track(harness, renewal.flowId);

    const fromTool = failed(
      await call('slack_workspace_finish', { workspace: 'zeta', flowId: renewal.flowId, waitSeconds: 0 }),
    );
    assert.equal(fromTool.code, 'USAGE');
    assert.match(fromTool.message, /is for "acme", not "zeta"/);
    assert.match(fromTool.hint ?? '', /slack_workspace_finish/);
    assert.doesNotMatch(fromTool.hint ?? '', /agent-slack/);

    const fromCli = await cliError(harness, ['workspace', 'reauth', 'zeta', '--finish', renewal.flowId, '--wait', '0']);
    assert.equal(fromCli.message, fromTool.message, 'the same refusal');
    assert.match(fromCli.hint ?? '', new RegExp(`agent-slack workspace reauth acme --finish ${renewal.flowId}`));

    // And a renewal still waiting names the workspace at the terminal, which `reauth` cannot run without.
    const pending = await cliError(harness, ['workspace', 'reauth', 'acme', '--finish', renewal.flowId, '--wait', '0']);
    assert.equal(pending.code, 'APPROVAL_PENDING');
    assert.match(pending.hint ?? '', new RegExp(`agent-slack workspace reauth acme --finish ${renewal.flowId}`));
  } finally {
    await close();
  }
});

// ── Mentions: only the ones the preview can count (P2-7) ─────────────────────────────────────────────────────────

test('a broadcast outside here, channel and everyone is refused by the command, the tool and the operation', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const { call, close } = await connect(harness);
  try {
    const atTerminal = await cliError(harness, [
      'draft',
      'create',
      '--workspace',
      'acme',
      '--channel',
      'C1',
      '--text',
      'hi',
      '--broadcast',
      'subteam^S0123',
    ]);
    assert.equal(atTerminal.code, 'USAGE');

    const fromTool = failed(
      await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'hi', broadcast: 'subteam^S0123' }),
    );
    assert.equal(fromTool.code, 'USAGE');
    assert.equal(fromTool.message, '"subteam^S0123" is not a broadcast');

    // Whatever a caller's own parser lets through, the operation refuses it: no surface can write that mention.
    const context = new SlackContext({ core: harness.core, env: harness.env });
    await assert.rejects(
      createDraft(context, 'acme', { channel: 'C1', text: 'hi', broadcast: 'subteam^S0123' }),
      (error: { code?: string; message?: string }) =>
        error.code === 'USAGE' && error.message === '"subteam^S0123" is not a broadcast',
    );
    assert.deepEqual(await draftsOf(harness), [], 'nothing was written');
  } finally {
    await close();
  }
});

test('a mention id that is not a user id is refused the same way on both surfaces, before anything is written', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const { call, close } = await connect(harness);
  try {
    const smuggled = 'U1> <!subteam^S0123';
    const fromTool = failed(
      await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: 'hi', mentionUsers: [smuggled] }),
    );
    const fromCli = await cliError(harness, [
      'draft',
      'create',
      '--workspace',
      'acme',
      '--channel',
      'C1',
      '--text',
      'hi',
      '--mention',
      smuggled,
    ]);
    assert.deepEqual([fromTool.code, fromTool.message], [fromCli.code, fromCli.message]);
    assert.equal(fromTool.code, 'USAGE');
    assert.match(fromTool.message, /is not a Slack user id/);
    assert.deepEqual(await draftsOf(harness), []);
  } finally {
    await close();
  }
});

test('mentions typed into the text are shown as typed, and notify nobody — in Slack as in the preview', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const { call, close } = await connect(harness);
  try {
    const typed = '<!here> <!channel> <!everyone> <!subteam^S0123> <@U024BE7LH> <!group>';
    const prepared = ok<{
      draftId: string;
      requiredPolicy: string;
      preview: { body: string; notifies: { here: boolean; channel: boolean; users: string[]; estimated: number } };
    }>(await call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: typed }));

    // What goes to Slack carries no span at all: escaped, so Slack shows these characters and notifies nobody.
    const { draft } = ok<{ draft: { payload: { text: string } } }>(
      await call('slack_draft_get', { workspace: 'acme', draftId: prepared.draftId }),
    );
    assert.doesNotMatch(draft.payload.text, /<[!@]/);
    assert.match(draft.payload.text, /&lt;!here&gt;/);

    // And the preview agrees with Slack: the characters as typed, nobody interrupted, a yes in the chat is enough.
    assert.equal(prepared.preview.body, typed);
    assert.deepEqual(prepared.preview.notifies, { here: false, channel: false, users: [], estimated: 0 });
    assert.equal(prepared.requiredPolicy, 'chat');
  } finally {
    await close();
  }
});

test('a mention the preview cannot count — a user group, an unknown special — needs a person at a terminal', async () => {
  /*
   * The gate's own backstop, for a draft the composer did not write: its file edited, or written by an older version.
   * It used to count such a mention as nobody, and let the post go on a yes in the chat.
   */
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const store = openDraftStore(harness.core.paths.stateDir, () => new Date());
  const { call, close } = await connect(harness);
  try {
    for (const [mention, shown] of [
      ['<!subteam^S0123>', '@S0123 (a user group)'],
      ['<!group>', '@group (a special mention)'],
    ] as const) {
      const text = `${mention} standup moved`;
      const written = await store.create(
        account.id,
        {
          text,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
          channel: 'C1',
          unfurl_links: false,
          unfurl_media: false,
        },
        'standup moved',
      );
      const prepared = ok<{
        requiredPolicy: string;
        riskFlags: string[];
        preview: { notifies: { users: string[]; estimated: number; unknown?: string } };
      }>(await call('slack_post_prepare', { workspace: 'acme', draftId: written.draftId }));
      assert.equal(prepared.requiredPolicy, 'confirm', mention);
      assert.deepEqual(prepared.preview.notifies.users, [shown], mention);
      assert.match(prepared.preview.notifies.unknown ?? '', /nothing here can count/, mention);
      assert.ok(prepared.riskFlags.includes('reach-unknown'), mention);

      const fromCli = await cliData<{ requiredPolicy: string }>(harness, [
        'post',
        'prepare',
        '--workspace',
        'acme',
        '--draft',
        written.draftId,
      ]);
      assert.equal(fromCli.requiredPolicy, 'confirm', `${mention} at the terminal too`);
    }
  } finally {
    await close();
  }
});

// ── The mode tools, as `workspace mode` (P2-5) ───────────────────────────────────────────────────────────────────

test('the mode tools answer as `workspace mode` does: the same reading, the same port check, the same result', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'legacy', mode: 'send', redirectPort: 50123 });
  // A record written before `mode` existed says `send` only in its `tier`.
  await harness.core.config.update((config) => {
    const { mode: _mode, ...rest } = config.accounts.legacy as NonNullable<(typeof config.accounts)['legacy']>;
    return { ...config, accounts: { ...config.accounts, legacy: rest } };
  });
  await harness.addWorkspace({ alias: 'loud', mode: 'send', redirectPort: 50124, workspaceId: 'T0002' });
  await harness.addWorkspace({ alias: 'noport', mode: 'send', workspaceId: 'T0003' });
  await harness.addWorkspace({ alias: 'quiet', redirectPort: 50125, workspaceId: 'T0004' });
  const { call, close } = await connect(harness);
  try {
    const same = async (argv: string[], tool: string, args: Record<string, unknown>) => {
      const fromCli = await cli(harness, argv);
      const fromTool = await call(tool, args);
      if (fromCli.code === 0) {
        assert.deepEqual(ok(fromTool), fromCli.envelope.data, `${argv.join(' ')} / ${tool}`);
      } else {
        const refused = failed(fromTool);
        assert.deepEqual(
          [refused.code, refused.message],
          [fromCli.envelope.error?.code, fromCli.envelope.error?.message],
          `${argv.join(' ')} / ${tool}`,
        );
      }
      return fromTool;
    };

    // Asking a `send` workspace for the steps to post: it can already, whichever field says so.
    const legacy = ok<{ mode: string; canActOutward: boolean }>(
      await same(['workspace', 'mode', 'legacy', 'send'], 'slack_mode_request_send', { workspace: 'legacy' }),
    );
    assert.deepEqual([legacy.mode, legacy.canActOutward], ['send', true]);
    await same(['workspace', 'mode', 'legacy'], 'slack_mode', { workspace: 'legacy' });

    // Asking a `read` workspace: the app step, the manifest and the link — the command's result, whole.
    await same(['workspace', 'mode', 'quiet', 'send'], 'slack_mode_request_send', { workspace: 'quiet' });
    await same(['workspace', 'mode', 'quiet', '--port', '50999'], 'slack_mode', { workspace: 'quiet', port: 50999 });

    // The way back: the steps for a `send` workspace, the report for one that is `read` already.
    const steps = ok<{ changed: boolean; steps: string[] }>(
      await same(['workspace', 'mode', 'loud', 'read'], 'slack_mode_narrow', { workspace: 'loud' }),
    );
    assert.equal(steps.changed, false);
    const already = ok<{ mode: string; toRead: string[] }>(
      await same(['workspace', 'mode', 'quiet', 'read'], 'slack_mode_narrow', { workspace: 'quiet' }),
    );
    assert.deepEqual([already.mode, already.toRead], ['read', []], 'no steps to remove an app it never widened');

    // A port that is not one, or none at all: refused, never written into the steps.
    await same(['workspace', 'mode', 'loud', 'read', '--port', '70000'], 'slack_mode_narrow', {
      workspace: 'loud',
      port: 70000,
    });
    await same(['workspace', 'mode', 'noport', 'read'], 'slack_mode_narrow', { workspace: 'noport' });
    await same(['workspace', 'mode', 'quiet', '--port', '70000'], 'slack_mode', { workspace: 'quiet', port: 70000 });

    assert.deepEqual(await harness.core.approvals.list(), [], 'none of them asked anybody anything');
  } finally {
    await close();
  }
});

// ── Words that are not one: refused by the operation, with a code (P2-6) ─────────────────────────────────────────

test('a word that is not one is refused with USAGE by the operation, and the schema still lists the words', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 50123 });
  const { client, call, close } = await connect(harness);
  try {
    const pairs: [string[], string, Record<string, unknown>][] = [
      [
        ['workspace', 'policy', 'acme', '--send', 'loud'],
        'slack_workspace_policy',
        { workspace: 'acme', sendPolicy: 'loud' },
      ],
      [
        ['workspace', 'policy', 'acme', '--change', 'loud'],
        'slack_workspace_policy',
        { workspace: 'acme', changePolicy: 'loud' },
      ],
      [['workspace', 'mode', 'acme', 'banana'], 'slack_mode_set', { workspace: 'acme', mode: 'banana' }],
    ];
    for (const [argv, tool, args] of pairs) {
      const fromCli = await cliError(harness, argv);
      const fromTool = failed(await call(tool, args));
      assert.deepEqual([fromTool.code, fromTool.message], [fromCli.code, fromCli.message], argv.join(' '));
      assert.equal(fromTool.code, 'USAGE');
    }

    // The command's `--mode` has choices, which refuse first there, in Commander's words; the tools reach the
    // operation, which refuses in its own. The code is the same either way.
    for (const [argv, tool, args] of [
      [
        ['workspace', 'add', 'zeta', '--client-id', TEST_CLIENT_ID, '--port', '50999', '--mode', 'loud'],
        'slack_workspace_add',
        { workspace: 'zeta', clientId: TEST_CLIENT_ID, port: 50999, mode: 'loud' },
      ],
      [
        ['workspace', 'reauth', 'acme', '--mode', 'loud'],
        'slack_workspace_reauth',
        { workspace: 'acme', mode: 'loud' },
      ],
      [['manifest', '--port', '50999', '--mode', 'loud'], 'slack_manifest', { port: 50999, mode: 'loud' }],
    ] as [string[], string, Record<string, unknown>][]) {
      assert.equal((await cliError(harness, argv)).code, 'USAGE', argv.join(' '));
      const fromTool = failed(await call(tool, args));
      assert.deepEqual([fromTool.code, fromTool.message], ['USAGE', '"loud" is not a mode'], tool);
    }
    assert.deepEqual(await harness.core.approvals.list(), [], 'nothing was prepared for a word that is not one');
    assert.deepEqual(await openFlowStore(harness.core.paths.stateDir, () => new Date()).pending(), []);

    // What a client and a model read is unchanged: each field still lists exactly its words.
    const tools = (await client.listTools()).tools;
    const enumOf = (tool: string, field: string) => {
      const found = tools.find((entry) => entry.name === tool);
      assert.ok(found, tool);
      return (found.inputSchema.properties as Record<string, { enum?: string[] }>)[field]?.enum;
    };
    assert.deepEqual(enumOf('slack_workspace_policy', 'sendPolicy'), ['chat', 'confirm', 'never']);
    assert.deepEqual(enumOf('slack_workspace_policy', 'changePolicy'), ['chat', 'confirm']);
    for (const tool of ['slack_mode_set', 'slack_workspace_add', 'slack_workspace_reauth', 'slack_manifest']) {
      assert.deepEqual(enumOf(tool, 'mode'), ['read', 'send'], tool);
    }
    assert.deepEqual(enumOf('slack_post_prepare', 'broadcast'), ['here', 'channel', 'everyone']);
  } finally {
    await close();
  }
});

// ── A pinned server and another workspace's approvals (P2-8) ─────────────────────────────────────────────────────

test('a pinned server refuses another workspace’s approval before touching it, for every tool that takes one', async () => {
  const harness = await newHarness();
  // acme can only read and may not post: each tool below would have a change or a post of its own to claim.
  await harness.addWorkspace({ alias: 'acme', sendPolicy: 'never', redirectPort: await freePort() });
  await harness.addWorkspace({ alias: 'zeta', mode: 'send', sendPolicy: 'confirm', workspaceId: 'T0002' });
  const unpinned = await connect(harness);
  const pinned = await connect(harness, { workspace: 'acme' });
  const state = async (approvalId: string) => (await harness.core.approvals.get(approvalId))?.state;
  try {
    // zeta's person is asked to loosen zeta's policy; the approval waits for their yes.
    const zetaChange = ok<{ approvalId: string }>(
      await unpinned.call('slack_workspace_policy', { workspace: 'zeta', sendPolicy: 'chat' }),
    ).approvalId;

    // Changes to acme, on a server pinned to it, each handed zeta's approval. Claimed, it would be voided on the
    // digest mismatch — so it is refused before it is claimed.
    for (const [tool, args] of [
      ['slack_workspace_policy', { sendPolicy: 'chat', approvalId: zetaChange }],
      ['slack_workspace_reauth', { mode: 'send', approvalId: zetaChange }],
      ['slack_mode_set', { mode: 'send', appUpdated: true, approvalId: zetaChange }],
    ] as [string, Record<string, unknown>][]) {
      const refused = failed(await pinned.call(tool, args));
      assert.equal(refused.code, 'NOT_FOUND', tool);
      assert.equal(refused.message, `no approval "${zetaChange}" for the "acme" workspace`, tool);
      assert.equal(refused.hint, 'This server only serves "acme".', tool);
      assert.equal(await state(zetaChange), 'pending', `${tool} left it alone`);
    }

    // zeta's approval is still zeta's to use, and acme was never touched.
    const applied = ok<{ applied: boolean }>(
      await unpinned.call('slack_workspace_policy', { workspace: 'zeta', sendPolicy: 'chat', approvalId: zetaChange }),
    );
    assert.equal(applied.applied, true);
    const acme = (await harness.core.config.load()).accounts.acme;
    assert.deepEqual([acme?.sendPolicy, acme?.mode], ['never', 'read']);

    // A post's approval, the same way: refused by the tools that claim posts and reactions, and left standing.
    const zetaPost = ok<{ approvalId: string }>(
      await unpinned.call('slack_post_prepare', { workspace: 'zeta', channel: 'C1', text: 'theirs' }),
    ).approvalId;
    const ours = await cliData<{ draftId: string }>(harness, [
      'draft',
      'create',
      '--workspace',
      'acme',
      '--channel',
      'C1',
      '--text',
      'ours',
    ]);
    for (const [tool, args] of [
      ['slack_post_send', { draftId: ours.draftId, approvalId: zetaPost, expectChannel: 'C1' }],
      ['slack_react_send', { channel: 'C1', ts: '1700000000.000100', emoji: 'eyes', approvalId: zetaPost }],
    ] as [string, Record<string, unknown>][]) {
      const refused = failed(await pinned.call(tool, args));
      assert.equal(refused.code, 'NOT_FOUND', tool);
      assert.equal(await state(zetaPost), 'pending', `${tool} left it alone`);
    }

    // Its own approvals it still claims: nothing here narrows what a pinned server may do with its own workspace.
    const own = ok<{ approvalId: string }>(await pinned.call('slack_workspace_policy', { sendPolicy: 'confirm' }));
    const claimed = ok<{ applied: boolean }>(
      await pinned.call('slack_workspace_policy', { sendPolicy: 'confirm', approvalId: own.approvalId }),
    );
    assert.equal(claimed.applied, true);
  } finally {
    await Promise.all([unpinned.close(), pinned.close()]);
  }
});

// ── A number out of range is refused, never clamped ─────────────────────────────────────────────────────────────

test('search and files refuse a limit above the page they read, by the command and the tool alike, rather than clamping it', async () => {
  /*
   * `searchMessages` and `listFiles` took `Math.min(limit, 100)` and `Math.min(limit, 200)`, so `search --limit 500`
   * and `slack_search {limit: 500}` searched 100 and said nothing — and the limit is also the page size, so the
   * `nextPage` that came back counted pages of 100 for a caller that had asked for 500. Gmail's tools refuse the same
   * input as USAGE (`gmail_search {limit: 500}`); these are checked by the operation now, before Slack is asked
   * anything, naming the number as the surface spells it and the range it takes.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const counts: Record<string, unknown>[] = [];
  const read: FakeFetch = async (_input, init) => {
    counts.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))));
    return new Response(
      JSON.stringify({ ok: true, messages: { matches: [], paging: { page: 1, pages: 1 } }, files: [], paging: {} }),
    );
  };
  const cases: Array<{
    argv: (value: string) => string[];
    flag: string;
    tool: string;
    args: Record<string, unknown>;
    arg: string;
    range: string;
    typed: string[];
    given: number[];
  }> = [
    {
      argv: (value) => ['search', 'standup', '--workspace', 'acme', `--limit=${value}`],
      flag: '--limit',
      tool: 'slack_search',
      args: { workspace: 'acme', query: 'standup' },
      arg: 'limit',
      range: 'from 1 to 100',
      typed: ['101', '500', '0', '1e2', 'abc'],
      given: [101, 500, 0, -1],
    },
    {
      argv: (value) => ['files', '--workspace', 'acme', `--limit=${value}`],
      flag: '--limit',
      tool: 'slack_files',
      args: { workspace: 'acme' },
      arg: 'limit',
      range: 'from 1 to 200',
      typed: ['201', '1000', '0', '2e2'],
      given: [201, 1000, 0],
    },
    {
      argv: (value) => ['search', 'standup', '--workspace', 'acme', `--page=${value}`],
      flag: '--page',
      tool: 'slack_search',
      args: { workspace: 'acme', query: 'standup' },
      arg: 'page',
      range: 'of 1 or more',
      typed: ['0', 'two'],
      given: [0, -2],
    },
    {
      argv: (value) => ['files', '--workspace', 'acme', `--page=${value}`],
      flag: '--page',
      tool: 'slack_files',
      args: { workspace: 'acme' },
      arg: 'page',
      range: 'of 1 or more',
      typed: ['0'],
      given: [0],
    },
  ];
  const { call, close } = await connect(harness, { fetch: read });
  try {
    for (const { argv, flag, tool, args, arg, range, typed, given } of cases) {
      for (const value of typed) {
        const label = argv(value).join(' ');
        const refused = await cliError(harness, argv(value), read);
        assert.equal(refused.code, 'USAGE', label);
        assert.equal(refused.message, `${flag} "${value}" is not a whole number ${range}`, label);
      }
      // The tool refuses what the command refuses, from the same check, naming the argument as a tool call spells it.
      for (const value of given) {
        const label = `${tool} ${arg}: ${value}`;
        const refused = failed(await call(tool, { ...args, [arg]: value }));
        assert.equal(refused.code, 'USAGE', label);
        assert.equal(refused.message, `${arg} "${value}" is not a whole number ${range}`, label);
      }
    }
    assert.deepEqual(counts, [], 'refused before Slack was asked anything');

    // The most each takes is sent as given, from either surface: a page of 100 matches, and one of 200 files.
    await cliData(harness, ['search', 'standup', '--workspace', 'acme', '--limit', '100'], read);
    ok(await call('slack_search', { workspace: 'acme', query: 'standup', limit: 100 }));
    await cliData(harness, ['files', '--workspace', 'acme', '--limit', '200', '--page', '3'], read);
    ok(await call('slack_files', { workspace: 'acme', limit: 200, page: 3 }));
    assert.deepEqual(
      counts.map(({ count, page }) => [count, page]),
      [
        ['100', '1'],
        ['100', '1'],
        ['200', '3'],
        ['200', '3'],
      ],
    );
  } finally {
    await close();
  }
});

// ── A draft is shown as what it would post ──────────────────────────────────────────────────────────────────────

/** What `draft show`, `draft list`, `slack_draft_get` and `slack_draft_list` give for one draft. */
interface ShownDraft {
  draftId: string;
  channel: string;
  threadTs?: string;
  text?: string;
  payload?: { text: string; blocks: unknown[] };
  source?: string;
  problem?: { code: string; reason: string; message: string; hint: string };
}

/** A draft file rewritten by hand, which anything with a shell can do. */
async function handEdit(harness: Harness, draftId: string, edit: (draft: Record<string, unknown>) => void) {
  const path = join(harness.core.paths.stateDir, 'slack', 'drafts', `${draftId}.json`);
  const draft = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  edit(draft);
  await writeFile(path, `${JSON.stringify(draft, null, 2)}\n`);
}

test('a draft is shown as what it would post, by `draft show` and `slack_draft_get` alike, not as the words its file keeps', async () => {
  /*
   * Both showed the draft's `source` — the words it was typed as, which nothing posts. A file edited so `source` said
   * one thing and the payload another was shown as the one, and prepared, approved and posted as the other: the gate
   * previews from the payload, so the post was safe, but `draft show` and `slack_draft_get` misreported it. They show
   * the payload the gate would send now, decoded as the channel reads it, and say when the file was changed.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const { call, close } = await connect(harness);
  try {
    const { draftId } = await cliData<{ draftId: string }>(harness, [
      'draft',
      'create',
      '--workspace',
      'acme',
      '--channel',
      'C1',
      '--text',
      'ready & waiting',
      '--mention',
      'U024BE7LH',
    ]);
    const show = ['draft', 'show', draftId, '--workspace', 'acme'];

    // As written: what it posts, as the channel reads it, and the words it was typed as.
    const fresh = await cliData<ShownDraft>(harness, show);
    assert.equal(fresh.text, '@U024BE7LH ready & waiting');
    assert.equal(fresh.payload?.text, '<@U024BE7LH> ready &amp; waiting');
    assert.equal(fresh.source, 'ready & waiting');
    assert.equal(fresh.problem, undefined);

    await handEdit(harness, draftId, (draft) => {
      draft.source = 'lunch at noon?';
    });

    const shown = await cliData<ShownDraft>(harness, show);
    assert.equal(shown.text, '@U024BE7LH ready & waiting', 'what it would post');
    assert.deepEqual(shown.payload, fresh.payload);
    assert.equal(shown.source, undefined, 'words it does not post are not offered as its own');
    assert.equal(shown.problem?.code, 'BAD_DATA');
    assert.equal(shown.problem?.reason, 'source-differs');
    assert.match(
      shown.problem?.hint ?? '',
      new RegExp(`^It was changed outside agent-slack\\..*\`agent-slack draft delete ${draftId} --workspace <name>\``),
    );
    assert.doesNotMatch(JSON.stringify(shown), /lunch/);

    // The tool says what the command says, and so does each surface's list.
    assert.deepEqual(
      ok<{ draft: ShownDraft }>(await call('slack_draft_get', { workspace: 'acme', draftId })).draft,
      shown,
    );
    assert.deepEqual(ok<{ drafts: ShownDraft[] }>(await call('slack_draft_list', { workspace: 'acme' })).drafts, [
      shown,
    ]);
    assert.deepEqual(await cliData<ShownDraft[]>(harness, ['draft', 'list', '--workspace', 'acme']), [shown]);

    // At a terminal, as a person reads it.
    for (const argv of [show, ['draft', 'list', '--workspace', 'acme']]) {
      const words = await printed(harness, argv);
      assert.match(words, /@U024BE7LH ready & waiting/, argv.join(' '));
      assert.doesNotMatch(words, /lunch/, argv.join(' '));
      assert.match(words, /changed outside agent-slack/, argv.join(' '));
    }

    // And showing and posting agree: the preview a person approves has the text the draft was shown with.
    const prepared = ok<{ preview: { body: string } }>(
      await call('slack_post_prepare', { workspace: 'acme', draftId }),
    );
    assert.equal(prepared.preview.body, shown.text);
  } finally {
    await close();
  }
});

test('a draft whose blocks are not its text is refused by `draft show` and `slack_draft_get` in the gate’s words, and marked so in the list', async () => {
  /*
   * The gate refuses it — preparing, approving and posting — because a client renders and notifies from the blocks,
   * which say something the text does not. Showing it as its text would show one message where the gate sees
   * another, so showing refuses it exactly as the gate does, and a list names it with the gate's words instead of
   * dropping it or printing either half.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002' });
  const { call, close } = await connect(harness);
  try {
    const { draftId } = await cliData<{ draftId: string }>(harness, [
      'draft',
      'create',
      '--workspace',
      'acme',
      '--channel',
      'C1',
      '--text',
      'shipping now',
    ]);
    await handEdit(harness, draftId, (draft) => {
      const payload = draft.payload as Record<string, unknown>;
      payload.blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '<!channel> wire the money' } }];
    });

    const gate = failed(await call('slack_post_prepare', { workspace: 'acme', draftId }));
    assert.equal(gate.code, 'BAD_DATA');
    assert.equal(gate.details?.reason, 'not-composed');
    const refusals = {
      'post prepare': await cliError(harness, ['post', 'prepare', '--workspace', 'acme', '--draft', draftId]),
      'draft show': await cliError(harness, ['draft', 'show', draftId, '--workspace', 'acme']),
      slack_draft_get: failed(await call('slack_draft_get', { workspace: 'acme', draftId })),
    };
    for (const [where, refused] of Object.entries(refusals)) {
      assert.deepEqual([refused.code, refused.message, refused.hint], [gate.code, gate.message, gate.hint], where);
    }

    // Listed, with the gate's words, and with neither the text nor the blocks offered as what it would post.
    const listed = await cliData<ShownDraft[]>(harness, ['draft', 'list', '--workspace', 'acme']);
    assert.deepEqual(
      listed.map((row) => [row.draftId, row.channel, row.problem, row.text, row.payload, row.source]),
      [
        [
          draftId,
          'C1',
          { code: 'BAD_DATA', reason: 'not-composed', message: gate.message, hint: gate.hint },
          undefined,
          undefined,
          undefined,
        ],
      ],
    );
    assert.deepEqual(
      ok<{ drafts: ShownDraft[] }>(await call('slack_draft_list', { workspace: 'acme' })).drafts,
      listed,
    );
    const words = await printed(harness, ['draft', 'list', '--workspace', 'acme']);
    assert.match(words, new RegExp(`${draftId}.*is not what its text composes to`));
    assert.doesNotMatch(words, /shipping now|wire the money/);

    // Another workspace is told there is no such draft, as for any draft of acme's: a refusal would say it exists.
    assert.equal(failed(await call('slack_draft_get', { workspace: 'zeta', draftId })).code, 'NOT_FOUND');
    assert.equal((await cliError(harness, ['draft', 'show', draftId, '--workspace', 'zeta'])).code, 'NOT_FOUND');
  } finally {
    await close();
  }
});

test('a draft whose thread_ts is not a string is refused by show, list, prepare and post, in the gate’s words', async () => {
  /*
   * The gate composed the payload again from the file's own `thread_ts`, whatever it held, so a number compared equal
   * to itself and the draft passed as composed. `draft show` and `slack_draft_get` showed it as a top-level message
   * with no problem, and preparing or posting it failed inside the digest as UNEXPECTED — `threadTs?.trim is not a
   * function` — rather than with the gate's refusal; `null` went further, and prepared as a message outside any thread.
   * The composer only ever writes a string, so anything else is a file changed outside agent-slack: `not-composed`,
   * from all of them, in the same words.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const asked: string[] = [];
  const room = slack();
  const read: FakeFetch = async (input, init) => {
    asked.push(
      String(input instanceof Request ? input.url : input)
        .split('/api/')[1]
        ?.split('?')[0] ?? '',
    );
    return room(input, init);
  };
  const store = openDraftStore(harness.core.paths.stateDir, () => new Date());
  const { call, close } = await connect(harness, { fetch: read });
  try {
    for (const threadTs of [1700000000.0001, null, true, { ts: '1700000000.000100' }, ['1700000000.000100']]) {
      const label = JSON.stringify(threadTs);
      const { draftId } = await cliData<{ draftId: string }>(harness, [
        'draft',
        'create',
        '--workspace',
        'acme',
        '--channel',
        'C1',
        '--text',
        'on it',
        '--thread',
        '1700000000.000100',
      ]);
      // Prepared while it was as written, so that posting it has an approval to claim.
      const { approvalId } = ok<Prepared>(await call('slack_post_prepare', { workspace: 'acme', draftId }));
      await handEdit(harness, draftId, (draft) => {
        (draft.payload as Record<string, unknown>).thread_ts = threadTs;
      });

      const gate = failed(await call('slack_post_prepare', { workspace: 'acme', draftId }));
      assert.equal(gate.code, 'BAD_DATA', label);
      assert.equal(gate.details?.reason, 'not-composed', label);
      const refusals = {
        'post prepare': await cliError(harness, ['post', 'prepare', '--workspace', 'acme', '--draft', draftId], read),
        'draft show': await cliError(harness, ['draft', 'show', draftId, '--workspace', 'acme'], read),
        slack_draft_get: failed(await call('slack_draft_get', { workspace: 'acme', draftId })),
        'post send': await cliError(
          harness,
          [
            'post',
            'send',
            '--workspace',
            'acme',
            '--draft',
            draftId,
            '--approval',
            approvalId,
            '--expect-channel',
            'C1',
          ],
          read,
        ),
        slack_post_send: failed(
          await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: 'C1' }),
        ),
      };
      for (const [where, refused] of Object.entries(refusals)) {
        assert.deepEqual(
          [refused.code, refused.message, refused.hint, refused.details?.reason],
          [gate.code, gate.message, gate.hint, 'not-composed'],
          `${where}, thread_ts ${label}`,
        );
      }

      // Listed with the gate's words, and with no thread, text or payload offered as what it would post.
      const listed = await cliData<ShownDraft[]>(harness, ['draft', 'list', '--workspace', 'acme'], read);
      assert.deepEqual(
        listed.map((row) => [row.draftId, row.channel, row.threadTs, row.problem, row.text, row.payload]),
        [
          [
            draftId,
            'C1',
            undefined,
            { code: 'BAD_DATA', reason: 'not-composed', message: gate.message, hint: gate.hint },
            undefined,
            undefined,
          ],
        ],
        label,
      );
      assert.deepEqual(
        ok<{ drafts: ShownDraft[] }>(await call('slack_draft_list', { workspace: 'acme' })).drafts,
        listed,
        label,
      );
      await store.remove(draftId);
    }
    assert.ok(!asked.includes('chat.postMessage'), `nothing was posted: ${asked.join(', ')}`);
  } finally {
    await close();
  }
});

test('`draft show` and `draft list` show a hidden character escaped, as the preview does — never silently dropped', async () => {
  /*
   * Both stripped them. `Approve invoice 1\u200b0\u202e00 now` printed as `Approve invoice 1000 now`, while `post
   * prepare` printed `1<U+200B>0<U+202E>00` for the same draft: the draft was not shown as what it would post, and the
   * difference was exactly the kind a person about to approve it needs to see. Both now escape as the preview does.
   *
   * Over MCP the preview carries the text as it is — neither escaped nor flagged — and so do the draft tools: what the
   * preview says about a draft, they say.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const { call, close } = await connect(harness);
  try {
    const text = 'Approve invoice 1\u200b0\u202e00 now';
    const escaped = 'Approve invoice 1<U+200B>0<U+202E>00 now';
    const { draftId } = await cliData<{ draftId: string }>(harness, [
      'draft',
      'create',
      '--workspace',
      'acme',
      '--channel',
      'C1\u2060',
      '--text',
      text,
      '--thread',
      '1700000000.000100\u200d',
    ]);
    const hidden = /\u200b|\u200d|\u202e|\u2060/;

    const shown = await printed(harness, ['draft', 'show', draftId, '--workspace', 'acme']);
    assert.ok(shown.includes(escaped), shown);
    assert.ok(shown.includes('C1<U+2060>'), shown);
    assert.ok(shown.includes('1700000000.000100<U+200D>'), shown);
    const listed = await printed(harness, ['draft', 'list', '--workspace', 'acme']);
    assert.ok(listed.includes(escaped), listed);
    assert.ok(listed.includes('C1<U+2060>'), listed);
    for (const [where, words] of Object.entries({ 'draft show': shown, 'draft list': listed })) {
      assert.doesNotMatch(words, hidden, `${where} prints no hidden character as it is`);
      assert.doesNotMatch(words, /invoice 1000/, `${where} does not drop one either`);
    }

    // The preview at a terminal shows the same text, and the same thread, the same way.
    const preview = await printed(harness, ['post', 'prepare', '--workspace', 'acme', '--draft', draftId]);
    assert.ok(preview.includes(escaped), preview);
    assert.ok(preview.includes('1700000000.000100<U+200D>'), preview);

    // Over MCP: the preview's body is the text as it is, unflagged, and the draft tools give that text.
    const prepared = ok<{ preview: { body: string; warnings?: string[] } }>(
      await call('slack_post_prepare', { workspace: 'acme', draftId }),
    );
    assert.equal(prepared.preview.body, text);
    assert.deepEqual(prepared.preview.warnings ?? [], []);
    const { draft } = ok<{ draft: ShownDraft }>(await call('slack_draft_get', { workspace: 'acme', draftId }));
    assert.equal(draft.text, prepared.preview.body);
    assert.equal(draft.problem, undefined);
    const { drafts } = ok<{ drafts: ShownDraft[] }>(await call('slack_draft_list', { workspace: 'acme' }));
    assert.deepEqual(drafts, [draft]);
  } finally {
    await close();
  }
});

test('a draft the composer wrote, in this version or an older one, is not taken for one changed by hand', async () => {
  /*
   * `source` is the author's words before the composer escaped them and put any mentions in front. An older version's
   * `--broadcast` wrote whatever word it was given as a mention — `<!subteam^S0123>` — which the gate previews and
   * sends as it is: that is still the author's words after mentions, not a file somebody changed.
   */
  const harness = await newHarness();
  const acme = await harness.addWorkspace({ alias: 'acme' });
  const store = openDraftStore(harness.core.paths.stateDir, () => new Date());
  const { call, close } = await connect(harness);
  try {
    for (const [text, source, shownAs, changed] of [
      ['standup moved', 'standup moved', 'standup moved', false],
      ['<!subteam^S0123> standup moved', 'standup moved', '@S0123 standup moved', false],
      ['<@U024BE7LH> <!here> a &amp; b &lt;c&gt;', 'a & b <c>', '@U024BE7LH @here a & b <c>', false],
      ['<@U024BE7LH> ', '', '@U024BE7LH ', false],
      ['standup moved!', 'standup moved', 'standup moved!', true],
      ['<@U024BE7LH> standup moved', 'moved', '@U024BE7LH standup moved', true],
      ['a &amp; b', 'a &amp; b', 'a & b', true],
      ['x <!here> standup', 'standup', 'x @here standup', true],
    ] as const) {
      const { draftId } = await store.create(acme.id, payloadOf(text, 'C1', undefined), source);
      const { draft } = ok<{ draft: ShownDraft }>(await call('slack_draft_get', { workspace: 'acme', draftId }));
      assert.equal(draft.text, shownAs, text);
      assert.equal(draft.problem?.reason, changed ? 'source-differs' : undefined, text);
      assert.equal(draft.source, changed ? undefined : source, text);
      await store.remove(draftId);
    }
  } finally {
    await close();
  }
});

test('slack_draft_create writes the draft `draft create` writes, and prepares nothing', async () => {
  /*
   * `draft create` had no tool of its own: it was paired with slack_post_prepare, which writes a draft and prepares
   * it in one call. The operation check found they were not one operation. Both now run `createDraft`: the same draft,
   * the same checks, and no approval until slack_post_prepare is called with its id.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const { call, close } = await connect(harness);
  try {
    const input = { channel: 'C1', text: 'ready & waiting', mentionUsers: ['U024BE7LH'] };
    const byCommand = await cliData<{ draftId: string; payload: unknown; source: string }>(harness, [
      'draft',
      'create',
      '--workspace',
      'acme',
      '--channel',
      input.channel,
      '--text',
      input.text,
      '--mention',
      'U024BE7LH',
    ]);
    const byTool = ok<{ draftId: string; payload: unknown; source: string }>(
      await call('slack_draft_create', { workspace: 'acme', ...input }),
    );
    assert.notEqual(byTool.draftId, byCommand.draftId);
    assert.deepEqual(byTool.payload, byCommand.payload);
    assert.equal(byTool.source, byCommand.source);
    assert.deepEqual(await harness.core.approvals.list(), [], 'writing a draft asks nobody');

    // The same refusals: a mention that is not a user id, and a broadcast the preview could not count.
    const badMention = failed(
      await call('slack_draft_create', { workspace: 'acme', channel: 'C1', text: 'x', mentionUsers: ['U1> <!here'] }),
    );
    assert.equal(badMention.code, 'USAGE');
    const badBroadcast = failed(
      await call('slack_draft_create', { workspace: 'acme', channel: 'C1', text: 'x', broadcast: 'subteam^S0123' }),
    );
    assert.equal(badBroadcast.code, 'USAGE');

    // And the draft it wrote is one slack_post_prepare takes by id.
    const prepared = ok<{ approvalId: string }>(
      await call('slack_post_prepare', { workspace: 'acme', draftId: byTool.draftId }),
    );
    assert.equal(typeof prepared.approvalId, 'string');
  } finally {
    await close();
  }
});
