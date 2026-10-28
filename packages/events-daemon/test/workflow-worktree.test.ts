import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFlow, type FlowDocumentV1, type FlowStep } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { createGitRunner, type GitRunner } from '../src/runtime/git.ts';
import { readProject } from '../src/runtime/projects.ts';
import {
  branchOf,
  createWorktreeExecutor,
  foldBranch,
  type WorktreeStepDeps,
} from '../src/runtime/workflow/steps/worktree.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome } from './support/stand-ins.ts';
import { OWNER_EXAMPLE, STEP_CONTEXT_NOW, stepContext } from './support/step-context.ts';

/*
 * A worktree per run (workflows design §6.6, W14), with the real `git` binary over temporary repositories in a stand-in
 * home: git runs through the git runner (no shell, no GIT_*, hooks off), each repository is the test's own, and the
 * allowed roots are the stand-in home's work folder.
 */

interface Tree {
  readonly root: string;
  readonly work: string;
  readonly checkout: string;
  readonly env: NodeJS.ProcessEnv;
  readonly store: EventDatabase;
  readonly git: GitRunner;
  readonly deps: WorktreeStepDeps;
  readonly rule: CanonicalFullRuleDocument & { readonly flow: FlowDocumentV1 };
}

function setupGit(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

async function withTree(
  work: (tree: Tree) => Promise<void>,
  options: { readonly worktreeRoot?: (tree: { work: string; checkout: string }) => string | null } = {},
): Promise<void> {
  const root = await realpath(await shortTempDir('aev-flow-tree-'));
  const { homeDirectory } = await standInHome(root);
  const workFolder = join(homeDirectory, 'work');
  const checkout = join(workFolder, 'acme-site');
  mkdirSync(checkout, { recursive: true });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homeDirectory, GIT_CONFIG_NOSYSTEM: '1' };
  setupGit(env, checkout, '-c', 'core.hooksPath=/dev/null', 'init', '-q', '-b', 'main');
  setupGit(env, checkout, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'init');
  setupGit(env, checkout, 'remote', 'add', 'origin', 'https://github.com/example/acme-site.git');
  const worktreeRoot = options.worktreeRoot?.({ work: workFolder, checkout }) ?? null;
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  try {
    store.database
      .prepare(
        "INSERT INTO projects (id, name, repo, created_at, updated_at) VALUES ('acme-site', 'acme-site', 'github.com/example/acme-site', 1, 1)",
      )
      .run();
    store.database
      .prepare(
        "INSERT INTO project_folders (folder, project_id, kind, default_branch, worktree_root) VALUES (?, 'acme-site', 'checkout', 'main', ?)",
      )
      .run(checkout, worktreeRoot);
    const route = OWNER_EXAMPLE.flow.steps.route as Extract<FlowStep, { kind: 'route' }>;
    const rule = {
      ...OWNER_EXAMPLE,
      flow: {
        ...OWNER_EXAMPLE.flow,
        steps: {
          ...OWNER_EXAMPLE.flow.steps,
          route: {
            ...route,
            candidates: [{ projectId: 'acme-site', name: 'acme-site', folders: [checkout], worktreeRoot }],
          },
        },
      },
    } as CanonicalFullRuleDocument & { readonly flow: FlowDocumentV1 };
    const git = createGitRunner({ env: { PATH: env.PATH, HOME: homeDirectory } });
    const deps: WorktreeStepDeps = {
      store,
      git,
      project: (projectId) => readProject(store.database, projectId),
      sessionRoots: async () => [workFolder],
      deniedFolders: () => [join(root, 'state')],
    };
    await work({ root, work: workFolder, checkout, env, store, git, deps, rule });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const OUTPUTS = {
  route: { project: 'acme-site', projectName: 'acme-site', reason: 'judge', score: 0.9, profileHash: 'x' },
  issue: {
    delivery: 'd-1',
    issue: { id: 'i-1', identifier: 'ACME-123', url: 'https://linear.app/example/issue/ACME-123' },
  },
};

function rows(store: EventDatabase) {
  return store.database
    .prepare(
      'SELECT run_id, step_id, project_id, checkout, path, branch, state, reason FROM workflow_worktrees ORDER BY created_at, run_id',
    )
    .all()
    .map((row) => ({ ...row }));
}

function listed(tree: Tree): string {
  return setupGit(tree.env, tree.checkout, 'worktree', 'list', '--porcelain');
}

test('a worktree at <root>/<branch slug> on ac/acme-123, recorded before git runs', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTree(async (tree) => {
    const seenAtAdd: unknown[] = [];
    const watching: GitRunner = {
      run: async (args, cwd) => {
        if (args[0] === 'worktree' && args[1] === 'add') seenAtAdd.push(rows(tree.store));
        return tree.git.run(args, cwd);
      },
    };
    const ctx = stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS });
    const path = join(`${tree.checkout}-wt`, 'ac-acme-123');
    const result = await createWorktreeExecutor({ ...tree.deps, git: watching }).run(ctx);
    assert.deepEqual(result, {
      kind: 'settled',
      outcome: 'made',
      output: { branch: 'ac/acme-123', path, refusal: null },
    });
    assert.deepEqual(seenAtAdd, [
      [
        {
          run_id: ctx.run.id,
          step_id: 'tree',
          project_id: 'acme-site',
          checkout: tree.checkout,
          path,
          branch: 'ac/acme-123',
          state: 'recording',
          reason: null,
        },
      ],
    ]);
    assert.equal(rows(tree.store)[0]?.state, 'made');
    assert.match(listed(tree), new RegExp(`worktree ${path}\\nHEAD [0-9a-f]+\\nbranch refs/heads/ac/acme-123`, 'u'));
    assert.deepEqual(ctx.charged, ['worktree']);
    // Its run ends: with cleanup keep, the worktree stays.
    await createWorktreeExecutor(tree.deps).finish?.(ctx, 'done');
    assert.ok(existsSync(path));
  });
});

