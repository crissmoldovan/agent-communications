import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CHANNEL_SERVERS, serverFacts } from '../src/channel-servers.ts';
import { locateCliCommand } from '../src/cli-command.ts';
import { ERROR_REGISTRY, EXIT_CODES } from '../src/errors.ts';
import { handoffSentence } from '../src/handoffs.ts';
import { managedShimsSupported, writeManagedShim } from '../src/managed-shims.ts';
import { knownClientConfigs } from '../src/mcp-clients.ts';
import {
  clientCliDirectories,
  handedOutRuntimesPath,
  type InstallContext,
  type InstallRemedy,
  installExitStatus,
  installFailure,
  installRemedyOf,
  installTarget,
  isProductServer,
  listManagedRuntimes,
  type McpProduct,
  managedRuntimeDir,
  managedRuntimeEntry,
  managedRuntimeVersion,
  mcpInstall,
  pinnedVersion,
  preflightInstall,
  pruneManagedRuntimes,
  reusableRuntime,
  runningCommandLines,
  whichExecutable,
} from '../src/mcp-install.ts';
import { withManagedShim } from '../src/operations/servers.ts';
import { resolvePaths } from '../src/paths.ts';
import { renderInstall } from '../src/render.ts';
import { coreHandoffs } from './helpers/handoffs.ts';
import { tempDir } from './helpers/temp.ts';

/**
 * The installer's own facts about where a runtime lives, read back the way the doctors and `prune` read them.
 *
 * Nothing here installs from the registry or starts a client: a runtime is a directory these tests make, and a
 * registration is a config file in a temporary home.
 */

const SLACK = { packageName: '@agentcomms/slack', npxPackage: '@agentcomms/slack', binary: 'agent-slack' } as const;
const GMAIL = {
  packageName: '@agentcomms/gmail',
  npxPackage: '@agentcomms/gmail-mcp',
  binary: 'agent-gmail',
  bins: ['agent-gmail-mcp'],
} as const;

function context(dataDir: string, home: string): InstallContext {
  // No client command beyond PATH but in this home: a real `claude` or `codex` elsewhere is never found, nor run.
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
  };
}

function registrationPins(context: InstallContext): string[] {
  const { configDir, stateDir, dataDir, secretsDir } = context.core.paths;
  return ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir];
}

test('managed and local entries pin all four suite roots before mcp, without a downloads pin or config env', async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home);
  const product = pinnedProduct();
  const managed = await mcpInstall(installing, product, { client: 'json', apply: false, noVerify: true });
  assert.deepEqual(managed.entry.args, [
    managedRuntimeEntry(data, product.packageName, product.version),
    ...registrationPins(installing),
    'mcp',
  ]);
  assert.equal(managed.entry.env.AGENT_COMMS_CONFIG_DIR, undefined);
  assert.ok(!managed.entry.args.includes('--downloads-dir'));

  const checkout = tempDir();
  writeFileSync(join(checkout, 'cli.mjs'), '');
  const local = await mcpInstall(
    installing,
    { ...product, moduleUrl: pathToFileURL(join(checkout, 'module.mjs')).href },
    { client: 'json', launcher: 'local', apply: false, noVerify: true },
  );
  assert.deepEqual(local.entry.args, [join(checkout, 'cli.mjs'), ...registrationPins(installing), 'mcp']);
  assert.equal(local.entry.env.AGENT_COMMS_CONFIG_DIR, undefined);
  assert.ok(!local.entry.args.includes('--downloads-dir'));
});

/**
 * The events service's own declaration and bin, read from its package: a runtime that made up an `agentcomms` field
 * for it hid a locator that could not read the service's real `agentcommsPackage` one.
 */
const EVENTS_MANIFEST = JSON.parse(
  readFileSync(new URL('../../events-daemon/package.json', import.meta.url), 'utf8'),
) as { agentcommsPackage: unknown; bin: Record<string, string> };

/** A runtime as `installManagedRuntime` leaves one: the package inside, and a manifest pinning it. */
function makeRuntime(root: string, packageName: string, version: string, pin: string = version): void {
  const packageDir = join(root, 'node_modules', ...packageName.split('/'));
  const unscoped = packageName.split('/').at(-1) ?? packageName;
  const binary = unscoped === 'core' ? 'agentcomms' : `agent-${unscoped}`;
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'dist', 'cli.mjs'), '');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      engines: { node: '>=22.12.0' },
      ...(unscoped === 'events-daemon'
        ? { agentcommsPackage: EVENTS_MANIFEST.agentcommsPackage, bin: EVENTS_MANIFEST.bin }
        : { agentcomms: { binary }, bin: { [binary]: './dist/cli.mjs' } }),
    }),
  );
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
    narrowingOf: () => ({}),
  };
  const result = await mcpInstall(context(data, home), product, { client: 'json', apply: false });
  assert.equal(result.entry.args[0], managedRuntimeEntry(data, product.packageName, '0.0.1'));
  // Only the record of what was handed out, which `prune` reads: no runtime.
  assert.deepEqual(readdirSync(data), [basename(handedOutRuntimesPath(data))], 'nothing was installed');
  assert.equal(result.verified, false);
  assert.match(result.verifyDetail ?? '', /--print installs nothing/);
});

/** Managed CLI shims are POSIX-only: on Windows the install writes none, which its own test below shows. */
const POSIX_SHIMS =
  process.platform === 'win32' ? { skip: 'WINDOWS_SKIP: managed CLI shims are offered on macOS and Linux only' } : {};

test(
  'an applied managed install writes its CLI shim and reports PATH without touching a profile',
  POSIX_SHIMS,
  async () => {
    const data = tempDir();
    const home = tempDir();
    const installing = context(data, home);
    const product = pinnedProduct();
    makeRuntime(managedRuntimeDir(data, product.packageName, product.version), product.packageName, product.version);

    const result = await withManagedShim(
      installing,
      product,
      await mcpInstall(installing, product, { client: 'cursor', noVerify: true }),
    );
    const shim = result.shim;
    assert.equal(result.applied, true, 'the temporary Cursor config was registered');
    assert.equal(shim?.status, 'created', 'the applied managed install creates its package CLI shim');
    assert.equal(
      shim?.path,
      join(home, '.local', 'bin', product.binary),
      'the install reports the user-local shim path',
    );
    assert.equal(shim?.onPath, false, 'the fixture keeps the shim directory off PATH');
    assert.match(shim?.pathNotice ?? '', /export PATH=/, 'the install result explains how to add it for this shell');
    assert.match(shim?.pathNotice ?? '', /No shell profile was edited/, 'the install result promises no profile edit');

    const printed = await mcpInstall(installing, product, {
      client: 'json',
      apply: false,
      noVerify: true,
    });
    assert.equal(
      printed.shim,
      undefined,
      'the installer writes no shim of its own: the operation does, and not for --print',
    );
  },
);

