# Gmail query syntax, as this package passes it

A working reference for the search string itself. Open it when a query returned nothing and you need
to know whether that is an answer about the mailbox or an answer about the query, when you are turning
a vague request into an explicit one, or when you want to know exactly what this package changed before
your words reached Gmail. The procedure in the SKILL tells you to write a query and read the `query`
block that comes back; this file is what that block means.

The one thing to hold on to: **this package rewrites four date operators and nothing else.** Everything
else in your string is Gmail's own search language, passed through as written. That makes the failure
mode predictable — a mistake is not an error, it is a search for the mistake.

## The only rewrite: dates

Gmail's API reads a bare date in Pacific time, not the user's. So the compiler finds date operators,
parses the value, and replaces it with epoch seconds at **local midnight in the configured timezone**.

| What is rewritten | What is not |
|---|---|
| `after:`, `before:`, `older:`, `newer:` | every other operator |
| values shaped `YYYY-MM-DD`, `YYYY/MM/DD` or `MM/DD/YYYY` | `older_than:`, `newer_than:` — different operators, relative already |
| the operator with a leading `-` (`-after:2026-09-01`) | a value that is already epoch seconds, or anything that does not parse as a date |
| the operator whatever its case (`After:` compiles to `after:`) | anything inside quotes |

The timezone comes from the configuration (`defaults.timezone`), which is `system` unless somebody set
it — and `system` means this machine's IANA zone as the runtime reports it. The compiled instant is
derived from that zone's own offset **on that date**, so a range that straddles a daylight-saving
change is still two local midnights and not one local midnight and one 01:00.

### Why this matters for "yesterday"

Take Europe/London in September, which is UTC+1, and a user asking on the 18th for anything since
yesterday.

- You write `after:2026-09-17`.
- Gmail, left alone, reads that as midnight Pacific: 2026-09-17T07:00:00Z, epoch `1789628400`.
- The package compiles it to local midnight in London: 2026-09-16T23:00:00Z, epoch `1789599600`.

The difference is eight hours, and it is eight hours at the start of the window, so the unrewritten
query silently drops everything that arrived between midnight and eight in the morning — the early mail
that is usually the reason somebody asked. The rewrite is not a nicety; it is the difference between
"nothing came in overnight" being true and being an artefact.

Two consequences worth stating to a user rather than assuming:

- **A bound is the start of a day, not a moment in it.** `after:2026-08-01 before:2026-09-01` runs from
  local midnight opening the 1st of August to local midnight opening the 1st of September, so it covers
  August and excludes the 1st of September entirely.
- **`MM/DD/YYYY` is American order.** `03/04/2026` compiles to 4 March, not 3 April. Where a user's
  intent could go either way, write `YYYY-MM-DD` and there is nothing to misread.

### Reading the rewrite back

Every search result echoes what happened:

| Field | What it is |
|---|---|
| `query.given` | the string you passed, unchanged |
| `query.compiled` | the string Gmail actually received |
| `query.timezone` | the zone the dates were resolved in |
| `query.rewrites` | one entry per rewritten operator: `{operator, from, to}` |

If you wrote a date and `rewrites` is empty, the rewrite did not happen, and the search ran on Gmail's
timezone rather than the user's. There are three ways that occurs, and all three are silent:

1. The value did not parse as a date — a typo, a two-digit year, a month name.
2. The configured timezone is not a name the runtime knows. `query.timezone` still reports it; the
   compile step gives up and leaves the operator alone.
3. The token was swallowed by a quote. The tokeniser treats both `"` and `'` as quote characters
   anywhere in a token, so an apostrophe in `subject:sam's` opens a quoted run that continues to the
   next apostrophe, or to the end of the string. Everything inside it — including a later `after:` — is
   one token and is passed through untouched. If a query contains an apostrophe and a date, check
   `rewrites` rather than assuming.

