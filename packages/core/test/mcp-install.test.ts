import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type InstallContext,
  isProductServer,
  type McpProduct,
  managedRuntimeDir,
  managedRuntimeEntry,
  managedRuntimeVersion,
  mcpInstall,
  pinnedVersion,
  pruneManagedRuntimes,
  reusableRuntime,
} from '../src/mcp-install.ts';
import { tempDir } from './helpers/temp.ts';

/**
 * The installer's own facts about where a runtime lives, read back the way the doctors and `prune` read them.
 *
 * Nothing here installs from the registry or starts a client: a runtime is a directory these tests make, and a
 * registration is a config file in a temporary home.
 */

const SLACK = { packageName: '@agentcomms/slack', npxPackage: '@agentcomms/slack' } as const;
const GMAIL = { packageName: '@agentcomms/gmail', npxPackage: '@agentcomms/gmail-mcp' } as const;

function context(dataDir: string, home: string): InstallContext {
  return { env: { HOME: home, PATH: '' }, core: { paths: { dataDir, configDir: join(home, 'config') } } };
}

/** A runtime as `installManagedRuntime` leaves one: the package inside, and a manifest pinning it. */
function makeRuntime(root: string, packageName: string, version: string, pin: string = version): void {
  const packageDir = join(root, 'node_modules', ...packageName.split('/'));
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'dist', 'cli.mjs'), '');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, dependencies: { [packageName]: pin } }));
}

test('a runtime path is read back in both layouts, and only for its own product', () => {
  const data = join('/data', 'agent-communications');
  // The layout the installer writes today, built with its own helper.
  assert.equal(
    managedRuntimeVersion(managedRuntimeEntry(data, GMAIL.packageName, '0.4.1'), GMAIL.packageName),
    '0.4.1',
  );
  // The layout every Gmail install before the move used, still registered on real machines.
  const old = join(data, 'runtime', '0.4.0', 'node_modules', '@agentcomms', 'gmail', 'dist', 'cli.mjs');
  assert.equal(managedRuntimeVersion(old, GMAIL.packageName), '0.4.0');
  // A prerelease keeps its own hyphen; only the product suffix is taken off.
  assert.equal(
    managedRuntimeVersion(managedRuntimeEntry(data, GMAIL.packageName, '0.5.0-rc.1'), GMAIL.packageName),
    '0.5.0-rc.1',
  );
  // Windows separators.
  assert.equal(
    managedRuntimeVersion(
      'C:\\d\\runtime\\0.4.1-slack\\node_modules\\@agentcomms\\slack\\dist\\cli.mjs',
      SLACK.packageName,
    ),
    '0.4.1',
  );
  // Another product's runtime pins nothing for this one.
  assert.equal(managedRuntimeVersion(managedRuntimeEntry(data, SLACK.packageName, '0.4.1'), GMAIL.packageName), null);
  // An npx spec, either package name.
  assert.equal(pinnedVersion('@agentcomms/gmail-mcp@0.4.1', GMAIL), '0.4.1');
  assert.equal(pinnedVersion('@agentcomms/slack@0.4.1', SLACK), '0.4.1');
  assert.equal(pinnedVersion('@agentcomms/slack@0.4.1', GMAIL), null);
});

test('a runtime is reused only when it pins exactly this version and holds exactly this version', async () => {
  const data = tempDir();
  const root = managedRuntimeDir(data, SLACK.packageName, '0.4.1');
  makeRuntime(root, SLACK.packageName, '0.4.1');
  assert.equal(
    await reusableRuntime(data, SLACK.packageName, '0.4.1'),
    managedRuntimeEntry(data, SLACK.packageName, '0.4.1'),
  );

  // Made by hand with a range — the one on the author's machine was `^0.4.0` — is not this installer's runtime.
  makeRuntime(root, SLACK.packageName, '0.4.1', '^0.4.1');
  assert.equal(await reusableRuntime(data, SLACK.packageName, '0.4.1'), null, 'a caret range is not a pin');

  // A pin that says one thing over a package that is another.
  makeRuntime(root, SLACK.packageName, '0.4.2', '0.4.1');
  assert.equal(await reusableRuntime(data, SLACK.packageName, '0.4.1'), null, 'the package inside is another version');
});