test('a managed events install writes its agent-events shim from the service declaration', POSIX_SHIMS, async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home);
  const product: McpProduct = { ...serverFacts('events'), version: '0.0.1', moduleUrl: '' };
  makeRuntime(managedRuntimeDir(data, product.packageName, product.version), product.packageName, product.version);

  const result = await withManagedShim(
    installing,
    product,
    await mcpInstall(installing, product, { client: 'cursor', noVerify: true }),
  );
  assert.equal(result.shimFailure, undefined, 'the locator reads the service declaration, so the shim can be written');
  assert.equal(result.shim?.status, 'created', 'the events service gets its CLI shim');
  assert.equal(result.shim?.path, join(home, '.local', 'bin', 'agent-events'), 'named for the binary it declares');
  assert.match(
    readFileSync(result.shim?.path ?? '', 'utf8'),
    new RegExp(managedRuntimeEntry(data, product.packageName, product.version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'and it starts the CLI of the events runtime the entry starts',
  );
});

test(
  'a managed shim executes exactly the program and entry resolved by the CLI locator',
  process.platform === 'win32'
    ? { skip: 'WINDOWS_SKIP: this test creates a POSIX PATH executable and shell shim' }
    : {},
  async () => {
    const data = tempDir();
    const home = tempDir();
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const pathNode = join(bin, 'node');
    writeFileSync(pathNode, `#!${process.execPath}\nprocess.exit(0);\n`);
    chmodSync(pathNode, 0o755);
    const installing = context(data, home);
    installing.env.PATH = bin;
    const product = pinnedProduct();
    const runtime = managedRuntimeDir(data, product.packageName, product.version);
    makeRuntime(runtime, product.packageName, product.version);
    const packageDir = join(runtime, 'node_modules', ...product.packageName.split('/'));
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: product.packageName,
        version: product.version,
        engines: { node: '>=22.12.0' },
        agentcomms: { binary: product.binary },
        bin: { [product.binary]: './dist/cli.mjs' },
      }),
    );

    const result = await withManagedShim(
      installing,
      product,
      await mcpInstall(installing, product, { client: 'cursor', noVerify: true }),
    );
    const entry = managedRuntimeEntry(data, product.packageName, product.version);
    const located = locateCliCommand({
      caller: { url: pathToFileURL(entry).href, packageName: product.packageName },
      target: {
        packageName: product.packageName,
        manifest: { channel: 'example', label: 'example', binary: product.binary },
      } as never,
      words: [],
      uses: [],
      paths: { ...installing.core.paths, downloadsDir: join(home, 'downloads') },
      platform: 'linux',
    });
    assert.equal(located.ok, true, 'the managed runtime locates its own declared CLI');
    if (!located.ok) return;
    const quote = (word: string) => `'${word.replaceAll("'", `'"'"'`)}'`;
    const execLine = readFileSync(result.shim?.path ?? '', 'utf8').split('\n')[2];
    assert.equal(
      execLine,
      `exec ${located.command.words.map(quote).join(' ')} "$@"`,
      'the shim content uses the locator result rather than the PATH-visible Node from the MCP registration',
    );
    assert.notEqual(
      located.command.words[0],
      result.entry.command,
      'the fixture proves the registration Node and the locator program are different',
    );
  },
);

test('a managed Windows install writes no shim and explains why Windows shims are not offered yet', async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = { ...context(data, home), platform: 'win32' as const };
  const product = pinnedProduct();
  makeRuntime(managedRuntimeDir(data, product.packageName, product.version), product.packageName, product.version);

  const result = await withManagedShim(
    installing,
    product,
    await mcpInstall(installing, product, { client: 'cursor', noVerify: true }),
  );

  assert.equal(result.shim, undefined, 'Windows managed installs do not write a .cmd or another shim');
  assert.match(
    result.shimNotice ?? '',
    /not offered on Windows yet.*cmd\.exe.*re-parses.*arguments/i,
    'the install result names the cmd.exe argument-reparsing reason',
  );
  assert.equal(existsSync(join(data, 'bin')), false, 'the Windows install creates no shim directory');
  assert.match(
    renderInstall(result, false),
    /not offered on Windows yet/i,
    'the human install rendering includes the Windows shim notice',
  );
});

test('a shim failure after registration is reported as partial success with repair guidance', POSIX_SHIMS, async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = {
    ...context(data, home),
    writeShim: async () => {
      throw new Error('test-shim-denied');
    },
  };
  const product = pinnedProduct();
  makeRuntime(managedRuntimeDir(data, product.packageName, product.version), product.packageName, product.version);

  const result = await withManagedShim(
    installing,
    product,
    await mcpInstall(installing, product, { client: 'cursor', noVerify: true }),
  );
  assert.equal(result.applied, true, 'the temporary client registration remains an acknowledged success');
  assert.match(result.shimFailure ?? '', /test-shim-denied/, 'the result reports why the CLI shim failed');
  assert.match(
    result.warnings.join('\n'),
    /registration succeeded.*managed install again with `--force`/i,
    'the result gives a command option that can replace the matching registration and repair its shim',
  );
  assert.match(
    readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'),
    /agentcomms/,
    'the result reflects that the client config was already written',
  );

  const retrying = context(data, home);
  const repaired = await withManagedShim(
    retrying,
    product,
    await mcpInstall(retrying, product, { client: 'cursor', noVerify: true, force: true }),
  );
  assert.equal(repaired.applied, true, 'following the documented forced retry succeeds against the owned entry');
  assert.equal(repaired.shim?.status, 'created', 'the documented retry creates the previously failed CLI shim');
});

