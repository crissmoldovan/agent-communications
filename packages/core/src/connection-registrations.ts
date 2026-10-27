import { channelManifest, narrowingArgs, serverFacts } from './channel-servers.ts';
import type { Config } from './config.ts';
import { connectionReach, partFacts, readConnections } from './connections.ts';
import type { Core } from './core.ts';
import { launcherName, launcherPaths } from './launcher.ts';
import { type ClientConfigFile, type RegisteredServer, type ServerScan, scanRegisteredServers } from './mcp-clients.ts';
import { findById } from './names.ts';
import { nodeProgram } from './node-program.ts';
import { VERSION } from './version.ts';

/**
 * What is registered, or reached through an MCP connection (single-server design D19, §14 "Counting parts is a class of
 * bug"): every reader that asks "what is registered?" must also ask "what does a connection start?". A part reached
 * only through a connection's gateway is in no app's config, so `update` would leave its launcher on the old release,
 * the doctor would say no client starts it, and `channels` would show it unused. So those readers read this, which is
 * every entry in the apps' configs and, beside them, one entry per part of every connection here that serves — as the
 * gateway starts it, with `connection` saying whose it is.
 *
 * Only a managed or npx part is listed: a `local` connection runs a checkout's own code, which no update moves.
 */
export async function registeredOrConnected(
  core: Pick<Core, 'paths' | 'config'>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  also: readonly Pick<ClientConfigFile, 'client' | 'path'>[] = [],
): Promise<ServerScan> {
  const scan = await scanRegisteredServers(env, platform, also);
  let config: Config;
  try {
    config = await core.config.load();
  } catch {
    // A configuration that cannot be read names no connection: what the apps' configs say is all there is to count.
    return scan;
  }
  return {
    servers: [...scan.servers, ...connectionRegistrations(config, core.paths, env, platform)],
    unreadable: scan.unreadable,
  };
}

/** One entry per part of every connection that serves, as its gateway starts it. */
export function connectionRegistrations(
  config: Config,
  paths: {
    readonly configDir: string;
    readonly stateDir: string;
    readonly dataDir: string;
    readonly secretsDir: string;
  },
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): RegisteredServer[] {
  const servers: RegisteredServer[] = [];
  const pins = [
    '--config-dir',
    paths.configDir,
    '--state-dir',
    paths.stateDir,
    '--data-dir',
    paths.dataDir,
    '--secrets-dir',
    paths.secretsDir,
  ];
  for (const read of readConnections(config).connections) {
    if (!read.readable || read.record.revokedAt !== null || read.record.launcher === 'local') continue;
    const { record } = read;
    for (const [server, reach] of connectionReach(read)) {
      const facts = partFacts(server);
      if (facts === undefined) continue;
      const alias =
        reach.pin === null
          ? undefined
          : facts.accounts === 'inboxes'
            ? findById(config, 'inbox', reach.pin.id)?.alias
            : findById(config, 'account', reach.pin.id)?.alias;
      // A part kept to an account that is gone is not started, so it is no registration of anything.
      if (reach.pin !== null && alias === undefined) continue;
      const manifest = channelManifest(server);
      const narrowing =
        manifest === undefined
          ? []
          : narrowingArgs(manifest, {
              client: 'json',
              ...(alias !== undefined && facts.pin !== undefined ? { [facts.pin]: alias } : {}),
              ...(reach.readOnly ? { readOnly: true } : {}),
            });
      const product = serverFacts(server);
      let command: string;
      let args: string[];
      if (record.launcher === 'npx') {
        command = 'npx';
        args = ['-y', `${product.npxPackage}@${VERSION}`, ...pins, ...(product.npxArgs ?? []), ...narrowing];
      } else {
        const launcher = launcherPaths(paths.dataDir, launcherName(product.packageName)).launcher;
        command = platform === 'win32' ? nodeProgram(env, platform) : launcher;
        args = platform === 'win32' ? [launcher, ...pins, 'mcp', ...narrowing] : [...pins, 'mcp', ...narrowing];
      }
      servers.push({
        client: record.app,
        path: record.entry?.path ?? 'a snippet pasted by hand',
        name: record.entry?.name ?? 'agentcomms',
        scope: record.where.scope === 'local' ? 'project' : 'user',
        command,
        args,
        connection: { id: record.id, name: record.name },
      });
    }
  }
  return servers;
}
