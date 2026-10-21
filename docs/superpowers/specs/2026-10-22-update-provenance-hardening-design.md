# Update provenance, hardened: release flags, channel checks, global installs and holds — design (0.26.0)

Status: **written 2026-10-22**, for 0.26.0.

**What the owner asked**, on 2026-10-22, answering three questions:
- **Scope:** "0.26.0 with CUE-495": Linear CUE-495's items 1–4, the follow-ups the 0.20.0 provenance work (PR #81)
  proposed but did not build, with the small fixes that waited for a feature riding along.
- **CUE-495 item 5, an escape hatch for a release that fails verification:** "No escape hatch". This is the owner's
  decision, not the lead's (P5).
- On 2026-10-21, that the agent runs the desktop app's signed release itself, as Supbuddy's `/release` does (R1).

Every other decision here is marked **(lead's call)**.

## 1. What is true today (main = v0.25.0, `1aca79f8`, read 2026-10-22)

0.20.0 verifies Sigstore provenance for every `@agentcomms/*` release before it is installed, whether by hand, by the
background run or at first install. Each is pinned to this repository's `.github/workflows/release.yml`, on a
`refs/tags/v<version>` ref and a GitHub-hosted runner, with no bypass (`packages/core/src/update-provenance.ts`). The
attestation signs the tarball's sha512; core compares it with the packument's `dist.integrity`, and after a managed
install it compares the runtime's `package-lock.json` with that digest (`runtimeIntegrityProblem`,
`update-release.ts:173-215`). Four things are still taken on the registry's word, or not checked at all.

**G1. Release flags are read from the packument.**
- **Where:** `agentcommsRelease` (`security`, `needsDecision`) is read from `packument.versions[v]`, by
  `releaseDeclaration` (`update-release.ts:105-117`). Its readers are `declaredSince` (`:327-355`), the daily check
  and `--check` (`operations/update.ts:705-727`), the by-hand preview (`:1043-1056`), and the background run
  (`update-background.ts:532, 555, 581-612`).
- **Why it matters:** verification proves where the tarball came from, not that the registry's copy of the manifest
  is genuine. A registry or mirror can add or remove either flag on a genuine release. That moves its hold between
  72 and 24 hours, turns its urgent notice on or off, or skips it as "needs a decision". `SECURITY.md:169-174` records
  this as a known limit.
- **No release can declare a flag at all.** `scripts/channels.mjs` refuses `agentcommsRelease` on core (`readHold`,
  `:361-391`; pinned by `test/channel-registry.test.mjs:778`), and no release has ever carried one.
- **Nothing reads a tarball:** core has no gunzip or tar code (searched `packages/core/src`).

**G2. A check run only by a channel describes a security fix as an ordinary release.**
- **Why:** core's code is bundled into each channel, but Sigstore is left out on purpose (`update-release.ts:6-8`).
  A channel CLI's or server's check runs `releaseFactsReader` with no verifier, so every flag reads false
  (`operations/update.ts:720`).
- **It also overwrites:** `recordFound` writes that `{security: false, needsDecision: false}` into the machine-wide
  `<state>/update-check.json`, over whatever core's verified check had left there (`:779-780, 793`). The notice then
  reads as an ordinary release, and no send or post preview carries the security line (`update-gate.ts:310-339, 473`).
- **What exists already:** a channel can locate core's CLI at its own version (`locateCliCommand` `channel-to-core`,
  `cli-command.ts:399-421`), but only ever prints that command; no channel spawns core today. A CLI's check is handed
  to a detached child of the same CLI (`handUpdateCheckToChild`, `update-check.ts:346-373`).

**G3. A global package is not checked after `npm install -g`.**
- **What happens:** the by-hand update verifies the global package before its preview, then runs `npm install
  --global --ignore-scripts … pkg@version` (`npm.ts:172-183`) and marks the step `updated`
  (`operations/update.ts:1627-1636`).
- **The gap:** npm resolves the package again, from a fresh fetch of the packument, so what it installs need not be
  what was verified. Afterwards npm keeps no lockfile and no integrity for a global (observed with npm 10.9.8 and
  Node 22.22.3). `SECURITY.md:156-157` records this.

**G4. Holds count from the registry's `time`.**
- **Where:** the background run holds a release for 72 hours after it was published, or 24 for a security fix
  (`update-background.ts:250-252, 667-694`). The publish time is `packument.time[version]`, which the registry
  controls.
