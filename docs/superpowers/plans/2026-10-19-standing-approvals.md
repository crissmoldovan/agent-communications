# Standing Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person approve in advance, at a terminal with a code, a fixed set of Slack acknowledgements — standard
emoji reactions or short fixed replies — that an agent may then send, without asking, on a message that has just
arrived from another person, within places, counts and an expiry the person set.

**Architecture:**
- **The model is core's.** `packages/core/src/standing.ts` holds contents, places, limits, digests and what widens. The
  approval store gains a `standing` kind and one-shot child sends. `standing-ledger.ts` counts acts per account, and
  `standing-use.ts` mints a child under both locks.
- **Creating and using one are Slack's,** because both read Slack: `packages/slack/src/operations/standing.ts`
  prepares one, and `packages/slack/src/operations/ack.ts` uses one. The child goes through Slack's existing
  `claimOrHandOver`, `postPrepared` and `reactPrepared`. There is no new send path.
- **Reporting, narrowing and ending are core's,** in `packages/core/src/operations/standing.ts`, on the CLI and MCP in
  parity.
- **Each act raises an OS notification** through `packages/core/src/notify.ts`, behind an injected runner.

**Tech Stack:** TypeScript (Node 22.12+, `--experimental-strip-types`), zod 4, `node:test`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-19-standing-approvals-design.md` (S1–S11). Read it with this plan. Spec 2's
plan, `docs/superpowers/plans/2026-10-19-agent-behaviour-rules.md`, is built: `allowedAct`, `ActDecision`,
`BehaviourAct`, `actNotAllowed`, `ACT_NOT_ALLOWED` and `claimOrHandOver`'s `check` parameter exist. Read `AGENTS.md` too.

## Global Constraints

- **Placement (the plan's call, forced by the code).** Core has no Slack client (`packages/core/package.json` depends on
  no channel), and a creation preview must show each place's name, member count and sharing (S5, S8). So `standing add`
  is `agent-slack standing add` and `slack_standing_add`. Core keeps `agentcomms standing list|narrow|revoke|off` and
  `comms_standing`. Both `agentcomms approve` and `agent-slack approve` complete one.
- **Acts, exactly:** `STANDING_ACTS = ['reaction', 'reply']`. A reaction is only ever added, never removed.
- **Contents:** at most 5 reactions and 5 replies; `eyes` alone when none is given. Each is `{ kind, text, digest }`,
  where `digest = sha256Hex(canonicalJson({ kind, text }))`.
- **Reactions:** a name from `STANDARD_EMOJI` in `packages/core/src/standing-emoji.ts`. This is a curated list of
  standard Unicode names, each with its code point: `eyes`, `white_check_mark`, `heavy_check_mark`,
  `ballot_box_with_check`, `+1`, `thumbsup`, `ok`, `ok_hand`, `100`, `heavy_plus_sign`, `handshake`, `raised_hands`,
  `pray`, `clap`, `wave`, `memo`, `pencil2`, `hourglass_flowing_sand`, `stopwatch`, `inbox_tray`, `pushpin`, `mag`,
  `bulb`, `speech_balloon`, `thinking_face`, `slightly_smiling_face`, `heart`, `tada`, `rocket`, `sparkles`.
  - `READS_AS_APPROVAL` is `white_check_mark`, `heavy_check_mark`, `ballot_box_with_check`, `+1`, `thumbsup`, `ok`,
    `ok_hand`, `100`, `heavy_plus_sign` and `handshake`.
- **Reply texts:** 1 to 200 characters, one line, trimmed. A text is refused for any of `<`, `>`, `*`, `_`, `~`, a
  backtick, `{`, `}`, `[`, `]`, `|`, `@`, a control character, a `:word:` emoji code, `://`, `www.`, `mailto:`, or a
  dotted name matching `/[A-Za-z0-9-]+\.[A-Za-z]{2,}/`.
- **Limits:**

  | Limit | Default | Allowed |
  |---|---|---|
  | `perThread` | 1 | 1–3 |
  | `perHour` | 10 | 1–30 |
  | `perDay` | 30 | 1–100 |
  | `expiresDays` | 7 | 1–30, typed `<n>d` on the CLI |

- **Fixed numbers:** a target is fresh for 15 minutes; `threads-i-am-in` looks back 14 days; a big room has 50 or more
  members; a child send is usable for `APPROVAL_LIFETIMES.standingChild = 120_000` ms.
- **Records:**
  - **A standing record:** kind `standing`, channel `slack`, route `confirm`, `requiredPolicy` `confirm`,
    `pendingMs = APPROVAL_LIFETIMES.confirm`, `approvedMs = expiresDays × 86_400_000`. It binds `sendEpoch` and
    `standingEpoch`, and is approved only with `approvedVia: 'terminal'`.
  - **A child:** kind `send`, route `standing`, created `approved` with `approvedVia: 'standing'`. It binds
    `standingId`, `standingEpoch` and `sendEpoch`.
- **Epochs:**
  - `config.standingEpoch` is raised by one by `standing off`, and by any write that turns the default, an inbox's or an
    account's effective change policy from `chat` to `confirm`. It is never lowered.
  - `never` already raises `sendEpochs[account]`.
- **Errors**, both exit `EXIT_CODES.APPROVAL` (10), not retryable, each with a row in every table that lists codes,
  including the exit-code table in `docs/superpowers/specs/2026-09-18-agent-communications-design.md`:
  - `STANDING_REFUSED`, summary `this standing approval does not cover this act`. It has `details.reason`, one of the
    tokens in Task 1, and its message is `nothing was sent: <why>`.
  - `STANDING_LIMIT`, summary `a standing approval's limit is reached`. It has `details.limit` (`perThread`, `perHour`
    or `perDay`), `details.allowed` and `details.freesAt` (an ISO time, or `null` for `perThread`).
  - The hint of each names the located `standing list` command and says to ask the person instead. It never names a
    command that widens.
