import { EventDomainError } from './lifecycle.ts';

export interface GmailSourceOptions {
  readonly channel: 'gmail';
  readonly labels: readonly string[] | 'inbox' | 'any';
  readonly includeSpamTrash: boolean;
}

export type SourceOptionChange = 'same' | 'tightening' | 'loosening';

function fail(message: string): never {
  throw new EventDomainError('VERSION_DOCUMENT_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function canonicalLabels(value: unknown): readonly string[] | 'inbox' | 'any' {
  if (value === 'inbox' || value === 'any') return value;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === 'string' && entry !== '')
  ) {
    return fail('a Gmail label selector is inbox, any, or a non-empty label-id array');
  }
  const labels = [...value] as string[];
  if (labels.includes('INBOX')) return fail('the Gmail INBOX selector is written as labels: inbox');
  for (let index = 1; index < labels.length; index += 1) {
    if (compareUtf8(labels[index - 1] as string, labels[index] as string) >= 0) {
      return fail('Gmail label ids are duplicate-free and sorted by raw UTF-8 bytes');
    }
  }
  return labels;
}

/** Validates the D4 Gmail-only source shape without silently reordering an authority-bound label array. */
export function normaliseGmailSourceOptions(value: unknown): GmailSourceOptions {
  if (!isRecord(value) || value.channel !== 'gmail') return fail('a B1 source option must name the Gmail channel');
  if (typeof value.includeSpamTrash !== 'boolean') return fail('Gmail includeSpamTrash is a boolean');
  return {
    channel: 'gmail',
    labels: canonicalLabels(value.labels),
    includeSpamTrash: value.includeSpamTrash,
  };
}

function labelSet(options: GmailSourceOptions): ReadonlySet<string> | null {
  if (options.labels === 'any') return null;
  return new Set(options.labels === 'inbox' ? ['INBOX'] : options.labels);
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