- **The gap:** a registry could make a release look older than it is, and so skip the hold. The Rekor entry's
  integrated time is signed, but nothing uses it: `VerifiedProvenance.integratedTime` is read from the raw bundle's
  first tlog entry (`update-provenance.ts:275-285`), and the result of sigstore-js's own verification is discarded
  (`:522`).

## 2. Threat model

**In scope:**
- An attacker who controls or alters what the npm registry, or a mirror in front of it, returns: the packument (its
  `versions[v]` manifests, `time`, `dist.integrity` and `dist.tarball`) and the bytes it serves.
- That attacker can't forge a Sigstore attestation from this repository's release workflow, and can't get Rekor to
  sign a time that isn't its own.

**Out of scope, as in 0.20.0:**
- a compromised release workflow or maintainer account (provenance proves where a release was built, not that it is
  safe);
- a program running as the same user on the person's machine;
- the non-`@agentcomms` dependencies npm installs for a package.

**The goals:**
- A flag that changes how a release is held, announced or skipped is believed only if it is in the verified bytes.
- A channel never erases what core verified.
- A global install puts the verified bytes on disk, and is checked afterwards.
- A hold counts from a time Rekor signed.

## 3. Decisions

### P1. Release flags come from the verified tarball

**Declaring them (lead's call):**
- A release declares its flags in `packages/core/package.json` as `"agentcommsRelease": { "security": true,
  "needsDecision": true }`, with either key alone or both. Only these two keys are allowed, and only as booleans.
- `scripts/channels.mjs` accepts this on core. It still refuses `hold` on core, and a channel's `agentcommsRelease`
  stays `{ "hold": … }` only.
- **They must match the changelog.** The release checks (`scripts/release.mjs`, and the tag gate in `release.yml`)
  refuse a release whose flags don't match its own changelog section:
  - `security: true` ⇔ the `## X.Y.Z` section has a line starting `**Security fix.**`;
  - `needsDecision: true` ⇔ it has a line starting `**Needs a decision before it installs.**`.
- **Why the match:** flags left in `package.json` after a release would otherwise apply to the next one. The next
  version's section won't carry the markers, so the check refuses it.
- `docs/RELEASING.md` says how to declare each flag and when.

**Reading them:**
- Only core reads them, because only core carries the verifier.
- **The download:** for each release whose flags matter (the newest version, and each version in range for
  `needsDecision`), core downloads the tarball from the packument's `dist.tarball`. The URL must be `https:`, on the
  registry's own origin, and must answer without redirect. The response must be at most 32 MiB.
- **The checks:**
  - the tarball's sha512 must equal the **verified** provenance digest;
  - it is gunzipped with `node:zlib`, stopping past 128 MiB;
  - core reads `package/package.json` from the ustar archive: exactly one entry by that name, a regular file of at
    most 1 MiB, with every header checksum valid up to it;
  - its `name` and `version` must be the release's.
- The flags are then `releaseDeclaration(manifest)`, as today.
- **Nothing else reads the archive.** The packument's `agentcommsRelease` is no longer read for any decision.
- **Cache:** what was read is cached per integrity, content-free (`{ version, integrity, security, needsDecision }`),
  in `<state>/release-declarations.json`. Neither the daily check nor the background run downloads the same release
  twice.
- **Fail closed (lead's call):** a declaration that can't be read is *unknown*.
  - The background run skips that release this run, and says so in its record ("its declaration could not be read
    from its verified release"); the next run tries again.
  - The notice and the preview make no security claim.
  - A by-hand update still shows its preview, saying the declaration could not be read.
- **The pause:** it now asks the verified declaration, not the packument (`update-background.ts:532`). So, with the
  machine paused, core is verified and its declaration read before the run decides whether a security fix overrides
  the pause.

### P2. A channel never overwrites verified facts, and hands its check to core

**Writing (lead's call):** `recordFound` writes `release` only from a check that verified it.
- A check with no verifier records the latest version, and keeps a verified `release` for that same version if one is
  there.
- Otherwise `release` is `null`, meaning *unknown*: no security line and no decision line, and never a stored
  `security: false`.

**Handing off:** when core is installed at the channel's own version (`locateCliCommand` `channel-to-core`, through
`stableWayIn`), a channel's CLI and its MCP server hand the check to **core's CLI**.
- They spawn the located command's words plus `update-check-child <claimedAt>`: detached, no shell, with the same
  environment the CLI's own child gets today. Core's child does the verified check and writes the record.
- If core is not found, or the spawn fails, the channel checks as today, with no verifier and so under the rule above.
- **No other path spawns core:** this is the only spawn a channel gains, and a test holds the channels to it.
- **WhatsApp is unchanged:** it keeps its no-network guarantee (smoother-updates U9).

### P3. A global install installs the verified bytes, and is checked afterwards

**Before** `npm install -g` (lead's call):
- Core downloads the verified tarball, as in P1, with the same checks.
- It writes the tarball to a private temporary file: mode 0600, in a 0700 folder, removed afterwards.
- It runs `npm install --global --ignore-scripts --no-audit --no-fund --no-update-notifier <that file>`. npm then
  installs exactly those bytes, not a fresh resolution.

**After:** core walks the installed package at `<npm root -g>/@agentcomms/<pkg>`, and each
`node_modules/@agentcomms/*` package under it. For each one:
- its installed version must be a release whose provenance verifies (verified now if it wasn't already);
- every file in that verified tarball must be present, with identical bytes;
- files outside `node_modules/` that the tarball doesn't list are refused.

**On a mismatch:**
- The step's outcome is `failed`, with "the global `<pkg>` does not match its verified release: run `agentcomms
  update` again", and `current.global` isn't changed.
- Nothing is uninstalled: the person reinstalls, and the next update repeats the check.
- **Not covered:** other dependencies (§2).

`SECURITY.md:156-157` now says what is checked.

### P4. Holds count from Rekor's signed integrated time

**Which time counts:**
- A release's publish time, for holds, is the integrated time of its provenance's Rekor entry.
- It is taken only when the bundle carries exactly one tlog entry and that entry's inclusion promise (SET) has
  verified against the trusted root's Rekor key.
- **Check what sigstore-js verifies:** the builder confirms, from `@sigstore/verify` 2.1.1's source, whether that SET
  is what `tlogThreshold: 1` verified. If it isn't guaranteed, or not exposed, core verifies the SET itself.
- **No signed time:** a release without one is held, as one without a publish time is today.

**How the hold is counted:**
- For the set (core and every package behind), the hold counts from the latest of their signed times.
- **The clock is unchanged:** the earlier of the machine's time and the registry's `Date` headers.
- The registry's `time` is no longer used for holds.
- **Order (lead's call):** every package of the set is verified before the hold is decided. Today only core is.
- **Test fixtures:** `ProvenanceShape` gains a per-release `signedAt`.

### P5. No escape hatch (the owner's decision, 2026-10-22)

A release whose provenance fails verification can't be installed in any way: by hand, by the background run, or at
first install. There is no override, code or flag. A broken release is replaced by a new verified one.
`SECURITY.md` says so.

### R1. The desktop release scripts can be run by an agent (the owner, 2026-10-21)

- **`--confirm`:** `release-desktop.sh desktop-vX.Y.Z --confirm X.Y.Z [--updater off]` and `publish-desktop.sh
  desktop-vX.Y.Z --confirm X.Y.Z` run with no terminal.
  - `--confirm` must equal the app's version, exactly as typing it back must.
  - `--updater off` is required when the updater is off. With the updater on, it is refused.
- **Without the flags,** the scripts behave as now: a terminal, and the version typed back.
- **Every other refusal stays:** tag and version, clean tree, HEAD at the tag, the signing environment's mode, the
  identity, and the notary profile.
- **The install runs under `CI=true`,** as the build already does. Under CI, pnpm 11.22 defaults
  `enableGlobalVirtualStore` to false, so `verifyDepsBeforeRun` refused the build after a non-CI install. This
  happened on the first real run, 2026-10-21.
- **The text to change:** DA8's "An agent never runs these scripts", `docs/RELEASING.md` ("No agent runs these
  scripts", and the owner's steps), and both scripts' header comments. They now say an agent may run them once the
  owner has said so, with the flags. The signing identity, the notary profile and the updater key still stay on the
  signing Mac.

### R2. The update-check lock waits per holder (lead's call)

- **The change:** `changeUpdateCheck` (`update-state.ts:297-312`) takes `.update-check.lock` with `{ timeoutPerHolder:
  true, timeoutMs: 2_000, maxWaitMs: 15_000 }`, as config writes do since 0.25.0.
- **Why:** today 2 s counts from the start of the wait, while every tool call's refresh also takes the lock.
- **A person's update no longer loses its record:** after the apply, `recordFound` is no longer dropped on a lock
  timeout (`operations/update.ts:797`). It is tried once more, and if that also times out, the update's result says
  "the update was installed; its record will be corrected by the next check".
- **The test:** this fixes the Windows Node 22 flake in `update-gate.test.ts:538`. The test is made to hold the lock
  deterministically.

### R3. The E2 checker reads imports with TypeScript's own parser (lead's call)

- **The bug:** `codeImportSpecifiers` in `scripts/verify-events-phase-e2-tests.mjs` (`:1044-1083`) reads an
  apostrophe inside a regular-expression literal as the start of a string, and so can miss an import that comes after
  it.
- **The fix:** it uses `ts.preProcessFile(text, true, true)` from the repository's own `typescript` dev dependency.
  That reads static imports, `import()` and `require` the way the compiler does. `codeOnly` and `valueImports` get the
  same treatment where they decide anything.
- **Frozen anchors:** a frozen fragment's mutant anchored on a changed line is superseded by F2's checked rule, never
  edited.

## 4. Tests

All tests use the loopback registry and the test Sigstore root (`packages/core/test/helpers/provenance-fixture.ts`).
None reaches npm, Sigstore or GitHub.

**P1, flags:**
- Each flag is read from a tarball whose packument says otherwise, both ways, for both flags. The packument's word
  never decides.
- A tarball that doesn't match the verified digest, a redirect, an oversized download, a gzip bomb, a missing
  `package/package.json`, two entries by that name, a bad header checksum, or a mismatched name or version: each
  makes the declaration *unknown*.
- An unknown declaration skips the release in the background run, makes no claim in the notice, and still allows a
  by-hand preview.
- A cached declaration is used again without a download.
- The release check refuses flags that don't match the changelog markers, and markers without flags, both ways; and
  `hold` on core.

**P2, channel checks:**
- A channel-only check never replaces a verified `release` with false flags.
- An unknown `release` makes no claim.
- With core installed at the same version, the Gmail, Slack and Resend CLIs and servers spawn core's
  `update-check-child`, and the record carries core's verified flags.
- With no core, or a spawn that fails, they fall back to the unverified check.
- No other channel code path spawns core.

**P3, globals:**
- Against a loopback registry and real npm into a temporary prefix: the verified file is what gets installed.
- One changed byte in an installed `@agentcomms` file, a missing file, an extra file outside `node_modules/`, or a
  nested `@agentcomms/core` at a version that doesn't verify: each fails the step, with `current.global` unchanged.

**P4, holds:**
- Holds count from each release's own `signedAt`, so a registry `time` set back by days changes nothing.
- No signed time, or two tlog entries, means held.
- A SET that doesn't verify means held.
- The rest of the set is verified before the hold.

**P5:** no input, flag, environment variable or approval installs a release that fails verification (a test for each
install path).

**R1:**
- Both scripts run headless with `--confirm`, against stand-ins for `codesign`, `xcrun` and `gh`. The tests never
  sign or publish.
- A wrong `--confirm`, a missing `--updater off`, or `--updater off` with the updater on are each refused.
- The install runs under `CI=true`.

**R2:** a held update-check lock that is handed on within its bound doesn't lose a person's record; one held past it
gives the stated result.

**R3:** an apostrophe in a regular expression before a forbidden Laya import is caught.

**Mutants:** break each new guard on purpose and see its named test fail. The E2 phase's strict runner keeps applying
to E2 files.

**CI:** a cloud dry run at each join. All three platforms run P3's real-npm test and R1's script tests (bash only:
Windows skips R1).

## 5. Out of scope

- An escape hatch (P5).
- Offering Laya.
- CUE-392 phase 4 (moving RGC's members onto their profile).
- Checking non-`@agentcomms` dependencies.
- Any network use by WhatsApp.

## 6. Version

**0.26.0, a minor.**

**What changes when you update:**
- Release flags now come from the verified release itself.
- A channel's check no longer hides a security fix.
- A global package is installed from its verified file and checked afterwards.
- Holds count from Rekor's signed time.
- The desktop release can be run without a terminal.

**What doesn't change:** nothing that succeeded before now fails, except installs and holds that rested on the
registry's word alone.