test('the installer refuses a server name that is not plain, whoever calls it', async () => {
  /*
   * The last of three checks, for a caller that went round the other two — a library user, a surface added later.
   * A name is quoted in the preview a person approves, so one that carries quotes and commas can make that preview
   * describe a pin the entry does not have. Refused before anything is read, printed or written.
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
    narrowingOf: () => ({}),
  };
  for (const name of ['test", pinned to the mailbox work, read-only, "', 'x'.repeat(65), 'two words']) {
    await assert.rejects(
      mcpInstall(context(data, home), product, { client: 'json', apply: false, noVerify: true, name }),
      (error: Error & { code?: string }) => error.code === 'USAGE' && /a server name is 1 to 64/.test(error.message),
    );
  }
  assert.deepEqual(readdirSync(data), [], 'nothing was recorded, printed or installed');
  const plain = await mcpInstall(context(data, home), product, {
    client: 'json',
    apply: false,
    noVerify: true,
    name: 'x'.repeat(64),
  });
  assert.equal(plain.name, 'x'.repeat(64));
});

test('a runtime that only carries a package as a dependency is not that package’s runtime (CUE-473)', async () => {
  const data = tempDir();
  const at = (name: string) => join(data, 'runtime', name);
  // The events service's runtime installs core, Gmail, Slack, Resend and WhatsApp beside its own package.
  makeRuntime(at('0.0.9-events-daemon'), '@agentcomms/events-daemon', '0.0.9');
  for (const dependency of ['@agentcomms/core', '@agentcomms/slack', '@agentcomms/resend']) {
    const dir = join(at('0.0.9-events-daemon'), 'node_modules', ...dependency.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: dependency, version: '0.0.9' }));
  }
  // Slack's own runtime carries core the same way.
  makeRuntime(at('0.0.9-slack'), SLACK.packageName, '0.0.9');
  mkdirSync(join(at('0.0.9-slack'), 'node_modules', '@agentcomms', 'core'), { recursive: true });
  // Gmail's old layout has no name suffix: its own pin manifest is what makes it Gmail's.
  makeRuntime(at('0.0.1'), GMAIL.packageName, '0.0.1');

  const versions = async (packageName: string) =>
    (await listManagedRuntimes(data, packageName)).map((runtime) => basename(runtime.path));
  assert.deepEqual(await versions(SLACK.packageName), ['0.0.9-slack'], 'Slack has its own runtime and no other');
  assert.deepEqual(await versions('@agentcomms/resend'), [], 'Resend has none: the events runtime only carries it');
  assert.deepEqual(await versions('@agentcomms/core'), [], 'core has none: Slack and events only carry it');
  assert.deepEqual(await versions('@agentcomms/events-daemon'), ['0.0.9-events-daemon'], 'events has its own');
  assert.deepEqual(await versions(GMAIL.packageName), ['0.0.1'], 'the old Gmail layout is Gmail’s by its pin');
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
  const installing = context(data, home);
  // Shims exist on macOS and Linux only; on Windows prune has none to remove, and says so.
  const shims = managedShimsSupported();
  const ownedShim = shims
    ? await writeManagedShim(
        { env: installing.env, dataDir: installing.core.paths.dataDir, platform: installing.platform },
        {
          binary: 'agent-slack',
          command: [process.execPath, managedRuntimeEntry(data, SLACK.packageName, '0.0.1')],
          entry: managedRuntimeEntry(data, SLACK.packageName, '0.0.1'),
        },
      )
    : undefined;
  if (ownedShim !== undefined) {
    assert.equal(ownedShim.status, 'created', 'the prune fixture owns a shim into the unused runtime');
  }

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
    'the dry run finds only the unused Slack runtime',
  );
  if (ownedShim !== undefined) {
    assert.deepEqual(dry.shims.removed, [ownedShim.path], 'the dry run previews removing its owned CLI shim');
    assert.equal(existsSync(ownedShim.path), true, 'the dry run leaves the owned shim in place');
  } else {
    assert.deepEqual(dry.shims, { removed: [], kept: [] }, 'a Windows dry run has no CLI shim to remove');
  }
  await stat(at('0.0.1-slack'));

  const pruned = await pruneManagedRuntimes(context(data, home), product, { processes: async () => running });
  assert.deepEqual(
    pruned.removed.map((item) => item.path),
    [at('0.0.1-slack')],
    'prune removes only the unused runtime it previewed',
  );
  if (ownedShim !== undefined) {
    assert.deepEqual(pruned.shims.removed, [ownedShim.path], 'prune reports the owned CLI shim it removed');
    assert.equal(existsSync(ownedShim.path), false, 'prune removes the unchanged owned CLI shim');
  } else {
    assert.deepEqual(pruned.shims, { removed: [], kept: [] }, 'a Windows prune removes no CLI shim');
  }
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

/** Two runtimes, the older one registered only where the test puts it; this release is 0.0.9. */
function twoRuntimes() {
  const data = tempDir();
  const home = tempDir();
  const old = join(data, 'runtime', '0.0.1-slack');
  makeRuntime(old, SLACK.packageName, '0.0.1');
  makeRuntime(join(data, 'runtime', '0.0.9-slack'), SLACK.packageName, '0.0.9');
  const entry = { command: 'node', args: [managedRuntimeEntry(data, SLACK.packageName, '0.0.1'), 'mcp'] };
  const product = { packageName: SLACK.packageName, version: '0.0.9' };
  return { data, home, old, entry, product, nothingRunning: { processes: async () => [] } };
}

function writeConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('prune removes nothing when a client config cannot be read, and names the file', async () => {
  const { data, home, old, product, nothingRunning } = twoRuntimes();
  const env = context(data, home).env;
  const vscode = knownClientConfigs(env).find((file) => file.client === 'vscode')?.path ?? '';
  // Half an edit: whatever it registers, nobody can say.
  writeConfig(vscode, '{ "servers": { "slack": { "command": "node", "args": [');

  const result = await pruneManagedRuntimes(context(data, home), product, nothingRunning);
  assert.deepEqual(result.removed, []);
  assert.ok(result.refused?.includes(vscode), `the refusal names the file: ${result.refused}`);
  assert.deepEqual(
    result.kept.map((item) => item.reason),
    ['not checked', 'not checked'],
  );
  await stat(old);
});

test('prune keeps a runtime registered where only a closer reading finds it', async (t) => {
  const cases: [string, (setup: ReturnType<typeof twoRuntimes>) => NodeJS.ProcessEnv][] = [
    [
      'a VS Code mcp.json with a comment',
      ({ data, home, entry }) => {
        const env = context(data, home).env;
        const path = knownClientConfigs(env).find((file) => file.client === 'vscode')?.path ?? '';
        writeConfig(path, `// mine\n{ "servers": { "slack": ${JSON.stringify(entry)}, } }`);
        return env;
      },
    ],
    [
      'codex under CODEX_HOME',
      ({ data, home, entry }) => {
        const codexHome = tempDir();
        writeConfig(
          join(codexHome, 'config.toml'),
          `[mcp_servers.slack]\ncommand = "node"\nargs = [${entry.args.map((a) => JSON.stringify(a)).join(', ')}]\n`,
        );
        return { ...context(data, home).env, CODEX_HOME: codexHome };
      },
    ],
    [
      "Claude Code's config under CLAUDE_CONFIG_DIR",
      ({ data, home, entry }) => {
        const claudeDir = tempDir();
        writeConfig(join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { slack: entry } }));
        return { ...context(data, home).env, CLAUDE_CONFIG_DIR: claudeDir };
      },
    ],
    [
      "a project's .mcp.json",
      ({ data, home, entry }) => {
        const project = tempDir();
        writeConfig(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { mcpServers: {} } } }));
        writeConfig(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { slack: entry } }));
        return context(data, home).env;
      },
    ],
  ];
  for (const [label, arrange] of cases) {
    await t.test(label, async () => {
      const setup = twoRuntimes();
      const env = arrange(setup);
      const result = await pruneManagedRuntimes(
        { env, core: context(setup.data, setup.home).core },
        setup.product,
        setup.nothingRunning,
      );
      assert.deepEqual(result.removed, [], label);
      assert.match(result.kept.find((item) => item.version === '0.0.1')?.reason ?? '', /registered with/);
      await stat(setup.old);
    });
  }
});

