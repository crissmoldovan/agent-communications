# Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent Comms, a Tauri v2 tray app. It shows this machine's agent-communications: accounts, approvals waiting,
what agents may do, standing approvals, updates, the events service and the doctor.
- It applies tightenings and revocations at once.
- It sends anything needing approval to the system terminal.
- It never sends, posts or approves.

**Architecture:**
- **Core** gains `update --status`, and `doctor --json` prints one envelope.
- **Rust** runs the installed CLIs with no shell, through a typed allow-list, behind thirteen commands.
- **The shell** is Supbuddy's.
- **The UI** is `@cueplusplus/ui` 0.29, used the way QuotaMate uses it.
- **Releases** follow the siblings': macOS is signed on the owner's Mac; Windows and Linux are unsigned, from CI.

**Tech Stack:**
- **Rust:** Tauri 2.12 (`tray-icon`, `image-png`).
  - Plugins: single-instance 2.5 (`deep-link`), deep-link 2.6, updater 2.14, opener 2.7, clipboard-manager 2.5, and
    autostart 2.7 except on macOS.
  - On macOS, `objc2` 0.6 and `objc2-service-management` 0.3.
  - Also `ureq` 3, `regex` 1, `semver` 1, serde, and `tempfile` 3.
- **UI:**
  - React 19.3, Vite 8.3, `@vitejs/plugin-react` 6, Tailwind 4.3 (`@tailwindcss/vite`).
  - `@cueplusplus/ui` and `@cueplusplus/tokens` 0.29.0, `@cueplusplus/theme-cue` and `@cueplusplus/theme-terminal`
    1.1, public on npm with no token.
  - `@base-ui/react` 1.9, `lucide-react` 1.59, `@tauri-apps/api` and `@tauri-apps/cli` 2.12, and zod (catalog).
- **Tests:** Vitest 5, `@testing-library/react` 16, jsdom, `@playwright/test` 1.64.

**Spec:** `docs/superpowers/specs/2026-10-19-desktop-app-design.md` (DA1–DA14; §5 is the later word), and
`AGENTS.md`.

**Before Task 1:** rebase `feat/desktop` onto `main` at 0.23.0, which has `behaviour`, `profile` and `standing`. The
app comes after 0.23.0 (DA12).

## Global Constraints

- **Never:**
  - send, post or approve from the app;
  - run a change with `--approval`, or `approve` outside a terminal the person types in (DA10);
  - pass an argument the allow-list did not build;
  - start a shell for the app's own calls (argv goes to `std::process::Command`). The only line a shell reads is the
    one `terminal.rs` quotes for DA6.
  - load remote content: no `fetch`, no URL in `dist` HTML or CSS, and no `@tauri-apps/plugin-*` npm package;
  - render text as HTML or Markdown: no `dangerouslySetInnerHTML`, `innerHTML` or `@cueplusplus/ui/elements`;
  - give `ThemeProvider` `overrides`, whose `<style>` the CSP refuses;
  - handle a secret: sign-ins are Run in Terminal, CLI stdout is never logged, and tokens are never printed;
  - put an absolute machine path in a repository file (fixtures use `/home/example`, `/Users/example` and
    `C:\Users\example`);
  - let a test touch the network, a real account or the real home.
- **Windows-safe:**
  - Rust builds paths as strings with the target platform's separator, so a forced platform behaves the same on any
    host;
  - a test a host cannot run is skipped (`skipIf(process.platform === 'win32')`, `#[cfg(unix)]`), saying why.
- **The guards:**
  - `test/printed-command-construction.test.mjs` does not scan `apps/`: its `runtimeSources` reads only
    `packages/<name>/src/**/*.ts` (`test/helpers/printed-command-guard.mjs:148-160`).
  - So every command the app runs or shows starts with a launcher path that Rust located.
  - `src/test/repo-rules.test.ts` scans `src/**/*.{ts,tsx}` and `src-tauri/src/**/*.rs` as text for a
    `suiteFacts(ROOT).binaries` entry followed by whitespace, and for `npx` before `@agentcomms/`. Its only exemption
    is `INSTALL_COMMAND` (`src/install.ts`), which is pinned to `README.md:100`.
- **Folders:**
  - Every call but `--version` ends with `--config-dir <c> --state-dir <s> --data-dir <d> --secrets-dir <x>`.
  - Settings overrides act as `AGENT_COMMS_CONFIG_DIR`, `AGENT_COMMS_STATE_DIR` and `AGENT_COMMS_DATA_DIR` would.
- **The commands,** each permitted as `allow-<name>`: `installation`, `cli`, `open_in_terminal`, `copy_text`,
  `open_link`, `open_profile`, `get_settings`, `set_folders`, `set_login_item`, `updater_state`, `check_for_updates`,
  `install_update` and `take_deep_link`.
- **The allow-list.** `--json` and the pins follow the words. "Needs" is the minimum CLI version (DA12).

  | `kind` and fields | Launcher and words | Shape | Needs |
  |---|---|---|---|
  | `version {product}` | any: `--version` alone, without `--json` or pins | version line | — |
  | `approvalsPending` | core `approvals list --state pending` | envelope | — |
  | `approvalRevoke {approvalId}` | core `approvals revoke <id>` | envelope | — |
  | `updateStatus` | core `update --status` | envelope | 0.24.0 |
  | `updatePause {days: 1\|7\|14}` / `updateResume` | core `update --pause <days>` / `update --resume` | envelope | — |
  | `updateLevel {level}` | core `update --level auto\|every-14-days\|never` | envelope, prepares | — |
  | `updateRollback` | core `update --rollback` | envelope, prepares | — |
  | `updateBackgroundJob {on}` | core `update --background-job on\|off` (`on` prepares) | envelope | — |
  | `doctor {product}` | core and gmail `doctor`; slack and resend `doctor --offline`; whatsapp `status`; events-daemon `doctor` | envelope (events: bare) | — |
  | `accounts {product}` | gmail `inbox list`, slack `workspace list`, resend `account list` | envelope | — |
  | `label` | core `label` | envelope | — |
  | `behaviour` | core `behaviour` | envelope | 0.22.0 |
  | `behaviourAllow {account, acts, conversation?}` | core `behaviour allow <account> <acts> [--conversation <id>]` | envelope, prepares | 0.22.0 |
  | `behaviourClear {account, conversation?}` | core `behaviour clear <account> [--conversation <id>]` | envelope, prepares | 0.22.0 |
  | `profileView {account}` / `profileInit {account?, conversation?}` | core `profile <account>` / `profile init [<account>] [--conversation <id>]` | envelope | 0.22.0 |
  | `standingList` / `standingRevoke {id}` / `standingOff` | core `standing list` / `standing revoke <id>` / `standing off` | envelope | 0.23.0 |
  | `eventsStatus` / `eventsPause` / `eventsResume` / `eventsRules` / `eventsDeliveries` | events-daemon `status` / `pause` / `resume` / `rules list` / `deliveries list` | bare | — |

  - `doctor` and `accounts` refuse any product not listed for them.
  - Every call sets `NO_COLOR=1`, and every call but `doctor` and `updateStatus` sets `AGENT_COMMS_UPDATE_CHECK=off`.
  - A call times out after 30 seconds (90 for `doctor`), and stdout is capped at 8 MiB.
  - On Windows, Node runs the launcher as its first word, with `CREATE_NO_WINDOW`.
- **Grammars:** `apps/desktop/grammar.json` holds these, and Rust and TypeScript both read it.

  | Name | Source |
  |---|---|
  | `approvalId` | `packages/core/src/ids.ts:14` |
  | `alias` | `config.ts:41` |
  | `name` | `name-grammar.ts:46`, without its look-ahead, plus the reserved words at `:19` |
  | `slackConversation`, `mailConversation` | `operations/label.ts:73,75` |
  | `acts` | `none`, or a comma list without repeats of `post`, `reply`, `reaction`, `edit`, `delete`, `file`, `send` |

  A value is refused if it is empty, starts with `-`, has a control character, or runs past 320 characters.
- **Copy:**
  - `src/copy.ts` holds the sections Overview, Accounts, Approvals, Agent, Updates, Events and Doctor, then Settings.
    It also holds `Approve this in Terminal`, `Approve in Terminal`, `Run in Terminal`, `Revoke`, `Copy`,
    `Update agent-communications to use this` and `End every standing approval`.
  - `tray.rs` holds `Open`, `Pause update notices for a day`, `End every standing approval`, `Check for Updates…` and
    `Quit`.
