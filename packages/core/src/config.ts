import { createHash, randomBytes } from 'node:crypto';
import { chmod, open, readFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { readActivitySettings, storedActivity } from './activity-settings.ts';
import {
  type AgentLabelLoosening,
  type AgentLabelRule,
  agentLabelOf,
  classifyAgentLabelChange,
} from './agent-label.ts';
import type { ChangeBinding } from './approvals.ts';
import {
  type BehaviourAct,
  type BehaviourDelta,
  behaviourAccountsOf,
  behaviourRulesMigrated,
  classifyBehaviourChange,
  type RuleRef,
  readBehaviourSettings,
} from './behaviour.ts';
import { CHANNEL_SNAPSHOT } from './channels.generated.ts';
import { CONVERSION_HOOKS, type ConversionHooks } from './config-hooks.ts';
import { type ConfigVersion, NEW_CONFIG_VERSION } from './config-version.ts';
import { changedConnectionSettings, classifyConnectionChange } from './connections.ts';
import { CommsError } from './errors.ts';
import { FILE_MODE, writeFileAtomic } from './fs.ts';
import { type CliHandoffs, handoffSentence, requiredHandoffs } from './handoff-text.ts';
import { namesItsPlace } from './jail.ts';
import { type LockOptions, withCredentialsLock, withFileLock } from './lock.ts';
import {
  NAME_MESSAGE,
  NAME_PATTERN,
  ORGANISATION_PATTERN,
  PLAIN_NAME_PATTERN,
  parseName,
  parseOrganisation,
} from './name-grammar.ts';
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
export const READABLE_CONFIG_VERSIONS: readonly ConfigVersion[] = [1, 2, 3];

export { type ConfigVersion, NEW_CONFIG_VERSION } from './config-version.ts';

export const ALIAS_PATTERN: RegExp = PLAIN_NAME_PATTERN;
const ALIAS_MESSAGE = 'names must be 1–32 lowercase letters, digits or hyphens, starting with a letter or digit';

export type SendPolicy = 'chat' | 'confirm' | 'never';
/**
 * How a loosening of the configuration is approved: `chat` — the person says yes in the conversation and the agent
 * claims the approval — or `confirm` — the person types a code at a terminal, as for a send under `confirm`.
 *
 * There is no `never`. A setting the software refused ever to loosen would leave editing the file by hand as the only
 * way to change it, and that passes no gate at all.
 */
export type ChangePolicy = 'chat' | 'confirm';
/** 0.18's switch for the daily update check: what `defaults.updates` reads from until a level is set. */
export type UpdateCheckSetting = 'on' | 'off';

/**
 * How this machine updates (design 2026-10-16, U2), from the most updating to the least: `auto` — the default — checks
 * daily and installs in the background once its job is set up; `every-14-days` checks at most once every 14 days and
 * installs only with the person's yes; `never` asks the registry nothing.
 */
export const UPDATE_LEVELS = ['auto', 'every-14-days', 'never'] as const;
export type UpdateLevel = (typeof UPDATE_LEVELS)[number];

export function isUpdateLevel(value: unknown): value is UpdateLevel {
  return typeof value === 'string' && (UPDATE_LEVELS as readonly string[]).includes(value);
}
export type StoreKind = 'keychain' | 'file';

export interface ClientConfig {
  provider: string;
  clientId: string;
  projectId?: string | undefined;
  secretRef: string;
  addedAt: string;
  /**
   * The organisation profile that made this row and owns it (design 2026-10-02 §D4) — absent on a row a person
   * registered, or one a profile adopted. A row carrying it is the profile's to change: `org update` and `org remove`
   * change it, and `client add --replace` and `client remove` refuse it while its organisation has a record.
   *
   * Additive: client rows are loose, so a release that does not know the key keeps it through its writes.
   */
  organisation?: string | undefined;
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
  /** Overrides `defaults.changePolicy` for changes to this inbox. */
  changePolicy?: ChangePolicy | undefined;
  internalDomains: string[];
  createdAt: string;
}

export interface Defaults {
  sendPolicy: SendPolicy;
  /**
   * How a loosening is approved wherever an inbox or account does not say otherwise. Absent reads as `chat`.
   *
   * Absent rather than filled in by the schema, unlike `sendPolicy`. A config written before this setting existed
   * reads as `chat` from then on, and the release note says so; a default the schema supplied would be written into
   * the file by the next unrelated change, where it would look like a choice somebody made.
   */
  changePolicy?: ChangePolicy | undefined;
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
  /**
   * The daily update check (design 2026-09-28): once a day this machine asks npm whether a newer release is out, and
   * every server and command stops until it is updated or put off until tomorrow. Absent reads as `on`.
   *
   * Absent rather than filled in, as `changePolicy` is: a default the schema supplied would be written into the file
   * by the next unrelated change, where it would look like a choice somebody made. Turning it off is a loosening —
   * it is what keeps a machine from quietly falling behind a release — so it is approved like one; on applies at once.
   */
  updateCheck?: UpdateCheckSetting | undefined;
  /**
   * How this machine updates (design 2026-10-16, U2): `auto`, `every-14-days` or `never`. Absent reads from
   * `updateCheck` — `on` as `auto`, `off` as `never` — and both absent as `auto`. A word this release does not know
   * reads as `auto`, and the file stays readable: a later release may add a level.
   *
   * Moving to a level that updates less is a loosening, approved like one; moving back applies at once. Every write of
   * a level writes `updateCheck` beside it, `off` for `never` and `on` otherwise, so a release before 0.20 sharing the
   * file checks, or does not, as the person chose.
   */
  updates?: string | undefined;
}

/**
 * A connected account on a platform that is not mail: a Slack workspace, and every channel after it (design
 * 2026-09-26) — one generic record, whatever the platform.
 *
 * `id`, `platform`, `workspace` (the container: a Slack team, a Resend team, a WhatsApp store), `userId` (who it acts
 * as), `tier`, `mode`, `grantedScopes`, `secretRef`, the two policies and `createdAt` are every channel's. A channel
 * may keep keys of its own beside them — Slack's `appId`, `redirectPort` — and they are kept through every write. It
 * may not add a safety setting: only `sendPolicy`, `changePolicy` and `mode` are judged by `classifyChange`, so a key
 * of a channel's own that loosened something would loosen it unasked.
 *
 * `secretRef` stays required, although the 2026-09-26 contract made it optional for a channel with no credential:
 * every earlier release requires it, and they share this file — an account without one would make the whole
 * configuration unreadable to a server started last week. Such a channel records a reference that names no secret,
 * `<platform>:none:<id>`, until a config version can say otherwise.
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
  /** Where its credential is in the secret store, `<platform>:…` — for a channel that stores none, `<platform>:none:<id>`. */
  secretRef: string;
  sendPolicy?: SendPolicy | undefined;
  /** Overrides `defaults.changePolicy` for changes to this account. */
  changePolicy?: ChangePolicy | undefined;
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
  /**
   * The loopback port the last sign-in used, which is the one in the app's redirect URL.
   *
   * Slack matches redirect URLs exactly, so every later sign-in and every set of steps that edits the app has to
   * name this number. Without it the steps said `<port>`, or — from the MCP server — guessed 51234, and a person who
   * had chosen another port followed them to a sign-in that failed on the way back.
   */
  redirectPort?: number | undefined;
  /** The organisation profile whose Slack app created this account. Absent for a person's own app. */
  organisation?: string | undefined;
  /** Which app in that profile issued the account's current credential. */
  profileApp?: 'read' | 'send' | undefined;
}

export type PendingRevocationStatus = 'pending' | 'revoked' | 'expired';

/** One bearer token in a superseded rotating bundle, tracked independently from its pair. */
export interface PendingRevocationTokenState {
  status: PendingRevocationStatus;
  /** The fixed absolute time after which the old token is known to be unusable. */
  deadline: string;
}

/**
 * A superseded credential kept until each token in it is conclusively revoked or expired.
 *
 * `store` belongs to the entry rather than being inferred from `secrets.store`: an older release can move the root
 * store without knowing to move this bundle, and cleanup must still find the only copy that exists.
 */
