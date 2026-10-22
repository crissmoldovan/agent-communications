import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stateOf } from '../src/approval-stored.ts';
import { type GatedOutcome, gatedChange } from '../src/change-flow.ts';
import { serverFacts } from '../src/channel-servers.ts';
import { type Core, openCore } from '../src/core.ts';
import type { CommsError } from '../src/errors.ts';
import { installVerifiedGlobal } from '../src/global-install.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { LAUNCHER_ENV, launcherName, switchPointer } from '../src/launcher.ts';
import { type McpProduct, managedRuntimeDir, managedRuntimeEntry, mcpInstall } from '../src/mcp-install.ts';
import {
  type ServerInstallDeps,
  type ServerInstallRequest,
  type ServerInstallResult,
  serverInstallChange,
  serverProduct,
} from '../src/operations/servers.ts';
import { type UpdateDeps, type UpdateRequest, type UpdateResult, updateChange } from '../src/operations/update.ts';
import type { TarballFetch } from '../src/release-tarball.ts';
import { type BackgroundDeps, type BackgroundRunResult, runBackgroundUpdate } from '../src/update-background.ts';
import type { Packument, ReleaseRegistry } from '../src/update-release.ts';
import { UPDATE_CHECK_ENV, UPDATE_STARTED_BY_ENV, UPDATES_ENV, updateCheckSwitchedOff } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { type GlobalStandIn, globalStandIn } from './helpers/global-stand-in.ts';
import { releaseWorld, type World } from './helpers/release-world.ts';
import { integrityOfBytes, releaseTarball } from './helpers/tarball-fixture.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * No escape hatch (design 2026-10-22 P5, the owner's decision): a release whose provenance fails verification cannot be
 * installed in any way — by hand, by the background run, or at first install. No override, code or flag. A broken
 * release is replaced by a new verified one.
 *
 * One test for each kind of input — the environment, a flag or request, an approval, what the registry says — each
 * tried on every install path:
 * - by hand (`updateChange`): a runtime installed and a versioned registration registered again; a stable launcher's
 *   pointer switched, to a runtime it installs or to one already on disk; an npx registration registered again; a
 *   global package updated;
 * - at first install (`serverInstallChange`): a managed runtime fetched from npm, or one already on this machine;
 * - in the background (`runBackgroundUpdate`, and its dry run): core's release, and another package of the release;
 * - and the global install itself (`installVerifiedGlobal`), the one step that hands npm the bytes.
 * Each attempt fails if any installer is called, or anything outside the state folder is written — a runtime, a
 * pointer, a client's configuration, a global package, a shim.
 *
 * What is kept, and held apart: a channel's own command carries no Sigstore, so it cannot verify anything, and it
 * installs the release it is running itself, unverified and said so (the owner's decision, 2026-10-17). That is a
 * release nothing here could check, not one that failed a check: handed a verifier, the same request is refused.
 *
 * Not held here: a first install on the npx launcher (`launcher: 'npx'`) writes an entry whose client fetches the
 * release from npm each time it starts it, and checks nothing before writing it, with a verifier or without — the limit
 * SECURITY.md has stated since 0.20.0. The by-hand update does verify an npx registration's release before it writes
 * the entry again (above).
 *
 * Nothing here reaches npm, Sigstore or GitHub: every release is one `releaseWorld`, its attestations signed by the
 * test's own trust root, and every installer a stand-in that records being called.
 */

const CORE = serverFacts('core').packageName;
const GMAIL = serverFacts('gmail').packageName;
const GMAIL_MCP = serverFacts('gmail').npxPackage;
const SLACK = serverFacts('slack').packageName;
/** Every package an update here may ask the registry about. */
const EVERY = [
  ...new Set(
    (['core', 'gmail', 'resend', 'slack', 'whatsapp', 'events'] as const).flatMap((server) => [
      serverFacts(server).packageName,
      serverFacts(server).npxPackage,
    ]),
  ),
].sort();

/** What this machine runs, and the release after it; a first install installs this core's own, `VERSION`. */
const OLD = '0.90.0';
const LATEST = '0.90.1';
const NOW = new Date('2026-10-22T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

/** Gmail's own product, as `agent-gmail mcp install` hands it in: the release that command is. */
const GMAIL_OWN: McpProduct = { ...serverFacts('gmail'), version: VERSION, moduleUrl: '' };

// ── A machine ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Calls {
  /** Runtimes the update's installer was asked for. */
  runtimes: string[];
  /** Files npm was handed to install globally. */
  globals: string[];
  /** Runtimes the background run's installer was asked for. */
  background: string[];
  /** Runtimes the background run's self-check was asked about. */
  checked: string[];
}

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  dataDir: string;
  /** What `npm ls -g` lists, by name. */
  installed: Record<string, string>;
  globals: GlobalStandIn;
  calls: Calls;
}

