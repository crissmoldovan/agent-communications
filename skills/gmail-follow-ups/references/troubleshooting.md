# Why a thread is missing, or there when it should not be

A follow-up list is usually wrong in one of two directions, and both look like the operation working. This
file is the diagnosis for each: the specific reason a thread the user expected is absent, the specific reason
one they did not expect is present, what to check in each case, and the per-inbox errors that produce a short
list with no visible failure. Open it when a user says "that is not right" about a row or an absence.

Before anything else, two habits that resolve most of these. **Open the thread** — `gmail_thread_get` (CLI:
`agent-gmail thread <threadId> --inbox <alias>`) shows what the last message actually is and who sent it. And
**check the run's numbers**: the row cap, the one-page-per-mailbox read, and `errors` explain more absences
than any property of the mail does.

## A thread you expected is missing

| Why | How to confirm | What to do |
|---|---|---|
| **The last message is not the one you think.** `awaiting-them` needs the thread's newest real message to carry `SENT`; `awaiting-me` needs it not to | Open the thread and look at who sent the newest message | If their auto-reply, their "thanks", or a later note from the user is the newest message, the thread is genuinely in the other direction |
| **The thread is nothing but drafts.** A draft at the end is stepped over in favour of the newest message that is not one, so a thread with no real message in it has nothing to judge and is skipped | Open the thread, or look in Gmail's Drafts | A composed but unsent message is not waiting on anybody. Drafts are Gmail's own list and this operation cannot show them |
| **The cap was spent.** `limit` is one budget across every mailbox, filled in mailbox order | Compare the row count against the limit. A full list is a suspicious list | Re-run for that one mailbox, or raise the limit to at most 50 |
| **The mailbox was read one page deep.** Each mailbox contributes at most `limit` candidate threads *before* filtering, and rows dropped by the filters are not replaced | The row count is below the limit and the list still looks thin | Narrow the run — one mailbox, a shorter lookback — rather than assuming the mailbox is quiet |
| **The window is too short.** `lookbackDays` defaults to 30, and the thread's last message may be older | Search for the thread directly: `agent-gmail search "subject:<words>" --inbox <alias>` | Re-run with a longer `lookbackDays` |
| **The age threshold excluded it**, in either direction. `olderThanDays` is applied to the thread's newest real message, and defaults to 3 in `them` and 0 in `me` | The thread's last message is newer than the threshold | Lower `olderThanDays`, or drop it entirely in `me`, where any value at all hides what arrived today |
| **It is not in the inbox**, in `me` only. The query is `in:inbox`, so archived mail — including mail a filter archived on arrival — is invisible | Search without the inbox restriction | Say that the direction only sees the inbox. Nothing here can look at archived mail |
| **Gmail filed it under an excluded category**, in `me` only: promotions, social, updates, forums | Look at the thread's labels with `agent-gmail read <messageId> --inbox <alias>` | The exclusion is deliberate. If the user wants that mail, this operation is the wrong tool for it |
| **It is in spam or trash.** Neither direction searches either | `gmail_search` with `includeSpamTrash` | This is the right way to check one specific thread that "never arrived" |
| **The reply started a new thread.** A reply with a fresh subject line is a new thread to Gmail, so the old one still shows the user speaking last | Search for the counterpart: `agent-gmail search "from:<address> newer_than:30d" --inbox <alias>` | Report the newer thread's id. The old row is not evidence of silence |
| **The mailbox failed.** A per-inbox error produces a shorter list, not a visible failure | `errors` is non-empty and `complete` is `false` | See the error table below |
| **Wrong mailbox.** The thread lives in an account this run did not cover, or the alias was reconnected to another account | `agent-gmail whoami --inbox <alias>` | Confirm before the first read of a session; a plausible list about the wrong life is the worst outcome here |

## A thread is there that should not be

| Why | How to confirm | What to say |
|---|---|---|
| **It was answered somewhere else** — a call, a meeting, a chat thread, a document comment | Nothing in the mailbox can confirm it. The user knows | This is the single most common false row. Say in one line that the list only sees the mailbox |
| **The user already started answering it.** A draft at the end of a thread is stepped over, so the thread is judged on the last real message and stays in `awaiting-me` | Open the thread, or look in Gmail's Drafts | The row is doing its job — an abandoned reply is unfinished work, not a reply. Say the draft is there and let the user finish that one, rather than drafting a second beside it |
| **Nothing was ever owed.** The user's last message was an acknowledgement, a forward, or an FYI | Open the thread and read the last message | `ageDays` measures silence, and silence is frequently correct. Never describe a row as somebody ignoring the user |
| **Automated mail in `awaiting-me`.** Only four Gmail categories are excluded; anything automated that lands in Primary looks exactly like a question | The sender is a no-reply address, or the body has no ask | Drop the no-reply senders before showing the list, and say you did |
| **The thread closed itself.** "No need to reply", "sending for your records" | Open the thread | One of the two cheap disqualifiers worth checking before promoting a row |
| **It was answered from another account** of the user's, or handed to a colleague who replied directly | The reply is not in this mailbox at all | Say which mailboxes the run covered |
| **`with` names the wrong person.** The field is the **first** address of `To` (or of `From`), so on a thread with six people it is one of them, chosen by header order | Open the thread and look at the recipients | Describe it as "one of the recipients", not as "who you are waiting on" |
| **The subject is misleading.** It is cut to 120 characters and it is whatever the sender typed | — | Quote it as a subject, never as a claim about the thread |
| **The thread matched on an older sent message.** `in:sent` matches a thread containing a sent message; the age filter is then applied to the thread's newest | Open the thread | The row is correct by the rules; whether it is useful is the user's call |

