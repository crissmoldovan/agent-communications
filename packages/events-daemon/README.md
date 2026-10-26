# @agentcomms/events-daemon

`agent-events` watches the Gmail, Slack, Resend and WhatsApp accounts you have already connected with
agent-communications. When an event matches a rule you approved, it delivers that event to the rule's targets:
- a signed HTTPS webhook;
- a local live stream (server-sent events) for your own tools;
- a queue you work through in the desktop app or at your terminal, or a lane of it that wakes one agent window;
- a dry-run log you read at your terminal or in the desktop app, which keeps each entry 24 hours at most.

Nothing is collected and nothing leaves this machine until you approve the rule yourself, at your terminal.

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
`--version <number>` continues to select an immutable rule, target, subscriber or judge version.

## A first rule: Gmail into the dry-run log

The dry-run target keeps what matched in an encrypted local log that only you can read, at your terminal or in the
desktop app. It keeps each entry 24 hours at most, and then deletes it. It is the safe way to see what a rule would send
before you point it at a webhook.

```bash
# 1. a target: the local dry-run log, keeping records for a day
agent-events target add '{"targetId":"log","version":1,"kind":"dry-run","retentionMs":86400000}'

# 2. a rule: every received Gmail message with a subject, mapped to its subject only
agent-events sources list          # every connected account a rule can name: its source, id and name
agent-events rule create "$(cat rule.json)"

# 3. turn it on: each step prints an approval, which you approve by typing its challenge
agent-events enable-all            # the standing approval that starts collection
agent-events approve <approval-id>
agent-events rule enable mail-subjects 1
agent-events approve <approval-id> # offers to test the target first; answering no is fine

# 4. read what matched: the list gives each record's id, and show prints that record
agent-events dryrun list
agent-events dryrun show <record-id>
agent-events delivery show <record-id>   # the delivery itself: its decision, the message it came from, its target
```

`dryrun list` and `dryrun show` take `--json` too, which is how the desktop app reads the log: `show` then gives the
record as data (the exact event it would have sent), with each field its sender wrote, the ones `agentcommsuntrusted`
names, inside the untrusted-content envelope, as `queue show --json` gives a sender's fields.
Inside the event service's MCP server both refuse, so no agent reads the log through MCP.

Switch collection on before approving the rule: a pending target can be tested only while collection is on. If a test
cannot run, the approval says why and still asks for its challenge.

An approval that `rule enable` or `enable-all` prints lasts 30 minutes. If it runs out, or is revoked, before you
approve it, nothing is turned on. On its next tick, or when it next starts, the service cancels the activation that
was waiting for it, and `status` stops counting it as pending. Run `rule enable` again for a new approval. An update
that lapsed this way no longer blocks the rule's next version.

`rule.json`:

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

Rules, targets and subscribers are immutable versions. To change one, create its next version and enable it. The
approval preview then shows exactly what changes.

## A queue

From 0.30.0 a rule can put each match in a list you work through: a `queue` target. Each item says what arrived (the
channel, the account, from whom, the subject or first words, when), which rule matched and, when the rule asked a
judge, what it answered. You mark it **done** or **dismiss** it, and open the message in Gmail or Slack when the item
has a link. The desktop app shows the queue in its own screen; at a terminal:

```bash
agent-events target add '{"targetId":"inbox-queue","version":1,"kind":"queue","retentionMs":604800000,"show":"summary"}'
agent-events queue list              # open items, newest first, with what they say: add --json for the app's shape
agent-events queue show <item-id>
agent-events queue done <item-id>    # or: dismiss, reopen
agent-events queue clear             # remove done and dismissed items now (yours alone: no MCP tool clears)
```

- **What a rule needs:** a queue target, `retention.queueMs` (1 to 30 days; a queue target's own retention is 1 to 30
  days, 7 by default, and the lesser of the two applies), and a mapping that includes what an item shows. For Gmail,
  that is the sender and the subject; for Slack, the poster's name and the text; for Resend, the sender and the
  subject or body; for WhatsApp, the sender and the text. A rule without them is refused, and the refusal names
  what is missing. Nothing is fetched to fill an item: its first words come only from a field the rule maps, and its
  link only from ids the rule maps.
