# Workflows (0.36.0): one list of workflows that branch, wait, finish the job and tell others

Date: 2026-10-27. **Status: normative for 0.36.0.** The owner approved the prototype and asked for this spec and its plan
(§0). The plan is `docs/superpowers/plans/2026-10-27-workflows-0360.md`.

Grounded in a read of `feat/0.35` at 46b97348. Paths are from the repository root. The draft's reads at 0c653652 still
hold: `git diff --stat 0c653652 46b97348 -- packages/events-daemon packages/events apps/desktop` is empty. Also read:
`cueplusplus/claude-stream` at 1379b3f0 (`docs/agent-relay/api-contract.md`, 2026-10-27); cue-ui 0.34.0's Flow parts, as
installed for the app (`@cueplusplus/ui` `package.json` 87–91, 157, 188–190; `dist/flow/index.d.ts`, 2026-10-27).

Markers: **O** = the owner's words. **L** = the lead's direction. **S** = this spec's own call.

**One word.** This document says *workflow* for what the event service stores as a rule version. Code names keep saying
rule (`ruleId`, `rule_versions`, `canonicalFullRuleDocument`), because they are identifiers. Nothing a person reads
calls a workflow anything else (W22).

## 0. What the owner decided, and what this spec adopts

### 0.1 The owner's words (2026-10-27)

- **The go-ahead.** "amazing. Now let's make a full spec and implementation plan, and let's get going with this because
  it looks really good." The owner confirmed:
  - rules become straight-line workflows, with one list, one editor and one approval;
  - nothing migrates;
  - adding a branch or a step makes a new version, which is approved again.
- **Raising events.** "I see we have the webhooks, but I may want to raise an event. Somewhere we will have to have
  something like event listeners, and we will have to be able to define ways for people to subscribe to events.
  Probably there would be a way via Socket.io, WebSockets, or something like that, and it would have token-based stuff.
  The point is, in these workflows, we should be able, at any point, to raise this kind of event. What that means is
  that when I raise an event, that can be a split in the flow. For example, when a project was found, I should be able
  to create a Linear issue, but before the Linear issue is created, I should be able to raise that event. After the
  Linear issue has been created from here, I should be able to raise an event, and so on: session has started, session
  has completed, and so on. Third-party things can listen to them."
- **One concept.** "I don't think I understood the difference between workflows and rules. Simple workflows: why are
  they different in any way?"
- **Events from every step.** "those events that I told you about are just examples, but probably all of these ones
  should be able to raise an event automatically and have a small tick there. Emit events for every single node, and
  then each node will have a set of events that I can turn on, and so on. The events should be namespaced somehow and
  should carry payloads about what happened here, where we are in the workflow, the specific node, and so on. It should
  be able to raise custom events as well."

### 0.2 The lead's directions (2026-10-27)

- **The questions.** The draft's 15 questions take their defaults unless they conflict with the owner's items.
- **One concept.** There is one concept, a workflow. "Simple" only describes a shape: a straight line, no branches,
  nothing waits. It is not a kind, a mode or a screen. In the app the word "rule" disappears. On the command line
  `agent-events workflow …` is the name, and `agent-events rule …` stays as an alias. The MCP tool names are decided by
  cost (W22).
- **Raising events.** These directions become W23–W35:
  1. A **Raise an event** step, placeable anywhere: a non-blocking branch, with a name in a namespace of the person's
     own and declared fields. No sender content goes out unless it is enveloped and the subscriber is allowed it.
  2. **Events from every step:**
     - a standard set per kind, and kind-specific ones;
     - each off by default, ticked per step and stored in the approved document;
     - names of the form `<namespace>.<workflow>.<step>.<event>`;
     - a CloudEvents 1.0 envelope;
     - run events too.
  3. **Subscribers:** a name, the events wanted, a token shown once, revocable. They receive events:
     - live on this Mac over the existing loopback stream, as SSE and as plain WebSocket;
     - off this Mac by a signed webhook.
     Not Socket.io. The existing subscriber and live-stream mechanism is extended, not copied.
  4. **Chaining:** a raised event may start other workflows, with a depth and loop limit.
- **The prototype's choices** (`docs/prototypes/2026-10-27-workflows/README.md`, "For the lead"):
  - the Linear issue is made before the session search, so a worktree's branch can be named after it;
  - Which project? runs first;
  - its limits are placeholders.

### 0.3 The draft's questions: what this spec adopts

| # | Question (draft §14) | Adopted |
|---|---|---|
| 1 | Workflows are rules with a flow, not a second kind | **Default, made stronger:** one concept, one word (W22) |
| 2 | 0.36 holds the first list; worktrees and per-run questions come in 0.37 | **Changed for worktrees:** they ship in 0.36. Step 10 of the owner's thirteen asks for them, the approved prototype draws them, and the lead's track list names them. **Default for per-run questions:** `ask me` waits for 0.37 |
| 3 | A session that may edit files without asking needs a yes per run, unless it works in a worktree the run made | **Default.** In 0.36, with no `ask me`, `acceptEdits` is allowed only in a worktree the run made, and refused anywhere else (W6) |
| 4 | A route chooses only among the projects it lists | **Default** |
| 5 | A project's folders are part of the approval; its profile and hints change at once | **Default** |
| 6 | Analyse runs through claude-stream | **Default**, in 0.37 with Analyse (§13) |
| 7 | "Who asks about it" is off | **Default**, in 0.37 with Analyse |
| 8 | Worktrees are kept; branch `ac/<issue identifier>`; folder `<checkout>-wt/` | **Default.** The prototype's `agent/{{ticket}}` and "removed 7 days after the issue closes" are drawing placeholders |
| 9 | "Finished" means the session said `done` (Claude) | **Default** |
| 10 | Replying stays the session's own act | **Default** |
| 11 | Limits: 10 runs an hour, 2 at a time, 2 sessions an hour, 5 worktrees a day, 3 days | **Default.** New: 120 events an hour (W33) |
| 12 | Projects need the event service | **Default** |
| 13 | The app keeps canvas positions; Approve… lays the graph out afresh | **Default** |
| 14 | Describe it uses the person's Claude subscription first | **Default** |
| 15 | Describe it ships in 0.36 | **Default.** It can slip to 0.37 without holding the rest back |

### 0.4 What changed from the draft

- **New sections:** W22–W36, §9 (events, subscribers and chaining), and Appendix W (the step event catalogue).
- **W19 corrected.** The draft said the new operations would be "B3 control v4". They join B3 control v1 additively,
  as every release from 0.30 to 0.34 did (W19).
