import { COPY } from '../copy.ts';
import { splitEnvelopes } from '../envelope.ts';

/**
 * What a sender wrote, inside a line of the app's own words — a subject, a name, a file — as `UntrustedText` shows it,
 * but in the run of the line rather than as a block of its own: each untrusted-content envelope becomes a boxed span,
 * marked From outside for a screen reader and on hover, its content one text node. Text with no envelope (an address
 * core left bare) is one text node too. Nothing here is ever read as markup.
 *
 * The line it sits in carries the visible From outside mark (the Activity screen's timeline), once for all its boxes.
 */
export function OutsideText({ text }: { text: string }) {
  return (
    <>
      {splitEnvelopes(text).map((part, index) =>
        part.kind === 'outside' ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts come in the text's order and never move.
            key={index}
            data-slot="from-outside"
            title={COPY.fromOutside}
            className="rounded-control border border-border-strong bg-sunken px-(--cue-space-1) box-decoration-clone"
          >
            <span className="sr-only">{`${COPY.fromOutside}: `}</span>
            <span className="whitespace-pre-wrap break-words">{part.text}</span>
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts come in the text's order and never move.
          <span key={index} className="whitespace-pre-wrap break-words">
            {part.text}
          </span>
        ),
      )}
    </>
  );
}
