# Agent Comms: workflows, from a message to the right session (prototype, 2026-10-27)

The owner asked, on 2026-10-27, for "a workflow designer based on a node-style thing": an event comes in, conditions
are set, and if they are met it goes on; it finds which session the message is about and sends it there, looks for
another if that one isn't found, and starts a new session, in the right project and "a separate work tree, optionally
or not", if none is; and he wants to add behaviour such as creating a Linear ticket, with instructions for what it
contains, and closing it "when it finishes work". He then added: "I want this to be a UI experience as well, yes, build
a workflow by describing it, and also be able to build it visually by dragging and dropping."

These boards draw that for feedback before anything is built. They are written as a Claude Design canvas's sources, so
the prototype doesn't depend on any one Claude account. The format, palette, app shell and sidebar are those of
`docs/prototypes/2026-10-26-messages-lifecycle`, with one new sidebar item, Workflows, under Events. The rule editor's
continuity comes from `docs/prototypes/2026-10-26-0320` (RuleEdit, RuleEditText, RuleAnalyse).

## Open it on this Mac

```sh
cd docs/prototypes/2026-10-27-workflows
python3 -m http.server 8342
```

Then open http://localhost:8342/. `index.html` lists every screen.
- Each screen is clickable. A button that changes something shows what would happen: an approval to give, or a line
  saying it applied at once. A screen not drawn here (Queue, Messages, Projects and the rest) leads to `Main.dc.html`.
- Add `?theme=dark` to a screen's address for its dark look.
- Other levers: `WorkflowDesigner.dc.html?show=rule` (or `blank`), `&rule=client-asks` (or `invoices`,
  `mail-subjects`), `?selected=project` (any step's id, `added`, or `none` for the workflow's settings),
  `?stage=dragging` (or `added`, `drawing`, `connected`), `?sheet=true`; `WorkflowRun.dc.html?run=waiting` (or
  `finished`, `test`); `Describe.dc.html?drafted=false`; `Workflows.dc.html?approved=true`.
- In a browser, a step really drags from the left onto the canvas, and a wire is drawn by clicking a free port, then
  the new step's glowing input. On a canvas, "Try it, step by step" walks the same four moments.
- A small **new** chip marks what the app can't do yet. Everything without one is there today.

The screens need a local server, not `file://`, because each one loads `support.js`. That file is the small viewer
written for `docs/prototypes/2026-10-26-0320`, copied here unchanged. The screens load Inter from Google Fonts, so they
need the network to show that face.

## Put it on a canvas (any Claude account)

Ask Claude to create a Design canvas from these files:
- each `*.dc.html` file goes under the canvas's `project/` folder;
- `canvas.json` is the canvas's layout, and goes under `project/` too; it opens focused on `Main.dc.html`;
- leave out `support.js`, `index.html` and this README, since the canvas brings its own runtime.

`WorkflowDrag.dc.html` and `WorkflowStep.dc.html` are `WorkflowDesigner.dc.html` with other defaults (`stage=drawing`
with the new step selected; the Linear step selected with its editor open), so those moments have boards of their own.
The three files are the same apart from those defaults.

This folder hasn't been put on a canvas yet.

## What's here

| Row | Boards | What it shows |
|---|---|---|
| 0 · Start here | Main | every board, the owner's 13 points and where each one is, and what to tell the lead |
| 1 · Workflows, and building one by dragging | Workflows, WorkflowDesigner, WorkflowDrag | the list, with rules as straight-line workflows; the owner's example as a node canvas (palette, graph, selected step's settings, minimap, zoom); a step dragged on and a wire half-drawn |
| 2 · Building one by describing it, or as text | Describe, WorkflowText | the owner's words drafted into steps, each saying which words it came from, with four questions; the rule text language with steps and branches beside the canvas, changing together |
| 3 · A step in full, a run, and approving | WorkflowStep, WorkflowRun, WorkflowApprove | Create a Linear issue with fields, a description in parts and a live preview; one message's path lit on the graph (finished, waiting, a test); every step that reaches outside Agent Comms, the limits, and Approve |

## What would be new

- **Workflows:** a sidebar item under Events. Workflows with branches, and every rule shown as a straight-line workflow
  that keeps its name, version and approval; runs this week and the last run for each; New workflow… from your words,
  an empty canvas, a copy, or a rule.
