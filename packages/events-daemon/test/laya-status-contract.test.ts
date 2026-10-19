import assert from 'node:assert/strict';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { EventControlClient } from '../src/control/client.ts';
import {
  assertB3ControlV2LayaResult,
  assertLayaModelStatusV1,
  B3_CONTROL_V2_LAYA_OPERATIONS,
} from '../src/operations/b3-control-v2.ts';
import b3ControlV1Schema from '../src/operations/contracts/b3-control-v1.schema.json' with { type: 'json' };
import b3ControlV2Schema from '../src/operations/contracts/b3-control-v2.schema.json' with { type: 'json' };
import doctorV1Schema from '../src/operations/contracts/doctor-v1.schema.json' with { type: 'json' };
import doctorV3Schema from '../src/operations/contracts/doctor-v3.schema.json' with { type: 'json' };
import layaStatusSchema from '../src/operations/contracts/laya-model-status-v1.schema.json' with { type: 'json' };
import { startEventOwner } from '../src/runtime/owner.ts';
import frozenResults from './fixtures/b3-control-contract-v2/laya-results.json' with { type: 'json' };
import { emptyConfigDir } from './support/config-dir.ts';
import { LAYA, type LayaRig, layaRig, macPlatform, modelPath, treeListing } from './support/laya-artifacts.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

function ajv(): Ajv2020Class {
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const instance = new Ajv2020({ allErrors: true, strict: false });
  for (const schema of [b3ControlV1Schema, doctorV1Schema, doctorV3Schema, layaStatusSchema, b3ControlV2Schema])
    instance.addSchema(schema);
  return instance;
}

/** Collects one live status answer per presentation state, each made by the production manager and E. */
async function liveStates(): Promise<{ readonly states: Map<string, unknown>; readonly rigs: LayaRig[] }> {
  const states = new Map<string, unknown>();
  const rigs: LayaRig[] = [];
  let recording: LayaRig | undefined;
  const watched = await layaRig({
    failpoint: (edge) => {
      if (recording === undefined) return;
      const status = recording.manager.status();
      if (edge === 'runtime-promotion' || edge === 'model-promotion' || edge === 'model-ready')
        states.set(status.state, status);
    },
  });
  recording = watched;
  rigs.push(watched);
  states.set('idle', watched.manager.status());
  await watched.enable();
  await watched.manager.ensureInstalled();
  states.set('ready', watched.manager.status());
  await appendFile(join(watched.artifactRoot, 'models', watched.laya.manifestId, 'laya.onnx'), ' ');
  watched.origin.serve(modelPath(watched.laya, 'laya.onnx'), Buffer.from('not the reviewed bytes'));
  await watched.manager.verifyForWorkerStart();
  states.set('failed:integrity', watched.manager.status());

  const root = await shortTempDir('events-e2-t6-contract-');
  const enabled = await layaRig({ root });
  await enabled.enable();
  await enabled.manager.ensureInstalled();
  await enabled.close();
  const boundary = await layaRig({ root, platform: macPlatform('fails') });
  rigs.push(boundary);
  states.set('failed:boundary', boundary.manager.status());
  const linux = await layaRig({ platform: { platform: 'linux', architecture: 'x64' } });
  rigs.push(linux);
  states.set('unavailable:platform', linux.manager.status());
  const sandbox = await layaRig({ platform: macPlatform('fails') });
  rigs.push(sandbox);
  states.set('unavailable:sandbox', sandbox.manager.status());
  return { states, rigs };
}

test('E2 laya status contract: every presentation state is a valid laya-model-status-v1 answer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const { states, rigs } = await liveStates();
  try {
    const validate = ajv().getSchema(layaStatusSchema.$id);
    assert.ok(validate !== undefined);
    assert.deepEqual(
      [...states.keys()].sort(),
      [
        'downloading',
        'failed:boundary',
        'failed:integrity',
        'idle',
        'installing',
        'ready',
        'unavailable:platform',
        'unavailable:sandbox',
        'verifying',
      ],
      'every presentation state was reached through production',
    );
    for (const [name, status] of states) {
      assert.equal(validate(status), true, `${name}: ${JSON.stringify(validate.errors)}`);
      assertLayaModelStatusV1(status);
    }
    const ready = states.get('ready') as Record<string, unknown>;
    for (const [name, variant] of [
      ['a path field', { ...ready, modelPath: '/tmp/model' }],
      ['an unknown state', { ...ready, state: 'paused' }],
      ['a failure without its code', { ...ready, state: 'failed' }],
      ['an unavailable answer without its reason', { ...ready, state: 'unavailable' }],
      [
        'an unavailable answer with a failure code',
        { ...ready, state: 'unavailable', reason: 'LAYA_PLATFORM_UNAVAILABLE', failureCode: 'integrity' },
      ],
      ['a working state with a reason', { ...ready, reason: 'LAYA_SANDBOX_UNAVAILABLE' }],
      [
        'an integrity failure with a platform reason',
        { ...ready, state: 'failed', failureCode: 'integrity', reason: 'LAYA_PLATFORM_UNAVAILABLE' },
      ],
      ['an unknown reason', { ...ready, state: 'unavailable', reason: 'E2_REQUIRED' }],
    ] as const) {
      assert.equal(validate(variant), false, `the schema refuses ${name}`);
      assert.throws(() => assertLayaModelStatusV1(variant), TypeError, `the runtime check refuses ${name}`);
    }
  } finally {
    for (const rig of rigs) {
      await rig.close();
      await rm(rig.root, { recursive: true, force: true });
    }
  }
});

