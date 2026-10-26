# The desktop app — design

Status: **written 2026-10-19**, to ship after spec 3, as 0.24.0. The owner set the direction on 2026-10-14: build it
on `@cueplusplus/ui`, and make it look, behave and be built like QuotaMate, or better, like Supbuddy. On 2026-10-19
they asked for the work to be done without further questions. So every decision the owner did not state is marked
**(lead's call)**.

This design **replaces** §D13 of the [local event emission design](2026-10-05-local-event-emission-design.md), and the
paused phase C built from it (branches `feat/events-c` and `feat/events-c-t7fix`). That work was for the events
service only, predates the owner's direction, and stays unmerged, as reference.

## 1. What was asked

> We should get started with implementing the desktop app, which should make use of the Q-UI library. And make sure
> that it looks, behaves, and has the same infrastructure as the QuotaMate app. And more specifically, a better one
> would be Subbody app.

"Q-UI" is `@cueplusplus/ui`, and "Subbody" is Supbuddy.

## 2. What is true (researched 2026-10-19, read-only)

**Supbuddy** (`cueplusplus/supbuddy`, `apps/desktop`, 3.7.8) is a Tauri v2 app, migrated from Electron.
- **The shell:** one main window, 1200×800 with a 900×600 minimum. On macOS it has an overlay title bar, with the
  traffic lights over the app's own header, which is the drag region.
- **The tray:** closing the window hides it to the tray, and Cmd+Q asks before quitting. The tray menu is live.
- **The rest of the shell:** clicking the dock icon reopens the window. It has a login item through SMAppService, and
  `supbuddy://` deep links.
- **It bundles a Node daemon** as a sidecar, with a watchdog.
- **Its UI** is React 18, Tailwind 3 and Radix, with its own tokens. It does not use `@cueplusplus/ui`.
- **Releases** are signed with a Developer ID and notarised by a local script. They update through
  tauri-plugin-updater, from a private GitHub release, using a token baked into the binary.

**QuotaMate** (`cueplusplus/quotamate`) has two parts:
- **A Next.js web app.**
- **A Tauri v2 menu-bar app** (`apps/menubar`, `ai.quotamate.menubar` 0.1.3), merged on 2026-10-11.
  - It is signed with a Developer ID and notarised.
  - Its release script says it is "Supbuddy release-tauri.sh, adapted for a universal menu bar app with no sidecar".
    It runs on the signing Mac, notarises and staples both the app and the DMG, and refuses a dirty tree or a commit
    that isn't the tag's.
  - It updates through tauri-plugin-updater, from private GitHub prereleases, using a baked read-only token.
  - It paints with `@cueplusplus/theme-quotamate` tokens, but doesn't use `@cueplusplus/ui`'s components or provider.

So the two siblings share one release mechanism, and Supbuddy is its source.

The **web** app's use of `@cueplusplus/ui` is the reference:
- the two-line stylesheet (`@import 'tailwindcss'` then `@import '@cueplusplus/ui/styles.css'`);
- a pre-paint script so the theme shows without a flash;
- `ThemeProvider` with theme, density and mode;
- an appearance menu.

**What the owner's direction comes to:** Supbuddy's shell and release model, with QuotaMate's way of adopting
`@cueplusplus/ui`. That reading is the lead's: neither repository states it.

**The paused phase C** (`feat/events-c`) has a Tauri v2 app with React 19, Vite 7 and `@cueplusplus/ui` 0.20.1.
- It has two windows and events-only screens, built from plain elements.
- It has a strict no-egress content policy, a typed allow-list of Rust commands, and a three-OS CI matrix.
- Its releases are unsigned, with no updater.

`@cueplusplus/ui` is at 0.29.0 on npm, and Tauri's CLI at 2.12.3.

## 3. Decisions

### DA1. What the app is (lead's call)

The app is **a control panel for agent-communications on this machine**. It shows:
- the accounts;
- what is waiting for the person's approval;
- how agents are labelled and what they may do (spec 2);
- the standing approvals (spec 3);
- updates;
- the events service;
- the doctor.

**It never sends or posts anything,** and never approves anything:
- **Tightening and revoking:** the app applies these, because they apply at once anyway.
- **Anything that needs approval** shows its full preview in the app. One button opens the system terminal with the
  approve command, and the person types the code there.

That keeps the core's approval routes exactly as they are: no new way to approve is added. The app also never calls a
change again with an `approvalId`, even under the `chat` change policy.

### DA2. Built like Supbuddy

- **Tauri v2.** The app lives in this repository at `apps/desktop`. It is a private workspace package, never
  published to npm.
- **One main window,** 1200×800, minimum 900×600. On macOS the title bar overlays the app's header, which is the drag
  region.
- **The tray:**
  - its icon shows the number of approvals waiting;
  - its menu has Open, Pause update notices for a day, End every standing approval (from 0.23.0), and Quit.
- **Window behaviour:** closing the window hides it to the tray, and Cmd+Q (or Quit) quits.
- **Start at login** is off by default, and switched on in Settings.
- **Deep link `agentcomms://`:** `agentcomms://approvals/<id>` opens the app on that approval. The CLI may print the
  link beside an approve command.
- **No bundled daemon (lead's call).** Supbuddy ships its daemon. agent-communications has no daemon of its own: its
  servers are started by MCP clients. So the app drives what is already installed (DA4), and there stays one
  installation and one verified update path.

### DA3. Looks like QuotaMate, on `@cueplusplus/ui`

- React 19, Vite and Tailwind v4, with `@cueplusplus/ui` at its latest (0.29.x) and `@cueplusplus/theme-cue`.
- The two-line stylesheet, a pre-paint script, and `ThemeProvider` with theme `cue`, density `compact` and mode
  `system`. An appearance menu changes all three, and the choice is kept in local storage.
- **The layout:** a sidebar, with Overview, Accounts, Approvals, Agent, Updates, Events and Doctor; then the page.
  **(lead's call:** QuotaMate's top bar fits few sections, and this app has seven.**)**
- **Only `@cueplusplus/ui` components.** A builder uses the `cue-ui` skill and follows its rules on colour, spacing
  and control size. No component library of the app's own.

### DA4. How the app talks to agent-communications

**It runs the installed CLIs,** through this installation's stable launchers: `<data>/launch/core`, and
`<data>/launch/events-daemon` for the events service. It always runs them with `--json` and the folder pins, from Rust.
- **A fixed allow-list** of command shapes, each with its arguments checked against the product's own grammars
  (account names, approval ids, channel ids).
- **No shell.** No argument is passed that the allow-list didn't build.
- **Output** is parsed as JSON, and handed to the UI as data.

**When nothing is installed:** the app shows the documented install command and stops there. It never installs
anything itself. **(lead's call:** one install path, the verified one.**)**

**Refreshing:** on focus, and every 15 seconds while the window is visible. The tray badge refreshes every 60 seconds.

**Untrusted text:** a preview's sender-controlled text arrives from the CLI already inside its untrusted-content
envelope. The app shows it as plain text, never as HTML or Markdown.

### DA5. The screens (v1)

1. **Overview:**
   - the version and the update status: level, background job and pause;
   - doctor's result for each channel;
   - approvals waiting;
   - standing approvals active;
   - the events service's state.
2. **Accounts:**
   - Gmail mailboxes, Slack workspaces, Resend accounts and WhatsApp;
   - each one's mode and policies, its label style, what agents may do there (spec 2), and its writing profile files;
   - the profile files open in the default editor, after `profile init` makes any that are missing.
3. **Approvals:**
   - each waiting approval with its full preview;
   - Revoke, which applies at once;
   - Approve in Terminal.
4. **Agent:**
   - the label: word, name, rules and Slack style;
   - the behaviour rules: a form that adds or changes a rule; a tightening applies at once, and a loosening returns its
     preview with Approve in Terminal;
   - standing approvals: list, revoke, and end them all.
5. **Updates:**
   - level; pause for 1, 7 or 14 days; resume;
   - the background job, its status and its last run;
   - rollback, through Terminal when it needs approval.
6. **Events,** mostly read-only: status, pause and resume, rules, recent deliveries. Everything else stays in the CLI
   and MCP, which carry the events service's secret-handling rules. **(lead's call)**
7. **Doctor:** every check. A fix that is a command has Copy and Run in Terminal.

**Sign-ins and secrets** (adding a mailbox or workspace, pasting a bot token) are "Run in Terminal" only. The app never
handles a secret. **(lead's call)**

### DA6. Opening the terminal

The command is the located command, the stable launcher with its arguments, quoted for the platform.
- **macOS:** Terminal through `osascript`.
- **Linux:** `x-terminal-emulator`, then `gnome-terminal`, then `konsole`.
- **Windows:** `wt.exe`, then `cmd /k`.
- **Fallback:** copy the command and say so.

The command is built in Rust from the allow-list. It is never text taken from the CLI's output.

### DA7. Security

- **The webview's content policy:**
  - nothing remote: `default-src 'self'`, with no `connect-src` beyond Tauri's IPC;
  - no inline scripts beyond the pre-paint script, which is pinned by hash;
  - no remote images.

  Copy it, and the bundle check, from phase C.
- **Tauri capabilities,** the fewest that work: the tray, notifications, the opener (only for Terminal, and for
  `https://` links to slack.com and google.com that doctor fixes name), autostart, the deep link and the updater.
- **Rust:** the allow-list (DA4) and argument checks are unit-tested, including refusals of every argument that
  doesn't match.

### DA8. Packaging and release

- **Identity:** `com.cueplusplus.agentcomms`, product name **Agent Comms**. **(lead's call)** Its version follows the
  repository's: `sync-versions` writes `tauri.conf.json`.
- **CI:** `.github/workflows/desktop.yml` builds on macOS (Apple silicon and Intel), Windows and Linux, for any pull
  request that touches `apps/desktop`, and runs the app's tests.
- **The macOS release follows the siblings (lead's call).** `apps/desktop/scripts/release-desktop.sh` is adapted from
  QuotaMate's `release-menubar.sh`. On the owner's signing Mac it:
  - builds a universal binary;
  - signs it with the Developer ID certificate in the login keychain;
  - notarises and staples the app and the DMG;
  - refuses a dirty tree, or a commit that is not the tag's.

  Then `publish-desktop.sh` makes the GitHub release `desktop-vX.Y.Z` in this repository, with the DMG, the updater's
  `.app.tar.gz` and `latest.json`. The signing identity, the notary profile and the updater key stay on the owner's
  Mac, as they do for Supbuddy and QuotaMate. An agent may run these scripts once the owner has said so, as Supbuddy's
  `/release` does, with the version confirmed on the command line instead of typed back at a terminal:
  `release-desktop.sh desktop-vX.Y.Z --confirm X.Y.Z [--updater off]` and `publish-desktop.sh desktop-vX.Y.Z --confirm
  X.Y.Z`. **(the owner, 2026-10-21; 0.26.0 design R1, which replaces "An agent never runs these scripts")**
- **The updater** follows the siblings: tauri-plugin-updater with `requireSignedVersion`, a silent check 60 seconds
  after launch and then every 24 hours, and Check for Updates… in the tray. It reads `latest.json` from this
  repository's releases. **No token is baked into the app,** because this repository is public. An app built without
  the updater key (any CI build) has its updater off, and says so in Settings.
- **Windows and Linux:** `desktop-release.yml`, on a `desktop-v*` tag, builds an unsigned NSIS `.exe`, an AppImage and
  a `.deb`, and attaches them to that release. The release notes say they are unsigned. **(lead's call:** the siblings
  ship macOS only; these come at no cost from CI.**)**
- **Owner steps** go in `docs/RELEASING.md`: generate the updater key (`tauri signer generate`) into
  `~/.agentcomms/tauri-updater.key` with mode 600; put the signing environment in a `.env.desktop-release.local` that
  git ignores; then run the two scripts.

### DA9. Tests

- **The UI:** Vitest with a fake runner that returns recorded CLI JSON, covering every screen's loading, empty, error
  and populated states.
- **End to end:** Playwright against the Vite build, with Tauri's IPC mocked: the main flows of Overview, Approvals
  (revoke, Approve in Terminal), Agent (a tightening applied, a loosening sent to Terminal) and Updates.
- **Rust:** unit tests for the allow-list, the arguments, the terminal command for each platform, and the locating of
  launchers.
- **CI:** the three-OS build.
- **Never:** a real account, a real send, or the network from tests.

## 4. Out of scope (v1)

- Approving in the app.
- Sign-ins in the app.
- Managing the events service beyond what is listed.
- A bundled runtime.
- Auto-installing agent-communications.

## 5. Settled after the builder check (2026-10-19)

A fresh reader checked this design against the code at v0.21.0. Its findings are settled here. Where this section
and DA1 to DA9 differ, this section is the later word. All of it is **(lead's call)**.

### DA10. Approving and applying

`agentcomms approve <id>` only approves: the change applies when something runs it again with `--approval <id>`. So
the app works in two ways.

- **A change the app prepares** (the Agent form, update level, rollback, background job on, …):
  1. The app first gets the preview with `--json`, which exits 10 with `APPROVAL_PENDING`.
  2. It shows that preview with its own header, "Approve this in Terminal", in place of the CLI's.
  3. On the button, the app **revokes its own pending approval**, so the tray count is not inflated.
  4. It opens the terminal with **the change command itself**, without `--json`, built by the allow-list. The person
     confirms there, and the change applies there.
- **An approval an agent prepared** (a send, or a change): the button opens the terminal with that channel's
  `approve <id>`, through its own launcher. The agent that is waiting on it (`approval wait`) applies it, as today.
- **The app never runs a change with `--approval`.**

**Note, 2026-10-26 (0.32.0; owner decision of 2026-10-26: judges set up in the app).** For judges only, two rules
loosen. **The app approves a judge's enablements:** Events → Judges → Set up… runs the events service's `judge setup`,
which turns the kind on, and the judge budget when it has none for the judge's provider, as the person's own act —
recorded as approved through the app (events design, D2's note of the same day). The app still runs no change with
`--approval`, and still opens the terminal for every other approval. **The app handles one secret:** Settings → AI
providers takes a TypeSafe or OpenRouter key in a password field the window never keeps in its state, empties the field
as it sends it, and hands it to the twenty-second command, `provider_key_set`, which gives it to `provider key set` on
stdin — never argv, an environment variable, a log, a setting or a file — and overwrites its own copy when the call
ends. Every other token or secret stays at the terminal. Turning a judge off, and removing a key, apply at once.

### DA11. What a preview shows

- **Each waiting approval:** the summary `approvals list` gives (its kind, the enveloped recipients, subject and
  files), shown as plain text.
- **Changes the app prepared itself:** the full preview.
- **A command that reads back a stored preview** is future work: no release keeps the preview today, and keeping
  sender text at rest needs its own design.

### DA12. Launchers, folders, versions

- **Launchers:** all six, `<data>/launch/{core,gmail,slack,resend,whatsapp,events-daemon}`.
  - The app counts as having agent-communications when `launch/core` exists. Each channel's section appears when its
    launcher exists.
  - **On Windows** a launcher is a Node script. The app starts it with the Node path that this installation's managed
    receipt records, falling back to `node` on PATH.
- **Folders:** a Rust port of `resolvePaths`'s defaults from `packages/core/src/paths.ts`.
  - An app started from the Dock or Start menu sees no shell variables, so Settings offers overrides for the data,
    config and state folders.
  - **Every** CLI call passes all four folder pins, so the app and the CLI always agree.
- **Versions:** the app reads the installed version with `--version`. A section that needs a later CLI says "Update
  agent-communications to use this", rather than failing:
  - behaviour rules and profiles need 0.22.0 or later;
  - standing approvals need 0.23.0 or later;
  - the update status needs 0.24.0 or later.

  The app is built after 0.23.0 ships.

### DA13. Commands this release adds, and fixes

- **`agentcomms update --status`,** read-only, with `comms_update` `status: true` beside it. It returns as JSON:
  - the level and pause, and the last check, latest and running versions;
  - the background job's state and its last run.

  It asks npm nothing. It gets a `capabilities.json` row and tests.
- **`doctor --json`** prints exactly one envelope when a check fails. Today it prints a success envelope and then an
  error envelope.
- **The events CLI** keeps its bare JSON. The app reads both shapes.

### DA14. Doctor fixes and polling

- **A doctor fix** is shown with Copy. Running it from the app needs structured fixes, which are future work. This
  replaces "Run in Terminal" in DA5.
- **Polling:**
  - every 15 seconds, while the window is visible, only local reads:
    - `approvals list --state pending` for core and each channel;
    - `update --status`;
    - `agent-events status`;
  - every 60 seconds, for the tray badge: the approvals lists.
- **Doctors** run once when the app starts and whenever the Doctor screen is opened or refreshed. Slack's and Resend's
  run `--offline`. Gmail's only runs when the person asks, because it calls Google. Core's doctor never runs on a
  timer, because each run writes to the keychain.
- **The pre-paint script** is pinned in the content policy by its hash. That is new work: phase C had no inline script.

### DA15. Settled while planning (2026-10-19)

The plan (`docs/superpowers/plans/2026-10-19-desktop-app.md`) settles what writing it found against the code. Where it
differs from DA1 to DA14, the plan is the later word.
- **Approvals are polled through core only.** Every channel writes to one shared store, and only core lists it.
- **Windows Node** is read from the Windows launcher's second line.
- **Five folder pins,** where DA12 said four. Downloads is left to its default.
- **Stylesheet:** `@cueplusplus/ui` 0.29 also needs its theme stylesheet line and a `themes` prop.
- **Updates** are found through the GitHub API, among `desktop-v*` releases published with `--latest=false`.
- **The events CLI's** `--version` takes no folder pins.
- **Plugins:**
  - notifications are dropped;
  - clipboard, single-instance and opening files are added.
- **On Windows,** the tray shows the count in its tooltip.
- **Updater artifacts** are switched on only by the release script.

**Licence notices (lead's call).** The app ships a `THIRD_PARTY_LICENSES` file, as phase C did. A script in
`apps/desktop/scripts/` writes it from two sources: the JavaScript dependencies the bundle includes, read the way
`scripts/third-party-licenses.mjs` reads the packages; and the Rust crates in the build, read from `cargo metadata`
(name, version, licence expression), with the licence texts taken from each crate's own files. No new tool is
installed. A check in CI fails when the file is out of step.

### DA16. Settled after review (2026-10-19)

Two independent reviewers read the app, its CI and core's additions before 0.24.0. Where this list and DA1 to DA15, or
the plan, differ, this list is the later word.

- **Folders are on this machine's own disks.** Settings refuse a network share for every folder, in any form:
  `\\server\share`, `//server/share`, `\\?\UNC\…`, `\\.\UNC\…`, and an address such as `smb://…`; on Windows only a
  drive's root starts a folder. A drive letter mapped to a share looks local, and is not told apart. **(lead's call,
  after review)**
- **A launcher runs only when it is safe to.** Never one on a network share, whatever named the folder. On macOS and
  Linux, the launcher and its `launch` folder must belong to this user and be writable by nobody else, as core writes
  them; otherwise the run and the terminal line are refused (`APP_UNSAFE_LAUNCHER`), saying `chmod go-w <path>`. The
  data folder above it is not checked. Settings show `<data>/launch/core` and why the app would not run it.
  **(lead's call, after review)**
- **Windows Node:** the PATH fallback skips every entry that is not a full path. **(lead's call, after review)**
- **What a child gets of the app's environment** — a CLI run, or the terminal — is an allow-list: `HOME`,
  `USERPROFILE`, `PATH`, `LANG`, `LC_*`, `TMPDIR`, `TMP`, `TEMP`, `SystemRoot`, `SYSTEMDRIVE`, `APPDATA`,
  `LOCALAPPDATA`, `XDG_*`, `USER`, `USERNAME`, `LOGNAME`, `SHELL` and `TERM`, as the review listed, and four it needs
  besides: `WINDIR`, `COMSPEC` and `PATHEXT`, which Windows programs read, and `DBUS_SESSION_BUS_ADDRESS`, through which
  Linux reaches the keyring and gnome-terminal its server. A terminal also gets `DISPLAY`, `WAYLAND_DISPLAY` and
  `XAUTHORITY`, since it opens a window. Never, whatever else allows it: a name with `_AGENT` in it, `CI`,
  `CLAUDECODE`, `CODEX_HOME`, `AGENT_*` (the pins name the folders), `NODE_*`, `LD_*`, `DYLD_*`, `GIO_*`. Names are
  compared without case on Windows. **(lead's call, after review)**
- **The updater finds its release through the tags.** It lists `desktop-v*` with `git/matching-refs/tags/desktop-v`,
  takes only `refs/tags/desktop-v<major.minor.patch>`, and asks for the release of each by tag, highest first, at most
  five; a release counts only when it is that tag's, published, and carries the `latest.json` this repository serves
  for it. This replaces DA15's search of the releases list, which held 30 to a page, and so lost the app's release
  once thirty CLI releases came after it. **(lead's call, after review)**
- **A change opens only with the approval the app prepared for it.** `cli` records each `APPROVAL_PENDING` id a
  change the app prepares comes back with, and its call; a `Change` is refused unless its `revoke` id was recorded for
  an equal call, and takes it once. A fourteenth command, `revoke_preview`, revokes only such a recorded id, for a
  preview that is cancelled or left behind, and keeps the record when the revoke did not happen. **(lead's call, after
  review)**
- **A preview left behind revokes its own approval** when it goes — the screen changed, or the next change replaced
  it — unless Approve or Cancel already did, so the tray never counts an approval nobody will look at again. Cancel
  says "Cancelled" only once the revoke worked, and otherwise shows why and keeps the preview. **(lead's call, after
  review)**
- **A word that starts with `=` or `~` is quoted** for a POSIX shell, by the app and by core: zsh reads `=ls` as a
  command's path. **(lead's call, after review)**
- **No single-instance plugin on macOS.** Launch Services keeps one copy and hands it each later link, which the
  deep-link plugin's open-url takes; the plugin's socket in a shared temporary folder would let another local user stop
  the app. It stays on Windows and Linux, where a second launch is how a later link arrives. **(lead's call, after
  review)**
- **Windows is tested on Windows.** `cfg(windows)` tests hand cmd.exe the line as the app does, with Node — the
  program that runs a launcher there — printing its words. The folder parity fixture holds Windows cases recorded from
  core's own `resolvePaths` with `node:path` answered by `path.win32`; they run on every host, since the port builds
  paths for the platform it is given, and a vitest file re-checks them against core. **(lead's call, after review)**
- **Open link takes three hosts, exactly:** `api.slack.com`, `myaccount.google.com` and `console.cloud.google.com`,
  the pages doctor fixes, and the hints a failing check carries into one, send a person to. Never another host of
  Slack's or Google's, and never a `/url` path, Google's redirect. This replaces DA7's "slack.com and google.com".
  Copy is unchanged: it keeps line breaks and tabs, since a fix is often several lines, and refuses every other
  control or format character; a line or paragraph separator is not refused there, as it is in a terminal line.
  **(lead's call, after review)**
- **A signed release may have its updater off.** With `plugins.updater.pubkey` empty, `release-desktop.sh` still
  builds, signs and notarises the DMG, with no updater artefacts and no key in the build's environment, after the owner
  types `off` (or, run with `--confirm`, is given `--updater off`; 0.26.0 design R1); `publish-desktop.sh` then
  publishes without `latest.json`, and says the updater stays off until the key is committed and the next version
  released. With a pubkey, the key must be there, mode 600 and the pubkey's, or the release is refused — checked before
  the signing environment is read. **(lead's call, after review)**
- **The DMG is notarised with a notarytool keychain profile** (`agentcomms-notary`, or `AGENTCOMMS_NOTARY_PROFILE`),
  so no password is on a command line. Tauri still reads `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` from its
  environment to notarise the app. **(lead's call, after review)**
- **Only a draft is written to.** CI's bundle legs build with read-only access and hand their files on as artifacts;
  one `attach` job, which checks nothing out, uploads them, and only while `isDraft` is true. The draft job, and
  `publish-desktop.sh`, refuse a release already published. **(lead's call, after review)**
- **npm's publish job builds the packages alone** (`pnpm -r --filter "./packages/**" run build`): the app is never
  published, and is not built where npm's OIDC identity is held. **(lead's call, after review)**
- **Rust is pinned** by `apps/desktop/src-tauri/rust-toolchain.toml`, at 1.94.1, the version used locally; both
  workflows install it, and the signing Mac adds its targets to it. `desktop.yml` also runs for every file outside
  `apps/desktop` that the app's checks read. **(lead's call, after review)**
- **`update --status`:** a background job that cannot be read is `job.state: "unreadable"`, with a `reason`, and the
  rest is read all the same; the app shows the reason. Over MCP, `status: true` neither carries the update notice nor
  starts the server's own check. `--status --no-verify` is a usage error, as `--status --approval` is. **(lead's call,
  after review)**
- **Smaller things.** Only the latest-started read of the approvals, the update status or the events service is kept,
  so a slow poll cannot put back a revoked approval. A rollback with nothing to go back to (`ok`, exit 69) shows what
  the CLI said. Ending every standing approval shows core's `partial` notes. Base UI writes no `<style>` element
  (`CSPProvider disableStyleElements`), and the scrollbar rule it would have written is in the app's stylesheet.
  Playwright never reuses a server already on its port. **(lead's call, after review)**
- **Laya, the local judge, on the Events screen,** when the events service's phase E2 ships it. This replaces D13's
  Judges screen for Laya, which approved in the app.
  - **Its state is shown read-only:** the events service's `idle | installing | downloading | verifying | ready |
    failed | unavailable`, the bytes verified of the total, and its stable reason codes, as plain text. A new call in
    the allow-list, `eventsJudgeModelStatus`, reads them: `judge model status`, through `<data>/launch/events-daemon`.
  - **Enable opens the terminal** with `judge kind enable laya`, through the same launcher. The service's preview and
    its approval happen there; the app never approves.
  - **Disable applies at once,** through another new allow-listed call, `eventsJudgeKindDisable` (`judge kind
    disable laya`): it is a tightening.
  - Removing the model files stays in the CLI and MCP.
  - **No model, runtime, worker or Laya artifact ever enters the app's bundle,** and the bundle check refuses one.

  E2's plan, Task 11, builds this. **(lead's call, 2026-10-19)**