- **The designer:** a node canvas (cue-ui's Flow components on React Flow): steps as node cards with ports, branch
  wires labelled (yes, none, busy, idle, found, free, run ended), a minimap, zoom and lock; a palette of step types; the
  selected step's settings beside it, with where it comes from and goes on to; Workflow settings for the limits.
- **Drag and drop:** dragging a step onto the canvas, a drop place shown, a free port ("timed out" on Wait for the run
  to end) and a wire drawn from it to the new step's input.
- **Describe a workflow:** your words, drafted by your Claude subscription or your OpenRouter or Anthropic key; each
  step marked "from: …" (the words it came from) or "added: …" (what your words didn't say); questions for what it
  guessed (which messages, no project, the worktree, the Linear team); Draft again; Open in the designer.
- **New steps:** Which project? (routing as a step, with a "none" branch); Find another session; Start a session in a
  new worktree, with a branch named `agent/{{ticket}}`; Wait for the run to end (claude-stream's run-ended event, with a
  "timed out" port); Linear update, comment and close; Reply in the thread (your yes each time, or a short reply
  approved in advance); Notify me; Branch.
- **The Linear step in full:** fields to click into the title, a description built from parts (fixed text, a summary
  the model writes, the message quoted as the sender's words, links), labels, assignee, status, and a live preview with
  two sample messages and checks; the session's link added to the issue when the message is delivered.
- **A run:** one message's path lit on the graph with times, the branch taken in a sentence ("busy → queued 4 min →
  delivered"), steps not taken and why, links to the message's story, the issue and the session; a run waiting for a
  session; a test of a draft on a recent message, where judges and lookups run for real and everything that acts says
  what it would do.
- **Text with steps:** `step name: …`, branches with `→`, `then stop`; the text and the canvas change together.
- **Review and approve a workflow:** every step that reaches outside Agent Comms in plain words, what changed since the
  last version, the limits (runs an hour, sessions at once, worktree clean-up, waits), what leaves this Mac, and what it
  can never do.

Already in the app, so not marked: a rule's parts (0.33): When, Which messages, Ask a judge with a threshold, Then do;
the Queue and lanes that wake a bound window (0.31); a session claude-stream runs, found by folder, started with Claude
Code or Codex if there's none, and queued while it's busy; a Linear issue made with fields and a model's words; a
webhook; the dry-run log; a rule edited as text with checks as you type; each version approved by you before it runs.

## For the lead: where the drawing makes a choice

- **The Linear issue is made before a session is looked for**, not after Start a session as first listed. The worktree's
  branch is named after the issue (`agent/{{ticket}}`), so the issue has to exist before a session can start, and every
  path, not only a new session, then carries it and closes it. The session's link is added to the issue when the
  message is delivered: a Linear update, listed when the person approves. Moving the step back is one wire, but then
  the branch can't be named after the ticket.
- **Which project? runs before Find a session**, not only before starting one (the owner's point 9), so every search
  knows where to look. Its "none" branch puts the message in the Queue, lane triage.
- **A busy session gets its own step,** Queue for the session, on a "busy" branch: claude-stream refuses a second prompt
  while a run is going, as today. It waits at most 2 hours, then tells the person.
- **Worktrees are made by Agent Comms with git,** because claude-stream doesn't make them: in a sibling `-wt` folder,
  which must be inside claude-stream's allowed roots, removed 7 days after the issue closes and only if nothing in it is
  uncommitted. Agent Comms running git in the person's repositories is a new kind of action, so it's listed when
  approving.
- **Closing the issue** happens only if the run ended without an error, with the session's last message as the comment
  (cut to 2,000 characters). That message can quote the sender, so it would be carried as untrusted text.
- **Replies** need the person's yes each time by default; the other choice is only a short reply approved in advance
  ("Done:" with the issue's link), like the 👀 and fixed replies under a reply approved in advance today.
- **A test run** asks the judge and looks sessions up for real, because those only read (a judge question still costs
  a call), and shows everything that acts as "would". It runs the draft, so it can take a different path from the live
  run: the drawn test finds the session idle and would deliver at once.
- **Describe** sends the person's words and the projects' names and profiles to the model they choose, never a message.
  The draft adds what the words didn't say (a judge, the busy and none branches), marked "added:", and asks four
  questions rather than guessing silently. An agent can draft a workflow; only the person approves one, in the app.
- **One new step at a time** in the drag-and-drop drawing; the app would keep them all. The free port shown is "timed
  out" on Wait for the run to end, wired to Notify me.
- **The limits drawn:** 20 runs an hour, 3 sessions at once, 2 hours for a busy session, 1 day for a run, worktrees
  removed 7 days after their issue closes. They're placeholders for the owner to set.
- **Version 2 adds Reply in the thread** to a workflow whose version 1 is on, so the list, the designer, the run (on
  version 1) and the approval show versions working as rules' do today.

All names, addresses, messages, repositories, issues and numbers are made up (a colleague David Park at acme, the
person Chris Moldovan, the projects acme-site and billing, the Linear team ACME). None of it is real data.
