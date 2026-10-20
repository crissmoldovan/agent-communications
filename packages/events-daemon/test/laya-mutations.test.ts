import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  CARGO_LEG_COMMAND,
  expectEveryLayaMutationToFail,
  expectLayaMutationToFail,
  LAYA_MUTATION_LEGS,
  type LayaMutation,
  layaMutationLeg,
  loadLayaMutations,
  VERIFY_MUTATION_LEGS,
} from './support/laya-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';
import { runStrictMutationChild } from './support/strict-mutation-child.ts';

assertLoopbackSeal();

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const checker = join(repositoryRoot, 'scripts', 'verify-events-phase-e2-tests.mjs');
const runtimeName = '@agentcomms/events-laya-runtime';
const normalInstall = ['pnpm', 'install', '--frozen-lockfile', '--filter', `'!${runtimeName}'`].join(' ');

/**
 * The whole checkout, as Git lists it (tracked, and untracked but not ignored), in a fresh repository whose history
 * holds every file but Task 3's fragment: E2 Task 12's matrix reads the plan, every fragment, test and source, so a
 * case is a complete copy that each test changes in one place.
 */
async function copyCase(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'events-e2-proof-'));
  const listed = (await runGit(repositoryRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean);
  for (const relative of listed) {
    const source = join(repositoryRoot, relative);
    // The repository tracks no symbolic link: one listed here is an installed tree linked into a copy, never a file.
    const info = await lstat(source).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink()) continue;
    const destination = join(root, relative);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  await initialiseCaseHistory(root);
  return root;
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${output}`));
    });
  });
}

async function initialiseCaseHistory(root: string): Promise<void> {
  const taskFragment = 'packages/events-daemon/test/fixtures/laya/cases/task-3.json';
  await runGit(root, ['init', '--quiet']);
  await runGit(root, ['config', 'user.email', 'laya-fixture@example.test']);
  await runGit(root, ['config', 'user.name', 'Laya fixture']);
  await runGit(root, ['add', '--all']);
  await runGit(root, ['rm', '--cached', '--quiet', '--', taskFragment]);
  await runGit(root, ['commit', '--quiet', '-m', 'fixture baseline']);
}

async function commitTaskFragment(root: string, message: string): Promise<void> {
  const taskFragment = 'packages/events-daemon/test/fixtures/laya/cases/task-3.json';
  await runGit(root, ['add', '--', taskFragment]);
  await runGit(root, ['commit', '--quiet', '-m', message]);
}

async function runChecker(
  root: string,
  args: readonly string[] = [],
): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', checker, '--root', root, ...args],
      { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

async function expectRejected(root: string, expected: RegExp): Promise<void> {
  const result = await runChecker(root);
  assert.notEqual(result.code, 0, 'checker accepted the unsafe copied input');
  assert.match(result.output, expected);
}

async function expectAccepted(root: string): Promise<void> {
  const result = await runChecker(root);
  assert.equal(result.code, 0, result.output);
}

async function change(root: string, relative: string, before: string, after: string): Promise<void> {
  const path = join(root, relative);
  const source = await readFile(path, 'utf8');
  assert.ok(source.includes(before), `${relative} does not contain the expected production input`);
  await writeFile(path, source.replace(before, after), 'utf8');
}

function unsafeInstall(...options: readonly string[]): string {
  return ['pnpm', 'install', ...options].join(' ');
}

async function writeTracked(root: string, relative: string, source: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, 'utf8');
  await runGit(root, ['add', '--', relative]);
}

async function makeInstallUnsafe(root: string, relative: string): Promise<void> {
  const source = await readFile(join(root, relative), 'utf8');
  const unfiltered = unsafeInstall('--frozen-lockfile');
  const previous = source.includes(normalInstall) ? normalInstall : unfiltered;
  assert.ok(source.includes(previous), `${relative} does not contain its install instruction`);
  await writeFile(join(root, relative), source.replace(previous, unfiltered), 'utf8');
}

async function withCase(run: (root: string) => Promise<void>): Promise<void> {
  const root = await copyCase();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('E2 mutation: negative workspace filter is mandatory', async () => {
  await withCase(async (root) => {
    await change(root, '.github/workflows/release.yml', normalInstall, unsafeInstall('--frozen-lockfile'));
    await expectRejected(root, new RegExp(`${unsafeInstall()} must exclude @agentcomms/events-laya-runtime`));
  });
});

test('E2 mutation: only the three frozen record locations are excluded from install scanning', async () => {
  await withCase(async (root) => {
    const exclusions = [
      {
        excluded: 'packages/core/test/fixtures/released-0.13.0/core/install-record.mjs',
        adjacent: 'packages/core/test/fixtures/release-notes/install-record.mjs',
      },
      { excluded: 'CHANGELOG.md', adjacent: 'CHANGELOG-install-record.md' },
      {
        excluded: 'docs/superpowers/plans/2026-10-10-install-record.md',
        adjacent: 'docs/superpowers/plans/install-record.md',
      },
    ];
    for (const { excluded, adjacent } of exclusions) {
      await writeTracked(root, excluded, `${unsafeInstall('--frozen-lockfile')}\n`);
      await expectAccepted(root);
      await writeTracked(root, adjacent, `${unsafeInstall('--frozen-lockfile')}\n`);
      await expectRejected(root, new RegExp(adjacent.replaceAll('.', '\\.')));
      await runGit(root, ['rm', '--quiet', '--cached', '--', adjacent]);
      await rm(join(root, adjacent));
    }
  });
});

test('E2 mutation: rejects an unfiltered install in the post-clone setup hook', async () => {
  await withCase(async (root) => {
    await makeInstallUnsafe(root, '.blocks/post-clone.sh');
    await expectRejected(root, /\.blocks\/post-clone\.sh/);
  });
});

test('E2 mutation: rejects an unfiltered install in the release skill', async () => {
  await withCase(async (root) => {
    await makeInstallUnsafe(root, '.claude/skills/release/SKILL.md');
    await expectRejected(root, /\.claude\/skills\/release\/SKILL\.md/);
  });
});

test('E2 mutation: rejects an unfiltered install in the pull-request review skill', async () => {
  await withCase(async (root) => {
    await makeInstallUnsafe(root, '.claude/skills/review-pr/SKILL.md');
    await expectRejected(root, /\.claude\/skills\/review-pr\/SKILL\.md/);
  });
});

async function expectUnsafeInstallSpelling(root: string, name: string, command: string): Promise<void> {
  const file = `instructions/e2-${name.replaceAll(/[^a-z]+/g, '-')}.txt`;
  await writeTracked(root, file, `Run this setup command:\n${command}\n`);
  await expectRejected(root, new RegExp(file.replaceAll('.', '\\.')));
}

test('E2 mutation: rejects a version-pinned pnpm executable in an otherwise unlisted tracked text file', async () => {
  await withCase((root) =>
    expectUnsafeInstallSpelling(
      root,
      'a version-pinned pnpm executable',
      ['pnpm@11.26.0', 'install', '--frozen-lockfile'].join(' '),
    ),
  );
});

test('E2 mutation: rejects options before the install subcommand in an otherwise unlisted tracked text file', async () => {
  await withCase((root) =>
    expectUnsafeInstallSpelling(
      root,
      'options before the install subcommand',
      ['pnpm', '--offline', 'install'].join(' '),
    ),
  );
});

test('E2 mutation: rejects options after the install subcommand in an otherwise unlisted tracked text file', async () => {
  await withCase((root) =>
    expectUnsafeInstallSpelling(
      root,
      'options after the install subcommand',
      ['pnpm', 'install', '--offline'].join(' '),
    ),
  );
});

test('E2 mutation: rejects the short install subcommand in an otherwise unlisted tracked text file', async () => {
  await withCase((root) =>
    expectUnsafeInstallSpelling(root, 'the short install subcommand', ['pnpm', 'i', '--frozen-lockfile'].join(' ')),
  );
});

test('E2 mutation: rejects a backslash-continued install command in an otherwise unlisted tracked text file', async () => {
  await withCase((root) =>
    expectUnsafeInstallSpelling(
      root,
      'a backslash-continued install command',
      ['pnpm \\', '  --offline \\', '  install \\', '  --frozen-lockfile'].join('\n'),
    ),
  );
});

test('E2 mutation: rejects an unfiltered install printed by a copied script', async () => {
  await withCase(async (root) => {
    const releaseCi = await readFile(join(root, 'scripts/release-ci.mjs'), 'utf8');
    await writeFile(
      join(root, 'scripts/release-ci-copy.mjs'),
      `${releaseCi}\nconsole.log(${JSON.stringify(unsafeInstall('--frozen-lockfile'))});\n`,
    );
    await runGit(root, ['add', '--', 'scripts/release-ci-copy.mjs']);
    await expectRejected(root, /scripts\/release-ci-copy\.mjs.*must exclude @agentcomms\/events-laya-runtime/);
  });
});

test('E2 mutation: cold-store assertion is mandatory', async () => {
  await withCase(async (root) => {
    await change(root, 'scripts/verify-laya-ci-install.mjs', 'assertNoRuntimeClosure(store);', 'void store;');
    await expectRejected(root, /must prove the runtime closure is absent/);
  });
});

test('E2 mutation: source-record requirement blocks without coordinator evidence', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"externalSources": []',
      '"externalSources": [{ "id": "runtime-metadata" }]',
    );
    await expectRejected(root, /E2_EXTERNAL_REFERENCE_BLOCKED/);
  });
});

test('E2 mutation: source record requires every reviewed fact', async () => {
  await withCase(async (root) => {
    const url = ['https:/', '/registry.invalid/runtime'].join('');
    const source = JSON.stringify([
      {
        id: 'runtime-metadata',
        url,
        fetchedAt: '2026-10-10T00:00:00.000Z',
        immutable: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        fact: 'runtime metadata',
        reviewer: 'reviewer',
      },
    ]);
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"externalSources": []',
      `"externalSources": ${source}`,
    );
    const record = join(root, 'docs/superpowers/evidence/2026-10-10-e2-external-sources.md');
    await mkdir(dirname(record), { recursive: true });
    await writeFile(record, '# runtime-metadata\n', 'utf8');
    await expectRejected(root, /E2_EXTERNAL_REFERENCE_BLOCKED/);
  });
});

test('E2 mutation: source record rejects a mutable revision', async () => {
  await withCase(async (root) => {
    const url = ['https:/', '/registry.invalid/runtime'].join('');
    const source = JSON.stringify([
      {
        id: 'runtime-metadata',
        url,
        fetchedAt: '2026-10-10T00:00:00.000Z',
        immutable: 'main',
        fact: 'runtime metadata',
        reviewer: 'reviewer',
      },
    ]);
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"externalSources": []',
      `"externalSources": ${source}`,
    );
    const record = join(root, 'docs/superpowers/evidence/2026-10-10-e2-external-sources.md');
    await mkdir(dirname(record), { recursive: true });
    await writeFile(record, '# runtime-metadata\n', 'utf8');
    await expectRejected(root, /E2_EXTERNAL_REFERENCE_BLOCKED/);
  });
});

test('E2 mutation: task fragment ownership is immutable', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"owner": "task-3"',
      '"owner": "other-task"',
    );
    await expectRejected(root, /has no declared owner/);
  });
});

test('E2 mutation: rejects unowned section 5 row', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"section5": [],',
      '"section5": [{ "id": "unowned-section-5", "owner": "nobody" }],',
    );
    await expectRejected(root, /has no declared owner/);
  });
});

test('E2 mutation: rejects unowned traceability row', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"traceability": [',
      '"traceability": [{ "id": "unowned-traceability", "owner": "nobody" },',
    );
    await expectRejected(root, /has no declared owner/);
  });
});

test('E2 mutation: rejects unowned await row', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"awaits": [],',
      '"awaits": [{ "id": "unowned-await", "owner": "nobody" }],',
    );
    await expectRejected(root, /has no declared owner/);
  });
});

test('E2 mutation: rejects duplicate owner', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"owners": [',
      '"owners": [{ "id": "task-3" },',
    );
    await expectRejected(root, /duplicates owner/);
  });
});

test('E2 mutation: rejects a shared mutable case manifest', async () => {
  await withCase(async (root) => {
    await writeFile(join(root, 'packages/events-daemon/test/fixtures/laya/cases/index.json'), '{}\n');
    await expectRejected(root, /shared mutable case manifest/);
  });
});

test('E2 mutation: rejects deleting a completed task fragment from history', async () => {
  await withCase(async (root) => {
    const taskFragment = 'packages/events-daemon/test/fixtures/laya/cases/task-3.json';
    await commitTaskFragment(root, 'add task fragment');
    await runGit(root, ['rm', '--quiet', '--', taskFragment]);
    await runGit(root, ['commit', '--quiet', '-m', 'delete task fragment']);
    await expectRejected(root, /deleted immutable task fragment/);
  });
});

test('E2 mutation: an unmerged task fragment is not immutable in this branch', async () => {
  await withCase(async (root) => {
    const taskFragment = 'packages/events-daemon/test/fixtures/laya/cases/task-3.json';
    const source = await readFile(join(root, taskFragment), 'utf8');
    await runGit(root, ['switch', '--quiet', '-c', 'unmerged-task']);
    await commitTaskFragment(root, 'add task fragment elsewhere');
    await runGit(root, ['switch', '--quiet', '-']);
    await writeTracked(root, taskFragment, source.replace('"section5": [],', '"section5": [ ],'));
    await expectAccepted(root);
  });
});

test('E2 mutation: rejects a task fragment nested beneath the cases directory', async () => {
  await withCase(async (root) => {
    const source = await readFile(join(root, 'packages/events-daemon/test/fixtures/laya/cases/task-3.json'), 'utf8');
    await writeTracked(root, 'packages/events-daemon/test/fixtures/laya/cases/extra/task-3.json', source);
    await expectRejected(root, /must be directly inside the cases directory/);
  });
});

test('E2 mutation: rejects a second file for the same task', async () => {
  await withCase(async (root) => {
    const source = await readFile(join(root, 'packages/events-daemon/test/fixtures/laya/cases/task-3.json'), 'utf8');
    // A task number no fragment has: the copied case is the whole checkout, whose own fragments are frozen.
    const taskLater = source.replaceAll('task-3', 'task-98').replace('"task": 3', '"task": 98');
    await writeTracked(root, 'packages/events-daemon/test/fixtures/laya/cases/task-98.json', taskLater);
    await writeTracked(root, 'packages/events-daemon/test/fixtures/laya/cases/second-task-98.json', taskLater);
    await expectRejected(root, /duplicate task fragment for task 98/);
  });
});

test('E2 mutation: rejects editing a completed task fragment', async () => {
  await withCase(async (root) => {
    await commitTaskFragment(root, 'add task fragment');
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"section5": [],',
      '"section5": [{ "id": "committed-edit", "owner": "task-3" }],',
    );
    await commitTaskFragment(root, 'edit task fragment');
    await expectRejected(root, /differs from its first-added commit/);
  });
});

test('E2 mutation: a shallow checkout must fetch full history before it validates a committed fragment', async () => {
  await withCase(async (root) => {
    await commitTaskFragment(root, 'add task fragment');
    const head = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(root, '.git', 'shallow'), `${head}\n`);
    await expectRejected(root, /shallow clone; fetch full history and retry/);
  });
});

test('E2 mutation: rejects an orphan mutation mapping', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"mutations": [',
      '"mutations": [{ "id": "orphan", "owner": "nobody", "source": "scripts/verify-events-phase-e2-tests.mjs", "testFile": "packages/events-daemon/test/laya-mutations.test.ts", "testName": "missing", "before": "if", "after": "if" },',
    );
    await expectRejected(root, /orphan mutation/);
  });
});

test('E2 mutation: rejects a non-exact test pattern', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"testPattern": "E2 mutation: source-record requirement blocks without coordinator evidence"',
      '"testPattern": ".*"',
    );
    await expectRejected(root, /must equal its exact test name/);
  });
});

test('E2 mutation: loopback preload is mandatory', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/support/laya-mutants.ts',
      "join(root, 'test/helpers/loopback-seal-preload.mjs')",
      "join(root, 'test/helpers/seal-removed.mjs')",
    );
    await expectRejected(root, /must preload the loopback seal/);
  });
});

test('E2 mutation: rejects an external hostname in Laya tests', async () => {
  await withCase(async (root) => {
    const hostname = ['https:/', '/provider.invalid'].join('');
    await change(root, 'packages/events-daemon/test/laya-scope.test.ts', 'repositoryRoot', hostname);
    await expectRejected(root, /external hostname/);
  });
});

test('E2 mutation: rejects raw corpus content in a Laya case', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"externalSources": []',
      '"rawCorpus": "synthetic content is still forbidden", "externalSources": []',
    );
    await expectRejected(root, /raw corpus field/);
  });
});

test('E2 mutation: rejects a test-local ledger', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
      '"externalSources": []',
      '"testLocalLedger": true, "externalSources": []',
    );
    await expectRejected(root, /test-local ledger/);
  });
});

test('E2 mutation: rejects a daemon Laya dependency', async () => {
  await withCase(async (root) => {
    await change(
      root,
      'packages/events-daemon/package.json',
      '"dependencies": {',
      '"dependencies": { "@receptron/laya": "0.1.2",',
    );
    await expectRejected(root, /must not depend on/);
  });
});

test('E2 mutation: rejects a duplicate judge-kind literal', async () => {
  await withCase(async (root) => {
    const target = join(root, 'packages/events-daemon/src/runtime/laya/duplicate.ts');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "export const duplicate = 'laya';\n", { encoding: 'utf8', flag: 'w' });
    await expectRejected(root, /duplicates the lifecycle judge-kind literal/);
  });
});

test('E2 mutation: rejects production use of test-only Laya worker seams', async () => {
  const cases: readonly [string, string, RegExp][] = [
    [
      'test-only boundary import',
      // Joined, so the copied-tree runner does not read this fixture text as a module the test itself imports.
      ['export { createLayaWorkerBoundaryForTest } from', "'./worker-boundary-probe.ts';\n"].join(' '),
      /test-only Laya worker boundary entry/,
    ],
    [
      'sandbox availability spawn seam',
      "sandboxExecAvailable({ platform: 'darwin', architecture: 'arm64', spawnSync: () => ({ status: 0, signal: null }) });\n",
      /sandboxExecAvailable spawnSync seam/,
    ],
    [
      'boundary spawn seam',
      "createLayaWorkerBoundary({ dataDirectory: '/tmp', spawn: forgedSpawn });\n",
      /Laya worker boundary spawn seam/,
    ],
    [
      'boundary listener seam',
      "createLayaWorkerBoundary({ dataDirectory: '/tmp', startListeners: forgedListeners });\n",
      /Laya worker boundary listener seam/,
    ],
  ];
  for (const [name, source, expected] of cases) {
    await withCase(async (root) => {
      await writeTracked(
        root,
        `packages/events-daemon/src/runtime/laya/forged-${name.replaceAll(' ', '-')}.ts`,
        source,
      );
      await expectRejected(root, expected);
    });
  }
});

test('E2 mutation: the five Windows filesystem oracles declare the common Windows skip', async () => {
  const cases = [
    [
      'packages/events-daemon/test/laya-runtime-installer.test.ts',
      'E2 runtime installer: writes owner-only files and directories',
    ],
    ['packages/events-daemon/test/laya-tar.test.ts', 'E2 tar: extracts only listed package regular files'],
    [
      'packages/events-daemon/test/laya-tar.test.ts',
      'E2 tar: refuses whole archive before staging a later malformed header',
    ],
    [
      'packages/events-daemon/test/laya-tar.test.ts',
      'E2 tar: refuses whole archive before staging a later implied-directory collision',
    ],
    ['packages/events-daemon/test/laya-tree-verifier.test.ts', 'E2 tree verifier: reports a changed executable bit'],
  ] as const;
  for (const [file, name] of cases) {
    const source = await readFile(join(repositoryRoot, file), 'utf8');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      source,
      new RegExp(`test\\(\\s*'${escaped}',\\s*\\{\\s*skip: WINDOWS_SKIP,?\\s*\\},`),
      `${file}: ${name}`,
    );
  }
});

test('E2 mutation: rejects a warm-store assumption', async () => {
  await withCase(async (root) => {
    await writeFile(join(root, 'scripts/verify-laya-ci-install.mjs'), 'export const coldStore = false;\n');
    await expectRejected(root, /fresh pnpm store/);
  });
});

test('E2 mutation: runtime workspace is explicitly excluded from ordinary CI', async () => {
  await withCase(async (root) => {
    await change(
      root,
      '.github/workflows/release.yml',
      normalInstall,
      [unsafeInstall('--frozen-lockfile'), '--filter @agentcomms/core'].join(' '),
    );
    assert.match(
      await readFile(join(root, '.github/workflows/release.yml'), 'utf8'),
      new RegExp(`${unsafeInstall('--frozen-lockfile')} --filter @agentcomms/core`),
    );
    await expectRejected(root, new RegExp(`${unsafeInstall()} must exclude @agentcomms/events-laya-runtime`));
  });
});

test('E2 mutation: rejects a skipped production-copy mutant', async () => {
  await withCase(async (root) => {
    await change(root, 'packages/events-daemon/test/support/laya-mutants.ts', 'assert.notEqual(', 'assert.equal(');
    await expectRejected(root, /must fail when a mutant passes/);
  });
});

test('E2 mutation: loads production mutants from every task fragment', async () => {
  const mutations = await loadLayaMutations();
  assert.ok(mutations.some((mutation) => mutation.owner === 'task-3'));
  assert.ok(mutations.some((mutation) => mutation.owner === 'task-5'));
});

test('E2 mutation: a registered production mutant cannot be skipped', async () => {
  const mutants = await import('./support/laya-mutants.ts');
  const mutations = await loadLayaMutations();
  assert.throws(
    () => mutants.assertEveryLayaMutationExecuted(mutations, new Set()),
    /registered production mutant was never executed/,
  );
});

/** A synthetic runner input over files every copied tree of this file carries; it is never registered. */
function runnerProbe(overrides: Partial<LayaMutation>): LayaMutation {
  const testName = overrides.testName ?? 'E2 mutation: loads production mutants from every task fragment';
  return {
    id: 'runner-self-test',
    kind: 'production',
    leg: 'node',
    owner: 'task-6',
    source: 'packages/events-daemon/test/support/laya-mutants.ts',
    testFile: 'packages/events-daemon/test/laya-mutations.test.ts',
    before: "const packageRoot = join(import.meta.dirname, '..', '..');",
    after: "const packageRoot = join(import.meta.dirname, '..', '..'); // an inert edit",
    ...overrides,
    testName,
    testPattern: testName,
  };
}

test('E2 mutation: a copy whose named oracle fails to load is not a kill', async () => {
  // node:test reports a file that cannot load as one failed test under the file's name: `# tests 1` and `# fail 1`.
  await assert.rejects(
    expectLayaMutationToFail(
      runnerProbe({
        after:
          "throw new Error('mutation runner self-test: the oracle cannot load');\nconst packageRoot = join(import.meta.dirname, '..', '..');",
      }),
    ),
    /its named test, not the file, failed/u,
  );
});

