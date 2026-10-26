/**
 * Settings → Integrations (0.33.0, design 2026-10-26-rules-that-act-0330 §3.4, §3.5), as the event service's
 * `integration show <linear|agent-sessions> --json` answers. Read leniently: a field the app cannot read says nothing,
 * and an answer that is not one of these at all is unreadable. Neither ever holds a key or a token. The shapes are
 * the event service's builders' (`linear-integration.ts`, `agent-sessions.ts`):
 *
 *   linear          { integration, connected, workspace: string | null, teams: [{ id, key, name }], labels? }
 *   agent-sessions  { integration, settings: { relayHome, relayPort, allowedFolders },
 *                     relay: { found, home, source, url, ready, version, allowedRoots, problem }, waiting }
 */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string' && each !== '') : [];

/** A Linear team the key can see. */
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearState {
  connected: boolean;
  workspace: string | null;
  teams: LinearTeam[];
  /** The rules that add issues, when the answer names them; null when it does not say. */
  usedBy: string[] | null;
}

export function readLinear(value: unknown): LinearState | null {
  if (!isRecord(value) || typeof value.connected !== 'boolean') return null;
  const workspace = text(value.workspace) ?? (isRecord(value.workspace) ? text(value.workspace.name) : null);
  const teams = Array.isArray(value.teams)
    ? value.teams.flatMap((team): LinearTeam[] => {
        if (!isRecord(team)) return [];
        const id = text(team.id);
        const key = text(team.key);
        return id === null || key === null ? [] : [{ id, key, name: text(team.name) ?? key }];
      })
    : [];
  return {
    connected: value.connected,
    workspace,
    teams,
    usedBy: Array.isArray(value.usedBy) ? texts(value.usedBy) : null,
  };
}

/** Where the relay was found: the folder the person set, claude-stream's own home, or the Pilot app's. */
export type RelaySource = 'setting' | 'default' | 'pilot';

export interface SessionsState {
  /** The relay's home the person set, or null for the defaults. */
  relayHome: string | null;
  found: boolean;
  ready: boolean;
  /** Where the relay is, and how it was found. */
  home: string | null;
  source: RelaySource | null;
  version: string | null;
  /** Why it cannot be used, as the event service's closed reason; null when it is ready. */
  problem: string | null;
  /** The folders the relay lets a session work in. */
  allowedRoots: string[];
  /** The folders the person added that a session's file parts may be read from, besides those. */
  allowedFolders: string[];
  /** Items waiting for a busy session. */
  waiting: number;
}

const SOURCES: readonly RelaySource[] = ['setting', 'default', 'pilot'];

export function readAgentSessions(value: unknown): SessionsState | null {
  if (!isRecord(value) || !isRecord(value.relay)) return null;
  const settings = isRecord(value.settings) ? value.settings : {};
  const relay = value.relay;
  return {
    relayHome: text(settings.relayHome),
    found: relay.found === true,
    ready: relay.ready === true,
    home: text(relay.home),
    source: SOURCES.find((source) => source === relay.source) ?? null,
    version: text(relay.version),
    problem: text(relay.problem),
    allowedRoots: texts(relay.allowedRoots),
    allowedFolders: texts(settings.allowedFolders),
    waiting: typeof value.waiting === 'number' && Number.isSafeInteger(value.waiting) ? value.waiting : 0,
  };
}

/** Where the relay was found, for a person. */
export const SOURCE_WORDS: Readonly<Record<RelaySource, string>> = {
  setting: 'the folder you set',
  default: 'claude-stream’s own home',
  pilot: 'the Pilot app’s home',
};

/** Whether `path` is inside one of `roots`, with `~` read as `home`. A path that steps out with `..` is in none. */
export function insideAny(path: string, roots: readonly string[], home: string | null): boolean {
  const whole = path.startsWith('~/') && home !== null ? `${home.replace(/\/$/u, '')}${path.slice(1)}` : path;
  if (!whole.startsWith('/') || whole.split('/').some((part) => part === '..' || part === '.')) return false;
  return roots.some((root) => {
    const base = root.replace(/\/+$/u, '');
    return base !== '' && (whole === base || whole.startsWith(`${base}/`));
  });
}
