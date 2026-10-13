# Local event emission — Phase E implementation plan

**Goal.** Deliver disabled-by-default judge kinds, hosted TypeSafe Jev and literal-loopback local-endpoint judges, durable rolling budgets with crash settlement, holds, and an adversarial corpus. Phase E is not a build or release candidate until B3's full secret-completion/human-only surface and C's Judges/hold surfaces are present and pass the hard gate.

**Starting point.** This plan applies to feat/events-e at 556feb64, the converged B2 + Phase-D tree. It incorporates every binding decision in the B1, B2 and D decision tables: use the shared assertDisclosable fence; reuse B2's raw pinned connection and loopback seal; preserve D raw account/source identity and visibility gates; keep re-added accounts dark until re-approved; encrypt before final writes; and add the hold-created clock D deferred to E (D plan line 1600).

This is a plan, not implementation. Planning ran no provider/network/send/release command.

## Scope and sequencing

E implements typesafe and local-endpoint. Laya remains an enumerated, typed-unavailable `E2_REQUIRED` seam: no pointer, approval, download, worker, native dependency, enablement path, or network path. E does not add a send path, source, temporary CLI/MCP surface, release, or package unhold.

Before B3 is merged, the only permitted E work is unregistered, unreachable foundation code; it is neither a completed Phase-E build nor a Phase-E PR candidate. Task 3 is the E-owned build/ship gate, imports E's real foundation parser/registry code and B3's data-only contract/consumer fixture, and is an entry condition before any judge owner registration or operation registration. The Phase-E PR therefore starts only after B3 merges. Once Task 3 lands, `pnpm verify`, package verification and release verification fail closed whenever the B3 contract/surfaces are missing, stubbed or drifted. B3 never imports E code or owns this gate.

## Plan review decisions (2026-10-10)

| Question | Decision | Reason |
| --- | --- | --- |
| E-A — persisted agentic condition | `CanonicalFullRuleDocument` has mandatory deterministic `condition` and one optional sibling `agentic?: AgenticConditionV1`; deterministic-only rules omit `agentic`. `agentic` embeds the complete immutable judge document, whose canonical bytes must equal the named stored judge version. | The deterministic prefilter remains mandatory while the exact disclosed judge authority remains auditable and digest-bound. |
| E-B — provider wire and limits | Use versioned exact request/response byte vectors, a closed header allowlist, a bounded parser, a 64 KiB request cap, a 64 KiB response cap and B2's 20-second all-phase deadline. Canonical agentic rules carry digest-covered `maxInputTokens` and `maxOutputTokens`; the estimate/refusal/output rules below are binding. An adapter ships only when its vector cites a published provider reference and the date read; otherwise it returns `ADAPTER_REFERENCE_BLOCKED` before network I/O. | No request, parser or token limit may be inferred from a provider's observed behavior. |
| E-C — local protocol shape | A local judge document has exactly `protocol: 'noul'` or `protocol: 'json-score'`; the latter has one validated concrete response JSON Pointer. Every other protocol or extractor shape is refused. | A closed discriminator prevents unreviewed score/extractor semantics. |
| E-D — budget identity and accounting | The singleton id is `judge-budget`; provider identity is the canonical value embedded in the exact judge document. Rolling call/token ceilings count `reserved + in-flight + settled`; concurrency counts `reserved + in-flight`; `released` never counts and `settled` never occupies concurrency. | Reservations are provisional authority before I/O; settled rows are historical usage only. |
| E-E — holds and leases | `hold_created_at` is read from the SQLite transaction clock. A decision-bound, random-token durable resolution claim has DB-time expiry; expired claims recover, and the final transaction rechecks every held authority fact. | Process clocks and in-memory locks cannot safely bound retained data or resolver concurrency. |
| E-F — B3 hard gate | Apply cross-plan contract 6 exactly: unregistered/unreachable foundation may exist before B3, but the E-owned gate lands before any judge owner/operation registration; B3 exports only data-only contract/consumer fixtures; the E PR requires B3 merged. | This preserves limited foundation work without permitting a registered Phase E to build or ship without the human-only protections. |
| E-G — adversarial corpus | Keep a synthetic, versioned JSONL corpus plus schema/hash manifest; execute each case through the real evaluator/coordinator/transport under the loopback seal and assert durable state plus a sealed network journal and no-real-data scan. | A corpus is useful only when it exercises the production trust boundary and cannot contain live data. |
| E-H — Laya boundary | Follow cross-plan contract 5: list/doctor/app expose `laya` only as typed `E2_REQUIRED` unavailable. Model status/remove retain capability rows and return that same state; E has no enablement or runtime path. | E2 owns Laya activation, download, worker and network behavior. |

## Decisions made during the build

