/**
 * The source's own ids for an observed event, read back from its ingest `dedupe_key` (owner feedback 0.32.0, §3.5 and
 * §3.6). They are what joins an event to the message it came from: a Gmail message id, a Slack channel id and ts, a
 * WhatsApp chat and message id, or a Resend email id. Ids only: no sender text is ever part of a dedupe key.
 *
 * The keys are the catalogue's (`packages/events/src/catalogue/definitions/*.ts`):
 * - Gmail: canonical JSON `["<historyId>","<messageId>","received"|"sent"|"labelled"]`;
 * - Slack: `<channelId>/<ts>`;
 * - WhatsApp: `<chatId>/<messageId>`;
 * - Resend: `<emailId>` for a received email, canonical JSON `["<emailId>",previous,current,at]` for a status change.
 *
 * A key that does not have its channel's shape gives null, never a guess.
 */
export type EventSource =
  | { channel: 'gmail'; messageId: string }
  | { channel: 'slack'; channelId: string; ts: string }
  | { channel: 'whatsapp'; chatId: string; messageId: string }
  | { channel: 'resend'; emailId: string };

function jsonArray(text: string): readonly unknown[] | null {
  if (!text.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Splits `<left>/<right>` at the given slash, or null when either side is empty. */
function pair(key: string, at: number): readonly [string, string] | null {
  if (at <= 0 || at >= key.length - 1) return null;
  return [key.slice(0, at), key.slice(at + 1)];
}

export function parseEventSource(eventType: string, dedupeKey: string): EventSource | null {
  const channel = eventType.slice(0, eventType.indexOf('.'));
  switch (channel) {
    case 'gmail': {
      const parts = jsonArray(dedupeKey);
      const messageId = parts?.length === 3 ? text(parts[1]) : null;
      return messageId === null ? null : { channel: 'gmail', messageId };
    }
    case 'slack': {
      // A Slack ts is `<seconds>.<micros>` and a channel id has no slash: the last slash splits them.
      const parts = pair(dedupeKey, dedupeKey.lastIndexOf('/'));
      return parts === null || !/^[0-9]+\.[0-9]+$/u.test(parts[1])
        ? null
        : { channel: 'slack', channelId: parts[0], ts: parts[1] };
    }
    case 'whatsapp': {
      // A WhatsApp chat id (a JID such as `<number>@s.whatsapp.net`) has no slash: the first slash splits them.
      const parts = pair(dedupeKey, dedupeKey.indexOf('/'));
      return parts === null ? null : { channel: 'whatsapp', chatId: parts[0], messageId: parts[1] };
    }
    case 'resend': {
      const parts = jsonArray(dedupeKey);
      const emailId = parts === null ? text(dedupeKey) : text(parts[0]);
      return emailId === null ? null : { channel: 'resend', emailId };
    }
    default:
      return null;
  }
}
