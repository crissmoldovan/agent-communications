# Send policies, escalation, caps and the approval record

This is the detail behind step 1 and step 7 of `SKILL.md`. Open it when a send was refused and the
reason is not obvious, when the user asks what their policy actually protects them from, when a
`riskFlags` entry needs explaining, or when an approval is in a state you have not met before. It
describes what the code does, not what would be reasonable — where the two differ, the code wins.

Everything here is decided in three places: `prepareSend` writes an approval record, `claimForSend`
checks it one last time, and the send ledger decides whether there is a slot. Nothing about a policy
is enforced by the Google grant: no OAuth scope separates drafting from sending, so the gate is
entirely in this package's own code.

## 1. The three policies

The policy that applies to a mailbox is its own `sendPolicy`, or `defaults.sendPolicy` when the
mailbox has none. The shipped default is `chat`. `gmail_inboxes_list` (CLI: `agent-gmail inbox list
--json`) reports the one in force, and whether it is inherited.

### `chat`

**What it guarantees.** Nothing leaves unless a `gmail_send_prepare` call has run for *exactly* this
content and produced an approval record, and then only:

- within ten minutes of that prepare;
- once — the claim creates a `<approvalId>.claim` file with `O_EXCL`, which the file system lets
  exactly one process create, so two servers racing cannot both send;
- against the same draft, identified by the draft's Gmail **message id**, which Gmail changes on
  every save, so an edit that restores byte-identical content still voids the approval;
- against the same content digest — a SHA-256 over sender, recipients, `Reply-To`, subject, thread
  and threading headers, the visible text, the SHA-256 of the raw HTML and text parts, and the
  filename, type, size and SHA-256 of every attachment's **bytes**;
- with recipients and subject that match what the draft says, because the send call must pass them
  back and `sameExpectation` compares them;
- from the same mailbox, and the same Google account: the record stores the account id (`sub`) and a
  claim that names a different one, or none at all, is refused rather than trusted;
- under the rate caps (§4);
- with a line in the audit log naming the approval, the draft, the sent message id and the
  canonical recipients.

**What it does not guarantee.** That anyone saw the preview. The server has no view of the
conversation; the only thing it can check is that a prepare happened for this content. Whether the
preview was pasted in full, summarised, or never shown at all is invisible to it. That is why step 2
of `SKILL.md` is written as an obligation rather than a suggestion — under `chat` it is the whole of
the protection, and it is yours.

It also does not guarantee that the user meant *this* message. An "ok" answering a different
question is an approval as far as the code can tell.

### `confirm`

**What it guarantees.** Everything `chat` guarantees, plus: the record must be in state `approved`
before it can be claimed, and it reaches that state only when a person typed a four-character
challenge that was shown to them alongside a freshly re-rendered preview. The challenge is generated
per approval, only its hash is stored, and it is never returned to an agent. Three wrong answers
void the record.

There are exactly two channels:

| Channel | How it happens | What stops an agent using it |
|---|---|---|
| Terminal | The user runs `agent-gmail approve <approvalId>`, reads the preview it prints, and types the code | The command refuses when an agent marker is present in the environment (`APPROVAL_REQUIRED`), and again when there is no interactive terminal |
| Trusted client form | An MCP client raises a form carrying the preview and the code; the person types it back | The client's `clientInfo.name` must already be on `defaults.confirm.elicitationClients`, which is empty by default and can only be added to by a person at a terminal, after that client has passed a probe in the last ten minutes |

An un-allowlisted client asking to send under `confirm` gets `APPROVAL_REQUIRED` with the terminal
command in the hint, and **the record is left pending** — being asked from the wrong client is not
evidence that anything is wrong with the message.

**What it does not guarantee.** That the person who typed the code is the mailbox owner, or that
they read the preview rather than skipping to the prompt. And `SECURITY.md` says the terminal check
is a speed bump, not a boundary: an agent with a shell can make any command believe it has a
terminal. The boundary for that threat is `never`.

### `never`

**What it guarantees.** `prepareSend` throws `POLICY_NEVER` before it reads the draft, so no
approval is ever created. If a mailbox is set to `never` *after* an approval was prepared,
`claimForSend` voids the record with `POLICY_NEVER` as well. Nothing in this package can send from
that mailbox.

**What it does not guarantee.** That mail cannot be sent from the account by other means. The draft
is still in Gmail Drafts and the user can send it from there, which is the point. It also says
nothing about any *other* Gmail MCP server registered with the same client — `doctor`'s
`other-gmail-servers` check exists because such a server offers an ungated send path that none of
this touches.

## 2. How the effective policy is computed

