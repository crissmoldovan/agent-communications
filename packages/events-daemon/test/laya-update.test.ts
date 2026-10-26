import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { EventControlClient } from '../src/control/client.ts';
import { layaJudgeKindDefinitionFor } from '../src/domain/judges.ts';
import doctorV1Schema from '../src/operations/contracts/doctor-v1.schema.json' with { type: 'json' };
import doctorV3Schema from '../src/operations/contracts/doctor-v3.schema.json' with { type: 'json' };
import layaStatusSchema from '../src/operations/contracts/laya-model-status-v1.schema.json' with { type: 'json' };
import type { DoctorReportV3 } from '../src/operations/doctor.ts';
import { projectE2Doctor } from '../src/runtime/b3-doctor-projection.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import frozenDoctorVectors from './fixtures/laya/doctor-v3-laya-vectors.json' with { type: 'json' };
import { emptyConfigDir } from './support/config-dir.ts';
import {
  LAYA,
  type LayaRig,
  layaArtifactOrigin,
  layaRig,
  macPlatform,
  modelPath,
  pauseAt,
  type SyntheticLaya,
  syntheticLaya,
  treeListing,
} from './support/laya-artifacts.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

assertLoopbackSeal();

/**
 * E2 CI round 1: every test here that starts or awaits a child, a listener, an owner or a worker has a bound of its own.
 * `node --test` has none, and Node 24 keeps a test whose awaited promise never settles pending for ever (Node 22
 * cancels it once the event loop drains): a hang must fail in minutes, not at the job limit hours later.
 */
const CHILD_TEST_TIMEOUT_MS = 120_000;

function pointer(rig: LayaRig): number | null {
  const row = rig.store.database
    .prepare("SELECT version FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?")
    .get(LAYA) as { version: number } | undefined;
  return row?.version ?? null;
}

/** E's own kind-disable transaction, composed for the start-up tightening exactly as the owner composes it. */
function eDisable(rig: LayaRig): () => unknown {
  return () => new JudgeKinds({ store: rig.store, now: () => 1, activations: rig.activations }).disable(LAYA);
}

/** An installation whose Laya was enabled and verified under `before`; the rig is closed, the root kept. */
async function enabledUnder(before: SyntheticLaya): Promise<{ readonly root: string; readonly digest: string }> {
  const root = await shortTempDir('events-e2-t6-update-');
  const rig = await layaRig({ root, laya: before });
  try {
    await rig.enable();
    await rig.manager.ensureInstalled();
    assert.equal(rig.manager.status().state, 'ready', 'the earlier release reached ready');
    return { root, digest: rig.manager.status().runtimeLockDigest as string };
  } finally {
    await rig.close();
  }
}

function sri(text: string): string {
  return `sha512-${createHash('sha512').update(text).digest('base64')}`;
}

function platformDigest(laya: SyntheticLaya): string {
  return layaJudgeKindDefinitionFor({ layaAssetSource: laya.assets, layaPlatformProbe: macPlatform() }).preview({
    version: 1,
  }).runtimeLock.platform.digest;
}

/** Starts the release `after` over an installation enabled under `before` and applies its start-up update rule. */
async function startUpUnder(
  before: SyntheticLaya,
  after: SyntheticLaya,
): Promise<{
  readonly reason: unknown;
  readonly rig: LayaRig;
  readonly earlierDigest: string;
  readonly audit: Record<string, unknown>[];
}> {
  const { root, digest } = await enabledUnder(before);
  const audit: Record<string, unknown>[] = [];
  const rig = await layaRig({
    root,
    laya: after,
    audit: {
      append: async (record) => {
        audit.push(record);
        return record;
      },
    },
  });
  const reason = await rig.manager.reconcileRelease(eDisable(rig));
  return { reason, rig, earlierDigest: digest, audit };
}

async function closeAndRemove(rig: LayaRig): Promise<void> {
  await rig.close();
  await rm(rig.root, { recursive: true, force: true });
}

async function assertTightenedKeepingTrees(
  outcome: Awaited<ReturnType<typeof startUpUnder>>,
  reason: 'model-changed' | 'runtime-changed',
): Promise<void> {
  const { rig } = outcome;
  assert.equal(outcome.reason, reason);
  assert.equal(pointer(rig), null, 'E’s kind-disable tightening removed the pointer');
  assert.deepEqual(outcome.audit, [
    {
      inboxId: '',
      operation: 'events.disableJudgeKind',
      outcome: 'ok',
      reason,
      ids: { kind: LAYA, version: '1' },
      surface: 'daemon',
      origin: 'daemon',
    },
  ]);
  assert.notEqual(
    await treeListing(join(rig.artifactRoot, 'runtime', outcome.earlierDigest)),
    null,
    'the verified runtime of the earlier entry is kept',
  );
  assert.notEqual(
    await treeListing(join(rig.artifactRoot, 'models', 'laya-en-onnx-tiny-v1')),
    null,
    'the verified model of the earlier entry is kept',
  );
  assert.equal(rig.manager.status().state, 'idle', 'nothing is re-approved: the new entry waits for its person');
  assert.equal(rig.origin.requests.length, 0, 'the tightening fetches nothing');
}

