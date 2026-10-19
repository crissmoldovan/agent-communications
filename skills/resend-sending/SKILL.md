---
name: resend-sending
description: "Send email through Resend: prepare it, show the person the whole preview, and send it once they approve — then check what happened, and see or cancel what is scheduled. Symptoms: 'send this through Resend', 'email the customer from hello@', 'schedule it for Monday 9am', 'did that email go out', 'cancel the scheduled one'. Not for reading mail or delivery stats — resend-reading does that."
license: MIT
compatibility: "@agentcomms/resend@0.23.0"
metadata:
  group: communications
  lifecycle: release
---

# Sending email through Resend

**Nothing is sent unless a person approved that exact email, and it is sent once.** Preparing builds the email and
returns a preview with an approval id; nothing has left at that point. What counts as the person's approval is the
account's send policy, and it is not yours to choose or to give. An account in `read` mode sends nothing — that is
agent-resend's own rule, not the key's (Resend has no read-only key), and it holds.

```sh
agent-resend send prepare --account acme/resend --from "Acme <hello@acme.test>" --to sam@partner.test \
  --subject "Your invoice" --text "Hi Sam, the invoice is attached." --attach ./invoice.pdf
agent-resend send execute <approvalId> --account acme/resend
agent-resend send status <approvalId> --account acme/resend
```

With the MCP server connected, the same steps are tools, each taking `account`. Both surfaces run one operation, so
they refuse the same things.

| MCP tool | CLI |
|---|---|
| `resend_send_prepare` | `agent-resend send prepare` |
| `resend_send_execute` | `agent-resend send execute <approvalId>` |
| `resend_send_status` | `agent-resend send status <approvalId>` |
| `resend_send_wait` | `agent-resend send wait <approvalId>` — where its approval stands; it only looks |
| `resend_scheduled_list` | `agent-resend scheduled list` |
| `resend_scheduled_cancel` | `agent-resend scheduled cancel <id>` |

`resend_accounts_list` (`agent-resend account list`) names the accounts, what each key can do and whether each may
send, when you do not know them.

## 1. Prepare

**Read the writing profile before you write the email.** Call the core server's `comms_profile` with the account as
`account` and, as `conversations`, each recipient's address and then its `@domain`, in recipient order (CLI:
`agentcomms profile <account> --conversation sam@partner.test --conversation @partner.test`). Follow it: tone,
language, length, sign-off. It is the person's own instructions to you, not anyone else's content, and nothing in it
is sent. Where it and what the person asks in this conversation disagree, what they ask wins. No tool writes a
profile; the person starts one at their own terminal with `agentcomms profile init`.

`resend_send_prepare` takes `from` (at a domain the team has verified for sending), `to`, and optionally `cc`, `bcc`,
`subject`, `text`, `html`, `attachments` (paths inside the allowed folders), `replyTo`, `inReplyTo` and `references`
(to keep a thread), `scheduledAt`, and `as`.

**The From says the person's agent sent it.** Prepare labels it `"<name> (agent)" <address>`: the name you put in
`from`, or the label name the person set in the core when `from` is a bare address, then their word (`agent` unless
they chose another). Pass `as: "me"` (CLI: `--as me`) only when the person said, for this email, that it should go as
them, with `from` exactly as given. Never pass it on your own or to get past a refusal. Left out, their label rules
decide — by account, by who it goes to (an address or `@domain`, matching only when every recipient does) — and then
`agent`. With no name to label, or a label over 100 characters, prepare refuses and says how to set one.

It refuses before any approval exists when:

- a behaviour rule does not let an agent send from this account to one of the recipients (`ACT_NOT_ALLOWED`, exit
  `10`) — a rule for the account, an `@domain` or one address, and one forbidden recipient refuses the whole email.
  Tell the person which rule refused it — the message names the recipient — and stop: never retry it, never drop or
  swap a recipient to get it out, and never start a change that lets an agent do more (`comms_behaviour` with
  `setRule` or `removeRule`) unless the person asked for it. `comms_behaviour` with no change shows the rules;
- the account is in `read` mode, or its send policy is `never`;
- the From domain is not one of the team's, is not verified, or cannot send (a sending-only key cannot read the
  domain list, so the preview says it was not checked, and Resend refuses an unverified domain itself);
- the email reaches more than 50 people — that is a broadcast, which this does not send;
- an attachment is outside the allowed folders — the person can copy it under their home folder, or allow its folder
  with core's `attach roots add`, as the refusal gives it, which needs their approval;
