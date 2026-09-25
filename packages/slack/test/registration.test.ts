import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, managedRuntimeDir, managedRuntimeEntry } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { run } from '../src/cli/program.ts';
import { VERSION } from '../src/version.ts';
import { type Harness, newHarness, tempDir } from './support/harness.ts';

/*
 * Registering the Slack server, and removing its old runtimes, are changes a person approves (design 2026-09-25
 * §3.1), whichever surface asks. `agent-slack mcp install` and `mcp prune` did it with nobody's approval while the core
 * server's `comms_server_install` and `comms_server_prune` asked; they are now the same change. So: the same preview,
 * one approval good on either surface, and nothing written before it is claimed.
 *
 * Nothing here reaches npm, Slack, a real client config or the keychain: every client config is under a temporary
 * home, `npx` is only named in an entry nothing starts (`--no-verify`), and a managed runtime is laid out by hand.
 */

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  envelope: <T>() => Envelope<T>;
}

/** The CLI in-process, as an agent runs it: no terminal, so a change waiting for a person comes back with its id. */
async function cli(harness: Harness, argv: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  err.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await run(argv, {
    core: harness.core,
    env: { ...harness.env, ...env },
    streams: {
      stdout: Object.assign(out, { isTTY: false }),
      stderr: Object.assign(err, { isTTY: false }),
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
    },
    openBrowser: () => undefined,
    probe: (input, init) => harness.probe(input, init),
  });
  return { code, stdout, stderr, envelope: <T>() => JSON.parse(stdout) as Envelope<T> };
}

/** The approval id a command that stopped for approval handed back, and its preview. */
function pending(ran: Ran): { approvalId: string; preview: string; hint: string } {
  assert.equal(ran.code, EXIT_CODES.APPROVAL, `${ran.stdout}${ran.stderr}`);
  const error = ran.envelope().error;
  assert.equal(error?.code, 'APPROVAL_PENDING', ran.stdout);
  return {
    approvalId: String(error?.details?.approvalId),
    preview: String(error?.details?.preview),
    hint: String(error?.hint),
  };
}

/**
 * A harness with one workspace, and a home of its own for the client configs — Windows' too, which are found through
 * `APPDATA` rather than the home.
 */
async function machine(): Promise<{ harness: Harness; home: string; env: NodeJS.ProcessEnv }> {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const home = tempDir();
  return {
    harness,
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
    },
  };
}

/**
 * The core MCP server, started as a client starts it — `agentcomms mcp`, from the core this package is built
 * against — over stdio, with this harness's configuration and home.
 *
 * Its environment is pinned whole. The transport adds `PATH` and `HOME` from the process running the tests — and
 * `APPDATA` on Windows, where a client's config is found through it — unless they are given, so they are: the home is
 * the test's, and `PATH` holds only `ps`, which `prune` needs to see what is running and nothing else it could start.
 */
async function coreServer(harness: Harness, env: NodeJS.ProcessEnv) {
  const coreCli = join(dirname(fileURLToPath(import.meta.resolve('@agentcomms/core'))), 'cli.mjs');
  const bin = tempDir();
  const ps = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path));
  if (ps) symlinkSync(ps, join(bin, 'ps'));
  const serverEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...harness.env,
    ...env,
    PATH: bin,
    AGENT_COMMS_DATA_DIR: harness.core.paths.dataDir,
  })) {
    if (value !== undefined) serverEnv[key] = value;
  }
  const client = new Client({ name: 'registration-test', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [coreCli, 'mcp'], env: serverEnv, stderr: 'ignore' }),
  );
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      },
    close: () => client.close(),
  };
}

const body = (preview: string) => preview.split('\n').slice(1).join('\n');

