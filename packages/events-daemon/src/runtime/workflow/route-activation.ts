import type { FlowDocumentV1 } from '@agentcomms/events';
import { EventDomainError } from '../../domain/lifecycle.ts';
import { readProject } from '../projects.ts';
import type { FlowActivationCheck } from './contracts.ts';
import { candidateChanged } from './steps/route.ts';

/**
 * A route step's candidates, checked at activation (workflows design W12, plan C2): each is one of the person's
 * projects now, with the same folders and worktree root the version binds. A project's folders are authority — the
 * approval names them — so a version whose candidates differ from the projects as they are is refused with
 * `PROJECT_CHANGED`, and the person reviews it again. Profiles and hints are not compared: they choose among the
 * candidates, and change at once. It runs inside B1's `assertFlowActivation`, after that function's own checks.
 */
export const routeCandidatesCheck: FlowActivationCheck = (rule, database) => {
  const flow = (rule as { readonly flow?: FlowDocumentV1 }).flow;
  if (flow === undefined) return;
  for (const [stepId, step] of Object.entries(flow.steps)) {
    if (step.kind !== 'route') continue;
    for (const candidate of step.candidates) {
      const project = readProject(database, candidate.projectId);
      if (project === null)
        throw new EventDomainError(
          'PROJECT_CHANGED',
          `the step ${stepId} chooses the project ${candidate.projectId}, which is not one of your projects now: review the workflow again`,
        );
      if (candidateChanged(candidate, project))
        throw new EventDomainError(
          'PROJECT_CHANGED',
          `the project ${candidate.projectId}'s folders or worktree root are not the ones the step ${stepId} names: review the workflow again`,
        );
    }
  }
};
