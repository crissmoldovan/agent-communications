# Agent Comms 0.34.0: the soft look from cue-ui, and screens that explain themselves

Date: 2026-10-26. Status: part A built on `feat/0.34-soft`; part B drawn and waiting for the owner's comments on the
prototype (https://claude.ai/artifact/7c5V9GpXw4ydjnD6jN6woh, files in `docs/prototypes/2026-10-26-0340-rework/`).

## 1. Why

Two things arrived on the same day.

- **cue-ui shipped CUE-571** (cue-ui 0.34.0 and `@cueplusplus/theme-soft` 1.0.0): everything the 0.28.0 redesign had
  faked locally — the sans faces, rimless panels, the soft palette — plus the gliding marks and swipeable tabs the owner
  asked for. cue-ui asked Agent Comms to adopt it, confirm it in the real Tauri window, and report on CUE-571.
- **The owner tried the 0.34 test build** and found screens they could not read. In their words: "I don't understand
  what it says behind 'core'" (Connections); "It says it's running, but below it says 'collecting off.' Why?" (Events);
  "the agent itself is not really understandable… let's figure out how we can do this, improve this, and rework this"
  (Agent); "I don't see any control for the MCP. That should be a separate section"; and a Doctor layout that broke check
  names one letter a line. They chose to move each account's agent settings into that account.

Part A is the first; part B the second. Both ship as 0.34.0.

## 2. Part A: the soft look from cue-ui (built)

Commits on `feat/0.34-soft` from a225410e (0.33's head): 0e39cf33, f30bfd7b, 7baf1236, c9226b62, e75a9e96, e4091d28,
7ee92de6, ec814382.

- **A1. Versions.** `@cueplusplus/ui` and `@cueplusplus/tokens` 0.34.0, `@cueplusplus/theme-soft` 1.0.0,
  `@fontsource-variable/inter` 5.3.0 and `@fontsource/ibm-plex-mono` 5.3.0 (both OFL-1.1, no dependencies).
  `theme-base` 1.4.0, `theme-cue` and `theme-terminal` 1.1.2 unchanged (their peer ranges fit). The three cue-ui
  versions are in `minimumReleaseAgeExclude` until 2026-10-27T13:37Z.
- **A2. Theme.** `@cueplusplus/theme-soft` replaces the app's own `src/themes/soft/` copy and both interim CSS blocks
  (cue-ui-77, cue-ui-78). A manifest cannot name a style set, pack or font, so `theme.ts` pairs each theme with its
  look (`LOOKS`): soft wears the `soft` set, the `inter` pairing and the `glaze` pack; cue and terminal the `system`
  pairing with the library's default set and pack, stored as real values so they do not fall back to soft's.
  The provider prop is `font`, not `fontPairing` as cue-ui's notes say.
- **A3. The stored look resets once.** The storage key becomes `agent-comms.look.v2`: a look stored by 0.28–0.33 has
  no set or pack, and under the new defaults a stored cue or terminal would open in soft's set. The app opens once on
  soft at the normal rung, as 0.28.0 did. Carrying the old choice over is a possible follow-up.
- **A4. What stays local** (`src/soft.css`, scoped to `[data-theme="soft"]`): the style values the approved mockup
  needs and 0.34.0's soft set leaves unset — the data, body, title and page-title faces, label and chip sizes and
  weights, the segment and tab track, the nav ground, the field fill, row and section rules, `--cue-measure-wide`, a
  motion scale of 1.1 — and the app shell's bar, brand cell and sidebar rims, which cue-ui-78 did not reach. A test
  fails as soon as cue-ui's set declares any of them, so each can go then. Each is reported to cue-ui as a gap.
- **A5. Fonts.** Inter and IBM Plex Mono are bundled by Vite into `assets/` and load under the unchanged content
  policy (`default-src 'self'`; no `data:` and no remote font, which the bundle check now refuses).
- **A6. Glides.** `<Tabs.Indicator />` in every `Tabs.List`, `indicator` on every `SegmentedControl` and the sidebar.
- **A7. Swipe.** `swipe` on the five page-level tab strips (Agent, Approvals, Queue, Events, Accounts).
  `data-tabs-swipe="ignore"` on the rule text editor's panel and the rule JSON block, which scroll sideways themselves.
- **A8. Reduced motion.** cue-ui's own: the marks' shared class turns transitions off, and the swipe's slide and fade
  apply only when motion is allowed. Nothing added.
- **A9. Layout fixes the owner found** (ec814382): a Doctor check's name keeps a third of its row beside a long detail,
  and its fix has a line of its own; Overview's and Events' label-and-value lines let a long value wrap.
- **A10. The approved mockup** is kept in `docs/prototypes/2026-10-24-soft-look/` (7ee92de6), so it opens from any
  Claude account.

**Open in part A:**
- **The face on macOS** (the owner's call). The desktop design (2026-10-24, §D3) says SF Pro on macOS and Inter
  elsewhere, and 0.28–0.33 showed SF Pro. cue-ui's Soft Look and the mockup itself use Inter, as this build does. No
  single pairing gives "SF Pro on macOS, Inter elsewhere"; `apple` gives SF Pro on macOS and the platform face
  elsewhere. Drawn side by side on the prototype's "Which face?" board.
- **The trackpad swipe** has not been tried on a physical trackpad; the owner tries it in the test build.
- **Report on CUE-571**: drafted for the owner to approve before it is posted.

## 3. Part B: screens that explain themselves (drawn, not built)

Grounded in a read of the code at `feat/0.34-soft` (2026-10-26); the owner's comments on the prototype may still change
the screens, not the mechanisms. Each item names what the person sees, the calls behind it, who approves what, and what
is new behind the screen.

**How approval works in the app today, which every item below reuses.** On macOS the app may approve a change itself
when the CLI it starts proves, by `codesign` on its parent's pid, that the app started it (`desktopAppOrigin`, core
`src/desktop-origin.ts`). Core runs this for `mcp install --app-approval` only: the function behind it,
`appliedFromApp` (`change-flow.ts` 402–487), takes any change, but `cli.ts` refuses the flag elsewhere (720–724). The
event service runs the same check (`personSetupOrigin`, `program.ts` 815–867) for `judge setup`, `provider key
set|remove`, `integration set agent-sessions` and `rule approve`. On Windows and Linux nothing attests the app, so each
refuses with `ORIGIN_UNATTESTED` and the app offers Do it in Terminal. A change that only takes away (a tightening)
applies at once, from anywhere. The check is a speed bump against agents, not a boundary against code running as the
person, and the docs say so.

### B1. Your agents (replaces the Agent screen)

- **Sees:** first, what people see: a Slack message `<name> (<word>): …` and an email From line
  `"<name> (<word>)" <address>`, built from `label` (name, word) and the first Gmail account's address (a placeholder
  when there is none). With no name set, the email line says the name comes from Gmail's "Send mail as". Then **Your
  name** and **The word after it**, each with Change…; then **Exceptions** (label rules) with Remove and Add…; then one
  line per account (what agents may do and how they look there, from `label.accounts` and `behaviour.accounts`), each
  opening that account (B2).
- **Calls:** reads `label`, `behaviour`, `accounts` (exist). Changes are new desktop calls for `label word`, `label
  name`, `label rule add|remove`: each loosening (a new word or name, an exception that drops the tag) is prepared,
  shown in `ChangePreview`, and approved in the app; each tightening applies at once.
- **New behind it:** core accepts `--app-approval` on the `label` commands (lift the refusal at `cli.ts` 720 for them
  and pass `appApproval` at 1198), with its wording no longer "mcp install only" (`change-flow.ts` 399–400 and 447,
  `approvals.ts` 414–417, `cli.ts` 274 and 390). The app gets the call rows, their `prepares_change` and
  `answers_app_approval` entries, and a version gate (`LABEL_APP_APPROVAL_VERSION = '0.34.0'`).

### B2. Each account's "Agents here" (the owner's choice: per-account settings live in the account)

- **Sees:** Accounts gains a page per account (opened from its row, as a delivery opens from Deliveries), with an
  **Agents here** section:
  - **What agents may do here:** a switch per act the channel has (Slack: post, reply, reaction, edit, delete, file;
    Gmail: send, reply; Resend: send). Off applies at once; on asks for approval. Below, **In one conversation** (Slack)
    or **For some people** (Gmail: an address or `@domain`), each an override with Add… and Remove.
  - **How their messages look here** (Slack only): as the Agent Comms app (Slack's APP badge) or as you, tagged, each
    with a preview; "Where the app can't post, such as a direct message, it goes as you, tagged."
  - **Replies approved in advance** (Slack only): each standing approval for this workspace, with its contents, places,
    limits, uses today and end; End and End all. Making one stays at the terminal, with its code: the store refuses an
    app approval for anything but a change (`approvals.ts` 1470–1476), and a standing reply is sent only on a
    terminal approval (`standing-use.ts` 151–160). The section says "An agent can prepare one; you approve it at your
    terminal."
  - WhatsApp has no behaviour rules (`behaviour` leaves it out); its account page shows no Agents here section.
- **Calls:** `behaviourAllow`, `behaviourClear` (exist; a loosening now approved in the app), `standingRevoke`,
  `standingOff` (exist), new `standingNarrow` (a tightening, applies at once), new `labelStyle` (`labelled` loosens,
  `app` tightens). Rows stay mounted while a preview waits, since unmounting revokes it (`ChangePreview.tsx` 17–21).
- **New behind it:** core's `--app-approval` on `behaviour allow|clear` and `label style` (`cli.ts` 1235). Standing
  approvals match their workspace by its current alias.

### B3. MCP servers (replaces Connections)

The owner asked why there are six servers and how to add them at once. They stay six processes (the channel design,
2026-09-26: isolation, an app given only what it needs, fewer tools in each model's context), but the screen speaks of
one thing, Agent Comms, per app. **Proposed, awaiting the owner's yes:**

- **Sees:** one row per AI app on this Mac (Claude Code, Claude Desktop, Codex, Cursor): "Agent Comms connected, with
  Gmail, Slack and Events", or "Not connected". **Connect Agent Comms…** adds, in one approval, everything the person
  uses: the core, each channel with an account here, and Events when the event service is installed. **Choose parts…**
  opens per-server switches for an app that should have fewer. **Remove** applies at once (`mcp uninstall`, exists).
  With nothing connected anywhere, the screen opens on "Agent Comms isn't connected to any of your AI apps yet" and a
  Connect button per app. **Who can reach them** stays.
- **Up to date, by one yardstick.** Today's "behind core" compares an entry with the core answering, while `update`
  compares with npm's latest release, so a newer test or dev core shows entries "behind" that `update` will not touch.
  The screen uses `update`'s yardstick (`update --check`): "An update is available" and **Bring everything up to date**,
  which runs `update`, approved in the app. For entries on the stable launcher it moves every app at once, which is
  what the person wants. The test build keeps a banner: "Your apps start your real Agent Comms (0.30.0), not this test,
  and nothing can be changed here."
- **New behind it:**
  - core `mcp install --client <c> --server <a,b,c>`: one plan, one preview naming every server, one approval, applied
    server by server, the approval revoked if any fails (as `appliedFromApp` does for one);
  - core `--app-approval` on `update`, and a desktop `update`/`updateCheck` pair of calls;
  - capabilities rows for the new option (CLI and MCP parity: `comms_server_install` takes the same list).

### B4. Events → Service, in plain words

- **Sees:** one line that says what is true and what it means: **Switched off** ("running, but not watching your
  accounts, so no rule does anything") with **Switch on…**; **On** ("watching acme/gmail and acme/slack; 2 rules
  active") with Pause and Switch off; **Paused** ("not watching since 14:02; nothing new is collected") with Resume.
  Pause and Resume show only where they do something.
- **Calls:** status (exists); Pause, Resume (exist); new **Switch off** (`disable-all`, a tightening, applies at once);
  new **Switch on…**: `enable-all` prepares the standing approval that starts collection, its preview is shown, and the
  person approves it in the app.
- **New behind it:** the event service approves an `enable-all` activation from an attested app origin, as `approveRule`
  does for a rule's (`judge-setup.ts` 262–310 refuses anything else today): a sibling owner path behind
  `personSetupOrigin`, a CLI command, a capabilities row, and the app's prepare/approve calls with `{approvalId, digest}`
  and the Terminal fallback widened (`terminal.rs` 491–498).

### B5. Deliveries: what happened to a match, and who can read it

- **Sees:** for a rule in dry-run, a line above its rows: "mail-subjects is in dry-run: each match is written to the
  dry-run log instead of being sent anywhere." A **Dry-run log** filter beside the state filters, opening each record's
  existing page (its "Would have" part, `DeliveryDetail.tsx` 477–512). A note, **Something reached your agent?**: an
  agent works through the Queue; a session target hands a match to an agent session; and the dry-run log is yours to
  read here or in Terminal — agents cannot read it through their MCP tools, but an agent with a terminal (such as
  Claude Code) runs commands as you and can, with every sender-written field marked as outside text.
- **Calls:** none new: the filter is `deliveries list` by `targetKind === 'dry-run'`. Expired records keep their row
  and show "removed after 24 hours", folded.

### B6. Doctor and the face

Doctor is part A9. The face is part A's open point.

### B7. Hardening found while reading for this (small, in 0.34)

- **`events_approval_view` gives an MCP client a usable challenge** (`operations/approval-view.ts`, `server.ts` 348–353),
  and a view challenge also answers the `approve` wire (`activations.ts` 1720–1738). No MCP tool approves, so using it
  needs the control socket, which only a shell has; still, the MCP view should strip the challenge, as the app already
  does (`rule_editor.rs` 298–311).
- **Known, not changed here (for the owner to decide):** an agent may resume collection the person paused
  (`events_resume`, no approval); `dryrun list|show` refuse only inside an MCP server's process, not an agent's shell
  (accepted: a shell runs as the person, and the fields are enveloped); the origin over the control socket is a label
  the CLI sets after its own check (SEC-3b, 0.33).

## 4. Order of work

1. Part A's open points: the face (owner), the trackpad and light mode in the test build (owner), the CUE-571 report
   (owner approves, then posted).
2. Part B, after the owner's comments on the prototype and their yes to B3's layout:
   - core: `--app-approval` on `label`, `behaviour`, `update`; `mcp install` with several servers; wording and tests;
     capabilities rows; the pinned wording fixture.
   - event service: the `enable-all` app approval; `disable-all` from the app; the MCP view without a challenge;
     capabilities rows; the built-surfaces list if a tool changes.
   - desktop: B1 Your agents; B2 the account page; B3 MCP servers; B4 Events → Service; B5 Deliveries; the call rows,
     allow-list entries, version gates, Do it in Terminal fallbacks; tests for each.
   - docs and skills where a command changed; CHANGELOG `## 0.34.0` with What, Why, Impact and the desktop app.
3. Checks: the full local chain except `pnpm test`, the root suite, a release dry run and the PR's Desktop workflow,
   then a test build the owner tries, then the release.
