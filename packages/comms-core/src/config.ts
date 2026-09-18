import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';

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
  /** The one secret backend for this config directory: client secrets, refresh tokens and the approval key. */
  secrets: { store: StoreKind };
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

const clientSchema = z.object({
  provider: z.string().min(1),
  clientId: z.string().min(1),
  projectId: z.string().optional(),
  secretRef: z.string().min(1),
  addedAt: z.string(),
});

const inboxSchema = z.object({
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
  internalDomains: z.array(z.string()).default([]),
  createdAt: z.string(),
});

const defaultsSchema = z.object({
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

export const configSchema: z.ZodType<Config, unknown> = z.object({
  version: z.literal(CONFIG_VERSION),
  secrets: z.object({ store: storeKindSchema }).default({ store: 'keychain' }),
  clients: z.record(aliasSchema, clientSchema).default({}),
  inboxes: z.record(aliasSchema, inboxSchema).default({}),
  defaults: defaultsSchema.default(defaultsSchema.parse({})),
});

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
    this.#lockPath = join(configDir, 'state', 'config.lock');
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
  async update(mutator: (config: Config) => Config | Promise<Config>): Promise<Config> {
    return withFileLock(this.#lockPath, async () => {
      this.#cache = null;
      const current = structuredClone(await this.load());
      const next = await mutator(current);
      const parsed = configSchema.safeParse(next);
      if (!parsed.success)
        throw new CommsError('CONFIG', `refusing to write invalid config: ${describeIssues(parsed.error)}`);
      await writeFileAtomic(this.path, `${JSON.stringify(parsed.data, null, 2)}\n`);
      this.#cache = null;
      return parsed.data;
    });
  }
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
