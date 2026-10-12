import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore, emptyConfig } from '@agentcomms/core';
import { canonicalJudgeKindEnablement } from '../src/domain/judges.ts';
import { EventDomainError, JUDGE_KINDS } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime } from '../src/runtime/activations.ts';
import {
  createLayaJudgeKindDefinition,
  LayaContractError,
  type LayaReviewedAssets,
  layaModelStatusFromRecord,
} from '../src/runtime/laya/contracts.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { LayaModelRepository } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const fixtureRoot = join(import.meta.dirname, 'fixtures', 'laya');

async function syntheticAssetSource(): Promise<LayaReviewedAssets> {
  return {
    manifestBytes: await readFile(join(fixtureRoot, 'manifest-tiny-v1.json')),
    runtimeLockBytes: await readFile(join(fixtureRoot, 'lock-expected.json')),
    disclosuresBytes: await readFile(join(fixtureRoot, 'disclosures-tiny-v1.json')),
  };
}

function syntheticPlatform() {
  return {
    platform: 'darwin' as const,
    architecture: 'arm64',
    spawnSync: () => ({ status: 0, signal: null, error: undefined }),
  } as never;
}

async function syntheticDefinition() {
  return createLayaJudgeKindDefinition({ assets: await syntheticAssetSource(), platform: syntheticPlatform() });
}

