# @agentcomms/events-daemon

`agent-events` watches the Gmail, Slack, Resend and WhatsApp accounts you have already connected with
agent-communications. When an event matches a rule you approved, it delivers that event to the rule's targets:
- a signed HTTPS webhook;
- a local live stream (server-sent events) for your own tools;
- a dry-run log you read at your terminal.

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
cleanly on `agent-events stop` or when the terminal closes. There is no background service or autostart in this
release; the desktop app will supervise it later. Its state lives in an owner-only directory. A state directory so
deep that its control socket's path would pass the system limit (103 bytes on macOS, 107 on Linux) is refused, with
a hint to pin a shorter one.

## A first rule: Gmail into the dry-run log

The dry-run target keeps what matched in an encrypted local log that only a person at a terminal can read. It is the
safe way to see what a rule would send before you point it at a webhook.

```bash
# 1. a target: the local dry-run log, keeping records for a day
agent-events target add '{"targetId":"log","version":1,"kind":"dry-run","retentionMs":86400000}'

# 2. a rule: every received Gmail message with a subject, mapped to its subject only
agent-events sources list          # the Gmail account ids you can name in a rule
agent-events rule create "$(cat rule.json)"

# 3. turn it on: each step prints an approval, which you approve by typing its challenge
agent-events rule enable mail-subjects 1
agent-events approve <approval-id>
agent-events enable-all            # the standing approval that starts collection
agent-events approve <approval-id>

# 4. read what matched
agent-events dryrun list
```

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
    is signed (Standard Webhooks). Each delivery can be retried or dropped (`delivery retry`, `delivery drop`).
  - **A live stream:** one listener on the loopback address, for tools on this machine. Each subscriber has its own
    token, and its origin is checked.
  - **The dry-run log.**
- **Control:**
  - `pause` / `resume`;
  - `disable-all`, which stops collection and purges pending work at once;
  - `doctor`, a content-free health report.
  
  Every command takes `--json`. The [CLI reference](../../docs/reference/events-daemon-cli.md) lists them all.

## Agents and approvals

`agent-events mcp` serves the same operations to a coding agent over MCP. Register it through the core's managed
installer — for example, `agentcomms mcp install --server events --client claude-code` — or call
`comms_server_install` with `channel: "events"` from the core MCP server. The same preview-and-approval flow used for
channel servers applies, and the result tells you to restart the client. The
[`agentcomms-events` skill](../../skills/agentcomms-events/SKILL.md) tells an agent how to use it.

- **An agent can:** read the catalogue and your rules, propose rules, targets, judges and a judge budget, test a rule
  against a sample event, test an active judge on the daemon's synthetic event, prepare a judge kind's enablement,
  and turn a judge kind off.
- **An agent can never:**
  - approve anything;
  - read what the dry-run log kept;
  - see, set or rotate a webhook secret or stream token;
  - see, set or rotate a hosted judge's API key;
  - resume a target;
  - decide a held event.

  Those are human-only, at your terminal. Every event's content is marked as untrusted wherever it is shown. So a
  message that tries to instruct an agent reaches it as quoted data, never as an instruction.

## Judges

A rule can ask a model one yes/no question about an event, after the rule's own conditions on its fields have matched.
Two kinds of judge are available:
- **`typesafe`:** TypeSafe's hosted **Jev** (`jev-1.13.0`), through its System One API at
  `https://api.typesafe.ai/v1/systemone`. The fields the rule names leave this machine for TypeSafe, sent with your
  TypeSafe API key.
- **`local-endpoint`:** a model server you run on this machine, at a plain-HTTP URL whose host is the literal
  `127.0.0.1` or `::1`; hostnames, HTTPS and any other address are refused. It is sent the same System One request
  as Jev. A server that answers in its own JSON says where its number is, with `"protocol": "json-score"` and a
  `scorePointer`, and that number is labelled an uncalibrated score. Nothing leaves this machine.

The third kind, **`laya`**, runs the Laya model inside the daemon. It is not available yet: `agent-events judge kinds
list` shows it as unavailable, and a judge naming it is refused.

**Every judge kind is off until you enable it, at your terminal.** Installing, updating, a rule or a budget never
turns one on. To ask Jev about received mail:

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
budget.

**Turning a kind off.** `agent-events judge kind disable typesafe` takes effect at once: decisions waiting on its
judges, and the deliveries, dry-run records and stream entries bound to them, are cancelled and purged. Rules that
name its judges stay, but cannot call them; turning the kind back on needs a new approval. `disable-all` stops judges
along with everything else.

`doctor` shows each kind's state, the active budget version and its reservations, how many decisions are held and
when the next one expires, any hosted judge whose key is missing, and Laya as not available yet, all without content.

## For desktop and tool builders

The data-only control contract is
[`b3-control-v1.schema.json`](src/operations/contracts/b3-control-v1.schema.json). Its content-free
request, result and error vectors are in [`test/fixtures/b3-control-contract-v1`](test/fixtures/b3-control-contract-v1),
and the terminal approval-preview vectors are in [`test/fixtures/b3-approval-preview-v1`](test/fixtures/b3-approval-preview-v1).
It covers every B3 capability a desktop app may call, and never contains a secret value. Its frozen doctor result is
the closed [`doctor-v1.schema.json`](src/operations/contracts/doctor-v1.schema.json); the released daemon reports the
additive Phase-E [`doctor-v2.schema.json`](src/operations/contracts/doctor-v2.schema.json).

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
