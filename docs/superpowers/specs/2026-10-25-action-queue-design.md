# The action queue: matches the person acts on, in the app

Status: draft, 2026-10-25. Written under the owner's standing directive "continue until all is implemented"
(`/goal`, 2026-10-25), not an explicit approval. The owner reviews it with the release.

## 1. Intent

The owner's vision (2026-10-24):
- rules per account, such as "when David is messaging me on Slack…";
- **a queue of actions**;
- routing to the right session.

They agreed the order: the audit (0.29.0, activity), then **the queue**, then routing. The desktop design (2026-10-24 §5)
says the queue is "a rule target that puts each match in a list in the app, with what the judge said it is about".

**What exists.**
- The event service matches incoming mail and messages against approved rules, optionally asks a judge (Jev, a
  local model server; Laya later), and delivers each match to a **target**.
- **The targets today:**
  - **dry-run:** an encrypted local log, at most 24 hours, read only by a person through `dryrun show`;
  - **webhook:** network;
  - **local SSE:** a loopback stream for a subscriber.
- **The gap:** nothing turns a match into something the person sees and works through. Matches go to a machine
  (webhook, SSE) or to a 24-hour log meant for testing a rule.

## 2. Goals, non-goals, anti-goals

**Goals**
- **A new target kind, `queue`.** Each match becomes one **item** in a list the person works through.
- **Each item says:**
  - what arrived: channel, account, from whom, subject or first words, and when, all as untrusted text marked
    *From outside*;
  - which rule matched;
  - **what the judge said**: the rule's question, the judge's answer (yes or no) and its confidence.
- **The person acts on an item:** **Done**, **Dismiss**, or **Open**, which opens the message in its own app
  (Gmail's web link, Slack's link) when one exists.
- **A Queue screen in the desktop app:**
  - open items first, newest first, with a count in the sidebar;
  - done and dismissed items for the retention;
  - filters by rule and channel.
- **The same at a terminal:** `agent-events queue list|show|done|dismiss`.
- **Retention:** 7 days by default and 30 at most, bound into the target version, as every content-bearing record's is.

**Non-goals (this release)**
- **Routing an item to an agent session,** or letting an agent take an item. That is §5 item 3, research first.
- **Acting on the item itself:** replying, labelling, archiving. The person does that in the message's own app, or
  asks an agent.
- **Notifications** (a macOS banner): a later step, once the queue proves useful.

**Anti-goals: it fails, even if it works, if:**
- **An agent can read the queue.** Its content is message content: it's a person's read, as `dryrun show` is. No MCP
  tool returns item content.
- **Content outlives its retention,** or survives a revocation that purges deliveries (D7, D8).
- **Sender text is rendered as anything but plain text.**
- **The queue adds a network path.** A queue target makes no network I/O.

## 3. Constraints
- **The events design is normative,** with Appendix A, the D2 standing disclosure authorisation, D7's delivery
  promises and D8's retention table. A queue target is a fourth adapter beside dry-run, webhook and SSE. This
  document amends D7 and D8 for it: the events design gets a dated note, and Appendix A's catalogue is unchanged.
- **Laya E2's frozen fragments** anchor lines in the event service. Nothing anchored may change, and
  `pnpm verify:events-phase-e2` must stay OK.
- **The desktop reads only through the allow-listed CLI** (DA4). It may mark an item done or dismissed itself:
  that changes only the person's own list and takes nothing away from anyone (DA10).
- **CLI and MCP parity:** the content reads are terminal-only exception rows with reasons, as `dryrun show` is. Two
  content-free reads go to both, as `events_queue_counts`: the open count and the per-rule counts.

## 4. Decisions (the lead's calls)

### 4.1 The target: like dry-run, with state
- **A `queue` target version binds:**
  - a name;
  - a retention of 1 to 30 days, default 7;
  - **what the item shows:** `summary`, the default (from whom, subject or first 140 characters, and a link), or
    `minimal` (from whom and the subject only).
- **No network, no secret.** Creating or editing one needs the same approval as any target, in the terminal or the
  app's typed challenge (D2).
- **At the delivery boundary,** the matched event's projection, as the rule's mapping gives it, is appended
  encrypted to a new `queue_items` table, in the same transaction that charges the cap and finishes the delivery. This
  is exactly dry-run's pattern, so every existing fence (cap, account, switch generation, revocation) applies
  unchanged.
- **Each item:** a delivery id, the bound rule version, the judge decision reference, the state (`open`, `done` or
  `dismissed`), `stateAt`, `expiresAt`, and the encrypted content.

