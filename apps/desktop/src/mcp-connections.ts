/**
 * MCP connections (0.35.0, single-server design §11; the owner-approved boards `docs/prototypes/2026-10-26-0340-rework`
 * McpServers, AddConnection and Connection): each place an app uses Agent Comms, read from core's `connection list
 * --json` and `connection show <id> --json`, with the parts a connection can have from `channels --json` (D20) and the
 * accounts each can be kept to from `label --json`. Core gives the facts; the words a person reads are made here.
 *
 * Nothing here makes markup. A connection's key never reaches this file: core gives none in a list or a view, and the
 * one Manual snippet that carries one (`Snippets`) is read out of a change's answer for the one screen that shows it.
 */
import { CONNECTION_APPS, type ConnectionApp, type ConnectionPartRequest, MCP_CLIENTS, type McpClient } from './ipc.ts';
import { shownFolder } from './lanes.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];
const isApp = (value: unknown): value is ConnectionApp => CONNECTION_APPS.includes(value as ConnectionApp);
const isClient = (value: unknown): value is McpClient => MCP_CLIENTS.includes(value as McpClient);

/** Core's word for Agent Comms itself, the part every connection the app adds has (lead's decision, 2026-10-27). */
export const CORE_PART = 'core';

// ── The apps ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Each app's name, as a card and a sentence say it; Manual's is said as "the app" in a sentence (`appName`). */
export const CONNECTION_APP_LABELS: Readonly<Record<ConnectionApp, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  vscode: 'VS Code',
  manual: 'Manual',
};

/** The two letters on each app's mark (the boards' `si`). */
export const CONNECTION_APP_MARKS: Readonly<Record<ConnectionApp, string>> = {
  'claude-code': 'CC',
  'claude-desktop': 'CD',
  codex: 'Co',
  cursor: 'Cu',
  gemini: 'Ge',
  vscode: 'VS',
  manual: 'M',
};

/** What each app is, under its name when the person chooses one (AddConnection, step 1). */
export const CONNECTION_APP_LINES: Readonly<Record<ConnectionApp, string>> = {
  'claude-code': 'In the terminal or an editor: every folder, one project, or another profile.',
  'claude-desktop': 'The Claude app for Mac.',
  codex: 'OpenAI’s coding agent: this Codex, or another Codex home.',
  cursor: 'The code editor, for every project.',
  gemini: 'Google’s Gemini CLI.',
  vscode: 'Visual Studio Code’s agent mode.',
  manual: 'Any other app that takes MCP servers. Agent Comms gives you a snippet to paste into its settings.',
};

/** The app as a sentence names it: "Claude Code", or for a Manual connection "the app". */
export function appName(app: ConnectionApp | null): string {
  return app === null || app === 'manual' ? 'the app' : CONNECTION_APP_LABELS[app];
}

