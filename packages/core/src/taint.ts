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

/**
 * A platform identifier that is not an email address: a Slack user or conversation id.
 *
 * It carries its scope because, unlike an address, it is not globally unique — `U024BE7LH` names a different person
 * in every workspace that happens to mint that id. The address store is deliberately cross-inbox, on the reasoning
 * that a message read in one mailbox can ask for a send from another; that reasoning does not transfer here, and a
 * store that matched ids across workspaces would flag an unrelated person every time two workspaces collided.
 *
 * The id, never the display name. `@sam` is set by the account that bears it and can be changed to `@finance-bot`
 * between the message being read and the send being checked; the id cannot.
 */
export interface TaintHandle {
  /** `slack`. Lower-cased on the way in. */
  platform: string;
  /** The workspace or team the id belongs to — a Slack team id. */
  scope: string;
  /** `U024BE7LH`, `C0123`, `D0456`. Passed in the platform's own canonical form; core does not know its shape. */
  id: string;
}

/** The store key. Each part is escaped, so a scope containing the separator cannot forge another handle's key. */
export function canonicalHandle(handle: TaintHandle): string {
  const part = (value: string) => encodeURIComponent(value.trim());
  return `${part(handle.platform.toLowerCase())}:${part(handle.scope)}:${part(handle.id)}`;
}

export type TaintSource = 'header' | 'body';

export interface TaintObservation {
  address: string;
  source: TaintSource;
  inboxId: string;
  messageId?: string | undefined;
}

/** The same observation for a handle. `inboxId` is the account that did the reading, as it is for an address. */
export interface TaintHandleObservation {
  handle: TaintHandle;
  source: TaintSource;
  inboxId: string;
  messageId?: string | undefined;
}

/** What is never recorded: the user's own addresses and the domains they call internal. */
export interface TaintExclusions {
  ownAddresses: readonly string[];
  internalDomains: readonly string[];
  /**
   * Handles that are never recorded: the account's own user id, and whoever the caller treats as internal — the
   * counterpart of `internalDomains`, decided per platform because "internal" means a domain for mail and
   * workspace membership for Slack, and core should not be the thing that knows the difference.
   */
  ownHandles?: readonly TaintHandle[] | undefined;
}

interface TaintEntry {
  at: string;
  source: TaintSource;
  inboxIds: string[];
}

interface TaintFile {
  addresses: Record<string, TaintEntry>;
  domains: Record<string, TaintEntry>;
  /**
   * Anything a later version wrote that this one does not know about, carried through untouched.
   *
   * An MCP server started last week and a CLI run today share this file, so the older of the two rewriting it must
   * not silently drop what the newer one recorded. Taint fails open — a lost entry is a send that is not escalated,
   * which is exactly the failure nobody notices.
   */
  [unknown: string]: unknown;
}

/**
 * Handles live in their own file, not as a key inside `taint.json`.
 *
 * Preserving unknown keys, above, protects this file from every version that comes after. It does nothing about the
 * one already installed: 0.1.2 reads `taint.json` into `{addresses, domains}` and writes back exactly that, so a
 * handles map stored inside it is erased by the next Gmail read an old MCP server performs. Measured against the
 * published 0.1.2, not assumed. A separate file is the only thing that survives a writer that predates the data,
 * because it is the one thing that writer never opens.
 */
interface HandleFile {
  handles: Record<string, TaintEntry>;
  [unknown: string]: unknown;
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

