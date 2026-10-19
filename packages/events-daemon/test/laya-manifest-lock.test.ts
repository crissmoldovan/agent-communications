import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { normaliseActivationDocument } from '../src/domain/activation-documents.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';

const fixtureRoot = join(import.meta.dirname, 'fixtures', 'laya');
const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const registryOrigin = ['https:/', '/registry.npmjs.org'].join('');
const alternateOrigin = ['https:/', '/registry.example.test'].join('');
const huggingFaceOrigin = ['https:/', '/huggingface.co'].join('');

function registryTarball(name: string, version: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `${registryOrigin}/${name}/-/${unscoped}-${version}.tgz`;
}

interface RuntimeLockModule {
  assertLayaManifest(value: unknown): void;
  buildFixtureRuntimeLock(input: unknown, archives: ReadonlyMap<string, Buffer>): Promise<string>;
  parseLayaManifest(text: string): unknown;
  parseRuntimeLock(text: string): unknown;
  readPrivateRuntimeClosure(lockfile: string): readonly RuntimePackage[];
}

interface RuntimePackage {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
}

interface LayaManifest {
  readonly manifestVersion: 1;
  readonly manifestId: string;
  readonly source: { readonly host: string; readonly repo: string; readonly revision: string };
  readonly weights: {
    readonly publisher: string;
    readonly origin: string;
    readonly originSha256: string;
    readonly licence: string;
  };
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
  readonly context: { readonly maxTokens: number; readonly language: string };
  readonly runtime: Record<string, string>;
  readonly promptTemplates: readonly string[];
}

interface ExternalSource {
  readonly id: string;
  readonly url: string;
  readonly fetchedAt: string;
  readonly immutable: string;
  readonly fact: string;
  readonly reviewer: string;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runtimeLockModule(): Promise<RuntimeLockModule> {
  // @ts-expect-error The release-only JavaScript command deliberately ships without a TypeScript declaration.
  const module = await import('../../../scripts/laya-runtime-lock.mjs');
  return module as RuntimeLockModule;
}

interface ReleaseAcquirerModule {
  buildLayaRuntimeLock(input: unknown, acquire?: (metadata: unknown) => Promise<Buffer>): Promise<string>;
  fetchLayaReleaseTarball(input: unknown, acquire?: (metadata: unknown) => Promise<Buffer>): Promise<Buffer>;
  supplyChainGateAcquirer(env?: NodeJS.ProcessEnv): (metadata: unknown) => Promise<Buffer>;
}

async function releaseAcquirerModule(): Promise<ReleaseAcquirerModule> {
  // @ts-expect-error The release-only JavaScript command deliberately ships without a TypeScript declaration.
  const module = await import('../../../scripts/fetch-laya-release-tarballs.mjs');
  return module as ReleaseAcquirerModule;
}

async function json(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(join(fixtureRoot, relative), 'utf8'));
}

async function sri(path: string): Promise<string> {
  return `sha512-${createHash('sha512')
    .update(await readFile(path))
    .digest('base64')}`;
}

function noncanonicalSha512Sri(integrity: string): string {
  const prefix = 'sha512-';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  assert.ok(integrity.startsWith(prefix));
  const payload = integrity.slice(prefix.length);
  const final = payload.at(-3);
  assert.ok(final);
  const index = alphabet.indexOf(final);
  assert.ok(index >= 0 && index % 16 === 0, 'a sha512 SRI payload has canonical final padding bits');
  return `${prefix}${payload.slice(0, -3)}${alphabet[index + 1]}==`;
}

