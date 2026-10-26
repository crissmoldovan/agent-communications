import { isAbsolute, normalize, relative, sep } from 'node:path';
import { type AuditLog, CommsError } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { personSetupApprover } from '../domain/judge-setup.ts';
import { EventDomainError } from '../domain/lifecycle.ts';
import { isSessionFolder, sessionTargetFiles } from '../domain/session-target.ts';
import type { EventDatabase } from '../store/database.ts';
import {
  locateRelay,
  RelayClient,
  RelayError,
  type RelayInfoV1,
  type RelayLocation,
  readRelayToken,
} from './relay-client.ts';

/**
 * Settings → Integrations → "Agent sessions" (0.33.0 design §3.5): where the person's claude-stream relay is, and the
 * folders a file part may be read from besides the relay's own allowed roots. Setting them is the person's, from the
 * app or their terminal (`integration set agent-sessions`); the event service reads them to reach the relay.
 */

export interface AgentSessionSettingsV1 {
  /** The relay's home the person gave, or null for the defaults: claude-stream's own, then the Pilot app's. */
  readonly relayHome: string | null;
  /** The relay's port the person gave, or null: the Pilot app's record beside the home, else 4318. */
  readonly relayPort: number | null;
  /** Folders a file part may be read from, besides the relay's allowed roots. */
  readonly allowedFolders: readonly string[];
}

/** `integration show agent-sessions` and `integration set`'s result: the settings, and what the relay said. */
export interface AgentSessionsIntegrationV1 {
  readonly integration: 'agent-sessions';
  readonly settings: AgentSessionSettingsV1;
  readonly relay: {
    readonly found: boolean;
    readonly home: string | null;
    readonly source: RelayLocation['source'] | null;
    readonly url: string | null;
    readonly ready: boolean;
    readonly version: string | null;
    readonly allowedRoots: readonly string[] | null;
    /** Why it could not be used, as a closed reason; null when it is ready. */
    readonly problem: string | null;
  };
  /** Items waiting for a busy session, across every relay session. */
  readonly waiting: number;
}

const MAX_FOLDERS = 32;

/** A folder as the settings keep one: absolute, normal, not the root. */
export function isSettingsFolder(value: unknown): value is string {
  return isSessionFolder(value);
}

/** A root that confines nothing: `/`, or the person's home folder itself. */
export function isTooWideRoot(root: string, homeDirectory: string): boolean {
  const normal = normalize(root).replace(/\/+$/u, '') || '/';
  return normal === '/' || normal === normalize(homeDirectory).replace(/\/+$/u, '');
}

/** Whether `path` is `folder` or inside it, comparing normal absolute paths segment by segment. */
export function isInside(path: string, folder: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(folder)) return false;
  const between = relative(normalize(folder), normalize(path));
  return between === '' || (!between.startsWith(`..${sep}`) && between !== '..' && !isAbsolute(between));
}

export interface AgentSessionServiceOptions {
  readonly store: EventDatabase;
  readonly homeDirectory: string;
  /**
   * Agent Comms' own configuration, state, secrets and data folders (security review of 0.33.0, finding 4): no file
   * part is read from them and no session works in them, whatever the roots say.
   */
  readonly deniedFolders?: readonly string[] | undefined;
  readonly audit?: Pick<AuditLog, 'append'> | undefined;
  readonly now?: (() => number) | undefined;
}

/** A ready client of the person's relay, with what it said about itself. */
export interface ReadyRelay {
  readonly client: RelayClient;
  readonly location: RelayLocation;
  readonly info: RelayInfoV1;
}

export class AgentSessionService {
  readonly #store: EventDatabase;
  readonly #homeDirectory: string;
  readonly #deniedFolders: readonly string[];
  readonly #audit: Pick<AuditLog, 'append'> | undefined;
  readonly #now: () => number;

  constructor(options: AgentSessionServiceOptions) {
    this.#store = options.store;
    this.#homeDirectory = options.homeDirectory;
    this.#deniedFolders = options.deniedFolders ?? [];
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
  }

