import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GatedChange } from '../change-flow.ts';
import type { ChangeRequest, ChangeSurface } from '../changes.ts';
import { channelManifest, serverFacts, serverLabel } from '../channel-servers.ts';
import { agentMarker } from '../cli-runtime.ts';
import { type Config, classifyChange, connectedAccounts } from '../config.ts';
import {
  CONNECTION_APPS,
  CONNECTION_ID_PATTERN,
  CONNECTION_KEY_ENV,
  CONNECTION_LAUNCHERS,
  type ConnectionApp,
  type ConnectionLauncher,
  type ConnectionPart,
  type ConnectionRead,
  type ConnectionRecord,
  connectionById,
  connectionKeyHash,
  connectionKeyMatches,
  connectionNameProblem,
  connectionOfThisProcess,
  connectionReach,
  newConnectionId,
  newConnectionKey,
  PART_FACTS,
  partFacts,
  partText,
  readConnections,
  withConnection,
} from '../connections.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { connectionLastUsed, type GatewayStatus, runningGateways } from '../gateway/status.ts';
import { handoffSentence } from '../handoff-text.ts';
import { requireHandoffs } from '../handoffs.ts';
import { launcherName, readPointer } from '../launcher.ts';
import { scanRegisteredServers } from '../mcp-clients.ts';
import {
  connectionOfEntry,
  type InstallContext,
  isProductServer,
  managedRuntimeDir,
  removeConnectionEntry,
  reusableRuntime,
  type SupportedClient,
} from '../mcp-install.ts';
import { mcpServerOf } from '../mcp-marker.ts';
import { findById, lookupName } from '../names.ts';
import { homeDirectory, shortenHome } from '../paths.ts';
import { unverifiedRelease } from '../update-release.ts';
import { VERSION } from '../version.ts';
import { type ServerInstallDeps, type ServerInstallResult, serverInstallChange } from './servers.ts';

/**
 * MCP connections, as operations (single-server design §6, §10, and the 0.35 prototype's MCP connections): what the
 * person sees and changes — each place an app uses Agent Comms, its parts and accounts, its key — from the CLI, the MCP
 * tools and the app alike.
 *
 * - **Adding a connection** is a loosening: it hands an app a set of tools. It is prepared, shown and approved like
 *   registering a server, and it registers the connection's one entry with its app — its key in the entry's
 *   environment, never shown — installing any part's runtime this machine lacks. A Manual connection is a snippet with
 *   its key in it, shown once, so it is added only at the person's own terminal or in the app, never over MCP: the key
 *   would stay in the chat's transcript.
 * - **Changing its parts** tightens at once — a part taken out, a pin added, read-only on — and asks for the rest.
 * - **Renaming it, and replacing its key**, give an agent nothing more, so they apply at once and are audited. A
 *   Manual connection's new key is a snippet to paste: at the person's terminal only, as adding one is.
 * - **Removing it** applies at once: its entry is taken out of its app, and its key stops working with the record.
 */

/**
 * A Manual connection's key is shown, in its snippet: only to the person — never over MCP, nor to an agent's shell, nor
 * inside an MCP server's process, where it would stay in a transcript (design §8.1). A speed bump against agents, as
 * every person-only act here is, not a boundary against code running as the person.
 */
function refuseKeyToAgent(env: NodeJS.ProcessEnv, surface: ChangeSurface): void {
  const marker =
    surface === 'mcp' ? 'MCP' : (agentMarker(env) ?? (mcpServerOf(env) === undefined ? null : 'MCP_SERVER_PROCESS'));
  if (marker === null) return;
  throw new CommsError('APPROVAL_REQUIRED', "a Manual connection's key is shown only to the person, not to an agent", {
    hint: 'Its snippet carries its key, which would stay in the agent’s transcript. Ask the person to do it in the Agent Comms app, or with the connection command at their own terminal.',
    details: { marker },
  });
}

/** The app each connection type registers with, as `mcp install` names it; Manual registers with none. */
const APP_CLIENT: Readonly<Record<Exclude<ConnectionApp, 'manual'>, SupportedClient>> = Object.freeze({
  'claude-code': 'claude-code',
  'claude-desktop': 'claude-desktop',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini',
  vscode: 'vscode',
});

/** How a person names an app in a sentence. */
const APP_LABELS: Readonly<Record<ConnectionApp, string>> = Object.freeze({
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  vscode: 'VS Code',
  manual: 'the app you paste it into',
});

/** One part as a request names it: a server, the account it is kept to, and read-only. */
export interface PartRequest {
  readonly server: string;
  /** The account's name, `organisation/platform`; left out, every account. */
  readonly account?: string | undefined;
  readonly readOnly?: boolean | undefined;
}

/**
 * Parts as a command line names them: `core,gmail:cue/gmail:read-only,slack,events` — each a server, then the account
 * it is kept to and `read-only`, separated by colons. An account name has no colon in it.
 */
export function parsePartsSpec(text: string): PartRequest[] {
  const parts: PartRequest[] = [];
  for (const raw of text.split(',')) {
    const item = raw.trim();
    if (item === '') continue;
    const [server = '', ...rest] = item.split(':').map((word) => word.trim());
    let account: string | undefined;
    let readOnly = false;
    for (const word of rest) {
      if (word === 'read-only') readOnly = true;
      else if (word !== '' && account === undefined) account = word;
      else
        throw new CommsError(
          'USAGE',
          `"${item.slice(0, 60)}" is not a part: name a server, then its account and read-only`,
        );
    }
    parts.push({ server, ...(account === undefined ? {} : { account }), ...(readOnly ? { readOnly } : {}) });
  }
  return parts;
}

/** The parts of a request as a record keeps them: each server once, each pin by its account's id (D12). */
function partsOf(config: Config, requested: readonly PartRequest[]): ConnectionPart[] {
  const parts: ConnectionPart[] = [];
  for (const request of requested) {
    const facts = partFacts(request.server);
    if (facts === undefined) {
      throw new CommsError('USAGE', `"${String(request.server).slice(0, 40)}" is not a part a connection can have`, {
        hint: `One of: ${PART_FACTS.map((each) => each.server).join(', ')}.`,
      });
    }
    if (parts.some((had) => had.server === facts.server)) {
      throw new CommsError('USAGE', `${facts.label} is named twice: a connection has one of each part`, {
        hint: 'Name it once, kept to one account or to every one.',
      });
    }
    let pin: ConnectionPart['pin'];
    if (request.account !== undefined) {
      if (facts.pin === undefined) {
        throw new CommsError('USAGE', `${facts.label} reaches no account, so it cannot be kept to one`);
      }
      if (facts.accounts === 'inboxes') {
        const inbox = lookupName(config, 'inbox', request.account);
        if (inbox === undefined) throw new CommsError('NOT_FOUND', `no mailbox here is called "${request.account}"`);
        pin = { id: inbox.id, alias: request.account };
      } else {
        const account = lookupName(config, 'account', request.account);
        if (account === undefined || account.platform !== facts.server) {
          throw new CommsError(
            'NOT_FOUND',
            `no ${facts.label} ${facts.noun ?? 'account'} here is called "${request.account}"`,
          );
        }
        pin = { id: account.id, alias: request.account };
      }
    }
    if (request.readOnly && !facts.readOnlySwitch) {
      throw new CommsError('USAGE', `${facts.label} cannot be kept to reading: only Gmail has a read-only switch`, {
        hint: "Slack's and Resend's accounts keep their own read mode; set it on the account.",
      });
    }
    parts.push({
      server: facts.server,
      ...(pin === undefined ? {} : { pin }),
      ...(request.readOnly ? { readOnly: true } : {}),
    });
  }
  return parts;
}