| Question | Decision | Reason |
| --- | --- | --- |
| E6-A — which addresses may the hosted judge reach? | The fixed endpoint is the approval: a `typesafe` call resolves `api.typesafe.ai` through B2's pinned path and connects only when every answer, and every address embedded in it (6to4, Teredo, NAT64), is globally reachable; a private, loopback, link-local, metadata or other special-purpose answer refuses the call before TCP. There is no person-approved IP set for this kind, and none is invented: the TLS certificate must validate for `api.typesafe.ai`, SNI and `Host` stay the hostname, and redirects are never followed. | D11 approves "the approved host" for `typesafe` and D7 keeps "the hosted TypeSafe judge … its fixed HTTPS endpoint"; only webhooks and local endpoints carry a person-approved address set. Refusing every hosted call for want of a set nobody approves would leave the kind unusable, while global-only answers keep DNS rebinding off internal addresses. |
| E6-M — what model does a TypeSafe judge name? | A `typesafe` judge document's `model` is one concrete published version from the dated provider record (`jev-1.13.0`, read 2026-10-10); the moving aliases `jev-latest` and `jev-preview`, and any name the record does not list, are refused when the document is canonicalised. The transport sends exactly the approved document's `model`, so a different model is a new judge version and a new approval. | TypeSafe's models page lists `jev-1.13.0` with two aliases that "point to" it and can move; an approval must bind the model its decisions are made by, and decisions record "provider, model and judge versions" (D11). The bare `jev` the Task 1 document fixed is not a published identifier. |
| E-B3 — which migration slots do the integrated durable tables use? | E's local migrations become 17 (judge/hold durability) and 18 (judge-ledger projection detachment) after B3's 14–16. | A recorded migration is immutable and each migration number must be unique in the integrated lineage. |
| E5 — when does crash recovery run at owner start? | Not in Task 5. Task 5's recovery and ledger stay unreachable from every production entry point (cross-plan contract 6 / E-F): the owner-start recovery call is added by the first production ledger caller (Task 7), after E's B3 gate, with its own test that start-up is inert while no judge kind is enabled. | A start-up hook runs on every shipped `events-daemon run` and opened a write transaction on the ledger before B3 — reachable code before the gate. |
| E-B3 — which v1 judge document does the integrated contract publish? | E supersedes B3 v1's placeholder judge document with Task 1's exact canonical TypeSafe/local-endpoint forms in the schema, exported request types and vectors. All non-judge v1 shapes remain unchanged; Phase C must build on this E-integrated contract. | Judges were unavailable in B3, so no B3 consumer depends on its provisional document shape. Keeping the placeholder would make the B3 fixture disagree with the canonical validator at the E authority boundary. |
| E3-B3 — when was the prerequisite gate built? | Task 3 was built against the stacked B3 branch at `cbb8257b` while PR #63 awaited the owner's merge; it will be re-verified after B3 merges. | The branch already carries B3's exact data-only contract and human-only surface, so the gate can be built without registering any E owner or operation; merge remains the Phase-E PR entry condition. |
| E3 review fix — how does the gate consume B3? | Compile B3's control schema with Ajv and its doctor `$ref`, validate all checked-in vectors, execute the runtime vector guard/preview renderer/constants, and require the E parser to refuse invalid documents. | File/title probes could pass with an inert contract or permissive parser. |
| E3 review fix — what makes mutation ownership live? | Each manifest case names one strict runner registry key; B3 gate mutants edit copied production code below `packages/events-daemon/src`. | A manifest row or a verifier-text mutation is not evidence that its named regression executes. |
| E3 review fix — where are release gates enforced? | `release.mjs` launches both Phase-E gates before release preflight, independent of `--skip-verify`. | Package-script wrappers do not cover direct release invocation. |
| E3 second review fix — how is B3 v1 consumed? | B3 v1 is frozen as E-owned exact paths and SHA-256 pins. A deliberate change to a pinned file updates its pin in the same commit, with the reason in that commit. | Empty, substituted or inert fixture/consumer sets cannot silently weaken the prerequisite gate. |
| E9 review fix — why re-pin the B3 consumer contract test? | Re-pin only `b3-consumer-contract.test.ts` so its frozen-seam proof dispatches through the owner: live E judge/budget/kind/test/held results are asserted as E results, while every retained E2/app-origin v1 vector is still checked from owner output. | Task 9 changes the owner's E operation results; directly calling unavailable helpers would let an owner-dispatch regression pass. This follows B3 follow-up #64 / commit `10dc1791`. |
| E9 — where do pending-rule judge-test origin labels come from? | The label is the control client's exact name, mapped only as B3 pending-target testing does: terminal approval or app approval view. The owner refuses every other origin before it validates a selector or begins work. | Inferring a friendly label from an adapter could let an ordinary CLI or MCP request borrow an approval-only path. Reusing B3's established origin mapping keeps the pending challenge tied to the originating control surface. |
| E9 — may a pending-rule judge selector be reused? | Yes, while its durable challenge row remains live and still exactly binds state, origin, hash and deadline; each execution independently consumes the exact-version ten-per-hour budget. | The live durable challenge is the request binding. A later non-forgeable capability hardens both paths, while prohibiting reuse would add a one-shot rule not present for B3 pending-target selectors. |
| E11 integrity fix — how may the DNS-rebinding corpus row name TypeSafe? | The row imports `TYPESAFE_SYSTEM_ONE_ENDPOINT` from the production judge domain and uses that identifier directly; it never repeats the hosted URL as fixture text. Its injected resolver returns only RFC 5737 documentation addresses under the seal. Every other helper URL is one complete allowlisted literal, including its fixed injected port. | The `typesafe` endpoint is fixed in production, so copying it into a fixture could drift while computing any helper URL from fixture or environment state would reopen the no-real-host boundary. The integrity scan therefore permits exactly this production identifier as its sole non-literal URL source. |
| E3 gate position — where do the Phase E gates run in `pnpm verify`? | Right after `pnpm build`, before typecheck, the tests and packaging; `preverify:packages` and the release scripts keep running them before ship. | The prerequisite gate loads the daemon's real source, which imports the built workspace packages. The first placement ran it before the build: the first clean-checkout run (the release dry run on GitHub, 2026-10-12) could not load `@agentcomms/core` and failed every verify leg — a local tree passed only because an earlier build remained. A test now requires build → gates → typecheck/tests/packages. |
| Release plan (owner, 2026-10-13) — must E wait for the desktop app? | No. Task 10 (the C contract/acceptance join) moves to the desktop release; E ships without it, its holds decided at the terminal. Task 11 follows Task 9 directly, and Task 12's audit covers Tasks 3–9 and 11 now, Task 10 when C lands. | The owner paused C and E2 and chose a staggered release: deterministic events (0.16.0), then judges, then the desktop app, then Laya. Spec §4 needs C only for the app's hold resolution and Judges screen. |

## Decisions the spec leaves to the plan

### E-1 — kind model and proof of off-by-default

Keep JUDGE_KINDS in packages/events-daemon/src/domain/lifecycle.ts as the only vocabulary. Add a closed JudgeKindDefinition registry in src/domain/judges.ts:

| Kind | E availability | Canonical enablement/executor |
| --- | --- | --- |
| typesafe | available | fixed HTTPS https://api.typesafe.ai/v1/systemone; Jev/Noul adapter |
| local-endpoint | available | literal-loopback URL and singleton approvedAddressSet; closed `noul` or `json-score` protocol |
| laya | unavailable: E2_REQUIRED | registry slot only; E2 later installs its adapter |

The sole enabled fact is an active_versions row with kind judge-kind and object_id equal to the kind. The pointer names an immutable canonical document. A fresh database, import, update, and no pointer all mean disabled; there is no boolean cache or implicit default. assertJudgeKindEnabled reads it in the same immediate transaction as activation, reservation, and final network gate.

Enable creates the usual judge-kind activation/disclosure approval. Its document has no rule, account, budget, or judge version and grants no disclosure alone. Disable atomically removes only that pointer, retains immutable rule/judge versions, and invokes the shared purge participant. TypeSafe enablement makes no request. Every Laya enablement/model action returns typed `E2_REQUIRED` before intent, approval, pointer, download, worker or network. E2 replaces only this unavailable registry definition.

Alternatives rejected: a settings boolean cannot bind an immutable disclosure approval; enabling when a rule names the kind violates separate-person approval; enabled-but-no-op Laya grants an effect that E cannot deliver.

### E-2 — canonical documents and judge trust boundary

Strengthen the open-ended JudgeDocument, budget, and kind documents into exact discriminated canonical forms. `CanonicalFullRuleDocument` has mandatory deterministic `condition` and optional sibling `agentic?: AgenticConditionV1`; an agentic value embeds the complete canonical judge document as well as its id/version, and the embedded canonical bytes must be byte-for-byte equal to that immutable stored judge version. It also carries per-rule call/hour, input-token/30-day and concurrency limits plus positive, digest-covered `maxInputTokens` and `maxOutputTokens`. Deterministic-only rules omit `agentic` and require neither judge nor budget. A local document is a closed union: `{ protocol: 'noul' }` or `{ protocol: 'json-score', scorePointer: ConcreteJsonPointer }`; an absent, plural, wildcard or any other extractor is refused.

After deterministic match, `JudgeCoordinator` extracts only declared input pointers from the encrypted projection, builds the exact typed/sanitised versioned judge-input envelope, then derives provenance from that final envelope itself before `flush`. The builder must record copied scalar/parent/subtree structured addresses and handles, scan copied untrusted prose for free-text addresses with their header/body locations, and prove constants inherit no source taint. A failed flush emits zero request bytes. The coordinator sends no tools, target, event id, arbitrary headers, secret, model-selected URL or capability. The hosted key is read from B3's secret slot only at the boundary and is never logged, returned or stored in a decision.

`JudgeTransport` builds raw bytes and reuses B2 `preparePinnedConnection`, `connectPinnedTcp`, `connectPinnedTls`, `requestBytesForPinnedConnection`, all four synchronous final gates, and B2's 20-second all-phase deadline. It must have no `fetch`, `http(s).request`, proxy, redirect, agent or alternate socket path. Every adapter checks versioned exact request/response byte vectors, permits only the vector's closed header allowlist, rejects a request over 65,536 UTF-8 bytes before DNS/TCP, and uses an incremental response parser that stops at 65,536 bytes. The wire bytes are not inferred: before the transport task is built, the coordinator fetches the providers' published references — the spec cites [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart), [TypeSafe models](https://docs.typesafe.ai/models) and [Ollama decisions](https://docs.ollama.com/capabilities/decision); the fixed endpoint `POST https://api.typesafe.ai/v1/systemone` is the spec's own (D11) — and records in the task brief, with the URL and the date read, the exact request fields, required headers, response fields and limits. The vectors are built from that record alone and reject every header and field it does not list; until it exists the adapter task is blocked. (The first draft of this plan named wire fields and two documentation pages as read; no page was read while planning, so they are withdrawn.) A proposed adapter with no dated published reference and matching vectors is `ADAPTER_REFERENCE_BLOCKED` before any network I/O; observed provider behavior is never a substitute. TypeSafe host/path/TLS name are constants. `local-endpoint` calls `validateLocalEndpoint` then the same pinned path; it only permits literal HTTP `127.0.0.1` or `::1` with its one exact approved literal.

