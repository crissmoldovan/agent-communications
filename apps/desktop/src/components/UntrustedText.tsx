import { Chip } from '@cueplusplus/ui';
import { COPY } from '../copy.ts';
import { splitEnvelopes } from '../envelope.ts';

/** Text, kept as one text node with its line breaks: no markup in it is ever read as markup. */
function Plain({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}

/**
 * What a sender wrote, as the CLI's untrusted-content envelope holds it: marked as from outside, with the content as
 * text and nothing of the tag shown.
 */
function FromOutside({ text }: { text: string }) {
  return (
    <span
      data-slot="from-outside"
      className="inline-flex max-w-full flex-col items-start gap-(--cue-space-1) rounded-control border border-border-strong bg-sunken px-(--cue-space-2) py-(--cue-space-1) align-top"
    >
      <Chip tone="warn" variant="tag" data-slot="from-outside-label">
        {COPY.fromOutside}
      </Chip>
      <Plain text={text} />
    </span>
  );
}

/**
 * Text someone else wrote — a sender, a workspace, a CLI preview — shown as text and nothing else (DA4, DA11). Each
 * untrusted-content envelope in it shows as a "From outside" block (`envelope.ts`); text with none is one text node,
 * as it always was.
 */
export function UntrustedText({ text }: { text: string }) {
  const parts = splitEnvelopes(text);
  if (!parts.some((part) => part.kind === 'outside')) return <Plain text={text} />;
  return (
    <span className="break-words">
      {parts.map((part, index) =>
        // The parts come in the text's order and never move; their place is what tells two equal ones apart.
        part.kind === 'outside' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are never reordered.
          <FromOutside key={index} text={part.text} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are never reordered.
          <Plain key={index} text={part.text} />
        ),
      )}
    </span>
  );
}
