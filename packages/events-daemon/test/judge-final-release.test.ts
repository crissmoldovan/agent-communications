import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error The verifier is a repository executable with no declaration file.
import { verifyPhaseEPrerequisites } from '../../../scripts/verify-events-phase-e-prerequisites.mjs';
import { runStrictMutationChild } from './support/strict-mutation-child.ts';

const ROOT = join(import.meta.dirname, '../../..');
const RELEASE_TOOL_PRELOAD = 'test/helpers/release-tool-seal-preload.mjs';
const RELEASE_CHILD_PROCESS_ENTRY_POINTS = Object.freeze([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
] as const);

function releaseToolPreloadUrl(root: string, recordFile: string): string {
  const preload = pathToFileURL(join(root, RELEASE_TOOL_PRELOAD));
  preload.searchParams.set('record', pathToFileURL(recordFile).href);
  return preload.href;
}

async function copiedB3Tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcomms-e13-b3-tree-'));
  // Directory symlinks on every platform, Windows included: through a junction, pnpm's workspace links do not resolve
  // there, and every production module then fails to load. Each points at the real directory, so a tree copied from
  // a mutation tree, whose own node_modules are links, is one link from them too.
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
  await symlink(await realpath(join(ROOT, 'node_modules')), join(root, 'node_modules'), 'dir');
  await symlink(
    await realpath(join(ROOT, 'packages/events-daemon/node_modules')),
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
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: temporary,
    PATH: path,
    npm_config_registry: 'http://127.0.0.1:9/',
    ...(process.platform === 'win32' ? { PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' } : {}),
  };
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      'HOME',
      'PATH',
      'TMPDIR',
      'npm_config_registry',
      ...(process.platform === 'win32' ? ['PATHEXT', 'SystemRoot'] : []),
    ].sort(),
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
        '--import',
        releaseToolPreloadUrl(fixture, hermetic.calls),
        'scripts/release.mjs',
        '--publish',
        '--skip-verify',
      ],
      cwd: fixture,
      env: hermetic.env,
      timeoutMs: 60_000,
    });
    assert.notEqual(release.code, 0, 'direct release refuses the damaged copied B3 tree');
    assert.deepEqual(await recordedReleaseCalls(hermetic.calls), [], 'no release tool runs before the gate refuses');
    assert.match(
      release.output,
      /B3 human-only exception row exists: events-daemon\.judge-key\.rotate/u,
      'the required prerequisite gate refuses before any release tool can run',
    );
    assert.doesNotMatch(
      release.output,
      /cannot load prerequisite production module/u,
      'the copied tree loads every production module, so the damaged row is what refuses it',
    );
    assert.doesNotMatch(
      release.output,
      /Rehearsing a release|Releasing — checking first|npm user:|Publishing /u,
      'the prerequisite refusal is ordered before release preflight or publication',
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
  const releaseSource = await readFile(join(ROOT, 'scripts/release.mjs'), 'utf8');
  assert.equal(
    releaseSource.split("await requirePhaseEGate('Phase-E prerequisite gate', verifyPhaseEPrerequisites);").length - 1,
    1,
    'direct release invokes the prerequisite gate exactly once before preflight',
  );
  assert.equal(
    releaseSource.split("await requirePhaseEGate('Phase-E strict-test gate', verifyPhaseETestManifest);").length - 1,
    1,
    'direct release invokes the strict test gate exactly once before preflight',
  );
});

test('E13 final release: the preload also refuses workers, the low-level spawn and the spawn bindings', async () => {
  const record = join(await mkdtemp(join(tmpdir(), 'e13-seal-lowlevel-')), 'calls.jsonl');
  try {
    const probe = await runStrictMutationChild({
      command: process.execPath,
      args: [
        '--import',
        `${pathToFileURL(join(ROOT, RELEASE_TOOL_PRELOAD)).href}?record=${encodeURIComponent(pathToFileURL(record).href)}`,
        '--input-type=module',
        '--eval',
        `import { ChildProcess } from 'node:child_process';
import { Worker } from 'node:worker_threads';
const attempts = [
  () => new Worker('process.exit(0)', { eval: true }),
  () => new ChildProcess().spawn({ file: process.execPath, args: [process.execPath], stdio: [] }),
  () => process.binding('spawn_sync'),
];
let refused = 0;
for (const attempt of attempts) { try { attempt(); } catch { refused += 1; } }
process.exit(refused === attempts.length ? 0 : 3);`,
      ],
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      timeoutMs: 30_000,
    });
    assert.equal(probe.code, 0, `every low-level way to start a process or worker is refused\n${probe.output}`);
    const lines = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).entryPoint);
    assert.deepEqual(
      lines,
      ['worker_threads.Worker', 'ChildProcess.prototype.spawn', 'process.binding'],
      'each low-level attempt is recorded before it is refused',
    );
  } finally {
    await rm(dirname(record), { recursive: true, force: true });
  }
});

