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

**Writing profiles exist, but only Gmail's draft tools hand them to the agent.**
- They are Markdown files in `<config>/compose/`, in four layers: `default.md`, `user.md`, `<platform>.md` and
  `inbox-<mailbox>.md`.
- `readComposeProfile` joins them, later layers refining earlier ones, with a built-in default when nothing is written.
- `gmail_draft_create`, `gmail_draft_reply` and `gmail_draft_update` return the text when asked with
  `includeProfile`. Slack, Resend and the send-prepare tools never return it.

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
| Slack | `post`, a new top-level message in a channel or DM. `reply`, a message in a thread. `reaction`. `edit` of a message this account posted. `delete` of one. `file`, a file shared. **A file share needs `file` and, for where it lands, `post` (top-level) or `reply` (in a thread); an edit that adds files needs `edit` and `file`.** So `reply` with `file` means files only in threads. **(lead's call)** |
| Gmail | `send`, a new message, a forward included. `reply`, a message whose `In-Reply-To` names a message that exists in this mailbox, checked against Gmail at prepare and bound into the approval. A thread id alone is not a reply: Gmail gives every draft one. **(lead's call)** |
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
- A rule carries the account's id when added.

**Rules fail closed (lead's call),** because here "no rule" means everything is allowed:
- **A rule matches its account by id,** so it follows a rename. `gmail_inbox_rename` needs no approval, and a rename
  must never shed a restriction.
- **A rule whose id no account holds any more** (an orphan, left by a removal and a reconnection) still applies by
  name, to an account of that name. A restriction applied more widely is safe. `behaviour` and `doctor` list orphans.
- **An act this release does not know** is dropped from that rule's list, which narrows the rule.
- **A rule this release cannot read at all** (a bad shape) makes its account allow nothing, and `doctor` says so.
  Nothing ever makes the whole list vanish, as the label's reader may for the label.

**Resolving them:**
- **With no rule,** every act is allowed: today's behaviour. Nothing changes on update.
- **The most specific rule wins,** conversation over account, as the label's do. For mail, an address rule wins over
  its `@domain` rule, which wins over the account rule. A conversation rule may allow more than its account rule. That
  is a loosening, and it is approved first (B5). **(lead's call:** it is the same model as the label's, so a person
  learns one rule.**)**
- **Two rules for the same place** can't exist: adding one replaces the other.
- **Two different places can match at the same specificity,** such as a Slack DM matched by its `D…` rule and by the
  person's `U…` rule. Then **the narrower wins**: only the acts both allow are allowed.

**Where they're kept:** `config.json`, under a top-level `behaviour: { rules: [...] }`, beside the top-level
`agentLabel`. Its schema is loose, as the label's is, so older releases keep it through their writes.
`classifyChange` and `changedSettings` learn it, as they learned `agentLabel` (`LABEL_SETTINGS`).

### B4. Where an act is checked

**There is one core function,** `allowedAct(config, { accountId, account, conversation, act })`. It returns `allowed`,
or `refused` naming the rule.

**Every act is checked twice:**
1. **At prepare,** before any preview or approval:
   - Slack: `slack_post_prepare` (posts, replies and files), `slack_react`, `slack_edit_prepare` and
     `slack_delete_prepare`;
   - Gmail: `prepareSend` (a draft's send is its execute);
   - Resend: `prepareSend`.

   A refusal is a `CommsError` with the new code `ACT_NOT_ALLOWED`, **exit 10**. That is the refusal class of
   `POLICY_NEVER` and `SEND_REFUSED` (`errors.ts`).
   - Its message names the act, the account and the conversation, and the rule that decides, such as `this agent may
     only reply and react in #general (cue/slack)`.
   - Its hint names the command that shows the rules. It never names one that loosens them: a loosening is the
     person's to start.
2. **At execute,** inside the existing send paths, before the provider is called:
   - Gmail's `executeSend`, which both `gmail_draft_send` and `gmail_send_execute` are;
   - Resend's `executeSend`;
   - Slack's `claimOrHandOver` (`packages/slack/src/operations/send.ts`), the one point that Slack's post, react, edit
     and delete executes share.

   A rule tightened after the yes stops the act, with the same code. **No new send path is added**, since AGENTS.md
   allows only these.
3. **Servers started before 0.22.0 enforce nothing** until their client restarts them. The first rule added on a
   machine says so in its result, and `doctor` names any registered server older than 0.22.0. **(lead's call:**
   bumping the config's version would make every older server refuse every tool, which does more harm than a restart
   prompt.**)**

**Deciding the act:**
- **Slack** decides `post` or `reply` from `thread_ts`. A file needs `file` as well (B2).
- **Gmail** decides `reply` only from an `In-Reply-To` naming a message in this mailbox (B2). A forward, or a bare
  thread id, is `send`.
- **The conversation is the destination:** a Slack channel id, the DM's channel or the person (a `U…` rule matches the
  DM with them), or each recipient's address for mail.
- **For mail, each recipient is resolved on its own:** address, then `@domain`, then account. The act must be allowed
  for every one of them. A rule for `@client.com` that forbids `send` refuses a message with any recipient there.
  **(lead's call:** the strictest reading, because one forbidden recipient is the point of such a rule. The label's
  own mail matching, which applies a conversation rule only when every recipient matches, is not reused.**)**

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
- **The agent reads it before it writes,** with `comms_profile`. That tool only reads and needs no approval, so the
  first preview is already written to the profile, and the person sees one preview, not two. **(lead's call)**
- Gmail's three draft tools keep `includeProfile` as they are. No other prepare gains it.
- The profile is text written by the person, so it reaches the agent as the person's instructions and is not wrapped
  as untrusted. Nothing in it is ever sent.
- **Which conversation files apply:**
  - for mail, every recipient's file, the address's before its `@domain`'s;
  - for a Slack DM, both the `D…` file and the person's `U…` file.

  Each is marked with its source, and they are joined in that order after the account layer.
- **The skills say:** call `comms_profile` for the account and the conversation before writing a message, and follow
  it. Where the profile and the person's request in the conversation disagree, the request wins.

**Reading and preparing profiles:**

| CLI | MCP | What it does |
|---|---|---|
| `agentcomms profile [<account>] [--conversation <id>…]` | `comms_profile` | Shows the joined profile for that place and the files it would read, existing or not. `--conversation` repeats, for several mail recipients |
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
- The most specific rule wins: an address over its `@domain`, over the account.
- A DM matched by both a `D…` rule and a `U…` rule gets the narrower.
- An empty `acts` means nothing is allowed.
- With no rule, everything is allowed.

**Failing closed:**
- A rename keeps its rules.
- An orphaned rule applies by name.
- An unknown act narrows its rule.
- An unreadable rule makes its account allow nothing.

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
- Slack `thread_ts` gives `reply`.
- A file needs `file` plus `post` or `reply`, and an edit that adds files needs `edit` and `file`.
- In Gmail, an `In-Reply-To` naming a message in the mailbox gives `reply`. A forward, or a bare thread id, gives
  `send`.
- A mail recipient's domain matches an `@domain` rule.

**Previews:** every one carries the `Allowed here:` line.

**Profiles:**
- The five layers apply in order, and the account layer reads `inbox-*.md` files written before this release.
- Conversation filenames are encoded.
- Several recipients' files are joined, in order.
- `comms_profile` only reads.
- `profile init` never overwrites, and is not reachable over MCP. It is listed as a CLI-only capability, as other
  person-only commands are.

**Repository checks:**
- the guards: no binary named in runtime strings, names looked up through `lookupName`/`resolveName`;
- `verify:parity --strict`;
- Windows-safe paths in every new test.

## 5. Out of scope

- Spec 3: sending some messages without asking.
- Organisation floors (B9).
- Checking style automatically.
- Rules on reading.
