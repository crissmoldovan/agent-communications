import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import { normaliseAddress } from './digest.ts';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';

/**
 * Addresses and domains that reached the model through email content (header fields and bodies of messages a read,
 * export or download returned) — for ALL inboxes in one store, because an injected message read in one inbox can ask
 * for a send from another. A send to a tainted recipient that the sending inbox has never written to is escalated from
 * `chat` to `confirm`: being told by an email to write to someone else is the shape of the exfiltration attacks.
 * Literal matching is beaten by obfuscated addresses ("x at evil dot test"); this is a tripwire, not a boundary.
 */

export const TAINT_WINDOW_MS: number = 7 * 24 * 60 * 60 * 1000;

/**
 * How many addresses one message may add to the store.
 *
 * Unbounded, one body naming forty thousand addresses produced a seven-megabyte store that every later read
 * rewrote under a lock and every send checked against — and, worse, a body naming the user's own correspondents'
 * domains tainted all of them, so every send escalated to `confirm`. Alarm fatigue on the one prompt that matters
 * is a real attack, not an inconvenience. A message with more than this many addresses in it is a mailing list or
 * an attack, and neither needs recording in full.
 */
const MAX_PER_MESSAGE = 200;

/** How many entries the store keeps in total, oldest dropped first. */
const MAX_ENTRIES = 20_000;

/**
 * Public mailbox providers. Their domains are never tainted as a whole — one message from someone at gmail.com must
 * not make every gmail.com recipient suspicious — so taint applies to the exact address only.
 */
export const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
  'qq.com',
  '163.com',
]);

/**
 * A pragmatic pattern to find addresses in free text; header fields are parsed properly elsewhere.
 *
 * Letters here are Unicode letters, not ASCII: an internationalised address (`jose@compañía.es`, a `.рф` domain) is
 * an address, and a pattern that cannot see one lets a reply-to hidden in the body past the checks that read this.
 */
const ADDRESS_IN_TEXT = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}/gu;

/** Canonical form for matching: trimmed, lower-cased, IDN domain in punycode; no dot or plus folding. */
export function canonicalAddress(address: string): string {
  const bare = normaliseAddress(address);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return bare;
  const domain = domainToASCII(bare.slice(at + 1)) || bare.slice(at + 1);
  return `${bare.slice(0, at)}@${domain.toLowerCase()}`;
}

export function domainOf(address: string): string | null {
  const canonical = canonicalAddress(address);
  const at = canonical.lastIndexOf('@');
  return at > 0 ? canonical.slice(at + 1) : null;
}

export function extractAddresses(text: string): string[] {
  return [...new Set((text.match(ADDRESS_IN_TEXT) ?? []).map(canonicalAddress))];
}

export type TaintSource = 'header' | 'body';

export interface TaintObservation {
  address: string;
  source: TaintSource;
  inboxId: string;
  messageId?: string | undefined;
}

/** What is never recorded: the user's own addresses and the domains they call internal. */
export interface TaintExclusions {
  ownAddresses: readonly string[];
  internalDomains: readonly string[];
}

interface TaintEntry {
  at: string;
  source: TaintSource;
  inboxIds: string[];
}

interface TaintFile {
  addresses: Record<string, TaintEntry>;
  domains: Record<string, TaintEntry>;
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