/** A home of the test's own, with core's folders in it, and npm's registry an address nobody answers on. */
function machine(): Machine {
  const home = tempDir('comms-no-escape-hatch-');
  mkdirSync(join(home, 'bin'));
  mkdirSync(join(home, 'config'));
  writeFileSync(
    join(home, 'config', 'config.json'),
    `${JSON.stringify({ version: 2, secrets: { store: 'file' } }, null, 2)}\n`,
  );
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(home, 'secrets'),
    // Where a client's own command is looked for beyond PATH: this home only, never a real `claude`.
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    NO_COLOR: '1',
    // A stray npm, had a stand-in been missed, fails at once instead of fetching.
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_offline: 'true',
  };
  const core = openCore({ env, caller: CORE_CALLER });
  const installed: Record<string, string> = {};
  return {
    home,
    env,
    core,
    dataDir: core.paths.dataDir,
    installed,
    globals: globalStandIn(join(home, 'npm-global'), installed),
    calls: { runtimes: [], globals: [], background: [], checked: [] },
  };
}

/** A runtime as npm leaves one: the package, the runtime's manifest pinning it, and the lockfile with `integrity`. */
function makeRuntime(m: Machine, packageName: string, version: string, integrity: string): string {
  const root = managedRuntimeDir(m.dataDir, packageName, version);
  const cli = managedRuntimeEntry(m.dataDir, packageName, version);
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, 'process.exit(0);\n');
  const unscoped = packageName.split('/').at(-1) ?? packageName;
  const binary = unscoped === 'core' ? 'agentcomms' : `agent-${unscoped}`;
  writeFileSync(
    join(root, 'node_modules', ...packageName.split('/'), 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      engines: { node: '>=22.12.0' },
      agentcomms: { binary },
      bin: { [binary]: './dist/cli.mjs' },
    }),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, dependencies: { [packageName]: version } }),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${packageName}`]: { version, integrity } } }),
  );
  return root;
}

/** Cursor's own configuration, holding `servers`: a file this writes itself, on every platform. */
function cursor(
  m: Machine,
  servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>,
) {
  mkdirSync(join(m.home, '.cursor'), { recursive: true });
  writeFileSync(join(m.home, '.cursor', 'mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

/** Every file and folder in the home but the state folder — approvals, the audit, caches — by content. */
function files(m: Machine): Record<string, string> {
  const found: Record<string, string> = {};
  const state = resolve(m.core.paths.stateDir);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (resolve(path) === state) continue;
      const key = relative(m.home, path).split(sep).join('/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) found[key] = `link to ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        found[`${key}/`] = 'folder';
        walk(path);
      } else found[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(m.home);
  return found;
}

interface Before {
  files: Record<string, string>;
  installed: Record<string, string>;
}

const before = (m: Machine): Before => ({ files: files(m), installed: { ...m.installed } });

/** Nothing installed, and nothing outside the state folder written. */
function untouched(m: Machine, was: Before, why: string): void {
  assert.deepEqual(
    m.calls,
    { runtimes: [], globals: [], background: [], checked: [] },
    `${why}: an installer or a self-check was called`,
  );
  assert.deepEqual(m.installed, was.installed, `${why}: a global package moved`);
  assert.deepEqual(files(m), was.files, `${why}: something was written`);
}

// ── The install paths ───────────────────────────────────────────────────────────────────────────────────────────

type Kind = 'by hand' | 'at first install' | 'in the background';

interface InstallPath {
  kind: Kind;
  name: string;
  /** The release this path would install, which a test makes fail: `package@version`. */
  failing: string;
  /** The releases, every one verifying until a test says otherwise. */
  world: () => World;
  /** A machine on which this path installs `failing`. */
  setUp: (world: World) => Promise<Machine>;
}

/** Every package at `OLD` and `LATEST`, signed by Rekor 30 days and 80 hours ago: past every hold. */
const releases = (): World =>
  releaseWorld(Object.fromEntries(EVERY.map((name) => [name, LATEST])), [
    { version: OLD, signedAt: hoursAgo(24 * 30) },
    { version: LATEST, signedAt: hoursAgo(80) },
  ]);

