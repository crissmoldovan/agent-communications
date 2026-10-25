import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { type ActivityItem, type ActivityLine, EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { PNG } from 'pngjs';
import { SLACK_AVATARS_ORIGIN } from '../src/api/methods.ts';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import type { FileDownloader } from '../src/operations/files.ts';
import { say, standing } from './support/ack.ts';
import { homeFile, type Script, scriptedSlack } from './support/amend.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { ENG, cli as standingCli, mcp as standingMcp, standingWorld } from './support/standing.ts';

/*
 * 0.29.0 Task 2b (design 2026-10-25-activity, §4.2 and §8): Slack records what each call read and did in core's
 * activity log — one line per call, on the command line and over MCP alike — and never what anything said.
 *
 * Every test runs against a temporary home and state folder and a scripted Slack (or the loopback fake for the
 * standing approvals): nothing here reaches the real Slack, posts anywhere or reads the real configuration. Each call is
 * made from both surfaces, and the lines it added to the activity file are read back raw from the file.
 */

/** Words the fixture messages say, which no line may ever hold. */
const BODY = 'Davids message body: the launch code is under the mat';
const REPLY_BODY = 'Anas reply body: do not tell anyone about the mat';
const OWN_WORDS = 'Jos own words, posted earlier';
const DRAFT_WORDS = 'the draft text the agent wrote for later';
const NEW_WORDS = 'the edited words the agent asked for';

/** David's message in #eng, the thread it starts, Ana's reply, and a message of this account's. */
const THEIRS = '1700000005.000100';
const REPLY_TS = '1700000006.000100';
const OWN_TS = '1700000000.000100';
const POSTED_TS = '1700000009.000100';
const PHOTO = `${SLACK_AVATARS_ORIGIN}/2026-10-25/1000000000001_0123456789abcdef0123_512.png`;

const USERS: Record<string, Record<string, unknown>> = {
  U0001: { id: 'U0001', name: 'jo', profile: { display_name: 'Jo', real_name: 'Jo Example', image_512: PHOTO } },
  U2: { id: 'U2', name: 'david', profile: { display_name: 'David' } },
  U3: { id: 'U3', name: 'ana', profile: { display_name: 'Ana' } },
};

const FILE = {
  id: 'F0AAA1',
  name: 'plan.pdf',
  title: 'The plan',
  mimetype: 'application/pdf',
  user: 'U2',
  size: 5,
  url_private_download: 'https://files.slack.com/files-pri/T0001-F0AAA1/download/plan.pdf',
  shares: { public: { C1: [{ ts: THEIRS }] } },
};

function script(): Script {
  return {
    'conversations.list': () => ({
      ok: true,
      channels: [
        { id: 'C1', name: 'eng', is_member: true },
        { id: 'D1', is_im: true, user: 'U2' },
      ],
    }),
    'conversations.info': (params) =>
      params.get('channel') === 'C404'
        ? { ok: false, error: 'channel_not_found' }
        : { ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } },
    'conversations.history': (params) => {
      if (params.get('channel') === 'C404') return { ok: false, error: 'channel_not_found' };
      // The edit and the deletion read this account's message at its ts; a read gets David's.
      if (params.get('latest') === OWN_TS) {
        return { ok: true, messages: [{ type: 'message', user: 'U0001', text: OWN_WORDS, ts: OWN_TS }] };
      }
      return { ok: true, messages: [{ type: 'message', user: 'U2', text: BODY, ts: THEIRS }] };
    },
    'conversations.replies': () => ({
      ok: true,
      messages: [
        { type: 'message', user: 'U2', text: BODY, ts: THEIRS, thread_ts: THEIRS },
        { type: 'message', user: 'U3', text: REPLY_BODY, ts: REPLY_TS, thread_ts: THEIRS },
      ],
    }),
    'search.messages': () => ({
      ok: true,
      messages: {
        total: 1,
        paging: { page: 1, pages: 1 },
        matches: [{ ts: THEIRS, user: 'U2', text: BODY, channel: { id: 'C1', name: 'eng' } }],
      },
    }),
    'users.info': (params) => ({ ok: true, user: USERS[params.get('user') ?? ''] ?? { id: params.get('user') } }),
    'users.list': () => ({ ok: true, members: Object.values(USERS) }),
    'files.list': () => ({ ok: true, files: [FILE], paging: { page: 1, pages: 1 } }),
    'files.info': () => ({ ok: true, file: FILE }),
    'chat.postMessage': () => ({ ok: true, channel: 'C1', ts: POSTED_TS }),
    'reactions.add': () => ({ ok: true }),
    'chat.update': (params) => ({ ok: true, channel: params.get('channel'), ts: params.get('ts') }),
    'chat.delete': (params) => ({ ok: true, channel: params.get('channel'), ts: params.get('ts') }),
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

/** A small photo, as Slack's avatar host would send it. */
function photo(): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  png.data = Buffer.alloc(64 * 64 * 4, 200);
  return PNG.sync.write(png);
}

/** The file transport's stand-in: the same few bytes for every file, and nothing fetched. */
const download: FileDownloader = async () => ({ bytes: Buffer.from('PDF!!'), contentType: 'application/pdf' });

interface World {
  readonly harness: Harness;
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** What the activity log holds, line by line, read back from the file. */
  lines(): ActivityLine[];
  /** The raw text of every activity file. */
  raw(): string;
  /** The lines a call added. */
  added<T>(call: () => Promise<T>): Promise<{ result: T; lines: ActivityLine[] }>;
}

async function world(options: { sendPolicy?: 'chat' | 'confirm' } = {}): Promise<World> {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: options.sendPolicy ?? 'chat' });
  mkdirSync(join(harness.home, 'Downloads'), { recursive: true });
  const fake = scriptedSlack(script());
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${SLACK_AVATARS_ORIGIN}/`)) {
      return new Response(photo(), { headers: { 'content-type': 'image/png' } });
    }
    return fake.fetch(input, init);
  };
  const folder = join(harness.core.paths.stateDir, 'activity');
  const files = () =>
    existsSync(folder)
      ? readdirSync(folder)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
      : [];
  const raw = () =>
    files()
      .map((name) => readFileSync(join(folder, name), 'utf8'))
      .join('');
  const lines = () =>
    raw()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ActivityLine);
  return {
    harness,
    fetch,
    lines,
    raw,
    async added(call) {
      const before = lines().length;
      const result = await call();
      return { result, lines: lines().slice(before) };
    },
  };
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  json<T>(): { ok: boolean; data?: T; error?: { code: string; message: string; details?: Record<string, unknown> } };
}

/** `agent-slack`, as an agent's shell runs it — or, with `person`, a person at a terminal typing back the code shown. */
async function cli(w: World, argv: string[], options: { person?: boolean } = {}): Promise<CliResult> {
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
    const asked = /Type (\S+) to approve/.exec(stderr);
    if (options.person && asked && !answered) {
      answered = true;
      input.write(`${asked[1]}\n`);
    }
  });
  const tty = options.person ?? false;
  const code = await run(argv, {
    core: w.harness.core,
    env: w.harness.env,
    exchange: (params) => w.harness.exchange(params),
    streams: {
      stdout: Object.assign(out, { isTTY: tty }),
      stderr: Object.assign(err, { isTTY: tty }),
      stdin: Object.assign(input, { isTTY: tty }),
    },
    openBrowser: () => undefined,
    probe: (probeInput, init) => w.harness.probe(probeInput, init),
    platform: 'darwin',
    read: w.fetch,
    fileDownload: download,
    notify: null,
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function connect(w: World, t: TestContext) {
  const { server } = await createSlackMcpServer({
    core: w.harness.core,
    env: w.harness.env,
    fetch: w.fetch,
    fileDownload: download,
    platform: 'darwin',
    notify: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'activity-test-client', version: '9.8.7' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(() => Promise.all([client.close(), server.close()]));
  return async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** The one line a call added, with the operation, kind and outcome it should have. */
function one(lines: ActivityLine[], operation: string, kind: string, outcome: string, surface: string): ActivityLine {
  assert.equal(lines.length, 1, `${operation} over ${surface} wrote ${lines.length} lines: ${JSON.stringify(lines)}`);
  const [line] = lines as [ActivityLine];
  assert.deepEqual(
    [line.channel, line.operation, line.kind, line.outcome, line.session.surface],
    ['slack', operation, kind, outcome, surface],
    JSON.stringify(line),
  );
  assert.equal(line.account.alias, 'acme');
  assert.match(line.account.id, /^acc_/);
  return line;
}

/** The items of a line, without the fields a test does not compare. */
function items(line: ActivityLine): ActivityItem[] {
  return [...(line.items ?? [])];
}

function ok(result: ToolResult, what: string): Record<string, unknown> {
  assert.notEqual(result.isError, true, `${what}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent as Record<string, unknown>;
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('every read records one line on each surface: message ids, the room by name, the poster by name, counts, the query', async (t) => {
  const w = await world();
  const call = await connect(w, t);

  const reads: {
    operation: string;
    argv: string[];
    tool: string;
    args: Record<string, unknown>;
    expect: (line: ActivityLine) => void;
  }[] = [
    {
      operation: 'slack.channels',
      argv: ['channels'],
      tool: 'slack_channels',
      args: {},
      expect: (line) => {
        assert.equal(line.count, 2);
        assert.deepEqual(items(line), [{ id: 'C1', conversation: 'eng' }, { id: 'D1' }]);
      },
    },
    {
      operation: 'slack.read',
      argv: ['read', 'C1'],
      tool: 'slack_read',
      args: { channel: 'C1' },
      expect: (line) => {
        assert.equal(line.count, 1);
        assert.deepEqual(items(line), [{ id: THEIRS, from: { name: 'David' }, conversation: 'eng' }]);
      },
    },
    {
      operation: 'slack.thread',
      argv: ['thread', 'C1', THEIRS],
      tool: 'slack_thread',
      args: { channel: 'C1', ts: THEIRS },
      expect: (line) => {
        assert.equal(line.count, 2);
        assert.deepEqual(items(line), [
          { id: THEIRS, from: { name: 'David' }, conversation: 'C1' },
          { id: REPLY_TS, from: { name: 'Ana' }, conversation: 'C1' },
        ]);
      },
    },
    {
      operation: 'slack.search',
      argv: ['search', 'launch code'],
      tool: 'slack_search',
      args: { query: 'launch code' },
      expect: (line) => {
        assert.equal(line.query, 'launch code', 'the query is the agent’s words, and kept');
        assert.equal(line.count, 1);
        assert.deepEqual(items(line), [{ id: THEIRS, from: { name: 'David' }, conversation: 'eng' }]);
      },
    },
    {
      operation: 'slack.files',
      argv: ['files'],
      tool: 'slack_files',
      args: {},
      expect: (line) => {
        assert.equal(line.count, 1);
        assert.deepEqual(items(line), [{ id: 'F0AAA1', name: 'plan.pdf', size: 5 }]);
      },
    },
    {
      operation: 'slack.people',
      argv: ['people'],
      tool: 'slack_people',
      args: {},
      expect: (line) => {
        assert.equal(line.count, 3);
        assert.deepEqual(items(line), [{ id: 'U0001' }, { id: 'U2' }, { id: 'U3' }], 'people by id alone');
      },
    },
  ];

  for (const read of reads) {
    const command = await w.added(() => cli(w, ['--json', ...read.argv, '--workspace', 'acme']));
    assert.equal(command.result.code, EXIT_CODES.OK, `${read.argv.join(' ')}: ${command.result.stdout}`);
    read.expect(one(command.lines, read.operation, 'read', 'ok', 'cli'));

    const tool = await w.added(() => call(read.tool, { workspace: 'acme', ...read.args }));
    ok(tool.result, read.tool);
    const line = one(tool.lines, read.operation, 'read', 'ok', 'mcp');
    read.expect(line);
    // What the client said it is, as it said it: the session names it, never as proof.
    assert.deepEqual(line.session.client, { name: 'activity-test-client', version: '9.8.7' });
    assert.equal(command.lines[0]?.session.client, undefined, 'a command line has no client');
  }
});