test('E2 mutation: an oracle that does not pass unmutated is not a kill', async () => {
  await assert.rejects(
    expectLayaMutationToFail(runnerProbe({ testName: 'E2 mutation: an oracle this file does not have' })),
    /the unmutated copy did not/u,
  );
});

test('E2 mutation: a mutant its oracle accepts is not a kill', async () => {
  await assert.rejects(expectLayaMutationToFail(runnerProbe({})), /unexpectedly accepted mutant/u);
});

// E2 Task 14: an oracle of the built daemon runs against its copy's own build, made again after the edit; an edit the
// daemon cannot be built from runs no oracle at all. (The tarball oracle skips on Windows, as this runner does.)
test('E2 mutation: a built-daemon copy whose edit does not build is not a kill', { skip: WINDOWS_SKIP }, async () => {
  await assert.rejects(
    expectLayaMutationToFail(
      runnerProbe({
        source: 'packages/events-daemon/tsdown.config.ts',
        testFile: 'test/release-packages.test.mjs',
        testName:
          'E2: the daemon tarball carries Laya’s reviewed assets, the placeholder lock and its worker, and no runtime or model',
        before: "index: 'src/index.ts',",
        after: "index: 'src/no-such-entry.ts',",
      }),
    ),
    /the copy's daemon did not build mutated, so nothing ran/u,
  );
});

