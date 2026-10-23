import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { serverFacts } from '../src/channel-servers.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { findNpmCli } from '../src/mcp-install.ts';
import { npmGlobalRoot, npmInstallGlobal } from '../src/npm.ts';
import { type UpdateDeps, type UpdateResult, type UpdateStep, updateChange } from '../src/operations/update.ts';
import { fetchTarball, type TarballFetch } from '../src/release-tarball.ts';
import { coreUpdateCheckWords, terminalUpdateHooks, type UpdateCheckChildEntry } from '../src/update-check.ts';
import { changeUpdateCheck, readUpdateCheck, type UpdateCheckRecord } from '../src/update-state.ts';
import { loopbackRegistry, releaseWorld, type World, type WorldRelease } from './helpers/release-world.ts';
import { releaseTarball, unpackTarball } from './helpers/tarball-fixture.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * A global package is installed from its verified tarball, and what npm installed is checked against it (design
 * 2026-10-22 P3). Before: npm was handed `<package>@<version>` and resolved it again from a fresh read of the registry,
 * so what it installed need not be what was verified, and nothing looked afterwards: npm keeps no lockfile for a
 * global. Now the update downloads the very bytes whose sha512 the provenance signs, hands npm that file, and walks the
 * installed package — and every package of this suite inside it — against the verified tarballs. Every one of those
 * that does not match is removed before the step fails (§8.2): a nested core npm took from the registry would otherwise
 * be what a channel's day's check hands on to (P2), and starts.
 *
 * npm itself runs here, on every platform, into a prefix of the test's own, against a registry on the loopback address
 * (`loopbackRegistry`) serving a world of releases whose provenance verifies against the test's own trust root. Nothing
 * reaches npm's registry, its attestations endpoint or Sigstore, and nothing is installed outside the test's folders.
 */

const CORE = serverFacts('core').packageName;
const GMAIL = serverFacts('gmail').packageName;
const OLD = '0.0.1';
const LATEST = '99.0.0';
const MISMATCH = `the global ${GMAIL} does not match its verified release`;

let npmCli: string | null;
try {
  npmCli = await findNpmCli();
} catch {
  npmCli = null;
}
const WITH_NPM = npmCli === null ? { skip: 'no npm beside this Node: nothing installs a global package here' } : {};
const POSIX_MODES = process.platform === 'win32' ? { skip: 'Windows has no POSIX file modes' } : WITH_NPM;

/**
 * Core and Gmail as they are published: each with its command, and Gmail depending on core at its own version — so a
 * global Gmail carries a nested `@agentcomms/core`. The older release ships a file the latest no longer does, which npm
 * must not leave behind when it replaces it. `gmail` changes the latest Gmail.
 */
function world(gmail: Partial<WorldRelease> = {}): World {
  const manifests = (version: string) => ({
    [CORE]: { bin: { agentcomms: './dist/cli.mjs' } },
    [GMAIL]: { bin: { 'agent-gmail': './dist/cli.mjs' }, dependencies: { [CORE]: version } },
  });
  return releaseWorld({ [CORE]: LATEST, [GMAIL]: LATEST }, [
    { version: OLD, manifests: manifests(OLD), files: { [GMAIL]: { 'OLD.md': 'only in the older release\n' } } },
    { version: LATEST, packages: [CORE], manifests: manifests(LATEST) },
    { version: LATEST, packages: [GMAIL], manifests: manifests(LATEST), ...gmail },
  ]);
}

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  world: World;
  served: Awaited<ReturnType<typeof loopbackRegistry>>;
  /** Every tarball core asked for, in order. */
  tarballsAsked: string[];
  deps: UpdateDeps;
  close: () => Promise<void>;
}

/**
 * A home of the test's own, with npm's prefix, cache and configuration in it and its registry on the loopback. The
 * update reads that registry as it reads npm's, and core's tarballs come from it through Node's own fetch; npm's
 * canonical address is never asked from here — it answers 404, or `canonical`. Only the verifier is the test's: npm's
 * attestations and the trust root, from the world.
 */
