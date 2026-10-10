import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertLoopbackSeal } from '../../../../test/helpers/loopback-seal-preload.mjs';
import { startLoopbackTrap } from './loopback-trap.mjs';
import { parseProbeReport } from './probe-report.mjs';

assertLoopbackSeal();
const args = process.argv.slice(2).filter((argument) => argument !== '--');
assert.equal(args[0], '--case');
const probeCase = args[1];
assert.ok(['no-egress', 'navigation', 'download', 'custom-protocol', 'new-window'].includes(probeCase));
const desktop = new URL('../../', import.meta.url);
const bundles = ['--bundles', process.platform === 'darwin' ? 'app' : process.platform === 'win32' ? 'nsis' : 'deb'];
if (!process.env.DESKTOP_PROBE_BINARY) {
  const build = spawnSync(
    'pnpm',
    ['exec', 'tauri', 'build', '--features', 'no-egress-probe', '--no-sign', ...bundles],
    {
      cwd: desktop,
      env: { ...process.env, VITE_NO_EGRESS_PROBE: '1', CARGO_NET_OFFLINE: 'true' },
      stdio: 'inherit',
      // A cold release build of the whole dependency graph, as in a fresh mutation cache, takes several minutes.
      timeout: 1_200_000,
    },
  );
  assert.equal(build.status, 0, 'test-feature release bundle build failed');
}
// Cargo, and the Tauri bundler with it, writes under CARGO_TARGET_DIR when it is set.
const targetDir = process.env.CARGO_TARGET_DIR
  ? pathToFileURL(`${resolve(process.env.CARGO_TARGET_DIR)}/`)
  : new URL('src-tauri/target/', desktop);
const expected =
  process.platform === 'darwin'
    ? 'release/bundle/macos/Agent Communications.app/Contents/MacOS/agentcomms-desktop'
    : `release/agentcomms-desktop${process.platform === 'win32' ? '.exe' : ''}`;
const binary = process.env.DESKTOP_PROBE_BINARY ?? fileURLToPath(new URL(expected, targetDir));
assert.ok(existsSync(binary), `probe binary missing: ${binary}`);

const trap = await startLoopbackTrap();
// The app runs under a throwaway home and temporary directory: a download the guard refuses, or one a mutant lets
// through, can only land there, where it is checked, never in the person's own Downloads folder.
const home = mkdtempSync(join(tmpdir(), 'desktop-probe-home-'));
try {
  const child = spawn(binary, [], {
    cwd: desktop,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: home,
      TMP: home,
      TEMP: home,
      DESKTOP_PROBE_PORT: String(trap.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reports = new Map();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    stdout += data;
    for (const line of stdout.split('\n').slice(0, -1)) {
      const report = parseProbeReport(line);
      if (report) reports.set(report.label, report);
    }
    stdout = stdout.slice(stdout.lastIndexOf('\n') + 1);
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const done = await Promise.race([
    new Promise((resolve) => {
      const interval = setInterval(() => {
        if (reports.size === 2) {
          clearInterval(interval);
          resolve('reported');
        }
      }, 25);
      child.once('exit', () => {
        clearInterval(interval);
        resolve('exited');
      });
    }),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
  ]);
  child.kill();
  assert.equal(done, 'reported', `both webviews must report; outcome=${done}; stderr=${stderr.slice(0, 500)}`);
  assert.deepEqual([...reports.keys()].sort(), ['secrets', 'settings']);
  for (const [label, { windows, counters, complete, ipc, origin, attacks }] of reports) {
    assert.equal(windows, 2, `${label} created an extra window`);
    assert.equal(complete, true, `${label} did not complete the attack matrix`);
    assert.equal(ipc, true, `${label} did not complete the Tauri IPC round trip`);
    assert.equal(origin, true, `${label} left the compiled app origin`);
    for (const attack of [
      'fetch',
      'xhr',
      'websocket',
      'eventsource',
      'beacon',
      'image',
      'css',
      'script',
      'frame',
      'form',
      'download',
      'popup',
      'custom',
      'navigation',
    ]) {
      assert.equal(attacks[attack], true, `${label} skipped ${attack}`);
    }
    const [customBlocked, navigationBlocked, navigationAllowed, downloadBlocked, popupBlocked] = counters;
    assert.equal(navigationAllowed, 0, `${label} allowed a non-app navigation`);
    if (probeCase === 'navigation') assert.ok(navigationBlocked > 0, `${label} did not natively block navigation`);
    else if (probeCase === 'download') assert.ok(downloadBlocked > 0, `${label} did not natively block download`);
    else if (probeCase === 'custom-protocol')
      assert.ok(customBlocked > 0, `${label} did not natively block the custom protocol`);
    else if (probeCase === 'new-window') assert.ok(popupBlocked > 0, `${label} did not natively block a new window`);
    else {
      assert.ok(customBlocked > 0, `${label} custom protocol guard was not exercised`);
      assert.ok(navigationBlocked > 0, `${label} navigation guard was not exercised`);
      assert.ok(downloadBlocked > 0, `${label} download guard was not exercised`);
      assert.ok(popupBlocked > 0, `${label} popup guard was not exercised`);
    }
  }
  assert.deepEqual(trap.requests, [], 'a webview reached the loopback exfiltration trap');
  const downloaded = readdirSync(home, { recursive: true }).filter((path) => String(path).includes('synthetic'));
  assert.deepEqual(downloaded, [], 'a webview download reached the file system');
  process.stdout.write(`desktop-probe-${probeCase}: OK\n`);
} finally {
  await trap.close();
  rmSync(home, { recursive: true, force: true });
}
