# Local event emission — Phase D implementation plan

**Goal:** add held, local-only Slack, Resend, and WhatsApp event sources to
`@agentcomms/events-daemon`.  This is Phase D from the local-event-emission
design.  It deliberately does not implement B2 delivery, open an outbound
network connection in tests, create a send path, or release either
`@agentcomms/events` or `@agentcomms/events-daemon`.

This plan is rebased on final Phase B1 head `7f2804e1` and main `0.15.1`.
It adopts every B1 amendment (B1-A through B1-G), K6, and every committee
decision through **code-review round 10**.  In particular: SQLite is owned by
the daemon on Node >= 22.16; activation is a durable, generation-fenced
protocol; disabled work remains content-free; account removal purges
immediately; a re-added account is dark until a new approved activation; an
encryption operation reserves its counter before the caller's write
transaction; and the sealed fakes, rather than real services, are the only
test transports.

Rounds 9 and 10 bind every Phase-D source, not only Gmail.  A claimed,
unpublished baseline for a scope with no old-version drain fences its worker
and first-cursor scheduler install; tightening transfers every staged debt and
makes an in-flight scan stale; a swap settles old-only debts; and completion
checks its deadline in the baseline transaction, immediately after baseline,
and before finalisation writes or settlement.  The scheduler's initial cursor
also re-reads the published point set inside its insert transaction and does
nothing if it changed or the scope became fenced.  Tasks 3 and 8 make those
rules source-neutral and mutation-tested for Slack, both Resend scopes, and
WhatsApp.

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

The dependency direction is strictly **daemon -> channel package**.  A channel
operation exports only its own read-side structural request/result types and
does not import, type-import, reference in a manifest, or declare a dependency
on `@agentcomms/events-daemon`.  The daemon adapts those structural operation
objects in `sources/contracts.ts`; if a shared data-only type becomes useful,
it belongs in `@agentcomms/events`, never in the daemon.  This keeps released
channels installable while the daemon is held and keeps `verify-package.mjs`'s
cycle/packed-consumer proof meaningful.

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

Every adapter scope uses the shared
`isSourceScopeFenced(database, source, accountId, scopeId)` predicate.  It is
true for any claimed activation whose durable baseline covers that scope and
has no old-version drain, whether the scope is a Gmail mailbox, Slack
conversation, Resend received/status stream, or WhatsApp chat.  The worker
checks it before a provider call; the scheduler holds that same scope lock for
initial-cursor installation and checks it again inside the insert transaction.
That transaction re-reads the encrypted points published for every currently
polling version and abandons its insert if their canonical set changed while a
point was decrypted, or if the scope has become fenced.  A drain-bearing
replacement remains unfenced so its old version can reach P.

### D-2a — exact source-option subset relation for derived tightening

`classifySourceOptionChange` accepts only two canonical options with the same
channel and treats a change as `same`, `tightening`, or `loosening`; invalid
options fail closed.  Arrays are nonempty, duplicate-free, and raw-UTF-8-byte
sorted before comparison.  The four subset relations are deliberately
field-by-field:

- Gmail keeps B1's rule: a label-set removal, `any -> inbox|explicit`, or
  `includeSpamTrash: true -> false` narrows; any added label, inverse selector,
  or `false -> true` loosens.
- Slack has `conversations`; only a strict subset narrows.  Adding any
  conversation or replacing a removal with an add/remove mixture loosens.
- Resend has `kinds`, the nonempty subset of `received|status`; only removing
  one or more kinds narrows and adding one loosens.
- WhatsApp has `chats: 'all-allowed' | readonly string[]`; `all-allowed`
  to a nonempty explicit set, or a strict explicit subset, narrows.  An
  explicit set to `all-allowed`, or adding a chat, loosens.

The normaliser emits, and activation/disclosure documents retain, only D4's
`{ channel: 'slack', conversations }` and
`{ channel: 'whatsapp', chats }` keys. Adapter selection reads those exact
keys after narrowing the channel variant; it does not accept, map, or emit
`conversationIds` or `chatJids`. The classifier and its vectors consume the
same canonical document value, so an alias cannot be signed, digested, or
selected for polling.

The classifier cannot waive a source/account mismatch and cannot classify a
different field, channel, or account set as a derived edit.  A derived
tightening has a new document digest but inherits byte-identical points, moves
stage debts to the child, invalidates the parent's snapshot, and makes no
provider call.  A loosening enters the ordinary approved activation path.

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
copy is disposed only to preserve the channel's checked-copy lifecycle; it
does not read, compare, or retain any value from that index.  It reads raw
message fields from the checked copy, not the live store, does not infer an
identity from `Z_PK`, and does not substitute an index-derived sender.  It
exposes `fromMe: true | false | null`; only exactly `false`, with nonempty raw
chat JID, raw sender JID, and stanza ID, is eligible.

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
pre-disclosure deliveries, dry-run records, snapshots, and unnecessary future
admissions. The D-6 registered B2 participant purges its stream and dead-letter
content in that same transaction. Widening produces no backfill.

Phase D provides these closed structural seams. They deliberately use the
daemon's existing SQLite transaction type without importing B2, so B2 can
register its retained-content participant after the branches converge while
the Phase-D branch remains independently buildable:

```ts
type WhatsAppSseFrameInput = Readonly<{
  accountId: string;
  whatsappMessageId: string;
}>;

interface SseFrameVisibilityGate {
  withCurrentSseFrameVisibility<T>(
    input: WhatsAppSseFrameInput,
    writeFrame: () => T,
  ): T;
}

interface WhatsAppListChangeParticipant {
  purgeNewlyHiddenInTransaction(
    tx: SqliteTransaction,
    input: Readonly<{
      accountId: string;
      newlyHiddenMessageIds: readonly string[];
      visibilityVersion: number;
      changedAt: string;
    }>,
  ): void;
}

interface DSourceRetentionParticipant {
  shortenOrPurgeInTransaction(
    tx: SqliteTransaction,
    input: Readonly<{
      ruleId: string;
      affectedVersionIds: readonly string[];
      revokedVersionId: string;
      at: string;
      changes: readonly Readonly<{
        retention: 'ingest' | 'hold' | 'delivery' | 'dead-letter' |
          'dry-run' | 'sse-replay' | 'decision-metadata';
        durationMs: number;
      }>[];
    }>,
  ): void;
}

interface DSourceRetentionHooks {
  registerWhatsAppListChangeParticipant(
    participant: WhatsAppListChangeParticipant,
  ): void;
  registerRetentionTighteningParticipant(
    participant: DSourceRetentionParticipant,
  ): void;
}
```

`WhatsAppVisibilityFence.withCurrentSseFrameVisibility` acquires
`withCurrentEventVisibility`, applies an unapplied durable digest journal,
checks the raw tuple for `input`, and invokes the synchronous `writeFrame`
while the same list lock remains held. It is the only implementation of
`SseFrameVisibilityGate`. `writeFrame` may neither await nor schedule a later
frame write; a hidden or unreadable list does not invoke it. B2's live and
`Last-Event-ID` replay writers call this exact method immediately before
**every** WhatsApp frame.

The owner calls every registered `WhatsAppListChangeParticipant` only while it
holds `.whatsapp-chats.lock` and inside the *same* SQLite transaction that
increments `whatsapp_visibility.version`, persists the new digest, and purges
the D-owned newly hidden data. The supplied message ids are the canonical
`whatsappMessageId` values of the newly hidden raw tuples. A participant may
make only synchronous SQL calls on `tx`; no await, independent transaction, or
post-commit deletion is permitted. The version/digest write, D purges, and all
participant purges commit together or all roll back; recovery retries an
unapplied digest before a source, read, append, or frame can proceed.

The derived-tightening transaction similarly calls every registered
`DSourceRetentionParticipant` after it has calculated the final affected
version set and before it commits the new pointer. For each changed retention,
the participant applies `min(oldDeadline, clockStart + durationMs)` to its
retained rows; it purges content already due, and it purges every row bound to
`revokedVersionId` irrespective of a changed retention. It must include
superseded `affectedVersionIds`, make only synchronous SQL calls on the
provided `tx`, and cannot start an independent transaction. Thus the derived
row/pointer, D-source shortening, and participant shortening/purges have one
commit boundary; restart sees either the old set or the fully shortened/purged
set.

