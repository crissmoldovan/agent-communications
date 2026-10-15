import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * This account's own record of what its app posted (design 2026-10-15 S5).
 *
 * The send app's bot token belongs to the workspace, and everyone who installed the same organisation app holds it, so
 * Slack cannot tell one person's agent from another's: every app message reads back as the same bot user. An app message
 * may therefore be edited or deleted from here only when this record holds its channel and ts — one this account's own
 * gate posted. One line per post, appended once Slack has said it posted, in the state directory beside the drafts.
 */

export interface AppPost {
  readonly channel: string;
  readonly ts: string;
}

export interface AppPostRecord {
  /** Whether this account's app posted the message at `where`. */
  holds(where: AppPost): Promise<boolean>;
  /** Records a post the app just made. Bookkeeping after the fact: the caller says so if it fails, and posts nothing. */
  add(where: AppPost & { readonly approvalId: string; readonly at: string }): Promise<void>;
}

/** The record for one account, by its id: a file of its own, private to this user. */
export function appPostRecordFor(stateDir: string, accountId: string): AppPostRecord {
  const dir = join(stateDir, 'slack', 'app-posts');
  const path = join(dir, `${accountId}.jsonl`);
  return {
    async holds(where) {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      for (const line of text.split('\n')) {
        if (line === '') continue;
        try {
          const entry = JSON.parse(line) as Partial<AppPost>;
          if (entry.channel === where.channel && entry.ts === where.ts) return true;
        } catch {
          // A line nothing here wrote names no post: it holds nothing.
        }
      }
      return false;
    },
    async add(where) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const line = JSON.stringify({ channel: where.channel, ts: where.ts, approvalId: where.approvalId, at: where.at });
      await appendFile(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    },
  };
}
