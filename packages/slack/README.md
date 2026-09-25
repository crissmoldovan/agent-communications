# @agentcomms/slack

Slack for coding agents. Read channels, threads, search, people and files across one or more workspaces — and
draft messages that **nothing posts without a person's approval of exactly what goes out**.

```sh
npm install -g @agentcomms/slack    # or run it with npx @agentcomms/slack <command>
```

## What makes this different from a Slack integration

**Read-only means read-only, and Slack enforces it.** Slack's read and write scopes are genuinely disjoint: a
token holding only `*:history` and `*:read` cannot call `chat.postMessage` at all, and the consent screen says
so. Install a workspace in the default `read` mode and no bug in this software can post from it.

Be exact about what that buys. It is **"this package cannot post"**, not "nothing on this machine can post" — a
second Slack server holding a write token for the same workspace posts without going near this one. Look in your
agent's MCP server list for another Slack entry, and remove it if you want the guarantee to mean anything.

**Nothing is posted without a person.** Even in `send` mode, an agent prepares and a person approves that exact
content — by saying yes in the conversation under the workspace's `chat` policy, or by typing a code at their own
terminal under `confirm`; under `never` nothing posts. A broadcast or a large room needs the terminal whatever the
policy says. The preview shows what the recipient will read and **how many people it interrupts** — `@channel` is
eight characters whether the room holds three people or four hundred.

**You bring your own Slack app.** There is no shared app to install. `agent-slack manifest` prints one to create
in your own workspace, so the scopes are visible before anything is granted and your admins keep control. No
client secret is stored anywhere: the sign-in is PKCE, and the verifier never leaves your machine.

## Getting started

```sh
agent-slack manifest --mode read --port 51234      # the app to create, and how
agent-slack workspace add acme/slack --client-id <id> --port 51234
agent-slack doctor
agent-slack mcp install --client claude-code         # connect it to your agent
```

The port must be the same number in both commands — Slack stores redirect URLs on the app and matches them
exactly.

## Changing a workspace, and who approves it

Connecting a workspace, signing it in again, moving it between `read` and `send`, setting its policies and removing
it work from a terminal and from a chat alike, and ask the same way. Anything that loosens what a workspace may do —
connecting it in `send`, moving it to `send`, loosening a policy — or that cannot be taken back — removing it — is a
**change approval**: you are shown a preview of exactly what changes, and nothing happens until you agree to it.
Tightening applies at once.

```sh
agent-slack workspace mode acme/slack send                 # the app's send manifest, and the link to its page, first
agent-slack workspace mode acme/slack send --app-updated   # then the change: a preview, your yes, and the sign-in
agent-slack workspace policy acme/slack --send confirm     # tightening: applied at once
agent-slack workspace remove acme/slack                    # a preview, then your yes
```

How you agree is the workspace's **change policy**. Under `chat`, the default, a yes — in the conversation, or typed
at the terminal running the command. Under `confirm`, a code typed at your own terminal: the command asks for it, and
an agent asks you to run `agentcomms approve <id>` (`npx -y @agentcomms/core approve <id>` if only `@agentcomms/slack`
is installed). `agent-slack workspace policy <name> --change confirm` switches to that; moving back to `chat` is itself
approved under `confirm`. An agent that runs the command without your approval gets the preview and an approval id,
exits 10, and runs it again with `--approval <id>` once you have agreed.

Every sign-in stops at Slack's own consent screen, which is yours to approve, and the app's manifest is yours to
change.

## Changing the app from the CLI

Pasting the manifest on the app's page is the default. With an **app configuration token** — generated at
https://api.slack.com/apps under "Your App Configuration Tokens", valid for twelve hours — the CLI can do that step
itself:

```sh
agent-slack app create acme/slack --mode read --port 51234   # a new app; prints its Client ID and what to run next
agent-slack app update acme/slack --mode send                # the app acme/slack signed in through, to the send manifest
```

Both ask Slack to validate the manifest first, and a refusal changes nothing. `app update` replaces the app's whole
configuration with the manifest `agent-slack manifest` prints — a hand-set name or description included — and
changes no token: a workspace updated to `send` still cannot post until you run `agent-slack workspace mode <name>
send --app-updated` and approve the change and the sign-in, which it prints. `app create` keeps only the app id and Client ID from Slack's reply; the client secret and
signing secret it also returns are dropped unseen, because the PKCE sign-in needs neither.

The token is read from a hidden prompt, or from `SLACK_APP_CONFIG_TOKEN` for that one command, and is used for that
command's calls only: never stored, logged or printed, and never accepted as an option, which would land in your
shell history. Without a terminal or the variable, the command refuses. No MCP tool takes the token or changes an
app — a token typed into a chat stays in the transcript — so an agent gives you the command to run instead.

## Reading

```sh
agent-slack channels --workspace acme/slack
agent-slack read C024BE7LR --workspace acme/slack --limit 50
agent-slack thread C024BE7LR 1700000000.000100 --workspace acme/slack
agent-slack search 'in:#engineering invoice' --workspace acme/slack
```

