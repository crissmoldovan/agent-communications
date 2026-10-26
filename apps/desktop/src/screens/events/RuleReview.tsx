/**
 * Review and approve (0.33.0, design §3.1, the prototype's dialog): the activation the editor prepared, as its own
 * preview says it — what changes, and what leaves this Mac — and the person's approval of it, in the app. They type
 * the rule's name and press Approve and switch on; only that runs `rule approve`, for exactly this approval and its
 * digest, which Rust answers only for the activation the app prepared. Back, or leaving, revokes the approval: the new
 * version is never switched on, and the one that runs keeps running.
 */
import { Button, Dialog, Field, FieldLabel, Input } from '@cueplusplus/ui';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AccountNames } from '../../account-aliases.ts';
import { aliasOf } from '../../account-aliases.ts';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { errorMessage } from '../../ipc.ts';
import { REVIEW_COPY as COPY } from '../../rule-editor/copy.ts';
import type { JsonObject } from '../../rule-editor/model.ts';
import { whatChanges, whatLeaves } from '../../rule-editor/submit.ts';
import { Sentence } from './parts.tsx';

/** An activation the editor prepared, waiting for the person. */
export interface PreparedReview {
  ruleId: string;
  version: number;
  approvalId: string;
  digest: string;
  /** The rule the activation would switch on, as its own preview says it. */
  rule: JsonObject;
  /** The version that runs now, and its document; null for a new rule. */
  running: { version: number; document: JsonObject | null } | null;
}

export function RuleReview({
  review,
  names,
  onApproved,
  onClosed,
}: {
  review: PreparedReview;
  names: AccountNames;
  onApproved: () => void;
  /** Revoked, or left: nothing was switched on. */
  onClosed: (problem: string | null) => void;
}) {
  const bridge = useBridge();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Whether Approve or Back has the approval in hand: then leaving revokes nothing.
  const handled = useRef(false);
  const { approvalId, digest } = review;

  // Left behind — the editor closed, or the screen changed — revokes the approval as it goes, as `ChangePreview` does:
  // a moment after the unmount, so React's StrictMode rehearsal, which mounts it again at once, revokes nothing.
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
    if (typed !== review.ruleId) return;
    setBusy(true);
    setProblem(null);
    handled.current = true;
    try {
      const result = await bridge.cli({ kind: 'eventsRuleApprove', approvalId, digest });
      if (result.status === 'ok') {
        onApproved();
        return;
      }
      handled.current = false;
      setProblem(
        result.status === 'failed'
          ? [`${COPY.notApproved}: ${result.message}`, result.hint].filter(Boolean).join(' ')
          : COPY.notApproved,
      );
    } catch (error) {
      handled.current = false;
      setProblem(`${COPY.notApproved}: ${errorMessage(error)}`);
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
      if (result.status !== 'ok') revoked = result.status === 'failed' ? result.message : COPY.revoked;
    } catch (error) {
      revoked = errorMessage(error);
    } finally {
      setBusy(false);
    }
    onClosed(revoked);
  };

  const before = review.running?.document ?? null;
  const changes = whatChanges(before, review.rule, (id) => aliasOf(names, id));
  const leaves = whatLeaves(review.rule);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && void back()}>
      <Dialog.Content width="md" showCloseButton={false}>
        <Dialog.Title>{COPY.title(review.version, review.ruleId)}</Dialog.Title>
        <Dialog.Description>
          {review.running === null ? COPY.nothingRuns : COPY.running(review.running.version)}
        </Dialog.Description>
        <div className="flex flex-col gap-(--cue-space-3)">
          <section aria-label={COPY.whatChanges} className="flex flex-col gap-(--cue-space-1)">
            <h3 className="font-medium text-fg">{COPY.whatChanges}</h3>
            <ul className="flex flex-col gap-(--cue-space-1)">
              {changes.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines come in the sections' fixed order.
                <li key={index} className="flex items-start gap-(--cue-space-2)">
                  <Plus aria-hidden="true" className="mt-0.5 size-(--cue-icon-sm) shrink-0 text-ok" />
                  <span>
                    <Sentence parts={line} names={names} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-label={COPY.whatLeaves} className="rounded-control bg-warn-subtle p-(--cue-space-3)">
            <h3 className="font-semibold text-fg">{COPY.whatLeaves}</h3>
            <ul className="flex flex-col gap-(--cue-space-1)">
              {leaves.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines come in the rule's fixed order.
                <li key={index}>
                  <Sentence parts={line} names={names} />
                </li>
              ))}
            </ul>
          </section>
          <p className="text-(length:--cue-text-label) text-fg-muted">
            {COPY.fingerprint}: <span className="break-all font-mono">{digest}</span>
          </p>
          <Field name="confirm">
            <FieldLabel>{COPY.typeToApprove(review.ruleId)}</FieldLabel>
            <Input
              value={typed}
              spellCheck={false}
              autoComplete="off"
              onValueChange={(value: string) => setTyped(value)}
            />
          </Field>
          {problem === null ? null : (
            <p role="alert" className="text-danger">
              <UntrustedText text={problem} />
            </p>
          )}
        </div>
        <Dialog.Footer>
          <Button variant="ghost" disabled={busy} onClick={() => void back()}>
            {COPY.back}
          </Button>
          <Button variant="primary" loading={busy} disabled={typed !== review.ruleId} onClick={() => void approve()}>
            {COPY.approve}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
