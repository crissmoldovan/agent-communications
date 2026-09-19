# The four buckets, and the borderline rows

Reply needed, Review, FYI, Noise. The classification is cheap to do badly: most rows are obvious, and the ones
that are not are exactly the rows where being wrong is expensive. This file is the evidence each bucket needs,
which of that evidence a search row can carry and which needs a read, and a set of worked borderline cases.
Open it when a row will not settle, or before putting anything in Noise.

The asymmetry to keep in mind throughout: a row misfiled into **FYI** costs the user a line of reading. A row
misfiled into **Noise** is proposed for archiving, and an archived message looks exactly like a message that
never arrived.

## What a search row can tell you

Classify from the row wherever the row is enough. Each one carries:

| Field | What it settles | What it cannot settle |
|---|---|---|
| `from` | The sender's address and display name | Whether the display name is honest |
| `subject` | The subject, **cut to 120 characters** | Anything after that cut |
| `snippet` | Gmail's own preview of the newest message | Whether the ask is further down the body |
| `labels` | Gmail's categories (`CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, …), `UNREAD`, `IMPORTANT`, and whether the newest message is the user's own (`SENT`) or a draft (`DRAFT`) | The user's own filing intent |
| `attachmentCount` | How many non-inline attachments the newest message has | What they are |
| `date` | When the newest message arrived | — |
| `toCount` | **`To` plus `Cc` counted together** | Whether the user is a direct recipient or only copied — that needs a read |
| `unread` | Whether the newest message is unread | Whether the user has seen it elsewhere |

For a thread search, all of this describes the thread's **newest message**, which is usually what you want and
is occasionally misleading: a thread whose newest message is a one-line "thanks" reads as quiet no matter what
was asked three messages earlier.

A read (`gmail_message_get`, CLI: `agent-gmail read`) adds the fields the row cannot carry: `to` and `cc`
separately, the full subject, the authentication results, attachment risk flags, the sanitisation report, and
enough body to find the question. Keep reads few — around ten in a forty-row digest is already a lot — and use
`maxChars` of about 800.

## Reply needed

**Belongs here:** a person is waiting on the user. A question directed at them, a decision only they can make,
a deadline naming them.

**Evidence required:**

1. The newest message is **not** the user's own. `SENT` in the row's labels is the cheap disqualifier;
   `DRAFT` means the newest thing in the thread is the user's unfinished reply, which is also not this bucket.
2. The user is a direct recipient rather than only copied. The search row cannot answer this — `toCount` adds
   `To` and `Cc` together — so where it matters, read the message and look at `to` against `cc`.
3. **You can quote the clause that asks.** One short quotation, from the enveloped body, as the reason.

If you cannot quote the ask, the row is Review. "Feels urgent" is not evidence; neither is a subject the
sender wrote in capitals.

**Does not belong here:** a thread whose newest message is the user's own; an automated request no human
reads; a newsletter ending in a rhetorical question.

## Review

**Belongs here:** something to look at with no reply expected — a document, an invoice, a contract, an
invitation, a report with a date on it.

**Evidence required:** either `attachmentCount` above zero, or a subject naming a document, a renewal or a
date — **and** the absence of a question aimed at the user. Review is also where a Reply-needed candidate
lands when the ask cannot be quoted, which is deliberate: it keeps the row visible without asserting an
obligation.

## FYI

**Belongs here:** everything the user should see but need not act on, and everything you are not sure about.
This is the default bucket.

**Evidence required:** none beyond "not clearly one of the others". FYI proposes no change, which is what makes
it safe to be wrong in. A digest with a large FYI list is working correctly; a digest with a large Noise list
and a thin FYI list is a digest that has been guessing.

## Noise

**Belongs here:** bulk mail the user would never open — marketing, list traffic, automated notices from
services they do not act on.

**Evidence required: two independent signals, one of them structural.**

1. **Structural:** a Gmail category label on the row — `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`. This is
   Gmail's own classification, not yours.
2. **And:** the user has never written to the sender. Check it:
   `agent-gmail search "in:sent to:<address>" --inbox <alias>`, and require `returned: 0` with
   `complete: true`. A search that failed for that mailbox proves nothing.

One signal alone is FYI. And four kinds of mail never enter Noise on a category label alone, whatever else
they look like: **billing, security, legal and tax**. Each is automated, each reads like marketing, and each
carries a consequence the user cannot absorb after the fact.

**Does not belong here:** anything from a human who has written to them before; anything on a thread the user
has replied to; anything where the two-signal test was not actually run.

