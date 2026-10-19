import { EmptyState, Panel } from '@cueplusplus/ui';
import { useEffect, useState } from 'react';
import { ApprovalCard, approverOf, readApprovals } from '../components/ApprovalCard.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { useAppData } from '../data.tsx';
import type { Product } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/** What the screen says when nothing waits. */
export const NOTHING_WAITING = 'Nothing is waiting for you.';

/** What it says when a link names an approval that is not in the list. */
const GONE = 'This approval is no longer waiting.';

/** What it says when the list came back in no shape the app knows. */
const UNREADABLE = 'The approvals list could not be read.';

/**
 * Each waiting approval, with Revoke and Approve in Terminal (DA5.3, DA11), from the list the app polls. An
 * `agentcomms://approvals/<id>` link selects that approval and scrolls to it, or says it is no longer waiting.
 */
export function Approvals() {
  const { approvals, installation, deepLink, clearDeepLink } = useAppData();
  const [target, setTarget] = useState<string | null>(null);

  // A link is taken once: the screen keeps its id, and the shared data lets it go.
  useEffect(() => {
    if (deepLink === null) return;
    setTarget(deepLink.approvalId);
    clearDeepLink();
  }, [deepLink, clearDeepLink]);

  const present: readonly Product[] = installation.state === 'ready' ? installation.value.present : [];

  return (
    <ScreenFrame title="Approvals">
      <ScreenState value={approvals}>
        {(value) => {
          const list = readApprovals(value);
          if (list === null) {
            return (
              <p role="alert" className="text-danger">
                {UNREADABLE}
              </p>
            );
          }
          const gone = target !== null && !list.some((approval) => approval.approvalId === target);
          return (
            <>
              {gone ? (
                <p role="status" className="text-fg-muted">
                  {GONE}
                </p>
              ) : null}
              {list.length === 0 ? (
                <Panel>
                  <EmptyState title={NOTHING_WAITING} />
                </Panel>
              ) : (
                list.map((approval) => (
                  <ApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    approver={approverOf(approval, present)}
                    selected={approval.approvalId === target}
                  />
                ))
              )}
            </>
          );
        }}
      </ScreenState>
    </ScreenFrame>
  );
}