Whitespace is normalised as a side effect of tokenising: runs of spaces, tabs and newlines in the query
become single spaces in `compiled`. That changes nothing about matching, but it is why `given` and
`compiled` can differ on a query with no dates in it.

## Everything else is Gmail's language, passed verbatim

Nothing validates operators, label names or values. The package does not know which operators exist.
This is deliberate — rewriting more would be guessing at intent — and it has one consequence that
catches people out:

```text
form:sam invoice
```

There is no `form:` operator. Gmail does not reject this; it searches for the text `form:sam` alongside
`invoice`, finds nothing, and returns an empty page that looks exactly like "Sam never sent an invoice".
The same is true of `lable:clients`, of `has:attachments` (the operator is singular), and of a real
operator with a value that does not exist — `label:Clients` where the label is spelled `clients`
matches nothing rather than erroring.

So an empty result is evidence about the query before it is evidence about the world. Before reporting
an absence, re-read `query.compiled` and confirm the label names with `gmail_labels_list` (CLI:
`agent-gmail labels --inbox <alias>`).

## Operators worth knowing

Each of these is Gmail's, not this package's, and each goes through untouched.

| Operator | What it matches | Example |
|---|---|---|
| `from:` | the sender: a name, an address or a domain | `from:sam@partner.test` |
| `to:` `cc:` `bcc:` | a recipient in that field | `to:me cc:ana@partner.test` |
| `subject:` | words in the subject line | `subject:invoice` |
| `"…"` | an exact phrase anywhere in the message | `"phase 2 plan"` |
| `+` | a word with no stemming or synonyms | `+invoice` |
| `AROUND n` | two terms within n words of each other | `"phase 2" AROUND 5 pricing` |
| `OR` or `{ }` | either side matches; bare `OR` must be capitalised | `{from:sam from:ana}` |
| `-` | negation, of a word or of any operator | `invoice -label:archive-2026` |
| `( )` | grouping, so a negation or an `OR` binds where you meant | `from:sam (invoice OR receipt)` |
| `has:attachment` | carries a real attachment | `from:ana has:attachment` |
| `has:drive` `has:document` `has:spreadsheet` `has:presentation` | carries a Drive link of that kind | `has:drive newer_than:30d` |
| `filename:` | an attachment's name or extension | `filename:pdf` |
| `label:` | a label, by the name Gmail shows | `label:clients` |
| `in:` | a place: `inbox`, `sent`, `drafts`, `anywhere`, `spam`, `trash` | `in:anywhere from:sam` |
| `is:` | a state: `unread`, `read`, `starred`, `important`, `snoozed` | `is:unread in:inbox` |
| `category:` | a tab: `primary`, `updates`, `promotions`, `social`, `forums` | `category:primary is:unread` |
| `after:` `before:` | an absolute date — the rewritten pair | `after:2026-08-01 before:2026-09-01` |
| `older:` `newer:` | the same thing, other spelling — also rewritten | `newer:2026/09/01` |
| `older_than:` `newer_than:` | a relative age in `d`, `m` or `y` — not rewritten | `newer_than:7d` |
| `larger:` `smaller:` | message size | `larger:5M` |
| `list:` | a mailing-list address | `list:announce@example.com` |
| `deliveredto:` | the address in the `Delivered-To` header | `deliveredto:jo@example.com` |
| `rfc822msgid:` | the original `Message-ID` header | `rfc822msgid:<abc@example.com>` |

A value with a space in it needs quotes: `subject:"phase 2"`, not `subject:phase 2`, which searches for
the word `phase` in the subject and the word `2` anywhere.

## Combining, negating, grouping

Terms are ANDed by default: `from:sam invoice` means both. The three things that change that shape:

**Negation** is a leading `-`, and it takes an operator as happily as a word. `-from:me` is the useful
one — it turns "anything about Phase 2" into "anything about Phase 2 that I did not write", which is
what a user means when they ask whether anyone ever replied.

