import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('a recorded listener PID that another process now holds is neither a leak nor ever stopped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-gmail-listener-reuse-'));
  const registry = join(directory, 'listeners.jsonl');
  const previousRegistry = process.env[LISTENER_REGISTRY_ENV];
  process.env[LISTENER_REGISTRY_ENV] = registry;
  // Not a listener: what holds a finished listener's PID once Windows has handed it on.
  const other = spawn(process.execPath, ['--eval', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
  try {
    assert.ok(other.pid !== undefined, 'the stand-in process started');
    const entry = {
      pid: other.pid,
      flowId: 'flow_reused_pid',
      testFile: 'test/listener-registry.test.ts',
      testName: 'a reused PID',
    };
    await writeFile(registry, `${JSON.stringify(entry)}\n`);
    assert.deepEqual(await liveRegisteredListeners(), [], 'a PID running something else is not a live listener');
    await stopRegisteredListeners([entry]);
    assert.equal(other.exitCode, null, 'the process that holds the PID now is not stopped in the listener’s name');
    assert.equal(other.signalCode, null, 'and is sent no signal');
  } finally {
    other.kill();
    await new Promise<void>((resolve) => {
      if (other.exitCode !== null || other.signalCode !== null) resolve();
      else other.once('exit', () => resolve());
    });
    await rm(directory, { recursive: true, force: true });
    if (previousRegistry === undefined) delete process.env[LISTENER_REGISTRY_ENV];
    else process.env[LISTENER_REGISTRY_ENV] = previousRegistry;
  }
});
