import type { ChannelEntry } from './channel-manifest.ts';
import {
  launcherCanStartSync,
  launcherCli,
  launcherName,
  launcherRuntimeVersion,
  readPointerSync,
  registeredLauncher,
} from './launcher.ts';
import { commandLinePackage, type RegisteredServer } from './mcp-clients.ts';
import {
  isProductServer,
  type Launcher,
  type McpProduct,
  managedRuntimeVersion,
  pinnedVersion,
} from './mcp-install.ts';
import { PATH_OPTIONS, type PathName, type PathOverrides, withoutPathOptions } from './paths.ts';

/**
 * What a registered server's entry says about the product it starts: whether it is that product's, how it was
 * launched, the version it pins, the suite directories it pins and the files it names — read from the entry's words
 * alone, and never by running anything it names.
 *
 * Neutral ground between the reports that list registrations (`operations/servers.ts`, `operations/update.ts`) and the
 * locator, which reads them to find another product's command (`cli-command.ts`): both parse an entry the same way
 * because both parse it here. It may use the installer's own recognisers (`mcp-install.ts`), which the installer keeps
 * for its overwrite protection; nothing here imports the locator, so the locator can import this.
 *
 * `platform` is the system the entry was registered on. On Windows, whose file names are not case-sensitive, names and
 * path segments are compared without case; everywhere else exactly.
 */

/** The product facts an entry is read against. */
export type RegistrationFacts = Pick<McpProduct, 'packageName' | 'npxPackage' | 'binary' | 'bins' | 'entryFiles'>;

/** How an entry starts its server: the launcher `mcp install` wrote it with, or `other` for one it did not. */
export type RegistrationLauncher = Launcher | 'other';

/** A channel's registration facts, from its manifest. */
export function registrationFactsOf({ packageName, manifest }: ChannelEntry): RegistrationFacts {
  return {
    packageName,
    npxPackage: manifest.server.npxPackage,
    binary: manifest.binary,
    ...(manifest.server.bins === undefined ? {} : { bins: manifest.server.bins }),
    ...(manifest.server.entryFiles === undefined ? {} : { entryFiles: manifest.server.entryFiles }),
  };
}

/** How a registered entry starts its server: the launcher `mcp install` wrote it with, or `other` for one it did not. */
export function launcherOf(
  server: Pick<RegisteredServer, 'command' | 'args'>,
  facts: Pick<RegistrationFacts, 'packageName' | 'npxPackage'>,
  platform?: NodeJS.Platform,
): RegistrationLauncher {
  const fold = folding(platform);
  // The stable launcher is what a managed install writes now (design 2026-10-16, U6).
  if (stableLauncherOf(server, facts, platform) !== null) return 'managed';
  const parts = [server.command, ...server.args];
  if (parts.some((part) => managedRuntimeVersion(part, facts.packageName, platform) !== null)) return 'managed';
  if (server.args.some((arg) => fold(arg).startsWith(fold(`${facts.npxPackage}@`)))) return 'npx';
  const local = new RegExp(
    '[/\\\\]packages[/\\\\][^/\\\\]+[/\\\\](?:src[/\\\\]cli\\.ts|dist[/\\\\]cli\\.mjs)$',
    platform === 'win32' ? 'i' : '',
  );
  if (parts.some((part) => local.test(part))) return 'local';
  return 'other';
}

/**
 * The version an entry pins — a managed runtime's or an npx spec's — or null for one that pins none.
 *
 * An entry that starts the stable launcher names no version: it runs the release its launcher's pointer names, read
 * here — null when the pointer is not there, cannot be read, or names a folder that is not a release.
 */
export function registrationVersion(
  server: Pick<RegisteredServer, 'args'> & Partial<Pick<RegisteredServer, 'command'>>,
  facts: Pick<RegistrationFacts, 'packageName' | 'npxPackage'>,
  platform?: NodeJS.Platform,
): string | null {
  const stable = stableLauncherOf({ command: server.command ?? '', args: server.args }, facts, platform);
  if (stable !== null) {
    const current = pointedRuntime(stable.dataDir, stable.name);
    return current === null ? null : launcherRuntimeVersion(current, stable.name);
  }
  return server.args.map((arg) => pinnedVersion(arg, facts, platform)).find((found) => found !== null) ?? null;
}

/**
 * The stable launcher of this product an entry starts, in the data directory the entry pins, or null: see
 * `registeredLauncher`. Another product's launcher is not this one's.
 */
export function stableLauncherOf(
  server: Pick<RegisteredServer, 'command' | 'args'>,
  facts: Pick<RegistrationFacts, 'packageName'>,
  platform?: NodeJS.Platform,
): { dataDir: string; name: string; launcher: string } | null {
  const stable = registeredLauncher(server, platform);
  if (stable === null) return null;
  let own: string;
  try {
    own = launcherName(facts.packageName);
  } catch {
    return null;
  }
  return folding(platform)(stable.name) === folding(platform)(own) ? { ...stable, name: own } : null;
}

/** The runtime a launcher's pointer names as current, or null when it has none that can be read. */
function pointedRuntime(dataDir: string, name: string): string | null {
  try {
    return readPointerSync(dataDir, name)?.current ?? null;
  } catch {
    return null;
  }
}

