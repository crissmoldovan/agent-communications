# Local event emission — Phase B2 implementation plan

> **For the implementation team:** B2 is a held-package implementation plan. Do not
> publish `@agentcomms/events` or `@agentcomms/events-daemon`, add a release tag, or
> contact a non-loopback service while carrying it out. Every batch below ends in
> `pnpm verify` before its commit.

## Scope and inherited decisions

B1 is the baseline: `@agentcomms/events` and `@agentcomms/events-daemon` exist,
are held from release, and use Node **22.16.0 or later** with B1-F's lazy
`node:sqlite` loader. B1-G's control boundary remains unchanged: Unix control
directories/socket permissions are private, and Windows refuses control rather
than introducing a token-bearing network control plane.

B2 implements only the B2 row in §4: safe webhook/SSE transport and persistence,
the underlying network reset/degraded-recovery machinery, and the CLI/MCP rows
listed below. It does **not** make a judge kind callable, add a network listener
other than the local SSE listener, expose a full secret operation, add `target
test`/`target resume`, change the core change policy, lift either package hold, or
publish anything. The local-endpoint transport work in this phase is a validated,
unreachable transport primitive for Phase E; no scheduler, operation, CLI command,
or MCP tool may invoke it before E.

This plan preserves the B1 rule that a convenience in-memory cache is never an
authority source. At every disclosure boundary, load the account from core's
`ConfigStore` afresh, and treat the current switch generation, enablement, pause
state where it gates a claim, exact rule/target/subscriber versions, and current
delivery row as authoritative only when re-read in the transaction that changes
the row.

### Binding B1 amendments and committee decisions

The whole B1 plan, including amendments B1-A through B1-G and its complete
“Decisions made during the build (committee)” table, remains binding. B2 does not
silently reopen any of them. The following is the operative carry-forward checklist
for work that can otherwise look local to B2:

| Binding B1 decision | B2 consequence |
| --- | --- |
| B1-A | Existing terminal-only safe dry-run reads stay as they are; B2 does not use B3's broad exception allocation as a reason to move or widen them. |
| B1-B | B1's local dry-run reset append barrier remains. B2 adds only network target-version barriers/degraded behaviour; `target resume` remains terminal/app-only in B3 and excluded from MCP. |
| B1-C | Add only forward B2 migrations with explicit AAD contracts for B2 tables; never rewrite v1 or pre-create E/D future schemas. |
| B1-D | Gmail alone is runnable before D. Network delivery consumes established events; it does not make another source/baseline callable. |
| B1-E | Reuse the independent event-secret backend and fail closed. B2 adds backing slots, not a model-facing secret operation. |
| B1-F / K4 | Keep `engines.node >=22.16.0`, one lazy `node:sqlite` loader and the 22.12 named-refusal/22.16 SQLite release legs. No experimental flag, native driver, install script or static SQLite import. |
| B1-G / K5 | Do not weaken the Unix 0700-directory/0600-socket re-proof plus token boundary; Windows still refuses `WINDOWS_CONTROL_UNAVAILABLE`. The SSE listener is a disclosure endpoint, never a replacement control plane. |
| Committee: canonical documents, exact-version purge, disable-all and pause | Preserve every canonical rule leaf/embedded exact version; purge by exact revoked version rather than rule id; disable retains only the B1-specified content-free records/cap charges and leaves pause unchanged; pause blocks claims/recovery. |
| Committee: post-await writes and D9 | `EventRecordCipher.encrypt()` remains outside caller write transactions. Every B2 post-await write re-reads fresh core account configuration, switch/generation, exact row/version/lease and retention facts in its own transaction; a lost race writes nothing or only the existing content-free attempt marker. |
| Committee: packaging/E2E | Keep runtime workspace dependencies external as B1 established, retain the no-native-bundle proof, and install the loopback seal before any daemon/provider import. |

### Decisions the spec leaves to the plan

1. **Use Node built-ins and a deliberately small pinned transport.** Use
   `node:net`, `node:tls`, `node:http`, `node:crypto`, and an injected resolver;
   do not add an HTTP server/client, DNS, proxy, TLS, or native dependency. This
   avoids install scripts, new licence/provenance surface, bundle externals, and
   the native-module problems B1 avoided. The webhook client owns a raw connected
   socket, does not call `fetch`, `http(s).request`, an agent, or a proxy-aware
   library, always sets `agent: false` where a test helper uses Node HTTP, and
   never reads proxy environment variables. Redirects are disabled by construction:
   one request yields one response and a 3xx is retryable/non-2xx, never followed.

   The resolver returns all candidate answers to an injected interface. Canonical
   IP parsing unwraps IPv4-mapped IPv6, NAT64, 6to4 and Teredo outer/embedded
   representations; an ambiguous or disallowed representation rejects before a
   connect. Every returned answer must be in the target's sorted approved CIDR set.
   The client connects only to a vetted literal address while preserving the
   canonical URL hostname for TLS SNI, certificate hostname verification, and
   `Host`. `rejectUnauthorized` stays true; tests inject only a throwaway local CA
   into the client test seam. Literal IP HTTPS performs IP certificate checking and
   sends no hostname SNI. HTTP is accepted only when the URL host is exactly the
   canonical literal `127.0.0.1` or `::1` and the sole approved address is that
   literal; hostname-to-loopback, IPv4-mapped spellings, all other private HTTP,
   redirects, and proxy configuration cannot widen this exception.

   The IANA special-purpose classification will be a checked-in, reviewed policy
   snapshot with its source date/version in a comment and tests for the mandatory
   metadata/link-local cases. It is data, not a runtime network lookup. A later
   policy update is a visible reviewable source change rather than a DNS/library
   update changing egress silently. A reasonable alternative is a maintained IP
   library; reject it because it adds an update/licence/install surface and hides
   the normative classification behind dependency behaviour.