- **How long it keeps:** an item's content goes at its retention, whatever you did with it; its content-free row
  (rule, state, times) stays one retention more, for the counts. Every revocation that removes a rule's dry-run
  records removes its queue items too: disabling or tightening the rule, removing its target or judge, turning its
  judge's kind off, `disable-all`, removing the account, or a WhatsApp chat your lists now hide. A tighter version's
  `rule update` result says how many open items enabling it will remove.
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
# 1. a lane is a queue target with a name; a rule sends to it, and you approve the rule as any other
agent-events target add '{"targetId":"lane-david","version":1,"kind":"queue","retentionMs":604800000,"show":"summary","lane":{"name":"david"}}'

# 2. the agent in the window you want tells you its id (events_lane_whoami); you bind it, at your terminal
agent-events lane bind david --window 25f971a3-0c69-44e3-971c-3a4656afa986

agent-events lane list               # every lane, its rules, channels, open items and the window bound to it
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
  pointer the event service writes — "1 new item in lane david (Slack, rule david-on-slack): read it with
  events_lane_item, item qi_…" — never a sender, subject or text. The window reads the item with
  `events_lane_item({ item })`, every field its sender wrote inside an untrusted-content envelope, then watches again.
  A client without the tasks extension waits with `events_wait({ lane, seconds })`, up to 50 seconds at a time.
- **Only what arrives after you bind.** A window wakes for, reads and sees in `events_queue_items` only items that
  arrived after its binding. Binding again starts again.
- **Every other window sees no lane item** over MCP, in any queue tool, and is not told one exists. You, at the
  terminal and in the app, see everything.
- **A binding ends** when you unbind it (or the window unbinds its own), when no active rule sends to the lane any
  more, and with `disable-all`. It follows the lane across a new version of its target that you approve. Making a
  queue a lane, or renaming one, is a new target version, approved through a new rule activation, and the approval
  says "Items in lane david can be read by the agent window you bind to it." Two different targets of active rules
  cannot share a lane's name.
- **The protocol.** `agent-events mcp` now serves both MCP eras: a client that offers 2026-07-28 negotiates it, and a
  2025-era client connects as before.

## What happened to a message

From 0.32.0 the event service tells you what became of each message it observed: whether each rule matched it and what
its judge answered, where each delivery went, the queue item it became, and what happened to that item since — which
agent window was woken for it and read it, and who marked it done, dismissed it or reopened it. The desktop app reads
it for its Messages screen; at a terminal:

```bash
agent-events messages list --json                    # the last 30 days, newest first, 100 at a time
agent-events messages list --before <next> --json    # the page after: pass back the next the last page gave
agent-events message show <event-id> --json          # one message, with every line of its queue item's history
```

- **What each message holds:**
  - its event id, type, channel, account, and when it happened and was observed;
  - its source's own ids: a Gmail message id, a Slack channel and ts, a WhatsApp chat and message id, a Resend email
    id. These are the ids its link and agent-communications' activity log use;
  - each rule's decision, with the judge's answer while the decision's record is kept;
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

## What you can do with it

- **Sources:**
  - Gmail, received and sent mail, and labels;
  - Slack messages and thread replies;
  - Resend received mail and sent-mail status;
  - WhatsApp messages from the chats WhatsApp for Mac lists. A hidden chat never reaches a target.
  
  The event catalogue, `agent-events catalogue list`, gives every event type and field.
- **Conditions and mapping:** checks on an event's fields, and a mapping that names exactly the fields a target
  receives. Nothing else leaves. Once you enable a judge, a rule can also ask a model one yes/no question
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
  - **The dry-run log.**
- **Rules and deliveries you can read (0.32.0):**
  - `rule show <rule-id>` gives each version with when it was switched on, replaced or revoked, the rule in plain words
    (its `summary`, as parts; a part of kind `untrusted` is the rule author's own text), and what it did in the last 7
    days (`counts7d`). The approval preview prints the same words above the JSON you approve, each piece of the rule
    author's text as one escaped string in double quotes, which nothing it holds can close.
  - `deliveries list` gives each delivery's target kind, its last try's answer, the decision and event it came from,
    when it was delivered where a log keeps that, and when it failed for good. A delivered row has no next try.
  - `agent-events delivery show <delivery-id>` gives one delivery's details: its decision and the judge's answer, the
    event with its source's own ids (a Gmail message id, a Slack channel and ts), and where it went (a webhook by its
    host only). It is yours, at your terminal or in the app: it refuses inside the event service's MCP server.
    Earlier tries are counted, not kept one by one.
