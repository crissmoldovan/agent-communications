# Smoother updates implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. The tracks run in
> parallel, each in a git worktree of its own, once 0.19.0 is merged; then rebase onto main. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** an update never blocks a conversation. A machine on the default level installs verified releases in the
background. The person chooses `auto`, `every-14-days` or `never`, and can pause for 1, 7 or 14 days.

**Architecture:**
- The core owns everything here. Track A replaces the stop with a notice, adds the levels, the pause and the security
  line.
- Track B adds the stable launcher and its pointer files.
- Track C installs and removes the per-platform job.
- Track D is the background run: registry, holds, provenance, install, self-check and switch. It builds on B's
  pointer API.
- The channels take only the security line in their send and post previews (Track A's helper).

**Tech stack:** TypeScript on Node 22.18+/24, pnpm, `node:test`. Track D adds `sigstore` (sigstore-js) for
provenance; check its licence with `pnpm run licenses`.

**Spec:** `docs/superpowers/specs/2026-10-16-smoother-updates-design.md`, approved on 2026-10-16. The ids U1–U9 refer
to it.

## Global constraints

- **No test reaches npm, schedules a real job, installs a package, or touches the real `~/Library/LaunchAgents`,
  `~/.config/systemd`, Task Scheduler or client configs.** Everything is injected: registry, attestation fixtures,
  scheduler runners, clock and home.
- The background run never sends, posts or approves anything, and changes only what U5 lists.
- **The holds:** 72 hours after publish, and 24 for a release whose core manifest declares
  `agentcommsRelease.security: true`.
- **Never automatic:** a major version, `agentcommsRelease.needsDecision`, a downgrade.
- **Provenance is pinned** to `crissmoldovan/agent-communications`, `.github/workflows/release.yml`,
  `refs/tags/v<version>` and a GitHub-hosted runner. Anything else is refused.
- **A pause:** 1, 7 or 14 days, 7 by default, with no approval. It never holds a security fix.
- **Level changes:** a level that updates less is a loosening, approved through the change flow; moving back is at
  once. `updateCheck: on` reads as `auto`, `off` as `never`.
- **CLI and MCP parity**, a `capabilities.json` row for each new command or tool, and no suite binary named in a
  runtime string.
- One suite at a time per worktree. Read the `# fail` counts.

## Review focus

1. **A runtime in use is never switched under a running server's feet, or pruned.** Pointers change, files of a used
   runtime never do (B, D).
2. **The clock jumps or goes backwards:** no hold is skipped, and a pause never lasts longer than 14 days from when it
   was asked (A, D).
3. **A partly failed run:** one package installed, the next refused. No pointer switches unless every package of the
   release verified and self-checked (D).
4. **A client still on 0.18 talks to this release's state file:** the notice fields are additive, and old servers
   keep reading what they read (A).
5. **An organisation profile with `background: false` arrives after the job is installed:** the next run stops
   itself, removes the job, and leaves a notice (C, D).

---

## Track A — notice, levels, pause, security line (core)

### Task A1: the stop becomes a notice (U1)

- **Files:** `packages/core/src/update-gate.ts`, `update-state.ts`, `tool-arguments.ts`, each CLI's entry (core,
  gmail, slack, resend, whatsapp), `errors.ts`, and the tests beside them.
- **Tests first:**
  - no tool or command is refused for being behind;
  - a server's first tool result carries `update: <line>` once per process;
  - a CLI prints the line on stderr at most once a day for the machine;
  - the update and doctor tools are unchanged;
  - WhatsApp reads the notice from the state file and never asks npm.
- **Then:** retire `UPDATE_REQUIRED` and its exit code. Update skills/comms-update and docs/upgrading.md.

### Task A2: levels and pause (U2, U3)

- **Files:** `config.ts` (`defaults.updates`, its schema, `classifyChange`), `operations/update-settings.ts`, the
  core MCP server (`comms_update` takes `level`, `pause`, `resume`), the CLI (`update --level`, `--pause [days]`,
  `--resume`), and `capabilities.json`.