2. **Target versions are immutable, and secrets have no document reference.** A
   plain webhook document stores its canonical public URL (no userinfo, query, or
   fragment). A secret-URL document stores only
   `{ scheme, host, port, sha256 }`; its complete canonical URL, including any
   sensitive path/query/userinfo, is in the independent daemon secret store. The
   SQLite secret-slot tables join an opaque slot to a target/version, but neither
   public documents, previews, canonical-rule bytes, control responses, MCP
   results, logs, audits, nor errors contain the opaque slot or complete URL. A
   SHA-256 fingerprint is recomputed after every secret read and before resolution.
   A byte change to either form of URL creates a new target version and requires a
   new rule activation; it never edits a live version in place.

   A webhook target has an explicit Standard Webhooks signing mode, approved
   address set, retry limit (integer 1–20, default 20), and
   `deliveryOrdering: "per-rule-account-target"`. The latter is serial only for
   that tuple, matching D8's ordering key, rather than globally serialising an
   unrelated target. An alternative default of unordered delivery is unsafe and
   would make the D8 ordering clause untestable. Signing keys and SSE bearer
   tokens are generation records in the same independent secret store. Rotation
   keeps current plus previous for a **five-minute** bounded overlap, matching the
   consumer timestamp tolerance; the previous generation is then erased through
   the normal secret/reconciliation path. Five minutes is a plan choice, not an
   implied unbounded grace period.

   B2 builds the slot/rotation state and exercises it through daemon-internal test
   seams. It intentionally does not offer a terminal, app, or MCP command that
   creates/displays/rotates a secret: those named exception operations remain B3.
   An agent can create or inspect only non-secret target/subscriber descriptors and
   delivery summaries; it cannot read a secret URL, signing key, bearer token,
   prior token, secret slot, complete query, or a body. An MCP caller has the same
   limitation.

3. **Webhook outbox state is fenced at the attempt, not merely at the job.** Add a
   single generic delivery dispatcher on top of B1's encrypted outbox. A webhook
   is `queued`/`retryable` → leased `disclosing` → `delivered`, `retryable`, or
   `dead-lettered`; expiry/revocation/disable can instead make it terminal. The
   first claimed webhook attempt performs one cap charge; retries do not charge a
   cap. Attempts use capped exponential backoff with deterministic test-injected
   jitter, never exceed 20 or the target limit, and never run after the fixed
   deadline. A 2xx is success; everything else is classified without accepting a
   redirect. Every attempt has the stable delivery ID, a timestamp sampled at its
   start, and a newly calculated `v1,<base64>` HMAC-SHA-256 over
   `id + "." + timestamp + "." + exactBody`. During overlap it emits two
   space-separated signatures. The body and ID are unchanged across retries.

   `delivery retry` only changes a webhook already in `retryable`; after its
   complete fence succeeds it sets `nextAt=now`. It never remaps, re-judges,
   creates a new delivery, extends a deadline, or mutates a terminal/non-webhook
   row. It refuses with no mutation for attempts/expiry/revocation/lifecycle/live
   account/generation failures. The alternative “clone for manual retry” breaks
   stable IDs, cap accounting and the stipulated deadline.

4. **Network reset barriers are durable target-version state.** Generalise B1's
   local reset records into encrypted reset deliveries plus a barrier keyed by
   `(resetEpoch, targetId, targetVersion)`. Ordinary deliveries wait behind the
   closed barrier; a successful reset opens it; reset failure/expiry/dead-letter
   makes it degraded. Reset work has a fixed 20 attempts/24 hours and no cap.
   The B2 runtime exposes an internal, owner-session-only recovery function for
   the daemon's future B3 operation: it verifies the retained target version and
   creates a new reset delivery, never retries an old one. The CLI/MCP `target
   resume` exception remains B3. Revoke/purge deletes the reset payload and closes
   no later work behind a removed target.

5. **SSE is a loopback server with bearer generations, not EventSource.** The
   daemon owns a loopback-only HTTP listener and serves only
   `GET /v1/streams/<subscriber-id>` with a fixed configured listener authority.
   Subscriber documents contain an exact stream identity and an exact origin set;
   they never contain a bearer token. A request must use `Authorization: Bearer`,
   has no query/cookie authentication, and is rejected if `Host` is not byte-for-
   byte the configured listener authority. CORS reflects an exact allowed Origin
   only, supplies the exact preflight headers `Authorization, Last-Event-ID`,
   uses `Vary: Origin`, has no credentials and no wildcard. Rotation commits the
   new token generation and invalidates old streams inside the subscriber mutex;
   it aborts their sockets before returning. Disable-all, revocation, pause where
   it gates work, and account removal all prevent later frames; revocation/account
   removal also purge retained replay bytes. A stream replay is a normal disclosure
   boundary and rechecks authority before each frame.

   The listener's `host` (`127.0.0.1` or `::1`) and non-zero port are daemon
   configuration captured as the subscriber's public `listenerAuthority`; active
   subscribers must agree on it, otherwise creation refuses. This makes `Host`
   validation unambiguous and permits IPv4/IPv6 test coverage. A reasonable
   alternative is an ambient daemon port chosen at startup; reject it because it
   cannot make the subscriber version's stream identity/digest stable.

6. **Every outbound phase has a just-before-I/O authority gate.** “Immediately
   before a byte leaves” means no asynchronous boundary separates the final
   transaction gate and the call that initiates that outbound phase. A webhook
   has three gates: immediately before resolver invocation, immediately before
   `net.connect`/`tls.connect` (before a SYN/ClientHello), and immediately before
   raw `socket.write(requestBytes)`. The last transaction creates/updates the
   attempt record and is followed synchronously by one write of the prepared
   request bytes. SSE has one gate before response headers and, under the
   per-subscriber mutex, another immediately before each `ServerResponse.write`
   of an event frame. No `await`, encryption/decryption, secret read, config load,
   approval read, taint flush, resolver call, or callback is permitted between a
   gate and its byte-emitting call. Test-only hooks run *before* each final gate so
   disable/revoke races prove the gate, rather than creating an artificial gap
   after it.

### Await-to-write fence ledger (binding implementation checklist)

The following is deliberately more specific than a helper name. A helper may
factor code, but it must not weaken any listed re-read or move it outside the
transaction that writes the named state.

