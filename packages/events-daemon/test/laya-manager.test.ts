import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isCommsError } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  LAYA,
  type LayaRig,
  layaArtifactOrigin,
  layaRig,
  modelPath,
  pauseAt,
  syntheticLaya,
  treeListing,
} from './support/laya-artifacts.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

const RUNTIME_TREE = [
  'node_modules/runtime-a/bin/arm64.mjs',
  'node_modules/runtime-a/shared.mjs',
  'node_modules/runtime-b/index.mjs',
];
const MODEL_TREE = [
  'laya.onnx',
  'laya.onnx.data',
  'laya_config.json',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
];

function runtimeRoot(rig: LayaRig): string {
  const digest = rig.manager.status().runtimeLockDigest;
  assert.ok(digest !== null, 'this platform has a reviewed runtime lock');
  return join(rig.artifactRoot, 'runtime', digest);
}

function modelRoot(rig: LayaRig): string {
  return join(rig.artifactRoot, 'models', rig.laya.manifestId);
}

function pointer(rig: LayaRig): number | null {
  const row = rig.store.database
    .prepare("SELECT version FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?")
    .get(LAYA) as { version: number } | undefined;
  return row?.version ?? null;
}

function modelRequests(rig: LayaRig): readonly string[] {
  return rig.origin.requests.filter((path) => path.includes('/resolve/'));
}

function archiveRequests(rig: LayaRig): readonly string[] {
  return rig.origin.requests.filter((path) => path.endsWith('.tgz'));
}

function totalBytes(rig: LayaRig): number {
  const model = rig.laya.modelFiles.reduce((sum, file) => sum + file.size, 0);
  const runtime = rig.laya.lock.packages
    .flatMap((pkg) => pkg.files['darwin-arm64'] ?? [])
    .reduce((sum, file) => sum + file.size, 0);
  return model + runtime;
}

/** A bounded wait: an operation that should finish promptly fails its test instead of hanging the suite. */
async function within<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readyRig(options: Parameters<typeof layaRig>[0] = {}): Promise<LayaRig> {
  const rig = await layaRig(options);
  await rig.enable();
  await rig.manager.ensureInstalled();
  assert.equal(rig.manager.status().state, 'ready', 'the fixture reaches ready');
  return rig;
}

async function unverifiedTrees(rig: LayaRig): Promise<readonly string[]> {
  const found: string[] = [];
  for (const directory of ['runtime', 'models']) {
    for (const entry of (await treeListing(join(rig.artifactRoot, directory))) ?? []) {
      const top = entry.split('/')[0] ?? '';
      if (top.endsWith('.partial') || top.endsWith('.staging')) found.push(`${directory}/${top}`);
    }
  }
  return [...new Set(found)].sort();
}

test('E2 manager: no artifact is fetched or recorded before the enablement claim', { skip: WINDOWS_SKIP }, async () => {
  const rig = await layaRig();
  try {
    const prepared = await rig.prepare();
    assert.equal(typeof prepared.approvalId, 'string', 'enable prepares one pending approval');
    // A start-up resume and a direct install request both find no claimed pointer and do nothing.
    await rig.manager.resume();
    await rig.manager.ensureInstalled();
    assert.deepEqual(rig.origin.requests, [], 'nothing is requested before the claim');
    assert.equal(rig.modelRow(), null, 'no D8 model row exists before the claim');
    assert.equal(await treeListing(rig.artifactRoot), null, 'no artifact directory exists before the claim');
    assert.equal(rig.manager.status().state, 'idle', 'a prepared, unapproved enablement is still idle');
    assert.deepEqual(rig.manager.kindEntry(), { kind: LAYA, state: 'disabled', version: null });

    await rig.approve(prepared);
    await rig.manager.ensureInstalled();
    assert.equal(rig.manager.status().state, 'ready');
    assert.deepEqual(
      [...archiveRequests(rig)].sort(),
      [...rig.laya.archives.keys()].sort(),
      'the claim installs each reviewed archive once',
    );
    assert.deepEqual(
      modelRequests(rig),
      rig.laya.modelFiles.map((file) => modelPath(rig.laya, file.path)),
      'the claim downloads each reviewed model file once, in manifest order',
    );
  } finally {
    await rig.close();
  }
});

