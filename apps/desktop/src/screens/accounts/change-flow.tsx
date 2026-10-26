/**
 * The one flow every change on an account page goes through (0.34.0, spec §B2), one per section: the CLI is asked once,
 * with `--json`. A tightening applies there and then, and the section is read again. A loosening comes back waiting: its
 * preview shows under the section, headed in the page's words, and the person approves it in the app (`inApp`), where
 * core takes the app's approval for that very change (core 0.34.0, macOS); elsewhere, and on an older core, with Approve
 * in Terminal, as before. Core may void an approval handed the wrong change (`APPROVAL_VOID`): the change is then
 * prepared again, and its new preview shown.
 *
 * The preview is held by the section, not by the row it came from, so a row that reads differently after a reload never
 * takes it away: unmounting a preview revokes its approval (`ChangePreview`).
 */
import { type ReactNode, useState } from 'react';
import type { BehaviourChangeResult } from '../../cli-types.ts';
import { ChangePreview } from '../../components/ChangePreview.tsx';
import { setupsAtTerminal } from '../../components/DoInTerminal.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { useAppData } from '../../data.tsx';
import { supports } from '../../gates.ts';
import { type ChangeOutcome, useChange } from '../../hooks/use-change.ts';
import type { Call } from '../../ipc.ts';

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/** The words of a loosening: what it asks, what it means, and what is said once it is approved. */
export interface Asking {
  title: string;
  body: string;
  approved: string;
  /** The call that answers the approval in the app, given the approval the change came back with. */
  approve: (approvalId: string) => Call;
}

/** What a change says, whichever way it goes. */
export interface ChangeWords {
  /** Applied at once: a tightening. A function reads what the CLI answered. */
  applied: string | ((data: unknown) => string);
  /** Prepared: a loosening. None for a change that only takes away, which never waits. */
  asking?: Asking | undefined;
}

export const FLOW_COPY = {
  approve: 'Approve',
  cancelled: 'Cancelled: nothing was changed.',
  inTerminal: 'Confirm it in Terminal. This page reads it again when you come back to this window.',
  notChanged: (message: string) => `Nothing was changed: ${message}`,
  already: 'It was so already: nothing was changed.',
  unexpected: 'The CLI asked for an approval this change should not need. Nothing was changed.',
} as const;

/** Whether this app approves an account page's loosenings itself: a core with it, on a Mac that attests the app. */
export function useApprovesHere(): boolean {
  const { installation } = useAppData();
  const version = installation.state === 'ready' ? installation.value.version : null;
  return supports(version, 'accountAppApproval') && !setupsAtTerminal();
}

/** What the CLI said when it applied a change: nothing written, or what else it did. */
function appliedLine(data: unknown, given: ChangeWords['applied']): string {
  const words = typeof given === 'function' ? given(data) : given;
  const result = (typeof data === 'object' && data !== null ? data : {}) as Partial<BehaviourChangeResult>;
  const note = typeof result.note === 'string' && result.note !== '' ? result.note : null;
  if (result.changed === false) return note ?? FLOW_COPY.already;
  return note === null ? words : `${words} ${note}`;
}

export interface Flow {
  /** The key of the change running now: its row's button shows it busy. */
  busy: string | null;
  run(key: string, call: Call, words: ChangeWords): Promise<void>;
  /** Says something of the section's own: a check that failed before anything ran. */
  refuse(message: string): void;
  view: ReactNode;
}

/**
 * One section's change flow. `reload` reads the section again after a change. A change given no `asking` only takes
 * away and never waits: one that came back waiting all the same is refused, and nothing is sent to Terminal for it.
 */
export function useFlow(reload: () => Promise<void>): Flow {
  const change = useChange();
  const here = useApprovesHere();
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<{ outcome: Waiting; asking: Asking; words: ChangeWords; key: string } | null>(
    null,
  );
  const [opened, setOpened] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ message: string; hint: string | null } | null>(null);

  const run: Flow['run'] = async (key, call, words) => {
    setSaid(null);
    setRefused(null);
    setOpened(false);
    setBusy(key);
    try {
      const outcome = await change.run(call);
      switch (outcome.state) {
        case 'applied':
          setWaiting(null);
          setSaid(appliedLine(outcome.data, words.applied));
          await reload();
          return;
        case 'needsTerminal':
          if (words.asking === undefined) {
            setRefused({ message: FLOW_COPY.unexpected, hint: null });
            return;
          }
          setWaiting({ outcome, asking: words.asking, words, key });
          return;
        case 'failed':
          setRefused({ message: outcome.message, hint: outcome.hint });
          return;
      }
    } finally {
      setBusy(null);
    }
  };

  const view =
    said === null && refused === null && waiting === null ? null : (
      <div className="flex flex-col gap-(--cue-space-3)">
        {said === null ? null : (
          <p role="status" className="text-fg">
            <UntrustedText text={said} />
          </p>
        )}
        {refused === null ? null : (
          <div className="flex flex-col gap-(--cue-space-1)">
            <p role="alert" className="text-danger">
              <UntrustedText text={refused.message} />
            </p>
            {refused.hint === null ? null : (
              <p className="text-fg-muted">
                <UntrustedText text={refused.hint} />
              </p>
            )}
          </div>
        )}
        {waiting === null ? null : (
          <section aria-label={waiting.asking.title} className="flex flex-col gap-(--cue-space-2)">
            {here ? null : <p className="font-medium text-fg">{waiting.asking.title}</p>}
            <p className="text-fg-muted">{waiting.asking.body}</p>
            <ChangePreview
              key={waiting.outcome.approvalId}
              change={waiting.outcome}
              onDone={(done) => {
                if (done === 'cancelled') {
                  setWaiting(null);
                  setSaid(FLOW_COPY.cancelled);
                  return;
                }
                setOpened(true);
                void reload();
              }}
              inApp={
                here
                  ? {
                      title: waiting.asking.title,
                      approve: FLOW_COPY.approve,
                      call: waiting.asking.approve(waiting.outcome.approvalId),
                      failed: FLOW_COPY.notChanged,
                      onApproved: () => {
                        setWaiting(null);
                        setSaid(waiting.asking.approved);
                        void reload();
                      },
                      // Voided by core: the same change, prepared again, with its own new preview.
                      onVoid: () => {
                        setWaiting(null);
                        void run(waiting.key, waiting.outcome.call, waiting.words);
                      },
                    }
                  : undefined
              }
            />
            {opened ? <p className="text-fg-muted">{FLOW_COPY.inTerminal}</p> : null}
          </section>
        )}
      </div>
    );

  return {
    busy,
    run,
    refuse: (message) => {
      setSaid(null);
      setRefused({ message, hint: null });
    },
    view,
  };
}
