# 0.27.0: the desktop app updates itself, runs the event service, and is redesigned

Design, 2026-10-24. Builds on the desktop app's design (`2026-10-19-desktop-app-design.md`, DA1–DA16); where the two
differ, this one is the later word.

## 1. What was asked

The owner tried the desktop app on 2026-10-24 and asked for three things.

- **"Why did we not do an automated update system just like in QuotaMate and Supbuddy?"** They chose to turn it on in
  0.27.0, the next real release, rather than in a patch with nothing else in it.
- **The event service, without a terminal.** The app showed "the event service is not running". It runs only while a
  terminal runs `agent-events run`.
- **A sleeker app.** In the owner's words:
  - "I don't like how the UI looks with these panel things, a lot of lines, a lot of text, and the fonts are not
    clear";
  - "I don't want you to use too harsh fonts. I don't want it to look very terminalish";
  - "whenever we have tabs … the tab highlight should glide … tabs should swipe and feel very smoothly integrated";
  - "We want the latest versions of the GUI to have micro-interactions";
  - "a good example of how things look is the Linear app". Supbuddy and QuotaMate "look good", especially QuotaMate's
    soft panels in its new Mac menu-bar app.

**Their wider vision, which is not this release** (§5):
- an audit of what agent sessions read, were told about, acted on and sent;
- a queue of actions that rules feed;
- routing work to agent sessions, and "lanes" across projects.

The owner agreed this order on 2026-10-24.

## 2. What is true (read 2026-10-24)

**The updater**
- `apps/desktop/src-tauri/src/updater.rs` is built (DA8, DA15):
  - It uses `tauri-plugin-updater` with `requireSignedVersion`.
  - It finds the newest published `desktop-v*` release that carries a `latest.json`, through GitHub's API, with no
    token.
  - It checks silently 60 s after launch, then daily, and has a manual "Check for Updates".
- It is off for one reason: `plugins.updater.pubkey` in `tauri.conf.json` is empty, so no updater key was ever made.
  `docs/RELEASING.md`, "The desktop app", steps 1–2 say how to turn it on.
- Once the pubkey is committed, `release-desktop.sh` builds the signed updater archive, and `publish-desktop.sh`
  uploads `latest.json`.

**The event service**
- `agent-events run` is a foreground owner of the event database. It stops on `agent-events stop` or when its terminal
  closes.
- The daemon's README says it has no background mode, and that "the desktop app will supervise it later".
- On the owner's Mac its database was made on 2026-10-17 and has not been touched since.
- It refuses to run on Windows (B1-G).

**Supbuddy's patterns, the owner's reference**
- **Updates:** it checks silently a minute after launch and then daily. An available update lights a dot and a menu
  item, and installing is the person's click.
- **Its daemon:** the app supervises it, a watchdog restarts it if it dies, and quitting asks whether to stop it.

**The current look**
- The app is on `@cueplusplus/ui` 0.29.0, the latest published version, with theme `cue`, density `compact`.
- Theme `cue`'s fonts include JetBrains Mono, which gives the monospaced headings and labels the owner calls
  terminal-ish.
- Every group is a bordered panel with a ruled header.
- Each screen explains itself in sentences.

**QuotaMate's look** (`cueplusplus/quotamate`, `apps/menubar/src/style.css`):
- the system font (`ui-sans-serif, system-ui, -apple-system`) at 11–14 px;
- soft panels: three surface shades with rounded corners, instead of borders and rules;
- short eased transitions, and swipeable tabs.

**The login item** can go unanswered on a Mac whose login-items service is down. desktop-v0.26.2 bounds it; keep that
behaviour (`login_item::within`).

## 3. Decisions

### D1. The app updates itself

- **The key.** The updater key is made once, on the owner's Mac, by the agent, with the owner's yes:
  - Use `pnpm --filter @agentcomms/desktop tauri signer generate -w ~/.agentcomms/tauri-updater.key`, mode 600.
  - Its password goes in `.env.desktop-release.local` as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  - Never print the key or the password.
  - The owner backs both up, because a lost key means installed copies can never update again.
  - Its `.pub` goes into `plugins.updater.pubkey`, which is committed.