/** The same, at the start of a sentence. */
export function appNameAtStart(app: ConnectionApp | null): string {
  const name = appName(app);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ── The parts ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The words for the parts this release knows: what each lets agents do, and, for Gmail, which alone has a read-only
 * switch (core refuses one on any other part), what reading only means. A part a later release adds has none of these,
 * and is shown by core's label alone.
 */
export const PART_WORDS: Readonly<
  Record<string, { name: string; purpose: string; readOnly?: string; more?: string; readOnlyMore?: string }>
> = {
  core: { name: 'Agent Comms itself', purpose: 'Setup, approvals and updates.' },
  gmail: {
    name: 'Gmail',
    purpose: 'Read, search and draft mail. An email goes only after your yes.',
    readOnly: 'Read and search only: no drafts, no emails',
    more: 'can draft, and prepare mail that waits for your yes',
    readOnlyMore: 'read and search only',
  },
  slack: {
    name: 'Slack',
    purpose: 'Read channels and threads, and prepare posts that wait for your yes.',
    more: 'can prepare posts that wait for your yes',
  },
  resend: {
    name: 'Resend',
    purpose: 'Mail from your own domain: see what was sent and received, and prepare mail that waits for your yes.',
    more: 'can prepare mail that waits for your yes',
  },
  whatsapp: {
    name: 'WhatsApp',
    purpose: 'Read your WhatsApp chats on this Mac, and draft replies. It never sends.',
    more: 'can draft replies, for you to send',
  },
  events: { name: 'Events', purpose: 'Work through the Queue, and see your workflows and what they passed on.' },
};

/** A part that can be chosen, from `channels --json` (D20): its word, its name, and whether it is a channel. */
export interface PartChoice {
  server: string;
  name: string;
  kind: 'channel' | 'service';
}

/** One of our own entries an app starts on its own, outside any connection: what Move to one entry gathers. */
export interface StandaloneEntry {
  client: McpClient;
  server: string;
}

export interface ChannelsForConnections {
  parts: PartChoice[];
  standalone: StandaloneEntry[];
}

/**
 * `channels --json`, read for MCP connections: every declared server, in core's order, as a part a connection can have,
 * named as this file names the ones it knows and as core labels the rest; and every entry of ours an app starts outside
 * a connection. Null when it is not that answer at all.
 */
export function readPartChoices(value: unknown): ChannelsForConnections | null {
  if (!isRecord(value) || !Array.isArray(value.channels)) return null;
  const parts: PartChoice[] = [];
  const standalone: StandaloneEntry[] = [];
  for (const channel of value.channels) {
    if (!isRecord(channel)) continue;
    const server = text(channel.channel);
    if (server === null || !/^[a-z][a-z0-9]{0,15}$/.test(server)) continue;
    if (parts.some((had) => had.server === server)) continue;
    parts.push({
      server,
      name: PART_WORDS[server]?.name ?? text(channel.label) ?? server,
      kind: channel.kind === 'service' ? 'service' : 'channel',
    });
    for (const entry of Array.isArray(channel.registered) ? channel.registered : []) {
      if (!isRecord(entry) || !isClient(entry.client)) continue;
      if (typeof entry.connection === 'string') continue;
      standalone.push({ client: entry.client, server });
    }
  }
  return { parts, standalone };
}

/** An account a part can be kept to: its name now, and the platform it is on (`label --json`'s `accounts`). */
export interface AccountChoice {
  account: string;
  platform: string;
}

/** Every account here, from `label --json`: each by its name and platform. Null when it is not that answer. */
export function readAccountChoices(value: unknown): AccountChoice[] | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null;
  return value.accounts.flatMap((each): AccountChoice[] => {
    if (!isRecord(each)) return [];
    const account = text(each.account);
    const platform = text(each.platform) ?? text(each.channel);
    return account === null || platform === null ? [] : [{ account, platform }];
  });
}

/** The accounts `server` can be kept to: the ones on its platform. */
export function accountsOf(server: string, accounts: readonly AccountChoice[]): string[] {
  return accounts.filter((each) => each.platform === server).map((each) => each.account);
}

/** What one part is set to in an editor: on or off, the one account it is kept to (null for every one), read-only. */
export interface PartSetting {
  on: boolean;
  account: string | null;
  readOnly: boolean;
}

export type PartSettings = Record<string, PartSetting>;

/** Whether the person may switch read-only on for `server`: only where this release has a read-only switch. */
export function hasReadOnly(server: string): boolean {
  return PART_WORDS[server]?.readOnly !== undefined;
}

/**
 * A new connection's parts as the editor starts them (§6.1's defaults, chosen here so the person sees them): Agent
 * Comms itself, each channel with an account here, and Events when the event service is installed; each part on every
 * account, and none read-only.
 */
export function startingParts(
  choices: readonly PartChoice[],
  accounts: readonly AccountChoice[],
  eventsInstalled: boolean,
): PartSettings {
  const settings: PartSettings = {};
  for (const choice of choices) {
    const on =
      choice.server === CORE_PART ||
      (choice.kind === 'channel' && accountsOf(choice.server, accounts).length > 0) ||
      (choice.kind === 'service' && eventsInstalled);
    settings[choice.server] = { on, account: null, readOnly: false };
  }
  return settings;
}

/** An existing connection's parts as the editor starts them: what it has now, by its parts' views. */
export function partsNow(choices: readonly PartChoice[], view: ConnectionView): PartSettings {
  const settings: PartSettings = {};
  for (const choice of choices) {
    const part = view.parts.find((each) => each.server === choice.server);
    settings[choice.server] = {
      on: part !== undefined,
      account: part?.account ?? null,
      readOnly: part?.readOnly === true,
    };
  }
  // A part this release's channels do not list, which the connection has, stays as it is.
  for (const part of view.parts) {
    if (settings[part.server] !== undefined) continue;
    settings[part.server] = { on: true, account: part.account, readOnly: part.readOnly };
  }
  return settings;
}

