# Local event emission — Phase E2 implementation plan

> **For agentic workers:** implement one checked task at a time. Each checkbox is a delivery boundary: write its failing production-path test first, make the smallest change, run its focused proof and named mutant, obtain its narrow P1-only review, then commit it before a dependent task begins.

**Goal.** Make the existing, disabled-by-default `laya` judge kind usable only on macOS and only for the reviewed English ONNX bundle: install an integrity-pinned runtime and model after a human approves enablement, run it in a network-denied isolated worker, and make a release offer it only after the exact manifest/runtime/template has passed D11's labelled Gmail and Slack quality gate.

**Starting point and dependencies.** This plan starts on `feat/events-e` at `5cab45c6`, the converged B2 + Phase D tree with Phase E's revised plan. It is blocked on Phase E's implemented/reviewed contracts, including its `Plan review decisions (2026-10-10)`: `laya` remains a typed `E2_REQUIRED` unavailable state until E2, and E's B3 hard gate must land before E2 registers a judge owner or operation. It also has a final contract join with Phase C. It preserves every B1, B2 and D build decision, especially: the shared `assertDisclosable` fence; no post-await write without an in-transaction recheck; raw account/source identity; re-added accounts staying dark until re-approved; B2's raw pinned connection and loopback seal; and all work-orphaning purges cancelling their work. It uses, rather than recreates, E's judge kinds, enablement pointers, JudgeCoordinator request/answer path, reservation ledger/budgets, holds, and JudgeWorkPurgeParticipant.

**Architecture.** The daemon carries one strict reviewed manifest and a release-built lock, but has no Laya dependency. A private, unpublished workspace package exists solely to pin the third-party dependency closure in pnpm's lockfile. After E's normal kind-enable claim, an artifact manager fetches only lock/manifest-pinned bytes, validates/extracts them into owner-only partial trees, atomically promotes verified trees, and verifies both whole trees before every worker start. The daemon launches a separate Node child under macOS `sandbox-exec`; a probe proves the boundary before that child imports the native runtime or opens a model. The child returns only E's bounded judge answer over framed stdin/stdout; it receives no daemon credential, database, control token, provider session, socket, or inherited descriptor.

