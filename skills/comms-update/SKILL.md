---
name: comms-update
description: "Bring agent-communications on this computer up to the latest release from chat: see what is behind, update the servers, their runtimes and any global commands in one approved step, then restart and clear out the old versions. Symptoms: 'update my comms', 'update agentcomms', 'upgrade Gmail and Slack', 'is there a new version', 'my Gmail tools are out of date', a tool answering 'Hang on a minute, there's an update. Let's update first.' (UPDATE_REQUIRED), 'not now', 'stop asking me to update'. Not for first-time setup — comms-onboarding does that — nor for one account's settings."
license: MIT
compatibility: "@agentcomms/core@0.15.2"
metadata:
  group: communications
  lifecycle: release
---

# Updating

One update, done from the conversation: every registered server moved to the latest release with its
name and pins exactly as they were, the runtimes it needs installed, and the global commands updated
if they are installed. The person approves it once, restarts once, and the old versions are removed
after.

## When a tool says "Hang on a minute, there's an update"

Once a day this computer asks npm whether a newer release is out. When one is, every server stops:
a tool answers `UPDATE_REQUIRED`, opening "Hang on a minute, there's an update. Let's update first.",
with the version running and the latest — and does nothing else. Stop what you were doing, tell the
person, and ask which they want:

- **Update now** — steps 1 to 3 below. The stop ends once the update is applied; a server whose
  registrations the update moved, and that was running before it, then says "the update is
  installed … Restart the client first" instead, until the client is restarted. A server the update
  does not move — the Claude Code plugin's Gmail server, the Gemini extension's servers, one a
  registration starts from a checkout — keeps saying "update": `comms_update` cannot reach it, so tell
  the person to update it where it was installed (the plugin or the extension), or to put the stop off.
- **Not now** — call `comms_update` with `later: true`. It is a change like any other: show the
  preview ("Skip the update to X until tomorrow") and wait for the person's yes (under `confirm`,
  the approve command the result gives, run at their own terminal, and `comms_approval_wait` to learn
  when they have), then call again with the `approvalId`. Nothing stops again until midnight, local time, on this computer; the first request
  after it asks again. Never put it off on your own: the stop exists so the person decides. Where the
  core server is not connected — only a plugin's server is — the stop itself gives the `update --later`
  command, and the `update` one, as this installation runs them: hand those over exactly as given, or,
  where it says they are not locatable here, that sentence (contract, §5).

A call carrying the `approvalId` of an approval the person already gave on this computer, still
waiting to be used, is never stopped — an empty or made-up id does not count, nor one already used,
revoked or expired — and neither are `comms_update`, `comms_doctor`,
`comms_paths` or a channel's doctor. The same stop meets every command at a terminal: a person there
is asked "Update now, later today, or cancel?"; anything else — you, a script — gets exit `11` with the
same two ways on. A command carrying `--approval` with an approval already given goes ahead, as the
same call does here.

To turn the check off for this computer, `comms_update` with `auto: "off"` — a change the person
approves; `auto: "on"` turns it back on at once. `comms_doctor` shows it on one line: on or off, when
it last checked, the latest release, and the one running.

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
ask. Under the `chat` change policy, call `comms_update` again with the `approvalId` after their yes,
within ten minutes. Under `confirm`, they first run the approve command the result gives, in their own
terminal, exactly as given, within thirty minutes; you cannot approve it yourself. Learn when they have
with `comms_approval_wait` (`agentcomms approval wait <id>`), in repeated default-length waits, and call
again once it answers `claimable: true`. When the person says no, revoke it at once:
`comms_approval_revoke` (`agentcomms approvals revoke <id>`).

The result lists each step with its `outcome`. A registration that did not start, or a runtime that
did not install, is reported as `failed` with its `detail`: say which, and do not call the update done.
`manual` lists the entries left for the person.

## 3. Restart, then clear out the old versions

The new servers start only after the client is restarted — the result's `next` names the clients.
Say so, and stop until they have. From 0.14.0 this matters more: the first 0.14 server or command that
prepares, approves or sends anything, or changes a send policy, moves the shared configuration to
version 3, and a server still running 0.13 then fails every call it starts with "this release reads
versions 1 and 2" until its client is restarted. Approvals a 0.13 server prepared and nobody used are
retired then ("prepared by an earlier release; prepare it again"): prepare them again. After the restart, call `comms_server_prune` for `core`, `gmail`
and `slack` (each shows what it will delete and asks); it keeps any version a running process still
uses, so a window that was not restarted keeps its old one until it is.

## Without the MCP tools

| Step | Command |
|---|---|
| What is behind | `agentcomms update --check` |
| Update | `agentcomms update` — at a terminal it shows the plan and asks `yes`; anywhere else it exits `10` with the preview and an approval id, then `agentcomms update --approval <id>` |
| Clear out old versions | `agentcomms mcp prune`, `agent-gmail mcp prune`, `agent-slack mcp prune` |
| Not now | `agentcomms update --later` — approved like any change; nothing stops until midnight |
| The daily check off, or on | `agentcomms update --auto off` (approved like any change), `--auto on` (at once) |

Where `agentcomms` is not installed, use `npx -y @agentcomms/core@latest` in its place. A command a result or
a stop hands over is another matter: give the person that one, exactly as given — it names the installation that
printed it, with its folders pinned — never one rebuilt from these names.

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
- **Putting the update off, or turning the check off, without asking.** Both are the person's to
  decide: show the preview and wait for their yes, as for any change.
- **Working around the stop.** Retrying the tool, or reaching for another one, does nothing but stop
  again. Ask the person: update, or not now.
