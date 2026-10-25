# Activity: what agent sessions read, were told, did and sent

Status: draft for the owner's approval, 2026-10-25. Nothing is built until the owner approves this document.

## 1. Intent

The owner runs many agent sessions, in many project folders, against their mail, Slack, Resend and WhatsApp. Today
they can't answer the question they care about afterwards: **which session read what, was told about what, did what
and sent what — and did it work?**

The owner's words (2026-10-24), describing the wider vision:
- they want rules per account, such as "when David is messaging me on Slack…";
- a queue of actions;
- routing to the right thread and session;
- and, first, "an audit of what sessions read and sent".

They agreed the order: the audit first, then the action queue, then routing (desktop design 2026-10-24 §5).

**What exists today.**
- core's audit log (`<state>/audit/YYYY-MM.jsonl`) records every **write**: sends, mailbox changes, approvals and
  configuration changes. Each record has the operation, the account, the ids, the outcome, the recipients of a send
  (domains otherwise), and the surface (`cli`, `mcp`, `app`, `daemon`).
- It records **no reads**, and nothing about **which session** asked. Every MCP call from every Claude Code window
  looks the same.
- The event service records its own deliveries, which say what reached each target, but nothing joins them to a
  session.
- The desktop app has no history view. Its Approvals screen shows only what is waiting, because there is no "recent"
  data.

## 2. Goals, non-goals, anti-goals

**Goals**
- Every agent call that **reads** account data is recorded with what it touched. That covers searching, reading a
  message or thread, listing, downloading an attachment and exporting.
- Every **write** is still recorded as today, and is now tied to the same session.
- **Which session:** each call is tied to a session, made of:
  - the **project folder** it was started in;
  - the **client** (Claude Code, Cursor, …);
  - a **session id** per server process;
  - for the CLI, the terminal or the agent that ran it.
- **What the session was told about:** event deliveries to targets the person set up, joined to the session that read
  them, where a session read them.
- **When, and the outcome:** ok, refused or failed, and why.
- **A desktop screen, Activity,** that answers "what did that session do?" at a glance. It lists sessions by project
  folder, with a timeline under each, filters by channel, account and kind, and each line plain and short.
- **Approvals gains its "Recent" tab** (D7 promised it), fed by the same records: what was approved, refused, expired
  or revoked, and by whom.
- **CLI and MCP parity:** `agentcomms activity …` and `comms_activity`, one operation in core.

**Non-goals (this release)**
- The action queue and routing (§5 items 2 and 3).
- Recording what a **person** reads in a mail client. Only calls through agent-communications are seen.
- Recording anything a client does without agent-communications, such as its own web fetches or files.
- Undo or replay from the activity screen.

**Anti-goals: it fails, even if it works, if:**
- **Content is stored.** The activity log must never hold a message body, an attachment's bytes or a secret.
- **It slows the agent down.** Recording must not add more than a few milliseconds to a call, and a failed write to
  the log must never fail the call itself (but see §4.6).
- **It is taken for the audit.** The audit log stays small, content-free and shareable when asking for help. The
  activity log is private, and says so.
- **Sender-controlled text is shown as anything but plain text.** Subjects and sender names are written by whoever
  sent the mail, so they go through the untrusted-content envelope everywhere.

## 3. Constraints

- Everything stays on this machine, under `<state>/`, in owner-only files (mode 600, folder 700), as the audit log
  is.
- **Node 22.12+;** no new runtime dependency for recording.
- **AGENTS.md's rules hold:**
  - only `send.execute` may call Gmail's send endpoints;
  - anything a sender controls passes through the sanitiser and the envelope;
  - CLI and MCP stay in parity, with a row in `capabilities.json`.
- The desktop app reads the log only through the allow-listed CLI, as it reads everything else (DA4). It never opens
  the file itself.
- Windows, macOS and Linux all record, and the screen works on all three.

## 4. Decisions (the lead's calls, for the owner to check)

### 4.1 A second log, `activity`, beside the audit log
- **Where:** `<state>/activity/YYYY-MM-DD.jsonl`, one JSON line per call. Daily files, so retention can drop whole
  days.
- **The audit log is unchanged.** Writes keep going there exactly as now; the activity log gets its own line for each
  write as well, with the session, so one place answers "what did this session do".
- **Retention:** 30 days by default, set by `activity.retentionDays` in config (1–365). Daily maintenance deletes
  older files. Lowering it applies at once. Raising it is a loosening, so it goes through the change policy, like any
  other loosening.
- **Off switch:** `activity.record` is `on` by default. `off` stops recording, and is a tightening, so it applies at
  once. Turning it back on is a loosening.

