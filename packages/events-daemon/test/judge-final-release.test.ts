import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error The verifier is a repository executable with no declaration file.
import { verifyPhaseEPrerequisites } from '../../../scripts/verify-events-phase-e-prerequisites.mjs';
import { runStrictMutationChild } from './support/strict-mutation-child.ts';

const ROOT = join(import.meta.dirname, '../../..');

async function copiedB3Tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcomms-e13-b3-tree-'));
  await Promise.all([
    cp(join(ROOT, 'packages/events-daemon/src'), join(root, 'packages/events-daemon/src'), { recursive: true }),
    cp(join(ROOT, 'packages/events-daemon/test/fixtures'), join(root, 'packages/events-daemon/test/fixtures'), {
      recursive: true,
    }),
    cp(
      join(ROOT, 'packages/events-daemon/test/b3-consumer-contract.test.ts'),
      join(root, 'packages/events-daemon/test/b3-consumer-contract.test.ts'),
    ),
    cp(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true }),
    cp(join(ROOT, 'capabilities.json'), join(root, 'capabilities.json')),
    cp(join(ROOT, 'package.json'), join(root, 'package.json')),
  ]);
  await mkdir(join(root, 'packages/events-daemon'), { recursive: true });
  await cp(join(ROOT, 'packages/events-daemon/package.json'), join(root, 'packages/events-daemon/package.json'));
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  await symlink(
    join(ROOT, 'packages/events-daemon/node_modules'),
    join(root, 'packages/events-daemon/node_modules'),
    'dir',
  );
  await writeFile(join(root, 'scripts/packages.mjs'), "export const PACKAGES = []; export const SCOPE = '@fixture';\n");
  return root;
}

async function replaceOnce(root: string, file: string, before: string, after: string): Promise<void> {
  const path = join(root, file);
  const source = await readFile(path, 'utf8');
  assert.equal(source.split(before).length - 1, 1, `${file} contains the exact final-gate mutation target once`);
  await writeFile(path, source.replace(before, after), 'utf8');
}

test('E13 final release: verify and direct release retain both Phase-E gates', async () => {
  const rootPackage = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  for (const script of ['verify', 'preverify:packages', 'release', 'release:publish']) {
    assert.match(
      rootPackage.scripts[script] ?? '',
      /verify:events-phase-e-prerequisites/u,
      `${script} keeps the prerequisite gate`,
    );
    assert.match(
      rootPackage.scripts[script] ?? '',
      /verify:events-phase-e-tests/u,
      `${script} keeps the strict test gate`,
    );
  }
  const releaseSource = await readFile(join(ROOT, 'scripts/release.mjs'), 'utf8');
  assert.equal(
    releaseSource.split("'scripts/verify-events-phase-e-prerequisites.mjs'").length - 1,
    1,
    'direct release invokes the prerequisite gate exactly once before preflight',
  );
  assert.equal(
    releaseSource.split("'scripts/verify-events-phase-e-tests.mjs'").length - 1,
    1,
    'direct release invokes the strict test gate exactly once before preflight',
  );
});

test('E13 final release: the positive B3 tree passes and B3 drift refuses verify and release before preflight', async () => {
  assert.deepEqual(
    await verifyPhaseEPrerequisites({ root: ROOT }),
    [],
    'the integrated positive B3 tree satisfies the Phase-E prerequisite gate without a Phase-C join',
  );

  const fixture = await copiedB3Tree();
  try {
    assert.deepEqual(
      await verifyPhaseEPrerequisites({ root: fixture }),
      [],
      'the exact unmutated copied B3 tree passes before its destructive edit',
    );
    await replaceOnce(
      fixture,
      'capabilities.json',
      'events-daemon.judge-key.rotate',
      'events-daemon.judge-key.removed-by-e13',
    );
    const problems = await verifyPhaseEPrerequisites({ root: fixture });
    assert.equal(
      problems.includes('B3 human-only exception row exists: events-daemon.judge-key.rotate'),
      true,
      `the missing B3 capability row fails the prerequisite gate: ${problems.join('; ')}`,
    );

    assert.equal(
      problems.length > 0,
      true,
      'the required verifier returns a failing result that the statically required verify and release gates cannot bypass',
    );

    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const release = await runStrictMutationChild({
      command: process.execPath,
      args: ['scripts/release.mjs', '--publish', '--skip-verify'],
      cwd: fixture,
      env: environment,
      timeoutMs: 30_000,
    });
    assert.notEqual(release.code, 0, 'direct release refuses the damaged copied B3 tree');
    assert.match(
      release.output,
      /B3 human-only exception row exists: events-daemon\.judge-key\.rotate/u,
      'direct release reports the damaged B3 prerequisite row',
    );
    assert.doesNotMatch(
      release.output,
      /Rehearsing a release|Releasing — checking first|npm user:|Publishing /u,
      'direct release stops before release preflight, registry reads, or publication',
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('E13 packaging: the released event packages carry no Laya or native inference runtime dependency', async () => {
  const manifests = await Promise.all(
    ['package.json', 'packages/events/package.json', 'packages/events-daemon/package.json'].map(async (file) => ({
      file,
      text: await readFile(join(ROOT, file), 'utf8'),
    })),
  );
  for (const manifest of manifests)
    assert.doesNotMatch(
      manifest.text,
      /(?:laya|onnxruntime|tensorflow|pytorch|torch-js)/iu,
      `${manifest.file} has no Laya or native inference dependency`,
    );
  assert.doesNotMatch(
    await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8'),
    /(?:@receptron\/laya|onnxruntime(?:-node)?|@tensorflow|torch-js)/iu,
    'the resolved lockfile has neither Laya nor a native inference runtime',
  );
});
