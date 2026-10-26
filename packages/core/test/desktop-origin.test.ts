import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
} from '../src/desktop-origin.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * 0.32.0, after the release's security reviews (2026-10-26): what the desktop app's own approvals rest on. On macOS the
 * running process that started this one must verify, by its pid, as Agent Comms — the release, signed by the owner's
 * team, or the local test build, ad-hoc signed, only for a test profile. A speed bump against agents, not a boundary
 * against code running as the person. The unit tests stand in for `ps` and `codesign`; nothing reads a real app.
 */

const RELEASE_APP = '/Applications/Agent Comms.app/Contents/MacOS/agentcomms-desktop';
const LOCAL_CLI = '/example/home/work/agent-communications/packages/core/dist/cli.mjs';
const RELEASE_RUNTIME_CLI =
  '/example/home/.local/share/agent-communications/runtime/0.32.0-core/node_modules/@agentcomms/core/dist/cli.mjs';

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
  assert.deepEqual(await desktopAppOrigin({ ...DARWIN, exec, selfPath: RELEASE_RUNTIME_CLI }), {
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
  const origin = await desktopAppOrigin({ ...DARWIN, exec, selfPath: LOCAL_CLI });
  assert.deepEqual(origin, { ok: false, reason: 'not-agent-comms', parent: RELEASE_APP });
  // And one whose `ps` cannot say is judged by its running code alone.
  const silent: ExecFn = async (file, args) => {
    if (file === '/bin/ps') throw new Error('ps: no such process');
    return machine({ parent: '', satisfies: ['release'] }).exec(file, args);
  };
  assert.deepEqual(await desktopAppOrigin({ ...DARWIN, exec: silent, selfPath: LOCAL_CLI }), {
    ok: true,
    build: 'release',
    identifier: DESKTOP_RELEASE_IDENTIFIER,
  });
});

test('the test app is accepted by its running code beside a local build, and refused beside a release runtime', async () => {
  const { exec } = machine({
    parent: '/example/home/Applications/Agent Comms Test.app/Contents/MacOS/x',
    satisfies: ['test'],
  });
  assert.deepEqual(await desktopAppOrigin({ ...DARWIN, exec, selfPath: LOCAL_CLI }), {
    ok: true,
    build: 'test',
    identifier: DESKTOP_TEST_IDENTIFIER,
  });
  const origin = await desktopAppOrigin({ ...DARWIN, exec, selfPath: RELEASE_RUNTIME_CLI });
  assert.equal(origin.ok ? '' : origin.reason, 'test-app-with-release-runtime');
});

test('any other parent is refused: a shell, a terminal, node, another app', async () => {
  for (const parent of [
    '/bin/zsh',
    '/usr/local/bin/node',
    '/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '',
  ]) {
    const { exec } = machine({ parent, satisfies: [] });
    const origin = await desktopAppOrigin({ ...DARWIN, exec, selfPath: LOCAL_CLI });
    assert.equal(origin.ok, false, parent);
    assert.equal(origin.ok ? '' : origin.reason, 'not-agent-comms', parent);
  }
});

test('on Windows and Linux nothing is attested, and nothing is run', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const { exec, ran } = machine({ parent: '/usr/bin/agentcomms-desktop', satisfies: ['release', 'test'] });
    assert.deepEqual(await desktopAppOrigin({ ppid: 4242, platform, exec, selfPath: LOCAL_CLI }), {
      ok: false,
      reason: 'unattested-platform',
    });
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
