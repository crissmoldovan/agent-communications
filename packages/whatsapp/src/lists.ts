import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNT_ID_PATTERN, CommsError, canonicalJson, withFileLock, writeFileAtomic } from '@agentcomms/core';
import { z } from 'zod';
import { CHAT_ID } from './chat-ref.ts';
import type { ChatLists } from './visibility.ts';

/**
 * The person's allow and deny lists — which chats an agent may see — in a file of this package's own,
 * `whatsapp-chats.json` beside core's `config.json`.
 *
 * **Why not in `config.json`.** Every key an account record carries is kept through every write to that file, by
 * every release that shares it — but only `sendPolicy`, `changePolicy` and `mode` are *judged* when a write loosens
 * something (design 2026-09-26 §5). A deny list kept there could be emptied by any write, from any program that
 * writes the configuration, and core's classifier would see no loosening, so nobody would be asked. That is exactly
 * the "safety setting the classifier can't judge" the design forbids a channel to add.
 *
 * The lists are not a setting that can be approved into looser at all. They are the person's, in both directions:
 * only `allow`, `deny` and `clear` write this file, those are commands with no tool, and they refuse an agent. So the
 * lists sit outside the approval machinery — which exists to let an agent loosen something once a person agrees —
 * in a file nothing else writes.
 *
 * **Keyed by the account's id**, not its name: a rename through core moves the name and leaves the id, so the lists
 * stay with the account; and a removed account's entry is removed with it, so a new account under the same name
 * starts with none.
 *
 * **Fails closed.** A file that cannot be read or does not parse refuses every read rather than showing everything:
 * a deny list silently dropped is the widest thing that could happen here.
 */

export const LISTS_FILE = 'whatsapp-chats.json';

/** Long enough for any real list, short enough that a hand-edited file cannot make every read slow. */
export const CHAT_LIST_LIMIT = 1000;

interface ListsFile {
  version: 1;
  accounts: Record<string, { allow: string[]; deny: string[] }>;
}

const chatList = z
  .array(z.string().regex(CHAT_ID, 'a chat list holds chat ids, such as 15555550101@s.whatsapp.net'))
  .max(CHAT_LIST_LIMIT);

const listsSchema = z.strictObject({
  version: z.literal(1),
  accounts: z.record(
    z.string().regex(ACCOUNT_ID_PATTERN, 'keyed by account id: acc_ followed by 16 characters'),
    z.strictObject({ allow: chatList, deny: chatList }),
  ),
});

const EMPTY: ChatLists = Object.freeze({ allow: Object.freeze([]), deny: Object.freeze([]) });

/** One account's entry, as an own property only: an id is data, and `constructor` is a function on every object. */
function entryOf(file: ListsFile, accountId: string): ChatLists {
  return new Map(Object.entries(file.accounts)).get(accountId) ?? EMPTY;
}

export class ChatListStore {
  readonly path: string;
  readonly #lockPath: string;

  constructor(configDir: string) {
    this.path = join(configDir, LISTS_FILE);
    this.#lockPath = join(configDir, '.whatsapp-chats.lock');
  }

  async #load(): Promise<ListsFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: {} };
      throw new CommsError('CONFIG', `${this.path} could not be read, so no chat is shown`, {
        hint: 'It holds the chats hidden from agents. Fix its permissions, or restore it.',
        cause: error,
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new CommsError('CONFIG', `${this.path} is not valid JSON, so no chat is shown`, {
        hint: 'It holds the chats hidden from agents; nothing is read until it is fixed or restored.',
      });
    }
    const parsed = listsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CommsError('CONFIG', `${this.path} is not a valid list of chats, so no chat is shown`, {
        hint: `${parsed.error.issues[0]?.message ?? 'invalid'}. Nothing is read until it is fixed or restored.`,
      });
    }
    return parsed.data as ListsFile;
  }

  /** One account's lists; none when the account has no entry. */
  async of(accountId: string): Promise<ChatLists> {
    return entryOf(await this.#load(), accountId);
  }

  /**
   * Reads the live list while holding the same inter-process gate as allow/deny/clear.  Event consumers get the
   * parsed policy and its canonical digest, never a second mutable copy of the list file.
   */
  async withCurrent<T>(
    accountId: string,
    work: (current: Readonly<{ version: 1; lists: ChatLists; digest: string }>) => Promise<T> | T,
  ): Promise<T> {
    return withFileLock(this.#lockPath, async () => {
      const file = await this.#load();
      const lists = entryOf(file, accountId);
      const digest = createHash('sha256')
        .update(canonicalJson({ allow: [...lists.allow], deny: [...lists.deny] }), 'utf8')
        .digest('hex');
      return work({ version: file.version, lists, digest });
    });
  }

  /** Changes one account's lists under the file's lock; an account left with neither list has no entry. */
  async update(
    accountId: string,
    change: (lists: ChatLists) => ChatLists,
  ): Promise<{ before: ChatLists; after: ChatLists }> {
    return withFileLock(this.#lockPath, async () => {
      const file = await this.#load();
      const before = entryOf(file, accountId);
      const after = change({ allow: [...before.allow], deny: [...before.deny] });
      const accounts = Object.fromEntries(Object.entries(file.accounts).filter(([id]) => id !== accountId));
      if (after.allow.length > 0 || after.deny.length > 0) {
        accounts[accountId] = { allow: [...after.allow], deny: [...after.deny] };
      }
      await this.#write({ version: 1, accounts });
      return { before, after };
    });
  }

  /** Forgets an account's lists: when the account is removed. */
  async forget(accountId: string): Promise<void> {
    await withFileLock(this.#lockPath, async () => {
      const file = await this.#load();
      if (!Object.hasOwn(file.accounts, accountId)) return;
      const accounts = Object.fromEntries(Object.entries(file.accounts).filter(([id]) => id !== accountId));
      if (Object.keys(accounts).length === 0) {
        await rm(this.path, { force: true });
        return;
      }
      await this.#write({ version: 1, accounts });
    });
  }

  async #write(file: ListsFile): Promise<void> {
    const parsed = listsSchema.safeParse(file);
    if (!parsed.success) {
      throw new CommsError('CONFIG', `refusing to write an invalid list of chats: ${parsed.error.issues[0]?.message}`);
    }
    await writeFileAtomic(this.path, `${JSON.stringify(parsed.data, null, 2)}\n`);
  }
}