| Write after an await | Transactional re-check immediately before the write | Bite test(s) |
| --- | --- | --- |
| Persist a secret URL/key/token generation after secret-store I/O | Exact pending target/subscriber version still exists, is the same canonical digest, has not been revoked/superseded in the requested role, and the expected prior slot generation is still current; record an opaque reference only. | `secret-slot-race.test.ts`: rotate/revoke/version-replace while the fake store is paused; `target-documents.test.ts`: no slot/full URL in every result. |
| Create/queue/release/drop/manual-retry a delivery after approvals, config, cipher, taint or fence reads | The new queue insert still has a live projection/stage and exact rule/target/subscriber binding; for an existing row its id/state/version/lease is still the row read. In both cases switch enabled/generation matches; pause permits this transition; direct fresh core account exists and is unrevoked; exact lineage is live; deadline/attempt limit/barrier and cap conditions still hold. | `delivery-fences.test.ts` cases “each await”; `manual-retry.test.ts` cases “no mutation”; B1 projection-to-outbox regression cases remain green. |
| Start DNS, TCP/TLS, and request write after resolver/key/taint/config work | All preceding delivery checks, plus exact attempt/lease, URL-secret fingerprint, key generation, approved address set, target version, and reset barrier. DNS occurs only after its first gate; connect only after address-set revalidation; request bytes only after the final gate. | `pinned-webhook.test.ts` and `webhook-races.test.ts` pause each pre-I/O hook and disable/revoke/remove/expire/replace. |
| Record an HTTP outcome after request/TLS/response awaits | Delivery still has the exact id, `disclosing` state, lease token and attempt id; its rule/object versions, generation, account and retention deadline are still valid. If not, do not recreate or update the delivery/ciphertext. | `webhook-races.test.ts` “outcome after each terminal cause”; `lifecycle-webhook.test.ts`. |
| Create/update reset delivery/barrier after cipher/secret/config work | Exact target version remains retained and unrevoked, epoch and barrier state are the expected pair, direct account/rule authority is live, no newer barrier exists, and the new delivery id is still unique. | `reset-network.test.ts` races with target revoke, epoch replacement, account removal and expiry. |
| Append stream log / mark SSE delivery after decrypt/encrypt/taint/config reads | Exact leased delivery, switch generation, account, rule/target/subscriber versions, subscriber non-revocation, barrier, expiry, cap and log identity remain current; append and delivery transition share one transaction. | `sse-fences.test.ts` races each await; `sse-replay.test.ts` validates no orphan log. |
| Accept/rotate/close an SSE stream after secret comparison or socket setup | Exact subscriber/version and listener authority are live; token generation is active; rotation expected generation still matches. Rotation commits invalidation then closes registry sockets while holding the subscriber mutex. | `sse-auth-rotation.test.ts` pauses token read/handshake; old stream gets no post-rotation frame. |
| Replay a stored stream event after decrypt/config/fence reads | Stream-log row still exists and has not expired/purged; direct account/rule/subscriber authority and current token generation are live; the same connected stream is still registered. Under its mutex, repeat the generation check immediately before `write`. | `sse-replay.test.ts` races disable/pause/revoke/account removal/rotation at every frame. |
| Expire/purge/dead-letter after a lease/cleanup read | Exact current row and reason still match; never change a newer state or recreate encrypted content. | `retention-network.test.ts`, `webhook-races.test.ts`, and `reset-network.test.ts`. |

An HTTP request already issued cannot be recalled. If disable, revocation, target
purge, account removal, expiry, or a generation change wins while it is in flight,
the completion transaction must leave the terminal row selected by that winner
(`cancelled` or the applicable `in-flight-at-disable`/`in-flight-account-removal`)
untouched, must not schedule a retry or restore ciphertext, and may update only
the pre-existing content-free `work_attempts` row with an
`outcome-discarded-after-<reason>` marker plus safe status class. Operator output
reports `externalOutcome: "unrecalled; discarded"`, never a body, URL, key,
response text, or authority it no longer has. Pause does not recall an issued
request: a valid completion may be recorded, but no next claim occurs until
resume; a subsequently lost non-pause authority wins and discards the outcome.

### Spec amendments to raise with the owner

These are not blockers and do not change the B2 build choices above.

| ID | Lines | Ambiguity / contradiction | B2 plan resolution |
| --- | --- | --- | --- |
| B2-A | §4 lines 2824–2825; D2 lines 471–500 | B2 requires secret URLs and signing rotation, while B3 reserves the complete named terminal/app secret operations and exception rows. | Build opaque slots, rotation and internal tests in B2; expose no named secret command/tool until B3. Ask whether secret creation/rotation should be explicitly split into backing state (B2) and human operation (B3). |
| B2-B | §4 lines 2824–2825; D7 lines 1267–1295; D10 line 2011 | B2 says durable reset barriers/degraded resume; B3 assigns `target resume` the human-only surface. | Implement the durable recovery primitive and tests in B2, defer CLI/MCP `target resume` and its exception row to B3. Ask whether B2 should instead own that surface. |
| B2-C | §4 lines 2823–2824; D11 lines 2092–2148 | B2 names HTTP-only literal-loopback local judges, but no judge kind may be callable before E. | Ship a non-reachable validator/connector primitive and transport tests only; no judge target, scheduler branch, operation, command, or tool. Ask for phase wording that says “transport substrate”, not callable judge. |
| B2-D | D2 lines 260–267; D8 lines 1759–1761 | Target documents name delivery ordering/retry policy but do not define the public enum/default. | Use `per-rule-account-target`, default retry limit 20, range 1–20, because D8 supplies that ordering key and retry cap. Ask owner to normatively name these document values. |
| B2-E | D6 lines 1152–1157; D7 lines 1378–1395 | “Fixed listener authority” and “stream identity” have no persisted subscriber schema or port ownership rule. | Persist literal host/port authority in the subscriber version; require all active subscribers to agree. Ask owner to approve the exact document fields and multi-listener policy. |
| B2-F | D6 lines 1168–1174 | Signing-key overlap is “bounded” but no duration is specified. | Five minutes, aligned to consumer timestamp tolerance, with exactly two active generations. Ask owner to make duration normative. |
| B2-G | D7 lines 1340–1368 | “IANA globally reachable” has no snapshot/update source. | Checked-in reviewed policy snapshot, no runtime lookup/dependency. Ask owner to name the desired source/update cadence. |

## Batch map and safe parallelism

