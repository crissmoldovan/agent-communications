import { Button, Panel, PanelHeader } from '@cueplusplus/ui';
import { useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { COPY } from '../copy.ts';
import type { ChangeOutcome } from '../hooks/use-change.ts';
import { errorMessage, type TerminalOutcome } from '../ipc.ts';
import { TerminalResult } from './TerminalResult.tsx';
import { UntrustedText } from './UntrustedText.tsx';

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/**
 * A change the app prepared that needs the person's approval (DA10): its preview under the app's own header, as text.
 * `Approve in Terminal` sends one command that names both halves — the app's own pending approval, revoked first so
 * the tray does not count it, then the change itself, opened in Terminal where the person confirms it. The app never
 * approves it. `Cancel` revokes the approval and opens nothing, and says it was cancelled only once it was revoked.
 *
 * A preview left behind — the screen changed, or another change replaced it — revokes its approval as it goes
 * (DA16, after review), unless Approve or Cancel already did: an approval nobody will look at again would only fill
 * the tray. The revoke waits a moment after the unmount, so React's StrictMode rehearsal, which mounts the preview
 * again at once, revokes nothing.
 */
export function ChangePreview({
  change,
  onDone,
}: {
  change: Waiting;
  onDone?: (result: TerminalOutcome | 'cancelled') => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Whether Approve or Cancel has the approval in hand, or is about to: then leaving revokes nothing.
  const handled = useRef(false);
  const mounted = useRef(false);
  const { approvalId } = change;

  const revokeLeftBehind = () => {
    if (handled.current) return;
    handled.current = true;
    bridge.revokePreview(approvalId).catch(() => undefined);
  };
  // The latest of it, for the unmount: the effect below runs once, for the preview's whole life.
  const leave = useRef(revokeLeftBehind);
  leave.current = revokeLeftBehind;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current) leave.current();
      }, 0);
    };
  }, []);

  const approve = async () => {
    setBusy(true);
    setProblem(null);
    handled.current = true;
    try {
      const outcome = await bridge.openInTerminal({ kind: 'change', call: change.call, revoke: approvalId });
      setOpened(outcome);
      onDone?.(outcome);
    } catch (error) {
      // Nothing was revoked or opened: the approval is still this preview's to revoke.
      handled.current = false;
      if (!mounted.current) revokeLeftBehind();
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setProblem(null);
    handled.current = true;
    try {
      const result = await bridge.revokePreview(approvalId);
      if (result.status === 'ok') {
        onDone?.('cancelled');
      } else {
        // Not revoked: it is not cancelled, and the preview stays, to try again or leave.
        handled.current = false;
        setProblem(
          result.status === 'failed'
            ? [`The approval was not revoked: ${result.message}`, result.hint].filter(Boolean).join(' ')
            : 'The approval was not revoked.',
        );
      }
    } catch (error) {
      handled.current = false;
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader title={COPY.approveThisInTerminal} />
      <div className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <div className="font-mono text-fg">
          <UntrustedText text={change.preview} />
        </div>
        {opened === null ? (
          <div className="flex gap-(--cue-space-2)">
            <Button variant="primary" loading={busy} onClick={() => void approve()}>
              {COPY.approveInTerminal}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>
              {COPY.cancel}
            </Button>
          </div>
        ) : (
          <TerminalResult outcome={opened} />
        )}
        {problem === null ? null : (
          <p role="alert" className="text-danger">
            <UntrustedText text={problem} />
          </p>
        )}
      </div>
    </Panel>
  );
}
