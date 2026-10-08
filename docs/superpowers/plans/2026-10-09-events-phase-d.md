# Local event emission — Phase D implementation plan

**Goal:** add held, local-only Slack, Resend, and WhatsApp event sources to
`@agentcomms/events-daemon`.  This is Phase D from the local-event-emission
design.  It deliberately does not implement B2 delivery, open an outbound
network connection in tests, create a send path, or release either
`@agentcomms/events` or `@agentcomms/events-daemon`.

This plan is based on the completed Phase A library and Phase B1 daemon in
`feat/events-b1`, and adopts every B1 amendment (B1-A through B1-G) and every
committee decision through code-review round 8 and K6.  In particular: SQLite
is owned by the daemon on Node >= 22.16; activation is a durable,
generation-fenced protocol; disabled work remains content-free; account
removal purges immediately; a re-added account is dark until a new approved
activation; an encryption operation reserves its counter before the caller's
write transaction; and the sealed fakes, rather than real services, are the
only test transports.

Phase D is one PR-sized body of work, but the implementation commits below are
deliberately small and independently reviewable.  A source task may not start
until Batch 1 has landed.  Thereafter Tasks 4, 5, and 6 are three separate
worktrees with no shared production-file ownership.  All commands below are
commands for the implementer; planning this change neither runs them nor
contacts a provider.

## Decisions the spec leaves to the plan

### D-1 — a source adapter, not a provider client in the daemon

`packages/events-daemon/src/sources/contracts.ts` will define a closed
`LocalEventSource` interface.  An adapter owns these operations:

1. validate and canonicalise its `SourceOptions`;
2. acquire its ordered scope lock(s);
3. establish a bounded first-activation baseline;
4. resume one durable scan step and return a typed, pre-sanitised candidate or
   a typed terminal result;
5. describe the durable cursor/scan record that the daemon may advance; and
6. perform source-specific reset, drain, and purge cleanup.

The adapter receives a minimal read-only channel operation object from
`packages/<channel>/src/operations/events.ts`, never a raw provider client.
It returns plain candidate data; the daemon alone encrypts/stages, applies
rules, creates projections, runs taint, and handles dry-run disclosure.  This
preserves the B1 Gmail trust boundary and ensures no Phase-D source can send.

The registry is explicit, not discovery-based: Gmail, Slack, Resend, and
WhatsApp are registered by `runtime/owner.ts`.  An unregistered source option
is rejected with a stable `SOURCE_UNAVAILABLE` error during the transitional
commits; a completed Phase-D tree has all four.  Explicit registration is more
auditable than loading arbitrary package code and lets package manifests remain
metadata, rather than an executable plugin system.

### D-2 — durable source identities and activation points

Every source has a canonical `scopeId`, a scan record, and a source-specific
activation point.  Scope IDs are UTF-8 byte-sorted and include the account
alias so two accounts cannot share state by accident.

| Source | `scopeId` and occurrence identity | Cursor / snapshot record | Activation point |
| --- | --- | --- | --- |
| Slack | `slack:<account>:<conversationId>`; occurrence is `(conversationId, ts)` where `ts` is the exact decimal timestamp string | `source_scan_state` stores `oldest`, fixed `latest`, opaque `cursor`, and a scan generation.  `slack_reply_drains` stores parent `ts`, the fixed reply upper bound, opaque cursor, and completion state. | Exact Slack timestamp `P` for each conversation, plus aggregate reply-drain state at `P`. |
| Resend received | `resend:<account>:received`; occurrence is immutable received-email ID | state stores `anchorId`, `cycleHeadId`, `after`, `pagesScanned`, and the terminal-resolution/stage reference. | The newest received ID, or a canonical `empty` marker. |
| Resend status | `resend:<account>:status`; occurrence is `(sentEmailId, status, observedAt)` | `resend_status_state` keeps the last observed closed state for seven days; the source cursor is the durable observation start. | Durable activation-start instant; first observations seed state and emit nothing. |
| WhatsApp | `whatsapp:<account>:<chatJid>`; occurrence is canonical raw key `['wa-msg', chatJid, senderJidRaw, stanzaId]` | `whatsapp_snapshot_heads` and `whatsapp_snapshot_keys` retain a raw-key generation and exact tuple set; a candidate generation is separate until committed. | `(T, baselineGeneration, baselineIdentities)`, where `T` is the staged first-representation time and identities are raw keys. |

The exact source points live in the existing generic activation-point document,
encrypted where B1 encrypts the rest of the document.  Human-facing aliases,
SQLite primary keys, `Z_PK`, and pagination positions are never event
identities.  This chooses a separate source-state table over a polymorphic JSON
cursor because the transition predicates are safety critical, indexed, and
need SQL conditional updates.

### D-3 — Slack scan and aggregate reply barrier

A Slack history scan freezes `latest` at cycle start and retains the prior
committed `oldest`.  It follows every cursor, including cursors from an empty
or short page.  The only write that changes the committed watermark is the
last-page transaction after all candidates through `latest` are staged or
terminal.  A budget cut, 429, malformed cursor, restart, or a page with no
messages leaves that watermark in place.  A malformed cursor restarts the
same `[oldest, latest]` interval from no cursor.  Only Slack's explicit
retained-history boundary may create a recorded gap, and never when it would
exclude the old committed watermark.

Replies use an independent, resumable `conversations.replies` cursor for each
eligible parent.  An eligible parent is discovered from top-level history at
or before the frozen `P`; the parent set may grow until top-level coverage of
`P` completes, then freezes.  The aggregate barrier is durable only when both
conditions are true: top-level history is covered through `P`, and each frozen
eligible parent's reply scan is covered through `P`.  A completed child scan
may be reused after restart, but top-level coverage cannot imply child
coverage.  The decimal timestamp comparator is a dedicated exact parser; it
does not use JavaScript `Number`.

This is more state than a single channel watermark, but it is the only choice
that makes a late paginated reply unable to slip behind a replacement drain.

### D-4 — Resend resolution, Unicode, and throttle fairness

For received mail, a list result is only a candidate.  The source calls the
required detail/body operation before it may stage or advance the anchor.
`404` becomes the affected item's terminal `vanished` resolution.  Other
detail errors retry for at most 24 hours, subject to stage retention; then one
terminal `unresolvable` result and one recorded source gap allow progress.
The current anchor advances to `cycleHeadId` only after the old anchor was seen
and every item in the bounded cycle is staged or terminal.  Ten pages without
the old anchor purges the cycle stage, records one gap, and starts a bounded
rebaseline; it never keeps paging indefinitely.