test('E2 laya status contract: the B3 control v2 Laya vectors are the live operator-control answers', {
  skip: WINDOWS_SKIP,
}, async () => {
  const rig = await layaRig();
  try {
    const validate = ajv().getSchema(`${b3ControlV2Schema.$id}#/$defs/layaResultVector`);
    assert.ok(validate !== undefined);
    const live = new Map<string, unknown>();
    const call = async (name: string, operation: string, args: Record<string, unknown> = {}) => {
      const result = await rig.operator.handle({ operation: operation as never, args });
      live.set(name, { name, request: { operation, args }, result });
      return result;
    };
    await call('kinds-disabled', 'judgeKindsList');
    await call('status-idle', 'judgeModelStatus');
    const prepared = (await call('enable-prepared', 'enableJudgeKind', { kind: LAYA })) as { approvalId: string };
    await rig.approve(prepared);
    await rig.manager.ensureInstalled();
    await call('kinds-enabled', 'judgeKindsList');
    await call('status-ready', 'judgeModelStatus');
    await call('disable', 'disableJudgeKind', { kind: LAYA });
    await call('remove', 'removeJudgeModel');
    const frozen = frozenResults as readonly { readonly name: string }[];
    for (const vector of frozen) {
      assert.equal(validate(vector), true, `${vector.name}: ${JSON.stringify(validate.errors)}`);
      const operation = (vector as unknown as { request: { operation: string } }).request.operation;
      assert.ok((B3_CONTROL_V2_LAYA_OPERATIONS as readonly string[]).includes(operation));
      assertB3ControlV2LayaResult(operation as never, (vector as unknown as { result: unknown }).result);
      assert.deepEqual(live.get(vector.name), vector, `${vector.name}: the frozen vector is the live answer`);
    }
    // The prepared enable carries fresh approval identities, so its live answer is checked by shape, not bytes.
    const enable = live.get('enable-prepared');
    assert.equal(validate(enable), true, JSON.stringify(validate.errors));
    assertB3ControlV2LayaResult('enableJudgeKind', (enable as { result: unknown }).result);
    assert.deepEqual(frozen.map((vector) => vector.name).sort(), [
      'disable',
      'kinds-disabled',
      'kinds-enabled',
      'remove',
      'status-idle',
      'status-ready',
    ]);
  } finally {
    await rig.close();
  }
});

test('E2 laya status contract: the shipped placeholder lock says Laya is not offered yet and refuses enablement first', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e2-t6-dormant-');
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'data');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    // The production composition with the daemon's own shipped assets: no Laya seam at all.
    owner = await startEventOwner({ stateDir, configDir: await emptyConfigDir(root), dataDir, tickMs: 60_000 });
    const control = new EventControlClient({ stateDir, clientName: 'events-e2-t6-dormant' });
    const status = (await control.request('judgeModelStatus')) as Record<string, unknown>;
    assertLayaModelStatusV1(status);
    assert.equal(status.state, 'unavailable');
    assert.equal(status.reason, 'E2_EXTERNAL_REFERENCE_BLOCKED');
    assert.equal(status.runtimeLockDigest, null, 'no reviewed runtime lock ships yet');
    const kinds = (await control.request('judgeKindsList')) as readonly Record<string, unknown>[];
    assert.deepEqual(
      kinds.find((entry) => entry.kind === LAYA),
      {
        kind: LAYA,
        state: 'unavailable',
        code: 'E2_EXTERNAL_REFERENCE_BLOCKED',
      },
    );
    assert.deepEqual(await control.request('enableJudgeKind', { kind: LAYA }), {
      kind: 'unavailable',
      code: 'E2_EXTERNAL_REFERENCE_BLOCKED',
      phase: 'E2',
    });
    const doctor = (await control.request('doctor')) as { schemaVersion: string; judge: { laya: unknown } };
    assert.equal(doctor.schemaVersion, 'doctor-v3');
    assert.deepEqual((doctor.judge.laya as { boundary: unknown }).boundary, {
      status: 'unavailable',
      reason: 'E2_EXTERNAL_REFERENCE_BLOCKED',
    });
    assertLayaModelStatusV1(await control.request('removeJudgeModel'));
    await owner.stop();
    owner = undefined;
    const { openEventDatabase } = await import('../src/store/database.ts');
    const store = await openEventDatabase({ stateDir });
    try {
      assert.deepEqual(
        {
          ...store.database
            .prepare(
              `SELECT (SELECT count(*) FROM judge_kind_versions WHERE kind = ?) AS versions,
                    (SELECT count(*) FROM activation_intents) AS intents,
                    (SELECT count(*) FROM laya_models) AS models`,
            )
            .get(LAYA),
        },
        { versions: 0, intents: 0, models: 0 },
        'the refusal came before any version, intent or model row',
      );
    } finally {
      store.close();
    }
    assert.equal(await treeListing(join(dataDir, 'events', LAYA)), null, 'no Laya directory was created');
  } finally {
    await owner?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
