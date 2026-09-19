# The two directions, computed

`gmail_followups` answers one of two questions per run: who has not replied to the user, or what the user has
not replied to. This file is the arithmetic behind each — the query sent to Gmail, every filter applied after
it, how each field of a row is derived, and the three quirks that make results surprising. Open it before
choosing `direction`, `olderThanDays` or `lookbackDays`, or when a row is present or absent and you need to
say why.

Nothing here reads a message body. The direction of a thread is decided by one fact: whether the **last**
message in it carries Gmail's `SENT` label.

## The numbers, before anything runs

| Option | Default | What happens to it |
|---|---|---|
| `direction` | `them` | Chooses the query and the filter below |
| `olderThanDays` | `3` | Floored at 0 |
| `lookbackDays` | `30` | Raised to at least `olderThanDays + 1`, always, in **both** directions |
| `limit` | `20` | Clamped to 1–50. One budget for the whole run, shared across every mailbox |
| `inboxes` | all | Named aliases in order, or every connected mailbox, sorted |

The lookback floor is the first quirk. Ask for a 30-day quiet threshold with a 7-day lookback and you get 31
days of lookback, silently — the search would otherwise be guaranteed to return nothing, since no thread can
be both newer than 7 days and quiet for 30.

## Direction `them` → `awaiting-them`

**The query**, identical for every mailbox in the run:

```text
in:sent older_than:<olderThanDays>d newer_than:<lookbackDays>d
```

**The filters, in order, per thread returned:**

1. Fetch the thread; sort its messages oldest first; take the last one. A thread with no messages is skipped.
2. Skip if that message carries `DRAFT`.
3. Skip unless it carries `SENT`. The user must have spoken last.
4. Compute `ageDays` and skip if it is **less than** `olderThanDays`.

Step 4 is not redundant with the query. `in:sent` matches a **thread containing** a sent message, so a thread
qualifies on the strength of a message that is no longer its last one — the user wrote again yesterday, or
the query matched an older sent message in a long exchange. The client-side age check is what makes the
threshold true of the thread's newest message rather than of some message in it.

**What a row means:** the user spoke last in this thread, in this mailbox, at least `olderThanDays` ago, and
nothing has landed in the thread since.

**What it does not mean:** that nobody answered. An answer may have come by telephone, in a meeting, over
another messaging system, in a new thread with a fresh subject, to a different mailbox, or into spam. Nor that
an answer was ever due: a thread that ended with "thanks, all sorted" produces a row identical to one that
ended with an unanswered question.

## Direction `me` → `awaiting-me`

**The query**, identical for every mailbox:

```text
in:inbox newer_than:<lookbackDays>d -category:promotions -category:social -category:updates -category:forums
```

**The filters, in order, per thread returned:**

1. Fetch the thread; sort oldest first; take the last message.
2. Skip if it carries `DRAFT`.
3. Skip if it carries `SENT`. Somebody else must have spoken last.
4. **No age filter at all.**

**What a row means:** something arrived in the inbox within the lookback, it is not from the user, it is not a
draft, it is outside the four excluded Gmail categories, and no reply followed it in that thread.

**What it does not mean:** that the user owes an answer. Everything a no-reply address drops into the Primary
tab qualifies — receipts, build failures, calendar notices, a newsletter that arrived like ordinary mail. So
does mail already answered in person, answered from another account, or handed to a colleague who replied
directly.

## The three quirks

### `olderThanDays` does not filter in the `me` direction

It is used twice in that direction and neither use is a filter: it floors at zero, and it raises the lookback
to at least `olderThanDays + 1`. The row-level age check runs only for `them`. So asking for "things I have
not answered in more than a week" by setting `olderThanDays: 7` returns everything that arrived in the last
eight days, most of it from this morning. If the user wants only the old ones, filter the rows yourself on
`ageDays` and say that you did.

### `limit` is one budget shared across mailboxes