The channel operation normalises text by validating Unicode scalar values,
then taking at most 20,000 Unicode code points.  If the resulting boundary
would end with a high surrogate, it removes that code unit; any other unpaired
surrogate is rejected before content crosses into the daemon.  It preserves
the provider's `bodyTruncated` fact rather than inventing a character count.

`Throttle` gains durable, local priority accounting: interactive CLI/MCP reads
receive the next available slot, and a background event reservation cannot
consume more than alternating slots while either class is waiting.  The event
adapter labels every request `background-event`; it may never call transport
directly.  This is preferable to an independent event throttle, which would
violate the machine-wide limit, and to a fixed sleep, which would starve an
interactive investigator behind polling.

### D-5 — WhatsApp raw-key snapshots and first representation

WhatsApp event discovery runs inside the channel package's existing checked
copy/sync lock.  The event adapter invokes `rebuildIndex` before the checked
copy is disposed and reads raw message fields from that checked copy.  It does
not read the live store, infer an identity from `Z_PK`, or substitute an
index-derived sender.  It exposes `fromMe: true | false | null`; only exactly
`false`, with nonempty raw chat JID, raw sender JID, and stanza ID, is eligible.

The daemon constructs the raw key exactly as canonical JSON:

```text
["wa-msg", chatJid, senderJidRaw, stanzaId]
```

`Z_PK` may select deterministic checked-copy read order for a first
representation, but is neither persisted as identity nor used to form the
key.  A candidate complete raw tuple set is written under a new generation
without changing the head.  After it has been read, visibility is read again.
Only if the visibility version/digest still matches does one transaction:
compare the prior head; calculate raw-key adds/removals; insert occurrence and
rule-admission rows; encrypt/stage a first representation for every owed new
key; and switch the head.  First representations are therefore staged before
the checked copy is disposed.  Recovery discards a candidate without an
authoritative head; a switched head is authoritative and is never recomputed
from a later database copy.

The separate occurrence ledger and rule-admission ledger are intentional.
They prevent a later rule from treating a snapshot-deduped historical key as a
new occurrence, while retaining exact version admission and replacement-drain
accounting.

### D-6 — WhatsApp live lists are a capability fence

`packages/whatsapp` will expose a `withCurrentEventVisibility` operation.  It
obtains `.whatsapp-chats.lock` after the normal activation/source/sync locks,
parses the human-editable list file, computes lower-case SHA-256 over core
canonical JSON `{allow,deny}`, and supplies the parsed `Visibility`, version,
and digest to a callback.  The daemon never caches the list entries.  It keeps
only `whatsapp_visibility(accountId, version, listsDigest, changedAt)`.

Every gate acquisition, watcher/config reload, source boundary, dry-run read,
dry-run append, activation baseline sample/finalise, candidate-head commit,
and disclosure transition invokes this operation.  A read failure hides all:
no candidate, delivery, append, dry-run view, or future stream frame is
created.  It does not purge merely because the file could not be parsed.  A
different digest is applied under the gate in one transaction: increment the
version, persist the digest, and purge newly hidden tuple data from stage,
first representations, projections, undecided ingest holds, queued/retryable
pre-disclosure deliveries, dry-run records, future stream records, snapshots,
and unnecessary future admissions.  Widening produces no backfill.

Phase D defines a `SseFrameVisibilityGate` interface and gives it the exact
same `assertCurrent` callback used by dry-run.  It ships no transport and no
SSE record writer.  When B2 lands, its live and replay frame writer must call
this interface immediately before every frame, under the same list gate.  The
Phase-D tests exercise the callback with a sealed in-memory frame sink; that
makes the required every-frame property testable now without taking a B2
dependency.

This is stricter than checking the list only during polling.  It is necessary
because a list may change between discovery and disclosure.

### D-7 — taint, reset, and scheduling fairness

Each source candidate is treated as sender-controlled before it enters an
existing B1 event record.  Slack text/blocks, Resend headers/body/attachment
metadata, and WhatsApp raw message fields pass through the channel sanitizer,
the event envelope, and taint before any dry-run disclosure.  Source-specific
taint tests assert that hostile candidate text cannot become an instruction or
an unescaped HTML result.  A terminal resolution is content-free and must not
become a substitute representation.

Reset is source-local and scope-local: Slack discards only an interrupted
interval and re-establishes it from the preserved watermark; Resend clears the
bounded received cycle or expired status state and records the required gap;
WhatsApp discards a non-head candidate and retains the authoritative head.
The scheduler round-robins ready `(source, account, scope)` work and persists
the next eligible instant/backoff.  It uses each manifest minimum interval and
provider `Retry-After`; a hot Slack reply drain, a Resend detail retry, or a
large WhatsApp account cannot monopolise the owner.  Resend's throttle rule in
D-4 is an additional cross-client fairness boundary.

### D-8 — parity rows D owns

Phase D adds no new user command or MCP tool.  It extends the existing
`events-daemon source show <source>` capability to the three new source values,
so `capabilities.json` gains three invocation rows:

| Capability ID | CLI argv / MCP input | Shared operation |
| --- | --- | --- |
| `events-daemon.source.show.slack` | `['slack']` / `{source:'slack'}` | `sourceShow` |
| `events-daemon.source.show.resend` | `['resend']` / `{source:'resend'}` | `sourceShow` |
| `events-daemon.source.show.whatsapp` | `['whatsapp']` / `{source:'whatsapp'}` | `sourceShow` |

The existing Gmail row remains and receives an explicit Gmail expectation if
the parity fixture needs one.  `sources list` stays one existing row because
it already calls `sourcesList`; it must now list all registered sources.
Channel `operations/events.ts` is internal adapter surface, not a CLI/MCP
capability, so it gets no capability row.  This avoids pretending that a
provider adapter is a user-authorised action while still proving CLI/MCP
parity for every newly selectable value.

### D-9 — schema and package boundaries

The daemon receives one additive migration, `v6_phase_d_local_sources`.  It
adds the D-owned tables and nullable foreign-key columns without rewriting B1
rows:

- `slack_reply_drains`;
- `resend_status_state` with its seven-day retention index;
- `whatsapp_visibility`, `whatsapp_snapshot_heads`,
  `whatsapp_snapshot_keys`, `whatsapp_occurrences`, and
  `whatsapp_rule_admissions`;
- explicit source scan/reset/gap metadata where the generic B1 scan table
  cannot represent the durable boundary; and
- the nullable WhatsApp identity/visibility references required by D8 on
  existing ingest, decision, delivery, dry-run, and future stream-log rows.

The migration uses `CHECK`s and uniqueness constraints for source kinds,
generation/head state, and raw canonical keys.  It is idempotent under the
existing migration ledger and is covered by an upgrade fixture from B1 v5.
No table is repurposed for a provider's opaque cursor.  Source packages add an
explicit workspace dependency to the daemon; `tsdown` keeps all four channel
packages external, as it already does Gmail, and never bundles a provider or
native database binary.