B2 calls both registration methods exactly once during its owner setup. Its
list participant purges its `stream_log` rows and dead-letter payloads for the
provided account/message ids. Its retention participant shortens `stream_log`
only for `sse-replay`, shortens dead-letter payloads only for `dead-letter`,
and purges both for a revoked version. B2 owns the tests that prove those
registrations, including crash/restart and a list change between frame
preparation and write. Phase D ships neither a transport nor an SSE record
writer; its sealed-sink tests prove only the callback and transaction contract.

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
WhatsApp may reset and rebuild all checked-copy/source index state, but
discards only a non-head candidate and retains the authoritative D-owned
snapshot head, occurrence ledger, and admission ledger.  Its rebuilt index is
never an authority: recovery repeats candidate-versus-committed-head comparison
from the raw checked copy and those D records.
The scheduler round-robins ready `(source, account, scope)` work and persists
the next eligible instant/backoff.  It uses each manifest minimum interval and
provider `Retry-After`; a hot Slack reply drain, a Resend detail retry, or a
large WhatsApp account cannot monopolise the owner.  Resend's throttle rule in
D-4 is an additional cross-client fairness boundary.

### D-7a — fixed stage deadlines precede every adapter

Every source representation has one immutable `stagedAt` and
`stageExpiresAt = stagedAt + shortest ingest retention among every rule version
then owed`; the deadline is never extended.  The common expiry worker runs on
start-up before a source/worker can inspect or call a provider and on every
tick.  On restart or downtime past the deadline it atomically purges the
ciphertext and records only the source's content-free terminal outcome
(`retention-expired`, or WhatsApp's `expired`).  A provider-materialisation
retry has its own 24-hour deadline; the earlier deadline wins and an equality
is retention expiry, so no retry, gap, or provider call follows it.

A no-approval retention tightening runs one transaction that shortens, never
extends, every derived D-source deadline to `min(current, start + new
retention)`: shared/staged source rows and their debts, D-source occurrence or
admission rows, projections, holds, deliveries, dry-run rows, and retained
metadata. Rows already due terminate and purge in that transaction. The same
transaction invokes the registered `DSourceRetentionParticipant`; once B2 is
present that participant atomically shortens or purges B2's stream and
dead-letter content as D-6 specifies. Task 4a owns the D-side common contract
and hook contract; B2 Tasks 8–9 own its registered rows and their
crash/restart/list-change proof. Tasks 4–6 supply source-specific fixtures
rather than creating separate deadline rules.

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

The coordinator allocates Phase D's one additive migration from the migration
registry **after rebasing**, rather than naming a number in this plan.  It adds
the D-owned tables and nullable foreign-key columns to B1-present tables
without rewriting B1 rows:

- `slack_reply_drains`;
- `resend_status_state` with its seven-day retention index;
- `whatsapp_visibility`, `whatsapp_snapshot_heads`,
  `whatsapp_snapshot_keys`, `whatsapp_occurrences`, and
  `whatsapp_rule_admissions`;
- explicit source scan/reset/gap metadata where the generic B1 scan table
  cannot represent the durable boundary; and
- the nullable WhatsApp identity/visibility references required by D8 on the
  existing ingest, decision, delivery, and dry-run rows.

The migration uses `CHECK`s and uniqueness constraints for source kinds,
generation/head state, and raw canonical keys.  It is idempotent under the
existing migration ledger and is covered by an upgrade fixture from the final
B1 schema.  It creates the real `whatsapp_occurrences` parent in either merge
order, but never creates, rebuilds, or adds a foreign key to B2's
`stream_log`. Thus a B2-first standalone stream migration can remain usable
without a parent foreign key; after this D migration creates the parent, B2's
next forward convergence migration can add its foreign key. When D lands
first, the same parent already exists for B2's direct stream migration. No
table is repurposed for a provider's opaque cursor. The daemon declares the
exact workspace runtime dependencies on Slack, Resend, and
WhatsApp and externalises them; no channel package imports or depends on the
daemon.  `tsdown` keeps channel packages external and never bundles a provider
or native database binary.

### D-10 — held release contract

At the time the Phase-D PR is opened, its release owner reads the lockstep
version from the PR's post-merge target main (for example with
`git show <target-main>:package.json`), records that source version and date,
and proposes `MAJOR.(MINOR + 1).0-events-d` for a target version
`MAJOR.MINOR.PATCH`: a minor prerelease because this is the first held release
candidate to add three event-source families.  If a different post-merge main
or semver reason applies, the owner records the new base and reason in the PR
before proposing the corresponding prerelease.  The plan intentionally
contains no frozen version literal.  The PR does not publish or unhold
anything.  Its release note is:

> No changelog: Phase D only adds internal source support to the held local
> event daemon; no released CLI, MCP, or event package behaviour is available
> to users.

The PR carries focused synthetic tests, `pnpm verify:parity --strict`,
`pnpm verify:browser`, `pnpm verify:packages`, and `pnpm verify`, source/
manifest/reference documentation, and provenance describing the branch, exact
workspace package versions, and the sealed-fake test run.  It contains no real
token, API key, address, message, workspace, local-store copy, or provider
request/response.  Release provenance and an actual version bump are deferred
until the hold is lifted by the release owner.

### D-11 — Phase D / B2 merge contract

Phase D and B2 may develop in parallel but neither branch imports the other.
Whichever branch lands second renumbers only its own **unapplied** migration to
the next free registry number/name; neither recorded migration is edited,
renumbered, or duplicated. Phase D owns `whatsapp_occurrences` and every other
D table/column in a B1-present table. B2 owns `stream_log`, including its two
nullable WhatsApp fields, `whatsapp_message_id` and
`whatsapp_visibility_version`, their same-source `CHECK`, and the
`(account_id, whatsapp_message_id)` visibility-purge index. D never creates a
placeholder stream table.

There are two executable migration orders:

1. **D first.** D's migration creates the real
   `whatsapp_occurrences(account_id, message_id)` parent and the final-D
   fixture. B2's one rebased stream migration may declare its nullable pair,
   same-source `CHECK`, index, and
   `FOREIGN KEY (account_id, whatsapp_message_id) REFERENCES
   whatsapp_occurrences(account_id, message_id)` directly. Its upgrade test
   starts from the final-D fixture, proves the exact shape, runs
   `PRAGMA foreign_key_check`, and proves all earlier D ledger entries/names
   are unchanged.
2. **B2 first.** B2's standalone stream migration creates a usable
   `stream_log` with the nullable pair, same-source `CHECK`, and purge index,
   but **no foreign key that names `whatsapp_occurrences`**: SQLite foreign
   keys are enabled and the parent does not exist yet, so even a non-WhatsApp
   `NULL` row must remain insertable. D then rebases/renumbers its own
   migration, creates the D parent and final-D fixture without reading,
   rebuilding, or otherwise changing `stream_log`, and preserves every B2
   encrypted row byte-for-byte. B2 alone owns the next forward convergence
   migration after that parent exists. It rebuilds/copies `stream_log` to add
   the exact nullable pair, same-source `CHECK`, composite foreign key, and
   purge index; its test proves encrypted rows survive, valid nullable
   non-WhatsApp rows remain usable, invalid WhatsApp references are refused,
   and `PRAGMA foreign_key_check` is clean. It must not rewrite either the
   B2-first standalone migration or D's recorded migration.

Task 2 tests the D migration from both the final-B1 fixture and a synthetic
B2-first standalone-stream fixture: the former proves D's complete schema;
the latter proves D creates `whatsapp_occurrences` while leaving existing
`stream_log` schema and encrypted rows untouched. Task 10 audits B2's direct
or forward-convergence proof for the order actually landed.

B2 Tasks 8–9 own the stream/dead-letter implementation and test obligations
below; D Task 7 owns the normal production composition that constructs and
installs them once Phase D is present, and Task 10 audits the combined proof:

1. B2 supplies the concrete retained-content participant constructors to D
   Task 7's production composition. The list participant deletes B2
   `stream_log` and dead-letter payload content matching the supplied
   `(accountId, whatsappMessageId)` set on the supplied transaction. The
   retention participant applies the D-6 deadline formula to B2
   stream/dead-letter content of active and superseded affected versions and
   deletes every B2 row of `revokedVersionId` on that same transaction. The
   D-owned composition, not a test-only injection, constructs both through
   those constructors and registers each exactly once.
2. In `sse-dispatcher.ts` and `stream-replay.ts`, call
   `WhatsAppVisibilityFence.withCurrentSseFrameVisibility` for every live and
   `Last-Event-ID` replay WhatsApp frame, after preparation and immediately
   before the synchronous sealed-sink write. No await may separate the gate's
   final list check from that write.
3. Own `phase-d-b2-sse-visibility-contract.test.ts`. It upgrades from the
   final-Phase-D migration fixture; exercises both actual writers and each
   registered participant; pauses after frame preparation, applies a real
   `ChatListStore.update`, then releases the writer. It proves an allowed tuple
   writes once, a newly hidden tuple reaches neither sink, and its stream and
   dead-letter payload content are purged/refused. It injects crashes
   before/inside/after the common transaction and after the list-file commit,
   restarts before any read/replay/frame, and proves convergence. It then
   tightens `sse-replay` and `dead-letter` retention with live and superseded
   records both before and after their new bound, proving atomic
   shorten-or-purge. Mutating either writer to bypass the named gate, omitting
   either registration, splitting either purge/shortening into a second
   transaction, or omitting the stream index/column must fail it.

