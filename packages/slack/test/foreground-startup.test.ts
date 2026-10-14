import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('abort in the real listen callback owns completion rejection before startup cleanup awaits', {
  timeout: 10000,
}, async () => {
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { Server } from 'node:net';
    import { join } from 'node:path';
    import { setImmediate as turn } from 'node:timers/promises';
    import { newHarness, TEST_CLIENT_ID } from ${JSON.stringify(new URL('./support/harness.ts', import.meta.url).href)};
    import { startSignIn } from ${JSON.stringify(new URL('../src/operations/signin.ts', import.meta.url).href)};
    const harness = await newHarness();
    const controller = new AbortController();
    let settled;
    let intercepted = false;
    let unhandled = 0;
    let handledLate = 0;
    process.on('unhandledRejection', () => unhandled++);
    process.on('rejectionHandled', () => handledLate++);
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      const callback = args.pop();
      return listen.call(this, ...args, () => {
        intercepted = true;
        controller.abort();
        callback();
      });
    };
    const rm = fs.rm;
    fs.rm = async (...args) => {
      // A full turn while startup discards its flow makes deferred rejection ownership observable.
      if (String(args[0]).startsWith(join(harness.core.paths.stateDir, 'slack', 'flows'))) await turn();
      return rm(...args);
    };
    syncBuiltinESMExports();
    const context = harness.context({ foregroundSignIn: {
      signal: controller.signal,
      register(_id, completion) { settled = completion; },
    }});
    await assert.rejects(startSignIn(context, {
      alias: 'acme', mode: 'read', clientId: TEST_CLIENT_ID, port: 51000, detached: false,
    }), { name: 'AbortError' });
    await settled;
    await turn();
    assert.equal(intercepted, true);
    assert.equal(harness.calls.length, 0);
    console.log(JSON.stringify({ unhandled, handledLate }));
  `;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /UnhandledPromiseRejection|PromiseRejectionHandledWarning/);
  assert.deepEqual(JSON.parse(stdout), { unhandled: 0, handledLate: 0 });
});
