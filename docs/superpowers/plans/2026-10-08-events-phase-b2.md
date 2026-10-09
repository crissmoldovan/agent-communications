# Local event emission — Phase B2 implementation plan

> **For the implementation team:** B2 is held-package work. Do not publish either
> events package, tag a release, or contact a non-loopback service. Every task and
> batch ends in full pnpm verify before its commit.

## Scope and inherited decisions

B1 is the baseline: the packages are held and use Node 22.16.0 or later with B1-F's
lazy node:sqlite loader. B1-G's private Unix control boundary and Windows
WINDOWS_CONTROL_UNAVAILABLE refusal remain unchanged.

B2 implements only its §4 row: safe webhook/SSE transport and persistence, network
reset/degraded-recovery machinery, and private seams for later B3 controls. It does
not add delivery command/tool/hold/drop/retry controls, subscriber CRUD, target test,
target resume, secret operations, a judge kind, full doctor extension, or a listener
besides the loopback SSE listener. It does not alter core policy, lift a package hold,
or publish.

The existing B1 targets CLI/MCP capability remains the target-version surface. B2 may
extend its existing shared target-document validation for a non-secret webhook
descriptor, but adds no command, tool, capability row, reference page, or separately
callable operation. Secret URL/signing/bearer slots are internal test/runtime seams.
events-daemon.doctor remains the B1 CLI/MCP/capability/reference operation: tests
assert only that B3 doctor extensions are absent, never that doctor is absent.

A cache is never authority. Reload ConfigStore at every disclosure boundary; accept
switch generation/enablement/pause, exact rule/target/subscriber versions, and outbox
state only when reread in the transaction that changes the row.

### Binding B1 amendments and committee decisions

The entire B1 plan, including B1-A through B1-G and its committee table, is binding.

| Binding B1 decision | B2 consequence |
| --- | --- |
| B1-A | Terminal-only dry-run reads remain as shipped. |
| B1-B | B1 local reset append barrier remains; B2 adds private network barriers/degraded recovery. Terminal/app-only target resume remains B3 and MCP is excluded. |
| B1-C | Add only forward B2 migrations and explicit AAD; never rewrite v1 or pre-create later-phase schemas. |
| B1-D | Gmail alone is runnable before D; network work consumes established events and enables no source/baseline. |
| B1-E | Reuse independent event-secret backend fail-closed; add backing slots, not model-facing secret operations. |
| B1-F / K4 | Preserve Node >=22.16.0, lazy SQLite, and 22.12-refusal/22.16-SQLite release legs. |
| B1-G / K5 | Preserve Unix 0700/0600 re-proof/token boundary and Windows refusal. SSE is disclosure, never control. |
| B1 decision 6 | Preserve doctor and its B1 CLI/MCP/capability/reference row. Subscribers, delivery controls, named secret operations, target test/resume, and remaining doctor surface are B3. |
| Committee: canonical docs, purge, disable, pause | Preserve exact immutable versions; purge exact revoked versions; preserve B1 disable records and pause blocks claims/recovery. |
| Committee: post-await/D9 | Encrypt outside caller writes. Each B2 post-await write rechecks fresh account, switch/generation, row/version/lease and retention; a loser writes nothing except an existing content-free attempt marker. |
| Committee: packaging/E2E | Keep workspace externals/no-native proof and install a preload seal before any daemon/transport import in every network-capable Node test process. |

### Decisions the spec leaves to the plan

1. **Pinned transport, recursive address validation, pre-import seal.** Use only
   node:net, node:tls, node:http, node:crypto, and injected resolver/connector
   interfaces; add no HTTP/DNS/proxy/TLS/native dependency. The client owns raw
   sockets, never calls fetch, http(s).request, agents or proxy-aware code, never
   reads proxy variables, and never follows 3xx.

   packages/events-daemon/test/fixtures/iana-special-purpose-2026-10-08.json is
   checked-in policy. Its snapshotVersion is iana-special-purpose-2026-10-08; for
   IPv4 and IPv6 registries it records IANA title, canonical URL, IANA Last Updated,
   raw-source SHA-256, and every prefix plus globallyReachable. The matching
   src/network/iana-special-purpose.ts exports only this data—no runtime lookup.
   Tests derive an inside and boundary literal from **every** globallyReachable:false
   prefix, fail if version/source metadata/hash changes without reviewed snapshot
   update, and deny each vector including metadata/link-local ranges.

   Normalisation validates outer and every recursively embedded address: IPv4-mapped/
   compatible IPv6, NAT64, 6to4, and both Teredo server and obfuscated client. B2
   production ActiveNat64Prefix is null because no trusted owner-approved local
   prefix-provisioning surface exists. Null, multiple, malformed or ambiguous prefix
   rejects NAT64 rather than guessing. A test-only injected trusted /96 exercises
   active NAT64 and proves forbidden outer **or** embedded values reject. Every
   resolver answer must pass this policy and be in sorted approved CIDRs before socket
   construction.

   Connect only to vetted literal address while retaining canonical URL hostname for
   SNI, certificate hostname checking and Host. rejectUnauthorized remains true.
   Literal HTTPS uses IP certificate checking/no hostname SNI. HTTP is only literal
   127.0.0.1 or ::1 with that sole approved literal; hostname-to-loopback, mapped
   spellings and other private HTTP refuse.

   Every B2 network-capable Node process begins with:
       node --import test/helpers/loopback-seal-preload.mjs
   before evaluation. The root `test` script and the events-daemon `test` script each
   pass that `--import` directly to `node` (never through a shell-specific
   `NODE_OPTIONS` assignment), so ordinary `pnpm verify` seals their root and package
   test processes on macOS, Linux and Windows. Every fixture child that can import
   daemon/transport code likewise invokes `process.execPath` with the same `--import`
   argument before its entry module. `loopback-seal-preload.mjs` sets a private global
   marker; `assertLoopbackSeal()` is the first executable statement of every
   network-capable fixture/test before its dynamic daemon/transport import. The root
   E2E and a daemon `network-process-seal.test.ts` run on the normal `pnpm verify`
   path and fail if their process has no marker before that import. The preload imports Node built-ins
   only and patches callback/promise lookup and resolve*, dns.Resolver variants,
   net.connect/net.createConnection/net.Socket.prototype.connect, tls.connect, and
   http/https request entries. It allows Unix sockets and literal 127.0.0.1/::1 only;
   hostnames/DNS/non-loopback throw before import-time code acts. ESM daemon/provider/
   transport fixtures dynamically import after installed-marker check. The browser
   case uses a Playwright route installed before navigation allowing only exact
   literal-loopback fixture/SSE URLs.

2. **Immutable documents; all B2 secret refs migrate through the real module.**
   Plain webhook docs have canonical public URL without userinfo/query/fragment.
   Secret docs store only scheme/host/port/sha256; complete URL lives in independent
   event store. Public docs/previews/canonical bytes/control/MCP/log/audit/errors
   contain neither slot nor complete URL. Recompute fingerprint after secret read and
   before resolution. URL byte changes make a target version/new activation.

   The module is packages/events-daemon/src/store/event-secrets.ts.
   event_secret_generations owns secret-url, webhook-signing, and sse-bearer refs,
   each bound to exact target/subscriber version, purpose, generation, current/
   overlap/retired state and expiry. Under events/secrets.lock enumerate masters plus
   all current/overlap generations. Creation/rotation writes, reads back, then in new
   BEGIN IMMEDIATE verifies exact version/digest/lifecycle/prior generation before
   opaque-ref insert. Migration locks, enumerates complete union, copies/writes,
   verifies all, commits event selector, then retires/deletes source; failure leaves
   old selector usable and cleans destination copies. Mark retired before deletion;
   reconciliation deletes only unreferenced retired refs. Core migration must not
   enumerate/change event refs.

3. **Two outboxes; never invent identities.** Ordinary webhooks use existing
   decision/account/rule deliveries. Reset uses encrypted system_reset_outbox with
   its own id, reset epoch, target id/version, state, fixed bytes, attempts, lease
   token/fence/deadline and content-free attempts. It has no decision/account/rule/
   cap charge or fake ordinary row. Add system_outbox_id to barrier while retaining
   B1 local-notice field. Add exact AAD layouts for system reset and stream records.

   target_version_references is authoritative. Activation writes active-rule ref for
   each exact target version. Real retained delivery writes retained-delivery ref and
   deletes it atomically with bytes/authority. In cleanup transaction,
   hasLiveSystemTargetReference(epoch,targetId,targetVersion) joins refs to exact
   rule/delivery/target and returns true only for non-revoked active rule, or queued/
   retryable/disclosing/authorised retained superseded delivery with unrevoked exact
   lineage/live deadline. Revocation makes false and purges barrier/outbox atomically.
   One removal/replacement never cancels if another reference exists; final empty
   query alone cleans it.