Two values meet, and the stricter one wins. Strictness is ranked `chat` < `confirm` < `never`.

| Value | Where it comes from | When it is read |
|---|---|---|
| Live policy | The mailbox's `sendPolicy`, else `defaults.sendPolicy` | Freshly, at prepare, at approve and again at claim |
| `requiredPolicy` | Stored on the approval record: `confirm` when risk escalation raised any flag, else `chat` — but never lower than the live policy at prepare time | Written once, at prepare; read at approve and at claim |

So the effective policy is `stricter(live policy now, record.requiredPolicy)`, and it is recomputed
at every step rather than trusted from the preview.

Two consequences worth knowing:

- **Loosening the mailbox does not weaken an approval already prepared.** Because the record's
  `requiredPolicy` absorbs the live policy at prepare time, a send prepared while the mailbox was on
  `confirm` still needs a human approval even if someone sets the mailbox to `chat` a minute later.
- **Tightening applies immediately.** Raise the mailbox to `confirm` and a pending `chat` approval
  can no longer be claimed without a typed challenge; set it to `never` and the claim voids the
  record.

Escalation only ever raises to `confirm`. It cannot raise to `never`, and nothing lowers it.

## 3. Risk escalation: every trigger, its evidence, and its blind spots

Escalation runs inside prepare, and only when `defaults.riskEscalation` is true. It is true by
default, and turning it off is classified as loosening a safety setting (`defaults.riskEscalation`),
which needs a person at a terminal. When it is off, no facts are gathered at all: the preview shows
no recipient notes and no flag can fire.

First, the facts it computes for every address in `To`, `Cc` and `Bcc`:

| Fact | How it is decided |
|---|---|
| own | The mailbox's own address, or any address Gmail reports as a verified send-as. Never external, never first-time, never tainted |
| `external` | Not an own address, and its domain is not in the mailbox's configured `internalDomains` |
| written-to | A Gmail search for `in:sent to:<address>` returning up to five messages, whose parsed `To`/`Cc`/`Bcc` are then compared against the address — Gmail's `to:` matching is fuzzy, so a raw hit is not trusted |
| `firstTime` | `external` and not written-to |
| `tainted` | The address, or its domain, is in the taint store — and the mailbox has **not** written to it before |

The preview shows these against each recipient as `EXTERNAL`, `internal`, `FIRST-TIME`,
`ADDRESS SEEN IN MAIL YOU READ` and `LOOKS LIKE <domain>`.

Then the three flags:

| Flag | What fires it | The evidence behind it |
|---|---|---|
| `recipient-tainted` | Any recipient is tainted | The address, or its non-public domain, was seen in the headers or body of a message read, exported or downloaded through this package in the last seven days — from **any** connected mailbox, because a message read in one inbox can ask for a send from another. The mailbox's own addresses and its internal domains are never recorded |
| `attachment-to-first-time-recipient` | The draft has at least one attachment **and** at least one recipient is first-time | Attachment presence comes from the draft's parts; first-time from the `in:sent` check above. The two do not have to be the same recipient |
| `lookalike-domain` | A first-time recipient's domain is within a Levenshtein distance of 2 of a domain already known in this draft | "Known" means: the domain of another recipient of **this same draft** that the mailbox has written to before, or the domain of one of its own addresses |

Any flag sets `requiredPolicy` to `confirm`. All three together set it to `confirm` once — there is
no higher level.

**What escalation cannot see.** Say these out loud when they matter; a clean prepare is not a clean
bill of health.

- **Obfuscated addresses are never tainted.** Taint recording scans text with an address-shaped
  pattern. "x at evil dot test", an address inside an image, or one split across a hidden span is
  not an address to that pattern, so it is never recorded and never escalates.
- **Taint expires after seven days**, and public mailbox providers (`gmail.com`, `outlook.com`,
  `proton.me` and about thirty others) are never tainted at the domain level — only the exact
  address is. An address seen eight days ago escalates nothing.
- **The lookalike check is narrower than it sounds.** It compares a first-time recipient only
  against domains present among the *other recipients of the same draft* that this mailbox has
  corresponded with, plus its own. A message sent to one lookalike address and nobody else has
  nothing to compare against, and the flag does not fire. Comparing the domain with the one the user
  expects is work done by eye, in the preview.
- **The written-to check reads five messages.** Somebody written to once, long ago, behind five more
  recent messages to the same address, is still recognised; somebody whose only correspondence is
  outside those five results may read as first-time. The error is in the safe direction.
- **Nothing reads the body.** A draft whose text says "please wire the money to the new account"
  raises no flag. Escalation is about who a message goes to, not what it says.