export interface PendingRevocation {
  ref: string;
  store: StoreKind;
  platform: string;
  workspace: string;
  createdAt: string;
  tokens: {
    access: PendingRevocationTokenState;
    refresh?: PendingRevocationTokenState | undefined;
  };
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
  /** Superseded rotating credentials which still need conclusive per-token cleanup. */
  pendingRevocations?: PendingRevocation[] | undefined;
  defaults: Defaults;
  /**
   * How what an agent sends is labelled (design 2026-10-15-agent-label, L5): the word, the name, the rules that say
   * who a message appears to come from, and each Slack account's agent emoji.
   *
   * `unknown` here, on purpose: it is read only through `agentLabelOf`, which reads a value it does not understand
   * as the stricter one — an unknown word as `agent`, a rule list it cannot read as no rules — so a hand edit or a
   * later release's key can only tighten. Kept through every write as the schemas keep every key they do not name, and
   * judged by `classifyChange`.
   */
  agentLabel?: unknown;
  /**
   * What an agent may do (design 2026-10-19-agent-behaviour-rules, B3): `{ rules: [...] }`, each rule the acts allowed
   * in one account or one of its conversations.
   *
   * `unknown` here, as `agentLabel` is, and for the same reason the other way round: it is read only through
   * `readBehaviourSettings`, which reads a value it does not understand as allowing less — an unknown act dropped, a
   * rule it cannot read as its account allowing nothing — never as no rules. Kept through every write as the schemas
   * keep every key they do not name, so older releases keep it too, and judged by `classifyChange`.
   */
  behaviour?: unknown;
  /**
   * The activity log's settings (design 2026-10-25-activity §4.1): `{ record: 'on' | 'off', retentionDays: 1..365 }`,
   * on and 30 when absent.
   *
   * `unknown` here, as `agentLabel` and `behaviour` are: it is read only through `readActivitySettings`, which reads a
   * value it does not understand as recording less — off, and the fewest days — so a hand edit or a later release's
   * word can only tighten. Kept through every write as the schemas keep every key they do not name, and judged by
   * `classifyChange`: recording again and keeping more days are loosenings, off and fewer days tightenings.
   */
  activity?: unknown;
  /**
   * The MCP connections (single-server design D9): each place an app uses Agent Comms, by id — its name, app, where its
   * entry is, its parts and their pins, read-only, and its key's hash.
   *
   * `unknown` here, as `agentLabel`, `behaviour` and `activity` are: it is read only through `readConnections`, which
   * reads what it does not understand as reaching less — a part it cannot read left out, a record it cannot read serving
   * nothing — so a hand edit or a later release's word can only narrow what a connection reaches. Kept through every
   * write as the schemas keep every key they do not name, and judged by `classifyChange`: a connection or part added, a
   * pin taken away or moved, and read-only off are loosenings; the rest apply at once.
   */
  connections?: unknown;
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

/** Who an organisation's Google client is for, as its administrator states it (design 2026-10-02 §D2). */
export type OrganisationServes = 'any' | { domains: string[] };

/**
 * One Google client an organisation profile brought here: a *generation* (design 2026-10-02 §D4).
 *
 * `owned` — the profile made the client row `name` (`rgc-1`), which carries `organisation`, and its secret is the
 * profile's to rewrite. `adopted` — the row was already here under a name a person chose (they ran `client add` with
 * the organisation's file), and stays theirs: no `org` command changes or removes it. `serves` is per generation,
 * because it is a fact about one client, not about the organisation.
 */
export interface OrganisationGeneration {
  name: string;
  clientId: string;
  projectId?: string | undefined;
  ownership: 'owned' | 'adopted';
  serves: OrganisationServes;
  addedAt: string;
}

export interface OrganisationSlackApp {
  clientId: string;
  appId?: string | undefined;
}

/**
 * An organisation's update caps, as the file beside its profile names them (design 2026-10-16, U8), and the SHA-256 of
 * that file, so `org update` can tell the organisation changing them from the record drifting. A `max` word this release
 * does not know reads as `never`, the strictest it could mean: caps only ever tighten.
 */
export interface OrganisationUpdates {
  max?: string | undefined;
  background?: boolean | undefined;
  sha256: string;
}

/**
 * The organisation's bot-only agent app, as its profile's agent-app file names it (CUE-493): the app's id, and the
 * SHA-256 of that file, so `org update` can tell the organisation changing it from the record drifting. No client id:
 * nobody signs in through it — its administrator installs it once and its members paste its bot token.
 */
export interface OrganisationAgentApp {
  appId: string;
  sha256: string;
}

/**
 * What this machine records of one organisation profile: never its bytes and never its secret — where it was read
 * from, the SHA-256 of what was read and when, the generations of its Google client, and its Slack apps.
 */
export interface OrganisationRecord {
  label: string;
  /** Read again, from this absolute path, by every `org update`. `file` is the one kind version 1 knows (§D3). */
  source: { kind: string; path: string };
  sha256: string;
  readAt: string;
  addedAt: string;
  /** Whether the member asked for this organisation's client to serve addresses outside it too (§D6). */
  forOtherAddresses: boolean;
  /** `active` names the generation new mailboxes get — none once a profile stops naming a Google client. */
  gmail?: { active: string | null; generations: OrganisationGeneration[] } | undefined;
  slack?:
    | {
        workspace: string;
        workspaceName: string;
        redirectPort: number;
        apps: {
          read?: OrganisationSlackApp | undefined;
          send?: OrganisationSlackApp | undefined;
          agent?: OrganisationAgentApp | undefined;
        };
      }
    | undefined;
  /** The organisation's update caps, from the file beside its profile; absent when it names none. */
  updates?: OrganisationUpdates | undefined;
  /**
   * The entries of the profile's `extensions` this release did not know and skipped, being optional (design 2026-10-19,
   * X3): the release that first understands each, and the SHA-256 of the entry's canonical JSON — as
   * `Record<string, OrganisationIgnoredExtension>`. Kept in step with the profile. Absent when none was skipped.
   *
   * Held as the file holds it, whatever its shape, and read only through `ignoredListOf`, which keeps the well-formed
   * entries and names the rest: 0.21.0 is the first release to read it, so a shape a later release or a hand gave it
   * must never make the whole configuration unreadable, nor be dropped by an unrelated write. Losing it is safe: a
   * later release that understands an entry judges applying it by its classifier whether or not the list names it —
   * a tightening at once, anything else approved first, never a repair of drift (X4).
   */
  ignoredExtensions?: unknown;
}

/** One skipped extension, as the record keeps it (design 2026-10-19, X3). */
export interface OrganisationIgnoredExtension {
  since: string;
  sha256: string;
}

export interface ConfigV2 extends ConfigBody {
  version: 2;
  formerNames: FormerNames;
  /**
   * The organisation profiles added here, by organisation word (design 2026-10-02 §D4). Absent reads as none, and
   * stays absent until the first `org add`: a key the schema filled in would be written into every file by the next
   * unrelated change.
   */
  organisations?: Record<string, OrganisationRecord> | undefined;
}

/** What a legacy drain records of one tracked record: still open, or what became of it. */
export type LegacyDrainOutcome = 'revoked' | 'expired' | 'used' | 'failed' | 'sending' | 'unknown';

/**
 * The approvals an earlier release prepared that were still waiting, or already being sent, when this configuration
 * became version 3, and what has become of each (design 2026-10-05 §D1, "Old releases are locked out before the fence
 * is relied on").
 */
export interface LegacyDrain {
  /** When the conversion that opened the drain was written. */
  since: string;
  /**
   * Every tracked version-1 send record by id: `open` until it has an outcome — or `sending` from the start, for one an
   * earlier release was already sending when the conversion ran.
   */
  tracked: Record<string, 'open' | LegacyDrainOutcome>;
}

/** What version 3 adds to a body of either naming. */
interface Version3Fields {
  /** Each owner's send epoch by id; absent reads as 0. Raised by every write that turns its send policy to `never`. */
  sendEpochs?: Record<string, number> | undefined;
  /**
   * The standing epoch (design 2026-10-19-standing-approvals, S8); absent reads as 0. Raised by `standing off` and by
   * every write that turns a change policy from `chat` to `confirm`, and never lowered: a standing approval made under
   * an earlier one has ended.
   */
  standingEpoch?: number | undefined;
  /** Present while records from an earlier release are being retired. */
  legacyDrain?: LegacyDrain | undefined;
}

/** Version 3 over a version-1 body: one plain word per account. */
export interface ConfigV3Naming1 extends ConfigBody, Version3Fields {
  version: 3;
  naming: 1;
}

/** Version 3 over a version-2 body: `organisation/platform` names, and the names they replaced. */
export interface ConfigV3Naming2 extends Omit<ConfigV2, 'version'>, Version3Fields {
  version: 3;
  naming: 2;
}

/**
 * Version 3: the send epoch and the legacy drain (design 2026-10-05 §D1), over either naming — converted from version 1
 * or 2 without renaming anything, so its body keeps the rules of the version it came from.
 */
export type ConfigV3 = ConfigV3Naming1 | ConfigV3Naming2;

export type Config = ConfigV1 | ConfigV2 | ConfigV3;

/** A configuration whose accounts are named `organisation/platform`: version 2, or version 3 over it. */
export type NamedConfig = ConfigV2 | ConfigV3Naming2;

/** A configuration whose accounts have one plain word each: version 1, or version 3 over it. */
export type PlainConfig = ConfigV1 | ConfigV3Naming1;

/** Which naming a configuration's body has: 1 — plain words — or 2 — `organisation/platform`. */
export function namingOf(config: Config): 1 | 2 {
  return config.version === 3 ? config.naming : config.version;
}

/** Whether a configuration names its accounts `organisation/platform` (version 2, or version 3 over it). */
export function hasNames(config: Config): config is NamedConfig {
  return namingOf(config) === 2;
}

/** The committed config returned by an update; process-only commit metadata is deliberately stored out of band. */
export type ConfigUpdateResult = Config;

const COMMITTED_BEFORE_ABORT = new WeakSet<object>();

/** True only for the exact update result whose cancellation arrived after its atomic rename. */
export function configCommittedBeforeAbort(config: ConfigUpdateResult): boolean {
  return COMMITTED_BEFORE_ABORT.has(config);
}

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
const changePolicySchema = z.enum(['chat', 'confirm']);
const storeKindSchema = z.enum(['keychain', 'file']);

const clientSchema = z.looseObject({
  provider: z.string().min(1),
  clientId: z.string().min(1),
  projectId: z.string().optional(),
  secretRef: z.string().min(1),
  addedAt: z.string(),
  // Any string, not the organisation grammar: a marker nothing here would write is drift for `doctor` to report and
  // `org update` to clear, never a reason for the whole configuration to stop being readable.
  organisation: z.string().optional(),
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
  changePolicy: changePolicySchema.optional(),
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
  changePolicy: changePolicySchema.optional(),
  createdAt: z.string(),
  oauthClientId: z.string().min(1).optional(),
  appId: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  redirectPort: z.number().int().min(1).max(65535).optional(),
  organisation: z
    .string()
    .refine((word) => parseOrganisation(word) !== null, 'an organisation is a name’s first half')
    .optional(),
  profileApp: z.enum(['read', 'send']).optional(),
});

const absoluteTimeSchema = z.iso.datetime({ offset: true });
const pendingRevocationTokenSchema = z.looseObject({
  status: z.enum(['pending', 'revoked', 'expired']),
  deadline: absoluteTimeSchema,
});
const pendingRevocationSchema = z.looseObject({
  ref: z.string().min(1),
  store: storeKindSchema,
  platform: z.string().min(1),
  workspace: z.string().min(1),
  createdAt: absoluteTimeSchema,
  tokens: z.looseObject({ access: pendingRevocationTokenSchema, refresh: pendingRevocationTokenSchema.optional() }),
});

// Loose at every level, nested objects included. `sendCaps` and `confirm` were plain objects, which strip what they do
// not know — so a key a newer release added inside them was silently dropped by the next write from an older one,
// and a change to it was invisible to the migration's fingerprint. Keeping more than before is safe for every older
// reader: it strips them, as it always has.
const defaultsSchema = z.looseObject({
  sendPolicy: sendPolicySchema.default('chat'),
  changePolicy: changePolicySchema.optional(),
  riskEscalation: z.boolean().default(true),
  sendCaps: z
    .looseObject({ perHour: z.number().int().min(0).default(20), perDay: z.number().int().min(0).default(100) })
    .default({ perHour: 20, perDay: 100 }),
  attachRoots: z.array(z.string()).default(['~']),
  attachDeny: z.array(z.string()).default([]),
  downloadsDir: z.string().optional(),
  timezone: z.string().default('system'),
  confirm: z.looseObject({ elicitationClients: z.array(z.string()).default([]) }).default({ elicitationClients: [] }),
  updateCheck: z.enum(['on', 'off']).optional(),
  updates: z.string().min(1).optional(),
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
/** The fields of a version-1 body, which version 3 over it shares. */
const v1BodyShape = {
  secrets: z.looseObject({ store: storeKindSchema }).optional(),
  clients: z.record(aliasSchema, clientSchema).default({}),
  inboxes: z.record(aliasSchema, inboxSchema).default({}),
  accounts: z.record(aliasSchema, accountSchema).default({}),
  pendingRevocations: z.array(pendingRevocationSchema).optional(),
  defaults: defaultsSchema.default(defaultsSchema.parse({})),
};

/**
 * Across the two maps a collision cannot be an error. A v1 invariant may not depend on old writers enforcing a rule
 * they have never heard of: 0.1.2 can rename a mailbox onto an alias this version gave an account, and it will,
 * because nothing in it can see the account. Refusing to parse the result would turn a name clash into a
 * configuration that cannot be read at all — every mailbox gone, on a file the user never touched. So a persisted
 * collision is tolerated here and reported by `aliasConflicts`, and the lookup that cannot answer refuses at the point
 * somebody asks it something ambiguous.
 */
function checkV1Body(
  config: { inboxes: Record<string, { id: string }>; accounts: Record<string, { id: string }> },
  ctx: z.RefinementCtx,
): void {
  checkWithinMaps(config, ctx);
}

export const configV1Schema: z.ZodType<ConfigV1, unknown> = z
  .looseObject({ version: z.literal(1), ...v1BodyShape })
  .superRefine(checkV1Body);

/*
 * The organisations record. Loose at every level, as the rest of the file is: a later release adds keys inside it — a
 * Slack app id learned at sign-in, a source kind that is not a file — and this one must keep them through its writes,
 * not drop them or refuse the file. The organisation is a key, so it is held to the grammar a name's first half is.
 */
const servesSchema = z.union([z.literal('any'), z.looseObject({ domains: z.array(z.string().min(1)).min(1) })]);
const generationSchema = z.looseObject({
  name: aliasSchema,
  clientId: z.string().min(1),
  projectId: z.string().optional(),
  ownership: z.enum(['owned', 'adopted']),
  serves: servesSchema,
  addedAt: z.string(),
});
const slackAppRecordSchema = z.looseObject({ clientId: z.string().min(1), appId: z.string().min(1).optional() });
const agentAppRecordSchema = z.looseObject({ appId: z.string().min(1), sha256: z.string().min(1) });
const organisationRecordSchema = z.looseObject({
  label: z.string(),
  source: z.looseObject({ kind: z.string().min(1), path: z.string().min(1) }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 is 64 lowercase hex digits'),
  readAt: z.string(),
  addedAt: z.string(),
  forOtherAddresses: z.boolean().default(false),
  gmail: z
    .looseObject({ active: aliasSchema.nullable().default(null), generations: z.array(generationSchema).default([]) })
    .optional(),
  slack: z
    .looseObject({
      workspace: z.string().min(1),
      workspaceName: z.string(),
      redirectPort: z.number().int().min(1).max(65535),
      apps: z
        .looseObject({
          read: slackAppRecordSchema.optional(),
          send: slackAppRecordSchema.optional(),
          agent: agentAppRecordSchema.optional(),
        })
        .default({}),
    })
    .optional(),
  updates: z
    .looseObject({ max: z.string().min(1).optional(), background: z.boolean().optional(), sha256: z.string().min(1) })
    .optional(),
  // Any shape: read through `ignoredListOf`, so one malformed entry never makes config.json unreadable (X3).
  ignoredExtensions: z.unknown().optional(),
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
/** The fields of a version-2 body, which version 3 over it shares. */
const v2BodyShape = {
  secrets: z.looseObject({ store: storeKindSchema }).optional(),
  // OAuth clients keep plain names. One client is shared by mailboxes across organisations, so an organisation
  // prefix on it would be wrong.
  clients: z.record(aliasSchema, clientSchema).default({}),
  inboxes: z.record(nameSchema, inboxSchema).default({}),
  accounts: z.record(nameSchema, accountSchema).default({}),
  pendingRevocations: z.array(pendingRevocationSchema).optional(),
  defaults: defaultsSchema.default(defaultsSchema.parse({})),
  formerNames: z
    .looseObject({
      inboxes: z.record(formerKeySchema, formerNameSchema).default({}),
      accounts: z.record(formerKeySchema, formerNameSchema).default({}),
    })
    .default({ inboxes: {}, accounts: {} }),
  organisations: z
    .record(z.string().regex(ORGANISATION_PATTERN, 'an organisation is a name’s first half'), organisationRecordSchema)
    .optional(),
};

function checkV2Body(config: Omit<ConfigV2, 'version'>, ctx: z.RefinementCtx): void {
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
}

export const configV2Schema: z.ZodType<ConfigV2, unknown> = z
  .looseObject({ version: z.literal(2), ...v2BodyShape })
  .superRefine(checkV2Body);

const LEGACY_DRAIN_OUTCOMES = ['revoked', 'expired', 'used', 'failed', 'sending', 'unknown'] as const;

/** What version 3 adds, loose as the rest of the file is: a later release's keys inside them are kept. */
const v3Shape = {
  sendEpochs: z.record(z.string().min(1), z.number().int().min(0)).optional(),
  standingEpoch: z.number().int().min(0).optional(),
  legacyDrain: z
    .looseObject({
      since: absoluteTimeSchema,
      tracked: z.record(z.string().min(1), z.enum(['open', ...LEGACY_DRAIN_OUTCOMES])),
    })
    .optional(),
};

/** Version 3 over a version-1 body: its body validated by version 1's own rules. */
const configV3Naming1Schema: z.ZodType<ConfigV3Naming1, unknown> = z
  .looseObject({ version: z.literal(3), naming: z.literal(1), ...v1BodyShape, ...v3Shape })
  .superRefine(checkV1Body);

/** Version 3 over a version-2 body: its body validated by version 2's own rules. */
const configV3Naming2Schema: z.ZodType<ConfigV3Naming2, unknown> = z
  .looseObject({ version: z.literal(3), naming: z.literal(2), ...v2BodyShape, ...v3Shape })
  .superRefine(checkV2Body);

/** Version 3, either naming. Loose at every level, so a key a later release adds survives this one's writes. */
export const configV3Schema: z.ZodType<ConfigV3, unknown> = z.union([configV3Naming1Schema, configV3Naming2Schema]);

function schemaFor(version: ConfigVersion, naming: unknown = 2): z.ZodType<Config, unknown> {
  if (version === 3) return naming === 1 ? configV3Naming1Schema : configV3Naming2Schema;
  return version === 2 ? configV2Schema : configV1Schema;
}

/** The schema that validates a write of `config`: its version's, and for version 3 its naming's. */
function schemaOf(config: Config): z.ZodType<Config, unknown> {
  return schemaFor(config.version, config.version === 3 ? config.naming : undefined);
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

/**
 * The backend this configuration already keeps credentials in, or null when nothing has chosen one yet.
 *
 * The recorded one — or, with nothing recorded, the keychain whenever anything already refers to a stored secret.
 * Slack uses the backend in force and never records it, so a machine with only Slack connected holds its tokens in
 * the keychain and has no `secrets` block. Reading that as "nothing chosen" let the next command that stores a secret
 * choose files and record them: nothing moved, and every Slack token was left where nothing looks any more.
 */
export function committedSecretsStore(config: Config): StoreKind | null {
  if (config.secrets) return config.secrets.store;
  return holdsSecrets(config) ? secretsStoreOf(config) : null;
}

/**
 * The backend a command that stores a secret uses: the one already committed to, or — when nothing is — the one
 * asked for, the keychain by default. `choosing` says this command is the one choosing it.
 *
 * A different backend asked for is refused, not taken: one backend holds everything here, and changing it has to move
 * what is already stored, which is what `agentcomms secrets migrate` does and nothing else does. The refusal names that
 * command, made by `handoffs` — the caller's, located (CUE-403).
 */
export function secretsStoreFor(
  config: Config,
  requested: StoreKind | undefined,
  handoffs: CliHandoffs,
): { store: StoreKind; choosing: boolean } {
  const committed = committedSecretsStore(config);
  if (committed === null) return { store: requested ?? 'keychain', choosing: true };
  if (requested !== undefined && requested !== committed) {
    const migrate = handoffSentence(
      handoffs.core(['secrets', 'migrate', '--to', requested]),
      (command) => `To change it, run ${command}, then run this again.`,
      { instead: 'To change it, call comms_secrets_migrate from a chat, then run this again.' },
    );
    throw new CommsError('CONFIG', `this configuration already keeps its secrets in the ${committed} store`, {
      hint: `Everything here uses one store, and changing it moves what is already stored. ${migrate}`,
    });
  }
  return { store: committed, choosing: false };
}

/** True when `alias` is a valid inbox or client name. */
export function isValidAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

/** A config with nothing in it, at `version` — by default the version a new config is created at. */
export function emptyConfig(version: ConfigVersion = NEW_CONFIG_VERSION): Config {
  return schemaFor(version).parse(version === 3 ? { version, naming: 2 } : { version });
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

/**
 * The send policy that applies to an account in `accounts` — a Slack workspace, and every channel after it — by name:
 * its own, else the default. Slack worked this out for itself, and a second channel would have been a third copy.
 */
export function effectiveAccountSendPolicy(config: Config, account: string): SendPolicy {
  return own(config.accounts, account)?.sendPolicy ?? config.defaults.sendPolicy;
}

/** The change policy that applies where nothing overrides it: the default, and `chat` when none is set. */
export function defaultChangePolicy(config: Config): ChangePolicy {
  return config.defaults.changePolicy ?? 'chat';
}

/**
 * The change policy that governs a change, as `config` stands: the strictest of the policies over everything the change
 * touches.
 *
 * The inbox or account it is about, and every inbox or account whose setting it loosens, each by its own policy or
 * the default — and the default itself for a setting of the whole configuration, or for an account the change
 * connects, which has no policy of its own until it exists. The strictest, because a change that loosens two things
 * is approved the way the more careful of them asks.
 *
 * Accounts are found by id, the one measured on the before side, so a rename in the same change cannot move a
 * loosening out from under the policy that was meant to govern it.
 */
export function governingChangePolicy(
  config: Config,
  change: Pick<ChangeBinding, 'target' | 'loosened'>,
): ChangePolicy {
  const byId = (id: string | undefined): ChangePolicy => {
    const entry =
      id === undefined
        ? undefined
        : (Object.values(config.inboxes).find((inbox) => inbox.id === id) ??
          Object.values(config.accounts).find((account) => account.id === id));
    return entry?.changePolicy ?? defaultChangePolicy(config);
  };
  // A setting of the whole configuration carries no id, and so is governed by the default — as is a new account.
  const governing = [byId(change.target?.id), ...change.loosened.map((loosening) => byId(loosening.id))];
  return governing.includes('confirm') ? 'confirm' : 'chat';
}

/** 0.18's switch, as written: `defaults.updateCheck`, absent reading as `on`. */
export function updateCheckSetting(config: Config): UpdateCheckSetting {
  return config.defaults.updateCheck ?? 'on';
}

/**
 * The level this machine's configuration sets (design 2026-10-16, U2): `defaults.updates`, else 0.18's switch read as a
 * level — `on` as `auto`, `off` as `never`. A word this release does not know reads as `auto`, the default.
 */
export function updateLevelOf(config: Config): UpdateLevel {
  const set = config.defaults.updates;
  if (set !== undefined) return isUpdateLevel(set) ? set : 'auto';
  return updateCheckSetting(config) === 'off' ? 'never' : 'auto';
}

/**
 * How much a level updates, for `classifyChange`: `auto` 2, `every-14-days` 1, `never` 0. A word this release does not
 * know is judged as the most updating on the side it leaves and the least on the side it arrives on, as an account's
 * mode is — an unknown word can cost a person a question, never skip one.
 */
function updateRank(config: Config, side: 'before' | 'after'): number {
  const set = config.defaults.updates;
  const level = set === undefined ? updateLevelOf(config) : isUpdateLevel(set) ? set : null;
  if (level === null) return side === 'before' ? UPDATE_LEVELS.length - 1 : 0;
  return UPDATE_LEVELS.length - 1 - UPDATE_LEVELS.indexOf(level);
}

/**
 * The change policy that applies to an inbox or an account, by name: its own, else the default. With neither named,
 * or a name that is not connected, the default — a change to something that does not exist yet is governed by what
 * governs everything else.
 */
export function effectiveChangePolicy(config: Config, scope: { inbox?: string; account?: string } = {}): ChangePolicy {
  const entry =
    scope.inbox !== undefined
      ? own(config.inboxes, scope.inbox)
      : scope.account !== undefined
        ? own(config.accounts, scope.account)
        : undefined;
  return entry?.changePolicy ?? defaultChangePolicy(config);
}

/** `naming` is the body's: 2 for `organisation/platform` names (version 2, or version 3 over it), 1 for plain ones. */
function describeIssues(error: z.ZodError, naming: 1 | 2): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const where = issue.path.join('.') || '(root)';
      // zod reports a bad record key as "Invalid key in record"; say what a valid name looks like instead.
      if (issue.code !== 'invalid_key') return `${where}: ${issue.message}`;
      if (naming === 2 && issue.path[0] !== 'clients') return `${where}: ${NAME_MESSAGE}`;
      return `${where}: ${naming === 2 ? 'client' : 'inbox and client'} ${ALIAS_MESSAGE}`;
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
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new CommsError(
      'CONFIG',
      `${source} has version ${String(version)}; this release reads versions ${READABLE_CONFIG_VERSIONS.slice(0, -1).join(', ')} and ${READABLE_CONFIG_VERSIONS.at(-1)}`,
      {
        hint: 'Upgrade agent-communications, or restore a config written by this version.',
      },
    );
  }
  const naming = version === 3 ? (raw as { naming?: unknown }).naming : version;
  if (version === 3 && naming !== 1 && naming !== 2) {
    throw new CommsError('CONFIG', `${source} is invalid: naming: version 3 names its accounts by naming 1 or 2`);
  }
  const parsed = schemaFor(version, naming).safeParse(raw);
  if (!parsed.success) {
    throw new CommsError('CONFIG', `${source} is invalid: ${describeIssues(parsed.error, naming === 1 ? 1 : 2)}`);
  }
  return parsed.data;
}

/**
 * How a config write waits for the config lock: five seconds for each holder, thirty seconds in all.
 *
 * The lock is a queue. Every send prepare, claim and approval on every channel runs `ensureSendEpochConfig` first, and
 * while a legacy drain is open that is a config write or two per call, so an agent's parallel calls across several MCP
 * servers arrive at this lock together, each holding it for one read, check and fsynced rename (and the drain's, for a
 * list of the approvals too). Counted from when each waiter began, the lock's five seconds were a budget for the whole
 * line ahead: on the Windows runner a line of twelve writes gave up at the ninth, "another agent-communications process
 * is holding", while the lock was being handed on exactly as it should be. A holder there took about half a second, and
 * on Windows a rename alone may retry for one. Counted per holder, as Resend's throttle and Gmail's history caches count
 * theirs, a write gives up only on a holder that keeps the lock for the whole five seconds: the stuck lock the timeout is
 * for. The lock is polled rather than queued, so thirty seconds in all bounds the rest, and leaves room inside the minute
 * an MCP client waits for a tool call.
 */
const CONFIG_WRITE_LOCK: LockOptions = { timeoutPerHolder: true, maxWaitMs: 30_000 };

export class ConfigStore {
  readonly path: string;
  readonly #lockPath: string;
  readonly #handoffs: CliHandoffs | undefined;
  readonly #hooks: ConversionHooks | undefined;
  #cache: { key: string; config: Config } | null = null;

  /**
   * @param options.handoffs the printing package's handoffs (`core.handoffs`, CUE-403), for the command a refusal
   *   names; left out, a refusal that has to name one is a programming error (`requiredHandoffs`).
   */
  constructor(
    configDir: string,
    options: {
      readonly handoffs?: CliHandoffs | undefined;
      /** Test-only pauses inside the version-3 conversion (`config-hooks.ts`); unreachable from the package root. */
      readonly [CONVERSION_HOOKS]?: ConversionHooks | undefined;
    } = {},
  ) {
    this.path = join(configDir, 'config.json');
    // The lock sits next to the file it guards, so an overridden state directory cannot split it.
    this.#lockPath = join(configDir, '.config.lock');
    this.#handoffs = options.handoffs;
    this.#hooks = options[CONVERSION_HOOKS];
  }

  /** "Run the names migration again", as core's command — located from whatever is printing — or the tool. */
  #namesMigrateAgain(why: string): string {
    return handoffSentence(
      requiredHandoffs(this.#handoffs).core(['names', 'migrate']),
      (command) => `Run ${command} again ${why}.`,
      { instead: `Call comms_names_migrate again ${why}.` },
    );
  }

  /** Runs `fn` holding the config lock, waited for as a write waits for it (`CONFIG_WRITE_LOCK`). */
  #withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.#lockPath, fn, CONFIG_WRITE_LOCK);
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
    options: { consent?: LooseningConsent; signal?: AbortSignal | undefined } = {},
  ): Promise<ConfigUpdateResult> {
    /*
     * Cancellation is opt-in, and the atomic rename is the commit point. `writeFileAtomic` checks the signal under
     * this lock immediately before each rename attempt. Before that point it removes its temporary file and the old
     * config remains; after it, the new config is final and must never be replaced with an earlier snapshot.
     */
    let committed: ConfigUpdateResult | undefined;
    let result: ConfigUpdateResult;
    try {
      result = await this.#withWriteLock(async () => {
        options.signal?.throwIfAborted();
        this.#cache = null;
        const current = structuredClone(await this.load());
        const next = await mutator(structuredClone(current));
        // An ordinary write keeps the version it found, and its naming. Changing either is a migration — renaming
        // every account, or deciding which releases can still read the file — and each has exactly one door:
        // `migrateNames`, and `convertToVersion3`.
        if ((next as { version?: unknown }).version !== current.version) {
          throw new CommsError(
            'CONFIG',
            `refusing to change the config version from ${current.version} to ${String((next as { version?: unknown }).version)}`,
            {
              hint: 'Only the names migration and the version-3 conversion change it. This is a bug — please report it.',
            },
          );
        }
        if (current.version === 3 && (next as { naming?: unknown }).naming !== current.naming) {
          throw new CommsError('CONFIG', 'refusing to change how the configuration names its accounts', {
            hint: 'Only the names migration changes it. This is a bug — please report it.',
          });
        }
        const parsed = schemaOf(current).safeParse(next);
        if (!parsed.success) {
          throw new CommsError(
            'CONFIG',
            `refusing to write invalid config: ${describeIssues(parsed.error, namingOf(current))}`,
          );
        }
        if (hasNames(current) && hasNames(parsed.data)) {
          const dropped = formerNamesDropped(current, parsed.data);
          if (dropped !== null) {
            throw new CommsError('CONFIG', `refusing to write a config that ${dropped}`, {
              hint: 'Former names are permanent. This is a bug — please report it.',
            });
          }
        }
        const { loosened, changes } = classifyChange(current, parsed.data);
        const allowed = new Set(options.consent?.paths ?? []);
        const unconsented = loosened.filter((path) => !allowed.has(path));
        if (unconsented.length > 0) {
          /*
           * Both routes, because both are real (design 2026-09-25 §3.2): a hint naming only the terminal sent an agent
           * to a shell it may not have, for a change it could have asked for in the conversation.
           */
          throw new CommsError('LOOSENING_REFUSED', `this change loosens a safety setting: ${unconsented.join(', ')}`, {
            hint: 'A person approves a loosening, from a chat or at a terminal. From a chat, the tool that makes the change returns a preview and an approval id: the person says yes in the chat (change policy `chat`) or runs the approve command the result gives at their own terminal (`confirm`), and the tool is called again with the id. At a terminal, run the matching command and approve the change it shows.',
            details: { paths: unconsented },
          });
        }
        /*
         * A consent from a change approval says what each path was approved to move between, and the write has to be
         * that. Checked here, against the configuration read inside the lock, because this is the one place nothing
         * can change between the check and the write: a claim checks the change the caller described, and the
         * configuration may have moved since — a path now loosened from a different value, or an account that is not
         * the one the person was shown.
         */
        const approved = options.consent?.changes;
        if (approved !== undefined) {
          const drifted = changes.filter((change) => !approved.some((ok) => sameLoosening(ok, change)));
          if (drifted.length > 0) {
            const paths = drifted.map((change) => change.path);
            throw new CommsError('LOOSENING_REFUSED', `this is not the change that was approved: ${paths.join(', ')}`, {
              hint: 'The configuration changed after the approval was given. Prepare the change again and ask again.',
              details: { paths },
            });
          }
        }
        // The send epoch (design 2026-10-05 §D1), last, once the write is otherwise allowed: on version 3, raised for
        // every owner this write turns to `never`, and never lowered; before it, no send policy of an existing owner
        // moves at all.
        // The standing epoch beside it (design 2026-10-19-standing-approvals, S8): raised by any tighter change policy,
        // and never lowered, in this same write.
        const written = withStandingEpoch(current, withSendEpochs(current, parsed.data));
        const serialized = `${JSON.stringify(written, null, 2)}\n`;
        await writeFileAtomic(this.path, serialized, FILE_MODE, options.signal);
        committed = written;
        this.#cache = null;
        return written;
      });
    } catch (error) {
      if (!options.signal?.aborted || !committed) throw error;
      // The rename committed. Even if lock cleanup could not report success, cancellation cannot turn that durable
      // write back into a failed transaction: the caller needs the committed result so it keeps the staged secret.
      result = committed;
    }
    if (options.signal?.aborted) {
      // Out-of-band process metadata keeps loose-root compatibility: no unknown config key is read, changed or hidden.
      COMMITTED_BEFORE_ABORT.add(result);
    }
    return result;
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
    build: (current: PlainConfig) => NamedConfig,
  ): Promise<{ status: 'migrated' | 'already-migrated'; config: NamedConfig; backup?: string }> {
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
        if (hasNames(current)) {
          if (!migrationApplied(current, rows)) {
            throw new CommsError('TRANSIENT', 'the names were migrated while this ran, and not to these names', {
              hint: this.#namesMigrateAgain('to see what they are called now'),
            });
          }
          return { status: 'already-migrated' as const, config: current };
        }
        if (configFingerprint(current) !== expected) {
          throw new CommsError('TRANSIENT', 'the configuration changed after the preview was made', {
            hint: this.#namesMigrateAgain('to see the mapping for the configuration as it is now'),
          });
        }
        // Version 1 becomes version 2; version 3 over version 1's names stays version 3, over version 2's. Never back.
        const target = current.version === 3 ? 3 : 2;
        const built = build(structuredClone(current));
        if (built.version !== target) {
          throw new CommsError('CONFIG', `refusing a migration that writes version ${built.version}`, {
            hint: 'This is a bug — please report it.',
          });
        }
        const parsed = (schemaFor(target, 2) as z.ZodType<NamedConfig, unknown>).safeParse(built);
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

  /**
   * The one way a configuration becomes version 3 (design 2026-10-05 §D1, "Old releases are locked out before the
   * fence is relied on").
   *
   * Version 3 carries the send epoch, which 0.13 does not know, and 0.13 refuses to read it — so from this write on, no
   * 0.13 process can start a prepare, a claim, an approval or a policy change through this file. Nothing is renamed:
   * a version-1 body stays version 1's (`naming: 1`) until the names migration, which needs its own approval.
   *
   * Under the config lock, the file is read again — never from the cache, never from the read before the lock — and an
   * existing version 3 returned unchanged: a second converter that lost the race keeps the winner's epochs and drain.
   * `scan` runs under the same lock, so a record written while this waited for it is seen, and an update cannot land
   * between the scan and the write; the version-3 write carries `legacyDrain` only when the scan tracked something.
   * With no config file at all there is nothing to convert, and nothing is written.
   */
  async convertToVersion3(
    scan: () => Promise<LegacyDrain['tracked']>,
    options: { now?: (() => Date) | undefined } = {},
  ): Promise<{ status: 'converted' | 'already' | 'empty'; config: Config }> {
    // Most calls find version 3 already, and need no lock.
    const seen = await this.load();
    if (seen.version === 3) return { status: 'already', config: seen };
    await this.#hooks?.beforeLock?.();
    return withFileLock(this.#lockPath, async () => {
      this.#cache = null;
      const raw = await readFileIfExists(this.path);
      if (raw === null) return { status: 'empty' as const, config: emptyConfig() };
      const current = parseConfig(raw, this.path);
      if (current.version === 3) return { status: 'already' as const, config: current };
      const tracked = await scan();
      await this.#hooks?.afterScan?.();
      const since = (options.now?.() ?? new Date()).toISOString();
      const converted = {
        ...current,
        version: 3,
        naming: current.version,
        ...(Object.keys(tracked).length > 0 ? { legacyDrain: { since, tracked } } : {}),
      };
      const parsed = schemaFor(3, current.version).safeParse(converted);
      if (!parsed.success) {
        throw new CommsError(
          'CONFIG',
          `refusing to write invalid config: ${describeIssues(parsed.error, current.version)}`,
          { hint: 'This is a bug — please report it.' },
        );
      }
      await this.#hooks?.beforeWrite?.();
      await writeFileAtomic(this.path, `${JSON.stringify(parsed.data, null, 2)}\n`);
      this.#cache = null;
      return { status: 'converted' as const, config: parsed.data };
    });
  }
}

/**
 * Each owner's effective send policy, by id: a mailbox's own or the default, an account's own or the default.
 *
 * By id, because a name can change within one write and a policy must be compared for the same owner.
 */
function sendPoliciesById(config: Config): Map<string, SendPolicy> {
  const policies = new Map<string, SendPolicy>();
  for (const [alias, inbox] of Object.entries(config.inboxes))
    policies.set(inbox.id, effectiveSendPolicy(config, alias));
  for (const [name, account] of Object.entries(config.accounts)) {
    policies.set(account.id, effectiveAccountSendPolicy(config, name));
  }
  return policies;
}

/**
 * The owners this write turns to `never`: each one there before and after whose effective send policy was not `never`
 * and is now — by its own setting, or by the default it inherits.
 */
export function fencedOwners(before: Config, after: Config): string[] {
  const was = sendPoliciesById(before);
  return [...sendPoliciesById(after)]
    .filter(([id, policy]) => policy === 'never' && was.has(id) && was.get(id) !== 'never')
    .map(([id]) => id);
}

/** Whether this write makes any send policy looser: an owner's effective one, or the default. */
function loosensASendPolicy(before: Config, after: Config): boolean {
  const was = sendPoliciesById(before);
  for (const [id, policy] of sendPoliciesById(after)) {
    const earlier = was.get(id);
    if (earlier !== undefined && POLICY_RANK[policy] < POLICY_RANK[earlier]) return true;
  }
  return POLICY_RANK[after.defaults.sendPolicy] < POLICY_RANK[before.defaults.sendPolicy];
}

/**
 * `after`, with the send epochs this write owes (design 2026-10-05 §D1, "`never` revokes; loosening revives nothing").
 *
 * On version 3: every owner this write turns to `never` gets its epoch raised by one, in this same atomic write, and
 * no epoch is ever lowered — whatever the write's own copy says. While a legacy drain is open no send policy may be
 * loosened at all, so a revocation that failed cannot be followed by `never → chat`.
 *
 * Before version 3 there is no epoch, so no write may move an existing owner's send policy: every writer that does
 * converts first (`ensureSendEpochConfig`), and one that did not would skip the fence.
 */
function withSendEpochs(before: Config, after: Config): Config {
  if (before.version !== 3 || after.version !== 3) {
    const was = sendPoliciesById(before);
    const moved = [...sendPoliciesById(after)].some(([id, policy]) => was.has(id) && was.get(id) !== policy);
    if (moved) {
      throw new CommsError('CONFIG', 'refusing to change a send policy before the configuration is version 3', {
        hint: 'A send policy is changed only with its send epoch, on version 3. This is a bug — please report it.',
      });
    }
    return after;
  }
  if ((before.legacyDrain !== undefined || after.legacyDrain !== undefined) && loosensASendPolicy(before, after)) {
    throw new CommsError(
      'TRANSIENT',
      'records from an earlier release are still being retired, so no send policy can be loosened yet',
      {
        hint: 'Try again in a few minutes: until every approval an earlier release prepared is retired, a looser policy could let one through.',
      },
    );
  }
  const epochs: Record<string, number> = {};
  for (const [id, epoch] of Object.entries(before.sendEpochs ?? {})) epochs[id] = epoch;
  // Never lowered, whatever the write's own copy says.
  for (const [id, epoch] of Object.entries(after.sendEpochs ?? {})) epochs[id] = Math.max(epochs[id] ?? 0, epoch);
  for (const id of fencedOwners(before, after)) epochs[id] = (before.sendEpochs?.[id] ?? 0) + 1;
  return Object.keys(epochs).length === 0 ? after : { ...after, sendEpochs: epochs };
}

/**
 * The standing epoch in `config` (design 2026-10-19-standing-approvals, S8): its stored value, or 0 when it has none —
 * or when it is not a whole number of 0 or more, which no write of this release leaves.
 */
export function standingEpochOf(config: Config): number {
  const epoch = (config as { standingEpoch?: unknown }).standingEpoch;
  return typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0 ? epoch : 0;
}

/** The change policy of every inbox and account by id, each its own or the default. */
function changePoliciesById(config: Config): Map<string, ChangePolicy> {
  const policies = new Map<string, ChangePolicy>();
  for (const inbox of Object.values(config.inboxes))
    policies.set(inbox.id, inbox.changePolicy ?? defaultChangePolicy(config));
  for (const account of Object.values(config.accounts)) {
    policies.set(account.id, account.changePolicy ?? defaultChangePolicy(config));
  }
  return policies;
}

/**
 * Whether this write turns a change policy from `chat` to `confirm`: the default's, or the effective one of an inbox or
 * account there before and after, by id.
 */
function tightensAChangePolicy(before: Config, after: Config): boolean {
  if (defaultChangePolicy(before) === 'chat' && defaultChangePolicy(after) === 'confirm') return true;
  const was = changePoliciesById(before);
  for (const [id, policy] of changePoliciesById(after)) {
    if (policy === 'confirm' && was.get(id) === 'chat') return true;
  }
  return false;
}

/**
 * `after`, with the standing epoch this write owes (design 2026-10-19-standing-approvals, S8): on version 3, the higher
 * of the two it holds — never lowered, whatever the write's own copy says, nor dropped — and one more when it tightens a
 * change policy (`tightensAChangePolicy`). Before version 3 there is no epoch, and no standing approval: every one is
 * made on version 3.
 */
function withStandingEpoch(before: Config, after: Config): Config {
  if (before.version !== 3 || after.version !== 3) return after;
  const held = Math.max(standingEpochOf(before), standingEpochOf(after));
  const kept = tightensAChangePolicy(before, after) ? held + 1 : held;
  return kept === 0 && after.standingEpoch === undefined ? after : { ...after, standingEpoch: kept };
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
function migrationApplied(config: NamedConfig, rows: readonly RenamedAccount[]): boolean {
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
 * id may change only to follow a re-authorisation that minted a new id for the same account — Slack's did before it
 * kept the id, and a release of that age sharing this configuration still does: from an id that has just gone to one
 * that has just arrived. Its `name` is only the fallback shown when the account has been removed, so it may change
 * freely.
 */
function formerNamesDropped(before: NamedConfig, after: NamedConfig): string | null {
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
 * Only accounts ever re-authorised under a new id — Slack's reauth once did, to stage the new credential beside the
 * old one, and an older release still does — so only they can move a former name. The old account must have been connected before the write and gone after it; the new
 * one must be new in this write; and they must be the same person in the same workspace. Without the first
 * condition, a former name of an account removed long ago could be pointed at whatever was connected next.
 */
/** The account that replaced `fromId` in this write as its reauth, if one did. */
function replacementOf(before: NamedConfig, after: NamedConfig, fromId: string): AccountConfig | undefined {
  return Object.values(after.accounts).find((row) => followsReauth(before, after, fromId, row.id));
}

function followsReauth(before: NamedConfig, after: NamedConfig, fromId: string, toId: string): boolean {
  const was = Object.values(before.accounts).find((row) => row.id === fromId);
  const now = Object.values(after.accounts).find((row) => row.id === toId);
  if (!was || !now) return false;
  if (Object.values(after.accounts).some((row) => row.id === fromId)) return false;
  if (Object.values(before.accounts).some((row) => row.id === toId)) return false;
  return was.platform === now.platform && was.workspace === now.workspace && was.userId === now.userId;
}

/**
 * Null when `after` is `before` with only account keys changed — plus the version, exactly one record of each former
 * name naming where it went, and the behaviour rules that held an account by its old name holding it by its new one
 * (`behaviourRulesMigrated`) — or a description of the first other difference.
 */
function onlyKeysRenamed(before: PlainConfig, after: NamedConfig): string | null {
  const renames: { from: string; to: string; id: string }[] = [];
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
      renames.push({ from: alias, to: record.name, id: row.id });
    }
  }
  if (canonicalJson(behaviourRulesMigrated(before, renames) ?? null) !== canonicalJson(after.behaviour ?? null)) {
    return 'the behaviour rules changed other than by the names';
  }
  const {
    version: _v1,
    inboxes: _i1,
    accounts: _a1,
    naming: _n1,
    behaviour: _b1,
    ...restBefore
  } = before as PlainConfig & {
    naming?: unknown;
  };
  const {
    version: _v2,
    inboxes: _i2,
    accounts: _a2,
    formerNames: _f,
    naming: _n2,
    behaviour: _b2,
    ...restAfter
  } = after as NamedConfig & { naming?: unknown };
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
  return comparablePath(resolve(expandHome(path.trim(), homedir())));
}

/**
 * An absolute path in the form two paths are compared in here: no trailing separator, and case folded on macOS and
 * Windows, whose filesystems are case-insensitive by default (see `normalisePath`). The top of a disk keeps its
 * separator — `/`, `C:\` — so it is not read as no path at all.
 */
export function comparablePath(absolute: string): string {
  const stripped = withoutTrailingSeparators(absolute);
  const kept = stripped === '' || /^[A-Za-z]:$/.test(stripped) ? absolute.slice(0, stripped.length + 1) : stripped;
  return platform() === 'darwin' || platform() === 'win32' ? kept.toLowerCase() : kept;
}

/**
 * The path with any separators at its end removed. A loop, not `/[/\\]+$/`: that pattern backtracks over every run of
 * separators in the string, and the path comes from a configuration anybody can write.
 */
function withoutTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1;
  return path.slice(0, end);
}

/** Whether anything in this configuration already points at a stored secret. */
function holdsSecrets(config: Config): boolean {
  return (
    Object.values(config.clients).some((client) => Boolean(client.secretRef)) ||
    Object.values(config.inboxes).some((inbox) => Boolean(inbox.secretRef)) ||
    // Accounts hold secret references too. Left out, a configuration whose only secrets were Slack tokens counted
    // as holding none, and the silent move off the keychain that this check exists to catch was not a downgrade.
    Object.values(config.accounts).some((account) => Boolean(account.secretRef)) ||
    (config.pendingRevocations?.some((entry) => Boolean(entry.ref)) ?? false)
  );
}

/**
 * True when `candidate` is the same directory as `parent`, or inside it. Both may be unset. Both are compared as
 * written, so both have to be in one form first: `normalisePath`, or `comparablePath` of a real path. A parent that is
 * the top of a disk — `/`, `c:\` — holds everything on it.
 */
export function isInsideDirectory(candidate: string | undefined, parent: string | undefined): boolean {
  if (!candidate || !parent) return false;
  if (parent.endsWith('/') || parent.endsWith('\\')) return candidate.startsWith(parent);
  return candidate === parent || candidate.startsWith(`${parent}/`) || candidate.startsWith(`${parent}\\`);
}

/** A value a loosened setting had or will have: a policy, a mode, a list, a pair of caps, a path, or nothing. */
export type SettingValue = string | number | boolean | readonly string[] | { readonly [key: string]: unknown } | null;

/**
 * One loosened setting, with the values the classifier compared.
 *
 * The values are the ones it judged, not the raw fields: an inbox that inherits a looser default reports the policy
 * it inherits, and a new inbox reports the default it was measured against. A preview built from anything else could
 * show a person one change while the classifier judged another.
 */
export interface Loosening {
  /** As `ConfigStore.update` names it in a refusal: `accounts.rgc/slack.mode`, `defaults.sendPolicy`. */
  readonly path: string;
  readonly before: SettingValue;
  readonly after: SettingValue;
  /**
   * The inbox or account measured on the before side, by id. Absent for one new in this change and for a setting
   * that belongs to the whole configuration. Carried so that an approval of this loosening cannot be spent on a
   * different account that took the same name in the meantime.
   */
  readonly id?: string | undefined;
}

/**
 * The modes an account may be in, narrow to wide: `read`, which cannot reach another person, and `send`, which can
 * once a person approves. Closed: a channel may not add a word, because a word the classifier does not know is a
 * widening it cannot judge (see `classifyChange`).
 */
export const ACCOUNT_MODES: readonly ['read', 'send'] = Object.freeze(['read', 'send'] as const);
export type AccountMode = (typeof ACCOUNT_MODES)[number];

/**
 * The platforms whose accounts live in `accounts` and whose modes this release can judge, with the modes each has —
 * read from each channel's manifest, through core's snapshot of them.
 *
 * On any other platform a mode is only a word: `read` means what Slack's token guarantees on Slack, and nothing this
 * release can vouch for anywhere else.
 */
const ACCOUNT_PLATFORM_MODES: Readonly<Record<string, readonly AccountMode[]>> = Object.freeze(
  Object.fromEntries(
    CHANNEL_SNAPSHOT.flatMap(({ manifest }) =>
      manifest.accounts?.map === 'accounts' ? [[manifest.channel, manifest.accounts.modes]] : [],
    ),
  ),
);

/** Where `mode` sits on `platform`, narrow to wide — or `Infinity` for a word or a platform this release does not know. */
function modeRank(platform: string, mode: string): number {
  const modes = Object.hasOwn(ACCOUNT_PLATFORM_MODES, platform) ? ACCOUNT_PLATFORM_MODES[platform] : undefined;
  const rank = modes ? (modes as readonly string[]).indexOf(mode) : -1;
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

/**
 * Which paths of a config change loosen a safety setting, and what each moved between. A safety setting may only be
 * loosened with a person's consent (see LooseningConsent); tightening never needs it.
 */
export function classifyChange(before: Config, after: Config): { loosened: string[]; changes: Loosening[] } {
  const changes: Loosening[] = [];
  const loosen = (path: string, was: SettingValue | undefined, now: SettingValue | undefined, id?: string): void => {
    // `null` rather than `undefined` for a value that is not set, so the value survives being written to disk and
    // read back as the same thing — an approval is bound to it.
    changes.push({ path, before: was ?? null, after: now ?? null, ...(id === undefined ? {} : { id }) });
  };
  for (const [alias, inbox] of Object.entries(after.inboxes)) {
    const previous = Object.values(before.inboxes).find((i) => i.id === inbox.id);
    // A newly added inbox is measured against the policy in force before it existed: adding one that may send more
    // freely than the default is the same loosening as relaxing an existing one, and needs the same consent.
    const was = previous ? (previous.sendPolicy ?? before.defaults.sendPolicy) : before.defaults.sendPolicy;
    const now = inbox.sendPolicy ?? after.defaults.sendPolicy;
    if (POLICY_RANK[now] < POLICY_RANK[was]) loosen(`inboxes.${alias}.sendPolicy`, was, now, previous?.id);
    // The change policy is a safety setting like the send policy, measured the same way: a new inbox against the
    // default in force before it existed, so adding one that approves its own changes in chat under a `confirm`
    // default is the loosening it would be for an existing one.
    const wasChange = previous?.changePolicy ?? defaultChangePolicy(before);
    const nowChange = inbox.changePolicy ?? defaultChangePolicy(after);
    if (POLICY_RANK[nowChange] < POLICY_RANK[wasChange]) {
      loosen(`inboxes.${alias}.changePolicy`, wasChange, nowChange, previous?.id);
    }
    // For a new inbox, its own domain is part of what it is; any *other* domain declared internal is a claim about
    // who to trust, and needs the same consent as widening an existing inbox's list.
    const ownDomain = inbox.email.slice(inbox.email.lastIndexOf('@') + 1).toLowerCase();
    const domainsBefore = previous ? previous.internalDomains : [ownDomain];
    if (inbox.internalDomains.some((domain) => !domainsBefore.includes(domain))) {
      loosen(`inboxes.${alias}.internalDomains`, domainsBefore, inbox.internalDomains, previous?.id);
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
     * Re-authorising a Slack workspace minted a new account id, to stage the new credential beside the old one —
     * this release keeps the id, and an older one sharing the configuration still mints one. An id lookup alone then
     * finds nothing and measures the renewed account against the *default* — so a workspace set to `never`,
     * re-authorised into `chat`, read as a new account arriving at the default and needed nobody's consent. The
     * alias is what the person set the policy on.
     */
    const previous =
      Object.values(before.accounts).find((existing) => existing.id === account.id) ?? sameAccountUnder(alias);
    const was = previous ? (previous.sendPolicy ?? before.defaults.sendPolicy) : before.defaults.sendPolicy;
    const now = account.sendPolicy ?? after.defaults.sendPolicy;
    if (POLICY_RANK[now] < POLICY_RANK[was]) loosen(`accounts.${alias}.sendPolicy`, was, now, previous?.id);
    // Found the same way as the send policy, across a reauth's new id, for the same reason.
    const wasChange = previous?.changePolicy ?? defaultChangePolicy(before);
    const nowChange = account.changePolicy ?? defaultChangePolicy(after);
    if (POLICY_RANK[nowChange] < POLICY_RANK[wasChange]) {
      loosen(`accounts.${alias}.changePolicy`, wasChange, nowChange, previous?.id);
    }

    /*
     * `mode` is a claim about what the stored credential can do at all, and widening it is a different kind of
     * change from the ones above.
     *
     * A workspace connected as `read` holds a token that physically cannot post — that is the guarantee, not a
     * policy sitting in front of a token that could. Re-authorising it as `send` replaces the token with one that
     * can, and nothing downstream can undo that: the send gate governs whether this package posts, while the mode
     * governs whether posting is possible at all.
     *
     * **Matched by alias, not by id.** A reauth by an older release mints a new account id to stage the new
     * credential beside the old one, so an id lookup finds nothing and would read that renewal as a brand-new
     * account — which is exactly the case this must not miss.
     *
     * **A new account arriving as `send` is a widening too.** This once read "choosing `send` when connecting is the
     * decision itself" — true of a person, but the decision is exactly the one an agent may not make, and treating
     * it as free left `workspace remove` then `workspace add --mode send` as a way to a posting token with nobody's
     * consent. Measured against nothing, a new account's floor is `read`.
     */
    /*
     * **The vocabulary is closed** (`ACCOUNT_MODES`). This once flagged exactly one move, `read` → `send`, and let
     * every other word through: a channel that stored `post` or `full`, or an account on a platform this release
     * cannot describe, widened with nobody's consent because nothing recognised the word as a widening. So a word
     * this release does not know is judged as the widest thing it could mean on the side it arrives on, and as the
     * narrowest on the side it leaves — an unknown word can cost a person a question, never skip one. An account
     * left exactly as it was moved nothing, whatever its word.
     */
    const wasMode = previous ? (previous.mode ?? previous.tier) : 'read';
    const nowMode = account.mode ?? account.tier;
    const unchanged = previous !== undefined && previous.platform === account.platform && wasMode === nowMode;
    const wasRank = previous ? modeRank(previous.platform, wasMode) : 0;
    const nowRank = modeRank(account.platform, nowMode);
    if (!unchanged && nowRank > (Number.isFinite(wasRank) ? wasRank : 0)) {
      loosen(`accounts.${alias}.mode`, wasMode, nowMode, previous?.id);
    }
  }

  const b = before.defaults;
  const a = after.defaults;
  // Checked directly as well: with no inboxes (yet), the loop above sees nothing, and the next inbox added would
  // inherit the looser default without anyone having been asked.
  if (POLICY_RANK[a.sendPolicy] < POLICY_RANK[b.sendPolicy]) loosen('defaults.sendPolicy', b.sendPolicy, a.sendPolicy);
  // The same for the change policy — and this one governs itself: moving it off `confirm` is approved under
  // `confirm`, because the policy in force before a change is the one that decides how it is approved.
  if (POLICY_RANK[defaultChangePolicy(after)] < POLICY_RANK[defaultChangePolicy(before)]) {
    loosen('defaults.changePolicy', defaultChangePolicy(before), defaultChangePolicy(after));
  }
  if (b.riskEscalation && !a.riskEscalation) loosen('defaults.riskEscalation', b.riskEscalation, a.riskEscalation);
  // A level that updates less keeps this machine behind for longer, or for good: a person agrees to that (design
  // 2026-10-16, U2). The words as written, so a preview names what was set — an unknown one too.
  // A level left exactly as it was moved nothing, whatever its word.
  const levelKept = b.updates !== undefined && b.updates === a.updates;
  if (!levelKept && updateRank(after, 'after') < updateRank(before, 'before')) {
    loosen(
      'defaults.updates',
      before.defaults.updates ?? updateLevelOf(before),
      after.defaults.updates ?? updateLevelOf(after),
    );
  } else if (updateCheckSetting(before) === 'on' && updateCheckSetting(after) === 'off') {
    // 0.18's switch off beside a level that says otherwise: what a release before 0.20 reads on this machine.
    loosen('defaults.updateCheck', updateCheckSetting(before), updateCheckSetting(after));
  }
  if (a.sendCaps.perHour > b.sendCaps.perHour || a.sendCaps.perDay > b.sendCaps.perDay)
    loosen('defaults.sendCaps', b.sendCaps, a.sendCaps);
  // Paths are compared by what they resolve to: a path written with `~` and the same path written in full are the
  // same place, and comparing them as strings would either ask for consent that is not needed or miss a change
  // that is.
  // Not `normalisePath`, which trims: a space at the end is part of a folder's name, and the jail reads `/allowed ` and
  // `/allowed` as two folders — so taking one of them off a deny list is a loosening, whichever it is.
  const roots = (list: readonly string[]) =>
    new Set(list.map((path) => comparablePath(resolve(expandHome(path, homedir())))));
  // Folders as the jail reads them: one that names no place allows nothing, so adding its proper form is a loosening.
  // Not so for deny entries, which deny however they are written.
  const readRoots = (list: readonly string[]) => roots(list.filter((root) => namesItsPlace(root)));
  const before_roots = readRoots(b.attachRoots);
  const after_deny = roots(a.attachDeny);
  if ([...readRoots(a.attachRoots)].some((root) => !before_roots.has(root))) {
    loosen('defaults.attachRoots', b.attachRoots, a.attachRoots);
  }
  if ([...roots(b.attachDeny)].some((deny) => !after_deny.has(deny))) {
    loosen('defaults.attachDeny', b.attachDeny, a.attachDeny);
  }
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
    loosen('defaults.downloadsDir', b.downloadsDir, a.downloadsDir);
  }
  if (a.confirm.elicitationClients.some((c) => !b.confirm.elicitationClients.includes(c))) {
    loosen('defaults.confirm.elicitationClients', b.confirm.elicitationClients, a.confirm.elicitationClients);
  }
  // Moving away from a recorded keychain is a downgrade, whether it names another store or erases the record so the
  // next write can name one. Choosing a store on a configuration that has never held a secret is not a downgrade —
  // it is setup, and on a machine with no keychain (a server, a container) files are the only thing that works.
  if (before.secrets?.store === 'keychain' && after.secrets?.store !== 'keychain') {
    loosen('secrets.store', before.secrets.store, after.secrets?.store);
  }
  // And the unrecorded case, which is the same downgrade wearing a different shape: with no `secrets` block the
  // effective store is the keychain (`secretsStoreOf`), so if this configuration already holds secret references,
  // naming `file` for the first time moves real secrets out of the keychain. Only a configuration with nothing
  // stored yet is setup.
  if (before.secrets === undefined && after.secrets !== undefined && after.secrets.store !== 'keychain') {
    if (holdsSecrets(before)) loosen('secrets.store', secretsStoreOf(before), after.secrets.store);
  }
  // The agent label (design 2026-10-15-agent-label, L5), read as every channel reads it: a change that could leave a
  // message unlabelled, or that changes how the label looks, waits for the person. Its values are rendered as the
  // other settings' are, so the preview shows them and the approval binds them.
  for (const loosening of classifyAgentLabelChange(agentLabelOf(before), agentLabelOf(after))) {
    loosen(
      loosening.path,
      labelSettingValue(loosening, loosening.was, before),
      labelSettingValue(loosening, loosening.now, after),
    );
  }
  // What an agent may do (design 2026-10-19-agent-behaviour-rules, B5), judged per connected account as every channel
  // decides it: a change that lets an agent do more at any level waits for the person, and one that only narrows applies
  // at once. Its values are every level the change moves, by name, so the preview shows the whole change and the
  // approval binds it.
  const behaviour = classifyBehaviourChange(readBehaviourSettings(before), readBehaviourSettings(after), {
    before: behaviourAccountsOf(before),
    after: behaviourAccountsOf(after),
  });
  if (behaviour.loosens) {
    const levels = behaviourLevels(behaviour.deltas);
    loosen('behaviour.rules', levels.before, levels.after);
  }
  // The activity log (design 2026-10-25-activity §4.1), judged by the settings in force on each side: recording again
  // and keeping more days let more be known afterwards of what agents read and sent, so a person agrees to them; off
  // and fewer days apply at once.
  const activityBefore = readActivitySettings(before);
  const activityAfter = readActivitySettings(after);
  if (activityBefore.record === 'off' && activityAfter.record === 'on') {
    loosen('activity.record', activityBefore.record, activityAfter.record);
  }
  if (activityAfter.retentionDays > activityBefore.retentionDays) {
    loosen('activity.retentionDays', activityBefore.retentionDays, activityAfter.retentionDays);
  }
  // The MCP connections (single-server design §6.2), read on each side as the gateway reads them: a connection or a
  // part added, a pin taken away or moved, read-only off. Removing, pinning, read-only on and cutting off apply at once.
  for (const loosening of classifyConnectionChange(before, after)) {
    loosen(loosening.path, loosening.before, loosening.after, loosening.id);
  }
  return { loosened: changes.map((change) => change.path), changes };
}

/** What a level allows, in a preview's words: `everything` where no rule holds, `nothing` for an empty one. */
function behaviourActsText(acts: readonly BehaviourAct[] | 'all'): string {
  return acts === 'all' ? 'everything' : acts.length === 0 ? 'nothing' : acts.join(', ');
}

/** A level by the name the person knows: the account, and its conversation — `acme/slack C0GENERAL`. */
function behaviourLevelText(scope: RuleRef): string {
  const account = scope.account === '*' ? 'any other account' : scope.account;
  return scope.conversation === undefined ? account : `${account} ${scope.conversation}`;
}

/**
 * The levels a change to the behaviour rules moves, as a loosening carries them: each level, by name, to what it
 * allowed before, and to what it allows after. Read back as `<level>: <before> → <after>` in a preview.
 */
function behaviourLevels(deltas: readonly BehaviourDelta[]): {
  before: Record<string, string>;
  after: Record<string, string>;
} {
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const delta of deltas) {
    const level = behaviourLevelText(delta.scope);
    before[level] = behaviourActsText(delta.before);
    after[level] = behaviourActsText(delta.after);
  }
  return { before, after };
}

/**
 * One label rule in words, as a preview lists it: `acme/slack in C0ACME for post/reply: me`. No comma inside, since a
 * preview joins a list of them with commas.
 */
export function agentLabelRuleText(rule: AgentLabelRule): string {
  const where = rule.conversation === undefined ? '' : ` in ${rule.conversation}`;
  const kinds = rule.kinds === undefined ? '' : ` for ${rule.kinds.join('/')}`;
  return `${rule.account}${where}${kinds}: ${rule.as}`;
}

/**
 * A label setting's value as a loosening carries it: the rules in words, the icons and the Slack styles by the name of
 * the workspace each is for, in `config` — the side the value was read from — and the rest as text.
 *
 * Icons and styles are stored by the account's id, so they follow a rename; a preview names the workspace as the person
 * knows it, `acme/slack`, never its id, which they have never seen (0.21). The ids are still what an approval binds:
 * `changedSettings` records the stored values as they are. An id that names no connected account — one removed since —
 * has no other name, and keeps its id.
 */
function labelSettingValue(loosening: AgentLabelLoosening, value: unknown, config: Config): SettingValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (loosening.path === 'agentLabel.rules') return (value as readonly AgentLabelRule[]).map(agentLabelRuleText);
  if (loosening.path === 'agentLabel.slackIcons' || loosening.path === 'agentLabel.slackStyles') {
    const accounts = connectedAccounts(config);
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, string>>).map(([id, entry]) => [
        accounts.find((account) => account.id === id)?.alias ?? id,
        entry,
      ]),
    );
  }
  return String(value);
}

