import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { launcherPaths, readPointer, switchPointer } from '../src/launcher.ts';
import { managedShimsSupported } from '../src/managed-shims.ts';
import {
  type InstallContext,
  isProductServer,
  type McpProduct,
  managedRuntimeDir,
  managedRuntimeEntry,
  mcpInstall,
  missingEntryFile,
  pruneManagedRuntimes,
} from '../src/mcp-install.ts';
import { withManagedShim } from '../src/operations/servers.ts';
import { launcherOf, registrationFiles, registrationVersion, startsProduct } from '../src/registrations.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * A managed install registers the stable launcher, never a versioned runtime (design 2026-10-16, U6): the entry a
 * client starts is `<data>/launch/<name>` with the suite's pins, the shim on PATH starts the same launcher, and the
 * install points the launcher at its release. A runtime here is a directory the test makes; a client is Cursor, whose
 * configuration is a file in a temporary home.
 */

const POSIX_SHIMS = managedShimsSupported()
  ? {}
  : { skip: 'WINDOWS_SKIP: managed CLI shims are offered on macOS and Linux only' };

function context(dataDir: string, home: string, platform?: NodeJS.Platform): InstallContext {
  return {
    env: { HOME: home, USERPROFILE: home, PATH: '', AGENT_COMMS_CLIENT_CLI_DIRS: '' },
    core: {
      paths: {
        configDir: join(home, 'config'),
        stateDir: join(home, 'state'),
        dataDir,
        secretsDir: join(home, 'secrets'),
      },
    },
    ...(platform === undefined ? {} : { platform }),
  };
}

function pins(context: InstallContext): string[] {
  const { configDir, stateDir, dataDir, secretsDir } = context.core.paths;
  return ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir];
}

function product(version: string): McpProduct {
  return {
    packageName: '@agentcomms/example',
    binary: 'agent-example',
    defaultServerName: 'example',
    npxPackage: '@agentcomms/example',
    version,
    moduleUrl: import.meta.url,
    serverArgs: (options) => (options.inbox ? ['--inbox', options.inbox] : []),
    narrowingOf: (args) => (args.includes('--inbox') ? { inbox: args[args.indexOf('--inbox') + 1] } : {}),
  };
}

const MCP_STAND_IN = (version: string) =>
  [
    "import { createInterface } from 'node:readline';",
    'if (process.argv.includes("--print-version")) { process.stdout.write(' +
      JSON.stringify(version) +
      '); process.exit(0); }',
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
  ].join('\n');

/** A runtime as the installer leaves one; its CLI a stand-in server that answers, or one that exits at once. */
function makeRuntime(data: string, version: string, cli: 'server' | 'broken' = 'server'): string {
  const packageName = '@agentcomms/example';
  const root = managedRuntimeDir(data, packageName, version);
  const packageDir = join(root, 'node_modules', '@agentcomms', 'example');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'dist', 'cli.mjs'), cli === 'server' ? MCP_STAND_IN(version) : 'process.exit(1);\n');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      engines: { node: '>=22.12.0' },
      agentcomms: { binary: 'agent-example' },
      bin: { 'agent-example': './dist/cli.mjs' },
    }),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, dependencies: { [packageName]: version } }),
  );
  return root;
}

function cursorEntry(home: string): { command: string; args: string[] } {
  return JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.example;
}

test('a managed install registers the stable launcher, and an install of the next release leaves the entry as it was', async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home);
  makeRuntime(data, '0.19.0');
  makeRuntime(data, '0.20.0');
  const { launcher } = launcherPaths(data, 'example');

  const first = await mcpInstall(installing, product('0.19.0'), { client: 'cursor', inbox: 'acme/gmail' });
  assert.equal(first.applied, true);
  assert.equal(first.verification, 'passed', first.verifyDetail);
  const words = [...pins(installing), 'mcp', '--inbox', 'acme/gmail'];
  const expected =
    process.platform === 'win32'
      ? { command: process.execPath, args: [launcher, ...words] }
      : { command: launcher, args: words };
  assert.deepEqual({ command: first.entry.command, args: first.entry.args }, expected);
  assert.ok(
    !JSON.stringify(cursorEntry(home)).includes(join('runtime', '0.19.0-example')),
    'the client starts no versioned runtime',
  );
  assert.deepEqual(await readPointer(data, 'example'), {
    current: managedRuntimeDir(data, '@agentcomms/example', '0.19.0'),
  });

  const config = readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8');
  const second = await mcpInstall(installing, product('0.20.0'), { client: 'cursor', force: true });
  assert.equal(second.verification, 'passed', second.verifyDetail);
  assert.equal(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'), config, 'the entry did not change');
  assert.deepEqual(await readPointer(data, 'example'), {
    current: managedRuntimeDir(data, '@agentcomms/example', '0.20.0'),
    previous: managedRuntimeDir(data, '@agentcomms/example', '0.19.0'),
  });
});

