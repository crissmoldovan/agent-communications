# Workflows: rules that branch, wait and finish the job

Date: 2026-10-27. Status: draft, spec only, for the owner's comments. The designer is being drawn in parallel; this is the
mechanism under it. Grounded in a read of `feat/0.35` at 0c653652 (paths are from the repository root) and of
`cueplusplus/claude-stream` at 1379b3f0 (`docs/agent-relay/api-contract.md`, read 2026-10-27). cue-ui's Flow parts were
read in the 0.32.1 checkout; the app pins 0.34.0. **O** = the owner's words. **L** = the lead's default, handed to this
spec. **S** = this spec's own call, for the owner and the lead to confirm.

## 1. Why

**O, 2026-10-27:** "a workflow designer based on a node-style thing: 1. An event comes in. 2. Conditions are set. 3. If
they are met, it continues. 4. It can search for the session and determine which session it is. 5. If it's about that
session, it goes there. 6. If the session is found, it goes there. 7. If not, search for another one. 8. If no session
was found, it goes to create a new session. 9. If it has to create a new session, you should check what project it is
in. 10. It should be creating a separate work tree, optionally or not. 11. On completion, I may also want to say add part
of this behaviour to this workflow, like create a Linear ticket. 12. … create instructions on what the Linear ticket
should contain. 13. When it finishes work, it should actually close the Linear ticket, and so on."

Earlier the same day the owner asked for **Projects** (import a GitHub repository, find its checkouts, analyse it with
their own Claude or Codex, keep a profile) and **routing** (which project and session a message is about; wait when
busy). The prototype draws both (`docs/prototypes/2026-10-26-messages-lifecycle/README.md` 46–76, row 4).

**O, 2026-10-27, relayed by the lead, two additions:**
- **The designer** is React Flow (`@xyflow/react` ^12.11.3) through cue-ui's Flow parts, with drag-and-drop from a
  palette.
- **Describe it:** the person says in plain words what should happen. A model drafts the workflow in the rule text:
  the person's own Claude subscription through the local CLI, or their OpenRouter or Anthropic key, as Analyse uses.
  The draft is checked like any workflow, each step shows the words it came from, ambiguities come back as questions,
  and nothing runs until it is approved.

**What a rule is today.** One straight pipeline, run once per event:
- **The gate:** the source and event, then the deterministic condition, then the optional judge
  (`packages/events-daemon/src/runtime/evaluate.ts` 227–300). The condition runs before any envelope, taint, reservation
  or network call (262).
- **The fan-out:** a match prepares one delivery per target, all at once (`runtime/deliveries.ts` 80–110). Six target
  kinds: dry-run, webhook, SSE, queue, session, Linear (`domain/activation-documents.ts` 55–61).
- **The session target** already finds a session by folder or lane, starts one, queues while busy and posts a framed
  prompt under an idempotent `startId` (`runtime/session-dispatcher.ts` 223–291; 0.33 §3.5–§3.6).
- **The Linear target** creates an issue and nothing else (`runtime/linear-dispatcher.ts` 29–53; 0.33 §2 non-goals:
  "Linear comments or updates (create only)").

**What the thirteen steps need that is missing:**
- **Anything after a delivery.** Nothing waits for a session's turn to end except the busy queue's follower, which only
  lets the next item go (`runtime/session-queue.ts` 223–228).
- **Branches.** Targets are unordered siblings. "If not found, look elsewhere, else start one" can't be said.
- **Projects.** Searched `packages/core/src` and `packages/events-daemon/src` for a project concept: the only hits are
  Google OAuth's `projectId` (`packages/core/src/config.ts` 89) and MCP install scopes. None exists.
- **Worktrees.** None is made anywhere. The one mention is save-deny letting a `.claude/worktrees/<name>` checkout count
  as a project (`packages/core/src/save-deny.ts` 26, 527–538).
- **A Linear lifecycle**: comment, change, close.

## 2. Goals, non-goals, anti-goals

**Goals**
- **A workflow is a graph** of steps with branches, drawn in a node designer or written as text. Each version is
  approved as a whole, and the approval lists every effect in plain words.
- **Every existing rule is a straight-line workflow** with no migration and no new approval.
- **The owner's thirteen steps can be built:** route to a project, find a session (idle, busy or none) and look again
  elsewhere, start one, optionally in a new worktree, give it the message, wait for its turn to end, and create, comment
  on and close a Linear issue.
- **Runs survive restarts,** wait durably (for a turn, a time, the person), time out, can be cancelled, and never repeat
  an effect.
- **The person sees each run:** its graph lit along the path it took, in Events and in the message's story.
- **A whole workflow can be tried** without any effect.
- **The canvas, the text and the JSON stay in step:** an edit in one shows in the others at once.
- **Describe it** turns the person's words into a draft they check, answer questions about, change and approve.

**Non-goals (this design)**
- **Triggers other than the catalogue's events** (a schedule, a Linear change, a GitHub push). The catalogue is
  normative and closed (local-event-emission design, Appendix A, 3666–3671; §3 W19).
- **Loops.** A graph is acyclic. "Search for another one" is a second step, not a loop.
- **Sending a message.** A workflow never sends to a person (W16).
- **Interrupting a busy session** (0.33 §2). The person may interrupt a turn when they cancel a run, and only then.
- **GitHub actions** (a pull request, a push). The session does those under its own permissions.
- **Workflows shared between people or Macs.**

**Anti-goals: it fails if…**
- **An agent can approve a workflow,** answer one of its questions, or continue, resume or cancel a run.
- **A stored rule's bytes or digest change,** or any active approval needs renewing because this shipped.
- **An effect happens twice** after a crash, a lost answer or a retry.
- **A run reaches a folder, a project, a Linear issue or a provider its approved version doesn't name.**
- **Sender text reaches a prompt, an issue, a branch name, a path or a notification outside the untrusted envelope,** or
  decides a branch by its words.
- **A run waits forever** or holds a process while it waits.
- **Moving a box on the canvas makes a new version,** or a layout can hide a step from the person approving it.
- **Describe it sends a message's content the person didn't paste,** or an agent reaches a version, a target or an
  approval through it.

## 3. Decisions

**W1. A workflow is a rule version with a `flow` (S).**
- **The rule document gains one optional field, `flow`.** Absent, the rule is exactly today's. Present, the fan-out is
  replaced by the flow's graph.
- **Why:** the hardest machinery already belongs to rule versions and is reused as it is: immutable versions, D2's
  approval and supersede (`runtime/activations.ts` 281–386), cut-over points and replacement drains, derived tightenings
  (`runtime/replacements.ts` 32–38, 200–205), the disclosure binding's version list (`activation-documents.ts`
  459–491), and the Rules list, Deliveries and Analyse.
- **Rejected:**
  - **A new activation kind, `workflow`.** It would duplicate activation, cut-over and replacement, and turning a rule
    into a workflow would be a supersede across kinds, which nothing does today.
  - **Rewriting every rule into graph form.** Every stored digest would change, the pinned vectors in
    `packages/events-daemon/test/fixtures/activation-documents-v1.json` (56, 79, 96, 109) would fail, and every active
    approval would need renewing.

**W2. A rule without a `flow` is already a straight-line workflow, so nothing migrates (S).**
- **The designer draws it** as `Trigger → Condition → [Judge] → Keep → Split → one Deliver per target`. The drawing is
  derived (`flowOf(rule)` in `@agentcomms/events`), never stored.
- **It runs on today's path,** with no run record.
- **Its first version with a step the straight line can't say** (a branch, a wait, a find) is a new version with
  `flow`, approved like any other, superseding the old one (0.33 §3.1).
- **The precedent:** optional fields are left out of the canonical form when absent, "so every rule stored before it
  keeps its bytes and its digest" (`activation-documents.ts` 93–97; `agentic` and `cloudEventType` likewise, 129–132).

**W3. The gate stays before any run (S).**
- **The trigger, the rule's condition and its judge** keep running in the evaluator, before anything is kept for a
  message (`evaluate.ts` 262). A run is made only for a match.
- **A no-match leaves no run,** so a run's existence is itself a match.
- **The flow may hold more conditions and judges later in the graph,** over the run's mapped fields and its steps'
  closed outputs.