  get #handlesPath(): string {
    return join(this.directory, 'handles.json');
  }

  async #readJson<T extends object>(path: string, empty: () => T): Promise<T> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<T>;
      // Spread first so the known maps win, and anything a later version added survives the rewrite.
      return { ...empty(), ...parsed } as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      if (error instanceof SyntaxError) return empty();
      throw error;
    }
  }

  async #read(): Promise<TaintFile> {
    return this.#readJson<TaintFile>(this.#path, () => ({ addresses: {}, domains: {} }));
  }

  async #readHandles(): Promise<HandleFile> {
    return this.#readJson<HandleFile>(this.#handlesPath, () => ({ handles: {} }));
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
    return { ...file, addresses: keep(file.addresses), domains: keep(file.domains) };
  }

  #pruneHandles(file: HandleFile): HandleFile {
    const cutoff = this.#now().getTime() - TAINT_WINDOW_MS;
    const fresh = Object.entries(file.handles).filter(([, entry]) => new Date(entry.at).getTime() >= cutoff);
    fresh.sort((a, b) => new Date(b[1].at).getTime() - new Date(a[1].at).getTime());
    return { ...file, handles: Object.fromEntries(fresh.slice(0, MAX_ENTRIES)) };
  }

  /**
   * Records observations. Throws if it cannot — callers must fail the read rather than return content whose taint
   * was not recorded.
   */
  async record(
    observations: readonly TaintObservation[],
    exclusions: TaintExclusions,
    handleObservations: readonly TaintHandleObservation[] = [],
  ): Promise<void> {
    const own = new Set(exclusions.ownAddresses.map(canonicalAddress));
    const internal = new Set(exclusions.internalDomains.map((d) => d.toLowerCase()));
    const ownHandles = new Set((exclusions.ownHandles ?? []).map(canonicalHandle));
    const keptHandles = handleObservations
      .map((o) => ({ ...o, key: canonicalHandle(o.handle) }))
      .filter((o) => o.handle.id.trim() !== '' && !ownHandles.has(o.key))
      .sort((a, b) => (a.source === b.source ? 0 : a.source === 'header' ? -1 : 1))
      // The same cap as addresses, and for the same reason — one message listing every member of a large workspace
      // must not taint all of them and escalate every later send — but its own budget, not a shared one. Sharing
      // would let a body padded with addresses push the handles out of a message that carried both.
      .slice(0, MAX_PER_MESSAGE);
    const kept = observations
      .map((o) => ({ ...o, address: canonicalAddress(o.address) }))
      .filter((o) => o.address.includes('@') && !own.has(o.address) && !internal.has(domainOf(o.address) ?? ''))
      // Headers first, then body sightings: a header address is the stronger signal, so it is the one that
      // survives if a single message carries more addresses than this will record.
      .sort((a, b) => (a.source === b.source ? 0 : a.source === 'header' ? -1 : 1))
      .slice(0, MAX_PER_MESSAGE);
    if (kept.length === 0 && keptHandles.length === 0) return;
    const at = this.#now().toISOString();
    const touch = (map: Record<string, TaintEntry>, key: string, o: { source: TaintSource; inboxId: string }) => {
      const existing = map[key];
      const inboxIds = [...new Set([...(existing?.inboxIds ?? []), o.inboxId])];
      // A header sighting is kept once seen: it is the stronger signal.
      const source: TaintSource = existing?.source === 'header' ? 'header' : o.source;
      map[key] = { at, source, inboxIds };
    };

    // Two files, each under its own lock — see `HandleFile`. Not one transaction across both: they are independent
    // stores, and a crash between them loses at most one kind of tripwire rather than corrupting either.
    if (kept.length > 0) {
      const path = this.#path;
      await withFileLock(`${path}.lock`, async () => {
        const file = this.#prune(await this.#read());
        for (const o of kept) {
          touch(file.addresses, o.address, o);
          const domain = domainOf(o.address);
          if (domain && !PUBLIC_MAILBOX_DOMAINS.has(domain)) touch(file.domains, domain, o);
        }
        await writeFileAtomic(path, JSON.stringify(file));
      });
    }

    if (keptHandles.length > 0) {
      const path = this.#handlesPath;
      await withFileLock(`${path}.lock`, async () => {
        const file = this.#pruneHandles(await this.#readHandles());
        // No domain counterpart: a handle has no part that generalises to others the way a domain does.
        for (const o of keptHandles) touch(file.handles, o.key, o);
        await writeFileAtomic(path, JSON.stringify(file));
      });
    }
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

  /**
   * Whether a handle was seen in message content in the window.
   *
   * Only within its own workspace — see `TaintHandle`. There is no second answer to give, the way an address also
   * carries a domain: two ids sharing a workspace says nothing about either of them.
   */
  async checkHandle(handle: TaintHandle): Promise<boolean> {
    const file = this.#pruneHandles(await this.#readHandles());
    return canonicalHandle(handle) in file.handles;
  }
}

/**
 * The context every read path uses to put sender-controlled content into a result. It wraps strings in the untrusted
 * envelope and collects every address it sees; `flush` records them once, and a read must not return until it has.
 */
export class TaintCollector {
  readonly #observations: TaintObservation[] = [];
  readonly #handles: TaintHandleObservation[] = [];
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

  /**
   * Records platform identifiers found in message content — the ids behind `<@U024BE7LH>` and `<#C0123|general>`.
   *
   * Parsing them out is the platform adapter's job, not core's: the markup is Slack's, and a regex here would be a
   * second place to keep it correct. What core insists on is that the caller hands over ids rather than the display
   * names beside them, which the account being named can change at any time.
   */
  observeHandles(handles: Iterable<TaintHandle>, source: TaintSource = 'body'): void {
    for (const handle of handles) {
      this.#handles.push({ handle, source, inboxId: this.#inboxId, messageId: this.#messageId });
    }
  }

  get size(): number {
    return this.#observations.length + this.#handles.length;
  }

  observations(): TaintObservation[] {
    return [...this.#observations];
  }

  handleObservations(): TaintHandleObservation[] {
    return [...this.#handles];
  }

  /** Records everything collected. Throws when it cannot, so the read fails closed. */
  async flush(store: TaintStore, exclusions: TaintExclusions): Promise<void> {
    await store.record(this.#observations, exclusions, this.#handles);
  }
}
