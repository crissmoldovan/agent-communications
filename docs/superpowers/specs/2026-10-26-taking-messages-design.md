# Taking messages: one session acts on a message, and the person sees who

Date: 2026-10-26. Status: draft, for the owner. It is the mechanism under the screens being drawn in parallel: a
message's story with several readers, a take and a "not mine" hand-back; a Messages list with states; and Settings →
Taking messages. Grounded in a read of `feat/0.34-soft` at 1c169674 (paths are from the repository root). **L** marks
this spec's own calls, each for the owner to confirm. **O** marks the owner's words.

## 1. Why

**O, 2026-10-26:** "David messages me, the session checks and acknowledges it, this message gets delivered to it, and
then it gets back to David… one specific message may be read either by an event or by several sessions… The
acknowledgement should be mandatory so no other sessions are getting it. We may have to track the situation where the
session got the message and it determined this is not for me, so it was just handed back… We need to make sure we have
a UI where we can track all those ones."

**Today nothing says which session a message belongs to.**
- **Behaviour rules** decide which acts an account allows, per account and conversation (`packages/core/src/behaviour.ts`
  1–31), and the send gate binds the exact content the person approved. Neither says which session acts. Two windows
  with the Slack server can both reply to David, each after its own approval.
- **The one "already handled" record** is the acknowledgement ledger's `perThread`, counted across an account's
  standing approvals (`packages/core/src/standing-ledger.ts` 9–17; standing-approvals S6). It covers Slack standing acts
  only.
- **A lane** gives one bound window its items (routing B1–B5), but any window can still find the same message by
  searching. A binding also outlives its window (routing §7).
- **The Messages story** knows about reads, drafts, sends, acknowledgements and queue states (`apps/desktop/src/messages/join.ts`
  34–43, 67–86). It doesn't know who has the message, or who said "not mine".

**How sessions are named today, which this builds on.**
- **The activity key** (`packages/core/src/activity.ts` 108–130, 1505–1523) is a hash of the parent process's id,
  its start time and the folder. It is `grouped` when the parent and folder were read, and otherwise it is a random key
  for that process alone (a folder like `/` or `~`, Windows, or a parent that has gone).
- **A CLI call** joins the window whose server process is among its ancestors (1576–1592).
- **The Claude Code session id** (`CLAUDE_CODE_SESSION_ID`) is read only by the event service's MCP server
  (`packages/events-daemon/src/mcp/server.ts` 96–109).
- **`clientInfo`** is stored as the client said it, and nothing depends on it (`activity.ts` 1522).
- **`AGENTCOMMS_MCP_SERVER`** marks a server's process and its children, so that person-only reads refuse there
  (`packages/core/src/mcp-marker.ts` 1–9).

## 2. Goals, non-goals, anti-goals

**Goals**
- **A session takes an inbound message before it acts on it,** when the person turns that on for an account. Once one
  session has taken it, no other session can act on it.
- **A session can hand a message back** ("not mine", with a reason), **mark it done**, and ask **who has it**.
- **A rule's delivery offers a message** to the session or lane window it names. That window still takes it itself.
- **The person can see each message's takes** in Messages, gets a reminder when nobody takes one, and can take a
  message back, give it to a window, or keep it themselves.
- **A take can show the sender a 👀 reaction** in Slack, but only under a standing approval the person made.

**Non-goals (this slice)**
- **WhatsApp.** Nothing there sends, and a chat id must not be kept (§T11).
- **Gating acts that answer no message:** a new email to David, or a top-level post in a channel (§T6).
- **Routing.** Rules and lanes still decide where a message goes. A take only says who acts on it.

**Anti-goals: it fails if…**
- **A take loosens anything.** Every act still needs the behaviour rules, the send policy and the person's approval.
- **A session can take, hand back or finish a message for another session,** or end another session's take.
- **An agent learns another session's folder, client or key,** or anything a sender wrote, from a take.
- **A take outlives its session forever.** An ended or silent session's take lapses by itself.

## 3. Decisions

**T1. The take store lives in core, as files (L).**
- **Where:** `<state>/takes/<accountId>/<sha256(message key)>.json`, one record per message. Each is written with
  `writeFileAtomic` under its own `withFileLock` (`<file>.lock`), owner-only, as approvals are (`approvals.ts` 891, 920,
  1143).
