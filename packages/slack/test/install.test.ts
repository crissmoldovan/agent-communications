import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
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

interface Entry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

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

/**
 * A stand-in for `claude` or `codex` that records every call and succeeds.
 *
 * Codex is asked what it has under a name before anything is written there, so the stand-in answers `mcp get
 * <name> --json` in codex's shape: the entry, or "No MCP server named …" and a failure. `registered` is what it
 * answers from — codex's own view, which need not be anything the config files show. `get` makes that one answer
 * unreadable (`garbage`) or a failure that is not "none" (`broken`).
 */
async function fakeCli(
  dir: string,
  name: 'claude' | 'codex',
  options: { registered?: Record<string, Entry>; get?: 'garbage' | 'broken' } = {},
) {
  const log = join(dir, `${name}.log`);
  const path = join(dir, name);
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const argv = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");`,
      `const registered = ${JSON.stringify(options.registered ?? {})};`,
      `const mode = ${JSON.stringify(options.get ?? 'answer')};`,
      'if (argv[0] === "mcp" && argv[1] === "get") {',
      '  if (mode === "garbage") { process.stdout.write("slack\\n  enabled: true\\n"); process.exit(0); }',
      '  if (mode === "broken") { process.stderr.write("Error: failed to load configuration\\n"); process.exit(1); }',
      '  const entry = registered[argv[2]];',
      '  if (!entry) { process.stderr.write("Error: No MCP server named \'" + argv[2] + "\' found.\\n"); process.exit(1); }',
      '  const transport = { type: "stdio", command: entry.command, args: entry.args, env: entry.env ?? null, env_vars: [], cwd: null };',
      '  process.stdout.write(JSON.stringify({ name: argv[2], enabled: true, transport }, null, 2));',
      '}',
    ].join('\n'),
  );
  await chmod(path, 0o755);
  return async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
}

/** What was asked of a client's CLI that changes something: asking what is registered changes nothing. */
const writesOf = (calls: string[]) => calls.filter((call) => !call.startsWith('mcp get '));

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
  const calls = await fakeCli(bin, 'codex', { registered: { slack: OURS } });
  await mkdir(dirname(fileOf('codex')), { recursive: true });
  await writeFile(
    fileOf('codex'),
    ['[mcp_servers.slack]', 'command = "node"', `args = ["${OURS.args[0]}", "mcp"]`].join('\n'),
  );

  await assert.rejects(mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true }), /already has this/);
  assert.deepEqual(await calls(), [], 'nothing was run without --force');

  const result = await mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true, force: true });
  assert.equal(result.applied, true);
  const made = writesOf(await calls());
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
  assert.match(here.warnings[0] ?? '', /"official" in cursor \(https:\/\/mcp\.slack\.com\)/);
});

test('codex that cannot be started is reported as that, not as codex declining to answer', NOT_ON_WINDOWS, async () => {
  const { context, bin } = await setUp();
  // Found on PATH and executable, but its interpreter does not exist: the spawn itself fails, as `codex.cmd` does
  // on Windows.
  await writeFile(join(bin, 'codex'), '#!/nonexistent/interpreter-for-this-test\n');
  await chmod(join(bin, 'codex'), 0o755);
  await assert.rejects(
    mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.match(error.message, /codex could not be started \(ENOENT\), so nothing was written/);
      assert.doesNotMatch(error.message, /would not say/);
      return true;
    },
  );
});

test(
  'codex: a server codex itself reports under the name is refused, though no file shows it',
  NOT_ON_WINDOWS,
  async () => {
    // Codex's answer is the one that counts: it is what `codex mcp add` would overwrite, token and all.
    const { context, bin } = await setUp();
    const calls = await fakeCli(bin, 'codex', { registered: { slack: THEIRS } });
    for (const force of [false, true]) {
      await assert.rejects(
        mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true, force }),
        refusedAsNotOurs,
        `force: ${force}`,
      );
    }
    assert.deepEqual(writesOf(await calls()), [], 'codex was never asked to remove or add anything');
  },
);

test(
  'codex: our own entry that only codex reports is still ours, and is saved before --force replaces it',
  NOT_ON_WINDOWS,
  async () => {
    const { context, bin } = await setUp();
    const calls = await fakeCli(bin, 'codex', { registered: { slack: OURS } });
    await assert.rejects(
      mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true }),
      /already has this/,
    );
    assert.deepEqual(writesOf(await calls()), []);

    const result = await mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true, force: true });
    assert.deepEqual(
      writesOf(await calls()).map((call) => call.split(' ').slice(0, 3).join(' ')),
      ['mcp remove slack', 'mcp add slack'],
    );
    assert.ok(result.backupPath, 'the entry codex reported was saved first');
    assert.match(await readFile(result.backupPath, 'utf8'), /\/cfg\/previous/);
  },
);

test(
  'codex: an answer that cannot be read, or a codex that cannot answer, writes nothing',
  NOT_ON_WINDOWS,
  async () => {
    for (const get of ['garbage', 'broken'] as const) {
      const { context, bin } = await setUp();
      const calls = await fakeCli(bin, 'codex', { get });
      await assert.rejects(
        mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true, force: true }),
        (error: unknown) => error instanceof CommsError && /nothing was written/.test(error.message),
        get,
      );
      assert.deepEqual(writesOf(await calls()), [], get);
    }
  },
);

