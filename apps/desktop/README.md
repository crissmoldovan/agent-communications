# Agent Communications desktop

This private workspace app is the Phase C Tauri v2 shell. Settings controls a separately installed local daemon;
the isolated Secrets window owns the eight human-only D2 operations. The two entry documents and native command
capabilities are separate. Secrets has no general control, approval, clipboard, filesystem, HTTP, or opener grant.

On Unix, secret operations require a daemon spawned by this desktop process. Rust generates an in-memory
32-byte key and transfers it once through an inherited pipe, never through arguments, environment material or
a file. Each operation needs a fresh nonce and HMAC bound to its authenticated session and exact operation.
Attaching to an existing daemon does not grant secret authority: use the terminal, or explicitly start a new
daemon through Settings. Windows continues to refuse daemon control before reading the profile.

Generated signing secrets and subscriber tokens are shown once. Hidden URL and judge-key entries are never
echoed; URLs return only a fingerprint. Submit, blur, close and rejected navigation clear secret-window state.
No secret input or reveal is persisted in preferences. The core audit envelope is unchanged; its D2 projection
is validated before app completion, with no secret-derived fields permitted in the underlying audit.

Run `pnpm --filter @agentcomms/desktop build`, `typecheck`, and `test` after installing the workspace dependencies. Native Tauri builds require the platform toolchain; the Cargo lockfile is checked in.
`test` skips the proofs that build or run Rust, so the repository's `pnpm verify` needs no Rust toolchain;
`pnpm --filter @agentcomms/desktop test:native` runs every test with them, once the locked crates are fetched (any
`cargo build` in `src-tauri` does that). The desktop workflow runs it on each operating system after its Rust gates.

The desktop workflow checks macOS, Windows and Linux with public, frozen pnpm dependencies, frontend checks,
Rust formatting, warning-denied clippy, Rust tests, the bundled actual-webview no-egress probe and an unsigned build.
Linux uses WebKitGTK 4.1, build-essential, curl, wget, file, libxdo, OpenSSL, librsvg, Ayatana AppIndicator, patchelf
and Xvfb development/runtime packages as listed in `.github/workflows/desktop.yml`; it uploads nothing.
Release notes are maintained in [RELEASE_NOTES.md](RELEASE_NOTES.md); third-party licence texts travel in the bundle.
The `full-production` probe combines production adapter/native B3 frames with the actual webview egress and
capability probes. Its synthetic journal records only operation names, counts and artifact digests. The bundle
gate records packaged file hashes, executable/type metadata and Cargo/pnpm/Vite/Tauri provenance; renamed Node,
daemon, ONNX, worker or model payloads and Node builtin edges fail the gate. It requires an actual release bundle.
Run `pnpm --filter @agentcomms/desktop test:e2e -- --case full-production` under the loopback seal (and Xvfb on Linux).

The CI native lane also uses Xvfb on Linux. Mutation cases declare their platform applicability; Unix-only owner
proofs are explicitly reported as **not applicable, not killed** on Windows, whose refusal proof still runs. Task 7
mutants build into their temporary copy with isolated frontend output, preferences, home and evidence.

For an auditable local package, wrap the ordinary build command:
`node apps/desktop/scripts/bundle-with-evidence.mjs -- pnpm --filter @agentcomms/desktop tauri:build --no-sign --bundles app`.
The wrapper creates a fresh build identity and a digest-bound `release/desktop-artifact-evidence.json` accompaniment.
The audit reads that same-build Vite graph, not the current checkout's dist, and rejects changed or unbound artifacts.
Vite classifies complete frontend asset bytes before embedding; the wrapper rechecks the final output inventory,
digests and classifications. The bound audit rejects model/runtime payloads even when Tauri compresses them inside
the native executable. Evidence contains safe metadata, not asset payload bytes.
Universal macOS evidence resolves both aarch64 and x86_64 Cargo graphs. Unexpected helper executables remain a
release blocker; the content allowlist is not an exception mechanism.
The release workflow calls the same three-platform workflow before packaging. Local success alone is not matrix evidence.

The pre-E display accepts daemon-provided unavailable/empty holds and Judges state. Pre-E2 model state remains
`E2_REQUIRED`, with its explicit reason. No future operation, network call, model, worker or activation pointer is
implemented in this phase. A future progress DTO must pass the versioned daemon contract before it can render.
`THIRD_PARTY_LICENSES` was generated offline from `pnpm-lock.yaml`, installed runtime dependencies and peers,
and every registry crate in `src-tauri/Cargo.lock`, with source/version/licence provenance. Its missing-text section
identifies 37 upstream crate archives whose licence grants need to be obtained and reviewed before distribution.

## Before installing

This unsigned prerelease is for the owner and a few named colleagues. It requires a separate daemon installation
and a compatible local event daemon; the desktop does not bundle or install that daemon. Starting it requires
an explicit Settings action.
The event library and daemon remain held from npm release. Obtain the checked daemon build from the maintainer;
do not interpret a desktop tag as lifting those holds. An attached daemon remains terminal-only for secret operations.

Download the artifact and `SHA256SUMS` from the same `desktop-v<version>` prerelease. Before opening or installing,
compute its SHA-256 and compare the complete hexadecimal result with the line for that exact filename in
`SHA256SUMS`. Stop if they differ. The checksum detects mismatched or corrupted downloads; it is not publisher
code signing.

On macOS:

```sh
shasum -a 256 desktop-macos-universal.app.zip
```

On Windows (PowerShell):

```powershell
Get-FileHash .\desktop-windows-x64-setup.exe -Algorithm SHA256
```

## macOS first launch

Extract the universal app ZIP, move Agent Communications.app to Applications, open the app once and dismiss the
warning. In **System Settings**, **Privacy & Security**, under Security, choose **Open Anyway** (offered for
about an hour after that attempt) and enter the login password. A new version may need the same step again.
The app is signed ad hoc, as Apple silicon requires, and is not notarised.

## Windows first launch

Run the x64 NSIS installer. At **Windows protected your PC**, choose **More info**, then **Run anyway**.
Each new unsigned version starts with no SmartScreen reputation, so this step can recur. Enterprise policy can
remove the choice. Windows 11's Smart App Control blocks unsigned files with no reputation: a machine with it on
cannot run version 1. Do not disable organizational or operating-system protections to install it.

## Version 1 distribution limits

There is no in-app updater; download and install each new version by hand and compare its checksum again.
There is no Linux version-1 artifact, although Linux must pass the same CI build and webview gates.

Any wider release beyond the owner and named colleagues, including a non-prerelease, a link outside that group,
a store listing or an auto-update, first requires an Apple Developer ID signature: notarise and staple the macOS
bundle, and sign Windows with a code-signing certificate. Those future credentials belong only in a protected
release environment. The current workflows contain no signing credentials and can publish only a prerelease,
never mark it latest.
