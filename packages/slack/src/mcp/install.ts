import {
  type InstallOptions,
  type InstallResult,
  mcpInstall as install,
  type Launcher,
  type McpProduct,
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
 *
 * There is no `warnAbout`. Gmail warns about third-party servers whose send tools no approval gates, because a
 * mail token that can read can also send. Slack's scopes are disjoint, so a `read` workspace's token cannot post
 * whatever else is installed — there is nothing to warn about that would be true.
 */
export type { InstallOptions, InstallResult, Launcher, ServerEntry, SupportedClient };

const SLACK: McpProduct = {
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
  version: VERSION,
  moduleUrl: import.meta.url,
  serverArgs: (options) => (options.workspace ? ['--workspace', options.workspace] : []),
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
  return install(context, SLACK, options);
}

export function verifyEntry(entry: ServerEntry): Promise<{ ok: boolean; detail: string }> {
  return verify(entry, { binary: SLACK.binary, version: SLACK.version });
}