The token rule is deterministic and conservative: serialize the final request once; its UTF-8 byte length is the token upper-bound estimate reserved before I/O, and a rule refuses before network if it exceeds `maxInputTokens` or 65,536 bytes. It never attempts a call that cannot reserve that estimate. A bounded response must report a non-negative integer usage where the published adapter contract supplies it; reject it as `OUTPUT_TOKEN_LIMIT_EXCEEDED` if it exceeds `maxOutputTokens`, and otherwise use the response-byte upper bound for a documented no-usage `json-score` adapter. The 65,536-byte parser cap applies in either case, and no adapter may add undocumented generation controls to simulate a limit.

All answers are untrusted. Accept one provider-native finite JSON number in [0,1] only, derive match as `p >= threshold`, and ignore/reject any provider match, tool, URL or outcome. A malformed/oversized/over-output-limit/timeout/unknown answer is fail-closed no-match with a closed reason. Persist provider/model/exact versions/template/threshold/value-label/reason only inside encrypted decision metadata. Jev/Noul is labelled probability; `json-score` is labelled uncalibrated-score.

Alternatives rejected: fetch bypasses B2 fences; plaintext prompt/response violates D8; accepting provider match is a confused deputy; one score label misstates generic JSON output.

### E-3 — held decisions and the hold-created clock

Retain the established nonterminal spelling `outcome = hold`. Add `hold_created_at` and content-free `hold_resolution_claims` instead of a transient decision outcome. The same SQLite immediate transaction reads the database clock, writes that value as `hold_created_at`, and uses it for both deadline arithmetic and every expiry comparison; no process/injected wall clock supplies production time. At creation:

    holdExpiresAt = min(holdCreatedAt + holdMs, stagedAt + ingestMs)
    holdBoundBy = ingest-retention on a tie, otherwise the winning bound

A terminal or C resolver atomically takes a durable DB-time lease keyed to the decision and bound to its account/rule/version, with a cryptographically random claim token and `lease_expires_at` from the transaction clock. It decrypts/maps/encrypts outside the transaction, then rechecks the held row, decision-bound token, DB-time deadline, projection, live account/list, exact versions, lineage, kind, switch and expiry while atomically writing the terminal decision/deliveries, deleting the claim, and purging projection. A second resolver sees busy/terminal. Recovery expires claims whose DB-time lease elapsed. Resolution uses the stored answer and never re-asks.

Expiry runs before source/control/replay/recovery. It beats a resolver at deadline, records hold-expired for hold-window or retention-expired for ingest-retention, deletes claim/projection/ciphertext, and creates no delivery. Tightening recomputes min(oldDeadline, createdAt + newHold, stagedAt + newIngest), never extends, and terminalises already-expired holds in the same transaction.

Alternatives rejected: resolution/evaluation time can retain data past D7's creation-bound; an in-memory mutex dies on restart; re-asking consumes new authority/budget and violates “retries never re-ask.”

### E-4 — reservations are the rolling durable ledger

Add `judge_budget_reservations` as the authoritative ledger: id, unique work id, a discriminated work scope, stable rule id where source-owned, exact rule/judge/budget versions, canonical provider id copied only from the embedded judge document, global installation key, timestamps, one call, estimated/actual tokens, concurrency ownership, and closed `reserved | in-flight | settled | released` state. The immutable singleton id is exactly `judge-budget`. Add `judge_test_charges(judge_id, judge_version, charged_at, work_id unique)`.

One immediate transaction reads the active singleton and counts `reserved + in-flight + settled` for rolling call/token ceilings by stable rule, provider and installation key; it counts only `reserved + in-flight` for concurrency and counts `released` nowhere. It checks rule/global/provider limits and inserts `reserved`. Immediately before transport it repeats all authority/budget facts and changes only that row to `in-flight`. Settlement charges actual input tokens when valid or the estimate otherwise, frees concurrency in the same transaction, and creates the decision/hold. Pre-I/O loss releases. Post-I/O-unknown settles its estimate, writes exactly one content-free closed no-match decision with stable `judge-io-unknown` reason, purges the projection in the same decision transaction, and discards every late answer. These are the only transitions.

Startup recovery and kind disable call the same idempotent helper: release `reserved`; for `in-flight`, settle once with estimate, free concurrency, close the one no-match decision and purge its projection; discard late answers. Judge test uses that machine against global only plus one unrefundable exact-version ten-per-hour charge; it has no invented rule/provider limit. New rule/singleton versions never reset stable-key usage.

Alternatives rejected: aggregates cannot survive a crash between I/O/accounting; charge-after-response allows unlimited in-flight calls; version keys reset caps after edits.

### E-5 — all purges use one closure

`JudgeWorkPurgeParticipant` is registered with kind disable, judge revoke/remove, rule disable/remove/revocation/tightening, target revoke/remove, subscriber revoke/remove, disable-all, account removal, WhatsApp visibility hide, projection/ingest expiry, hold expiry, and retention shortening. Within the caller's immediate transaction, and using the discriminated scope selector below, it cancels held/judging work, removes claims/projections/ciphertext, releases reserved rows, settles in-flight rows, and cancels/purges resulting deliveries/dry-run/SSE. Supersession alone never purges. A late completion never restores work.

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

The Task 3 hard gate requires the complete D2 exception set, not only judge keys: target secret create/rotate, target URL set, subscriber token create/rotate, judge key set/rotate and secrets migrate; it also verifies exception rows for approve, dry-run list/show, rule test-retained, pending target/judge test, target resume and held decide. Each has its stated reason, terminal operation/TTY-agent gate where applicable, no MCP tool/schema/text/structured content, and one capabilities row. Non-exception judge operations have CLI/MCP rows naming one shared operation.

The B3/E/C boundary is fixed as follows and Task 3/Task 9 prove its consumer side rather than recreating B3 or C behavior:

| Cross-plan contract | E enforcement and proof |
| --- | --- |
| 1 — versioned desktop wire contract | Task 3 consumes B3's language-neutral, versioned JSON Schema plus request/result/error vectors for desktop-callable D10 operations, checks them against the TypeScript operation types and rejects contract drift. Task 10 consumes the same artifact from C's generated/validated Rust types and mutation-tests schema/operation drift. |
| 2 — approval view | Task 9 consumes `approval view { approvalId, digest }`, its authoritative structured preview and daemon challenge; its stale/digest/challenge vectors prove that `approve` still re-plans at the end. |
| 3 — shared preview fixtures | Task 10 gives B3's TypeScript terminal renderer and C's Rust renderer the identical fixture set and makes either renderer's divergence fail. |
| 4 — secret capability | Until C delivers its owner-verified non-forgeable Rust-to-daemon secret-window capability, Task 9 proves B3 accepts secret operations only from interactive-terminal origin and returns the stable unavailable code to every app/window origin; a forged raw-client window label is refused. Task 10 enables the app origin only after C's capability test passes. |
| 5 — pre-E/pre-E2 typed states | Task 3 requires B3 judge operations and capability rows to return zero-network unavailable before E, and Laya model status/remove to return typed `E2_REQUIRED` with no pointer/approval/download/worker/network. Task 9 turns E into the producer for judge operations without changing those result variants. |
| 6 — E-owned gate | Task 3 owns the gate in E and imports E real code; B3 supplies only its data-only contract and consumer-fixture test. The gate precedes every E owner/operation registration and the Phase-E PR requires B3 merged. |
| 7 — pending-target testing | Task 9 consumes B3's pending activation-context selector, verifies it is available only to terminal approval and app approval flows, and proves MCP and ordinary CLI refusal. Task 10 proves C calls that same operation. |