- **cue-ui:** use only its components, by the rules of the `cue-ui` and `cue-ui-forms` skills.
- **Identity:**
  - `com.cueplusplus.agentcomms`, shown as `Agent Comms`;
  - npm `@agentcomms/desktop`, `"private": true`, with its version synced;
  - crate `agentcomms-desktop` at `0.0.0`.
- **Version:** 0.24.0 (minor).

## Where the design is silent or the code disagrees (the plan's calls)

1. **The channels have no `approvals list`.** Core's lists the one shared store
   (`packages/core/src/operations/maintenance.ts:849`). Every channel writes there, for example
   `packages/gmail/src/operations/send.ts:888`. So the app polls only core.
2. **Windows has no managed receipt** (`packages/core/src/managed-shims.ts:88-92`).
   - The app reads Node from the Windows launcher's second line (`launcher.ts:436-437`), and Task 2 pins that line.
   - The fallback is `node.exe` on `PATH`.
3. **`PATH_OPTIONS` has five folders** (`paths.ts:7-13`), but DA12 says four. Downloads comes from the home folder,
   which the app and the CLI share.
4. **`@cueplusplus/ui` 0.29 needs a theme stylesheet and `themes`,** so the "two-line" stylesheet takes four lines.
   - The `cue-ui` skills document 0.1.0, whose density names differ.
   - The appearance menu offers `cue` and `terminal`, the `DENSITIES` from `@cueplusplus/tokens`, and dark, light or
     system.
5. **GitHub's Latest release is the CLI's** (`release.yml:323`). So the updater finds `desktop-v*` releases through the
   API, and desktop releases pass `--latest=false`.
6. **Events takes `--version` only as its sole argument** (`packages/events-daemon/src/cli/program.ts:193`), and its
   failures come as stderr text (`:732-740`).
7. **Core's `doctor --json` matches the channels':** one ok envelope, then exit 78
   (`packages/gmail/src/cli/program.ts:2541-2556`, `packages/slack/src/cli/program.ts:988-1003`).
8. **Plugins run from Rust; the capability file grants none.**
   - Notifications (DA7) are omitted, since nothing in v1 raises one.
   - The clipboard is added.
   - Single-instance is added, for deep links on Windows and Linux.
   - The opener may open `<config>/compose/` profiles.
9. **The count** shows in the tray title on macOS and Linux, and in the tooltip on Windows.
10. **`createUpdaterArtifacts` stays false,** so unsigned CI builds pass. The release script sets it with `--config`.
11. **The CLI does not print the deep link.** DA2 only says it "may".
12. **The bundle check is smaller than phase C's.** Phase C audited a content graph for a bundled daemon. Here
    `bundle-check.mjs` checks that same promise (no external binary, no resources), plus the CSP pin and the absence of
    remote URLs.

## Review Focus

1. **Not installed** (no `<data>/launch/core`): only the install screen shows, and no `cli` call is made.
   - Task 4: `discover_reports_not_installed_without_launch_core`.
   - Task 5: `with no core launcher only the install screen shows and nothing runs`.
2. **A 0.21.0 CLI:** every gated section says `Update agent-communications to use this`, and calls nothing.
   - Task 5: `a 0.21.0 CLI gets the update line in every gated section and none of their calls`.
3. **`AGENT_COMMS_*` folders a Dock launch cannot see:** a config override takes state and secrets with it, and every
   call carries the four pins.
   - Task 4: `settings_overrides_act_as_the_environment_variables` and `every_call_ends_with_the_four_pins`.
4. **A hostile preview** (`<img src=x onerror=alert(1)>`, `</untrusted-content>`, `[x](https://evil)`, an RTL override,
   a newline) renders as text.
   - Task 5: `UntrustedText renders hostile text as text`.
   - Task 8 (e2e): `a hostile approval renders as text`.
5. **Linux without `x-terminal-emulator`, `gnome-terminal` or `konsole`:** the command is copied, and the app says so.
   - Task 6: `linux_with_no_terminal_app_copies_the_command`.
   - Task 5: `TerminalResult says the command was copied`.

---

## Phase 1: contracts. Two workers in parallel: A runs Tasks 1 and 2; B runs Tasks 3, 4 and 5

### Task 1: `update --status` and `comms_update` `status: true`

**Files:**
- Create: `packages/core/src/operations/update-status.ts`, exported from `src/index.ts` beside `update-settings`.
- Modify:
  - **`src/cli.ts`:**
    - a `status` boolean, counted among the update modes; `--approval` with it is `USAGE`;
    - the HELP line `update --status`, "where updates stand here: level, pause, last check, latest and running
      versions, and the background job; asks npm nothing".
  - **`src/render.ts`:** `renderUpdateStatus(status: UpdateStatus): string`, a `key value` line per field.
  - **`src/mcp/server.ts`:**
    - `status: z.literal(true).optional()`, counted in `modes`, refusing `approvalId` as `check` does;
    - the instructions end ``comms_update with `check` or `status`.``.
  - **`capabilities.json`:** after `core.update.background`, the row
    `{"id":"core.update.status","package":"core","cli":"update","mcp":"comms_update","status":"both",
    "operation":"updateStatus","argv":["--status"],"args":{"status":true},"reason":"Where updates stand here, read
    from local files, asking npm nothing (desktop design DA13)."}`.
  - **`skills/comms-update/SKILL.md`:** the row ``| Where updates stand | `agentcomms update --status` |``.
  - **`docs/reference/*`:** regenerated by `pnpm sync:reference`.
- Test: `packages/core/test/update-status.test.ts`

**Interfaces:**
- **Consumes:** `effectiveUpdates`, `readUpdateCheck`, `countedLatest`, `pauseEnd`, `securityRelease`,
  `updateJobContext`, `inspectUpdateJob(…, { query: 'when-recorded' })`, `updateJobHealth` and `updateJobSupported`.
- **Produces:**
  ```ts
  export interface UpdateStatus {
    level: UpdateLevel; set: UpdateLevel; by: EffectiveUpdates['by'];
    cap: { level: 'every-14-days' | 'never'; organisation: string } | null;
    pausedUntil: string | null; lastChecked: string | null; latest: string | null; running: string;
    security: string | null; lastError: string | null;
    job: { state: UpdateJobState | 'unsupported'; where: string | null; installedAt: string | null;
      lastRun: string | null; working: boolean | null };
  }
  export async function updateStatus(core: Core, env: NodeJS.ProcessEnv,
    options?: { platform?: NodeJS.Platform; job?: UpdateJobDeps; now?: () => Date }): Promise<UpdateStatus>;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `status reads level, pause, last check, latest and running from local files`: seed `update-check.json`, set level
    `every-14-days`, and expect `running === VERSION`.
  - `status asks npm nothing`: CLI and MCP each succeed with a registry whose every method throws.
  - `status says where the background job stands`:
    - an injected `UpdateJobDeps` with a marker gives `installed` and its `lastRun`;
    - `win32` with nothing recorded gives `not-set-up`.
  - `an environment switch is what decided the level`: `AGENT_COMMS_UPDATES=never` gives `by: 'AGENT_COMMS_UPDATES'`.
  - `--status is one mode at a time and takes no approval`: `--status --check`, `--status --approval ap_…`, and MCP
    `status` with an `approvalId` each exit 64.
  - `the CLI and MCP give the same result`, as the `label` parity tests do.
- [ ] **Step 2:** run `pnpm --filter @agentcomms/core exec node --experimental-strip-types --test
  test/update-status.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement, then `pnpm sync:reference`.
