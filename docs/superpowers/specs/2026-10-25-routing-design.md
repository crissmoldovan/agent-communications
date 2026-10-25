# Routing, first slice: lanes that wake the agent window bound to them

Status: draft, 2026-10-25. Written under the owner's standing directive "continue until all is implemented"
(`/goal`, 2026-10-25), not an explicit approval. Builds on `2026-10-25-routing-research.md` and its spike.

## 1. Intent

The owner, 2026-10-24: "when David is messaging me on Slack…", route it to "the right thread / the right agent session
/ a lane". This is the third agreed step, after the activity log (0.29.0) and the action queue (0.30.0).

**What the research found, and the spike proved on 2026-10-25** (Claude Code 2.1.310):
- **An MCP tool can answer with a task.** Claude Code polls `tasks/get` every 2 s, and when the task completes in an
  **idle** interactive window, it starts a turn on its own. This works in the default mode and under bypass
  permissions alike.
- **The catch:** our servers connect with `server.connect(new StdioServerTransport())`, which falls back to protocol
  2025-11-25 ("legacy"), and tasks need 2026-07-28. The SDK's `serveStdio(factory)` negotiates 2026-07-28, while the
  SDK has no task store: the extension's wire shapes are implemented by hand.
- **Cursor and Codex** document no outside push. A long-poll tool is their fallback.

## 2. Goals, non-goals, anti-goals

**Goals**
- **A lane:** a name the person gives a stream of matches, such as "david" or "billing". Any rule can send its matches to
  a lane, as it sends them to a queue.
- **An agent window binds to a lane,** with the person's approval. From then on, that window, and only that one, is woken
  for each new item in the lane, and may read the item.
- **Waking (Claude Code):** `events_watch({lane})` answers with an MCP task that completes on the lane's next open item.
  The task's result is a pointer we write, never sender text: "1 new item in lane david (Slack, rule david-on-slack):
  read it with events_lane_item."
- **Reading:** `events_lane_item({item})` returns the item, in the untrusted-content envelope, only to the bound window,
  and only the fields the rule's mapping keeps.
- **Without push (Cursor, Codex):** `events_wait({lane, seconds ≤ 50})` blocks until an item or the timeout, with
  progress heartbeats.
- **In the app:**
  - the Queue screen gains a lane filter and a Lanes panel: each lane, its open count, the window bound to it (folder,
    client, since), and **Unbind**;
  - unbinding is a tightening, so it applies at once.

**Non-goals (this slice)**
- **Starting a session for a lane** when no window is bound (lanes as background sessions, R3): next.
- **An agent acting on an item on its own.** The wake tells it an item arrived. What it does next is the person's
  instruction in that window, under its normal permissions.
- **Plugin monitors and channels** (R2, R4).

**Anti-goals: it fails if:**
- **A window that isn't bound reads a lane's content,** through any tool, filter or id guess.
- **The wake carries sender text.** It lands in a privileged spot, as a task result.
- **Binding happens without the person's approval,** or binds a window other than the one asking.
- **The legacy protocol stops working** for clients that don't speak 2026-07-28.

## 3. Decisions (the lead's calls)

### 3.1 A lane is a queue with a name
- **A lane is a queue target** whose document carries `lane: <name>` (`[a-z0-9-]{1,40}`). Lane items are queue items.
  They are stored, retained, purged and fenced exactly as 0.30.0's are, and show in the Queue screen with a lane
  filter. No new storage.
- **Done, Dismiss and Clear** work as in 0.30.0. An agent marking an item done is the same tool as today.

### 3.2 Binding is an approved change
- **`events_lane_bind({lane})`, called from the window,** prepares a binding and returns `approvalRequired` with a
  preview. The person approves it at the terminal, or in the app's typed challenge, as every change is. The preview
  names:
  - the lane, its rules and channels;
  - the window: its folder, its client as it says it is, and its session id.
- **The binding records:**
  - the window's identity: `CLAUDE_CODE_SESSION_ID` from the server's environment when present, and the activity
    session key (0.29.0's parent-process grouping);
  - who approved it, and when.
- **One window per lane, one lane per window, in this slice.** Binding a lane already bound needs the old binding ended
  first, in the app or at the terminal.
- **A binding ends:**
  - on Unbind (app or terminal, applied at once);
  - when the window's identity can no longer be found (its parent process has gone) on the next check;
  - on any revocation of the lane's queue target.

### 3.3 Who is "the bound window"
- A call is from the bound window when its server process's `CLAUDE_CODE_SESSION_ID` equals the binding's.
- When neither side has a session id, it is the bound window when its activity key equals the binding's, and only if
  that key is grouped (not a per-process random key).
- **Identity is self-reported by a process running as the person.** That is the boundary 0.29.0 (S3) and 0.30.0 (Q1)
  already state: it keeps one project's agent from another's mail, not from the person.

### 3.4 The wake
- **The event service's MCP server moves to `serveStdio`,** so it negotiates 2026-07-28 with clients that offer it.
  Legacy clients must still connect: a test drives it with a legacy client.
- **`events_watch({lane})`, from the bound window only,** answers `resultType: "task"`, with a server-held task:
  - **It completes** when the lane has an open item the window hasn't been woken for, or at once if one is waiting.
  - **Its result is the pointer of §2,** with the item's id, the lane, the channel and the rule's name. No sender, subject
    or text.
  - **`tasks/get` and `tasks/cancel`** are implemented by hand to the extension's shapes, as the spike did.
  - **A task never times out by itself.** It ends on completion, cancellation, unbinding, or the service stopping.
- **The model calls `events_watch` again** after each wake. The tool's description says so.

### 3.5 Reading
- **`events_lane_item({item})`, from the bound window only,** returns the item as `queue show` does, with every
  sender-written field enveloped.
- **For a window that isn't bound,** it refuses, and says the lane is bound elsewhere, without saying which item exists.
  It names no window.

### 3.6 Long-poll
- **`events_wait({lane, seconds})`** (1–50), from the bound window only. It blocks until an item arrives or the time is
  up, sending a progress notification every 10 s, and returns the same pointer, or `{ waiting: true }`.

### 3.7 Commands and parity
- **Both CLI and MCP:**
  - `lane list` (lanes, open counts, bindings: content-free);
  - `lane unbind <lane>` (a tightening);
  - `lane bind <lane>`, which prepares and needs approval.
- **MCP only, each with an exception row and reason:** `events_watch`, `events_lane_item` and `events_wait`. They only
  mean something to a bound agent window.

## 4. Left to the builder
- The binding table's schema and migration.
- How the task store survives a service restart: tasks may be lost, and the window's `tasks/get` then gets an error and
  the model calls `events_watch` again.
- The Lanes panel's layout, within the soft look.

## 5. Release
**0.31.0, a minor:** the event service and the desktop.