There are **six tasks in four batches**. Tasks 1 and 2 may run in separate
worktrees after copying this plan; they touch distinct network-test/substrate and
document/store files. After they land, Tasks 3 and 4 are deliberately serial: they
both establish delivery/retention terminal-state semantics. Task 5 follows their
merged state machine. Task 6 is the final integration, parity, generated-reference,
release-hold and full-suite task. Do not run concurrent edits in the shared
worktree.

| Batch | Tasks | Can run in parallel | Why / dependency |
| --- | --- | --- | --- |
| 1 — isolated safety substrate | 1, 2 | 1 and 2 in separate worktrees | Network primitives/seal and document/secret schema do not overlap. |
| 2 — disclosure state machine | 3, 4 | No | Webhook attempts establish the generic terminal semantics used by reset/retention. |
| 3 — streaming boundary | 5 | No | SSE uses the B2 schema, generic dispatcher, and lifecycle/expiry hooks. |
| 4 — integration gate | 6 | No | It validates all public surfaces and held-release evidence after every preceding batch. |

## Batch 1 — isolated safety substrate

### Task 1 — pinned loopback-only transport and hostile-network test harness **(high risk)**

**Files**

- Add `packages/events-daemon/src/network/address-policy.ts`,
  `packages/events-daemon/src/network/resolver.ts`,
  `packages/events-daemon/src/network/pinned-connection.ts`, and
  `packages/events-daemon/src/network/local-endpoint.ts`.
- Add `packages/events-daemon/test/network/address-policy.test.ts`,
  `packages/events-daemon/test/network/pinned-connection.test.ts`, and
  `packages/events-daemon/test/network/local-endpoint.test.ts`.
- Add `packages/events-daemon/test/support/loopback-receiver.ts` and
  `packages/events-daemon/test/support/test-tls.ts`; add
  `packages/events-daemon/test/support/sse-client.ts` as a loopback-only raw SSE
  client (it is used by Task 5).
- Update `test/helpers/loopback-seal.mjs`; add
  `test/helpers/loopback-seal.test.mjs` and update
  `test/events-daemon-e2e.test.mjs` to install the stricter seal before daemon
  import.

**Tests first**

1. Write table-driven policy tests for canonical literal parsing, CIDR membership,
   every answer required to match, IPv4-mapped/NAT64/6to4/Teredo handling,
   ambiguity rejection, private/default rejection, explicit-private acceptance,
   metadata/link-local unconditional rejection, and sorted non-empty address sets.
2. Write pinned-connection tests using an injected resolver and the fake receiver:
   successful HTTPS to loopback with an injected throwaway test CA; bad certificate;
   original-host SNI/certificate/Host preservation; one vetted address only;
   all-answer enforcement; no redirects; no proxy use; secret-fingerprint mismatch
   before resolver; literal-loopback HTTP acceptance; hostname-loopback, mapped
   literal, private HTTP, and non-loopback HTTP rejection. The fake receiver binds
   only `127.0.0.1`/`::1` and records byte-safe request metadata, never a real URL.
3. Write seal tests that an attempted non-loopback socket/TLS connection and every
   hostname/DNS lookup fail, including `dns.lookup`, `dns.promises.lookup`,
   resolver APIs, and `net.Socket.connect`; a literal loopback connection remains
   permitted. All tests use injected resolver answers, so no DNS lookup is a
   success path.
4. Write local-endpoint validator tests that only literal `127.0.0.1`/`::1` with a
   matching singleton approved set and HTTP are accepted; HTTPS, hostname,
   `localhost`, mapped spellings, proxy forms, and all non-loopback values reject.
   Assert the module has no operation/dispatcher import and no actual judge call.

**Implementation, in order**

1. Define a resolver interface returning canonical answer candidates and provide a
   production implementation only as an injected dependency; it never caches an
   answer across an attempt. Implement checked-in special-address policy and
   canonical CIDR/IP comparison before any socket construction.
2. Implement the raw pinned connector. It samples no proxy variables and exposes
   three explicit, synchronous-after-gate starts: `resolve`, TCP/TLS start, and
   request-byte write. It connects a vetted literal while retaining the original
   hostname for TLS verification/SNI and `Host`, with redirects impossible.
3. Build the in-process fake HTTP/HTTPS receiver and synthetic, throwaway test TLS
   material. The test certificate/key is non-production fixture material, exists
   only for loopback test setup, is never logged or committed as a credential, and
   is trusted solely through the client test seam. Build the raw SSE client without
   `EventSource`.
4. Strengthen the root seal to reject all hostname/DNS paths and every nonliteral,
   non-loopback connect. Keep it test-only; install it before imports in the E2E
   entrypoint so a future dependency cannot open a connection first.
5. Keep `local-endpoint.ts` a pure validator/connector substrate with no export
   reachable from daemon operations. Add a regression import-graph test for that
   negative guarantee.

**Required mutations**

- Change any approved answer, special-address decision, canonical hostname, or
  pinned literal: named address-policy/pinned-connection tests fail.
- Permit a redirect, read `HTTP_PROXY`, use a hostname in the HTTP exception, skip
  certificate verification, or connect before checking every answer: the pinned
  tests fail.
- Remove a patched resolver/socket path or allow a hostname lookup: the seal test
  and daemon E2E fail.
- Route the local-endpoint primitive through an operation: the negative import
  graph test fails.

**Run**

```sh
pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/network/address-policy.test.ts test/network/pinned-connection.test.ts test/network/local-endpoint.test.ts
node --test test/helpers/loopback-seal.test.mjs test/events-daemon-e2e.test.mjs
pnpm verify
```

Passing means all transport test traffic is provably literal loopback, no resolver
reaches DNS, and a release-mode connector cannot reach an unpinned address. Commit:
`feat(events): add pinned local network transport`.

### Task 2 — immutable B2 target/subscriber documents and independent secret slots **(high risk)**

**Files**

- Update `packages/events-daemon/src/domain/activation-documents.ts`,
  `packages/events-daemon/src/domain/versions.ts`,
  `packages/events-daemon/src/store/migrations.ts`,
  `packages/events-daemon/src/store/records.ts`,
  `packages/events-daemon/src/store/event-secret-store.ts`, and
  `packages/events-daemon/src/store/owner.ts`.