/** The label settings a change can write, as the file holds them — raw, as `changedSettings` records every setting. */
const LABEL_SETTINGS = ['word', 'name', 'rules', 'slackIcons', 'slackStyles'] as const;

function storedAgentLabel(config: Config): Readonly<Record<string, unknown>> {
  const stored = config.agentLabel;
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

/**
 * One setting a change writes, from the value in the file before to the value after — whichever way it moves.
 *
 * Unlike a `Loosening`, these are the raw values, not the effective ones: `null` for a setting the file does not
 * hold, so a mailbox set to `chat` itself is told apart from one inheriting `chat`, which only the first survives a
 * later change to the default. `id` is the inbox or account measured on the before side, as for a loosening.
 */
export interface SettingChange {
  readonly path: string;
  readonly before: SettingValue;
  readonly after: SettingValue;
  readonly id?: string | undefined;
}

/** The settings of a mailbox, and of an account, that a change can write — the ones the classifier judges. */
const INBOX_SETTINGS = ['sendPolicy', 'changePolicy', 'internalDomains'] as const;
const ACCOUNT_SETTINGS = ['sendPolicy', 'changePolicy', 'mode'] as const;

/**
 * Every setting that differs between `before` and `after`, loosened or tightened: the defaults, the secret store,
 * the agent label's settings, the behaviour rules, the activity log's, and each mailbox's and account's own settings — including those of
 * one added or removed.
 *
 * What a change approval binds, beside its loosenings. A preview shows the whole change — "sends approved by never;
 * changes approved by chat" — and binding only the loosenings let a claim drop the tightening a person read, since
 * what it loosened was the same. Records that are not settings (timestamps, grants, ids, clients) are left out: they
 * are not what a person approves, and some of them are made fresh each time a change is planned.
 *
 * Mailboxes and accounts are matched by id, so a rename in the same change moves no setting.
 */
export function changedSettings(before: Config, after: Config): SettingChange[] {
  const changes: SettingChange[] = [];
  const record = (path: string, was: unknown, now: unknown, id?: string): void => {
    const from = (was ?? null) as SettingValue;
    const to = (now ?? null) as SettingValue;
    if (canonicalJson(from) === canonicalJson(to)) return;
    changes.push({ path, before: from, after: to, ...(id === undefined ? {} : { id }) });
  };
  const entries = <T extends { id: string }>(
    map: 'inboxes' | 'accounts',
    was: Record<string, T>,
    now: Record<string, T>,
    fields: readonly (keyof T & string)[],
  ): void => {
    for (const [alias, entry] of Object.entries(now)) {
      const previous = Object.values(was).find((held) => held.id === entry.id);
      for (const field of fields) record(`${map}.${alias}.${field}`, previous?.[field], entry[field], previous?.id);
    }
    for (const [alias, entry] of Object.entries(was)) {
      if (Object.values(now).some((held) => held.id === entry.id)) continue;
      for (const field of fields) record(`${map}.${alias}.${field}`, entry[field], undefined, entry.id);
    }
  };
  entries('inboxes', before.inboxes, after.inboxes, INBOX_SETTINGS);
  entries('accounts', before.accounts, after.accounts, ACCOUNT_SETTINGS);
  const defaultsBefore = before.defaults as unknown as Record<string, unknown>;
  const defaultsAfter = after.defaults as unknown as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(defaultsBefore), ...Object.keys(defaultsAfter)])].sort()) {
    record(`defaults.${key}`, defaultsBefore[key], defaultsAfter[key]);
  }
  record('secrets.store', before.secrets?.store, after.secrets?.store);
  const labelBefore = storedAgentLabel(before);
  const labelAfter = storedAgentLabel(after);
  for (const key of LABEL_SETTINGS) record(`agentLabel.${key}`, labelBefore[key], labelAfter[key]);
  record('behaviour.rules', storedBehaviourRules(before), storedBehaviourRules(after));
  record('activity.record', storedActivity(before)?.record, storedActivity(after)?.record);
  record('activity.retentionDays', storedActivity(before)?.retentionDays, storedActivity(after)?.retentionDays);
  for (const change of changedConnectionSettings(before, after)) record(change.path, change.before, change.after);
  return changes;
}

