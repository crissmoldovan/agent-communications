# Smoother updates — design

2026-10-16. Replaces the stop of the daily update check
([2026-09-28](2026-09-28-daily-update-check-design.md), decisions 1 and 2, and "later"). It keeps that design's
purpose: "Success is that a machine never quietly falls behind a release again." It builds on the CLI path shims
([2026-10-04](2026-10-04-cli-path-shims-design.md)) and the parity design
([2026-09-25](2026-09-25-cli-mcp-parity-design.md)). Where this document says nothing, they hold.

## 1. What was asked

On 2026-10-15 the owner relayed a complaint: "the agent is annoying because it blocks the thread while updating, as in
it blocks the conversation." They asked:
- to "allow the user to not update when this asks, and … make this process much smoother";
- for three levels: every 14 days, never, and an automatic one that is "on by default" and "should allow deferring
  it";
- whether "an updater that does it in the background without the intervention of the user" is possible.

They decided, one question at a time, on 2026-10-15 and 2026-10-16:

1. **Never stop; mention it.** Tools keep working when a newer version is out. A session's first result carries a
   one-line notice. A release marked as a security fix asks once, before the next send or post.
2. **The default level installs in the background**, after one yes to set it up. It waits 3 days after a release,
   verifies the package was built by our own release workflow, and takes effect at the next client restart. It asks
   the person only for a major version, or a release that needs a decision from them.
3. **Defer means pause for 1, 7 or 14 days** (7 when no length is given). It is a plain answer with no approval, and
   tools keep working.
4. **A security fix installs within a day,** after a 24-hour hold, still only if the provenance is verified.
5. **An organisation's profile can only make updates stricter**: no background updates, or every 14 days at most.

Success:
- no conversation is ever blocked by an update;
- a machine on the default level runs the latest verified release within days, without anyone doing anything;
- nobody is left behind without knowing it.

## 2. What is true

Sources read on 2026-10-15.

**Today**, from the code at 0.18.2:
- Any newer version, patch included, stops every tool call and command: "Nothing was done: … did not run"
  (`packages/core/src/update-state.ts:370`, `update-gate.ts:149-216`).
- Nothing remembers that the person was told, so every call stops again.
- `later` snoozes until local midnight, and needs an approval of its own (`operations/update-settings.ts:35-75`).
- `--auto on|off` only switches the daily check (`defaults.updateCheck`). Nothing installs on its own.
- Registrations name a versioned runtime, so every update edits each client's configuration
  (`operations/update.ts:801-856`).
- The events daemon has no stop at all.

