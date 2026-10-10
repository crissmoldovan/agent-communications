# Local event emission — Phase E implementation plan

**Goal.** Deliver disabled-by-default judge kinds, hosted TypeSafe Jev and literal-loopback local-endpoint judges, durable rolling budgets with crash settlement, holds, and an adversarial corpus. Phase E is not a build or release candidate until B3's full secret-completion/human-only surface and C's Judges/hold surfaces are present and pass the hard gate.

**Starting point.** This plan applies to feat/events-e at 556feb64, the converged B2 + Phase-D tree. It incorporates every binding decision in the B1, B2 and D decision tables: use the shared assertDisclosable fence; reuse B2's raw pinned connection and loopback seal; preserve D raw account/source identity and visibility gates; keep re-added accounts dark until re-approved; encrypt before final writes; and add the hold-created clock D deferred to E (D plan line 1600).

This is a plan, not implementation. Planning ran no provider/network/send/release command.

## Scope and sequencing

E implements typesafe and local-endpoint. Laya remains an enumerated, unavailable E2 seam: no worker, model, downloader, native dependency, or network path. E does not add a send path, source, temporary CLI/MCP surface, release, or package unhold.

Daemon-first work is deliberately unregistered foundation code. It has no Phase-E command/tool and cannot be packaged as completed E. Task 9 joins it to actual B3 operations and makes the prerequisite gate required by verify/release. This is the only way to build the independent daemon safety work first while honoring §4 line 2828's “refuses to build or ship” condition.

## Decisions the spec leaves to the plan

### E-1 — kind model and proof of off-by-default

Keep JUDGE_KINDS in packages/events-daemon/src/domain/lifecycle.ts as the only vocabulary. Add a closed JudgeKindDefinition registry in src/domain/judges.ts:

| Kind | E availability | Canonical enablement/executor |
| --- | --- | --- |
| typesafe | available | fixed HTTPS https://api.typesafe.ai/v1/systemone; Jev/Noul adapter |
| local-endpoint | available | literal-loopback URL and singleton approvedAddressSet; Noul or explicit JSON numeric extractor |
| laya | unavailable: E2_REQUIRED | registry slot only; E2 later installs its adapter |

The sole enabled fact is an active_versions row with kind judge-kind and object_id equal to the kind. The pointer names an immutable canonical document. A fresh database, import, update, and no pointer all mean disabled; there is no boolean cache or implicit default. assertJudgeKindEnabled reads it in the same immediate transaction as activation, reservation, and final network gate.

Enable creates the usual judge-kind activation/disclosure approval. Its document has no rule, account, budget, or judge version and grants no disclosure alone. Disable atomically removes only that pointer, retains immutable rule/judge versions, and invokes the shared purge participant. TypeSafe enablement makes no request. Laya enablement refuses with JUDGE_KIND_UNAVAILABLE before intent, approval, or download. E2 replaces only this unavailable registry definition.

Alternatives rejected: a settings boolean cannot bind an immutable disclosure approval; enabling when a rule names the kind violates separate-person approval; enabled-but-no-op Laya grants an effect that E cannot deliver.

### E-2 — canonical documents and judge trust boundary

Strengthen the open-ended JudgeDocument, budget, and kind documents into exact discriminated canonical forms. CanonicalFullRuleDocument gains optional sibling agentic: AgenticConditionV1 next to its existing deterministic condition; its agentic judge id/version must be exactly represented in judges, and it must have per-rule call/hour, input-token/30-day, and concurrency limits. This preserves the existing exported agentic type and requires the real deterministic prefilter. Deterministic-only rules require neither judge nor budget.

After deterministic match, JudgeCoordinator extracts only declared input pointers from the encrypted projection, serialises typed/sanitised values under a fixed versioned envelope, and taint-flushes before reserve. It sends no tools, target, event id, arbitrary headers, secret, model-selected URL, or capability. The hosted key is read from B3's secret slot only at the boundary and is never logged, returned, or stored in a decision.

JudgeTransport builds raw bytes and reuses B2 preparePinnedConnection, connectPinnedTcp, connectPinnedTls, requestBytesForPinnedConnection, all four synchronous final gates, B2's 20-second all-phases deadline and bounded parser. It must have no fetch, http(s).request, proxy, redirect, agent, or alternate socket path. TypeSafe host/path/TLS name are constants. local-endpoint calls validateLocalEndpoint then the same pinned path; it only permits literal HTTP 127.0.0.1 or ::1 with its one exact approved literal.

All answers are untrusted. Accept one provider-native finite JSON number in [0,1] only, derive match as p >= threshold, and ignore/reject any provider match, tool, URL or outcome. A malformed/oversized/timeout/unknown answer is fail-closed no-match with a closed reason. Persist provider/model/exact versions/template/threshold/value-label/reason only inside encrypted decision metadata. Use 64 KiB prompt/request and response caps pending owner ratification. Jev/Noul is labelled probability; generic JSON is uncalibrated-score.

Alternatives rejected: fetch bypasses B2 fences; plaintext prompt/response violates D8; accepting provider match is a confused deputy; one score label misstates generic JSON output.

### E-3 — held decisions and the hold-created clock

