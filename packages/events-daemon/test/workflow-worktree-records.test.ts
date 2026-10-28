import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { createGitRunner, type GitRunner } from '../src/runtime/git.ts';
import { madeWorktreesOf } from '../src/runtime/project-sessions.ts';
import {
  WORKTREE_RECORDS_BATCH,
  WORKTREE_RECORDS_EVERY_MS,
  WorktreeRecordSweep,
} from '../src/runtime/worktree-records.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome } from './support/stand-ins.ts';
import { seedRun, testId } from './support/workflow-event-rows.ts';

/*
 * 0.37.0 §2: the worktree rows of purged runs. An ended run's history goes with its decision's metadata (W7), but a row
 * in state `made` or `kept` stays, since its folder may still be on disk and Projects reads it. Once its run is purged,
 * the history sweep looks at it: a folder that no longer exists, or is no longer a worktree of its checkout (by `git
 * worktree list --porcelain` of the checkout, through the git runner), loses its row; a worktree still on disk keeps
 * it, for the person to remove; a row whose checkout can't be read stays for the next sweep. At most 100 rows a sweep.
 *
 * The real `git` binary over the test's own repositories, in a stand-in home; nothing reads the person's folders.
 */

const RULE = 'client-asks';
const ACCOUNT = 'acme/slack';
const AT = Date.UTC(2026, 9, 28, 9, 30, 0, 0);
const DAY = 86_400_000;

interface Checkout {
  readonly root: string;
  readonly checkout: string;
  readonly trees: string;
  readonly env: NodeJS.ProcessEnv;
  readonly store: EventDatabase;
  readonly git: GitRunner;
}

function setupGit(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
}

async function withCheckout(work: (checkout: Checkout) => Promise<void>): Promise<void> {
  const root = await realpath(await shortTempDir('aev-wt-records-'));
  const { homeDirectory } = await standInHome(root);
  const checkout = join(homeDirectory, 'work', 'acme-site');
  const trees = `${checkout}-wt`;
  mkdirSync(checkout, { recursive: true });
  mkdirSync(trees, { recursive: true });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homeDirectory, GIT_CONFIG_NOSYSTEM: '1' };
  setupGit(env, checkout, 'init', '-q', '-b', 'main');
  setupGit(env, checkout, 'commit', '-q', '--allow-empty', '-m', 'init');
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  try {
    const git = createGitRunner({ env: { PATH: env.PATH, HOME: homeDirectory } });
    await work({ root, checkout, trees, env, store, git });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** A run that ended, its decision's metadata past its deadline at `AT`, so the history sweep purges it. */
function endedRun(store: EventDatabase): string {
  const runId = seedRun(store.database, { ruleId: RULE, ruleVersion: 1, accountId: ACCOUNT, now: AT - 2 * DAY });
  store.database.prepare('UPDATE decisions SET metadata_expires_at = ? WHERE id = ?').run(AT - 1, `decision-${runId}`);
  store.database.prepare("UPDATE workflow_runs SET state = 'done' WHERE id = ?").run(runId);
  return runId;
}

/** A worktree row as the worktree step leaves it. */
function worktreeRow(
  store: EventDatabase,
  input: { runId: string; stepId?: string; checkout: string; path: string; state: 'made' | 'kept' },
): void {
  store.database
    .prepare(
      `INSERT INTO workflow_worktrees (run_id, step_id, project_id, checkout, path, branch, state, created_at, settled_at)
       VALUES (?, ?, 'acme-site', ?, ?, 'ac/acme-1', ?, ?, ?)`,
    )
    .run(input.runId, input.stepId ?? 'tree', input.checkout, input.path, input.state, AT - 2 * DAY, AT - 2 * DAY);
}

function paths(store: EventDatabase): string[] {
  return (
    store.database.prepare('SELECT path FROM workflow_worktrees ORDER BY path').all() as unknown as { path: string }[]
  ).map((row) => row.path);
}

/** A git runner that counts what it is asked, around another. */
function counted(git: GitRunner): GitRunner & { readonly calls: { args: readonly string[]; cwd: string }[] } {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  return {
    calls,
    run: (args, cwd) => {
      calls.push({ args, cwd });
      return git.run(args, cwd);
    },
  };
}

test("§2: a purged run's made row whose folder is gone is deleted by the history sweep", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withCheckout(async ({ checkout, trees, store, git }) => {
    const ended = endedRun(store);
    worktreeRow(store, { runId: ended, stepId: 'tree', checkout, path: join(trees, 'gone-made'), state: 'made' });
    worktreeRow(store, { runId: ended, stepId: 'kept', checkout, path: join(trees, 'gone-kept'), state: 'kept' });
    // A live run's row is its run's to clean up: the sweep never looks at it, gone or not.
    const live = seedRun(store.database, { ruleId: RULE, ruleVersion: 1, accountId: ACCOUNT, now: AT });
    worktreeRow(store, { runId: live, checkout, path: join(trees, 'gone-live'), state: 'made' });
    const recorder = counted(git);
    const records = new WorktreeRecordSweep({ store, git: recorder, now: () => AT });
    const expiry = new EventExpiry(store, () => AT, undefined, records);

    await expiry.sweepAll();
    await records.idle();

    assert.equal(
      store.database.prepare('SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?').get(ended)?.count,
      0,
      'the ended run is purged with its decision’s metadata',
    );
    assert.deepEqual(paths(store), [join(trees, 'gone-live')], 'a purged run’s rows whose folders are gone go');
    assert.deepEqual(madeWorktreesOf(store.database, 'acme-site'), [join(trees, 'gone-live')]);
    assert.deepEqual(recorder.calls, [], 'a folder that is gone needs no git');
  });
});