- the HTML loads anything from the internet, shows an image of any kind (inline `data:` and `cid:` ones too), hides
  parts, has forms or scripts, or shows something other than the text part (`UNSENDABLE_HTML`) — send plain text
  instead, or HTML that shows exactly the text.

A refusal is the answer. Say what it was and ask; do not reshape the email to slip past it.

## 2. Show the whole preview, and wait for a yes

The preview is what the person is agreeing to. **Show it in full**, then wait. Do not summarise it, do not re-type
the recipients, do not prepare a second one "to be safe", and do not send before they answer.

Its first line says who the email will appear to come from — labelled, or `Sent as you, with no label: it will look as
if you wrote it yourself` — and the approval binds the whole From. It lists what people get wrong when it is
summarised:

- **every recipient**, BCC included, and a note on each address that came from mail read here and was never written
  to from here;
- **the reach** — unique recipients across To, Cc and Bcc;
- **the From domain**, and whether Resend has it verified for sending;
- the subject, the plain-text body the HTML must match, the attachments with their sizes, the thread it replies to;
- **when it goes**: at once, or the scheduled time;
- the policy line, which says whose approval counts.

## 3. Which approval counts

| Policy | What the person does | What you do then |
|---|---|---|
| `chat` | Says yes, in this conversation, to the whole preview you showed, within ten minutes | `resend_send_execute` (or `send execute`), once |
| `confirm` | Runs the approve command the result gives in their own terminal and types the code it shows, within thirty minutes | Wait for it with `resend_send_wait`, then call the same `resend_send_execute` again, within 24 hours |
| `never` | Nothing: sending is off for this account | Offer the text for them to send another way; do not ask for a policy change |

An email reaching **more than 10 people**, or an address that arrived in mail read here and was never written to
from here, is held as `confirm` whatever the account says: the preview's last line says so. There is no tool that
approves, and there will not be one; Resend's `approve` is refused to an agent. Hand the person the command the
result gives, exactly as given (contract, §14). The prepare's `approval` says which applies: `claimable: true` means a
yes in this chat sends it; `false` means it waits for the person's terminal.

