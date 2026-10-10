# Local event emission — Phase E2 implementation plan

> **For agentic workers:** implement one checked task at a time. Each checkbox is a delivery boundary: write its failing production-path test first, make the smallest change, run its focused proof and named mutant, obtain its narrow P1-only review, then commit it before a dependent task begins.

**Goal.** Make the existing, disabled-by-default `laya` judge kind usable only on macOS and only for the reviewed English ONNX bundle: install an integrity-pinned runtime and model after a human approves enablement, run it in a network-denied isolated worker, and make a release offer it only after the exact manifest/runtime/template has passed D11's labelled Gmail and Slack quality gate.

**Starting point and dependencies.** This plan starts on `feat/events-e` at `5cab45c6`, the converged B2 + Phase D tree with Phase E's plan under review. It is blocked on the implemented, reviewed Phase E contracts and B3 surfaces, and has a final contract join with Phase C. It preserves every B1, B2 and D build decision, especially: the shared `assertDisclosable` fence; no post-await write without an in-transaction recheck; raw account/source identity; re-added accounts staying dark until re-approved; B2's raw pinned connection and loopback seal; and all work-orphaning purges cancelling their work. It uses, rather than recreates, E's judge kinds, enablement pointers, JudgeCoordinator request/answer path, reservation ledger/budgets, holds, and JudgeWorkPurgeParticipant.

**Architecture.** The daemon carries one strict reviewed manifest and a release-built lock, but has no Laya dependency. A private, unpublished workspace package exists solely to pin the third-party dependency closure in pnpm's lockfile. After E's normal kind-enable claim, an artifact manager fetches only lock/manifest-pinned bytes, validates/extracts them into owner-only partial trees, atomically promotes verified trees, and verifies both whole trees before every worker start. The daemon launches a separate Node child under macOS `sandbox-exec`; a probe proves the boundary before that child imports the native runtime or opens a model. The child returns only E's bounded judge answer over framed stdin/stdout; it receives no daemon credential, database, control token, provider session, socket, or inherited descriptor.

