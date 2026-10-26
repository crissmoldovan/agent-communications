import { stat } from 'node:fs/promises';
import { Server, type Transport } from '@modelcontextprotocol/server';
import type { Config } from '../config.ts';
import {
  CONNECTION_ID_PATTERN,
  CONNECTION_KEY_ENV,
  type ConnectionRecord,
  connectionById,
  connectionKeyMatches,
  partFacts,
} from '../connections.ts';
import type { Core } from '../core.ts';
import { VERSION } from '../version.ts';
import { gatewayInstructions, refusedInstructions } from './instructions.ts';
import { connectionExtensions, type PartsContext, partSpecs } from './parts.ts';
import { type PartSpec, Router } from './router.ts';
import { markConnectionUsed, removeGatewayStatus, writeGatewayStatus } from './status.ts';

/**
 * `agentcomms mcp --connection <id>` (single-server design D2, §4): the gateway an app starts once per connection.
 *
 * At start it reads the connection's record and checks the key its entry carries (`AGENT_COMMS_CONNECTION_KEY`)
 * against the hash the record keeps, in constant time (D10). A connection that is unknown, cut off or unreadable, or a
 * key that does not match, serves no tools, with instructions that say why and what the person does — exiting instead
 * would let the app say only "failed to start". The key is then taken out of this process's environment, and no part
 * is ever given it.
 *
 * It follows its connection live (D15): before every request, and every 30 seconds, it looks at `config.json`; a part
 * added is started, one taken out stopped, one whose pin or switch changed started again, and the client is told with
 * `tools/list_changed`. A connection cut off or removed, or whose key was replaced, stops every part at once, and every
 * later call is refused with the reason.
 */

export interface GatewayOptions {
  readonly core: Pick<Core, 'paths' | 'config'>;
  readonly env: NodeJS.ProcessEnv;
  readonly connection: string;
  readonly platform?: NodeJS.Platform | undefined;
  /** The client's transport: stdio's own, unless a test hands in one. */
  readonly transport?: Transport | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** For a test: the windows, waits and the interval it follows `config.json` at. */
  readonly startWindowMs?: number | undefined;
  readonly joinWindowMs?: number | undefined;
  readonly restartDelaysMs?: readonly number[] | undefined;
  readonly followEveryMs?: number | undefined;
  /** For a test: the `npx` an npx connection's parts start with. */
  readonly npx?: string | undefined;
  /** For a test: how a record's parts are started — stand-ins in place of the real servers. */
  readonly parts?: typeof partSpecs | undefined;
}

export interface Gateway {
  /** The router serving the parts, or null for a gateway that serves nothing. */
  readonly router: Router | null;
  /** Why it serves nothing, or null. */
  readonly refused: string | null;
  close(): Promise<void>;
}

/** Why a connection's record and key cannot be served, or null when they can — said to the person, never the key. */
export function connectionRefusal(config: Config, id: string, key: unknown): string | null {
  if (!CONNECTION_ID_PATTERN.test(id)) return `"${id.slice(0, 40)}" is not a connection's id`;
  const read = connectionById(config, id);
  if (read === undefined) return 'this connection is not in Agent Comms any more: it was removed';
  if (!read.readable) return 'this connection’s record in Agent Comms could not be read';
  if (read.record.revokedAt !== null) return 'this connection was cut off';
  if (key === undefined || key === '') return 'this app’s entry carries no key for the connection';
  if (!connectionKeyMatches(key, read.record.keyHash)) {
    return 'the key this app’s entry carries is not the connection’s: it was replaced, or the entry was copied from an older one';
  }
  return null;
}

/** The parts of a record whose start differs from `before`'s: added, taken out, or kept with another pin or switch. */
function partsDiff(
  before: ReadonlyMap<string, PartSpec>,
  after: readonly PartSpec[],
): { start: PartSpec[]; stop: string[] } {
  const start: PartSpec[] = [];
  const now = new Map(after.map((spec) => [spec.server, spec]));
  for (const spec of after) {
    const was = before.get(spec.server);
    if (
      was === undefined ||
      was.command !== spec.command ||
      JSON.stringify(was.args) !== JSON.stringify(spec.args) ||
      was.unavailable !== spec.unavailable
    ) {
      start.push(spec);
    }
  }
  const stop = [...before.keys()].filter((server) => !now.has(server));
  return { start, stop };
}

