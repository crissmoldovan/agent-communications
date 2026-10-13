import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { projectE9Doctor } from '../src/runtime/b3-doctor-projection.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const localJudge = {
  judgeId: 'judge-e9-local',
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'judge-test-model',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'] as const,
  promptTemplate: 'judge-test-v1',
  protocol: 'noul' as const,
};

test('E9: the B3 judge operation join creates immutable judge authority while preserving the typed E2 seam', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e9-operation-join-');
  const store = await openEventDatabase({ stateDir });
  try {
    const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } });
    const created = await control.handle({ operation: 'addJudge', args: { document: localJudge } });
    assert.deepEqual(created, {
      id: 'judge-e9-local@1',
      kind: 'judge',
      objectId: 'judge-e9-local',
      version: 1,
      document: localJudge,
      digest: (created as { readonly digest: string }).digest,
      state: null,
    });
    assert.deepEqual(await control.handle({ operation: 'judgesList', args: {} }), [
      {
        judgeId: 'judge-e9-local',
        version: 1,
        kind: 'local-endpoint',
        provider: 'ollama',
        model: 'judge-test-model',
        revokedAt: null,
      },
    ]);
    assert.deepEqual(await control.handle({ operation: 'judgeModelStatus', args: {} }), {
      kind: 'unavailable',
      code: 'E2_REQUIRED',
      phase: 'E2',
    });
    assert.deepEqual(await control.handle({ operation: 'heldList', args: {} }), {
      kind: 'held-list',
      decisions: [],
    });
    const doctor = await projectE9Doctor({
      database: store.database,
      installationId: store.installationId,
      lifecycle: { enabled: false, paused: false, switchGeneration: 0 },
      protocolVersions: [1],
      ports: { assertObjectSecretReady: async () => undefined } as never,
      config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
      approvals: { get: async () => null } as never,
      decryptSourceState: async () => null,
      now: () => 0,
    });
    assert.deepEqual(doctor.schemaVersion, 'doctor-v2');
    assert.deepEqual(doctor.judge, {
      kinds: [
        { kind: 'typesafe', state: 'disabled', version: null },
        { kind: 'laya', state: 'unavailable', code: 'E2_REQUIRED' },
        { kind: 'local-endpoint', state: 'disabled', version: null },
      ],
      budget: { activeVersion: null },
      reservations: [],
    });
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