4. **Atomic claim and cross-version order.** Decision insert allocates immutable
   ordering_sequence from delivery_order_counters keyed only by stable
   `(rule_id, account_id, target_id)` identities—never by a rule or target version.
   The atomic predecessor predicate uses that same stable triple, so a later
   replacement version cannot overtake an earlier queued, retryable or unexpired
   disclosing delivery; recovery retains the original sequence. Claim waits while
   such an earlier sequence is queued, retryable or unexpired disclosing.
   One BEGIN IMMEDIATE checks exact row/lineage, deadline, switch/enablement/pause,
   cap window/unique first charge and open current barrier **before** lease/attempt.
   Cap/barrier block changes no attempt, lease, work attempt, charge, append or
   ciphertext. Success writes first charge, attempt id, random lease token and lease
   together; retries reuse charge. System reset is cap-free but has same token/
   lineage semantics.

5. **Five separate final byte fences.** Final transactions run immediately before
   DNS resolver invocation, TCP net.connect/SYN, tls.connect({socket})/ClientHello
   after TCP completes, raw socket.write(requestBytes), and every SSE
   ServerResponse.write(frame). SSE frame gate is distinct from header gate and under
   subscriber mutex. No await/callback/config/secret/approval/taint/encrypt/telemetry
   occurs between gate and named call. Hooks run before gate, proving revocation after
   TCP but before ClientHello loses at TLS.

6. **Crash recovery ownership.** Content-free attempt owns outbox id, attempt id,
   lease token, generation and bound lineage. Recover expired lease only if exact
   current lineage remains live; late owner cannot settle newer lease/cancel/purge.
   Post-write crash may repeat external request (bounded at-least-once), but cannot
   double-charge, duplicate state, resurrect secret/ciphertext, or recreate purge.
   Task 7 crash matrix is normative.

7. **Internal loopback SSE bearer listener.** Serve only GET
   /v1/streams/<subscriber-id> at persisted literal authority. Subscriber docs bind
   stream identity/origins, never token. Require Authorization bearer; reject query/
   cookie auth/wrong Host. CORS reflects exact allowed Origin only, permits exactly
   Authorization and Last-Event-ID, sets Vary: Origin, emits no credentials/wildcard.
   Rotation invalidates old sockets in subscriber mutex before return. No B2
   subscriber CLI/MCP CRUD: internal fixtures only.

### Await-to-write fence ledger (binding implementation checklist)

| Write after an await | Transactional re-check immediately before write | Bite test(s) |
| --- | --- | --- |
| Persist URL/key/token generation after store I/O | Exact target/subscriber version, digest, lifecycle and expected prior generation match; write opaque ref only. | secret-slot-race, network-documents |
| Create webhook/system-reset outbox after cipher/config/fence work | Projection/reference, target, epoch, uniqueness, account/switch/lineage/deadline remain live. | outbox-persistence, system-reset-references |
| Claim/release/recover after config/fence/cap/barrier read | Exact row/state/sequence/lease, deadline, generation, lineage, cap/barrier match; blocked writes no attempt/lease/charge/append. | claim-cap-barrier, claim-ordering |
| Start DNS | Leased row, lineage, address digest, secret fingerprint/key generation and barrier remain valid. | webhook-fences DNS |
| Start TCP | DNS facts plus complete vetted answers/selected literal remain valid. | webhook-fences TCP |
| Start TLS ClientHello | TCP facts and exact lease/token reread after TCP completes. | webhook-fences TCP-to-TLS |
| Write HTTP bytes | Preceding facts plus exact attempt/timestamp/key generation; synchronous raw write follows. | webhook-fences write |
| Record HTTP outcome | Exact disclosing state/lease token/attempt/live authority; otherwise only existing content-free discarded marker. | webhook-crash-recovery |
| Append stream log / settle SSE delivery | Leased delivery/account/switch/rule/target/subscriber/barrier/expiry/cap/log identity remain; append+settle one transaction.  A WhatsApp row carries Task 8's nullable message/version pair.  The B2-first standalone migration has no occurrence foreign key; only the later B2-owned convergence migration, after D creates the parent, names the final-D occurrence parent.  The D-first, not-yet-recorded B2 migration may name it directly. | sse-persistence-auth, phase-d-b2-migration-contract |
| Accept/rotate/close SSE stream | Exact subscriber/authority/token generation live; rotate commits invalidation then closes under mutex. | sse-persistence-auth |
| Write each non-WhatsApp live/replay frame | Row/token/account/rule/subscriber/stream registration live; mutex repeats check immediately before write. | sse-frame-fences, browser listener |
| Write each WhatsApp live/replay frame | The ordinary frame authority remains live and `WhatsAppVisibilityFence.withCurrentSseFrameVisibility({accountId, whatsappMessageId}, writeFrame)` holds the current list lock through the synchronous physical write; there is no await or scheduled write after its check. | sse-frame-fences, phase-d-b2-sse-visibility-contract |
| Apply a Phase-D list change or retention tightening to B2 retained content | Registered B2 participants receive D's open transaction, make synchronous SQL changes only, delete newly hidden stream/dead-letter content, and shorten active/superseded deadlines with `min(oldDeadline, clockStart + durationMs)`; revoked-version content always purges. | phase-d-b2-retention-seam, phase-d-b2-sse-visibility-contract |
| Expire/purge/dead-letter | Exact current row/reason and immutable dead-letter clock remain; never mutate newer state or recreate encrypted content. | retention/crash/reset |

Issued HTTP cannot be recalled. If disable/revocation/purge/account removal/expiry/
generation change wins, completion leaves winner terminal state untouched, schedules
no retry/restoration, and adds only outcome-discarded-after-reason plus safe status to
existing content-free attempt. Pause permits only issued completion; later non-pause
loss wins.

### Spec amendments to raise with the owner

| ID | Lines | Ambiguity / contradiction | B2 plan resolution |
| --- | --- | --- | --- |
| B2-A | §4 2824–2825; D2 471–500 | B2 needs secret URLs/rotation; B3 reserves named terminal/app secret operations. | Opaque backing/internal tests in B2; no named operation until B3. Ask owner to state split. |
| B2-B | §4; D7; D10 | B2 reset recovery but B3 human-only resume. | Private recovery seam B2; terminal/app target resume exception B3. |
| B2-C | §4; D11 | Local-endpoint named B2 but no judge before E. | Non-reachable validator/connector only; no scheduler/operation/CLI/MCP judge path. |
| B2-D | D2; D8 | Ordering/retry enum/default unstated. | Stable `(rule_id, account_id, target_id)` ordering across superseded rule/target versions; default 20/range 1–20 and Task 5 fence; ask owner to name normatively. |
| B2-E | D6; D7 | Listener authority/identity schema incomplete. | Persist literal authority/require agreement; ask owner to approve fields/multi-listener policy. |
| B2-F | D6 | Bounded overlap duration unspecified. | Five minutes/current+previous only; ask owner to make normative. |
| B2-G | D7 | IANA source/update cadence unspecified. | Versioned checked-in snapshot with source metadata/hashes/exhaustive vectors; ask owner for cadence. |

## Batch map and safe parallelism

There are **eleven tasks in six batches**. Task 8a is deliberately inserted between
the persisted SSE work and the listener so the Phase-D retained-content seam has one
builder and one test cycle of its own; the reviewed identities of Tasks 1–10 remain
stable. The seal must land before any task may claim
the ordinary `pnpm verify` route protects B2 network-capable tests. The target
construction/routing seam then lands before any task widens target documents. Later
tasks are serial because each owns state the next uses; one builder completes one
task, including full verification, in one sitting.

| Batch | Tasks | Can run in parallel | Why / dependency |
| --- | --- | --- | --- |
| 1 — safety and routing substrate | 1 → 2 | No | Task 1 seals normal verification; Task 2 then makes all three target forms constructable and generically routable. |
| 2 — documents and persistence | 3 → 4 | No | Task 3 may widen documents only after Task 2; Task 4 persists its prepared target rows and references. |
| 3 — eligibility | 5 | No | Task 5 claims Task 4 rows using stable cross-version ordering. |
| 4 — webhook transport/recovery | 6 → 7 | No | Task 6 installs the webhook adapter in Task 2's router; Task 7 tests its crashes. |
| 5 — SSE boundary | 8 → 8a → 9 | No | Task 8 owns the forward stream schema and writer seam; Task 8a owns the one-transaction Phase-D list/retention participants; Task 9 connects the actual loopback writes and proves the converged fence. |
| 6 — held integration | 10 | No | Audits public boundary/E2E/release after runtime work. |

