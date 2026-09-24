import {
  type InstallOptions,
  type InstallResult,
  mcpInstall as install,
  type Launcher,
  type McpProduct,
  type RegisteredServer,
  type ServerEntry,
  type SupportedClient,
  verifyEntry as verify,
} from '@agentcomms/core';
import type { GmailContext } from '../context.ts';
import { findUngatedGmailServers } from '../operations/client-configs.ts';
import { VERSION } from '../version.ts';

/**
 * Registering the Gmail server with an MCP client.
 *
 * The machinery moved to `@agentcomms/core` when Slack needed the same thing — where each client keeps its
 * servers, how a minimal PATH breaks a bare `node`, which npm binary works on Windows. What stayed here is what
 * is actually about Gmail: the package to install, the flags it takes, and the warning about third-party servers
 * whose send tools no approval gates.
 */
export type { InstallOptions, InstallResult, Launcher, ServerEntry, SupportedClient };

const GMAIL: McpProduct = {
  packageName: '@agentcomms/gmail',
  binary: 'agent-gmail',
  defaultServerName: 'gmail',
  npxPackage: '@agentcomms/gmail-mcp',
  version: VERSION,
  moduleUrl: import.meta.url,
  serverArgs: (options) => {
    const args: string[] = [];
    if (options.inbox) args.push('--inbox', options.inbox);
    if (options.readOnly) args.push('--read-only');
    return args;
  },
  warnAbout: (servers: readonly RegisteredServer[]) =>
    findUngatedGmailServers(servers).map(
      (finding) =>
        `${finding.packageName} is registered with ${finding.client} as "${finding.name}": ${finding.reason}. Remove it: ${finding.removal}`,
    ),
};

export async function mcpInstall(context: GmailContext, options: InstallOptions): Promise<InstallResult> {
  /*
   * The pin is resolved before anything is written.
   *
   * A server pinned to a mailbox that does not exist — or to one renamed since — starts, fails, and says so only
   * in a client's log. This is the one part of the install that needs a Gmail context, which is why it is here
   * rather than in the shared code.
   */
  if (options.inbox) await context.inbox(options.inbox);
  return install(context, GMAIL, options);
}

export function verifyEntry(entry: ServerEntry): Promise<{ ok: boolean; detail: string }> {
  return verify(entry, { binary: GMAIL.binary, version: GMAIL.version });
}