/** A new connection's parts when none are named (§6.1): core, each channel with an account here, and Events if installed. */
async function defaultParts(core: Pick<Core, 'paths'>, config: Config): Promise<ConnectionPart[]> {
  const platforms = new Set(connectedAccounts(config).map((account) => account.platform));
  const parts: ConnectionPart[] = [{ server: 'core' }];
  for (const facts of PART_FACTS) {
    if (facts.kind !== 'channel' || facts.server === 'core') continue;
    if (platforms.has(facts.server)) parts.push({ server: facts.server });
  }
  const events = PART_FACTS.find((facts) => facts.kind === 'service');
  if (events !== undefined) {
    const pointer = await readPointer(core.paths.dataDir, launcherName(serverFacts(events.server).packageName)).catch(
      () => undefined,
    );
    if (pointer !== undefined) parts.push({ server: events.server });
  }
  return parts;
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One part of a connection, as the app and `connection list` show it. */
export interface ConnectionPartView {
  readonly server: string;
  readonly label: string;
  /** The account it is kept to, by its name now; null for every one, or for a part that reaches none. */
  readonly account: string | null;
  readonly readOnly: boolean;
  /** Whether it can be started now, and why not. */
  readonly available: boolean;
  readonly why: string | null;
  /** The part in a sentence: "Gmail, the mailbox cue/gmail, read-only". */
  readonly text: string;
}

/** A connection, as `connection list --json` gives it (§11): never its key or its hash. */
export interface ConnectionView {
  readonly id: string;
  readonly readable: boolean;
  readonly name: string | null;
  readonly app: ConnectionApp | null;
  readonly appLabel: string | null;
  readonly where: ConnectionRecord['where'] | null;
  readonly launcher: ConnectionLauncher | null;
  readonly parts: readonly ConnectionPartView[];
  /** The entry in its app: its name and file, whether it is there, and whether the key it carries is this one's. */
  readonly entry: {
    readonly name: string;
    readonly path: string | null;
    readonly present: boolean | null;
    readonly keyMatches: boolean | null;
  } | null;
  readonly key: { readonly issuedAt: string | null; readonly revoked: boolean };
  readonly createdAt: string | null;
  readonly lastUsed: string | null;
  /**
   * Whether `connection migrate` made it (D16), and the entries of their own it replaced, by server and entry name —
   * what `connection migrate --undo` registers again; null for a connection made any other way, which has nothing to
   * undo. Never where those entries were saved.
   */
  readonly migratedFrom: {
    readonly at: string;
    readonly entries: readonly { readonly server: string; readonly name: string }[];
  } | null;
  readonly problems: readonly string[];
}

/** What `connection show` adds: the gateways running for it now, and each part's state there. */
export interface ConnectionShown extends ConnectionView {
  readonly running: readonly GatewayStatus[];
}

function partViews(config: Config, record: ConnectionRecord): ConnectionPartView[] {
  return [...connectionReach({ readable: true, record, problems: [] })].map(([server, reach]) => {
    const facts = partFacts(server);
    const now =
      reach.pin === null
        ? null
        : facts?.accounts === 'inboxes'
          ? (findById(config, 'inbox', reach.pin.id)?.alias ?? null)
          : (findById(config, 'account', reach.pin.id)?.alias ?? null);
    const gone = reach.pin !== null && now === null;
    return {
      server,
      label: facts?.label ?? server,
      account: reach.pin === null ? null : (now ?? reach.pin.alias),
      readOnly: reach.readOnly,
      available: !gone,
      why: gone ? `the ${facts?.noun ?? 'account'} it is kept to, ${reach.pin?.alias}, is no longer connected` : null,
      text: partText(
        server,
        reach.pin === null ? reach : { ...reach, pin: { ...reach.pin, alias: now ?? reach.pin.alias } },
      ),
    };
  });
}

/** The app's config, read for the connection's entry: whether it is there, and whether its key is this one's. */
async function entryState(
  env: NodeJS.ProcessEnv,
  record: ConnectionRecord,
): Promise<{ present: boolean | null; keyMatches: boolean | null; path: string | null }> {
  if (record.app === 'manual' || record.entry === null) return { present: null, keyMatches: null, path: null };
  const scan = await scanRegisteredServers(envFor(env, record)).catch(() => null);
  if (scan === null) return { present: null, keyMatches: null, path: record.entry.path };
  const found = scan.servers.find(
    (server) =>
      server.client === APP_CLIENT[record.app as Exclude<ConnectionApp, 'manual'>] &&
      server.name === record.entry?.name &&
      connectionOfEntry(server.args) === record.id,
  );
  if (found === undefined) return { present: false, keyMatches: null, path: record.entry.path };
  // Compared by its hash, in constant time; neither the key nor the hash is ever printed.
  return {
    present: true,
    keyMatches: connectionKeyMatches(found.env?.[CONNECTION_KEY_ENV], record.keyHash),
    path: found.path,
  };
}

async function viewOf(
  core: Core,
  env: NodeJS.ProcessEnv,
  config: Config,
  read: ConnectionRead,
): Promise<ConnectionView> {
  if (!read.readable) {
    return {
      id: read.id,
      readable: false,
      name: read.name,
      app: null,
      appLabel: null,
      where: null,
      launcher: null,
      parts: [],
      entry: null,
      key: { issuedAt: null, revoked: false },
      createdAt: null,
      lastUsed: null,
      migratedFrom: null,
      problems: read.problems,
    };
  }
  const { record } = read;
  const entry = record.entry === null ? null : await entryState(env, record);
  return {
    id: record.id,
    readable: true,
    name: record.name,
    app: record.app,
    appLabel: APP_LABELS[record.app],
    where: record.where,
    launcher: record.launcher,
    parts: partViews(config, record),
    entry:
      record.entry === null || entry === null
        ? null
        : { name: record.entry.name, path: entry.path, present: entry.present, keyMatches: entry.keyMatches },
    key: { issuedAt: record.keyIssuedAt, revoked: record.revokedAt !== null },
    createdAt: record.createdAt,
    lastUsed: await connectionLastUsed(core.paths.stateDir, record.id),
    migratedFrom:
      record.migratedFrom === undefined
        ? null
        : {
            at: record.migratedFrom.at,
            entries: record.migratedFrom.entries.map((entry) => ({ server: entry.server, name: entry.name })),
          },
    problems: read.problems,
  };
}

/** Every connection here (`connection list`, `comms_connections_list`): never a key, nor its hash. */
export async function connectionList(
  core: Core,
  env: NodeJS.ProcessEnv,
): Promise<{ connections: ConnectionView[]; problems: string[] }> {
  const config = await core.config.load();
  const { connections, problems } = readConnections(config);
  return {
    connections: await Promise.all(connections.map((read) => viewOf(core, env, config, read))),
    problems: [...problems],
  };
}

/**
 * One connection (`connection show`, `comms_connection_show`), with the gateways running for it and each part's state.
 * With no id, inside a part of a connection, it is that connection: "which connection am I" (D3).
 */
export async function connectionShow(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: { id?: string | undefined },
): Promise<ConnectionShown> {
  const id = request.id ?? connectionOfThisProcess(env);
  if (id === undefined || id === '') {
    throw new CommsError('USAGE', 'name the connection by its id: this is not one of a connection’s parts', {
      hint: 'connection list gives every connection’s id.',
    });
  }
  const read = requireConnection(await core.config.load(), id);
  const config = await core.config.load();
  const view = await viewOf(core, env, config, read);
  return { ...view, running: await runningGateways(core.paths.stateDir, id) };
}

function requireConnection(config: Config, id: unknown): ConnectionRead {
  if (typeof id !== 'string' || !CONNECTION_ID_PATTERN.test(id)) {
    throw new CommsError('USAGE', `"${String(id).slice(0, 40)}" is not a connection's id`, {
      hint: 'A connection’s id is cn_ and 26 letters and digits: connection list gives them.',
    });
  }
  const read = connectionById(config, id);
  if (read === undefined) throw new CommsError('NOT_FOUND', `no connection here has the id ${id}`);
  return read;
}

function requireReadable(config: Config, id: unknown): ConnectionRecord {
  const read = requireConnection(config, id);
  if (!read.readable) {
    throw new CommsError('CONFIG', `connection ${read.id} could not be read, so it can only be removed`, {
      hint: read.problems.join(' '),
    });
  }
  return read.record;
}

/** The environment a connection's app is found in: another Claude profile's or Codex home's folder when it has one. */
function envFor(env: NodeJS.ProcessEnv, record: Pick<ConnectionRecord, 'app' | 'where'>): NodeJS.ProcessEnv {
  const dir = record.where.configDir;
  if (dir === null) return env;
  if (record.app === 'claude-code') return { ...env, CLAUDE_CONFIG_DIR: dir };
  if (record.app === 'codex') return { ...env, CODEX_HOME: dir };
  return env;
}

// ── Add ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ConnectionAddRequest {
  readonly app: ConnectionApp;
  readonly name: string;
  /** Its parts; left out, the defaults (§6.1). */
  readonly parts?: readonly PartRequest[] | undefined;
  /** Claude Code for one project: its folder, where the entry goes at local scope (D18). */
  readonly folder?: string | undefined;
  /** Another Claude profile's folder, or another Codex home (D18). */
  readonly profile?: string | undefined;
  readonly launcher?: ConnectionLauncher | undefined;
  /** For a test, or an install with no way to start it: register without starting the entry once. */
  readonly noVerify?: boolean | undefined;
}