/**
 * The parts to send core, in core's order (the channels' order, then any part only the connection has): each one on,
 * its account when it is kept to one, and read-only only where it can be and is on.
 */
export function partsRequest(choices: readonly PartChoice[], settings: PartSettings): ConnectionPartRequest[] {
  const order = [...choices.map((choice) => choice.server)];
  for (const server of Object.keys(settings)) if (!order.includes(server)) order.push(server);
  return order.flatMap((server): ConnectionPartRequest[] => {
    const setting = settings[server];
    if (setting === undefined || !setting.on) return [];
    return [
      {
        server,
        ...(setting.account === null ? {} : { account: setting.account }),
        ...(setting.readOnly && hasReadOnly(server) ? { readOnly: true as const } : {}),
      },
    ];
  });
}

/** A part's name, as this file knows it, or as core labelled it. */
export function partName(server: string, label?: string | null): string {
  return PART_WORDS[server]?.name ?? label ?? server;
}

/**
 * What agents could do with these parts, in a person's words (AddConnection's review, Connection's ask): a line or two
 * each, Agent Comms itself first. `accountsFor` says which accounts a part reaches when it is not kept to one.
 */
export function grantsFor(
  parts: readonly ConnectionPartRequest[],
  accountsFor: (server: string) => readonly string[],
  names: (server: string) => string = (server) => partName(server),
): string[] {
  const list = (items: readonly string[]): string =>
    items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return parts.flatMap((part): string[] => {
    const reach = part.account === undefined ? list(accountsFor(part.server)) : part.account;
    const where = reach === '' ? '' : ` in ${reach}`;
    switch (part.server) {
      case CORE_PART:
        return ['check how Agent Comms is set up, and ask you to approve a change'];
      case 'gmail':
        return part.readOnly
          ? [`read and search mail${where}`]
          : [`read and search mail${where}`, 'write drafts, and prepare an email, which goes only after your yes'];
      case 'slack':
        return [
          `read channels and threads${where}`,
          'prepare a post, a reply or a reaction, which goes only after your yes',
        ];
      case 'resend':
        return [
          `see what was sent and received${reach === '' ? '' : ` through ${reach}`}`,
          'prepare an email, which goes only after your yes',
        ];
      case 'whatsapp':
        return [`read your chats${where} on this Mac`, 'write a draft reply, for you to send yourself'];
      case 'events':
        return [
          'read the Queue, and mark items done',
          'see your workflows and what they passed on, and propose a workflow, which waits for your approval',
        ];
      default:
        return [`use ${names(part.server)}’s tools${where}`];
    }
  });
}

// ── A connection, as core gives it ───────────────────────────────────────────────────────────────────────────

/** One part of a connection, as `connection list` gives it. */
export interface PartView {
  server: string;
  label: string;
  /** The account it is kept to, by its name now; null for every account, or for a part that reaches none. */
  account: string | null;
  readOnly: boolean;
  available: boolean;
  why: string | null;
}

/** Where a connection's entry is: every folder, one project, and another profile's folder. */
export interface WhereView {
  scope: 'user' | 'local';
  folder: string | null;
  configDir: string | null;
}

/** A connection, as `connection list --json` gives it: never its key, nor its hash. */
export interface ConnectionView {
  id: string;
  readable: boolean;
  name: string | null;
  /** Null for an app this release does not know, or a connection that could not be read. */
  app: ConnectionApp | null;
  where: WhereView | null;
  parts: PartView[];
  /** What core wrote into the app's config; null for Manual, which core writes nowhere. */
  entry: { name: string; path: string | null; present: boolean | null; keyMatches: boolean | null } | null;
  key: { issuedAt: string | null; revoked: boolean };
  createdAt: string | null;
  lastUsed: string | null;
  problems: string[];
}

/** One part, in an Agent Comms running for a connection now. */
export interface RunningPart {
  server: string;
  label: string;
  state: string;
  version: string | null;
  why: string | null;
}

/** One Agent Comms running for a connection now, as `connection show` gives it from its status file. */
export interface RunningGateway {
  /** Its process, which names its status file: one gateway each. */
  pid: number;
  startedAt: string | null;
  /** The app's name, as the app said it. */
  client: string | null;
  /** Why it serves nothing, when it does not. */
  refused: string | null;
  parts: RunningPart[];
}

