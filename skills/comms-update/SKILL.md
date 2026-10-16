---
name: comms-update
description: "Bring agent-communications on this computer up to the latest release from chat: see what is behind, update the servers, their runtimes and any global commands in one approved step, then restart and clear out the old versions. Symptoms: 'update my comms', 'update agentcomms', 'upgrade Gmail and Slack', 'is there a new version', 'my Gmail tools are out of date', a result carrying `update` ('agent-communications 0.20.0 is out; say \"update\" when it suits you'), 'not now', 'stop asking me to update'. Not for first-time setup — comms-onboarding does that — nor for one account's settings."
license: MIT
compatibility: "@agentcomms/core@0.19.0"
metadata:
  group: communications
  lifecycle: release
---

# Updating

One update, done from the conversation: every registered server moved to the latest release with its
name and pins exactly as they were, the runtimes it needs installed, and the global commands updated
if they are installed. The person approves it once, restarts once, and the old versions are removed
after.

## When a result says a newer release is out

Once a day this computer asks npm whether a newer release is out. Nothing is ever stopped for it: every tool keeps
working. A server's first result of its session carries one line beside the result, as an `update` field and a text
block of its own, and no later result of that session repeats it:

- `agent-communications 0.20.0 is out; say "update" when it suits you.` — pass it on to the person in one sentence,
  then finish what you were doing. Update only when they say so: steps 1 to 3 below.
- `agent-communications 0.20.0 is installed; restart the client (in Claude Code, /mcp → Reconnect) to use it.` — the
  update is done; this session started before it. Say so; nothing else is needed.
- `… this server came with the Claude Code plugin (or the Gemini extension), and is updated there …` — `comms_update`
  cannot reach that server. Tell the person to update it where it was installed.

A command at a terminal says the same once on stderr, at most once a day for the computer, and runs. A client that
still answers `UPDATE_REQUIRED`, or a command that exits `11`, is a server or command older than 0.20.0: it is behind,
and the update moves it too.

**Not now** is a plain answer, with no approval: `comms_update` with `pause` — `1`, `7` or `14` days, `true` for 7 when
they name no length — holds every notice on this computer until then. A new pause replaces the old one; `resume: true`
ends it at once. A pause never holds a security fix: its notice is said at once, with when the pause ends.

**How often it checks** is the person's to choose, with `comms_update` and `level`:

- `auto`, the default: a check every day. It will install in the background once that is set up; until then it is a
  daily check with a notice.
- `every-14-days`: a check, and a notice, at most once every 14 days; an update only with their yes.
- `never`: nothing asks npm; they update by hand.

A level that updates less is a change the person approves: show the preview, which says what stops happening, and
wait for their yes (under `confirm`, the approve command the result gives, at their own terminal, and
`comms_approval_wait` to learn when they have), then call again with the `approvalId`. Moving back to one that updates
more applies at once. Never choose a level or a pause for them. `comms_doctor` shows it on one line: the level, when it
last checked, the latest release, the one running, and a pause with when it ends.

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

## 4. Then walk through what the new release asks of the person

Some releases change what other people see, or need one decision from the person. After the restart, read the
changelog's **Upgrading** section for every version passed over, and go through it with the person **one step at a
time**, as the contract's setup section says: what it changes for them in plain words, then the step as numbered
instructions, then wait for their answer.

From 0.19.0, everything an agent sends is labelled as their agent's, "Their Name (agent)". Take these as separate
messages, in this order, skipping any that does not apply:

1. **Tell them what changed.** People who get a message an agent sent can now see it came from their agent. They
   can still have a message sent as themselves, by saying so for that message, or with a rule. `comms_label` with no
   change shows how each account's messages will look.
2. **Their name,** only if a channel has none for them. That happens when Gmail holds no display name for the
   address, or a Resend send gives a bare address. Offer `comms_label` with `name`: it shows a preview to approve,
   and a labelled send without a name is refused until then.
3. **The word,** only if they ask. It is `agent` unless they choose `assistant`, `twin`, `minion`, `bot`, `fake` or
   `AI`, and a new word is approved like the name.
4. **Slack, posting as the app,** only if they want the APP badge. Until then, an agent's Slack messages go out as
   them, with the label at the start. Explain that the bot token stays on this machine, and that both ways need a new
   Slack app; then give one way's numbered steps, not both at once. The slack-setup skill has them.

## Without the MCP tools

| Step | Command |
|---|---|
| What is behind | `agentcomms update --check` |
| Update | `agentcomms update` — at a terminal it shows the plan and asks `yes`; anywhere else it exits `10` with the preview and an approval id, then `agentcomms update --approval <id>` |
| Clear out old versions | `agentcomms mcp prune`, `agent-gmail mcp prune`, `agent-slack mcp prune` |
| Not now | `agentcomms update --pause [1\|7\|14]` — no approval; `agentcomms update --resume` ends it |
| How often it checks | `agentcomms update --level auto\|every-14-days\|never` — less often is approved like any change; more often is at once |

Where `agentcomms` is not installed, use `npx -y @agentcomms/core@latest` in its place. A command a result or
a notice hands over is another matter: give the person that one, exactly as given — it names the installation that
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
- **Pausing, or choosing a level, without asking.** Both are the person's to decide: a pause is their answer, and a
  level that updates less waits for their yes to its preview.
- **Stopping the conversation for the notice.** It is one line to pass on, not a question to wait for: finish what the
  person asked, and update when they say so.