test('E2 manifest: contains the reviewed single English ONNX entry', async () => {
  const { assertLayaManifest, parseLayaManifest } = await runtimeLockModule();
  const manifestText = await readFile(join(repositoryRoot, 'packages/events-daemon/laya-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as LayaManifest;
  assert.deepEqual(parseLayaManifest(manifestText), manifest);
  assert.doesNotThrow(() => assertLayaManifest(manifest));
  // The fixture keeps both of the worker's templates; the release offers `laya-noul-v1` alone (E2 Task 10), and every
  // other reviewed fact is the fixture's.
  const { promptTemplates, ...facts } = manifest;
  const { promptTemplates: fixtureTemplates, ...fixtureFacts } = (await json('manifest-tiny-v1.json')) as LayaManifest;
  assert.deepEqual(facts, fixtureFacts);
  assert.deepEqual(promptTemplates, ['laya-noul-v1']);
  assert.deepEqual(fixtureTemplates, ['laya-choice2-v1', 'laya-noul-v1']);
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.manifestId, 'laya-en-onnx-68f27dfe');
  assert.deepEqual(manifest.source, {
    host: 'huggingface.co',
    repo: 'receptron/laya-onnx',
    revision: '68f27dfe5a27a54fb2b1fefc432f43f972e90868',
  });
  assert.deepEqual(manifest.context, { maxTokens: 512, language: 'en' });
  assert.deepEqual(manifest.runtime, {
    '@receptron/laya': '0.1.2',
    'onnxruntime-node': '1.30.0',
    '@huggingface/tokenizers': '0.2.0',
  });
  assert.equal(manifest.weights.originSha256, '891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c');
  const task = (await json('cases/task-2.json')) as { readonly externalSources: readonly ExternalSource[] };
  const source = (id: string): ExternalSource => {
    const found = task.externalSources.find((candidate) => candidate.id === id);
    assert.ok(found, `source record ${id} is present`);
    return found;
  };
  const tree = source('hf-laya-onnx-tree');
  const readme = source('hf-laya-onnx-readme');
  const origin = source('hf-laya-origin-weights');
  assert.deepEqual(origin, {
    id: 'hf-laya-origin-weights',
    url: `${huggingFaceOrigin}/api/models/convaiinnovations/laya/paths-info/7b928d828b7b0e022f929d9bd2e44165aa270148`,
    fetchedAt: '2026-10-10T22:07:11Z',
    immutable: '891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c',
    fact: 'convaiinnovations/laya model.safetensors is 842609210 bytes with SHA-256 891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c; it was last changed by commit 00c37c405e3c3ad73ee070227614c89cda06b99e on 2026-09-18 ("Initial release of Laya fine-tuned System 1 decision model"), before receptron/laya-onnx\'s export at revision 68f27dfe5a27a54fb2b1fefc432f43f972e90868 (2026-09-19); the repository is licensed apache-2.0 and its later commits up to 7b928d828b7b0e022f929d9bd2e44165aa270148 changed only the README, assets and a root config.json',
    reviewer: 'coordinator',
  });
  assert.equal(manifest.manifestId, `laya-en-onnx-${manifest.source.revision.slice(0, 8)}`);
  assert.equal(new URL(tree.url).hostname, manifest.source.host);
  assert.match(tree.fact, new RegExp(escaped(`${manifest.source.repo} at revision ${manifest.source.revision}`)));
  assert.match(
    readme.fact,
    new RegExp(escaped(`weights are ${manifest.weights.publisher}' under ${manifest.weights.licence}`)),
  );
  assert.match(origin.fact, new RegExp(escaped(manifest.weights.origin)));
  assert.match(origin.fact, new RegExp(manifest.weights.originSha256));
  const evidence = await readFile(
    join(repositoryRoot, 'docs/superpowers/evidence/2026-10-10-e2-external-sources.md'),
    'utf8',
  );
  for (const file of manifest.files) {
    assert.match(tree.fact, new RegExp(escaped(`${file.path} ${file.size} bytes`)));
    assert.match(evidence, new RegExp(escaped(file.sha256)));
  }
  for (const [name, version] of Object.entries(manifest.runtime)) {
    const sourceId = `npm-${name.replace('@', '').replace('/', '-')}-${version}`;
    assert.match(source(sourceId).fact, new RegExp(escaped(`${name} ${version}`)));
  }
  assert.match(readme.fact, /English/);
});

test('E2 manifest: refuses noncanonical JSON text', async () => {
  const { parseLayaManifest } = await runtimeLockModule();
  const manifest = await readFile(join(fixtureRoot, 'manifest-tiny-v1.json'), 'utf8');
  assert.throws(() => parseLayaManifest(manifest.replace('{\n', '{\n\n')), /LAYA_MANIFEST_CANONICAL/);
  assert.throws(
    () =>
      parseLayaManifest(
        manifest.replace('  "manifestVersion": 1,', '  "manifestVersion": 1,\n  "manifestVersion": 1,'),
      ),
    /RUNTIME_LOCK_DUPLICATE/,
  );
});

test('E2 manifest: offers a sorted, duplicate-free list of the worker templates, written on one line', async () => {
  const { assertLayaManifest, parseLayaManifest } = await runtimeLockModule();
  const manifest = (await json('manifest-tiny-v1.json')) as LayaManifest;
  // E2 Task 10: the release offers `laya-noul-v1` alone; the fixture keeps the worker's pair.
  const text = await readFile(join(repositoryRoot, 'packages/events-daemon/laya-manifest.json'), 'utf8');
  assert.match(text, /\n {2}"promptTemplates": \["laya-noul-v1"\]\n\}\n$/);
  assert.deepEqual((parseLayaManifest(text) as LayaManifest).promptTemplates, ['laya-noul-v1']);
  assert.throws(
    () => parseLayaManifest(text.replace('["laya-noul-v1"]', '[\n    "laya-noul-v1"\n  ]')),
    /LAYA_MANIFEST_CANONICAL/,
  );
  assert.doesNotThrow(() => assertLayaManifest({ ...manifest, promptTemplates: ['laya-noul-v1'] }));
  for (const templates of [[], ['laya-noul-v2'], ['laya-noul-v1', 'laya-unreviewed-v1'], [7]]) {
    assert.throws(() => assertLayaManifest({ ...manifest, promptTemplates: templates }), /LAYA_MANIFEST$/);
  }
  for (const templates of [
    ['laya-noul-v1', 'laya-choice2-v1'],
    ['laya-noul-v1', 'laya-noul-v1'],
  ]) {
    assert.throws(() => assertLayaManifest({ ...manifest, promptTemplates: templates }), /LAYA_MANIFEST_ORDER/);
  }
});

