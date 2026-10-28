# @agentcomms/events-daemon

`agent-events` watches the Gmail, Slack, Resend and WhatsApp accounts you have already connected with
agent-communications. When an event matches a workflow you approved, it delivers that event to the workflow's targets:
- a signed HTTPS webhook;
- a local live stream (server-sent events) for your own tools;
- a queue you work through in the desktop app or at your terminal, or a lane of it that wakes one agent window;
- a dry-run log you read at your terminal or in the desktop app, which keeps each entry 24 hours at most.

Nothing is collected and nothing leaves this machine until you approve the workflow yourself, at your terminal.

```bash
npm i -g @agentcomms/events-daemon   # or run any command with: npx -y @agentcomms/events-daemon <command>
agent-events run                     # in a terminal you keep open: the owner of all event state
```

## What it needs

- **macOS or Linux.** Windows is refused for now: Node cannot yet make a control pipe that only your account can open.
- **Node 22.16.0 or newer**, the first release with Node's built-in SQLite. An older Node is refused, and the message
  says what to install.
- **The accounts you want to watch, already connected** with `agent-gmail`, `agent-slack`, `agent-resend` or
  `agent-whatsapp`. The daemon reads through those packages and never sends mail or messages through them.

## How it runs

`agent-events run` starts the **foreground owner**. It owns the event database while that terminal runs, and stops
cleanly on `agent-events stop` or when the terminal closes. A clean stop writes `last-stop.json` beside the
database, with the owner's PID, the time, and whether it was asked to stop or got a signal, so a supervisor can tell
it from a crash. From 0.27.0 the desktop app can
run it for you: it starts it in the background, restarts it after a crash and keeps it running after the app quits
(see [the desktop app](../../README.md#the-desktop-app)). There is still no OS service of its own (launchd, systemd
or a Windows service). Its state lives in an owner-only directory. A state directory so
deep that its control socket's path would pass the system limit (103 bytes on macOS, 107 on Linux) is refused, with
a hint to pin a shorter one. `agent-events --version` (or `-V`) prints the installed daemon version; a subcommand's
`--version <number>` continues to select an immutable workflow, target, subscriber or judge version.

## A first workflow: Gmail into the dry-run log

The dry-run target keeps what matched in an encrypted local log that only you can read, at your terminal or in the
desktop app. It keeps each entry 24 hours at most, and then deletes it. It is the safe way to see what a workflow would
send before you point it at a webhook.

```bash
# 1. a target: the local dry-run log, keeping records for a day
agent-events target add '{"targetId":"log","version":1,"kind":"dry-run","retentionMs":86400000}'

# 2. a workflow: every received Gmail message with a subject, mapped to its subject only
agent-events sources list          # every connected account a workflow can name: its source, id and name
agent-events workflow create "$(cat workflow.json)"

# 3. turn it on: each step prints an approval, which you approve by typing its challenge
agent-events enable-all            # the standing approval that starts collection
agent-events approve <approval-id>
agent-events workflow enable mail-subjects 1
agent-events approve <approval-id> # offers to test the target first; answering no is fine

# 4. read what matched: the list gives each record's id, and show prints that record
agent-events dryrun list
agent-events dryrun show <record-id>
agent-events delivery show <record-id>   # the delivery itself: its decision, the message it came from, its target
```

`dryrun list` and `dryrun show` take `--json` too, which is how the desktop app reads the log: `show` then gives the
record as data (the exact event it would have sent), with every field its sender controls inside the untrusted-content
envelope: the ones `agentcommsuntrusted` names, every address (From, Reply-To, To, Cc) and the fields the queue shows
from a sender, as `queue show --json` gives them.
Inside the event service's MCP server both refuse, so no agent reads the log through MCP.

Switch collection on before approving the workflow: a pending target can be tested only while collection is on. If a
test cannot run, the approval says why and still asks for its challenge.

In the desktop app, **Events → Service → Switch on…** does the first two lines of step 3 for you: it runs `enable-all`, shows you
the approval's preview — the workflows collection starts for — and, when you press Approve, approves exactly that
approval with `agent-events collection approve <approval-id> --digest <digest>`, the digest its preview showed. That
command is the app's own: it refuses an agent's shell and the event service's MCP server, and on macOS it first checks
that the app started it (core's `desktopAppOrigin`), a speed bump against agents, not a boundary against code running as
you. On Windows and Linux nothing attests the app, so it is refused with `APPROVAL_REQUIRED` (exit 10, reason
`ORIGIN_UNATTESTED`), naming `approve <approval-id>`, and the app offers Do it in Terminal, where you type the challenge
as above. **Switch off** is `disable-all`: it takes away, so it applies at once, from anywhere, and its result's `said` tells you
in plain words what it did.

An approval that `workflow enable` or `enable-all` prints lasts 30 minutes. If it runs out, or is revoked, before you
approve it, nothing is turned on. On its next tick, or when it next starts, the service cancels the activation that
was waiting for it, and `status` stops counting it as pending. Run `workflow enable` again for a new approval. An update
that lapsed this way no longer blocks the workflow's next version.

`workflow.json`:

```json
{
  "ruleId": "mail-subjects",
  "version": 1,
  "source": {
    "channel": "gmail",
    "accountIds": ["<an account id from sources list>"],
    "options": { "channel": "gmail", "labels": "inbox", "includeSpamTrash": false }
  },
  "event": { "type": "gmail.message.received", "version": 1 },
  "condition": { "path": "/subject", "op": "exists" },
  "mapping": { "subject": { "$path": "/subject" } },
  "targets": [{ "targetId": "log", "version": 1, "kind": "dry-run", "retentionMs": 86400000 }],
  "subscribers": [],
  "judges": [],
  "deliveryRateCap": 1,
  "retention": {
    "ingestMs": 86400000,
    "holdMs": 86400000,
    "deliveryMs": 86400000,
    "dryrunMs": 86400000,
    "sseReplayMs": 86400000,
    "deadLetterMs": 86400000,
    "decisionMetadataMs": 604800000
  }
}
```

Workflows, targets and subscribers are immutable versions. To change one, create its next version and enable it. The
approval preview then shows exactly what changes. A workflow is what earlier releases called a rule: `workflow` and
`workflows` also answer to `rule` and `rules`, so scripts keep working, and a workflow's document keeps its `ruleId`.

## A queue

From 0.30.0 a workflow can put each match in a list you work through: a `queue` target. Each item says what arrived (the
channel, the account, from whom, the subject or first words, when), which workflow matched and, when the workflow asked
a judge, what it answered. You mark it **done** or **dismiss** it, and open the message in Gmail or Slack when the item
has a link. The desktop app shows the queue in its own screen; at a terminal:

```bash
agent-events target add '{"targetId":"inbox-queue","version":1,"kind":"queue","retentionMs":604800000,"show":"summary"}'
agent-events queue list              # open items, newest first, with what they say: add --json for the app's shape
agent-events queue show <item-id>
agent-events queue done <item-id>    # or: dismiss, reopen
agent-events queue clear             # remove done and dismissed items now (yours alone: no MCP tool clears)
```

- **What a workflow needs:** a queue target, `retention.queueMs` (1 to 30 days; a queue target's own retention is 1 to
  30 days, 7 by default, and the lesser of the two applies), and a mapping that includes what an item shows. For Gmail,
  that is the sender and the subject; for Slack, the poster's name and the text; for Resend, the sender and the
  subject or body; for WhatsApp, the sender and the text. A workflow without them is refused, and the refusal names
  what is missing. Nothing is fetched to fill an item: its first words come only from a field the workflow maps, and its
  link only from ids the workflow maps.
- **How long it keeps:** an item's content goes at its retention, whatever you did with it; its content-free row
  (workflow, state, times) stays one retention more, for the counts. Every revocation that removes a workflow's dry-run
  records removes its queue items too: disabling or tightening the workflow, removing its target or judge, turning its
  judge's kind off, `disable-all`, removing the account, or a WhatsApp chat your lists now hide. A tighter version's
  `workflow update` result says how many open items enabling it will remove.
- **Who can read it:** you. `queue list`, `queue show` and `queue clear` refuse inside the event service's MCP server
  (`agent-events mcp`) and every program it starts; core's and the channels' MCP servers don't run the event service's
  CLI. Over MCP an agent gets `events_queue_items` and `events_queue_counts`, which never carry a sender, subject,
  text or link, and can mark an item done, dismissed or reopened without reading it; a done or dismissed item stays
  in your Done or Dismissed tab for its retention. Clearing the queue is yours alone, at your terminal or in the app:
  no MCP tool does it, so an agent cannot make your queue disappear. A queue target makes no network connection.

## A lane

From 0.31.0 a queue can be a **lane**: you name it (`david`, `billing`), bind it to one agent window, and that window
is woken for each new item and may read it. Nothing else changes about the queue: a lane's items are queue items,
kept, purged and shown as every queue item is, and each item names its lane.

```bash
# 1. a lane is a queue target with a name; a workflow sends to it, and you approve the workflow as any other
agent-events target add '{"targetId":"lane-david","version":1,"kind":"queue","retentionMs":604800000,"show":"summary","lane":{"name":"david"}}'

# 2. the agent in the window you want tells you its id (events_lane_whoami); you bind it, at your terminal
agent-events lane bind david --window 25f971a3-0c69-44e3-971c-3a4656afa986

agent-events lane list               # every lane, its workflows, channels, open items and the window bound to it
agent-events lane unbind david       # at once; the window's watches end
```

- **Binding is yours.** No MCP tool binds a lane. `lane bind` asks you to type the lane's name, and refuses an
  agent's shell, anything without an interactive terminal, and the event service's MCP server. A
  window's id is its Claude Code session id, or its activity session key; `agent-events mcp` works out both for the
  window it runs in. Only a window that can be told apart from others can be bound: one with a Claude Code session
  id, or a grouped activity session (not Windows, and not a server started in `/`, the home folder or a system
  folder). One window per lane, and one lane per window. The app's Lanes panel opens your terminal with the command.
- **What the window gets.** `events_watch({ lane })` answers with an MCP task (protocol 2026-07-28, the tasks
  extension) that completes on the lane's next new item: Claude Code wakes an idle window for it. The wake is a
  pointer the event service writes — "1 new item in lane david (Slack, workflow david-on-slack): read it with
  events_lane_item, item qi_…" — never a sender, subject or text. The window reads the item with
  `events_lane_item({ item })`, every field its sender wrote inside an untrusted-content envelope, then watches again.
  A client without the tasks extension waits with `events_wait({ lane, seconds })`, up to 50 seconds at a time.
- **Only what arrives after you bind.** A window wakes for, reads and sees in `events_queue_items` only items that
  arrived after its binding. Binding again starts again.
- **Every other window sees no lane item** over MCP, in any queue tool, and is not told one exists. You, at the
  terminal and in the app, see everything.
- **A binding ends** when you unbind it (or the window unbinds its own), when no active workflow sends to the lane any
  more, and with `disable-all`. It follows the lane across a new version of its target that you approve. Making a
  queue a lane, or renaming one, is a new target version, approved through a new workflow activation, and the approval
  says "Items in lane david can be read by the agent window you bind to it." Two different targets of active workflows
  cannot share a lane's name.
- **The protocol.** `agent-events mcp` now serves both MCP eras: a client that offers 2026-07-28 negotiates it, and a
  2025-era client connects as before.

## A Linear issue

From 0.33.0 a workflow can add an issue to your Linear workspace. Connect Linear once with a personal API key from your
Linear account's settings, in the app's Settings → Integrations or at your terminal:

```bash
# 1. your Linear key: typed at this terminal, hidden — never piped in, never an argument
agent-events provider key set linear

# 2. what the key can see: the workspace and its teams, and a team's labels
agent-events --json integration show linear --team CUE

# 3. a target: the team, its labels, who it is assigned to, and the title and description, whose {{field}} slots
#    name fields the workflow keeps
agent-events target add '{"targetId":"billing-issues","version":1,"kind":"linear","team":{"id":"<team id>","key":"CUE"},"title":{"text":"Invoice from {{sender}}"},"description":{"text":"{{subject}}"},"labels":[{"id":"<label id>","name":"Billing"}],"assignee":"me"}'
```

- **The key is yours.** It is kept with the AI provider keys, set and removed only where you are — at an interactive
  terminal, or in the Agent Comms app — never by an agent, and never shown again. `provider list` and
  `events_provider_list` say whether a Linear key is kept. `integration show linear` is your read too: it refuses
  inside an MCP server's process, and no MCP tool reaches it.
- **Only what the workflow keeps.** Each `{{field}}` in the title and description names one of the workflow's mapped
  fields (`{{subject}}`, `{{sender}}`, or `{{from.address}}` within a mapped `from`); a workflow naming any other is
  refused when you activate it. A model-written title or description comes later. The approval says which team, labels
  and assignee, and which fields fill the title and the description.
- **A slot's value stays text.** Linear makes a mention from a person's or an issue's plain address, links bare
  addresses and issue ids, and reads the description as Markdown. So in the description every slot's value is a block
  quote, its text inside a code block, where Linear makes no link, mention or formatting: a value from the message is
  labelled "From outside: written by the sender, not checked", and a constant the workflow's mapping sets "From the
  workflow's mapping: a fixed value, shown as text" — an agent may have written that constant. In the title, which is plain
  text, each is one line. The templates' own words are written as they are, as you approved them, and the description
  ends with the workflow and delivery that added the issue.
- **Checked against Linear.** When you enable a workflow and a Linear key is kept, the event service asks Linear (as
  `integration show linear --team` does) whether each target's team key is the team its id names, and each label name
  its id's; a mismatch is refused (`LINEAR_TEAM_MISMATCH`, `LINEAR_LABEL_MISMATCH`), and so is a key Linear refuses or a
  Linear that does not answer. With no key kept the check is skipped — nothing is sent until there is one — and
  `approval view` says so.
- **One issue per match.** The issue is sent to `https://api.linear.app/graphql` — the one Linear address the event
  service may reach — through the same pinned, checked connection as a hosted judge. A rate limit, a 5xx or no answer
  is tried again, as a webhook's failure is, up to ten times; Linear refusing the issue fails it at once with Linear's
  code (`LINEAR_INVALID_INPUT`, `LINEAR_AUTHENTICATION_ERROR`, …). The issue's id is chosen from the delivery's, and each
  try first looks for it, so a retry after a lost answer never adds a second issue. With no key, a delivery waits
  (`LINEAR_KEY_MISSING`) and sends nothing.
- **A change, in a workflow.** A workflow's `linear-change` target comments on, moves, labels or assigns the issue an
  earlier step of the same run created (its deliver step's `to.issue`), and no other: the issue comes from that step's
  own output, never from a message, and it must still be in the target's team. It goes through the same address, key
  and checks as an issue. The comment's id is chosen from the delivery's, so a retry after a lost answer finds it
  instead of adding a second; a state, labels and an assignee are one `issueUpdate`, which a retry repeats harmlessly.
  Each slot in the comment is quoted as an issue's are, and a session's summary (`{{steps.<wait>.summary}}`, a
  comment's slot only) is labelled "Written by an agent, not checked". Each change counts the workflow's
  `linearWritesPerHour`, as an issue does.
- **What is kept.** The rendered title and description wait on the delivery, encrypted, only until the issue is
  added or the delivery's retention (`retention.deliveryMs`) ends; a failed one's are kept as a webhook's dead letter
  is, for `retention.deadLetterMs`. After that the delivery keeps only its issue's id, identifier and address, for the
  workflow's delivery retention: `deliveries list` and `delivery show` give them as `linear: { identifier, url }`, the
  address without the title's words. Nothing the issue says is kept.

## What happened to a message

From 0.32.0 the event service tells you what became of each message it observed: whether each workflow matched it and
what its judge answered, where each delivery went, the queue item it became, and what happened to that item since —
which agent window was woken for it and read it, and who marked it done, dismissed it or reopened it. The desktop app
reads it for its Messages screen; at a terminal:

```bash
agent-events messages list --json                    # the last 30 days, newest first, 100 at a time
agent-events messages list --before <next> --json    # the page after: pass back the next the last page gave
agent-events message show <event-id> --json          # one message, with every line of its queue item's history
```

- **What each message holds:**
  - its event id, type, channel, account, and when it happened and was observed;
  - its source's own ids: a Gmail message id, a Slack channel and ts, a WhatsApp chat and message id, a Resend email
    id. These are the ids its link and agent-communications' activity log use;
  - each workflow's decision, with the judge's answer while the decision's record is kept;
  - each delivery's target and state;
  - its queue item, with that item's history. `agent-events messages list` gives the newest line of each kind;
    `agent-events message show` gives every line.
- **Ids and times only, but for what a queue kept.** When the message's queue target keeps a summary
  (`show: summary`), `kept` gives its sender and subject as `agent-events queue show` does: inside the
  untrusted-content envelope, data and never instructions.
- **Who did what.** An item's history lines are `woken`, `read`, `done`, `dismissed` and `reopened`. Each says
  `window`, with the agent window's activity session key, for a call through the event service's MCP server, or
  `person`, for the CLI and the app. An item keeps its newest 500 lines, and its history goes when the item goes.
- **Who can read it: you.** `agent-events messages list` and `agent-events message show` refuse inside the event
  service's MCP server (`agent-events mcp`) and every program it starts. No MCP tool returns a message's story or an
  item's history. The history is never written to agent-communications' activity log, so no agent's own activity
  view names an item in a lane bound to another window.
- **What it can't see.** Only what the event service saw: a reply an agent sent is in the activity log, and what you
  did in Gmail or Slack yourself is in neither. `--since` and `--before` take milliseconds since 1970, and `--limit`
  is 1 to 500.

## Analyse a workflow

From 0.33.0 the event service suggests how to improve a workflow, or a draft of it, part by part: each suggestion says
what the part says now, what it could say, why, and what that rests on. It never applies one. The desktop app puts the
one you choose into the editor, and you approve the new version as any other. At a terminal:

```bash
agent-events workflow analyse invoices --json                        # the workflow's active version, else its newest
agent-events workflow analyse invoices --draft - --json < draft.json # a draft: one JSON workflow document on stdin
agent-events workflow analyse invoices --provider anthropic --json   # the model on your Anthropic key
```

- **What it reads.** The workflow, or the draft, and content-free counts of what the workflow did on this Mac in the
  last 30 days:
  - its decisions, and their outcomes;
  - the judge's answers, and their spread;
  - per sending domain, what the judge said;
  - the queue items you marked done or dismissed, against the judge's number for each.

  It reads no subject, body, snippet or address. A domain is counted only when a judged decision kept it: from 0.33.0
  a judged decision keeps its sender's domain (never the address), when the workflow tests or keeps `from.address` and
  the domain is a plain ASCII hostname. It is kept apart from the decision's metadata, encrypted, and only as long as
  the workflow keeps the message's content — its projection's deadline, the ingest retention (7 days by default) — not
  the 90 days of the decision's content-free metadata; it goes sooner with that metadata, and a tightening shortens it.
  So Analyse's per-domain counts cover the last week or so, the rest of its counts the last 30 days.
- **What it suggests from the counts alone:**
  - a sending domain the judge said no to three times or more, and never yes: the condition, with that domain left out
    before the judge is asked;
  - when every message you kept scored above every one you dismissed: a judge bar between them;
  - when nothing passed in 30 days: a note that says so.
- **What a model suggests,** each through its own fixed brief (`src/domain/analyse-prompts.ts`):
  - the judge's question, as TypeSafe advises for System One questions: one yes-or-no about one fact, naming who asks
    for what;
  - a session's context text, as a task, steps, limits and what to do when unsure;
  - a Linear issue's title template, using only the workflow's mapped fields.
- **Where the model runs.** On the provider you name, or else the first with a key: OpenRouter
  (`anthropic/claude-sonnet-5.5`, the key Jev may already use), then Anthropic's own API (`claude-sonnet-5-5`, with
  `agent-events provider key set anthropic`). The result's `model` names the provider and the model, or why it did not
  run — `NO_KEY`, with `noKey` listing the providers that have none. The suggestions from the counts come either way.
- **What it sends.** The workflow's own text around each part — its question, a session's text and a Linear title as you
  wrote them, and its condition with each address and domain it names (a person it watches for, a domain an applied
  exclusion left out) replaced by `<address>` or `<domain>` — and the counts without any domain: never a message or
  anything from one, no sender, subject, body or address. The network allows only `https://openrouter.ai/api/v1/chat/completions` and
  `https://api.anthropic.com/v1/messages`, through the same pinned path as the judges, with a 64 KiB request, a 256 KiB
  answer and a 60-second deadline.
- **What it takes back.** One JSON object, `{ "after": …, "why": … }`, within each part's limit; anything else is
  refused with a closed reason (`MODEL_OUTPUT_NOT_JSON`, `MODEL_OUTPUT_SLOTS`, …), and the provider's own words are
  never kept. A suggestion you apply is your workflow's text from then on, and you approve it with the workflow.
- **Who can run it: you.** It runs when you press Analyse in the app or run it at an interactive terminal, as
  `provider key set` does. `workflow analyse` refuses inside the event service's MCP server, in an agent's shell (an
  agent's marker) and, on macOS, from any process the Agent Comms app did not start — a speed bump against agents, not
  a boundary against code running as you — and no MCP tool runs it.

## A workflow that branches

From 0.36.0 a workflow can do more than send each match to one place. A workflow with a `flow` is a graph of steps: it
can choose a project, find or start a session, make a worktree, hand the message over, wait for the turn to end, write
to Linear, tell you, and raise events for others. Rules and workflows are one list now; `agent-events rule …` still
works, and the MCP tools keep their `rule` names.

```
workflow client-asks, version 5

when a Slack message is posted in acme/slack, in conversation C0123
match text exists

flow, at most 6 runs an hour
  events in acme as client-asks, run emits failed and finished
  step route: choose a project among acme-site and billing, by hints
    looking at text
    project acme-site, in /example/home/work/acme-site
    project billing, in /example/home/work/billing
    none → tell
  step issue: linear issue client-issues, version 1, in team ACME, assigned to me
    team id 0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11
    title "{{author.name}} asks about {{steps.route.project}}"
    emits created
  step find: find a session in route's project, with claude-code
    idle → give
    busy → free
    none → tree
  step free: wait for find's session to be free, up to 2 hours
    free → give
    otherwise → tell
  step tree: make a worktree of route's project, branch "ac/{{steps.issue.identifier}}"
    refused → tell
  step start: start a session in tree, with claude-code, mode manual
  step give: session client-prompt, version 2, with claude-code, to find or start
    give
      fields text, author.name
      text "Do what they ask, on a branch of its own. Don't push."
    report done and needs-the-person
  step wait: wait for give's turn to end, up to 1 day
    done → note
    otherwise → tell
  step note: linear change client-done, version 1, in team ACME, on issue
    team id 0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11
    comment "{{steps.wait.summary}}"
    state Done, a completed state
    state id 5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f
    then → end
  step tell: tell me "A message for {{steps.route.project}} needs you"

keep author.name, text
at most 60 an hour
```

- **The steps.** A condition or a judge (yes, no, unsure); **Which project?** (`route`, by your hints, then a judge if
  you name one); **find a session** in a project, a worktree or the session that took this conversation (idle, busy,
  watched, none); **start a session** (started, refused); **make a worktree** (made, refused); **hand it over** to a
  session, a queue, a webhook or Linear (done, left in the queue, failed); **wait** for a turn to end, a session to be
  free or a time (and `timed-out`); **tell me**; **split** into branches that run side by side; and **raise an event**.
- **Arrows.** A step's outcome goes where its arrow says (`busy → free`); an outcome with no arrow goes on to the next
  step written, so a straight line needs none. `->` may be typed for `→`. `otherwise → <step>` sends every outcome not
  named; `then → end` or `then stop` ends the run there.
- **Limits are written out.** `flow, at most …` sets runs an hour (default 10, at most 60), runs at a time (2, at most
  8), sessions started an hour (2, at most 10), worktrees a day (5, at most 20), Linear writes an hour (30, at most
  120), events an hour (120, at most 600) and a run's deadline (3 days, at most 30). A flow has at most 32 steps and a
  run at most 64 executed steps; a step a limit holds isn't counted again each time it wakes. Runs a limit holds wait
  their turn, oldest first, and never hold back another workflow's runs.
- **How git runs for a worktree.** As you, with no shell, without the repository's hooks, with every key that names a
  program by a fixed name (`core.fsmonitor`, `core.sshCommand`, `credential.helper`, …) overridden on the command line,
  and without the system git config; your global one is read. A run's worktree shares its checkout's config, which a
  session working in it can write. So before git adds, checks out, checks or removes a worktree, the event service reads
  the repository's config. It refuses a repository whose own config (local or worktree scope) names a filter, diff or
  merge program, or an include: `REPO_CONFIG_UNSAFE`, with the key and its scope, never its value (0.37.0). A worktree
  is added with nothing checked out, and the config is read again before the checkout, so a filter planted in between
  never runs. Git LFS in your global config, where `git lfs install` puts it, keeps working; LFS set in one
  repository's own config is refused like any other filter: move it to your global config.
- **The session that took this conversation.** `find the session that took this conversation, with claude-code` finds
  the Claude Code session that took an earlier message in the same Gmail thread or Slack thread (0.35.0's taking). Only
  a take by an agent window's own session counts, never one by a command that joined no window, and the session found
  must still work in the folder that window worked in, inside the relay's allowed roots. The message's own take doesn't
  count, and a Codex session can't be found this way.
- **What a session is told.** A flow hands a message over through a `session` target, as a straight-line workflow
  does: its fixed frame, the fields you mapped, the sender's words inside their envelope. The session is offered the
  message for 15 minutes after it is handed over, and still takes it itself.
- **Approved as a whole.** The approval lists, after the workflow's plain words, one numbered line per step that does
  something: the folders a session may work in, the projects it may choose, each Linear team and state, the fields that
  leave and each event it raises. From 0.37.0 its last line says the limits, every one, defaults too: "At most 6 runs
  an hour, 2 at a time; at most 2 sessions started, 30 Linear writes and 120 events an hour; at most 5 worktrees a day;
  a run ends after 3 days." The JSON you approve under them holds them too. Moving a box in the designer doesn't change
  the version; changing a step, an arrow, a limit or an event makes a new one, approved again.
- **In the app** a workflow opens in its designer: the canvas, the text and the JSON are three views of one document,
  with the checks under them.

## A workflow's runs

From 0.36.0 a workflow with a `flow` makes a run for each message it matches, and the run goes through its steps. The
desktop app shows them in a workflow's Runs and in the run view; at a terminal:

```bash
agent-events runs list --json                                     # newest first, at most 200
agent-events runs list --workflow client-asks --state waiting --json
agent-events runs show <run-id> --json                            # one run: its path, each step, the events it raised
agent-events runs cancel <run-id> --json                          # stop it now; its session's turn runs on
agent-events runs cancel <run-id> --interrupt --json              # and interrupt that turn too
```

It is `runs`, not `run`: `agent-events run` starts the event service.

- **What a run says.** Its id (`wfr_…`), its workflow and the version it started on (`ruleVersion`), its state —
  `held`, `running`, `waiting`, `done`, `failed`, `cancelled` or `expired` — its times, the message it is about
  (`eventId`), its parent run and depth when another workflow's event started it, whether it is a shadow, and what it
  waits on: the step, the kind (`turn-end`, `session-idle`, `time` or `limit`), since when, how many are ahead of it in
  a busy session's queue, and whether the turn needs you in claude-stream. Its `summary` is the story line a list
  shows: the project Which project? chose, the issue it made, whether it `found` or `started` a session, and how the
  turn it gave ended — each from a settled step's closed output, never a folder or a sender's words.
- **A run keeps its version.** `runs show` gives the steps of the version the run started on, of that version's kinds,
  even after you edit the workflow: a run finishes under its own version. The app draws it from
  `workflow show <id> --version <n>`.
- **What `runs show` adds.** The path the run took, each step it reached with its outcome, attempts, times, closed
  output, last error code, delivery and wait, how many events it did not raise over its limit, and each event it raised
  with who it was delivered to. A step's output is ids and closed words, and a worktree's folder: `runs show` is the
  one place a run's folders are shown, to you. No event carries one.
- **How long a run is kept.** A run's history — its steps, its waits, the events it raised and their deliveries — is
  kept as long as its decision's metadata (`retention.decisionMetadataMs`, `decisions <duration>` in the text; 90 days
  by default), then purged with it. A run still going, or one with an event still being delivered or a dead letter
  still kept, stays until those end. A worktree's row goes once the worktree was removed or never made. From 0.37.0
  the row of a worktree a purged run made or kept is looked at every 10 minutes, at most 100 at a time: once its folder
  is gone, or is no longer a worktree of its checkout (`git worktree list --porcelain`), the row goes; a worktree still
  on disk keeps its row, and Projects keeps showing it, for you to remove; a row whose checkout can't be read stays for
  the next look. The sweep never touches the worktree itself.
- **How a run ends** (`endCode`). Done carries none. Otherwise:
  - `RUN_EXPIRED`: it reached its deadline (`flow.limits.runMs`);
  - `CANCELLED_BY_PERSON`: you cancelled it;
  - `DISABLED_ALL`: collection was switched off;
  - `AUTHORIZATION_REVOKED`: its version's authority ended — `workflow disable`, a tightening, or a target, subscriber
    or judge kind it used removed or turned off;
  - `ACCOUNT_REMOVED`: the account it watches was removed;
  - `STEP_LIMIT`: it executed 64 steps (its deliveries still waiting are cancelled, as at a cancel);
  - `STEP_FAILED`: a step ended on a failure outcome (`refused`, `failed`) that no arrow handles;
  - a step's own code, when that step failed (`STEP_THREW`, `OUTCOME_UNKNOWN`, …);
  - the fence's reason, when its version's authority was found gone just before a step (`RULE_REVOKED` and its kin).
- **Cancel is yours, at once.** `runs cancel` cancels the run's deliveries still waiting and its events not yet
  delivered, and purges what they kept; drops its waits; purges the run's own record; and says how many it cancelled.
  It applies straight away, even while one of the run's steps is under way: that step's result is dropped, so nothing
  after it runs. An event of the run being sent is stopped, its dead letters can't be tried again, and the frames a live
  subscriber was given are deleted, so reconnecting doesn't replay them; the run's own `cancelled` event still goes
  out. A session's turn the run started goes on unless you add `--interrupt`, which asks claude-stream to interrupt it
  (`interrupted` says whether it did; with it, the answer waits for the step under way). A run that has ended can't be
  cancelled. However a run is cancelled — by you, by
  switching collection off, by a revocation or by an account's removal — each step it ran is finished afterwards, as at
  any run's end: a worktree made with `cleanup: remove-if-clean` is removed if it is clean.
- **Who can do it: you.** Every `runs` command refuses inside the event service's MCP server, in an agent's shell (an
  agent's marker) and, on macOS, from any process the Agent Comms app did not start — a speed bump against agents, not
  a boundary against code running as you. The event service takes them only from your terminal or the app, and no MCP
  tool lists, shows or cancels a run.

## Try a workflow

From 0.36.0 you can check a workflow and try it before it runs, at a terminal or in the app's designer:

```bash
agent-events workflow check - --json < client-asks.json                      # every problem, with its code; writes nothing
agent-events workflow test - gmail.message.received@1:1 --json < client-asks.json
agent-events workflow test - gmail.message.received@1:1 --outcome find=busy --json < client-asks.json
agent-events workflow test-retained <event-id> --workflow client-asks --version 5   # on a recent message (you only)
agent-events workflow show client-asks --version 5 --json                     # that one version alone
```

- **`workflow check`** reads the document as the event service does — canonical, its flow checked by `checkFlow` and
  against its own targets, its events' name free among the active workflows — and lists every problem
  (`FLOW_CYCLE`, `FLOW_TARGET_UNUSED`, `VERSION_DOCUMENT_INVALID`, …) with the step and pointer it is about. An agent
  may check a document as you may (`events_rule_check`): it holds no content and writes nothing.
- **`workflow test`** walks a flow over a catalogue example. Each step answers with the outcome you name with
  `--outcome <step>=<outcome>`, or else its first; every effect is a "would" — what it would have done, the prompt a
  session would have been sent and the issue Linear would have been given, as written, with the sender's words inside
  their envelope or labelled quote — and each event it would raise is shown with its data. It does no I/O and makes no
  run. A workflow without a flow is tested as before.
- **`workflow test-retained`** tries a flow on a message the event service still holds: a condition, a judge, Which
  project? and a find answer for real, reading only — a find of the session that took the conversation with the
  message's own ids — and every start, worktree, delivery, notice and event is a "would". Nothing is started.
- **A shadow version** (`flow.shadow: true`) is approved like any other and runs on real messages, route and find for
  real; every start, worktree, delivery, notice and raised event becomes a dry-run record of what it would have done,
  kept 24 hours (`agent-events dryrun list`, `dryrun show <id>`), and each wait ends at once, `timed-out`. Each event
  ticked on a step it does run — a condition, Which project?, a find — and each of the run's own is a dry-run record
  too. Nothing leaves, and it raises no event, so no subscriber gets one.
- **A flow's approval** lists, after the workflow's plain words, one numbered line per step that does something, as
  `describeFlow` says it, and last the flow's limits.

## Projects

From 0.36.0 a project is a GitHub repository, its folders on this Mac (checkouts and their worktrees), a profile you
write and hints. A workflow's **Which project?** step chooses among the projects its approval names; then a session
can be found or started there, or a worktree made of it. In the app, **Projects** in the sidebar shows each project
with its folders and the sessions working in them; at a terminal:

```bash
agent-events project scan --json                    # the GitHub checkouts under the relay's roots, else ~/work and ~/code
agent-events project add - --json < acme-site.json  # { projectId, name, repo, profile, hints, folders }
agent-events projects list --json                   # each project, with the relay sessions working in it
agent-events project show acme-site --json
agent-events project update - --json < acme-site.json
agent-events project remove acme-site --json
```

- **Scan finds, you choose.** `project scan` walks the relay's allowed roots, or `~/work` and `~/code`, four folders
  down (or the `--root` folders you name, at most 8). It follows no symlink, reads no file, and groups what it finds
  by the GitHub repository each checkout's origin names, with each checkout's worktrees. You pick the folders. A folder
  whose repository's own git config names a program git would run is passed over as `unsafe-config`, with the key and
  its scope, and `project add` refuses it until you move that key to your global config or remove it (0.37.0).
- **Hints choose without a judge:** sender domains (`acme.example`), Slack conversations (`C0123ABCD`) and people (a
  Slack user id or an email address), matched exactly. A message they don't settle goes to the judge, when the step
  names one, with the profile (at most 2,000 characters) and only the fields the step looks at.
- **Folders are authority; the rest changes at once.** A workflow's approval binds the folders of the projects it may
  choose, by value. A profile or hints change applies at once. When a project's folders change, a run whose approved
  candidate no longer matches takes `none` with `PROJECT_CHANGED`, and the app offers Review again.
- **Yours alone.** A project's folders name your clients, so listing, showing and changing projects refuse inside the
  event service's MCP server, in an agent's shell and, on macOS, from a process the app did not start. No tool reads
  them.

## A workflow's events, and who receives them

From 0.36.0 each step can raise events, each one ticked in the workflow (off by default), and a **Raise an event** step
raises one wherever you put it. Each is named `<namespace>.<workflow>.<step>.<event>`, such as
`acme.client-asks.issue.created` or `acme.client-asks.run.failed`, and is a CloudEvents 1.0 JSON object whose `data`
holds closed values: the run, the step, its outcome, the issue's identifier, the project's name. Never a folder.

```bash
agent-events workflow-events list --json        # every event each step kind can raise, and what it carries
agent-events workflow-events show <schema> --json
```

- **Subscribers receive them.** A subscriber is given namespaces and patterns (`acme.client-asks.*.*`,
  `*.*.*.failed`; `*` is one segment), and either takes them **live on this Mac** — over SSE or WebSocket, on its own
  loopback listener, with its own token — or by **signed webhook** off it, as a webhook target is signed.

  ```json
  {
    "subscriberId": "events-dashboard",
    "version": 1,
    "kind": "sse",
    "authority": { "host": "127.0.0.1", "port": 4801 },
    "origins": ["http://localhost:3000"],
    "retentionMs": 86400000,
    "events": { "namespaces": ["acme"], "patterns": ["*.*.*.failed", "acme.client-asks.*.*"], "content": "none" }
  }
  ```

  ```bash
  agent-events subscriber add - --json < events-dashboard.json
  agent-events subscriber enable events-dashboard 1 --json   # prepares your approval; nothing is approved here
  agent-events approve <approval-id>                         # at your terminal, or Approve… in the app
  agent-events subscriber token create events-dashboard      # a live subscriber's token, shown once
  agent-events subscriber secret create <id> --version <n>   # a webhook subscriber's signing secret, shown once
  ```
- **Two approvals let an event out.** The workflow's says what is raised and with what; the subscriber's says who
  receives which names, in which namespaces, and whether it gets what senders wrote. For a webhook it names the whole
  URL — scheme, host, port and path, since on a shared host such as `hooks.zapier.com` the path decides who receives —
  or a secret URL by its host and port, "(a URL kept secret)"; the addresses it may connect to; and how many times each
  event is tried. Both are checked again just before each event leaves. `subscriber remove` ends it at once: its streams close and its undelivered events are cancelled.
- **Sender content only by a Raise step's `fields`,** only to a subscriber approved with `content: "enveloped"`, and
  only inside the untrusted-content envelope. Every other subscriber gets the event without them.
- **Delivery never holds a run back.** Each event goes to each matching subscriber at least once, in order. Limits: a
  workflow's `eventsPerHour` (120 by default), 1,000 an hour across all workflows, and 10,000 undelivered per subscriber,
  past which the oldest expire (`SUBSCRIBER_BACKLOG`). A subscriber's deliveries are on the Deliveries screen under it,
  with `delivery retry|drop <event-id>:<subscriber-id>`.
- **A live connection** sends `Authorization: Bearer <token>`, or from a browser the WebSocket subprotocols
  `agentcomms.events.v1, agentcomms.bearer.<token>`; it replays from `Last-Event-ID` (or `agentcomms.after.<event id>`).
  The server only pushes: a client may send ping, pong and close. A rotated or removed token closes the stream (4401),
  and so does the end of the previous token's five-minute overlap, for a stream opened with it. A reader that leaves
  more than 1 MiB unread is closed (on a WebSocket, 1008) and replays what it missed when it reconnects. A listener
  takes at most 64 connections, and cuts a request whose headers take more than 10 seconds.
- **A workflow can start on another's event.** A chained workflow's flow begins with `on raised <pattern>, within 1
  day`: it waits, for that long, for a run about the same message to raise a matching event, then reads the message
  through its own approved mapping. No sender content passes between workflows, a chain stops at depth 3, and a
  workflow can't start on its own events.
- **Shadow versions and tests raise nothing:** they record what they would have raised.

## Describe it

From 0.36.0 the app's designer has **Describe it…**: say in your words what should happen, and a model drafts the
workflow. The draft opens in the designer, with each step marked by the words it came from ("Added by the model, not
from your words" where none: a note counts only when it quotes at least 12 characters and three whole words of your
description, or of an answer you typed, never a choice the model offered), up to 5 questions with choices, and the
checks. A draft that writes any part as `raw` JSON is refused, however it is spaced. Nothing is saved until you save it, and
nothing runs until you approve it.

```bash
echo "When acme writes in C0123, find a session in their project and hand it over" \
  | agent-events workflow describe --provider claude-cli --json
```

- **Who drafts it:** your Claude subscription (`claude` on this Mac, signed in; the default when it is found), run in
  the process of the terminal you started, with no tools and no MCP servers; or OpenRouter or Anthropic, with the key
  you keep for Analyse.
- **What is sent:** your words (at most 4,000 characters) and your answers, a fixed brief with the text's grammar, and
  the names a draft may use — your accounts, lanes, judges, targets, projects' ids and names, the step event words and
  your namespaces. When you ask again, the current draft goes too, with its folders, URLs, address sets and templates
  replaced by placeholders (`/redacted/folder-1`, `https://redacted.invalid/1`, `"template 1"`), and your answers go
  through the same replacement, so a choice that names your folder goes as its placeholder (from 0.37.0). The event
  service puts your values back in what comes back: the draft, and the model's questions and choices. A draft that
  does not read as a workflow goes as you wrote it, for the model to fix. Never a message's content (unless you paste
  one, which goes inside the untrusted envelope), never a profile, a folder, a target's URL, a secret or a key.
- **Yours alone.** `workflow describe` refuses inside the event service's MCP server, in an agent's shell and, on
  macOS, from a process the app did not start; no tool runs it. An agent writes a workflow itself with
  `workflow create`, which you approve as any other.

## What you can do with it

- **Sources:**
  - Gmail, received and sent mail, and labels;
  - Slack messages and thread replies;
  - Resend received mail and sent-mail status;
  - WhatsApp messages from the chats WhatsApp for Mac lists. A hidden chat never reaches a target.
  
  The event catalogue, `agent-events catalogue list`, gives every event type and field.
- **Conditions and mapping:** checks on an event's fields, and a mapping that names exactly the fields a target
  receives. Nothing else leaves. Once you enable a judge, a workflow can also ask a model one yes/no question
  ([Judges](#judges)).
- **Targets:**
  - **Webhooks:** HTTPS, or plain HTTP to the literal loopback address only. Addresses are pinned, and every attempt
    is signed (Standard Webhooks). A delivery that will be tried again can be tried now (`delivery retry`) or
    stopped at once (`delivery drop`, from 0.32.0), and a dead letter's kept payload dropped (`delivery drop`). One
    being sent right now can't be stopped mid-try: the refusal says so (`DELIVERY_IN_FLIGHT`). Stopping is yours, at
    your terminal or in the app, like clearing the queue: over MCP a window may stop only a delivery in the lane it is
    bound to, and `delivery drop` inside the event service's MCP server stops none.
  - **A live stream:** one listener on the loopback address, for tools on this machine. Each subscriber has its own
    token, and its origin is checked.
  - **A queue** you work through ([A queue](#a-queue)), or a lane of it that wakes one agent window
    ([A lane](#a-lane)).
  - **A Linear issue** in your workspace, with your Linear key (0.33.0, [A Linear issue](#a-linear-issue)).
  - **The dry-run log.**
- **Workflows that branch (0.36.0):** steps that choose a project, find or start a session, make a worktree, write to
  Linear, wait and tell you, and raise events that subscribers receive live on this Mac or by signed webhook
  ([A workflow that branches](#a-workflow-that-branches), [A workflow's events](#a-workflows-events-and-who-receives-them)).
- **Workflows and deliveries you can read (0.32.0):**
  - `workflow show <workflow-id>` gives each version with when it was switched on, replaced or revoked, the workflow in
    plain words (its `summary`, as parts; a part of kind `untrusted` is the workflow author's own text), and what it
    did in the last 7 days (`counts7d`; over MCP, a window not bound to a lane the workflow sends to gets the workflow
    without it). The approval preview prints the same words above the JSON you approve, each piece of the workflow
    author's text as one escaped string in double quotes, which nothing it holds can close.
  - `deliveries list` gives each delivery's target kind, its last try's answer, the decision and event it came from,
    when it was delivered where a log keeps that, and when it failed for good. A delivered row has no next try.
  - `agent-events delivery show <delivery-id>` gives one delivery's details: its decision and the judge's answer, the
    event with its source's own ids (a Gmail message id, a Slack channel and ts), and where it went (a webhook by its
    host only). It is yours, at your terminal or in the app: it refuses inside the event service's MCP server.
    Earlier tries are counted, not kept one by one.
- **Control:**
  - `pause` / `resume`;
  - `disable-all`, which stops collection and purges pending work at once, and says so in its result's `said`: your
    workflows are kept; deliveries not yet sent, the Queue's items, the dry-run log and approvals not yet given are
    cleared; each lane's window is unbound; and switching on again needs your approval;
  - `doctor`, a content-free health report.
  
  Every command takes `--json`. The [CLI reference](../../docs/reference/events-daemon-cli.md) lists them all.
- **What it delivered:** from 0.29.0, what each delivery came to (delivered, failed, or dropped before it was
  delivered) is a line in agent-communications' private activity log, under the event service's own session. A line
  names the workflow, the account the events came from, how many events, the target and the outcome. It never holds the
  event, its sender or its subject, nor a webhook's URL. `agentcomms activity sessions` lists the session, and
  `agentcomms activity record off` stops the recording
  ([activity](../../README.md#what-your-agents-did-activity)).

## Agents and approvals

`agent-events mcp` serves the same operations to a coding agent over MCP. Register it through the core's managed
installer — for example, `agentcomms mcp install --server events --client claude-code` — or call
`comms_server_install` with `channel: "events"` from the core MCP server. The same preview-and-approval flow used for
channel servers applies, and the result tells you to restart the client. The
[`agentcomms-events` skill](../../skills/agentcomms-events/SKILL.md) tells an agent how to use it.

- **An agent can:** read the catalogue and your workflows, propose workflows, targets, judges and a judge budget, test a
  workflow against a sample event, test an active judge on the daemon's synthetic event, prepare a judge kind's
  enablement, and turn a judge kind off. In a window you bound to a lane, it can watch that lane, read its items and
  unbind it. From 0.36.0 it can also check a workflow (`events_rule_check`), read the step event catalogue
  (`events_workflow_events_list`, `_show`), and propose a subscriber version and prepare its approval
  (`events_subscriber_enable`).
- **An agent can never:**
  - approve anything. `events_approval_view`, and `approval view` run in a shell that carries an agent's marker or
    inside the event service's MCP server, give an approval's preview without a challenge and issue none (0.34.0), so
    nothing an agent reads there answers an approval or replaces the challenge you are typing at your terminal. A shell
    that drops the marker runs as you and still gets your view, challenge included: the marker is a speed bump, not a
    boundary;
  - bind a lane, or read a lane another window is bound to;
  - read what the dry-run log kept, one delivery's details, or what a queue item says outside its own lane;
  - see, set or rotate a webhook secret or stream token;
  - see, set or rotate a hosted judge's API key;
  - set up a judge (`judge setup`), or set or remove an AI provider's key (`provider key set|remove`);
  - analyse a workflow (`workflow analyse`), or draft one with Describe it (`workflow describe`);
  - approve a subscriber's events, or see its token or signing secret;
  - read or change your projects, or read or cancel a workflow's runs. A workflow's Which project? step names its
    projects by id and name only, when an agent reads it: `events_rule_show`, `events_approval_view`, and `workflow
    show` or `approval view` in an agent's shell give each project `folders: []`, `worktreeRoot: null` and
    `foldersHidden`, how many folders it has (0.36.0). You see the folders in the app and at your terminal. When an
    agent enables a workflow whose projects have changed, the refusal (`PROJECT_CHANGED`) names the step, not which
    project changed or how;
  - try a workflow on a message the event service holds (`workflow test-retained`);
  - resume a target;
  - decide a held event.

  Those are human-only, at your terminal or in the desktop app. Every event's content is marked as untrusted wherever it is shown. So a
  message that tries to instruct an agent reaches it as quoted data, never as an instruction.

## Judges

A workflow can ask a model one yes/no question about an event, after the workflow's own conditions on its fields have
matched. Two kinds of judge are available:
- **`typesafe`:** TypeSafe's hosted **Jev**, from one of two providers. From TypeSafe itself (`jev-1.13.0`), through
  its System One API at `https://api.typesafe.ai/v1/systemone`; or through OpenRouter (`typesafe/jev-1.14`), at
  `https://openrouter.ai/api/v1/systemone`, which passes the request on to TypeSafe's Jev. The fields the workflow names
  leave this machine for that provider, sent with your key for it.
- **`local-endpoint`:** a model server you run on this machine, at a plain-HTTP URL whose host is the literal
  `127.0.0.1` or `::1`; hostnames, HTTPS and any other address are refused. It is sent the same System One request
  as Jev. A server that answers in its own JSON says where its number is, with `"protocol": "json-score"` and a
  `scorePointer`, and that number is labelled an uncalibrated score. Nothing leaves this machine.

The third kind, **`laya`**, will run the Laya model on this machine, in an isolated worker. This release does not offer
it yet: a release offers Laya only once its exact runtime, model and prompt template have passed the owner's labelled
quality gate on real Gmail and Slack messages, and its worker boundary has been proved on a real Mac. Neither has run
yet, so this release ships no reviewed runtime lock. `agent-events judge kinds list` and
`agent-events judge model status` show Laya as unavailable with the reason `E2_EXTERNAL_REFERENCE_BLOCKED`,
and `agent-events judge kind enable laya` refuses before anything is prepared. You can still add a Laya judge, and a
workflow that names it: both are configuration, and a Laya judge answers only once you have enabled Laya and its model
is ready. Until then `workflow enable` refuses that workflow with Laya's reason: in this release that is
`E2_EXTERNAL_REFERENCE_BLOCKED` on every platform; once a release offers Laya, it is `LAYA_PLATFORM_UNAVAILABLE` on
Linux and Windows and to a daemon Rosetta translates on an Apple-silicon Mac, and `LAYA_SANDBOX_UNAVAILABLE` on a Mac
whose sandbox does not apply.
The first release that offers it will offer it on macOS only, with one prompt template, `laya-noul-v1`: English only, a
512-token context, on the CPU, one call at a time, in a worker whose `sandbox-exec` profile lets it open no network
connection (Unix-domain sockets included), start no other process, send no Apple event, look up no system service and
write nowhere but its own temporary folder, so the worker has no way of its own to send what a workflow asks it
anywhere. Each worker proves, before it loads anything, that a connection and a process start are refused. Linux and
Windows show Laya as not available. Once you enable it there,
the daemon downloads the runtime (about 300 MB) and the model (about 1.69 GB) — ordinary network traffic, and the only
network traffic Laya has — and checks every file against the release's lock and manifest before each start.
`judge model status` then reports the runtime and model installation (`idle`, `installing`, `downloading`, `verifying`,
`ready`, `failed` or `unavailable`), its byte progress and any failure or unavailable reason;
`judge kind disable laya` cancels a download and keeps the verified files; `judge model remove` deletes every verified
runtime and model, only while Laya is disabled; and once a newly approved entry's model is ready, the daemon deletes the
files of every entry it replaced.

**A judge's exact document.** `agent-events judge show <judge-id> [--version <n>] --json` (and `events_judge_show` over
MCP) gives one judge version's canonical document, as a workflow embeds it, with its digest and whether it is `live` or
`revoked`: the newest live version unless you name one. It is configuration only — kind, provider, model, endpoint,
prompt template and protocol. A hosted judge's key is kept apart from its document, so it never appears here.

**Every judge kind is off until you turn it on: in the desktop app, or at your terminal.** Installing, updating, a
workflow or a budget never turns one on. Turning a kind off also cancels any pending global enablement that captured a
workflow of that kind. Removing a judge cancels its pending workflow activations, and a workflow that embeds that
revoked judge cannot later become active.

**Setting up Jev, or a model server on this machine, in one step.** In the desktop app, Settings → AI providers keeps
your TypeSafe and OpenRouter keys, and Events → Judges → Set up Jev picks the provider and turns Jev on. The app runs
these commands, which you can run yourself:

```bash
# 1. your provider's key: typed at this terminal, hidden — never piped in, never an argument
agent-events provider key set openrouter      # or typesafe
agent-events provider list                    # whether each provider has a key; never the key

# 2. Jev from that provider, set up and turned on
agent-events judge setup typesafe --provider openrouter

# or a model server on this machine (an Ollama System One server here)
agent-events judge setup local-endpoint --url http://127.0.0.1:11434 --model nimble
```

`judge setup` adds the judge (`jev`, or `local-model`), gives Jev its provider's stored key, approves the daemon-wide
budget when there is none for the judge's provider — 60 calls per rolling hour, 1,000,000 input tokens per rolling 30
days and two calls at a time, overall and for that provider — and turns the kind on. Running the command is your
approval of those enablements: each is recorded with where you approved it (`approvedVia: app` on its approval from
the attested Agent Comms app, `terminal` at a terminal), and the audit log says the same — `approvedBy: desktop-app` from
the app, `terminal` at a terminal. Running it again changes nothing, or makes the next judge version when the
provider, the URL or the model changed; a workflow keeps using the judge version it names until you update it. A local
model server's URL must be `http://127.0.0.1:<port>` or `http://[::1]:<port>`. `provider key set` again replaces a key,
and every Jev judge of that provider gets the new one at once; `provider key remove` removes it, and theirs, so they
refuse their calls until you add one. `judge kind disable <kind>` turns a kind off. Each of these commands runs only
where you are: at an interactive terminal, where a key is your hidden input, or in the Agent Comms app, which sends the
key on stdin. On macOS the command first checks that the app started this process: a speed bump against agents, not a
boundary against code running as you (core's `desktopAppOrigin`, which has codesign verify the running parent by its
pid). The local test build counts only for its own marked test profile: the command's state folder must be in that
profile with its config folder (`outside-test-profile` otherwise, naming the folder), and the event service takes it
only when its own state folder holds the profile's mark and is not your real, default one (`NOT_A_TEST_PROFILE`
otherwise; from 0.34.0, `scripts/local-test-release.sh` marks both folders). Windows and Linux check nothing, so there
these changes go through a terminal: a command that is neither at an interactive terminal nor attested as the app's is
refused with
`APPROVAL_REQUIRED` (exit 10, reason `ORIGIN_UNATTESTED`), naming the words to type at your terminal, and its audit line
says `desktop-app (unattested)`; the app offers Do it in Terminal instead. The same holds for
`integration set agent-sessions`, `workflow approve` and `collection approve`. `workflow analyse` changes nothing and
still runs from the app there.
The result and the audit line say where you were — `desktop-app`, `desktop-app (test build)` or `terminal` — as the
CLI tells the event service; that label rides on a same-user control token, so it too is a speed bump. Each
refuses an agent's shell and the event service's MCP server, and no MCP tool performs them; `events_provider_list`
says only whether each provider has a key.

Or step by step, at your terminal, to ask Jev about received mail:

```bash
# 1. turn the kind on: you approve its exact enablement at this terminal
agent-events judge kind enable typesafe
agent-events approve <approval-id>

# 2. the daemon-wide judge budget: no judge is called without one
agent-events budget update "$(cat budget.json)"
agent-events approve <approval-id>

# 3. the judge, then its TypeSafe API key, which you enter at this terminal
agent-events judge add "$(cat judge.json)"
agent-events judge key set jev --version 1

# 4. a workflow that asks it; its approval shows the question, the fields the judge sees and where they go
agent-events workflow create "$(cat workflow.json)"
agent-events workflow enable mail-asks 1
agent-events approve <approval-id>

# 5. try the judge on the daemon's own synthetic event, never one of yours
agent-events judge test jev --version 1
```

`judge.json`:

```json
{
  "judgeId": "jev",
  "version": 1,
  "kind": "typesafe",
  "provider": "typesafe",
  "model": "jev-1.13.0",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "promptTemplate": "typesafe-jev-noul-v1",
  "protocol": "noul"
}
```

Through OpenRouter, the same judge names `"provider": "openrouter"`, `"model": "typesafe/jev-1.14"` and
`"endpoint": "https://openrouter.ai/api/v1/systemone"`; the provider fixes both, and the budget needs an `openrouter`
provider entry. A workflow's approval says where its judge sends the fields: to TypeSafe, or to OpenRouter, which passes
them to TypeSafe's Jev.

`budget.json`, the ceilings for every judge call, overall and per provider:

```json
{
  "budgetId": "judge-budget",
  "version": 1,
  "global": { "callsPerRollingHour": 60, "inputTokensPerRolling30Days": 1000000, "concurrency": 2 },
  "providers": [
    { "provider": "typesafe", "callsPerRollingHour": 60, "inputTokensPerRolling30Days": 1000000, "concurrency": 2 }
  ]
}
```

`workflow.json` is the first workflow with `"ruleId": "mail-asks"` and an `agentic` part beside its `condition`. Its
`judge` is the judge document exactly as you added it:

```json
"agentic": {
  "judge": {
    "judgeId": "jev",
    "version": 1,
    "kind": "typesafe",
    "provider": "typesafe",
    "model": "jev-1.13.0",
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "promptTemplate": "typesafe-jev-noul-v1",
    "protocol": "noul"
  },
  "question": "Does this message ask me to do something today?",
  "inputs": ["/subject"],
  "threshold": 0.8,
  "onUncertain": "hold",
  "callsPerRollingHour": 20,
  "inputTokensPerRolling30Days": 100000,
  "concurrency": 1,
  "maxInputTokens": 512,
  "maxOutputTokens": 64
}
```

A local judge has `"kind": "local-endpoint"`, your server's `provider`, `model` and `endpoint`, and that endpoint's
address in `"approvedAddressSet": ["127.0.0.1"]`. It needs no key.

A Laya judge names the Laya provider, this release's reviewed model as `model` (the `manifestId` that
`judge model status` shows) and the yes/no template `laya-noul-v1`. It needs no key and no endpoint:

```json
{
  "judgeId": "laya",
  "version": 1,
  "kind": "laya",
  "provider": "laya",
  "model": "laya-en-onnx-68f27dfe",
  "promptTemplate": "laya-noul-v1"
}
```

It runs on this Mac, in English only, with a 512-token context, on the CPU and one call at a time, and the approval
view of a workflow that names it says so. Another model is refused (`LAYA_MANIFEST_NOT_REVIEWED`), and so is the
two-option template `laya-choice2-v1` (`LAYA_TEMPLATE_BLOCKED`) until where its answer comes from has been reviewed. A
budget's `laya` provider entry allows at most one call at a time.

**What a judge sees, and what it decides:**
- Only the fields in `inputs`, sanitised and marked as untrusted inside a fixed prompt. The workflow's `condition` must
  check a content field too (`/subject` above), so a judge is never asked about every event.
- It has no tools, secrets or authority. Its answer is one number from 0 to 1, and the workflow matches when that number
  reaches `threshold`. A message written to talk the judge into a match can move only that number; it cannot change
  the workflow, its fields or its targets.
- An answer up to 0.1 below the threshold is uncertain. It is no match or, with `"onUncertain": "hold"`, a held
  decision that waits for you: `agent-events held list` shows them, and `agent-events held decide <decision-id> accept`
  (or `reject`) settles one, at your terminal.
- A timeout, a malformed answer or a spent budget is no match. Retrying a delivery never asks the judge again.

**Budgets.** Each workflow sets its own ceilings: calls per rolling hour, input tokens per rolling 30 days, concurrent
calls, and the most input and output tokens per call. The daemon-wide budget caps every workflow, overall and per
provider, and a workflow cannot raise it. A workflow's new version inherits the charges of the versions before it, so a
new version never resets a budget. `judge test` runs at most ten times an hour per judge version, charged to the overall
budget. A call is charged once it reaches the network: one refused, out of time or cut short before its first
connection costs nothing, and a retry is a call of its own.

**Turning a kind off.** `agent-events judge kind disable typesafe` takes effect at once: decisions waiting on its
judges, and the deliveries, dry-run records and stream entries bound to them, are cancelled and purged. Workflows
that name its judges stay, but cannot call them; turning the kind back on needs a new approval. `disable-all` stops
judges along with everything else.

`doctor` shows each kind's state, the active budget version and its reservations, how many decisions are held and
when the next one expires, any hosted judge whose key is missing, and Laya's runtime, model and sandbox-boundary state
with its reason, all without content.

## For desktop and tool builders

The data-only control contract is
[`b3-control-v1.schema.json`](src/operations/contracts/b3-control-v1.schema.json). Its content-free
request, result and error vectors are in [`test/fixtures/b3-control-contract-v1`](test/fixtures/b3-control-contract-v1),
and the terminal approval-preview vectors are in [`test/fixtures/b3-approval-preview-v1`](test/fixtures/b3-approval-preview-v1).
It covers every B3 capability a desktop app may call, and never contains a secret value. Its frozen doctor result is
the closed [`doctor-v1.schema.json`](src/operations/contracts/doctor-v1.schema.json), and Phase E's
[`doctor-v2.schema.json`](src/operations/contracts/doctor-v2.schema.json) stays as it was. The released daemon reports
[`doctor-v3.schema.json`](src/operations/contracts/doctor-v3.schema.json), which keeps every v2 property, has no judge
kind left behind a phase boundary, and adds Laya's content-free `judge.laya` entry.

[`b3-control-v2.schema.json`](src/operations/contracts/b3-control-v2.schema.json) is v1 with the real Laya answers: it
replaces exactly the six results that carried v1's typed `E2_REQUIRED` placeholder (`judgeKindsList`,
`enableJudgeKind`, `disableJudgeKind`, `judgeModelStatus`, `removeJudgeModel` and `doctor`); its vectors are in
[`test/fixtures/b3-control-contract-v2`](test/fixtures/b3-control-contract-v2). `judge model status` and
`judge model remove` answer the stable
[`laya-model-status-v1.schema.json`](src/operations/contracts/laya-model-status-v1.schema.json): eight closed fields —
the state, the reviewed manifest id and runtime-lock digest, `bytesVerified` of `totalBytes`, a failure code, an
unavailable reason and the last update time — and never a path, input, request, response, key or token.

[`b3-control-v3.schema.json`](src/operations/contracts/b3-control-v3.schema.json) is v2 with a Laya judge variant: a
Laya judge document is exactly `judgeId`, `version`, `kind` and `provider` `laya`, the reviewed manifest id as `model`
and `promptTemplate` `laya-noul-v1`, and v3 accepts one in `judge add` and `judge update` and in the workflow documents
of `workflow create`, `workflow update` and `workflow test`. It replaces the results of `judgesList`, `addJudge`,
`updateJudge`, `rule-create` and `rule-update`, and the approval view of a workflow that names a Laya judge adds
`layaJudge`: its template, manifest id and D11's limits, and no input text. A refusal is `BAD_DATA` with one of five
closed reasons in `details.reason`, named in its message too. Its vectors are in
[`test/fixtures/b3-control-contract-v3`](test/fixtures/b3-control-contract-v3). An owner without E2's artifact manager
still answers v1.

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