**Tech stack.** Node 22.18+ and pnpm 11; existing Node built-ins (crypto, fs, path, zlib, child_process, net/dgram only in the worker's boundary probe); SQLite through E; the E/B2 pinned-connection primitives; macOS `/usr/bin/sandbox-exec`; `@receptron/laya` 0.1.2, `onnxruntime-node` 1.30.0 and `@huggingface/tokenizers` 0.2.0 only in the private runtime declaration and the daemon-installed lock tree. No package-manager install script ever runs.

## Global constraints

- Read and retain the interfaces and decisions in Phase E before changing a judge path. `JUDGE_KINDS` in `packages/events-daemon/src/domain/lifecycle.ts` remains the one vocabulary; no Laya module writes a parallel union or string list.
- The only enablement fact remains E's active `active_versions(kind = 'judge-kind', object_id = 'laya')` pointer. Fresh database, install, update and import mean disabled. E2 adds no boolean cache, alternate approval, alternate budget, alternate hold, rule activation, CLI command, MCP tool, send path, source or target.
- E2 uses E's normal `judge kind enable` prepare/approve/claim/finalise path. MCP still prepares only. Linux and Windows reject `laya` before an intent, approval, download, model row or worker exists. On macOS an unavailable/missing boundary also refuses before prepare.
- E's coordinator remains sole owner of deterministic prefilter → minimised fixed envelope → taint flush → reservation → in-flight transition → answer settlement/hold. The Laya adapter cannot see an event id, account id, target, secret, arbitrary endpoint, mutable model URL, or a provider-directed outcome; it returns only E's finite score, actual input token count, and closed reason.
- The Laya provider identity is E's canonical `laya` provider id. E must refuse a Laya per-provider concurrency ceiling above one; the supervisor independently permits one request at a time. A malformed/token-overflow/crashed/timed-out worker result is E's no-match, never a retry that re-asks.
- The model is English-only, CPU-only and 512-token-context in version 1. Do not add language detection, GPU providers, the multilingual checkpoint, another runtime, Linux isolation, a Windows launcher, an HTTP listener, or an installer bundle; each is D15 work.
- The runtime/model use no event content in their download requests. Production fetching uses no `fetch`, npm, npm cache, .npmrc, proxy, redirect helper, agent, install script, cookie, Authorization header, or token. Tests use only injected fakes or sealed loopback fixtures and synthetic `.test` names.
- Tests never call a real provider, model host, registry, Gmail, Slack, Resend, WhatsApp, keychain, or send endpoint. The real bundle/labelled quality gate is an explicit protected macOS release-gate activity, never part of `pnpm verify`.
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
| Reproducibility/release | `scripts/laya-runtime-lock.mjs`, `scripts/verify-laya-quality-gate.mjs`, `.github/workflows/release.yml`, `.github/workflows/laya-quality-gate.yml` | Deterministic lock reconstruction, aggregate-only gate report validation and release refusal |
| Tests | `packages/events-daemon/test/laya-*.test.ts`, `test/fixtures/laya/**`, `test/support/laya-*.ts`, `scripts/verify-events-phase-e2-tests.mjs` | Production-path tests, tiny synthetic artifacts/fakes, mutation pairing and structural enforcement |

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

The activation document embeds the selected entry verbatim and the canonical runtime-lock package list plus selected macOS file-list digest, as D2/D11 require. It binds direct package versions only as reviewed preview text; the lock is the install authority. Template content lives in the daemon worker source, has a stable id and SHA-256 in the gate subject digest, and changes semantically only with a new template id/manifest entry. That avoids silently giving a new prompt the old labelled result or enablement approval.

Reasonable alternatives rejected: a remote manifest, a flexible manifest schema, a branch/tag revision, or a model selector in a rule would defeat reviewed immutable approval bytes; including arbitrary prompt text in the activation document duplicates daemon code and does not make the shipped worker safer.

### E2-3 — private package pins dependencies; release-built lock is the sole installer authority

`packages/events-laya-runtime` is private, has no `agentcomms` or `agentcommsPackage` declaration, exports no code, and is absent from publication. Its exact dependencies declare the three direct packages and their full pnpm-resolved closure; `allowBuilds` remains empty. The daemon has none of these packages in dependencies, optionalDependencies, bundledDependencies or its resolved packed dependency tree.

`scripts/laya-runtime-lock.mjs` deterministically builds `packages/events-daemon/laya-runtime.json` from that workspace declaration, the root lockfile and verified tarballs. The canonical lock has a schema version, sorted package list of exact name/version/HTTPS registry tarball URL/lowercase SHA-512 integrity, and macOS arm64/x64 entries containing the complete installed `node_modules/` tree's safe path, size, SHA-256 and executable bit. It is byte-for-byte canonical JSON. The daemon package lists the root asset in `files`, reads it relative to its own installed package, and consumer-tarball tests prove it is present.

The release job reconstructs the lock with the same strict extractor from each exact tarball, compares it byte-for-byte with the committed asset, then packages the daemon. Unit tests use tiny synthetic tarballs and a fixture lock only; neither a test nor normal verification fetches a real tarball. The release reconstruction is the explicit externally networked supply-chain gate, not npm installation on an end-user machine.

Reasonable alternatives rejected: a lockfile plus `npm ci --ignore-scripts` still trusts user npm config/layout and requires a pinned npm; shipping native packages in the daemon makes every user install native code; publishing the runtime package makes it a consumer-installed API; dynamic package installation lets package-manager scripts/cache/registry settings become authority.

### E2-4 — daemon fetches only pinned bytes and promotes only complete verified trees

Use one production `LayaArtifactFetcher`, implemented over B2's raw pinned resolution/TCP/TLS request primitives and IANA policy, not `fetch` or Node HTTP clients. For tarballs, it accepts only the lock's exact HTTPS URL and streams through a SHA-512 integrity verifier. For model files it constructs only:

~~~text
https://huggingface.co/<repo>/resolve/<full-40-hex-revision>/<manifest-path>
~~~

It follows at most five redirects; every hop is HTTPS, resolves only to globally reachable non-metadata addresses, has no approved-address-set exception, sends only a product/version User-Agent, and sends no cookie, proxy, Authorization or token. Redirect target, status/header bounds, TLS name/address gates and byte stream are journalled only as content-free closed codes.

The strict tar reader accepts only regular files rooted at `package/`; it rejects links, devices, FIFOs, special/PAX entries, absolute paths, `..`, backslashes, NUL bytes and any duplicate. It rejects a duplicate even when unlisted, skips only safe unlisted regular entries, and writes only lock-listed files as owner-only files under `runtime/<lockDigest>.partial/`. After every listed file's size/SHA-256 matches, a single rename promotes `runtime/<lockDigest>/`.

Model downloads stream into `models/<manifestId>.partial/`, hash every byte, abandon immediately above manifest size, delete/retry a bad file up to five times, and rehash a partial before a single `Range` resume. A correct 206 must start at the requested byte; a 200/ignored/invalid range deletes the partial and restarts it. Check free disk space for remaining bytes plus ten percent before the first request. Only after every exact file verifies does one rename promote `models/<manifestId>/` and E's `laya_models` row become `ready`.

Reasonable alternatives rejected: trust-on-size, a CDN allow list, accepting a branch, resuming without rehashing, individual file promotion, archive extraction by system `tar`, or retaining a bad partial lets unreviewed/mixed data become executable model state.

### E2-5 — full-tree verification and update are fail-closed lifecycle transitions

Immediately before every new worker starts, walk each selected runtime/model directory with `lstat`, compare the complete sorted relative-file set to the selected lock/manifest, and require every type, size, SHA-256 and executable flag to match. Missing, extra, altered, resized, link or traversal entries fail. No worker process is spawned and no native module/model is imported until both checks pass. On a failed tree, atomically mark content-free `integrity`, delete only the failing selected tree under the artifact mutex, reinstall/redownload it once from its pinned source, reverify, then leave Laya `failed` if the new tree still fails.

At daemon start, compare the active Laya enablement's embedded manifest canonical bytes and platform lock digest with assets in this daemon release. If either differs, including a downgrade, call E's existing immediate kind-disable tightening with closed audit reason `model-changed` or `runtime-changed`; retain verified directories, never auto-approve, and wait for a new enablement. A worker-code-only release makes no comparison change. Delete an obsolete verified tree only after its replacement has verified and no enabled entry names it, or through existing `judge model remove` while Laya is disabled.

Reasonable alternatives rejected: checking only a lock digest stored in SQLite, checking first use only, overwriting old trees, retaining a current pointer through changed weights, or using package version as the update signal cannot prove the native files actually loaded.

### E2-6 — macOS sandbox boundary is availability and is re-proved at every worker start

On macOS only, launch the child with literal arguments:

~~~text
/usr/bin/sandbox-exec -p "(version 1) (allow default) (deny network*)" <absolute node> <worker entry>
~~~

No shell is used. The spawn uses only stdin/stdout/stderr pipes, an explicit small environment (`PATH=/usr/bin:/bin`, `TZ=UTC`), a 0700 working directory, and no inherited `AGENT_COMMS_*`, token, proxy, `LAYA_*`, `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`, database/control descriptor or provider session. The profile string, executable path and descriptor list are asserted by tests.

Before the daemon sends a load request, it opens a disposable loopback TCP listener and pathname Unix-domain listener in a fresh owner-only data subdirectory. A just-launched probe worker imports only Node built-ins, attempts TCP/UDP/Unix-domain connections and fetch, reports bounded closed errors over its pipe, and proves stdin/stdout frames still work. The daemon accepts only failed TCP and UDS attempts with neither listener accepting a connection; otherwise it kills the worker, stores only `boundary-failed`, and never sends a load request. It runs this sequence for each new worker, including after a crash. Missing `sandbox-exec`, a failed profile, Linux and Windows are `unavailable` and reject enablement before approval/download.

After the probe, the worker replaces `globalThis.fetch` with a thrower, patches network constructors used by the runtime to throw, and source/AST checks forbid network imports other than the probe module. These are defence in depth only; no code promise substitutes for the OS boundary.

Reasonable alternatives rejected: an in-worker fetch stub alone, a container/namespace that leaves pathname UDS reachable, a TCP-only self-test, inheriting the normal daemon environment, or treating deprecated `sandbox-exec` as always present all weaken the stated v1 boundary. Linux/Windows support stays D15.

### E2-7 — one framed worker is a resource/fault boundary, not a second authority

The worker starts lazily, accepts one length-prefixed JSON request at a time, and exits after ten idle minutes, on daemon stop, kind disable, purge of its in-flight reservation, crash, boundary failure or a 30-second request deadline. Frames have E's request/response caps, closed schema and random request id; the id derives from the reservation/work id but the frame has no event/account/target/raw source identity. The daemon kills, waits and drops all late frames on timeout/crash; E settles the reservation as unknown/estimated and emits no-match. A later approved call starts a fresh worker.

Only after the self-test and tree verification does the child dynamically load the exact extracted `@receptron/laya` entry and call `Laya.load({ modelDir, executionProviders: ["cpu"] })`. It receives the verified directory and no downloader options; a structural test proves the package's default downloader is never reachable. It tokenises the already bounded input and refuses rather than truncates at 512 tokens. It renders only manifest-listed `laya-noul-v1` or `laya-choice2-v1`, accepts its own finite [0,1] Noul/affirmative-choice probability unchanged, returns actual `usage.input_tokens`, and rejects any other shape as malformed.

Reasonable alternatives rejected: loading native code in the daemon, workers/threads in the daemon process, multiple workers, native ONNX calls directly, kill-less JavaScript cancellation, prompt-selected templates, silently truncating, or returning a model-provided match/reason text all break a stated fence or E's answer authority.

### E2-8 — the D11 quality gate is aggregate-only, reproducible and release-blocking

The gate uses an external, consented corpus of the owner/colleagues' Gmail and Slack messages and human labels, stored outside the repository and never uploaded to CI, fixtures, logs or gate artifacts. A written consent/provenance ledger remains with the corpus owner outside the checkout. Repository tests use only a tiny synthetic labelled metric vector and a non-executable tiny model fixture; neither claims Laya quality.

The protected macOS gate command runs the exact candidate's built worker under the sandbox against the external corpus. For each manifest/template/channel it records only a schema-validated aggregate in `packages/events-laya-runtime/gate/<manifestId>.json`: manifest canonical SHA-256, lock SHA-256, platform file-list digest, runtime direct versions, template id/digest, gate-subject digest, runner/version/reference identity, channel item count, positive share, aggregate language mix, ten-bin ECE, Brier, AUROC, maximum Python-reference probability delta, warm p95 latency, peak worker memory and aggregate length-refusal/result counts. It rejects an artifact containing a message, subject, address, Slack handle, event id, rule question, per-item score, raw label, path, secret-looking value or unknown field.

For Gmail and Slack separately, each template needs at least 200 labelled pairs and 30% positives, ECE <= 0.10, Brier <= 0.20, AUROC >= 0.80, every worker probability within 0.001 of the pinned Python reference, warm p95 <= 2 seconds and peak <= 3 GB on Apple silicon; repeat on Intel before Intel is offered. The release validator recomputes the gate-subject digest from the release's manifest, lock, worker/template source and package build inputs. It refuses if any offered template lacks a passing exact aggregate. A failed template is removed only by a new reviewed manifest/enablement entry; if no template passes, the release offers no Laya.

Reasonable alternatives rejected: synthetic data as the release gate, a shared real-mail fixture, aggregate metrics without manifest/lock/template binding, one combined Gmail+Slack score, model-card calibration claims, or merely warning in release notes do not earn D5's probability label.

### E2-9 — test the dangerous mechanics locally; prove the operating-system claim on real macOS

`pnpm verify` exercises production manager/coordinator code with injected clock, filesystem, resolver/socket/child spawner and Laya-runtime stand-in. Tiny gzipped tarballs and a five-file non-executable tiny model exercise lock generation, extraction, fetch/resume/promotion and tree failures. A sealed loopback fixture and injected address policy exercise redirect/range/header behavior; no test permits an external address. Child-process integration uses a frame-compatible stand-in entry; direct worker unit tests inject a `LayaRuntime` stand-in. The shipped worker's production entry has no test-mode argument or ambient test environment escape.

The E2 gate job, outside `pnpm verify`, runs a clean release candidate on real macOS: both architectures before offering them; absence/profile-failure; TCP, UDP, fetch and pathname UDS denial while pipes work; actual native runtime/load; timeout/crash/idle restart; model/tree mutation after a prior verified start; packaging/lock reconstruction; and the consented quality run. It records only the aggregate gate artifact and a content-free manual checklist result.

Reasonable alternatives rejected: mocking `sandbox-exec` as proof, adding a real 1.69 GB model to fixtures, importing ONNX in ordinary unit tests, running label data in a public workflow, or treating a green typecheck as native/runtime evidence.

### Decision-to-task audit

No plan decision is merely prose. The structural verifier contains this mapping and fails if its task, named test, or paired mutation is removed.

| Plan decision | Implementing task(s) | Named proof |
| --- | ---: | --- |
| E2-1 typed E registry seam, one pointer and E coordinator/budget/hold reuse | 1, 6, 8 | `E2 canonical Laya enablement vectors` |
| E2-2 strict reviewed English manifest and immutable templates | 1, 2 | `E2 manifest canonical vectors` |
| E2-3 private declaration and release-built runtime lock | 2, 5, 10 | `E2 runtime lock rebuild` |
| E2-4 fixed-purpose verified fetch, strict extraction and resumable model promotion | 4, 5, 6 | `E2 model download matrix` |
| E2-5 whole-tree verification, repair and update tightening | 5, 6 | `E2 tree verifier matrix` |
| E2-6 macOS-only OS boundary and every-start self-test | 7 | `E2 boundary probe fence` |
| E2-7 one isolated framed worker and E-only answer authority | 8 | `E2 Laya supervisor timeout/crash/idle` |
| E2-8 consented aggregate quality evidence and pre-release refusal | 9, 10 | `E2 release rejects stale Laya evidence` |
| E2-9 synthetic CI/fakes plus protected real-mac proof | 13 | `E2 end to end held path` |

## Spec amendments to raise with the owner

| ID | Design line(s) | Ambiguity, contradiction or missing contract | Plan-safe resolution pending owner decision |
| --- | ---: | --- | --- |
| E2-A | Phase E plan 17-29, 35-41; D10 2071-2085 | E reserves a `JudgeKindDefinition` registry slot but does not define its executor/lifecycle/status ABI, and E Task 2 does not name D8's required `laya_models` table. E2 cannot safely infer either. | Amend E before its integration: add the E2-1 closed callbacks and migration fields `manifest_id, state, bytes_verified, verified_at, failure_code, updated_at`; task 1 fails closed until they exist. |
| E2-B | 2153-2156; 2321-2324 | “worker entry that ships in its own package” conflicts with “worker entry is part of the daemon” while `events-laya-runtime` must hold no code. | Place compiled worker source in the daemon package; keep the private package dependency-only. This follows the later packaging sentence; owner should ratify wording. |
| E2-C | 2155-2157 | “environment reduced to what Node needs” and “no other inherited descriptor” do not specify an allow-list or stderr policy. | Use only PATH and TZ plus stdio pipes; stderr is a bounded, redacted diagnostic pipe and no other fd/environment is inherited. Owner may name a different required Node environment variable. |
| E2-D | 2194-2204; 2100-2112 | The boundary must make Laya not offered, but the mandatory self-test is described at worker start after enablement; the design does not say whether an absent boundary is discovered before an approval. | Run a no-runtime probe during enablement preparation and repeat it before every worker load; fail before intent when unavailable. |
| E2-E | 2258-2277 | The lock requires canonical platform file lists but gives no JSON schema, executable-bit representation, tar/PAX policy or reproducibility subject. | Use E2-3's strict versioned JSON, boolean executable flag, raw-UTF-8 ordering and reject PAX/special entries. The actual candidate closure must prove compatible or prompt a reviewed manifest/lock replacement. |
| E2-F | 2288-2299 | Resume says to use Range after rehash but omits required 206/Content-Range validation and handling of 416/ignored ranges. | Require exact 206 range start; delete/restart on 200, malformed range or 416. This is stricter and never retains unverifiable bytes. |
| E2-G | 2313-2319 | It says an update detects a changed lock/model entry but does not define the comparison canonicalisation, concurrency with download/remove, or model-state race fence. | Compare canonical embedded activation bytes and selected-platform lock digest under one artifact mutex; final promotion/status writes recheck current pointer and job epoch. |
| E2-H | 2337-2348 | “on that release's code” and “only aggregate results are committed” cannot both be proven by a gate that writes its report after evaluation unless the executable subject is defined separately from the report commit. “weights' source revision” also does not unambiguously identify the Python reference repository/revision. | Gate report binds a reproducible executable-subject digest excluding the report itself; release recomputes it. Owner must identify the exact Python reference source/revision and approve this provenance convention. |
| E2-I | 2338-2341 | The design says owner/colleagues’ messages but does not explicitly state consent, retention/handling, gate-runner location or access controls. | Require written consent, external encrypted storage, no CI upload, aggregate-only committed output and owner-controlled protected macOS runner. |
| E2-J | 2347-2349 | “Apple-silicon Mac, and on an Intel Mac before Intel Macs are offered” does not say whether arm64-only release is permitted or how platform status reaches the manifest. | Lock has separate arm64/x64 file lists; runtime offers only architectures with a matching passing aggregate. Start with arm64 only unless owner supplies the Intel gate evidence. |
| E2-K | 503-529; SECURITY.md 37-38 | D2 mandates two E2 SECURITY bullets but does not allocate their exact automated wording test or release documentation owner. | Task 10 adds the exact stated bullets and tests them byte-for-byte; no other SECURITY claim changes. |

## Automatic defenses for recurring defect classes

### Write after await: E2 ledger and mutation proof

Every row below is registered in `test/fixtures/laya/case-manifest.json`. Its named test pauses the real production seam, mutates the specified authority through the production lifecycle operation, resumes it and proves the stale write/load/answer did not happen. `scripts/verify-events-phase-e2-tests.mjs` rejects a new async artifact/worker method not in the ledger.

| Await or external boundary | Subsequent write/action | Recheck inside the owning mutex/transaction | Named test |
| --- | --- | --- | --- |
| E enablement claim → artifact job start | `laya_models = installing` | exact active Laya pointer, embedded manifest/lock, kind availability, job epoch | `E2 enablement claim starts no stale install` |
| free-space/stat/hash/read → runtime partial write/promote | partial/final runtime tree and state | lock digest, artifact job epoch, current pointer or disabled-safe cleanup, exact lock entry | `E2 runtime promotion after disable race` |
| model Range response/hash → partial write/promote/ready row | model file rename and `ready` | active pointer, manifest bytes, partial hash/size, job epoch, no remove/disable | `E2 model resume finalisation race` |
| tree walk/hash → delete/reinstall/failure status | selected tree mutation and `failed` | selected manifest/lock, worker generation, artifact mutex epoch | `E2 integrity repair cannot replace changed selection` |
| current release asset read → kind-disable tightening | pointer removal/audit | still-active exact Laya pointer and same canonical embedded values | `E2 update compare does not disable a re-enabled version` |
| boundary probe child result → send worker load frame | native import/load | worker generation, exact probe token, both listeners saw zero, tree verification generation, kind still enabled | `E2 boundary probe fence` |
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

Every named case calls production activation/lifecycle, artifact manager, E coordinator or worker supervisor against SQLite and real filesystem temp roots. Fakes are limited to clock, free-space probe, resolver/socket, raw-byte origin, child spawner and Laya runtime. No test-local budgets, model state, parser or decision ledger is permitted. `test/support/laya-mutants.ts` applies exactly one source change to a copied production module and runs only the mapped named case. The structural verifier requires one owner for every §5 row, traceability row, await row and fixture, one mutation per guard, a loopback seal for any socket fixture, and failure for an orphan/duplicate/skipped mapping, test-local model, external hostname or raw corpus field.

## Batches, dependencies and safe parallelism

There are **13 implementation tasks in seven batches**. A task is one sitting for one builder. Every batch finishes by integrating its completed work, running `pnpm verify`, recording the result, and leaving no worker/loopback server running.

| Batch | Tasks | Safe parallel group and join |
| --- | --- | --- |
| 1 — E contract and supply-chain inputs | 1, 2, 3 | 1 and 3 may begin independently; 2 follows the reviewed manifest contract from 1. One owner integrates package/lockfile edits. |
| 2 — verified artifacts | 4, 5, 6 | 4 and 5 work in separate worktrees after task 2; 6 serially joins their interfaces and E's model-state seam. |
| 3 — execution boundary | 7, 8 | 7 may run in parallel with Batch 2 once task 1 lands; 8 joins 6 and 7. |
| 4 — quality/release gate | 9, 10 | 9 precedes 10's release validator; documentation/security work within 10 may start while 9's metric implementation is reviewed. |
| 5 — desktop/control join | 11 | Blocked until Phase C and B3 land; it changes no app-owned implementation beyond a shared daemon DTO/vector correction. |
| 6 — exhaustive safety proof | 12 | Serial audit of every prior E2 path and all E interfaces it invokes. |
| 7 — final evidence and review | 13 plus split review | 13 is serial after all joins. The final area reviews run in parallel from isolated review worktrees. |

Do not share migration/lockfile/manifest edits between active worktrees. Rebase before each join, run named tests and mutants, then run the batch command. The riskiest tasks are 1, 4, 6, 7, 8 and 12.

## Batch 1 — E contract and supply-chain inputs

### Task 1 — close the E2 registry, enablement and model-state seam (highest risk)

**Files.**

- Modify: `packages/events-daemon/src/domain/judges.ts`, `packages/events-daemon/src/domain/activation-documents.ts`, `packages/events-daemon/src/domain/lifecycle.ts`, `packages/events-daemon/src/domain/versions.ts`, `packages/events-daemon/src/runtime/judge-coordinator.ts`, `packages/events-daemon/src/runtime/judge-budget.ts`, `packages/events-daemon/src/store/migrations.ts`, `packages/events-daemon/src/store/records.ts`, `packages/events-daemon/src/operations/judges.ts`, `packages/events-daemon/src/operations/doctor.ts`
- Create: `packages/events-daemon/src/runtime/laya/contracts.ts`, `packages/events-daemon/test/laya-contract.test.ts`, `packages/events-daemon/test/laya-enablements.test.ts`

**Consumes.** E's `JUDGE_KINDS`, active judge-kind pointer, `JudgeKindDefinition`, `JudgeCoordinator`, reservation state machine, B3 `judge model status|remove` operations and C's fixed model-status states.

**Produces.** The E2-1 typed registry ABI; exact strict `CanonicalLayaEnablement`; D8 `laya_models` schema/model-state repository; a laya provider concurrency validator; safe DTOs used by tasks 6–13. It exposes no new operation/capability row.

- [ ] **Step 1: Write failing canonical and surface vectors.** Add strict manifest-shaped enablement vectors: all manifest fields/file order/runtime package integrity/platform digest/template ids mutate the D2 digest; Linux/Windows and absent sandbox refuse before intent; unknown model status fields, a caller-chosen manifest/path/template and Laya provider concurrency >1 refuse. Seed a database and prove exactly the D8 `laya_models` states/fields, no path/content, and no pre-claim state row or download.
- [ ] **Step 2: Run the focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 contract|laya enablement|laya model state'
  ~~~

  Expected: failures identify the absent E2 ABI/strict document/model record, never an external request.
- [ ] **Step 3: Amend the E seam, not its authority model.** Implement the E2-1 registry contract; install Laya only by replacing E's unavailable definition; make `canonicalEnablement` embed exactly the daemon-reviewed manifest plus runtime-lock data; add the next forward migration for the D8 model table if E did not add it. Make status/remove route through the already existing B3 operation functions and keep MCP enable prepare-only.
- [ ] **Step 4: Make availability and budgets closed.** Implement platform/boundary availability as a content-free pre-prepare result and require the canonical `laya` provider concurrency ceiling <= 1. Keep dynamic probe work out of the approval/document digest except its stated platform/boundary facts.
- [ ] **Step 5: Add paired mutants.** Delete the pointer check; accept caller manifest bytes; create a model row before claim; accept a concurrency of two; omit a lock package/file/template digest; or expose a filesystem path. Each must fail its unique vector.
- [ ] **Step 6: Review and commit.** P1-only review: one vocabulary, no implicit enablement, no new activation/capability, canonical byte equality, pointer/model-state ownership, and no secret/content DTO. Commit:

  ~~~text
  feat(events): define the bounded Laya judge-kind seam
  ~~~

**Passing.** The vectors prove Laya is unavailable until E's normal approved pointer exists, and that no E2 side effect occurs before it. Then run `pnpm verify`.

### Task 2 — private runtime declaration, reviewed assets and reproducible lock

**Files.**

- Create: `packages/events-laya-runtime/package.json`, `packages/events-laya-runtime/README.md`, `packages/events-laya-runtime/THIRD_PARTY_LICENSES`, `packages/events-laya-runtime/gate/.gitkeep`; `packages/events-daemon/laya-manifest.json`, `packages/events-daemon/laya-runtime.json`; `scripts/laya-runtime-lock.mjs`; `packages/events-daemon/test/laya-manifest-lock.test.ts`, `packages/events-daemon/test/laya-runtime-package.test.mjs`; `packages/events-daemon/test/fixtures/laya/lock-input/runtime-a-1.0.0.tgz`, `packages/events-daemon/test/fixtures/laya/lock-input/runtime-b-1.0.0.tgz`, `packages/events-daemon/test/fixtures/laya/lock-expected.json`, `packages/events-daemon/test/fixtures/laya/manifest-tiny-v1.json`
- Modify: `packages/events-daemon/package.json`, `pnpm-lock.yaml`, root `package.json`, `test/release-packages.test.mjs`

**Produces.** The dependency-only private package; shipped daemon assets; deterministic lock builder/check command; fixture-only asset proof consumed by tasks 4–5 and release task 10.

- [ ] **Step 1: Write failing package/lock tests.** Assert the private package has no declaration/bin/export/code and exactly pins reviewed runtime direct dependencies; `allowBuilds` remains empty; daemon has no direct/optional/bundled Laya or ONNX dependency; packed daemon contains both root JSON assets. Feed tiny package tarballs to the lock builder and require byte-identical expected JSON, raw-byte path sorting, exact SHA-512 integrity, both macOS file lists, executable bit and rejection of a non-HTTPS/duplicate/unsorted/unknown lock field.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 manifest|runtime lock|runtime package'
  node --test packages/events-daemon/test/laya-runtime-package.test.mjs
  ~~~

  Expected: missing private declaration/assets/generator fails before any registry or model request.
- [ ] **Step 3: Implement the strict assets and builder.** Add the reviewed single-entry manifest and canonical lock format from E2-2/E2-3. Resolve only the private importer's full closure from `pnpm-lock.yaml`; accept tarball bytes only through the builder's injected source; reconstruct platform file lists with task 5's strict parser; produce canonical JSON. Add a `verify:laya-runtime-lock` script that uses fixtures locally and release-provided verified bytes only in the release job.
- [ ] **Step 4: Protect package/release boundaries.** Add daemon root assets to its packed files and consumer assertions. Add static tests that private packages do not enter `PUBLISHABLE`, `PACKAGES`, surfaces or drivers, while the daemon remains held and dependency-clean.
- [ ] **Step 5: Add paired mutants.** Publish/private-declare the runtime package incorrectly; add a daemon runtime dependency; remove a lock asset from tarball; accept a tarball URL without SHA-512; or change canonical sorting. Each makes its named test red.
- [ ] **Step 6: Review and commit.** P1-only review: exact pins, no runtime code/private surface, lock generator cannot read user npm config, pack contents, no install script. Commit:

  ~~~text
  build(events): pin Laya artifacts outside the daemon dependency tree
  ~~~

**Passing.** Only tiny local tarballs are read; package and lock invariants hold. Run `pnpm verify`.

### Task 3 — E2 structural checker and mutation harness

**Files.**

- Create: `scripts/verify-events-phase-e2-tests.mjs`, `packages/events-daemon/test/laya-mutations.test.ts`, `packages/events-daemon/test/laya-scope.test.ts`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`, `packages/events-daemon/test/support/laya-mutants.ts`
- Modify: root `package.json` only to run the completed checker through test/verify; later tasks append their cases in the same commit.

**Produces.** The mandatory owner/mutation/network/test-path manifest used by every later task.

- [ ] **Step 1: Write checker self-tests.** In copied manifests, prove failure for an unowned §5/traceability/await row, duplicate owner, orphan mutation, wrong test pattern, missing loopback preload, real hostname, raw corpus field, test-local ledger, daemon dependency on Laya, duplicate judge-kind literal and skipped mutant.
- [ ] **Step 2: Implement the production-copy mutant runner.** Copy one named production module to a temporary tree, apply one declared edit, run only the mapped `node:test` pattern under the loopback seal, and fail if it passes or did not execute. It must never invoke a release/gate command.
- [ ] **Step 3: Register tasks 1–2.** Add the exact E2 contract/package cases and all mutation names in their commits; reject missing source/test mapping.
- [ ] **Step 4: Run the checker.** Run:

  ~~~text
  node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-events-phase-e2-tests.mjs
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 mutation|laya scope'
  ~~~

- [ ] **Step 5: Review and commit.** P1-only review: a mutant runs production code, no no-op default branch, seal precedes network import, and no test model replaces E state. Commit:

  ~~~text
  test(events): enforce phase E2 Laya proof pairing
  ~~~

**Passing.** Every Task 1–2 invariant has one real-path test and one red mutant. Run `pnpm verify`.

## Batch 2 — verified artifacts

### Task 4 — pinned artifact fetcher and resumable model download (high risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/fetcher.ts`, `packages/events-daemon/src/runtime/laya/artifact-paths.ts`, `packages/events-daemon/src/runtime/laya/model-downloader.ts`; `packages/events-daemon/test/laya-fetcher.test.ts`, `packages/events-daemon/test/laya-model-download.test.ts`, `packages/events-daemon/test/support/laya-origin.ts`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya.onnx`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya.onnx.data`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya_config.json`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/tokenizer/tokenizer.json`, `packages/events-daemon/test/fixtures/laya/model-tiny-v1/tokenizer/tokenizer_config.json`
- Modify: `packages/events-daemon/src/network/pinned-connection.ts`, `packages/events-daemon/src/network/address-policy.ts` only to expose a bounded reusable raw-byte streaming primitive, never a second network path; `packages/events-daemon/test/fixtures/laya/case-manifest.json`

**Consumes.** B2 raw pinned DNS/TCP/TLS/write primitives and deadline/loopback seal; task 2 manifest/lock.

**Produces.** A production fixed-purpose fetcher and resumable model downloader used by task 6.

- [ ] **Step 1: Write failing scripted-origin tests.** Drive the production fetcher against injected resolver/socket and sealed loopback origin journals. Cover exact lock URL only; SHA-512 mismatch; full revision path; five redirects vs a sixth; HTTP/loopback/private/link-local/metadata redirect-hop refusal; no cookies/auth/proxy; bounded response headers; wrong TLS/DNS drift; Range rehash/correct 206; ignored/malformed/416 range reset; oversize abort; SHA/size retry-to-failed; free-space refusal; partial cleanup on disable; and final rename only after five tiny files verify.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 fetcher|laya model download'
  ~~~

  Expected: no production artifact fetcher/downloader exists and the loopback journal has no external route.
- [ ] **Step 3: Implement raw fetch and strict resume.** Build requests only from the lock/manifest, pass every redirect through B2 address/TLS gates, enforce E2-4 bounds, stream into owner-only partial paths, and rehash before Range. Inject resolver/socket/filesystem/free-space only through constructor interfaces; production constructors have no loopback exemption.
- [ ] **Step 4: Fence all lifecycle writes.** At start, retry and final promotion, acquire the artifact mutex and recheck E's exact pointer/embedded document/job epoch. Disable/purge aborts I/O and deletes partials; it cannot delete a verified tree.
- [ ] **Step 5: Add paired mutants.** Use a branch/revision short form; permit Authorization; follow HTTP/sixth/private redirect; trust partial length; accept 200 for Range; promote before final SHA; or forget the final pointer check. Each fails its named case.
- [ ] **Step 6: Review and commit.** P1-only review: raw request construction, redirect/address ordering, byte caps, no sender content, resume correctness, cancellation and no alternate HTTP client. Commit:

  ~~~text
  feat(events): download only verified resumable Laya model bytes
  ~~~

**Passing.** Every request journal is injected/loopback and every incorrect byte state remains partial/failed. Run `pnpm verify`.

### Task 5 — strict tar extraction, runtime installer and whole-tree verifier (high risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/tar.ts`, `packages/events-daemon/src/runtime/laya/runtime-installer.ts`, `packages/events-daemon/src/runtime/laya/tree-verifier.ts`; `packages/events-daemon/test/laya-tar.test.ts`, `packages/events-daemon/test/laya-runtime-installer.test.ts`, `packages/events-daemon/test/laya-tree-verifier.test.ts`; `packages/events-daemon/test/fixtures/laya/tar/valid.tgz`, `packages/events-daemon/test/fixtures/laya/tar/symlink.tgz`, `packages/events-daemon/test/fixtures/laya/tar/hardlink.tgz`, `packages/events-daemon/test/fixtures/laya/tar/device.tgz`, `packages/events-daemon/test/fixtures/laya/tar/fifo.tgz`, `packages/events-daemon/test/fixtures/laya/tar/absolute.tgz`, `packages/events-daemon/test/fixtures/laya/tar/dotdot.tgz`, `packages/events-daemon/test/fixtures/laya/tar/backslash.tgz`, `packages/events-daemon/test/fixtures/laya/tar/nul.tgz`, `packages/events-daemon/test/fixtures/laya/tar/duplicate.tgz`, `packages/events-daemon/test/fixtures/laya/tar/pax.tgz`
- Modify: `scripts/laya-runtime-lock.mjs`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`

**Produces.** The exact strict extractor shared by lock reconstruction and daemon install, and the verifier used before every worker start.

- [ ] **Step 1: Write failing archive/tree cases.** Generate tiny gzipped ustar fixtures covering listed/unlisted regular files, all required path/type rejects, duplicate listed/unlisted entries, bad header/size/checksum, missing listed file, wrong hash/size/exec bit, symlink hidden in installed tree, extra file, altered file after earlier verification, and partial/final atomic rename. Assert no shell/system tar/npm/install-script invocation.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 tar|runtime installer|tree verifier'
  ~~~

- [ ] **Step 3: Implement one strict parser and installer.** Reject every disallowed entry before writing it; accept only safe `package/` regular files; stream listed entries to owner-only partial tree while verifying SHA-256; verify complete exact tree; rename once. Make both lock builder and installer call this module rather than duplicate parsing.
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
- Modify: `packages/events-daemon/src/runtime/owner.ts`, `packages/events-daemon/src/runtime/judge-purge.ts`, `packages/events-daemon/src/runtime/lifecycle.ts`, `packages/events-daemon/src/runtime/recovery.ts`, `packages/events-daemon/src/runtime/expiry.ts`, `packages/events-daemon/src/runtime/judge-coordinator.ts`, `packages/events-daemon/src/operations/judges.ts`, `packages/events-daemon/src/operations/doctor.ts`, `packages/events-daemon/src/store/records.ts`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`
- Create: `packages/events-daemon/test/laya-manager.test.ts`, `packages/events-daemon/test/laya-update.test.ts`, `packages/events-daemon/test/laya-purge-closure.test.ts`

**Consumes.** Tasks 1, 4 and 5 plus E's JudgeWorkPurgeParticipant, reservations/holds and laya_models state.

**Produces.** One serial artifact manager registered at E's lifecycle seams; safe status/remove/update behavior for task 8 and C.

- [ ] **Step 1: Write failing lifecycle/race tests.** Through real E enable/disable/purge operations, prove no fetch before claim; claimed enable moves only through legal model states/progress; same manifest re-enable reuses verified trees; disable cancels partial download/kills work but keeps verified trees; remove refuses while enabled; account/rule/hold purge kills only matching request; startup runtime/model change disables with exact audit reason; code-only change does not; downgrade behaves same; verify failure repairs once then fails; and all model-status/doctor data is content-free.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 manager|laya update|laya purge'
  ~~~

- [ ] **Step 3: Implement the artifact mutex and legal transitions.** Serialize install/download/verify/remove/start preparation, track a non-secret job epoch in memory, persist only D8 model status, and call tasks 4/5 components. E kind disable is immediate and triggers abort/worker stop outside its pointer transaction; its final cleanup checks ownership. Re-enable waits for a conflicting remove job then installs/reuses safely.
- [ ] **Step 4: Implement update/repair/remove fences.** On owner startup compare canonical active embed against current assets before worker work; use E's disable operation for mismatch. Repair only selected failing tree once. Model removal uses existing operation only when disabled, rechecks disabled state after each asynchronous filesystem phase, and never touches another manifest/lock tree.
- [ ] **Step 5: Add paired mutants.** Start a download pre-claim; retain partial on disable; delete verified tree during ordinary account purge; let remove win after enable; compare package version instead of manifest/lock; skip second integrity repair failure; or publish a path/content in doctor. Each must fail a unique case.
- [ ] **Step 6: Review and commit.** P1-only review: E owns authority/purge/budget; artifact mutex/job epochs; all post-await rechecks; update reason; content-free observability; no global tree cross-scope deletion. Commit:

  ~~~text
  feat(events): manage verified Laya artifacts through kind lifecycle
  ~~~

**Passing.** Every purge/update/download race leaves E decisions/reservations/artifacts in a closed state. Run `pnpm verify`.

## Batch 3 — execution boundary

### Task 7 — macOS boundary self-test and framed worker protocol (highest risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/worker-protocol.ts`, `packages/events-daemon/src/runtime/laya/worker-boundary-probe.ts`, `packages/events-daemon/src/runtime/laya/worker-main.ts`; `packages/events-daemon/test/laya-boundary.test.ts`, `packages/events-daemon/test/laya-worker-protocol.test.ts`, `packages/events-daemon/test/support/laya-worker-standin.ts`
- Modify: `packages/events-daemon/src/runtime/laya/contracts.ts`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`

**Produces.** The exact spawn/profile/environment/frame contract used by task 8; no native runtime import yet.

- [ ] **Step 1: Write failing boundary/protocol tests.** Assert literal sandbox executable/profile, direct argument array, pipe-only fds, exact environment allow-list, bounded frame parser, random request/probe ids, listener ownership cleanup, no profile/no sandbox unavailable result, TCP-only and UDS-only stand-in escapes killing the worker before load, and pipe liveness. Source scans reject network imports outside boundary probe and reject worker references to daemon DB/control/secrets/provider modules.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 boundary|laya worker protocol'
  ~~~

- [ ] **Step 3: Implement probe-before-load.** Start the disposable listeners; spawn a Node-built-in-only probe under the literal profile; require both client errors plus zero listener accepts; kill/report `boundary-failed` otherwise; send no load frame before success. Make Linux/Windows and missing/profile-failed macOS a reasoned unavailable status before enablement prepare.
- [ ] **Step 4: Add defence in depth.** After probing, patch fetch/network construction to throw, assert no sockets remain beyond pipes, and keep runtime import in a later worker-load function. Bound stderr/frame diagnostics and never echo request input.
- [ ] **Step 5: Add paired mutants.** Remove UDS probe; accept one successful connection; load before probe; inherit proxy/NODE_OPTIONS/fd; use shell; permit a network import; or treat simulated sandbox as production availability. Each fails a single named test.
- [ ] **Step 6: Review and commit.** P1-only review: profile bytes, test/production separation, listener timing, error redaction, source scan, unavailable behavior and cleanup. Commit:

  ~~~text
  feat(events): prove the Laya worker boundary before load
  ~~~

**Passing.** Stand-ins prove the daemon never sends load after either boundary escape. Run `pnpm verify`.

### Task 8 — isolated Laya supervisor and E coordinator adapter (highest risk)

**Files.**

- Create: `packages/events-daemon/src/runtime/laya/templates.ts`, `packages/events-daemon/src/runtime/laya/worker-runtime.ts`, `packages/events-daemon/src/runtime/laya/worker-supervisor.ts`; `packages/events-daemon/test/laya-supervisor.test.ts`, `packages/events-daemon/test/laya-evaluation.test.ts`, `packages/events-daemon/test/laya-worker-runtime.test.ts`
- Modify: `packages/events-daemon/src/domain/judges.ts`, `packages/events-daemon/src/runtime/judge-coordinator.ts`, `packages/events-daemon/src/runtime/judge-budget.ts`, `packages/events-daemon/src/runtime/laya/manager.ts`, `packages/events-daemon/src/runtime/owner.ts`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`

**Consumes.** Tasks 1, 6 and 7; E's request/answer/reservation/hold machinery.

**Produces.** The Laya registry executor, one-child supervisor and worker runtime adapter.

- [ ] **Step 1: Write failing real-coordinator tests.** Send synthetic E production projections through deterministic prefilter, E fixed envelope/taint/reserve/in-flight and the Laya adapter. Prove no worker for false prefilter/disabled/unavailable/no budget; exactly one framed request after reservation; request lacks event/account/target/secret; template is manifest-listed; 512-token overflow is malformed; score NaN/infinity/range/wrong type is malformed; score is unchanged; actual token usage settles once; 30-second hang/crash/late answer produces no-match and kills/restarts child; idle ten-minute exit; and a second request is serialized.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 Laya supervisor|laya evaluation|laya worker runtime'
  ~~~

- [ ] **Step 3: Implement worker runtime without package fallback.** Dynamically import only from the verified extracted runtime tree after task 7 success; call the exact CPU-only load; implement the two immutable templates; count before run; return only score/input-token/closed reason. Test direct runtime logic with injected stand-in; process integration uses only task 7's frame-compatible stand-in entry.
- [ ] **Step 4: Implement supervisor/coordinator bridge.** Bind child generation to E reservation/work id, enforce one request, kill on deadline/purge/disable/stop, discard stale frame/exit, and pass answers solely to E coordinator. Let E's existing final settlement recheck exact reservation/projection/switch/account/rule/kind/budget/hold facts.
- [ ] **Step 5: Add paired mutants.** Import runtime before boundary/tree check; invoke default downloader; run concurrent request; silently truncate; accept/clamp output; return a provider match/reason; fail to kill timeout; or settle a late answer. Each fails its named case.
- [ ] **Step 6: Review and commit.** P1-only review: E ordering is unaltered, child has no authority, dynamic path is verified, no native dependency leak, timeout/kill ordering and reservation fence. Commit:

  ~~~text
  feat(events): execute bounded Laya decisions in an isolated worker
  ~~~

**Passing.** A real E coordinator receives only bounded Laya answers from an isolated test stand-in and all error modes are no-match. Run `pnpm verify`.

## Batch 4 — quality and release gate

### Task 9 — aggregate-only labelled quality gate and local metric proof

**Files.**

- Create: `scripts/run-laya-quality-gate.mjs`, `scripts/verify-laya-quality-gate.mjs`, `packages/events-laya-runtime/gate/schema-v1.json`, `packages/events-daemon/test/laya-quality-gate.test.ts`, `packages/events-daemon/test/fixtures/laya/quality/metrics-v1.json`, `packages/events-daemon/test/fixtures/laya/quality/bad-report-v1.json`
- Modify: `packages/events-laya-runtime/README.md`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`

**Produces.** A protected, external-corpus gate protocol and static aggregate validator. The committed `gate/<manifestId>.json` is added only from a real consented gate run, never as a fixture/placeholder.

- [ ] **Step 1: Write failing metric/report tests.** Use a tiny synthetic labelled vector to prove ten equal-width ECE, Brier, AUROC, positive share, latency percentile/memory aggregation and maximum reference delta calculations. Reject insufficient Gmail/Slack counts/positive rate, one-channel-only report, wrong manifest/lock/template/runtime/gate-subject hashes, raw or secret-like corpus data, per-item values, unknown fields, duplicate templates and a passing flag inconsistent with thresholds.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 quality gate'
  node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-laya-quality-gate.mjs --fixture
  ~~~

- [ ] **Step 3: Implement aggregate protocol.** Make the runner require an explicitly supplied external corpus directory, refuse any path inside the repository, produce no per-item stdout/log/artifact, run worker and pinned Python reference, and write only schema-validated aggregate. The verifier recomputes gate-subject digest from assets/source and requires every offered template/channel threshold.
- [ ] **Step 4: Document consented real-mac run.** In the private runtime README, state corpus consent/provenance, encryption/retention/outside-tree handling, no provider calls, Apple-silicon/Intel evidence rule, and that only the sanitized report may be copied into the repository. Record the owner action as a release prerequisite, not a test step.
- [ ] **Step 5: Add paired mutants.** Collapse Gmail/Slack; use model-card calibration; omit a template/source digest; accept a raw item; calculate bins incorrectly; accept 199/<30%; or permit a fixture report as release evidence. Each fails its named test.
- [ ] **Step 6: Review and commit.** P1-only review: privacy scan, metrics definitions, thresholds, exact subject binding, external-directory refusal and no quality assertion from synthetic data. Commit:

  ~~~text
  test(events): gate Laya probability labels on aggregate evidence
  ~~~

**Passing.** Unit fixtures prove gate math/report privacy; no actual model/corpus is used. Run `pnpm verify`.

### Task 10 — release refusal, package audit and SECURITY/documentation contract

**Files.**

- Modify: `.github/workflows/release.yml`, root `package.json`, `scripts/release.mjs`, `packages/events-daemon/package.json`, `packages/events-daemon/README.md`, `packages/events-laya-runtime/README.md`, `SECURITY.md`, `docs/RELEASING.md`, `CHANGELOG.md`
- Create: `.github/workflows/laya-quality-gate.yml`, `test/laya-release-gate.test.mjs`, `test/laya-security-doc.test.mjs`
- Modify: `test/release-packages.test.mjs`, `test/events-daemon-package.test.mjs`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`

**Produces.** A future release can publish an unheld daemon only after lock reconstruction and exact aggregate validation; E2 itself stays held.

- [ ] **Step 1: Write failing release/package/security tests.** In copied workflow/release assets, unhold the daemon and prove release fails for no aggregate, stale manifest/lock/template/gate-subject, failed template, absent arm64/Intel evidence as applicable, lock reconstruction drift, daemon dependency leak, or missing root lock asset. Assert both D2 Laya SECURITY bullets byte-for-byte, current holds remain, and docs say macOS-only/English/CPU/boundary/ordinary downloads/quality gate without promising same-user protection.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  node --test test/laya-release-gate.test.mjs test/laya-security-doc.test.mjs test/events-daemon-package.test.mjs
  ~~~

- [ ] **Step 3: Add conditional release gate.** When and only when `events-daemon` enters `PACKAGES`, release first reconstructs/checks the lock from verified tarballs and validates exact aggregate evidence; failure stops before OIDC preflight/publish. Add the protected macOS quality workflow with no npm/publish credentials and only an owner-provisioned external corpus mount. It emits the aggregate for review; the normal release accepts only its committed sanitized report plus matching subject digest.
- [ ] **Step 4: Make packaging/security assertions mechanical.** Require daemon tarball assets, prohibit Laya/ONNX in daemon dependency closure and desktop bundle, preserve private runtime absence from publication, and append exactly D2's Laya vulnerability/safety-model bullets. Explain in release docs that the packages remain held and a future owner release needs the evidence.
- [ ] **Step 5: Add paired mutants.** Skip release validation on daemon; accept an arbitrary report; run quality in `pnpm verify`; publish runtime package; remove one SECURITY sentence; add ONNX dependency; or lift a hold. Each fails its named test.
- [ ] **Step 6: Review and commit.** P1-only review: pre-publish placement, evidence provenance, no corpus/credential leak, held-release behavior, exact asset packing and security wording. Commit:

  ~~~text
  ci(events): require Laya gate evidence before a daemon release
  ~~~

**Passing.** Normal verification is model/network free; a future unhold is mechanically impossible without exact aggregate evidence. Run `pnpm verify`.

## Batch 5 — desktop and control join

### Task 11 — Phase C Laya enablement/progress/status contract (blocked until C)

**Files.**

- Modify Phase E's exact daemon contract files: `packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json`, `packages/events-daemon/test/judge-desktop-contract.test.ts`, `packages/events-daemon/src/operations/judges.ts`, and `packages/events-daemon/src/operations/doctor.ts`.
- Modify after rebase onto C: `apps/desktop/src/control-contract.ts`, `apps/desktop/src/screens/judges.tsx`, `apps/desktop/test/control-contract.test.ts`, `apps/desktop/test/full-flow.test.mjs`, and `apps/desktop/test/mutations/manifest.json`.
- Modify: `packages/events-daemon/test/fixtures/laya/case-manifest.json`.

**Consumes.** C's exact `idle | installing | downloading | verifying | ready | failed | unavailable` UI slot and no-Laya-bundle rule; B3/E existing shared judge operations.

- [ ] **Step 1: Write failing cross-surface vectors.** Freeze daemon responses for disabled, approval-pending, macOS unavailable, installing/downloading byte progress, verifying, ready, failed/integrity, boundary-failed, removal-complete-as-`idle`, and Linux/Windows unavailable. Require stable reason codes and no path/input/secret. Drive C's real Rust/TypeScript adapter with the sealed D12 peer, not a UI-local state model.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E10|desktop contract|E2 Laya contract'
  pnpm --filter @agentcomms/desktop test -- --test-name-pattern='control-contract|full-flow'
  ~~~

- [ ] **Step 3: Implement only shared contract corrections.** Map existing `judge kind enable|disable` and `judge model status|remove` to E2 status without adding a UI evaluator/downloader/secret route. C renders daemon-provided state/reason and opens existing approval/secrets surfaces; no app model/runtime/worker/Node code is added.
- [ ] **Step 4: Add paired mutants.** Mark a model ready before tree verification; omit unavailable/boundary reason; expose a path; let app infer enabled; or put a Laya artifact in the bundle. Each fails the exact daemon/C production adapter/bundle scan.
- [ ] **Step 5: Review and commit.** P1-only review: daemon authority, DTO stability, app capability/CSP boundaries, no secret/no artifact, no extra capability row. Commit:

  ~~~text
  test(events): prove desktop Laya status and progress contracts
  ~~~

**Passing.** The app is only a safe presenter of E2 status and remains artifact-free. Run `pnpm verify`.

## Batch 6 — exhaustive safety proof

### Task 12 — E2 race, identity, purge and mutation audit (highest risk)

**Files.**

- Modify: `packages/events-daemon/test/laya-contract.test.ts`, `packages/events-daemon/test/laya-fetcher.test.ts`, `packages/events-daemon/test/laya-model-download.test.ts`, `packages/events-daemon/test/laya-tar.test.ts`, `packages/events-daemon/test/laya-runtime-installer.test.ts`, `packages/events-daemon/test/laya-tree-verifier.test.ts`, `packages/events-daemon/test/laya-manager.test.ts`, `packages/events-daemon/test/laya-update.test.ts`, `packages/events-daemon/test/laya-purge-closure.test.ts`, `packages/events-daemon/test/laya-boundary.test.ts`, `packages/events-daemon/test/laya-worker-protocol.test.ts`, `packages/events-daemon/test/laya-supervisor.test.ts`, `packages/events-daemon/test/laya-evaluation.test.ts`, `packages/events-daemon/test/laya-quality-gate.test.ts`, `packages/events-daemon/test/laya-desktop-contract.test.ts`, `packages/events-daemon/test/laya-mutations.test.ts`, `packages/events-daemon/test/laya-scope.test.ts`, `packages/events-daemon/test/support/laya-mutants.ts`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`, `scripts/verify-events-phase-e2-tests.mjs`
- Repair production modules only where this audit finds an actual fence gap.

- [ ] **Step 1: Make every matrix exhaustive.** Enumerate every E2 await/write, external/raw identity, artifact lifecycle purge caller, test fixture, §5 row and traceability row. The verifier fails if one lacks exactly one owner and one red mutant.
- [ ] **Step 2: Race production seams.** Pause every real fetch/hash/fs/tree/probe/worker/operation seam; race kind disable/re-enable, budget swap, rule/judge revoke, account remove/re-add, visibility hide, expiry/hold, model remove, update/downgrade, boundary failure and competing start. Resume and assert no stale pointer/state/promotion/load/answer/disclosure.
- [ ] **Step 3: Re-run purges and scope isolation.** Seed two account/source scopes and all Laya manager/worker states through E operations; invoke all E purge callers and restart. Require precise cancellation with no cross-account/source work deletion and no orphan child/claim/partial.
- [ ] **Step 4: Enforce static trust boundaries.** Reject `fetch`/http(s).request/package-manager/child-shell usage in artifact paths; reject network imports outside probe; reject tests without seal; reject daemon Laya dependencies, duplicate kind/template vocabulary, test runtime entry on production spawn and raw-corpus fields.
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

## Batch 7 — final evidence, release readiness and review

### Task 13 — end-to-end gate evidence, packed artifacts and PR handoff

**Files.**

- Create: `packages/events-daemon/test/laya-e2e.test.ts`, `test/laya-manual-macos-checklist.md`
- Modify: `packages/events-daemon/test/consumer-check.mjs`, `test/events-daemon-e2e.test.mjs`, `test/release-packages.test.mjs`, `packages/events-daemon/README.md`, `CHANGELOG.md`, `packages/events-daemon/test/fixtures/laya/case-manifest.json`

- [ ] **Step 1: Write failing E2E/packed checks.** Drive the actual owner/control operation with a synthetic rule through E deterministic prefilter, taint, reservation, Laya artifact ready state, boundary probe stand-in, worker frame, E settlement/no-match/hold and all disable/purge/restart paths. Pack/install the daemon into a sealed consumer and require manifest/lock/worker assets, no native dependency tree, no model/runtime preinstall and preserved holds. A copied release state without aggregate evidence must fail before any publish path.
- [ ] **Step 2: Run focused failures.** Run:

  ~~~text
  pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='E2 end to end|laya consumer'
  node --test test/events-daemon-e2e.test.mjs test/release-packages.test.mjs
  ~~~

- [ ] **Step 3: Implement only integration wiring/evidence.** Reuse production owner/manager/supervisor/coordinator/control modules and synthetic fakes; do not create an E2 test-only daemon model. Add the manual macOS checklist covering arm64/Intel availability, absent/profile-failed sandbox, TCP/UDP/fetch/UDS denial with pipes, real native load, timeout/crash/idle, altered tree repair, release lock reconstruction and external consented quality report review.
- [ ] **Step 4: Run final machine checks.** Run:

  ~~~text
  pnpm verify:parity --strict
  pnpm verify:packages
  pnpm verify
  git diff --check
  git status --short
  ~~~

  Record only command status in the PR. Do not run a real model, model download, quality corpus, release, tag, publish, email or message command as part of ordinary verification.
- [ ] **Step 5: Review and commit.** P1-only review: E's one judge path, packed assets, no native model/dependency preinstall, holds, release ordering, no real data, manual evidence boundary. Commit:

  ~~~text
  test(events): prove the held Laya runtime end to end
  ~~~

**Passing.** The full synthetic production path is safe and package/release gates fail closed. The manual macOS/quality evidence remains an owner-controlled prerequisite for offering Laya in a release. Run `pnpm verify`.

## §5 coverage ownership

Each E2-owned test clause has exactly one task owner. Existing E ownership of generic judge enablement, budgets, holds, TypeSafe/local-endpoint transport, B3 parity and C app security remains unchanged.

| §5 row / E2-owned assertion | Sole task |
| --- | ---: |
| 2884–2892: default-disabled Laya, normal E enablement/claim only, unavailable-before-intent and canonical enablement/document vectors | 1 |
| 2892–2895, 2904: private dependency-only package, shipped lock, byte-identical fixture rebuild and daemon dependency exclusion | 2 |
| 2892–2895: runtime fetch is lock-URL-only and SHA-512-pinned, starts only after claim | 4 |
| 2893–2895: strict runtime archive shape/listing/owner-only extraction and no npm/install script | 5 |
| 2895–2900: full-revision model request, redirect/address/header policy, over-size, retry, Range resume, free space, disable cleanup and final rename | 4 |
| 2901–2903: exact whole-tree verification before native import/start, one repair, then failed | 5 |
| 2905–2907: update/downgrade tightening, code-only no-op and verified-tree retention/removal | 6 |
| 2907–2908: child environment/descriptor fence and package downloader unreachable | 8 |
| 2908–2916: macOS deny-network TCP/fetch/UDP/UDS boundary/self-test and unavailable Linux/Windows/doctor reason | 7 |
| 2916–2919: in-worker defence, malformed/token/score handling, concurrency one, timeout/crash/no-match/restart and idle exit | 8 |
| 2920: injected stand-in in ordinary tests; no real bundle in `pnpm verify` | 13 |
| 2921–2922: external-only aggregate harness, consent/data-rejection checks and exact manifest/template aggregate validity | 9 |
| 2922: release refuses an offered template without exact passing evidence; held/package/SECURITY release guard | 10 |
| 3326–3336: C presentation-only DTO/bundle contract and existing B3 CLI/MCP prepare-only contract join | 11 |
| All E2 await fences, stable identity scope, purge closure, production-path/mutation pairing and loopback seal | 12 |
| Synthetic owner-to-packed-consumer proof plus the owner-only real-mac checklist | 13 |

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
| D11 2167-2204 | macOS sandbox-exec profile, unavailable other platforms, per-start TCP/UDS self-test and in-worker defence | 7 | `E2 boundary probe fence`, `E2 sandbox unavailable before prepare` |
| D11 2206-2213 | Exact bounded request/templates/token refusal/answer/token charge/30-second timeout | 8 | `E2 Laya worker runtime vectors` |
| D11 2215-2256 | Reviewed strict manifest and embedded activation entry | 1, 2 | `E2 manifest canonical vectors`, `E2 enablement digest vectors` |
| D11 2258-2277 | Release-built daemon lock, private package, exact tarball integrity/file lists and no scripts | 2, 5 | `E2 runtime lock rebuild`, `E2 strict tar extractor` |
| D11 2279-2299 | Post-claim install; exact lock extraction; fixed model fetch/redirect/range/hash/retry/space/rename | 4, 5, 6 | `E2 model download matrix`, `E2 runtime installer matrix`, `E2 manager claim fence` |
| D11 2301-2311 | Whole-tree verification/reinstall/failure and verified-tree retention/disable/remove rule | 5, 6 | `E2 tree verifier matrix`, `E2 verified artifact lifecycle` |
| D11 2313-2319 | Runtime/model update and downgrade disable rule | 6 | `E2 Laya update/downgrade matrix` |
| D11 2321-2335 | No daemon dependency/installer/app artifact; app shows status/progress; stated limits | 2, 10, 11 | `E2 daemon dependency boundary`, `E2 release asset guard`, `E2 desktop Laya contract` |
| D11 2337-2350 | Per-manifest/runtime/template Gmail+Slack labelled quality gate thresholds and release condition | 9, 10 | `E2 quality gate aggregate vectors`, `E2 release rejects stale Laya evidence` |
| D13 2608-2613 | Judges surface has enable/disable/status/progress/reason/removal, without app runtime | 11 | `E2 desktop Laya contract` |
| D14 2677-2686, 2715-2719 | Private dependency-only runtime package; daemon carries worker/manifest/lock; no install script | 2, 10 | `E2 private runtime package`, `E2 daemon package boundary` |
| §4 2829, 2832-2833 | E2 phase deliverable/dependency ordering; no kind callable pre-E/enablement | 1, 13 | `E2 laya contract`, `E2 end to end held path` |
| §5 2884-2922 | Complete Laya install/download/tree/update/worker/boundary/gate acceptance matrix | 1, 4–10, 12, 13 | §5 ownership table above and `verify-events-phase-e2-tests` |
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
| macOS isolation reviewer | exact sandbox command/profile, fds/environment, boundary self-test, UDS/TCP/UDP/fetch denial, worker imports/frames/timeout |
| Lifecycle/scope reviewer | every post-await recheck, E purge participant, account/source stable scope, disable/re-enable/remove/update/recovery races |
| Quality/release reviewer | consent/data protocol, metric math, aggregate privacy scan, gate-subject binding, release pre-publish refusal, holds/packaging/SECURITY |
| C/test-integrity reviewer | daemon-to-C status DTO, app artifact boundary, real production paths, fixture seal, mutation pairing and structural verifier |

Any P1 is fixed by the task owner; rerun that task's focused tests, named mutants and `pnpm verify`. A new recurring defect class is not reviewer memory: add it to the automatic ledger/checker and map a mutant before approval.

## Pull-request payload and release status

The E2 PR proposes **`0.16.0-events-e2`** if main remains `0.15.2`: a minor prerelease because it adds an opt-in capability without breaking an existing published API. Recompute only from current main when opening the PR. Its description carries:

1. what changes for a person: macOS-only, English-only local Laya can be approved and downloaded after E; how the daemon verifies/isolate it; Linux/Windows remain unavailable;
2. the version and semver reason;
3. focused test/mutation results, each batch's `pnpm verify`, final package/parity checks, and separately the owner-controlled real-mac checklist/gate result when a release is contemplated;
4. docs/reference impact (no new capability), README, SECURITY, RELEASING, private runtime documentation and a user-facing CHANGELOG line; or `No changelog: <why>` only if the owner decides the held-only change is not user-noticeable;
5. provenance: this local-event design and B1/B2/D/E/C plans read 2026-10-10; the D11 sources already recorded in the design; any observed protected macOS gate; no live Gmail/Slack/provider testing by repository tests; and AI assistance;
6. explicit confirmation that fixtures are synthetic, the consented quality corpus stays outside the repository, and no real address, message, token, key, secret or client data is committed.

The events library and daemon remain held; E2 does not tag, publish, unhold, send or contact a model host. A future owner release first satisfies task 10's gate then follows `docs/RELEASING.md` to lift/publish events before daemon from one checked tag.

## Implementation commit sequence

1. `feat(events): define the bounded Laya judge-kind seam`
2. `build(events): pin Laya artifacts outside the daemon dependency tree`
3. `test(events): enforce phase E2 Laya proof pairing`
4. `feat(events): download only verified resumable Laya model bytes`
5. `feat(events): install Laya runtime through a strict verified extractor`
6. `feat(events): manage verified Laya artifacts through kind lifecycle`
7. `feat(events): prove the Laya worker boundary before load`
8. `feat(events): execute bounded Laya decisions in an isolated worker`
9. `test(events): gate Laya probability labels on aggregate evidence`
10. `ci(events): require Laya gate evidence before a daemon release`
11. `test(events): prove desktop Laya status and progress contracts`
12. `test(events): exhaustively fence Phase E2 Laya lifecycle races`
13. `test(events): prove the held Laya runtime end to end`

**Plan-document commit message:** `docs(plan): local event emission — phase E2`
