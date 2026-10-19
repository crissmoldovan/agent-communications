import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CliCommandRequest,
  type CliCommandResult,
  locateCliCommand,
  type NodeRuntime,
  type PrintedCommand,
} from '../src/cli-command.ts';
import { commandText, inlineCommand } from '../src/cli-runtime.ts';
import { type ExternalCommand, externalCommand } from '../src/command-brands.ts';
import { commandAsJson, inlineQuoted, quoteCommand, quotedText } from '../src/command-line.ts';
import type { RegisteredServer } from '../src/mcp-clients.ts';
import { findUngatedGmailServers, otherSlackServerRemoval } from '../src/other-servers.ts';
import type { PathName, ResolvedPaths } from '../src/paths.ts';
import { satisfiesRange } from '../src/versions.ts';
import { bareEnv, runPrinted, writeNpxCache, writePreloader, writeRunnable } from './fixtures/cli-command/runnable.ts';
import {
  link,
  markingProgram,
  moduleUrl,
  pinArgs,
  realTemp,
  registration,
  shortName,
  suiteEntry,
  VERSION,
  writeCheckout,
  writeFile,
  writeGlobal,
  writeManaged,
  writePackage,
} from './fixtures/cli-command/trees.ts';

/*
 * The CLI locator (design 2026-10-04, D1 and D5): a command for a person to run names this Node and a checked file of
 * the product it runs, never a bare suite binary, and pins the suite directories that command uses. Own-product and
 * channel→core here; another product's command is CUE-403 task 7.
 */

const PATHS: ResolvedPaths = {
  configDir: resolve('/pins/config'),
  stateDir: resolve('/pins/state'),
  dataDir: resolve('/pins/data'),
  secretsDir: resolve('/pins/secrets'),
  downloadsDir: resolve('/pins/downloads'),
};
const FOUR: readonly PathName[] = ['configDir', 'stateDir', 'dataDir', 'secretsDir'];
const PINS = [
  '--config-dir',
  PATHS.configDir,
  '--state-dir',
  PATHS.stateDir,
  '--data-dir',
  PATHS.dataDir,
  '--secrets-dir',
  PATHS.secretsDir,
];
/** A Node new enough for every package, run with no flags: what most tests locate under. */
const NODE: NodeRuntime = { version: 'v22.18.0', execArgv: [] };
const STRIP = '--experimental-strip-types';
const TRANSFORM = '--experimental-transform-types';

function request(
  callerUrl: string,
  callerChannel: string,
  targetChannel: string,
  overrides: Partial<CliCommandRequest> = {},
): CliCommandRequest {
  return {
    caller: { url: callerUrl, packageName: suiteEntry(callerChannel).packageName },
    target: suiteEntry(targetChannel),
    words: ['approve', 'abc123'],
    uses: FOUR,
    paths: PATHS,
    platform: 'linux',
    ...overrides,
  };
}

function located(result: CliCommandResult): PrintedCommand {
  assert.equal(result.ok, true, result.ok ? '' : `not located: ${result.reason}: ${result.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result.command;
}

/**
 * No command at all — nothing to paste, no words, no bare binary in its place — and a sentence naming the product,
 * its package and the exact version it needs.
 */
function notLocated(result: CliCommandResult, reason: string, channel: string, version = VERSION) {
  assert.equal(result.ok, false, 'no command');
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.reason, reason, result.message);
  assert.ok(!('command' in result), 'the failure carries no command');
  const { packageName, manifest } = suiteEntry(channel);
  assert.equal(result.package, packageName);
  assert.equal(result.product, manifest.label);
  assert.equal(result.version, version);
  assert.ok(result.message.includes(`${manifest.label} ${version} (${packageName})`), result.message);
  for (const { manifest: each } of [suiteEntry('core'), suiteEntry('gmail'), suiteEntry('slack')]) {
    assert.doesNotMatch(result.message, new RegExp(`(?:^|[\\s\`'"])${each.binary}\\s+[a-z-]`), 'no bare command');
  }
  return result;
}

// ── 1a: the product's own CLI, wherever it is installed ─────────────────────────────────────────────────────────────

test('own locator: a managed runtime, an npx cache, a global prefix and a built checkout each run their own bin (1a)', () => {
  const temp = realTemp();
  const shapes = [
    [
      'managed runtime',
      'gmail',
      join(temp, 'data', 'runtime', `${VERSION}-gmail`, 'node_modules', '@agentcomms', 'gmail'),
    ],
    ['npx cache', 'slack', join(temp, 'npm', '_npx', '0a1b2c3d', 'node_modules', '@agentcomms', 'slack')],
    ['global prefix', 'resend', join(temp, 'prefix', 'lib', 'node_modules', '@agentcomms', 'resend')],
    ['built checkout', 'whatsapp', join(temp, 'checkout', 'packages', 'whatsapp')],
    ['managed core', 'core', join(temp, 'data', 'runtime', `${VERSION}-core`, 'node_modules', '@agentcomms', 'core')],
  ] as const;
  for (const [shape, channel, root] of shapes) {
    writePackage(root, channel, {
      files: ['dist/cli.mjs'],
      engines: channel === 'whatsapp' ? '>=22.16.0' : '>=22.12.0',
    });
    const entry = join(root, 'dist', 'cli.mjs');
    for (const platform of ['darwin', 'win32'] as const) {
      const result = locateCliCommand(
        request(moduleUrl(root, 'dist', 'cli.mjs'), channel, channel, { platform }),
        NODE,
      );
      const command = located(result);
      const words = [process.execPath, entry, ...PINS, 'approve', 'abc123'];
      assert.deepEqual(command.words, words, `${shape} on ${platform}`);
      assert.equal(command.platform, platform);
      // Rendered by the one quoting contract every printed command uses.
      assert.equal(command.line, quoteCommand(words, platform).line, `${shape} on ${platform}`);
      assert.equal(command.entry, entry);
      assert.ok(result.ok && result.basis.direction === 'own' && result.basis.entryKind === 'bin', shape);
      assert.ok(result.ok && result.basis.callerRoot === root && result.basis.targetRoot === root, shape);
    }
  }
});

test("own locator: a checkout run from source — the local launcher's shape — runs src/cli.ts with the strip flag (1a)", () => {
  const { packages } = writeCheckout(join(realTemp(), 'checkout'), ['gmail']);
  const root = packages.gmail as string;
  for (const platform of ['linux', 'win32'] as const) {
    const result = locateCliCommand(
      request(moduleUrl(root, 'src', 'mcp', 'install.ts'), 'gmail', 'gmail', { platform }),
      NODE,
    );
    const command = located(result);
    const words = [process.execPath, STRIP, join(root, 'src', 'cli.ts'), ...PINS, 'approve', 'abc123'];
    assert.deepEqual(command.words, words);
    assert.equal(command.line, quoteCommand(words, platform).line);
    assert.ok(result.ok && result.basis.callerSource && result.basis.entryKind === 'source');
  }
});

test('a located command cannot be made again from its constructor', () => {
  const root = writePackage(join(realTemp(), 'gmail'), 'gmail', { files: ['dist/cli.mjs'] });
  const command = located(locateCliCommand(request(moduleUrl(root, 'dist', 'cli.mjs'), 'gmail', 'gmail'), NODE));
  const Made = command.constructor as new (...args: unknown[]) => unknown;
  assert.throws(() => new Made(Symbol('forged'), ['agent-gmail', 'approve'], 'linux', '/x'), TypeError);
  assert.ok(Object.isFrozen(command) && Object.isFrozen(command.words));
});

// ── 1b: only the two allowed Node flags; source never looks at dist ─────────────────────────────────────────────────

test('only the strip flag, and transform-types from a source run that used it, are carried; nothing else in execArgv (1b)', () => {
  const { packages } = writeCheckout(join(realTemp(), 'checkout'), ['slack']);
  const root = packages.slack as string;
  const noisy = [
    '--inspect=9229',
    '--require',
    '/tmp/preload.cjs',
    '--import=./loader.mjs',
    '--conditions=development',
    '--no-warnings',
    '--disable-warning=ExperimentalWarning',
    '--enable-source-maps',
    '--max-old-space-size=4096',
    '--title=agent',
    '--test',
    '--eval=1',
    STRIP,
  ];
  const source = moduleUrl(root, 'src', 'mcp', 'install.ts');
  const entry = join(root, 'src', 'cli.ts');
  const flagsOf = (command: PrintedCommand) => command.words.slice(1, command.words.indexOf(command.entry));
  assert.deepEqual(
    flagsOf(located(locateCliCommand(request(source, 'slack', 'slack'), { version: 'v22.18.0', execArgv: noisy }))),
    [STRIP],
  );
  assert.deepEqual(
    flagsOf(
      located(
        locateCliCommand(request(source, 'slack', 'slack'), { version: 'v22.18.0', execArgv: [...noisy, TRANSFORM] }),
      ),
    ),
    [STRIP, TRANSFORM],
  );
  // With no flags at all, a TypeScript entry still gets the strip flag: Node 22.12–22.17 needs it.
  assert.deepEqual(
    flagsOf(located(locateCliCommand(request(source, 'slack', 'slack'), { version: 'v22.12.0', execArgv: [] }))),
    [STRIP],
  );
  assert.equal(located(locateCliCommand(request(source, 'slack', 'slack'), NODE)).entry, entry);
  // A built entry gets none, whatever the running process was started with.
  const built = moduleUrl(root, 'dist', 'cli.mjs');
  const command = located(
    locateCliCommand(request(built, 'slack', 'slack'), { version: 'v22.18.0', execArgv: [...noisy, TRANSFORM] }),
  );
  assert.deepEqual(command.words, [process.execPath, join(root, 'dist', 'cli.mjs'), ...PINS, 'approve', 'abc123']);
});

test('a source caller runs src/cli.ts whether dist is absent, stale or not a file at all (1b)', () => {
  const temp = realTemp();
  const variants: [string, (root: string) => void][] = [
    ['no dist', () => {}],
    [
      'a stale dist',
      (root) => {
        const stale = writeFile(join(root, 'dist', 'cli.mjs'), 'throw new Error("stale");\n');
        utimesSync(stale, new Date(2020, 0, 1), new Date(2020, 0, 1));
      },
    ],
    ['dist/cli.mjs a directory', (root) => mkdirSync(join(root, 'dist', 'cli.mjs'), { recursive: true })],
  ];
  for (const [name, arrange] of variants) {
    const root = writePackage(join(temp, name.replace(/\W+/g, '-')), 'gmail', {
      files: ['src/cli.ts', 'src/mcp/install.ts'],
    });
    arrange(root);
    const command = located(
      locateCliCommand(request(moduleUrl(root, 'src', 'mcp', 'install.ts'), 'gmail', 'gmail'), NODE),
    );
    assert.equal(command.entry, join(root, 'src', 'cli.ts'), name);
    assert.deepEqual(command.words.slice(0, 3), [process.execPath, STRIP, join(root, 'src', 'cli.ts')], name);
  }
});

