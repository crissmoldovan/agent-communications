# CUE-411 and CUE-413 — safe send echoes — design

Status: approved for implementation by the owner on 2026-10-14, on `fix/envelope-send-echoes`. This design
supersedes the required-`expect` parts of the 2026-09-18 agent-communications design; the send gate itself is
unchanged.

## The problem

Gmail and Resend prepare results return the approval's `expect` as bare sender-controlled text. Their successful send
results do the same for `to`, `cc`, `bcc` and `subject`, and core's `audit tail` returns recorded recipients bare. An
address or subject copied from received mail can therefore leave the untrusted-content envelope. Gmail's
`send cancel --json` has the opposite inconsistency: core's `publicApproval` wraps even a plain valid address, while
Gmail's `send list` leaves that address plain through Gmail's field helpers.

## Decisions

**D1. An approval id is sufficient to execute a send.** The approval already binds the owner, draft or prepared
message, provider revision, complete content digest, recipients and subject. Gmail derives the draft id from it, and
both channels derive the exact expectation from it when the caller omits `expect`. Every existing policy, ownership,
single-use, digest, revision, rate-cap, lease, final-read and provider-send check remains in place.

**D2. Compatibility is additive at the send boundary.** Existing Gmail callers may continue to pass the draft id and
existing Gmail and Resend callers may continue to pass `expect`. When supplied, those values must still match the
approval and live content exactly; a mismatch refuses and sends nothing. New callers pass the approval id alone
(besides the account or mailbox selector a non-pinned surface needs). Returned `expect` is a safe display value, not
an argument to copy back into execute.

**D3. Send echoes use the channel's field rules.** Gmail and Resend prepare `expect` values and successful send
`to`, `cc`, `bcc` and `subject` values use that channel's existing address and prose helpers with one fresh boundary
per result. A strict plain address stays plain; every other sender-controlled address and every subject is sanitised
and enveloped. Gmail cancel builds its public approval with the same helper path as Gmail list, so the same field has
the same shape on both surfaces.

**D4. Core audit output is safe without importing a channel.** Audit storage remains canonical and unchanged. The
core `auditTail` operation presents each recorded recipient with the same conservative rule: a strict plain address
is plain; anything else is bounded, sanitised and placed in core's untrusted-content envelope. CLI and MCP keep
calling that one operation.

## Tests

- Gmail and Resend operation and surface tests send with the approval id and no `expect`; Gmail also omits the draft
  id. Separate mismatch tests keep proving that an optional supplied `expect` and legacy Gmail draft id are enforced.
- Hostile prepare and successful-send subjects and addresses are enveloped, while strict addresses remain plain.
- Core CLI and MCP audit-tail tests show a strict recorded address plainly and a hostile recorded recipient only in
  the envelope.
- Gmail `send list` and `send cancel --json` show the same approval's strict address in the same plain shape.
- Generated CLI/MCP references and the Gmail and Resend skills direct agents to execute by approval id; SECURITY and
  the changelog state the new boundary and compatibility rule.

All send tests use the repository's fake Gmail and loopback Resend transports. No live mail is sent.