- **Copy the spec pins, exactly:**
  - a preview prepared by an agent opens with `An agent proposed these contents and places. Check each one.`;
  - the warning for a reaction in `READS_AS_APPROVAL` is `:<name>: can read as approval: people read ✅ on "can I
    deploy?" as a yes, and a Slack workflow can start on a reaction.`
- **CLI:**
  - `agent-slack standing add --workspace <name> [--reactions <name,…>] [--replies-file <file>]
    --places threads-i-am-in|<id,…> [--per-thread <n>] [--per-hour <n>] [--per-day <n>] [--expires <n>d]
    [--replaces <id>]`. The replies file holds one text per line, and blank lines are skipped.
  - `agent-slack ack --workspace <name> --standing <id> --channel <id> --ts <ts> --content <digest>`;
  - `agentcomms standing list`;
  - `agentcomms standing narrow <id> [--keep <digest,…>] [--places <id,…>] [--per-thread <n>] [--per-hour <n>]
    [--per-day <n>] [--expires <n>d]`;
  - `agentcomms standing revoke <id>`;
  - `agentcomms standing off`.
- **MCP:**
  - `slack_standing_add` takes the add's options, with `places: 'threads-i-am-in' | string[]` and `expiresDays`. It has
    no `approvalId`: it only prepares.
  - `slack_ack` takes `workspace`, `standingId`, `channel`, `ts` and `content`. It has no `draftId` and no `remove`.
  - `comms_standing` takes at most one of `narrow`, `revoke` or `off`. With none, it only reports.
- **Never:**
  - a real Slack call: every test uses `packages/slack/test/support/fake-slack.ts`, and its `world`;
  - a real OS notification: tests inject the runner;
  - a new send path;
  - a suite binary named in a runtime string (the `printed-command-construction` guard): commands come from `handoffs`;
  - account names not looked up through core's `lookupName`/`resolveName`;
  - absolute machine paths in any file;
  - a POSIX-only test assumption: a forced platform never gets `process.execPath`;
  - a command or tool without its row in `capabilities.json`.
- **Version:** 0.23.0, minor.

## Review Focus

1. **Another agent's bot whose message carries a `U…` user and a `bot_profile`.** Acknowledging it starts a loop. Task
   8, test `a U user with a bot_profile is not human`.
2. **Under `threads-i-am-in`, a thread where the person's only message is one this product sent as them, labelled.**
   That message is in the audit, not in the app-posts record. Task 8, test `a thread whose only message from the person
   this product sent does not count`.
3. **Two server processes acknowledging one thread at once, under two standing approvals.** Task 5, test `two
   concurrent uses cannot acknowledge one thread under two approvals`.
4. **An exactly named channel shared with another organisation since its approval.** `is_pending_ext_shared` turns
   true, while an Enterprise Grid's `is_org_shared` alone must still pass. Task 8, test `a pending external share since
   creation refuses; is_org_shared alone does not`.
5. **A reply replaced with one outside the old set,** such as "Got it" with "Approved, go ahead", through `--replaces`.
   Task 1, test `replacing a text with one outside the old set widens`, and Task 7, test `--replaces with a new text asks
   for a code`.

---

## Phase 1: the core model. One worker, in order: Tasks 1, 2, 3, 4, 5

### Task 1: Contents, places, limits, and what widens

**Files:**
- Create: `packages/core/src/standing.ts`, `packages/core/src/standing-emoji.ts`
- Modify:
  - `packages/core/src/errors.ts`: `STANDING_REFUSED` and `STANDING_LIMIT`, with every code table;
  - `packages/core/src/index.ts`, to export them.
- Test: `packages/core/test/standing-model.test.ts`

**Interfaces:**
- Consumes: `sha256Hex`, `canonicalJson` (`digest.ts`); `CommsError` (`errors.ts`).
- Produces:
  ```ts
  export const STANDING_ACTS: readonly ['reaction', 'reply'];
  export type StandingAct = (typeof STANDING_ACTS)[number];
  export interface StandingContent { kind: StandingAct; text: string; digest: string }
  /** `externalMembers` is null when the place has 50 or more members, which are not read one by one. */
  export interface SharedState { extShared: boolean; pendingExtShared: boolean; externalMembers: boolean | null }
  export interface ExactPlace { id: string; name: string | null; members: number; shared: SharedState }
  export type StandingPlaces = { kind: 'exact'; places: ExactPlace[] } | { kind: 'threads-i-am-in' };
  export interface StandingLimits { perThread: number; perHour: number; perDay: number; expiresDays: number }
  export interface StandingBinding {
    summary: string;                                   // shown; not in the digest
    target: { kind: 'account'; name: string; id: string };
    contents: StandingContent[];                       // reactions first, then replies, as written
    places: StandingPlaces;
    limits: StandingLimits;
    proposedBy: 'agent' | 'person';
    replaces?: string | undefined;                     // the standing id this widens
    warnings: string[];
  }
  export interface StandingNarrowing { keep?: string[]; places?: string[]; limits?: Partial<StandingLimits> }
  export type StandingRefusal = 'not-fresh' | 'not-newest' | 'already-acknowledged' | 'not-human' | 'interactive'
    | 'place-not-covered' | 'big-room' | 'count-unreadable' | 'external' | 'shared-state-changed'
    | 'reaction-as-person' | 'content-not-held' | 'clock-behind' | 'unreadable';
  export function checkedContents(input: { reactions?: string[]; replies?: string[] }):
    { contents: StandingContent[]; warnings: string[] };            // BAD_DATA, details.reason, on any refusal
  export function checkedLimits(input: Partial<StandingLimits>): StandingLimits;          // BAD_DATA outside the table
  export function parseExpiry(text: string): number;                // '7d' → 7; USAGE otherwise
  export function standingDigest(binding: StandingBinding): string; // everything but summary
  export function effectiveStanding(binding: StandingBinding, narrowed?: StandingNarrowing): StandingBinding;
  export function classifyStandingChange(before: StandingBinding, after: StandingBinding): 'same' | 'narrows' | 'widens';
  export function standingRefused(reason: StandingRefusal, hint: string): CommsError;
  export function standingLimitReached(limit: 'perThread' | 'perHour' | 'perDay', allowed: number,
    freesAt: string | null, hint: string): CommsError;
  ```
- **`<why>` for each refusal reason,** which `standingRefused` writes after `nothing was sent: `:
  - `not-fresh`: `the message is older than 15 minutes, or than this standing approval`;
  - `not-newest`: `the message is not the newest from someone else in its thread or channel`;
  - `already-acknowledged`: `this message or thread was already acknowledged under a standing approval`;
  - `not-human`: `the message, or its thread's first message, is not from a person`;
  - `interactive`: `the message has buttons or menus, or came from a workflow`;
  - `place-not-covered`: `this standing approval does not cover this place`;
  - `big-room`: `this place has 50 or more members, and was not approved with that count`;
  - `count-unreadable`: `how many people are in this place could not be read`;
  - `external`: `someone from another organisation is in this place`;
  - `shared-state-changed`: `who shares this place changed since it was approved`;
  - `reaction-as-person`: `a standing reaction goes only as the agent app, and here it would go as you`;
  - `content-not-held`: `this standing approval holds no such content`;
  - `clock-behind`: `the clock is earlier than this account's last standing act`;
  - `unreadable`: `the message or its thread could not be read`.
