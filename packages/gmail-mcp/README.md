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

An agent asked to "set up Gmail" need not send you to a terminal: `gmail_setup` says what is missing and changes
nothing, `gmail_client_add` registers the OAuth client from the path of the JSON you downloaded, `gmail_inbox_add`
returns a sign-in link and stops, and `gmail_inbox_finish` completes it once Google returns the grant. The grant is
still yours to approve in your own browser — this server does not open one and cannot grant it. The client JSON is
read from its path on your machine, never pasted into the conversation, and no tool returns its secret.

Everything else `agent-gmail` does to an account is a tool too, each the same operation as its command:

| Tool | Command |
|---|---|
| `gmail_inbox_show`, `gmail_inboxes_list` | `inbox show`, `inbox list` |
| `gmail_inbox_rename` | `inbox rename` |
| `gmail_inbox_policy` — the send policy and the change policy | `inbox policy --send --change` |
| `gmail_inbox_reauth`, then `gmail_inbox_finish` | `inbox reauth --start`, then `--finish` |
| `gmail_inbox_import` | `inbox import` |
| `gmail_inbox_remove` | `inbox remove` |
| `gmail_clients_list`, `gmail_client_add`, `gmail_client_remove` | `client list\|add\|remove` |
| `gmail_confirm_clients`, `gmail_confirm_client_add`, `gmail_confirm_client_remove` | `confirm-clients list\|add\|remove` |

### How a change is approved

A change that loosens a safety setting or cannot be taken back — a looser policy, a wider grant, an OAuth client
added or removed, a mailbox imported or removed, a client trusted to show approval forms — does not happen on the
first call. The tool returns `approvalRequired`, a `preview` of exactly what would change and an `approvalId`; the
agent shows you the preview and asks. Under the `chat` change policy (the default) your yes is the approval, and
the agent calls again with the id. Under `confirm` you run `agentcomms approve <id>` in your own terminal and type
the code it shows first. An approval is for the change it previewed, once, for ten minutes: if anything is
different by the time it is claimed, it is refused and the change is prepared again. Tightening needs nobody. The
same approval can be claimed from the command line with `--approval <id>`, and the other way round.

The writers are withheld from a server started `--read-only`. One pinned to a single mailbox with `--inbox` sets
its own mailbox's policies and offers none of the rest.

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