test('E2 laya enablement: the shipped blocked lock refuses before an intent or pointer exists', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e2-laya-unavailable-');
  const store = await openEventDatabase({ stateDir: root });
  try {
    const before = store.database
      .prepare("SELECT count(*) AS count FROM activation_intents WHERE kind = 'judge-kind'")
      .get() as { count: number };
    assert.throws(
      () => canonicalJudgeKindEnablement({ id: 'judge-kind:laya', kind: JUDGE_KINDS[1], version: 1 }),
      (error: unknown) => error instanceof EventDomainError && error.code === 'E2_EXTERNAL_REFERENCE_BLOCKED',
    );
    assert.equal(
      (
        store.database
          .prepare("SELECT count(*) AS count FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?")
          .get(JUDGE_KINDS[1]) as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        store.database.prepare("SELECT count(*) AS count FROM activation_intents WHERE kind = 'judge-kind'").get() as {
          count: number;
        }
      ).count,
      before.count,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E2 laya enablement: unsupported platforms and a missing macOS boundary refuse before preparation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const assets: LayaReviewedAssets = await syntheticAssetSource();
  for (const platform of [
    { platform: 'linux' as const, architecture: 'x64', code: 'LAYA_PLATFORM_UNAVAILABLE' },
    { platform: 'win32' as const, architecture: 'x64', code: 'LAYA_PLATFORM_UNAVAILABLE' },
    {
      platform: 'darwin' as const,
      architecture: 'arm64',
      spawnSync: () => ({ status: 1, signal: null, error: undefined }),
      code: 'LAYA_SANDBOX_UNAVAILABLE',
    },
  ]) {
    const definition = createLayaJudgeKindDefinition({ assets, platform });
    assert.deepEqual(definition.availability(), { available: false, code: platform.code });
    assert.throws(
      () => definition.prepareEnablement({ version: 1 }),
      (error: unknown) => error instanceof LayaContractError && error.code === platform.code,
    );
  }
});

test('E2 laya model state: has only D8 content-free fields and needs the active kind pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e2-laya-model-');
  const store = await openEventDatabase({ stateDir: root });
  try {
    const columns = store.database.prepare("PRAGMA table_info('laya_models')").all() as Array<{ name: string }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      ['manifest_id', 'state', 'bytes_verified', 'verified_at', 'failure_code', 'updated_at'],
    );
    const table = store.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'laya_models'")
      .get() as { sql: string };
    assert.match(
      table.sql,
      /state TEXT NOT NULL CHECK \(state IN \('installing', 'downloading', 'ready', 'failed', 'removed'\)\)/,
    );
    const models = new LayaModelRepository(store.database);
    assert.throws(
      () =>
        models.write({
          manifestId: 'synthetic-laya-manifest',
          state: 'installing',
          bytesVerified: 0,
          failureCode: null,
          now: 1,
        }),
      /pointer/i,
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM laya_models').get() as { count: number }).count,
      0,
    );
    const definition = await syntheticDefinition();
    const enablement = definition.prepareEnablement({ version: 1 });
    const availability = definition.availability();
    assert.ok(availability.available);
    assert.deepEqual(
      layaModelStatusFromRecord({
        record: {
          manifestId: enablement.manifest.manifestId,
          state: 'removed',
          bytesVerified: 0,
          verifiedAt: null,
          failureCode: null,
          updatedAt: 2,
        },
        enablement,
        availability,
      }).state,
      'idle',
    );
    assert.throws(
      () =>
        layaModelStatusFromRecord({
          record: {
            manifestId: enablement.manifest.manifestId,
            state: 'ready',
            bytesVerified: 0,
            verifiedAt: 2,
            failureCode: null,
            updatedAt: 2,
            modelPath: '/tmp/model',
          },
          enablement,
          availability,
        }),
      (error: unknown) => error instanceof LayaContractError && error.code === 'LAYA_ASSET_INVALID',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E2 laya enablement: parsed fixture asset bytes—not an injectable definition—enable the normal activation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e2-laya-activation-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(emptyConfig())}\n`);
  const store = await openEventDatabase({ stateDir });
  try {
    const assets = await syntheticAssetSource();
    const platform = syntheticPlatform();
    const definition = createLayaJudgeKindDefinition({ assets, platform });
    const config = new ConfigStore(configDir);
    const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => config.load() });
    new ImmutableVersions(store.database, {
      layaAssetSource: assets,
      layaPlatformProbe: platform,
    } as never).createJudgeKind(definition.prepareEnablement({ version: 1 }));
    const runtime = new ActivationRuntime({
      store,
      approvals,
      config,
      gmailSourceFor: async () => {
        throw new Error('judge-kind activation must not query a source');
      },
      encryptBaseline: async () => {
        throw new Error('judge-kind activation must not create a baseline');
      },
      decryptBaseline: async () => {
        throw new Error('judge-kind activation must not decrypt a baseline');
      },
      encryptPoint: async () => {
        throw new Error('judge-kind activation must not create a point');
      },
      decryptPoint: async () => {
        throw new Error('judge-kind activation must not decrypt a point');
      },
      mailboxLock: new MailboxLock(),
      layaAssetSource: assets,
      layaPlatformProbe: platform,
    });
    const prepared = await runtime.prepareJudgeKind({ kind: JUDGE_KINDS[1], version: 1 });
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM laya_models').get() as { count: number }).count,
      0,
      'preparation does not pre-claim a model row',
    );
    const challenge = await runtime.issueChallenge(prepared.approvalId);
    await runtime.approve({ approvalId: prepared.approvalId, answer: challenge });
    assert.equal(
      new ImmutableVersions(store.database, {
        layaAssetSource: assets,
        layaPlatformProbe: platform,
      } as never).activeVersion('judge-kind', JUDGE_KINDS[1])?.version,
      1,
    );

    const models = new LayaModelRepository(store.database);
    const row = store.immediate(() =>
      models.write({
        manifestId: definition.prepareEnablement({ version: 1 }).manifest.manifestId,
        state: 'installing',
        bytesVerified: 0,
        now: 1,
      }),
    );
    assert.deepEqual(row, {
      manifestId: 'laya-en-onnx-68f27dfe',
      state: 'installing',
      bytesVerified: 0,
      verifiedAt: null,
      failureCode: null,
      updatedAt: 1,
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E2 laya enablement: invalid injected reviewed bytes refuse before any intent or model row', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e2-laya-invalid-injected-assets-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(emptyConfig())}\n`);
  const store = await openEventDatabase({ stateDir });
  try {
    const assets = await syntheticAssetSource();
    const platform = syntheticPlatform();
    const definition = createLayaJudgeKindDefinition({ assets, platform });
    new ImmutableVersions(store.database, {
      layaAssetSource: assets,
      layaPlatformProbe: platform,
    } as never).createJudgeKind(definition.prepareEnablement({ version: 1 }));
    const config = new ConfigStore(configDir);
    const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => config.load() });
    const runtime = new ActivationRuntime({
      store,
      approvals,
      config,
      gmailSourceFor: async () => {
        throw new Error('judge-kind activation must not query a source');
      },
      encryptBaseline: async () => {
        throw new Error('judge-kind activation must not create a baseline');
      },
      decryptBaseline: async () => {
        throw new Error('judge-kind activation must not decrypt a baseline');
      },
      encryptPoint: async () => {
        throw new Error('judge-kind activation must not create a point');
      },
      decryptPoint: async () => {
        throw new Error('judge-kind activation must not decrypt a point');
      },
      mailboxLock: new MailboxLock(),
      layaAssetSource: {
        ...assets,
        manifestBytes: Buffer.concat([Buffer.from(assets.manifestBytes), Buffer.from(' ')]),
      },
      layaPlatformProbe: platform,
    });

    await assert.rejects(
      () => runtime.prepareJudgeKind({ kind: JUDGE_KINDS[1], version: 1 }),
      (error: unknown) => error instanceof LayaContractError && error.code === 'LAYA_ASSET_INVALID',
    );
    const intents = store.database
      .prepare("SELECT count(*) AS count FROM activation_intents WHERE kind = 'judge-kind'")
      .get() as { count: number };
    const models = store.database.prepare('SELECT count(*) AS count FROM laya_models').get() as { count: number };
    assert.equal(intents.count, 0);
    assert.equal(models.count, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E2 laya model state: rejects a manifest not named by the active Laya pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e2-laya-manifest-fence-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(emptyConfig())}\n`);
  const store = await openEventDatabase({ stateDir });
  try {
    const assets = await syntheticAssetSource();
    const platform = syntheticPlatform();
    const definition = createLayaJudgeKindDefinition({ assets, platform });
    const config = new ConfigStore(configDir);
    const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => config.load() });
    new ImmutableVersions(store.database, {
      layaAssetSource: assets,
      layaPlatformProbe: platform,
    } as never).createJudgeKind(definition.prepareEnablement({ version: 1 }));
    const runtime = new ActivationRuntime({
      store,
      approvals,
      config,
      gmailSourceFor: async () => {
        throw new Error('judge-kind activation must not query a source');
      },
      encryptBaseline: async () => {
        throw new Error('judge-kind activation must not create a baseline');
      },
      decryptBaseline: async () => {
        throw new Error('judge-kind activation must not decrypt a baseline');
      },
      encryptPoint: async () => {
        throw new Error('judge-kind activation must not create a point');
      },
      decryptPoint: async () => {
        throw new Error('judge-kind activation must not decrypt a point');
      },
      mailboxLock: new MailboxLock(),
      layaAssetSource: assets,
      layaPlatformProbe: platform,
    });
    const prepared = await runtime.prepareJudgeKind({ kind: JUDGE_KINDS[1], version: 1 });
    const challenge = await runtime.issueChallenge(prepared.approvalId);
    await runtime.approve({ approvalId: prepared.approvalId, answer: challenge });

    const models = new LayaModelRepository(store.database);
    assert.throws(
      () =>
        store.immediate(() =>
          models.write({
            manifestId: 'unreviewed-laya-manifest',
            state: 'installing',
            bytesVerified: 0,
            now: 1,
          }),
        ),
      /manifest/i,
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM laya_models').get() as { count: number }).count,
      0,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