- **First take wins:** the record is read, checked and written under that lock.
- **Why core:** every act that must be gated runs in a channel server, which opens core but not the event service.
  Core also runs where no event service is installed.
- **Rejected: SQLite, as the event service uses.** Core and Gmail run on Node ≥ 22.12.0 (`packages/core/package.json`
  9), and `node:sqlite` is unflagged only since 22.13 (`packages/whatsapp/src/sqlite.ts` 5–8). Every core store is a
  file with a lock.
- **Rejected: a JSONL ledger per account,** like the acknowledgement ledger. "Who has it" is asked for every message a
  read returns, so it must be one file lookup, not a scan.

**T2. A take is held by a session, worked out by the server and never passed in (L).**
- **The holder** is `{ key, grouped, process, sessionId, parent, folder, client }`. It comes from core's
  `sessionIdentity`, plus `CLAUDE_CODE_SESSION_ID`. That env read moves from the event service's `windowSource` into a
  core `takerIdentity()`, so every channel reads it the same way.
- **A caller is the holder when:**
  - both sides have a Claude Code session id and the two are the same; or
  - either side lacks one, the keys are the same, and the key is `grouped` (or it is the same process).
  - Two different session ids never match, even when the keys are the same (routing §7: "fixed by its first report").
- **No tool or command takes a session argument,** as `activity mine` does (`capabilities.json` 53–60: "the session
  read from the process, never from an argument").
- **What a take can't hold for:** a CLI call that joined no window and has no session id. That is the person at a
  terminal, who is never held to taking (§T6).
- **`clientInfo` is for display only.** Nothing matches on it.

**T3. States, and what ends a take (L).**
- **The states:**
  - `open`: nobody has the message;
  - `offered`: reserved for one session;
  - `taken`;
  - `done`: the holder finished it, and others stay refused.
- **What sends a message back to `open`:** a hand-back, a person's release, or a take that lapses.
- **A take lapses** (the history says which):
  - `ended`: the holder's parent is gone, checked with `psProbe` (`activity.ts` 1238) on its pid and start time. This
    is checked when another session meets the take, and by the event service's sweep;
  - `expired`: 60 minutes have passed since the holder's last act on the message.
- **The lease renews** on a take again, a draft, prepare, send, react or ack on the message. It does not renew on
  reads.
- **A prepared act pins the take.** While an approval prepared under it waits, the take doesn't expire. The record
  lists the approval ids, and a pin is cleared when that approval is claimed, revoked or lapses.
- **Rejected: a take that lasts until the session hands it back.** A crashed or idle window would hold David's message
  for good. That is the binding's known limit (routing §7).

**T4. A delivery offers; it never takes (L).**
- **When it offers:**
  - a lane delivery (`queue-dispatcher.ts` 291) offers the message to the binding's window, by its `session_id` and
    `activity_key` (`store/migrations.ts` 906–916);
  - a session-target dispatch offers it to the chosen relay session's `nativeSessionId` (`session-dispatcher.ts`
    358–388), once the relay names one;
  - a person's **Give to…** offers it to the window they choose.
- **What an offer does:** it is exclusive. Any other session's take or act is refused while it lasts.
  - It lasts while the item waits for the session, then 15 minutes after the session was handed it (woken, or the
    prompt posted).
  - The offered session must still take the message, which is the explicit acknowledgement the owner asked for.
  - An offer that lapses becomes `open`.