/** What a first install fetches: this core's own release, of Gmail, its npx package and core. */
const firstReleases = (): World =>
  releaseWorld({ [GMAIL]: VERSION, [GMAIL_MCP]: VERSION, [CORE]: VERSION }, [{ version: VERSION }]);

/** Gmail registered with Cursor on its stable launcher at `version`, through the installer itself. */
async function onLauncher(m: Machine, world: World, version: string): Promise<void> {
  makeRuntime(m, GMAIL, version, world.integrity(GMAIL, version));
  const done = await mcpInstall({ env: m.env, core: m.core }, await serverProduct('gmail', 'managed', version), {
    client: 'cursor',
    noVerify: true,
    force: true,
  });
  assert.equal(done.applied, true, done.notApplied);
}

/** Core and Gmail started through their stable launchers at `OLD`: what the background run switches. */
async function launched(world: World): Promise<Machine> {
  const m = machine();
  for (const packageName of [CORE, GMAIL]) {
    await switchPointer(
      m.dataDir,
      launcherName(packageName),
      makeRuntime(m, packageName, OLD, world.integrity(packageName, OLD)),
    );
  }
  return m;
}

const BY_HAND: readonly InstallPath[] = [
  {
    kind: 'by hand',
    name: 'a runtime installed, and a registration naming a versioned runtime registered again',
    failing: `${SLACK}@${LATEST}`,
    world: releases,
    setUp: async (world) => {
      const m = machine();
      makeRuntime(m, SLACK, OLD, world.integrity(SLACK, OLD));
      cursor(m, {
        slack: {
          command: process.execPath,
          args: [managedRuntimeEntry(m.dataDir, SLACK, OLD), 'mcp'],
          env: { AGENT_COMMS_CONFIG_DIR: m.env.AGENT_COMMS_CONFIG_DIR ?? '' },
        },
      });
      return m;
    },
  },
  {
    kind: 'by hand',
    name: "a stable launcher's pointer switched to the runtime the update installs",
    failing: `${GMAIL}@${LATEST}`,
    world: releases,
    setUp: async (world) => {
      const m = machine();
      await onLauncher(m, world, OLD);
      return m;
    },
  },
  {
    kind: 'by hand',
    name: "a stable launcher's pointer switched to a runtime already on this machine",
    failing: `${GMAIL}@${LATEST}`,
    world: releases,
    setUp: async (world) => {
      const m = machine();
      await onLauncher(m, world, OLD);
      makeRuntime(m, GMAIL, LATEST, world.integrity(GMAIL, LATEST));
      return m;
    },
  },
  {
    kind: 'by hand',
    name: 'an npx registration registered again, whose client fetches its package from npm',
    failing: `${GMAIL_MCP}@${LATEST}`,
    world: releases,
    setUp: async () => {
      const m = machine();
      cursor(m, { gmail: { command: 'npx', args: ['-y', `${GMAIL_MCP}@${OLD}`] } });
      return m;
    },
  },
  {
    kind: 'by hand',
    name: 'a global package updated',
    failing: `${GMAIL}@${LATEST}`,
    world: releases,
    setUp: async () => {
      const m = machine();
      m.installed[GMAIL] = OLD;
      return m;
    },
  },
];

const FIRST_INSTALL: readonly InstallPath[] = [
  {
    kind: 'at first install',
    name: 'a managed runtime fetched from npm',
    failing: `${GMAIL}@${VERSION}`,
    world: firstReleases,
    setUp: async () => machine(),
  },
  {
    kind: 'at first install',
    name: 'a managed registration on a runtime already on this machine',
    failing: `${GMAIL}@${VERSION}`,
    world: firstReleases,
    setUp: async (world) => {
      const m = machine();
      makeRuntime(m, GMAIL, VERSION, world.integrity(GMAIL, VERSION));
      return m;
    },
  },
];

const BACKGROUND: readonly InstallPath[] = [
  {
    kind: 'in the background',
    name: "core's release",
    failing: `${CORE}@${LATEST}`,
    world: releases,
    setUp: launched,
  },
  {
    kind: 'in the background',
    name: 'another package of the release, once core verified',
    failing: `${GMAIL}@${LATEST}`,
    world: releases,
    setUp: launched,
  },
];

const EVERY_PATH: readonly InstallPath[] = [...BY_HAND, ...FIRST_INSTALL, ...BACKGROUND];

const named = (path: InstallPath) => `${path.kind}, ${path.name}`;

