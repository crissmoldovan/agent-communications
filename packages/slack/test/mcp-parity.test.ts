import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { openFlowStore } from '../src/auth/flow.ts';
import { run } from '../src/cli/program.ts';
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