- [ ] **Step 4:** run the test, `test/core-server.test.ts`, `test/update.test.ts` and `pnpm verify:parity --strict`.
  Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): agentcomms update --status and comms_update status say where updates stand, asking npm nothing`.

### Task 2: `doctor --json` prints one envelope; contracts the app reads

**Files:**
- Modify:
  - `packages/core/src/cli.ts`, case `doctor`. With `--json` and a failing report, write the ok envelope once, set
    `softExit = EXIT_CODES.CONFIG`, and don't throw. Without `--json`, keep today's behaviour.
  - The comment at `test/cli.test.ts:1163-1165`, which now describes one line.
  - Export `SLACK_CONVERSATION` and `MAIL_CONVERSATION` from `src/operations/label.ts:73,75`.
- Test: `packages/core/test/doctor-json.test.ts`, `packages/core/test/launcher-windows-header.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `doctor --json with a failing check prints exactly one envelope and exits 78`. Use a `config.json` of `{ not json`,
    which fails `config` on every platform. Expect one stdout line, `ok: true`, and `data.ok: false`.
  - `doctor without --json still says doctor found problems and exits 78`.
  - `comms_doctor returns the report unchanged`.
  - `the Windows launcher names its Node on its second line, as JSON`:
    - call `writeLauncher(temp, 'core', 'C:\\Program Files\\nodejs\\node.exe', { platform: 'win32' })`;
    - line 2 must match `/^\/\/ updates; do not edit\. Started by ("(?:[^"\\]|\\.)*") with this file as its first word/`,
      and its group must parse to that path;
    - a comment names `apps/desktop/src-tauri/src/launchers.rs` as the reader.
- [ ] **Step 2:** run both. Expected: the doctor test FAILS. The header test PASSES, because it pins today's behaviour.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them with `test/cli.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `fix(core): doctor --json prints one envelope when a check fails, as the channels' doctors do`.

### Task 3: The scaffold, its content policy and its guards

**Files:**
- Modify:
  - **`pnpm-workspace.yaml`:**
    - add `- apps/*`;
    - set `allowBuilds: { esbuild: false }`, plus `false` for each other ignored build script that `pnpm install`
      lists.
  - **Root `package.json`:** `build`, `typecheck` and `test` add `--filter "./apps/**"`.
  - **`.gitignore`:** `apps/desktop/src-tauri/{target,gen}/` and `apps/desktop/{test-results,playwright-report}/`.
  - **`scripts/sync-versions.mjs`:** also writes the version into `apps/desktop/package.json`, and into the first
    `"version"` of `apps/desktop/src-tauri/tauri.conf.json`, as text, as it does for the plugin manifest.
- Create in `apps/desktop/`:
  - **`package.json`:** the Tech Stack dependencies, and these scripts: `dev` (`vite --port 1420 --strictPort`),
    `build`, `typecheck` (`tsc -p tsconfig.json`), `test` (`vitest run`), `test:e2e` (`playwright test`), `tauri` and
    `check:bundle` (`node scripts/bundle-check.mjs`).
  - **`tsconfig.json`:** standalone. Use `moduleResolution` bundler, `jsx` react-jsx, the DOM libs, and the base's
    strict flags except `isolatedDeclarations`.
  - **`index.html`:** `<title>Agent Comms</title>`, `#root` and `/src/main.tsx`. No inline script.
  - **`vite.config.ts`:**
    - `react()`, `tailwindcss()`, and `prepaint()`. `prepaint()` uses `transformIndexHtml` with `order: 'pre'` to
      inject `<script>${prepaintSource()}</script>` at `head-prepend`.
    - `build.target ['es2022','chrome105','safari15']`.
    - vitest runs on jsdom, with `src/test/setup.ts`, over `src/**/*.test.{ts,tsx}`. Any test that reads files starts
      with `// @vitest-environment node`.
  - **`src/styles.css`:** imports `tailwindcss`, `@cueplusplus/ui/styles.css`, `@cueplusplus/theme-cue/theme.css`, then
    `@cueplusplus/theme-terminal/theme.css`.
  - **`src/theme.ts`:**
    - `THEMES = [cue, terminal]`;
    - `THEME_DEFAULTS = { theme: 'cue', density: 'compact', mode: 'system' }`;
    - `STORAGE_KEY = 'agent-comms'`;
    - `prepaintSource()`, which returns `prepaintScript({ storageKey, defaults: THEME_DEFAULTS, themes: THEMES })`.
  - **`src/main.tsx`:** renders `<ThemeProvider themes={THEMES} storageKey={STORAGE_KEY} {...THEME_DEFAULTS}>` around
    `<App/>`. Biome forbids `!`, so check that `#root` exists.
  - **`src/install.ts`:** `INSTALL_COMMAND = 'npx -y @agentcomms/core mcp install --client claude-code'`.
  - **`scripts/bundle-check.mjs`:** fails unless:
    - the bundle has no `externalBin` and no `resources`;
    - `dist/` holds only `index.html` and `assets/*`;
    - there is exactly one inline script, and its sha256 is in `script-src`;
    - there is no `http(s)://` in `dist` HTML or CSS.

    Then it prints `desktop bundle check: OK`.
- Create in `apps/desktop/src-tauri/`:
  - **`Cargo.toml`:** Tauri and serde for now.
  - **`build.rs`:**
    `tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)))`, with
    `const COMMANDS: &[&str]` holding the thirteen names.
  - **`tauri.conf.json`:**
    - `productName`, `identifier` and `version`;
    - `build`: `frontendDist "../dist"`, `devUrl "http://localhost:1420"`, `beforeDevCommand "pnpm dev"`,
      `beforeBuildCommand "pnpm build"`;
    - `app.windows []`;
    - `app.security`: `csp`, `devCsp`, and `dangerousDisableAssetCspModification: false`;
    - `bundle`: `targets ["app","dmg","nsis","appimage","deb"]`, `category "DeveloperTool"`,
      `createUpdaterArtifacts false`, `macOS.minimumSystemVersion "12.0"`, `windows.nsis.installMode "currentUser"`,
      `linux.deb.depends ["libayatana-appindicator3-1"]`, and the icons.
  - **The CSP is exactly:**
    `default-src 'self'; script-src 'self' 'sha256-<prepaint>'; style-src 'self'; img-src 'self' data:; connect-src
    ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`.
    - `devCsp` adds `'unsafe-inline'` to scripts and styles, and `ws://localhost:1420` to `connect-src`.
  - **`capabilities/default.json`:** windows `["main"]`.
    - Permissions: `core:event:allow-listen`, `core:event:allow-unlisten`, `core:window:allow-start-dragging`,
      `core:window:allow-internal-toggle-maximize`, and the thirteen `allow-*`.
  - **`icons/source.svg`:** 1024×1024, filled `#0b0b0c`, `AC` centred in white sans-serif. Run `tauri icon` on it, and
    commit what it writes.
  - **`src/main.rs`:** calls `agentcomms_desktop::run()`.
  - **`src/lib.rs`:** `setup` calls `window::build_main`.
  - **`src/window.rs`:** builds the `main` window:
    - titled `Agent Comms`, 1200×800, minimum 900×600;
    - on macOS, `TitleBarStyle::Overlay` with `hidden_title(true)`;
    - `.on_navigation(is_app_origin)`, copying `is_app_origin` from
      `git show feat/events-c:apps/desktop/src-tauri/src/security.rs`;
    - new windows and downloads denied.
- Create: root `test/desktop-app.test.mjs`.
- Test: `apps/desktop/src/test/csp.test.ts` (node environment), `apps/desktop/src/test/repo-rules.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - **csp:**
    - `the content policy is phase C's with the pre-paint script pinned by its hash`;
    - `index.html carries no inline script of its own`;
    - `capabilities grant only events, dragging and the thirteen commands`.
  - **repo-rules:**
    - `no runtime string names a suite binary as a command`;
    - `the install command is the README's`;
    - `no source renders HTML or Markdown`;
    - `no source reaches the network` (`fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`
      outside `src/test`);
    - `no @tauri-apps/plugin- package is a dependency`;
    - `no file names a real home`.
  - **root:**
    - `the desktop app is private and outside PUBLISHABLE and the registry`;
    - `its package and tauri.conf.json are at the repository's version`.
- [ ] **Step 2:** run `pnpm install`, then `pnpm --filter @agentcomms/desktop exec vitest run src/test/csp.test.ts
  src/test/repo-rules.test.ts` and `node --test test/desktop-app.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** implement. Run `pnpm sync:versions`, then `pnpm --filter @agentcomms/desktop run build`. The build
  must come before any `cargo` command, because Tauri's codegen needs `dist/`. Then run `check:bundle`.
- [ ] **Step 4:** run them again, with `pnpm lint` and `pnpm verify:versions`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): the scaffold on @cueplusplus/ui, the pre-paint script pinned in the content policy, and the app's own guards`.

### Task 4: Rust contracts: folders, launchers, the allow-list, the runner, the IPC types

