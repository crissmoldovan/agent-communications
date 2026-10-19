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
mailbox has none. The shipped default is `chat`. `gmail_inboxes_list` reports the one in force, but
not where it came from: its `sendPolicy` is already the resolved value. `gmail_inbox_show` does say —
it carries `sendPolicyInherited`, as `agent-gmail inbox show <alias> --json` does, and the CLI's human
output writes `chat (from defaults)` on its `sending:` line (`inbox list` prints `chat (default)`).
So when the question is *where do I change this*, read `gmail_inbox_show` rather than inferring it from
the effective value, which reads identically either way.

### `chat`

**What it guarantees.** Nothing leaves unless a `gmail_send_prepare` call has run for *exactly* this
content and produced an approval record, and then only:

- within ten minutes of that prepare — the chat route's lifetime (§5);
- once — the claim creates a `<approvalId>.claim` file with `O_EXCL`, which the file system lets
  exactly one process create, so two servers racing cannot both send;
- against the same draft, identified by the draft's Gmail **message id**, which Gmail changes on
  every save, so an edit that restores byte-identical content still voids the approval;
- against the same content digest — a SHA-256 over sender, recipients, `Reply-To`, subject, thread
  and threading headers, the visible text, the SHA-256 of the raw HTML and text parts, and the
  filename, type, size and SHA-256 of every attachment's **bytes**;
- with the recipients and subject bound in the approval; legacy callers may pass them again, and
  `sameExpectation` still refuses any mismatch;
- from the same mailbox, and the same Google account: the record stores the account id (`sub`), and
  a claim naming a different one — or naming none at all — is refused rather than trusted. A mailbox
  imported from a legacy setup has no account id until its first re-consent, so for those the check
  has nothing to compare and only the inbox id is enforced;
- under the rate caps (§4);
- with a line in the audit log naming the approval, the draft, the sent message id and the
  canonical recipients.

**What it does not guarantee.** That anyone saw the preview. The server has no view of the
conversation; the only thing it can check is that a prepare happened for this content. Whether the
preview was pasted in full, summarised, or never shown at all is invisible to it. That is why step 2
of `SKILL.md` is written as an obligation rather than a suggestion — under `chat` it is the whole of
the protection, and it is yours.

It also does not guarantee that the user meant *this* message. An "ok" answering a different
question is an approval as far as the code can tell. And it cannot hear a "no": a chat-route approval
the person refused stays usable for the rest of its ten minutes unless you revoke it
(`gmail_send_cancel`) — so revoke it at once.

### `confirm`

**What it guarantees.** Everything `chat` guarantees, plus: the record must be in state `approved`
before it can be claimed, and it reaches that state only when a person typed a four-character
challenge that was shown to them alongside a freshly re-rendered preview — the standard preview,
once: that rendering is the approval, and it sends nothing. The challenge is generated per approval,
only its hash is stored, and it is never returned to an agent. Three wrong answers void the record.
The person has thirty minutes from the prepare to approve it; approved, it can be claimed once, within
24 hours (§5), and the agent learns that it was with `gmail_send_wait`.

There are exactly two channels:

| Channel | How it happens | What stops an agent using it |
|---|---|---|
| Terminal | The user runs the approve command the result gives — this installation's own, its folders pinned — reads the preview it prints, and types the code | The command refuses when an agent marker is present in the environment (`APPROVAL_REQUIRED`), and again when there is no interactive terminal |
| Trusted client form | An MCP client raises a form carrying the preview and the code; the person types it back | The client's `clientInfo.name` must already be on `defaults.confirm.elicitationClients`, which is empty by default; a name is added by `gmail_confirm_client_add` or `agent-gmail confirm-clients add`, only after that client passed a probe in the last ten minutes, and only through a change approval (a yes in chat under the `chat` change policy, the approve command the result gives under `confirm`). Taking a name off it needs nobody: `gmail_confirm_client_remove`, or `agent-gmail confirm-clients remove` |