test('prune keeps a runtime it printed an entry for, because where that entry went cannot be read', async () => {
  const { data, home, old, nothingRunning } = twoRuntimes();
  const product: McpProduct = {
    packageName: SLACK.packageName,
    binary: 'agent-slack',
    defaultServerName: 'slack',
    npxPackage: SLACK.npxPackage,
    version: '0.0.1',
    moduleUrl: import.meta.url,
    serverArgs: () => [],
    narrowingOf: () => ({}),
  };
  // `--client json` prints; the entry is pasted wherever the person keeps it, which no scan reaches.
  const printed = await mcpInstall(context(data, home), product, { client: 'json', apply: false, noVerify: true });
  assert.equal(printed.entry.args[0], managedRuntimeEntry(data, SLACK.packageName, '0.0.1'));

  const result = await pruneManagedRuntimes(context(data, home), { ...product, version: '0.0.9' }, nothingRunning);
  assert.deepEqual(result.removed, []);
  assert.match(result.kept.find((item) => item.version === '0.0.1')?.reason ?? '', /printed for json as "slack"/);
  await stat(old);

  // A record it cannot read is the same as a config it cannot read: nothing goes.
  writeFileSync(handedOutRuntimesPath(data), 'not json\n', { flag: 'a' });
  const blind = await pruneManagedRuntimes(context(data, home), { ...product, version: '0.0.9' }, nothingRunning);
  assert.deepEqual(blind.removed, []);
  assert.ok(blind.refused?.includes(handedOutRuntimesPath(data)), `${blind.refused}`);
});

const NOT_ON_WINDOWS =
  process.platform === 'win32' ? { skip: 'mcp install cannot spawn a .cmd; see install-force.test.ts in gmail' } : {};

/**
 * A stand-in for `claude`, in `bin` — a directory of its own unless one is named — that keeps its servers in the one
 * `.claude.json` it is given.
 *
 * That is what Claude Code does with the `CLAUDE_CONFIG_DIR` of the shell that ran it. The path is written into
 * the script rather than read from its environment, which is this test process's own and may name a real one.
 */
function fakeClaude(config: string, bin: string = tempDir()): string {
  mkdirSync(bin, { recursive: true });
  const script = [
    // This node, by path: the client CLI is started with the install's own environment, whose PATH has none.
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `const config = ${JSON.stringify(config)};`,
    'const [, sub, name, entry] = process.argv.slice(2);',
    'if (sub === "add-json") {',
    '  const current = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, "utf8")) : {};',
    '  current.mcpServers = { ...current.mcpServers, [name]: JSON.parse(entry) };',
    '  fs.writeFileSync(config, JSON.stringify(current));',
    '}',
  ].join('\n');
  writeFileSync(join(bin, 'claude'), script, { mode: 0o755 });
  return bin;
}

test(
  'prune keeps a runtime the installer registered under a CLAUDE_CONFIG_DIR its own shell does not have',
  NOT_ON_WINDOWS,
  async () => {
    const { data, home, old, product, nothingRunning } = twoRuntimes();
    // A second Claude account, chosen per shell: the install ran with it set, and the prune below does not.
    const work = tempDir();
    const config = join(work, '.claude.json');
    const installing: InstallContext = {
      env: { HOME: home, PATH: fakeClaude(config), CLAUDE_CONFIG_DIR: work },
      core: context(data, home).core,
    };
    const slack: McpProduct = {
      packageName: SLACK.packageName,
      binary: 'agent-slack',
      defaultServerName: 'slack',
      npxPackage: SLACK.npxPackage,
      version: '0.0.1',
      moduleUrl: import.meta.url,
      serverArgs: () => [],
      narrowingOf: () => ({}),
    };
    const installed = await mcpInstall(installing, slack, { client: 'claude-code', noVerify: true });
    assert.equal(installed.method, 'cli');
    assert.match(readFileSync(config, 'utf8'), /0\.0\.1-slack/, 'the stand-in wrote the entry where it was told');

    const kept = await pruneManagedRuntimes(context(data, home), product, nothingRunning);
    assert.deepEqual(kept.removed, [], 'a runtime the work account still starts was removed');
    const reason = kept.kept.find((item) => item.version === '0.0.1')?.reason ?? '';
    assert.match(reason, /registered with claude-code as "slack"/);
    assert.ok(reason.includes(config), `the reason says where, which this shell would not guess: ${reason}`);
    await stat(old);

    // A recorded config that is there and cannot be read is the same as a known one: nothing goes, and it is named.
    writeFileSync(config, '{ "mcpServers": ');
    const blind = await pruneManagedRuntimes(context(data, home), product, nothingRunning);
    assert.deepEqual(blind.removed, []);
    assert.ok(blind.refused?.includes(config), `the refusal names the file: ${blind.refused}`);

    // One that is no longer there is not a reason to keep anything: the record is of where to look, not a hold.
    rmSync(config);
    const gone = await pruneManagedRuntimes(context(data, home), product, nothingRunning);
    assert.deepEqual(
      gone.removed.map((item) => item.version),
      ['0.0.1'],
    );
  },
);