test('ownership is decided on whole paths and package names, never on a substring', () => {
  const ask = (args: string[], packageName?: string) =>
    isProductServer({ command: 'node', args, ...(packageName ? { packageName } : {}) }, SLACK);
  assert.equal(ask([managedRuntimeEntry('/d', SLACK.packageName, '0.4.1'), 'mcp']), true);
  assert.equal(ask(['/src/agent-communications/packages/slack/src/cli.ts', 'mcp']), true);
  assert.equal(ask(['-y', '@agentcomms/slack@0.4.1', 'mcp'], '@agentcomms/slack'), true);
  assert.equal(ask(['-y', '@modelcontextprotocol/server-slack'], '@modelcontextprotocol/server-slack'), false);
  assert.equal(ask([managedRuntimeEntry('/d', GMAIL.packageName, '0.4.1'), 'mcp']), false, "Gmail's is not Slack's");
  assert.equal(ask(['/opt/node_modules/@agentcomms/slack-evil/dist/cli.mjs']), false);
  assert.equal(isProductServer({ command: '', args: [] }, SLACK), false, 'a URL entry is nobody we know');
});

test('--print builds the managed entry without installing anything', async () => {
  /*
   * A package that does not exist, so an install attempt fails loudly rather than quietly succeeding from the
   * registry: `--print` used to run the whole `npm install` before looking at whether it was only printing.
   */
  const data = tempDir();
  const home = tempDir();
  const product: McpProduct = {
    packageName: '@agentcomms/no-such-package-for-tests',
    binary: 'agent-test',
    defaultServerName: 'test',
    npxPackage: '@agentcomms/no-such-package-for-tests',
    version: '0.0.1',
    moduleUrl: import.meta.url,
    serverArgs: () => [],
  };
  const result = await mcpInstall(context(data, home), product, { client: 'json', apply: false });
  assert.equal(result.entry.args[0], managedRuntimeEntry(data, product.packageName, '0.0.1'));
  assert.deepEqual(readdirSync(data), [], 'nothing was installed');
  assert.equal(result.verified, false);
  assert.match(result.verifyDetail ?? '', /--print installs nothing/);
});

test('prune removes only unused runtimes of this product, and nothing else in the directory', async () => {
  const data = tempDir();
  const home = tempDir();
  const runtime = join(data, 'runtime');
  const at = (name: string) => join(runtime, name);

  makeRuntime(at('0.0.1-slack'), SLACK.packageName, '0.0.1'); // unused: goes
  makeRuntime(at('0.0.2-slack'), SLACK.packageName, '0.0.2'); // registered: stays
  makeRuntime(at('0.0.3-slack'), SLACK.packageName, '0.0.3'); // running: stays
  makeRuntime(at('0.0.9-slack'), SLACK.packageName, '0.0.9'); // this release: stays
  makeRuntime(at('0.0.1'), GMAIL.packageName, '0.0.1'); // Gmail's, old layout: not ours to touch
  mkdirSync(at('notes'), { recursive: true }); // not a runtime at all
  makeRuntime(at('saved-by-hand'), SLACK.packageName, '0.0.6'); // holds our package, but is not named as a runtime
  writeFileSync(at('0.0.5-slack'), 'a file, not a directory');
  // A link that looks like a runtime and points at something that must survive.
  const outside = tempDir();
  makeRuntime(outside, SLACK.packageName, '0.0.4');
  if (process.platform !== 'win32') symlinkSync(outside, at('0.0.4-slack'), 'dir');

  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { slack: { command: 'node', args: [managedRuntimeEntry(data, SLACK.packageName, '0.0.2'), 'mcp'] } },
    }),
  );
  const running = [`node ${managedRuntimeEntry(data, SLACK.packageName, '0.0.3')} mcp`, 'ps -A -o args='];
  const product = { packageName: SLACK.packageName, version: '0.0.9' };

  // Nothing is removed when the processes cannot be listed: "unused" cannot be shown.
  const blind = await pruneManagedRuntimes(context(data, home), product, { processes: async () => null });
  assert.ok(blind.refused);
  assert.deepEqual(blind.removed, []);

  const dry = await pruneManagedRuntimes(context(data, home), product, {
    dryRun: true,
    processes: async () => running,
  });
  assert.deepEqual(
    dry.removed.map((item) => item.version),
    ['0.0.1'],
  );
  await stat(at('0.0.1-slack'));

  const pruned = await pruneManagedRuntimes(context(data, home), product, { processes: async () => running });
  assert.deepEqual(
    pruned.removed.map((item) => item.path),
    [at('0.0.1-slack')],
  );
  assert.deepEqual(Object.fromEntries(pruned.kept.map((item) => [item.version, item.reason])), {
    '0.0.2': 'registered with claude-code as "slack"',
    '0.0.3': 'a running process uses it',
    '0.0.9': 'this release',
  });
  const left = readdirSync(runtime).sort();
  const expected = ['0.0.1', '0.0.2-slack', '0.0.3-slack', '0.0.5-slack', '0.0.9-slack', 'notes', 'saved-by-hand'];
  if (process.platform !== 'win32') expected.push('0.0.4-slack');
  assert.deepEqual(left, expected.sort());
  await stat(join(outside, 'node_modules', '@agentcomms', 'slack', 'dist', 'cli.mjs'));
});