export interface ConnectionAddResult {
  readonly connection: ConnectionView;
  /** What the person does next, in plain words: restart the app, or paste the snippet. */
  readonly next: string;
  /** Manual only, and shown this once: the snippet in each format, with the key in it. */
  readonly snippets?: { readonly json: string; readonly toml: string; readonly vscode: string } | undefined;
  /** How the entry's first start went, for every type but Manual. */
  readonly verification?: ServerInstallResult['verification'] | undefined;
  readonly verifyDetail?: string | undefined;
}

/** A free name for a connection's entry in its app (D18): `agentcomms`, or `agentcomms-<slug>` when that is taken. */
async function entryName(
  env: NodeJS.ProcessEnv,
  client: SupportedClient,
  connectionName: string,
  scope: 'user' | 'local',
  folder: string | undefined,
  own?: string,
): Promise<string> {
  const scan = await scanRegisteredServers(env);
  const taken = (name: string) =>
    scan.servers.some(
      (server) =>
        server.client === client &&
        server.name === name &&
        (scope === 'local' ? server.scope === 'project' && server.folder === folder : server.scope !== 'project') &&
        connectionOfEntry(server.args) !== own,
    );
  // Core's own server name, from its manifest: what an entry of Agent Comms is called unless it is taken.
  const base = serverFacts('core').defaultServerName;
  if (!taken(base)) return base;
  const slug =
    connectionName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'connection';
  for (let index = 1; index < 100; index += 1) {
    const name = index === 1 ? `${base}-${slug}` : `${base}-${slug}-${index}`;
    if (!taken(name)) return name;
  }
  throw new CommsError('CONFIG', `${client} has every name this would give the entry already`);
}