**W4. The graph: steps, closed outcomes, arrows; acyclic and bounded (S).**
- **Each step has a kind, its own fields and a closed set of outcomes.** Each outcome has an arrow to a step or to
  `end`; `otherwise` names every outcome not given. An outcome without an arrow ends that branch, and the preview says
  so ("If none, it stops").
- **Merging** is several arrows into one step. It is allowed only where a run can reach that step one way: two branches
  of one `split` may never meet again. Activation checks it.
- **Parallel:** `split` starts 2 to 8 branches. The run ends when every branch has.
- **No cycles,** at most 32 steps per flow and 64 executed per run. Retrying is inside a step, never an arrow back.
- **Rejected:**
  - **Joins that wait for every branch.** They add partial-failure states the person would have to understand in an
    approval, and nothing in the thirteen steps needs one.
  - **Loops with a counter.** A bound is easy to state but hard to read in a preview, and a loop that finds no session
    is the start step's job.

**W5. What reaches someone outside is still a delivery of a target version; everything else is an engine step (S).**
- **Deliver** sends to a target version through today's delivery machinery: the claim with its lease, every fence again
  just before anything leaves (`session-dispatcher.ts` 597–604), retries, dead letters, the Deliveries screen, the rate
  cap (`runtime/delivery-claim.ts` 140–161). It covers a session's prompt, a Linear write, a webhook, SSE, the Queue and
  dry-run.
- **Engine steps** don't disclose to anyone: condition, route, find, start, worktree, wait, ask me, notify, split. The
  engine checks the rule version's live authority before each one (`runtime/disclosure-fence.ts` 211–231, "active or
  retained superseded work") and the account (`assertLiveEventAccount`).
- **Two target changes, each valid only in a flow:**
  - a session target's `find` gains `{ "flow": true }`: "the session the flow chose". The deliver step names the find
    or start steps it takes the session from;
  - a new kind, `linear-change`, holds a comment, a state, labels and an assignee for "the issue this run made".
- **The `targets` list still names every target the flow uses,** so the disclosure binding lists each version, as it
  does today.

**W6. One approval per version lists every effect; a run asks the person only where the flow says so, and must in one
case (S).**
- **The version's approval** is D2's: prepared by `rule enable`, approved by the person at the terminal with the
  challenge, or in the attested app (`runtime/judge-setup.ts` 285–345; `cli/program.ts` 830–875, 982). Its preview is
  the rule's plain words plus a numbered list of effects, one line per step that does something (§9.2).
- **An `ask me` step** pauses a run for the person's yes. It is a core approval with its own preview, approved as any
  other approval is, and it lapses to `no`.
- **Required before a session that may edit files without asking** (`acceptEdits`) is started anywhere but in a
  worktree this run made: activation refuses a flow without an `ask me` on that path.
- **`bypassPermissions` stays refused** (`domain/session-target.ts` 28–33, 132–135).
- **Rejected:**
  - **An approval for every effect of every run.** Twenty approvals a day teach a person to press yes.
  - **No per-run gate at all.** Edits in the person's own checkout, from a prompt that carries a sender's words, are
    worth one look.

**W7. Runs live in the event service's database; content is sealed, history is content-free (S).**
- **Where:** new tables in the event service's SQLite (§4.3). A run joins its decision, deliveries, the busy queue and
  the relay's sessions in one transaction, which a file store can't.
- **Content:** the rule's mapped fields, sealed in the run's record as a delivery's are, purged when the run ends or at
  the run's deadline, whichever is first.
- **History:** each step's state, outcome, times and closed outputs (ids, closed words, paths of worktrees the run
  made). It holds no sender text, and is kept as long as the decision's metadata (`retention.decisionMetadataMs`).

**W8. Every effect has a key derived from its run and step, so a retry can't repeat it (S).** See §7.4.

**W9. Waiting is a row, not a process (S).**
- **A waiting step** writes a wait (kind, key, `wake_at`) and the run returns.
- **What wakes it:**
  - the relay's event stream, already followed for the busy queue (`session-queue.ts` 223–346), now also for waits;
  - a timer from `wake_at` on the scheduler's tick (`runtime/scheduler.ts` 37);
  - the person's answer.
- **Every wait has a timeout,** within the run's deadline.

**W10. A run finishes under the version it started on (S).**
- **A new version** takes new events. Runs already going keep their own version's authority, as superseded deliveries
  do today (`delivery-claim.ts` 280–303; `disclosure-fence.ts` 230–231).
- **Disabling or revoking the rule, `disable-all`, or removing its account** cancels its runs, as it cancels deliveries.
- **The person can cancel any run.**

**W11. Projects live in Agent Comms' event service; claude-stream keeps the sessions; Agent Comms makes the worktrees (L).**
- **Agent Comms** keeps projects, their folders, profiles and routing hints (§8).
- **claude-stream** starts, runs and owns sessions. Agent Comms is its client (agents screen design §2) and never "a
  second place that starts and owns agents" (§3 there).
- **Why the event service, not core:** routing and runs are its, and it already holds the relay client, the allowed
  roots and the denied folders (`runtime/agent-sessions.ts` 107–115, 213–270). Core's channels never need a project.
- **Rejected:**
  - **claude-stream's `project` environment layer** (api-contract 1178–1184). It provisions kits for a conversation and
    knows nothing of messages, profiles or routing.
  - **Core files.** They can't join runs and deliveries transactionally.
- **The cost:** Projects need the event service installed (§14, Q12).

**W12. A project's folders are authority; its profile and hints are not (S).**
- **A route step's candidates are bound into the approved document by value:** each project's id, name, folders and
  worktree folder. A run only ever reaches those folders.
- **If a project's folders change,** a run whose candidate no longer matches its approved folders takes the `none`
  branch with `PROJECT_CHANGED`, and the app offers "Review again".
- **The profile and hints only choose among approved candidates.** Editing them applies at once, with no approval. Each
  routing decision records the profile's hash.
- **Rejected: "any project you add later".** It widens an approved workflow without a review (§14, Q4).

**W13. Routing is a step: the person's hints first, then a judge per candidate (S).** See §8.3.

**W14. Worktrees: git runs as the person, with the repository's hooks off, inside the project's worktree folder (S).**
See §6.6. It is a new execution surface, which 0.33 deferred ("command output … new egress and execution surfaces",
§2); it is the only one here, and it is local.

**W15. Linear changes only reach issues this run created (S).**
- **A comment, change or close names the step that created the issue,** never an id from a message. A sender can't make
  a workflow close someone else's issue.
- **They use the same key and the one endpoint** (`domain/linear-target.ts` 23–24; 0.33 §3.4).

**W16. Nothing in a workflow sends a message (S).**
- **A reply in the thread** is the session's own act, through its channel tools, under the send gate and behaviour
  rules unchanged.
- **The `reply` step (later, §12)** only prepares an act for the person's yes, through the channel's own prepare. A
  standing approval covers only fixed Slack content (standing-approvals S1–S10).
- **Only `send.execute` and `executeSend` send** (AGENTS.md). The event service never does.

**W17. The rule text gains a `flow` section with steps and arrows (S).** See §4.4. The canonical JSON stays what is
approved. The text is a view, and the round trip holds.

**W18. A whole workflow can be tried without effects (S).** See §7.7.

**W19. Appendix A and the pinned digests don't move (S).**
- **No field is added to any catalogue event.** What a wait listens for — a turn's end, a time, a Linear state — is
  internal state, never a catalogue event, so Appendix A (3666–3671, 4232–4235) is unchanged.
- **`activation-documents-v1.json`'s digests, and the B3 vectors for v1–v3** (`test/fixtures/b3-control-contract-v*`),
  are unchanged. The new operations are B3 control v4.
- **Hardening:** `canonicalFullRuleDocument` builds its result from the fields it knows and drops any other key without
  saying so (`activation-documents.ts` 299–381). It now refuses an unknown top-level key. Every stored document is
  canonical, so nothing stored is affected.
- **Downgrade:** an older event service refuses a newer database (`store/database.ts` 36–75), so it can never read a
  flow rule as a fan-out.