- **Widening (S8)** is a content digest or a place not in `before`, a swap between exact places and `threads-i-am-in`
  either way, any higher limit, or a later expiry. Anything else that differs narrows.

- [ ] **Step 1: Write the failing tests:**
  - refused, each with its `details.reason`: a text with `{name}`, a link, `<@U1>`, `@here`, `*bold*`, a 201-character
    text, 6 reactions, 6 replies, a custom emoji `partyparrot`;
  - `no contents given holds eyes alone`;
  - `an emoji that reads as approval is warned for`, using the exact copy;
  - `a digest covers kind and text`: `reaction eyes` and `reply eyes` differ, and reordering contents keeps each digest;
  - `limits outside the table are refused`, and `parseExpiry('31d')` is USAGE;
  - `the standing digest ignores the summary and changes with anything else`;
  - `replacing a text with one outside the old set widens`;
  - `a subset of contents and places with lower limits narrows`;
  - `exact places replaced by threads-i-am-in widens`;
  - `effectiveStanding keeps only the kept digests and the lower limits`;
  - the two errors' code, exit 10, message, and `details` fields.
- [ ] **Step 2:** run `pnpm --filter @agentcomms/core exec node --experimental-strip-types --test
  test/standing-model.test.ts`. Expected: FAIL, because the module doesn't exist.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4:** run it again. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): standing approvals' contents, places and limits, named by digest, and what widens them`.

### Task 2: The standing epoch

**Files:**
- Modify:
  - `packages/core/src/config.ts`:
    - `standingEpoch?: number` in `Version3Fields` and `v3Shape` (`z.number().int().min(0).optional()`);
    - `standingEpochOf(config): number`;
    - `withStandingEpoch(before, after)`, applied in `ConfigStore.update` beside `withSendEpochs`;
  - `packages/core/src/approval-outcome.ts`: `LiveGate.standingEpoch`, which `liveGateOf` sets for every record.
- Create: `raiseStandingEpoch(core: Core): Promise<number>` in `packages/core/src/standing.ts`.
- Test: `packages/core/test/standing-epoch.test.ts`

**Interfaces:**
- Produces: `standingEpochOf`, `raiseStandingEpoch`, `LiveGate.standingEpoch?: number`.

- [ ] **Step 1: Write the failing tests:**
  - `tightening the default change policy raises the standing epoch`;
  - `tightening one account's change policy raises it`;
  - `loosening a change policy raises nothing`;
  - `a write carrying a lower epoch keeps the higher one`;
  - `raiseStandingEpoch adds one`, and `classifyChange` reports no loosening for it;
  - `a config with standingEpoch parses and survives a write that doesn't name it`.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run it, plus the core `config` and `send-epoch` tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): a standing epoch that standing off and any tighter change policy raise`.

### Task 3: The `standing` record and its one-shot children

**Files:**
- Modify:
  - `packages/core/src/approvals.ts`:
    - `ApprovalKind` gains `'standing'`;
    - `ApprovalRecord` gains `standing?`, `narrowed?`, `standingEpoch?` and `standingId?`;
    - `approvedVia` becomes `ApprovalChannel | 'standing'`;
    - add the four store methods below;
    - `approve(..., 'standing')` voids any `via` but `'terminal'`, as a change does (~1394), and `issueChallenge`
      accepts the kind.
  - `packages/core/src/approval-binding.ts`:
    - `ApprovalRoute` gains `'standing'`, and `APPROVAL_LIFETIMES` gains `standingChild: 120_000`;
    - `pendingMsOf('standing')` is `standingChild`;
    - `BindingFields` and `identityOf` carry `standingEpoch` and `standingId` only when present, so every other
      record's digest is unchanged. `identityOf` carries `sendEpoch` for a `standing` record as it does for a send,
      and `checkIdentity` requires both epochs there as whole numbers of 0 or more.
  - `packages/core/src/approval-validate.ts`, for the two lifetime profiles:
    - **standing:** states `pending`, `approved`, `expired` or `revoked`. `approvedMs` is a whole number of days, 1 to
      30, equal to `standing.limits.expiresDays`. `contentDigest` is `standingDigest(standing)`. `narrowed` is a subset
      (`classifyStandingChange` is not `widens`). `approvedVia` is `'terminal'` only.
    - **child:** route `standing` only on a send. `pendingMs` and `approvedMs` are `standingChild`. It is never
      `pending`. `approvedAt` equals `createdAt`. `approvedVia` is `'standing'` and `standingId` is present; neither
      appears on any other record.
  - `packages/core/src/approval-stored.ts`, for the shape of `standing`, `narrowed`, `standingEpoch` and `standingId`.
  - `packages/core/src/approval-outcome.ts`:
    - a `standing` record, or a `standing`-route child, is revoked as a send is: owner removed, `never`, or a stale
      `sendEpoch`;
    - it is also revoked by a `standingEpoch` behind the live one, with reason `standing approvals were ended since
      this was approved`;
    - `isClaimable('standing')` is false, since a standing record is never claimed;
    - `approvalNotFound` and `refusalOf` have words for the kind.
- Test: `packages/core/test/standing-records.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  ```ts
  createStanding(input: { binding: StandingBinding; inboxSub: string; sendEpoch: number; standingEpoch: number }):
    Promise<ApprovalRecord>;                              // pending, route confirm, whatever the change policy
  withStanding<T>(standingId: string, owner: string,
    use: (record: ApprovalRecord, outcome: ApprovalOutcome) => Promise<T>): Promise<T>;  // under the record's lock
  createStandingChild(input: { standingId: string; standingEpoch: number; inboxId: string; inboxSub: string;
    draftId: string; draftMessageId: string; contentDigest: string; sendEpoch: number; riskFlags: string[];
    expect: Expectation }): Promise<ApprovalRecord>;     // approved, single use, standingChild lifetime
  narrowStanding(standingId: string, owner: string, narrowing: StandingNarrowing): Promise<ApprovalRecord>;
  ```
  `narrowStanding` refuses with USAGE anything that `classifyStandingChange` calls `widens`.