An un-allowlisted client asking to send under `confirm` gets `APPROVAL_REQUIRED` — "This needs your
approval outside the chat: run … in a terminal, and I will wait with gmail_send_wait." — and **the
record is left pending**: being asked from the wrong client is not evidence that anything is wrong
with the message. The list is never advertised in that refusal. In a trusted client's form, an
explicit decline revokes the record (`declined`); a form cancelled or dismissed decides nothing, and
the record stays pending. The probe proves only that a client can return a form's answer — not that a
person gave it; that the client reaches one is what the person attests to by trusting it.

**What it does not guarantee.** That the person who typed the code is the mailbox owner, or that
they read the preview rather than skipping to the prompt. And `SECURITY.md` says the terminal check
is a speed bump, not a boundary: an agent with a shell can make any command believe it has a
terminal. The boundary for that threat is `never`.

Nor that the mailbox stays on `confirm`. Moving it to `chat` is a loosening, approved under the
mailbox's **change policy** — and under the default change policy, `chat`, that approval is a yes in
the conversation, which the software cannot tell from the agent's own. Only with the change policy
at `confirm` too (`agent-gmail inbox policy <alias> --change confirm`, or `agentcomms policy confirm`
for the default) does moving it off `confirm` need a code typed at a terminal.

### `never`

**What it guarantees.** `prepareSend` throws `POLICY_NEVER` before it reads the draft, so no
approval is ever created. Setting a mailbox to `never` *after* an approval was prepared revokes every
waiting send of that mailbox at once — the change reports them under `fenced`, with any already being
sent — and moving it back to `chat` or `confirm` later revives none of them: each was prepared under
the mailbox's earlier send epoch, and reads revoked "sending was turned off since this was prepared
(policy: never)" for good. A claim, a terminal approval or a form under `never` revokes the record and
returns `POLICY_NEVER`; it never writes `approved`. Nothing in this package can send from that
mailbox. A send already under way when the policy changed is not recalled.

**What it does not guarantee.** That mail cannot be sent from the account by other means. The draft
is still in Gmail Drafts and the user can send it from there, which is the point. It also says
nothing about any *other* Gmail MCP server registered with the same client — `doctor`'s
`other-gmail-servers` check exists because such a server offers an ungated send path that none of
this touches.

## 2. How the effective policy is computed

Two values meet, and the stricter one wins. Strictness is ranked `chat` < `confirm` < `never`.

| Value | Where it comes from | When it is read |
|---|---|---|
| Live policy | The mailbox's `sendPolicy`, else `defaults.sendPolicy` | Freshly, under the record's lock, at approve and again at claim |
| `route` | Stored on the approval record, and bound into it: `confirm` when the live policy was `confirm` or risk escalation raised any flag, else `chat` | Written once, at prepare; never changed by a later policy |

So a record is claimable (`claimable: true`) when it is `approved` and inside its 24 hours, or when
it is `pending` on the `chat` route while the live policy is still `chat` — and never while the live
policy is `never`. It is recomputed at every step rather than trusted from the preview.

Two consequences worth knowing:

- **Loosening the mailbox does not weaken an approval already prepared.** A send prepared while the
  mailbox was on `confirm` is on the `confirm` route for good: it still needs a human approval even if
  someone sets the mailbox to `chat` a minute later.
- **Tightening applies immediately.** Raise the mailbox to `confirm` and a pending chat-route
  approval can no longer be claimed on a yes in the chat: it waits for a typed challenge, inside its
  original ten minutes. Set it to `never` and it is revoked.

Escalation only ever raises to `confirm`. It cannot raise to `never`, and nothing lowers it.

## 3. Risk escalation: every trigger, its evidence, and its blind spots

Escalation runs inside prepare, and only when `defaults.riskEscalation` is true. It is true by
default, and turning it off is classified as loosening a safety setting (`defaults.riskEscalation`).
No command or tool here turns it off: it is the user's own edit to their configuration, and not one to
offer. When it is off, no facts are gathered at all: the preview shows no recipient notes and no flag
can fire.

