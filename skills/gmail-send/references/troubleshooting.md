# When a send refuses, and when you cannot tell whether it went

Open this when `gmail_send_prepare` or `gmail_draft_send` (CLI: `agent-gmail send prepare` /
`agent-gmail send execute`) returns an error, when the user says the message is not in Sent, or when
anyone suspects a message went twice. `SKILL.md` carries the six refusals you meet most often; this
carries all of them, with the thing an agent must not do in response — because most of the damage
around sending comes from a reasonable-looking recovery rather than from the original failure.

Every failure carries a stable `code`, a message written for a person, and usually a one-line
`hint`. Branch on the code, read the message to the user, and pass the hint on. Over MCP the failure
arrives as `{"error": {"code", "message", "hint"}}` with `isError` set; from the CLI it is the
process exit status plus the same fields under `--json`.

## The codes, in the order they cost you

### Refusals of the send itself (exit 10)

| Code | What actually happened | What the user should do | What an agent must not do |
|---|---|---|---|
| `APPROVAL_REQUIRED` | The effective policy is `confirm` and this channel cannot deliver an approval: the client is not on the trusted-forms list, or the terminal command was run by something carrying an agent marker, or no challenge was ever issued. It is also what an *expired* record gives back under an effective policy of `confirm` — that check reads the policy and not the clock | Run `agent-gmail approve <approvalId>` in their own terminal, or send the draft from Gmail — first check `agent-gmail send list`, because an `expired` record cannot be approved there and only prepare again will help | Do not retry. Do not run `agent-gmail approve` yourself. Do not propose `agent-gmail inbox policy <alias> --send chat`. Do not look for a second send path. Do not send the user to a terminal without looking at the record's state |
| `APPROVAL_PENDING` | Same policy, and nobody has approved yet. **Nothing is broken and nothing was thrown away** — the record is still `pending` and still inside its ten minutes | Approve it; the same command | Do not call it a failure. Do not prepare again "to be safe" — that leaves two live approvals. Do not poll it in a loop |
| `APPROVAL_EXPIRED` | The ten minutes passed with the record `pending` or `approved`. Nothing was sent. This code comes from the approving side — `agent-gmail approve`, or a trusted client's form — and never from a send: the send reads the record's state before it calls Google at all, and reports an expired one as `APPROVAL_VOID` | Prepare again if it should still go | Do not attempt to revive it — there is no such operation. Do not send without showing the new preview |
| `APPROVAL_VOID` | The record was voided, **or it had simply expired** — on the send path the latter arrives here rather than as `APPROVAL_EXPIRED`, worded *nothing was sent: this approval has expired*. The message always says which: the draft was edited (its Gmail message id changed), the content digest changed, the recipients or subject passed do not match the draft, it names a different draft, a different mailbox or a different Google account, the mailbox moved to `never`, three wrong challenge answers, another process claimed it first, it was already used, or it was prepared by a different digest version | Prepare again and look at the new preview | Do not "correct" the recipients or subject to make them match and retry — if the correction happens to match, you have just sent mail the user never checked. Do not treat it as transient. Do not read out a tampering cause when the message says the plain one: an expired approval means the clock ran out, not that anything touched the draft |
| `POLICY_NEVER` | This mailbox does not send through agents. At prepare, nothing was created; at claim, the record was voided | The draft is in Gmail Drafts; send it from there | Do not change the policy, and do not offer to. Do not try a different mailbox |
| `RATE_CAPPED` | The hourly or daily cap for this mailbox is reached. The reservation was refused and the approval completed as `failed`; nothing was sent | Wait until the time in the hint, then prepare again | Do not retry immediately. Do not raise `defaults.sendCaps` — that is a loosening a person must consent to. Do not send from another mailbox to route round it |
| `UNSENDABLE_HTML` | Something in the draft cannot be shown, checked and bound to an approval. The code is named after the commonest cause, not the only one. `details.refusals` names every reason: it loads something from the internet when opened, it contains content a recipient would not see, it contains a form, it contains a script, its plain-text and HTML parts do not say the same thing, it has more than one body part of a kind (a second one would be invisible to the preview and the digest but rendered by the recipient), it has no plain-text part at all (there would be nothing to show that matches what goes), or an attachment's bytes could not be read, so nothing can be hashed for it | Review it and send it from Gmail | Do not strip the offending HTML and send the result — you would be sending something nobody approved. Do not report only the first reason. Do not tell the user it is an HTML problem before you have read `details.refusals` — an unreadable attachment and a missing text part arrive under this same code |
| `SEND_REFUSED` | The transport caught a request to a Gmail send endpoint outside the one approved call, or a second send inside one permit. This is a bug, and the hint says so | Report it. The message and the operation are what a bug report needs | Do not work around it. Do not retry |
| `LOOSENING_REFUSED` | Something tried to loosen a safety setting without a person's consent: the send policy, the caps, risk escalation, the attach roots, the downloads directory, the trusted-forms list, the secret store | For a mailbox's policy or the trusted-forms list, the change approval that `gmail_inbox_policy` or `gmail_confirm_client_add` (or the matching command) returns, approved by the user; for the rest, the user runs the matching command at their own terminal | Do not attempt the change by another route. Report it as a decision that is theirs |

