import {
  appConnectionPart,
  CHANNEL_SERVERS,
  type Config,
  findById,
  type InstallOptions,
  type InstallResult,
  mcpInstall as install,
  isProductServer,
  type Launcher,
  listRegisteredServers,
  type McpProduct,
  missingEntryFile,
  type PruneResult,
  pruneManagedRuntimes,
  type RegisteredServer,
  readConnections,
  type ServerEntry,
  type SupportedClient,
  verifyEntry as verify,
} from '@agentcomms/core';
import type { GmailContext } from '../context.ts';
import { VERSION } from '../version.ts';

/**
 * Registering the Gmail server with an MCP client.
 *
 * The machinery moved to `@agentcomms/core` when Slack needed the same thing — where each client keeps its
 * servers, how a minimal PATH breaks a bare `node`, which npm binary works on Windows. What stayed here is what
 * is actually about Gmail: the package to install, the flags it takes, and the warning about third-party servers
 * whose send tools no approval gates.
 */
export type { InstallOptions, InstallResult, Launcher, PruneResult, ServerEntry, SupportedClient };

/**
 * Exported for the doctor, which reads registered entries back with the same facts that wrote them.
 *
 * The facts themselves — the package, its flags, how an entry is read back, and the warning about other Gmail
 * servers whose send tools nothing gates — are core's `CHANNEL_SERVERS.gmail`, which the core server's
 * `comms_server_install` registers from too, so both surfaces warn alike. What is added here is what only this
 * package knows: its own version, and where its code is.
 */
export const GMAIL_MCP: McpProduct = {
  ...CHANNEL_SERVERS.gmail,
  version: VERSION,
  moduleUrl: import.meta.url,
};

/**
 * The MCP clients whose config files register this server, by core's one rule for what is ours.
 *
 * What `setup` counts as its agent step done: some entry of ours, for any mailbox. Not what a finish decides by —
 * that is whether the entry serves the mailbox it has just connected, `clientServesInbox`. A config that cannot be
 * read is left out rather than failing: for "which clients have it" the answer is the ones that could be read.
 */
export async function clientsRegisteredWith(env: NodeJS.ProcessEnv, config?: Config): Promise<string[]> {
  let clients: string[] = [];
  try {
    const servers = await listRegisteredServers(env);
    clients = servers.filter((server) => isProductServer(server, GMAIL_MCP)).map((server) => server.client);
  } catch {
    // The ones that could be read: none.
  }
  /*
   * And every app whose MCP connection has Gmail as a part (single-server design D17, D19): what `setup` and
   * `mcp install` register from 0.35.0, and which no app's config holds an entry of Gmail's own for. Left out, a
   * setup that had just put Gmail into the app's connection would say the agent step was still to do.
   */
  if (config !== undefined) {
    for (const read of readConnections(config).connections) {
      if (!read.readable || read.record.revokedAt !== null || read.record.app === 'manual') continue;
      if (read.record.parts.some((part) => part.server === 'gmail')) clients.push(read.record.app);
    }
  }
  return [...new Set(clients)];
}

/**
 * The app's MCP connection — the one `mcp install --client <app>` puts Gmail into (`appConnectionPart`) — when its
 * Gmail part reaches `inbox`: every mailbox, or kept to exactly this one. What a finish checks before it puts Gmail
 * into the connection, as `clientServesInbox` is for an entry of Gmail's own. Null otherwise, and for an app with
 * several connections for every folder, where `mcp install` names none.
 */
export function connectionServesInbox(
  config: Config,
  env: NodeJS.ProcessEnv,
  request: { client: string; inbox: string },
): { id: string; name: string } | null {
  const found = appConnectionPart(config, env, request.client, 'gmail');
  if (found === null) return null;
  const { pin } = found.part;
  if (pin !== undefined && findById(config, 'inbox', pin.id)?.alias !== request.inbox) return null;
  return { id: found.connection.id, name: found.connection.name };
}