Every read is bounded and says so: `complete: false` means a page remained, and a short list is not a quiet
channel.

Everything a sender controls arrives inside an `<untrusted-content>` envelope — the message, the notification
half when it disagrees, attachments, and anything Slack unfurled, each labelled with what it is and whose page it
came from. Two flags are worth acting on:

- **`mismatch`** — the message says one thing in the channel and another in its notification text. Slack does not
  make the two agree, and that gap is how an instruction reaches a model that nobody in the room can see.
- **`unrenderable`** — part of the message could not be shown.

Attribution comes from `bot_id` and `user`, which an app cannot choose. A display name it picked for a message is
reported as the name it wore, never as identity.

## Posting

```sh
agent-slack draft create --workspace acme/slack --channel C024BE7LR --text 'ready when you are'
agent-slack post prepare --workspace acme/slack --draft <draftId>   # prints the preview, posts nothing
agent-slack approve <approvalId>                                    # under `confirm`: you, at your terminal
agent-slack post send --workspace acme/slack --draft <draftId> --approval <approvalId> --expect-channel C024BE7LR
```

A draft is a local file, because Slack has no server-side draft. That is better in one way — nothing exists in
Slack until you say yes — and worse in another: you cannot open it in Slack and finish it yourself, so the
preview is written to be pasteable.

The approval binds the exact bytes. Editing the draft voids it; so does the room growing between the preview and
the post, because the words did not change but who reads them did.

## As an MCP server

Register it with your agent's client, which also starts it once to prove the entry works:

```sh
agent-slack mcp install --client claude-code                       # or codex, cursor, gemini, claude-desktop, vscode
agent-slack mcp install --client claude-code --workspace acme/slack # pinned to one workspace
```

The entry pins the exact version, so a newer release reaches the agent only when you register it again with
`--force`, then restart the client. `agent-slack mcp --workspace acme/slack` runs the server on stdio directly.

| Tools | What they do |
|---|---|
| `slack_workspaces_list`, `slack_workspace_show`, `slack_mode` | which workspaces are connected, and what each may do |
| `slack_workspace_add`, `slack_workspace_finish` | connect a workspace: start the sign-in and return its link, then finish it — `send` is approved first |
| `slack_workspace_reauth` | sign one in again — widening to `send` is approved first |
| `slack_mode_set` | move one to `send` (the app's manifest first, then an approved change) or back to `read` (the steps) |
| `slack_workspace_policy` | report or set how its posts and its changes are approved — loosening is approved first |
| `slack_workspace_remove` | disconnect one and delete its token — approved first |
| `slack_doctor` | what `agent-slack doctor` checks, as the same JSON |
| `slack_manifest` | the app manifest, and for a connected workspace the link to its own app's manifest page — changes nothing |
| `slack_channels`, `slack_read`, `slack_thread`, `slack_search`, `slack_people`, `slack_files` | read, bounded |
| `slack_post_prepare` | compose a draft and return the preview a person must approve — posts nothing |
| `slack_post_send` | post a prepared draft once its approval allows it — the operation `agent-slack post send` runs |
| `slack_react`, `slack_react_send` | add or remove a reaction through the same gate — `agent-slack react` |
| `slack_draft_list`, `slack_draft_get`, `slack_draft_delete` | the drafts prepares leave behind |
| `slack_mode_request_send`, `slack_mode_narrow` | the steps to change a workspace's mode, as text — changes nothing |

Every one that acts on a workspace takes `workspace`. The full list, with arguments, is `docs/reference/slack-mcp-tools.md` in
[the repository](https://github.com/crissmoldovan/agent-communications).

Or embed it:

```js
import { createSlackMcpServer } from '@agentcomms/slack';

const server = await createSlackMcpServer({ workspace: 'acme/slack' });
await server.connectStdio();
```

No tool approves. `slack_post_send` and the reaction tools claim an approval through the gate the CLI uses: under
`chat` your yes in the conversation is the approval; under `confirm` they return `APPROVAL_PENDING` with the
`agent-slack approve <approvalId>` command for you to run, and post only after you have; under `never` they refuse.
The tools that change a workspace return a preview and an approval id first, whenever the change loosens it or
removes it, and apply it only when called again with that id — after your yes under the `chat` change policy, after
`agentcomms approve` at your terminal under `confirm`. A server pinned to one workspace connects and removes none. No
tool changes the Slack app itself: that needs an app configuration token, and a chat's transcript would keep it.

## Modes

| Mode | What the token can do | Who enforces it |
|---|---|---|
| `read` (default) | history, read, users, files, search | **Slack** |
| `send` | the above plus `chat:write`, `files:write`, `reactions:write` | this package's approval gate |

Moving to `send` means editing your app's manifest — on its page, or with `agent-slack app update <name> --mode
send` — and then approving the change and re-authorising: a new grant you approve in Slack's own UI.
`agent-slack workspace mode <name> send` walks both, from a terminal or, as `slack_mode_set`, from a chat. Going
back means removing the app's installation in Slack first: Slack adds scopes to a token and never removes one.
`agent-slack workspace mode <name>` prints either path.

## Licence

MIT.
