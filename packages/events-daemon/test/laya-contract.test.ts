import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { activationDocumentDigest, canonicalActivationDocument } from '../src/domain/activation-documents.ts';
import { canonicalJudgeBudget } from '../src/domain/judges.ts';
import { JUDGE_KINDS } from '../src/domain/lifecycle.ts';
import {
  createLayaJudgeKindDefinition,
  LayaContractError,
  type LayaReviewedAssets,
} from '../src/runtime/laya/contracts.ts';

assertLoopbackSeal();

const fixtureRoot = join(import.meta.dirname, 'fixtures', 'laya');

async function fixtureAssets(): Promise<LayaReviewedAssets> {
  return {
    manifestBytes: await readFile(join(fixtureRoot, 'manifest-tiny-v1.json')),
    runtimeLockBytes: await readFile(join(fixtureRoot, 'lock-expected.json')),
    disclosuresBytes: await readFile(join(fixtureRoot, 'disclosures-tiny-v1.json')),
  };
}

function availablePlatform() {
  return {
    platform: 'darwin' as const,
    architecture: 'arm64',
    spawnSync: () => ({ status: 0, signal: null, error: undefined }),
  };
}

/**
 * Writes the changed disclosure in the reviewed asset's own canonical layout (its licence list on one line), so the
 * parser refuses it for the field the test removed and not because the bytes stopped being canonical.
 */
function assetWithDisclosureChange(
  assets: LayaReviewedAssets,
  change: (value: Record<string, unknown>) => Record<string, unknown>,
): LayaReviewedAssets {
  const changed = change(JSON.parse(Buffer.from(assets.disclosuresBytes).toString('utf8')));
  const licences = JSON.stringify(changed.runtimeLicences);
  const source = `${JSON.stringify(changed, null, 2)}\n`.replace(
    `  "runtimeLicences": ${JSON.stringify(changed.runtimeLicences, null, 2).split('\n').join('\n  ')},`,
    `  "runtimeLicences": ${licences},`,
  );
  return { ...assets, disclosuresBytes: Buffer.from(source) };
}

