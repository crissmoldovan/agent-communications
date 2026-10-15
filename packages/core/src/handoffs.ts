import type { ChannelEntry } from './channel-manifest.ts';
import { CHANNEL_SNAPSHOT } from './channels.generated.ts';
import { type CliCommandCaller, locateCliCommand, type NodeRuntime } from './cli-command.ts';
import { type CliHandoffs, type Handoff, type HandoffUse, requiredHandoffs } from './handoff-text.ts';
import { type RegisteredServer, scanRegisteredServers } from './mcp-clients.ts';
import type { PathName, ResolvedPaths } from './paths.ts';

export {
  type CliHandoffs,
  type Handoff,
  type HandoffSentenceOptions,
  type HandoffUse,
  handoffChoices,
  handoffSentence,
  handoffSentenceToFill,
  handoffText,
  handoffTextToFill,
  isCommand,
  type Remedy,
  type RemedyPart,
  remedy,
} from './handoff-text.ts';

/**
 * The commands a package tells a person to run, made once per printing process (design 2026-10-04, D1 and D5;
 * CUE-403). How a channel migrates a handoff to these is in CONTRIBUTING.md, "Telling a person what to run".
 *
 * A package makes them from where it is — a module of its own and its package name, the caller — with the folders and
 * shell of the process printing: `openCore({ caller })` puts them on `core.handoffs`. Each method takes the CLI's own
 * words, never the program, and returns a `Handoff`: a located `PrintedCommand`, or why there is none here. Nothing
 * here quotes a line by hand, names a bare binary, or guesses an installation.
 */

/** The suite folders every CLI command opens: what a command is pinned to unless it says otherwise. */
export const HANDOFF_FOLDERS: readonly PathName[] = Object.freeze(['configDir', 'stateDir', 'dataDir', 'secretsDir']);

export interface CliHandoffsOptions {
  /** A module of the printing package (`import.meta.url`) and that package's name. */
  readonly caller: CliCommandCaller;
  /** The printing process's folders. */
  readonly paths: Readonly<ResolvedPaths>;
  readonly platform?: NodeJS.Platform | undefined;
  /**
   * The printing process's environment: where the MCP clients' configurations are found, for `registered()` (this
   * process's unless given), and the PATH each command names this Node from, as a registration does (CUE-492). Left
   * out, a command names `process.execPath`, which the system reports resolved.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly registrations?: readonly RegisteredServer[] | undefined;
  /** For a test only: the Node version and flags the commands are located for. Its program is always this one's. */
  readonly runtime?: NodeRuntime | undefined;
}

/**
 * Core as a caller: a module of this package. Only core's own entry points — its CLI, its server — open core with it.
 * Bundled into another package, this module belongs to that package, so the manifest check refuses it there and it
 * locates nothing: a channel gives its own caller, never this one.
 */
export const CORE_CALLER: CliCommandCaller = Object.freeze({ url: import.meta.url, packageName: '@agentcomms/core' });

/** A channel of this release, by its word; a programming error for a word that is none. */
function entryOf(channel: string): ChannelEntry {
  const entry = CHANNEL_SNAPSHOT.find((each) => each.manifest.channel === channel);
  if (entry === undefined) throw new TypeError(`"${channel}" is not a channel of this release`);
  return entry;
}

/** The folders a command is pinned to. */
function usesOf(use: HandoffUse | undefined): PathName[] {
  return [...(use?.uses ?? HANDOFF_FOLDERS), ...(use?.downloads ? (['downloadsDir'] as const) : [])];
}

/** The commands a package prints, located from `caller` (CONTRIBUTING.md, "Telling a person what to run"). */
export function cliHandoffs(options: CliHandoffsOptions): CliHandoffs {
  const { caller, paths, registrations } = options;
  const platform = options.platform ?? process.platform;
  const own = CHANNEL_SNAPSHOT.find((entry) => entry.packageName === caller.packageName);
  if (own === undefined) throw new TypeError(`${caller.packageName} is not a package of this suite`);
  const locate = (target: ChannelEntry, words: readonly string[], use: HandoffUse | undefined): Handoff => {
    const result = locateCliCommand(
      {
        caller,
        target,
        words,
        uses: usesOf(use),
        paths,
        platform,
        ...(registrations === undefined ? {} : { registrations }),
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      ...(options.runtime === undefined ? [] : [options.runtime]),
    );
    return result.ok ? result.command : result;
  };
  const handoffs: CliHandoffs = Object.freeze({
    caller,
    platform,
    own: (words: readonly string[], use?: HandoffUse) => locate(own, words, use),
    core: (words: readonly string[], use?: HandoffUse) => locate(entryOf('core'), words, use),
    of: (channel: string, words: readonly string[], use?: HandoffUse) => locate(entryOf(channel), words, use),
    on: (other: NodeJS.Platform) => (other === platform ? handoffs : cliHandoffs({ ...options, platform: other })),
    registered: async () =>
      cliHandoffs({
        ...options,
        registrations: (await scanRegisteredServers(options.env ?? process.env, platform)).servers,
      }),
    withRegistrations: (servers: readonly RegisteredServer[]) => cliHandoffs({ ...options, registrations: servers }),
  });
  return handoffs;
}

/**
 * `core.handoffs` — quoted for `platform` when one is given — for anything that prints a command. A programming error
 * when core was opened without its caller: the package has to give it one (`openCore({ caller })`), and there is no
 * bare name to print instead.
 */
export function requireHandoffs(
  core: { readonly handoffs?: CliHandoffs | undefined },
  platform?: NodeJS.Platform | undefined,
): CliHandoffs {
  const handoffs = requiredHandoffs(core.handoffs);
  return platform === undefined ? handoffs : handoffs.on(platform);
}
