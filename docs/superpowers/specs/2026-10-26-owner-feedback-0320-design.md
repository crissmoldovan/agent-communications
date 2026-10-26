# 0.32.0: the owner's feedback on the app, item by item

Status: draft, 2026-10-26. Written under the owner's `/goal` of 2026-10-26 ("create a very thorough spec and plan for
implementing all of these ones by analysing each of them one by one … then completely implement everything"), and their
later word: "prototype the UI via Canvas so I can see exactly how this would look, so I can feed back before we build
it". The prototype is https://claude.ai/artifact/3dRSZuWTRDfw9JjGmurYNM, kept in this repository at
`docs/prototypes/2026-10-26-0320/` (open it with its README). The owner approved it on 2026-10-26 ("perfect"). Facts below were read from
feat/0.31 at 1c279b4d on 2026-10-26; the fact sheet with every file and line is `docs/superpowers/plans/2026-10-26-0320-facts.md`.

Each item has the same parts: what the owner said, what is there today, what changes, the decisions (**O** = the
owner's, **L** = the lead's call), the contract builders share, and what is left out.

## 1. Intent

The owner installed 0.30.0, opened the app, and found it hard to use and hard to understand:
- judges that can only be turned on at the Terminal;
- no place for an AI provider's key;
- no way to see which apps have the servers;
- rules and deliveries shown as raw database rows ("mail subject version 1 state active and approval and activation";
  "next try … 1970");
- no answer to the question they care about most: what happened to a message that came in.

This release answers each of those, and changes how releases are made, so that the owner tries a change before it
goes public.

## 2. How this release is made

- **Prototype first (O, 2026-10-26).** Every new screen is drawn in the prototype canvas first. Screens are built only
  after the owner's feedback on it. Work that has no screen (the event service, core, the channels) starts at once.
- **A local test build before any public release (O, 2026-10-26).** `scripts/local-test-release.sh` builds the branch
  into the test profile and "Agent Comms Test". The owner tries it, and a public release (dry run, npm, the signed app)
  happens only when they say "release".
- **Lean checking (O, 2026-10-26).** Builders run only touched tests, the root suite and `verify:events-phase-e2`. One
  cloud dry run gates the tag. Only the changes with a security edge get a review: §3.5's dry-run gate and §3.6's
  cross-session reads.

## 3. The items

### 3.1 Judges set up in the app

**The owner:** "when I'm in events and judges, for example, 'judge by TypeSafe', I have to turn it on in the terminal.
I don't like that … If it's missing the API key, it should be settled in settings. Same: Laya is unavailable, so I don't
know exactly what I should do. Another thing is a local model server: turn it on in the terminal."

**Today:** the Judges tab shows each judge kind with "Turn on in Terminal" and "Turn off" (`apps/desktop/src/screens/Events.tsx`).
Turning on means `judge kind enable` plus `judge add` at a terminal. Laya is dormant (`E2_EXTERNAL_REFERENCE_BLOCKED`)
and shows "unavailable" with no explanation.

**What changes** (prototype row 1, screens 1–3):
- **Jev:** "Set up…" opens a dialog to choose the provider (§3.2), choose the model (Jev 1.14, always the latest, or
  Jev 1.13), try it with a made-up sample, and turn it on. Once on, the card shows its provider, its model and today's
  answers, with Try it, Change… and Turn off.
- **A local model server:** "Set up…" opens a dialog:
  - pick Ollama, LM Studio or something else, which presets the address;
  - check the address and find the models;
  - pick one and turn it on.
- **Laya** reads "Not available yet: Laya comes in a later release", with no button.

**Decisions**
- **O:** judges are set up in the app (2026-10-26, "Yes, in the app").
- **L:** the event service gains `judge setup <typesafe|local-endpoint>`, the person's act, approved by their press in
  the app after the preview of what the judge sees and its budget — or by running it at an interactive terminal. A key
  is the app's stdin, or the person's hidden input at a terminal, never a pipe otherwise. It is refused to agent
  markers, inside an MCP server, and on macOS to any process the app did not start: core's `desktopAppOrigin`
  checks that the app started this process: a speed bump against agents, not a boundary against code running as you (see the notes at the end of §4). Turning a judge off is a tightening and
  applies at once.
- **L:** the local model server's address must be on this Mac (loopback), as the local-endpoint judge already requires.

**Status:** being built on `feat/0.32-judges`, event service first. Its screens wait for the owner's feedback.

### 3.2 AI provider keys

