import { COPY, openedLine } from '../copy.ts';
import type { TerminalOutcome } from '../ipc.ts';

/** What opening the terminal came to: where it opened, or that the command is on the clipboard instead, and why. */
export function TerminalResult({ outcome }: { outcome: TerminalOutcome }) {
  const line =
    outcome.outcome === 'opened'
      ? openedLine(outcome.via)
      : outcome.reason === 'noTerminal'
        ? COPY.noTerminal
        : COPY.noSafeLine;
  return (
    <p role="status" className="text-fg-muted">
      {line}
    </p>
  );
}