### 4.2 What a line holds
- **Common to every line:** `at`, `channel`, `account` (its id and alias at the time), `operation` (the capability
  id, e.g. `gmail.search`), `kind` (`read`, `write`, `told`, `approval`), `outcome` (`ok`, `refused`, `failed`),
  `reason` on refusal or failure, `session` (§4.3), and `ms` (the duration).
- **What it touched, never content:**
  - **reads:** the ids returned and their count, plus for each message or thread its **subject and its sender's
    name and address**, so the screen can say "read 'Invoice March' from David". The query text of a search goes in
    too: an agent wrote it, not a sender.
  - **writes:** what the audit records, plus the subject.
  - **downloads:** the file name and size.
- **Bounded:** a line lists at most 50 items; past that, a count. Subjects are cut at 200 characters.
- Subjects and names are stored as received. They are marked untrusted wherever they are shown.

### 4.3 Which session
- **An MCP server process is one session,** named by:
  - a random id made when the server starts;
  - the client's self-reported name and version (`clientInfo`, already read by Gmail's server);
  - the server's working folder, which is the project folder Claude Code and most clients start it in.
- If the client gives a session id of its own (an environment variable or a header the MCP SDK exposes), it is stored
  too, but nothing depends on it.
- **A CLI call is a session of its own,** with its working folder and `cli`, and `parent` set to the parent process's
  name when it is an agent's shell (for example `claude`), so a person typing in Terminal can be told from an agent.
- **The event service's own work** (`daemon`) is its own session.
- **`clientInfo` is self-reported.** The screen shows it as what the client said, never as proof.
- **Folders are shown with the home folder as `~`.** A session whose folder can't be read says so.

### 4.4 What a session was told about
- **Two parts:**
  - the event service records each delivery as today;
  - when a session **reads** deliveries or events through the events MCP server, its activity line lists the
    delivery ids.
- The screen joins the two: "Told about 3 new Slack messages from David (rule *David on Slack*)".
- Deliveries no session read show under the daemon session, as "delivered to <target>".

### 4.5 The screen: Activity
- **A new sidebar section, Activity, between Approvals and Agent.**
- **Sessions:** a list, newest first. Each shows its project folder, its client, when it started and was last seen,
  and counts by kind (read 34, sent 2, told 3, refused 1).
- **Opening a session** shows its timeline: one line per call, grouped by minute. For example, "Searched Gmail
  (personal) for 'invoice' — 12 results", "Read 'Invoice March' from David", "Sent to jo@example.com — waiting for
  your approval", "Refused: the policy says confirm".
- **Filters:** channel, account, kind, outcome, and a time range (today, 7 days, 30 days).
- **Approvals → Recent** lists what was approved, refused, expired or revoked in the last 30 days, from the same
  records.
- **Read-only.** The screen changes nothing. The one action it offers is "Open in Approvals" for a pending one.
- **The same soft look** as 0.28, with every sender-written string as plain text, marked *From outside*.

### 4.6 Failure and safety
- A write to the activity log that fails is reported once per process to stderr and in `doctor` ("activity is not
  being recorded: <why>"). The call itself still succeeds.
  - **The exception:** a **send** whose activity line can't be written still sends. The audit log, which is durable
    and already required for a send, is the record of it.
- The log is written with the same private append the audit uses (`appendPrivateLine`), so a line is whole or absent.
- `doctor` gains an `activity` check: the folder is private, today's file is writable, and retention is in force.

### 4.7 Commands
- **CLI:** `agentcomms activity sessions [--since] [--json]` and
  `agentcomms activity show <session> [--kind] [--channel] [--account] [--since] [--json]`. Plus
  `agentcomms activity recent-approvals [--since]` for Approvals → Recent.
- **MCP:** `comms_activity` with `sessions`, `session` and `approvals` modes.
- **Parity:** one operation in `packages/core/src/operations/activity.ts`, with rows in `capabilities.json`.
- **Retention and the off switch** are config settings, changed through `comms_change_policy`-style tools and the CLI,
  under the change policy.

## 5. Left to the builder
- How the channels hand their records to core's `ActivityLog`: a shared wrapper around each operation, or a call at
  each site. It must cover every row in `capabilities.json` whose operation reads or writes account data.
- The exact grouping and wording on the timeline, within §4.5 and D3's rules (a few words, explanations in hints).
- The indexes the CLI keeps to answer `sessions` fast over 30 days of files.
- The session id's format.

## 6. Release
- **0.29.0, a minor,** for every package: the recording is in core and the four channels, and the screen is in the
  desktop app.
- The changelog says plainly what is recorded, where, for how long, and how to turn it off.