**The owner:** "I need to make sure that I can provide an OpenRouter key … I should have some kind of an accounts part
where I should have TypeSafe, OpenRouter and so on. Whenever I want to use Jev by TypeSafe, I should be able … to choose
if I'm using the OpenRouter or native one, based on what keys are available. Those that are not available should be
greyed out as options."

**Today:** the only key is TypeSafe's, set at the terminal. Jev is reached at `https://api.typesafe.ai/v1/systemone`
(model `jev-1.13.0`). OpenRouter serves the same System One API at `https://openrouter.ai/api/v1/systemone`, with the
models `typesafe/jev-1.14`, `~typesafe/jev-latest` and `typesafe/jev-1.13`. Source:
https://openrouter.ai/docs/guides/community/jev, read 2026-10-26.

**What changes** (prototype row 1, screens 2 and 4):
- **Settings gains "AI providers"**, beside "This app" and "Folders". It lists TypeSafe and OpenRouter, each with
  Add key…, Replace… and Remove. A key is never shown again once saved.
- **Jev's setup dialog** offers OpenRouter and TypeSafe. A provider without a key is greyed out, with a link to add
  one.

**Decisions**
- **O:** a providers section in Settings; choices without a key greyed out.
- **L:** `provider key set|remove|list` for `typesafe` and `openrouter`. `set` reads the key from stdin; `list` returns
  only presence and dates. Keys live with the other secrets on this Mac.
- **L:** Jev's judge document gains `provider: "typesafe" | "openrouter"`, and the event service's network allow-list
  gains `openrouter.ai`.
- **L:** removing a key that a judge uses names that judge first, and then turns it off.

**Status:** being built with §3.1.

### 3.3 Connections: which apps have which servers

**The owner:** "Currently, since I updated, are cloud sessions or things able to read things through MCP? Also, I do
not see any MCP section on the left sidebar. Why?"

**Today**
- The sidebar has nine sections (`apps/desktop/src/copy.ts:23-35`), and none of them is about MCP.
- Registrations show up only as free-text rows in the Doctor (`packages/core/src/operations/maintenance.ts:887`).
- The data already exists: `agentcomms channels --json` (`channelsAvailable`, `packages/core/src/operations/servers.ts:1051-1131`)
  is read-only and never returns an `env`. For each server, it lists each registration with the client, name, scope,
  config path, launcher, version, `behindCore` and `missing`, plus the client configs it could not read.
- Activity (0.29) gives each agent window's self-reported client and last-seen time.

**What changes** (prototype row 5, screen 1):
- **A "Connections" section** in the sidebar, after Accounts.
- **A table of apps by servers:**
  - **Apps:** Claude Code, Claude Desktop, Cursor and Codex; Gemini and VS Code when they have any registration.
  - **Servers:** Core, Gmail, Slack, Resend, WhatsApp and Events.
  - **A cell** shows ✓, or a note: behind core, its file missing, or a project scope with its folder.
- **Change… (or Add…)** per app opens a list of checkboxes, one per server:
  - removing applies at once;
  - adding shows what it lets agents do, then asks for the person's approval in the app.
- **"Who can reach them":**
  - **Yes:** agent windows on this Mac, including a local Claude Code window driven from a phone with Remote Control.
  - **No:** cloud sessions.
- **"Used recently":** agent windows from activity, with folder, client, channels and when.
- **A reminder** that an app sees a change only after it restarts.

**Decisions**
- **L:** one new read-only allow-list row, `channels`, runs `channels --json` in core.
- **L:** "last used" per app is approximate. It maps activity's self-reported `client.name` to an app through a table
  (for example `claude-code` → Claude Code), and the screen says it is what the window reported. An app none of whose
  windows touched an account shows no "last used".
- **L:** Add runs `mcp install --client <c> --server <s>`, which comes back waiting for approval with core's preview of
  what the server lets agents do; the app shows it, and the person's press of Approve and add, after that preview, is
  the approval (the owner-approved prototype; §5 question 3): the app runs `mcp install … --app-approval <id>`, which
  approves that change through the app channel and applies it, never as a silent change. On macOS core first
  checks that the app started this process: a speed bump against agents, not a boundary against code running as you (the notes at the end of §4). Remove is a tightening and applies at once. If core
  has no per-app removal (prune is not the same), core gains `mcp uninstall --client <c> --server <s>`, a tightening
  with an MCP twin for parity.
- **L:** cloud sessions are explained, not detected. Nothing on this Mac can see them.

