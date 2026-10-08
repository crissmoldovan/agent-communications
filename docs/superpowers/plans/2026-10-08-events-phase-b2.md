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
   (or equivalent NODE_OPTIONS) before evaluation. The preload imports Node built-ins
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

4. **Atomic claim and order.** Decision insert allocates immutable ordering_sequence
   from delivery_order_counters keyed by exact rule/version/account/target/version.
   Claim waits while earlier sequence is queued, retryable or unexpired disclosing.
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
   Task 6 crash matrix is normative.

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
| Append stream log / settle SSE delivery | Leased delivery/account/switch/rule/target/subscriber/barrier/expiry/cap/log identity remain; append+settle one transaction. | sse-persistence-auth |
| Accept/rotate/close SSE stream | Exact subscriber/authority/token generation live; rotate commits invalidation then closes under mutex. | sse-persistence-auth |
| Write each live/replay frame | Row/token/account/rule/subscriber/stream registration live; mutex repeats check immediately before write. | sse-frame-fences, browser listener |
| Expire/purge/dead-letter | Exact current row/reason; never mutate newer state or recreate encrypted content. | retention/crash/reset |

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
| B2-D | D2; D8 | Ordering/retry enum/default unstated. | per-rule-account-target, default 20/range 1–20 and Task 4 fence; ask owner to name normatively. |
| B2-E | D6; D7 | Listener authority/identity schema incomplete. | Persist literal authority/require agreement; ask owner to approve fields/multi-listener policy. |
| B2-F | D6 | Bounded overlap duration unspecified. | Five minutes/current+previous only; ask owner to make normative. |
| B2-G | D7 | IANA source/update cadence unspecified. | Versioned checked-in snapshot with source metadata/hashes/exhaustive vectors; ask owner for cadence. |

## Batch map and safe parallelism

There are **nine tasks in five batches**. Tasks 1/2 may run in separate worktrees.
Later tasks are serial because each owns state the next uses; one builder completes
one task, including full verification, in one sitting.

| Batch | Tasks | Can run in parallel | Why / dependency |
| --- | --- | --- | --- |
| 1 — safety/model substrate | 1, 2 | 1 and 2 separate worktrees | Seal/address and document/secret files do not overlap. |
| 2 — persistence/eligibility | 3, 4 | No | Task 3 defines storage/references; Task 4 claims them. |
| 3 — webhook transport/recovery | 5, 6 | No | Task 5 transport; Task 6 its crashes. |
| 4 — SSE boundary | 7, 8 | No | Task 7 persistence/auth; Task 8 listener/browser. |
| 5 — held integration | 9 | No | Audits public boundary/E2E/release after runtime work. |

## Batch 1 — safety/model substrate

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
  test/helpers/loopback-seal.test.mjs, and test/events-daemon-e2e.test.mjs.

**Tests first**

1. Generate inside/boundary vectors for every non-global snapshot prefix; assert
   version/source metadata/hash and unconditional metadata/link-local denial.
2. Table-test outer/embedded mapped/compatible/NAT64/6to4/Teredo, including forbidden
   outer/safe embedded and inverse; null/multiple/ambiguous NAT64 rejects while
   injected trusted /96 proves recursion.
3. Inject resolver/literal fake to test TLS/SNI/Host/all answers/cert/no redirect/no
   proxy/fingerprint-before-resolver/exact HTTP matrix.
4. Fresh preloaded child statically imports transport and tests patched DNS/resolver/
   net/tls/http entry refusal; Unix/literal loopback succeeds. E2E dynamic imports
   modules only after marker assertion.
5. Local-endpoint accepts literal-loopback HTTP singleton only and no operation/
   dispatcher import or judge call.

**Implementation, in order**

1. Check in/import static snapshot; implement CIDR and recursive address validation.
2. Implement injected resolver/raw connector without cache/proxy/redirect.
3. Build loopback receiver and fixture-only throwaway TLS material.
4. Implement pre-import seal and all named resolver/socket/request patches.
5. Keep local endpoint unreachable from operations and add graph assertion.

