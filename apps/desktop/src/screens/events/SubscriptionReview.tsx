/**
 * Approve… for a subscriber's events (workflows design W29, §10.1): the subscription `subscriber enable` prepared, as
 * its own preview says it — what it receives, in which namespaces, whether it gets what senders wrote, and where it goes
 * — and the person's approval of it. On macOS, where the app attests the person, they type the subscriber's name and
 * press Approve; only that runs `subscriber approve <approval> --digest <d>`, for exactly this approval and its digest,
 * which Rust answers only for the subscription the app prepared. Elsewhere, or when the event service refuses the app's
 * approval, Approve in Terminal opens `approve <approval>` there. Back, or leaving before the terminal opened, revokes
 * it: nothing is approved.
 *
 * The preview's words are the event service's, built from the subscriber's own canonical words, and the terminal's
 * preview prints the same: for a webhook, its whole URL (a secret one by its authority) — on a shared webhook host the
 * path decides who receives — the addresses it may connect to and how many times each event is tried (security review
 * of 0.36.0, M4). They are shown as text, whole.
 */
import { Button, Dialog, Field, FieldLabel, Input } from '@cueplusplus/ui';
import { useEffect, useRef, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { TerminalResult } from '../../components/TerminalResult.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { type Bridge, errorMessage, type TerminalOutcome } from '../../ipc.ts';
import { isMac } from '../../platform.ts';
import { readActivation } from '../../rule-editor/submit.ts';

export const SUBSCRIPTION_COPY = {
  preparing: 'Preparing its approval…',
  title: (id: string, version: number) => `Approve what ${id} receives (version ${version})`,
  body: 'It receives nothing until you approve. You can remove it at any time, at once.',
  receives: 'What it receives',
  fingerprint: 'Fingerprint',
  typeToApprove: (id: string) => `Type ${id} to approve`,
  approve: 'Approve',
  back: 'Back',
  notApproved: 'It was not approved',
  revoked: 'Not approved: nothing changed.',
  approveInTerminal: 'Approve in Terminal',
  atTerminal:
    'On this computer the app cannot be sure it is you who presses Approve, so you approve it in a terminal: it shows this preview again and asks you to type its challenge.',
  inTerminal: 'Finish in the terminal: type the challenge it shows. It starts receiving once you approve there.',
  done: 'Done',
  unreadable: 'Its preview could not be read.',
} as const;

/** A subscription the app prepared, and its preview's words. */
export interface PreparedSubscription {
  subscriberId: string;
  version: number;
  approvalId: string;
  digest: string;
  words: string;
}

/**
 * Prepares version `version`'s subscription and reads its preview (`approval view`); a preview with no words for it is
 * revoked, and nothing waits.
 */
export async function prepareSubscription(
  bridge: Pick<Bridge, 'cli' | 'revokePreview'>,
  subscriberId: string,
  version: number,
): Promise<{ ok: true; prepared: PreparedSubscription } | { ok: false; problem: string }> {
  const enabled = await bridge.cli({ kind: 'eventsSubscriberEnable', subscriberId, version });
  if (enabled.status !== 'ok')
    return { ok: false, problem: enabled.status === 'failed' ? enabled.message : SUBSCRIPTION_COPY.unreadable };
  const activation = readActivation(enabled.data);
  if (activation === null) return { ok: false, problem: SUBSCRIPTION_COPY.unreadable };
  const viewed = await bridge.cli({ kind: 'eventsApprovalView', ...activation });
  const subscription =
    viewed.status === 'ok' && typeof viewed.data === 'object' && viewed.data !== null
      ? (viewed.data as { subscription?: { words?: unknown } }).subscription
      : undefined;
  const words = typeof subscription?.words === 'string' ? subscription.words : null;
  if (words === null) {
    await bridge.revokePreview(activation.approvalId).catch(() => undefined);
    return { ok: false, problem: viewed.status === 'failed' ? viewed.message : SUBSCRIPTION_COPY.unreadable };
  }
  return { ok: true, prepared: { subscriberId, version, ...activation, words } };
}

export function SubscriptionReview({
  prepared,
  onApproved,
  onClosed,
  onDone,
}: {
  prepared: PreparedSubscription;
  onApproved: () => void;
  /** Revoked, or left: nothing was approved. */
  onClosed: (problem: string | null) => void;
  /** Left after Approve in Terminal: whether it was approved there is read again, not assumed. */
  onDone: () => void;
}) {
  const bridge = useBridge();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [atTerminal, setAtTerminal] = useState(() => !isMac());
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const handled = useRef(false);
  const { approvalId, digest, subscriberId } = prepared;

  // Left behind revokes the approval as it goes, a moment after the unmount, as Review and approve does.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (mounted.current || handled.current) return;
        handled.current = true;
        bridge.revokePreview(approvalId).catch(() => undefined);
      }, 0);
    };
  }, [bridge, approvalId]);

  const approve = async () => {
    if (typed !== subscriberId) return;
    setBusy(true);
    setProblem(null);
    handled.current = true;
    try {
      const result = await bridge.cli({ kind: 'eventsSubscriberApprove', approvalId, digest });
      if (result.status === 'ok') {
        onApproved();
        return;
      }
      handled.current = false;
      if (result.status === 'failed' && result.code === 'APPROVAL_REQUIRED') setAtTerminal(true);
      setProblem(
        result.status === 'failed'
          ? [`${SUBSCRIPTION_COPY.notApproved}: ${result.message}`, result.hint].filter(Boolean).join(' ')
          : SUBSCRIPTION_COPY.notApproved,
      );
    } catch (error) {
      handled.current = false;
      setProblem(`${SUBSCRIPTION_COPY.notApproved}: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const approveInTerminal = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await bridge.openInTerminal({ kind: 'ruleApprove', approvalId });
      handled.current = true;
      setOpened(outcome);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const back = async () => {
    setBusy(true);
    handled.current = true;
    let revoked: string | null = null;
    try {
      const result = await bridge.revokePreview(approvalId);
      if (result.status !== 'ok') revoked = result.status === 'failed' ? result.message : SUBSCRIPTION_COPY.revoked;
    } catch (error) {
      revoked = errorMessage(error);
    } finally {
      setBusy(false);
    }
    onClosed(revoked);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (open || busy) return;
        if (opened === null) void back();
        else onDone();
      }}
    >
      <Dialog.Content width="md" showCloseButton={false}>
        <Dialog.Title>
          <UntrustedText text={SUBSCRIPTION_COPY.title(subscriberId, prepared.version)} />
        </Dialog.Title>
        <Dialog.Description>{SUBSCRIPTION_COPY.body}</Dialog.Description>
        <div className="flex flex-col gap-(--cue-space-3)">
          <section
            aria-label={SUBSCRIPTION_COPY.receives}
            className="flex flex-col gap-(--cue-space-1) rounded-control bg-warn-subtle p-(--cue-space-3)"
          >
            <h3 className="font-semibold text-fg">{SUBSCRIPTION_COPY.receives}</h3>
            <p className="text-fg" data-slot="subscription-words">
              <UntrustedText text={prepared.words} />
            </p>
          </section>
          <p className="text-(length:--cue-text-label) text-fg-muted">
            {SUBSCRIPTION_COPY.fingerprint}: <span className="break-all font-mono">{digest}</span>
          </p>
          {atTerminal ? (
            <div data-slot="at-terminal" className="flex flex-col gap-(--cue-space-1)">
              <p className="text-fg">{opened === null ? SUBSCRIPTION_COPY.atTerminal : SUBSCRIPTION_COPY.inTerminal}</p>
              {opened === null ? null : <TerminalResult outcome={opened} />}
            </div>
          ) : (
            <Field name="confirm-subscriber">
              <FieldLabel>
                <UntrustedText text={SUBSCRIPTION_COPY.typeToApprove(subscriberId)} />
              </FieldLabel>
              <Input
                value={typed}
                spellCheck={false}
                autoComplete="off"
                onValueChange={(value: string) => setTyped(value)}
              />
            </Field>
          )}
          {problem === null ? null : (
            <p role="alert" className="text-danger">
              <UntrustedText text={problem} />
            </p>
          )}
        </div>
        <Dialog.Footer>
          <Button variant="ghost" disabled={busy} onClick={() => void back()}>
            {SUBSCRIPTION_COPY.back}
          </Button>
          {!atTerminal ? (
            <Button variant="primary" loading={busy} disabled={typed !== subscriberId} onClick={() => void approve()}>
              {SUBSCRIPTION_COPY.approve}
            </Button>
          ) : opened === null ? (
            <Button variant="primary" loading={busy} onClick={() => void approveInTerminal()}>
              {SUBSCRIPTION_COPY.approveInTerminal}
            </Button>
          ) : (
            <Button variant="primary" onClick={onDone}>
              {SUBSCRIPTION_COPY.done}
            </Button>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