test('a read that fails is recorded as failed, with why; one of a workspace nobody connected records nothing', async (t) => {
  const w = await world();
  const call = await connect(w, t);

  const command = await w.added(() => cli(w, ['--json', 'read', 'C404', '--workspace', 'acme']));
  assert.notEqual(command.result.code, EXIT_CODES.OK);
  const failed = one(command.lines, 'slack.read', 'read', 'failed', 'cli');
  // Slack's refusal is a NOT_FOUND, which is a failure rather than a refusal: nothing decided against the call.
  assert.match(String(failed.reason), /^NOT_FOUND: no such channel/);
  assert.equal(failed.items, undefined);

  const tool = await w.added(() => call('slack_read', { workspace: 'acme', channel: 'C404' }));
  assert.equal(tool.result.isError, true);
  assert.equal(one(tool.lines, 'slack.read', 'read', 'failed', 'mcp').reason, failed.reason);

  // No account was touched, so there is no account to record it under: the call is refused, and that is all.
  const unknown = await w.added(() => cli(w, ['--json', 'read', 'C1', '--workspace', 'nobody']));
  assert.equal(unknown.result.code, EXIT_CODES.NOT_FOUND, unknown.result.stdout);
  assert.deepEqual(unknown.lines, []);
  const unknownTool = await w.added(() => call('slack_read', { workspace: 'nobody', channel: 'C1' }));
  assert.equal(unknownTool.result.isError, true);
  assert.deepEqual(unknownTool.lines, []);
});