test('E2 manager: a claimed enable moves through installing, downloading and verifying to ready with byte progress', {
  skip: WINDOWS_SKIP,
}, async () => {
  const seen: { edge: string; state: string; bytesVerified: number; row: unknown }[] = [];
  let current: LayaRig | undefined;
  const rig = await layaRig({
    failpoint: (edge) => {
      if (current === undefined) return;
      const status = current.manager.status();
      seen.push({ edge, state: status.state, bytesVerified: status.bytesVerified, row: current.modelRow() });
    },
  });
  current = rig;
  try {
    await rig.enable();
    await rig.manager.ensureInstalled();
    const total = totalBytes(rig);
    const runtime = total - rig.laya.modelFiles.reduce((sum, file) => sum + file.size, 0);
    const row = (state: string, bytes: number) => ({
      manifest_id: rig.laya.manifestId,
      state,
      bytes_verified: bytes,
      verified_at: null,
      failure_code: null,
      updated_at: 1_800_000_000_000,
    });
    assert.deepEqual(seen, [
      { edge: 'install-start', state: 'installing', bytesVerified: 0, row: null },
      { edge: 'runtime-promotion', state: 'installing', bytesVerified: 0, row: row('installing', 0) },
      { edge: 'model-promotion', state: 'downloading', bytesVerified: total, row: row('downloading', runtime) },
      { edge: 'model-ready', state: 'verifying', bytesVerified: total, row: row('downloading', runtime) },
    ]);
    assert.deepEqual(rig.modelRow(), {
      ...row('ready', total),
      verified_at: 1_800_000_000_000,
    });
    assert.deepEqual(rig.manager.status(), {
      state: 'ready',
      manifestId: rig.laya.manifestId,
      runtimeLockDigest: rig.manager.status().runtimeLockDigest,
      bytesVerified: total,
      totalBytes: total,
      failureCode: null,
      reason: null,
      updatedAt: 1_800_000_000_000,
    });
    assert.deepEqual(await treeListing(runtimeRoot(rig)), RUNTIME_TREE, 'only this platform’s listed runtime files');
    assert.deepEqual(await treeListing(modelRoot(rig)), MODEL_TREE, 'exactly the five reviewed model files');
    assert.deepEqual(await unverifiedTrees(rig), [], 'no partial or staging tree remains');
  } finally {
    await rig.close();
  }
});

test('E2 manager: an enablement claim that a disable overtakes starts no stale install', {
  skip: WINDOWS_SKIP,
}, async () => {
  const pause = pauseAt('install-start');
  const rig = await layaRig({ failpoint: pause.failpoint });
  let disabled: Promise<unknown> | undefined;
  try {
    await rig.enable();
    await within(pause.reached, 5_000, 'the claimed install');
    disabled = rig.disable();
    pause.release();
    await within(disabled, 5_000, 'the disable');
    await rig.manager.ensureInstalled();
    assert.equal(pointer(rig), null, 'the disable removed the pointer');
    assert.equal(rig.modelRow(), null, 'the overtaken job records no model state');
    assert.deepEqual(rig.origin.requests, [], 'the overtaken job requests nothing');
    assert.equal(await treeListing(rig.artifactRoot), null, 'the overtaken job creates no directory');
  } finally {
    pause.release();
    await disabled?.catch(() => undefined);
    await rig.close();
  }
});

test('E2 manager: a disable racing the runtime promotion waits for the artifact lock and leaves no promoted runtime', {
  skip: WINDOWS_SKIP,
}, async () => {
  const pause = pauseAt('runtime-promotion');
  const rig = await layaRig({ failpoint: pause.failpoint });
  let disabled: Promise<unknown> | undefined;
  try {
    await rig.enable();
    await within(pause.reached, 5_000, 'the runtime promotion');
    const runtime = runtimeRoot(rig);
    disabled = rig.disable();
    // E's disable transaction waits for the promotion's artifact lock: no promotion can land between its recheck
    // and its rename once a disable has removed the pointer.
    assert.equal(pointer(rig), 1, 'the pointer survives while the promotion holds the lock');
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pointer(rig), 1, 'the disable is serialised behind the promotion');
    pause.release();
    await within(disabled, 5_000, 'the disable');
    await rig.manager.ensureInstalled();
    assert.equal(pointer(rig), null);
    assert.equal(await treeListing(runtime), null, 'the stale verified staging tree was not promoted');
    assert.deepEqual(await unverifiedTrees(rig), [], 'no staging tree remains');
    assert.deepEqual(modelRequests(rig), [], 'no model byte is requested after the overtaken runtime');
    assert.equal(rig.manager.status().state, 'idle');
  } finally {
    pause.release();
    await disabled?.catch(() => undefined);
    await rig.close();
  }
});

