import { EventControlClient } from '../control/client.ts';
import type { ActivationDocumentV1 } from '../domain/activation-documents.ts';

/**
 * An agent's view of a pending approval (0.34.0 design B7): the daemon-authoritative preview, with no challenge and no
 * selector carrying one, so nothing in it can answer `approve`. A Laya rule's view keeps its limits.
 */
export interface AgentApprovalViewV1 {
  readonly kind: 'READY';
  readonly approvalId: string;
  readonly digest: string;
  readonly preview: ActivationDocumentV1;
  readonly layaJudge?: unknown;
}

/**
 * Returns the daemon-authoritative preview; it never claims an approval. The person's view — the app's, and `approval
 * view` at a terminal — also carries the fresh challenge the owner issues for it. `insideMcpServer` asks for an agent's
 * view: the preview alone, for which the owner issues no challenge (0.34.0 design B7). The flag only narrows.
 */
export async function approvalView(
  approvalId: string,
  digest: string,
  options: { readonly stateDir?: string | undefined; readonly insideMcpServer?: boolean | undefined } = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('approvalView', {
    approvalId,
    digest,
    ...(options.insideMcpServer === true ? { insideMcpServer: true } : {}),
  });
}