## Batch 1 — safety and routing substrate

### Task 1 — registry-derived address policy and pre-import loopback seal **(high risk)**

**Files**

- Add packages/events-daemon/src/network/address-policy.ts,
  packages/events-daemon/src/network/iana-special-purpose.ts,
  packages/events-daemon/src/network/resolver.ts,
  packages/events-daemon/src/network/pinned-connection.ts, and
  packages/events-daemon/src/network/local-endpoint.ts.
- Add packages/events-daemon/test/fixtures/iana-special-purpose-2026-10-08.json,
  packages/events-daemon/test/network/address-policy.test.ts,
  packages/events-daemon/test/network/iana-snapshot.test.ts,
  packages/events-daemon/test/network/pinned-connection.test.ts, and
  packages/events-daemon/test/network/local-endpoint.test.ts.
- Add packages/events-daemon/test/support/loopback-receiver.ts,
  packages/events-daemon/test/support/test-tls.ts, and
  test/helpers/loopback-seal-preload.mjs; update test/helpers/loopback-seal.mjs,
  test/helpers/loopback-seal.test.mjs, test/events-daemon-e2e.test.mjs,
  package.json, and packages/events-daemon/package.json.
- Add packages/events-daemon/test/network-process-seal.test.ts. It imports only the
  seal assertion statically and dynamically imports its daemon/transport fixture
  after that assertion, so the package test entrypoint itself is exercised.

**Tests first**

1. Generate inside/boundary vectors for every non-global snapshot prefix; assert
   version/source metadata/hash and unconditional metadata/link-local denial.
2. Table-test outer/embedded mapped/compatible/NAT64/6to4/Teredo, including forbidden
   outer/safe embedded and inverse; null/multiple/ambiguous NAT64 rejects while
   injected trusted /96 proves recursion.
3. Inject resolver/literal fake to test TLS/SNI/Host/all answers/cert/no redirect/no
   proxy/fingerprint-before-resolver/exact HTTP matrix.
4. Fresh preloaded child statically imports transport and tests patched DNS/resolver/
   net/tls/http entry refusal; Unix/literal loopback succeeds. The root E2E and the
   daemon network-process-seal test, both reached by an ordinary `pnpm verify`, first
   assert the preload marker then dynamically import daemon/transport code; an
   unsealed network-capable test process therefore fails before its import.
5. Local-endpoint accepts literal-loopback HTTP singleton only and no operation/
   dispatcher import or judge call.

**Implementation, in order**

1. Check in/import static snapshot; implement CIDR and recursive address validation.
2. Implement injected resolver/raw connector without cache/proxy/redirect.
3. Build loopback receiver and fixture-only throwaway TLS material.
4. Implement pre-import seal, marker assertion and all named resolver/socket/request
   patches.
5. Change the root `test` script to
   `node --import ./test/helpers/loopback-seal-preload.mjs --test "test/**/*.test.mjs" && pnpm -r --filter "./packages/**" run test`
   and the events-daemon `test` script to
   `node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test "test/**/*.test.ts"`.
   These are Node argv, not shell environment syntax, so work on macOS, Linux and
   Windows. Make every network-capable fixture child build the same
   `process.execPath, --import, entry` argv. Keep direct focused commands explicit
   too.
6. Keep local endpoint unreachable from operations and add graph assertion.

**Required mutations**

- Missing/changed non-global registry vector/metadata/version: snapshot test fails.
- Outer-only/embedded-only validation or guessed NAT64: address test fails.
- Hostname HTTP/proxy/redirect/missing answer or cert check: connector test fails.
- Delete either root/package script preload, start a fixture child without its
  `--import`, or import daemon/transport before `assertLoopbackSeal()`: the normal
  `pnpm verify` seal sentinel/E2E fails before the network-capable import.
- Local endpoint operation import: graph test fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test test/network/address-policy.test.ts test/network/iana-snapshot.test.ts test/network/pinned-connection.test.ts test/network/local-endpoint.test.ts test/network-process-seal.test.ts
    node --import test/helpers/loopback-seal-preload.mjs --test test/helpers/loopback-seal.test.mjs test/events-daemon-e2e.test.mjs
    pnpm verify

Passing: literal loopback only, zero DNS, every snapshot non-global range refused;
the unqualified root and daemon test scripts used by `pnpm verify` have installed the
seal before any network-capable daemon/transport import on macOS, Linux and Windows.
Commit: feat(events): seal and validate pinned network transport.

### Task 2 — three-target construction and generic dispatch routing **(high risk)**

**Files**

- Add packages/events-daemon/src/runtime/target-delivery.ts.
- Update packages/events-daemon/src/runtime/deliveries.ts,
  packages/events-daemon/src/runtime/dispatcher.ts,
  packages/events-daemon/src/runtime/owner.ts, and
  packages/events-daemon/src/runtime/scheduler.ts.
- Add packages/events-daemon/test/target-delivery.test.ts and
  packages/events-daemon/test/delivery-routing.test.ts; update
  packages/events-daemon/test/decision-outbox.test.ts,
  packages/events-daemon/test/dispatcher.test.ts, and
  packages/events-daemon/test/owner.test.ts.

**Tests first**

1. Exercise the private `DeliveryTarget` union directly for dry-run, webhook and SSE:
   assert the only keys are `dryrun:<targetId>:<targetVersion>`,
   `webhook:<targetId>:<targetVersion>`, and
   `sse:<targetId>:<targetVersion>:<subscriberId>:<subscriberVersion>`; two target
   versions sharing one subscriber produce distinct SSE deliveries.
2. For each union branch, prepare an actual decision delivery and assert one canonical
   CloudEvent structured JSON byte string is generated before the write boundary,
   retained as that target's representation, and is neither rebuilt nor changed by
   dispatch selection. Keep the B1 dry-run byte/key vector unchanged.
3. Inject dry-run/webhook/SSE handlers into the generic dispatcher, then drive an
   owner scheduler tick for every branch. Assert exact-kind routing, exhaustive
   unknown-kind refusal, and that owner/scheduler no longer construct or type their
   dispatcher as dry-run-only. Webhook/SSE handlers are internal no-network fakes
   until Tasks 6 and 8 install the real adapters.
4. Assert the accepted target document remains B1 dry-run-only and no new operation,
   CLI/MCP/capability/reference surface exists; these are construction and routing
   seams, not early target activation.

**Implementation, in order**

1. Define a closed private `DeliveryTarget` union and `constructTargetDelivery()` in
   target-delivery.ts. Its result carries exact target key, exact bound target/
   subscriber versions, kind-specific representation and the already-canonical
   CloudEvent bytes; it accepts no URL, token or other secret.
2. Make `prepareDeliveries()` call that constructor for every prepared target and
   persist its representation with the encrypted record. Preserve the B1 dry-run
   form byte-for-byte; do not make any transport regenerate the CloudEvent.
3. Introduce an exhaustive `DeliveryDispatcher` facade in dispatcher.ts with injected
   dry-run, webhook and SSE handlers, and make EventScheduler and startEventOwner
   depend on that facade rather than `DryRunDispatcher`. The owner attaches the B1
   handler; direct internal test fakes cover the two B2 branches until their later
   adapters are supplied.
4. Keep document validation and public target acceptance unchanged in this task. Task
   3 alone maps canonical webhook/SSE documents to this already-tested union.

**Required mutations**

- Reuse a dry-run key for webhook/SSE, omit a bound subscriber version, or collapse
  two target versions: target-delivery vectors fail.
- Rebuild/change the prepared CloudEvent bytes at dispatch selection or lose the
  target-specific representation: prepared-byte vectors fail.
- Retain a dry-run-only owner/scheduler type, skip a branch, or add a default that
  silently accepts an unknown kind: routing/owner tests fail.
- Widen the accepted target document or expose a B3 surface here: negative document
  audit fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test test/target-delivery.test.ts test/delivery-routing.test.ts test/decision-outbox.test.ts test/dispatcher.test.ts test/owner.test.ts
    pnpm verify

Passing: all three B2 target forms have exact keys, immutable target-specific bytes
and generic owner/scheduler routing before any accepted document can name them.
Commit: feat(events): prepare and route all B2 target deliveries.

**Batch 1 close.** Run pnpm verify after Tasks 1 and 2; target construction/routing
must be complete before a later batch widens target documents.

## Batch 2 — documents and persistence

### Task 3 — immutable B2 documents and complete event-secret reconciliation **(high risk)**

**Files**

