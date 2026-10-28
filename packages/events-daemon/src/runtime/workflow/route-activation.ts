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
 *
 * The refusal has one wording for a project gone and a project changed, and names the step alone (security review of
 * 0.36.0, M3): an agent may enable a workflow, and two wordings, or one naming a project or its folders, would tell it
 * which project ids exist and which folders are theirs. The person sees what changed in Projects.
 */
export const routeCandidatesCheck: FlowActivationCheck = (rule, database) => {
  const flow = (rule as { readonly flow?: FlowDocumentV1 }).flow;
  if (flow === undefined) return;
  for (const [stepId, step] of Object.entries(flow.steps)) {
    if (step.kind !== 'route') continue;
    for (const candidate of step.candidates) {
      const project = readProject(database, candidate.projectId);
      if (project === null || candidateChanged(candidate, project)) throw projectChanged(stepId);
    }
  }
};

function projectChanged(stepId: string): EventDomainError {
  return new EventDomainError(
    'PROJECT_CHANGED',
    `the projects the step ${stepId} chooses among are not your projects as they are now: review the workflow again`,
  );
}
