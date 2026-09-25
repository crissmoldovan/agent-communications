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

## Set up mailboxes first

This package serves mailboxes; connecting them is `@agentcomms/gmail`, and one command does all of it —
the Google Cloud steps, the client, the first mailbox, and registering this server with your agent:

```sh
npx @agentcomms/gmail setup
```

To register it separately, or to move an existing registration to a new version:

```sh
npx @agentcomms/gmail mcp install --client claude-code --launcher npx
```

### Connecting a mailbox from the agent instead

Three of the 38 tools do the onboarding, so an agent asked to "set up Gmail" need not send you to a terminal:
`gmail_setup` says what is missing and changes nothing, `gmail_inbox_add` returns a sign-in link and stops, and
`gmail_inbox_finish` completes it once Google returns the grant. The grant is still yours to approve in your own
browser — this server does not open one and cannot grant it.

Those two writers are withheld from a server started `--read-only`, and from one pinned to a single mailbox with
`--inbox`. `gmail_inbox_finish` refuses any flow that is not an add, so a re-authorisation started elsewhere
cannot be completed through MCP.

Six more manage what is connected, each the same operation as an `agent-gmail` command: `gmail_inbox_show`,
`gmail_clients_list` and `gmail_confirm_clients` read; `gmail_inbox_rename`, `gmail_inbox_policy` and
`gmail_confirm_client_remove` change only what needs nobody's approval — a name, a stricter policy, one client
fewer trusted to show approval forms. Asked to make sending easier, `gmail_inbox_policy` refuses and names the
command you run instead. The three writers are withheld from a `--read-only` server, and a pinned one does not
rename.

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