Task 10 is a convergence audit only: once both branches share one branch, it
runs and inspects B2's owned test and migration proof plus Task 7's production
owner-composition test. It creates no B2 table, migration, writer, participant,
or joint test.

## Spec amendments to raise with the owner

The following do not block implementation.  The plan uses the decisions above
until the owner changes the normative text.

| ID | Ambiguity / contradiction | Lines | Plan's safe interpretation |
| --- | --- | --- | --- |
| D-A | D4 requires an `agentcomms` manifest `events` declaration with types, minimum interval, and scopes/key kind, but does not define its strict JSON shape, property names, permitted credential kinds, or interval units. | 993–998 | Use the strict discriminated `events` object in D-1/D-9: `types`, `minimumIntervalMs`, and `access` (`oauth-user` + nonempty `requiredScopes`, `resend-full-access`, or `local-store`). Reject unknown fields. |
| D-B | The Slack aggregate barrier says replies must be “covered through P”, but does not specify the fixed request upper-bound or how an API whose reply ordering differs from history proves it. | 721 | Persist the parent, fixed `P`, cursor, and exact returned timestamp range; request/paginate until the adapter proves no reply <= `P` remains. If it cannot prove that, preserve the drain and do not finalise. |
| D-C | Resend status asks for a durable local start time but does not state its storage representation or how a local clock rollback is classified. | 959–965 and 985–990 | Store an ISO-8601 UTC instant plus monotonic scan generation; wall-clock rollback retains the prior high-water start and emits no backfill or gap. |
| D-D | D9 assigns every SSE-frame list check to Phase D even though B2 owns network delivery and stream-log writing. | 1901–1911 and 2824–2827 | Adopt D-11. D Task 7's `createPhaseDWhatsAppOwnerComposition` constructs the concrete `WhatsAppVisibilityFence` and B2 retained-content participants and injects them through ordinary `startEventOwner`; after D's WhatsApp registry entry exists, an absent seam fails closed and cannot select B2 pass-through. B2 Tasks 8–9 own the actual live/replay writer calls and prepared-frame mutation proof. No D-to-B2 runtime dependency is added. |
| D-E | D8 specifies `stream_log` WhatsApp columns although this B1-based branch has no B2 stream table; the parallel B2 migration must not be guessed or made to collide. | 1502–1507 and 1547–1552 | Adopt D-11. D owns the real `whatsapp_occurrences` parent but never a pretend stream table. If B2 lands first, its standalone stream migration has no foreign key to the absent parent and its later B2-owned convergence migration rebuilds/copies the exact nullable pair, check, foreign key, and purge index after D; if D lands first, B2 may declare that foreign key directly. Both paths preserve encrypted rows and prove `foreign_key_check`. |
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
| Generic first-activation/new-only baseline, encrypted point, pointer installation, scope-fence removal, and completion claim | switch/gen, pause, current core account, live version, intent claim, previous pointer, exact source/account/scope fence, and deadline before any write | `source-scope-fence.test.ts :: unpublished baseline blocks worker and scheduler` and `activation-write-fence.test.ts :: baseline completion loses account/switch/claim` (Task 3) |
| Initial-cursor point decryption -> cursor insert | current source/account/scope lock and scope fence, plus an in-transaction re-read of the canonical published-point set | `initial-cursor-fence.test.ts :: changed points or fence abandons insert` (Task 3) |
| Generic replacement drain creation/finalisation, derived tightening point/debt transfer, old-only debt settlement, and timeout/recovery transition | switch/gen, live old/new versions, enabled state, exact drain token/row, source scope, core account, rule-set generation, and deadline before finalisation writes or settlement | `replacement-write-fence.test.ts :: stale drain cannot move pointer` and `derived-tightening-source-race.test.ts :: stale scan cannot settle transferred debt` (Task 3) |
| Slack session open, history/replies page, and staged first representation -> occurrence/projection/scan/reply-drain/gap/watermark writes | all common checks, exact `(conversationId,ts)` row, scan generation/cursor, parent drain token | `slack-write-fence.test.ts :: page or reply result loses each boundary` (Task 4; adversarial audit in Task 9) |
| Resend throttle reservation, list/detail/body read, and encryption -> received scan, anchor, status state, terminal resolution, stage, and gap writes | all common checks, exact `anchorId/cycleHeadId`, status observation row, resolution lease | `resend-write-fence.test.ts :: stale detail result cannot advance anchor` (Task 5; adversarial audit in Task 9) |
| WhatsApp checked-copy/sync, list read, candidate read, visibility re-read, and encryption -> candidate, snapshot head/key, occurrence/admission, stage, baseline, and list-purge writes | all common checks plus list gate/version/digest, exact head generation, raw key, candidate token | `whatsapp-write-fence.test.ts :: visibility/head/account changes abandon candidate` (Task 6; list recovery audit in Task 9) |
| Scheduler provider-result health/backoff/next-slot update | current core account and scope ownership, active intent/scan generation, row version | `source-scheduler-fence.test.ts :: removed scope cannot be rescheduled` (Task 7) |
| Shared evaluator encryption/taint flush -> ingest rule/decision/delivery write for a D candidate | current account, switch/gen, live rule/target, claim and projection version | `d-source-taint-fence.test.ts :: taint flush loses rule or target` (Task 7) |
| Dry-run decrypt/taint/visibility read -> append, display transition, or purge | pause/switch/gen, core account/revocation, live rule/target, delivery row version; WhatsApp gate/version/digest | `whatsapp-dryrun-live-list.test.ts :: changed list before append/show purges` (Task 9) |
| B2 live/replay frame preparation -> sealed-sink frame write | same disclosure checks plus `WhatsAppVisibilityFence.withCurrentSseFrameVisibility` under the list lock, with no await after its final check | B2-owned `phase-d-b2-sse-visibility-contract.test.ts :: prepared frame rechecks and purges` (B2 Tasks 8–9; Task 10 audits it) |

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
| Claimed new-only baseline fence before publication | `S:claimed-P-fences-history-and-reply-worker` | `R:claimed-P-fences-received-and-status-worker` | `W:claimed-P-fences-snapshot-worker` |
| First-cursor lock/fence and published-point re-read after async point work | `S:initial-cursor-rechecks-points-under-conversation-lock` | `R:initial-cursor-rechecks-points-under-received-and-status-locks` | `W:initial-cursor-rechecks-generation-under-chat-lock` |
| Derived tightening transfers shared debts and invalidates the in-flight scan | `S:tighten-transfers-page-and-reply-debts-stale-scan-writes-nothing` | `R:tighten-transfers-received-and-status-debts-stale-scan-writes-nothing` | `W:tighten-transfers-first-representation-admissions-stale-snapshot-writes-nothing` |
| Swap settles old-only staged debt and deletes an unowed stage | `S:swap-drops-old-only-history-and-reply-debts` | `R:swap-drops-old-only-received-and-status-debts` | `W:swap-drops-old-only-first-representation-debt` |
| Deadline at baseline transaction, immediately after baseline, and before finalisation | `S:deadline-at-P-after-P-and-finalise-settles-without-write` | `R:deadline-at-P-after-P-and-finalise-settles-without-write` | `W:deadline-at-P-after-P-and-finalise-settles-without-head-write` |

For all rows, Task 8 also runs the three destructive mutations: advance the
pointer/cursor/head before staging, omit the conditional generation predicate,
and finalise an aggregate Slack drain after top-level coverage alone.  It also
mutates each round-9/10 guard: omit the source-scope fence, move the initial
cursor outside the scope lock or skip its point-set re-read, leave a transferred
debt on the parent or let its stale scan commit, retain an old-only debt at the
swap, and remove each baseline/after-baseline/finalisation deadline check.  At
least the corresponding S/R/W cell must fail.  WhatsApp has two additional
mutations: switch the head before first-representation staging, and derive a
raw key from `Z_PK`; its first-enabled and shared-replacement proofs must fail.

## Execution map

| Batch | Tasks | Dependency and worktree rule |
| --- | --- | --- |
| 1 — safety substrate | 1, then 2, then 3, then 4a | Sequential in one integration worktree.  It lands durable schema, source contracts, the per-scope liveness fence, and the common deadline contract before a source is written. |
| 2 — independent adapters | 4 Slack, 5 Resend, 6 WhatsApp | These three tasks run in parallel in separate worktrees after Batch 1.  Each owns only its channel package, its daemon source file(s), and source-specific fixtures/tests. |
| 3 — assemble and attack invariants | 7, then 8, then 9 | Rebase/merge the three source worktrees first.  Integration precedes the full cut-over matrix; the matrix precedes the post-await/list-change adversarial audit. |
| 4 — convergence, documentation, and held-release audit | 10, then 11, then 12 | Starts only after all behaviour and matrix tests are green. Task 10 runs only once D and B2 share one branch; it audits B2's owned proof without changing B2. |

