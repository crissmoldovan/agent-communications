# Agent Behaviour Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce, per account and per conversation, which acts an agent may do (post, reply, reaction, edit, delete,
file, send), and give every channel and conversation a writing profile the agent reads before it writes.

**Architecture:**
- **One core module.** `packages/core/src/behaviour.ts` holds the rules, the fail-closed reader, the resolver
  `allowedAct` and the classifier.
- **One core operation.** `packages/core/src/operations/behaviour.ts` drives the CLI and MCP surfaces, in parity.
- **Each channel checks twice.** Slack, Gmail and Resend call `allowedAct` at prepare and again at execute, inside
  their existing send paths.
- **Writing profiles** gain an account layer and a conversation layer in `compose-profile.ts`, read through a new
  `comms_profile`.

**Tech Stack:** TypeScript (Node 22.12+, `--experimental-strip-types`), zod 4, `node:test`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-19-agent-behaviour-rules-design.md` (B1–B9). Read it with this plan. Read
`AGENTS.md` too.

## Global Constraints

- **Acts, exactly:** `BEHAVIOUR_ACTS = ['post', 'reply', 'reaction', 'edit', 'delete', 'file', 'send']`.
- **Rule shape:** `{ account, accountId?, conversation?, acts }`, stored at the top level of `config.json` as
  `behaviour: { rules: [...] }`, beside `agentLabel`, with a loose schema.
- **The refusal:**
  - code `ACT_NOT_ALLOWED`, exit `EXIT_CODES.APPROVAL` (10, the same as `POLICY_NEVER`), not retryable;
  - message `this agent may only <acts> in <place> (<account>)`, or `this agent may do nothing in <place> (<account>)`;
  - hint naming the located `behaviour` report command, never a loosening command.
- **The preview line, exactly:**
  - `Allowed here: <acts joined by ", "> (rule: <account>[, <place>])`;
  - or `Allowed here: everything (no rule)`.
- **CLI:**
  - `behaviour`;
  - `behaviour allow <account> <act,…|none> [--conversation <id>] [--approval <id>]`;
  - `behaviour clear <account> [--conversation <id>] [--approval <id>]`;
  - `profile [<account>] [--conversation <id>…]`;
  - `profile init [<account>] [--conversation <id>]`, which is CLI-only.
- **MCP:**
  - `comms_behaviour` with `setRule` / `removeRule` / `approvalId`;
  - `comms_profile` with `account` / `conversations`, read-only.
- **Profile files** live in `<config>/compose/`:
  - `default.md`, `user.md`, `<platform>.md`;
  - `inbox-<account with / as __>.md`, for the account layer;
  - `conversation-<account with / as __>__<conversation, with characters outside [A-Za-z0-9@._-] as %XX>.md`.
- **Never:**
  - a real email, Slack post or Resend send: tests use Gmail's fake transport, `packages/slack/test/support/fake-slack.ts`
    and `packages/resend/test/support/fake-resend.ts`;
  - a new send path;
  - a suite binary named in a runtime string, or names not looked up through `lookupName`/`resolveName`;
  - absolute machine paths in any file;
  - POSIX-only test assumptions (a forced platform gets a fixed POSIX path, such as `/usr/bin/node`).
- **Version:** 0.22.0, minor.

## Review Focus

1. **A Slack DM ruled only by the person's `U…` rule** (no `D…` rule) is refused when that rule forbids the act.
   Task 6, test `a DM is ruled by the person's U rule when no D rule exists`.
2. **Mail with mixed recipients**, one allowed and one in a forbidden `@domain`, is refused whole, naming the forbidden
   recipient. Task 7, test `one forbidden recipient refuses the whole send`.
3. **A Gmail mailbox renamed after a rule was added** keeps the rule, because it binds by id. Task 2, test `a rename
   keeps the rule`.
4. **An approval prepared, then the rule tightened, then the approval claimed:** refused, and the fake provider
   receives nothing. Tasks 6, 7 and 8, each `tightened after the yes refuses at send`.
5. **Mail addresses and domains match regardless of case** (`Bob@Client.COM` against `@client.com`). Task 1, test
   `addresses and domains match regardless of case`.

---

## Phase 1: the core model. One worker, in order: Tasks 1, 2, 4

