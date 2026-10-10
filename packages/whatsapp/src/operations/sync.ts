import type { DatabaseSync } from 'node:sqlite';
import { CommsError, ensurePrivateDir, handoffSentence, withFileLock } from '@agentcomms/core';
import type { WhatsAppAccount } from '../config.ts';
import type { WhatsAppContext } from '../context.ts';
import { type IndexStats, rebuildIndex } from '../index-db.ts';
import { inspectSchema, type SchemaReport } from '../source/schema.ts';
import { removeStaleSnapshots, type StoreSnapshot, snapshotStore } from '../source/snapshot.ts';
import { openDatabase } from '../sqlite.ts';
import { type ChatLists, Visibility } from '../visibility.ts';

/**
 * The one operation that reads WhatsApp's files: copy the store, check the copy, rebuild the index, delete the copy.
 *
 * In that order, and all of it or none of it: a copy that fails SQLite's check, or a store whose layout has drifted,
 * leaves the previous index exactly as it was, and the copy is deleted whatever happens.
 */

export interface SyncResult extends IndexStats {
  account: string;
  store: { path: string; default: boolean };
  snapshot: { attempts: number; deleted: true; staleRemoved: number };
}

/** Builds tried before a sync whose lists keep changing under it gives up. */
const LIST_ROUNDS = 3;

/** A verified private source copy, valid only while the callback holds the account sync lock. */
export interface CheckedCopy {
  readonly accountName: string;
  readonly account: WhatsAppAccount;
  readonly directory: string;
  readonly database: DatabaseSync;
  readonly report: SchemaReport;
  readonly snapshot: StoreSnapshot;
  readonly staleRemoved: number;
  readonly store: { readonly path: string; readonly isDefault: boolean };
}

export type CheckedCopyRequest = Readonly<
  | { readonly account?: string | undefined; readonly accountId?: never }
  | { readonly accountId: string; readonly account?: never }
>;

/** The account went while it synced; adding it again — this name, this store — is the person's, located here. */
function removedWhileSyncing(context: WhatsAppContext, name: string, account: WhatsAppAccount): CommsError {
  const add = ['add', name, ...(account.source === undefined ? [] : ['--source', account.source])];
  return new CommsError('NOT_FOUND', `"${name}" was removed while it was being synced, so nothing was indexed`, {
    hint: handoffSentence(context.handoffs.own(add), (command) => `Add it again with ${command} to read it.`),
  });
}

function sameLists(a: ChatLists, b: ChatLists): boolean {
  return JSON.stringify([a.allow, a.deny]) === JSON.stringify([b.allow, b.deny]);
}

/**
 * Owns the source-copy lifecycle shared by normal sync and the local event reader.  Callers can use values from the
 * copy only inside `work`; the copy is always closed and removed afterwards.
 */
export async function withCheckedCopy<T>(
  context: WhatsAppContext,
  request: CheckedCopyRequest,
  work: (copy: CheckedCopy) => Promise<T> | T,
): Promise<T> {
  const resolved =
    request.accountId === undefined
      ? await context.account(request.account)
      : await context.accountById(request.accountId);
  if (resolved === null)
    throw new CommsError('NOT_FOUND', 'the WhatsApp account was removed before its store was read');
  const { name, account } = resolved;
  const store = context.storeOf(account);
  const directory = context.accountDir(account);
  return withFileLock(
    context.syncLock(account),
    async () => {
      if (!(await context.accountById(account.id))) throw removedWhileSyncing(context, name, account);
      await ensurePrivateDir(directory);
      const staleRemoved = await removeStaleSnapshots(directory);
      const snapshot = await snapshotStore(store.path, directory, context.sourceOptions(store.isDefault));
      try {
        // The copy is ours, so it is opened read-write: SQLite folds the copied log into it as it opens.
        const database = await openDatabase(snapshot.database);
        try {
          const check = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
          const verdict = check ? String(Object.values(check)[0]) : 'no answer';
          if (verdict !== 'ok') {
            throw new CommsError('TRANSIENT', 'the copy of WhatsApp’s message store did not pass SQLite’s check', {
              hint: 'Nothing was indexed. Try again; if it keeps failing, quit WhatsApp for a moment and sync.',
              details: { reason: 'COPY_INCONSISTENT', verdict },
            });
          }
          return await work({
            accountName: name,
            account,
            directory,
            database,
            report: inspectSchema(database),
            snapshot,
            staleRemoved,
            store,
          });
        } finally {
          database.close();
        }
      } finally {
        await snapshot.dispose();
      }
    },
    { timeoutMs: 5000, renewMs: 5000 },
  );
}

/**
 * Held against a person's commands that land while it runs:
 *
 * - **`remove`** holds the same lock (`WhatsAppContext.syncLock`), so it waits for a running sync and then deletes
 *   everything, the new index with it; and a sync that waited behind a remove looks its account up again once it
 *   holds the lock, finds it gone, and writes nothing.
 * - **`allow`, `deny`, `clear`**: the lists are read again just before the new index replaces the old. If they
 *   changed while it was built, it is built again, from the same copy, with the lists as they are now — so what a
 *   deny hides is never written, not merely filtered out when read.
 */
export async function syncAccount(
  context: WhatsAppContext,
  request: { account?: string | undefined },
): Promise<SyncResult> {
  return withCheckedCopy(context, request, async (copy) => {
    let current = await context.accountById(copy.account.id);
    if (!current) throw removedWhileSyncing(context, copy.accountName, copy.account);
    for (let round = 1; ; round++) {
      const built = current;
      // What the person's lists hide is never written to the index.
      const stats = await rebuildIndex(
        copy.directory,
        copy.database,
        copy.report,
        { indexedAt: context.now().toISOString(), copied: copy.snapshot.copied },
        new Visibility(built.lists),
        async () => {
          const now = await context.accountById(copy.account.id);
          if (!now) throw removedWhileSyncing(context, built.name, copy.account);
          current = now;
          return sameLists(now.lists, built.lists);
        },
      );
      if (stats) {
        return {
          account: built.name,
          store: { path: copy.store.path, default: copy.store.isDefault },
          ...stats,
          snapshot: { attempts: copy.snapshot.attempts, deleted: true as const, staleRemoved: copy.staleRemoved },
        };
      }
      if (round === LIST_ROUNDS) {
        throw new CommsError('TRANSIENT', 'the chat lists kept changing while the index was built', {
          hint: 'The previous index is kept as it was. Run the sync again.',
          details: { reason: 'LISTS_CHANGED' },
        });
      }
    }
  });
}
