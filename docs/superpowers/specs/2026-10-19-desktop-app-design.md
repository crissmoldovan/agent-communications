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

**QuotaMate** (`cueplusplus/quotamate`) is a Next.js web app with no desktop shell. Its use of `@cueplusplus/ui` is
the reference:
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
- **Releases:** `desktop-release.yml`, on the same `v*` tag as the npm release, builds the installers and attaches them
  to that GitHub release: a `.dmg`, an NSIS `.exe`, an AppImage and a `.deb`.
- **Signing and notarisation** use repository secrets when they exist: Apple's Developer ID certificate, notarisation
  credentials, and Tauri's updater key. **When they don't,** the workflow still builds:
  - macOS is signed ad hoc;
  - Windows is unsigned;
  - no updater files are made, and the app's updater is off.

  The release notes say which applies.

  Only the owner can create a signing identity, so `docs/RELEASING.md` gains the owner's steps:
  - generate the updater key (`tauri signer generate`), and add it and its password as secrets;
  - add the Developer ID certificate and the notarisation credentials as secrets.
- **The updater** reads `latest.json` from this public repository's releases. **No token is baked into the app**,
  unlike Supbuddy, because the repository is public.

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
