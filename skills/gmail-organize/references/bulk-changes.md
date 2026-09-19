# Bulk changes: the dry run, the undo, and what a partial failure looks like

A bulk change is one sentence to ask for and a thousand messages to repair by hand. Two mechanisms make that
survivable: a dry run that turns the selection into a number before the number matters, and an undo that comes
back with every applied change. This file is what each of them actually computes, where the undo stops being a
faithful reverse, how the change reaches Gmail, and what to tell the user when a change fails halfway. Open it
before a change wider than a handful of named messages, or after one has failed.

## When a dry run is required

The shared contract sets the rule and both halves of it matter:

- **more than ten messages**, counted after threads are expanded — not after rows are counted; and
- **any selection that came from a search** rather than from the user naming messages one at a time, however
  few rows came back.

The second half is the one people skip. Six threads found by a query are still a query's idea of what the user
meant, and the dry run is where the difference shows up for the price of one call.

## What the dry run computes

`gmail_organise` with `dryRun: true` (CLI: `--dry-run`) does everything except the write, in this order:

1. Checks the `organize` capability on the mailbox. A `read`-tier mailbox fails here, before anything else.
2. Refuses an empty selection: neither `messageIds` nor `threadIds` is a `USAGE` error.
3. Resolves every label name to an id — so a misspelled label fails **before** any thread is expanded.
4. Folds the convenience flags into the two id sets: `archive` removes `INBOX`, `markRead` removes `UNREAD`,
   `markUnread` adds `UNREAD`, `star` adds `STARRED`, `unstar` removes `STARRED`.
5. Refuses a contradiction: any id landing in both sets is a `USAGE` error naming it — `--read` with
   `--unread`, or the same label in `--add` and `--remove`.
6. Refuses a change that changes nothing: both sets empty is a `USAGE` error.
7. **Expands every thread id into its message ids**, by fetching each thread, then de-duplicates the whole
   selection.
8. Returns the result, including the undo, and writes nothing.

The fields that matter in that result:

| Field | What it is | What it is not |
|---|---|---|
| `messages` | The number of distinct message ids that would change, after expansion | The number of rows your search returned |
| `threads` | How many thread ids you passed | A count of anything that will change |
| `addLabelIds`, `removeLabelIds` | The resolved ids, flags included | The names you typed |
| `undo` | The reverse change, pinned to those ids — present on the dry run too | A record of each message's prior state |
| `dryRun` | `true` | — |

Two practical notes. The expansion is what produces the number worth reporting: twenty threads from a chatty
list can be three hundred messages, including the user's own replies, which they never pictured as "mail from
this sender". And the dry run is not free — one thread fetch per thread id, plus a label listing for each of
the add and remove lists that is not empty — so dry-running forty threads is about forty-one calls. That is the right price; it is just not zero, and it is
a reason to dry-run the selection you mean rather than a wider one "to see".

`gmail_trash` has its own dry run. It expands threads the same way and returns `messages` as the **list of
ids** it would move, plus `action: "trash"` or `"untrash"`.

## Applying what was dry-run

The same ids, the same flags, without `dryRun`. Not a re-run of the query: mail arrives between the plan and
the change, and refreshing the selection quietly changes what the user agreed to. If the selection genuinely
needs to be current, that is a new dry run and a new yes.

Check that the applied result's `messages` matches the plan's. A mismatch means the selection moved, and the
report to the user should say so rather than quoting the number they approved.

## How the change reaches Gmail

| Operation | How it is sent | What that means for failure |
|---|---|---|
| `gmail_organise` | Gmail's batch modify endpoint, in chunks of **1000 message ids**, one call per chunk, in order | Under a thousand messages it is one call: it either happened or it did not. Over a thousand, an error on a later chunk leaves the earlier chunks applied |
| `gmail_trash` | One call **per message**, in order | A failure partway leaves everything before it binned |

The audit record is written **after** the operation completes. So a change that threw halfway leaves no audit
line at all, even though part of it landed. The audit log is not the place to find out what happened to a
failed bulk change.

## The undo, exactly

The undo returned is the same change with the two label lists swapped, pinned to the exact message ids that
changed:

```text
change: add []            remove [INBOX]   over 314 ids
undo:   add [INBOX]       remove []        over the same 314 ids
```

