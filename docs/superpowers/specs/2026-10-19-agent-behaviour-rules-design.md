# Agent behaviour rules — design (spec 2)

Status: **written 2026-10-19**, for 0.22.0. The owner asked for these rules on 2026-10-15, as part of the agent label,
and confirmed the order on 2026-10-19: spec 2, then spec 3 (sending some messages without asking), then the desktop
app. On 2026-10-19 the owner chose to have the work done without further questions ("continue until all specs and
plans are implemented"). So every decision the owner did not state is marked **(lead's call)**, for them to overturn.

This design builds on the [agent label design](2026-10-15-agent-label-design.md), whose rules, kinds and account
binding it reuses. It also builds on the writing profiles in `packages/core/src/compose-profile.ts`.

## 1. What was asked

These are the owner's words, from 2026-10-15, recorded in §1 of the agent label design:

> **Behaviour rules:** how it writes: tone, language, length, sign-off, always in the thread. This builds on the
> compose profiles the core already has; what it may do at all: for example, react and reply, but never start a
> conversation, edit or delete.

The owner wanted control "at all four levels": per message, per account, per conversation and by kind.

## 2. What is true today (main at 3916bacd, v0.21.0)

**What an agent may do is coarse.**
- **Per account,** there is only Slack's `mode`, `read` or `send`. `read` cannot post at all, and Slack enforces that.
- **Each account has a send policy:** `chat`, `confirm` or `never`. Under `never` nothing is sent; under the other two,
  every act waits for the person's yes to its exact content.
- **Nothing says "this account may reply but never start a conversation".** Within `send` mode, every act is open to
  the agent, and the person's yes is the only check.

**The label already has the right shape.**
- Its rules (`AgentLabelRule`, `packages/core/src/agent-label.ts`) name:
  - an account, bound to its stable id;
  - optionally, a conversation: a Slack channel, DM or person, or a mail address or `@domain`;
  - optionally, kinds from `ACT_KINDS`: `post`, `reply`, `reaction`, `edit`, `file`, `send`.
- The most specific rule wins.
- Adding a rule that tightens applies at once. A loosening is approved first (`classifyAgentLabelChange`).

**Writing profiles exist, but only Gmail's draft tool hands them to the agent.**
- They are Markdown files in `<config>/compose/`, in four layers: `default.md`, `user.md`, `<platform>.md` and
  `inbox-<mailbox>.md`.
- `readComposeProfile` joins them, later layers refining earlier ones, with a built-in default when nothing is written.
- `gmail_draft_create` returns the text when asked with `includeProfile`. Slack, Resend and the send-prepare tools
  never return it.

**Edit and delete** are Slack operations through the gate (`packages/slack/src/operations/amend.ts`), since 0.15.0.

## 3. Decisions

### B1. Two halves, of different strength (lead's call)

- **What the agent may do is enforced.** The tools refuse an act that a rule does not allow. Nothing reaches a preview,
  an approval or a send.
- **How the agent writes is guidance.** It is the person's writing profile, handed to whoever writes the message.
  Nothing parses tone or length, and nothing is refused for it.

**The reason for the split.** "Never start a conversation, edit or delete" is a boundary; the owner wants it to hold
even when an agent is confused or instructed otherwise by something it read. "Warm, short, signed 'C'" is style: a
machine check would be wrong as often as right, and the person sees every message in its preview anyway.

### B2. Acts

**The acts a rule can name:** `ACT_KINDS` (`post`, `reply`, `reaction`, `edit`, `file`, `send`) plus one more,
`delete`. The new type is `BehaviourAct`.

| Channel | Acts, and what each is |
|---|---|
| Slack | `post`, a new top-level message in a channel or DM. `reply`, a message in a thread. `reaction`. `edit` of a message this account posted. `delete` of one. `file`, a file shared, top-level or in a thread. |
| Gmail | `send`, a message that starts a thread. `reply`, one in an existing thread, whether by draft or prepared send. |
| Resend | `send`. Resend has no threads here, so a message with `In-Reply-To` is still `send`. **(lead's call)** |
| WhatsApp | none, since it reads only. |

**Outside the scope:**
- what touches only the person's own mailbox or workspace: drafts, labels, archiving, trash;
- reads.

These are not acts on other people. Drafts stay possible under every rule, because a draft reaches nobody. Sending
one is the act that is checked.

### B3. Rules

```json
{ "account": "cue/slack", "accountId": "acc_…", "conversation": "C0123", "acts": ["reply", "reaction"] }
```

**A rule's shape:**
- A rule means: here the agent may do these acts, and only these.
- `acts` may be empty, which means nothing at all.
- `conversation` takes the label's grammar: a Slack `C…`, `G…`, `D…` or `U…`, or a mail address or `@domain`. Left
  out, the rule covers the whole account.
- A rule carries the account's id when added, and matches only that id, as the label's do.

**Resolving them:**
- **With no rule,** every act is allowed: today's behaviour. Nothing changes on update.
- **The most specific rule wins,** conversation over account, as the label's do. A conversation rule may allow more
  than its account rule. That is a loosening, and it is approved first (B5). **(lead's call:** it is the same model as
  the label's, so a person learns one rule.**)**
- **Two rules at the same level** can't exist: adding one replaces the other.

**Where they're kept:** `config.json`, under `defaults.behaviour.rules`, beside `defaults.agentLabel`. Its schema is
loose, as the label's is, so older releases keep it through their writes.

### B4. Where an act is checked

**There is one core function,** `allowedAct(config, { accountId, account, conversation, act })`. It returns `allowed`,
or `refused` naming the rule.

**Every act is checked twice:**
1. **At prepare,** before any preview or approval: Slack's post, react, edit, delete and file prepares, Gmail's send
   prepare and draft send, and Resend's send prepare. A refusal is a `CommsError` with the new code
   `ACT_NOT_ALLOWED`, exit 1.
   - Its message names the act, the account and the conversation, and the rule that decides, such as `this agent may
     only reply and react in #general (cue/slack)`.
   - Its hint names the command that shows the rules. It never names one that loosens them: a loosening is the
     person's to start.
2. **At execute,** inside the existing single send paths, before the provider is called: Gmail's `send.execute`,
   Resend's `executeSend`, and Slack's send gate. A rule tightened after the yes stops the act, with the same code. **No
   new send path is added**, since AGENTS.md allows only those.

**Deciding the act:**
- Slack decides `post` or `reply` from `thread_ts`, and `file` from a file part. A message with both files and text is
  `file`.
- Gmail decides `reply` from the thread: a `threadId`, or `In-Reply-To` naming a message in this mailbox.
- **The conversation is the destination:** a Slack channel id, the DM's channel or the person (a `U…` rule matches the
  DM with them), or each recipient's address for mail.
- **For mail, every recipient must be allowed.** A rule for `@client.com` that forbids `send` refuses a message with
  any recipient there. **(lead's call:** the strictest reading, because one forbidden recipient is the point of such a
  rule.**)**

**What every preview carries:** a line `Allowed here: reply, reaction (rule: cue/slack, #general)`, or `Allowed here:
everything (no rule)`, so the person sees what holds.

### B5. Changing the rules

**The CLI and MCP surfaces, which keep parity:**

| CLI | MCP | What it does |
|---|---|---|
| `agentcomms behaviour` | `comms_behaviour` (no change) | Reports every rule and, for each account, what is allowed: across the account, and per conversation where a rule exists |
| `agentcomms behaviour allow <account> <act,…\|none> [--conversation <id>] [--approval <id>]` | `comms_behaviour` with `setRule` | Adds a rule, or replaces the one at that level |
| `agentcomms behaviour clear <account> [--conversation <id>] [--approval <id>]` | `comms_behaviour` with `removeRule` | Removes a rule |

**Tightening and loosening:**
- A change **tightens** when, at every level it affects, the allowed acts after are a subset of those before. It
  applies at once.
- Anything else **loosens**, and is approved first through the change flow, under the change policy. The preview shows
  `before → after` at each affected level. Examples are removing a rule, adding an act, or a conversation rule wider
  than its account's.
- At a terminal, the person approves inline.

**The agent's part:**
- An agent may start any change, but only the person's yes applies a loosening.
- The skills tell agents to start a loosening only when the person asked for it, as they already do for the label's
  `me` rules.

**Rows:** each one in `capabilities.json` names the same operation in `packages/core/src/operations/behaviour.ts`.

### B6. How it writes: writing profiles for every channel and conversation

**Two layers join the four.** In order, the layers are:
1. `default`
2. `user`
3. `platform`: `gmail.md`, `slack.md` or `resend.md`
4. `account`
5. `conversation`

**The `account` layer:**
- It is `inbox-<account>.md`. It is renamed `account` in the code but keeps its filename, so files people have
  written keep working.
- Slack and Resend accounts use the same pattern: `inbox-cue__slack.md`.

**The `conversation` layer:** `conversation-<account>__<conversation>.md`. The conversation is the same id a behaviour
rule takes, with `@` kept and characters a filename cannot hold encoded as `%XX`.

**Who gets the profile:**
- Every prepare tool takes `includeProfile`, and returns `profile` (the joined text) and `profileSources` (the files
  read):
  - Slack's `slack_post_prepare` and `slack_edit_prepare`;
  - Gmail's `gmail_send_prepare`, `gmail_draft_create`, `gmail_draft_reply` and `gmail_draft_update`;
  - Resend's send prepare.
- Gmail's draft tools keep `includeProfile` as they are.
- The profile is text written by the person, so it reaches the agent as the person's instructions and is not wrapped
  as untrusted. Nothing in it is ever sent.
- **The skills say:** read the profile before writing a message (`includeProfile: true` on the first prepare), and
  follow it. Where the profile and the person's request in the conversation disagree, the request wins.

**Reading and preparing profiles:**

| CLI | MCP | What it does |
|---|---|---|
| `agentcomms profile [<account>] [--conversation <id>]` | `comms_profile` | Shows the joined profile for that place and the files it would read, existing or not |
| `agentcomms profile init [<account>] [--conversation <id>]` | (none) | Creates the missing file for that layer from a starter, and prints its path |

**No tool lets an agent write a profile. (lead's call)** A profile is the person's own instructions to their agents.
If an agent could rewrite it, something the agent read could make it change how all later messages are written.
`profile init` exists only in the CLI, for the person. It creates a starter and never overwrites.

**The starter** has five headings, each with one line of example: Tone, Language, Length, Sign-off and Threads. For
example, Threads says "Reply in the thread; start a new message only when asked." It is guidance: "always in the
thread" as a rule is B3's `reply` without `post`.

### B7. Per message

- **The person's own words in the conversation** ("just react, don't reply") govern that message, as they do today,
  because the person approves the exact act.
- **A rule is the boundary under every message:** no per-message instruction lets an agent do an act the rule forbids.
- **There is no new per-message parameter.** **(lead's call:** the preview and the person's yes already make every
  message individually chosen.**)**

### B8. What doesn't change

- The send gate, the untrusted-content envelope and the label are untouched.
- Every act still needs the person's yes. Spec 3 is the only place that may change that.
- An account with no rules behaves exactly as in 0.21.0.

### B9. Organisations

Out of scope. An organisation-wide floor ("no agent may delete in our workspace") is a natural first profile extension
(CUE-494's `extensions`), designed when an organisation asks for it.

## 4. Tests

**Rules and resolution:**
- The most specific rule wins.
- A rule bound to one account id doesn't match another account later given the same name.
- An empty `acts` means nothing is allowed.
- With no rule, everything is allowed.

**Classification:**
- A subset tightens, and applies at once.
- Anything else loosens, and asks first.
- A conversation rule wider than its account's loosens.
- Removing a rule loosens unless the account rule it falls back to is no wider.

**Enforcement at prepare,** for every act of every channel, through the CLI and MCP: refused with `ACT_NOT_ALLOWED`,
with no preview and no approval created.

**Enforcement at execute:**
- Prepare, then tighten, then claim the approval: refused, and the fake provider receives nothing.
- This uses Gmail's fake transport, Slack's loopback fake and Resend's loopback fake. Nothing real is reached.

**Deciding the act:**
- Slack `thread_ts` gives `reply`; a file part gives `file`.
- Gmail's thread gives `reply`, and a mail recipient's domain matches an `@domain` rule.

**Previews:** every one carries the `Allowed here:` line.

**Profiles:**
- The five layers apply in order, and the account layer reads `inbox-*.md` files written before this release.
- Conversation filenames are encoded.
- `includeProfile` works on every listed prepare.
- `profile init` never overwrites, and is not reachable over MCP (a parity row of kind `cli-only`, if the parity
  tooling has one; otherwise listed as a CLI-only capability as other person-only commands are).

**Repository checks:**
- the guards: no binary named in runtime strings, names looked up through `lookupName`/`resolveName`;
- `verify:parity --strict`;
- Windows-safe paths in every new test.

## 5. Out of scope

- Spec 3: sending some messages without asking.
- Organisation floors (B9).
- Checking style automatically.
- Rules on reading.