**Files:**
- Create in `src-tauri/src/`:
  - `paths.rs`, `launchers.rs`, `allowlist.rs` and `runner.rs`;
  - `grammar.rs`, which `include_str!`s `../../grammar.json`;
  - `version.rs`, with `at_least(installed, needed) -> bool`, false when a version can't be read;
  - `ipc.rs`, holding every type that crosses IPC;
  - `commands.rs`, holding the commands and `pub const NAMES`.
- Create:
  - `apps/desktop/grammar.json`;
  - `src/ipc.ts`;
  - `src/grammar.ts`, zod built from `grammar.json`;
  - `src-tauri/tests/fixtures/resolve-paths.json`, the POSIX cases.
- Modify: `lib.rs`. Add `generate_handler!`, and `AppState { overrides: Mutex<FolderOverrides> }`, empty until Task 6.
- Test:
  - module unit tests;
  - `src-tauri/tests/paths_parity.rs`;
  - `src/test/paths-parity.test.ts`;
  - `src/test/grammar.test.ts`.

**Interfaces** (serde camelCase; IPC inputs `deny_unknown_fields`):
```rust
pub enum Platform { MacOs, Linux, Windows }
pub struct PathEnv { pub platform: Platform, pub home: String, pub appdata: Option<String>, pub localappdata: Option<String>,
  pub xdg_config_home: Option<String>, pub xdg_data_home: Option<String>,
  pub config_dir: Option<String>, pub state_dir: Option<String>, pub data_dir: Option<String> } // AGENT_COMMS_*; "" is unset
impl PathEnv { pub fn from_process() -> Self; pub fn with_overrides(self, o: &FolderOverrides) -> Self }
pub struct FolderOverrides { pub config_dir: Option<String>, pub state_dir: Option<String>, pub data_dir: Option<String> }
pub struct Folders { pub config_dir: String, pub state_dir: String, pub data_dir: String, pub secrets_dir: String }
pub fn resolve_folders(env: &PathEnv) -> Folders;                    // resolvePaths' rules, lexically normalised
impl Folders { pub fn pins(&self) -> [String; 8] }
pub enum Product { Core, Gmail, Slack, Resend, Whatsapp, EventsDaemon } // "core" … "events-daemon"
pub struct Launcher { pub product: Product, pub path: String }
pub fn find_launcher(folders: &Folders, platform: Platform, product: Product) -> Option<Launcher>; // a file; executable on POSIX
pub fn windows_node_from_launcher(text: &str) -> Option<String>;     // Task 2's pattern
pub fn node_on_path(path_var: &str) -> Option<String>;
pub struct Program { pub program: String, pub leading: Vec<String> } // POSIX: the launcher; Windows: node + [launcher]
pub struct ApprovalId(String); pub struct AccountName(String); pub struct ConversationId(String); pub struct Acts(String);
pub enum PauseDays { One, Seven, Fourteen }  pub enum UpdateLevel { Auto, Every14Days, Never }
// each #[serde(try_from = …)]: an invalid value never constructs, so the invoke itself fails
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Call { /* the allow-list table, row by row */ }
pub enum Shape { Envelope, Bare, VersionLine }
pub struct Words { pub product: Product, pub words: Vec<String>, pub shape: Shape, pub pins: bool, pub quiet_updates: bool, pub timeout: Duration }
impl Call { pub fn words(&self) -> Result<Words, AppError>; pub fn prepares_change(&self) -> bool }
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CliResult { Ok { exit: i32, data: Value }, ApprovalPending { approval_id: String, preview: String, expires_at: Option<String> },
  Failed { exit: i32, code: String, message: String, hint: Option<String> }, Version { version: String } }
pub fn parse_output(shape: Shape, exit: i32, stdout: &[u8], stderr: &[u8]) -> CliResult;
pub fn command_for(words: &Words, program: &Program, folders: &Folders, json: bool) -> std::process::Command;
pub struct RunContext { pub folders: Folders, pub platform: Platform, pub node: Option<String> }
pub fn run(call: &Call, ctx: &RunContext) -> CliResult;              // spawn, timeout, cap; never panics
pub struct Installation { pub installed: bool, pub version: Option<String>, pub present: Vec<Product>, pub folders: Folders, pub problem: Option<String> }
pub fn discover(ctx: &RunContext) -> Installation;
pub struct AppError { pub code: String, pub message: String }      // APP_REFUSED | APP_NOT_INSTALLED | APP_NO_NODE | APP_NOT_BUILT | APP_IO
pub enum TerminalCommand {                                           // tag "kind"; implemented in Task 6
  Approve { product: Product, approval_id: ApprovalId },             // core, gmail, slack, resend, whatsapp: `approve <id>`
  Change { call: Call, revoke: ApprovalId },                         // refused unless call.prepares_change()
  SignIn { product: Product, account: AccountName, again: bool } }   // gmail inbox add|reauth; slack workspace add|reauth; resend account add
pub enum TerminalOutcome { Opened { via: String, revoked: Option<bool> }, Copied { reason: CopyReason, revoked: Option<bool> } } // tag "outcome"
pub enum CopyReason { NoTerminal, NoSafeLine }
pub struct ProfileOpened { pub path: String, pub created: bool }
pub struct AppSettings { pub folders: FolderOverrides, pub resolved: Folders, pub login_item: bool, pub login_item_available: bool }
pub struct DeepLinkTarget { pub approval_id: String }
pub struct UpdaterState { pub on: bool, pub status: UpdaterStatus, pub version: Option<String>, pub message: Option<String> }
pub enum UpdaterStatus { Off, Idle, Checking, Available, None, Downloading, Ready, Error }
```

**How output is read:**
- **Envelope:** exactly one JSON value.
  - `ok: true` is `Ok`, and keeps the exit code, so doctor's 78 survives.
  - `APPROVAL_PENDING` is `ApprovalPending`, from `details`.
  - Any other error is `Failed`.
  - The pre-0.24 doctor pair (ok, then a `CONFIG` error) reads as its first envelope.
- **Bare:** one value at exit 0 is `Ok`. Anything else is `Failed` (`CLI_FAILED`), with stderr cut to 2000 characters.
- **Unreadable output** is `Failed` (`APP_UNREADABLE_OUTPUT`).

**Commands and mirror:**
- `installation` and `cli` work here. The other eleven return `APP_NOT_BUILT` until Phase 2 replaces each body with one
  call into its module.
- `src/ipc.ts` mirrors every type, and adds:
  - `AppEvents`: `'deep-link'` (`DeepLinkTarget`), `'window-visibility'` (`{ visible }`), `updater` (`UpdaterState`)
    and `'data-changed'`;
  - `Bridge`: one method per command, named in camelCase (`installation()`, `cli(call)`, `openInTerminal(command)`,
    `openProfile({ account?, conversation? })`, `setFolders(folders)`, …), plus `on(event, handler)`;
  - `tauriBridge`;
  - `formatActs(acts)`, which returns `none` when the list is empty.

- [ ] **Step 1: Write the failing tests:**
  - **paths:**
    - `the_port_matches_resolve_paths_for_every_recorded_case`;
    - `an_explicit_config_dir_takes_state_and_secrets_with_it`;
    - `windows_keeps_state_and_secrets_under_localappdata`;
    - `empty_variables_count_as_unset`;
    - `settings_overrides_act_as_the_environment_variables`;
    - `every_call_ends_with_the_four_pins`.
  - **launchers:**
    - `discover_reports_not_installed_without_launch_core`;
    - `each_product_is_present_when_its_launcher_is_a_file`;
    - `a_directory_named_like_a_launcher_is_not_one`;
    - `windows_node_comes_from_the_launcher_header`;
    - `windows_falls_back_to_node_on_path`;
    - `windows_without_node_cannot_run`.
  - **allowlist:**
    - `every_call_builds_its_documented_words`, for every row;
    - `no_call_carries_approval_and_version_takes_no_pins`;
    - `refuses_every_argument_that_does_not_match`: bad ids, names and conversations; a leading `-`; an unknown,
      repeated or empty act; `days: 2`; `sometimes`; an unknown `kind` or field;
    - `doctor_and_accounts_refuse_unlisted_products`;
    - `only_the_five_change_shapes_prepare`.
  - **runner:**
    - `an_ok_envelope_keeps_its_exit_code`;
    - `approval_pending_carries_id_preview_and_expiry`;
    - `an_error_envelope_is_failed_with_code_and_hint`;
    - `two_envelopes_are_unreadable_except_the_legacy_doctor_pair`;
    - `bare_json_is_ok_at_zero_and_failed_with_stderr_otherwise`;
    - `a_version_line_is_a_version`;
    - `quiet_updates_is_off_only_for_doctor_and_update_status`;
    - `the_command_has_no_shell_and_ends_with_the_pins`;
    - `#[cfg(unix)] runs_a_fake_launcher_and_reads_its_envelope`;
    - `#[cfg(unix)] a_launcher_that_hangs_is_killed_at_its_timeout`;
    - `output_over_the_cap_is_unreadable`.
  - **commands:** `capabilities_grant_exactly_the_commands`, checking that the capability file, `build.rs`'s
    `COMMANDS` and `NAMES` agree.
  - **TypeScript:**
    - `resolvePaths gives every recorded POSIX case`: imports core's `paths.ts`, and is skipped on win32;
    - `grammar.json agrees with core on a shared corpus`: against `APPROVAL_ID_PATTERN`, `ALIAS_PATTERN`,
      `NAME_PATTERN`, `SLACK_CONVERSATION` and `MAIL_CONVERSATION`.