async function machine(
  releases: World,
  options: { toNpm?: Record<string, Buffer>; canonical?: Buffer } = {},
): Promise<Machine> {
  const served = await loopbackRegistry(releases, options.toNpm === undefined ? {} : { toNpm: options.toNpm });
  const home = tempDir('comms-update-global-');
  mkdirSync(join(home, 'bin'));
  mkdirSync(join(home, 'config'));
  writeFileSync(join(home, 'config', 'config.json'), `${JSON.stringify({ version: 2 }, null, 2)}\n`);
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: [join(home, 'bin'), dirname(process.execPath)].join(delimiter),
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(home, 'secrets'),
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    NO_COLOR: '1',
    npm_config_registry: served.url,
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_prefix: join(home, 'npm-global'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  const tarballsAsked: string[] = [];
  const tarballs: TarballFetch = async (url, init) => {
    tarballsAsked.push(url);
    if (url.startsWith(served.url)) return fetchTarball(url, init);
    if (options.canonical !== undefined && url.startsWith('https://registry.npmjs.org/')) {
      return new Response(new Uint8Array(options.canonical), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return {
    home,
    env,
    core: openCore({ env, caller: CORE_CALLER }),
    world: releases,
    served,
    tarballsAsked,
    deps: {
      verifyRelease: releases.verifyRelease,
      tarballs,
      installRuntime: async () => {
        throw new Error('no runtime is installed in these tests');
      },
    },
    close: () => served.close(),
  };
}

/** Where npm itself says global packages are installed: asked of npm, never built from the prefix. */
function npmRoot(m: Machine): string {
  const answer = spawnSync(process.execPath, [String(npmCli), 'root', '--global'], { env: m.env, encoding: 'utf8' });
  assert.equal(answer.status, 0, answer.stderr);
  return answer.stdout.trim();
}

/** The global Gmail's folder. */
function installedAt(m: Machine): string {
  return join(npmRoot(m), ...GMAIL.split('/'));
}

/** A tarball's own files, unpacked by the fixture's walker. */
async function unpacked(bytes: Buffer): Promise<string> {
  const dir = tempDir('comms-update-global-unpacked-');
  await unpackTarball(bytes, dir);
  return dir;
}

/** The older Gmail, installed globally by npm itself from its own file: what an update finds and replaces. */
async function olderInstalled(m: Machine): Promise<void> {
  const file = join(tempDir('comms-update-global-older-'), 'agentcomms-gmail-0.0.1.tgz');
  writeFileSync(file, m.world.tarball(GMAIL, OLD));
  await npmInstallGlobal(m.env, file);
}

/** The update, planned and applied as a person's yes applies it; with `between` run after the plan. */
async function update(
  m: Machine,
  deps: Partial<UpdateDeps> = {},
  between?: () => void,
): Promise<{ effects: string[]; result: UpdateResult; record: UpdateCheckRecord }> {
  const change = updateChange(m.core, m.env, {}, { ...m.deps, ...deps });
  const plan = await change.plan(await m.core.config.load());
  between?.();
  const result = await change.apply(undefined, plan);
  return { effects: [...(plan.effects ?? [])], result, record: await readUpdateCheck(m.core.paths.stateDir) };
}

function globalStep(result: UpdateResult): Extract<UpdateStep, { kind: 'global' }> {
  const step = result.steps.find((one): one is Extract<UpdateStep, { kind: 'global' }> => one.kind === 'global');
  assert.ok(step, `no global step in ${JSON.stringify(result.steps)}`);
  return step;
}

/** What the update found installed, as `npm ls -g` would list it, for a test that does not install the older one. */
const olderListed = { globalPackages: async () => ({ [GMAIL]: OLD }) };

/** Whether anything is at `path`, a link included: looked at with lstat, never through it. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every path below `dir`, sorted, as lstat finds them: a link is listed, and nothing behind it. */
function tree(dir: string): string[] {
  const paths: string[] = [];
  const walk = (relative: string) => {
    for (const name of readdirSync(relative === '' ? dir : join(dir, relative))) {
      const path = relative === '' ? name : join(relative, name);
      paths.push(path);
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path);
    }
  };
  walk('');
  return paths.sort();
}

/** A link to the folder `target` at `path`: a junction on Windows, which needs no privilege, a symbolic link elsewhere. */
function linkFolder(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/** The core nested in the global package at `dir`. */
function nestedCore(dir: string, ...path: string[]): string {
  return join(dir, 'node_modules', ...CORE.split('/'), ...path);
}

/** The channel's own CLI, as its command would start it for the day's check: recorded here, never started. */
const OWN: UpdateCheckChildEntry = Object.freeze({
  command: process.execPath,
  args: Object.freeze([join(tempDir('comms-update-global-own-'), 'dist', 'cli.mjs')]),
});

/** The file where the update records each global it removed, in the state directory: what the next update reinstalls. */
const REMOVED_FILE = 'removed-globals.json';

interface RemovedEntry {
  package: string;
  version: string;
  removedAt: string;
}

/** What the record holds now: each global it lists, or none when there is no record. */
function removedEntries(m: Machine): RemovedEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(m.core.paths.stateDir, REMOVED_FILE), 'utf8'));
  } catch {
    return [];
  }
  const listed = (parsed as { removed?: unknown } | null)?.removed;
  return Array.isArray(listed) ? (listed as RemovedEntry[]) : [];
}