- Update packages/events-daemon/src/domain/activation-documents.ts,
  packages/events-daemon/src/domain/versions.ts,
  packages/events-daemon/src/operations/targets.ts,
  packages/events-daemon/src/store/migrations.ts,
  packages/events-daemon/src/store/aad.ts,
  packages/events-daemon/src/store/records.ts, and
  packages/events-daemon/src/store/event-secrets.ts.
- Add packages/events-daemon/src/domain/webhook-target.ts and
  packages/events-daemon/src/domain/sse-subscriber.ts.
- Add/update packages/events-daemon/test/network-documents.test.ts,
  packages/events-daemon/test/event-secrets.test.ts,
  packages/events-daemon/test/secret-slot-race.test.ts, and
  packages/events-daemon/test/migrations.test.ts.

**Tests first**

1. Canonical plain/secret webhook and SSE subscriber docs map only to Task 2's
   already-tested `DeliveryTarget` union; URL byte changes version; public
   serialisations/errors/logs reveal no synthetic URL/slot/token/key.
2. B1 fixture proves append-only slot/AAD migration covers secret URL, webhook signing
   current/previous, SSE bearer current/previous.
3. Pausable fake store races create/rotate/reconcile/migrate and asserts lock →
   masters plus every current/overlap ref → copy/write → read-back verify → selector
   commit → source retirement, preserving old selector on failure.
4. Existing B1 target capability only; assert no new command/tool/row/secret result
   and subscriber factory stays internal.

**Implementation, in order**

1. Add append-only slot migration/AAD; never change B1 migration text.
2. Add canonical types and existing shared target validation that pass exact bound
   fields to Task 2's `constructTargetDelivery()`; do not duplicate target-key or
   representation/CloudEvent construction. Add no delivery/subscriber operations,
   CLI/MCP, capability row or reference.
3. Extend EventSecretStore references/migration with complete locked
   write/verify/commit/retire protocol.
4. Add internal factories which reveal no complete secret.

**Required mutations**

- In-place URL/exposed slot or secret/missing canonical item/conflicting authority:
  document-redaction tests fail.
- Masters-only enumeration/overlap omission/commit-before-verify/retire-first:
  secret migration tests fail.
- Missing post-await reread: slot-race fails.
- B3 public surface: negative operation audit fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/network-documents.test.ts test/event-secrets.test.ts test/secret-slot-race.test.ts test/migrations.test.ts
    pnpm verify

Passing: B1 migration, B2 secret references and B3-surface absence hold.
Commit: feat(events): model network descriptors and reconcile event secrets.

### Task 4 — ordinary delivery persistence and distinct system reset outbox **(highest risk)**

**Files**

- Update packages/events-daemon/src/store/migrations.ts,
  packages/events-daemon/src/store/aad.ts,
  packages/events-daemon/src/store/records.ts,
  packages/events-daemon/src/runtime/decisions.ts,
  packages/events-daemon/src/runtime/deliveries.ts,
  packages/events-daemon/src/runtime/reset.ts,
  packages/events-daemon/src/runtime/replacements.ts, and
  packages/events-daemon/src/runtime/revocations.ts.
- Add packages/events-daemon/src/runtime/system-reset-outbox.ts and
  packages/events-daemon/src/runtime/target-version-references.ts.
- Add/update packages/events-daemon/test/outbox-persistence.test.ts,
  packages/events-daemon/test/system-reset-outbox.test.ts,
  packages/events-daemon/test/system-reset-references.test.ts,
  packages/events-daemon/test/retention.test.ts, and
  packages/events-daemon/test/migrations.test.ts.

**Tests first**

1. B1 migration proves each Task 2 prepared dry-run/webhook/SSE representation and
   exact key/lineage is persisted with ordinary lease/order fields; system_reset_outbox
   owns reset bytes/state and no reset can satisfy ordinary decision/account/rule
   constraints or insert fake identities.
2. Active-rule plus retained superseded-delivery exact-version references remove/
   replace one at a time; query retains reset until final authorised ref disappears,
   then purges barrier/outbox in same transaction.
3. Race reset create/restart/revoke/retained expiry; D6-only payload, 20/24 and no
   cap charge.
4. Interrupted migration/AAD mismatch/purge preserves B1 local reset and cannot
   recreate system ciphertext.
5. Dead-letter a prepared ordinary row, restart, and tighten its dead-letter
   retention.  Assert its immutable `dead_lettered_at` clock start and
   `dead_letter_expires_at` survive restart and are not reconstructed from the
   current rule.  Task 8a will use these fields to apply Phase D's
   `min(oldDeadline, clockStart + durationMs)` participant contract.

**Implementation, in order**

1. Add forward ordinary lease-token/attempt/order plus target-kind/representation
   fields, system-outbox, target-reference, order-counter/barrier-link migrations,
   immutable `dead_lettered_at`/`dead_letter_expires_at` fields, and AAD; consume the
   Task 2 prepared bytes/key without rebuilding either.  Set the two dead-letter
   fields only in the terminal transition that first dead-letters the payload; never
   recompute them during recovery, replacement, expiry, or a later tightening.
2. Persist active refs on activation and retained refs atomically with each ordinary
   target's prepared bytes.
3. Use exact reference query in all reset create/recover/cleanup/revocation paths.
4. Implement cap-free system repository and forbid reset insertion into deliveries,
   decisions, cap charges or fabricated account/rule.

**Required mutations**

- Reset ordinary row/fake identity/cap charge: system schema fails.
- Active-pointer-only/drop retained ref/cancel first removal: final-reference fails.
- Missing system AAD/post-purge ciphertext: migration/purge fails.
- Recompute a dead-letter clock on restart or tightening, extend its deadline, or
  retain its payload after the persisted deadline: the dead-letter retention vector
  fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/outbox-persistence.test.ts test/system-reset-outbox.test.ts test/system-reset-references.test.ts test/retention.test.ts test/migrations.test.ts
    pnpm verify

Passing: every B2 target row is constructable and persisted with its exact prepared
representation; reset is system outbox work with final-reference semantics.
Commit: feat(events): persist distinct reset outbox and target references.

**Batch 2 close.** Run pnpm verify after the document and persistence tasks; accepted
webhook/SSE documents now have constructable, persistable, generically routed rows.

## Batch 3 — eligibility

### Task 5 — atomic cap/barrier claims and stable cross-version ordering fence **(highest risk)**

**Files**

- Update packages/events-daemon/src/runtime/dispatcher.ts,
  packages/events-daemon/src/runtime/scheduler.ts,
  packages/events-daemon/src/runtime/recovery.ts,
  packages/events-daemon/src/runtime/expiry.ts,
  packages/events-daemon/src/runtime/lifecycle.ts, and
  packages/events-daemon/src/runtime/system-reset-outbox.ts.
- Add packages/events-daemon/src/runtime/delivery-claim.ts.
- Add/update packages/events-daemon/test/claim-cap-barrier.test.ts,
  packages/events-daemon/test/claim-ordering.test.ts,
  packages/events-daemon/test/stale-recovery.test.ts,
  packages/events-daemon/test/dispatcher.test.ts, and
  packages/events-daemon/test/retention.test.ts.

**Tests first**

1. At/before/after cap-window and closed/degraded/open barrier boundaries, including
   restart, prove blocked means no attempt, lease, work attempt, cap charge, append
   or ciphertext mutation.
2. Allocate deliveries for the same stable `(rule_id, account_id, target_id)` across
   both a rule replacement and a target replacement: the later version waits behind
   the earlier version while it is queued, retryable or under an active lease.
   Expire that first lease and recover it without allocating a new sequence; the
   later version still waits. It runs only after the recovered earlier row completes,
   fails, cancels or expires. Cover restart and a stale former owner that attempts to
   settle or reorder the recovered row.
3. First charge/attempt/token is atomic once; retries/recovery reuse it; reset never
   charges; cover pause/disable/revoke/account removal/expiry.
4. Keep B1 dry-run green through shared eligibility, no webhook transport yet.

**Implementation, in order**

1. Allocate sequence in decision insert from `delivery_order_counters` whose sole
   identity is `(rule_id, account_id, target_id)`. Store no rule/target version in
   that counter key; one claimant serves scheduler/recovery.
2. In the one immediate claim transaction, find predecessor rows using the same
   stable triple and lower sequence regardless of their superseded rule/target
   versions, then evaluate that predicate and every other eligibility predicate
   before lease/attempt. A blocked result is content-free and mutation-free.
3. Persist attempt id/random token; require both for release/recovery/completion.
4. Apply token/lineage semantics to system reset while preserving cap exemption.

**Required mutations**

- Attempt/lease/work/charge/append while cap or reset blocked: cap-barrier fails.
- Key `delivery_order_counters` or the atomic predecessor predicate by rule/target
  version, allocate a replacement-version fresh sequence, let it pass a retry or
  recovered lease, or let a stale owner settle/reorder it: cross-version ordering
  cases fail.
