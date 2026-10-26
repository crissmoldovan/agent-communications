# 0.32.0 Implementation Plan: the owner's feedback

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`)
> syntax. Each builder works in its own worktree off `feat/0.32` and merges back by the lead.

**Goal:** answer each item of the owner's 2026-10-26 feedback: judges and keys in the app, Connections, readable rules
and deliveries, the 1970 fix, the dry-run log in the app, a story per message, and a test build you can tell apart.

**Architecture:** the services first: event service, core and channels, each new read the person's (CLI and app,
refused inside MCP). The screens come second, after the owner's feedback on the prototype canvas. The app joins the
event service's `messages list` with core's `activity items` on source ids.

**Tech stack:** TypeScript (Node 22/24), SQLite migrations in `packages/events-daemon/src/store/migrations.ts`, the
Tauri 2 + React desktop app on `@cueplusplus/ui` 0.30.0 with the `soft` theme.

**Spec:** `docs/superpowers/specs/2026-10-26-owner-feedback-0320-design.md` (read it first; its §3.x contracts are
normative). The prototype is https://claude.ai/artifact/3dRSZuWTRDfw9JjGmurYNM.

## Global Constraints

- **Lean checking:** each builder runs only the tests it touched, the root suite
  (`node --import ./test/helpers/loopback-seal-preload.mjs --test 'test/**/*.test.mjs'`) and
  `pnpm verify:events-phase-e2`, and never a full package suite. One cloud dry run gates the tag.
- **Filtered install only:** `pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'`. Never commit a
  pnpm-written change to `pnpm-workspace.yaml`.
- **New reads that return message ids or content are CLI only:** they are refused inside an MCP server's process
  (`assertNotMcpServer`) and have an `exception` row in `capabilities.json` with its reason.
- **Additive JSON only** on existing operations: no field is removed or renamed.
- **The skill-safety scan:**
  - no real home-folder path (macOS or Linux) in any text file; use `/example/home/…`;
  - no 8+ character secret-shaped literals; use `fake-…`;
  - no `agentcomms:` at the start of a runtime message;
  - docs name whole commands (for example `agent-events delivery show`).
- **The Laya E2 frozen boundary:** in `apps/desktop/src/ipc.ts` every `Call` row is one line, and Laya's two rows stay
  last.
- **B3 manifests:** editing a line that `packages/events-daemon/test/b3-guard-manifests/*.json` anchors means updating
  its `mutation.from`.
- **Windows:** tests that need POSIX permissions take `{ skip: WINDOWS_SKIP }`.
- **Never** send mail or post to Slack, never use a real key, and never read the owner's real folders.

## Review Focus

1. A delivered dry-run, queue or SSE row returns `nextAt: null`, and an old row with `next_at = 0` is cleared by the
   migration. The app never renders a date for `nextAt` ≤ 0.
2. `delivery show`, `dryrun list/show`, `messages list`, `message show` and `activity items` each refuse inside an MCP
   server's process (`AGENTCOMMS_MCP_SERVER`-style marker), with exit 10, and work with `--json` outside.
3. Over MCP, `deliveries list`'s new fields never reveal a lane delivery to a window not bound to it.
4. `describeRule` marks every rule-author string (condition operands, judge question) `untrusted`, and the app renders
   those parts with `UntrustedText`.
5. A Slack reply's `thread` and a Gmail reply's `replyTo` join to the message's event source id, in the app's join.

---

## Phase 1: the services (now)

### Task A: judges and provider keys (in progress, `feat/0.32-judges`)

As briefed: `judge setup`, `provider key set|remove|list`, Jev's `provider` field, the `openrouter.ai` allow-list, then
the desktop part after the owner's feedback (§3.1, §3.2).

### Task B: rules and deliveries you can read (`packages/events`, `packages/events-daemon`)

**Files:**
- Create: `packages/events/src/rules/describe-rule.ts`, `packages/events/test/describe-rule.test.ts`.
- Modify:
  - in `packages/events-daemon/src/runtime/`: `dispatcher.ts:571`, `queue-dispatcher.ts:320`, `sse-dispatcher.ts:340`,
    `b3-operator-control.ts:434-460` and `owner.ts:1923-1945`;
  - `store/migrations.ts`, `cli/program.ts` (`delivery show`, the dryrun gate) and `targets/dry-run.ts`;
  - the approval preview (`operations/b3-contract.ts:1531-1541`), `capabilities.json`, and the B3 manifests that
    anchor any edited line.

**Interfaces**
- **Produces:** `describeRule(document: CanonicalFullRuleDocument, labels?: FieldLabels): RulePart[]`, where
  `type RulePart = { text: string; kind: 'plain' | 'value' | 'untrusted' }`.