/** The preview's line for a global the update reinstalls: one an earlier update removed all or part of. */
const REINSTALLS = `reinstalls the global ${GMAIL} ${LATEST}, which an earlier update removed all or part of because it did not match its verified release: installs its verified tarball with \`npm install -g\`, then checks what npm installed against it`;

function flipFirstByte(file: string): void {
  const bytes = readFileSync(file);
  bytes[0] = (bytes[0] as number) ^ 0x01;
  writeFileSync(file, bytes);
}

test('a global update installs the verified tarball, not what npm would resolve by name', WITH_NPM, async () => {
  // A registry that lies to npm, and not to the check: npm, asking by name, is given another Gmail and its integrity.
  const swapped = releaseTarball(GMAIL, LATEST, {
    manifest: { dependencies: { [CORE]: LATEST } },
    files: { 'dist/cli.mjs': '// not the release its provenance signs\nprocess.exit(0);\n' },
  });
  const m = await machine(world(), { toNpm: { [GMAIL]: swapped } });
  try {
    await olderInstalled(m);
    const { effects, result, record } = await update(m);
    const dir = installedAt(m);
    const verified = await unpacked(m.world.tarball(GMAIL, LATEST));
    assert.equal(
      readFileSync(join(dir, 'dist', 'cli.mjs'), 'utf8'),
      readFileSync(join(verified, 'dist', 'cli.mjs'), 'utf8'),
      'what is installed is the verified tarball',
    );
    assert.deepEqual(globalStep(result), { kind: 'global', package: GMAIL, from: OLD, to: LATEST, outcome: 'updated' });
    assert.equal(result.ok, true);
    assert.ok(
      effects.includes(
        `updates the global ${GMAIL} from ${OLD} to ${LATEST}: installs its verified tarball with \`npm install -g\`, then checks what npm installed against it`,
      ),
      effects.join('\n'),
    );
    assert.equal(existsSync(join(dir, 'OLD.md')), false, 'npm left nothing of the older release behind');
    assert.ok(existsSync(join(dir, 'node_modules', ...CORE.split('/'), 'package.json')), 'with core nested in it');
    assert.ok(record.current?.global.includes('gmail'), `current.global: ${JSON.stringify(record.current)}`);
    // npm never asked for Gmail by name — it was handed the file — and fetched the core Gmail depends on.
    const byNpm = m.served.asked.filter((request) => request.npm).map((request) => request.url);
    assert.deepEqual(
      byNpm.filter((url) => url.includes('gmail')),
      [],
      `npm asked for: ${byNpm.join(', ')}`,
    );
    assert.ok(byNpm.includes(`/tarballs/${CORE}/-/core-${LATEST}.tgz`), `npm asked for: ${byNpm.join(', ')}`);
  } finally {
    await m.close();
  }
});

test('the verified tarball is written to a private file, removed afterwards', POSIX_MODES, async () => {
  const m = await machine(world());
  try {
    const seen: { spec: string; file: number; folder: number; bytes: Buffer }[] = [];
    const { result } = await update(m, {
      ...olderListed,
      installGlobal: async (spec) => {
        seen.push({
          spec,
          file: statSync(spec).mode & 0o777,
          folder: statSync(dirname(spec)).mode & 0o777,
          bytes: readFileSync(spec),
        });
        await npmInstallGlobal(m.env, spec);
      },
    });
    assert.equal(seen.length, 1, 'npm was run once');
    const [one] = seen as [(typeof seen)[number]];
    assert.ok(isAbsolute(one.spec) && one.spec.endsWith('.tgz'), `npm was handed ${one.spec}`);
    assert.equal(one.file.toString(8), '600', 'the file is the person’s alone');
    assert.equal(one.folder.toString(8), '700', 'in a folder that is the person’s alone');
    assert.ok(one.bytes.equals(m.world.tarball(GMAIL, LATEST)), 'it holds the verified tarball');
    assert.equal(existsSync(dirname(one.spec)), false, 'the folder is removed after the step');
    assert.equal(globalStep(result).outcome, 'updated');
  } finally {
    await m.close();
  }
});

