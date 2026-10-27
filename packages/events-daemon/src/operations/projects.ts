import { EventControlClient } from '../control/client.ts';
import type { PersonSetupOrigin } from '../domain/judge-setup.ts';
import type {
  ProjectRemoveResultV1,
  ProjectScanResultV1,
  ProjectsListResultV1,
  ProjectV1,
} from '../domain/projects.ts';

/*
 * Projects (workflows design §8.1): the GitHub repositories on this Mac, their folders, a profile and hints. Every one
 * of these is the person's, from the app or their terminal: the CLI refuses the event service's MCP server, an agent's
 * shell and, on macOS, a process the app did not start, before anything is read; the owner takes them only from the
 * person's origin; and no MCP tool calls any of them.
 */

interface Options {
  readonly stateDir?: string | undefined;
  /** Who is asking, as the CLI found it: the terminal, or the app. */
  readonly origin: PersonSetupOrigin;
}

function client(options: Options): EventControlClient {
  return new EventControlClient({ stateDir: options.stateDir, clientName: options.origin });
}

/** Every project, with its folders, profile and hints. */
export async function projectsList(options: Options): Promise<ProjectsListResultV1> {
  return (await client(options).request('projects-list', {})) as ProjectsListResultV1;
}

/** One project. */
export async function projectShow(projectId: string, options: Options): Promise<ProjectV1> {
  return (await client(options).request('project-show', { projectId })) as ProjectV1;
}

/** Adds a project: each folder is checked to be a checkout or worktree of its repository, inside the allowed roots. */
export async function projectAdd(document: unknown, options: Options): Promise<ProjectV1> {
  return (await client(options).request('project-add', { document })) as ProjectV1;
}

/** Replaces a project's document: its folders are checked again; its profile and hints change at once. */
export async function projectUpdate(document: unknown, options: Options): Promise<ProjectV1> {
  return (await client(options).request('project-update', { document })) as ProjectV1;
}

/** Removes a project and its folders. A workflow that chose among them then takes `none` with PROJECT_CHANGED. */
export async function projectRemove(projectId: string, options: Options): Promise<ProjectRemoveResultV1> {
  return (await client(options).request('project-remove', { projectId })) as ProjectRemoveResultV1;
}

/** The GitHub checkouts under `roots`, or under the relay's allowed roots, else `~/work` and `~/code`. */
export async function projectScan(roots: readonly string[], options: Options): Promise<ProjectScanResultV1> {
  return (await client(options).request(
    'project-scan',
    roots.length === 0 ? {} : { roots: [...roots] },
  )) as ProjectScanResultV1;
}