First, the facts it computes for every address in `To`, `Cc` and `Bcc`:

| Fact | How it is decided |
|---|---|
| own | The mailbox's own address, or any address Gmail reports as a verified send-as. Never external, never first-time, never tainted |
| `external` | Not an own address, and its domain is not in the mailbox's configured `internalDomains` |
| written-to | A Gmail search for `in:sent {to:<address> cc:<address> bcc:<address>}`, paged through up to 50 hits, whose `To`/`Cc`/`Bcc` are then compared against the exact address — Gmail's matching is fuzzy, so a raw hit is not trusted. One prepare spends at most 200 history requests across all its recipients; the answers are kept for ten minutes, so the terminal's re-check does not ask Gmail again |
| `firstTime` | `external` and not written-to |
| `tainted` | The exact address is in the taint store, or its domain is and the recipient is **external** to this mailbox — and the mailbox has **not** written to the address before |

The preview shows these against each recipient as `EXTERNAL`, `internal`, `FIRST-TIME`,
`ADDRESS SEEN IN MAIL YOU READ` and `LOOKS LIKE <domain>`.

Then the three flags:

| Flag | What fires it | The evidence behind it |
|---|---|---|
| `recipient-tainted` | Any recipient is tainted | The address, or its non-public domain, was seen in the headers or body of a message read, exported or downloaded through this package in the last seven days — from **any** connected mailbox, because a message read in one inbox can ask for a send from another. The mailbox's own addresses and its internal domains are never recorded. A domain alone never escalates a colleague on this mailbox's own domains; their exact address still does. The preview says only what the store holds: "seen in mail read in these mailboxes within the last seven days", "most recently on <date>", and "seen at least once in a header" when it was |
| `attachment-to-first-time-recipient` | The draft has at least one attachment **and** at least one recipient is first-time | Attachment presence comes from the draft's parts; first-time from the `in:sent` check above. The two do not have to be the same recipient |
| `lookalike-domain` | A first-time recipient's domain is within a Levenshtein distance of 2 of a domain this mailbox writes to | "Writes to" means: a domain seen in the recipients of the last two hundred messages in Sent, plus this mailbox's own addresses and its internal domains |

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
- **The lookalike check has a horizon.** It compares a first-time recipient against the domains found
  in the last two hundred sent messages, so a correspondent the user has not written to recently is
  not in the comparison set and a lookalike of them will not fire. It is also distance-2 only:
  `acme-invoices.test` against `acme.test` is nine characters away and passes. Comparing the domain
  with the one the user expects is still work done by eye, in the preview.
- **The written-to check reads 50 hits, within 200 requests a prepare.** Somebody whose only
  correspondence is past the 50th fuzzy hit, or a recipient left unchecked when a long recipient list
  spends the budget, reads as not written to, and the preview says so: "prior-send history was not
  fully checked (the 200-read budget was reached); treated as not previously written." A search that
  fails says "prior-send history could not be checked". The error is in the safe direction: doubt
  never removes a flag.
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
worth suggesting. Raising the caps is classified as loosening `defaults.sendCaps`; no command or tool
here raises them, so it is the user's own edit to their configuration. Lowering them needs nothing.

## 5. How long an approval lasts

Every approval is created with `expiresAt` from its `route`, and the value is returned by prepare:

| Route, or state | Lasts | Then |
|---|---|---|
| `pending`, route `chat` | ten minutes from the prepare | `expired` |
| `pending`, route `confirm` (the policy, or escalation) | thirty minutes from the prepare, for the person to approve it | `expired` |
| `approved` | 24 hours from the approval (`usableUntil`), to be claimed once | `expired`, still unused |
| a download's question | thirty minutes from when it was asked, answered or not | `expired` |

Three details matter:

- **Expiry is derived, not scheduled.** A `pending` or `approved` record past its deadline simply
  *reads* as `expired` the next time anything looks at it, and that look writes it. The boundary is
  expired: an approval typed at exactly `expiresAt` is refused. Nothing runs in the background, so an
  approval does not become dangerous by being forgotten.
- **An expired approval says so.** "this approval expired; nothing was sent with it", followed by when
  it was prepared — or approved — and when it expired (`APPROVAL_EXPIRED`), on the send as on the
  approve. A clock found running backwards expires a record at once, and says that instead.
- **Finished records are kept 90 days.** A record that was used, failed, revoked, expired or ended
  `unknown` is deleted 90 days after it finished, in one bounded batch a day — a call may take up to
  five seconds once a day for it — with an `approval.retained` line in the audit log first.

Preparing again is free and is the correct response to an expired approval: each prepare is its own
record with its own digest and its own lifetime. What is not free is leaving the old one pending,
which is why step 8 of `SKILL.md` says to revoke it (`gmail_send_cancel`, CLI `agent-gmail send
cancel <approvalId>`). `gmail_send_list` (CLI: `agent-gmail send list`) shows what is still open.

## 6. The record state machine

```text
pending ──approve (confirm route)──▶ approved ──claim──▶ sending ──▶ used
   │                                                       │
   └──────claim (chat route, live policy chat)─────────────┤──▶ failed
                                                           └──▶ unknown (derived, lease lost)
pending | approved ──▶ revoked        pending | approved ──▶ expired (derived)
```

| State | What it means to a person |
|---|---|
| `pending` | Prepared and waiting. Nothing has been sent. On the `chat` route a yes in the chat sends it (`claimable: true`); on `confirm` it waits for somebody to type a code |
| `approved` | A person typed the challenge for this exact content. Nothing has been sent yet; it can be claimed once, within 24 hours |
| `sending` | A process is sending it right now, renewing a two-minute lease every thirty seconds. Drafts refuse edits and deletion; another send call is told "being sent by another call since …; wait for it". Never prepare again while a send is `sending` |
| `used` | Gmail accepted it, once. The record carries the sent message id. This approval can never be used again |
| `failed` | The send was refused, and the message says why: "nothing was sent: …". This approval is not used again |
| `unknown` | The sending process lost its lease — it died, or Gmail's answer never came — so the mail **may have gone**. Final to everyone but that process, which may still record a late result. Check Sent first; never prepare it again automatically |
| `expired` | Its lifetime passed with nobody using it. Nothing was sent. Prepare again |
| `revoked` | Voided or cancelled. The record's `reason` says which: revoked by the user, declined in a form, the draft changed, the recipients or subject did not match, it named another mailbox or another Google account, sending was turned off since it was prepared (policy: never), its mailbox was removed, too many wrong challenge answers, or prepared by an earlier release |
| `corrupt` | Not a stored state: the record failed its integrity check, and `reason` says how. Never used, and evidence of nothing; say so rather than skip it |

Only `pending` and `approved` can be claimed. Only `pending` and `approved` can be revoked —
cancelling a `used` record leaves it exactly as it is, which is the honest answer rather than a
silent success. And a record written by a different digest version of this package — one 0.13 or
earlier prepared — is refused with `APPROVAL_VOID`, "the approval was prepared by a different version
of agent-communications", rather than re-interpreted: prepare it again.

## 7. What to say when a policy stops you

- Under `confirm`, the sentence is: this mailbox needs the send approved outside this conversation;
  run this command in a terminal, or send the draft from Gmail — followed by the approve command the
  result gave, exactly as given (where it says the command is not locatable here, that sentence
  instead). Then wait with `gmail_send_wait`, and send once it answers `claimable: true`.
- Under `never`, the sentence is: this mailbox does not send through agents; the draft is in Gmail
  Drafts and can be sent from there.
- Under either, changing the policy to get past it is the wrong instinct. Loosening is a change the
  person approves after reading its preview — at their own terminal when the mailbox's change policy is
  `confirm` — and proposing it to get one message out is worth avoiding even when they would say yes.