### D-10 — held release contract

The Phase-D PR proposes version `0.14.2-events-d` for release planning only;
it does not publish or unhold anything.  Its release note is:

> No changelog: Phase D only adds internal source support to the held local
> event daemon; no released CLI, MCP, or event package behaviour is available
> to users.

The PR carries focused synthetic tests, `pnpm verify:parity --strict`,
`pnpm verify:browser`, `pnpm verify`, source/manifest/reference documentation,
and provenance describing the branch, exact workspace package versions, and
the sealed-fake test run.  It contains no real token, API key, address,
message, workspace, local-store copy, or provider request/response.  Release
provenance and an actual version bump are deferred until the hold is lifted by
the release owner.

## Spec amendments to raise with the owner

The following do not block implementation.  The plan uses the decisions above
until the owner changes the normative text.

| ID | Ambiguity / contradiction | Lines | Plan's safe interpretation |
| --- | --- | --- | --- |
| D-A | D4 requires an `agentcomms` manifest `events` declaration with types, minimum interval, and scopes/key kind, but does not define its strict JSON shape, property names, permitted credential kinds, or interval units. | 993–998 | Use the strict discriminated `events` object in D-1/D-9: `types`, `minimumIntervalMs`, and `access` (`oauth-user` + nonempty `requiredScopes`, `resend-full-access`, or `local-store`). Reject unknown fields. |
| D-B | The Slack aggregate barrier says replies must be “covered through P”, but does not specify the fixed request upper-bound or how an API whose reply ordering differs from history proves it. | 721 | Persist the parent, fixed `P`, cursor, and exact returned timestamp range; request/paginate until the adapter proves no reply <= `P` remains. If it cannot prove that, preserve the drain and do not finalise. |
| D-C | Resend status asks for a durable local start time but does not state its storage representation or how a local clock rollback is classified. | 959–965 and 985–990 | Store an ISO-8601 UTC instant plus monotonic scan generation; wall-clock rollback retains the prior high-water start and emits no backfill or gap. |
| D-D | D9 assigns every SSE-frame list check to Phase D even though B2 owns network delivery and stream-log writing. | 1901–1911 and 2824–2827 | Phase D supplies and tests the mandatory gate interface with a sealed sink; B2 must call it for every live/replay frame. No B2 code or dependency is added here. |
| D-E | D8 specifies `stream_log` WhatsApp columns although this B1-based branch has no B2 stream table; the parallel B2 migration must not be guessed or made to collide. | 1502–1507 and 1547–1552 | Add D columns only to B1-present tables; reserve the exact WhatsApp column contract in a shared migration/schema helper so B2 creates it in its own forward migration. Do not create a pretend stream table. |
| D-F | D9 says a missing list-file account is represented canonically as no entry (`{allow: [], deny: []}`), but does not restate the established channel `Visibility` behaviour for that empty value. | 1864–1873 | Preserve the channel's established empty-list behaviour (no restriction); a read/parse failure—not a missing entry—is hide-all. This avoids silently changing existing list semantics. |

## The two defect classes designed out up front

### Write after await: mandatory re-check table

No source caches core configuration, an approval, visibility, or a switch
across an `await`.  Before every provider call, it loads the current account
from `ConfigStore`; after each await, the write transaction calls the common
`assertWriteStillLive` helper.  The helper re-reads, in that transaction:

- the rule switch generation and enabled state;
- pause/kill-switch state;
- the account's current presence and channel configuration in core (not a
  cached account object), including revocation;
- live rule version and target state;
- current activation/drain/baseline pointer and intent claim/token/deadline;
- the row version/primary key that was read before awaiting; and
- for WhatsApp, the live visibility version and digest under the list gate.

Failure is a no-op except account/rule removal, which invokes the relevant
immediate purge in the same transaction.  Ciphertext is prepared before the
transaction using B1's counter-reservation discipline; the transaction still
compares the intended row/version before linking it.  The following is the
complete Phase-D post-await write inventory.  “Removal” includes target and
rule removal where applicable.

| New write after await | Required in-transaction re-check | Test that bites it |
| --- | --- | --- |
| Generic first-activation baseline, encrypted point, pointer installation, and completion claim | switch/gen, pause, current core account, live version, intent claim, previous pointer | `activation-write-fence.test.ts :: baseline completion loses account/switch/claim` (Task 3) |
| Generic replacement drain creation/finalisation, derived tightening point, and timeout/recovery transition | switch/gen, live old/new versions, enabled state, exact drain token/row, core account | `replacement-write-fence.test.ts :: stale drain cannot move pointer` (Task 3) |
| Slack session open, history/replies page, and staged first representation -> occurrence/projection/scan/reply-drain/gap/watermark writes | all common checks, exact `(conversationId,ts)` row, scan generation/cursor, parent drain token | `slack-write-fence.test.ts :: page or reply result loses each boundary` (Task 4; adversarial audit in Task 9) |
| Resend throttle reservation, list/detail/body read, and encryption -> received scan, anchor, status state, terminal resolution, stage, and gap writes | all common checks, exact `anchorId/cycleHeadId`, status observation row, resolution lease | `resend-write-fence.test.ts :: stale detail result cannot advance anchor` (Task 5; adversarial audit in Task 9) |
| WhatsApp checked-copy/sync, list read, candidate read, visibility re-read, and encryption -> candidate, snapshot head/key, occurrence/admission, stage, baseline, and list-purge writes | all common checks plus list gate/version/digest, exact head generation, raw key, candidate token | `whatsapp-write-fence.test.ts :: visibility/head/account changes abandon candidate` (Task 6; list recovery audit in Task 9) |
| Scheduler provider-result health/backoff/next-slot update | current core account and scope ownership, active intent/scan generation, row version | `source-scheduler-fence.test.ts :: removed scope cannot be rescheduled` (Task 7) |
| Shared evaluator encryption/taint flush -> ingest rule/decision/delivery write for a D candidate | current account, switch/gen, live rule/target, claim and projection version | `d-source-taint-fence.test.ts :: taint flush loses rule or target` (Task 7) |
| Dry-run decrypt/taint/visibility read -> append, display transition, or purge | pause/switch/gen, core account/revocation, live rule/target, delivery row version; WhatsApp gate/version/digest | `whatsapp-dryrun-live-list.test.ts :: changed list before append/show purges` (Task 9) |
| Future B2 sealed-frame-gate callback -> frame append | same disclosure checks plus current WhatsApp visibility gate | `sse-frame-visibility-gate.test.ts :: every synthetic frame rechecks` (Task 6, hardened in Task 9) |

