import { CommsError } from '@agentcomms/core';
import { WhatsAppContext } from '../context.ts';
import { rebuildIndex } from '../index-db.ts';
import { type RawEventMessage, readRawEventMessages } from '../source/event-reader.ts';
import { inspectSchema } from '../source/schema.ts';
import { Visibility } from '../visibility.ts';
import { withCheckedCopy } from './sync.ts';

/**
 * The held event owner receives this deliberately narrow, read-only operation object.  In particular it never
 * exposes ChatListStore, whose update/forget methods are local list writes rather than event-reader capabilities.
 */
export interface WhatsAppEventOperations {
  withCurrentEventVisibility<T>(
    input: Readonly<{ accountId: string }>,
    work: (visibility: CurrentEventVisibility) => Promise<T> | T,
  ): Promise<T>;
  withEventSnapshot<T>(
    input: Readonly<{ accountId: string }>,
    work: (snapshot: EventSnapshot) => Promise<T> | T,
  ): Promise<T>;
}

/**
 * Opens this channel's own context from the owner's config directory and returns no write-capable local-store handle.
 * The context is made when first used: an owner with no WhatsApp account never resolves this channel's folders (and,
 * under test, a test that never reaches WhatsApp never looks for them in the account's real home).
 */
export function openWhatsAppEventOperations(
  // `env` is a test seam: a test gives a temporary home, so this channel's other folders are never the person's own.
  input: Readonly<{ configDir: string; env?: NodeJS.ProcessEnv | undefined }>,
): WhatsAppEventOperations {
  let opened: WhatsAppContext | undefined;
  const context = (): WhatsAppContext => {
    opened ??= new WhatsAppContext({
      ...(input.env === undefined ? {} : { env: input.env }),
      pathOverrides: { configDir: input.configDir },
    });
    return opened;
  };
  return {
    withCurrentEventVisibility: (visibilityInput, work) => withCurrentEventVisibility(context(), visibilityInput, work),
    withEventSnapshot: (snapshotInput, work) => withEventSnapshot(context(), snapshotInput, work),
  };
}

export interface CurrentEventVisibility {
  /** The list-file format version, not the daemon's durable journal version. */
  readonly version: 1;
  readonly digest: string;
  readonly seesMessage: (chatJid: string, chatKind: string, senderJidRaw: string, fromMe: boolean) => boolean;
  readonly seesUnit?: ((unitKey: string) => boolean) | undefined;
}

export interface EventSnapshot {
  readonly accountId: string;
  readonly accountName: string;
  readonly visibility: CurrentEventVisibility;
  readonly messages: readonly RawEventMessage[];
}

/**
 * The channel's live-list capability boundary.  The callback runs while `.whatsapp-chats.lock` is held, so a daemon
 * may place a synchronous SQLite decision immediately after this read without a list command racing it.
 */
export async function withCurrentEventVisibility<T>(
  context: WhatsAppContext,
  input: Readonly<{ accountId: string }>,
  work: (visibility: CurrentEventVisibility) => Promise<T> | T,
): Promise<T> {
  return context.lists.withCurrent(input.accountId, async ({ version, lists, digest }) => {
    const visibility = new Visibility(lists);
    return work({
      version,
      digest,
      seesMessage: (chatJid, chatKind, senderJidRaw, fromMe) =>
        visibility.seesMessage(chatJid, chatKind, senderJidRaw, fromMe),
      seesUnit: (unitKey) => visibility.seesUnit(unitKey),
    });
  });
}

/**
 * Runs the checked-copy lifecycle for the event source.  The normal index is rebuilt first, but the source copies
 * only raw values from the checked copy and never observes the rebuilt index.
 */
export async function withEventSnapshot<T>(
  context: WhatsAppContext,
  input: Readonly<{ accountId: string }>,
  work: (snapshot: EventSnapshot) => Promise<T> | T,
): Promise<T> {
  return withCheckedCopy(context, input, async ({ account, accountName, directory, database, snapshot }) => {
    const report = inspectSchema(database);
    const current = await context.accountById(account.id);
    if (current === null)
      throw new CommsError('NOT_FOUND', 'the account was removed while its event snapshot was being read');
    // Rebuilding is part of the checked-copy lifecycle. Its presentation result is intentionally discarded: only the
    // raw checked-copy reader below supplies event facts or identities.
    await rebuildIndex(
      directory,
      database,
      report,
      { indexedAt: context.now().toISOString(), copied: snapshot.copied },
      new Visibility(current.lists),
      async () => {
        const latest = await context.accountById(account.id);
        return latest !== null && JSON.stringify(latest.lists) === JSON.stringify(current.lists);
      },
    );
    if ((await context.accountById(account.id)) === null)
      throw new CommsError('NOT_FOUND', 'the account was removed while its event snapshot was being read');
    // The source worker admits only incoming complete tuples, but it must receive visible from-me rows as well so
    // their list unit has a durable visibility floor before a later incoming first representation arrives.
    const messages = readRawEventMessages(database, report).filter(
      (message) =>
        (message.fromMe === false || message.fromMe === true) && message.chatJid !== null && message.chatKind !== null,
    );
    return withCurrentEventVisibility(context, { accountId: account.id }, (visibility) =>
      work({ accountId: account.id, accountName, visibility, messages }),
    );
  });
}