**W20. The canvas is a view of the document; positions are kept by the app, never in what is approved (S).** See
§10.2.
- **The rule document is the one thing the designer holds,** as the 0.33 editor's model already says
  (`apps/desktop/src/rule-editor/model.ts` 1–6). The canvas, the text and the JSON are each drawn from it. An edit in
  any of them makes a new document, and the other two are drawn again from that.
- **Positions** are kept in the app's own settings, by rule id and step id, so a step keeps its place across versions.
  A version with no positions (one an agent wrote, or Describe it drafted) is laid out from its graph.
- **Approve… always lays the graph out afresh** and ignores kept positions. The numbered list of §9.2 is what is
  approved.
- **Rejected:**
  - **Positions in the document.** Moving a box would change the digest and need an approval.
  - **Positions in the document but outside its digest.** The stored bytes would no longer be the approved bytes, and
    a version's author (an agent, through `events_rule_create`) could place a step off-screen or under another.
  - **Positions in the event service.** That is a new store and command for something only the app draws.

**W21. Describe it drafts; it never writes, prepares or approves anything (S, on the owner's ask).** See §10.3.
- **It is the person's act:** an exception row that refuses the MCP server, an agent's shell and, on macOS, a process
  the app didn't start, as `rule analyse` does.
- **What it returns** is a draft in the editor: rule text, the words each step came from, and questions. Only the
  person's Save prepares a version, and only their approval enables it (W6).
- **The model gets no tools.** The local CLI runs with its tools and MCP servers off, so it can't reach Agent Comms'
  own servers, even when the person's Claude has them installed.
- **No message's content is sent** unless the person pastes it into the description.

## 4. Data model

### 4.1 The flow (in the rule document, `domain/flow.ts`)

```ts
interface CanonicalFullRuleDocument { /* … today's fields … */ readonly flow?: FlowDocumentV1 }

interface FlowDocumentV1 {
  readonly flowVersion: 1;
  readonly start: StepId;
  readonly steps: Readonly<Record<StepId, Step>>;      // 1–32; StepId is [a-z][a-z0-9-]{0,31}
  readonly limits: FlowLimits;                          // written out in full, so the digest binds them
  readonly shadow?: true;                               // W18: every effect becomes a dry-run record
}
type Next = StepId | 'end';
type Arrows<O extends string> = Readonly<Partial<Record<O | 'otherwise', Next>>>;

type Step =
  | { kind: 'condition'; when: CanonicalCondition; next: Arrows<'yes' | 'no'> }          // over /fields and /steps
  | { kind: 'judge'; ask: CanonicalAgenticCondition; next: Arrows<'yes' | 'no' | 'unsure'> }
  | { kind: 'route'; candidates: readonly RouteCandidate[]; by: readonly ('hints' | 'judge')[];
      judge?: CanonicalAgenticCondition; inputs: readonly string[]; next: Arrows<'chosen' | 'none' | 'unsure'> }
  | { kind: 'find-session'; in: Place; provider: 'claude' | 'codex'; next: Arrows<'idle' | 'busy' | 'none' | 'watched'> }
  | { kind: 'start-session'; in: Place; provider: 'claude' | 'codex'; mode: 'manual' | 'acceptEdits' | 'plan';
      next: Arrows<'started' | 'refused'> }
  | { kind: 'worktree'; project: StepId; base: 'default' | { branch: string }; branch: BranchTemplate;
      cleanup: 'keep' | 'remove-if-clean'; next: Arrows<'made' | 'refused'> }
  | { kind: 'deliver'; target: { targetId: string; version: number };
      to?: { session: readonly StepId[] } | { issue: StepId };                         // which session, which issue
      report?: readonly ('done' | 'needs-the-person' | 'not-mine' | 'blocked')[];      // a session's closed answer
      next: Arrows<'done' | 'left-in-queue' | 'failed'> }
  | { kind: 'wait'; for: { turnEnd: StepId } | { time: { afterMs: number } } | { linearState: LinearWait };
      timeoutMs: number; next: Arrows<WaitOutcome> }
  | { kind: 'ask-me'; question: string; timeoutMs: number; next: Arrows<'yes' | 'no'> }  // the person's words
  | { kind: 'notify'; text: string; next: Arrows<'sent'> }          // the person's words, closed step slots only
  | { kind: 'split'; branches: readonly StepId[] };                 // 2–8, never meeting again

type Place = { project: StepId } | { worktree: StepId } | { folder: string } | { lane: string };
interface RouteCandidate { projectId: string; name: string; folders: readonly string[]; worktreeRoot: string | null }
type WaitOutcome = 'completed' | 'failed' | 'stopped' | 'timed-out' | 'done' | 'needs-the-person' | 'not-mine'
                 | 'blocked' | 'reached';
interface FlowLimits {
  runsPerHour: number;          // default 10, at most 60
  concurrentRuns: number;       // default 2, at most 8
  sessionsPerHour: number;      // default 2, at most 10
  worktreesPerDay: number;      // default 5, at most 20
  linearWritesPerHour: number;  // default 30, at most 120
  runMs: number;                // default 3 days, at most 30
}
```

- **Step slots.** A template (Linear, notify, a branch name) may name a mapped field, `{{subject}}`, as today
  (`linear-target.ts` 218–233), or a step's closed output: `{{steps.issue.identifier}}`, `{{steps.route.project}}`.
  A session's summary is the one free-text output. It's agent-written, so it's rendered as outside text (§9.4).
- **A condition step** reads `/fields/…` (mapped values) and `/steps/<id>/<output>` (closed values only). An operand
  over a closed output must be one of its closed words.
- **What activation refuses:**
  - a cycle, a step no arrow reaches, a `split` whose branches meet;
  - an unknown or unused target, a `deliver` whose `to` names a step of the wrong kind;
  - a `flow: true` session target or a `linear-change` target outside a flow;
  - `report` for a Codex session (claude-stream's `outputFormat` is Claude's alone, api-contract 1030–1034);
  - `acceptEdits` reached outside a run-made worktree without an `ask me` (W6).

### 4.2 The two target additions

```ts
// The session target (domain/session-target.ts 38–51): find gains one shape, valid only inside a flow.
type SessionFind = { folder: string } | { lane: string } | { flow: true };

interface LinearChangeTargetDocument {
  targetId: string; version: number; kind: 'linear-change';
  team: { id: string; key: string };                             // the same team as the issue's, checked at activation
  comment?: { text: string };                                    // slots as a description's, rendered the same way
  state?: { id: string; name: string; type: 'started' | 'completed' | 'canceled' };
  labels?: { add: readonly LinearLabel[]; remove: readonly LinearLabel[] };
  assignee?: LinearAssignee;                                     // at least one of the four
}
```

Activation checks the state id against the team's states in Linear, as it checks label ids today (`linear-target.ts`
19–21).

### 4.3 The store (migration 34; content-free unless marked)

| Table | What it holds |
|---|---|
| `workflow_runs` | `id`, `decision_id` (unique), `rule_id`, `rule_version`, `account_id`, `event_id`, `state` (`running`, `waiting`, `held`, `done`, `failed`, `cancelled`, `expired`), `started_at`, `updated_at`, `expires_at`, `switch_generation`, `end_code`, and `encrypted_record` (**sealed**: the mapped values and any session summary; NULL once the run ends) |
| `workflow_steps` | `(run_id, step_id)`, `state` (`ready`, `running`, `waiting`, `done`, `failed`, `skipped`, `cancelled`), `outcome`, `delivery_id`, `attempt_id`, `lease_token`, `lease_until`, `attempts`, times, `last_error_code`, `output` (JSON of closed values, checked by kind) |
| `workflow_waits` | `(run_id, step_id)`, `kind` (`turn-end`, `time`, `person`, `linear-state`, `limit`), `key` (a relay turn id, an approval id, a Linear issue id), `wake_at` |
| `workflow_effects` | `rule_id`, `kind` (`run`, `session-start`, `worktree`, `linear-write`), `at`: the hour and day counters, as `delivery_cap_charges` is |
| `projects` | `id`, `name`, `repo` (`github.com/<owner>/<name>`), `profile` (≤ 2,000 characters), `profile_by` (`person`, `claude`, `codex`), `profile_at`, `hints` (sender domains, Slack conversations, people's handles; the person's words), times |
| `project_folders` | `folder` (realpath), `project_id`, `kind` (`checkout`, `worktree`), `default_branch`, `worktree_root`, `made_by` (run and step, for a worktree a run made) |
| `deliveries` | gains `run_id` and `step_id` (NULL outside a flow); `target_kind` admits `linear-change`. The kind check is a closed set, so the table is rebuilt, as migrations 24, 31 and 32 did (`store/migrations.ts` 1130–1204) |