Every listed test has a mutation counterpart: remove the named re-check or
replace its conditional `UPDATE ... WHERE version = ?` with an unconditional
update.  The named test must fail by exposing a stale write, duplicate, or
surviving hidden content.  A review cannot accept a new awaited write without
adding one row to this table and one such mutation proof.

### Cut-over correctness: required matrix

The tests below run each transition with a concurrent source scan paused at
each durable edge (before stage, after stage, before pointer/head/cursor move,
after move, before finalise) and restart the daemon at that edge.  The oracle
is: each eligible occurrence is admitted exactly once by the correct version,
or remains strictly before the new point; no backfill, permanent stall, or
duplicate is accepted.  “S/R/W” test names are the concrete test cases that
Task 8 adds to `slack-cutover.test.ts`, `resend-cutover.test.ts`, and
`whatsapp-cutover.test.ts`.

| Transition / crash race | Slack proof | Resend proof | WhatsApp proof |
| --- | --- | --- | --- |
| First activation, enabled | `S:first-enabled-page-and-reply-barrier` | `R:first-enabled-received-and-status` | `W:first-enabled-stages-before-copy-dispose` |
| First activation, disabled | `S:first-disabled-baselines-without-content` | `R:first-disabled-seeds-anchor-and-status` | `W:first-disabled-head-without-owed-stage` |
| Exact replacement, enabled, old-only scope | `S:replace-old-only-drains-history-and-replies` | `R:replace-old-only-drains-received-and-status` | `W:replace-old-only-admits-by-old-generation` |
| Exact replacement, enabled, new-only scope | `S:replace-new-only-baselines-at-P` | `R:replace-new-only-baselines-at-anchor` | `W:replace-new-only-baselines-raw-generation` |
| Exact replacement, enabled, shared scope | `S:replace-shared-one-version-per-occurrence` | `R:replace-shared-one-version-per-occurrence` | `W:replace-shared-raw-key-one-version` |
| Exact replacement, disabled | `S:disabled-replacement-marks-drains-complete` | `R:disabled-replacement-marks-drains-complete` | `W:disabled-replacement-no-owed-admission` |
| Enable-all after disabled / re-add | `S:enable-all-rebaselines-readded-scope` | `R:enable-all-rebaselines-readded-account` | `W:enable-all-rebaselines-authoritative-head` |
| Derived tightening | `S:tighten-preserves-old-P-and-new-boundary` | `R:tighten-preserves-anchor-and-status-seed` | `W:tighten-preserves-raw-admission-boundary` |
| Disable-all, rule disable/removal, or target removal | `S:disable-or-remove-cancels-and-purges` | `R:disable-or-remove-cancels-and-purges` | `W:disable-or-remove-cancels-and-purges-hidden-tuples` |
| Account removal and K6 re-add | `S:remove-readd-stays-dark` | `R:remove-readd-stays-dark` | `W:remove-readd-stays-dark-and-rechecks-list` |
| Claimed-completion recovery and restart | `S:claim-recovery-resumes-same-drain` | `R:claim-recovery-resumes-same-cycle` | `W:claim-recovery-keeps-authoritative-head` |
| Completion timeout | `S:timeout-keeps-watermark-and-retries` | `R:timeout-keeps-anchor-and-retries` | `W:timeout-discards-candidate-not-head` |
| Initial cursor installation | `S:initial-cursor-is-after-baseline` | `R:initial-anchor-and-status-start-atomic` | `W:initial-baseline-generation-and-identities-atomic` |

For all rows, Task 8 also runs the three destructive mutations: advance the
pointer/cursor/head before staging, omit the conditional generation predicate,
and finalise an aggregate Slack drain after top-level coverage alone.  At least
the corresponding row must fail.  WhatsApp has two additional mutations:
switch the head before first-representation staging, and derive a raw key from
`Z_PK`; its first-enabled and shared-replacement proofs must fail.

## Execution map

| Batch | Tasks | Dependency and worktree rule |
| --- | --- | --- |
| 1 — safety substrate | 1, then 2, then 3 | Sequential in one integration worktree.  It lands durable schema, source contracts, liveness fences, and generic cut-over machinery before a source is written. |
| 2 — independent adapters | 4 Slack, 5 Resend, 6 WhatsApp | These three tasks run in parallel in separate worktrees after Batch 1.  Each owns only its channel package, its daemon source file(s), and source-specific tests. |
| 3 — assemble and attack invariants | 7, then 8, then 9 | Rebase/merge the three source worktrees first.  Integration precedes the full cut-over matrix; the matrix precedes the post-await/list-change adversarial audit. |
| 4 — release-facing audit | 10 | Starts only after all behaviour and matrix tests are green. |

Every batch ends with a clean `pnpm verify`.  The focused commands below are
diagnostic; passing them is not a substitute for that final batch command.

### Batch 1 — safety substrate

### Task 1 — declare exact source metadata and canonical source options

**Files**

- Modify `packages/core/src/channel-manifest.ts`,
  `packages/core/src/channels.generated.ts`, `scripts/channels.mjs`, their
  tests, and the generated channel-manifest snapshot used by
  `pnpm sync:channels`.
- Modify `packages/gmail/package.json`, `packages/slack/package.json`,
  `packages/resend/package.json`, and `packages/whatsapp/package.json`.
- Modify `packages/events-daemon/src/domain/source-options.ts` and
  `packages/events-daemon/src/domain/activation-documents.ts`.
- Add/modify `packages/events-daemon/test/source-options.test.ts`,
  `packages/events-daemon/test/activation-documents.test.ts`, and
  `packages/core/test/channel-manifest.test.ts`.

**Steps (tests first)**

1. Add red table-driven vectors for all four source variants: empty and
   duplicate arrays; UTF-8 ordering; malformed IDs; bad Resend kinds; invalid
   `all-allowed`; and source options that do not match the channel account.
   Add manifest vectors that reject unknown keys, zero/non-integer intervals,
   empty types/scopes, and incompatible access kinds.
2. Run the focused tests and confirm the pre-change tree cannot represent
   Slack/Resend/WhatsApp or an `events` manifest declaration.
3. Add the strict manifest discriminated union from D-A, including event types,
   `minimumIntervalMs`, and access requirements.  Declare Gmail's existing
   types/read scope plus Slack's history/reply types and OAuth scopes, Resend's
   received/status types and full-access key kind, and WhatsApp's message type
   and local-store kind.  Keep the package JSON `agentcomms` object strict.
4. Expand canonical source options and activation documents to the exact
   Phase-D variants.  Deduplicate and byte-sort permitted arrays before signing
   or comparing a document; preserve raw WhatsApp JIDs as raw strings.