function mutationAccountingFixture(
  id: string,
  testName = 'E2 runtime installer: writes owner-only files and directories',
) {
  return {
    id,
    kind: 'production' as const,
    leg: 'node' as const,
    owner: 'task-5',
    source: 'packages/events-daemon/src/runtime/laya/tar.ts',
    testFile: 'packages/events-daemon/test/laya-runtime-installer.test.ts',
    testName,
    testPattern: testName,
    before: 'before',
    after: 'after',
  };
}

function skippedBaseline(testName: string, reason: string): string {
  return [
    'TAP version 13',
    `# Subtest: ${testName}`,
    `ok 1 - ${testName} # SKIP ${reason}`,
    '1..1',
    '# tests 1',
    '# suites 0',
    '# pass 0',
    '# fail 0',
    '# cancelled 0',
    '# skipped 1',
    '# todo 0',
  ].join('\n');
}

test('E2 mutation: a Windows baseline with exactly WINDOWS_SKIP is platform-skipped', async () => {
  const mutants = await import('./support/laya-mutants.ts');
  const mutation = mutationAccountingFixture('windows-exact');
  const skipped = new Map([
    [
      mutation.id,
      {
        platform: 'win32' as const,
        baselineOutput: skippedBaseline(
          mutation.testName,
          'B1-G: the local event service does not run on Windows in this release',
        ),
      },
    ],
  ]);
  assert.doesNotThrow(() => mutants.assertEveryLayaMutationExecuted([mutation], new Set(), skipped));
});