- Add `packages/events-daemon/src/domain/webhook-target.ts` and
  `packages/events-daemon/src/domain/sse-subscriber.ts`.
- Add/update `packages/events-daemon/test/domain/webhook-target.test.ts`,
  `packages/events-daemon/test/domain/sse-subscriber.test.ts`,
  `packages/events-daemon/test/store/network-migration.test.ts`, and
  `packages/events-daemon/test/store/secret-slot-race.test.ts`.

**Tests first**

1. Specify canonical plain and secret webhook documents: lower-case/IDNA host,
   explicit normalised port, exact encoded path/query, no fragment; plain rejects
   userinfo/query/fragment; secret output contains only scheme/host/port/SHA-256.
   Verify every byte URL change yields a new target version and that replacement
   does not mutate the old version. Scan all public serialisations, logs, preview
   values and thrown errors for a synthetic secret path/query/fingerprint input.
2. Specify canonical webhook retry/signing/address/ordering fields and canonical
   local-SSE subscriber identity, exact origins, listener authority, and embedded
   target-to-subscriber version binding. Assert stale/mismatched listener
   authorities and multiple active authorities refuse.
3. Test migration from a B1 fixture: B2 creates only B2 tables/columns—secret
   slots/generations, attempt metadata/dead-letter expiry, stream log and durable
   network reset fields—without rewriting B1 migration text. Verify all encrypted
   layouts have explicit AAD and secret-store reference reconciliation retains live
   current/overlap generations but collects retired ones.
4. With a pausable fake secret store, test create/rotate races against version
   replacement and revocation. The final write must refuse or write only the exact
   expected slot generation; it must never attach a secret to a changed version.

**Implementation, in order**

1. Add one append-only B2 migration (and exact AAD layouts) rather than altering
   B1 schema. Keep the complete secret URL/key/token only in encrypted independent
   secret-store entries; rows contain opaque internal references and no public
   document contains even the reference.
2. Add canonical immutable target/subscriber document types, including default
   retry limit 20 and fixed `per-rule-account-target` ordering. Update rule
   canonicalisation, version insert/read paths, preview/redaction functions and
   activation validation to bind exact target/subscriber versions.
3. Extend secret reference reconciliation so signing-key/token/URL generations
   participate in the same lock/retention deletion discipline as B1 master refs.
   Read/encrypt/decrypt outside a SQLite write transaction; after each await,
   start a fresh transaction and perform the exact slot/version/generation checks
   in the fence ledger before committing a reference.
4. Add B2-only internal factories for tests and later daemon control wiring. They
   accept synthetic opaque values but have no CLI/MCP entrypoint and no method that
   returns a complete secret.

**Required mutations**

- Make a target URL update in place, expose a slot/full secret, omit a canonical
  component, or accept a conflicting listener: the domain/redaction tests fail.
- Alter an AAD layout/table without its migration/reference update: migration and
  secret reconciliation tests fail.
- Remove the after-await version/generation re-read: `secret-slot-race.test.ts`
  fails.

**Run**

```sh
pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/domain/webhook-target.test.ts test/domain/sse-subscriber.test.ts test/store/network-migration.test.ts test/store/secret-slot-race.test.ts
pnpm verify
```

Passing means B1 stores migrate deterministically, every public representation is
safe to expose, and B2 secrets cannot be rebound by a race. Commit:
`feat(events): model versioned network targets and secret slots`.

**Batch 1 close.** After both worktrees are integrated, run `pnpm verify` once more
from the combined tree; passing means Task 1's seal/substrate and Task 2's migrated
store work together before any dispatcher can use either.

## Batch 2 — disclosure state machine

### Task 3 — fenced Standard Webhooks, delivery attempts, and manual retry **(highest risk)**

**Files**

- Update `packages/events-daemon/src/runtime/dispatcher.ts`,
  `packages/events-daemon/src/runtime/deliveries.ts`,
  `packages/events-daemon/src/runtime/decisions.ts`,
  `packages/events-daemon/src/runtime/disclosure-fence.ts`,
  `packages/events-daemon/src/runtime/scheduler.ts`,
  `packages/events-daemon/src/runtime/lifecycle.ts`, and
  `packages/events-daemon/src/store/owner.ts`.
- Add `packages/events-daemon/src/runtime/webhook-dispatcher.ts` and
  `packages/events-daemon/src/runtime/webhook-signing.ts`.
- Add `packages/events-daemon/src/operations/deliveries.ts`; update
  `packages/events-daemon/src/cli/program.ts`,
  `packages/events-daemon/src/mcp/server.ts`, `capabilities.json`, and generated
  `docs/reference/events-daemon-cli.md` / `docs/reference/events-daemon-mcp.md`.
- Add/update `packages/events-daemon/test/runtime/webhook-signing.test.ts`,
  `packages/events-daemon/test/runtime/webhook-dispatcher.test.ts`,
  `packages/events-daemon/test/runtime/webhook-races.test.ts`,
  `packages/events-daemon/test/runtime/manual-retry.test.ts`, and
  `packages/events-daemon/test/operations/deliveries.test.ts`.

**Tests first**

1. Characterise exact CloudEvent bytes, content type, stable delivery ID, attempt
   timestamp, HMAC input, single and dual Standard Webhook signatures, five-minute
   rotation overlap, and the injected-clock proof that retries keep ID/body but
   change timestamp/signature. Assert keys and response bodies never appear in
   result/error/log snapshots.
2. Test 2xx success, all non-2xx/network/TLS classifications, backoff/jitter,
   first-attempt-only cap charge, retry limits/deadline, dead lettering and
   retention. Assert no redirect request reaches the receiver.
3. For **each** await—approval read, direct `ConfigStore.load`, decrypt, encrypt,
   secret URL read, signing-key read, taint flush, resolution, TCP connect, TLS
   completion and response read—pause a test seam and race disable-all, pause,
   rule/target replacement, target revocation, account removal and expiry. At the
   DNS/connect/write seams additionally assert the actual fake receiver saw no
   request when the pre-I/O fence loses.
4. Race the response after a real loopback request has started. Assert terminal
   winner state/purge remains, payload is not restored, no retry is made, only the
   existing content-free attempt record says outcome discarded, and status output
   says `externalOutcome: "unrecalled; discarded"`. Assert pause permits an
   already-issued completion but blocks future claims.
