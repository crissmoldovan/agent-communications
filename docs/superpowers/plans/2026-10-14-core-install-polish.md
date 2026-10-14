# Core Install Polish Implementation Plan

> **For agentic workers:** Execute these tasks inline, in order.

**Goal:** Make the declared events service installable and maintainable by core, make safe Windows handoffs pasteable in PowerShell, and add owned PATH shims for managed CLIs.

**Architecture:** Extend the generated declaration snapshot with services, then expose a product-neutral server registry while preserving channel-only narrowing, account, policy, and rival behavior. Keep command rendering pure by adding a PowerShell-only rendered form for the narrow spaced-program case. Put shim ownership, rendering, inspection, and removal in one focused core module; the managed installer, updater, pruner, and doctor consume that module.

**Tech Stack:** TypeScript ESM, Node 22.18/24, `node:test`, pnpm, Biome.

## Global Constraints

- Tests use temporary homes, data directories, bin directories, and client configs only; no real client config or host is contacted.
- Every new assertion has an explicit message.
- POSIX-only tests use the repository's `WINDOWS_SKIP`; paths compared in assertions use `/` where repository paths are involved.
- Generated references come only from `pnpm sync:reference`; generated skills come only from `pnpm sync:skills`.
- Run affected tests, `pnpm typecheck`, `pnpm lint`, `pnpm verify:parity --strict`, `pnpm verify:reference`, and `node scripts/verify-skills.mjs`; do not run `pnpm verify`.

---

### Task 1: Declaration-driven service server management

**Files:**

- Modify: `scripts/sync-channels.mjs`
- Modify: `packages/core/src/channels.generated.ts` (only through `pnpm sync:channels`)
- Modify: `packages/core/src/channel-servers.ts`
- Modify: `packages/core/src/operations/servers.ts`
- Modify: `packages/core/src/operations/update.ts`
- Modify: `packages/core/src/operations/maintenance.ts`
- Modify: `packages/core/src/cli.ts`
- Modify: `packages/core/src/mcp/server.ts`
- Modify: `packages/core/src/render.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `capabilities.json`
- Test: `test/channel-registry.test.mjs`
- Test: `packages/core/test/core-server.test.ts`
- Test: `packages/core/test/mcp-scan.test.ts`
- Test: `packages/core/test/update.test.ts`
- Test: affected doctor/prune tests in `packages/core/test/`
- Modify: `skills/agentcomms-events/SKILL.md`
- Modify: `packages/events-daemon/README.md`
- Modify: `CHANGELOG.md`
- Regenerate: `docs/reference/*.md`, generated skill contracts

**Interfaces:**

- Consumes: each strict `agentcommsPackage.kind: "service"` declaration (`binary`, `server.defaultName`, package name).
- Produces: generated service snapshot entries and product-neutral `serverFacts`, `serverLabel`, `SERVERS`, install/list/update/prune behavior. Channel helpers remain the only path to accounts, narrowing, send-policy wording, and rival warnings.

- [ ] Add a registry test proving a synthetic declared service appears in core's generated runtime snapshot without a hand-kept name, and core tests proving `events` can be installed, listed, updated, and pruned while rejecting channel-only options.
- [ ] Run those exact tests and record failures caused by the absent service runtime registry.
- [ ] Generate the service snapshot and implement the product-neutral server path; add `--server <name>` to the existing core install/prune commands while the no-flag form remains core.
- [ ] Run the affected tests and record green results.
- [ ] Update the events skill, daemon README, changelog, capability rows, generated references, and generated skills.

### Task 2: PowerShell rendering for quoted Windows program paths

**Files:**

- Modify: `packages/core/src/command-line.ts`
- Modify: `packages/core/src/cli-runtime.ts` only if the outward renderer needs the shell label there
- Test: `packages/core/test/cli.test.ts`
- Modify: `docs/superpowers/specs/2026-10-04-cli-path-shims-design.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `QuotedCommand.words` on `win32`.
- Produces: either a common-shell line, a PowerShell-only line explicitly labelled PowerShell, or the existing inert JSON/manual-entry result.

- [ ] Replace the existing CUE-403 spaced-program expectation with tests for `& 'C:\\Program Files\\nodejs\\node.exe' '…'`, doubled embedded single quotes, an explicit PowerShell label, and unchanged inert JSON for unsafe argument words.
- [ ] Run the renderer test and record the expected failure caused by the current null line.
- [ ] Implement the minimal PowerShell single-quote proof/render path without changing the common cmd/PowerShell renderer.
- [ ] Run renderer tests and record green results.
- [ ] Amend the governing renderer section and add the user-facing changelog entry.

### Task 3: Owned managed-runtime PATH shims

**Files:**

- Create: `packages/core/src/managed-shims.ts`
- Modify: `packages/core/src/mcp-install.ts`
- Modify: `packages/core/src/operations/servers.ts`
- Modify: `packages/core/src/operations/update.ts`
- Modify: `packages/core/src/operations/maintenance.ts`
- Modify: `packages/core/src/render.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/managed-shims.test.ts`
- Test: `packages/core/test/mcp-install.test.ts`
- Test: `packages/core/test/update.test.ts`
- Test: `packages/core/test/install-drift.test.ts`
- Modify: `docs/superpowers/specs/2026-10-04-cli-path-shims-design.md`
- Modify: user-facing README/troubleshooting material selected by existing install documentation
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: `managedShimDir`, owned receipt inspection, a POSIX renderer for macOS/Linux, safe write/repoint and removal
  APIs, and an explicit Windows no-shim result. The write itself lives in the operation (`withManagedShim` in
  `operations/servers.ts`, used by install and update), because finding the command takes the locator, which the
  installer may not import. Windows keeps the full-path or labelled PowerShell handoff because a
  `.cmd` forwarder would make `cmd.exe` re-parse caller arguments.
- Ownership rule: overwrite or remove only when the receipt in this installation's data directory names the shim and the current file digest still matches the receipt; otherwise report foreign.
- Directory rule: resolve `<HOME>/.local/bin` once per operation, mutate only inside that real directory, and refuse
  immediately before a mutation if the public directory resolves elsewhere. A bin directory that is itself a symlink
  remains supported.
- PATH rule: macOS/Linux uses `<HOME>/.local/bin`. Results explain how to prepend it for the current shell and never
  edit a profile. Windows writes no shim and explains why.

- [ ] Add tests with temporary HOME/data/bin paths for new shims, locator-exact Node/entry forwarding, repoint on
  update, a symlinked bin, parent-swap refusal, Windows no-shim behavior, missing/stale/foreign doctor findings,
  non-overwrite of foreign files, owned-only prune removal, and PATH guidance.
- [ ] Run those exact tests and record failures caused by missing shim support.
- [ ] Implement the focused shim module and integrate it after successful managed install/update, with prune and doctor consuming the same ownership inspection.
- [ ] Run affected tests and record green results.
- [ ] Amend CUE-403 with the new shim contract before final implementation documentation, then update README/troubleshooting and changelog.

### Final verification

- [ ] Format every changed file with Biome.
- [ ] Run all affected test files.
- [ ] Run `pnpm sync:reference` and `pnpm sync:skills`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm verify:parity --strict`.
- [ ] Run `pnpm verify:reference`.
- [ ] Run `node scripts/verify-skills.mjs`.
- [ ] Report changed files, each red → green observation, each command result, and any item needing a committee.