test('§2: one whose folder is still a worktree of its checkout is kept; a folder that is not one goes', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withCheckout(async ({ checkout, trees, env, store, git }) => {
    const tree = join(trees, 'ac-acme-1');
    setupGit(env, checkout, 'worktree', 'add', '-q', '-b', 'ac/acme-1', tree, 'main');
    // A plain folder at a row's path: no longer a worktree of the checkout, whatever is in it.
    const plain = join(trees, 'ac-acme-2');
    mkdirSync(plain);
    // A worktree of another checkout is not one of this checkout's.
    const other = join(trees, '..', 'other-site');
    mkdirSync(other);
    setupGit(env, other, 'init', '-q', '-b', 'main');
    setupGit(env, other, 'commit', '-q', '--allow-empty', '-m', 'init');
    const elsewhere = join(trees, 'ac-acme-3');
    setupGit(env, other, 'worktree', 'add', '-q', '-b', 'ac/acme-3', elsewhere, 'main');
    // A run the history sweep purged: its rows stay, and nothing else of it.
    const purged = testId('wfr_');
    worktreeRow(store, { runId: purged, stepId: 'tree', checkout, path: tree, state: 'made' });
    worktreeRow(store, { runId: purged, stepId: 'plain', checkout, path: plain, state: 'kept' });
    worktreeRow(store, { runId: purged, stepId: 'other', checkout, path: elsewhere, state: 'made' });
    const recorder = counted(git);
    const records = new WorktreeRecordSweep({ store, git: recorder, now: () => AT });

    assert.deepEqual(await records.sweep(), { looked: 3, deleted: 2, kept: 1, unread: 0 });

    assert.deepEqual(paths(store), [tree], 'the worktree on disk keeps its row: it is the person’s to remove');
    assert.deepEqual(madeWorktreesOf(store.database, 'acme-site'), [tree], 'and Projects keeps showing it');
    assert.deepEqual(
      recorder.calls,
      [{ args: ['worktree', 'list', '--porcelain'], cwd: checkout }],
      'one listing of the checkout, through the git runner, for every row of it',
    );
  });
});

