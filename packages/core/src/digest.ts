import { createHash } from 'node:crypto';
import { CommsError } from './errors.ts';

/**
 * The canonical form of an outgoing message that an approval is bound to.
 *
 * It covers what a recipient sees and where the message goes, and leaves out what a provider regenerates on its own
 * — Message-ID, Date, MIME boundaries, transfer encodings — so re-serialising an unchanged draft does not change the
 * digest while any visible change does.
 *
 * Two shapes, because a channel message is not a mail-shaped thing with different field names. Mail goes to a list
 * of addresses and carries a subject; a chat message goes to one channel and its blast radius is *who gets
 * notified*, which has no mail equivalent. Forcing one into the other would mean a digest that covers a recipient
 * list nobody has and omits the thing a person most needs to approve.
 */
export type CanonicalMessage = CanonicalMailMessage | CanonicalChannelMessage;

/** A message with addressed recipients and a subject. `kind` is optional so mail callers need not state the obvious. */
export interface CanonicalMailMessage {
  kind?: 'mail' | undefined;
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  replyTo: readonly string[];
  subject: string;
  threadId?: string | undefined;
  inReplyTo?: string | undefined;
  references?: readonly string[] | undefined;
  /** The whitespace-collapsed text a reader sees (from the HTML part when there is one). */
  visibleText: string;
  /** SHA-256 of the exact HTML part, so any HTML change — visible or not — changes the digest. */
  htmlSha256?: string | undefined;
  /** SHA-256 of the exact text part. */
  textSha256?: string | undefined;
  attachments: readonly { filename: string; mimeType: string; size: number; sha256: string }[];
}

/**
 * A message posted into a channel or thread.
 *
 * `notifies` is the part with no mail equivalent and the reason this is a separate shape. A message naming
 * `@channel` in a 400-person room is a different act from the same words in a two-person thread, and the person
 * approving it is approving the blast radius as much as the words. It is therefore inside the digest: change who
 * gets notified and the approval is void, exactly as adding a recipient voids a mail approval.
 */
export interface CanonicalChannelMessage {
  kind: 'channel';
  /** The workspace by its stable id, not the alias a person chose, which they can move. */
  workspace: string;
  /**
   * The user id this will be posted as — the channel equivalent of `from`, and in the digest for the same reason.
   *
   * Every reader sees who spoke, and two accounts connected to one workspace are two different people saying the
   * same words. Without this, a post approved for the bot and a post from the person who owns the workspace were
   * the same message to the approval, and an agent holding both could spend one on the other.
   *
   * The id, not the display name: a name can be changed between the approval and the post, and the account behind
   * it cannot.
   */
  postingAs: string;
  /** The channel or conversation id. */
  channel: string;
  /** The name at the time, for the preview to show. Not part of the digest: a rename is not a different message. */
  channelName?: string | undefined;
  /** The parent message's timestamp when this is a threaded reply. */
  threadTs?: string | undefined;
  /** The text a reader sees, after the composer has rendered it. */
  visibleText: string;
  /** SHA-256 of the exact payload that will be posted, so a block change the text does not show still counts. */
  payloadSha256: string;
  notifies: {
    /** `@here` — everyone currently online in the channel. */
    here: boolean;
    /** `@channel` — every member, online or not. */
    channel: boolean;
    /** Individually mentioned user ids, sorted and de-duplicated by the digest. */
    users: readonly string[];
    /**
     * How many people the above actually reaches, resolved at preview time.
     *
     * Inside the digest because it is what a person is really approving. If the channel grew between the preview
     * and the post, the message now reaches people nobody agreed to reach, and that deserves a fresh look rather
     * than a silent send.
     */
    estimated: number;
  };
  attachments: readonly { filename: string; mimeType: string; size: number; sha256: string }[];
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Lower-cases the address part of `Name <addr>` or a bare address; display names are dropped. */
export function normaliseAddress(value: string): string {
  const angle = /<([^<>]+)>\s*$/.exec(value);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

function normaliseList(values: readonly string[]): string[] {
  return [...new Set(values.map(normaliseAddress).filter(Boolean))].sort();
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Deterministic JSON: keys sorted at every level, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The approval digest.
 *
 * For mail: the From header keeps its display name (a recipient sees it); recipients are compared by address only,
 * sorted and de-duplicated, so reordering them does not force a new approval but adding one does.
 *
 * **The mail form is byte-identical to what it produced before channels existed**, `kind` deliberately absent from
 * the canonical object. An approval is a record on disk bound to a digest; changing how mail hashes would have
 * voided every approval anybody had outstanding at the moment they upgraded, for no reason a user could see.
 */
export function messageDigest(message: CanonicalMessage): string {
  if (message.kind === 'channel') return channelDigest(message);
  const canonical = {
    v: 1,
    from: collapseWhitespace(message.from),
    to: normaliseList(message.to),
    cc: normaliseList(message.cc),
    bcc: normaliseList(message.bcc),
    replyTo: normaliseList(message.replyTo),
    subject: collapseWhitespace(message.subject),
    threadId: message.threadId,
    inReplyTo: message.inReplyTo?.trim(),
    references: message.references?.map((r) => r.trim()).filter(Boolean),
    visibleText: collapseWhitespace(message.visibleText),
    htmlSha256: message.htmlSha256,
    textSha256: message.textSha256,
    attachments: [...message.attachments]
      .map((a) => ({ filename: a.filename, mimeType: a.mimeType.toLowerCase(), size: a.size, sha256: a.sha256 }))
      .sort((a, b) => (a.sha256 + a.filename < b.sha256 + b.filename ? -1 : 1)),
  };
  return sha256Hex(canonicalJson(canonical));
}

/**
 * The channel form. `v: 'channel-1'` rather than a number, so a channel digest can never collide with a mail one
 * even if every other field happened to line up — the two are answers to different questions.
 *
 * `channelName` is left out on purpose: a channel being renamed between the preview and the post is not a different
 * message going to a different place, and voiding the approval for it would teach people that re-approving is
 * routine.
 */
/**
 * A count that `canonicalJson` can represent without losing it.
 *
 * `JSON.stringify` renders every non-finite number as `null`, so a digest taken over one cannot tell `NaN` from
 * `Infinity` — two previews a person would read as saying different things, hashing to the same approval. Nothing
 * should ever produce one; a digest is the wrong place to find out that something did, so it refuses instead.
 */
function exactCount(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CommsError('BAD_DATA', `${what} must be a whole number of at least zero, not ${String(value)}`);
  }
  return value;
}

function channelDigest(message: CanonicalChannelMessage): string {
  return sha256Hex(
    canonicalJson({
      v: 'channel-1',
      workspace: message.workspace.trim(),
      postingAs: message.postingAs.trim(),
      channel: message.channel.trim(),
      threadTs: message.threadTs?.trim(),
      visibleText: collapseWhitespace(message.visibleText),
      payloadSha256: message.payloadSha256,
      notifies: {
        here: message.notifies.here,
        channel: message.notifies.channel,
        users: [...new Set(message.notifies.users.map((u) => u.trim()).filter(Boolean))].sort(),
        estimated: exactCount(message.notifies.estimated, 'the number of people notified'),
      },
      attachments: [...message.attachments]
        .map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType.toLowerCase(),
          size: exactCount(a.size, `the size of ${a.filename}`),
          sha256: a.sha256,
        }))
        .sort((a, b) => (a.sha256 + a.filename < b.sha256 + b.filename ? -1 : 1)),
    }),
  );
}
