import type { RegisteredServer } from '@agentcomms/core';

/**
 * Other Gmail MCP servers on this machine, and why each one matters.
 *
 * This stayed behind when the client-config machinery moved to `@agentcomms/core`, and the split is the point:
 * *where a client keeps its servers* is the same question for every product, while *which third-party servers
 * send mail with no approval step* is a fact about Gmail. Slack keeps its own answer for Slack.
 */

export interface LegacyServerFinding extends RegisteredServer {
  /** The npm package that makes this a finding; `name` stays the client's own name for the entry. */
  packageName: string;
  /** Why it is a problem, in one sentence. */
  reason: string;
  removal: string;
}

const UNGATED_GMAIL_SERVERS: Array<{
  pattern: RegExp;
  name: string;
  removal: (server: RegisteredServer) => string;
}> = [
  {
    pattern: /@artymclabin\/gmail-mcp/,
    name: '@artymclabin/gmail-mcp',
    removal: (server) => removalCommand(server),
  },
  {
    pattern: /@gongrzhe\/server-gmail-autoauth-mcp|(?<![\w@/-])server-gmail-autoauth-mcp/,
    name: '@gongrzhe/server-gmail-autoauth-mcp',
    removal: (server) => removalCommand(server),
  },
  {
    pattern: /@shinzolabs\/gmail-mcp/,
    name: '@shinzolabs/gmail-mcp',
    removal: (server) => removalCommand(server),
  },
];

function removalCommand({ client, name: server, path, scope }: RegisteredServer): string {
  // A project's entry is out of reach of the user-scope commands below, run from wherever `doctor` was.
  if (scope === 'project') return `remove "${server}" from the project entry in ${path} by hand`;
  switch (client) {
    case 'claude-code':
      return `claude mcp remove ${server}`;
    case 'codex':
      return `codex mcp remove ${server}`;
    default:
      // The file named, not "the file above": this is printed under a different client's install, and by
      // `doctor` in a list of several, where the file above is somebody else's.
      return `remove the "${server}" entry from ${path}, then restart ${client}`;
  }
}

/** Registered servers known to send mail with no approval step, each with why it matters and how to remove it. */
export function findUngatedGmailServers(servers: readonly RegisteredServer[]): LegacyServerFinding[] {
  const findings: LegacyServerFinding[] = [];
  for (const server of servers) {
    const line = [server.command, ...server.args].join(' ');
    for (const known of UNGATED_GMAIL_SERVERS) {
      if (!known.pattern.test(line)) continue;
      findings.push({
        ...server,
        packageName: known.name,
        reason: `${known.name} exposes send tools that no approval step gates`,
        removal: known.removal(server),
      });
      break;
    }
  }
  return findings;
}