export async function runGateway(options: GatewayOptions): Promise<Gateway> {
  const { core, env } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const key = env[CONNECTION_KEY_ENV];
  // Held in this process only as long as it is needed to check: nothing it starts may inherit it (§4).
  delete env[CONNECTION_KEY_ENV];
  if (env !== process.env) delete process.env[CONNECTION_KEY_ENV];
  const startedAt = new Date().toISOString();
  const context: PartsContext = {
    paths: core.paths,
    env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.npx === undefined ? {} : { npx: options.npx }),
  };
  const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  const transport = options.transport ?? new StdioServerTransport();

  let config: Config | undefined;
  let refused: string | null;
  try {
    config = await core.config.load();
    refused = connectionRefusal(config, options.connection, key);
  } catch {
    refused = 'Agent Comms could not read its configuration';
  }
  const record = (): ConnectionRecord | undefined => {
    const read = config === undefined ? undefined : connectionById(config, options.connection);
    return read?.readable ? read.record : undefined;
  };

  if (refused !== null || record() === undefined) {
    const why = refused ?? 'this connection’s record in Agent Comms could not be read';
    log(`[agentcomms] serving nothing: ${why}`);
    // Serves no tools, with instructions that say why: an app that started it shows them, not "failed to start".
    const handle = serveStdio(
      () => {
        const server = new Server(
          { name: 'agentcomms', version: VERSION },
          { capabilities: { tools: { listChanged: true } }, instructions: refusedInstructions(why) },
        );
        server.setRequestHandler('tools/list', () => ({ tools: [] }));
        return server;
      },
      { transport, onerror: () => undefined },
    );
    await writeGatewayStatus(core.paths.stateDir, {
      connection: options.connection,
      pid: process.pid,
      startedAt,
      client: null,
      refused: why,
      parts: [],
    }).catch(() => undefined);
    return {
      router: null,
      refused: why,
      close: async () => {
        await handle.close();
        await removeGatewayStatus(core.paths.stateDir, options.connection).catch(() => undefined);
      },
    };
  }

  const served = record() as ConnectionRecord;
  const specsOf = async (held: ConnectionRecord, from: Config): Promise<PartSpec[]> => {
    const { specs, skipped } = await (options.parts ?? partSpecs)(held, from, context);
    return [
      ...specs,
      ...skipped.map(
        (part): PartSpec => ({
          server: part.server,
          label: part.label,
          prefix: partFacts(part.server)?.prefix ?? part.server,
          command: '',
          args: [],
          unavailable: part.why,
        }),
      ),
    ].sort(
      (a, b) =>
        held.parts.findIndex((each) => each.server === a.server) -
        held.parts.findIndex((each) => each.server === b.server),
    );
  };
  const initial = await specsOf(served, config as Config);
  let name = served.name;
  let lastStat: string | null = null;
  let lastUsedMark = 0;
  let statusQueue: Promise<void> = Promise.resolve();

  const writeStatus = (refusedNow: string | null) => {
    statusQueue = statusQueue
      .then(() =>
        writeGatewayStatus(core.paths.stateDir, {
          connection: options.connection,
          pid: process.pid,
          startedAt,
          client: router.client(),
          refused: refusedNow,
          parts: router.status(),
        }),
      )
      .catch(() => undefined);
  };

  /** D15: `config.json` as it is now, and what changed for this connection. Null to serve; the reason to refuse. */
  const follow = async (): Promise<string | null> => {
    let stamp: string;
    try {
      const facts = await stat(core.config.path);
      stamp = `${facts.mtimeMs}:${facts.size}:${facts.ino}`;
    } catch {
      stamp = 'missing';
    }
    if (stamp === lastStat) return null;
    lastStat = stamp;
    let next: Config;
    try {
      next = await core.config.load();
    } catch {
      return null;
    }
    const why = connectionRefusal(next, options.connection, key);
    if (why !== null) return why;
    const read = connectionById(next, options.connection);
    if (read === undefined || !read.readable) return 'this connection’s record in Agent Comms could not be read';
    config = next;
    name = read.record.name;
    const { start, stop } = partsDiff(router.specs(), await specsOf(read.record, next));
    for (const server of stop) await router.removePart(server);
    for (const spec of start) await router.addPart(spec);
    return null;
  };

  const router: Router = new Router({
    parts: initial,
    connectionId: options.connection,
    serverInfo: { name: 'agentcomms', version: VERSION },
    extensions: connectionExtensions(served),
    instructions: (input) => gatewayInstructions(name, input),
    log,
    onStatus: () => writeStatus(null),
    beforeRequest: follow,
    onCall: () => {
      const now = Date.now();
      if (now - lastUsedMark < 30_000) return;
      lastUsedMark = now;
      void markConnectionUsed(core.paths.stateDir, options.connection).catch(() => undefined);
    },
    ...(options.startWindowMs === undefined ? {} : { startWindowMs: options.startWindowMs }),
    ...(options.joinWindowMs === undefined ? {} : { joinWindowMs: options.joinWindowMs }),
    ...(options.restartDelaysMs === undefined ? {} : { restartDelaysMs: options.restartDelaysMs }),
  });
  // The stat it starts from, so the first request does not read the file again for nothing.
  try {
    const facts = await stat(core.config.path);
    lastStat = `${facts.mtimeMs}:${facts.size}:${facts.ino}`;
  } catch {
    lastStat = 'missing';
  }
  const handle = await router.serve(transport);
  const every = setInterval(() => {
    void follow().then(
      (why) => (why === null ? undefined : router.refuse(why).then(() => writeStatus(why))),
      () => undefined,
    );
  }, options.followEveryMs ?? 30_000);
  every.unref();
  writeStatus(null);
  return {
    router,
    refused: null,
    close: async () => {
      clearInterval(every);
      await handle.close();
      await statusQueue;
      await removeGatewayStatus(core.paths.stateDir, options.connection).catch(() => undefined);
    },
  };
}