Retain the established nonterminal spelling outcome = hold. Add hold_created_at and content-free hold_resolution_claims instead of a transient decision outcome. At creation:

    holdExpiresAt = min(holdCreatedAt + holdMs, stagedAt + ingestMs)
    holdBoundBy = ingest-retention on a tie, otherwise the winning bound

A terminal or C resolver atomically takes a short lease keyed by decision/account/rule/version and random claim token. It decrypts/maps/encrypts outside the transaction, then rechecks the held row, token, deadline, projection, live account/list, exact versions, lineage, kind, switch and expiry while atomically writing the terminal decision/deliveries, deleting the claim, and purging projection. A second resolver sees busy/terminal. Recovery expires stale claims. Resolution uses the stored answer and never re-asks.

Expiry runs before source/control/replay/recovery. It beats a resolver at deadline, records hold-expired for hold-window or retention-expired for ingest-retention, deletes claim/projection/ciphertext, and creates no delivery. Tightening recomputes min(oldDeadline, createdAt + newHold, stagedAt + newIngest), never extends, and terminalises already-expired holds in the same transaction.

Alternatives rejected: resolution/evaluation time can retain data past D7's creation-bound; an in-memory mutex dies on restart; re-asking consumes new authority/budget and violates “retries never re-ask.”

### E-4 — reservations are the rolling durable ledger

Add judge_budget_reservations as the authoritative ledger: id, unique work id, account/source when applicable, stable rule id, exact rule/judge/budget versions, canonical provider id, global installation key, timestamps, one call, estimated/actual tokens, concurrency ownership, and closed reserved | in-flight | settled | released state. Add judge_test_charges(judge_id, judge_version, charged_at, work_id unique).

One immediate transaction reads the active singleton and counts nonreleased reservations/settled charges in the rolling windows by stable rule, provider, and installation key. It checks rule/global/provider limits and inserts reserved. Immediately before transport it repeats all authority/budget facts and changes only that row to in-flight. Settlement charges actual tokens if valid or estimate otherwise, frees concurrency in the same transaction, and creates the decision/hold. Pre-I/O loss releases; post-I/O unknown settles estimate. These are the only transitions.

Startup recovery and kind disable call the same idempotent helper: release reserved, settle in-flight once with estimate, free concurrency, and discard late answers. judge test uses that machine against global only plus one unrefundable exact-version ten-per-hour charge; it has no invented rule/provider limit. New rule/singleton versions never reset stable-key usage.

Alternatives rejected: aggregates cannot survive a crash between I/O/accounting; charge-after-response allows unlimited in-flight calls; version keys reset caps after edits.

### E-5 — all purges use one closure

JudgeWorkPurgeParticipant is registered with kind disable, judge revoke/remove, rule disable/remove/revocation/tightening, disable-all, account removal, WhatsApp visibility hide, projection/ingest expiry, hold expiry, and retention shortening. Within the caller's immediate transaction, scoped by raw account/source plus exact ids, it cancels held/judging work, removes claims/projections/ciphertext, releases reserved rows, settles in-flight rows, and cancels/purges resulting deliveries/dry-run/SSE. Supersession alone never purges. A late completion never restores work.

Alternatives rejected: hand-written cleanup repeats D's orphan bug; delete by judgeId alone crosses account/source scope.

### E-6 — adversarial corpus

Add packages/events-daemon/test/fixtures/judges/adversarial-v1.jsonl and a schema/sha256 manifest. Each synthetic row names rule/input pointers, scripted loopback/injected bytes, and expected real-production result. Cover injection/envelope forgery, control Unicode, oversize/truncated/multiple JSON, wrong/NaN/infinite/range scores, provider match/tools, hostile reason text, redirects/userinfo/host drift, DNS rebinding, disable/revoke/budget races, and response after hold/expiry.

The runner invokes EventEvaluator, JudgeCoordinator and real JudgeTransport through injected resolver/socket or loopback receiver under test/helpers/loopback-seal-preload.mjs. It does not use test-local decision/budget models. Passing means bounded fail-closed outcome, expected durable reservation/decision effect, and no unapproved byte/operation/secret. Fixtures use TEST_CLOUD_EVENT and example.test only; never user/provider data. E2's labelled quality corpus stays out of this repository.

Alternatives rejected: prose red-team lists do not regress-fail; real prompts/corpora violate data rules and collide with E2 quality-gate design.

### E-7 — exact B3 and C prerequisites

E consumes or verifies these B3 surfaces:

| E behavior | B3 operation/surface |
| --- | --- |
| immutable judge versions | judges list; judge add, update, remove |
| controlled call | judge test |
| singleton | budget show, update |
| kind state | judge kinds list; judge kind enable, disable |
| E2 seam | judge model status, remove |
| hold read/decision | held list; terminal/app-only held decide |
| observability | doctor kind/hold/budget/reservation/missing-key fields |
| hosted secret | terminal/secrets-window-only judge key set, rotate |

The hard gate requires the complete D2 exception set, not only judge keys: target secret create/rotate, target url set, subscriber token create/rotate, judge key set/rotate, and secrets migrate; it also verifies exception rows for approve, dryrun list/show, rule test-retained, pending target/judge test, target resume, and held decide. Each has status exception, stated reason, terminal operation/TTY-agent gate where applicable, no MCP tool/schema/text/structured content, and one capabilities row. Non-exception judge operations have CLI/MCP rows naming one shared operation.

