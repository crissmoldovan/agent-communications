import { createHash, randomBytes } from 'node:crypto';
import { chmod, open, readFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { type ConfigVersion, NEW_CONFIG_VERSION } from './config-version.ts';
import { CommsError } from './errors.ts';
import { FILE_MODE, writeFileAtomic } from './fs.ts';
import { withCredentialsLock, withFileLock } from './lock.ts';
import { NAME_MESSAGE, NAME_PATTERN, parseName } from './name-grammar.ts';
import { expandHome } from './paths.ts';
import { namesMigrationEnabled } from './release-gate.ts';

/**
 * The one config file. Provider-neutral: provider-specific fields (scopes, tiers) are plain strings here and validated
 * by the provider package. No secret ever appears in it — only references into the secret store.
 */

/**
 * The versions this release reads.
 *
 * Version 1 is strictly additive and names accounts with one plain word. Version 2 names every account
 * `organisation/platform[-qualifier]` and records the names it replaced (see `name-grammar.ts`). A release reads a
 * version or refuses it outright; it never guesses at a shape it does not know.
 */
export const READABLE_CONFIG_VERSIONS: readonly ConfigVersion[] = [1, 2];

export { type ConfigVersion, NEW_CONFIG_VERSION } from './config-version.ts';

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

/**
 * A connected account on a platform that is not mail: a Slack workspace, and whatever follows it.
 *
 * It sits beside `inboxes` rather than replacing it. The spec asked for one `accounts` map holding everything, and
 * that rename is the one change this file cannot take: `version: 1` is additive precisely because an MCP server
 * started last week and a CLI run today share the file, and a release that moved every mailbox out of `inboxes`
 * would read, to the older of the two, as a config with no mailboxes in it. What the rename was for — one list of
 * everything connected, whatever the platform — is a question about the shape of the answer, not the shape of the
 * file, so `connectedAccounts()` provides it and the file grows one key.
 */
export interface AccountConfig {
  id: string;
  /** `slack`. */
  platform: string;
  /** The workspace or team id. Every other id this account sees is only meaningful inside it. */
  workspace: string;
  /** "Acme Corp" — shown to people, never matched on: a workspace can be renamed and stays the same workspace. */
  workspaceName?: string | undefined;
  /** This account's own user id in that workspace, so its own messages can be told from everyone else's. */
  userId: string;
  tier: string;
  grantedScopes: string[];
  secretRef: string;
  sendPolicy?: SendPolicy | undefined;
  createdAt: string;
  /**
   * The OAuth client this account's token was issued by, and the app it belongs to.
   *
   * Recorded because the Gmail release found the opposite: a reauth used the first OAuth client in the config
   * rather than the inbox's own, and then did not record which one it had used. Slack makes that worse — D8
   * means **one app per workspace**, so "the first app" is wrong more often than it is right — and a reauth
   * that silently moves an account onto a different app changes what it can do without saying so.
   *
   * Optional because the key is additive: a config written before these existed parses unchanged.
   */
  oauthClientId?: string | undefined;
  appId?: string | undefined;
  /**
   * `read` or `send`, as installed.
   *
   * Kept beside `grantedScopes` rather than derived from them, because the two answer different questions: the
   * scopes are what Slack granted, and this is what the person asked for. A disagreement between them is drift
   * worth reporting, and a value derived from the scopes could never disagree.
   */
  mode?: string | undefined;
}

interface ConfigBody {
  /**
   * The one secret backend for this config directory: client secrets, refresh tokens and the approval key. Absent
   * until the first command that stores a secret chooses it.
   */
  secrets?: { store: StoreKind } | undefined;
  clients: Record<string, ClientConfig>;
  inboxes: Record<string, InboxConfig>;
  /** Non-mail accounts. Absent in every config written before this key existed, hence the default. */
  accounts: Record<string, AccountConfig>;
  defaults: Defaults;
}

export interface ConfigV1 extends ConfigBody {
  version: 1;
}

/** A name an account used to have, and the account that had it. */
export interface FormerName {
  /** What it was renamed to — at the time. The account's current name is found by `id`, so a later rename is followed. */
  name: string;
  id: string;
}

/**
 * Names that were replaced, per kind, and never reusable.
 *
 * Per kind because version 1 lets a mailbox and a workspace share a word: `work` the mailbox and `work` the workspace
 * become `work/gmail` and `work/slack`, and one flat record could not say which old `work` is which.
 */
export interface FormerNames {
  inboxes: Record<string, FormerName>;
  accounts: Record<string, FormerName>;
}

export interface ConfigV2 extends ConfigBody {
  version: 2;
  formerNames: FormerNames;
}

export type Config = ConfigV1 | ConfigV2;

const aliasSchema = z.string().regex(ALIAS_PATTERN, ALIAS_MESSAGE);
const nameSchema = z.string().regex(NAME_PATTERN, NAME_MESSAGE);
const BASE32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
export const INBOX_ID_PATTERN: RegExp = /^ibx_[A-Z0-9]{16}$/;

export const ACCOUNT_ID_PATTERN: RegExp = /^acc_[A-Z0-9]{16}$/;

function newId(prefix: string): string {
  const bytes = randomBytes(16);
  let out = prefix;
  for (const byte of bytes) out += BASE32[byte % BASE32.length];
  return out;
}

/** A new immutable inbox id: `ibx_` + 16 characters from an unambiguous alphabet (80 random bits). */
export function newInboxId(): string {
  return newId('ibx_');
}

/** The same for a non-mail account. A distinct prefix, so an id alone says which map it belongs to. */
export function newAccountId(): string {
  return newId('acc_');
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

const accountSchema = z.looseObject({
  id: z.string().regex(ACCOUNT_ID_PATTERN, 'account ids look like acc_ followed by 16 characters'),
  platform: z.string().min(1),
  workspace: z.string().min(1),
  workspaceName: z.string().optional(),
  userId: z.string().min(1),
  tier: z.string().min(1),
  grantedScopes: z.array(z.string()).default([]),
  secretRef: z.string().min(1),
  sendPolicy: sendPolicySchema.optional(),
  createdAt: z.string(),
  oauthClientId: z.string().min(1).optional(),
  appId: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
});

// Loose at every level, nested objects included. `sendCaps` and `confirm` were plain objects, which strip what they do
// not know — so a key a newer release added inside them was silently dropped by the next write from an older one,
// and a change to it was invisible to the migration's fingerprint. Keeping more than before is safe for every older
// reader: it strips them, as it always has.
const defaultsSchema = z.looseObject({
  sendPolicy: sendPolicySchema.default('chat'),
  riskEscalation: z.boolean().default(true),
  sendCaps: z
    .looseObject({ perHour: z.number().int().min(0).default(20), perDay: z.number().int().min(0).default(100) })
    .default({ perHour: 20, perDay: 100 }),
  attachRoots: z.array(z.string()).default(['~']),
  attachDeny: z.array(z.string()).default([]),
  downloadsDir: z.string().optional(),
  timezone: z.string().default('system'),
  confirm: z.looseObject({ elicitationClients: z.array(z.string()).default([]) }).default({ elicitationClients: [] }),
});

export const RESERVED_ALIASES: ReadonlySet<string> = new Set(['all']);

/** Within one map, a reserved alias or a duplicate id is a hard error in every version. */
function checkWithinMaps(
  config: { inboxes: Record<string, { id: string }>; accounts: Record<string, { id: string }> },
  ctx: z.RefinementCtx,
): void {
  const check = (map: 'inboxes' | 'accounts', entries: Record<string, { id: string }>) => {
    const ids = new Map<string, string>();
    for (const [alias, entry] of Object.entries(entries)) {
      if (RESERVED_ALIASES.has(alias)) {
        ctx.addIssue({ code: 'custom', path: [map, alias], message: `"${alias}" is reserved` });
      }
      const other = ids.get(entry.id);
      if (other) {
        ctx.addIssue({ code: 'custom', path: [map, alias, 'id'], message: `duplicates the id of "${other}"` });
      }
      ids.set(entry.id, alias);
    }
  };
  check('inboxes', config.inboxes);
  check('accounts', config.accounts);
}

/**
 * Unknown keys are kept, never dropped. Two versions of this software share one config file — an MCP server started
 * last week, a CLI installed today — and a reader that silently discarded what it did not understand would quietly
 * undo settings the other one wrote. Within `version: 1` every change is additive for that reason.
 *
 * This is the version-1 schema exactly as every earlier release has it. Tightening it would make files those
 * releases wrote unreadable here.
 */
export const configV1Schema: z.ZodType<ConfigV1, unknown> = z
  .looseObject({
    version: z.literal(1),
    secrets: z.looseObject({ store: storeKindSchema }).optional(),
    clients: z.record(aliasSchema, clientSchema).default({}),
    inboxes: z.record(aliasSchema, inboxSchema).default({}),
    accounts: z.record(aliasSchema, accountSchema).default({}),
    defaults: defaultsSchema.default(defaultsSchema.parse({})),
  })
  .superRefine((config, ctx) => {
    // Across the two maps a collision cannot be an error. A v1 invariant may not depend on old writers enforcing a
    // rule they have never heard of: 0.1.2 can rename a mailbox onto an alias this version gave an account, and it
    // will, because nothing in it can see the account. Refusing to parse the result would turn a name clash into a
    // configuration that cannot be read at all — every mailbox gone, on a file the user never touched. So a
    // persisted collision is tolerated here and reported by `aliasConflicts`, and the lookup that cannot answer
    // refuses at the point somebody asks it something ambiguous.
    checkWithinMaps(config, ctx);
  });

const formerNameSchema = z.looseObject({ name: nameSchema, id: z.string().min(1) });
// A former name is whatever the account was called before: a version-1 alias, or an earlier version-2 name.
const formerKeySchema = z.string().refine((key) => ALIAS_PATTERN.test(key) || NAME_PATTERN.test(key), {
  message: 'a former name must have been a valid name',
});

/**
 * Version 2: every account named `organisation/platform[-qualifier]`, the platform checked against the account, and
 * names unique across both maps.
 *
 * Version 2 can afford what version 1 could not. No release that writes it predates the rule, and every release
 * that predates version 2 refuses to read the file at all — so nothing that cannot see the other map can put a
 * clash into it.
 */
export const configV2Schema: z.ZodType<ConfigV2, unknown> = z
  .looseObject({
    version: z.literal(2),
    secrets: z.looseObject({ store: storeKindSchema }).optional(),
    // OAuth clients keep plain names. One client is shared by mailboxes across organisations, so an organisation
    // prefix on it would be wrong.
    clients: z.record(aliasSchema, clientSchema).default({}),
    inboxes: z.record(nameSchema, inboxSchema).default({}),
    accounts: z.record(nameSchema, accountSchema).default({}),
    defaults: defaultsSchema.default(defaultsSchema.parse({})),
    formerNames: z
      .looseObject({
        inboxes: z.record(formerKeySchema, formerNameSchema).default({}),
        accounts: z.record(formerKeySchema, formerNameSchema).default({}),
      })
      .default({ inboxes: {}, accounts: {} }),
  })
  .superRefine((config, ctx) => {
    checkWithinMaps(config, ctx);
    for (const [name, inbox] of Object.entries(config.inboxes)) {
      const platform = parseName(name)?.platform;
      if (platform !== undefined && platform !== inbox.provider) {
        ctx.addIssue({
          code: 'custom',
          path: ['inboxes', name],
          message: `ends in /${platform}, but it is a ${inbox.provider} mailbox`,
        });
      }
    }
    for (const [name, account] of Object.entries(config.accounts)) {
      const platform = parseName(name)?.platform;
      if (platform !== undefined && platform !== account.platform) {
        ctx.addIssue({
          code: 'custom',
          path: ['accounts', name],
          message: `ends in /${platform}, but it is a ${account.platform} account`,
        });
      }
      if (config.inboxes[name]) {
        ctx.addIssue({ code: 'custom', path: ['accounts', name], message: 'names a mailbox too' });
      }
    }
    const inboxIds = new Set(Object.values(config.inboxes).map((inbox) => inbox.id));
    for (const [name, account] of Object.entries(config.accounts)) {
      if (inboxIds.has(account.id)) {
        ctx.addIssue({ code: 'custom', path: ['accounts', name, 'id'], message: 'duplicates the id of a mailbox' });
      }
    }
    // A former name is never reusable. Checked here, on every write, rather than only where names are proposed: a
    // lookup of a former name is refused with its replacement, so an account that took one would be unreachable
    // by it — or worse, reached by somebody who meant the old one.
    const live = new Set([...Object.keys(config.inboxes), ...Object.keys(config.accounts)]);
    for (const map of ['inboxes', 'accounts'] as const) {
      for (const former of Object.keys(config.formerNames[map])) {
        if (live.has(former)) {
          ctx.addIssue({
            code: 'custom',
            path: ['formerNames', map, former],
            message: `"${former}" was renamed and cannot be used again`,
          });
        }
      }
    }
  });

function schemaFor(version: ConfigVersion): z.ZodType<Config, unknown> {
  return version === 2 ? configV2Schema : configV1Schema;
}

/**
 * Aliases, or ids, that name something in both maps at once.
 *
 * Empty for every configuration this version writes. Non-empty means an older release renamed a mailbox onto an
 * account's name — see the note in the schema — and `doctor` should say so, because the fix is a rename and only a
 * person can choose which one.
 */
export function aliasConflicts(config: Config): { alias: string; ids: string[] }[] {
  const conflicts: { alias: string; ids: string[] }[] = [];
  for (const [alias, inbox] of Object.entries(config.inboxes)) {
    const account = config.accounts[alias];
    if (account) conflicts.push({ alias, ids: [inbox.id, account.id] });
  }
  const byId = new Map<string, string>();
  for (const [alias, inbox] of Object.entries(config.inboxes)) byId.set(inbox.id, alias);
  for (const [alias, account] of Object.entries(config.accounts)) {
    const other = byId.get(account.id);
    if (other && other !== alias) conflicts.push({ alias, ids: [account.id] });
  }
  return conflicts;
}

/**
 * Everything connected, whichever map it lives in, in one list.
 *
 * This is what the `inboxes` → `accounts` rename was for, and it is the part worth having: callers that do not care
 * whether something is a mailbox or a workspace — `doctor`, the secret store, `agentcomms accounts list` — ask here
 * and get one answer. Callers that do care keep reading the map they mean, and say so by doing it.
 */
export type ConnectedAccount =
  | { kind: 'mail'; alias: string; id: string; platform: string; secretRef: string; inbox: InboxConfig }
  | { kind: 'channel'; alias: string; id: string; platform: string; secretRef: string; account: AccountConfig };

export function connectedAccounts(config: Config): ConnectedAccount[] {
  const mail = Object.entries(config.inboxes).map(
    ([alias, inbox]): ConnectedAccount => ({
      kind: 'mail',
      alias,
      id: inbox.id,
      platform: inbox.provider,
      secretRef: inbox.secretRef,
      inbox,
    }),
  );
  const channel = Object.entries(config.accounts).map(
    ([alias, account]): ConnectedAccount => ({
      kind: 'channel',
      alias,
      id: account.id,
      platform: account.platform,
      secretRef: account.secretRef,
      account,
    }),
  );
  // Sorted by alias, not concatenated: the two maps are an implementation detail of the file, and a list that put
  // every mailbox before every workspace would make that detail visible in every `list` a person reads.
  return [...mail, ...channel].sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * The one thing an alias names, in either map, or null when it names nothing.
 *
 * Throws when it names two things. That state is reachable — an older release can write it (see `aliasConflicts`) —
 * and picking one of the two would be the worst available answer: the caller would act on a mailbox believing it
 * had a workspace, or the reverse, with nothing in the output saying which.
 */
export function findConnectedAccount(config: Config, alias: string): ConnectedAccount | null {
  const matches = connectedAccounts(config).filter((entry) => entry.alias === alias);
  if (matches.length > 1) {
    throw new CommsError('CONFIG', `"${alias}" names both a mailbox and an account`, {
      hint: `Rename one of them. They are ${matches.map((m) => m.id).join(' and ')}.`,
    });
  }
  return matches[0] ?? null;
}

/** The secret backend in use: the recorded one, or the keychain before anything has been stored. */
export function secretsStoreOf(config: Config): StoreKind {
  return config.secrets?.store ?? 'keychain';
}

/** True when `alias` is a valid inbox or client name. */
export function isValidAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

/** A config with nothing in it, at `version` — by default the version a new config is created at. */
export function emptyConfig(version: ConfigVersion = NEW_CONFIG_VERSION): Config {
  return schemaFor(version).parse({ version });
}

/**
 * A digest of the whole configuration, in canonical form.
 *
 * The whole thing, not the parts a caller happens to be interested in: the migration shows a preview and applies it
 * later, and anything that changed in between — a policy, a domain list, a key this release does not even know — has
 * to count as a change, or the apply writes over it.
 */
export function configFingerprint(config: Config): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The send policy that applies to an inbox: its own, else the default. */
export function effectiveSendPolicy(config: Config, inbox: string): SendPolicy {
  return config.inboxes[inbox]?.sendPolicy ?? config.defaults.sendPolicy;
}

function describeIssues(error: z.ZodError, version: ConfigVersion): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const where = issue.path.join('.') || '(root)';
      // zod reports a bad record key as "Invalid key in record"; say what a valid name looks like instead.
      if (issue.code !== 'invalid_key') return `${where}: ${issue.message}`;
      if (version === 2 && issue.path[0] !== 'clients') return `${where}: ${NAME_MESSAGE}`;
      return `${where}: ${version === 2 ? 'client' : 'inbox and client'} ${ALIAS_MESSAGE}`;
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
  if (version !== 1 && version !== 2) {
    throw new CommsError(
      'CONFIG',
      `${source} has version ${String(version)}; this release reads versions ${READABLE_CONFIG_VERSIONS.join(' and ')}`,
      {
        hint: 'Upgrade agent-communications, or restore a config written by this version.',
      },
    );
  }
  const parsed = schemaFor(version).safeParse(raw);
  if (!parsed.success) {
    throw new CommsError('CONFIG', `${source} is invalid: ${describeIssues(parsed.error, version)}`);
  }
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
      // An ordinary write keeps the version it found. Changing it is a migration — it renames every account and
      // decides which releases can still read the file — and has exactly one door, `migrateNames`.
      if ((next as { version?: unknown }).version !== current.version) {
        throw new CommsError(
          'CONFIG',
          `refusing to change the config version from ${current.version} to ${String((next as { version?: unknown }).version)}`,
          { hint: 'Only `agentcomms names migrate` changes the version. This is a bug — please report it.' },
        );
      }
      const parsed = schemaFor(current.version).safeParse(next);
      if (!parsed.success) {
        throw new CommsError(
          'CONFIG',
          `refusing to write invalid config: ${describeIssues(parsed.error, current.version)}`,
        );
      }
      if (current.version === 2 && parsed.data.version === 2) {
        const dropped = formerNamesDropped(current, parsed.data);
        if (dropped !== null) {
          throw new CommsError('CONFIG', `refusing to write a config that ${dropped}`, {
            hint: 'Former names are permanent. This is a bug — please report it.',
          });
        }
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

  /**
   * The one way a version-1 config becomes version 2.
   *
   * Under the credentials lock and then the config lock — the order everything takes them in — so it cannot land
   * between a removal's read and its write, or in the middle of moving secrets between backends.
   *
   * `expected` is the fingerprint of the config the caller previewed. The file is read again inside the locks, and
   * if it is not that config any more the whole thing is refused: somebody confirmed a mapping computed from
   * something else. Nothing waits for a person while holding a lock; the preview happens before this is called.
   *
   * `build` produces version 2 from the locked snapshot. What it may change is checked rather than trusted: the same
   * accounts, byte for byte, under new keys — a rename grants nothing, so a build that changed anything else is a
   * bug and is refused before it is written.
   *
   * Idempotent, but only for this plan. A retry after a write that committed — even one whose lock release then
   * failed — finds version 2, recognises its own mapping in it, and says so. Version 2 that does *not* carry this
   * mapping is somebody else's migration; saying "already migrated" there would report a mapping nobody applied,
   * and a caller updating registrations from it would point them at names that do not exist.
   *
   * `rows` is the plan, and the question is asked of the mapping rather than of the whole file: between a
   * committed write and its retry, something else may have changed a policy or a timezone, and a retry refused
   * over that would be idempotency in name only. The rows are checked here rather than by whoever built them,
   * for the same reason `build` is: a caller that could answer its own question could answer it wrongly.
   *
   * The file it replaces is copied beside it first — see `backUpBeforeMigration` — and the copy's path returned.
   */
  async migrateNames(
    expected: string,
    rows: readonly RenamedAccount[],
    build: (current: ConfigV1) => ConfigV2,
  ): Promise<{ status: 'migrated' | 'already-migrated'; config: ConfigV2; backup?: string }> {
    if (!namesMigrationEnabled()) {
      throw new CommsError('CONFIG', 'this release reads version 2 of the config but does not write it', {
        hint: 'Names are migrated by a later release, once every program that shares this config can read the result.',
      });
    }
    return withCredentialsLock(dirname(this.path), () =>
      withFileLock(this.#lockPath, async () => {
        this.#cache = null;
        /*
         * The bytes, not only the parsed config: they are what the backup copies, and the fingerprint below is
         * taken of exactly them. Loading and then reading the file a second time for the copy would leave a gap
         * between the two reads, and a backup that is not quite the file that was replaced.
         */
        const raw = await readFileIfExists(this.path);
        const current = raw === null ? emptyConfig() : parseConfig(raw, this.path);
        if (current.version === 2) {
          if (!migrationApplied(current, rows)) {
            throw new CommsError('TRANSIENT', 'the names were migrated while this ran, and not to these names', {
              hint: 'Run `agentcomms names migrate` again to see what they are called now.',
            });
          }
          return { status: 'already-migrated' as const, config: current };
        }
        if (configFingerprint(current) !== expected) {
          throw new CommsError('TRANSIENT', 'the configuration changed after the preview was made', {
            hint: 'Run `agentcomms names migrate` again to see the mapping for the configuration as it is now.',
          });
        }
        const parsed = configV2Schema.safeParse(build(structuredClone(current)));
        if (!parsed.success) {
          throw new CommsError('CONFIG', `refusing to write invalid config: ${describeIssues(parsed.error, 2)}`);
        }
        const unchanged = onlyKeysRenamed(current, parsed.data);
        if (unchanged !== null) {
          throw new CommsError('CONFIG', `refusing a migration that changes more than names: ${unchanged}`, {
            hint: 'This is a bug — please report it.',
          });
        }
        /*
         * And that it is the mapping this call was given.
         *
         * `onlyKeysRenamed` proves that *a* rename happened and nothing else; it does not compare it to the rows.
         * Without this, the rows and the transform could disagree — the caller would show one mapping and write
         * another — and a retry would then measure itself against a plan that was never applied. The same check
         * decides both branches, so what counts as this migration cannot drift between writing it and recognising
         * it later.
         */
        if (!migrationApplied(parsed.data, rows)) {
          throw new CommsError('CONFIG', 'refusing a migration that is not the mapping it was given', {
            hint: 'This is a bug — please report it.',
          });
        }
        const backup = await backUpBeforeMigration(this.path, raw ?? '');
        await writeFileAtomic(this.path, `${JSON.stringify(parsed.data, null, 2)}\n`);
        this.#cache = null;
        return { status: 'migrated' as const, config: parsed.data, backup };
      }),
    );
  }
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Copies the version-1 file to `config.json.before-names-migrate-<UTC>`, owner-only, and returns its path.
 *
 * The migration cannot be undone by any command: the old names become tombstones and are refused for good. The one
 * way back — a release that cannot read version 2, or a mapping somebody regrets — is the file as it was, and until
 * now whoever wanted that had to remember to copy it by hand before running the command. Taken inside the locks,
 * after every check has passed and before the write, so it is exactly what is replaced and nothing is left behind
 * by a migration that was refused. The config holds no secret, only references to them, so the copy holds none
 * either; it is 0600 anyway, like everything else in this directory.
 *
 * Exclusive, never overwritten: a second migration in the same second (after restoring the first backup, say) gets
 * a suffix rather than replacing the only copy of the original.
 */
async function backUpBeforeMigration(path: string, raw: string): Promise<string> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  for (let attempt = 0; ; attempt += 1) {
    const target = `${path}.before-names-migrate-${stamp}${attempt === 0 ? '' : `-${attempt}`}`;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(target, 'wx', FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 99) continue;
      throw error;
    }
    try {
      await handle.writeFile(raw);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // `open`'s mode passes through the umask; this does not.
    if (process.platform !== 'win32') await chmod(target, FILE_MODE);
    return target;
  }
}

/** An own property only: a name is user input, and `map.constructor` is a function on every plain object. */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** One account's rename, as the migration planned it. */
export interface RenamedAccount {
  readonly kind: 'inbox' | 'account';
  readonly from: string;
  readonly to: string;
  readonly id: string;
}

/**
 * Whether this exact plan is the migration already in place.
 *
 * Row by row rather than by comparing whole configurations: a migration that committed and then failed to release
 * its lock is retried, and between the two something else may legitimately have changed a policy or a timezone.
 * That is not a reason to refuse the retry. What has to hold is what the plan claimed — each account under the name
 * it was given, still the same account, and the name it left behind pointing at it — and that the plan is the
 * *whole* migration, not part of one.
 *
 * The second half is what the rows alone cannot say. A plan previewed against a smaller configuration, whose rows
 * another process then happened to reproduce while migrating a larger one, would satisfy every row and still be
 * missing an account. So the flat names left behind are compared as a set: a migration of version 1 leaves exactly
 * one behind per account it renamed, because every version-1 name is flat, and a rename afterwards leaves a
 * qualified one. The sets have to be equal, and the rows may not name the same account twice — a repeated row
 * would otherwise make a subset the right size.
 *
 * Set equality, rather than provenance: nothing stops a flat former name being written another way — `update`
 * checks that existing tombstones are kept, not that new ones are earned, and a hand-edited file can hold
 * anything. An unexpected one makes this false, which refuses a retry that might have been fine. That is the
 * direction to be wrong in.
 *
 * False, then, for somebody else's mapping, for a migration of a configuration this plan never saw, for a rename
 * after this one, for an account removed since, and for an id that has moved.
 */
function migrationApplied(config: ConfigV2, rows: readonly RenamedAccount[]): boolean {
  for (const map of ['inboxes', 'accounts'] as const) {
    const kind = map === 'inboxes' ? 'inbox' : 'account';
    const planned = rows.filter((row) => row.kind === kind);
    const from = new Set(planned.map((row) => row.from));
    if (from.size !== planned.length) return false;
    const flat = Object.keys(config.formerNames[map]).filter((key) => ALIAS_PATTERN.test(key));
    if (flat.length !== from.size || !flat.every((key) => from.has(key))) return false;
    for (const row of planned) {
      const live = own(config[map] as Record<string, { id: string }>, row.to);
      const former = own(config.formerNames[map], row.from);
      if (live?.id !== row.id || former?.id !== row.id || former.name !== row.to) return false;
    }
  }
  return true;
}

/**
 * Null when every former name in `before` is still in `after`, or a description of the first that is not.
 *
 * The schema checks that no live name is a former one, but only in the config it is given — so a single write that
 * deleted a record and reused its name would pass it. This compares the two sides. A record's key is permanent. Its
 * id may change only to follow a re-authorisation, which mints a new id for the same account: from an id that has just
 * gone to one that has just arrived. Its `name` is only the fallback shown when the account has been removed, so it
 * may change freely.
 */
function formerNamesDropped(before: ConfigV2, after: ConfigV2): string | null {
  for (const map of ['inboxes', 'accounts'] as const) {
    for (const [key, record] of Object.entries(before.formerNames[map])) {
      const now = Object.hasOwn(after.formerNames[map], key) ? after.formerNames[map][key] : undefined;
      if (!now) return `forgets the former name "${key}"`;
      if (now.id === record.id) {
        // Left behind by a reauth that replaced its account: it would report a connected workspace as removed.
        if (map === 'accounts' && replacementOf(before, after, record.id)) {
          return `leaves the former name "${key}" pointing at an account a reauth just replaced`;
        }
        continue;
      }
      if (map !== 'accounts' || !followsReauth(before, after, record.id, now.id)) {
        return `points the former name "${key}" at a different account`;
      }
    }
  }
  return null;
}

/**
 * Whether `toId` replaced `fromId` in this write as a re-authorisation of the same account.
 *
 * Only accounts re-authorise under a new id — Slack's reauth stages the new credential beside the old one — so only
 * they can move a former name. The old account must have been connected before the write and gone after it; the new
 * one must be new in this write; and they must be the same person in the same workspace. Without the first
 * condition, a former name of an account removed long ago could be pointed at whatever was connected next.
 */
/** The account that replaced `fromId` in this write as its reauth, if one did. */
function replacementOf(before: ConfigV2, after: ConfigV2, fromId: string): AccountConfig | undefined {
  return Object.values(after.accounts).find((row) => followsReauth(before, after, fromId, row.id));
}

function followsReauth(before: ConfigV2, after: ConfigV2, fromId: string, toId: string): boolean {
  const was = Object.values(before.accounts).find((row) => row.id === fromId);
  const now = Object.values(after.accounts).find((row) => row.id === toId);
  if (!was || !now) return false;
  if (Object.values(after.accounts).some((row) => row.id === fromId)) return false;
  if (Object.values(before.accounts).some((row) => row.id === toId)) return false;
  return was.platform === now.platform && was.workspace === now.workspace && was.userId === now.userId;
}

/**
 * Null when `after` is `before` with only account keys changed — plus the version, and exactly one record of each
 * former name naming where it went — or a description of the first other difference.
 */
function onlyKeysRenamed(before: ConfigV1, after: ConfigV2): string | null {
  for (const map of ['inboxes', 'accounts'] as const) {
    const was = new Map(Object.values(before[map]).map((row) => [row.id, canonicalJson(row)]));
    const now = Object.values(after[map]);
    if (now.length !== was.size) return `the number of ${map} changed`;
    for (const row of now) {
      if (was.get(row.id) !== canonicalJson(row)) return `${map} row ${row.id} changed`;
    }
    // Every old key recorded once, pointing at the key its account has now — no forgeries, no omissions, no extras.
    const keyOf = new Map(Object.entries(after[map]).map(([key, row]) => [row.id, key]));
    const records = after.formerNames[map];
    if (Object.keys(records).length !== Object.keys(before[map]).length)
      return `the former ${map} are not one per name`;
    for (const [alias, row] of Object.entries(before[map])) {
      const record = Object.hasOwn(records, alias) ? records[alias] : undefined;
      if (!record || record.id !== row.id || record.name !== keyOf.get(row.id)) {
        return `the former name "${alias}" is wrong`;
      }
    }
  }
  const { version: _v1, inboxes: _i1, accounts: _a1, ...restBefore } = before;
  const { version: _v2, inboxes: _i2, accounts: _a2, formerNames: _f, ...restAfter } = after;
  return canonicalJson(restBefore) === canonicalJson(restAfter) ? null : 'a setting other than a name changed';
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
    Object.values(config.inboxes).some((inbox) => Boolean(inbox.secretRef)) ||
    // Accounts hold secret references too. Left out, a configuration whose only secrets were Slack tokens counted
    // as holding none, and the silent move off the keychain that this check exists to catch was not a downgrade.
    Object.values(config.accounts).some((account) => Boolean(account.secretRef))
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
  // The same rule for non-mail accounts. Without this loop, moving `accounts.acme.sendPolicy` from `never` to
  // `chat` classified as no change at all and `ConfigStore.update` took it without asking anyone — a loosening that
  // walks straight through the gate built to catch exactly that.
  for (const [alias, account] of Object.entries(after.accounts)) {
    /*
     * The same person in the same workspace under this name — not merely whatever held the name.
     *
     * Matching by alias alone was the first fix for id rotation, and it over-reached: replacing workspace A with
     * an unrelated workspace B under the same alias read as B loosening A's policy, which is a finding about a
     * workspace B never had. A reauth keeps the platform, the workspace and the user; a replacement does not.
     */
    const sameAccount = (held: AccountConfig | undefined): AccountConfig | undefined =>
      held &&
      held.platform === account.platform &&
      held.workspace === account.workspace &&
      held.userId === account.userId
        ? held
        : undefined;
    /*
     * Under this name first, then under any name.
     *
     * A reauth and a rename can land in one write — the migration renames every key, and an account re-authorised
     * just before it has a new id — and a fallback that only looked under the new name would find nothing there
     * and measure the account against the default. The same person in the same workspace is the same account
     * whatever it is called.
     */
    const sameAccountUnder = (name: string): AccountConfig | undefined =>
      sameAccount(before.accounts[name]) ?? Object.values(before.accounts).find((held) => sameAccount(held));
    /*
     * By id, and failing that by alias.
     *
     * Re-authorising a Slack workspace mints a new account id on purpose, so the new credential can be staged
     * beside the old one. An id lookup alone then finds nothing and measures the renewed account against the
     * *default* — so a workspace set to `never`, re-authorised into `chat`, read as a new account arriving at the
     * default and needed nobody's consent. The alias is what the person set the policy on.
     */
    const previous =
      Object.values(before.accounts).find((existing) => existing.id === account.id) ?? sameAccountUnder(alias);
    const was = previous ? (previous.sendPolicy ?? before.defaults.sendPolicy) : before.defaults.sendPolicy;
    const now = account.sendPolicy ?? after.defaults.sendPolicy;
    if (POLICY_RANK[now] < POLICY_RANK[was]) loosened.push(`accounts.${alias}.sendPolicy`);

    /*
     * `mode` is a claim about what the stored credential can do at all, and widening it is a different kind of
     * change from the ones above.
     *
     * A workspace connected as `read` holds a token that physically cannot post — that is the guarantee, not a
     * policy sitting in front of a token that could. Re-authorising it as `send` replaces the token with one that
     * can, and nothing downstream can undo that: the send gate governs whether this package posts, while the mode
     * governs whether posting is possible at all.
     *
     * **Matched by alias, not by id.** Re-authorising mints a new account id precisely so the new credential can
     * be staged beside the old one, so an id lookup finds nothing and would read every renewal as a brand-new
     * account — which is exactly the case this must not miss.
     *
     * **A new account arriving as `send` is a widening too.** This once read "choosing `send` when connecting is the
     * decision itself" — true of a person, but the decision is exactly the one an agent may not make, and treating
     * it as free left `workspace remove` then `workspace add --mode send` as a way to a posting token with nobody's
     * consent. Measured against nothing, a new account's floor is `read`.
     */
    const wasMode = previous ? (previous.mode ?? previous.tier) : 'read';
    if (wasMode === 'read' && (account.mode ?? account.tier) === 'send') {
      loosened.push(`accounts.${alias}.mode`);
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