test('a download records the question — an approval — with the files it lists, then the files saved, on each surface', async (t) => {
  const w = await world();
  const call = await connect(w, t);

  // The command, run by an agent: the question, exit 10, and its line.
  const asked = await w.added(() => cli(w, ['--json', 'files', 'download', '--workspace', 'acme', '--file', 'F0AAA1']));
  assert.equal(asked.result.code, EXIT_CODES.APPROVAL, asked.result.stdout);
  const question = one(asked.lines, 'slack.files.download', 'approval', 'ok', 'cli');
  const choiceId = String(asked.result.json().error?.details?.choiceId);
  assert.equal(question.approvalId, choiceId);
  assert.deepEqual(items(question), [{ id: 'F0AAA1', name: 'plan.pdf', size: 5, conversation: 'C1' }]);

  const saved = await w.added(() =>
    cli(w, [
      '--json',
      'files',
      'download',
      '--workspace',
      'acme',
      '--file',
      'F0AAA1',
      '--to',
      'downloads',
      '--choice',
      choiceId,
    ]),
  );
  assert.equal(saved.result.code, EXIT_CODES.OK, saved.result.stdout);
  assert.deepEqual(items(one(saved.lines, 'slack.files.download.answer', 'read', 'ok', 'cli')), [
    { id: 'F0AAA1', name: 'plan.pdf', size: 5, conversation: 'C1' },
  ]);

  // The tool: the same two calls, the same two lines.
  const toolAsked = await w.added(() => call('slack_file_download', { workspace: 'acme', fileIds: ['F0AAA1'] }));
  const toolChoice = String(ok(toolAsked.result, 'the question').choiceId);
  const toolQuestion = one(toolAsked.lines, 'slack.files.download', 'approval', 'ok', 'mcp');
  assert.equal(toolQuestion.approvalId, toolChoice);
  assert.deepEqual(items(toolQuestion), items(question));
  const toolSaved = await w.added(() =>
    call('slack_file_download', { workspace: 'acme', fileIds: ['F0AAA1'], choiceId: toolChoice, saveTo: 'downloads' }),
  );
  ok(toolSaved.result, 'the download');
  // Saved beside the first copy, under the name made for it: the line says which.
  assert.deepEqual(items(one(toolSaved.lines, 'slack.files.download.answer', 'read', 'ok', 'mcp')), [
    { id: 'F0AAA1', name: 'plan-2.pdf', size: 5, conversation: 'C1' },
  ]);
  assert.ok(!w.raw().includes('PDF!!'), 'a file’s bytes are never in a line');
});