C must provide: Overview and Deliveries safely list/resolve held decisions; Judges lists three kinds off by default, opens typed D2 approval for enable, applies immediate disable, shows hosted/local facts, and opens the secrets window for hosted keys; typed app approval calls the same daemon activation protocol. E owns daemon DTO vectors, not an app-side judge/secret/hold implementation.

Alternatives rejected: a temporary E CLI forks B3 parity; a generic installed marker cannot prove no secret enters MCP; blocking foundation work on C defeats the requested safety ordering.

## Spec amendments to raise with the owner

| ID | Lines | Ambiguity / resolution needed |
| --- | ---: | --- |
| E-A | 1049-1052 | Agentic record has no canonical full-rule field. Plan uses optional sibling agentic; ratify exact persisted shape/multiplicity. |
| E-B | 1058-1071, 2096-2101 | Exact TypeSafe JSON fields, local generic extractor grammar, sizes and timeout absent. Plan fixes adapter/pointer and 64 KiB/20 s limits; ratify wire vectors. |
| E-C | 1065-1068 | Local endpoint does not state Noul versus generic JSON. Plan requires either protocol noul or protocol json-score plus a score pointer; ratify. |
| E-D | 1072-1102, 1549-1552 | Exact budgetId, provider canonicalisation, and whether reserved work counts in rolling windows absent. Plan uses judge-budget, canonical provider and counts nonreleased reservations; ratify. |
| E-E | 1235-1243, 1531-1533 | Hold-created timestamp/resolver concurrency omitted. Plan adds clock and leased claim table; D plan line 1600 assigns this to E. |
| E-F | 2828 | “refuses to build or ship” conflicts with daemon-first work while B3 is absent. Plan permits unregistered foundation only then gates registered E verify/release; owner should state if all repository build must fail sooner. |
| E-G | 2828 | Adversarial corpus has no location/schema/pass criterion. Plan supplies synthetic executable JSONL/manifest; ratify governance. |
| E-H | 2092-2125, 2828-2829 | D11 describes Laya enablement while E defers Laya. Plan shows unavailable and refuses before approval; confirm interim UX. |

## Automatic defenses for recurring defect classes

### Write-after-await ledger

Every new await/write pair is registered in packages/events-daemon/test/judge-races.test.ts and Task 3's manifest. The test pauses the real production seam, changes the named fact via production operation, resumes, and proves no stale write/disclosure.

| Await then write | Final immediate re-check | Named case |
| --- | --- | --- |
| activation prepare/approval/claim → kind pointer | intent kind/digest, core used binding, exact version, pointer drift, availability | E4 activation prepare-claim-finalise fences |
| B3 secret-store I/O → key completion/request | exact judge id/version/digest/slot/current generation and human origin | E9 B3 secret completion fence |
| decrypt/evaluate → reserve | projection/event/account/rule/deadline, enabled/paused, lineage, account, kind/budget pointer, unique work | E7 reservation after decrypt race |
| taint flush → reserve | all preceding facts plus successful event taint | E7 taint-before-reserve race |
| endpoint/key/config/approval read → in-flight | exact reserved row, all versions/ceilings/account/switch | E6 pre-I/O reservation fence |
| DNS/TCP/TLS/raw write | B2 final gate repeats lease/reservation/lineage/account/kind/budget/secret/address digest; no await before named I/O | E6 DNS/TCP/TLS/write fences |
| response/parser → settlement | exact in-flight token/projection/authority/expiry; loss discards | E7 settlement after disable race |
| hold decrypt/map/encrypt → resolution | hold/token/deadline/projection/account/list/version/lineage/kind/switch | E8 held resolution stale lease race |
| recovery/config load → cleanup | exact nonterminal row/state/lease/scope | E5 recovery/expiry idempotence |
| purge preparation await → purge | raw account/source, versions, visibility/generation, intended row | E8 purge after async preparation race |

### Identity and scope

JudgeWorkScope is accountId, source, eventId?, ruleId?, ruleVersion?, judgeId?, judgeVersion?, decisionId?, reservationId?. SQL mutation helpers accept it, bind account/source for source-owned work, and return affected counts callers assert. Aliases resolve once then match stable row id. Provider id comes only from canonical judge document. All modules import JUDGE_KINDS from lifecycle.

judge-scope.test.ts uses two accounts/sources, same-looking ids, re-add, and stale alias. scripts/verify-events-phase-e-tests.mjs rejects unscoped judge SQL helper use and duplicate kind literals. Removing an account/source predicate must fail E3 scope isolation.

### Purge closure

judge-purge-closure.test.ts seeds held/reserved/in-flight/queued/retryable/dry-run/SSE work through production paths for every registered purge caller, restarts, and proves exact terminal state, ciphertext/claim purge, release/settlement, and no resurrection. The registry test fails when a lifecycle operation that can purge ingest_rules omits the participant.

### Tests that bite