- **An internal domain is whatever the mailbox says it is.** `internalDomains` is configuration —
  adding one is a loosening that needs consent — and a recipient in an internal domain is never
  external and therefore never first-time.

## 4. The rate caps

| Property | Value |
|---|---|
| Defaults | 20 per hour, 100 per day (`defaults.sendCaps.perHour`, `.perDay`) |
| Counted per | Immutable inbox id (`ibx_…`), one append-only JSONL ledger per mailbox under the state directory |
| Counted what | Reservations, not successes: a slot is taken just before the send and released if the send fails, or if the final draft check fails |
| Shared by | Every process on the machine — the ledger is read from disk under a lock, never from memory, so two MCP server copies cannot each get a full allowance |
| Window | Sliding, not calendar. The hour count is every un-released reservation newer than one hour; the day count is every un-released reservation newer than 24 hours. Lines older than 24 hours are ignored entirely |
| Reset | `resetAt` in the error: the oldest reservation in the breached window plus one hour (or plus one day). There is no midnight reset and no top-up |
| On breach | `RATE_CAPPED` (exit 10), retryable in principle, and the approval it was reserving for is completed as `failed` |

Renaming a mailbox does not reset the count, because the ledger is keyed by the id rather than the
alias. Removing and re-adding one does, because that mints a new id — which is worth knowing and not
worth suggesting. Raising the caps is classified as loosening `defaults.sendCaps` and needs a person
at a terminal; lowering them needs nothing.

## 5. The ten-minute lifetime

An approval is created with `expiresAt` ten minutes after `createdAt`, and the value is returned by
prepare. Two details matter:

- **Expiry is derived, not scheduled.** A `pending` or `approved` record past its deadline simply
  *reads* as `expired` the next time anything looks at it. Nothing runs in the background, so an
  approval does not become dangerous by being forgotten — but neither does it disappear from the
  state directory.
- **The clock does not restart.** Approving under `confirm` does not extend the window; the person
  has the remainder of the same ten minutes to type the code and the agent to call the send.

Preparing again is free and is the correct response to almost every refusal: each prepare is its own
record with its own digest and its own ten minutes. What is not free is leaving the old one pending,
which is why step 8 of `SKILL.md` says to cancel it (`gmail_send_cancel`, CLI `agent-gmail send
cancel <approvalId>`). `gmail_send_list` (CLI: `agent-gmail send list`) shows what is still open.

## 6. The record state machine

```text
pending ──approve (confirm)──▶ approved ──claim──▶ sending ──▶ used
   │                               │                  │
   └──────claim (effective chat)───┘                  ├──▶ failed
                                                      └──▶ unknown (derived)
pending | approved ──▶ revoked        pending | approved ──▶ expired (derived)
```

| State | What it means to a person |
|---|---|
| `pending` | Prepared and waiting. Nothing has been sent. Under `chat` it can be claimed now; under `confirm` it is waiting for somebody to type a code |
| `approved` | A person typed the challenge for this exact content. Nothing has been sent yet; the send still has to be called |
| `sending` | A process is sending it right now. Drafts refuse edits and deletion while a record for them is in this state |
| `used` | It was sent, once. The record carries the sent message id. This approval can never be used again |
| `failed` | The one send attempt returned an error. **Whether the message arrived is not known from here** — a send is never retried, because a retry can deliver twice |
| `unknown` | A process died mid-send: the record sat in `sending` for five minutes without recording an outcome. Same uncertainty as `failed`, with less information |
| `expired` | The ten minutes passed with nobody using it. Nothing was sent. Prepare again |
| `revoked` | Voided or cancelled. The record's `reason` says which: the user cancelled it, the draft changed, the recipients or subject did not match, it named another mailbox or another Google account, the mailbox moved to `never`, three wrong challenge answers, or another process claimed it first |

Only `pending` and `approved` can be claimed. Only `pending` and `approved` can be revoked —
cancelling a `used` record leaves it exactly as it is, which is the honest answer rather than a
silent success. And a record written by a different digest version of this package is refused with
`APPROVAL_VOID` rather than re-interpreted.

## 7. What to say when a policy stops you

- Under `confirm`, the sentence is: this mailbox needs the send approved outside this conversation;
  run `agent-gmail approve <approvalId>` in a terminal, or send the draft from Gmail. Then stop.
- Under `never`, the sentence is: this mailbox does not send through agents; the draft is in Gmail
  Drafts and can be sent from there.
- Under either, changing the policy to get past it is the wrong instinct. Loosening is refused with
  `LOOSENING_REFUSED` and needs a person at their own terminal — that refusal is the design working,
  and proposing the change is worth avoiding even when you know it will fail.