Every batch ends with a clean `pnpm verify`.  The focused commands below are
diagnostic; passing them is not a substitute for that final batch command.

This is 13 implementation tasks: Task 4a is deliberately inserted before the
three adapters so the reviewed Task 4–12 identities—including Task 8's
per-source crash matrix—remain stable. It is a common pre-adapter gate, not a
fourth parallel adapter. Task 10 is deliberately an audit only; the B2 work it
checks belongs to B2 Tasks 8–9 under D-11.

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
  `packages/events-daemon/src/domain/activation-documents.ts`, and
  `packages/events-daemon/src/runtime/disclosure-fence.ts`.
- Add/modify `packages/events-daemon/test/source-options.test.ts`,
  `packages/events-daemon/test/activation-documents.test.ts`,
  `packages/events-daemon/test/disclosure-fence.test.ts`, and
  `packages/events-daemon/test/tightening.test.ts`, and
  `packages/core/test/channel-manifest.test.ts`.

**Steps (tests first)**

1. Add red table-driven normalisation and classifier vectors for all four source
   variants: empty and duplicate arrays; UTF-8 ordering; malformed IDs; bad
   Resend kinds; invalid `all-allowed`; and source options that do not match
   the channel account.  For every channel test exactly one-field strict
   narrowing and its inverse loosening: Gmail label removal/`any` narrowing and
   `includeSpamTrash: true -> false`; Slack `conversations` strict subset and
   addition; Resend `kinds` (`received`/`status`) strict subset and addition;
   WhatsApp explicit `chats` strict subset and addition plus
   `all-allowed -> explicit subset` and the inverse.  A mixed add/remove is a
   loosening.  Add manifest vectors that reject unknown keys, zero/non-integer
   intervals, empty types/scopes, and incompatible access kinds.
2. Run the focused tests and confirm the pre-change tree cannot represent
   Slack/Resend/WhatsApp or an `events` manifest declaration.
3. Add the strict manifest discriminated union from D-A, including event types,
   `minimumIntervalMs`, and access requirements.  Declare Gmail's existing
   types/read scope plus Slack's history/reply types and OAuth scopes, Resend's
   received/status types and full-access key kind, and WhatsApp's message type
   and local-store kind.  Keep the package JSON `agentcomms` object strict.
4. Expand canonical source options and activation documents to the exact
   Phase-D variants. The Slack normaliser/document/adapter-selection branch
   reads and emits `conversations`; the WhatsApp branch reads and emits `chats`.
   Reject `conversationIds` and `chatJids` rather than translating them.
   Deduplicate and byte-sort permitted arrays before signing or comparing a
   document; preserve raw WhatsApp JIDs as raw strings. Export one
   `classifySourceOptionChange` dispatcher that validates matching channel
   variants then delegates all four field-by-field subset classifiers; replace
   Gmail-only use in `isWhitelistedTightening` with it.
5. Add derived-authorisation vectors: every accepted D-source narrowing changes
   the immutable document digest, copies byte-identical inherited points,
   transfers debt to the child, and makes **no provider call**; every loosening
   is refused from the no-approval path and requires an ordinary activation.
6. Regenerate the checked-in manifest artifact, rerun the tests, and run the
   package type checks.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/core test -- channel-manifest
pnpm --filter @agentcomms/events-daemon test -- source-options activation-documents disclosure-fence tightening
pnpm sync:channels
pnpm --filter @agentcomms/core typecheck
pnpm --filter @agentcomms/events-daemon typecheck
```

The focused suites pass; regeneration is either the expected reviewed
manifest/type diff or clean on a rerun.  Mutate a D subset classifier to treat
an addition as tightening, keep the Gmail-only classifier in the authority
fence, skip sorting, accept an unknown manifest key, or accept a source/account
mismatch: the named vectors fail.  Mutating derived tightening to call a D
provider, alter an inherited point, or keep a parent debt also fails.

**Commit:** `feat(core): declare event source metadata (events phase D, task 1)`

### Task 2 — add D-owned durable state and generic account purge authority

**Files**

- Modify `packages/events-daemon/src/store/migrations.ts`,
  `packages/events-daemon/src/store/records.ts`, and any migration fixture
  builder; do not edit a B2-only stream migration.
- Modify `packages/events-daemon/src/runtime/account-fence.ts`,
  `packages/events-daemon/src/runtime/revocations.ts`,
  `packages/events-daemon/src/runtime/disclosure-fence.ts`, and
  `packages/events-daemon/src/runtime/dispatcher.ts` only to make account and
  source cleanup generic; do not add a source driver here.
- Add/modify `packages/events-daemon/test/migrations-phase-d.test.ts`,
  `packages/events-daemon/test/account-fence-phase-d.test.ts`.

**Steps (tests first)**

1. Write upgrade tests from the final B1 fixture and from a synthetic B2-first
   standalone-stream fixture. Assert the exact rebased-registry D table,
   index, foreign-key, `CHECK`, and nullable-column shape; assert a second
   open is a no-op and a B1 Gmail record remains readable. For the B2-first
   fixture, seed an encrypted `stream_log` row with the nullable WhatsApp pair
   and no parent foreign key; prove this D migration creates
   `whatsapp_occurrences` but neither creates/rebuilds `stream_log` nor changes
   its schema or ciphertext bytes. Assert no `stream_log` table or stream
   column is created from the final-B1 fixture.
2. Write account/rule/target-removal tests that seed each new D table and prove
   a removal purges its account/version rows immediately while preserving
   another account.  Include retention of a content-free terminal/gap audit
   decision where the spec requires it.
3. Add the one forward migration allocated from the rebased registry as D-9
   specifies.  Do not alter `schema-v1.ts`, recreate old tables, hard-code a
   branch-local migration number, or create B2's absent stream table.
4. Generalise the B1 purge/query helpers by explicit source/account predicates;
   make every removal path call them in the same transaction.  Add typed record
   helpers rather than passing opaque provider JSON through the store.
5. Run migration, foreign-key, and purge checks against a fresh DB and the
   final-B1 fixture.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- migrations-phase-d account-fence-phase-d
pnpm --filter @agentcomms/events-daemon typecheck
```

The final-B1 fixture upgrades once, the B2-first fixture gains the real D
parent without changing its stream row, all D tables are constrained, and
removal purges only the affected account. Mutate the allocated migration ledger
version, create or rebuild a placeholder stream table, remove a raw-key
uniqueness constraint, or omit one D table from account purge: the named test
must fail.

**Commit:** `feat(events): add durable multi-source authority (events phase D, task 2)`

### Task 3 — generalise activation, scheduling, and write fences **(risky)**

**Files**

- Add `packages/events-daemon/src/sources/contracts.ts`,
  `packages/events-daemon/src/sources/registry.ts`, and
  `packages/events-daemon/src/sources/scope-lock.ts` and
  `packages/events-daemon/src/sources/source-scope-fence.ts`; refactor
  `packages/events-daemon/src/sources/mailbox-fence.ts` to the Gmail wrapper
  of that shared predicate.
- Modify `packages/events-daemon/src/runtime/activations.ts`,
  `packages/events-daemon/src/runtime/baseline.ts`,
  `packages/events-daemon/src/runtime/replacements.ts`,
  `packages/events-daemon/src/runtime/scheduler.ts`,
  `packages/events-daemon/src/runtime/account-fence.ts`, and
  `packages/events-daemon/src/runtime/owner.ts`.
- Add/modify `packages/events-daemon/test/source-contracts.test.ts`,
  `packages/events-daemon/test/source-scope-fence.test.ts`,
  `packages/events-daemon/test/initial-cursor-fence.test.ts`,
  `packages/events-daemon/test/derived-tightening-source-race.test.ts`,
  `packages/events-daemon/test/activation-write-fence.test.ts`,
  `packages/events-daemon/test/replacement-write-fence.test.ts`,
  `packages/events-daemon/test/source-scheduler-contract.test.ts`, and the
  existing activation/replacement/scheduler tests.

**Steps (tests first)**

1. Build a fake ordered source adapter in tests for a Slack conversation, both
   Resend scopes, and a WhatsApp chat.  Its operations deliberately pause after
   baseline sampling, point encryption, candidate staging, drain completion,
   and before each conditional update.  Port the B1 Gmail cases through it
   without changing their Gmail semantics.
2. Add red tests for `SOURCE_UNAVAILABLE`, ordered scope locking, round-robin
   ready work, pause before recovery, K6 re-add darkness, and every generic
   post-await write in the write-after-await table.  For every D scope, prove
   a claimed new-only baseline blocks its worker and the scheduler's first
   cursor; prove that an old-version drain does not block it.
