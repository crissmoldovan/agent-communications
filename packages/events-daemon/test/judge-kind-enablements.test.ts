import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const typesafe = {
  id: 'judge-kind:typesafe' as const,
  kind: 'typesafe' as const,
  version: 1,
  endpoint: 'https://api.typesafe.ai/v1/systemone' as const,
};
const judge = {
  judgeId: 'judge-e4-disabled',
  version: 1,
  kind: 'typesafe' as const,
  provider: 'typesafe' as const,
  model: 'jev-1.13.0' as const,
  endpoint: 'https://api.typesafe.ai/v1/systemone' as const,
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul' as const,
};

test('E4 judge kind: fresh, installed, updated and imported immutable versions leave every kind pointer absent', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e4-kinds-');
  const store = await openEventDatabase({ stateDir: root });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createJudgeKind(typesafe);
    versions.createJudge(judge);
    for (const kind of ['typesafe', 'laya', 'local-endpoint'] as const)
      assert.equal(versions.activeVersion('judge-kind', kind), null, `${kind} has no implicit pointer`);
    assert.equal(versions.activeVersion('judge-budget', 'judge-budget'), null, 'the singleton is absent too');
    assert.equal(versions.createJudge({ ...judge, judgeId: 'judge-e4-disabled-second', version: 1 }).state, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E4 judge kind: laya refuses before an enablement can create authority', { skip: WINDOWS_SKIP }, async () => {
  const root = await shortTempDir('events-e4-laya-');
  const store = await openEventDatabase({ stateDir: root });
  try {
    const kinds = new JudgeKinds({ store, now: () => 1 });
    assert.throws(
      () => kinds.disable('laya'),
      (error: unknown) => error instanceof EventDomainError && error.code === 'E2_REQUIRED',
    );
    assert.equal(new ImmutableVersions(store.database).activeVersion('judge-kind', 'laya'), null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