test('E2 laya update: a URL-only lock change keeps the platform digest yet disables at start-up as runtime-changed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const before = await syntheticLaya();
  const after = await syntheticLaya({
    lock: (lock) => {
      const pkg = lock.packages[0];
      if (pkg !== undefined) pkg.url = pkg.url.replace(/\.tgz$/u, '-mirror.tgz');
    },
  });
  assert.equal(platformDigest(after), platformDigest(before), 'the selected platform file-list digest is unchanged');
  const outcome = await startUpUnder(before, after);
  try {
    await assertTightenedKeepingTrees(outcome, 'runtime-changed');
  } finally {
    await closeAndRemove(outcome.rig);
  }
});

test('E2 laya update: an SRI-only lock change keeps the platform digest yet disables at start-up as runtime-changed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const before = await syntheticLaya();
  const after = await syntheticLaya({
    lock: (lock) => {
      const pkg = lock.packages[1];
      if (pkg !== undefined) pkg.integrity = sri('another reviewed archive');
    },
  });
  assert.equal(platformDigest(after), platformDigest(before), 'the selected platform file-list digest is unchanged');
  const outcome = await startUpUnder(before, after);
  try {
    await assertTightenedKeepingTrees(outcome, 'runtime-changed');
  } finally {
    await closeAndRemove(outcome.rig);
  }
});

test('E2 laya update: a downgraded package version disables at start-up as runtime-changed', {
  skip: WINDOWS_SKIP,
}, async () => {
  // The earlier release named runtime-a 1.0.1 (its exact registry URL encodes that version); this one names 1.0.0,
  // with every file and digest of the selected platform alike.
  const before = await syntheticLaya({
    lock: (lock) => {
      const pkg = lock.packages[0];
      if (pkg === undefined) return;
      pkg.version = '1.0.1';
      pkg.url = pkg.url.replace(/-1\.0\.0\.tgz$/u, '-1.0.1.tgz');
    },
  });
  const after = await syntheticLaya();
  assert.equal(platformDigest(after), platformDigest(before), 'the selected platform file-list digest is unchanged');
  const outcome = await startUpUnder(before, after);
  try {
    await assertTightenedKeepingTrees(outcome, 'runtime-changed');
  } finally {
    await closeAndRemove(outcome.rig);
  }
});

test('E2 laya update: a changed model manifest disables at start-up as model-changed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const before = await syntheticLaya();
  const after = await syntheticLaya({ revision: 'd'.repeat(40) });
  const outcome = await startUpUnder(before, after);
  try {
    await assertTightenedKeepingTrees(outcome, 'model-changed');
  } finally {
    await closeAndRemove(outcome.rig);
  }
});

test('E2 laya update: once the re-approved entry is ready, every tree the earlier entry left is deleted', {
  skip: WINDOWS_SKIP,
}, async () => {
  // D11 and E2-5 (E2 review round 1, A6/B4): a tree no enabled entry names is deleted once its replacement verified.
  // The earlier entry named runtime-a 1.0.1 and the first manifest; the re-approved one names 1.0.0 and a second.
  const before = await syntheticLaya({
    lock: (lock) => {
      const pkg = lock.packages[0];
      if (pkg === undefined) return;
      pkg.version = '1.0.1';
      pkg.url = pkg.url.replace(/-1\.0\.0\.tgz$/u, '-1.0.1.tgz');
    },
  });
  const after = await syntheticLaya({ manifestId: 'laya-en-onnx-tiny-v2', revision: 'd'.repeat(40) });
  const outcome = await startUpUnder(before, after);
  const { rig } = outcome;
  try {
    await assertTightenedKeepingTrees(outcome, 'model-changed');
    const earlierPartial = join(rig.artifactRoot, 'models', 'laya-en-onnx-tiny-v1.partial');
    await mkdir(earlierPartial, { recursive: true });
    await writeFile(join(earlierPartial, 'laya.onnx'), 'an interrupted earlier download');
    await rig.enable();
    await rig.manager.ensureInstalled();
    assert.equal(rig.manager.status().state, 'ready', 'the re-approved entry installed and verified');
    const digest = rig.manager.status().runtimeLockDigest as string;
    assert.notEqual(digest, outcome.earlierDigest, 'the two entries name different runtime trees');
    assert.deepEqual(await readdir(join(rig.artifactRoot, 'runtime')), [digest], 'only the enabled runtime is left');
    assert.deepEqual(
      await readdir(join(rig.artifactRoot, 'models')),
      ['laya-en-onnx-tiny-v2'],
      'only the enabled model is left: the earlier one and its partial are deleted',
    );
  } finally {
    await closeAndRemove(rig);
  }
});