export interface ShownConnection extends ConnectionView {
  running: RunningGateway[];
}

const CONNECTION_ID = /^cn_[0-9A-HJKMNP-TV-Z]{26}$/;

function partOf(value: unknown): PartView | null {
  if (!isRecord(value)) return null;
  const server = text(value.server);
  if (server === null) return null;
  return {
    server,
    label: text(value.label) ?? server,
    account: text(value.account),
    readOnly: value.readOnly === true,
    available: value.available !== false,
    why: text(value.why),
  };
}

function whereOf(value: unknown): WhereView | null {
  if (!isRecord(value)) return null;
  return {
    scope: value.scope === 'local' ? 'local' : 'user',
    folder: text(value.folder),
    configDir: text(value.configDir),
  };
}

/** One connection, read field by field: null for one with no id core would make, which nothing could act on. */
export function readConnection(value: unknown): ConnectionView | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (id === null || !CONNECTION_ID.test(id)) return null;
  const entry = isRecord(value.entry) && typeof value.entry.name === 'string' ? value.entry : null;
  const key = isRecord(value.key) ? value.key : {};
  return {
    id,
    readable: value.readable !== false,
    name: text(value.name),
    app: isApp(value.app) ? value.app : null,
    where: whereOf(value.where),
    parts: (Array.isArray(value.parts) ? value.parts : []).flatMap((each) => partOf(each) ?? []),
    entry:
      entry === null
        ? null
        : {
            name: entry.name as string,
            path: text(entry.path),
            present: flag(entry.present),
            keyMatches: flag(entry.keyMatches),
          },
    key: { issuedAt: text(key.issuedAt), revoked: key.revoked === true },
    createdAt: text(value.createdAt),
    lastUsed: text(value.lastUsed),
    problems: strings(value.problems),
  };
}

/** `connection list --json`, read: every connection core gave, and what it could not read. Null when it is not one. */
export function readConnectionList(value: unknown): { connections: ConnectionView[]; problems: string[] } | null {
  if (!isRecord(value) || !Array.isArray(value.connections)) return null;
  return {
    connections: value.connections.flatMap((each) => readConnection(each) ?? []),
    problems: strings(value.problems),
  };
}

/** `connection show <id> --json`, read: the connection, and each Agent Comms running for it now. */
export function readShownConnection(value: unknown): ShownConnection | null {
  const view = readConnection(value);
  if (view === null || !isRecord(value)) return null;
  const running = (Array.isArray(value.running) ? value.running : []).flatMap((each): RunningGateway[] => {
    if (!isRecord(each) || typeof each.pid !== 'number' || !Number.isInteger(each.pid)) return [];
    const client = isRecord(each.client) ? text(each.client.name) : null;
    return [
      {
        pid: each.pid,
        startedAt: text(each.startedAt),
        client,
        refused: text(each.refused),
        parts: (Array.isArray(each.parts) ? each.parts : []).flatMap((part): RunningPart[] => {
          if (!isRecord(part)) return [];
          const server = text(part.server);
          if (server === null) return [];
          return [
            {
              server,
              label: text(part.label) ?? server,
              state: text(part.state) ?? 'stopped',
              version: text(part.version),
              why: text(part.why),
            },
          ];
        }),
      },
    ];
  });
  return { ...view, running };
}

// ── A connection, in words ───────────────────────────────────────────────────────────────────────────────────

/** A connection's name as shown: its own, or for one that could not be read, its id. */
export function nameOf(view: ConnectionView): string {
  return view.name ?? view.id;
}

/** Where it is, in a few words, under its name: "Claude Code · project ~/work/acme-site". */
export function whereShort(view: ConnectionView, home: string | null): string {
  if (view.app === null) return view.readable ? 'An app this release does not know' : 'Could not be read';
  const label = CONNECTION_APP_LABELS[view.app];
  const where = view.where;
  if (view.app === 'manual') return 'Manual · a snippet you paste';
  const profile = where?.configDir == null ? null : shownFolder(where.configDir, home);
  if (view.app === 'claude-code') {
    const place =
      where?.scope === 'local' && where.folder !== null ? `project ${shownFolder(where.folder, home)}` : null;
    if (place !== null) return `${label} · ${place}${profile === null ? '' : ` · profile ${profile}`}`;
    return profile === null ? `${label} · every folder` : `${label} · profile ${profile}`;
  }
  if (view.app === 'codex') return profile === null ? label : `${label} · home ${profile}`;
  return label;
}

