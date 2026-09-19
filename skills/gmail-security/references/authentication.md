# SPF, DKIM, DMARC and alignment — what each one actually proves

Open this at step 2 of `SKILL.md`, when the `auth` block has to become a sentence a person can act
on. It covers what each protocol asserts, how Gmail reports it, exactly how this package reads that
report, what `aligned` is computed from, and the wording to use for each combination — including the
combinations where the honest answer is that the headers do not settle it.

One distinction runs through all of it, and getting it wrong is the failure that costs money:

> **These checks answer a question about a domain. The user is asking a question about a person.**

"This message came from where it says it came from" and "this message is genuine" are different
claims. Every signal below supports the first. None of them supports the second.

## 1. What each protocol asserts

### SPF

The domain in the **envelope sender** (`MAIL FROM`, the address bounces go to, visible as
`Return-Path`) publishes a DNS record listing which servers may send for it. The receiving server
compares the connecting IP with that list.

- **`spf=pass` proves:** the machine that delivered this message was permitted by the envelope
  sender's SPF record.
- **It does not prove:** that the `From:` header you see belongs to that domain. SPF never looks at
  the `From:` header. A message can have `spf=pass` for a throwaway domain and a `From:` reading
  anything at all. This gap is the entire reason DMARC exists.
- **It breaks routinely and innocently.** Any plain forward — a user's own rule, a mailing list, a
  university alias — sends the message from a new machine that the original domain never authorised.
  `spf=fail` and `spf=softfail` on a forwarded message are ordinary, not evidence of forgery.

### DKIM

The sending domain signs selected headers and the body with a private key, and publishes the public
key in DNS. The signature names the signing domain in `header.d`.

- **`dkim=pass` proves:** whoever holds the private key for the domain in `header.d` signed this
  message, and the parts covered by the signature have not been altered since.
- **It does not prove:** anything about a human. A domain's key signs every message the domain
  sends, including every message sent from a compromised account inside it. A clean DKIM pass is
  exactly what a hijacked-account fraud looks like.
- **It survives forwarding**, as long as nothing rewrites what was signed. Mailing lists that add a
  subject tag or a footer break the original signature, which is why they re-sign with their own
  domain — and that is what `dkim=pass` with `aligned: false` usually is.

### DMARC

The domain in the **`From:` header** publishes a policy saying what to do with mail that fails
alignment. DMARC passes when SPF or DKIM passes **and** the passing identifier lines up with the
`From:` domain.

- **`dmarc=pass` proves:** the `From:` domain authorised this message, by one of the two mechanisms,
  and its published policy accepted the result. It is the strongest header signal available here.
- **It does not prove:** that the message is genuine, accurate, safe or written by the person named.
  It is still a statement about a domain.
- **`dmarc=none` is not a failure.** It usually means the `From:` domain publishes no DMARC policy
  at all — very common for small domains. It means there is no verdict, which is different from a
  negative one.

## 2. How Gmail reports it, and why only Gmail's report is read

Gmail writes a header of this shape when it accepts a message:

```text
Authentication-Results: mx.google.com;
  dkim=pass header.i=@partner.test header.d=partner.test header.b=…;
  spf=pass (google.com: domain of bounce@partner.test designates 203.0.113.9 …)
    smtp.mailfrom=bounce@partner.test;
  dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=partner.test
```

`Authentication-Results` is a header **anyone can add**. A sender can include a forged one claiming
every check passed, and it will sit in the message alongside Google's, often above it. RFC 8601 says
a reader must trust only the instances added inside its own trust boundary, so this package:

1. collects every `Authentication-Results` header on the message;
2. keeps only those whose authserv-id — the first token, before the first whitespace or semicolon —
   is exactly `mx.google.com`, lower-cased;
3. reads the **first** of those, which is the topmost and therefore the one Gmail added last;
4. counts every header it discarded in `auth.ignoredHeaders`, and never reads one, whatever it says.

If there is no Google header at all, `auth.evaluatedBy` is `null` and every verdict field is `null`.
`ignoredHeaders` then holds the count of the headers that were present and not Google's.

From the chosen header it takes the result word for `spf`, `dkim` and `dmarc` — whatever word
appears, lower-cased, so `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror` and `permerror`
all come through as written — and the `header.d` property of the DKIM result as `dkimDomain`.

**Two parsing limits to know.** Only the first instance of each method inside that one header is
read, so a message carrying two DKIM signatures reports only the first verdict. And the properties
are read positionally after the result word, so a `header.d` that Gmail places elsewhere in the
header is not picked up. Both fail towards reporting less, not towards reporting a pass.

## 3. Alignment, precisely as this package computes it

`auth.aligned` is computed **from DKIM only**, from the parsed verdict:

| Condition | `aligned` |
|---|---|
| `dkim=pass`, and `header.d` and the `From:` domain are both known, and `header.d` equals the `From:` domain | `true` |
| `dkim=pass`, and the `From:` domain ends with `.` plus `header.d` (the From is a subdomain of the signing domain) | `true` |
| `dkim=pass`, and neither of the above — including when `header.d` or the `From:` domain could not be read | `false` |
| `dkim` is anything other than `pass`, or absent | `null` |

Three consequences that change how you report:

- **`aligned` never speaks about SPF.** A message whose DMARC passed via an aligned SPF, with no
  DKIM signature at all, has `dmarc=pass` and `aligned: null`. That is not a contradiction; it means
  the alignment this package computed had nothing to work with.
