import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  CommsError,
  knownClientConfigs,
  listRegisteredServers,
  managedRuntimeEntry,
  type SupportedClient,
} from '@agentcomms/core';
import { SlackContext } from '../src/context.ts';
import { mcpInstall } from '../src/mcp/install.ts';
import { VERSION } from '../src/version.ts';
import { newHarness, tempDir } from './support/harness.ts';

/**
 * `agent-slack mcp install` against every client, with the one thing that went wrong: a server already registered
 * under the same name.
 *
 * `slack` is a generic name, and the reference Slack server is set up with its bot token in exactly that entry's
 * env. The shared installer overwrote it — token and all, no warning, no copy — on every file client without
 * `--force`, on codex because codex itself overwrites, and on Claude Code as soon as somebody followed the hint
 * to pass `--force`. Every test here runs against a temporary home, and the two CLI clients are stand-ins on
 * PATH that record what they were asked to do; nothing touches a real client or a real config.
 */

const NOT_ON_WINDOWS =
  process.platform === 'win32' ? { skip: 'mcp install cannot spawn a .cmd; see install-force.test.ts in gmail' } : {};

/** Somebody else's Slack server, as its README sets it up: a token in the env. */
const THEIRS = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-slack'],
  env: { SLACK_BOT_TOKEN: 'fake-bot-token-1', SLACK_TEAM_ID: 'T0001' },
};

/** Our own older install, at the path the installer writes. */
const OURS = {
  command: 'node',
  args: [managedRuntimeEntry(join('/old', 'data'), '@agentcomms/slack', '0.0.1'), 'mcp'],
  env: { AGENT_COMMS_CONFIG_DIR: '/cfg/previous' },
};

async function setUp() {
  const harness = await newHarness();
  const home = tempDir();
  const bin = tempDir();
  const env = { ...harness.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), PATH: bin };
  const context = new SlackContext({ core: harness.core, env, exchange: (params) => harness.exchange(params) });
  const fileOf = (client: SupportedClient) => {
    const path = knownClientConfigs(env).find((file) => file.client === client)?.path;
    assert.ok(path, `no config file for ${client}`);
    return path;
  };
  return { harness, home, bin, env, context, fileOf };
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

/** A stand-in for `claude` or `codex` that records every call and succeeds. */
async function fakeCli(dir: string, name: 'claude' | 'codex') {
  const log = join(dir, `${name}.log`);
  const path = join(dir, name);
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");`,
    ].join('\n'),
  );
  await chmod(path, 0o755);
  return async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
}

const refusedAsNotOurs = (error: unknown) =>
  error instanceof CommsError && /is not this one/.test(error.message) && /--name/.test(error.hint ?? '');

for (const client of ['cursor', 'gemini', 'claude-desktop', 'vscode'] as const) {
  test(`${client}: somebody else's "slack" entry is never replaced, with or without --force`, async () => {
    const { context, fileOf } = await setUp();
    const file = fileOf(client);
    const key = client === 'vscode' ? 'servers' : 'mcpServers';
    await writeJson(file, { [key]: { slack: THEIRS } });
    const before = await readFile(file, 'utf8');

    for (const force of [false, true]) {
      await assert.rejects(
        mcpInstall(context, { client, launcher: 'local', noVerify: true, force }),
        refusedAsNotOurs,
        `force: ${force}`,
      );
      assert.equal(await readFile(file, 'utf8'), before, `the file was changed (force: ${force})`);
    }
  });
}

test("--print writes nothing, and warns when pasting it would replace somebody else's server", async () => {
  const { context, fileOf } = await setUp();
  await writeJson(fileOf('cursor'), { mcpServers: { slack: THEIRS } });
  const result = await mcpInstall(context, { client: 'cursor', launcher: 'local', apply: false, noVerify: true });
  assert.equal(result.applied, false);
  assert.ok(
    result.warnings.some((warning) => /different server called "slack"/.test(warning)),
    result.warnings.join('\n'),
  );
});

for (const client of ['claude-code', 'codex'] as const) {
  test(
    `${client}: somebody else's "slack" entry is never removed, with or without --force`,
    NOT_ON_WINDOWS,
    async () => {
      const { context, bin, fileOf } = await setUp();
      const calls = await fakeCli(bin, client === 'claude-code' ? 'claude' : 'codex');
      if (client === 'codex') {
        await mkdir(dirname(fileOf('codex')), { recursive: true });
        await writeFile(
          fileOf('codex'),
          [
            '[mcp_servers.slack]',
            'command = "npx"',
            'args = ["-y", "@modelcontextprotocol/server-slack"]',
            '',
            '[mcp_servers.slack.env]',
            'SLACK_BOT_TOKEN = "fake-bot-token-1"',
          ].join('\n'),
        );
      } else {
        await writeJson(fileOf('claude-code'), { mcpServers: { slack: THEIRS } });
      }
      for (const force of [false, true]) {
        await assert.rejects(
          mcpInstall(context, { client, launcher: 'local', noVerify: true, force }),
          refusedAsNotOurs,
          `force: ${force}`,
        );
      }
      // Real codex overwrites an existing entry on `mcp add`, so a refusal left to the client is no refusal.
      assert.deepEqual(await calls(), [], 'the client CLI was never asked to remove or add anything');
    },
  );
}

