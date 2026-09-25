import {
  CHANNEL_SERVERS,
  type InstallOptions,
  type InstallResult,
  mcpInstall as install,
  type Launcher,
  type McpProduct,
  type PruneResult,
  pruneManagedRuntimes,
  type ServerEntry,
  type SupportedClient,
  verifyEntry as verify,
} from '@agentcomms/core';
import type { SlackContext } from '../context.ts';
import { requireWorkspace } from '../operations/workspaces.ts';
import { VERSION } from '../version.ts';

/**
 * Registering the Slack server with an MCP client.
 *
 * The machinery is `@agentcomms/core`'s, shared with Gmail: where each client keeps its servers, how a minimal
 * PATH breaks a bare `node`, which npm binary works on Windows. What is here is what is about Slack.
 */
export type { InstallOptions, InstallResult, Launcher, PruneResult, ServerEntry, SupportedClient };

/**
 * Exported for the doctor, which reads registered entries back with the same facts that wrote them.
 *
 * The facts themselves — the package, the `mcp` argument `npx` needs, the `--workspace` pin, and the warning about
 * other Slack servers — are core's `CHANNEL_SERVERS.slack`, which the core server's `comms_server_install` registers
 * from too, so both surfaces warn alike. What is added here is what only this package knows: its own version, and
 * where its code is.
 */
export const SLACK_MCP: McpProduct = {
  ...CHANNEL_SERVERS.slack,
  version: VERSION,
  moduleUrl: import.meta.url,
};

export async function mcpInstall(context: SlackContext, options: InstallOptions): Promise<InstallResult> {
  /*
   * The pin is resolved before anything is written.
   *
   * A server pinned to a workspace that does not exist — or to one renamed since — starts, fails, and says so
   * only in a client's log. `requireWorkspace` also resolves a former name, so a pin written before the rename
   * is refused with the name the workspace has now rather than reported as missing.
   */
  if (options.workspace) requireWorkspace(await context.config(), options.workspace);
  return install(context, SLACK_MCP, options);
}

export function verifyEntry(entry: ServerEntry): Promise<{ ok: boolean; detail: string }> {
  return verify(entry, { binary: SLACK_MCP.binary, version: SLACK_MCP.version });
}

/** Removes Slack's managed runtimes that nothing registers and nothing runs. */
export function mcpPrune(
  context: SlackContext,
  options: { dryRun?: boolean; includePrinted?: boolean } = {},
): Promise<PruneResult> {
  return pruneManagedRuntimes(context, SLACK_MCP, options);
}