### 4.2 What the judge said
- **When the rule asked a judge,** the item carries the rule's question (from the rule version), the judge's id,
  kind and model, its answer, and its confidence or score as the decision recorded it.
- **No judge:** the item says the rule matched without one.
- **A local endpoint's uncalibrated score** is labelled "uncalibrated", as the events design already requires.

### 4.3 Retention, revocation, purge
- **An item's content is purged at `expiresAt`,** whatever its state. Its content-free row (rule, state, times)
  stays until the same retention again, for the counts, then goes.
- **Every revocation that purges deliveries or dry-run rows** purges queue items of the same bound versions, in the
  same transaction (D7's rule, extended). Account removal and WhatsApp's visibility seam purge them too.
- **Done and dismissed don't purge early.** The person can still look back within the retention. A **Clear** action
  purges done and dismissed items now.

### 4.4 The commands
- **Terminal and app only** (content):
  - `agent-events queue list [--state open|done|dismissed|all] [--rule] [--channel] [--since] [--json]`;
  - `agent-events queue show <item> [--json]`.
- **Both CLI and MCP** (state changes, no content): `queue done <item>`, `queue dismiss <item>`, `queue reopen <item>`,
  `queue clear`.
  - Done and dismiss tighten nothing and loosen nothing, so they need no approval.
  - Through MCP, an agent may mark an item done (a step toward routing) but never read its content.
- **Content-free counts:** `queue counts`, for the sidebar badge and an agent's "is there anything waiting".

### 4.5 The Queue screen
- **A sidebar section, Queue, first after Overview,** with the open count as a badge.
- **Each item is a card** in the soft look:
  - the channel and account;
  - from whom, in *From outside*;
  - the subject or first words, in *From outside*;
  - when;
  - the rule's name;
  - the judge's answer and confidence, as a quiet chip ("Jev: yes, 0.86").
  
  Its actions are **Done**, **Dismiss** and **Open in Gmail** or **Open in Slack** when the item has a link (through
  the app's `open_link` allow-list, for that provider's web host only).
- **Tabs:** Open, with its count, then Done, then Dismissed. The open tab updates when the window comes back, and
  every 30 seconds while it is shown.
- **Empty:**
  - with no queue target, the screen says how to add one: a target and a rule, approved in the terminal;
  - with nothing waiting, it says nothing is waiting.

### 4.6 Overview
Overview's tiles gain **Queue**, the open count, beside Approvals waiting.

## 5. Left to the builder
- The `queue_items` table's schema and migration, within the event database's migration rules.
- How the projection becomes the item's summary fields, per channel, from the mapping the rule already has.
- The links' exact form per channel, within the allow-list rule.
- The card's layout, within the soft look.

## 6. Release
**0.30.0, a minor:**
- the event service: the target kind, its storage and its commands;
- core: none;
- the desktop: the Queue screen and the Overview tile;
- the events design gets its dated note.

## 7. Settled after the builder check (the lead's calls, 2026-10-25)

Each answer overrides the section it names.

### Q1. Who may read item content (overrides §2's anti-goal and §4.4)
- **No MCP tool returns item content.** Content reads are CLI only: `queue list` and `queue show` from a terminal, and
  from the desktop app, which runs the CLI with `--json` and no terminal.
- **This is the boundary activity already has (activity design, S3).** An agent that can run a shell runs as the
  person, and can read what the person can; no CLI gate changes that, so none is pretended.
- **The anti-goal therefore reads:** "no MCP tool, and no agent through MCP, can read the queue's content."
- **The CLI read is a new, separate gate:** it refuses when the calling process says it is an MCP server.
  `dryrun show`'s terminal-only gate is unchanged.
- **Rows in `capabilities.json`:** the content reads are `cli-only` exception rows, with this reason.

### Q2. Retention lives on the rule (overrides §4.1)
- A rule's `retention` document gains an optional `queueMs`, beside `dryrunMs`. It is required when, and only when,
  the rule has a queue target, and it is 1–30 days.
- The canonical form omits it when absent, so every stored rule, and its digest, is unchanged.
- **The target version** binds its own `retentionMs` the way dry-run's does. The item's deadline is the lesser of the
  two.
- **Shortening `queueMs` is a tightening, applied at once,** through `replacements.ts`'s existing path. It is
  extended to name `queueMs`.

### Q3. The judge's answer is read from the decision, never copied (overrides §4.2)
- The item points at its decision. While the decision's metadata lives, the item shows the judge's answer and
  confidence.
- After the metadata expires, it says "the judge's answer is no longer kept". No deadline extends another.
- **A held decision the person let through** shows "you let it through", with no judge answer.

### Q4. A queue target needs the fields it shows (adds to §4.1)
- **On a rule with a queue target,** creating or activating it is refused unless the rule's mapping includes, per
  channel:
  - **Gmail:** the sender and the subject;
  - **Slack:** the poster and the text's first words, from the mapping's own text field;
  - **Resend and WhatsApp:** the sender and the subject or the first words, where the mapping offers them.
  
  The refusal names the missing fields.
- **Links:** shown only when the mapping includes the ids a link needs. Otherwise there is no link.
- **Nothing is fetched** to fill an item. "First 140 characters" comes only from a mapped text field. D8's rule (keep
  only what the rule uses) is unchanged.

