import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  asV2,
  claimUpdateCheck,
  EXIT_CODES,
  gatedChange,
  readUpdateCheck,
  UPDATE_CHECK_CHILD_COMMAND,
  updateCheckPath,
  updateLevelChange,
} from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import type { FileDownloader, FileDownloadQuestion, FileDownloadResult } from '../src/operations/files.ts';
import { assertNoBareCommand, coreInline } from './support/handoffs.ts';
import { type Harness, newHarness, tempDir } from './support/harness.ts';

/*
 * The update notice, on Slack's server and command (design 2026-10-16, U1): nothing is refused for being behind. The
 * server's first result carries one line beside it, and a command prints it once on stderr, at most once a day for the
 * machine. The check is turned back on here — the harness turns it off — with a file a check wrote a moment ago, so
 * nothing here asks a registry, and Slack is a fetch that refuses.
 */

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

const refuseEverything = async () => new Response(JSON.stringify({ ok: false, error: 'unknown_method' }));

function updateOut(harness: Harness, current: { registered: string[]; global: string[] } | null = null): void {
  harness.env.AGENT_COMMS_UPDATE_CHECK = 'on';
  harness.env.npm_config_registry = 'http://127.0.0.1:9/';
  const stateDir = harness.core.paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(stateDir),
    JSON.stringify({ lastChecked: new Date().toISOString(), latest: '99.0.0', behind: true, current }),
  );
}

/** An approval this machine holds, prepared before the update was found — as a post approved moments before is. */
async function heldApproval(harness: Harness): Promise<string> {
  const prepared = await gatedChange(harness.core, updateLevelChange(harness.core, 'never'), {
    channel: 'slack',
    surface: 'mcp',
  });
  assert.equal(prepared.status, 'approval-required');
  return (prepared as { prepared: { approvalId: string } }).prepared.approvalId;
}