C must provide: Overview and Deliveries safely list/resolve held decisions; Judges lists all three kinds as disabled by default, opens typed D2 approval only for TypeSafe/local-endpoint enablement, applies immediate disable, shows hosted/local facts and the `laya: E2_REQUIRED` reason, and opens the secrets window for hosted keys only after contract 4 permits it. Typed app approval calls the same daemon activation protocol. E owns daemon DTO vectors, not an app-side judge/secret/hold implementation.

Alternatives rejected: a temporary E CLI forks B3 parity; a generic installed marker cannot prove no secret enters MCP; blocking foundation work on C defeats the requested safety ordering.

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

`JudgeWorkScope` is a closed discriminated selector algebra:

```ts
type JudgeWorkScope =
  | { scope: 'source-owned'; source: SourceName; accountId: string; eventId?: string; ruleId?: string; ruleVersion?: number; judgeId?: string; judgeVersion?: number; decisionId?: string; reservationId?: string }
  | { scope: 'synthetic-test'; testWorkId: string; judgeId: string; judgeVersion: number }
  | { scope: 'judge-kind'; judgeKind: JudgeKind };
```

Every source-owned SQL mutation helper binds both raw `source` and `accountId`; synthetic judge-test work matches only its exact `testWorkId`; and a kind-wide purge first enumerates rows by exact canonical kind, then invokes the source-owned/synthetic selector that each row requires. Helpers return affected counts that callers assert. Aliases resolve once then match stable row id. Provider id comes only from the embedded canonical judge document. All modules import `JUDGE_KINDS` from `lifecycle`.

`judge-scope.test.ts` uses two accounts and two sources with same-looking ids, re-add and stale alias, a synthetic test-work identity, and a kind-wide purge across both source-owned identities. `scripts/verify-events-phase-e-tests.mjs` rejects unscoped judge SQL helper use and duplicate kind literals. Removing an account/source predicate, replacing a synthetic-work predicate, or matching kind-wide work without enumeration must fail its named E3 scope-isolation test.

### Purge closure

`judge-purge-closure.test.ts` seeds held/reserved/in-flight/queued/retryable/dry-run/SSE work through production paths for every registered purge caller, including target and subscriber revoke/remove, restarts, and proves exact terminal state, ciphertext/claim purge, release/settlement and no resurrection. The registry test fails when a lifecycle operation that can purge `ingest_rules` omits the participant.

### Tests that bite

Every named test runs a real EventEvaluator, JudgeCoordinator, JudgeTransport, activation/lifecycle or hold operation against SQLite. Fakes are only clock/config/approval/resolver/socket/loopback receiver. test/support/judge-mutants.ts maps exactly one source mutation to one named test. The runner copies production source, applies that one edit, and runs only the exact name pattern. The manifest maps every §5 row, await row and corpus case to one named test/mutation. The structural verifier fails for orphan cases/mutations, duplicate ownership, network test without preload, test-local system model, or skipped mutation.

## Batches, dependencies, and safe parallelism

There are 13 implementation tasks in 7 batches. Every batch ends with full `pnpm verify`; focused tests alone never accept a batch. A task may be parallel only where this table gives it a disjoint file set; semantic dependency alone is not treated as safe parallelism.

| Batch | Tasks | Parallel group / join |
| --- | --- | --- |
| 1 — contracts and prerequisite gate | 1 → 2 → 3 | Serial. Tasks 1–2 may be unregistered foundation before B3; Task 3 requires B3 merged, installs the E-owned hard gate, and completes before any owner/operation registration. |
| 2 — recovery, authority and transport | 5 → 4; 6 | Task 5's shared recovery transition precedes Task 4's kind/budget activation and purge participant. Task 6 may run beside either only because it touches exclusively `runtime/judge-{transport,adapters}.ts`, `network/{pinned-connection,local-endpoint}.ts` and its own test/fixture files; it must not edit the manifest. |
| 3 — decisions | 7 → 8 | serial: they share hold/decision semantics. |
| 4 — joins/corpus | 9 → 10 → 11 | Serial. Task 9 owns operations/doctor/capabilities and precedes Task 10; Task 11 follows Task 8 and follows the joins because each task updates the shared case manifest. No B3/C shims. |
| 5 — proof | 12 | serial audit of all prior paths. |
| 6 — handoff | 13 | serial final gate. |
| 7 — review | split reviewers | parallel reviewers, isolated review worktrees, then P1 fixes. |

Do not copy generated references/migrations between worktrees. Rebase, run named tests, then full verify. Tests use synthetic data, injected fakes and sealed loopback only. The only concurrent files in Batch 2 are the explicit disjoint Task 6 set; every other shared file—especially `owner.ts`, `lifecycle.ts`, `expiry.ts`, `operations/doctor.ts` and the case manifest—has one serial owner.

## Batch 1 — contracts

### Task 1 — canonical agentic/judge/budget/kind documents (high risk)

**Files.** Modify `packages/events-daemon/src/domain/activation-documents.ts`, `domain/versions.ts`, `domain/lifecycle.ts`; `packages/events/src/conditions/types.ts`, `agentic.ts`, `index.ts`; add `packages/events-daemon/src/domain/judges.ts`. Modify `packages/events-daemon/test/activation-documents.test.ts` and `version-lifecycle.test.ts`; add `test/judge-documents.test.ts`. Add browser-run canonicalisation/export vectors under `packages/events/test/`.

**Tests first, then implementation.**

1. Add failing Node-and-browser vectors for mandatory deterministic `condition`, omitted optional sibling `agentic`, an embedded exact judge document byte-equal to its stored version, content-field deterministic prefilter, strict kind documents, singleton id `judge-budget`, all kinds unavailable, `maxInputTokens`/`maxOutputTokens`, and closed `noul | json-score` protocol. Include malformed provider/model/protocol/address fields, non-concrete/multiple score pointers, unmatched embedded judge bytes, missing/zero token maxima, rule global/provider fields and Laya `E2_REQUIRED` unavailable.
2. Implement discriminated canonical forms without importing daemon/I/O into events.
3. Make `VersionStore.prepareRule`, `prepareJudge`, `prepareBudget` and `prepareJudgeKind` enforce the forms, immutable byte identity and every digest field. `judge add`/update succeeds while its kind is disabled; only a **rule activation that names an agentic judge** checks `JUDGE_KIND_DISABLED` at prepare, claim and finalisation.
4. Add one digest mutation vector for every agentic/judge/budget/token/protocol field, including either token maximum, and import—never duplicate—the kind vocabulary.

**Commands.**

    pnpm --filter @agentcomms/events test -- conditions
    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E1|agentic|judge document'
    pnpm verify:browser

Run `pnpm verify` for this foundation task only after B3 merges and Task 3's gate is installed; before then these are exploratory foundation checks, never a successful Phase-E acceptance claim.

**Passing / mutations.** Node/browser vectors round-trip canonical bytes and exports identically; deterministic rules still work while disabled kinds cannot become effective; adding a disabled judge succeeds but its activation fails `JUDGE_KIND_DISABLED`. Removing prefilter, permitting a non-byte-equal/foreign judge, default-enabling a kind, omitting a token maximum, accepting an open protocol or deleting a canonical field fails its named vector.