test(
  "a client's own command is found where it is installed when PATH does not have it, and registered through",
  NOT_ON_WINDOWS,
  async () => {
    /*
     * An install asked for from chat runs inside an MCP server, whose PATH is the one written into its entry at
     * registration: node's own directory, /usr/local/bin, /usr/bin, /bin. `claude` from Anthropic's native installer
     * (~/.local/bin) or from Homebrew on an Apple Silicon Mac (/opt/homebrew/bin) is on none of them, so the install
     * found no `claude`, registered nothing, and printed the entry. Here PATH is an empty directory each time, and the
     * stand-in is only where it is usually installed. Every lookup stays inside these directories: the system ones
     * are replaced with a directory of the test's own, or with none.
     */
    const lookIn = async (where: 'home' | 'system') => {
      const home = tempDir();
      const claudeDir = tempDir();
      const config = join(claudeDir, '.claude.json');
      const system = tempDir();
      const bin = where === 'home' ? join(home, '.local', 'bin') : system;
      fakeClaude(config, bin);
      const installing: InstallContext = {
        env: {
          HOME: home,
          PATH: tempDir(),
          CLAUDE_CONFIG_DIR: claudeDir,
          // Standing in for /opt/homebrew/bin and /usr/local/bin.
          AGENT_COMMS_CLIENT_CLI_DIRS: system,
        },
        core: context(tempDir(), home).core,
      };
      const target = await installTarget(installing, { client: 'claude-code' });
      assert.equal(target.cliPath, join(bin, 'claude'), `looked for claude in ${where}`);
      const result = await mcpInstall(installing, pinnedProduct(), {
        client: 'claude-code',
        launcher: 'npx',
        noVerify: true,
      });
      assert.equal(result.notApplied, undefined, `${where}: ${result.notApplied}`);
      assert.equal(result.applied, true, where);
      assert.equal(result.method, 'cli', where);
      const written = JSON.parse(readFileSync(config, 'utf8'));
      assert.deepEqual(
        written.mcpServers.example.args,
        ['-y', '@agentcomms/example@0.0.1', ...registrationPins(installing)],
        where,
      );
    };
    await lookIn('home');
    await lookIn('system');

    // Found nowhere, it registers nothing — and says where it looked, so a person knows where to put it.
    const home = tempDir();
    const nowhere = await mcpInstall(
      {
        env: { HOME: home, PATH: tempDir(), CLAUDE_CONFIG_DIR: tempDir(), AGENT_COMMS_CLIENT_CLI_DIRS: '' },
        core: context(tempDir(), home).core,
      },
      pinnedProduct(),
      { client: 'claude-code', launcher: 'npx', noVerify: true },
    );
    assert.equal(nowhere.applied, false);
    assert.equal(
      nowhere.notApplied,
      `claude was not found on PATH or in ${join(home, '.local', 'bin')}, so nothing was registered`,
    );
  },
);

test(
  "a client's command is looked for only in absolute directories, so where the server started cannot choose it",
  NOT_ON_WINDOWS,
  () => {
    /*
     * A relative directory is read against the directory the server happened to start in: a `claude` found there, and
     * run, would be chosen by that, not by where the person installed it. A relative HOME, and a relative entry in the
     * list that stands in for the system directories, are both left out; absolute ones are kept, in order.
     */
    assert.deepEqual(
      clientCliDirectories({
        HOME: 'relative-home',
        AGENT_COMMS_CLIENT_CLI_DIRS: ['bin', '/abs/one', './two', '/abs/three'].join(delimiter),
      }),
      ['/abs/one', '/abs/three'],
    );
    assert.deepEqual(clientCliDirectories({ HOME: '/abs/home', AGENT_COMMS_CLIENT_CLI_DIRS: '' }), [
      join('/abs/home', '.local', 'bin'),
    ]);
  },
);