// ── 1c: the Gmail wrapper locates Gmail ─────────────────────────────────────────────────────────────────────────────

test("the Gmail wrapper locates Gmail from Gmail's own module, and never itself (1c)", () => {
  const modules = join(realTemp(), 'npx', 'node_modules', '@agentcomms');
  const gmail = writePackage(join(modules, 'gmail'), 'gmail', { files: ['dist/index.mjs', 'dist/cli.mjs'] });
  const wrapper = writePackage(join(modules, 'gmail-mcp'), 'gmail', {
    name: '@agentcomms/gmail-mcp',
    binary: null,
    bin: { 'agent-gmail-mcp': './dist/server.mjs' },
    files: ['dist/server.mjs'],
  });
  // What `@agentcomms/gmail` exports for it: a module of Gmail's own package, built.
  const command = located(locateCliCommand(request(moduleUrl(gmail, 'dist', 'index.mjs'), 'gmail', 'gmail'), NODE));
  assert.equal(command.entry, join(gmail, 'dist', 'cli.mjs'));
  // The wrapper's own module is not Gmail, whatever it says it is…
  notLocated(
    locateCliCommand(request(moduleUrl(wrapper, 'dist', 'server.mjs'), 'gmail', 'gmail'), NODE),
    'manifest',
    'gmail',
  );
  // …and as itself it is not Gmail's own CLI, so it is no own-product command either.
  const server = moduleUrl(wrapper, 'dist', 'server.mjs');
  const asItself = request(server, 'gmail', 'gmail', { caller: { url: server, packageName: '@agentcomms/gmail-mcp' } });
  notLocated(locateCliCommand(asItself, NODE), 'direction', 'gmail');
});

// ── 1d: a manifest or entry that is not right gives no command, and nothing in its place ───────────────────────────

test("no command, and no bare fallback, when the manifest's bin is missing or disagrees with agentcomms.binary (1d)", () => {
  const temp = realTemp();
  const cases: [string, Parameters<typeof writePackage>[2]][] = [
    ['no bin', { bin: null }],
    ['no agentcomms.binary', { binary: null }],
    ['agentcomms.binary names another command', { binary: 'agent-gmail2', bin: { 'agent-gmail2': './dist/cli.mjs' } }],
    ['bin names another command', { bin: { 'agent-gmail-old': './dist/cli.mjs' } }],
    ['bin is empty', { bin: { 'agent-gmail': '' } }],
  ];
  for (const [name, spec] of cases) {
    const root = writePackage(join(temp, name.replace(/\W+/g, '-')), 'gmail', { ...spec, files: ['dist/cli.mjs'] });
    notLocated(locateCliCommand(request(moduleUrl(root, 'dist', 'cli.mjs'), 'gmail', 'gmail'), NODE), 'bin', 'gmail');
  }
});

test('no command when the entry is missing, unreadable, a directory, or outside its package (1d)', () => {
  const temp = realTemp();
  const outside = writeFile(join(temp, 'elsewhere', 'cli.mjs'));
  const cases: [string, Parameters<typeof writePackage>[2], (root: string) => void][] = [
    ['missing', { files: [] }, () => {}],
    ['a directory', { files: [] }, (root) => mkdirSync(join(root, 'dist', 'cli.mjs'), { recursive: true })],
    ['a symlink out of the package', { files: [] }, (root) => link(outside, join(root, 'dist', 'cli.mjs'))],
    ['a bin path out of the package', { bin: { 'agent-gmail': '../elsewhere/cli.mjs' }, files: [] }, () => {}],
  ];
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    cases.push(['unreadable', { files: [] }, (root) => chmodSync(writeFile(join(root, 'dist', 'cli.mjs')), 0o000)]);
  }
  for (const [name, spec, arrange] of cases) {
    const root = writePackage(join(temp, name.replace(/\W+/g, '-')), 'gmail', spec);
    arrange(root);
    notLocated(locateCliCommand(request(moduleUrl(root, 'dist', 'cli.mjs'), 'gmail', 'gmail'), NODE), 'entry', 'gmail');
  }
  // A source caller whose src/cli.ts is gone does not fall back to a built entry.
  const source = writePackage(join(temp, 'no-source'), 'gmail', { files: ['src/mcp/install.ts', 'dist/cli.mjs'] });
  notLocated(
    locateCliCommand(request(moduleUrl(source, 'src', 'mcp', 'install.ts'), 'gmail', 'gmail'), NODE),
    'entry',
    'gmail',
  );
});

test('no command when the nearest manifest is not the product the caller says it is (1d)', () => {
  const temp = realTemp();
  const evil = writePackage(join(temp, 'evil'), 'gmail', { name: '@agentcomms/gmail-evil', files: ['dist/cli.mjs'] });
  notLocated(
    locateCliCommand(request(moduleUrl(evil, 'dist', 'cli.mjs'), 'gmail', 'gmail'), NODE),
    'manifest',
    'gmail',
  );
  // A package of its own nested inside the product's is still the nearest manifest, and it is not the product.
  const outer = writePackage(join(temp, 'outer'), 'slack', { files: ['dist/cli.mjs'] });
  writeFileSync(join(outer, 'dist', 'package.json'), '{"type":"module"}\n');
  notLocated(
    locateCliCommand(request(moduleUrl(outer, 'dist', 'cli.mjs'), 'slack', 'slack'), NODE),
    'manifest',
    'slack',
  );
  const broken = join(temp, 'broken');
  writeFile(join(broken, 'dist', 'cli.mjs'));
  writeFileSync(join(broken, 'package.json'), '{ not json');
  notLocated(
    locateCliCommand(request(moduleUrl(broken, 'dist', 'cli.mjs'), 'gmail', 'gmail'), NODE),
    'manifest',
    'gmail',
  );
  notLocated(locateCliCommand(request('https://example.invalid/cli.mjs', 'gmail', 'gmail'), NODE), 'caller', 'gmail');
});

// ── Node's engine range: the target's, against this Node ────────────────────────────────────────────────────────────

test("a Node outside the target's engines.node range gets no command, and the reason names the range", () => {
  const temp = realTemp();
  const whatsapp = writePackage(join(temp, 'whatsapp'), 'whatsapp', { engines: '>=22.16.0', files: ['dist/cli.mjs'] });
  const url = moduleUrl(whatsapp, 'dist', 'cli.mjs');
  const old = notLocated(
    locateCliCommand(request(url, 'whatsapp', 'whatsapp'), { version: 'v22.15.1', execArgv: [] }),
    'engine',
    'whatsapp',
  );
  assert.equal(old.nodeRange, '>=22.16.0');
  assert.match(old.message, />=22\.16\.0/);
  assert.match(old.message, /22\.15\.1/);
  located(locateCliCommand(request(url, 'whatsapp', 'whatsapp'), { version: 'v22.16.0', execArgv: [] }));
  // A range this cannot read, or none at all, is not taken as permission.
  for (const [name, engines] of [
    ['caret', '^22.12.0'],
    ['none', null],
  ] as const) {
    const root = writePackage(join(temp, name), 'gmail', { engines, files: ['dist/cli.mjs'] });
    notLocated(
      locateCliCommand(request(moduleUrl(root, 'dist', 'cli.mjs'), 'gmail', 'gmail'), NODE),
      'engine',
      'gmail',
    );
  }
  // Channel to core checks core's range, not the channel's.
  const { packages } = writeCheckout(join(temp, 'checkout'), ['gmail']);
  const core = notLocated(
    locateCliCommand(request(moduleUrl(packages.gmail as string, 'dist', 'cli.mjs'), 'gmail', 'core'), {
      version: 'v22.11.0',
      execArgv: [],
    }),
    'engine',
    'core',
  );
  assert.equal(core.nodeRange, '>=22.12.0');
});

test('engine ranges are read as semver comparators, and anything else is unknown', () => {
  assert.equal(satisfiesRange('22.18.0', '>=22.12.0'), true);
  assert.equal(satisfiesRange('v22.12.0', '>=22.12.0'), true);
  assert.equal(satisfiesRange('22.11.9', '>=22.12.0'), false);
  assert.equal(satisfiesRange('24.1.0', '>=22.12.0 <24.0.0'), false);
  assert.equal(satisfiesRange('20.19.0', '^20.19.0 || >=22.12.0'), null);
  assert.equal(satisfiesRange('20.19.0', '>=20.19.0 <21.0.0 || >=22.12.0'), true);
  assert.equal(satisfiesRange('22.12.0', '=22.12.0'), true);
  assert.equal(satisfiesRange('22.12.0', '22.12.0'), true);
  assert.equal(satisfiesRange('22.12.0', '>22.12.0'), false);
  assert.equal(satisfiesRange('22.12.0', '<=22.12.0'), true);
  assert.equal(satisfiesRange('22.12.0', ''), null);
  assert.equal(satisfiesRange('22.12.0', '>=22'), null);
  assert.equal(satisfiesRange('not a version', '>=22.12.0'), null);
});

// ── 2a: channel to core ─────────────────────────────────────────────────────────────────────────────────────────────

test("a source channel in the same checkout runs core's src/cli.ts, with core's dist absent or stale (2a)", () => {
  for (const coreFiles of [['src/cli.ts'], ['src/cli.ts', 'dist/cli.mjs']]) {
    const checkout = writeCheckout(join(realTemp(), 'checkout'), ['gmail'], { coreFiles });
    const gmail = checkout.packages.gmail as string;
    const result = locateCliCommand(request(moduleUrl(gmail, 'src', 'mcp', 'install.ts'), 'gmail', 'core'), NODE);
    const command = located(result);
    assert.deepEqual(command.words, [
      process.execPath,
      STRIP,
      join(checkout.core, 'src', 'cli.ts'),
      ...PINS,
      'approve',
      'abc123',
    ]);
    assert.ok(result.ok);
    assert.deepEqual(result.basis, {
      direction: 'channel-to-core',
      callerSource: true,
      callerRoot: gmail,
      callerVersion: VERSION,
      targetRoot: checkout.core,
      targetVersion: VERSION,
      callerWorkspace: checkout.root,
      targetWorkspace: checkout.root,
      sameCheckout: true,
      entryKind: 'source',
    });
  }
});