5. Test every refusal path of `delivery retry`: non-webhook, non-retryable,
   attempt 20/target limit, expired, revoked/stale rule/target, removed account,
   disabled generation and closed barrier. Each must be byte-for-byte no mutation.
   Test success resets only `nextAt` on the same row.
6. Exercise CLI and MCP against the same operation doubles for `deliveries list`,
   `delivery retry`, and `delivery drop`; strict parity must see the same operation
   name, input/output/redaction/errors and no remote HTTP.

**Implementation, in order**

1. Refactor the B1 dry-run dispatcher behind a common delivery-claim interface
   without changing dry-run semantics. Persist a distinct attempt id/lease/start
   record and keep long-lived `work_attempts` content-free. Add webhook-specific
   state transitions, bounded scheduling and dead-letter deadline handling.
2. Implement signing from the exact persisted bytes with injected clock/random
   jitter. Read the secret outside a write transaction, then re-read the exact
   slot/generation in the final transaction. Retired overlap keys are never
   resurrected by an in-flight attempt.
3. Implement the three synchronous-after-gate outbound starts described above.
   At every gate, in one owner transaction re-read delivery id/state/lease/attempt,
   record identity, expiration, switch generation/enabled, pause, direct core
   account existence/revocation, rule and target version lineage, target
   revocation, URL fingerprint/secret generation, barrier, attempt/cap facts and
   approved addresses. The final request gate is immediately followed by raw
   `socket.write`; do not put telemetry, taint flushing or a promise between them.
4. After HTTP completes, start a new transaction and compare the exact lease,
   attempt and all current authority facts before success/retry/dead-letter writes.
   On a lost race follow the unrecalled-outcome rule above; never perform a
   compensating insert/update to recover a purged delivery.
5. Put `delivery retry` and `delivery drop` in one operations module used unchanged
   by CLI and MCP. `drop` uses the same lifecycle fence and only produces a safe
   terminal reason. Add capability rows and regenerate reference pages in this
   task, not as a later documentation clean-up.

**Required mutations**

- Reuse an HMAC/timestamp, charge a retry, alter bytes/ID, include an old key after
  overlap, or follow a redirect: signing/dispatcher tests fail.
- Remove any enumerated fence re-read or insert an `await` after a final gate:
  the named `webhook-races` subcase fails.
- Let an outcome recreate/mutate a terminal delivery or schedule retry: the
  unrecalled-outcome subcase fails.
- Make manual retry clone/remap/extend work or touch a refusal: `manual-retry`
  fails; change only one surface/capability row and parity fails.

**Run**

```sh
pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/runtime/webhook-signing.test.ts test/runtime/webhook-dispatcher.test.ts test/runtime/webhook-races.test.ts test/runtime/manual-retry.test.ts test/operations/deliveries.test.ts
pnpm verify:parity --strict
pnpm verify
```

Passing means a webhook can disclose only through an attempt fence, and neither a
response nor a convenience retry can outlive authority. Commit:
`feat(events): dispatch fenced standard webhooks`.

### Task 4 — network reset barriers, retention, and terminal cleanup **(high risk)**

**Files**

- Update `packages/events-daemon/src/runtime/reset.ts`,
  `packages/events-daemon/src/runtime/expiry.ts`,
  `packages/events-daemon/src/runtime/lifecycle.ts`,
  `packages/events-daemon/src/runtime/account-fence.ts`,
  `packages/events-daemon/src/runtime/replacements.ts`,
  `packages/events-daemon/src/runtime/revocations.ts`,
  `packages/events-daemon/src/runtime/scheduler.ts`, and
  `packages/events-daemon/src/store/owner.ts`.
- Add/update `packages/events-daemon/test/runtime/reset-network.test.ts`,
  `packages/events-daemon/test/runtime/retention-network.test.ts`, and
  `packages/events-daemon/test/runtime/lifecycle-webhook.test.ts`.

**Tests first**

1. Start from a B1 local reset and prove B2 creates a retained encrypted reset
   delivery and a closed durable barrier for each affected webhook target version;
   ordinary work cannot claim/cross it. A 2xx opens it; retry exhaustion, expiry or
   dead letter produces degraded state and remains durable across daemon restart.
2. Prove reset uses exactly 20 attempts/fixed 24 hours/no cap, has the reset
   canonical bytes/signing semantics, and cannot be silently replaced by ordinary
   target delivery. Test the internal recovery primitive creates a new reset
   delivery after all its rechecks, never revives an old delivery; assert no CLI/MCP
   capability exists for it in B2.
3. Race reset delivery/barrier creation and completion against target revocation,
   reset-epoch replacement, disable, account removal, purge and expiry. Verify the
   exact current barrier/epoch/target row is re-read inside the write transaction,
   and losing work leaves no reopened barrier or recreated ciphertext.
4. Test delivery-created expiry, dead-letter retention start, B2 stream/replay
   deadline inputs, retention tightening, target/rule/account/disable purges and
   the `in-flight-at-*` dispositions. Assert content is unrecoverable after purge
   and work-attempt summaries remain content-free.

**Implementation, in order**

1. Replace B1's network-agnostic notice-only reset path with a target-version
   barrier record plus an encrypted, signed reset delivery using the generic
   dispatcher. Retain B1 local behaviour where applicable; do not conflate an
   installed generation's reset epoch with a target version replacement.
2. Implement recovery as a private runtime method only. Before its post-await
   insert/update, re-read target retention/revocation, barrier epoch/state, live
   rule/account/switch authority and new delivery uniqueness in one transaction.
3. Extend expiry/lifecycle/account/revocation/replacement cleanup in lockstep.
   Cleanup must remove encrypted delivery/secret/stream material first, mark a
   disclosing network attempt with the stipulated in-flight terminal reason, and
   never let the completion path repopulate it. Apply tightened deadlines to every
   B2 record, not merely future queued deliveries.
4. Ensure scheduler recovery only sees current-generation, retained, unrevoked
   rows and treats a degraded barrier as a wait, not a retry bypass.

**Required mutations**

- Open a barrier before reset 2xx, let ordinary work cross a closed/degraded
  barrier, charge a reset cap, or revive an old reset: reset tests fail.
