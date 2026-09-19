import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';

/**
 * Per-inbox runtime facts that any process may update (last successful refresh, last use, health). Kept out of
 * config.json so a running server never rewrites user intent — a stale in-memory copy of config written back by a
 * server could otherwise silently undo a policy the user just tightened.
 */
export interface InboxRuntimeState {
  lastRefreshOkAt?: string;
  lastUsedAt?: string;
  lastError?: { code: string; message: string; at: string };
  grantedScopes?: string[];
  refreshTokenExpiresAt?: string;
}

export class InboxStateStore {
  readonly directory: string;

  constructor(stateDir: string) {
    this.directory = join(stateDir, 'inboxes');
  }

  #path(inboxId: string): string {
    if (!/^ibx_[A-Z0-9]{16}$/.test(inboxId)) throw new Error(`not an inbox id: ${inboxId}`);
    return join(this.directory, `${inboxId}.json`);
  }

  async get(inboxId: string): Promise<InboxRuntimeState> {
    try {
      return JSON.parse(await readFile(this.#path(inboxId), 'utf8')) as InboxRuntimeState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  }

  /** Merges `patch` into the stored state under a per-inbox lock. */
  async update(inboxId: string, patch: Partial<InboxRuntimeState>): Promise<InboxRuntimeState> {
    const path = this.#path(inboxId);
    return withFileLock(`${path}.lock`, async () => {
      const next = { ...(await this.get(inboxId)), ...patch };
      await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }
}