test("a built channel runs core's manifest bin, even beside core's source in the same checkout (2a)", () => {
  const checkout = writeCheckout(join(realTemp(), 'checkout'), ['slack']);
  const slack = checkout.packages.slack as string;
  const result = locateCliCommand(request(moduleUrl(slack, 'dist', 'cli.mjs'), 'slack', 'core'), NODE);
  assert.deepEqual(located(result).words, [
    process.execPath,
    join(checkout.core, 'dist', 'cli.mjs'),
    ...PINS,
    'approve',
    'abc123',
  ]);
  assert.ok(result.ok);
  assert.equal(result.basis.callerSource, false);
  assert.equal(result.basis.sameCheckout, true);
  assert.equal(result.basis.entryKind, 'bin');
  // And with no build of core, there is nothing to run: core's source is not a fallback for a built caller.
  const unbuilt = writeCheckout(join(realTemp(), 'checkout'), ['slack'], { coreFiles: ['src/cli.ts'] });
  notLocated(
    locateCliCommand(request(moduleUrl(unbuilt.packages.slack as string, 'dist', 'cli.mjs'), 'slack', 'core'), NODE),
    'entry',
    'core',
  );
});

test("a source channel with an installed core, not a workspace package, runs that core's bin (2a)", () => {
  const checkout = writeCheckout(join(realTemp(), 'checkout'), ['resend']);
  const resend = checkout.packages.resend as string;
  // The link pnpm made, replaced by an installed copy: inside the checkout, but no workspace package of it.
  const installed = join(resend, 'node_modules', '@agentcomms', 'core');
  const linked = realpathSync(installed);
  assert.equal(linked, checkout.core);
  rmLink(installed);
  writePackage(installed, 'core', { files: ['dist/cli.mjs', 'src/cli.ts'] });
  const result = locateCliCommand(request(moduleUrl(resend, 'src', 'mcp', 'install.ts'), 'resend', 'core'), NODE);
  assert.equal(located(result).entry, join(installed, 'dist', 'cli.mjs'));
  assert.ok(result.ok);
  assert.equal(result.basis.callerSource, true);
  assert.equal(result.basis.callerWorkspace, checkout.root);
  assert.equal(result.basis.targetWorkspace, null);
  assert.equal(result.basis.sameCheckout, false);
  assert.equal(result.basis.entryKind, 'bin');
});

test("a source channel whose core is in another checkout runs that core's bin (2a)", () => {
  const temp = realTemp();
  const here = writeCheckout(join(temp, 'here'), ['gmail']);
  const there = writeCheckout(join(temp, 'there'), []);
  const gmail = here.packages.gmail as string;
  rmLink(join(gmail, 'node_modules', '@agentcomms', 'core'));
  symlinkSync(there.core, join(gmail, 'node_modules', '@agentcomms', 'core'));
  const result = locateCliCommand(request(moduleUrl(gmail, 'src', 'mcp', 'install.ts'), 'gmail', 'core'), NODE);
  assert.equal(located(result).entry, join(there.core, 'dist', 'cli.mjs'));
  assert.ok(result.ok);
  assert.equal(result.basis.targetRoot, there.core);
  assert.equal(result.basis.callerWorkspace, here.root);
  assert.equal(result.basis.targetWorkspace, there.root);
  assert.equal(result.basis.sameCheckout, false);
});