- Missing token/attempt or stale settlement: stale recovery fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/claim-cap-barrier.test.ts test/claim-ordering.test.ts test/stale-recovery.test.ts test/dispatcher.test.ts test/retention.test.ts
    pnpm verify

Passing: blocked work consumes no attempt and stable rule/account/target order survives
replacement versions, retry, lease recovery and stale-owner races.
Commit: feat(events): fence claims with caps barriers and ordering.

**Batch 3 close.** Run pnpm verify before raw transport.

## Batch 4 — webhook transport and recovery

### Task 6 — fenced Standard Webhooks with DNS, TCP, TLS and write gates **(highest risk)**

**Files**

- Add packages/events-daemon/src/runtime/webhook-dispatcher.ts and
  packages/events-daemon/src/runtime/webhook-signing.ts.
- Update packages/events-daemon/src/runtime/dispatcher.ts,
  packages/events-daemon/src/runtime/disclosure-fence.ts,
  packages/events-daemon/src/runtime/account-fence.ts, and
  packages/events-daemon/src/runtime/untrusted.ts.
- Add packages/events-daemon/test/webhook-signing.test.ts,
  packages/events-daemon/test/webhook-fences.test.ts, and
  packages/events-daemon/test/webhook-dispatcher.test.ts.

**Tests first**

1. Pin exact bytes/content type/id/timestamp/HMAC/single-dual signature/overlap;
   retry keeps body/id, changes time/signature and safe output excludes secret/body.
2. Preload-sealed literal fake tests 2xx/non-2xx/network/TLS/backoff/no redirect.
3. Pause before DNS, TCP, TLS ClientHello and HTTP write; race disable/pause/replace/
   revoke/account removal/expiry/address drift/key change. Loser makes no resolver
   call/SYN/ClientHello/request bytes, including revoke after TCP before TLS.
4. Fingerprint/key rereads and no await after every final gate.

**Implementation, in order**

1. Sign exact persisted bytes using injected clock/jitter/current-overlap secret refs.
2. Implement raw transport with gateDns, gateTcp, gateTls and gateWrite, each exact
   row/lease/lineage/generation/account/barrier reread.
3. Invoke net.connect synchronously after TCP gate, tls.connect({socket}) after TLS
   gate, socket.write after write gate; never combine TCP/TLS.
4. Install this concrete handler in Task 2's generic router; classify no-follow
   response and hand outcome to Task 7; no operation/CLI/MCP/
   capability/reference change.

**Required mutations**

- Reused signature/time, changed ID/body, expired key, redirect, secret output:
  signing/dispatcher fails.
- Combined TCP/TLS, await after gate, omitted reread: named fence case fails.
- Losing gate begins resolver/SYN/ClientHello/write: counters fail.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test test/webhook-signing.test.ts test/webhook-fences.test.ts test/webhook-dispatcher.test.ts
    pnpm verify

Passing: each byte phase has separate immediately-prior authority.
Commit: feat(events): add separately fenced webhook transport.

### Task 7 — deterministic webhook crash, lease-expiry and stale-owner recovery **(highest risk)**

**Files**

- Update packages/events-daemon/src/runtime/webhook-dispatcher.ts,
  packages/events-daemon/src/runtime/delivery-claim.ts,
  packages/events-daemon/src/runtime/recovery.ts,
  packages/events-daemon/src/runtime/lifecycle.ts,
  packages/events-daemon/src/runtime/expiry.ts, and
  packages/events-daemon/src/runtime/revocations.ts.
- Add packages/events-daemon/test/fixtures/webhook-crash-points.ts and
  packages/events-daemon/test/webhook-crash-recovery.test.ts.
- Update packages/events-daemon/test/webhook-dispatcher.test.ts,
  packages/events-daemon/test/stale-recovery.test.ts, and
  packages/events-daemon/test/retention.test.ts.

**Tests first**

| Crash point | Required restart result |
| --- | --- |
| Before claim / cap charge | Queued; no lease/attempt/charge/request. |
| After claim / before DNS | Recover only expired exact live lease; one charge. |
| DNS→TCP, TCP→TLS, TLS→write | No request bytes; recover only exact current lineage. |
| Write→response / response→outcome | At-least-once retry possible; no double charge; old owner cannot settle. |
| After outcome | Durable terminal/retry; no old-attempt redispatch. |
| Cancel/purge/generation/revoke | Winner stays terminal/purged; late outcome only existing discarded marker. |

1. Run matrix with normal retry, lease recovery and stale late owner; assert token/
   attempt ownership, no duplicate charge/stale outcome/recreated bytes, recovery only
   exact live lineage.
2. Race response with disable/revoke/account removal/expiry/version replacement;
   assert content-free externalOutcome unrecalled-discarded, no retry after non-pause
   loss, pause permits issued completion only.

**Implementation, in order**

1. Add test-only failpoints and durable content-free owner facts; production cannot
   enable hooks.
2. Recovery uses Task 5's expired claim then re-fences before DNS.
3. Completion compares outbox/state/attempt/token; loser never compensates with
   insert/encryption/reference/key restoration.
4. Apply same stale-owner rule to system reset, preserving cap-free/final-ref stop.

**Required mutations**

- Recover different token/attempt/lineage, double charge post-write, or late overwrite:
  matrix fails.
- Recreate purge or retry post-revoke: purge matrix fails.
- Store URL/body/key/response text in outcome: safe-output scan fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test test/webhook-crash-recovery.test.ts test/webhook-dispatcher.test.ts test/stale-recovery.test.ts test/retention.test.ts
    pnpm verify

Passing: bounded at-least-once requests have exactly-owned non-resurrectable state.
Commit: feat(events): recover fenced webhook leases safely.

**Batch 4 close.** Run pnpm verify; all crash outcomes share lease/lineage/cap rules.

## Batch 5 — SSE boundary

### Task 8 — persisted SSE log, forward-compatible WhatsApp schema and writer seam **(high risk)**

**Files**

- Add packages/events-daemon/src/runtime/sse-dispatcher.ts,
  packages/events-daemon/src/runtime/stream-replay.ts,
  packages/events-daemon/src/runtime/phase-d-whatsapp-seam.ts, and
  packages/events-daemon/src/runtime/subscriber-streams.ts.
- Update packages/events-daemon/src/store/migrations.ts,
  packages/events-daemon/src/store/aad.ts,
  packages/events-daemon/src/store/records.ts,
  packages/events-daemon/src/runtime/dispatcher.ts,
  packages/events-daemon/src/runtime/disclosure-fence.ts,
  packages/events-daemon/src/runtime/expiry.ts,
  packages/events-daemon/src/runtime/lifecycle.ts,
  packages/events-daemon/src/runtime/account-fence.ts, and
  packages/events-daemon/src/runtime/revocations.ts.
- Add packages/events-daemon/test/sse-persistence-auth.test.ts and
  packages/events-daemon/test/sse-frame-fences.test.ts and
  packages/events-daemon/test/phase-d-b2-migration-contract.test.ts; update
  packages/events-daemon/test/migrations.test.ts and
  packages/events-daemon/test/retention.test.ts.

**Tests first**

1. Encrypted stream append and SSE settle atomically: stable event/order, first cap,
   no orphan, replay no slot, AAD/expiry/purge exact.
2. Bearer current plus five-minute previous only; rotation invalidates old internal
   streams under mutex and reconciliation retires old slot.
3. Race decrypt/config/fence await and final frame gate with pause/disable/revoke/
   account removal/expiry/rotation; no post-loss frame.
4. Assert no subscriber/bearer CLI/MCP/capability/reference surface.
5. Add the two immutable upgrade-order vectors before implementing either
   migration path.  The B2-first vector starts from the final B1 fixture, applies
   B2's standalone `stream_log` migration with foreign keys enabled, and proves
   that a non-WhatsApp encrypted row with both nullable WhatsApp fields `NULL`
   inserts and replays even though `whatsapp_occurrences` does not exist.  It
   asserts that this recorded B2 migration has the nullable
   `whatsapp_message_id`/`whatsapp_visibility_version` pair, their same-source
   `CHECK`, and the `(account_id, whatsapp_message_id)` purge index, but **no**
   `REFERENCES whatsapp_occurrences` clause.  It then applies D's immutable
   migration that creates `whatsapp_occurrences`, followed by B2's new forward
   convergence migration.  That migration must rebuild and copy `stream_log` to
   the exact pair, same-source `CHECK`, composite
   `FOREIGN KEY (account_id, whatsapp_message_id) REFERENCES
   whatsapp_occurrences(account_id, message_id)`, and purge index; the vector
   compares every pre-existing encrypted stream row byte-for-byte, checks its
   stable identity/order/replay result, and requires `PRAGMA foreign_key_check`
   to return no rows.

   The D-first vector starts from the final-D fixture, applies B2's then-unapplied
   direct-FK migration, and asserts that same final pair/`CHECK`/foreign-key/index
   shape and an empty `PRAGMA foreign_key_check`.  It also proves a non-WhatsApp
   encrypted row remains usable and that a WhatsApp row can reference its real D
   occurrence.  Each vector uses its own frozen chronological migration fixture:
   B2-first → D → B2 convergence, and D-first → B2 direct-FK.  It must compare
   the ledger names and contents after every step and must never edit, replace, or
   reapply an already-recorded migration.  Before the final-D fixture exists its
   D-dependent vector is an explicit skip, not a substitute fixture; once D is
   present both vectors are mandatory and neither may be disabled by an environment
   flag.
