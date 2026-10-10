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

const OWNER_STAGE_EXPIRIES = [
  'GmailStageExpiry',
  'SlackHistoryStageExpiry',
  'SlackReplyStageExpiry',
  'ResendReceivedStageExpiry',
  'ResendStatusStageExpiry',
] as const;

function ownerStageExpiryConstruction(owner: string, component: (typeof OWNER_STAGE_EXPIRIES)[number]): string {
  const groupStart = owner.indexOf('const sourceStageExpiry = new SourceStageExpiryGroup([');
  const groupEnd = owner.indexOf('  const expiry =', groupStart);
  assert.ok(groupStart >= 0 && groupEnd > groupStart, 'the owner constructs source-stage expiry before EventExpiry');
  const group = owner.slice(groupStart, groupEnd);
  const start = group.indexOf(`new ${component}({`);
  assert.ok(start >= 0, `the owner constructs ${component}`);
  const rest = group.slice(start);
  const next = rest.indexOf('\n    new ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

function assertOwnerStageExpiryClocks(owner: string): void {
  for (const component of OWNER_STAGE_EXPIRIES)
    assert.match(
      ownerStageExpiryConstruction(owner, component),
      /\n\s+now,(?=\n\s+\}\),)/u,
      `${component} compares deadline state and must receive the owner's injected clock`,
    );
}

function omitOwnerStageExpiryClock(owner: string, component: (typeof OWNER_STAGE_EXPIRIES)[number]): string {
  const construction = ownerStageExpiryConstruction(owner, component);
  const clockLine = /\n\s+now,(?=\n\s+\}\),)/u;
  assert.match(construction, clockLine, `${component} has a clock to remove for the local mutation`);
  return owner.replace(construction, construction.replace(clockLine, ''));
}

test('B2-T8: the post-D owner installs the SSE adapter through D’s concrete visibility composition', async () => {
  const owner = await readFile(new URL('../src/runtime/owner.ts', import.meta.url), 'utf8');
  assert.match(owner, /const dryrun = new DryRunDispatcher/);
  assert.match(owner, /const webhook = new WebhookDispatcher/);
  assert.match(owner, /const sse = new SseDispatcher/);
  assert.match(owner, /createPhaseDWhatsAppOwnerComposition/);
  assert.match(owner, /createB2RetainedContentParticipants/);
  assert.match(owner, /visibilityGate: whatsappComposition\.visibilityFence/);
  assert.match(owner, /hasConcreteWhatsAppVisibilityFence: true/);
  assert.match(owner, /retentionHooks: whatsappComposition\.retainedContentHooks/);
  assert.doesNotMatch(owner, /PassThroughSseFrameVisibilityGate/);
  assert.match(owner, /const dispatcher = new DeliveryDispatcher/);
  assert.match(owner, /dryrun,\n {4}webhook,/);
  assert.match(owner, /sse,/);
});

test('D-C: every deadline-aware stage expiry constructed by the owner receives its injected clock', async () => {
  const owner = await readFile(new URL('../src/runtime/owner.ts', import.meta.url), 'utf8');
  assertOwnerStageExpiryClocks(owner);

  for (const component of OWNER_STAGE_EXPIRIES)
    assert.throws(
      () => assertOwnerStageExpiryClocks(omitOwnerStageExpiryClock(owner, component)),
      new RegExp(`${component} compares deadline state`, 'u'),
      `local clock-omission mutation is caught for ${component}`,
    );
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