**Required mutations**

- Missing/changed non-global registry vector/metadata/version: snapshot test fails.
- Outer-only/embedded-only validation or guessed NAT64: address test fails.
- Hostname HTTP/proxy/redirect/missing answer or cert check: connector test fails.
- Import before preload/missing patch: fresh-process seal/E2E fails.
- Local endpoint operation import: graph test fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test test/network/address-policy.test.ts test/network/iana-snapshot.test.ts test/network/pinned-connection.test.ts test/network/local-endpoint.test.ts
    node --import test/helpers/loopback-seal-preload.mjs --test test/helpers/loopback-seal.test.mjs test/events-daemon-e2e.test.mjs
    pnpm verify

Passing: literal loopback only, zero DNS, every snapshot non-global range refused.
Commit: feat(events): seal and validate pinned network transport.

### Task 2 — immutable B2 documents and complete event-secret reconciliation **(high risk)**

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

1. Canonical plain/secret webhook and SSE subscriber docs; URL byte changes version;
   public serialisations/errors/logs reveal no synthetic URL/slot/token/key.
2. B1 fixture proves append-only slot/AAD migration covers secret URL, webhook signing
   current/previous, SSE bearer current/previous.
3. Pausable fake store races create/rotate/reconcile/migrate and asserts lock →
   masters plus every current/overlap ref → copy/write → read-back verify → selector
   commit → source retirement, preserving old selector on failure.
4. Existing B1 target capability only; assert no new command/tool/row/secret result
   and subscriber factory stays internal.

**Implementation, in order**

1. Add append-only slot migration/AAD; never change B1 migration text.
2. Add canonical types and existing shared target validation; add no delivery/
   subscriber operations, CLI/MCP, capability row or reference.
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

**Batch 1 close.** Integrate worktrees then pnpm verify; sealed substrate and model
must coexist before outbox use.

## Batch 2 — persistence and eligibility

### Task 3 — ordinary delivery persistence and distinct system reset outbox **(highest risk)**

**Files**

- Update packages/events-daemon/src/store/migrations.ts,
  packages/events-daemon/src/store/aad.ts,
  packages/events-daemon/src/store/records.ts,
  packages/events-daemon/src/runtime/decisions.ts,
  packages/events-daemon/src/runtime/reset.ts,
  packages/events-daemon/src/runtime/replacements.ts, and
  packages/events-daemon/src/runtime/revocations.ts.
- Add packages/events-daemon/src/runtime/system-reset-outbox.ts and
  packages/events-daemon/src/runtime/target-version-references.ts.
- Add/update packages/events-daemon/test/outbox-persistence.test.ts,
  packages/events-daemon/test/system-reset-outbox.test.ts,
  packages/events-daemon/test/system-reset-references.test.ts, and
  packages/events-daemon/test/migrations.test.ts.

**Tests first**

1. B1 migration proves deliveries gains ordinary lease/order only; system_reset_outbox
   owns reset bytes/state and no reset can satisfy ordinary decision/account/rule
   constraints or insert fake identities.
2. Active-rule plus retained superseded-delivery exact-version references remove/
   replace one at a time; query retains reset until final authorised ref disappears,
   then purges barrier/outbox in same transaction.
3. Race reset create/restart/revoke/retained expiry; D6-only payload, 20/24 and no
   cap charge.
4. Interrupted migration/AAD mismatch/purge preserves B1 local reset and cannot
   recreate system ciphertext.

**Implementation, in order**

1. Add forward ordinary lease-token/attempt/order, system-outbox, target-reference,
   order-counter/barrier-link migrations and AAD.
2. Persist active refs on activation and retained refs atomically with ordinary bytes.
3. Use exact reference query in all reset create/recover/cleanup/revocation paths.
4. Implement cap-free system repository and forbid reset insertion into deliveries,
   decisions, cap charges or fabricated account/rule.