test('E2 manifest: refuses duplicate, unsorted, and unsafe file paths', async () => {
  const { assertLayaManifest } = await runtimeLockModule();
  const manifest = (await json('manifest-tiny-v1.json')) as LayaManifest;
  assert.throws(
    () =>
      assertLayaManifest({ ...manifest, files: [manifest.files[0], manifest.files[0], ...manifest.files.slice(2)] }),
    /LAYA_MANIFEST_ORDER/,
  );
  assert.throws(() => assertLayaManifest({ ...manifest, files: [...manifest.files].reverse() }), /LAYA_MANIFEST_ORDER/);
  for (const path of ['../laya.onnx', '/laya.onnx', 'tokenizer\\tokenizer.json', `tokenizer/\0tokenizer.json`]) {
    assert.throws(
      () =>
        assertLayaManifest({
          ...manifest,
          files: [{ ...manifest.files[0], path }, ...manifest.files.slice(1)],
        }),
      /RUNTIME_LOCK_FIELD/,
    );
  }
});

test('E2 manifest and runtime lock: refuses lone-surrogate paths before comparison', async () => {
  const { assertLayaManifest, parseRuntimeLock } = await runtimeLockModule();
  const manifest = (await json('manifest-tiny-v1.json')) as LayaManifest;
  const expected = await readFile(join(fixtureRoot, 'lock-expected.json'), 'utf8');
  const surrogatePath = `tokenizer/\uD800`;
  const finalFile = manifest.files.at(-1);
  assert.ok(finalFile);

  assert.throws(
    () =>
      assertLayaManifest({
        ...manifest,
        files: [...manifest.files.slice(0, -1), { ...finalFile, path: surrogatePath }],
      }),
    /RUNTIME_LOCK_FIELD/,
  );
  assert.throws(() => parseRuntimeLock(expected.replace('"shared.mjs"', `"${surrogatePath}"`)), /RUNTIME_LOCK_FIELD/);
});