**Left out:** knowing whether an app has restarted since a change (nothing records it).

### 3.4 Rules in plain words

**The owner:** "when I'm going into events and rules, I just have one thing that says 'mail subject version 1 state
active and approval and activation.' I don't know what the hell that is … Is that something that I click and I should
see a detail?"

**Today**
- **The tab** is a table of raw columns, one row per *version*, with no click: rule id, version, state, approval id,
  activation id and digest (`Events.tsx:115-122,145-221`). `rules list` returns only those columns
  (`events-daemon/src/runtime/owner.ts:1923-1929`).
- **`rule show <id>`** exists (CLI and `events_rule_show`). It returns each version's full rule document, but the app
  has no row for it. The table also stores `activated_at`, `superseded_at` and `revoked_at`, which `rule show` doesn't
  return.
- **What the words mean** (events design D2):
  - **state** is `active`, `superseded` or `revoked`, or none for a version never switched on;
  - **approval** is the person's standing yes to disclose future messages;
  - **activation** is the record tying that yes to this exact version.

  Both ids are for audit and mean nothing to a person.
- **Rules have no name field.** The id (`mail-subject`) is the name.
- **A sentence renderer exists only for conditions** (`packages/events/src/conditions/describe.ts`), and it speaks in
  JSON pointers.

**What changes** (prototype row 2):
- **The list** shows one card per rule:
  - its id as its name;
  - a state chip: On, Off, Not switched on, or Dry run as a second chip;
  - one sentence: "When mail arrives in cue/gmail with 'invoice' in the subject, ask Jev '…'. If it says yes, put it in
    the Queue, lane billing.";
  - a line of facts: matches this week, the last match, and when it was approved.
- **Filters:** All, On, Not switched on, Off.
- **Clicking a card opens the rule:**
  - the sentence;
  - six panels: what it watches, which messages, the judge, where they go, what's kept, and the limit (60 an hour by
    default);
  - the last 7 days in counts;
  - its versions, with times and a line on what changed;
  - a collapsed "Technical details": the ids, each explained in a few words.
- **Actions:** Turn off (a tightening, at once) and Remove… (confirmed).
- **Intro copy:** an agent writes a rule when you ask it to, and you approve each one before it starts.

**Decisions**
- **L:** the name is the id. Adding a name to the rule document would change every digest and need every rule
  approved again. A separate display name can come later if the owner wants one.
- **L:** a pure `describeRule(document, labels)` in `packages/events` returns the sentence as parts:
  `{ text, kind: 'plain' | 'value' | 'untrusted' }[]`.
  - `value` marks a channel, an account, a target or a number; `untrusted` marks rule-author text, such as condition
    operands and the judge's question.
  - Field pointers are labelled from the event catalogue (`/subject` → "the subject"), falling back to the pointer.
  - It is used in two places: `rule show`, and the terminal approval preview, which today prints raw canonical JSON.
    The summary goes above the JSON there; the JSON stays, since it is what is approved.
- **L:** `rule show --json` stays an array, one entry per version, and each entry gains `activatedAt`, `supersededAt`
  and `revokedAt` (ms or null), `summary` (the parts) and `counts7d`: `{ matched, judgedYes, judgedNo, held, delivered,
  failed }`, counted from decisions and deliveries in the last 7 days. These are additive, so the MCP twin stays
  compatible. They are content-free.
- **L:** account ids are shown as the aliases the Accounts screen shows (for example `cue/gmail`), and as the id where
  no alias matches.
- **L:** a version that was never switched on reads "Not switched on". If an agent asked for it, its approval is in
  Approvals. The app links there when an open approval names the rule.
- **L:** the app gets allow-list rows for `rule show <id>`, `rule disable <id>` and `rule remove <id>`, where they are
  missing. The rule id is checked against the id grammar in Rust, as `lane` is.

**Left out:** "Try it on a recent message" (`rule test-retained` exists; the screen comes later), and editing a rule in
the app (agents write rules).

### 3.5 Deliveries: the 1970 date, the details, and "the log"

**The owner:** "These are based on some kind of a rule. It's a target that goes into a log, an account, and the next
try is always 1970 … Where is this log that you're mentioning here also? Should I not be able to click on it and see
the details of that event of that delivery?"

**Today**
- **The 1970 date is a bug:**
  - every delivery starts with `next_at = 0` (`runtime/decisions.ts:212,361`);
  - the dry-run, queue and SSE dispatchers mark a delivery `delivered` without clearing `next_at`
    (`dispatcher.ts:571`, `queue-dispatcher.ts:320`, `sse-dispatcher.ts:340`); only the webhook's clears it
    (`webhook-dispatcher.ts:765`);
  - the app formats 0 as 1 January 1970, and its test fixture uses `null`, so no test saw it.