/** The snippets a Manual connection's person pastes, with the key in them: shown once, never stored. */
function manualSnippets(command: string, args: readonly string[], key: string, env: Record<string, string>) {
  const entry = { command, args: [...args], env: { ...env, [CONNECTION_KEY_ENV]: key } };
  const name = 'agentcomms';
  const toml = [
    `[mcp_servers.${name}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    '',
    `[mcp_servers.${name}.env]`,
    ...Object.entries(entry.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
  ].join('\n');
  return {
    json: `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`,
    toml: `${toml}\n`,
    vscode: `${JSON.stringify({ servers: { [name]: { type: 'stdio', ...entry } } }, null, 2)}\n`,
  };
}

/**
 * Adding a connection, as a change (§6.2: a loosening). The plan names everything that decides what the connection
 * reaches — its parts, their accounts, read-only — and where its entry goes and what it starts, and any runtime it
 * installs; the approval binds those. Applied, the record is written, then each missing runtime installed and the
 * entry registered; an entry that cannot be registered takes the record out again.
 */
export function connectionAddChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ConnectionAddRequest,
  surface: ChangeSurface,
  deps: ServerInstallDeps = {},
): GatedChange<ConnectionAddResult> {
  if (!(CONNECTION_APPS as readonly unknown[]).includes(request.app)) {
    throw new CommsError('USAGE', `"${String(request.app).slice(0, 40)}" is not an app a connection is made for`, {
      hint: `One of: ${CONNECTION_APPS.join(', ')}.`,
    });
  }
  if (request.app === 'manual') refuseKeyToAgent(env, surface);
  const nameProblem = connectionNameProblem(request.name);
  if (nameProblem !== null) throw new CommsError('USAGE', nameProblem);
  if (request.launcher !== undefined && !CONNECTION_LAUNCHERS.includes(request.launcher)) {
    throw new CommsError('USAGE', `"${String(request.launcher)}" is not a launcher`, {
      hint: `One of: ${CONNECTION_LAUNCHERS.join(', ')}.`,
    });
  }
  if (request.folder !== undefined && request.app !== 'claude-code') {
    throw new CommsError('USAGE', 'one project is for Claude Code only in this release', {
      hint: 'Other apps keep a project’s servers in files that are often committed, and would carry the key into the repository.',
    });
  }
  if (request.profile !== undefined && request.app !== 'claude-code' && request.app !== 'codex') {
    throw new CommsError('USAGE', 'another profile is for Claude Code (CLAUDE_CONFIG_DIR) and Codex (CODEX_HOME) only');
  }
  const launcher = request.launcher ?? 'managed';
  const scope: 'user' | 'local' = request.folder === undefined ? 'user' : 'local';
  // The folder as the app will name it — its real path — and one that is there: the entry is run in it.
  let folder: string | undefined;
  if (request.folder !== undefined) {
    try {
      folder = realpathSync(resolve(request.folder));
    } catch {
      throw new CommsError('NOT_FOUND', `${request.folder} is not a folder here`, {
        hint: 'Name the project folder the connection is for, as it is on this Mac.',
      });
    }
  }
  let planned:
    | {
        record: ConnectionRecord;
        key: string;
        subs: GatedChange<ServerInstallResult>[];
        gateway?: GatedChange<ServerInstallResult>;
      }
    | undefined;
  return {
    plan: async (config): Promise<ChangeRequest> => {
      const taken = readConnections(config).connections.some(
        (read) => (read.readable ? read.record.name : (read.name ?? '')).toLowerCase() === request.name.toLowerCase(),
      );
      if (taken) {
        throw new CommsError('USAGE', `you have a connection called "${request.name}" already: nothing was changed`, {
          hint: 'Give this one another name.',
        });
      }
      const parts = request.parts === undefined ? await defaultParts(core, config) : partsOf(config, request.parts);
      const now = new Date().toISOString();
      const key = newConnectionKey();
      const id = newConnectionId();
      const client = request.app === 'manual' ? null : APP_CLIENT[request.app];
      const appEnv = envFor(env, {
        app: request.app,
        where: { scope, folder: folder ?? null, configDir: request.profile ?? null },
      });
      const name =
        client === null
          ? serverFacts('core').defaultServerName
          : await entryName(appEnv, client, request.name, scope, folder);
      const record: ConnectionRecord = {
        id,
        name: request.name,
        app: request.app,
        where: { scope, folder: folder ?? null, configDir: request.profile ?? null },
        entry: client === null ? null : { name, path: null },
        launcher,
        parts,
        keyHash: connectionKeyHash(key),
        keyIssuedAt: now,
        createdAt: now,
        revokedAt: null,
      };
      const subs = launcher === 'managed' ? await runtimeInstalls(core, env, parts, deps) : [];
      const effects: string[] = [];
      for (const sub of subs) effects.push(...((await sub.plan(config)).effects ?? []));
      let gateway: GatedChange<ServerInstallResult> | undefined;
      if (client !== null) {
        gateway = serverInstallChange(
          core,
          appEnv,
          {
            channel: 'core',
            client,
            name,
            launcher,
            ...(request.noVerify ? { noVerify: true } : {}),
            connection: { id, name: request.name, key, scope, ...(folder === undefined ? {} : { folder }) },
          },
          undefined,
          deps,
        );
        effects.push(...((await gateway.plan(config)).effects ?? []));
      } else {
        effects.push(
          'shows its snippet once, with its key in it, for you to paste into the app yourself: Agent Comms writes it nowhere',
        );
      }
      planned = { record, key, subs, ...(gateway === undefined ? {} : { gateway }) };
      return {
        before: config,
        after: { ...config, connections: withConnection(config, { put: record }) } as Config,
        effects,
        summary: `Add the connection "${request.name}" for ${APP_LABELS[request.app]}`,
      };
    },
    apply: async (consent): Promise<ConnectionAddResult> => {
      if (planned === undefined) throw new CommsError('UNEXPECTED', 'the connection was added before it was planned');
      const { record, key, subs, gateway } = planned;
      await core.config.update(
        (config) => ({ ...config, connections: withConnection(config, { put: record }) }) as Config,
        consent === undefined ? {} : { consent },
      );
      try {
        for (const sub of subs) await sub.apply(undefined, await sub.plan(await core.config.load()));
        let installed: ServerInstallResult | undefined;
        if (gateway !== undefined) {
          installed = await gateway.apply(undefined, await gateway.plan(await core.config.load()));
          if (!installed.applied) {
            throw new CommsError(
              'PROVIDER_UNAVAILABLE',
              installed.notApplied ?? 'the connection’s entry was not written',
              {
                hint: 'Nothing was added: the connection was taken out again. Install the app’s own command line, or add a Manual connection and paste its snippet.',
              },
            );
          }
          const path =
            installed.configPath ??
            (record.app === 'claude-code' ? join(claudeDir(env, record), '.claude.json') : null);
          await core.config.update((config) => {
            const read = connectionById(config, record.id);
            if (read === undefined || !read.readable) return config;
            return {
              ...config,
              connections: withConnection(config, {
                put: {
                  ...read.record,
                  entry: { name: installed?.name ?? record.entry?.name ?? serverFacts('core').defaultServerName, path },
                },
              }),
            } as Config;
          });
        }
        await audit(
          core,
          surface,
          'connection.add',
          record.id,
          `${record.app}: ${record.parts.map((part) => part.server).join(', ')}`,
        );
        const config = await core.config.load();
        const read = connectionById(config, record.id) as ConnectionRead;
        const view = await viewOf(core, env, config, read);
        if (record.app === 'manual') {
          const { command, args, env: base } = await manualEntry(core, env, record, launcher);
          return {
            connection: view,
            next: 'Paste the snippet into the app’s settings, then restart the app. This is the only time the key is shown: lost, replace the key for a new one.',
            snippets: manualSnippets(command, args, key, base),
          };
        }
        return {
          connection: view,
          next:
            record.where.scope === 'local'
              ? `Open ${shortenHome(record.where.folder ?? '', homeDirectory(env))} in ${APP_LABELS[record.app]}, or restart it there, to use the connection.`
              : `Restart ${APP_LABELS[record.app]} to use the connection: no app loads a new server into a session that is already running.`,
          ...(installed === undefined
            ? {}
            : {
                verification: installed.verification,
                ...(installed.verifyDetail === undefined ? {} : { verifyDetail: installed.verifyDetail }),
              }),
        };
      } catch (error) {
        // Not registered: the record goes again, so no key is left that nothing carries.
        await core.config
          .update((config) => ({ ...config, connections: withConnection(config, { remove: record.id }) }) as Config)
          .catch(() => undefined);
        throw error;
      }
    },
  };
}

function claudeDir(env: NodeJS.ProcessEnv, record: Pick<ConnectionRecord, 'where'>): string {
  return record.where.configDir ?? env.CLAUDE_CONFIG_DIR ?? homeDirectory(env);
}

/** The command a Manual connection's snippet starts: core's launcher, the four folders, `mcp --connection <id>`. */
async function manualEntry(
  core: Core,
  env: NodeJS.ProcessEnv,
  record: ConnectionRecord,
  launcher: ConnectionLauncher,
): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const gateway = serverInstallChange(
    core,
    env,
    {
      channel: 'core',
      client: 'json',
      launcher,
      noVerify: true,
      print: true,
      connection: { id: record.id, name: record.name, key: '' },
    },
    undefined,
    {},
  );
  const printed = await gateway.apply(undefined, await gateway.plan(await core.config.load()));
  const { [CONNECTION_KEY_ENV]: _key, ...base } = printed.entry.env;
  return { command: printed.entry.command, args: printed.entry.args, env: base };
}

/**
 * The runtimes a managed connection's parts need that this machine does not have at this release: each a verified
 * install, as `mcp install --client json` makes one — fetched, checked, and the part's launcher pointed at it.
 */
async function runtimeInstalls(
  core: Core,
  env: NodeJS.ProcessEnv,
  parts: readonly ConnectionPart[],
  deps: ServerInstallDeps,
): Promise<GatedChange<ServerInstallResult>[]> {
  const subs: GatedChange<ServerInstallResult>[] = [];
  for (const part of parts) {
    const facts = serverFacts(part.server);
    const pointer = await readPointer(core.paths.dataDir, launcherName(facts.packageName)).catch(() => undefined);
    if (pointer?.current === managedRuntimeDir(core.paths.dataDir, facts.packageName, VERSION)) continue;
    subs.push(
      serverInstallChange(core, env, { channel: part.server, client: 'json', noVerify: true }, undefined, deps),
    );
  }
  return subs;
}

async function audit(
  core: Core,
  surface: ChangeSurface,
  operation: string,
  connection: string,
  reason: string,
): Promise<void> {
  await core.audit.append({ inboxId: '', operation, outcome: 'ok', surface, connection, reason });
}

// ── Change parts ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ConnectionChangeRequest {
  readonly id: string;
  /** Every part it should have from now on. */
  readonly parts: readonly PartRequest[];
  /**
   * The approval this call claims, when it claims one — `--approval`, `--app-approval`, a tool's `approvalId`: what its
   * preparation narrowed at once is read from it, so a claim planned from a record narrowed already binds the same.
   */
  readonly approvalId?: string | undefined;
}

export interface ConnectionChangeResult {
  readonly connection: ConnectionView;
  /**
   * What was applied at once, before anything waited: the narrowings — this call's, and, on a claim, those its
   * preparation made, which the approval it claims records.
   */
  readonly appliedAtOnce: readonly string[];
  readonly next: string;
}

/** The narrowing of `from` toward `to`: parts taken out, pins added, read-only on — nothing that reaches more. */
function narrowing(from: readonly ConnectionPart[], to: readonly ConnectionPart[]): ConnectionPart[] {
  const kept: ConnectionPart[] = [];
  for (const part of from) {
    const wanted = to.find((each) => each.server === part.server);
    if (wanted === undefined) continue;
    const pin = part.pin ?? wanted.pin;
    const readOnly = part.readOnly === true || wanted.readOnly === true;
    // A pin moved to another account is a loosening, not a narrowing: the old pin stays until it is approved.
    kept.push({ server: part.server, ...(pin === undefined ? {} : { pin }), ...(readOnly ? { readOnly: true } : {}) });
  }
  return kept;
}

/** What the change approval `approvalId` says its preparation did at once: none for anything but a valid change. */
async function approvalDoneAtOnce(core: Core, approvalId: string | undefined): Promise<readonly string[]> {
  if (approvalId === undefined) return [];
  const stored = await core.approvals.get(approvalId).catch(() => null);
  return stored?.form === 'v2' && stored.record.kind === 'change' ? (stored.record.change?.doneAtOnce ?? []) : [];
}

/**
 * Of the narrowings an approval says its preparation made, those the record still shows made, in the approval's order
 * — a part taken out that is not there, one kept to the account the line names, one read-only — so a claim says only
 * what is true of the record it plans from. A line the record does not bear out is left out: the claim then binds
 * otherwise than the approval, and is refused — prepare it again.
 */
function stillNarrowed(config: Config, lines: readonly string[], parts: readonly ConnectionPart[]): string[] {
  return lines.filter((line) =>
    PART_FACTS.some((facts) => {
      const part = parts.find((each) => each.server === facts.server);
      if (line === `${facts.label} taken out`) return part === undefined;
      if (line === `${facts.label} read-only`) return part?.readOnly === true;
      if (!line.startsWith(`${facts.label} kept to `) || part?.pin === undefined) return false;
      const alias =
        facts.accounts === 'inboxes'
          ? (findById(config, 'inbox', part.pin.id)?.alias ?? part.pin.alias)
          : (findById(config, 'account', part.pin.id)?.alias ?? part.pin.alias);
      return line === `${facts.label} kept to ${alias}`;
    }),
  );
}

/**
 * A refusal raised after this call narrowed at once, saying so: its "nothing was changed" made true, and what was done
 * in `details.appliedAtOnce`, as `org update` says a narrowing done before a refusal. Its own code, hint and details.
 */
function saidNarrowed(error: unknown, done: readonly string[]): unknown {
  if (!(error instanceof CommsError) || done.length === 0) return error;
  return new CommsError(
    error.code,
    error.message.replace('nothing was changed', `${done.join('; ')} at once; nothing else was changed`),
    {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      details: { ...(error.details ?? {}), appliedAtOnce: [...done] },
      cause: error,
    },
  );
}

/**
 * Changing a connection's parts (§6.2): every narrowing applies at once — a part taken out, a pin added, read-only on —
 * even beside a change that waits, as `comms_org_update` narrows; what reaches more — a part added, a pin taken away or
 * moved, read-only off — is prepared, shown and approved. A part added on a managed connection installs its runtime.
 *
 * What narrowed at once while the rest waits is the waiting preview's to say (the lead's call for 0.35.0, as `org
 * update` marks a tightening done): bound into the approval as `doneAtOnce`, so the preview lists it apart, done
 * already, and its header says the rest is what waits. A claim plans from a record narrowed already, and learns what
 * was done from this change's own earlier call at a terminal, or — from a chat, where each call builds the change
 * afresh — from the approval it claims, each line held to the record it says it left (`stillNarrowed`). The result and
 * the audit say it again.
 */
export function connectionChangeChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ConnectionChangeRequest,
  surface: ChangeSurface,
  deps: ServerInstallDeps = {},
): GatedChange<ConnectionChangeResult> {
  return partsChange(
    core,
    env,
    { id: request.id, approvalId: request.approvalId, target: (config) => partsOf(config, request.parts) },
    surface,
    deps,
  );
}

/**
 * The change of a connection's parts to what `target` says, from the configuration and the record as they are now:
 * `connection change`'s every part, or one part put in by a channel's `mcp install` (`connectionPartChange`).
 */
function partsChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: {
    readonly id: string;
    readonly approvalId?: string | undefined;
    readonly target: (config: Config, record: ConnectionRecord) => ConnectionPart[];
  },
  surface: ChangeSurface,
  deps: ServerInstallDeps,
): GatedChange<ConnectionChangeResult> {
  /** What this change narrowed at once on an earlier call of its own: a terminal's prepare, before its claim. */
  let doneEarlier: string[] = [];
  let doneAtOnce: string[] = [];
  let subs: GatedChange<ServerInstallResult>[] = [];
  let target: ConnectionPart[] = [];
  return {
    plan: async (given): Promise<ChangeRequest> => {
      let config = given;
      let record = requireReadable(config, request.id);
      target = request.target(config, record);
      let doneNow: string[] = [];
      try {
        const narrowed = narrowing(record.parts, target);
        if (JSON.stringify(narrowed) !== JSON.stringify(record.parts)) {
          const before = record;
          await core.config.update((now) => {
            const read = connectionById(now, before.id);
            if (read === undefined || !read.readable) return now;
            return {
              ...now,
              connections: withConnection(now, {
                put: { ...read.record, parts: narrowing(read.record.parts, target) },
              }),
            } as Config;
          });
          doneNow = describeNarrowing(config, before.parts, narrowed);
          await audit(core, surface, 'connection.update', before.id, `narrowed at once: ${doneNow.join('; ')}`);
          config = await core.config.load();
          record = requireReadable(config, request.id);
        }
        const doneBefore =
          doneEarlier.length > 0
            ? doneEarlier
            : stillNarrowed(config, await approvalDoneAtOnce(core, request.approvalId), record.parts);
        doneAtOnce = [...doneBefore, ...doneNow.filter((line) => !doneBefore.includes(line))];
        doneEarlier = doneAtOnce;
        const added = target.filter((part) => !record.parts.some((had) => had.server === part.server));
        subs = record.launcher === 'managed' ? await runtimeInstalls(core, env, added, deps) : [];
        const effects: string[] = [];
        for (const sub of subs) effects.push(...((await sub.plan(config)).effects ?? []));
        return {
          before: config,
          after: { ...config, connections: withConnection(config, { put: { ...record, parts: target } }) } as Config,
          effects,
          // What narrowed at once is bound beside what waits, and the preview lists it apart, done already.
          ...(doneAtOnce.length > 0 ? { doneAtOnce } : {}),
          summary: `Let agents in "${record.name}" reach more${doneAtOnce.length > 0 ? '; what narrows was applied at once' : ''}`,
        };
      } catch (error) {
        throw saidNarrowed(error, doneNow);
      }
    },
    apply: async (consent): Promise<ConnectionChangeResult> => {
      for (const sub of subs) await sub.apply(undefined, await sub.plan(await core.config.load()));
      await core.config.update(
        (config) => {
          const read = connectionById(config, request.id);
          if (read === undefined || !read.readable)
            throw new CommsError('NOT_FOUND', `no connection here has the id ${request.id}`);
          return {
            ...config,
            connections: withConnection(config, { put: { ...read.record, parts: target } }),
          } as Config;
        },
        consent === undefined ? {} : { consent },
      );
      if (consent !== undefined)
        await audit(
          core,
          surface,
          'connection.update',
          request.id,
          `parts: ${target.map((part) => part.server).join(', ')}${doneAtOnce.length > 0 ? `; narrowed at once as this was prepared: ${doneAtOnce.join('; ')}` : ''}`,
        );
      const config = await core.config.load();
      const read = connectionById(config, request.id) as ConnectionRead;
      const view = await viewOf(core, env, config, read);
      return {
        connection: view,
        appliedAtOnce: [...doneAtOnce],
        next: 'A running app sees the new parts at once, through tools/list_changed, where it supports it; otherwise restart it.',
      };
    },
    refuseApproval: () =>
      new CommsError(
        'USAGE',
        'nothing was changed: as things stand this change only narrows, so it takes no approval',
        {
          hint: 'Make the same call again without the approval: it applies at once.',
        },
      ),
  };
}

function describeNarrowing(config: Config, from: readonly ConnectionPart[], to: readonly ConnectionPart[]): string[] {
  const lines: string[] = [];
  for (const part of from) {
    const facts = partFacts(part.server);
    const label = facts?.label ?? part.server;
    const now = to.find((each) => each.server === part.server);
    if (now === undefined) {
      lines.push(`${label} taken out`);
      continue;
    }
    if (part.pin === undefined && now.pin !== undefined) {
      const alias =
        facts?.accounts === 'inboxes'
          ? (findById(config, 'inbox', now.pin.id)?.alias ?? now.pin.alias)
          : (findById(config, 'account', now.pin.id)?.alias ?? now.pin.alias);
      lines.push(`${label} kept to ${alias}`);
    }
    if (part.readOnly !== true && now.readOnly === true) lines.push(`${label} read-only`);
  }
  return lines;
}

// ── One part, from a channel's own `mcp install` (D17) ──────────────────────────────────────────────────────

export interface ConnectionPartRequest {
  /** The part: a declared server — the channel whose own `mcp install` asks for it. */
  readonly server: string;
  /** The app whose connection it goes into, by the word `mcp install --client` names it. */
  readonly app: string;
  /** The connection, by its id: needed when the app has several, and held to be the app's. */
  readonly id?: string | undefined;
  /** The account it is kept to, `organisation/platform`; left out, every account. */
  readonly account?: string | undefined;
  readonly readOnly?: boolean | undefined;
  /** How a connection this makes starts its parts — managed, the default. One that is there keeps its own. */
  readonly launcher?: ConnectionLauncher | undefined;
  /** For a connection this makes: register its entry without starting it once. */
  readonly noVerify?: boolean | undefined;
  /** The approval this call claims, when it claims one: see `ConnectionChangeRequest.approvalId`. */
  readonly approvalId?: string | undefined;
}

export interface ConnectionPartResult {
  readonly connection: ConnectionView;
  /** Whether this made the connection: the app had none, so it was made with Agent Comms itself and this part. */
  readonly created: boolean;
  /** Whether anything changed: false when the part was there already, as asked. */
  readonly changed: boolean;
  /** What was applied at once, before anything waited: see `ConnectionChangeResult.appliedAtOnce`. */
  readonly appliedAtOnce: readonly string[];
  readonly next: string;
  /** How a connection this made first started, for every type but Manual. */
  readonly verification?: ServerInstallResult['verification'] | undefined;
  readonly verifyDetail?: string | undefined;
}

/** The profile folder `env` gives an app — Claude Code's `CLAUDE_CONFIG_DIR`, Codex's `CODEX_HOME` — or null. */
function profileOf(env: NodeJS.ProcessEnv, app: ConnectionApp): string | null {
  const dir = app === 'claude-code' ? env.CLAUDE_CONFIG_DIR : app === 'codex' ? env.CODEX_HOME : undefined;
  return dir === undefined || dir === '' ? null : resolve(dir);
}

/**
 * What `mcp install --client <app>` means by the app's connection: the app's, serving, for every folder — user scope,
 * where `mcp install` has always registered — in the profile this environment gives the app. One for one project, or
 * for another profile, is another place the app uses Agent Comms, never this one.
 */
function appConnections(config: Config, env: NodeJS.ProcessEnv, app: ConnectionApp): ConnectionRecord[] {
  const profile = profileOf(env, app);
  return readConnections(config).connections.flatMap((read) => {
    if (!read.readable) return [];
    const { record } = read;
    const here =
      record.where.configDir === null
        ? profile === null
        : profile !== null && resolve(record.where.configDir) === profile;
    return record.revokedAt === null && record.app === app && record.where.scope === 'user' && here ? [record] : [];
  });
}

/**
 * The app's connection a channel's own `mcp install --client <app>` puts its part into (`appConnections`), with that
 * part, when the connection has it: what a finish checks before it puts the part in again — Gmail's `setup` hands its
 * registration to the finish of a sign-in. Null when the app has no such connection, has several (`mcp install` then
 * names none), or the connection has no part of `server`.
 */
export function appConnectionPart(
  config: Config,
  env: NodeJS.ProcessEnv,
  app: string,
  server: string,
): { readonly connection: ConnectionRecord; readonly part: ConnectionPart } | null {
  if (app === 'manual' || !(CONNECTION_APPS as readonly unknown[]).includes(app)) return null;
  const mine = appConnections(config, env, app as ConnectionApp);
  if (mine.length !== 1) return null;
  const connection = mine[0] as ConnectionRecord;
  const part = connection.parts.find((each) => each.server === server);
  return part === undefined ? null : { connection, part };
}

/** A name no connection here has, ignoring case: `Claude Code`, then `Claude Code 2`, and so on. */
function freeConnectionName(config: Config, base: string): string {
  const taken = new Set(
    readConnections(config).connections.map((read) =>
      (read.readable ? read.record.name : (read.name ?? '')).toLowerCase(),
    ),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 100; index += 1) {
    const name = `${base} ${index}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  throw new CommsError('CONFIG', `you have a connection under every name this would give one for ${base}`);
}

/** `parts` with `part` in its place — the part of the same server replaced, or a new one put last. */
function putPart(parts: readonly ConnectionPart[], part: ConnectionPart): ConnectionPart[] {
  return parts.some((had) => had.server === part.server)
    ? parts.map((had) => (had.server === part.server ? part : had))
    : [...parts, part];
}

/** Parts as `--parts` names them — `core,gmail:cue/gmail:read-only` — each account by the name it has now. */
function partsWords(config: Config, parts: readonly ConnectionPart[]): string {
  return parts
    .map((part) => {
      const facts = partFacts(part.server);
      const alias =
        part.pin === undefined
          ? undefined
          : facts?.accounts === 'inboxes'
            ? (findById(config, 'inbox', part.pin.id)?.alias ?? part.pin.alias)
            : (findById(config, 'account', part.pin.id)?.alias ?? part.pin.alias);
      return [part.server, ...(alias === undefined ? [] : [alias]), ...(part.readOnly ? ['read-only'] : [])].join(':');
    })
    .join(',');
}

/**
 * Refuses, before anything is written or prepared, a change from a process that cannot verify a release — a channel's
 * own `mcp install`, which carries no Sigstore — that would install the runtime of another release than the one it is
 * running (owner's decision, 2026-10-17): a connection it makes starts Agent Comms itself, whose runtime may not be here
 * yet. Core's own command, located, does the same change and verifies what it installs.
 */
async function refuseUnverifiable(
  core: Core,
  servers: readonly string[],
  deps: ServerInstallDeps,
  coreWords: readonly string[],
): Promise<void> {
  if (deps.verifyRelease !== undefined) return;
  for (const server of servers) {
    const facts = serverFacts(server);
    if (deps.running?.packageName === facts.packageName) continue;
    const { dataDir } = core.paths;
    const pointer = await readPointer(dataDir, launcherName(facts.packageName)).catch(() => undefined);
    if (pointer?.current === managedRuntimeDir(dataDir, facts.packageName, VERSION)) continue;
    if ((await reusableRuntime(dataDir, facts.packageName, VERSION)) !== null) continue;
    const instead = `Agent Comms verifies a release before it installs it: run its own connection command in your own terminal, or call comms_connection_change from a chat. Nothing was prepared to approve.`;
    let hint = instead;
    try {
      hint = handoffSentence(
        requireHandoffs(core, deps.platform).core(coreWords),
        (command) =>
          `Agent Comms verifies a release before it installs it: run ${command} in your own terminal, or call comms_connection_change from a chat. Nothing was prepared to approve.`,
        { instead },
      );
    } catch {
      // A core opened with no caller names no command: the words alone.
    }
    throw unverifiedRelease(
      facts.packageName,
      VERSION,
      'this command cannot check provenance, and the connection would install it',
      'verifier',
      'install',
      hint,
    );
  }
}

/**
 * What the app reaches already through an entry of its own, beside the connection — the part's server, and Agent Comms
 * itself for a connection this makes: said in the preview, never refused (§14, "Two Agent Comms in one app"), since
 * the agent would see those tools twice. An app's config that cannot be read says nothing here.
 */
async function alreadyOnTheirOwn(
  env: NodeJS.ProcessEnv,
  app: Exclude<ConnectionApp, 'manual'>,
  servers: readonly string[],
): Promise<string[]> {
  const scan = await scanRegisteredServers(env).catch(() => null);
  if (scan === null) return [];
  const lines: string[] = [];
  for (const server of servers) {
    for (const entry of scan.servers) {
      if (entry.client !== APP_CLIENT[app] || entry.scope === 'project' || connectionOfEntry(entry.args) !== null) {
        continue;
      }
      if (!isProductServer(entry, serverFacts(server))) continue;
      lines.push(
        `${APP_LABELS[app]} reaches ${partLabel(server)} through its own entry "${entry.name}" already: as a part of the connection too, the agent sees the same tools twice — connection migrate moves that entry into the connection`,
      );
    }
  }
  return lines;
}

/**
 * A channel's own `mcp install` (single-server design D17, §9.2): that channel put into the app's connection, as one
 * part — kept to the account and read-only the command names — or, when the app has none, a connection made for it with
 * Agent Comms itself and that channel. `--standalone` keeps the separate entry of before (`serverInstallChange`), as a
 * way back for 0.35.
 *
 * - **Approved as every change to a connection is** (§6.2, §8.1): a part added, an account let go or moved, and
 *   read-only off are loosenings, prepared and shown — the preview names the connection — and approved; a pin added or
 *   read-only on narrows at once, said done in the waiting preview (`connectionChangeChange`). A connection made is a
 *   loosening as `connection add` is, and registers its one entry.
 * - **The app's connection** is the one for every folder, in the profile the environment gives the app
 *   (`appConnections`). Where it has several, the design is silent, and this does the narrowest thing: nothing, naming
 *   each by its id — `id` says which.
 * - **A connection that is there keeps how it starts its parts**: a `launcher` other than its own is refused.
 * - **A channel's own process cannot verify a release**, so one that would install another release's runtime — Agent
 *   Comms itself, for a connection it makes — is refused, naming core's own command (`refuseUnverifiable`).
 */
export function connectionPartChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ConnectionPartRequest,
  surface: ChangeSurface,
  deps: ServerInstallDeps = {},
): GatedChange<ConnectionPartResult> {
  if (request.app === 'manual' || !(CONNECTION_APPS as readonly unknown[]).includes(request.app)) {
    throw new CommsError('USAGE', `"${String(request.app).slice(0, 40)}" is not an app a connection's part goes into`, {
      hint: `One of: ${CONNECTION_APPS.filter((app) => app !== 'manual').join(', ')}.`,
    });
  }
  const app = request.app as Exclude<ConnectionApp, 'manual'>;
  const facts = partFacts(request.server);
  if (facts === undefined) {
    throw new CommsError('USAGE', `"${String(request.server).slice(0, 40)}" is not a part a connection can have`, {
      hint: `One of: ${PART_FACTS.map((each) => each.server).join(', ')}.`,
    });
  }
  if (request.launcher !== undefined && !CONNECTION_LAUNCHERS.includes(request.launcher)) {
    throw new CommsError('USAGE', `"${String(request.launcher)}" is not a launcher`, {
      hint: `One of: ${CONNECTION_LAUNCHERS.join(', ')}.`,
    });
  }
  const asked: PartRequest = {
    server: facts.server,
    ...(request.account === undefined ? {} : { account: request.account }),
    ...(request.readOnly ? { readOnly: true } : {}),
  };
  let planned:
    | { kind: 'create'; change: GatedChange<ConnectionAddResult> }
    | { kind: 'add'; change: GatedChange<ConnectionChangeResult>; name: string; unchanged: boolean }
    | undefined;
  /** The connection the part goes into: the one named, the app's only one, or none — one to make. */
  const chosen = (config: Config): ConnectionRecord | null => {
    if (request.id !== undefined) {
      const record = requireReadable(config, request.id);
      if (record.app !== app) {
        throw new CommsError(
          'USAGE',
          `"${record.name}" is a connection for ${APP_LABELS[record.app]}, not ${APP_LABELS[app]}`,
        );
      }
      if (record.revokedAt !== null) throw new CommsError('USAGE', `"${record.name}" was cut off: it serves nothing`);
      return record;
    }
    const mine = appConnections(config, env, app);
    if (mine.length <= 1) return mine[0] ?? null;
    throw new CommsError(
      'USAGE',
      `${APP_LABELS[app]} has ${mine.length} connections for every folder, so ${facts.label} was put into none: say which`,
      {
        hint: `Name it by its id — ${mine.map((record) => `${record.id} ("${record.name}")`).join(', ')}: mcp install --connection <id>, or comms_connection_change with that id.`,
      },
    );
  };
  return {
    plan: async (config): Promise<ChangeRequest> => {
      const into = chosen(config);
      let request_: ChangeRequest;
      let servers: string[];
      if (into === null) {
        // None: a connection made for the app, with Agent Comms itself and this part (D17), named after the app.
        const name = freeConnectionName(config, APP_LABELS[app]);
        const parts: PartRequest[] = facts.server === 'core' ? [asked] : [{ server: 'core' }, asked];
        const launcher = request.launcher ?? 'managed';
        servers = parts.map((part) => part.server);
        if (launcher === 'managed') {
          const words = [
            'connection',
            'add',
            '--app',
            app,
            '--name',
            name,
            '--parts',
            partsWords(config, partsOf(config, parts)),
          ];
          await refuseUnverifiable(core, servers, deps, words);
        }
        const change = connectionAddChange(
          core,
          env,
          { app, name, parts, launcher, ...(request.noVerify ? { noVerify: true } : {}) },
          surface,
          deps,
        );
        planned = { kind: 'create', change };
        request_ = await change.plan(config);
      } else {
        if (request.launcher !== undefined && request.launcher !== into.launcher) {
          throw new CommsError(
            'USAGE',
            `"${into.name}" starts its parts ${into.launcher === 'managed' ? 'from managed runtimes' : `with ${into.launcher}`}, and a part is started as the others are: nothing was changed`,
            { hint: 'Leave out --launcher: the part is started the way the connection starts every part.' },
          );
        }
        servers = [facts.server];
        const target = (now: Config, record: ConnectionRecord) =>
          putPart(record.parts, partsOf(now, [asked])[0] as ConnectionPart);
        if (into.launcher === 'managed' && !into.parts.some((part) => part.server === facts.server)) {
          const words = ['connection', 'change', into.id, '--parts', partsWords(config, target(config, into))];
          await refuseUnverifiable(core, servers, deps, words);
        }
        const change = partsChange(core, env, { id: into.id, approvalId: request.approvalId, target }, surface, deps);
        request_ = await change.plan(config);
        // As asked already: nothing narrows, nothing reaches more, nothing is installed.
        const before = connectionById(request_.before, into.id);
        const after = connectionById(request_.after, into.id);
        const unchanged =
          before?.readable === true &&
          after?.readable === true &&
          JSON.stringify(before.record.parts) === JSON.stringify(after.record.parts) &&
          (request_.doneAtOnce ?? []).length === 0 &&
          (request_.effects ?? []).length === 0;
        planned = { kind: 'add', change, name: into.name, unchanged };
      }
      // What waits is said beside the tools the app reaches on their own already; what applies at once says nothing.
      const waits =
        classifyChange(request_.before, request_.after).loosened.length > 0 || (request_.effects ?? []).length > 0;
      const twice = waits ? await alreadyOnTheirOwn(env, app, servers) : [];
      return twice.length === 0 ? request_ : { ...request_, effects: [...(request_.effects ?? []), ...twice] };
    },
    apply: async (consent, request_): Promise<ConnectionPartResult> => {
      if (planned === undefined) throw new CommsError('UNEXPECTED', 'the part was added before it was planned');
      if (planned.kind === 'create') {
        const added = await planned.change.apply(consent, request_);
        return {
          connection: added.connection,
          created: true,
          changed: true,
          appliedAtOnce: [],
          next: added.next,
          ...(added.verification === undefined ? {} : { verification: added.verification }),
          ...(added.verifyDetail === undefined ? {} : { verifyDetail: added.verifyDetail }),
        };
      }
      const done = await planned.change.apply(consent, request_);
      return {
        connection: done.connection,
        created: false,
        changed: !planned.unchanged,
        appliedAtOnce: done.appliedAtOnce,
        next: planned.unchanged
          ? `${facts.label} is a part of "${planned.name}" already, as asked: nothing was changed.`
          : done.next,
      };
    },
    refuseApproval: (approvalId) =>
      planned?.change.refuseApproval?.(approvalId) ??
      new CommsError('USAGE', 'nothing was changed: as things stand this change needs no approval, so it takes none', {
        hint: 'Make the same call again without the approval: it applies at once.',
      }),
  };
}