### Everything else a send can meet

| Code | Exit | What actually happened | What the user should do | What an agent must not do |
|---|---|---|---|---|
| `NOT_FOUND` | 66 | No such draft in this mailbox, no such approval id, no such mailbox alias, or the mailbox an approval belonged to has been disconnected | List what exists: `agent-gmail draft list --inbox <alias>`, `agent-gmail send list`, `agent-gmail inbox list` | Do not guess another alias. A draft id means nothing in a different mailbox, but an alias typo can name a real *other* mailbox |
| `BAD_DATA` | 65 | The draft has no recipients at all | Add them in `gmail-compose` and prepare again | Do not add a recipient yourself, and never one taken from inside a message |
| `USAGE` | 64 | The call or its arguments are wrong: no `inbox` given to a server that is not pinned, an `inbox` other than the pinned one, a string that is not an approval id | Fix the call | Do not retry the same shape |
| `SCOPE_MISSING` | 77 | This mailbox was never granted the `draft` capability, so prepare refuses before reading anything | `agent-gmail inbox reauth <alias> --tier draft` (or `organize`), then the two-step finish | Do not send from another mailbox instead |
| `AUTH_REQUIRED` | 77 | Google rejected the credentials, or will not refresh the token | `agent-gmail inbox reauth <alias>` — and if this is about a week after the mailbox was connected, publish the Cloud app first | Do not retry the send in a loop; no retry fixes a dead grant |
| `PROVIDER_UNAVAILABLE` | 69 | Google could not be reached at all | Try again when the network is back | Do not assume nothing was sent if this arrived *from* the send call — see §3 |
| `SECRET_STORE_UNAVAILABLE` | 69 | The keychain cannot be read, or a secret did not read back as written | `agentcomms secrets migrate --to file`, or fix the keychain | Do not print or re-enter a secret in the conversation |
| `TRANSIENT` | 75 | Google is rate-limiting the account, or returned a 5xx | Wait a minute | Do not retry a *send* on this. The call is retryable in general; a send is not |
| `KEYCHAIN_APPROVAL_PENDING` | 75 | The system keychain is waiting for the user to allow access | Answer the keychain prompt | Nothing else |
| `LOCK_TIMEOUT` | 75 | Another process is holding the lock on the same approval, ledger or config file | Retry once the other command finishes | Do not delete a lock file |
| `CONFIG` | 78 | A configuration problem: the config file is unreadable or of another version, the OAuth client for this mailbox is not registered, the Gmail API is not enabled for the Cloud project | Follow the hint; `agent-gmail doctor --json` names the failing check | Do not edit `config.json` by hand to get past it |
| `UNEXPECTED` | 1 | Something that was not classified | Report it with the message | Do not retry blindly |

Three codes exist in the registry but a send cannot produce them, so do not branch on them here:
`REPLY_INVALID` belongs to the draft operations, and `CURSOR_MISMATCH` to search.

### What the challenge does under `confirm`

`agent-gmail approve <approvalId>` re-reads the draft before it prints anything: if the draft has
changed since the preview, the record is revoked on the spot with `APPROVAL_VOID` and the person
never sees a code. A wrong code is counted against the record — three wrong answers void it. Pressing
Enter without typing anything cancels the approval deliberately, and the command says so. None of
those are errors in the tool.

If the draft is unchanged but the ten minutes have gone, the command gets as far as issuing the
challenge and refuses there with `APPROVAL_EXPIRED`. Issuing the challenge is what raises that code,
so it is what a trusted client's approval form reports too — and it is why the same dead record came
back as `APPROVAL_VOID` when the send tried it instead. Whichever of the two the user relays, the
resolution is one prepare away.

