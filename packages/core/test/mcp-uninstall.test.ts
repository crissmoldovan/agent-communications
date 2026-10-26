import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { gatedChange } from '../src/change-flow.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { type ServerUninstallResult, serverUninstallChange } from '../src/operations/servers.ts';
import { runMain } from './helpers/main-in-process.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * 0.32.0, Task E (design 2026-10-26-owner-feedback-0320 §3.3, §4): `mcp uninstall --client <c> --server <s>` and
 * comms_server_uninstall take one server out of one client's configuration — a tightening, applied at once with no
 * approval. Every test writes its client configurations in a temporary home, and its `claude` is a stand-in script:
 * no real client configuration is read or written, and no real client runs.
 */

const NOT_ON_WINDOWS = process.platform === 'win32' ? { skip: 'the stand-in `claude` is a POSIX script' } : {};

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
}

function machine(): Machine {
  const home = tempDir('comms-uninstall-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  mkdirSync(join(home, 'bin'));
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { home, env, core: openCore({ env, caller: CORE_CALLER }) };
}

/** Cursor's servers: two of Gmail's (by its command, and by its npx package), Slack's, and somebody else's. */
function cursorConfig(home: string): string {
  const path = join(home, '.cursor', 'mcp.json');
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        mcpServers: {
          gmail: {
            command: 'agent-gmail',
            args: ['mcp'],
            env: { AGENT_COMMS_CONFIG_DIR: '/example/home/.config/agentcomms' },
          },
          'gmail-work': { command: 'npx', args: ['-y', '@agentcomms/gmail@0.31.0', 'mcp', '--inbox', 'work'] },
          slack: { command: 'agent-slack', args: ['mcp'] },
          notes: { command: 'node', args: ['/example/home/notes-server.js'] },
        },
        theme: 'dark',
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

async function uninstall(m: Machine, channel: string, client: string): Promise<ServerUninstallResult> {
  const outcome = await gatedChange(
    m.core,
    serverUninstallChange(m.core, m.env, { channel, client } as Parameters<typeof serverUninstallChange>[2], 'cli'),
    { surface: 'cli', channel: 'core' },
  );
  assert.equal(outcome.status, 'applied', 'a tightening applies at once, asking nobody');
  return (outcome as { result: ServerUninstallResult }).result;
}

test('one server comes out of one JSON client: every entry of it, and nothing else in the file', async () => {
  const m = machine();
  const path = cursorConfig(m.home);
  const result = await uninstall(m, 'gmail', 'cursor');
  assert.deepEqual(
    result.removed.map((entry) => [entry.name, entry.path]),
    [
      ['gmail', path],
      ['gmail-work', path],
    ],
  );
  assert.deepEqual(result.kept, []);
  const after = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, unknown>; theme: string };
  assert.deepEqual(Object.keys(after.mcpServers).sort(), ['notes', 'slack']);
  assert.equal(after.theme, 'dark');
  assert.match(result.restart, /cursor/);
  // What was removed is kept, owner-only — an entry's env can hold a credential — to put back by hand.
  assert.ok(result.backupPath !== undefined && existsSync(result.backupPath));
  const saved = JSON.parse(readFileSync(result.backupPath, 'utf8')) as { entries: { name: string }[] };
  assert.deepEqual(
    saved.entries.map((entry) => entry.name),
    ['gmail', 'gmail-work'],
  );
  if (process.platform !== 'win32') assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
  // It is a change, and the audit log says it was made.
  const audit = await m.core.audit.tail({});
  assert.ok(audit.some((record) => record.operation === 'mcp.uninstall' && record.outcome === 'ok'));
});

test('a client with none of that server registered: nothing removed, nothing written, and said', async () => {
  const m = machine();
  const path = cursorConfig(m.home);
  const before = readFileSync(path, 'utf8');
  const result = await uninstall(m, 'resend', 'cursor');
  assert.deepEqual(result.removed, []);
  assert.equal(result.backupPath, undefined);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a file with comments is left as it was, and the entry is named to remove by hand', async () => {
  const m = machine();
  const path = join(m.home, '.gemini', 'settings.json');
  mkdirSync(join(m.home, '.gemini'));
  const text =
    '{\n  // the person’s own note\n  "mcpServers": { "gmail": { "command": "agent-gmail", "args": ["mcp"] } }\n}\n';
  writeFileSync(path, text);
  const result = await uninstall(m, 'gmail', 'gemini');
  assert.deepEqual(result.removed, []);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]?.name, 'gmail');
  assert.match(result.kept[0]?.reason ?? '', /not plain JSON/);
  assert.equal(readFileSync(path, 'utf8'), text);
});