6. Add sealed-sink unit tests for both actual writer entry points:
   `sse-dispatcher.ts` live delivery and `stream-replay.ts` `Last-Event-ID`
   replay.  A recording `SseFrameVisibilityGate` must observe exactly one
   `withCurrentSseFrameVisibility({accountId, whatsappMessageId}, writeFrame)` for
   each WhatsApp frame, with the synchronous sink write nested inside its callback;
   non-WhatsApp frames must retain the ordinary B2 frame fence only.  The
   pass-through gate must invoke `writeFrame` synchronously once, so the B2 branch
   proves the call-site invariant without importing a Phase-D module.

**Implementation, in order**

1. At rebase, inspect the shared migration registry.  Whichever of B2 and Phase D
   lands second renumbers *its own* unapplied forward migration to the next free
   number/name; neither side rewrites a recorded migration or reuses a number.
   B2 owns the `stream_log` nullable
   `whatsapp_message_id`/`whatsapp_visibility_version` pair, their same-source
   `CHECK`, the composite occurrence foreign key, and the
   `(account_id, whatsapp_message_id)` purge index; D owns
   `whatsapp_occurrences` and never creates a placeholder `stream_log` table.

   If D lands first, B2's still-unapplied Task 8 migration declares the complete
   pair/`CHECK`/foreign-key/index directly.  If B2 lands first, its recorded
   standalone migration declares the same nullable pair, `CHECK`, and index but
   **no foreign key at all** to the absent D table; it must stay usable with
   `PRAGMA foreign_keys = ON` and B2 creates no D-owned table.  After D's recorded
   migration creates `whatsapp_occurrences`, B2 owns a separate next-free forward
   convergence migration.  It creates a replacement `stream_log` with the exact
   pair/`CHECK`/foreign-key/index, copies every existing column and encrypted blob
   unchanged, atomically swaps the rebuilt table into place, restores its ordinary
   indexes, and proves `PRAGMA foreign_key_check` is empty before it completes.
   This is a new migration, never a revision of the B2-first or D migration.
2. Add the applicable forward stream-log migration(s)/AAD and Task 3 generation
   refs.  Define
   `WhatsAppSseFrameInput`, `SseFrameVisibilityGate`,
   `WhatsAppListChangeParticipant`, `DSourceRetentionParticipant`, and
   `DSourceRetentionHooks` in `phase-d-whatsapp-seam.ts` with exactly D-6's
   structural signatures; the gate member is exactly
   `withCurrentSseFrameVisibility<T>(input: WhatsAppSseFrameInput, writeFrame: () => T): T`.
   Export a synchronous `PassThroughSseFrameVisibilityGate` and no-op hook registry
   as the B2 default.  `startEventOwner` accepts the concrete
   `SseFrameVisibilityGate` and `DSourceRetentionHooks` through this same structural
   owner seam.  B2-only owners retain that pass-through/no-op default and have no
   WhatsApp row that can reach it.  A normal owner must never select the
   pass-through gate for a persisted non-null WhatsApp tuple: if the concrete seam
   is absent, it fails closed without invoking the sink.  After D is present, the
   D-owned production composition step in Phase D Task 7 is the sole definition and
   producer of the concrete `WhatsAppVisibilityFence` and participants; it supplies
   `startEventOwner` through this seam.  B2 does not re-specify that composition or
   import a D runtime module.
3. Append/settle together under Task 5 eligibility and purge bytes/refs together.
4. Implement internal registry/mutex/auth boolean with live rereads/invalidation.
5. Prepare replay/live outside writes.  At each of the two named writer sites,
   branch on the persisted nullable WhatsApp tuple and call the injected
   `WhatsAppVisibilityFence.withCurrentSseFrameVisibility` immediately before the
   synchronous sealed-sink write; no `await`, promise callback, queueing, config
   load, or other work may occur between that call's final check and the write.
   Preserve the existing B2 authorization/mutex gate and give Task 9 only a sealed
   synchronous sink to wire to `ServerResponse.write`.

**Required mutations**

- Split append/settle, charge replay, retain purged bytes: persistence fails.
- Accept retired generation/close after rotation/skip gate: auth-frame fails.
- Remove either writer's `withCurrentSseFrameVisibility` call, move its sink write
  out of `writeFrame`, insert an await/microtask between the callback's check and
  write, make the pass-through asynchronous, select pass-through for a persisted
  WhatsApp tuple without D's concrete seam, put the occurrence foreign key in the
  B2-first standalone migration, omit it from the D-first/direct or B2-convergence
  schema, lose an encrypted row during the rebuild/copy, omit the same-source
  `CHECK` or purge index, fail `PRAGMA foreign_key_check`, or edit an
  already-recorded migration: the named frame-fence or migration-contract test
  fails.
- Add subscriber/bearer operation: negative audit fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/sse-persistence-auth.test.ts test/sse-frame-fences.test.ts test/phase-d-b2-migration-contract.test.ts test/migrations.test.ts test/retention.test.ts
    pnpm verify

Passing before D: SSE has durable disclosure semantics, the standalone `stream_log`
migration has no absent-parent foreign key, and B2-only owners retain the synchronous
structural pass-through with no WhatsApp row to reach it; `pnpm verify` passes without
a D import.  Passing after D: the same command runs both immutable upgrade-order
vectors, including B2's convergence rebuild and `foreign_key_check`, against the
actual fixture. Commit:
feat(events): persist fenced SSE replay and bearer state.

### Task 8a — register B2 retained content in Phase D's list and retention transactions **(high risk)**

**Files**

- Add `packages/events-daemon/src/runtime/phase-d-b2-retention.ts` and
  `packages/events-daemon/test/phase-d-b2-retention-seam.test.ts`.
- Update `packages/events-daemon/src/runtime/owner.ts`,
  `packages/events-daemon/src/runtime/phase-d-whatsapp-seam.ts`,
  `packages/events-daemon/src/runtime/expiry.ts`,
  `packages/events-daemon/src/runtime/lifecycle.ts`,
  `packages/events-daemon/src/runtime/replacements.ts`, and
  `packages/events-daemon/src/runtime/revocations.ts` only to expose B2's existing
  stream/dead-letter purge and deadline operations to the supplied transaction.
- Update `packages/events-daemon/test/retention.test.ts` for the participant's use
  of Task 4's persisted dead-letter clock/deadline.  Keep the actual `stream_log`
  schema and its WhatsApp column in Task 8, and do not revise either earlier
  migration in this task.

**Tests first**

1. Before D, boot the real owner twice with the B2 default pass-through/no-op seams and
   assert, through a recording registry, that `startEventOwner` registers no participant
   itself and imports or loads no D module; the B2-only fixture contains no WhatsApp
   row. Separately, call `createB2RetainedContentParticipants({ database })` and drive
   both returned participants inside a supplied open transaction (the purge and
   shortening cases below). After D is present, the production owner must register
   exactly one of each, and only through Phase D Task 7's composition step: assert the
   count on two owner setups. After D is present, boot the normal production owner through
   Phase D Task 7's production composition step—not a test-only owner override—and
   prove it supplies the concrete `WhatsAppVisibilityFence` and concrete hooks to
   `startEventOwner` through the Task 8 seam.  Repeat with that production seam
   deliberately absent: a persisted WhatsApp stream row reaches neither
   `PassThroughSseFrameVisibilityGate` nor a frame sink, while a non-WhatsApp row
   retains its ordinary B2 path.  This is the production-owner fail-closed proof.