3. Introduce the closed adapter/registry and scope-lock contracts.  Refactor
   activation, baseline, replacement, and scheduler code to use typed source
   points rather than Gmail-only mailbox types.  Keep the Gmail adapter as the
   reference implementation and ensure it remains the only registered source
   until the Batch-2 worktrees merge.
4. Implement `isSourceScopeFenced` and use it in every source worker and the
   scheduler.  Initial-cursor installation holds the same source scope lock,
   reads/decrypts candidate published points outside its write transaction, then
   re-reads the canonical point set and the fence inside that transaction before
   it inserts.  A changed set or fence inserts nothing and the next tick
   recomputes it.
5. Implement `assertWriteStillLive` and use conditional insert/update/delete
   predicates at each generic durable edge.  It must reload core config inside
   the transaction and invoke immediate purge on removal.  Do not await
   encryption, a config load, or a provider operation while a write transaction
   is open.
6. Make activation completion, replacement drains, timeout/recovery, and
   scheduler state source-neutral.  A derived tightening atomically transfers
   all parent stage debts to the child before parent purge and increments the
   rule-set generation so an in-flight scan writes nothing; swap atomically
   drops old-only debts and deletes an unowed stage.  Check the deadline in the
   baseline transaction, directly after baseline, and before finalisation does
   any write or settlement; finalisation commits its content-free failure
   settlement before refusing.  Preserve B1's first-activation lock,
   disabled-replacement, and aggregate-finalisation rules.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- source-contracts source-scope-fence initial-cursor-fence derived-tightening-source-race activation-write-fence replacement-write-fence source-scheduler-contract activations replacements scheduler
pnpm --filter @agentcomms/events-daemon typecheck
```

All existing Gmail lifecycle tests and the fake-source race tests pass.  Delete
the switch/config/claim re-check, the source-scope fence, the in-transaction
point re-read, a debt transfer/old-only settlement, any of the three deadline
checks, make a pointer update unconditional, or let two scope locks overlap:
the named fence/contract test fails.

**Commit:** `feat(events): generalise source activation fences (events phase D, task 3)`

### Task 4a — enforce stage deadlines and retention tightening before adapters **(risky)**

**Files**

- Modify `packages/events-daemon/src/store/retention.ts`,
  `packages/events-daemon/src/runtime/expiry.ts`,
  `packages/events-daemon/src/runtime/replacements.ts`, and the generic source
  contracts/records from Tasks 2–3 only to carry immutable `stagedAt`,
  `stageExpiresAt`, owed-version debts, and source-terminal outcomes.
- Add `packages/events-daemon/src/runtime/retained-content-hooks.ts` for the
  D-6 participant registration and in-transaction dispatch; it imports no B2
  module and owns no B2 table.
- Add/modify `packages/events-daemon/test/stage-deadline-contract.test.ts`,
  `packages/events-daemon/test/stage-deadline-recovery.test.ts`,
  `packages/events-daemon/test/retention-tightening-phase-d.test.ts`,
  `packages/events-daemon/test/retained-content-hooks.test.ts`, and
  common fake-clock/source-stage helpers under
  `packages/events-daemon/test/support/`.
- Task 4 supplies Slack's fixture cases in `slack-source.test.ts` and
  `slack-reply-drains.test.ts`; Task 5 supplies Resend's in
  `resend-source.test.ts` and `resend-status.test.ts`; Task 6 supplies
  WhatsApp's in `whatsapp-source.test.ts` and `whatsapp-visibility.test.ts`.
  Those fixtures exercise this task's common suite; they do not own a second
  deadline policy.

**Steps (tests first)**

1. Write a generic four-source fixture matrix that stages shared work for two
   owed versions with unequal ingest retentions.  Assert fixed `stagedAt`, the
   shortest `stageExpiresAt`, no extension after a later/looser version, and
   content-free expiry outcomes.  Test one tick before, exactly at, and after
   expiry before admission, between admission and projection, and after one
   projection; inspect database, WAL, and free pages for no surviving payload.
2. Add restart/start-up tests that stop before/during/after the expiry
   transaction and start the daemon after its deadline.  The start-up recovery
   must expire before any source worker/provider call.  Add an after-P
   replacement-drain case: an owed staged item that expires settles the drain
   without an event or delivery.
3. Add retry-composition vectors for every source that materialises/retries:
   retry deadline first produces one `unresolvable` gap, stage deadline first
   produces `retention-expired`/WhatsApp `expired` and no gap, and an equal
   deadline chooses retention expiry.  Assert no retry/provider request occurs
   after that terminal transaction.
4. Add retention-tightening fixtures that seed each affected D shared/staged
   row and retained row—stage/debt, occurrence/admission, projection, hold,
   queued/retryable/disclosing delivery, dry-run, and metadata.  A shortening
   atomically applies `min(current, start + newRetention)` to every affected
   row and terminates/purges already due content in that same transaction.
5. Add red structural-hook tests. A registered list participant receives only
   canonical newly-hidden message ids and the open transaction; a registered
   tightening participant receives active and superseded versions, the
   revoked version, and only the changed retention values. Assert both run
   before the owner commits, cannot issue an asynchronous callback, and a
   thrown participant leaves the D pointer/digest/deadlines unchanged. These
   are seam tests, not B2 stream/dead-letter tests.
6. Implement the common calculator, start-up/tick expiry, retry arbitration,
   one-transaction shortening, and the D-6 registration/dispatch contract.
   Keep source adapters unable to choose a longer deadline or invent a terminal
   outcome. Incorporate the named Slack, Resend, and WhatsApp fixture cases
   when their parallel tasks merge.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- stage-deadline-contract stage-deadline-recovery retention-tightening-phase-d retained-content-hooks gmail-stage-deadline
pnpm --filter @agentcomms/events-daemon typecheck
```

Every source fixture observes a fixed shortest deadline, start-up expires
before a provider call, retries choose the earlier bound, and a tightening
shortens every seeded shared/staged and retained row atomically. The hook suite
also proves that a future B2 participant shares—not follows—the D transaction.
Mutate `stagedAt` on restart, use a longest/later deadline, let a retry win an
equal deadline, skip start-up expiry, leave any listed row unshortened, split
shorten/purge into transactions, or dispatch a participant after commit: the
named suite fails.

**Commit:** `feat(events): enforce source stage deadlines (events phase D, task 4a)`

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
   only at an explicit boundary; top-level/reply aggregate barriers; each
   staged-result race in the write-fence table; and Task 4a's fixed-shortest
   stage deadline/restart/start-up expiry, after-P drain expiry, and atomic
   retention-tightening fixtures for both history and reply staging.
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
   Register the Slack fixtures in Task 4a's common deadline suite rather than
   duplicating expiry policy.

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
   `404`, 24-hour retry exhaustion, fixed-shortest stage expiry, tie-breaking
   retry versus stage deadline, restart/start-up and after-P expiry,
   retention-tightening of received/status shared rows, ten-page anchor loss,
   status seed/no-event, seven-day pruning, and interactive-versus-event
   throttle ordering.  Register these as Resend's fixtures in Task 4a's common
   deadline suite.
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
  `packages/events-daemon/src/runtime/whatsapp-admissions.ts`; modify the
  Task-4a retained-content hook registry only to dispatch a list participant
  from the D-owned list-change transaction.
- Add/modify `packages/events-daemon/test/whatsapp-source.test.ts`,
  `packages/events-daemon/test/whatsapp-visibility.test.ts`,
  `packages/events-daemon/test/whatsapp-write-fence.test.ts`,
  `packages/events-daemon/test/whatsapp-index-recovery.test.ts`,
  `packages/events-daemon/test/whatsapp-taint.test.ts`, and
  `packages/events-daemon/test/sse-frame-visibility-gate.test.ts`.

**Steps (tests first)**

1. Extend the WhatsApp harness with checked-copy messages whose `Z_PK`, sender,
   `fromMe`, chat JID, stanza ID, ordering, disposal timing, and human list
   file can differ. It exposes `resetAndRebuildAllIndexState()` which clears
   and rebuilds **all index state**, including every checked-copy/source index
   cache and persisted index record, from raw rows without changing the D
   database. It must never open a real local store. Add vectors
   that prove `null` `fromMe` is excluded; duplicate index values cannot
   collide; raw sender differences make different keys; and copy disposal
   before first representation is observable.