test(
  'a changed byte, a missing file, or an extra file outside node_modules fails the step, removes what differs, and current.global stays',
  WITH_NPM,
  async (t) => {
    // `removes`: the global package itself, when it is the one that differs; the core nested in it, when only that does.
    const cases: { name: string; which: string; removes: 'it' | 'core'; change: (dir: string) => void }[] = [
      {
        name: 'a changed byte',
        which: 'a file of it differs from its verified release',
        removes: 'it',
        change: (dir) => flipFirstByte(join(dir, 'dist', 'cli.mjs')),
      },
      {
        name: 'a missing file',
        which: 'a file of its verified release is missing',
        removes: 'it',
        change: (dir) => rmSync(join(dir, 'dist', 'cli.mjs')),
      },
      {
        name: 'an extra file outside node_modules',
        which: 'it holds a file its verified release does not',
        removes: 'it',
        change: (dir) => writeFileSync(join(dir, 'dist', 'more.mjs'), 'process.exit(0);\n'),
      },
      {
        name: 'a changed byte in the core nested in it',
        which: `a file of ${CORE}@${LATEST} in it differs from its verified release`,
        removes: 'core',
        change: (dir) => flipFirstByte(nestedCore(dir, 'dist', 'cli.mjs')),
      },
    ];
    for (const each of cases) {
      await t.test(each.name, async () => {
        const m = await machine(world());
        try {
          const { result, record } = await update(m, {
            ...olderListed,
            installGlobal: async (spec) => {
              await npmInstallGlobal(m.env, spec);
              each.change(installedAt(m));
            },
          });
          const step = globalStep(result);
          assert.equal(step.outcome, 'failed');
          const removed = each.removes === 'it' ? 'so it was removed' : `so ${CORE} was removed from it`;
          assert.ok(step.detail?.startsWith(`${MISMATCH} (${each.which}), ${removed}: `), step.detail);
          assert.equal(result.ok, false);
          assert.equal(record.current?.global.includes('gmail'), false, 'current.global is unchanged');
          if (each.removes === 'it') {
            assert.equal(present(installedAt(m)), false, 'the global package is removed');
          } else {
            assert.equal(present(nestedCore(installedAt(m))), false, 'the core nested in it is removed');
            assert.ok(
              existsSync(join(installedAt(m), 'dist', 'cli.mjs')),
              'the global package itself, which matches, stays',
            );
          }
        } finally {
          await m.close();
        }
      });
    }
  },
);

test('a nested @agentcomms/core whose release does not verify fails the step, and is removed', WITH_NPM, async () => {
  const m = await machine(world());
  try {
    // Gmail's release verified for the preview; core's attestation is gone by the time npm has installed it.
    const { result, record } = await update(m, olderListed, () => m.world.change({ [CORE]: 'missing' }));
    const step = globalStep(result);
    assert.equal(step.outcome, 'failed');
    assert.ok(
      step.detail?.startsWith(
        `${MISMATCH} (${CORE}@${LATEST} in it could not be verified as built by this repository's release workflow), so ${CORE} was removed from it: `,
      ),
      step.detail,
    );
    assert.equal(record.current?.global.includes('gmail'), false);
    assert.equal(present(nestedCore(installedAt(m))), false, 'the core that could not be verified is removed');
    assert.ok(existsSync(join(installedAt(m), 'package.json')), 'the global package itself stays');
  } finally {
    await m.close();
  }
});

