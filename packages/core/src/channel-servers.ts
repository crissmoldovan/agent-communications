import type { McpProduct } from './mcp-install.ts';

/**
 * The MCP servers this suite ships, and what the shared installer needs to know to register each one.
 *
 * One list, read by every installer. `agent-gmail mcp install` and `agent-slack mcp install` register their own
 * server; the core server's `comms_server_install` registers any of the three. Each package used to keep these facts
 * beside its own installer, and a second installer holding a copy would have been a second place for a package name,
 * a flag or an npx argument to drift — the Slack entry once started `agent-slack --workspace acme` with no command at
 * all, because a shared default was wrong for one product. So the channel packages spread these, and add only what
 * is theirs: the version they are, where their own code lives, and what they warn about.
 */
export type Channel = 'core' | 'gmail' | 'slack';

export const CHANNELS: readonly Channel[] = Object.freeze(['core', 'gmail', 'slack']);

/** Everything about a server except the version being installed, where its code lives and its warnings. */
export type ServerFacts = Omit<McpProduct, 'version' | 'moduleUrl' | 'warnAbout'>;

const flagValue = (args: readonly string[], flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

export const CHANNEL_SERVERS: Readonly<Record<Channel, ServerFacts>> = Object.freeze({
  /*
   * The core server, which installs and manages the others. It is the whole CLI, like Slack's, so `npx` runs it with
   * `mcp`; and it reaches no account, so there is nothing to pin and nothing to narrow.
   */
  core: {
    packageName: '@agentcomms/core',
    binary: 'agentcomms',
    defaultServerName: 'agentcomms',
    npxPackage: '@agentcomms/core',
    npxArgs: ['mcp'],
    serverArgs: () => [],
    narrowingOf: () => ({}),
  },
  gmail: {
    packageName: '@agentcomms/gmail',
    binary: 'agent-gmail',
    defaultServerName: 'gmail',
    npxPackage: '@agentcomms/gmail-mcp',
    // The published `agent-gmail-mcp` bin: not what the installer writes, but a real way to run this server —
    // by its path inside a package, or by its name when installed globally.
    entryFiles: [['node_modules', '@agentcomms', 'gmail-mcp', 'dist', 'server.mjs']],
    bins: ['agent-gmail-mcp'],
    serverArgs: (options) => {
      const args: string[] = [];
      if (options.inbox) args.push('--inbox', options.inbox);
      if (options.readOnly) args.push('--read-only');
      return args;
    },
    // Read back as the doctor's repair reads them, so `--force` keeps what a registered entry narrowed.
    narrowingOf: (args) => {
      const inbox = flagValue(args, '--inbox');
      return { ...(inbox ? { inbox } : {}), ...(args.includes('--read-only') ? { readOnly: true } : {}) };
    },
  },
  slack: {
    packageName: '@agentcomms/slack',
    binary: 'agent-slack',
    defaultServerName: 'slack',
    /*
     * The package itself, not a thin `-mcp` wrapper.
     *
     * Gmail ships `@agentcomms/gmail-mcp` so an `npx` launcher downloads a small package rather than the whole CLI.
     * Slack has no such package, so `npx` fetches this one; saying so here is better than pointing at a name that
     * does not exist on the registry, which is a launcher that fails only on the machine that chose it.
     */
    npxPackage: '@agentcomms/slack',
    // …and because it is the whole CLI, the server is its `mcp` command.
    npxArgs: ['mcp'],
    serverArgs: (options) => (options.workspace ? ['--workspace', options.workspace] : []),
    // Read back as the doctor's repair reads it, so `--force` keeps the workspace a registered entry was pinned to.
    narrowingOf: (args) => {
      const workspace = flagValue(args, '--workspace');
      return workspace ? { workspace } : {};
    },
  },
});

/** How each server is named to a person: in a preview, and in what a tool returns. */
export const CHANNEL_LABELS: Readonly<Record<Channel, string>> = Object.freeze({
  core: 'agentcomms (core)',
  gmail: 'Gmail',
  slack: 'Slack',
});

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}
