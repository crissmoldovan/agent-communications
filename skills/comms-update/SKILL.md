---
name: comms-update
description: "Bring agent-communications on this computer up to the latest release from chat: see what is behind, update the servers, their runtimes and any global commands in one approved step, then restart and clear out the old versions. Symptoms: 'update my comms', 'update agentcomms', 'upgrade Gmail and Slack', 'is there a new version', 'my Gmail tools are out of date'. Not for first-time setup — comms-onboarding does that — nor for one account's settings."
license: MIT
compatibility: "@agentcomms/core@0.6.0"
metadata:
  group: communications
  lifecycle: release
---

# Updating

One update, done from the conversation: every registered server moved to the latest release with its
name and pins exactly as they were, the runtimes it needs installed, and the global commands updated
if they are installed. The person approves it once, restarts once, and the old versions are removed
after.

## Before anything: a core that can update

`comms_update` arrived in 0.6.0. If the `comms_…` tools are missing, or `comms_update` is not among
them, the core server is older than that, or not registered. The person runs one command in a
terminal — it does the whole update, core included, and asks them to type `yes` — then restarts the
client:

```sh
npx -y @agentcomms/core@latest update
```

If you can run commands, run it yourself: it exits `10` with the preview and an approval id, and after
their yes the same command with `--approval <id>` applies it. From then on, every update is in chat.

## 1. See what is behind

Call `comms_update` with `check: true`. It asks npm for the latest release and lists, for this
computer:

- `behind` — each registration, runtime and global command older than the latest;
- `upToDate` — what is already current;
- `unpinned` — registrations that run a local checkout, which an update does not move;
- `unreadable` — a client configuration it could not read. Say so: an entry there is neither updated
  nor protected from pruning.

If nothing is behind, say so, and stop. A registration in `behind` with `updatable: false` carries a
`reason` and is left for the person — a project-scoped entry, one written by hand, one pinned to an
account that was renamed, or a client whose command is not on this computer. Tell them what its
reason says to run.

## 2. Update, once

Call `comms_update` without `check`. It returns `approvalRequired`, a `preview` and an `approvalId`:
show the whole preview — it names every registration, runtime and global command it will change — and
ask. Under the `chat` change policy, call `comms_update` again with the `approvalId` after their yes.
Under `confirm`, they run `agentcomms approve <approvalId>` in their own terminal first; you cannot
approve it yourself. If they say no, call `comms_approval_revoke`.

The result lists each step with its `outcome`. A registration that did not start, or a runtime that
did not install, is reported as `failed` with its `detail`: say which, and do not call the update done.
`manual` lists the entries left for the person.

## 3. Restart, then clear out the old versions

The new servers start only after the client is restarted — the result's `next` names the clients.
Say so, and stop until they have. After the restart, call `comms_server_prune` for `core`, `gmail`
and `slack` (each shows what it will delete and asks); it keeps any version a running process still
uses, so a window that was not restarted keeps its old one until it is.

## Without the MCP tools

| Step | Command |
|---|---|
| What is behind | `agentcomms update --check` |
| Update | `agentcomms update` — at a terminal it shows the plan and asks `yes`; anywhere else it exits `10` with the preview and an approval id, then `agentcomms update --approval <id>` |
| Clear out old versions | `agentcomms mcp prune`, `agent-gmail mcp prune`, `agent-slack mcp prune` |

Where `agentcomms` is not installed, use `npx -y @agentcomms/core@latest` in its place.

## Pitfalls

- **Updating one server at a time.** `comms_update` moves them together, to one release; mixing
  releases across the servers is how a client ends up with two versions of the same tool.
- **Widening an entry to update it.** An entry pinned to one mailbox or workspace, or `--read-only`,
  keeps its pins; one that cannot keep them exactly is left for the person. Do not remove it and
  install a wider one to get around that.
- **Promising the new tools before the restart.** They are there only in the next session.
- **Pruning before the restart.** Prune keeps what is running, so it removes less than it should; run
  it after.
- **Renaming or changing policies here.** An update changes versions only. Renaming old account names
  is `comms_names_migrate`; approvals are `comms_change_policy`.
