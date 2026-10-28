import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import {
  assertSafeRepoConfig,
  createGitRunner,
  GIT_FIXED_OPTIONS,
  type GitExecFile,
  repoConfigKeyShown,
  repoConfigRefusal,
  unsafeRepoConfig,
} from '../src/runtime/git.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome } from './support/stand-ins.ts';

/*
 * The git runner and the config gate (0.37.0 design §3 A and B). A run's worktree shares its checkout's config, which
 * a session working in it can write; these are the runner's overrides, its environment, and the gate that refuses a
 * repository whose own config names a program. Real `git` runs over temporary repositories in a stand-in home, with a
 * stand-in global config where a test needs one; nothing reads the person's repositories or their `~/.gitconfig`.
 */

/** Every fixed-name key that runs a program, as §3 A lists it, after the hooks: the runner's whole prefix. */
const OVERRIDES = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.sshCommand=',
  'core.gitProxy=',
  'core.pager=cat',
  'core.editor=false',
  'core.askpass=',
  'core.alternateRefsCommand=',
  'sequence.editor=false',
  'credential.helper=',
  'gpg.program=false',
  'gpg.openpgp.program=false',
  'uploadpack.packObjectsHook=',
  'diff.external=',
  'protocol.ext.allow=never',
];

test("the runner builds every -c override on every argv, hooks first, before the command's own", async () => {
  assert.deepEqual(
    GIT_FIXED_OPTIONS,
    OVERRIDES.flatMap((override) => ['-c', override]),
  );
  const recorded: (readonly string[])[] = [];
  const git = createGitRunner({
    env: { PATH: '/usr/bin', HOME: '/example/home' },
    execFile: (_file, args, _options, callback) => {
      recorded.push(args);
      callback(null, '');
    },
  });
  const commands = [
    ['config', '--get', 'remote.origin.url'],
    ['config', '--list', '--show-scope', '-z'],
    ['worktree', 'list', '--porcelain'],
    ['worktree', 'add', '--no-checkout', '-b', 'ac/acme-1', '/example/home/work/acme-site-wt/ac-acme-1', 'main'],
    ['checkout', '--quiet'],
    ['status', '--porcelain'],
    ['worktree', 'remove', '/example/home/work/acme-site-wt/ac-acme-1'],
  ];
  for (const command of commands) await git.run(command, '/example/home/work/acme-site');
  assert.deepEqual(
    recorded,
    commands.map((command) => [...GIT_FIXED_OPTIONS, ...command]),
  );
});

test('git is given GIT_CONFIG_NOSYSTEM=1, whatever the environment says of it, and no other GIT_*', async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const execFile: GitExecFile = (_file, _args, options, callback) => {
    seen.push(options.env);
    callback(null, '');
  };
  for (const env of [
    { PATH: '/usr/bin', HOME: '/example/home' },
    { PATH: '/usr/bin', HOME: '/example/home', GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: '/example/planted' },
    { PATH: '/usr/bin', HOME: '/example/home', git_config_nosystem: '', GIT_CONFIG_PARAMETERS: "'core.pager'='x'" },
  ])
    await createGitRunner({ env, execFile }).run(['status'], '/example/home/work/acme-site');
  for (const env of seen) assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/example/home', GIT_CONFIG_NOSYSTEM: '1' });
});

interface Box {
  readonly root: string;
  readonly home: string;
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
}