2. Add transaction-boundary tests with a recording `DSourceRetentionHooks` and
   test-owned D-shaped columns only—never a production D migration or D import:
   invoke `purgeNewlyHiddenInTransaction(tx, input)` while its transaction is open,
   then prove B2 deletes the matching `stream_log` rows and clears only matching
   dead-letter payloads in that same transaction.  Throw before commit and prove
   both B2 mutations roll back with the supplied D digest/version mutation; reject
   any participant implementation that starts a second transaction, awaits, or
   schedules post-commit deletion.
3. In the same B2-owned fixture, seed active and superseded affected rule-version
   rows both before and after the proposed bounds.  For a changed `sse-replay` value,
   shorten each B2 stream deadline to `min(oldDeadline, deliveredAt + durationMs)` or
   purge it when due; for `dead-letter`, use
   `min(oldDeadline, deadLetteredAt + durationMs)` and clear the payload when due.
   Every row bound to `revokedVersionId` is purged regardless of whether either
   retention changed.  Unrelated retention kinds and unrelated rule/account/message
   rows remain untouched.
4. Add the final-D guarded crash/restart matrix.  Starting from the final-D schema,
   inject a crash before the list/digest change, inside the common transaction after
   B2 stream purge, after B2 dead-letter purge but before commit, and after commit;
   restart before any source/read/replay/frame path.  Repeat at each shortening/
   purge point.  The result is either the complete old state or the complete new
   purged/shortened state—never a surviving hidden payload or half-shortened
   superseded row.  This guard skips only while the final-D fixture and concrete
   hooks do not exist; once they do, the test must run in `pnpm verify`.

**Implementation, in order**

1. Use Task 4's persisted `dead_lettered_at` and immutable dead-letter deadline as
   the original clock start; do not derive either from a current rule, a replacement,
   or a post-restart clock.
2. Add B2 participants in `phase-d-b2-retention.ts`, exported through one factory with exactly
   the type Phase D Task 7 accepts as `createRetainedContentParticipants`:

   ```ts
   export function createB2RetainedContentParticipants(
     input: Readonly<{ database: EventDatabase }>,
   ): Readonly<{ list: WhatsAppListChangeParticipant; retention: DSourceRetentionParticipant }>;
   ```

   Their only database handle is
   the supplied open `tx`: the list participant deletes `stream_log` by the supplied
   `(accountId, newlyHiddenMessageIds)` and clears matching dead-letter encrypted
   payloads; it neither opens another transaction nor performs an await.  The
   retention participant considers all `affectedVersionIds`, including superseded
   ones, shortens only `sse-replay` stream rows and `dead-letter` payloads using the
   exact `min(oldDeadline, clockStart + durationMs)` formula, and purges both kinds
   for `revokedVersionId` even when `changes` lacks either retention kind.
3. Registration has one site. `startEventOwner` never registers a participant itself.
   Before D it keeps the Task 8 no-op registry and pass-through visibility fence, where
   no WhatsApp row exists and B2's own native purge and shortening paths (step 4) cover
   its content. Once D's WhatsApp source is registered, `startEventOwner` passes
   `createB2RetainedContentParticipants` to Phase D Task 7's
   `createPhaseDWhatsAppOwnerComposition` as its `createRetainedContentParticipants`,
   which registers both participants exactly once (through
   `DSourceRetentionHooks.registerWhatsAppListChangeParticipant` and
   `registerRetentionTighteningParticipant`) and returns the concrete hooks and fence
   that reach the owner through the same Task 8 seam; do not recreate that factory or
   inject it solely in a test.  If a persisted WhatsApp
   tuple reaches an owner without that concrete seam, select the fail-closed path
   and do not invoke `writeFrame`, never the pass-through.  B2 must not import D's
   `whatsapp-visibility.ts`, construct a WhatsApp client, create a D transaction,
   or add a provider/send path.
4. Route existing B2 expiry, revoke, disable, replacement, and retention helpers
   through the same internal synchronous purge/shorten primitives, so the
   participant cannot have a weaker content-removal meaning than native B2 paths.

**Required mutations**

- Omit either one-time registration, register it per tick, import a D runtime module,
  replace the B2 default seam with a failing optional import, leave the normal
  post-D owner on test-only injection, or route a WhatsApp tuple through
  `PassThroughSseFrameVisibilityGate` when the D seam is absent: the owner/seam
  test fails.
- Start a new transaction, make either callback async, delete after commit, purge
  only `stream_log`, retain a matching dead-letter payload, omit a superseded
  version, use `max`/a new clock instead of `min(oldDeadline, clockStart +
  durationMs)`, or leave a revoked-version row: the transaction, tightening, or
  crash/restart test fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/phase-d-b2-retention-seam.test.ts test/migrations.test.ts test/retention.test.ts
    pnpm verify

Passing before D: the no-op seams register B2's synchronous participants and all
ordinary B2 tests pass without a D import or a WhatsApp row.  Passing after D: the
normal production owner receives D's concrete seam, a missing seam fails closed for
WhatsApp rows, and the guarded real-schema crash/restart matrix proves the
one-transaction list and tightening contract.
Commit: feat(events): join B2 retained SSE content to the Phase-D safety seam.

### Task 9 — loopback SSE listener, every-frame WhatsApp fence, and real-browser CORS verification **(high risk)**

**Files**

- Add packages/events-daemon/src/runtime/sse-server.ts,
  packages/events-daemon/test/support/browser-sse-fixture.ts,
  packages/events-daemon/test/support/sse-client.ts,
  packages/events/test/browser/sse-client.html, and
  packages/events/test/browser/sse-client.js.
- Update packages/events/scripts/verify-browser.mjs,
  packages/events/test/browser/index.html, packages/events/test/browser/boot.js,
  .github/workflows/release.yml, test/release-packages.test.mjs,
  packages/events-daemon/src/runtime/sse-dispatcher.ts, and
  packages/events-daemon/src/runtime/stream-replay.ts.
- Add packages/events-daemon/test/sse-listener.test.ts and
  packages/events-daemon/test/sse-listener-browser.test.ts and
  packages/events-daemon/test/phase-d-b2-sse-visibility-contract.test.ts; update
  packages/events-daemon/test/sse-frame-fences.test.ts.

**Tests first**

1. Raw loopback client checks exact route/Host/bearer, query/cookie refusal, OPTIONS
   method/headers, exact origin reflection, Vary, no wildcard/credentials, literal
   persisted binding.
2. Chromium/WebKit case inside pnpm verify:browser: page on one literal loopback
   origin uses cross-origin streaming fetch with Authorization, Last-Event-ID and
   credentials: omit to distinct literal SSE authority. Prove browser preflight,
   authorised live/replay frame, no cookie/no ACA credentials; unlisted-origin/
   credentialed cases fail before frame.
3. Before page creation install route permit only exact page/SSE URLs; Node fixture
   starts under Task 1 preload before dynamic daemon import and reports zero DNS/non-
   loopback counters.
4. Race header/every frame gate with rotation/pause/disable/revoke/account removal:
   old stream receives no later header/frame.
5. Assert root verify:browser runs this test; release browser job updates B2 name/
   check and invokes root command after build; update structural workflow test.
6. Make `phase-d-b2-sse-visibility-contract.test.ts` the B2-owned convergence
   proof.  It dynamically detects the final-D fixture and concrete
   `WhatsAppVisibilityFence`; pre-D it records an explicit skip, while after D it
   cannot be opted out of.  For both the actual live writer and the actual
   `Last-Event-ID` replay writer, pause after frame preparation, apply a real
   `ChatListStore.update` that newly hides the tuple, then release the sealed sink.
   An allowed `(accountId, whatsappMessageId)` writes once; a newly hidden one writes
   neither frame nor replay and reaches neither retained `stream_log` content nor a
   dead-letter payload.  The trace must be `fence check -> synchronous writeFrame ->
   ServerResponse.write` with no await/microtask between the first two operations.
   Construct this owner only through Phase D Task 7's production composition step,
   then repeat with its concrete seam absent and prove that an otherwise allowed
   WhatsApp tuple reaches neither the pass-through gate nor `ServerResponse.write`.
   The pre-D branch retains the structural pass-through unit vector but has no
   persisted WhatsApp row and explicitly skips this production-D proof.
   The test also runs the Task 8a list-change and `sse-replay`/`dead-letter`
   retention crash/restart cases through the concrete D transaction, for live and
   superseded versions before and after their proposed deadline.  This is B2's test:
   Phase D Task 10 may run and inspect it only; it must not create, repair, or own it.

**Implementation, in order**

1. Loopback-only listener over Task 8 registry; reject route/Host/auth/CORS before
   registration and add no control/operation/CLI/MCP surface.