/** The behaviour rules as the file holds them — raw, ids and all, as `changedSettings` records every setting. */
function storedBehaviourRules(config: Config): unknown {
  const stored = config.behaviour;
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? (stored as { rules?: unknown }).rules
    : undefined;
}

/**
 * Proof that exactly these paths may loosen: produced by a CLI after a person at a terminal typed a challenge, or by
 * `claimChange` from a change approval a person gave.
 */
export interface LooseningConsent {
  kind: 'loosening-consent';
  paths: readonly string[];
  /**
   * What each path was approved to move between, when the consent came from a change approval.
   *
   * A terminal challenge is answered moments before the write it permits, so the paths are enough. An approval is
   * prepared first and applied later — after a sign-in, possibly minutes later — and in between the configuration
   * can move underneath it: the same path, loosened from a different value, or on a different account that took
   * the name. With these, `ConfigStore.update` refuses any loosening that is not exactly one of them.
   */
  changes?: readonly Loosening[] | undefined;
}

/**
 * A loosening in canonical form: the four fields and nothing else, an unset value as `null`.
 *
 * Only these fields, because a loosening read back from an approval on disk is whatever the file says, and a stray
 * key in it must neither make two identical changes differ nor let two different ones agree.
 */
export function canonicalLoosening(loosening: Loosening): string {
  return canonicalJson({
    path: loosening.path,
    before: loosening.before ?? null,
    after: loosening.after ?? null,
    id: loosening.id ?? null,
  });
}

/** Whether two loosenings are the same one: the same path, between the same values, on the same account. */
export function sameLoosening(a: Loosening, b: Loosening): boolean {
  return canonicalLoosening(a) === canonicalLoosening(b);
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
