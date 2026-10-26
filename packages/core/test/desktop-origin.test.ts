import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DESKTOP_RELEASE_IDENTIFIER,
  DESKTOP_RELEASE_REQUIREMENT,
  DESKTOP_TEST_IDENTIFIER,
  DESKTOP_TEST_REQUIREMENT,
  desktopAppOrigin,
  type ExecFn,
  TEST_PROFILE_MARKER,
} from '../src/desktop-origin.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * 0.32.0, after the release's security reviews (2026-10-26): what the desktop app's own approvals rest on. On macOS the
 * running process that started this one must verify, by its pid, as Agent Comms — the release, signed by the owner's
 * team, or the local test build, ad-hoc signed, only for a test profile. A speed bump against agents, not a boundary
 * against code running as the person. The unit tests stand in for `ps` and `codesign`; nothing reads a real app.
 */

const RELEASE_APP = '/Applications/Agent Comms.app/Contents/MacOS/agentcomms-desktop';
/** The real default config folder, as core resolves it with no pin, and a test profile's, marked as the script marks it. */
const REAL_CONFIG = '/example/home/.config/agent-communications';
function testProfile(marked = true): string {
  const dir = tempDir('origin-profile-');
  if (marked) writeFileSync(join(dir, TEST_PROFILE_MARKER), '');
  return dir;
}

/** A machine: what `ps` says the parent calls itself, and which requirements its running code satisfies. */
function machine(options: { parent: string; satisfies?: ('release' | 'test')[] }): { exec: ExecFn; ran: string[][] } {
  const ran: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    ran.push([file, ...args]);
    if (file === '/bin/ps') {
      assert.deepEqual(args, ['-p', '4242', '-o', 'comm=']);
      return `${options.parent}\n`;
    }
    if (file === '/usr/bin/codesign') {
      // The running process, by its pid: never a path, which anything can name.
      assert.equal(args.at(-1), '4242');
      assert.deepEqual(args.slice(0, 3), ['--verify', '--strict', '--test-requirement']);
      const requirement = args[3];
      const which =
        requirement === DESKTOP_RELEASE_REQUIREMENT
          ? 'release'
          : requirement === DESKTOP_TEST_REQUIREMENT
            ? 'test'
            : null;
      assert.ok(which !== null, `an unknown requirement: ${requirement}`);
      if (options.satisfies?.includes(which)) return '';
      throw new Error('codesign: code failed to satisfy specified code requirement(s)');
    }
    throw new Error(`no stand-in for ${file}`);
  };
  return { exec, ran };
}

const DARWIN = { ppid: 4242, platform: 'darwin' as const };