- **`deliveries list`** lacks the target's kind, the last error, any time other than expiry, and the decision and
  event ids. There is no `delivery show`.
- **"The log" is the dry-run target**, the `dryrun_log` table:
  - it keeps the exact would-be event, encrypted, for **at most 24 hours** (`store/schema-v1.ts:264-277`);
  - `dryrun list` and `dryrun show` read it, but only at an interactive terminal (`assertHumanTerminal`,
    `targets/dry-run.ts:11-26`), so the app, which always runs with `--json`, is refused;
  - the events design D7 says a person may read it "at the terminal or in the app";
  - the queue's Q1 already moved the same kind of gate for the app.

**What changes** (prototype row 3)
- **The bug, on both sides:**
  - the three dispatchers set `next_at = NULL` when they deliver;
  - a migration clears `next_at` on rows that are neither `queued` nor `retryable`;
  - the app shows "next try" only for `queued` and `retryable` rows with a positive time.
- **The list** reads "rule → where it went", for example "invoices → Queue, lane billing" or "mail-subject → Dry-run
  log":
  - the channel, the account alias and, when the Queue kept it, the sender;
  - a state chip: Delivered, Recorded, Will try again, Failed, Expired or Cancelled, and the time;
  - filters: All, Will try again, Failed, Done;
  - two intro lines: what a delivery is, and what the dry-run log is (private, on this Mac, nothing sent, each entry
    deleted after 24 hours).
- **Clicking a delivery opens it:**
  - **the message:** where, when, and the sender and subject when they were kept, as outside text, with Open in Gmail
    or Slack and a link to the message's story (§3.6);
  - **why it was passed on:** the rule and version, what matched, and the judge's answer;
  - **for a dry run, what it would have delivered,** each field the sender wrote shown as outside text;
  - **for a webhook, where it sends:** the URL's host;
  - **its tries:** the count, the last answer, the next try, and Try now and Stop trying.

**Decisions**
- **L:** `deliveries list --json` rows gain `targetKind`, `lastErrorCode`, `lastStatus`, `decisionId`, `eventId`, and
  `createdAt` and `deliveredAt` where the table has them. They are additive and content-free. Over MCP, the 0.31 rule
  that hides lane deliveries from windows not bound to the lane still applies.
- **L:** a new `delivery show <id> --json`, **CLI only**: the person's view, refused inside an MCP server
  (`assertNotMcpServer`), with an exception row in `capabilities.json`. It returns:
  `{ delivery: <the list row>, decision: { outcome, decidedAt, judge: { kind, answer, confidence, calibrated } | null },
  event: { eventId, type, accountId, occurredAt, observedAt, source }, target: { kind, id, version, host?: string,
  lane?: string }, dryRun: { expiresAt } | null }`. `source` holds the source's ids only: Gmail `{ messageId }`, Slack
  `{ channelId, ts }`, WhatsApp `{ chatId, messageId }`, Resend `{ emailId }`.
- **L (the owner may overrule, §5 question 2):** `dryrun list` and `dryrun show` move from the human-terminal gate to
  Q1's: refused inside an MCP server's process, allowed with `--json` to the person and the app. This is the design's
  own D7 ("at the terminal or in the app") and the queue's precedent.
  - **The trade:** an agent with a shell, which runs as the person, could now read the log with `--json`. Q1 accepted
    the same trade for the queue.
  - **The guards:** `dryrun show --json` returns the record as data, and the app renders every sender-written field
    with `OutsideText`. The terminal view keeps the untrusted-content envelope.
  - **Review:** this gets the release's one security review.
- **L:** earlier tries are not stored one by one; only the count and the last answer are. The detail says so, and no
  attempts table is added.
- **L:** the app gets allow-list rows for `delivery show`, `dryrun show`, `delivery retry` and `delivery drop`, where
  missing.

### 3.6 Messages: what happened to each one

**The owner:** "I was expecting to see if, for example, something has come in. Did we acknowledge it? Did we reply to
it? Is it something that has been passed over to a session, or was it proactively read by a session, and so on?"

**Today:** the data is in four places, and only some of it joins.
- **The event service** keeps every observed event with the source's ids in clear (`dedupe_key`: Gmail
  `<historyId>,<messageId>`, Slack `<channelId>/<ts>`), each rule's decision with the judge's answer, each delivery and
  each queue item. The chain delivery → decision → event is complete inside its database, but no operation exposes it.