test('a workspace that does not list core as one of its packages is not the same checkout (2a)', () => {
  const checkout = writeCheckout(join(realTemp(), 'checkout'), ['gmail']);
  writeFileSync(join(checkout.root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/gmail\n  - "!packages/core"\n');
  const result = locateCliCommand(
    request(moduleUrl(checkout.packages.gmail as string, 'src', 'mcp', 'install.ts'), 'gmail', 'core'),
    NODE,
  );
  assert.equal(located(result).entry, join(checkout.core, 'dist', 'cli.mjs'));
  assert.ok(result.ok);
  assert.equal(result.basis.callerWorkspace, checkout.root);
  assert.equal(result.basis.targetWorkspace, null);
  assert.equal(result.basis.sameCheckout, false);
});

test('channel and core at different versions, no core at all, or a core that is not core give no command (2a)', () => {
  const temp = realTemp();
  const older = writeCheckout(join(temp, 'older'), ['gmail'], { coreVersion: '0.12.0' });
  const mismatch = notLocated(
    locateCliCommand(
      request(moduleUrl(older.packages.gmail as string, 'src', 'mcp', 'install.ts'), 'gmail', 'core'),
      NODE,
    ),
    'version',
    'core',
  );
  assert.match(mismatch.message, /0\.12\.0/);
  const alone = writePackage(join(temp, 'alone'), 'gmail', { files: ['src/mcp/install.ts', 'dist/cli.mjs'] });
  notLocated(locateCliCommand(request(moduleUrl(alone, 'dist', 'cli.mjs'), 'gmail', 'core'), NODE), 'core', 'core');
  const impostor = writePackage(join(temp, 'impostor'), 'slack', { files: ['dist/cli.mjs'] });
  writePackage(join(impostor, 'node_modules', '@agentcomms', 'core'), 'core', { name: '@agentcomms/core-evil' });
  notLocated(
    locateCliCommand(request(moduleUrl(impostor, 'dist', 'cli.mjs'), 'slack', 'core'), NODE),
    'manifest',
    'core',
  );
});

// ── Another product: from what is registered with the person's clients, never trusting or running it ────────────────

/** A built package of `channel` to print from: its own module is what a caller's `import.meta.url` would be. */
function printer(channel: string, version = VERSION): string {
  const root = writePackage(join(realTemp('printer-'), shortName(channel)), channel, {
    version,
    files: ['dist/cli.mjs'],
  });
  return moduleUrl(root, 'dist', 'cli.mjs');
}

/** Locating `target`'s command from a built `from`, given these registrations. */
function fromRegistrations(
  from: string,
  target: string,
  registrations: readonly RegisteredServer[] | undefined,
  overrides: Partial<CliCommandRequest> = {},
  runtime: NodeRuntime = NODE,
): CliCommandResult {
  return locateCliCommand(
    request(printer(from), from, target, {
      ...(registrations === undefined ? {} : { registrations }),
      ...overrides,
    }),
    runtime,
  );
}

/** Why each registration of the product was not used, in the order given. */
function whyNot(result: CliCommandResult): string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : (result.registrations ?? []).map(({ why }) => why);
}

test('with no registrations given, another product is not located, and nothing is guessed', () => {
  // Core asking for a channel's command, and a channel asking for another's: the same direction.
  const none = notLocated(fromRegistrations('core', 'whatsapp', undefined), 'no-registrations', 'whatsapp');
  assert.match(none.detail, /nothing registered was given/);
  notLocated(fromRegistrations('gmail', 'slack', undefined), 'no-registrations', 'slack');
  // An empty list was looked through: there is nothing registered, and it says so.
  assert.deepEqual(whyNot(notLocated(fromRegistrations('core', 'slack', []), 'not-registered', 'slack')), []);
});

test("a built caller runs another product's local source registration with the strip flag (0000)", () => {
  const { packages } = writeCheckout(join(realTemp(), 'checkout'), ['slack']);
  const slack = packages.slack as string;
  rmSyncTree(join(slack, 'dist'));
  const entry = join(slack, 'src', 'cli.ts');
  const local = registration({
    name: 'slack',
    command: '/opt/elsewhere/node',
    args: [
      STRIP,
      '--disable-warning=ExperimentalWarning',
      entry,
      ...pinArgs(PATHS),
      'mcp',
      '--workspace',
      'acme/slack',
    ],
  });
  // The caller was started with transform-types, but it is built: no source run of its own to carry it from.
  const result = fromRegistrations('gmail', 'slack', [local], {}, { version: 'v22.12.0', execArgv: [TRANSFORM] });
  const command = located(result);
  assert.deepEqual(command.words, [process.execPath, STRIP, entry, ...PINS, 'approve', 'abc123']);
  assert.ok(result.ok);
  assert.equal(result.basis.direction, 'cross-product');
  assert.equal(result.basis.entryKind, 'source');
  assert.deepEqual(result.basis.registration, {
    client: 'claude-code',
    path: '/cfg/.claude.json',
    name: 'slack',
    launcher: 'local',
  });
});

test('an npx registration is never used for another product, its cache there or not (000a)', () => {
  const home = realTemp('home-');
  const cache = join(home, '.npm', '_npx', '5f2e1a', 'node_modules', '@agentcomms');
  const spec = `@agentcomms/slack@${VERSION}`;
  const npx = [
    registration({ name: 'slack', command: '/usr/local/bin/npx', args: ['-y', spec, ...pinArgs(PATHS), 'mcp'] }),
    registration({ name: 'slack-win', command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', spec, 'mcp'] }),
    registration({ name: 'slack-bare', command: 'npx', args: ['-y', spec, 'mcp'] }),
    // npx running another Node over the cached package's own file: a real file, while the cache lasts, and still npx.
    registration({
      name: 'slack-cached',
      command: '/usr/local/bin/npx',
      args: ['-y', 'node@24', join(cache, 'slack', 'dist', 'cli.mjs'), 'mcp'],
    }),
  ];
  for (const cached of [false, true]) {
    if (cached) writePackage(join(cache, 'slack'), 'slack', { files: ['dist/cli.mjs'] });
    for (const platform of ['linux', 'win32'] as const) {
      const result = notLocated(fromRegistrations('core', 'slack', npx, { platform }), 'not-registered', 'slack');
      assert.deepEqual(
        whyNot(result),
        ['npx', 'npx', 'npx', 'npx'],
        `cache ${cached ? 'present' : 'evicted'}, ${platform}`,
      );
    }
  }
  // Gmail's npx launcher starts its wrapper package; that is npx too.
  const gmail = registration({
    name: 'gmail',
    command: '/usr/local/bin/npx',
    args: ['-y', `@agentcomms/gmail-mcp@${VERSION}`],
  });
  assert.deepEqual(whyNot(notLocated(fromRegistrations('core', 'gmail', [gmail]), 'not-registered', 'gmail')), ['npx']);
});

test("a folder pinned under another package's name never makes a registration that product's (000b)", () => {
  const temp = realTemp();
  const { entry } = writeManaged(join(temp, 'data'), 'gmail');
  const decoy = join(temp, 'pins', '@agentcomms', 'slack');
  for (const pins of [
    ['--config-dir', decoy, '--state-dir', join(decoy, 'state'), '--data-dir', decoy, '--secrets-dir', decoy],
    [
      `--config-dir=${decoy}`,
      `--state-dir=${decoy}`,
      `--data-dir=${decoy}`,
      `--secrets-dir=${join(decoy, 'packages', 'slack', 'src', 'cli.ts')}`,
    ],
  ]) {
    const gmail = registration({ name: 'gmail', command: '/opt/node/bin/node', args: [entry, ...pins, 'mcp'] });
    for (const platform of ['darwin', 'win32'] as const) {
      // Recognised as the Gmail it is, and located…
      assert.equal(located(fromRegistrations('core', 'gmail', [gmail], { platform })).entry, entry, platform);
      // …and not as Slack, which it is not: there is no Slack registration at all.
      assert.deepEqual(
        whyNot(notLocated(fromRegistrations('core', 'slack', [gmail], { platform }), 'not-registered', 'slack')),
        [],
      );
    }
  }
});

test('no registered interpreter is ever run or asked anything, and only this Node runs the command (000c)', () => {
  const temp = realTemp();
  const changed = markingProgram(join(temp, 'bin'), 'node');
  const handMadeInterpreter = markingProgram(join(temp, 'bin'), 'node24');
  // A genuine managed registration whose interpreter was changed, and a hand-written one in the managed shape.
  const genuine = writeManaged(join(temp, 'data'), 'slack');
  const handMade = writeManaged(join(temp, 'elsewhere'), 'resend', { handMade: true });
  const registrations = [
    registration({ name: 'slack', command: changed.path, args: [genuine.entry, ...pinArgs(PATHS), 'mcp'] }),
    registration({ name: 'resend', command: handMadeInterpreter.path, args: [handMade.entry, 'mcp'] }),
  ];
  const spawned: string[] = [];
  const restore = spyOnChildProcesses(spawned);
  let results: CliCommandResult[];
  try {
    results = [fromRegistrations('core', 'slack', registrations), fromRegistrations('gmail', 'resend', registrations)];
  } finally {
    restore();
  }
  assert.deepEqual(spawned, [], 'nothing was started');
  assert.equal(changed.ran() || handMadeInterpreter.ran(), false, 'neither registered interpreter ran');
  const [slack, resend] = results.map(located);
  assert.deepEqual(slack?.words.slice(0, 2), [process.execPath, genuine.entry]);
  assert.deepEqual(resend?.words.slice(0, 2), [process.execPath, handMade.entry]);
  for (const command of [slack, resend]) {
    assert.ok(!command?.words.includes(changed.path) && !command?.words.includes(handMadeInterpreter.path));
  }
});

test("a Node outside the target's range gets no command, whatever the registration's interpreter (000d, 0a)", () => {
  const temp = realTemp();
  const newer = markingProgram(join(temp, 'node-24', 'bin'), 'node');
  const managed = writeManaged(join(temp, 'data'), 'whatsapp', { spec: { engines: '>=22.16.0' } });
  const global = writeGlobal(join(temp, 'prefix'), 'whatsapp', { spec: { engines: '>=22.16.0' } });
  for (const [launcher, server] of [
    ['managed', registration({ name: 'whatsapp', command: newer.path, args: [managed.entry, 'mcp'] })],
    ['global', registration({ name: 'whatsapp', command: global.command, args: ['mcp'] })],
  ] as const) {
    for (const version of ['v22.12.0', 'v22.15.1']) {
      const result = notLocated(
        fromRegistrations('core', 'whatsapp', [server], {}, { version, execArgv: [] }),
        'engine',
        'whatsapp',
      );
      assert.equal(result.nodeRange, '>=22.16.0', launcher);
      assert.match(result.message, /needs Node >=22\.16\.0/);
    }
    located(fromRegistrations('core', 'whatsapp', [server], {}, { version: 'v22.16.0', execArgv: [] }));
  }
  assert.equal(newer.ran(), false);
  // And Gmail's own floor, for a Node below it.
  const gmail = writeManaged(join(temp, 'data'), 'gmail');
  const below = registration({ name: 'gmail', command: newer.path, args: [gmail.entry, 'mcp'] });
  const old = notLocated(
    fromRegistrations('core', 'gmail', [below], {}, { version: 'v22.11.0', execArgv: [] }),
    'engine',
    'gmail',
  );
  assert.equal(old.nodeRange, '>=22.12.0');
});

test('core with only npx registrations of a channel prints nothing, whatever Node each place has (00a)', () => {
  const home = realTemp('home-');
  const npx = (channel: string, env: Record<string, string>) =>
    registration({
      name: channel,
      command: '/opt/node-24/bin/npx',
      args: ['-y', `${suiteEntry(channel).packageName}@${VERSION}`, ...pinArgs(PATHS), 'mcp'],
      env,
    });
  for (const cached of [false, true]) {
    if (cached) {
      for (const channel of ['slack', 'whatsapp']) {
        writePackage(join(home, '.npm', '_npx', channel, 'node_modules', '@agentcomms', channel), channel, {
          files: ['dist/cli.mjs'],
        });
      }
    }
    for (const caller of ['v22.12.0', 'v22.18.0', 'v24.1.0']) {
      for (const registered of [
        { PATH: '/opt/node-22.12/bin' },
        { PATH: '/opt/node-24/bin', NODE_OPTIONS: '--max-old-space-size=64' },
      ]) {
        for (const channel of ['slack', 'whatsapp']) {
          const result = fromRegistrations(
            'core',
            channel,
            [npx(channel, registered)],
            {},
            { version: caller, execArgv: [] },
          );
          assert.deepEqual(
            whyNot(notLocated(result, 'not-registered', channel)),
            ['npx'],
            `${channel} ${caller} ${cached}`,
          );
        }
      }
    }
  }
});

test('only a registration of the same version is used, managed first, then by client, file, name, command and arguments (2b)', () => {
  const temp = realTemp();
  const old = writeManaged(join(temp, 'data'), 'slack', { version: '0.12.0' });
  const current = writeManaged(join(temp, 'data'), 'slack');
  const global = writeGlobal(join(temp, 'prefix'), 'slack');
  const { packages } = writeCheckout(join(temp, 'checkout'), ['slack']);
  const localEntry = join(packages.slack as string, 'src', 'cli.ts');
  const node = '/opt/node/bin/node';
  const olderManaged = registration({ name: 'slack-old', command: node, args: [old.entry, 'mcp'] });
  const globalOne = registration({
    client: 'codex',
    path: '/cfg/codex.toml',
    name: 'slack-global',
    command: global.command,
    args: ['mcp'],
  });
  const localOne = registration({
    client: 'cursor',
    name: 'slack-local',
    command: node,
    args: [STRIP, localEntry, 'mcp'],
  });
  // `data~` sorts after `data` followed by either separator: `data2` came after `data/` on POSIX but before `data\`
  // on Windows, where the backslash sorts after the digits.
  const other = writeManaged(join(temp, 'data~'), 'slack');
  const managedAt = (client: string, path: string, name: string, command = node, entry = other.entry) =>
    registration({ client, path, name, command, args: [entry, 'mcp'] });

  // Older only: nothing.
  assert.deepEqual(whyNot(notLocated(fromRegistrations('core', 'slack', [olderManaged]), 'not-registered', 'slack')), [
    'version',
  ]);
  // An older managed one and a current global one: the current one, though managed ranks first.
  const mixed = fromRegistrations('core', 'slack', [olderManaged, globalOne]);
  assert.equal(located(mixed).entry, join(global.root, 'dist', 'cli.mjs'));
  // A current managed one beats current file entries of every other launcher.
  const best = fromRegistrations('core', 'slack', [localOne, globalOne, managedAt('vscode', '/z', 'z')]);
  assert.ok(best.ok && best.basis.registration?.launcher === 'managed' && best.basis.registration.name === 'z');
  // Without one, any other checked file entry: a local source checkout or a global install, by client.
  const files = fromRegistrations('core', 'slack', [localOne, globalOne]);
  assert.ok(files.ok && files.basis.registration?.name === 'slack-global', 'codex sorts before cursor');
  // Ties: client, then config file, then server name, then command, then arguments, whatever order they came in. Only
  // the first runs `current`; each of the others would show itself by running `other`.
  const ladder = [
    managedAt('codex', '/a', 'b'),
    managedAt('claude-code', '/b', 'b'),
    managedAt('claude-code', '/a', 'c'),
    managedAt('claude-code', '/a', 'b', '/p'),
    managedAt('claude-code', '/a', 'b', node, other.entry),
    managedAt('claude-code', '/a', 'b', node, current.entry),
  ];
  assert.ok(current.entry < other.entry, 'the arguments sort as the test means them to');
  for (const order of [ladder, [...ladder].reverse()]) {
    assert.equal(located(fromRegistrations('core', 'slack', order)).entry, current.entry);
  }
  // The registration's own server words — `mcp`, its pin, its path pins — are never part of the command.
  const command = located(fromRegistrations('core', 'slack', ladder));
  assert.deepEqual(command.words.slice(2), [...PINS, 'approve', 'abc123']);
});

test('a Windows npm .cmd registration is used when its package is this version and can be read (2c)', () => {
  const temp = realTemp();
  const windows = { platform: 'win32' as const };
  const at = (prefix: string, version?: string) =>
    writeGlobal(join(temp, prefix), 'gmail', { windows: true, ...(version ? { version } : {}) });
  const matching = at('matching');
  const server = (command: string) => registration({ name: 'gmail', command, args: ['--inbox', 'work'] });
  const result = fromRegistrations('core', 'gmail', [server(matching.command)], windows);
  assert.equal(located(result).entry, join(matching.root, 'dist', 'cli.mjs'));
  assert.ok(result.ok && result.basis.registration?.launcher === 'other');
  const older = at('older', '0.12.0');
  assert.deepEqual(
    whyNot(notLocated(fromRegistrations('core', 'gmail', [server(older.command)], windows), 'not-registered', 'gmail')),
    ['version'],
  );
  const unreadable = at('unreadable');
  writeFileSync(join(unreadable.root, 'package.json'), '{ not json');
  assert.deepEqual(
    whyNot(
      notLocated(fromRegistrations('core', 'gmail', [server(unreadable.command)], windows), 'not-registered', 'gmail'),
    ),
    ['no-package'],
  );
  const gone = at('gone');
  rmSyncTree(gone.root);
  assert.deepEqual(
    whyNot(notLocated(fromRegistrations('core', 'gmail', [server(gone.command)], windows), 'not-registered', 'gmail')),
    ['no-package'],
  );
});

test('nothing usable is "not locatable here", named exactly, with the usual route and no repair (2d)', () => {
  const temp = realTemp();
  const older = writeManaged(join(temp, 'data'), 'resend', { version: '0.12.0' });
  const unknown = writeGlobal(join(temp, 'unknown'), 'resend');
  const manifest = JSON.parse(readFileSync(join(unknown.root, 'package.json'), 'utf8')) as Record<string, unknown>;
  delete manifest.version;
  writeFileSync(join(unknown.root, 'package.json'), JSON.stringify(manifest));
  const missing = writeManaged(join(temp, 'missing'), 'resend');
  rmSyncTree(join(missing.root, 'dist'));
  const cases: [string, RegisteredServer[], string[]][] = [
    ['older only', [registration({ name: 'resend', command: '/n', args: [older.entry, 'mcp'] })], ['version']],
    ['an unknown version', [registration({ name: 'resend', command: unknown.command, args: ['mcp'] })], ['version']],
    [
      'an entry that is gone',
      [registration({ name: 'resend', command: '/n', args: [missing.entry, 'mcp'] })],
      ['entry'],
    ],
    ['nothing at all', [], []],
  ];
  for (const [name, registrations, why] of cases) {
    const result = notLocated(fromRegistrations('core', 'resend', registrations), 'not-registered', 'resend');
    assert.deepEqual(whyNot(result), why, name);
    assert.equal(
      result.message,
      `Resend ${VERSION} (@agentcomms/resend) is not locatable here: ${result.detail}. Install or update it through your usual route, then try again.`,
      name,
    );
    // No command, no repair and no route through a chat: nothing to run, install, update or approve with.
    assert.doesNotMatch(result.message, /`|comms_|mcp install|server install|agentcomms update|approve|--force/, name);
  }
});

test('Windows reads a registration without case, POSIX with it (2e)', () => {
  const temp = realTemp();
  // A command and package path in another case, as Windows writes and finds them, on disk in that case.
  const prefix = join(temp, 'prefix');
  const mixed = writeGlobal(prefix, 'gmail', { windows: true, command: 'Agent-Gmail.CMD' });
  const root = join(temp, 'data', 'Runtime', `${VERSION}-Gmail`, 'Node_Modules', '@AgentComms', 'Gmail');
  writePackage(root, 'gmail', { files: ['dist/cli.mjs'] });
  const shapes = [
    registration({ name: 'cmd', command: mixed.command, args: ['mcp'] }),
    registration({ name: 'managed', command: '/n', args: [join(root, 'Dist', 'CLI.mjs'), 'mcp'] }),
  ];
  for (const server of shapes) {
    const windows = located(fromRegistrations('core', 'gmail', [server], { platform: 'win32' }));
    assert.ok(windows.entry.endsWith(join('dist', 'cli.mjs')), server.name);
    assert.deepEqual(
      whyNot(
        notLocated(fromRegistrations('core', 'gmail', [server], { platform: 'linux' }), 'not-registered', 'gmail'),
      ),
      [],
      server.name,
    );
  }
  // A file-backed candidate that is not a full path depends on where it is run from, and is not used.
  for (const server of [
    registration({ name: 'bare', command: 'agent-gmail', args: ['mcp'] }),
    registration({ name: 'relative', command: '/n', args: ['node_modules/@agentcomms/gmail/dist/cli.mjs', 'mcp'] }),
  ]) {
    assert.deepEqual(
      whyNot(notLocated(fromRegistrations('core', 'gmail', [server]), 'not-registered', 'gmail')),
      ['no-file'],
      server.name,
    );
  }
});

test("a registration's own path options, however written, never reach the command, and a broken one is not used (3h-registered)", () => {
  const temp = realTemp();
  const { entry } = writeManaged(join(temp, 'data'), 'slack');
  const messy = registration({
    name: 'slack',
    command: '/n',
    args: [
      entry,
      '--secrets-dir=relative/secrets',
      '--config-dir',
      'one',
      `--config-dir=${join(temp, 'two')}`,
      '--state-dir',
      './state/',
      '--data-dir',
      `${temp}//data//`,
      'mcp',
      '--workspace',
      'acme/slack',
    ],
  });
  const away = realTemp('cwd-');
  const before = process.cwd();
  process.chdir(away);
  try {
    const command = located(fromRegistrations('core', 'slack', [messy], { uses: ['secretsDir', 'configDir'] }));
    assert.deepEqual(command.words, [
      process.execPath,
      entry,
      '--config-dir',
      PATHS.configDir,
      '--secrets-dir',
      PATHS.secretsDir,
      'approve',
      'abc123',
    ]);
  } finally {
    process.chdir(before);
  }
  // A spaced path option with no value before `--` is an installation error: that entry is not used at all.
  const broken = registration({ name: 'slack', command: '/n', args: [entry, '--state-dir', '--', 'mcp'] });
  assert.deepEqual(whyNot(notLocated(fromRegistrations('core', 'slack', [broken]), 'not-registered', 'slack')), [
    'arguments',
  ]);
});

test('an entry is checked inside its package by whole segments, as written and through links (5a-containment)', () => {
  const temp = realTemp();
  const outside = writeFile(join(temp, 'outside', 'cli.mjs'));
  writeFile(join(temp, 'p3', 'lib', 'node_modules', '@agentcomms', 'slack-evil', 'dist', 'cli.mjs'));
  const escapes: [string, (root: string) => Parameters<typeof writePackage>[2]][] = [
    ['p1', () => ({ bin: { 'agent-slack': '../../../../../outside/cli.mjs' } })],
    [
      'p2',
      (root) => {
        rmSyncTree(join(root, 'dist'));
        link(outside, join(root, 'dist', 'cli.mjs'));
        return {};
      },
    ],
    ['p3', () => ({ bin: { 'agent-slack': '../slack-evil/dist/cli.mjs' } })],
  ];
  for (const [prefix, arrange] of escapes) {
    const { root } = writeGlobal(join(temp, prefix), 'slack');
    writePackage(root, 'slack', { files: [], ...arrange(root) });
    const server = registration({ name: prefix, command: join(temp, prefix, 'bin', 'agent-slack'), args: ['mcp'] });
    assert.deepEqual(
      whyNot(notLocated(fromRegistrations('core', 'slack', [server]), 'not-registered', 'slack')),
      ['entry'],
      prefix,
    );
  }
  // A link into the package is not an escape: a POSIX global command is one, and its real file is checked.
  const fine = writeGlobal(join(temp, 'fine'), 'slack');
  const viaLink = registration({ name: 'fine', command: fine.command, args: ['mcp'] });
  assert.equal(located(fromRegistrations('core', 'slack', [viaLink])).entry, join(fine.root, 'dist', 'cli.mjs'));
});

test("Gmail's wrapper, installed on its own, locates the Gmail it depends on", () => {
  const modules = join(realTemp(), 'prefix', 'lib', 'node_modules', '@agentcomms');
  const wrapper = writePackage(join(modules, 'gmail-mcp'), 'gmail', {
    name: '@agentcomms/gmail-mcp',
    binary: null,
    bin: { 'agent-gmail-mcp': './dist/server.mjs' },
    files: ['dist/server.mjs'],
  });
  const gmail = writePackage(join(wrapper, 'node_modules', '@agentcomms', 'gmail'), 'gmail', {
    files: ['dist/cli.mjs'],
  });
  const server = registration({
    name: 'gmail',
    command: '/n',
    args: [join(wrapper, 'dist', 'server.mjs'), '--inbox', 'work'],
  });
  assert.equal(located(fromRegistrations('slack', 'gmail', [server])).entry, join(gmail, 'dist', 'cli.mjs'));
});

test('own product and channel to core never read the registrations they are given', () => {
  const temp = realTemp();
  const decoy = writeManaged(join(temp, 'data'), 'gmail');
  const registrations = [registration({ name: 'gmail', command: '/n', args: [decoy.entry, 'mcp'] })];
  const checkout = writeCheckout(join(temp, 'checkout'), ['gmail']);
  const gmail = checkout.packages.gmail as string;
  const own = located(
    locateCliCommand(request(moduleUrl(gmail, 'dist', 'cli.mjs'), 'gmail', 'gmail', { registrations }), NODE),
  );
  assert.equal(own.entry, join(gmail, 'dist', 'cli.mjs'));
  const core = located(
    locateCliCommand(request(moduleUrl(gmail, 'dist', 'cli.mjs'), 'gmail', 'core', { registrations }), NODE),
  );
  assert.equal(core.entry, join(checkout.core, 'dist', 'cli.mjs'));
});

/** Records every attempt to start a process, through every function `node:child_process` has, until restored. */
function spyOnChildProcesses(calls: string[]): () => void {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const module = childProcess as unknown as Record<string, unknown>;
  const originals = names.map((name) => module[name]);
  for (const name of names) {
    module[name] = (...args: unknown[]) => {
      calls.push(`${name} ${JSON.stringify(args[0])}`);
      throw new Error(`${name} was called`);
    };
  }
  syncBuiltinESMExports();
  return () => {
    names.forEach((name, index) => {
      module[name] = originals[index];
    });
    syncBuiltinESMExports();
  };
}

/** Removes a directory tree that a test made. */
function rmSyncTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

// ── Time of print (D6): checked when printed, not frozen; nothing else is ever run in its place ──────────────────────

const POSIX = process.platform !== 'win32';

/** Runs `body` with this process's `PATH` set to `path`, as a person's shell might have it, and puts it back. */
function withPath<T>(path: string, body: () => T): T {
  const before = process.env.PATH;
  process.env.PATH = path;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
}

test("an npx-launched process's own command names its cache entry, and fails cleanly once the cache is gone (5b)", () => {
  /*
   * Proves: the command names the file found when it was printed, and when that file is evicted — the entry alone, or
   * the whole npx cache — running it fails with Node's own missing-module error naming that file, and nothing found by
   * name on PATH runs instead; located again, there is no command. Cannot prove that a cache is never evicted, or
   * that a person will not run some other command themselves: that is the person's shell. On Windows the decoy cannot
   * run at all, so there only the absolute program and the missing-file failure are what is shown.
   */
  const home = realTemp('home-');
  const decoys = join(home, 'decoys');
  const decoy = markingProgram(decoys, 'agent-slack');
  const { cache, root, entry } = writeNpxCache(home, 'slack', '5f2e1a', 'slack from the npx cache');
  const ownCommand = request(moduleUrl(root, 'dist', 'cli.mjs'), 'slack', 'slack');
  const command = located(withPath(decoys, () => locateCliCommand(ownCommand, NODE)));
  const printed = [...command.words];
  assert.deepEqual(printed.slice(0, 2), [process.execPath, entry]);
  const env = bareEnv({ PATH: decoys });
  const ran = runPrinted(command, env);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), {
    fixture: 'slack from the npx cache',
    args: [...PINS, 'approve', 'abc123'],
  });
  for (const [evicted, reason] of [
    [entry, 'entry'],
    [cache, 'manifest'],
  ] as const) {
    rmSyncTree(evicted);
    const gone = runPrinted(command, env);
    assert.notEqual(gone.status, 0, `${evicted} gone`);
    assert.equal(gone.stdout, '');
    assert.match(gone.stderr, /Cannot find module/);
    assert.ok(gone.stderr.includes(entry), gone.stderr);
    assert.equal(decoy.ran(), false, 'nothing on PATH ran in its place');
    assert.deepEqual(command.words, printed, 'and the command is still what was printed');
    notLocated(
      withPath(decoys, () => locateCliCommand(ownCommand, NODE)),
      reason,
      'slack',
    );
  }
});