/** A stand-in for `claude` that keeps its servers in `config` and writes each command it was given to `log`. */
function fakeClaude(bin: string, config: string, log: string): void {
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `const config = ${JSON.stringify(config)};`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'const [, sub, name] = process.argv.slice(2);',
    'if (sub === "remove") {',
    '  const current = JSON.parse(fs.readFileSync(config, "utf8"));',
    '  delete current.mcpServers[name];',
    '  fs.writeFileSync(config, JSON.stringify(current));',
    '}',
  ].join('\n');
  writeFileSync(join(bin, 'claude'), script, { mode: 0o755 });
}

test(
  'Claude Code: removed with its own command at user scope; a project’s own entry is left, and said',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const config = join(m.home, '.claude.json');
    const project = join(m.home, 'work', 'acme');
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          gmail: { command: 'agent-gmail', args: ['mcp'] },
          slack: { command: 'agent-slack', args: ['mcp'] },
        },
        projects: { [project]: { mcpServers: { 'gmail-acme': { command: 'agent-gmail', args: ['mcp'] } } } },
      }),
    );
    const log = join(m.home, 'claude-calls.jsonl');
    fakeClaude(join(m.home, 'bin'), config, log);
    const result = await uninstall(m, 'gmail', 'claude-code');
    assert.deepEqual(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [['mcp', 'remove', 'gmail', '--scope', 'user']],
    );
    assert.deepEqual(
      result.removed.map((entry) => entry.name),
      ['gmail'],
    );
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0]?.name, 'gmail-acme');
    assert.match(result.kept[0]?.reason ?? '', /project/);
    const after = JSON.parse(readFileSync(config, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(after.mcpServers), ['slack']);
  },
);

test('Claude Code with no claude command: nothing removed, and the command to run named', async () => {
  const m = machine();
  writeFileSync(
    join(m.home, '.claude.json'),
    JSON.stringify({ mcpServers: { gmail: { command: 'agent-gmail', args: ['mcp'] } } }),
  );
  const result = await uninstall(m, 'gmail', 'claude-code');
  assert.deepEqual(result.removed, []);
  assert.equal(result.kept[0]?.name, 'gmail');
  assert.match(result.kept[0]?.reason ?? '', /claude was not found/);
  assert.match(result.kept[0]?.reason ?? '', /mcp remove gmail/);
});

// ── The command and the tool ───────────────────────────────────────────────────────────────────────────────────

test('mcp uninstall applies at once at a terminal, takes no approval, and names its client and server', async () => {
  const m = machine();
  const path = cursorConfig(m.home);
  const run = await runMain(
    ['mcp', 'uninstall', '--client', 'cursor', '--server', 'gmail', '--json'],
    m.env,
    process.platform,
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const data = (run.json() as { data: ServerUninstallResult }).data;
  assert.deepEqual(
    data.removed.map((entry) => entry.name),
    ['gmail', 'gmail-work'],
  );
  assert.deepEqual(Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: object }).mcpServers).sort(), [
    'notes',
    'slack',
  ]);

  for (const argv of [
    ['mcp', 'uninstall', '--client', 'cursor', '--server', 'slack', '--approval', 'appr_fake-0001'],
    ['mcp', 'uninstall', '--client', 'cursor'],
    ['mcp', 'uninstall', '--server', 'slack'],
    ['mcp', 'uninstall', '--client', 'json', '--server', 'slack'],
    ['mcp', 'uninstall', '--client', 'cursor', '--server', 'nobody'],
    ['mcp', 'uninstall', '--client', 'cursor', '--server', 'slack', '--name', 'slack'],
  ]) {
    const refused = await runMain([...argv, '--json'], m.env, process.platform);
    assert.equal(refused.code, 64, `${argv.join(' ')}: ${refused.stdout}`);
  }
  // None of the refused calls touched Slack's entry.
  assert.ok('slack' in (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: object }).mcpServers);
});

test('comms_server_uninstall is the same change from a chat: applied at once, with no approvalId to take', async () => {
  const m = machine();
  const path = cursorConfig(m.home);
  const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((each) => each.name === 'comms_server_uninstall');
    assert.ok(tool);
    assert.equal('approvalId' in (tool.inputSchema.properties ?? {}), false);
    const result = (await client.callTool({
      name: 'comms_server_uninstall',
      arguments: { channel: 'slack', client: 'cursor' },
    })) as { isError?: boolean; structuredContent?: { applied: boolean; result: ServerUninstallResult } };
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent?.applied, true);
    assert.deepEqual(
      result.structuredContent?.result.removed.map((entry) => entry.name),
      ['slack'],
    );
    assert.deepEqual(
      Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: object }).mcpServers).sort(),
      ['gmail', 'gmail-work', 'notes'],
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