For a bin, the reverse is the same call with `undo: true` (CLI: `--undo`) over the ids in the result's
`messages`.

That is a genuine reverse of the *change*. It is not a restore of the *state*, and the difference bites in
exactly the cases bulk changes are used for:

- **Archiving a mixed selection.** Archive fifty messages of which three were already out of the inbox, then
  apply the undo, and all fifty get `INBOX` — including the three, which are now in the inbox for the first
  time in months.
- **Marking a mixed selection read.** The undo adds `UNREAD` to every id, so messages that were already read
  before you started come back unread.
- **Removing a label.** The undo adds it to every id in the selection, including any that never carried it.
- **Time.** The undo is a change, not a snapshot. If the user has starred, archived or filed some of those
  messages in between, applying the undo overwrites their work on those ids.

None of that makes the undo useless — it is the only durable handle on what you changed, and for a handful of
named messages it is exactly right. It means the undo for a wide selection needs one sentence of honesty when
you offer it:

```text
To put it back: agent-gmail organise --inbox work --add INBOX --message 18f2c… --message 18f2d… …

That adds INBOX to all 314, so any that were already archived before today would come back to the inbox.
```

Keep the ids in the conversation. Once they are gone, so is the undo: nothing on disk records the selection,
and reconstructing it from the query gives a different set.

## Idempotency, and what a retry is worth

Gmail's label changes are idempotent: adding a label a message already has, or removing one it does not have,
changes nothing and does not fail. Trashing a message already in the bin is likewise a no-op. So **retrying a
failed bulk change is safe** in the sense that it cannot double-apply.

What a retry does not give you is a correct count. After a partial failure the second call reports the size of
what you asked for, not the size of what actually changed on this attempt, and there is nothing in the result
that separates the two. If the number matters to the user — and after a failure it usually does — it has to
come from a search, not from the call.

## Reporting a partial failure

Say what you know, what you do not, and what would settle it. In that order.

```text
The archive failed partway. What I know: I sent 2,400 message ids in three batches of up to 1,000, in the
order of the dry run, and the third call returned a rate-limit error. The first two batches had already been
accepted, so roughly 2,000 messages are archived and the rest are not. Nothing was deleted either way.

What I cannot tell you from here: exactly where the boundary fell. A search for the same query with
`in:inbox` will show what is still in the inbox.

I have kept the full id list. Retrying is safe — re-archiving an archived message does nothing — but the
count it reports will be the size of the request, not the size of the repair.
```

For a bin that failed partway, the same shape with one change: `gmail_trash` moves one message at a time, so
the failure is per message, and the `messages` list in the result is what you asked for rather than a receipt.
Check before retrying, and never retry blindly across a selection the user has not re-approved.

The codes worth recognising when this happens:

| Code | What it means here | Retry? |
|---|---|---|
| `TRANSIENT` | Gmail rate-limited the account, or returned a server error | Yes, after a wait — safe, as above |
| `SCOPE_MISSING` | The mailbox was never granted `organize` | No. `agent-gmail inbox reauth <alias> --tier organize`, by the user |
| `AUTH_REQUIRED` | The credentials were rejected, or a Workspace policy blocks the app | No. Sign-in or an administrator |
| `NOT_FOUND` | A label or message id is not in this mailbox | No. Check the alias and the ids |
| `BAD_DATA` | Gmail rejected the request itself | No. Read what Google said; do not reshape the request and try again |

## The four ways a selection is bigger than it looked

Worth re-reading before any wide change, because each one is a way the dry run's number surprises the user:

- **Threads are not messages.** Search returns threads by default; expansion counts every message in each.
- **`estimatedTotal` is Gmail's guess**, wrong in both directions. `returned` counts what you hold; `hasMore`
  is the only statement about what was left behind.
- **The query was broader than the sentence.** "Everything from that newsletter" becomes a `from:` that also
  catches the order confirmations from the same domain. A count far above what the user pictured is the first
  and best sign.
- **The mailbox moved while you worked.** Apply the ids you dry-ran.

## Where else to look

- `references/labels.md` — how a name becomes an id, the system labels, and creating one.
- `references/contract.md` — the shared contract, including the bulk-change rule and the bin's thirty days.
