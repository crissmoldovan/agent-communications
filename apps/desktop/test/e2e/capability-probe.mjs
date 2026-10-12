import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertLoopbackSeal } from '../../../../test/helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

if (!process.env.DESKTOP_PROBE_BINARY) {
  const build = spawnSync(
    'pnpm',
    ['exec', 'tauri', 'build', '--features', 'no-egress-probe', '--no-sign', '--no-bundle'],
    {
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, VITE_NO_EGRESS_PROBE: '1', CARGO_NET_OFFLINE: 'true' },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  assert.equal(build.status, 0, 'production capability probe build failed');
}
const target = process.env.CARGO_TARGET_DIR
  ? pathToFileURL(`${resolve(process.env.CARGO_TARGET_DIR)}/`)
  : new URL('../../src-tauri/target/', import.meta.url);
const binary =
  process.env.DESKTOP_PROBE_BINARY ??
  fileURLToPath(new URL(`release/agentcomms-desktop${process.platform === 'win32' ? '.exe' : ''}`, target));
const child = spawn(binary, [], {
  env: { ...process.env, DESKTOP_PROBE_CAPABILITIES: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (value) => {
  output += String(value);
});
child.stderr.resume();
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(
        new Error(
          `production webview capability probe timed out (${(output.match(/:capabilities,/gu) ?? []).length}/3 reports)`,
        ),
      );
    }, 15000);
    const interval = setInterval(() => {
      if ((output.match(/:capabilities,/gu) ?? []).length === 3) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 25);
    child.once('error', () => {
      clearTimeout(timeout);
      clearInterval(interval);
      reject(new Error('production webview capability probe could not spawn'));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      clearInterval(interval);
      reject(new Error(`production webview capability probe exited (code ${code}, signal ${signal})`));
    });
  });
  for (const label of ['settings', 'secrets', 'synthetic-third']) {
    const match = output.match(new RegExp(`desktop-probe:${label}:3:[^:]*:capabilities,(\\d+),(\\d+),(\\d+)`));
    assert.ok(match, `${label} did not report its actual raw invocations`);
    assert.equal(Number(match[1]), label === 'secrets' ? 8 : 0, `${label} secret command grants`);
    assert.equal(Number(match[2]), label === 'secrets' ? 0 : 8, `${label} secret command refusals`);
    assert.equal(Number(match[3]), label === 'secrets' ? 2 : 0, `${label} generic and approval exclusion`);
  }
  process.stdout.write('desktop-probe-capabilities: OK\n');
} finally {
  child.kill();
}