test(
  'a nested core the registry substituted is removed, and the channel hands its check to nothing',
  WITH_NPM,
  async () => {
    // The registry hands npm another core for the one Gmail depends on, with a command a hand-off would start; the
    // check, which reads its verified release, is told the truth. Gmail itself is installed from its verified file.
    const marker = join(tempDir('comms-update-global-marker-'), 'RAN');
    const substituted = releaseTarball(CORE, LATEST, {
      manifest: {
        engines: { node: '>=22.0.0' },
        agentcomms: { binary: 'agentcomms' },
        bin: { agentcomms: './dist/cli.mjs' },
      },
      files: {
        'dist/cli.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`,
      },
    });
    const m = await machine(world(), { toNpm: { [CORE]: substituted } });
    try {
      const { result, record } = await update(m, olderListed);
      const step = globalStep(result);
      assert.equal(step.outcome, 'failed');
      const gmail = installedAt(m);

      // The global Gmail's own command, opening core as it does, then its day's check: no core is located to hand the
      // check to, so the channel's own child is all that starts — and nothing of the substituted core runs.
      const fromGmail = openCore({
        env: m.env,
        caller: { url: pathToFileURL(join(gmail, 'dist', 'cli.mjs')).href, packageName: GMAIL },
      });
      assert.equal(
        coreUpdateCheckWords(fromGmail, new Date().toISOString()),
        null,
        'a core is located from the global Gmail',
      );
      await changeUpdateCheck(fromGmail.paths.stateDir, (current) => ({
        record: { ...current, lastChecked: new Date(Date.now() - 25 * 3_600_000).toISOString(), checking: null },
      }));
      const started: string[][] = [];
      await terminalUpdateHooks(fromGmail, m.env, {
        handOff: {
          start: async (words) => {
            started.push([...words]);
            return true;
          },
        },
        childEntry: OWN,
      }).check?.();
      assert.deepEqual(
        started.map((words) => words.slice(0, 2)),
        [[OWN.command, OWN.args[0]]],
        `started: ${JSON.stringify(started)}`,
      );
      assert.equal(existsSync(marker), false, 'the substituted core ran');

      assert.equal(present(nestedCore(gmail)), false, 'the substituted core is removed');
      assert.ok(existsSync(join(gmail, 'dist', 'cli.mjs')), 'the verified Gmail stays');
      assert.ok(
        step.detail?.startsWith(
          `${MISMATCH} (a file of ${CORE}@${LATEST} in it differs from its verified release), so ${CORE} was removed from it: `,
        ),
        step.detail,
      );
      assert.equal(record.current?.global.includes('gmail'), false);
      // Recorded, content-free, for the next update to reinstall: the global package, its release, and when.
      const removed = removedEntries(m);
      assert.deepEqual(
        removed.map((entry) => Object.keys(entry).sort()),
        [['package', 'removedAt', 'version']],
        JSON.stringify(removed),
      );
      assert.deepEqual(
        removed.map(({ package: name, version }) => [name, version]),
        [[GMAIL, LATEST]],
      );
      assert.equal(new Date(removed[0]?.removedAt as string).toISOString(), removed[0]?.removedAt);
    } finally {
      await m.close();
    }
  },
);

test('a removal never follows a link out of the global root', WITH_NPM, async (t) => {
  await t.test('a nested core that is a link: the link is removed, and the folder it points to stays', async () => {
    const m = await machine(world());
    try {
      const outside = join(m.home, 'outside', 'core');
      let before: string[] = [];
      const { result } = await update(m, {
        ...olderListed,
        installGlobal: async (spec) => {
          await npmInstallGlobal(m.env, spec);
          // The core npm installed, moved out of the global root with a link in its place: a removal that followed the
          // link would empty that folder.
          const nested = nestedCore(installedAt(m));
          mkdirSync(dirname(outside), { recursive: true });
          renameSync(nested, outside);
          linkFolder(outside, nested);
          before = tree(outside);
        },
      });
      assert.ok(before.includes('package.json'), `outside: ${before.join(', ')}`);
      assert.deepEqual(present(outside) ? tree(outside) : [], before, 'the folder the link pointed to is as it was');
      const step = globalStep(result);
      assert.ok(
        step.detail?.startsWith(
          `${MISMATCH} (${CORE} in it is a link, not an installed package), so ${CORE} was removed from it: `,
        ),
        step.detail,
      );
      assert.equal(present(nestedCore(installedAt(m))), false, 'the link is removed');
    } finally {
      await m.close();
    }
  });

  await t.test(
    'a global package removed with a link in it: the link goes, and the folder it points to stays',
    async () => {
      const m = await machine(world());
      try {
        const outside = join(m.home, 'outside', 'left-pad');
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, 'index.js'), 'module.exports = () => {};\n');
        const before = tree(outside);
        const { result } = await update(m, {
          ...olderListed,
          installGlobal: async (spec) => {
            await npmInstallGlobal(m.env, spec);
            flipFirstByte(join(installedAt(m), 'dist', 'cli.mjs'));
            linkFolder(outside, join(installedAt(m), 'node_modules', 'left-pad'));
          },
        });
        assert.deepEqual(
          present(outside) ? tree(outside) : [],
          before,
          'the folder the link in it pointed to is as it was',
        );
        const step = globalStep(result);
        assert.ok(
          step.detail?.startsWith(`${MISMATCH} (a file of it differs from its verified release), so it was removed: `),
          step.detail,
        );
        assert.equal(present(installedAt(m)), false, 'the global package is removed');
      } finally {
        await m.close();
      }
    },
  );

  await t.test('a scope folder that links out of the global root: nothing is removed through it', async () => {
    const m = await machine(world());
    try {
      const outside = join(m.home, 'outside', '@agentcomms');
      let before: string[] = [];
      const { result } = await update(m, {
        ...olderListed,
        installGlobal: async (spec) => {
          await npmInstallGlobal(m.env, spec);
          // `<root>/@agentcomms` moved out of the global root, with a link in its place, and Gmail changed in it: the
          // check reads Gmail through the link, and a removal by that path would reach outside the root.
          const scope = join(npmRoot(m), '@agentcomms');
          mkdirSync(dirname(outside), { recursive: true });
          renameSync(scope, outside);
          linkFolder(outside, scope);
          flipFirstByte(join(outside, 'gmail', 'dist', 'cli.mjs'));
          before = tree(outside);
        },
      });
      assert.ok(before.includes(join('gmail', 'package.json')), `outside: ${before.join(', ')}`);
      assert.deepEqual(present(outside) ? tree(outside) : [], before, 'nothing outside the global root is removed');
      const step = globalStep(result);
      assert.ok(
        step.detail?.startsWith(
          `${MISMATCH} (a file of it differs from its verified release), and it could not be removed: `,
        ),
        step.detail,
      );
      assert.ok(lstatSync(join(npmRoot(m), '@agentcomms')).isSymbolicLink(), 'the link is left as it was');
    } finally {
      await m.close();
    }
  });
});