### Task 1: Rules, fail-closed reading, resolution and classification

**Files:**
- Create: `packages/core/src/behaviour.ts`
- Modify: `packages/core/src/index.ts`, to export it
- Test: `packages/core/test/behaviour-rules.test.ts`

**Interfaces:**
- Consumes: `Config` (`config.ts`); the conversation grammar the label uses (`agent-label.ts`, the `conversation` parser).
- Produces:
  ```ts
  export const BEHAVIOUR_ACTS: readonly ['post','reply','reaction','edit','delete','file','send'];
  export type BehaviourAct = (typeof BEHAVIOUR_ACTS)[number];
  export interface BehaviourRule { account: string; accountId?: string; conversation?: string; acts: BehaviourAct[] }
  export interface BehaviourSettings {
    rules: BehaviourRule[];
    /** Rules that could not be read: their account allows nothing (B3). */
    unreadable: { account: string | null; reason: string }[];
  }
  export function readBehaviourSettings(config: Config): BehaviourSettings; // never throws
  export interface RuleRef { account: string; conversation?: string }
  /** A place is one destination; its aliases (a DM's D… and the person's U…) match at the same specificity. */
  export interface ActQuery { accountId: string; account: string; places: string[][]; acts: BehaviourAct[] }
  export type ActDecision =
    | { allowed: true; rule: RuleRef | null; allowedActs: BehaviourAct[] | 'all' }
    | { allowed: false; act: BehaviourAct; place: string | null; rule: RuleRef; allowedActs: BehaviourAct[] };
  export function allowedAct(config: Config, query: ActQuery): ActDecision;
  export interface BehaviourDelta { scope: RuleRef; before: BehaviourAct[] | 'all'; after: BehaviourAct[] | 'all' }
  export function classifyBehaviourChange(before: BehaviourSettings, after: BehaviourSettings):
    { loosens: boolean; deltas: BehaviourDelta[] };
  ```

**Matching rules** (B3), which the tests pin:
- A rule matches by `accountId`. A rule whose `accountId` no connected account holds matches by `account` name. That
  needs a list of current account ids: read them from the config's inboxes and accounts.
- **Specificity:**
  - for mail, an address rule over its `@domain` rule, over the account rule;
  - for Slack, a `C…`/`G…`/`D…`/`U…` rule over the account rule;
  - among the aliases of one place at the same specificity, the intersection of their acts.
- **Every** place must allow **every** act in `acts`.
- Addresses and domains compare lower-cased.
- An unknown act in a stored rule is dropped, which narrows the rule.
- A rule that isn't an object with a string `account` and an array `acts` goes into `unreadable`. Its account, when
  named, allows nothing.

- [ ] **Step 1: Write the failing tests.** `node:test`, all in `behaviour-rules.test.ts`:
  - `no rule allows everything`: `allowedAct(...)` returns `{ allowed: true, rule: null, allowedActs: 'all' }`;
  - `the most specific rule wins: address over domain over account`;
  - `a DM's D and U rules give the narrower`: acts `['reply','reaction']` and `['reply']` give only `reply`;
  - `every place must allow every act`: two mail places, one forbidding `send`, give `allowed: false` with `place` set
    to the forbidding one;
  - `a file in a thread needs file and reply`;
  - `an empty acts list allows nothing`;
  - `an orphaned rule applies by name`;
  - `an unknown act narrows its rule`;
  - `an unreadable rule makes its account allow nothing, and others keep theirs`;
  - `addresses and domains match regardless of case`;
  - `classify: a subset tightens; adding an act, removing a rule, or a conversation wider than its account loosens`.
    It asserts `deltas` before → after.
- [ ] **Step 2:** run `pnpm --filter @agentcomms/core exec node --experimental-strip-types --test
  test/behaviour-rules.test.ts`. Expected: FAIL, because the module doesn't exist.
