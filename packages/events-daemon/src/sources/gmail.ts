import type { GmailHistoryPage } from '@agentcomms/gmail';
import type { GmailSourceOptions } from '../domain/source-options.ts';

export type GmailMessageSelection =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: 'draft' | 'spam-trash' | 'label' };

/**
 * Applies the source selector to observation-time metadata. Gmail's `any` selector is deliberately not a bypass for
 * DRAFT: drafts are not mailbox events in B1, whatever labels a provider happened to put on them.
 */
export function classifyGmailMessage(
  options: Pick<GmailSourceOptions, 'labels' | 'includeSpamTrash'>,
  message: Pick<{ readonly labelIds?: readonly string[] | null }, 'labelIds'>,
): GmailMessageSelection {
  const labels = new Set(message.labelIds ?? []);
  if (labels.has('DRAFT')) return { eligible: false, reason: 'draft' };
  if (!options.includeSpamTrash && (labels.has('SPAM') || labels.has('TRASH')))
    return { eligible: false, reason: 'spam-trash' };
  if (options.labels === 'any') return { eligible: true };
  const wanted = options.labels === 'inbox' ? ['INBOX'] : options.labels;
  return wanted.some((label) => labels.has(label)) ? { eligible: true } : { eligible: false, reason: 'label' };
}

/**
 * D4: a labelled occurrence is matched on the union of its own added and removed label ids — for the selector and for
 * `includeSpamTrash` — never on a metadata snapshot. A removal of a selected label therefore matches, as does its add.
 */
export function classifyGmailLabelChange(
  options: Pick<GmailSourceOptions, 'labels' | 'includeSpamTrash'>,
  change: { readonly added: readonly string[]; readonly removed: readonly string[] },
): GmailMessageSelection {
  const labels = new Set([...change.added, ...change.removed]);
  if (!options.includeSpamTrash && (labels.has('SPAM') || labels.has('TRASH')))
    return { eligible: false, reason: 'spam-trash' };
  if (options.labels === 'any') return { eligible: true };
  const wanted = options.labels === 'inbox' ? ['INBOX'] : options.labels;
  return wanted.some((label) => labels.has(label)) ? { eligible: true } : { eligible: false, reason: 'label' };
}

export interface GmailAddedOccurrence {
  readonly kind: 'message';
  readonly historyRecordId: string;
  readonly messageId: string;
  readonly threadId: string | undefined;
}

export interface GmailLabelledOccurrence {
  readonly kind: 'labelled';
  readonly historyRecordId: string;
  readonly messageId: string;
  readonly threadId: string | undefined;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export type GmailHistoryOccurrence = GmailAddedOccurrence | GmailLabelledOccurrence;

function orderedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

/**
 * Reduces only the specific Gmail history arrays. A generic `messages` record is a convenience summary, not an event
 * occurrence, and using it here would duplicate an added or labelled event.
 */
export function occurrencesFromHistory(page: GmailHistoryPage): readonly GmailHistoryOccurrence[] {
  const result: GmailHistoryOccurrence[] = [];
  for (const record of page.history) {
    const additions = new Map<string, string | undefined>();
    const labels = new Map<string, { threadId: string | undefined; added: string[]; removed: string[] }>();
    for (const change of record.messagesAdded) {
      if (!additions.has(change.message.id)) additions.set(change.message.id, change.message.threadId);
    }
    for (const [messageId, threadId] of additions) {
      result.push({
        kind: 'message',
        historyRecordId: record.id,
        messageId,
        threadId,
      });
    }
    for (const change of record.labelsAdded) {
      const current = labels.get(change.message.id) ?? {
        threadId: change.message.threadId,
        added: [],
        removed: [],
      };
      current.threadId ??= change.message.threadId;
      current.added.push(...change.labelIds);
      labels.set(change.message.id, current);
    }
    for (const change of record.labelsRemoved) {
      const current = labels.get(change.message.id) ?? {
        threadId: change.message.threadId,
        added: [],
        removed: [],
      };
      current.threadId ??= change.message.threadId;
      current.removed.push(...change.labelIds);
      labels.set(change.message.id, current);
    }
    for (const [messageId, change] of labels) {
      const added = orderedUnique(change.added);
      const removed = orderedUnique(change.removed);
      const overlap = new Set(added);
      if (removed.some((label) => overlap.has(label))) {
        throw new Error('one Gmail history record cannot add and remove the same label for one labelled occurrence');
      }
      if (added.length === 0 && removed.length === 0) continue;
      result.push({
        kind: 'labelled',
        historyRecordId: record.id,
        messageId,
        threadId: change.threadId,
        added,
        removed,
      });
    }
  }
  return result;
}
