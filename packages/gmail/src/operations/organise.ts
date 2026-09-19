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
  /**
   * What to pass to put it back, as a list of per-message changes.
   *
   * Per message, not one swap for the whole selection, because the swap is wrong whenever the selection was not
   * uniform: undoing "archive these forty threads" by adding INBOX to all of them puts back the twelve that were
   * already archived before anyone touched them, and the user has no way to tell which. Each entry here restores
   * exactly the labels that message had.
   */
  undo: { messageId: string; addLabelIds: string[]; removeLabelIds: string[] }[] | null;
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

/**
 * Applies an undo returned by `modify`.
 *
 * The entries differ per message, and Gmail's batch takes one pair of label lists for a whole set of ids — so the
 * entries are grouped by the change they ask for and one batch is sent per group. Two or three groups is typical;
 * a selection that was already uniform collapses to one.
 */
export async function applyUndo(
  context: GmailContext,
  alias: string,
  entries: readonly NonNullable<ModifyResult['undo']>[number][],
): Promise<{ inbox: string; messages: number; groups: number }> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'organize');
  const transport = await context.transport(alias);
  if (entries.length === 0) throw new CommsError('USAGE', 'there is nothing to put back');

  const groups = new Map<string, { add: string[]; remove: string[]; ids: string[] }>();
  for (const entry of entries) {
    const add = [...entry.addLabelIds].sort();
    const remove = [...entry.removeLabelIds].sort();
    const key = `${add.join(',')}|${remove.join(',')}`;
    const group = groups.get(key) ?? { add, remove, ids: [] };
    group.ids.push(entry.messageId);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    await transport.modifyMessages(group.ids, group.add, group.remove);
  }
  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'modify.undo',
    outcome: 'ok',
    surface: context.surface,
    ids: { messageIds: entries.map((entry) => entry.messageId) },
    reason: `${groups.size} group(s)`,
  });
  return { inbox: alias, messages: entries.length, groups: groups.size };
}

/**
 * Refuses to touch a message that a send is standing on.
 *
 * `draft update` and `draft delete` already refuse while an approval for that draft is sending. Labelling or
 * binning the draft's *message* is the same act reached through a different operation — and it was not guarded,
 * which is the shape of bug this project keeps finding: a rule applied to one operation and not its sibling.
 *
 * The send would survive it: the final re-read compares the message id and the digest, so a changed draft aborts.
 * But it aborts with a confusing error about a draft that changed, when the truth is that another tool moved it.
 */
async function refuseWhileSending(
  context: GmailContext,
  inboxId: string,
  messageIds: readonly string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const sending = await context.core.approvals.list({ inboxId, states: ['sending'] });
  const held = new Set(sending.map((record) => record.draftMessageId));
  const clash = messageIds.find((id) => held.has(id));
  if (clash) {
    throw new CommsError('APPROVAL_PENDING', 'that message is a draft being sent right now, so it cannot be changed', {
      hint: 'Wait for the send to finish, then look at the message in Sent.',
      details: { messageId: clash },
    });
  }
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
  await refuseWhileSending(context, resolved.inbox.id, unique);

  // What each message carries now, so the undo can restore exactly that. One metadata read per message, which is
  // the price of an undo that is actually an undo; a dry run pays it too, so the user can see the reverse before
  // agreeing to the change.
  const undo: NonNullable<ModifyResult['undo']> = [];
  for (const messageId of unique) {
    let current: string[] = [];
    try {
      current = (await transport.getMessageMetadata(messageId)).labelIds ?? [];
    } catch {
      // A message we cannot read is one we cannot promise to restore. It is still changed — Gmail's batch does not
      // take exceptions — so the undo simply does not claim it.
      continue;
    }
    const held = new Set(current);
    undo.push({
      messageId,
      // Put back only what this message actually had, and take away only what it actually lacked.
      addLabelIds: [...remove].filter((label) => held.has(label)),
      removeLabelIds: [...add].filter((label) => !held.has(label)),
    });
  }

  const result: ModifyResult = {
    inbox: alias,
    dryRun: Boolean(options.dryRun),
    messages: unique.length,
    threads: threadIds.length,
    addLabelIds: [...add],
    removeLabelIds: [...remove],
    undo: undo.filter((entry) => entry.addLabelIds.length > 0 || entry.removeLabelIds.length > 0),
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
  await refuseWhileSending(context, resolved.inbox.id, unique);

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
