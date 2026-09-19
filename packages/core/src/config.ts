import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';
import { expandHome } from './paths.ts';

/**
 * The one config file. Provider-neutral: provider-specific fields (scopes, tiers) are plain strings here and validated
 * by the provider package. No secret ever appears in it — only references into the secret store.
 */

export const CONFIG_VERSION = 1;

export const ALIAS_PATTERN: RegExp = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ALIAS_MESSAGE = 'names must be 1–32 lowercase letters, digits or hyphens, starting with a letter or digit';

export type SendPolicy = 'chat' | 'confirm' | 'never';
export type StoreKind = 'keychain' | 'file';

export interface ClientConfig {
  provider: string;
  clientId: string;
  projectId?: string | undefined;
  secretRef: string;
  addedAt: string;
}

export interface InboxConfig {
  /** Immutable id (`ibx_` + 16 base32 characters). Secrets and all state are keyed by it; the alias is a label. */
  id: string;
  provider: string;
  email: string;
  /** Stable account id (OIDC `sub`). Absent for inboxes imported from tools that never asked for it. */
  sub?: string | undefined;
  identity: 'oidc' | 'legacy';
  client: string;
  tier: string;
  contacts: boolean;
  grantedScopes: string[];
  secretRef: string;
  sendPolicy?: SendPolicy | undefined;
  internalDomains: string[];
  createdAt: string;
}

export interface Defaults {
  sendPolicy: SendPolicy;
  riskEscalation: boolean;
  sendCaps: { perHour: number; perDay: number };
  attachRoots: string[];
  /** Extra deny entries on top of the built-in list. */
  attachDeny: string[];
  downloadsDir?: string | undefined;
  timezone: string;
  confirm: {
    /**
     * Fail-closed allowlist of MCP `clientInfo.name` values whose form elicitation is trusted to reach a human.
     * Empty by default; only the CLI adds entries, after a probe.
     */
    elicitationClients: string[];
  };
}

export interface Config {
  version: typeof CONFIG_VERSION;
  /**
   * The one secret backend for this config directory: client secrets, refresh tokens and the approval key. Absent
   * until the first command that stores a secret chooses it.
   */
  secrets?: { store: StoreKind } | undefined;
  clients: Record<string, ClientConfig>;
  inboxes: Record<string, InboxConfig>;
  defaults: Defaults;
}

const aliasSchema = z.string().regex(ALIAS_PATTERN, ALIAS_MESSAGE);
const BASE32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
export const INBOX_ID_PATTERN: RegExp = /^ibx_[A-Z0-9]{16}$/;

/** A new immutable inbox id: `ibx_` + 16 characters from an unambiguous alphabet (80 random bits). */
export function newInboxId(): string {
  const bytes = randomBytes(16);
  let out = 'ibx_';
  for (const byte of bytes) out += BASE32[byte % BASE32.length];
  return out;
}
const sendPolicySchema = z.enum(['chat', 'confirm', 'never']);
const storeKindSchema = z.enum(['keychain', 'file']);

const clientSchema = z.looseObject({
  provider: z.string().min(1),
  clientId: z.string().min(1),
  projectId: z.string().optional(),
  secretRef: z.string().min(1),
  addedAt: z.string(),
});

const inboxSchema = z.looseObject({
  id: z.string().regex(INBOX_ID_PATTERN, 'inbox ids look like ibx_ followed by 16 characters'),
  provider: z.string().min(1),
  email: z.string().min(3),
  sub: z.string().optional(),
  identity: z.enum(['oidc', 'legacy']),
  client: aliasSchema,
  tier: z.string().min(1),
  contacts: z.boolean().default(false),
  grantedScopes: z.array(z.string()).default([]),
  secretRef: z.string().min(1),
  sendPolicy: sendPolicySchema.optional(),
  // Lower-cased on the way in: domains are case-insensitive, and a mixed-case entry would otherwise fail to match
  // the inbox's own domain and demand consent for a change that is not one.
  internalDomains: z.array(z.string().transform((domain) => domain.trim().toLowerCase())).default([]),
  createdAt: z.string(),
});

const defaultsSchema = z.looseObject({
  sendPolicy: sendPolicySchema.default('chat'),
  riskEscalation: z.boolean().default(true),
  sendCaps: z
    .object({ perHour: z.number().int().min(0).default(20), perDay: z.number().int().min(0).default(100) })
    .default({ perHour: 20, perDay: 100 }),
  attachRoots: z.array(z.string()).default(['~']),
  attachDeny: z.array(z.string()).default([]),
  downloadsDir: z.string().optional(),
  timezone: z.string().default('system'),
  confirm: z.object({ elicitationClients: z.array(z.string()).default([]) }).default({ elicitationClients: [] }),
});