test('E2 laya update: a release that changes only daemon code keeps Laya enabled and ready', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = await syntheticLaya();
  const outcome = await startUpUnder(laya, laya);
  try {
    assert.equal(outcome.reason, null);
    assert.equal(pointer(outcome.rig), 1, 'the approved pointer stays');
    assert.deepEqual(outcome.audit, [], 'nothing is tightened');
    assert.equal(outcome.rig.manager.status().state, 'ready');
  } finally {
    await closeAndRemove(outcome.rig);
  }
});

test('E2 laya update: the start-up comparison does not disable a version re-enabled meanwhile', {
  skip: WINDOWS_SKIP,
}, async () => {
  const before = await syntheticLaya();
  const after = await syntheticLaya({ revision: 'd'.repeat(40) });
  const { root } = await enabledUnder(before);
  const pause = pauseAt('update-disable');
  const audit: Record<string, unknown>[] = [];
  const rig = await layaRig({
    root,
    laya: after,
    failpoint: pause.failpoint,
    audit: {
      append: async (record) => {
        audit.push(record);
        return record;
      },
    },
  });
  let reconciled: Promise<unknown> | undefined;
  try {
    // The person has prepared this release's entry; it is approved while the start-up comparison is in flight.
    const prepared = await rig.prepare();
    reconciled = rig.manager.reconcileRelease(eDisable(rig));
    await pause.reached;
    await rig.approve(prepared);
    assert.equal(pointer(rig), 2, 'the new reviewed version replaced the compared one');
    pause.release();
    assert.equal(await reconciled, null, 'the tightening named a pointer that is no longer active');
    assert.equal(pointer(rig), 2, 'the re-enabled version stays enabled');
    assert.deepEqual(audit, []);
    await rig.manager.ensureInstalled();
    assert.equal(rig.manager.status().state, 'ready', 'the re-enabled entry installs');
  } finally {
    pause.release();
    await reconciled?.catch(() => undefined);
    await closeAndRemove(rig);
  }
});

