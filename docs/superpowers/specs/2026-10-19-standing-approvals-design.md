# Standing approvals: some messages sent without asking — design (spec 3)

Status: **written 2026-10-19**, for 0.23.0, after spec 2
([agent behaviour rules](2026-10-19-agent-behaviour-rules-design.md)); **revised 2026-10-19 after an independent
security review,** and settled again after build (§9).

**What the owner asked:**
- On 2026-10-15: that some messages go without asking each time, acknowledgements especially.
- On 2026-10-19: "continue until all specs and plans are implemented", without further questions.

So every decision the owner did not state is marked **(lead's call)**, including how each of the review's findings was
settled.

**This design changes the product's first rule:** nothing is sent without the person's yes to its exact content. So it
carries its own threat model (§4), which says plainly what it does not defend, and every loosening it adds is approved
the strongest way the product has (S8).

## 1. What was asked

The owner, 2026-10-15:

> Agents that listen and read information via Slack sometimes send acknowledgments back and then send responses back,
> but they send them as me, which is fine in most cases.

They also asked that sending some messages without asking be designed, after the behaviour rules. The agent label
design (§1) recorded it this way:

> **Sending some messages without asking**, for example acknowledgements. It changes the rule that nothing is sent
> without the person's yes to its exact content, so it needs a threat model of its own.

## 2. The idea in one paragraph

**A standing approval** is the person's yes given in advance, for acknowledging. It covers:
- an exact set of contents, written by the person: standard emoji reactions, or short fixed texts;
- a bounded set of places;
- a bounded number of uses;
- a time limit.

**What the agent chooses, and what it doesn't:** the agent decides **whether** to acknowledge a message that has just
arrived, and **with which** pre-approved content. It never writes the words, and it cannot pick an old message, one
among many, or a new place. Every act goes out as the agent, and is counted, audited and shown on the person's screen.
The person can end every standing approval at once with one command.

**How this squares with the first rule:** the person still approved the exact content. What they gave up is approving
the moment and the exact message, within limits they set.

## 3. What is true today (the `feat/0.22` branch, read 2026-10-19)

- **The terminal check is a speed bump, not a boundary.** The repository says so: `script -q /dev/null` makes any
  command see a terminal (`packages/core/src/change-flow.ts` ~321).
- **Under the `chat` change policy, the terminal takes a typed `yes`, not a code** (`change-flow.ts` ~262), and a
  caller with the answer already (`answered`) skips even that. A change approval's route and `requiredPolicy` come
  from the change policy (`packages/core/src/approvals.ts` ~1623, ~1639); only at `confirm` must `approvedVia` be
  `'terminal'` (~1394).
- **Under a `chat` send policy, Slack's react and post tools act on the agent's word** after it reports the person's
  yes (`packages/slack/src/mcp/server.ts` ~818, ~1024). No tool can check a yes given in a chat; the skills are what
  make the agent ask.
- **A reaction is never labelled, and often goes as the person:** in a DM, a group DM, a room the app isn't in, or a
  `labelled` workspace (`packages/slack/src/operations/label.ts` ~247–254, ~294–303).
- **The big-room rule is about reach, not membership:** a post needs the terminal when it notifies 50 or more people
  (`packages/slack/src/operations/send.ts` ~636, `packages/slack/src/compose/preview.ts` ~92). A plain reply in a
  room of 400 notifies nobody, and passes.
- **`isShared` mixes another organisation's sharing with an Enterprise Grid's own** (`is_org_shared`,
  `packages/slack/src/operations/people.ts` ~89). An external author is known per message (`is_stranger`, a foreign
  `team_id`: `packages/slack/src/text/message.ts` ~223).
- **Approval records have fixed lifetimes and per-record locks:** `approval-validate.ts` accepts only the lifetimes a
  route gives (~267–276), an approved record lasts 24 hours, `ensurePruned` deletes a finished one 90 days on, and
  each record's lock is its own (`approvals.ts` ~1062).

## 4. Threat model

**Who might attack, and what they can do:**
- **Anyone who can put text in front of the agent:** a Slack message, a channel topic, a file name, an email. Such text
  can try to make the agent act (prompt injection). Today the person's yes on every preview is the defence. Under a
  standing approval that defence is gone, for the acts it covers.
- **A confused agent,** with no attacker at all: loops, repeats, the wrong thread.
- **Another agent or bot** answering ours: acknowledgement loops.
- **An agent that wants more than it was given:** it can propose a standing approval, list every id, and call any MCP
  tool.

**The boundary (lead's call):** this design defends against an agent acting **through MCP tools**. The real loosening
is for accounts at `confirm`. Under `chat` the tools already act on the agent's word (§3): there a standing approval
adds enforcement, not freedom, and its contents, places and limits hold only on the standing path (S2).

| # | Threat | What it would cost | Mitigation |
|---|---|---|---|
| T1 | Injected text makes the agent send words of the attacker's choosing | impersonation, data leak | **No free text.** The gate builds the payload from the person's fixed content, named by digest (S3, S9). |
| T2 | Injected text leaks data by choosing which content, which message or where (a covert channel) | a few bits per act | A fixed target: the newest message from someone else, just arrived (S4). Fixed places (S5), one emoji by default (S3), low counts (S6). |
| T3 | Messages go to new people or places | spam, a wrong-recipient leak | Exact places, or threads the person really posted in; threads only, no mentions; big rooms and other organisations only where named exactly, failing closed (S5). |
| T4 | Volume: loops with another bot, or a flood | reputation, rate limits | Humans only, by allow-list (S4). Once per thread across all standing approvals; hourly and daily caps (S6). |
| T5 | Being taken for the person ("Got it" read as their promise) | reputation | A reply goes as the app or labelled; a reaction only as the app (S7). |
| T6 | An agent creates or widens a standing approval | the whole feature | Forced to `confirm` and a terminal code: no typed `yes`, no form, no `answered`. The preview says when an agent proposed it (S8). |
| T7 | A standing approval outlives its purpose | drift | Expiry at most 30 days, 7 by default; revoke; `standing off`. Tightening the change policy, or `never`, ends them by epoch (S8). |
| T8 | Edits, deletes, files, reaction removals or mail out of reach of the yes | irreversible harm | Not coverable (S1). |
| T9 | The behaviour rules (spec 2) are bypassed | the boundary | `allowedAct` before the mint, and again at execute (S9). |
| T10 | Records tampered with, or approved through a client's form | forged acts | The store's integrity rules; `standing` is approved only at a terminal; each use is a child approval (S8, S9). |
| T11 | Fixed content read as more than it is | a false yes, a workflow started | `eyes` by default; standard emoji only; a warning for emoji that read as approval; no acknowledging buttons, selects or workflows (S3, S4). |
| T12 | The acknowledged message is changed afterwards | a false record of what was agreed | The audit keeps its text's digest and `edited` state at the act (S10). |
| T13 | Two uses race, or the clock is moved back | acts over the limits | The count is spent at mint, under the lock, never refunded; a clock behind the last act refuses (S9). |
| T14 | Someone makes a message or thread qualify: a mention, an old thread, many posts to pick from | acts where the person isn't | No mention criterion; fresh, newest, not yet acknowledged (S4); only the person's own posts count (S5). |
| T15 | The agent hides what it did | misuse nobody notices | An OS notification for each act, the list, `doctor` and the audit, none through the agent (S10). |

**Out of reach, and accepted:**
- **An agent with an unrestricted shell, running as the person.** It can already get past the terminal check, edit the
  configuration and run the CLI as the person (§3), as can anyone who can write to the configuration directory. An OS
  user-presence check would reach further: future work (§7).
- T2's covert channel: about one bit per act (act or not, on a message the agent did not choose), within the counts.
- Under `chat`, an agent that ignores the skills and takes the ordinary path: today's risk, unchanged.

## 5. Decisions

### S1. What a standing approval may cover (lead's call)

**In 0.23.0, two Slack acts only:**
- `reaction`: adding one, from a fixed list of emoji. Never removing one. **(lead's call)**
- `reply`: in a thread, from a fixed list of texts, each at most 200 characters.

**Out of 0.23.0:** mail, top-level posts, edits, deletes, files, and removing reactions. Mail goes outside the
organisation and cannot be taken back, and the owner's example was Slack. Mail can be a later design, starting from
this one.

### S2. What it means under each send policy (lead's call)

No send tool can check a yes given in a chat (§3). So:
- **`confirm`:** a standing approval is the only way a reaction or reply skips the terminal code. The real loosening.
- **`chat`:** it is the sanctioned scope in which an agent may act without asking. The skills say: without one that
  covers it, always ask. On the standing path the gate enforces S3 to S7; on the ordinary path, as today, it does not.
- **`never`:** nothing. A standing act is refused with `POLICY_NEVER`, and `never` ends the account's standing
  approvals (S8).

### S3. Contents

**What the person writes:**
- `reactions`: emoji names, at most 5. **The default is `eyes` alone. (lead's call)**
- `replies`: fixed texts, at most 5, each at most 200 characters, as the person writes them, such as "Got it, I'll look
  at this and come back to you."

**Reactions (lead's call):**
- Only standard Unicode emoji names, from a list shipped with the release. A custom workspace emoji is refused: its
  image can be replaced under the same name.
- The preview warns for an emoji that reads as approval: `white_check_mark`, `heavy_check_mark`,
  `ballot_box_with_check`, `+1` (`thumbsup`), `ok`, `ok_hand` and the like. People read ✅ on "can I deploy?" as a
  yes, and a Slack workflow can start on a reaction.

**Texts:** no placeholders, links, mentions (`<@…>`, `<!…>`) or markup beyond plain text, each checked at creation.
The agent label prefix is added as for every labelled post (S7).

**Each content is named by digest, never by position (lead's call).** The digest covers its kind and exact text, and
`standing list` shows it. A list narrowed or reordered can't turn "content 2" into another text.

### S4. Which messages may be acknowledged (lead's call)

The review found that "a thread that mentions the person" let anyone make a thread qualify, and that a free choice
among many messages is a covert channel. So what just happened fixes the target; the agent does not choose it.

**A target must be:**
- **from another human,** by the allow-list below;
- **fresh:** it arrived after the standing approval was created, and within the last 15 minutes;
- **the newest message from someone else** in its thread, or in its channel when not in a thread;
- **not yet acknowledged** by any standing approval of this account (S6's `perThread`).

**Human, by allow-list (lead's call).** The message, and its thread's parent, must:
- have a `user` beginning `U` or `W`, whom `users.info` does not call a bot;
- carry no `bot_id`, `app_id`, `bot_profile` or `subtype` at all;
- not be from this account, nor in this account's app-posts record;
- not be from Slackbot (`USLACKBOT`, which begins with `U`).

Whatever can't be read is refused.

**Threads the person started (lead's call, after build).** The thread's parent may instead be the person's own
message, when this product did not send it:
- their own user id, with none of `bot_id`, `app_id`, `bot_profile` or `subtype`;
- not in the app-posts record, and not in the audit's record of what was sent: the same test `threads-i-am-in` makes
  of the person's posts (S5). The audit is read as far back as the parent, however old the thread.

A parent from a bot, an app, Slackbot or this account's app, or one this product sent, is still refused. The message
acknowledged must still be from another human: never the person's own.

**Nothing to press (lead's call).** A message with interactive blocks (buttons, selects), or from a workflow, is
refused. A reaction on a form or an approval request can read as an answer to it.

### S5. Places

**A standing approval names its places in one of two ways:**
- **Exact channels or DMs** (`C…`, `G…`, `D…`), named at creation.
- **Or `threads-i-am-in`, in one workspace (lead's call):** threads where the person's own user id posted, within the
  last 14 days, a message this product did not send. A message in the app-posts record, or in the audit's record of
  what was sent, doesn't count, and neither does a mention.

**Where each act may go:**
- A `reply` goes only in a thread, never top-level.
- A `reaction` goes on a message in an exactly named channel or DM. Under `threads-i-am-in`, only on a message inside
  a qualifying thread, never on a channel message outside one. **(lead's call)**
- Either goes only on a target S4 allows.

**Big rooms (lead's call).** The existing rule counts whom a post notifies, not who is in the room (§3). This adds a
member count that fails closed:
- A place with 50 or more members is refused, unless named exactly at creation with its member count in the preview.
  One that has reached 50 since is refused until the person approves it again.
- A count that can't be read refuses. A DM's or group DM's members are counted.

**Other organisations (lead's call).** `isShared` is not used (§3). External presence is read, at execute, from the
channel's `is_ext_shared` and `is_pending_ext_shared`, and from each member: a `team_id` not the workspace's, or
`is_stranger`. Members are read for every DM, group DM and place under 50. A place with anyone external is refused,
unless named exactly. An exactly named channel's shared state is recorded at creation, and a change refuses.

**On top of all this,** spec 2's rules apply: an approval cannot reach where `reply` or `reaction` is not allowed.

### S6. Limits

**Each standing approval has:**
- `perThread`: 1 by default, at most 3, per thread, or per message outside a thread. **It counts across every standing
  approval of the account (lead's call),** so two approvals cannot double it.
- `perHour`: 10 by default, at most 30.
- `perDay`: 30 by default, at most 100.
- `expires`: 7 days by default, at most 30.

**Enforcement:** a use spends its count when minted (S9), never refunded. Hitting a limit refuses the act with
`STANDING_LIMIT`, saying which limit and when it frees. It is never queued.

### S7. Identity

**A reply goes out as the agent:** through the app, where the workspace has its bot token, its style is `app` and the
app is a member; otherwise labelled, "Name (agent): …".

**A reaction goes only as the workspace's agent app (lead's call):** bot token present, style `app`, app a member.
Wherever the label would send it as the person, unlabelled (§3), it is refused, so it never goes in a DM.

**The app's membership is read for every reaction (lead's call, after build).** An app post may go to a public channel
the app has not joined, so the label's route alone does not settle it. Before the mint, so that no count is spent, the
app's bot user must be found among the conversation's members (`conversations.members`). One not found, or a membership
that can't be settled, refuses with `STANDING_REFUSED`, reason `app-not-member`.

**What overrides what:** this overrides any `me` label rule. A message sent without the person's yes must never look
like the person's own. **(lead's call)**

### S8. Creating, widening and ending

**Commands, kept in parity with MCP:**
- `agentcomms standing add <workspace> [--reactions eyes] [--replies-file <file>] --places threads-i-am-in|C…,C…
  [--per-thread 1] [--per-hour 10] [--per-day 30] [--expires 7d]`
- `agentcomms standing list`, `agentcomms standing revoke <id>`, `agentcomms standing off`
- MCP: `comms_standing` reports, narrows and revokes. Its `add`, and any widening, only prepares.

**Creating or widening one is a change approval with no shortcut (lead's call):**
- **Its `requiredPolicy` is `confirm`, and its claim needs `approvedVia` to be `'terminal'`, whatever the change
  policy.** So it always takes the code typed at a terminal (`approveChangeAtTerminal`): never a typed `yes`, never a
  client's form, never the `answered` shortcut.
- **The record is a new kind, `standing`,** treated as `change` is where approval is decided (`approvals.ts` ~1394).
- **An agent can prepare one over MCP.** The result says so and names the approve command. The preview then opens
  with "An agent proposed these contents and places. Check each one."
- **The preview shows** every content in full, with its digest and S3's warnings; every place by name, member count
  and whether another organisation shares it; the limits; and the expiry.

**Widening** means more contents, more places, higher limits or a later expiry. Replacing a text or a place is a
widening too, unless the result is a subset of what was approved. **(lead's call)**

**Ending them:** revoking or narrowing applies at once. `standing off` ends every one, at once.

**When they lapse (lead's call):** tightening the change policy ends every standing approval; `never` on an account's
send policy, or removing the account, ends that account's. So each record binds two epochs at creation: its account's
`sendEpoch`, and a new standing epoch that `standing off` and any tightening of the change policy raise. A record whose
epochs aren't the live ones has ended, and loosening again revives nothing.

### S9. Using one

**One operation, with no draft (lead's call):** `slack_ack` over MCP, `agent-slack ack` in the CLI, one row in
`capabilities.json`. It takes the workspace, the standing id, the target (`channel`, `ts`) and the content's digest,
and no `draftId`. The gate builds the payload itself from the content (escaped for Slack: `&`, `<`, `>`), the channel
and the thread, and binds the label into the digest.

**Each use mints a one-shot child approval (lead's call):**
1. **Before any lock, the Slack reads:** the target and its thread (S4), the place's members and shared state (S5),
   the label's route (S7), and spec 2's `allowedAct`.
2. **Under the account's acknowledgement ledger lock, then the standing record's** (the ledger needs its own, since
   `perThread` spans records, §3):
   - revocation, expiry, both epochs and every limit are checked again;
   - a clock earlier than the last act refuses, so moving it back frees nothing;
   - a target already in the ledger refuses;
   - the count is spent, the target written to the ledger, and a child `send` approval minted: already approved, with
     the standing id as its evidence, bound to the payload's digest and the send epoch, usable once, within minutes.
3. **The newest-message check is read once more** just before the claim, since it is one call.
4. **The child takes the unchanged path:** `claimForSend`, the fence and `claimOrHandOver`, where spec 2's rules are
   checked again. A second claim is refused.

**A count is never refunded,** even when a check refuses after the mint, or the act ends `SEND_OUTCOME_UNKNOWN`.

**The records live with the others.** A 30-day record fits no lifetime the store knows (§3). So
`approval-validate.ts` gives the `standing` kind and its children lifetime profiles of their own, as it does a
download's, and `ensurePruned` keeps an active standing record until it ends, then 90 days.

### S10. Seeing what it did

**Visibility doesn't rest on the agent (lead's call).** Each act raises a best-effort notification on the person's
screen: macOS `display notification` through `osascript`, Linux `notify-send`, Windows a toast through PowerShell.
- The programs are named as `system-programs.ts` names them. The text says what was sent, where and under which
  standing approval, and goes as an argument, never spliced into a script.
- A failed notification never fails the act; the audit notes it.

**The audit** records every act: the standing id, the child's id, the content's digest, the place, the time, and **the
digest of the acknowledged message's text and its `edited` state at that moment (lead's call).** A message edited after
its acknowledgement then shows as edited since.

**The list and the doctor:** `agentcomms standing list` shows each approval's uses today and its last 10 acts with
links. `doctor` lists active standing approvals and when they expire.

**A standing id is not a capability (lead's call).** Any agent on the machine can list the ids. What protects is S3 to
S7 and the limits.

### S11. What doesn't change

- Every other act still needs the person's yes to its exact content.
- Mail, top-level posts, edits, deletes, files and reaction removals can't be sent without asking.
- The untrusted-content envelope and the HTML sanitiser are untouched.
- No new send path: the child goes through Slack's existing claim and execute.

## 6. Tests (all with Slack's loopback fake; nothing reaches Slack)

**Contents (S3):**
- Refused: a text with a placeholder, a link, a mention or markup; more than 5 contents; a text over 200 characters; a
  custom emoji; a content named by position, or by a digest the approval doesn't hold.
- With no `--reactions`, the approval holds `eyes` alone. An emoji that reads as approval gets a preview warning.

**Send policy (S2):** under `never` a standing act is refused; under `confirm` it goes with no code; under `chat` the
standing path refuses what S4 to S6 refuse.

**Which messages (S4):** refused:
- a message older than the approval or than 15 minutes, or not the newest from someone else in its thread or channel;
- a thread already acknowledged under another standing approval;
- on the message or its parent, each allow-list failure: `bot_id`, `app_id`, `bot_profile`, any `subtype`, a `user`
  not beginning `U` or `W`, `users.info` saying bot, `USLACKBOT`, this account, the app-posts record;
- a message with a button or a select, or from a workflow.

A thread the person started may be acknowledged; one whose parent this product sent as them (in the audit, however
old, or in the app-posts record), or an app made with their token, may not.

**Places (S5):**
- A top-level reply is refused.
- Under `threads-i-am-in`, a thread doesn't count when the person's only message there was this product's (app-posts
  record or audit), when it only mentions the person, or when their message is older than 14 days. A reaction outside
  a qualifying thread is refused.
- 50 or more members, not named exactly, refuses; so does an unreadable count. A group DM's members are counted. A
  place named exactly is allowed with its count in the preview, and refused once it has reached 50 since.
- A member with another `team_id`, or `is_stranger`, refuses, and so do `is_ext_shared` and `is_pending_ext_shared`;
  `is_org_shared` alone doesn't. An exactly named channel whose shared state changed is refused.

**Limits and counting (S6, S9):**
- Each of per thread, per hour and per day is reached and refused, with the time it frees.
- Two concurrent uses can't both take the last count, nor acknowledge one thread under two approvals.
- `SEND_OUTCOME_UNKNOWN` keeps the count spent; a clock behind the last act refuses; a child's second claim is refused.
- The standing send takes no `draftId`, its payload is escaped, and a different label gives a different digest.
- A standing record survives `ensurePruned` for its 30 days and passes `approval-validate.ts`; one with any other
  lifetime fails it.

**Expiry and ending (S8):** an expired or revoked approval is refused at execute, even after the agent picked it.
`standing off`, or tightening the change policy, ends every one; `never` ends the account's; loosening revives none.

**Who approves (S8):**
- Under the `chat` change policy, an `add` can't be completed by a typed `yes`, by `answered`, or by a client's form.
  Only `approve <id>`, with its code, completes it.
- An `add` prepared over MCP says so in its preview.
- Widening asks again, as does replacing a text or a place with one outside the old set. Narrowing applies at once.

**Identity (S7):** a reply goes as the app or labelled, overriding a `me` rule. A reaction is refused wherever it would
go as the person (a DM, a group DM, a room the app isn't in, `labelled` style, no bot token), and so is a removal. A
reaction in a public channel the app has not joined, or whose membership can't be read, is refused before the mint,
`app-not-member`, with nothing counted.

**Spec 2 (T9):** a rule that forbids `reply` or `reaction` refuses the standing act, before the mint and at execute.

**Seeing it (S10):** each act raises a notification through an injected runner, with each platform's program and its
text as an argument; a notifier that fails or is missing leaves the act done. The audit holds the target's text digest
and `edited` state, and `standing list` and `doctor` show the acts.

**The rest:** the parity rows, the guards, and Windows-safe tests.

## 7. Out of scope

- A user-presence check from the operating system (Touch ID, Windows Hello) for creating or widening one. Future work,
  and the one thing that would reach the shell agent §4 leaves out.
- Mail.
- Agent-written text.
- Placeholders.
- Custom workspace emoji.
- Anything an organisation sets.
- Events-service rules that send by themselves. Those would use standing approvals, in a later design.

## 8. Settled while planning (2026-10-19)

Writing the plan (`docs/superpowers/plans/2026-10-19-standing-approvals.md`) against the code turned up six points.
Each is settled here, and where this section and S1 to S11 differ, this section is the later word. **(lead's call)**

1. **Creating one is Slack's command.**
   - Core has no Slack client, but the preview must show each place's name, member count and sharing. So creating and
     widening are `agent-slack standing add` and `slack_standing_add`, with `--replaces <id>` for a widening.
   - Core keeps `agentcomms standing list|narrow|revoke|off` and `comms_standing`.
   - The forced terminal-code approval (S8) is the same, whichever CLI asks for it.
2. **Narrowing has a CLI command,** `agentcomms standing narrow`, so it matches the MCP side.
3. **One refusal code, `STANDING_REFUSED`** (exit 10), with a fixed list of reasons, covers refusals under S4, S5 and
   S7. `STANDING_LIMIT` stays for the limits.
4. **The emoji allowed are a curated list** of 30 standard names, shipped in the code. Ten of them carry the
   reads-as-approval warning.
5. **A child send binds the standing epoch** as well as the send epoch. `standing off`, and revoking a standing
   approval, revoke its unused children.
6. **The notification text on Windows goes in through environment variables,** read by a fixed script, because
   PowerShell's `-Command` joins trailing arguments into the script. It is never spliced in.

## 9. Settled after build (2026-10-19)

Integrating the build turned up three more points. Each is the lead's call, and where this section and the ones above
differ, this section is the later word.

1. **A thread the person started may be acknowledged** (S4). Its parent may be the person's own message when this
   product did not send it; the message acknowledged is still another person's.
2. **A standing reaction needs the app in the conversation** (S7). Its membership is read before the mint, and a
   membership not found or not settled refuses with `app-not-member`, so nothing is counted for a reaction that could
   not have gone.
3. **The notice is core's** (S10). Its words are `ackNotice`'s alone, and a Slack context raises it with core's
   notifier for its platform (`makeNotifier`) unless it is given one. Tests inject a notifier or a runner, so none shows
   a real notification.

## 10. Settled after review (2026-10-19)

An independent review of the build, by a core reviewer and a Slack reviewer, found the points below. Each is settled
here as **(lead's call, after review)**, and where this section and the ones above differ, this section is the later
word.

1. **A change policy tightened by a release that knows no standing epoch still ends them** (S8; core review C1).
   0.22 can tighten a change policy and leave the standing epoch where it was. So the approval binds the change policy
   that governed its account when the person typed the code — its own, else the default — as `approvedChangePolicy`,
   written with `approvedAt` and checked by the validator: an approved standing record has one, and nothing else does.
   A live change policy stricter than it ends the record, `changePolicy-tightened`, with the reason "the change policy
   was tightened since this was approved", read from the configuration itself at every look, mint and claim, whatever
   the epoch says. Because a policy, unlike an epoch, can be loosened again, this is the one ending even a look writes
   down (`writtenAtALook`): `standing list`, the doctor and `comms_standing` write it as well as a use does. A
   loosening made before anything has looked at the record still revives it; nothing a 0.22 process does can be
   prevented by this release. The epoch stays the broader rule for this release's own writes: any tightening, of any
   account's policy or the default, ends every one. **(lead's call, after review)**
2. **A narrowing stops a use already reading Slack** (S8, S9; core review C2). The mint is given the channel and
   thread, and the kind of place its reads were checked against. Under the record's lock it requires the place to be
   covered by what is in force there: an exact place by its id, and `threads-i-am-in` only while the record is still
   `threads-i-am-in`. Otherwise `STANDING_REFUSED`, `place-not-covered`, before anything is counted. **(lead's call,
   after review)**
3. **A child is claimed only while its standing approval still covers it** (S9; core review C6). Each child now binds
   its use, `standingUse`: the channel, the thread and the digest of the content it sends. At the claim of any
   `route: 'standing'` child — in core's `claimForSend`, so every channel gets it — the standing record is read again,
   under its own lock while the child's is held (never the other way round), and the child is voided, APPROVAL_VOID,
   when the record has ended by any rule (revoked, expired, an epoch, a tightened change policy, `never`) or no longer
   holds the content or covers the place. The count stays spent. **(lead's call, after review)**
4. **A Linux notice is never read as markup** (S10; core review C5). Most notification servers read `notify-send`'s
   body, and some its title, as markup, so a reply holding `<b>` or a link would be drawn as one, and a stray `<` could
   blank the notice. On Linux both are given with `&`, `<` and `>` as entities (`asMarkupText`); macOS and Windows are
   given the words as they are. **(lead's call, after review)**
5. **`standing off` fails closed** (S8; core review C4). It revokes each standing record, and its unused children,
   first (`endStanding`), then raises the standing epoch; either alone ends every one. What it could not do while
   ending every one all the same is said in the result's `partial`, a sentence each, and in the audit. If any is still
   in force once both have been tried — a record that could not be written down, under an epoch that could not be
   raised — it is refused with the failure's code, naming each in `details.inForce`, so it exits non-zero and nobody
   is told they have all ended when they have not. **(lead's call, after review)**
6. **Every place name `comms_standing` returns is in the untrusted-content envelope** (S10; core review C3). A
   channel's name is whatever someone in the workspace called it, and a DM's is the other person's display name. The
   report — `comms_standing`, `standing list --json` and the doctor's reading of it — gives each, cut to 80
   characters, wrapped with `wrapUntrusted` (field `place-name`, the place's id), one boundary per report.
   `standing list` prints each envelope on lines of its own, as it is, so an agent reading the command's output reads
   it as quoted data too. **(lead's call, after review)**
7. **A wait reads a standing approval in its own words** (S8; core review C8). `comms_approval_wait` and
   `slack_approval_wait` called an approved standing record `blocked`, as if a policy kept it from being claimed; but
   nothing claims one. A wait on one now ends `active` once the person has approved it, and carries
   `standing: { state: 'pending' | 'active' | 'ended', reason? }`, read as `standing list` reads it (a live `never`
   ends it at a look). A pending one is waited on as before; an ended one ends `final`, with the store's reason.
   **(lead's call, after review)**
8. **An unreadable ledger line still fails closed, and is no longer silent** (S6, S10; core review C7). A line of an
   account's acknowledgement ledger that this release cannot read still refuses every use of that account's standing
   approvals, `BAD_DATA`, now with the line numbers in `details.lines`. The doctor adds a `standing ledger` warning for
   each such ledger, naming the account, its lines and the file, `<state>/standing/<accountId>.jsonl`. There is no
   repair command. The recovery is documented (core README, and the doctor's fix): the person ends that account's
   standing approvals with `standing off`, or `standing revoke` for each, then moves the file aside; a new ledger starts
   empty. **(lead's call, after review)**