2. Add failing tests for candidate/head crash edges, list changes while waiting
   at every gate, unreadable-list hide-all, newly hidden purge, widening with
   no backfill, raw-key rule admissions, disabled activation, every synthetic
   frame invoking the visibility callback, and Task 4a's fixed-shortest first-
   representation deadline/restart/start-up expiry, after-P expiry, and atomic
   retention-tightening fixtures. Register the last group in Task 4a's common
   deadline suite. In the separately named
   `whatsapp-index-recovery.test.ts`, commit an eligible post-cut-over
   emission, call `resetAndRebuildAllIndexState()` after every committed
   generation, and vary every raw row's `Z_PK` on each rebuild. Repeat with a
   retained emitted key, a newly present candidate key, and a candidate paused
   after candidate-key writes/before the head commit and after that commit;
   crash and reopen the same on-disk database at each pause. Assert that the
   pre-reset `whatsapp_snapshot_heads` row and its committed snapshot remain
   authoritative, and that `whatsapp_occurrences` and
   `whatsapp_rule_admissions` retain their rows and remain authoritative. The
   adapter must compare the raw candidate only with that D-owned committed
   generation—not the rebuilt index—and recovery must discard an uncommitted
   candidate or resume a committed one correctly. Assert exactly one raw
   occurrence and one per-rule admission/projection/delivery for every
   post-cut-over raw key, with no backfill or duplicate after each reset,
   rebuild, and restart.
3. Factor the channel's checked-copy routine so both ordinary sync and the
   event adapter invoke the lifecycle rebuild before disposal, while the event
   adapter copies raw fields and never reads the rebuilt index. Add a raw event
   reader with tri-state `fromMe`; preserve the existing presentation reader's
   public behaviour. Expose `withCurrentEventVisibility` under the list lock.
   Its request/result/callback types are structural and it declares no daemon
   dependency or import.
4. Implement candidate generation, second visibility read, conditional
   head-switch transaction, raw occurrence/admission ledgers, baseline tuple,
   and immediate hidden-data purge.  Stage every owed first representation
   while the checked copy remains open; on any failure discard the candidate,
   not the previous head. An index reset/source rebuild may clear only index
   state: candidate recovery reads the D-owned committed head and both D-owned
   ledgers, and no reset path may delete or reseed any of them.
5. Add `WhatsAppVisibilityFence.withCurrentSseFrameVisibility` with the exact
   D-6 generic signature and sealed-sink tests. Add the list-change dispatcher
   that invokes registered `WhatsAppListChangeParticipant`s before its one
   transaction commits; test rollback when a participant throws. It is a
   callback seam only: do not add an SSE client, HTTP transport, B2 dependency,
   B2 participant, or send path. Add source fairness and taint cases.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/whatsapp test -- events checked-copy lists
pnpm --filter @agentcomms/events-daemon test -- whatsapp-source whatsapp-visibility whatsapp-write-fence whatsapp-index-recovery whatsapp-taint sse-frame-visibility-gate
pnpm --filter @agentcomms/whatsapp typecheck
pnpm --filter @agentcomms/events-daemon typecheck
```

Only raw protocol keys reach the ledger, every checked copy follows its index
lifecycle before disposal without the adapter reading the index, committed
heads and both ledgers survive an index reset/source rebuild, and list changes
prevent disclosure and purge newly hidden D data. Mutate the key to use `Z_PK`,
make the adapter read the rebuilt index, clear `whatsapp_snapshot_heads`,
clear `whatsapp_occurrences` or `whatsapp_rule_admissions` during a reset,
collapse `fromMe` to boolean, switch the head before staging, cache lists, skip
one sealed-frame callback, or dispatch a list participant after commit: the
named tests fail. The B2-owned test in D-11 separately proves actual
stream/dead-letter purge and real writer behaviour.

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
  `packages/events-daemon/src/runtime/phase-d-whatsapp-owner-composition.ts`,
  `packages/events-daemon/src/runtime/scheduler.ts`,
  `packages/events-daemon/src/runtime/activations.ts`, and
  `packages/events-daemon/src/operations/sources.ts` only where registry
  integration requires it.
- Modify `capabilities.json`, `scripts/parity.mjs`, and
  `packages/events-daemon/test/capability-audit.test.ts`.
- Add/modify `packages/events-daemon/test/phase-d-owner-e2e.test.ts`,
  `packages/events-daemon/test/phase-d-owner-composition.test.ts`,
  `packages/events-daemon/test/source-scheduler-fence.test.ts`,
  `packages/events-daemon/test/d-source-taint-fence.test.ts`,
  `packages/events-daemon/test/channel-package-boundary.test.ts`, and existing
  CLI/MCP stand-in fixtures.
- Modify generated command/tool reference files only if `pnpm sync:reference`
  produces a semantic D-source result; otherwise record a clean generation.

**Steps (tests first)**

1. Define the D-owned production composition function in
   `phase-d-whatsapp-owner-composition.ts` with this exact signature:

   ```ts
   export function createPhaseDWhatsAppOwnerComposition(
     input: Readonly<{
       database: EventDatabase;
       chatLists: ChatListStore;
       createRetainedContentParticipants: (
         input: Readonly<{ database: EventDatabase }>,
       ) => Readonly<{
         list: WhatsAppListChangeParticipant;
         retention: DSourceRetentionParticipant;
       }>;
     }>,
   ): Readonly<{
     visibilityFence: WhatsAppVisibilityFence;
     retainedContentHooks: DSourceRetentionHooks;
   }>;
   ```

   It constructs the concrete `WhatsAppVisibilityFence` and D hook registry,
   calls the supplied B2 retained-content participant constructor, registers
   the resulting list and retention participants exactly once, and returns the
   concrete fence and hooks. It is the only place those participants are
   registered: `startEventOwner` supplies B2 Task 8a's exported
   `createB2RetainedContentParticipants` as `createRetainedContentParticipants`
   and registers nothing itself, before D or after. `startEventOwner` is the ordinary production
   composition site: whenever its source registry contains WhatsApp, it calls
   this function and injects its returned fence/hooks into the actual owner,
   dispatcher, and live/replay writer path. B2-alone may select its structural
   pass-through only when the registry has no D WhatsApp source. Once D's
   WhatsApp source is registered, a missing constructor, failed composition, or
   absent returned seam must reject owner start with
   `WHATSAPP_VISIBILITY_SEAM_REQUIRED` before scheduling or dispatch; it must
   never select B2's pre-D pass-through for a WhatsApp row.
2. Add `phase-d-owner-composition.test.ts` before implementation. Boot the
   normal `startEventOwner` path with the D WhatsApp registry entry and the
   production B2 retained-content constructors, not an injected fence or hook
   test double. Assert it constructs one `WhatsAppVisibilityFence`, registers
   exactly one list and one retention participant, and passes that concrete
   fence/hooks to the actual owner path. Add the negative production-owner
   case with the D registry entry but no participant constructor/seam: startup
   fails closed with `WHATSAPP_VISIBILITY_SEAM_REQUIRED`, schedules no WhatsApp
   work, writes no WhatsApp frame, and makes zero calls to B2's pass-through
   gate. Keep a pre-D registry-only control case to prove the B2-alone
   pass-through remains confined to the no-D path.
3. Add sealed end-to-end tests that boot one owner with all four fake adapters,
   interleave ready scopes, pause/remove an account while a source is in
   flight, and query each source through both CLI and MCP stand-ins.
4. Add red parity rows from D-8. For each row, make CLI and MCP invoke the
   same `sourceShow` operation and assert the matching source result.  Add a
   `sources list` assertion that all four registry entries are visible without
   adding a duplicate capability.
5. Add explicit workspace runtime dependencies and externalisation for Slack,
   Resend, and WhatsApp **to `@agentcomms/events-daemon` only**.  Channel
   `package.json` files retain no daemon dependency and their `events.ts`
   operations retain no daemon import, including type-only imports.  Register
   all adapters once in the owner and inject fakes in tests; no source reaches a
   provider constructor directly.
6. Merge source scheduling with persisted fair ready-work selection, manifest
   minimums, provider backoff, and source-specific locks.  Ensure every
   provider call and provider-result write observes fresh core config; update
   `source show` to expose content-free state only.
7. Run parity/reference generation and inspect that no new command/tool slipped
   in.  Extend existing taint/disclosure tests across all D candidate types.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- phase-d-owner-e2e phase-d-owner-composition source-scheduler-fence d-source-taint-fence channel-package-boundary capability-audit
pnpm verify:parity --strict
pnpm sync:reference
pnpm --filter @agentcomms/events-daemon typecheck
```