- **The activity log** (core, 0.29) records each agent window's reads with the items' ids. Gmail reads record the
  `messageId`, so "read by window X" joins.
  - Gmail replies don't join: a reply draft records only `{draftId, subject}`, and a send records the sent id with no
    thread.
  - Slack posts record no `thread_ts`, and Slack history reads record the channel's name, not its id.
- **The Slack ack ledger** records the acknowledged message's channel and ts, so it joins.
- **Lanes and the queue:**
  - a wake is held only in memory;
  - a window reading a lane item is not recorded;
  - queue Done and Dismiss store no actor, so "the window did it" and "the person did it" look the same.

**What changes** (prototype row 4)
- **A "Messages" section** in the sidebar, after Queue. Each message that came in is a card:
  - the channel and account;
  - the sender and subject when something kept them, as outside text; otherwise "A Gmail message … open it in Gmail";
  - a status chip: Replied, Acknowledged, Read by an agent, Waiting for you, Done, Dismissed or Not seen;
  - a line of steps, such as "Rule invoices › Jev: yes › Queue, lane billing › Read by the agent in ~/work/cue++/acme ›
    Reply sent 11:45, after your approval".
- **Filters:** All, Waiting for you, Handled by an agent, No agent has seen; and an account picker.
- **Opening a message shows its story:**
  - **a timeline:** arrived, matched, judged, queued, woke a window, read, a reply prepared, approved, sent, done;
  - **the agent windows that touched it;**
  - **one honest line:** built from what Agent Comms saw, so what an agent did elsewhere isn't here.