Every named test runs a real EventEvaluator, JudgeCoordinator, JudgeTransport, activation/lifecycle or hold operation against SQLite. Fakes are only clock/config/approval/resolver/socket/loopback receiver. test/support/judge-mutants.ts maps exactly one source mutation to one named test. The runner copies production source, applies that one edit, and runs only the exact name pattern. The manifest maps every §5 row, await row and corpus case to one named test/mutation. The structural verifier fails for orphan cases/mutations, duplicate ownership, network test without preload, test-local system model, or skipped mutation.

## Batches, dependencies, and safe parallelism

There are 13 implementation tasks in 7 batches. Every batch ends with full pnpm verify; focused tests alone never accept a batch.

| Batch | Tasks | Parallel group / join |
| --- | --- | --- |
| 1 — contracts | 1, 2, 3 | 1 and 3 may start separately; 2 follows document names from 1. Rebase 2/3 on 1. |
| 2 — authority/transport | 4, 5, 6 | 4 and 6 parallel after Batch 1; 5 follows Task 2 and cannot share a migration edit with 4. One owner integrates migrations. |
| 3 — decisions | 7 → 8 | serial: they share hold/decision semantics. |
| 4 — joins/corpus | 9, 10, 11 | 9 waits for B3, 10 for C, 11 runs after 7 in parallel. No B3/C shims. |
| 5 — proof | 12 | serial audit of all prior paths. |
| 6 — handoff | 13 | serial final gate. |
| 7 — review | split reviewers | parallel reviewers, isolated review worktrees, then P1 fixes. |

Do not copy generated references/migrations between worktrees. Rebase, run named tests, then full verify. Tests use synthetic data, injected fakes and sealed loopback only.

## Batch 1 — contracts

### Task 1 — canonical agentic/judge/budget/kind documents (high risk)

**Files.** Modify packages/events-daemon/src/domain/activation-documents.ts, domain/versions.ts, domain/lifecycle.ts; packages/events/src/conditions/types.ts, agentic.ts, index.ts. Add packages/events-daemon/src/domain/judges.ts. Modify test/activation-documents.test.ts and version-lifecycle.test.ts; add test/judge-documents.test.ts.

**Tests first, then implementation.**

1. Add failing vectors for sibling agentic, exact bound judge, content-field deterministic prefilter, strict kind documents, singleton budget, and all kinds unavailable; include malformed provider/model/protocol/address fields, unmatched binding, rule global/provider field, and Laya unavailable.
2. Implement discriminated canonical forms without importing daemon/I/O into events.
3. Make VersionStore prepareRule/prepareJudge/prepareBudget/prepareJudgeKind enforce the forms and reject disabled kinds at prepare, claim and finalisation.
4. Add digest mutation vectors for every field and import, never duplicate, the kind vocabulary.

**Commands.**

    pnpm --filter @agentcomms/events test -- conditions
    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E1|agentic|judge document'
    pnpm verify

**Passing / mutations.** Vectors round-trip byte-for-byte; deterministic rules still work while disabled kinds cannot become effective. Removing prefilter, permitting foreign judge, default-enabling a kind, or deleting canonical field fails its named vector.

**P1-only review.** Document/digest permissiveness, duplicate vocabulary, and any deterministic canonicalisation change.

**Commit.** feat(events): canonicalise phase E judge authority documents

### Task 2 — durable schema and migration shapes (high risk)

**Files.** Modify packages/events-daemon/src/store/schema-v1.ts, migrations.ts, records.ts; add migration fixtures, test/judge-migrations.test.ts; extend test/migrations.test.ts.

**Tests first, then implementation.**

1. Start from every B1/B2/D fixture and fresh v1; add failing checks for hold_created_at, hold_resolution_claims, judge_budget_reservations, judge_test_charges, unique keys, state checks, rolling/scope indexes and valid current-schema foreign keys.
2. Add one forward migration at the next free integrated number; never edit a recorded migration. Update fresh schema and preserve old encrypted bytes.
3. Add foreign_key_check, reopen/idempotence, secure-delete, and plaintext request/response scan assertions.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='migration|E2'
    pnpm verify

**Passing / mutations.** Fresh/upgraded schema agrees; invalid state, unscoped duplicate or old fixture regression fails. Remove clock, work-id uniqueness, state check or scope index and the named case fails.

**P1-only review.** Forward-only ordering, SQL checks/index scope, preserved ciphertext and no migration renumbering.

**Commit.** feat(events): add durable judge and hold records

### Task 3 — test manifest, mutation runner and static guards

**Files.** Add packages/events-daemon/test/judge-mutations.test.ts, judge-scope.test.ts, test/support/judge-mutants.ts, test/fixtures/judges/case-manifest.json, scripts/verify-events-phase-e-tests.mjs; modify root package.json only to invoke the completed verifier.

**Tests first, then implementation.**

1. Add failing self-tests for an orphan named case/mutation, unowned §5 row, missing loopback preload, duplicate kind literal, and test-local implementation substitute.
2. Implement the D-style copy-one-production-file mutation runner; it runs only the mapped name pattern.
3. Register Tasks 1–2 rows. Every later task adds its rows in the same commit.

**Commands.**

    node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e-tests.mjs
    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E3|mutation|scope'
    pnpm verify

**Passing / mutations.** The verifier fails in a temporary mutant copy and passes only with total one-owner metadata. Delete a mapping or account/source predicate; its named verifier/scope case fails.