**A per-user background job needs no admin rights on any platform:**
- **macOS:** a LaunchAgent in `~/Library/LaunchAgents` with `StartCalendarInterval`, which runs on wake if missed;
  loaded with `launchctl bootstrap gui/$UID` ([launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)).
  macOS 13+ shows "Background Items Added" once and lists it under Login Items, where the person can switch it off
  ([Apple](https://support.apple.com/guide/mac-help/change-login-items-extensions-settings-mtusr003/mac)).
- **Linux:** a systemd user timer, `OnCalendar=daily`, `Persistent=true`, `RandomizedDelaySec=`
  ([systemd.timer(5)](https://man7.org/linux/man-pages/man5/systemd.timer.5.html)).
- **Windows:** a per-user scheduled task, `-Daily -RandomDelay`, `-StartWhenAvailable` and
  `-AllowStartIfOnBatteries` ([MS Learn](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)).
- Endpoint-security tools watch both mechanisms (MITRE ATT&CK T1543.001, T1053.005). Some company machines will
  flag the job, which is why §1's fifth decision exists.

**Provenance can be checked before installing:**
- npm's attestations endpoint gives a version's SLSA provenance bundle. sigstore-js verifies it against a pinned
  issuer and identity: this repository's `release.yml` on a `v*` tag, on a GitHub-hosted runner
  ([Sigstore](https://blog.sigstore.dev/cosign-verify-bundles/),
  [sigstore-js](https://github.com/sigstore/sigstore-js/tree/main/packages/client)).
- npm itself does not pin the repository or workflow. A version without provenance still installs, unless the
  installer refuses it ([Nx postmortem](https://nx.dev/blog/s1ngularity-postmortem)).
- Provenance proves where a package was built, not that it is safe. A compromised repository or workflow would pass.
  A cooldown catches most published attacks: 8 in 10 were caught within a week
  ([dependency cooldowns](https://blog.yossarian.net/2025/11/21/We-should-all-be-using-dependency-cooldowns)).

**An MCP server keeps its old code until its client starts it again**
([transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)):
- Claude Code reconnects a server with `/mcp`;
- Claude Desktop and Cursor need a restart;
- a runtime that a running server uses must never be changed or deleted.

## 3. Decisions

### U1 — A notice, never a stop

The gate in `strictToolArguments` and in each CLI no longer refuses anything for being behind. Instead:
- **A server's first tool result of its process** carries a single line, when this machine is behind on a level that
  shows notices (U3), as an `update` field beside the result. For example: `agentcomms 0.20.0 is out; say "update"
  when it suits you`, or `0.20.0 is installed; restart Claude Code (or /mcp → Reconnect) to use it`. That process
  never repeats it.
- **A CLI command** prints the same line once on stderr, at most once a day for the machine, and runs.
- **The tools that served the stop** (`comms_update`, doctor) keep working as they do.
- **The `UPDATE_REQUIRED` error and exit code 11 are retired.** A client that still sees one is talking to a server
  older than this release.

### U2 — Levels

`defaults.updates` in `config.json` is one of three levels:

| Level | Checks | Installs | Notices |
|---|---|---|---|
| **`auto`** (the default) | daily, in the background job | in the background, U4 | only when something needs the person: a major version, a release needing a decision, a failed verification, a restart to use what was installed |
| **`every-14-days`** | at most once every 14 days, as the daily check does today | only with the person's yes, `comms_update` | at most once every 14 days |
| **`never`** | never: no registry request | only by hand | none |

- **Moving to a level that updates less** (`auto` → `every-14-days` → `never`) is a loosening. Its preview says what
  stops happening, and it needs the person's yes. Moving back applies at once.
- **Migration from 0.18:** `updateCheck: on` reads as `auto`, and `off` reads as `never`.
- **`auto` without its job:** until the person has said yes to setting up the background job (U4), `auto` behaves as
  a daily check with a notice. The first notice offers the setup.
- `CI`, and `AGENT_COMMS_UPDATES=never` for one process, keep switching it all off, as `AGENT_COMMS_UPDATE_CHECK=off`
  does today.

### U3 — Pausing

`comms_update` with `pause: 1 | 7 | 14` (default 7), or `agentcomms update --pause [days]`, holds background installs
and notices until then, for the whole machine. It is a plain answer with no approval: since nothing stops any more, a
pause clears nothing.
- A pause never holds back a **security fix** (U5).
- Every notice and `doctor` say when the pause ends. A new pause replaces the old one, and the end is at most 14 days
  from when it was asked.
- `resume` ends a pause at once.

### U4 — The background job, set up with one yes

- **Setting it up is a change the person approves.** It is offered by the first `auto` notice, by `comms-onboarding`,
  and by the update skill after this release. The preview names:
  - the job file and what it runs;
  - when it runs: daily, at a random minute;
  - what macOS will show;
  - how to remove it.
- **Per platform:**
  - **macOS:** `~/Library/LaunchAgents/com.agentcomms.update.plist`, with `StartCalendarInterval` (hour 10 local, a
    random minute) and `RunAtLoad` false. It is loaded with `launchctl bootstrap gui/$UID`.
  - **Linux:** `~/.config/systemd/user/agentcomms-update.{service,timer}`, `OnCalendar=daily`, `Persistent=true`,
    `RandomizedDelaySec=1h`.
  - **Windows:** a per-user task `agentcomms-update`, daily, `-RandomDelay 1h`, `-StartWhenAvailable`,
    `-AllowStartIfOnBatteries`.
- **What it runs:** the stable core command (U6) with `update --background`. It runs with no terminal and no agent:
  it can never send, post or approve anything, and it changes only what U5 lists.
- **Removing it:** `agentcomms update --level every-14-days` or `never` removes it, and so does uninstalling. Doctor
  reports a job that is missing, foreign or stale, and gives the fix.

### U5 — What one background run does

1. **Ask the registry for `latest`.** Stop if the machine is paused (U3), unless a security fix is waiting. Stop if
   an organisation profile forbids background updates (U8).
2. **Choose the candidate.**
   - Skip a major version, a release whose core manifest declares `agentcommsRelease.needsDecision` (a migration, or
     a changed safety default), and any downgrade. Each of these becomes a notice for the person.
   - A release must have been published at least **72 hours** ago, or **24 hours** for one whose manifest declares
     `agentcommsRelease.security: true`.
3. **Verify the provenance** of every package to be installed, pinned to:
   - this repository;
   - `.github/workflows/release.yml`;
   - a `refs/tags/v<version>` ref;
   - a GitHub-hosted runner.

   A version without provenance, or with any other identity, is refused. The run stops with a notice and installs
   nothing.
4. **Install** each package into a new runtime directory, exactly as `comms_update` does. Then run that runtime's
   offline self-check: `--version`, and an MCP `initialize` with no account access.
5. **Switch** each stable launcher's pointer (U6) to the new runtime, in one atomic rename per package.
6. **Record** it in the audit log, readable with `comms_audit_tail`. Keep the previous runtime, and every runtime a
   process still uses. Prune the rest as `comms_server_prune` would, without asking, because nothing uses them.
7. **Leave a notice** for the next session: `0.20.0 is installed; restart … to use it`.

A failure at any step leaves the pointers as they were.

### U6 — A stable launcher, so an update never edits a client again

- **Registrations and shims start a stable launcher,** `<data>/launch/<name>`, instead of a versioned runtime path.
  The launcher reads a pointer file, `<data>/launch/<name>.current`, naming the runtime, then runs that runtime's
  entry with the Node the locator found (CUE-492's rule).
- A pointer file rather than a symlink, so Windows works without Developer Mode.
- **The move to the launcher** is one ordinary approved `comms_update`, the last that edits client configs. After
  it, updates only switch pointers.
- **A runtime that fails to start** after a switch makes the launcher fall back to the previous pointer once, and
  record it. The next run's notice says so.
- `agentcomms update --rollback` switches the pointers back to the previous runtime. It is a change the person
  approves.

### U7 — A security fix

A release declaring `agentcommsRelease.security: true` installs after 24 hours on `auto` (U5), whatever the pause.

On `every-14-days` and `never`, and on `auto` while its job is not set up:
- its notice is shown at once, whatever the 14-day spacing;
- the next send or post prepare puts it in the preview's first line: `A security fix is out (0.20.1): update first,
  or approve to send anyway`. That is asked once, and the person's yes to that preview is the answer.

### U8 — Organisations can only tighten

An organisation profile, `organisations.ts`, may carry `updates: { max?: 'every-14-days' | 'never',
background?: false }`.
- A member's level is capped at `max`.
- `background: false` keeps `auto` from setting up the job, and makes an existing job stop at its next run, with a
  notice. `auto` then behaves as a daily check with a notice.
- A member can never loosen past the profile. `doctor` shows the cap and where it comes from.
- Profile version 1 says "no defaults, no policies". This adds an optional field that older releases ignore.

### U9 — What does not change

- Nothing is sent, posted or approved by the background job or by any update. The send gates are untouched.
- A major version always waits for the person.
- `comms_update` still exists for an update by hand, with its preview.
- WhatsApp keeps its no-network guarantee: it reads the notice from the state file and never asks npm.

## 4. Tests

Every test uses temporary directories and injected stand-ins:
- a fake registry and attestation fixture;
- runners for `launchctl`, `systemctl` and the Windows scheduler cmdlets;
- a clock.

Nothing schedules a real job, reaches npm or installs a package.

**Tests cover:**
- **U1:** no tool or command is refused for being behind; the notice comes once per process; the CLI line at most
  once a day.
- **U2:** each level's checks and notices; the classification of a level change; the migration from `updateCheck`.
- **U3:** a pause's limits; a security fix is never held by one.
- **U4:** each platform's job file and commands, exactly; removal; doctor's three states.
- **U5:**
  - each skip: major, needs-decision, downgrade, too new;
  - the two holds: 72 hours, and 24 hours for a security fix;
  - a provenance refusal for each mismatched field, and for a missing attestation;
  - a failed self-check leaves the pointers alone;
  - an in-use runtime is never pruned.
- **U6:** the launcher reads the pointer; the atomic switch; the fallback once; rollback's preview.
- **U7:** a security release's notice, and the preview line on the next send.
- **U8:** caps and `background: false`.

Break the provenance pin on purpose and see its test fail.

## 5. Live checks, each only with the owner's yes

1. Set up the background job on the owner's Mac. Check the "Background Items Added" notice, the Login Items entry,
   and `doctor`.
2. Run `agentcomms update --background --dry-run` once by hand. It shows what it would install and why, and the
   provenance it verified for the current release.
3. After the next release, check that it installed on its own after 3 days, the pointer switched, and a restart
   picked it up.

## 6. Release

A minor release, with the move to the stable launcher as its one approved `comms_update`. Its **Upgrading** section
says:
- nothing stops any more;
- the default level is `auto`;
- one yes sets up background updates;
- how to choose `every-14-days` or `never`, and how to pause.

The update skill walks through these one step at a time ([setup](../../skills/_shared/contract-comms.md), "Setting up:
one question at a time").

## 7. For the owner's review

These are choices made here that the owner has not yet been asked:
1. A pause never holds back a security fix (U3).
2. Moving to a level that updates less needs a yes; moving back applies at once (U2).
3. The job runs daily at 10:00 local, at a random minute (U4).
4. The previous runtime is kept for rollback, and runtimes older than that are pruned in the background without
   asking (U5).
