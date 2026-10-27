import { Button } from '@cueplusplus/ui';
import { useState } from 'react';
import { ChangePreview } from '../../components/ChangePreview.tsx';
import { type ChangeOutcome, useChange } from '../../hooks/use-change.ts';
import type { Call, ConnectionApp } from '../../ipc.ts';
import { CONNECTION_APP_MARKS } from '../../mcp-connections.ts';
import { KEY_COPY, MCP_COPY } from './copy.ts';

/** An app's mark: its two letters on the accent's soft ground; Manual's on a plain one (the boards' `si`). */
export function AppMark({ app }: { app: ConnectionApp | null }) {
  return (
    <span
      aria-hidden="true"
      data-slot="app-mark"
      className={`flex size-chip shrink-0 items-center justify-center rounded-control font-semibold text-(length:--cue-text-ui) ${app === 'manual' || app === null ? 'bg-surface-3 text-fg-muted' : 'bg-accent-soft text-accent'}`}
    >
      {app === null ? '?' : CONNECTION_APP_MARKS[app]}
    </span>
  );
}

/** What a connection's key is for, and what it is not (§6.3, the boards' "What the key is for"). */
export function KeyWhy({ name }: { name: string }) {
  return (
    <div className="flex flex-col gap-(--cue-space-1) rounded-control bg-surface-2 px-(--cue-space-3) py-(--cue-space-2)">
      <span className="font-medium text-fg">{KEY_COPY.title}</span>
      <p className="text-fg">{KEY_COPY.body(name)}</p>
      <p className="text-(length:--cue-text-ui) text-fg-subtle">{KEY_COPY.network}</p>
    </div>
  );
}

/** What a prepared change came to, said by the screen that holds it. */
export type Outcome = { tone: 'ok' | 'quiet'; text: string } | { tone: 'refused'; text: string; hint: string | null };

/**
 * A change the person asks for with one button, which core prepares and the person approves (the boards' Move to one
 * entry and Undo): pressed, it is prepared, and core's preview shows under it, approved in the app with `approve(id)` —
 * only that approval, for that very change (`connections::run_app_approval`) — or in Terminal where nothing attests the
 * app. Cancel revokes it; an approval core calls void is prepared again. What it came to goes to `onSaid`, and an
 * approval that applied to `onApproved`.
 */
export function PrepareAndApprove({
  button,
  buttonLabel,
  prepare,
  approve,
  title,
  approveHere,
  failed,
  onApproved,
  onSaid,
  disabled = false,
}: {
  button: string;
  buttonLabel?: string;
  prepare: Call;
  approve: (approvalId: string) => Call;
  title: string;
  approveHere: boolean;
  failed: (message: string) => string;
  onApproved: (data: unknown) => void;
  onSaid: (said: Outcome) => void;
  disabled?: boolean;
}) {
  const change = useChange();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Extract<ChangeOutcome, { state: 'needsTerminal' }> | null>(null);
  const [opened, setOpened] = useState(false);
  const run = async (again = false) => {
    setBusy(true);
    setOpened(false);
    try {
      const outcome = await change.run(prepare);
      if (outcome.state === 'needsTerminal') {
        setWaiting(outcome);
        if (again) onSaid({ tone: 'quiet', text: MCP_COPY.prepareAgain });
        return;
      }
      setWaiting(null);
      if (outcome.state === 'applied') onApproved(outcome.data);
      else onSaid({ tone: 'refused', text: failed(outcome.message), hint: outcome.hint });
    } finally {
      setBusy(false);
    }
  };
  if (waiting === null) {
    return (
      <div className="flex flex-col gap-(--cue-space-2)">
        <div>
          <Button
            size="sm"
            variant="secondary"
            aria-label={buttonLabel}
            loading={busy}
            disabled={disabled}
            onClick={() => void run()}
          >
            {button}
          </Button>
        </div>
        {opened ? <p className="text-fg-muted">{MCP_COPY.inTerminal}</p> : null}
      </div>
    );
  }
  return (
    <ChangePreview
      key={waiting.approvalId}
      change={waiting}
      onDone={(result) => {
        setWaiting(null);
        if (result === 'cancelled') {
          onSaid({ tone: 'quiet', text: MCP_COPY.cancelled });
          return;
        }
        setOpened(true);
      }}
      inApp={
        approveHere
          ? {
              title,
              approve: MCP_COPY.approve,
              call: approve(waiting.approvalId),
              failed,
              onApproved: (result) => {
                setWaiting(null);
                onApproved(result.data);
              },
              onVoid: () => {
                setWaiting(null);
                void run(true);
              },
            }
          : undefined
      }
    />
  );
}