**P1-only review.** Real-module execution, one-to-one mapping, no silent skip.

**Commit.** test(events): enforce phase E mutation and scope coverage

**Batch 1 end.** Rebase integrations and run pnpm verify. Record result in the implementation PR.

## Batch 2 — authority and transport

### Task 4 — kind activation, immediate disable and purge closure (high risk)

**Files.** Add src/runtime/judge-kinds.ts and judge-purge.ts. Modify runtime/activations.ts, disclosure-fence.ts, lifecycle.ts, revocations.ts, account-fence.ts, whatsapp-visibility.ts, expiry.ts, replacements.ts, owner.ts and domain/versions.ts. Add test/judge-kind-enablements.test.ts and judge-purge-closure.test.ts.

**Tests first, then implementation.**

1. Prove new/install/update/import all have three absent pointers; deterministic-only rules activate. Prove prepare/claim/finalise each refuse JUDGE_KIND_DISABLED when disable races between them.
2. Implement judge-kind effect/final fence; fixed TypeSafe/no-request; Laya refusal before approval.
3. Implement the participant inside caller transactions, scoped by raw account/source.
4. Seed held/reserved/in-flight/delivery/dry-run/SSE rows. Prove immediate no-approval disable purges/settles, late result discards, rules/judges remain unrevoked, and re-enable restores only listed work.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E4|judge kind|purge closure'
    pnpm verify

**Passing / mutations.** No implicit enablement or post-disable reservation/byte boundary; every purge path invokes one participant. Default pointer, omit claim/final check, skip in-flight settlement, remove account scope, or unregister path; named E4/E5 case fails.

**P1-only review.** Activation binding, pointer absence, all callers, post-await rechecks.

**Commit.** feat(events): enforce judge kind enablement and purge closure

### Task 5 — rolling budgets and crash recovery (high risk)

**Files.** Add src/runtime/judge-budget.ts and judge-recovery.ts. Modify runtime/owner.ts, lifecycle.ts, expiry.ts. Add test/judge-budgets.test.ts, judge-crash-recovery.test.ts and fixtures.

**Tests first, then implementation.**

1. Add injected-clock edges for rule/provider/global call/hour, token/30-day and concurrency; prove stable ids survive rule/singleton replacement.
2. Implement singleton validation, conditional reserve/release/in-flight/settle SQL and test-charge cap.
3. Inject crashes after reserve, before/after transport, before/after settlement. Restart through real owner/recovery and prove release or one pessimistic settlement/free slot/no double charge.
4. Prove exhausted/no-singleton refusal reaches no injected transport.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E5|budget|reservation|crash'
    pnpm verify

**Passing / mutations.** Only legal state paths occur and recovery is idempotent. Exclude reserved work, key by version, refund unknown transport, double-settle, or omit concurrency release; named case fails.

**P1-only review.** Window predicates, conditional transitions, recovery idempotence, awaited writes.

**Commit.** feat(events): reserve and recover durable judge budgets

### Task 6 — sealed hosted/local transports (high risk)

**Files.** Add src/runtime/judge-transport.ts and judge-adapters.ts. Only minimally extend src/network/pinned-connection.ts and local-endpoint.ts for common bounded response helpers. Add test/judge-transport.test.ts, judge-network-fences.test.ts and loopback fixtures.

**Tests first, then implementation.**

1. Add sealed tests for fixed TypeSafe bytes, literal local URL, address drift/rebinding, TLS/SNI, no redirect/proxy, deadline/stall/oversize and refusal before TCP.
2. Reuse B2 resolver/TCP/TLS/request primitives/four gates; hooks run before each gate; no HTTP client import.
3. Add parser vectors for Noul, generic pointer, wrong type, NaN/Infinity/range, provider match/tools and hostile reason.
4. Return data only; Task 7 owns settle/decision.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E6|judge transport|local endpoint'
    pnpm verify

**Passing / mutations.** Every transport is injected/loopback sealed; each gate blocks next I/O; only validated number reaches coordinator. Replace final gate with cache, use fetch, allow hostname loopback/redirect, accept match, clamp score, or remove cap; named test fails.

**P1-only review.** Network imports, gate-to-I/O adjacency, parser bounds, no secret observation.

**Commit.** feat(events): add sealed hosted and local judge transports

**Batch 2 end.** One owner integrates migrations, reruns E4–E6 and pnpm verify. Confirm no test can contact a real host.

## Batch 3 — decision and retention

### Task 7 — deterministic-first coordinator and atomic decisions (high risk)

**Files.** Add src/runtime/judge-coordinator.ts. Modify runtime/evaluate.ts, decisions.ts, mapping.ts, untrusted.ts and relevant record types. Add test/judge-evaluation.test.ts and judge-taint.test.ts.

**Tests first, then implementation.**

1. Real-path cases: deterministic false has no taint/reservation/network; true extracts exact inputs; match/no-match/uncertain/no-match/hold; timeout/malformed/exhausted no-match; retry never re-asks.
2. EventEvaluator evaluates deterministic condition first, then coordinator extracts projection inputs, taint-flushes, reserves, moves in-flight before transport, settles, and calls one decision/hold commit helper.
3. Extend commitDecisionOutbox; final transaction rechecks projection, exact versions/pointers/lineage, pause/switch/account/visibility and reservation token.
4. Store only encrypted metadata; create deliveries only for derived match.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E7|judge evaluation|taint'
    pnpm verify