- **Control:**
  - `pause` / `resume`;
  - `disable-all`, which stops collection and purges pending work at once;
  - `doctor`, a content-free health report.
  
  Every command takes `--json`. The [CLI reference](../../docs/reference/events-daemon-cli.md) lists them all.
- **What it delivered:** from 0.29.0, what each delivery came to (delivered, failed, or dropped before it was
  delivered) is a line in agent-communications' private activity log, under the event service's own session. A line
  names the rule, the account the events came from, how many events, the target and the outcome. It never holds the
  event, its sender or its subject, nor a webhook's URL. `agentcomms activity sessions` lists the session, and
  `agentcomms activity record off` stops the recording
  ([activity](../../README.md#what-your-agents-did-activity)).

## Agents and approvals

`agent-events mcp` serves the same operations to a coding agent over MCP. Register it through the core's managed
installer — for example, `agentcomms mcp install --server events --client claude-code` — or call
`comms_server_install` with `channel: "events"` from the core MCP server. The same preview-and-approval flow used for
channel servers applies, and the result tells you to restart the client. The
[`agentcomms-events` skill](../../skills/agentcomms-events/SKILL.md) tells an agent how to use it.

- **An agent can:** read the catalogue and your rules, propose rules, targets, judges and a judge budget, test a rule
  against a sample event, test an active judge on the daemon's synthetic event, prepare a judge kind's enablement,
  and turn a judge kind off. In a window you bound to a lane, it can watch that lane, read its items and unbind it.
- **An agent can never:**
  - approve anything;
  - bind a lane, or read a lane another window is bound to;
  - read what the dry-run log kept, one delivery's details, or what a queue item says outside its own lane;
  - see, set or rotate a webhook secret or stream token;
  - see, set or rotate a hosted judge's API key;
  - set up a judge (`judge setup`), or set or remove an AI provider's key (`provider key set|remove`);
  - resume a target;
  - decide a held event.

  Those are human-only, at your terminal or in the desktop app. Every event's content is marked as untrusted wherever it is shown. So a
  message that tries to instruct an agent reaches it as quoted data, never as an instruction.

## Judges

A rule can ask a model one yes/no question about an event, after the rule's own conditions on its fields have matched.
Two kinds of judge are available:
- **`typesafe`:** TypeSafe's hosted **Jev**, from one of two providers. From TypeSafe itself (`jev-1.13.0`), through
  its System One API at `https://api.typesafe.ai/v1/systemone`; or through OpenRouter (`typesafe/jev-1.14`), at
  `https://openrouter.ai/api/v1/systemone`, which passes the request on to TypeSafe's Jev. The fields the rule names
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
rule that names it: both are configuration, and a Laya judge answers only once you have enabled Laya and its model is
ready. Until then `rule enable` refuses that rule with Laya's reason: in this release that is
`E2_EXTERNAL_REFERENCE_BLOCKED` on every platform; once a release offers Laya, it is `LAYA_PLATFORM_UNAVAILABLE` on
Linux and Windows and to a daemon Rosetta translates on an Apple-silicon Mac, and `LAYA_SANDBOX_UNAVAILABLE` on a Mac
whose sandbox does not apply.
The first release that offers it will offer it on macOS only, with one prompt template, `laya-noul-v1`: English only, a
512-token context, on the CPU, one call at a time, in a worker whose `sandbox-exec` profile lets it open no network
connection (Unix-domain sockets included), start no other process, send no Apple event, look up no system service and
write nowhere but its own temporary folder, so the worker has no way of its own to send what a rule asks it anywhere.
Each worker proves, before it loads anything, that a connection and a process start are refused. Linux and Windows
show Laya as not available. Once you enable it there,
the daemon downloads the runtime (about 300 MB) and the model (about 1.69 GB) — ordinary network traffic, and the only
network traffic Laya has — and checks every file against the release's lock and manifest before each start.
`judge model status` then reports the runtime and model installation (`idle`, `installing`, `downloading`, `verifying`,
`ready`, `failed` or `unavailable`), its byte progress and any failure or unavailable reason;
`judge kind disable laya` cancels a download and keeps the verified files; `judge model remove` deletes every verified
runtime and model, only while Laya is disabled; and once a newly approved entry's model is ready, the daemon deletes the
files of every entry it replaced.

**Every judge kind is off until you turn it on: in the desktop app, or at your terminal.** Installing, updating, a rule
or a budget never turns one on. Turning a kind off also cancels any pending global enablement that captured a rule of
that kind. Removing a judge cancels its pending rule activations, and a rule that embeds that revoked judge cannot later
become active.

**Setting up Jev, or a model server on this machine, in one step.** In the desktop app, Settings → AI providers keeps
your TypeSafe and OpenRouter keys, and Events → Judges → Set up Jev picks the provider and turns Jev on. The app runs
these commands, which you can run yourself:

```bash
# 1. your provider's key: typed at this terminal, hidden, or piped in on stdin — never an argument
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
approval of those enablements: each is recorded as approved through the app (`approvedVia: app` on its approval, and
`approvedBy: desktop-app` in the audit log). Running it again changes nothing, or makes the next judge version when the
provider, the URL or the model changed; a rule keeps using the judge version it names until you update it. A local
model server's URL must be `http://127.0.0.1:<port>` or `http://[::1]:<port>`. `provider key set` again replaces a key,
and every Jev judge of that provider gets the new one at once; `provider key remove` removes it, and theirs, so they
refuse their calls until you add one. `judge kind disable <kind>` turns a kind off. Each of these commands refuses an
agent's shell and the event service's MCP server, and no MCP tool performs them; `events_provider_list` says only
whether each provider has a key.

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

# 4. a rule that asks it; its approval shows the question, the fields the judge sees and where they go
agent-events rule create "$(cat rule.json)"
agent-events rule enable mail-asks 1
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
provider entry. A rule's approval says where its judge sends the fields: to TypeSafe, or to OpenRouter, which passes
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

`rule.json` is the first rule with `"ruleId": "mail-asks"` and an `agentic` part beside its `condition`. Its `judge`
is the judge document exactly as you added it:

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
view of a rule that names it says so. Another model is refused (`LAYA_MANIFEST_NOT_REVIEWED`), and so is the two-option
template `laya-choice2-v1` (`LAYA_TEMPLATE_BLOCKED`) until where its answer comes from has been reviewed. A budget's
`laya` provider entry allows at most one call at a time.

**What a judge sees, and what it decides:**
- Only the fields in `inputs`, sanitised and marked as untrusted inside a fixed prompt. The rule's `condition` must
  check a content field too (`/subject` above), so a judge is never asked about every event.
- It has no tools, secrets or authority. Its answer is one number from 0 to 1, and the rule matches when that number
  reaches `threshold`. A message written to talk the judge into a match can move only that number; it cannot change
  the rule, its fields or its targets.
- An answer up to 0.1 below the threshold is uncertain. It is no match or, with `"onUncertain": "hold"`, a held
  decision that waits for you: `agent-events held list` shows them, and `agent-events held decide <decision-id> accept`
  (or `reject`) settles one, at your terminal.
- A timeout, a malformed answer or a spent budget is no match. Retrying a delivery never asks the judge again.

**Budgets.** Each rule sets its own ceilings: calls per rolling hour, input tokens per rolling 30 days, concurrent
calls, and the most input and output tokens per call. The daemon-wide budget caps every rule, overall and per
provider, and a rule cannot raise it. A rule's new version inherits the charges of the versions before it, so a new
version never resets a budget. `judge test` runs at most ten times an hour per judge version, charged to the overall
budget. A call is charged once it reaches the network: one refused, out of time or cut short before its first
connection costs nothing, and a retry is a call of its own.

**Turning a kind off.** `agent-events judge kind disable typesafe` takes effect at once: decisions waiting on its
judges, and the deliveries, dry-run records and stream entries bound to them, are cancelled and purged. Rules that
name its judges stay, but cannot call them; turning the kind back on needs a new approval. `disable-all` stops judges
along with everything else.

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
and `promptTemplate` `laya-noul-v1`, and v3 accepts one in `judge add` and `judge update` and in the rule documents of
`rule create`, `rule update` and `rule test`. It replaces the results of `judgesList`, `addJudge`, `updateJudge`,
`rule-create` and `rule-update`, and the approval view of a rule that names a Laya judge adds `layaJudge`: its template,
manifest id and D11's limits, and no input text. A refusal is `BAD_DATA` with one of five closed reasons in
`details.reason`, named in its message too. Its vectors are in
[`test/fixtures/b3-control-contract-v3`](test/fixtures/b3-control-contract-v3). An owner without E2's artifact manager
still answers v1.

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