test('E2 contract: canonical Laya enablement binds every reviewed asset and digest input', async () => {
  const definition = createLayaJudgeKindDefinition({
    assets: await fixtureAssets(),
    platform: availablePlatform(),
  });
  const enablement = definition.prepareEnablement({ version: 1 });
  const activation = { documentVersion: 1 as const, kind: 'judge-kind' as const, enablement };
  const options = { layaAssetSource: await fixtureAssets(), layaPlatformProbe: availablePlatform() };
  const digest = activationDocumentDigest(activation, options);

  assert.deepEqual(JSON.parse(canonicalActivationDocument(activation, options)), activation);
  assert.deepEqual(definition.canonicalEnablement(enablement), enablement);
  assert.match(digest, /^[a-f0-9]{64}$/);
  const [firstManifestFile, ...remainingManifestFiles] = enablement.manifest.files;
  if (firstManifestFile === undefined) throw new Error('the synthetic reviewed manifest must have files');

  const cases: readonly [string, unknown][] = [
    ['manifest version', { ...enablement, manifest: { ...enablement.manifest, manifestVersion: 2 } }],
    [
      'manifest identity',
      { ...enablement, manifest: { ...enablement.manifest, manifestId: 'an-unreviewed-manifest' } },
    ],
    [
      'manifest file',
      { ...enablement, manifest: { ...enablement.manifest, files: [...enablement.manifest.files].reverse() } },
    ],
    [
      'manifest file field',
      {
        ...enablement,
        manifest: {
          ...enablement.manifest,
          files: [{ ...firstManifestFile, size: firstManifestFile.size + 1 }, ...remainingManifestFiles],
        },
      },
    ],
    [
      'manifest source or weights field',
      {
        ...enablement,
        manifest: {
          ...enablement.manifest,
          source: { ...enablement.manifest.source, revision: 'f'.repeat(40) },
          weights: { ...enablement.manifest.weights, licence: 'unreviewed' },
        },
      },
    ],
    [
      'manifest runtime or context field',
      {
        ...enablement,
        manifest: {
          ...enablement.manifest,
          runtime: { ...enablement.manifest.runtime, '@receptron/laya': '999.0.0' },
          context: { ...enablement.manifest.context, maxTokens: 513 },
        },
      },
    ],
    [
      'runtime package name',
      {
        ...enablement,
        runtimeLock: {
          ...enablement.runtimeLock,
          packages: [
            { ...enablement.runtimeLock.packages[0], name: 'runtime-z' },
            ...enablement.runtimeLock.packages.slice(1),
          ],
        },
      },
    ],
    [
      'runtime package version',
      {
        ...enablement,
        runtimeLock: {
          ...enablement.runtimeLock,
          packages: [
            { ...enablement.runtimeLock.packages[0], version: '999.0.0' },
            ...enablement.runtimeLock.packages.slice(1),
          ],
        },
      },
    ],
    [
      'runtime package URL',
      {
        ...enablement,
        runtimeLock: {
          ...enablement.runtimeLock,
          packages: [
            {
              ...enablement.runtimeLock.packages[0],
              url: ['https:/', '/registry.npmjs.org/runtime-a/-/other.tgz'].join(''),
            },
            ...enablement.runtimeLock.packages.slice(1),
          ],
        },
      },
    ],
    [
      'runtime package SRI',
      {
        ...enablement,
        runtimeLock: {
          ...enablement.runtimeLock,
          packages: [
            {
              ...enablement.runtimeLock.packages[0],
              integrity:
                'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
            },
            ...enablement.runtimeLock.packages.slice(1),
          ],
        },
      },
    ],
    [
      'platform file',
      {
        ...enablement,
        runtimeLock: {
          ...enablement.runtimeLock,
          platform: {
            ...enablement.runtimeLock.platform,
            files: [
              { ...enablement.runtimeLock.platform.files[0], sha256: 'a'.repeat(64) },
              ...enablement.runtimeLock.platform.files.slice(1),
            ],
          },
        },
      },
    ],
    [
      'platform list identity or digest',
      {
        ...enablement,
        runtimeLock: {
          ...enablement.runtimeLock,
          platform: {
            ...enablement.runtimeLock.platform,
            id: 'darwin-unreviewed',
            digest: 'b'.repeat(64),
          },
        },
      },
    ],
    ['runtime lock digest', { ...enablement, runtimeLock: { ...enablement.runtimeLock, digest: 'c'.repeat(64) } }],
    [
      'template',
      {
        ...enablement,
        manifest: { ...enablement.manifest, promptTemplates: [...enablement.manifest.promptTemplates].reverse() },
      },
    ],
  ];
  for (const [name, changed] of cases) {
    assert.throws(
      () => definition.canonicalEnablement(changed),
      (error: unknown) => error instanceof LayaContractError && error.code === 'LAYA_ENABLEMENT_EXACT',
      name,
    );
  }
  assert.throws(
    () => definition.canonicalEnablement({ ...enablement, manifestPath: '/tmp/unreviewed.json' }),
    (error: unknown) => error instanceof LayaContractError && error.code === 'LAYA_ENABLEMENT_EXACT',
  );
});

test('E2 contract: macOS availability runs the content-free sandbox boundary before preparation', async () => {
  const calls: Array<readonly [string, readonly string[], Readonly<Record<string, unknown>>]> = [];
  const definition = createLayaJudgeKindDefinition({
    assets: await fixtureAssets(),
    platform: {
      platform: 'darwin',
      architecture: 'arm64',
      spawnSync(command: string, args: readonly string[], options: Readonly<Record<string, unknown>>) {
        calls.push([command, args, options]);
        return { status: 0, signal: null, error: undefined };
      },
    } as never,
  });

  assert.deepEqual(definition.availability(), { available: true });
  assert.deepEqual(calls, [
    [
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1) (allow default) (deny network*)', '/usr/bin/true'],
      { cwd: '/', env: { PATH: '/usr/bin:/bin' }, shell: false, stdio: 'ignore', timeout: 250, killSignal: 'SIGKILL' },
    ],
  ]);
  assert.deepEqual(definition.prepareEnablement({ version: 1 }).kind, JUDGE_KINDS[1]);

  const unavailable = createLayaJudgeKindDefinition({
    assets: await fixtureAssets(),
    platform: {
      platform: 'darwin',
      architecture: 'arm64',
      spawnSync: () => ({ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } }),
    } as never,
  });
  assert.deepEqual(unavailable.availability(), { available: false, code: 'LAYA_SANDBOX_UNAVAILABLE' });

  const missing = createLayaJudgeKindDefinition({
    assets: await fixtureAssets(),
    platform: {
      platform: 'darwin',
      architecture: 'arm64',
      spawnSync: () => ({ status: null, signal: null, error: { code: 'ENOENT' } }),
    } as never,
  });
  assert.deepEqual(missing.availability(), { available: false, code: 'LAYA_SANDBOX_UNAVAILABLE' });
});

