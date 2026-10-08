---
name: comms-onboarding
description: "Set a person up with agent-communications from chat: which channels and accounts, which mode each account should have, the servers registered, every sign-in started, and the steps only they can take named. Symptoms: 'set up my email and Slack', 'install agent-communications', 'connect Gmail and Slack to Claude', 'onboard me', 'set this up on my other computer'. Not for one account's settings once it works — gmail-setup and slack-setup do those."
license: MIT
compatibility: "@agentcomms/core@0.15.0"
metadata:
  group: communications
  lifecycle: release
---

# Onboarding

The whole setup, done from the conversation. Everything an agent can do, it does; everything that
needs the person — a Google Cloud client, a Slack app, a consent screen, an approval, a restart — is
handed to them as one clear step, with the exact link or command.

## Before anything: the core server

The core server (`agentcomms`) installs and manages the others. If its tools (`comms_…`) are not
available, the person runs one command in a terminal, types `yes` to what it will register, then
restarts the client:

```sh
npx -y @agentcomms/core mcp install --client claude-code
```

Use their client in place of `claude-code` (`codex`, `cursor`, `claude-desktop`, `gemini`,
`vscode`). If you can run commands, run it yourself: it exits `10` with the preview and an approval
id, and after their yes the same command with `--approval <id>` registers it. Every other step below
happens in chat, or through the commands in "Without the MCP tools".

## 1. Ask what they want, once

Ask in one message, and wait:

1. **Which channels:** Gmail, Slack, Resend (email a company sends from its own domain) and WhatsApp
   (the chats WhatsApp for Mac keeps, read-only).
2. **Which accounts:** each mailbox address, each Slack workspace, each Resend team, the WhatsApp store.
   Names are `organisation/platform` — `acme/gmail`, `acme/slack`, `acme/resend`, `personal/whatsapp`.
3. **What each account may do.**
   - Gmail: `read` (Google itself refuses to send), `draft` (also writes drafts) or `organize` (also
     labels, archives, bins). `draft` and `organize` can both send once a person approves — only this
     software stops them.
   - Slack: `read` (cannot post: Slack itself refuses) or `send` (posts, with approval).
   - Resend: `read` or `send`. Resend has no read-only key, so `read` is enforced by this software
     only. The key is typed by the person at a terminal (`agent-resend account add`) — never in chat.
   - WhatsApp: read only, always. The person adds the store at a terminal (`agent-whatsapp add`); a
     reply is a draft link they send themselves in WhatsApp.
4. **How sends and changes are approved:** by a yes in chat (`chat`, the default), given within ten
   minutes, or at a terminal with a typed code (`confirm`), within thirty minutes — an approval given
   there then holds for 24 hours. A send policy can also be `never`: nothing is sent or posted from
   here, and they do it in Gmail, Slack or Resend themselves.

`comms_channels_available` says what is already installed, at which version, and registered where;
start from that rather than from nothing.

## 2. Register the servers

`comms_server_install` for each channel chosen, with their client — skipping a channel whose server
`comms_channels_available` already shows registered with that client. It is a change: show the
preview, get their yes, call again with `approvalId`. Under `confirm`, `comms_approval_wait` tells you
when they have approved it at their terminal. When the person says no, revoke it at once with
`comms_approval_revoke`: the server never hears a "no".

Then ask them to restart the client **now**, once, after every server is registered: the channels'
tools below (`gmail_…`, `slack_…`, `resend_…`, `whatsapp_…`) exist only in the next session. Claude Code resumes this conversation with
`claude --continue`. If you can run commands, you may instead carry on in this session with the
commands in "Without the MCP tools", and leave the restart to the end.

## An organisation's apps

If the person's organisation provides a profile — a small `.agentcomms.json` file, from its repository
or sent inside the organisation — add it before connecting their accounts, so they make no Google client
or Slack app of their own. `comms_org_add` with the file's **path** (never its contents): a change, so
preview, yes, `approvalId`. The preview names the organisation, the file and its SHA-256, the Google
client and the client name it gets here — or the client of theirs it uses — and the Slack apps; the
client secret is never shown. Pass `forOtherAddresses: true` only if they ask for the organisation's client to serve their
other addresses too. It is added beside what they have; nothing of theirs is replaced, and
`comms_orgs_list` lists every profile added on this machine.