5. Regenerate the checked-in manifest artifact, rerun the tests, and run the
   package type checks.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/core test -- channel-manifest
pnpm --filter @agentcomms/events-daemon test -- source-options activation-documents
pnpm sync:channels
pnpm --filter @agentcomms/core typecheck
pnpm --filter @agentcomms/events-daemon typecheck
```

The focused suites pass; regeneration is either the expected reviewed
manifest/type diff or clean on a rerun.  Mutate the canonicaliser to skip
sorting, accept an unknown manifest key, or accept a source/account mismatch:
the named vectors must fail.

**Commit:** `feat(core): declare event source metadata (events phase D, task 1)`

### Task 2 — add D-owned durable state and generic account purge authority

**Files**

- Modify `packages/events-daemon/src/store/migrations.ts`,
  `packages/events-daemon/src/store/records.ts`,
  `packages/events-daemon/src/store/retention.ts`, and any migration fixture
  builder.
- Modify `packages/events-daemon/src/runtime/account-fence.ts`,
  `packages/events-daemon/src/runtime/revocations.ts`,
  `packages/events-daemon/src/runtime/disclosure-fence.ts`, and
  `packages/events-daemon/src/runtime/dispatcher.ts` only to make account and
  source cleanup generic; do not add a source driver here.
- Add/modify `packages/events-daemon/test/migrations-phase-d.test.ts`,
  `packages/events-daemon/test/account-fence-phase-d.test.ts`, and
  `packages/events-daemon/test/retention-phase-d.test.ts`.

**Steps (tests first)**

1. Write an upgrade test from a real v5/B1 fixture.  Assert the exact v6 table,
   index, foreign-key, `CHECK`, and nullable-column shape; assert a second open
   is a no-op and a B1 Gmail record remains readable.
2. Write account/rule/target-removal tests that seed each new D table and prove
   a removal purges its account/version rows immediately while preserving
   another account.  Include retention of a content-free terminal/gap audit
   decision where the spec requires it.
3. Add `v6_phase_d_local_sources` as the one forward migration described in
   D-9.  Do not alter `schema-v1.ts`, recreate old tables, or create B2's
   absent stream table.
4. Generalise the B1 purge/query helpers by explicit source/account predicates;
   make every removal path call them in the same transaction.  Add typed record
   helpers rather than passing opaque provider JSON through the store.
5. Run migration, foreign-key, and retention checks against a fresh DB and the
   v5 fixture.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- migrations-phase-d account-fence-phase-d retention-phase-d
pnpm --filter @agentcomms/events-daemon typecheck
```

The v5 fixture upgrades once, all D tables are constrained, and removal purges
only the affected account.  Mutate the migration ledger version, remove a raw
key uniqueness constraint, or omit one D table from account purge: the named
test must fail.

**Commit:** `feat(events): add durable multi-source authority (events phase D, task 2)`

### Task 3 — generalise activation, scheduling, and write fences **(risky)**

**Files**

- Add `packages/events-daemon/src/sources/contracts.ts`,
  `packages/events-daemon/src/sources/registry.ts`, and
  `packages/events-daemon/src/sources/scope-lock.ts`.
- Modify `packages/events-daemon/src/runtime/activations.ts`,
  `packages/events-daemon/src/runtime/baseline.ts`,
  `packages/events-daemon/src/runtime/replacements.ts`,
  `packages/events-daemon/src/runtime/scheduler.ts`,
  `packages/events-daemon/src/runtime/account-fence.ts`, and
  `packages/events-daemon/src/runtime/owner.ts`.
- Add/modify `packages/events-daemon/test/source-contracts.test.ts`,
  `packages/events-daemon/test/activation-write-fence.test.ts`,
  `packages/events-daemon/test/replacement-write-fence.test.ts`,
  `packages/events-daemon/test/source-scheduler-contract.test.ts`, and the
  existing activation/replacement/scheduler tests.

**Steps (tests first)**

1. Build a fake ordered source adapter in tests.  Its operations deliberately
   pause after baseline sampling, candidate staging, drain completion, and
   before each conditional update.  Port the B1 Gmail cases through it without
   changing their Gmail semantics.
2. Add red tests for `SOURCE_UNAVAILABLE`, ordered scope locking, round-robin
   ready work, pause before recovery, K6 re-add darkness, and every generic
   post-await write in the write-after-await table.
3. Introduce the closed adapter/registry and scope-lock contracts.  Refactor
   activation, baseline, replacement, and scheduler code to use typed source
   points rather than Gmail-only mailbox types.  Keep the Gmail adapter as the
   reference implementation and ensure it remains the only registered source
   until the Batch-2 worktrees merge.
4. Implement `assertWriteStillLive` and use conditional insert/update/delete
   predicates at each generic durable edge.  It must reload core config inside
   the transaction and invoke immediate purge on removal.  Do not await
   encryption, a config load, or a provider operation while a write transaction
   is open.
5. Make activation completion, replacement drains, timeout/recovery, and
   scheduler state source-neutral.  Preserve B1's first-activation lock,
   disabled-replacement, and aggregate-finalisation rules.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- source-contracts activation-write-fence replacement-write-fence source-scheduler-contract activations replacements scheduler
pnpm --filter @agentcomms/events-daemon typecheck
```

All existing Gmail lifecycle tests and the fake-source race tests pass.  Delete
the switch/config/claim re-check, make a pointer update unconditional, or let
two scope locks overlap: the named fence/contract test fails.

**Commit:** `feat(events): generalise source activation fences (events phase D, task 3)`

**Batch 1 exit gate**

```sh
pnpm verify
```

It passes with the working tree containing only intentional Batch-1 changes.
Only then may the three source worktrees begin.

### Batch 2 — independent source adapters (parallel worktrees)

### Task 4 — Slack history and aggregate reply source **(risky)**

**Files**

- Add `packages/slack/src/operations/events.ts`; modify
  `packages/slack/src/index.ts` and only the read-operation exports/types it
  needs.
- Modify `packages/slack/test/support/fake-slack.ts`; add/modify
  `packages/slack/test/operations/events.test.ts` and fake route tests.
- Add `packages/events-daemon/src/sources/slack.ts` and
  `packages/events-daemon/src/sources/slack-replies.ts`.
- Add/modify `packages/events-daemon/test/slack-source.test.ts`,
  `packages/events-daemon/test/slack-reply-drains.test.ts`,
  `packages/events-daemon/test/slack-write-fence.test.ts`,
  `packages/events-daemon/test/slack-taint.test.ts`, and Slack source fixture
  helpers.

**Steps (tests first)**

1. Extend only the injected/loopback Slack fake with paginated history and
   replies, empty/short pages with cursors, invalid cursors, explicit
   retained-history boundaries, 429 `Retry-After`, delayed pages, and a request
   journal.  Add a guard test that fails if a test constructs an un-injected
   fetch or invokes any send method.
2. Add failing daemon tests for exact decimal timestamp order; persisted
   `[oldest, latest, cursor]`; page restart; budget/429 continuation; one gap
   only at an explicit boundary; top-level/reply aggregate barriers; and each
   staged-result race in the write-fence table.
3. Add the narrow Slack event operation using the existing session/read call
   boundary and `conversations.history`/`conversations.replies` only.  Return
   typed page/result/error facts, not raw API objects, and normalise sender
   content before the daemon sees it.
4. Implement the source and reply-drain state machine.  Freeze `latest`, save
   every opaque cursor, dedupe `(channelId, ts)`, and only advance a watermark
   on a complete final page.  Freeze the eligible-parent set only after
   top-level `P` coverage; make finalisation require every parent drain.
5. Add source-local reset/backoff/fairness and taint cases.  A stuck reply
   drain yields fairly to another scope; its state survives restart.  No edit
   or reply outside the specified seven-day eligibility is inferred as new.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/slack test -- operations/events fake-slack
pnpm --filter @agentcomms/events-daemon test -- slack-source slack-reply-drains slack-write-fence slack-taint
pnpm --filter @agentcomms/slack typecheck
pnpm --filter @agentcomms/events-daemon typecheck
```