- [ ] **Step 2:** run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` and the two vitest files. Expected:
  FAIL.
- [ ] **Step 3:** implement. Then run `cargo fmt` and `cargo clippy --all-targets -- -D warnings`.
- [ ] **Step 4:** run them again. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): the allow-list — every call the app may make, its arguments checked, run with no shell, read in both shapes`.

### Task 5: UI foundations: data, shared components, the shell, test support

**Files:**
- Create in `apps/desktop/src/`:
  - `copy.ts` and `gates.ts`;
  - `bridge-context.tsx` (`BridgeProvider`, `useBridge`);
  - `data.tsx` (`AppDataProvider`, `useAppData`);
  - `hooks/use-{poll,call,change}.ts`;
  - `components/{ScreenState,UntrustedText,NeedsNewerCli,ChangePreview,TerminalResult,AppearanceMenu,CopyButton}.tsx`;
  - `Shell.tsx`, `App.tsx` and `screens/NotInstalled.tsx`;
  - `screens/{Overview,Accounts,Approvals,Agent,Updates,Events,Doctor,Settings}.tsx`, headings only until Phase 2;
  - `cli-types.ts`;
  - `test/{setup.ts,fake-bridge.ts,render.tsx}` and `test/fixtures/*.json`.
- Create in `apps/desktop/`:
  - `scripts/record-fixtures.mjs`;
  - `playwright.config.ts` (Chromium; `webServer` is `pnpm exec vite preview --port 4173 --strictPort`);
  - `e2e/support/mock-ipc.ts` and `e2e/smoke.spec.ts`.
- Test: `src/test/foundations.test.tsx` and `src/test/gates.test.tsx`.

**Interfaces:**
```ts
export type Screen = 'overview' | 'accounts' | 'approvals' | 'agent' | 'updates' | 'events' | 'doctor' | 'settings';
export const GATES = { behaviour: '0.22.0', profiles: '0.22.0', standing: '0.23.0', updateStatus: '0.24.0' } as const;
export function supports(installed: string | null, feature: keyof typeof GATES): boolean;
export type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };
export type DoctorProduct = 'core' | 'gmail' | 'slack' | 'resend' | 'whatsapp' | 'events-daemon';
export interface DoctorView { product: DoctorProduct; healthy: boolean;
  checks: { title: string; status: 'ok' | 'warn' | 'fail' | 'skipped'; detail: string; fix?: string }[] }
export function doctorView(product: DoctorProduct, data: unknown): DoctorView;
export interface AppData {
  installation: Loadable<Installation>; approvals: Loadable<ApprovalView[]>;
  updateStatus: Loadable<UpdateStatus> | 'unsupported'; events: Loadable<unknown> | 'absent';
  doctors: Partial<Record<DoctorProduct, Loadable<DoctorView>>>; deepLink: DeepLinkTarget | null;
  refresh(what?: 'approvals' | 'updateStatus' | 'events' | 'installation'): Promise<void>;
  runDoctors(products: DoctorProduct[]): Promise<void>; clearDeepLink(): void;
}
export function usePoll(fn: () => Promise<void>, options: { everyMs: number; enabled: boolean }): void;
export function useCall<T>(call: Call | null): { result: Loadable<T>; reload(): Promise<void> };
export type ChangeOutcome = { state: 'applied'; data: unknown }
  | { state: 'needsTerminal'; call: Call; approvalId: string; preview: string }
  | { state: 'failed'; message: string; hint: string | null };
export function useChange(): { run(call: Call): Promise<ChangeOutcome> };
export function createFakeBridge(handlers?: Partial<Bridge>, fixtures?: Partial<Record<Call['kind'], unknown>>):
  Bridge & { calls: { command: keyof Bridge; args: unknown }[]; emit<E extends keyof AppEvents>(e: E, p: AppEvents[E]): void };
export function renderApp(bridge: Bridge, options?: { screen?: Screen }): RenderResult;
export async function installMockIpc(page: Page, scenario: Record<string, unknown>): Promise<void>;
```

**Behaviour:**
- **`cli-types.ts`** copies only the fields screens read, from:
  - core's `PublicApprovalView` (`approval-outcome.ts:327`), `DoctorReport` (`maintenance.ts:77`) and `LabelReport`
    (`operations/label.ts:125`);
  - `UpdateStatus`;
  - each channel's `DoctorResult`;
  - Gmail's `InboxView` (`inboxes.ts:31`), and the Slack and Resend list views;
  - spec 2's behaviour report and spec 3's `StandingView`.
- **Polling (DA14):** every 15 seconds while the window is visible, and on focus or `data-changed`.
  - It runs `approvalsPending`, `updateStatus` if it is supported, and `eventsStatus` if `events-daemon` is present.
  - Visibility means `document.visibilityState` together with the last `window-visibility` event.
- **Doctors:** each of core, slack, resend, whatsapp and events-daemon runs once at start, if present. Gmail runs only
  when asked.
- **A deep link** sets `deepLink`, and the Shell opens Approvals.
- **Shell:** a sidebar with Settings at the foot, and a header that is the `data-tauri-drag-region`. On macOS the header
  leaves a 28px inset for the traffic lights. It holds the appearance menu.
- **NotInstalled** shows, in order:
  - `agent-communications isn't installed for this user.`
  - `Run this in a terminal, then come back to this window:`
  - `INSTALL_COMMAND` in a `CodeBlock`, with `Copy`
  - `If you keep its folders elsewhere with AGENT_COMMS_* variables, set the same folders in Settings.`
- **ChangePreview:** the header `Approve this in Terminal`, then the preview as `UntrustedText`.
  - `Approve in Terminal` calls `openInTerminal({ kind: 'change', call, revoke: approvalId })`.
  - `Cancel` revokes.
- **TerminalResult** shows one of:
  - `Opened in <via>.`
  - `No terminal app was found. The command is copied: paste it into a terminal.`
  - `This command cannot be written as one safe line. Its words are copied as JSON.`
- **NeedsNewerCli** shows the update line, then `Needs <version> or later; this machine has <installed>.`
- **UntrustedText** puts the text in one text node, inside a `whitespace-pre-wrap` span.
- **Test support:**
  - `setup.ts` makes `fetch` throw.
  - `record-fixtures.mjs` records reads only, never doctor, from the built CLIs, with the folders pinned to a temp
    directory. Doctor and populated fixtures are written by hand, with fake data.
  - `mock-ipc.ts` stubs `window.__TAURI_INTERNALS__` (`invoke`, `transformCallback`, `plugin:event|listen`) and records
    every call to `window.__calls`.

- [ ] **Step 1: Write the failing tests:**
  - `with no core launcher only the install screen shows and nothing runs`
  - `a 0.21.0 CLI gets the update line in every gated section and none of their calls`. Gated: Agent behaviour and
    standing, Accounts profiles, Updates, Overview status. No calls to `behaviour`, `profileView`, `standingList` or
    `updateStatus`.
  - `polls every 15 seconds while visible and stops when hidden`
  - `runs the doctors once at start, Gmail's never unasked`
  - `UntrustedText renders hostile text as text`. For each Review Focus 4 string, `textContent` equals the input, and
    `querySelector('img,a,script,iframe')` is null.
  - `ChangePreview revokes its own approval and opens the change, in that order`
  - `TerminalResult says the command was copied`
  - `a deep link opens Approvals with that id`
  - `the sidebar has the seven sections in order, then Settings`
  - `the appearance menu offers cue and terminal, every density and three modes`
  - e2e: `opens on Overview with the seven sections`