**Passing / mutations.** Judge is never called before valid prefilter/taint/reserve; each path has one terminal decision or safely retained retry. Move taint after reserve/I/O, skip prefilter, create delivery for malformed, settle without token, or re-ask; named E7 test fails.

**P1-only review.** Authority order, input minimisation, single decision owner and final checks.

**Commit.** feat(events): evaluate agentic rules through durable judges

### Task 8 — holds, expiry, tightening and resolver safety (high risk)

**Files.** Add src/runtime/holds.ts. Modify runtime/decisions.ts, expiry.ts, replacements.ts, account-fence.ts, whatsapp-visibility.ts, lifecycle.ts and B3-facing contract types if present. Add test/judge-holds.test.ts, judge-hold-retention.test.ts, judge-races.test.ts.

**Tests first, then implementation.**

1. Test threshold 0/1/band edges, hold deadline/tie, start-up expiry before control, tightening, late resolution, competing terminal/app resolvers, and crash edges around claim/decision/delivery.
2. Implement clock, lease claims/recovery and fenced resolution; use normal mapping/delivery encryption-before-write path.
3. Make expiry/purge delete claims and terminalise content-free, including D account/list visibility paths.
4. Register all new guards/writes/mutations in Task 3 manifest.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E8|hold|hold retention|race'
    pnpm verify

**Passing / mutations.** A hold cannot outlive ingest, resolve twice, resurrect after purge, or create delivery after expiry/disable/revoke. Use evaluation time, reverse tie, omit claim-token, allow late resolution, or omit purge hook; named case fails.

**P1-only review.** Time arithmetic, lease recovery, existing B1 atomicity, D scope/visibility propagation.

**Commit.** feat(events): retain and resolve bounded judge holds

**Batch 3 end.** Run pnpm verify and inspect DB/WAL/free-page scans: prompt/response/source text exists only encrypted.

## Batch 4 — B3/C joins and adversarial corpus

### Task 9 — B3 operation join and hard prerequisite gate (blocked until B3; high risk)

**Files.** After rebase on B3, modify B3-owned packages/events-daemon/src/operations/judges.ts, deliveries.ts, doctor.ts, CLI/MCP registrations, capabilities.json and generated sources; add scripts/verify-events-phase-e-prerequisites.mjs, test/judge-b3-prerequisites.test.ts, judge-operation-parity.test.ts, judge-test-operation.test.ts.

**Tests first, then implementation.**

1. Encode E-7 inventory; temporary copies missing each secret row/human guard, adding MCP registration, mismatching operation, or omitting held exception must fail.
2. Route judge/budget/kind/test/held/doctor through Tasks 4–8 shared operations. MCP kind enable prepares only; secret operations use B3 event secret store and stay terminal/secrets-window only.
3. Implement judge test restrictions: fixed io.agentcomms.test.v1, no caller content/field override, active or specified pending-rule human exception, ordinary taint/reservation, ten/hour exact version charge and global-only budget; unapproved call has zero network.
4. Add prerequisite script to required pnpm verify and package/release verification only after B3 real rows exist. Missing/stubbed B3 surfaces must fail build/ship, never warn. Generate references; do not edit them by hand.

**Commands.**

    pnpm verify:parity --strict
    node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e-prerequisites.mjs
    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E9|judge test|capability'
    pnpm verify

**Passing / mutations.** Correct parity/exception behavior; deliberately removed B3 completion fails required verify. Stub judge key rotate, expose secret in MCP, let MCP claim kind/resolve hold, accept caller content, or detach capability operation; named E9 test fails.

**P1-only review.** CLI/MCP operation identity, no-MCP-secret proof, human guards, reference generation and failure path.

**Commit.** feat(events): gate judge surfaces on B3 human-only completion

### Task 10 — C contract/acceptance join (blocked until C)

**Files.** Add packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json and test/judge-desktop-contract.test.ts. After rebase on C, modify its landed apps/desktop protocol DTO/tests; modify operations/doctor.ts/control response types only as required.

**Tests first, then implementation.**

1. Freeze DTO vectors for disabled/pending/enabled/E2_REQUIRED kind state; safely represented held data; typed hold decision errors/results.
2. C Overview/Deliveries use safe rendering and same daemon hold operation as terminal. Judges starts all three off, enables by typed approval, disables immediately, shows hosted/local facts and opens secrets window for keys.
3. Test app challenge/digest re-plan and denial of every secret command from non-secrets windows. No app-side judge/budget/secret/hold implementation.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E10|desktop contract'
    pnpm --filter @agentcomms/desktop test
    pnpm verify

**Passing / mutations.** App/daemon DTOs agree; kinds begin off and hold/key actions cannot escape human-only windows. Mark kind enabled, render webview preview, expose secret command, or bypass daemon hold operation; exact C/daemon case fails.

**P1-only review.** Protocol ownership, untrusted rendering, approval identity and secret-window boundary.

**Commit.** test(events): prove phase E desktop judge contracts

### Task 11 — executable adversarial corpus