- **Tests first:**
  - each level's behaviour;
  - the migration from `updateCheck`;
  - a less-updating move waits for a yes, and a move back is at once;
  - a pause's limits and replacement;
  - a pause never holds a security fix;
  - `AGENT_COMMS_UPDATES=never` and `CI`.

### Task A3: the security line (U7)

- **Files:** a core helper `securityNotice(state)` that each channel's send and post prepare calls (gmail, slack,
  resend), and their previews.
- **Tests first:**
  - on `every-14-days`, `never`, or `auto` without its job, a security release puts its line first in the next send
    or post preview, once;
  - the person's yes to that preview sends;
  - nothing changes when no security release is waiting.

### Task A4: organisation caps (U8)

- **Files:** `organisations.ts` (the optional `updates` field), and the effective-level reader.
- **Tests first:**
  - a member's level is capped at `max`;
  - `background: false` turns `auto` into a daily check with a notice;
  - doctor names the cap's source;
  - an older profile without the field changes nothing.

## Track B — the stable launcher (core)

### Task B1: launcher and pointer files (U6)

- **Files:** a new `packages/core/src/launcher.ts`, which writes `<data>/launch/<name>` and `<name>.current`, reads
  the pointer, falls back once, and takes the Node from the locator (CUE-492). Also `mcp-install.ts`, so that
  registrations and shims name the launcher.
- **Tests first:**
  - the launcher runs the pointed runtime;
  - the switch is an atomic rename;
  - a runtime that fails to start falls back once and records it;
  - a Windows pointer file needs no symlink.

### Task B2: the move to the launcher, and rollback (U6)

- **Files:** `operations/update.ts` (one approved update moves every registration to the launcher) and
  `update --rollback` (approved).
- **Tests first:**
  - after the move, an update only switches pointers and edits no client config;
  - rollback's preview, and its switch.

## Track C — the background job (core)

### Task C1: install, remove, doctor (U4)

- **Files:** a new `packages/core/src/update-job.ts`, with one writer per platform:
  - macOS: plist plus `launchctl bootstrap` / `bootout`;
  - Linux: unit and timer plus `systemctl --user`;
  - Windows: the `Register-ScheduledTask` script.

  Also its change-flow preview, and the doctor rows.
- **Tests first:**
  - each platform's exact file and commands, run through an injected runner;
  - the job runs the launcher's core with `update --background`;
  - removal on a level change and on uninstall;
  - doctor's missing, foreign and stale states;
  - a profile with `background: false` removes it.

## Track D — one background run (core)

### Task D1: the run pipeline (U5)

- **Files:** a new `packages/core/src/update-background.ts` and `update-provenance.ts` (sigstore-js against the
  attestations endpoint, through an injected fetch), plus `operations/update.ts`'s installer, reused.
- **Tests first:**
  - every skip, and each hold;
  - provenance refused for each mismatched pin field, and for a missing attestation;
  - the self-check failing leaves every pointer as it was;
  - a partly failed release switches nothing (Review focus 3);
  - an in-use runtime is never pruned;
  - an audit entry per run;
  - the next session's notice;
  - `--dry-run` reports and changes nothing.
- Break the pin on purpose and see its test fail.

## Integration (the lead)

- [ ] Rebase the tracks onto main after 0.19.0 merges, and merge them as A, B, D, C.
- [ ] Write the CHANGELOG 0.20.0 entry and Upgrading, per spec §6, and bump to 0.20.0.
- [ ] Add a note to SECURITY.md: the background job and the provenance pin are in scope.
- [ ] Run the root suite once, push, run the six-leg dry run, and send `@blocks review this pull request` at once.
- [ ] Live checks per spec §5, each with the owner's yes, one step at a time.
- [ ] Merge pinned, tag, and verify from outside.