Every source is selected through one owner, a D-present owner constructs and
injects the concrete WhatsApp fence and both retained-content participants,
the missing-seam case fails closed rather than selecting pass-through, each
added source-show invocation has CLI/MCP parity, and a removed account cannot
be rescheduled or disclosed. Mutate a parity row to a different operation,
register an adapter or participant twice, omit the D production composition,
fall back to B2 pass-through after WhatsApp is registered, cache core config
across the provider await, add a daemon dependency/import to a channel, or
bypass taint: the named test, package-boundary test, or strict parity check
fails.

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
   initial cursor; timeout; and recovery.  For every source add the five new
   round-9/10 matrix rows, covering six guards: unpublished new-only P fences
   its worker, the scheduler's locked first-cursor fence plus point-set re-read,
   derived debt transfer plus stale-scan loss, old-only debt settlement/deletion
   at swap, and all three deadline moments.  Assert exact version admission and
   exact raw key/Slack timestamp/Resend ID counts, provider-call count zero
   while fenced, and content-free settlement on deadline failure.
3. Add the required destructive mutations as test-local toggles or mutation
   patches: stage-after-pointer, unconditional pointer/head/cursor update,
   Slack top-level-only finalisation, WhatsApp early head, WhatsApp `Z_PK`
   identity, each round-9/10 guard named below the matrix, and all three
   deadline checks.  Confirm each produces a failing oracle before accepting
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
   digest/version write; between each D-owned purge set; after candidate stage;
   before head switch; after head switch; dry-run show; dry-run append;
   baseline finalise; and the D sealed synthetic callback. Reopen/retry until
   stable. These tests prove D's gate and participant transaction contract;
   B2 Tasks 8–9 own the actual stream/dead-letter, live/replay, and
   prepared-frame list-change matrix in D-11.
3. Add a live-core-config test at every source boundary (poll, candidate
   commit, scheduler reschedule, disclosure, dry-run) to prove account data is
   never reused from an earlier read.  Add an unreadable-list test for hide-all
   without destructive purge.
4. Fix only demonstrated stale-write/list-recovery defects. Require a single
   gate callback at dry-run and synthetic-frame boundaries, and retain the B2
   seam without importing or constructing B2.

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

### Batch 4 — D/B2 convergence, documentation, and held-release handoff

### Task 10 — audit the converged D/B2 visibility and retention contract

**Inputs (read-only)**

- B2's rebased migration, `stream_log` schema test, actual
  `sse-dispatcher.ts` and `stream-replay.ts`, and its owned
  `phase-d-b2-sse-visibility-contract.test.ts`.
- Phase D's D-6 seam definitions and the final-Phase-D migration fixture.

**Steps**

1. Start only after D and B2 share one branch. Read B2's migration and writer
   code before running it. Confirm the D-11 migration order actually landed:
   direct nullable-pair/check/composite-foreign-key/index migration after D,
   or a B2-first no-parent-FK standalone migration followed by its B2-owned
   rebuild/copy convergence migration after D. Confirm preserved encrypted
   rows, `PRAGMA foreign_key_check`, the D Task 7 one-time production
   construction/registration of both retained-content participants, and the
   named gate at both actual writer sites.
2. Run B2's owned migration and contract test. Inspect its test setup to
   confirm it covers live and replay writes, a list change between preparation
   and write, bypass mutations, restart/crash points, list-triggered stream
   and dead-letter purge, and `sse-replay`/`dead-letter` shortening for live
   and superseded records. Run Task 7's production-owner test too; confirm its
   negative D-present/missing-seam case fails closed and records no call to the
   pre-D pass-through gate.
3. Record pass/fail and the verified B2 commit in the PR evidence. A missing
   proof or failing mutation is a convergence blocker for its B2 owner; do not
   implement, edit, or repair any B2 file in this task.

**Commands and passing result**

```sh
pnpm --filter @agentcomms/events-daemon test -- phase-d-owner-composition phase-d-b2-sse-visibility-contract migrations
```

The combined proof demonstrates the required migration order, a concrete
ordinary-owner composition with no D-present pass-through fallback, hidden
WhatsApp content reaching neither stream nor dead-letter retention, and no B2
content surviving a relevant D-source tightening. This task builds nothing.

**Commit:** none — audit only; Task 11 records the result.

### Task 11 — document the Phase-D surface and handoff evidence

**Files**

- Modify `packages/events-daemon/README.md`, channel README/reference material,
  and generated reference artifacts only where Phase D makes an already-present
  surface more specific.
- Add/modify a release/PR evidence note under `docs/superpowers/` if the normal
  PR template cannot carry the required held-release evidence.

**Steps**

1. Document the four-source local-only boundary, source constraints, fake-only
   testing, Slack reply barrier, Resend detail/Unicode semantics, and the
   WhatsApp live-list/SSE seam. State that B2's `stream_log` and dead-letter
   handling is registered into D's one transaction; do not expose raw
   identities, cursor contents, or fixtures as examples.
2. Prepare the PR checklist from the target main checked at PR-open time:
   record its lockstep version, the next-minor prerelease derived by D-10 and
   its semver reason, the No-changelog sentence, verification commands/results,
   branch/workspace provenance, B2 commit audited by Task 10, and “no real
   data, no real transport, no send path.” Do not reuse a stale version.
3. Generate references twice, inspect the reviewed diff, and retain only a
   semantic Phase-D documentation change.

**Commands and passing result**

```sh
pnpm sync:reference
pnpm sync:reference
git diff --check
```

The second generation is clean, documentation is safe and source-specific, and
the handoff names the audited B2 proof without claiming a release.

**Commit:** `docs(events): document Phase D sources and handoff (events phase D, task 11)`

### Task 12 — audit public surface, packaging, and held-release readiness

**Inputs (read-only)**

- `capabilities.json`, generated references, `scripts/packages.mjs`, held
  release wiring, packed-consumer verifier, and the completed Task-10/11 diff.

**Steps**

1. Run the strict capability audit with a deliberately missing/misnamed D row
   in an isolated temporary copy, confirm failure, then discard that copy.
   Confirm every command and tool maps to exactly one shared operation.
2. Confirm the structural boundary test rejects every channel -> daemon import
   or dependency, and `pnpm verify:packages` packs each consumer closure while
   the daemon remains held. Do not duplicate the package graph in a new test
   unless the existing audit demonstrates a specific gap.
3. Run the full verification and inspect the package graph, secret-scan output,
   fake request journals, and mutation results before handoff.

**Commands and passing result**

```sh
pnpm verify:parity --strict
pnpm verify:browser
pnpm verify:packages
pnpm verify
git diff --check
git status --short
```

Strict parity, browser verification, packed-consumer, held-release, and full
verification pass. The final diff contains only source, tests, documentation,
and generated artifacts; no credentials or realistic provider data. A missing
D row, changed operation, channel -> daemon edge, undocumented command/tool,
or failed Task-10 proof blocks handoff.

**Commit:** none — final verification and PR handoff only.

## §5 coverage ownership

Each Phase-D-owned §5 row has exactly one primary implementation task.  A task
may exercise a case incidentally, but it is not a second owner.

| §5 coverage row D owns | Primary task |
| --- | --- |
| Four-variant source-option validation, exact field-by-field subset classifier, derived digest/point/debt transfer, and no-provider-call narrowing proof | Task 1 |
| Slack history pagination: empty/short pages with cursors, invalid-cursor restart, retained-history gap, decimal timestamps, persisted budget/429 continuation | Task 4 |
| Slack reply pagination and aggregate top-level/reply drain barrier, including restart and fairness | Task 4 |
| Resend received newest-first anchor/cycle, required detail terminal outcomes, 10-page bounded reset, and received source gaps | Task 5 |
| Resend body Unicode-code-point vectors, attachment facts, status seeding/deltas, seven-day state, and shared-throttle interactive priority | Task 5 |
| WhatsApp checked-copy/index lifecycle; reset/rebuild of **all** index state with post-commit `Z_PK` variation; candidate-versus-committed-head recovery without index reads; preserved authoritative snapshot head, occurrence/admission ledgers, and exactly-once projection/delivery across crashes; raw protocol key, tri-state `fromMe`, snapshot generation diff, first representation, and raw admission ledger | Task 6 |
| WhatsApp list digest/version application, hide-all read failure, newly-hidden purge, no widening backfill, dry-run reads, and sealed synthetic every-frame gate | Task 6 |
| Fixed shortest stage deadline, restart/start-up expiry, retry-deadline composition, after-P expiry, atomic retention shortening of every affected D shared/staged and retained row, and the synchronous participant contract for B2 retained content | Task 4a |
| Per-source untrusted-content envelope and taint before dry-run disclosure | Task 7 |
| D-owned CLI/MCP parity: Slack, Resend, and WhatsApp `source show`, complete `sources list`, and one-way daemon -> channel package boundary | Task 7 |
| First activation/disabled activation, exact replacement (old-only/new-only/shared), enable-all, derived tightening, initial cursor, and every round-9/10 fence/debt/deadline crash race for all D sources | Task 8 |
| Disable-all, rule/target removal, account removal and K6 re-add, claimed recovery/restart, timeout, and crash at every D-source durable edge | Task 8 |
| Every post-await transaction fence, live core-config reread, stale-row conditional write, immediate removal purge, and WhatsApp D9 list-change recovery at every durable edge | Task 9 |
| B2-owned live/replay every-frame gate, migration/stream-column, list-change purge, and retention-shortening proof; Phase-D-only convergence audit of that proof | B2 Tasks 8–9; Task 10 audits |
| Four-source documentation, generated-reference stability, and held-release/PR provenance | Task 11 |
| Strict capability, package-boundary, packed-consumer, held-release, and final verification audit | Task 12 |

