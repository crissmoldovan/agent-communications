import assert from 'node:assert/strict';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProjectV1 } from '../src/domain/projects.ts';
import { madeWorktreesOf, withProjectSessions } from '../src/runtime/project-sessions.ts';
import { projectControl } from '../src/runtime/projects.ts';
import { RelayClient, RelayError, readRelayToken } from '../src/runtime/relay-client.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { FakeRelay } from './support/fake-relay.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome } from './support/stand-ins.ts';

/*
 * Which sessions are working in each project, busy or idle (0.36): `project show` and `projects list` ask the loopback
 * fake relay, as C3's steps do. No real claude-stream; folders are a stand-in home's; a session's title, which another
 * client may have written, never comes back.
 */

const PERSON = 'person-setup:terminal';
const SENTINEL_TITLE = 'SENTINEL a title someone else wrote';

const projectAt = (folder: string): ProjectV1 => ({
  projectId: 'acme-site',
  name: 'acme-site',
  repo: 'github.com/example/acme-site',
  profile: '',
  profileBy: null,
  profileAt: null,
  hints: { senderDomains: [], slackConversations: [], people: [] },
  folders: [{ folder, kind: 'checkout', defaultBranch: 'main', worktreeRoot: null }],
  createdAt: 1,
  updatedAt: 1,
});

test('a project lists the relay sessions in its folders and run-made worktrees: busy, idle, watched; never a title', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await realpath(await shortTempDir('aev-project-sessions-'));
  const { homeDirectory } = await standInHome(root);
  const checkout = join(homeDirectory, 'work', 'acme-site');
  const tree = join(homeDirectory, 'work', 'acme-site-wt', 'ac-acme-1');
  const elsewhere = join(homeDirectory, 'work', 'billing');
  for (const folder of [checkout, tree, elsewhere]) await mkdir(folder, { recursive: true });
  const relay = await new FakeRelay({ allowedRoots: [join(homeDirectory, 'work')] }).start();
  try {
    const client = new RelayClient({
      url: relay.url,
      token: await readRelayToken(await relay.writeHome(root)),
      attestListener: async () => ({ kind: 'unattested', platform: 'test' }),
    });
    const idle = relay.addSession({ cwd: checkout, title: SENTINEL_TITLE, createdAt: '2026-10-27T08:00:00.000Z' });
    const busy = relay.addSession({ cwd: tree, provider: 'codex', createdAt: '2026-10-27T07:00:00.000Z' });
    relay.startRunElsewhere(busy.id);
    const watched = relay.addSession({ cwd: checkout, attached: 'observer', createdAt: '2026-10-27T06:00:00.000Z' });
    relay.addSession({ cwd: elsewhere });
    relay.addSession({ cwd: checkout, executor: { generation: 2, state: 'moved' } });
    const [project] = await withProjectSessions([projectAt(checkout)], {
      relay: async () => ({ client }),
      madeWorktrees: () => [tree],
    });
    assert.ok(project);
    assert.equal(project.sessionsReason, null);
    assert.deepEqual(
      project.sessions?.map(({ session, provider, state, folder }) => ({ session, provider, state, folder })),
      [
        { session: busy.id, provider: 'codex', state: 'busy', folder: tree },
        { session: idle.id, provider: 'claude', state: 'idle', folder: checkout },
        { session: watched.id, provider: 'claude', state: 'watched', folder: checkout },
      ],
    );
    for (const session of project.sessions ?? []) assert.equal(typeof session.lastActiveAt, 'number');
    assert.equal(JSON.stringify(project).includes('SENTINEL'), false, 'no title comes back');
    // The relay down: no sessions, the relay's reason, and the project still read.
    await relay.stop();
    const [down] = await withProjectSessions([projectAt(checkout)], {
      relay: async () => ({ client }),
      madeWorktrees: () => [],
    });
    assert.deepEqual([down?.projectId, down?.sessions, down?.sessionsReason], ['acme-site', null, 'RELAY_UNREACHABLE']);
    const [missing] = await withProjectSessions([projectAt(checkout)], {
      relay: async () => {
        throw new RelayError('RELAY_NOT_FOUND', 'no relay');
      },
      madeWorktrees: () => [],
    });
    assert.deepEqual([missing?.sessions, missing?.sessionsReason], [null, 'RELAY_NOT_FOUND']);
  } finally {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('project show and projects list answer with the sessions working in each project', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await realpath(await shortTempDir('aev-project-sessions-owner-'));
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  const relay = await new FakeRelay().start();
  try {
    const { homeDirectory } = await standInHome(root);
    const checkout = join(homeDirectory, 'work', 'acme-site');
    await mkdir(checkout, { recursive: true });
    store.database
      .prepare(
        "INSERT INTO projects (id, name, repo, created_at, updated_at) VALUES ('acme-site', 'acme-site', 'github.com/example/acme-site', 1, 1)",
      )
      .run();
    store.database
      .prepare(
        "INSERT INTO project_folders (folder, project_id, kind, default_branch) VALUES (?, 'acme-site', 'checkout', 'main')",
      )
      .run(checkout);
    const tree = join(homeDirectory, 'work', 'acme-site-wt', 'ac-acme-2');
    store.database
      .prepare(
        "INSERT INTO workflow_worktrees (run_id, step_id, project_id, checkout, path, branch, state, created_at) VALUES ('wfr_0123456789abcdefghjkmnpqrs', 'tree', 'acme-site', ?, ?, 'ac/acme-2', 'made', 1)",
      )
      .run(checkout, tree);
    store.database
      .prepare(
        "INSERT INTO workflow_worktrees (run_id, step_id, project_id, checkout, path, branch, state, created_at) VALUES ('wfr_0123456789abcdefghjkmnpqrt', 'tree', 'acme-site', ?, ?, 'ac/acme-3', 'removed', 1)",
      )
      .run(checkout, join(homeDirectory, 'work', 'acme-site-wt', 'ac-acme-3'));
    assert.deepEqual(madeWorktreesOf(store.database, 'acme-site'), [tree]);
    const client = new RelayClient({
      url: relay.url,
      token: await readRelayToken(await relay.writeHome(root)),
      attestListener: async () => ({ kind: 'unattested', platform: 'test' }),
    });
    const session = relay.addSession({ cwd: tree });
    const deps = {
      store,
      sessions: {
        sessionRoots: async () => [join(homeDirectory, 'work')],
        deniedFolders: () => [],
        homeFolder: () => homeDirectory,
        relay: async () => ({ client }),
      },
    };
    const shown = (await projectControl(deps, {
      operation: 'project-show',
      args: { projectId: 'acme-site' },
      origin: PERSON,
    })) as ProjectV1;
    assert.deepEqual(
      shown.sessions?.map((entry) => [entry.session, entry.state, entry.folder]),
      [[session.id, 'idle', tree]],
    );
    const listed = (await projectControl(deps, { operation: 'projects-list', args: {}, origin: PERSON })) as {
      projects: ProjectV1[];
    };
    assert.deepEqual(listed.projects[0]?.sessions, shown.sessions);
  } finally {
    await relay.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