test('the release app is attested by its running code: the pid verifies against the owner-team requirement', async () => {
  const { exec, ran } = machine({ parent: RELEASE_APP, satisfies: ['release'] });
  assert.deepEqual(await desktopAppOrigin({ ...DARWIN, exec, configDir: REAL_CONFIG, defaultConfigDir: REAL_CONFIG }), {
    ok: true,
    build: 'release',
    identifier: DESKTOP_RELEASE_IDENTIFIER,
  });
  assert.match(DESKTOP_RELEASE_REQUIREMENT, /identifier "com\.cueplusplus\.agentcomms"/);
  assert.match(DESKTOP_RELEASE_REQUIREMENT, /anchor apple generic/);
  assert.match(DESKTOP_RELEASE_REQUIREMENT, /certificate leaf\[subject\.OU\] = "75K3LTUM8A"/);
  assert.equal(DESKTOP_TEST_REQUIREMENT, `=identifier "${DESKTOP_TEST_IDENTIFIER}"`);
  // Programs by their full paths, never through a shell.
  for (const [file] of ran) assert.match(file ?? '', /^\/(?:bin|usr\/bin)\//);
});

test('a parent that only calls itself the app is refused: argv[0] is the name a process gives itself', async () => {
  // `exec -a "/Applications/Agent Comms.app/…" /bin/sh`: `ps` says the app, and its running code is the shell's.
  const { exec } = machine({ parent: RELEASE_APP, satisfies: [] });
  const origin = await desktopAppOrigin({ ...DARWIN, exec, configDir: REAL_CONFIG, defaultConfigDir: REAL_CONFIG });
  assert.deepEqual(origin, { ok: false, reason: 'not-agent-comms', parent: RELEASE_APP });
  // And one whose `ps` cannot say is judged by its running code alone.
  const silent: ExecFn = async (file, args) => {
    if (file === '/bin/ps') throw new Error('ps: no such process');
    return machine({ parent: '', satisfies: ['release'] }).exec(file, args);
  };
  assert.deepEqual(
    await desktopAppOrigin({ ...DARWIN, exec: silent, configDir: REAL_CONFIG, defaultConfigDir: REAL_CONFIG }),
    {
      ok: true,
      build: 'release',
      identifier: DESKTOP_RELEASE_IDENTIFIER,
    },
  );
});

test('the test app is accepted only for a marked test profile, never the real one: its own audit name follows', async () => {
  const { exec } = machine({
    parent: '/example/home/Applications/Agent Comms Test.app/Contents/MacOS/x',
    satisfies: ['test'],
  });
  const profile = testProfile();
  assert.deepEqual(await desktopAppOrigin({ ...DARWIN, exec, configDir: profile, defaultConfigDir: REAL_CONFIG }), {
    ok: true,
    build: 'test',
    identifier: DESKTOP_TEST_IDENTIFIER,
  });
  // A folder the script did not mark: any home-made ad-hoc app with the test identifier, beside any install of the CLI.
  const unmarked = await desktopAppOrigin({
    ...DARWIN,
    exec,
    configDir: testProfile(false),
    defaultConfigDir: REAL_CONFIG,
  });
  assert.equal(unmarked.ok ? '' : unmarked.reason, 'not-a-test-profile');
  // The real, default folder, even marked.
  const real = testProfile();
  const atReal = await desktopAppOrigin({ ...DARWIN, exec, configDir: real, defaultConfigDir: real });
  assert.equal(atReal.ok ? '' : atReal.reason, 'test-app-with-real-profile');
  // No folder named: nothing to check, so nothing accepted.
  const unknown = await desktopAppOrigin({ ...DARWIN, exec, defaultConfigDir: REAL_CONFIG });
  assert.equal(unknown.ok ? '' : unknown.reason, 'test-profile-unknown');
  // A marker that is a link, not the file the script writes, does not count.
  const linked = testProfile(false);
  symlinkSync(join(profile, TEST_PROFILE_MARKER), join(linked, TEST_PROFILE_MARKER));
  const viaLink = await desktopAppOrigin({ ...DARWIN, exec, configDir: linked, defaultConfigDir: REAL_CONFIG });
  assert.equal(viaLink.ok ? '' : viaLink.reason, 'not-a-test-profile');
  // The release needs no marker: it speaks for any folder, the real one included.
  const release = machine({ parent: RELEASE_APP, satisfies: ['release'] });
  assert.equal(
    (await desktopAppOrigin({ ...DARWIN, exec: release.exec, configDir: REAL_CONFIG, defaultConfigDir: REAL_CONFIG }))
      .ok,
    true,
  );
});

test("the local test release marks its test profile's config folder with this marker, and nothing else", () => {
  const script = readFileSync(
    fileURLToPath(new URL('../../../scripts/local-test-release.sh', import.meta.url)),
    'utf8',
  );
  const writes = script
    .split('\n')
    .filter((line) => line.includes(TEST_PROFILE_MARKER) && !line.trim().startsWith('#'));
  assert.deepEqual(writes, [`: > "$profile/config/${TEST_PROFILE_MARKER}"`]);
});

test('any other parent is refused: a shell, a terminal, node, another app', async () => {
  for (const parent of [
    '/bin/zsh',
    '/usr/local/bin/node',
    '/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '',
  ]) {
    const { exec } = machine({ parent, satisfies: [] });
    const origin = await desktopAppOrigin({ ...DARWIN, exec, configDir: REAL_CONFIG, defaultConfigDir: REAL_CONFIG });
    assert.equal(origin.ok, false, parent);
    assert.equal(origin.ok ? '' : origin.reason, 'not-agent-comms', parent);
  }
});

test('on Windows and Linux nothing is attested, and nothing is run', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const { exec, ran } = machine({ parent: '/usr/bin/agentcomms-desktop', satisfies: ['release', 'test'] });
    assert.deepEqual(
      await desktopAppOrigin({ ppid: 4242, platform, exec, configDir: REAL_CONFIG, defaultConfigDir: REAL_CONFIG }),
      {
        ok: false,
        reason: 'unattested-platform',
      },
    );
    assert.deepEqual(ran, []);
  }
});

// ── The real spoof, on macOS ──────────────────────────────────────────────────────────────────────────────────────

const ON_MACOS = process.platform === 'darwin' ? {} : { skip: 'only macOS has codesign and exec -a to try it with' };
const ORIGIN = fileURLToPath(new URL('../src/desktop-origin.ts', import.meta.url));

test(
  'a real `exec -a` spoof of the app is refused: the running parent is the shell, whatever argv[0] says',
  ON_MACOS,
  () => {
    const dir = tempDir('origin-spoof-');
    const probe = join(dir, 'probe.mts');
    writeFileSync(
      probe,
      `import { execFileSync } from 'node:child_process';
const { desktopAppOrigin } = await import(${JSON.stringify(ORIGIN)});
const comm = execFileSync('/bin/ps', ['-p', String(process.ppid), '-o', 'comm='], { encoding: 'utf8' }).trim();
console.log(JSON.stringify({ comm, origin: await desktopAppOrigin() }));
`,
    );
    const node = [process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning', probe]
      .map((word) => `'${word.replaceAll("'", `'\\''`)}'`)
      .join(' ');
    // The inner shell forks node (`; true` keeps it from exec'ing it), so node's parent is the shell named as the app.
    const run = spawnSync(
      '/bin/bash',
      ['-c', `exec -a ${JSON.stringify(RELEASE_APP)} /bin/bash -c "${node.replaceAll('"', '\\"')}; true"`],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: dir },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const seen = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as {
      comm: string;
      origin: { ok: boolean; reason?: string };
    };
    assert.equal(seen.comm, RELEASE_APP, 'the spoof is in effect: ps names the app');
    assert.equal(seen.origin.ok, false);
    assert.equal(seen.origin.reason, 'not-agent-comms');
  },
);
