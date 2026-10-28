import type { TakeStore } from '@agentcomms/core';
import type { EventDatabase } from '../../store/database.ts';
import type { AgentSessionService, ReadyRelay } from '../agent-sessions.ts';
import { createGitRunner, type GitRunner } from '../git.ts';
import { readProject } from '../projects.ts';
import type { WorkflowComposition } from './contracts.ts';
import { routeCandidatesCheck } from './route-activation.ts';
import { startFolderCheck } from './session-activation.ts';
import { createFindSessionExecutor, type SessionStepDeps } from './steps/find-session.ts';
import { createRouteExecutor } from './steps/route.ts';
import { createStartSessionExecutor } from './steps/start-session.ts';
import { createWorktreeExecutor } from './steps/worktree.ts';

/**
 * Track C's part of the workflow engine (plan C2–C5): the route, find-session, start-session and worktree executors,
 * and two activation checks — the route candidates' (`routeCandidatesCheck`) and a start step's folder
 * (`startFolderCheck`). The engine (`compose.ts`, Track B's) takes it with the other tracks' parts;
 * nothing here starts anything on its own.
 */
export interface ProjectsCompositionDeps {
  readonly store: EventDatabase;
  /** The person's relay, its allowed roots and Agent Comms' own folders. */
  readonly sessions: Pick<AgentSessionService, 'relay' | 'sessionRoots' | 'deniedFolders'>;
  /** git, as the worktree step runs it: the event service's one runner by default. */
  readonly git?: GitRunner | undefined;
  /**
   * Core's take store, opened on core's state folder (the person's in the owner, a stand-in home's in a test), read for
   * who took a conversation (W36). Without one, "the session that took this conversation" is none.
   */
  readonly takes?: Pick<TakeStore, 'threadHolder'> | undefined;
}

/** The window bound to a lane, by the lane's name: its Claude Code session id and since when. */
function laneBinding(store: EventDatabase): SessionStepDeps['laneBinding'] {
  return (lane) => {
    const row = store.database.prepare('SELECT session_id, since FROM lane_bindings WHERE lane = ?').get(lane) as
      | { session_id: string | null; since: number }
      | undefined;
    return row === undefined ? null : { sessionId: row.session_id, since: row.since };
  };
}

export function composeProjects(deps: ProjectsCompositionDeps): WorkflowComposition {
  const project = (projectId: string) => readProject(deps.store.database, projectId);
  const takes = deps.takes;
  const sessions: SessionStepDeps = {
    relay: () => deps.sessions.relay(),
    // What `relay()` handed a step is the service's own ready relay: its roots are asked of it, not of a second one.
    sessionRoots: (ready) => deps.sessions.sessionRoots(ready as ReadyRelay | undefined),
    deniedFolders: () => deps.sessions.deniedFolders(),
    laneBinding: laneBinding(deps.store),
    ...(takes === undefined ? {} : { threadHolder: (input) => takes.threadHolder(input) }),
  };
  return {
    executors: [
      createRouteExecutor({ project }),
      createFindSessionExecutor(sessions),
      createStartSessionExecutor(sessions),
      createWorktreeExecutor({
        store: deps.store,
        git: deps.git ?? createGitRunner(),
        project,
        sessionRoots: () => deps.sessions.sessionRoots(),
        deniedFolders: () => deps.sessions.deniedFolders(),
      }),
    ],
    activationChecks: [
      routeCandidatesCheck,
      startFolderCheck({
        sessionRoots: () => deps.sessions.sessionRoots(),
        deniedFolders: () => deps.sessions.deniedFolders(),
      }),
    ],
  };
}