test('a repository whose core.hooksPath hook writes a marker never runs it', { skip: WINDOWS_SKIP }, async () => {
  await withTree(async (tree) => {
    const hooks = join(tree.checkout, '.githooks');
    const marker = join(tree.root, 'hook-ran');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(join(hooks, 'post-checkout'), 0o755);
    setupGit(tree.env, tree.checkout, 'config', 'core.hooksPath', '.githooks');
    // The hook is live: git as anyone else runs it.
    setupGit(tree.env, tree.checkout, 'worktree', 'add', '-q', '-b', 'proof', join(tree.root, 'proof'));
    assert.equal(existsSync(marker), true, 'the hook runs for a plain git');
    await rm(marker);
    const result = await createWorktreeExecutor(tree.deps).run(
      stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS }),
    );
    assert.equal(result.kind === 'settled' && result.outcome, 'made');
    assert.equal(existsSync(marker), false);
  });
});

test('a symlinked root is refused', { skip: WINDOWS_SKIP }, async () => {
  await withTree(
    async (tree) => {
      mkdirSync(join(tree.work, 'real-trees'));
      symlinkSync(join(tree.work, 'real-trees'), join(tree.work, 'trees-link'));
      const result = await createWorktreeExecutor(tree.deps).run(
        stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS }),
      );
      assert.deepEqual(result, {
        kind: 'settled',
        outcome: 'refused',
        output: { branch: 'ac/acme-123', path: null, refusal: 'ROOT_SYMLINK' },
      });
      assert.deepEqual(rows(tree.store), []);
    },
    { worktreeRoot: ({ work }) => join(work, 'trees-link') },
  );
});

test("a root outside the allowed roots, or in Agent Comms' folders, is refused", { skip: WINDOWS_SKIP }, async () => {
  await withTree(
    async (tree) => {
      const result = await createWorktreeExecutor(tree.deps).run(
        stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS }),
      );
      assert.equal(result.kind === 'settled' && result.output.refusal, 'OUTSIDE_ALLOWED_ROOTS');
    },
    { worktreeRoot: ({ work }) => join(work, '..', '..', 'trees') },
  );
});

