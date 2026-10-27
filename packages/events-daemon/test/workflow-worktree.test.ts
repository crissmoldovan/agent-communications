import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