test('a global install upgraded in place: the command printed before runs the newer code at that path (5c)', () => {
  /*
   * Proves: the guarantee is identity at the time of printing, not immutability. The command names the global
   * install's file; upgraded in place, the same words run the newer code there, while locating again now refuses that
   * registration, which is another release. Cannot prove the newer code is compatible: approval is data-only, and the
   * newer CLI checks digest, kind, expiry and policy itself (D6).
   */
  const temp = realTemp();
  const platform = process.platform;
  const global = writeGlobal(join(temp, 'prefix'), 'slack', { windows: platform === 'win32' });
  writeRunnable(join(global.root, 'dist', 'cli.mjs'), `slack ${VERSION}`);
  const server = registration({ name: 'slack', command: global.command, args: ['mcp'] });
  const command = located(fromRegistrations('core', 'slack', [server], { platform }));
  const printed = [...command.words];
  assert.equal(command.entry, join(global.root, 'dist', 'cli.mjs'));
  assert.equal(JSON.parse(runPrinted(command).stdout).fixture, `slack ${VERSION}`);
  // Upgraded in place by whatever installed it: the same folder, a newer release than this one.
  const [major, minor] = VERSION.split('.').map(Number);
  const newer = `${major}.${(minor ?? 0) + 1}.0`;
  writePackage(global.root, 'slack', { version: newer, files: [] });
  writeRunnable(join(global.root, 'dist', 'cli.mjs'), `slack ${newer}`);
  const after = runPrinted(command);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout).fixture, `slack ${newer}`, 'the same path runs what is there now');
  assert.deepEqual(command.words, printed);
  assert.deepEqual(
    whyNot(notLocated(fromRegistrations('core', 'slack', [server], { platform }), 'not-registered', 'slack')),
    ['version'],
  );
});