**P1-only review.** Document/digest permissiveness, duplicate vocabulary, and any deterministic canonicalisation change.

**Commit.** feat(events): canonicalise phase E judge authority documents

### Task 2 — durable schema and migration shapes (high risk)

**Files.** Modify `packages/events-daemon/src/store/schema-v1.ts`, `migrations.ts`, `records.ts`; add migration fixtures and `test/judge-migrations.test.ts`; extend `test/migrations.test.ts`.

**Tests first, then implementation.**

1. Start from every B1/B2/D fixture and fresh v1; add failing checks for DB-clock `hold_created_at`, decision-bound random-token/DB-expiry hold claims, discriminated source/synthetic/kind work scope columns, `judge_budget_reservations`, `judge_test_charges`, unique keys, state checks, rolling/scope indexes and valid current-schema foreign keys.
2. Add one forward migration at the next free integrated number; never edit a recorded migration. Update fresh schema and preserve old encrypted bytes.
3. Add foreign_key_check, reopen/idempotence, secure-delete, and plaintext request/response scan assertions.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='migration|E2'

Run `pnpm verify` for this foundation task only after B3 merges and Task 3's gate is installed; before then these are exploratory foundation checks, never a successful Phase-E acceptance claim.

**Passing / mutations.** Fresh/upgraded schema agrees; invalid state, an unscoped duplicate, non-decision claim, non-DB expiry or old fixture regression fails. Remove transaction-clock capture, decision/work-id uniqueness, state check or scope index and the named case fails.

**P1-only review.** Forward-only ordering, SQL checks/index scope, preserved ciphertext and no migration renumbering.

**Commit.** feat(events): add durable judge and hold records

### Task 3 — B3 prerequisite gate, test manifest, mutation runner and static guards (high risk)

**Precondition.** B3 is merged. This is the first task allowed to register an E owner or operation; it installs the E-owned gate before registering either.

**Files.** Add `packages/events-daemon/src/runtime/phase-e-prerequisites.ts`, `test/judge-b3-prerequisites.test.ts`, `judge-mutations.test.ts`, `judge-scope.test.ts`, `test/support/judge-mutants.ts`, `test/fixtures/judges/case-manifest.json`, `scripts/verify-events-phase-e-prerequisites.mjs`, `scripts/verify-events-phase-e-tests.mjs`; modify root `package.json` only to invoke both completed verifiers.

**Tests first, then implementation.**

1. Add failing gate vectors that remove/stub each B3 data-only contract item, secret/human-only capability row, pre-E typed unavailable result, `approval view` challenge vector, or consumer fixture; each must make required verify/package/release fail before an owner/operation is registered. Include the forged app/window-origin secret client and pending-target MCP/ordinary-CLI refusal vectors.
2. Import E's actual `JudgeKindDefinition`/canonical-document parser into `phase-e-prerequisites.ts`, consume B3's data-only versioned schemas/vectors and consumer fixture, and add the gate to required verify, package and release verification. B3 must not import this file; no stub/warning path exists.
3. Add failing self-tests for an orphan named case/mutation, unowned §5 row, missing loopback preload, duplicate kind literal, unscoped scope variant and test-local implementation substitute. Implement the D-style copy-one-production-file mutation runner; it runs only the mapped name pattern.
4. Register Tasks 1–2 and every gate guard/mutation. Every later task adds its rows in the same commit.

**Commands.**

    node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e-tests.mjs
    node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e-prerequisites.mjs
    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E3|mutation|scope'
    pnpm verify

**Passing / mutations.** B3 absence/drift makes build/ship refusal fail closed before owner/operation registration; the verifier fails in a temporary mutant copy and passes only with total one-owner metadata. Delete a B3 guard, a mapping, an account/source predicate or a synthetic-work predicate; its named gate/verifier/scope case fails.

**P1-only review.** E-owned real-code import, B3 one-way/data-only boundary, pre-registration failure, one-to-one mutation mapping and no silent skip.

**Commit.** test(events): enforce phase E mutation and scope coverage

**Batch 1 end.** Rebase integrations and run `pnpm verify:browser` plus `pnpm verify`. Record both results in the implementation PR. No later task may register a judge owner/operation unless this gate remains green.

## Batch 2 — authority and transport

### Task 4 — kind activation, immediate disable and purge closure (high risk)

**Dependency.** Task 5's `recoverJudgeWork`/terminalisation primitive is complete and green. Run Task 4 only after it; both tasks own `owner.ts`, `lifecycle.ts` and `expiry.ts` and are never parallel.

**Files.** Add `src/runtime/judge-kinds.ts`, `judge-budget-activation.ts` and `judge-purge.ts`. Modify `runtime/activations.ts`, `disclosure-fence.ts`, `lifecycle.ts`, `revocations.ts`, `account-fence.ts`, `whatsapp-visibility.ts`, `expiry.ts`, `replacements.ts`, `owner.ts` and `domain/versions.ts`. Add `test/judge-kind-enablements.test.ts`, `judge-budget-activation.test.ts` and `judge-purge-closure.test.ts`.

**Tests first, then implementation.**

1. Prove new/install/update/import all have three absent pointers; deterministic-only rules activate; `judge add` succeeds while its kind is disabled; and only prepare/claim/finalise of a rule activation that names that judge refuse `JUDGE_KIND_DISABLED` when a disable races between them.
2. Add `judge-budget-activation` tests before implementation: prepare → terminal/app disclosure approval → core claim → final SQLite pointer swap for exactly `judge-budget`. Test every global/provider ceiling and digest field mutation, wrong activation-kind claim, stale pointer/digest binding at prepare/claim/finalise, bypassed approval and post-await final recheck. Each test mutates exactly its named guard and runs the named case.
3. Implement the kind and singleton-budget activation effects/final fences. The budget path derives its one version binding from the immutable singleton document, performs all three pointer/digest drift fences, records completion and never writes a pointer outside the claimed disclosure protocol. TypeSafe enablement makes no request; Laya returns `E2_REQUIRED` before intent, approval, pointer or download.
4. Implement the participant inside caller transactions using `JudgeWorkScope`, and call Task 5's one recovery helper rather than hand-written reservation cleanup.
5. Seed held/reserved/in-flight/delivery/dry-run/SSE work for kind disable, judge/rule/account/visibility/expiry plus target and subscriber revoke/remove. Prove immediate no-approval disable/revoke/remove purges/settles, late result discards, rules/judges remain unrevoked after kind disable, and re-enable restores only listed work.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E4|judge kind|judge-budget-activation|purge closure'
    pnpm verify

**Passing / mutations.** No implicit enablement, pointer write without approved claim, or post-disable reservation/byte boundary; every purge path invokes one participant and one shared recovery helper. Default a pointer, bypass budget approval, omit a prepare/claim/final drift check, permit disabled `judge add` refusal, skip in-flight terminalisation, remove account/source or target/subscriber scope, or unregister a path; the named E4/E5 mutation case fails.

**P1-only review.** Kind/budget activation binding, three pointer/digest fences, pointer absence, all purge callers, shared recovery reuse and post-await rechecks.

**Commit.** feat(events): activate judge budgets and enforce kind purge closure

### Task 5 — rolling budgets and crash recovery (high risk)

**Dependency.** Task 3's B3 gate is green. This task precedes Task 4 and creates the only `recoverJudgeWork` transition helper that Task 4's disable/purge path calls.