test('an approval from comms_server_install registers from `agent-slack mcp install --approval`, and the other way round', async () => {
  const { harness, home, env } = await machine();
  // Another Slack server already registered with cursor, which only this package's own product warns about.
  const cursor = join(home, '.cursor', 'mcp.json');
  await mkdir(dirname(cursor), { recursive: true });
  const before = JSON.stringify({ mcpServers: { 'other-slack': { command: 'npx', args: ['-y', 'some-slack-mcp'] } } });
  await writeFile(cursor, before);
  const server = await coreServer(harness, env);
  try {
    // ── Prepared in chat, claimed at the command line ──
    const fromChat = await server.call('comms_server_install', {
      channel: 'slack',
      client: 'cursor',
      launcher: 'npx',
      workspace: 'acme',
      noVerify: true,
    });
    assert.equal(fromChat.isError, undefined, JSON.stringify(fromChat.structuredContent));
    const asked = fromChat.structuredContent as { approvalId: string; preview: string };
    assert.match(asked.preview, /registers the Slack MCP server with cursor as "slack", pinned to the workspace acme/);
    const command = [
      'mcp',
      'install',
      '--client',
      'cursor',
      '--launcher',
      'npx',
      '--workspace',
      'acme',
      '--no-verify',
      '--json',
    ];
    const fromCommand = pending(await cli(harness, command, env));
    assert.equal(body(fromCommand.preview), body(asked.preview), 'the same words from either surface');
    // The command an agent is told to run again carries the pin: without it, it would ask for a wider server.
    assert.match(
      fromCommand.hint,
      new RegExp(
        `agent-slack mcp install --client cursor --workspace acme --launcher npx --no-verify --approval ${fromCommand.approvalId}`,
      ),
    );
    assert.equal(await readFile(cursor, 'utf8'), before, 'nothing is written while it is only asked');

    const claimed = await cli(harness, [...command, '--approval', asked.approvalId], env);
    assert.equal(claimed.code, 0, claimed.stdout);
    const result = claimed.envelope<{ applied: boolean; warnings: string[] }>().data;
    assert.equal(result?.applied, true);
    assert.ok(
      result?.warnings.some((warning) => /"other-slack" in cursor/.test(warning)),
      `the Slack package's own warning: ${JSON.stringify(result?.warnings)}`,
    );
    const written = JSON.parse(await readFile(cursor, 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
    assert.deepEqual(written.mcpServers.slack?.args, [
      '-y',
      `@agentcomms/slack@${VERSION}`,
      'mcp',
      '--workspace',
      'acme',
    ]);

    // ── Prepared at the command line, claimed in chat — with the default launcher, whose runtime is here ──
    const { dataDir } = harness.core.paths;
    const root = managedRuntimeDir(dataDir, '@agentcomms/slack', VERSION);
    const entry = managedRuntimeEntry(dataDir, '@agentcomms/slack', VERSION);
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, '');
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@agentcomms/slack': VERSION } }));
    await writeFile(
      join(root, 'node_modules', '@agentcomms', 'slack', 'package.json'),
      JSON.stringify({ name: '@agentcomms/slack', version: VERSION }),
    );
    const gemini = join(home, '.gemini', 'settings.json');
    const fromTerminal = pending(
      await cli(harness, ['mcp', 'install', '--client', 'gemini', '--no-verify', '--json'], env),
    );
    assert.match(fromTerminal.preview, /registers the Slack MCP server with gemini as "slack"/);
    assert.equal(existsSync(gemini), false);

    const done = await server.call('comms_server_install', {
      channel: 'slack',
      client: 'gemini',
      noVerify: true,
      approvalId: fromTerminal.approvalId,
    });
    assert.equal(done.isError, undefined, JSON.stringify(done.structuredContent));
    assert.equal(done.structuredContent?.applied, true);
    const settings = JSON.parse(await readFile(gemini, 'utf8')) as { mcpServers: { slack: { args: string[] } } };
    assert.deepEqual(settings.mcpServers.slack.args, [entry, 'mcp']);
  } finally {
    await server.close();
  }
});

test('`agent-slack mcp install` asks before it writes; `--print` and `--client json` ask nobody', async () => {
  const { harness, home, env } = await machine();
  const cursor = join(home, '.cursor', 'mcp.json');
  const command = ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--name', 'team-slack', '--no-verify'];

  const asked = await cli(harness, [...command, '--json'], env);
  const { approvalId, preview } = pending(asked);
  assert.match(preview, /registers the Slack MCP server with cursor as "team-slack"/);
  assert.match(preview, /not pinned: it reaches every workspace on this machine/);
  // The command to run again repeats every flag the registration was asked with.
  assert.match(
    String(asked.envelope().error?.hint),
    new RegExp(
      `agent-slack mcp install --client cursor --name team-slack --launcher npx --no-verify --approval ${approvalId}`,
    ),
  );
  assert.equal(existsSync(cursor), false);
  const done = await cli(harness, [...command, '--json', '--approval', approvalId], env);
  assert.equal(done.code, 0, done.stdout);
  assert.ok(existsSync(cursor));

  const other = await machine();
  for (const argv of [
    ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--no-verify', '--print', '--json'],
    ['mcp', 'install', '--client', 'json', '--launcher', 'npx', '--no-verify', '--json'],
  ]) {
    const ran = await cli(other.harness, argv, other.env);
    assert.equal(ran.code, 0, `${argv.join(' ')}: ${ran.stdout}`);
  }
  assert.deepEqual(await other.harness.core.approvals.list(), [], 'no approval was made');
  assert.equal(existsSync(join(other.home, '.cursor', 'mcp.json')), false);
});

test('a server name that could rewrite the preview is refused by `agent-slack mcp install`, before anybody is asked', async () => {
  // Quoted in the sentence the person approves, this name read as a pin the entry would not have.
  const { harness, home, env } = await machine();
  const spoof = 'slack", pinned to the workspace acme, "';
  const ran = await cli(harness, ['mcp', 'install', '--client', 'cursor', '--name', spoof, '--json'], env);
  assert.equal(ran.code, EXIT_CODES.USAGE, ran.stdout);
  assert.match(String(ran.envelope().error?.message), /a server name is 1 to 64 letters/);
  assert.deepEqual(await harness.core.approvals.list(), [], 'nobody was asked');
  assert.equal(existsSync(join(home, '.cursor', 'mcp.json')), false);
});

test('`agent-slack mcp install` and comms_server_install warn about the same other Slack servers', async () => {
  const { harness, home, env } = await machine();
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'old-gmail': { command: 'npx', args: ['-y', '@artymclabin/gmail-mcp'] },
        'team-slack': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
      },
    }),
  );
  const server = await coreServer(harness, env);
  try {
    const command = await cli(
      harness,
      ['mcp', 'install', '--client', 'cursor', '--print', '--no-verify', '--json'],
      env,
    );
    assert.equal(command.code, 0, command.stdout);
    const fromCommand = command.envelope<{ warnings: string[] }>().data?.warnings ?? [];
    const tool = await server.call('comms_server_install', {
      channel: 'slack',
      client: 'cursor',
      print: true,
      noVerify: true,
    });
    assert.equal(tool.isError, undefined, JSON.stringify(tool.structuredContent));
    const fromChat = (tool.structuredContent?.result as { warnings: string[] } | undefined)?.warnings;
    assert.deepEqual(fromChat, fromCommand);
    assert.equal(fromCommand.length, 1, JSON.stringify(fromCommand));
    assert.match(fromCommand[0] ?? '', /"team-slack" in cursor .*can post to Slack with no approval step/);
  } finally {
    await server.close();
  }
});