export const RESERVED_ALIASES: ReadonlySet<string> = new Set(['all']);

/**
 * Unknown keys are kept, never dropped. Two versions of this software share one config file — an MCP server started
 * last week, a CLI installed today — and a reader that silently discarded what it did not understand would quietly
 * undo settings the other one wrote. Within `version: 1` every change is additive for that reason.
 */
export const configSchema: z.ZodType<Config, unknown> = z
  .looseObject({
    version: z.literal(CONFIG_VERSION),
    secrets: z.looseObject({ store: storeKindSchema }).optional(),
    clients: z.record(aliasSchema, clientSchema).default({}),
    inboxes: z.record(aliasSchema, inboxSchema).default({}),
    defaults: defaultsSchema.default(defaultsSchema.parse({})),
  })
  .superRefine((config, ctx) => {
    const seen = new Map<string, string>();
    for (const [alias, inbox] of Object.entries(config.inboxes)) {
      if (RESERVED_ALIASES.has(alias)) {
        ctx.addIssue({ code: 'custom', path: ['inboxes', alias], message: `"${alias}" is reserved` });
      }
      const other = seen.get(inbox.id);
      if (other)
        ctx.addIssue({ code: 'custom', path: ['inboxes', alias, 'id'], message: `duplicates the id of "${other}"` });
      seen.set(inbox.id, alias);
    }
  });

/** The secret backend in use: the recorded one, or the keychain before anything has been stored. */
export function secretsStoreOf(config: Config): StoreKind {
  return config.secrets?.store ?? 'keychain';
}

/** True when `alias` is a valid inbox or client name. */
export function isValidAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

export function emptyConfig(): Config {
  return configSchema.parse({ version: CONFIG_VERSION });
}

/** The send policy that applies to an inbox: its own, else the default. */
export function effectiveSendPolicy(config: Config, inbox: string): SendPolicy {
  return config.inboxes[inbox]?.sendPolicy ?? config.defaults.sendPolicy;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const where = issue.path.join('.') || '(root)';
      // zod reports a bad record key as "Invalid key in record"; say what a valid name looks like instead.
      return issue.code === 'invalid_key'
        ? `${where}: inbox and client ${ALIAS_MESSAGE}`
        : `${where}: ${issue.message}`;
    })
    .join('; ');
}

/** Parses and validates config JSON. Unknown versions are refused rather than guessed at. */
export function parseConfig(text: string, source = 'config.json'): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CommsError('CONFIG', `${source} is not valid JSON`, { cause: error });
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (version !== CONFIG_VERSION) {
    throw new CommsError(
      'CONFIG',
      `${source} has version ${String(version)}; this release reads version ${CONFIG_VERSION}`,
      {
        hint: 'Upgrade agent-communications, or restore a config written by this version.',
      },
    );
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new CommsError('CONFIG', `${source} is invalid: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

export class ConfigStore {
  readonly path: string;
  readonly #lockPath: string;
  #cache: { key: string; config: Config } | null = null;

  constructor(configDir: string) {
    this.path = join(configDir, 'config.json');
    // The lock sits next to the file it guards, so an overridden state directory cannot split it.
    this.#lockPath = join(configDir, '.config.lock');
  }

  /** The current config; an empty one when the file does not exist yet. */
  async load(): Promise<Config> {
    let key: string;
    try {
      // Every write is a rename onto the path, so the inode changes even when two writes share a timestamp.
      const info = await stat(this.path);
      key = `${info.ino}:${info.mtimeMs}:${info.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
      throw error;
    }
    if (this.#cache && this.#cache.key === key) return structuredClone(this.#cache.config);
    const config = parseConfig(await readFile(this.path, 'utf8'), this.path);
    this.#cache = { key, config };
    return structuredClone(config);
  }

  /**
   * Read-modify-write under a lock, so a CLI command and a running MCP server never lose each other's changes. The
   * mutator receives a fresh copy read inside the lock and returns the new config, which is validated before writing.
   */
  async update(
    mutator: (config: Config) => Config | Promise<Config>,
    options: { consent?: LooseningConsent } = {},
  ): Promise<Config> {
    return withFileLock(this.#lockPath, async () => {
      this.#cache = null;
      const current = structuredClone(await this.load());
      const next = await mutator(structuredClone(current));
      const parsed = configSchema.safeParse(next);
      if (!parsed.success) {
        throw new CommsError('CONFIG', `refusing to write invalid config: ${describeIssues(parsed.error)}`);
      }
      const { loosened } = classifyChange(current, parsed.data);
      const allowed = new Set(options.consent?.paths ?? []);
      const unconsented = loosened.filter((path) => !allowed.has(path));
      if (unconsented.length > 0) {
        throw new CommsError('LOOSENING_REFUSED', `this change loosens a safety setting: ${unconsented.join(', ')}`, {
          hint: 'Only a person at a terminal can loosen these, by running the matching command and typing the challenge it shows.',
          details: { paths: unconsented },
        });
      }
      await writeFileAtomic(this.path, `${JSON.stringify(parsed.data, null, 2)}\n`);
      this.#cache = null;
      return parsed.data;
    });
  }
}

