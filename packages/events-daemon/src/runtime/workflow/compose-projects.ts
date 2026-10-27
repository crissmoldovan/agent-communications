import type { EventDatabase } from '../../store/database.ts';
import type { AgentSessionService, ReadyRelay } from '../agent-sessions.ts';
import { readProject } from '../projects.ts';
import type { WorkflowComposition } from './contracts.ts';
import { routeCandidatesCheck } from './route-activation.ts';
import { createFindSessionExecutor, type SessionStepDeps } from './steps/find-session.ts';
import { createRouteExecutor } from './steps/route.ts';
import { createStartSessionExecutor } from './steps/start-session.ts';

/**
 * Track C's part of the workflow engine (plan C2–C5): the route, find-session and start-session executors, and the
 * route candidates' activation check. The engine (`compose.ts`, Track B's) takes it with the other tracks' parts;
 * nothing here starts anything on its own.
 */
export interface ProjectsCompositionDeps {
  readonly store: EventDatabase;
  /** The person's relay, its allowed roots and Agent Comms' own folders. */
  readonly sessions: Pick<AgentSessionService, 'relay' | 'sessionRoots' | 'deniedFolders'>;
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
  const sessions: SessionStepDeps = {
    relay: () => deps.sessions.relay(),
    // What `relay()` handed a step is the service's own ready relay: its roots are asked of it, not of a second one.
    sessionRoots: (ready) => deps.sessions.sessionRoots(ready as ReadyRelay | undefined),
    deniedFolders: () => deps.sessions.deniedFolders(),
    laneBinding: laneBinding(deps.store),
  };
  return {
    executors: [
      createRouteExecutor({ project }),
      createFindSessionExecutor(sessions),
      createStartSessionExecutor(sessions),
    ],
    activationChecks: [routeCandidatesCheck],
  };
}