test('E2 manager: a disable during the final model promotion fence is prompt and the model is not promoted', {
  skip: WINDOWS_SKIP,
}, async () => {
  const pause = pauseAt('model-promotion');
  const rig = await layaRig({ failpoint: pause.failpoint });
  let disabled: Promise<unknown> | undefined;
  try {
    await rig.enable();
    await within(pause.reached, 5_000, 'the model promotion fence');
    // The disable aborts the job first, so the downloader's fence wait refuses at once and frees the lock: the
    // disable neither waits for the paused fence nor lets the rename happen.
    disabled = rig.disable();
    await within(disabled, 2_000, 'a disable during the promotion fence');
    assert.equal(pointer(rig), null);
    assert.equal(await treeListing(modelRoot(rig)), null, 'the model was not promoted');
    assert.deepEqual(await unverifiedTrees(rig), [], 'its partial tree is deleted');
    assert.deepEqual(await treeListing(runtimeRoot(rig)), RUNTIME_TREE, 'the verified runtime survives the disable');
    pause.release();
    await rig.manager.ensureInstalled();
    assert.equal(await treeListing(modelRoot(rig)), null, 'releasing the stale fence promotes nothing');
    assert.equal(rig.manager.status().state, 'idle');
  } finally {
    pause.release();
    await disabled?.catch(() => undefined);
    await rig.close();
  }
});

test('E2 manager: disable cancels an in-flight download and keeps the verified runtime', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = await syntheticLaya();
  const origin = layaArtifactOrigin(laya);
  const gate = origin.gate(modelPath(laya, 'laya_config.json'));
  const rig = await layaRig({ laya, origin });
  try {
    await rig.enable();
    await within(gate.reached, 5_000, 'the third model file');
    assert.equal(rig.manager.status().state, 'downloading');
    await within(rig.disable(), 5_000, 'the disable');
    gate.release();
    await rig.manager.ensureInstalled();
    assert.equal(pointer(rig), null);
    assert.deepEqual(await unverifiedTrees(rig), [], 'the cancelled download leaves no partial tree');
    assert.equal(await treeListing(modelRoot(rig)), null, 'the cancelled model is not promoted');
    assert.deepEqual(await treeListing(runtimeRoot(rig)), RUNTIME_TREE, 'the verified runtime survives the disable');
    assert.equal(rig.manager.status().state, 'idle');
  } finally {
    gate.release();
    await rig.close();
  }
});

test('E2 manager: disable deletes an interrupted partial and staging tree but keeps verified trees', {
  skip: WINDOWS_SKIP,
}, async () => {
  const rig = await readyRig();
  try {
    // What a crash mid-install leaves behind: an unverified model partial and runtime staging tree.
    const partial = `${modelRoot(rig)}.partial`;
    const staging = `${runtimeRoot(rig)}.staging`;
    await mkdir(join(partial, 'tokenizer'), { recursive: true });
    await writeFile(join(partial, 'laya.onnx'), 'partial');
    await mkdir(join(staging, 'node_modules'), { recursive: true });
    await writeFile(join(staging, 'node_modules', 'leftover'), 'staging');
    await within(rig.disable(), 5_000, 'the disable');
    assert.deepEqual(await unverifiedTrees(rig), [], 'the disable deletes every unverified tree');
    assert.deepEqual(await treeListing(runtimeRoot(rig)), RUNTIME_TREE, 'the verified runtime is kept');
    assert.deepEqual(await treeListing(modelRoot(rig)), MODEL_TREE, 'the verified model is kept');
  } finally {
    await rig.close();
  }
});

test('E2 manager: re-enabling the same reviewed entry reuses its verified trees and downloads nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  const rig = await readyRig();
  try {
    const requested = rig.origin.requests.length;
    await within(rig.disable(), 5_000, 'the disable');
    assert.deepEqual(rig.manager.status(), {
      state: 'idle',
      manifestId: rig.laya.manifestId,
      runtimeLockDigest: rig.manager.status().runtimeLockDigest,
      bytesVerified: totalBytes(rig),
      totalBytes: totalBytes(rig),
      failureCode: null,
      reason: null,
      updatedAt: 1_800_000_000_000,
    });
    await rig.enable();
    await rig.manager.ensureInstalled();
    assert.equal(rig.manager.status().state, 'ready');
    assert.equal(rig.origin.requests.length, requested, 'the same entry is reused without a request');
    assert.deepEqual(await treeListing(runtimeRoot(rig)), RUNTIME_TREE);
    assert.deepEqual(await treeListing(modelRoot(rig)), MODEL_TREE);
  } finally {
    await rig.close();
  }
});