2. Gate immediately before writeHead.  For a normal frame, preserve the Task 8
   final authority/mutex gate immediately before the synchronous `response.write`.
   For every live or replay WhatsApp frame, make `sse-server.ts` supply its sealed
   synchronous `response.write` callback to the Task 8 writer, so that writer calls
   `WhatsAppVisibilityFence.withCurrentSseFrameVisibility(input, writeFrame)` after
   preparation and immediately before the physical write.  Do not add a second,
   later direct WhatsApp write path in the server; the callback neither awaits nor
   schedules work, and a hidden/unreadable list never invokes it.
3. Extend existing Playwright script with sealed daemon fixture/browser CORS, retain
   event vectors and report both.
4. Run the final-D-guarded contract fixture through the real loopback client as well
   as the sealed sink.  Its normal-owner case must use Phase D Task 7's production
   composition step and the same Task 8 owner seam, not a test-only injection; its
   missing-seam case must fail closed for a WhatsApp tuple.  B2 has no import of D's
   fence/hook implementation and remains independently buildable with the pre-D
   structural pass-through, for which no WhatsApp row exists.
5. Rename/document release required browser check as vectors plus loopback daemon
   SSE/CORS while preserving publish dependency.

**Required mutations**

- Query/cookie auth, wrong Host, wildcard/unlisted reflection or credentials: CORS fails.
- No preflight/credentials include/route seal skipped/case omitted: browser/workflow fails.
- Final gate moved or old rotation stream frames: listener/frame fails.
- Delete either live/replay `withCurrentSseFrameVisibility` invocation, mutate the
  WhatsApp server callback to call `response.write` outside `writeFrame`, defer that
  write through an await/microtask, bypass the gate after prepared-frame list change,
  omit either Task 8a registration, replace the normal D production composition
  with test-only seam injection, allow an absent post-D seam to select pass-through,
  or split its D transaction: the named `phase-d-b2-sse-visibility-contract` test
  fails.  This mutation is required after D lands; it must demonstrate the
  convergence oracle, not merely a mocked callback.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test test/sse-listener.test.ts test/sse-listener-browser.test.ts test/sse-frame-fences.test.ts test/phase-d-b2-sse-visibility-contract.test.ts
    pnpm verify:browser
    pnpm verify

Passing before D: Chromium/WebKit verify preflight and credential-omitting CORS
against loopback daemon SSE, while the final-D-only convergence fixture explicitly
skips and B2 imports no D runtime.  Passing after D: the same commands exercise both
writers through the normal D production composition seam, prove an absent seam fails
closed, and prove every WhatsApp frame is fenced at its actual write.  Release
requires it. Commit:
feat(events): verify loopback SSE in real browsers.

**Batch 5 close.** Before Phase D lands, run `pnpm verify` and `pnpm
verify:browser` with the standalone no-FK migration, structural pass-through, no
persisted WhatsApp row, and the explicit final-D skips; stream state/listener/both
browsers must share final fencing.  Once the branches share one rebased registry,
run both immutable migration-order vectors and use Phase D Task 7's production
composition seam: the B2 convergence rebuild/`foreign_key_check`, participant,
prepared-frame, missing-seam fail-closed, bypass-mutation, and crash/restart proofs
are then required.  D Task 10 audits those B2-owned results only.

## Batch 6 — held integration gate

### Task 10 — sealed B2 E2E, B1-surface audit and release hold **(high risk)**

**Files**

- Update test/events-daemon-e2e.test.mjs, test/helpers/loopback-seal.mjs,
  packages/events-daemon/test/capability-audit.test.ts, and
  packages/events-daemon/test/built-surfaces.test.ts.
- Update packages/events-daemon/README.md, docs/RELEASING.md, and
  test/release-packages.test.mjs only for held/release-browser evidence.
- Do **not** edit packages/events-daemon/src/cli/program.ts,
  packages/events-daemon/src/mcp/server.ts, capabilities.json,
  docs/reference/events-daemon-cli.md, or docs/reference/events-daemon-mcp.md for B2
  public surface; preserve B1 doctor and references.

**Tests first**

1. Preloaded sealed E2E internal fixtures: HTTPS/loopback HTTP/fingerprint failure/
   cap-barrier wait/order-recovery/reset-final-ref/in-flight discard/SSE rotation-
   replay-purge/no judge call; only literal fakes and zero DNS/non-loopback.
2. B1 doctor is on CLI/MCP and reaches B1 operation. Assert no delivery retry/drop/
   hold, subscribers, named secrets/migration, target test/resume/replay/judges or
   B3 doctor extensions.
3. Assert holds/nonpublishable output/unchanged B1 generated references/release
   browser B2 requirement.

**Implementation, in order**

1. Compose E2E through internal runtime/owner seams and dynamic imports after preload;
   never smuggle B3 operation into test.
2. Negative inventory assertions wrap existing parity/capability audit; never remove
   or defer doctor.
3. Concise held/release docs: no publish list/tag/provenance/registry/new public tool.
4. PR evidence only: plan/docs/code/tests, pnpm verify, pnpm verify:browser, hold
   proof and no real data/address/token/key/external-traffic attestation.

**Required mutations**

- Add delivery/subscriber/secret/target-resume/judge surface or remove doctor:
  capability/built-surface fails.
- Seal after import, allow DNS/non-loopback, remove fence: E2E fails.
- Lift hold/add publishable package/remove browser SSE check: release test fails.

**Run**

    node --import test/helpers/loopback-seal-preload.mjs --test test/events-daemon-e2e.test.mjs
    pnpm verify:browser
    pnpm verify

Passing: B2 is sealed/held, B1 doctor persists, B3/E public surface is absent.
Commit: docs(events): document held B2 runtime boundaries.

**Batch 6 close.** Run pnpm verify once more and pnpm verify:browser alongside it;
release browser gate requires real-browser SSE/CORS.

## §5 coverage ownership

Each B2-owned §5 portion has exactly one owner. B1 retains its rows; B3/E retain
delivery/hold/subscriber controls, named secret operations/migration command, target
test/resume, full doctor/dry-run surface and callable judges.

| §5 row / B2-owned assertion | Sole task owner |
| --- | --- |
| Canonical URLs, all-answer pinning, redirect/proxy refusal, HTTPS/HTTP matrix, recursive transitions and every non-global IANA IPv4/IPv6 snapshot range; root/package `pnpm verify` preload seal and network-process sentinel | Task 1 |
| Exact dry-run/webhook/SSE target keys, target-specific immutable CloudEvent representations and generic owner/scheduler routing before document widening | Task 2 |
| Versioned webhook/subscriber docs, secret URL redaction/fingerprint/versioning, masters plus every current/overlap B2 secret ref migration/reconciliation | Task 3 |
| Forward outbox/AAD schema, prepared three-target persistence, cap-free system reset outbox, active-plus-retained exact final-reference model, and immutable dead-letter clock/deadline | Task 4 |
| Atomic cap/barrier-before-attempt eligibility, reset wait, stable rule/account/target ordering across superseded versions, stale claim prevention | Task 5 |
| Webhook bytes/signing/overlap and separate DNS/TCP/TLS/write gates | Task 6 |
| Webhook/system-reset crash matrix, lease ownership, no duplicate charge/stale outcome/recreated purge, exact-lineage recovery | Task 7 |
| SSE encrypted append/replay, bearer current/overlap auth, rotation invalidation, and internal frame authority | Task 8 |
| Forward `stream_log` schema/AAD: B2-first no-FK standalone migration; D-first direct-FK migration; B2-owned post-D rebuild/copy convergence to the nullable WhatsApp message/version pair, same-source check, occurrence composite foreign key/purge index, encrypted-row preservation, and `foreign_key_check`; immutable proofs of both upgrade orders; and pre-D structural pass-through seam | Task 8 |
| Exactly-once owner registration of B2 list-change/retention participants; Phase D Task 7 production-composition injection of the concrete fence/hooks through `startEventOwner`; fail-closed missing post-D seam; same-transaction hidden stream/dead-letter purge; active and superseded shortening or revoked-version purge with crash/restart convergence | Task 8a |
| Loopback SSE listener/CORS, actual live/replay WhatsApp every-frame gate through the normal D production composition seam, B2-owned prepared-frame/list-change/missing-seam/bypass convergence proof, and Chromium/WebKit preflight credential-omitting verification in verify:browser/release | Task 9 |
| Sealed full path, B1 doctor preservation, B3/E public-surface absence, held-release evidence | Task 10 |

## Final verification and hand-off

After final batch inspect git diff --check and git status --short without altering
unrelated work, then run:

    pnpm verify
    pnpm verify:browser

Record full pass/fail in PR. No implementation commit, tag, publish, email, Slack
post, Resend request, DNS lookup or non-loopback connection is authorised by this
plan.

Commit this plan with:

    docs(plan): local event emission — phase B2, the Phase D seam, review round 4
