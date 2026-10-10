import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const nativeLibUrl = new URL('../../src-tauri/src/lib.rs', import.meta.url);
const nativeSecurityUrl = new URL('../../src-tauri/src/security.rs', import.meta.url);
const probeSourceUrl = new URL('../../src/egress-probe.ts', import.meta.url);
const preload = fileURLToPath(new URL('../../../../test/helpers/loopback-seal-preload.mjs', import.meta.url));
const script = fileURLToPath(new URL('./production-probe.mjs', import.meta.url));

async function runCase(name) {
  const productionSource = {
    'no-egress': nativeLibUrl,
    navigation: nativeLibUrl,
    download: nativeLibUrl,
    'custom-protocol': nativeSecurityUrl,
    'new-window': nativeLibUrl,
  }[name];
  assert.ok(productionSource, `${name} has no production source`);
  const source = await readFile(productionSource, 'utf8');
  assert.match(source, /deny_|allow_window_navigation|is_app_origin/);
  const child = spawn(process.execPath, ['--import', preload, script, '--case', name], {
    env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-8000);
    });
  }
  let timer;
  const status = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        child.kill();
        resolve('timeout');
      }, 1_500_000);
    }),
  ]);
  // A probe that fails at once must not hold this process open until the deadline.
  clearTimeout(timer);
  assert.equal(status, 0, `${name} packaged probe failed: ${output.slice(-2500)}`);
  assert.match(output, new RegExp(`desktop-probe-${name}: OK`));
}

// desktop-mutation: desktop-probe-attack-completeness
test('desktop-production-no-egress', async () => {
  assert.match(await readFile(probeSourceUrl, 'utf8'), /runEgressProbe/);
  await runCase('no-egress');
});

// desktop-mutation: desktop-navigation-denial
test('desktop-navigation-denial', async () => {
  await runCase('navigation');
});

// desktop-mutation: desktop-download-denial
test('desktop-download-denial', async () => {
  await runCase('download');
});

// desktop-mutation: desktop-custom-protocol-denial
test('desktop-custom-protocol-denial', async () => {
  await runCase('custom-protocol');
});

// desktop-mutation: desktop-new-window-denial
test('desktop-new-window-denial', async () => {
  await runCase('new-window');
});