/** An executable file `name` in `directory`, which is where it is found. */
function executable(directory: string, name: string): string {
  const file = join(directory, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

test(
  'a command on PATH is looked for only in absolute directories: an empty, `.` or relative entry is where this started',
  NOT_ON_WINDOWS,
  async () => {
    /*
     * The `tool` a relative entry names really is there, reached from this test's own current folder — so a search
     * that took relative entries would find it, and return it first. The one installed in an absolute directory is
     * the only one that may be found.
     */
    const cwdDecoy = relative(process.cwd(), tempDir());
    executable(cwdDecoy, 'tool');
    const installed = tempDir();
    const tool = executable(installed, 'tool');
    assert.equal(
      await whichExecutable('tool', { PATH: ['', '.', cwdDecoy, installed].join(delimiter) }),
      tool,
      'the tool in the absolute directory is found, never the one a relative entry reaches',
    );
    assert.equal(
      await whichExecutable('tool', { PATH: ['', '.', cwdDecoy].join(delimiter) }),
      null,
      'with only relative entries nothing is found, though a relative entry holds one',
    );
  },
);

test(
  'the running processes are listed by `ps` at its full path, never a `ps` looked up by name',
  NOT_ON_WINDOWS,
  async () => {
    const ran: string[] = [];
    const list = async (ps: string) => {
      ran.push(ps);
      return ['node server.mjs'];
    };
    // The machine's own: /bin/ps, or else /usr/bin/ps.
    const system = ['/bin/ps', '/usr/bin/ps'].filter((file) => existsSync(file));
    const lines = await runningCommandLines({ list });
    assert.deepEqual(ran, system.slice(0, 1), 'ps is run by its full path under /bin or /usr/bin');
    assert.deepEqual(lines, system.length > 0 ? ['node server.mjs'] : null);

    // The first directory that holds one, in order.
    ran.length = 0;
    const empty = tempDir();
    const holds = tempDir();
    const ps = executable(holds, 'ps');
    await runningCommandLines({ directories: [empty, holds], list });
    assert.deepEqual(ran, [ps], 'the first directory holding a ps is the one run');

    // None there: the processes cannot be listed, and nothing is started to find out.
    ran.length = 0;
    assert.equal(await runningCommandLines({ directories: [empty], list }), null);
    assert.deepEqual(ran, [], 'with no ps in the directories nothing is run');
  },
);

test('with a data directory it cannot write, --print still prints the entry and a write is refused untouched', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('a mode cannot stop this process writing there');
    return;
  }
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
    narrowingOf: () => ({}),
  };
  // What a sandbox whose writable roots leave out the data directory looks like from inside it.
  chmodSync(data, 0o500);
  try {
    const result = await mcpInstall(context(data, home), product, { client: 'cursor', apply: false, noVerify: true });
    assert.match(result.snippet, /no-such-package-for-tests/);
    assert.ok(
      result.warnings.some((warning) => /mcp prune/.test(warning) && warning.includes(handedOutRuntimesPath(data))),
      result.warnings.join('\n'),
    );
  } finally {
    chmodSync(data, 0o700);
  }
  assert.deepEqual(readdirSync(data), [], 'and nothing was written there');

  // An entry that would be written is different: unrecorded, prune could delete what it starts. So it is refused,
  // in words, before the client's config is touched.
  makeRuntime(managedRuntimeDir(data, product.packageName, '0.0.1'), product.packageName, '0.0.1');
  chmodSync(data, 0o500);
  try {
    await assert.rejects(
      mcpInstall(context(data, home), product, { client: 'cursor', noVerify: true }),
      (error: { message?: string; hint?: string }) =>
        /nothing was registered/.test(error.message ?? '') && /--print/.test(error.hint ?? ''),
    );
  } finally {
    chmodSync(data, 0o700);
  }
  const cursor = knownClientConfigs(context(data, home).env).find((file) => file.client === 'cursor')?.path ?? '';
  await assert.rejects(stat(cursor), 'the client config was written without a record');
});

test('--force keeps the pin and --read-only of the entry it replaces, unless the caller gives its own', async () => {
  const data = tempDir();
  const home = tempDir();
  const installing = context(data, home);
  const cursor = knownClientConfigs(installing.env).find((file) => file.client === 'cursor')?.path ?? '';
  const narrowed = {
    command: 'node',
    args: [managedRuntimeEntry(data, '@agentcomms/example', '0.0.0'), 'mcp', '--inbox', 'acme/work', '--read-only'],
  };
  writeConfig(cursor, JSON.stringify({ mcpServers: { example: narrowed } }));
  const product = pinnedProduct();
  const asked = { client: 'cursor', launcher: 'npx', noVerify: true } as const;

  // The remedy is the command that replaces this entry as it is, so following it keeps what it narrowed. The installer
  // says its words; the operation that called it locates the command (CUE-403).
  const hint = await mcpInstall(installing, product, asked).then(
    () => assert.fail('it was not refused'),
    (error: unknown) => installRemedyOf(error)?.words.join(' ') ?? '',
  );
  for (const flag of ['--inbox acme/work', '--read-only', '--launcher npx', '--force']) {
    assert.ok(hint.includes(flag), `the hint dropped ${flag}: ${hint}`);
  }

  // And so does the bare `--force` that the upgrade instructions give, saying what it kept.
  const forced = await mcpInstall(installing, product, { ...asked, force: true });
  assert.deepEqual(forced.entry.args, [
    '-y',
    '@agentcomms/example@0.0.1',
    ...registrationPins(installing),
    '--inbox',
    'acme/work',
    '--read-only',
  ]);
  const written = JSON.parse(readFileSync(cursor, 'utf8')) as { mcpServers: { example: { args: string[] } } };
  assert.deepEqual(written.mcpServers.example.args, forced.entry.args, 'the file holds what the result says');
  assert.ok(
    forced.warnings.some((warning) => warning.includes('--inbox acme/work --read-only') && /remove/.test(warning)),
    forced.warnings.join('\n'),
  );

  // A flag the caller gives wins over the one it replaces; what the caller leaves out is still kept.
  const repinned = await mcpInstall(installing, product, { ...asked, force: true, inbox: 'acme/home' });
  assert.deepEqual(repinned.entry.args, [
    '-y',
    '@agentcomms/example@0.0.1',
    ...registrationPins(installing),
    '--inbox',
    'acme/home',
    '--read-only',
  ]);

  // Nothing to keep is nothing to say.
  writeConfig(
    cursor,
    JSON.stringify({ mcpServers: { example: { command: 'node', args: [narrowed.args[0], 'mcp'] } } }),
  );
  const plain = await mcpInstall(installing, product, { ...asked, force: true });
  assert.deepEqual(plain.entry.args, ['-y', '@agentcomms/example@0.0.1', ...registrationPins(installing)]);
  assert.deepEqual(plain.warnings, []);

  // The launcher, too, comes off the entry when the caller named none, as the doctors' repair reads it.
  writeConfig(
    cursor,
    JSON.stringify({
      mcpServers: { example: { command: 'npx', args: ['-y', '@agentcomms/example@0.0.0', '--read-only'] } },
    }),
  );
  const npx = await mcpInstall(installing, product, { client: 'cursor', noVerify: true }).then(
    () => assert.fail('it was not refused'),
    (error: unknown) => installRemedyOf(error)?.words.join(' ') ?? '',
  );
  for (const flag of ['--read-only', '--launcher npx', '--force']) {
    assert.ok(npx.includes(flag), `the hint dropped ${flag}: ${npx}`);
  }
});