/**
 * Whether `client` already has an entry of this server that serves `inbox` — what a finish checks before it makes
 * the registration `setup` asked for, and what `gmail_inbox_finish` checks before it hands one back.
 *
 * Only the entry that registration would find in its place counts: of ours, by core's one rule for that; at user
 * scope, the only one it writes; under the name it would use; unpinned, or pinned to exactly this mailbox; and still
 * able to start, by the doctor's own check (`missingEntryFile`). The client's name alone used to decide it, so an
 * entry pinned to another mailbox, a project's entry, one under another name, or one whose runtime had been deleted
 * made the finish say "already registered" — for a mailbox connected a moment ago that no server reached, in a
 * report that read as success. In every other case the registration goes ahead, and its own preflight refuses what
 * it must not replace: somebody else's server under that name, or ours without `--replace-server`.
 *
 * A config that cannot be read counts as not serving it: the registration is then made, and the installer refuses
 * it if the unread file is the one it would write.
 */
export async function clientServesInbox(
  env: NodeJS.ProcessEnv,
  request: { client: string; inbox: string; name?: string | undefined },
): Promise<boolean> {
  let servers: RegisteredServer[];
  try {
    servers = await listRegisteredServers(env);
  } catch {
    return false;
  }
  const name = request.name ?? GMAIL_MCP.defaultServerName;
  for (const server of servers) {
    if (server.client !== request.client || server.name !== name || server.scope === 'project') continue;
    if (!isProductServer(server, GMAIL_MCP)) continue;
    // Read as the installer reads a pin back, in either form: `--inbox work` and `--inbox=work`.
    const pin = GMAIL_MCP.narrowingOf(server.args).inbox;
    if (pin !== undefined && pin !== request.inbox) continue;
    if ((await missingEntryFile(server)) === null) return true;
  }
  return false;
}

/**
 * The mailbox `client`'s entry of ours under the name serves, when that is another than `inbox` — the entry a
 * registration for `inbox` would find in its place, pinned elsewhere — or null.
 *
 * A finish that registers the server for the mailbox it has just connected pins it to that mailbox when this is not
 * null (#47). Left to the installer, a replacement keeps the pin of the entry it replaces, so `setup --replace-server`
 * for `home` over an entry for `other` registered `other` again, and `home` was reached by nothing; and without
 * `--replace-server` the refusal's hint was that same command. With the pin given, the replacement serves `home`, and
 * the refusal names a second entry instead. Read as `clientServesInbox` reads: of ours, at user scope, under the name.
 */
export async function mailboxServedElsewhere(
  env: NodeJS.ProcessEnv,
  request: { client: string; inbox: string; name?: string | undefined },
): Promise<string | null> {
  let servers: RegisteredServer[];
  try {
    servers = await listRegisteredServers(env);
  } catch {
    return null;
  }
  const name = request.name ?? GMAIL_MCP.defaultServerName;
  for (const server of servers) {
    if (server.client !== request.client || server.name !== name || server.scope === 'project') continue;
    if (!isProductServer(server, GMAIL_MCP)) continue;
    const pin = GMAIL_MCP.narrowingOf(server.args).inbox;
    if (pin !== undefined && pin !== request.inbox) return pin;
  }
  return null;
}

export async function mcpInstall(context: GmailContext, options: InstallOptions): Promise<InstallResult> {
  /*
   * The pin is resolved before anything is written.
   *
   * A server pinned to a mailbox that does not exist — or to one renamed since — starts, fails, and says so only
   * in a client's log. This is the one part of the install that needs a Gmail context, which is why it is here
   * rather than in the shared code.
   */
  if (options.inbox) await context.inbox(options.inbox);
  return install(context, GMAIL_MCP, options);
}

export function verifyEntry(entry: ServerEntry): Promise<{ ok: boolean; detail: string }> {
  return verify(entry, { binary: GMAIL_MCP.binary, version: GMAIL_MCP.version });
}

/** Removes Gmail's managed runtimes that nothing registers and nothing runs. */
export function mcpPrune(
  context: GmailContext,
  options: { dryRun?: boolean; includePrinted?: boolean } = {},
): Promise<PruneResult> {
  return pruneManagedRuntimes(context, GMAIL_MCP, options);
}
