import { displayUrl, isProductServer, type McpProduct, type RegisteredServer } from '@agentcomms/core';

/**
 * Other Slack MCP servers registered on this machine.
 *
 * The design calls for this and `doctor` printed "not checked" instead, on the reasoning that a `read` token
 * cannot post whatever else is installed. True, and beside the point: another Slack server posts with its own
 * token — `@modelcontextprotocol/server-slack` with a bot token in its env, the official one at
 * `mcp.slack.com` — and an agent uses whichever tool it finds. Everything this package does about approval
 * assumes it is the only route to Slack's posting methods.
 *
 * Matched on the word rather than on a list of packages. There are at least half a dozen such servers and more
 * each month, and a list is out of date the day it is written; a false "also registered" costs a glance, a
 * missed one costs the guarantee. The client's own `url` is read too, because the official server has nothing
 * else to match. What stays invisible is anything that does not say "slack" at all — a bridge that relays to
 * several services — and anything a client gets from somewhere other than its config file.
 */
export function findOtherSlackServers(
  servers: readonly RegisteredServer[],
  product: Pick<McpProduct, 'packageName' | 'npxPackage' | 'entryFiles' | 'binary' | 'bins'>,
): RegisteredServer[] {
  return servers.filter(
    (server) =>
      !isProductServer(server, product) &&
      /slack/i.test([server.name, server.command, ...server.args, server.url ?? ''].join(' ')),
  );
}

/**
 * One line naming a server: its name, client and what it runs — never its arguments or env, which may carry a
 * token, and of a URL only its host and path. A remote server's URL is often the credential itself, and this
 * line goes into `doctor --json`, which the skills tell agents to run.
 */
export function describeOtherSlackServer(server: RegisteredServer): string {
  const what = (server.url ? displayUrl(server.url) : undefined) ?? server.packageName;
  return `"${server.name}" in ${server.client}${what ? ` (${what})` : ''}`;
}

/** How to remove one, in the client's own terms. */
export function removalFor(server: RegisteredServer): string {
  // A project's entry is out of reach of the user-scope commands below, run from wherever `doctor` was.
  if (server.scope === 'project') return `remove "${server.name}" from the project entry in ${server.path} by hand`;
  switch (server.client) {
    case 'claude-code':
      return `claude mcp remove ${server.name}`;
    case 'codex':
      return `codex mcp remove ${server.name}`;
    default:
      return `remove "${server.name}" from ${server.path}, then restart ${server.client}`;
  }
}