**Boundary.** Task 5 creates an unreachable ledger/recovery primitive and its direct SQLite proofs only; it neither enables a singleton nor registers a production judge owner/caller. In particular, owner start issues no ledger or recovery SQL: Task 7, after the B3 gate, is the first production ledger caller and owns wiring owner-start recovery. Task 4's approved `judge-budget` pointer activation also precedes Task 7.

**Files.** Add `src/runtime/judge-budget.ts` and `judge-recovery.ts`. Modify `store/schema-v1.ts`, `store/migrations.ts`, `runtime/decisions.ts`, `lifecycle.ts`, `expiry.ts` and relevant records; do not add a production recovery call to `owner.ts`. Add `test/judge-budgets.test.ts`, `judge-crash-recovery.test.ts`, `judge-task5-mutations.test.ts`, strict-mutation-child support/self-test, and only `test/fixtures/judges/crash-recovery/`.

**Tests first, then implementation.**

1. Add injected-clock edges for rule/provider/global call/hour, token/30-day and concurrency; prove stable ids survive rule/singleton replacement. Count `reserved + in-flight + settled` in rolling call/token windows, `reserved + in-flight` in concurrency, and `released` nowhere.
2. Add token vectors: a fixed UTF-8 final-envelope byte estimate is reserved before I/O, input over `maxInputTokens`/64 KiB refuses before injected transport, output over `maxOutputTokens` becomes closed no-match, and an unknown/timeout charges the estimate. Settlement takes a required result discriminant with no `completed` default: only `completed` carrying parsed provider usage replaces the estimate; every named non-completed outcome and a call missing that discriminant charges the estimate or is refused. Prove the actual reported input count, when valid, replaces only the provisional estimate at settlement.
3. Implement singleton validation, `JudgeWorkScope`-bound conditional reserve/release/in-flight/settle SQL, exact-version test-charge cap and the idempotent `recoverJudgeWork` helper. Its post-I/O branch atomically settles the estimate, frees concurrency, writes one closed `judge-io-unknown` no-match decision and purges the projection; its pre-I/O branch releases only. No other module may recreate those transitions.
4. Inject failpoints after reserve, immediately before transport, immediately after transport, response persistence, settlement, terminal decision insert, each delivery insert, projection purge and immediately before commit. Reopen then invoke direct recovery and prove pre-I/O release; otherwise exactly one pessimistic charge/free-slot/closed no-match/projection purge, zero second transport calls and discarded late answers. Install the startup SQL observer before the owner opens SQLite (including migrations), and prove no Task-5 ledger/recovery statement executes at owner start; every owner opened by a test stops in `finally` before its database/temp path is closed.
5. Prove exhausted/no-singleton refusal reaches no injected transport. Prove fresh and upgraded `judge_kind_versions` checks admit exactly `JUDGE_KINDS`, from the one shared SQL vocabulary.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E5|budget|reservation|crash'
    pnpm verify

**Passing / mutations.** Only legal state paths occur and recovery is idempotent. Exclude `reserved` or `in-flight` from its named ceiling, count settled concurrency, key by version, under-estimate/ignore an approved token maximum, restore a missing-result `completed` default, refund unknown transport, double-settle, leave a post-I/O projection/decision nonterminal, allow a second transport call, issue recovery SQL at owner start, literalise a judge-kind check, or omit concurrency release; its exact named E5 mutation case fails. Every strict copied-child mutation runner has a bounded per-child timeout that kills a hung child and reports a runner failure; its self-test proves a child that never exits fails within that bound.

**P1-only review.** Window predicates/state counting, token upper bounds, conditional transitions, post-I/O terminalisation, recovery idempotence and awaited writes.

**Commit.** feat(events): reserve and recover durable judge budgets

### Task 6 — sealed hosted/local transports (high risk)

**Files.** Add `src/runtime/judge-transport.ts` and `judge-adapters.ts`. Only minimally extend `src/network/pinned-connection.ts` and `local-endpoint.ts` for common bounded response helpers. Add `test/judge-transport.test.ts`, `judge-network-fences.test.ts` and only `test/fixtures/judges/transport/` loopback fixtures.

**Tests first, then implementation.**

1. Add sealed, versioned byte vectors for fixed TypeSafe request/response bytes and documented header allowlist, the supported dated Ollama local request/response bytes, literal local URL, closed `noul`/one-pointer `json-score` parser, `ADAPTER_REFERENCE_BLOCKED`, address drift/rebinding, TLS/SNI, no redirect/proxy, 20-second all-phase deadline, 64 KiB request/response caps and refusal before DNS/TCP.
2. Reuse B2 resolver/TCP/TLS/request primitives/four gates; hooks run before each gate; no HTTP client import.
3. Add incremental-parser vectors for Noul, one `json-score` pointer, multiple/invalid pointer, wrong type, NaN/Infinity/range, provider match/tools, hostile reason, missing/invalid usage and over-`maxOutputTokens` usage. The only response value returned to the coordinator is the bounded validated number plus bounded usage metadata.
4. Return data only; Task 7 owns settle/decision.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E6|judge transport|local endpoint'
    pnpm verify

**Passing / mutations.** Every transport is injected/loopback sealed; each gate blocks next I/O; only the bounded validated number reaches coordinator. Replace a reference/vector/date check, header allowlist, final gate or cap; use `fetch`; allow hostname loopback/redirect; accept match; clamp score; accept an open extractor; or remove an output-token check; its named test fails.

**P1-only review.** Network imports, gate-to-I/O adjacency, parser bounds, no secret observation.

**Commit.** feat(events): add sealed hosted and local judge transports

**Batch 2 end.** One owner integrates migrations, reruns E4–E6 and pnpm verify. Confirm no test can contact a real host.

## Batch 3 — decision and retention

### Task 7 — deterministic-first coordinator and atomic decisions (high risk)

**Files.** Add `src/runtime/judge-coordinator.ts`. Modify `runtime/evaluate.ts`, `decisions.ts`, `mapping.ts`, `untrusted.ts` and relevant record types. Add `test/judge-evaluation.test.ts`, `judge-taint.test.ts` and decision-crash fixtures.

**Tests first, then implementation.**

1. Add real-path cases: deterministic false has no provenance/taint/reservation/network; true derives the exact judge-input envelope; copied scalar, parent and subtree structured addresses/handles retain provenance; copied prose address uses body provenance; constants inherit none; a failed flush writes zero request bytes; match/no-match/uncertain/no-match/hold; timeout/malformed/exhausted/over-output-limit no-match; retry never re-asks.
2. `EventEvaluator` evaluates deterministic condition first, then coordinator builds the exact envelope/provenance, taint-flushes, reserves using Task 5's approved token estimate, moves in-flight before transport, settles and calls one decision/hold commit helper. It must not call the ledger until Task 4's active singleton pointer passes its final fence.
3. Extend `commitDecisionOutbox`; final transaction rechecks projection, exact versions/pointers/lineage, pause/switch/account/visibility and reservation token. Reuse Task 5's `judge-io-unknown` terminalisation after every post-I/O uncertainty rather than retrying the judge.
4. Run failpoints around post-I/O settlement, terminal decision insert, each delivery insert, projection purge and commit through the actual evaluator/coordinator. After restart prove one charge, one terminal decision and zero second transport calls; a committed result has the complete delivery set, while the unknown branch creates none. Store only encrypted metadata; create deliveries only for derived match.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E7|judge evaluation|taint'
    pnpm verify

**Passing / mutations.** Judge is never called before valid prefilter/exact-input-provenance/flush/reserve; each path has one terminal decision or a safely retained hold. Move taint after reserve/I/O; substitute unrelated provenance; omit a structured/parent/subtree/prose observation; inherit constant taint; skip prefilter; create a delivery for malformed/unknown; settle without token; retain a post-I/O projection; or re-ask; the named E7 test fails.