- [ ] **Step 2:** run the two vitest files. Expected: FAIL.
- [ ] **Step 3:** implement. After `pnpm build`, record the fixtures, then fill in the populated ones.
- [ ] **Step 4:** run them, `run build`, and `exec playwright test e2e/smoke.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): the shell, the data the screens share, and the components that keep text plain`.

---

## Phase 2: in parallel, one worker each, all branched from Phase 1's head: Tasks 6 to 11

Each task replaces the `APP_NOT_BUILT` bodies of the commands it owns, and adds its plugins to `Cargo.toml` and
`lib.rs`.

### Task 6: Rust: the terminal, settings, the login item, links, the clipboard, profiles

**Files:**
- Create in `src-tauri/src/`:
  - `terminal.rs` and `links.rs`;
  - `settings.rs`: `<app_config_dir>/settings.json` holds `{ "folders": FolderOverrides }`, loaded into `AppState` at
    start;
  - `login_item.rs`: off until switched on. macOS uses Supbuddy's SMAppService `is_enabled`/`set_enabled`; everywhere
    else uses `tauri-plugin-autostart`.
- Modify:
  - `commands.rs`: the seven commands from `open_in_terminal` to `set_login_item`;
  - `lib.rs`: opener, clipboard-manager, and autostart (not on macOS);
  - `Cargo.toml`.

**Interfaces:**
```rust
pub fn posix_word(word: &str) -> String;                 // port of posixShellWord, packages/core/src/command-line.ts:120
pub fn windows_word(word: &str) -> Option<String>;       // port of windowsShellWord, :128
pub fn json_words(words: &[String]) -> String;           // port of commandAsJson, :157
pub fn line(words: &[String], platform: Platform) -> Option<String>;
pub enum Plan { Spawn { program: String, args: Vec<String>, raw: bool, via: &'static str }, Copy { text: String, reason: CopyReason } }
pub fn plan(platform: Platform, words: &[String], found: &dyn Fn(&str) -> Option<String>) -> Plan;
pub fn applescript_string(text: &str) -> String;
pub fn open(app: &AppHandle, command: TerminalCommand, ctx: &RunContext) -> Result<TerminalOutcome, AppError>;
pub fn allowed_link(url: &str) -> bool;                  // https; slack.com, google.com or a subdomain of either
pub fn open_profile(app: &AppHandle, ctx: &RunContext, account: Option<AccountName>,
  conversation: Option<ConversationId>) -> Result<ProfileOpened, AppError>; // profileInit; opens only <config>/compose/*.md
```

**Behaviour:**
- **Words:** the program, its leading words, the call's words, then the pins. There is no `--json`.
- **`Change`:** revoke first, record the result, then open the terminal either way (DA10).
- **macOS:** `/usr/bin/osascript`, with the args `-e`, `tell application "Terminal"`, `-e`, `activate`, `-e`,
  `do script <applescript_string(line)>`, `-e` and `end tell`. `via` is `Terminal`.
- **Linux:** the first of `x-terminal-emulator -e`, `gnome-terminal --` and `konsole -e` found on `PATH`, each with
  `/bin/sh -c HOLD`.
  - `HOLD` is `<line>; printf '\n%s\n' 'Done. Press Enter to close this window.'; read -r _`.
  - If none is found: `Copy` (`noTerminal`).
- **Windows:**
  - an unsafe word gives `Copy` of `json_words` (`noSafeLine`);
  - otherwise `wt.exe`, if it is on `PATH` and the line has no `;`, with raw `-w new cmd /s /k "<line>"`;
  - otherwise `%SystemRoot%\System32\cmd.exe`, with raw `/s /k "<line>"` and `CREATE_NEW_CONSOLE`.
- **Every `Copy`** writes the clipboard.

