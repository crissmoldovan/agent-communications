import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import { personSetupApprover } from '../domain/judge-setup.ts';
import {
  canonicalProject,
  foldGitHubRepo,
  isProjectFolder,
  PROJECT_LIMITS,
  type ProjectDocument,
  type ProjectFolderV1,
  type ProjectHintsV1,
  type ProjectRemoveResultV1,
  type ProjectScanResultV1,
  type ProjectsListResultV1,
  type ProjectV1,
  projectIdArgument,
} from '../domain/projects.ts';
import type { EventDatabase } from '../store/database.ts';
import { isInside, isTooWideRoot } from './agent-sessions.ts';
import { createGitRunner, type GitRunner } from './git.ts';
import { scanProjects } from './project-scan.ts';
import { madeWorktreesOf, withProjectSessions } from './project-sessions.ts';
import type { RelayClient } from './relay-client.ts';

/**
 * The person's projects (workflows design §8.1, W11, W12), kept in the event service beside the relay client, the
 * allowed roots and the denied folders it already holds. Adding or changing one checks each folder against the disk:
 * it is its own realpath, a checkout (`.git` a folder) or a worktree (`.git` a file) as the document says, of the
 * document's repository by its `remote.origin.url`, inside the folders a session may work in (the relay's allowed
 * roots, else the person's) and outside Agent Comms' own. A checkout's worktree root is held to the same roots.
 *
 * Every act here is the person's: the owner takes it only without a window's `caller` and from a person's origin (the
 * terminal, or the app), and the CLI refuses the event service's MCP server and an agent's shell first. No MCP tool
 * reaches any of it: an agent never reads the list (taking design T7), since project folders name clients.
 */

export interface ProjectsOptions {
  readonly store: EventDatabase;
  readonly git: GitRunner;
  /** The folders a project's folders must be inside: the relay's allowed roots, else the person's. */
  readonly roots: () => Promise<readonly string[]>;
  /** Agent Comms' own folders: never a project's. */
  readonly deniedFolders: () => readonly string[];
  /** The person's home folder, for a scan's default roots, `~/work` and `~/code`. */
  readonly homeDirectory: () => string;
  readonly now?: (() => number) | undefined;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly profile: string;
  readonly profile_by: string | null;
  readonly profile_at: number | null;
  readonly hints: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface FolderRow {
  readonly folder: string;
  readonly project_id: string;
  readonly kind: 'checkout' | 'worktree';
  readonly default_branch: string | null;
  readonly worktree_root: string | null;
}

function hintsOf(text: string): ProjectHintsV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const list = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  return {
    senderDomains: list(record.senderDomains),
    slackConversations: list(record.slackConversations),
    people: list(record.people),
  };
}