**P1-only review.** Authority order, exact-input provenance, token/refusal handoff, single decision owner, post-I/O terminalisation and final checks.

**Commit.** feat(events): evaluate agentic rules through durable judges

### Task 8 — holds, expiry, tightening and resolver safety (high risk)

**Files.** Add `src/runtime/holds.ts`. Modify `runtime/decisions.ts`, `expiry.ts`, `replacements.ts`, `account-fence.ts`, `whatsapp-visibility.ts`, `lifecycle.ts` and B3-facing contract types if present. Add `test/judge-holds.test.ts`, `judge-hold-retention.test.ts`, `judge-races.test.ts`.

**Tests first, then implementation.**

1. Test threshold 0/1/band edges; DB-transaction-clock hold deadline/tie; restart across process-clock skew/rollback; start-up expiry before control; tightening; late resolution; competing terminal/app resolvers; expired-lease recovery; and crash edges around claim/decision/delivery.
2. Implement DB-clock capture, a decision-bound random-token DB-expiry lease claim/recovery, and fenced resolution; use normal mapping/delivery encryption-before-write path. The final transaction checks the exact claim token, lease/deadline from DB time and every listed authority fact before a pointer/delivery write.
3. Make expiry/purge delete claims and terminalise content-free, including D account/list visibility paths. At deadline, expiry wins against a claim and no process clock can extend the hold.
4. Register all new guards/writes/mutations in Task 3 manifest.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E8|hold|hold retention|race'
    pnpm verify

**Passing / mutations.** A hold cannot outlive ingest, resolve twice, resurrect after purge, or create delivery after expiry/disable/revoke. Use evaluation/process time instead of SQLite time, reverse tie, omit decision binding/claim token/DB-lease expiry/final recheck, allow late resolution, or omit purge hook; the named case fails.

**P1-only review.** DB-time arithmetic, lease recovery, final transactional rechecks, existing B1 atomicity and D scope/visibility propagation.

**Commit.** feat(events): retain and resolve bounded judge holds

**Batch 3 end.** Run pnpm verify and inspect DB/WAL/free-page scans: prompt/response/source text exists only encrypted.

## Batch 4 — B3/C joins and adversarial corpus

### Task 9 — B3 operation join (blocked until B3; high risk)

**Dependency.** Task 3's gate has already proved B3's data-only contract and human-only surfaces. Task 9 owns `operations/doctor.ts` and completes before Task 10; Task 10 may not edit it.

**Files.** After rebase on B3, modify B3-owned `packages/events-daemon/src/operations/judges.ts`, `deliveries.ts`, `doctor.ts`, CLI/MCP registrations, `capabilities.json` and generated sources; add `test/judge-operation-parity.test.ts`, `judge-test-operation.test.ts` and operation vectors.

**Tests first, then implementation.**

1. Encode E-7 inventory/consumer vectors; a temporary copy that removes a secret row/human guard, adds MCP registration, mismatches an operation, omits a held exception, forges an app/window origin, accepts ordinary-CLI/MCP pending-target testing, or changes the pre-E/E2 unavailable variant must fail.
2. Route judge/budget/kind/test/held/doctor through Tasks 4–8 shared operations. MCP kind enable prepares only; secret operations use B3 event secret store and remain terminal-only until C's non-forgeable secret capability passes. `approval view` returns the authoritative preview/challenge and `approve` still re-plans at finalisation.
3. Implement judge-test restrictions: fixed `io.agentcomms.test.v1`, no caller content/field override, active or specified pending-rule terminal/app exception, ordinary exact-input taint/reservation, ten/hour exact-version charge and global-only budget; unapproved call has zero network.
4. Keep `laya` list/doctor/model-status/model-remove capability rows typed `E2_REQUIRED`: no pointer, approval, download, worker or network. Generate references; do not edit them by hand.

**Commands.**

    pnpm verify:parity --strict
    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E9|judge test|capability'
    pnpm verify

**Passing / mutations.** Correct parity/exception behavior; the Task 3 gate still fails required verify on deliberately removed B3 completion. Stub judge key rotate; expose a secret to MCP/window origin; let MCP claim kind/resolve hold; bypass `approval view` re-plan; accept caller content; permit pending target test from ordinary CLI/MCP; give Laya an E pointer/action; or detach a capability operation; the named E9 test fails.

**P1-only review.** CLI/MCP operation identity, no-MCP/window-secret proof, human guards, typed unavailable seams, reference generation and retained hard-gate failure path.

**Commit.** feat(events): join B3 judge operations and typed unavailable seams

### Task 10 — C contract/acceptance join (blocked until C)

**Dependency.** Task 9 owns and has frozen daemon operations/doctor DTOs. This task modifies no `operations/doctor.ts`, capability row or CLI/MCP file.

**Files.** Add `packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json` and `test/judge-desktop-contract.test.ts`. After rebase on C, modify its landed `apps/desktop` protocol DTO/tests and shared preview fixtures only.

**Tests first, then implementation.**

1. Freeze B3's versioned schema/request/result/error vectors for disabled/pending/enabled/`E2_REQUIRED` kind state, safely represented held data and typed hold-decision errors/results. Generate or validate C's Rust types from that artifact and mutation-test schema/operation drift.
2. Give the B3 TypeScript terminal renderer and C Rust renderer the same named preview fixtures; test byte-identical structured preview interpretation. C Overview/Deliveries use safe rendering and the same daemon hold operation as terminal. Judges starts all three disabled, enables only TypeSafe/local-endpoint by typed approval, disables immediately, and shows hosted/local facts plus the Laya `E2_REQUIRED` reason.
3. Test `approval view` challenge/digest stale re-plan and denial of every secret command from non-secrets windows, including a forged raw-client window label. Enable app secret origin only after C's owner-verified, non-forgeable Rust-to-daemon secret-window capability succeeds. Pending-target test uses the same terminal/app activation-context operation and refuses MCP/ordinary CLI. No app-side judge/budget/secret/hold implementation.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E10|desktop contract'
    pnpm --filter @agentcomms/desktop test
    pnpm verify

**Passing / mutations.** App/daemon DTOs agree and mutate-detect schema/operation drift; terminal/Rust renderers agree on the shared fixtures; kinds begin off and hold/key actions cannot escape human-only windows. Mark kind enabled, render a webview preview, expose a secret command/origin, accept a forged window label, bypass `approval view`/daemon hold operation, or permit pending-target test outside approval; the exact C/daemon case fails.

**P1-only review.** Generated/validated protocol ownership, shared-renderer fixtures, untrusted rendering, approval identity, pending-target selector and non-forgeable secret-window boundary.

**Commit.** test(events): prove phase E desktop judge contracts

### Task 11 — executable adversarial corpus

**Dependency.** Task 8 is complete: corpus cases include response-after-hold/expiry and use the production hold/expiry path. Task 11 is serial after Tasks 9–10 because each updates the shared case manifest.

**Files.** Add `test/fixtures/judges/adversarial-v1.jsonl` and `adversarial-v1.manifest.json`, `test/judge-adversarial-corpus.test.ts`, `judge-corpus-integrity.test.ts`, `test/support/judge-adversarial-fixture.ts`; extend the shared case manifest.

**Tests first, then implementation.**

1. Add failing versioned schema/hash-manifest checks and synthetic category rows from E-6, including exact-input taint, token/refusal, budget activation/race, post-I/O unknown and response-after-hold/expiry cases.
2. Run each through the real `EventEvaluator` → `JudgeCoordinator` → `JudgeTransport` path and loopback/injected endpoint under the preload seal; assert durable decision/reservation/projection/taint result and the sealed network journal's exact allowed bytes, destination and zero unapproved attempt—not a fixture model.
3. Scan corpus and journal fixtures for secret-looking material, real domains, provider captures, unknown schema, unpaired case, missing digest/hash, or unsealed network attempt.

