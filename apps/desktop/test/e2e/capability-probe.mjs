import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { assertLoopbackSeal } from '../../../../test/helpers/loopback-seal-preload.mjs';
import { preparePackagedPayload } from './packaged-payload.mjs';

assertLoopbackSeal();

const payload = await preparePackagedPayload();
const binary = payload.binary;
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
    }, 120_000); // a hang guard, not a speed bound: hosted runners start a cold release build slowly
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
  await payload.cleanup();
}
