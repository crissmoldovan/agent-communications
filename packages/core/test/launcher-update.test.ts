import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { asV2 } from '../src/approval-stored.ts';
import { gatedChange } from '../src/change-flow.ts';
import type { InboxConfig } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { launcherPaths, readPointer, switchPointer, writeLauncher } from '../src/launcher.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { managedRuntimeDir, managedRuntimeEntry, mcpInstall } from '../src/mcp-install.ts';
import { serverProduct } from '../src/operations/servers.ts';
import {
  type UpdateDeps,
  type UpdateReport,
  type UpdateResult,
  updateChange,
  updateCheck,
  updateCheckFindings,
} from '../src/operations/update.ts';
import { runBackgroundUpdate } from '../src/update-background.ts';
import { readUpdateCheck } from '../src/update-state.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * After the move to the stable launcher (design 2026-10-16, U6), an update installs the latest runtime and switches
 * the launcher's pointer, and edits no client's configuration; the one update that moves a registration onto the
 * launcher is an approved one; and a rollback switches the pointers back, approved too.
 *
 * Nothing here reaches npm or a real client: the registry is a function, a runtime is a directory the test makes —
 * its CLI a stand-in MCP server that answers `initialize` — and the clients are Cursor and VS Code, whose
 * configuration is a file in a temporary home.
 */

process.env.npm_config_offline = 'true';

const OLD = '0.19.0';
const LATEST = '0.20.0';
const NEXT = '0.20.1';
const GMAIL = '@agentcomms/gmail';
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const INBOX: InboxConfig = {
  id: 'ibx_AAAAAAAAAAAAAAAA',
  provider: 'gmail',
  email: 'jo@acme.test',
  identity: 'oidc',
  client: 'desktop',
  tier: 'read',
  contacts: false,
  grantedScopes: [],
  secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
  internalDomains: ['acme.test'],
  createdAt: '2026-09-20T00:00:00.000Z',
};

interface Machine {
  home: string;
  dataDir: string;
  env: Record<string, string>;
  core: Core;
}

function machine(): Machine {
  const home = tempDir('comms-launcher-update-');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, 'config.json'),
    `${JSON.stringify({ version: 2, inboxes: { 'acme/gmail': INBOX } }, null, 2)}\n`,
  );
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: bin,
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    NO_COLOR: '1',
    npm_config_offline: 'true',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  const core = openCore({ env, caller: CORE_CALLER });
  return { home, dataDir: core.paths.dataDir, env, core };
}

