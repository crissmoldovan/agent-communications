import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normaliseAddress } from './digest.ts';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';

/**
 * Addresses and domains that reached the model through untrusted content (headers and bodies of messages a read,
 * export or download returned). A send to a tainted recipient that the inbox has never written to before is escalated
 * from `chat` to `confirm`: being told by an email to write to someone else is the shape of the exfiltration attacks.
 * Literal matching is beaten by obfuscated addresses ("x at evil dot test"); this is a tripwire, not a boundary.
 */

export const TAINT_WINDOW_MS: number = 7 * 24 * 60 * 60 * 1000;

// A pragmatic address pattern: good enough to find addresses in text; parsing of header fields is done elsewhere.
const ADDRESS_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export function extractAddresses(text: string): string[] {
  return [...new Set((text.match(ADDRESS_IN_TEXT) ?? []).map((a) => a.toLowerCase()))];
}

export function domainOf(address: string): string | null {
  const normalised = normaliseAddress(address);
  const at = normalised.lastIndexOf('@');
  return at > 0 ? normalised.slice(at + 1) : null;
}

/** Collects addresses seen while building one response; flushed to the store once at the end. */
export class TaintCollector {
  readonly #addresses = new Set<string>();

  /** Scans free text (bodies, subjects, snippets, attachment text) for addresses. */
  observeText(text: string): void {
    for (const address of extractAddresses(text)) this.#addresses.add(address);
  }

  /** Records header addresses (From, Reply-To, Sender, To, Cc), already parsed. */
  observeAddresses(addresses: Iterable<string>): void {
    for (const address of addresses) {
      const normalised = normaliseAddress(address);
      if (normalised.includes('@')) this.#addresses.add(normalised);
    }
  }

  get size(): number {
    return this.#addresses.size;
  }

  addresses(): string[] {
    return [...this.#addresses];
  }
}

interface TaintFile {
  addresses: Record<string, string>;
  domains: Record<string, string>;
}

export interface TaintCheck {
  address: boolean;
  domain: boolean;
}

export class TaintStore {
  readonly directory: string;
  readonly #now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.directory = join(stateDir, 'taint');
    this.#now = now;
  }

  #path(inboxId: string): string {
    if (!/^ibx_[A-Z0-9]{16}$/.test(inboxId)) throw new Error(`not an inbox id: ${inboxId}`);
    return join(this.directory, `${inboxId}.json`);
  }

  async #read(inboxId: string): Promise<TaintFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path(inboxId), 'utf8')) as Partial<TaintFile>;
      return { addresses: parsed.addresses ?? {}, domains: parsed.domains ?? {} };
    } catch {
      return { addresses: {}, domains: {} };
    }
  }

  #prune(file: TaintFile): TaintFile {
    const cutoff = this.#now().getTime() - TAINT_WINDOW_MS;
    const keep = (map: Record<string, string>) =>
      Object.fromEntries(Object.entries(map).filter(([, at]) => new Date(at).getTime() > cutoff));
    return { addresses: keep(file.addresses), domains: keep(file.domains) };
  }

  /** Merges what a collector saw into the inbox's taint set, refreshing timestamps. */
  async record(inboxId: string, collector: TaintCollector): Promise<void> {
    if (collector.size === 0) return;
    const path = this.#path(inboxId);
    await withFileLock(`${path}.lock`, async () => {
      const file = this.#prune(await this.#read(inboxId));
      const at = this.#now().toISOString();
      for (const address of collector.addresses()) {
        file.addresses[address] = at;
        const domain = domainOf(address);
        if (domain) file.domains[domain] = at;
      }
      await writeFileAtomic(path, JSON.stringify(file));
    });
  }

  async check(inboxId: string, address: string): Promise<TaintCheck> {
    const file = this.#prune(await this.#read(inboxId));
    const normalised = normaliseAddress(address);
    const domain = domainOf(normalised);
    return { address: normalised in file.addresses, domain: domain !== null && domain in file.domains };
  }
}
