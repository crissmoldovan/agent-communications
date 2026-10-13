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
    judge: {
      kinds: [
        { kind: 'typesafe', state: 'disabled', version: null },
        { kind: 'laya', state: 'unavailable', code: 'E2_REQUIRED' },
        { kind: 'local-endpoint', state: 'enabled', version: 1 },
      ],
      budget: { activeVersion: null },
      reservations: [],
      holds: { count: 0, oldestCreatedAt: null, nextExpiresAt: null },
    },
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

  for (const [name, kinds] of [
    ['empty judge kinds', []],
    ['missing local endpoint', report.judge.kinds.slice(0, 2)],
    ['duplicated typesafe', [report.judge.kinds[0], report.judge.kinds[0], report.judge.kinds[1]]],
    [
      'enabled kind without version',
      [{ kind: 'typesafe', state: 'enabled', version: null }, ...report.judge.kinds.slice(1)],
    ],
    [
      'disabled kind with version',
      [report.judge.kinds[0], report.judge.kinds[1], { kind: 'local-endpoint', state: 'disabled', version: 1 }],
    ],
  ] as const)
    assert.equal(
      validate({ ...report, judge: { ...report.judge, kinds } }),
      false,
      `${name}: ${JSON.stringify(validate.errors)}`,
    );
});