- **The words the session receives** (the lane pointer, and the session prompt's fixed frame, 0.33 §3.6) gain one
  fixed line of ours: "It is offered to this session until 11:20: take it before acting, or hand it back."
- **Rejected: the delivery takes on the session's behalf.** The event service would act as another session, and the
  take would hold the message for a window that may never see it (busy, gone, or a lane wake that is never answered).
  Taking is the acknowledgement.

**T5. Taking is checked against the provider (L).**
- **What the take reads:** the message itself, through the channel. It must exist and be inbound:
  - Gmail: not one this mailbox sent;
  - Slack: not this account's user, and not in its app-posts record;
  - Resend: a received email.
- **What the take records:** the thread (Gmail's thread id, Slack's parent ts) and, for mail, the Message-ID header.
- **Why:** an id for a message that hasn't arrived can't be squatted. Slack's ts are guessable.
- **Ids are checked** with activity's `providerId` grammar (`activity.ts` 379–383), so no sender text can ride in one.
- **Rejected: one core tool, `comms_take`.** Core has no channel token to check the message with, and a window may
  connect only the Gmail server (channel design: an app given only what it needs).

**T6. With taking required, acts that answer a message need the take (L).** Details are in §6.
- **Housekeeping on a message another session holds is refused,** but housekeeping never needs a take (organise, trash).
- **The person is never held to taking:** a CLI call that joined no agent window.
- **Rejected: gating every act in the account.** A new email or a channel announcement answers nobody's message, and
  forcing a take of some unrelated message to post one would be noise.

**T7. Over MCP, other sessions are never named (L).**
- **An agent sees closed words only:**
  - who has it: `you`, `another session`, `the person`;
  - offers: `offered to you`, `offered to another session`;
  - `done`;
  - hand-back reasons, from a closed list.
- **Never shown over MCP:** another session's folder, client, key, Claude Code session id, or a hand-back's note.
- **Why:** a folder names a project, often a client's (`~/work/rgc/<client>`). This keeps activity S3 ("an agent sees
  only its own session") and routing B4 ("never names another window").
- **The person** sees everything, in the CLI and the app.

**T8. Hand-back reasons are closed words; a note is for the person only (L).**
- **The reasons:** `not-mine`, `wrong-account`, `needs-the-person`, `duplicate`, `other`.
- **The optional note** is at most 200 characters. An agent wrote it, and it may have copied sender text into it, so it
  is shown only to the person, enveloped (`UntrustedText`). It never reaches another session.
- **Rejected: free text passed to the next session.** That is a way for one project's agent, or a sender's words, to
  reach another project's agent.

**T9. 👀 on taking is an ordinary standing acknowledgement (L).** See §7.

**T10. The takes are their own record, not activity lines (L).** A take, hand-back or done writes no activity line.
The record's history is the story, as queue history stays out of activity (0.32 §3.6, "Why not activity"). An
acknowledgement made by a take writes its activity line as today.

**T11. WhatsApp is out (L).** Nothing there can send (`packages/whatsapp/src/operations/draft.ts` 10–20), so there is
no act to gate. A take would keep a chat id, which activity S4 and `visibility.ts` forbid.

## 4. Data model

```ts
// <state>/takes/<accountId>/<sha256(key)>.json   (600, in a 700 folder)
interface TakeRecord {
  v: 1;
  message: {
    channel: 'gmail' | 'slack' | 'resend';
    accountId: string;
    id: string;              // Gmail message id | Slack `<channelId>/<ts>` | Resend email id (event-source.ts 17–21)
    thread: string | null;   // Gmail thread id | Slack `<channelId>/<parent ts>` | null
    rfc822Id?: string;       // mail's Message-ID, so a reply's In-Reply-To finds its take
  };
  state: 'open' | 'offered' | 'taken' | 'done';
  holder: Holder | { person: true } | null;
  offer: { to: Holder; until: string | null; by: { rule: string; delivery: string } | { person: true } } | null;
  takenAt: string | null;
  lastActAt: string | null;  // the lease runs 60 min from here (T3)
  pins: string[];            // approvals prepared under the take, still waiting
  history: TakeLine[];       // newest 50 kept
  updatedAt: string;
}
interface Holder {
  key: string; grouped: boolean; process: string; sessionId: string | null;
  parent: { pid: number; startedAt: string; name: string } | null;
  folder: string | null; client: { name: string; version?: string } | null;
}
interface TakeLine {
  at: string;
  kind: 'offered' | 'taken' | 'handed-back' | 'done' | 'expired' | 'ended' | 'released' | 'given' | 'kept'
      | 'acknowledged';
  by: 'window' | 'person' | 'service';
  windowKey: string | null;
  reason?: 'not-mine' | 'wrong-account' | 'needs-the-person' | 'duplicate' | 'other';
  note?: string;             // ≤ 200 chars, agent-written, enveloped wherever shown
  ack?: { outcome: 'sent' | 'failed' | 'unknown' | 'not-made'; why?: string };
}
```

- **The message key** is `<channel>:<accountId>:<id>`. Its ids are the ones the event service's `dedupe_key` and
  `activity items` already use, so the app joins them without a mapping (`event-source.ts` 6–11; 0.32 §3.6).
- **Nothing a sender wrote is stored.** There is no subject, sender, text or name, and the record is rebuilt field by
  field on write, as `activityLineOf` does (`activity.ts` 308–314).
- **Retention:** a record is deleted 30 days after `updatedAt` (activity's default, `activity-settings.ts` 22), by
  core's daily maintenance. Removing an account removes its folder.
- **The settings** live in `config.json`, under `taking`, one entry per account, bound by account id, as behaviour
  rules are:

  ```ts
  { accountId, account, required: boolean, acknowledge: 'eyes' | 'nothing',
    unclaimed: { afterMinutes: 5..240, notify: boolean } }
  ```

  A value that can't be read counts as `required: true` (fail closed, as behaviour B3 does), and `doctor` says so.

## 5. Tools and CLI

**Each channel** (Gmail, Slack, Resend) gains two operations, `take` and `taken` (`packages/<ch>/src/operations/take.ts`):

| MCP | CLI | What |
|---|---|---|
| `gmail_take {inbox, message, step, reason?, note?}` | `agent-gmail take <message> [--hand-back --reason … [--note …] \| --done]` | `step`: `take` (or renew), `hand-back`, `done`. Write, local (`readOnlyHint: false, openWorldHint: false`; Slack's is `openWorldHint: true` when 👀 is on). |
| `gmail_taken {inbox, messages?: ≤50}` | `agent-gmail taken [<message>…]` | Who has these messages, in T7's words. With no ids: this session's own takes in the account. Read-only. |
| `slack_take {workspace, channel, ts, step, …}` / `slack_taken` | `agent-slack take <channel> <ts> …` / `agent-slack taken` | The same. |
| `resend_take {account, email, step, …}` / `resend_taken` | `agent-resend take <email> …` / `agent-resend taken` | The same, for received email. |

- **What `take` returns:** content-free. It holds `{ message, state, you: true, leaseUntil, offeredUntil?, acknowledged? }`,
  or a refusal (§6).
- **Hand-back and done** refuse with `TAKEN_ELSEWHERE` unless the caller is the holder.
- **Two tools, not one:** the read-only `taken` is kept apart so a client that asks before each write doesn't ask
  before a look.

**Core, for the person** (`agentcomms takes …`), each CLI only: an exception row that refuses inside an MCP server's
process, as `activity items` does (`packages/core/src/operations/activity.ts` 296–307).
- `takes list [--since] [--account] [--state] --json`: every record, with full holders and notes, notes enveloped.
- `takes release <account> <message>`: ends a take or an offer, at once.
- `takes give <account> <message> --window <id>`: an offer, taking the window's id as `lane bind --window` does.
- `takes keep <account> <message>`: held by the person, and every session is refused.

**Core, settings** (`agentcomms taking [<account>]`, MCP `comms_taking`, both):
- reading needs nobody;
- `--require on`, `--acknowledge nothing` and a shorter `--unclaimed` tighten, at once;
- `--require off` and `--acknowledge eyes` loosen. They follow the change policy, as `comms_behaviour` does, and in
  the app go through `--app-approval` from the attested app (0.34 §3, `appliedFromApp`), with Do it in Terminal
  elsewhere.

**`capabilities.json`:**
- per channel: `<ch>.take`, `<ch>.take.hand-back` and `<ch>.take.done`, one tool told apart by `args.step`; and
  `<ch>.taken`;
- `core.takes.list`, `core.takes.release`, `core.takes.give` and `core.takes.keep`, each an exception. The reason: a
  session must not end, give or read another's take, and the holder's own hand-back is the MCP path;
- `core.taking` and its change rows;
- `pnpm verify:parity` runs each row.

## 6. Enforcement (when `required` is on for the account)

**Where it is checked:** at prepare, beside the behaviour check, before any preview or approval. It is checked again
at the claim, where behaviour is asked again (`packages/slack/src/operations/behaviour.ts` 23–30), so a take released
in between stops the send. On a pass, the act's preview gains one line: "Taken by this session at 11:02."

| Act | Needs |
|---|---|
| Gmail `gmail_draft_reply` (`drafts.ts` 473) | the take of the message it answers |
| Gmail `gmail_send_prepare` / `gmail_draft_send` of a reply (`mail-acts.ts` 297–323) | the take of the message its In-Reply-To proves (`replyProofOf`), found by `rfc822Id` |
| Slack `slack_react` / `slack_react_send` (`send.ts` 2265, 2474), `slack_ack` | the take of that message |
| Slack `slack_post_prepare` in a thread (`send.ts` 722) | the take of the newest message from someone else in that thread: standing-approvals S4's target, read the way `ack` reads a thread (`ack.ts`, at most 10 pages) |
| Slack top-level post in a DM or group DM (`D…`, mpim `G…`) | the take of the newest message from someone else there |
| Resend `resend_send_prepare` with In-Reply-To (`resend/src/operations/send.ts` 760) | the take of the received email with that Message-ID |
| Gmail `gmail_organise`, `gmail_trash` | no take; refused only on a message another session holds |
| Not gated | new messages, Slack channel top-level posts, edits and deletes of own posts, local Slack drafts |

**The errors.** These are two new codes, both exit 10, not retryable (`packages/core/src/errors.ts` 10–21, 30–59).
- **`TAKE_REQUIRED`:** "cue/slack asks a session to take a message before acting on it, and this session has not taken
  C0123/1729936800.000100".
  - hint: "Take it with slack_take (step "take") if it is yours; otherwise leave it, or hand it back."
  - details: `{ reason: 'NOT_TAKEN', act, message }`.
- **`TAKEN_ELSEWHERE`:** "another session has taken this message" (`HELD`); "this message is offered to another session
  until 11:20" (`OFFERED`); "another session marked this message done" (`DONE`); "the person is handling this message"
  (`PERSON`).
  - hint: "Leave it. The person can give it to this session in Agent Comms → Messages."
  - details: `{ reason, until? }`. It never names the other session.
- **The same check without `required`:** `TAKEN_ELSEWHERE` still applies to anyone else's take. A take is respected
  wherever one exists, but none is demanded.

**Read results** gain `taken` on every message they return:
- where: `gmail_message_get`, `gmail_thread_get`, `gmail_search`, `slack_read`, `slack_thread`, `slack_search`,
  `resend` received list and show, and `events_lane_item`;
- the shape: `null`, or `{ by: 'you' | 'another session' | 'the person', state: 'taken' | 'done', since, offered?: {
  to: 'you' | 'another session', until }, handedBack?: Reason[] }`, with closed words only (T7);
- the cost: one file stat per message.

**A session that ends or goes silent:** T3's `ended` and `expired`, worked out lazily by any reader and written down
under the lock by the next writer or the sweep, at the time it happened (`leaseUntil`, not the sweep's time). The
message becomes `open`, and "nobody took it" counts again from then.

## 7. The visible acknowledgement (👀)

- **What happens:** with `acknowledge: eyes`, Slack's `take` calls the existing `ack` operation
  (`packages/slack/src/operations/ack.ts` 56–82) after the take is written. The act goes through `mintStandingUse`,
  `reactPrepared` and `claimOrHandOver`, so there is no new send path, and S4–S10 apply unchanged.
- **Which standing approval:** the take uses the account's standing approvals that hold the `eyes` reaction content,
  soonest to expire first. The first one whose checks before the mint pass is used. Those checks spend no count.
- **With no standing approval, nothing is posted.** The take still succeeds, and returns `acknowledged: { made: false,
  why }`: no standing approval covers it, the message is older than 15 minutes (`standing.ts` 110), it isn't the newest
  from someone else, a limit, or the policy is `never`.
- **The setting is not a permission.** "Say so with 👀" only chooses to use a standing approval the person made at
  their terminal (S8). That approval is what permits the reaction.
- **Timing:** the ack's pause of 5–30 s (`standing-pause.ts` 14) makes the take call that much longer. The take is
  recorded before the pause, so other sessions are refused at once. A failed ack never undoes the take.
- **Gmail and Resend have no 👀.** A standing approval covers Slack only (S1), so for mail the setting offers "say
  nothing" alone.

## 8. The event service

- **It opens core on the same state folder** (`packages/events-daemon/src/runtime/owner.ts` 1028–1034), so it writes
  offers (T4) into core's store. It writes them best-effort, after the delivery commits, as its "told" lines are
  (1339). An offer that can't be written never fails a delivery. The event service never writes `taken`.
- **A queue item and a take are separate.** The item is the person's list (open, done, dismissed); the take is which
  session acts. Neither changes the other.
  - The Queue card and the story show both.
  - A lane window that finishes still marks its item done with `events_queue_done`, as today.
- **The "nobody took it" sweep runs once a minute.** It covers accounts with `required` on, and events
  (`gmail.message.received`, `slack.message.posted`, `resend.email.received`) where a rule **matched and delivered to
  a lane, a session or the Queue** (L, open question 1).
  - It finds every such event older than `afterMinutes` with no `taken`, `done` or live offer. A hand-back starts the
    clock again, and a `needs-the-person` hand-back counts at once.
  - With `notify`, it raises one notice per sweep per account with core's notifier (`notify.ts` 184). The notice is
    content-free: "2 messages in cue/slack have waited 15 minutes and no session took them."
  - The sweep also writes the `ended` and `expired` lines (T3).
- **"Put it in the Queue" makes no queue item (L).** The Queue screen gains a **Not taken** tab, joined in the app
  from `messages list` and `takes list`, and the tab counts toward the Queue badge. A queue item's content is bound to
  an approved target version and its retention (action-queue §4.1, Q2), and a setting must not create content records
  outside D2. So the choice in Settings is only whether to notify. Either way the message shows under Not taken.

## 9. The app

**Messages** (`apps/desktop/src/messages/`):
- **`read.ts`:** reads `takes list --json` beside `messages list` and `activity items`, through new allow-list rows
  (`src-tauri/src/allowlist.rs`) with the message-id grammars it already has (122, 193).
- **`join.ts`:**
  - `TouchKind` gains `offered`, `taken`, `handed-back`, `take-done`, `expired`, `ended`, `released`, `given`, `kept`;
  - `Status` gains `taken` (with holder), `handed-back` (with reason) and `not-taken` (taking required, past the
    window);
  - `STATUS_ORDER` becomes: replied, acknowledged, done, dismissed, **taken, handed back**, read, waiting, **not
    taken**, not seen. A take's `done` counts as Done by an agent.
- **`story.ts`:**
  - `statusLabel`: "Taken by an agent", "Handed back", "Nobody took it";
  - `cardSteps`: "Rule david › Offered to the agent bound to lane david › Taken by the agent in ~/acme (👀) › Reply
    sent 11:45";
  - `timeline`: each take line, with its folder and client (the person's view), the reason, and the note through
    `UntrustedText`;
  - `windowsOf`: adds "took it" and "handed it back: not mine";
  - `storySummary`: "The agent in ~/acme has it since 11:02." or "Two sessions handed it back; nobody has it."
- **The story's header** shows who has the message, with **Take back**, **Give to…** (recent windows from `activity
  sessions`, as the Lanes panel lists them) and **I'll handle it**. Each runs the matching `takes` command, applied at
  once (DA10: it moves only the person's own coordination).
- **Filters** gain **Nobody took it** and **Handed back**.

**Settings → Taking messages**, mirrored in each account's **Agents here** (0.34 B2):
- "A session must take a message before it acts on it": on applies at once; off is approved in the app.
- "When a session takes one: say so with 👀 / say nothing" (Slack only, with a line naming the standing approval it
  would use, or "none yet: make one at your terminal").
- "A message nobody takes within [15 min]: remind me / put it in the Queue". This needs the event service, and says so
  when it is off.
- **A version gate:** `TAKING_VERSION`, with the Terminal fallback.

## 10. Security

- **No one takes for someone else.** No take argument names a session (T2). Hand-back and done need the caller to be
  the holder, and the event service only offers.
- **The person can override:** `takes release|give|keep`, from the CLI and the app. These refuse inside an MCP
  server's process, and each is a history line with `by: person`.
- **A speed bump, not a boundary.** An agent's own shell is not marked (`mcp-marker.ts` 4–7), so it can run `takes
  release` as the person, and identity is self-reported by processes running as the person (routing §3.3). The line
  records the CLI session and its ancestors, so the story shows "released from a terminal in ~/x".
- **Taking guards against two sessions acting, not against what is sent.** The send gate, the behaviour rules and the
  standing-approval limits stay the protections.
- **Untrusted content:** a take result carries ids and closed words. Notes are agent text that may carry sender text,
  so they are enveloped and shown to the person only (T8). Sender fields never enter the record (§4).
- **What an agent learns from another session's take:** that a message is held, offered or done, when, and the closed
  hand-back reasons. Nothing that names the other session (T7).

## 11. Tests

All of these run with the fakes (Gmail's fake transport, Slack's loopback fake, Resend's fake) and a temp home and state
folder. Nothing reads the real relay token or config.

- **Core store:**
  - 8 real processes race to take one message, and exactly one wins;
  - holder matching: session id against key, grouped, ungrouped in the same process, different session ids with the
    same key refused;
  - the lease, on an injected clock;
  - `ended`, through a fake `ProcessProbe`, including a reused pid with a different start;
  - pins hold a take while an approval waits;
  - the history is bounded;
  - a record copies no unknown field;
  - pruning at 30 days;
  - an unreadable `taking` counts as required.
- **Channels:**
  - the take refuses an own, sent or missing message;
  - each act in §6 is refused without a take, with the exact code and reason, at prepare and again at the claim (a
    release between prepare and send means nothing is sent);
  - `TAKEN_ELSEWHERE` and `taken` JSON contain none of the other holder's fields (asserted by value);
  - Slack DM posts are gated by the newest message, and channel posts and edits are not;
  - with `required` off, nothing is demanded, but another's take is still respected.
- **👀:**
  - with a covering standing approval, one reaction posts as the app and its count is spent;
  - with none, the take succeeds with `made: false`;
  - a message 16 minutes old gets no ack;
  - a failed ack keeps the take.
- **Parity:** every new row runs in `pnpm verify:parity --strict`, and the MCP schemas refuse a `session` or `key`
  argument.
- **Event service:**
  - offers go to a lane binding's ids and to a relay session's `nativeSessionId`;
  - an offer is exclusive, then lapses;
  - the service never writes `taken`;
  - the sweep notifies once per message, with content-free text, and stays silent with `notify` off or collection off.
- **Desktop:**
  - pure tests of `join`/`story`: the new touches, the status order, the filters, the note through `UntrustedText`;
  - Rust tests for the allow-list's argument grammars;
  - the version gate.
- **Person-only:** `takes list|release|give|keep` exit 10 inside the marker.

## 12. Risks and known limits

- **Not answering escapes the gate:** a fresh email to David, or a channel post about his message. The gate binds
  answers, not conversations.
- **Two messages in one Gmail thread** can be taken by two sessions. Each reply is checked against the message it
  answers.
- **👀 spends the thread's standing acknowledgement:** `perThread` defaults to 1 across the account (S6), so a standing
  reply after it is refused unless `perThread` is 2 or more. The Settings line says so.
- **On Windows nothing is grouped and no parent is probed** (`activity.ts` 1520). Takes there rest on the Claude Code
  session id where it is present, and lapse only by the lease.
- **More provider reads:** each take reads its message, and with `required` on, a DM post reads the newest message.
- **A crashed session the probe can't see** holds its take for up to 60 minutes. The person can release it.
- **The story shows only what Agent Comms saw,** as today (0.32 §7).

## 13. Questions for the owner (with this spec's default)

1. **"Nobody took it" covers** messages a rule delivered to a lane, a session or the Queue, or every inbound message
   on the account (Gmail newsletters included)? Default: rule-delivered only.
2. **A silent take lapses** after 60 minutes without an act on the message. Default: 60.
3. **A delivery offers the message for 15 minutes** after the session is handed it, and doesn't take it. Default:
   offer.
4. **Gate a Gmail reply draft** (not only its send), and **a top-level post in a Slack DM** (by its newest message).
   Default: both.
5. **WhatsApp left out.** Default: yes.
6. **👀 is Slack only;** mail says nothing until a standing approval for mail exists. Default: yes.
7. **Other sessions see the hand-back's closed reason,** never its note. Default: yes.
8. **Turning "must take" off is approved** like any loosening (in the app on macOS, at the terminal elsewhere).
   Default: yes.
9. **A `needs-the-person` hand-back reminds at once.** Default: yes.

## 14. Release

**A minor (0.35.0 proposed):**
- core: the store, `takerIdentity`, `takes`, `taking`, the two codes and maintenance;
- `@agentcomms/gmail`, `slack` and `resend`: `take`/`taken`, the gates and the read fields;
- `@agentcomms/events-daemon`: offers and the sweep;
- the desktop app;
- capabilities rows, the skills' "take before you act" step, docs, and a CHANGELOG entry with What, Why and Impact.

No migration is asked of anyone, and nothing changes until the person turns taking on.
