import type { RegisteredServer } from '@agentcomms/core';

/**
 * Other Gmail MCP servers on this machine, and why each one matters.
 *
 * This stayed behind when the client-config machinery moved to `@agentcomms/core`, and the split is the point:
 * *where a client keeps its servers* is the same question for every product, while *which third-party servers
 * send mail with no approval step* is a fact about Gmail. Slack has no equivalent — a `read` workspace's token
 * cannot post at all — so there is nothing here for it to inherit.
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
  removal: (client: string, server: string) => string;
}> = [
  {
    pattern: /@artymclabin\/gmail-mcp/,
    name: '@artymclabin/gmail-mcp',
    removal: (client, server) => removalCommand(client, server),
  },
  {
    pattern: /@gongrzhe\/server-gmail-autoauth-mcp|(?<![\w@/-])server-gmail-autoauth-mcp/,
    name: '@gongrzhe/server-gmail-autoauth-mcp',
    removal: (client, server) => removalCommand(client, server),
  },
  {
    pattern: /@shinzolabs\/gmail-mcp/,
    name: '@shinzolabs/gmail-mcp',
    removal: (client, server) => removalCommand(client, server),
  },
];

function removalCommand(client: string, server: string): string {
  switch (client) {
    case 'claude-code':
      return `claude mcp remove ${server}`;
    case 'codex':
      return `codex mcp remove ${server}`;
    default:
      return `remove the "${server}" entry from the file above, then restart ${client}`;
  }
}

/** The config files worth looking at, whether or not they exist. */
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
        removal: known.removal(server.client, server.name),
      });
      break;
    }
  }
  return findings;
}
