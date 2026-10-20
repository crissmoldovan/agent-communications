import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
// @ts-expect-error The packed consumer check is executable ESM, copied alone into a consumer, without a declaration file.
import { packedWorkerImports } from './consumer-check.mjs';

assertLoopbackSeal();

/*
 * E2 review round 1 (B11): the packed daemon's consumer check must read the whole module graph the built Laya worker
 * loads, and the daemon's own suite must run every one of its test files.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** A built `dist/` of the test's own: each file path to its text. */
async function plantedDist(files: Readonly<Record<string, string>>): Promise<string> {
  const dist = await mkdtemp(join(tmpdir(), 'events-e2-packed-worker-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dist, path)), { recursive: true });
    await writeFile(join(dist, path), text);
  }
  return dist;
}

/**
 * A specifier quoted for planted module text. Quoting it here keeps this file's own text free of import-shaped
 * specifiers, which the copied-tree mutation runner would follow as this file's imports.
 */
const q = (specifier: string): string => JSON.stringify(specifier);

async function importsOf(files: Readonly<Record<string, string>>) {
  const dist = await plantedDist(files);
  try {
    return (await packedWorkerImports(dist)) as {
      readonly chunks: readonly string[];
      readonly refused: readonly string[];
    };
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
}

test('E2 packed consumer: the Laya worker check walks every chunk the worker imports, bare imports included', async () => {
  // A worker that imports only Node built-ins and its own chunks, each of which does the same, passes.
  assert.deepEqual(
    await importsOf({
      'laya-worker.mjs': `import { spawn } from ${q('node:child_process')};\nimport { a } from ${q('./chunk-a.mjs')};\n`,
      'chunk-a.mjs': `import${q('node:fs')};export*from${q('./nested/chunk-b.mjs')};export const a=1;\n`,
      'nested/chunk-b.mjs': `const later=()=>import(${q('../chunk-c.mjs')});export{later};\n`,
      'chunk-c.mjs': 'export const c = 3;\n',
    }),
    { chunks: ['chunk-a.mjs', 'chunk-c.mjs', 'laya-worker.mjs', 'nested/chunk-b.mjs'], refused: [] },
  );
  // Whatever chunk loads it, and however: the runtime, ONNX Runtime and the tokenizer never load in the packed worker.
  for (const [files, refused] of [
    [
      { 'laya-worker.mjs': `import ${q('./chunk-a.mjs')};\n`, 'chunk-a.mjs': `import ${q('onnxruntime-node')};\n` },
      'onnxruntime-node',
    ],
    [
      {
        'laya-worker.mjs': `export * from ${q('./chunk-a.mjs')};\n`,
        'chunk-a.mjs': `import{Laya}from${q('@receptron/laya')};\n`,
      },
      '@receptron/laya',
    ],
    [
      {
        'laya-worker.mjs': `const load = () => import(${q('./chunk-a.mjs')});\n`,
        'chunk-a.mjs': `const tokenizers = require(${q('@huggingface/tokenizers')});\n`,
      },
      '@huggingface/tokenizers',
    ],
    [{ 'laya-worker.mjs': `import ${q('../outside.mjs')};\n` }, '../outside.mjs'],
  ] as const) {
    const result = await importsOf(files);
    assert.deepEqual(result.refused, [refused], JSON.stringify(files));
  }
  // The daemon's own build, where there is one: its worker passes.
  const dist = join(packageRoot, 'dist');
  if (existsSync(join(dist, 'laya-worker.mjs'))) {
    const built = (await packedWorkerImports(dist)) as { readonly chunks: readonly string[]; readonly refused: [] };
    assert.deepEqual(built.refused, [], 'the built worker loads only Node built-ins and its own chunks');
    assert.ok(built.chunks.includes('laya-worker.mjs'));
  }
});

test('E2 runtime package: the daemon suite runs every test file, the runtime package test included', async () => {
  const script = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).scripts.test as string;
  const runs = script
    .slice(script.indexOf(' --test ') + ' --test '.length)
    .split(/\s+/u)
    .filter(Boolean);
  const globRegExp = (glob: string) =>
    new RegExp(
      `^${glob
        .replaceAll('"', '')
        .split('**/')
        .map((part) =>
          part
            .split('*')
            .map((text) => text.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
            .join('[^/]*'),
        )
        .join('(?:.*/)?')}$`,
      'u',
    );
  const patterns = runs.map(globRegExp);
  // release.yml's old-node job runs this one by name, under an older Node, and nothing else may.
  const release = await readFile(join(packageRoot, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(release, /packages\/events-daemon\/test\/old-node\.test\.mjs/u);
  const files = readdirSync(join(packageRoot, 'test'), { recursive: true })
    .map((entry) => `test/${String(entry).replaceAll('\\', '/')}`)
    .filter((path) => /\.test\.(?:ts|mjs)$/u.test(path) && path !== 'test/old-node.test.mjs');
  assert.ok(files.includes('test/laya-runtime-package.test.mjs'));
  for (const file of files)
    assert.ok(
      patterns.some((pattern) => pattern.test(file)),
      `${file} is not run by the daemon's test script: ${script}`,
    );
});