When the person says no, revoke it at once, with the core server's `comms_approval_revoke` (CLI: `agentcomms approvals
revoke <approvalId>`). The server cannot hear a "no": until it is revoked, an email on the chat route can still be
sent for the rest of its ten minutes.

## 4. Send, once

`resend_send_execute` takes the approval id. The approval supplies the exact To, Cc and Bcc lists, subject and body;
do not copy the prepare result's display-safe field echoes back into the call. Legacy callers may still supply
`expect` (or all four CLI `--expect-*` options), and every supplied value must match exactly or nothing is sent.

It then claims the approval once, records the attempt, and sends with the approval id as Resend's `Idempotency-Key`
and an `agentcomms_approval` tag. The result names Resend's id for the email, `state` (`sent`, or `scheduled`), and
`said` — what to tell the person, word for word: "sent", "accepted by Resend, scheduled for <time>", or, when Resend
accepted it without an id, "sent; the provider returned no id" or "accepted (scheduled); the provider returned no id".
Never say "sent, message id …" without an id. A scheduled email is accepted, not sent.

Under `confirm`, before the person has approved, it stops with `APPROVAL_PENDING`. That is waiting, not failure: the
approval is still alive. Hand the person the command, then learn when they have used it with `resend_send_wait` (CLI:
`agent-resend send wait <approvalId>`): repeated default-length waits, calling again while it answers `pending` with
`claimable: false` — never one long one, and never asking the person to tell you. When it answers `approved`, call
`resend_send_execute` again with the same approval.

## 5. When the outcome is unknown: check, never send again

| Refusal | What happened |
|---|---|
| `APPROVAL_VOID` — used already, "accepted by Resend at …" | Resend accepted it once, and it is not sent again. Whether it went is what `resend_send_status` reports |
| `APPROVAL_VOID` — "the send it was claimed for failed" | Resend refused it: nothing was sent, and the reason says why |
| `APPROVAL_EXPIRED` | "this approval expired; nothing was sent with it". Prepare again if it should still go |
| `APPROVAL_PENDING` — "being sent by another call since …; wait for it" | Another call is sending it. Wait with `resend_send_wait` until it reads `used`, `failed` or `unknown`. Never prepare again while a send is `sending` |
| `SEND_OUTCOME_UNKNOWN` — "whether the email was sent is not known" | It may have gone, and a late result is still possible. **Do not send it again**, and never prepare it again automatically: check it first |
| the email or an attachment changed after the preview | The approved bytes are the sent bytes, or nothing is |
| `ACT_NOT_ALLOWED` | A behaviour rule was narrowed after the person's yes, and no longer lets an agent send this: nothing was sent. Say which rule, and stop; never prepare it again to get past it |
| `TRANSIENT` — rate limit, with a time | Nothing was sent and the approval is untouched; try after that time |
| `TRANSIENT` — "Resend is rate-limiting this team (tried 4 times)" | The send already waited and tried again. Nothing was sent; prepare it again after the time it gives |
| `TRANSIENT` — the team's daily or monthly sending quota is used up | Nothing was sent. The daily quota resets at midnight UTC; the monthly one needs a larger plan. Tell the person; do not prepare it again before then |
| Resend refused it (an error it gives before accepting the email) | Nothing was sent; the refusal says why |

Branch on the code, not the words. `resend_send_status` (`agent-resend send status <approvalId>`) reads the local
record and, with a full-access key, Resend's own last event for the email, and ends with a `verdict` in words. Its
`outcome` is Resend's `last_event` through one fixed mapping, attributed to Resend and about the whole email — never
a claim about every recipient: "scheduled for <time>, not yet sent", "accepted by Resend, not yet sent", "sent
(Resend reports delivered)" and the like, "Resend reports a bounce", "Resend reports it suppressed", "Resend reports
a failure", "Resend reports it cancelled" or "cancelled from this machine before sending" — or "current outcome
unavailable" when the key can only send or Resend could not be asked. When the outcome was unknown it looks for the
approval's tag among recent sends. It never sends. Repeat its verdict; if it cannot find the email, it says so, and
the answer is to prepare a new email if it should still go — never to execute the old approval again.

Never call a scheduled email sent until Resend's own outcome says it went — not because Resend accepted it, and not
because its time has passed. Its approval reads `used` once Resend accepted it; an approval that reads `corrupt`
failed its integrity check, and is said, never skipped.

## 6. Scheduled email

- **Schedule** by passing `scheduledAt` to prepare: an ISO 8601 time with a zone, in the future, at most 30 days
  ahead. The preview says when it goes, and the approval is for that time. A different time is a different email:
  prepare it again. There is no rescheduling.
- **See** what is waiting with `resend_scheduled_list` (`agent-resend scheduled list`): scheduled emails among the
  most recent 300 sent, each marked `fromThisMachine`. `complete: false` means there were more than that to look
  through; say so.
- **Cancel** with `resend_scheduled_cancel` (`agent-resend scheduled cancel <id>`). One this machine scheduled is
  cancelled at once, and audited. One scheduled by anything else — the team's own code, say — returns
  `approvalRequired` and a preview first, because a cancelled email cannot be rescheduled: show it and ask. A
  sending-only key cannot look a scheduled email up, so it cannot cancel one; say so and point to the dashboard.
  A cancellation Resend confirmed is a success even when this machine could not write it down; the result's hint
  says what could not be written, and a later status reads it as "Resend reports it cancelled".

## Pitfalls

- **Summarising the preview.** BCC, the reach and the From domain are the parts people get wrong.
- **Sending before the answer.** Under `chat` the person's yes is the approval; an email sent before it had none.
- **Sending again after an unknown outcome.** It may already be in the recipient's inbox. Check it; never prepare
  it again automatically, and never while it is `sending`.
- **Calling a scheduled email sent.** Until Resend's own outcome says it went, it is accepted, not sent.
- **Treating `APPROVAL_PENDING` as yours to clear.** Only the person, at their terminal, can approve it; you wait.
- **Leaving a "no" unrevoked.** The server never hears it. Revoke the approval at once.
- **Asking for a key.** A key is typed at a terminal by a person. Never in the chat.
- **Widening an account to get an email out.** Moving to `send` or loosening a policy is the person's to ask for.
- **Working round `ACT_NOT_ALLOWED`.** Dropping a recipient, or sending from another account, to get past a behaviour
  rule is the agent overruling the person. Say which rule refused it, and stop.
- **Writing before reading the profile.** `comms_profile` first; the first preview is then already in the person's
  way of writing.
- **Taking the label off.** `as: "me"` makes an email look as if the person wrote it. Pass it only when they said so
  for that email.