- [ ] **Step 1: Write the failing tests:**
  - `posix_and_windows_words_match_core_on_its_cases` (the cases come from core's `quoteCommand` tests)
  - `approve_builds_the_channel_launcher_with_pins`
  - `change_refuses_a_call_that_prepares_nothing`
  - `change_revokes_first_then_opens`
  - `sign_in_builds_each_channel_and_refuses_resend_again`
  - `macos_uses_terminal_through_osascript_with_the_line_escaped` (a folder containing `"` and `\`)
  - `linux_tries_the_three_terminals_in_order`
  - `linux_with_no_terminal_app_copies_the_command`
  - `windows_prefers_wt_then_cmd_and_avoids_wt_for_a_semicolon`
  - `windows_with_an_unsafe_word_copies_json`
  - `links_allow_only_https_slack_and_google`
  - `profile_paths_outside_compose_are_refused`
  - `folders_must_be_absolute_and_round_trip_through_settings_json`
- [ ] **Step 2:** run `cargo test … terminal settings links`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run all the Rust tests and clippy. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): the terminal opens the located command on each platform, and settings keep the folders`.

### Task 7: Rust: the window's behaviour, the tray, deep links, the updater

**Files:**
- Create:
  - `src-tauri/src/{tray,deeplink,updater}.rs`;
  - `icons/tray.png`: 44×44, a black `AC` on transparent, for use as a template.
- Modify:
  - `window.rs`:
    - closing hides the window unless the app is quitting, and `RunEvent::Reopen` shows it;
    - hide and show emit `window-visibility`;
    - on macOS, `Menu::default`.
  - `commands.rs`: the four updater and deep-link commands. `cli` calls `tray::set_count` after an `Ok`
    `approvalsPending`.
  - `lib.rs`:
    - plugins in this order: single-instance first (it shows the window), then deep-link, then the updater when
      `UPDATER_ON`;
    - `ExitRequested` sets `QUITTING`.
  - `build.rs`: `AGENTCOMMS_DESKTOP_UPDATER` is `on` when `TAURI_SIGNING_PRIVATE_KEY` is set, and `off` otherwise.
  - `tauri.conf.json`:
    - `plugins.deep-link.desktop.schemes ["agentcomms"]`;
    - `plugins.updater { "pubkey": "", "endpoints": [], "requireSignedVersion": true }`.
  - `Cargo.toml`.

**Interfaces:**
```rust
pub static QUITTING: AtomicBool;
pub fn on_close(quitting: bool) -> CloseAction;          // Hide | Close
pub const TRAY_ID: &str = "agentcomms-tray";            // menu ids: open, pause-day, standing-off, check-updates, quit
pub fn build(app: &AppHandle) -> tauri::Result<()>;     // template icon, tooltip "Agent Comms", menu on left click
pub fn set_count(app: &AppHandle, n: usize);            // title "<n>" (none at 0) on macOS and Linux; tooltip everywhere
pub fn tooltip(n: usize) -> String;                     // "Agent Comms" · "Agent Comms — 1 approval waiting" · "… <n> approvals waiting"
pub fn standing_enabled(version: Option<&str>) -> bool; // at_least 0.23.0
pub fn parse(url: &str) -> Option<DeepLinkTarget>;      // agentcomms://approvals/<ApprovalId>, one trailing / allowed
pub const UPDATER_ON: bool;                             // option_env!("AGENTCOMMS_DESKTOP_UPDATER") == Some("on")
pub fn pick_manifest_url(releases_json: &str) -> Option<String>;
```

**Behaviour:**
- **The tray menu:**
  - `Open` shows the window;
  - `Pause update notices for a day` runs `updatePause { days: 1 }`;
  - `End every standing approval` runs `standingOff`, and is enabled only when `standing_enabled`;
  - `Check for Updates…` shows the window and checks;
  - `Quit` sets `QUITTING`, then calls `app.exit(0)`;
  - each action emits `data-changed`.
- **The count:** `approvalsPending` runs through `runner::run` every 60 seconds (DA4).
- **The updater (DA8):**
  - **When:** silently, 60 seconds after launch, then every 24 hours. It emits `updater` only on `available`.
  - **Where:** `pick_manifest_url` reads
    `https://api.github.com/repos/crissmoldovan/agent-communications/releases?per_page=30` with a `User-Agent` and no
    token. It returns the `latest.json` URL of the highest release that is neither a draft nor a prerelease and is
    tagged `desktop-v<semver>`, with no pre-release suffix.
  - **How:** through `updater_builder().endpoints(vec![url])`. `install_update` then calls `restart()`.
  - **When off,** it reports `{ on: false, status: 'off', message: 'Updates for this app are off: this copy was built
    without the updater key.' }`.
- **Deep links:** one that launched the app (`get_current`) waits for `take_deep_link`. Later ones show the window and
  emit `deep-link`.

- [ ] **Step 1: Write the failing tests:**
  - `close_hides_unless_quitting`
  - `tooltip_counts_approvals`
  - `standing_off_needs_0_23`
  - `parses_an_approval_link`
  - `refuses_every_other_link`: another scheme or host, two segments, a query, a fragment, a bad id, `..`, and percent
    encoding
  - `picks_the_highest_complete_desktop_release`, which skips `v0.25.0`, a draft, a prerelease,
    `desktop-v0.26.0-rc.1`, and a release with no `latest.json`
  - `updater_is_off_without_the_key`
- [ ] **Step 2:** run `cargo test … tray deeplink updater window`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run all the Rust tests and clippy, then try `tauri dev` once by hand: the tray, hide-on-close and
  Quit. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): the tray counts what waits, the window hides to it, agentcomms:// links open an approval, the updater is off without its key`.

### Task 8: UI: Overview and Approvals

**Files:** `src/screens/Overview.tsx`, `src/screens/Approvals.tsx`, `src/components/ApprovalCard.tsx`.
- Test: `src/test/{overview,approvals}.test.tsx`, `e2e/{overview,approvals}.spec.ts`

**Overview** (DA5.1), from `useAppData()`:
- `agent-communications <version>`;
- the update status (gated): level, background job with its last run, and any pause;
- a `Row` per doctor, with a `StatusDot`: `ok`, `warn` on any warning, `danger` on any failure;
- the approvals waiting, which links to Approvals;
- the active standing approvals (gated), via `useCall({ kind: 'standingList' })`;
- the events state, if events-daemon is present.

**Approvals** (DA5.3, DA11):
- **`ApprovalCard`** shows the kind, channel, created and expires times. `expect.to`, `cc`, `bcc`, `subject` and
  `files.names` each show as `UntrustedText`.
- **`Revoke`** runs `approvalRevoke`, then `refresh('approvals')`.
- **`Approve in Terminal`** calls `openInTerminal({ kind: 'approve', product: channel, approvalId })`. It shows only for
  core, gmail, slack, resend or whatsapp, and only when that launcher is present.
- **Empty:** `Nothing is waiting for you.`
- **A deep link** selects its card and scrolls to it. If the approval is gone: `This approval is no longer waiting.`

- [ ] **Step 1: Write the failing tests:**
  - `Overview shows loading, then every block from the fixtures`
  - `a failing doctor shows danger for that channel`
  - `Approvals is empty, loading, error and populated from the fixtures`
  - `Revoke runs approvalRevoke with that id and refreshes`
  - `Approve in Terminal opens that channel's approve`
  - `no Approve in Terminal when the channel's launcher is missing`
  - `a deep link selects its approval, and an unknown id says it is no longer waiting`
  - e2e: `Overview shows the version, approvals waiting and each doctor`, `revoke removes the approval`,
    `Approve in Terminal sends open_in_terminal with the approval`, and `a hostile approval renders as text`
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): Overview and Approvals — what waits, shown as plain text, revoked here or approved in Terminal`.

### Task 9: UI: Accounts and Agent

**Files:** `src/screens/Accounts.tsx`, `src/screens/Agent.tsx`, `src/components/RuleForm.tsx`
- Test: `src/test/{accounts,agent}.test.tsx`, `e2e/agent.spec.ts`

**Accounts** (DA5.2):
- **One row per account**, from `accounts` (gmail, slack, resend) and `doctor { product: 'whatsapp' }`, for each
  launcher that is present. A row shows:
  - its mode and policies, under its source type's names (`sendPolicy`, `changePolicy`, a workspace's mode);
  - its label style, from `label`;
  - what agents may do there, from `behaviour` (gated).
- **`Open writing profile`** (gated `profiles`) calls `openProfile({ account })`. When it made the file, it says
  `Created <path>`.
- **`Add a mailbox`, `Add a workspace` and `Add a Resend account`** each open a `Dialog`. Its `Field` checks the name
  against `grammar.ts`. `Run in Terminal` then calls
  `openInTerminal({ kind: 'signIn', product, account, again: false })`.
- **`Sign in again`** (Gmail and Slack) sends `again: true`.

**Agent** (DA5.4):
- **The label,** read-only: its word, name and rules, and each account's Slack style.
- **Rules** (gated):
  - `Remove` on a rule runs `behaviourClear`;
  - `RuleForm` takes an account (`Select`), an optional conversation (`Input`) and acts (`CheckboxGroup`, where none
    means `none`), and runs `behaviourAllow`;
  - every outcome goes through `useChange`: `applied` refreshes, and `needsTerminal` shows `ChangePreview`.
- **Standing approvals** (gated): `Revoke` (`standingRevoke`), and `End them all` (`standingOff`).

- [ ] **Step 1: Write the failing tests:**
  - `Accounts lists each channel's accounts with policies, label style and what agents may do`
  - `Open writing profile calls openProfile with the account`
  - `an invalid account name never reaches the bridge`
  - `Add a mailbox opens the terminal with a gmail sign-in`
  - `the label shows word, name, rules and Slack style`
  - `a tightening rule applies and refreshes`
  - `a loosening rule shows its preview under Approve this in Terminal, and the button revokes then opens the change`
  - `Remove runs behaviourClear through the same flow`
  - `standing: revoke one, end them all`
  - e2e: `a tightening is applied`, `a loosening is sent to Terminal`
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): Accounts and Agent — what each account allows, rules that tighten here and loosen in Terminal, standing approvals ended`.

### Task 10: UI: Updates, Events, Doctor and Settings

**Files:** `src/screens/{Updates,Events,Doctor,Settings}.tsx`
- Test: `src/test/{updates,events,doctor,settings}.test.tsx`, `e2e/updates.spec.ts`

**Updates** (DA5.5), gated on `updateStatus`:
- the level: a `SegmentedControl` that runs `updateLevel` through `useChange`;
- pausing: `Pause for 1 day`, `7 days` and `14 days` (`updatePause`), and `Resume`;
- the background job: its state, where it is and its last run.
  - `Set up background updates` runs `updateBackgroundJob { on: true }` through `useChange`.
  - `Remove` runs `on: false`, which applies at once.
- rollback: `Roll back to the release before` runs `updateRollback` through `useChange`.

**Events** (DA5.6), only when `events-daemon` is present (otherwise `The events service isn't installed.`):
- the status, with `Pause` and `Resume`;
- the rules (`eventsRules`) and recent deliveries (`eventsDeliveries`), each a `Table` of its source type's fields.

**Doctor** (DA5.7, DA14):
- It runs every present doctor except Gmail's, on open and on `Refresh`. `Check Gmail (asks Google)` runs Gmail's.
- Each check shows its title, a tone `Chip` and its detail.
- Each fix is text with `Copy`. Each `https://` URL in it that `allowed_link` accepts gets `Open link` (`openLink`).

**Settings:**
- `Start at login` is a `Switch` (`setLoginItem`). Where that isn't available, it is disabled with a note.
- **Folders:** three `Field`s, for config, state and data. `Save` calls `setFolders`, then `refresh('installation')`.
  The four resolved folders show read-only.
- **The app's updater:** its state, and `Check for Updates`. `Install and restart` appears when an update is
  `available`. The off message shows when the updater is off.