**Required mutations**

- Reset ordinary row/fake identity/cap charge: system schema fails.
- Active-pointer-only/drop retained ref/cancel first removal: final-reference fails.
- Missing system AAD/post-purge ciphertext: migration/purge fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/outbox-persistence.test.ts test/system-reset-outbox.test.ts test/system-reset-references.test.ts test/migrations.test.ts
    pnpm verify

Passing: reset is system outbox work with final-reference semantics.
Commit: feat(events): persist distinct reset outbox and target references.

### Task 4 — atomic cap/barrier claims and per-target ordering fence **(highest risk)**

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
2. Later deterministic sequence waits behind earlier retry, active lease and expired/
   recovered lease; runs after earlier completion/failure/cancel/expiry; cover restart
   and stale completion.
3. First charge/attempt/token is atomic once; retries/recovery reuse it; reset never
   charges; cover pause/disable/revoke/account removal/expiry.
4. Keep B1 dry-run green through shared eligibility, no webhook transport yet.

**Implementation, in order**

1. Allocate sequence in decision insert; one claimant serves scheduler/recovery.
2. One immediate transaction evaluates all predicates before lease/attempt; blocked
   result is content-free and mutation-free.
3. Persist attempt id/random token; require both for release/recovery/completion.
4. Apply token/lineage semantics to system reset while preserving cap exemption.

**Required mutations**

- Attempt/lease/work/charge/append while cap or reset blocked: cap-barrier fails.
- Later sequence past retry/recovered lease or recovery bypass: ordering fails.
- Missing token/attempt or stale settlement: stale recovery fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/claim-cap-barrier.test.ts test/claim-ordering.test.ts test/stale-recovery.test.ts test/dispatcher.test.ts test/retention.test.ts
    pnpm verify

Passing: blocked work consumes no attempt and ordering survives retry/recovery.
Commit: feat(events): fence claims with caps barriers and ordering.

**Batch 2 close.** Run pnpm verify before raw transport.

## Batch 3 — webhook transport and recovery

### Task 5 — fenced Standard Webhooks with DNS, TCP, TLS and write gates **(highest risk)**

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
4. Classify no-follow response and hand outcome to Task 6; no operation/CLI/MCP/
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

### Task 6 — deterministic webhook crash, lease-expiry and stale-owner recovery **(highest risk)**

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
2. Recovery uses Task 4 expired claim then re-fences before DNS.
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

**Batch 3 close.** Run pnpm verify; all crash outcomes share lease/lineage/cap rules.

## Batch 4 — SSE boundary

### Task 7 — persisted SSE log, bearer generations and frame authority **(high risk)**

**Files**

- Add packages/events-daemon/src/runtime/sse-dispatcher.ts,
  packages/events-daemon/src/runtime/stream-replay.ts, and
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
  packages/events-daemon/test/sse-frame-fences.test.ts; update
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

**Implementation, in order**

1. Add forward stream-log migration/AAD and Task 2 generation refs.
2. Append/settle together under Task 4 eligibility and purge bytes/refs together.
3. Implement internal registry/mutex/auth boolean with live rereads/invalidation.
4. Prepare replay/live outside writes then require Task 8 final frame gate.

**Required mutations**

- Split append/settle, charge replay, retain purged bytes: persistence fails.
- Accept retired generation/close after rotation/skip gate: auth-frame fails.
- Add subscriber/bearer operation: negative audit fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/sse-persistence-auth.test.ts test/sse-frame-fences.test.ts test/migrations.test.ts test/retention.test.ts
    pnpm verify

Passing: SSE has durable disclosure semantics before listener. Commit:
feat(events): persist fenced SSE replay and bearer state.

### Task 8 — loopback SSE listener and real-browser CORS verification **(high risk)**

**Files**

- Add packages/events-daemon/src/runtime/sse-server.ts,
  packages/events-daemon/test/support/browser-sse-fixture.ts,
  packages/events-daemon/test/support/sse-client.ts,
  packages/events/test/browser/sse-client.html, and
  packages/events/test/browser/sse-client.js.