## Pull-request handoff checklist

- The daemon and `@agentcomms/events` remain held.  No publish, tag, release
  PR, or version unhold is part of this work.
- At PR creation, the release owner records the post-merge target-main version,
  derives the D-10 next-minor prerelease and its semver reason, includes the
  No-changelog line, and records full verification results; it does not reuse a
  stale literal from another branch.
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

Commit this plan with:

`docs(plan): local event emission — phase D, review round 2`

## Decisions made during the build

| Decision | Raised in | Question | Resolution |
| --- | --- | --- | --- |
| — (coordinator) | Task 1 build | Should the manifest's minimum polling interval be per channel rather than one shared 60 000 ms floor? | Keep the shared 60 000 ms floor. It matches the scheduler's default and Slack's documented conservative interval, and a per-channel floor could only make a source poll faster, raising provider load; nothing in D's safety or cut-over contract depends on it. A later phase may tune a channel's floor upward or downward against its provider's documented limits. |
| — (coordinator) | Task 1 build | This branch predated B1's `zod` fix and its builder declared and externalised `zod` itself. | Dropped in favour of B1's accepted fix (a bundled devDependency, with the bundle-imports test in `test/events-daemon-package.test.mjs`), which the rebase onto B1's head brings in. |
| — (spec-literal) | Task 4a build | Gmail's expired staged pages were still terminalised only inside the Gmail worker, so while collection is paused (no scan runs) an expired Gmail page would keep its content past its deadline. Does that meet D-7a? | No. The spec says expiry "runs it for every source before any source, worker, control request or replay" (D8, spec lines 1626–1627). The common start-up and tick expiry therefore also terminalises expired Gmail pages, independent of pause, under the mailbox lock: it decrypts each expired page only to derive its occurrence keys, writes their content-free `retention-expired` resolutions, records the page drained and purges the ciphertext in one transaction, reusing the worker's existing terminalisation so the two cannot drift. Done as a Task 4a follow-up. |
| — (coordinator) | Task 4a build | Hold tightening keeps B1's staged-time basis: the schema records no hold-created time, while the spec measures holds from creation. | Owed to Phase E, where holds are first created: E adds the hold-created timestamp and measures hold tightening from it. No hold exists before E, so nothing in D can be held past its deadline. |
| — (coordinator) | Task 7 brief | Task 7's production-owner test boots with "the production B2 retained-content constructors", which do not exist on this branch until B2 lands; and "a missing constructor rejects owner start" would then stop WhatsApp from running at all if D lands first. | `createPhaseDWhatsAppOwnerComposition`'s `createRetainedContentParticipants` is optional. Before B2 there is no B2 stream or dead-letter content, so no B2 participant is registered and D's own hooks cover D's content; the concrete visibility fence is always built and enforced. Once B2 and D share a branch, `startEventOwner` always passes B2's `createB2RetainedContentParticipants`, and B2's guarded production-owner test plus D's Task 10 audit prove exactly one of each participant is registered; a missing visibility seam for a WhatsApp row still fails closed. |
| — (plan-literal) | Task 7 build | Task 7's builder registered, listed, fenced and composed the D sources but left activation and live scheduling Gmail-only, and asked whether completing them belongs to Task 7 or Task 8. | Task 7: its step 6 and its acceptance line ("Every source is selected through one owner") own live scheduling, and Task 3 steps 3 and 6 own source-neutral activation, which Task 3 could finish only for fences and contracts because no non-Gmail adapter existed yet. Task 8 only proves the cut-over matrix and needs both. The remainder is built as Task 7b (source-neutral activation and initial cursor, one fair scheduler over all registered sources, owner reader wiring) before Task 8. Task 7b also replaces Task 7's `ChatListStore` export from `@agentcomms/whatsapp` — a local-store handle with write methods — with a read-only event operation object from `operations/events.ts`, as D-1 requires. |
| — (coordinator) | Task 7b end-to-end run | The four-source owner E2E (Unix sockets, unrunnable in the builder's sandbox) had never run. Outside the sandbox it showed every non-Gmail event lost before delivery: `minimiseProjection` kept a fixed Gmail-shaped pointer list (`/messageId`), so each rule projection dropped the fields the catalogue's `subject` and `dedupeKey` read (Slack `/channel/id` and `/ts`, Resend `/emailId`, WhatsApp `/chat/id`), and evaluation could not build the CloudEvent. It also showed the disclosure fence's enable-all branch checking every account as Gmail. | Each catalogue definition in `@agentcomms/events` names its `identityPointers` — the concrete fields its subject and dedupe key read — and a projection always retains those plus the rule's own condition and mapping fields; unmapped content is still dropped (tested in `d-source-events.test.ts`). This adds an internal, data-only field to the held library's definitions and changes no Appendix A wire schema, subject or dedupe key; a catalogue test proves for every definition and example that the identity pointers alone reproduce the subject and dedupe key, so they cannot drift. The enable-all fence now checks each account against the source its planned points name. A socket-free test through the real evaluator (`d-source-events`) now covers each source, so a broken source cannot pass unrun. |
| — (coordinator) | Task 10 convergence audit | Does the converged branch (B2 at 6f6cf159, then D, then B2's convergence commit) meet D-11? | Yes, with two gaps closed here. Confirmed in the code and tests: the migration order is v9 (B2 standalone `stream_log`, no foreign key) → v10 (D's `whatsapp_occurrences`, `stream_log` untouched) → v11 (B2's rebuild with the composite foreign key, rows preserved, `PRAGMA foreign_key_check` clean); the production owner always composes D's concrete fence with `createB2RetainedContentParticipants` and never the pass-through gate; both SSE writers (live and Last-Event-ID replay) call the fence; the participants are registered at one site. Gap 1 (no mutation proof): bypassing either writer's gate, omitting either registration, or dropping v11's purge index each fails B2's contract or D's composition test. Gap 2: D7's missing-seam case was helper-level; a production-owner test now proves a start without the concrete fence is refused with `WHATSAPP_VISIBILITY_SEAM_REQUIRED` before any dispatcher exists and never calls the pass-through gate. That test also exposed that a start refused before the owner existed kept the owner lock (and database) held, blocking the next start in the same process — the start path now releases both. Noted for review: B2's stream and dead-letter shortening runs both directly and through the registered participant; both are idempotent. |
| — (coordinator) | Code review round 1 (Phase D) | Three P1s: WhatsApp webhook bytes and the SSE `stream_log` append were outside D's live-list fence (D-6 binds "every … disclosure transition"); and overlapping WhatsApp rules (`all-allowed` and an explicit chat) lost an occurrence because each scope's turn admitted only its own rules while the occurrence ledger is account-wide. Also: how does a fenced boundary treat an **unreadable** list? | Webhook writes and the SSE append-and-settle now run inside the concrete fence's synchronous callback; a hidden chat sends or retains nothing and its delivery ends content-free. A first observation admits the tuple to every matching active rule against each rule's own point, and a fenced matching scope defers the tuple rather than losing it. An unreadable list is not a hidden chat: per D-6 ("A read failure hides all … It does not purge merely because the file could not be parsed") it sends and appends nothing, keeps the retained record, releases the claim for a later retry and reports a transient error; an error raised by the write or append itself propagates and is never turned into a cancellation. Each behaviour has a test and a mutation that fails it. |
| — (coordinator) | Code review round 2 (Phase D) | Three P1s: a pending explicit-chat activation's fenced scope was not consulted by an `all-allowed` turn (round 1's overlap fix was incomplete); the async WhatsApp list-lock acquisition sat between the account/disclosure check and the synchronous write at every WhatsApp boundary, against the write-after-await table; and the event reader trimmed raw JID/stanza values before building the occurrence identity. | A tuple is deferred while **any** covering scope of the account is fenced, pending activations included, checked before and inside the commit. `WhatsAppVisibilityFence.withCurrentVisibleWrite` holds the list lock, returns without calling anything for a hidden tuple, awaits the caller's fresh `assertDisclosable` / account re-check, then runs the synchronous final gate and write with no other await between — used by the webhook write, SSE append, dry-run append and show, live frames and replay. Identity is the exact raw tuple; nothing in the identity path trims. Each has a failing-first test and a mutation that fails it (removing the under-lock re-check fails six boundary tests). |