/** The default `internalDomains` for a new inbox: its own domain, unless that is a public mailbox provider. */
export function defaultInternalDomains(email: string, publicDomains: ReadonlySet<string>): string[] {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return domain && !publicDomains.has(domain) ? [domain] : [];
}

const POLICY_RANK: Record<SendPolicy, number> = { chat: 0, confirm: 1, never: 2 };

/**
 * A path as it will actually be used: `~` expanded, `..` resolved, separators normalised, no trailing slash.
 *
 * Resolving `..` is the whole point, not tidiness. `isInsideDirectory` compares by string prefix, so
 * `~/downloads/../../../tmp` "is inside" `~/downloads` while naming somewhere else entirely — and that comparison
 * decides whether moving the downloads directory needs the user's consent. Without `resolve`, an agent could redirect
 * every attachment it downloads into a world-readable directory without anyone being asked.
 *
 * Case is folded on macOS and Windows, whose filesystems are case-insensitive by default: there, `~/Downloads` and
 * `~/downloads` are one directory, and treating them as two reports a loosening that never happened — which costs the
 * user a consent prompt for a change that is not one. Linux is case-sensitive, so case is kept.
 */
function normalisePath(path: string): string {
  const expanded = resolve(expandHome(path.trim(), homedir())).replace(/[/\\]+$/, '');
  return platform() === 'darwin' || platform() === 'win32' ? expanded.toLowerCase() : expanded;
}

/** Whether anything in this configuration already points at a stored secret. */
function holdsSecrets(config: Config): boolean {
  return (
    Object.values(config.clients).some((client) => Boolean(client.secretRef)) ||
    Object.values(config.inboxes).some((inbox) => Boolean(inbox.secretRef))
  );
}

/** True when `candidate` is the same directory as `parent`, or inside it. Both may be unset. */
function isInsideDirectory(candidate: string | undefined, parent: string | undefined): boolean {
  if (!candidate || !parent) return false;
  return candidate === parent || candidate.startsWith(`${parent}/`) || candidate.startsWith(`${parent}\\`);
}

/**
 * Which paths of a config change loosen a safety setting. A safety setting may only be loosened by a person at a
 * terminal who typed a challenge (see LooseningConsent); tightening never needs consent.
 */