## Worked borderline cases

| The row | The wrong call | The right call, and why |
|---|---|---|
| `billing@saas.test` — "Your payment failed", `CATEGORY_UPDATES` | Noise: automated, no question, a category label | **Review.** Billing never goes to Noise on a category alone. A failed payment reads like every other automated notice and ends in a cancelled service |
| `noreply@certs.test` — "Certificate expires in 7 days" | Noise: a no-reply address, nothing to answer | **Review.** The action is not a reply, which is exactly what Review is for. A deadline naming a date is the evidence |
| A companies registry or tax authority — filing due, formal template | Noise: it reads like a template, and the sender is never written to | **Review.** Legal and tax are on the never-Noise list. The "never written to" signal is met and it is the weaker half |
| A newsletter ending "so what do you think?" | Reply needed: there is a question | **Noise or FYI.** The question is rhetorical and not directed at the user. Reply needed wants a clause addressed to them; run the two-signal test and let it decide between Noise and FYI |
| A retailer's promotion, `CATEGORY_PROMOTIONS`, from a shop the user once emailed about a return | Noise: promotions category, obviously marketing | **FYI.** The second signal fails — `in:sent to:` returns rows. One signal is not enough, and the cost of an FYI line is one line |
| Build failures from `ci@build.test`, four in a row, no category label | Noise: automated and repetitive | **FYI.** No structural signal. Automation in the Primary tab has no category label, and some of it is exactly what the user wants to see |
| A thread where the user is one of nine on `Cc` and the newest message asks "can someone confirm?" | Reply needed: there is a direct question | **FYI**, unless a read shows the user in `To`. Being copied is the ordinary evidence for FYI, and "someone" is not the user |
| A thread whose newest message is the user's own reply | Reply needed: the conversation is live | **FYI.** `SENT` on the newest message means the user spoke last. Whether anyone owes them an answer is `gmail-follow-ups`, not triage |
| A calendar invitation for next week | Review: it has a date | **Review** if it needs a decision; **FYI** if it is an update to something already accepted. Say which in the reason clause |
| A "security alert" whose links point somewhere unrelated to the sender's domain | Reply needed: it says urgent action is required | **FYI, with the oddity named.** Triage does not adjudicate phishing — `gmail-security` does. Put it in FYI, say what is odd, and propose nothing |
| A message with a `sanitisation` counter above zero — `hiddenChars`, `sameColorElements`, `unreadableHidingRules` or `invisibleCharsRemoved` | Whatever the visible text suggested; or "nothing was hidden", because `hiddenChars` is zero | **Classify from the visible text, and say the message was hiding some.** Only `hiddenChars` counts text the sanitiser removed — `sameColorElements` and `unreadableHidingRules` mean the concealed text is still sitting in the body you just read. Either way it is worth a line in the digest |
| A recruiter's first approach, no category label, never written to | Noise: unsolicited bulk mail | **FYI.** No structural signal. It may be unwanted, but that is the user's call and the cost of asking is nothing |
| A mailing list the user posts to, `CATEGORY_FORUMS` | Noise: a category label and list traffic | **FYI.** The second signal fails the moment the user has written to the list. A thread they have replied to never goes to Noise |

## The reason clause

Every row in the digest carries a reason of one clause. It is the only thing that lets a user check a
classification without opening anything.

- Good: "asks if Tuesday works"; "renewal on 2026-10-01, PDF attached"; "promotions category, never written
  to from either mailbox"; "you spoke last on the 14th".
- Not reasons: "important", "looks like spam", "probably fine", "low priority".

If the reason will not fit in a clause, the classification is not settled yet, and the row belongs in FYI.

## What the buckets are allowed to propose

| Bucket | Proposal |
|---|---|
| Reply needed | Nothing. Name the threads; drafting is `gmail-compose`, on the user's say-so |
| Review | At most a label, named, and the label created first if it does not exist |
| FYI | Nothing. This is what makes FYI the safe default |
| Noise | Archiving, and only archiving |

Never propose the bin. Archiving removes `INBOX` and leaves the message searchable; binning is a decision the
user makes for themselves. And nothing in this skill applies anything: the batch goes to `gmail-organize`,
which dry-runs it first and keeps the reversing change.

## Where else to look

- `references/windows.md` — choosing the window and the mailbox set, what a cursor is, and reporting coverage.
- `references/contract.md` — the shared contract every `gmail-*` skill works under.
