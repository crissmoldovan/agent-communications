# @cloudpixel/gmail

Gmail for coding agents: search, read, analyse and draft across several mailboxes — with **sending gated by an
approval the user gives at that moment**.

This package is the `agent-gmail` command and the MCP server behind it. It is part of
[agent-communications](https://github.com/crissmoldovan/agent-communications).

> **Status: 0.x, not published yet.** The commands below describe the released behaviour; until then, use it from a
> checkout.

## Why the sending rule exists

Every Gmail permission that lets an app write a draft also lets it send: there is no scope that separates the two.
So "the agent may draft but not send" cannot be enforced by the grant, and is enforced here instead — one code path
reaches Gmail's send endpoints, and it refuses without an approval that matches the exact message being sent.

## Install

```sh
npm install -g @cloudpixel/gmail    # or run it with npx @cloudpixel/gmail <command>
```

Node 22.12 or newer. Nothing else: the command ships as a single bundle.

## Connect a mailbox

You need one OAuth client of your own, created once in Google Cloud (type **Desktop app**), and published so its
tokens do not expire after a week. The `gmail-setup` skill walks an agent through it; by hand it is:

```sh
agent-gmail client add ~/Downloads/client_secret_*.json --move
agent-gmail inbox add work --email you@example.com --start   # prints a link
# open the link, choose the account, leave every permission ticked
agent-gmail inbox add --finish fl_… --wait 60
agent-gmail whoami --inbox work
```

`--start` and `--finish` are two commands because consent takes minutes and an agent's shell does not last that
long. On a terminal, plain `agent-gmail inbox add work` waits for the browser itself.

## Commands

| Command | What it does |
|---|---|
| `client add\|list\|remove` | the Google Cloud OAuth client every mailbox signs in through |
| `inbox add\|list\|show\|reauth\|rename\|policy\|remove\|import` | connect and manage mailboxes |
| `whoami --inbox <name>` | what Google says about a mailbox |
| `doctor [--inbox <name>]` | check everything that has to work, and say how to fix what does not |
| `mcp` | run the MCP server on stdio |
| `mcp install --client claude-code\|claude-desktop\|codex\|cursor\|gemini\|vscode\|json` | register the server, and prove it starts |

Every command takes `--json` and prints `{"ok":true,"schemaVersion":1,"data":…}` or, on failure,
`{"ok":false,"schemaVersion":1,"error":{"code","message","hint"}}` — with a documented exit code (`--help` lists
them). Data goes to stdout, messages to stderr.

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

Or embed it:

```js
import { createGmailMcpServer } from '@cloudpixel/gmail';

const server = await createGmailMcpServer({ inbox: 'work' });
await server.connectStdio();
```

Tools are registered by process flags only, so the tool list never varies between connections; what each mailbox may
do is checked on every call against the configuration as it is at that moment. An inbox added or a policy tightened
while the server runs applies to the next call.

## Where things are kept

| What | Where |
|---|---|
| Configuration | `$XDG_CONFIG_HOME/agent-communications`, else `~/.config/agent-communications` (`%APPDATA%` on Windows) |
| Tokens and client secrets | the system keychain, or owner-only files (`--store file`) |
| Approvals, audit log, state | `<config>/state` |

No secret is ever written to `config.json`, printed by a command, or put in a result.

## Licence

MIT
