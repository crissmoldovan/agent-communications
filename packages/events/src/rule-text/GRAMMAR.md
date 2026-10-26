# The rule text

A rule document written as a short text a person reads and edits (0.33.0 design §3.2). `printRuleText(doc)` writes it,
and `parseRuleText(text)` reads it back to exactly the same document. The canonical JSON stays what is approved: the
text is a view of it.

```
rule invoices, version 4

when a new message arrives in cue/gmail, in the inbox
match any
  subject contains "invoice"
  subject contains "payment"

ask jev, version 2, via typesafe
  question "Is this asking me to pay or send something?"
  looking at from.address, subject, snippet
  yes at 0.7, if unsure drop
  at most 60 calls an hour, 1000000 input tokens in 30 days, 1 at a time
  each call up to 2000 tokens in and 16 tokens out
  judge typesafe, model jev-1.13.0
    endpoint https://api.typesafe.ai/v1/systemone
    prompt template typesafe-jev-noul-v1
    protocol noul

then
  queue billing, version 1, in lane billing, keep 7 days

  dry run invoices-log, version 1, keep 1 day

keep from.address, from.name, snippet, subject
at most 60 an hour
```

## What it promises

- **Round trip:** `parseRuleText(printRuleText(doc))` deep-equals `doc`, for any JSON object.
- **Stable:** the same document always prints the same text, whatever order its keys are in.
- **Nothing dropped:** a field or shape the readable form has no words for is written as `raw` JSON in its place (see
  [The escape form](#the-escape-form)). A canonical rule never needs it.
- **Grammar only:** the parser checks the text, not the rule. Whether the accounts, lanes, judges and targets exist,
  and whether the event service accepts the rule, is for the event service to say when the document is submitted.
- **No I/O and no knowledge of accounts:** an account is written as the alias or id the document holds.

## Lines and words

- **Lines.** A section starts at the left margin. Its lines are indented under it by **two spaces** per level; tabs,
  odd indents and a jump of two levels are refused. Blank lines and trailing spaces are ignored, and any line ending
  works.
- **Words** are made of letters, digits and `_ . / @ : + ~ -`. Keywords are case-sensitive.
- **Names** — accounts, ids, lanes, labels, hosts, URLs — are bare words, or quoted text when they have other
  characters. A name is also quoted when it is `and`, `version`, `port`, `URL` or `secret`, the words a name can end at.
- **Quoted text** is a JSON string, with JSON's escapes, so any text round-trips: `"say \"hi\"\nthanks"`.
- **Values** in conditions are JSON scalars: quoted text, a number, `true`, `false` or `null`.
- **Fields** are dotted names, `from.address` for `/from/address`, when every token is letters, digits and `_`.
  Otherwise, or when the name is `not`, `raw`, `any`, `all`, `nothing` or `for`, a field is its JSON Pointer, bare
  (`/a-b/c`) or quoted (`"/with space"`, `""` for the whole event).
- **Durations** are a whole number and a unit: `7 days`, `1 hour`, `30 minutes`, `5 seconds`, `500 milliseconds`.
  The printer uses the largest unit that divides exactly.
- **Lists** of names are joined by `and`: `cue/gmail and rgc/gmail`. Clauses on a line are joined by commas.

## Sections

Each section is given once, in any order; `subscriber` and `raw` may repeat. The printer writes them in the order
below.

### `rule` — `ruleId`, `version`

```
rule <id>, version <n>
```

### `when` — `source`, `event`

```
when <event> in <account> [and <account>…][, <option>…]
```

The event, by its catalogue phrase at version 1, or by its type and version:

| Phrase | Event type |
|---|---|
| `a new message arrives` | `gmail.message.received` |
| `a message is sent` | `gmail.message.sent` |
| `a message is labelled` | `gmail.message.labelled` |
| `a Slack message is posted` | `slack.message.posted` |
| `a Resend email arrives` | `resend.email.received` |
| `a Resend email changes status` | `resend.email.status_changed` |
| `a WhatsApp message arrives` | `whatsapp.message.received` |
| `event "<type>" version <n>` | any other, or another version |

The channel is the event type's first part, and the source's `channel` and `options.channel` are it. The options, by
channel (one is required, except Gmail's spam and trash, which is `false` when not said):

| Channel | Options | Document |
|---|---|---|
| Gmail | `in the inbox` · `in any label` · `in label <id>` · `in labels <id> and <id>` | `labels`: `inbox`, `any`, or the ids |
| Gmail | `including spam and trash` | `includeSpamTrash: true` |
| Slack | `in conversation <id>` · `in conversations <id> and <id>` | `conversations` |
| Resend | `kind <kind>` · `kinds received and status` | `kinds` |
| WhatsApp | `in all allowed chats` · `in chat <id>` · `in chats <id> and <id>` | `chats`: `all-allowed`, or the ids |

### `match` — `condition`

```
match <condition>
match any|all
  <condition>
  …
```

A condition is one line; `any` and `all` take their members from the lines indented under them, and `not` goes before
any condition, `not any` included.

| Text | Condition |
|---|---|
| `<field> exists` | `exists` |
| `<field> is <value>` | `equals` |
| `<field> is not <value>` | `notEquals` |
| `<field> contains <value>` (also `mentions`) | `contains` |
| `<field> starts with "<text>"` · `<field> ends with "<text>"` | `startsWith` · `endsWith` |
| `<field> is one of <value>, <value>…` | `in` |
| `<field> is more than` · `is at least` · `is less than` · `is at most <number or text>` | `gt` · `gte` · `lt` · `lte` |
| `<field> has domain "<domain>"` [`or a subdomain`] | `domainIs`, `includeSubdomains` |
| `not <condition>` | `not` |
| `any` · `all`, members indented | `any` · `all` |
| `raw <JSON>` | the condition as given |

`, matching case` after `is`, `is not`, `contains`, `starts with` and `ends with` sets `caseSensitive: true`; without it
the parser writes `caseSensitive: false`.

### `ask` — `agentic`

```
ask <judge id>, version <n>[, via <provider>]
  question "<text>"
  looking at <field>, <field>…        (or: looking at nothing)
  yes at <number>[, if unsure drop|hold]
  at most <n> calls an hour, <n> input tokens in 30 days, <n> at a time
  each call up to <n> tokens in and <n> tokens out
  judge [<kind>][, model <name>]
    endpoint <URL>
    approved addresses <address> and <address>
    prompt template <name>
    protocol <name>
    score at <field>
```

`if unsure drop` is `onUncertain: "no-match"`, and `if unsure hold` is `"hold"`; `if unsure …` may also stand alone.
The judge's document is embedded in the rule, so every field of it is written. Each line is optional and sets only its
own fields: the prototype's short `ask` parses, and the event service refuses what it leaves out.

The app fills a short `ask`'s judge document and limits from the judge's stored version, by its id; the parser does not.

### `then` — `targets`

```
then
  <target>
    <its options>
  …
```

At least one target, in order. Blank lines between them are ignored.

| Text | Target |
|---|---|
| `dry run <id>, version <n>[, keep <duration>]` | `dry-run`, `retentionMs` |
| `queue <id>, version <n>[, in lane <name>][, keep <duration>][, show <what>]` | `queue`, `lane`, `retentionMs`, `show` (`summary` when not said) |
| `webhook <id>, version <n>[, plain\|enveloped][, retrying up to <n> times]` | `webhook`, `representation`, `retryLimit` |
| `stream <id>, version <n>[, to subscriber <id> version <n>][, plain\|enveloped]` | `sse`, `subscriberId`, `subscriberVersion` |
| `session <id>, version <n>, working in <folder>\|in lane <name>[, with <provider>]` | `session`, `find`, `provider` (see [The session target](#the-session-target)) |
| `linear issue <id>, version <n>[, in team <key>][, label <name>\|labels <name> and <name>…][, assigned to me\|nobody\|user <id>]` | `linear`, `team.key`, `labels[].name`, `assignee` |
| `raw <JSON>` | the target as given |

A webhook's indented lines: `to <URL>` (a plain URL), `to secret <scheme> URL on <host> port <n>, fingerprint <sha-256>`
(a secret URL's public part), `approved addresses <address> and <address>`, and `signed <name>` and `ordering <name>`,
written only when they are not `standard-webhooks` and `strict`, which the parser fills.

A Linear issue (design §3.4) names its team by key, its labels by name and who it is assigned to on its line, and gives
below it the ids Linear knows them by, and its title and description:

```
  linear issue billing-issues, version 2, in team CUE, labels Billing and Urgent, assigned to me
    team id 0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11
    label ids 3e1f8a52-7c1d-4a8e-9f00-2b6c1d4e5f60 and 1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d
    title "Invoice from {{from.address}}"
    description "Check it against Stripe.\n\n{{subject}}"
```

- `team id <id>` is `team.id`; `label id <id>` (or `label ids <id> and <id>…`) pairs each id, in order, with a name on
  the target's line, so there are as many of each.
- `title "<text>"` and `description "<text>"` are the templates `{ "text": … }`: quoted text, whose `{{field}}` slots
  name the rule's mapped fields (the event service checks them when the rule is activated). A model-written part
  (`title written by …`) is refused for now: it arrives with the session target's context.
- `assigned to me` is `"me"`, `assigned to user <id>` is `{ "id": … }`, and `assigned to nobody`, or nothing, is `null`.
  No labels is `[]`. The parser fills both, and the printer leaves out each only when the document holds exactly that.
- The prototype's short line, `linear issue in team CUE, label Billing, assigned to me`, with no id or version and no
  ids below it, parses too: it gives `team: { "key": "CUE" }` and `labels: [{ "name": "Billing" }]`, and the app fills
  the rest from Linear; the event service refuses what it leaves out. Such a target prints as `raw`.

### The session target

An agent session claude-stream runs (0.33.0 design §3.5–§3.6): found by its folder, or by the window bound to a lane.

```
  session <id>, version <n>, working in <folder>|in lane <name>[, with claude-code|codex]
    if none start with claude-code|codex      (or: if none leave it in the queue)
    if busy wait                              (or: if busy leave it in the queue)
    mode <mode>
    give
      fields <field>, <field>…
      text "<text>"
      written by <model> via <provider>, asking "<instruction>", from <field>, <field>…
      file <path>
      raw <JSON>
    instruction "<text>"
```

| Text | Target |
|---|---|
| `working in <folder>` · `in lane <name>` | `find: { folder }` · `find: { lane }` |
| `with claude-code` · `with codex` | `provider`: `claude` · `codex` |
| `if none start with <provider>` · `if none leave it in the queue` | `ifNone`: `start` (and `provider`) · `queue-only` |
| `if busy wait` · `if busy leave it in the queue` | `ifBusy`: `queue` · `queue-only` |
| `mode <mode>` | `mode`, the relay's `requestedMode` |
| `give`, its parts indented | `context`, in order: `{ fields }`, `{ text }`, `{ generate: { model, provider, instruction, from } }`, `{ file }`, or a part as given |
| `instruction "<text>"` | `instruction`, the prompt's last words |

The provider is said once: in `if none start with`, or with `, with` on the first line. A lane's session is its bound
window's, so the printer writes `if none` for a lane only when it is not `leave it in the queue`. The parser fills
`ifNone: "queue-only"`, `ifBusy: "queue"`, `mode: "manual"` and `context: []` when the text says nothing of them, and
the printer leaves out exactly those (`if busy` is always written, as the prototype draws it). A part the readable
form has no words for is `raw <JSON>` in its place; a target it cannot say at all is `raw` whole. A session target
that leaves an item in the Queue — found by a lane, or with either `leave it in the queue` — gives its rule a queue
retention, as a queue target does (`targetQueues`, exported by this package).

### `subscriber` — `subscribers`

```
subscriber <id>, version <n>[, on <host> port <n>][, keep <duration>]
  origins <origin> and <origin>
```

One section per SSE subscriber, in order. With none, `subscribers` is `[]`.

### `keep` — `mapping`

```
keep <item>, <item>…
keep nothing
```

| Item | Mapping |
|---|---|
| `from.address` | `{ "from": { "address": { "$path": "/from/address" } } }`: kept where it is |
| `from.address as sender` | `{ "sender": { "$path": "/from/address" } }`: kept under another name |
| `… if missing null` | `"missing": "null"` (or `omit`, `reject`) |
| `kind = "invoice"` | `{ "kind": "invoice" }`: a fixed value, as JSON |

A name after `as` or before `=` is keys joined by dots, each letters, digits, `_` and `-`, or quoted.
A mapping that is not an object of fields — a bare reference, a constant — is written with `raw`.

### `at most` — `deliveryRateCap`

```
at most <n> an hour
```

### `cloud event type` — `cloudEventType`

```
cloud event type "<type>"
```

### `keep for` — `retention`

```
keep for
  events <duration>           ingestMs
  held events <duration>      holdMs
  deliveries <duration>       deliveryMs
  dry runs <duration>         dryrunMs
  stream replay <duration>    sseReplayMs
  dead letters <duration>     deadLetterMs
  decisions <duration>        decisionMetadataMs
  queue items <duration>      queueMs
```

Only what differs from the defaults is written, and the parser fills the rest: 7 days each, except dry runs (1 day)
and decisions (90 days), the owner's defaults of 2026-10-06 (local-event-emission design, D2); and, for a rule with a
queue target or a session target that leaves items in the Queue, queue items 7 days (action queue design, Q2). With
no `keep for`, the rule has the defaults. They are `RULE_RETENTION_DEFAULTS`, exported by this package, the one copy
the event service uses too.

## What the parser fills

When the text says nothing of them: `judges` is `[]`, `subscribers` is `[]`, `retention` is the defaults above, a
queue's `show` is `summary`, a session's `ifNone`, `ifBusy`, `mode` and `context` are `queue-only`, `queue`, `manual`
and `[]`, a webhook's `signing` and `ordering` are `standard-webhooks` and `strict`, a Linear issue's `labels` are `[]`
and its `assignee` is `null`, Gmail's `includeSpamTrash` is `false`, and a condition's `caseSensitive` is `false`. The
printer leaves each out only when the
document holds exactly that value.

## The escape form

Whatever the readable form cannot say is written as JSON, never dropped:

- `raw <JSON>` in place of a condition or a target;
- `raw /<field> = <JSON>` for a top-level field: one the grammar has no section for, or one whose shape a section
  cannot say (a retention without `queueMs` on a queue rule, `targets: []`);
- `raw /<field> absent` for a field the document lacks where the parser would otherwise expect or fill it.

A field given by a section and by `raw` is refused. Of the repository's rule fixtures, only ones the event service
would refuse need the escape form: partial documents, an authoring condition without `caseSensitive`, no targets.

## Errors

`parseRuleText` returns `{ ok: false, errors }`, each with a 1-based `line` and `column`, sorted, and keeps reading
after a mistake:

- an unknown keyword, target or line names the phrase it is closest to: `unknown keyword "thne"; did you mean "then"?`;
- a wrongly indented line is reported and still placed, so it does not also cost the lines under it;
- a missing `then`, `when` or `match` is reported after the last line, and a missing `rule` line at line 1;
- a section given twice, an option given twice, and quoted text without its closing quote are refused where they
  stand.