test('E2 contract: the approval document embeds the reviewed D11 disclosure and preview is that same document', async () => {
  const definition = createLayaJudgeKindDefinition({
    assets: await fixtureAssets(),
    platform: availablePlatform(),
  });
  const enablement = definition.prepareEnablement({ version: 1 });
  const preview = definition.preview({ version: 1 });
  const activation = { documentVersion: 1 as const, kind: 'judge-kind' as const, enablement };

  assert.deepEqual(preview, enablement);
  assert.deepEqual(
    JSON.parse(
      canonicalActivationDocument(activation, {
        layaAssetSource: await fixtureAssets(),
        layaPlatformProbe: availablePlatform(),
      }),
    ),
    activation,
  );
  assert.deepEqual((enablement as { readonly disclosures?: unknown }).disclosures, {
    modelBytes: enablement.manifest.files.reduce((total, file) => total + file.size, 0),
    runtimeBytes: enablement.runtimeLock.platform.files.reduce((total, file) => total + file.size, 0),
    runtimeLicences: ['MIT'],
    workerMemory: 'roughly 2 GB worker memory.',
    facts: {
      englishCpu: 'English-only, 512-token context, CPU-only execution.',
      macosBoundary:
        'macOS-only sandbox-exec boundary denies every network operation, including loopback TCP and pathname Unix-domain sockets.',
      linuxUnavailable: 'Linux unavailable: its current boundary does not block pathname Unix-domain sockets.',
      windowsUnavailable: 'Windows unavailable: an AppContainer native launcher is not included.',
      downloadAfterApproval: 'Download after approval.',
      oneAtATime: 'One-at-a-time execution.',
    },
    limitations: {
      sandboxDeprecation:
        'sandbox-exec is deprecated; if it is unavailable or its boundary self-test fails, Laya is unavailable.',
      englishAccuracy: 'Accuracy in languages other than English is not established.',
    },
  });
});

test('E2 contract: preview is complete, reviewed, and content-free', async () => {
  const definition = createLayaJudgeKindDefinition({
    assets: await fixtureAssets(),
    platform: availablePlatform(),
  });
  const preview = definition.preview({ version: 1 });
  const rendered = JSON.stringify(preview);
  for (const required of [
    'English-only',
    '512-token',
    'CPU-only',
    'macOS-only',
    'sandbox-exec',
    'denies every network operation',
    'pathname Unix-domain sockets',
    'Linux unavailable',
    'Windows unavailable',
    'download after approval',
    'roughly 2 GB',
    'one-at-a-time',
    'huggingface.co',
    'Apache-2.0',
  ])
    assert.match(rendered, new RegExp(required, 'i'));
  assert.doesNotMatch(rendered, /(?:\/Users\/|\\\\|request|response|token=|secret)/i);
  assert.equal(preview.manifest.manifestId, 'laya-en-onnx-68f27dfe');
});

test('E2 contract: preview refuses a reviewed asset missing either D11 limitation', async () => {
  const assets = await fixtureAssets();
  for (const limitation of ['sandboxDeprecation', 'englishAccuracy']) {
    assert.throws(
      () =>
        createLayaJudgeKindDefinition({
          assets: assetWithDisclosureChange(assets, (value) => {
            const limitations = { ...(value.limitations as Record<string, unknown>) };
            delete limitations[limitation];
            return { ...value, limitations };
          }),
          platform: availablePlatform(),
        }),
      // The completeness guard itself must refuse it, not a later shape check that happens to trip as well.
      (error: unknown) =>
        error instanceof LayaContractError &&
        error.code === 'LAYA_ASSET_INVALID' &&
        error.message === 'the Laya disclosure limitations are complete',
      limitation,
    );
  }
});

