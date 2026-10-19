import { Button, Panel, PanelHeader } from '@cueplusplus/ui';
import { useState } from 'react';
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
 * approves it. `Cancel` revokes the approval and opens nothing.
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

  const approve = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await bridge.openInTerminal({ kind: 'change', call: change.call, revoke: change.approvalId });
      setOpened(outcome);
      onDone?.(outcome);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await bridge.cli({ kind: 'approvalRevoke', approvalId: change.approvalId });
      onDone?.('cancelled');
    } catch (error) {
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