test('E13 final release: the preload intercepts every child_process entry point available to release', async () => {
  const releaseSource = await readFile(join(ROOT, 'scripts/release.mjs'), 'utf8');
  const imports = [...releaseSource.matchAll(/['"](?:node:)?child_process['"]/gu)];
  assert.equal(imports.length, 1, 'release has one statically inspectable child_process import');
  const namedImport = /import\s*\{(?<bindings>[^}]*)\}\s*from\s*['"]node:child_process['"]/u.exec(releaseSource);
  assert.notEqual(namedImport, null, 'release imports child_process through named entry points');
  const releaseEntries = (namedImport?.groups?.bindings ?? '')
    .split(',')
    .map((binding) => binding.trim().split(/\s+as\s+/u)[0])
    .filter(Boolean);
  assert.equal(releaseEntries.length > 0, true, 'release uses at least one child_process entry point');
  for (const entry of releaseEntries) {
    assert.equal(
      RELEASE_CHILD_PROCESS_ENTRY_POINTS.includes(entry as (typeof RELEASE_CHILD_PROCESS_ENTRY_POINTS)[number]),
      true,
      `release child_process entry point is sealed: ${entry}`,
    );
  }

  const root = await mkdtemp(join(tmpdir(), 'agentcomms-release-tool-preload-'));
  try {
    const record = join(root, 'tool-calls');
    const probe = await runStrictMutationChild({
      command: process.execPath,
      args: [
        '--import',
        releaseToolPreloadUrl(ROOT, record),
        '--input-type=module',
        '--eval',
        `import * as childProcess from 'node:child_process';
const entries = ${JSON.stringify(RELEASE_CHILD_PROCESS_ENTRY_POINTS)};
for (const entry of entries) {
  try {
    if (entry === 'fork') childProcess[entry]('example-child.mjs', ['--probe']);
    else if (entry === 'exec' || entry === 'execSync') childProcess[entry]('git status --short');
    else childProcess[entry]('git', ['status', '--short']);
    throw new Error('release tool seal allowed child_process.' + entry);
  } catch (error) {
    if (!String(error).includes('release tool seal refused child_process.' + entry)) throw error;
  }
}`,
      ],
      cwd: ROOT,
      env: process.env,
    });
    assert.equal(probe.code, 0, `the release-tool preload probe completes after every refusal\n${probe.output}`);
    assert.deepEqual(
      await recordedReleaseCalls(record),
      RELEASE_CHILD_PROCESS_ENTRY_POINTS.map((entry) =>
        JSON.stringify({
          entryPoint: entry,
          command:
            entry === 'fork'
              ? 'example-child.mjs'
              : entry === 'exec' || entry === 'execSync'
                ? 'git status --short'
                : 'git',
          arguments:
            entry === 'fork' ? ['--probe'] : entry === 'exec' || entry === 'execSync' ? [] : ['status', '--short'],
        }),
      ),
      'the preload records and refuses every release-capable child_process entry point with its arguments',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

/** A lockfile section's entries, two spaces in: each key, quotes and peer suffixes dropped, with its block's lines. */
function lockfileEntries(lockfile: string, section: string): Map<string, string> {
  const start = lockfile.indexOf(`\n${section}:\n`);
  assert.notEqual(start, -1, `the lockfile has a ${section} section`);
  const lines = lockfile.slice(start + section.length + 3).split('\n');
  const end = lines.findIndex((line) => /^\S/u.test(line));
  const entries = new Map<string, string>();
  let key: string | undefined;
  for (const line of end === -1 ? lines : lines.slice(0, end)) {
    // An entry with nothing under it is written on one line, `'name@version': {}`.
    const matched = /^ {2}(\S.*?):(?: \{\})?$/u.exec(line);
    if (matched?.[1] !== undefined) {
      const quoted = matched[1].replace(/^'(.*)'$/u, '$1');
      key = quoted.includes('(') ? quoted.slice(0, quoted.indexOf('(')) : quoted;
      entries.set(key, '');
    } else if (key !== undefined) entries.set(key, `${entries.get(key)}${line}\n`);
  }
  return entries;
}

test('E13 packaging: the released event packages carry no Laya or native inference runtime dependency', async () => {
  // Phase E2 adds Laya by design: the daemon ships its reviewed manifest, lock and disclosures as files, and the
  // private, never-published `packages/events-laya-runtime` pins the runtime's closure in the lockfile. What phase E
  // proved stays true: neither the root nor a released event package depends on Laya or a native inference runtime,
  // and nothing in the lockfile reaches one except that private importer.
  const inference = /(?:laya|onnxruntime|tensorflow|pytorch|torch-js)/iu;
  for (const file of ['package.json', 'packages/events/package.json', 'packages/events-daemon/package.json']) {
    const manifest = JSON.parse(await readFile(join(ROOT, file), 'utf8')) as Record<string, unknown>;
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'bundledDependencies',
      'bundleDependencies',
    ]) {
      const declared = manifest[field] ?? {};
      for (const name of Array.isArray(declared) ? declared : Object.keys(declared as Record<string, unknown>))
        assert.doesNotMatch(String(name), inference, `${file} has no Laya or native inference dependency`);
    }
  }
  const lockfile = await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const runtimePackage = /(?:@receptron\/laya|onnxruntime(?:-node)?|@huggingface\/tokenizers|@tensorflow|torch-js)/iu;
  for (const [importer, block] of lockfileEntries(lockfile, 'importers'))
    if (importer !== 'packages/events-laya-runtime')
      assert.doesNotMatch(block, runtimePackage, `${importer} resolves neither Laya nor a native inference runtime`);
  // @ts-expect-error The release-only JavaScript command deliberately ships without a TypeScript declaration.
  const { readPrivateRuntimeClosure } = await import('../../../scripts/laya-runtime-lock.mjs');
  const closure = new Set(
    (readPrivateRuntimeClosure(lockfile) as readonly { name: string; version: string }[]).map(
      (entry) => `${entry.name}@${entry.version}`,
    ),
  );
  for (const [snapshot, block] of lockfileEntries(lockfile, 'snapshots'))
    if (runtimePackage.test(block))
      assert.ok(closure.has(snapshot), `${snapshot} depends on a Laya runtime package outside the private closure`);
});