- [ ] **Step 3: Implement** `behaviour.ts` with the interfaces above.
- [ ] **Step 4:** run it again. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): behaviour rules — what an agent may do, per account and conversation, read fail-closed`.

### Task 2: The config knows `behaviour`, and a rename keeps it

**Files:**
- Modify: `packages/core/src/config.ts`:
  - the top-level schema gains `behaviour?: unknown`, next to `agentLabel`;
  - `classifyChange` gains a loosening for `behaviour.rules` when `classifyBehaviourChange(...).loosens` is true;
  - the loosening text uses each delta as `<account>[ <place>]: <before> → <after>`, with "everything" for `'all'`;
  - `changedSettings` records `behaviour.rules`.
- Modify: `packages/core/src/names.ts` (`renameEntry`) **only if** a rule stores the name in a way a rename must
  rewrite. The display `account` updates; `accountId` already binds.
- Test: `packages/core/test/behaviour-config.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `classifyChange` reports `behaviour.rules` loosenings; `changedSettings` lists `behaviour.rules`.

- [ ] **Step 1: Write the failing tests:**
  - `a loosened behaviour rule is a loosening classifyChange reports`;
  - `a tightened rule is not`;
  - `a rename keeps the rule`: add a rule for `acme/gmail`, rename the mailbox through the rename operation, and
    `allowedAct` still refuses;
  - `older releases' loose schema keeps behaviour through a write`.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run it, plus the core suite's `agent-label-config` and `names` tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): the configuration keeps behaviour rules, and loosening one is a change to approve`.

### Task 4: The refusal and the preview line

**Files:**
- Modify: `packages/core/src/errors.ts`. Add `ACT_NOT_ALLOWED`: `{ exit: EXIT_CODES.APPROVAL, retryable: false,
  summary: 'a behaviour rule does not allow this act here' }`. Add a row for it to every table that lists codes,
  including the exit-code table in `docs/superpowers/specs/2026-09-18-agent-communications-design.md`.
- Modify: `packages/core/src/behaviour.ts`
- Test: `packages/core/test/behaviour-refusal.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function actNotAllowed(decision: Extract<ActDecision, { allowed: false }>,
    shown: { account: string; place: string | null }, hint: string): CommsError;
  export function allowedHereLine(decision: ActDecision, shown: { account: string; place: string | null }): string;
  ```

- [ ] **Step 1: Write the failing tests:**
  - the exact message text in both forms;
  - the hint passed through;
  - exit 10;
  - `allowedHereLine` in both forms (copy from the Global Constraints);
  - shown names neutralised and flattened.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): ACT_NOT_ALLOWED, and the line every preview carries about what is allowed`.

---

## Phase 2: in parallel, one worker each, all branched from Phase 1's head: Tasks 3, 5, 6, 7, 8

### Task 3: Core surfaces: report, change, doctor

**Files:**
- Create: `packages/core/src/operations/behaviour.ts`, mirroring `operations/label.ts`'s `labelReport`/`labelChange`.
- Modify:
  - `packages/core/src/cli.ts`, for the `behaviour` commands;
  - `packages/core/src/mcp/server.ts`, for `comms_behaviour`;
  - `capabilities.json`, rows `core.behaviour`, `core.behaviour.allow` and `core.behaviour.clear`;
  - the core doctor (`operations/maintenance.ts` or wherever its checks live), for three rows: unreadable rules, orphaned
    rules, and registered servers below 0.22.0 while any rule exists;
  - `docs/reference/core-mcp-tools.md`, regenerated.
- Test: `packages/core/test/behaviour-operation.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 4.
- Produces:
  ```ts
  export async function behaviourReport(core: Core): Promise<BehaviourReport>;
  export type BehaviourChangeRequest =
    | { setRule: { account: string; conversation?: string; acts: BehaviourAct[] } }
    | { removeRule: { account: string; conversation?: string } };
  export function behaviourChange(core: Core, request: BehaviourChangeRequest /* , options as labelChange */): ...;
  ```

**Report shape:**
`{ rules: { account, conversation?, acts, orphan: boolean }[], unreadable, accounts: { account, allowed: BehaviourAct[] | 'all', conversations: { conversation, allowed }[] }[] }`.

**The first rule ever added** reports in its result: `servers started before 0.22.0 do not enforce this until their
client restarts them`.

- [ ] **Step 1: Write the failing tests:**
  - the report on an empty config;
  - `setRule` that tightens applies at once with no approval;
  - `setRule` that loosens returns `approval-required`, with a preview listing before → after, and applies on the claim;
  - `removeRule` loosens;
  - a terminal approval says "typed here, at this terminal";
  - the CLI and MCP give the same result (follow the `label` parity tests);
  - doctor's three rows.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement. Run `pnpm verify:parity --strict` and the reference generator.