- **Produces:** `rule show --json` entries gain `activatedAt`, `supersededAt`, `revokedAt` (number|null), `summary:
  RulePart[]` and `counts7d: { matched, judgedYes, judgedNo, held, delivered, failed }`.
- **Produces:** `deliveries list --json` rows gain `targetKind`, `lastErrorCode`, `lastStatus`, `decisionId`,
  `eventId`, and `createdAt` and `deliveredAt` where stored.
- **Produces:** `delivery show <id> --json` with the shape in spec §3.5, CLI only.
- **Produces:** `dryrun list --json` / `dryrun show <id> --json` allowed outside MCP. `show` returns `{ deliveryId,
  ruleId, ruleVersion, targetId, targetVersion, eventId, accountId, deliveredAt, expiresAt, record }`, where `record`
  is the parsed would-be event.

**Steps**
- [ ] **The 1970 bug:**
  - write `delivered rows clear next_at` for dry-run, queue and SSE (expect `nextAt === null` from `deliveries list`)
    and a migration test (a `delivered` row with `next_at = 0` reads back `null`); run them and see them fail;
  - set `next_at = NULL` in the three dispatchers, and add the migration that clears `next_at` where `state` is not
    in (`queued`, `retryable`); pass; commit.
- [ ] **The list fields:** a `deliveries list` test expecting the new fields for a dry-run and a webhook row, and that
  an MCP caller not bound to a lane still sees no lane delivery. Implement and commit.
- [ ] **`delivery show`:**
  - tests: the shape (decision with a judge answer and without), `source` per channel from the `dedupe_key`
    (Gmail `<historyId>,<messageId>` → `{ messageId }`; Slack `<channelId>/<ts>` → `{ channelId, ts }`), exit 66 for an
    unknown id, and exit 10 inside MCP;
  - implement, add the `capabilities.json` exception row, and commit.
- [ ] **The dry-run gate:**
  - tests: `dryrun list --json` and `dryrun show --json` succeed without a TTY and refuse inside MCP; the terminal view
    keeps the envelope;
  - move both to the Q1 gate as the queue's `show` does (`program.ts:720-760`); update the B3 manifests; commit.
  - This change gets the release's security review.
- [ ] **`describeRule`:**
  - tests: a Gmail rule with `any` of two `contains`, a judge and a lane queue target gives the spec's sentence; a
    Slack rule with no judge; a dry-run target; an operand containing `<script>` comes back as an `untrusted` part
    unchanged;
  - implement, labelling pointers from the catalogue's field descriptions; commit.
- [ ] **`rule show`:** tests for the new fields (times from the rules table; counts from decisions and deliveries in a
  7-day window with a fixed clock). Implement, then put the summary above the canonical JSON in the terminal approval
  preview. Commit.
- [ ] **Docs and checks:**
  - the events README and skill name `agent-events delivery show` and the dry-run log's 24 hours;
  - CHANGELOG lines under 0.32.0;
  - the root suite and `verify:events-phase-e2` pass;
  - commit.

### Task C: a story per message, in the event service (`packages/events-daemon`)

**Files:**
- Modify:
  - in `packages/events-daemon/src/`: `store/migrations.ts`, `runtime/queue.ts:461-478,692-705`, `runtime/lanes.ts`
    (wake), `mcp/` (the `events_lane_item` read), `cli/program.ts` and `runtime/owner.ts`;
  - `capabilities.json`.
- Test: `packages/events-daemon/test/messages-list.test.ts`, `packages/events-daemon/test/queue-history.test.ts`.

**Interfaces**
- **Produces:** the table `queue_item_history(item_id TEXT, at INTEGER, kind TEXT CHECK (kind IN
  ('woken','read','done','dismissed','reopened')), actor TEXT CHECK (actor IN ('person','window')), window_key TEXT)`,
  purged with its item.
- **Produces:** `messages list [--since <ms>] [--before <ms>] [--limit <n>] --json` and `message show <eventId>
  --json`, both with the shapes in spec §3.6 and both CLI only. `limit` defaults to 100 and caps at 500; `since`
  defaults to 30 days back.
- **Consumes:** Task B's `source` parsing from `dedupe_key`. If B hasn't landed, put the parser in
  `runtime/event-source.ts` and B reuses it. The first to land owns the file.

**Steps**
- [ ] **History:**
  - tests: a wake writes `woken`; `events_lane_item` writes `read` with the window's key; Done from MCP writes actor
    `window`, and Done from the CLI writes `person`; history goes when its item is purged; no MCP tool returns history;
  - implement and commit.
