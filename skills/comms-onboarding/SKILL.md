---
name: comms-onboarding
description: "Set a person up with agent-communications from chat: which channels and accounts, which mode each account should have, the servers registered, every sign-in started, and the steps only they can take named. Symptoms: 'set up my email and Slack', 'install agent-communications', 'connect Gmail and Slack to Claude', 'onboard me', 'set this up on my other computer'. Not for one account's settings once it works — gmail-setup and slack-setup do those."
license: MIT
compatibility: "@agentcomms/core@0.4.2"
metadata:
  group: communications
  lifecycle: release
---

# Onboarding

The whole setup, done from the conversation. Everything an agent can do, it does; everything that
needs the person — a consent screen, a Slack app's permissions, an approval, a restart — is handed to
them as one clear step, with the exact link or command.

## Before anything: the core server

The core server (`agentcomms`) installs and manages the others. If its tools (`comms_…`) are not
available, the person runs one command in a terminal, then restarts the client:

```sh
npx -y @agentcomms/core mcp install --client claude-code
```

Use their client in place of `claude-code` (`codex`, `cursor`, `claude-desktop`, `gemini`,
`vscode`). Every other step below happens in chat.

## 1. Ask what they want, once

Ask in one message, and wait:

1. **Which channels:** Gmail, Slack, or both.
2. **Which accounts:** each mailbox address, each Slack workspace. Names are
   `organisation/platform` — `acme/gmail`, `acme/slack`.
3. **What each account may do.**
   - Gmail: `read`, `draft`, or `organize` (read, draft, label, archive — and send with approval).
   - Slack: `read` (cannot post: Slack itself refuses) or `send` (posts, with approval).
4. **How sends and changes are approved:** by a yes in chat (`chat`, the default) or at a terminal
   with a typed code (`confirm`).

`comms_channels_available` says what is already installed, at which version, and registered where;
start from that rather than from nothing.

## 2. Register the servers

`comms_server_install` for each channel chosen, with their client. It is a change: show the preview,
get their yes, call again with `approvalId`. Then tell them the new tools appear after a restart —
do the restart once, at the end, not per server.

## 3. Connect each account

- **Gmail:** `gmail_setup` checks the OAuth client; `gmail_client_add` adds one from the client JSON
  file's **path** (never its contents). `gmail_inbox_add` with the tier returns a Google link; give it
  to them, and `gmail_inbox_finish` once they are back.
- **Slack:** a workspace needs its own Slack app. `slack_manifest` with the mode returns the manifest
  to create it from on api.slack.com and says what to copy back (the Client ID — not a secret). Then
  `slack_workspace_add` with the mode, the Client ID and the port from the manifest; for `send` it is a
  change and asks for approval before the sign-in starts. Give them the link;
  `slack_workspace_finish` when they are back.

A Slack workspace connected on another computer has an app already: reuse its Client ID and port
(`slack_workspace_show` on that computer, or the person's notes), and do not create a second app.

## 4. Set the policies

`gmail_inbox_policy` and `slack_workspace_policy` set how sends are approved; `comms_change_policy`
sets how changes are. Tightening applies at once; loosening is a change like any other.

## 5. Check, and hand over

- `comms_doctor`, `gmail_doctor`, `slack_doctor`: report anything not `ok` with its fix.
- Tell them to restart the client once, now, and what they will then be able to ask for.
- List every step that was theirs and whether it is done.

## Pitfalls

- **Asking per step instead of once.** Ask the choices in step 1 together; then only approvals.
- **Creating a second Slack app** for a workspace that has one. A new app is a new installation;
  the old one keeps its permissions.
- **A port that does not match the manifest.** Slack matches the redirect URL exactly; use the port
  the manifest was made with.
- **Promising the tools before the restart.** Registered servers start in the next session.
- **A token in chat.** Never ask for one, never accept one. `agent-slack app update` reads the
  configuration token from a hidden prompt in the person's own terminal.
