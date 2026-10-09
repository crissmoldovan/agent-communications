import assert from 'node:assert/strict';
import { lstat, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

type OwnerModule = typeof import('../src/runtime/owner.ts');
type ClientModule = typeof import('../src/control/client.ts');
type PathsModule = typeof import('../src/runtime/paths.ts');

async function ownerModule(): Promise<OwnerModule | null> {
  return import('../src/runtime/owner.ts').catch(() => null);
}

async function clientModule(): Promise<ClientModule | null> {
  return import('../src/control/client.ts').catch(() => null);
}

async function pathsModule(): Promise<PathsModule | null> {
  return import('../src/runtime/paths.ts').catch(() => null);
}

test('B2-T8: the owner installs the SSE adapter through the pre-D structural default seam', async () => {
  const owner = await readFile(new URL('../src/runtime/owner.ts', import.meta.url), 'utf8');
  assert.match(owner, /const dryrun = new DryRunDispatcher/);
  assert.match(owner, /const webhook = new WebhookDispatcher/);
  assert.match(owner, /const sse = new SseDispatcher/);
  assert.match(owner, /PassThroughSseFrameVisibilityGate/);
  assert.match(owner, /NoopDSourceRetentionHooks/);
  assert.match(owner, /const dispatcher = new DeliveryDispatcher/);
  assert.match(owner, /dryrun,\n {4}webhook,/);
  assert.match(owner, /sse,/);
});

test('CTRL-B1: only one foreground owner opens the event database and a graceful stop closes it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const ownerRuntime = await ownerModule();
  const clientRuntime = await clientModule();
  const pathsRuntime = await pathsModule();
  assert.ok(ownerRuntime, 'Task 6 supplies the foreground event owner');
  assert.ok(clientRuntime, 'Task 6 supplies the authenticated local control client');
  assert.ok(pathsRuntime, 'Task 6 supplies private control paths');
  if (!ownerRuntime || !clientRuntime || !pathsRuntime) return;

  const stateDir = await shortTempDir('aev-owner-');
  try {
    const owner = await ownerRuntime.startEventOwner({ stateDir });
    try {
      assert.equal(owner.status().owner, 'running');
      if (process.platform !== 'win32') {
        const paths = pathsRuntime.eventPaths(stateDir);
        assert.equal((await lstat(paths.controlSocket)).mode & 0o077, 0, 'the Unix socket is owner-only');
        assert.equal((await lstat(paths.controlToken)).mode & 0o077, 0, 'the control token is owner-only');
      }
      await assert.rejects(() => ownerRuntime.startEventOwner({ stateDir }), /already owns|already running/i);
      const client = new clientRuntime.EventControlClient({ stateDir, clientName: 'events-daemon-owner-test' });
      assert.deepEqual(await client.request('status'), owner.status());
      assert.deepEqual(await client.request('pause'), {
        enabled: false,
        paused: true,
        switchGeneration: 0,
      });
      assert.deepEqual(await client.request('stop'), { stopping: true });
      await owner.stopped;
    } finally {
      await owner.stop();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
