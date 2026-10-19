import { Button, DescriptionList, Panel, PanelHeader } from '@cueplusplus/ui';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { COPY } from '../copy.ts';
import { useAppData } from '../data.tsx';
import { useChange } from '../hooks/use-change.ts';
import { errorMessage, type Product, type TerminalOutcome } from '../ipc.ts';
import { TerminalResult } from './TerminalResult.tsx';
import { UntrustedText } from './UntrustedText.tsx';

/**
 * One waiting approval, as `approvals list` summarises it (DA11), read into strings and lists of strings only: every
 * field the CLI might leave out or send in another shape is read here, so nothing else has to guess.
 */
export interface ApprovalSummary {
  approvalId: string;
  kind: string | null;
  /** The channel's word, or null for core's own. */
  channel: string | null;
  state: string;
  createdAt: string | null;
  expiresAt: string | null;
  /** An earlier release's record: shown, never used here. */
  legacy: boolean;
  /** Where it stands, in core's words. */
  said: string | null;
  /** Why a corrupt record could not be read. */
  reason: string | null;
  /** Each inside its untrusted-content envelope, as the CLI gave it. */
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  files: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];

/**
 * The approvals list, read: one summary per record that has an id, or null when the answer is not a list at all.
 */
export function readApprovals(value: unknown): ApprovalSummary[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(isRecord)
    .filter((record) => typeof record.approvalId === 'string')
    .map((record) => {
      const expected = isRecord(record.expect) ? record.expect : {};
      const files = isRecord(record.files) ? record.files : {};
      return {
        approvalId: record.approvalId as string,
        kind: textOrNull(record.kind),
        channel: textOrNull(record.channel),
        state: textOrNull(record.state) ?? 'pending',
        createdAt: textOrNull(record.createdAt),
        expiresAt: textOrNull(record.expiresAt),
        legacy: record.legacy === true,
        said: textOrNull(record.said),
        reason: textOrNull(record.reason),
        to: strings(expected.to),
        cc: strings(expected.cc),
        bcc: strings(expected.bcc),
        subject: textOrNull(expected.subject),
        files: strings(files.names),
      };
    });
}

/** What a product or channel is called on screen. A word this release does not know is shown as it came. */
export function productLabel(product: string | null): string {
  switch (product) {
    case null:
    case 'core':
      return 'agent-communications';
    case 'gmail':
      return 'Gmail';
    case 'slack':
      return 'Slack';
    case 'resend':
      return 'Resend';
    case 'whatsapp':
      return 'WhatsApp';
    case 'events-daemon':
      return 'Events';
    default:
      return product;
  }
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  send: 'Send',
  change: 'Change',
  download: 'Download',
  disclosure: 'Disclosure',
  standing: 'Standing approval',
};

/** The products whose launcher takes `approve <id>` (DA10). */
const APPROVERS: readonly Product[] = ['core', 'gmail', 'slack', 'resend', 'whatsapp'];

/**
 * The launcher that approves this one, when it can be approved from here: core's own changes through core, a channel's
 * through that channel's, and only when that launcher is on this machine. An earlier release's record, and one that is
 * not pending, are never sent to Terminal.
 */
export function approverOf(approval: ApprovalSummary, present: readonly Product[]): Product | null {
  if (approval.legacy || approval.state !== 'pending') return null;
  const product = (approval.channel ?? 'core') as Product;
  return APPROVERS.includes(product) && present.includes(product) ? product : null;
}

/** A time the CLI gave, as this machine's locale writes it; a time that cannot be read is shown as it came. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** A time, readable, with the CLI's own value kept on the element. */
export function When({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatWhen(iso)}</time>;
}

/** A term and what it names, left out when there is nothing to say. */
function Pair({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <DescriptionList.Term>{term}</DescriptionList.Term>
      <DescriptionList.Detail>{children}</DescriptionList.Detail>
    </>
  );
}

/** Strings a sender controls, one to a line, each as plain text. */
function SenderText({ texts }: { texts: string[] }) {
  return (
    <div className="flex flex-col gap-(--cue-space-1) font-mono">
      {texts.map((text, index) => (
        // The same address may appear twice; its place in the list is what tells them apart.
        // biome-ignore lint/suspicious/noArrayIndexKey: the list is never reordered.
        <div key={index}>
          <UntrustedText text={text} />
        </div>
      ))}
    </div>
  );
}

