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

## 7. Settled after the builder check (the lead's calls, 2026-10-25)

A builder read this cold and asked five questions. Each answer below overrides the section it names.

### S1. "Told about" in 0.29 is the event service's own record (overrides §4.4)
- **What a "told" line is:** a line the event service writes for each delivery: the rule, the account, the number of
  events, the target and the outcome.
- **It holds no sender, subject or payload,** because the events design forbids payloads in any log (D7, D8), and
  it is not joined to an agent session.
- **Where they show:** under the event service's own session, as "Delivered 3 events from *David on Slack* to
  <target>".
- **Later:** joining a delivery to the session it reached needs a way to reach sessions, which is the routing work
  (§5 item 3 of the desktop design). It is not part of this release.

### S2. A session is an agent window, not a server process (overrides §4.3)
- **Per process:** each server process records its own id, the client's `clientInfo`, its working folder, and its
  **parent process**: its id, its start time, and its executable's name. A Claude Code window is one parent for all
  the servers it starts.
- **A session is the group** of processes with the same parent (id and start time) and the same folder. The screen,
  the counts and `activity show <session>` all work on that group.
- **The session key** is a hash of the parent's id, its start time and the folder, stable for the window's life.
- **A CLI call** records its own parent chain up to three levels. If an agent's process (a parent that started MCP
  servers) is found in that chain, the call joins that session. Otherwise it is a session of its own, marked `cli`.
- **What can't be grouped stays alone, marked as such.** Examples: a client that starts servers through a wrapper, or
  a parent that has gone. Grouping is a convenience, never a claim. The screen says "this window" only when the parent
  matched.

### S3. An agent sees only its own session (overrides §4.7)
- **`comms_activity` over MCP** answers only for the session it is called from: its own lines and counts. It never
  shows another session, another project or another account.
- **The full view** (every session, every account) is the CLI's `agentcomms activity …` and the desktop app.
- **What this boundary is for:** an agent that can run a shell can read the owner's files anyway. The boundary is that
  no MCP tool hands one project's mail subjects to another project's agent.
- **Security tests pin both sides:** the MCP view is limited, and the CLI view is full.

### S4. WhatsApp is recorded without identities (adds to §4.2)
- **What a WhatsApp line holds:** the operation, the account, the counts (chats, messages), the outcome and the
  session.
- **What it never holds:** a chat id, a name, a number or a message preview.
- **Why:** a chat denied later then leaves nothing behind (`visibility.ts`'s rule that a denied chat is never listed
  or kept), and core never needs WhatsApp's lists.

### S5. Approvals → Recent reads the approval store (overrides §4.5's "from the same records")
- **Where it reads:** Recent lists finished approvals from the approval store, which keeps them 90 days, through the
  existing `approvals list` with a finished state. The desktop's allow-list gains exactly those states.
- **What follows:** it works the day the upgrade lands, shows expiries (which no call ever records), and doesn't
  depend on the activity switch.

## 8. Build plan (the lead's, 2026-10-25)

**Status:** built under the owner's standing directive "continue until all is implemented" (given with `/goal`,
2026-10-25: do not pause to ask). This is not an explicit approval of this design. The owner reviews it with the
release, and installing the desktop app stays their click.

### Task 1: core (first; every other task builds on it)
- **The log:** `packages/core/src/activity.ts`.
  - **`ActivityLog`:**
    - `append(line)` writes the daily private file with `appendPrivateLine`, and never throws into the caller: it
      reports once and records the problem for `doctor`.
    - `sessions({since})` and `show(sessionKey, filters)`.
    - `prune(retentionDays)`.
  - **`ActivityLine`:** the type in §4.2, with S1, S2 and S4.
  - **`sessionIdentity(kind: 'mcp' | 'cli' | 'daemon', clientInfo?)`:** works out the process id, the parent's id,
    start time and name, the folder and the session key (S2). Done once per process, bounded to about 200 ms, and on
    failure it gives "ungrouped".
- **Config:** `activity: { record: 'on' | 'off', retentionDays: 1..365 }`, default on and 30.
  - **Under the change policy:** off and a lower retention are tightenings, so they apply at once. On and a higher
    retention are loosenings.
- **Daily maintenance** prunes old days.
- **`doctor`** gains the `activity` check (§4.6).
- **One operation, `operations/activity.ts`, in three modes,** each with a `capabilities.json` row:
  - `sessions`;
  - `show`;
  - `mine`: the MCP view, limited to the calling session (S3).
- **The surfaces:** the CLI `agentcomms activity sessions|show` and the MCP tool `comms_activity` (mine only).
- **Exports for the channels:** `recordActivity(core, line)`, plus a wrapper `withActivity(operationId, kind, fn,
  describe)` that times the call, catches its outcome and records the line from `describe(result)`.

### Task 2a: Gmail and Resend record
Every capability row whose operation reads or writes account data records one line, through `withActivity`.
- **Reads:** ids, counts, subjects, the sender's name and address, and the query.
- **Writes:** what the audit records, plus the subject.
- **Downloads:** the file name and size.

Each MCP server passes `clientInfo` into `sessionIdentity`.

### Task 2b: Slack and WhatsApp record
- **Slack:** as 2a, with channel names, message ids, and the poster's name.
- **WhatsApp:** counts only (S4).

### Task 2c: the event service records "told" lines (S1)
One line per delivery outcome: rule, account, count, target, outcome. No payload, no sender, no subject.

### Task 3: the desktop app
- **The Activity screen,** as §4.5 says, read through new allow-listed calls to `activity sessions` and `activity
  show`.
- **Approvals → Recent** (S5), through `approvals list` with finished states.
- **Copy:** in the 0.28 soft look, with every sender-written string as untrusted plain text.

### Tests that must exist
- A failed append never fails the call, and `doctor` reports it.
- Retention prunes whole days.
- The MCP view never returns another session's line; a test calls it from two sessions.
- No line ever holds a message body: a test feeds a message with a body and asserts it isn't in the file.
- WhatsApp lines hold no chat id, name or number.
- Session grouping: two server processes with one parent are one session.
- Parity, in `pnpm verify:parity`.