// ── Rename, key, remove ─────────────────────────────────────────────────────────────────────────────────────────

/** Renaming a connection: neutral, so applied at once and audited (§6.2). Activity names it so from then on. */
export function connectionRenameChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: { id: string; name: string },
  surface: ChangeSurface,
): GatedChange<{ connection: ConnectionView; before: string }> {
  let before = '';
  return {
    plan: (config) => {
      const record = requireReadable(config, request.id);
      const problem = connectionNameProblem(request.name);
      if (problem !== null) throw new CommsError('USAGE', `${problem}: nothing was changed`);
      if (request.name === record.name) throw new CommsError('USAGE', 'nothing was changed: that is its name already');
      const clash = readConnections(config).connections.some(
        (read) =>
          (read.readable ? read.record.id : read.id) !== record.id &&
          (read.readable ? read.record.name : (read.name ?? '')).toLowerCase() === request.name.toLowerCase(),
      );
      if (clash)
        throw new CommsError('USAGE', `you have a connection called "${request.name}" already: nothing was changed`);
      before = record.name;
      return {
        before: config,
        after: { ...config, connections: withConnection(config, { put: { ...record, name: request.name } }) } as Config,
        summary: `Rename the connection "${record.name}" to "${request.name}"`,
      };
    },
    apply: async (_consent, planned) => {
      await core.config.update(() => planned.after);
      await audit(core, surface, 'connection.rename', request.id, `"${before}" to "${request.name}"`);
      const config = await core.config.load();
      return {
        connection: await viewOf(core, env, config, connectionById(config, request.id) as ConnectionRead),
        before,
      };
    },
  };
}