- [ ] **Step 1: Write the failing tests:**
  - `a standing record is confirm under a chat change policy`;
  - `approved with elicitation it is void`, and `approved at the terminal it lasts its days`;
  - `a 30-day standing record passes validation, and one with any other lifetime fails it`;
  - `ensurePruned keeps an approved standing record for its 30 days, then 90 more`;
  - `a child is approved at creation, claims once, and a second claim is APPROVAL_VOID`;
  - `a child claims under a confirm send policy with no code`;
  - `a raised standing epoch revokes the standing record and its unclaimed child`;
  - `never revokes it, and loosening again revives nothing`;
  - `removing the account revokes it`;
  - `narrowStanding applies at once, and refuses a widening`;
  - `every existing record digests as before`, with fixtures from `approval-binding.test.ts`.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run it, plus every core `approval*` test. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): a standing approval is a record of its own, approved only at a terminal, and each use a one-shot child`.

### Task 4: Preparing, previewing and approving at a terminal

**Files:**
- Create: `packages/core/src/standing-flow.ts`
- Modify: `packages/core/src/cli.ts`. In the `approve` case, a record of kind `standing` goes to
  `approveStandingAtTerminal`; a `change` keeps `approveChangeAtTerminal`.
- Test: `packages/core/test/standing-flow.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3; `refuseUnlessPerson`, `approveAndWaitSentence`, `requireHandoffs`. It audits with
  `core.audit.append`, as operations `standing.prepare`, `standing.approve` and `standing.end`: `auditChange` is private
  to `changes.ts`.
- Produces:
  ```ts
  export interface StandingRequest {
    account: string; accountId: string; inboxSub: string;
    contents: { reactions?: string[]; replies?: string[] };
    places: StandingPlaces; limits: Partial<StandingLimits>; replaces?: string | undefined;
  }
  export interface PreparedStanding { approvalId: string; summary: string; preview: string; expiresAt: string;
    next: string; approval: ApprovalObject; warnings: string[] }
  export async function prepareStanding(core: Core, request: StandingRequest,
    options: { surface: 'cli' | 'mcp'; proposedBy: 'agent' | 'person'; platform?: NodeJS.Platform }):
    Promise<{ status: 'narrowed'; record: ApprovalRecord } | { status: 'approval-required'; prepared: PreparedStanding }>;
  export function renderStandingPreview(record: ApprovalRecord): string;   // believed only once the digest reproduces
  export async function approveStandingAtTerminal(core: Core, approvalId: string, env: NodeJS.ProcessEnv,
    output: { json?: boolean; color: boolean; platform?: NodeJS.Platform }, streams?: Streams):
    Promise<{ approvalId: string; state: 'approved' | 'cancelled' }>;
  export async function endStanding(core: Core, standingId: string, reason: string): Promise<ApprovalRecord>;
  ```
- **Behaviour:** a `replaces` whose result `narrows` is applied at once with `narrowStanding`, and nothing is
  prepared. Approving a record that `replaces` another ends that one. `endStanding` revokes the record and every
  `approved` child whose `standingId` is it.
- **The preview, in order:**
  1. the agent line, when `proposedBy` is `agent`;
  2. `Standing approval for <workspace>: your agent may acknowledge, without asking, a message that has just arrived
     from another person.`;
  3. each content in full, with its whole digest, then its warnings;
  4. each place as `#<name> (<id>): <n> members, <shared or not shared with another organisation>`, or
     `threads-i-am-in: threads in <workspace> where you posted yourself in the last 14 days`;
  5. `Limits: <a> per thread, <b> an hour, <c> a day; it ends <d> days after you approve it.`;
  6. `Replaces <id>: approving this ends it.`, when it replaces one.

  Names are neutralised and cut with `truncateDisplay`.

