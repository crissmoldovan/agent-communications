import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ChannelManifest } from './channel-manifest.ts';
import { CHANNEL_SNAPSHOT, SERVICE_SNAPSHOT } from './channels.generated.ts';
import { isDangerous } from './chars.ts';
import type { SettingValue } from './config.ts';

/**
 * MCP connections (single-server design §6, D9–D12): each place an app uses Agent Comms — Claude Code in every folder,
 * Claude Code in one project, Codex in another home, a manual snippet — with its name, its parts and the accounts each
 * part reaches, and a key that names it in Activity and can be replaced or cut off.
 *
 * `config.json` keeps them under `connections`, by id, a key the schemas do not name: every release sharing the file
 * keeps it through its writes, as it keeps `agentLabel`, `behaviour` and `activity`. It is read only through
 * `readConnections`, which reads what it does not understand as reaching less — a part it cannot read is dropped, a
 * record it cannot read serves nothing — so a hand edit or a later release's word can only narrow what a connection
 * reaches. `classifyChange` judges each change to them through `classifyConnectionChange`: a connection or a part
 * added, a pin taken away or moved, read-only turned off are loosenings; the rest apply at once.
 *
 * `config.ts` imports this module to judge a change, so it imports nothing that reads the configuration.
 */

/** The apps a connection is made for, as the person picks them (D18); `manual` is a snippet they paste themselves. */
export const CONNECTION_APPS: readonly [
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'gemini',
  'vscode',
  'manual',
] = Object.freeze(['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'vscode', 'manual'] as const);
export type ConnectionApp = (typeof CONNECTION_APPS)[number];

/** How the gateway starts the parts, as an entry starts a server today. */
export const CONNECTION_LAUNCHERS: readonly ['managed', 'npx', 'local'] = Object.freeze([
  'managed',
  'npx',
  'local',
] as const);
export type ConnectionLauncher = (typeof CONNECTION_LAUNCHERS)[number];

/** `cn_` and 26 characters of the approval ids' alphabet: 130 random bits, as `ap_` ids are (`ids.ts`). */
export const CONNECTION_ID_PATTERN: RegExp = /^cn_[0-9A-HJKMNP-TV-Z]{26}$/;
/** `ack_` and 32 random bytes in base64url (D10). */
export const CONNECTION_KEY_PATTERN: RegExp = /^ack_[A-Za-z0-9_-]{43}$/;
/** The stored form of a key: its SHA-256, never the key (D10). */
export const CONNECTION_KEY_HASH_PATTERN: RegExp = /^sha256:[0-9a-f]{64}$/;

/** The environment variable a connection's entry carries its key in — never its arguments (D10). */
export const CONNECTION_KEY_ENV = 'AGENT_COMMS_CONNECTION_KEY';
/** What the gateway tells each part its connection is (D11): the id, never the key. */
export const CONNECTION_ID_ENV = 'AGENTCOMMS_CONNECTION';
/** What the gateway tells each part its own process is, so a part takes the gateway's parent as its window (D8). */
export const GATEWAY_PID_ENV = 'AGENTCOMMS_GATEWAY_PID';

/**
 * The MCP connection this process is a part of, as its gateway set it (`AGENTCOMMS_CONNECTION`, D11): its id, never
 * its key — or undefined outside any connection, and for anything there that is not a connection's id. What an audit
 * line and an approval this process writes name the connection by (single-server design §7).
 */
export function connectionOfThisProcess(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env[CONNECTION_ID_ENV];
  return id !== undefined && CONNECTION_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * Whether this process is a part of an MCP connection, started by its gateway: its instructions are then a brief of a
 * few lines that the gateway composes with the others' (D14), not its own full greeting.
 */
export function isGatewayPart(env: NodeJS.ProcessEnv): boolean {
  const raw = env[GATEWAY_PID_ENV];
  return raw !== undefined && /^[1-9][0-9]{0,9}$/.test(raw);
}

/** The most characters a connection's name has (§6.1). */
export const CONNECTION_NAME_MAX = 64;

const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new connection id. */
export function newConnectionId(): string {
  const bytes = randomBytes(26);
  let out = 'cn_';
  for (let i = 0; i < 26; i += 1) out += ID_ALPHABET[(bytes[i] ?? 0) & 31];
  return out;
}

/** A new connection key: shown once (Manual) or written into the app's entry, and kept here only as its hash. */
export function newConnectionKey(): string {
  return `ack_${randomBytes(32).toString('base64url')}`;
}

/** The hash a record keeps of a key. */
export function connectionKeyHash(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/**
 * Whether `key` is the one whose hash a record keeps, compared in constant time (D10). Anything that is not a key's
 * shape, or a hash that is not a hash's, is no match.
 */
export function connectionKeyMatches(key: unknown, keyHash: unknown): boolean {
  if (typeof key !== 'string' || !CONNECTION_KEY_PATTERN.test(key)) return false;
  if (typeof keyHash !== 'string' || !CONNECTION_KEY_HASH_PATTERN.test(keyHash)) return false;
  const given = Buffer.from(connectionKeyHash(key).slice('sha256:'.length), 'hex');
  const held = Buffer.from(keyHash.slice('sha256:'.length), 'hex');
  return given.length === held.length && timingSafeEqual(given, held);
}

/**
 * Why a connection's name cannot be used, or null when it can: 1 to 64 printable characters, no quotes, newlines,
 * control or bidi characters (the preview rule of `mcp-install.ts`): the name is shown in previews and in Activity, and
 * a name that reads as a pin, or reverses the line it sits in, is a preview that lies.
 */
export function connectionNameProblem(name: unknown): string | null {
  if (typeof name !== 'string') return 'a connection’s name is text';
  const trimmed = name.trim();
  if (trimmed === '') return 'give the connection a name: it is how you find it, and how Activity names it';
  if (trimmed !== name) return 'a connection’s name does not start or end with a space';
  if ([...name].length > CONNECTION_NAME_MAX) return `a connection’s name is at most ${CONNECTION_NAME_MAX} characters`;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (isDangerous(code) || char === '\n' || char === '\t') {
      return 'a connection’s name has no newlines, tabs, control characters or invisible ones';
    }
    if (char === '"' || char === "'" || char === '`' || char === '“' || char === '”' || char === '‘' || char === '’') {
      return 'a connection’s name has no quotation marks';
    }
  }
  return null;
}

// ── Parts ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a part is, from core's snapshot of the declarations: one declared server (D12), its tool prefix (D5), and the
 * narrowing it can be started with — a pin to one account, Gmail's read-only switch.
 */
export interface PartFacts {
  readonly server: string;
  readonly label: string;
  readonly kind: 'channel' | 'service';
  /** The prefix every one of its tools is named with, without the underscore: `comms` for core (D5). */
  readonly prefix: string;
  /** Its pin's option, when it can be pinned to one account: `inbox`, `workspace` or `account`. */
  readonly pin?: 'inbox' | 'workspace' | 'account' | undefined;
  /** Whether it can be started read-only (the manifest's `readOnly` switch: Gmail's today). */
  readonly readOnlySwitch: boolean;
  /** Where its accounts live in `config.json`, when it has any. */
  readonly accounts?: 'inboxes' | 'accounts' | undefined;
  /** What one of its accounts is called: `mailbox`, `workspace`, `account`. */
  readonly noun?: string | undefined;
}

function channelPartFacts(manifest: ChannelManifest): PartFacts {
  const pin = manifest.narrowing?.find((each) => each.kind === 'pin')?.option;
  return {
    server: manifest.channel,
    label: manifest.channel === 'core' ? 'Agent Comms itself' : manifest.label,
    kind: 'channel',
    prefix: manifest.channel === 'core' ? 'comms' : manifest.channel,
    ...(pin === 'inbox' || pin === 'workspace' || pin === 'account' ? { pin } : {}),
    readOnlySwitch: manifest.narrowing?.some((each) => each.kind === 'switch' && each.option === 'readOnly') === true,
    ...(manifest.accounts === undefined ? {} : { accounts: manifest.accounts.map, noun: manifest.accounts.noun }),
  };
}

/** Every part a connection can have, channels first and then services, in the order the gateway lists their tools. */
export const PART_FACTS: readonly PartFacts[] = Object.freeze([
  ...CHANNEL_SNAPSHOT.map((entry) => channelPartFacts(entry.manifest)),
  ...SERVICE_SNAPSHOT.map(({ declaration }) => ({
    server: declaration.server.defaultName,
    label: declaration.server.defaultName === 'events' ? 'Events' : declaration.server.defaultName,
    kind: 'service' as const,
    prefix: declaration.server.defaultName,
    readOnlySwitch: false,
  })),
]);

/** A part's facts, or undefined for a word that is no declared server of this release. */
export function partFacts(server: unknown): PartFacts | undefined {
  return typeof server === 'string' ? PART_FACTS.find((facts) => facts.server === server) : undefined;
}

// ── The record ────────────────────────────────────────────────────────────────────────────────────────────────

/** A part's pin to one account: by the account's immutable id, with the name it had when it was pinned (D12). */
export interface ConnectionPin {
  readonly id: string;
  readonly alias: string;
}

/** One part of a connection: a declared server, reaching one account or every one, read-only where it can be. */
export interface ConnectionPart {
  readonly server: string;
  readonly pin?: ConnectionPin | undefined;
  readonly readOnly?: boolean | undefined;
}

/** Where a connection's entry is (D18): user scope, or Claude Code's local scope in one folder; another profile's folder. */
export interface ConnectionWhere {
  readonly scope: 'user' | 'local';
  /** The project folder, for `local`. */
  readonly folder: string | null;
  /** Another Claude profile's `CLAUDE_CONFIG_DIR`, or another Codex home's `CODEX_HOME`. */
  readonly configDir: string | null;
}

/** What core wrote into the app's config: the entry's name and the file; null for Manual, which core writes nowhere. */
export interface ConnectionEntryRef {
  readonly name: string;
  readonly path: string | null;
}

/** The standalone entries a migration replaced with this connection, so `connection migrate --undo` can put them back. */
export interface ConnectionMigratedFrom {
  readonly at: string;
  readonly entries: readonly { readonly server: string; readonly name: string }[];
  /** Where each entry it removed was saved first, owner-only. */
  readonly backups: readonly string[];
}

/** One connection, as `config.json` keeps it under `connections[<id>]` (§6.1). */
export interface ConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly app: ConnectionApp;
  readonly where: ConnectionWhere;
  readonly entry: ConnectionEntryRef | null;
  readonly launcher: ConnectionLauncher;
  readonly parts: readonly ConnectionPart[];
  readonly keyHash: string;
  readonly keyIssuedAt: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly migratedFrom?: ConnectionMigratedFrom | undefined;
}

/** A connection as this release reads it: whole, or not readable — serving nothing — with why. */
export type ConnectionRead =
  | { readonly readable: true; readonly record: ConnectionRecord; readonly problems: readonly string[] }
  | {
      readonly readable: false;
      readonly id: string;
      readonly name: string | null;
      readonly problems: readonly string[];
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Mailbox ids are `ibx_…`, every other account's `acc_…` (`config.ts`): a pin names one by its id. */
const ACCOUNT_ID = /^(?:ibx|acc)_[A-Z0-9]{16}$/;

function readPart(raw: unknown, problems: string[], where: string): ConnectionPart | null {
  if (!isRecord(raw)) {
    problems.push(`${where}: a part that is not an object was left out`);
    return null;
  }
  const facts = partFacts(raw.server);
  if (facts === undefined) {
    problems.push(`${where}: "${describe(raw.server)}" is no part this release has, so it was left out`);
    return null;
  }
  let pin: ConnectionPin | undefined;
  if (raw.pin !== undefined && raw.pin !== null) {
    const held = raw.pin;
    const readable =
      facts.pin !== undefined &&
      isRecord(held) &&
      typeof held.id === 'string' &&
      ACCOUNT_ID.test(held.id) &&
      typeof held.alias === 'string' &&
      held.alias !== '';
    // A pin that cannot be read is never read as no pin, which would reach every account: the part is left out.
    if (!readable) {
      problems.push(`${where}: ${facts.label}'s pin could not be read, so the part was left out`);
      return null;
    }
    pin = { id: held.id as string, alias: held.alias as string };
  }
  let readOnly: boolean | undefined;
  if (raw.readOnly !== undefined) {
    // Read-only that cannot be read, or that a part cannot honour, leaves the part out: never read as off.
    if (raw.readOnly !== true && raw.readOnly !== false) {
      problems.push(`${where}: ${facts.label}'s read-only could not be read, so the part was left out`);
      return null;
    }
    if (raw.readOnly && !facts.readOnlySwitch) {
      problems.push(`${where}: ${facts.label} cannot be started read-only, so the part was left out`);
      return null;
    }
    readOnly = raw.readOnly;
  }
  return { server: facts.server, ...(pin === undefined ? {} : { pin }), ...(readOnly ? { readOnly: true } : {}) };
}

function readWhere(raw: unknown): ConnectionWhere | null {
  if (!isRecord(raw) || (raw.scope !== 'user' && raw.scope !== 'local')) return null;
  const folder = raw.folder ?? null;
  const configDir = raw.configDir ?? null;
  if (folder !== null && typeof folder !== 'string') return null;
  if (configDir !== null && typeof configDir !== 'string') return null;
  if (raw.scope === 'local' && (folder === null || folder === '')) return null;
  return { scope: raw.scope, folder, configDir };
}

function readEntry(raw: unknown): ConnectionEntryRef | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name === '') return undefined;
  if (raw.path !== null && typeof raw.path !== 'string') return undefined;
  return { name: raw.name, path: raw.path };
}

function readMigratedFrom(raw: unknown): ConnectionMigratedFrom | undefined {
  if (!isRecord(raw) || !isTime(raw.at) || !Array.isArray(raw.entries) || !Array.isArray(raw.backups)) return undefined;
  const entries = raw.entries.flatMap((each) =>
    isRecord(each) && typeof each.server === 'string' && typeof each.name === 'string'
      ? [{ server: each.server, name: each.name }]
      : [],
  );
  const backups = raw.backups.filter((each): each is string => typeof each === 'string');
  return { at: raw.at, entries, backups };
}

/**
 * Every connection in `config`, as this release reads it, in the order the file keeps them. A record it cannot read
 * — not an object, its id not its key's, a name, app, place, launcher, key hash or time it cannot read — serves
 * nothing; a part it cannot read is left out of an otherwise readable record, and said in `problems`. A second
 * connection with a name another already has, ignoring case, serves nothing either: Activity and every preview name a
 * connection by its name, and two with one name could not be told apart.
 */
export function readConnections(config: { readonly connections?: unknown }): {
  readonly connections: readonly ConnectionRead[];
  readonly problems: readonly string[];
} {
  const raw = config.connections;
  if (raw === undefined) return { connections: [], problems: [] };
  if (!isRecord(raw)) {
    return { connections: [], problems: ['connections in config.json is not an object, so no connection is served'] };
  }
  const connections: ConnectionRead[] = [];
  const names = new Set<string>();
  for (const [id, held] of Object.entries(raw)) {
    const problems: string[] = [];
    const unreadable = (why: string): ConnectionRead => {
      const name = isRecord(held) && typeof held.name === 'string' ? held.name : null;
      return { readable: false, id, name, problems: [...problems, `connection ${id}: ${why}, so it serves nothing`] };
    };
    if (!CONNECTION_ID_PATTERN.test(id)) {
      connections.push(unreadable('its id is not a connection id'));
      continue;
    }
    if (!isRecord(held) || held.id !== id) {
      connections.push(unreadable('it could not be read'));
      continue;
    }
    if (connectionNameProblem(held.name) !== null) {
      connections.push(unreadable('its name could not be read'));
      continue;
    }
    const name = held.name as string;
    if (names.has(name.toLowerCase())) {
      connections.push(unreadable(`another connection is called "${name}" already`));
      continue;
    }
    if (!(CONNECTION_APPS as readonly unknown[]).includes(held.app)) {
      connections.push(unreadable('its app could not be read'));
      continue;
    }
    const where = readWhere(held.where);
    if (where === null) {
      connections.push(unreadable('where its entry goes could not be read'));
      continue;
    }
    const entry = readEntry(held.entry);
    if (entry === undefined) {
      connections.push(unreadable('its entry could not be read'));
      continue;
    }
    if (!(CONNECTION_LAUNCHERS as readonly unknown[]).includes(held.launcher)) {
      connections.push(unreadable('its launcher could not be read'));
      continue;
    }
    if (typeof held.keyHash !== 'string' || !CONNECTION_KEY_HASH_PATTERN.test(held.keyHash)) {
      connections.push(unreadable('its key could not be read'));
      continue;
    }
    if (!isTime(held.keyIssuedAt) || !isTime(held.createdAt)) {
      connections.push(unreadable('its times could not be read'));
      continue;
    }
    const revokedAt = held.revokedAt ?? null;
    if (revokedAt !== null && !isTime(revokedAt)) {
      connections.push(unreadable('whether it was cut off could not be read'));
      continue;
    }
    if (!Array.isArray(held.parts)) {
      connections.push(unreadable('its parts could not be read'));
      continue;
    }
    const parts: ConnectionPart[] = [];
    for (const [index, each] of held.parts.entries()) {
      const part = readPart(each, problems, `connection "${name}" part ${index + 1}`);
      if (part === null) continue;
      // One of each server: a second Gmail would list every Gmail tool twice (D12, Q3).
      if (parts.some((had) => had.server === part.server)) {
        problems.push(`connection "${name}" part ${index + 1}: a second ${part.server} part was left out`);
        continue;
      }
      parts.push(part);
    }
    names.add(name.toLowerCase());
    const migratedFrom = readMigratedFrom(held.migratedFrom);
    connections.push({
      readable: true,
      record: {
        id,
        name,
        app: held.app as ConnectionApp,
        where,
        entry,
        launcher: held.launcher as ConnectionLauncher,
        parts,
        keyHash: held.keyHash,
        keyIssuedAt: held.keyIssuedAt,
        createdAt: held.createdAt,
        revokedAt,
        ...(migratedFrom === undefined ? {} : { migratedFrom }),
      },
      problems,
    });
  }
  return { connections, problems: connections.flatMap((each) => each.problems) };
}

/** The connection `id`, as this release reads it, or undefined when `config` has none by that id. */
export function connectionById(config: { readonly connections?: unknown }, id: string): ConnectionRead | undefined {
  return readConnections(config).connections.find((each) => (each.readable ? each.record.id : each.id) === id);
}

/** A record as `config.json` keeps it: the plain object, with no key left undefined. */
export function storedConnection(record: ConnectionRecord): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

/** `config.connections` with `record` put in, or with the record `remove` taken out, as a new object. */
export function withConnection(
  config: { readonly connections?: unknown },
  change: { readonly put?: ConnectionRecord; readonly remove?: string },
): Record<string, unknown> {
  const held = isRecord(config.connections) ? { ...config.connections } : {};
  if (change.remove !== undefined) delete held[change.remove];
  if (change.put !== undefined) held[change.put.id] = storedConnection(change.put);
  return held;
}

// ── What a connection reaches, and how a change to it is judged ─────────────────────────────────────────────

/** What one part reaches: one account by id, or every one (`null`), and whether read-only. */
export interface PartReach {
  readonly pin: ConnectionPin | null;
  readonly readOnly: boolean;
}

/** What a connection reaches, part by part — nothing at all when it is cut off or cannot be read. */
export function connectionReach(read: ConnectionRead | undefined): ReadonlyMap<string, PartReach> {
  const reach = new Map<string, PartReach>();
  if (read === undefined || !read.readable || read.record.revokedAt !== null) return reach;
  for (const part of read.record.parts) {
    reach.set(part.server, { pin: part.pin ?? null, readOnly: part.readOnly === true });
  }
  return reach;
}

/** The path a change to a connection is named by: by its name, so two plans of one new connection agree (no id yet). */
export function connectionPath(name: string, ...rest: string[]): string {
  return [`connections["${name}"]`, ...rest].join('.');
}

/** One part in a preview's words: "Gmail, pinned to the mailbox cue/gmail, read-only", "Slack, every workspace". */
export function partText(server: string, reach: PartReach): string {
  const facts = partFacts(server);
  const label = facts?.label ?? server;
  const pieces = [label];
  if (facts?.pin !== undefined) {
    pieces.push(
      reach.pin === null ? `every ${facts.noun ?? 'account'}` : `the ${facts.noun ?? 'account'} ${reach.pin.alias}`,
    );
  }
  if (reach.readOnly) pieces.push('read-only');
  return pieces.join(', ');
}

/** A whole connection in a preview's words: its name, its app and each part. */
export function connectionText(record: ConnectionRecord): string {
  const parts = [...connectionReach({ readable: true, record, problems: [] })].map(([server, reach]) =>
    partText(server, reach),
  );
  return `${record.name} (${record.app}): ${parts.length === 0 ? 'no parts' : parts.join('; ')}`;
}

/** A loosening of a connection, as `classifyChange` records it: by path, with the values it compared. */
export interface ConnectionLoosening {
  readonly path: string;
  readonly before: SettingValue;
  readonly after: SettingValue;
  /** The connection on the before side, by id; absent for one this change adds. */
  readonly id?: string | undefined;
}

/**
 * What a change to the connections loosens (§6.2): a connection added — or one cut off, or unreadable, that serves again
 * — a part added, a part's pin taken away or moved to another account, read-only turned off. Everything else — a
 * connection or part removed, a pin added, read-only on, cut off, renamed, its key replaced — loosens nothing.
 * Connections are matched by id; a path names the connection by its name on the after side.
 */
export function classifyConnectionChange(
  before: { readonly connections?: unknown },
  after: { readonly connections?: unknown },
): ConnectionLoosening[] {
  const was = new Map(
    readConnections(before).connections.map((read) => [read.readable ? read.record.id : read.id, read] as const),
  );
  const changes: ConnectionLoosening[] = [];
  for (const read of readConnections(after).connections) {
    if (!read.readable || read.record.revokedAt !== null) continue;
    const { record } = read;
    const previous = was.get(record.id);
    const reachBefore = connectionReach(previous);
    const reachAfter = connectionReach(read);
    if (previous === undefined || !previous.readable || previous.record.revokedAt !== null) {
      changes.push({ path: connectionPath(record.name), before: null, after: connectionText(record) });
      continue;
    }
    for (const [server, now] of reachAfter) {
      const then = reachBefore.get(server);
      if (then === undefined) {
        changes.push({
          path: connectionPath(record.name, 'parts', server),
          before: null,
          after: partText(server, now),
          id: record.id,
        });
        continue;
      }
      if (then.pin !== null && (now.pin === null || now.pin.id !== then.pin.id)) {
        const noun = partFacts(server)?.noun ?? 'account';
        changes.push({
          path: connectionPath(record.name, 'parts', server, 'pin'),
          before: then.pin.alias,
          after: now.pin === null ? `every ${noun}` : now.pin.alias,
          id: record.id,
        });
      }
      if (then.readOnly && !now.readOnly) {
        changes.push({
          path: connectionPath(record.name, 'parts', server, 'readOnly'),
          before: true,
          after: false,
          id: record.id,
        });
      }
    }
  }
  return changes;
}

/**
 * Every setting of every connection that differs between `before` and `after`, loosened or tightened — what a change
 * approval binds beside its loosenings, so a claim cannot drop a narrowing the person read. By the name on the after
 * side, as the loosenings are, and without the id, the key or a time: a new connection's are made fresh on each plan.
 */
export function changedConnectionSettings(
  before: { readonly connections?: unknown },
  after: { readonly connections?: unknown },
): { path: string; before: SettingValue; after: SettingValue }[] {
  const settings = (read: ConnectionRead | undefined): Record<string, SettingValue> => {
    if (read === undefined) return {};
    if (!read.readable) return { served: 'nothing: it cannot be read' };
    const { record } = read;
    return {
      parts: [...connectionReach(read)].map(([server, reach]) => partText(server, reach)),
      app: record.app,
      where: `${record.where.scope}${record.where.folder === null ? '' : ` in ${record.where.folder}`}${record.where.configDir === null ? '' : `, profile ${record.where.configDir}`}`,
      entry: record.entry === null ? 'none: a snippet the person pastes' : record.entry.name,
      launcher: record.launcher,
      served: record.revokedAt === null ? 'yes' : 'no: cut off',
    };
  };
  const idOf = (read: ConnectionRead) => (read.readable ? read.record.id : read.id);
  const nameOf = (read: ConnectionRead) => (read.readable ? read.record.name : (read.name ?? read.id));
  const was = new Map(readConnections(before).connections.map((read) => [idOf(read), read] as const));
  const now = new Map(readConnections(after).connections.map((read) => [idOf(read), read] as const));
  const changes: { path: string; before: SettingValue; after: SettingValue }[] = [];
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const then = settings(was.get(id));
    const next = settings(now.get(id));
    const shown = now.get(id) ?? was.get(id);
    if (shown === undefined) continue;
    const name = nameOf(shown);
    for (const key of [...new Set([...Object.keys(then), ...Object.keys(next)])].sort()) {
      const a = then[key] ?? null;
      const b = next[key] ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b))
        changes.push({ path: connectionPath(name, key), before: a, after: b });
    }
  }
  return changes;
}

/** A stored value in a sentence: short, and never more than a few dozen characters of whatever the file held. */
function describe(value: unknown): string {
  const text = typeof value === 'string' ? value : String(JSON.stringify(value) ?? value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
