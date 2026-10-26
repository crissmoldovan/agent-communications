import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DESKTOP_RELEASE_IDENTIFIER,
  DESKTOP_RELEASE_REQUIREMENT,
  DESKTOP_TEST_IDENTIFIER,
  desktopAppOrigin,
  type ExecFn,
} from '../src/desktop-origin.ts';

/*
 * 0.32.0, after the release's security review (2026-10-26): what the desktop app's own approvals rest on. On macOS the
 * process that started this one must be Agent Comms itself — its executable inside an app bundle that codesign verifies:
 * the release, signed by the owner's team, or the local test build, ad-hoc signed, only beside a local build of the
 * CLI. Every program here is a stand-in: nothing runs `ps`, `plutil` or `codesign`, and no real app is read.
 */

const RELEASE_APP = '/Applications/Agent Comms.app';
const TEST_APP = '/example/home/Applications/Agent Comms Test.app';
const LOCAL_CLI = '/example/home/work/agent-communications/packages/core/dist/cli.mjs';
const RELEASE_RUNTIME_CLI =
  '/example/home/.local/share/agent-communications/runtime/0.32.0-core/node_modules/@agentcomms/core/dist/cli.mjs';

/** A machine: what `ps` says the parent is, each bundle's identifier, and which codesign checks pass. */
function machine(options: {
  parent: string;
  identifiers?: Record<string, string>;
  /** `bundle` passes a plain `--verify --strict`; `release:<bundle>` passes the release requirement too. */
  passes?: string[];
}): { exec: ExecFn; ran: string[][] } {
  const ran: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    ran.push([file, ...args]);
    if (file === '/bin/ps') {
      assert.deepEqual(args, ['-p', '4242', '-o', 'comm=']);
      return `${options.parent}\n`;
    }
    if (file === '/usr/bin/plutil') {
      const plist = args[args.length - 1] ?? '';
      const bundle = plist.replace(/\/Contents\/Info\.plist$/, '');
      const identifier = options.identifiers?.[bundle];
      if (identifier === undefined) throw new Error('plutil: no such key');
      return `${identifier}\n`;
    }
    if (file === '/usr/bin/codesign') {
      const bundle = args[args.length - 1] ?? '';
      const requirement = args.indexOf('--test-requirement');
      const key = requirement === -1 ? bundle : `release:${bundle}`;
      if (requirement !== -1) assert.equal(args[requirement + 1], DESKTOP_RELEASE_REQUIREMENT);
      assert.ok(args.includes('--verify') && args.includes('--strict'));
      if (options.passes?.includes(key)) return '';
      throw new Error('codesign: code failed to satisfy specified code requirement(s)');
    }
    throw new Error(`no stand-in for ${file}`);
  };
  return { exec, ran };
}

const DARWIN = { ppid: 4242, platform: 'darwin' as const };

