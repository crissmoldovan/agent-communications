import { useMemo } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { type Call, errorMessage } from '../ipc.ts';

/**
 * What a change came to (DA10): applied at once (a tightening), waiting for the person's approval in Terminal (a
 * loosening, with the preview to show), or refused.
 */
export type ChangeOutcome =
  | { state: 'applied'; data: unknown }
  | { state: 'needsTerminal'; call: Call; approvalId: string; preview: string }
  | { state: 'failed'; message: string; hint: string | null; code: string | null };

/**
 * Runs a change from the allow-list once, and says what it came to. It never runs it again with an approval: a change
 * that needs one goes to `ChangePreview`, and from there to Terminal.
 */
export function useChange(): { run(call: Call): Promise<ChangeOutcome> } {
  const bridge = useBridge();
  return useMemo(
    () => ({
      async run(call: Call): Promise<ChangeOutcome> {
        try {
          const result = await bridge.cli(call);
          switch (result.status) {
            case 'ok':
              return { state: 'applied', data: result.data };
            case 'approvalPending':
              return { state: 'needsTerminal', call, approvalId: result.approvalId, preview: result.preview };
            case 'failed':
              return { state: 'failed', message: result.message, hint: result.hint, code: result.code };
            case 'version':
              return { state: 'failed', message: 'That was not a change.', hint: null, code: null };
          }
        } catch (error) {
          return { state: 'failed', message: errorMessage(error), hint: null, code: null };
        }
      },
    }),
    [bridge],
  );
}
