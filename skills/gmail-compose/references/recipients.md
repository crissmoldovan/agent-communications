# Who a reply goes to

The rules that turn one original message into a draft's `To`, `Cc`, subject and threading headers, in
the order they are applied, with the three modes worked through against real headers. Open it before
explaining a recipient list to a user, when a reply-all produced somebody unexpected or dropped
somebody expected, or when you need to say what a forward does and does not carry.

Nothing here is guessed and nothing is read out of a message body. Every address comes from a header on
the original, or from the mailbox, or from you passing it explicitly.

## What goes in

Five headers from the original, parsed into `{name, address}` pairs — groups expanded, entries without
an address dropped, addresses lower-cased with the domain in punycode, duplicates removed in their
original order:

| Header | Used for |
|---|---|
| `From` | the fallback for who a reply goes to |
| `Reply-To` | where a reply goes when it is set |
| `To`, `Cc` | the extra recipients of a reply-all |
| `Subject` | the base of the new subject, with prefixes stripped |
| `Message-ID`, `References` | the threading headers |

Plus one thing from the mailbox: its **own addresses**. That is the connected address, together with
every send-as address Gmail returns for it, all lower-cased. The send-as lookup needs one extra
permission and is allowed to fail quietly; when it does, the list is the mailbox address alone, and a
reply-all keeps the user's aliases as recipients. If a reply-all kept an address the user thinks of as
theirs, that is the first thing to check.

## The rules, in order

1. **`Reply-To` replaces `From`.** If the original carries one or more `Reply-To` addresses, those are
   the sender for this purpose. Otherwise it is the single `From` address.
2. **Strip the subject prefixes, then add one.** A leading run of `Re:`, `Fw:`, `Fwd:`, `Aw:`, `Sv:`,
   `Vs:` and `Rv:` — in any mixture, any case, with or without a `[2]` counter — is removed, and then
   `Re:` (or `Fwd:` for a forward) is put on the front. A twelve-message chain stays
   `Re: Phase 2 plan`.
3. **Drop the mailbox's own addresses** from the sender list, and from the original's `To` and `Cc`.
4. **`To` is the sender.** For a plain reply that is the whole recipient list; `Cc` is empty.
5. **`Cc` is everyone else, for a reply-all only.** The original's `To` and `Cc`, less the mailbox's own
   addresses, less anyone already in the new `To`, deduplicated.
6. **If step 3 emptied the sender list, put it back.** Unfiltered. See the self-reply case below.
7. **Thread it.** `In-Reply-To` is the original's `Message-ID`; `References` is the original's
   `References` plus that `Message-ID`, deduplicated; the draft is saved into the original's thread.
8. **A forward skips 4 to 7 entirely.** Empty `Cc`, no `In-Reply-To`, no `References`, no thread, and
   `to` must be supplied.
9. **Anything you pass explicitly replaces what was computed** — field by field, not as a whole. See
   "Overriding" below.

## Why `Reply-To` wins

Because that is what every mail client does, and because mailing lists do not work otherwise: the list
posts as one address and takes replies at another, and a client that answered the `From` address would
send every reply to the list software rather than to the list.

The same mechanism is how somebody redirects an answer to an address of their choosing while the
message still appears to come from a name the reader trusts. The package will not resolve that for you,
because both cases look identical in the headers. What it does instead is refuse to be quiet about it:
when `Reply-To` differs from `From`, the draft comes back with a warning naming the addresses the sender
asked for. Repeating that warning to the user is not optional politeness; it is the whole point of
computing the recipients in a place where a warning can be attached.

## Worked example

One original, in a mailbox `work` whose own addresses are `jo@example.com` and `jo.alias@example.com`:

```text
From:        Sam Lee <sam@partner.test>
Reply-To:    phase2-list@partner.test
To:          jo@example.com, ana@partner.test
Cc:          finance@partner.test, jo.alias@example.com
Subject:     Re: Phase 2 plan
Message-ID:  <CA+abc123@mail.partner.test>
References:  <first@mail.partner.test> <second@mail.partner.test>
```

