import { Chip, EmptyState, Panel, Tabs } from '@cueplusplus/ui';
import { useEffect, useState } from 'react';
import { ApprovalCard, approverOf, readApprovals } from '../components/ApprovalCard.tsx';
import { RecentApprovals } from '../components/RecentApprovals.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import type { Loadable } from '../data.tsx';
import { useAppData } from '../data.tsx';
import type { Product } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/** What the screen says when nothing waits. */
export const NOTHING_WAITING = 'Nothing is waiting for you.';

/** What it says when a link names an approval that is not in the list. */
const GONE = 'This approval is no longer waiting.';

/** What it says when the list came back in no shape the app knows. */
const UNREADABLE = 'The approvals list could not be read.';

/** The screen's two views (D7), in the tab bar's order: what waits for the person comes first. */
type View = 'waiting' | 'recent';

/**
 * Two views (D7). Waiting: each waiting approval, with Revoke and Approve in Terminal (DA5.3, DA11), from the list the
 * app polls, its count on its tab. An `agentcomms://approvals/<id>` link opens Waiting, selects that approval and
 * scrolls to it, or says it is no longer waiting. Recent (0.29.0, design 2026-10-25-activity S5): what no longer waits,
 * from the last 30 days, read-only, read from the approval store each time the view opens.
 */
export function Approvals() {
  const { approvals, deepLink, clearDeepLink } = useAppData();
  const [target, setTarget] = useState<string | null>(null);
  const [view, setView] = useState<View>('waiting');

  // A link is taken once: the screen keeps its id, opens Waiting, and the shared data lets it go.
  useEffect(() => {
    if (deepLink === null) return;
    setTarget(deepLink.approvalId);
    setView('waiting');
    clearDeepLink();
  }, [deepLink, clearDeepLink]);

  return (
    <ScreenFrame title="Approvals">
      <Tabs.Root value={view} onValueChange={(value) => setView(value as View)}>
        <Tabs.List aria-label="Approvals" className="self-start">
          {/* A space before the count, which the flex row does not draw, keeps the tab's name two words apart. */}
          <Tabs.Tab value="waiting">
            Waiting <WaitingCount approvals={approvals} />
          </Tabs.Tab>
          <Tabs.Tab value="recent">Recent</Tabs.Tab>
          <Tabs.Indicator />
        </Tabs.List>
        <Tabs.Panel value="waiting" keepMounted>
          <Waiting target={target} />
        </Tabs.Panel>
        {/* Not kept mounted: Recent reads the store each time it opens, and never while it is not shown. */}
        <Tabs.Panel value="recent">
          <section aria-label="Recent">
            <RecentApprovals />
          </section>
        </Tabs.Panel>
      </Tabs.Root>
    </ScreenFrame>
  );
}

/** Waiting's count on its tab, said in full to a screen reader; nothing until the list is read. */
function WaitingCount({ approvals }: { approvals: Loadable<unknown> }) {
  if (approvals.state !== 'ready') return null;
  const list = readApprovals(approvals.value);
  if (list === null) return null;
  return (
    <Chip tone="neutral" variant="tag" data-slot="tab-count">
      <span aria-hidden="true">{list.length}</span>
      <span className="sr-only">{`${list.length} waiting`}</span>
    </Chip>
  );
}

/** Each approval that waits, and the line for a link to one that does not. */
function Waiting({ target }: { target: string | null }) {
  const { approvals, installation } = useAppData();
  const present: readonly Product[] = installation.state === 'ready' ? installation.value.present : [];
  return (
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
            <section aria-label="Waiting" className="flex flex-col gap-(--cue-space-3)">
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
            </section>
          </>
        );
      }}
    </ScreenState>
  );
}