function projectOf(row: ProjectRow, folders: readonly FolderRow[]): ProjectV1 {
  return {
    projectId: row.id,
    name: row.name,
    repo: row.repo,
    profile: row.profile,
    profileBy: row.profile_by === 'person' ? 'person' : null,
    profileAt: row.profile_at,
    hints: hintsOf(row.hints),
    folders: folders.map(
      (folder): ProjectFolderV1 => ({
        folder: folder.folder,
        kind: folder.kind,
        defaultBranch: folder.default_branch,
        worktreeRoot: folder.worktree_root,
      }),
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROJECT_COLUMNS = 'id, name, repo, profile, profile_by, profile_at, hints, created_at, updated_at';
// A worktree a run made is recorded in workflow_worktrees, never as one of the person's folders.
const FOLDER_SELECT = `SELECT folder, project_id, kind, default_branch, worktree_root FROM project_folders
  WHERE made_by_run IS NULL`;

/** One project as it is now, or null: read straight from the store, for activation and the route step. */
export function readProject(database: DatabaseSync, projectId: string): ProjectV1 | null {
  const row = database.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(projectId) as
    | ProjectRow
    | undefined;
  if (row === undefined) return null;
  const folders = database
    .prepare(`${FOLDER_SELECT} AND project_id = ? ORDER BY folder`)
    .all(projectId) as unknown as FolderRow[];
  return projectOf(row, sortedFolders(folders));
}

/** Every project, by id. */
export function readProjects(database: DatabaseSync): readonly ProjectV1[] {
  const rows = database.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY id`).all() as unknown as ProjectRow[];
  const folders = database.prepare(`${FOLDER_SELECT} ORDER BY folder`).all() as unknown as FolderRow[];
  return rows.map((row) => projectOf(row, sortedFolders(folders.filter((folder) => folder.project_id === row.id))));
}

/** SQLite orders TEXT by its bytes, as `compareUtf8` does; sorted here again so the order never rests on a collation. */
function sortedFolders(folders: readonly FolderRow[]): readonly FolderRow[] {
  return [...folders].sort((left, right) => {
    const a = Buffer.from(left.folder);
    const b = Buffer.from(right.folder);
    return Buffer.compare(a, b);
  });
}

function refused(message: string, reason: string): never {
  throw new CommsError('BAD_DATA', message, { details: { reason } });
}

export class Projects {
  readonly #store: EventDatabase;
  readonly #git: GitRunner;
  readonly #roots: () => Promise<readonly string[]>;
  readonly #denied: () => readonly string[];
  readonly #home: () => string;
  readonly #now: () => number;

  constructor(options: ProjectsOptions) {
    this.#store = options.store;
    this.#git = options.git;
    this.#roots = options.roots;
    this.#denied = options.deniedFolders;
    this.#home = options.homeDirectory;
    this.#now = options.now ?? Date.now;
  }

  list(): ProjectsListResultV1 {
    return { projects: readProjects(this.#store.database) };
  }

  show(projectId: string): ProjectV1 {
    const project = readProject(this.#store.database, projectIdArgument(projectId));
    if (project === null) throw new CommsError('NOT_FOUND', `there is no project ${projectId}`);
    return project;
  }

  async add(document: unknown): Promise<ProjectV1> {
    const project = canonicalProject(document);
    if (readProject(this.#store.database, project.projectId) !== null)
      refused(`there is already a project ${project.projectId}: change it with project update`, 'PROJECT_EXISTS');
    await this.#checkFolders(project);
    const now = this.#now();
    this.#store.immediate(() => {
      this.#assertFree(project);
      this.#store.database
        .prepare(
          `INSERT INTO projects (id, name, repo, profile, profile_by, profile_at, hints, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.projectId,
          project.name,
          project.repo,
          project.profile,
          project.profile.length === 0 ? null : 'person',
          project.profile.length === 0 ? null : now,
          JSON.stringify(project.hints),
          now,
          now,
        );
      this.#insertFolders(project);
    });
    return this.show(project.projectId);
  }

  async update(document: unknown): Promise<ProjectV1> {
    const project = canonicalProject(document);
    const before = readProject(this.#store.database, project.projectId);
    if (before === null) throw new CommsError('NOT_FOUND', `there is no project ${project.projectId}`);
    await this.#checkFolders(project);
    const now = this.#now();
    const profileChanged = before.profile !== project.profile;
    this.#store.immediate(() => {
      this.#assertFree(project);
      this.#store.database
        .prepare(
          `UPDATE projects SET name = ?, repo = ?, profile = ?, profile_by = ?, profile_at = ?, hints = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          project.name,
          project.repo,
          project.profile,
          profileChanged ? (project.profile.length === 0 ? null : 'person') : before.profileBy,
          profileChanged ? (project.profile.length === 0 ? null : now) : before.profileAt,
          JSON.stringify(project.hints),
          now,
          project.projectId,
        );
      this.#store.database
        .prepare('DELETE FROM project_folders WHERE project_id = ? AND made_by_run IS NULL')
        .run(project.projectId);
      this.#insertFolders(project);
    });
    return this.show(project.projectId);
  }

  remove(projectId: string): ProjectRemoveResultV1 {
    const id = projectIdArgument(projectId);
    const removed = this.#store.immediate(
      () => this.#store.database.prepare('DELETE FROM projects WHERE id = ?').run(id).changes,
    );
    if (removed === 0) throw new CommsError('NOT_FOUND', `there is no project ${id}`);
    return { projectId: id, removed: true };
  }

  /** The repositories under `roots`, or under the relay's allowed roots, else `~/work` and `~/code`. */
  async scan(roots: readonly string[] | undefined): Promise<ProjectScanResultV1> {
    const given = roots === undefined || roots.length === 0 ? undefined : roots;
    if (given !== undefined) {
      if (given.length > PROJECT_LIMITS.scanRoots)
        throw new CommsError('USAGE', `a scan takes at most ${PROJECT_LIMITS.scanRoots} roots`);
      for (const root of given)
        if (!isProjectFolder(root) || isTooWideRoot(root, '/'))
          throw new CommsError('USAGE', 'a root is an absolute folder, written without . or .. steps or a trailing /');
    }
    let scanned = given;
    if (scanned === undefined) {
      const allowed = await this.#roots();
      scanned = allowed.length > 0 ? allowed : [join(this.#home(), 'work'), join(this.#home(), 'code')];
    }
    const database = this.#store.database;
    const known = database.prepare('SELECT id FROM projects WHERE repo = ? ORDER BY id LIMIT 1');
    return scanProjects({
      roots: [...new Set(scanned)],
      maxDepth: 4,
      git: this.#git,
      deniedFolders: this.#denied(),
      known: (repo) => (known.get(repo) as { id: string } | undefined)?.id ?? null,
    });
  }

  /** No folder of `project` is another project's. Inside the write's transaction. */
  #assertFree(project: ProjectDocument): void {
    const owner = this.#store.database.prepare('SELECT project_id FROM project_folders WHERE folder = ?');
    for (const folder of project.folders) {
      const row = owner.get(folder.folder) as { project_id: string } | undefined;
      if (row !== undefined && row.project_id !== project.projectId)
        refused(`the folder ${folder.folder} is already the project ${row.project_id}'s`, 'FOLDER_IN_ANOTHER_PROJECT');
    }
    const named = this.#store.database
      .prepare('SELECT id FROM projects WHERE name = ? AND id <> ?')
      .get(project.name, project.projectId) as { id: string } | undefined;
    if (named !== undefined)
      refused(`the project ${named.id} is already called ${project.name}`, 'PROJECT_NAME_IN_USE');
  }

  #insertFolders(project: ProjectDocument): void {
    const insert = this.#store.database.prepare(
      `INSERT INTO project_folders (folder, project_id, kind, default_branch, worktree_root, made_by_run, made_by_step)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    );
    for (const folder of project.folders)
      insert.run(folder.folder, project.projectId, folder.kind, folder.defaultBranch, folder.worktreeRoot);
  }

  /** Each folder is what the document says it is, where a project's folder may be. */
  async #checkFolders(project: ProjectDocument): Promise<void> {
    const roots = await this.#roots();
    const denied = this.#denied();
    const placed = (folder: string, what: string) => {
      if (denied.some((own) => isInside(folder, own) || isInside(own, folder)))
        refused(`${what} ${folder} is one of Agent Comms' own folders, or holds one`, 'AGENT_COMMS_FOLDER');
      if (roots.length === 0)
        refused(
          `${what} ${folder} cannot be checked: the relay does not say its allowed roots, and none is set: add its root in Settings → Integrations → Agent sessions (integration set agent-sessions --allow-folder)`,
          'NO_ALLOWED_ROOTS',
        );
      if (!roots.some((root) => isInside(folder, root)))
        refused(`${what} ${folder} is not inside the relay's allowed roots`, 'OUTSIDE_ALLOWED_ROOTS');
    };
    for (const entry of project.folders) {
      placed(entry.folder, 'the folder');
      let real: string;
      try {
        real = await realpath(entry.folder);
      } catch {
        refused(`the folder ${entry.folder} is not there`, 'FOLDER_MISSING');
      }
      if (real !== entry.folder)
        refused(`the folder ${entry.folder} is not its own real path: give ${real}`, 'FOLDER_NOT_REAL');
      const marker = await lstat(join(entry.folder, '.git')).catch(() => undefined);
      const kind = marker?.isDirectory() === true ? 'checkout' : marker?.isFile() === true ? 'worktree' : undefined;
      if (kind === undefined) refused(`the folder ${entry.folder} is not a git checkout or worktree`, 'NOT_A_CHECKOUT');
      if (kind !== entry.kind) refused(`the folder ${entry.folder} is a ${kind}, not a ${entry.kind}`, 'FOLDER_KIND');
      const origin = await this.#git.run(['config', '--get', 'remote.origin.url'], entry.folder);
      const repo = origin.code === 0 ? foldGitHubRepo(origin.stdout.trim()) : null;
      if (repo !== project.repo)
        refused(`the folder ${entry.folder} is not a checkout of ${project.repo}`, 'NOT_THE_REPOSITORY');
      if (entry.worktreeRoot !== null) {
        placed(entry.worktreeRoot, 'the worktree root');
        const root = await lstat(entry.worktreeRoot).catch(() => undefined);
        if (root?.isSymbolicLink() === true)
          refused(`the worktree root ${entry.worktreeRoot} is a symlink`, 'WORKTREE_ROOT_SYMLINK');
        if (root !== undefined && (await realpath(entry.worktreeRoot)) !== entry.worktreeRoot)
          refused(`the worktree root ${entry.worktreeRoot} is not its own real path`, 'FOLDER_NOT_REAL');
      }
    }
  }
}