const NO_PS =
  process.platform === 'win32'
    ? { skip: 'no `ps` on Windows: prune keeps everything when it cannot list processes' }
    : {};

test(
  'an approval to prune from comms_server_prune is claimed by `agent-slack mcp prune --approval`, and the other way round',
  NO_PS,
  async () => {
    const { harness, env } = await machine();
    const { dataDir } = harness.core.paths;
    const runtime = async (version: string) => {
      const dir = managedRuntimeDir(dataDir, '@agentcomms/slack', version);
      await mkdir(join(dir, 'node_modules', '@agentcomms', 'slack'), { recursive: true });
      return dir;
    };
    const server = await coreServer(harness, env);
    try {
      // Prepared in chat, claimed at the command line.
      const first = await runtime('0.0.1');
      const asked = await server.call('comms_server_prune', { channel: 'slack' });
      assert.equal(asked.isError, undefined, JSON.stringify(asked.structuredContent));
      const fromChat = asked.structuredContent as { approvalId: string; preview: string };
      assert.match(fromChat.preview, /deletes the unused Slack runtime 0\.0\.1/);
      const claimed = await cli(harness, ['mcp', 'prune', '--json', '--approval', fromChat.approvalId], env);
      assert.equal(claimed.code, 0, claimed.stdout);
      assert.deepEqual(
        claimed.envelope<{ removed: { path: string }[] }>().data?.removed.map((item) => item.path),
        [first],
      );
      assert.ok(!existsSync(first));

      // Prepared at the command line, claimed in chat.
      const second = await runtime('0.0.2');
      const { approvalId } = pending(await cli(harness, ['mcp', 'prune', '--json'], env));
      assert.ok(existsSync(second), 'asking removed nothing');
      const done = await server.call('comms_server_prune', { channel: 'slack', approvalId });
      assert.equal(done.isError, undefined, JSON.stringify(done.structuredContent));
      assert.deepEqual(
        (done.structuredContent?.result as { removed: { path: string }[] } | undefined)?.removed.map(
          (item) => item.path,
        ),
        [second],
      );
      assert.ok(!existsSync(second));
    } finally {
      await server.close();
    }
  },
);

test(
  '`agent-slack mcp prune`: a dry run is free; removing needs an approval, and removes only what it showed',
  NO_PS,
  async () => {
    const { harness, env } = await machine();
    const { dataDir } = harness.core.paths;
    const runtime = async (version: string) => {
      const dir = managedRuntimeDir(dataDir, '@agentcomms/slack', version);
      await mkdir(join(dir, 'node_modules', '@agentcomms', 'slack'), { recursive: true });
      return dir;
    };
    const old = await runtime('0.0.1');
    const current = await runtime(VERSION);

    const dry = await cli(harness, ['mcp', 'prune', '--dry-run', '--json'], env);
    assert.equal(dry.code, 0, dry.stdout);
    assert.deepEqual(
      dry.envelope<{ removed: { path: string }[] }>().data?.removed.map((item) => item.path),
      [old],
    );
    assert.deepEqual(await harness.core.approvals.list(), [], 'a dry run asks nobody');

    const asked = await cli(harness, ['mcp', 'prune', '--json'], env);
    const { approvalId, preview } = pending(asked);
    assert.match(preview, /deletes the unused Slack runtime 0\.0\.1/);
    assert.match(String(asked.envelope().error?.hint), new RegExp(`agent-slack mcp prune --approval ${approvalId}`));
    assert.ok(existsSync(old), 'asking removed nothing');

    const done = await cli(harness, ['mcp', 'prune', '--json', '--approval', approvalId], env);
    assert.equal(done.code, 0, done.stdout);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(current), 'this release stays');
  },
);