/** Where it is, in a sentence, for its page's facts. */
export function whereLong(view: ConnectionView, home: string | null): string {
  const where = view.where;
  if (view.app === 'manual') return 'The app’s own settings, where you pasted the snippet. Agent Comms can’t see them.';
  const profile = where?.configDir == null ? null : shownFolder(where.configDir, home);
  if (view.app === 'claude-code') {
    if (where?.scope === 'local' && where.folder !== null) {
      const project = `One project: ${shownFolder(where.folder, home)}`;
      return profile === null ? project : `${project}, under the profile in ${profile}`;
    }
    return profile === null ? 'Every folder' : `Another Claude profile: ${profile}`;
  }
  if (view.app === 'codex') return profile === null ? 'This Codex' : `Another Codex home: ${profile}`;
  return view.app === null ? '—' : `${CONNECTION_APP_LABELS[view.app]}, for every project`;
}

/** The file its entry is in, and the entry's name: "“agentcomms” in ~/.claude.json". Null for Manual. */
export function entryLine(view: ConnectionView, home: string | null): string | null {
  if (view.entry === null) return null;
  return view.entry.path === null
    ? `“${view.entry.name}”`
    : `“${view.entry.name}” in ${shownFolder(view.entry.path, home)}`;
}

/** Where core wrote its entry, as Done says it: "Written into ~/.claude.json, as “agentcomms”." Empty for Manual. */
export function writtenLine(view: ConnectionView, home: string | null): string {
  if (view.entry === null) return '';
  const file = view.entry.path === null ? `${appName(view.app)}’s settings` : shownFolder(view.entry.path, home);
  return `Written into ${file}, as “${view.entry.name}”.`;
}

/** Whether a connection has Agent Comms itself: every one the app adds does; one made at a terminal may not. */
export function hasCore(view: ConnectionView): boolean {
  return view.parts.some((part) => part.server === CORE_PART);
}

/** A card's chips: each part but Agent Comms itself, with its account and read-only, as the list shows them. */
export function partChips(view: ConnectionView): string[] {
  const chips = view.parts
    .filter((part) => part.server !== CORE_PART)
    .map(
      (part) =>
        `${partName(part.server, part.label)}${part.account === null ? '' : ` · only ${part.account}`}${part.readOnly ? ' · read-only' : ''}${part.available ? '' : ' · not started'}`,
    );
  return view.readable && !hasCore(view) ? [...chips, 'Without Agent Comms itself'] : chips;
}

/** One line of a connection's page: a part, and what it reaches and may do. */
export function partLine(part: PartView): { name: string; detail: string } {
  const words = PART_WORDS[part.server];
  if (part.server === CORE_PART)
    return { name: partName(part.server, part.label), detail: 'Setup, approvals and updates' };
  const reach = part.account === null ? 'every account' : `only ${part.account}`;
  const does = part.readOnly ? (words?.readOnlyMore ?? 'read-only') : words?.more;
  return {
    name: partName(part.server, part.label),
    detail: [reach, does].filter((each): each is string => each !== undefined).join(' · '),
  };
}

/** How it stands, as its card and page say: a tone, a word, and a sentence. */
export interface ConnectionStatus {
  tone: 'ok' | 'warn' | 'danger' | 'idle';
  word: string;
  line: string;
}

/**
 * How a connection stands, from what core said of it: unreadable and cut off first, then what is wrong with its entry,
 * then what is running for it now (when `connection show` was read), then whether it has been used.
 */