test('an install that matches its verified release removes nothing', WITH_NPM, async () => {
  const m = await machine(world());
  try {
    let installed: string[] = [];
    const { result } = await update(m, {
      ...olderListed,
      installGlobal: async (spec) => {
        await npmInstallGlobal(m.env, spec);
        installed = tree(installedAt(m));
      },
    });
    assert.equal(globalStep(result).outcome, 'updated');
    assert.ok(installed.includes(join('node_modules', ...CORE.split('/'), 'package.json')), installed.join(', '));
    assert.deepEqual(tree(installedAt(m)), installed, 'everything npm installed is still there');
    assert.deepEqual(removedEntries(m), [], 'nothing is recorded for the next update to reinstall');
  } finally {
    await m.close();
  }
});

test(
  'a global the update removed part of is reinstalled by the next update, and the record is cleared',
  WITH_NPM,
  async () => {
    const m = await machine(world());
    try {
      let tamper = true;
      const installGlobal = async (spec: string) => {
        await npmInstallGlobal(m.env, spec);
        if (tamper) flipFirstByte(nestedCore(installedAt(m), 'dist', 'cli.mjs'));
      };
      const first = await update(m, { ...olderListed, installGlobal });
      assert.equal(globalStep(first.result).outcome, 'failed');
      assert.equal(present(nestedCore(installedAt(m))), false, 'the core that differed is removed');
      assert.deepEqual(
        removedEntries(m).map(({ package: name, version }) => [name, version]),
        [[GMAIL, LATEST]],
      );

      // npm itself now lists Gmail at its latest release, with no core in it: by version alone nothing is behind.
      tamper = false;
      const second = await update(m, { installGlobal });
      assert.ok(second.effects.includes(REINSTALLS), second.effects.join('\n'));
      assert.deepEqual(globalStep(second.result), {
        kind: 'global',
        package: GMAIL,
        from: LATEST,
        to: LATEST,
        outcome: 'updated',
      });
      assert.ok(
        existsSync(nestedCore(installedAt(m), 'package.json')),
        'the core is back, checked against its release',
      );
      assert.deepEqual(removedEntries(m), [], 'the record is cleared once the install verifies');
      assert.ok(second.record.current?.global.includes('gmail'), JSON.stringify(second.record.current));
    } finally {
      await m.close();
    }
  },
);