**Commands.**

    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E11|adversarial corpus'
    pnpm verify

**Passing / mutations.** Every row crosses the actual trust boundary, reaches its bounded durable outcome and has the expected sealed journal. Treat provider match as authority, remove an envelope/provenance observation, bypass range/token/cap check, alter journal bytes/destination, or delete a manifest row; the named corpus/integrity case fails.

**P1-only review.** Fixture provenance, real production path, no real data/host, expectation coverage.

**Commit.** test(events): add adversarial judge corpus

**Batch 4 end.** Tasks 9–11 are serial and none may be waived. E remains incomplete/unshippable until the B3/C joins, corpus and `pnpm verify` pass.

## Batch 5 — cross-cutting proof

### Task 12 — exhaustive race, scope, purge and mutation audit (highest risk)

**Files.** Modify test/judge-races.test.ts, judge-scope.test.ts, judge-purge-closure.test.ts, judge-mutations.test.ts, test/support/judge-mutants.ts, manifest and scripts/verify-events-phase-e-tests.mjs. Repair production only where the matrix finds a true gap.

**Tests first, then implementation.**

1. Enumerate every Tasks 3–11 await/write, external identity, alias, discriminated scope variant, purge caller (including target/subscriber), §5/corpus case and gate guard; fail on omission.
2. Pause every real seam; race budget activation/pointer swap, disable, judge/target/subscriber revoke/remove, account remove/re-add, WhatsApp hide, expiry, approval/secret drift and competing resolver; resume and assert no stale write/network.
3. Run each mutation isolated against exactly its named production operation; reject test-local ledger/model.
4. Statically reject fetch/http.request/https.request and duplicate kind vocabulary in judge paths; require loopback preload for judge network tests.

**Commands.**

    node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e-tests.mjs
    pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E12|judge race|scope|purge|mutation'
    pnpm verify

**Passing / mutations.** Every ledger/matrix row has one owner/mutation and every mutant fails its one real-path test. The suite itself is the mutation requirement; deleting a required gate/manifest mapping, source/account/synthetic selector or purge caller must fail structural verification.

**P1-only review.** Matrix completeness, mutant isolation/name targeting, no test-local behavior.

**Commit.** test(events): exhaustively fence phase E judge races

**Batch 5 end.** pnpm verify plus mutation/network-journal inspection. Any skipped mutation, orphan purge path or unsealed test is P1.

## Batch 6 — final gate and handoff

### Task 13 — final E2E, release hold and PR evidence

**Files.** Modify operations/doctor.ts and tests, README/reference/skill generators as needed, held-release tests if necessary, and this plan only for discovered links. Do not remove agentcommsRelease.hold from packages/events or packages/events-daemon.

**Tests first, then implementation.**

1. Add active rule → prefilter → exact-input provenance/taint → approved budget pointer → sealed judge → match/no-match/hold → delivery/purge/restart E2E cases. Doctor reports kind pointer, budget/reservations, holds, missing key and Laya `E2_REQUIRED` unavailable.
2. In a temporary checkout remove/stub B3 rows or a B3/E consumer fixture and prove the Task 3 required verify/release gate fails; test positive integrated B3+C tree.
3. Regenerate/check references, strict parity, browser/package/held-release/docs/skills. Confirm no Laya native dependency.
4. Prepare CONTRIBUTING evidence: user-visible change/how; proposed 0.16.0-events-e (a minor prerelease from the present 0.15.2 because it adds the held daemon's first usable judge capability; recompute if target main moves); focused/full test results; docs; changelog line or “No changelog: Phase E only extends the held local event daemon and @agentcomms/events”; provenance of specs read 2026-10-10, B1/B2/D decisions, no live testing, AI assistance; no real data. No tag/publish/unhold.

**Commands.**

    pnpm verify:parity --strict
    pnpm verify:browser
    pnpm verify:packages
    pnpm verify
    git diff --check
    git status --short

**Passing / mutations.** B3/C gates green, both packages held, no real data. Remove the E-owned verify gate, one B3 row/consumer fixture, hold-clock doctor field, a typed Laya unavailable field or package hold; the named final/hold test fails.

**P1-only review.** Build/ship refusal, parity, generated docs, holds, provenance, no Laya/send/network regressions.

**Commit.** None — final verification and PR handoff only.

## §5 coverage ownership

E2-only Laya runtime/download/quality clauses are excluded. Every E-owned §5 clause has one owner.

| §5 row / clause | Owner |
| --- | --- |
| Phase-E B3 hard gate, data-only consumer fixture and pre-E/E2 typed unavailable contract | Task 3 |
| Conditions/local tests: judge-test synthetic/taint/no unapproved network | Task 9 |
| Judges/budgets: approved token maxima/estimates, ledger state counting, rolling limits/inheritance/crash and judge-test charge | Task 5 |
| Judge answers: documented wire, header/parser/byte/token output bounds and malformed values | Task 6 |
| Deterministic prefilter, exact judge-input provenance/taint and post-I/O terminal decision outcome | Task 7 |
| Judge kinds: all-off, activation fences, disable purge/late result and TypeSafe enable no request | Task 4 |
| Digest/approvals: kind/budget vectors, full budget activation, wrong-kind claims and pointer/digest drift | Task 4 |
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
| D1 128-131; CONTRIBUTING browser gate | 1 | E1 Node/browser agentic canonicalisation/export vectors and `pnpm verify:browser` |
| D2 146-157 | 4 | E4 kind enablement separate disclosure |
| D2 230-233, 320-323 | 4 | E4 approved singleton budget prepare/approve/claim/final pointer swap |
| D2 241-246 | 4 | E4 kind document grants no judge/rule authority |
| D2 392-399, 398, 422-425, 435-436 | 4 | E4 immediate kind disable and target/subscriber closure leave versions unrevoked |
| D2 462-469 | 6 | E6 final judge DNS/TCP/TLS/write fence |
| D2 471-500 | 9 | E9 closed human-only secret inventory |
| D5 1047 | 7 | E7 deterministic rule with all kinds off |
| D5 1049-1057 | 1 | E1 optional embedded-byte-equal agentic document/prefilter/kind validation |
| D5 1058-1071 | 6 | E6 documented vector/header/parser/token-bounded untrusted numeric answer validation |
| D5 1061-1064 | 8 | E8 exact uncertain band and hold resolution |
| D5 1072-1079 | 5 | E5 stable rolling ledgers, canonical provider, approved token maxima and immutable singleton |
| D5 1080-1096 | 5, 7 | E5 recovery terminalises post-I/O unknown; E7 real evaluator proves no re-ask |
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
| §4 2828 | 3 | E3 E-owned B3 build/ship prerequisite gate before owner/operation registration |
| §5 2856-2865 | 9 | E9 unapproved judge test zero-network |
| §5 2866-2883 | 5, 6, 7 | E5 durable accounting/recovery; E6 sealed vectors; E7 one-terminal-decision recovery proof |
| §5 2884-2891 | 4 | E4 kinds-off/disable matrix |
| §5 2937-2955 judge/budget clauses | 4 | E4 activation digest/wrong-kind claims |
| §5 2969-2976 judge/hold clauses | 5, 7 | E5 post-I/O terminalisation and E7 decision/delivery/purge crash matrix |
| §5 3298-3307 local-judge clauses | 6 | E6 sealed local-judge network matrix |
| §5 3308-3318 app/secret-window clauses | 10 | E10 desktop security contract |
| §5 3326-3336 | 3, 9 | E3 B3-stub build/ship failure; E9 parity rows |

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

docs(plan): phase E — apply plan review