- [ ] **Step 1: Write the failing tests:**
  - `under the chat change policy, a typed yes does not approve it`: the streams answer `yes`, and the challenge fails;
  - `an add cannot be completed by a client's form`, because `approve` with `elicitation` voids it;
  - `nothing answered or said in a chat applies it`: `claimForChange` on a standing id is NOT_FOUND, and the record
    stays pending;
  - `only approve <id>, with its code, completes it`, through `agentcomms approve` with terminal streams;
  - `an agent is refused approve`, with its marker set;
  - `a preview proposed by an agent opens with the agent line`;
  - `the preview shows each content, digest, warning, place, count, sharing, limit and expiry`;
  - `a narrowing replaces applies at once; a widening one prepares`;
  - `approving a replacement ends the one it replaces`;
  - `a pending standing record is reported by comms_approval_wait`.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run it, plus `change-flow` and `cli` tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): a standing approval is shown in full and approved only with the code at a terminal`.

### Task 5: The acknowledgement ledger and the mint

**Files:**
- Create: `packages/core/src/standing-ledger.ts`, `packages/core/src/standing-use.ts`
- Modify: `packages/core/src/core.ts`. `Core` gains `acks: AckLedger`, opened in `openCore`.
- Test: `packages/core/test/standing-use.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4; `withFileLock`, `appendPrivateLine`.
- Produces:
  ```ts
  export interface AckUse { kind: 'use'; at: string; standingId: string; childId: string; act: StandingAct;
    contentDigest: string; channel: string; ts: string; thread: string; targetDigest: string; edited: boolean }
  export interface AckOutcome { kind: 'outcome'; at: string; childId: string;
    outcome: 'sent' | 'failed' | 'unknown'; link?: string; notice: string }
  export class AckLedger {                    // <state>/standing/<accountId>.jsonl, locked at <path>.lock
    constructor(stateDir: string, now?: () => Date);
    /** `append` writes under the lock already held; never take the lock again inside `fn`. */
    withLock<T>(accountId: string, fn: (entries: (AckUse | AckOutcome)[],
      append: (entry: AckUse) => Promise<void>) => Promise<T>): Promise<T>;
    recordOutcome(accountId: string, entry: AckOutcome): Promise<void>;   // takes the lock itself
    entries(accountId: string): Promise<(AckUse | AckOutcome)[]>;
  }
  export interface StandingUseRequest {
    standingId: string; accountId: string; inboxSub: string; act: StandingAct; contentDigest: string;
    target: { channel: string; ts: string; thread: string; textDigest: string; edited: boolean };
    child: { draftId: string; draftMessageId: string; contentDigest: string; expect: Expectation; riskFlags: string[] };
  }
  export async function mintStandingUse(core: Core, request: StandingUseRequest):
    Promise<{ child: ApprovalRecord; standing: ApprovalRecord; content: StandingContent }>;
  export interface Notice { title: string; body: string }
  export type Notifier = (notice: Notice) => Promise<{ raised: true } | { raised: false; reason: string }>;
  ```
- **`mintStandingUse`, in order,** under `acks.withLock(accountId)`, then `approvals.withStanding(standingId)`:
  1. the outcome's error (revoked, expired, epochs, owner, `never`);
  2. APPROVAL_PENDING when it isn't approved yet;
  3. the narrowed expiry;
  4. the content: held, and of `act`'s kind, or `content-not-held`;
  5. the clock: now earlier than the newest ledger `at` is `clock-behind`;
  6. the target: `channel:ts` already a `use` is `already-acknowledged`;
  7. `perThread`: `use` lines with this `channel:thread`, across every standing id;
  8. `perHour` and `perDay`: this standing id's `use` lines;
  9. the `use` line appended;
  10. the child minted.

  Nothing ever removes a `use` line.

- [ ] **Step 1: Write the failing tests:**
  - `each of per thread, per hour and per day is reached and refused with when it frees`;
  - `two concurrent uses cannot both take the last count`: two `mintStandingUse` calls with `Promise.all`;
  - `two concurrent uses cannot acknowledge one thread under two approvals`;
  - `a clock behind the last act refuses`;
  - `a revoked or expired approval is refused at the mint`;
  - `a content named by a digest the approval doesn't hold is refused`;
  - `an outcome line, failed or unknown, never frees a count`;
  - `the ledger path refuses an id that isn't an account id`.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): every standing act is counted once, under the account's ledger lock, and never refunded`.

---

## Phase 2: in parallel, branched from Phase 1's head. Core surfaces: Task 6. Slack, one worker in order: Tasks 7, 8. Notifications: Task 9

### Task 6: Core surfaces: list, narrow, revoke, off, doctor

**Files:**
- Create: `packages/core/src/operations/standing.ts`
- Modify:
  - `packages/core/src/cli.ts`, for `standing list|narrow|revoke|off`, with their options refused on every other
    command, as `label`'s are;
  - `packages/core/src/mcp/server.ts`, for `comms_standing`;
  - `packages/core/src/operations/maintenance.ts`: a `standing approvals` check, ok, listing each active one, its
    workspace and its expiry, or `none`;
  - `capabilities.json`: rows `core.standing.list`, `core.standing.narrow`, `core.standing.revoke` and
    `core.standing.off`, the last three with `args` and `expect` as `core.label.*` have them;
  - `docs/reference/cli.md` and `docs/reference/core-mcp-tools.md`, regenerated.
