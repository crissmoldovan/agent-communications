import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expectLayaMutationToFail, loadLayaMutations } from './support/laya-mutants.ts';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const checker = join(repositoryRoot, 'scripts', 'verify-events-phase-e2-tests.mjs');
const runtimeName = '@agentcomms/events-laya-runtime';
const normalInstall = ['pnpm', 'install', '--frozen-lockfile', '--filter', `'!${runtimeName}'`].join(' ');

async function copyCase(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'events-e2-proof-'));
  const files = [
    'package.json',
    'README.md',
    'CONTRIBUTING.md',
    'docs/RELEASING.md',
    '.blocks/post-clone.sh',
    '.claude/skills/release/SKILL.md',
    '.claude/skills/review-pr/SKILL.md',
    '.github/workflows/release.yml',
    'packages/events-daemon/package.json',
    'packages/events-daemon/test/laya-mutations.test.ts',
    'packages/events-daemon/test/laya-scope.test.ts',
    'packages/events-daemon/test/support/laya-mutants.ts',
    'test/helpers/loopback-seal-preload.mjs',
    'scripts/verify-events-phase-e2-tests.mjs',
    'scripts/verify-laya-ci-install.mjs',
    'scripts/release-ci.mjs',
    'packages/events-daemon/test/fixtures/laya/cases/schema-v1.json',
    'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
  ];
  for (const relative of files) {
    const destination = join(root, relative);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repositoryRoot, relative), destination, { recursive: true });
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
    const taskFive = source.replaceAll('task-3', 'task-5').replace('"task": 3', '"task": 5');
    await writeTracked(root, 'packages/events-daemon/test/fixtures/laya/cases/task-5.json', taskFive);
    await writeTracked(root, 'packages/events-daemon/test/fixtures/laya/cases/second-task-5.json', taskFive);
    await expectRejected(root, /duplicate task fragment for task 5/);
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

test('E2 mutation: copied production checker fails only its named oracle', async (context) => {
  for (const mutation of await loadLayaMutations()) {
    const changedLine = await expectLayaMutationToFail(mutation);
    context.diagnostic(`${mutation.id}: ${mutation.source}:${changedLine} -> ${mutation.testName}`);
  }
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
