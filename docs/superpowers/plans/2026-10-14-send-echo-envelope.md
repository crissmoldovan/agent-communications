# Safe Send Echoes Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Do not commit or run a Git-writing command in this worktree.

**Goal:** Let Gmail and Resend execute from an approval id while returning every recipient and subject echo in its
channel-safe form, including consistent Gmail cancel/list output and safe core audit-tail recipients.

**Architecture:** The stored approval remains the single raw source for send identity and exact expectations. Each
channel adds one result-shaping helper around its existing field helpers; core shapes audit recipients at the read
operation. CLI and MCP adapters make legacy expectation fields optional and continue calling the same operations.

**Tech Stack:** TypeScript, Node `node:test`, Commander, Zod MCP schemas, Biome, pnpm workspaces.

## Global Constraints

- Never contact Gmail, Resend, Slack or any other real host; use only the repository fakes and loopback seal.
- Only Gmail `send.execute` and Resend `executeSend` may invoke their providers' send paths.
- A supplied legacy draft id or `expect` remains an exact-match guard; no existing gate is weakened.
- Every new `assert` has an explicit message. POSIX-only tests use `WINDOWS_SKIP` and file URLs for `--import`.
- Regenerate references with `pnpm sync:reference` and skills with `pnpm sync:skills`; format with Biome.
- Do not run `pnpm verify`; run the affected files and the explicitly requested verification commands.

---

### Task 1: Prove approval-id-only execution and safe channel echoes

**Files:**
- Modify: `packages/gmail/test/send-gate.test.ts`
- Modify: `packages/gmail/test/mcp-send.test.ts`
- Modify: `packages/gmail/test/cli.test.ts`
- Modify: `packages/resend/test/send-gate.test.ts`
- Modify: `packages/resend/test/mcp.test.ts`
- Modify: `packages/resend/test/parity.test.ts`

**Interfaces:**
- Consumes: current `prepareSend`, `executeSend`, Gmail CLI/MCP, and Resend CLI/MCP behavior.
- Produces: failing coverage for omitted duplicate arguments, exact optional mismatch checks, and channel-safe fields.

- [ ] Add tests that execute Gmail with `{ approvalId }`, Resend with `{ approvalId }`, and the corresponding CLI and
  MCP tools without `expect`; assert exactly one fake provider send.
- [ ] Add hostile subject/address assertions on prepare and successful send output using the existing untrusted-field
  test helpers; assert strict addresses remain plain.
- [ ] Keep explicit legacy calls with a raw `expect` and Gmail draft id, and assert a mismatching supplied value sends
  nothing.
- [ ] Run each affected test file and record the expected failures: required arguments or bare hostile text.

### Task 2: Derive send inputs from approvals and shape results

**Files:**
- Modify: `packages/gmail/src/operations/send.ts`
- Modify: `packages/gmail/src/cli/program.ts`
- Modify: `packages/gmail/src/mcp/server.ts`
- Modify: `packages/resend/src/operations/send.ts`
- Modify: `packages/resend/src/cli/program.ts`
- Modify: `packages/resend/src/mcp/server.ts`

**Interfaces:**
- Consumes: the approval record's `draftId` and raw `expect`, plus each channel's `addressField` and `wrapField`.
- Produces: optional `draftId`/`expect` operation arguments and safe public `Expectation`/send fields.

- [ ] Add a small channel-local expectation shaper that maps `to`, `cc` and `bcc` through `addressField` and the
  subject through `wrapField`, sharing one new boundary per result.
- [ ] In Gmail, inspect the approval first and use `options.draftId ?? record.draftId` and
  `options.expect ?? record.expect`; in Resend use `options.expect ?? known.expect`. Pass the selected raw expectation
  into the existing `claimForSend` check.
- [ ] Make Gmail's new CLI form `send execute <approvalId>` work while retaining
  `send execute <draftId> --approval <approvalId>`; make all four expectation flags optional as one legacy group.
- [ ] Make Gmail MCP `draftId` and `expect`, and Resend MCP `expect`, optional; update their descriptions to send by
  approval id and retain exact checking when supplied.
- [ ] Return shaped `expect` from prepare and shaped recipients/subject from send success, without changing previews,
  stored records, audit writes or provider arguments.
- [ ] Run the Task 1 files until green, then run the full Gmail and Resend package tests.

### Task 3: Make Gmail cancel and list share field shaping

**Files:**
- Modify: `packages/gmail/src/operations/send.ts`
- Modify: `packages/gmail/src/cli/program.ts`
- Modify: `packages/gmail/test/send-gate.test.ts`

**Interfaces:**
- Consumes: `publicApproval`, `ownerOf`, Gmail field helpers, and the current inbox-id-to-alias map.
- Produces: one Gmail public-approval presentation helper used by both list and cancel.

- [ ] Add a failing test that prepares one approval, reads it through `send list`, cancels it through `send cancel
  --json`, and asserts its strict address is plain in both.
- [ ] Extract Gmail's `publicApproval` wrapper construction and use it from both `listApprovals` and the CLI cancel
  result.
- [ ] Run `packages/gmail/test/send-gate.test.ts` and record green.

### Task 4: Shape audit-tail recipients in core

**Files:**
- Modify: `packages/core/test/cli.test.ts`
- Modify: `packages/core/test/core-server.test.ts`
- Modify: `packages/core/src/operations/maintenance.ts`

**Interfaces:**
- Consumes: stored `AuditRecord` rows, `newBoundary`, `stripInvisible`, and `wrapUntrusted`.
- Produces: `auditTail` results whose strict addresses stay plain and whose other recipient strings are enveloped.

- [ ] Add CLI and MCP failing tests with one strict synthetic address and one hostile synthetic recipient; assert the
  strict address stays plain and no hostile text occurs outside an untrusted envelope.
- [ ] Map only returned `recipients` in `auditTail`, sharing a fresh boundary for the response and leaving storage and
  filtering unchanged.
- [ ] Run the affected core tests and record green.

### Task 5: Documentation, generation and verification

**Files:**
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/sending.md`
- Modify: `skills/gmail-send/SKILL.md`
- Modify: `skills/gmail-send/references/troubleshooting.md`
- Modify: `skills/resend-sending/SKILL.md`
- Modify: `skills/_shared/contract-resend.md`
- Regenerate: `skills/*/references/contract.md`, `docs/reference/*.md`, and generator-owned indexes as selected by the
  repository scripts.

**Interfaces:**
- Consumes: final CLI/MCP schemas and the compatibility contract in the design note.
- Produces: user-facing instructions that execute by approval id and explain safe echoes.

- [ ] Reword SECURITY's former bare-echo limitation; add `## Unreleased` with what, why and impact/compatibility.
- [ ] Remove instructions to copy `expect`; document approval-id-only execution and optional exact legacy arguments.
- [ ] Run `pnpm sync:reference`, `pnpm sync:skills`, and Biome on every changed file.
- [ ] Run the affected test files, `pnpm typecheck`, `pnpm lint`, `pnpm verify:parity --strict`,
  `pnpm verify:reference`, and `node scripts/verify-skills.mjs`; record every result without running `pnpm verify`.