test('an entry replaced after printing runs as it is then, and is checked again only when located again (5a-replacement)', () => {
  /*
   * Proves: the checks — a real, readable file inside its package — hold when the command is printed. A same-user
   * replacement after that is what the command meets: its contents swapped, or (on POSIX, where a test can make one)
   * a link out of the package. Locating again checks again, and refuses the escape. Cannot prove anything about what
   * happens between printing and running: that is the same-OS-user boundary (SECURITY.md), which this does not move.
   */
  const temp = realTemp();
  const { root, entry } = writeManaged(join(temp, 'data'), 'slack');
  writeRunnable(entry, 'the slack that was checked');
  // Printed by another product from the registration, and by the installation for itself.
  const server = registration({ name: 'slack', command: '/n', args: [entry, 'mcp'] });
  const own = request(moduleUrl(root, 'dist', 'cli.mjs'), 'slack', 'slack');
  const commands = [located(fromRegistrations('core', 'slack', [server])), located(locateCliCommand(own, NODE))];
  for (const command of commands) {
    assert.equal(JSON.parse(runPrinted(command).stdout).fixture, 'the slack that was checked');
  }
  writeRunnable(entry, 'replaced in place');
  for (const command of commands) assert.equal(JSON.parse(runPrinted(command).stdout).fixture, 'replaced in place');
  assert.equal(located(fromRegistrations('core', 'slack', [server])).entry, entry, 'still inside its package');
  if (POSIX) {
    const outside = writeRunnable(join(temp, 'elsewhere', 'cli.mjs'), 'something outside the package');
    rmSyncTree(entry);
    link(outside, entry);
    for (const command of commands) {
      assert.equal(JSON.parse(runPrinted(command).stdout).fixture, 'something outside the package');
    }
    // Located again: the registration's own file now leads out of every package, and the entry out of its own.
    assert.deepEqual(whyNot(notLocated(fromRegistrations('core', 'slack', [server]), 'not-registered', 'slack')), [
      'no-package',
    ]);
    notLocated(locateCliCommand(own, NODE), 'entry', 'slack');
  }
});

test('a hostile NODE_OPTIONS preloader runs inside the printed command, and changes nothing the locator chooses (5d)', () => {
  /*
   * Proves two things, and claims no more. The boundary: the printed command does not neutralise `NODE_OPTIONS` — a
   * preloader set in the person's shell runs before the CLI, which still runs — because that shell is inside the
   * same-OS-user boundary (D6, SECURITY.md). The selection: preload, loader, inspector and other flags this process was
   * started with, or a `NODE_OPTIONS` it has, are never copied into the command or used to choose its file — in this
   * process, and in a child process that is itself started with a preloader. Cannot prove that a preloader in the
   * locating process could not patch the locator itself: it could, as any code running as that user could.
   */
  const temp = realTemp();
  const hostile = writePreloader(join(temp, 'hostile'));
  const { root, entry } = writeManaged(join(temp, 'data'), 'slack');
  writeRunnable(entry, 'slack');
  const { packages } = writeCheckout(join(temp, 'checkout'), ['gmail']);
  const built = request(moduleUrl(root, 'dist', 'cli.mjs'), 'slack', 'slack');
  const requests = [built, request(moduleUrl(packages.gmail as string, 'src', 'mcp', 'install.ts'), 'gmail', 'gmail')];
  // Every flag a debugging, preloading or tracing process might have been started with.
  const ambient = [
    '--require',
    hostile.path,
    `--require=${hostile.path}`,
    '--import',
    pathToFileURL(hostile.path).href,
    '--loader=./loader.mjs',
    '--experimental-loader',
    './loader.mjs',
    '--inspect',
    '--inspect-brk=0.0.0.0:9229',
    '--inspect-port=0',
    '--cpu-prof',
    '--heapsnapshot-signal=SIGUSR2',
    '--enable-source-maps',
    '--conditions=development',
    '--no-warnings',
    '--title=agent',
    '--max-old-space-size=64',
    STRIP,
  ];
  const nodeOptions = `--require=${hostile.path.replace(/\\/g, '/')} --inspect-port=0`;
  for (const each of requests) {
    const clean = located(locateCliCommand(each, NODE)).words;
    const preloaded = withEnv(
      { NODE_OPTIONS: nodeOptions },
      () => located(locateCliCommand(each, { version: NODE.version, execArgv: ambient })).words,
    );
    assert.deepEqual(preloaded, clean);
    for (const word of preloaded)
      assert.doesNotMatch(word, /^--(?:require|import|loader|experimental-loader|inspect|cpu-prof|title|max-old)/);
  }
  assert.equal(hostile.loaded(), false, 'locating loads nothing');

  // In a process of its own, started with a preloader of its own and NODE_OPTIONS: the same words as a clean one.
  const script = writeFile(
    join(temp, 'locate.mjs'),
    [
      `const { locateCliCommand } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/cli-command.ts', import.meta.url))).href)});`,
      `const result = locateCliCommand(JSON.parse(process.env.LOCATE_REQUEST));`,
      'process.stdout.write(JSON.stringify(result.ok ? result.command.words : result.message));',
    ].join('\n'),
  );
  const locateIn = (flags: string[], extra: Record<string, string>) => {
    const ran = spawnSync(process.execPath, [STRIP, ...flags, script], {
      encoding: 'utf8',
      env: bareEnv({ LOCATE_REQUEST: JSON.stringify(built), ...extra }),
    });
    assert.equal(ran.status, 0, ran.stderr);
    return JSON.parse(ran.stdout) as string[];
  };
  const cleanChild = locateIn([], {});
  const preloadedChild = locateIn(['--require', hostile.path, '--import=data:text/javascript,'], {
    NODE_OPTIONS: nodeOptions,
  });
  assert.ok(hostile.loaded(), 'the preloader ran in the locating process');
  assert.deepEqual(preloadedChild, cleanChild);
  assert.deepEqual(cleanChild, located(locateCliCommand(built, NODE)).words);

  // And it runs inside the command a person pastes: their shell's NODE_OPTIONS applies, the CLI still runs.
  const fresh = writePreloader(join(temp, 'shell'));
  const run = runPrinted(
    located(locateCliCommand(built, NODE)),
    bareEnv({ NODE_OPTIONS: `--require=${fresh.path.replace(/\\/g, '/')}` }),
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).fixture, 'slack');
  assert.ok(fresh.loaded(), 'the preloader ran: the command does not neutralise NODE_OPTIONS');
});

