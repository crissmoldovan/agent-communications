# @agentcomms/gmail-mcp

The Gmail MCP server for coding agents, as its own command — so a client configuration can pin it:

```json
{
  "mcpServers": {
    "gmail": { "command": "npx", "args": ["-y", "@agentcomms/gmail-mcp@0.1.0"] }
  }
}
```

It is one call into [`@agentcomms/gmail`](https://www.npmjs.com/package/@agentcomms/gmail), which is where the server
and the `agent-gmail` command live. Part of
[agent-communications](https://github.com/crissmoldovan/agent-communications).

> **Status: 0.x, not published yet.**

## Set up mailboxes first

This package only serves; it does not connect anything. Use the command from `@agentcomms/gmail`:

```sh
npx @agentcomms/gmail client add ~/Downloads/client_secret_*.json --move
npx @agentcomms/gmail inbox add work --start
```

Then let it write the client configuration for you, which also proves the server starts:

```sh
npx @agentcomms/gmail mcp install --client claude-code --launcher npx
```

## Options

| Option | Effect |
|---|---|
| `--inbox <alias>` | serve only that mailbox; the `inbox` argument becomes optional |
| `--read-only` | register only the tools that cannot change anything |

## Sending

No tool here sends mail on its own. A send is prepared, shown to the user in full, and transmitted only after they
approve that exact content — the same message, the same recipients, within a short window, once. Every Gmail
permission that allows drafting also allows sending, so that rule lives in code rather than in the grant.

## Licence

MIT