Gmail picks the eligible client before consent. Name the mailbox in `gmail_setup` and
`gmail_inbox_add`: an explicit `client` wins; otherwise `<organisation>/gmail` uses that profile's
active generation, one profile opted into `forOtherAddresses` may serve another name, and only then
does an ordinary client act as the fallback. If no client fits, `gmail_setup` offers the Google Cloud
walk instead of borrowing a profile client. Existing mailboxes stay on the client that granted their
token. Slack automatically selects the profile's read app for `rgc/slack`, or its send app when
`mode: "send"` is requested. No Client ID or port is needed. When the organisation
changes its file, `comms_org_update` reads it again — a changed profile is approved first, a repair
applies at once — and `comms_org_remove` stops using it.

## 3. Connect each account

- **Gmail:** `gmail_setup` with the mailbox's `inbox` says what is missing. With no eligible OAuth client, making one in
  Google Cloud is the person's step: `consoleSteps` has each screen, its link and what to type there.
  Then `gmail_client_add` with the downloaded client JSON's **path** (never its contents) — a change,
  so preview, yes, `approvalId`. `gmail_inbox_add` with the tier returns a Google link; give it to
  them, and `gmail_inbox_finish` once they are back.
- **Slack, with an organisation profile added:** do not create an app. Use `slack_workspace_add` with
  `workspace: "rgc/slack"` (CLI: `agent-slack workspace add rgc/slack --start`). It selects the
  profile's read app and port automatically. For send, pass `mode: "send"` (CLI: `--mode send`); it
  selects the profile's send app and asks for a change approval before sign-in. Give the person the
  link, then use `slack_workspace_finish` when they return. A later mode change moves the account
  directly between the profile's read and send apps through another sign-in; neither app is edited.
- **Slack, without one:** a workspace needs its own Slack app, and creating it is the person's step.
  `slack_manifest` with the mode and a `port` you choose (51234, say; it is required for a new app)
  returns the manifest. Tell them: open https://api.slack.com/apps, **Create New App** → **From a
  manifest**, pick the workspace, paste the JSON, create it, and copy the **Client ID** from **Basic
  Information** back to you. It is not a secret, and there is no client secret to copy. Then
  `slack_workspace_add` with the mode, the Client ID and the same port; for `send` it is a change and
  asks for approval before the sign-in starts. Give them the link; `slack_workspace_finish` when they
  are back.

- **Resend:** the person's step, at a terminal: `agent-resend account add <organisation>/resend`
  (`--mode send` to send) asks for the API key in a hidden prompt. Never ask for the key in chat.
  `resend_accounts_list` shows it once added.
- **WhatsApp:** the person's step, at the Mac's own terminal — macOS asks there for permission to
  read WhatsApp's data: `agent-whatsapp add <organisation>/whatsapp`, then
  `agent-whatsapp sync --account <organisation>/whatsapp`. `whatsapp_status` shows it; `whatsapp_sync`
  refreshes it later.

For a person's own app, a Slack workspace connected on another computer has an app already: reuse it,
and do not create a second one. On that computer, its Client ID is `oauthClientId` in
`slack_workspace_show`, and its port is `port` in `slack_manifest` with `workspace` (CLI:
`agent-slack manifest --workspace <name> --json`).

## 4. Set the policies

`gmail_inbox_policy`, `slack_workspace_policy` and `resend_account_policy` set how sends are
approved; `comms_change_policy` sets how changes are. WhatsApp never sends, so it has none. Tightening applies at once; loosening is a change like any other. A mailbox or
workspace set to `chat` itself stays `chat` when the default goes to `confirm`: show the person the
result's `warning`, and tighten each one it lists if that is what they meant.

## 5. Check, and hand over

