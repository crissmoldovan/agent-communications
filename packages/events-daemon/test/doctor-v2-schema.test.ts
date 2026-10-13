import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';

test('E9 doctor-v2 schema accepts only the one frozen Laya E2 boundary entry', async () => {
  const contracts = join(import.meta.dirname, '../src/operations/contracts');
  const doctorV1 = JSON.parse(await readFile(join(contracts, 'doctor-v1.schema.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const doctorV2 = JSON.parse(await readFile(join(contracts, 'doctor-v2.schema.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(doctorV1);
  const validate = ajv.compile(doctorV2);

  const report = {
    schemaVersion: 'doctor-v2',
    owner: { status: 'running', protocolVersions: [1], installationId: 'doctor-v2-test' },
    switch: { status: 'disabled', paused: false, generation: 0 },
    lineages: [],
    superseded: [],
    points: [],
    awaitingReapproval: [],
    activationIntents: [],
    sources: [],
    recovery: { leases: 0, held: 0, deadLetters: 0, deadlines: 0, resetBarriers: [], missingSecrets: [] },
    judgeBoundary: [{ kind: 'laya', code: 'E2_REQUIRED', phase: 'E2' }],
    judge: { kinds: [], budget: { activeVersion: null }, reservations: [] },
    whatsapp: [],
  };

  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  for (const [name, judgeBoundary] of [
    ['empty', []],
    ['extra entry', [...report.judgeBoundary, ...report.judgeBoundary]],
    ['typesafe entry', [{ kind: 'typesafe', code: 'E2_REQUIRED', phase: 'E2' }]],
    ['local endpoint entry', [{ kind: 'local-endpoint', code: 'E2_REQUIRED', phase: 'E2' }]],
    ['reordered boundary entries', [{ kind: 'typesafe', code: 'E2_REQUIRED', phase: 'E2' }, ...report.judgeBoundary]],
    ['altered laya code', [{ kind: 'laya', code: 'E_REQUIRED', phase: 'E2' }]],
  ] as const)
    assert.equal(validate({ ...report, judgeBoundary }), false, `${name}: ${JSON.stringify(validate.errors)}`);
});
