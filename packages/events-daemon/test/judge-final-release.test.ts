import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error The verifier is a repository executable with no declaration file.
import { verifyPhaseEPrerequisites } from '../../../scripts/verify-events-phase-e-prerequisites.mjs';
import { runStrictMutationChild } from './support/strict-mutation-child.ts';

const ROOT = join(import.meta.dirname, '../../..');

async function copiedB3Tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcomms-e13-b3-tree-'));
  await Promise.all([
    cp(join(ROOT, 'packages/events-daemon/src'), join(root, 'packages/events-daemon/src'), { recursive: true }),
    cp(join(ROOT, 'packages/events-daemon/test'), join(root, 'packages/events-daemon/test'), { recursive: true }),
    cp(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true }),
    cp(join(ROOT, 'test/helpers'), join(root, 'test/helpers'), { recursive: true }),
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

interface HermeticReleaseChild {
  readonly calls: string;
  readonly env: NodeJS.ProcessEnv;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function hermeticReleaseChild(root: string): Promise<HermeticReleaseChild> {
  const sandbox = join(root, '.release-child');
  const home = join(sandbox, 'home');
  const temporary = join(sandbox, 'tmp');
  const path = join(sandbox, 'bin');
  const calls = join(sandbox, 'tool-calls');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(temporary, { recursive: true }),
    mkdir(path, { recursive: true }),
  ]);
  await Promise.all(
    ['git', 'npm', 'pnpm', 'npx'].map(async (tool) => {
      const executable = join(path, tool);
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' ${shellLiteral(tool)} >> ${shellLiteral(calls)}\nexit 97\n`,
        'utf8',
      );
      await chmod(executable, 0o700);
    }),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: temporary,
    PATH: path,
    npm_config_registry: 'http://127.0.0.1:9/',
    ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows' } : {}),
  };
  assert.deepEqual(
    Object.keys(env).sort(),
    ['HOME', 'PATH', 'TMPDIR', 'npm_config_registry', ...(process.platform === 'win32' ? ['SystemRoot'] : [])].sort(),
    'the release child receives only the hermetic environment allowlist',
  );
  return { calls, env };
}

async function recordedReleaseCalls(path: string): Promise<readonly string[]> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter(Boolean);
}

async function replaceOnce(root: string, file: string, before: string, after: string): Promise<void> {
  const path = join(root, file);
  const source = await readFile(path, 'utf8');
  assert.equal(source.split(before).length - 1, 1, `${file} contains the exact final-gate mutation target once`);
  await writeFile(path, source.replace(before, after), 'utf8');
}

test('E13 final release: verify and direct release retain both Phase-E gates', {
  skip:
    process.platform === 'win32' &&
    'the hermetic git/npm/pnpm/npx stand-ins are POSIX shell executables, which Windows cannot spawn without a shell',
}, async () => {
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
  const fixture = await copiedB3Tree();
  try {
    await replaceOnce(
      fixture,
      'capabilities.json',
      'events-daemon.judge-key.rotate',
      'events-daemon.judge-key.removed-by-e13-executed-gate',
    );
    const hermetic = await hermeticReleaseChild(fixture);
    const release = await runStrictMutationChild({
      command: process.execPath,
      args: [
        '--import',
        pathToFileURL(join(fixture, 'test/helpers/loopback-seal-preload.mjs')).href,
        'scripts/release.mjs',
        '--publish',
        '--skip-verify',
      ],
      cwd: fixture,
      env: hermetic.env,
      timeoutMs: 30_000,
    });
    assert.notEqual(release.code, 0, 'direct release refuses the damaged copied B3 tree');
    assert.match(
      release.output,
      /B3 human-only exception row exists: events-daemon\.judge-key\.rotate/u,
      'the required prerequisite gate refuses before any release tool can run',
    );
    assert.doesNotMatch(
      release.output,
      /Rehearsing a release|Releasing — checking first|npm user:|Publishing /u,
      'the prerequisite refusal is ordered before release preflight or publication',
    );
    assert.deepEqual(
      await recordedReleaseCalls(hermetic.calls),
      [],
      'the prerequisite refusal runs before every hermetic git/npm/pnpm/npx stand-in',
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
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