All calls appear in the fake's read-only journal; a crash or 429 leaves the
same interval resumable, and only a fully covered aggregate barrier drains.
Mutate decimal comparison to `Number`, advance on a short page, finalise on
top-level coverage alone, or remove the scan-generation predicate: the named
Slack tests fail.

**Commit:** `feat(slack): add resumable local event source (events phase D, task 4)`

### Task 5 — Resend received and status source **(risky)**

**Files**

- Add `packages/resend/src/operations/events.ts`; modify
  `packages/resend/src/index.ts`, `packages/resend/src/api/throttle.ts`, and
  only the read-operation types needed to expose bounded pages/details.
- Modify `packages/resend/test/support/fake-resend.ts`; add/modify
  `packages/resend/test/operations/events.test.ts` and throttle tests.
- Add `packages/events-daemon/src/sources/resend.ts` and
  `packages/events-daemon/src/sources/resend-status.ts`.
- Add/modify `packages/events-daemon/test/resend-source.test.ts`,
  `packages/events-daemon/test/resend-status.test.ts`,
  `packages/events-daemon/test/resend-write-fence.test.ts`,
  `packages/events-daemon/test/resend-taint.test.ts`, and source fixtures.

**Steps (tests first)**

1. Teach the sealed Resend fake to supply newest-first pages, details/bodies,
   missing IDs, retryable errors, attachment facts, sent-mail status changes,
   a controllable clock, and a throttle request journal.  Assert fake keys and
   synthetic addresses only; assert no send endpoint is registered.
2. Add Unicode scalar and 20,000-code-point vectors, including a boundary high
   surrogate and invalid unpaired surrogate.  Add failing tests for detail
   `404`, 24-hour retry exhaustion, stage expiry, ten-page anchor loss, status
   seed/no-event, seven-day pruning, and interactive-versus-event throttle
   ordering.
3. Add the narrow event operation.  It obtains a guarded read transport,
   labels every reservation `background-event`, resolves required details,
   performs the Unicode normalisation, and exposes closed terminal facts.
4. Implement received cycles and status comparisons in the daemon.  Advance an
   anchor only after the old anchor is found and each member is durable; seed
   first status observations; retain exact status state for seven days; record
   one gap and bounded rebaseline at the specified terminal conditions.
5. Add write-fence, reset, fairness, and taint tests.  The scheduler must
   resume another source while a Resend detail is retrying, and interactive
   requests must obtain the next eligible throttle slot.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/resend test -- operations/events throttle fake-resend
pnpm --filter @agentcomms/events-daemon test -- resend-source resend-status resend-write-fence resend-taint
pnpm --filter @agentcomms/resend typecheck
pnpm --filter @agentcomms/events-daemon typecheck
```

The fake shows no send request; anchors never advance across unresolved work;
Unicode is scalar-valid and bounded; and no background polling starves an
interactive read.  Mutate the normaliser to slice code units, move the anchor
before details settle, omit the 24-hour terminal resolution, or let two
background reservations run before a waiting interactive one: the named tests
fail.

**Commit:** `feat(resend): add durable local event source (events phase D, task 5)`

### Task 6 — WhatsApp raw-key source and live visibility fence **(risky)**

**Files**

- Add `packages/whatsapp/src/operations/events.ts` and a sibling raw event
  reader under `packages/whatsapp/src/source/`; modify
  `packages/whatsapp/src/operations/sync.ts`, `packages/whatsapp/src/lists.ts`,
  and `packages/whatsapp/src/index.ts`.
- Modify `packages/whatsapp/test/support/harness.ts`; add/modify event-reader,
  checked-copy, list-lock, and operation tests under `packages/whatsapp/test/`.
- Add `packages/events-daemon/src/sources/whatsapp.ts`,
  `packages/events-daemon/src/runtime/whatsapp-visibility.ts`, and
  `packages/events-daemon/src/runtime/whatsapp-admissions.ts`.
- Add/modify `packages/events-daemon/test/whatsapp-source.test.ts`,
  `packages/events-daemon/test/whatsapp-visibility.test.ts`,
  `packages/events-daemon/test/whatsapp-write-fence.test.ts`,
  `packages/events-daemon/test/whatsapp-taint.test.ts`, and
  `packages/events-daemon/test/sse-frame-visibility-gate.test.ts`.

**Steps (tests first)**

1. Extend the WhatsApp harness with checked-copy messages whose `Z_PK`, sender,
   `fromMe`, chat JID, stanza ID, ordering, disposal timing, and human list
   file can differ.  It must never open a real local store.  Add vectors that
   prove `null` `fromMe` is excluded; duplicate index values cannot collide;
   raw sender differences make different keys; and copy disposal before first
   representation is observable.
2. Add failing tests for candidate/head crash edges, list changes while waiting
   at every gate, unreadable-list hide-all, newly hidden purge, widening with
   no backfill, raw-key rule admissions, disabled activation, and every
   synthetic frame invoking the visibility callback.
3. Factor the channel's checked-copy routine so both ordinary sync and the
   event adapter rebuild the index before disposal.  Add a raw event reader
   with tri-state `fromMe`; preserve the existing presentation reader's public
   behaviour.  Expose `withCurrentEventVisibility` under the list lock.
4. Implement candidate generation, second visibility read, conditional
   head-switch transaction, raw occurrence/admission ledgers, baseline tuple,
   and immediate hidden-data purge.  Stage every owed first representation
   while the checked copy remains open; on any failure discard the candidate,
   not the previous head.
5. Add the dry-run/future-SSE visibility-gate interface and sealed sink tests.
   It is a callback seam only: do not add an SSE client, HTTP transport, B2
   dependency, or send path.  Add source fairness and taint cases.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/whatsapp test -- events checked-copy lists
pnpm --filter @agentcomms/events-daemon test -- whatsapp-source whatsapp-visibility whatsapp-write-fence whatsapp-taint sse-frame-visibility-gate
pnpm --filter @agentcomms/whatsapp typecheck
pnpm --filter @agentcomms/events-daemon typecheck
```