test('E2 mutation: a Windows baseline skip with another reason is refused', async () => {
  const mutants = await import('./support/laya-mutants.ts');
  const mutation = mutationAccountingFixture('windows-other-reason');
  const skipped = new Map([
    [mutation.id, { platform: 'win32' as const, baselineOutput: skippedBaseline(mutation.testName, 'other reason') }],
  ]);
  assert.throws(
    () => mutants.assertEveryLayaMutationExecuted([mutation], new Set(), skipped),
    /unapproved platform skip/,
  );
});

test('E2 mutation: a Linux or macOS baseline skip is refused', async () => {
  const mutants = await import('./support/laya-mutants.ts');
  const mutation = mutationAccountingFixture('non-windows-skip');
  for (const platform of ['darwin', 'linux'] as const) {
    const skipped = new Map([
      [
        mutation.id,
        {
          platform,
          baselineOutput: skippedBaseline(
            mutation.testName,
            'B1-G: the local event service does not run on Windows in this release',
          ),
        },
      ],
    ]);
    assert.throws(
      () => mutants.assertEveryLayaMutationExecuted([mutation], new Set(), skipped),
      /unapproved platform skip/,
      platform,
    );
  }
});

test('E2 mutation: a production row cannot be both platform-skipped and executed', async () => {
  const mutants = await import('./support/laya-mutants.ts');
  const mutation = mutationAccountingFixture('both-skipped-and-executed');
  const skipped = new Map([
    [
      mutation.id,
      {
        platform: 'win32' as const,
        baselineOutput: skippedBaseline(
          mutation.testName,
          'B1-G: the local event service does not run on Windows in this release',
        ),
      },
    ],
  ]);
  assert.throws(
    () => mutants.assertEveryLayaMutationExecuted([mutation], new Set([mutation.id]), skipped),
    /both platform-skipped and executed/,
  );
});

