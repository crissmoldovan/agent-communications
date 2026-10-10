# Local event emission — Phase C desktop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the version-1 local desktop control surface in `apps/desktop`: a Tauri v2 app that safely supervises and controls the local events daemon, isolates secret entry in a separate window, and is released only as an unsigned `desktop-v*` prerelease.

**Architecture:** The React UI is a presentation client. Rust owns every local control connection, daemon token, child process, native window, navigation decision, approval rendering and secret hand-off; it exposes a typed, non-secret command allow-list to `settings` and a disjoint, complete D2 secret-operation allow-list to `secrets`. The app neither reads providers nor opens the event database, and it retains no offline mutation queue: B3's daemon operations remain the single authority.

**Tech Stack:** Tauri **v2** (the spec's versioned framework choice), Rust stable, React 19, Vite, TypeScript, `@cueplusplus/ui` 0.20.1, `@cueplusplus/tokens` 0.20.1, `@cueplusplus/theme-cue` 1.1.1, `@cueplusplus/theme-base` 1.3.0, Node 22.18+, pnpm 11, `node:test`, Rust `cargo test`, and an actual bundled Tauri-webview probe on macOS, Windows and Linux.

This plan starts from `feat/events-c` at `556feb64` (the converged B2 + Phase D tree). It plans against B3's specified API, but B3 is not present yet. It does not amend B3, add a daemon operation, send to a provider, or make a network request in a test.

## Global constraints

- Read and preserve the local-event design, the CLI/MCP parity design and the channel-plugin design. `agentcomms` remains a channel declaration; the desktop is a private workspace app, not a channel or a published package.
- `apps/desktop` is a pnpm workspace member but is independently versioned. `pnpm verify` must run its TypeScript typecheck, unit tests and TypeScript preview-vector test; Cargo and bundle checks run in the desktop workflow on macOS, Windows and Linux.
- Use Tauri v2 only. The exact patch is lockfile-pinned in both `apps/desktop/src-tauri/Cargo.lock` and `pnpm-lock.yaml`; `Cargo.toml` and `package.json` may name the supported v2 major but may not mix Tauri v1 APIs or a non-v2 plugin. The spec names v2 but no patch floor, so the lockfiles, not an invented patch number, are the reproducibility source of truth.
- Production CSP is byte-for-byte D13's value. `dangerousDisableAssetCspModification` remains `false`; the `secrets` document adds its stricter meta CSP.
- No frontend has shell, filesystem, HTTP/opener, clipboard, dialog, external-protocol, download, or window-creation permission. Rust alone opens local-control sessions and starts/stops a daemon child.
- `secrets` is a separately labelled Tauri window and entry document, never a React route. Its capability is non-overlapping and exposes only the D2 secret commands.
- A secret byte is accepted only by the `secrets` IPC argument or returned only by its one reveal-once response. It never reaches `settings`, a generic command, logs, telemetry, audit, state JSON, SQLite, a trace, or a test fixture.
- All test accounts, secrets, URLs, messages and tokens are synthetic. Node tests use the existing loopback seal before an import that could reach a transport; webview probes use a loopback trap and require zero requests. No test calls Gmail, Slack, Resend, WhatsApp, a registry, or a signing service.
- The desktop bundle contains no Node runtime/code, daemon database, ONNX Runtime, Laya worker or model. The app does not download any of them.
- The daemon and `@agentcomms/events` remain held. Phase C neither changes their `agentcommsRelease` holds nor inserts the desktop in `scripts/packages.mjs`.
- Every batch ends with root `pnpm verify`; a batch touching `packages/events` would also run `pnpm verify:browser`, but Phase C must not modify that package.
- Every task starts with a focused failing test, ends with an independent P1-only diff review, runs its named mutations through the production path, and updates the mutation manifest. A green test without its paired destructive mutation is a failure.

---

## Decisions the spec leaves to the plan

### C-1. Framework and UI version: locked Tauri v2 + React/Vite/CUE++

Use the Tauri **v2** API family with React 19 and Vite. Use the public CUE++ package versions recorded by the design: `@cueplusplus/ui` 0.20.1, `@cueplusplus/tokens` 0.20.1, `@cueplusplus/theme-cue` 1.1.1 and transitive `@cueplusplus/theme-base` 1.3.0. The patch-level Tauri choice is deliberately resolved once by the clean, frozen-lockfile bootstrap and committed in `apps/desktop/src-tauri/Cargo.lock` and `pnpm-lock.yaml`; upgrades are explicit dependency-review commits.

Reason: D13 mandates Tauri v2, React, Vite and these design-system packages (design lines 2581-2587). It also records the security properties C relies on: labelled capabilities and command manifests (lines 86-88), CSP and Tauri IPC origins (lines 86-88), checked from Tauri's official documentation on 2026-10-05; and the CUE++ versions/public MIT packages, checked against npm on 2026-10-06 (line 111). This plan was read on 2026-10-10 and makes no new network claim.

Reasonable alternatives rejected: Electron would duplicate a browser/runtime and violate the Tauri choice; Tauri v1 lacks the specified v2 capability model; a SPA-only browser UI cannot enforce the window/capability and local-token boundary; an unpinned `latest`/uncommitted Cargo resolution would make a security surface non-reproducible.

### C-2. Workspace and build boundary

Create the private workspace member `@agentcomms/desktop` at `apps/desktop`, add `apps/*` to `pnpm-workspace.yaml`, and extend root build/typecheck/test filters to include both `packages/**` and `apps/**`. The app's normal `build` is Vite's static multi-page build, its root-run test is TypeScript unit/vector tests, and its `tauri:build`, Cargo lint/test and real-webview probe are explicit desktop-workflow commands. The app has no `agentcommsPackage`/`agentcomms` field and no release hold because it is not an npm package.

Reason: D14 explicitly makes the desktop a workspace app with an independent version and limits root verify to TypeScript-side work (lines 2756-2763). Keeping Cargo out of normal repository verification preserves the stated cross-platform workflow gate without pretending every developer host can package native applications.

Reasonable alternatives rejected: placing it in `packages/` would make publication/registry tooling misclassify it; a separate repository would break the one-CI/release contract; running a Tauri bundle in root `pnpm verify` would make the normal check platform-toolchain-dependent.

### C-3. Rust owns a narrow, versioned daemon client and supervision

Implement the D12 length-prefixed JSON client in Rust, supporting exactly protocol version 1. It reads the owner-only instance/token records, validates the endpoint before sending a token on Unix, sends `hello`, records the selected protocol version in memory, and maps only the documented reply envelope to typed UI errors. It never returns token/session/instance bytes to TypeScript. Wire fixtures exercise the same valid/invalid frames as `packages/events-daemon/src/control/protocol.ts`, and an integration probe connects the Rust client to the real Node control server on Unix. A no-overlap reply blocks all mutation screens with `PROTOCOL_UNSUPPORTED`; it never guesses a newer protocol.

Rust's `DesktopSupervisor` first attaches through `status`; if absent, an explicit person action starts an absolute, owner-selected `agent-events` executable with fixed `run` arguments and no shell. It waits for a fresh authenticated hello, retains only child/process identity and a control-client handle, and never opens the database or providers. Closing `settings` hides it and keeps the tray and daemon. Quitting the tray sends D12 `stop` unless **keep collecting after quit** is enabled; in that case the child inherits/nulls its stdio, Rust drops its handle without killing it, and subsequent management belongs to the CLI. All paths re-check their supervisor generation after an await, so a late spawn cannot survive a concurrent quit.

Reason: D12 calls the Rust app a protocol client (2352-2367) and defines tray lifetime (2374-2376); protocol v1 is currently `[1]` in `packages/events-daemon/src/control/protocol.ts`. The daemon is the authority, so a Rust SQLite binding, a second control server, direct core calls, or a frontend `invoke` that accepts an arbitrary operation would create a second privileged implementation.

Reasonable alternatives rejected: TCP loopback would weaken the established owner-only socket boundary; reimplementing operations in Rust would violate D1; auto-starting a daemon silently would create durable background work without a person action; spawning through a shell or arbitrary arguments would add command-injection surface.

### C-4. Window/capability model is command-disjoint, not route-disjoint

Build exactly two webviews: `settings` (ordinary entry document) and `secrets` (separate entry document). `settings` receives only explicitly declared non-secret `desktop_control`, `desktop_approve`, `desktop_open_secrets`, and supervision/status commands. `secrets` receives only named commands for the complete D2 secret set. `tauri_build::AppManifest::commands` registers every custom command and each capability grants only the commands assigned to its labelled window. No Tauri capability overlaps between the two labels.

The general command takes an exhaustive Rust enum of named **non-secret** B3 operations; arbitrary operation strings, secret operation names, control protocol tokens, preview HTML and daemon endpoint paths are rejected before a control request. `secrets` cannot call approval/general/supervisor commands. The native tray is Rust-only and has no webview capability.

Reason: Tauri merges overlapping capabilities, routes are not a boundary, and undeclared commands otherwise reach all webviews (design lines 86 and 2650-2656). This makes a raw invocation from `settings` fail even if a hostile renderer knows the Rust function name.

Reasonable alternatives rejected: one React app with a `/secrets` route, one broad `desktop_control` IPC command, or a capability shared by both windows would turn a renderer compromise into secret access.

### C-5. Egress is denied twice: exact CSP plus native navigation/new-window refusal

Use the exact production policy from D13:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'
```

Set it in `tauri.conf.json`, retain `dangerousDisableAssetCspModification: false`, and put the stricter secrets meta policy in `secrets.html`. Before either window loads, Rust installs navigation and new-window callbacks that allow only the compiled app origin and deny remote/custom protocol URLs, downloads and new windows. Bundled UI uses no remote fonts/assets, opener, HTTP, WebSocket or shell/file plugin.

The cross-platform test builds the app in release mode with a test-only probe feature, launches the actual bundled webviews and a sealed literal-loopback trap, and attempts `fetch`, XHR, WebSocket, EventSource, beacon, remote image/CSS/script/frame, form submit, top-level navigation, custom protocol, download and `window.open` from **both** labels. It proves zero trap requests, no navigation/new window, and working Tauri IPC. Chromium/WebKit static-asset CSP smoke tests supplement, but never replace, this real-webview gate.

Reason: this exactly implements D13 lines 2629-2648 and 2667-2673. CSP alone does not control native navigation; a navigation handler alone does not control passive network loads.

Reasonable alternatives rejected: a permissive `connect-src` for localhost, CSP `null`, a dev-server check, an allow-list of arbitrary URLs, or a browser-only test all miss a required boundary.

### C-6. Approval and secret bytes remain Rust-mediated and authoritative

For approval, TypeScript may submit only `{ approvalId, digest, typedResponse }`. Rust uses the id/digest to fetch the authoritative structured preview from the daemon, renders it with the Rust text-only renderer, obtains the daemon-issued challenge, and invokes B3's `approve` operation. It never displays any preview field supplied by the webview. TypeScript and Rust consume identical JSON fixtures under `test/fixtures/disclosure-preview/` and compare exact UTF-8 rendering after neutralising HTML, bidi/C0/C1/zero-width/control characters, links and envelope-looking text.

For D2 secrets, Rust passes hidden input directly from the `secrets` window to the same B3 daemon operation, uses `Zeroizing` storage for the shortest possible scope, and only returns create/rotate generated material once to `secrets`. It preserves the D2 contracts: generated target-signing/subscriber values are reveal-once; URL/key input never echoes; secret URL returns only authority/fingerprint; audit output has operation/id/version/outcome/time only. The frontend clears input/result on submit, close, blur and failed navigation; the Rust owner clears pending reveal state when the window closes.

Reason: D2 lines 471-495 and D13 lines 2618-2627/2658-2665 establish precisely this authority and byte boundary. Terminal/app operations share the daemon operation; C is an adapter, never a second secret store.

Reasonable alternatives rejected: trusting webview preview JSON, rendering HTML/links, accepting a secret in a generic command or URL parameter, clipboard-based secret transport, logging a request for diagnosis, or returning a second copy on reload.

### C-7. Version-1 distribution is a separate, unsigned prerelease lane

Add a `desktop.yml` cross-platform PR/build workflow and a `desktop-release.yml` workflow triggered only by `desktop-v*`. The release workflow validates the tag against `apps/desktop/package.json`, repeats the full desktop matrix, builds an ad-hoc-signed universal macOS bundle (`signingIdentity: "-"`) and one unsigned Windows x64 NSIS installer, produces one SHA-256 file, and creates a GitHub prerelease with immutable checked-in first-launch notes. Linux builds/tests but uploads no version-1 artifact. It uses no signing/certificate secret and refuses a non-prerelease/latest release.

The mechanical signing gate is deliberate: the only version-1 workflow path forces `--prerelease` and never calls a signing/notarisation step. A future wider-release change must add a protected signing environment, Developer ID signing + notarisation + staple and Windows certificate signing before it can remove those assertions. A static workflow test fails if the version-1 workflow references a signing secret, omits either launch instruction, lacks either artifact/hash, or can create a latest/non-prerelease release.

Reason: this is D14 lines 2765-2788, not a temporary documentation promise. The build remains unsigned because credentials and identities do not exist in this phase.

Reasonable alternatives rejected: adding a signing secret now, shipping Linux before it has an artifact contract, using the npm `v*` workflow, marking a prerelease latest, or relying on a README instead of a release gate.

### C-8. B3 is a named contract, not an assumption; E/E2 are presentation seams only

Tasks 5–7 start only after B3's operations, exception rows and human-only secret tests have landed. C calls the following B3 surfaces, exactly as D10 names them:

| App area | B3 daemon operations called by C |
|---|---|
| Overview/source health | `status`; `doctor`; `catalogue list`; `catalogue show <type>`; `sources list`; `source show` |
| Rules | `rules list`; `rule show`; `rule create`; `rule update`; `rule enable`; `rule disable`; `rule remove`; `rule test`; terminal/app-only `rule test-retained <eventId>` |
| Targets/subscribers | `targets list`; `target add`; `target update`; `target remove`; `target test`; terminal/app-only `target resume`; `subscribers list`; `subscriber add`; `subscriber update`; `subscriber remove` |
| Deliveries | `deliveries list`; `delivery retry`; `delivery drop`; `held list`; terminal/app-only `held decide`; `dryrun list`; `dryrun show` |
| Judges/budget | `judges list`; `judge add`; `judge update`; `judge remove`; `judge test`; `budget show`; `budget update`; `judge kinds list`; `judge kind enable <kind>`; `judge kind disable <kind>`; `judge model status`; `judge model remove` |
| Daemon/approval | `stop`; `pause`; `resume`; `disable-all`; `enable-all`; terminal/app-only `approve <id>`; `doctor`. The app does **not** call `run`: Rust supervision is the only start path. |
| Dedicated `secrets` only | `target secret create <targetId>`; `target secret rotate <targetId>`; `target url set <targetId>`; `subscriber token create`; `subscriber token rotate`; `judge key set <judgeId>`; `judge key rotate <judgeId>`; `secrets migrate --to keychain|file`. |

E seam: C owns stable empty/loading/error/ready contracts and views for `held list|decide`, judge-kind enablement and `judge model status`, but it implements no judge, hold, budget reservation or network call. E populates those DTOs through its B3 operations. E2 seam: the Judges view has an immutable `idle | installing | downloading | verifying | ready | failed | unavailable` model-progress slot, displays the daemon-provided reason for Linux/Windows unavailability, and never bundles/downloads Laya. E2 supplies the producer and macOS-only progress; C only polls the existing status operation over local control.

Reason: Phase E explicitly depends on C's hold resolution and Judges screen and E2 on enablement/progress (lines 2828-2829); D11 says the app contains no Node/Laya artifacts (2321-2329). A screen seam is not licence to implement future daemon work.

---

## Spec amendments to raise with the owner

| ID | Spec lines | Ambiguity / contradiction | Plan resolution while awaiting owner |
|---|---:|---|---|
| C-A | D12 2357-2360; B1 decision K5 in `2026-10-07-events-phase-b1.md:176`; D13 2669-2673; D14 2760-2763 | D12 requires a Windows named-pipe ACL; the binding B1 decision says the Node daemon refuses Windows (`WINDOWS_CONTROL_UNAVAILABLE`) until an ACL-capable owner exists; C still owes a Windows app build and real-webview gate. | Compile and run the Windows UI/security/release checks. The Rust client refuses before token read/send when the daemon advertises/has the B1 Windows refusal and shows a non-control status. Do not invent a Rust server or bypass D12. Owner must assign the ACL-capable daemon owner/lift to a phase. |
| C-B | D11 2321-2327; D12 2354 and 2374-2376; D14 2765-2772 | Rust must supervise/detach `agent-events`, while the bundle contains no Node code and the distribution does not specify how it locates/installs the daemon. | Persist an owner-selected absolute executable path in Rust-owned app preferences; launch it without a shell and only as `agent-events run` with pinned state/config paths. First-launch docs call out the separately installed daemon prerequisite. No Node is bundled. Owner should specify a future installer/daemon discovery contract. |
| C-C | D2 471-495; D10 2016 and 2049-2057; D13 2658-2665 | The set of secret operations is exact, but D10 has no Rust/daemon DTO names or response schemas for reveal-once, incomplete slots, migration leftovers and fingerprint-only URL results. | C imports B3's generated/declared operation request/result types; it has no fallback decoder. B3 must expose typed DTOs before Task 6 starts. The C tests freeze only the D2 observable contract, not invented fields. |
| C-D | D13 2591-2616; D10 2013-2017; §4 2825 and 2828-2829 | C is scheduled after B3 but before E/E2, while its mandatory Judges/held screens name data and controls whose producers do not exist until E/E2. | Ship non-actionable, typed `unavailable`/empty state seams and B3 controls that exist; no invented judge/hold implementation. Owner should clarify whether B3 returns stable empty DTOs or explicit phase-unavailable errors. |
| C-E | D13 2632; D13 2641-2643 | The base CSP permits `img-src data:`, while secrets says `img-src ... 'none'`; the prose calls it a tightening meta-policy but does not state whether the base policy is also emitted for secrets. | Emit the base configured CSP plus the stated secrets meta policy; CSP intersection leaves `img-src 'none'`. The production probe verifies the effective stricter result. |
| C-F | D12 2374-2376 | “Quitting the tray app stops the daemon” does not distinguish an app-owned child from an already-running terminal-owned daemon. | Follow the literal default: send D12 `stop` on quit unless keep-collecting is enabled, and record whether it was attached/spawned only for diagnostics. Owner should decide whether a future version may leave an externally started daemon running. |

## Planned file map

| Area | Files / responsibility |
|---|---|
| Workspace/frontend | `apps/desktop/package.json`, `tsconfig.json`, `vite.config.ts`, `settings.html`, `secrets.html`, `src/main.tsx`, `src/secrets-main.tsx`, `src/app.tsx`, and `src/screens/*.tsx`: private multi-page React/CUE++ UI, typed state and no network client. |
| Native authority | `apps/desktop/src-tauri/src/{lib,security,tray,preferences,supervisor}.rs`, `src/control/*.rs`, `src/commands/*.rs`: window creation, CSP/navigation/tray, D12 client, supervised process and closed Rust IPC commands. |
| Tauri declarations | `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/settings.json,capabilities/secrets.json}`: v2 dependency lock, bundle/CSP settings, command manifest and disjoint labelled authority. |
| Tests/mutations | `apps/desktop/test/**`, `apps/desktop/src-tauri/tests/**`, `test/desktop-*.test.mjs`, `scripts/verify-desktop-mutations.mjs`, and the shared daemon protocol fixture: production-path unit, integration, actual-webview, workflow and destructive-mutation proofs. |
| Build/release/docs | `pnpm-workspace.yaml`, root `package.json`, `pnpm-lock.yaml`, `.github/workflows/desktop*.yml`, `apps/desktop/{README.md,RELEASE_NOTES.md,THIRD_PARTY_LICENSES}`, `docs/RELEASING.md`, and `CHANGELOG.md`: workspace reachability, three-platform CI, unsigned prerelease release boundary and first-launch instructions. |

## Safety ledgers and automatic defect checks

### Write-after-await ledger

The desktop owns no event-database transaction. It nevertheless has mutable Rust preferences and process lifecycle state, which need the same discipline. `apps/desktop/src-tauri/src/supervisor.rs` must expose a `SupervisorEpoch`; `preferences.rs` must use a revisioned, owner-only atomic file and lock. Every row is exercised against production code by the named test and mutation runner.

| Write after await | Fresh condition checked at write/commit | Named production-path test / destructive mutation |
|---|---|---|
| Native daemon-path selection returns, then preference save | Current preference revision and app lifecycle epoch still equal the snapshot; canonicalised path is a regular owner-readable executable named `agent-events`; no caller-supplied argv survives. | `desktop-preferences-race`; remove revision comparison. |
| A daemon child spawn or attach hello returns | Desired supervisor epoch, current child identity, selected protocol version and quit state still match; otherwise stop only that just-spawned child and persist nothing. | `desktop-supervisor-late-spawn`; remove epoch re-check. |
| `stop`/child-exit wait returns | Stored child/process identity and epoch still match before clearing ownership/health; a restarted daemon is not erased. | `desktop-supervisor-stop-race`; clear by PID/any state. |
| A Rust control request returns before UI state is published | Request id, negotiated session generation and current window/lifecycle epoch still match; stale replies cannot repopulate a purged/closed screen. No daemon state is written by C. | `desktop-control-stale-reply`; accept stale result. |
| Authoritative preview fetch/challenge request returns | Approval id and digest must still match the requested action; Rust renders fetched bytes only. The daemon's B3 `approve` operation re-plans/claims atomically; C writes no approval record. | `desktop-approval-authoritative-preview`; render supplied preview or skip digest match. |
| Secret IPC reaches Rust or the B3 reply returns | Window label must still be `secrets`; request nonce and operation kind must be in the dedicated allow-list. Rust clears the value/result if the window closed/blurred meanwhile; no local persistence occurs. | `desktop-secret-close-race`; permit settings label or retain result. |

`apps/desktop/test/mutations/manifest.json` names each test and its source-level mutant. `apps/desktop/test/mutations/run.mjs` applies one mutant at a time to a temporary worktree copy, executes exactly that named test, and requires failure. `scripts/verify-desktop-mutations.mjs` parses the manifest and test markers, rejects a test without a mutation, a mutation without a test, duplicate mutation ids, a test that does not import the production module it names, or a mutant that stays green. Root `pnpm verify` runs this structural checker; the full destructive runner runs in the desktop workflow.

### Identity and scope ledger

- The React layer treats daemon ids as opaque stable ids. It displays aliases/names supplied by B3 but sends the stable `accountId`, `ruleId`, `targetId`, `subscriberId`, `judgeId`, version and digest that B3's typed DTO requires; it never resolves aliases itself.
- Every UI update/remove/retry/hold action carries the selected record's stable id and version, and Rust rejects an id/version result whose returned parent `accountId`/source does not equal the selection. This is a client-side refusal, not a replacement for B3's SQL scope fence.
- C imports source/channel vocabulary from B3 response types. It does not reproduce Slack/WhatsApp event names, visibility vocabulary, account aliases or target-kind lists.
- `desktop-id-scope.test.tsx` invokes the real command adapter with same-looking cross-account records; the `drop-account-scope` and `resolve-alias-again` mutants must fail it. `verify-desktop-mutations` requires both pairs.

### Purge/cancellation and cache ledger

The app owns no daemon purge. Therefore it keeps no durable optimistic/offline mutation queue, never caches decrypted dry-run/secret content to disk, invalidates its in-memory query cache after every destructive B3 response and on a control-session reconnect, and cancels pending UI promises/timers on window close. The daemon remains responsible for rule/target/account/list purges under B1/B2/D fences. `desktop-purge-ui-orphans.test.tsx` drives the real adapter through a disabled/removed response and proves no retry, stale dry-run rendering or secret reveal continues; `leave-action-queued` and `keep-secret-result` mutations fail it.

### Tests that bite

Every app test calls either a compiled Rust command, the real TypeScript adapter/reducer, the actual preview renderer, or a packaged Tauri webview. No test-local authority table, mock-only model, shared default branch or “test mode” bypass may establish the assertion. Test doubles are restricted to the daemon control peer, child process and literal-loopback trap; each records the actual frame/bytes it received. The structural checker above enforces a one-to-one named-test/mutation manifest, and `desktop-production-path.test.mjs` rejects test imports from `test/support` in a case asserting a production command.

## Execution map and safe parallelism

| Batch | Tasks | Dependency / safe parallelism |
|---|---|---|
| 1 — workspace authority | 1 | First: establishes the private app, mutation harness and root verification hooks. No B3 dependency. |
| 2 — isolated UI and release perimeter | 2, 3 | After Task 1, run in separate worktrees. Task 2 owns app runtime/security files; Task 3 owns workflows/release scripts/docs. Neither edits the other's files. No B3 dependency. |
| 3 — local client authority | 4 | After Task 2 (it wires the security bootstrap). It may proceed while B3 is being implemented because it tests protocol v1/status/stop only. |
| 4 — B3 adoption and privileged boundary | 5 → 6 | Begin only after B3 has merged and its D10/exception/parity suite is green. Sequential: Task 5 declares the non-secret operation/approval contract; Task 6 binds the secret-only contract and capability manifest. |
| 5 — phase seams and release audit | 7 | After Tasks 3–6. This is the integrated release gate and E/E2 seam audit. |

Parallel group A is Task 2 (security/tray) and Task 3 (workflow/docs). Parallel group B is B3 implementation in its own worktree while C performs Tasks 1–4; do not cherry-pick an assumed B3 API. Rebase after each merged parallel task, rerun its focused tests and then the batch command. Generated lockfiles and reference artifacts are resolved only in the integration worktree; do not copy them between worktrees.

Every task ends with a **P1-only review** of only its own diff: confirm the named invariant and tests, inspect changed command/capability/plugin declarations, run its mutation cases, and reject any unrelated refactor. No later task may depend on an unreviewed task.

## Batch 1 — workspace authority

### Task 1 — private desktop workspace, typed app shell, and mutation enforcement

**Risk:** medium. It changes root workspace verification but must not make the desktop look publishable or weaken package checks.

**Files:**

- Modify: `pnpm-workspace.yaml`, `package.json`, `pnpm-lock.yaml`, `.gitignore`
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/vite.config.ts`, `apps/desktop/settings.html`, `apps/desktop/secrets.html`, `apps/desktop/src/main.tsx`, `apps/desktop/src/secrets-main.tsx`, `apps/desktop/src/app.tsx`, `apps/desktop/src/types.ts`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/build.rs`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/capabilities/settings.json`, `apps/desktop/src-tauri/capabilities/secrets.json`, `apps/desktop/README.md`
- Create tests: `apps/desktop/test/workspace.test.mjs`, `apps/desktop/test/mutations/manifest.json`, `apps/desktop/test/mutations/run.mjs`, `scripts/verify-desktop-mutations.mjs`, `test/desktop-mutations.test.mjs`

**Interfaces:**

- Produces `@agentcomms/desktop` as a private workspace project; Vite multi-page entries named `settings` and `secrets`; Rust `run()` as the only Tauri bootstrap; no custom command is registered yet.
- Consumes no B3 surface.

- [ ] **Step 1: Write the failing workspace and mutation-structure tests.** Assert `apps/*` is a workspace, desktop is `private: true`, has no `agentcomms`/`agentcommsPackage`, is absent from `scripts/packages.mjs` output, and root `build`, `typecheck` and `test` include the app's Vite/typecheck/unit scripts. Seed the mutation manifest with the Task 1 workspace guard and prove the checker rejects an unpaired entry.
- [ ] **Step 2: Run the focused failures.** Run `node --test apps/desktop/test/workspace.test.mjs test/desktop-mutations.test.mjs`; expect missing app files and a deliberate unpaired-manifest failure.
- [ ] **Step 3: Add the minimal private app skeleton.** Add `apps/*`; use Vite's two explicit HTML inputs, React/CUE++ theme bootstrap and inert `settings`/`secrets` headings. Add Rust/Tauri v2 bootstrap and two empty labelled capability files. Add only frontend TypeScript scripts to root verification; do not add an npm publish script, a channel declaration, Node code in the Tauri bundle, a webview permission, or a network dependency.
- [ ] **Step 4: Add the automatic mutation guard.** Implement the manifest/checker contract described above; make Task 1's mutation remove the `private` assertion and require its named production-path test to fail in a temporary copy.
- [ ] **Step 5: Run focused checks.** Run `pnpm --filter @agentcomms/desktop build`, `pnpm --filter @agentcomms/desktop typecheck`, `pnpm --filter @agentcomms/desktop test`, and `node --test apps/desktop/test/workspace.test.mjs test/desktop-mutations.test.mjs`; all exit zero. Run `node apps/desktop/test/mutations/run.mjs --case desktop-workspace-private`; expect the deliberately altered test to fail.
- [ ] **Step 6: P1-only review and commit.** Review only workspace membership/private status/root script reachability/mutation pairing. Commit `feat(desktop): add private Tauri workspace shell`.

**Required mutation:** remove `"private": true` or remove `apps/*` from `pnpm-workspace.yaml`; `desktop-workspace-private` must fail.

**Batch 1 verification:** run `pnpm verify`; passing means zero failures, desktop TypeScript checks run, and no package/release registry behavior changes.

## Batch 2 — isolated UI and release perimeter

### Task 2 — tray shell, exact no-egress policy, navigation denial, and actual-webview probe

**Risk:** highest. A permissive capability, a missing CSP directive or a handler installed after a window loads turns an app screen into an egress path.

**Files:**

- Modify: `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/app.tsx`, `apps/desktop/src/main.tsx`, `apps/desktop/src/secrets-main.tsx`, `apps/desktop/settings.html`, `apps/desktop/secrets.html`, `apps/desktop/package.json`, `apps/desktop/test/mutations/manifest.json`
- Create: `apps/desktop/src-tauri/src/security.rs`, `apps/desktop/src-tauri/src/tray.rs`, `apps/desktop/src/egress-probe.ts`, `apps/desktop/src-tauri/tests/security_policy.rs`, `apps/desktop/test/csp-navigation.test.mjs`, `apps/desktop/test/e2e/production-probe.mjs`, `apps/desktop/test/e2e/loopback-trap.mjs`

**Interfaces:**

- Produces `install_security_before_windows(app)` and `install_tray(app)`; the former is called before creating either webview and permits only the compiled app origin.
- Produces a test-feature-only bundled probe reporter. It is not registered or compiled in the normal release build.
- Consumes no B3 surface.

- [ ] **Step 1: Write failing static and real-webview tests.** Assert byte-equality of the D13 CSP, `dangerousDisableAssetCspModification: false`, a stricter secrets meta policy, no forbidden plugin/permission, handler installation before `WebviewWindowBuilder`, and labelled capabilities. Write the probe contract that launches a release-mode test-feature bundle plus literal loopback trap and requires both windows' attack matrix to yield zero requests/no navigation/no popup while a benign IPC round trip succeeds.
- [ ] **Step 2: Run focused failures.** Run `node --test apps/desktop/test/csp-navigation.test.mjs` and `pnpm --filter @agentcomms/desktop test:e2e -- --case no-egress`; expect missing policy/handler/probe.
- [ ] **Step 3: Implement the native perimeter first.** Put the exact configured CSP in `tauri.conf.json`; set the secrets HTML meta CSP to the D13 tightening; add no remote asset. In Rust install navigation, new-window, download and external-protocol refusals before creating `settings` or `secrets`. Register no shell, fs, HTTP, opener, clipboard, dialog or window-creation plugin/capability. Create the tray after the policy and make closing `settings` hide rather than quit.
- [ ] **Step 4: Implement the production probe.** Under a Cargo feature usable only by the CI command, compile the same Tauri config/assets into a test probe that executes the complete D13 attack matrix in each actual window and reports only booleans/counts over a private test pipe. The Node harness starts the repository's loopback seal and literal-loopback trap before launching the bundle; it contains synthetic URLs only. It must fail if an attack is skipped, an IPC call fails, a new window is created, or the trap sees one request.
- [ ] **Step 5: Add paired mutations.** Add mutants that (a) remove `connect-src ipc: http://ipc.localhost`, (b) change CSP to `null`, (c) register navigation after the first window, (d) allow a non-app URL, and (e) grant an HTTP/opener permission. Each named static/probe test must fail.
- [ ] **Step 6: Run focused checks.** Run `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`, `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features`, `node --test apps/desktop/test/csp-navigation.test.mjs`, and the platform's `pnpm --filter @agentcomms/desktop test:e2e -- --case no-egress`; all must pass. Run every Task 2 mutation with the mutation runner and observe each named test fail.
- [ ] **Step 7: P1-only review and commit.** Review only the effective CSP intersection, handler ordering, capability/plugin absence, both window labels, and trap journal. Commit `feat(desktop): enforce no-egress webview perimeter`.

**Required mutations:** the five mutations in Step 5, each paired in `manifest.json` with `desktop-production-no-egress` or its exact static guard.

### Task 3 — cross-platform desktop CI, unsigned prerelease workflow, first-launch docs, and signing gate

**Risk:** high. A tag-pattern collision, untested platform, missing hash or accidental signing secret can make an unsafe artifact look released.

**Files:**

- Create: `.github/workflows/desktop.yml`, `.github/workflows/desktop-release.yml`, `apps/desktop/RELEASE_NOTES.md`, `apps/desktop/THIRD_PARTY_LICENSES`
- Modify: `apps/desktop/README.md`, `docs/RELEASING.md`, `CHANGELOG.md`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/test/mutations/manifest.json`
- Create tests: `test/desktop-workflows.test.mjs`, `apps/desktop/test/release-notes.test.mjs`

**Interfaces:**

- Produces `desktop.yml` matrix `{ macos-latest, windows-latest, ubuntu-latest }` and `desktop-release.yml` trigger `desktop-v*` only.
- Produces `apps/desktop/RELEASE_NOTES.md` as the exact prerelease notes source and SHA-256 attachment contract.
- Consumes no B3 surface.

- [ ] **Step 1: Write failing workflow/docs tests.** Parse both YAML files as text/structure and require all three OS gates to run frozen pnpm install, frontend checks, `cargo fmt`, warning-denied clippy, Cargo tests, actual-webview test and unsigned Tauri build. Require the release tag only be `desktop-v*`, root `release.yml` remain `v*`, Linux upload be absent, macOS universal/ad-hoc and Windows x64 NSIS outputs plus SHA-256 exist, and release creation be `--prerelease`/not-latest. Require no `secrets.` expression or signing env/certificate value in the version-1 workflow. Require the exact macOS/Windows instructions and hash comparison in README, release notes and RELEASING.
- [ ] **Step 2: Run focused failures.** Run `node --test test/desktop-workflows.test.mjs apps/desktop/test/release-notes.test.mjs`; expect missing workflows/notes.
- [ ] **Step 3: Implement the normal desktop matrix.** Add path-aware workflow triggers for app/root workflow changes and an explicit all-platform matrix. Install public dependencies with `pnpm install --frozen-lockfile` and no registry token; build/test the frontend, run the requested Cargo commands, execute the bundled trap probe and build an unsigned bundle. Linux installs only documented Tauri system packages and publishes nothing.
- [ ] **Step 4: Implement prerelease-only release.** Validate `desktop-v${desktop package version}` and immutable tag commit; rerun the same matrix; build universal macOS with `signingIdentity: "-"` and unsigned Windows x64 NSIS; download artifacts into one release job, write deterministic SHA-256 lines, assert release notes contain both launch sections, and create/update only a GitHub prerelease. Use `github.token`/repository permissions only; do not introduce a stored signing secret. The workflow must reject any input or branch which requests latest/non-prerelease publication.
- [ ] **Step 5: Add docs and package artefact hygiene.** Document the separate daemon prerequisite from C-B, checksum comparison, macOS Open Anyway and Windows More info/Run anyway/Smart App Control limitations. State no in-app updater, no Linux version-1 artifact and the Developer ID/notarisation/Windows-code-signing condition for a wider release. Generate the desktop third-party notices from its locked dependencies; do not touch npm package release holds.
- [ ] **Step 6: Add paired mutations.** Mutate the trigger to `v*`, remove one OS, remove `--prerelease`, add a signing-secret reference, omit an artifact hash, omit one launch instruction, and add a Linux upload. Each must fail its named workflow/docs test.
- [ ] **Step 7: Run focused checks.** Run `node --test test/desktop-workflows.test.mjs apps/desktop/test/release-notes.test.mjs` and the Task 3 mutation cases; all normal tests pass and every mutation fails. Validate YAML with the repository's parser/test rather than an online service.
- [ ] **Step 8: P1-only review and commit.** Review only tag isolation, forced prerelease, artifact/hash flow, absence of signing credentials, matrix completeness and user-facing instructions. Commit `ci(desktop): add unsigned prerelease release gates`.

**Required mutations:** `desktop-tag-isolation`, `desktop-matrix-completeness`, `desktop-prerelease-only`, `desktop-no-signing-secret`, `desktop-hash-asset`, `desktop-launch-docs`, and `desktop-no-linux-upload`.

**Batch 2 verification:** after both worktrees are integrated, run `pnpm verify`; passing means root checks, workflow/docs tests and desktop TypeScript checks are all green. On each native CI OS, `desktop.yml` additionally proves the Cargo/bundle/webview commands from Task 3.

## Batch 3 — local client authority

### Task 4 — Rust D12 client, safe daemon supervision, and protocol compatibility

**Risk:** highest. A token leak, wrong frame encoding, unsupported-version fallback, or late child could make the app control the wrong owner or leave collection running after quit.

**Files:**

- Modify: `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/tray.rs`, `apps/desktop/src/app.tsx`, `apps/desktop/package.json`, `apps/desktop/test/mutations/manifest.json`
- Create: `apps/desktop/src-tauri/src/control/mod.rs`, `apps/desktop/src-tauri/src/control/frame.rs`, `apps/desktop/src-tauri/src/control/client.rs`, `apps/desktop/src-tauri/src/control/types.rs`, `apps/desktop/src-tauri/src/preferences.rs`, `apps/desktop/src-tauri/src/supervisor.rs`, `apps/desktop/src-tauri/src/commands/supervision.rs`, `apps/desktop/src-tauri/src/bin/control-probe.rs`, `packages/events-daemon/test/fixtures/control-protocol-v1.json`
- Modify tests: `packages/events-daemon/test/protocol-compat.test.ts`
- Create tests: `apps/desktop/src-tauri/tests/control_frames.rs`, `apps/desktop/src-tauri/tests/supervisor.rs`, `apps/desktop/test/control-compat.test.mjs`, `apps/desktop/test/supervisor.test.mjs`

**Interfaces:**

- Produces `DesktopControlClient::request(NonSecretControlRequest)` and `DesktopSupervisor::{attach,start,quit,status}`. Protocol support is `const SUPPORTED: [u32; 1] = [1]`.
- Produces the sole pre-B3 command surface: `desktop_supervision_status`, `desktop_start_daemon`, `desktop_quit_daemon`, and `desktop_open_secrets` (which only opens a still-inert separate window).
- Consumes current D12 `status`, `stop` and `doctor` only; it does not require B3.

- [ ] **Step 1: Write failing shared-frame and supervisor race tests.** Add a data-only protocol fixture containing valid hello/request/success/failure/oversize/malformed/no-overlap frames. Extend the existing TypeScript protocol test to consume it. Write Rust tests for byte-exact frame encode/decode, highest mutual version, rejection of malformed/oversize/session responses, and no token in a public error. Write Node integration that starts the real `startControlServer`/owner under the loopback seal and invokes the compiled Rust `control-probe` over the Unix socket. Write race tests that pause spawn/hello/stop operations and exercise the ledger rows.
- [ ] **Step 2: Run focused failures.** Run `node --import ./test/helpers/loopback-seal-preload.mjs --experimental-strip-types --test packages/events-daemon/test/protocol-compat.test.ts apps/desktop/test/control-compat.test.mjs`, then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test control_frames --test supervisor`; expect absent fixture/client/supervisor failures.
- [ ] **Step 3: Implement the client without widening authority.** Mirror D12's 4-byte big-endian bounded JSON frames and hello/request/reply shapes. On Unix re-prove the socket path/owner/mode before reading/sending the token; use the current owner-only state directory and no TCP. On Windows compile a typed `WINDOWS_CONTROL_UNAVAILABLE` path before token access, preserving B1-G. Do not serialise token/session into any `serde::Serialize` UI type.
- [ ] **Step 4: Implement supervision and preferences.** Store only canonical executable path, keep-after-quit flag, preference revision and non-secret child diagnostic identity in an owner-only atomic preference file. Never persist the token/session. Start with fixed argv/no shell; attach before spawning; wait boundedly for authenticated protocol v1; use the epoch checks in the ledger; route tray Quit through D12 stop/detach semantics. `settings` closing only hides it.
- [ ] **Step 5: Prove actual compatibility.** The Unix integration must use the real Node v1 server, not a Rust-only fake; prove status/doctor success and typed `PROTOCOL_UNSUPPORTED` on disjoint versions. The Windows CI case proves refusal occurs before a token-file read. The test must start no source/provider and uses a temporary state directory.
- [ ] **Step 6: Add paired mutations.** Remove length prefix validation, accept no-overlap, expose a token in an error, remove Unix endpoint proof, remove each supervisor epoch/revision check, and clear ownership without exact process identity. Each mutation must fail its named test.
- [ ] **Step 7: Run focused checks.** Run the commands in Step 2, `pnpm --filter @agentcomms/desktop test -- --test-name-pattern='control|supervisor'`, and all Task 4 mutation cases. Every normal test passes and every mutant fails.
- [ ] **Step 8: P1-only review and commit.** Review frame bounds, no token serialization, Unix endpoint proof, Windows fail-closed behavior, no shell spawn, every await ledger row, and child quit/detach behavior. Commit `feat(desktop): add authenticated daemon supervision`.

**Required mutations:** `desktop-frame-bounds`, `desktop-no-overlap`, `desktop-token-redaction`, `desktop-endpoint-proof`, `desktop-preferences-race`, `desktop-supervisor-late-spawn`, `desktop-supervisor-stop-race`, `desktop-control-stale-reply`.

**Batch 3 verification:** run `pnpm verify`; passing means the shared TypeScript protocol fixture remains green and no daemon behavior/hold changed. Native CI additionally runs Cargo fmt/clippy/test and the Unix real-server probe where available.

## Batch 4 — B3 adoption and privileged boundary

### Task 5 — typed non-secret B3 adapter, authoritative approvals, and app screens with E/E2 seams

**Risk:** high. A generic operation path could invoke a human-only secret operation, and a hostile renderer could forge an approval preview.

**Prerequisite:** B3 has merged its complete D10 operation set, human-only exception rows, event-secret migration and lineage/pending-completion doctor surface. Confirm with B3's `pnpm verify`, `pnpm verify:parity --strict`, and its secret-operation mutation tests before editing C.

**Files:**

- Modify: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/control/types.rs`, `apps/desktop/src/app.tsx`, `apps/desktop/src/main.tsx`, `apps/desktop/src/types.ts`, `apps/desktop/src-tauri/capabilities/settings.json`, `apps/desktop/test/mutations/manifest.json`
- Create: `apps/desktop/src-tauri/src/commands/control.rs`, `apps/desktop/src-tauri/src/commands/approval.rs`, `apps/desktop/src-tauri/src/preview.rs`, `apps/desktop/src/control-contract.ts`, `apps/desktop/src/screens/overview.tsx`, `apps/desktop/src/screens/sources.tsx`, `apps/desktop/src/screens/rules.tsx`, `apps/desktop/src/screens/targets.tsx`, `apps/desktop/src/screens/deliveries.tsx`, `apps/desktop/src/screens/judges.tsx`, `apps/desktop/src/screens/approvals.tsx`, `apps/desktop/src/screens/settings.tsx`, `apps/desktop/src/screens/phase-seams.ts`, `test/fixtures/disclosure-preview/desktop-hostile.json`, `test/fixtures/disclosure-preview/desktop-normal.json`
- Create tests: `apps/desktop/src-tauri/tests/preview.rs`, `apps/desktop/test/control-contract.test.ts`, `apps/desktop/test/approval-renderer.test.tsx`, `apps/desktop/test/id-scope.test.tsx`, `apps/desktop/test/purge-ui-orphans.test.tsx`

**Interfaces:**

- Produces exhaustive `NonSecretOperation` enum covering every non-secret/app-permitted B3 operation listed in C-8, plus `desktop_control` and `desktop_approve` commands.
- Produces `render_disclosure_preview(preview) -> Vec<u8>` and identical TypeScript `renderDisclosurePreview(preview) -> Uint8Array` fixture contract.
- Does not expose any D2 secret operation through `desktop_control`.

- [ ] **Step 1: Write failing operation-boundary, renderer and screen tests.** Generate a manifest from B3's D10/capabilities rows and assert every C-8 non-secret operation maps once, `run` maps never, and every D2 secret name is rejected by the generic enum. Test each overview/source/rules/targets/deliveries/judges/settings screen against typed control replies, including empty E/E2 state/progress. Feed fake preview fields containing tags, bidi/control/zero-width, OSC/CSI, fake headers, links and forged envelopes; compare Rust/TypeScript exact UTF-8 bytes. Ensure a webview-provided preview is never rendered.
- [ ] **Step 2: Run focused failures.** Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test preview`, `pnpm --filter @agentcomms/desktop test -- --test-name-pattern='control-contract|approval-renderer|id-scope|purge-ui'`; expect missing enum/screens/renderer.
- [ ] **Step 3: Implement a closed adapter and screens.** Import B3 request/result DTOs rather than decoding guessed JSON. Map every table entry in C-8 to a closed non-secret enum and Rust control request. Render stable ids/version/digest and B3's source/health/lineage fields; never recompute channel vocabulary or present an alias as authority. Implement no judge/hold/model behavior: wire existing B3 result shapes to the E/E2 seam states from C-8.
- [ ] **Step 4: Implement authoritative approval.** Accept only id/digest/typed answer from the webview; fetch the daemon preview by id/digest, reject drift/missing challenge, render fetched structured fields as text-only Rust bytes, show the issued challenge, and call the B3 approval operation. Prevent HTML insertion and clickable links in both renderers. Do not call core directly.
- [ ] **Step 5: Implement cancellation/cache rules.** On B3 disable/remove/drop/held-decision/dry-run result or session reconnect, invalidate the matching in-memory rows and cancel stale promises. Use account/source stable ids for every selection and reject cross-scope response associations before painting.
- [ ] **Step 6: Add paired mutations.** Allow a D2 operation through generic control; render `previewFromWebview`; remove a control-character neutralisation; make a link clickable; remove id/version/account/source association; retain a disabled row/reveal promise. Each must fail its uniquely named production adapter/renderer/screen test.
- [ ] **Step 7: Run focused checks.** Run the commands in Step 2, `node apps/desktop/test/mutations/run.mjs --group task-5`, and `pnpm verify:reference` (C must not alter generated daemon references); normal tests pass and every mutation fails.
- [ ] **Step 8: P1-only review and commit.** Review enum exhaustiveness against B3 capability rows, no secret strings in generic dispatch, fixture byte equality, renderer injection resistance, scope association and no offline queue. Commit `feat(desktop): add typed control and approval screens`.

**Required mutations:** `desktop-no-secret-generic-dispatch`, `desktop-approval-authoritative-preview`, `desktop-preview-controls`, `desktop-preview-links`, `desktop-id-scope`, `desktop-purge-ui-orphans`.

### Task 6 — privileged secret window, complete D2 operation bridge, and per-window command proof

**Risk:** highest. This is the sole webview path that carries secret bytes.

**Files:**

- Modify: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/security.rs`, `apps/desktop/src-tauri/src/control/types.rs`, `apps/desktop/src-tauri/capabilities/settings.json`, `apps/desktop/src-tauri/capabilities/secrets.json`, `apps/desktop/secrets.html`, `apps/desktop/src/secrets-main.tsx`, `apps/desktop/package.json`, `apps/desktop/test/mutations/manifest.json`
- Create: `apps/desktop/src-tauri/src/commands/secrets.rs`, `apps/desktop/src/secrets-app.tsx`, `apps/desktop/src/secret-form-state.ts`, `apps/desktop/src-tauri/tests/secret_boundary.rs`, `apps/desktop/test/secret-window.test.tsx`, `apps/desktop/test/secret-trace.test.mjs`, `apps/desktop/test/e2e/capability-probe.mjs`

**Interfaces:**

- Produces exactly eight Rust command families corresponding one-for-one to the D2 list in C-8; each is registered in `AppManifest::commands` and granted only to label `secrets`.
- Produces B3's typed secret result variants: acknowledgement, one `RevealOnce { material }`, `UrlFingerprint { scheme, host, port, sha256 }`, and B3's non-secret migration-status result. `material` is serialised only on the one secrets response.

- [ ] **Step 1: Write failing capability, byte-trace and close-race tests.** Inspect generated command manifest/capability JSON and invoke every command by raw name from `settings`, `secrets` and a synthetic third label. Require only `secrets` succeeds and only for the matching D2 operation. Place a unique synthetic sentinel in each hidden entry/generated response and scan Tauri IPC logs/test traces, all control replies to non-secret surfaces, preferences, audit capture, SQLite/WAL fixture scans and frontend state snapshots; allow exactly one secrets request/one reveal result pair. Exercise submit/close/blur/navigation failure races.
- [ ] **Step 2: Run focused failures.** Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test secret_boundary`, `pnpm --filter @agentcomms/desktop test -- --test-name-pattern='secret-window|secret-trace'`, and `pnpm --filter @agentcomms/desktop test:e2e -- --case capabilities`; expect no secret commands/boundary implementation.
- [ ] **Step 3: Implement the complete closed secret set.** Register and map target signing create/rotate, secret URL set, subscriber token create/rotate, judge key set/rotate and backend migration directly to B3. Enforce create-versus-rotate preconditions only through B3 results; do not invent slot state. Make hidden fields non-argv/non-URL/non-clipboard inputs. Use short-lived zeroizing Rust values, do not log errors containing values, and return only D2's permitted one-time/fingerprint/nonsecret result.
- [ ] **Step 4: Install non-overlapping capabilities.** Remove every secret/general/approval command from `settings`; give `secrets` no generic control, approval, filesystem, shell, dialog, clipboard, HTTP, opener or window creation capability. Declare all custom commands via `AppManifest::commands`; capability access is label-specific even for a raw invoke name.
- [ ] **Step 5: Finish lifecycle clearing.** Clear JavaScript state on submit, close, blur and navigation failure; close/clear Rust pending result on every secrets-window lifecycle event; do not rehydrate secret input/reveal state. Maintain the stricter secrets CSP from Task 2.
- [ ] **Step 6: Add paired mutations.** Grant one secret command to `settings`, omit the app command manifest, route a secret through generic control, leave a sentinel in state/log, echo URL/key input, or retain reveal after close. Every case must fail the named direct-invocation/trace/race test.
- [ ] **Step 7: Run focused checks.** Run the Step 2 commands and `node apps/desktop/test/mutations/run.mjs --group task-6`; all normal cases pass and each mutation fails. The production-webview capability probe must run on every CI OS.
- [ ] **Step 8: P1-only review and commit.** Review the exact D2 operation inventory, generation/reveal response handling, absence from generic command/capability, command-manifest labels, sentinel trace, clear-on-close path and audit redaction. Commit `feat(desktop): isolate human-only secret operations`.

**Required mutations:** `desktop-secret-capability`, `desktop-secret-app-manifest`, `desktop-no-secret-generic-dispatch`, `desktop-secret-trace`, `desktop-secret-no-echo`, `desktop-secret-close-race`.

**Batch 4 verification:** run `pnpm verify`, `pnpm verify:parity --strict`, and the B3 secret-operation focused tests. Passing means C consumes, but does not change, each B3 operation/exception; no non-secrets window can invoke or observe a secret command.

## Batch 5 — phase seams and release audit

### Task 7 — full cross-platform gate, E/E2 seam audit, release-hold audit, and hand-off

**Risk:** high. Integration is where a screen can quietly bypass a capability or a release workflow can ship a bundle that omitted its safety contract.

**Files:**

- Modify: `apps/desktop/README.md`, `apps/desktop/RELEASE_NOTES.md`, `docs/RELEASING.md`, `CHANGELOG.md`, `.github/workflows/desktop.yml`, `.github/workflows/desktop-release.yml`, `apps/desktop/test/mutations/manifest.json`
- Create: `apps/desktop/test/full-flow.test.mjs`, `apps/desktop/test/e2e/full-production-probe.mjs`, `apps/desktop/test/e2e/fixtures/daemon-control-peer.mjs`, `apps/desktop/test/e2e/fixtures/no-egress-sentinel.mjs`, `test/desktop-release-hold.test.mjs`

**Interfaces:**

- Produces the documented E/E2 UI DTO seam and final CI/release evidence; it introduces no future phase operation.
- Confirms `@agentcomms/events` and `@agentcomms/events-daemon` remain held and desktop remains non-npm-published.

- [ ] **Step 1: Write failing full-flow and release-hold tests.** Drive the packaged app through the real Rust command paths against a local scripted D12 peer/B3 stand-in that validates received operation frames, not a test-local state model. Cover protocol negotiation; tray hide/quit/keep; no-egress attacks from both windows; approval hostile fixture; all B3 non-secret operation mappings; all D2 secret denials/allowed pair; unavailable E/E2 states and progress transitions; stale/purge cancellation; tag/release notes/hash assertions; and no Node/Laya artifacts in built app. Assert event packages' holds and `scripts/packages.mjs` remain unchanged.
- [ ] **Step 2: Run focused failures.** Run `pnpm --filter @agentcomms/desktop test -- --test-name-pattern='full-flow'`, `node --test test/desktop-release-hold.test.mjs`, and `pnpm --filter @agentcomms/desktop test:e2e -- --case full-production`; expect missing end-to-end gate/evidence.
- [ ] **Step 3: Implement the integrated gate.** Reuse production adapter/renderer/capability modules and sealed fake peer; do not add a parallel UI model. Add test-only peer journals that prove every actual control frame excludes token/secret data from the wrong surface and every external request attempt reaches zero on the trap. Scan release bundles for Node/ONNX/Laya filenames and held-package release list changes.
- [ ] **Step 4: Make the workflow run the whole evidence set.** Add the full probe/mutation runner to each OS desktop workflow leg, archive only synthetic test journals/artifact hashes on failure, and have the release workflow run exactly the same matrix before packaging. Keep release notes/manual first-launch text synchronized by test, not duplication by trust.
- [ ] **Step 5: Add final paired mutations.** Make one full-flow case use its support fake directly rather than the adapter, remove an E2 unavailable reason, add a Node/Laya artifact fixture to the bundle scan, lift a daemon hold, or skip a named mutation case. Each must fail its own integration/hold test.
- [ ] **Step 6: Run final focused and full checks.** Run `pnpm --filter @agentcomms/desktop test`, `node apps/desktop/test/mutations/run.mjs --all`, `node --test test/desktop-workflows.test.mjs test/desktop-release-hold.test.mjs`, then `pnpm verify`. In CI, require the full `desktop.yml` matrix to pass macOS, Windows and Linux; the release workflow remains unrun until a `desktop-v*` tag.
- [ ] **Step 7: P1-only review and commit.** Review only integrated boundaries: B3 frame mapping, secret trace, egress journal, platform result, bundle scan, holds and forced prerelease. Commit `test(desktop): gate packaged app and release boundary`.

**Required mutations:** `desktop-production-path`, `desktop-e2-seam-reason`, `desktop-bundle-no-node-laya`, `desktop-release-hold`, `desktop-mutation-completeness`.

**Batch 5 verification:** run `pnpm verify`; passing means all root checks are green. CI evidence additionally requires the three-platform desktop workflow (fmt, clippy, Cargo test, unsigned build, actual bundled egress/capability probe) and all destructive mutations to be red in their isolated runs.

## §5 coverage ownership

| §5 row / C-owned assertion | Sole task owner |
|---|---|
| Control protocol negotiation/authentication/error shape and desktop protocol compatibility; no token on unsupported Windows | Task 4 |
| Hostile preview fixtures, exact TypeScript/Rust text rendering, fake-webview preview/digest/challenge rejection | Task 5 |
| Per-window commands, every non-`secrets` secret-command denial, and one allowed secret IPC argument/result pair only | Task 6 |
| Built production app from every window blocks fetch/XHR/WebSocket/EventSource/beacon/passive image/CSS/form/navigation/script/frame/new-window egress while IPC works | Task 2 |
| Desktop workflow runs fmt, warning-denied clippy, Cargo test and unsigned build on macOS/Windows/Linux, public CUE++ install with no token | Task 3 |
| `desktop-v*` only, distinct from npm `v*`; forced prerelease; ad-hoc macOS + unsigned Windows assets/SHA-256; no signing secret; required first-launch text; no Linux release artifact | Task 3 |
| Built bundle lacks ONNX Runtime, Laya worker/model and Node; event daemon/library holds stay in place | Task 7 |
| B3's human-only secret operations/dryrun/target-resume/held-decision are consumed only through their allowed desktop boundary; no MCP surface is added by C | Task 6 |
| E hold-resolution/Judges and E2 enablement/progress display seams compile and present daemon-provided unavailable/progress state without future implementation | Task 5 |
| Structural test/mutation pairing, production-path enforcement, scope and orphaned-UI cancellation checks | Task 1 (checker), Tasks 4–7 (their listed cases) |

## Spec traceability

Every line below is normative for C. A semicolon-separated line range means the linked requirements are implemented together by one task and named test; no design decision is left without an implementation row.

| Spec section and line(s) | Requirement implemented | Task | Named proof |
|---|---|---:|---|
| D1 128-138 | Desktop presents/control surface only; no I/O/rule implementation | 1, 5 | `desktop-workspace-private`, `desktop-production-path` |
| D2 146-156, 187-205 | App may approve disclosure only through app challenge, never MCP/chat/core direct | 5 | `desktop-approval-authoritative-preview` |
| D2 471-495 | Closed human-only secret set, TTY/app boundary, reveal-once/no audit bytes | 6 | `desktop-secret-window`, `desktop-secret-trace` |
| D10 2002-2017 | B3 operations use one daemon operation; complete operation inventory | 5, 6 | `desktop-control-contract`, `desktop-secret-operation-inventory` |
| D10 2029-2033 | Retained rule test is terminal/app-only and safely rendered | 5 | `desktop-retained-test-boundary` |
| D10 2049-2060 | No MCP secret/dryrun/resume/migration exposure; exceptions remain explicit | 5, 6 | `desktop-no-secret-generic-dispatch`, `desktop-capability-manifest` |
| D10 2066-2069 | App approval re-plans/rechecks through daemon operation | 5 | `desktop-approval-authoritative-preview` |
| D10 2071-2086 | Judge enable/disable/model and doctor state surface to app | 5 | `desktop-judge-seams` |
| D11 2100-2110, 2321-2329 | Judges off/daemon-owned; app shows only status and contains no Laya/Node artifacts | 5, 7 | `desktop-judge-seams`, `desktop-bundle-no-node-laya` |
| D12 2352-2367 | Rust is authenticated versioned local protocol client; frame/error compatibility | 4 | `desktop-control-real-server-compat`, `desktop-frame-bounds` |
| D12 2369-2372 | App uses instance ownership/stale status without replacing daemon recovery | 4 | `desktop-supervisor-attach` |
| D12 2374-2376 | Settings close/tray/quit/keep-collecting lifecycle | 2, 4 | `desktop-tray-lifecycle`, `desktop-supervisor-late-spawn` |
| D13 2583-2587 | Tauri v2/React/Vite/CUE++, tray, separate labelled windows, repository workspace | 1, 2 | `desktop-workspace-private`, `desktop-window-labels` |
| D13 2589-2616 | Overview through Settings screen inventory, secret handoff, Judges/holds seams | 5, 6 | `desktop-screen-contract`, `desktop-judge-seams` |
| D13 2618-2627 | Authoritative preview, text-only renderer, fixture byte identity, typed challenge/app approval | 5 | `desktop-approval-authoritative-preview`, `desktop-preview-byte-vectors` |
| D13 2629-2643 | Exact production CSP, asset modification, secrets meta policy | 2 | `desktop-csp-exact`, `desktop-production-no-egress` |
| D13 2645-2648 | Pre-load navigation/new-window/download/custom-protocol denial; Rust-only control | 2, 4 | `desktop-navigation-denial`, `desktop-production-no-egress` |
| D13 2650-2656 | Window-labelled, non-overlapping secret capability and AppManifest command declarations | 6 | `desktop-capability-manifest`, `desktop-capability-raw-invoke` |
| D13 2658-2665 | Only secret IPC pair; clear lifecycle; no logs/cache/telemetry/audit bytes | 6 | `desktop-secret-trace`, `desktop-secret-close-race` |
| D13 2667-2673 | Hostile preview and actual cross-platform built-webview attack matrix | 2, 5, 6 | `desktop-production-no-egress`, `desktop-approval-authoritative-preview`, `desktop-capability-raw-invoke` |
| D14 2677-2687, 2756-2763 | `apps/desktop` layout, workspace/build, independent version, root/CI checks all platforms | 1, 3 | `desktop-workspace-private`, `desktop-workflow-matrix` |
| D14 2765-2772 | Separate `desktop-v*`, prerelease, ad-hoc macOS, unsigned Windows, no updater/Linux artifact | 3 | `desktop-prerelease-workflow` |
| D14 2774-2782 | SHA-256 and macOS/Windows first-launch instructions | 3 | `desktop-release-notes` |
| D14 2784-2788 | Signing/notarisation/code-signing wider-release gate | 3 | `desktop-prerelease-only`, `desktop-no-signing-secret` |
| §4 2825-2829 | C depends on B3; C provides E/E2 UI seams; C deliverable list | 4, 5, 6, 7 | `desktop-control-contract`, `desktop-judge-seams`, `desktop-full-flow` |
| §5 3308-3325 | Control/storage/app, production egress, capabilities, three-platform CI/release and no Laya bundle | 2–7 | §5 ownership tests above |
| §7 3372-3379 | High-value approval surface and unsigned-build risk controls | 3, 5, 6 | `desktop-approval-authoritative-preview`, `desktop-prerelease-workflow`, `desktop-secret-trace` |
| §8 3402-3408 | Repository location and unsigned version-1 owner decision | 1, 3 | `desktop-workspace-private`, `desktop-prerelease-workflow` |

## Review process and hand-off

After each task's P1-only review, run its focused test/mutation set before the next dependency begins. Do not repeat Phase D's serial twelve-round pattern at the end: the final review is one parallel round, on the integrated head, with one reviewer per area:

| Parallel reviewer | Covers |
|---|---|
| Rust/control reviewer | Frame parser, endpoint/token handling, protocol compatibility, supervisor epochs, child quit/detach, Windows refusal |
| Tauri security reviewer | CSP bytes/effective intersection, handler installation order, plugins, manifest/capability disjointness, raw command invocation, actual-webview trap journal |
| Approval/secret reviewer | B3 operation mapping, authoritative preview/challenge, text renderer fixtures, reveal-once/Zeroizing/trace/audit redaction, close/blur races |
| UI/state reviewer | Stable id/account/source associations, no re-derived channel vocabulary, cache/orphan cancellation, all D13 screens and E/E2 seams |
| Release/CI reviewer | Workspace/private/package holds, all three CI legs, unsigned tag isolation, assets/hashes/notes, signing gate, no Node/Laya bundle |
| Test-integrity reviewer | Every named test exercises production code, fixture/loopback seal use, one-to-one mutation manifest, each mutant actually red |

The phase cannot be handed off until every reviewer reports no P1, `pnpm verify` is green, all desktop matrix legs are green, and all mutation cases are demonstrably red under their individual test. Any reviewer finding a new recurring defect class adds an automatic test/mutation pair before approval; it is not left as reviewer memory.

### Pull-request payload and release status

The Phase C PR proposes version **`0.16.0-events-c`** (a minor change from root `0.15.2`: it adds an optional desktop product without breaking npm consumers). Its description carries:

1. what a person can do with the desktop app and how the daemon/secret boundary works;
2. the proposed semver and reason above;
3. focused tests, three-platform workflow evidence, `pnpm verify`, and each intentionally broken mutation;
4. README, release notes, RELEASING, reference/skills impact (no daemon CLI/MCP surface is added by C), and `CHANGELOG.md` under `Unreleased` describing the unsigned desktop prerelease;
5. provenance: this design/spec and Tauri/CUE++ primary sources recorded in it (read 2026-10-10; source checks dated 2026-10-05/06), no live-provider testing, and AI assistance used for the plan/implementation as applicable; and
6. confirmation that all fixtures/traps are synthetic and no real data, address, token or client secret appears.

The daemon and events-library holds remain. A `desktop-v*` prerelease does not lift them; when the owner elects to release the first daemon consumer, the existing normal release process lifts/publishes them in dependency order as `docs/RELEASING.md` requires.

**Implementation commit sequence:**

1. `feat(desktop): add private Tauri workspace shell`
2. `feat(desktop): enforce no-egress webview perimeter`
3. `ci(desktop): add unsigned prerelease release gates`
4. `feat(desktop): add authenticated daemon supervision`
5. `feat(desktop): add typed control and approval screens`
6. `feat(desktop): isolate human-only secret operations`
7. `test(desktop): gate packaged app and release boundary`

**Plan commit message:** `docs(plan): local event emission — phase C`