### Q5. Agents get a content-free list (overrides §4.4)
- **Both CLI and MCP get `queue items`:** id, rule id, channel, account id, state and times. Never the sender, subject,
  text or link.
- An agent can find an item and mark it done, dismissed or reopened, without reading what it says.

### Q6. Tightening a rule still removes its items (adds to §4.3)
- **D2's revocation rules are unchanged.** A tightening revokes the displaced rule version, and its queue items are
  purged with it, as its dry-run rows are.
- **What the person is told first:**
  - the tightening's preview, at the terminal and in the app, says "N open queue items under this rule will be
    removed";
  - the Queue screen says the same beside the rule's filter when a tightening is pending.
- Keeping items across a revocation would change D2's security model. It is not done here.

## 8. Build plan (the lead's, 2026-10-25)

Two tasks, in parallel. The JSON below is their contract; both build to it exactly.

### The CLI's JSON (the event service's `agent-events`)
- **`queue list [--state open|done|dismissed|all] [--rule <id>] [--channel gmail|slack|resend|whatsapp]
  [--since <ISO|7d>] [--limit n] --json`** (CLI only, content; Q1) gives:
  - `{ items: Item[], more: boolean }`, newest first.
  - **`Item`:**
    - `{ id, state: 'open'|'done'|'dismissed', stateAt, arrivedAt, expiresAt }`;
    - `rule: { id, version, name }`, `channel`, `account: { id, alias }`;
    - `from: { name?, address? }`, `subject?`, `text?`;
    - `link?: { kind: 'gmail'|'slack', url }`;
    - `judge: { state: 'answered'|'expired'|'released'|'none', id?, kind?, model?, question?, answer?: 'yes'|'no',
      confidence?: number, uncalibrated?: boolean }`.
  - `from.name`, `from.address`, `subject` and `text` are sender-written, so they are wrapped in the untrusted-content
    envelope, as `activity show` wraps them.
- **`queue show <id> --json`** gives `{ item: Item }` (CLI only).
- **`queue items [--state] [--rule] [--channel] [--limit] --json`** (CLI and MCP, content-free; Q5) gives `{ items:
  [{ id, state, stateAt, arrivedAt, expiresAt, rule: { id, version, name }, channel, account: { id, alias } }],
  more }`.
- **`queue counts --json`** (CLI and MCP) gives `{ open, done, dismissed, byRule: [{ ruleId, name, open }] }`.
- **`queue done|dismiss|reopen <id> --json`** (CLI and MCP) gives `{ item: { id, state, stateAt } }`.
- **`queue clear --json`** (CLI and MCP) gives `{ cleared: number }`. It purges done and dismissed items now.
- **Item ids:** `qi_` followed by 26 Crockford base32 characters.
- **Exit codes:** 66 for no such item, 64 for a bad argument.

### Task A: the event service (packages/events-daemon)
- **The target:**
  - the `queue` target document and its validation;
  - the `queue_items` table and its migration;
  - the append at the delivery boundary, dry-run's pattern;
  - retention: the rule's `queueMs` and the target's `retentionMs` (Q2);
  - the expiry sweep and every purge hook that purges dry-run rows, extended to queue items.
- **The rest of §4 and §7:** the judge read (Q3), the mapping refusal (Q4), the commands and JSON above, the MCP
  tools (`events_queue_items`, `_counts`, `_done`, `_dismiss`, `_reopen`, `_clear`) and the `capabilities.json` rows.
- **The tightening preview's count of open items** (Q6).
- **The events design's dated note** under D7 and D8.

### Task B: the desktop app (apps/desktop)
- **The Queue screen (§4.5)** and the Overview tile (§4.6), read through allow-listed calls to the CLI above (closed
  argument shapes, the item id's grammar), gated at 0.30.0.
- **Done, Dismiss, Reopen and Clear:** the app applies these itself (DA10).
- **Links** open through `open_link`, only for `https://mail.google.com/` and `https://*.slack.com/` and
  `https://app.slack.com/`.
- **Fixtures** come from the contract above, until Task A's real output replaces them.