### `mode: "reply"`

| Field | Value | Why |
|---|---|---|
| To | `phase2-list@partner.test` | `Reply-To` replaced `From`; Sam's own address is not a recipient |
| Cc | empty | a plain reply copies nobody |
| Subject | `Re: Phase 2 plan` | the existing `Re:` was stripped before one was added |
| In-Reply-To | `<CA+abc123@mail.partner.test>` | |
| References | `<first@…> <second@…> <CA+abc123@…>` | the chain, plus the message being answered |
| Thread | the original's | |
| Warning | the sender asked for replies to go to `phase2-list@partner.test`, not to the address it came from | |

Ana and finance hear nothing. If the user believes they are answering Sam, the draft disagrees with
them, and the preview is where they find that out.

### `mode: "reply_all"`

| Field | Value | Why |
|---|---|---|
| To | `phase2-list@partner.test` | as above |
| Cc | `ana@partner.test`, `finance@partner.test` | the original `To` and `Cc`, less the mailbox's own two addresses |
| Subject, threading | as above | |

`jo@example.com` was on the original `To` and `jo.alias@example.com` was on the `Cc`; both are gone.
Without that filter the user's own reply arrives in their inbox looking like a message from a stranger
who shares their name, and — worse — every subsequent reply-all in the thread carries them twice.

### `mode: "forward"`

| Field | Value | Why |
|---|---|---|
| To | whatever you pass; required | nobody can be computed |
| Cc | empty | |
| Subject | `Fwd: Phase 2 plan` | |
| In-Reply-To, References | none | |
| Thread | none — a new conversation | |

A forward inherits nothing on purpose. Inheriting the thread would file the message alongside a
conversation its new readers cannot open; inheriting the recipients would send it back to the people it
came from, which is the accident that makes a private forward public. If `to` is missing and nothing
else is supplied, the call fails with `REPLY_INVALID` and a hint saying a forward needs recipients.

## The edges

**Replying to yourself.** The user reads a message they sent, and asks for a reply to it. The sender
list is their own address, step 3 empties it, and step 6 puts it back unfiltered. The draft goes to the
user. That is deliberate: a draft with no recipient at all is refused with `REPLY_INVALID`, and a note
to yourself is the more useful answer than an error. On `reply_all` the original's other recipients are
still computed into `Cc`, so the draft reads `To: you, Cc: the people you originally wrote to` — check
that against what the user meant before showing it as normal.

**A message with no `From` and no `Reply-To`.** Nothing can be computed for `To`. A plain reply then
has no recipients at all and is refused; a reply-all may still produce a `Cc` from the original's
recipients, which is enough to pass the check and leaves a draft with an empty `To`. The preview shows
`To: none`, and that is a stop sign rather than a formatting quirk.

**Overriding.** `to`, `cc` and `bcc` substitute for the computed value of that field, each on its own.
Passing `to: ["sam@partner.test"]` on a reply-all answers Sam — and keeps the computed `Cc`, so the
whole list is still copied. If the user says "just Sam, not the whole list", pass `to` **and**
`cc: []`. `bcc` is never computed; it is empty unless you pass it.

**The `Reply-To` warning fires on a forward too.** It is derived from the original's headers, not from
what was done with them. On a forward the recipients came from the user, so the warning is context
rather than a correction — say so rather than implying the forward was redirected.

## The quoted original

Unless `quote` is false, the original is quoted below the new text, in both the plain and the HTML
parts. What goes in:

- An attribution line. For a reply, `On <date>, <the raw From header> wrote:`. For a forward,
  `---------- Forwarded message ----------` followed by `From:`, `Date:`, `Subject:`, `To:` and, when
  present, `Cc:` — restated because a forwarded quote without them is orphaned text.
- The original's body as **sanitised text**, up to 4,000 characters, with the original's own quoted
  history collapsed.