/** A path's machine, in a world where the release it would install has no attestation at all. */
async function failingOn(path: InstallPath): Promise<{ m: Machine; world: World }> {
  const world = path.world();
  world.change({ [path.failing]: 'missing' });
  return { m: await path.setUp(world), world };
}

/** How one attempt is made: everything a person, an agent, the machine or the registry can vary. */
interface How {
  env?: Record<string, string> | undefined;
  registry?: ReleaseRegistry | undefined;
  update?: UpdateRequest | undefined;
  install?: Partial<ServerInstallRequest> | undefined;
  /** In place of core's: the registry and the verifier core's command and server hand in. */
  installDeps?: ServerInstallDeps | undefined;
  /** The calling channel's product, as its own `mcp install` hands it in. */
  own?: McpProduct | undefined;
  approvalId?: string | undefined;
  dryRun?: boolean | undefined;
}

/** The update's outside effects, every one a stand-in that records being called. */
function updateDeps(m: Machine, world: World, registry: ReleaseRegistry): UpdateDeps {
  return {
    latestVersion: async (packageName) => String((await registry(packageName)).packument['dist-tags']?.latest),
    registry,
    verifyRelease: world.verifyRelease,
    tarballs: world.tarballs,
    globalPackages: async () => ({ ...m.installed }),
    installGlobal: async (spec) => {
      m.calls.globals.push(spec);
      await m.globals.installGlobal(spec);
    },
    globalRoot: m.globals.globalRoot,
    installRuntime: async (packageName, version) => {
      m.calls.runtimes.push(`${packageName}@${version}`);
      makeRuntime(m, packageName, version, world.integrity(packageName, version));
    },
  };
}

/** The background run's: the level `auto`, nothing running, the clock fixed, every installer a recording stand-in. */
function backgroundDeps(m: Machine, world: World, registry: ReleaseRegistry): BackgroundDeps {
  return {
    settings: { level: () => 'auto', pausedUntil: () => undefined, background: () => true },
    registry,
    provenance: { fetch: world.attestations, verifyBundle: world.verifyBundle },
    tarballs: world.tarballs,
    install: async (packageName, version) => {
      m.calls.background.push(`${packageName}@${version}`);
      return makeRuntime(m, packageName, version, world.integrity(packageName, version));
    },
    selfCheck: async ({ packageName, version }) => {
      m.calls.checked.push(`${packageName}@${version}`);
      return { ok: true, detail: 'a stand-in that answers' };
    },
    processes: async () => [],
    now: () => NOW,
    job: { run: async () => ({ status: 0, stdout: '', stderr: '' }), uid: 501, random: () => 0.5, now: () => NOW },
    platform: 'linux',
  };
}

/** One attempt on `path`, as `how` says: a gated change's outcome, or the background run's result. */
async function attempt(path: InstallPath, m: Machine, world: World, how: How = {}): Promise<unknown> {
  const env = how.env ?? m.env;
  // Opened as the process that makes the attempt would open it: with its environment.
  const core = openCore({ env, caller: CORE_CALLER });
  const registry = how.registry ?? world.registry;
  const gate = { surface: 'mcp' as const, channel: 'core', approvalId: how.approvalId };
  if (path.kind === 'by hand') {
    return gatedChange(core, updateChange(core, env, how.update ?? {}, updateDeps(m, world, registry)), gate);
  }
  if (path.kind === 'at first install') {
    const request: ServerInstallRequest = { channel: 'gmail', client: 'cursor', noVerify: true, ...how.install };
    const deps = how.installDeps ?? { registry, verifyRelease: world.verifyRelease };
    return gatedChange(core, serverInstallChange(core, env, request, how.own, deps), gate);
  }
  return runBackgroundUpdate(core, env, { dryRun: how.dryRun === true }, backgroundDeps(m, world, registry));
}

/** The refusal of a release that did not verify: the whole change, naming it, with nothing installed. */
function refusal(failing: string, why: string) {
  return (error: unknown) => {
    const refused = error as CommsError;
    assert.equal(refused.code, 'BAD_DATA', `${why}: ${refused.message}`);
    assert.ok(
      refused.message.startsWith(
        `nothing was installed or changed: ${failing} could not be verified as built by this repository's release workflow — `,
      ),
      `${why}: ${refused.message}`,
    );
    return true;
  };
}

/**
 * The attempt is refused for `path.failing`, and nothing moved: by hand or at first install, the change refuses
 * before anything is prepared to approve (or, claiming an approval, before it is applied); in the background, the run
 * is `refused`.
 */