- **A flow delivery's `target_key`** ends in `#<stepId>`, so `UNIQUE (decision_id, target_key)` (`migrations.ts` 1182)
  holds one delivery per step per run.
- **The busy queue's triggers** keep working (`migrations.ts` 1223–1233).

### 4.4 The rule text

A rule with a flow has a `flow` section in place of `then`. Its targets are written where a step delivers to them, and
the parser collects them into `targets`. A step with no arrows goes on to the next one written, so a straight line needs
none. `->` may be typed for `→`.

```
rule client-asks, version 5

when a Slack message is posted in cue/slack, in conversation C0123
ask jev, version 2
  question "Is this person asking for a change to one of our sites?"
  looking at text
  yes at 0.7, if unsure drop
keep text, author.name

flow, at most 6 runs an hour, 2 at a time, 2 sessions an hour
  step route: choose a project among acme-site and billing, by hints then by jev version 2
    looking at text
    none → tell
  step issue: linear issue client-issues, version 1, in team CUE, assigned to me
    title "{{author.name}} asks about {{steps.route.project}}"
    description "{{text}}"
  step find: find a session in route's project, with claude-code
    idle → give
    busy → give
    none → start
  step start: start a session in route's project, with claude-code, mode manual
  step give: session client-prompt, version 2, to find or start
    give
      fields text, author.name
      text "Do what they ask, on a branch of its own. Don't push."
    report done and needs-the-person
  step wait: wait for give's turn to end, up to 4 hours
    done → note
    otherwise → tell
  step note: linear change client-done, version 1, on issue
    comment "{{steps.wait.summary}}"
    state Done
    then → end
  step tell: tell me "A message for {{steps.route.project}} needs you"
```

- **The printer** writes steps from `start` in a stable order: depth first, the arrows in each kind's outcome order.
- **The `raw` escape** stays for any step or target the words can't say (GRAMMAR.md 305–315).
- **`parseRuleText(printRuleText(doc))` deep-equals `doc`** for every flow fixture, and the property test covers flows.

## 5. The engine

- **Where:** `WorkflowEngine` in the event service's owner, beside the dispatcher, under the same writer lease. It's
  driven by the scheduler's tick and woken by a delivery settling, a wait resolving or the person answering.
- **A run begins with its match.** For a rule with a flow, `commitDecisionOutbox` writes the run and makes its `start`
  step `ready` in the decision's own transaction, instead of preparing a delivery per target (`deliveries.ts` 80–110).
  The run is charged to `runsPerHour`. Past `concurrentRuns`, it is made `held` and starts in turn, oldest first. It is
  never dropped.
- **One step at a time per branch:**
  1. claim the step: an attempt id, a lease token and a lease, as a delivery claim takes them (`delivery-claim.ts`);
  2. fence: the rule version's authority, the switch generation, the account live, collection not paused;
  3. check the limit the step counts against. When it's reached, the step waits (`limit`, `wake_at` when the window
     frees) and is never failed;
  4. run it. An engine step does its work; a `deliver` step inserts one delivery row and waits for it to settle;
  5. settle: the outcome, its closed outputs, and the next steps made `ready`, in one transaction that proves the claim
     is still this attempt's.
- **Delivery settled → outcome:** delivered → `done`; `LEFT_IN_QUEUE` or `LEFT_IN_LANE` → `left-in-queue`; dead-lettered,
  expired or unreadable → `failed`. A session busy is not an outcome: the delivery waits in the busy queue as today
  (`session-dispatcher.ts` 463–496), and the step stays `waiting` ("1 ahead").
- **Ends:** when every branch has reached `end`, the run is `done`, or `failed` if a branch ended on an unhandled
  `failed`. The sealed record is purged in the same transaction. At `expires_at` the run is `expired`: its steps are
  cancelled, its deliveries cancelled where they still wait, its record purged.

## 6. Steps

| Step | Reads | Outcomes and outputs | Effect | Fails, retries | Approval |
|---|---|---|---|---|---|
| condition | mapped fields, closed outputs | yes, no | none | none | version |
| judge | the pointers it names | yes, no, unsure; score | a judge call, on the rule's judge budget | as the rule's judge (holds, budget waits) | version |
| route | hints, then the judge per candidate | chosen (`project`, `reason`), none, unsure | 0 to 8 judge calls | judge failure → unsure | version |
| find-session | the relay's sessions | idle, busy, none, watched (`session`) | reads only | relay down: retried 12 times with backoff (`session-dispatcher.ts` 51, 624–652), then failed | version |
| start-session | the place, the provider | started (`session`), refused | a relay session; counts `sessionsPerHour` | as find; a refusal (folder outside roots, 501, 503) is `refused` | version; `ask me` first for `acceptEdits` outside a run-made worktree |
| worktree | the project's checkout | made (`path`, `branch`), refused | `git worktree add`; counts `worktreesPerDay` | an index lock: 3 tries; anything else → refused | version |
| deliver | its target | done, left-in-queue, failed | the target's | the target's own (Linear 10 tries, `linear-dispatcher.ts` 43; session 12) | version |
| wait | a turn, a time, a Linear state | per kind; timed-out | none | reconciled after a restart (§7.3) | version |
| ask me | — | yes, no | a core approval for the person | lapses to no | the person, per run |
| notify | the person's words | sent | a notice from core's notifier (`packages/core/src/notify.ts` 184) | best-effort; never fails a run | version |
| split | — | — | none | none | version |

### 6.1 Route
- **Inputs:** the step's pointers (mapped fields only, as a judge's `inputs` are) and its approved candidates.
- **By hints, deterministic and first:**
  - the sender's address domain;
  - the Slack conversation id;
  - a person's handle the project lists.
  One project matching → `chosen`, reason `hint`, naming which hint. Several match → the judge decides among those.
- **By judge:** one yes-or-no per remaining candidate, "Is this message about the project <name>: <profile>?", on the
  step's judge document, budget and threshold.
  - The highest yes above the bar is `chosen`. None → `none`. Two within 0.05 of each other, or the best between the
    unsure bar and the yes bar → `unsure`.
  - At most 8 calls per run, each counted in the judge's hourly and 30-day limits.
- **Outputs:** `project` (an id), `reason` (`hint:sender-domain`, `hint:slack-conversation`, `hint:person` or
  `judge`), `score`, `profileHash`. Never a quote from the message (§9.4).

### 6.2 Find a session
- **In a project:** a relay session whose realpath `cwd` is one of the chosen candidate's approved folders, or a
  worktree this run made.
- **In a worktree, a folder or a lane:** as the session target finds today (`session-dispatcher.ts` 353–389).
- **The provider** must match. Of several, the most recently active wins, as today.
- **Outcomes:**
  - `idle`: no active turn;
  - `busy`: `activeRunId` present;
  - `none`;
  - `watched`: a window the relay only watches, which takes no prompt (`relay-client.ts` 308–314). The flow may send it
    to a lane.
- **Later (needs taking messages, 0.35):** `in: thread`, the session that holds or held a take on this message's
  thread (taking design T2, §4).

### 6.3 Start a session
- **The call:** `POST /v1/sessions { provider, cwd, requestedMode, title }` (api-contract 609–630).
  - `cwd` is the place's folder, or the worktree's path.
  - The title is fixed, `Agent Comms · <rule> · <run, 8 hex>`, under claude-stream's 200 characters (api-contract 1922).
- **Activation and dispatch both check the folder** is inside the relay's allowed roots and outside Agent Comms' own
  folders (`agent-sessions.ts` 226–270).
- **A run starts at most one session per start step.** A retry adopts the session it made (§7.4).