export interface ConnectionKeyResult {
  readonly connection: ConnectionView;
  readonly next: string;
  /** Manual only, and shown this once: the snippet with the new key in it. */
  readonly snippets?: { readonly json: string; readonly toml: string; readonly vscode: string } | undefined;
}

/**
 * Replacing a connection's key (§6.2): neutral — a new key gives an agent nothing more — so applied at once and audited.
 * The old key stops working at once: a gateway checks it again when the record changes. For every type but Manual the
 * new key is written into the app's entry and never shown; a Manual connection's is a snippet shown once, at the
 * person's terminal or in the app only, never over MCP.
 */
export function connectionKeyReplaceChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: { id: string },
  surface: ChangeSurface,
  deps: ServerInstallDeps = {},
): GatedChange<ConnectionKeyResult> {
  let key = '';
  return {
    plan: (config) => {
      const record = requireReadable(config, request.id);
      if (record.app === 'manual') refuseKeyToAgent(env, surface);
      key = newConnectionKey();
      return {
        before: config,
        after: {
          ...config,
          connections: withConnection(config, {
            put: { ...record, keyHash: connectionKeyHash(key), keyIssuedAt: new Date().toISOString() },
          }),
        } as Config,
        summary: `Replace the key of the connection "${record.name}"`,
      };
    },
    apply: async (_consent, planned) => {
      await core.config.update(() => planned.after);
      const config = await core.config.load();
      const record = requireReadable(config, request.id);
      await audit(core, surface, 'connection.rotate', record.id, `${record.app}: the old key stopped working`);
      if (record.app === 'manual') {
        const { command, args, env: base } = await manualEntry(core, env, record, record.launcher);
        return {
          connection: await viewOf(core, env, config, connectionById(config, record.id) as ConnectionRead),
          next: 'Paste the new snippet into the app’s settings in place of the old one, then restart the app.',
          snippets: manualSnippets(command, args, key, base),
        };
      }
      const client = APP_CLIENT[record.app as Exclude<ConnectionApp, 'manual'>];
      const install = serverInstallChange(
        core,
        envFor(env, record),
        {
          channel: 'core',
          client,
          name: record.entry?.name ?? serverFacts('core').defaultServerName,
          launcher: record.launcher,
          noVerify: true,
          connection: {
            id: record.id,
            name: record.name,
            key,
            scope: record.where.scope,
            ...(record.where.folder === null ? {} : { folder: record.where.folder }),
          },
        },
        undefined,
        deps,
      );
      const done = await install.apply(undefined, await install.plan(config));
      return {
        connection: await viewOf(core, env, config, connectionById(config, record.id) as ConnectionRead),
        next: done.applied
          ? `The new key is in ${APP_LABELS[record.app]}’s entry: restart ${APP_LABELS[record.app]} to use it.`
          : `The old key stopped working, and the new one could not be written into ${APP_LABELS[record.app]}’s entry (${done.notApplied ?? 'not applied'}): add the connection again, or remove it.`,
      };
    },
  };
}