test('E2 contract: preview refuses a reviewed asset missing a D11 stated fact', async () => {
  const assets = await fixtureAssets();
  for (const fact of [
    'englishCpu',
    'macosBoundary',
    'linuxUnavailable',
    'windowsUnavailable',
    'downloadAfterApproval',
    'oneAtATime',
  ]) {
    assert.throws(
      () =>
        createLayaJudgeKindDefinition({
          assets: assetWithDisclosureChange(assets, (value) => {
            const facts = { ...(value.facts as Record<string, unknown>) };
            delete facts[fact];
            return { ...value, facts };
          }),
          platform: availablePlatform(),
        }),
      (error: unknown) => error instanceof LayaContractError && error.code === 'LAYA_ASSET_INVALID',
      fact,
    );
  }
});

test('E2 contract: definition construction accepts only canonical reviewed asset bytes', async () => {
  const assets = await fixtureAssets();
  assert.throws(
    () =>
      createLayaJudgeKindDefinition({
        assets: {
          ...assets,
          disclosuresBytes: Buffer.concat([Buffer.from(assets.disclosuresBytes), Buffer.from(' ')]),
        },
        platform: availablePlatform(),
      }),
    (error: unknown) => error instanceof LayaContractError && error.code === 'LAYA_ASSET_INVALID',
  );
});

/** The fixture manifest with another template list, written in the manifest's canonical layout (the list on one line). */
function manifestWithTemplates(assets: LayaReviewedAssets, templates: readonly unknown[]): LayaReviewedAssets {
  const manifest = JSON.parse(Buffer.from(assets.manifestBytes).toString('utf8')) as Record<string, unknown>;
  const source = `${JSON.stringify({ ...manifest, promptTemplates: templates }, null, 2)}\n`;
  const multiline = `  "promptTemplates": ${JSON.stringify(templates, null, 2).split('\n').join('\n  ')}`;
  const compact = `  "promptTemplates": [${templates.map((id) => JSON.stringify(id)).join(', ')}]`;
  return { ...assets, manifestBytes: Buffer.from(source.replace(multiline, compact)) };
}

test('E2 contract: the manifest offers a sorted list of templates the worker implements, and nothing else', async () => {
  const assets = await fixtureAssets();
  // E2 Task 10: the release offers `laya-noul-v1` alone, so a single-template manifest is a reviewed one.
  const noulOnly = createLayaJudgeKindDefinition({
    assets: manifestWithTemplates(assets, ['laya-noul-v1']),
    platform: availablePlatform(),
  });
  assert.deepEqual(noulOnly.prepareEnablement({ version: 1 }).manifest.promptTemplates, ['laya-noul-v1']);
  for (const [name, templates] of [
    ['empty', []],
    ['not implemented by the worker', ['laya-noul-v2']],
    ['implemented, beside one that is not', ['laya-noul-v1', 'laya-unreviewed-v1']],
    ['unsorted', ['laya-noul-v1', 'laya-choice2-v1']],
    ['duplicated', ['laya-noul-v1', 'laya-noul-v1']],
    ['not text', [1]],
  ] as const) {
    assert.throws(
      () =>
        createLayaJudgeKindDefinition({
          assets: manifestWithTemplates(assets, templates),
          platform: availablePlatform(),
        }),
      (error: unknown) => error instanceof LayaContractError && error.code === 'LAYA_ASSET_INVALID',
      name,
    );
  }
});

test('E2 contract: Laya provider concurrency greater than one is refused', () => {
  assert.throws(
    () =>
      canonicalJudgeBudget({
        budgetId: 'judge-budget',
        version: 1,
        global: { callsPerRollingHour: 2, inputTokensPerRolling30Days: 2, concurrency: 2 },
        providers: [
          {
            provider: JUDGE_KINDS[1],
            callsPerRollingHour: 2,
            inputTokensPerRolling30Days: 2,
            concurrency: 2,
          },
        ],
      }),
    /one-at-a-time/i,
  );
});