- `comms_doctor`, `gmail_doctor`, `slack_doctor`, `resend_doctor` and `whatsapp_status`, for the
  channels set up: report anything not `ok` with its fix.
- No further restart, unless a server was registered after step 2 or you went on with the commands
  instead of restarting there. Then tell them to restart once, now, and what they will be able to ask
  for.
- List every step that was theirs and whether it is done.
- Tell them how to keep it current: "update my comms" in a chat later brings every server to the latest
  release (the `comms-update` skill).

## Without the MCP tools

Every step has a command, for a person at a terminal or an agent that can run commands. Each takes
`--json`. Where one is not installed, use `npx -y @agentcomms/<package>` in its place — `core`,
`gmail`, `slack`, `resend` or `whatsapp`.

| Step | Command |
|---|---|
| What is there | `agentcomms channels` |
| An organisation's profile | `agentcomms org add <file>`, then `agentcomms org show <organisation>` for its client's name; later `agentcomms org update <organisation>` or `agentcomms org remove <organisation>` |
| Register a server | `agent-gmail mcp install --client <client>`, and the same with `agent-slack`, `agent-resend` or `agent-whatsapp` |
| Gmail, in one command | `agent-gmail setup --inbox <name>` — the Google Cloud screens, the client, a mailbox and the registration. With `--profile <file>` its separate profile preview is claimed with `--org-approval <id>`. With `--json` it acts only on the flags it is given (`--client-json <path>`, `--inbox <name>`, `--email <address>`, `--mcp-client <client>`) and names the one it needs next |
| Gmail, step by step | `agent-gmail client add <path>`, then `agent-gmail inbox add <name> --tier <tier> --start`, then `agent-gmail inbox add --finish <flowId>` |
| Slack, organisation profile | `agent-slack workspace add rgc/slack --start` (or `--mode send --start`), then `agent-slack workspace add --finish <flowId>`; the profile selects its app and port |
| Slack, own app | `agent-slack manifest --mode <mode> --port <port>`, then `agent-slack workspace add <name> --client-id <id> --port <port> --mode <mode> --start`, then `agent-slack workspace add --finish <flowId>` |
| Resend | `agent-resend account add <name> --mode <mode>`, the key typed by the person |
| WhatsApp | `agent-whatsapp add <name>`, then `agent-whatsapp sync --account <name>`, at the Mac's terminal |
| Policies | `agent-gmail inbox policy <name> --send <policy> --change <policy>`, `agent-slack workspace policy <name> --send <policy> --change <policy>`, `agent-resend account policy <name> --send <policy> --change <policy>`, `agentcomms policy confirm` |
| Check | `agentcomms doctor`, `agent-gmail doctor`, `agent-slack doctor`, `agent-resend doctor`, `agent-whatsapp status` |

A change stops with exit `10`, its preview and an approval id, and changes nothing — with one
exception: `agentcomms org update <organisation> --for-other-addresses off` turns that off at once,
because narrowing never waits, and the preview and the final result both say it was done. Show the
preview; after their yes, run the command its hint gives, which carries the approval id. Under `confirm` they
first run the approve command the hint gives, in their own terminal, exactly as given, and
`agentcomms approval wait <id>` tells you when they have. If they say no, `agentcomms approvals revoke <id>`, at
once. A person running a command at a terminal approves there and then: `yes`, or the code under `confirm`.

## Pitfalls

- **Asking per step instead of once.** Ask the choices in step 1 together; then only approvals.
- **Asking whether they have approved yet.** The wait says so; and a "no" is revoked, never left to expire.
- **Creating a second own Slack app** for a workspace that has one. A new app is a new installation;
  the old one keeps its permissions.
- **An own-app port that does not match the manifest.** Slack matches the redirect URL exactly; use the port
  the manifest was made with.
- **Promising the tools before the restart.** Registered servers start in the next session.
- **A token in chat.** Never ask for one, never accept one. `agent-slack app update` reads the
  configuration token from a hidden prompt in the person's own terminal.