export function statusOf(
  view: ConnectionView,
  home: string | null,
  running?: readonly RunningGateway[],
): ConnectionStatus {
  const app = appName(view.app);
  const App = appNameAtStart(view.app);
  if (!view.readable)
    return {
      tone: 'danger',
      word: 'Could not be read',
      line: 'Agent Comms could not read this connection, so it serves nothing. Remove it, then add it again.',
    };
  if (view.key.revoked)
    return { tone: 'danger', word: 'Cut off', line: 'Its key no longer works, so it serves nothing.' };
  if (view.entry?.present === false)
    return {
      tone: 'warn',
      word: `Not in ${app}’s settings`,
      line: `Agent Comms can’t find its entry in ${app}’s settings, so ${app} doesn’t start it. Remove this connection, then add it again.`,
    };
  if (view.entry?.keyMatches === false)
    return {
      tone: 'warn',
      word: 'Its entry has an old key',
      line: `${App} would start it with a key that no longer works. Replace the key to write the right one into its entry.`,
    };
  const refused = running?.find((gateway) => gateway.refused !== null);
  if (refused !== undefined) return { tone: 'warn', word: 'Running, but serving nothing', line: refused.refused ?? '' };
  if (running !== undefined && running.length > 0)
    return { tone: 'ok', word: 'Running now', line: `${App} has Agent Comms running through this connection now.` };
  if (view.lastUsed === null) {
    if (view.app === 'manual')
      return {
        tone: 'idle',
        word: 'Not used yet',
        line: 'Paste its snippet into the app’s settings, then restart the app. Lost the snippet? Replace the key for a new one.',
      };
    if (view.where?.scope === 'local' && view.where.folder !== null)
      return {
        tone: 'warn',
        word: `Open the project in ${app} to finish`,
        line: `It reaches Claude Code in ${shownFolder(view.where.folder, home)}: open that folder in Claude Code, or restart Claude Code there.`,
      };
    return {
      tone: 'warn',
      word: `Restart ${app} to finish`,
      line: `A change reaches ${app} after you restart it. Until then, it has the parts it had before.`,
    };
  }
  return {
    tone: 'ok',
    word: 'Connected',
    line: `${App} starts Agent Comms through this connection.`,
  };
}

/** Two connections in one place: the same app and the same entry's place, so the app starts both. */
export function samePlace(a: Pick<ConnectionView, 'app' | 'where'>, b: Pick<ConnectionView, 'app' | 'where'>): boolean {
  if (a.app === null || a.app === 'manual' || a.app !== b.app) return false;
  const left = a.where ?? { scope: 'user', folder: null, configDir: null };
  const right = b.where ?? { scope: 'user', folder: null, configDir: null };
  return (
    left.scope === right.scope &&
    (left.scope === 'user' || left.folder === right.folder) &&
    (left.configDir ?? null) === (right.configDir ?? null)
  );
}

/** "3 connections, in 2 apps": Manual connections each count as an app of their own. */
export function countLine(views: readonly ConnectionView[]): string {
  const apps = new Set(views.map((view) => (view.app === 'manual' || view.app === null ? `:${view.id}` : view.app)));
  const n = views.length;
  return `${n} ${n === 1 ? 'connection' : 'connections'}, in ${apps.size} ${apps.size === 1 ? 'app' : 'apps'}`;
}

// ── What a change came back with ─────────────────────────────────────────────────────────────────────────────

/** A Manual connection's snippet in each format, with its key in it: shown once, and never kept. */
export interface Snippets {
  json: string;
  toml: string;
  vscode: string;
}

function snippetsOf(value: unknown): Snippets | null {
  if (!isRecord(value)) return null;
  const json = text(value.json);
  const toml = text(value.toml);
  const vscode = text(value.vscode);
  return json === null || toml === null || vscode === null ? null : { json, toml, vscode };
}

/** What `connection add` came to: the connection, its snippets for Manual, and how its first start went. */
export interface AddedConnection {
  connection: ConnectionView | null;
  snippets: Snippets | null;
  verification: string | null;
  verifyDetail: string | null;
}

export function readAdded(value: unknown): AddedConnection {
  const data = isRecord(value) ? value : {};
  return {
    connection: readConnection(data.connection),
    snippets: snippetsOf(data.snippets),
    verification: text(data.verification),
    verifyDetail: text(data.verifyDetail),
  };
}

/** What `connection key replace` came to: the connection, and for Manual the new snippet. */
export function readReplaced(value: unknown): {
  connection: ConnectionView | null;
  snippets: Snippets | null;
  next: string | null;
} {
  const data = isRecord(value) ? value : {};
  return { connection: readConnection(data.connection), snippets: snippetsOf(data.snippets), next: text(data.next) };
}

/** What `connection change` came to: the connection now, and what was taken away at once. */
export function readChanged(value: unknown): { connection: ConnectionView | null; appliedAtOnce: string[] } {
  const data = isRecord(value) ? value : {};
  return { connection: readConnection(data.connection), appliedAtOnce: strings(data.appliedAtOnce) };
}