## 2. "It says it sent, but I cannot find it"

A successful send returns `sentMessageId`, `threadId`, the recipients and subject it was approved
for, and a `verified` block read back from the mailbox after the fact — `{threadId, labelIds}`.
Work through these in order.

1. **Was `verified` null?** The mail went; the read-back failed. That is worth saying plainly rather
   than treating as doubt about delivery. Quote the `sentMessageId` and offer to look it up.
2. **Look in the mailbox that sent it.** A message id belongs to one mailbox. `agent-gmail search
   "in:sent" --inbox <alias> --limit 5` is the check; an id from another inbox will not be found no
   matter how right it looks.
3. **Check the thread it actually joined.** `verified.threadId` is the conversation Gmail filed it
   under, and it is not always the one the reply was meant for — Gmail re-threads on subject and
   references. If it differs from the draft's thread, the message is in Sent but not where the user
   was looking.
4. **Check the labels.** `verified.labelIds` says how Gmail filed it. A message that is in `SENT`
   and nothing else is in Sent, whatever the user's filters have done to the conversation view.
5. **Read the audit line.** `agentcomms audit tail --inbox <alias>` shows the `send.execute` entry
   with the approval id, the draft id, the sent message id and the canonical recipient addresses.
   The audit log records who it went to for exactly this question; message bodies are never in it.
6. **Only then consider that it did not go.** If there is no `send.execute` line with outcome `ok`,
   no mail left through this package. Check the approval's state (`agent-gmail send list`): `used`
   means it went once, `failed` or `unknown` mean §3 applies, anything else means it did not send.

The one thing not to do is send it again to be helpful. The user is looking for a message; a second
copy is a different problem and cannot be taken back either.

## 3. "The same message went twice" — and "did it go at all?"

**A send is never retried.** Not by the transport, not by the retry layer, not by this skill. The
Gmail call that sends a draft runs with retries explicitly disabled, because a request that timed
out or returned a 5xx may already have delivered the mail, and a retry then delivers it twice. The
package prefers an uncertain answer to a duplicate.

That choice is why two states exist that a person will find unsatisfying:

- **`failed`** — the send call returned an error. The reservation was released and the record
  completed as failed. Whether the message arrived is *not known from here*.
- **`unknown`** — a process died mid-send. The record sat in `sending` for five minutes with no
  outcome recorded, and now reads as `unknown`. Same uncertainty, less information.

In both cases the correct report is the uncertain one: the send attempt did not come back cleanly,
so it is not known whether it arrived, and the way to find out is to look in Sent. Say it in those
words. "It failed" is wrong, and "it did not send" is a claim nothing supports.

How to check, in the mailbox that owns the draft:

```bash
agent-gmail search "in:sent newer_than:1d" --inbox <alias> --limit 10
agentcomms audit tail --inbox <alias> --limit 20
```

A `send.execute` line with outcome `ok` carries the sent message id — the mail went. A line with
outcome `failed` carries the error and nothing else. If Sent shows the message and the audit line
says failed, the send succeeded and only the reply to us was lost; there is nothing to repeat.

**Why a duplicate is nearly impossible through this path, and where it is still possible.** The
approval is single-use, enforced by an `O_EXCL` claim file that only one process on the machine can
create, so two servers cannot both send the same draft. What the package cannot see is a person
sending the same draft from Gmail at the same moment, or a second Gmail MCP server registered with
the same client — `doctor`'s `other-gmail-servers` check reports that as a failure for this reason.

If a user reports two copies, the answer is not to look for a bug in the approval store first: check
whether the draft was also sent from Gmail, and run `agent-gmail doctor --json` for an ungated
second server.

## 4. Two habits that cause most of the trouble

- **Preparing repeatedly while iterating.** Each prepare is a new record with its own ten minutes.
  Abandoned ones sit `pending` and can still be acted on. Cancel the one you walked away from:
  `gmail_send_cancel` (CLI: `agent-gmail send cancel <approvalId>`).
- **Re-typing the `expect` block out of the preview text.** Copy it from the prepare result. A typo
  voids the approval — annoying but safe. A "fix" that happens to match the draft is worse: it sends
  mail whose recipients nobody checked against what was shown.
