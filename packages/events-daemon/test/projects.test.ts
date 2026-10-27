import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin } from '@agentcomms/core';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { canonicalProject, foldGitHubRepo, PROJECT_LIMITS, type ProjectV1 } from '../src/domain/projects.ts';
import { createGitRunner, GIT_FIXED_OPTIONS, type GitExecOptions } from '../src/runtime/git.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { scanProjects } from '../src/runtime/project-scan.ts';
import { Projects, projectControl } from '../src/runtime/projects.ts';
import { RelayError } from '../src/runtime/relay-client.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome, standInSecrets } from './support/stand-ins.ts';

/*
 * Projects (0.36.0 workflows design §8.1): `project scan` over temporary git repositories made with the real `git`
 * binary under a stand-in home, `Projects` over a real event database, the person-only refusals of every project
 * command, and the git runner's own guarantees. Nothing here reads the person's folders: every root is a temporary
 * one, and git runs with the stand-in home as its HOME.
 */

const PERSON = 'person-setup:terminal';

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly work: string;
  readonly env: NodeJS.ProcessEnv;
}

async function sandbox(prefix: string): Promise<Sandbox> {
  const root = await realpath(await shortTempDir(prefix));
  const { homeDirectory } = await standInHome(root);
  const work = join(homeDirectory, 'work');
  mkdirSync(work, { recursive: true });
  return {
    root,
    home: homeDirectory,
    work,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homeDirectory, GIT_CONFIG_NOSYSTEM: '1' },
  };
}

/** git for the test's own setup, as the stand-in home's person, with no hooks. */
function git(box: Sandbox, cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
}

function repo(box: Sandbox, path: string, origin: string | null): string {
  mkdirSync(path, { recursive: true });
  git(box, path, 'init', '-q', '-b', 'main');
  git(box, path, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin !== null) git(box, path, 'remote', 'add', 'origin', origin);
  return path;
}

function runner(box: Sandbox) {
  return createGitRunner({ env: { PATH: box.env.PATH, HOME: box.home } });
}