test('a branch that exists and this run did not make is refused', { skip: WINDOWS_SKIP }, async () => {
  await withTree(async (tree) => {
    setupGit(tree.env, tree.checkout, 'branch', 'ac/acme-123');
    const ctx = stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS });
    const result = await createWorktreeExecutor(tree.deps).run(ctx);
    assert.deepEqual(result, {
      kind: 'settled',
      outcome: 'refused',
      output: { branch: 'ac/acme-123', path: null, refusal: 'BRANCH_EXISTS' },
    });
    assert.deepEqual(rows(tree.store), []);
    assert.deepEqual(ctx.charged, []);
  });
});

test('a retry that finds the worktree adopts it', { skip: WINDOWS_SKIP }, async () => {
  await withTree(async (tree) => {
    // The attempt's git made the worktree, and the attempt stopped before it settled.
    const crashing: GitRunner = {
      run: async (args, cwd) => {
        const result = await tree.git.run(args, cwd);
        if (args[0] === 'worktree' && args[1] === 'add') throw new Error('the event service stopped here');
        return result;
      },
    };
    await assert.rejects(
      createWorktreeExecutor({ ...tree.deps, git: crashing }).run(
        stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS }),
      ),
      /stopped here/u,
    );
    assert.equal(rows(tree.store)[0]?.state, 'recording');
    const retry = stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS, attempt: { id: 'a-2', number: 2 } });
    const result = await createWorktreeExecutor(tree.deps).run(retry);
    const path = join(`${tree.checkout}-wt`, 'ac-acme-123');
    assert.deepEqual(result, {
      kind: 'settled',
      outcome: 'made',
      output: { branch: 'ac/acme-123', path, refusal: null },
    });
    assert.deepEqual(retry.charged, [], 'adopted, not made or charged again');
    assert.equal(listed(tree).split('\nworktree ').length, 2, 'the checkout and one worktree');
    // And once made, any later attempt answers the same.
    assert.deepEqual(await createWorktreeExecutor(tree.deps).run(retry), result);
  });
});

test('realpath not equal to the computed path: removed and refused', { skip: WINDOWS_SKIP }, async () => {
  await withTree(async (tree) => {
    const root = `${tree.checkout}-wt`;
    mkdirSync(root);
    mkdirSync(join(tree.work, 'elsewhere'));
    symlinkSync(join(tree.work, 'elsewhere'), join(root, 'ac-acme-123'));
    const result = await createWorktreeExecutor(tree.deps).run(
      stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS }),
    );
    assert.deepEqual(result, {
      kind: 'settled',
      outcome: 'refused',
      output: { branch: 'ac/acme-123', path: null, refusal: 'PATH_NOT_REAL' },
    });
    assert.equal(rows(tree.store)[0]?.state, 'refused');
    assert.equal(listed(tree).includes('elsewhere'), false, 'the worktree git made through the symlink is removed');
  });
});

