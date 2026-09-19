import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError } from './errors.ts';
import { appendPrivateLine } from './fs.ts';
import { withFileLock } from './lock.ts';

/**
 * The send ledger: one JSONL file per inbox, shared by every process. Rate caps are counted from it, never from
 * per-process memory, so parallel server instances (Claude Desktop runs separate chat and Cowork copies of every
 * server) cannot multiply the caps. A slot is reserved atomically before the send and released if the send fails.
 */

interface LedgerLine {
  at: string;
  approvalId: string;
  kind: 'reserve' | 'release';
}

export interface Caps {
  perHour: number;
  perDay: number;
}

export interface CapStatus {
  hour: number;
  day: number;
  /** When the next slot frees up, if a cap is reached. */
  resetAt?: string;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export class SendLedger {
  readonly directory: string;
  readonly #now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.directory = join(stateDir, 'sends');
    this.#now = now;
  }

  #path(inboxId: string): string {
    if (!/^ibx_[A-Z0-9]{16}$/.test(inboxId)) throw new Error(`not an inbox id: ${inboxId}`);
    return join(this.directory, `${inboxId}.jsonl`);
  }

  async #active(inboxId: string): Promise<string[]> {
    let text = '';
    try {
      text = await readFile(this.#path(inboxId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const since = this.#now().getTime() - DAY;
    const reserved = new Map<string, string>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry: LedgerLine;
      try {
        entry = JSON.parse(line) as LedgerLine;
      } catch {
        continue;
      }
      if (entry.kind === 'reserve') reserved.set(entry.approvalId, entry.at);
      else reserved.delete(entry.approvalId);
    }
    return [...reserved.values()].filter((at) => new Date(at).getTime() > since).sort();
  }

  /** Counts sends (including in-flight reservations) in the last hour and day. */
  async status(inboxId: string, caps: Caps): Promise<CapStatus> {
    return this.#statusOf(await this.#active(inboxId), caps);
  }

  #statusOf(active: string[], caps: Caps): CapStatus {
    const now = this.#now().getTime();
    const hourTimes = active.filter((at) => new Date(at).getTime() > now - HOUR);
    const status: CapStatus = { hour: hourTimes.length, day: active.length };
    if (status.hour >= caps.perHour && hourTimes[0]) {
      status.resetAt = new Date(new Date(hourTimes[0]).getTime() + HOUR).toISOString();
    } else if (status.day >= caps.perDay && active[0]) {
      status.resetAt = new Date(new Date(active[0]).getTime() + DAY).toISOString();
    }
    return status;
  }

  /** Reserves a slot or refuses with APPROVAL_REQUIRED and the time the cap resets. Atomic across processes. */
  async reserve(inboxId: string, approvalId: string, caps: Caps): Promise<CapStatus> {
    const path = this.#path(inboxId);
    return withFileLock(`${path}.lock`, async () => {
      const status = this.#statusOf(await this.#active(inboxId), caps);
      if (status.hour >= caps.perHour || status.day >= caps.perDay) {
        throw new CommsError('RATE_CAPPED', 'nothing was sent: the send limit for this inbox is reached', {
          hint: `Limits: ${caps.perHour} per hour, ${caps.perDay} per day. Next slot: ${status.resetAt ?? 'soon'}.`,
          details: { ...status },
        });
      }
      await appendPrivateLine(path, JSON.stringify({ at: this.#now().toISOString(), approvalId, kind: 'reserve' }));
      return { hour: status.hour + 1, day: status.day + 1 };
    });
  }

  /** Releases a reservation whose send did not happen. */
  async release(inboxId: string, approvalId: string): Promise<void> {
    const path = this.#path(inboxId);
    await withFileLock(`${path}.lock`, () =>
      appendPrivateLine(path, JSON.stringify({ at: this.#now().toISOString(), approvalId, kind: 'release' })),
    );
  }
}