- [ ] **Step 4:** run the tests, plus `pnpm verify:parity --strict`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): agentcomms behaviour and comms_behaviour report and change what an agent may do`.

### Task 5: Writing profiles for every channel and conversation

**Files:**
- Modify: `packages/core/src/compose-profile.ts`:
  - `PROFILE_LAYERS = ['default','user','platform','account','conversation']`;
  - `ProfileOptions` gains `account?` (with `inbox` kept as an alias that Gmail's callers still pass) and
    `conversations?: string[]`;
  - export `conversationProfileFile(account: string, conversation: string): string`;
  - the starter text for `profile init`, with five headings: Tone, Language, Length, Sign-off and Threads. Each has one
    example line, and Threads says "Reply in the thread; start a new message only when asked.".
- Create: `packages/core/src/operations/profile.ts`:
  - `profileView(core, { account?, conversations? })` returns `{ text, sections, candidates }`;
  - `profileInit(core, { account?, conversation? })` returns `{ path, created: boolean }` and never overwrites.
- Modify:
  - `cli.ts`, for `profile` and `profile init`;
  - `mcp/server.ts`, for `comms_profile`, read-only, with no `init`;
  - `capabilities.json`: `core.profile` on both surfaces, and `core.profile.init` CLI-only, written the way other
    person-only commands are (search for an existing CLI-only row and copy its form).
- Test: `packages/core/test/compose-profile-layers.test.ts`, `packages/core/test/profile-operation.test.ts`

**For mail,** a caller passes each recipient's address followed by its `@domain`, in recipient order. For a Slack DM,
it passes the `D…` id, then the `U…` id.

- [ ] **Step 1: Write the failing tests:**
  - the five layers in order;
  - an old `inbox-acme__gmail.md` still read as the account layer;
  - `conversationProfileFile('acme/slack','C01')` is `conversation-acme__slack__C01.md`;
  - an address with `+` is encoded as `%2B`;
  - several conversation files are joined, each marked with its source;
  - `profileInit` creates the starter and refuses to overwrite;
  - `comms_profile` has no `init` and writes nothing;
  - Gmail's `draft_create` `includeProfile` is unchanged (the existing tests pass).
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them, plus Gmail's draft tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): writing profiles for every channel and conversation, read with comms_profile before writing`.

### Task 6: Slack checks every act

**Files:**
- Modify:
  - `packages/slack/src/operations/send.ts`: `preparePost` and `prepareReaction` check at prepare; `claimOrHandOver`
    gains a `check: { acts: BehaviourAct[]; places: string[][] }` parameter and runs `allowedAct` on a fresh config
    before claiming. Every caller passes it: `postPrepared`, `reactPrepared`, and in `amend.ts` `editPrepared` and
    `deletePrepared`;
  - `amend.ts`: `prepareMessageEdit` (`edit`, plus `file` when files are added) and `prepareDeletion` (`delete`);
  - the preview renderers (`viewPost`, `viewEdit`, `viewDeletion`, the reaction preview), to add the `Allowed here:`
    line.
- Test: `packages/slack/test/behaviour-rules.test.ts`

**Acts and places:**
- **Acts:** `thread_ts` gives `reply`, otherwise `post`; any file adds `file`.
- **Places:**
  - for a channel, `[[channelId]]`;
  - for a DM, `[[dmChannelId, counterpartUserId]]`. Use what `roomOf` already resolves.
- **Account:** the workspace's `accountId` and alias.
- **The acts and places are bound** into the prepared approval, so execute re-checks exactly what was approved.

- [ ] **Step 1: Write the failing tests,** using the loopback fake:
  - each of post, reply, file-in-thread, top-level file, reaction, edit, edit-adding-files and delete refused at
    prepare under a rule that forbids it, with no approval created;
  - `a DM is ruled by the person's U rule when no D rule exists`;
  - `tightened after the yes refuses at send`, where the fake receives no `chat.postMessage`, `reactions.add`,
    `chat.update` or `chat.delete`;
  - every preview carries the `Allowed here:` line.