async function refusedOn(path: InstallPath, m: Machine, world: World, how: How, why: string): Promise<void> {
  const was = before(m);
  const approvals = (await m.core.approvals.list()).length;
  const ran = attempt(path, m, world, how);
  if (path.kind === 'in the background') {
    const result = (await ran) as BackgroundRunResult;
    assert.equal(result.outcome, 'refused', `${why}: ${result.reason}`);
    assert.ok(result.reason.startsWith(`the provenance of ${path.failing} did not verify`), `${why}: ${result.reason}`);
  } else {
    await assert.rejects(ran, refusal(path.failing, why));
  }
  assert.equal((await m.core.approvals.list()).length, approvals, `${why}: something was prepared to approve`);
  untouched(m, was, why);
}

// ── The environment ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The harness's own folders and registry, by name in any case: an environment variable on Windows has no case, so
 * `Path` is `PATH` there, and `NPM_CONFIG_REGISTRY` is `npm_config_registry`. `PATHEXT` goes with `PATH`: it is how
 * Windows finds a program on it, and set to anything else, `npx` is not found and its registration is left for a
 * person before any check — installing nothing, but never meeting the check this test is about.
 */
const HARNESS = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'NPM_CONFIG_REGISTRY']);
const harness = (name: string) => HARNESS.has(name.toUpperCase()) || /^AGENT_COMMS_.+_DIR$/i.test(name);

/** What updates are switched off by for one process (`updateCheckSwitchedOff`): only ever off, never past a check. */
const SWITCHES = new Set(['CI', UPDATE_CHECK_ENV, UPDATES_ENV]);

/**
 * Every environment variable core reads — each name its source reads as `env.NAME` or `env['NAME']` — and those
 * that could be imagined to skip a check: the update switches, the launcher's, and Node's, npm's and Sigstore's
 * look-alikes. Not the harness's own folders and registry, which every attempt needs to stay in its own home.
 */