export interface ConnectionRemoveResult {
  readonly id: string;
  readonly name: string | null;
  readonly entry: {
    readonly removed: number;
    readonly kept: readonly { name: string; path: string; reason: string }[];
  };
  readonly next: string;
}

/**
 * Removing a connection (§6.2): a tightening, applied at once and audited. Its record goes — so its key stops working
 * at once, everywhere a copy of it is — and its entry is taken out of its app, saved first. A Manual snippet is the
 * person's to take out of their app; until then it serves nothing.
 */
export function connectionRemoveChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: { id: string },
  surface: ChangeSurface,
): GatedChange<ConnectionRemoveResult> {
  let held: ConnectionRead | undefined;
  return {
    plan: (config) => {
      held = requireConnection(config, request.id);
      return {
        before: config,
        after: { ...config, connections: withConnection(config, { remove: request.id }) } as Config,
        summary: `Remove the connection ${held.readable ? `"${held.record.name}"` : request.id}`,
      };
    },
    apply: async () => {
      await core.config.update(
        (config) => ({ ...config, connections: withConnection(config, { remove: request.id }) }) as Config,
      );
      const record = held?.readable ? held.record : undefined;
      let entry: ConnectionRemoveResult['entry'] = { removed: 0, kept: [] };
      if (record !== undefined && record.app !== 'manual' && record.entry !== null) {
        const context: InstallContext = { env: envFor(env, record), core };
        const removed = await removeConnectionEntry(
          context,
          APP_CLIENT[record.app as Exclude<ConnectionApp, 'manual'>],
          {
            name: record.entry.name,
            connection: record.id,
            scope: record.where.scope,
            ...(record.where.folder === null ? {} : { folder: record.where.folder }),
          },
        );
        entry = { removed: removed.removed.length, kept: removed.kept };
      }
      await audit(
        core,
        surface,
        'connection.remove',
        request.id,
        record === undefined ? 'an unreadable record' : `${record.app}: removed`,
      );
      const app = record === undefined ? 'the app' : APP_LABELS[record.app];
      return {
        id: request.id,
        name: record?.name ?? (held?.readable === false ? held.name : null),
        entry,
        next:
          record?.app === 'manual'
            ? 'Its key stopped working at once. Take the snippet out of the app’s settings when you can.'
            : `Its key stopped working at once. Restart ${app} to see it gone.`,
      };
    },
  };
}

/** The labels of every part a connection can have, for the app and `channels --json` (D20). */
export function connectionPartChoices(): { server: string; label: string; pin: string | null; readOnly: boolean }[] {
  return PART_FACTS.map((facts) => ({
    server: facts.server,
    label: facts.label,
    pin: facts.pin ?? null,
    readOnly: facts.readOnlySwitch,
  }));
}

/** Whether `server` is pinnable, by its manifest: for a refusal's words. */
export function partHasPin(server: string): boolean {
  return channelManifest(server)?.narrowing?.some((each) => each.kind === 'pin') === true;
}

/** How a person names a part: its label. */
export function partLabel(server: string): string {
  return partFacts(server)?.label ?? serverLabel(server);
}