test('remove-if-clean keeps a dirty tree and an unpushed branch, and says why', { skip: WINDOWS_SKIP }, async () => {
  await withTree(async (tree) => {
    const tidy = { ...(tree.rule.flow.steps.tree as object), cleanup: 'remove-if-clean' } as FlowStep;
    const executor = createWorktreeExecutor(tree.deps);
    const runs = ['wfr_0000000000000000000000000a', 'wfr_0000000000000000000000000b', 'wfr_0000000000000000000000000c'];
    const contexts = runs.map((id, index) =>
      stepContext({
        rule: tree.rule,
        stepId: 'tree',
        step: tidy,
        run: { id },
        outputs: { ...OUTPUTS, issue: { identifier: `ACME-${index}` } },
      }),
    );
    const paths: string[] = [];
    for (const ctx of contexts) {
      const result = await executor.run(ctx);
      assert.equal(result.kind === 'settled' && result.outcome, 'made');
      paths.push(result.kind === 'settled' ? (result.output.path as string) : '');
    }
    writeFileSync(join(paths[1] as string, 'notes.txt'), 'work in progress\n');
    setupGit(
      tree.env,
      paths[2] as string,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'done',
    );
    for (const ctx of contexts) await executor.finish?.(ctx, 'done');
    assert.deepEqual(
      rows(tree.store).map((row) => [row.path, row.state, row.reason]),
      [
        [paths[0], 'removed', null],
        [paths[1], 'kept', 'DIRTY'],
        [paths[2], 'kept', 'UNPUSHED'],
      ],
    );
    assert.equal(existsSync(paths[0] as string), false);
    assert.equal(existsSync(paths[1] as string), true);
    assert.equal(existsSync(paths[2] as string), true);
  });
});

test('worktreesPerDay holds the step', { skip: WINDOWS_SKIP }, async () => {
  await withTree(async (tree) => {
    const ctx = stepContext({
      rule: tree.rule,
      stepId: 'tree',
      outputs: OUTPUTS,
      charge: () => ({ ok: false, until: STEP_CONTEXT_NOW + 3_600_000 }),
    });
    assert.deepEqual(await createWorktreeExecutor(tree.deps).run(ctx), {
      kind: 'wait',
      wait: 'limit',
      key: null,
      wakeAt: STEP_CONTEXT_NOW + 3_600_000,
    });
    assert.deepEqual(rows(tree.store), []);
    assert.equal(listed(tree).split('\nworktree ').length, 1);
  });
});

test('the branch never holds a mapped field', () => {
  const slot = (name: string) => (name === 'steps.issue.identifier' ? 'ACME-123' : name === 'run' ? 'wfr_abc' : null);
  const withSenderSlot = 'ac/{{subject}}';
  assert.equal(branchOf(withSenderSlot, slot), undefined);
  assert.equal(branchOf('ac/{{steps.wait.summary}}', slot), undefined);
  assert.equal(branchOf('ac/{{steps.issue.identifier}}', slot), 'ac/acme-123');
  assert.equal(branchOf('ac/{{run}}', slot), 'ac/wfr-abc');
  assert.equal(branchOf('ac/{{steps.find.session}}', slot), undefined, 'a slot with no value yet');
  assert.equal(foldBranch('Ac//ACME 123!!/../.lock'), 'ac/acme-123/lock');
  assert.equal(foldBranch(`ac/${'x'.repeat(80)}`).length, 60);
  // And activation never lets one through: checkFlow refuses the slot.
  const tree = OWNER_EXAMPLE.flow.steps.tree as Extract<FlowStep, { kind: 'worktree' }>;
  const checked = checkFlow(
    { ...OWNER_EXAMPLE.flow, steps: { ...OWNER_EXAMPLE.flow.steps, tree: { ...tree, branch: withSenderSlot } } },
    {},
  );
  assert.equal(checked.ok, false);
  assert.ok(
    !checked.ok &&
      checked.problems.some((problem) => problem.stepId === 'tree' && problem.pointer === '/steps/tree/branch'),
  );
});

/*
 * Git in a folder a session can write to (0.37.0 design §3): a run's worktree shares the checkout's `.git/config`, so a
 * session in it can plant a key that names a program, and commit `.gitattributes`. Each planted state below is the
 * review's (2026-10-28), proved live for a plain git first; the payload only writes a marker file in the test's folder.
 */