- [ ] **Step 1: Write the failing tests:**
  - `Updates: each state; pause 7 runs updatePause 7; a less frequent level goes to Terminal; Remove applies at once`
  - `Events: absent, loading, error, populated; Pause and Resume run`
  - `Doctor: runs on open, never Gmail unasked; Copy copies the fix; Open link only for slack.com and google.com`
  - `Settings: saving a config folder re-reads the installation and shows the four folders; the updater says when it is off`
  - e2e: `pause for 7 days runs update --pause 7 and shows the pause`, `rollback is sent to Terminal`
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run them. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(desktop): Updates, Events, Doctor and Settings`.

### Task 11: CI, the release workflow, the owner's scripts

**Files:**
- Create: `.github/workflows/desktop.yml`, shaped after phase C's
  (`git show feat/events-c:.github/workflows/desktop.yml`).
  - **Triggers:**
    - `pull_request` and `push` to `main`, on `apps/desktop/**`, `.github/workflows/desktop*.yml`,
      `pnpm-lock.yaml` and `pnpm-workspace.yaml`;
    - `workflow_call: {}`.
  - **Settings:** `contents: read`, and `fail-fast: false`.
  - **Matrix:**

    | OS | Bundle |
    |---|---|
    | `macos-latest` | `app` |
    | `macos-15-intel` | `app` |
    | `windows-latest` | `nsis` |
    | `ubuntu-22.04` | `deb` |
  - **Setup:**
    - `actions/checkout@v7` (`persist-credentials: false`);
    - `pnpm/action-setup@v6`;
    - `actions/setup-node@v7`, Node 22.18.0 with the pnpm cache;
    - `pnpm install --frozen-lockfile`;
    - phase C's Linux `apt-get` list;
    - `rustup toolchain install stable --profile minimal --component rustfmt --component clippy`.
  - **Steps, in order:**
    1. `typecheck`, `test`, `build` and `check:bundle`;
    2. `playwright install --with-deps chromium`, then `test:e2e`;
    3. in `src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`;
    4. `tauri build --ci --no-sign --bundles ${{ matrix.bundles }}`.
- Create: `.github/workflows/desktop-release.yml`, on tags `desktop-v*`.
  - **`check-tag`** requires the tag to be `desktop-v` plus the `tauri.conf.json` version.
  - **`verify`** runs `uses: ./.github/workflows/desktop.yml`.
  - **`bundle`** builds `nsis` on `windows-latest` and `appimage,deb` on `ubuntu-22.04`, with `contents: write` and
    `GH_TOKEN: ${{ github.token }}`:
    - with no release yet, it runs
      `gh release create "$tag" --verify-tag --draft --latest=false --title "Agent Comms $version" --notes-file notes.md`.
      If that fails, it runs `view` again, because the other leg may have created it.
    - then `gh release upload … --clobber`.
- Create in `apps/desktop/scripts/`:
  - **`release-notes.mjs <version>`** prints these four lines:
    - `Agent Comms <version>.`
    - `macOS: the DMG is signed with a Developer ID and notarised.`
    - `Windows and Linux: the .exe, .AppImage and .deb are unsigned; your system warns before it opens them.`
    - `What changed: CHANGELOG.md, <version>.`
  - **`release-desktop.sh desktop-vX.Y.Z`:** QuotaMate's `scripts/release-menubar.sh` (in `cueplusplus/quotamate`),
    with its checks kept and these changes:
    - **Refusals:**
      - a tag other than `desktop-v` plus the `tauri.conf.json` version;
      - a `"$TAG^{commit}"` other than `HEAD`;
      - a stdin or stdout that is not a terminal, or a version that is not typed back.
    - **Environment and key:**
      - the env file is `${AGENTCOMMS_DESKTOP_RELEASE_ENV_FILE:-.env.desktop-release.local}`;
      - the key is `${AGENTCOMMS_UPDATER_KEY_FILE:-$HOME/.agentcomms/tauri-updater.key}`, mode 600, and its `.pub`
        must equal `plugins.updater.pubkey`;
      - no token is baked in;
      - QuotaMate's `check:monitor` and `verify-updater` steps are dropped, because this repository has no such crate.
    - **The build:** `pnpm --filter @agentcomms/desktop tauri build --ci --target universal-apple-darwin --bundles
      app,dmg --config '{"bundle":{"createUpdaterArtifacts":true}}'`.
    - **Staging:** in `src-tauri/target/desktop-release/<version>/`: `Agent.Comms.app.tar.gz` and its `.sig`,
      `Agent.Comms_<version>_universal.dmg`, `SHA256SUMS` and `.built-at-commit`.
  - **`publish-desktop.sh desktop-vX.Y.Z`:** QuotaMate's `publish-menubar.sh`, with
    `REPO=crissmoldovan/agent-communications` and these changes:
    - **Refusals:** the same tag and terminal checks.
    - **The release:** it refuses one already published with the DMG. Otherwise it creates it
      (`--verify-tag --draft --latest=false`) or uses the draft CI made.
    - **Uploads:** the DMG, `.tar.gz`, `.sig` and `SHA256SUMS`, then `latest.json`:
      `{ version, notes: "Agent Comms <version>", pub_date, platforms }`. Both `darwin-aarch64` and `darwin-x86_64`
      map to `{ signature, url: "https://github.com/<REPO>/releases/download/<tag>/Agent.Comms.app.tar.gz" }`.
    - **Finally** it runs `gh release edit --draft=false --latest=false`.
- Test: `apps/desktop/src/test/release.test.ts` (node environment)

- [ ] **Step 1: Write the failing tests:**
  - `desktop.yml runs on PRs touching apps/desktop, on four legs, with every gate`
  - `desktop-release.yml checks the tag, verifies, attaches unsigned bundles and never takes Latest`
  - `release-desktop.sh refuses a dirty tree, a wrong tag, another commit and no terminal, and bakes no token`
  - `publish-desktop.sh writes latest.json for both Mac architectures and never takes Latest`
  - `the release notes say Windows and Linux are unsigned`
  - `both scripts parse` (`bash -n`; skipped on win32)
- [ ] **Step 2:** run the file. Expected: FAIL.
- [ ] **Step 3:** implement. Never run either release script: no agent does.
- [ ] **Step 4:** run it again. Expected: PASS.
- [ ] **Step 5: Commit:** `ci(desktop): three-OS checks on every desktop PR, unsigned Windows and Linux on a desktop tag, and the owner's signing scripts`.

---

## Phase 3: one worker, in order: Tasks 12, 13

### Task 12: Docs and changelog

**Files:**
- Modify `README.md`: add `## The desktop app` after the section that installs the core server. It covers:
  - what the app shows, and that it never sends, posts or approves;
  - that approvals open in Terminal;
  - where it comes from: `desktop-vX.Y.Z` releases, with a signed DMG for macOS and unsigned files for Windows and
    Linux;
  - that it needs agent-communications installed, and its features follow that version;
  - that Settings takes the folders `AGENT_COMMS_*` would set.
- Modify `docs/RELEASING.md`: add `## The desktop app`, with the owner's steps:
  1. Run `pnpm --filter @agentcomms/desktop tauri signer generate -w ~/.agentcomms/tauri-updater.key`, then
     `chmod 600` the key.
  2. Paste the `.pub` into `plugins.updater.pubkey`, and commit.
  3. Create `.env.desktop-release.local` with mode 600.
  4. Tag `desktop-vX.Y.Z` on the `vX.Y.Z` commit, and push the tag.
  5. Run the two scripts.
  6. Update between two signed versions.

  The section also says why a desktop release never takes Latest, and that no agent runs these scripts.
- Modify `CHANGELOG.md` under `## Unreleased`: the app, and `update --status`. Note that `doctor --json` now prints one
  envelope, so read `data.ok`.
- Test: the existing checks.

- [ ] **Step 1:** make the edits.
- [ ] **Step 2:** run `node --test test/install-docs.test.mjs`, then `pnpm verify:skills && pnpm verify:reference`.
  Expected: PASS.
- [ ] **Step 3: Commit:** `docs: the desktop app — what it does, how it is released, and the changelog`.

### Task 13: Integrate and verify

- [ ] **Step 1:** merge the Phase 2 branches onto Phase 1's head. Keep every side in `commands.rs`, `lib.rs`,
  `Cargo.toml` and `Cargo.lock`. Single-instance stays the first plugin.
- [ ] **Step 2:** run `node --import ./test/helpers/loopback-seal-preload.mjs --test "test/**/*.test.mjs"`. Expected:
  `# fail 0`.
- [ ] **Step 3:** run the desktop gates in `desktop.yml`'s order. Expected: PASS.
- [ ] **Step 4:** run `pnpm verify` once, with nothing else running in the worktree. Expected: exit 0.
- [ ] **Step 5: Commit** any fixes as `chore(desktop): integrated`. The pull request carries what `CONTRIBUTING.md`
  lists, and proposes `0.24.0-feat-desktop` (minor).
