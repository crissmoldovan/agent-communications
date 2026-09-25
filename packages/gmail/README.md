# @agentcomms/gmail

Gmail for coding agents: search, read, analyse and draft across several mailboxes — with **sending gated by an
approval the user gives at that moment**.

This package is the `agent-gmail` command and the MCP server behind it. It is part of
[agent-communications](https://github.com/crissmoldovan/agent-communications).


## Why the sending rule exists

Every Gmail permission that lets an app write a draft also lets it send: there is no scope that separates the two.
So "the agent may draft but not send" cannot be enforced by the grant, and is enforced here instead — one code path
reaches Gmail's send endpoints, and it refuses without an approval that matches the exact message being sent.

## Install

```sh
npm install -g @agentcomms/gmail    # or run it with npx @agentcomms/gmail <command>
```

Node 22.12 or newer. Nothing else: the command ships as a single bundle.

## Connect a mailbox

```sh
npm i -g @agentcomms/gmail
agent-gmail setup
```

`setup` is the way in. You need one OAuth client of your own, created once in Google Cloud (type **Desktop app**)
and published so its tokens do not expire after a week — `setup` walks those five screens with a link to each and
says what to type in every field, then finds the JSON you downloaded, connects a mailbox, and offers to register
the MCP server. It skips whatever is already done, so running it again adds another mailbox.

At a terminal it draws a list you move through with the cursor keys; `--no-tui` asks the same questions one line
at a time. Where nobody can answer one — `--json`, `--no-input`, CI, a redirected stream — it acts on the flags it
was given and names the flag that would have let it continue:

```sh
agent-gmail setup --client-json ~/Downloads/client_secret_*.json \
  --inbox acme/gmail --email you@example.com --mcp-client claude-code --json
```

The one step it cannot finish is the grant: it returns the sign-in link and the command that completes it.
Registering the OAuth client and registering the MCP server are changes you approve. Run by an agent, `setup` stops
at each with the preview and an approval id, and runs again with `--approval <id>` for the OAuth client or
`--mcp-approval <id>` for the MCP server once you have said yes; at a terminal it asks you there.

### By hand

The commands `setup` wraps are all still there:

```sh
agent-gmail client add ~/Downloads/client_secret_*.json --move
agent-gmail inbox add acme/gmail --email you@example.com --start   # prints a link
# open the link, choose the account, leave every permission ticked
agent-gmail inbox add --finish fl_… --wait 60
agent-gmail whoami --inbox acme/gmail
```

`--start` and `--finish` are two commands because consent takes minutes and an agent's shell does not last that
long. On a terminal, plain `agent-gmail inbox add acme/gmail` waits for the browser itself.

## Commands

| Command | What it does |
|---|---|
| `setup` | the Google Cloud steps, the client, a mailbox and the agent connection, in one command |
| `client add\|list\|remove` | the Google Cloud OAuth client every mailbox signs in through |
| `inbox add\|list\|show\|reauth\|rename\|policy\|remove\|import` | connect and manage mailboxes |
| `whoami --inbox <name>` | what Google says about a mailbox |
| `doctor [--inbox <name>]` | check everything that has to work, and say how to fix what does not |
| `mcp` | run the MCP server on stdio |
| `mcp install --client claude-code\|claude-desktop\|codex\|cursor\|gemini\|vscode\|json` | register the server, and prove it starts (approved first) |
| `mcp prune [--dry-run]` | remove the runtimes old releases left behind (approved first) |

Every command takes `--json` and prints `{"ok":true,"schemaVersion":1,"data":…}` or, on failure,
`{"ok":false,"schemaVersion":1,"error":{"code","message","hint"}}` — with a documented exit code (`--help` lists
them). Data goes to stdout, messages to stderr.

### Changes that need your approval

`client add` and `client remove`, `inbox import` and `inbox remove`, `confirm-clients add`, a looser
`inbox policy`, an `inbox reauth` that asks for more access than the mailbox has, `mcp install` (it hands a client
a new set of tools) and `mcp prune` (a deleted runtime cannot be taken back) each loosen something or cannot be
undone, so each is approved before it happens. At a terminal the command shows exactly what will
change and asks you to type `yes` — or, under the `confirm` change policy, the code `agentcomms approve` shows.
Run by an agent, or with no terminal, it prints the same preview with an approval id and exits `10`; once you have
said yes, the same command with `--approval <id>` makes the change. Tightening a policy never asks.

The MCP server offers each of these as a tool that asks the same way, and an approval prepared on one surface can be
claimed on the other: it is one change. Registering and pruning are the core server's `comms_server_install` and
`comms_server_prune` with `channel: "gmail"`, and the same holds between them and `mcp install` and `mcp prune`.
`mcp install --print`, `--client json` and `mcp prune --dry-run` change nothing, and ask nobody.

## Coming from another Gmail MCP server

```sh
agent-gmail inbox import --dry-run    # says what it would take from ~/.gmail-mcp
agent-gmail inbox import
```

It copies; it never moves or deletes anything. Two things it cannot inherit: which Google account each mailbox is
(those tokens were issued without `openid`), and permission to label or archive. One `agent-gmail inbox reauth
<name> --start` per mailbox fixes both.

**It also tells you if the other server is still connected to an agent.** While it is, that server's send tools are
there too, and nothing in this package gates them.

## As an MCP server

```sh
agent-gmail mcp install --client claude-code
```

It shows what it will register and asks you to type `yes`; run by an agent, it exits `10` with that preview and an
approval id, and registers when run again with `--approval <id>` after your yes.

Or embed it:

```js
import { createGmailMcpServer } from '@agentcomms/gmail';

const server = await createGmailMcpServer({ inbox: 'acme/gmail' });
await server.connectStdio();
```

Tools are registered by process flags only, so the tool list never varies between connections; what each mailbox may
do is checked on every call against the configuration as it is at that moment. An inbox added or a policy tightened
while the server runs applies to the next call.

Every account command has its tool — `gmail_client_add`, `gmail_inbox_reauth`, `gmail_inbox_import`,
`gmail_inbox_remove`, `gmail_inbox_policy`, `gmail_confirm_client_add` and the rest — and a change that needs
approval returns `approvalRequired` with the preview and an `approvalId` instead of acting. The agent shows you the
preview and calls again with the id after your yes. `gmail_client_add` reads the client JSON from a path on your
machine; the file never passes through the conversation, and no tool returns its secret.

## Where things are kept

| What | Where |
|---|---|
| Configuration | `$XDG_CONFIG_HOME/agent-communications`, else `~/.config/agent-communications` (`%APPDATA%` on Windows) |
| Tokens and client secrets | the system keychain, or owner-only files (`--store file`) |
| Approvals, audit log, state | `<config>/state` |

No secret is ever written to `config.json`, printed by a command, or put in a result.

## Licence

MIT