- Test: `packages/core/test/standing-operation.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Produces:
  ```ts
  export interface StandingView { id: string; workspace: string; state: 'pending' | 'active' | 'ended';
    contents: StandingContent[]; places: StandingPlaces; limits: StandingLimits; expiresAt: string | null;
    usesToday: number; lastActs: { at: string; act: StandingAct; contentDigest: string; channel: string; ts: string;
      outcome: AckOutcome['outcome'] | 'pending'; link?: string }[] }      // at most 10, newest first
  export async function standingReport(core: Core): Promise<{ approvals: StandingView[] }>;
  export type StandingChangeRequest =
    | { narrow: { id: string } & StandingNarrowing } | { revoke: { id: string } } | { off: true };
  export async function standingChange(core: Core, request: StandingChangeRequest): Promise<{ approvals: StandingView[] }>;
  ```
  Each change applies at once, with no approval. `off` calls `raiseStandingEpoch`. `revoke` calls `endStanding`.

- [ ] **Step 1: Write the failing tests:**
  - `the report on an empty store`;
  - `the report shows uses today and the last 10 acts with links`;
  - `revoke ends it at once, even after the agent picked it`;
  - `off ends every one, and loosening the change policy revives none`;
  - `narrow applies at once; a narrow that widens is USAGE, naming agent-slack standing add --replaces`;
  - `comms_standing with no change only reports and refuses an approvalId`;
  - `the CLI and MCP give the same result`, following the `label` parity tests;
  - `doctor lists active standing approvals and when they expire`.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement. Run the reference generator.
- [ ] **Step 4:** run the tests, plus `pnpm verify:parity --strict`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): agentcomms standing and comms_standing list, narrow and end standing approvals`.

### Task 7: Slack creates one

**Files:**
- Create: `packages/slack/src/operations/standing.ts`, `packages/slack/src/operations/places.ts`
- Modify:
  - `packages/slack/src/operations/people.ts`:
    - `Channel` gains `isExtShared`, `isPendingExtShared` and `isOrgShared`; `isShared` stays as it is;
    - `Person` gains `teamId?: string` and `isStranger: boolean`;
  - `packages/slack/src/cli/program.ts`:
    - `standing add`;
    - `approve`, which sends a `standing` record to core's `approveStandingAtTerminal`, beside its `change` branch;
  - `packages/slack/src/mcp/server.ts`, for `slack_standing_add`;
  - `packages/slack/test/support/fake-slack.ts`. The `world` gains, per room, `is_pending_ext_shared` and
    `is_org_shared`, and per user, `team_id` and `is_stranger`.
  - `capabilities.json`, row `slack.standing.add`;
  - `docs/reference/slack-cli.md` and `docs/reference/slack-mcp-tools.md`.
- Test: `packages/slack/test/standing-add.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 4; `roomOf`, `gateDepsFor`.
- Produces:
  ```ts
  // places.ts
  export interface PlaceFacts { id: string; name: string | null; isIm: boolean; isMpim: boolean;
    dmWith?: string | undefined; members: number | null; shared: SharedState }
  export async function readPlace(call: SlackCall, channelId: string, ourTeamId: string): Promise<PlaceFacts>;
  // standing.ts
  export interface StandingAddRequest { reactions?: string[]; replies?: string[];
    places: 'threads-i-am-in' | string[]; perThread?: number; perHour?: number; perDay?: number;
    expiresDays?: number; replaces?: string }
  export async function prepareStandingAdd(context: SlackContext, alias: string, request: StandingAddRequest,
    slack?: SessionDeps): ReturnType<typeof prepareStanding>;
  ```
- **`readPlace`:** `members` comes from `num_members`, else from paging `conversations.members` (10 pages at most),
  and is `null` when unreadable. `externalMembers` is read with `users.info` for every member of a place under 50: a
  `team_id` that isn't `ourTeamId`, or `is_stranger`. `is_org_shared` never counts as external.
- **`prepareStandingAdd`:** an unreadable count refuses the add, with `count-unreadable`. `proposedBy` is `person` only
  on the CLI with a person at the terminal (no agent marker, and `canPrompt`), the test `gatedChangeAtTerminal` uses.
  That person approves inline with `approveStandingAtTerminal`. Anyone else gets APPROVAL_PENDING, with the approve
  command and its wait.

- [ ] **Step 1: Write the failing tests,** using the fake world:
  - `an add prepared over MCP says an agent proposed it`, and has no `approvalId` input;
  - `the preview names each place with its member count and sharing`;
  - `a group DM's members are counted`;
  - `an unreadable count refuses the add`;
  - `is_org_shared alone is not shared with another organisation`;
  - `--replaces with a new text asks for a code`;
  - `--replaces with a subset narrows at once`;
  - `agent-slack approve completes a standing record with its code`;
  - the CLI and MCP parity test for the new row.
- [ ] **Step 2:** run `pnpm --filter @agentcomms/slack exec node --experimental-strip-types --test
  test/standing-add.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them, plus the full Slack suite. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(slack): agent-slack standing add prepares a standing approval, showing each place's members and sharing`.

### Task 8: Slack uses one: `ack`

**Files:**
- Create: `packages/slack/src/operations/ack.ts`
- Modify:
  - `packages/slack/src/operations/send.ts`. Export `reactionApprovalFields(deps, options, label): { draftId;
    draftMessageId; contentDigest; expect }`, from the private `reactionDraftId`, `reactionDigest` and
    `reactionExpectation`.
  - `packages/slack/src/context.ts`: `SlackContextOptions.notify?: Notifier`, kept as `SlackContext.notify`, which is
    `undefined` until Task 11 gives it a default.
  - `packages/slack/src/cli/program.ts`, for `ack`;
  - `packages/slack/src/mcp/server.ts`, for `slack_ack`;
  - `packages/slack/test/support/fake-slack.ts`. A `world` message gains `thread_ts`, `bot_profile`, `app_id`,
    `subtype` and `edited`. `conversations.replies` answers a thread from the world's messages, `conversations.history`
    honours `latest`, `oldest` and `inclusive`, and `chat.getPermalink` answers.
  - `capabilities.json`, row `slack.ack`;
  - `docs/reference/slack-cli.md` and `docs/reference/slack-mcp-tools.md`.
