# Standing approvals: some messages sent without asking — design (spec 3)

Status: **written 2026-10-19**, for 0.23.0, after spec 2 ([agent behaviour rules](2026-10-19-agent-behaviour-rules-design.md)).

**What the owner asked:**
- On 2026-10-15: that some messages go without asking each time, acknowledgements especially.
- On 2026-10-19: "continue until all specs and plans are implemented", without further questions.

So every decision the owner did not state is marked **(lead's call)**.

**This design changes the product's first rule:** nothing is sent without the person's yes to its exact content. So it
carries its own threat model (§3), and every loosening it adds is approved the strongest way the product has (S6).

## 1. What was asked

The owner, 2026-10-15:

> Agents that listen and read information via Slack sometimes send acknowledgments back and then send responses back,
> but they send them as me, which is fine in most cases.

They also asked that sending some messages without asking be designed, after the behaviour rules. The agent label
design (§1) recorded it this way:

> **Sending some messages without asking**, for example acknowledgements. It changes the rule that nothing is sent
> without the person's yes to its exact content, so it needs a threat model of its own.

## 2. The idea in one paragraph

**A standing approval** is the person's yes given in advance. It covers:
- an exact set of contents, written by the person: reactions, or short fixed texts;
- a bounded set of places;
- a bounded number of uses;
- a time limit.

**What the agent chooses, and what it doesn't:** within a standing approval, the agent picks **which** pre-approved
content, and **where** among the allowed places. It never writes the words. Every such act is labelled as the agent's,
audited, counted and listed. The person can end every standing approval at once with one command.

**How this squares with the first rule:** the person still approved the exact content. What they gave up is approving
the moment and the exact place, within limits they set.

## 3. Threat model

**Who might attack, and what they can do:**
- **Anyone who can put text in front of the agent:** a Slack message, a channel topic, a file name, an email. Such text
  can try to make the agent act (prompt injection). Today the person's yes on every preview is the defence. Under a
  standing approval that defence is gone, for the acts it covers.
- **A confused agent,** with no attacker at all: loops, repeats, the wrong thread.
- **Another agent or bot** answering ours: acknowledgement loops.

| # | Threat | What it would cost | Mitigation |
|---|---|---|---|
| T1 | Injected text makes the agent send words of the attacker's choosing | impersonation, data leak | **No free text.** Content is chosen from the person's fixed list, with no placeholders filled from anything the agent read (S2). |
| T2 | Injected text leaks data by choosing which content or where (a covert channel) | a few bits per act | Only places where the conversation already is (S3), low use counts (S4), and every act audited and visible (S7). The residual is a few bits per hour, accepted. |
| T3 | Messages go to new people or places: spam, or a wrong-recipient leak | reputation | Only in conversations the person is already part of, and in threads, never top-level, unless the place is named exactly. No DMs to people the person hasn't talked to. No @channel, @here or mentions (S3). |
| T4 | Volume: loops with another bot, or a flood | reputation, rate limits | At most once per thread per approval, plus an hourly and a daily cap (S4). Never in answer to a bot or app message (S3). |
| T5 | Being taken for the person ("Got it" read as their promise) | reputation | Always labelled as the agent, with the label forced on whatever the label rules say (S5). The texts are the person's own words for acknowledging. |
| T6 | An agent creates or widens a standing approval by persuading the person in a chat | the whole feature | Creating or widening one is approved **only at a terminal, by typed code**, under any change policy. Never by a yes in a chat (S6). |
| T7 | A standing approval outlives its purpose | drift | It expires after at most 30 days, 7 by default. The person can revoke it at once, and switching every one off at once is one command (S6). |
| T8 | Edits, deletes, files or mail out of reach of the yes | irreversible harm | Not coverable: a standing approval covers only Slack reactions and Slack thread replies (S1). |
| T9 | The behaviour rules (spec 2) are bypassed | the boundary | Every act is still checked by `allowedAct` at execute. A standing approval never allows what a rule forbids. |
| T10 | Approval records tampered with on disk | forged acts | Records live in the approvals store with its existing integrity rules. Each act re-checks the record, counts and expiry under the approvals lock. |

**Out of reach, and accepted:** an attacker who can already write to the person's configuration directory or run
code as them. That is true of the whole product.

## 4. Decisions

### S1. What a standing approval may cover (lead's call)

**In 0.23.0, two Slack acts only:**
- `reaction`, from a fixed list of emoji;
- `reply`, in a thread, from a fixed list of texts, each at most 200 characters.

**Out of 0.23.0:** mail, posts, edits, deletes and files. Mail goes outside the organisation and cannot be taken back,
and the owner's example was Slack. Mail can be a later design, starting from this one.

### S2. Contents

**What the person writes:**
- `reactions`: emoji names, at most 5, such as `eyes`, `white_check_mark` or `thumbsup`.
- `replies`: fixed texts, at most 5, each at most 200 characters, as the person writes them, such as "Got it, I'll look
  at this and come back to you."

**What a text may contain:**
- No placeholders, no links, no mentions (`<@…>`, `<!…>`) and no markup beyond plain text. Each is checked when the
  approval is created.
- The agent label prefix is added as for every labelled post (S5).

### S3. Places

A standing approval names its places in one of two ways:
- **Exact channels or DMs** (`C…`, `G…`, `D…`). There, a `reaction` may go on any message, and a `reply` in any thread.
- **Or `threads-i-am-in`, in one workspace.** A thread counts when the person has posted in it, or when a message in
  it mentions the person.

**Never:**
- a top-level post;
- a message in answer to a bot or app message, meaning one with `bot_id`, a `subtype` of `bot_message`, or this
  account's own app;
- a thread in a channel with 50 or more members. This is the existing big-room rule, under which a post always needs
  the terminal.
- a Slack Connect channel shared with another organisation, unless named exactly. **(lead's call)**

**On top of all this,** spec 2's rules apply: an approval cannot reach where `reply` or `reaction` is not allowed.

### S4. Limits

**Each standing approval has:**
- `perThread`: 1 by default, at most 3. It counts acts per thread or message.
- `perHour`: 10 by default, at most 30.
- `perDay`: 30 by default, at most 100.
- `expires`: 7 days by default, at most 30.

**Enforcement:** counts are checked and taken under the approvals lock, at execute. Hitting a limit refuses the act
with `STANDING_LIMIT`, saying which limit and when it frees. It is never queued.

### S5. Identity

**Every act under a standing approval goes out as the agent:**
- through the app where the workspace has its bot token and its style is `app`;
- otherwise labelled, "Name (agent): …".

**What overrides what:** this overrides any `me` label rule. A message sent without the person's yes must never look
like the person's own. **(lead's call)**

### S6. Creating, widening and ending

**Commands, kept in parity with MCP:**
- `agentcomms standing add <workspace> --reactions eyes,white_check_mark --replies-file <file> --places
  threads-i-am-in|C…,C… [--per-thread 1] [--per-hour 10] [--per-day 30] [--expires 7d]`
- `agentcomms standing list`
- `agentcomms standing revoke <id>`
- `agentcomms standing off`
- MCP: `comms_standing` reports and revokes, and its `add` only prepares.

**Creating or widening one:**
- **Always approved by a code typed at a terminal,** whatever the change policy. An agent can prepare one over MCP;
  the result says so and names the approve command. A yes in a chat never creates one.
- Widening means more contents, more places, higher limits or a later expiry.
- The preview shows every content in full, every place by name, the limits and the expiry.

**Ending them:** revoking or narrowing applies at once. `standing off` ends every one, at once.

**When they lapse:** a standing approval also lapses when the account's send policy is `never`, when the account is
removed, or when the person's change policy is changed.

### S7. Using one, and seeing what it did

**How an agent uses one:** `slack_react_send` and `slack_post_send` take `standing: <id>` in place of `approvalId`.
- Slack's send gate checks, under the approvals lock, that the record exists, isn't expired and holds this exact
  content.
- It also checks the place (S3), spec 2's rules and the limits (S4). Then it counts the act and sends it through the
  existing send path.
- No new send path is added.

**The audit:** every act is audited with the approval id, the content index, the place and the time.
- `agentcomms standing list` shows, for each approval, its uses today and the last 10 acts with links.
- `doctor` lists active standing approvals and when they expire.

**The first use** of a standing approval in a session adds one line to that result: `sent without asking under
standing approval sa_… (expires …)`. The agent passes it to the person.

### S8. What doesn't change

- Every other act still needs the person's yes to its exact content.
- Mail, posts, edits, deletes and files can't be sent without asking.
- The untrusted-content envelope and the HTML sanitiser are untouched.

## 5. Tests (all with Slack's loopback fake; nothing reaches Slack)

**Contents (S2):**
- A text with a placeholder, a link, a mention or markup is refused.
- More than 5 contents, or a text over 200 characters, is refused.

**Places (S3):**
- A top-level post is refused, and so is a thread whose parent is a bot's.
- A big room is refused, and so is a Slack Connect channel that isn't named exactly.
- A thread the person isn't in is refused under `threads-i-am-in`.

**Limits (S4):**
- Each of per thread, per hour and per day is reached and refused, with the time it frees.
- Two concurrent uses can't both take the last count.

**Expiry and revocation:**
- An expired or revoked approval is refused at execute, even after the agent has picked it.
- `standing off` ends every approval at once.

**Who approves (S6):**
- An `add` over MCP, or under the chat change policy, cannot be completed in a chat. Only `approve <id>`, with its
  code, completes it.
- Widening asks again. Narrowing applies at once.

**Identity (S5):** a `me` label rule is overridden, and the act is labelled or goes as the app.

**Spec 2 (T9):** a rule that forbids `reply` refuses a standing reply.

**The audit:** each act is recorded, and `standing list` shows them.

**The rest:** the parity rows, the guards, and Windows-safe tests.

## 6. Out of scope

- Mail.
- Agent-written text.
- Placeholders.
- Anything an organisation sets.
- Events-service rules that send by themselves. Those would use standing approvals, in a later design.