- Omit an epoch/target/account/revocation re-read after an await: a reset race
  fails.
- Leave a ciphertext/stream eligibility row after a purge or let a completion
  recreate it: lifecycle/retention tests fail.

**Run**

```sh
pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/runtime/reset-network.test.ts test/runtime/retention-network.test.ts test/runtime/lifecycle-webhook.test.ts
pnpm verify
```

Passing means reset ordering survives a crash and no cleanup race restores an
authorisation that was removed. Commit:
`feat(events): persist network reset barriers and retention`.

**Batch 2 close.** Run `pnpm verify` from the tree containing both Tasks 3 and 4;
passing means a reset uses the same attempt/lifecycle fences as ordinary webhooks.

## Batch 3 — streaming disclosure boundary

### Task 5 — authenticated, generation-bound local SSE **(highest risk)**

**Files**

- Add `packages/events-daemon/src/runtime/sse-server.ts`,
  `packages/events-daemon/src/runtime/sse-dispatcher.ts`, and
  `packages/events-daemon/src/runtime/stream-replay.ts`.
- Update `packages/events-daemon/src/runtime/dispatcher.ts`,
  `packages/events-daemon/src/runtime/disclosure-fence.ts`,
  `packages/events-daemon/src/runtime/scheduler.ts`,
  `packages/events-daemon/src/runtime/expiry.ts`,
  `packages/events-daemon/src/runtime/lifecycle.ts`,
  `packages/events-daemon/src/runtime/account-fence.ts`,
  `packages/events-daemon/src/runtime/replacements.ts`,
  `packages/events-daemon/src/runtime/revocations.ts`, and
  `packages/events-daemon/src/store/owner.ts`.
- Add `packages/events-daemon/src/operations/subscribers.ts`; update
  `packages/events-daemon/src/cli/program.ts`, `packages/events-daemon/src/mcp/server.ts`,
  `capabilities.json`, `docs/reference/events-daemon-cli.md`, and
  `docs/reference/events-daemon-mcp.md`.
- Add/update `packages/events-daemon/test/runtime/sse-auth-rotation.test.ts`,
  `packages/events-daemon/test/runtime/sse-cors.test.ts`,
  `packages/events-daemon/test/runtime/sse-fences.test.ts`,
  `packages/events-daemon/test/runtime/sse-replay.test.ts`, and
  `packages/events-daemon/test/operations/subscribers.test.ts`.

**Tests first**

1. Use only the Task 1 loopback SSE client to prove bearer-header authentication,
   exact route/Host, query/cookie rejection, no EventSource assumptions, exact
   origin matching, preflight header/method set, `Vary: Origin`, no credentials or
   wildcard, and no CORS reflection for an unlisted origin.
2. Test token generation rotation with concurrent old/new streams. Pause token
   lookup/handshake/rotation, then prove the rotation transaction invalidates old
   generation and closes its socket before the operation returns. The old stream
   receives no post-rotation header/frame; retained replay is still available to a
   correctly authenticated new stream.
3. Test scheduler append, log encryption, event ID/order, live frame and replay
   after `Last-Event-ID`, retention/deadline expiry, target/subscriber-version
   replacement, revocation and account removal purge. A replay test must race each
   decrypt/config/fence await and each frame with disable, pause, revoke, account
   removal and token rotation.
4. Assert append and delivery completion occur in one transaction after every
   listed recheck; no orphan log exists on a failed completion and no frame is
   written after its final generation/mutex check loses.
5. Exercise CLI/MCP subscriber list/add/update/remove through the same operation,
   including redaction, conflict/error values and strict parity. These operations
   manipulate only public subscriber descriptors; no secret token create/rotate
   operation appears in B2.

**Implementation, in order**

1. Start/stop one daemon-owned literal-loopback listener with the persisted fixed
   authority rule from Task 2. Parse HTTP manually enough to reject all routes,
   query/cookie auth and Host/CORS deviations before any stream registry entry is
   created. Do not add a public network-control listener.
2. Store bearer generations in independent secret slots. On accept, read/compare
   outside a DB write transaction; immediately before `writeHead`, acquire the
   subscriber mutex and re-read subscriber version, active token generation,
   switch/account/rule authority and registered stream identity. Release no header
   if that gate fails.
3. Append encrypted stream-log records from the generic dispatcher in the same
   transaction that marks its SSE delivery terminal. After every decrypt/encrypt,
   taint/config/approval read, re-read all delivery/switch/account/rule/target/
   subscriber/barrier/expiry/cap facts specified in the fence ledger.
4. For live and replay frames, fetch/decrypt outside a write transaction, then
   re-fence before each event. Hold the per-subscriber mutex, check the current
   token generation and stream membership once more, and call `response.write`
   synchronously next. On pause, stop new claims/frames; on disable/revocation/
   account removal, close/purge per D8/D9 and make all later writes fail their
   fence.
5. Add shared subscriber operations and both surfaces/capability/reference pages.
   Do not add secret operations, target resume, target test, or any judge surface.

**Required mutations**

- Accept a query/cookie/EventSource-style token, wildcard/reflected origin, wrong
  Host, or CORS credentials: SSE CORS/auth tests fail.
- Close streams after (rather than inside) rotation completion, skip the final
  mutex/generation check, or preserve logs after required purge: rotation/replay
  tests fail.
- Split log append from delivery transition or omit a post-await check: SSE fences
  tests fail; change only one public surface/capability row and strict parity fails.

**Run**

```sh
pnpm --filter @agentcomms/events-daemon exec node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/runtime/sse-auth-rotation.test.ts test/runtime/sse-cors.test.ts test/runtime/sse-fences.test.ts test/runtime/sse-replay.test.ts test/operations/subscribers.test.ts
pnpm verify:parity --strict
pnpm verify
```

Passing means a local stream is authenticated per generation, origin-exact, and
cannot receive a stale live/replay byte after authority is gone. Commit:
`feat(events): add fenced local SSE delivery`.

**Batch 3 close.** Run `pnpm verify`; passing means the SSE listener, replay store
and generic delivery/retention fences are validated together.

## Batch 4 — integration and held-release gate

### Task 6 — B2 end-to-end proof, parity inventory, documentation, and release hold