test('--include-printed removes a runtime kept only for a printed entry, and the record forgets only that one', async () => {
  const { data, home, old, nothingRunning } = twoRuntimes();
  const product: McpProduct = {
    packageName: SLACK.packageName,
    binary: 'agent-slack',
    defaultServerName: 'slack',
    npxPackage: SLACK.npxPackage,
    version: '0.0.1',
    moduleUrl: import.meta.url,
    serverArgs: () => [],
    narrowingOf: () => ({}),
  };
  await mcpInstall(context(data, home), product, { client: 'json', apply: false, noVerify: true });
  // Somebody else's line, for the other product: forgetting 0.0.1 must not take it with it.
  const other = {
    at: '2026-09-01T00:00:00.000Z',
    client: 'json',
    name: 'gmail',
    runtime: join(data, 'runtime', '0.0.1-gmail'),
  };
  writeFileSync(handedOutRuntimesPath(data), `${JSON.stringify(other)}\n`, { flag: 'a' });

  const kept = await pruneManagedRuntimes(context(data, home), { ...product, version: '0.0.9' }, nothingRunning);
  assert.match(kept.kept.find((item) => item.version === '0.0.1')?.reason ?? '', /--include-printed/);

  const dry = await pruneManagedRuntimes(
    context(data, home),
    { ...product, version: '0.0.9' },
    {
      ...nothingRunning,
      includePrinted: true,
      dryRun: true,
    },
  );
  assert.deepEqual(
    dry.removed.map((item) => item.version),
    ['0.0.1'],
  );
  await stat(old);

  const gone = await pruneManagedRuntimes(
    context(data, home),
    { ...product, version: '0.0.9' },
    {
      ...nothingRunning,
      includePrinted: true,
    },
  );
  assert.deepEqual(
    gone.removed.map((item) => item.version),
    ['0.0.1'],
  );
  await assert.rejects(stat(old));
  const left = readFileSync(handedOutRuntimesPath(data), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(left, [other]);
});

test("the product's own published command, by name or by path, is ours; a package npx would fetch is not", () => {
  const slack = (command: string, args: string[] = ['mcp', '--workspace', 'acme/slack']) =>
    isProductServer({ command, args }, SLACK);
  // What a global install gives, and what the Slack README says runs the server.
  assert.equal(slack('agent-slack'), true);
  assert.equal(slack('/usr/local/bin/agent-slack'), true);
  assert.equal(slack('/opt/project/node_modules/.bin/agent-slack'), true);
  assert.equal(slack('C:\\tools\\npm\\agent-slack.cmd'), true);
  assert.equal(isProductServer({ command: 'agent-gmail-mcp', args: ['--inbox', 'work'] }, GMAIL), true);
  // Near misses.
  assert.equal(slack('agent-slack-evil'), false);
  assert.equal(slack('npx', ['-y', 'agent-slack', 'mcp']), false, 'npx would fetch a package of that name');
  assert.equal(isProductServer({ command: 'agent-slack', args: ['mcp'] }, GMAIL), false, "Slack's is not Gmail's");
});

/** A product whose flags are the ones that decide what a server may reach. */
function pinnedProduct(): McpProduct {
  return {
    packageName: '@agentcomms/example',
    binary: 'agent-example',
    defaultServerName: 'example',
    npxPackage: '@agentcomms/example',
    version: '0.0.1',
    moduleUrl: import.meta.url,
    serverArgs: (options) => [
      ...(options.inbox ? ['--inbox', options.inbox] : []),
      ...(options.readOnly ? ['--read-only'] : []),
    ],
    narrowingOf: (args) => ({
      ...(args.includes('--inbox') ? { inbox: args[args.indexOf('--inbox') + 1] } : {}),
      ...(args.includes('--read-only') ? { readOnly: true } : {}),
    }),
  };
}

test('install warnings render rival removal commands for the selected shell platform', async () => {
  const data = tempDir();
  const home = tempDir();
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { '7/gmail': { command: 'npx', args: ['@artymclabin/gmail-mcp'] } } }),
  );
  const result = await mcpInstall(
    { ...context(data, home), platform: 'win32' },
    { ...CHANNEL_SERVERS.gmail, version: '0.0.1', moduleUrl: import.meta.url },
    { client: 'claude-code', apply: false, noVerify: true },
  );
  assert.ok(
    result.warnings.some((warning) => /claude mcp remove "7\/gmail"/.test(warning)),
    result.warnings.join('\n'),
  );
});

test('a refusal hint repeats every flag that narrows the server, so following it widens nothing', async () => {
  const data = tempDir();
  const home = tempDir();
  const env = context(data, home).env;
  const cursor = knownClientConfigs(env).find((file) => file.client === 'cursor')?.path ?? '';
  const ours = { command: 'node', args: [managedRuntimeEntry(data, '@agentcomms/example', '0.0.0'), 'mcp'] };
  writeConfig(
    cursor,
    JSON.stringify({ mcpServers: { 'example-work': ours, theirs: { command: 'npx', args: ['x'] } } }),
  );
  const options = {
    client: 'cursor',
    name: 'example-work',
    inbox: 'acme/work',
    readOnly: true,
    launcher: 'npx',
    noVerify: true,
  } as const;

  // The command the remedy gives — its words after the program, which the operation locates — not the prose around it.
  const hintOf = async (name: string) => {
    try {
      await mcpInstall(context(data, home), pinnedProduct(), { ...options, name });
    } catch (error) {
      const remedy = installRemedyOf(error);
      assert.equal(remedy?.binary, 'agent-example');
      return remedy?.words.join(' ') ?? '';
    }
    assert.fail('it was not refused');
  };
  const again = await hintOf('example-work');
  for (const flag of ['--name example-work', '--inbox acme/work', '--read-only', '--launcher npx', '--force']) {
    assert.ok(again.includes(flag), `the hint dropped ${flag}: ${again}`);
  }
  const elsewhere = await hintOf('theirs');
  for (const flag of ['--inbox acme/work', '--read-only', '--launcher npx']) {
    assert.ok(elsewhere.includes(flag), `the hint dropped ${flag}: ${elsewhere}`);
  }
  assert.doesNotMatch(elsewhere, /--force/);
});

