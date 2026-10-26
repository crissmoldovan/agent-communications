/**
 * Settings → Integrations (0.33.0, design 2026-10-26-rules-that-act-0330 §3.4, §3.5), as the event service's
 * `integration show <linear|agent-sessions> --json` answers. Read leniently: a field the app cannot read says nothing,
 * and an answer that is not one of these at all is unreadable. Neither ever holds a key or a token.
 *
 *   linear          { integration, connected, workspace: { name, urlKey } | null, teams: [{ id, key, name }],
 *                     usedBy: [ruleId] }
 *   agent-sessions  { integration, home: 'claude-stream' | 'pilot', homes: [{ home, path, found }],
 *                     relay: { state, version, protocol, allowedRoots: [path] } }
 *
 * The shapes are the spec's words made concrete while its builders write them: the lead settles any difference.
 */
import { RELAY_HOMES, type RelayHome } from './ipc.ts';

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
  usedBy: string[];
}

export function readLinear(value: unknown): LinearState | null {
  if (!isRecord(value) || typeof value.connected !== 'boolean') return null;
  const workspace = isRecord(value.workspace) ? text(value.workspace.name) : null;
  const teams = Array.isArray(value.teams)
    ? value.teams.flatMap((team): LinearTeam[] => {
        if (!isRecord(team)) return [];
        const id = text(team.id);
        const key = text(team.key);
        return id === null || key === null ? [] : [{ id, key, name: text(team.name) ?? key }];
      })
    : [];
  return { connected: value.connected, workspace, teams, usedBy: texts(value.usedBy) };
}

/** Where the relay stands, in the app's words. */
export type RelayState = 'running' | 'not-running' | 'no-token' | 'unsupported' | 'not-found' | 'unknown';

export interface SessionsState {
  home: RelayHome | null;
  homes: { home: RelayHome; path: string | null; found: boolean | null }[];
  relay: RelayState;
  version: string | null;
  /** The folders the relay lets a session work in, and so the files it may be given. */
  allowedRoots: string[];
}

const RELAY_STATES: readonly RelayState[] = ['running', 'not-running', 'no-token', 'unsupported', 'not-found'];

const relayHome = (value: unknown): RelayHome | null =>
  (RELAY_HOMES as readonly unknown[]).includes(value) ? (value as RelayHome) : null;

export function readAgentSessions(value: unknown): SessionsState | null {
  if (!isRecord(value)) return null;
  const homes = Array.isArray(value.homes)
    ? value.homes.flatMap((entry): SessionsState['homes'] => {
        if (!isRecord(entry)) return [];
        const home = relayHome(entry.home);
        if (home === null) return [];
        return [{ home, path: text(entry.path), found: typeof entry.found === 'boolean' ? entry.found : null }];
      })
    : [];
  const relay = isRecord(value.relay) ? value.relay : {};
  const state = RELAY_STATES.find((each) => each === relay.state) ?? 'unknown';
  if (homes.length === 0 && relayHome(value.home) === null) return null;
  return {
    home: relayHome(value.home),
    homes,
    relay: state,
    version: text(relay.version),
    allowedRoots: texts(relay.allowedRoots),
  };
}

/** What the relay's state says, for a person. */
export const RELAY_WORDS: Readonly<Record<RelayState, string>> = {
  running: 'Running',
  'not-running': 'Not running',
  'no-token': 'No token yet: start claude-stream once',
  unsupported: 'Too old for Agent Comms',
  'not-found': 'Not found',
  unknown: 'Unknown',
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