- **Behaviour, as built:**
  - It checks silently 60 s after launch and then daily, and "Check for Updates" checks at once.
  - **(Owner's reference: Supbuddy.)** An available update shows a dot on Settings and in the tray menu, never a
    pop-up.
  - Installing is always the person's click. It downloads, verifies the signature, installs and relaunches.
- **Nothing installs on its own.** That is an anti-goal (§4).
- **The first update.** 0.27.0 is the first copy with the updater on, and the owner installs it by hand. From 0.27.1,
  installed copies update themselves.
- **The release scripts already handle the key.** With the pubkey committed, `release-desktop.sh` refuses to run
  without the key and builds the updater archive, and `publish-desktop.sh` uploads `latest.json`. The agent runs them
  as before, with `--confirm` and without `--updater off`.

### D2. The app runs the event service

- **On, by default, where it can run.** The Events screen has a "Run the event service" switch. The app keeps the
  choice (on unless switched off) in its own settings. On Windows the switch is absent, with one line saying why.
  - The service collects nothing until a rule is approved at the terminal, so running it idle costs little.
- **Starting it.**
  - The app starts `<data>/launch/events-daemon run` (DA4's launcher and allow-list, no shell) in a session of its
    own, so it can outlive the app.
  - Output goes to `<state>/events/service.log`, kept under 1 MB, with the older half dropped.
  - A service already running, started from a terminal, is adopted, not started twice. The daemon refuses a second
    owner anyway.
- **Watching it.**
  - While the app runs, it asks `agent-events status` every 15 s. If the service is wanted and not running, the app
    starts it again, waiting 1 s, 5 s, then 30 s between tries.
  - After 5 failed starts within 10 minutes it stops trying. The Events screen then says so, with the last lines of
    the log and a "Try again" button.
  - Each restart is shown as a quiet line: "Restarted 2 min ago".
- **Stopping it.** The switch's off runs `agent-events stop`. Quitting the app asks once "Keep the event service
  running?". The answers are **Keep running** (the default) and **Stop it**, with "Remember my answer".
- **At login.** If the app starts at login and the service is wanted, it starts.
- **Unchanged:**
  - The app never approves anything: rules and enable-all are still approved in Terminal (DA10).
  - The service owns its database.
  - Laya stays off.

### D3. The redesign

**References:**
- **Linear:** calm, dense, quiet type.
- **QuotaMate's soft panels.**
- **Supbuddy:** the owner likes both it and QuotaMate.

**How it is built:** with `@cueplusplus/ui` 0.29.0 and its rules (the `cue-ui` skill). The `impeccable` skill drives
the layout, typography, copy and motion: a critique of each screen, then shaping, then polish. The agent's choice of
skill; the owner named three. No component library of the app's own.

**Type:**
- One sans-serif face for everything: the system font on macOS (SF Pro), Inter elsewhere. Set it through cue-ui's
  font pairing, not by overriding components.
- Monospace only where a value is literal: paths, ids, commands.
- Body text at 13 px, secondary at 12 px, headings at 15–20 px.
- No all-caps monospace labels.

**Surfaces:**
- Soft panels: filled, rounded surfaces in cue-ui's surface shades, with no border and no ruled header.
- A divider only where two lists would otherwise run together.
- More space between groups, less inside them.

**Words:**
- Each screen says what is true in a few words. Explanations go in a hover hint or behind "Learn more".
- Copy shrinks by about half.
- What a sender wrote still shows as plain text, marked *From outside* (DA5).

**Motion and micro-interactions:**
- **Tabs:**
  - Every tab bar has a highlight that glides to the chosen tab: a transform, about 200 ms, ease-out.
  - Tab bars, and the sidebar's sections, can be swiped with a trackpad or touch. The content slides in from the
    side it came from.
- **Feedback:** hover and press feedback on every control; lists that fade or slide items in and out; counts that
  roll.
- **Speed:** nothing a person waits through lasts more than 250 ms.
- **Reduced motion:** with "reduce motion" on, highlights jump and nothing slides.

**Settings:**
- Folders shows the four folders in use.
- The override fields go behind "Change folders…", because they are needed only by someone who keeps agentcomms'
  folders elsewhere.
- The updater (D1) and the login item sit at the top.

**Every screen is reworked** in turn: Overview, Accounts, Approvals, Agent, Updates, Events, Doctor and Settings.
- **No change in behaviour or information:** every status, warning, number and action that is there now stays, and
  the tests that pin them are kept, with only their selectors updated.
- **Screenshots:** for each screen, in dark and light, before and after, taken from the app running against the test
  fixtures in a browser.

**Theme:**
- Light, dark and system stay.
- The appearance menu keeps its choices, with the new type as the default.

## 4. Goals, non-goals, anti-goals

- **Goals:**
  - From 0.27.1 the app keeps itself current with one click.
  - The event service runs without a terminal and comes back by itself.
  - The app looks and moves like Linear, QuotaMate and Supbuddy.
- **Non-goals:**
  - The audit, the action queue, routing and lanes (§5).
  - Approving or signing in from the app.
  - A Windows event service.
- **Anti-goals:**
  - An update installed without the person's click.
  - A service running after the person switched it off.
  - A redesign that hides a warning or a number someone relied on.
  - A terminal look.
  - Paragraphs of explanation on screen.
  - Motion that makes a person wait.

## 5. Next, in the order the owner agreed (not this release)

1. **An audit in the app:**
   - what agent sessions read, were told about, acted on and sent;
   - which session did it, by project folder;
   - when, and the outcome.
   Sends and approvals are recorded today; reads and the session behind each act are not.
2. **A queue of actions:** a rule target that puts each match in a list in the app, with what the judge said it is
   about.
3. **Routing to agent sessions and "lanes":** research first. How a running session can be reached and woken without
   polling is not known yet.

## 6. Left to the builder

- How the gliding highlight and the swipe are built: Base UI's `Tabs.Indicator`, CSS transforms, or
  pointer/wheel events, within cue-ui.
- The exact surface shades and radii, within cue-ui's tokens.
- The service log's rotation, within the 1 MB bound.
- How the watchdog's state reaches the window: an event, or polling.
- The release: 0.27.0 for every package, since the app shares the repository's version, and `desktop-v0.27.0`, with
  its changelog section.

## 7. Settled after the builder check (2026-10-24)

A builder read this design cold and asked seven questions. Six are settled here as the lead's calls. The seventh,
whether the new look is approved before every screen is reworked, is the owner's (§7.6).

### D4. A stop is a stop (lead's call)

The watchdog restarts only a service that **crashed**. That is a service the app started, which then exited by a
signal or a non-zero code.
- **A clean exit counts as switched off.** That covers `agent-events stop` at a terminal or through the
  `events_stop` tool, and a clean shutdown. The switch turns off, and the Events screen says "Stopped from outside at
  <time>".
- **An adopted service** (started from a terminal) that goes away is not restarted, because it was never the app's.
  The Events screen offers Start.
- This needs nothing from the daemon. The app watches the exit of its own child.

### D5. A new version of the service (lead's call)

When the background update moves `launch/events-daemon.current` to a new version, the app restarts the service on
it within a minute, and the Events screen says so.
- The daemon stops cleanly and resumes from its database, as it does after `agent-events stop` and `run`.
- The app restarts only a service it started. An adopted one is told about with a "Restart to use <version>" button.
- **This overrides the events design's D12** ("a normal available update does not stop the daemon") for a service
  the desktop app runs, and fills D15's "update recovery". The events design gets a dated note in this release saying
  so.

### D6. macOS privacy access for WhatsApp (lead's call)

A service the app starts counts as the app's to macOS. So reading WhatsApp's local database
(`~/Library/Group Containers/…`) needs **Agent Comms** to have Full Disk Access, as Terminal has it today.
- The Events screen and the doctor check this only when a WhatsApp source is in use.
- They say "Give Agent Comms Full Disk Access", with a button that opens that pane of System Settings.
- The service keeps running for every other source until access is given.
- launchd is not used: it would need the same access for the Node binary, which is harder to explain.

### D7. Tabs, swipes and the gliding highlight (lead's call)

- **The highlight glides on every switcher:** the sidebar's selection between sections, every segmented control (the
  update level today), and any tab bar the redesign adds.
- **Tab bars are added only where a screen has distinct views:**
  - Accounts, one tab per channel;
  - Approvals, waiting and recent;
  - Events, status, rules and deliveries.
  - A tab whose view holds a warning carries a count badge, so nothing is hidden behind a tab.
- **Swiping moves between the tabs of a screen's own tab bar,** with a trackpad's two-finger swipe or touch.
  - It does not move between sidebar sections.
  - It is ignored over anything that scrolls sideways itself: tables, code blocks, long paths.

### D8. The first start after the upgrade (lead's call)

If collection was already switched on in the event database (`enable-all` approved) and any rule is enabled, the
first automatic start after the upgrade asks once:
- "The event service will resume <n> rules. Start it now?";
- the choices are **Start** and **Not now**;
- **Not now** leaves the switch off until it is switched on.

With nothing enabled, the service starts silently, as D2 says. So a week's backlog is never delivered without the
person knowing.

### D9. The events design (lead's call)

- **This design overrides the events design's D12** for the desktop app: Keep running is the default when quitting,
  and the service starts at login with the app.
- **The events design gets a dated note** in this release (Appendix A is untouched).

### D10. Monospaced headings (lead's call, from the check)

The app already uses cue-ui's `system` font pairing, so its sans-serif face is SF Pro on macOS. The headings, chips
and description terms are monospaced because those components default to mono. cue-ui's style sets and
`--cue-style-*-face` tokens change that without overriding any component, so they are what changes it.

### 7.6. The owner's question, answered

Should the new look be approved before every screen is reworked, at a checkpoint after the type, surfaces, tabs and
one screen?

**The owner (2026-10-25): "Build it all, then show me."** All eight screens are reworked straight through. The owner
sees the finished app, with screenshots in dark and light, before 0.27.0 is tagged.

## 8. Split into two releases (the owner, 2026-10-25)

Checked against `@cueplusplus/ui` 0.29.0, the installed package and the cue-ui repository at `05e80433`. The mockup's
look needs five things cue-ui does not have.

1. **A label typeface separate from the code face.** About twenty components set labels in `font-mono` directly: the
   sidebar, tabs ("mono labels"), chips, description lists, title and app bars, items, pagination, empty states. Only
   page titles route through `--cue-style-display-face`.
2. **A soft panel.** `Panel` is "one hairline rim, one raised surface, one radius", with a ruled `PanelHeader`. The
   `quotamate` theme (1.1.2) softens the rim colour but keeps it. QuotaMate's soft panels are its menu-bar app's own
   CSS.
3. **Gliding highlights.** Tabs draw an accent underline, with no `Tabs.Indicator` wrapped. `SegmentedControl` tints
   the active segment. `Sidebar.Item` marks `active` statically.
4. **Swipeable tabs** that slide their panels in from the side they came from. `layout/carousel` (Embla) exists, but
   nothing joins it to `Tabs`.
5. **Motion tokens:** durations and easings. Components transition colours only.

Present already: `Switch`, `Row` with `interactive` hover, `surface-1` to `surface-3`, the radius tokens, the theme
packages, and `motion-reduce` on colour transitions.

**The owner chose to split the release:**
- **0.27.0** ships D1 (the updater) and D2, D4, D5, D6, D8 and D9 (the event service run by the app), on today's
  look.
- **0.28.0** ships the redesign (D3, D7, D10), built once cue-ui has the five pieces.

**The five pieces are requested from cue-ui** as one Linear issue (Cueplusplus team, project agent-communications),
plus the matching `cue-ui-NN` reports in cue-ui's `docs/feature-requests`.

**The mockup the owner approved for the look:** https://claude.ai/artifact/7Z14fMx8Cp3fPfjtxDDJKj

**A sixth ask, a theme of its own** (the owner, 2026-10-25: "I really like the generic look and feel… we may want to
have this one as a dedicated new theme"):
- a new cue-ui theme preset, like `quotamate`, built from the mockup's colours, type, radii and soft shadows;
- the values are listed in CUE-571, item 6;
- 0.28.0 uses that preset.