test('E2 manager: removal refuses while Laya is enabled and touches no tree', { skip: WINDOWS_SKIP }, async () => {
  const rig = await readyRig();
  try {
    await assert.rejects(
      rig.operator.handle({ operation: 'removeJudgeModel', args: {} }),
      (error: unknown) => isCommsError(error) && error.code === 'USAGE' && error.details?.reason === 'LAYA_ENABLED',
    );
    assert.deepEqual(await treeListing(runtimeRoot(rig)), RUNTIME_TREE);
    assert.deepEqual(await treeListing(modelRoot(rig)), MODEL_TREE);
    assert.equal(rig.manager.status().state, 'ready');
  } finally {
    await rig.close();
  }
});

test('E2 manager: removal while disabled deletes only this release’s trees and reports idle', {
  skip: WINDOWS_SKIP,
}, async () => {
  const rig = await readyRig();
  try {
    await within(rig.disable(), 5_000, 'the disable');
    const foreignRuntime = join(rig.artifactRoot, 'runtime', 'f'.repeat(64));
    const foreignModel = join(rig.artifactRoot, 'models', 'laya-en-onnx-other');
    await mkdir(foreignRuntime, { recursive: true });
    await writeFile(join(foreignRuntime, 'kept'), 'another lock');
    await mkdir(foreignModel, { recursive: true });
    await writeFile(join(foreignModel, 'kept'), 'another manifest');
    const runtime = runtimeRoot(rig);
    const removed = await rig.operator.handle({ operation: 'removeJudgeModel', args: {} });
    assert.deepEqual(removed, {
      state: 'idle',
      manifestId: rig.laya.manifestId,
      runtimeLockDigest: rig.manager.status().runtimeLockDigest,
      bytesVerified: 0,
      totalBytes: totalBytes(rig),
      failureCode: null,
      reason: null,
      updatedAt: 1_800_000_000_000,
    });
    assert.equal(await treeListing(runtime), null, 'this release’s runtime is deleted');
    assert.equal(await treeListing(modelRoot(rig)), null, 'this release’s model is deleted');
    assert.deepEqual(await treeListing(foreignRuntime), ['kept'], 'another lock’s tree is untouched');
    assert.deepEqual(await treeListing(foreignModel), ['kept'], 'another manifest’s tree is untouched');
    assert.equal((rig.modelRow() as { state: string }).state, 'removed');
  } finally {
    await rig.close();
  }
});

test('E2 manager: a removal that races a re-enable stops, and the enablement keeps its verified model', {
  skip: WINDOWS_SKIP,
}, async () => {
  const pause = pauseAt('remove-model');
  const rig = await readyRig({ failpoint: pause.failpoint });
  let removal: Promise<unknown> | undefined;
  try {
    await within(rig.disable(), 5_000, 'the disable');
    const prepared = await rig.prepare();
    const modelsBefore = modelRequests(rig).length;
    removal = rig.operator.handle({ operation: 'removeJudgeModel', args: {} });
    await within(pause.reached, 5_000, 'the removal');
    assert.equal(await treeListing(runtimeRoot(rig)), null, 'the removal deleted the runtime first');
    // A person approves the re-enable while the removal holds the artifact lock: the claim lands, and its install
    // queues behind the removal.
    await rig.approve(prepared);
    assert.equal(pointer(rig), 1, 'the re-enable claimed the same reviewed version again');
    pause.release();
    await within(removal, 5_000, 'the removal');
    await rig.manager.ensureInstalled();
    assert.deepEqual(await treeListing(modelRoot(rig)), MODEL_TREE, 'the removal stopped before the model');
    assert.equal(modelRequests(rig).length, modelsBefore, 'the re-enabled install downloads no model byte');
    assert.deepEqual(await treeListing(runtimeRoot(rig)), RUNTIME_TREE, 'the re-enabled install restores the runtime');
    assert.equal(rig.manager.status().state, 'ready');
    assert.equal((rig.modelRow() as { state: string }).state, 'ready');
  } finally {
    pause.release();
    await removal?.catch(() => undefined);
    await rig.close();
  }
});