test('scan groups checkouts by their GitHub origin, https and ssh alike, with their worktrees', {
  skip: WINDOWS_SKIP,
}, async () => {
  const box = await sandbox('aev-scan-group-');
  try {
    const site = repo(box, join(box.work, 'acme-site'), 'https://github.com/Example/acme-site.git');
    const copy = repo(box, join(box.work, 'clients', 'acme-copy'), 'git@github.com:example/acme-site.git');
    const billing = repo(box, join(box.work, 'billing'), 'ssh://git@github.com/example/billing');
    repo(box, join(box.work, 'elsewhere'), 'https://gitlab.example/example/elsewhere.git');
    mkdirSync(join(box.work, 'acme-site-wt'));
    git(box, site, 'worktree', 'add', '-q', '-b', 'ac/acme-1', join(box.work, 'acme-site-wt', 'ac-acme-1'));
    git(box, site, 'worktree', 'add', '-q', '-b', 'claude', join(site, '.claude', 'worktrees', 'claude'));
    const result = await scanProjects({ roots: [box.work], maxDepth: 4, git: runner(box), known: () => null });
    assert.deepEqual(result.roots, [box.work]);
    assert.deepEqual(result.repos, [
      {
        repo: 'github.com/example/acme-site',
        known: null,
        folders: [
          { folder: site, kind: 'checkout', defaultBranch: 'main' },
          { folder: copy, kind: 'checkout', defaultBranch: 'main' },
          { folder: join(site, '.claude', 'worktrees', 'claude'), kind: 'worktree', defaultBranch: null },
          { folder: join(box.work, 'acme-site-wt', 'ac-acme-1'), kind: 'worktree', defaultBranch: null },
        ].sort((left, right) =>
          left.kind === right.kind ? (left.folder < right.folder ? -1 : 1) : left.kind === 'checkout' ? -1 : 1,
        ),
      },
      {
        repo: 'github.com/example/billing',
        known: null,
        folders: [{ folder: billing, kind: 'checkout', defaultBranch: 'main' }],
      },
    ]);
    assert.equal(foldGitHubRepo('example/acme-site'), 'github.com/example/acme-site');
    assert.equal(foldGitHubRepo('https://github.com/example/acme-site/'), 'github.com/example/acme-site');
    assert.equal(foldGitHubRepo('https://gitlab.example/example/acme-site'), null);
    assert.equal(foldGitHubRepo('github.com/example/acme-site/extra'), null);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("scan follows no symlink, skips hidden folders but .claude/worktrees, and skips Agent Comms' folders", {
  skip: WINDOWS_SKIP,
}, async () => {
  const box = await sandbox('aev-scan-skip-');
  try {
    const outside = repo(box, join(box.root, 'outside', 'secret-client'), 'https://github.com/example/secret-client');
    symlinkSync(join(box.root, 'outside'), join(box.work, 'clients-link'));
    repo(box, join(box.work, '.archive', 'old'), 'https://github.com/example/old');
    const own = join(box.work, 'agentcomms-state');
    repo(box, join(own, 'inside'), 'https://github.com/example/inside');
    const holder = join(box.work, 'holder');
    repo(box, join(holder, '.claude', 'worktrees', 'kept'), 'https://github.com/example/kept');
    const result = await scanProjects({ roots: [box.work], maxDepth: 4, git: runner(box), deniedFolders: [own] });
    assert.deepEqual(
      result.repos.map((entry) => entry.repo),
      ['github.com/example/kept'],
    );
    assert.deepEqual(
      [...result.skipped].sort((left, right) => (left.folder < right.folder ? -1 : 1)),
      [
        { folder: join(box.work, '.archive'), reason: 'hidden' },
        { folder: own, reason: 'agent-comms' },
        { folder: join(box.work, 'clients-link'), reason: 'symlink' },
      ],
    );
    assert.equal(JSON.stringify(result).includes(outside), false, 'nothing behind the symlink is listed');
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test('scan stops at depth 4', { skip: WINDOWS_SKIP }, async () => {
  const box = await sandbox('aev-scan-depth-');
  try {
    const four = repo(box, join(box.work, 'a', 'b', 'c', 'four'), 'https://github.com/example/four');
    repo(box, join(box.work, 'a', 'b', 'c', 'd', 'five'), 'https://github.com/example/five');
    const result = await scanProjects({ roots: [box.work], maxDepth: 4, git: runner(box) });
    assert.deepEqual(result.repos, [
      {
        repo: 'github.com/example/four',
        known: null,
        folders: [{ folder: four, kind: 'checkout', defaultBranch: 'main' }],
      },
    ]);
    assert.deepEqual(result.skipped, [{ folder: join(box.work, 'a', 'b', 'c', 'd'), reason: 'depth' }]);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

async function withProjects(
  box: Sandbox,
  work: (projects: Projects, store: EventDatabase) => Promise<void>,
): Promise<void> {
  const store = await openEventDatabase({ stateDir: join(box.root, 'state') });
  try {
    await standInSecrets(store.database);
    let now = 1_793_000_000_000;
    const projects = new Projects({
      store,
      git: runner(box),
      roots: async () => [box.work],
      deniedFolders: () => [join(box.root, 'state'), join(box.work, 'agentcomms-state')],
      homeDirectory: () => box.home,
      now: () => {
        now += 1000;
        return now;
      },
    });
    await work(projects, store);
  } finally {
    store.close();
  }
}

const documentFor = (folder: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId: 'acme-site',
  name: 'acme-site',
  repo: 'example/acme-site',
  profile: 'The Acme site: its pages and its booking form.',
  hints: { senderDomains: ['Acme.Example'], slackConversations: ['c0123abcd'], people: ['U0123ABCD'] },
  folders: [{ folder, kind: 'checkout', defaultBranch: 'main', worktreeRoot: null }],
  ...overrides,
});

function refusedWith(reason: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal((error.details as { reason?: string } | undefined)?.reason, reason, error.message);
    return true;
  };
}

test("add refuses a folder outside the allowed roots and a folder that is not the repo's checkout", {
  skip: WINDOWS_SKIP,
}, async () => {
  const box = await sandbox('aev-project-add-');
  try {
    const site = repo(box, join(box.work, 'acme-site'), 'https://github.com/example/acme-site.git');
    const other = repo(box, join(box.work, 'billing'), 'https://github.com/example/billing.git');
    const away = repo(box, join(box.root, 'away', 'acme-site'), 'https://github.com/example/acme-site.git');
    const plain = join(box.work, 'plain');
    mkdirSync(plain);
    symlinkSync(site, join(box.work, 'site-link'));
    const own = repo(box, join(box.work, 'agentcomms-state', 'acme'), 'https://github.com/example/acme-site.git');
    await withProjects(box, async (projects) => {
      await assert.rejects(projects.add(documentFor(away)), refusedWith('OUTSIDE_ALLOWED_ROOTS'));
      await assert.rejects(projects.add(documentFor(other)), refusedWith('NOT_THE_REPOSITORY'));
      await assert.rejects(projects.add(documentFor(plain)), refusedWith('NOT_A_CHECKOUT'));
      await assert.rejects(projects.add(documentFor(join(box.work, 'site-link'))), refusedWith('FOLDER_NOT_REAL'));
      await assert.rejects(projects.add(documentFor(own)), refusedWith('AGENT_COMMS_FOLDER'));
      await assert.rejects(
        projects.add(
          documentFor(site, { folders: [{ folder: site, kind: 'worktree', defaultBranch: null, worktreeRoot: null }] }),
        ),
        refusedWith('FOLDER_KIND'),
      );
      assert.deepEqual(projects.list(), { projects: [] }, 'nothing refused was kept');

      const added = await projects.add(documentFor(site));
      assert.deepEqual(added, {
        projectId: 'acme-site',
        name: 'acme-site',
        repo: 'github.com/example/acme-site',
        profile: 'The Acme site: its pages and its booking form.',
        profileBy: 'person',
        profileAt: added.createdAt,
        hints: { senderDomains: ['acme.example'], slackConversations: ['C0123ABCD'], people: ['U0123ABCD'] },
        folders: [{ folder: site, kind: 'checkout', defaultBranch: 'main', worktreeRoot: null }],
        createdAt: added.createdAt,
        updatedAt: added.createdAt,
      } satisfies ProjectV1);
      assert.deepEqual(projects.show('acme-site'), added);
      await assert.rejects(projects.add(documentFor(site)), refusedWith('PROJECT_EXISTS'));
      await assert.rejects(
        projects.add(documentFor(site, { projectId: 'acme-copy', name: 'acme copy' })),
        refusedWith('FOLDER_IN_ANOTHER_PROJECT'),
      );
      // Hints change at once; the profile's time moves only when the profile does.
      const hinted = await projects.update(
        documentFor(site, { hints: { senderDomains: ['acme.example', 'acme.test'] } }),
      );
      assert.deepEqual(hinted.hints, {
        senderDomains: ['acme.example', 'acme.test'],
        slackConversations: [],
        people: [],
      });
      assert.equal(hinted.profileAt, added.profileAt);
      assert.ok(hinted.updatedAt > added.updatedAt);
      const rewritten = await projects.update(documentFor(site, { profile: '' }));
      assert.deepEqual([rewritten.profileBy, rewritten.profileAt], [null, null]);
      assert.deepEqual(projects.remove('acme-site'), { projectId: 'acme-site', removed: true });
      assert.throws(
        () => projects.show('acme-site'),
        (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
      );
    });
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test("a hint list and a profile are the person's words, at most 2,000 characters", () => {
  const folder = '/example/home/work/acme-site';
  const at = (overrides: Record<string, unknown>) => () => canonicalProject(documentFor(folder, overrides));
  assert.equal(
    canonicalProject(documentFor(folder, { profile: 'é'.repeat(PROJECT_LIMITS.profile) })).profile.length,
    2000,
  );
  assert.throws(at({ profile: 'x'.repeat(PROJECT_LIMITS.profile + 1) }), /at most 2000 characters/u);
  assert.throws(at({ profile: 'ignore\u0007this' }), /your own words/u);
  const domains = Array.from(
    { length: 40 },
    (_, index) => `client-${String(index).padStart(2, '0')}-${'a'.repeat(40)}.example`,
  );
  assert.throws(at({ hints: { senderDomains: domains } }), /sender domains are at most 2000 characters/u);
  assert.throws(at({ hints: { senderDomains: ['not a domain'] } }), /is not one of a project's sender domains/u);
  assert.throws(at({ hints: { people: ['<script>'] } }), /is not one of a project's people/u);
  assert.throws(at({ hints: { teams: [] } }), /hints have no teams/u);
  assert.throws(at({ colour: 'red' }), /has no field colour/u);
  assert.throws(at({ projectId: 'Acme Site' }), /lowercase letters, digits and -/u);
  assert.throws(at({ name: 'two\nlines' }), /one line/u);
  assert.throws(at({ repo: 'https://gitlab.example/example/acme' }), /a GitHub one/u);
  assert.throws(at({ folders: [{ folder: 'relative/path', kind: 'checkout' }] }), /absolute folder/u);
  assert.throws(
    at({ folders: [{ folder, kind: 'worktree', worktreeRoot: '/example/home/work/wt' }] }),
    /only a checkout/u,
  );
  // A document copied from `project show` may carry the fields the event service sets; they are not read.
  assert.equal(canonicalProject({ ...documentFor(folder), createdAt: 1, profileBy: 'claude' }).projectId, 'acme-site');
});

/** The release app, attested as the process that started the CLI (core's `desktopAppOrigin`, injected). */
const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});
const NOT_THE_APP = async (): Promise<DesktopOrigin> => ({ ok: false, reason: 'not-started-by-the-app' });

async function cli(
  args: readonly string[],
  options: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly origin?: () => Promise<DesktopOrigin>;
  } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const streams: EventsCliStreams = { stdin, stdout, stderr };
  const code = await run(args, { streams, env: options.env ?? {}, desktopOrigin: options.origin ?? ATTESTED });
  return { code, stdout: out, stderr: err };
}

const projectCommands: readonly (readonly string[])[] = [
  ['projects', 'list'],
  ['project', 'show', 'acme-site'],
  ['project', 'add', '-'],
  ['project', 'update', '-'],
  ['project', 'remove', 'acme-site'],
  ['project', 'scan'],
];

for (const command of projectCommands)
  test(`${command.join(' ')} exits 10 inside the MCP marker and an agent's shell`, { skip: WINDOWS_SKIP }, async () => {
    const stateDir = await shortTempDir('aev-project-cli-');
    try {
      const inside = await cli(['--state-dir', stateDir, '--json', ...command], {
        env: { AGENTCOMMS_MCP_SERVER: 'events' },
        stdin: '{}',
      });
      assert.equal(inside.code, 10, inside.stderr);
      assert.match(inside.stderr, /projects are for a person, at a terminal or in the app/u);
      for (const marker of ['CLAUDECODE', 'CODEX_SANDBOX', 'CURSOR_AGENT']) {
        const agent = await cli(['--state-dir', stateDir, '--json', ...command], {
          env: { [marker]: '1' },
          stdin: '{}',
        });
        assert.equal(agent.code, 10, `${marker}: ${agent.stderr}`);
        assert.match(agent.stderr, /only a person can/u);
      }
      // On macOS a process the app did not start, and that is no terminal, is refused too.
      const piped = await cli(['--state-dir', stateDir, '--json', ...command], { origin: NOT_THE_APP, stdin: '{}' });
      assert.equal(piped.code, 10, piped.stderr);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

test('git runs with no shell, no GIT_* variables and hooks off', async () => {
  const recordedGit: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv; options: GitExecOptions }[] = [];
  const git = createGitRunner({
    env: { PATH: '/usr/bin', HOME: '/example/home', GIT_DIR: '/example/elsewhere/.git', git_work_tree: '/example/x' },
    execFile: (file, args, options, callback) => {
      recordedGit.push({ file, args, env: options.env, options });
      callback(null, 'x'.repeat(70_000));
    },
  });
  const result = await git.run(['config', '--get', 'remote.origin.url'], '/example/home/work/acme-site');
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 64 * 1024, 'what git prints is read up to 64 KiB');
  assert.deepEqual(recordedGit.at(0)?.env.GIT_DIR, undefined);
  assert.equal(recordedGit.at(0)?.env.git_work_tree, undefined);
  assert.deepEqual(recordedGit.at(0)?.env, { PATH: '/usr/bin', HOME: '/example/home' });
  assert.ok(recordedGit.at(0)?.file.startsWith('/'), "git's path is absolute");
  assert.deepEqual(recordedGit.at(0)?.args, [...GIT_FIXED_OPTIONS, 'config', '--get', 'remote.origin.url']);
  assert.equal(recordedGit.at(0)?.options.shell, false);
  assert.equal(recordedGit.at(0)?.options.timeout, 60_000);
  assert.equal(recordedGit.at(0)?.options.maxBuffer, 64 * 1024);
  assert.equal(recordedGit.at(0)?.options.cwd, '/example/home/work/acme-site');
  assert.deepEqual(await git.run(['status'], 'relative'), { code: -1, stdout: '' }, 'a relative folder runs nothing');
  assert.equal(recordedGit.length, 1);
});

test('the owner takes a project only from the person, never from a window or another client', {
  skip: WINDOWS_SKIP,
}, async () => {
  const box = await sandbox('aev-project-owner-');
  try {
    const site = repo(box, join(box.work, 'acme-site'), 'https://github.com/example/acme-site.git');
    const store = await openEventDatabase({ stateDir: join(box.root, 'state') });
    try {
      const deps = {
        store,
        git: runner(box),
        sessions: {
          sessionRoots: async () => [box.work],
          deniedFolders: () => [],
          homeFolder: () => box.home,
          relay: async () => {
            throw new RelayError('RELAY_NOT_FOUND', 'no relay in a stand-in home');
          },
        },
      };
      await assert.rejects(
        projectControl(deps, { operation: 'projects-list', args: {}, origin: 'events-cli' }),
        (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_REQUIRED',
      );
      await assert.rejects(
        projectControl(deps, { operation: 'projects-list', args: { caller: { windowId: 'w' } }, origin: PERSON }),
        (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_REQUIRED',
      );
      await assert.rejects(
        projectControl(deps, { operation: 'projects-list', args: { extra: true }, origin: PERSON }),
        (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
      );
      const added = (await projectControl(deps, {
        operation: 'project-add',
        args: { document: documentFor(site) },
        origin: 'person-setup:desktop-app',
      })) as ProjectV1;
      assert.equal(added.projectId, 'acme-site');
      // With no roots given, the scan walks the allowed roots, and names the project that has the repository.
      const scanned = (await projectControl(deps, { operation: 'project-scan', args: {}, origin: PERSON })) as {
        roots: string[];
        repos: { repo: string; known: string | null }[];
      };
      assert.deepEqual(scanned.roots, [box.work]);
      assert.deepEqual(scanned.repos, [
        {
          repo: 'github.com/example/acme-site',
          known: 'acme-site',
          folders: [{ folder: site, kind: 'checkout', defaultBranch: 'main' }],
        },
      ]);
    } finally {
      store.close();
    }
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
});

test('through a real owner: project add - from the app, then projects list', { skip: WINDOWS_SKIP }, async () => {
  const box = await sandbox('aev-project-e2e-');
  const stateDir = await shortTempDir('aev-project-state-');
  const home = await standInHome(box.root);
  const opened = await openEventDatabase({ stateDir });
  await standInSecrets(opened.database);
  opened.close();
  const owner = await startEventOwner({ ...home, stateDir, tickMs: 60_000 });
  try {
    const site = repo(box, join(box.work, 'acme-site'), 'git@github.com:example/acme-site.git');
    const allowed = await cli([
      '--state-dir',
      stateDir,
      '--json',
      'integration',
      'set',
      'agent-sessions',
      '--allow-folder',
      box.work,
    ]);
    assert.equal(allowed.code, 0, allowed.stderr);
    const added = await cli(['--state-dir', stateDir, '--json', 'project', 'add', '-'], {
      stdin: JSON.stringify(documentFor(site)),
    });
    assert.equal(added.code, 0, added.stderr);
    assert.equal((JSON.parse(added.stdout) as ProjectV1).repo, 'github.com/example/acme-site');
    const listed = await cli(['--state-dir', stateDir, '--json', 'projects', 'list']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(
      (JSON.parse(listed.stdout) as { projects: ProjectV1[] }).projects.map((project) => project.folders),
      [[{ folder: site, kind: 'checkout', defaultBranch: 'main', worktreeRoot: null }]],
    );
    const missing = await cli(['--state-dir', stateDir, '--json', 'project', 'show', 'billing']);
    assert.equal(missing.code, 66, missing.stderr);
  } finally {
    await owner.stop();
    await rm(stateDir, { recursive: true, force: true });
    await rm(box.root, { recursive: true, force: true });
  }
});
