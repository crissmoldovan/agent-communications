import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  assertB3ControlV3LayaJudgeResult,
  assertB3LayaJudgeRefusalV3,
  assertLayaJudgePreviewV3,
  B3_CONTROL_V3_LAYA_JUDGE_OPERATIONS,
  B3_CONTROL_V3_SCHEMA_VERSION,
} from '../src/operations/b3-control-v3.ts';
import b3ControlV1Schema from '../src/operations/contracts/b3-control-v1.schema.json' with { type: 'json' };
import b3ControlV2Schema from '../src/operations/contracts/b3-control-v2.schema.json' with { type: 'json' };
import b3ControlV3Schema from '../src/operations/contracts/b3-control-v3.schema.json' with { type: 'json' };
import doctorV1Schema from '../src/operations/contracts/doctor-v1.schema.json' with { type: 'json' };
import doctorV3Schema from '../src/operations/contracts/doctor-v3.schema.json' with { type: 'json' };
import layaStatusSchema from '../src/operations/contracts/laya-model-status-v1.schema.json' with { type: 'json' };
import frozenVectors from './fixtures/b3-control-contract-v3/laya-judge-results.json' with { type: 'json' };
import { laya, liveVectors, rule, SHIPPED_MANIFEST, typesafe, type Vector } from './support/b3-control-v3-vectors.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

const V3 = b3ControlV3Schema.$id;

function ajv(): Ajv2020Class {
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const instance = new Ajv2020({ allErrors: true, strict: false });
  for (const schema of [
    b3ControlV1Schema,
    doctorV1Schema,
    doctorV3Schema,
    layaStatusSchema,
    b3ControlV2Schema,
    b3ControlV3Schema,
  ])
    instance.addSchema(schema);
  return instance;
}

function validator(definition: string): (value: unknown) => boolean {
  const validate = ajv().getSchema(`${V3}#/$defs/${definition}`);
  assert.ok(validate !== undefined, definition);
  return (value) => validate(value) === true;
}

test('E2 B3 control v3: the Laya judge vectors are the live answers of the shipped release', {
  skip: WINDOWS_SKIP,
}, async () => {
  assert.equal(B3_CONTROL_V3_SCHEMA_VERSION, 'b3-control-v3');
  const live = await liveVectors();
  const resultVector = validator('layaJudgeResultVector');
  const errorVector = validator('layaJudgeErrorVector');
  const frozen = frozenVectors as readonly Vector[];
  for (const vector of frozen) {
    const operation = vector.request.operation;
    if ('result' in vector) {
      assert.ok(resultVector(vector), `${vector.name}: the v3 schema accepts the frozen result`);
      assert.ok((B3_CONTROL_V3_LAYA_JUDGE_OPERATIONS as readonly string[]).includes(operation));
      assertB3ControlV3LayaJudgeResult(operation as never, vector.result);
    } else {
      assert.ok(errorVector(vector), `${vector.name}: the v3 schema accepts the frozen refusal`);
      assertB3LayaJudgeRefusalV3(vector.error);
    }
  }
  assert.deepEqual(live, frozen, 'every frozen v3 vector is the live answer, in order');
});

test('E2 B3 control v3: the schema adds exactly the Laya judge variant and refuses what v3 does not', () => {
  const judgeDocument = validator('judgeDocument');
  const ruleDocument = validator('ruleDocument');
  const inventory = validator('judgeInventoryEntry');
  const preview = validator('layaJudgePreview');
  const refusal = validator('layaJudgeRefusal');
  assert.ok(judgeDocument(laya()), 'a Laya judge document');
  assert.ok(judgeDocument(typesafe), 'v1’s judge documents are kept');
  for (const changed of [
    laya({ promptTemplate: 'laya-choice2-v1' }),
    laya({ provider: 'typesafe' }),
    laya({ endpoint: 'http://127.0.0.1/v1/systemone' }),
    laya({ model: '' }),
    { ...laya(), version: 0 },
  ])
    assert.equal(judgeDocument(changed), false, JSON.stringify(changed));
  assert.ok(ruleDocument(rule(laya())), 'a rule naming a Laya judge');
  assert.ok(ruleDocument(rule(typesafe)), 'a rule naming a v1 judge');
  assert.equal(ruleDocument(rule(laya({ promptTemplate: 'laya-choice2-v1' }))), false);
  assert.ok(
    inventory({ judgeId: 'judge-laya', version: 1, kind: 'laya', provider: 'laya', model: 'm', revokedAt: null }),
  );
  assert.equal(
    inventory({ judgeId: 'judge-laya', version: 1, kind: 'laya', provider: 'typesafe', model: 'm', revokedAt: null }),
    false,
  );
  assert.equal(
    inventory({ judgeId: 'j', version: 1, kind: 'laya', provider: 'laya', model: 'm', revokedAt: null, prompt: 'x' }),
    false,
    'an inventory entry carries no prompt',
  );
  const limits = { englishCpu: 'a', macosBoundary: 'b', oneAtATime: 'c' };
  const limitations = { sandboxDeprecation: 'd', englishAccuracy: 'e' };
  const block = {
    judgeId: 'judge-laya',
    version: 1,
    promptTemplate: 'laya-noul-v1',
    manifestId: SHIPPED_MANIFEST,
    limits,
    limitations,
  };
  assert.ok(preview(block));
  assertLayaJudgePreviewV3(block);
  for (const changed of [
    { ...block, limits: { englishCpu: 'a', macosBoundary: 'b' } },
    { ...block, limitations: { englishAccuracy: 'e' } },
    { ...block, question: 'an input' },
    { ...block, promptTemplate: 'laya-choice2-v1' },
  ]) {
    assert.equal(preview(changed), false, JSON.stringify(changed));
    assert.throws(() => assertLayaJudgePreviewV3(changed), TypeError);
  }
  assert.ok(refusal({ code: 'BAD_DATA', reason: 'LAYA_TEMPLATE_BLOCKED' }));
  for (const changed of [
    { code: 'BAD_DATA', reason: 'E2_REQUIRED' },
    { code: 'USAGE', reason: 'LAYA_TEMPLATE_BLOCKED' },
  ]) {
    assert.equal(refusal(changed), false);
    assert.throws(() => assertB3LayaJudgeRefusalV3(changed), TypeError);
  }
  const ready = {
    kind: 'READY',
    approvalId: 'approval-laya',
    digest: 'digest-laya',
    preview: { documentVersion: 1, kind: 'rule', rule: rule(laya()) },
    pendingTargetSelectors: [],
    challenge: { approvalId: 'approval-laya', digest: 'digest-laya', challenge: 'challenge', expiresAt: 1 },
    layaJudge: block,
  };
  const approvalView = validator('resultsByOperation/approvalView');
  assert.ok(approvalView(ready), 'a ready view of a Laya rule carries its limits');
  assertB3ControlV3LayaJudgeResult('approvalView', ready);
  const { layaJudge: _omitted, ...withoutLimits } = ready;
  assert.equal(approvalView(withoutLimits), false, 'a ready view of a Laya rule never omits them');
  assert.throws(() => assertB3ControlV3LayaJudgeResult('approvalView', withoutLimits), TypeError);
  assert.ok(approvalView({ kind: 'STALE_APPROVAL' }), 'v1’s other views are kept');
});