- Test: `packages/slack/test/ack.test.ts`

**Interfaces:**
- Consumes: Task 5 (`mintStandingUse`, `AckLedger`, `Notifier`); Task 7 (`readPlace`); spec 2's `allowedAct`,
  `actNotAllowed` and `check`.
- Produces:
  ```ts
  export interface AckRequest { standingId: string; channel: string; ts: string; content: string }
  export interface AckResult { act: StandingAct; standingId: string; approvalId: string; channel: string; ts: string;
    posted?: { ts?: string } | undefined; label?: LabelView | undefined; notice: string; approval: ApprovalObject }
  export async function ack(context: SlackContext, alias: string, request: AckRequest, slack?: SessionDeps):
    Promise<AckResult>;
  ```
- **What `ack` does, in order:**
  1. **Before anything is read:**
     - `never` is POLICY_NEVER;
     - a `content` that isn't 64 hex characters is USAGE, saying to name a content by its digest, as `standing list`
       shows it.
  2. **The Slack reads, with no lock (S9 step 1):**
     - **The target, by `readTarget`.** It is `conversations.replies` at `ts`, or, on `thread_not_found`,
       `conversations.history` with `latest=ts`, `inclusive` and `limit=1`.
     - **S4's allow-list,** on the target and on its thread's parent:
       - the author is human: a `user` matching `/^[UW]/`, not `USLACKBOT`, not this account, not in the app-posts
         record, and not a bot by `users.info`;
       - there is no `bot_id`, `app_id`, `bot_profile` or `subtype`;
       - there is no `actions` or `input` block, and no interactive element;
       - it is fresh;
       - it is the newest message, not this account's and not in the app-posts record, in its thread, or in its channel
         from `oldest=ts`.
     - **The place:**
       - `exact` holds its id;
       - `threads-i-am-in` needs a thread where `self` posted within 14 days. That message has no `bot_id`, is not in
         app-posts, and is not in the audit's `ok` records with that `channel` and `ts` from `core.audit.tail`.
     - **`readPlace` against what was recorded:**
       - a count of 50 or more is `big-room`, unless it was recorded at 50 or more;
       - `null` is `count-unreadable`;
       - a different `SharedState` on an exact place is `shared-state-changed`;
       - anyone external under `threads-i-am-in` is `external`.
     - **The label:** `decideLabel` with `requested: 'agent'`, which overrides a `me` rule. A reaction whose route
       isn't `app` is `reaction-as-person`.
     - **`allowedAct`,** with acts `[act]` and places `[[channel]]`, or `[[D…, U…]]` for a DM.
     - **The child's fields.**
       - For a reply, write a draft with `store.create(accountId, payloadOf(escapeForSlack(text), channel, thread),
         text)`, where `thread` is the target's `thread_ts`, or else its `ts`. Then take `view = viewPost(deps, draft,
         book, 'agent')`, and the child is `{ draftId: draft.draftId, draftMessageId: draft.revision, contentDigest:
         view.digest, expect: expectationFor(view.payload, view.preview.notifies) }`. The draft is removed whatever
         happens.
       - For a reaction, they are `reactionApprovalFields(deps, { channel, ts, name }, label)`.
       - Every child's `riskFlags` carry `AS_AGENT`, and a reaction's also carry `REACTS_AS_APP`.
  3. **`mintStandingUse`.**
  4. **The newest-message read again.** Refused now, the child is revoked and the count stays spent.
  5. **The act, through the existing path:** `postPrepared(deps, draft, childId, channel, book)` for a reply, and
     `reactPrepared(deps, childId, { channel, ts, name })` for a reaction.
  6. **After the act:**
     - an `AckOutcome` line, with `link` from `chat.getPermalink` on the target, best effort;
     - the notice, from `context.notify`: `notice` is `raised`, `failed: <reason>`, or `none` without a notifier;
     - an audit record `slack.ack`, whose `ids` are `standingId`, `childId`, `contentDigest`, `channel`, `ts`,
       `targetDigest`, `edited` and `notice`.

     None of the three ever fails the act.

- [ ] **Step 1: Write the failing tests,** using the fake world:
  - **Send policy:** `under never a standing act is refused`; `under confirm it goes with no code`; `under chat the
    standing path refuses what S4 to S6 refuse`.
  - **Refused, each with its reason:**
    - older than the approval, older than 15 minutes, or not the newest;
    - `bot_id`, `app_id`, `bot_profile`, any `subtype`, a `user` starting `B`, `users.info` saying bot, `USLACKBOT`,
      this account, or the app-posts record, on the message and on its parent;
    - a button, a select, or a workflow's message;
    - `a U user with a bot_profile is not human`;
    - `a thread already acknowledged under another standing approval`.
  - **Places:**
    - `a reply always goes in a thread`: every `chat.postMessage` the fake records carries `thread_ts`;
    - `a thread whose only message from the person this product sent does not count`;
    - a thread where the person is only mentioned, or posted more than 14 days ago, does not count;
    - a reaction outside a qualifying thread is refused;
    - 50 or more members not recorded so, an unreadable count, and an exact place grown to 50 since are each refused;
    - another `team_id`, `is_stranger` or `is_ext_shared` refuses;
    - `a pending external share since creation refuses; is_org_shared alone does not`.
  - **Identity:**
    - a reply goes as the app, or labelled, even under a `me` rule;
    - a reaction is refused in a DM, a group DM, a room the app isn't in, under `labelled` style, and with no bot token;
    - `slack_ack` with `remove` is USAGE.
  - **Spec 2:** a rule forbidding `reply` or `reaction` refuses with ACT_NOT_ALLOWED before the mint. Tightened after
    the mint, it refuses at the claim, and the fake records no `chat.postMessage` or `reactions.add`.
  - **Counting:**
    - `SEND_OUTCOME_UNKNOWN` keeps the count spent;
    - `the standing send takes no draftId`, and `a payload with & < > is escaped`;
    - `a different label gives a different digest`.
  - **Seeing it:**
    - a notifier that throws or is missing leaves the act done;
    - `the audit keeps the acknowledged text's digest and edited state`;
    - `standing list` shows the act.
