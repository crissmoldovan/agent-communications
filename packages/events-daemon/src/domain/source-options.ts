import { EventDomainError } from './lifecycle.ts';

export interface GmailSourceOptions {
  readonly channel: 'gmail';
  readonly labels: readonly string[] | 'inbox' | 'any';
  readonly includeSpamTrash: boolean;
}

export interface SlackSourceOptions {
  readonly channel: 'slack';
  readonly conversations: readonly string[];
}

export interface ResendSourceOptions {
  readonly channel: 'resend';
  readonly kinds: readonly ('received' | 'status')[];
}

export interface WhatsAppSourceOptions {
  readonly channel: 'whatsapp';
  readonly chats: readonly string[] | 'all-allowed';
}

export type SourceOptions = GmailSourceOptions | SlackSourceOptions | ResendSourceOptions | WhatsAppSourceOptions;
export type SourceOptionChange = 'same' | 'tightening' | 'loosening';

function fail(message: string): never {
  throw new EventDomainError('VERSION_DOCUMENT_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) fail(`${name} has no ${unknown} field`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${name} has a ${key} field`);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function canonicalIds(value: unknown, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === 'string' && entry !== '')
  ) {
    return fail(`${name} is a non-empty id array`);
  }
  const ids = [...value] as string[];
  for (let index = 1; index < ids.length; index += 1) {
    if (compareUtf8(ids[index - 1] as string, ids[index] as string) >= 0) {
      return fail(`${name} is duplicate-free and sorted by raw UTF-8 bytes`);
    }
  }
  return ids;
}

function canonicalLabels(value: unknown): readonly string[] | 'inbox' | 'any' {
  if (value === 'inbox' || value === 'any') return value;
  const labels = canonicalIds(value, 'Gmail label ids');
  if (labels.includes('INBOX')) return fail('the Gmail INBOX selector is written as labels: inbox');
  return labels;
}

/** Validates the Gmail source shape without silently reordering an authority-bound label array. */
export function normaliseGmailSourceOptions(value: unknown): GmailSourceOptions {
  if (!isRecord(value) || value.channel !== 'gmail') return fail('a Gmail source option names the Gmail channel');
  exactKeys(value, ['channel', 'labels', 'includeSpamTrash'], 'a Gmail source option');
  if (typeof value.includeSpamTrash !== 'boolean') return fail('Gmail includeSpamTrash is a boolean');
  return {
    channel: 'gmail',
    labels: canonicalLabels(value.labels),
    includeSpamTrash: value.includeSpamTrash,
  };
}

/** Validates the Phase-D Slack source shape, retaining only canonical conversation ids. */
export function normaliseSlackSourceOptions(value: unknown): SlackSourceOptions {
  if (!isRecord(value) || value.channel !== 'slack') return fail('a Slack source option names the Slack channel');
  exactKeys(value, ['channel', 'conversations'], 'a Slack source option');
  return { channel: 'slack', conversations: canonicalIds(value.conversations, 'Slack conversations') };
}

/** Validates Resend's fixed-order, non-empty event-kind set. */
export function normaliseResendSourceOptions(value: unknown): ResendSourceOptions {
  if (!isRecord(value) || value.channel !== 'resend') return fail('a Resend source option names the Resend channel');
  exactKeys(value, ['channel', 'kinds'], 'a Resend source option');
  if (!Array.isArray(value.kinds) || value.kinds.length === 0) return fail('Resend kinds are a non-empty array');
  const kinds = [...value.kinds];
  if (!kinds.every((kind) => kind === 'received' || kind === 'status')) {
    return fail('Resend kinds are received and status');
  }
  const expected = [...new Set(kinds)].sort((left, right) => (left === 'received' ? -1 : right === 'received' ? 1 : 0));
  if (expected.length !== kinds.length || expected.some((kind, index) => kind !== kinds[index])) {
    return fail('Resend kinds are duplicate-free and ordered received, status');
  }
  return { channel: 'resend', kinds: kinds as ResendSourceOptions['kinds'] };
}

