import { UntrustedText } from './UntrustedText.tsx';

/**
 * A moment the CLI reported — an ISO time, or milliseconds since the epoch, as the events service writes them — shown
 * in the person's own locale, with the exact instant kept in `dateTime`. A value that is not a time is shown as the
 * text it is.
 */
export function When({ at }: { at: string | number }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <UntrustedText text={String(at)} />;
  return (
    <time dateTime={date.toISOString()}>
      {date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}