function environmentNames(): string[] {
  const source = fileURLToPath(new URL('../src/', import.meta.url));
  const names = new Set<string>();
  for (const file of readdirSync(source, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(join(source, file), 'utf8');
    for (const found of text.matchAll(/\benv(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g)) {
      names.add(String(found[1] ?? found[2]));
    }
  }
  for (const name of [
    UPDATE_CHECK_ENV,
    UPDATES_ENV,
    UPDATE_STARTED_BY_ENV,
    LAUNCHER_ENV,
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'npm_config_provenance',
    'npm_config_ignore_scripts',
    'SIGSTORE_NO_VERIFY',
  ]) {
    names.add(name);
  }
  return [...names].filter((name) => !harness(name)).sort();
}

/** `names`, each set to `value`, in this process's own environment too, for the length of `run`. */
async function inProcessEnvironment(names: readonly string[], value: string, run: () => Promise<void>): Promise<void> {
  const kept = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = value;
  try {
    await run();
  } finally {
    for (const [name, was] of kept) {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
  }
}

const VALUES = ['1', 'true', 'on', 'off', '0', 'skip'] as const;

test('no environment variable installs a release that fails verification, by any path', async () => {
  const names = environmentNames();
  // The names are core's own, and more than a handful: the switches, the clients' folders, Node's and npm's.
  for (const name of ['CI', UPDATE_CHECK_ENV, UPDATES_ENV, LAUNCHER_ENV, 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR']) {
    assert.ok(names.includes(name), `${name} is not among the names read: ${names.join(', ')}`);
  }
  for (const name of ['HOME', 'PATH', 'Path', 'AGENT_COMMS_STATE_DIR', 'npm_config_registry']) {
    assert.ok(!names.includes(name), `${name} is the harness's own`);
  }
  const unswitched = names.filter((name) => !SWITCHES.has(name));

  for (const value of VALUES) {
    for (const path of EVERY_PATH) {
      const why = `${named(path)}, every variable ${value}`;
      const { m, world } = await failingOn(path);
      const env = { ...m.env, ...Object.fromEntries(names.map((name) => [name, value])) };
      if (path.kind === 'in the background') {
        // The switches only ever turn a run off, before anything is asked: so tried with them, then without them, so
        // that every other variable meets the check itself.
        await inProcessEnvironment(names, value, async () => {
          const was = before(m);
          const result = (await attempt(path, m, world, { env })) as BackgroundRunResult;
          assert.equal(
            result.outcome,
            updateCheckSwitchedOff(env) === null ? 'refused' : 'off',
            `${why}: ${result.reason}`,
          );
          untouched(m, was, why);
        });
        const without = { ...m.env, ...Object.fromEntries(unswitched.map((name) => [name, value])) };
        await inProcessEnvironment(unswitched, value, () =>
          refusedOn(path, m, world, { env: without }, `${why} but the switches`),
        );
        continue;
      }
      await inProcessEnvironment(names, value, () => refusedOn(path, m, world, { env }, why));
    }

    // The global install itself, handed bytes that are not its verified tarball: npm is never run.
    const world = releases();
    const m = machine();
    const was = before(m);
    await inProcessEnvironment(names, value, async () => {
      const installed = await globalInstall(m, world, otherBytes);
      assert.equal(installed.ok, false, `the global install, every variable ${value}`);
    });
    untouched(m, was, `the global install, every variable ${value}`);
  }
});

// ── Flags and requests ──────────────────────────────────────────────────────────────────────────────────────────

test('no flag or request installs one', async () => {
  // By hand: with or without starting each server registered again to check it.
  for (const path of BY_HAND) {
    for (const update of [{}, { noVerify: true }, { noVerify: false }] satisfies UpdateRequest[]) {
      const { m, world } = await failingOn(path);
      await refusedOn(path, m, world, { update }, `${named(path)}, ${JSON.stringify(update)}`);
    }
  }

  // At first install: forced over an entry already there, on the managed launcher, checked or not.
  for (const path of FIRST_INSTALL) {
    for (const install of [
      { launcher: 'managed', force: true },
      { launcher: 'managed', force: true, noVerify: false },
    ] satisfies Partial<ServerInstallRequest>[]) {
      const { m, world } = await failingOn(path);
      cursor(m, { gmail: { command: 'npx', args: ['-y', `${GMAIL_MCP}@${OLD}`] } });
      await refusedOn(path, m, world, { install }, `${named(path)}, ${JSON.stringify(install)}`);
    }
    // Asked as a channel's own command, naming the release it runs — with a verifier in hand, verified as any other.
    const { m, world } = await failingOn(path);
    await refusedOn(path, m, world, { own: GMAIL_OWN }, `${named(path)}, Gmail's own command, with a verifier`);
    await refusedOn(
      path,
      m,
      world,
      {
        installDeps: {
          registry: world.registry,
          verifyRelease: world.verifyRelease,
          running: { packageName: GMAIL, version: VERSION },
        },
      },
      `${named(path)}, naming the release running, with a verifier`,
    );
  }

  // In the background: a run, and a dry run, which would have said `would-install`.
  for (const path of BACKGROUND) {
    for (const dryRun of [false, true]) {
      const { m, world } = await failingOn(path);
      await refusedOn(path, m, world, { dryRun }, `${named(path)}, ${dryRun ? 'a dry run' : 'a run'}`);
    }
  }
});

// ── Approvals ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The approval a first call prepared, while the release still verified. */
function prepared(outcome: unknown, why: string): string {
  const asked = outcome as GatedOutcome<UpdateResult | ServerInstallResult>;
  assert.equal(asked.status, 'approval-required', `${why}: ${JSON.stringify(asked)}`);
  return (asked as Extract<typeof asked, { status: 'approval-required' }>).prepared.approvalId;
}

test('no approval installs one', async () => {
  // Prepared while the release verified, then its attestation is gone: the claim plans again, and refuses.
  for (const path of [...BY_HAND, ...FIRST_INSTALL]) {
    const why = `${named(path)}, an approval prepared while it verified`;
    const world = path.world();
    const m = await path.setUp(world);
    const approvalId = prepared(await attempt(path, m, world), why);
    world.change({ [path.failing]: 'missing' });
    await refusedOn(path, m, world, { approvalId }, why);
    const stored = await m.core.approvals.get(approvalId);
    assert.ok(stored !== null, why);
    assert.notEqual(stateOf(stored), 'used', `${why}: the approval was spent`);
  }

  // Prepared by a channel's own command, which cannot verify and says so, then claimed through core's, which can.
  const [path] = FIRST_INSTALL;
  assert.ok(path !== undefined);
  const why = "an approval Gmail's own command prepared, claimed through core's";
  const { m, world } = await failingOn(path);
  const approvalId = prepared(await attempt(path, m, world, { own: GMAIL_OWN, installDeps: {} }), why);
  await refusedOn(path, m, world, { approvalId }, why);
});

// ── What the registry says ──────────────────────────────────────────────────────────────────────────────────────

/** A registry that serves `world`'s documents, each changed by `change` first. */
function hostileRegistry(world: World, change: (packument: Packument, packageName: string) => void): ReleaseRegistry {
  return async (packageName) => {
    const answer = await world.registry(packageName);
    const packument = structuredClone(answer.packument);
    change(packument, packageName);
    return { ...answer, packument };
  };
}

/** One way a registry or a mirror can lie about a release, and whether its attestation is gone as well. */
interface Lie {
  name: string;
  /** The release keeps its genuine attestation: the lie alone must make it fail. */
  genuine?: true;
  change: (packument: Packument, packageName: string, failing: { packageName: string; version: string }) => void;
}

const versionsOf = (packument: Packument) =>
  Object.values(packument.versions ?? {}).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

const declaring = (declares: unknown): Lie => ({
  name: `agentcommsRelease ${JSON.stringify(declares)} on every release of core`,
  change: (packument, packageName) => {
    if (packageName !== CORE) return;
    for (const entry of versionsOf(packument)) entry.agentcommsRelease = declares;
  },
});

const LIES: readonly Lie[] = [
  declaring({ security: true }),
  declaring({ security: true, needsDecision: false }),
  declaring({ needsDecision: false, verified: true }),
  declaring('verified'),
  {
    name: 'a dist.integrity for other bytes, which no attestation signs',
    genuine: true,
    change: (packument, packageName, failing) => {
      if (packageName !== failing.packageName) return;
      const dist = packument.versions?.[failing.version]?.dist;
      if (dist === undefined) return;
      dist.integrity = integrityOfBytes(
        releaseTarball(failing.packageName, failing.version, { files: { 'MIRROR.md': 'the registry’s own bytes\n' } }),
      );
    },
  },
  {
    // Only the failing release's own: moved for core too, the background run stops before Gmail's check, as
    // `unavailable` — installing nothing, but never meeting the check this test is about.
    name: 'a dist.tarball on another host',
    change: (packument, packageName, failing) => {
      if (packageName !== failing.packageName) return;
      for (const entry of versionsOf(packument)) {
        if (entry.dist !== undefined) entry.dist.tarball = `https://mirror.comms.test/${packageName}.tgz`;
      }
    },
  },
  {
    name: 'a time years back',
    change: (packument) => {
      for (const version of Object.keys(packument.time ?? {})) {
        (packument.time as Record<string, unknown>)[version] = '2001-01-01T00:00:00.000Z';
      }
    },
  },
];

test('no registry input installs one', async () => {
  const everything: Lie = {
    name: 'all of these at once',
    change: (...args) => {
      for (const lie of LIES) lie.change(...args);
    },
  };
  for (const lie of [...LIES, everything]) {
    for (const path of EVERY_PATH) {
      const why = `${named(path)}, ${lie.name}`;
      const world = path.world();
      if (lie.genuine !== true) world.change({ [path.failing]: 'missing' });
      const m = await path.setUp(world);
      const at = path.failing.lastIndexOf('@');
      const failing = { packageName: path.failing.slice(0, at), version: path.failing.slice(at + 1) };
      const registry = hostileRegistry(world, (packument, packageName) => lie.change(packument, packageName, failing));
      await refusedOn(path, m, world, { registry }, why);
    }
  }
});

// ── The global install ──────────────────────────────────────────────────────────────────────────────────────────

/** A tarball location, and npm's canonical one, that answer another tarball than the verified one. */
const otherBytes: TarballFetch = async () =>
  new Response(
    new Uint8Array(releaseTarball(GMAIL, LATEST, { files: { 'MIRROR.md': 'not the verified tarball\n' } })),
    {
      status: 200,
    },
  );

/**
 * `installVerifiedGlobal` of Gmail at `LATEST`, handed the verified provenance of Gmail at `provenanceOf`, with its
 * tarballs fetched through `tarballs`, and npm a stand-in that records being called.
 */
async function globalInstall(m: Machine, world: World, tarballs: TarballFetch, provenanceOf: string = LATEST) {
  const verdict = await world.verifyRelease({
    packageName: GMAIL,
    version: provenanceOf,
    integrity: world.integrity(GMAIL, provenanceOf),
  });
  if (!verdict.ok) throw new Error(`the test's own release ${GMAIL}@${provenanceOf} did not verify: ${verdict.field}`);
  return installVerifiedGlobal(
    { packageName: GMAIL, version: LATEST, provenance: verdict.provenance },
    {
      install: async (spec) => {
        m.calls.globals.push(spec);
      },
      root: m.globals.globalRoot,
      registry: world.registry,
      verify: world.verifyRelease,
      tarballs,
    },
    'run the update again',
  );
}

test('a global whose tarball is not the verified digest runs no npm', async () => {
  // By hand: the release verifies, and every location of its tarball answers other bytes. The step fails, npm is
  // never handed a file, and the global package stays as it was.
  {
    const world = releaseWorld(Object.fromEntries(EVERY.map((name) => [name, LATEST])), [
      { version: OLD },
      { version: LATEST, packages: EVERY.filter((name) => name !== GMAIL) },
      { version: LATEST, packages: [GMAIL], serve: 'other-bytes' },
    ]);
    const m = machine();
    m.installed[GMAIL] = OLD;
    const path = BY_HAND.find((each) => each.name === 'a global package updated');
    assert.ok(path !== undefined);
    const was = before(m);
    const approvalId = prepared(await attempt(path, m, world), 'the global update');
    const done = (await attempt(path, m, world, { approvalId })) as GatedOutcome<UpdateResult>;
    assert.equal(done.status, 'applied');
    const { result } = done as Extract<typeof done, { status: 'applied' }>;
    assert.equal(result.status, 'failed');
    assert.deepEqual(
      result.steps.map((step) => [step.kind, step.outcome, step.detail]),
      [
        [
          'global',
          'failed',
          `the verified tarball of ${GMAIL}@${LATEST} could not be downloaded, so nothing was installed`,
        ],
      ],
    );
    untouched(m, was, 'the global update');
  }

  // The install itself: bytes that are not the verified tarball, from wherever they come; and a provenance of another
  // release than the one asked for. Neither reaches npm.
  {
    const world = releases();
    const m = machine();
    const was = before(m);
    const other = await globalInstall(m, world, otherBytes);
    assert.deepEqual(other, {
      ok: false,
      detail: `the verified tarball of ${GMAIL}@${LATEST} could not be downloaded, so nothing was installed`,
    });
    const asked: string[] = [];
    const another = await globalInstall(
      m,
      world,
      async (url, init) => {
        asked.push(url);
        return world.tarballs(url, init);
      },
      OLD,
    );
    assert.deepEqual(another, { ok: false, detail: `${GMAIL}@${LATEST} was not verified before the preview` });
    assert.deepEqual(asked, [], 'a tarball was fetched for a release that was not verified');
    untouched(m, was, 'the global install');
  }
});

// ── What is kept: a release nothing here can check, never one that failed ───────────────────────────────────────

test("a channel's own command, which cannot verify, still installs the release it is running; handed a verifier, the same request is refused", async () => {
  const [path] = FIRST_INSTALL;
  assert.ok(path !== undefined);
  const { m, world } = await failingOn(path);

  // Nothing here can verify (the owner's decision, 2026-10-17): the release it runs is installed unverified, and said
  // so. Neither the registry nor npm's attestations endpoint is asked, so nothing about the release has failed.
  const asked = (await attempt(path, m, world, {
    own: GMAIL_OWN,
    installDeps: {},
  })) as GatedOutcome<ServerInstallResult>;
  assert.equal(asked.status, 'approval-required');
  const { preview } = (asked as Extract<typeof asked, { status: 'approval-required' }>).prepared;
  assert.ok(
    preview.includes(
      `${GMAIL}@${VERSION} will not be verified: this command cannot check provenance, so it installs the release it is running itself`,
    ),
    preview,
  );
  assert.deepEqual([world.registryAsked, world.attestationsAsked], [[], []], 'something was asked about the release');

  // With nothing to verify it, any other release is refused, not installed unverified.
  await refusedOn(
    path,
    m,
    world,
    { own: GMAIL_OWN, installDeps: { running: { packageName: GMAIL, version: OLD } } },
    'another release than the one it runs, with no verifier',
  );

  // Handed a verifier, the very same request checks the release, and the release fails: refused, however it is asked.
  await refusedOn(path, m, world, { own: GMAIL_OWN }, "Gmail's own command, with a verifier");
  await refusedOn(
    path,
    m,
    world,
    { own: GMAIL_OWN, installDeps: { registry: world.registry, verifyRelease: world.verifyRelease } },
    "Gmail's own command, handed a registry and a verifier",
  );
});