test('making the agent emoji records the file it wrote, by name and size', async (t) => {
  const w = await world();
  const call = await connect(w, t);
  const command = await w.added(() => cli(w, ['--json', 'icon', 'make', 'acme']));
  assert.equal(command.result.code, EXIT_CODES.OK, command.result.stdout + command.result.stderr);
  const made = command.result.json<{ path: string; bytes: number }>().data;
  const line = one(command.lines, 'slack.icon.make', 'read', 'ok', 'cli');
  const name = basename(String(made?.path));
  assert.deepEqual(items(line), [{ id: name, name, size: made?.bytes }]);

  const tool = await w.added(() => call('slack_icon_make', { workspace: 'acme' }));
  ok(tool.result, 'slack_icon_make');
  assert.deepEqual(items(one(tool.lines, 'slack.icon.make', 'read', 'ok', 'mcp')), items(line));
});

// ── Drafts, posts, edits and deletions ─────────────────────────────────────────────────────────────────────────

test('drafts record their id, the room they are for and their files, on each surface — never their words', async (t) => {
  const w = await world();
  const call = await connect(w, t);
  const file = homeFile(w.harness, 'notes.txt', 'the notes say nothing a line may hold');

  for (const surface of ['cli', 'mcp'] as const) {
    const created = await w.added(async () =>
      surface === 'cli'
        ? (
            await cli(w, [
              '--json',
              'draft',
              'create',
              '--workspace',
              'acme',
              '--channel',
              'C1',
              '--text',
              DRAFT_WORDS,
              '--file',
              file,
            ])
          ).json<{ draftId: string }>().data?.draftId
        : String(
            ok(
              await call('slack_draft_create', { workspace: 'acme', channel: 'C1', text: DRAFT_WORDS, files: [file] }),
              'create',
            ).draftId,
          ),
    );
    const draftId = String(created.result);
    const [draft, attached] = items(one(created.lines, 'slack.draft.create', 'approval', 'ok', surface));
    assert.deepEqual(draft, { id: draftId, conversation: 'C1' });
    assert.equal(attached?.name, 'notes.txt');
    assert.equal(attached?.size, 'the notes say nothing a line may hold'.length);
    assert.match(String(attached?.id), /^[0-9a-f]{64}$/, 'a file by the SHA-256 of its bytes');

    const updated = await w.added<unknown>(() =>
      surface === 'cli'
        ? cli(w, ['--json', 'draft', 'update', draftId, '--workspace', 'acme', '--no-files'])
        : call('slack_draft_update', { workspace: 'acme', draftId, files: [] }),
    );
    assert.deepEqual(items(one(updated.lines, 'slack.draft.update', 'approval', 'ok', surface)), [
      { id: draftId, conversation: 'C1' },
    ]);

    const shown = await w.added<unknown>(() =>
      surface === 'cli'
        ? cli(w, ['--json', 'draft', 'show', draftId, '--workspace', 'acme'])
        : call('slack_draft_get', { workspace: 'acme', draftId }),
    );
    assert.deepEqual(items(one(shown.lines, 'slack.draft.get', 'read', 'ok', surface)), [
      { id: draftId, conversation: 'C1' },
    ]);

    const listed = await w.added<unknown>(() =>
      surface === 'cli'
        ? cli(w, ['--json', 'draft', 'list', '--workspace', 'acme'])
        : call('slack_draft_list', { workspace: 'acme' }),
    );
    const list = one(listed.lines, 'slack.draft.list', 'read', 'ok', surface);
    assert.equal(list.count, 1);
    assert.deepEqual(items(list), [{ id: draftId, conversation: 'C1' }]);

    const deleted = await w.added<unknown>(() =>
      surface === 'cli'
        ? cli(w, ['--json', 'draft', 'delete', draftId, '--workspace', 'acme'])
        : call('slack_draft_delete', { workspace: 'acme', draftId }),
    );
    assert.deepEqual(items(one(deleted.lines, 'slack.draft.delete', 'approval', 'ok', surface)), [{ id: draftId }]);
  }
  assert.ok(!w.raw().includes(DRAFT_WORDS), 'a draft’s words are never in a line');
  assert.ok(!w.raw().includes('the notes say nothing'), 'nor a file’s');
});