- [ ] **Step 2:** run `pnpm --filter @agentcomms/slack exec node --experimental-strip-types --test
  test/behaviour-rules.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them, plus the full Slack suite. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(slack): every post, reply, file, reaction, edit and deletion is checked against the behaviour rules, at prepare and at send`.

### Task 7: Gmail proves a reply and checks every recipient

**Files:**
- Modify: `packages/gmail/src/operations/send.ts`:
  - `prepareSend` decides the act. It is `reply` only when `In-Reply-To` names a message found in this mailbox (one
    Gmail search, `rfc822msgid:<id>`, through the existing transport). Otherwise it is `send`.
  - It binds `{ act, places }` into the approval. The places are every To, Cc and Bcc recipient, each as `[[address]]`
    lower-cased.
  - It checks with `allowedAct`.
  - `executeSend` re-checks the bound act and places on a fresh config before it sends.
  - The preview gains the `Allowed here:` line.
- Leave `domain/agent-label.ts` `mailKind` as it is: the label is out of scope.
- Test: `packages/gmail/test/behaviour-rules.test.ts`

- [ ] **Step 1: Write the failing tests,** using the fake transport:
  - `a reply needs In-Reply-To to a message in the mailbox`, where an unknown id is `send`;
  - `a forward is send`;
  - `one forbidden recipient refuses the whole send`, naming it;
  - `tightened after the yes refuses at send`, where the fake records no send call;
  - `gmail_draft_send` refuses the same way;
  - the preview carries the line.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them, plus the full Gmail suite. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(gmail): a send is checked against the behaviour rules for every recipient, and a reply is proven from the mailbox`.

### Task 8: Resend checks every recipient

**Files:**
- Modify: `packages/resend/src/operations/send.ts`. `prepareSend` (act `send`, places as every recipient) checks and
  binds. `executeSend` re-checks. The preview gains the line.
- Test: `packages/resend/test/behaviour-rules.test.ts`

- [ ] **Step 1: Write the failing tests,** using the loopback fake:
  - refused at prepare, with no approval;
  - `tightened after the yes refuses at send`, where the fake records no `POST /emails`;
  - the preview line.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them, plus the full Resend suite. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(resend): a send is checked against the behaviour rules for every recipient`.

---

## Phase 3: integration, one worker

### Task 9: Skills, docs and changelog

**Files:**
- Modify:
  - `skills/_shared/contract-*.md`, then sync with the repository's sync script;
  - `skills/slack-posting/SKILL.md`, `skills/gmail-send/SKILL.md`, `skills/gmail-compose/SKILL.md`,
    `skills/resend-sending/SKILL.md` and `skills/comms-onboarding/SKILL.md`. Each says: call `comms_profile` for the
    account and conversation before writing, and follow it; on `ACT_NOT_ALLOWED`, tell the person which rule refused
    and stop; never retry, and never start a loosening the person didn't ask for;
  - the core server's MCP `instructions`, adding `comms_behaviour` and `comms_profile` to the read-only list, with any
    wording fixture the repository pins for it;
  - `packages/core/README.md` and `docs/getting-started.md`, each with a short "What an agent may do, and how it writes"
    section;
  - `CHANGELOG.md`, under `## Unreleased`.
- Test: the existing skill, wording and reference checks.

- [ ] **Step 1:** make the edits.
- [ ] **Step 2:** run `pnpm verify:skills && pnpm verify:reference`. Expected: PASS.
- [ ] **Step 3: Commit:** `docs: what an agent may do and how it writes, in the skills, guides and changelog`.

### Task 10: Integrate and verify

- [ ] **Step 1:** merge the Phase 2 branches onto Phase 1's head, resolving conflicts in `capabilities.json`,
  `cli.ts`, `mcp/server.ts` and `index.ts` by keeping every side.
- [ ] **Step 2:** run the root suite: `node --import ./test/helpers/loopback-seal-preload.mjs --test
  "test/**/*.test.mjs"`. Expected: `# fail 0`.
- [ ] **Step 3:** run `pnpm verify` once, with nothing else running in the worktree. Expected: exit 0.
- [ ] **Step 4: Commit** any integration fixes: `chore: behaviour rules integrated`.
