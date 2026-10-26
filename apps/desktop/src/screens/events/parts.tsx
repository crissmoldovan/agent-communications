/**
 * What Events → Rules and Events → Deliveries share (owner feedback 0.32.0, §3.4, §3.5): a rule's sentence in its
 * parts, an author's or a sender's text as text and nothing else, short times, and the line a read that went wrong
 * says. Nothing here reads markup: every string reaches the page as a text node.
 */
import { Button, Chip } from '@cueplusplus/ui';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { type AccountNames, aliasOf } from '../../account-aliases.ts';
import { OutsideText } from '../../components/OutsideText.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY } from '../../copy.ts';
import { splitEnvelopes } from '../../envelope.ts';
import { type RulePart, type RuleStatus, type RuleVersionView, ruleStatus } from '../../events-rules.ts';

/**
 * What a rule's author wrote — a condition's operand, the judge's question — as text in a quiet box: an agent wrote it
 * and the person approved it, so it is set apart from the app's own words and never read as markup.
 */
export function AuthorText({ text }: { text: string }) {
  return (
    <span
      data-part="untrusted"
      className="rounded-control bg-surface-2 px-(--cue-space-1) box-decoration-clone text-fg"
    >
      <UntrustedText text={text} />
    </span>
  );
}

/**
 * What a sender wrote — a name, an address, a subject, a field of a dry-run record — boxed and marked From outside, as
 * the Activity timeline marks it. Text inside the CLI's envelope keeps its own box; bare text is given one.
 */
export function SenderText({ text }: { text: string }) {
  if (splitEnvelopes(text).some((part) => part.kind === 'outside')) return <OutsideText text={text} />;
  return (
    <span
      data-slot="from-outside"
      title={COPY.fromOutside}
      className="rounded-control border border-border-strong bg-sunken px-(--cue-space-1) box-decoration-clone"
    >
      <span className="sr-only">{`${COPY.fromOutside}: `}</span>
      <span className="whitespace-pre-wrap break-words">{text}</span>
    </span>
  );
}

/** The visible From outside mark a section of sender text carries, once for all its boxes. */
export function FromOutsideMark() {
  return (
    <Chip tone="warn" variant="tag" data-slot="from-outside-label">
      {COPY.fromOutside}
    </Chip>
  );
}

/**
 * A sentence in its parts: plain words as they are, a value emphasised, an author's text boxed. A value that is an
 * account's id is said as the account's alias, as the Accounts screen names it.
 */
export function Sentence({ parts, names }: { parts: readonly RulePart[]; names: AccountNames }) {
  return (
    <>
      {parts.map((part, index) => {
        // The parts come in the sentence's order and never move: their place is what tells two equal ones apart.
        const key = `${index}-${part.kind}`;
        if (part.kind === 'untrusted') return <AuthorText key={key} text={part.text} />;
        if (part.kind === 'value') {
          return (
            <strong key={key} data-part="value" className="font-medium text-fg">
              <UntrustedText text={aliasOf(names, part.text)} />
            </strong>
          );
        }
        return <UntrustedText key={key} text={part.text} />;
      })}
    </>
  );
}

const FULL = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** A moment in milliseconds, short: the time alone when it is today, the day and time otherwise; the whole on hover. */
export function Short({ at }: { at: number }) {
  const date = new Date(at);
  const today = date.toDateString() === new Date().toDateString();
  const shown = today
    ? date.toLocaleTimeString(undefined, { timeStyle: 'short' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, FULL)}>
      {shown}
    </time>
  );
}

/** A day in milliseconds: "Oct 25", with the whole moment on hover. */
export function Day({ at }: { at: number }) {
  const date = new Date(at);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, FULL)}>
      {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
    </time>
  );
}

/** Back to a tab's list, from one of its pages. */
export function BackTo({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div>
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
        {label}
      </Button>
    </div>
  );
}

/** What a read or a change came to when it went wrong, as text. */
export function Problem({ message }: { message: string }) {
  return (
    <p role="alert" className="text-danger">
      <UntrustedText text={message} />
    </p>
  );
}

/** A line of quiet facts, said with a dot between each. */
export function FactsLine({ facts }: { facts: readonly ReactNode[] }) {
  const shown = facts.filter((fact) => fact !== null && fact !== false);
  if (shown.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
      {shown.map((fact, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the facts come in a fixed order and never move.
        <span key={index} className="flex gap-x-(--cue-space-2)">
          {index === 0 ? null : <span aria-hidden="true">·</span>}
          <span>{fact}</span>
        </span>
      ))}
    </span>
  );
}

/** A rule's state, in words: on, not switched on yet, or off. */
export const STATUS_WORDS = { on: 'On', 'not-switched-on': 'Not switched on', off: 'Off' } as const satisfies Record<
  RuleStatus,
  string
>;

/** The chip beside a rule whose every target is the dry-run log. */
export const DRY_RUN = 'Dry run';

/** A rule's state, in a chip: on in the ok tone, not switched on as a caution, off quietly. */
export function StatusChip({ status }: { status: RuleStatus }) {
  const tone = status === 'on' ? 'ok' : status === 'not-switched-on' ? 'warn' : 'neutral';
  return (
    <Chip tone={tone} data-slot="rule-status">
      {STATUS_WORDS[status]}
    </Chip>
  );
}

/** A rule's status: from its versions once read, else as the list's rows have it. */
export function statusOf(listed: RuleStatus | null, versions: readonly RuleVersionView[] | null): RuleStatus | null {
  return versions === null || versions.length === 0 ? listed : ruleStatus(versions);
}