/** Runs `body` with these variables set in this process's environment, and puts them back. */
function withEnv<T>(values: Record<string, string>, body: () => T): T {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── The words: the caller's, after the entry, with the directories the command uses ────────────────────────────────

test('only the directories the command uses are pinned, between the entry and its words and before any --', () => {
  const root = writePackage(join(realTemp(), 'gmail'), 'gmail', { files: ['dist/cli.mjs'] });
  const url = moduleUrl(root, 'dist', 'cli.mjs');
  const entry = join(root, 'dist', 'cli.mjs');
  const one = located(
    locateCliCommand(
      request(url, 'gmail', 'gmail', { uses: ['secretsDir'], words: ['inbox', 'reauth', 'work'] }),
      NODE,
    ),
  );
  assert.deepEqual(one.words, [process.execPath, entry, '--secrets-dir', PATHS.secretsDir, 'inbox', 'reauth', 'work']);
  const download = located(
    locateCliCommand(
      request(url, 'gmail', 'gmail', { uses: ['downloadsDir', 'configDir'], words: ['attachment', 'download', 'id'] }),
      NODE,
    ),
  );
  assert.deepEqual(download.words, [
    process.execPath,
    entry,
    '--config-dir',
    PATHS.configDir,
    '--downloads-dir',
    PATHS.downloadsDir,
    'attachment',
    'download',
    'id',
  ]);
  const none = located(locateCliCommand(request(url, 'gmail', 'gmail', { uses: [], words: ['--help'] }), NODE));
  assert.deepEqual(none.words, [process.execPath, entry, '--help']);
  // Path options in the caller's words are replaced by the canonical pins; after `--` every word is data, kept exactly.
  const replaced = located(
    locateCliCommand(
      request(url, 'gmail', 'gmail', {
        uses: ['configDir'],
        words: ['client', 'add', '--config-dir', 'relative', '--state-dir=x', '--', '--config-dir=kept', '--state-dir'],
      }),
      NODE,
    ),
  );
  assert.deepEqual(replaced.words, [
    process.execPath,
    entry,
    '--config-dir',
    PATHS.configDir,
    'client',
    'add',
    '--',
    '--config-dir=kept',
    '--state-dir',
  ]);
  // A path option with no value before `--` is no command at all.
  notLocated(
    locateCliCommand(request(url, 'gmail', 'gmail', { words: ['approve', '--state-dir', '--', 'x'] }), NODE),
    'arguments',
    'gmail',
  );
});

test('the caller never supplies word zero: a suite command as the first word is a programming error', () => {
  const root = writePackage(join(realTemp(), 'gmail'), 'gmail', { files: ['dist/cli.mjs'] });
  for (const first of ['agent-gmail', 'AgentComms', 'agent-slack.cmd', process.execPath]) {
    assert.throws(
      () =>
        locateCliCommand(
          request(moduleUrl(root, 'dist', 'cli.mjs'), 'gmail', 'gmail', { words: [first, 'approve'] }),
          NODE,
        ),
      TypeError,
      first,
    );
  }
});

test('a located and an external command render through the same contract as every printed command', () => {
  const root = writePackage(join(realTemp(), 'gmail'), 'gmail', { files: ['dist/cli.mjs'] });
  const printed = located(
    locateCliCommand(request(moduleUrl(root, 'dist', 'cli.mjs'), 'gmail', 'gmail', { platform: 'darwin' }), NODE),
  );
  assert.equal(inlineCommand(printed), `\`${quoteCommand(printed.words, 'darwin').line}\``);
  assert.equal(commandText(printed), quoteCommand(printed.words, 'darwin').line);
  const windows: ExternalCommand = externalCommand(['claude', 'mcp', 'remove', '$x&whoami&'], 'removal', 'win32');
  assert.equal(windows.line, null);
  assert.equal(commandText(windows), quotedText(quoteCommand(windows.words, 'win32')));
  assert.equal(inlineCommand(windows), inlineQuoted(quoteCommand(windows.words, 'win32')));
  assert.match(
    commandText(windows),
    new RegExp(`^${escapeRegExp(commandAsJson(windows.words))} \\(the command's words`),
  );
});

// ── 7b and 7e: external commands ────────────────────────────────────────────────────────────────────────────────────

const CORE_ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const GMAIL_ROOT = realpathSync(fileURLToPath(new URL('../../gmail/', import.meta.url)));

test('externalCommand refuses any word naming a command of this suite, in any case, alone or in a payload (7b)', () => {
  const refused: string[][] = [
    ['agent-gmail', 'approve', 'abc'],
    ['agentcomms'],
    ['AGENTCOMMS', 'approve'],
    ['Agent-Slack.CMD', 'post', 'send'],
    ['D:\\Profiles\\me\\AppData\\Roaming\\npm\\agent-whatsapp.ps1', '--help'],
    ['/usr/local/bin/agent-resend', 'send'],
    ['./node_modules/.bin/agent-gmail', 'approve'],
    ['agent-gmail-mcp'],
    ['npx', '-y', 'agent-slack', 'mcp'],
    ['env', 'FOO=1', 'agentcomms', 'approve'],
    ['sh', '-c', 'agent-slack post send x'],
    ['sh', '-c', 'cd /tmp && agentcomms approve x'],
    ['cmd', '/c', 'agentcomms.cmd approve x'],
    ['powershell', '-Command', '& "C:\\npm\\Agent-Gmail.ps1" approve x'],
    ['xargs', '--arg=agent-resend'],
    ['claude', 'mcp', 'add', 'gmail', '--', 'agent-gmail', 'mcp'],
  ];
  for (const words of refused) {
    assert.throws(
      () => externalCommand(words, 'a test', 'linux'),
      { name: 'TypeError', message: /names a command of this suite/ },
      JSON.stringify(words),
    );
  }
  // A word that only contains a command's letters inside a longer one is not that command.
  externalCommand(['chmod', '700', '/profiles/me/.config/agent-communications'], 'a test', 'linux');
  externalCommand(['claude', 'mcp', 'remove', 'agent-gmail-old'], 'a test', 'linux');
});

test('externalCommand refuses any package of this suite named as a specifier (7b)', () => {
  for (const words of [
    ['npx', '-y', '@agentcomms/gmail@0.13.0', 'approve'],
    ['npx', '@AgentComms/core'],
    ['pnpm', 'dlx', '@agentcomms/slack'],
    ['node', 'C:\\x\\node_modules\\@agentcomms\\gmail\\dist\\cli.mjs'],
    ['node', '/opt/lib/node_modules/@agentcomms/resend/dist/cli.mjs'],
    ['sh', '-c', 'npx -y @agentcomms/whatsapp mcp'],
  ]) {
    // Its own refusal, and not only the command-name one that `agentcomms` inside the scope would also make.
    assert.throws(
      () => externalCommand(words, 'a test', 'linux'),
      { name: 'TypeError', message: /names a package of this suite/ },
      JSON.stringify(words),
    );
  }
});

test('externalCommand refuses a path inside a suite package root, directly or through a symlink (7b)', () => {
  const temp = realTemp();
  const linkedFile = link(join(GMAIL_ROOT, 'src', 'cli.ts'), join(temp, 'entry.ts'));
  const linkedDir = link(GMAIL_ROOT, join(temp, 'checkout-link'));
  const installed = writePackage(join(temp, 'somewhere', 'gmail'), 'gmail', { files: ['dist/cli.mjs'] });
  for (const words of [
    ['node', join(GMAIL_ROOT, 'dist', 'cli.mjs'), 'approve'],
    ['node', join(CORE_ROOT, 'src', 'cli.ts')],
    ['node', join(GMAIL_ROOT, 'not', 'there', 'yet.mjs')],
    ['node', linkedFile],
    ['node', join(linkedDir, 'src', 'cli.ts')],
    ['node', join(installed, 'dist', 'cli.mjs')],
    ['node', `--import=${join(CORE_ROOT, 'src', 'cli.ts')}`],
    ['sh', '-c', `node "${join(GMAIL_ROOT, 'dist', 'cli.mjs')}" approve x`],
    ['node', pathToFileURL(join(CORE_ROOT, 'dist', 'cli.mjs')).href],
  ]) {
    assert.throws(
      () => externalCommand(words, 'a test', 'linux'),
      { name: 'TypeError', message: /is a path inside .*, a package of this suite/ },
      JSON.stringify(words),
    );
  }
});

test('externalCommand needs words and a reason', () => {
  assert.throws(() => externalCommand([], 'a test', 'linux'), TypeError);
  assert.throws(() => externalCommand([''], 'a test', 'linux'), TypeError);
  assert.throws(() => externalCommand(['chmod', '700', '/x'], ' ', 'linux'), TypeError);
});

test('the reviewed external commands are accepted: chmod 700, claude and codex mcp get and remove (7e-external)', () => {
  const temp = realTemp();
  const accepted: [string[], NodeJS.Platform][] = [
    [['chmod', '700', join(temp, 'config')], 'darwin'],
    [['chmod', '700', '/profiles/me/.local/state/agent-communications/secrets'], 'linux'],
    [['claude', 'mcp', 'remove', 'gmail', '--scope', 'user'], 'linux'],
    [['claude', 'mcp', 'remove', 'old gmail'], 'win32'],
    [['codex', 'mcp', 'remove', 'slack-acme'], 'linux'],
    [['codex', 'mcp', 'get', 'resend'], 'linux'],
    [['claude', 'mcp', 'get', '7/gmail'], 'linux'],
    [['claude', 'mcp', 'remove', '$x&whoami&'], 'win32'],
  ];
  for (const [words, platform] of accepted) {
    const command = externalCommand(words, 'a reviewed external program', platform);
    assert.deepEqual(command.words, words);
    assert.equal(command.line, quoteCommand(words, platform).line);
    assert.equal(command.reason, 'a reviewed external program');
    assert.ok(Object.isFrozen(command) && Object.isFrozen(command.words));
  }
  // `other-servers.ts`'s removals of another server go through it and print exactly what they always did.
  const rival = {
    client: 'claude-code',
    name: 'old gmail',
    path: '/profiles/me/.claude.json',
    command: 'npx',
    args: ['-y', '@shinzolabs/gmail-mcp'],
    env: {},
    scope: 'user' as const,
  };
  assert.equal(findUngatedGmailServers([rival], 'darwin')[0]?.removal, "claude mcp remove 'old gmail'");
  assert.equal(
    otherSlackServerRemoval({ ...rival, client: 'codex', name: 'slack-helper', args: ['/opt/slack.js'] }, 'linux'),
    'codex mcp remove slack-helper',
  );
});

test('a server whose name is a suite command is removed in prose, never by a command naming it', () => {
  const server = {
    client: 'claude-code',
    name: 'agent-slack',
    path: '/profiles/me/.claude.json',
    command: 'node',
    args: ['/opt/someone-elses-slack.js'],
    env: {},
    scope: 'user' as const,
  };
  const removal = otherSlackServerRemoval(server, 'linux');
  assert.equal(removal, 'remove "agent-slack" from /profiles/me/.claude.json by hand, then restart claude-code');
  assert.doesNotMatch(removal, /mcp remove/);
});

// ── The import graph: brands, registrations and the locator, one way only ───────────────────────────────────────────

const SRC = realpathSync(fileURLToPath(new URL('../src/', import.meta.url)));
const GRAPHED = ['command-brands.ts', 'registrations.ts', 'cli-command.ts', 'mcp-install.ts', 'operations/servers.ts'];
/** The permitted edges among them, importer → imported (plan, task 6; task 10 lets the operations use the locator). */
const PERMITTED: readonly (readonly [string, string])[] = [
  ['registrations.ts', 'mcp-install.ts'],
  ['cli-command.ts', 'command-brands.ts'],
  ['cli-command.ts', 'registrations.ts'],
  ['mcp-install.ts', 'command-brands.ts'],
  ['operations/servers.ts', 'registrations.ts'],
  ['operations/servers.ts', 'mcp-install.ts'],
  ['operations/servers.ts', 'cli-command.ts'],
];
/** What must never be reachable, through any chain of runtime imports across core's sources. */
const UNREACHABLE: readonly (readonly [string, readonly string[]])[] = [
  ['command-brands.ts', ['mcp-install.ts', 'operations/servers.ts', 'registrations.ts', 'cli-command.ts']],
  ['registrations.ts', ['cli-command.ts', 'operations/servers.ts']],
  ['mcp-install.ts', ['registrations.ts', 'cli-command.ts', 'operations/servers.ts']],
  ['cli-command.ts', ['operations/servers.ts']],
];

interface Edge {
  from: string;
  to: string;
  typeOnly: boolean;
}

function sourceGraph(): Edge[] {
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((file) => file.endsWith('.ts'));
  const edges: Edge[] = [];
  // An import or export clause holds no `;`, so the match cannot run on into the next statement.
  const statics = /^(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"](\.\.?\/[^'"]+)['"]/gm;
  const bare = /^import\s+['"](\.\.?\/[^'"]+)['"]/gm;
  const dynamic = /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  for (const file of files) {
    const from = file.split(sep).join('/');
    const text = readFileSync(join(SRC, file), 'utf8');
    const add = (specifier: string, typeOnly: boolean) => {
      const to = relative(SRC, resolve(SRC, dirname(file), specifier))
        .split(sep)
        .join('/');
      edges.push({ from, to, typeOnly });
    };
    for (const match of text.matchAll(statics)) {
      const clause = match[2] ?? '';
      const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
      const allTypes =
        named !== null &&
        (named[1] ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .every((part) => part.startsWith('type '));
      add(match[3] as string, Boolean(match[1]) || allTypes);
    }
    for (const match of text.matchAll(bare)) add(match[1] as string, false);
    for (const match of text.matchAll(dynamic)) add(match[1] as string, false);
  }
  return edges;
}

/** Kahn's algorithm: the nodes in an order where every importer comes after what it imports, or null on a cycle. */
function topologicalOrder(nodes: readonly string[], edges: readonly (readonly [string, string])[]): string[] | null {
  const waiting = new Map(nodes.map((node) => [node, edges.filter(([from]) => from === node).length]));
  const order: string[] = [];
  const ready = nodes.filter((node) => waiting.get(node) === 0);
  while (ready.length > 0) {
    const node = ready.shift() as string;
    order.push(node);
    for (const [from, to] of edges) {
      if (to !== node) continue;
      const left = (waiting.get(from) ?? 0) - 1;
      waiting.set(from, left);
      if (left === 0) ready.push(from);
    }
  }
  return order.length === nodes.length ? order : null;
}

test('command-brands, registrations, cli-command, mcp-install and operations/servers import one way only, with no cycle', () => {
  const edges = sourceGraph();
  assert.ok(edges.length > 100, 'the sources were read');
  const among = edges.filter(({ from, to }) => GRAPHED.includes(from) && GRAPHED.includes(to) && from !== to);
  const pairs = [...new Set(among.map(({ from, to }) => `${from} -> ${to}`))].map(
    (pair) => pair.split(' -> ') as [string, string],
  );
  const permitted = new Set(PERMITTED.map(([from, to]) => `${from} -> ${to}`));
  // Type-only imports count too: a module that must not import another must not name its types either.
  assert.deepEqual(
    pairs.filter(([from, to]) => !permitted.has(`${from} -> ${to}`)),
    [],
    'every import among them is one the design permits',
  );
  // The edges this task relies on are really there, so the graph read is the real one rather than an empty one.
  for (const edge of [
    'mcp-install.ts -> command-brands.ts',
    'registrations.ts -> mcp-install.ts',
    'operations/servers.ts -> registrations.ts',
  ]) {
    assert.ok(
      pairs.some(([from, to]) => `${from} -> ${to}` === edge),
      edge,
    );
  }
  assert.notEqual(topologicalOrder(GRAPHED, pairs), null, 'the imports among them sort topologically');
  assert.notEqual(topologicalOrder(GRAPHED, PERMITTED), null, 'and so does every edge the design permits');
  // Through any other module, at runtime: no chain of imports may lead back.
  const runtime = new Map<string, string[]>();
  for (const { from, to, typeOnly } of edges) if (!typeOnly) runtime.set(from, [...(runtime.get(from) ?? []), to]);
  for (const [start, forbidden] of UNREACHABLE) {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift() as string;
      for (const next of runtime.get(node) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    assert.deepEqual(
      forbidden.filter((module) => seen.has(module)),
      [],
      `${start} reaches none of ${forbidden.join(', ')}`,
    );
  }
});

test('the topological check fails on a cycle', () => {
  assert.equal(
    topologicalOrder(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    ),
    null,
  );
  assert.deepEqual(topologicalOrder(['a', 'b'], [['a', 'b']]), ['b', 'a']);
});

// ── CUE-492: this Node, named as PATH finds it, never by the file a link of it resolves to ───────────────────────────

const POSIX_LINKED_NODE =
  process.platform === 'win32' ? { skip: 'WINDOWS_SKIP: a `node` on PATH that is a symlink is a POSIX layout' } : {};

/**
 * A `bin` folder whose `node` is a symlink to this very Node — Homebrew's `/opt/homebrew/bin/node`, or a tool's
 * `~/.local/bin/node` — and the real file it resolves to, which is what `process.execPath` reports.
 */
function linkedNode(): { bin: string; node: string; real: string } {
  const bin = join(realTemp('linked-node-'), 'bin');
  const node = link(process.execPath, join(bin, 'node'));
  return { bin, node, real: realpathSync(process.execPath) };
}

test(
  'a command names this Node by the link PATH finds it by, not by the file the link resolves to (CUE-492)',
  POSIX_LINKED_NODE,
  () => {
    const { bin, node, real } = linkedNode();
    const root = join(realTemp(), 'data', 'runtime', `${VERSION}-slack`, 'node_modules', '@agentcomms', 'slack');
    writePackage(root, 'slack', { files: ['dist/cli.mjs'] });
    const entry = join(root, 'dist', 'cli.mjs');
    const own = request(moduleUrl(root, 'dist', 'cli.mjs'), 'slack', 'slack');
    // An empty folder first, as most of a person's PATH is for `node`: the first `node` that is this one is named.
    const empty = join(realTemp('no-node-'), 'bin');
    mkdirSync(empty, { recursive: true });
    const command = located(locateCliCommand({ ...own, env: { PATH: [empty, bin].join(delimiter) } }, NODE));
    assert.deepEqual(command.words, [node, entry, ...PINS, 'approve', 'abc123'], 'the link, as PATH has it');
    assert.notEqual(node, real, 'the fixture names this Node by a path other than its own');
    assert.ok(
      !(command.line ?? '').includes(real),
      `the line never names the file the link resolves to: ${command.line}`,
    );
    // With no PATH to look on, the command names this process's own path, as it always has.
    assert.equal(located(locateCliCommand(own, NODE)).words[0], process.execPath);
  },
);

test(
  'the version check still reads the real Node: a link is checked by its real file and never run (CUE-492)',
  POSIX_LINKED_NODE,
  () => {
    const { bin, node } = linkedNode();
    // A `node` first on PATH that is another program: another Node, a wrapper. It leaves a mark if anything runs it.
    const decoy = markingProgram(join(realTemp('other-node-'), 'bin'), 'node');
    const PATH = [dirname(decoy.path), bin].join(delimiter);
    const temp = realTemp();
    const fits = join(temp, 'fits', 'node_modules', '@agentcomms', 'slack');
    writePackage(fits, 'slack', { files: ['dist/cli.mjs'] });
    const major = Number(process.versions.node.split('.')[0]);
    const newer = join(temp, 'newer', 'node_modules', '@agentcomms', 'slack');
    writePackage(newer, 'slack', { files: ['dist/cli.mjs'], engines: `>=${major + 1}.0.0` });
    const calls: string[] = [];
    const restore = spyOnChildProcesses(calls);
    let found: CliCommandResult;
    let tooOld: CliCommandResult;
    let onlyDecoy: CliCommandResult;
    try {
      // This process's own Node runtime: the version checked is `process.version`, the real file's.
      found = locateCliCommand({ ...request(moduleUrl(fits, 'dist', 'cli.mjs'), 'slack', 'slack'), env: { PATH } });
      tooOld = locateCliCommand({ ...request(moduleUrl(newer, 'dist', 'cli.mjs'), 'slack', 'slack'), env: { PATH } });
      onlyDecoy = locateCliCommand({
        ...request(moduleUrl(fits, 'dist', 'cli.mjs'), 'slack', 'slack'),
        env: { PATH: dirname(decoy.path) },
      });
    } finally {
      restore();
    }
    assert.deepEqual(calls, [], 'nothing on PATH is run, not even to ask its version');
    assert.equal(decoy.ran(), false, 'the other node was never started');
    assert.equal(located(found).words[0], node, 'past a `node` that is another file, to the link that is this Node');
    const refused = notLocated(tooOld, 'engine', 'slack');
    assert.ok(refused.detail.includes(`this is Node ${process.version}`), refused.detail);
    assert.equal(located(onlyDecoy).words[0], process.execPath, 'with no link to this Node on PATH, its own path');
  },
);

/** Removes a link itself, never what it points at. */
function rmLink(path: string): void {
  unlinkSync(path);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