test(
  'a global package the update removed is reinstalled by the next update, though npm no longer lists it',
  WITH_NPM,
  async () => {
    const m = await machine(world());
    try {
      let tamper = true;
      const installGlobal = async (spec: string) => {
        await npmInstallGlobal(m.env, spec);
        if (tamper) flipFirstByte(join(installedAt(m), 'dist', 'cli.mjs'));
      };
      const first = await update(m, { ...olderListed, installGlobal });
      assert.equal(globalStep(first.result).outcome, 'failed');
      assert.equal(present(installedAt(m)), false, 'the global package is removed');

      tamper = false;
      const second = await update(m, { installGlobal });
      assert.ok(second.effects.includes(REINSTALLS), second.effects.join('\n'));
      assert.deepEqual(globalStep(second.result), {
        kind: 'global',
        package: GMAIL,
        from: LATEST,
        to: LATEST,
        outcome: 'updated',
      });
      assert.ok(existsSync(join(installedAt(m), 'dist', 'cli.mjs')), 'the global package is installed again');
      assert.deepEqual(removedEntries(m), [], 'the record is cleared once the install verifies');
      assert.ok(second.record.current?.global.includes('gmail'), JSON.stringify(second.record.current));
    } finally {
      await m.close();
    }
  },
);

test('a reinstall that fails again keeps the record, and the global is not counted as current', WITH_NPM, async () => {
  const m = await machine(world());
  try {
    const installGlobal = async (spec: string) => {
      await npmInstallGlobal(m.env, spec);
      flipFirstByte(join(installedAt(m), 'dist', 'cli.mjs'));
    };
    await update(m, { ...olderListed, installGlobal });
    assert.deepEqual(
      removedEntries(m).map(({ package: name }) => name),
      [GMAIL],
    );

    const second = await update(m, { installGlobal });
    assert.ok(second.effects.includes(REINSTALLS), second.effects.join('\n'));
    assert.equal(globalStep(second.result).outcome, 'failed');
    assert.deepEqual(
      removedEntries(m).map(({ package: name, version }) => [name, version]),
      [[GMAIL, LATEST]],
      'the record stays for the update after',
    );
    assert.equal(second.record.current?.global.includes('gmail'), false, 'a global not installed is not current');

    // And the update after that plans the reinstall once more.
    const third = await update(m, { installGlobal: async (spec) => npmInstallGlobal(m.env, spec) });
    assert.equal(globalStep(third.result).outcome, 'updated');
    assert.deepEqual(removedEntries(m), []);
  } finally {
    await m.close();
  }
});

test('on Windows a removal refused for a moment is tried again; elsewhere, and for other errors, it is not', async (t) => {
  const { removeInside } = (await import('../src/global-install.ts')) as unknown as {
    removeInside: (
      root: string,
      dir: string,
      options?: {
        platform?: NodeJS.Platform;
        remove?: (path: string) => Promise<void>;
        pause?: (ms: number) => Promise<void>;
      },
    ) => Promise<boolean>;
  };
  const installed = () => {
    const root = tempDir('comms-update-global-retry-');
    const dir = join(root, '@agentcomms', 'gmail');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.mjs'), 'process.exit(0);\n');
    return { root, dir };
  };
  /** A remover that refuses with each of `codes` in turn, then removes. */
  const refusing = (...codes: string[]) => {
    const calls: string[] = [];
    return {
      calls,
      remove: async (path: string) => {
        calls.push(path);
        const code = codes[calls.length - 1];
        if (code !== undefined) throw Object.assign(new Error(`${code}: refused, for the test`), { code });
        rmSync(path, { recursive: true });
      },
    };
  };
  const pauses: number[] = [];
  const pause = async (ms: number) => {
    pauses.push(ms);
  };

  await t.test('refused with EBUSY, then EPERM, on Windows: tried again, and removed', async () => {
    const { root, dir } = installed();
    const remover = refusing('EBUSY', 'EPERM');
    assert.equal(await removeInside(root, dir, { platform: 'win32', remove: remover.remove, pause }), true);
    assert.deepEqual(remover.calls, [dir, dir, dir]);
    assert.equal(present(dir), false);
  });

  await t.test('refused every time on Windows: given up after five tries, briefly', async () => {
    const { root, dir } = installed();
    const remover = refusing('EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY');
    pauses.length = 0;
    assert.equal(await removeInside(root, dir, { platform: 'win32', remove: remover.remove, pause }), false);
    assert.equal(remover.calls.length, 5, 'five tries');
    assert.ok(pauses.length === 4 && pauses.every((ms) => ms > 0 && ms <= 500), `paused ${pauses.join(', ')} ms`);
    assert.ok(present(dir), 'what could not be removed is still there, and said to be');
  });

  await t.test('refused with EBUSY elsewhere: not tried again', async () => {
    const { root, dir } = installed();
    const remover = refusing('EBUSY');
    assert.equal(await removeInside(root, dir, { platform: 'linux', remove: remover.remove, pause }), false);
    assert.equal(remover.calls.length, 1);
  });

  await t.test('refused with another error on Windows: not tried again', async () => {
    const { root, dir } = installed();
    const remover = refusing('EACCES');
    assert.equal(await removeInside(root, dir, { platform: 'win32', remove: remover.remove, pause }), false);
    assert.equal(remover.calls.length, 1);
  });
});