/** What `connection remove` came to: the entries it left, and why. */
export function readRemoved(value: unknown): { kept: { name: string; path: string; reason: string }[] } {
  const data = isRecord(value) ? value : {};
  const entry = isRecord(data.entry) ? data.entry : {};
  return {
    kept: (Array.isArray(entry.kept) ? entry.kept : []).flatMap((each) => {
      if (!isRecord(each)) return [];
      const name = text(each.name);
      const path = text(each.path);
      return name === null || path === null ? [] : [{ name, path, reason: text(each.reason) ?? '' }];
    }),
  };
}

/** What `connection migrate` came to: each connection made, each entry left, and what to do next. */
export interface Migrated {
  migrated: { id: string; name: string; app: string; replaced: number }[];
  left: { name: string; path: string; why: string }[];
  next: string[];
}

export function readMigrated(value: unknown): Migrated {
  const data = isRecord(value) ? value : {};
  return {
    migrated: (Array.isArray(data.migrated) ? data.migrated : []).flatMap((each) => {
      if (!isRecord(each)) return [];
      const id = text(each.id);
      const name = text(each.name);
      if (id === null || !CONNECTION_ID.test(id) || name === null) return [];
      const replaced = typeof each.replaced === 'number' && Number.isFinite(each.replaced) ? each.replaced : 0;
      return [{ id, name, app: text(each.app) ?? '', replaced }];
    }),
    left: (Array.isArray(data.left) ? data.left : []).flatMap((each) => {
      if (!isRecord(each)) return [];
      const name = text(each.name);
      const path = text(each.path);
      return name === null || path === null ? [] : [{ name, path, why: text(each.why) ?? '' }];
    }),
    next: strings(data.next),
  };
}

/** What `connection migrate --undo` came to: each part registered again, by the entry's name. */
export function readUndone(value: unknown): {
  name: string | null;
  registered: { server: string; name: string; applied: boolean }[];
} {
  const data = isRecord(value) ? value : {};
  return {
    name: text(data.name),
    registered: (Array.isArray(data.registered) ? data.registered : []).flatMap((each) => {
      if (!isRecord(each)) return [];
      const server = text(each.server);
      const name = text(each.name);
      return server === null || name === null ? [] : [{ server, name, applied: each.applied === true }];
    }),
  };
}

// ── Folders the person types ─────────────────────────────────────────────────────────────────────────────────

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/**
 * A folder the person typed, written whole, as Rust checks it (`mcp_connections::connection_folder`): `~/…` is read
 * with the home folder, then it must be absolute — `/…`, or `C:\…` on Windows — with no `.` or `..` step and no
 * repeated or trailing separator. Null when it is not one.
 */
export function wholeFolder(typed: string, home: string | null): string | null {
  const value = typed.trim();
  const expanded =
    (value === '~' || value.startsWith('~/')) && home !== null && home !== ''
      ? `${home.replace(/[\\/]$/, '')}${value.slice(1)}`
      : value;
  if (expanded.length === 0 || new TextEncoder().encode(expanded).length > 1024 || CONTROL_OR_FORMAT.test(expanded))
    return null;
  const steps = (rest: string, separator: string) =>
    rest !== '' && rest.split(separator).every((step) => step !== '' && step !== '.' && step !== '..');
  if (expanded.startsWith('/')) return steps(expanded.slice(1), '/') ? expanded : null;
  if (/^[A-Za-z]:\\/.test(expanded) && !expanded.includes('/')) return steps(expanded.slice(3), '\\') ? expanded : null;
  return null;
}

/** A connection's name, by core's rule, as Rust checks it (`mcp_connections::connection_name`): why not, or null. */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return 'Give it a name: it’s how you’ll find it here and in Activity.';
  if (name.trim() !== name) return 'A name doesn’t start or end with a space.';
  if (name.startsWith('-')) return 'A name doesn’t start with “-”.';
  if ([...name].length > 64) return 'A name is at most 64 characters.';
  if (CONTROL_OR_FORMAT.test(name)) return 'A name has no line breaks, tabs or hidden characters.';
  if (/["'`“”‘’]/.test(name)) return 'A name has no quotation marks.';
  // A name that imitates the label a preview gives it — `"Work" (Claude Code, every folder, cn_ABCD…)` — is refused
  // for a new one (0.35.0 re-review, LOW 6). One that has them already still reads, and works.
  if (/[()…]/.test(name)) return 'A name has no brackets or “…”: a preview puts its app, place and id there.';
  return null;
}
