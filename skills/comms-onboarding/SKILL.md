---
name: comms-onboarding
description: "Set a person up with agent-communications from chat: which channels and accounts, which mode each account should have, the servers registered, every sign-in started, and the steps only they can take named. Symptoms: 'set up my email and Slack', 'install agent-communications', 'connect Gmail and Slack to Claude', 'onboard me', 'set this up on my other computer'. Not for one account's settings once it works — gmail-setup and slack-setup do those."
license: MIT
compatibility: "@agentcomms/core@0.6.0"
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

1. **Which channels:** Gmail, Slack, or both.
2. **Which accounts:** each mailbox address, each Slack workspace. Names are
   `organisation/platform` — `acme/gmail`, `acme/slack`.
3. **What each account may do.**
   - Gmail: `read` (Google itself refuses to send), `draft` (also writes drafts) or `organize` (also
     labels, archives, bins). `draft` and `organize` can both send once a person approves — only this
     software stops them.
   - Slack: `read` (cannot post: Slack itself refuses) or `send` (posts, with approval).
4. **How sends and changes are approved:** by a yes in chat (`chat`, the default) or at a terminal
   with a typed code (`confirm`). A send policy can also be `never`: nothing is sent or posted from
   here, and they do it in Gmail or Slack themselves.

`comms_channels_available` says what is already installed, at which version, and registered where;
start from that rather than from nothing.

## 2. Register the servers

`comms_server_install` for each channel chosen, with their client — skipping a channel whose server
`comms_channels_available` already shows registered with that client. It is a change: show the
preview, get their yes, call again with `approvalId`.

Then ask them to restart the client **now**, once, after every server is registered: the Gmail and
Slack tools below exist only in the next session. Claude Code resumes this conversation with
`claude --continue`. If you can run commands, you may instead carry on in this session with the
commands in "Without the MCP tools", and leave the restart to the end.

## 3. Connect each account

- **Gmail:** `gmail_setup` says what is missing. With no OAuth client registered, making one in
  Google Cloud is the person's step: `consoleSteps` has each screen, its link and what to type there.
  Then `gmail_client_add` with the downloaded client JSON's **path** (never its contents) — a change,
  so preview, yes, `approvalId`. `gmail_inbox_add` with the tier returns a Google link; give it to
  them, and `gmail_inbox_finish` once they are back.
- **Slack:** a workspace needs its own Slack app, and creating it is the person's step.
  `slack_manifest` with the mode and a `port` you choose (51234, say; it is required for a new app)
  returns the manifest. Tell them: open https://api.slack.com/apps, **Create New App** → **From a
  manifest**, pick the workspace, paste the JSON, create it, and copy the **Client ID** from **Basic
  Information** back to you. It is not a secret, and there is no client secret to copy. Then
  `slack_workspace_add` with the mode, the Client ID and the same port; for `send` it is a change and
  asks for approval before the sign-in starts. Give them the link; `slack_workspace_finish` when they
  are back.

A Slack workspace connected on another computer has an app already: reuse it, and do not create a
second one. On that computer, its Client ID is `oauthClientId` in `slack_workspace_show`, and its port
is `port` in `slack_manifest` with `workspace` (CLI: `agent-slack manifest --workspace <name> --json`).

## 4. Set the policies

`gmail_inbox_policy` and `slack_workspace_policy` set how sends are approved; `comms_change_policy`
sets how changes are. Tightening applies at once; loosening is a change like any other. A mailbox or
workspace set to `chat` itself stays `chat` when the default goes to `confirm`: show the person the
result's `warning`, and tighten each one it lists if that is what they meant.

## 5. Check, and hand over

- `comms_doctor`, `gmail_doctor`, `slack_doctor`: report anything not `ok` with its fix.
- No further restart, unless a server was registered after step 2 or you went on with the commands
  instead of restarting there. Then tell them to restart once, now, and what they will be able to ask
  for.
- List every step that was theirs and whether it is done.
- Tell them how to keep it current: "update my comms" in a chat later brings every server to the latest
  release (the `comms-update` skill).

## Without the MCP tools

Every step has a command, for a person at a terminal or an agent that can run commands. Each takes
`--json`. Where one is not installed, use `npx -y @agentcomms/core`, `npx -y @agentcomms/gmail` or
`npx -y @agentcomms/slack` in its place.

| Step | Command |
|---|---|
| What is there | `agentcomms channels` |
| Register a server | `agent-gmail mcp install --client <client>`, `agent-slack mcp install --client <client>` |
| Gmail, in one command | `agent-gmail setup` — the Google Cloud screens, the client, a mailbox and the registration. With `--json` it acts only on the flags it is given (`--client-json <path>`, `--inbox <name>`, `--email <address>`, `--mcp-client <client>`) and names the one it needs next |
| Gmail, step by step | `agent-gmail client add <path>`, then `agent-gmail inbox add <name> --tier <tier> --start`, then `agent-gmail inbox add --finish <flowId>` |
| Slack | `agent-slack manifest --mode <mode> --port <port>`, then `agent-slack workspace add <name> --client-id <id> --port <port> --mode <mode> --start`, then `agent-slack workspace add --finish <flowId>` |
| Policies | `agent-gmail inbox policy <name> --send <policy> --change <policy>`, `agent-slack workspace policy <name> --send <policy> --change <policy>`, `agentcomms policy confirm` |
| Check | `agentcomms doctor`, `agent-gmail doctor`, `agent-slack doctor` |

A change stops with exit `10`, its preview and an approval id, and changes nothing. Show the preview;
after their yes, run the command its hint gives, which carries the approval id. Under `confirm` they
run `agentcomms approve <id>` in their own terminal first. A person running a command at a terminal
approves there and then: `yes`, or the code under `confirm`.

## Pitfalls

- **Asking per step instead of once.** Ask the choices in step 1 together; then only approvals.
- **Creating a second Slack app** for a workspace that has one. A new app is a new installation;
  the old one keeps its permissions.
- **A port that does not match the manifest.** Slack matches the redirect URL exactly; use the port
  the manifest was made with.
- **Promising the tools before the restart.** Registered servers start in the next session.
- **A token in chat.** Never ask for one, never accept one. `agent-slack app update` reads the
  configuration token from a hidden prompt in the person's own terminal.
