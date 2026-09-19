import { createHash } from 'node:crypto';

/**
 * The canonical form of an outgoing message that an approval is bound to. Provider-neutral: every mail provider can
 * produce it. It covers what a recipient sees and where the message goes; it leaves out what a provider regenerates
 * on its own (Message-ID, Date, MIME boundaries, transfer encodings), so re-serialising an unchanged draft does not
 * change the digest, while any visible change does.
 */
export interface CanonicalMessage {
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
 * The approval digest. The From header keeps its display name (a recipient sees it); recipients are compared by
 * address only, sorted and de-duplicated, so reordering them does not force a new approval but adding one does.
 */
export function messageDigest(message: CanonicalMessage): string {
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
