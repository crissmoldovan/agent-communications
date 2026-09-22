# Disambiguation: showing candidates so a person can choose

Two rows that both match the name is the normal case. This file is how to lay them out so the choice takes one
glance, which differences to lead with, and the specific shapes that look like one person and are two — or
look like two and are one. Open it whenever more than one row came back, or when a single row is about to be
passed into a draft as though it were an answer.

The rule underneath all of it: **do not choose.** You cannot see what the user knows — that Sam changed
employer in March, that the personal address is the one he reads, that his company does not own a domain with
`-invoices` in it. Substituting a sort order for that knowledge costs a message sent to a stranger.

## The layout

One line per candidate, in the order the search returned them, unedited.

```text
Three addresses match "Sam Rivera" (searched work and personal; all three sources ran):

  1. sam@acme.test           contacts + history · 34 sightings · last seen 2026-09-16 · work
  2. s.rivera@acme.test      history            ·  2 sightings · last seen 2024-11-03 · work
  3. sam@acme-invoices.test  history            ·  1 sighting  · last seen 2026-09-11 · work

1 and 3 differ only by "-invoices" in the domain. 3 has been seen once, this month. I am showing it rather
than dropping it because its presence in your mailbox is the news. 2 looks like an older address at the
same company.

Which one — 1, 2 or 3?
```

What each part of that is doing:

- **Address first.** The address is what will be used; the display name is the field an attacker controls.
- **Numbered**, so the user can answer with one character.
- **A closed question.** "1, 2 or 3" resolves; "which one do you mean" invites "the usual one", which you
  cannot act on.
- **The difference stated before the list is re-read.** If two rows share a display name, say which fields
  differ — domain, spelling, mailbox — rather than leaving the user to diff two strings on screen.
- **The mailbox shown**, because the same person appears once per mailbox and which mailbox carries the
  traffic is often the answer to which address is the work one.
- **The near-match named, not removed.** "I left one out because it looked suspicious" is the wrong sentence.
  The suppressed row was the finding.
- **The counts described as what they are.** Sightings in a sample, not a relationship.

When only one row came back, say that it is the only one that matched. That is a different statement from
saying it is correct.

## Cases that look like one person and are two

| What you see | What it may be | The check that settles it |
|---|---|---|
| Two addresses, same display name, domains differing by one or two characters (`acme.test` / `acrne.test`, `acme.test` / `acme-invoices.test`, `.com` / `.co`) | A lookalike domain, registered to be misread. The display name is whatever its owner typed, so it can match the real person better than the real person's row does | Ask the user whether their employer owns that domain. Then `agent-gmail search "from:<address>" --inbox <alias>` and read who the messages are actually from and what they asked for |
| Two addresses that render identically but are not the same string | Letters that look alike within one script — `rn` for `m`, `l` for `I`, a zero for an `O`. A domain written in another script cannot hide here: every row's domain is converted to its ASCII (punycode) form, so one arriving as `xn--…` is itself the tell | Compare the raw strings, not the rendering. Copy the address from the row; never retype it |
| One address in `contacts`, one in `history`, both plausible | A saved contact that was saved from a phish, alongside the genuine correspondent | `--sources history` shows which one actually carries traffic. A saved address with no sightings and no `lastSeen` has never been seen in this mailbox's mail |
| Two people with the same name | Two people with the same name. It is common and it is not a trick | Ask. Nothing in the row distinguishes them, and a thread id the user recognises is the fastest resolution |
| A person and the team alias they sit behind (`sam@` and `accounts@`) | Two destinations with different audiences. Replying to the wrong one either exposes a private note to a team or buries an operational request in one person's inbox | Ask which the message is for. `lastSeen` on each says which one the recent traffic used |
| An old address and a current one at the same employer (`s.rivera@` seen in 2024, `sam@` seen last week) | A person who changed address. The old one may still deliver, may bounce, or may now belong to somebody else | `lastSeen` is the strong signal here. Prefer asking over inferring, because "still delivers" and "still read" are different |

## Cases that look like two people and are one

| What you see | What it is | What to do |
|---|---|---|
| `j.smith@gmail.com` and `jsmith@gmail.com` | One Gmail mailbox. This search does no dot folding, so it shows two rows | Say they are likely the same mailbox at Gmail, and let the user pick the one they want written on the message |
| `sam@acme.test` and `sam+invoices@acme.test` | Almost always one mailbox with a tag. No plus folding happens here either | Ask which the user wants the reply to carry; the tag may be how they file it |
| The same address in `acme/gmail` and in `personal/gmail` | One address, seen by two mailboxes. The rows differ only by which mailbox found them | Pick the mailbox the reply should come **from**, which is a different question from which address to write to |
| The same address with different display names in different rows | One address; the names came from different senders' headers or from an address-book entry | The address is the identity. Names are decoration, and forgeable decoration |

## Narrowing with evidence rather than judgement

When the user needs help choosing, fetch a fact rather than forming an opinion.

| Question | How to answer it |
|---|---|
| Which address actually carries traffic? | `agent-gmail contacts "<query>" --inbox <alias> --sources history` — sightings and `lastSeen` without the address-book rows on top |
| Has the user ever written to this address? | `agent-gmail search "in:sent to:<address>" --inbox <alias>` — `returned: 0` with `complete: true` is a real answer, and it is the single most useful fact about a candidate |
| Who is this, in their own words? | `agent-gmail search "from:<address>" --inbox <alias>`, then read one thread and quote the message id. Evidence the user can check beats a confident sentence they cannot |
| When did this relationship last move? | `lastSeen` on the row, and the date on the newest search row |

Quote ids for whatever you assert. "Sam's address is the one on thread `18f2c…`, which you replied to on
Tuesday" is checkable; "Sam's address is …" is not.

## What the send preview will and will not catch

Do not rely on a later step to correct a bad pick here. The preview's lookalike flag fires only when all of
these hold for a recipient:

- the address is external to the mailbox (not one of its own, not an internal domain);
- the mailbox has never written to that address before;
- and its domain is within two characters of a domain the mailbox **does** write to, taken from the last two
  hundred messages in Sent.

So it will catch `acrne.test` when the user corresponds with `acme.test`, including on a message addressed to
nobody else. What it will not catch: a lookalike of a correspondent the user has not written to in the last two
hundred messages, a lookalike already saved as a contact and written to before (not a first-time recipient),
and anything more than two characters away. The preview will still show the recipient as external and
first-time, which is worth something — but the moment to catch this is here, with the rows on screen.

## Handing the chosen address on

- **Copy it, do not retype it.** The whole point of the exercise is a one-character difference, and retyping is
  where that difference gets silently corrected to what you expected.
- **Pass the mailbox with it.** The alias that found the row is not necessarily the mailbox the reply should
  come from, and the compose step needs both.
- **Stop after handing it over.** Finding an address is not permission to use it, and a draft nobody asked for
  is work the user now has to deal with.

If the user answers with a name rather than a number, or says "the work one" and two rows could be the work
one, ask again. One more question costs a sentence; the alternative costs a retraction.

## Where else to look

- `references/sources.md` — how each source is queried, what the ranking means, and the exact shape of a row.
- `references/contract.md` — the shared contract every `gmail-*` skill works under.