**Files.** Add test/fixtures/judges/adversarial-v1.jsonl and adversarial-v1.manifest.json, test/judge-adversarial-corpus.test.ts, judge-corpus-integrity.test.ts, test/support/judge-adversarial-fixture.ts; extend manifest.

**Tests first, then implementation.**

1. Add failing manifest/hash/schema check and synthetic category rows from E-6.
2. Run each through real evaluator/coordinator/adapter plus loopback/injected endpoint; assert decision/reservation/taint/request journal, not a fixture model.
3. Scan corpus for secret-looking material, real domains, provider captures, unknown schema, unpaired case, or unsealed network attempt.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E11|adversarial corpus'
    pnpm verify

**Passing / mutations.** Every row crosses the actual trust boundary and reaches its bounded outcome. Treat provider match as authority, remove envelope, bypass range check, or delete manifest row; named corpus/integrity case fails.

**P1-only review.** Fixture provenance, real production path, no real data/host, expectation coverage.

**Commit.** test(events): add adversarial judge corpus

**Batch 4 end.** Task 11 may finish while B3/C wait. Tasks 9/10 cannot be waived; E remains incomplete/unshippable until both land and pnpm verify passes.

## Batch 5 — cross-cutting proof

### Task 12 — exhaustive race, scope, purge and mutation audit (highest risk)

**Files.** Modify test/judge-races.test.ts, judge-scope.test.ts, judge-purge-closure.test.ts, judge-mutations.test.ts, test/support/judge-mutants.ts, manifest and scripts/verify-events-phase-e-tests.mjs. Repair production only where the matrix finds a true gap.

**Tests first, then implementation.**

1. Enumerate every Tasks 4–11 await/write, external identity, alias, purge caller, §5/corpus case; fail on omission.
2. Pause every real seam; race disable, budget swap, revoke, account remove/re-add, WhatsApp hide, expiry, approval/secret drift and competing resolver; resume and assert no stale write/network.
3. Run each mutation isolated against exactly its named production operation; reject test-local ledger/model.
4. Statically reject fetch/http.request/https.request and duplicate kind vocabulary in judge paths; require loopback preload for judge network tests.

**Commands.**

    node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e-tests.mjs
    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E12|judge race|scope|purge|mutation'
    pnpm verify

**Passing / mutations.** Every ledger/matrix row has one owner/mutation and every mutant fails its one real-path test. The suite itself is the mutation requirement; deleting a required mapping must fail structural verification.

**P1-only review.** Matrix completeness, mutant isolation/name targeting, no test-local behavior.

**Commit.** test(events): exhaustively fence phase E judge races

**Batch 5 end.** pnpm verify plus mutation/network-journal inspection. Any skipped mutation, orphan purge path or unsealed test is P1.

## Batch 6 — final gate and handoff

### Task 13 — final E2E, release hold and PR evidence

**Files.** Modify operations/doctor.ts and tests, README/reference/skill generators as needed, held-release tests if necessary, and this plan only for discovered links. Do not remove agentcommsRelease.hold from packages/events or packages/events-daemon.

**Tests first, then implementation.**

