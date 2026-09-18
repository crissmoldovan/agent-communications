import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendPrivateLine } from './fs.ts';

/**
 * Every mailbox write leaves one line here: what was done, to which inbox, with which ids and outcome. Never message
 * bodies, never secrets — recipient *domains* only, so the log can be shared when asking for help.
 */
export interface AuditRecord {
  at: string;
  inbox: string;
  operation: string;
  outcome: 'ok' | 'refused' | 'failed';
  ids?: Record<string, string | string[]>;
  recipientDomains?: string[];
  approvalId?: string;
  reason?: string;
  surface?: 'cli' | 'mcp';
}

export class AuditLog {
  readonly directory: string;
  readonly #now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.directory = join(stateDir, 'audit');
    this.#now = now;
  }

  async append(record: Omit<AuditRecord, 'at'> & { at?: string }): Promise<AuditRecord> {
    const at = record.at ?? this.#now().toISOString();
    const full: AuditRecord = { ...record, at };
    await appendPrivateLine(join(this.directory, `${at.slice(0, 7)}.jsonl`), JSON.stringify(full));
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
        if (options.inbox && record.inbox !== options.inbox) continue;
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