test(
  "codex: somebody else's entry in CODEX_HOME, or in an inline [mcp_servers] table, is refused",
  NOT_ON_WINDOWS,
  async () => {
    const inline = [
      '[mcp_servers]',
      'slack = { command = "npx", args = ["-y", "@modelcontextprotocol/server-slack"], env = { SLACK_BOT_TOKEN = "fake-bot-token-1" } }',
    ].join('\n');
    const sectioned = [
      '[mcp_servers.slack]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-slack"]',
    ].join('\n');
    for (const [label, where, text] of [
      ['CODEX_HOME', 'codex-home', sectioned],
      ['inline table', 'default', inline],
    ] as const) {
      const { bin, env, fileOf, harness } = await setUp();
      const codexHome = tempDir();
      const moved = where === 'codex-home' ? { ...env, CODEX_HOME: codexHome } : env;
      const context = new SlackContext({
        core: harness.core,
        env: moved,
        exchange: (params) => harness.exchange(params),
      });
      const file = where === 'codex-home' ? join(codexHome, 'config.toml') : fileOf('codex');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
      // A stand-in that knows nothing, so what is refused is what the file shows.
      const calls = await fakeCli(bin, 'codex');
      for (const force of [false, true]) {
        await assert.rejects(
          mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true, force }),
          refusedAsNotOurs,
          `${label}, force: ${force}`,
        );
      }
      assert.deepEqual(writesOf(await calls()), [], label);
    }
  },
);

test('codex: a config.toml this cannot read is a reason to write nothing', NOT_ON_WINDOWS, async () => {
  const { context, bin, fileOf } = await setUp();
  const calls = await fakeCli(bin, 'codex');
  await mkdir(dirname(fileOf('codex')), { recursive: true });
  await writeFile(fileOf('codex'), '[mcp_servers.slack\ncommand = "npx"\n');
  await assert.rejects(
    mcpInstall(context, { client: 'codex', launcher: 'local', noVerify: true, force: true }),
    (error: unknown) => error instanceof CommsError && error.message.includes(fileOf('codex')),
  );
  assert.deepEqual(writesOf(await calls()), []);
});

test(
  'Claude Code: --force reaches the user-scope copy of an entry that is also at project scope',
  NOT_ON_WINDOWS,
  async () => {
    const { context, bin, fileOf } = await setUp();
    const calls = await fakeCli(bin, 'claude');
    await writeJson(fileOf('claude-code'), {
      mcpServers: { slack: OURS },
      projects: { [tempDir()]: { mcpServers: { slack: OURS } } },
    });
    await mcpInstall(context, { client: 'claude-code', launcher: 'local', noVerify: true, force: true });
    assert.deepEqual(
      (await calls()).map((call) => call.split(' ').slice(0, 3).join(' ')),
      ['mcp remove slack', 'mcp add-json slack'],
    );
  },
);

test('a refusal names another server by where it is, never by what its URL carries', async () => {
  const { context, fileOf } = await setUp();
  const secretUrl = 'https://someone:fake-password-1@mcp.example.net/fake-path-id/sse?key=fake-secret-1#fake-fragment';
  await writeJson(fileOf('cursor'), {
    mcpServers: { slack: { url: secretUrl }, relay: { url: secretUrl.replace('/sse', '/slack') } },
  });
  const refusal = await mcpInstall(context, { client: 'cursor', launcher: 'local', noVerify: true }).then(
    () => assert.fail('not refused'),
    (error: CommsError) => `${error.message} ${error.hint ?? ''}`,
  );
  assert.match(refusal, /https:\/\/mcp\.example\.net\b/);
  const warned = await mcpInstall(context, {
    client: 'cursor',
    name: 'agent-slack',
    launcher: 'local',
    noVerify: true,
  });
  assert.match(warned.warnings.join('\n'), /"relay" in cursor \(https:\/\/mcp\.example\.net\)/);
  for (const text of [refusal, ...warned.warnings]) {
    assert.doesNotMatch(text, /fake-path-id|fake-password-1|fake-secret-1|fake-fragment/, text);
  }
});

test("a refusal's hint keeps the name and the workspace pin it was given", async () => {
  const { harness, context, fileOf } = await setUp();
  await harness.addWorkspace({ alias: 'acme' });
  await writeJson(fileOf('cursor'), { mcpServers: { 'slack-acme': OURS } });
  await assert.rejects(
    mcpInstall(context, { client: 'cursor', name: 'slack-acme', workspace: 'acme', launcher: 'local', noVerify: true }),
    (error: unknown) =>
      error instanceof CommsError &&
      (error.hint ?? '').includes('--name slack-acme') &&
      (error.hint ?? '').includes('--workspace acme') &&
      (error.hint ?? '').includes('--force'),
  );
});

test(
  'a config kept elsewhere and linked into place stays linked, and its directory keeps its mode',
  NOT_ON_WINDOWS,
  async () => {
    const { context, fileOf } = await setUp();
    const link = fileOf('cursor');
    const dotfiles = join(tempDir(), 'cursor-mcp.json');
    await writeFile(dotfiles, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
    await chmod(dotfiles, 0o644);
    await mkdir(dirname(link), { recursive: true });
    await chmod(dirname(link), 0o755);
    await symlink(dotfiles, link);

    const result = await mcpInstall(context, { client: 'cursor', launcher: 'local', noVerify: true });
    assert.equal(result.applied, true);
    assert.ok((await lstat(link)).isSymbolicLink(), 'the link was replaced by a file');
    const written = JSON.parse(await readFile(dotfiles, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(written.mcpServers).sort(), ['other', 'slack'], 'the linked file has the entry');
    assert.equal((await stat(dotfiles)).mode & 0o777, 0o644, 'the file kept its mode');
    assert.equal((await stat(dirname(link))).mode & 0o777, 0o755, "the client's directory kept its mode");
  },
);