- **Worktrees** move into 0.36 (Q2).
- **Find by thread** moves into 0.36 (W36, the lead's review of 2026-10-27): it is the owner's step 5, and 0.35's taking,
  which 0.36 is built on, records who took each conversation. A flow's delivery to a session offers the message, as a
  session target's does.
- **Steps added from the prototype:**
  - waiting for a busy session to come free, `wait for: { sessionIdle }`, drawn as "Queue for the session";
  - looking only for an idle session, `find-session` with `only: 'idle'`, drawn as "Find another session".
- **Adding a project** comes from the checkouts found on this Mac (§8.1). Listing a GitHub account's repositories through
  `gh` waits until a repository can be cloned (§13).
- **Moved to 0.37 or later:** see §13.

## 1. Why

**O, 2026-10-27:** "a workflow designer based on a node-style thing: 1. An event comes in. 2. Conditions are set. 3. If
they are met, it continues. 4. It can search for the session and determine which session it is. 5. If it's about that
session, it goes there. 6. If the session is found, it goes there. 7. If not, search for another one. 8. If no session
was found, it goes to create a new session. 9. If it has to create a new session, you should check what project it is
in. 10. It should be creating a separate work tree, optionally or not. 11. On completion, I may also want to say add part
of this behaviour to this workflow, like create a Linear ticket. 12. … create instructions on what the Linear ticket
should contain. 13. When it finishes work, it should actually close the Linear ticket, and so on."

Earlier the same day the owner asked for:
- **Projects:** a GitHub repository, its checkouts on this Mac, and a profile;
- **routing:** which project and session a message is about, and waiting while the session is busy.

The 0.35 prototype draws both (`docs/prototypes/2026-10-26-messages-lifecycle/README.md` 46–76, row 4).

**O, relayed by the lead, two additions:**
- **The designer** is React Flow (`@xyflow/react` ^12.11.3) through cue-ui's Flow parts, with drag and drop from a
  palette.
- **Describe it:** the person says in plain words what should happen, and a model drafts the workflow. The model is the
  person's Claude subscription through the local CLI, or their OpenRouter or Anthropic key, as Analyse uses. The draft
  is checked like any workflow. Each step shows the words it came from, and ambiguities come back as questions. Nothing
  runs until it is approved.

**What a workflow does today.** It is one straight line, run once per event:
- **The gate.** First the source and event, then the deterministic condition, then the optional judge
  (`packages/events-daemon/src/runtime/evaluate.ts` 227–300). The condition runs before any envelope, taint,
  reservation or network call (262).
- **The fan-out.** A match prepares one delivery per target, all at once (`runtime/deliveries.ts` 80–110). There are six
  target kinds (`domain/activation-documents.ts` 55–61).
- **The session target** finds a session by folder or lane, starts one, queues while it is busy, and posts a framed
  prompt under an idempotent `startId` (`runtime/session-dispatcher.ts` 223–291).
- **The Linear target** creates an issue and does nothing else (`runtime/linear-dispatcher.ts` 29–53).

**What the thirteen steps need that is missing:**
- Anything after a delivery.
- Branches.
- Projects. A search of `packages/core/src` and `packages/events-daemon/src` finds only Google OAuth's `projectId` and
  MCP install scopes.
- Worktrees. None is made anywhere (`packages/core/src/save-deny.ts` 26, 527–538 is the one mention).
- A Linear lifecycle: comment, change, close.
- A way to tell anything outside what a workflow is doing, except by a delivery's own target.

## 2. Goals, non-goals, anti-goals

**Goals**
- **A workflow is a graph of steps with branches,** drawn in a node designer or written as text. Each version is
  approved as a whole, and the approval lists every effect in plain words.
- **Every existing workflow is unchanged.** It shows in the one list as the straight line it is, with no migration and
  no new approval.
- **The owner's thirteen steps can be built:**
  - route to a project;
  - make a Linear issue;
  - find the session that took this conversation (W36), or a session (idle, busy or none) in the project; wait for a
    busy one, or look for another;
  - start one, optionally in a new worktree;
  - give it the message and wait for its turn to end;
  - comment on and close the issue.
- **Any step can tell others what happened:**
  - each step's events are ticked on or left off;
  - a Raise an event step raises a custom event;
  - subscribers receive what they asked for, on this Mac or off it;
  - another workflow can start from an event.
- **Runs survive restarts.** They wait durably (for a turn, a time, a free session), time out, can be cancelled, and
  never repeat an effect.
- **The person sees each run:** its graph, lit along the path it took, in Events and in the message's story.
- **A whole workflow can be tried** without any effect.
- **The canvas, the text and the JSON stay in step,** and **Describe it** turns the person's words into a draft.

**Non-goals**
- **Triggers other than the catalogue's events and raised events,** such as a schedule, a Linear change or a GitHub
  push. The catalogue is normative and closed (local-event-emission design, Appendix A, 3666–3671).
- **Loops.** A graph is acyclic. "Search for another one" is a second step.
- **Sending a message.** A workflow never sends to a person (W16).
- **Interrupting a busy session,** except when the person cancels a run with `--interrupt`.
- **GitHub actions.** The session does those under its own permissions.
- **Workflows or events shared between people or Macs.** A subscriber off this Mac receives events; it does not share
  the workflow.

**Anti-goals: it fails if…**
- **An agent can approve** a workflow or a subscription, answer a run's question, or continue, resume or cancel a run.
- **A stored workflow's bytes or digest change,** or an active approval needs renewing because this shipped.
- **An effect happens twice** after a crash, a lost answer or a retry.
- **A run reaches something its approved version doesn't name:** a folder, a project, a Linear issue or a provider.
- **Sender text reaches the wrong place.** This means:
  - outside the untrusted envelope: a prompt, an issue, a branch name, a path, a notification or an event;
  - deciding a branch by its words;
  - reaching a subscriber that wasn't allowed it.
- **A subscriber receives an event** outside the namespaces it was given, or before the person approved it.
- **A run waits forever,** or holds a process while it waits.
- **A raised event can stop or slow a run.**
- **A chain of workflows loops,** or reaches deeper than 3.
- **Moving a box on the canvas makes a new version,** or a layout can hide a step from the person approving it.
- **Describe it sends content the person didn't paste,** or an agent reaches a version, a target or an approval through
  it.

## 3. Decisions

### 3.1 The graph and its runs (the draft's, kept unless marked)

**W1. A workflow is a rule version with an optional `flow` (S).**
- **The document gains one optional field, `flow`.** Without it, the workflow is exactly today's. With it, the fan-out
  is replaced by the flow's graph.
- **Why:** the hardest machinery already belongs to rule versions and is reused as it is:
  - immutable versions, and D2's approval and supersede (`runtime/activations.ts` 281–386);
  - cut-over points, replacement drains and derived tightenings (`runtime/replacements.ts` 32–38, 200–205);
  - the disclosure binding (`activation-documents.ts` 459–491);
  - Deliveries and Analyse.
- **Rejected:**
  - **a new activation kind;**
  - **rewriting every stored workflow into graph form.** It would change every stored digest and break the pinned vectors in
    `packages/events-daemon/test/fixtures/activation-documents-v1.json` (56, 79, 96, 109).

**W2. A workflow without a `flow` is a straight line, so nothing migrates (S).**
- **The designer draws it** as `Trigger → Condition → [Judge] → Keep → one Deliver per target`. The drawing is derived
  (`flowOf(rule)` in `@agentcomms/events`), never stored.
- **It runs on today's path, with no run record.**
- **Its first version with a step the straight line can't say** (a branch, a wait, a find, an emitted event) is a new
  version with `flow`. It is approved like any other, and supersedes the old one (0.33 §3.1).
- **The precedent:** optional fields are left out of the canonical form when absent, "so every rule stored before it
  keeps its bytes and its digest" (`activation-documents.ts` 93–97).

**W3. The gate stays before any run (S).**
- **The trigger, the condition and the judge** run in the evaluator before anything is kept (`evaluate.ts` 262).
- **A no-match leaves no run.** A run is made only for a match, so a run's existence is itself a match.
- **The flow may hold more conditions and judges later in the graph.** They read the run's mapped fields and its steps'
  closed outputs.

**W4. The graph: steps, closed outcomes, arrows; acyclic and bounded (S).**
- **A step** has a kind, its fields and a closed set of outcomes.
- **Arrows:**
  - each outcome has an arrow to a step or to `end`;
  - `otherwise` names every outcome not given;
  - an outcome without an arrow ends that branch, and the preview says so.
- **Merging** (several arrows into one step) is allowed only where a run can reach that step one way. Two branches of
  one `split` never meet again.
- **Parallel:** `split` starts 2 to 8 branches. The run ends when every branch has.
- **Bounds:** no cycles, at most 32 steps per flow, and at most 64 executed per run.
- **Rejected:** joins that wait for every branch; loops with a counter.

**W5. What reaches someone outside is a delivery of a target version or an event; everything else is an engine step
(S).**
- **Deliver** sends to a target version through today's delivery machinery: the claim and its lease, every fence again
  just before anything leaves (`session-dispatcher.ts` 597–604), retries, dead letters, the Deliveries screen and the
  rate cap (`runtime/delivery-claim.ts` 140–161).
- **Events** leave through the subscriber machinery of §9. It has its own claim, fence and retries, because an event is
  not bound to a target version.
- **Engine steps** disclose to no one: condition, judge, route, find, start, worktree, wait, notify, split.
  - The engine checks the version's live authority before each one (`runtime/disclosure-fence.ts` 211–231).
  - It checks the account too (`assertLiveEventAccount`).
- **Two target changes, each valid only in a flow:**
  - a session target's `find` gains `{ "flow": true }`, "the session the flow chose";
  - a new kind, `linear-change`.
- **The `targets` list still names every target the flow uses.**

**W6. One approval per version lists every effect; per-run questions wait for 0.37 (S, Q3).**
- **The version's approval** is D2's:
  - prepared by `workflow enable`;
  - approved by the person at the terminal with the challenge, or in the attested app (`cli/program.ts` 972–987).
  - Its preview is the workflow's plain words and a numbered list of effects (§10.2).
- **In 0.36:**
  - `acceptEdits` is allowed only for a session started in a worktree this run made. Activation refuses it anywhere
    else, with `ACCEPT_EDITS_OUTSIDE_RUN_WORKTREE`.
  - `bypassPermissions` stays refused (`domain/session-target.ts` 24–33, 132–135).
- **In 0.37:** the `ask me` step, a core approval per run that lapses to `no`. It opens `acceptEdits` in the person's
  own checkout.

**W7. Runs live in the event service's database; content is sealed, history is content-free (S).**
- **Content:** the mapped fields, sealed in the run's record as a delivery's are. They are purged when the run ends or at
  its deadline.
- **History:** each step's state, outcome, times and closed outputs. It is kept as long as the decision's metadata
  (`retention.decisionMetadataMs`).

**W8. Every effect has a key derived from its run and step, so a retry can't repeat it (S).** See §7.4.

**W9. Waiting is a row, not a process (S).**
- **A waiting step** writes a wait (its kind, key and `wake_at`), and the run returns.
- **A wait is woken by:**
  - the relay's event stream (`session-queue.ts` 223–346);
  - a timer, on the scheduler's tick (`runtime/scheduler.ts` 37).
- **Every wait has a timeout** within the run's deadline.

**W10. A run finishes under the version it started on (S).**
- **Ending a run's authority** — disabling or revoking the workflow, `disable-all`, or removing its account — cancels its
  runs and their undelivered events.
- **The person can cancel any run.**

**W11. Projects live in the event service; claude-stream keeps the sessions; Agent Comms makes the worktrees (L).**
- **Why the event service:** routing and runs are its, and it already holds the relay client, the allowed roots and the
  denied folders (`runtime/agent-sessions.ts` 107–115, 213–270).

**W12. A project's folders are authority; its profile and hints are not (S, Q4, Q5).**
- **A route step's candidates are bound into the approved document by value:** each project's id, name, folders and
  worktree root.
- **When a project's folders change,** a run whose candidate no longer matches takes `none` with `PROJECT_CHANGED`. The
  app offers "Review again".
- **Hints and the profile** only choose among approved candidates. They change at once, with no approval.

**W13. Routing is a step: the person's hints first, then a judge per candidate (S).** See §8.3.

**W14. Worktrees: git runs as the person, without the repository's hooks, inside the project's worktree root (S; in
0.36 by Q2's change).** See §6.6. It is the one new execution surface, and it is local.

**W15. Linear changes only reach issues this run created (S).**
- **A comment, change or close names the step that created the issue,** never an id from a message.
- **It uses the same key and the one endpoint** (`domain/linear-target.ts` 23–24).

**W16. Nothing in a workflow sends a message (S, Q10).** Only `send.execute` and `executeSend` send (AGENTS.md).

**W17. The text gains a `flow` section (S).** See §4.4. The canonical JSON stays what is approved; the text is a view.

**W18. A whole workflow can be tried without effects (S).** See §7.7.

**W19. Appendix A does not move. The new operations join B3 control v1 additively, and its pin moves with a reason
(S, corrected).**
- **No field is added to any catalogue event.** Step events are not catalogue events. They have their own catalogue,
  Appendix W, which is separate from the source-event contract.
- **The pinned documents don't change:** `activation-documents-v1.json`'s digests, and the B3 v2 and v3 vectors.
- **New wires join the v1 schema and its vectors additively, as 0.30–0.34's did.** Each release recorded why in the pin
  script (`scripts/verify-events-phase-e-prerequisites.mjs` 12–55). The draft's "v4" can't stand, for two reasons:
  - the lockstep test needs every desktop-callable wire, and every events-daemon `operation` in `capabilities.json`, to
    be a request in `b3-control-v1.schema.json` (`packages/events-daemon/test/b3-contract-type-drift.test.ts` 169–201);
  - v2 and v3 only replace results (`operations/b3-control-v2.ts` 6–11, `b3-control-v3.ts` 14–24).
- **No existing branch changes.** One existing request widens:
  - `rule-test` gains its optional `outcomes`;
  - `subscriber-add` and `subscriber-update` take the new subscriber shapes.
- **Hardening:** `canonicalFullRuleDocument` now refuses an unknown top-level key (`activation-documents.ts` 299–381).
- **Downgrade:** an older event service refuses a newer database (`store/database.ts` 36–75).

**W20. The canvas is a view of the document. The app keeps positions, outside what is approved (S, Q13).** See §11.3.

**W21. Describe it drafts; it never writes, prepares or approves (S).** See §11.4.

### 3.2 One concept

**W22. A workflow is the one concept. "Simple" names a shape, never a kind (O, L, S).**
- **In the app:**
  - Events → **Workflows** is the one list, editor and approval;
  - every existing rule appears there unchanged, as a workflow;
  - the word "rule" leaves every screen, button, preview and message;
  - a straight-line workflow is drawn as a short graph, opened in the same designer and approved with the same
    Approve….
- **On the command line:**
  - `agent-events workflow …` and `agent-events workflows list` are the names;
  - `rule …` and `rules list` stay as aliases (Commander `.alias()`), so scripts and the app keep working;
  - `workflow test-retained` takes `--workflow <id>`, with `--rule` kept as a hidden alias.
- **What the rename costs.** Parity reads the command word before `|` in the help (`scripts/registries.mjs` 156–157),
  so eleven `capabilities.json` rows change their `cli` from `rule …` to `workflow …`:
  - `rules list`, and `rule show|create|update|enable|disable|remove|test|test-retained|analyse|approve`;
  - two strings each in `B3_CAPABILITIES` (`operations/b3-contract.ts` 179–185) and `PHASE_E_B3_CAPABILITY_INVENTORY`
    (`runtime/phase-e-prerequisites.ts` 40, 49);
  - the audit tuples (`test/capability-audit.test.ts` 24–216).
  - No pinned fixture holds the words. A search of `test/fixtures/b3-control-contract-v1`, `src/operations/contracts`
    and `test/b3-consumer-contract.test.ts` for `rule create` and `rule test` finds none. Row ids
    (`events-daemon.rule.create`) stay, as identifiers.
- **The app calls by the alias.** It keeps calling `rule …` words (`apps/desktop/src-tauri/src/allowlist.rs` 1688–1752),
  which every service since 0.33 understands. New 0.36 calls use `workflow …` and are gated at 0.36.0.
- **The MCP tools keep their names (`events_rule_*`), and their titles and descriptions say workflow.** This is cheaper
  than the alternatives:
  - The names are identifiers, held in people's client permission lists (`mcp__events__events_rule_create`), the skills
    and the router's prefixes.
  - A second set of `events_workflow_*` names would double ten tools for agents. It would also need an alias mechanism
    that parity doesn't have: one row names one `mcp` tool, and no alias exists in the event service.
  - The ordered tool lists are pinned (`test/built-surfaces.test.ts` 106, `test/runtime-operation-parity.test.ts` 64).
  - **New tools on workflows take the same noun,** `events_rule_check`, so an agent sees one family.
  - **The tool's `title`, which a client shows a person,** says workflow: "Create a workflow".
- **Inside:** one object, a rule version with an optional `flow`. Nothing is renamed in storage, wire or JSON keys.

### 3.3 Events, subscribers and chaining

**W23. Every step can emit events. Each is off by default, ticked per step, and stored in the approved document (O, L,
S).**
- **Each step kind has a fixed set of events,** standard and kind-specific (Appendix W.3):
  - the standard ones are `started`, `succeeded`, `failed`, `waiting`, `skipped` and `retrying`, where the kind can do
    them;
  - the kind-specific ones follow its outcomes. Find a session has `found`, `busy`, `not-found` and `watched`. Create a
    Linear issue has `created`. Which project? has `matched`, `none` and `unsure`. Wait for the run has `finished` and
    `timed-out`.
- **A step's `emit` lists the ones ticked.** It is absent when none are, so a flow with no events keeps its bytes.
- **The run's own events** (`started`, `held`, `finished`, `failed`, `cancelled`, `expired`) are ticked in the workflow's
  settings, as `flow.events.run`.
- **Emitting is an effect.** It is in the document, so it is in the digest and listed in the approval (§10.2).
  - Ticking an event makes a new version, approved again.
  - Moving a box doesn't (W20).
- **On the canvas** a small mark on a step's card shows that it emits, with the count ticked. The step's settings have
  an Events part with one tick per event.

**W24. An event's name is `<namespace>.<workflow>.<step>.<event>` (O, L, S).**
- **Each segment matches `^[a-z][a-z0-9_-]{0,31}$`,** so a name is at most 131 characters.
- **Where each segment comes from:**
  - `namespace` is the workflow's `flow.events.namespace`;
  - `workflow` is `flow.events.workflow`;
  - `step` is the step's id, or `run` for the run's own events;
  - `event` is the event's word, or a Raise step's name.
  - For example: `acme.client-asks.issue.created`, `acme.client-asks.run.failed`, `acme.client-asks.tell-crm.found`.
- **The namespace defaults to the person's own.** The app and Describe it fill in the organisation part of the trigger
  account's alias (`acme` for `acme/slack`) when it fits the grammar, and `me` otherwise. It is written out in the
  document and shown in the approval.
- **The workflow segment defaults** to the workflow's id when that fits the grammar, and must be given when it doesn't.
  Today's ids allow `.`, `:`, `@` and capitals (`apps/desktop/grammar.json` 36).
- **Reserved:**
  - the namespaces `agentcomms` and `com`. `com.agentcomms.<type>.v<n>` is the default type of today's message events
    (`packages/events/src/wire/cloudevent.ts` 53–56);
  - the step ids `run`, `trigger`, `end` and `otherwise`;
  - the six standard words, which can't be a Raise step's name.
- **Unique:** among active workflows, a `namespace.workflow` pair names one workflow. Activation refuses a second with
  `EVENT_NAME_IN_USE`, as a lane is refused (`activation-documents.ts` 283–297).
- **Stable across versions:** step ids stay as they are. The designer never renames a step when it saves, so a
  subscriber's pattern keeps matching from version to version.

**W25. Step events have their own catalogue, Appendix W, with schema versions (L, S).**
- **It is closed:** each kind's events, and each event's `data` fields.
- **It lives in `@agentcomms/events`** beside Appendix A's, and is pinned by its own fixture.
- **Changes:** a field, a widened word or a new event means a new catalogue version. The version shows in each event's
  `dataschema`: `urn:agentcomms:workflow-events:v1:<schema>`.
- **`agent-events workflow-events list|show`** prints it. It is content-free, so it is on both the CLI and MCP.

**W26. An event is a CloudEvents 1.0 structured JSON object (L, S).** Its attributes are fixed (Appendix W.2):
- **`id`:** `wfe_` and 26 characters. It is the same on every try and for every subscriber.
- **`source`:** `urn:agentcomms:<installation>:workflows:<workflow id>@<version>`.
- **`type`:** the namespaced name.
- **`time`:** when it was raised.
- **`subject`:** the run id.
- **Extensions:**
  - `agentcommsrule` (`<id>@<version>`, as today's events carry, `cloudevent.ts` 21);
  - `agentcommsrun`;
  - `agentcommsstep`;
  - `agentcommsuntrusted` when content is present (`cloudevent.ts` 22).
- **`data`:**
  - the workflow, the run (id, start, depth, parent);
  - the step (id, kind, label, index, attempt);
  - the path so far, the outcome, the duration and the error code;
  - the step's closed outputs. These include an issue's id, identifier and link, a session's id, a project's id and
    name, and a worktree's branch.
- **Never in `data`:** a folder path. Project folders name clients (taking design T7). The run view shows paths; events
  don't.

**W27. Sender content reaches an event only through a Raise step, only for a subscriber allowed it, and only enveloped
(L, S).**
- **Automatic events carry closed values only.** A step's label is the workflow author's words. It is carried as a
  string and marked as author text, as `describeRule` marks it (`packages/events/src/rules/describe-rule.ts` 5–10).
- **A Raise step may declare `fields`:** mapped field names whose values a sender wrote.
  - They reach a subscriber only when its approved subscription says `content: "enveloped"`.
  - They arrive inside `wrapUntrusted`'s envelope, with each pointer listed in `agentcommsuntrusted`, as a delivery
    marks them today (`runtime/target-delivery.ts` 106–122).
  - Any other subscriber gets the event without `data.fields`.
- **A session's summary is agent-written,** and is treated the same way.

**W28. Raise an event is a step that never waits and never fails (O, L, S).**
- **What it holds:** `{ kind: "raise", name, fields?, next }`, with one outcome, `raised`.
- **What it does:** it writes the event to the outbox in the same transaction that settles it, and goes on. Delivery
  happens later, apart from the run (W33). This is the owner's "a split in the flow".
- **Where it goes:** anywhere a step can go, including before an effect ("before the Linear issue is created") and after
  one.
- **Its type:** `<namespace>.<workflow>.<raise step id>.<name>`.

**W29. A subscriber is the existing object, extended (L, S).**
- **Today:** a subscriber is an immutable SSE listener version (`domain/sse-subscriber.ts` 5–12, `subscriber_versions`
  in `store/migrations.ts` 89–100):
  - a loopback authority, browser origins and a replay retention;
  - a terminal-only bearer token (`cli/program.ts` 692–710);
  - revoked by `subscriber remove`.
  It receives only what a workflow's SSE target delivers to it.
- **In 0.36 it gains an optional `events` part,** `{ namespaces, patterns, content }`, and a second kind, `webhook`:
  - **`sse`:** live on this Mac, over SSE or WebSocket on its own listener (W31). It is the same document, so a stored
    subscriber keeps its bytes. With `events`, `origins` may be empty, which means no browser may connect.
  - **`webhook`:** off this Mac, at a URL, signed (W32). Its document is a webhook target's, without a representation,
    plus `events`.
- **Approval:** a subscriber version with `events` is inert until the person approves it.
  - `subscriber enable <id> <version>` prepares an activation of a new kind, `subscription`. CLI and MCP both have it, as
    `workflow enable` does.
  - The person approves it with `approve <approval-id>` at the terminal, or `subscriber approve <approval-id> --digest`
    in the attested app.
  - One version per subscriber is active; a new one supersedes the old.
- **Its preview** says what it receives, in which namespaces, whether it gets what senders wrote, and where it goes:
  "events-dashboard receives acme.client-asks.*.* and *.*.*.failed in the namespace acme, live on this Mac at
  127.0.0.1:4801, from the page at http://localhost:3000. Nothing a sender wrote."
- **Tokens and secrets are the person's, shown once:**
  - the live token is `subscriber token create|rotate` (terminal-only, as today);
  - a webhook's signing secret is the new `subscriber secret create|rotate`;
  - a secret URL is the new `subscriber url set`, as a webhook target's (`capabilities.json`, `events-daemon.target-secret.*`,
    `target url set`).
- **Revoking is at once:** `subscriber remove` revokes every version, closes its streams and cancels its undelivered
  events.

**W30. A subscriber is given namespaces. Its patterns match only inside them (O, L, S).**
- **A pattern** is four segments, each a literal segment or `*`. `*` matches exactly one segment. There is no `**`, no
  partial wildcard and no regular expression.
- **The first segment** is a namespace the subscriber was given, or `*`, which means any of them. So `*.*.*.failed`
  matches every failed step in the subscriber's namespaces, and nothing outside them.
- **Bounds:** 1 to 8 namespaces and 1 to 32 patterns, sorted and unique. A literal namespace not given is refused.
- **One function decides it all:** `matchesEventPattern(type, pattern, namespaces)`, in `@agentcomms/events`, for
  delivery and for the preview alike.

**W31. Live on this Mac: one listener per subscriber version, serving SSE and WebSocket with the same token rules (L,
S).**
- **Today's listener** (`runtime/sse-server.ts`) serves `GET /v1/streams/<id>` (88–90). It checks:
  - the exact `Host` (262), no query (262) and no cookie (264);
  - the `Origin` against `origins` (111–115);
  - `Authorization: Bearer`, for the current token or the previous one inside its 5-minute overlap
    (`subscriber-streams.ts` 62–90).
  - It replays after `Last-Event-ID` (362).
- **The owner doesn't start it today.** `startSseServer` (`sse-server.ts` 448) is called only by tests
  (`test/sse-listener.test.ts`, `test/b3-purge-closure.test.ts`, `test/support/browser-sse-fixture.ts`; a search of
  `packages/*/src` and `apps` finds no other caller).
- **In 0.36 the owner starts one listener for each subscriber version something may deliver to:**
  - one bound by an active workflow's SSE target;
  - or one with an active subscription.
  - It closes the listener when that ends. A port in use shows as `PORT_IN_USE` in `subscribers list`.
- **WebSocket on the same listener and path.** A `GET` with `Upgrade: websocket` gets an RFC 6455 handshake, with the same
  checks of `Host`, query, cookie and `Origin`.
  - **The token** comes in `Authorization: Bearer <token>`, for programs that can set it. A browser offers it as a
    subprotocol instead: `Sec-WebSocket-Protocol: agentcomms.events.v1, agentcomms.bearer.<token>`, since a browser
    can't set the header. The answer names `agentcomms.events.v1` only, and never echoes the token.
  - **Replay** comes from `Last-Event-ID`, or a subprotocol `agentcomms.after.<event id>`.
  - **It only pushes.** Each event is one text message, the CloudEvent's canonical JSON.
    - The client may send only ping, pong and close, each at most 125 bytes. Anything else closes with 1008.
    - The server pings every 30 seconds, and closes with 4408 when no pong comes within 60.
    - A rotated or revoked token closes with 4401, as an SSE stream is ended today (`sse-server.ts` 220–231).
  - **No extensions,** so no `permessage-deflate`.
  - **No library.** It is a small push-only implementation in the event service, which has no runtime dependency outside
    the workspace (`packages/events-daemon/package.json` 44–51). It is tested against Node's built-in `WebSocket`
    client and a browser.
  - **Rejected: Socket.io.** It is one library's protocol over WebSocket: a client must speak it, and it adds polling
    fallbacks and rooms nothing here needs.
- **SSE frames** for events are `id: <event id>`, `event: <type>`, `data: <the CloudEvent>`.
- **Replay** reads the listener's rule-target frames (`stream_log`) and its events (`event_stream_log`) in one order.
  Each is kept for the subscriber's `retentionMs`, at most 7 days (`sse-subscriber.ts` 78).

**W32. Off this Mac: a signed webhook per subscriber, as a webhook target is (L, S).**
- **The same transport:**
  - the pinned connection to the approved address set;
  - HTTPS, or plain HTTP to literal loopback only;
  - the Standard Webhooks headers from `signStandardWebhook` (`runtime/webhook-signing.ts` 29–43), with the current
    secret and the overlap's;
  - `retryLimit` at most 20 (`domain/webhook-target.ts` 150–151).
- **`webhook-id` is the event id,** the same on every try, so a receiver can drop repeats.
- **The body** is the CloudEvent, sent as `application/cloudevents+json; charset=utf-8` (`cloudevent.ts` 9).

**W33. Delivery never touches the run (S).**
- **At least once, in order per subscriber:**
  - an event is delivered to each matching subscriber version at least once, in the order raised;
  - a webhook subscriber is strict, as webhook targets are: a later event waits for an earlier one to settle.
- **A run never waits for a subscriber.** The outbox write is in the step's own transaction. Delivery, its failures and
  its dead letters are the subscriber's, on the Deliveries screen under the subscriber.
- **Bounds:**
  - `flow.limits.eventsPerHour` per workflow (default 120, at most 600);
  - across all workflows, 1,000 an hour;
  - each subscriber holds at most 10,000 undelivered events.
  - An event over the limit isn't raised. It is counted in the run as `EVENT_LIMIT`. Past a subscriber's backlog its
    oldest undelivered events expire with `SUBSCRIBER_BACKLOG`. Neither blocks a run.
- **Retention:**
  - a raised event's sealed record is kept until every delivery of it is final, or `retention.deliveryMs`;
  - a dead letter is kept for `retention.deadLetterMs`.
- **Shadow and test** raise nothing. They record "would raise …" (§7.7).

**W34. A raised event may start other workflows: a chain is about the same message (L, S).**
- **A chained workflow is an ordinary workflow** whose `flow.on` names the events that start it:
  - `on: { raised: [patterns], withinMs }`;
  - each pattern has a literal namespace and workflow, so the approval names which workflows can start it;
  - `withinMs` defaults to 1 day, and is at most the workflow's `retention.ingestMs`.
- **It is about the message that started the chain.**
  - **At ingest:** its `source`, event, condition, judge and mapping are its own, approved as usual. Each message it
    covers is admitted as for any workflow.
  - **Its evaluator waits** until a run about that message raises a matching event, or `withinMs` passes. At the
    deadline it decides `not-chained`, content-free, and drops its projection.
  - **When a matching event comes,** it gates and maps the message through its own approval, and starts its run. That
    run has `parent` (the raising run) and `depth` (the parent's plus 1), and the raised event's closed `data` under
    `/trigger`.
- **What follows from this:**
  - **Sender content never passes between workflows.** Each reads the message through its own approved mapping.
  - **There are no loops.** A decision is unique per message and workflow version (`UNIQUE (event_id, rule_id,
    rule_version)`, `store/schema-v1.ts` 239), so a workflow can't be started twice for one message.
  - **There is a depth limit.** A chain reaches at most depth 3, and an event raised at depth 3 starts nothing.
  - **A workflow can't name its own events,** which activation refuses.
- **Rejected: a chained run fed by the raised event alone.** Its fields would be the parent's, mapped by the parent's
  approval and passed on, so the child's approval couldn't say what it reads.
- **Its cost:** a chained workflow keeps its projection of each message it covers for up to `withinMs`. The preview says
  so: "keeps what it needs of each Slack message in cue/slack for up to 1 day, in case client-asks raises
  acme.client-asks.issue.created".
- **It can slip.** If chaining slips from 0.36, activation refuses `flow.on` with `CHAIN_NOT_AVAILABLE`, and nothing else
  depends on it.

**W35. Two authorities let an event out: the workflow's approval and the subscriber's (S).**
- **The workflow's approval** says what is raised, when, and with what: closed outputs, and any declared `fields`.
- **The subscriber's approval** says who receives which names, in which namespaces, with or without content.
- **A delivery needs both, live, checked again just before it leaves:**
  - the emitting version active, or retained superseded work (`disclosure-fence.ts` 230–231);
  - its account live;
  - the subscriber version active and not revoked;
  - the pattern matching inside the given namespaces;
  - content only where `content` allows it.
- **An agent may write either one** — a workflow version, or an inert subscriber version — and approve neither (§10.1).

**W36. Find the session that took this conversation (O, L).**
- **O:** "5. If it's about that session, it goes there."
- **L (2026-10-27):** the draft left this for 0.37 ("find by thread"). 0.36 is built on 0.35, whose taking records who
  took each conversation, so step 5 has a meaning the engine can check, and it ships in 0.36.
- **The place `{ thread: true }`,** on `find-session` only: the session that took an earlier message in this message's
  conversation (Gmail's thread id; Slack's `<channel>/<parent ts>`), read from core's take store
  (`packages/core/src/takes.ts`, `TakeStore`).
  - It reads the newest take in the run's account whose `thread` is this message's thread, in state `taken` or `done`,
    held by a session with a Claude Code session id (`TakeHolder.sessionId`). The message's own take doesn't count.
  - That session is the relay session whose `nativeSessionId` equals that id. The outcomes are the usual ones: `idle`,
    `busy`, `watched`, or `none` when there is no such take, its holder had no session id, the person holds it, or the
    relay no longer knows the session.
  - **Claude only.** A Codex session has no id a take records, so activation refuses `provider: 'codex'` with this place
    (`FIND_THREAD_NEEDS_CLAUDE`). `start-session` refuses the place (`FLOW_PLACE`): a conversation has no folder.
  - **What it reads and keeps:** a thread id is the provider's id, not sender text. The output is find's existing
    `session` and `provider`, so Appendix W doesn't change. The take's folder, client and key never enter the run, its
    events or its output. A message with no thread finds `none`.
- **A flow's delivery to a session offers the message** to that session, as a session target's dispatch does (taking
  design T4): exclusive for 15 minutes after it is handed over, and the session still takes it itself. The flow's
  delivery goes through the same dispatcher (§6.4), so the offer comes with it. The message's story shows it.
  - It needs 0.35's offers (the event service writing offers into core's take store, taking design §14) on the base.
    If those slip, the offer slips with them; find by thread still ships, since it only reads.
- **The words:**
  - the text: `find the session that took this conversation, with claude-code`;
  - the palette's Sessions group gains **Find this conversation's session**;
  - the approval's line: "If a session already took an earlier message in this conversation, …".
- **Rejected: matching on the sender alone.** A second, unrelated request from the same person would go to a session
  busy with the first.

## 4. Data model

### 4.1 The flow (`packages/events/src/flow/types.ts`)

```ts
interface CanonicalFullRuleDocument { /* … today's fields … */ readonly flow?: FlowDocumentV1 }

interface FlowDocumentV1 {
  readonly flowVersion: 1;
  readonly start: StepId;
  readonly steps: Readonly<Record<StepId, FlowStep>>;   // 1–32; StepId matches ^[a-z][a-z0-9-]{0,31}$, not reserved
  readonly limits: FlowLimits;                          // written out in full, so the digest binds them
  readonly events?: FlowEvents;                         // required when any step emits or raises, or run events tick
  readonly on?: FlowOn;                                 // a chained workflow (W34)
  readonly shadow?: true;                               // every effect becomes a dry-run record (§7.7)
}
interface FlowEvents { readonly namespace: string; readonly workflow: string; readonly run?: readonly RunEvent[] }
interface FlowOn { readonly raised: readonly string[]; readonly withinMs: number }   // 1–8 patterns
type Next = StepId | 'end';
type Arrows<O extends string> = Readonly<Partial<Record<O | 'otherwise', Next>>>;
interface StepCommon { readonly label?: string; readonly emit?: readonly string[] }  // label ≤ 60, author text

type FlowStep = StepCommon & (
  | { kind: 'condition'; when: CanonicalCondition; next: Arrows<'yes' | 'no'> }        // over /fields, /steps, /trigger
  | { kind: 'judge'; ask: AgenticConditionV1; next: Arrows<'yes' | 'no' | 'unsure'> }
  | { kind: 'route'; candidates: readonly RouteCandidate[]; by: readonly ('hints' | 'judge')[];
      judge?: AgenticConditionV1; inputs: readonly string[]; next: Arrows<'chosen' | 'none' | 'unsure'> }
  | { kind: 'find-session'; in: Place; provider: 'claude' | 'codex'; only?: 'idle';
      next: Arrows<'idle' | 'busy' | 'none' | 'watched'> }
  | { kind: 'start-session'; in: Place; provider: 'claude' | 'codex'; mode: 'manual' | 'acceptEdits' | 'plan';
      next: Arrows<'started' | 'refused'> }
  | { kind: 'worktree'; project: StepId; base: 'default' | { branch: string }; branch: string;
      cleanup: 'keep' | 'remove-if-clean'; next: Arrows<'made' | 'refused'> }
  | { kind: 'deliver'; target: { targetId: string; version: number };
      to?: { session: readonly StepId[] } | { issue: StepId };
      report?: readonly ('done' | 'needs-the-person' | 'not-mine' | 'blocked')[];
      next: Arrows<'done' | 'left-in-queue' | 'failed'> }
  | { kind: 'wait'; for: { turnEnd: StepId } | { sessionIdle: StepId } | { time: { afterMs: number } };
      timeoutMs: number; next: Arrows<WaitOutcome> }
  | { kind: 'notify'; text: string; next: Arrows<'sent'> }
  | { kind: 'split'; branches: readonly StepId[] }                                      // 2–8, never meeting again
  | { kind: 'raise'; name: string; fields?: readonly string[]; next: Arrows<'raised'> });

type Place = { project: StepId } | { worktree: StepId } | { folder: string } | { lane: string }
            | { thread: true };                     // find-session only, provider claude (W36)
interface RouteCandidate { projectId: string; name: string; folders: readonly string[]; worktreeRoot: string | null }
type WaitOutcome = 'completed' | 'failed' | 'stopped' | 'timed-out' | 'done' | 'needs-the-person' | 'not-mine'
                 | 'blocked' | 'free' | 'elapsed';
interface FlowLimits {
  runsPerHour: number;          // default 10, at most 60
  concurrentRuns: number;       // default 2, at most 8
  sessionsPerHour: number;      // default 2, at most 10
  worktreesPerDay: number;      // default 5, at most 20
  linearWritesPerHour: number;  // default 30, at most 120
  eventsPerHour: number;        // default 120, at most 600
  runMs: number;                // default 3 days, at most 30
}
```

- **Step slots.** A template (Linear, notify, a branch name) may name:
  - a mapped field, `{{subject}}`, as today (`linear-target.ts` 218–233);
  - a closed output, `{{steps.issue.identifier}}` or `{{steps.route.project}}`;
  - in a chained workflow, `{{trigger.outputs.issue.identifier}}`.
  - A session's summary, `{{steps.<wait>.summary}}`, is the one free-text output. It is agent-written, it may be named
    only in a Linear comment, and it is rendered as outside text.
- **A condition step** reads `/fields/…`, `/steps/<id>/<output>` and `/trigger/…`. An operand over a closed output must
  be one of its closed words.
- **What `checkFlow` (pure, in `@agentcomms/events`) refuses:**
  - a cycle, a step no arrow reaches, or a `split` whose branches meet;
  - a reserved step id;
  - an `emit` word the step's kind doesn't have (Appendix W.3);
  - `emit`, run events or a `raise` step without `flow.events`;
  - a Raise name that is a standard word;
  - a malformed pattern in `on.raised`.
- **What activation also refuses** (the event service, with its accounts, folders and Linear):
  - an unknown or unused target, or a `deliver` whose `to` names a step of the wrong kind;
  - a `flow: true` session target or a `linear-change` target outside a flow;
  - `report` for a Codex session (claude-stream's `outputFormat` is Claude's alone, api-contract 1030–1034);
  - `acceptEdits` anywhere but a worktree this run made (W6);
  - a `namespace.workflow` another active workflow holds (W24);
  - an `on.raised` pattern naming this workflow, or one whose namespace or workflow segment is `*`;
  - a canonical document over 48 KiB. That is the app's bound (`apps/desktop/src-tauri/src/rule_editor.rs` 16), and it
    keeps a request inside the 64 KiB control frame (`control/protocol.ts` 5).

### 4.2 Target and subscriber additions

```ts
// The session target (domain/session-target.ts 38–51): find gains one shape, valid only inside a flow.
type SessionFind = { folder: string } | { lane: string } | { flow: true };

interface LinearChangeTargetDocument {
  targetId: string; version: number; kind: 'linear-change';
  team: { id: string; key: string };
  comment?: { text: string };                       // slots as a description's; may name {{steps.<wait>.summary}}
  state?: { id: string; name: string; type: 'started' | 'completed' | 'canceled' };
  labels?: { add: readonly LinearLabel[]; remove: readonly LinearLabel[] };
  assignee?: LinearAssignee;                        // at least one of the four
}

interface EventSubscriptionV1 {
  namespaces: readonly string[];                    // 1–8, sorted, unique, not reserved
  patterns: readonly string[];                      // 1–32, sorted, unique; W30
  content: 'none' | 'enveloped';
}
interface SseSubscriberDocument {                   // today's (domain/sse-subscriber.ts 5–12), plus:
  events?: EventSubscriptionV1;                     // absent: today's subscriber, its bytes unchanged
}                                                   // origins may be [] only when events is present
interface WebhookSubscriberDocument {
  subscriberId: string; version: number; kind: 'webhook';
  url: PlainWebhookUrl | SecretWebhookUrl; approvedAddressSet: readonly string[];
  signing: 'standard-webhooks'; retryLimit: number; // as a webhook target's (webhook-target.ts 20–30, 150–151)
  events: EventSubscriptionV1;
}
```

- **Linear states:** activation checks the state id against the team's states in Linear, as it checks label ids today.
- **Subscribers in documents:** `canonicalSubscriber` (`activation-documents.ts` 238–242) accepts both kinds. A
  workflow's `subscribers` list, which its SSE targets bind, still admits `sse` only.

### 4.3 The store (migration 34)

Everything is content-free unless marked **sealed**.

| Table | What it holds |
|---|---|
| `workflow_runs` | `id` (`wfr_` + 26), `decision_id` (unique), `parent_run_id`, `depth` (0–3), `rule_id`, `rule_version`, `account_id`, `event_id`, `state` (`held`, `running`, `waiting`, `done`, `failed`, `cancelled`, `expired`), `started_at`, `updated_at`, `expires_at`, `switch_generation`, `executed_steps`, `events_not_raised`, `end_code`, `shadow`, `encrypted_record` (**sealed**: the mapped values, the session summaries and the `/trigger` data; NULL once the run ends) |
| `workflow_steps` | `(run_id, step_id)`, `state` (`ready`, `running`, `waiting`, `done`, `failed`, `skipped`, `cancelled`), `outcome`, `delivery_id`, `attempt_id`, `lease_token`, `lease_until`, `attempts`, `next_at`, `started_at`, `settled_at`, `settle_seq`, `last_error_code`, `output` (closed JSON, checked by kind) |
| `workflow_waits` | `(run_id, step_id)`, `kind` (`turn-end`, `session-idle`, `time`, `limit`), `key` (a relay turn or session id), `wake_at` |
| `workflow_effects` | `rule_id`, `kind` (`run`, `session-start`, `worktree`, `linear-write`, `event`), `at`: the hour and day counters, as `delivery_cap_charges` is |
| `workflow_worktrees` | `(run_id, step_id)`, `project_id`, `checkout`, `path` (unique), `branch`, `state` (`recording`, `made`, `refused`, `kept`, `removed`), times, `reason` |
| `workflow_settings` | one row: the ceilings of §7.5 and W33 |
| `projects` | `id`, `name` (unique), `repo` (`github.com/<owner>/<name>`), `profile` (≤ 2,000 characters), `profile_by`, `profile_at`, `hints` (sender domains, Slack conversations, handles: the person's words), times |
| `project_folders` | `folder` (realpath), `project_id`, `kind` (`checkout`, `worktree`), `default_branch`, `worktree_root`, `made_by_run`, `made_by_step` |
| `workflow_events` | `id` (`wfe_` + 26), `run_id`, `step_id` (NULL for run events), `rule_id`, `rule_version`, `account_id`, `type`, `schema`, `sequence`, `raised_at`, `expires_at`, `state` (`open`, `done`, `expired`, `cancelled`), `encrypted_record` (**sealed**: the CloudEvent's bytes and any enveloped fields; NULL once done) |
| `event_deliveries` | `(event_id, subscriber_id, subscriber_version)`, `kind` (`sse`, `webhook`), `state` (`queued`, `retryable`, `disclosing`, `delivered`, `dead-lettered`, `expired`, `cancelled`), `attempts`, `next_at`, `lease_until`, `attempt_id`, `lease_token`, `ordering_sequence`, `last_error_code`, `last_status`, `delivered_at`, `dead_letter_expires_at` |
| `event_stream_log` | `id`, `event_id`, `subscriber_id`, `subscriber_version`, `encrypted_record` (**sealed**: the frame as this subscriber may see it), `delivered_at`, `expires_at` (at most 7 days later) |
| `workflow_chain_requests` | `(event_id, rule_id, rule_version)`, `workflow_event_id`, `parent_run_id`, `depth`, `requested_at` |
| `deliveries` | gains `run_id` and `step_id` (NULL outside a flow); `target_kind` admits `linear-change`; an issue may be recorded on `linear` and `linear-change` |
| `subscriber_versions` | gains `state` (NULL, `inert`, `active`, `superseded`), `approval_id`, `activated_at`, `superseded_at`, with one active version per subscriber |
| `event_secret_generations` | a subscriber may hold `webhook-signing` and `secret-url` as well as `sse-bearer` |

- **Rebuilds:**
  - `deliveries`, because its kind check is a closed set (`store/migrations.ts` 1163). The rebuild recreates exactly what
    migration 32 left on it: the index `deliveries_stable_order` and the triggers `session_queue_goes_with_its_delivery`
    and `session_work_goes_with_its_delivery` (1203–1233).
  - `event_secret_generations`, because its owner and purpose check is closed (36–41). It is rebuilt with migration 26's
    helper (17–50).
- **A flow delivery's `target_key`** ends in `#<stepId>`, so `UNIQUE (decision_id, target_key)` holds one delivery per
  step per run.
- **Run ids are `wfr_`, not `run_`.** claude-stream's turn ids are `run_` + 36 (`session_deliveries.run_id`,
  `migrations.ts` 1220).

### 4.4 The text

A workflow with a flow has a `flow` section in place of `then`.
- **Targets** are written where a step delivers to them, and the parser collects them into `targets`.
- **Arrows:** a step with no arrows goes on to the next one written, so a straight line needs none. `->` may be typed for
  `→`.
- **Events:**
  - `emits` on a step's own line ticks events;
  - `events in <namespace> as <workflow>` heads the section;
  - `raise <name>` is the Raise step;
  - `on raised <pattern> and <pattern>, within 1 day` starts a chained workflow.

```
workflow client-asks, version 5

when a Slack message is posted in acme/slack, in conversation C0123
ask jev, version 2
  question "Is this person asking for a change to one of our sites?"
  looking at text
  yes at 0.7, if unsure drop
keep text, author.name

flow, at most 6 runs an hour, 2 at a time, 2 sessions an hour
  events in acme as client-asks, run emits finished and failed
  step route: choose a project among acme-site and billing, by hints then by jev version 2
    looking at text
    emits matched and none
    none → tell
  step found: raise project-found
  step issue: linear issue client-issues, version 1, in team ACME, assigned to me
    title "{{author.name}} asks about {{steps.route.project}}"
    description "{{text}}"
    emits created
  step find: find a session in route's project, with claude-code
    idle → give
    busy → free
    none → another
  step free: wait for find's session to be free, up to 2 hours
    free → give
    otherwise → tell
  step another: find an idle session in route's project, with claude-code
    idle → give
    none → tree
  step tree: make a worktree of route's project, branch "ac/{{steps.issue.identifier}}"
    refused → tell
  step start: start a session in tree, with claude-code, mode manual
  step give: session client-prompt, version 2, to find, another or start
    give
      fields text, author.name
      text "Do what they ask, on a branch of its own. Don't push."
    report done and needs-the-person
    emits given
  step wait: wait for give's turn to end, up to 1 day
    done → note
    otherwise → tell
  step note: linear change client-done, version 1, on issue
    comment "{{steps.wait.summary}}"
    state Done
    emits closed
    then → end
  step tell: tell me "A message for {{steps.route.project}} needs you"
```

- **The keyword:** `workflow <id>, version <n>` heads the text. `rule <id>, version <n>` still parses, and the printer
  writes `workflow`. A version's text never changes its JSON, so this changes no digest.
- **The printer** writes steps from `start` in a stable order: depth first, the arrows in each kind's outcome order. It
  reads no position.
- **The `raw` escape** stays for anything the words can't say (`GRAMMAR.md` 305–315).
- **The round trip:** `parseRuleText(printRuleText(doc))` deep-equals `doc` for every flow fixture, and the property
  test covers flows.

## 5. The engine

- **Where:** `WorkflowEngine` lives in the owner, beside the dispatcher, under the same writer lease.
  - The scheduler's tick drives it.
  - It is woken when a delivery settles or a wait resolves.
- **A run begins with its match.** For a flow, `commitDecisionOutbox` writes the run and makes `start` ready, in the
  decision's own transaction, instead of preparing a delivery per target (`deliveries.ts` 80–110).
  - The run is charged to `runsPerHour`.
  - Past `concurrentRuns`, it is `held`, and starts in turn, oldest first. It is never dropped.
- **One step at a time per branch:**
  1. **claim** the step: an attempt id, a lease token and a lease (`delivery-claim.ts`);
  2. **fence:** the version's authority, the switch generation, the account live, collection not paused;
  3. **check the limit** the step counts against. When it is reached, the step waits (`limit`), and is never failed;
  4. **run** it through its kind's executor. A `deliver` step inserts one delivery row and waits for it to settle;
  5. **settle,** in one transaction that proves the claim is still this attempt's: the outcome, its closed outputs, the
     next steps made ready, the steps now unreachable marked `skipped`, and the outbox rows of every ticked event (§9.1).
- **A settled delivery becomes an outcome:**
  - delivered is `done`;
  - `LEFT_IN_QUEUE` or `LEFT_IN_LANE` is `left-in-queue`;
  - dead-lettered, expired or unreadable is `failed`.
  - A busy session is not an outcome. The delivery waits in the busy queue (`session-dispatcher.ts` 463–496), and the
    step stays `waiting`.
- **How a run ends:**
  - when every branch reaches `end`, the run is `done`, or `failed` if a branch ended on an unhandled `failed`;
  - the sealed record is purged in the same transaction;
  - at `expires_at` the run is `expired`: its steps are cancelled, its deliveries cancelled where they still wait, and
    its record purged.

## 6. Steps

| Step | Outcomes and outputs | Effect | Fails, retries | In 0.36 |
|---|---|---|---|---|
| condition | yes, no | none | none | yes |
| judge | yes, no, unsure; `score` | a judge call, on the workflow's budget | as the workflow's judge | yes |
| route | chosen (`project`, `projectName`, `reason`, `score`, `profileHash`), none, unsure | 0 to 8 judge calls | a judge failure → unsure | yes |
| find-session | idle, busy, none, watched; `session`, `provider` | reads only | relay down: 12 tries (`session-dispatcher.ts` 51, 624–652) | yes |
| start-session | started (`session`), refused (`refusal`) | a relay session; counts `sessionsPerHour` | a refusal (outside roots, 501, 503) is `refused` | yes, `manual` and `plan`; `acceptEdits` only in a run-made worktree |
| worktree | made (`branch`, `path`), refused (`refusal`) | `git worktree add`; counts `worktreesPerDay` | an index lock: 3 tries; else refused | **yes** (Q2) |
| deliver | done, left-in-queue, failed; per target (Appendix W) | the target's; Linear counts `linearWritesPerHour` | the target's own | yes |
| wait | per kind; timed-out | none | reconciled after a restart (§7.3) | turn end, session free, time |
| notify | sent | a notice from core's notifier (`packages/core/src/notify.ts` 184) | best-effort; never fails a run | yes |
| split | — | none | none | yes |
| raise | raised; `event` | an outbox row (W28) | never fails | yes |
| ask me | yes, no | a core approval | lapses to no | **0.37** |

### 6.1 Route
- **Inputs:** the step's pointers (mapped fields only) and its approved candidates.
- **By hints first, deterministic:**
  - the sender's address domain;
  - the Slack conversation id;
  - a person's handle the project lists.
  - One match is `chosen` with reason `hint:<kind>`. Several go to the judge.
- **By judge:** one yes-or-no per remaining candidate, "Is this message about the project <name>: <profile>?", on the
  step's judge, budget and bar.
  - The highest yes above the bar is `chosen`, and none is `none`.
  - Two within 0.05 of each other, or the best between the unsure bar and the yes bar, is `unsure`.
  - At most 8 calls per run.
- **Outputs are closed words and ids.** They never quote the message.

### 6.2 Find a session
- **In a project:** a relay session whose realpath `cwd` is one of the chosen candidate's approved folders, or a worktree
  this run made.
- **In a worktree, a folder or a lane:** as the session target finds today (`session-dispatcher.ts` 353–389).
- **In this conversation** (`{ thread: true }`): the session that took an earlier message in the same thread, from
  core's take store, matched to a relay session by its Claude Code session id (W36).
- **Which one:** the provider must match. Of several, the most recently active wins. With `only: 'idle'`, busy sessions
  are passed over, so the outcomes are `idle` or `none`. This is the prototype's "Find another session".
- **Outcomes:**
  - `idle`: no active turn;
  - `busy`: `activeRunId` is present;
  - `none`;
  - `watched`: a window the relay only watches, which takes no prompt (`relay-client.ts` 308–314).

### 6.3 Start a session
- **The call:** `POST /v1/sessions { provider, cwd, requestedMode, title }` (api-contract 609–630).
  - The title is fixed: `Agent Comms · <workflow> · <run, 8 characters>`.
  - Activation and dispatch both check the folder: inside the relay's allowed roots, outside Agent Comms' own folders
    (`agent-sessions.ts` 226–270).
- **A run starts at most one session per start step.** A retry adopts the one it made (§7.4).

### 6.4 Deliver to a session
- **The prompt** is the session target's fixed frame (`packages/events/src/context/index.ts` 414–431). Its context parts
  add `{ step: <id>, field }` for a closed output, labelled "from Agent Comms".
- **`startId`** comes from the delivery's id, so a retry makes no second turn.
- **`report`:** the turn is started with `outputFormat` `{ outcome: <the listed words>, summary: string ≤ 2,000 }`. The
  turn's `structured.final` (api-contract 250) is read when it ends, and the summary is sealed in the run's record.
- **The session the flow chose** (`to.session`): the first of the named find or start steps whose output holds a
  session. It is recorded on the delivery when it is inserted, so the dispatcher doesn't look again.

### 6.5 Wait
- **For a turn's end** (`turnEnd: <deliver step>`): the turn that step made.
  - It ends on `run.completed|failed|cancelled|interrupted` (api-contract 241–244).
  - Without `report`, the outcome is `completed`, `failed` or `stopped`. With it, the reported word, or `failed` when the
    turn ended without one.
  - A turn waiting on the person in claude-stream keeps waiting, and the run view says "Needs you in claude-stream".
- **For a free session** (`sessionIdle: <find step>`): `free` when that session has no active turn. It is the
  prototype's "Queue for the session", at most 2 hours by default. A turn that starts in the gap before the deliver step
  leaves that delivery in the busy queue, as today.
- **For a time:** `elapsed` after `afterMs`.
- **`timed-out`** at `timeoutMs`, which every wait has, within `runMs`.
- **The designer's defaults** are the prototype's: a free session 2 hours, a turn's end 1 day.

### 6.6 Worktree
- **Where:** `<worktreeRoot>/<branch slug>`. `worktreeRoot` is the approved candidate's, by default `<checkout>-wt`
  beside the checkout (Q8). `.claude/worktrees` inside the checkout may be chosen instead (save-deny's exception).
- **The branch:** a template of closed slots only, by default `ac/{{steps.<issue>.identifier}}`, else `ac/{{run}}`. It
  is folded to `[a-z0-9/-]`, at most 60 characters, and never holds a field from the message.
- **The command:** `git -c core.hooksPath=/dev/null -C <checkout> worktree add -b <branch> <path> <base>`.
  - It runs through `execFile` at git's absolute path, with no shell and an environment scrubbed of `GIT_*`.
  - It has a 60-second timeout and capped output, as `runtime/relay-listener.ts` 1–25 does.
  - Hooks are off because `core.hooksPath` may point into the repository.
- **The jail:**
  - the checkout is one of the approved folders;
  - the root is inside the allowed roots and outside Agent Comms' folders;
  - the path is the root plus one slug;
  - after creation, `realpath(path)` must equal the computed path, or the worktree is removed and the step refused.
- **Idempotency:** `workflow_worktrees` records the path, branch and run before git runs.
  - A retry that finds the worktree adopts it.
  - A branch that exists and wasn't made by this run is `refused`.
- **Cleanup:** `keep` (the default), or `remove-if-clean` when the run ends.
  - It runs `git worktree remove` without `--force`, only when `git status --porcelain` is empty and the branch has no
    commit its upstream lacks.
  - Otherwise the worktree is kept, and the run view says why.

### 6.7 Linear
- **Create** is today's target, unchanged.
- **Change** (`linear-change`) acts on `to.issue`, the create step's issue. Each try reads the issue first, as create does
  (`linear-dispatcher.ts` 35–38).
  - **A comment** uses `commentCreate` with an id chosen from the delivery's, as `linearIssueId` chooses one
    (`linear-target.ts` 235–245). Whether `CommentCreateInput` takes `id` is checked against Linear's schema in the
    first build step. Without it, a comment carries a footer with the delivery's short id, and a retry looks for that
    footer first.
  - **A state, labels or an assignee** use `issueUpdate`, which a second try repeats harmlessly.
- **Slot values** are quoted blocks labelled by who wrote them (`linear-target.ts` 268–290). A summary is labelled
  "Written by an agent, not checked".

### 6.8 Notify
- **What it says:** the person's words and closed slots only, since a notice can show on a locked screen.
- **How often:** once per step per run.

### 6.9 Raise an event
See W28. Its event is raised whether or not anyone subscribes. A chained workflow may start from it (W34).

## 7. Runs

### 7.1 States
- **A run:** `held` → `running` ⇄ `waiting` → `done` | `failed` | `cancelled` | `expired`.
- **A step:** `ready` → `running` → `waiting` → `done` (an outcome) | `failed` (a code); `skipped`; `cancelled`.
- **A step is `skipped`** when the run can no longer reach it. This is worked out at each settle, from the steps still
  ready, running or waiting.

### 7.2 What is kept
- **Sealed in `workflow_runs`:** the mapped values, a session's summary and a chained run's `/trigger` data.
- **Sealed per delivery:** each delivery's own context, as today.
- **Sealed per event:** each event, until it is delivered.
- **Content-free:** outputs, waits, counters and the event ledger.

### 7.3 After a restart
- **Expired leases are claimed again,** as `recoverLeases` does (`session-dispatcher.ts` 213–221).
- **Turn and free-session waits** re-arm the relay follower, which reconciles each session's snapshot on every
  (re)connect (`session-queue.ts` 262–276). A turn that ended while the service was down resolves then.
- **Time waits** fire at the first tick.
- **Outbox rows** are delivered by the next tick, since they were written in the settle's transaction.

### 7.4 Idempotency keys
- **A turn:** `startId` from the step's delivery id (api-contract 136–143, 1018–1020).
- **A session.** `POST /v1/sessions` takes no client key, so:
  - the step records "starting" before the call;
  - a retry lists sessions and adopts the one with this run's title marker and `cwd`;
  - two with the marker: the newer is adopted, and the other is named in the run view.
- **A Linear issue:** `linearIssueId(deliveryId)`. **A comment:** §6.7.
- **A worktree:** §6.6.
- **A notice:** once per step per run, recorded before it is raised.
- **An event:** its id is made in the settle's transaction. A delivery's key is `(event, subscriber, version)`.

### 7.5 Bounds
- **Per run:** 64 executed steps (`STEP_LIMIT`), one session per start step, one worktree per worktree step, and the
  deadline `runMs`.
- **Per hour and day:** the version's `limits`, counted in `workflow_effects`. A reached limit holds a step; it never
  drops one. Events are the exception (W33).
- **Ceilings across all workflows** (`workflow_settings`): 16 concurrent runs, 10 sessions started an hour, 20
  worktrees a day, 1,000 events an hour. They are fixed in 0.36. They are stored so that a later command can lower
  them (a tightening) without a migration.
- **Today's `deliveryRateCap`** still caps each workflow's deliveries (`delivery-claim.ts` 148–161).

### 7.6 Cancel and pause
- **`runs cancel <id>`** is the person's, a tightening, and applies at once:
  - deliveries still waiting are cancelled and their records purged, as `session-queue drop` does
    (`session-queue.ts` 102–128);
  - its undelivered events are cancelled;
  - its waits are dropped, its record is purged, and the run is `cancelled`.
- **A session's turn is interrupted only with `--interrupt`** (`POST /v1/runs/:id/interrupt`, api-contract 1635–1638).
- **Pause** stops claims. Waits keep listening, and events already raised keep going out.

### 7.7 Trying a workflow
- **`workflow test <document> <example> [--outcome <step>=<outcome>]…`** runs the graph against a catalogue example, as
  `rule test` does (`operations/rule-test.ts` 5–12). It does no I/O:
  - each step answers with the outcome given, or its first;
  - the result is the path, each effect's line as "would have…", each prompt and issue as written with its envelopes,
    and each event "would raise <type>", with its data.
  - It is on both the CLI and MCP, since it holds no real content.
- **`workflow test-retained <event-id> --workflow <id> --version <n>`** runs a draft on a recent message. It is the
  person's, as today (`b3-contract.ts` 180–185):
  - judges, route and find run for real;
  - every effect and event is "would". This is the prototype's test run.
- **Shadow** (`flow.shadow: true`) is a version approved like any other:
  - real events, route and find (which only read);
  - every start, worktree, Linear write, prompt, notice and raised event becomes a dry-run record;
  - waits end at once as `timed-out`.

## 8. Projects and routing

### 8.1 A project
- **What it is:** a GitHub repository, its folders on this Mac (checkouts and their worktrees), a profile, and hints.
- **Who changes it:** only the person, at the CLI or in the app. An agent never reads the list (taking design T7).
- **Adding one:**
  1. **Find it.** `project scan` walks the relay's allowed roots, else `~/work` and `~/code`, to depth 4:
     - it follows no symlink, and skips hidden folders except `.claude/worktrees`, and skips Agent Comms' folders;
     - it groups the checkouts by the GitHub repository their `remote.origin.url` names, in https or ssh form;
     - it lists each checkout's worktrees from `git worktree list --porcelain`.
     The person picks a repository, or types `owner/name`.
  2. **Tick its folders.**
  3. **Write the profile.** The person writes it. Analyse comes in 0.37.
  4. **Add hints:** sender domains, Slack conversations, handles.
- **`gh` waits for later.** The draft had the app list repositories with `gh repo list`. A repository with no checkout
  here can't be worked on until Agent Comms can clone one, so 0.36 lists what is on this Mac and runs no new program.

### 8.2 The profile
- **The person writes it,** at most 2,000 characters.
- **0.37:** Analyse, through claude-stream, in `plan` mode, with the draft's terms (Q6, Q7).

### 8.3 Routing
- **Routing is the `route` step.** Outside workflows nothing routes. Lanes (0.31) and taking (0.35) are unchanged.
- **Hints are deterministic and free,** so most messages never reach a judge.
- **The judge provider receives** the profile and the fields the step names, and the preview says so.
- **The story's "because" is closed words:** "its sender's domain is one acme-site lists", or "Jev said yes at 0.86 to
  acme-site's profile". It never quotes the message.

## 9. Events, subscribers and chaining

### 9.1 Raising
- **Where it happens:** every step transition goes through one hook, `WorkflowEventSink.emitInTransaction`, inside the
  engine's transaction. The transitions are claim, wait, retry, settle and skip. Run transitions go through the same
  hook.
- **What the sink does:**
  - writes nothing for an event that isn't ticked;
  - for a ticked one, builds the CloudEvent (Appendix W.2);
  - seals it in `workflow_events`;
  - adds one `event_deliveries` row per active subscription whose pattern matches;
  - adds one `workflow_chain_requests` row per active chained workflow whose `on.raised` matches, for the run's message,
    while the run's depth is under 3;
  - charges `eventsPerHour`.
- **It is synchronous and fails closed.** An event over the limit isn't written, and the step settles all the same.

### 9.2 Delivering
- **`EventDispatcher`** claims `event_deliveries` rows like deliveries: an attempt, a lease, ordering per subscriber.
  Before anything leaves, it fences W35's two authorities again.
- **To a live subscriber:**
  - it writes the frame, as this subscriber may see it, to `event_stream_log`;
  - it pushes the frame to the listener's open SSE and WebSocket streams;
  - it settles `delivered`.
  - A subscriber with no stream open is still `delivered`: the log is its replay.
- **To a webhook subscriber:** it posts through the webhook transport (W32), and settles or retries as a webhook
  delivery does.
- **The Deliveries screen** gains the subscriber's deliveries under it. **Retry and drop** work as for deliveries:
  `delivery retry|drop <event>:<subscriber>`.

### 9.3 Chaining
- **The evaluator's one change.** For a workflow with `flow.on`, it doesn't decide when the message's projection arrives.
  - **It waits** for a `workflow_chain_requests` row for that message and version, or for `withinMs`.
  - **When a row comes,** it runs the ordinary gate and mapping, and makes the run with `parent_run_id`, `depth` and the
    sealed `/trigger`.
  - **At the deadline,** it commits `not-chained`, content-free, and purges the projection.
- **The source cursor isn't held.** A message whose chained workflow is waiting must not hold back any later message.
  This is tested; holds already keep content past admission the same way (`runtime/holds.ts`).

### 9.4 Who sees what

| | Workflow's events | Its declared `fields` | Folder paths |
|---|---|---|---|
| Subscriber, `content: none` | in its namespaces, by its patterns | never | never |
| Subscriber, `content: enveloped` | the same | enveloped, pointers listed | never |
| A chained workflow | the raised event's closed `data` as `/trigger` | never: it maps the message itself | never |
| The run view (the person) | every event and its deliveries | not shown | yes |

## 10. Security

### 10.1 Who can do what

| Act | The person (CLI, app) | An agent (MCP, its shell) |
|---|---|---|
| Write a workflow (`workflow create\|update`), check one (`workflow check`) | yes | yes: prepares or checks a version, nothing more |
| Approve a workflow version | yes: the challenge, or the attested app | never (`mcp/server.ts` 348–353) |
| Try (`workflow test`) | yes | yes: catalogue examples only |
| Try on a retained message (`workflow test-retained`) | yes | never (an exception row, as today) |
| Describe it (`workflow describe`) | yes: a draft, written nowhere | never (an exception row) |
| Runs: list, show, cancel | yes | never (exception rows) |
| Projects: add, scan, edit, remove | yes | never (exception rows) |
| Subscriber: add, update (inert), enable (prepare) | yes | yes: prepares, never approves |
| Subscriber: approve, token, secret, secret URL | yes | never (exception rows; the secrets are terminal-only) |
| Subscriber: remove, lower a limit, disable | yes, at once | as today (a tightening) |
| The step event catalogue | yes | yes (content-free) |

- **The app's speed bump is 0.34's.** On macOS the app approves what it started, attested by `codesign` on the parent
  pid (`packages/core/src/desktop-origin.ts` 86–125). Elsewhere the person approves in Terminal. It is a speed bump
  against agents, not a boundary against code running as the person, and the docs say so.
- **The exception rows** refuse in three places:
  - the MCP server's process (`AGENTCOMMS_MCP_SERVER`, `targets/queue.ts` 11–30);
  - an agent's shell (`agentMarker`, `packages/core/src/cli-runtime.ts` 125–139);
  - on macOS, a process the app didn't start (`personSetupOrigin`, `cli/program.ts` 830–899).
  - Each exits 10 (`packages/core/src/errors.ts` 13).

### 10.2 The approval's preview
- **The workflow's plain words** (`describeRule`), then one numbered line per step that does something, from
  `describeFlow`, in `plain`, `value` and `untrusted` parts (`describe-rule.ts` 1–14).
- **Each line names everything that matters:**
  - every folder a session may work in, with its provider and mode in words (`session-target.ts` 54–58);
  - every worktree root and branch template, and that git runs as the person without the repository's hooks;
  - each Linear team, label, state and assignee;
  - which fields go to a session, a judge, a webhook or Linear;
  - every event the step raises, by name, with what it carries, and "to subscribers given acme, and workflows that start
    on it";
  - the limits;
  - what happens on `none`, `failed` and `timed-out`.
- **For a chained workflow:** which events start it, from which workflows, and how long it keeps each message's
  projection.
- **For example:** "4. When it has made the issue, raises acme.client-asks.issue.created, with the issue's id,
  identifier and link and the project's name: nothing a sender wrote."
- **A subscription's preview** is W29's.

### 10.3 Folders and processes
- **Sessions** work only in approved folders and run-made worktrees.
- **Git:** see §6.6. It never uses `--force`, and never fetches or pushes.
- **The event service runs no other new program.**
- **Describe it's local `claude`** runs in the CLI process the person started, never in the event service (§11.4).
- **Network:** live events stay on the loopback listeners. Webhook subscribers reach only their approved address sets,
  as webhook targets do. There is no other new address.

### 10.4 Untrusted content
- **Mapped sender values** reach a prompt only in `wrapUntrusted`'s envelope (`session-dispatcher.ts` 439–452), a Linear
  text only in labelled quoted blocks, and an event only per W27.
- **They never reach** a branch name, a path, a title, a notice, a step's outputs, an automatic event, the story, or a
  subscriber without `content: "enveloped"`.
- **Agent-written text is outside text** wherever it is shown or passed on: a session's summary, a profile, and
  everything Describe it returns.
- **Branches turn only on closed words.**
- **The send gates, behaviour rules and standing approvals are unchanged** (W16).

## 11. Surfaces

### 11.1 Commands

Every row is in `capabilities.json` and run by `pnpm verify:parity --strict`. B3 v1 gains the wires additively (W19).

| Command (alias) | MCP | Status | Operation |
|---|---|---|---|
| `workflows list` (`rules list`) | `events_rules_list` | both | `rulesList` (renamed `cli`) |
| `workflow show\|create\|update\|enable\|disable\|remove\|test` (`rule …`) | `events_rule_*` | both | as today (renamed `cli`); `workflow show` gains `--version <n>` |
| `workflow test-retained\|analyse\|approve` (`rule …`) | — | exception | as today (renamed `cli`) |
| `workflow check <document>` | `events_rule_check` | both | `ruleCheck` |
| `workflow describe [--provider claude-cli\|openrouter\|anthropic] [--draft -]` | — | exception | `workflowDescribe` |
| `runs list [--workflow <id>] [--state <s>]` | — | exception | `runsList` |
| `runs show <run-id>` | — | exception | `runShow` |
| `runs cancel <run-id> [--interrupt]` | — | exception | `runCancel` |
| `projects list` | — | exception | `projectsList` |
| `project show\|add\|update\|remove` | — | exception | `projectShow`, `projectAdd`, `projectUpdate`, `projectRemove` |
| `project scan [--root <path>]…` | — | exception | `projectScan` |
| `workflow-events list` · `workflow-events show <schema>` | `events_workflow_events_list` · `_show` | both | `workflowEventsList`, `workflowEventsShow` |
| `subscriber enable <id> <version>` | `events_subscriber_enable` | both | `enableSubscriber` |
| `subscriber approve <approval-id> --digest <d>` | — | exception | `approveSubscriberFromApp` |
| `subscriber url set <id> --version <n>` | — | exception (secret) | `subscriberUrlSet` |
| `subscriber secret create\|rotate <id> --version <n>` | — | exception (secret) | `subscriberSecretCreate`, `subscriberSecretRotate` |

- **`runs`, not `run`:** `agent-events run` already starts the service (`cli/program.ts` 320).
- **The app** gets an allow-list row for each, with its arguments checked in Rust (0.33 §3.7), gated at 0.36.0.

### 11.2 The desktop app: where things are
- **Events → Workflows:** the one list, which replaces today's Rules tab (`apps/desktop/src/screens/Events.tsx` 80).
  - Every workflow is listed, straight line or graph, with its version, approval, runs this week and last run.
  - **New workflow…** offers: from your words, an empty canvas, or a copy.
  - The sidebar gains **Workflows** under Events, opening this tab, as the prototype draws it.
- **A workflow:** its designer (§11.3), its Runs, and its versions.
- **Events → Subscribers:** each subscriber, its kind, what it receives, its state, its listener or address, and its
  backlog. **Add a subscriber…**, **Approve…**, **Remove**.
  - Tokens and secrets are made at the terminal ("Open in Terminal"), as today's secrets are.
- **Projects** in the sidebar: projects with their folders, the sessions working in them (busy or idle, from the
  relay), the profile with Edit, and Add a project….
- **The run view:**
  - the version's graph, its taken path lit (`SignalEdge` live, `NodeCard` state);
  - each step's time, outcome and wait ("Waiting for acme-site · Claude Code, 1 ahead", "Needs you in claude-stream");
  - the events it raised and who received them;
  - Cancel.
  - It is opened from a workflow's Runs, from Deliveries, and from a message's story. It polls `runs show` every 2
    seconds while the run is live. The app opens no socket or stream: the window's fetch, WebSocket and EventSource are
    refused (`apps/desktop/src/test/repo-rules.test.ts` 82–90; `src-tauri/tauri.conf.json` 15).
- **Messages:** `TouchKind` (`apps/desktop/src/messages/join.ts` 34–43) gains `routed`, `issue-made`, `session-found`,
  `session-started`, `worktree-made`, `given`, `turn-ended`, `issue-closed`, `event-raised` and `run-ended`.
  - The story reads: "Workflow client-asks › Project acme-site (its sender's domain) › Issue ACME-123 › Session started
    in ~/work/acme-site-wt/ac-acme-123 › Given 11:20 › Turn ended 11:39: done › Issue closed".
  - It is read from `runs list --json`, joined by event id.

### 11.3 The designer
- **The stack:**
  - React Flow, `@xyflow/react` ^12.11.3, added to the app's dependencies. It is the range cue-ui 0.34.0 declares, as an
    optional peer (`package.json` 157, 188–190).
  - Through `@cueplusplus/ui/flow` (exports 87–91): `useFlowTheme`, `NodeCard`, `NodeHandle`, `SignalEdge`,
    `FlowBackground` and `FlowControls`.
  - The stylesheets load in cue-ui's order: `@xyflow/react/dist/style.css`, then `@cueplusplus/ui/flow.css`.
- **Canvas and document (W20):**

  | Canvas | Document |
  |---|---|
  | the gate nodes: Trigger, Condition, Judge, Keep | `source` and `event`, `condition`, `agentic`, `mapping` |
  | a node, by its React Flow id | a step, by its id |
  | a node's type | the step's `kind` |
  | a source handle | one of the kind's outcomes, `otherwise`, or a split's branch |
  | an edge | an arrow, `next[outcome] = <step id>` |
  | a handle with no edge | the outcome stops (`end`), drawn as a small "Stops" mark |
  | a step's settings, Events part | `emit` |
  | the workflow's settings | `flow.limits`, `flow.events`, `flow.on`, `shadow` |
  | a Deliver node's settings | its target version in `targets`; a change makes a new target version on Save, as 0.33's submit does (`rule-editor/submit.ts` 61–88) |

  - **Nodes:** `NodeCard` tones are input (the trigger), processing (engine steps) and output (effects). A step that
    fails a check shows a warning chip. A step that emits shows a small mark with the count ticked.
  - **Settings:** a node opens the same controls as `RuleVisual` (`apps/desktop/src/screens/events/RuleVisual.tsx`
    1–6). Each kind has its own, and an Events part with one tick per Appendix W event, all off by default. A field with
    no control is "edited as text", and left as it is.
- **The palette** is an app panel beside the canvas, outside React Flow, grouped as the prototype draws it
  (`WorkflowDesigner.dc.html` 850):
  - **Decide:** Condition, Ask a judge, Which project?, Side by side (`split`);
  - **Sessions:** Find a session, Find this conversation's session (W36), Start a session, Make a worktree, Deliver to a
    session;
  - **Linear:** Create, Update, Comment, Close;
  - **Hand over, and tell:** Put it in the Queue, Send to a webhook (an existing one), Notify me, **Raise an event**;
  - **Wait:** for a session's turn to end, for a session to be free, for a time.
  - The prototype's Branch is a Condition's two ports. Its Reply waits for later.
- **Drag and drop:**
  - `dragstart` puts the kind on the drag's data;
  - the canvas's `onDrop` turns the pointer into a place with `screenToFlowPosition({ x: clientX, y: clientY })`;
  - it adds a step with a fresh id (`<kind>-<n>`), the kind's defaults and no arrows, and keeps the place as its
    position;
  - a dropped step stays invalid, and Save stays off, until its fields pass the checks.
- **Connecting:** `onConnect` writes the arrow. `isValidConnection` refuses a cycle, a second arrow from one outcome, and
  two branches of one split meeting, using the same `checkFlow` the event service runs.
- **Deleting** a node turns each arrow into it into `end`. Its target leaves `targets` when no other step uses it.
- **The three views in step:**
  - there is one document, and one undo stack of whole documents;
  - **canvas → document:** each change is a pure function from the old document to a new one. A drag changes the kept
    positions only;
  - **text → document:** each edit is parsed. When it parses, the document is replaced. When it doesn't, the canvas keeps
    the last good document, dimmed, with "The text has a mistake on line 12";
  - **document → text:** `printRuleText`, which reads no position;
  - **JSON:** the canonical document, read-only.
- **Positions** are kept in the app's settings, by workflow id and step id. A step with no position is placed in layers
  from `start`, sized from `NodeCard`'s fixed height. This is a small function in the app, with no layout library.
- **Approve…** shows §10.2's list and the typed name (0.33 §3.1), beside the graph laid out afresh (W20). It shows what
  changed since the last version.
- **Try it:** `workflow test`, with an outcome picker on each node and the taken path lit.
- **The bundle:** React Flow's stylesheet must pass `check:bundle`. It allows no remote address, no `data:` font, and no
  file over 3 MiB (`apps/desktop/scripts/bundle-check.mjs` 38, 350–368).

### 11.4 Describe it

**What the person does.** In the designer, **Describe it…** opens a box: "Say what should happen, in your words." The
person picks who drafts it:
- **Your Claude subscription** (`claude` on this Mac, signed in), the default when it is found;
- **OpenRouter** or **Anthropic**, with the key already kept for Analyse (`domain/analyse-model.ts` 3–64).

**What comes back** is shown in the designer and saved nowhere:
- **the draft:** the text, opened in the three views like any edit;
- **where each step came from.** The model answers `{ text, notes: [{ step, words }], questions: [{ step | null,
  question, choices? }] }`.
  - A note's `words` must be an exact piece of the description, or the note is dropped.
  - A step with no note is marked "Added by the model, not from your words."
- **questions:** at most 5, each with up to 4 choices. The answers are added to the description, and the current draft
  goes along, so each round changes only what it must.
- **the checks:** the parse errors, then `workflow check`'s.

**What is sent to the model,** said under the box before anything is sent:
- the person's words, at most 4,000 characters, and their answers;
- a fixed brief, and the text's words for the steps this release has, from `GRAMMAR.md`, versioned with it;
- the names a draft may use: account aliases and their channels, lane names, judge ids and kinds, target ids and kinds,
  project ids and names, the step event words and the person's namespaces, and, with a Linear key, team keys, label
  names and state names;
- when asking again, the current draft's text.
- **Never:**
  - any message's content, unless the person pastes it. It is then sent inside the untrusted envelope, marked as an
    example;
  - profiles and folders. The prototype drew profiles as sent; this spec keeps the draft's choice, because a profile is
    model-written and names clients, and a draft needs only the names;
  - counts, a target's URL, templates, subscribers, secrets or any key or token.

**How it runs:**
- **With a key:** in the event service, on Analyse's pinned transport and bounds: a 64 KB request, a 256 KB response, a
  4,096-token answer and 60 seconds (`analyse-model.ts` 58–64).
- **With the person's Claude subscription:** in the CLI process the person started, never the event service.
  - `claude -p --output-format json`, with the prompt on stdin;
  - `execFile` at an absolute path: on `PATH`, or `~/.claude/local/claude`, `~/.local/bin/claude`,
    `/opt/homebrew/bin/claude` or `/usr/local/bin/claude`;
  - no shell, in an empty owner-only temporary folder that is removed afterwards;
  - with no tools, no MCP servers, and as little of the person's own settings and hooks as the CLI allows. The flags are
    checked against `claude --help` in the build's first step, and pinned in one file;
  - with a 120-second deadline and the response capped at 256 KB.
- **Refused:** a draft holding `raw` lines. A model's draft must say every step in words.

**Why an agent can't reach an approval through it (W21):**
- `workflow describe` is an exception row.
- It writes nothing.
- A draft becomes a version only on the person's Save, and is enabled only by their approval.
- The model has no tools.
- A pasted message that tells the model to add a step shows as a step on the canvas and as a line in the approval.

## 12. Tests

Every test runs with:
- a stand-in home (`test/support/temp-home.ts` 9–11) and an empty config folder;
- a stand-in secret store, either the file store (`selectEventSecretStore(db, 'file')`, `store/event-secrets.ts` 308) or
  an in-memory keyring (as `test/b3-secret-migration.test.ts` 21–62 builds). Never the system Keychain;
- the fakes: `test/support/fake-relay.ts`, `fake-linear.ts`, `fake-model-provider.ts`, `loopback-receiver.ts`, and a
  fake `claude` on a temporary `PATH`;
- temporary git repositories.

Nothing reads the real relay token or config, and nothing talks to Linear, Slack, Gmail, Resend, Anthropic or OpenRouter.
The loopback seal (`test/helpers/loopback-seal-preload.mjs`) holds. Event-service tests skip on Windows with
`WINDOWS_SKIP` (`test/support/short-temp.ts` 14–16). A spawned child gets its `--import` and `import()` paths as
`pathToFileURL(…).href` (`test/support/laya-mutants.ts` 109–113, pinned by `test/laya-mutations.test.ts` 802–815).

- **Documents:**
  - every existing fixture keeps its bytes and digest;
  - every refusal of §4.1;
  - an unknown top-level key is refused;
  - limits are written out in full;
  - an `emit` word outside its kind is refused.
- **Text:** the round trip and stable printing for flows. The property test is extended to generated graphs, with events
  and `on`.
- **Engine:**
  - one test per outcome of each step;
  - merges, splits and skips;
  - held runs start in order;
  - limits hold and resume;
  - 64 steps fail with `STEP_LIMIT`;
  - expiry purges;
  - cancel cancels waiting deliveries and undelivered events.
- **Crashes:** a failpoint at every transaction edge of each effect, as `test/cutover-failpoints.test.ts` does. A restart
  makes no second session, turn, issue, comment, worktree or event, and adopts the one it made.
- **Waits:**
  - a turn that ends while the service is down;
  - a relay journal reset;
  - a repeated run end;
  - a timeout;
  - a session that comes free.
- **Worktrees:**
  - a repository whose `core.hooksPath` hook writes a marker: the marker is never written;
  - a symlinked root is refused;
  - an existing foreign branch is refused;
  - `remove-if-clean` keeps a dirty or unpushed tree.
- **Events:**
  - nothing is raised when nothing is ticked, and one row per ticked event otherwise;
  - the CloudEvent's attributes, by value;
  - no folder path and no sender text in any automatic event, asserted by value with sentinels;
  - `fields` only for `content: "enveloped"`, inside the envelope;
  - `*.*.*.failed` matches only the namespaces given;
  - the limit and backlog bounds;
  - a run never waits for a subscriber: a webhook subscriber that hangs leaves the run's timing unchanged.
- **Subscribers:**
  - an inert version receives nothing;
  - the approval preview;
  - SSE and WebSocket on one listener, with the same Host, query, cookie and Origin refusals;
  - a bearer in the header, and as the browser subprotocol;
  - replay after `Last-Event-ID` and `agentcomms.after.<id>`;
  - a rotation closes with 4401;
  - a client data frame closes with 1008;
  - a webhook delivery signed with the current and overlap secrets, with a stable `webhook-id`;
  - revoke cancels the backlog;
  - a browser test of both transports, beside `test/support/browser-sse-fixture.ts`.
- **Chaining:**
  - a child starts once per message;
  - A → B → A doesn't loop;
  - depth 3 starts nothing;
  - the child reads the message through its own mapping;
  - `not-chained` at the deadline purges;
  - a waiting child holds back no later message.
- **Security:**
  - every exception row exits 10 inside the MCP marker and an agent's shell;
  - no MCP tool approves anything;
  - a Linear change can name only the run's own issue.
- **Parity:** every new row passes `pnpm verify:parity --strict`.
- **Describe it:**
  - the request holds exactly §11.4's parts, asserted by value;
  - a pasted example arrives enveloped;
  - a note quoting words not in the description is dropped;
  - a `raw` line is refused;
  - nothing is written;
  - exit 10 in the MCP marker and an agent's shell;
  - the CLI runs with no shell, no tools and no MCP servers, in an empty folder that is gone afterwards.
- **Desktop:**
  - pure tests of `flowOf`, layout, and the canvas and document functions. A drag leaves the document's bytes unchanged;
  - a drop at a `screenToFlowPosition` place;
  - text that doesn't parse leaves the canvas on the last good document;
  - `isValidConnection` through `checkFlow`;
  - event ticks write `emit`;
  - the run view's lit path;
  - Rust tests of each allow-list grammar;
  - the version gate;
  - the bundle check.

## 13. Phasing

**0.36.0, a minor.** It contains:
- the `flow` document, the text, `checkFlow`, `describeFlow` and `flowOf`;
- condition, judge, split, route (hints and judge), find and start a session, worktree, deliver, the three waits,
  notify, and raise;
- Linear create, comment, change and close;
- runs, cancel, `workflow test`, `test-retained`, shadow and `workflow check`;
- projects: scan, hand-written profile, hints;
- events from every step and from runs, the catalogue, subscribers (SSE, WebSocket, webhook) and their approval;
- chaining, which can slip on its own (W34);
- the designer, the run view, Projects, Subscribers and the story;
- Describe it, on all three providers;
- the one-concept naming;
- find by thread, and a flow's delivery offering the message to its session (W36).

**0.37:**
- `ask me`, and `acceptEdits` in the person's own checkout after it;
- Analyse for profiles through claude-stream (Q6, Q7);
- waiting for a Linear state;
- adding projects through `gh`, with clone;
- the prototype's worktree removal 7 days after the issue closes;
- a command to lower the ceilings of §7.5.

**Later:**
- the prepared `reply` step;
- routing by meaning on this Mac (with local search's model);
- triggers beyond the catalogue;
- events shared between Macs.

## 14. Risks and known limits

- **A graph is harder to approve than a list.** §10.2's numbered effects carry the approval. A preview over 20 lines is a
  sign to split the workflow, and the designer says so.
- **Spend.** Each started session uses the person's subscription. The limits default low.
- **A prompt carries a sender's words to an agent that can act.** The defences: manual mode by default, never
  `bypassPermissions`, and edits only in a run-made worktree in 0.36. "Don't push" in an instruction is a request, not a
  control.
- **A turn's end is not work done.** Only a Claude session's reported word says "done".
- **Events leave the approval's sight once delivered.** A subscriber off this Mac keeps what it receives. The
  subscription's preview names the address, and content stays off unless the person ticks it.
- **The browser subprotocol carries the token in a request header,** as `Authorization` does. It is accepted only from an
  `Origin` the subscriber lists. The listener is loopback-only.
- **Starting listeners is new behaviour.** A subscriber someone created before 0.36 gets a listener only when an active
  workflow targets it or it has an approved subscription (W31).
- **A chained workflow keeps message projections for up to `withinMs`.** The preview says so, and it defaults to 1 day.
- **`workflow show` returns every version's document.** Several large versions can pass the 64 KiB control frame, as a
  workflow with several large judges already can. `--version <n>` reads one, and the app uses it.
- **claude-stream gaps:**
  - no create key on `POST /v1/sessions` (§7.4 adopts by title);
  - no status or `cwd` filter on `GET /v1/sessions`, so find costs one snapshot per candidate, at most 8;
  - `outputFormat` is Claude's alone.
- **Linear:** comment idempotency is unconfirmed (§6.7). States differ per team.
- **Git:** `worktree add` on a large repository can be slow (a 60-second cap). LFS smudge filters run, since they come
  from the person's own git config. Network volumes are untested.
- **Two schedulers in one owner.** The engine reuses the delivery claim and fences rather than copying them.
- **The `claude` CLI's flags may change between releases.** They are pinned in one place and tested against a fake. A
  CLI that refuses them makes Describe it say so and offer a key.
- **React Flow is a large dependency for one screen.** It loads only with the designer's chunk.
- **On Windows and Linux** every person's act is done at a terminal, as today. The event service doesn't run on Windows
  in this release.

## 15. Questions

The draft's fifteen are answered in §0.3. None is open.

**To ask claude-stream for:**
- a create key on `POST /v1/sessions`;
- a status field and a `cwd` filter on `GET /v1/sessions`;
- `outputFormat` for Codex.

## Appendix W. The step event catalogue, version 1 (normative)

This appendix is the complete version-1 contract for events a workflow raises. Its rules:
- **It is separate from Appendix A** of the local-event-emission design, which stays the contract for source events.
- **Pinned to a fixture.** `@agentcomms/events` exports it as data (`WORKFLOW_EVENT_CATALOGUE_V1`). A test compares that
  data byte for byte with `packages/events/test/fixtures/workflow-events-v1.json`.
- **Changes need a new version.** No implementation may add an event, a `data` field or an outcome word, or widen a
  type, without catalogue version 2.

### W.1 Names

- **A name is `<namespace>.<workflow>.<step>.<event>`.** Each segment matches `^[a-z][a-z0-9_-]{0,31}$`.
  - `namespace` and `workflow` come from `flow.events`.
  - `step` is a step id, or `run` for a run's events.
  - `event` is a word of W.3, or a Raise step's name.
- **Reserved:**
  - the namespaces `agentcomms` and `com`;
  - the step ids `run`, `trigger`, `end` and `otherwise`;
  - the six standard words, which can't be a Raise name.
- **A pattern** has four segments, each a segment or `*`. Its first segment is one of the subscriber's namespaces, or
  `*`. `matchesEventPattern` compares segment by segment, so `*` never spans a dot.

### W.2 The envelope

```json
{
  "specversion": "1.0",
  "id": "wfe_01jbx2k9q7m3t5v8w0y2z4a6c8",
  "source": "urn:agentcomms:<installation id>:workflows:client-asks@5",
  "type": "acme.client-asks.issue.created",
  "time": "2026-10-27T11:20:04.120Z",
  "datacontenttype": "application/json",
  "dataschema": "urn:agentcomms:workflow-events:v1:step.deliver.linear",
  "subject": "wfr_01jbx2k3d5f7h9k1m3n5p7r9t1",
  "agentcommsrule": "client-asks@5",
  "agentcommsrun": "wfr_01jbx2k3d5f7h9k1m3n5p7r9t1",
  "agentcommsstep": "issue",
  "data": {
    "workflow": { "id": "client-asks", "version": 5, "namespace": "acme", "name": "client-asks" },
    "run": { "id": "wfr_01jbx2k3d5f7h9k1m3n5p7r9t1", "startedAt": "2026-10-27T11:19:58.002Z", "depth": 0, "parent": null },
    "step": { "id": "issue", "kind": "deliver", "label": null, "index": 3, "attempt": 1 },
    "path": ["route", "found", "issue"],
    "event": "created",
    "outcome": "done",
    "durationMs": 1840,
    "error": null,
    "outputs": { "delivery": "…", "issue": { "id": "…", "identifier": "ACME-123", "url": "https://linear.app/…" } }
  }
}
```

- **The attributes:**
  - `id` is `wfe_` and 26 lowercase Crockford base-32 characters;
  - percent-encoding of `source` and `agentcommsrule` is as `buildCloudEvent`'s (`cloudevent.ts` 88–101);
  - `agentcommsstep` is absent for run events;
  - `agentcommsuntrusted` is present only when `data.fields` is, listing its pointers, encoded as today
    (`wire/untrusted-extension.ts`).
- **`data`** has exactly these keys:
  - `workflow`, `run`, `step` (null for run events), `path`, `event`, `outcome` (null for `started`, `waiting`,
    `retrying` and `skipped`), `durationMs` (for `succeeded`, `failed` and the outcome words), `error` (a closed code,
    for `failed` and `retrying`) and `outputs`;
  - plus `nextAt` for `retrying`, `wait: { kind, since }` for `waiting`, and `fields` for a Raise step's subscribers
    allowed content.
- **`data.step.label`** is the workflow author's words, at most 60 characters.

### W.3 Events by schema

Standard words: `started` (first claimed), `succeeded` (settled with an outcome that isn't a failure), `failed`
(settled `failed`, or with a failure outcome: `refused`, deliver's `failed`), `waiting` (a wait row written, or a limit
reached), `skipped` (no longer reachable, §7.1), `retrying` (an attempt failed in a way the step retries).

| `dataschema` (after `…:v1:`) | Standard words | Its own words | `outputs` (closed) |
|---|---|---|---|
| `run` | — | `started`, `held`, `finished`, `failed`, `cancelled`, `expired` | `steps` (executed), `endCode` |
| `step.condition` | started, succeeded, skipped | `matched`, `not-matched` | — |
| `step.judge` | all six | `yes`, `no`, `unsure` | `score` |
| `step.route` | all six | `matched`, `none`, `unsure` | `project`, `projectName`, `reason`, `score` |
| `step.find-session` | started, succeeded, failed, skipped, retrying | `found`, `busy`, `not-found`, `watched` | `session`, `provider` |
| `step.start-session` | all six | `session-started`, `refused` | `session`, `provider`, `mode`, `refusal` |
| `step.worktree` | all six | `made`, `refused` | `branch`, `refusal` (never the path) |
| `step.deliver.session` | all six | `given`, `left-in-queue` | `delivery`, `session`, `turn`, `ahead` |
| `step.deliver.linear` | all six | `created` | `delivery`, `issue { id, identifier, url }` |
| `step.deliver.linear-change` | all six | `changed`, `commented`, `closed` | `delivery`, `issue`, `changed[]`, `state` |
| `step.deliver.webhook` | all six | `delivered` | `delivery`, `status` |
| `step.deliver.sse` · `.queue` · `.dry-run` | all six | `delivered` | `delivery` |
| `step.wait` | started, succeeded, waiting, skipped | turn end: `finished`, `timed-out`; free session: `free`, `timed-out`; time: `elapsed` | `for`, `reported` |
| `step.notify` | started, succeeded, skipped | `notified` | `raised` |
| `step.split` | started, succeeded, skipped | — | `branches` |
| `raise` | — | its `name` | `name`, and `fields` (W27) |

- **Mapping outcomes to words.** A word is raised with the outcome it names:
  - `found` is `idle`, `not-found` is `none`, `matched` is `yes` or `chosen`, `session-started` is `started`;
  - `given` and `delivered` are `done`;
  - `created`, `changed`, `commented` and `closed` are deliver's `done`, by what the target did;
  - `finished` is any turn-end outcome other than `timed-out`, with the word in `outputs.reported`.
- **The run's words** are raised when the run enters that state.
