# Agent behaviour rules — design (spec 2)

Status: **written 2026-10-19**, for 0.22.0. The owner asked for these rules on 2026-10-15, as part of the agent label,
and confirmed the order on 2026-10-19: spec 2, then spec 3 (sending some messages without asking), then the desktop
app. On 2026-10-19 the owner chose to have the work done without further questions ("continue until all specs and
plans are implemented"). So every decision the owner did not state is marked **(lead's call)**, for them to overturn.
Revised on 2026-10-19 after two independent code reviews: what changed then is marked **(lead's call, after review)**.

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
| Gmail | `send`, a new message, a forward included. `reply`, a message whose `In-Reply-To` names a message that exists in this mailbox, checked against Gmail at prepare and bound into the approval. A thread id alone is not a reply: Gmail gives every draft one. **(lead's call)** The act is decided **per recipient**: a recipient is `reply` only if their address is on the proven message — its From, Reply-To, To or Cc — and `send` otherwise, so a reply to an unrelated message cannot reach someone new as a reply. The proof never uses Spam or Trash: a message only there proves nothing. **(lead's call, after review)** |
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

**Rules fail closed against names too (lead's call, after review):**
- **A rule naming an account no account here could ever have** — outside the configuration's name grammar (`*`, upper
  case, a version-1 name in a version-2 configuration), or a former name whose account is gone (a former name is never
  given again) — is unreadable, and since it names no account it can hold, it holds every account: each allows nothing
  until a person corrects it. A restriction that silently holds nothing is the failure this prevents.
- **A rule naming a former name** holds the account that name points at now, through the former-names table.
- **`names migrate` renames the rules** that hold each account it renames, as `renameEntry` does for one rename, and the
  store accepts a migration whose rules changed only so.
- `doctor`'s orphan row promises a future account only for a name an account could still be given.

**Resolving them:**
- **With no rule,** every act is allowed: today's behaviour. Nothing changes on update.
- **The most specific rule wins,** conversation over account, as the label's do. For mail, an address rule wins over
  every `@domain` rule, which wins over the account rule. A conversation rule may allow more than its account rule. That
  is a loosening, and it is approved first (B5). **(lead's call:** it is the same model as the label's, so a person
  learns one rule.**)**
- **How mail rules meet a recipient (lead's call, after review):**
  - An address rule and a recipient compare as the mailbox they reach: a `+tag` in the local part is ignored on both
    sides (`ceo+x@client.test` meets `ceo@client.test`), and for `gmail.com` and `googlemail.com` the dots in the
    local part are ignored too and the two domains are one.
  - An `@domain` rule covers its subdomains: `@client.test` holds `x@eu.client.test`. Among domain rules the longest
    that covers the recipient wins, so `@eu.client.test` wins over `@client.test`. Specificity: address > longest
    matching domain > account.
  - Before these, case, Unicode or punycode, and a trailing dot are already one spelling (`normaliseMailConversation`).
- **A Slack place that is no conversation id** — a channel's name, `#name`, an id in lower case — is held to every rule
  of its account at one level, so only what all of them allow is allowed, as a DM whose person could not be read is
  held to every person's rule. Slack refuses such a destination at prepare (B4); this is the backstop beneath it.
  **(lead's call, after review)**
- **Two rules for the same place** can't exist: adding one replaces the other. Two rules whose addresses only reach
  one mailbox — `ceo@client.test` and `ceo+board@client.test` — are two places, both kept, and a recipient there gets
  only what both allow, as two rules at one level do. **(lead's call, after review)**
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
- **Slack** decides `post` or `reply` from `thread_ts`. A file needs `file` as well (B2). **(lead's call, after
  review:** Slack posts a `thread_ts` that names no message in that conversation as a new top-level message, so a
  thread is never taken on the draft's word. A post's `thread_ts` must have a message ts's form — `USAGE` where it is
  given, `BAD_DATA` in a stored or hand-written draft. Where the rules as they are now allow a reply and not a post, or
  a post and not a reply, the thread is read from Slack (`conversations.replies` in that channel at that ts): a message
  there makes it a `reply`; none makes it a `post`, checked as that, the refusal's hint saying why. Where they allow
  both, or neither, the post is checked as both acts, so Slack is asked nothing more — and an account with no rules
  asks Slack nothing it did not before. This is decided again at the approval screen and at the send, from the channel
  and thread the digest already binds, so a thread gone by the send is a post there. A read that fails for a moment is
  `TRANSIENT`, nothing sent.**)**
- **A Slack destination is a conversation id** — a channel's `C…` or `G…`, a DM's `D…`, in capitals and digits — and
  anything else (a channel's name, `#name`, an id in lower case) is refused `USAGE` (`not-a-conversation`) at draft
  create and update, at post prepare, at a reaction's prepare and claim, at an edit's and a deletion's, and wherever a
  post is viewed, before Slack is asked anything. `chat.postMessage` takes a name, and a name matched no rule. Beneath
  this, core holds a place that is no id to every rule of its account (B3). **(lead's call, after review)**
- **Gmail** decides `reply` only from an `In-Reply-To` naming a message in this mailbox, outside Spam and Trash (B2),
  and only for the recipients on that message. A forward, or a bare thread id, is `send`. **(lead's call, after
  review:** a Gmail error while proving the reply raises `TRANSIENT` — nothing sent, nothing used, retryable — and
  never reads as "not a reply", which a rule that allows only replies would refuse for good.**)**
- **The conversation is the destination:** a Slack channel id, the DM's channel or the person (a `U…` rule matches the
  DM with them), or each recipient's address for mail.
- **A person's rule holds every group DM with them too (lead's call, after review).** A group DM (`G…`, an mpim) is
  one place for each person in it but this account, each place the room with that person — `[G…, U…]` — and every
  place must allow the act. So a person's narrower rule holds the group DM, a rule for the room itself still wins over
  the account's where no person's rule speaks, and a person's wider rule cannot widen the room past what its other
  people allow. The members are those Slack reports (`conversations.members`, paged), read only while a rule names a
  person. Failing closed: members that could not be read, or a `G…` room that could not be read at all (it may be a
  group DM), are held to every person's rule. Nothing more is bound, so a channel's and a group DM's approvals keep
  their digests; the members are read and held again at the claim. (The decision as given was the room and each
  member as separate places; pairing each member with the room keeps a rule for the room able to allow more than its
  account, as every conversation rule may.)
- **For mail, each recipient is resolved on its own:** address, then the longest `@domain`, then account. The act — for
  Gmail, the act the message is to that recipient — must be allowed for every one of them. A rule for `@client.test` that forbids `send` refuses a message with any recipient there.
  **(lead's call:** the strictest reading, because one forbidden recipient is the point of such a rule. The label's
  own mail matching, which applies a conversation rule only when every recipient matches, is not reused.**)**

**What every preview carries:** a line `Allowed here: reply, reaction (rule: cue/slack, #general)`, or `Allowed here:
everything (no rule)`, so the person sees what holds. A Gmail reply's preview, and its approval screen, also carry
`Checked as: reply to <From of the proven message>` — a sender's words, so neutralised and flattened to one line — and
how many recipients get it as a new message. **(lead's call, after review)**

**Where the second check sits (lead's call, after review):**
- **Gmail binds each recipient's act into the approval's digest** (`{ v: 2, content, places: [[address, act], …] }`).
  The approval screen and the send read the acts back from the digest: every recipient a `send`, every one a `reply`,
  or — only when neither is the digest — the reading a fresh proof gives, which the digest must confirm. A mailbox
  changed since can never turn a send into a reply; a mixed reply whose original has gone cannot be read back, and its
  approval is void. An approval prepared before 0.22.0 binds the draft's digest alone, and each recipient is checked
  as both acts when its `In-Reply-To` could make it a reply.
- **Every channel checks before the approval is claimed,** so a refused approval stays usable: loosened again, the same
  approval goes once. Gmail checks again after the claim, before each attempt; Resend asks before each attempt too, so
  a rule tightened while a throttle is waited out stops the retry.
- **The terminal's approval screen refuses** what a rule tightened since the prepare forbids, on Gmail and Resend
  alike, and issues no code.
- **`doctor`** counts a registered server that names no release, or one it cannot read, as one that may enforce no
  rule.

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
- A group DM is held to the rule of every person in it, and to every person's rule when its members cannot be read.
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
- Slack `thread_ts` gives `reply` only with a parent in that channel, where the rules tell a reply from a post; an
  unknown `thread_ts`, or one from another channel, is checked as `post`; a malformed one is refused.
- A Slack destination that is no conversation id is refused at prepare, and held to every rule beneath that.
- A Gmail recipient not on the message a reply answers is checked as `send`; Spam and Trash prove nothing; a Gmail
  error during the proof is `TRANSIENT`.
- A file needs `file` plus `post` or `reply`, and an edit that adds files needs `edit` and `file`.
- In Gmail, an `In-Reply-To` naming a message in the mailbox gives `reply`. A forward, or a bare thread id, gives
  `send`.
- A mail recipient's domain matches an `@domain` rule, and so does a subdomain of it, a longer subdomain rule winning.
- An address rule holds the address with a `+tag`, and at Gmail with dots and at `googlemail.com`.
- A rule naming an account that can never match holds every account; a former name holds its account; `names migrate`
  keeps every rule holding its account.

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