const REGISTRATION_PATH_OPTIONS = PATH_OPTIONS.filter(({ key }) => key !== 'downloadsDir') as readonly {
  key: Exclude<PathName, 'downloadsDir'>;
  flag: string;
}[];

/**
 * The four suite roots an entry pins, in both supported flag forms, stopping where option parsing stops. Invalid or
 * empty pins are absent; downloads are never a server registration's pin.
 */
export function registrationPathPins(args: readonly string[]): Omit<PathOverrides, 'downloadsDir'> {
  const pins: Omit<PathOverrides, 'downloadsDir'> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') break;
    for (const { key, flag } of REGISTRATION_PATH_OPTIONS) {
      if (argument === flag) {
        const value = args[index + 1];
        if (value !== undefined && value !== '--' && value.length > 0) pins[key] = value;
        index += 1;
        break;
      }
      if (argument?.startsWith(`${flag}=`)) {
        const value = argument.slice(flag.length + 1);
        if (value.length > 0) pins[key] = value;
        break;
      }
    }
  }
  return pins;
}

/**
 * Whether an entry starts this product, judged on its own words: the suite's path options and their values are taken
 * out, and the package its command line launches is read again from what is left rather than taken from the entry.
 * A folder pinned as `/tmp/@agentcomms/slack` never makes a Gmail registration Slack's.
 */
export function startsProduct(
  server: Pick<RegisteredServer, 'command' | 'args'>,
  facts: RegistrationFacts,
  platform?: NodeJS.Platform,
): boolean {
  // The launcher is known by the data directory the entry pins, which the words below no longer have.
  if (registeredLauncher(server, platform) !== null) return stableLauncherOf(server, facts, platform) !== null;
  const { words: args } = withoutPathOptions(server.args);
  const packageName = commandLinePackage(server.command, args);
  return isProductServer(
    { command: server.command, args, ...(packageName === undefined ? {} : { packageName }) },
    facts,
    platform,
  );
}

/**
 * A command's name as Windows finds it — its last path segment without `.cmd`, `.exe`, `.bat` or `.ps1` — without case
 * on Windows (`platform`), and exactly elsewhere.
 */
export function commandStem(command: string, platform?: NodeJS.Platform): string {
  return folding(platform)((command.split(/[\\/]+/).at(-1) ?? '').replace(/\.(?:cmd|exe|bat|ps1)$/i, ''));
}

/** Whether npx runs the entry: its program is npx, or it names the product's package at a version, as npx does. */
export function isNpxRegistration(
  server: Pick<RegisteredServer, 'command' | 'args'>,
  facts: Pick<RegistrationFacts, 'packageName' | 'npxPackage'>,
  platform?: NodeJS.Platform,
): boolean {
  return commandStem(server.command, platform) === 'npx' || launcherOf(server, facts, platform) === 'npx';
}

/**
 * The files an entry names as what it starts, as it writes them: every script among its words before `--` once the
 * path options are out (an interpreter's flags may name one too, so each is a candidate, not the answer), and its
 * program when that is one of the product's own commands — a link into the package, or a script npm wrote beside it.
 */
export function registrationFiles(
  server: Pick<RegisteredServer, 'command' | 'args'>,
  facts: Pick<RegistrationFacts, 'binary' | 'bins'> & Partial<Pick<RegistrationFacts, 'packageName'>>,
  platform?: NodeJS.Platform,
): { scripts: string[]; command: string | null } {
  /*
   * The stable launcher is not the product's file: the CLI it starts is, in the runtime its pointer names — or, when
   * that one cannot start, the previous one it falls back to. Neither is run here; the locator checks it as a file.
   */
  const { packageName } = facts;
  const stable = packageName === undefined ? null : stableLauncherOf(server, { packageName }, platform);
  if (stable !== null) {
    let pointer: ReturnType<typeof readPointerSync>;
    try {
      pointer = readPointerSync(stable.dataDir, stable.name);
    } catch {
      return { scripts: [], command: null };
    }
    const runtime =
      pointer === undefined
        ? undefined
        : launcherCanStartSync(pointer.current, stable.name) || pointer.previous === undefined
          ? pointer.current
          : pointer.previous;
    return { scripts: runtime === undefined ? [] : [launcherCli(runtime, stable.name)], command: null };
  }
  const { words } = withoutPathOptions(server.args);
  const sentinel = words.indexOf('--');
  const options = sentinel < 0 ? words : words.slice(0, sentinel);
  const fold = folding(platform);
  const scripts = options
    .flatMap((word) => [
      word,
      ...(word.startsWith('--') && word.includes('=') ? [word.slice(word.indexOf('=') + 1)] : []),
    ])
    .filter((word) => !word.startsWith('-') && /\.(?:[cm]?js|[cm]?ts)$/i.test(word));
  const own = [facts.binary, ...(facts.bins ?? [])].map(fold).includes(commandStem(server.command, platform));
  return { scripts, command: own ? server.command : null };
}

function folding(platform: NodeJS.Platform | undefined): (text: string) => string {
  return platform === 'win32' ? (text) => text.toLowerCase() : (text) => text;
}