/** A program a planted key names: it writes `<root>/<name>`, and passes its input through when a filter needs that. */
function payload(
  tree: Tree,
  name: string,
  passThrough: boolean,
): { readonly program: string; readonly marker: string } {
  const marker = join(tree.root, name);
  const program = join(tree.root, `${name}.sh`);
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n${passThrough ? 'cat\n' : ''}`);
  chmodSync(program, 0o755);
  return { program, marker };
}

/** A commit on main with `files`, so a checkout writes them and a filter has paths to run on. */
function commit(tree: Tree, files: Readonly<Record<string, string>>): void {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tree.checkout, name), text);
  setupGit(tree.env, tree.checkout, '-c', 'core.hooksPath=/dev/null', 'add', '--', ...Object.keys(files));
  setupGit(tree.env, tree.checkout, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'files');
}

/** A plain git, as anyone else runs it, writes the marker: the planted state is live. */
async function provedLive(tree: Tree, marker: string, ...args: string[]): Promise<void> {
  try {
    setupGit(tree.env, tree.checkout, ...args);
  } catch {
    // A filter that does not speak git's protocol fails the command after it ran; the marker is what counts.
  }
  assert.equal(existsSync(marker), true, `a plain git ${args.join(' ')} runs it`);
  await rm(marker);
}

const TIDY = (tree: Tree) => ({ ...(tree.rule.flow.steps.tree as object), cleanup: 'remove-if-clean' }) as FlowStep;

test('core.fsmonitor at local scope runs nothing during the add or the cleanup', { skip: WINDOWS_SKIP }, async () => {
  await withTree(async (tree) => {
    commit(tree, { 'a.txt': 'hello\n' });
    const { program, marker } = payload(tree, 'fsmonitor', false);
    setupGit(tree.env, tree.checkout, 'config', 'core.fsmonitor', program);
    await provedLive(tree, marker, 'status', '--porcelain');
    const ctx = stepContext({ rule: tree.rule, stepId: 'tree', step: TIDY(tree), outputs: OUTPUTS });
    const executor = createWorktreeExecutor(tree.deps);
    const result = await executor.run(ctx);
    const path = join(`${tree.checkout}-wt`, 'ac-acme-123');
    assert.deepEqual(result, {
      kind: 'settled',
      outcome: 'made',
      output: { branch: 'ac/acme-123', path, refusal: null },
    });
    assert.equal(readFileSync(join(path, 'a.txt'), 'utf8'), 'hello\n', 'the worktree is checked out');
    assert.equal(existsSync(marker), false, 'the add ran nothing');
    await executor.finish?.(ctx, 'done');
    assert.deepEqual(
      rows(tree.store).map((row) => [row.state, row.reason]),
      [['removed', null]],
    );
    assert.equal(existsSync(marker), false, 'the cleanup ran nothing');
  });
});

for (const planted of [
  {
    name: 'a local filter.x.smudge',
    key: 'filter.x.smudge',
    passThrough: true,
    plant: (tree: Tree, program: string) => setupGit(tree.env, tree.checkout, 'config', 'filter.x.smudge', program),
  },
  {
    name: 'a local filter.x.process',
    key: 'filter.x.process',
    passThrough: false,
    plant: (tree: Tree, program: string) => setupGit(tree.env, tree.checkout, 'config', 'filter.x.process', program),
  },
  {
    name: 'filter.x.process through include.path',
    key: 'filter.x.process',
    passThrough: false,
    plant: (tree: Tree, program: string) => {
      const included = join(tree.root, 'planted.inc');
      writeFileSync(included, `[filter "x"]\n\tprocess = ${program}\n`);
      setupGit(tree.env, tree.checkout, 'config', 'include.path', included);
    },
  },
]) {
  test(`a committed * filter=x with ${planted.name} is refused by name, and runs nothing`, {
    skip: WINDOWS_SKIP,
  }, async () => {
    await withTree(async (tree) => {
      commit(tree, { '.gitattributes': '* filter=x\n', 'a.txt': 'hello\n' });
      const { program, marker } = payload(tree, 'filter', planted.passThrough);
      planted.plant(tree, program);
      await provedLive(
        tree,
        marker,
        '-c',
        'core.hooksPath=/dev/null',
        'worktree',
        'add',
        '-q',
        join(tree.root, 'proof'),
      );
      const ctx = stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS });
      const result = await createWorktreeExecutor(tree.deps).run(ctx);
      assert.deepEqual(result, {
        kind: 'settled',
        outcome: 'refused',
        output: {
          branch: 'ac/acme-123',
          path: null,
          refusal: 'REPO_CONFIG_UNSAFE',
          configKey: planted.key,
          configScope: 'local',
        },
      });
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(`${tree.checkout}-wt`, 'ac-acme-123')), false, 'git made no worktree');
      assert.deepEqual(rows(tree.store), [], 'refused before anything was recorded or charged');
      assert.deepEqual(ctx.charged, []);
    });
  });
}

test("an includeIf gitdir: naming the run's worktree is refused, though it applies only there", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTree(async (tree) => {
    commit(tree, { '.gitattributes': '* filter=x\n', 'a.txt': 'hello\n' });
    const { program, marker } = payload(tree, 'filter', true);
    const included = join(tree.root, 'planted.inc');
    writeFileSync(included, `[filter "x"]\n\tsmudge = ${program}\n`);
    // A worktree's git directory is <checkout>/.git/worktrees/<name>: the include applies in a worktree, never in the
    // checkout, where the first read of the config is made.
    setupGit(tree.env, tree.checkout, 'config', `includeIf.gitdir:${tree.checkout}/.git/worktrees/**.path`, included);
    await provedLive(tree, marker, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', join(tree.root, 'proof'));
    const result = await createWorktreeExecutor(tree.deps).run(
      stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS }),
    );
    assert.equal(result.kind === 'settled' && result.output.refusal, 'REPO_CONFIG_UNSAFE');
    assert.equal(
      result.kind === 'settled' && result.output.configKey,
      `includeif.gitdir:${tree.checkout}/.git/worktrees/**.path`,
    );
    assert.equal(existsSync(marker), false);
  });
});

test("LFS in the person's global config runs and the worktree is made; the same keys at local scope are refused", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTree(async (tree) => {
    commit(tree, { '.gitattributes': '*.bin filter=lfs\n', 'a.bin': 'pointer\n' });
    const { program, marker } = payload(tree, 'lfs', true);
    // A stand-in global config, where `git lfs install` writes it: the person's own machine, never the session's.
    const global = join(tree.env.HOME as string, '.gitconfig');
    writeFileSync(global, `[filter "lfs"]\n\tsmudge = ${program}\n\tclean = cat\n\trequired = true\n`);
    const ctx = stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS });
    const result = await createWorktreeExecutor(tree.deps).run(ctx);
    assert.equal(result.kind === 'settled' && result.outcome, 'made');
    assert.equal(existsSync(marker), true, "the person's LFS smudge ran for the checkout");
    const path = join(`${tree.checkout}-wt`, 'ac-acme-123');
    assert.equal(readFileSync(join(path, 'a.bin'), 'utf8'), 'pointer\n');
    await rm(marker);
    // The same filter written into the repository's own config is a planted one, by its scope.
    await rm(global);
    setupGit(tree.env, tree.checkout, 'config', 'filter.lfs.smudge', program);
    setupGit(tree.env, tree.checkout, 'config', 'filter.lfs.clean', 'cat');
    const again = stepContext({
      rule: tree.rule,
      stepId: 'tree',
      run: { id: 'wfr_0000000000000000000000000b' },
      outputs: { ...OUTPUTS, issue: { identifier: 'ACME-124' } },
    });
    assert.deepEqual(await createWorktreeExecutor(tree.deps).run(again), {
      kind: 'settled',
      outcome: 'refused',
      output: {
        branch: 'ac/acme-124',
        path: null,
        refusal: 'REPO_CONFIG_UNSAFE',
        configKey: 'filter.lfs.smudge',
        configScope: 'local',
      },
    });
    assert.equal(existsSync(marker), false);
  });
});

test('the add: a filter planted between the first read and the checkout is refused, and writes no marker', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTree(async (tree) => {
    commit(tree, { '.gitattributes': '* filter=x\n', 'a.txt': 'hello\n' });
    const { program, marker } = payload(tree, 'filter', true);
    // The session plants the filter after the first read of the config, as git is about to add the worktree.
    const planting: GitRunner = {
      run: async (args, cwd) => {
        if (args[0] === 'worktree' && args[1] === 'add')
          setupGit(tree.env, tree.checkout, 'config', 'filter.x.smudge', program);
        return tree.git.run(args, cwd);
      },
    };
    const ctx = stepContext({ rule: tree.rule, stepId: 'tree', outputs: OUTPUTS });
    const result = await createWorktreeExecutor({ ...tree.deps, git: planting }).run(ctx);
    assert.deepEqual(result, {
      kind: 'settled',
      outcome: 'refused',
      output: {
        branch: 'ac/acme-123',
        path: null,
        refusal: 'REPO_CONFIG_UNSAFE',
        configKey: 'filter.x.smudge',
        configScope: 'local',
      },
    });
    assert.equal(existsSync(marker), false, 'the add checked nothing out, and the checkout never ran');
    assert.deepEqual(
      rows(tree.store).map((row) => [row.state, row.reason]),
      [['refused', 'REPO_CONFIG_UNSAFE']],
    );
    assert.equal(existsSync(join(`${tree.checkout}-wt`, 'ac-acme-123', 'a.txt')), false);
  });
});

test('the cleanup: a clean filter planted after the worktree was made keeps it, and runs nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTree(async (tree) => {
    commit(tree, { 'a.txt': 'hello\n' });
    const ctx = stepContext({ rule: tree.rule, stepId: 'tree', step: TIDY(tree), outputs: OUTPUTS });
    const executor = createWorktreeExecutor(tree.deps);
    const made = await executor.run(ctx);
    assert.equal(made.kind === 'settled' && made.outcome, 'made');
    const path = made.kind === 'settled' ? (made.output.path as string) : '';
    // The session plants an attribute and a clean filter; a file it touched makes git hash it again.
    writeFileSync(join(tree.checkout, '.git', 'info', 'attributes'), '* filter=x\n');
    const { program, marker } = payload(tree, 'clean', true);
    setupGit(tree.env, path, 'config', 'filter.x.clean', program);
    setupGit(tree.env, path, 'config', 'filter.x.process', program);
    try {
      setupGit(tree.env, path, 'status', '--porcelain');
    } catch {
      // As above: the marker is what counts.
    }
    assert.equal(existsSync(marker), true, 'a plain git status runs it');
    await rm(marker);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(path, 'a.txt'), later, later);
    await executor.finish?.(ctx, 'done');
    assert.deepEqual(
      rows(tree.store).map((row) => [row.state, row.reason]),
      [['kept', 'REPO_CONFIG_UNSAFE']],
    );
    assert.equal(existsSync(marker), false, 'neither status nor worktree remove ran');
    assert.equal(existsSync(path), true);
  });
});

test('worktree remove leaves a folder outside the root intact when the worktree is replaced by a symlink', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTree(async (tree) => {
    commit(tree, { 'a.txt': 'hello\n' });
    const ctx = stepContext({ rule: tree.rule, stepId: 'tree', step: TIDY(tree), outputs: OUTPUTS });
    const executor = createWorktreeExecutor(tree.deps);
    const made = await executor.run(ctx);
    const path = made.kind === 'settled' ? (made.output.path as string) : '';
    const victim = join(tree.work, 'precious');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'mine\n');
    await rm(path, { recursive: true, force: true });
    symlinkSync(victim, path);
    await executor.finish?.(ctx, 'done');
    assert.equal(rows(tree.store)[0]?.state, 'kept');
    assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'mine\n');
    // And git's own remove, without --force, refuses it.
    const removed = await tree.git.run(['worktree', 'remove', path], tree.checkout);
    assert.notEqual(removed.code, 0);
    assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'mine\n');
  });
});