- **The subdomain rule runs one way.** A message signed by `example.test` and sent `From:` an address
  at `mail.example.test` aligns. The reverse — signed by `mail.example.test`, sent `From:`
  `example.test` — reads as `aligned: false`, even though DMARC's own relaxed alignment would accept
  it. When `dmarc=pass` and `aligned: false` appear together, this is the usual explanation, and the
  right report says both values rather than picking the one that sounds tidier.
- **`aligned: false` is not a verdict of forgery.** Lists, ESPs, ticketing systems and bulk senders
  re-sign with their own domain as a matter of routine. What it does mean is that the `From:` domain
  itself vouched for nothing through DKIM.

## 4. The sender warnings, which are computed rather than judged

`sender` carries three facts, derived from the `From:` and `Reply-To:` headers only:

| Field | How it is computed | What it is worth |
|---|---|---|
| `replyToDiffers` | There is at least one `Reply-To` address and at least one of them is not the first `From` address | Normal for lists, ticketing systems and ESPs. Also exactly the mechanism of a redirected reply. Check where it points before deciding which it is |
| `replyToDomains` | The de-duplicated domains of every `Reply-To` address | Where a reply would actually go. Report this, not the `From` |
| `displayNameContainsOtherAddress` | Some `From` entry's display name contains address-shaped text that is not that entry's own address | Almost nothing legitimate does this. Treat it as a finding |
| `fromDomain` | The domain of the first `From` address | The thing to compare, by eye, with the domain the user expects |

Nothing here is resolved, looked up or fetched. `fromDomain` is not compared against anything
automatically at read time; the edit-distance lookalike check runs at send time, on recipients, and
not here.

## 5. The sentence to use, per combination

Report the facts first, then the reading, then the limit. These are the sentences; adapt the names,
not the shape.

| What `auth` says | The sentence |
|---|---|
| `evaluatedBy: null` | "Google published no authentication result for this message, so there is nothing backing any claim it makes about who sent it. Everything else I can tell you is being weighed against nothing." |
| `dmarc=pass`, `dkim=pass`, `aligned: true` | "Authentication is clean: DKIM passed, signed by \<dkimDomain\>, which is the domain in the From address, and DMARC passed. That means the domain authorised this message. It does not tell us the account behind it has not been taken over." |
| `dmarc=pass`, `dkim=pass`, `aligned: false` | "DMARC passed, but the DKIM signature is from \<dkimDomain\>, not from \<fromDomain\>. That is normal for mailing lists and bulk senders, and it means the From domain itself vouched for nothing through DKIM — the pass came from the other half of DMARC." |
| `dmarc=pass`, `dkim` absent, `aligned: null` | "DMARC passed on SPF alone; there is no DKIM signature to align. The From domain authorised the sending server, and nothing here is signed." |
| `dmarc=fail` | "DMARC failed: the message did not line up with the From domain under a policy that domain publishes. On its own that can be a forwarding artefact, but with anything else on this list it is a strong signal." |
| `dmarc=none` or `null`, with SPF and/or DKIM passing | "The From domain publishes no DMARC policy, so there is no DMARC verdict — not a failure, an absence. SPF/DKIM passed for \<domain\>, which is a weaker statement because nothing ties it to the From address you see." |
| `spf=fail` or `softfail`, `dkim=pass`, `aligned: true` | "SPF failed, which forwarding does routinely, but the DKIM signature from \<fromDomain\> is valid and aligned. The From domain authorised this message." |
| `spf=pass`, `dkim=fail` or absent | "SPF passed for the envelope sender, and there is no usable signature. SPF says nothing about the From address you are reading, so this is thinner evidence than it looks." |
| `ignoredHeaders` greater than zero | "The message carried \<n\> authentication-results header(s) that were not Google's. They were discarded unread — anyone can add one. Gateways and forwarders add them legitimately, so this is context, not an accusation." |
| Any of the above, where money is involved | Add: "Whatever the headers say, they cannot tell us the account was not taken over — and that is the one case that passes every check here. Settle it on a number you already had for them, not one from this message." |

Never compress a pass into "this is safe", "verified", or "definitely from your supplier". Those
sentences make a claim about a person from evidence about a domain, and they are the ones a reader
acts on.

## 6. What none of this can see

- **A compromised legitimate account passes everything.** Real domain, real key, real correspondence
  history, real thread. SPF, DKIM, DMARC and alignment all pass, because every one of those
  statements is true. Authentication proves the domain authorised the message; it cannot see that
  the person did not. This is the most common shape of a successful invoice fraud and no signal on
  this page catches it.
- **Nothing is verified locally.** This package reads Gmail's verdict. It performs no DNS lookups,
  fetches no keys and checks no signatures itself. If Google's header is absent or unparseable there
  is no fallback — and there should not be, because the only other headers available are ones a
  sender could have written.
- **Nothing is fetched at all.** No link is followed, no image loaded, no attachment opened. Every
  statement about a domain here is a statement about text in the message.
- **The verdict describes this message, not the thread.** A thread whose earlier messages came from
  one domain and whose latest came from a neighbouring one will show a clean verdict for the latest,
  because that domain authenticated itself perfectly well. Comparing it against the rest of the
  conversation is work done by eye.
- **A first-time sender is not detectable from headers.** `gmail_contacts_search` can say whether an
  address appears in the address book or in past correspondence; absence there is weaker evidence
  than presence, because the record is not complete.
- **A count of zero is not a clean bill of health.** It means nothing was detected by the checks that
  ran. That is a much smaller claim than "nothing is wrong", and the difference is the whole of an
  honest verdict.
