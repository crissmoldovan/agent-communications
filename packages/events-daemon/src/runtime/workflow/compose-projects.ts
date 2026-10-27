import type { EventDatabase } from '../../store/database.ts';
import { readProject } from '../projects.ts';
import type { WorkflowComposition } from './contracts.ts';
import { routeCandidatesCheck } from './route-activation.ts';
import { createRouteExecutor } from './steps/route.ts';

/**
 * Track C's part of the workflow engine (plan C2–C5): the route step's executor and its activation check. The engine
 * (`compose.ts`, Track B's) takes it with the other tracks' parts; nothing here starts anything on its own.
 */
export interface ProjectsCompositionDeps {
  readonly store: EventDatabase;
}

export function composeProjects(deps: ProjectsCompositionDeps): WorkflowComposition {
  return {
    executors: [createRouteExecutor({ project: (projectId) => readProject(deps.store.database, projectId) })],
    activationChecks: [routeCandidatesCheck],
  };
}