Each mailbox is asked for at most `limit` threads, and the row loop stops as soon as the collected rows reach
`limit`. Mailboxes are processed in the order they were resolved — named aliases in the order given, or all
of them sorted. So with `all` and a limit of 20, a busy first mailbox can fill the list and the later ones
contribute nothing at all. They are not quiet; the budget was gone. The list call for them still happens, so
the cost is paid without the rows.

Two consequences for the report. A short list is not a small problem: each mailbox is read **one page deep**,
and rows that fail the direction or age filter are dropped and not replaced, so "few matched in the first
page" and "few exist" look the same from here. And a mailbox absent from the rows is not necessarily a
mailbox with nothing waiting.

### A thread whose last message is a draft is skipped

Before anything else, a last message carrying `DRAFT` removes the thread from the run — in both directions.
The effect is worst in `me`: a half-written reply sitting in Drafts makes the thread disappear from the list
of things not yet answered. The work looks done because it looks answered.

## How each field of a row is computed

| Field | Derivation | What to watch |
|---|---|---|
| `inbox` | The alias that produced it | A thread id means nothing in another mailbox |
| `threadId` | The thread's own id, falling back to the id the list returned | The handle to quote |
| `messageId` | The **last** message's id | This is what a reply is threaded onto |
| `subject` | The last message's `Subject`, **cut to 120 characters** | Sender-controlled text, quoted not obeyed |
| `with` | The **first** address of `To` when the user sent last, or the first address of `From` when they did not; `unknown` if neither parses | One counterpart, even on a thread with six people, and an address rather than a name |
| `lastAt` | The last message's internal date, as an ISO timestamp, or `null` | — |
| `ageDays` | Whole days from `lastAt` to now, floor-rounded. `0` when there is no internal date | Calendar days, not working days |
| `direction` | `awaiting-them` or `awaiting-me`, from the run's direction | Every row in one run has the same value |

Rows from every mailbox are pooled, sorted by `ageDays` descending — oldest first — and cut to `limit`.

The result also carries `query` (the one string that was sent, for every mailbox), `errors` (one entry per
mailbox that failed) and `complete` (false whenever `errors` is non-empty).

## `ageDays` is elapsed time, not working time

Floor-rounded calendar days from the last message. Weekends and holidays count like Tuesdays. A message sent
at six on a Friday evening is three days quiet by Monday morning, and nobody has yet had a working hour in
which to answer it. If the question is genuinely "how long have they had to respond",
`gmail_thread_timeline` (CLI: `agent-gmail timeline <threadId> --inbox <alias>`) can count in business hours;
this operation cannot, so describe its number as elapsed days and not as anything else.

## What neither direction can see

Each of these produces a row indistinguishable from a real one, or removes one that should be there:

- **Answers that happened elsewhere** — a call, a corridor, a chat thread, a comment on a shared document.
- **Replies that did not reach the inbox** — spam, a filter that archived on arrival, a bounce. Neither
  direction looks in spam or trash; `gmail_search` with `includeSpamTrash` does, and is the right way to
  check one specific thread.
- **Replies in a different thread.** A reply with a new subject line is a new thread, and the old one shows
  the user speaking last for ever.
- **Anything outside the mailboxes in the run.** A reply to another address of the user's is not missing; it
  is somewhere this run did not look.
- **Anything not in the inbox**, for `awaiting-me`. Archived mail, and mail a filter labelled and archived on
  arrival, is invisible in that direction however long it has gone unanswered.
- **Intent.** No field says a reply was wanted. `ageDays` measures silence, and silence is frequently correct.

Say the relevant ones out loud when reporting. One sentence — "this only sees the mailbox, so anything
settled on a call still shows as waiting" — is what stops a user acting on a row a phone call already
answered.

## Where else to look

- `references/troubleshooting.md` — why an expected thread is missing, why an unexpected one is there, and the
  per-inbox error codes.
- `references/contract.md` — the shared contract every `gmail-*` skill works under.