- Update packages/events/scripts/verify-browser.mjs,
  packages/events/test/browser/index.html, packages/events/test/browser/boot.js,
  .github/workflows/release.yml, and test/release-packages.test.mjs.
- Add packages/events-daemon/test/sse-listener.test.ts and
  packages/events-daemon/test/sse-listener-browser.test.ts.

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

**Implementation, in order**

1. Loopback-only listener over Task 7 registry; reject route/Host/auth/CORS before
   registration and add no control/operation/CLI/MCP surface.
2. Gate immediately before writeHead; independently gate immediately before every
   synchronous response.write frame under mutex.
3. Extend existing Playwright script with sealed daemon fixture/browser CORS, retain
   event vectors and report both.
4. Rename/document release required browser check as vectors plus loopback daemon
   SSE/CORS while preserving publish dependency.

**Required mutations**

- Query/cookie auth, wrong Host, wildcard/unlisted reflection or credentials: CORS fails.
- No preflight/credentials include/route seal skipped/case omitted: browser/workflow fails.
- Final gate moved or old rotation stream frames: listener/frame fails.

**Run**

    pnpm --filter @agentcomms/events-daemon exec node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test test/sse-listener.test.ts test/sse-listener-browser.test.ts
    pnpm verify:browser
    pnpm verify

Passing: Chromium/WebKit verify preflight and credential-omitting CORS against
loopback daemon SSE; release requires it. Commit:
feat(events): verify loopback SSE in real browsers.

**Batch 4 close.** Run pnpm verify and pnpm verify:browser; stream state/listener/
both browsers must share final fencing.

## Batch 5 — held integration gate

### Task 9 — sealed B2 E2E, B1-surface audit and release hold **(high risk)**

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

**Batch 5 close.** Run pnpm verify once more and pnpm verify:browser alongside it;
release browser gate requires real-browser SSE/CORS.

## §5 coverage ownership

Each B2-owned §5 portion has exactly one owner. B1 retains its rows; B3/E retain
delivery/hold/subscriber controls, named secret operations/migration command, target
test/resume, full doctor/dry-run surface and callable judges.

| §5 row / B2-owned assertion | Sole task owner |
| --- | --- |
| Canonical URLs, all-answer pinning, redirect/proxy refusal, HTTPS/HTTP matrix, recursive transitions and every non-global IANA IPv4/IPv6 snapshot range | Task 1 |
| Versioned webhook/subscriber docs, secret URL redaction/fingerprint/versioning, masters plus every current/overlap B2 secret ref migration/reconciliation | Task 2 |
| Forward outbox/AAD schema, cap-free system reset outbox, active-plus-retained exact final-reference model | Task 3 |
| Atomic cap/barrier-before-attempt eligibility, reset wait, deterministic ordering, stale claim prevention | Task 4 |
| Webhook bytes/signing/overlap and separate DNS/TCP/TLS/write gates | Task 5 |
| Webhook/system-reset crash matrix, lease ownership, no duplicate charge/stale outcome/recreated purge, exact-lineage recovery | Task 6 |
| SSE encrypted append/replay, bearer current/overlap auth, rotation invalidation, internal frame authority | Task 7 |
| Loopback SSE listener/CORS/final header-frame writes and Chromium/WebKit preflight credential-omitting verification in verify:browser/release | Task 8 |
| Sealed full path, B1 doctor preservation, B3/E public-surface absence, held-release evidence | Task 9 |

## Final verification and hand-off

After final batch inspect git diff --check and git status --short without altering
unrelated work, then run:

    pnpm verify
    pnpm verify:browser

Record full pass/fail in PR. No implementation commit, tag, publish, email, Slack
post, Resend request, DNS lookup or non-loopback connection is authorised by this
plan.

Commit this plan with:

    docs(plan): local event emission — phase B2, review round 1
