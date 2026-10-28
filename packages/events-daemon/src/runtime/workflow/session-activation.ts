import type { FlowDocumentV1 } from '@agentcomms/events';
import { EventDomainError } from '../../domain/lifecycle.ts';
import { isInside } from '../agent-sessions.ts';
import type { FlowActivationCheck } from './contracts.ts';

/**
 * A start-session step's `{ folder }` place, checked at activation as the step checks it again when it runs (workflows
 * design §6.3): inside the relay's allowed roots — else the folders the person allowed — and outside Agent Comms' own
 * folders. A session target's folder is held to the same at activation (`agent-sessions.ts` `assertActivation`); a
 * project's folders were checked when the person added them, and a worktree's root is checked when the step makes it.
 */
export function startFolderCheck(sessions: {
  sessionRoots(): Promise<readonly string[]>;
  deniedFolders(): readonly string[];
}): FlowActivationCheck {
  return async (rule) => {
    const flow = (rule as { readonly flow?: FlowDocumentV1 }).flow;
    if (flow === undefined) return;
    const folders = Object.entries(flow.steps).flatMap(([stepId, step]) =>
      step.kind === 'start-session' && 'folder' in step.in ? [{ stepId, folder: step.in.folder }] : [],
    );
    if (folders.length === 0) return;
    const denied = sessions.deniedFolders();
    const roots = await sessions.sessionRoots();
    for (const { stepId, folder } of folders) {
      if (denied.some((own) => isInside(folder, own) || isInside(own, folder)))
        throw new EventDomainError(
          'VERSION_DOCUMENT_INVALID',
          `the step ${stepId} starts a session in ${folder}, one of Agent Comms' own folders, which no session works in`,
        );
      if (roots.length === 0)
        throw new EventDomainError(
          'VERSION_DOCUMENT_INVALID',
          `the step ${stepId}'s folder ${folder} cannot be checked: the relay does not say its allowed roots, and none is set: add its root in Settings → Integrations → Agent sessions (integration set agent-sessions --allow-folder)`,
        );
      if (!roots.some((root) => isInside(folder, root)))
        throw new EventDomainError(
          'VERSION_DOCUMENT_INVALID',
          `the step ${stepId} starts a session in ${folder}, which is not inside the relay's allowed roots`,
        );
    }
  };
}