/** A Gmail runtime as the installer leaves one: its CLI a stand-in server that answers, or one that exits at once. */
function makeRuntime(m: Machine, version: string, cli: 'server' | 'broken' = 'server'): string {
  const root = managedRuntimeDir(m.dataDir, GMAIL, version);
  const entry = managedRuntimeEntry(m.dataDir, GMAIL, version);
  mkdirSync(dirname(entry), { recursive: true });
  const log = join(root, 'started.log');
  writeFileSync(
    entry,
    cli === 'broken'
      ? 'process.exit(1);\n'
      : [
          "import { appendFileSync } from 'node:fs';",
          "import { createInterface } from 'node:readline';",
          `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
          'createInterface({ input: process.stdin }).on("line", (line) => {',
          '  let message;',
          '  try { message = JSON.parse(line); } catch { return; }',
          '  if (message.id === undefined) return;',
          '  const result = message.method === "initialize"',
          `    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: ${JSON.stringify(version)} } }`,
          '    : { tools: [] };',
          '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
          '});',
          '',
        ].join('\n'),
  );
  writeFileSync(
    join(root, 'node_modules', '@agentcomms', 'gmail', 'package.json'),
    JSON.stringify({
      name: GMAIL,
      version,
      engines: { node: '>=22.12.0' },
      agentcomms: { binary: 'agent-gmail' },
      bin: { 'agent-gmail': './dist/cli.mjs' },
    }),
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, dependencies: { [GMAIL]: version } }));
  return root;
}

/** How often a runtime's stand-in server was started, and with which words. */
function startedWith(m: Machine, version: string): string[][] {
  const log = join(managedRuntimeDir(m.dataDir, GMAIL, version), 'started.log');
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    : [];
}

const cursorConfig = (m: Machine) => join(m.home, '.cursor', 'mcp.json');
const vscodeConfig = (m: Machine) =>
  process.platform === 'darwin'
    ? join(m.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    : process.platform === 'win32'
      ? join(m.home, 'AppData', 'Code', 'User', 'mcp.json')
      : join(m.home, '.config', 'Code', 'User', 'mcp.json');

/** Registers Gmail with Cursor and VS Code through the installer itself, at `version`: entries on the launcher. */
async function registerOnLauncher(m: Machine, version: string): Promise<void> {
  const context = { env: m.env, core: m.core };
  const product = await serverProduct('gmail', 'managed', version);
  for (const client of ['cursor', 'vscode'] as const) {
    const done = await mcpInstall(context, product, { client, inbox: 'acme/gmail', noVerify: true, force: true });
    assert.equal(done.applied, true, `${client}: ${done.notApplied}`);
  }
}

/** A registration as a release before the launcher wrote it: this Node, a versioned runtime's CLI, the pins. */
function versionedEntry(m: Machine, version: string): { command: string; args: string[] } {
  const { configDir, stateDir, dataDir, secretsDir } = m.core.paths;
  return {
    command: process.execPath,
    args: [
      managedRuntimeEntry(m.dataDir, GMAIL, version),
      ...['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir],
      'mcp',
      '--inbox',
      'acme/gmail',
    ],
  };
}

interface Fakes extends UpdateDeps {
  runtimes: string[];
}

function fakes(m: Machine, latest: string, cli: 'server' | 'broken' = 'server'): Fakes {
  const runtimes: string[] = [];
  return {
    runtimes,
    latestVersion: async (packageName: string) => {
      if (packageName.startsWith('@agentcomms/')) return latest;
      throw new Error(`the registry answered 404 for ${packageName}`);
    },
    globalPackages: async () => ({}),
    installGlobal: async () => {
      throw new Error('no global package is installed in these tests');
    },
    installRuntime: async (packageName: string, version: string) => {
      runtimes.push(`${packageName}@${version}`);
      makeRuntime(m, version, cli);
    },
  };
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function connect(m: Machine, update: UpdateDeps = {}) {
  const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null, update });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent as Record<string, unknown>;
  };
  return { call, ok, close: () => Promise.all([client.close(), server.close()]) };
}

/** The preview's steps, as a person reads them. */
const stepsOf = (preview: unknown) =>
  String(preview)
    .slice(String(preview).indexOf('It also:'))
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^ {2}- /, ''));

type Item = Record<string, unknown>;

test('after the move, an update installs the release and switches the launcher, and edits no client config', async () => {
  const m = machine();
  makeRuntime(m, OLD);
  await registerOnLauncher(m, OLD);
  const before = [readFileSync(cursorConfig(m), 'utf8'), readFileSync(vscodeConfig(m), 'utf8')];
  const { launcher } = launcherPaths(m.dataDir, 'gmail');
  const deps = fakes(m, LATEST);
  const { ok, close } = await connect(m, deps);
  try {
    const check = (await ok('comms_update', { check: true })) as unknown as UpdateReport;
    const registrations = check.behind.filter((item) => item.kind === 'registration');
    assert.deepEqual(
      registrations.map((item) => [item.client, item.name, item.version, item.launches, item.updatable]),
      [
        ['cursor', 'gmail', OLD, launcher, true],
        ['vscode', 'gmail', OLD, launcher, true],
      ],
      'each reads at the release its launcher starts, and is updatable without its client',
    );
    assert.deepEqual(check.moves, []);

    const first = await ok('comms_update', {});
    assert.equal(first.approvalRequired, true, 'an update is still a change the person approves');
    assert.deepEqual(stepsOf(first.preview), [
      `installs ${GMAIL}@${LATEST} from npm into ${managedRuntimeDir(m.dataDir, GMAIL, LATEST)}`,
      `switches the Gmail stable launcher ${launcher} from ${OLD} to ${LATEST}; no client configuration is changed`,
      `cursor as "gmail" and vscode as "gmail" start it, and run ${LATEST} once restarted`,
    ]);
    assert.equal(first.summary, 'Update agent-communications to the latest release: 1 launcher, 1 runtime');
    assert.ok(!String(first.preview).includes('…'), 'no step is cut short in the preview');

    const done = await ok('comms_update', { approvalId: first.approvalId });
    const result = done.result as unknown as UpdateResult;
    assert.equal(result.status, 'updated', JSON.stringify(result.steps));
    const pointer = result.steps.find((step) => step.kind === 'pointer');
    assert.equal(pointer?.kind === 'pointer' && pointer.outcome, 'switched');
    assert.equal(pointer?.kind === 'pointer' && pointer.verification, 'passed', 'a registration of it was started');
    assert.deepEqual(
      result.steps.filter((step) => step.kind === 'registration'),
      [],
      'nothing was registered again',
    );
    assert.deepEqual(
      [readFileSync(cursorConfig(m), 'utf8'), readFileSync(vscodeConfig(m), 'utf8')],
      before,
      'no client configuration was edited',
    );
    assert.deepEqual(await readPointer(m.dataDir, 'gmail'), {
      current: managedRuntimeDir(m.dataDir, GMAIL, LATEST),
      previous: managedRuntimeDir(m.dataDir, GMAIL, OLD),
    });
    // Started through the launcher as cursor starts it: the new runtime, with the entry's own words.
    assert.deepEqual(startedWith(m, LATEST).at(-1)?.slice(-3), ['mcp', '--inbox', 'acme/gmail']);
    assert.ok(existsSync(managedRuntimeEntry(m.dataDir, GMAIL, OLD)), 'the runtime it switched from is still there');
    assert.match(String(result.next), /Restart cursor and vscode/);

    // What the daily check records from it: Gmail is current where it is registered, so a server says "restart".
    assert.deepEqual(updateCheckFindings(check, LATEST, result).current.registered, ['gmail']);

    const settled = (await ok('comms_update', { check: true })) as unknown as UpdateReport;
    assert.deepEqual(settled.behind, []);
  } finally {
    await close();
  }
});

test('the one approved update moves a registration naming a versioned runtime onto the launcher, even at the latest release', async () => {
  const m = machine();
  makeRuntime(m, LATEST);
  mkdirSync(dirname(cursorConfig(m)), { recursive: true });
  writeFileSync(cursorConfig(m), `${JSON.stringify({ mcpServers: { gmail: versionedEntry(m, LATEST) } }, null, 2)}\n`);
  const { launcher } = launcherPaths(m.dataDir, 'gmail');
  const { ok, close } = await connect(m, fakes(m, LATEST));
  try {
    const check = (await ok('comms_update', { check: true })) as unknown as UpdateReport;
    assert.deepEqual(check.behind, [], 'nothing is behind');
    assert.deepEqual(
      (check.moves ?? []).map((item) => [item.client, item.name, item.version, item.launches]),
      [['cursor', 'gmail', LATEST, undefined]],
      'but the registration still names a versioned runtime, and is to move',
    );

    const first = await ok('comms_update', { noVerify: true });
    assert.equal(first.approvalRequired, true, 'the move is a change the person approves');
    const steps = stepsOf(first.preview);
    const starts = process.platform === 'win32' ? process.execPath : join('~', 'data', 'launch', 'gmail');
    assert.deepEqual(steps.slice(0, 2), [
      `moves the Gmail MCP server registered with cursor as "gmail" to the stable launcher (user scope), at ${LATEST} as it is — pinned to the mailbox acme/gmail, as now`,
      `the entry goes in ${join('~', '.cursor', 'mcp.json')}, and cursor will start it with ${starts}`,
    ]);
    assert.ok(
      steps.includes(
        "from then on, an update switches that launcher's pointer and leaves this entry in cursor's configuration as it is",
      ),
      steps.join('\n'),
    );
    const done = await ok('comms_update', { noVerify: true, approvalId: first.approvalId });
    assert.equal((done.result as Item).status, 'updated');
    const entry = JSON.parse(readFileSync(cursorConfig(m), 'utf8')).mcpServers.gmail as {
      command: string;
      args: string[];
    };
    assert.equal(
      process.platform === 'win32' ? entry.args[0] : entry.command,
      launcher,
      'the client starts the launcher now',
    );
    assert.deepEqual(entry.args.slice(-3), ['mcp', '--inbox', 'acme/gmail'], 'with exactly the pin it had');
    assert.equal((await readPointer(m.dataDir, 'gmail'))?.current, managedRuntimeDir(m.dataDir, GMAIL, LATEST));
    const moved = (await ok('comms_update', { check: true })) as unknown as UpdateReport;
    assert.deepEqual(moved.moves, [], 'moved once, and not again');
  } finally {
    await close();
  }

  // The next release only switches the launcher: the configuration the move wrote is left as it is.
  const after = readFileSync(cursorConfig(m), 'utf8');
  const next = await connect(m, fakes(m, NEXT));
  try {
    const first = await next.ok('comms_update', { noVerify: true });
    const done = await next.ok('comms_update', { noVerify: true, approvalId: first.approvalId });
    const result = done.result as unknown as UpdateResult;
    assert.deepEqual(
      result.steps.map((step) => [step.kind, step.outcome]),
      [
        ['runtime', 'installed'],
        ['pointer', 'switched'],
      ],
    );
    assert.equal(readFileSync(cursorConfig(m), 'utf8'), after, 'no client configuration was edited');
    assert.equal((await readPointer(m.dataDir, 'gmail'))?.current, managedRuntimeDir(m.dataDir, GMAIL, NEXT));
  } finally {
    await next.close();
  }
});

test('a switch whose release does not start through the launcher is put back, and the update says so', async () => {
  const m = machine();
  makeRuntime(m, OLD);
  await registerOnLauncher(m, OLD);
  const before = readFileSync(cursorConfig(m), 'utf8');
  const { ok, close } = await connect(m, fakes(m, LATEST, 'broken'));
  try {
    const first = await ok('comms_update', {});
    const done = await ok('comms_update', { approvalId: first.approvalId });
    const result = done.result as unknown as UpdateResult;
    assert.equal(result.status, 'failed');
    assert.equal(result.ok, false);
    const pointer = result.steps.find((step) => step.kind === 'pointer');
    assert.equal(pointer?.outcome, 'failed');
    assert.match(String(pointer?.detail), new RegExp(`switched back to ${OLD.replaceAll('.', '\\.')}`));
    assert.deepEqual(await readPointer(m.dataDir, 'gmail'), { current: managedRuntimeDir(m.dataDir, GMAIL, OLD) });
    assert.equal(readFileSync(cursorConfig(m), 'utf8'), before);
  } finally {
    await close();
  }
});

test('rollback: a preview naming each launcher and release, approved, then the switch back — and no client config', async () => {
  const m = machine();
  makeRuntime(m, OLD);
  makeRuntime(m, LATEST);
  await registerOnLauncher(m, OLD);
  await switchPointer(m.dataDir, 'gmail', managedRuntimeDir(m.dataDir, GMAIL, LATEST));
  const before = readFileSync(cursorConfig(m), 'utf8');
  const { launcher } = launcherPaths(m.dataDir, 'gmail');
  const { ok, call, close } = await connect(m);
  try {
    const first = await ok('comms_update', { rollback: true });
    assert.equal(first.approvalRequired, true, 'a rollback is a change the person approves');
    const effect = `switches the Gmail stable launcher ${launcher} back from ${LATEST} to ${OLD}; no client configuration is changed`;
    assert.deepEqual(stepsOf(first.preview), [effect]);
    assert.ok(!String(first.preview).includes('…'), 'no step is cut short in the preview');
    assert.deepEqual(asV2(await m.core.approvals.get(String(first.approvalId)))?.change?.effects, [effect]);
    assert.equal(
      (await readPointer(m.dataDir, 'gmail'))?.current,
      managedRuntimeDir(m.dataDir, GMAIL, LATEST),
      'asking changed nothing',
    );

    const done = await ok('comms_update', { rollback: true, approvalId: first.approvalId });
    const result = done.result as Item;
    assert.equal(result.status, 'rolled-back');
    assert.deepEqual(
      (result.steps as Item[]).map((step) => [step.launcher, step.from, step.to, step.outcome]),
      [[launcher, LATEST, OLD, 'switched']],
    );
    assert.deepEqual(await readPointer(m.dataDir, 'gmail'), {
      current: managedRuntimeDir(m.dataDir, GMAIL, OLD),
      previous: managedRuntimeDir(m.dataDir, GMAIL, LATEST),
    });
    assert.equal(readFileSync(cursorConfig(m), 'utf8'), before, 'no client configuration was edited');
    assert.match(String(result.next), /Restart each MCP client/);

    // Rolling back again goes forward again.
    const again = await ok('comms_update', { rollback: true });
    assert.match(
      stepsOf(again.preview)[0] ?? '',
      new RegExp(`back from ${OLD.replaceAll('.', '\\.')} to ${LATEST.replaceAll('.', '\\.')}`),
    );

    // One at a time: a rollback is not a check, nor an update with or without its checks.
    for (const args of [
      { rollback: true, check: true },
      { rollback: true, noVerify: true },
    ]) {
      const refused = await call('comms_update', args);
      assert.equal(refused.isError, true, JSON.stringify(args));
    }
  } finally {
    await close();
  }
});

test('with no release before to go back to, a rollback changes nothing, asks nobody, and says why', async () => {
  const m = machine();
  const { ok, close } = await connect(m);
  try {
    const none = await ok('comms_update', { rollback: true });
    assert.equal(none.applied, true, 'nothing to approve');
    assert.equal((none.result as Item).status, 'nothing');
    assert.deepEqual((none.result as Item).left, [], 'no launcher here at all');

    makeRuntime(m, OLD);
    await writeLauncher(m.dataDir, 'gmail', process.execPath);
    await switchPointer(m.dataDir, 'gmail', managedRuntimeDir(m.dataDir, GMAIL, OLD));
    const once = await ok('comms_update', { rollback: true });
    assert.equal((once.result as Item).status, 'nothing');
    assert.match(JSON.stringify((once.result as Item).left), /started one release only/);
  } finally {
    await close();
  }
});

test('`agentcomms update --rollback` gives the tool’s preview, claims the approval the tool prepared, and switches back', async () => {
  const m = machine();
  makeRuntime(m, OLD);
  makeRuntime(m, LATEST);
  await writeLauncher(m.dataDir, 'gmail', process.execPath);
  await switchPointer(m.dataDir, 'gmail', managedRuntimeDir(m.dataDir, GMAIL, OLD));
  await switchPointer(m.dataDir, 'gmail', managedRuntimeDir(m.dataDir, GMAIL, LATEST));
  const cli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [...NODE_FLAGS, CLI, ...args], {
        env: { ...m.env, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), CLAUDECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
  const { ok, close } = await connect(m);
  try {
    const asked = await ok('comms_update', { rollback: true });
    const pending = await cli(['update', '--rollback', '--json']);
    assert.equal(pending.status, 10, pending.stderr);
    const error = JSON.parse(pending.stdout.trim().split('\n')[0] ?? '').error as {
      details: { approvalId: string; preview: string };
    };
    const same = (preview: string, id: string) => preview.replaceAll(id, '<id>');
    assert.equal(
      same(error.details.preview, error.details.approvalId),
      same(String(asked.preview), String(asked.approvalId)),
    );

    const done = await cli(['update', '--rollback', '--approval', String(asked.approvalId), '--json']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal((JSON.parse(done.stdout.trim().split('\n')[0] ?? '').data as Item).status, 'rolled-back');
    assert.equal((await readPointer(m.dataDir, 'gmail'))?.current, managedRuntimeDir(m.dataDir, GMAIL, OLD));

    const misuse = await cli(['update', '--rollback', '--check']);
    assert.equal(misuse.status, 64, 'one at a time');
  } finally {
    await close();
  }
});

test('the check records how many registrations still name a versioned runtime, for the notice; the update that moves them leaves none', async () => {
  const m = machine();
  // The check is on here: what it records is what the notice reads (design 2026-10-16, U6 and U1).
  const env = { ...m.env, AGENT_COMMS_UPDATE_CHECK: 'on' };
  makeRuntime(m, LATEST);
  mkdirSync(dirname(cursorConfig(m)), { recursive: true });
  writeFileSync(cursorConfig(m), `${JSON.stringify({ mcpServers: { gmail: versionedEntry(m, LATEST) } }, null, 2)}\n`);
  const report = await updateCheck(m.core, env, fakes(m, LATEST));
  assert.equal((report.moves ?? []).length, 1);
  assert.equal((await readUpdateCheck(m.core.paths.stateDir)).moves, 1);

  const change = updateChange(m.core, env, { noVerify: true }, fakes(m, LATEST));
  const first = await gatedChange(m.core, change, { channel: 'core', surface: 'mcp' });
  assert.equal(first.status, 'approval-required');
  const approvalId = (first as { prepared: { approvalId: string } }).prepared.approvalId;
  const done = await gatedChange(m.core, updateChange(m.core, env, { noVerify: true }, fakes(m, LATEST)), {
    channel: 'core',
    surface: 'mcp',
    approvalId,
  });
  assert.equal(done.status, 'applied');
  assert.equal((await readUpdateCheck(m.core.paths.stateDir)).moves, 0, 'moved, so nothing is left to move');
});

test('while a person’s update is applying, a background run finds the machine busy and asks and installs nothing', async () => {
  const m = machine();
  makeRuntime(m, OLD);
  await registerOnLauncher(m, OLD);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const installing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const deps = fakes(m, LATEST);
  const install = deps.installRuntime;
  deps.installRuntime = async (packageName, version) => {
    reached();
    await gate;
    await install?.(packageName, version);
  };
  const first = await gatedChange(m.core, updateChange(m.core, m.env, { noVerify: true }, deps), {
    channel: 'core',
    surface: 'mcp',
  });
  assert.equal(first.status, 'approval-required');
  const approvalId = (first as { prepared: { approvalId: string } }).prepared.approvalId;
  const person = gatedChange(m.core, updateChange(m.core, m.env, { noVerify: true }, deps), {
    channel: 'core',
    surface: 'mcp',
    approvalId,
  });
  await installing;
  const asked: string[] = [];
  const installed: string[] = [];
  try {
    const busy = await runBackgroundUpdate(
      m.core,
      { ...m.env, AGENT_COMMS_UPDATE_CHECK: 'on' },
      {},
      {
        settings: { level: () => 'auto', pausedUntil: () => undefined, background: () => true },
        registry: async (packageName) => {
          asked.push(packageName);
          throw new Error('a background run that got this far overlapped the person’s update');
        },
        provenance: {
          fetch: async () => {
            throw new Error('no attestation is fetched in this test');
          },
          verifyBundle: async () => undefined,
        },
        install: async (packageName, version) => {
          installed.push(`${packageName}@${version}`);
          return '';
        },
        processes: async () => [],
      },
    );
    assert.equal(busy.outcome, 'busy');
    assert.match(busy.reason, /under way/);
    assert.deepEqual(asked, []);
    assert.deepEqual(installed, []);
  } finally {
    release();
  }
  assert.equal((await person).status, 'applied');
  assert.equal((await readPointer(m.dataDir, 'gmail'))?.current, managedRuntimeDir(m.dataDir, GMAIL, LATEST));
});