export function classifyChange(before: Config, after: Config): { loosened: string[] } {
  const loosened: string[] = [];
  for (const [alias, inbox] of Object.entries(after.inboxes)) {
    const previous = Object.values(before.inboxes).find((i) => i.id === inbox.id);
    // A newly added inbox is measured against the policy in force before it existed: adding one that may send more
    // freely than the default is the same loosening as relaxing an existing one, and needs the same consent.
    const was = previous ? (previous.sendPolicy ?? before.defaults.sendPolicy) : before.defaults.sendPolicy;
    const now = inbox.sendPolicy ?? after.defaults.sendPolicy;
    if (POLICY_RANK[now] < POLICY_RANK[was]) loosened.push(`inboxes.${alias}.sendPolicy`);
    // For a new inbox, its own domain is part of what it is; any *other* domain declared internal is a claim about
    // who to trust, and needs the same consent as widening an existing inbox's list.
    const ownDomain = inbox.email.slice(inbox.email.lastIndexOf('@') + 1).toLowerCase();
    const domainsBefore = previous ? previous.internalDomains : [ownDomain];
    if (inbox.internalDomains.some((domain) => !domainsBefore.includes(domain))) {
      loosened.push(`inboxes.${alias}.internalDomains`);
    }
  }
  const b = before.defaults;
  const a = after.defaults;
  // Checked directly as well: with no inboxes (yet), the loop above sees nothing, and the next inbox added would
  // inherit the looser default without anyone having been asked.
  if (POLICY_RANK[a.sendPolicy] < POLICY_RANK[b.sendPolicy]) loosened.push('defaults.sendPolicy');
  if (b.riskEscalation && !a.riskEscalation) loosened.push('defaults.riskEscalation');
  if (a.sendCaps.perHour > b.sendCaps.perHour || a.sendCaps.perDay > b.sendCaps.perDay)
    loosened.push('defaults.sendCaps');
  // Paths are compared by what they resolve to: a path written with `~` and the same path written in full are the
  // same place, and comparing them as strings would either ask for consent that is not needed or miss a change
  // that is.
  const roots = (list: readonly string[]) => new Set(list.map(normalisePath));
  const before_roots = roots(b.attachRoots);
  const after_deny = roots(a.attachDeny);
  if ([...roots(a.attachRoots)].some((root) => !before_roots.has(root))) loosened.push('defaults.attachRoots');
  if ([...roots(b.attachDeny)].some((deny) => !after_deny.has(deny))) loosened.push('defaults.attachDeny');
  // Moving where files from strangers land is a safety change — unless the new place is inside the old one, which
  // narrows rather than widens it.
  // Unset is not "anywhere": it means the built-in downloads directory under our own state, which is the narrowest
  // place there is. So clearing the setting returns to that default and loosens nothing, while naming a directory
  // where none was named moves downloads out of it.
  const downloadsBefore = b.downloadsDir === undefined ? undefined : normalisePath(b.downloadsDir);
  const downloadsAfter = a.downloadsDir === undefined ? undefined : normalisePath(a.downloadsDir);
  if (
    downloadsAfter !== undefined &&
    downloadsAfter !== downloadsBefore &&
    !isInsideDirectory(downloadsAfter, downloadsBefore)
  ) {
    loosened.push('defaults.downloadsDir');
  }
  if (a.confirm.elicitationClients.some((c) => !b.confirm.elicitationClients.includes(c))) {
    loosened.push('defaults.confirm.elicitationClients');
  }
  // Moving away from a recorded keychain is a downgrade, whether it names another store or erases the record so the
  // next write can name one. Choosing a store on a configuration that has never held a secret is not a downgrade —
  // it is setup, and on a machine with no keychain (a server, a container) files are the only thing that works.
  if (before.secrets?.store === 'keychain' && after.secrets?.store !== 'keychain') loosened.push('secrets.store');
  // And the unrecorded case, which is the same downgrade wearing a different shape: with no `secrets` block the
  // effective store is the keychain (`secretsStoreOf`), so if this configuration already holds secret references,
  // naming `file` for the first time moves real secrets out of the keychain. Only a configuration with nothing
  // stored yet is setup.
  if (before.secrets === undefined && after.secrets !== undefined && after.secrets.store !== 'keychain') {
    if (holdsSecrets(before)) loosened.push('secrets.store');
  }
  return { loosened };
}

/** Proof, produced by the CLI after a person at a terminal typed a challenge, that exactly these paths may loosen. */
export interface LooseningConsent {
  kind: 'loosening-consent';
  paths: readonly string[];
}

/** Finds an inbox by its immutable id. */
export function findInboxById(config: Config, id: string): { alias: string; inbox: InboxConfig } | null {
  for (const [alias, inbox] of Object.entries(config.inboxes)) if (inbox.id === id) return { alias, inbox };
  return null;
}

/**
 * The alias of an existing inbox for the same account on the same client, if any. Accounts are matched by `sub`, or by
 * lower-cased email for legacy inboxes that have none. Adding a second inbox for one account would make two aliases
 * share — and overwrite — one grant.
 */
export function duplicateInbox(
  config: Config,
  candidate: { client: string; sub?: string | undefined; email: string },
): string | null {
  const email = candidate.email.toLowerCase();
  for (const [alias, inbox] of Object.entries(config.inboxes)) {
    if (inbox.client !== candidate.client) continue;
    if (candidate.sub && inbox.sub && inbox.sub === candidate.sub) return alias;
    if (inbox.email.toLowerCase() === email) return alias;
  }
  return null;
}

/** Looks up an inbox by alias or fails with the list of known aliases. */
export function requireInbox(config: Config, alias: string): InboxConfig {
  const inbox = config.inboxes[alias];
  if (inbox) return inbox;
  const known = Object.keys(config.inboxes);
  throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`, {
    hint: known.length
      ? `Known inboxes: ${known.join(', ')}.`
      : 'No inboxes yet: add one with `agent-gmail inbox add`.',
  });
}
