/**
 * Do it in Terminal (0.33.0, security review): the person-only setups — judge setup, a provider's key set or removed,
 * where the agent-session relay is — where the app cannot attest that it is the person who acts. On macOS the event
 * service checks that the app started the CLI; on Windows and Linux nothing can, so it refuses the app there
 * (`APPROVAL_REQUIRED`, or `ORIGIN_UNATTESTED`), and the person does it in a terminal instead: the app opens the exact
 * command through the terminal allow-list, as Approve in Terminal and Bind in Terminal do. A key is typed there, hidden;
 * the app never has it. On macOS the app acts itself, and offers the terminal only when the event service refuses it.
 */
import { Button } from '@cueplusplus/ui';
import { useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { errorMessage, type TerminalCommand, type TerminalOutcome } from '../ipc.ts';
import { isMac } from '../platform.ts';
import { TerminalResult } from './TerminalResult.tsx';
import { UntrustedText } from './UntrustedText.tsx';

export const AT_TERMINAL_COPY = {
  doIt: 'Do it in Terminal',
  why: 'On this computer the app cannot be sure it is you, so you do this in a terminal.',
  key: 'The terminal asks for the key there, hidden: the app never sees it.',
  after: 'When you have finished there, press Done: this reads it again.',
  done: 'Done',
  cancel: 'Cancel',
} as const;

/** Whether the person's setups are the terminal's on this computer: everywhere but macOS, which attests the app. */
export function setupsAtTerminal(): boolean {
  return !isMac();
}

/** Whether the event service refused the app because it cannot attest the person: then the terminal is offered. */
export function refusedAsUnattested(code: string | null | undefined): boolean {
  return code === 'ORIGIN_UNATTESTED' || code === 'APPROVAL_REQUIRED';
}

/**
 * The command to run at the terminal, why, and once it opened, where — then Done, which reads it again. Nothing runs
 * until the person presses Do it in Terminal.
 */
export function DoInTerminal({
  command,
  asksForKey = false,
  onDone,
  onCancel,
}: {
  command: TerminalCommand;
  /** It is a key's: the terminal asks for it. */
  asksForKey?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setOpened(await bridge.openInTerminal(command));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-slot="do-in-terminal" className="flex flex-col gap-(--cue-space-2)">
      <p className="text-fg-muted">{AT_TERMINAL_COPY.why}</p>
      {asksForKey ? <p className="text-fg-muted">{AT_TERMINAL_COPY.key}</p> : null}
      {opened === null ? (
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <Button size="sm" variant="primary" loading={busy} onClick={() => void open()}>
            {AT_TERMINAL_COPY.doIt}
          </Button>
          {onCancel === undefined ? null : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              {AT_TERMINAL_COPY.cancel}
            </Button>
          )}
        </div>
      ) : (
        <>
          <TerminalResult outcome={opened} />
          <p className="text-fg-muted">{AT_TERMINAL_COPY.after}</p>
          <div>
            <Button size="sm" onClick={onDone}>
              {AT_TERMINAL_COPY.done}
            </Button>
          </div>
        </>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-danger">
          <UntrustedText text={problem} />
        </p>
      )}
    </div>
  );
}
