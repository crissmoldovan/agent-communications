# Sending and approvals

An agent using this package cannot send mail without your approval. This page says how that is enforced, and what
it does not cover. It is about Gmail; Slack's gate — messages, files, reactions, edits and deletions — is described in the
[`slack-posting` skill](../skills/slack-posting/SKILL.md) and in [What is where](architecture.md#how-a-slack-post-is-gated).
A Slack post's files come from the same folders as a Gmail draft's attachments: see
[the attachment rule](../skills/gmail-attachments/references/jail.md).

## Why it is in code

No Gmail scope separates drafting from sending. `gmail.compose` and `gmail.modify` both permit `drafts.send`, so
the permission you grant on the consent screen cannot express "may write, may not send". If the guarantee is going
to exist at all, it has to be enforced by the software.

That makes the honest claim narrow, and worth stating before the mechanism: **this package will not send without an
approval.** It is not a claim about your machine.

## The three steps

```
draft ──► send prepare ──► you read the preview ──► send execute ──► sent
             │                                          │
             │ records an approval bound to:            │ re-reads the draft and
             │   · a digest of what a recipient sees    │ refuses if either moved
             │   · the draft's Gmail message id         │
```

```bash
agent-gmail draft new --inbox acme/gmail --to sam@example.com --subject 'Tuesday' --text 'Works for me.'
agent-gmail send prepare --inbox acme/gmail --draft <draftId>     # prints the preview, sends nothing
agent-gmail send execute --inbox acme/gmail --draft <draftId> --approval <approvalId> --expect-to sam@example.com
```

**`prepare` sends nothing.** It reads the draft, refuses it outright if an agent could not have written it, and
records an approval. The preview it prints is the message as a recipient would receive it — decoded, so what you
read is what they read.

**`execute` re-reads the draft** and checks it against the record. The Gmail message id changes on every save, so
any edit after the preview voids the approval. The approval is single-use, claimed with an exclusive marker so two
processes cannot both spend it. It is never retried at any layer: a retried send may deliver twice and nothing here
could tell.

**You must pass what you believe you are sending.** `--expect-to` and friends are checked against the draft. If
they disagree, nothing is sent.

## Policies

Each mailbox has one. `agent-gmail inbox list` shows it.

| Policy | What it takes | When to use it |
|---|---|---|
| `chat` (default) | your yes in the conversation, within ten minutes of the prepare | an agent you are watching |
| `confirm` | a code typed at a terminal, or into a form from a client you chose to trust with approval forms, within thirty minutes; once you approve, the agent has 24 hours to send it | an agent you are not watching — with the change policy `confirm` too (`agentcomms policy confirm`) |
| `never` | nothing sends; the draft waits in Gmail | mailboxes an agent should never speak for |

Changing a policy to something weaker is a loosening, and a loosening is a change you approve: the command, or
`gmail_inbox_policy` from chat, shows you exactly what would change and does nothing until the approval it returns
is claimed. How that is approved is the mailbox's **change policy**. Under `chat`, the default, the agent claims it
after your yes in the conversation, and nothing can check that you said it. Under `confirm` it cannot be claimed
until you have typed the code at a terminal with the approve command the result gives.
`agent-gmail inbox policy <alias> --change confirm` sets it, and moving it back to `chat` is itself approved at a
terminal. Making a policy stricter needs nobody — `agent-gmail inbox policy <alias> --send confirm`, or the same
change from chat.

Setting a mailbox to `never` revokes every send waiting on it at once, and the change says which (`fenced`: what it
revoked, what was already being sent, what it could not revoke). Setting it back to `chat` or `confirm` later revives
none of them: each reads "revoked: sending was turned off since this was prepared (policy: never)" for good. A send
already under way when the policy changed is not recalled; the change lists it.

### Risk escalation

A `chat` send is raised to `confirm` on its own when the recipient looks like a mistake waiting to happen:

- an address that arrived in mail read this week and has never been written to before — the exact address, inside
  or outside your organisation; a domain seen in mail escalates only a recipient outside this mailbox's own domains,
  so a colleague on your own domain is never escalated by the domain alone
- an attachment going to an external recipient for the first time
- a domain within two characters of one this mailbox writes to regularly

"Never written to" is checked against Sent: up to 50 matches for each recipient, and 200 requests for one prepare
across all of them. Where that ran out, or Gmail could not be asked, the preview says so and the escalation stays.
The preview says why an address escalated using only what was recorded: the mailboxes it was seen in within the last
seven days, when most recently, and whether it was ever in a header.

## Two guards under all of it

**One path.** Exactly one function calls Gmail's send endpoint. `test/send-path.test.mjs` fails the build if a
second appears.

**A guard beneath that.** The HTTP client refuses any request whose path ends `/send` without a one-shot permit
naming that draft, and refuses batch endpoints outright. A `messages.send` added anywhere in the package fails at
the request, not at review.

## How long an approval lasts

| The approval | Lasts | Then |
|---|---|---|
| waiting for a yes in the chat (route `chat`) | ten minutes from the prepare | expired |
| waiting for you outside the chat (route `confirm`: the policy, or escalation) | thirty minutes from the prepare | expired |
| approved by you at a terminal or in a form | 24 hours from your approval, to be used once | expired, unused |
| a download's question of where to save | thirty minutes from when it was asked, answered or not | expired |

Changes — a looser policy, a client added, a server registered — follow the same rule by their change policy: ten
minutes for a yes in the chat, thirty at a terminal, then 24 hours. An approval that expired says exactly that: "this
approval expired; nothing was sent with it", with when it was prepared, or approved, and when it expired. Prepare it
again; the preview is the full one.

**A no is revoked by the agent.** The server cannot hear what you say in the conversation. When you say no, the
skills tell the agent to revoke the approval at once (`gmail_send_cancel`, `comms_approval_revoke`); if it does not,
an approval waiting for a yes in the chat can still be used for the rest of its ten minutes. That window is why the
chat route stays at ten.

## How an agent learns that you approved

An agent learns that a person approved by waiting, not by being told: `gmail_send_wait` (`agent-gmail send wait`),
`slack_approval_wait` (`agent-slack approval wait`), `resend_send_wait` (`agent-resend send wait`) and
`comms_approval_wait` (`agentcomms approval wait`) each say where an approval stands — 30 seconds by default, 300 at
most, and `--wait-seconds 0` for the status now — and never approve, claim or send. The skills use repeated
default-length waits, because some clients move a long call into the background. A wait returns as soon as the
approval can be used, and every refusal that sends you to a terminal names the wait beside the command.

Every send, status and list result says where its approval stands, as `approval`: its `state` (`pending`, `approved`,
`sending`, `used`, `failed`, `unknown`, `expired`, `revoked`, or `corrupt` for a record that failed its integrity
check), whether it can be used now (`claimable`), its `route`, and the times that apply.

## What a send says happened

- **Sent.** "sent, message id …", with Gmail's id and a read-back of where it landed. When Gmail accepted it without
  an id, exactly "sent; the provider returned no id" — never an id made up.
- **Nothing was sent.** A refusal before the send, or one Gmail gave for certain: "nothing was sent: …".
- **Being sent by another call.** "being sent by another call since …; wait for it" (`APPROVAL_PENDING`): another
  process holds the send, renewing a two-minute lease every thirty seconds. Nobody prepares it again meanwhile.
- **Not known.** `SEND_OUTCOME_UNKNOWN` (exit `10`, never retryable): Gmail's answer was lost, so it may have sent. The
  approval reads `sending`, then `unknown` once the lease runs out — and the process that sent it may still record a
  late result. Look in Sent before anything else; the skills never prepare it again automatically.

## Did it go?

`agent-gmail send list` (`gmail_send_list`) returns `{ approvals, unsent }`: every approval, and in `unsent` the
drafts from the last seven days whose newest approval expired. Each says only what the approval records it read can
prove:

- "not sent with any approval in the last 90 days" — when every retained record was read;
- "not sent with any of the 500 most recently changed approval records" — when there were more than it reads;
- "indeterminate (…)" — when a record could not be read, was busy, or the report ran out of time.

Beside that it looks the draft up in Gmail: "still in Drafts", or "no longer in Drafts — it may have been sent or
deleted elsewhere". `draft show`, `draft list` and `doctor` say the same; Slack's `draft list` says it of each
draft's current revision. None of them creates, sends or deletes anything, and none says "never sent": approval
records cannot see what another Gmail client did.

## How long records are kept

A finished approval — used, failed, revoked, expired, or ended `unknown` — is deleted 90 days after it finished, with
an `approval.retained` line in the audit log first. The pruning runs in one bounded batch a day, at most 200 records,
when something next uses approvals: a call may take up to 5 seconds once a day for it. Records still waiting, being
sent, or that cannot be read are kept.

## Approvals

Where Gmail is installed globally:

```bash
agent-gmail send list --inbox acme/gmail        # every approval, and the drafts it can say were not sent
agent-gmail send wait <approvalId>        # where one stands, now or once it changes: it only looks
agent-gmail send cancel <approvalId>      # void one
agent-gmail approve <approvalId>          # approve at this terminal, under `confirm`: the command the result gives
```

To approve, run the command the result gave you exactly as given: it names this installation's own Node and CLI
file, with its folders pinned, so it works without anything on your PATH and approves the very approval the agent
holds. On Windows with Node under `C:\Program Files` it comes as words to type, each quoted for your shell; where it
says the command is not locatable here, install or update that package the way you usually do and try again
([troubleshooting](troubleshooting.md#a-command-a-result-gave-you-is-not-found)). It shows the preview once — that is
the approval — and sends nothing: the agent, waiting, sends it.

An approval left lying around is one somebody can still act on, so cancelling is never refused.

## What this does not protect you from

Stated plainly, because a security claim that overstates itself is worse than one that does not try.

- **An agent with a shell** can read your tokens, run this CLI, drive a pseudo-terminal, or call Gmail directly. No
  MCP server can stop that. `confirm` with a trusted client, or `never`, is the answer — with the change policy
  `confirm` too (`agentcomms policy confirm`), or the agent can move the mailbox back to `chat` on its own say-so.
- **An agent you do not watch, under the default `chat` change policy.** The software cannot tell your yes from an
  agent's, so such an agent can loosen a mailbox from `confirm` or `never` to `chat`, move credentials out of the
  keychain, or remove an account, each on its own claim — and every one of those is in the audit log. Set
  `agentcomms policy confirm` for an agent you are not watching.
- **Another Gmail MCP server** installed beside this one. Everything above assumes it owns the only route to
  Gmail's send endpoints. A second server with an ungated send tool does not break the guarantee so much as stand
  beside it — an agent simply uses the other one. `doctor` lists any it can find, in every client config it can
  read.
- **You approving without reading.** The preview exists to be read. A gate that is always waved through is worse
  than no gate, because it produces confidence rather than safety.
- **Mail already sent.** There is no recall. The 72-hour undo in Gmail's web client is a client-side delay, not an
  API.
- **An approved send for 24 hours.** Once you approve at a terminal, any process on this machine that shares the
  approval store can send exactly that message, once, for 24 hours. A process running as you is outside the boundary
  anyway (the first point above); inside it, whoever claims the approval sends what you approved and nothing else.
  Revoke it if you change your mind.
- **A "no" the agent never passes on.** It is invisible to the server; an approval waiting for a yes in the chat can
  be used for the rest of its ten minutes unless the agent revokes it.
- **A send that may have gone.** When Gmail's answer is lost the outcome is unknown, and stays so until Sent is
  checked; the sending process may still record a late result.
- **A form in a fresh Claude Code.** No MCP mechanism proves a person, rather than the client, answered a form, so an
  untrusted client sends you to a terminal; the agent waits there.