**Tech stack.** Node 22.18+ and pnpm 11; existing Node built-ins (crypto, fs, path, zlib, child_process, net/dgram only in the worker's boundary probe); SQLite through E; the E/B2 pinned-connection primitives; macOS `/usr/bin/sandbox-exec`; `@receptron/laya` 0.1.2, `onnxruntime-node` 1.30.0 and `@huggingface/tokenizers` 0.2.0 only in the private runtime declaration and the daemon-installed lock tree. No package-manager install script ever runs.

## Plan review decisions (2026-10-10)

| Question | Decision | Reason |
| --- | --- | --- |
| E2-A — Phase E seam and D8 migration | E retains only its opaque typed-unavailable `E2_REQUIRED` Laya registry member. After E's B3 gate has landed, E2 replaces that definition with the closed E2 callback ABI and owns the D8 `laya_models` migration; it does not ask E to infer an activation path. | This is the Phase E cross-plan contract: before E2 there is no pointer, approval, download, worker or network path. It preserves the B3-before-registration gate and assigns concrete Laya authority to E2. |
| E2-B — worker packaging | The daemon ships the worker code; `packages/events-laya-runtime` stays private, dependency-only and code-free. | The later D11 packaging rule is explicit and avoids a consumer-installable runtime surface. |
| E2-C — child inheritance | The child gets only `PATH=/usr/bin:/bin`, `TZ=UTC`, stdin/stdout and one bounded/redacted stderr pipe. It inherits no other descriptor or environment variable. | A closed allow-list is safer than inferring what Node might need. |
| E2-D — availability and per-start boundary | A no-runtime probe fails closed before enablement preparation, but is only an availability check. Every actual worker repeats the probe as its first act and receives the load frame only on its same nonce-bound pipes, profile, entry point and child PID. | This both makes a missing boundary “not offered” and proves that the process that loads native code passed the boundary. |
| E2-E — lock/extraction schema | The lock is versioned canonical JSON: raw-UTF-8-byte path order, explicit boolean `executable`, exact ASCII SRI text, and rejection of PAX and every special tar entry. | The format is deterministic without altering the case-sensitive `sha512-<base64>` SRI value. |
| E2-F — resume response | Resume accepts only `206` with an exact matching `Content-Range`; `200`, malformed/mismatched range and `416` delete the partial and restart. | A partial can become executable model state only after its complete hash verifies. |
| E2-G — update fence and races | Under one artifact mutex, compare the canonical embedded manifest bytes plus the complete canonical `runtimeLock` package list and the selected-platform canonical file list (not merely its digest); recheck pointer and epoch after every await. | A URL, version or integrity can change while a selected file-list digest does not. The full approval payload must still equal the release definition. |
| E2-H — Python reference and candidate subject | Task 9 is `E2_REFERENCE_BLOCKED` until the owner records the exact Python-reference repository URL, immutable revision, invocation, tokenizer/model inputs and report-excluding candidate-subject digest in the fetched-source record. | Per-item D11 parity cannot be inferred from a package name or a report that changes the candidate it claims to test. |
| E2-I — corpus governance | The corpus requires written consent, external encrypted retention controls, aggregate-only handling and an owner-operated protected macOS procedure; it never runs in ordinary CI. | A repository test or PR-controlled runner is not an acceptable trust boundary for real mail or Slack data. |
| E2-J — architecture offerability | arm64 may be offered with its own exact passing gate evidence. x64 is not offered until a separate exact x64 result, bound to that architecture and candidate subject, passes. | D11 explicitly requires Intel evidence before Intel is offered. |
| E2-K — SECURITY text | Task 10 keeps D2's two exact Laya SECURITY bullets and its byte-for-byte test; this is not an owner-decision blocker. | D2 already assigns these bullets to E2. |

### External-source record is a hard pre-build input

Planning fetched no external page, registry record, model host, sandbox evidence, package metadata or quality result. Therefore no external fact in this plan is evidence that a page was read. Before the task named in the final column is built, a coordinator—not the implementation task—must fetch the named source and record its URL, UTC date fetched, immutable revision or response digest, the exact fact relied on, and the reviewer who accepted it in `docs/superpowers/evidence/2026-10-10-e2-external-sources.md`. The record contains no corpus item, secret, token, address or downloaded artifact. The structural checker fails the task as `E2_EXTERNAL_REFERENCE_BLOCKED` if its required record is absent, stale, mutable, or does not name the fact used; no wire format is inferred from observed behaviour.

| Fact required before build | Coordinator-fetched source to record | First blocked task |
| --- | --- | ---: |
| Manifest host, repository/revision, file paths/sizes/SHA-256, publisher/origin/licences and the English-only ONNX candidate | `https://huggingface.co/api/models/receptron/laya-onnx/tree/<full-40-hex-revision>?recursive=true&expand=true` and `https://huggingface.co/receptron/laya-onnx/raw/<full-40-hex-revision>/README.md` | 2 |
| Direct runtime metadata, licence/source location, dependency/install-script facts and exact npm metadata/tarball provenance | `https://registry.npmjs.org/%40receptron%2Flaya/0.1.2`, `https://registry.npmjs.org/onnxruntime-node/1.30.0`, and `https://registry.npmjs.org/%40huggingface%2Ftokenizers/0.2.0`; every closure tarball origin subsequently derives only from that response's exact `https://registry.npmjs.org/` URL and exact SRI | 2 |
| HTTP redirect, `Range`/`Content-Range` semantics and the closed request-header rule | `https://www.rfc-editor.org/rfc/rfc9110` plus the immutable Hugging Face download/API material named by the manifest record | 4 |
| macOS `sandbox-exec` availability/deprecation/profile semantics and the four-attempt real-mac proof procedure | `https://keith.github.io/xcode-man-pages/sandbox-exec.1.html` and the owner-controlled, content-free real-mac gate result bound to its candidate SHA | 7 |
| Runtime API/template/output wire and tokenizer behaviour | the exact, SRI-verified `@receptron/laya` tarball URL recorded from `https://registry.npmjs.org/%40receptron%2Flaya/0.1.2`; the coordinator records the immutable package bytes and source paths/fields used for `Laya.load`, request rendering, output parsing and token counting | 8 |
| Python-reference identity, model/tokenizer invocation and D11 quality-input provenance | the owner-selected immutable Python-reference repository URL and revision, plus the immutable weights-source revision recorded with the manifest | 9 |

The record is an input to implementation, not a substitute for the release evidence. A changed URL response, revision, licence, host, package origin, wire field, sandbox result or reference invocation starts a new review and blocks the dependent task until its changed fact is recorded and approved.

## Global constraints

- Read and retain the interfaces and decisions in Phase E before changing a judge path. `JUDGE_KINDS` in `packages/events-daemon/src/domain/lifecycle.ts` remains the one vocabulary; no Laya module writes a parallel union or string list.
- The only enablement fact remains E's active `active_versions(kind = 'judge-kind', object_id = 'laya')` pointer. Fresh database, install, update and import mean disabled. E2 adds no boolean cache, alternate approval, alternate budget, alternate hold, rule activation, CLI command, MCP tool, send path, source or target.
- E2 uses E's normal `judge kind enable` prepare/approve/claim/finalise path. MCP still prepares only. Linux and Windows reject `laya` before an intent, approval, download, model row or worker exists. On macOS an unavailable/missing boundary also refuses before prepare.
- E's coordinator remains sole owner of deterministic prefilter → minimised fixed envelope → taint flush → reservation → in-flight transition → answer settlement/hold. The Laya adapter cannot see an event id, account id, target, secret, arbitrary endpoint, mutable model URL, or a provider-directed outcome; it returns only E's finite score, actual input token count, and closed reason.
- The Laya provider identity is E's canonical `laya` provider id. E must refuse a Laya per-provider concurrency ceiling above one; the supervisor independently permits one request at a time. A malformed/token-overflow/crashed/timed-out worker result is E's no-match, never a retry that re-asks.
- The model is English-only, CPU-only and 512-token-context in version 1. Do not add language detection, GPU providers, the multilingual checkpoint, another runtime, Linux isolation, a Windows launcher, an HTTP listener, or an installer bundle; each is D15 work.
- The runtime/model use no event content in their download requests. Production fetching uses no `fetch`, npm, npm cache, .npmrc, proxy, redirect helper, agent, install script, cookie, Authorization header, or token. Tests use only injected fakes or sealed loopback fixtures and synthetic `.test` names.
- Tests never call a real provider, model host, registry, Gmail, Slack, Resend, WhatsApp, keychain, or send endpoint. The real bundle/labelled quality gate is an explicit protected macOS release-gate activity, never part of `pnpm verify`.
- Every ordinary CI, verification and developer setup install excludes `@agentcomms/events-laya-runtime` and is proven from a cold pnpm store to acquire none of its real closure. Real runtime tarballs are acquired only by the owner-controlled supply-chain gate after the external-source record is approved; ordinary tests consume synthetic tarballs only.
- Keep `@agentcomms/events` and `@agentcomms/events-daemon` held. E2 adds no published dependency from the daemon to Laya/ONNX and never removes either hold.
- Every batch ends with root `pnpm verify`. Any task that changes `packages/events` also runs `pnpm verify:browser`; this plan should not need to change that package.

## File and ownership map

| Area | Files created or changed | Responsibility |
| --- | --- | --- |
| E compatibility | `packages/events-daemon/src/domain/judges.ts`, `domain/activation-documents.ts`, `runtime/judge-coordinator.ts`, `runtime/judge-budget.ts`, `store/migrations.ts`, `store/records.ts` | E's typed Laya registry executor, strict enablement document, model-state record and bounded coordinator adapter contract |
| Reviewed assets | `packages/events-daemon/laya-manifest.json`, `laya-runtime.json`, `packages/events-laya-runtime/package.json`, `README.md`, `THIRD_PARTY_LICENSES` | One reviewed English manifest; private dependency declaration; canonical generated runtime lock shipped in daemon tarball |
| Artifact lifecycle | `src/runtime/laya/{manifest,lock,artifact-paths,fetcher,tar,runtime-installer,model-downloader,tree-verifier,manager}.ts` | Strict fetch/extract/resume/promote/verify/update/remove lifecycle |
| Worker boundary | `src/runtime/laya/{worker-protocol,worker-boundary-probe,worker-main,worker-runtime,templates,worker-supervisor}.ts` | macOS sandbox launch, self-test, framed worker protocol, no-network defence in depth, timeout/idle/crash containment |
| Existing operations | `src/operations/judges.ts`, `operations/doctor.ts`, `runtime/owner.ts`, `runtime/judge-purge.ts`, B3/C generated contract types | Existing `judge model status|remove`, kind lifecycle, purge hook, doctor and app DTO integration; no new capability |
| Reproducibility/release | `scripts/fetch-laya-release-tarballs.mjs`, `scripts/laya-runtime-lock.mjs`, `scripts/run-laya-macos-boundary-gate.mjs`, `scripts/verify-laya-quality-gate.mjs`, `.github/workflows/release.yml`, `.github/workflows/laya-quality-gate.yml` | Release-only SRI-verified acquisition, deterministic lock reconstruction, protected real-mac boundary/quality evidence and release refusal |
| Tests | `packages/events-daemon/test/laya-*.test.ts`, `test/fixtures/laya/cases/*.json`, `test/support/laya-*.ts`, `scripts/verify-events-phase-e2-tests.mjs` | Production-path tests, tiny synthetic artifacts/fakes, immutable per-task mutation fragments and structural enforcement |

## Decisions the spec leaves to the plan

### E2-1 — complete Phase E's registry seam before installing Laya

Phase E retains the existing `laya` registry member as `E2_REQUIRED`. E2 replaces only that unavailable definition with a typed `LayaJudgeKindDefinition`. Its closed interface is:

~~~text
availability(platform, paths): JudgeKindAvailability
prepareEnablement(): CanonicalLayaEnablement
onEnabled(enablement, activation): Promise<LayaModelStatus>
execute(request, reservation): Promise<JudgeAnswer>
onWorkPurged(scope): Promise<void>
onDisabled(): Promise<void>
status(): LayaModelStatus
removeWhenDisabled(): Promise<LayaModelStatus>
~~~

It is called only by E's existing registry/coordinator/purge hooks. `availability` returns a content-free reason; it never downloads. `prepareEnablement` selects only the daemon-shipped manifest and matching lock, never a caller-supplied ID/URL/path. `execute` receives E's already minimised, taint-flushed request and returns E's answer shape. The C/B3-facing `LayaModelStatus` is exactly E/C's `idle | installing | downloading | verifying | ready | failed | unavailable`, with only manifest id, lock digest, verified/total bytes, closed failure code, platform/boundary reason and updated time; no filesystem path, input, request/response, key or token appears. D8's durable `laya_models.state` is separately and exactly `installing | downloading | ready | failed | removed`; a disabled/removal-complete row maps to the presentation state `idle`, rather than adding `removed` to E/C's closed DTO.

Reason: E explicitly reserves a registry slot that E2 later installs, while D10/D13 already reserve model status/remove and C's immutable progress slot. A registry callback is the narrowest seam that preserves E's one coordinator, one budget ledger and one purge closure.

Reasonable alternatives rejected: a second Laya-only evaluation pipeline would bypass E's taint/budget/hold fences; a direct operation-owned downloader would fork kind lifecycle; accepting a manifest ID or local path from CLI/MCP would turn enablement into arbitrary code/data loading; treating Laya as a local endpoint would create a listener and lose the OS boundary.

### E2-2 — reviewed manifest is a strict, single-entry daemon asset

Create `packages/events-daemon/laya-manifest.json`, canonical JSON with `manifestVersion: 1` and exactly one entry: D11's `laya-en-onnx-68f27dfe` candidate unless the E2 gate reviews/replaces it. Validate an exact object: manifest id; source host `huggingface.co`, repository and full lowercase 40-hex revision; weights publisher/origin/origin SHA-256/licence; raw-UTF-8-byte-sorted unique safe relative files with exact size and lowercase SHA-256; direct-runtime preview versions; `context.maxTokens: 512`; `context.language: "en"`; and the two immutable template ids `laya-choice2-v1` and `laya-noul-v1`. Refuse unknown fields, noncanonical sort order, a duplicate, backslash, NUL, absolute path or dot segment.

The activation document embeds the selected entry verbatim and the canonical `runtimeLock` object: its complete sorted package list (name, version, exact tarball URL and exact ASCII SRI) and the selected macOS platform's complete canonical file list plus its SHA-256 digest. It compares those canonical bytes on update; a digest alone is not an update fence. It binds direct package versions only as reviewed preview text; the lock is the install authority. The enablement preview is derived only from these reviewed assets and says the manifest/runtime sources, their licences and sizes, English-only, 512-token context, CPU-only, macOS-only `sandbox-exec` boundary limitation, model and runtime disk estimates, roughly 2 GB worker memory, one-at-a-time execution, download-after-approval and every stated limitation/unavailable reason. Template content lives in the daemon worker source, has a stable id and SHA-256 in the gate subject digest, and changes semantically only with a new template id/manifest entry. That avoids silently giving a new prompt the old labelled result or enablement approval.

Reasonable alternatives rejected: a remote manifest, a flexible manifest schema, a branch/tag revision, or a model selector in a rule would defeat reviewed immutable approval bytes; including arbitrary prompt text in the activation document duplicates daemon code and does not make the shipped worker safer.

### E2-3 — private package pins dependencies; release-built lock is the sole installer authority

`packages/events-laya-runtime` is private, has no `agentcomms` or `agentcommsPackage` declaration, exports no code, and is absent from publication. Its exact dependencies declare the three direct packages and their full pnpm-resolved closure; `allowBuilds` remains empty. The daemon has none of these packages in dependencies, optionalDependencies, bundledDependencies or its resolved packed dependency tree.

`scripts/fetch-laya-release-tarballs.mjs` is the one release-only acquisition path. Under the owner-controlled supply-chain gate it requests only an exact lock URL whose origin is exactly `https://registry.npmjs.org`, streams the raw bytes through an exact, case-preserved `sha512-<base64>` SRI verifier before extraction, and passes verified raw bytes directly to the builder. It accepts neither an alternate HTTPS origin nor an npm cache, user config, package-manager install, injected “verified” label or pre-existing tarball. `scripts/laya-runtime-lock.mjs` then deterministically builds `packages/events-daemon/laya-runtime.json` from that workspace declaration, the root lockfile and this verifier's bytes. The canonical lock has a schema version, sorted package list of exact name/version/`https://registry.npmjs.org/` tarball URL/exact ASCII SRI, and macOS arm64/x64 entries containing the complete installed `node_modules/` tree's safe path, size, SHA-256 and explicit boolean executable bit. It is byte-for-byte canonical JSON. The daemon package lists the root asset in `files`, reads it relative to its own installed package, and consumer-tarball tests prove it is present.

The supply-chain gate reconstructs the lock with the same strict extractor from each SRI-verified raw tarball, compares it byte-for-byte with the committed asset, then packages the daemon. Normal CI/workflow/install commands use an explicit negative workspace filter and a cold-store proof so they never fetch this closure; unit tests use tiny synthetic tarballs and a fixture lock only. The release reconstruction is the explicit externally networked supply-chain gate, not npm installation on an end-user machine.

Reasonable alternatives rejected: a lockfile plus `npm ci --ignore-scripts` still trusts user npm config/layout and requires a pinned npm; shipping native packages in the daemon makes every user install native code; publishing the runtime package makes it a consumer-installed API; dynamic package installation lets package-manager scripts/cache/registry settings become authority.

### E2-4 — daemon fetches only pinned bytes and promotes only complete verified trees

Use one production `LayaArtifactFetcher`, implemented over B2's raw pinned resolution/TCP/TLS request primitives and IANA policy, not `fetch` or Node HTTP clients. For tarballs, it accepts only the lock's exact HTTPS URL and streams through a SHA-512 integrity verifier. For model files it constructs only:

~~~text
https://huggingface.co/<repo>/resolve/<full-40-hex-revision>/<manifest-path>
~~~

It follows at most five redirects; every hop is HTTPS, resolves only to globally reachable non-metadata addresses, and has no approved-address-set exception. The exact request allow-list is protocol-required `Host`, product/version `User-Agent`, and only for a rehashed model resume `Range: bytes=<verified-partial-length>-`; every other optional header—especially cookie, `Authorization`, proxy, `Accept*`, forwarding or token header—is rejected before bytes are sent. Redirect target, status/header bounds, TLS name/address gates and byte stream are journalled only as content-free closed codes.

The strict tar reader accepts only regular files rooted at `package/`; it rejects links, devices, FIFOs, special/PAX entries, absolute paths, `..`, backslashes, NUL bytes and any duplicate. It rejects a duplicate even when unlisted, skips only safe unlisted regular entries, and writes only lock-listed files as owner-only files under `runtime/<lockDigest>.partial/`. After every listed file's size/SHA-256 matches, a single rename promotes `runtime/<lockDigest>/`.

Model downloads stream into `models/<manifestId>.partial/`, hash every byte, abandon immediately above manifest size, delete/retry a bad file up to five times, and rehash a partial before a single `Range` resume. Resume accepts only `206` and an exact `Content-Range: bytes <requested-start>-<returned-end>/<manifest-size>` that starts at the rehashed length, ends within the declared size and names that total; a `200`, ignored/malformed/mismatched range or `416` deletes the partial and restarts it. Check free disk space for remaining bytes plus ten percent before the first request. Only after every exact file verifies does one rename promote `models/<manifestId>/` and E's `laya_models` row become `ready`.

Reasonable alternatives rejected: trust-on-size, a CDN allow list, accepting a branch, resuming without rehashing, individual file promotion, archive extraction by system `tar`, or retaining a bad partial lets unreviewed/mixed data become executable model state.

### E2-5 — full-tree verification and update are fail-closed lifecycle transitions

Immediately before every new worker starts, walk each selected runtime/model directory with `lstat`, compare the complete sorted relative-file set to the selected lock/manifest, and require every type, size, SHA-256 and executable flag to match. Missing, extra, altered, resized, link or traversal entries fail. No worker process is spawned and no native module/model is imported until both checks pass. On a failed tree, atomically mark content-free `integrity`, delete only the failing selected tree under the artifact mutex, reinstall/redownload it once from its pinned source, reverify, then leave Laya `failed` if the new tree still fails.

At daemon start, under the artifact mutex, compare the active Laya enablement's embedded manifest canonical bytes and its complete canonical `runtimeLock` package list plus selected-platform file-list bytes with this release's assets. A URL, version, SRI, package membership, executable bit, path, size or SHA-256 change disables; the selected-platform digest is asserted only as a consistency check, never as the sole comparison. If either differs, including a downgrade, call E's existing immediate kind-disable tightening with closed audit reason `model-changed` or `runtime-changed`; retain verified directories, never auto-approve, and wait for a new enablement. A worker-code-only release makes no comparison change. Delete an obsolete verified tree only after its replacement has verified and no enabled entry names it, or through existing `judge model remove` while Laya is disabled.

Reasonable alternatives rejected: checking only a lock digest stored in SQLite, checking first use only, overwriting old trees, retaining a current pointer through changed weights, or using package version as the update signal cannot prove the native files actually loaded.

### E2-6 — macOS sandbox boundary is availability and is re-proved at every worker start

On macOS only, launch the child with literal arguments:

~~~text
/usr/bin/sandbox-exec -p "(version 1) (allow default) (deny network*)" <absolute node> <worker entry>
~~~

No shell is used. The spawn uses only stdin/stdout/stderr pipes, an explicit small environment (`PATH=/usr/bin:/bin`, `TZ=UTC`), a 0700 working directory, and no inherited `AGENT_COMMS_*`, token, proxy, `LAYA_*`, `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`, database/control descriptor or provider session. The profile string, executable path and descriptor list are asserted by tests.

Before enablement preparation, a no-runtime probe under the literal profile establishes only whether this machine can offer Laya; it opens no model/runtime and fails closed as `unavailable`. Before every actual worker load, the daemon opens disposable loopback TCP and UDP listeners plus a pathname Unix-domain listener in a fresh owner-only data subdirectory, then starts the actual worker once under the literal profile. That same child—same PID, executable, profile, stdin/stdout pipes and random probe nonce—imports only Node built-ins as its first act, attempts TCP, UDP send, Unix-domain connection and `fetch`, reports bounded closed results, and proves framed pipes still work. The daemon accepts only failed TCP/fetch/UDS attempts with neither TCP/UDS listener accepting, and a worker-side UDP failure with the UDP receiver observing zero datagrams. Otherwise it kills that child, stores only `boundary-failed`, and never sends it a load frame. On success, it sends the nonce-bound load frame on those same pipes; a second spawn, changed profile/entry or changed pipe generation is a failure before load. This sequence runs for each new worker, including after a crash. Missing `sandbox-exec`, a failed profile, Linux and Windows are `unavailable` and reject enablement before approval/download.

After the probe, the worker replaces `globalThis.fetch` with a thrower, patches network constructors used by the runtime to throw, and source/AST checks forbid network imports other than the probe module. These are defence in depth only; no code promise substitutes for the OS boundary.

Reasonable alternatives rejected: an in-worker fetch stub alone, a container/namespace that leaves pathname UDS reachable, a TCP-only self-test, inheriting the normal daemon environment, or treating deprecated `sandbox-exec` as always present all weaken the stated v1 boundary. Linux/Windows support stays D15.

### E2-7 — one framed worker is a resource/fault boundary, not a second authority

The worker starts lazily, accepts one length-prefixed JSON request at a time, and exits after ten idle minutes, on daemon stop, kind disable, purge of its in-flight reservation, crash, boundary failure or a 30-second request deadline. Frames have E's request/response caps, closed schema and random request id; the id derives from the reservation/work id but the frame has no event/account/target/raw source identity. The daemon kills, waits and drops all late frames on timeout/crash; E settles the reservation as unknown/estimated and emits no-match. A later approved call starts a fresh worker.

Only after the self-test and tree verification does the child dynamically load the exact extracted `@receptron/laya` entry and call `Laya.load({ modelDir, executionProviders: ["cpu"] })`. It receives the verified directory and no downloader options; a structural test proves the package's default downloader is never reachable. It tokenises the already bounded input and refuses rather than truncates at 512 tokens. It renders only manifest-listed `laya-noul-v1` or `laya-choice2-v1`, accepts its own finite [0,1] Noul/affirmative-choice probability unchanged, returns actual `usage.input_tokens`, and rejects any other shape as malformed.

Reasonable alternatives rejected: loading native code in the daemon, workers/threads in the daemon process, multiple workers, native ONNX calls directly, kill-less JavaScript cancellation, prompt-selected templates, silently truncating, or returning a model-provided match/reason text all break a stated fence or E's answer authority.

### E2-8 — the D11 quality gate is aggregate-only, reproducible and release-blocking

The gate uses an external, consented corpus of the owner/colleagues' Gmail and Slack messages and human labels, stored outside the repository and never uploaded to CI, fixtures, logs or gate artifacts. A written consent/provenance ledger remains with the corpus owner outside the checkout. Repository tests use only a tiny synthetic labelled metric vector and a non-executable tiny model fixture; neither claims Laya quality.

The protected macOS gate command runs the exact candidate's built worker under the sandbox against the external corpus. For each manifest/template/channel it records only a schema-validated aggregate in `packages/events-laya-runtime/gate/<manifestId>.json`: manifest canonical SHA-256, lock SHA-256, platform file-list digest, runtime direct versions, template id/digest, gate-subject digest, runner/version/reference identity, channel item count, positive share, aggregate language mix, ten-bin ECE, Brier, AUROC, maximum Python-reference probability delta, warm p95 latency, peak worker memory and aggregate length-refusal/result counts. It rejects an artifact containing a message, subject, address, Slack handle, event id, rule question, per-item score, raw label, path, secret-looking value or unknown field. A sibling content-free `macos-boundary-v1.json` is bound to the same candidate subject and architecture; it records only pass/fail plus closed codes for TCP, `fetch`, UDP (including zero receiver datagrams), UDS, pipe liveness, native load, timeout/crash/idle restart and altered-tree repair.

For Gmail and Slack separately, each template needs at least 200 labelled pairs and 30% positives, ECE <= 0.10, Brier <= 0.20, AUROC >= 0.80, every worker probability within 0.001 of the pinned Python reference, warm p95 <= 2 seconds and peak <= 3 GB on Apple silicon; repeat on Intel before Intel is offered. The release validator recomputes the gate-subject digest from the release's manifest, lock, worker/template source and package build inputs. It refuses if any offered template lacks a passing exact aggregate. A failed template is removed only by a new reviewed manifest/enablement entry; if no template passes, the release offers no Laya.

Reasonable alternatives rejected: synthetic data as the release gate, a shared real-mail fixture, aggregate metrics without manifest/lock/template binding, one combined Gmail+Slack score, model-card calibration claims, or merely warning in release notes do not earn D5's probability label.

### E2-9 — test the dangerous mechanics locally; prove the operating-system claim on real macOS

`pnpm verify` exercises production manager/coordinator code with injected clock, filesystem, resolver/socket/child spawner and Laya-runtime stand-in. Tiny gzipped tarballs and a five-file non-executable tiny model exercise lock generation, extraction, fetch/resume/promotion and tree failures. A sealed loopback fixture and injected address policy exercise redirect/range/header behavior; no test permits an external address. Child-process integration uses a frame-compatible stand-in entry; direct worker unit tests inject a `LayaRuntime` stand-in. The shipped worker's production entry has no test-mode argument or ambient test environment escape.

The E2 gate job, outside `pnpm verify`, runs a clean release candidate on real macOS: both architectures before offering them; absence/profile-failure; TCP, UDP, fetch and pathname UDS denial while pipes work; actual native runtime/load; timeout/crash/idle restart; model/tree mutation after a prior verified start; packaging/lock reconstruction; and the consented quality run. `scripts/run-laya-macos-boundary-gate.mjs` produces the required content-free architecture- and candidate-subject-bound boundary artifact, and the protected workflow validates it before a release can offer Laya. The manual checklist is supplemental owner evidence only; it is never a substitute for the machine gate.

Reasonable alternatives rejected: mocking `sandbox-exec` as proof, adding a real 1.69 GB model to fixtures, importing ONNX in ordinary unit tests, running label data in a public workflow, or treating a green typecheck as native/runtime evidence.

### Decision-to-task audit

No plan decision is merely prose. The structural verifier contains this mapping and fails if its task, named test, or paired mutation is removed.

| Plan decision | Implementing task(s) | Named proof |
| --- | ---: | --- |
| E2-1 typed E registry seam, one pointer and E coordinator/budget/hold reuse | 1, 6, 8 | `E2 canonical Laya enablement vectors` |
| E2-2 strict reviewed English manifest, preview and immutable templates | 1, 2, 11 | `E2 manifest/preview canonical vectors` |
| E2-3 private declaration, exact-origin/SRI acquisition and release-built runtime lock | 2, 5, 10 | `E2 runtime lock rebuild` |
| E2-4 fixed-purpose verified fetch, strict extraction and resumable model promotion | 4, 5, 6 | `E2 model download matrix` |
| E2-5 whole-tree verification, repair and complete-lock update tightening | 5, 6 | `E2 tree verifier/update matrix` |
| E2-6 macOS-only OS boundary, same-child self-test and protected real-mac proof | 7, 10 | `E2 boundary probe fence`, `E2 macOS boundary gate` |
| E2-7 one isolated framed worker and E-only answer authority | 8 | `E2 Laya supervisor timeout/crash/idle` |
| E2-8 consented aggregate quality evidence, immutable Python reference and pre-release refusal | 9, 10 | `E2 quality reference gate`, `E2 release rejects stale Laya evidence` |
| E2-9 synthetic CI/fakes plus protected real-mac proof | 10, 13 | `E2 macOS boundary gate`, `E2 end to end held path` |

## Owner-controlled inputs and ratifications

| ID | Decision now applied | Blocking action or ratification |
| --- | --- | --- |
| E2-A | E stays opaque `E2_REQUIRED`; E2 owns its concrete callbacks and D8 migration. | E's B3 hard gate must be present before Task 1 registers the replacement. |
| E2-B | Worker code is in the daemon; the private runtime workspace has no code. | Record the packaging clarification with the implementation review. |
| E2-C | `PATH`, `TZ`, stdio and bounded/redacted stderr only. | Task 7's exact environment/fd vector and mutant ratify the closed contract. |
| E2-D | Pre-prepare no-runtime availability probe and same-child, nonce-bound pre-load probe. | Task 7 must prove no second spawn/profile/pipe substitution can load native code. |
| E2-E | Versioned strict JSON, raw-byte order, boolean executable, PAX/special rejection and exact SRI text. | Task 5 rejects every incompatible closure/archive before Task 2 builds the reviewed lock. |
| E2-F | Exact `206` plus matching `Content-Range`; restart on `200`, malformed/mismatch or `416`. | Task 4's resume matrix and named mutants enforce it. |
| E2-G | Compare canonical embedded manifest plus complete package list and selected-platform list under mutex/epoch fences. | Task 6's URL/SRI-only change vector must yield `runtime-changed`. |
| E2-H | Immutable Python source/revision, invocation/tokenizer/model inputs and report-excluding subject digest are mandatory. | The coordinator records them before Task 9; otherwise it is `E2_REFERENCE_BLOCKED`. |
| E2-I | Consent, encrypted external retention, protected runner and aggregate-only output are mandatory. | Task 9/10 refuse corpus use outside the owner-controlled procedure. |
| E2-J | Arm64-only is allowed; x64 needs separately subject-bound exact evidence. | Task 10's release validator refuses an architecture with no matching gate result. |
| E2-K | Preserve D2's byte-exact SECURITY bullets. | Task 10 owns their mechanical proof; no owner decision is needed. |

## Automatic defenses for recurring defect classes

### Write after await: E2 ledger and mutation proof

Every row below is registered in its immutable task-owned fragment under `test/fixtures/laya/cases/`; no parallel task writes a shared case manifest. Its named test pauses the real production seam, mutates the specified authority through the production lifecycle operation, resumes it and proves the stale write/load/answer did not happen. `scripts/verify-events-phase-e2-tests.mjs` rejects a new async artifact/worker method not in the ledger.

| Await or external boundary | Subsequent write/action | Recheck inside the owning mutex/transaction | Named test |
| --- | --- | --- | --- |
| E enablement claim → artifact job start | `laya_models = installing` | exact active Laya pointer, embedded manifest/lock, kind availability, job epoch | `E2 enablement claim starts no stale install` |
| free-space/stat/hash/read → runtime partial write/promote | partial/final runtime tree and state | lock digest, artifact job epoch, current pointer or disabled-safe cleanup, exact lock entry | `E2 runtime promotion after disable race` |
| model Range response/hash → partial write/promote/ready row | model file rename and `ready` | active pointer, manifest bytes, partial hash/size, job epoch, no remove/disable | `E2 model resume finalisation race` |
| tree walk/hash → delete/reinstall/failure status | selected tree mutation and `failed` | selected manifest/lock, worker generation, artifact mutex epoch | `E2 integrity repair cannot replace changed selection` |
| current release asset read → kind-disable tightening | pointer removal/audit | still-active exact Laya pointer and same canonical manifest/package-list/platform-list bytes | `E2 update compare does not disable a re-enabled version` |
| boundary probe child result → send worker load frame | native import/load | same child PID/profile/entry/pipe generation, exact probe nonce, TCP/UDP/UDS listeners saw zero, tree verification generation, kind still enabled | `E2 boundary probe fence` |
| worker answer/exit/timeout → return to coordinator | answer or closed failure | reservation/work id still in-flight and scoped, kind/switch/account/rule live through E's final settlement | `E2 late worker result is discarded` |
| remove filesystem work → removed status | delete/promote model/runtime directories | Laya remains disabled, remove generation owns selected paths, no later enable owns job | `E2 model remove versus re-enable` |
| purge/disable request → child kill/download abort | completion/cancellation bookkeeping | exact JudgeWorkScope and active child/request id; E purge remains authoritative | `E2 purge kills only its in-flight Laya work` |

Mutants remove each stated recheck, substitute an old pointer/digest, promote before hash completion, or accept a late answer. The named case alone must fail.

### Identity and scope

All event work continues to use E's `JudgeWorkScope`: stable account id plus source and exact event/rule/rule-version/judge-version/reservation/decision ids where applicable. A worker receives only a random work/reservation id, not an account alias, source identity or event id. SQL delete/update for judge work keeps account/source predicates inherited from E; model state is installation-global and keyed only by reviewed manifest id, never a user path. Runtime tree keys are lock digest; model tree keys are manifest id; neither accepts an externally supplied value. `JUDGE_KINDS` is imported from lifecycle, template IDs from the manifest module, and channel vocabulary from the channel package—never re-derived.

`laya-scope.test.ts` uses two same-looking account ids/sources, a re-add and a stale alias while a Laya request is in flight. Static checks reject a raw external identity in model/runtime SQL, a duplicate kind literal, a worker frame containing account/event/target fields, or a daemon dependency on Laya packages. Removing an account/source predicate or stable-id assertion is a named mutant.

### Every purge path cancels what it orphans

E2 registers no parallel cleanup. E's `JudgeWorkPurgeParticipant` invokes `onWorkPurged` for exact Laya work; kind disable additionally aborts model download, kills the worker and removes partial trees, but retains verified trees. Account removal, rule/judge revoke, visibility hide, projection/ingest expiry, hold expiry, disable-all and budget/cancellation only stop matching in-flight work; they do not delete the installation-wide verified runtime/model. `judge model remove` is allowed only with no Laya pointer and uses the artifact mutex.

`laya-purge-closure.test.ts` seeds reserved/in-flight Laya requests, queued model download, probe child, idle child and model/remove state through real lifecycle paths; it invokes every E purge caller, restarts, and asserts no late answer, child, partial tree, claim or reservation survives beyond the correct scope. The registry test fails if a new E purge caller omits Laya work cancellation.

### Tests that bite

Every named case calls production activation/lifecycle, artifact manager, E coordinator or worker supervisor against SQLite and real filesystem temp roots. Fakes are limited to clock, free-space probe, resolver/socket, raw-byte origin, child spawner and Laya runtime. No test-local budgets, model state, parser or decision ledger is permitted. `test/support/laya-mutants.ts` applies exactly one source change to a copied production module and runs only the mapped named case. The structural verifier requires one owner for every §5 row, traceability row, await row and fixture, one mutation per guard, a loopback seal for any socket fixture, and failure for an orphan/duplicate/skipped mapping, test-local model, external hostname, raw corpus field, absent external-source record, shared mutable case manifest or normal-CI runtime tarball acquisition.

## Batches, dependencies and safe parallelism

There are **13 implementation tasks in eight ordered batches**. Task numbers are stable traceability identifiers, not execution order. A task is one sitting for one builder. Every batch finishes by integrating its completed work, running `pnpm verify`, recording the result, and leaving no worker/loopback server running.

| Batch | Tasks | Safe parallel group and join |
| --- | --- | --- |
| 0 — proof and ordinary-CI fence | 3 | Completes first. It creates the mutable-proof harness, immutable per-task fragment scheme and cold-store CI exclusion before any task may claim a paired mutant or add the private importer. |
| 1 — strict parser and reviewed inputs | 5 → 2 → 1 | Serial. Task 5 delivers the synthetic strict parser API; after the fetched-source record exists, Task 2 builds reviewed assets through it; Task 1 then consumes those real daemon assets. One owner integrates lockfile/manifest/migration edits. |
| 2 — artifacts and execution boundary | 4 and 7, then 6, then 8 | Tasks 4 and 7 may run in separate worktrees after Task 1, because each adds only its own immutable case fragment. Task 6 joins Task 4/5/1; Task 8 joins Task 6/7. |
| 3 — quality/release gate | 9 → 10 | Serial. Task 9 is blocked on E2-H's source record; Task 10 joins its protocol, owns the runtime README and installs both protected machine gates. |
| 4 — desktop/control join | 11 | Blocked until Phase C and B3 land; it changes no app-owned implementation beyond a shared daemon DTO/vector correction. |
| 5 — exhaustive safety proof | 12 | Serial audit of every prior E2 path and all E interfaces it invokes. |
| 6 — final evidence | 13 | Serial after all joins; the checklist remains supplemental to Task 10's protected machine artifacts. |
| 7 — split end-of-phase review | all completed tasks | The final area reviews run in parallel from isolated review worktrees after Task 13. |

Do not share migration/lockfile/manifest/README edits between active worktrees. Case registration is fragment-only: a task creates `test/fixtures/laya/cases/task-<n>.json` and never edits another task's file. Rebase before each join, run named tests and mutants, then run the batch command. The riskiest tasks are 1, 4, 6, 7, 8 and 12.

The task headings below retain their original identifiers for traceability; execute them only in the batch-table order above: **3 → 5 → 2 → 1 → (4 and 7) → 6 → 8 → 9 → 10 → 11 → 12 → 13**. A task does not begin merely because its numbered heading appears earlier in this document.

## Detailed tasks — reviewed assets and E2 registry seam

### Task 1 — close the E2 registry, enablement and model-state seam (highest risk)

**Files.**

- Modify: `packages/events-daemon/src/domain/judges.ts`, `packages/events-daemon/src/domain/activation-documents.ts`, `packages/events-daemon/src/domain/lifecycle.ts`, `packages/events-daemon/src/domain/versions.ts`, `packages/events-daemon/src/runtime/judge-coordinator.ts`, `packages/events-daemon/src/runtime/judge-budget.ts`, `packages/events-daemon/src/store/migrations.ts`, `packages/events-daemon/src/store/records.ts`, `packages/events-daemon/src/operations/judges.ts`, `packages/events-daemon/src/operations/doctor.ts`
- Create: `packages/events-daemon/src/runtime/laya/contracts.ts`, `packages/events-daemon/test/laya-contract.test.ts`, `packages/events-daemon/test/laya-enablements.test.ts`, `packages/events-daemon/test/fixtures/laya/cases/task-1.json`

**Consumes.** Task 3's completed mutation harness; Task 2's reviewed daemon manifest/lock assets; E's `JUDGE_KINDS`, active judge-kind pointer, `JudgeKindDefinition`, `JudgeCoordinator`, reservation state machine, B3 `judge model status|remove` operations and C's fixed model-status states. It may start only after E's B3 owner/operation-registration gate is present.

**Produces.** The E2-1 typed registry ABI; exact strict `CanonicalLayaEnablement`; D8 `laya_models` schema/model-state repository; a laya provider concurrency validator; safe DTOs used by tasks 6–13. It exposes no new operation/capability row.

- [ ] **Step 1: Write failing canonical, preview and surface vectors.** Add strict manifest-shaped enablement vectors: every manifest field/file order, every runtime package name/version/exact URL/exact SRI, selected-platform complete file-list field/digest and template id mutates the D2 digest. Freeze the terminal/daemon approval preview: English-only, 512-token context, CPU-only, macOS-only `sandbox-exec` boundary limitation, download-after-approval, model/runtime sources, sizes and licences, model/runtime disk estimates, roughly 2 GB memory, one-at-a-time execution, and every stated unavailable/accuracy limitation must be present and derive only from reviewed assets. Linux/Windows and absent sandbox refuse before intent; unknown model status fields, a caller-chosen manifest/path/template and Laya provider concurrency >1 refuse. Seed a database and prove exactly the D8 `laya_models` states/fields, no path/content, and no pre-claim state row or download.
- [ ] **Step 2: Run the focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 contract|laya enablement|laya model state'
  ~~~

  Expected: failures identify the absent E2 ABI/strict document/model record, never an external request.
- [ ] **Step 3: Replace only E's unavailable seam.** Implement the E2-1 registry contract only after E's B3 gate; install Laya by replacing E's unavailable definition, not by amending E with a concrete authority path. Make `canonicalEnablement` embed exactly the daemon-reviewed manifest and complete canonical runtime-lock object; add the next forward migration for the D8 model table. Make status/remove route through the already existing B3 operation functions and keep MCP enable prepare-only.
- [ ] **Step 4: Make availability, preview and budgets closed.** Implement the no-runtime macOS pre-prepare probe as a content-free availability result, render the frozen preview solely from reviewed assets, and require the canonical `laya` provider concurrency ceiling <= 1. Keep dynamic probe output out of the approval/document digest except its stated platform/boundary facts.
- [ ] **Step 5: Add paired mutants.** Delete the pointer check; accept caller manifest bytes; create a model row before claim; accept a concurrency of two; omit a lock URL/SRI/package/platform-file/template field; omit or drift one required preview disclosure; or expose a filesystem path. Each must fail its unique vector.
- [ ] **Step 6: Review and commit.** P1-only review: E2-only concrete registry authority after E's B3 gate, one vocabulary, no implicit enablement, no new activation/capability, complete canonical byte equality, exact preview, pointer/model-state ownership, and no secret/content DTO. Commit:

  ~~~text
  feat(events): define the bounded Laya judge-kind seam
  ~~~

**Passing.** The vectors prove Laya is unavailable until E's normal approved pointer exists, no E2 side effect occurs before it, and the exact human preview has every D11 fact. Then run `pnpm verify`.

### Task 2 — private runtime declaration, reviewed assets and reproducible lock

**Files.**

- Create: `packages/events-laya-runtime/package.json`, `packages/events-laya-runtime/README.md`, `packages/events-laya-runtime/THIRD_PARTY_LICENSES`, `packages/events-laya-runtime/gate/.gitkeep`; `packages/events-daemon/laya-manifest.json`, `packages/events-daemon/laya-runtime.json`; `scripts/fetch-laya-release-tarballs.mjs`, `scripts/laya-runtime-lock.mjs`; `packages/events-daemon/test/laya-manifest-lock.test.ts`, `packages/events-daemon/test/laya-runtime-package.test.mjs`; `packages/events-daemon/test/fixtures/laya/lock-input/runtime-a-1.0.0.tgz`, `packages/events-daemon/test/fixtures/laya/lock-input/runtime-b-1.0.0.tgz`, `packages/events-daemon/test/fixtures/laya/lock-expected.json`, `packages/events-daemon/test/fixtures/laya/manifest-tiny-v1.json`, `packages/events-daemon/test/fixtures/laya/cases/task-2.json`
- Modify: `packages/events-daemon/package.json`, `pnpm-lock.yaml`, root `package.json`, `test/release-packages.test.mjs`

**Consumes.** Task 3's proof/ordinary-CI fence, Task 5's strict parser API, and the coordinator-fetched external-source record. If any required source record is missing, stop as `E2_EXTERNAL_REFERENCE_BLOCKED` before creating the importer or touching `pnpm-lock.yaml`.

**Produces.** The dependency-only private package; shipped daemon assets; deterministic lock builder/check command and release-only SRI verifier/acquirer; fixture-only asset proof consumed by tasks 1, 4–5 and release task 10.

- [ ] **Step 1: Write failing package/acquisition/lock tests.** Assert the private package has no declaration/bin/export/code and exactly pins reviewed runtime direct dependencies; `allowBuilds` remains empty; daemon has no direct/optional/bundled Laya or ONNX dependency; packed daemon contains both root JSON assets. Feed tiny package tarballs to the lock builder and require byte-identical expected JSON, raw-byte path sorting, exact case-preserved `sha512-<base64>` SRI, both macOS file lists, executable bit, exact `https://registry.npmjs.org/` origin/path parsing, SRI-before-extraction and rejection of alternate HTTPS origin, altered SRI, duplicate/unsorted/unknown lock field.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 manifest|runtime lock|runtime package'
  node --test packages/events-daemon/test/laya-runtime-package.test.mjs
  node scripts/verify-laya-ci-install.mjs
  ~~~

  Expected: missing private declaration/assets/generator fails before any registry or model request.
- [ ] **Step 3: Implement the strict assets, verifier and builder.** Add the reviewed single-entry manifest and canonical lock format from E2-2/E2-3 using only facts in the coordinator's fetched-source record. Resolve only the private importer's full closure from `pnpm-lock.yaml`; `fetch-laya-release-tarballs.mjs` is the sole real-tarball path, verifies exact origin and exact SRI over raw bytes before extraction, and hands those bytes directly to the builder. The builder has no “verified tarball” injection path in production, reconstructs platform file lists through Task 5's parser, and produces canonical JSON. Add a `verify:laya-runtime-lock` script that uses fixtures locally and the release-only verified-byte source only in the supply-chain gate.
- [ ] **Step 4: Protect package/release boundaries.** Add daemon root assets to its packed files and consumer assertions. Add static tests that private packages do not enter `PUBLISHABLE`, `PACKAGES`, surfaces or drivers, while the daemon remains held and dependency-clean.
- [ ] **Step 5: Add paired mutants.** Publish/private-declare the runtime package incorrectly; add a daemon runtime dependency; remove a lock asset from tarball; accept alternate HTTPS origin, lowercased/changed SRI or a tarball without SRI; bypass SRI-before-extraction; or change canonical sorting. Each makes its named test red.
- [ ] **Step 6: Review and commit.** P1-only review: fetched-source record precedes reviewed facts, exact pins/origin/SRI, no runtime code/private surface, release acquirer cannot read user npm config/cache, pack contents, no install script and no ordinary-CI closure acquisition. Commit:

  ~~~text
  build(events): pin Laya artifacts outside the daemon dependency tree
  ~~~

**Passing.** Only tiny local tarballs are read; package and lock invariants hold. Run `pnpm verify`.

### Task 3 — E2 structural checker and mutation harness

**Files.**

- Create: `scripts/verify-events-phase-e2-tests.mjs`, `scripts/verify-laya-ci-install.mjs`, `packages/events-daemon/test/laya-mutations.test.ts`, `packages/events-daemon/test/laya-scope.test.ts`, `packages/events-daemon/test/fixtures/laya/cases/schema-v1.json`, `packages/events-daemon/test/fixtures/laya/cases/task-3.json`, `packages/events-daemon/test/support/laya-mutants.ts`
- Modify: root `package.json`, `.github/workflows/release.yml`, `test/release-packages.test.mjs`, `README.md`, `CONTRIBUTING.md` and `docs/RELEASING.md` only to run the completed checker and the explicit normal-install exclusion; later tasks create only their own `test/fixtures/laya/cases/task-<n>.json` in the same commit.

**Produces.** The mandatory owner/mutation/network/test-path fragment scheme used by every later task, and the normal-CI/install fence that precedes introduction of the private importer.

- [ ] **Step 1: Write checker and cold-store self-tests.** In copied fragments, prove failure for an unowned §5/traceability/await row, duplicate owner, shared mutable manifest, orphan mutation, wrong test pattern, missing loopback preload, real hostname, raw corpus field, test-local ledger, daemon dependency on Laya, duplicate judge-kind literal, missing external-source record, ordinary-CI root install, Laya-runtime workspace not excluded, a warm-store assumption and skipped mutant. The cold-store fixture asserts the exact normal command installs all other workspaces while acquiring none of the three direct packages or their closure.
- [ ] **Step 2: Implement the production-copy mutant runner and CI fence.** Copy one named production module to a temporary tree, apply one declared edit, run only the mapped `node:test` pattern under the loopback seal, and fail if it passes or did not execute. It must never invoke a release/gate command. Replace every normal/release verification-leg and documented setup install with the explicit negative workspace filter for `@agentcomms/events-laya-runtime`; `verify-laya-ci-install.mjs` runs it with a fresh store directory and proves the store contains no real runtime closure. The supply-chain gate is the only exception, and is not callable through `pnpm verify`.
- [ ] **Step 3: Establish task-owned registration and its guard mutations.** Validate the empty schema/fragment directory now; every later task creates its own immutable `task-<n>.json` with exact source/test/mutant mappings. The checker discovers fragments and rejects an index file or edit to another task's fragment, so a task's mutation runs before its commit without waiting for a later registration task. In copied workflow/harness inputs, mutate the negative workspace filter, cold-store assertion, source-record requirement and fragment owner; each mapped Task 3 self-test must fail.
- [ ] **Step 4: Run the checker.** Run:

  ~~~text
  node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e2-tests.mjs
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 mutation|laya scope'
  ~~~

- [ ] **Step 5: Review and commit.** P1-only review: this task completed before every other E2 task; a mutant runs production code, no no-op default branch, seal precedes network import, cold-store normal CI cannot acquire the private closure, and no test model replaces E state. Commit:

  ~~~text
  test(events): enforce phase E2 Laya proof pairing
  ~~~

**Passing.** The harness is complete before Tasks 5, 2 and 1 begin; every later invariant can have one real-path test and one red mutant before its own commit. Normal CI/verify installs are closure-free from a cold store. Run `pnpm verify`.

## Detailed tasks — verified artifacts and strict lock parser

### Task 4 — pinned artifact fetcher and resumable model download (high risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/fetcher.ts`, `packages/events-daemon/src/runtime/laya/artifact-paths.ts`, `packages/events-daemon/src/runtime/laya/model-downloader.ts`; `packages/events-daemon/test/laya-fetcher.test.ts`, `packages/events-daemon/test/laya-model-download.test.ts`, `packages/events-daemon/test/support/laya-origin.ts`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya.onnx`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya.onnx.data`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya_config.json`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/tokenizer/tokenizer.json`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/tokenizer/tokenizer_config.json`
- Modify: `packages/events-daemon/src/network/pinned-connection.ts`, `packages/events-daemon/src/network/address-policy.ts` only to expose a bounded reusable raw-byte streaming primitive, never a second network path
- Create: `packages/events-daemon/test/fixtures/laya/cases/task-4.json`

**Consumes.** B2 raw pinned DNS/TCP/TLS/write primitives and deadline/loopback seal; Task 2 manifest/lock and the Task 4 HTTP source record. It is `E2_EXTERNAL_REFERENCE_BLOCKED` until that record names the exact header/range facts; no observed model-host behaviour supplies a wire rule.

**Produces.** A production fixed-purpose fetcher and resumable model downloader used by task 6.

- [ ] **Step 1: Write failing scripted-origin tests.** Drive the production fetcher against injected resolver/socket and sealed loopback origin journals. Cover exact `https://registry.npmjs.org/` lock URL only and exact SRI mismatch; full revision path; five redirects vs a sixth; HTTP/loopback/private/link-local/metadata redirect-hop refusal; only `Host` plus product/version `User-Agent` on a fresh request and a controlled `Range` only after rehash; rejection of cookie/auth/proxy/Accept/forwarding/token headers; bounded response headers; wrong TLS/DNS drift; Range rehash plus exact `206`/`Content-Range`; ignored `200`, malformed/mismatched range and `416` reset; oversize abort; SHA/size retry-to-failed; free-space refusal; partial cleanup on disable; and final rename only after five tiny files verify.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 fetcher|laya model download'
  ~~~

  Expected: no production artifact fetcher/downloader exists and the loopback journal has no external route.
- [ ] **Step 3: Implement raw fetch and strict resume.** Build requests only from the lock/manifest, pass every redirect through B2 address/TLS gates, enforce E2-4 bounds, stream into owner-only partial paths, and rehash before Range. Inject resolver/socket/filesystem/free-space only through constructor interfaces; production constructors have no loopback exemption.
- [ ] **Step 4: Fence all lifecycle writes.** At start, retry and final promotion, acquire the artifact mutex and recheck E's exact pointer/embedded document/job epoch. Disable/purge aborts I/O and deletes partials; it cannot delete a verified tree.
- [ ] **Step 5: Add paired mutants.** Use a branch/revision short form; accept a non-registry HTTPS tarball or altered SRI; permit an optional header; follow HTTP/sixth/private redirect; trust partial length; accept `200`, mismatched `Content-Range` or `416` for Range; promote before final SHA; or forget the final pointer check. Each fails its named case.
- [ ] **Step 6: Review and commit.** P1-only review: raw request construction, redirect/address ordering, byte caps, no sender content, resume correctness, cancellation and no alternate HTTP client. Commit:

  ~~~text
  feat(events): download only verified resumable Laya model bytes
  ~~~

**Passing.** Every request journal is injected/loopback and every incorrect byte state remains partial/failed. Run `pnpm verify`.

### Task 5 — strict tar extraction, runtime installer and whole-tree verifier (high risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/tar.ts`, `packages/events-daemon/src/runtime/laya/runtime-installer.ts`, `packages/events-daemon/src/runtime/laya/tree-verifier.ts`; `packages/events-daemon/test/laya-tar.test.ts`, `packages/events-daemon/test/laya-runtime-installer.test.ts`, `packages/events-daemon/test/laya-tree-verifier.test.ts`; `packages/events-daemon/test/fixtures/laya/tar/valid.tgz`, `packages/events-daemon/test/fixtures/laya/tar/symlink.tgz`, `packages/events-daemon/test/fixtures/laya/tar/hardlink.tgz`, `packages/events-daemon/test/fixtures/laya/tar/device.tgz`, `packages/events-daemon/test/fixtures/laya/tar/fifo.tgz`, `packages/events-daemon/test/fixtures/laya/tar/absolute.tgz`, `packages/events-daemon/test/fixtures/laya/tar/dotdot.tgz`, `packages/events-daemon/test/fixtures/laya/tar/backslash.tgz`, `packages/events-daemon/test/fixtures/laya/tar/nul.tgz`, `packages/events-daemon/test/fixtures/laya/tar/duplicate.tgz`, `packages/events-daemon/test/fixtures/laya/tar/pax.tgz`
- Create: `packages/events-daemon/test/fixtures/laya/cases/task-5.json`

**Consumes.** Task 3's completed harness. It intentionally starts before Task 2: all initial lock cases use the synthetic schema/fixtures in this task, so it creates no reviewed lock asset or external acquisition.

**Produces.** The exact strict extractor API that Task 2's lock builder imports, the daemon installer and the verifier used before every worker start.

- [ ] **Step 1: Write failing archive/tree cases.** Generate tiny gzipped ustar fixtures covering listed/unlisted regular files, all required path/type rejects, duplicate listed/unlisted entries, bad header/size/checksum, missing listed file, wrong hash/size/exec bit, symlink hidden in installed tree, extra file, altered file after earlier verification, and partial/final atomic rename. Assert no shell/system tar/npm/install-script invocation.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 tar|runtime installer|tree verifier'
  ~~~

- [ ] **Step 3: Implement one strict parser and installer.** Reject every disallowed entry before writing it; accept only safe `package/` regular files; stream listed entries to owner-only partial tree while verifying SHA-256; verify complete exact tree; rename once. Export the strict parser API for Task 2's later builder and make the installer call it; this task does not create or edit `laya-runtime.json` or duplicate a builder.
- [ ] **Step 4: Implement complete verifier/repair signal.** Walk with `lstat`, compare exact expected set/type/size/hash/executable flag, return a content-free closed failure, and never import a native module. Task 6 owns deletion/reinstall policy.
- [ ] **Step 5: Add paired mutants.** Accept a symlink/PAX/duplicate; normalise a backslash or dot segment; write an unlisted entry; ignore an extra tree file; or omit executable/hash verification. Each fails one named production-path test.
- [ ] **Step 6: Review and commit.** P1-only review: byte/path parser boundaries, no system archive/npm, extraction tree permissions, shared implementation and atomic promotion. Commit:

  ~~~text
  feat(events): install Laya runtime through a strict verified extractor
  ~~~

**Passing.** Tiny fixtures prove every prohibited archive/tree shape remains unexecuted. Run `pnpm verify`.

### Task 6 — artifact manager, disable/purge/update/remove lifecycle (highest risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/manager.ts`
- Modify: `packages/events-daemon/src/runtime/owner.ts`, `packages/events-daemon/src/runtime/judge-purge.ts`, `packages/events-daemon/src/runtime/lifecycle.ts`, `packages/events-daemon/src/runtime/recovery.ts`, `packages/events-daemon/src/runtime/expiry.ts`, `packages/events-daemon/src/runtime/judge-coordinator.ts`, `packages/events-daemon/src/operations/judges.ts`, `packages/events-daemon/src/operations/doctor.ts`, `packages/events-daemon/src/store/records.ts`
- Create: `packages/events-daemon/test/laya-manager.test.ts`, `packages/events-daemon/test/laya-update.test.ts`, `packages/events-daemon/test/laya-purge-closure.test.ts`, `packages/events-daemon/test/fixtures/laya/cases/task-6.json`

**Consumes.** Tasks 1, 4 and 5 plus E's JudgeWorkPurgeParticipant, reservations/holds and laya_models state.

**Produces.** One serial artifact manager registered at E's lifecycle seams; safe status/remove/update behavior for task 8 and C.

- [ ] **Step 1: Write failing lifecycle/race/doctor tests.** Through real E enable/disable/purge operations, prove no fetch before claim; claimed enable moves only through legal model states/progress; same manifest re-enable reuses verified trees; disable cancels partial download/kills work but keeps verified trees; remove refuses while enabled; account/rule/hold purge kills only matching request; and code-only change does not. Mutate only a lock package tarball URL, version or exact SRI while preserving the selected platform file-list digest and require start-up `runtime-changed`; mutate the manifest and require `model-changed`; downgrade behaves the same. Verify failure repairs once then fails. Freeze `doctor` vectors for ready, integrity failure, boundary failure, Linux and Windows: each contains manifest id, runtime-lock digest, runtime state, model state and active/unavailable boundary reason, while containing no path, input, request/response, key or token.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 manager|laya update|laya purge'
  ~~~

- [ ] **Step 3: Implement the artifact mutex and legal transitions.** Serialize install/download/verify/remove/start preparation, track a non-secret job epoch in memory, persist only D8 model status, and call tasks 4/5 components. E kind disable is immediate and triggers abort/worker stop outside its pointer transaction; its final cleanup checks ownership. Re-enable waits for a conflicting remove job then installs/reuses safely.
- [ ] **Step 4: Implement update/repair/remove fences.** On owner startup, under the artifact mutex, byte-compare the exact embedded canonical manifest, entire sorted runtime package list (including URL/version/SRI) and selected-platform canonical file list to current assets before worker work; use E's disable operation for any mismatch. Recheck the pointer and epoch after every asynchronous filesystem phase. Repair only selected failing tree once. Model removal uses existing operation only when disabled, rechecks disabled state after each asynchronous filesystem phase, and never touches another manifest/lock tree.
- [ ] **Step 5: Add paired mutants.** Start a download pre-claim; retain partial on disable; delete verified tree during ordinary account purge; let remove win after enable; compare package version or platform digest instead of complete canonical lock data; ignore a URL/SRI-only lock change; skip second integrity repair failure; omit a required doctor field; or publish a path/content in doctor. Each must fail a unique case.
- [ ] **Step 6: Review and commit.** P1-only review: E owns authority/purge/budget; artifact mutex/job epochs; all post-await rechecks; complete-lock update reason; required content-free doctor observability; no global tree cross-scope deletion. Commit:

  ~~~text
  feat(events): manage verified Laya artifacts through kind lifecycle
  ~~~

**Passing.** Every purge/update/download race leaves E decisions/reservations/artifacts in a closed state. Run `pnpm verify`.

## Detailed tasks — execution boundary

### Task 7 — macOS boundary self-test and framed worker protocol (highest risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/worker-protocol.ts`, `packages/events-daemon/src/runtime/laya/worker-boundary-probe.ts`, `packages/events-daemon/src/runtime/laya/worker-main.ts`; `packages/events-daemon/test/laya-boundary.test.ts`, `packages/events-daemon/test/laya-worker-protocol.test.ts`, `packages/events-daemon/test/support/laya-worker-standin.ts`
- Modify: `packages/events-daemon/src/runtime/laya/contracts.ts`
- Create: `packages/events-daemon/test/fixtures/laya/cases/task-7.json`

**Produces.** The exact spawn/profile/environment/frame contract used by task 8; no native runtime import yet.

- [ ] **Step 1: Write failing boundary/protocol tests.** Assert literal sandbox executable/profile, direct argument array, pipe-only fds, exact `PATH`/`TZ` environment allow-list, bounded/redacted stderr, bounded frame parser, random request/probe ids, listener ownership cleanup, no profile/no sandbox unavailable result and a pre-prepare no-runtime probe. For the actual child, assert its first built-in-only act tries TCP, `fetch`, UDP and UDS; a TCP-only, fetch-only, UDP-only or UDS-only stand-in escape kills that same child before load, and UDP requires both worker-side send failure and zero datagrams at a loopback receiver while pipes remain live. Assert the nonce, PID, profile, entry and pipe generation sent in the successful probe are identical at the load frame; a second spawn or substitution fails. Source scans reject network imports outside boundary probe and reject worker references to daemon DB/control/secrets/provider modules.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 boundary|laya worker protocol'
  ~~~

- [ ] **Step 3: Implement same-child probe-before-load.** Before prepare, run only the no-runtime availability probe. For each actual worker, start disposable TCP, UDP and UDS listeners; spawn once under the literal profile; require failed TCP/fetch/UDS attempts with zero connection accepts and failed UDP send with zero received datagrams; kill/report `boundary-failed` otherwise. Only the nonce-bound successful child may receive a load frame over its original pipes. Make Linux/Windows and missing/profile-failed macOS a reasoned unavailable status before enablement prepare.
- [ ] **Step 4: Add defence in depth.** After that child's probe, patch fetch/network construction to throw, assert no sockets remain beyond pipes, and keep runtime import in its later worker-load function. Bound/redact stderr/frame diagnostics and never echo request input.
- [ ] **Step 5: Add paired mutants.** Remove TCP/fetch/UDP/UDS probe; accept one successful connection/datagram; load before probe; replace the successful child/profile/entry/pipes; inherit proxy/NODE_OPTIONS/fd; use shell; permit a network import; or treat simulated sandbox as production availability. Each fails a single named test.
- [ ] **Step 6: Review and commit.** P1-only review: profile bytes, same-child nonce/PID/pipe fence, test/production separation, listener timing, UDP falsifiability, error redaction, source scan, unavailable behavior and cleanup. Commit:

  ~~~text
  feat(events): prove the Laya worker boundary before load
  ~~~

**Passing.** Stand-ins prove the daemon never sends load after either boundary escape. Run `pnpm verify`.

### Task 8 — isolated Laya supervisor and E coordinator adapter (highest risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/templates.ts`, `packages/events-daemon/src/runtime/laya/worker-runtime.ts`, `packages/events-daemon/src/runtime/laya/worker-supervisor.ts`; `packages/events-daemon/test/laya-supervisor.test.ts`, `packages/events-daemon/test/laya-evaluation.test.ts`, `packages/events-daemon/test/laya-worker-runtime.test.ts`
- Modify: `packages/events-daemon/src/domain/judges.ts`, `packages/events-daemon/src/runtime/judge-coordinator.ts`, `packages/events-daemon/src/runtime/judge-budget.ts`, `packages/events-daemon/src/runtime/laya/manager.ts`, `packages/events-daemon/src/runtime/owner.ts`
- Create: `packages/events-daemon/test/fixtures/laya/cases/task-8.json`

**Consumes.** Tasks 1, 6 and 7; E's request/answer/reservation/hold machinery; and the Task 8 runtime-wire source record. It is `E2_EXTERNAL_REFERENCE_BLOCKED` until the record names every external runtime field/limit used by the adapter.

**Produces.** The Laya registry executor, one-child supervisor and worker runtime adapter.

- [ ] **Step 1: Write failing real-coordinator tests.** Send synthetic E production projections through deterministic prefilter, E fixed envelope/taint/reserve/in-flight and the Laya adapter. Prove no worker for false prefilter/disabled/unavailable/no budget; exactly one framed request after reservation and only after Task 7's same-child tree/boundary generation succeeds; request lacks event/account/target/secret; template is manifest-listed; 512-token overflow is malformed; score NaN/infinity/range/wrong type is malformed; score is unchanged; actual token usage settles once; 30-second hang/crash/late answer produces no-match and kills/restarts child; idle ten-minute exit; and a second request is serialized.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 Laya supervisor|laya evaluation|laya worker runtime'
  ~~~

- [ ] **Step 3: Implement worker runtime without package fallback.** Dynamically import only from the verified extracted runtime tree after task 7 success; call the exact CPU-only load; implement the two immutable templates; count before run; return only score/input-token/closed reason. Test direct runtime logic with injected stand-in; process integration uses only task 7's frame-compatible stand-in entry.
- [ ] **Step 4: Implement supervisor/coordinator bridge.** Bind child generation, PID/profile/entry/pipe generation and Task 7 probe nonce to E reservation/work id, enforce one request, kill on deadline/purge/disable/stop, discard stale frame/exit, and pass answers solely to E coordinator. Let E's existing final settlement recheck exact reservation/projection/switch/account/rule/kind/budget/hold facts.
- [ ] **Step 5: Add paired mutants.** Import runtime before boundary/tree check; replace the probed child; invoke default downloader; run concurrent request; silently truncate; accept/clamp output; return a provider match/reason; fail to kill timeout; or settle a late answer. Each fails its named case.
- [ ] **Step 6: Review and commit.** P1-only review: E ordering is unaltered, child has no authority, dynamic path is verified, no native dependency leak, timeout/kill ordering and reservation fence. Commit:

  ~~~text
  feat(events): execute bounded Laya decisions in an isolated worker
  ~~~

**Passing.** A real E coordinator receives only bounded Laya answers from an isolated test stand-in and all error modes are no-match. Run `pnpm verify`.

## Detailed tasks — quality and release gate

### Task 9 — aggregate-only labelled quality gate and local metric proof

**Files.**

- Create: `scripts/run-laya-quality-gate.mjs`, `scripts/verify-laya-quality-gate.mjs`, `packages/events-laya-runtime/gate/schema-v1.json`, `packages/events-daemon/test/laya-quality-gate.test.ts`, `packages/events-daemon/test/fixtures/laya/quality/metrics-v1.json`, `packages/events-daemon/test/fixtures/laya/quality/bad-report-v1.json`, `packages/events-daemon/test/fixtures/laya/cases/task-9.json`

**Consumes.** Tasks 2, 8 and the E2-H coordinator-fetched source record naming the immutable Python repository/revision, invocation, tokenizer/model inputs and report-excluding candidate subject. Without that record this task is `E2_REFERENCE_BLOCKED`; do not write a runner with guessed Python behaviour.

**Produces.** A protected, external-corpus gate protocol and static aggregate validator. The committed `gate/<manifestId>.json` is added only from a real consented gate run, never as a fixture/placeholder.

- [ ] **Step 1: Write failing metric/report/reference tests.** Use a tiny synthetic labelled vector to prove ten equal-width ECE, Brier, AUROC, positive share, latency percentile/memory aggregation and maximum reference delta calculations. Reject an absent/mutable Python reference record, invocation/tokenizer/model-input mismatch, a candidate subject that includes the report, insufficient Gmail/Slack counts/positive rate, one-channel-only report, wrong manifest/lock/template/runtime/gate-subject hashes, raw or secret-like corpus data, per-item values, unknown fields, duplicate templates and a passing flag inconsistent with thresholds.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 quality gate'
  node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-laya-quality-gate.mjs --fixture
  ~~~

- [ ] **Step 3: Implement aggregate protocol.** Make the runner require an explicitly supplied encrypted external corpus directory, refuse any path inside the repository, produce no per-item stdout/log/artifact, run only the source-record-pinned Python reference and worker invocation, and write only schema-validated aggregate. The verifier recomputes the report-excluding candidate-subject digest from assets/source and requires every offered template/channel/architecture threshold.
- [ ] **Step 4: Define the owner procedure, not a CI test.** Produce the task's private procedure input for Task 10: written consent/provenance, encrypted external retention, aggregate-only output, no provider calls, protected runner access, Apple-silicon/Intel evidence rule, and the rule that only the sanitized report may enter the repository. Task 10, as sole README owner, documents it; this task does not edit the README.
- [ ] **Step 5: Add paired mutants.** Collapse Gmail/Slack; use model-card calibration; omit a template/source digest; accept mutable/guessed reference inputs or a subject including the report; accept a raw item; calculate bins incorrectly; accept 199/<30%; or permit a fixture report as release evidence. Each fails its named test.
- [ ] **Step 6: Review and commit.** P1-only review: `E2_REFERENCE_BLOCKED` predecessor, privacy scan, metrics definitions, thresholds, exact subject binding, external-directory refusal and no quality assertion from synthetic data. Commit:

  ~~~text
  test(events): gate Laya probability labels on aggregate evidence
  ~~~

**Passing.** Unit fixtures prove gate math/report privacy; no actual model/corpus is used. Run `pnpm verify`.

### Task 10 — release refusal, package audit and SECURITY/documentation contract

**Files.**

- Modify: `.github/workflows/release.yml`, root `package.json`, `scripts/release.mjs`, `packages/events-daemon/package.json`, `packages/events-daemon/README.md`, `packages/events-laya-runtime/README.md`, `SECURITY.md`, `docs/RELEASING.md`, `CHANGELOG.md`
- Create: `.github/workflows/laya-quality-gate.yml`, `scripts/run-laya-macos-boundary-gate.mjs`, `packages/events-laya-runtime/gate/macos-boundary-v1.schema.json`, `test/laya-release-gate.test.mjs`, `test/laya-security-doc.test.mjs`, `packages/events-daemon/test/fixtures/laya/cases/task-10.json`
- Modify: `test/release-packages.test.mjs`, `test/events-daemon-package.test.mjs`

**Produces.** A future release can publish an unheld daemon only after exact-origin/SRI lock reconstruction, exact aggregate validation and content-free real-mac boundary evidence; E2 itself stays held.

- [ ] **Step 1: Write failing release/package/security/workflow tests.** In copied workflow/release assets, unhold the daemon and prove release fails for no aggregate or boundary artifact; stale manifest/complete lock/package URL/SRI/platform list/template/gate subject; failed template; absent arm64/Intel evidence as applicable; wrong architecture/subject; lock reconstruction drift; daemon dependency leak; or missing root lock asset. Require the protected macOS workflow to reject pull-request, branch/ref and arbitrary-dispatch inputs; require an immutable reviewed candidate SHA/tag, protected environment approval, isolated self-hosted macOS runner, host outbound-egress denial, no persisted checkout credentials, no package/npm publishing credential, corpus mount only after candidate verification, and no corpus mount/output on ordinary CI. Assert both D2 Laya SECURITY bullets byte-for-byte, current holds remain, and docs say macOS-only/English/CPU/boundary/ordinary downloads/quality gate without promising same-user protection.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  node --test test/laya-release-gate.test.mjs test/laya-security-doc.test.mjs test/events-daemon-package.test.mjs
  ~~~

- [ ] **Step 3: Add the protected supply-chain and macOS gates.** When and only when `events-daemon` enters `PACKAGES`, release first invokes the owner-only raw-tarball acquirer, reconstructs/checks the lock, then validates exact aggregate and boundary evidence; any failure stops before OIDC preflight/publish. Add a protected macOS workflow with no PR trigger, no ref/branch/workflow-dispatch input and no npm/publish credential. It accepts only an immutable reviewed candidate tag/SHA from the protected release control, checks out with no persisted credential, verifies the candidate subject before mounting the corpus, uses a runner group unavailable to PR jobs with host egress denied, and runs the trusted gate driver with bounded/redacted logs. The driver writes two content-free artifacts: the sanitized aggregate and `macos-boundary-v1` pass/fail result for TCP/fetch/UDP/UDS (with zero UDP receiver datagrams), pipe liveness, native load, timeout/crash/idle restart and altered-tree repair. The normal release accepts only committed sanitized artifacts whose architecture and candidate subject match; an arm64 artifact never authorises x64.
- [ ] **Step 4: Make packaging/security/documentation assertions mechanical.** Require daemon tarball assets, prohibit Laya/ONNX in daemon dependency closure and desktop bundle, preserve private runtime absence from publication, append exactly D2's Laya vulnerability/safety-model bullets, and make this task the sole owner of the private runtime README. It documents the written-consent, encrypted-external-retention, owner-controlled protected-runner, aggregate-only procedure from Task 9, the exact normal-CI exclusion, and that the packages remain held until the three supply-chain/quality/boundary evidence gates pass.
- [ ] **Step 5: Add paired mutants.** Skip release validation on daemon; accept an arbitrary report or checklist in place of boundary evidence; accept URL/SRI-only lock drift; permit a PR/ref input, ordinary runner, host egress or corpus mount before candidate verification; run quality in `pnpm verify`; publish runtime package; remove one SECURITY sentence; add ONNX dependency; or lift a hold. Each fails its named test.
- [ ] **Step 6: Review and commit.** P1-only review: pre-publish placement, exact-origin/SRI and candidate-subject evidence provenance, actual real-mac boundary artifact, protected-runner/corpus trust boundary, no corpus/credential leak, held-release behavior, exact asset packing and security wording. Commit:

  ~~~text
  ci(events): require Laya gate evidence before a daemon release
  ~~~

**Passing.** Normal verification is model/network free; a future unhold is mechanically impossible without exact aggregate, full lock reconstruction and architecture-bound real-mac boundary evidence. Run `pnpm verify`.

## Detailed tasks — desktop and control join

### Task 11 — Phase C Laya enablement/progress/status contract (blocked until C)

**Files.**

- Modify Phase E's exact daemon contract files: `packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json`, `packages/events-daemon/test/judge-desktop-contract.test.ts`, `packages/events-daemon/src/operations/judges.ts`, and `packages/events-daemon/src/operations/doctor.ts`.
- Modify after rebase onto C: `apps/desktop/src/control-contract.ts`, `apps/desktop/src/screens/judges.tsx`, `apps/desktop/test/control-contract.test.ts`, `apps/desktop/test/full-flow.test.mjs`, and `apps/desktop/test/mutations/manifest.json`.
- Create: `packages/events-daemon/test/fixtures/laya/cases/task-11.json`.

**Consumes.** C's exact `idle | installing | downloading | verifying | ready | failed | unavailable` UI slot and no-Laya-bundle rule; B3/E existing shared judge operations.

- [ ] **Step 1: Write failing cross-surface and approval-preview vectors.** Freeze daemon responses for disabled, approval-pending, macOS unavailable, installing/downloading byte progress, verifying, ready, failed/integrity, boundary-failed, removal-complete-as-`idle`, and Linux/Windows unavailable. Freeze the real C rendering of the same daemon-owned enablement preview: sources, sizes, licences, model/runtime disk estimates, roughly 2 GB memory, English-only, 512-token, CPU-only, macOS-only `sandbox-exec` limitation, one-at-a-time execution, download-after-approval and every unavailable/accuracy reason must appear without app inference. Require stable reason codes and no path/input/secret. Drive C's real Rust/TypeScript adapter with the sealed D12 peer, not a UI-local state model.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E10|desktop contract|E2 Laya contract'
  pnpm --filter @agentcomms/desktop test -- --test-name-pattern='control-contract|full-flow'
  ~~~

- [ ] **Step 3: Implement only shared contract corrections.** Map existing `judge kind enable|disable` and `judge model status|remove` to E2 status without adding a UI evaluator/downloader/secret route. C renders daemon-provided state/reason and opens existing approval/secrets surfaces; no app model/runtime/worker/Node code is added.
- [ ] **Step 4: Add paired mutants.** Mark a model ready before tree verification; omit an unavailable/boundary reason or one preview disclosure; expose a path; let app infer enabled; or put a Laya artifact in the bundle. Each fails the exact daemon/C production adapter/bundle scan.
- [ ] **Step 5: Review and commit.** P1-only review: daemon authority, DTO stability, app capability/CSP boundaries, no secret/no artifact, no extra capability row. Commit:

  ~~~text
  test(events): prove desktop Laya status and progress contracts
  ~~~

**Passing.** The app is only a safe presenter of E2 status and remains artifact-free. Run `pnpm verify`.

## Detailed tasks — exhaustive safety proof

### Task 12 — E2 race, identity, purge and mutation audit (highest risk)

**Files.**

- Modify: `packages/events-daemon/test/laya-contract.test.ts`, `packages/events-daemon/test/laya-fetcher.test.ts`, `packages/events-daemon/test/laya-model-download.test.ts`, `packages/events-daemon/test/laya-tar.test.ts`, `packages/events-daemon/test/laya-runtime-installer.test.ts`, `packages/events-daemon/test/laya-tree-verifier.test.ts`, `packages/events-daemon/test/laya-manager.test.ts`, `packages/events-daemon/test/laya-update.test.ts`, `packages/events-daemon/test/laya-purge-closure.test.ts`, `packages/events-daemon/test/laya-boundary.test.ts`, `packages/events-daemon/test/laya-worker-protocol.test.ts`, `packages/events-daemon/test/laya-supervisor.test.ts`, `packages/events-daemon/test/laya-evaluation.test.ts`, `packages/events-daemon/test/laya-quality-gate.test.ts`, `packages/events-daemon/test/laya-desktop-contract.test.ts`, `packages/events-daemon/test/laya-mutations.test.ts`, `packages/events-daemon/test/laya-scope.test.ts`, `packages/events-daemon/test/support/laya-mutants.ts`, `scripts/verify-events-phase-e2-tests.mjs`
- Create: `packages/events-daemon/test/fixtures/laya/cases/task-12.json`
- Repair production modules only where this audit finds an actual fence gap.

- [ ] **Step 1: Make every matrix exhaustive.** Enumerate every E2 await/write, external/raw identity, external-source record, normal-CI install, artifact lifecycle purge caller, test fixture, §5 row and traceability row. Include URL/SRI-only update drift, all four same-child boundary attempts, doctor fields, preview fields, candidate/Python-reference binding and the real-mac artifact. The verifier fails if one lacks exactly one owner and one red mutant.
- [ ] **Step 2: Race production seams.** Pause every real fetch/hash/fs/tree/probe/worker/operation seam; race kind disable/re-enable, budget swap, rule/judge revoke, account remove/re-add, visibility hide, expiry/hold, model remove, update/downgrade, boundary failure and competing start. Resume and assert no stale pointer/state/promotion/load/answer/disclosure.
- [ ] **Step 3: Re-run purges and scope isolation.** Seed two account/source scopes and all Laya manager/worker states through E operations; invoke all E purge callers and restart. Require precise cancellation with no cross-account/source work deletion and no orphan child/claim/partial.
- [ ] **Step 4: Enforce static trust boundaries.** Reject `fetch`/http(s).request/package-manager/child-shell usage in artifact paths except the named release-only raw-tarball acquirer; reject network imports outside probe; reject tests without seal; reject daemon Laya dependencies, duplicate kind/template vocabulary, test runtime entry on production spawn, raw-corpus fields, ordinary-CI imports of the private runtime and workflow PR/ref/corpus-mount escape hatches.
- [ ] **Step 5: Run focused proof.** Run:

  ~~~text
  node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e2-tests.mjs
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 race|laya scope|laya purge|laya mutation'
  ~~~

- [ ] **Step 6: Review and commit.** P1-only review: every mutation is isolated/red, writes recheck after await, scopes are stable IDs, all orphan paths cancel, and no test-local model exists. Commit:

  ~~~text
  test(events): exhaustively fence Phase E2 Laya lifecycle races
  ~~~

**Passing.** One mutation removed at a time fails its named production-path case; no unsealed/external/corpus test can run. Run `pnpm verify`.

## Detailed tasks — final evidence, release readiness and review

### Task 13 — end-to-end gate evidence, packed artifacts and PR handoff

**Files.**

- Create: `packages/events-daemon/test/laya-e2e.test.ts`, `test/laya-manual-macos-checklist.md`, `packages/events-daemon/test/fixtures/laya/cases/task-13.json`
- Modify: `packages/events-daemon/test/consumer-check.mjs`, `test/events-daemon-e2e.test.mjs`, `test/release-packages.test.mjs`, `packages/events-daemon/README.md`, `CHANGELOG.md`

- [ ] **Step 1: Write failing E2E/packed checks.** Drive the actual owner/control operation with a synthetic rule through E deterministic prefilter, taint, reservation, Laya artifact ready state, boundary probe stand-in, worker frame, E settlement/no-match/hold and all disable/purge/restart paths. Pack/install the daemon into a sealed consumer and require manifest/lock/worker assets, no native dependency tree, no model/runtime preinstall and preserved holds. A copied release state without aggregate evidence must fail before any publish path.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 end to end|laya consumer'
  node --test test/events-daemon-e2e.test.mjs test/release-packages.test.mjs
  ~~~

- [ ] **Step 3: Implement only integration wiring/supplemental evidence.** Reuse production owner/manager/supervisor/coordinator/control modules and synthetic fakes; do not create an E2 test-only daemon model. Add the manual macOS checklist as supplemental owner evidence covering arm64/Intel availability, absent/profile-failed sandbox, TCP/UDP/fetch/UDS denial with pipes, real native load, timeout/crash/idle, altered tree repair, release lock reconstruction and external consented quality report review. It explicitly points to Task 10's machine-produced boundary artifact as the release gate and cannot itself satisfy it.
- [ ] **Step 4: Run final machine checks.** Run:

  ~~~text
  pnpm verify:parity --strict
  pnpm verify:packages
  pnpm verify
  git diff --check
  git status --short
  ~~~

  Record only command status in the PR. Do not run a real model, model download, quality corpus, release, tag, publish, email or message command as part of ordinary verification.
- [ ] **Step 5: Review and commit.** P1-only review: E's one judge path, packed assets, no native model/dependency preinstall, holds, release ordering, no real data, and checklist-versus-machine-gate boundary. Commit:

  ~~~text
  test(events): prove the held Laya runtime end to end
  ~~~

**Passing.** The full synthetic production path is safe and package/release gates fail closed. Task 10's protected content-free macOS boundary and quality artifacts—not the checklist—remain prerequisites for offering Laya in a release. Run `pnpm verify`.

## §5 coverage ownership

Each E2-owned test clause has exactly one task owner. Existing E ownership of generic judge enablement, budgets, holds, TypeSafe/local-endpoint transport, B3 parity and C app security remains unchanged.

| §5 row / E2-owned assertion | Sole task |
| --- | ---: |
| 2884–2892: default-disabled Laya, normal E enablement/claim only, unavailable-before-intent, canonical enablement/document and exact approval-preview vectors | 1 |
| 2892–2895, 2904: private dependency-only package, shipped lock, byte-identical fixture rebuild, exact-origin/SRI acquisition, ordinary-CI exclusion and daemon dependency exclusion | 2, 3 |
| 2892–2895: runtime fetch is lock-URL-only and SHA-512-pinned, starts only after claim | 4 |
| 2893–2895: strict runtime archive shape/listing/owner-only extraction and no npm/install script | 5 |
| 2895–2900: full-revision model request, redirect/address/header policy, over-size, retry, Range resume, free space, disable cleanup and final rename | 4 |
| 2901–2903: exact whole-tree verification before native import/start, one repair, then failed | 5 |
| 2905–2907: complete-lock/model update and downgrade tightening, code-only no-op, required doctor fields and verified-tree retention/removal | 6 |
| 2907–2908: child environment/descriptor fence and package downloader unreachable | 8 |
| 2908–2916: same-child macOS deny-network TCP/fetch/UDP/UDS boundary/self-test, unavailable Linux/Windows/doctor reason and protected real-mac proof | 7, 10 |
| 2916–2919: in-worker defence, malformed/token/score handling, concurrency one, timeout/crash/no-match/restart and idle exit | 8 |
| 2920: injected stand-in in ordinary tests; no real bundle in `pnpm verify` or normal CI install | 3, 13 |
| 2921–2922: external-only aggregate harness, consent/data-rejection checks and exact manifest/template aggregate validity | 9 |
| 2922: release refuses an offered template without exact passing evidence; held/package/SECURITY release guard | 10 |
| 3326–3336: C presentation-only DTO/bundle contract and existing B3 CLI/MCP prepare-only contract join | 11 |
| All E2 await fences, stable identity scope, purge closure, production-path/mutation pairing and loopback seal | 12 |
| Synthetic owner-to-packed-consumer proof plus the supplemental owner-only real-mac checklist | 13 |

## Spec traceability

Every normative sentence implemented by E2 maps to one task and a named proof. A row owned by E, B3 or C is cited only where E2 consumes its interface; it is not duplicated as E2 ownership.

| Spec section and line(s) | Requirement | Task | Named proof |
| --- | --- | ---: | --- |
| D1 132-138 | Daemon owns judge/database/provider work; app is presentation only | 8, 11 | `E2 Laya supervisor has no daemon authority`, `E2 desktop Laya contract` |
| D2 146-157, 241-247, 320-323 | Separate human-only enablement pointer; Laya starts only after claim/outside approval | 1, 6 | `E2 enablement claim starts no stale install`, `E2 no artifact before claim` |
| D2 283-297 | Judge-kind digest mutations, immutable authorisation, no install/update/import enablement | 1 | `E2 canonical Laya enablement vectors` |
| D2 503-529 | Exact Laya vulnerability and safety-model disclosures in `SECURITY.md` | 10 | `E2 SECURITY Laya wording` |
| D5 1053-1071 | Kind enabled, fixed limited input, finite probability, threshold/no-match and stored metadata through E | 8 | `E2 Laya evaluation uses coordinator answer` |
| D5 1080-1096 | E reservation/in-flight/recovery/disable settlement remains the sole ledger | 8, 12 | `E2 late worker result is discarded`, `E2 Laya reservation purge race` |
| D8 1402-1418 | No kind pointer by default; content-free `laya_models` states | 1, 6 | `E2 Laya model state schema`, `E2 manager legal transitions` |
| D10 2035-2047 | Judge test/model-ready rule and synthetic test restrictions flow through existing operations | 1, 8 | `E2 Laya test readiness contract`, `E2 no worker before approved synthetic call` |
| D10 2071-2085 | Existing kind prepare/disable/model status/remove/doctor surfaces and reasons | 1, 6, 11 | `E2 Laya operation contract`, `E2 update doctor codes`, `E2 desktop Laya contract` |
| D11 2096-2128 | Laya local CPU contract, every kind off, disable stops/purges, immutable kind document | 1, 6, 8 | `E2 laya registry contract`, `E2 laya disable closure`, `E2 Laya evaluation` |
| D11 2134-2151 | macOS/English optional runtime, exact @receptron choice and CPU-only load | 2, 8 | `E2 runtime package pins`, `E2 worker CPU load` |
| D11 2153-2165 | Isolated child, pipe protocol, stripped authority, timeout/resource/idle/concurrency fence | 7, 8 | `E2 worker spawn fence`, `E2 Laya supervisor timeout/crash/idle` |
| D11 2167-2204 | macOS sandbox-exec profile, unavailable other platforms, same-child per-start TCP/UDP/fetch/UDS self-test and in-worker defence | 7, 10 | `E2 boundary probe fence`, `E2 macOS boundary gate`, `E2 sandbox unavailable before prepare` |
| D11 2206-2213 | Exact bounded request/templates/token refusal/answer/token charge/30-second timeout | 8 | `E2 Laya worker runtime vectors` |
| D11 2215-2256 | Reviewed strict manifest, complete embedded lock data and human enablement preview | 1, 2 | `E2 manifest/preview canonical vectors`, `E2 enablement digest vectors` |
| D11 2258-2277 | Release-built daemon lock, private package, exact tarball integrity/file lists and no scripts | 2, 5 | `E2 runtime lock rebuild`, `E2 strict tar extractor` |
| D11 2279-2299 | Post-claim install; exact lock extraction; fixed model fetch/redirect/range/hash/retry/space/rename | 4, 5, 6 | `E2 model download matrix`, `E2 runtime installer matrix`, `E2 manager claim fence` |
| D11 2301-2311 | Whole-tree verification/reinstall/failure and verified-tree retention/disable/remove rule | 5, 6 | `E2 tree verifier matrix`, `E2 verified artifact lifecycle` |
| D11 2313-2319 | Complete-lock/model update and downgrade disable rule | 6 | `E2 complete-lock update matrix` |
| D11 2321-2335 | No daemon dependency/installer/app artifact; app shows status/progress and every stated limit | 1, 2, 3, 10, 11 | `E2 preview vectors`, `E2 daemon dependency boundary`, `E2 cold-store install fence`, `E2 release asset guard`, `E2 desktop Laya contract` |
| D11 2337-2350 | Per-manifest/runtime/template Gmail+Slack labelled quality gate, immutable Python reference and architecture-bound release condition | 9, 10 | `E2 quality reference gate`, `E2 release rejects stale Laya evidence`, `E2 macOS boundary gate` |
| D13 2608-2613 | Judges surface has enable/disable/status/progress/reason/removal, without app runtime | 11 | `E2 desktop Laya contract` |
| D14 2677-2686, 2715-2719 | Private dependency-only runtime package; daemon carries worker/manifest/lock; no install script | 2, 10 | `E2 private runtime package`, `E2 daemon package boundary` |
| §4 2829, 2832-2833 | E2 phase deliverable/dependency ordering; no kind callable pre-E/enablement | 1, 13 | `E2 laya contract`, `E2 end to end held path` |
| §5 2884-2922 | Complete Laya install/download/tree/update/worker/boundary/gate acceptance matrix | 1–10, 12, 13 | §5 ownership table above and `verify-events-phase-e2-tests` |
| §5 3326-3336 | Private package/daemon lock/dependency closure; existing parity/MCP enable behavior; B3 prerequisite remains | 2, 10 | `E2 runtime package`, `E2 release/package boundary` |
| §7 3380-3385 | Third-party/local model risk mitigations and gate | 5, 7–10 | `E2 tree verifier`, `E2 boundary probe`, `E2 quality gate` |
| §8 3393-3399, 3410-3413, 3421-3426, 3431-3432 | Laya identity; off-by-default; macOS-only boundary; English-only | 1, 7, 8, 11 | `E2 enablement contract`, `E2 platform availability`, `E2 worker limits`, `E2 desktop reason` |
| §9 3463-3471, 3498-3501 | Review closures: durable lock/tree verification and OS boundary including pathname UDS | 2, 5, 7 | `E2 runtime lock rebuild`, `E2 tree verifier`, `E2 TCP/UDS boundary probe` |

## Review process

Each task ends with its P1-only review before a dependent task starts. The end-of-phase review is one parallel round from isolated review worktrees; it is not another serial twelve-round loop.

| Parallel reviewer | Covers |
| --- | --- |
| E authority reviewer | E registry replacement, canonical enablement/digest, pointer/availability/operation parity, budgets/holds/no new surface |
| Supply-chain reviewer | private package, lock reconstruction, tar parser, downloader/redirect/range/path/permission/tree verification, update/remove |
| macOS isolation reviewer | exact sandbox command/profile, fds/environment, same-child nonce/PID/pipes, UDP receiver proof, protected real-mac artifact, worker imports/frames/timeout |
| Lifecycle/scope reviewer | every post-await recheck, E purge participant, account/source stable scope, disable/re-enable/remove/update/recovery races |
| Quality/release reviewer | fetched Python-reference record, consent/data protocol, protected-runner workflow, metric math, aggregate privacy scan, gate-subject/architecture binding, release pre-publish refusal, holds/packaging/SECURITY |
| C/test-integrity reviewer | daemon-to-C preview/status DTO, app artifact boundary, cold-store CI exclusion, real production paths, fixture seal, mutation pairing and structural verifier |

Any P1 is fixed by the task owner; rerun that task's focused tests, named mutants and `pnpm verify`. A new recurring defect class is not reviewer memory: add it to the automatic ledger/checker and map a mutant before approval.

## Pull-request payload and release status

The E2 PR proposes **`0.16.0-events-e2`** if main remains `0.15.2`: a minor prerelease because it adds an opt-in capability without breaking an existing published API. Recompute only from current main when opening the PR. Its description carries:

1. what changes for a person: macOS-only, English-only local Laya can be approved and downloaded after E; how the daemon verifies/isolate it; Linux/Windows remain unavailable;
2. the version and semver reason;
3. focused test/mutation results, each batch's `pnpm verify`, final package/parity checks, and separately the owner-controlled protected real-mac aggregate and boundary artifacts when a release is contemplated (the checklist is supplemental only);
4. docs/reference impact (no new capability), README, SECURITY, RELEASING, private runtime documentation and a user-facing CHANGELOG line; or `No changelog: <why>` only if the owner decides the held-only change is not user-noticeable;
5. provenance: this local-event design and B1/B2/D/E/C plans read 2026-10-10; the coordinator-fetched external-source record with URL/date/revision for every external fact; any observed protected macOS gate; no live Gmail/Slack/provider testing by repository tests; and AI assistance;
6. explicit confirmation that fixtures are synthetic, the consented quality corpus stays outside the repository, and no real address, message, token, key, secret or client data is committed.

The events library and daemon remain held; E2 does not tag, publish, unhold, send or contact a model host. A future owner release first satisfies task 10's gate then follows `docs/RELEASING.md` to lift/publish events before daemon from one checked tag.

## Implementation commit sequence

1. `test(events): enforce phase E2 Laya proof pairing` (Task 3)
2. `feat(events): install Laya runtime through a strict verified extractor` (Task 5)
3. `build(events): pin Laya artifacts outside the daemon dependency tree` (Task 2)
4. `feat(events): define the bounded Laya judge-kind seam` (Task 1)
5. `feat(events): download only verified resumable Laya model bytes` (Task 4)
6. `feat(events): prove the Laya worker boundary before load` (Task 7)
7. `feat(events): manage verified Laya artifacts through kind lifecycle` (Task 6)
8. `feat(events): execute bounded Laya decisions in an isolated worker` (Task 8)
9. `test(events): gate Laya probability labels on aggregate evidence`
10. `ci(events): require Laya gate evidence before a daemon release`
11. `test(events): prove desktop Laya status and progress contracts`
12. `test(events): exhaustively fence Phase E2 Laya lifecycle races`
13. `test(events): prove the held Laya runtime end to end`

**Plan-document commit message:** `docs(plan): phase E2 — apply plan review`