**OR** must be capitalised when written as a word; lower-case `or` is searched for as text. The brace
form is equivalent and harder to get wrong: `{from:sam from:ana}` is "from either". Mixing OR with an
implicit AND without brackets is where queries quietly stop meaning what they look like —
`from:sam invoice OR receipt` binds as `from:sam AND (invoice OR receipt)` in Gmail's reading today,
but writing the brackets costs nothing and removes the question.

**Grouping** with `( )` matters most around a negation. `-(invoice OR receipt)` excludes both;
`-invoice OR receipt` excludes one and then ORs the other back in.

Because none of this is parsed locally, an unbalanced bracket or a stray brace is not an error here —
it goes to Gmail, which does its own thing with it, usually matching nothing.

## Two switches that are not query text

- `includeSpamTrash` (CLI `--include-spam-trash`) is an argument to the search call, not part of the
  query. It adds spam and the bin, which a plain query never searches.
- `in:anywhere` inside the query asks Gmail for something similar from its own side.

Use one of them and know which you used, so that "I searched everywhere" has a definite meaning when
you say it. Two other arguments shape the result rather than the match: `kind` (`threads`, the default,
or `messages`) and `limit` (default 20, capped at 50).

One consequence of the rewrite worth knowing when paging: the cursor is bound to a hash of the
**compiled** query and the kind, and to the list of mailboxes — compared in order, and only sorted when
`inboxes` was omitted or `all`, so naming the same mailboxes in a different order is a different cursor. An
absolute date compiles to the
same epoch tomorrow as it did today, so a cursor keeps working; changing the timezone configuration
between pages does not, and the cursor is refused with `CURSOR_MISMATCH` rather than quietly mixing
two result sets.

## From what a user says to a query

The work is almost always the same two moves: a vague time becomes an explicit bound, and a vague
person becomes a sender.

| What the user says | The query | Why |
|---|---|---|
| "anything from Sam about the invoice last month" | `from:sam invoice after:2026-08-01 before:2026-09-01` | "last month" means different things on the 1st and the 30th; the dates are what the user can check |
| "the PDF Ana sent me last week" | `from:ana has:attachment filename:pdf newer_than:7d` | relative ages need no rewrite, so there is nothing to explain about timezones |
| "did anyone ever reply about the Phase 2 plan?" | `subject:"Phase 2" -from:me` | the negation is what makes it a question about replies |
| "unread client mail still in my inbox" | `label:clients is:unread in:inbox` | confirm the label's spelling first; a wrong one looks like an empty inbox |
| "the contract, I think it was a big attachment" | `has:attachment larger:5M contract` | size is a good discriminator when the date is not known |
| "that message from the accountant, sometime in the spring" | ask | a three-month guess is a search that gets run twice; one question is cheaper |
| "everything from that domain" | `from:partner.test` | `from:` matches a domain as well as an address |
| "the one with the reference number in it" | `"INV-20418"` | quote it, or Gmail may stem or split it |

## Before you report an absence

Four checks, in the order they most often find the problem:

1. Read `query.compiled`. It is what ran.
2. Read `query.rewrites`. A date operator that is not in there was not rewritten — see the three silent
   cases above.
3. Confirm any `label:` name against `gmail_labels_list`. Names are case-sensitive in the operator and
   a near miss matches nothing.
4. Check `complete` and `errors`. A mailbox that failed to authenticate returns no rows and the rest of
   the search still looks like a whole answer.

Then say what you ran, not just what you found: "no rows for `from:sam invoice after:2026-08-01` in
`work` and `personal`" is checkable, and "Sam never sent an invoice" is not.

## Where this lives in the code

`packages/gmail/src/domain/query.ts` holds the tokeniser, the date parsing, the local-midnight
calculation and the list of rewritable operators; `packages/gmail/src/operations/search.ts` holds the
compile call, the cursor hash, the merge across mailboxes and the `returned` / `estimatedTotal` /
`hasMore` distinction. Nothing else in the package inspects a query.

See also `references/body-pipeline.md` for what happens to a message once a search has found it.