test('E2 manager: an integrity failure before a worker start is repaired once, then stays failed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const rig = await readyRig();
  try {
    const tampered = join(modelRoot(rig), 'laya_config.json');
    await appendFile(tampered, ' ');
    const repairedOnce = await rig.manager.verifyForWorkerStart();
    assert.equal(repairedOnce.ok, true, 'one fresh copy from the pinned source repairs the tree');
    assert.equal(rig.manager.status().state, 'ready');
    assert.equal(
      await readFile(tampered, 'utf8'),
      rig.laya.modelFiles.find((file) => file.path === 'laya_config.json')?.bytes.toString('utf8'),
    );

    await appendFile(tampered, ' ');
    rig.origin.serve(modelPath(rig.laya, 'laya_config.json'), Buffer.from('not the reviewed bytes'));
    const failed = await rig.manager.verifyForWorkerStart();
    assert.deepEqual(failed, { ok: false, failureCode: 'integrity' }, 'a fresh copy that fails too is a failure');
    assert.equal(rig.manager.status().state, 'failed');
    assert.equal(rig.manager.status().failureCode, 'integrity');
    assert.equal((rig.modelRow() as { failure_code: string }).failure_code, 'integrity');

    const requested = rig.origin.requests.length;
    assert.deepEqual(
      await rig.manager.verifyForWorkerStart(),
      { ok: false, failureCode: 'integrity' },
      'a failed model stays failed until its person acts',
    );
    assert.equal(rig.origin.requests.length, requested, 'no second repair is attempted');
  } finally {
    await rig.close();
  }
});

test('E2 manager: an integrity repair cannot replace a selection a disable changed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const pause = pauseAt('repair-delete');
  const rig = await readyRig({ failpoint: pause.failpoint });
  let verified: Promise<unknown> | undefined;
  let disabled: Promise<unknown> | undefined;
  try {
    const tampered = join(modelRoot(rig), 'laya_config.json');
    await appendFile(tampered, ' ');
    const tamperedBytes = await readFile(tampered);
    const requested = rig.origin.requests.length;
    verified = rig.manager.verifyForWorkerStart();
    await within(pause.reached, 5_000, 'the repair');
    disabled = rig.disable();
    pause.release();
    await within(disabled, 5_000, 'the disable');
    assert.deepEqual(await within(verified, 5_000, 'the repair'), { ok: false, failureCode: 'integrity' });
    assert.deepEqual(await readFile(tampered), tamperedBytes, 'the repair deleted nothing it no longer owned');
    assert.equal(rig.origin.requests.length, requested, 'the repair fetched nothing');
    assert.equal((rig.modelRow() as { state: string }).state, 'ready', 'the stale repair recorded nothing');
    assert.equal(pointer(rig), null);
  } finally {
    pause.release();
    await disabled?.catch(() => undefined);
    await verified?.catch(() => undefined);
    await rig.close();
  }
});

test('E2 race: a disable and re-enable during a worker start’s tree walk leave the re-enabled trees alone', {
  skip: WINDOWS_SKIP,
}, async () => {
  const pause = pauseAt('worker-start-verify');
  const rig = await readyRig({ failpoint: pause.failpoint });
  let verifying: Promise<unknown> | undefined;
  try {
    const config = join(modelRoot(rig), 'laya_config.json');
    const reviewed = rig.laya.modelFiles.find((file) => file.path === 'laya_config.json')?.bytes;
    await appendFile(config, ' ');
    // A worker start walks both trees and finds the altered file; it is paused before it decides what to repair.
    verifying = rig.manager.verifyForWorkerStart();
    await within(pause.reached, 5_000, 'the worker-start walk');
    // Meanwhile the person disables Laya and enables the same reviewed entry again: the re-enable claims the same
    // version and digest, and its own install replaces the altered model from the pinned source.
    await within(rig.disable(), 5_000, 'the disable');
    await rig.enable();
    assert.equal(pointer(rig), 1, 'the re-enable claimed the same reviewed version');
    await within(rig.manager.ensureInstalled(), 10_000, 'the re-enabled install');
    assert.equal(rig.manager.status().state, 'ready', 'the re-enabled install verified both trees');
    assert.deepEqual(await readFile(config), reviewed, 'the re-enabled install restored the reviewed bytes');
    const requested = modelRequests(rig).length;

    pause.release();
    // The walk compared a selection a disable has since fenced: it vouches for nothing and repairs nothing.
    assert.deepEqual(await within(verifying, 5_000, 'the stale worker start'), { ok: false, failureCode: null });
    assert.equal(modelRequests(rig).length, requested, 'the stale walk downloaded nothing again');
    assert.deepEqual(await readFile(config), reviewed, 'the re-enabled model was not deleted');
    assert.equal((rig.modelRow() as { state: string }).state, 'ready', 'the stale walk recorded nothing');
    assert.equal(rig.manager.status().state, 'ready');
  } finally {
    pause.release();
    await verifying?.catch(() => undefined);
    await rig.close();
  }
});
