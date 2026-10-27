import { join } from 'node:path';
import { channelManifest, narrowingArgs, serverFacts } from '../channel-servers.ts';
import type { Config } from '../config.ts';
import { type ConnectionRecord, partFacts } from '../connections.ts';
import { launcherName, launcherPaths } from '../launcher.ts';
import { findById } from '../names.ts';
import { nodeProgram } from '../node-program.ts';
import { localPartCli } from '../operations/servers.ts';
import { VERSION } from '../version.ts';
import type { PartSpec } from './router.ts';

/**
 * How the gateway starts each part of a connection (single-server design §4, "Spawning parts"): the same program, with
 * the same words, as its own entry starts it — `<data>/launch/<name>` with the four path pins, `mcp` and the part's
 * narrowing; or from a checkout's own code (`local`), or `npx` at this release. A pin names the account by its id
 * (D12), and is started with the name that account has now, so a rename does not break the part; an account that is
 * gone leaves the part unstarted, saying why — never started unpinned.
 */

/** The extensions a part declares, advertised from the connection whether or not it is ready in time (spike change 5). */
export const PART_EXTENSIONS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  events: Object.freeze({ 'io.modelcontextprotocol/tasks': Object.freeze({}) }),
});

/** Every extension the connection's parts declare. */
export function connectionExtensions(record: ConnectionRecord): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const part of record.parts) Object.assign(extensions, PART_EXTENSIONS[part.server] ?? {});
  return extensions;
}

/** What starting a part needs from where the gateway runs. */
export interface PartsContext {
  readonly paths: {
    readonly configDir: string;
    readonly stateDir: string;
    readonly dataDir: string;
    readonly secretsDir: string;
  };
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform | undefined;
  /** For a test: where the `npx` the parts are started with is. */
  readonly npx?: string | undefined;
}

/** A part the gateway could not start, and why, in a person's words. */
export interface SkippedPart {
  readonly server: string;
  readonly label: string;
  readonly why: string;
}

/** The pin's account as it is named now, by its id, or null when it is no longer connected. */
function pinnedAlias(config: Config, server: string, id: string): string | null {
  const facts = partFacts(server);
  if (facts?.accounts === 'inboxes') return findById(config, 'inbox', id)?.alias ?? null;
  return findById(config, 'account', id)?.alias ?? null;
}

/** The four path pins every registration carries (`registrationPathArgs` in `mcp-install.ts`). */
function pathPins(paths: PartsContext['paths']): string[] {
  return [
    '--config-dir',
    paths.configDir,
    '--state-dir',
    paths.stateDir,
    '--data-dir',
    paths.dataDir,
    '--secrets-dir',
    paths.secretsDir,
  ];
}

/** Each part of `record` as the gateway starts it, and the parts it cannot start, with why. */
export async function partSpecs(
  record: ConnectionRecord,
  config: Config,
  context: PartsContext,
): Promise<{ specs: PartSpec[]; skipped: SkippedPart[] }> {
  const platform = context.platform ?? process.platform;
  const specs: PartSpec[] = [];
  const skipped: SkippedPart[] = [];
  for (const part of record.parts) {
    const facts = partFacts(part.server);
    if (facts === undefined) continue;
    let alias: string | undefined;
    if (part.pin !== undefined) {
      const now = pinnedAlias(config, part.server, part.pin.id);
      if (now === null) {
        skipped.push({
          server: part.server,
          label: facts.label,
          why: `the ${facts.noun ?? 'account'} it is kept to, ${part.pin.alias}, is no longer connected`,
        });
        continue;
      }
      alias = now;
    }
    const manifest = channelManifest(part.server);
    const narrowing =
      manifest === undefined
        ? []
        : narrowingArgs(manifest, {
            client: 'json',
            ...(alias !== undefined && facts.pin !== undefined ? { [facts.pin]: alias } : {}),
            ...(part.readOnly ? { readOnly: true } : {}),
          });
    const server = serverFacts(part.server);
    const words = [...pathPins(context.paths), 'mcp', ...narrowing];
    let command: string;
    let args: string[];
    if (record.launcher === 'local') {
      const cli = await localPartCli(part.server);
      const flags = cli.endsWith('.ts') ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : [];
      command = process.execPath;
      args = [...flags, cli, ...words];
    } else if (record.launcher === 'npx') {
      command = context.npx ?? join(process.execPath, '..', platform === 'win32' ? 'npx.cmd' : 'npx');
      args = [
        '-y',
        `${server.npxPackage}@${VERSION}`,
        ...pathPins(context.paths),
        ...(server.npxArgs ?? []),
        ...narrowing,
      ];
    } else {
      const launcher = launcherPaths(context.paths.dataDir, launcherName(server.packageName)).launcher;
      // On Windows Node runs the launcher, its first word, since nothing starts a script there without a shell.
      if (platform === 'win32') {
        command = nodeProgram(context.env, platform);
        args = [launcher, ...words];
      } else {
        command = launcher;
        args = words;
      }
    }
    specs.push({ server: part.server, label: facts.label, prefix: facts.prefix, command, args, env: context.env });
  }
  return { specs, skipped };
}