test('E2 mutation: the copied boundary-source oracle passes its unmutated baseline before its guard is mutated', async () => {
  const mutation = (await loadLayaMutations()).find(
    (candidate) => candidate.id === 'e2-boundary-source-network-import',
  );
  assert.ok(mutation, 'Task 7 registers the worker-source guard mutation');
  const execution = await expectLayaMutationToFail(mutation);
  assert.match(execution.baselineOutput, /^# tests 1$/m);
  assert.match(execution.baselineOutput, /^# pass 1$/m);
  assert.match(execution.baselineOutput, /^# fail 0$/m);
  assert.ok(execution.changedLine !== null && execution.changedLine > 0);
});

/** The same synthetic runner input for the desktop app's Vitest leg (E2 Task 11): gates.ts and its first test. */
function vitestProbe(overrides: Partial<LayaMutation>): LayaMutation {
  const testName =
    overrides.testName ?? 'what each CLI version supports > a feature is there from the version that brings it';
  return {
    id: 'vitest-runner-self-test',
    kind: 'production',
    leg: 'vitest',
    owner: 'task-11',
    source: 'apps/desktop/src/gates.ts',
    testFile: 'apps/desktop/src/test/gates.test.tsx',
    before: 'export type Feature = keyof typeof GATES;',
    after: 'export type Feature = keyof typeof GATES; // an inert edit',
    ...overrides,
    testName,
    testPattern: testName,
  };
}

test('E2 mutation: a Vitest copy whose named test fails to load is not a kill', async () => {
  // Vitest reports a file that cannot load with no test in it: no named test ran, so nothing failed it.
  await assert.rejects(
    expectLayaMutationToFail(
      vitestProbe({
        after:
          "throw new Error('mutation runner self-test: the oracle cannot load');\nexport type Feature = keyof typeof GATES;",
      }),
    ),
    /its named test, not the file, failed/u,
  );
});

test('E2 mutation: a Vitest oracle that does not pass unmutated is not a kill', async () => {
  await assert.rejects(
    expectLayaMutationToFail(vitestProbe({ testName: 'an oracle the desktop app does not have' })),
    /the unmutated copy did not/u,
  );
});

test('E2 mutation: a Vitest mutant its oracle accepts is not a kill', async () => {
  await assert.rejects(expectLayaMutationToFail(vitestProbe({})), /unexpectedly accepted mutant/u);
});

test('E2 mutation: every registered mutation names a leg a runner executes', async () => {
  assert.deepEqual(LAYA_MUTATION_LEGS, ['node', 'vitest', 'cargo']);
  // pnpm verify runs node and Vitest; desktop.yml runs cargo, with the one command the checker requires there.
  assert.deepEqual(VERIFY_MUTATION_LEGS, ['node', 'vitest']);
  const workflow = await readFile(join(repositoryRoot, '.github/workflows/desktop.yml'), 'utf8');
  assert.ok(workflow.split(/\r?\n/u).some((line) => line.trim() === `run: ${CARGO_LEG_COMMAND}`));
  assert.match(
    await readFile(checker, 'utf8'),
    new RegExp(CARGO_LEG_COMMAND.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
  );
  assert.equal(layaMutationLeg(undefined, 'a fragment row'), 'node');
  for (const leg of ['jest', 'Vitest', 'rust', '', 7, null]) {
    assert.throws(() => layaMutationLeg(leg, 'a fragment row'), /must be one of node, vitest, cargo/u);
  }
  for (const mutation of await loadLayaMutations()) assert.ok(LAYA_MUTATION_LEGS.includes(mutation.leg), mutation.id);
});

// The runner proves each named oracle green in its copied tree before it mutates anything, and Laya is macOS-only in v1:
// several oracles skip on Windows (WINDOWS_SKIP), so there is no baseline to prove there, as for phase E's runners.
// Every registered mutant is credited on macOS and Linux.
test('E2 mutation: copied production checker fails only its named oracle', { skip: WINDOWS_SKIP }, async (context) => {
  for (const { mutation, changedLine } of await expectEveryLayaMutationToFail()) {
    context.diagnostic(`${mutation.id}: ${mutation.source}:${changedLine} -> ${mutation.testName}`);
  }
});

/**
 * One oracle that starts a descendant — as a test process starts a Laya worker — writes the descendant's PID to
 * `pidFile`, then hangs (`hang`), exits at once (`exit`), or exits while the descendant still holds its output (`hold`).
 */
function oracleWithDescendant(mode: 'hang' | 'exit' | 'hold', pidFile: string): readonly string[] {
  const source = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ${
      mode === 'hold' ? "['ignore', 'inherit', 'inherit']" : "'ignore'"
    } });`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));`,
    mode === 'hang' ? 'setInterval(() => {}, 1000);' : 'process.exit(0);',
  ].join('\n');
  return ['-e', source];
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True once `pid` has gone; a SIGKILLed orphan is reaped by init within moments. */
async function goneWithin(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

/** The runner under test must settle within `milliseconds`: one that cannot end its oracle fails here, never hangs. */
function settlesWithin<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`the runner did not settle within ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function withDescendantOracle(
  mode: 'hang' | 'exit' | 'hold',
  run: (oracle: { readonly args: readonly string[]; readonly descendant: () => Promise<number> }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'events-e2-runner-tree-'));
  const pidFile = join(directory, 'descendant.pid');
  try {
    await run({
      args: oracleWithDescendant(mode, pidFile),
      descendant: async () => Number(await readFile(pidFile, 'utf8')),
    });
  } finally {
    // A runner that left the descendant running fails above; this only keeps that failure from leaking it.
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => 'NaN'));
    if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) process.kill(pid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}

test('E2 mutation: a timed-out oracle leaves no process it started running', { skip: WINDOWS_SKIP }, async () => {
  await withDescendantOracle('hang', async (oracle) => {
    await assert.rejects(
      settlesWithin(
        runStrictMutationChild({
          command: process.execPath,
          args: oracle.args,
          cwd: tmpdir(),
          env: process.env,
          timeoutMs: 1_500,
        }),
        8_000,
      ),
      /timed out after 1500ms/u,
    );
    const descendant = await oracle.descendant();
    assert.equal(await goneWithin(descendant, 2_000), true, 'the bound ends the oracle’s whole process tree');
  });
});

test('E2 mutation: an oracle that has ended leaves no process it started running', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withDescendantOracle('exit', async (oracle) => {
    const result = await settlesWithin(
      runStrictMutationChild({
        command: process.execPath,
        args: oracle.args,
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 10_000,
      }),
      15_000,
    );
    assert.equal(result.code, 0, result.output);
    const descendant = await oracle.descendant();
    assert.equal(await goneWithin(descendant, 2_000), true, 'nothing the oracle started outlives it');
  });
});

test('E2 mutation: a process an ended oracle left holding its output does not hold the runner to its bound', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withDescendantOracle('hold', async (oracle) => {
    const started = Date.now();
    const result = await settlesWithin(
      runStrictMutationChild({
        command: process.execPath,
        args: oracle.args,
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 10_000,
      }),
      15_000,
    );
    assert.equal(result.code, 0, result.output);
    assert.ok(Date.now() - started < 5_000, 'the runner ended the leftover and read the oracle’s result at once');
    assert.equal(await goneWithin(await oracle.descendant(), 2_000), true, 'the leftover holding the pipe was ended');
  });
});

test('E2 mutation: a runner that is told to stop ends every oracle it started', { skip: WINDOWS_SKIP }, async () => {
  await withDescendantOracle('hang', async (oracle) => {
    const support = join(repositoryRoot, 'packages/events-daemon/test/support');
    const script = join(await mkdtemp(join(tmpdir(), 'events-e2-runner-stop-')), 'runner.mjs');
    await writeFile(
      script,
      [
        `import { runStrictMutationChild } from ${JSON.stringify(pathToFileURL(join(support, 'strict-mutation-child.ts')).href)};`,
        `import { endOracleGroupsWithThisRunner } from ${JSON.stringify(pathToFileURL(join(support, 'mutation-runner-exit.ts')).href)};`,
        'endOracleGroupsWithThisRunner();',
        `void runStrictMutationChild({ command: process.execPath, args: ${JSON.stringify(oracle.args)}, cwd: ${JSON.stringify(tmpdir())}, env: process.env, timeoutMs: 60_000 });`,
      ].join('\n'),
    );
    const runner = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script],
      {
        stdio: 'ignore',
      },
    );
    try {
      const deadline = Date.now() + 10_000;
      let descendant: number | undefined;
      while (descendant === undefined && Date.now() < deadline) {
        descendant = await oracle.descendant().then(
          (pid) => (Number.isSafeInteger(pid) && pid > 0 ? pid : undefined),
          () => undefined,
        );
        if (descendant === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(descendant !== undefined, 'the oracle started its descendant');
      runner.kill('SIGTERM');
      await new Promise((resolve) => runner.once('exit', resolve));
      assert.equal(await goneWithin(descendant, 2_000), true, 'the stopped runner ended its oracle’s whole tree');
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      await rm(dirname(script), { recursive: true, force: true });
    }
  });
});

test('E2 mutation: cold-store self-test holds the exact normal install command', async () => {
  const result = await new Promise<{ readonly code: number | null; readonly output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/verify-laya-ci-install.mjs', '--self-test'], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
});

// ------------------------------------------------------------------------------------------------ E2 Task 12

/** Appends `text` to a copied file, or replaces `before` in it, and returns the copied file's path. */
async function amend(
  root: string,
  relative: string,
  edit: string | { readonly before: string; readonly after: string },
) {
  const path = join(root, relative);
  const source = await readFile(path, 'utf8');
  if (typeof edit === 'string') await writeFile(path, `${source}\n${edit}\n`, 'utf8');
  else {
    assert.ok(source.includes(edit.before), `${relative} does not contain ${JSON.stringify(edit.before)}`);
    await writeFile(path, source.replace(edit.before, edit.after), 'utf8');
  }
}

const LAYA_SOURCE = 'packages/events-daemon/src/runtime/laya';

test('E2 static boundary: a network built-in imported outside the boundary probe is refused', async () => {
  await withCase(async (root) => {
    await amend(root, `${LAYA_SOURCE}/fetcher.ts`, "import { connect as leak } from 'node:net';\nvoid leak;");
    await expectRejected(root, /fetcher\.ts imports a network built-in; only the boundary probe may/);
  });
});

test('E2 static boundary: fetch or an HTTP request outside the probe and the release acquirer is refused', async () => {
  await withCase(async (root) => {
    await amend(root, `${LAYA_SOURCE}/manager.ts`, "export const leak = () => fetch('http://127.0.0.1/');");
    await expectRejected(root, /manager\.ts calls fetch; only the boundary probe's one loopback attempt may/);
  });
  await withCase(async (root) => {
    await amend(root, 'scripts/laya-runtime-lock.mjs', "import { request as leak } from 'node:https';\nvoid leak;");
    await expectRejected(
      root,
      /laya-runtime-lock\.mjs makes an HTTP request; only the release-only raw-tarball acquirer may/,
    );
  });
});

test('E2 static boundary: a shell or another program run from a Laya module is refused', async () => {
  await withCase(async (root) => {
    await amend(
      root,
      `${LAYA_SOURCE}/tar.ts`,
      "import { execSync } from 'node:child_process';\nexport const run = () => execSync('true');",
    );
    await expectRejected(
      root,
      /tar\.ts imports node:child_process; only the availability probe and the sandbox launcher may/,
    );
  });
  await withCase(async (root) => {
    await amend(root, `${LAYA_SOURCE}/worker-boundary-probe.ts`, { before: 'shell: false', after: 'shell: true' });
    await expectRejected(root, /worker-boundary-probe\.ts runs a shell or another program/);
  });
});

test('E2 static boundary: a package manager named in a Laya module is refused', async () => {
  await withCase(async (root) => {
    await amend(root, `${LAYA_SOURCE}/runtime-installer.ts`, "export const installer = 'npm';");
    await expectRejected(root, /runtime-installer\.ts names a package manager/);
  });
});

test('E2 static boundary: a Laya test that does not assert the loopback seal is refused', async () => {
  await withCase(async (root) => {
    await amend(root, 'packages/events-daemon/test/laya-tar.test.ts', {
      before: '\nassertLoopbackSeal();\n',
      after: '\n',
    });
    await expectRejected(root, /laya-tar\.test\.ts does not assert the loopback seal at load/);
  });
});

test('E2 static boundary: a Laya template id spelled outside templates.ts is refused', async () => {
  await withCase(async (root) => {
    await amend(root, `${LAYA_SOURCE}/worker-supervisor.ts`, "export const template = 'laya-noul-v1';");
    await expectRejected(root, /worker-supervisor\.ts spells a Laya template id; templates\.ts owns that vocabulary/);
  });
});

test('E2 static boundary: production source that names a test worker is refused', async () => {
  await withCase(async (root) => {
    await amend(
      root,
      `${LAYA_SOURCE}/worker-supervisor.ts`,
      "export const entry = '../../../test/support/laya-worker-standin.ts';",
    );
    await expectRejected(
      root,
      /worker-supervisor\.ts names a test worker; production launches only the shipped worker entry/,
    );
  });
});

test('E2 static boundary: only the owner’s laya test seam may hand the Laya supervisor a worker start', async () => {
  // E2 Task 13's pass-through, as the owner carries it since Task 13 joined: the option, and the line handing it on.
  const passThrough =
    '  const layaWorker = new LayaWorkerSupervisor({ artifacts: layaArtifacts, startWorker: options.laya?.startWorker });';
  const ownerSeam = async (root: string, start: string) => {
    await amend(root, 'packages/events-daemon/src/runtime/owner.ts', {
      before: passThrough,
      after: passThrough.replace('startWorker: options.laya?.startWorker', `startWorker: ${start}`),
    });
  };
  await withCase(async (root) => {
    const owner = await readFile(join(root, 'packages/events-daemon/src/runtime/owner.ts'), 'utf8');
    assert.ok(owner.includes('        readonly startWorker?: LayaWorkerStart | undefined;\n'), 'the owner’s option');
    assert.ok(owner.includes(passThrough), 'and its one pass-through');
    await expectAccepted(root);
  });
  await withCase(async (root) => {
    await amend(
      root,
      'packages/events-daemon/src/runtime/judge-test.ts',
      'export const forged = { startWorker: undefined };',
    );
    await expectRejected(
      root,
      /judge-test\.ts hands the Laya supervisor a worker start; only the owner's laya test seam/,
    );
  });
  await withCase(async (root) => {
    await ownerSeam(root, 'forgedStart');
    await expectRejected(root, /owner\.ts hands the Laya supervisor a worker start; only the owner's laya test seam/);
  });
});

test('E2 static boundary: any file that imports the Laya runtime or its private package is refused', async () => {
  await withCase(async (root) => {
    await writeTracked(root, 'scripts/laya-load-runtime.mjs', "import '@receptron/laya';\n");
    await expectRejected(root, /laya-load-runtime\.mjs imports @receptron\/laya/);
  });
});

test('E2 static boundary: a Laya gate workflow another event or an input can start is refused', async () => {
  await withCase(async (root) => {
    await amend(root, '.github/workflows/laya-quality-gate.yml', {
      before: 'on:\n  workflow_dispatch:\n',
      after: 'on:\n  workflow_dispatch:\n  pull_request:\n',
    });
    await expectRejected(root, /the Laya gate workflow must start only by hand, with no input/);
  });
});

test('E2 static boundary: another workflow that names the owner’s gate runner is refused', async () => {
  await withCase(async (root) => {
    await amend(root, '.github/workflows/release.yml', '# a job could ask for the agentcomms-laya-gate runner');
    await expectRejected(root, /release\.yml names the owner's Laya gate runner, its inputs or its scripts/);
  });
});

test('E2 static boundary: a Laya gate step before the boundary run that reads the corpus is refused', async () => {
  await withCase(async (root) => {
    await amend(root, '.github/workflows/laya-quality-gate.yml', {
      before: '      - name: the real-Mac boundary run\n',
      after:
        '      - name: an early look at the corpus\n        run: ls "$AGENTCOMMS_LAYA_GATE_CORPUS"\n      - name: the real-Mac boundary run\n',
    });
    await expectRejected(root, /the Laya gate reads the corpus in one step, the quality run, after the boundary run/);
  });
});

test('E2 static boundary: Laya state keyed on a raw identity is refused', async () => {
  await withCase(async (root) => {
    await amend(
      root,
      `${LAYA_SOURCE}/manager.ts`,
      "export const raw = (db: { prepare(sql: string): unknown }) => db.prepare('SELECT state FROM laya_models WHERE account_id = ?');",
    );
    await expectRejected(root, /manager\.ts keys Laya state on a raw identity/);
  });
});

test('E2 static boundary: a desktop app that calls a third Laya operation is refused', async () => {
  await withCase(async (root) => {
    await amend(root, 'apps/desktop/src/ipc.ts', {
      before: "  | { kind: 'eventsJudgeKindDisable' };",
      after: "  | { kind: 'eventsJudgeKindDisable' }\n  | { kind: 'eventsJudgeKindEnable' };",
    });
    await expectRejected(root, /the desktop app calls exactly two Laya operations: status and disable/);
  });
});

test('E2 mutation: the release workflow installs with exactly the ordinary command', async () => {
  await withCase(async (root) => {
    await change(root, '.github/workflows/release.yml', normalInstall, `${normalInstall} --prefer-offline`);
    await expectRejected(root, /ordinary CI install must be exactly/);
  });
});

test('E2 mutation: pnpm verify runs the E2 structural checker', async () => {
  await withCase(async (root) => {
    await change(root, 'package.json', 'pnpm verify:events-phase-e2 && ', '');
    await expectRejected(root, /pnpm verify must run the E2 structural checker/);
  });
});

/**
 * A later task's fragment, uncommitted in the copied case: one fixture row it covers with an existing red mutant, and
 * whatever rows and matrix entries a test adds. Task 12's matrix covers every earlier row already.
 */
async function laterFragment(
  root: string,
  overrides: { readonly section5?: unknown[]; readonly matrix?: unknown[]; readonly asyncLedger?: unknown[] },
): Promise<void> {
  const own = {
    row: 'fixture/task-99.json',
    owner: 'task-99',
    test: 'E2 mutation: an oracle that has ended leaves no process it started running',
    mutation: 'e2-t12-runner-group-signalled',
  };
  const fragment = {
    schemaVersion: 1,
    task: 99,
    owners: [{ id: 'task-99' }],
    section5: overrides.section5 ?? [],
    traceability: [],
    awaits: [],
    fixtures: [{ path: 'task-99.json', owner: 'task-99' }],
    externalSources: [],
    mutations: [],
    matrix: [own, ...(overrides.matrix ?? [])],
    ...(overrides.asyncLedger === undefined ? {} : { asyncLedger: overrides.asyncLedger }),
  };
  await writeFile(
    join(root, 'packages/events-daemon/test/fixtures/laya/cases/task-99.json'),
    `${JSON.stringify(fragment, null, 2)}\n`,
  );
}

const T99_ROW = {
  id: 'e2-t99-row',
  owner: 'task-99',
  test: 'E2 mutation: a timed-out oracle leaves no process it started running',
};

test('E2 matrix: a later fragment’s fully covered row is accepted', async () => {
  await withCase(async (root) => {
    await laterFragment(root, {
      section5: [T99_ROW],
      matrix: [
        {
          row: 'section5/task-99/e2-t99-row',
          owner: 'task-99',
          test: T99_ROW.test,
          mutation: 'e2-t12-runner-own-group',
        },
      ],
    });
    await expectAccepted(root);
  });
});

test('E2 matrix: a row with no owner and red mutant is refused', async () => {
  await withCase(async (root) => {
    await laterFragment(root, { section5: [T99_ROW] });
    await expectRejected(root, /matrix row "section5\/task-99\/e2-t99-row" has no owner and red mutant/);
  });
});

test('E2 matrix: a row two entries claim is refused', async () => {
  await withCase(async (root) => {
    await laterFragment(root, {
      matrix: [
        {
          row: 'fixture/task-99.json',
          owner: 'task-99',
          test: 'E2 mutation: a timed-out oracle leaves no process it started running',
          mutation: 'e2-t12-runner-own-group',
        },
      ],
    });
    await expectRejected(root, /matrix row "fixture\/task-99\.json" has 2 entries; exactly one owns it/);
  });
});

test('E2 matrix: an entry whose red mutant its named test does not kill is refused', async () => {
  await withCase(async (root) => {
    await laterFragment(root, {
      section5: [T99_ROW],
      matrix: [
        {
          row: 'section5/task-99/e2-t99-row',
          owner: 'task-99',
          test: T99_ROW.test,
          mutation: 'e2-t12-runner-group-signalled',
        },
      ],
    });
    await expectRejected(
      root,
      /mutation "e2-t12-runner-group-signalled" is killed by "E2 mutation: an oracle that has ended/,
    );
  });
});

test('E2 matrix: an entry that names another owner is refused', async () => {
  await withCase(async (root) => {
    await laterFragment(root, {
      section5: [T99_ROW],
      matrix: [
        {
          row: 'section5/task-99/e2-t99-row',
          owner: 'task-3',
          test: T99_ROW.test,
          mutation: 'e2-t12-runner-own-group',
        },
      ],
    });
    await expectRejected(root, /names owner "task-3"; this row's owner is one of task-99/);
  });
});

test('E2 matrix: an entry for a row this repository does not have is refused', async () => {
  await withCase(async (root) => {
    await laterFragment(root, {
      matrix: [
        {
          row: 'section5/task-99/no-such-row',
          owner: 'task-99',
          test: T99_ROW.test,
          mutation: 'e2-t12-runner-own-group',
        },
      ],
    });
    await expectRejected(root, /matrix entry "section5\/task-99\/no-such-row" names no row this repository has/);
  });
});

test('E2 matrix: a row whose test no file declares needs its correction named, and a declared one cannot be renamed', async () => {
  const stale = { ...T99_ROW, test: 'E2 mutation: a test this repository never declared' };
  await withCase(async (root) => {
    await laterFragment(root, {
      section5: [stale],
      matrix: [
        {
          row: 'section5/task-99/e2-t99-row',
          owner: 'task-99',
          test: T99_ROW.test,
          mutation: 'e2-t12-runner-own-group',
        },
      ],
    });
    await expectRejected(root, /but its row names "E2 mutation: a test this repository never declared"/);
  });
  await withCase(async (root) => {
    await laterFragment(root, {
      section5: [stale],
      matrix: [
        {
          row: 'section5/task-99/e2-t99-row',
          owner: 'task-99',
          test: T99_ROW.test,
          mutation: 'e2-t12-runner-own-group',
          staleRowTest: true,
        },
      ],
    });
    await expectAccepted(root);
  });
  await withCase(async (root) => {
    await laterFragment(root, {
      section5: [{ ...T99_ROW, test: 'E2 mutation: an oracle that has ended leaves no process it started running' }],
      matrix: [
        {
          row: 'section5/task-99/e2-t99-row',
          owner: 'task-99',
          test: T99_ROW.test,
          mutation: 'e2-t12-runner-own-group',
          staleRowTest: true,
        },
      ],
    });
    await expectRejected(root, /but its row names "E2 mutation: an oracle that has ended/);
  });
});

test('E2 matrix: an entry whose test no file declares is refused', async () => {
  await withCase(async (root) => {
    await laterFragment(root, {
      section5: [T99_ROW],
      matrix: [
        {
          row: 'section5/task-99/e2-t99-row',
          owner: 'task-99',
          test: 'E2 mutation: not a declared test',
          mutation: 'e2-t12-runner-own-group',
        },
      ],
    });
    await expectRejected(root, /names test "E2 mutation: not a declared test", which no file declares/);
  });
});

test('E2 await ledger: an async Laya function not in the ledger is refused', async () => {
  await withCase(async (root) => {
    await amend(root, `${LAYA_SOURCE}/tree-verifier.ts`, 'export async function unledgered(): Promise<void> {}');
    await expectRejected(root, /async Laya function tree-verifier\.ts#unledgered is not in the E2 await ledger/);
  });
});

test('E2 await ledger: a second async function of a ledgered name is refused until it is reviewed', async () => {
  await withCase(async (root) => {
    await amend(root, `${LAYA_SOURCE}/tree-verifier.ts`, 'export const again = { async sha256(): Promise<void> {} };');
    await expectRejected(root, /counts 1 async tree-verifier\.ts#sha256; the source has 2: review the new one/);
  });
});

test('E2 static boundary: the boundary probe starts no process beyond the launcher and its one refused spawn attempt', async () => {
  const probe = `${LAYA_SOURCE}/worker-boundary-probe.ts`;
  // The apostrophe is matched as any character: the checker's import scanner reads quotes, not regular expressions.
  const refused = /worker-boundary-probe\.ts starts a process beyond the sandbox launcher and the probe.s one refused/;
  for (const evasion of [
    "export const open = () => spawn('/usr/bin/open', ['/Applications']);",
    "import * as childProcess from 'node:child_process';\nexport const copy = () => childProcess.spawn('/usr/bin/pbcopy');",
    "import { spawnSync as run } from 'node:child_process';\nvoid run;",
    "const start = spawn;\nexport const script = () => start('/usr/bin/osascript');",
  ]) {
    await withCase(async (root) => {
      await amend(root, probe, evasion);
      await expectRejected(root, refused);
    });
  }
});

test("E2 static boundary: the release's gate-run check makes its one GitHub API request, and nothing else in it does", async () => {
  await withCase(async (root) => {
    await amend(root, 'scripts/verify-laya-gate-runs.mjs', "export const again = () => fetch('http://127.0.0.1/');");
    await expectRejected(root, /verify-laya-gate-runs\.mjs calls fetch more than once; the gate-run check makes/);
  });
  await withCase(async (root) => {
    await amend(root, 'scripts/verify-laya-gate-runs.mjs', "import { request as leak } from 'node:https';\nvoid leak;");
    await expectRejected(
      root,
      /verify-laya-gate-runs\.mjs makes an HTTP request; only the release-only raw-tarball acquirer may/,
    );
  });
});
