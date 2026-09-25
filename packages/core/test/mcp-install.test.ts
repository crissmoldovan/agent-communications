import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { EXIT_CODES } from '../src/errors.ts';
import { knownClientConfigs } from '../src/mcp-clients.ts';
import {
  handedOutRuntimesPath,
  type InstallContext,
  installExitStatus,
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
import { renderInstall } from '../src/render.ts';
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
    narrowingOf: () => ({}),
  };
  const result = await mcpInstall(context(data, home), product, { client: 'json', apply: false });
  assert.equal(result.entry.args[0], managedRuntimeEntry(data, product.packageName, '0.0.1'));
  // Only the record of what was handed out, which `prune` reads: no runtime.
  assert.deepEqual(readdirSync(data), [basename(handedOutRuntimesPath(data))], 'nothing was installed');
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
 * A stand-in for `claude`, on PATH, that keeps its servers in the one `.claude.json` it is given.
 *
 * That is what Claude Code does with the `CLAUDE_CONFIG_DIR` of the shell that ran it. The path is written into
 * the script rather than read from its environment, which is this test process's own and may name a real one.
 */
function fakeClaude(config: string): string {
  const bin = tempDir();
  const script = [
    '#!/usr/bin/env node',
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
  const cursor = knownClientConfigs(context(data, home).env).find((file) => file.client === 'cursor')?.path ?? '';
  const narrowed = {
    command: 'node',
    args: [managedRuntimeEntry(data, '@agentcomms/example', '0.0.0'), 'mcp', '--inbox', 'acme/work', '--read-only'],
  };
  writeConfig(cursor, JSON.stringify({ mcpServers: { example: narrowed } }));
  const product = pinnedProduct();
  const asked = { client: 'cursor', launcher: 'npx', noVerify: true } as const;

  // The hint is the command that replaces this entry as it is, so following it keeps what it narrowed.
  const hint = await mcpInstall(context(data, home), product, asked).then(
    () => assert.fail('it was not refused'),
    (error: { hint?: string }) => /`([^`]+)`/.exec(error.hint ?? '')?.[1] ?? '',
  );
  for (const flag of ['--inbox acme/work', '--read-only', '--launcher npx', '--force']) {
    assert.ok(hint.includes(flag), `the hint dropped ${flag}: ${hint}`);
  }

  // And so does the bare `--force` that the upgrade instructions give, saying what it kept.
  const forced = await mcpInstall(context(data, home), product, { ...asked, force: true });
  assert.deepEqual(forced.entry.args, ['-y', '@agentcomms/example@0.0.1', '--inbox', 'acme/work', '--read-only']);
  const written = JSON.parse(readFileSync(cursor, 'utf8')) as { mcpServers: { example: { args: string[] } } };
  assert.deepEqual(written.mcpServers.example.args, forced.entry.args, 'the file holds what the result says');
  assert.ok(
    forced.warnings.some((warning) => warning.includes('--inbox acme/work --read-only') && /remove/.test(warning)),
    forced.warnings.join('\n'),
  );

  // A flag the caller gives wins over the one it replaces; what the caller leaves out is still kept.
  const repinned = await mcpInstall(context(data, home), product, { ...asked, force: true, inbox: 'acme/home' });
  assert.deepEqual(repinned.entry.args, ['-y', '@agentcomms/example@0.0.1', '--inbox', 'acme/home', '--read-only']);

  // Nothing to keep is nothing to say.
  writeConfig(
    cursor,
    JSON.stringify({ mcpServers: { example: { command: 'node', args: [narrowed.args[0], 'mcp'] } } }),
  );
  const plain = await mcpInstall(context(data, home), product, { ...asked, force: true });
  assert.deepEqual(plain.entry.args, ['-y', '@agentcomms/example@0.0.1']);
  assert.deepEqual(plain.warnings, []);

  // The launcher, too, comes off the entry when the caller named none, as the doctors' repair reads it.
  writeConfig(
    cursor,
    JSON.stringify({
      mcpServers: { example: { command: 'npx', args: ['-y', '@agentcomms/example@0.0.0', '--read-only'] } },
    }),
  );
  const npx = await mcpInstall(context(data, home), product, { client: 'cursor', noVerify: true }).then(
    () => assert.fail('it was not refused'),
    (error: { hint?: string }) => /`([^`]+)`/.exec(error.hint ?? '')?.[1] ?? '',
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

  // The command the hint gives, not the prose around it.
  const hintOf = async (name: string) => {
    try {
      await mcpInstall(context(data, home), pinnedProduct(), { ...options, name });
    } catch (error) {
      return /`([^`]+)`/.exec((error as { hint?: string }).hint ?? '')?.[1] ?? '';
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
});
