import { Chip } from '@cueplusplus/ui';
import { OutsideText } from '../components/OutsideText.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import type { JoinedMessage } from '../messages/join.ts';
import type { SenderView } from '../messages/read.ts';
import { type Part, statusLabel, unknownSender } from '../messages/story.ts';

/*
 * The parts the Messages list and a message's story share (spec 2026-10-26-owner-feedback-0320 §3.6): what went wrong,
 * a run of the app's and a rule author's words, who a message is from, and its status chip.
 */

/** What went wrong, as text. */
export function Problem({ message }: { message: string }) {
  return (
    <p role="alert" className="text-danger">
      <UntrustedText text={message} />
    </p>
  );
}

/** A run of the app's words and the rule author's, which are shown as text and nothing else. */
export function Said({ parts }: { parts: readonly Part[] }) {
  return (
    <>
      {parts.map((part, index) =>
        'untrusted' in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts come in their order and never move.
          <UntrustedText key={index} text={part.untrusted} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts come in their order and never move.
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Who a message is from and what it is about, each the sender's words, boxed From outside; or what it is, unkept. */
export function Sender({ sender, channel }: { sender: SenderView | null; channel: string }) {
  if (sender === null) return <span className="text-fg-muted">{unknownSender(channel)}</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-(--cue-space-2) gap-y-(--cue-space-1)">
      {sender.name === null ? null : (
        <span className="font-medium text-fg" data-slot="message-from">
          <OutsideText text={sender.name} />
        </span>
      )}
      {sender.address === null ? null : (
        <span className="text-(length:--cue-text-ui) text-fg-muted">
          <OutsideText text={sender.address} />
        </span>
      )}
      {sender.subject === null ? null : (
        <span className="text-fg" data-slot="message-subject">
          <OutsideText text={sender.subject} />
        </span>
      )}
    </span>
  );
}

/** The status chip: Replied, Acknowledged, Done or Dismissed with who, Read by an agent, Waiting for you, Not seen. */
export function StatusChip({ message }: { message: JoinedMessage }) {
  const { label, tone } = statusLabel(message.status);
  return (
    <Chip tone={tone} variant="tinted" data-slot="message-status">
      {label}
    </Chip>
  );
}