test("npm's own files inside node_modules are not refused", WITH_NPM, async () => {
  const m = await machine(world());
  try {
    await olderInstalled(m);
    const { result } = await update(m, {
      installGlobal: async (spec) => {
        await npmInstallGlobal(m.env, spec);
        // What npm, or a later npm, may keep beside the packages it installs: a lockfile, and a package not ours.
        const modules = join(installedAt(m), 'node_modules');
        writeFileSync(join(modules, '.package-lock.json'), '{}\n');
        mkdirSync(join(modules, 'left-pad'));
        writeFileSync(join(modules, 'left-pad', 'index.js'), 'module.exports = () => {};\n');
      },
    });
    assert.deepEqual(globalStep(result), { kind: 'global', package: GMAIL, from: OLD, to: LATEST, outcome: 'updated' });
    assert.ok(existsSync(join(installedAt(m), 'node_modules', ...CORE.split('/'), 'package.json')));
  } finally {
    await m.close();
  }
});

test('a verified tarball that cannot be downloaded installs nothing', WITH_NPM, async () => {
  const other = releaseTarball(GMAIL, LATEST, { files: { 'OTHER.md': 'not the tarball its provenance signs\n' } });
  const m = await machine(world({ serve: 'other-bytes' }), { canonical: other });
  try {
    const handed: string[] = [];
    const { result, record } = await update(m, {
      ...olderListed,
      installGlobal: async (spec) => {
        handed.push(spec);
      },
    });
    assert.deepEqual(handed, [], 'npm was never run');
    assert.deepEqual(globalStep(result), {
      kind: 'global',
      package: GMAIL,
      from: OLD,
      to: LATEST,
      outcome: 'failed',
      detail: `the verified tarball of ${GMAIL}@${LATEST} could not be downloaded, so nothing was installed`,
    });
    // Gmail's location, then npm's canonical address once; both gave bytes that are not the verified ones.
    assert.deepEqual(
      m.tarballsAsked.filter((url) => url.includes('gmail')),
      [
        `${m.served.url}tarballs/${GMAIL}/-/gmail-${LATEST}.tgz`,
        `https://registry.npmjs.org/${GMAIL}/-/gmail-${LATEST}.tgz`,
      ],
    );
    assert.equal(record.current?.global.includes('gmail'), false);
  } finally {
    await m.close();
  }
});

test('a global package that is a link is a mismatch: the link is removed, and not followed', WITH_NPM, async () => {
  const m = await machine(world());
  try {
    const checkout = join(m.home, 'checkout', 'gmail');
    let before: string[] = [];
    const { result, record } = await update(m, {
      ...olderListed,
      installGlobal: async (spec) => {
        await npmInstallGlobal(m.env, spec);
        // The very files npm installed, moved to a checkout of their own, with a link in their place: a check that
        // followed the link would find every one of them as it should be, and a removal that followed it would empty
        // the checkout.
        const dir = installedAt(m);
        mkdirSync(dirname(checkout), { recursive: true });
        renameSync(dir, checkout);
        linkFolder(checkout, dir);
        before = tree(checkout);
      },
    });
    assert.ok(before.includes('package.json'), `checkout: ${before.join(', ')}`);
    assert.deepEqual(present(checkout) ? tree(checkout) : [], before, 'the checkout it pointed to is as it was');
    const step = globalStep(result);
    assert.equal(step.outcome, 'failed');
    assert.ok(
      step.detail?.startsWith(`${MISMATCH} (it is a link, not the installed package), so it was removed: `),
      step.detail,
    );
    assert.equal(record.current?.global.includes('gmail'), false);
    assert.equal(present(installedAt(m)), false, 'the link is removed');
  } finally {
    await m.close();
  }
});

test(
  'the global folder is where npm itself says it is: <prefix>/node_modules on Windows, <prefix>/lib/node_modules elsewhere',
  WITH_NPM,
  async () => {
    const m = await machine(world());
    try {
      const root = await npmGlobalRoot(m.env);
      assert.equal(root, npmRoot(m));
      assert.ok(isAbsolute(root), root);
      assert.ok(root.startsWith(m.env.npm_config_prefix as string), `${root} is in the test's own prefix`);
    } finally {
      await m.close();
    }
  },
);