  settings(): AgentSessionSettingsV1 {
    const row = this.#store.database
      .prepare('SELECT relay_home, relay_port, allowed_folders FROM agent_session_settings WHERE singleton = 1')
      .get() as { relay_home: string | null; relay_port: number | null; allowed_folders: string } | undefined;
    if (row === undefined) return { relayHome: null, relayPort: null, allowedFolders: [] };
    let folders: unknown;
    try {
      folders = JSON.parse(row.allowed_folders);
    } catch {
      folders = [];
    }
    return {
      relayHome: row.relay_home,
      relayPort: row.relay_port,
      allowedFolders: Array.isArray(folders)
        ? folders.filter((folder) => isSettingsFolder(folder) && !isTooWideRoot(folder, this.#homeDirectory))
        : [],
    };
  }

  /**
   * A client of the person's relay, checked: found, its token safe to read, and its protocol and capabilities the ones
   * this release relies on. Refused with a `RelayError` naming why, otherwise.
   */
  async relay(): Promise<ReadyRelay> {
    const settings = this.settings();
    const location = await locateRelay(settings, this.#homeDirectory);
    const token = await readRelayToken(location.home);
    const client = new RelayClient({ url: location.url, token });
    const info = await client.ready();
    return { client, location, info };
  }

  /**
   * The relay's allowed roots when it is ready and says them (claude-stream's `session-files`); null otherwise. A relay
   * with no root policy says `/`, and one may name the home folder itself: either confines nothing, so then the relay's
   * roots are not used at all, and only the folders the person added are (security review of 0.33.0, finding 4).
   */
  async relayAllowedRoots(ready?: ReadyRelay): Promise<readonly string[] | null> {
    let roots: readonly string[] | null;
    try {
      const relay = ready ?? (await this.relay());
      roots = await relay.client.allowedRoots();
    } catch (error) {
      if (error instanceof RelayError) return null;
      throw error;
    }
    if (roots === null || roots.some((root) => isTooWideRoot(root, this.#homeDirectory))) return null;
    return roots;
  }

  /** Agent Comms' own folders, never read and never worked in. */
  deniedFolders(): readonly string[] {
    return this.#deniedFolders;
  }

  /**
   * The folders a session may work in: the relay's allowed roots when it says them, else the folders the person gave
   * in the settings — the relay itself checks a new session's folder too.
   */
  async sessionRoots(ready?: ReadyRelay): Promise<readonly string[]> {
    return (await this.relayAllowedRoots(ready)) ?? this.settings().allowedFolders;
  }

  /** The folders a file part may be read from: the relay's allowed roots and the folders the person added. */
  async fileRoots(ready?: ReadyRelay): Promise<readonly string[]> {
    return [...new Set([...((await this.relayAllowedRoots(ready)) ?? []), ...this.settings().allowedFolders])];
  }

  /**
   * The activation check (§3.5): a session target's folder is inside the relay's allowed roots, and each file it reads
   * is under a folder it may be read from. Refused naming the folder or the file.
   */
  async assertActivation(rule: CanonicalFullRuleDocument): Promise<void> {
    const targets = rule.targets.filter((target) => target.kind === 'session');
    if (targets.length === 0) return;
    let ready: ReadyRelay | undefined;
    try {
      ready = await this.relay();
    } catch (error) {
      if (!(error instanceof RelayError)) throw error;
    }
    const sessionRoots = await this.sessionRoots(ready);
    const fileRoots = await this.fileRoots(ready);
    const denied = (path: string) => this.#deniedFolders.some((folder) => isInside(path, folder));
    for (const target of targets) {
      if ('folder' in target.find) {
        const folder = target.find.folder;
        if (denied(folder))
          throw new EventDomainError(
            'VERSION_DOCUMENT_INVALID',
            `the session folder ${folder} is one of Agent Comms' own folders, which no session works in`,
          );
        if (sessionRoots.length === 0)
          throw new EventDomainError(
            'VERSION_DOCUMENT_INVALID',
            `the session folder ${folder} cannot be checked: the relay does not say its allowed roots, and none is set: add its root in Settings → Integrations → Agent sessions (integration set agent-sessions --allow-folder)`,
          );
        if (!sessionRoots.some((root) => isInside(folder, root)))
          throw new EventDomainError(
            'VERSION_DOCUMENT_INVALID',
            `the session folder ${folder} is not inside the relay's allowed roots`,
          );
      }
      for (const file of sessionTargetFiles(target)) {
        if (denied(file))
          throw new EventDomainError(
            'VERSION_DOCUMENT_INVALID',
            `the file ${file} is in one of Agent Comms' own folders, which a session's context never reads`,
          );
        if (!fileRoots.some((root) => isInside(file, root)))
          throw new EventDomainError(
            'VERSION_DOCUMENT_INVALID',
            `the file ${file} is not under a folder a session's context may be read from: the relay's allowed roots, or one added with integration set agent-sessions --allow-folder`,
          );
      }
    }
  }

  /** How many items wait for a busy session. */
  waiting(): number {
    return (this.#store.database.prepare('SELECT COUNT(*) AS count FROM session_queue').get() as { count: number })
      .count;
  }

  /** `integration show agent-sessions`: the person's view of the settings and the relay, refused to an agent window. */
  async show(): Promise<AgentSessionsIntegrationV1> {
    const settings = this.settings();
    let location: RelayLocation | undefined;
    let info: RelayInfoV1 | undefined;
    let roots: readonly string[] | null = null;
    let problem: string | null = null;
    try {
      location = await locateRelay(settings, this.#homeDirectory);
      const ready = await this.relay();
      info = ready.info;
      roots = await this.relayAllowedRoots(ready);
    } catch (error) {
      if (!(error instanceof RelayError)) throw error;
      problem = error.reason;
    }
    return {
      integration: 'agent-sessions',
      settings,
      relay: {
        found: location !== undefined,
        home: location?.home ?? null,
        source: location?.source ?? null,
        url: location?.url ?? null,
        ready: info !== undefined,
        version: info?.version ?? null,
        allowedRoots: roots,
        problem,
      },
      waiting: this.waiting(),
    };
  }

  /**
   * `integration set agent-sessions`: the person's own, from the app or their terminal — the origin is checked here
   * again, and audited. Each given field replaces its setting; `default` clears the relay's home or port.
   */
  async set(args: Readonly<Record<string, unknown>>, origin: string | undefined): Promise<AgentSessionsIntegrationV1> {
    const approver = personSetupApprover(origin);
    const surface = approver === 'terminal' ? ('cli' as const) : ('app' as const);
    const audit = async (outcome: 'ok' | 'refused' | 'failed', reason?: string) =>
      this.#audit?.append({
        inboxId: '',
        operation: 'events.integrationSet',
        outcome,
        surface,
        origin: surface,
        ids: { integration: 'agent-sessions', ...(approver === null ? {} : { approvedBy: approver }) },
        ...(reason === undefined ? {} : { reason }),
      });
    if (approver === null) {
      await audit('refused', 'PERSON_SETUP_ONLY');
      throw new CommsError(
        'APPROVAL_REQUIRED',
        'where Agent Comms finds your claude-stream relay is your own setting, from the app or your terminal',
      );
    }
    try {
      const current = this.settings();
      const next = settingsFrom(args, current, this.#homeDirectory);
      this.#store.immediate(() =>
        this.#store.database
          .prepare(
            `INSERT INTO agent_session_settings (singleton, relay_home, relay_port, allowed_folders, updated_at)
             VALUES (1, ?, ?, ?, ?)
             ON CONFLICT (singleton) DO UPDATE SET relay_home = excluded.relay_home, relay_port = excluded.relay_port,
               allowed_folders = excluded.allowed_folders, updated_at = excluded.updated_at`,
          )
          .run(next.relayHome, next.relayPort, JSON.stringify(next.allowedFolders), this.#now()),
      );
      await audit('ok');
      return this.show();
    } catch (error) {
      await audit('failed');
      throw error;
    }
  }
}

function usage(message: string): never {
  throw new CommsError('USAGE', message);
}

/** The settings after `args`: only the given fields change, and each is checked. */
export function settingsFrom(
  args: Readonly<Record<string, unknown>>,
  current: AgentSessionSettingsV1,
  homeDirectory?: string,
): AgentSessionSettingsV1 {
  for (const key of Object.keys(args))
    if (!['relayHome', 'relayPort', 'allowFolders', 'removeFolders'].includes(key))
      usage(`integration set agent-sessions takes no ${key}`);
  let relayHome = current.relayHome;
  if (args.relayHome !== undefined) {
    if (args.relayHome === 'default') relayHome = null;
    else if (!isSettingsFolder(args.relayHome))
      usage("the relay's home is an absolute folder, written without . or .. steps or a trailing /");
    else relayHome = args.relayHome;
  }
  let relayPort = current.relayPort;
  if (args.relayPort !== undefined) {
    if (args.relayPort === 'default') relayPort = null;
    else if (!Number.isInteger(args.relayPort) || (args.relayPort as number) < 1 || (args.relayPort as number) > 65_535)
      usage("the relay's port is a whole number from 1 to 65535, or default");
    else relayPort = args.relayPort as number;
  }
  const list = (value: unknown, what: string): readonly string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(isSettingsFolder))
      usage(`${what} is an absolute folder, written without . or .. steps or a trailing /`);
    return value as readonly string[];
  };
  const removed = new Set(list(args.removeFolders, 'a folder to remove'));
  if (
    homeDirectory !== undefined &&
    list(args.allowFolders, 'a folder to allow').some((f) => isTooWideRoot(f, homeDirectory))
  )
    usage('a folder a file part may be read from is never / or your home folder itself: name the folder inside it');
  const folders = [...new Set([...current.allowedFolders, ...list(args.allowFolders, 'a folder to allow')])].filter(
    (folder) => !removed.has(folder),
  );
  if (folders.length > MAX_FOLDERS) usage(`at most ${MAX_FOLDERS} folders may be allowed`);
  return { relayHome, relayPort, allowedFolders: folders };
}