test('a post records the draft and the room when prepared, and the message it made when sent, with its approval', async (t) => {
  const w = await world();
  const call = await connect(w, t);

  // The command: a draft, prepared, then posted — under `chat`, the yes already given.
  const draftId = (
    await cli(w, ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', DRAFT_WORDS])
  ).json<{ draftId: string }>().data?.draftId as string;
  const prepared = await w.added(() =>
    cli(w, ['--json', 'post', 'prepare', '--workspace', 'acme', '--draft', draftId]),
  );
  assert.equal(prepared.result.code, EXIT_CODES.OK, prepared.result.stdout);
  const approvalId = prepared.result.json<{ approvalId: string }>().data?.approvalId as string;
  const prepare = one(prepared.lines, 'slack.post.prepare', 'approval', 'ok', 'cli');
  assert.equal(prepare.approvalId, approvalId);
  assert.deepEqual(items(prepare), [{ id: draftId, conversation: '#eng' }]);

  const posted = await w.added(() =>
    cli(w, [
      '--json',
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
    ]),
  );
  assert.equal(posted.result.code, EXIT_CODES.OK, posted.result.stdout);
  const send = one(posted.lines, 'slack.post.send', 'write', 'ok', 'cli');
  assert.equal(send.approvalId, approvalId);
  assert.deepEqual(items(send), [{ id: POSTED_TS, conversation: 'C1' }]);

  // The tools: composed and prepared in one call, then posted.
  const toolPrepared = await w.added(() =>
    call('slack_post_prepare', { workspace: 'acme', channel: 'C1', text: DRAFT_WORDS }),
  );
  const { draftId: toolDraft, approvalId: toolApproval } = ok(toolPrepared.result, 'prepare') as {
    draftId: string;
    approvalId: string;
  };
  const toolPrepare = one(toolPrepared.lines, 'slack.post.prepare', 'approval', 'ok', 'mcp');
  assert.equal(toolPrepare.approvalId, toolApproval);
  assert.deepEqual(items(toolPrepare), [{ id: toolDraft, conversation: '#eng' }]);
  const toolPosted = await w.added(() =>
    call('slack_post_send', { workspace: 'acme', draftId: toolDraft, approvalId: toolApproval, expectChannel: 'C1' }),
  );
  ok(toolPosted.result, 'send');
  const toolSend = one(toolPosted.lines, 'slack.post.send', 'write', 'ok', 'mcp');
  assert.equal(toolSend.approvalId, toolApproval);
  assert.deepEqual(items(toolSend), [{ id: POSTED_TS, conversation: 'C1' }]);

  // A second send of a spent approval is refused, and recorded as that.
  const again = await w.added(() =>
    call('slack_post_send', { workspace: 'acme', draftId: toolDraft, approvalId: toolApproval, expectChannel: 'C1' }),
  );
  assert.equal(again.result.isError, true);
  const refused = one(again.lines, 'slack.post.send', 'write', 'refused', 'mcp');
  assert.match(String(refused.reason), /^APPROVAL_/);
  assert.ok(!w.raw().includes(DRAFT_WORDS), 'a post’s words are never in a line');
});

test('an edit and a deletion record the message, the room and the approval, on each surface — never its words', async (t) => {
  const w = await world();
  const call = await connect(w, t);

  // The command: the new words as a draft, the edit prepared, then made; then the deletion prepared and made.
  const draftId = (
    await cli(w, ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', NEW_WORDS])
  ).json<{ draftId: string }>().data?.draftId as string;
  const prepared = await w.added(() =>
    cli(w, ['--json', 'edit', 'prepare', '--workspace', 'acme', '--draft', draftId, '--ts', OWN_TS]),
  );
  assert.equal(prepared.result.code, EXIT_CODES.OK, prepared.result.stdout);
  const approvalId = prepared.result.json<{ approvalId: string }>().data?.approvalId as string;
  const editPrepare = one(prepared.lines, 'slack.edit.prepare', 'approval', 'ok', 'cli');
  assert.equal(editPrepare.approvalId, approvalId);
  assert.deepEqual(items(editPrepare), [{ id: OWN_TS, conversation: '#eng' }]);
  const edited = await w.added(() =>
    cli(w, [
      '--json',
      'edit',
      'send',
      '--workspace',
      'acme',
      '--draft',
      draftId,
      '--approval',
      approvalId,
      '--expect-channel',
      'C1',
      '--ts',
      OWN_TS,
    ]),
  );
  assert.equal(edited.result.code, EXIT_CODES.OK, edited.result.stdout);
  const editSend = one(edited.lines, 'slack.edit.send', 'write', 'ok', 'cli');
  assert.equal(editSend.approvalId, approvalId);
  assert.deepEqual(items(editSend), [{ id: OWN_TS, conversation: 'C1' }]);

  const toPrepare = await w.added(() =>
    cli(w, ['--json', 'delete', 'prepare', '--workspace', 'acme', '--channel', 'C1', '--ts', OWN_TS]),
  );
  assert.equal(toPrepare.result.code, EXIT_CODES.OK, toPrepare.result.stdout);
  const deletion = toPrepare.result.json<{ approvalId: string }>().data?.approvalId as string;
  const deletePrepare = one(toPrepare.lines, 'slack.delete.prepare', 'approval', 'ok', 'cli');
  assert.deepEqual(
    [deletePrepare.approvalId, items(deletePrepare)],
    [deletion, [{ id: OWN_TS, conversation: '#eng' }]],
  );
  const deleted = await w.added(() =>
    cli(w, [
      '--json',
      'delete',
      'send',
      '--workspace',
      'acme',
      '--channel',
      'C1',
      '--ts',
      OWN_TS,
      '--approval',
      deletion,
    ]),
  );
  assert.equal(deleted.result.code, EXIT_CODES.OK, deleted.result.stdout);
  const deleteSend = one(deleted.lines, 'slack.delete.send', 'write', 'ok', 'cli');
  assert.deepEqual([deleteSend.approvalId, items(deleteSend)], [deletion, [{ id: OWN_TS, conversation: 'C1' }]]);

  // The tools.
  const toolEdit = await w.added(() =>
    call('slack_edit_prepare', { workspace: 'acme', channel: 'C1', ts: OWN_TS, text: NEW_WORDS }),
  );
  const { draftId: editDraft, approvalId: editApproval } = ok(toolEdit.result, 'edit prepare') as {
    draftId: string;
    approvalId: string;
  };
  assert.deepEqual(items(one(toolEdit.lines, 'slack.edit.prepare', 'approval', 'ok', 'mcp')), [
    { id: OWN_TS, conversation: '#eng' },
  ]);
  const toolEdited = await w.added(() =>
    call('slack_edit_send', {
      workspace: 'acme',
      draftId: editDraft,
      approvalId: editApproval,
      expectChannel: 'C1',
      ts: OWN_TS,
    }),
  );
  ok(toolEdited.result, 'edit send');
  assert.equal(one(toolEdited.lines, 'slack.edit.send', 'write', 'ok', 'mcp').approvalId, editApproval);
  const toolDelete = await w.added(() =>
    call('slack_delete_prepare', { workspace: 'acme', channel: 'C1', ts: OWN_TS }),
  );
  const deleteApproval = String(ok(toolDelete.result, 'delete prepare').approvalId);
  assert.equal(one(toolDelete.lines, 'slack.delete.prepare', 'approval', 'ok', 'mcp').approvalId, deleteApproval);
  const toolDeleted = await w.added(() =>
    call('slack_delete_send', { workspace: 'acme', channel: 'C1', ts: OWN_TS, approvalId: deleteApproval }),
  );
  ok(toolDeleted.result, 'delete send');
  assert.deepEqual(items(one(toolDeleted.lines, 'slack.delete.send', 'write', 'ok', 'mcp')), [
    { id: OWN_TS, conversation: 'C1' },
  ]);

  for (const words of [NEW_WORDS, OWN_WORDS]) assert.ok(!w.raw().includes(words), `"${words}" is in a line`);
});

test('a reaction waiting for a person is a refused approval line; the reaction made with their approval is a write', async (t) => {
  const w = await world({ sendPolicy: 'confirm' });
  const call = await connect(w, t);
  const reaction = ['--channel', 'C1', '--ts', THEIRS, '--emoji', 'eyes'];

  for (const surface of ['cli', 'mcp'] as const) {
    const asked = await w.added<unknown>(() =>
      surface === 'cli'
        ? cli(w, ['--json', 'react', '--workspace', 'acme', ...reaction])
        : call('slack_react', { workspace: 'acme', channel: 'C1', ts: THEIRS, emoji: 'eyes' }),
    );
    const pending = one(asked.lines, 'slack.react', 'approval', 'refused', surface);
    assert.match(String(pending.reason), /^APPROVAL_PENDING/);
    const error =
      surface === 'cli'
        ? (asked.result as CliResult).json().error
        : ((asked.result as ToolResult).structuredContent?.error as { details?: Record<string, unknown> } | undefined);
    const approvalId = String(error?.details?.approvalId);
    assert.match(approvalId, /^ap_/);

    // The person approves at their own terminal: their step, not an agent session's, and no line of its own.
    const approved = await w.added(() => cli(w, ['approve', approvalId], { person: true }));
    assert.equal(approved.result.code, EXIT_CODES.OK, approved.result.stdout + approved.result.stderr);
    assert.deepEqual(approved.lines, []);

    const made = await w.added<unknown>(() =>
      surface === 'cli'
        ? cli(w, ['--json', 'react', '--workspace', 'acme', ...reaction, '--approval', approvalId])
        : call('slack_react_send', { workspace: 'acme', channel: 'C1', ts: THEIRS, emoji: 'eyes', approvalId }),
    );
    const line = one(made.lines, 'slack.react.send', 'write', 'ok', surface);
    assert.equal(line.approvalId, approvalId);
    assert.deepEqual(items(line), [{ id: THEIRS, conversation: 'C1' }]);
  }
});

test('a standing approval prepared, and an acknowledgement made under it, each record one line on each surface', async (t) => {
  const w = await standingWorld(t, { sendPolicy: 'chat' });
  const folder = join(w.harness.core.paths.stateDir, 'activity');
  // The day files only: the folder also holds core's own indexes (`.index`, `.parents`).
  const lines = () =>
    (existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.jsonl')) : [])
      .sort()
      .flatMap((name) => readFileSync(join(folder, name), 'utf8').split('\n'))
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ActivityLine);
  const added = async <T>(run: () => Promise<T>) => {
    const before = lines().length;
    const result = await run();
    return { result, lines: lines().slice(before) };
  };
  const { call } = await standingMcp(w, t);

  // Prepared by an agent: the approval it waits on, and the place it names. The person approves it at a terminal.
  const command = await added(() =>
    standingCli(w, ['--json', 'standing', 'add', '--workspace', 'acme', '--places', ENG, '--reactions', 'eyes']),
  );
  assert.equal(command.result.code, EXIT_CODES.APPROVAL, command.result.stdout);
  const prepared = one(command.lines, 'slack.standing.add', 'approval', 'ok', 'cli');
  assert.match(String(prepared.approvalId), /^ap_/);
  assert.deepEqual(items(prepared), [{ id: ENG }]);
  const tool = await added(() => call('slack_standing_add', { workspace: 'acme', places: [ENG], reactions: ['eyes'] }));
  assert.notEqual(tool.result.isError, true, JSON.stringify(tool.result.structuredContent));
  assert.deepEqual(items(one(tool.lines, 'slack.standing.add', 'approval', 'ok', 'mcp')), [{ id: ENG }]);

  // An acknowledgement under one the person made and approved.
  const s = await standing(w, { reactions: ['eyes'], places: [ENG] });
  for (const surface of ['cli', 'mcp'] as const) {
    const ts = say(w, { channel: ENG });
    const request = { standingId: s.id, channel: ENG, ts, content: s.digest('reaction', 'eyes') };
    const acked = await added(async () =>
      surface === 'cli'
        ? (
            await standingCli(w, [
              '--json',
              'ack',
              '--workspace',
              'acme',
              '--standing',
              s.id,
              '--channel',
              ENG,
              '--ts',
              ts,
              '--content',
              request.content,
            ])
          ).code
        : (await call('slack_ack', { workspace: 'acme', ...request })).isError,
    );
    assert.ok(acked.result === EXIT_CODES.OK || acked.result === undefined, `ack over ${surface}`);
    const line = one(acked.lines, 'slack.ack', 'write', 'ok', surface);
    assert.match(String(line.approvalId), /^ap_/, 'the one-shot child it was sent under');
    assert.deepEqual(items(line), [{ id: ts, conversation: ENG }]);
  }
});

// ── What records nothing ───────────────────────────────────────────────────────────────────────────────────────

test('setup, configuration, the doctor and an approval’s wait record nothing: they touch no workspace’s data', async (t) => {
  const w = await world();
  const call = await connect(w, t);
  const commands = [
    ['workspace', 'list'],
    ['workspace', 'show', 'acme'],
    ['workspace', 'mode', 'acme'],
    ['workspace', 'policy', 'acme'],
    ['doctor', '--offline'],
    ['manifest', '--port', '51234'],
    ['approval', 'wait', `ap_${'0'.repeat(26)}`, '--wait-seconds', '0'],
  ];
  for (const argv of commands) {
    const ran = await w.added(() => cli(w, ['--json', ...argv]));
    assert.deepEqual(ran.lines, [], `${argv.join(' ')} recorded a line`);
  }
  const tools: [string, Record<string, unknown>][] = [
    ['slack_workspaces_list', {}],
    ['slack_workspace_show', { workspace: 'acme' }],
    ['slack_mode', { workspace: 'acme' }],
    ['slack_workspace_policy', { workspace: 'acme' }],
    ['slack_doctor', { offline: true }],
    ['slack_manifest', { port: 51234 }],
    ['slack_approval_wait', { approvalId: `ap_${'0'.repeat(26)}`, waitSeconds: 0 }],
  ];
  for (const [name, args] of tools) {
    const called = await w.added(() => call(name, args));
    assert.deepEqual(called.lines, [], `${name} recorded a line`);
  }
});

// ── Never content ──────────────────────────────────────────────────────────────────────────────────────────────

test('no message body, reply or own words appear anywhere in the activity file after every read', async (t) => {
  const w = await world();
  const call = await connect(w, t);
  for (const argv of [
    ['read', 'C1'],
    ['thread', 'C1', THEIRS],
    ['search', 'mat'],
  ]) {
    assert.equal((await cli(w, ['--json', ...argv, '--workspace', 'acme'])).code, EXIT_CODES.OK);
  }
  for (const [name, args] of [
    ['slack_read', { channel: 'C1' }],
    ['slack_thread', { channel: 'C1', ts: THEIRS }],
    ['slack_search', { query: 'mat' }],
  ] as const) {
    ok(await call(name, { workspace: 'acme', ...args }), name);
  }
  const raw = w.raw();
  assert.equal(w.lines().length, 6, raw);
  for (const words of [BODY, REPLY_BODY, 'launch code is under', 'do not tell anyone']) {
    assert.ok(!raw.includes(words), `"${words}" is in the activity file`);
  }
});