Only raw protocol keys reach the ledger, every checked copy is indexed before
disposal, and list changes prevent disclosure and purge newly hidden data.
Mutate the key to use `Z_PK`, collapse `fromMe` to boolean, switch the head
before staging, cache lists, or skip one frame callback: the named tests fail.

**Commit:** `feat(whatsapp): add visibility-fenced local event source (events phase D, task 6)`

**Batch 2 exit gate**

After merging the three worktrees without resolving conflicts by weakening a
fence:

```sh
pnpm verify
```

It passes with only fake/loopback provider traffic.  The merged request
journals show Slack read methods, Resend read methods, and WhatsApp harness
access only—never email, Slack, Resend, or WhatsApp sends.

### Batch 3 — assembly and adversarial safety proof

### Task 7 — register sources, integrate owner scheduling, and add parity rows

**Files**

- Modify `packages/events-daemon/package.json`,
  `packages/events-daemon/tsdown.config.ts`, build externalisation config,
  `packages/events-daemon/src/runtime/owner.ts`,
  `packages/events-daemon/src/runtime/scheduler.ts`,
  `packages/events-daemon/src/runtime/activations.ts`, and
  `packages/events-daemon/src/operations/sources.ts` only where registry
  integration requires it.
- Modify `capabilities.json`, `scripts/parity.mjs`, and
  `packages/events-daemon/test/capability-audit.test.ts`.
- Add/modify `packages/events-daemon/test/phase-d-owner-e2e.test.ts`,
  `packages/events-daemon/test/source-scheduler-fence.test.ts`,
  `packages/events-daemon/test/d-source-taint-fence.test.ts`, and existing
  CLI/MCP stand-in fixtures.
- Modify generated command/tool reference files only if `pnpm sync:reference`
  produces a semantic D-source result; otherwise record a clean generation.

**Steps (tests first)**

1. Add sealed end-to-end tests that boot one owner with all four fake adapters,
   interleave ready scopes, pause/remove an account while a source is in
   flight, and query each source through both CLI and MCP stand-ins.
2. Add red parity rows from D-8.  For each row, make CLI and MCP invoke the
   same `sourceShow` operation and assert the matching source result.  Add a
   `sources list` assertion that all four registry entries are visible without
   adding a duplicate capability.
3. Add explicit workspace runtime dependencies and externalisation for Slack,
   Resend, and WhatsApp.  Register all adapters once in the owner and inject
   fakes in tests; no source reaches a provider constructor directly.
4. Merge source scheduling with persisted fair ready-work selection, manifest
   minimums, provider backoff, and source-specific locks.  Ensure every
   provider call and provider-result write observes fresh core config; update
   `source show` to expose content-free state only.
5. Run parity/reference generation and inspect that no new command/tool slipped
   in.  Extend existing taint/disclosure tests across all D candidate types.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- phase-d-owner-e2e source-scheduler-fence d-source-taint-fence capability-audit
pnpm verify:parity --strict
pnpm sync:reference
pnpm --filter @agentcomms/events-daemon typecheck
```

Every source is selected through one owner, each added source-show invocation
has CLI/MCP parity, and a removed account cannot be rescheduled or disclosed.
Mutate a parity row to a different operation, register an adapter twice, cache
core config across the provider await, or bypass taint: the named test or
strict parity check fails.

**Commit:** `feat(events): schedule Phase D sources through one owner (events phase D, task 7)`

### Task 8 — prove the complete Phase-D cut-over matrix **(highest risk)**

**Files**

- Add `packages/events-daemon/test/slack-cutover.test.ts`,
  `packages/events-daemon/test/resend-cutover.test.ts`, and
  `packages/events-daemon/test/whatsapp-cutover.test.ts`.
- Add shared crash/concurrent-scan test support under
  `packages/events-daemon/test/support/`.
- Modify only the source/activation/replacement implementation files required
  to fix a demonstrated matrix failure; update their focused tests at the same
  time.

**Steps (tests first)**

1. Implement the pause/crash harness with durable-edge hooks.  It must restart
   from the same on-disk database and fake-provider journal, not recreate an
   in-memory model.
2. Encode every named S/R/W test in the cut-over table, including old-only,
   new-only, and shared replacement scopes; disabled variants; K6 re-add;
   initial cursor; timeout; and recovery.  Assert exact version admission and
   exact raw key/Slack timestamp/Resend ID counts.
3. Add the required destructive mutations as test-local toggles or mutation
   patches: stage-after-pointer, unconditional pointer/head/cursor update,
   Slack top-level-only finalisation, WhatsApp early head, and WhatsApp
   `Z_PK` identity.  Confirm each produces a failing oracle before accepting
   the unmutated implementation.
4. Correct implementation defects exposed by the matrix without broadening
   scope or weakening a point/drain invariant.  Re-run B1 Gmail cut-over tests
   to prove generalisation did not regress held B1 behaviour.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- slack-cutover resend-cutover whatsapp-cutover activations replacements gmail
pnpm --filter @agentcomms/events-daemon typecheck
```

Each matrix cell passes across every durable-edge restart, while every listed
mutation fails its named cell.  There is no accepted test that merely checks a
final cursor without proving the occurrence/version multiset.

**Commit:** `test(events): prove Phase D cut-overs recover exactly once (events phase D, task 8)`

### Task 9 — adversarial post-await and WhatsApp list-change audit **(highest risk)**

**Files**

- Add `packages/events-daemon/test/d-source-write-fence.test.ts`,
  `packages/events-daemon/test/whatsapp-list-change-recovery.test.ts`, and
  `packages/events-daemon/test/whatsapp-dryrun-live-list.test.ts`.
- Modify `packages/events-daemon/src/runtime/dispatcher.ts`,
  `packages/events-daemon/src/runtime/whatsapp-visibility.ts`, source files,
  and fence helpers only to close failures found by those tests.
- Add/modify fake clock/config/list mutation helpers under
  `packages/events-daemon/test/support/` and the WhatsApp harness.