**Files**

- Update `capabilities.json`, `scripts/parity.mjs`,
  `test/events-daemon-e2e.test.mjs`, `test/helpers/loopback-seal.mjs`,
  `docs/reference/events-daemon-cli.md`, and `docs/reference/events-daemon-mcp.md`.
- Update `packages/events-daemon/README.md`, `docs/RELEASING.md` only if its held
  package inventory/reference needs an explicit B2 note, and `CHANGELOG.md` or add
  the PR's `No changelog: held, unreleased daemon/network capability` statement.
- Add `packages/events-daemon/test/runtime/no-judge-before-e.test.ts` and
  `packages/events-daemon/test/parity/b2-capabilities.test.ts` if the existing
  parity harness cannot express the negative B2 assertions.
- Do **not** edit either package's `agentcommsRelease.hold` field to lift it, and do
  **not** edit publish workflow/package lists to include either held package.

**Tests first**

1. Extend the sealed E2E flow to run plain HTTPS webhook, literal-loopback HTTP
   webhook, secret-descriptor redaction/fingerprint failure, attempt retry,
   disable/revoke/account-removal in-flight outcome, reset degradation/recovery
   primitive, SSE handshake/CORS/rotation/replay/purge, and no-judge-call proof.
   The only receivers are Task 1 in-process literal-loopback fakes; seal counters
   assert zero DNS and zero non-loopback attempts.
2. Make the parity inventory enumerate exactly B2-owned rows: expanded
   `targets add/update/remove` operation behaviour; `subscribers list/add/update/
   remove`; `deliveries list`; `delivery retry`; and `delivery drop`. Every row
   names its shared `packages/events-daemon/src/operations/...` function and runs
   CLI/MCP stand-ins. Assert secret create/rotate, target test/resume, replay,
   doctor and every judge operation are absent or explicitly deferred to B3/E.
3. Make `pnpm verify:parity --strict` fail for a missing operation row, an
   inconsistent operation name/schema, an ungenerated reference page, or an
   accidental B2 human-only exception. Add a release hold test/assertion that
   verifies both package holds remain and PUBLISHABLE/PACKAGES treatment does not
   make B2 publishable.

**Implementation, in order**

1. Update the strict parity stand-ins and capabilities rows only for the B2 public
   operations above. Keep all secret-bearing actions absent from `capabilities.json`
   until B3. Regenerate, do not hand-edit, reference pages with `pnpm sync:reference`.
2. Assemble one loopback-sealed E2E scenario per boundary; re-use fakes rather than
   adding fixture URLs, keys, mail addresses, credentials or real DNS. Ensure all
   test logs redact synthetic payloads too, so snapshot patterns catch regressions.
3. Add concise package/release documentation: both packages remain held, B2 changes
   no publish list, version tag, provenance action, or registry state. Note B1-F
   Node 22.16 floor and B1-G control boundary are still required.
4. Prepare the PR evidence (not a release): proposed version
   `X.Y.Z-events-b2`; focused plan/docs/code/tests; generated references; test
   results; `No changelog: held, unreleased local event daemon capability` unless
   release policy requires a line; provenance statement for the checked source and
   generated docs; and an explicit “no real data, addresses, tokens, keys, URLs or
   external traffic” attestation. Follow CONTRIBUTING's PR template: what changed
   for a person, implementation summary, `pnpm verify`, tests, docs/skills, and
   changelog disposition. The review sequence is normal focused PR review/required
   checks/merge; it is not a publish authorisation.

**Required mutations**

- Add a CLI tool without its shared operation/capability/reference, or diverge CLI
  and MCP: strict parity/B2 capability tests fail.
- Add a secret/target-resume/judge B2 surface: negative parity/no-judge tests fail.
- Remove loopback seal installation, permit DNS/non-loopback, lift a hold, or add a
  publish package: sealed E2E/release-hold test fails.

**Run**

```sh
pnpm sync:reference
pnpm test -- test/events-daemon-e2e.test.mjs
pnpm verify:parity --strict
pnpm verify
```

Passing means all exposed B2 commands/tools share their operation, all network
tests are sealed to loopback, generated docs match, and the held release state is
unchanged. Commit: `docs(events): document phase B2 held network delivery`.

**Batch 4 close.** Run `pnpm verify` one final time after generated references are
fresh; its pass is the only implementation-wide completion signal for this plan.

## §5 coverage ownership

Each B2-owned portion of §5 has one owner below. Existing B1 rows remain owned by
B1; B3/E rows (named secret operations, target test/resume, full doctor/dry-run
surface, migration command and callable judges) are intentionally not claimed.

| §5 row / B2-owned assertion | Sole task owner |
| --- | --- |
| Network rules: canonical URL forms, approved sets, pinned answers, no redirects/proxy, HTTPS and literal-loopback HTTP exception | Task 1 |
| Local endpoint judge transport validation is literal-loopback HTTP only and no judge is callable before E | Task 1 |
| Versioned target/subscriber documents, secret URL redaction/fingerprint, URL change creates a new version, secret generation storage/rotation backing | Task 2 |
| Webhook exact bytes/content type, Standard Webhooks per-attempt signing/rotation, caps, retry/backoff/dead letter, manual-retry fences, in-flight unrecalled outcome | Task 3 |
| Network reset delivery/barrier ordering, degraded durable state/recovery primitive, delivery/dead-letter/reset retention and reset/lifecycle purge fences | Task 4 |
| SSE bearer authentication, exact-origin CORS, generation rotation close, append/live/replay fences, replay retention and version-bound/revocation purge | Task 5 |
| CLI/MCP B2 parity rows, generated references, loopback-sealed E2E, held-release/PR evidence and absence of B3/E-only surfaces | Task 6 |

## Final verification and hand-off

After the final batch, inspect `git diff --check` and `git status --short` (do not
alter unrelated work), then run one fresh:

```sh
pnpm verify
```

Record its complete pass/fail result in the PR. A failure blocks the B2 claim; do
not hide it with a narrowed test command. No implementation commit, tag, publish,
email, Slack post, Resend request, DNS lookup, or non-loopback connection is
authorised by this plan.

The plan document itself should be committed with:

```text
docs(plan): local event emission — phase B2
```