It is the sanitised text rather than the original's HTML for one reason and it is not aesthetic: the
original's markup belongs to whoever sent it. It can carry a tracking pixel, a form, or text hidden
from the reader, and forwarding it would put the user's name on somebody else's beacon. The outbound
analyser would refuse the draft anyway — a generated message containing a remote resource, a form, a
script or hidden text fails with `UNSENDABLE_HTML` rather than being quietly cleaned. Quoting the text
loses the original's formatting, and that is the right trade.

Three consequences to say out loud when they apply:

1. **The collapse marker is sent.** If the original had quoted history of its own, the quote contains a
   line reading `[quoted: N lines omitted — pass includeQuoted to see them]`, prefixed with `>` like
   the rest. The recipient sees it. On a long chain where that would read as noise, turn the quote off
   and paste the part that matters into your own text instead.
2. **The 4,000-character cut is silent.** A long original is simply shorter in the quote, with no
   marker where it stops.
3. **An original with no quotable text produces no quote at all** — a message that was entirely an
   image, or whose body sanitised to nothing. A forward in that state carries only what you wrote, and
   the recipient has no idea what is being forwarded. Check the preview for the quote before handing a
   forward over.

**Attachments are not carried by a quote.** A forwarded message does not bring the original's files
with it. If the user needs the attachment forwarded, it has to be downloaded and attached — which is a
different skill and a jail check, not something the reply path does.

### What an update does to the quote

`gmail_draft_update` rebuilds the message from what it is given plus what the draft already had. It has
no `quote` argument and it does not look at the original message, so:

- **Pass new `text` and the quote is gone.** The draft is rebuilt from your text alone. If the reply is
  meant to keep the original below it, the new `text` has to contain it, or the revision has to be made
  as a fresh `gmail_draft_reply`.
- **Omit `text` and the old body is reused verbatim** — quote and signature included — and the
  mailbox's signature is then appended to it a second time, because the rebuild adds a signature to
  whatever text it is handed. Check the preview after an update that only changed a recipient.

Recipients, subject and attachments survive an update untouched when they are not restated.

## What the preview proves

The draft result carries the computed `to`, `cc` and `bcc` as arrays, and a rendered `preview` that
lists them twice: once above the body and once after it, because a long message scrolls the header
lines out of view and the recipients are what is being approved. The quoted original appears in the
preview body, so what you see is what would go.

The `warnings` array is the tool's own reading of the recipient list:

| Warning | Raised when |
|---|---|
| the sender asked for replies to go elsewhere | `Reply-To` differs from `From` |
| goes outside your organisation | any recipient's domain is not one of the mailbox's internal domains |
| blind recipients, who the others cannot see | `bcc` is not empty |
| an attachment total over 25 MB | some recipients will not receive it |

Name each of them in plain words. A recipient list that survives the preview unchallenged is the user's
decision; one that is summarised instead of shown is yours.

## Where this lives in the code

`planReply` in `packages/gmail/src/domain/compose.ts` holds rules 1 to 8;
`replyDraft` in `packages/gmail/src/operations/drafts.ts` applies the overrides, builds the quote with
`quoteOf`, raises the warnings and writes the draft. `ownAddresses` in
`packages/gmail/src/operations/analyse.ts` is the list of addresses treated as the user's own.

**Two corrections to the procedure that points here.** The SKILL text says a forward "carries only the
body you wrote — not the original text". That was true before quoting existed. It quotes the original's
sanitised text by default now, and a forward sent with `quote: false` is the case that carries nothing;
the half that still holds is attachments, which never travel. The SKILL text also says `text` is
required on every update and that an update without `attach` comes back with nothing attached. Neither
is true any more: `text` is optional, and attachments are carried over by their bytes unless `attach`
replaces them. Restating them does no harm, so the procedure is safe to follow — it is just no longer
the reason.

See also `references/profile.md` for how the message itself should read.