/** What the owner gives `projectControl`: the store, and the agent-session service's roots, denied folders and home. */
export interface ProjectControlDeps {
  readonly store: EventDatabase;
  readonly sessions: {
    sessionRoots(): Promise<readonly string[]>;
    deniedFolders(): readonly string[];
    homeFolder(): string;
    /** The person's relay, for which sessions work in each project (`project show`, `projects list`). */
    relay(): Promise<{ readonly client: Pick<RelayClient, 'sessions' | 'snapshot'> }>;
  };
  readonly git?: GitRunner | undefined;
  readonly now?: (() => number) | undefined;
}

/** The project wires (plan I6). */
export const PROJECT_CONTROL_OPERATIONS: readonly [
  'projects-list',
  'project-show',
  'project-add',
  'project-update',
  'project-remove',
  'project-scan',
] = Object.freeze([
  'projects-list',
  'project-show',
  'project-add',
  'project-update',
  'project-remove',
  'project-scan',
] as const);

/**
 * The owner's one call for every project wire: the person's alone. A window's call (`caller`) is refused, and so is
 * any client that is not the person's — the terminal, or the app — as `integration set` is.
 */
export async function projectControl(
  deps: ProjectControlDeps,
  request: {
    readonly operation: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly origin?: string | undefined;
  },
): Promise<unknown> {
  if (Object.hasOwn(request.args, 'caller'))
    throw new CommsError(
      'APPROVAL_REQUIRED',
      'projects are for a person, at a terminal or in the app, not an agent window',
    );
  if (personSetupApprover(request.origin) === null)
    throw new CommsError('APPROVAL_REQUIRED', 'projects are your own, from the app or your terminal', {
      details: { reason: 'PERSON_SETUP_ONLY' },
    });
  const projects = new Projects({
    store: deps.store,
    git: deps.git ?? createGitRunner(),
    roots: () => deps.sessions.sessionRoots(),
    deniedFolders: () => deps.sessions.deniedFolders(),
    homeDirectory: () => deps.sessions.homeFolder(),
    now: deps.now,
  });
  const sessionsInput = {
    relay: () => deps.sessions.relay(),
    madeWorktrees: (projectId: string) => madeWorktreesOf(deps.store.database, projectId),
  };
  const args = request.args;
  const only = (...keys: string[]) => {
    for (const key of Object.keys(args))
      if (!keys.includes(key)) throw new CommsError('USAGE', `${request.operation} takes no ${key}`);
  };
  switch (request.operation) {
    case 'projects-list':
      only();
      return { projects: await withProjectSessions(projects.list().projects, sessionsInput) };
    case 'project-show': {
      only('projectId');
      const [shown] = await withProjectSessions([projects.show(args.projectId as string)], sessionsInput);
      return shown;
    }
    case 'project-add':
      only('document');
      return projects.add(args.document);
    case 'project-update':
      only('document');
      return projects.update(args.document);
    case 'project-remove':
      only('projectId');
      return projects.remove(args.projectId as string);
    case 'project-scan': {
      only('roots');
      const roots = args.roots;
      if (roots !== undefined && (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string')))
        throw new CommsError('USAGE', 'a scan takes its roots as a list of absolute folders');
      return projects.scan(roots as readonly string[] | undefined);
    }
    default:
      throw new CommsError('USAGE', 'the local event control operation is not recognised');
  }
}