test('the release app is attested: its bundle passes the owner-team requirement', async () => {
  const { exec, ran } = machine({
    parent: `${RELEASE_APP}/Contents/MacOS/agentcomms-desktop`,
    passes: [RELEASE_APP, `release:${RELEASE_APP}`],
  });
  assert.deepEqual(await desktopAppOrigin({ ...DARWIN, exec, selfPath: RELEASE_RUNTIME_CLI }), {
    ok: true,
    build: 'release',
    identifier: DESKTOP_RELEASE_IDENTIFIER,
  });
  assert.match(DESKTOP_RELEASE_REQUIREMENT, /identifier "com\.cueplusplus\.agentcomms"/);
  assert.match(DESKTOP_RELEASE_REQUIREMENT, /anchor apple generic/);
  assert.match(DESKTOP_RELEASE_REQUIREMENT, /certificate leaf\[subject\.OU\] = "75K3LTUM8A"/);
  // Programs by their full paths, never through a shell.
  for (const [file] of ran) assert.match(file ?? '', /^\/(?:bin|usr\/bin)\//);
});

test('the test app is attested beside a local build of the CLI: its own identifier, and an ad-hoc signature that verifies', async () => {
  const { exec } = machine({
    parent: `${TEST_APP}/Contents/MacOS/agentcomms-desktop`,
    identifiers: { [TEST_APP]: DESKTOP_TEST_IDENTIFIER },
    passes: [TEST_APP],
  });
  assert.deepEqual(await desktopAppOrigin({ ...DARWIN, exec, selfPath: LOCAL_CLI }), {
    ok: true,
    build: 'test',
    identifier: DESKTOP_TEST_IDENTIFIER,
  });
});

test('the test app is refused beside a release runtime: an ad-hoc app never speaks for a managed install', async () => {
  const { exec } = machine({
    parent: `${TEST_APP}/Contents/MacOS/agentcomms-desktop`,
    identifiers: { [TEST_APP]: DESKTOP_TEST_IDENTIFIER },
    passes: [TEST_APP],
  });
  const origin = await desktopAppOrigin({ ...DARWIN, exec, selfPath: RELEASE_RUNTIME_CLI });
  assert.equal(origin.ok, false);
  assert.equal(origin.ok ? '' : origin.reason, 'test-app-with-release-runtime');
});

test('a parent that is not an app bundle is refused: a shell, a terminal, node', async () => {
  for (const parent of ['/bin/zsh', '/usr/local/bin/node', '/Applications/Agent Comms.app', '-zsh', '']) {
    const { exec } = machine({ parent, passes: [RELEASE_APP, `release:${RELEASE_APP}`] });
    const origin = await desktopAppOrigin({ ...DARWIN, exec, selfPath: LOCAL_CLI });
    assert.equal(origin.ok, false, parent);
    assert.equal(origin.ok ? '' : origin.reason, 'parent-not-an-app', parent);
  }
});

test('an app whose signature does not verify is refused, and so is any other app', async () => {
  // Agent Comms Test, whose ad-hoc signature does not verify.
  let { exec } = machine({
    parent: `${TEST_APP}/Contents/MacOS/agentcomms-desktop`,
    identifiers: { [TEST_APP]: DESKTOP_TEST_IDENTIFIER },
  });
  let origin = await desktopAppOrigin({ ...DARWIN, exec, selfPath: LOCAL_CLI });
  assert.equal(origin.ok ? '' : origin.reason, 'signature-not-verified');
  // Another app, however it is signed, saying it is the release.
  ({ exec } = machine({
    parent: '/Applications/Terminal.app/Contents/MacOS/Terminal',
    identifiers: { '/Applications/Terminal.app': 'com.apple.Terminal' },
    passes: ['/Applications/Terminal.app'],
  }));
  origin = await desktopAppOrigin({ ...DARWIN, exec, selfPath: LOCAL_CLI });
  assert.equal(origin.ok ? '' : origin.reason, 'not-agent-comms');
  // A bundle that claims the release's identifier but fails the team requirement.
  ({ exec } = machine({
    parent: `${RELEASE_APP}/Contents/MacOS/agentcomms-desktop`,
    identifiers: { [RELEASE_APP]: DESKTOP_RELEASE_IDENTIFIER },
    passes: [RELEASE_APP],
  }));
  origin = await desktopAppOrigin({ ...DARWIN, exec, selfPath: LOCAL_CLI });
  assert.equal(origin.ok ? '' : origin.reason, 'not-agent-comms');
  // `ps` that cannot say.
  const failing: ExecFn = async () => {
    throw new Error('ps: no such process');
  };
  origin = await desktopAppOrigin({ ...DARWIN, exec: failing, selfPath: LOCAL_CLI });
  assert.equal(origin.ok ? '' : origin.reason, 'parent-unknown');
});

test('on Windows and Linux nothing is attested, and nothing is run', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const { exec, ran } = machine({ parent: '/usr/bin/agentcomms-desktop' });
    assert.deepEqual(await desktopAppOrigin({ ppid: 4242, platform, exec, selfPath: LOCAL_CLI }), {
      ok: false,
      reason: 'unattested-platform',
    });
    assert.deepEqual(ran, []);
  }
});
