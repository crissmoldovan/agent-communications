import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const APP_DIR_NAME = 'agent-communications';

export interface PathEnvironment {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

export interface ResolvedPaths {
  /** config.json, the file secret store and everything a user edits. */
  configDir: string;
  /** Approvals, pending OAuth flows, audit log, rate-cap counters, taint set. */
  stateDir: string;
  /** Managed runtime installs for MCP clients. */
  dataDir: string;
  /** Default root for attachment downloads and exports. */
  downloadsDir: string;
}

/**
 * Where everything lives. `AGENT_COMMS_CONFIG_DIR` wins; then `XDG_CONFIG_HOME` (honoured on macOS too, because that is
 * where agents and people look first); then `~/.config` on macOS and Linux, `%APPDATA%` on Windows.
 */
export function resolvePaths(options: PathEnvironment = {}): ResolvedPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();

  const configDir = resolve(
    env.AGENT_COMMS_CONFIG_DIR ||
      (env.XDG_CONFIG_HOME
        ? join(env.XDG_CONFIG_HOME, APP_DIR_NAME)
        : platform === 'win32'
          ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DIR_NAME)
          : join(home, '.config', APP_DIR_NAME)),
  );
  const stateDir = resolve(env.AGENT_COMMS_STATE_DIR || join(configDir, 'state'));
  const dataDir = resolve(
    env.AGENT_COMMS_DATA_DIR ||
      (platform === 'win32'
        ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), APP_DIR_NAME)
        : env.XDG_DATA_HOME
          ? join(env.XDG_DATA_HOME, APP_DIR_NAME)
          : join(home, '.local', 'share', APP_DIR_NAME)),
  );
  const downloadsDir = resolve(join(home, 'Downloads', APP_DIR_NAME));
  return { configDir, stateDir, dataDir, downloadsDir };
}

/** Expands a leading `~` to the home directory. Nothing else is expanded. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}