test("§2: one whose checkout can't be read is kept, and tried again at the next sweep", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withCheckout(async ({ checkout, trees, store, git }) => {
    const plain = join(trees, 'ac-acme-1');
    mkdirSync(plain);
    worktreeRow(store, { runId: testId('wfr_'), checkout, path: plain, state: 'made' });
    // The checkout's repository is away: git can't list its worktrees.
    await rename(join(checkout, '.git'), join(checkout, 'git-away'));
    let clock = AT;
    const recorder = counted(git);
    const records = new WorktreeRecordSweep({ store, git: recorder, now: () => clock });
    const expiry = new EventExpiry(store, () => clock, undefined, records);

    await expiry.sweepAll();
    await records.idle();
    assert.equal(recorder.calls.length, 1, 'the sweep asked git');
    assert.deepEqual(paths(store), [plain], 'a row whose checkout can’t be read stays');

    // Back, and not looked at again before the next sweep is due.
    await rename(join(checkout, 'git-away'), join(checkout, '.git'));
    await expiry.sweepAll();
    await records.idle();
    assert.equal(recorder.calls.length, 1, `the next sweep waits ${WORKTREE_RECORDS_EVERY_MS} ms`);
    assert.deepEqual(paths(store), [plain]);

    clock += WORKTREE_RECORDS_EVERY_MS;
    await expiry.sweepAll();
    await records.idle();
    assert.equal(recorder.calls.length, 2, 'tried again');
    assert.deepEqual(paths(store), [], 'now read: the folder is no worktree of the checkout, and its row goes');
  });
});

test('§2: at most 100 rows a sweep, and rows kept never hold the rest back', { skip: WINDOWS_SKIP }, async () => {
  await withCheckout(async ({ checkout, trees, store }) => {
    assert.equal(WORKTREE_RECORDS_BATCH, 100);
    const kept = Array.from({ length: WORKTREE_RECORDS_BATCH }, (_, index) =>
      join(trees, `a-${String(index).padStart(3, '0')}`),
    );
    for (const [index, path] of kept.entries()) {
      mkdirSync(path);
      worktreeRow(store, { runId: testId('wfr_'), stepId: `tree-${index}`, checkout, path, state: 'made' });
    }
    // Sorted after every kept one.
    const gone = join(trees, 'b-gone');
    worktreeRow(store, { runId: testId('wfr_'), checkout, path: gone, state: 'kept' });
    // A stand-in git that lists every kept folder as one of the checkout's worktrees.
    const listing = [checkout, ...kept].map((path) => `worktree ${path}\nHEAD ${'0'.repeat(40)}\ndetached\n`);
    const git = counted({ run: async () => ({ code: 0, stdout: listing.join('\n') }) });
    const records = new WorktreeRecordSweep({ store, git, now: () => AT });

    assert.deepEqual(await records.sweep(), { looked: 100, deleted: 0, kept: 100, unread: 0 });
    assert.equal(git.calls.length, 1, 'one listing for the 100 rows of one checkout');
    assert.deepEqual(await records.sweep(), { looked: 1, deleted: 1, kept: 0, unread: 0 }, 'the next takes the rest');
    assert.equal(paths(store).includes(gone), false);
    assert.deepEqual(
      await records.sweep(),
      { looked: 100, deleted: 0, kept: 100, unread: 0 },
      'and then starts again from the first',
    );
  });
});

test('§2: once stopped, the history sweep starts no more', { skip: WINDOWS_SKIP }, async () => {
  await withCheckout(async ({ checkout, trees, store, git }) => {
    worktreeRow(store, { runId: testId('wfr_'), checkout, path: join(trees, 'gone'), state: 'made' });
    const records = new WorktreeRecordSweep({ store, git, now: () => AT });
    await records.stop();
    await new EventExpiry(store, () => AT, undefined, records).sweepAll();
    await records.idle();
    assert.deepEqual(paths(store), [join(trees, 'gone')]);
  });
});
