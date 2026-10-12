# Local event emission — Phase C desktop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the version-1 local desktop control surface in `apps/desktop`: a Tauri v2 app that safely supervises and controls the local events daemon, isolates secret entry in a separate window, and is released only as an unsigned `desktop-v*` prerelease.

**Architecture:** The React UI is a presentation client. Rust owns every local control connection, daemon token, child process, native window, navigation decision, approval rendering, untrusted-result rendering and secret hand-off; it exposes a typed, non-secret command allow-list to `settings` and a disjoint, complete D2 secret-operation allow-list to `secrets`. The app neither reads providers nor opens the event database, and it retains no offline mutation queue: B3's daemon operations remain the single authority.

**Tech Stack:** Tauri **v2** (the spec's versioned framework choice), Rust stable, React 19, Vite, TypeScript, `@cueplusplus/ui` 0.20.1, `@cueplusplus/tokens` 0.20.1, `@cueplusplus/theme-cue` 1.1.1, `@cueplusplus/theme-base` 1.3.0, Node 22.18+, pnpm 11, `node:test`, Rust `cargo test`, and an actual bundled Tauri-webview probe on macOS, Windows and Linux.

This plan starts from `feat/events-c` at `556feb64` (the converged B2 + Phase D tree). It plans against B3's specified API, but B3 is not present yet. It does not amend B3, add a daemon operation, send to a provider, or make a network request in a test.

## Global constraints

- Read and preserve the local-event design, the CLI/MCP parity design and the channel-plugin design. `agentcomms` remains a channel declaration; the desktop is a private workspace app, not a channel or a published package.
- `apps/desktop` is a pnpm workspace member but is independently versioned. `pnpm verify` must run its TypeScript typecheck, unit tests and TypeScript preview-vector test; Cargo and bundle checks run in the desktop workflow on macOS, Windows and Linux.
- Use Tauri v2 only. The exact patch is lockfile-pinned in both `apps/desktop/src-tauri/Cargo.lock` and `pnpm-lock.yaml`; `Cargo.toml` and `package.json` may name the supported v2 major but may not mix Tauri v1 APIs or a non-v2 plugin. The spec names v2 but no patch floor, so the lockfiles, not an invented patch number, are the reproducibility source of truth.
- Production CSP is byte-for-byte D13's value. `dangerousDisableAssetCspModification` remains `false`; the `secrets` document adds its stricter meta CSP.
- B3's checked-in, language-neutral, versioned desktop-control wire contract is a hard prerequisite for Tasks 5–7. Rust types are generated from or validated against it; no C task may hand-decode, infer or fall back from an unknown result shape.
- No frontend has shell, filesystem, HTTP/opener, clipboard, dialog, external-protocol, download, or window-creation permission. Rust alone opens local-control sessions and starts/stops a daemon child.
- `secrets` is a separately labelled Tauri window and entry document, never a React route. Its capability is non-overlapping and exposes only the D2 secret commands.
- A secret byte is accepted only by the `secrets` IPC argument or returned only by its one reveal-once response. It never reaches `settings`, a generic command, logs, telemetry, audit, state JSON, SQLite, a trace, or a test fixture.
- All test accounts, secrets, URLs, messages and tokens are synthetic. Node tests use the existing loopback seal before an import that could reach a transport; webview probes use a loopback trap and require zero requests. No test calls Gmail, Slack, Resend, WhatsApp, a registry, or a signing service.
- The desktop bundle contains no Node runtime/code, daemon database, ONNX Runtime, Laya worker or model. A release gate checks the packaged content manifest and resolved build/dependency graph, not only filenames. The app does not download any of them.
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

Implement the D12 length-prefixed JSON client in Rust, supporting exactly protocol version 1. On Unix it reads the owner-only instance/token records for the selected profile, validates the endpoint before sending a token, sends `hello`, records the selected protocol version in memory, and maps only the documented reply envelope to typed UI errors. On Windows it returns `WINDOWS_CONTROL_UNAVAILABLE` **before opening any profile state/config directory, instance record or token file**. It never returns token/session/instance bytes to TypeScript. Wire fixtures exercise the same valid/invalid frames as `packages/events-daemon/src/control/protocol.ts`, and an integration probe connects the Rust client to the real Node control server on Unix. A no-overlap reply blocks all mutation screens with `PROTOCOL_UNSUPPORTED`; it never guesses a newer protocol.

Rust persists one owner-only, atomically recoverable `DaemonProfile { executable, stateDir, configDir }`: all three paths are canonical absolute paths, and the executable is a regular owner-readable `agent-events` file. Attach reads instance/token state only below that exact profile; spawn uses only that exact executable, state directory and config directory with the B3-agreed fixed `run` argv, no shell, PATH search, discovery, substituted path or caller-supplied arguments. An explicit person action may start it after attach proves it absent; no other event may. The profile file rejects symlink/reparse paths, verifies private ownership/mode after create and rename, and recovers only a complete last-good atomic record.

Closing `settings` hides it and keeps the tray and daemon. Quitting the tray sends D12 `stop` unless **keep collecting after quit** is enabled, regardless of whether the app attached or spawned the daemon; when enabled, Rust detaches it and subsequent management belongs to the CLI. The opt-in **open at login** setting is off by default and starts only the desktop tray app; startup never attaches or spawns a daemon until a new explicit person action. All paths re-check their supervisor generation after an await, so a late spawn cannot survive a concurrent quit.

Reason: D12 calls the Rust app a protocol client (2352-2367) and defines tray lifetime (2374-2376); protocol v1 is currently `[1]` in `packages/events-daemon/src/control/protocol.ts`. The daemon is the authority, so a Rust SQLite binding, a second control server, direct core calls, or a frontend `invoke` that accepts an arbitrary operation would create a second privileged implementation.

Reasonable alternatives rejected: TCP loopback would weaken the established owner-only socket boundary; reimplementing operations in Rust would violate D1; daemon advertising a Windows refusal would read untrusted state too late; PATH discovery or a silent installer/start would select an uncontrolled daemon; auto-starting a daemon silently would create durable background work without a person action; spawning through a shell or arbitrary arguments would add command-injection surface.

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

Set it in `tauri.conf.json`, retain `dangerousDisableAssetCspModification: false`, and emit it for `secrets` together with this exact tightening meta policy in `secrets.html`:

```text
default-src 'none'; script-src 'self'; style-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'
```

The test asserts the complete directive/value set of both policies and their intersection, rather than treating “stricter” as sufficient. Before either window loads, Rust installs navigation and new-window callbacks that allow only the compiled app origin and deny remote/custom protocol URLs, downloads and new windows. Bundled UI uses no remote fonts/assets, opener, HTTP, WebSocket or shell/file plugin.

The cross-platform test builds the app in release mode with a test-only probe feature, launches the actual bundled webviews and a sealed literal-loopback trap, and attempts `fetch`, XHR, WebSocket, EventSource, beacon, remote image/CSS/script/frame, form submit, top-level navigation, custom protocol, download and `window.open` from **both** labels. It proves zero trap requests, no navigation/new window, and working Tauri IPC. Chromium/WebKit static-asset CSP smoke tests supplement, but never replace, this real-webview gate.

Reason: this exactly implements D13 lines 2629-2648 and 2667-2673. CSP alone does not control native navigation; a navigation handler alone does not control passive network loads.

Reasonable alternatives rejected: a permissive `connect-src` for localhost, CSP `null`, a dev-server check, an allow-list of arbitrary URLs, or a browser-only test all miss a required boundary.

### C-6. Approval and secret bytes remain Rust-mediated and authoritative

For approval, TypeScript may submit only `{ approvalId, digest, typedResponse }`. Rust calls B3's authoritative `approval view { approvalId, digest }` control operation, handles its typed stale/digest/challenge outcomes, renders only the returned structured preview with the Rust text-only renderer, shows the daemon-issued challenge, and invokes B3's `approve` operation. `approve` still re-plans under the daemon lock. It never displays a preview field supplied by the webview. B3's production TypeScript **terminal** renderer and C's Rust app renderer consume every shared `test/fixtures/disclosure-preview/` vector and compare its exact UTF-8 result after neutralising HTML, bidi/C0/C1/zero-width/control characters, links and envelope-looking text; C does not introduce an app-local TypeScript preview renderer for this contract.

Every daemon/provider/target-controlled result crosses a Rust-mediated `UntrustedAppResult` boundary before React sees it. The production safe app renderer sanitises and bounds provider/target errors, labels them untrusted, and renders `dryrun show` and `rule test-retained` content as inert text. It rejects raw forwarding from a control reply, never treats a stable error code or a model `reasonCode` as a provider fact, and gives React only structured safe segments plus stable codes.

For D2 secrets, Rust passes hidden input directly from the `secrets` window to the same B3 daemon operation only after producing B3's owner-verified, non-forgeable secret-window capability. The capability is bound to the native labelled window, control session, operation and nonce; it is never a webview-supplied origin/window string, and a raw client forging a label is refused. Rust uses `Zeroizing` storage for the shortest possible scope, and only returns create/rotate generated material once to `secrets`. It preserves the D2 contracts: generated target-signing/subscriber values are reveal-once; URL/key input never echoes; secret URL returns only authority/fingerprint; audit output has operation/id/version/outcome/time only. The frontend clears input/result on submit, close, blur and failed navigation; the Rust owner clears pending reveal state when the window closes.

Reason: D2 lines 471-495 and D13 lines 2618-2627/2658-2665 establish precisely this authority and byte boundary. Terminal/app operations share the daemon operation; C is an adapter, never a second secret store.

Reasonable alternatives rejected: trusting webview preview JSON, rendering HTML/links, accepting a secret in a generic command or URL parameter, clipboard-based secret transport, logging a request for diagnosis, or returning a second copy on reload.

### C-7. Version-1 distribution is a separate, unsigned prerelease lane

Add a `desktop.yml` cross-platform PR/build workflow and a `desktop-release.yml` workflow triggered only by `desktop-v*`. The release workflow validates the tag against `apps/desktop/package.json`, repeats the full desktop matrix, builds an ad-hoc-signed universal macOS bundle (`signingIdentity: "-"`) and one unsigned Windows x64 NSIS installer, produces one SHA-256 file, and creates a GitHub prerelease with immutable checked-in first-launch notes. Linux builds/tests but uploads no version-1 artifact. It uses no signing/certificate secret and refuses a non-prerelease/latest release.

The mechanical signing gate is deliberate: the only version-1 workflow path forces `--prerelease` and never calls a signing/notarisation step. A future wider-release change must add a protected signing environment, Developer ID signing + notarisation + staple and Windows certificate signing before it can remove those assertions. A static workflow test fails if the version-1 workflow references a signing secret, omits either launch instruction, lacks either artifact/hash, or can create a latest/non-prerelease release.

Reason: this is D14 lines 2765-2788, not a temporary documentation promise. The build remains unsigned because credentials and identities do not exist in this phase.

Reasonable alternatives rejected: adding a signing secret now, shipping Linux before it has an artifact contract, using the npm `v*` workflow, marking a prerelease latest, or relying on a README instead of a release gate.

### C-8. B3 is a versioned wire contract, not an assumption; E/E2 are presentation seams only

Tasks 5–7 start only after B3 has landed its operations, exception rows, human-only secret tests and a checked-in `desktop-control/v1` language-neutral artifact. That artifact contains versioned JSON Schema plus request, success-result and error vectors for every D10 operation C may call; B3 generates it from, or checks it against, the TypeScript operation types. C generates its Rust DTOs from the artifact or validates checked Rust DTOs against it in `build.rs`; a missing artifact, an unknown operation, a schema/type drift or a vector mismatch fails closed in `desktop-b3-wire-contract`. C does not recreate a JSON decoder or a TypeScript desktop renderer.

B3 also publishes `approval view { approvalId, digest }` with the authoritative structured preview and daemon challenge, including stale-id, digest-drift and wrong/missing-challenge vectors. Before C's capability exists, B3 accepts D2 secret operations only from the interactive-terminal origin and refuses every app/window origin with its stable unavailable result; the raw forged-window-label vector is mandatory. C supplies and proves the capability before it enables the app origin. C calls the following B3 surfaces, exactly as D10 names them:

| App area | B3 daemon operations called by C |
|---|---|
| Overview/source health | `status`; `doctor`; `catalogue list`; `catalogue show <type>`; `sources list`; `source show` |
| Rules | `rules list`; `rule show`; `rule create`; `rule update`; `rule enable`; `rule disable`; `rule remove`; `rule test`; terminal/app-only `rule test-retained <eventId>` |
| Targets/subscribers | `targets list`; `target add`; `target update`; `target remove`; `target test`; terminal/app-only `target resume`; `subscribers list`; `subscriber add`; `subscriber update`; `subscriber remove` |
| Deliveries | `deliveries list`; `delivery retry`; `delivery drop`; `held list`; terminal/app-only `held decide`; `dryrun list`; `dryrun show` |
| Judges/budget | `judges list`; `judge add`; `judge update`; `judge remove`; `judge test`; `budget show`; `budget update`; `judge kinds list`; `judge kind enable <kind>`; `judge kind disable <kind>`; `judge model status`; `judge model remove` |
| Daemon/approval | `stop`; `pause`; `resume`; `disable-all`; `enable-all`; internal control `approval view { approvalId, digest }`; terminal/app-only `approve <id>`; `doctor`. The app does **not** call `run`: Rust supervision is the only start path. |
| Dedicated `secrets` only | `target secret create <targetId>`; `target secret rotate <targetId>`; `target url set <targetId>`; `subscriber token create`; `subscriber token rotate`; `judge key set <judgeId>`; `judge key rotate <judgeId>`; `secrets migrate --to keychain|file`. |

`target test` and `judge test` use B3's explicit pending activation-context selector only from the terminal approval flow or the app approval screen; ordinary CLI and MCP are refused. C passes the same selector and never reconstructs it.

Pre-E, judge operations exist with their capability rows but return B3's stable typed unavailable result with zero network. Pre-E2, the `laya` kind and its model status/remove operations return typed `E2_REQUIRED` with no pointer, approval, download, worker or network; holds are typed empty. C renders only these declared variants. E and E2 become their producers without changing C's contract. The E build/ship gate belongs in E and imports E's real code: B3 exports only the data-only contract and a consumer-fixture test, while C supplies only the consumer UI proof.

Reason: Phase E explicitly depends on C's hold resolution and Judges screen and E2 on enablement/progress (lines 2828-2829); D11 says the app contains no Node/Laya artifacts (2321-2329). A screen seam is not licence to implement future daemon work.

---

## Plan review decisions (2026-10-10)

| Question | Decision | Reason |
|---|---|---|
| C-A — Windows control while B1-G applies | Run the Windows desktop UI/build/no-egress tests, but return `WINDOWS_CONTROL_UNAVAILABLE` unconditionally before reading instance or token state. Amend the spec support matrix to say this; assign ACL-capable pipe ownership to a future phase. | B1-G is binding until a daemon owner can create and verify the required Windows ACL; UI coverage remains a C obligation. |
| C-B — daemon identity and launch | Persist one private, atomic `DaemonProfile` with canonical absolute executable, state directory and config directory; attach and spawn only through it with fixed argv, no shell, PATH search, discovery or silent start. | A separately installed daemon is safe only when the app cannot attach to or launch a different state/profile. |
| C-C — Rust/B3 DTO boundary | B3 publishes the language-neutral, versioned JSON Schema plus request/result/error vectors; C generates or validates Rust types from it and fails closed on absence or drift. | TypeScript DTO declarations alone are not a Rust-consumable contract. |
| Approval read/challenge | B3 provides `approval view { approvalId, digest }` returning authoritative preview and challenge, with stale/digest/challenge vectors; `approve` re-plans at the end. | The app must not invent a read operation or approve renderer-provided content. |
| Shared preview rendering | B3's production terminal renderer and C's Rust renderer consume the same checked-in preview fixtures. | A desktop-only TypeScript renderer would not detect terminal-renderer drift. |
| App secret origin | B3 refuses app/window secret origins until C supplies an owner-verified, non-forgeable Rust-to-daemon secret-window capability; forged raw labels are refused. | A caller-controlled origin label is not an authority boundary. |
| C-D — pre-E/E2 screen states | Judge operations return typed unavailable with zero network before E; `laya` returns `E2_REQUIRED` with no pointer, approval, download, worker or network before E2; holds are typed empty. | C renders declared data variants only; E/E2 later become their producers without contract drift. |
| E build/ship gate | Keep the real judge build/ship gate in E, importing E code; B3 exports only data contract and consumer fixtures. | C and B3 must not make an unreachable pre-E gate look like E validation. |
| Pending target/judge testing | Use B3's explicit pending activation-context selector only in terminal approval flow and the app approval screen; refuse MCP and ordinary CLI. | Testing a pending target/judge is part of its proposed approval, not a general operation. |
| C-E — secrets CSP intersection | Emit both the configured D13 CSP and the exact secrets meta policy; assert every directive/value, their effective intersection and working secrets IPC. | D13 already defines a second tightening policy; merely “stricter” is insufficient. |
| C-F — tray quit | Quit stops the daemon unless keep-collecting is enabled, whether the app attached or spawned it. | This is D12's literal version-1 behavior. |
| D13 Settings autostart | Add opt-in **open at login**, default off; it opens only the desktop tray and never starts/attaches the daemon until a new explicit action. | It satisfies the required Settings item without designing a future OS daemon service. |
| Untrusted daemon results | Add a Rust-mediated production safe renderer for provider/target errors, `dryrun show` and `rule test-retained`, with hostile vectors and raw-forward mutations. | D3 requires these values to be sanitised, bounded and visibly untrusted before an approval-adjacent UI can receive them. |
| D13 screen proof | Add a screen-contract fixture matrix with a named test for every D13 screen item. | Generic screen smoke tests cannot prove the required information/actions are present. |
| D2 secret audits | Assert one exact allowed audit-row schema for every secret operation and mutate added host, fingerprint and secret-reference fields. | A sentinel scan can miss derived secret material. |
| Bundle exclusion | Gate packaged content and dependency graphs against an allowlist; reject Node runtime/daemon entry or `node:` edge, ONNX binaries, workers and model artifacts by metadata/content as well as names. | Renaming an excluded runtime or artifact must not bypass the release gate. |
| Fork-safe desktop workflow | Make `desktop-workflow-matrix` reject registry token env/secret/configuration and prove the public-registry install path. | A normal fork PR must install CUE++ dependencies without credentials. |
| Native egress guards | Add one production-path mutant each for download, custom/external protocol and new-window refusal. | The real-webview test must go red when any native guard is removed. |
| Execution isolation | Serialize Tasks 2 → 3 → 4; parallel work may not share files. | These tasks each own package/config/mutation integration files and later gates consume earlier outputs. |

## Decisions made during the build

| Question | Decision | Reason |
| --- | --- | --- |
| Task 2 — how does the probe reach the native download refusal? | The probe adds a same-origin blob download next to the cross-origin download link; the app runs under a throwaway home and temporary directory, and the probe proves no download reached disk. Packaged mutations share one dedicated cargo cache (`src-tauri/target/desktop-mutations`) and skip pnpm's pre-run dependency check in their linked copies. | WebKit treats a cross-origin `download` link as a navigation, so the download guard never ran; a mutant that allowed downloads wrote into the person's real Downloads folder. |
| Task 3 — how are workflow actions referenced? | By the commit that was reviewed, never a movable tag, in both desktop workflows (`desktop-actions-pinned`; resolved 2026-10-10, listed in docs/RELEASING.md). The npm release and PR-requirements workflows, which still use tags, are a follow-up outside this phase. | The release job holds `contents: write`; a retargeted tag could publish a non-prerelease. |
| Task 4 — how is open-at-login handled before a registration mechanism is approved? | `openAtLogin` is persisted, default off, and login startup is inert (no attach, no spawn); no OS login-registration mechanism, plugin or fifth native command is added until one is approved. | The plan limits pre-B3 native control to four commands and names no registration mechanism. |
| Task 5 — B3 merge prerequisite while PR #63 awaits the owner | Task 5 was built on the stacked B3 branch while PR #63 awaited owner merge; re-verify the complete Task 5 contract and tests after that merge. | The reviewed B3 data-only v1 schema, vectors and operation registry are already present in the stacked branch; this does not substitute for owner merge or post-merge verification. |
| Task 5 — app approval path | App approval works through B3's `approval view` → `approve` path. The approval record's `approvedVia: "app"` value and the pending-test selector come from B3's follow-up on `fix/events-b3-app-approval`, which C adopts after it merges. | B3 currently supplies the typed view/approve path but not that pending selector; C does not reconstruct it. |
| Task 6 — non-forgeable secret-window capability | A desktop-spawned daemon receives one fresh 32-byte key only through an inherited pipe at the fixed FD named by `AGENTCOMMS_DESKTOP_CAPABILITY_FD`. The native `secrets` window obtains a daemon-issued single-use nonce bound to its authenticated control session and exact D2 operation, then proves it with `HMAC-SHA256(key, session id \|\| operation \|\| nonce)`. The owner verifies in constant time and consumes the nonce before accepting that one app request. An attached daemon has no shared key and returns the typed terminal-only result; it never falls back to a label. | A client that holds the ordinary owner token can forge any origin/client label, so a label is not a capability. The inherited key is neither argv, environment material nor a file; session/operation-bound one-time proofs prevent replay and substitution. |
| Task 6 — where do the desktop tests that build or run Rust go? | In a native lane: they skip under `pnpm --filter @agentcomms/desktop test`, so root `pnpm verify` needs no Rust toolchain, and `test:native` runs every test with them. The desktop workflow builds the packages before its frontend gates and runs `test:native` after its Rust gates, on each operating system; `desktop-native-lane` fails if a Cargo-backed test loses its gate or the lane its switch. | The first GitHub runs (2026-10-12) failed every npm-release leg on `cargo --offline` with no crates fetched, and this plan keeps Cargo out of normal repository verification. |
| Task 7 — how does the test-only `control-probe` stay out of release bundles? | It is a Cargo example (`src-tauri/examples/control-probe.rs`), not a binary: the desktop workflow builds it with `cargo build --example control-probe` for the Unix control gate, and Tauri bundles only the package's binaries. | Task 7's bundle audit found `Contents/MacOS/control-probe` in the real macOS bundle: Tauri packages every binary target, and a feature gate on a binary would leave the bundler looking for a file a normal build no longer makes. |

## Planned file map

| Area | Files / responsibility |
|---|---|
| Workspace/frontend | `apps/desktop/package.json`, `tsconfig.json`, `vite.config.ts`, `settings.html`, `secrets.html`, `src/main.tsx`, `src/secrets-main.tsx`, `src/app.tsx`, `src/screens/*.tsx` and the screen-contract fixture: private multi-page React/CUE++ UI, typed safe segments, Settings login-only autostart and no network client. |
| Native authority | `apps/desktop/src-tauri/src/{lib,security,tray,preferences,supervisor,untrusted_result}.rs`, `src/control/*.rs`, `src/commands/*.rs`: window creation, CSP/navigation/tray, profile-pinned D12 client, supervised process, Rust safe renderer and closed Rust IPC commands. |
| Tauri declarations | `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/settings.json,capabilities/secrets.json}`: v2 dependency lock, bundle/CSP settings, command manifest and disjoint labelled authority. |
| B3 contract input | B3-owned `packages/events-daemon/contracts/desktop-control/v1/` schema/vectors and `test/fixtures/disclosure-preview/`: versioned request/result/error types, approval-view vectors and the common production-terminal/Rust-renderer fixture set; C consumes but does not rewrite them. |
| Tests/mutations | `apps/desktop/test/**`, `apps/desktop/src-tauri/tests/**`, `test/desktop-*.test.mjs`, `test/fixtures/{desktop-screen-contract,untrusted-result}/**`, `scripts/verify-desktop-mutations.mjs`, and the shared daemon protocol fixture: production-path unit, integration, actual-webview, workflow, audit-schema and destructive-mutation proofs. |
| Build/release/docs | `pnpm-workspace.yaml`, root `package.json`, `pnpm-lock.yaml`, `.github/workflows/desktop*.yml`, `apps/desktop/{README.md,RELEASE_NOTES.md,THIRD_PARTY_LICENSES}`, `docs/RELEASING.md`, `CHANGELOG.md`, and the D12/D13 support matrix in the local-event design: workspace reachability, three-platform CI, Windows-control support statement, unsigned prerelease release boundary and first-launch instructions. |

## Safety ledgers and automatic defect checks

### Write-after-await ledger

The desktop owns no event-database transaction. It nevertheless has mutable Rust preferences and process lifecycle state, which need the same discipline. `apps/desktop/src-tauri/src/supervisor.rs` must expose a `SupervisorEpoch`; `preferences.rs` must use a revisioned, owner-only atomic file and lock. Every row is exercised against production code by the named test and mutation runner.

| Write after await | Fresh condition checked at write/commit | Named production-path test / destructive mutation |
|---|---|---|
| Native daemon-profile selection returns, then preference save | Do not save before attach/spawn readiness. At the final synchronous start commit, current preference revision and app lifecycle epoch still equal the snapshot; the full `DaemonProfile` has canonical absolute executable/state/config paths, each rejects symlink/reparse traversal, the executable is a regular owner-readable `agent-events`, private ownership/mode survives atomic replacement, and no caller-supplied argv survives. A cancelled or superseded start leaves the preference file byte-identical. | `desktop-daemon-profile`, `desktop-preferences-race`, `desktop-preferences-private`, `desktop-preferences-symlink-reparse`, `desktop-preferences-atomic-recovery`, `desktop-supervisor-late-spawn`; persist before the first status/attach operation or remove one respective check. |
| A daemon child spawn or attach hello returns | Desired supervisor epoch, current child identity, selected protocol version and quit state still match; otherwise stop only that just-spawned child and persist nothing. | `desktop-supervisor-late-spawn`; remove the epoch re-check or persist before the first operation. |
| `stop`/child-exit wait returns | Stored child/process identity and epoch still match before clearing ownership/health; a restarted daemon is not erased. | `desktop-supervisor-stop-race`; clear by PID/any state. |
| A Rust control request returns before UI state is published | Request id, negotiated session generation, request epoch and current window lifecycle epoch still match; hide, close and purge advance the lifecycle epoch, so stale replies cannot repopulate a hidden, purged or closed screen. No daemon state is written by C. | `desktop-control-stale-reply`, `desktop-ui-stale-reply`; accept a stale result or drop the request/lifecycle epoch comparison. |
| Authoritative preview fetch/challenge request returns | Approval id and digest must still match the requested action; Rust renders fetched bytes only. The daemon's B3 `approve` operation re-plans/claims atomically; C writes no approval record. | `desktop-approval-authoritative-preview`; render supplied preview or skip digest match. |
| Secret IPC reaches Rust or the B3 reply returns | Native label must still be `secrets`; the owner-verified, non-forgeable capability is bound to the control session, nonce and allow-listed operation. Rust clears the value/result if the window closed/blurred meanwhile; no local persistence occurs. | `desktop-secret-window-capability`, `desktop-secret-close-race`; accept a raw forged label/capability or retain a result. |

`apps/desktop/test/mutations/manifest.json` gives every mutation one executable `test`: a Node test names its file and exact case, and a Rust test names its Cargo manifest, `--test`/`--lib` path and exact case. Rust cases may also name a Node `structuralTest` as non-executable source evidence. `apps/desktop/test/mutations/run.mjs` applies one mutant at a time to a temporary worktree copy, executes only the declared test, verifies the exact named case ran, and requires failure. `scripts/verify-desktop-mutations.mjs` parses the manifest and test markers, rejects a test without a mutation, a mutation without a test, duplicate mutation ids, a test that does not import the production module it names, a Rust declaration whose name/path differs from its marked function, or a mutant that stays green. Root `pnpm verify` runs this structural checker; the full destructive runner runs in the desktop workflow.

### Identity and scope ledger

- The React layer treats daemon ids as opaque stable ids. It displays aliases/names supplied by B3 but sends the stable `accountId`, `ruleId`, `targetId`, `subscriberId`, `judgeId`, version and digest that B3's typed DTO requires; it never resolves aliases itself.
- Every UI update/remove/retry/hold action carries the selected record's stable id and version, and Rust rejects an id/version result whose returned parent `accountId`/source does not equal the selection. This is a client-side refusal, not a replacement for B3's SQL scope fence.
- C imports source/channel vocabulary from B3 response types. It does not reproduce Slack/WhatsApp event names, visibility vocabulary, account aliases or target-kind lists.
- `desktop-id-scope.test.tsx` invokes the real command adapter with same-looking cross-account records; the `drop-account-scope` and `resolve-alias-again` mutants must fail it. `verify-desktop-mutations` requires both pairs.

### Purge/cancellation and cache ledger

The app owns no daemon purge. Therefore it keeps no durable optimistic/offline mutation queue, never caches decrypted dry-run/secret content to disk, invalidates its in-memory query cache after every destructive B3 response and on a control-session reconnect, and cancels pending UI promises/timers on window close. The daemon remains responsible for rule/target/account/list purges under B1/B2/D fences. `desktop-purge-ui-orphans.test.tsx` drives the real adapter through a disabled/removed response and proves no retry, stale dry-run rendering or secret reveal continues; `leave-action-queued` and `keep-secret-result` mutations fail it.

### Tests that bite

Every app test calls either a compiled Rust command, the real TypeScript adapter/reducer, B3's actual production terminal renderer, the Rust production safe renderer, or a packaged Tauri webview. No test-local authority table, mock-only model, shared default branch or “test mode” bypass may establish the assertion. Test doubles are restricted to the daemon control peer, child process and literal-loopback trap; each records the actual frame/bytes it received. The structural checker above enforces a one-to-one named-test/mutation manifest, and `desktop-production-path.test.mjs` rejects test imports from `test/support` in a case asserting a production command.

## Execution map and safe parallelism

| Batch | Tasks | Dependency / safe parallelism |
|---|---|---|
| 1 — workspace authority | 1 | First: establishes the private app, mutation harness and root verification hooks. No B3 dependency. |
| 2 — UI and release perimeter | 2 → 3 | After Task 1, serialize: Task 2 owns the security/CSP/probe baseline; Task 3 then owns workflow, release and shared package/config integration. No B3 dependency. |
| 3 — local client authority | 4 | After Task 3, because Task 4 consumes the integrated package/config/mutation baseline. It may proceed while B3 is being implemented because it tests protocol v1/status/stop only. |
| 4 — B3 adoption and privileged boundary | 5 → 6 | Begin only after B3 has merged and its D10/exception/parity suite is green. Sequential: Task 5 declares the non-secret operation/approval contract; Task 6 binds the secret-only contract and capability manifest. |
| 5 — phase seams and release audit | 7 | After Tasks 3–6. This is the integrated release gate and E/E2 seam audit. |

The only implementation parallelism is B3 in its own worktree while C performs Tasks 1–4; it does not edit C files and C does not cherry-pick an assumed B3 API. C Tasks 2, 3 and 4 are serialized because they each edit shared package, Tauri configuration and mutation integration files. Rebase after each merged task, rerun its focused tests and then the batch command. Generated lockfiles and reference artifacts are resolved only in the integration worktree; do not copy them between worktrees.

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

- [ ] **Step 1: Write failing static and real-webview tests.** Assert byte-equality and the complete directive/value set of the configured D13 policy and of the `secrets` meta policy: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`. Assert their intersection, `dangerousDisableAssetCspModification: false`, no forbidden plugin/permission, handler installation before `WebviewWindowBuilder`, and labelled capabilities. The test must prove benign Tauri IPC works in **both** windows, including the secrets document. Write the probe contract that launches a release-mode test-feature bundle plus literal loopback trap and requires both windows' attack matrix to yield zero requests/no navigation/no popup while that IPC round trip succeeds.
- [ ] **Step 2: Run focused failures.** Run `node --test apps/desktop/test/csp-navigation.test.mjs` and `pnpm --filter @agentcomms/desktop test:e2e -- --case no-egress`; expect missing policy/handler/probe.
- [ ] **Step 3: Implement the native perimeter first.** Put the exact configured CSP in `tauri.conf.json`; emit it for `secrets` as well and add the exact nine-directive tightening meta policy above, with no remote asset. In Rust install independent navigation, new-window, download and external-protocol refusals before creating `settings` or `secrets`. Register no shell, fs, HTTP, opener, clipboard, dialog or window-creation plugin/capability. Create the tray after the policy and make closing `settings` hide rather than quit.
- [ ] **Step 4: Implement the production probe.** Under a Cargo feature usable only by the CI command, compile the same Tauri config/assets into a test probe that executes the complete D13 attack matrix in each actual window and reports only booleans/counts over a private test pipe. The Node harness starts the repository's loopback seal and literal-loopback trap before launching the bundle; it contains synthetic URLs only. It must fail if an attack is skipped, an IPC call fails, a new window is created, or the trap sees one request.
- [ ] **Step 5: Add paired mutations.** For **each directive** in both the configured policy and the secrets meta policy, delete it or widen/change its value and require `desktop-csp-exact` to fail; retain separate mutants for `dangerousDisableAssetCspModification: true` and CSP `null`. Mutate handler installation after the first window, allow a non-app navigation URL, grant an HTTP/opener permission, and independently remove the production download, custom/external-protocol and new-window refusals. The packaged probe must fail under `desktop-navigation-denial`, `desktop-download-denial`, `desktop-custom-protocol-denial` and `desktop-new-window-denial` respectively.
- [ ] **Step 6: Run focused checks.** Run `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`, `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features`, `node --test apps/desktop/test/csp-navigation.test.mjs`, and the platform's `pnpm --filter @agentcomms/desktop test:e2e -- --case no-egress`; all must pass. Run every Task 2 mutation with the mutation runner and observe each named test fail.
- [ ] **Step 7: P1-only review and commit.** Review only both complete CSP directive sets and their effective intersection, handler ordering, each native refusal, capability/plugin absence, both window labels, working secrets-document IPC and the trap journal. Commit `feat(desktop): enforce no-egress webview perimeter`.

**Required mutations:** `desktop-csp-configured-<directive>` and `desktop-csp-secrets-<directive>` for every directive; `desktop-csp-asset-modification`, `desktop-csp-null`, `desktop-handler-order`, `desktop-navigation-denial`, `desktop-http-opener-capability`, `desktop-download-denial`, `desktop-custom-protocol-denial`, and `desktop-new-window-denial`. Each is paired in `manifest.json` with its exact static or packaged-probe test.

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

- [ ] **Step 1: Write failing workflow/docs tests.** Parse both YAML files as text/structure and require all three OS gates to run frozen pnpm install, frontend checks, `cargo fmt`, warning-denied clippy, Cargo tests, actual-webview test and unsigned Tauri build. `desktop-workflow-matrix` must run in a fork-equivalent no-secret environment; reject every `secrets.*` expression, `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `YARN_NPM_AUTH_TOKEN`, auth-bearing `.npmrc`/registry configuration, and any registry other than the public npm registry. Require a `pnpm config get registry` assertion for that public path before `pnpm install --frozen-lockfile`. Require the release tag only be `desktop-v*`, root `release.yml` remain `v*`, Linux upload be absent, macOS universal/ad-hoc and Windows x64 NSIS outputs plus SHA-256 exist, and release creation be `--prerelease`/not-latest. Require no signing env/certificate value in the version-1 workflow. Require the exact macOS/Windows instructions and hash comparison in README, release notes and RELEASING.
- [ ] **Step 2: Run focused failures.** Run `node --test test/desktop-workflows.test.mjs apps/desktop/test/release-notes.test.mjs`; expect missing workflows/notes.
- [ ] **Step 3: Implement the normal desktop matrix.** Add path-aware workflow triggers for app/root workflow changes and an explicit all-platform matrix. In the same fork-safe job, assert `pnpm config get registry` is the public npm registry and install public dependencies with `pnpm install --frozen-lockfile`, no auth env, no secret, no private registry and no project/user `.npmrc` token; build/test the frontend, run the requested Cargo commands, execute the bundled trap probe and build an unsigned bundle. Linux installs only documented Tauri system packages and publishes nothing.
- [ ] **Step 4: Implement prerelease-only release.** Validate `desktop-v${desktop package version}` and immutable tag commit; rerun the same matrix; build universal macOS with `signingIdentity: "-"` and unsigned Windows x64 NSIS; download artifacts into one release job, write deterministic SHA-256 lines, assert release notes contain both launch sections, and create/update only a GitHub prerelease. Use `github.token`/repository permissions only; do not introduce a stored signing secret. The workflow must reject any input or branch which requests latest/non-prerelease publication.
- [ ] **Step 5: Add docs and package artefact hygiene.** Document the separate daemon prerequisite from C-B, checksum comparison, macOS Open Anyway and Windows More info/Run anyway/Smart App Control limitations. State no in-app updater, no Linux version-1 artifact and the Developer ID/notarisation/Windows-code-signing condition for a wider release. Generate the desktop third-party notices from its locked dependencies; do not touch npm package release holds.
- [ ] **Step 6: Add paired mutations.** Mutate the trigger to `v*`, remove one OS, remove the public-registry assertion, add a registry token/secret/private registry configuration, remove `--prerelease`, add a signing-secret reference, omit an artifact hash, omit one launch instruction, and add a Linux upload. Each must fail its named workflow/docs test.
- [ ] **Step 7: Run focused checks.** Run `node --test test/desktop-workflows.test.mjs apps/desktop/test/release-notes.test.mjs` and the Task 3 mutation cases; all normal tests pass and every mutation fails. Validate YAML with the repository's parser/test rather than an online service.
- [ ] **Step 8: P1-only review and commit.** Review only tag isolation, forced prerelease, artifact/hash flow, absence of signing credentials, matrix completeness and user-facing instructions. Commit `ci(desktop): add unsigned prerelease release gates`.

**Required mutations:** `desktop-tag-isolation`, `desktop-matrix-completeness`, `desktop-workflow-public-registry`, `desktop-workflow-no-registry-token`, `desktop-prerelease-only`, `desktop-no-signing-secret`, `desktop-hash-asset`, `desktop-launch-docs`, and `desktop-no-linux-upload`.

**Batch 2 verification:** after the serialized Tasks 2 then 3 are integrated, run `pnpm verify`; passing means root checks, workflow/docs tests and desktop TypeScript checks are all green. On each native CI OS, `desktop.yml` additionally proves the Cargo/bundle/webview commands from Task 3.

## Batch 3 — local client authority

### Task 4 — Rust D12 client, safe daemon supervision, and protocol compatibility

**Risk:** highest. A token leak, wrong frame encoding, unsupported-version fallback, or late child could make the app control the wrong owner or leave collection running after quit.

**Files:**

- Modify: `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/tray.rs`, `apps/desktop/src/app.tsx`, `apps/desktop/package.json`, `apps/desktop/test/mutations/manifest.json`, `docs/superpowers/specs/2026-10-05-local-event-emission-design.md`
- Create: `apps/desktop/src-tauri/src/control/mod.rs`, `apps/desktop/src-tauri/src/control/frame.rs`, `apps/desktop/src-tauri/src/control/client.rs`, `apps/desktop/src-tauri/src/control/types.rs`, `apps/desktop/src-tauri/src/preferences.rs`, `apps/desktop/src-tauri/src/supervisor.rs`, `apps/desktop/src-tauri/src/commands/supervision.rs`, `apps/desktop/src-tauri/src/bin/control-probe.rs`, `packages/events-daemon/test/fixtures/control-protocol-v1.json`
- Modify tests: `packages/events-daemon/test/protocol-compat.test.ts`, `test/desktop-mutation-structure.test.mjs`, `test/desktop-mutations.test.mjs`
- Create tests: `apps/desktop/src-tauri/tests/control_frames.rs`, `apps/desktop/src-tauri/tests/supervisor.rs`, `apps/desktop/src-tauri/tests/preferences_security.rs`, `apps/desktop/test/control-compat.test.mjs`, `apps/desktop/test/supervisor.test.mjs`, `apps/desktop/test/daemon-profile.test.mjs`, `apps/desktop/test/mutation-runner.spec.mjs`, `apps/desktop/test/supervision-lifecycle.test.mjs`, `apps/desktop/test/windows-support-matrix.test.mjs`

**Interfaces:**

- Produces `DesktopControlClient::request(NonSecretControlRequest)` and `DesktopSupervisor::{attach,start,quit,status}` operating only on `DaemonProfile { executable, stateDir, configDir }`. Protocol support is `const SUPPORTED: [u32; 1] = [1]`.
- Produces owner-only, atomic `DesktopPreferences { daemonProfile, keepCollectingAfterQuit, openAtLogin }`, where login launch is default-off and opens only the tray app.
- Produces the sole pre-B3 command surface: `desktop_supervision_status`, `desktop_start_daemon`, `desktop_quit_daemon`, and `desktop_open_secrets` (which only opens a still-inert separate window).
- Consumes current D12 `status`, `stop` and `doctor` only; it does not require B3.

- [ ] **Step 1: Write failing shared-frame, profile-security and supervisor-race tests.** Add a data-only protocol fixture containing valid hello/request/success/failure/oversize/malformed/no-overlap frames. Extend the existing TypeScript protocol test to consume it. Write Rust tests for byte-exact frame encode/decode, highest mutual version, rejection of malformed/oversize/session responses, and no token in a public error. Write profile vectors for absolute/canonical executable, state and config paths, and assert attach reads only those profile paths while spawn uses exactly the configured executable plus fixed `run` argv. Test private owner/mode verification after creation and atomic rename, symlink/reparse refusal on each profile/preferences path, crash recovery to only a complete prior atomic record, and path-drift refusal. Pause `runtime.status()`, cancel through tray Quit, and assert the complete preference-file byte sequence remains exactly as it was before Start. Test the production command adapter with each paused `status`, `start` and `stop` publication path, then hide, close or purge the window before resolving it; every stale reply must be dropped. Write Node integration that starts the real `startControlServer`/owner under the loopback seal and invokes the compiled Rust `control-probe` over the Unix socket. Write race tests that pause spawn/hello/stop operations and exercise the ledger rows; assert default login startup makes no attach/spawn call and Quit stops an attached as well as spawned daemon unless keep-collecting is true.
- [ ] **Step 2: Run focused failures.** Run `node --import ./test/helpers/loopback-seal-preload.mjs --experimental-strip-types --test packages/events-daemon/test/protocol-compat.test.ts apps/desktop/test/control-compat.test.mjs apps/desktop/test/daemon-profile.test.mjs apps/desktop/test/windows-support-matrix.test.mjs`, then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test control_frames --test supervisor --test preferences_security`; expect absent fixture/client/supervisor failures.
- [ ] **Step 3: Implement the client without widening authority.** Mirror D12's 4-byte big-endian bounded JSON frames and hello/request/reply shapes. On Unix re-prove the profile-selected socket path/owner/mode before reading/sending the token; use the current owner-only state directory and no TCP. On Windows branch at the public control entry point to typed `WINDOWS_CONTROL_UNAVAILABLE` before resolving a profile directory, opening an instance/token record or constructing a control client, preserving B1-G. Do not serialise token/session into any `serde::Serialize` UI type.
- [ ] **Step 4: Implement supervision, secure preferences and the support-matrix amendment.** Store only `DaemonProfile`, keep-after-quit, default-off open-at-login, preference revision and non-secret child diagnostic identity in an owner-only atomic preference file. Never persist a token/session. Verify the private file on every open/create/replace, reject symlink/reparse paths and recover only a complete atomic record. Attach only through the exact profile, then start with its fixed argv/no shell/no PATH lookup or discovery; wait boundedly for authenticated protocol v1; use the epoch checks in the ledger; persist the selected profile/revision only at the still-current start commit after attach/spawn readiness. A cancelled or superseded start persists nothing and cleans up only the child it spawned. Route tray Quit through D12 stop/detach semantics for attached and spawned daemons alike. Register login only for the tray app and make its startup inert until an explicit start action. Amend D12/D13's support matrix to state that Windows UI/CSP/no-egress coverage runs while desktop control is unconditionally unavailable under B1-G; assign ACL-capable daemon ownership to a future phase. `settings` closing only hides it. The React adapter issues a request epoch for every `status`, `start` and `stop`, publishes a result only when both that request and the current window lifecycle epoch match, and advances the lifecycle epoch on hide, close and purge.
- [ ] **Step 5: Prove actual compatibility.** The Unix integration must use the real Node v1 server, not a Rust-only fake; prove status/doctor success and typed `PROTOCOL_UNSUPPORTED` on disjoint versions, using the profile's exact temporary state/config directories. The Windows CI case puts trap files at every profile/instance/token path and proves `WINDOWS_CONTROL_UNAVAILABLE` occurs before any read; it still runs the packaged UI/CSP/no-egress probe. The test must start no source/provider.
- [ ] **Step 6: Add paired mutations.** Remove length prefix validation, accept no-overlap, expose a token in an error, remove Unix endpoint proof, read a Windows instance/token path before refusal, substitute one daemon-profile path or permit PATH lookup, remove private owner/mode verification, follow a symlink/reparse path, accept a torn preference record, make login startup call attach/spawn, persist the selected profile before the first attach/status operation, remove each supervisor epoch/revision check, clear ownership without exact process identity, and drop the frontend request/lifecycle epoch comparison. Every manifest case has exactly one executable `test` declaration: a Rust case declares its Cargo manifest, `--test`/`--lib` path and exact test function; any Node source assertion is labelled structural evidence. The runner executes only that declaration, and the structural checker rejects a declared Cargo name/path that differs from the marked function. Each mutation must fail its named test.
- [ ] **Step 7: Run focused checks.** Run the commands in Step 2, `pnpm --filter @agentcomms/desktop test -- --test-name-pattern='control|supervisor|daemon-profile|supervision lifecycle|windows-support'`, `node --test test/desktop-mutations.test.mjs`, and all Task 4 mutation cases. Every normal test passes and every mutant fails.
- [ ] **Step 8: P1-only review and commit.** Review frame bounds, no token serialization, Unix endpoint proof, unconditional pre-read Windows refusal, exact daemon-profile paths, private/symlink/reparse/atomic preference handling, no shell/PATH/discovery, login's no-spawn invariant, every await ledger row, and child quit/detach behavior. Commit `feat(desktop): add authenticated daemon supervision`.

**Required mutations:** `desktop-frame-bounds`, `desktop-no-overlap`, `desktop-token-redaction`, `desktop-endpoint-proof`, `desktop-windows-pre-read-refusal`, `desktop-daemon-profile-drift`, `desktop-preferences-private`, `desktop-preferences-symlink-reparse`, `desktop-preferences-atomic-recovery`, `desktop-autostart-no-spawn`, `desktop-preferences-race`, `desktop-supervisor-late-spawn`, `desktop-supervisor-stop-race`, `desktop-control-stale-reply`, `desktop-ui-stale-reply`.

**Batch 3 verification:** run `pnpm verify`; passing means the shared TypeScript protocol fixture remains green and no daemon behavior/hold changed. Native CI additionally runs Cargo fmt/clippy/test and the Unix real-server probe where available.

## Batch 4 — B3 adoption and privileged boundary

### Task 5 — typed non-secret B3 adapter, authoritative approvals, and app screens with E/E2 seams

**Risk:** high. A generic operation path could invoke a human-only secret operation, and a hostile renderer could forge an approval preview.

**Prerequisite:** B3 has merged its complete D10 operation set, human-only exception rows, event-secret migration, lineage/pending-completion doctor surface, `approval view`, terminal-only pre-C secret refusal, and `packages/events-daemon/contracts/desktop-control/v1/` (versioned JSON Schema plus request/result/error vectors). Confirm with B3's `pnpm verify`, `pnpm verify:parity --strict`, its terminal-disclosure-preview fixture test and secret-operation mutation tests before editing C. Missing contract files or a schema/vector mismatch are a hard stop, not a reason to invent a decoder.

**Files:**

- Modify: `apps/desktop/src-tauri/build.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/control/types.rs`, `apps/desktop/src/app.tsx`, `apps/desktop/src/main.tsx`, `apps/desktop/src/types.ts`, `apps/desktop/src-tauri/capabilities/settings.json`, `apps/desktop/test/mutations/manifest.json`
- Create: `apps/desktop/src-tauri/src/control/b3_contract.rs` (generated or schema-validated only), `apps/desktop/src-tauri/src/commands/control.rs`, `apps/desktop/src-tauri/src/commands/approval.rs`, `apps/desktop/src-tauri/src/preview.rs`, `apps/desktop/src-tauri/src/untrusted_result.rs`, `apps/desktop/src/screens/overview.tsx`, `apps/desktop/src/screens/sources.tsx`, `apps/desktop/src/screens/rules.tsx`, `apps/desktop/src/screens/targets.tsx`, `apps/desktop/src/screens/deliveries.tsx`, `apps/desktop/src/screens/judges.tsx`, `apps/desktop/src/screens/approvals.tsx`, `apps/desktop/src/screens/settings.tsx`, `apps/desktop/src/screens/phase-seams.ts`, `test/fixtures/desktop-screen-contract/v1.json`, `test/fixtures/untrusted-result/v1.json`
- Create tests: `apps/desktop/src-tauri/tests/b3_wire_contract.rs`, `apps/desktop/src-tauri/tests/preview.rs`, `apps/desktop/src-tauri/tests/untrusted_result.rs`, `apps/desktop/test/b3-terminal-fixture.test.mjs`, `apps/desktop/test/control-contract.test.ts`, `apps/desktop/test/approval-renderer.test.tsx`, `apps/desktop/test/untrusted-result-renderer.test.tsx`, `apps/desktop/test/screen-contract.test.tsx`, `apps/desktop/test/id-scope.test.tsx`, `apps/desktop/test/purge-ui-orphans.test.tsx`

**Interfaces:**

- Produces schema-generated or schema-validated Rust B3 DTOs and exhaustive `NonSecretOperation` covering every non-secret/app-permitted B3 operation listed in C-8, plus `desktop_control` and `desktop_approve` commands.
- Produces `render_disclosure_preview(preview) -> Vec<u8>` and `UntrustedAppResult::from_b3(reply) -> SafeAppResult`; React receives only `SafeAppResult` segments, never raw control JSON or untrusted text.
- Consumes B3's production TypeScript terminal renderer and common disclosure-preview fixtures; it produces no desktop TypeScript preview renderer.
- Does not expose any D2 secret operation through `desktop_control`.

- [ ] **Step 1: Write failing wire-contract, renderer and screen tests.** Load B3's schema/vectors at build and test time; assert every C-8 non-secret operation maps once, `run` maps never, each D2 secret name is rejected by the generic enum, and changing a schema operation/type/vector makes `desktop-b3-wire-contract` fail. Run B3's **production terminal renderer** and Rust renderer against every shared disclosure fixture; feed tags, bidi/control/zero-width, OSC/CSI, fake headers, links and forged envelopes, and assert byte identity. Assert `approval view` supplies the sole preview/challenge source and covers stale id, digest drift and wrong/missing challenge.

  Drive `desktop-screen-contract` from `test/fixtures/desktop-screen-contract/v1.json`, with one named test `screen:<screen>:<item>` for every item: Overview—global switch, daemon/protocol health, source lag, exact/derived lineage ids and current cut-over id, superseded retained work, delivery outcomes, holds, enabled judge kinds, WhatsApp live lists, pending approvals, and staged/replacement/`enable-all` completion/failed state with deadline/action; Sources—accounts, event types, interval/budget, expected latency, shared cursor, per-rule activation/current cut-over, Slack drains, Gmail/Resend materialisation health, observation-time labels; Rules—tree, optional judge, exact inputs/budgets, mapping builder, representation/schema, rate cap, preview/dry-run test; Targets/subscribers—retention, webhook policy, SSE retention/origins, approved/pending versions, tests, separate secret handoff/new URL version flow; Deliveries—filters, state, retryability, drop, safe dry-run, reset barrier/`target resume`, holds; Judges—three kinds off, approval enable, immediate disable, inputs, hosted warning, keys, endpoints, Laya limits/boundary/unavailability reason, progress/verified/remove, secret handoff; Approvals—complete preview and typed challenge; Settings—open at login, keep collecting, secret backend/migration, retention, data/Laya disk use, unsigned about. Include B3 typed empty/unavailable/E2-required variants and assert no network.

  Feed provider/target errors, `dryrun show`, and `rule test-retained` hostile vectors through the compiled Rust command. Assert sanitisation, bounds, untrusted labelling, inert rendering and absence of a raw reply field in React props.
- [ ] **Step 2: Run focused failures.** Run `pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern='terminal-disclosure-preview'`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test b3_wire_contract --test preview --test untrusted_result`, and `pnpm --filter @agentcomms/desktop test -- --test-name-pattern='b3-terminal-fixture|control-contract|approval-renderer|untrusted-result-renderer|screen-contract|id-scope|purge-ui'`; expect missing generated/validated DTOs, renderers and screens.
- [ ] **Step 3: Implement the closed contract adapter and screens.** Generate or validate Rust DTOs from B3's checked artifact in `build.rs`; fail the build for a missing/version-mismatched artifact and do not hand-decode JSON. Map every table entry in C-8 to a closed non-secret enum and Rust control request. Render stable ids/version/digest and B3's source/health/lineage fields; never recompute channel vocabulary or present an alias as authority. Pass B3's pending activation-context selector only from the app approval screen. Implement no judge/hold/model behavior: render only the typed pre-E empty/unavailable and pre-E2 `E2_REQUIRED` states from C-8.
- [ ] **Step 4: Implement authoritative approval and the Rust safe result boundary.** Accept only id/digest/typed answer from the webview; call `approval view`, reject its typed stale/digest/challenge failures, render the returned structured fields as text-only Rust bytes, show its challenge, and call B3 approval. Implement `UntrustedAppResult` before any generic result crosses IPC: sanitise/bound provider/target errors, `dryrun show` and `rule test-retained`; return safe segments and stable codes only. Prevent HTML insertion and clickable links. Do not call core directly.
- [ ] **Step 5: Implement Settings and cancellation/cache rules.** Wire the Settings `open at login` toggle to the default-off desktop-only preference, retaining Task 4's startup-no-spawn invariant. On B3 disable/remove/drop/held-decision/dry-run result or session reconnect, invalidate matching in-memory rows and cancel stale promises. Use account/source stable ids for every selection and reject cross-scope response associations before painting.
- [ ] **Step 6: Add paired mutations.** Allow a D2 operation through generic control; remove the schema operation/vector or validate against a stale Rust type; render `previewFromWebview`; skip `approval view`/challenge validation; remove a control-character neutralisation; make a link clickable; raw-forward an untrusted error, dry-run or retained-test reply; omit one fixture screen item; enable login startup to spawn; remove id/version/account/source association; retain a disabled row/reveal promise. Each must fail its uniquely named production adapter/renderer/screen test.
- [ ] **Step 7: Run focused checks.** Run the commands in Step 2, `node apps/desktop/test/mutations/run.mjs --group task-5`, and `pnpm verify:reference` (C must not alter generated daemon references); normal tests pass and every mutation fails.
- [ ] **Step 8: P1-only review and commit.** Review B3 schema generation/validation, enum exhaustiveness against capability rows, actual terminal/Rust fixture byte equality, authoritative `approval view`, safe-result raw-forward resistance, every D13 matrix row, open-at-login no-spawn, scope association and no offline queue. Commit `feat(desktop): add typed control and approval screens`.

**Required mutations:** `desktop-b3-wire-contract`, `desktop-no-secret-generic-dispatch`, `desktop-approval-authoritative-preview`, `desktop-preview-controls`, `desktop-preview-links`, `desktop-untrusted-result-raw-forward`, `desktop-untrusted-result-bounds`, `desktop-screen-contract-completeness`, `desktop-settings-autostart-no-spawn`, `desktop-id-scope`, `desktop-purge-ui-orphans`.

### Task 6 — privileged secret window, complete D2 operation bridge, and per-window command proof

**Risk:** highest. This is the sole webview path that carries secret bytes.

**Files:**

- Modify: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/security.rs`, `apps/desktop/src-tauri/src/control/types.rs`, `apps/desktop/src-tauri/capabilities/settings.json`, `apps/desktop/src-tauri/capabilities/secrets.json`, `apps/desktop/secrets.html`, `apps/desktop/src/secrets-main.tsx`, `apps/desktop/package.json`, `apps/desktop/test/mutations/manifest.json`
- Create: `apps/desktop/src-tauri/src/control/secret_window_capability.rs`, `apps/desktop/src-tauri/src/commands/secrets.rs`, `apps/desktop/src/secrets-app.tsx`, `apps/desktop/src/secret-form-state.ts`, `apps/desktop/src-tauri/tests/secret_boundary.rs`, `apps/desktop/src-tauri/tests/secret_audit.rs`, `apps/desktop/test/secret-window.test.tsx`, `apps/desktop/test/secret-trace.test.mjs`, `apps/desktop/test/secret-audit-shape.test.mjs`, `apps/desktop/test/e2e/capability-probe.mjs`

**Interfaces:**

- Produces exactly eight Rust command families corresponding one-for-one to the D2 list in C-8; each is registered in `AppManifest::commands` and granted only to label `secrets`.
- Produces an opaque `SecretWindowCapability` only after Rust verifies the native `secrets` label; B3 verifies it is bound to the control session, operation and nonce. An app/window-origin string never authorises a secret request.
- Produces B3's typed secret result variants: acknowledgement, one `RevealOnce { material }`, `UrlFingerprint { scheme, host, port, sha256 }`, and B3's non-secret migration-status result. `material` is serialised only on the one secrets response.
- Consumes the exact B3 audit-row schema for all eight operations: `{ operation, id?, version?, outcome, time }`, where `id`/`version` occur only where applicable; no other key or nested object is permitted.

- [ ] **Step 1: Write failing capability, byte-trace, audit-shape and close-race tests.** Inspect generated command manifest/capability JSON and invoke every command by raw name from `settings`, `secrets` and a synthetic third label. Send a raw D12 request with a forged `secrets`/app label and require B3's pre-capability stable unavailable result; then require only the native `secrets` path with a valid Rust-issued capability succeeds for the matching D2 operation. Place a unique synthetic sentinel in each hidden entry/generated response and scan Tauri IPC logs/test traces, all control replies to non-secret surfaces, preferences, audit capture, SQLite/WAL fixture scans and frontend state snapshots; allow exactly one secrets request/one reveal result pair. For target secret create/rotate, target URL set, subscriber token create/rotate, judge key set/rotate and migration, assert the authoritative audit row has exactly the allowed key set above; mutate capture rows that add `host`, `fingerprint` or `secretReference` and require failure. Exercise submit/close/blur/navigation failure races and actual `secrets` IPC under Task 2's intersected CSP.
- [ ] **Step 2: Run focused failures.** Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test secret_boundary --test secret_audit`, `pnpm --filter @agentcomms/desktop test -- --test-name-pattern='secret-window|secret-trace|secret-audit-shape'`, and `pnpm --filter @agentcomms/desktop test:e2e -- --case capabilities`; expect no secret commands/boundary implementation.
- [ ] **Step 3: Implement the complete closed secret set and capability before app origin.** Keep B3's terminal-only behavior until `SecretWindowCapability` verifies the native `secrets` label and binds the opaque capability to the current daemon session, exact D2 operation and single nonce; raw control cannot choose or replay it. Only then register and map target signing create/rotate, secret URL set, subscriber token create/rotate, judge key set/rotate and backend migration directly to B3. Enforce create-versus-rotate preconditions only through B3 results; do not invent slot state. Make hidden fields non-argv/non-URL/non-clipboard inputs. Use short-lived zeroizing Rust values, do not log errors containing values, return only D2's permitted one-time/fingerprint/nonsecret result, and validate the exact audit row before presenting operation completion.
- [ ] **Step 4: Install non-overlapping capabilities.** Remove every secret/general/approval command from `settings`; give `secrets` no generic control, approval, filesystem, shell, dialog, clipboard, HTTP, opener or window creation capability. Declare all custom commands via `AppManifest::commands`; capability access is label-specific even for a raw invoke name.
- [ ] **Step 5: Finish lifecycle clearing.** Clear JavaScript state on submit, close, blur and navigation failure; close/clear Rust pending result and unused capability nonce on every secrets-window lifecycle event; do not rehydrate secret input/reveal state. Maintain Task 2's exact intersected secrets CSP and prove the actual allowed secret IPC still works.
- [ ] **Step 6: Add paired mutations.** Grant one secret command to `settings`, omit the app command manifest, accept a forged label/capability or replay a nonce, route a secret through generic control, leave a sentinel in state/log, echo URL/key input, retain reveal after close, or add `host`, `fingerprint` or `secretReference` to an audit row. Every case must fail the named direct-invocation/capability/trace/audit/race test.
- [ ] **Step 7: Run focused checks.** Run the Step 2 commands and `node apps/desktop/test/mutations/run.mjs --group task-6`; all normal cases pass and each mutation fails. The production-webview capability probe must run on every CI OS.
- [ ] **Step 8: P1-only review and commit.** Review the exact D2 operation inventory, terminal-only-before-capability rule, non-forgeable native capability binding, generation/reveal response handling, absence from generic command/capability, command-manifest labels, actual secrets CSP IPC, sentinel trace, clear-on-close path and every exact audit-row shape. Commit `feat(desktop): isolate human-only secret operations`.

**Required mutations:** `desktop-secret-capability`, `desktop-secret-forged-window-label`, `desktop-secret-capability-replay`, `desktop-secret-app-manifest`, `desktop-no-secret-generic-dispatch`, `desktop-secret-trace`, `desktop-secret-no-echo`, `desktop-secret-close-race`, `desktop-secret-audit-host`, `desktop-secret-audit-fingerprint`, `desktop-secret-audit-reference`.

**Batch 4 verification:** run `pnpm verify`, `pnpm verify:parity --strict`, and the B3 secret-operation focused tests. Passing means C consumes, but does not change, each B3 operation/exception; no non-secrets window can invoke or observe a secret command.

## Batch 5 — phase seams and release audit

### Task 7 — full cross-platform gate, E/E2 seam audit, release-hold audit, and hand-off

**Risk:** high. Integration is where a screen can quietly bypass a capability or a release workflow can ship a bundle that omitted its safety contract.

**Files:**

- Modify: `apps/desktop/README.md`, `apps/desktop/RELEASE_NOTES.md`, `docs/RELEASING.md`, `CHANGELOG.md`, `.github/workflows/desktop.yml`, `.github/workflows/desktop-release.yml`, `apps/desktop/test/mutations/manifest.json`
- Create: `apps/desktop/test/full-flow.test.mjs`, `apps/desktop/test/e2e/full-production-probe.mjs`, `apps/desktop/test/e2e/fixtures/daemon-control-peer.mjs`, `apps/desktop/test/e2e/fixtures/no-egress-sentinel.mjs`, `apps/desktop/test/bundle-content-graph.test.mjs`, `test/desktop-release-hold.test.mjs`

**Interfaces:**

- Produces the documented E/E2 UI DTO seam and final CI/release evidence; it introduces no future phase operation.
- Confirms `@agentcomms/events` and `@agentcomms/events-daemon` remain held and desktop remains non-npm-published.

- [ ] **Step 1: Write failing full-flow, bundle-graph and release-hold tests.** Drive the packaged app through the real Rust command paths against a local scripted D12 peer/B3 stand-in that validates received operation frames, not a test-local state model. Cover protocol negotiation; profile-pinned tray hide/quit/keep/login-no-spawn; no-egress attacks from both windows; approval hostile fixture; safe hostile provider/target/dry-run/retained-result rendering; all B3 non-secret operation mappings; pending activation-context test selection; all D2 secret denials/allowed capability pair; unavailable E/E2 states and progress transitions; stale/purge cancellation; tag/release notes/hash assertions. Generate a packaged-content manifest (digest, executable/type metadata and dependency provenance) plus resolved Cargo/pnpm/Vite/Tauri build graph; allow only declared desktop assets/libraries and reject a Node runtime or daemon entry, `node:` edge, ONNX binary signature/metadata, worker or model artifact even when renamed. Assert event packages' holds and `scripts/packages.mjs` remain unchanged.
- [ ] **Step 2: Run focused failures.** Run `pnpm --filter @agentcomms/desktop test -- --test-name-pattern='full-flow'`, `node --test test/desktop-release-hold.test.mjs`, and `pnpm --filter @agentcomms/desktop test:e2e -- --case full-production`; expect missing end-to-end gate/evidence.
- [ ] **Step 3: Implement the integrated gate.** Reuse production adapter/renderer/capability modules and sealed fake peer; do not add a parallel UI model. Add test-only peer journals that prove every actual control frame excludes token/secret data from the wrong surface and every external request attempt reaches zero on the trap. Produce the content manifest and resolved Cargo/pnpm/Vite/Tauri dependency graph from the actual release bundle; enforce its allowlist and reject Node runtime/daemon entry, Node builtin edge, ONNX binary/content marker, Laya worker and model artifact by content/metadata as well as name. Check held-package release-list changes.
- [ ] **Step 4: Make the workflow run the whole evidence set.** Add the full probe/mutation runner to each OS desktop workflow leg, archive only synthetic test journals/artifact hashes on failure, and have the release workflow run exactly the same matrix before packaging. Keep release notes/manual first-launch text synchronized by test, not duplication by trust.
- [ ] **Step 5: Add final paired mutations.** Make one full-flow case use its support fake directly rather than the adapter, remove an E2 unavailable reason, add a renamed Node runtime/daemon entry, a `node:` dependency edge, renamed ONNX binary metadata, worker or model-content fixture to the package manifest/graph, lift a daemon hold, or skip a named mutation case. Each must fail its own integration/hold test.
- [ ] **Step 6: Run final focused and full checks.** Run `pnpm --filter @agentcomms/desktop test`, `node apps/desktop/test/mutations/run.mjs --all`, `node --test test/desktop-workflows.test.mjs test/desktop-release-hold.test.mjs`, then `pnpm verify`. In CI, require the full `desktop.yml` matrix to pass macOS, Windows and Linux; the release workflow remains unrun until a `desktop-v*` tag.
- [ ] **Step 7: P1-only review and commit.** Review only integrated boundaries: B3 frame mapping, secret trace, egress journal, platform result, content/graph bundle exclusion, holds and forced prerelease. Commit `test(desktop): gate packaged app and release boundary`.

**Required mutations:** `desktop-production-path`, `desktop-e2-seam-reason`, `desktop-bundle-content-dependency-graph`, `desktop-release-hold`, `desktop-mutation-completeness`.

**Batch 5 verification:** run `pnpm verify`; passing means all root checks are green. CI evidence additionally requires the three-platform desktop workflow (fmt, clippy, Cargo test, unsigned build, actual bundled egress/capability probe) and all destructive mutations to be red in their isolated runs.

## §5 coverage ownership

| §5 row / C-owned assertion | Sole task owner |
|---|---|
| Control protocol negotiation/authentication/error shape, profile-pinned attach/spawn, secure preferences and desktop protocol compatibility; unconditional pre-read Windows refusal | Task 4 |
| B3 wire-schema drift, hostile shared fixtures through B3's production terminal and Rust renderers, authoritative preview/digest/challenge rejection, safe untrusted errors/dry-runs/retained tests, and every D13 screen item | Task 5 |
| Per-window commands, raw forged-window capability refusal, every non-`secrets` secret-command denial, one allowed secret IPC argument/result pair only, and exact D2 audit-row shape | Task 6 |
| Built production app from every window blocks fetch/XHR/WebSocket/EventSource/beacon/passive image/CSS/form/navigation/script/frame/download/custom-protocol/new-window egress while IPC works | Task 2 |
| Desktop workflow runs fmt, warning-denied clippy, Cargo test and unsigned build on macOS/Windows/Linux, and proves public CUE++ installation without a registry token | Task 3 |
| `desktop-v*` only, distinct from npm `v*`; forced prerelease; ad-hoc macOS + unsigned Windows assets/SHA-256; no signing secret; required first-launch text; no Linux release artifact | Task 3 |
| Built bundle content manifest and dependency graph lack Node runtime/daemon edges, ONNX Runtime, Laya worker/model; event daemon/library holds stay in place | Task 7 |
| B3's human-only secret operations are consumed only through their allowed desktop boundary; dryrun/retained output is safe-rendered; no MCP surface is added by C | Tasks 5, 6 |
| E hold-resolution/Judges and E2 enablement/progress display seams compile and present daemon-provided unavailable/progress state without future implementation | Task 5 |
| Structural test/mutation pairing, production-path enforcement, scope and orphaned-UI cancellation checks | Task 1 (checker), Tasks 4–7 (their listed cases) |

## Spec traceability

Every line below is normative for C. A semicolon-separated line range means the linked requirements are implemented together by one task and named test; no design decision is left without an implementation row.

| Spec section and line(s) | Requirement implemented | Task | Named proof |
|---|---|---:|---|
| D1 128-138 | Desktop presents/control surface only; no I/O/rule implementation | 1, 5 | `desktop-workspace-private`, `desktop-production-path` |
| D2 146-156, 187-205 | App may approve disclosure only through app challenge, never MCP/chat/core direct | 5 | `desktop-approval-authoritative-preview` |
| D2 471-495 | Closed human-only secret set, terminal/app boundary, non-forgeable app capability, reveal-once/no audit bytes and exact audit-row shape | 6 | `desktop-secret-window-capability`, `desktop-secret-trace`, `desktop-secret-audit-shape` |
| D3 667-669 | Provider/target errors are sanitised, bounded and rendered untrusted; stable codes/reason labels are not provider facts | 5 | `desktop-untrusted-result-renderer` |
| D10 2002-2017 | B3 operations use one daemon operation; complete versioned request/result/error wire contract | 5, 6 | `desktop-b3-wire-contract`, `desktop-secret-operation-inventory` |
| D10 2029-2033 | Retained rule test is terminal/app-only and safely rendered through the production safe app boundary | 5 | `desktop-untrusted-result-renderer` |
| D10 2049-2060 | No MCP secret/dryrun/resume/migration exposure; exceptions remain explicit | 5, 6 | `desktop-no-secret-generic-dispatch`, `desktop-capability-manifest` |
| D10 2066-2069 | App approval re-plans/rechecks through daemon operation | 5 | `desktop-approval-authoritative-preview` |
| D10 2071-2086 | Judge enable/disable/model and doctor state surface to app | 5 | `desktop-judge-seams` |
| D11 2100-2110, 2321-2329 | Judges off/daemon-owned; app shows only typed pre-E/E2 status and bundle content/graph contains no Laya/Node artifacts | 5, 7 | `desktop-judge-seams`, `desktop-bundle-content-dependency-graph` |
| D12 2352-2367 | Rust is authenticated versioned local protocol client; frame/error compatibility, one daemon profile and B1-G Windows support-matrix exception | 4 | `desktop-control-real-server-compat`, `desktop-frame-bounds`, `desktop-windows-pre-read-refusal`, `desktop-daemon-profile` |
| D12 2369-2372 | App uses instance ownership/stale status without replacing daemon recovery | 4 | `desktop-supervisor-attach` |
| D12 2374-2376 | Settings close/tray/quit/keep-collecting lifecycle | 2, 4 | `desktop-tray-lifecycle`, `desktop-supervisor-late-spawn` |
| D13 2583-2587 | Tauri v2/React/Vite/CUE++, tray, separate labelled windows, repository workspace | 1, 2 | `desktop-workspace-private`, `desktop-window-labels` |
| D13 2589-2616 | Overview through Settings screen inventory, login-only autostart, secret handoff, Judges/holds seams | 5, 6 | `desktop-screen-contract`, `desktop-settings-autostart-no-spawn`, `desktop-judge-seams` |
| D13 2618-2627 | `approval view`, authoritative preview, B3-terminal/Rust text-renderer fixture identity, typed challenge/app approval | 5 | `desktop-approval-authoritative-preview`, `desktop-b3-terminal-fixture` |
| D13 2629-2643 | Exact production CSP, asset modification, exact secrets meta-policy/intersection and working secrets IPC | 2 | `desktop-csp-exact`, `desktop-production-no-egress` |
| D13 2645-2648 | Pre-load navigation/new-window/download/custom-protocol denial; Rust-only control | 2, 4 | `desktop-navigation-denial`, `desktop-download-denial`, `desktop-custom-protocol-denial`, `desktop-new-window-denial` |
| D13 2650-2656 | Window-labelled, non-overlapping secret capability and AppManifest command declarations | 6 | `desktop-capability-manifest`, `desktop-capability-raw-invoke` |
| D13 2658-2665 | Only secret IPC pair, non-forgeable app capability, clear lifecycle; no logs/cache/telemetry/audit bytes | 6 | `desktop-secret-window-capability`, `desktop-secret-trace`, `desktop-secret-close-race` |
| D13 2667-2673 | Hostile preview and actual cross-platform built-webview attack matrix | 2, 5, 6 | `desktop-production-no-egress`, `desktop-approval-authoritative-preview`, `desktop-capability-raw-invoke` |
| D14 2677-2687, 2756-2763 | `apps/desktop` layout, workspace/build, independent version, root/CI checks all platforms and fork-safe public-registry install | 1, 3 | `desktop-workspace-private`, `desktop-workflow-matrix`, `desktop-workflow-no-registry-token` |
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
| Rust/control reviewer | Frame parser, endpoint/token handling, exact daemon profile, private/symlink/reparse/atomic preferences, protocol compatibility, supervisor epochs, child quit/detach, pre-read Windows refusal and login-no-spawn |
| Tauri security reviewer | Both full CSP directive sets/effective intersection/working secrets IPC, handler installation order, each native refusal, plugins, manifest/capability disjointness, raw command invocation, actual-webview trap journal |
| Approval/secret reviewer | B3 schema/vector contract, authoritative `approval view`/challenge, production-terminal/Rust fixtures, safe untrusted results, non-forgeable secret capability, reveal-once/Zeroizing/trace/exact-audit-shape, close/blur races |
| UI/state reviewer | Stable id/account/source associations, no re-derived channel vocabulary, cache/orphan cancellation, fixture-named D13 screen items and E/E2 seams |
| Release/CI reviewer | Workspace/private/package holds, all three CI legs, public-registry/no-token fork path, unsigned tag isolation, assets/hashes/notes, signing gate, content/graph bundle exclusion |
| Test-integrity reviewer | Every named test exercises production code, fixture/loopback seal use, one-to-one mutation manifest, each mutant actually red |

The phase cannot be handed off until every reviewer reports no P1, `pnpm verify` is green, all desktop matrix legs are green, and all mutation cases are demonstrably red under their individual test. Any reviewer finding a new recurring defect class adds an automatic test/mutation pair before approval; it is not left as reviewer memory.

### Pull-request payload and release status

The Phase C PR proposes version **`0.16.0-events-c`** (a minor change from root `0.15.2`: it adds an optional desktop product without breaking npm consumers). Its description carries:

1. what a person can do with the desktop app and how the daemon/secret boundary works;
2. the proposed semver and reason above;
3. focused tests, three-platform workflow evidence, `pnpm verify`, and each intentionally broken mutation;
4. README, release notes, RELEASING, reference/skills impact (no daemon CLI/MCP surface is added by C), and `CHANGELOG.md` under `Unreleased` describing the unsigned desktop prerelease;
5. provenance: this design/spec (read 2026-10-10) and the Tauri/CUE++ primary sources it records (checked by the spec's authors on the dates it gives, 2026-10-05/06; re-read by the builder only where a task says so, with the date), no live-provider testing, and AI assistance used for the plan/implementation as applicable; and
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

**Plan commit message:** `docs(plan): phase C — apply plan review`