test('E2 laya update: the owner’s start-up applies E’s disable with its audit reason and keeps verified trees', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const root = await shortTempDir('events-e2-t6-owner-');
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'data');
  const configDir = await emptyConfigDir(root);
  const before = await syntheticLaya();
  const after = await syntheticLaya({
    lock: (lock) => {
      const pkg = lock.packages[0];
      if (pkg !== undefined) pkg.url = pkg.url.replace(/\.tgz$/u, '-mirror.tgz');
    },
  });
  const start = (laya: SyntheticLaya) =>
    startEventOwner({
      ...noRealHome(stateDir),
      stateDir,
      configDir,
      dataDir,
      tickMs: 60_000,
      pollIntervalMs: 60_000,
      laya: {
        assets: laya.assets,
        platform: macPlatform(),
        network: layaArtifactOrigin(laya).network,
        freeBytes: async () => Number.MAX_SAFE_INTEGER,
      },
    });
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    owner = await start(before);
    const control = new EventControlClient({ stateDir, clientName: 'events-e2-t6-owner' });
    const prepared = (await control.request('enableJudgeKind', { kind: LAYA })) as { readonly approvalId: string };
    const answer = await control.request('approve-challenge', { approvalId: prepared.approvalId });
    await control.request('approve', { approvalId: prepared.approvalId, answer });
    let status = (await control.request('judgeModelStatus')) as { readonly state: string };
    for (let attempt = 0; status.state !== 'ready' && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (await control.request('judgeModelStatus')) as { readonly state: string };
    }
    assert.equal(status.state, 'ready', 'the owner installed the approved entry');
    await owner.stop();
    owner = undefined;

    owner = await start(after);
    const restarted = new EventControlClient({ stateDir, clientName: 'events-e2-t6-owner-restart' });
    const kinds = (await restarted.request('judgeKindsList')) as readonly { readonly kind: string }[];
    assert.deepEqual(
      kinds.find((entry) => entry.kind === LAYA),
      { kind: LAYA, state: 'disabled', version: null },
      'the changed release starts with Laya disabled',
    );
    assert.equal(((await restarted.request('judgeModelStatus')) as { readonly state: string }).state, 'idle');
    const auditDirectory = join(stateDir, 'audit');
    const lines = (
      await Promise.all((await readdir(auditDirectory)).map((name) => readFile(join(auditDirectory, name), 'utf8')))
    )
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const tightening = lines.filter((line) => line.operation === 'events.disableJudgeKind');
    assert.equal(tightening.length, 1, 'one start-up tightening is audited');
    assert.equal(tightening[0]?.reason, 'runtime-changed');
    assert.deepEqual(tightening[0]?.ids, { kind: LAYA, version: '1' });
    const artifacts = join(dataDir, 'events', LAYA);
    assert.notEqual(await treeListing(join(artifacts, 'models', 'laya-en-onnx-tiny-v1')), null, 'verified model kept');
    assert.equal(((await readdir(join(artifacts, 'runtime'))) as string[]).length, 1, 'verified runtime kept');
  } finally {
    await owner?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

async function doctorFor(rig: LayaRig): Promise<DoctorReportV3> {
  return projectE2Doctor({
    database: rig.store.database,
    installationId: rig.store.installationId,
    lifecycle: { enabled: false, paused: false, switchGeneration: 0 },
    protocolVersions: [1],
    ports: { assertObjectSecretReady: async () => undefined } as never,
    config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
    approvals: { get: async () => null } as never,
    decryptSourceState: async () => null,
    laya: rig.manager,
    now: () => 0,
  });
}

function doctorValidator(): (value: unknown) => boolean {
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(doctorV1Schema);
  ajv.addSchema(layaStatusSchema);
  const validate = ajv.compile(doctorV3Schema);
  return (value) => {
    const valid = validate(value);
    if (!valid) assert.fail(JSON.stringify(validate.errors));
    return valid;
  };
}

/** Builds each doctor state through the production manager and E, never by writing a report. */
async function doctorStates(): Promise<Record<string, { readonly rig: LayaRig; readonly report: DoctorReportV3 }>> {
  const states: Record<string, { readonly rig: LayaRig; readonly report: DoctorReportV3 }> = {};
  const ready = await layaRig();
  await ready.enable();
  await ready.manager.ensureInstalled();
  states.ready = { rig: ready, report: await doctorFor(ready) };

  const integrity = await layaRig();
  await integrity.enable();
  await integrity.manager.ensureInstalled();
  await appendFile(join(integrity.artifactRoot, 'models', integrity.laya.manifestId, 'laya_config.json'), ' ');
  integrity.origin.serve(modelPath(integrity.laya, 'laya_config.json'), Buffer.from('not the reviewed bytes'));
  await integrity.manager.verifyForWorkerStart();
  states.integrity = { rig: integrity, report: await doctorFor(integrity) };

  // Enabled on this machine, which then lost its usable sandbox: the next owner start reports a boundary failure.
  const { root } = await enabledUnder(await syntheticLaya());
  const boundary = await layaRig({ root, platform: macPlatform('fails') });
  states.boundary = { rig: boundary, report: await doctorFor(boundary) };

  const linux = await layaRig({ platform: { platform: 'linux', architecture: 'x64' } });
  states.linux = { rig: linux, report: await doctorFor(linux) };
  const windows = await layaRig({ platform: { platform: 'win32', architecture: 'x64' } });
  states.windows = { rig: windows, report: await doctorFor(windows) };
  return states;
}

test('E2 laya update: doctor reports ready, integrity, boundary, Linux and Windows Laya states with no path or content', {
  skip: WINDOWS_SKIP,
}, async () => {
  const states = await doctorStates();
  try {
    const validate = doctorValidator();
    const frozen = frozenDoctorVectors as Record<string, unknown>;
    assert.deepEqual(Object.keys(frozen).sort(), ['boundary', 'integrity', 'linux', 'ready', 'windows']);
    for (const [name, { rig, report }] of Object.entries(states)) {
      assert.equal(validate(report), true, `${name}: the full report is doctor-v3`);
      assert.equal(report.schemaVersion, 'doctor-v3');
      assert.deepEqual(report.judgeBoundary, [], `${name}: no judge kind is left behind a boundary`);
      assert.deepEqual(report.judge.laya, frozen[name], `${name}: the frozen Laya doctor vector`);
      assert.deepEqual(
        report.judge.kinds.find((entry) => entry.kind === LAYA),
        rig.manager.kindEntry(),
        `${name}: the kind entry is the manager's own`,
      );
      const text = JSON.stringify(report);
      assert.equal(text.includes(rig.root), false, `${name}: no filesystem path`);
      assert.doesNotMatch(text, /https?:/iu, `${name}: no request URL`);
      const laya = JSON.stringify(report.judge.laya);
      assert.equal(laya.includes('/'), false, `${name}: no path-shaped Laya value`);
      assert.doesNotMatch(laya, /token|secret|authorization|cookie|key/iu, `${name}: no credential in the Laya entry`);
    }
  } finally {
    for (const { rig } of Object.values(states)) await closeAndRemove(rig);
  }
});