**Decisions** (all are ids and times, content-free unless marked)
- **L, the event service:** a new owner read, `messages list [--since <ms>] [--before <ms>] [--limit <n>] --json`,
  **CLI only** (the person's view, refused inside an MCP server, an exception row). It returns, newest first, the events
  observed in the window (default: the last 30 days, 100 at a time):
  `{ messages: [{ eventId, type, channel, accountId, occurredAt, observedAt, source, decisions: [{ ruleId, ruleVersion,
  outcome, judge }], deliveries: [{ deliveryId, targetKind, targetId, lane, state }], queueItem: { itemId, state,
  stateAt, lane, history } | null, kept: { from, subject } | null }], next: <cursor> | null }`.
  - `kept` is the queue item's summary when its target keeps one (`show: summary`). It is sender text and is rendered
    as outside text.
  - `message show <eventId>` returns one entry, with the queue item's full history.
- **L, the event service:** a new table, `queue_item_history(item_id, at, kind, actor, window_key)`, with `kind` one
  of woken, read, done, dismissed or reopened, and `actor` either person or window.
  - **Written by:** `events_watch` completing (woken), `events_lane_item` (read), and Done, Dismiss and Reopen from MCP
    (actor window) or from the CLI and the app (actor person).
  - **Retention and access:** it is retained and purged with its item, and never returned over MCP.
  - **Why not activity:** these lines stay out of core's activity log, so an agent's own activity view never names an
    item in a lane bound elsewhere (0.31's B4).
- **L, activity (core and the channels):** the lines gain the ids that link a reply to what it answers. These are
  additive fields on existing lines:
  - `gmail.draft.reply` adds `replyTo: { messageId, threadId }`;
  - `gmail.send.execute` adds `draftId` and `threadId` (from `SendResult`);
  - a send prepared as a reply adds `replyTo`;
  - Slack posts add `thread` (the parent ts) and the channel's id;
  - Slack history reads add the channel's id beside its name.
- **L, core:** a new owner read, `activity items [--since <ms>] [--ids <id,…>] --json`, **CLI only** (the person's
  view, like `activity show`; an exception row).
  - It returns every activity line that names an item, grouped by the item's id.
  - Each line carries the window (key, folder, client), the operation, the time, the outcome, and `replyTo`, `thread`
    and `draftId` where present.
  - Its `subject` and `from` are as recorded: sender text, rendered as outside text.
  - Ids are normalised: a Gmail `messageId`, and Slack `<channelId>/<ts>`.
- **L, the app joins them.** `messages list` and `activity items` are read for the same window, and joined on the
  Gmail message id or the Slack `<channelId>/<ts>`. A message that only an agent read (no event) is included, so "read
  by a session on its own" shows. The status is the furthest step reached, in this order:
  1. Replied: a send whose reply draft's `replyTo` names the message, a Slack post whose `thread` is the message, or a
     Slack ack that replied;
  2. Acknowledged: a Slack ack by reaction;
  3. Done or Dismissed, with the actor;
  4. Read by an agent;
  5. Waiting for you: an open queue item no agent has read;
  6. Not seen.
- **L:** what the person did in Gmail or Slack themselves is not seen, and the screen says so. A `gmail.message.sent`
  rule could add it later.

**Left out:** a thread view (ingest keeps no Gmail thread id, and the draft-id join makes one unnecessary for replies),
and pruning old ingest rows (unbounded today; recorded as a known limit).

### 3.7 Telling the test build apart

**The owner:** "Okay, I have two apps running. Which ones? Which one do I need to click to update and so on?"

**Today:** the test build differs only in its bundle identifier, product name, link scheme and updater. Inside the
window it is identical: the brand, title and tray tooltip are hard-coded "Agent Comms" (`Shell.tsx:71-80`,
`window.rs:128`, `tray.rs:95-101`).

**What changes** (prototype row 5, screen 2):
- **A band across the top:** "TEST BUILD · feat/0.32 · <commit> · built <time> · Uses the test profile, not your real
  accounts".
- **The brand** reads "Agent Comms Test", with an orange chip, and the sidebar names the test profile's folder.
- **The tray** tooltip reads "Agent Comms Test …", and its title is prefixed "T".

**Decisions**
- **L:** a new Tauri command, `app_build`, returns `{ identifier, isTest, commit, builtAt }`, where `isTest` means the
  identifier ends in `.test`. `commit` and `builtAt` are compiled in from `AGENTCOMMS_BUILD_COMMIT` and
  `AGENTCOMMS_BUILD_TIME`, which `local-test-release.sh` exports before it builds. A release build has no band.
- **L:** a tinted Dock icon is left out. The Dock already names the app "Agent Comms Test".

### 3.8 The smaller fixes ("quite a few things that we need to improve here")

- **Rows you can open look it:** each has a "›" and a hover, and the whole row is the link.
- **Account ids** show as aliases everywhere in Events.
- **The sidebar** gains Messages (after Queue) and Connections (after Accounts), each marked "New" for this release.
- **Settings** gains "AI providers".
- **Intro lines:** each Events tab opens with one line saying what it shows.
- **Words:** the Events screens use none of these words: approval id, activation, digest, superseded, retryable,
  dead-lettered. They become "replaced", "will try again", "failed" and so on, and the raw words stay in the collapsed
  technical details.

### 3.9 Prototype only: editing a rule, Analyse, and new kinds of action

**The owner (2026-10-26):** "Prototype the ability to edit a rule … I should have a visual way of editing a rule or a
text-based way of editing a rule. Any of them will have an Analyse, and that will create a more enriched version of the
rules … each of the rules … should maybe be optimised and passed through a prompt optimizer … dedicated to those
specific use cases." Rules may have target actions: "add to Linear … post message to session, starting session, or find
session. If it's not present, create a new session … if the session is busy, enqueue it … the ability to pass on a more
complex payload or context … data or extra text that is either generated by an LLM, fixed by us, or just something
derived from the inputs or any other external factor. Currently, we cannot handle that."

**Prototyped** (prototype row 2, screens 3–5):
- **A visual editor** with five sections: when, which messages, ask a judge, then do, and what's kept and the limit.
- **A text editor** for the same rule, checked as you type.
- **Analyse:** suggestions with before, after and why, each applied or skipped.
- **A review** that lists what changes and what leaves the Mac, approved by typing the rule's name.

**Not in 0.32.0's build.** This is a release of its own, specced after the owner's feedback on the prototype. What it
needs, recorded so the next spec starts from it:
- **Editing makes a new version.** The person's edit in the app is approved in the app, as D2 activations already can
  be, and the old version runs until then.
- **A rule text language** that round-trips with the canonical document. The canonical JSON stays what is approved.
- **Analyse:**
  - reads only the rule and content-free counts on this Mac (matches, judge answers, dismissals);
  - runs on a provider the person chooses (§3.2's keys);
  - uses a per-part optimiser: Jev's question guidance for the judge, and a prompt optimiser for session context.
- **New targets:**
  - **Linear**, with a new integration and OAuth or a key, its scopes chosen by the person;
  - **agent session**: find a session by folder or lane, start one if there is none, or queue the item until it's
    free, which is a per-session queue on top of 0.31's lanes;
  - each adds a disclosure the D2 preview must name.
- **Session context:** fixed text, fields from the message, model-written text and an outside file, web address or
  command. Each is a new disclosure or execution surface, and each needs its own gate.

### 3.10 Prototype only: agents, their sessions and providers

**The owner (2026-10-26):** "prototype integrations if it's using the agents, as in Codex agents or Claude agents … I
should see which sessions are actively doing some things or have done something … with a status … click and open the
session in either VS Code, the desktop app, or CLI … choose if I want to use the locally installed CLI or Claude or
Codex instance, or … a custom one where I connect either an API or a subscription … prototype now but not implement
yet, because we have another project called Claude Stream … that helps with exactly this scenario."

**Prototyped** (prototype row 6):
- **Agents → Sessions:** working, needs you, ready and ended, with Open in VS Code, Terminal or the app.
- **One session:** its conversation, sending it a message, and what is waiting for it.
- **Agents → Providers:** installed or custom, for Claude and Codex.
- **Settings → Integrations:** Linear.

**Not built, by the owner's word.** Live session state and the conversation view belong to the separate streaming
project. This one should take them from there, not duplicate them. What exists here today is activity's per-session
record (0.29) and lane bindings (0.31).

### 3.11 Prototype only: your agent, a digital twin colleagues can ask

**The owner (2026-10-26):** "I want … an agent that is called, for example, Chris's minion or Chris's bot. I want other
colleagues to have similar agents that basically can be added to any chat … a question or a thing can be sent to it.
That will then be handled here in the app … an agent's playground where various agents of our digital twins are able to
ask each other things … define some rules … when somebody … is messaging me about something, or a different rule when
somebody is messaging the bot itself. The bot may be able to provide some simple answers before actually having to do
anything … an exchange of information that can happen easily."

**Prototyped** (prototype row 7):
- **Your agent:** its name, where it can be reached (a Slack bot user, an email address, colleagues' agents), what it
  may answer alone (free/busy, issue states, notes for colleagues, a document index), and what it always hands over.
- **Its rules,** side by side: messages to you, and messages to your agent. The second set's kinds are: answers alone,
  hands to you, to a session, to the Queue.
- **What it was asked,** and what it said, with the ones waiting for you.
- **The playground:** colleagues' agents, what each may ask, and a thread between agents that you can step into.

**Not in 0.32.0's build.** This is the largest of the three, and it needs its own design. What it touches, recorded:
- **A bot identity per channel:** a Slack bot user in each workspace (the org agent app of 0.20 is the nearest start),
  and an email alias.
- **Auto-answers sent without a per-message approval.** That is a standing approval of a new kind, bounded by the
  "answers alone" sources. The 0.23 standing approvals and the 0.19 agent label are where it starts.
- **Agent-to-agent exchange across machines,** which needs a transport and identities between people's installations.
  Nothing like it exists today.
- **Every answer says it is an agent** (the 0.19 label).

## 4. Who reads what (the release's security edges)

- **No new MCP tool returns message content.** `delivery show`, `dryrun show --json`, `messages list`, `message show`
  and `activity items` are the person's: CLI and app, refused inside an MCP server's process.
- **Additive fields on existing MCP results** (`deliveries list`, `rule show`) are ids, times, counts and rule-author
  text. Lane hiding (0.31, B4) still applies.
- **Queue history stays in the event service.** It never enters core's activity log.
- **Sender-written text** (kept sender and subject, dry-run record fields, activity subjects) reaches the app only as
  data and is rendered with `OutsideText` / `UntrustedText`.
- **Keys** are read from stdin and never echoed, logged or returned. `provider key list` returns presence and dates.
- **Changes from the app:**
  - adding a server to an app and setting up a judge are the person's acts: a press in the app, after the preview, with
    a check on macOS that the app started the command (a speed bump against agents, not a boundary against code
    running as you); refused to agent markers and inside an MCP server's process;
  - adding a server goes through the app's approval: core's change approval, answered through the app channel;
  - removing a server, turning a judge off and turning a rule off are tightenings and apply at once.

**Settled after the security review (2026-10-26).** The release's review found a real bypass in `--app-approval`, and
two weaknesses beside it. Each is fixed:
- **`--app-approval` approved before it checked (high).** It answered any waiting change's code first and planned after,
  so a plan that refused (`--print`, a no-op, a throw) left that approval approved for any other change to claim. Now
  core plans first, refuses a change that needs no approval, checks the approval is a waiting change whose stored
  digest is exactly this install's, and only then answers it and claims it in the same flow, revoking it if it is not
  applied. The review's scenarios are regression tests.
- **The app's origin is checked (macOS).** Core's `desktopAppOrigin()` checks that the app started this process — the
  release, against the owner's requirement (its identifier, Apple's anchor, team `75K3LTUM8A`), or the local test
  build, ad-hoc signed. `--app-approval`, `judge setup` and `provider key set|remove` require it on macOS, and the
  audit says `approvedBy: desktop-app` only for the release. (The second look below changed how it checks.)
- **`provider key set` from a pipe (medium).** It got around `judge key set`'s terminal gate. Now a key, and judge
  setup, come only from the app the check found (the key on stdin) or an interactive terminal (hidden input, never a
  pipe), and the audit records the real origin.
- **What it does not close:** Windows and Linux check nothing (§7). There the app's path keeps the marker checks, and
  its audit line says `desktop-app (unattested)`. (0.33.0's second look closed that path for the event service's
  changes: there judge setup and a provider key are done at a terminal; see §7.)

**Settled after the second look (2026-10-26).** An independent second look confirmed the high finding above closed, and
found the origin check spoofable two ways and two smaller gaps. Each is fixed:
- **The parent's argv[0] was trusted (high).** `ps -o comm=` reports the name a process gives itself, so `exec -a` with
  the app's path passed. Codesign now verifies the running parent by its pid; the path is read only for the message.
- **Any home-made ad-hoc app passed as the test build (high).** A test-build origin now holds only when the parent's
  running code says `com.cueplusplus.agentcomms.test`, the config folder holds `.agentcomms-test-profile` (written by
  `scripts/local-test-release.sh` and nowhere else), and that folder is not the person's real, default one. Its
  approvals are audited `desktop-app (test build)`.
- **An approval could stay approved after its answer (low).** Any throw after the code is answered, the audit write
  included, now revokes it.
- **The event service's `approvedBy` was not the real origin (low).** Judge setup's result and its enablements now
  carry where the person was, as the CLI established it: the release app, the test build, the app unattested, or a
  terminal (approved on the terminal's own challenge).
- **What this is:** the origin check confirms the app started the command — a speed bump against agents, not a boundary
  against code running as you, which can approve in-process anyway. The event service's origin label rides on a
  same-user control token, likewise a speed bump.

## 5. Questions the prototype puts to the owner (with the lead's default)

1. **Messages as its own section,** rather than folded into Activity. Default: its own section.
2. **The app shows a dry run's would-be content,** as the Queue already shows senders and subjects. Default: yes
   (§3.5).
3. **Adding a server to an app from the app,** through the app's approval rather than the Terminal. Default: yes.
4. **A rule's id is its name.** Default: yes; a display name later if wanted.

The screens are built after the owner's answers. The parts with no screen do not depend on them.

## 6. Release

**0.32.0, a minor.** Packages:
- `@agentcomms/events-daemon`: judge setup, provider keys, the 1970 fix, delivery show, the dry-run gate,
  `rule show` fields, messages and queue history;
- `@agentcomms/events`: `describeRule`;
- `@agentcomms/core`: `activity items`, and `mcp uninstall` if needed;
- `@agentcomms/gmail` and `@agentcomms/slack`: the activity ids;
- the desktop app.

No migration is asked of anyone. Two schema migrations run automatically: `queue_item_history`, and the clearing of
`next_at`.

## 7. Known limits

- **"Last used" per app** is what windows reported about themselves.
- **A message's story** shows only what Agent Comms saw.
- **Earlier delivery tries** are counted, not kept.
- **Ingest rows** for observed events are not pruned, as before.
- **The dry-run log** keeps an entry 24 hours at most, so a dry run older than that shows its delivery but not its
  content.
- **The app's origin is checked on macOS only, and only as a speed bump.** On macOS it confirms the app started the
  command, which code running as you can get around. On Windows and Linux nothing is checked, so since 0.33.0's second
  look the event service's changes go through a terminal: judge setup, a provider key set or removed (and, in 0.33.0,
  Integrations → Agent sessions and a rule's approval) from an origin nothing attests are refused with
  `APPROVAL_REQUIRED` and `ORIGIN_UNATTESTED`, audited as `desktop-app (unattested)`, and the app offers Do it in
  Terminal. Adding a server in the app (core's `--app-approval`) still rests there on the agent-marker checks, a speed
  bump an agent's shell could get past. The event service's origin label is a same-user control client's word.