- [ ] **Step 2:** run `pnpm --filter @agentcomms/slack exec node --experimental-strip-types --test test/ack.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them, plus the full Slack suite and `pnpm verify:parity --strict`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(slack): agent-slack ack and slack_ack send a pre-approved acknowledgement, as the agent, on a message that just arrived`.

### Task 9: The notification on the person's screen

**Files:**
- Create: `packages/core/src/notify.ts`
- Modify: `packages/core/src/system-programs.ts`. Add `notifierProgram(platform, env, exists): string | null`:
  - darwin is `/usr/bin/osascript`;
  - win32 is `windowsSystemProgram('WindowsPowerShell\\v1.0\\powershell.exe', env)`;
  - linux is `notify-send` in the first `absoluteSearchPath(PATH)` entry where `exists` finds it, else `null`.
- Test: `packages/core/test/notify.test.ts`

**Interfaces:**
- Consumes: `Notice` and `Notifier` (Task 5); `StandingAct` (Task 1); `childEnvironment`; `truncateDisplay`.
- Produces:
  ```ts
  export type NoticeRunner = (program: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;
  export function noticeCommand(notice: Notice, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, program: string):
    { program: string; args: string[]; env: NodeJS.ProcessEnv };
  export function makeNotifier(options: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv;
    run?: NoticeRunner; exists?: (path: string) => Promise<boolean> }): Notifier;
  export function ackNotice(input: { act: StandingAct; text: string; place: string; standingId: string }): Notice;
  ```
- **The command for each platform:**
  - **darwin:** `-e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run'
    <body> <title>`.
  - **linux:** `<title> <body>`.
  - **win32:** `-NoProfile -NonInteractive -Command <a fixed toast script>`. The script reads `AGENTCOMMS_NOTICE_TITLE`
    and `AGENTCOMMS_NOTICE_BODY` from `childEnvironment(env, 'win32')`, because `-Command` would join trailing arguments
    into the script.

  In no case is text spliced into a script.
- **The notice:** the title is `agent-communications`, and the body `Your agent sent <:name: | "text"> in <place>
  (standing approval <id>)`, with the place flattened by `truncateDisplay` to 80 characters.
- **`makeNotifier`** never throws. A missing program, or a runner that throws, gives `{ raised: false, reason }`.

- [ ] **Step 1: Write the failing tests,** each with a forced platform and an injected runner and `exists`:
  - `each platform's program and arguments`, where win32's path comes from a `SystemRoot` in the given env;
  - `the text is an argument on darwin and linux, and an environment value on win32, never in the script`, with a body
    holding `"; rm -rf ~ ; '`;
  - `no notify-send gives raised false`;
  - `a runner that throws gives raised false`;
  - `the body names what, where and which standing approval`.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement. The real runner is `execFile` with a 5-second timeout and no shell.
- [ ] **Step 4:** run. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): an OS notification for every standing act, its text never spliced into a script`.

---

## Phase 3: integration, one worker

### Task 10: Skills, docs and changelog

**Files:**
- Modify:
  - **`skills/_shared/contract-slack.md`,** then sync with the repository's sync script. It says:
    - without a standing approval that covers it, always ask;
    - with one, use `slack_ack` only on a message that has just arrived, and only with a content digest from
      `comms_standing`;
    - on STANDING_REFUSED or STANDING_LIMIT, stop and ask the person, and never retry;
    - propose `slack_standing_add` only when the person asked for it, and say they approve it at their terminal.
  - `skills/slack-posting/SKILL.md` and `skills/comms-onboarding/SKILL.md`, to the same effect.
  - **The core server's MCP `instructions`:** `comms_standing` with no change joins the read-only list. **The Slack
    server's** gains one sentence on `slack_ack`. Update any wording fixture the repository pins for either.
  - `packages/core/README.md`, `packages/slack/README.md` and `docs/getting-started.md`, each with a short "Messages
    sent without asking" section. It says what a standing approval covers, how to end every one
    (`agentcomms standing off`), and §4's "out of reach" plainly.
  - `CHANGELOG.md`, under `## Unreleased`.
- Test: the existing skill, wording and reference checks.

- [ ] **Step 1:** make the edits.
- [ ] **Step 2:** run `pnpm verify:skills && pnpm verify:reference`. Expected: PASS.
- [ ] **Step 3: Commit:** `docs: standing approvals in the skills, guides and changelog, with what they do not defend`.

### Task 11: Integrate and verify

- [ ] **Step 1:** merge the Phase 2 branches onto Phase 1's head. Resolve conflicts in `capabilities.json`, `cli.ts`,
  both `mcp/server.ts`, `index.ts` and `fake-slack.ts` by keeping every side.
- [ ] **Step 2: Wire the default notifier.** The `SlackContext` constructor sets `notify` to `options.notify ??
  makeNotifier({ platform: this.platform, env: this.env })`, as it defaults `sendPacing`. Add the test `a context made
  without notify gets the platform's notifier`, with an injected runner.
- [ ] **Step 3:** run the root suite: `node --import ./test/helpers/loopback-seal-preload.mjs --test
  "test/**/*.test.mjs"`. Expected: `# fail 0`.
- [ ] **Step 4:** run `pnpm verify` once, with nothing else running in the worktree. Expected: exit 0.
- [ ] **Step 5: Commit** any integration fixes: `chore: standing approvals integrated`.
