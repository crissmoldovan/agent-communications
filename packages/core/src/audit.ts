import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SendPolicy } from './config.ts';
import { appendPrivateLine } from './fs.ts';

/**
 * Every mailbox write leaves one line here: what was done, to which inbox, with which ids and outcome. Never message
 * bodies, never secrets — recipient *domains* only, so the log can be shared when asking for help.
 */
export interface AuditRecord {
  at: string;
  /** Immutable inbox id; `alias` is the label at the time. */
  inboxId: string;
  alias?: string;
  operation: string;
  /** `started` marks the first half of a change recorded before it is made; a later record for the same ids ends it. */
  outcome: 'ok' | 'refused' | 'failed' | 'started';
  ids?: Record<string, string | string[] | CondensedIds>;
  recipientDomains?: string[];
  /**
   * Full canonical recipient addresses. Only a send writes these: for every other operation the domains are enough,
   * and storing less is better — but when mail has actually left, "who did it go to" is the first question anyone
   * asks afterwards, and a domain does not answer it.
   */
  recipients?: string[];
  approvalId?: string;
  reason?: string;
  surface?: 'cli' | 'mcp';
  /**
   * The policy that decided how this was approved. Written by change approvals, where it is the whole question
   * afterwards: a loosening a person typed a code for and one an agent claimed after a yes in chat look the same in
   * the configuration, and only this line tells them apart.
   */
  policy?: SendPolicy;
}

/** Large id lists are condensed so every audit line stays small enough to be appended atomically. */
export interface CondensedIds {
  count: number;
  sha256: string;
  first: string[];
}

const MAX_LISTED_IDS = 20;

function condense(ids: AuditRecord['ids']): AuditRecord['ids'] {
  if (!ids) return ids;
  const out: NonNullable<AuditRecord['ids']> = {};
  for (const [key, value] of Object.entries(ids)) {
    if (Array.isArray(value) && value.length > MAX_LISTED_IDS) {
      out[key] = {
        count: value.length,
        sha256: createHash('sha256')
          .update([...value].sort().join('\n'))
          .digest('hex'),
        first: value.slice(0, MAX_LISTED_IDS),
      };
    } else {
      out[key] = value;
    }
  }
  return out;
}

export class AuditLog {
  readonly directory: string;
  readonly #now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.directory = join(stateDir, 'audit');
    this.#now = now;
  }

  async append(
    record: Omit<AuditRecord, 'at'> & { at?: string },
    options: { durable?: boolean } = {},
  ): Promise<AuditRecord> {
    const at = record.at ?? this.#now().toISOString();
    const full: AuditRecord = {
      ...record,
      at,
      ...(record.ids ? { ids: condense(record.ids) as NonNullable<AuditRecord['ids']> } : {}),
    };
    await appendPrivateLine(join(this.directory, `${at.slice(0, 7)}.jsonl`), JSON.stringify(full), options);
    return full;
  }

  /** The most recent records, newest last, optionally filtered by inbox and a lower time bound. */
  async tail(options: { limit?: number; inbox?: string; since?: string } = {}): Promise<AuditRecord[]> {
    const limit = options.limit ?? 50;
    let files: string[];
    try {
      files = (await readdir(this.directory)).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: AuditRecord[] = [];
    for (const file of files.reverse()) {
      const lines = (await readFile(join(this.directory, file), 'utf8')).split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        let record: AuditRecord;
        try {
          record = JSON.parse(line) as AuditRecord;
        } catch {
          continue;
        }
        if (options.inbox && record.inboxId !== options.inbox && record.alias !== options.inbox) continue;
        if (options.since && record.at < options.since) return out.reverse();
        out.push(record);
        if (out.length >= limit) return out.reverse();
      }
    }
    return out.reverse();
  }
}

/** The domains of a list of addresses, lower-cased and de-duplicated, for audit records. */
export function recipientDomains(addresses: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const address of addresses) {
    const at = address.lastIndexOf('@');
    if (at > 0)
      domains.add(
        address
          .slice(at + 1)
          .toLowerCase()
          .replace(/[>\s]+$/, ''),
      );
  }
  return [...domains].sort();
}
