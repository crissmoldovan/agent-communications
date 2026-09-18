import { CommsError, recipientDomains } from '@cloudpixel/comms-core';
import type { GmailContext } from '../context.ts';

/**
 * Moving mail around: labels, archiving, read state, stars, the bin.
 *
 * These change the mailbox but send nothing, so they are gated by permission rather than by approval. What they do
 * need is **a way to see what would happen before it happens**, because "archive everything from this sender" is
 * easy to say and hard to undo across a thousand messages: every operation takes a dry run, reports what it would
 * touch, and returns what it did in a form that can be reversed.
 */

export interface ModifyOptions {
  /** Messages to change. Ids come from search or from reading a thread. */
  messageIds?: string[] | undefined;
  /** Whole threads to change — every message in them. */
  threadIds?: string[] | undefined;
  addLabels?: string[] | undefined;
  removeLabels?: string[] | undefined;
  /** Remove INBOX: the message stays, and stops being in the inbox. */
  archive?: boolean | undefined;
  markRead?: boolean | undefined;
  markUnread?: boolean | undefined;
  star?: boolean | undefined;
  unstar?: boolean | undefined;
  /** Report what would change and do nothing. */
  dryRun?: boolean | undefined;
}

export interface ModifyResult {
  inbox: string;
  dryRun: boolean;
  /** How many messages the change applies to. */
  messages: number;
  threads: number;
  addLabelIds: string[];
  removeLabelIds: string[];
  /** What to pass to put it back, when the change is reversible. */
  undo: { addLabelIds: string[]; removeLabelIds: string[]; messageIds: string[] } | null;
}

/** Resolves a label the way a person means it: by id, by its Gmail name, or by a system name in any case. */
export async function resolveLabelIds(
  context: GmailContext,
  alias: string,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const transport = await context.transport(alias);
  const labels = await transport.listLabels();
  const byId = new Map(labels.map((label) => [label.id, label.id]));
  const byName = new Map(labels.map((label) => [label.name.toLowerCase(), label.id]));

  return names.map((name) => {
    const exact = byId.get(name);
    if (exact) return exact;
    const named = byName.get(name.toLowerCase());
    if (named) return named;
    const system = name.toUpperCase().replace(/[\s-]+/g, '_');
    if (byId.has(system)) return system;
    throw new CommsError('NOT_FOUND', `no label called "${name}"`, {
      hint: `Labels in this mailbox: ${labels
        .map((label) => label.name)
        .slice(0, 20)
        .join(', ')}.`,
    });
  });
}

export async function modify(context: GmailContext, alias: string, options: ModifyOptions): Promise<ModifyResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'organize');
  const transport = await context.transport(alias);

  const messageIds = options.messageIds ?? [];
  const threadIds = options.threadIds ?? [];
  if (messageIds.length === 0 && threadIds.length === 0) {
    throw new CommsError('USAGE', 'name the messages or threads to change', {
      hint: 'Pass messageIds or threadIds; search returns both.',
    });
  }

  const add = new Set(await resolveLabelIds(context, alias, options.addLabels ?? []));
  const remove = new Set(await resolveLabelIds(context, alias, options.removeLabels ?? []));
  if (options.archive) remove.add('INBOX');
  if (options.markRead) remove.add('UNREAD');
  if (options.markUnread) add.add('UNREAD');
  if (options.star) add.add('STARRED');
  if (options.unstar) remove.add('STARRED');

  const overlap = [...add].filter((label) => remove.has(label));
  if (overlap.length > 0) {
    throw new CommsError('USAGE', `${overlap.join(', ')} would be both added and removed`, {
      hint: 'Ask for one or the other.',
    });
  }
  if (add.size === 0 && remove.size === 0) {
    throw new CommsError('USAGE', 'nothing to change', {
      hint: 'Pass labels to add or remove, or one of --archive, --read, --unread, --star, --unstar.',
    });
  }

  // Threads are expanded to their messages, so the count reported is the number of messages that will change.
  const expanded: string[] = [...messageIds];
  for (const threadId of threadIds) {
    const thread = await transport.getThread(threadId);
    for (const message of thread.messages ?? []) if (message.id) expanded.push(message.id);
  }
  const unique = [...new Set(expanded)];

  const result: ModifyResult = {
    inbox: alias,
    dryRun: Boolean(options.dryRun),
    messages: unique.length,
    threads: threadIds.length,
    addLabelIds: [...add],
    removeLabelIds: [...remove],
    // Putting it back is the same change with the two lists swapped.
    undo: { addLabelIds: [...remove], removeLabelIds: [...add], messageIds: unique },
  };
  if (options.dryRun) return result;

  await transport.modifyMessages(unique, [...add], [...remove]);
  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'modify',
    outcome: 'ok',
    surface: context.surface,
    ids: { messageIds: unique },
    reason: `+${[...add].join(',') || 'none'} -${[...remove].join(',') || 'none'}`,
  });
  return result;
}

export interface TrashResult {
  inbox: string;
  dryRun: boolean;
  messages: string[];
  action: 'trash' | 'untrash';
}

/**
 * Moves messages to the bin, or takes them out again. Nothing is deleted outright: Gmail keeps a binned message for
 * thirty days, so this is reversible, and permanent deletion is not offered at all.
 */
export async function trash(
  context: GmailContext,
  alias: string,
  options: {
    messageIds?: string[] | undefined;
    threadIds?: string[] | undefined;
    undo?: boolean | undefined;
    dryRun?: boolean | undefined;
  },
): Promise<TrashResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'organize');
  const transport = await context.transport(alias);

  const expanded: string[] = [...(options.messageIds ?? [])];
  for (const threadId of options.threadIds ?? []) {
    const thread = await transport.getThread(threadId);
    for (const message of thread.messages ?? []) if (message.id) expanded.push(message.id);
  }
  const unique = [...new Set(expanded)];
  if (unique.length === 0) {
    throw new CommsError('USAGE', 'name the messages or threads to move', { hint: 'Pass messageIds or threadIds.' });
  }

  const action = options.undo ? 'untrash' : 'trash';
  if (options.dryRun) return { inbox: alias, dryRun: true, messages: unique, action };

  for (const messageId of unique) {
    if (action === 'trash') await transport.trashMessage(messageId);
    else await transport.untrashMessage(messageId);
  }
  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: action,
    outcome: 'ok',
    surface: context.surface,
    ids: { messageIds: unique },
  });
  return { inbox: alias, dryRun: false, messages: unique, action };
}

export interface CreatedLabel {
  id: string;
  name: string;
  existed: boolean;
}

/** Creates a label, or returns the one already there: asking twice should not be an error. */
export async function createLabel(context: GmailContext, alias: string, name: string): Promise<CreatedLabel> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'organize');
  const transport = await context.transport(alias);

  const trimmed = name.trim();
  if (!trimmed) throw new CommsError('USAGE', 'a label needs a name');
  const existing = (await transport.listLabels()).find((label) => label.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return { id: existing.id, name: existing.name, existed: true };

  const created = await transport.createLabel(trimmed);
  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'label.create',
    outcome: 'ok',
    surface: context.surface,
    ids: { labelIds: [created.id] },
    reason: trimmed,
  });
  return { id: created.id, name: created.name, existed: false };
}

/** Exported for the audit line of a bulk change: domains only, never the addresses. */
export { recipientDomains };
