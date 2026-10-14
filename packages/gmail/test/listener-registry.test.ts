import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  LISTENER_REGISTRY_ENV,
  LISTENER_TEST_FILE_ENV,
  LISTENER_TEST_NAME_ENV,
  liveRegisteredListeners,
  stopRegisteredListeners,
} from './support/detached-listeners.ts';

test('the Gmail listener preload registers a spawned oauth-listen process while it is alive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gmail-listener-registry-'));
  const registry = join(directory, 'listeners.jsonl');
  const previousRegistry = process.env[LISTENER_REGISTRY_ENV];
  const previousTestFile = process.env[LISTENER_TEST_FILE_ENV];
  const previousTestName = process.env[LISTENER_TEST_NAME_ENV];
  process.env[LISTENER_REGISTRY_ENV] = registry;
  process.env[LISTENER_TEST_FILE_ENV] = 'test/listener-registry.test.ts';
  process.env[LISTENER_TEST_NAME_ENV] = 'records listener provenance';
  const preload = new URL('./support/detached-listener-preload.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      preload,
      '--eval',
      'setInterval(() => undefined, 1000)',
      'oauth-listen',
      'flow_registry_test',
    ],
    {
      env: {
        ...process.env,
        [LISTENER_REGISTRY_ENV]: registry,
        [LISTENER_TEST_FILE_ENV]: 'test/listener-registry.test.ts',
        [LISTENER_TEST_NAME_ENV]: 'records listener provenance',
      },
      stdio: 'ignore',
    },
  );
  try {
    let live = await liveRegisteredListeners();
    for (let waited = 0; live.length === 0 && waited < 5_000; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      live = await liveRegisteredListeners();
    }
    assert.deepEqual(
      live,
      [
        {
          pid: child.pid,
          flowId: 'flow_registry_test',
          testFile: 'test/listener-registry.test.ts',
          testName: 'records listener provenance',
        },
      ],
      'the preload must record the live listener PID and flow id',
    );
  } finally {
    await stopRegisteredListeners(
      child.pid === undefined
        ? []
        : [
            {
              pid: child.pid,
              flowId: 'flow_registry_test',
              testFile: 'test/listener-registry.test.ts',
              testName: 'records listener provenance',
            },
          ],
    );
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    await rm(directory, { recursive: true, force: true });
    if (previousRegistry === undefined) delete process.env[LISTENER_REGISTRY_ENV];
    else process.env[LISTENER_REGISTRY_ENV] = previousRegistry;
    if (previousTestFile === undefined) delete process.env[LISTENER_TEST_FILE_ENV];
    else process.env[LISTENER_TEST_FILE_ENV] = previousTestFile;
    if (previousTestName === undefined) delete process.env[LISTENER_TEST_NAME_ENV];
    else process.env[LISTENER_TEST_NAME_ENV] = previousTestName;
  }
});
