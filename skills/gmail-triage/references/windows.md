# Windows, mailbox sets and cursors

A digest is only as honest as its window. This file is how to choose one, what the query compiler does to
dates before Gmail sees them, how the mailbox set is resolved and why its order matters, what a cursor
actually contains, and how to state coverage so a reader knows what was not looked at. Open it before running
the search that a digest will be built from, or when a cursor has been refused.

## Choosing the window

A window is a query, written out, and it belongs at the top of the digest where a wrong one is visible.

| Shape | When it fits | Note |
|---|---|---|
| `in:inbox newer_than:2d` | The everyday "what came in overnight" | Relative forms pass through to Gmail untouched |
| `in:inbox newer_than:7d` | Back from a week away | Expect the row cap to bind before the window does |
| `in:inbox after:2026/09/17` | The user named a date | Rewritten — see below |
| `in:inbox is:unread newer_than:3d` | The user treats unread as their queue | A narrower window than it looks: read-but-unanswered mail disappears |

Two habits worth keeping. **Restrict to the inbox.** Triage is about what is sitting in the inbox, not about
the archive, and `in:inbox` is what makes the Noise proposal meaningful — archiving something already
archived is a no-op that still appears in the count. And **pick a limit you can actually read**: the default
is 20, the ceiling is 50, and forty rows is already a long digest.

## What the compiler does to dates

Gmail reads a bare date operator in Pacific time. Ask on a Wednesday morning in London for mail since
yesterday and the window quietly starts eight hours late. So before the query is sent:

- The operators `after`, `before`, `older` and `newer` are examined. A leading `-` is preserved.
- If the value parses as a date — `YYYY/MM/DD`, `YYYY-MM-DD` or `MM/DD/YYYY` — it is replaced by the **epoch
  seconds of local midnight on that date** in the configured timezone.
- The timezone is `defaults.timezone` from the configuration, or the machine's own zone when that is unset or
  set to `system`. The zone's offset on that date is used, so it stays right across daylight saving.
- `older_than:7d` and `newer_than:2h` are **not** rewritten: the operator is `older_than`, not `older`, and a
  relative span is already unambiguous.
- Everything else in the query passes through untouched. Quoted strings, parentheses and `{}` groups survive
  tokenisation intact.

The result carries `query.given`, `query.compiled`, `query.timezone` and `query.rewrites` — one entry per
rewrite, with the operator, the original value and the epoch it became. If a date was rewritten, say which
instant the window really starts at. "from 2026-09-17 00:00 Europe/London" is the line; the bare epoch is not.

## The mailbox set

`inboxes` takes a list of aliases, or `"all"`, or nothing.

- **Named aliases** are used **in the order given**. An alias that is not configured fails the whole call with
  `NOT_FOUND`, listing the aliases that are.
- **`"all"` or omitted** means every connected mailbox, **sorted**. The sort is deliberate: a cursor made
  today still matches the same set tomorrow, whatever order the configuration file grew in.
- **No mailboxes at all** is `NOT_FOUND` — "no mailbox is connected yet".

Search all the mailboxes in one call rather than one at a time. The merge is lazy: each mailbox's next row is
peeked, the newest across all of them is emitted, and metadata is fetched only for rows the merge actually
looks at. Twenty rows across six mailboxes costs roughly twenty-six message fetches, not six pages of fifty.
(For `kind: "threads"`, each peeked row also costs a thread fetch, because the row describes the thread's
newest message and that means finding it.)

A mailbox that fails — missing `read`, a rejected token, Google refusing — is recorded in `errors` and the
rest of the search still returns. It is recorded once, whether it failed while being set up or partway
through the merge.

## What a cursor is

`nextCursor` is a base64url-encoded JSON object. It holds:

| Part | What it is |
|---|---|
| `v` | The format version. Anything but `1` is refused |
| `q` | A truncated hash of the **compiled** query plus the `kind`. Not the query you typed — the query after date rewriting |
| `kind` | `threads` or `messages` |
| `inboxes` | The alias list, as an array |
| `per` | Per alias: Gmail's `pageToken`, the ids already emitted (**the last 200 only**), and whether that mailbox is exhausted |