test('a refusal names its remedy as words to locate, a pin Windows cannot print among them, and never a line (CUE-306)', async () => {
  /*
   * A pin kept from the entry being replaced is read from the client's file, which may hold anything. Quoted for
   * PowerShell, a word with a `$` or a `%` came out in single quotes, which cmd.exe reads as characters. The installer
   * now names the remedy as words — the operation that called it locates the command, and on Windows a located command
   * with such a word is shown as its words to type (`handoffSentence`). Until then its hint is prose: no line runs.
   */
  const data = tempDir();
  const home = tempDir();
  const windows: InstallContext = { ...context(data, home), platform: 'win32' };
  const cursor = knownClientConfigs(windows.env).find((file) => file.client === 'cursor')?.path ?? '';
  const runtime = managedRuntimeEntry(data, '@agentcomms/example', '0.0.0');
  const refusal = async (options: Parameters<typeof mcpInstall>[2]) =>
    mcpInstall(windows, pinnedProduct(), options).then(
      () => assert.fail('it was not refused'),
      (error: { hint?: string }) => {
        const remedy = installRemedyOf(error);
        assert.ok(remedy !== undefined, 'the refusal names its remedy');
        assert.doesNotMatch(String(error.hint), /`agent-example|`\[/, 'no command, and no words to type, in the hint');
        return { hint: String(error.hint), remedy };
      },
    );
  const located = (remedy: InstallRemedy) =>
    handoffSentence(coreHandoffs(resolvePaths({ env: windows.env }), 'win32').own(remedy.words), remedy.say);

  // Ours, pinned in the file to what no quoting makes safe on Windows: the command that replaces it as it is.
  writeConfig(
    cursor,
    JSON.stringify({ mcpServers: { example: { command: 'node', args: [runtime, 'mcp', '--inbox', 'acme/50%'] } } }),
  );
  const force = await refusal({ client: 'cursor', launcher: 'npx', noVerify: true });
  assert.deepEqual(force.remedy.words, [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--inbox',
    'acme/50%',
    '--launcher',
    'npx',
    '--force',
  ]);
  assert.equal(
    force.hint,
    'Pass --force to replace it — that is how an upgrade reaches a client: its own `mcp install` with --client cursor --inbox acme/50% --launcher npx --force.',
  );
  // Located for Windows, as an operation does: the words as JSON, saying they are to be typed, and no line.
  assert.match(located(force.remedy), /`\[.*"acme\/50\\u0025".*\]` \(the command's words, written as JSON/);

  // Somebody else's under the name asked for: register this one under another.
  writeConfig(cursor, JSON.stringify({ mcpServers: { theirs: { command: 'npx', args: ['x'] } } }));
  const elsewhere = await refusal({ client: 'cursor', name: 'theirs', inbox: 'acme/50%', noVerify: true });
  assert.deepEqual(elsewhere.remedy.words, [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--name',
    'agent-example',
    '--inbox',
    'acme/50%',
  ]);
  assert.ok(elsewhere.remedy.say('X').startsWith('Register this one under another name: X. '));

  // Ours, serving another mailbox: a second entry under a name of its own.
  writeConfig(
    cursor,
    JSON.stringify({ mcpServers: { example: { command: 'node', args: [runtime, 'mcp', '--inbox', 'acme/work'] } } }),
  );
  const second = await refusal({ client: 'cursor', inbox: 'acme/50%', noVerify: true });
  assert.deepEqual(second.remedy.words, [
    'mcp',
    'install',
    '--client',
    'cursor',
    '--name',
    'example-acme',
    '--inbox',
    'acme/50%',
  ]);
  assert.equal(
    second.remedy.say('X'),
    'That entry serves acme/work; to serve acme/50% as well, register a second entry under its own name: X.',
  );
});

test('an entry that was checked and failed to start says so, and ends the command non-zero', async () => {
  // A checkout whose command exits at once — 0.4.0's npx entry without `mcp` did exactly this.
  const checkout = tempDir();
  writeFileSync(join(checkout, 'cli.mjs'), 'process.exit(3);\n');
  const product = { ...pinnedProduct(), moduleUrl: pathToFileURL(join(checkout, 'module.mjs')).href };
  const result = await mcpInstall(context(tempDir(), tempDir()), product, {
    client: 'json',
    launcher: 'local',
    apply: false,
  });
  assert.equal(result.verification, 'failed');
  assert.match(renderInstall(result, false), /Failed to start: /);
  assert.doesNotMatch(renderInstall(result, false), /Not checked/);
  assert.equal(installExitStatus(result), EXIT_CODES.UNAVAILABLE);
  // The same verdict for a surface with no exit status: an error whose code exits with that status.
  const failure = installFailure(result);
  assert.ok(failure, 'a failed check is an error on every surface');
  assert.equal(ERROR_REGISTRY[failure.code].exit, installExitStatus(result));
  assert.match(failure.message, /did not start/);
  assert.equal(failure.details?.snippet, result.snippet, 'the entry is still there to read');

  // Skipped is not failed: `--no-verify` asked for no check, and gets no failure.
  const skipped = await mcpInstall(context(tempDir(), tempDir()), product, {
    client: 'json',
    launcher: 'local',
    apply: false,
    noVerify: true,
  });
  assert.equal(skipped.verification, 'skipped');
  assert.match(renderInstall(skipped, false), /Not checked/);
  assert.equal(installExitStatus(skipped), EXIT_CODES.OK);
  assert.equal(installFailure(skipped), null);
});

test(
  "a hint naming a client's entry is the client's own command, or says it in words when the name is a suite command",
  NOT_ON_WINDOWS,
  async () => {
    /*
     * Codex answers `mcp get` with something that cannot be read, so the install stops and says how to look. That is
     * codex's own command, an external one; but the core server's default name is `agentcomms`, the core's own
     * command, and an external command is never made with a suite command among its words (CUE-403). So that one hint
     * names the entry in words instead.
     */
    const bin = tempDir();
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nprocess.stdout.write('not json');\n`, { mode: 0o755 });
    const installing = { ...context(tempDir(), tempDir()) };
    installing.env = { ...installing.env, PATH: bin };
    const hintFor = async (product: McpProduct) => {
      try {
        await preflightInstall(installing, product, { client: 'codex' });
      } catch (error) {
        return (error as { hint?: string }).hint ?? '';
      }
      assert.fail('the install went ahead');
    };
    const gmail = await hintFor({ ...CHANNEL_SERVERS.gmail, version: '0.0.1', moduleUrl: import.meta.url });
    assert.match(gmail, /^Look with `codex mcp get gmail`\./);
    const core = await hintFor({ ...CHANNEL_SERVERS.core, version: '0.0.1', moduleUrl: import.meta.url });
    assert.match(core, /^Look with codex's own `mcp get`, for the entry called "agentcomms"\./);
    assert.doesNotMatch(core, /mcp get agentcomms/);
  },
);