test('E2 runtime lock: blocked placeholder keeps daemon Laya enablement from reaching install', async () => {
  assert.deepEqual(
    JSON.parse(await readFile(join(repositoryRoot, 'packages/events-daemon/laya-runtime.json'), 'utf8')),
    { schemaVersion: 1, blocked: 'E2_EXTERNAL_REFERENCE_BLOCKED' },
  );
  assert.throws(
    () =>
      normaliseActivationDocument({
        documentVersion: 1,
        kind: 'judge-kind',
        enablement: { id: 'judge-kind:laya', kind: 'laya', version: 1 },
      }),
    // E2 Task 1 replaced E's E2_REQUIRED seam: the placeholder lock now refuses with the plan's own blocked code.
    (error: unknown) => error instanceof EventDomainError && error.code === 'E2_EXTERNAL_REFERENCE_BLOCKED',
  );
});

test('E2 runtime lock: resolves the exact 19-package private importer closure from the real lockfile', async () => {
  const { readPrivateRuntimeClosure } = await runtimeLockModule();
  const lockfile = await readFile(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');

  assert.deepEqual(readPrivateRuntimeClosure(lockfile), [
    {
      name: '@huggingface/tokenizers',
      version: '0.2.0',
      url: registryTarball('@huggingface/tokenizers', '0.2.0'),
      integrity: 'sha512-LidMHe1FpcSYH4vcSjXooda34pC0M8m1gmDOv7SQi6Iv+ib1zX7J3sHBCC9/3FPCkn2k1b55FneVqMRxrr99pg==',
    },
    {
      name: '@receptron/laya',
      version: '0.1.2',
      url: registryTarball('@receptron/laya', '0.1.2'),
      integrity: 'sha512-cTqQC4DEY/wDAHY44EQhbW8wlrO7mZyLVWOy512783LUq55a7nLGGu16wXVi6oi4uNRfR0cLctKcQAxdXCXQfA==',
    },
    {
      name: 'adm-zip',
      version: '0.6.1',
      url: registryTarball('adm-zip', '0.6.1'),
      integrity: 'sha512-Xwrja8nx9e5o2N1my4DsKCeKpdrnACyr1wtbPxBDgGzKzKyE9kRtBFA8mWldI+RVlD7CBZNWY/wQ2+ydwOR6kQ==',
    },
    {
      name: 'define-data-property',
      version: '1.1.4',
      url: registryTarball('define-data-property', '1.1.4'),
      integrity: 'sha512-rBMvIzlpA8v6E+SJZoo++HAYqsLrkg7MSfIinMPFhmkorw7X+dOXVJQs+QT69zGkzMyfDnIMN2Wid1+NbL3T+A==',
    },
    {
      name: 'define-properties',
      version: '1.2.1',
      url: registryTarball('define-properties', '1.2.1'),
      integrity: 'sha512-8QmQKqEASLd5nx0U1B1okLElbUuuttJ/AnYmRXbbbGDWh6uS208EjD4Xqq/I9wK7u0v6O08XhTWnt5XtEbR6Dg==',
    },
    {
      name: 'es-define-property',
      version: '1.0.1',
      url: registryTarball('es-define-property', '1.0.1'),
      integrity: 'sha512-e3nRfgfUZ4rNGL232gUgX06QNyyez04KdjFrF+LTRoOXmrOgFKDg4BCdsjW8EnT69eqdYGmRpJwiPVYNrCaW3g==',
    },
    {
      name: 'es-errors',
      version: '1.3.0',
      url: registryTarball('es-errors', '1.3.0'),
      integrity: 'sha512-Zf5H2Kxt2xjTvbJvP2ZWLEICxA6j+hAmMzIlypy4xcBg1vKVnx89Wy0GbS+kf5cwCVFFzdCFh2XSCFNULS6csw==',
    },
    {
      name: 'escape-string-regexp',
      version: '4.0.0',
      url: registryTarball('escape-string-regexp', '4.0.0'),
      integrity: 'sha512-TtpcNJ3XAzx3Gq8sWRzJaVajRs0uVxA2YAkdb1jm2YkPz4G6egUFAyA3n5vtEIZefPk5Wa4UXbKuS5fKkJWdgA==',
    },
    {
      name: 'global-agent',
      version: '4.1.3',
      url: registryTarball('global-agent', '4.1.3'),
      integrity: 'sha512-KUJEViiuFT3I97t+GYMikLPJS2Lfo/S2F+DQuBWzuzaMPnvt5yyZePzArx36fBzpGTxZjIpDbXLeySLgh+k76g==',
    },
    {
      name: 'globalthis',
      version: '1.0.4',
      url: registryTarball('globalthis', '1.0.4'),
      integrity: 'sha512-DpLKbNU4WylpxJykQujfCcwYWiV/Jhm50Goo0wrVILAv5jOr9d+H+UR3PhSCD2rCCEIg0uc+G+muBTwD54JhDQ==',
    },
    {
      name: 'gopd',
      version: '1.2.0',
      url: registryTarball('gopd', '1.2.0'),
      integrity: 'sha512-ZUKRh6/kUFoAiTAtTYPZJ3hw9wNxx+BIBOijnlG9PnrJsCcSjs1wyyD6vJpaYtgnzDrKYRSqf3OO6Rfa93xsRg==',
    },
    {
      name: 'has-property-descriptors',
      version: '1.0.2',
      url: registryTarball('has-property-descriptors', '1.0.2'),
      integrity: 'sha512-55JNKuIW+vq4Ke1BjOTjM2YctQIvCT7GFzHwmfZPGo5wnrgkid0YQtnAleFSqumZm4az3n2BS+erby5ipJdgrg==',
    },
    {
      name: 'matcher',
      version: '4.0.0',
      url: registryTarball('matcher', '4.0.0'),
      integrity: 'sha512-S6x5wmcDmsDRRU/c2dkccDwQPXoFczc5+HpQ2lON8pnvHlnvHAHj5WlLVvw6n6vNyHuVugYrFohYxbS+pvFpKQ==',
    },
    {
      name: 'object-keys',
      version: '1.1.1',
      url: registryTarball('object-keys', '1.1.1'),
      integrity: 'sha512-NuAESUOUMrlIXOfHKzD6bpPu3tYt3xvjNdRIQ+FeT0lNb4K8WR70CaDxhuNguS2XG+GjkyMwOzsN5ZktImfhLA==',
    },
    {
      name: 'onnxruntime-common',
      version: '1.30.0',
      url: registryTarball('onnxruntime-common', '1.30.0'),
      integrity: 'sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==',
    },
    {
      name: 'onnxruntime-node',
      version: '1.30.0',
      url: registryTarball('onnxruntime-node', '1.30.0'),
      integrity: 'sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==',
    },
    {
      name: 'semver',
      version: '7.8.5',
      url: registryTarball('semver', '7.8.5'),
      integrity: 'sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==',
    },
    {
      name: 'serialize-error',
      version: '8.1.0',
      url: registryTarball('serialize-error', '8.1.0'),
      integrity: 'sha512-3NnuWfM6vBYoy5gZFvHiYsVbafvI9vZv/+jlIigFn4oP4zjNPK3LhcY0xSCgeb1a5L8jO71Mit9LlNoi2UfDDQ==',
    },
    {
      name: 'type-fest',
      version: '0.20.2',
      url: registryTarball('type-fest', '0.20.2'),
      integrity: 'sha512-Ne+eE4r0/iWnpAxD852z3A+N0Bt5RN//NjJwRd2VFHEmrywxf5vsZlh4R6lixl6B+wz/8d+maTSAkN1FIkI3LQ==',
    },
  ]);
});

test('E2 runtime lock: refuses a closure row absent from or different from the reviewed table', async () => {
  const { readPrivateRuntimeClosure } = await runtimeLockModule();
  const lockfile = await readFile(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const task = (await json('cases/task-2.json')) as { readonly externalSources: readonly ExternalSource[] };
  assert.deepEqual(
    task.externalSources.find((source) => source.id === 'npm-laya-runtime-closure'),
    {
      id: 'npm-laya-runtime-closure',
      url: `${registryOrigin}/`,
      fetchedAt: '2026-10-10T22:38:05Z',
      immutable: '5e23d92819feccb28ab2be114fa0a26613ec61d6dc5373c5d462a560f23bd181',
      fact: `the private @agentcomms/events-laya-runtime importer's closure in pnpm-lock.yaml is exactly the 19 packages tabled below; for each, the coordinator fetched ${registryOrigin}/<name>/<version> and the registry's dist.integrity equals the lockfile's and its tarball is the canonical registry URL; only onnxruntime-node declares an install-time script (postinstall), which never runs`,
      reviewer: 'coordinator',
    },
  );
  assert.throws(
    () =>
      readPrivateRuntimeClosure(
        lockfile.replace(
          'sha512-Xwrja8nx9e5o2N1my4DsKCeKpdrnACyr1wtbPxBDgGzKzKyE9kRtBFA8mWldI+RVlD7CBZNWY/wQ2+ydwOR6kQ==',
          'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
        ),
      ),
    /RUNTIME_EVIDENCE/,
  );
  assert.throws(
    () =>
      readPrivateRuntimeClosure(
        lockfile
          .replaceAll('adm-zip@0.6.1', 'unrecorded@0.6.1')
          .replace('      adm-zip: 0.6.1', '      unrecorded: 0.6.1'),
      ),
    /RUNTIME_EVIDENCE/,
  );
});

test('E2 runtime lock: rebuilds canonical platform files from acquirer-verified fixture bytes', async () => {
  const module = await runtimeLockModule();
  assert.equal(typeof module.buildFixtureRuntimeLock, 'function');
  const { buildFixtureRuntimeLock } = module;
  const runtimeA = join(fixtureRoot, 'lock-input', 'runtime-a-1.0.0.tgz');
  const runtimeB = join(fixtureRoot, 'lock-input', 'runtime-b-1.0.0.tgz');
  const lock = await buildFixtureRuntimeLock(
    {
      packages: [
        {
          name: 'runtime-b',
          version: '1.0.0',
          url: `${registryOrigin}/runtime-b/-/runtime-b-1.0.0.tgz`,
          integrity: await sri(runtimeB),
        },
        {
          name: 'runtime-a',
          version: '1.0.0',
          url: `${registryOrigin}/runtime-a/-/runtime-a-1.0.0.tgz`,
          integrity: await sri(runtimeA),
        },
      ],
      platforms: {
        'darwin-arm64': {
          'runtime-a': ['shared.mjs', 'bin/arm64.mjs'],
          'runtime-b': ['index.mjs'],
        },
        'darwin-x64': {
          'runtime-a': ['shared.mjs', 'bin/x64.mjs'],
          'runtime-b': ['index.mjs'],
        },
      },
    },
    new Map([
      ['runtime-a@1.0.0', await readFile(runtimeA)],
      ['runtime-b@1.0.0', await readFile(runtimeB)],
    ]),
  );
  assert.equal(lock, await readFile(join(fixtureRoot, 'lock-expected.json'), 'utf8'));
});

test('E2 runtime lock: refuses a local archive path', async () => {
  const module = await runtimeLockModule();
  assert.equal(typeof module.buildFixtureRuntimeLock, 'function');
  const { buildFixtureRuntimeLock } = module;
  const archive = join(fixtureRoot, 'lock-input', 'runtime-a-1.0.0.tgz');
  await assert.rejects(
    async () =>
      buildFixtureRuntimeLock(
        {
          packages: [
            {
              name: 'runtime-a',
              version: '1.0.0',
              url: `${registryOrigin}/runtime-a/-/runtime-a-1.0.0.tgz`,
              integrity: await sri(archive),
              archivePath: archive,
            },
          ],
          platforms: { 'darwin-arm64': { 'runtime-a': ['shared.mjs'] }, 'darwin-x64': { 'runtime-a': ['shared.mjs'] } },
        },
        new Map([['runtime-a@1.0.0', await readFile(archive)]]),
      ),
    /RUNTIME_LOCK_INPUT/,
  );
});

test('E2 runtime lock: refuses a claimed verified archive', async () => {
  const module = await runtimeLockModule();
  assert.equal(typeof module.buildFixtureRuntimeLock, 'function');
  const { buildFixtureRuntimeLock } = module;
  const archive = join(fixtureRoot, 'lock-input', 'runtime-a-1.0.0.tgz');
  await assert.rejects(
    async () =>
      buildFixtureRuntimeLock(
        {
          packages: [
            {
              name: 'runtime-a',
              version: '1.0.0',
              url: `${registryOrigin}/runtime-a/-/runtime-a-1.0.0.tgz`,
              integrity: await sri(archive),
              verified: true,
            },
          ],
          platforms: { 'darwin-arm64': { 'runtime-a': ['shared.mjs'] }, 'darwin-x64': { 'runtime-a': ['shared.mjs'] } },
        },
        new Map([['runtime-a@1.0.0', await readFile(archive)]]),
      ),
    /RUNTIME_LOCK_INPUT/,
  );
});

test('E2 runtime acquirer: rejects every noncanonical registry URL spelling before a request', async () => {
  const { fetchLayaReleaseTarball } = await releaseAcquirerModule();
  const integrity = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
  const canonical = registryTarball('runtime-a', '1.0.0');
  const uppercaseOrigin = ['https:/', '/REGISTRY.NPMJS.ORG'].join('');
  for (const url of [
    `${alternateOrigin}/runtime-a/-/runtime-a-1.0.0.tgz`,
    `${uppercaseOrigin}/runtime-a/-/runtime-a-1.0.0.tgz`,
    canonical.replace(registryOrigin, `${registryOrigin}:443`),
    canonical.replace('/runtime-a/-/', '/runtime-a/../runtime-a/-/'),
    `${canonical}#`,
  ]) {
    await assert.rejects(
      () =>
        fetchLayaReleaseTarball(
          {
            name: 'runtime-a',
            version: '1.0.0',
            url,
            integrity,
          },
          async () => Buffer.alloc(0),
        ),
      /RUNTIME_ORIGIN/,
    );
  }
});

test('E2 runtime integrity: rejects noncanonical Base64 before acquisition or parsing', async () => {
  const { fetchLayaReleaseTarball } = await releaseAcquirerModule();
  const { parseRuntimeLock, readPrivateRuntimeClosure } = await runtimeLockModule();
  const archive = join(fixtureRoot, 'lock-input', 'runtime-a-1.0.0.tgz');
  const integrity = await sri(archive);
  const noncanonical = noncanonicalSha512Sri(integrity);
  assert.deepEqual(
    Buffer.from(noncanonical.slice('sha512-'.length), 'base64'),
    Buffer.from(integrity.slice('sha512-'.length), 'base64'),
  );

  let acquisitions = 0;
  await assert.rejects(
    () =>
      fetchLayaReleaseTarball(
        {
          name: 'runtime-a',
          version: '1.0.0',
          url: registryTarball('runtime-a', '1.0.0'),
          integrity: noncanonical,
        },
        async () => {
          acquisitions += 1;
          return readFile(archive);
        },
      ),
    /RUNTIME_SRI/,
  );
  assert.equal(acquisitions, 0);

  const expected = await readFile(join(fixtureRoot, 'lock-expected.json'), 'utf8');
  assert.throws(() => parseRuntimeLock(expected.replace(integrity, noncanonical)), /RUNTIME_SRI/);

  const lockfile = await readFile(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const knownSri = 'sha512-Xwrja8nx9e5o2N1my4DsKCeKpdrnACyr1wtbPxBDgGzKzKyE9kRtBFA8mWldI+RVlD7CBZNWY/wQ2+ydwOR6kQ==';
  assert.throws(
    () => readPrivateRuntimeClosure(lockfile.replace(knownSri, noncanonicalSha512Sri(knownSri))),
    /RUNTIME_LOCKFILE/,
  );
});

test('E2 runtime acquirer: rejects invalid package names and normalised URLs before a request', async () => {
  const { fetchLayaReleaseTarball } = await releaseAcquirerModule();
  const archive = join(fixtureRoot, 'lock-input', 'runtime-a-1.0.0.tgz');
  const integrity = await sri(archive);
  let acquisitions = 0;
  const acquire = async (): Promise<Buffer> => {
    acquisitions += 1;
    return readFile(archive);
  };

  for (const { name, version } of [
    { name: '@scope/../pwn', version: '1.0.0' },
    { name: '@Scope/runtime-a', version: '1.0.0' },
    { name: '@scope/runtime-a/extra', version: '1.0.0' },
    { name: 'runtime-a', version: '1.0.0/../pwn' },
  ]) {
    const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
    await assert.rejects(
      () =>
        fetchLayaReleaseTarball(
          { name, version, url: `${registryOrigin}/${name}/-/${unscoped}-${version}.tgz`, integrity },
          acquire,
        ),
      /RUNTIME_ORIGIN/,
    );
  }
  assert.equal(acquisitions, 0);
});

test('E2 runtime lock: rejects a changed SRI before the archive parser runs', async () => {
  const { buildFixtureRuntimeLock } = await runtimeLockModule();
  const archive = join(fixtureRoot, 'lock-input', 'runtime-a-1.0.0.tgz');
  await assert.rejects(
    async () =>
      buildFixtureRuntimeLock(
        {
          packages: [
            {
              name: 'runtime-a',
              version: '1.0.0',
              url: `${registryOrigin}/runtime-a/-/runtime-a-1.0.0.tgz`,
              integrity:
                'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
            },
          ],
          platforms: { 'darwin-arm64': { 'runtime-a': ['shared.mjs'] }, 'darwin-x64': { 'runtime-a': ['shared.mjs'] } },
        },
        new Map([['runtime-a@1.0.0', await readFile(archive)]]),
      ),
    /RUNTIME_SRI/,
  );
});

test('E2 release runtime lock: refuses an unreviewed caller closure before acquisition', async () => {
  const { buildLayaRuntimeLock, fetchLayaReleaseTarball } = await releaseAcquirerModule();
  const archive = join(fixtureRoot, 'lock-input', 'runtime-a-1.0.0.tgz');
  const integrity = await sri(archive);
  const unreviewed = {
    name: 'runtime-a',
    version: '1.0.0',
    url: registryTarball('runtime-a', '1.0.0'),
    integrity,
  };
  let acquisitions = 0;
  const acquire = async (): Promise<Buffer> => {
    acquisitions += 1;
    return readFile(archive);
  };
  await assert.rejects(() => fetchLayaReleaseTarball(unreviewed, acquire), /RUNTIME_LOCK_INPUT/);
  assert.equal(acquisitions, 0);
  await assert.rejects(
    () =>
      buildLayaRuntimeLock(
        {
          packages: [unreviewed],
          platforms: { 'darwin-arm64': { 'runtime-a': ['shared.mjs'] }, 'darwin-x64': { 'runtime-a': ['shared.mjs'] } },
        },
        acquire,
      ),
    /RUNTIME_EVIDENCE/,
  );
  assert.equal(acquisitions, 0);
});

test('E2 release runtime lock: requires an explicit owner-gated acquirer', async () => {
  const { buildLayaRuntimeLock, fetchLayaReleaseTarball, supplyChainGateAcquirer } = await releaseAcquirerModule();
  const archive = join(fixtureRoot, 'lock-input', 'runtime-a-1.0.0.tgz');
  const unreviewed = {
    name: 'runtime-a',
    version: '1.0.0',
    url: registryTarball('runtime-a', '1.0.0'),
    integrity: await sri(archive),
  };
  const input = {
    packages: [unreviewed],
    platforms: { 'darwin-arm64': { 'runtime-a': ['shared.mjs'] }, 'darwin-x64': { 'runtime-a': ['shared.mjs'] } },
  };

  await assert.rejects(() => fetchLayaReleaseTarball(unreviewed), /RUNTIME_LOCK_INPUT/);
  await assert.rejects(() => buildLayaRuntimeLock(input), /RUNTIME_LOCK_INPUT/);
  assert.equal(typeof supplyChainGateAcquirer, 'function');
  assert.throws(() => supplyChainGateAcquirer({}), /RUNTIME_LOCK_INPUT/);
});

test('E2 runtime lock: rejects duplicate, unsorted, and unknown lock fields', async () => {
  const { parseRuntimeLock } = await runtimeLockModule();
  const expected = await readFile(join(fixtureRoot, 'lock-expected.json'), 'utf8');
  assert.throws(
    () => parseRuntimeLock(expected.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,')),
    /RUNTIME_LOCK_DUPLICATE/,
  );
  assert.throws(
    () => parseRuntimeLock(expected.replace('      "files": {', '      "unknown": true,\n      "files": {')),
    /RUNTIME_LOCK_UNKNOWN/,
  );
  assert.throws(() => parseRuntimeLock(expected.replaceAll('runtime-a', 'runtime-z')), /RUNTIME_LOCK_ORDER/);
});
