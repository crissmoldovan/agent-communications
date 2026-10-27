import { Button, Panel, PanelHeader } from '@cueplusplus/ui';
import { useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { COPY } from '../copy.ts';
import type { ChangeOutcome } from '../hooks/use-change.ts';
import { type Call, type CliResult, errorMessage, type TerminalOutcome } from '../ipc.ts';
import { refusedAsUnattested } from './DoInTerminal.tsx';
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
 *
 * `inApp` is the one change the person approves here, in the app (0.32.0, DA10's note of 2026-10-26: adding a server to
 * an app in Connections): the same preview under its own header, and its confirm runs `inApp.call`, which answers this
 * approval through core's app channel and applies the change. Nothing is approved until that button is pressed, and
 * Cancel and leaving revoke it as they do here otherwise. When core refuses the app's approval because nothing attests
 * that the app is the person's (`APPROVAL_REQUIRED`, reason `ORIGIN_UNATTESTED`: Windows and Linux, 0.33.0), the
 * preview offers Approve in Terminal instead, for the same change. When core says the approval is void
 * (`APPROVAL_VOID`, 0.34.0: it was used, or handed another change) and the screen gave `onVoid`, there is nothing left
 * to approve or revoke: the screen prepares the change again, with a preview of its own.
 */
export function ChangePreview({
  change,
  onDone,
  inApp,
}: {
  change: Waiting;
  onDone?: (result: TerminalOutcome | 'cancelled') => void;
  inApp?:
    | {
        /** The header, the confirm's words, and the call that answers the approval in the app. */
        title: string;
        approve: string;
        call: Call;
        /** What a refusal says, from core's message. */
        failed: (message: string) => string;
        /** Applied: core's answer. */
        onApproved: (result: Extract<CliResult, { status: 'ok' }>) => void;
        /**
         * Core voided the approval (`APPROVAL_VOID`, 0.34.0): it was handed one prepared for another change. Nothing was
         * applied and the approval is spent, so the screen prepares the change again and shows its new preview. Without
         * it, the refusal is said here.
         */
        onVoid?: () => void;
        /** Refused for any other reason, once that is said: the screen reads again what it shows (0.34.0). */
        onRefused?: () => void;
      }
    | undefined;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Refused in the app as unattested: the approval is the terminal's from here on.
  const [refusedHere, setRefusedHere] = useState(false);
  const here = refusedHere ? undefined : inApp;
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

  // Approved here: the person pressed the confirm, and only now is the approval answered — through core's app channel.
  const approveHere = async (here: NonNullable<typeof inApp>) => {
    setBusy(true);
    setProblem(null);
    handled.current = true;
    try {
      const result = await bridge.cli(here.call);
      if (result.status === 'ok') {
        here.onApproved(result);
        return;
      }
      // Voided by core: spent, with nothing to revoke; the screen prepares the change again.
      if (result.status === 'failed' && result.code === 'APPROVAL_VOID' && here.onVoid !== undefined) {
        here.onVoid();
        return;
      }
      // Not applied: the approval is still this preview's to cancel, or to leave behind.
      handled.current = false;
      if (!mounted.current) revokeLeftBehind();
      if (result.status === 'failed' && refusedAsUnattested(result.code)) setRefusedHere(true);
      setProblem(
        result.status === 'failed'
          ? [here.failed(result.message), result.hint].filter(Boolean).join(' ')
          : here.failed('core did not apply it'),
      );
      here.onRefused?.();
    } catch (error) {
      handled.current = false;
      if (!mounted.current) revokeLeftBehind();
      setProblem(here.failed(errorMessage(error)));
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
      <PanelHeader title={here === undefined ? COPY.approveThisInTerminal : here.title} />
      <div className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <div className="font-mono text-fg">
          <UntrustedText text={change.preview} />
        </div>
        {opened === null ? (
          <div className="flex gap-(--cue-space-2)">
            {here === undefined ? (
              <Button variant="primary" loading={busy} onClick={() => void approve()}>
                {COPY.approveInTerminal}
              </Button>
            ) : (
              <Button variant="primary" loading={busy} onClick={() => void approveHere(here)}>
                {here.approve}
              </Button>
            )}
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