test('our own entry is replaced only with --force, and is saved owner-only first', async () => {
  const { context, fileOf } = await setUp();
  const file = fileOf('cursor');
  await writeJson(file, { mcpServers: { slack: OURS, other: { command: 'x', args: [] } } });

  await assert.rejects(
    mcpInstall(context, { client: 'cursor', launcher: 'local', noVerify: true }),
    (error: unknown) => error instanceof CommsError && /Pass --force/.test(error.hint ?? ''),
  );
  assert.match(await readFile(file, 'utf8'), /0\.0\.1-slack/, 'refused without --force, and nothing written');

  const result = await mcpInstall(context, { client: 'cursor', launcher: 'local', noVerify: true, force: true });
  assert.equal(result.applied, true);
  const written = JSON.parse(await readFile(file, 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
  assert.doesNotMatch(JSON.stringify(written.mcpServers.slack), /0\.0\.1-slack/, 'replaced');
  assert.ok(written.mcpServers.other, 'and nothing else in the file was touched');

  // The backup: where the result says, owner-only, and holding the entry that was replaced — env included.
  assert.ok(result.backupPath, 'the result says where the old entry went');
  const saved = await readFile(result.backupPath, 'utf8');
  assert.match(saved, /0\.0\.1-slack/);
  assert.match(saved, /\/cfg\/previous/);
  if (process.platform !== 'win32') assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
});

test('codex: --force replaces our own entry by removing it first', NOT_ON_WINDOWS, async () => {
  const { context, bin, fileOf } = await setUp();
  const calls = await fakeCli(bin, 'codex');
  await mkdir(dirname(fileOf('codex')), { recursive: true });
  await writeFile(
    fileOf('codex'),
    ['[mcp_servers.slack]', 'command = "node"', `args = ["${OURS.args[0]}", "mcp"]`].join('\n'),
  );

  await assert.rejects(mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true }), /already has this/);
  assert.deepEqual(await calls(), [], 'nothing was run without --force');

  const result = await mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true, force: true });
  assert.equal(result.applied, true);
  const made = await calls();
  assert.equal(made[0], 'mcp remove slack');
  assert.match(made[1] ?? '', /^mcp add slack /);
});

test('a missing client CLI is reported as not registered, not as done', async () => {
  const { context } = await setUp();
  const result = await mcpInstall(context, { client: 'claude-code', launcher: 'local', noVerify: true });
  assert.equal(result.applied, false);
  assert.match(result.notApplied ?? '', /claude was not found on PATH/);
});

test('--launcher npx keeps the `mcp` command: @agentcomms/slack is the whole CLI', async () => {
  const { harness, context } = await setUp();
  await harness.addWorkspace({ alias: 'acme' });
  const result = await mcpInstall(context, {
    client: 'json',
    launcher: 'npx',
    apply: false,
    noVerify: true,
    workspace: 'acme',
  });
  assert.deepEqual(result.entry.args, ['-y', `@agentcomms/slack@${VERSION}`, 'mcp', '--workspace', 'acme']);
});

test('VS Code gets the shape its user mcp.json documents, and our older entry moves rather than doubling', async () => {
  const { context, fileOf } = await setUp();
  const file = fileOf('vscode');
  // What an earlier version wrote: our entry under `mcpServers`, beside somebody else's.
  await writeJson(file, { mcpServers: { slack: OURS, theirs: { command: 'x', args: [] } } });

  await mcpInstall(context, { client: 'vscode', launcher: 'local', noVerify: true, force: true });
  const written = JSON.parse(await readFile(file, 'utf8')) as {
    servers: Record<string, { type?: string }>;
    mcpServers: Record<string, unknown>;
  };
  assert.equal(written.servers.slack?.type, 'stdio');
  assert.deepEqual(Object.keys(written.mcpServers), ['theirs'], 'ours moved; theirs stayed where it was');
});

test('--client codex --print prints TOML that codex, and our own scanner, read back as the same entry', async () => {
  const { context, env, fileOf } = await setUp();
  const result = await mcpInstall(context, { client: 'codex', launcher: 'local', apply: false, noVerify: true });
  assert.match(result.snippet, /^\[mcp_servers\.slack\]/);
  assert.doesNotMatch(result.snippet, /mcpServers/);

  await mkdir(dirname(fileOf('codex')), { recursive: true });
  await writeFile(fileOf('codex'), result.snippet);
  const [read] = (await listRegisteredServers(env)).filter((server) => server.client === 'codex');
  assert.equal(read?.command, result.entry.command);
  assert.deepEqual(read?.args, result.entry.args);
  assert.deepEqual(read?.env, result.entry.env);
});

test('warnings are about the client being installed, and see a URL-only Slack server', async () => {
  const { context, fileOf } = await setUp();
  await writeJson(fileOf('cursor'), { mcpServers: { official: { url: 'https://mcp.slack.com/mcp' } } });

  const elsewhere = await mcpInstall(context, { client: 'gemini', launcher: 'local', noVerify: true });
  assert.deepEqual(elsewhere.warnings, [], "cursor's servers are not gemini's problem");

  const here = await mcpInstall(context, { client: 'cursor', launcher: 'local', noVerify: true });
  assert.equal(here.warnings.length, 1);
  assert.match(here.warnings[0] ?? '', /"official" in cursor \(https:\/\/mcp\.slack\.com\/mcp\)/);
});