test('a Windows managed entry starts Node with the launcher as its first word: no script is started without it', async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home, 'win32');
  makeRuntime(data, '0.20.0');
  const result = await mcpInstall(installing, product('0.20.0'), { client: 'cursor', noVerify: true });
  assert.equal(result.entry.command, process.execPath);
  assert.deepEqual(result.entry.args, [launcherPaths(data, 'example').launcher, ...pins(installing), 'mcp']);
  // The Windows launcher is a script for Node, which it runs in the same process: started as the client would.
  const ran = spawnSync(result.entry.command, [...result.entry.args.slice(0, 1), '--print-version'], {
    encoding: 'utf8',
  });
  assert.equal(ran.stdout, '0.20.0', ran.stderr);
});

test('an install whose entry does not start puts the launcher back on the runtime it started before', async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home);
  const working = makeRuntime(data, '0.19.0');
  makeRuntime(data, '0.20.0', 'broken');
  await mcpInstall(installing, product('0.19.0'), { client: 'cursor', noVerify: true });
  const failed = await mcpInstall(installing, product('0.20.0'), { client: 'cursor', force: true });
  assert.equal(failed.verification, 'failed');
  assert.match(failed.verifyDetail ?? '', /pointed back at/);
  assert.equal((await readPointer(data, 'example'))?.current, working, 'every other client keeps starting 0.19.0');
});

test('a managed shim starts the stable launcher, and so follows its pointer', POSIX_SHIMS, async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home);
  makeRuntime(data, '0.19.0');
  makeRuntime(data, '0.20.0');
  const result = await withManagedShim(
    installing,
    product('0.19.0'),
    await mcpInstall(installing, product('0.19.0'), { client: 'cursor', noVerify: true }),
  );
  assert.equal(result.shim?.status, 'created', result.shimFailure);
  const shim = result.shim?.path ?? '';
  const { launcher } = launcherPaths(data, 'example');
  assert.equal(readFileSync(shim, 'utf8').split('\n')[2], `exec '${launcher}' "$@"`);
  const run = () => spawnSync(shim, ['--print-version'], { encoding: 'utf8' }).stdout;
  assert.equal(run(), '0.19.0');
  await switchPointer(data, 'example', managedRuntimeDir(data, '@agentcomms/example', '0.20.0'));
  assert.equal(run(), '0.20.0', 'an update that switches the pointer moves the command too, rewriting nothing');
});

test('a launcher registration is read as its product’s, at the release its pointer names, and nobody else’s', async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home);
  makeRuntime(data, '0.20.0');
  const { entry } = await mcpInstall(installing, product('0.20.0'), { client: 'cursor', noVerify: true });
  const facts = { packageName: '@agentcomms/example', npxPackage: '@agentcomms/example', binary: 'agent-example' };
  const slack = { packageName: '@agentcomms/slack', npxPackage: '@agentcomms/slack', binary: 'agent-slack' };
  assert.equal(isProductServer(entry, facts), true);
  assert.equal(isProductServer(entry, slack), false);
  assert.equal(startsProduct(entry, facts), true, 'with its path pins taken out of its words, too');
  assert.equal(startsProduct(entry, slack), false);
  assert.equal(launcherOf(entry, facts), 'managed');
  assert.equal(registrationVersion(entry, facts), '0.20.0');
  assert.deepEqual(registrationFiles(entry, facts), {
    scripts: [managedRuntimeEntry(data, '@agentcomms/example', '0.20.0')],
    command: null,
  });
  assert.equal(await missingEntryFile(entry), null);
  // The same program pinned to another data directory is not a launcher at all, and not ours.
  const elsewhere = { ...entry, args: entry.args.map((word) => (word === data ? tempDir() : word)) };
  assert.equal(isProductServer(elsewhere, facts), false);
});

test('an in-use runtime is never deleted: prune keeps what the launcher starts and what it falls back to', async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home);
  const old = makeRuntime(data, '0.18.0');
  const previous = makeRuntime(data, '0.19.0');
  const current = makeRuntime(data, '0.20.0');
  const running = makeRuntime(data, '0.17.0');
  await mcpInstall(installing, product('0.19.0'), { client: 'cursor', noVerify: true });
  await mcpInstall(installing, product('0.20.0'), { client: 'cursor', noVerify: true, force: true });
  // Neither the client's entry nor this release names a runtime: only the launcher's pointer does.
  const result = await pruneManagedRuntimes(
    installing,
    { packageName: '@agentcomms/example', version: '9.9.9' },
    {
      processes: async () => [`node ${managedRuntimeEntry(data, '@agentcomms/example', '0.17.0')} mcp`],
    },
  );
  assert.deepEqual(
    result.removed.map((item) => item.version),
    ['0.18.0'],
  );
  assert.deepEqual(Object.fromEntries(result.kept.map((item) => [item.version, item.reason])), {
    '0.17.0': 'a running process uses it',
    '0.19.0': "the stable launcher's previous runtime: what it falls back to, and what a rollback goes back to",
    '0.20.0': 'the stable launcher starts it',
  });
  assert.equal(existsSync(old), false);
  for (const kept of [previous, current, running]) assert.ok(existsSync(kept), kept);

  // A pointer that cannot be read keeps everything.
  writeFileSync(launcherPaths(data, 'example').pointer, 'current=somewhere-else\n');
  const blind = await pruneManagedRuntimes(
    installing,
    { packageName: '@agentcomms/example', version: '9.9.9' },
    {
      processes: async () => [],
    },
  );
  assert.deepEqual(blind.removed, []);
  assert.match(blind.refused ?? '', /could not be read/);
});