async function withRepository(work: (box: Box) => Promise<void>): Promise<void> {
  const root = await realpath(await shortTempDir('aev-git-runner-'));
  try {
    const { homeDirectory } = await standInHome(root);
    const repo = join(homeDirectory, 'work', 'acme-site');
    mkdirSync(repo, { recursive: true });
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homeDirectory, GIT_CONFIG_NOSYSTEM: '1' };
    const box = { root, home: homeDirectory, repo, env };
    plain(box, 'init', '-q', '-b', 'main');
    await work(box);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** git for the test's own setup, as the stand-in home's person, with no hooks. */
function plain(box: Box, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: box.repo,
    env: box.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function runner(box: Box, execFile?: GitExecFile) {
  return createGitRunner({ env: { PATH: box.env.PATH, HOME: box.home }, execFile });
}

test('the system config: with GIT_CONFIG_SYSTEM pointing at a planted file, it has no effect', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRepository(async (box) => {
    const planted = join(box.root, 'system-gitconfig');
    writeFileSync(planted, '[filter "x"]\n\tprocess = /example/planted\n[agentcomms]\n\tplanted = yes\n');
    // The machine's system config, as git finds it: the variable is set where git runs, past the runner's scrubber,
    // as the default system path is for every git the person runs.
    const machine: GitExecFile = (file, args, options, callback) =>
      execFile(
        file,
        [...args],
        { ...options, env: { ...options.env, GIT_CONFIG_SYSTEM: planted }, encoding: 'utf8' },
        (error, stdout) => callback(error, String(stdout)),
      );
    // It is live: a git without NOSYSTEM reads it.
    assert.equal(
      execFileSync('git', ['config', '--get', 'agentcomms.planted'], {
        cwd: box.repo,
        env: { PATH: box.env.PATH, HOME: box.home, GIT_CONFIG_SYSTEM: planted },
      })
        .toString()
        .trim(),
      'yes',
    );
    const git = runner(box, machine);
    assert.deepEqual(await git.run(['config', '--get', 'agentcomms.planted'], box.repo), { code: 1, stdout: '' });
    const listed = await git.run(['config', '--list', '--show-scope', '-z'], box.repo);
    assert.equal(listed.code, 0);
    assert.equal(listed.stdout.split('\0').includes('system'), false, 'no key is read from the system scope');
    assert.equal(await repoConfigRefusal(git, box.repo), null);
  });
});

test('the gate refuses a program a driver names, and an include, at local or worktree scope', () => {
  const listing = (...records: [string, string][]) => records.map(([scope, entry]) => `${scope}\0${entry}\0`).join('');
  const BASE: [string, string][] = [
    ['command', 'core.hookspath\n/dev/null'],
    ['command', 'core.fsmonitor\nfalse'],
    ['local', 'core.repositoryformatversion\n0'],
  ];
  for (const [entry, key] of [
    ['filter.x.clean\n/example/planted', 'filter.x.clean'],
    ['filter.x.smudge\n/example/planted', 'filter.x.smudge'],
    ['filter.X.process\n/example/planted', 'filter.X.process'],
    ['diff.x.textconv\n/example/planted', 'diff.x.textconv'],
    ['diff.x.command\n/example/planted', 'diff.x.command'],
    ['merge.x.driver\n/example/planted %O %A %B', 'merge.x.driver'],
    ['include.path\n/example/planted.inc', 'include.path'],
    ['includeif.gitdir:/example/home/work/acme-site/.git/worktrees/**.path\n/example/planted.inc', null],
    ['includeif.onbranch:ac/**.path\n/example/planted.inc', 'includeif.onbranch:ac/**.path'],
    // A bare key, with no value: the record has no newline.
    ['filter.x.clean', 'filter.x.clean'],
  ] as const) {
    const shown = key ?? entry.slice(0, entry.indexOf('\n'));
    for (const scope of ['local', 'worktree'])
      assert.deepEqual(unsafeRepoConfig(listing(...BASE, [scope, entry])), {
        code: 'REPO_CONFIG_UNSAFE',
        key: shown,
        scope,
      });
    // The same at the person's own scopes is theirs.
    for (const scope of ['global', 'system', 'command'])
      assert.equal(unsafeRepoConfig(listing(...BASE, [scope, entry])), null, `${scope} ${entry}`);
  }
  // What A neutralises on every command, and what runs no program, is not refused: ordinary repositories set them.
  for (const entry of [
    'core.editor\nvim',
    'core.fsmonitor\ntrue',
    'core.pager\nless',
    'core.sshcommand\nssh -i /example/key',
    'credential.helper\nosxkeychain',
    'diff.external\n/example/differ',
    'alias.st\n!/example/planted',
    'filter.lfs.required\ntrue',
    'remote.origin.url\nhttps://github.com/example/acme-site.git',
  ])
    assert.equal(unsafeRepoConfig(listing(...BASE, ['local', entry])), null, entry);
  // A program key comes before an include: what include.path pulls in is refused by its own name.
  assert.deepEqual(
    unsafeRepoConfig(
      listing(['local', 'include.path\n/example/planted.inc'], ['local', 'filter.x.process\n/example/planted']),
    ),
    { code: 'REPO_CONFIG_UNSAFE', key: 'filter.x.process', scope: 'local' },
  );
  // Output that does not parse is no answer, and is refused as one.
  for (const broken of ['local\0filter.x.clean', 'local\0', 'local\0core.bare\nfalse\0local\0'])
    assert.deepEqual(unsafeRepoConfig(broken), { code: 'REPO_CONFIG_UNREADABLE', key: null, scope: null });
  assert.equal(unsafeRepoConfig(''), null);
});

test('a refusal names the key and its scope, never the value, and shows a subsection as plain characters', () => {
  assert.equal(repoConfigKeyShown('filter.x.process'), 'filter.x.process');
  assert.equal(repoConfigKeyShown('filter.we"ird\ttab\u001b[31m.smudge'), 'filter.we?ird?tab??31m.smudge');
  assert.equal(repoConfigKeyShown('filter.a.b.c.clean'), 'filter.a.b.c.clean');
  assert.equal(repoConfigKeyShown('include.path'), 'include.path');
  const long = repoConfigKeyShown(`filter.${'x'.repeat(300)}.process`);
  assert.equal(long, `filter.${'x'.repeat(127)}….process`);
  const refusal = unsafeRepoConfig('local\0filter.x.process\nrm -rf /example/home\0');
  assert.deepEqual(refusal, { code: 'REPO_CONFIG_UNSAFE', key: 'filter.x.process', scope: 'local' });
  assert.equal(JSON.stringify(refusal).includes('rm -rf'), false);
});

test("the gate over real git: a repository's own driver and include are refused; the person's global LFS is not", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRepository(async (box) => {
    const git = runner(box);
    assert.equal(await repoConfigRefusal(git, box.repo), null, 'a fresh repository passes');
    // What the runner overrides, set in the repository's own config, passes: A has it.
    plain(box, 'config', 'core.editor', '/example/editor');
    plain(box, 'config', 'core.fsmonitor', '/example/planted');
    plain(box, 'config', 'alias.st', '!/example/planted');
    assert.equal(await repoConfigRefusal(git, box.repo), null);
    // The person's own LFS, in a stand-in global config.
    writeFileSync(
      join(box.home, '.gitconfig'),
      '[filter "lfs"]\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n',
    );
    assert.equal(await repoConfigRefusal(git, box.repo), null);
    await assertSafeRepoConfig(git, box.repo);
    // The same filter in the repository's own config is a planted one.
    plain(box, 'config', 'filter.lfs.process', '/example/planted');
    assert.deepEqual(await repoConfigRefusal(git, box.repo), {
      code: 'REPO_CONFIG_UNSAFE',
      key: 'filter.lfs.process',
      scope: 'local',
    });
    await assert.rejects(
      assertSafeRepoConfig(git, box.repo),
      (error: unknown) =>
        error instanceof CommsError &&
        error.code === 'BAD_DATA' &&
        (error.details as { reason?: unknown }).reason === 'REPO_CONFIG_UNSAFE' &&
        error.message.includes('(filter.lfs.process, local)') &&
        !error.message.includes('/example/planted'),
    );
    plain(box, 'config', '--unset', 'filter.lfs.process');
    // An include in a worktree's own config (extensions.worktreeConfig) is the worktree scope's.
    plain(box, 'config', 'extensions.worktreeConfig', 'true');
    plain(box, 'config', '--worktree', 'include.path', join(box.root, 'planted.inc'));
    assert.deepEqual(await repoConfigRefusal(git, box.repo), {
      code: 'REPO_CONFIG_UNSAFE',
      key: 'include.path',
      scope: 'worktree',
    });
  });
});

test('a config git cannot read is no answer, and is refused', { skip: WINDOWS_SKIP }, async () => {
  await withRepository(async (box) => {
    writeFileSync(join(box.repo, '.git', 'config'), '[core\n\tbare = false\n');
    assert.deepEqual(await repoConfigRefusal(runner(box), box.repo), {
      code: 'REPO_CONFIG_UNREADABLE',
      key: null,
      scope: null,
    });
    // As is one too long to read whole: the runner reads 64 KiB.
    const runnerCut = createGitRunner({
      env: { PATH: '/usr/bin', HOME: box.home },
      execFile: (_file, _args, _options, callback) =>
        callback(Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'local\0'),
    });
    assert.deepEqual(await repoConfigRefusal(runnerCut, box.repo), {
      code: 'REPO_CONFIG_UNREADABLE',
      key: null,
      scope: null,
    });
  });
});
