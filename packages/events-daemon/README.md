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
  receives. Nothing else leaves.
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

`agent-events mcp` serves the same operations to a coding agent over MCP. Register it with your client as you would
any MCP server, with `npx -y @agentcomms/events-daemon mcp` as the command. The
[`agentcomms-events` skill](../../skills/agentcomms-events/SKILL.md) tells an agent how to use it.

- **An agent can:** read the catalogue and your rules, propose rules and targets, and test a rule against a sample
  event.
- **An agent can never:**
  - approve anything;
  - read what the dry-run log kept;
  - see, set or rotate a webhook secret or stream token;
  - resume a target;
  - decide a held event.

  Those are human-only, at your terminal. Every event's content is marked as untrusted wherever it is shown. So a
  message that tries to instruct an agent reaches it as quoted data, never as an instruction.

## Judges

A rule can later ask a model a yes/no question about an event: hosted Jev, or a model you run on this machine. That
comes in a later release. In this one, the `judge`, `judges` and `budget` commands answer that judges are not
available yet, and no event is ever sent to a model.

## For desktop and tool builders

The data-only control contract is
[`b3-control-v1.schema.json`](src/operations/contracts/b3-control-v1.schema.json). Its content-free
request, result and error vectors are in [`test/fixtures/b3-control-contract-v1`](test/fixtures/b3-control-contract-v1),
and the terminal approval-preview vectors are in [`test/fixtures/b3-approval-preview-v1`](test/fixtures/b3-approval-preview-v1).
It covers every capability a desktop app may call, and never contains a secret value. Its doctor result is the closed
[`doctor-v1.schema.json`](src/operations/contracts/doctor-v1.schema.json).

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