/** Validates the raw WhatsApp chat selector; JIDs stay raw authority-bound strings. */
export function normaliseWhatsAppSourceOptions(value: unknown): WhatsAppSourceOptions {
  if (!isRecord(value) || value.channel !== 'whatsapp')
    return fail('a WhatsApp source option names the WhatsApp channel');
  exactKeys(value, ['channel', 'chats'], 'a WhatsApp source option');
  return {
    channel: 'whatsapp',
    chats: value.chats === 'all-allowed' ? 'all-allowed' : canonicalIds(value.chats, 'WhatsApp chats'),
  };
}

/** D4's closed four-channel source-options union. */
export function normaliseSourceOptions(value: unknown): SourceOptions {
  if (!isRecord(value)) return fail('a source option is an object');
  switch (value.channel) {
    case 'gmail':
      return normaliseGmailSourceOptions(value);
    case 'slack':
      return normaliseSlackSourceOptions(value);
    case 'resend':
      return normaliseResendSourceOptions(value);
    case 'whatsapp':
      return normaliseWhatsAppSourceOptions(value);
    default:
      return fail('a source option has a known channel');
  }
}

function labelSet(options: GmailSourceOptions): ReadonlySet<string> | null {
  if (options.labels === 'any') return null;
  return new Set(options.labels === 'inbox' ? ['INBOX'] : options.labels);
}

function classifySubset<T>(before: readonly T[], after: readonly T[]): SourceOptionChange {
  const previous = new Set(before);
  const next = new Set(after);
  if (previous.size === next.size && [...previous].every((value) => next.has(value))) return 'same';
  return [...next].every((value) => previous.has(value)) ? 'tightening' : 'loosening';
}

/** D2's field-by-field Gmail narrowing rule. Any additive change keeps the whole edit a loosening. */
export function classifyGmailSourceOptionChange(before: unknown, after: unknown): SourceOptionChange {
  const previous = normaliseGmailSourceOptions(before);
  const next = normaliseGmailSourceOptions(after);
  if (previous.labels === next.labels && previous.includeSpamTrash === next.includeSpamTrash) return 'same';
  if (previous.labels === 'any') {
    if (next.labels === 'any') {
      return previous.includeSpamTrash === next.includeSpamTrash
        ? 'same'
        : next.includeSpamTrash
          ? 'loosening'
          : 'tightening';
    }
    return !previous.includeSpamTrash && next.includeSpamTrash ? 'loosening' : 'tightening';
  }
  if (next.labels === 'any') return 'loosening';

  const previousLabels = labelSet(previous) as ReadonlySet<string>;
  const nextLabels = labelSet(next) as ReadonlySet<string>;
  const added = [...nextLabels].some((label) => !previousLabels.has(label));
  const removed = [...previousLabels].some((label) => !nextLabels.has(label));
  const spamLoosened = !previous.includeSpamTrash && next.includeSpamTrash;
  const spamTightened = previous.includeSpamTrash && !next.includeSpamTrash;
  if (added || spamLoosened) return 'loosening';
  if (removed || spamTightened) return 'tightening';
  return 'same';
}

/** D2/D4's one source-option classifier; different source variants can never become a derived edge. */
export function classifySourceOptionChange(before: unknown, after: unknown): SourceOptionChange {
  const previous = normaliseSourceOptions(before);
  const next = normaliseSourceOptions(after);
  if (previous.channel !== next.channel) return fail('source options for a derived edit name the same channel');
  switch (previous.channel) {
    case 'gmail':
      return classifyGmailSourceOptionChange(previous, next);
    case 'slack':
      if (next.channel !== 'slack') return fail('source options for a derived edit name the same channel');
      return classifySubset(previous.conversations, next.conversations);
    case 'resend':
      if (next.channel !== 'resend') return fail('source options for a derived edit name the same channel');
      return classifySubset(previous.kinds, next.kinds);
    case 'whatsapp':
      if (next.channel !== 'whatsapp') return fail('source options for a derived edit name the same channel');
      if (previous.chats === 'all-allowed') return next.chats === 'all-allowed' ? 'same' : 'tightening';
      if (next.chats === 'all-allowed') return 'loosening';
      return classifySubset(previous.chats, next.chats);
  }
}
