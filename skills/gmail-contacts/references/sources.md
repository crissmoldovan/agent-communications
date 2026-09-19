# The three sources, and what a match in each is worth

`gmail_contacts_search` asks three different questions and merges the answers into one list. This file is what
each question actually is, how the rows are built and ordered, and — the part that matters most — what the
search does not do to an address before showing it to you. Open it when you are about to describe a row's
source to a user, when a mailbox returned less than you expected, or when two rows look like the same address.

The framing to keep: **nothing here is evidence that an address is the right one.** The sources say where a
string was seen. They do not say who owns it, and a lookalike domain matches a name search exactly as well as
the real thing does.

## The three sources

| Source | Where it comes from | What one query costs |
|---|---|---|
| `contacts` | Google's People API, searching the address book attached to this mailbox: up to 20 people, reading names and email addresses | One People API call per mailbox |
| `other-contacts` | The same API's "other contacts" collection — people this account has corresponded with, accumulated by Google automatically, never saved by anyone: up to 20 people | One People API call per mailbox, made in parallel with the one above |
| `history` | Gmail itself: a search for `from:<query> OR to:<query>`, at most 25 messages, each fetched for its headers | One list call plus up to 25 metadata fetches per mailbox |

All three run unless you narrow `sources`. They run **per mailbox**, and the same person in two mailboxes
comes back as two rows, because a row records which mailbox saw them.

### What a `contacts` match means

Somebody deliberately saved this person in the address book on this account. That is a record of an intention
and nothing more: people save addresses from signatures, from forwarded introductions, and from convincing
phishing mail. It carries a name and an address and says nothing about correspondence — `messages` is `0` and
`lastSeen` is `null` unless the same address was also seen in history.

It sorts first. That is a sort order, not a verdict, and an address saved after a successful phish sits at the
top of the list for exactly that reason.

### What an `other-contacts` match means

Google noticed this address passing through the account. Nobody chose it. Every mailing list, every no-reply
sender and everyone who wrote once is eligible. It sorts last, and it deserves that: it is the weakest
statement of the three.

### What a `history` match means

The address appeared in a `From`, `To` or `Cc` header of a message in this mailbox, among the messages Gmail
returned for the query, and the query is a substring of either the address or the display name. It is the only
source that carries behaviour:

- `messages` counts **header sightings**, not messages: an address in both `To` and `Cc` of one message counts
  twice, and the sample is at most 25 messages per mailbox. Treat 7 as "at least 7 sightings in a sample of at
  most 25 messages", and treat 0 as "this search did not see it in mail" — never as "they have never
  corresponded".
- `lastSeen` is the most recent sighting, as an ISO timestamp. Only history ever sets it, so a pure
  address-book row has none. Absent is absent, not old.
- The mailbox's own address is skipped, so the user does not appear in their own results.

## How a row is built

| Field | How it is set |
|---|---|
| `email` | Lower-cased. History addresses additionally have their domain converted to ASCII — see *What the search does not do* |
| `name` | The display name from the address book, or from the header. Whichever arrived first and was non-empty wins; a later source does not overwrite it |
| `inbox` | The alias that found it |
| `sources` | Every source that produced this address in this mailbox, in the order they ran |
| `messages` | Incremented once per history sighting; `0` for a row that came only from the address book |
| `lastSeen` | The latest history sighting, or `null` |

Rows are merged on `<alias>:<lower-cased address>`. So one person with two addresses is two rows, the same
address in two mailboxes is two rows, and the same address from two sources in one mailbox is one row with two
entries in `sources`.

## The ordering

Rows are sorted by:

1. **Best source rank**: `contacts` (0), then `history` (1), then `other-contacts` (2). A row's rank is the
   best of its sources.
2. **`messages`, descending.**
3. **`lastSeen`, descending.**

Then the list is cut to `limit` — default 20, clamped between 1 and 50.

Read that as: the ordering describes provenance and traffic. It is not a confidence score, and the top row is
not the answer. The cut is also worth noticing: a low limit can drop a history row with real traffic behind
address-book rows with none.

## What the search does not do

This is the section that prevents the expensive mistake.

- **No dot folding.** `j.smith@gmail.com` and `jsmith@gmail.com` are one Gmail mailbox and two rows here.
- **No plus folding.** `sam+invoices@acme.test` and `sam@acme.test` are two rows.
- **Punycode, inconsistently.** History addresses are parsed through the package's address parser, which
  lower-cases and converts an internationalised domain to its ASCII (punycode) form. Address-book and
  other-contacts addresses are only lower-cased. So an internationalised address can appear twice — once in
  Unicode from the address book, once in punycode from history — and the merge will not join them, because the
  strings differ. For the same reason, searching for a domain in its Unicode spelling will not substring-match
  the punycode form in history.
- **No lookalike comparison.** Nothing measures the distance between two domains here. The automatic check
  lives in the send preview, where a first-time external recipient is compared against the domains this mailbox
  actually writes to, read from the last two hundred messages in Sent. It is real but bounded: a lookalike of
  somebody outside that window, or one already saved and written to before, reaches the preview unflagged.
- **No verification of any kind.** No DNS, no MX check, no reputation, no ownership. A domain that does not
  exist looks exactly like one that does.
- **No filtering.** Similar addresses are shown rather than removed, and the CLI prints that line under every
  result. Suppressing a suspicious row hides the finding.

## When a source did not run

Two different silences, and only one of them is reported.

| What happened | How it shows | What to say |
|---|---|---|
| The mailbox is not connected with address-book access | `contacts` and `other-contacts` are skipped, **no error is raised**, and `complete` stays `true` | "Two of the three sources were switched off for this mailbox" — check the mailbox's `contacts` flag with `agent-gmail inbox list --json`; `gmail_inboxes_list` does not carry it |
| The mailbox has the flag but not the scope, or Google refused | The People call throws; the failure is recorded in `errors` for that inbox and `complete` becomes `false` | Name the inbox and the code. `SCOPE_MISSING` is resolved by the user with `agent-gmail inbox reauth <alias> --contacts` |
| The People API is not enabled on the Google Cloud project | `CONFIG` in `errors`, naming the People API | A person enables it in the Cloud console; nothing here can |
| The whole mailbox could not be read | `errors` for that inbox, `complete` false, and it contributed nothing at all | Say the mailbox is missing from the answer, not that the person was not found |

There is one more silence with no flag at all: **the People API needs a warm-up call before it answers a
query**, so the first contact search of a session can come back empty even when everything is configured
correctly. A second identical search is the cheap way to tell that apart from a genuine absence.

## Reporting a result

Say what ran, show every row with its source, and describe the two numbers honestly:

```text
Three addresses match "Sam Rivera" (work, personal · all three sources ran in work; personal has no
address-book access, so only its mail history was searched):

1. sam@acme.test           contacts+history · 34 sightings · last seen 2026-09-16 · work
2. s.rivera@acme.test      history           ·  2 sightings · last seen 2024-11-03 · work
3. sam@acme-invoices.test  history           ·  1 sighting  · last seen 2026-09-11 · work

"Sightings" are header appearances in a sample of at most 25 messages per mailbox, so they are a floor.
```

An empty result is a statement about a search, not about the world: "nobody matched 'Rivera' in `work` and
`personal`, and the address book was unavailable in `personal`" is true; "she is not in your contacts" is a
claim this search cannot support.

## Where else to look

- `references/disambiguation.md` — presenting several candidates, and the cases that look like one person and
  are two.
- `references/contract.md` — the shared contract every `gmail-*` skill works under.