- [ ] **`messages list`:**
  - tests: three events (one no-match, one judged yes and queued in a lane, one dry run) come back newest first, with
    decisions, deliveries and the queue item; `kept` only when the target keeps a summary; the cursor pages; exit 10
    inside MCP;
  - implement as one owner read joining ingest, decisions, deliveries and queue items by `event_id`; commit.
- [ ] **`message show`:** a test for one event with full history. Implement and commit.
- [ ] **Docs and checks:** the events README section "What happened to a message"; the CHANGELOG; the root suite and
  `verify:events-phase-e2`; commit.

### Task E: activity that links replies (`packages/core`, `packages/gmail`, `packages/slack`)

**Files:**
- Modify:
  - `packages/gmail/src/operations/drafts.ts:240-243,478-485` and `packages/gmail/src/operations/send.ts:1206-1217`;
  - `packages/slack/src/activity.ts:127-138,258-269`;
  - `packages/core/src/activity.ts` (the `items` read), `packages/core/src/cli.ts` and `capabilities.json`.
- Test: `packages/gmail/test/activity-reply-links.test.ts`, `packages/slack/test/activity-thread.test.ts`,
  `packages/core/test/activity-items.test.ts`.

**Interfaces**
- **Produces, on activity lines (additive):**
  - `gmail.draft.reply` adds `replyTo: { messageId, threadId }`;
  - `gmail.send.execute` adds `draftId` and `threadId`;
  - a send prepared as a reply adds `replyTo`;
  - Slack posts add `thread` (string|null) and `channelId`;
  - Slack history reads add `channelId`.
- **Produces:** `activity items [--since <ms>] [--ids <id,…>] --json` → `{ items: { [id: string]: Array<{ session: {
  key, folder, client }, operation, at, outcome, subject?, from?, replyTo?, thread?, draftId? }> } }`. Ids are
  normalised: a Gmail `messageId`, and Slack `<channelId>/<ts>`. It is CLI only, with an exception row beside
  `activity show`'s.

**Steps**
- [ ] **Gmail:** tests with the fake transport: a reply draft's line carries `replyTo`, and the send of that draft
  carries `draftId` and `threadId`. Implement and commit.
- [ ] **Slack:** tests with the injected fetch: a threaded post carries `thread` and `channelId`, and a history read
  carries `channelId`. Implement and commit.
- [ ] **Core `activity items`:**
  - tests: lines from two sessions about one Gmail message group under its id; `--ids` filters; Slack ids are
    normalised; exit 10 inside MCP;
  - implement over the activity files in range; commit.
- [ ] **`mcp uninstall`:** check whether core can unregister one server from one client. If not, add `mcp uninstall
  --client <c> --server <s>` as a tightening (applies at once, no approval), with its MCP twin
  `comms_server_uninstall` and `both` rows. Test it against a temp client config; commit.
- [ ] **Docs and checks:** the core README's activity section; the CHANGELOG; the root suite; commit.

## Phase 2: the screens (after the owner's feedback on the prototype)

These are planned now and briefed after the feedback, which may change them. Each is one builder in `apps/desktop`,
adding its `Call` rows (one line each, above Laya's) and its allow-list argv in `src-tauri/src/allowlist.rs`.

- **U1, judges and keys:** Task A's desktop part (§3.1, §3.2).
- **U2, rules:** the Rules list and rule detail (§3.4). Rows: `eventsRuleShow{ruleId}`, `eventsRuleDisable{ruleId}`,
  `eventsRuleRemove{ruleId}`.
- **U3, deliveries:** the Deliveries list and delivery detail (§3.5). Rows: `eventsDeliveryShow{deliveryId}`,
  `eventsDryrunShow{deliveryId}`, `eventsDeliveryRetry{deliveryId}`, `eventsDeliveryDrop{deliveryId}`. Never render
  `nextAt` ≤ 0.
- **U4, messages:** the Messages screen and a message's story (§3.6). Rows: `eventsMessagesList{since,before,limit}`,
  `eventsMessageShow{eventId}`, `activityItems{since,ids}`. The join and status order are in the spec.
- **U5, Connections** (§3.3). Rows: `channels`, `mcpInstall{client,server}` (through the app's approval) and
  `mcpUninstall{client,server}`.
- **U6, the test build and the small fixes** (§3.7, §3.8):
  - the `app_build` Tauri command, the band, the brand and the tray;
  - `local-test-release.sh` exports `AGENTCOMMS_BUILD_COMMIT` and `AGENTCOMMS_BUILD_TIME`;
  - sidebar entries and "New" tags;
  - account aliases.

## Phase 3: release

1. Merge A, B, C and E into `feat/0.32`, then the lead runs the root suite.
2. A local test build goes to the owner, followed by U1–U6, then another local test build.
3. Once the owner says "release": one dry run, the PR, the merge, the tags, and the desktop release, as before.