const code = (result: ToolResult) =>
  (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
const text = (result: ToolResult) => (result.content ?? []).find((part) => part.type === 'text')?.text ?? '';
const notice = (result: ToolResult) => result.structuredContent?.update as string | undefined;
const OUT = 'agent-communications 99.0.0 is out; say "update" when it suits you.';

test('an update that is out stops no Slack tool: the first result carries the notice, once, and the doctor never does', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  updateOut(harness);
  const connectSlack = async () => {
    const { server } = await createSlackMcpServer({
      core: harness.core,
      env: harness.env,
      fetch: refuseEverything,
      probe: (input, init) => harness.probe(input, init),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult;
    return { call, close: () => Promise.all([client.close(), server.close()]) };
  };
  const { call, close } = await connectSlack();
  try {
    assert.equal(notice(await call('slack_doctor', { offline: true })), undefined, 'the doctor carried the notice');
    const listed = await call('slack_workspaces_list', {});
    assert.notEqual(listed.isError, true, JSON.stringify(listed.structuredContent));
    assert.equal(notice(listed), OUT);
    assert.ok(
      (listed.content ?? []).some((part) => part.text === OUT),
      'a text block of its own',
    );
    // The rest of this process's results carry nothing, a refusal's included.
    const send = await call('slack_post_send', {
      workspace: 'acme',
      draftId: 'dr_none',
      approvalId: `ap_${'0'.repeat(26)}`,
      expectChannel: 'C0000000000',
    });
    assert.equal(notice(send), undefined);
    assert.notEqual(code(send), 'UPDATE_REQUIRED', 'the post was answered by its own gate');
  } finally {
    await close();
  }
  // Every registration of Slack's server here names the latest: restart the client. Another channel's, or Slack's
  // global command, says nothing of this server: it is out.
  for (const [current, words] of [
    [{ registered: ['slack'], global: [] }, /is installed; restart the client/],
    [{ registered: ['gmail'], global: ['slack'] }, /is out; say "update"/],
  ] as const) {
    updateOut(harness, { registered: [...current.registered], global: [...current.global] });
    const next = await connectSlack();
    try {
      assert.match(String(notice(await next.call('slack_workspaces_list', {}))), words);
    } finally {
      await next.close();
    }
  }
});

test('agent-slack: a command that is behind runs, and says so once on stderr, naming core’s own update', async () => {
  const harness = await newHarness();
  updateOut(harness);
  const command = async (argv: string[]) => {
    let stdout = '';
    let stderr = '';
    const out = new PassThrough();
    out.on('data', (chunk) => {
      stdout += String(chunk);
    });
    const err = new PassThrough();
    err.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exit = await run(argv, {
      core: harness.core,
      env: harness.env,
      streams: { stdout: out, stderr: err, stdin: new PassThrough() },
      openBrowser: () => undefined,
      probe: (input, init) => harness.probe(input, init),
      read: refuseEverything,
    });
    return { exit, stdout, stderr };
  };
  const listed = await command(['workspace', 'list', '--json']);
  assert.equal(listed.exit, 0, listed.stdout + listed.stderr);
  // Core's update, found through the core Slack has installed and located: never a bare `agentcomms` (CUE-403).
  assert.match(listed.stderr, /^agent-communications 99\.0\.0 is out \(this is /m);
  assert.ok(listed.stderr.includes(coreInline(harness.core.paths, ['update'])), listed.stderr);
  assertNoBareCommand(listed.stderr);
  assert.doesNotMatch(listed.stdout, /is out/, 'the line is on stderr, never in the result');
  // Not again today, on this machine; and never by the doctor or the listener a sign-in starts.
  assert.doesNotMatch((await command(['workspace', 'list', '--json'])).stderr, /is out/);
  updateOut(harness);
  assert.doesNotMatch((await command(['doctor', '--offline', '--json'])).stderr, /is out/);
  assert.doesNotMatch((await command(['sign-in-listen', 'flow_none', '--json'])).stderr, /is out/);
  // Slack's package installed globally at the latest, and this copy older: told to run the installed one.
  updateOut(harness, { registered: [], global: ['slack'] });
  const older = await command(['workspace', 'list', '--json']);
  assert.equal(older.exit, 0, older.stdout);
  assert.match(older.stderr, /is installed; this Slack CLI is .*: run it from the installed one\./);
});

test('an approval a call would not claim is refused by a report, the steps, the app step and a finish: nothing is shown or collected', async () => {
  /*
   * Each of these took an approval id and claimed none: they answered as though it were not there — which once got a
   * call past the update check's stop. Nothing is stopped now, and each still refuses it as usage, on both surfaces,
   * before it reads or collects anything.
   */
  const harness = await newHarness();
  // `read`, and its app never asked for posting; and one that posts. Each with the port it last signed in with.
  await harness.addWorkspace({ alias: 'acme', redirectPort: 51234 });
  await harness.addWorkspace({ alias: 'beta', mode: 'send', workspaceId: 'T0002', redirectPort: 51235 });
  const later = await heldApproval(harness);
  updateOut(harness);
  const before = JSON.stringify(await harness.core.config.load());

  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    fetch: refuseEverything,
    probe: (input, init) => harness.probe(input, init),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  try {
    for (const [what, tool, args, words] of [
      ['the report', 'slack_mode_set', { workspace: 'acme', mode: 'read' }, /only reports acme's mode/],
      ['the steps to read', 'slack_mode_set', { workspace: 'beta', mode: 'read' }, /changes nothing here/],
      ['the app step', 'slack_mode_set', { workspace: 'acme', mode: 'send' }, /has to ask for the send scopes first/],
      ['the policy report', 'slack_workspace_policy', { workspace: 'acme' }, /an approval goes with a policy to set/],
    ] as const) {
      const result = await call(tool, { ...args, approvalId: later });
      assert.equal(code(result), 'USAGE', `${what}: ${JSON.stringify(result.structuredContent)}`);
      assert.match(text(result), words, what);
      assert.doesNotMatch(text(result), /"manifest"|"steps"|"sendPolicy"/, `${what} was answered`);
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
  }

  const command = async (argv: string[]) => {
    let stdout = '';
    const out = new PassThrough();
    out.on('data', (chunk) => {
      stdout += String(chunk);
    });
    const exit = await run([...argv, '--approval', later, '--json'], {
      core: harness.core,
      env: harness.env,
      streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
      openBrowser: () => undefined,
      probe: (input, init) => harness.probe(input, init),
      read: refuseEverything,
    });
    return { exit, stdout };
  };
  for (const [argv, words] of [
    [['workspace', 'mode', 'acme'], /only reports acme's mode/],
    [['workspace', 'mode', 'beta', 'read'], /changes nothing here/],
    [['workspace', 'mode', 'acme', 'send'], /has to ask for the send scopes first/],
    [['workspace', 'policy', 'acme'], /an approval goes with a policy to set/],
    [['workspace', 'add', '--finish', 'sfl_none'], /--finish collects a sign-in already started/],
    [['workspace', 'reauth', 'acme', '--finish', 'sfl_none'], /--finish collects a sign-in already started/],
  ] as const) {
    const refused = await command([...argv]);
    assert.equal(refused.exit, EXIT_CODES.USAGE, `${argv.join(' ')}: ${refused.stdout}`);
    const error = (JSON.parse(refused.stdout) as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'USAGE', argv.join(' '));
    assert.match(error.message, words, argv.join(' '));
  }

  assert.equal(JSON.stringify(await harness.core.config.load()), before, 'a workspace was changed');
  assert.equal(asV2(await harness.core.approvals.get(later))?.state, 'pending', 'the approval was claimed');
});

// ── Saving files: `slack_file_download` and `agent-slack files download` ─────────────────────────────────────────

/*
 * The download is the one Slack surface that writes to this machine. With an update out it is never stopped: it asks,
 * and the person's answer saves, as on any other day. Each case counts what reached Slack, what reached the file
 * transport and what reached the disk.
 */

const FILE_ID = 'F0AAA1';

/** Slack, as far as one file by id needs it, recording each method it is asked; never the real one. */
function slackForOneFile() {
  const asked: string[] = [];
  const fetch = async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    asked.push(method);
    const replies: Record<string, unknown> = {
      'files.info': {
        ok: true,
        file: {
          id: FILE_ID,
          name: 'numbers.pdf',
          title: 'Numbers',
          mimetype: 'application/pdf',
          user: 'U0001',
          url_private_download: `https://files.slack.com/files-pri/T0001-${FILE_ID}/download/numbers.pdf`,
          shares: { public: { C0AAA1: [{ ts: '1700000000.000100' }] } },
        },
      },
      'users.info': { ok: true, user: { id: 'U0001', profile: { display_name: 'sam' } } },
    };
    return new Response(JSON.stringify(replies[method] ?? { ok: false, error: 'unknown_method' }));
  };
  return { fetch, asked };
}

/** The file transport's stand-in: the bytes of the one file, recording each file asked for. */
function fileTransport() {
  const asked: string[] = [];
  const download: FileDownloader = async (_call, request) => {
    asked.push(request.fileId);
    return { bytes: Buffer.from('%PDF-1.4 numbers'), contentType: 'application/pdf' };
  };
  return { download, asked };
}

/**
 * A harness with a workspace, and a downloads folder of its own in its home.
 *
 * Not `core.paths.downloadsDir`: on Windows that is under USERPROFILE, which the harness does not set, so it is the
 * runner's own Downloads folder — shared with every other test file running beside this one, and never emptied — and
 * "nothing was saved" would read their files.
 */
async function downloadHarness(): Promise<{ harness: Harness; root: string }> {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const root = join(harness.home, 'downloads');
  await harness.core.config.update((config) => ({ ...config, defaults: { ...config.defaults, downloadsDir: root } }), {
    consent: { kind: 'loosening-consent', paths: ['defaults.downloadsDir'] },
  });
  return { harness, root };
}

/** Everything under a downloads root, as paths below it: empty when nothing was ever written there. */
function saved(root: string): string[] {
  return existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]).sort() : [];
}

async function downloadAudits(harness: Harness): Promise<number> {
  const records = await harness.core.audit.tail({ limit: 50 });
  return records.filter((record) => record.operation === 'files.download').length;
}

/** The check's file as a check that could not reach the registry leaves it: asked today, nothing learnt. */
function offline(harness: Harness): void {
  harness.env.AGENT_COMMS_UPDATE_CHECK = 'on';
  harness.env.npm_config_registry = 'http://127.0.0.1:9/';
  const stateDir = harness.core.paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(stateDir),
    JSON.stringify({
      lastChecked: new Date().toISOString(),
      latest: null,
      behind: null,
      current: null,
      lastError: 'http://127.0.0.1:9 could not be reached (ECONNREFUSED)',
    }),
  );
}

/**
 * Every state of the update check a download meets: an update out, put off, switched off, turned off, CI, offline.
 * "Not now" is written an hour ahead rather than at the midnight the product writes, so a run that crosses midnight
 * cannot see it run out.
 */
const WAYS_PAST: readonly { label: string; apply: (harness: Harness) => Promise<void> | void }[] = [
  { label: 'an update out', apply: (harness) => updateOut(harness) },
  {
    label: 'an earlier release’s not now',
    apply: (harness) => {
      updateOut(harness);
      writeFileSync(
        updateCheckPath(harness.core.paths.stateDir),
        JSON.stringify({
          lastChecked: new Date().toISOString(),
          latest: '99.0.0',
          behind: true,
          current: null,
          snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
    },
  },
  {
    label: 'switched off for the process',
    apply: (harness) => {
      updateOut(harness);
      harness.env.AGENT_COMMS_UPDATE_CHECK = 'off';
    },
  },
  {
    label: 'turned off for the machine',
    apply: async (harness) => {
      updateOut(harness);
      await harness.core.config.update(
        (config) => ({ ...config, defaults: { ...config.defaults, updates: 'never', updateCheck: 'off' } }),
        { consent: { kind: 'loosening-consent', paths: ['defaults.updates'] } },
      );
    },
  },
  {
    label: 'CI',
    apply: (harness) => {
      updateOut(harness);
      harness.env.CI = 'true';
    },
  },
  { label: 'offline', apply: offline },
];

async function downloadOverMcp(harness: Harness, args: Record<string, unknown> = {}) {
  const slack = slackForOneFile();
  const transport = fileTransport();
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    fetch: slack.fetch,
    fileDownload: transport.download,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name: 'slack_file_download',
      arguments: { workspace: 'acme', fileIds: [FILE_ID], ...args },
    })) as ToolResult;
    return { result, slack: slack.asked, transport: transport.asked };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

/** The command with no terminal on any end, as a script or an agent's shell runs it. */
async function downloadAtCommand(harness: Harness, extra: string[] = [], options: { json?: boolean } = {}) {
  const slack = slackForOneFile();
  const transport = fileTransport();
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const err = new PassThrough();
  err.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const argv = [
    ...(options.json === false ? [] : ['--json']),
    ...['files', 'download', '--workspace', 'acme', '--file', FILE_ID],
    ...extra,
  ];
  const exit = await run(argv, {
    core: harness.core,
    env: harness.env,
    streams: {
      stdout: Object.assign(out, { isTTY: false }),
      stderr: Object.assign(err, { isTTY: false }),
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
    },
    openBrowser: () => undefined,
    probe: (input, init) => harness.probe(input, init),
    read: slack.fetch,
    fileDownload: transport.download,
  });
  return { exit, stdout, stderr, slack: slack.asked, transport: transport.asked };
}

/** Whether a saved file is on disk, inside this harness's downloads root. */
function savedInside(root: string, path: string | undefined): boolean {
  if (path === undefined || !existsSync(path)) return false;
  const below = relative(root, path);
  return below !== '' && !below.startsWith('..') && !below.includes(':');
}

test('the download goes ahead with an update out, put off, switched off, turned off, in CI or offline — over MCP and at the command', async () => {
  for (const { label, apply } of WAYS_PAST) {
    // Over MCP.
    const tool = await downloadHarness();
    await apply(tool.harness);
    // Asked first — nothing fetched — then answered, as the person would.
    const asked = await downloadOverMcp(tool.harness);
    assert.notEqual(asked.result.isError, true, `${label}: ${JSON.stringify(asked.result.structuredContent)}`);
    const question = asked.result.structuredContent as unknown as FileDownloadQuestion;
    assert.equal(question.destinationRequired, true, `${label}: ${JSON.stringify(question)}`);
    assert.deepEqual(asked.transport, [], `${label}: fetched before the person answered`);
    const passed = await downloadOverMcp(tool.harness, { saveTo: 'downloads', choiceId: question.choiceId });
    assert.notEqual(passed.result.isError, true, `${label}: ${JSON.stringify(passed.result.structuredContent)}`);
    const result = passed.result.structuredContent as unknown as FileDownloadResult;
    assert.equal(result.files.length, 1, `${label}: ${JSON.stringify(result)}`);
    assert.ok(savedInside(tool.root, result.files[0]?.path), `${label}: the saved file is not on disk`);
    assert.deepEqual(passed.transport, [FILE_ID], `${label}: the file was not fetched over MCP`);

    // At the command, with no terminal, as an agent runs it — asked first, then answered with `--to` and the
    // question's `--choice` (a bare `--to` is a person's at a terminal, and there is none here): exit 0 and the file
    // on disk.
    const command = await downloadHarness();
    await apply(command.harness);
    const askedAt = await downloadAtCommand(command.harness);
    assert.equal(askedAt.exit, 10, `${label}: ${askedAt.stdout}${askedAt.stderr}`);
    const choiceId = String(
      (JSON.parse(askedAt.stdout) as { error: { details: { choiceId: string } } }).error.details.choiceId,
    );
    const ran = await downloadAtCommand(command.harness, ['--to', 'downloads', '--choice', choiceId]);
    assert.equal(ran.exit, EXIT_CODES.OK, `${label}: ${ran.stdout}${ran.stderr}`);
    const data = (JSON.parse(ran.stdout) as { data: FileDownloadResult }).data;
    assert.equal(data.files.length, 1, `${label}: ${ran.stdout}`);
    assert.ok(savedInside(command.root, data.files[0]?.path), `${label}: the saved file is not on disk`);
    assert.deepEqual(ran.transport, [FILE_ID], `${label}: the file was not fetched at the command`);
  }
});

test('the download takes no approval but its own question’s, on either surface', async () => {
  // A download takes no approval but its own question's `choiceId`: `approvalId` on the tool, or `--approval` on the
  // command, is refused before anything runs, and a change's approval passed as the question's id saves nothing.
  const { harness, root } = await downloadHarness();
  const approvalId = await heldApproval(harness);
  updateOut(harness);

  const borrowed = await downloadOverMcp(harness, { saveTo: 'downloads', choiceId: approvalId });
  assert.equal(borrowed.result.isError, true, JSON.stringify(borrowed.result.structuredContent));
  assert.deepEqual(borrowed.transport, [], 'a change’s approval fetched the file');
  assert.equal(asV2(await harness.core.approvals.get(approvalId))?.state, 'pending', 'the change’s approval was spent');

  const tool = await downloadOverMcp(harness, { approvalId });
  assert.equal(code(tool.result), 'USAGE', JSON.stringify(tool.result.structuredContent));
  assert.match(text(tool.result), /does not take `approvalId`/);
  assert.deepEqual([...tool.slack, ...tool.transport], [], 'the claimed approval reached Slack or the transport');

  const command = await downloadAtCommand(harness, ['--approval', approvalId]);
  assert.equal(command.exit, EXIT_CODES.USAGE, `${command.stdout}${command.stderr}`);
  assert.deepEqual([...command.slack, ...command.transport], [], 'the claimed approval reached Slack or the transport');

  assert.deepEqual(saved(root), [], 'something was written under the downloads root');
  assert.equal(await downloadAudits(harness), 0, 'a download was audited');
});

test('agent-slack finishes the update check a command handed on: under its claim, with no notice, and not in help', async () => {
  // The child a command starts for the day's check (#48) is this CLI again, with the hidden command and the claim.
  const harness = await newHarness();
  updateOut(harness);
  // A day old, so every other command would ask first — and, with an update out, say so.
  const stateDir = harness.core.paths.stateDir;
  writeFileSync(updateCheckPath(stateDir), JSON.stringify({ latest: '99.0.0', behind: true }));
  const ambient = tempDir('agent-slack-update-ambient-');
  const command = async (argv: string[]) => {
    let stdout = '';
    const out = new PassThrough();
    out.on('data', (chunk) => {
      stdout += String(chunk);
    });
    const exit = await run(argv, {
      core: harness.core,
      env: {
        ...harness.env,
        AGENT_COMMS_CONFIG_DIR: join(ambient, 'config'),
        AGENT_COMMS_STATE_DIR: join(ambient, 'state'),
        AGENT_COMMS_DATA_DIR: join(ambient, 'data'),
        HOME: join(ambient, 'home'),
        USERPROFILE: join(ambient, 'home'),
      },
      streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
      read: refuseEverything,
    });
    return { exit, stdout };
  };
  const claimedAt = await claimUpdateCheck(harness.core);
  assert.ok(claimedAt !== null);
  const { configDir, stateDir: pinnedState, dataDir, secretsDir, downloadsDir } = harness.core.paths;
  const child = await command([
    '--config-dir',
    configDir,
    '--state-dir',
    pinnedState,
    '--data-dir',
    dataDir,
    '--secrets-dir',
    secretsDir,
    '--downloads-dir',
    downloadsDir,
    UPDATE_CHECK_CHILD_COMMAND,
    claimedAt,
    '--json',
  ]);
  assert.equal(child.exit, 0, child.stdout);
  // The registry here refuses at once: the ask is recorded as the day's, with why, and the claim given up.
  const record = await readUpdateCheck(stateDir);
  assert.deepEqual([record.lastChecked, record.checking], [claimedAt, null]);
  assert.match(String(record.lastError), /could not be reached/);
  assert.doesNotMatch((await command(['--help'])).stdout, new RegExp(UPDATE_CHECK_CHILD_COMMAND));
});
