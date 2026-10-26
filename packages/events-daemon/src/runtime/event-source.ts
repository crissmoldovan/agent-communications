/**
 * An event's source ids, read back from the `dedupe_key` its ingest row keeps in the clear (0.32.0 spec §3.5, §3.6):
 * what the person's app joins an event to core's activity lines on, and links to the message with. Ids only — no
 * sender, subject or text is in a key, so none can be read out of one.
 *
 * Each catalogued type writes its key one way (`packages/events/src/catalogue/definitions`):
 * - Gmail's three types: canonical JSON `["<historyId>","<messageId>","received"|"sent"|"labelled"]`;
 * - `slack.message.posted`: `<channelId>/<ts>`, the ts six digits after its point;
 * - `whatsapp.message.received`: `<chatId>/<messageId>`;
 * - `resend.email.received`: the email id, a UUID; `resend.email.status_changed`: canonical JSON
 *   `["<emailId>","<previous>","<current>","<at>"]`.
 *
 * A key that is not exactly its type's shape, or a type outside the catalogue, gives `null`: an unknown source, never a
 * guess at one.
 */

export type EventSource =
  | { channel: 'gmail'; messageId: string }
  | { channel: 'slack'; channelId: string; ts: string }
  | { channel: 'whatsapp'; chatId: string; messageId: string }
  | { channel: 'resend'; emailId: string };

/** One id inside a key: 1 to 512 characters, none of them whitespace or a control character. */
const ID = /^[^\s\p{Cc}]{1,512}$/u;
const HISTORY_ID = /^[0-9]{1,32}$/u;
const SLACK_TS = /^[0-9]+\.[0-9]{6}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** No key of the catalogue's is longer; a longer one is not one of them. */
const MAX_KEY = 2048;

const GMAIL_KINDS: Readonly<Record<string, string>> = Object.freeze({
  'gmail.message.received': 'received',
  'gmail.message.sent': 'sent',
  'gmail.message.labelled': 'labelled',
});

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/** A canonical JSON array of exactly `length` strings, or null. */
function stringArray(key: string, length: number): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== length) return null;
  if (!parsed.every((entry) => typeof entry === 'string')) return null;
  // Canonical: exactly as the catalogue writes it, so a key is read one way only.
  if (JSON.stringify(parsed) !== key) return null;
  return parsed as string[];
}

export function parseEventSource(eventType: string, dedupeKey: string): EventSource | null {
  if (typeof eventType !== 'string' || typeof dedupeKey !== 'string' || dedupeKey.length > MAX_KEY) return null;
  const gmailKind = Object.hasOwn(GMAIL_KINDS, eventType) ? GMAIL_KINDS[eventType] : undefined;
  if (gmailKind !== undefined) {
    const parts = stringArray(dedupeKey, 3);
    if (parts === null) return null;
    const [historyId, messageId, kind] = parts as [string, string, string];
    if (!HISTORY_ID.test(historyId) || kind !== gmailKind || !isId(messageId)) return null;
    return { channel: 'gmail', messageId };
  }
  switch (eventType) {
    case 'slack.message.posted': {
      // A ts has no slash, so the last one splits the key, whatever a channel id holds.
      const at = dedupeKey.lastIndexOf('/');
      const channelId = dedupeKey.slice(0, at);
      const ts = dedupeKey.slice(at + 1);
      if (at < 0 || !isId(channelId) || !SLACK_TS.test(ts)) return null;
      return { channel: 'slack', channelId, ts };
    }
    case 'whatsapp.message.received': {
      // Neither id is shaped, so only a key with exactly one slash splits one way.
      const parts = dedupeKey.split('/');
      if (parts.length !== 2) return null;
      const [chatId, messageId] = parts as [string, string];
      if (!isId(chatId) || !isId(messageId)) return null;
      return { channel: 'whatsapp', chatId, messageId };
    }
    case 'resend.email.received':
      return UUID.test(dedupeKey) ? { channel: 'resend', emailId: dedupeKey } : null;
    case 'resend.email.status_changed': {
      const parts = stringArray(dedupeKey, 4);
      if (parts === null || !UUID.test(parts[0] as string)) return null;
      return { channel: 'resend', emailId: parts[0] as string };
    }
    default:
      return null;
  }
}