## Per-inbox errors, and the one thing that resolves each

A failed mailbox is recorded in `errors` with its alias, a code and a message; `complete` becomes `false`.
The rest of the run still returns, which is why a short list needs `errors` read before it is believed.

| Code | What happened | The one thing that resolves it |
|---|---|---|
| `SCOPE_MISSING` | The mailbox was never granted the `read` capability | The user runs `agent-gmail inbox reauth <alias> --tier read` |
| `AUTH_REQUIRED` | Google rejected the credentials, the refresh token is gone from the secret store, or the grant was revoked or expired | The user runs `agent-gmail inbox reauth <alias>`. The error's hint distinguishes the week-old-consent case, which is an unpublished app rather than a revoked grant |
| `AUTH_REQUIRED` (Workspace policy) | A Google Workspace policy blocks this app for that account | An administrator allows the OAuth client under the Workspace security settings. Nothing the user can do alone |
| `CONFIG` | The Gmail API is not enabled on the Google Cloud project that owns the OAuth client | A person enables it in the Cloud console; the error carries the console link when Google supplied one |
| `TRANSIENT` | Google rate-limited the account, or returned a server error | Wait a minute and re-run. The operation reads only, so a retry is safe |
| `PROVIDER_UNAVAILABLE` | No response from Google at all — a dropped connection, DNS, no network | Check connectivity and re-run |
| `SECRET_STORE_UNAVAILABLE` | The system keychain refused, or is locked | Unlock it and re-run; `agent-gmail doctor` reports what the store is doing |
| `KEYCHAIN_APPROVAL_PENDING` | The keychain is waiting for a person to allow access | The user answers the system dialog, then re-run |
| `NOT_FOUND` | Google returned a 404 for something in the run | Check the alias owns the thread. An unknown **alias** fails the whole call rather than one mailbox, listing the aliases that exist |
| `BAD_DATA` | Google rejected the request | Read what Google said. Do not reshape the request and retry |

Never absorb one of these into a cheerful summary. "Nothing is waiting" after a mailbox failed is the single
most misleading sentence this operation can produce.

## An empty list: quiet, or blocked?

"Nothing is waiting" is the answer most likely to be wrong, because every failure mode in this operation
produces exactly that shape. Four checks, in order, before saying it:

1. **Is `complete` true, and is `errors` empty?** If not, the run covered fewer mailboxes than it appears to.
2. **Which mailboxes were actually in the run?** `all` means every connected mailbox; a named list means only
   those, in that order. A list of one is a list about one life.
3. **Which direction ran?** `them` and `me` answer different questions, and one run answers one of them. An
   empty `awaiting-them` says nothing about what the user has not answered.
4. **Are the numbers the user's?** `olderThanDays` of 3 in `them`, of 0 in `me`, and `lookbackDays` of 30 are
   defaults, not a description of what the user asked for. A quiet threshold larger than the lookback silently
   raises the lookback rather than returning nothing, and a threshold passed in `me` removes every arrival
   newer than it — the usual reason an `awaiting-me` list comes back empty on a morning that was not quiet.

Then say the true sentence, which is longer than the tempting one:

```text
Nothing came back from the part of the mailbox I looked at: `acme/gmail` only, direction "awaiting them",
quiet for at least 3 days, within the last 30, one page deep, 20-row cap. `personal/gmail` returned a
permission error and is not represented at all.
```

## Checking one specific thread properly

When the user disputes a row or an absence, four calls settle almost everything:

| Question | Call |
|---|---|
| What is actually the last message, and who sent it? | `gmail_thread_get` (CLI: `agent-gmail thread <threadId> --inbox <alias>`) |
| Did their reply go to spam or the bin? | `gmail_search` with `includeSpamTrash` |
| How long have they really had, in working hours? | `gmail_thread_timeline` (CLI: `agent-gmail timeline <threadId> --inbox <alias>`) |
| Did they reply in a different thread? | `agent-gmail search "from:<address> newer_than:<n>d" --inbox <alias>` |

Quote the ids of whatever you find. A correction that cannot be checked is worth about as much as the row that
prompted it.

## Reporting a correction

Short, specific, and without defending the original list:

```text
You are right that the Phase 2 thread is not waiting on Sam. The last message in `18f2c9a…` is his reply
from the 15th; the run showed it because the message before that was yours and it matched `in:sent`. Two
other rows in that list are in the same shape, so I have re-checked all six and three stand up.
```

And for an absence:

```text
It is missing because `personal/gmail` returned SCOPE_MISSING, so nothing from that mailbox was in the run at
all. The list you saw was `acme/gmail` only. Granting read on `personal/gmail` is `agent-gmail inbox reauth personal/gmail
--tier read`, which has to be run by you.
```

## Where else to look

- `references/directions.md` — the exact query each direction runs, every filter, and how each field of a row
  is computed.
- `references/contract.md` — the shared contract every `gmail-*` skill works under.