  get #path(): string {
    return join(this.directory, 'taint.json');
  }

  async #read(): Promise<TaintFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as Partial<TaintFile>;
      return { addresses: parsed.addresses ?? {}, domains: parsed.domains ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { addresses: {}, domains: {} };
      if (error instanceof SyntaxError) return { addresses: {}, domains: {} };
      throw error;
    }
  }

  #prune(file: TaintFile): TaintFile {
    const cutoff = this.#now().getTime() - TAINT_WINDOW_MS;
    const keep = (map: Record<string, TaintEntry>) => {
      const fresh = Object.entries(map).filter(([, entry]) => new Date(entry.at).getTime() >= cutoff);
      if (fresh.length <= MAX_ENTRIES) return Object.fromEntries(fresh);
      // Newest first, then cut. Every read rewrites this file under a lock, so an unbounded store is a growing
      // cost on every read and every send — and the oldest entries are the ones closest to ageing out anyway.
      fresh.sort((a, b) => new Date(b[1].at).getTime() - new Date(a[1].at).getTime());
      return Object.fromEntries(fresh.slice(0, MAX_ENTRIES));
    };
    return { addresses: keep(file.addresses), domains: keep(file.domains) };
  }

  /**
   * Records observations. Throws if it cannot — callers must fail the read rather than return content whose taint
   * was not recorded.
   */
  async record(observations: readonly TaintObservation[], exclusions: TaintExclusions): Promise<void> {
    const own = new Set(exclusions.ownAddresses.map(canonicalAddress));
    const internal = new Set(exclusions.internalDomains.map((d) => d.toLowerCase()));
    const kept = observations
      .map((o) => ({ ...o, address: canonicalAddress(o.address) }))
      .filter((o) => o.address.includes('@') && !own.has(o.address) && !internal.has(domainOf(o.address) ?? ''))
      // Headers first, then body sightings: a header address is the stronger signal, so it is the one that
      // survives if a single message carries more addresses than this will record.
      .sort((a, b) => (a.source === b.source ? 0 : a.source === 'header' ? -1 : 1))
      .slice(0, MAX_PER_MESSAGE);
    if (kept.length === 0) return;
    const path = this.#path;
    await withFileLock(`${path}.lock`, async () => {
      const file = this.#prune(await this.#read());
      const at = this.#now().toISOString();
      const touch = (map: Record<string, TaintEntry>, key: string, o: TaintObservation) => {
        const existing = map[key];
        const inboxIds = [...new Set([...(existing?.inboxIds ?? []), o.inboxId])];
        // A header sighting is kept once seen: it is the stronger signal.
        const source: TaintSource = existing?.source === 'header' ? 'header' : o.source;
        map[key] = { at, source, inboxIds };
      };
      for (const o of kept) {
        touch(file.addresses, o.address, o);
        const domain = domainOf(o.address);
        if (domain && !PUBLIC_MAILBOX_DOMAINS.has(domain)) touch(file.domains, domain, o);
      }
      await writeFileAtomic(path, JSON.stringify(file));
    });
  }

  /** Whether an address, or its (non-public) domain, was seen in email content in the window — from any inbox. */
  async check(address: string): Promise<TaintCheck> {
    const file = this.#prune(await this.#read());
    const canonical = canonicalAddress(address);
    const domain = domainOf(canonical);
    return {
      address: canonical in file.addresses,
      domain: domain !== null && !PUBLIC_MAILBOX_DOMAINS.has(domain) && domain in file.domains,
    };
  }
}

/**
 * The context every read path uses to put sender-controlled content into a result. It wraps strings in the untrusted
 * envelope and collects every address it sees; `flush` records them once, and a read must not return until it has.
 */
export class TaintCollector {
  readonly #observations: TaintObservation[] = [];
  readonly #inboxId: string;
  readonly #messageId: string | undefined;

  constructor(inboxId: string, messageId?: string) {
    this.#inboxId = inboxId;
    this.#messageId = messageId;
  }

  /** Scans free text (bodies, subjects, snippets, attachment text) for addresses. */
  observeText(text: string): void {
    for (const address of extractAddresses(text)) {
      this.#observations.push({ address, source: 'body', inboxId: this.#inboxId, messageId: this.#messageId });
    }
  }

  /** Records parsed header addresses (From, Reply-To, Sender, To, Cc). */
  observeHeaders(addresses: Iterable<string>): void {
    for (const address of addresses) {
      const canonical = canonicalAddress(address);
      if (canonical.includes('@')) {
        this.#observations.push({
          address: canonical,
          source: 'header',
          inboxId: this.#inboxId,
          messageId: this.#messageId,
        });
      }
    }
  }

  get size(): number {
    return this.#observations.length;
  }

  observations(): TaintObservation[] {
    return [...this.#observations];
  }

  /** Records everything collected. Throws when it cannot, so the read fails closed. */
  async flush(store: TaintStore, exclusions: TaintExclusions): Promise<void> {
    await store.record(this.#observations, exclusions);
  }
}