It is a resumption token for one search, not a bookmark in the mailbox. Four ways it is refused, all with
`CURSOR_MISMATCH` (CLI exit 64):

| Message | Cause |
|---|---|
| that cursor is not one of ours | It did not decode as our JSON |
| that cursor is from an older version | The version or shape does not match |
| that cursor belongs to a different search | The compiled query or the `kind` changed. Note that changing only the timezone, or a date's rewritten value, changes the compiled query too |
| that cursor was made for a different set of mailboxes | The alias list differs — **including its order**, because the lists are compared as joined strings |

That last one is the trap. Passing `["work", "personal"]` and then `["personal", "work"]` is a different set
as far as the cursor is concerned. Using `"all"` avoids it, because `"all"` always resolves sorted.

A refusal is the check working. Run the search again from the start rather than trimming the mailbox list to
make the cursor fit: the alternative is two result sets silently interleaved.

Two details about resumption worth knowing before relying on a second page:

- A mailbox whose first page carried no page token **re-lists that page** and filters out the ids it already
  emitted. One page of ids is cheap, and the alternative is losing the rest of the results.
- Only the last 200 emitted ids per mailbox are remembered. A mailbox that emitted more than that from a
  single page could show an early row again on resumption.

## Reporting coverage

Three numbers, and only one of them is a statement about completeness.

| Field | What it means | How to say it |
|---|---|---|
| `returned` | How many rows this page holds. A fact | "40 threads" |
| `estimatedTotal` | Gmail's own `resultSizeEstimate`, summed across mailboxes. An estimate, wrong in both directions | "an estimated 310" — and call it an estimate |
| `hasMore` | Whether any mailbox still had rows. The **only** reliable statement about what was left behind | "more remain" or "that is all of them" |

Plus:

- `complete` is `false` whenever `errors` is non-empty. A failed mailbox contributes nothing to any bucket, so
  its mail is simply absent from the digest. Name the mailbox and the code.
- Say how many bodies you read, and say when one came back `truncated` — a classification made from a
  truncated body should admit it.

A header that does all of that:

```text
Triage · in:inbox after:2026/09/17 (from 2026-09-17 00:00 Europe/London) · mailboxes acme/gmail, personal/gmail
40 of an estimated 310 threads · more remain · read 6 bodies · all mailboxes returned
```

And when one did not:

```text
Triage · in:inbox newer_than:2d · mailboxes acme/gmail, personal/gmail, acme/gmail-archive
40 of an estimated 310 threads · more remain · read 6 bodies
`acme/gmail-archive` returned SCOPE_MISSING and is not in any bucket below — nothing from it was classified.
```

## Do not page for completeness

One window, one page, an honest line about what was left behind. Paging to the end of the week so the digest
can claim to have covered everything produces forty extra rows nobody reads and a context window with no room
left for the reasoning. If the user wants the rest, pass `nextCursor` back — with the same query and the same
mailbox list.

The same instinct applies to widening. A digest that says "the 40 newest of an estimated 310, more remain" is
more useful than one that quietly searched a fortnight to make the number look complete.

## Two window mistakes that look like results

- **A window that starts in the wrong place.** An absolute date that was rewritten starts at local midnight in
  the configured timezone. If the user's configured timezone is not the one they are sitting in, the window is
  off by hours and everything downstream inherits that. `query.timezone` is in the result; quote it when a
  date was rewritten.
- **A window with no `in:inbox`.** The search then covers the archive as well, the Noise list fills with mail
  the user already dealt with months ago, and the archive proposal is mostly a no-op with a large number
  attached to it.

## Where else to look

- `references/buckets.md` — the evidence each bucket needs, and the borderline rows.
- `references/contract.md` — the shared contract, including "say how much you read".
