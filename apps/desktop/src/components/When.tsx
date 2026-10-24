import { UntrustedText } from './UntrustedText.tsx';

const FORMAT = { dateStyle: 'medium', timeStyle: 'short' } as const;

/**
 * A moment the CLI reported — an ISO time, or milliseconds since the epoch, as the events service writes them — shown
 * in the person's own locale, with the exact instant kept in `dateTime`. A value that is not a time is shown as the
 * text it is.
 */
export function When({ at }: { at: string | number }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <UntrustedText text={String(at)} />;
  return <time dateTime={date.toISOString()}>{date.toLocaleString(undefined, FORMAT)}</time>;
}

/** The units a time ago is said in, largest first, each with its length in milliseconds. */
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

/** How long before `now` the moment `at` was, in the person's own words: "2 minutes ago", "now". */
export function relativeTime(at: Date, now: number = Date.now()): string {
  const elapsed = at.getTime() - now;
  const [unit, length] = UNITS.find(([, size]) => Math.abs(elapsed) >= size) ?? ['second', 1_000];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.trunc(elapsed / length), unit);
}

/** A moment as how long ago it was, with the exact instant kept in `dateTime` and shown in full on hover. */
export function Ago({ at }: { at: string | number }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <UntrustedText text={String(at)} />;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, FORMAT)}>
      {relativeTime(date)}
    </time>
  );
}