1. Add active rule → prefilter → taint → budget → sealed judge → match/no-match/hold → delivery/purge/restart E2E cases. Doctor reports kind pointer, budget/reservations, holds, missing key, Laya unavailable.
2. In a temporary checkout remove/stub B3 rows and prove required verify/release fails; test positive integrated B3+C tree.
3. Regenerate/check references, strict parity, browser/package/held-release/docs/skills. Confirm no Laya native dependency.
4. Prepare CONTRIBUTING evidence: user-visible change/how; proposed 0.16.0-events-e (a minor prerelease from the present 0.15.2 because it adds the held daemon's first usable judge capability; recompute if target main moves); focused/full test results; docs; changelog line or “No changelog: Phase E only extends the held local event daemon and @agentcomms/events”; provenance of specs read 2026-10-10, B1/B2/D decisions, no live testing, AI assistance; no real data. No tag/publish/unhold.

**Commands.**

    pnpm verify:parity --strict
    pnpm verify:browser
    pnpm verify:packages
    pnpm verify
    git diff --check
    git status --short

**Passing / mutations.** B3/C gates green, both packages held, no real data. Remove verify gate, one B3 row, hold clock doctor field, or package hold; named final/hold test fails.

**P1-only review.** Build/ship refusal, parity, generated docs, holds, provenance, no Laya/send/network regressions.

**Commit.** None — final verification and PR handoff only.

## §5 coverage ownership

E2-only Laya runtime/download/quality clauses are excluded. Every E-owned §5 clause has one owner.

| §5 row / clause | Owner |
| --- | --- |
| Conditions/local tests: judge-test synthetic/taint/no unapproved network | Task 9 |
| Judges/budgets: boundaries, labels, prefilter, versions, rolling limits/inheritance/crash, malformed values, judge-test charge | Task 5 |
| Judge kinds: all-off, activation fences, disable purge/late result, TypeSafe enable no request | Task 4 |
| Digest/approvals: kind/budget vectors and wrong-kind/drift claims | Task 4 |
| Ingest recovery: judge response/hold decision crash outcomes | Task 7 |
| Retention/tightening clauses for holds/content-free expiry | Task 8 |
| Network local-judge literal/rebinding/userinfo/redirect/injected transport | Task 6 |
| Control/storage/app held decisions, kind state and secret-window/app contract | Task 10 |
| Parity/phases/packaging judge rows, MCP prepare-only enable, deliberate B3-stub failure | Task 9 |
| §4 adversarial corpus deliverable | Task 11 |
| Tests-bite, mutation pairing, scope, await fence and purge closure | Task 12 |
| Final held-package/docs/doctor/PR evidence | Task 13 |

## Spec traceability

| Normative section and lines | Task | Named proof |
| --- | --- | --- |
| D1 132-135 | 7 | E7 daemon-owned evaluator/coordinator |
| D2 146-157 | 4 | E4 kind enablement separate disclosure |
| D2 241-246 | 4 | E4 kind document grants no judge/rule authority |
| D2 398, 422-425, 435-436 | 4 | E4 immediate kind disable leaves versions unrevoked |
| D2 462-469 | 6 | E6 final judge DNS/TCP/TLS/write fence |
| D2 471-500 | 9 | E9 closed human-only secret inventory |
| D5 1047 | 7 | E7 deterministic rule with all kinds off |
| D5 1049-1057 | 1 | E1 agentic document/prefilter/kind validation |
| D5 1058-1071 | 6 | E6 untrusted numeric answer validation |
| D5 1061-1064 | 8 | E8 exact uncertain band and hold resolution |
| D5 1072-1079 | 5 | E5 stable rolling ledgers/immutable singleton |
| D5 1080-1096 | 5 | E5 transition/recovery/kind-disable settlement |
| D5 1097-1102 | 9 | E9 judge-test global-only charging |
| D7 1235-1243 | 8 | E8 hold-created deadline/tie/expiry |
| D7 1302-1332 | 7 | E7 taint before judge |
| D7 1340-1365 | 6 | E6 pinned local-judge matrix |
| D8 1402-1418 | 2 | E2 pointer-absence schema |
| D8 1500-1507 | 7 | E7 minimal encrypted projection |
| D8 1531-1555 | 2 | E2 decisions/holds/reservations schema |
| D8 1549-1552 | 5 | E5 reservation/test-charge recovery |
| D10 2002-2017 | 9 | E9 operation parity |
| D10 2035-2047 | 9 | E9 judge-test contract |
| D10 2049-2060 | 9 | E9 MCP human-only refusals |
| D10 2062-2075 | 4 | E4 budget/kind activation and Laya seam |
| D10 2076-2090 | 13 | E13 doctor/skill safety report |
| D11 2092-2101 | 6 | E6 fixed TypeSafe/local adapter |
| D11 2100-2125 | 4 | E4 all-off/hosted-key prerequisite |
| D13 2591-2613 | 10 | E10 Overview/Deliveries/Judges contract |
| D13 2618-2627, 2650-2665 | 10 | E10 typed approval/secrets-window boundary |
| §4 2828 | 9 | E9 B3 build/ship prerequisite |
| §5 2856-2865 | 9 | E9 unapproved judge test zero-network |
| §5 2866-2883 | 5 | E5 budgets/injected transport |
| §5 2884-2891 | 4 | E4 kinds-off/disable matrix |
| §5 2937-2955 judge/budget clauses | 4 | E4 activation digest/wrong-kind claims |
| §5 2969-2976 judge/hold clauses | 7 | E7 decision/hold crash matrix |
| §5 3298-3307 local-judge clauses | 6 | E6 sealed local-judge network matrix |
| §5 3308-3318 app/secret-window clauses | 10 | E10 desktop security contract |
| §5 3326-3336 | 9 | E9 parity and B3-stub failure |

## Review process

Each task has its own narrow P1-only review before another task depends on it. End-of-phase review is parallel in isolated worktrees:

| Area | Covers |
| --- | --- |
| Authority/activation | documents, disclosure binding, off-by-default proof, kind disable, B3 gate |
| Storage/recovery | migration, rolling ledger, crash settlement, hold clock/lease/expiry |
| Network/untrusted | B2 path, final gates, envelope/parser/taint/corpus/seal |
| Lifecycle/scope | purge participant, account/source/alias scope, WhatsApp visibility, no resurrection |
| Surface/app | B3 parity/exceptions/no-MCP secrets-holds; C approval/Judges/secrets DTO |
| Test/release | mutation/manifest integrity, no test-local models, package holds, docs/provenance |

Any P1 is fixed by the owner, then that task's named test, mutation runner and pnpm verify run again.

## Pull-request handoff checklist

- events-daemon and events remain held; no publish, tag or unhold.
- State user effect: a person may approve bounded hosted/local judging; agents cannot approve, complete secrets, resolve holds, or receive secret/content through MCP.
- Include proposed 0.16.0-events-e (minor prerelease from 0.15.2; recompute only if target main moves) and its semver reason, tests/results, docs, changelog/No changelog, provenance and no-real-data statement required by CONTRIBUTING.
- Cite this spec read on 2026-10-10 and binding B1/B2/D plans; record no live testing and AI assistance.
- B3/C prerequisite failure, hold change, parity drift, failed mutation, or unsealed transport blocks release.

## Plan-document commit

docs(plan): local event emission — phase E