### 6.4 Deliver to a session
- **The prompt** is the session target's fixed frame (`packages/events/src/context/index.ts` 414–431), opening "[Agent
  Comms] The workflow <id> passed you a message from <channel>/<account>."
  - It adds the offer line of taking messages (T4) once 0.35 ships.
  - Its context parts are as in 0.33 §3.6, plus `{ step: <id>, field }` for a closed output (an issue's identifier and
    address, a worktree's path and branch), labelled "from Agent Comms".
- **`startId`** comes from the delivery's id, as today (`session-dispatcher.ts` 58–64), so a retry makes no second turn.
- **`report`:** the turn is started with `outputFormat` `{ outcome: <the listed words>, summary: string ≤ 2,000 }`. The
  turn's `structured.final` (api-contract 250) is read when it ends. The outcome decides the wait's branch; the summary
  is sealed in the run's record.

### 6.5 Wait
- **For a turn's end:** the turn the named deliver step made (`session_deliveries.run_id`).
  - Ends when the relay journals `run.completed|failed|cancelled|interrupted` (api-contract 241–244).
  - Without `report`: `completed`, `failed`, or `stopped` (cancelled or interrupted).
  - With it: the reported word, or `failed` when the turn ended without one.
  - A turn `waiting` on the person's approval in claude-stream keeps waiting, and the run view says "Needs you in
    claude-stream".
- **For a time:** `afterMs`, at most the run's deadline.
- **For a Linear state (later):** `reached` when the issue's state type is one of those listed. It polls
  `issue(id) { state { type } }` at most every 5 minutes, through the one endpoint.
- **`timed-out`** at `timeoutMs`, which every wait must have, and which must be within `runMs`.

### 6.6 Worktree
- **Where:** `<worktreeRoot>/<branch slug>`. `worktreeRoot` is the approved candidate's, by default `<checkout>-wt`
  beside the checkout, as the prototype draws it (`Projects.dc.html` 258: `~/work/acme-site-wt/pricing`).
  `.claude/worktrees` inside the checkout may be chosen instead (save-deny's exception).
- **The branch:** a template of closed slots only, `ac/{{steps.issue.identifier}}` or `ac/{{run}}`, folded to
  `[a-z0-9/-]`, at most 60 characters. Never a field from the message.
- **The command:** `git -c core.hooksPath=/dev/null -C <checkout> worktree add -b <branch> <path> <base>`, run with
  `execFile` at git's absolute path, no shell, a scrubbed environment (no `GIT_*`), a 60-second timeout and capped
  output. This is the precedent of `runtime/relay-listener.ts` 1–25. Hooks are off because `core.hooksPath` may point
  into the repository (`.husky`), which would run the repository's code.
- **The jail:**
  - the checkout is one of the candidate's approved folders;
  - the root is inside the relay's allowed roots and outside Agent Comms' folders;
  - the path is the root plus one slug;
  - after creation, `realpath(path)` must equal the computed path, or the worktree is removed and the step refused.
- **Idempotency:** `worktrees` records path, branch and run before the command runs. A retry that finds the path is a
  worktree on that branch adopts it. A branch that exists and wasn't made by this run → `refused`. A branch is never
  reused.
- **Cleanup:** `keep` (the default), or `remove-if-clean` when the run ends: `git worktree remove` without `--force`,
  only when `git status --porcelain` is empty and the branch has no commit its upstream lacks. Otherwise it's kept, and
  the run view says why.

### 6.7 Linear
- **Create** is today's target, unchanged.
- **Change** (`linear-change`) on `to.issue`, the create step. Each try asks Linear for the issue first, as create does
  (`linear-dispatcher.ts` 35–38).
  - **A comment** uses `commentCreate` with an id chosen from the delivery's, as `linearIssueId` chooses one
    (`linear-target.ts` 235–245). That `CommentCreateInput` takes `id` is to be confirmed against Linear's schema
    before building. Without it, a comment carries a fixed footer with the delivery's short id, and a retry looks for
    it first.
  - **A state, labels, an assignee** use `issueUpdate`, which is the same on a second try.
  - **Close** is a state of type `completed` or `canceled`, named by id and name.
- **Slot values** are quoted blocks labelled by who wrote them, as today (`linear-target.ts` 268–290). A session's
  summary is labelled "Written by an agent, not checked".
- **Retries** as today: a rate limit, a 5xx or no answer retries; a 4xx fails with Linear's code.

### 6.8 Notify
Core's notifier, with the person's words and closed step slots only: a project's name, an issue's identifier, an
outcome word. No sender text, since a notice can show on a locked screen. One notice per step per run.

## 7. Runs

### 7.1 States
- **A run:** `running` → `waiting` ↔ `running` → `done` | `failed` | `cancelled` | `expired`; `held` before it starts.
- **A step:** `ready` → `running` → `waiting` → `done` (an outcome) | `failed` (a code); `skipped`; `cancelled`.

### 7.2 What is kept
- **Sealed, in `workflow_runs`:** the mapped values, written once, and a session's summary.
- **Each delivery** seals its own resolved context, as today (`session-dispatcher.ts` 273–282).
- **Content-free:** the steps' outputs, waits and effect counters.

### 7.3 After a restart
- **Expired leases are claimed again**, as `recoverLeases` does for deliveries (`session-dispatcher.ts` 213–221).
- **Turn waits re-arm the relay follower,** which reconciles each session's snapshot on every (re)connect
  (`session-queue.ts` 262–276). A turn that ended while the service was down resolves then. A new journal (a reset
  relay) starts again from the snapshots (318–327).
- **Time waits** fire from `wake_at` at the first tick. **Person waits** read their approval's state.
- **A crash between an effect and its settle** is covered by §7.4's keys: the retry finds what was made.

### 7.4 Idempotency keys
- **A turn:** `startId` from the step's delivery id. The relay answers a repeated `startId` with the turn it made,
  across restarts (api-contract 136–143, 1018–1020).
- **A session:** `POST /v1/sessions` takes no client key (api-contract 611). So the step records "starting" before the
  call. A retry first lists sessions and adopts the one with this run's title marker and `cwd`, and records it in the
  claim's transaction.
  - A session started but lost before the record is adopted the same way.
  - Two with the marker → the newer is adopted and the other named in the run view.
  - Ask claude-stream for a create key (§13).
- **A Linear issue:** `linearIssueId(deliveryId)`, as today. **A comment:** §6.7.
- **A worktree:** §6.6. **A notice:** once per step per run, recorded before it's raised.

### 7.5 Bounds
- **Per run:** 64 executed steps, at most one session per start step, one worktree per worktree step, the deadline
  `runMs`.
- **Per hour and day:** the version's `limits`, counted in `workflow_effects`. A reached limit holds, never drops.
- **Ceilings across all workflows** (event settings, a tightening to lower): 16 concurrent runs, 10 sessions started
  an hour, 20 worktrees a day.
- **Today's per-rule `deliveryRateCap`** still caps each rule's deliveries (`delivery-claim.ts` 148–161).

### 7.6 Cancel and pause
- **`run cancel <id>`** (the person, a tightening, applies at once):
  - deliveries still waiting are cancelled and their records purged, as `session-queue drop` does
    (`session-queue.ts` 102–128);
  - waits are dropped, the run's record is purged, the run is `cancelled`.
- **A session's turn is never interrupted** unless the person adds `--interrupt` (`POST /v1/runs/:id/interrupt`,
  api-contract 1635–1638).
- **Pause** stops claims, as for deliveries (`delivery-claim.ts` 143). Waits keep listening; nothing advances until
  Resume.

### 7.7 Trying a workflow
- **`flow test <rule> <version> --example <n> [--outcome <step>=<outcome>]…`** runs the graph against a catalogue
  example, as `rule test` does (`operations/rule-test.ts` 5–12):
  - no I/O;
  - each step answers with the outcome given, or its first;
  - the result is the path, each effect's line as "would have…", and each prompt and issue as it would be written,
    with its envelopes.
  - Both CLI and MCP: it holds no real content.
- **Shadow** (`flow.shadow: true`), a version approved like any other:
  - real events, real route and find (reads only);
  - every start, worktree, Linear write, prompt and notice becomes a dry-run record (24 hours, `dry-run` design);
  - waits end at once as `timed-out`.
  - Deliveries for a rule in dry-run already say so (0.34 B5).

## 8. Projects and routing

### 8.1 A project
- **What it is:** a GitHub repository, its folders on this Mac (checkouts, and worktrees of them), a profile, and hints.
- **Who changes it:** only the person, at the CLI or in the app. An agent never reads the list, since folders name
  clients (taking design T7).
- **Adding one** (the prototype's four steps, `AddProject.dc.html`):
  1. **Choose the repository.** The app runs `gh repo list` / `gh repo view` as the person. Agent Comms keeps no GitHub
     token. Without `gh`, the person types `owner/name`.
  2. **Find its folders.** `project scan`:
     - walks the relay's allowed roots, else `~/work` and `~/code`, to depth 4;
     - follows no symlink, and skips hidden folders except `.claude/worktrees` and Agent Comms' folders;
     - a folder is a checkout when its `remote.origin.url` names the repository, in its https or ssh form, and its
       worktrees come from `git worktree list --porcelain`;
     - the person ticks the ones that belong.
  3. **Analyse (optional)** (§8.2).
  4. **Check the profile.** The person edits and saves it. Only a saved profile routes.

### 8.2 The profile, and what is sent
- **The person may write the profile themselves.**
- **Analyse** runs through claude-stream, with the person's own Claude or Codex: a session in the checkout, mode `plan`
  ("it only plans, and changes nothing", `session-target.ts` 54–58), a fixed brief, and, for Claude, `outputFormat`
  `{ what, whoAsks, keywords[] }`.
  - The new profile is shown beside the old one, and the person chooses.
  - The session shows in claude-stream and on the Agents screen like any other.
- **Rejected: running `claude -p` or `codex exec` from Agent Comms.** That makes Agent Comms a second place that
  starts agents (agents screen §3). Describe it does call the local CLI (§10.3), on the owner's word. It is one model
  call with no tools, no folder and no files, not an agent working in a repository (§14, Q6).
- **What is sent, said on the screen before Analyse:** the brief, and whatever files the session reads in that
  checkout, to Anthropic or OpenAI under the person's own subscription. Nothing about messages, unless the person ticks
  "also say who has asked about it" (default off). That adds the names and subjects of messages routed to the project
  in 30 days.
- **Analyse is a person's act:** an exception row that refuses the MCP server, an agent's shell and, on macOS, an
  unattested process, as `rule analyse` does (`capabilities.json`, `events-daemon.rule.analyse`).
- **A profile is model-written from repository files**, which may carry instructions. So it is shown as outside text
  until the person saves it, and it is at most 2,000 characters.

### 8.3 Routing
- **Routing is the `route` step (§6.1),** inside a workflow. Outside workflows nothing routes. Lanes (0.31) and taking
  (0.35) are unchanged.
- **Hints are deterministic and free,** so most messages never reach a judge.
- **The judge provider receives** the profile and the fields the step names. The preview says which provider, which
  fields and which projects.
- **The story's "because" is closed words** (§9.4). The prototype's "because it mentions the October invoice page"
  (`MessageRouted.dc.html` 195, 357) quotes the message, and changes to "its sender's domain is one acme-site lists" or
  "Jev said yes at 0.86 to acme-site's profile".

## 9. Security

### 9.1 Who can do what

| Act | The person (CLI, app) | An agent (MCP, its shell) |
|---|---|---|
| Write a flow (`rule create|update`) | yes | yes: prepares a version, nothing more |
| Approve a version | yes: the challenge, or the attested app | never (`mcp/server.ts` 349–353: the view carries no challenge) |
| Answer `ask me` | yes, the same way | never |
| Try (`flow test`) | yes | yes: catalogue examples only |
| Describe it (`flow describe`) | yes: a draft, written nowhere | never (an exception row) |
| Cancel, continue, read a run's content | yes | never (exception rows) |
| Projects: add, scan, analyse, edit | yes | never |
| Lower a limit, disable | yes, at once | as today (a tightening) |

- **The app's speed bump is 0.34's** (desktop design §3, "How approval works"). On macOS the app approves what it
  started, attested by `codesign` on the parent pid. Elsewhere the person approves in Terminal. It is a speed bump
  against agents, not a boundary against code running as the person, and the docs say so.

### 9.2 The approval's preview
- **The rule's plain words** (`describeRule`), then one numbered line per effectful step, from a new
  `describeFlow`, with `plain`, `value` and `untrusted` parts (`packages/events/src/rules/describe-rule.ts` 1–14).
- **Each line names everything that matters:**
  - every folder a session may work in, and its provider and mode in words (`session-target.ts` 54–58);
  - every worktree folder and the branch template, and that git runs as you without the repository's hooks;
  - each Linear team, label, state and assignee;
  - which fields go to a session, a judge, a webhook or Linear;
  - each `ask me`;
  - the limits;
  - what happens on `none`, `failed` and `timed-out`.
- **For example:** "3. If no session is idle there, start a Claude Code session in ~/work/acme-site that asks before
  it acts."

### 9.3 Folders and processes
- **Sessions** work only in approved folders and run-made worktrees, inside the relay's allowed roots, outside Agent
  Comms' folders, checked at activation and at dispatch.
- **Git:** §6.6. Never `--force`, never fetch or push.
- **No other program** is run by the event service. `gh` and Analyse are the person's acts, run by the app or through
  claude-stream.
- **Describe it's local `claude`** runs in the CLI process the person started, never in the event service (§10.3).
- **No new network address:** the judges' and Linear's endpoints and the loopback relay, as today. The relay token is
  handled as today: never printed or put in argv, and sent only to a port this user listens on (`relay-listener.ts`).

### 9.4 Untrusted content
- **Mapped sender values** reach a prompt only in `wrapUntrusted`'s envelope (`session-dispatcher.ts` 439–452), and a
  Linear text only in labelled quoted blocks.
- **They never reach** a branch name, a path, a title, a notice, a step's outputs or the story.
- **A session's summary and a profile are agent-written**, so they are treated as outside text wherever they are shown
  or passed on.
- **So is everything Describe it returns.** Its draft becomes a document only through the parser and the event
  service's checks, and its words and questions are shown as outside text.
- **Branches turn only on closed words:** outcomes, the reported word, hint kinds, scores against bars. Never on what a
  message or an agent wrote.
- **The send gates, behaviour rules and standing approvals are unchanged** (W16).

## 10. Surfaces

### 10.1 Commands (B3 control v4; every row in `capabilities.json`, run by `pnpm verify:parity`)
- **Both CLI and MCP:**
  - `rule create|update` and `rule enable` (existing, with `flow`);
  - `flow test` (new).
- **CLI only, each an exception row** (the person's), refusing the MCP server's process and an agent's shell:
  - `runs list [--rule] [--state] --json`, `run show <id> --json`;
  - `run cancel <id> [--interrupt]`, `run continue <id> <step>` (answers an `ask me` with its challenge);
  - `project add|list|show|update|remove`, `project scan`, `project analyse`;
  - `flow describe [--provider claude-cli|openrouter|anthropic] [--draft -]`, with the words on stdin (§10.3).
- **The app:** allow-list rows for each, with arguments checked in Rust (0.33 §3.7).

### 10.2 The desktop app
**The designer: Events → Workflows** (today's Rules tab).
- **The stack:**
  - React Flow, `@xyflow/react` ^12.11.3, added to the app's dependencies. It is the range cue-ui declares, as an
    optional peer (`cue-ui-release-0.32.1/packages/ui/package.json` 167, 198–200).
  - Through `@cueplusplus/ui/flow`: `useFlowTheme` (the `--xy-*` token map, spread on the canvas), `NodeCard`,
    `NodeHandle`, `SignalEdge`, `FlowBackground` and `FlowControls`
    (`cue-ui-release-0.32.1/packages/ui/src/flow/index.ts` 1–69, `use-flow-theme.ts` 10–27).
  - The subpath is in 0.29.0's build as well. Confirm it in 0.34.0, which the app pins, before building.
- **Canvas ⇄ document (W20):**

  | Canvas | Document |
  |---|---|
  | the gate nodes: Trigger, Condition, Judge, Keep | `source` and `event`, `condition`, `agentic`, `mapping` |
  | a node, by its React Flow id | a step, by its id |
  | a node's type | the step's `kind` |
  | a source handle | one of the kind's outcomes, `otherwise`, or a split's branch |
  | an edge, from a handle to a node's input | an arrow, `next[outcome] = <step id>` |
  | a handle with no edge | the outcome stops (`end`), drawn as a small "Stops" mark |
  | a Deliver node's inspector | its target version in `targets`. A change makes a new target version on Save (`target add|update -`), as 0.33's submit does (`rule-editor/submit.ts` 1–7) |
  | the flow's settings panel | `flow.limits`, `shadow` |

  - **Nodes:** `NodeCard` tones input (the trigger), processing (engine steps) and output (effects). A step that
    fails a check shows a warning chip. Tones and states come from the document, never the reverse.
  - **Inspector:** a node opens the same controls as `RuleVisual` (`apps/desktop/src/screens/events/RuleVisual.tsx`
    1–6). A field without a control is "edited as text" and left as it is.
- **Drag and drop from a palette.** The palette is an app-level panel beside the canvas, outside React Flow, listing
  each step kind the release has. It uses React Flow's drag-and-drop pattern:
  - `dragstart` puts the kind on the drag's data;
  - the canvas's `onDrop` turns the pointer into a place with `screenToFlowPosition({ x: clientX, y: clientY })`;
  - it adds a step with a fresh id (`<kind>-<n>`), the kind's defaults and no arrows;
  - the drop place is kept as that step's position;
  - a dropped step stays invalid, and Save stays off, until its fields pass the checks.
- **Connecting:** `onConnect` writes the arrow. `isValidConnection` refuses a cycle, a second arrow from one outcome,
  and two branches of one split meeting. It uses `checkFlow`, a pure graph check in `@agentcomms/events` (isomorphic,
  no I/O) that the event service's canonicaliser runs too, beside its own checks of accounts, folders and Linear.
- **Deleting** a node turns each arrow into it into `end`. Its target leaves `targets` when no other step uses it.
- **Keeping the three views in step:**
  - one document, one undo stack of whole documents;
  - **canvas → document:** each node or edge change is a pure function from the old document to a new one. A drag
    changes the app's kept positions only, never the document;
  - **text → document:** each edit is parsed (`parseRuleText`). When it parses, the document is replaced and the canvas
    drawn again. When it doesn't, the canvas keeps the last good document, dimmed, with "The text has a mistake on line
    12", and doesn't take edits until the text parses or its changes are dropped;
  - **document → text** is `printRuleText`, which reads no position, so a version's text and digest don't depend on
    how it was drawn;
  - **JSON** is the canonical document, read-only, as 0.33's Advanced tab is;
  - React Flow's nodes and edges are drawn from the document and the kept positions on each change, never kept as a
    second copy.
- **Laying out:** steps without a kept position are placed in layers from `start` (one column per depth, rows by
  outcome order), sized from `NodeCard`'s fixed height ("a node's rendered height is exactly the height the layout was
  told", `flow/index.ts` 17–18). It's a small function in the app, with no layout library.
- **Approve…** shows §9.2's numbered list and the typed challenge (0.33 §3.1), beside the graph laid out afresh (W20).
- **Try it:** `flow test`, with an outcome picker on each node and the taken path lit.
- **The run view:** the version's graph, its taken path lit (`SignalEdge` live, `NodeCard` state), each step's time,
  outcome and wait ("Waiting for acme-site · Claude Code, 1 ahead", "Needs you in claude-stream"), Cancel and
  Continue…. Opened from the workflow's Runs list, from Deliveries, and from a message's story.
- **Projects** (prototype row 4): projects with their folders, the sessions working in them (busy or idle, from the
  relay), the profile with Edit and Analyse again, and Add a project….
- **Messages:**
  - `TouchKind` (`apps/desktop/src/messages/join.ts` 34–43) gains `routed`, `issue-made`, `session-found`,
    `session-started`, `worktree-made`, `given`, `turn-ended`, `issue-closed`, `run-ended`;
  - the story reads "Workflow client-asks › Project acme-site (its sender's domain) › Issue CUE-123 › Session started in
    ~/work/acme-site › Given 11:20, 1 ahead › Turn ended 11:39: done › Issue closed";
  - read from `runs list --json`, joined by event id.
- **The bundle:** React Flow's stylesheet must pass `check:bundle`: no remote address, no `data:` font, no file over 3
  MB (`apps/desktop/scripts/bundle-check.mjs` 10–15, 33–36).

### 10.3 Describe it

**What the person does.** In the designer, **Describe it…** opens a box: "Say what should happen, in your words." For
example: "When David asks for a change on Slack, find the acme-site session, or start one; make a Linear issue for it
and close it when the session says it's done." The person picks who drafts it:
- **Your Claude subscription** (`claude` on this Mac, signed in), the default when it's found;
- **OpenRouter** or **Anthropic**, with the key already kept for Analyse (`domain/analyse-model.ts` 3–64).

**What comes back**, shown in the designer and saved nowhere:
- **the draft:** rule text, opened in the three views like any edit;
- **where each step came from:** the words of the description that produced it, shown on its node. The model answers
  `{ text, notes: [{ step, words }], questions: [{ step | null, question, choices? }] }`.
  - A note's `words` must be an exact piece of the person's description, or the note is dropped.
  - A step with no note is marked "Added by the model, not from your words."
- **questions** for what was ambiguous, such as "Which Linear team: CUE or RGC?" or "When no session is idle: wait, or
  start another?", at most 5, each with up to 4 choices.
  - The person answers, or edits the description, and asks again. The answers are added to the description.
  - The current draft goes along, so each round changes only what it must.
- **the checks**, as for any document: the parse errors with their lines, then the event service's checks, run as
  `rule create`'s are but without writing a version (an unknown account, lane, team or project; a folder outside the
  roots; §4.1's refusals).

**What is sent to the model, said under the box before anything is sent:**
- the person's words, at most 4,000 characters, and their answers;
- a fixed brief, and the rule text's words for the steps this release has, from `GRAMMAR.md`, versioned with it;
- the names a draft may use: account aliases and their channels, lane names, judge ids and kinds, target ids and kinds,
  project ids and names, and, with a Linear key, team keys, label names and state names;
- when asking again: the current draft's text.
- **Never sent:**
  - any message's content, unless the person pastes it into the box. Then it is sent as they pasted it, inside the
    untrusted envelope, marked as an example;
  - profiles and folders;
  - counts, a target's URL, templates or secrets;
  - any key or token.

**How it runs:**
- **With a key:** in the event service, on Analyse's pinned transport and bounds (64 KB request, 256 KB response, a
  4,096-token answer, 60 seconds; `analyse-model.ts` 58–64), with Describe's own answer schema.
- **With the person's Claude subscription:** in the CLI process the person started (the app, or their terminal),
  never the event service:
  - `claude -p --output-format json`, with the prompt on stdin;
  - run by `execFile` at the absolute path Settings → Integrations found, with no shell, in an empty owner-only
    temporary folder that is removed afterwards;
  - with no tools, no MCP servers, and as little of the person's own settings and hooks as the installed CLI allows.
    The exact flags are checked against its `--help` before building and pinned in one place;
  - with a 120-second deadline and the response capped at 256 KB.
  - Without its tools and servers, the model can't call Agent Comms, even where the person's Claude has its servers
    installed.
- **Refused:** a draft holding `raw` lines (the escape form, GRAMMAR.md 305–315). A person may write `raw`; a model's
  draft must say every step in words, so its effects can be read.

**Why an agent can't reach an approval through it (W21):**
- `flow describe` is an exception row that refuses the MCP server's process, an agent's shell and, on macOS, a process
  the app didn't start.
- It writes nothing: no version, target, approval or run.
- The draft becomes a version only when the person presses Save, which prepares it, and is enabled only by their
  approval: the challenge, or the attested app.
- The model has no tools, and what it writes is outside text until the parser and the checks have read it.
- A pasted message that tells the model to add a step shows up as a step on the canvas, with or without a note, and as
  a line in the approval's list.

## 11. Tests

All with the fakes (`packages/events-daemon/test/support/fake-relay.ts`, `fake-linear.ts`), a temp home and state
folder, and temp git repositories. Nothing reads the real relay token or config, and nothing talks to Linear, Slack or
Gmail.

- **Documents:**
  - every existing fixture keeps its bytes and digest (`activation-documents-v1.json`; B3 v1–v3 vectors);
  - every refusal of §4.1;
  - an unknown top-level key is refused;
  - limits are written out in full.
- **Rule text:** the round trip and stable printing for flows, with the property test extended to generated graphs.
- **Engine:**
  - one test per outcome of each step;
  - merges and splits;
  - held runs start in order;
  - limits hold and resume;
  - 64 steps fail `STEP_LIMIT`;
  - expiry purges the record;
  - cancel cancels waiting deliveries.
- **Crashes:** a failpoint at every transaction edge of each effect (as `test/cutover-failpoints.test.ts` does). A
  restart makes no second session, turn, issue, comment or worktree, and adopts the one it made.
- **Waits:**
  - a turn that ends while the service is down;
  - a relay journal reset;
  - a repeated run end;
  - a timeout;
  - an `ask me` that lapses.
- **Worktrees:**
  - a repository whose `core.hooksPath` hook writes a marker: the marker is never written;
  - a symlinked root is refused;
  - an existing foreign branch is refused;
  - `remove-if-clean` keeps a dirty or unpushed tree.
- **Security:**
  - every exception row exits 10 inside the MCP marker and an agent's shell;
  - no MCP tool approves or continues;
  - sender text appears in a prompt only inside the envelope, and never in a branch, path, notice, step output or story
    line, asserted by value;
  - a Linear change can name only the run's own issue.
- **Parity:** every new row in `pnpm verify:parity --strict`.
- **Describe it:**
  - with the fake model provider (`test/support/fake-model-provider.ts`) and a fake `claude` on a temp `PATH` in a temp
    home, the request holds exactly §10.3's parts: no message content, profile, folder, URL or key, asserted by value;
  - a pasted example arrives enveloped;
  - a note quoting words not in the description is dropped, and a step with no note is marked;
  - a `raw` line is refused;
  - nothing is written to the store;
  - the command exits 10 inside the MCP marker and an agent's shell;
  - the CLI is started with no shell, no tools and no MCP servers, in an empty folder that is gone afterwards.
- **Desktop:**
  - pure tests of `flowOf`, layout and the run view's lit path;
  - the canvas ⇄ document functions: each node and edge change; a drag changes positions only, and the document's
    bytes are unchanged; a drop at a `screenToFlowPosition` place; text that doesn't parse leaves the canvas on the
    last good document; `printRuleText` is the same whatever the positions;
  - `isValidConnection` refuses a cycle and a split meeting itself, through the same `checkFlow` the event service runs;
  - Rust tests of each allow-list grammar;
  - the version gate;
  - the bundle check.

## 12. Phasing (S)

- **0.36.0, a minor.** The graph and its engine, with the steps the owner's main path needs:
  - the `flow` document, the text, `describeFlow`, B3 v4, migration 34;
  - condition, judge, split; route by hints and judge; find a session (folder, lane, project) and start one (`manual`
    and `plan` only);
  - deliver; wait (a turn's end with `report`, a time); notify;
  - Linear create, comment, change and close;
  - runs, cancel, `flow test`, shadow;
  - Projects (add through `gh`, scan, profile by hand, hints);
  - the designer (React Flow, the palette, the three views in step), the run view, Projects and the story;
  - Describe it, on all three providers.
  - **Builders, in parallel:**
    - E1: the document, text, `checkFlow` and description (`packages/events`);
    - E2: the engine and store;
    - E3: route and the session steps;
    - E4: the Linear lifecycle;
    - E5: projects;
    - E6: Describe it (the brief, both transports, the checks without a version);
    - U1: the designer and Describe it's box;
    - U2: the run view, Projects and Messages.
- **0.37:**
  - worktrees;
  - `ask me`, and `acceptEdits` for started sessions;
  - Analyse profiles through claude-stream;
  - waiting for a Linear state;
  - find by thread, and offers from flows (with taking, 0.35).
- **Later:**
  - the prepared `reply` step;
  - routing by meaning on this Mac (with local search's model, S9);
  - triggers beyond the catalogue, each behind a catalogue version of its own.

## 13. Risks and known limits

- **A graph is harder to approve than a list.** §9.2's numbered effects carry the approval. A preview over 20 lines is
  a sign to split the workflow, and the designer says so.
- **Spend:** each started session uses the person's subscription. The limits default low (2 sessions an hour).
- **A prompt carries a sender's words to an agent that can act.** Manual mode by default, never `bypassPermissions`,
  edits only in a run-made worktree or after the person's yes. "Don't push" in an instruction is a request, not a
  control; the session's own permissions are the control.
- **A turn's end is not work done.** Only a Claude session's reported word says "done". Codex ends on status alone,
  and the designer sends it to "tell me" by default.
- **claude-stream gaps:**
  - no create key on `POST /v1/sessions` (§7.4 adopts by title);
  - no status or `cwd` filter on `GET /v1/sessions` (asked in agents screen §5), so find costs one snapshot per
    candidate, at most 8 (`session-dispatcher.ts` 54);
  - `outputFormat` is Claude's alone.
- **Linear:** comment idempotency is unconfirmed (§6.7). States differ per team, so a close names one team's state.
- **Git:** `worktree add` on a large repository can be slow (60-second cap). LFS smudge filters run, since they come
  from the person's own git config. Network volumes are untested.
- **Two schedulers in one owner.** The engine reuses the delivery claim and fences rather than copying them, and its
  transactions sit under the same writer lease.
- **Projects need the event service.** Without it there is no routing, and the Projects screen says so.
- **Describe it can draft something that reads right and isn't.** The notes, the "added by the model" marks, the checks
  and the numbered approval list are there for that, and nothing runs before the person's approval. A message pasted
  as an example can steer the draft; it shows up as steps the person sees.
- **The `claude` CLI's flags may change between its releases.** They are pinned in one place and checked by a test
  against a fake. A CLI that refuses them makes Describe it say so and offer a key instead.
- **React Flow is a large dependency** for one screen. It's loaded only with the designer's chunk, and checked against
  the bundle's 3 MB file limit.
- **On Windows and Linux** every person act is done at a terminal, as today (0.33 §6).

## 14. Questions for the owner (with this spec's default)

1. **Workflows are rules with a flow,** in Events → Workflows, not a second kind of object. Default: yes.
2. **0.36 holds §12's first list;** worktrees and per-run questions come in 0.37. Default: yes.
3. **A session that may edit files without asking** needs your yes per run, unless it works in a worktree the run
   made. Default: yes.
4. **A route chooses among the projects it lists,** never "any project you add later". Default: listed only.
5. **A project's folders are part of each workflow's approval:** adding a folder means reviewing those workflows again.
   Its profile and hints change at once. Default: yes.
6. **Analyse runs through claude-stream** (a plan-mode session you'll see in Agents), not by Agent Comms calling
   `claude` or `codex` itself. Analyse reads a repository, which is an agent's work. Describe it calls the local
   `claude` directly, as you asked, because it reads no files. Default: claude-stream for Analyse.
7. **A profile says who asks about the project** only if you tick it, which sends those names and subjects to your
   provider. Default: off.
8. **Worktrees are kept** when a run ends; the branch is `ac/<issue identifier>`; the folder is `<checkout>-wt/`.
   Default: yes.
9. **"Finished" means the session said `done`** (Claude). Otherwise, and for Codex, the run tells you instead of
   closing the issue. Default: yes.
10. **Replying in the thread stays the session's own act,** gated as today; a prepared reply step comes later. Default:
    yes.
11. **Limits default to** 10 runs an hour, 2 at a time, 2 sessions an hour, 5 worktrees a day, runs end after 3 days.
    Default: these.
12. **Projects need the event service installed.** Default: yes.
13. **A step's place on the canvas is kept by the app,** not in the workflow, so moving a box never needs an approval,
    and Approve… shows a fresh layout. Default: yes.
14. **Describe it drafts with your Claude subscription by default,** and with your OpenRouter or Anthropic key when
    you choose one, or when `claude` isn't found. Default: Claude first.
15. **Describe it ships in 0.36** with the designer. Default: yes. It could slip to 0.37 without holding the rest back.

**To ask claude-stream for:** a create key on `POST /v1/sessions`; a status field and a `cwd` filter on
`GET /v1/sessions`; `outputFormat` for Codex.
