import type { DatabaseSync } from 'node:sqlite';
import type { ProjectSessionV1, ProjectV1 } from '../domain/projects.ts';
import { isPromptableSession, type RelayClient, RelayError, type RelaySessionV1 } from './relay-client.ts';
import { lastActive } from './workflow/steps/session-place.ts';

/**
 * Which sessions are working in each project, busy or idle (0.36, the owner: "identify… sessions… if it's working on
 * something"): the relay's sessions whose `cwd` — the relay reports a realpath — is one of the project's folders or a
 * worktree a run made of it, as find-session matches them. It reads the relay as C3's steps do, one session list and a
 * snapshot per session, at most `PROJECT_SESSION_SNAPSHOTS_MAX`, and writes nothing. What it gives is content-free: the
 * session's id, provider, a closed state, a time and its folder — never a title, which another client may have
 * written. A relay that cannot be asked gives every project `sessions: null` and the relay's closed reason; it never
 * fails the read it is part of.
 */

/** Snapshots read per call, at most; past them a session's time is its creation's. */
export const PROJECT_SESSION_SNAPSHOTS_MAX = 32;

export interface ProjectSessionsInput {
  readonly relay: () => Promise<{ readonly client: Pick<RelayClient, 'sessions' | 'snapshot'> }>;
  /** The worktrees a run made of a project and has not removed. */
  readonly madeWorktrees: (projectId: string) => readonly string[];
}

/** The worktrees runs made of `projectId` that are still there for a session to work in. */
export function madeWorktreesOf(database: DatabaseSync, projectId: string): readonly string[] {
  const rows = database
    .prepare("SELECT path FROM workflow_worktrees WHERE project_id = ? AND state IN ('made', 'kept') ORDER BY path")
    .all(projectId) as unknown as { path: string }[];
  return rows.map((row) => row.path);
}

function stateOf(session: RelaySessionV1): ProjectSessionV1['state'] | null {
  if (session.attached === 'observer') return 'watched';
  // Fenced or moved to another executor: it works nowhere here.
  if (!isPromptableSession(session)) return null;
  return session.activeRunId === undefined ? 'idle' : 'busy';
}

function time(value: string): number | null {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** Each project with the relay sessions working in it, or with `sessions: null` and why when the relay is not there. */
export async function withProjectSessions(
  projects: readonly ProjectV1[],
  input: ProjectSessionsInput,
): Promise<ProjectV1[]> {
  if (projects.length === 0) return [];
  let sessions: readonly RelaySessionV1[];
  let client: Pick<RelayClient, 'sessions' | 'snapshot'>;
  try {
    ({ client } = await input.relay());
    sessions = await client.sessions();
  } catch (error) {
    const reason = error instanceof RelayError ? error.reason : 'RELAY_FAILED';
    return projects.map((project) => ({ ...project, sessions: null, sessionsReason: reason }));
  }
  let snapshots = PROJECT_SESSION_SNAPSHOTS_MAX;
  const answered: ProjectV1[] = [];
  for (const project of projects) {
    const folders = new Set([
      ...project.folders.map((folder) => folder.folder),
      ...input.madeWorktrees(project.projectId),
    ]);
    const working: ProjectSessionV1[] = [];
    for (const session of sessions.filter((candidate) => folders.has(candidate.cwd))) {
      let current = session;
      let lastActiveAt = time(session.createdAt);
      if (snapshots > 0) {
        snapshots -= 1;
        try {
          const snapshot = await client.snapshot(session.id);
          if (snapshot === null) continue;
          current = snapshot.session;
          const active = lastActive({ ...snapshot, session: { ...snapshot.session, activeRunId: undefined } });
          lastActiveAt = active > 0 ? active : lastActiveAt;
        } catch {
          // One session the relay will not show keeps what its list said.
        }
      }
      const state = stateOf(current);
      if (state === null) continue;
      working.push({ session: current.id, provider: current.provider, state, lastActiveAt, folder: current.cwd });
    }
    working.sort(
      (left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0) || (left.session < right.session ? -1 : 1),
    );
    answered.push({ ...project, sessions: working, sessionsReason: null });
  }
  return answered;
}