/**
 * One approval that waits (DA5.3, DA11): its kind, channel, id and times, and every string a sender wrote as plain
 * text. `Revoke` applies at once and reads the list again. `Approve in Terminal` opens that channel's approve, through
 * its own launcher, where the person types the code: the app never approves. `selected` marks the one a link opened,
 * scrolls to it and gives it the focus.
 */
export function ApprovalCard({
  approval,
  approver,
  selected = false,
}: {
  approval: ApprovalSummary;
  /** The launcher that approves it, or null when it cannot be approved from here. */
  approver: Product | null;
  selected?: boolean;
}) {
  const bridge = useBridge();
  const { refresh } = useAppData();
  const change = useChange();
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<'revoke' | 'approve' | null>(null);
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);

  useEffect(() => {
    const element = card.current;
    if (!selected || element === null) return;
    element.focus({ preventScroll: true });
    if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
  }, [selected]);

  const revoke = async () => {
    setBusy('revoke');
    setProblem(null);
    try {
      const outcome = await change.run({ kind: 'approvalRevoke', approvalId: approval.approvalId });
      if (outcome.state === 'applied') {
        await refresh('approvals');
        return;
      }
      setProblem(
        outcome.state === 'failed'
          ? { message: outcome.message, hint: outcome.hint }
          : { message: 'This approval was not revoked.', hint: null },
      );
    } finally {
      setBusy(null);
    }
  };

  const approve = async (product: Product) => {
    setBusy('approve');
    setProblem(null);
    try {
      setOpened(await bridge.openInTerminal({ kind: 'approve', product, approvalId: approval.approvalId }));
    } catch (error) {
      setProblem({ message: errorMessage(error), hint: null });
    } finally {
      setBusy(null);
    }
  };

  const kind = (approval.kind === null ? undefined : KIND_WORDS[approval.kind]) ?? approval.kind ?? 'Approval';
  const title = `${kind} · ${productLabel(approval.channel)}`;
  const isChange = approval.kind === 'change';

  return (
    <article
      ref={card}
      aria-labelledby={titleId}
      aria-current={selected ? 'true' : undefined}
      tabIndex={-1}
      className="outline-none"
    >
      <Panel className={selected ? 'border-accent' : undefined}>
        <PanelHeader
          title={<span id={titleId}>{title}</span>}
          actions={
            approval.state === 'corrupt' ? undefined : (
              <>
                {approver === null ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === 'approve'}
                    disabled={busy !== null}
                    onClick={() => void approve(approver)}
                  >
                    {COPY.approveInTerminal}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy === 'revoke'}
                  disabled={busy !== null}
                  onClick={() => void revoke()}
                >
                  {COPY.revoke}
                </Button>
              </>
            )
          }
        >
          <span className="font-mono text-fg-muted">{approval.approvalId}</span>
        </PanelHeader>
        <div className="flex flex-col gap-(--cue-space-3) px-(--cue-pad-row-x) py-(--cue-pad-row-y)">
          <DescriptionList.Root>
            {approval.createdAt === null ? null : (
              <Pair term="Created">
                <When iso={approval.createdAt} />
              </Pair>
            )}
            {approval.expiresAt === null ? null : (
              <Pair term="Expires">
                <When iso={approval.expiresAt} />
              </Pair>
            )}
            {approval.to.length === 0 ? null : (
              <Pair term="To">
                <SenderText texts={approval.to} />
              </Pair>
            )}
            {approval.cc.length === 0 ? null : (
              <Pair term="Cc">
                <SenderText texts={approval.cc} />
              </Pair>
            )}
            {approval.bcc.length === 0 ? null : (
              <Pair term="Bcc">
                <SenderText texts={approval.bcc} />
              </Pair>
            )}
            {approval.subject === null || approval.subject === '' ? null : (
              <Pair term={isChange ? 'Summary' : 'Subject'}>
                <SenderText texts={[approval.subject]} />
              </Pair>
            )}
            {approval.files.length === 0 ? null : (
              <Pair term="Files">
                <SenderText texts={approval.files} />
              </Pair>
            )}
            {approval.said === null ? null : <Pair term="Where it stands">{approval.said}</Pair>}
            {approval.reason === null ? null : <Pair term="Why">{approval.reason}</Pair>}
          </DescriptionList.Root>
          {opened === null ? null : <TerminalResult outcome={opened} />}
          {problem === null ? null : (
            <p role="alert" className="text-danger">
              <UntrustedText text={problem.hint === null ? problem.message : `${problem.message} ${problem.hint}`} />
            </p>
          )}
        </div>
      </Panel>
    </article>
  );
}