**Steps (tests first)**

1. Turn every row in the write-after-await table into a deterministic
   interleaving: start the await, mutate switch/pause/config/rule/target/
   claim/row/list state, release it, then assert no stale write or immediate
   purge.  Include encryption and decryption as separate await boundaries.
2. Add WhatsApp list-change crash tests at: before applied version write; after
   digest/version write; between each purge set; after candidate stage; before
   head switch; after head switch; dry-run show; dry-run append; baseline
   finalise; and each sealed synthetic frame.  Reopen/retry until stable.
3. Add a live-core-config test at every source boundary (poll, candidate
   commit, scheduler reschedule, disclosure, dry-run) to prove account data is
   never reused from an earlier read.  Add an unreadable-list test for hide-all
   without destructive purge.
4. Fix only demonstrated stale-write/list-recovery defects.  Require a single
   gate callback at dry-run and synthetic-frame boundaries, and retain the B2
   seam without importing B2.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- d-source-write-fence whatsapp-list-change-recovery whatsapp-dryrun-live-list sse-frame-visibility-gate
pnpm --filter @agentcomms/events-daemon typecheck
```

No interleaving produces content after removal, pause, revocation, list
change, or a stale claim.  The crash suite converges to either a correct
authoritative head or no candidate—never a permanent stall.  Delete one
re-check, cache a list/config, or make purge best-effort after committing a
new list version: the named audit test fails.

**Commit:** `test(events): fence Phase D writes and list recovery (events phase D, task 9)`

**Batch 3 exit gate**

```sh
pnpm verify
```

It passes after the full matrix and adversarial suite.  Reviewers must inspect
the fake request journals and the mutation results, not just the green summary.

### Batch 4 — parity, documentation, and held-release handoff

### Task 10 — audit the public surface and prepare the held-release evidence

**Files**

- Modify `docs/superpowers/specs/2026-10-05-local-event-emission-design.md`
  only if the owner accepts one of D-A through D-F; otherwise do not silently
  alter normative text.
- Modify `packages/events-daemon/README.md`, channel README/reference material
  that documents event-source capabilities, and generated reference artifacts
  only where Phase D makes an already-present surface more specific.
- Add/modify a release/PR evidence note under `docs/superpowers/` if the
  repository's normal PR template does not carry the required held-release
  evidence.  Do not change held package versions or publish configuration.
- Modify `capabilities.json`/parity/reference output only if Task 7's strict
  audit identifies a missing expected artifact.

**Steps (tests first)**

1. Run the capability audit with a deliberately missing/misnamed D row and
   confirm it fails before restoring the correct table.  Check every command
   and tool remains mapped to exactly one shared operation for each invocation.
2. Document the four-source local-only boundary, source constraints, fake-only
   testing, Slack reply barrier, Resend detail/Unicode semantics, WhatsApp
   live-list/SSE seam, and held-release status.  Do not expose raw identities,
   cursor contents, or test fixtures as examples.
3. Prepare the PR checklist: proposed `0.14.2-events-d`, the No-changelog
   sentence from D-10, test commands/results, branch/workspace provenance,
   and an explicit “no real data, no real transport, no send path” attestation.
4. Run reference generation twice to prove it is stable; inspect the diff,
   package dependency graph, and secret scanner output before handoff.

**Commands and passing result**

```sh
pnpm verify:parity --strict
pnpm sync:reference
pnpm sync:reference
pnpm verify:browser
pnpm verify
git diff --check
git status --short
```

Strict parity, reference stability, browser verification, and the full verify
pass.  The final diff contains only source, tests, documentation, and generated
artifacts; no credentials or realistic provider data.  Remove a D parity row,
change its operation, or add an undocumented command/tool: audit/parity fails.

**Commit:** `docs(events): audit Phase D parity and held release (events phase D, task 10)`

## §5 coverage ownership

Each Phase-D-owned §5 row has exactly one primary implementation task.  A task
may exercise a case incidentally, but it is not a second owner.

| §5 coverage row D owns | Primary task |
| --- | --- |
| Slack history pagination: empty/short pages with cursors, invalid-cursor restart, retained-history gap, decimal timestamps, persisted budget/429 continuation | Task 4 |
| Slack reply pagination and aggregate top-level/reply drain barrier, including restart and fairness | Task 4 |
| Resend received newest-first anchor/cycle, required detail terminal outcomes, 10-page bounded reset, and received source gaps | Task 5 |
| Resend body Unicode-code-point vectors, attachment facts, status seeding/deltas, seven-day state, and shared-throttle interactive priority | Task 5 |
| WhatsApp checked-copy/index lifecycle, raw protocol key, tri-state `fromMe`, snapshot generation diff, first representation, and raw admission ledger | Task 6 |
| WhatsApp list digest/version application, hide-all read failure, newly-hidden purge, no widening backfill, dry-run reads, and sealed every-frame gate | Task 6 |
| Per-source untrusted-content envelope and taint before dry-run disclosure | Task 7 |
| D-owned CLI/MCP parity: Slack, Resend, and WhatsApp `source show`, plus complete `sources list` | Task 7 |
| First activation/disabled activation, exact replacement (old-only/new-only/shared), enable-all, derived tightening, and initial cursor point for all D sources | Task 8 |
| Disable-all, rule/target removal, account removal and K6 re-add, claimed recovery/restart, timeout, and crash at every D-source durable edge | Task 8 |
| Every post-await transaction fence, live core-config reread, stale-row conditional write, and immediate removal purge | Task 9 |
| WhatsApp D9 list-change recovery at every durable edge; live-list check before baseline, candidate commit, dry-run append/show, and each future-frame seam | Task 9 |
| Phase-D documentation, strict capability audit, generated-reference stability, held-release/provenance/no-real-data evidence | Task 10 |

## Pull-request handoff checklist

- The daemon and `@agentcomms/events` remain held.  No publish, tag, release
  PR, or version unhold is part of this work.
- The PR title/body proposes `0.14.2-events-d` only as a future release target,
  includes the D-10 No-changelog line, and records full verification results.
- It includes source, migration, fake, race, mutation, parity, and docs tests;
  no test invokes a real Slack, Resend, WhatsApp, Gmail, or B2 endpoint.
- It contains no real mail, phone/JID, workspace, address, token, API key,
  client secret, checked database copy, or message body.  Synthetic fixtures
  use obviously fictional values and the repository fakes only.
- It records source commit/branch, workspace package versions and lockfile
  provenance, generated-artifact commands, and the sealed-transport journal
  review.
- Owner decisions on D-A through D-F are linked in the PR.  Accepted amendments
  get a separate normative-spec commit; rejected amendments remain documented
  plan assumptions rather than silent behaviour changes.
