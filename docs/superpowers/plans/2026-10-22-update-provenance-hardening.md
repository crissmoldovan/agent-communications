# Update Provenance, Hardened (0.26.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Believe a release's flags only from its verified tarball, keep a channel's check from erasing what core
verified, install a global package from its verified file and check it afterwards, count holds from Rekor's signed
time, and let an agent run the desktop release with `--confirm`. The small fixes ride along: the lock wait (R2) and
the E2 import reader (R3).

**Architecture:**
- **One reader of verified tarballs.** `packages/core/src/release-tarball.ts` downloads a release's tarball from any
  `http(s)` location. It follows at most 5 redirects, falls back once to npm's canonical URL, and keeps only bytes
  whose sha512 is the verified provenance digest. It gunzips and walks the ustar archive by hand.
- **Declarations, cached.** `release-declarations.ts` reads `package/package.json` out of those bytes and caches the
  flags per integrity in `<state>/release-declarations.json`. The daily check and preview (Task 8), the background
  run (Task 10) and the global install (Task 9) all go through it.
- **Rekor's time.** `update-provenance.ts` returns the time Rekor signed (`signedAt`) when sigstore-js verified exactly
  one inclusion promise. `release-first-seen.ts` records when this machine first saw a release with no signed time.
- **A channel hands its check to core's CLI,** located at its own version (Task 4).
- **The release checks match flags to changelog markers** (Task 5). The desktop scripts take `--confirm` (Task 6).

**Tech Stack:** TypeScript (Node 22.12+ at run time, 22.18+ to build; `--experimental-strip-types`), `node:test`,
`node:zlib`, sigstore-js parts (`@sigstore/verify` 2.1.1, `/bundle` 3.1.0), npm 10/11, bash, Vitest (desktop), pnpm 11
workspaces, TypeScript 7.0.2 (catalog), and its JS scanner for R3.

**Spec:** `docs/superpowers/specs/2026-10-22-update-provenance-hardening-design.md` (§1 G1–G4, P1–P5, R1–R3, §4
tests, §7 settled). Read it with this plan, and `AGENTS.md`. Where §4 and §7 differ, §7 is the later word (see
"Spec gaps settled here").

## Global Constraints

- **Version:** 0.26.0, a minor. The branch is `feat/0.26`, so the PR proposes `0.26.0-0.26`. **0.26.0 declares
  neither flag** (§7.3): `packages/core/package.json` carries no `agentcommsRelease`, and no line of the 0.26.0
  changelog entry starts with either marker.
- **Release flags (P1):**
  - Declared as `"agentcommsRelease": { "security": true, "needsDecision": true }` in `packages/core/package.json`,
    with either key alone or both.
  - Only these two keys are allowed, and only as booleans. `{}` is refused. `hold` stays refused on core, and a
    channel's `agentcommsRelease` stays `{ "hold": … }` only.
  - They must match the changelog: `security: true` ⇔ the `## X.Y.Z` section has a line starting
    `**Security fix.**`, and `needsDecision: true` ⇔ a line starting `**Needs a decision before it installs.**`.
- **The download (P1, §7.1):**
  - Location: the packument's `dist.tarball`, any `http:` or `https:` URL, through at most **5** redirects. If that
    fails, npm's canonical `https://registry.npmjs.org/<name>/-/<file>-<version>.tgz` is tried **once**.
  - Limits: at most **32 MiB**, within **60 s**.
  - Checks: the sha512 must equal the **verified** provenance digest. It is gunzipped with `node:zlib`, stopping past
    **128 MiB**. `package/package.json` must be exactly one entry, a regular file of at most **1 MiB**, with every
    header checksum valid. Its `name` and `version` must be the release's.
  - The flags are then `releaseDeclaration(manifest)`, unchanged. The packument's `agentcommsRelease` decides nothing,
    anywhere.
- **The cache:** `<state>/release-declarations.json`, per integrity, content-free:
  `{ "declarations": [{ "version", "integrity", "security", "needsDecision" }] }`.
- **Unknown fails closed:**
  - A declaration that cannot be read is *unknown*.
  - The background run skips that release this run with `its declaration could not be read from its verified
    release`.
  - The notice and the preview make no security claim.
  - A by-hand preview is still shown, and says so.
- **The record (P2):**
  - `recordFound` writes `release` only from a check that verified it.
  - An unverified check keeps a verified `release` for the same version. Otherwise `release` is `null`, never a
    stored `security: false`.
- **The hand-off (P2):**
  - The channel spawns the located core command's words plus `update-check-child <claimedAt>`: detached, no shell,
    `updateCheckChildEnvironment(env)`.
  - No core, or a failed spawn, falls back to today's check. This is the only spawn a channel gains.
  - WhatsApp is unchanged.
- **Globals (P3):**
  - The verified tarball goes to a file of mode 0600, in a 0700 folder, removed afterwards.
  - `npm install --global --ignore-scripts --no-audit --no-fund --no-update-notifier <that file>`.
  - Afterwards, walk `<npm root -g>/@agentcomms/<pkg>` and every `node_modules/@agentcomms/*` under it. Each
    installed version's provenance must verify. Every file of its verified tarball must be present with identical
    bytes. A file outside `node_modules/` that the tarball doesn't list is refused.
  - A mismatch fails the step with `the global <pkg> does not match its verified release: run <core's located update
    command> again`. `current.global` is unchanged and nothing is uninstalled.
- **Holds (P4):**
  - A release's publish time is its Rekor integrated time, used only when the bundle has exactly one tlog entry and
    its inclusion promise (SET) verified against the trusted root.
  - With no signed time, the hold counts from this machine's first sight of the release.
  - The set's hold counts from the latest of its times. The clock is unchanged: the earlier of the machine's and the
    registry's `Date`.
  - The registry's `time` is not used for holds. Every package of the set is verified before the hold is decided.
- **No escape hatch (P5):** no input, flag, environment variable or approval installs a release that fails
  verification.
- **R1:**
  - `release-desktop.sh desktop-vX.Y.Z --confirm X.Y.Z [--updater off]` and
    `publish-desktop.sh desktop-vX.Y.Z --confirm X.Y.Z` run without a terminal.
  - `--updater off` is required when the updater is off, and refused when it is on.
  - Without the flags, nothing changes. Every other refusal stays. The install runs under `CI=true`.
- **R2:** `changeUpdateCheck` takes `.update-check.lock` with `{ timeoutPerHolder: true, timeoutMs: 2_000, maxWaitMs:
  15_000 }`. After an apply, a lock timeout gets one retry, then the result says `the update was installed; its
  record will be corrected by the next check`.
- **R3:** the E2 checker reads imports with TypeScript's own tokenizer (see gaps: TypeScript 7.0.2 has no
  `preProcessFile`). A frozen fragment's anchored line is never edited.
- **Tests:**
  - Loopback servers, in-memory stand-ins and the test Sigstore root only. Nothing reaches npm, Sigstore or GitHub.
    From Task 1 on, core's suite runs under `test/helpers/loopback-seal-preload.mjs`.
  - No test lets core's own `update-check-child` reach a registry that answers unless it hands that child the test
    verifier (Task 8's fixture CLI). Otherwise it would verify through Sigstore's real TUF root.
  - Windows: a test that spawns `bash`, reads POSIX modes, or needs process groups is skipped there, with the reason.
    An absolute path given to `import()` or `--import` is a file URL (`pathToFileURL(...).href`).
- **Words:**
  - A sentence a notice, a preview or a reason gives says nothing the registry, a tarball or a disk path wrote. A
    version appears only as `shownRelease(version)`.
  - A command printed for a person comes from `core.handoffs` (CONTRIBUTING "Telling a person what to run"). A bare
    `agentcomms …` in a runtime string fails `test/printed-command-construction.test.mjs`.
- **Surfaces:** no new command, tool or `capabilities.json` row, so `pnpm verify:parity --strict` is unchanged. The
  MCP results gain fields: `UpdateResult.recordNote` and `BackgroundRunResult.release.heldFrom`.
- **Bundles:** nothing WhatsApp's bundle reaches may call `fetch` or start a process. `packages/whatsapp/test/no-
  network.test.ts` and `update-gate.test.ts` (Task 4 extends its list) hold it to that.
- **AGENTS.md:** never send email, post to Slack or send through Resend. Run `pnpm verify` before claiming anything
  works, and report the result.
- **Commits:** `type(scope): <what changes, in a sentence>`. Each message ends with a blank line, then
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit nothing with real data.

## Review Focus

1. **A mirror or proxy that blocks tarballs, or a release in range whose tarball cannot be read.**
   - The declaration is unknown on every run, and the background run never installs.
   - A person would expect to hear about it, not a silent stall.
   - Task 10's test `an unreadable declaration is never silent: the run is unavailable, and the job's run is not
     recorded`.
2. **Windows: the located core command is a `.cmd` shim or sits on a path with spaces.**
   - A shell-less `spawn` of a `.cmd` throws `EINVAL` there.
   - The channel must fall back to its own check, not lose the day's check.
   - Task 4's test `a located core command that cannot be spawned without a shell falls back to the channel's own
     check`.
3. **A global package that is a link (`npm link`, a checkout).**
   - The check must not follow the link into a checkout and compare the wrong files, nor crash.
   - It is a mismatch with the fixed sentence.
   - Task 9's test `a global package that is a link is a mismatch, and the link is not followed`.
4. **The machine's clock far ahead when a release is first seen.**
   - The first-sight time would hold the release for as long as the clock was ahead, which is not a hold anyone
     intended.
   - Task 2's test `a first sight recorded more than five minutes ahead of the clock is recorded again as now`.
5. **Two processes writing `release-declarations.json` or `release-first-seen.json` at once** (the background run and
   a server's check).
   - Each must keep both entries, and a corrupt or half-written file costs a download, never a wrong flag.
   - Task 1's `two readers at once keep both declarations`, and Task 2's `two runs at once keep both sights`.

## Spec gaps settled here (each a planning call)

1. **Redirects (§4 against §7.1).** §4 lists "a redirect" as making a declaration unknown, but §7.1 settled that
   redirects are followed.
   - The plan follows §7.1: up to 5 redirects are followed.
   - A 6th, a loop, or a `Location` that is not `http(s)` fails that download, and the canonical URL gets its one try.
2. **"A SET that doesn't verify" (§4).**
   - In @sigstore/verify 2.1.1 (read 2026-10-22: `verifyTLogTimestamp` in `dist/timestamp/index.js`, and
     `dist/verifier.js`), a present inclusion promise is verified against the trusted root's tlog keys, and a failure
     throws `TLOG_INCLUSION_PROMISE_ERROR`. The whole bundle is then refused, which is stronger than a first-sight
     hold.
   - An entry with only an inclusion proof passes on its Merkle proof and checkpoint, so its `integratedTime` is not
     signed. `Verifier.verify` returns only the signer, and exposes no timestamps.
   - So core reads the signed time from the very entity sigstore-js just verified: one entry, with
     `inclusionPromise`. A test pins each case (Task 2).
   - "A SET that doesn't verify" is tested as a refusal. The first-sight path is tested with a proof-only (v0.2)
     bundle and a two-entry bundle.
3. **R3's `ts.preProcessFile` does not exist in the repository's TypeScript.**
   - The catalog pins `typescript` 7.0.2. Its main export is only its version (`lib/version.cjs`), and its JS API is
     `typescript/unstable/*`, with no parser in JS.
   - Its own scanner is there (`typescript/unstable/ast/scanner`, `createScanner`, `reScanSlashToken`,
     `reScanTemplateToken`). TypeScript 5's `preProcessFile` was itself a token walk over that scanner.
   - So the checker walks TypeScript 7's tokens. Tried on 2026-10-22: `const q = /'/;` followed by
     `import … from '@receptron/laya'` yields the import.
   - Rejected: a second, aliased `typescript@5` dev dependency only for `preProcessFile`.
4. **What an unknown declaration does in the background run.** The run's outcome is `unavailable`, with the fixed
   phrase in its reason and audit line, and no notice. `unavailable` is not one of `JOB_WORKS`, so two days of it
   bring back the notices and the doctor's "has not run" (Review Focus 1). `held` would have recorded the job as
   working for ever.
5. **A release in range that does not verify** has an unknown declaration, so the run is `unavailable`, not
   `refused`. Only the release that would be installed is refused.
6. **The record when some declaration is unread.** `release` is `null` unless both are known: the latest's `security`,
   and the range's `needsDecision` (true when any read one says so, false only when all were read).
7. **First sight is recorded at the machine's clock, not the run's.**
   - The run's clock is the earlier of the machine's and the registry's `Date`, so a registry could have made a first
     sight earlier.
   - A recorded sight more than 5 minutes ahead of the machine's clock is recorded again as now.
   - A dry run records nothing.
8. **The canonical fallback** follows any failure of the first location (status, network, size, time or digest).
   The canonical URL is not tried twice. No credential is ever sent with a tarball request, so a mirror that needs
   one falls back to npm.
9. **The cache saves downloads, not verification.** Every release whose declaration is read is verified first, every
   time. The daily check verifies each release in range, which costs one attestation request a release a day.
10. **The global mismatch sentence names the located command** (`handoffs.core(['update'])`). Where none is located,
    it says `run core's update again`. The detail names no file: installed paths can be a hostile tarball's names.
11. **The channel CLI's fallback is its own child, as today,** then the in-process check. A server falls back to the
    in-process check, as today.
12. **Tarball entries:**
    - Paths are POSIX-normalised, with a leading `./` stripped.
    - An entry outside `package/`, a `..` segment, or a base-256 size is an `archive` problem.
    - A pax `x` header's `path` and `size`, and a GNU `L` long name, apply to the next entry: a renamed second
      `package/package.json` counts.
13. **Field names:** `UpdateResult.recordNote`, and `BackgroundRunResult.release.heldFrom: 'signed' | 'first-seen'`,
    beside `publishedAt`, which now holds the hold's start.
14. **The release-flag check** lives in `scripts/release-flags.mjs`, used by `scripts/release.mjs` and the tag gate.
    `pnpm verify` does not run it, since `## Unreleased` carries no version.
15. **`release-desktop.sh --updater off` without `--confirm` is refused:** at a terminal, `off` is typed as today.
16. **Shared words:** only the phrase two tasks share, `DECLARATION_UNREAD`, goes in `update-words.ts`.
    `RECORD_DEFERRED` lives with Task 3, and `GLOBAL_MISMATCH` with Task 9. They run in parallel, and
    `update-words.ts` has one owner.

## Decisions made during the build

| Decision | Raised in | Question | Resolution |
| --- | --- | --- | --- |
| 0.26.0 review A — needed decision carried forward | Review A, findings 2–4; review B, finding 2; spec §8.1 (the lead's call, 2026-10-23) | P1 found a needed decision by verifying and reading every release the registry listed between the machine's version and the target. A registry that left out the release needing the decision got the next one installed with none (severity 5); one junk version in range wiped a verified security claim (3); 500 listed versions cost 501 attestation requests (3). Separately, one check read an unreadable target's tarball four times, and could outlast its claim's two-minute lease. | Core's `agentcommsRelease` gains `needsDecisionSince`, an exact `X.Y.Z`: a release declaring `needsDecision` carries its own version, every other release the previous one's, or none when no release ever declared one. `scripts/channels.mjs` accepts it on core only; `scripts/release-flags.mjs` (run by `release.mjs` and the tag gate) refuses a missing, wrong or unwarranted carry. **The carry is read from the changelog**, not the previous tag's `package.json`: each released `## X.Y.Z` section's decision marker is what that release declared (this check held the flag to it), the newest marked section below the version by semver is the last carry, and the changelog is in the tag gate's shallow checkout, which has no earlier tag, with no git or network needed. A check, the preview and the background run read only the target's verified declaration: a machine at A going to B decides when B declares `needsDecision` or B's `needsDecisionSince` is after A (an unknown A waits); security is B's own. `releasesBetween` and both range scans are gone. The check's reader keeps one answer per target for its life, known or unknown, and stops the read `DECLARATION_DEADLINE_MS` (30 s, a quarter of the lease) into the check's claim, counted from the claim's time rather than the ask's start — a command's child can start late on a loaded machine — so the registry's 10 s for `latest`, `npm ls`'s minute and the record lock's 15 s still end inside it; after it the read is unknown, never false, its download and any verification are cut off, and one not started is not started (the anchor taken from the reverted review B round, `76aa0337`). `update --check` gives the read 30 s from its start; the by-hand preview and the background run keep each request's own limits (60 s for each tarball location). The declaration cache's records carry `needsDecisionSince`; one without it is no record. Releases before 0.26.0 carry no field and declared no decision, so absent means none; 0.26.0 declares and carries nothing. This supersedes Global Constraints' "only these two keys" and the cache's four keys, and gaps 5, 6 and 9 (a release in range, the record when a range read is unread, and verifying each release in range daily). |

## Running this plan

**Waves.** Each task runs in its own worktree from `feat/0.26`. Within a wave, tasks run in parallel. The lead merges
a wave before the next starts.

| Wave | Tasks, in parallel | Builds on |
|---|---|---|
| 1 | 1 (tarball and declarations), 2 (signed time and first sight), 3 (R2), 4 (P2 hand-off), 5 (release flags), 6 (R1), 7 (R3) | `feat/0.26` at `3a7cbbd2` |
| 2 | 8 (P1 check and preview), 9 (P3 globals), 10 (P1 and P4, background) | wave 1 |
| 3 | 11 (P5), then 12 (integration) | wave 2 |

**Files two tasks share.** Each task changes only its own region. The lead resolves import-block conflicts at merge.

| File | Tasks: regions |
|---|---|
| `packages/core/src/operations/update.ts` | 1: `UpdateDeps.tarballs` (new field). 3: `UpdateResult`, the end of `recordFound`, `updateChange().apply`. 8: `releaseFactsReader`, `releaseOf`, `decidingSince`, `decidingEffects`, `Planned.deciding`, `UpdateDeps.releaseFacts`. 9: `UpdateDeps.installGlobal`/`globalRoot`, the global sentence in `effectsOf`, the global loop of `applyUpdate` |
| `packages/core/src/update-check.ts` | 4: `UpdateCheckOptions`, `checkForUpdates`, `handUpdateCheckToChild`, `startUpdateCheckChild`, `terminalUpdateHooks`, new exports. 8: `ask`, `runUpdateCheckChild` |
| `packages/core/test/helpers/provenance-fixture.ts` | 1: from `// ── Stand-ins for an update` to the end. 2: `ProvenanceShape` and `provenanceBundle` |
| `packages/core/test/update.test.ts` | 1: the `fakes` helper's `tarballs` line. 8: the release-facts and preview-decision tests. 9: the `installGlobal` stand-in and the global assertions |
| `packages/core/test/update-gate.test.ts` | 1: `deps()`'s `tarballs` line. 3: the R2 tests and `an update installed but not yet loaded…`. 9: `deps()`'s `installGlobal` |
| `helpers/update-machine.ts`, `launcher-update.test.ts`, `wording-identity.test.ts` | 1 (`tarballs`), then 9 (`installGlobal`), in different waves |
| `test/release-packages.test.mjs` | 5, then 12 |

**The lead's traps (from earlier releases):**
- One `pnpm verify` per worktree at a time, and no edits while it runs.
- Under Node 24, a strict runner needs `--test-reporter=tap`.
- Run the root suite (`pnpm test` at the root) before pushing.
- Never WIP-commit an E2 task fragment (Task 7 adds none).

---

## Wave 1

### Task 1: The verified tarball, its declaration and the cache (contracts)

**Files:**
- Create:
  - `packages/core/src/release-tarball.ts`, `packages/core/src/release-declarations.ts`;
  - `packages/core/test/helpers/tarball-fixture.ts`, `packages/core/test/helpers/release-world.ts`.
- Modify:
  - `packages/core/src/update-words.ts`: append `DECLARATION_UNREAD`;
  - `packages/core/src/update-release.ts:25-29`: `Packument` gains `dist.tarball`;
  - `packages/core/src/operations/update.ts`: `UpdateDeps` gains `tarballs`;
  - `packages/core/package.json`: the `test` script runs under the loopback seal;
  - `packages/core/test/helpers/provenance-fixture.ts`, from `// ── Stand-ins for an update` on: `tarballOf`,
    `packumentRegistry`, `registryOf`, plus the new `fixtureTarballs`;
  - wire `tarballs: fixtureTarballs` into every test's update deps that carries `testReleaseVerifier`:
    `update.test.ts` (`fakes`), `update-gate.test.ts` (`deps`), `helpers/update-machine.ts`, `launcher-update.test.ts`,
    `wording-identity.test.ts`, `fixtures/verified-core-cli.ts`, `fixtures/verified-core-server.ts`.
- Test: `packages/core/test/release-tarball.test.ts`, `packages/core/test/release-declarations.test.ts`.

**Interfaces:**
- Consumes: `VerifiedProvenance` (type, `update-provenance.ts`); `releaseDeclaration`, `Packument`
  (`update-release.ts`); `writeFileAtomic` (`fs.ts`); `withFileLock` (`lock.ts`).
- Produces:
  ```ts
  // release-tarball.ts: no Sigstore, no top-level side effects (WhatsApp's bundle must be able to drop it)
  export const TARBALL_MAX_BYTES = 32 * 1024 * 1024;
  export const TARBALL_TIMEOUT_MS = 60_000;
  export const TARBALL_MAX_REDIRECTS = 5;
  export const UNPACKED_MAX_BYTES = 128 * 1024 * 1024;
  export const MANIFEST_MAX_BYTES = 1024 * 1024;
  export type TarballFetch = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;
  export type TarballProblem = 'download' | 'size' | 'digest' | 'gzip' | 'archive' | 'manifest' | 'identity';
  export interface TarballRelease { packageName: string; version: string; /** verified, hex */ sha512: string }
  export interface TarballEntry { /** below `package/`, POSIX */ path: string; type: 'file' | 'directory' | 'link' | 'other'; data: Buffer }
  export function canonicalTarballUrl(packageName: string, version: string): string;
  /** `dist.tarball` of `version` when it is an absolute http(s) URL; otherwise null. */
  export function tarballLocation(packument: Packument, version: string): string | null;
  export function downloadVerifiedTarball(release: TarballRelease, location: string | null,
    options?: { fetch?: TarballFetch; timeoutMs?: number }):
    Promise<{ ok: true; bytes: Buffer } | { ok: false; problem: 'download' | 'size' | 'digest' }>;
  export function tarballEntries(gz: Buffer):
    { ok: true; entries: TarballEntry[] } | { ok: false; problem: 'gzip' | 'archive' };
  export function tarballManifest(gz: Buffer):
    { ok: true; manifest: Record<string, unknown> } | { ok: false; problem: 'gzip' | 'archive' | 'manifest' };

  // release-declarations.ts
  export const DECLARATIONS_FILE = 'release-declarations.json';
  export interface DeclarationRecord { version: string; integrity: string; security: boolean; needsDecision: boolean }
  export type DeclarationRead =
    | { known: true; version: string; security: boolean; needsDecision: boolean; from: 'cache' | 'tarball' }
    | { known: false; version: string; problem: TarballProblem };
  export function declarationsPath(stateDir: string): string;
  export function readVerifiedDeclaration(
    provenance: Pick<VerifiedProvenance, 'package' | 'version' | 'sha512'>,
    location: string | null,
    options: { stateDir: string; fetch?: TarballFetch; writeCache?: boolean; timeoutMs?: number },
  ): Promise<DeclarationRead>;

  // update-words.ts
  export const DECLARATION_UNREAD = 'its declaration could not be read from its verified release';

  // operations/update.ts, UpdateDeps
  /** How a release's tarball is fetched, to read what it declares and to install a global package from it. Defaults to `fetch`. */
  tarballs?: TarballFetch | undefined;

  // test/helpers/tarball-fixture.ts
  export interface FixtureEntry { path: string; data?: string | Buffer; type?: '0' | '2' | '5' | 'x' | 'L' | 'g'; linkname?: string }
  export function ustar(entries: readonly FixtureEntry[], options?: { badChecksumAt?: number }): Buffer; // mtime 0, deterministic
  export function gzip(bytes: Buffer): Buffer;
  export function releaseTarball(packageName: string, version: string, options?: {
    declares?: unknown; manifest?: Record<string, unknown>; files?: Record<string, string | Buffer> }): Buffer;
  export function integrityOfBytes(bytes: Buffer): string;          // `sha512-<base64>`
  export function unpackTarball(gz: Buffer, into: string): Promise<void>; // package/* → into/*
  // provenance-fixture.ts (changed below its stand-ins heading)
  export const tarballOf: (packageName: string, version: string) => string; // integrity of releaseTarball(packageName, version)
  export function fixtureTarballUrl(packageName: string, version: string): string; // https://registry.comms.test/<name>/-/<file>-<version>.tgz
  export const fixtureTarballs: TarballFetch;     // serves releaseTarball for fixtureTarballUrl; 404 for anything else
  // packumentRegistry and registryOf now give every version `dist.tarball: fixtureTarballUrl(...)`

  // test/helpers/release-world.ts
  export interface WorldRelease {
    version: string;
    packages?: readonly string[];      // default: every package `latest` names
    declares?: unknown;                // the tarball manifest's agentcommsRelease (core only)
    registrySays?: unknown;            // the packument's agentcommsRelease (core only); default: declares
    publishedAt?: Date;                // packument time
    signedAt?: Date;                   // passed to provenanceBundle as its signing time
    shape?: Partial<ProvenanceShape> | 'missing';
    serve?: 'ok' | 'missing' | 'other-bytes'; // what its tarball location answers
  }
  export interface World {
    registry: ReleaseRegistry; registryAsked: string[];
    attestations: AttestationFetch; attestationsAsked: string[];
    verifyBundle: BundleVerifier; verifyRelease: ReleaseVerifier;
    tarballs: TarballFetch; tarballsAsked: string[];
    tarball(packageName: string, version: string): Buffer;
    integrity(packageName: string, version: string): string;
    change(next: Record<string, Partial<ProvenanceShape> | 'missing'>): void; // by package or package@version, mid-test
  }
  export function releaseWorld(latest: Record<string, string>, releases?: readonly WorldRelease[]): World;
  /** The world on 127.0.0.1: packuments (`dist.tarball` pointing here) and tarballs; `toNpm` serves npm another tarball by name. */
  export function loopbackRegistry(world: World, options?: { toNpm?: Record<string, Buffer> }):
    Promise<{ url: string; asked: { url: string; npm: boolean }[]; close(): Promise<void> }>;
  ```
- The cache is keyed by `integrity = 'sha512-' + Buffer.from(sha512, 'hex').toString('base64')` and the version. It
  keeps the newest 64 records. It is written atomically under `<state>/.release-declarations.lock`, and only for a
  known declaration, unless `writeCache: false`. A file that cannot be read counts as empty.

- [ ] **Step 1: Write the failing tests, `release-tarball.test.ts`**
  - Network: a loopback `node:http` server on `127.0.0.1:0`, through real `fetch`. Wrap it in a recording `TarballFetch`
    that hands loopback URLs to `fetch`, and answers the canonical URL with a 503 or a stand-in.
  - `a verified tarball downloads over HTTP, and its bytes are the verified digest's` → `{ ok: true }`, equal bytes.
  - `any http or https location is used, through at most five redirects`:
    - 5 chained 302s → ok;
    - 6 → `problem: 'download'`, with the canonical asked once.
  - `a redirect to another scheme is not followed`: `Location: file:///etc/hosts` gives `download`.
  - `a location that fails is tried once more at npm's canonical address`: a 500, then the canonical stand-in serves →
    ok. `asked` is `[location, canonical]`.
  - `a canonical location is not tried twice`.
  - `a download over 32 MiB is refused, by its length or by what arrives`, both giving `size`:
    - `content-length: 33554433`, with the body never read;
    - a chunked body past 32 MiB.
  - `a download that does not finish in its time is refused`: `timeoutMs: 200` against a stalled server gives
    `download`.
  - `bytes that are not the verified digest's are refused`: `digest` from both the location and the canonical URL.
  - `a gzip bomb stops past 128 MiB`: `gzip(Buffer.alloc(129 * 2**20))` gives `tarballManifest`'s problem `gzip`.
  - `package/package.json is read when it is exactly one regular file of at most 1 MiB` → the manifest object.
  - Each of these is `manifest` or `archive`, as named:
    - none (`manifest`); two (`manifest`);
    - a pax `x` header whose `path=package/package.json` renames a later entry (`manifest`, two by that name);
    - a symlink by that name (`manifest`); 1 MiB + 1 byte (`manifest`); a JSON array (`manifest`);
    - a bad checksum on any header (`archive`); a `..` segment (`archive`); an entry outside `package/` (`archive`).
  - `tarballEntries lists every regular file below package/, with its bytes`.

- [ ] **Step 2: Write the failing tests, `release-declarations.test.ts`** (with `releaseWorld`)
  - `each flag is read from the verified tarball, and the registry's word never decides`:
    - four cases: `security` and `needsDecision`, each `true` in the tarball against `registrySays: {}`, and the
      reverse;
    - assert the read equals the tarball's;
    - `registryAsked` is empty: the reader never reads a packument.
  - `a name or version in the tarball that is not the release's makes it unknown` → `{ known: false, problem:
    'identity' }`.
  - `each refusal of the download or the archive is unknown, and nothing is cached`: `digest`, `gzip`, `manifest`. The
    file is absent afterwards.
  - `a cached declaration is used again without a download`: the second read is `from: 'cache'`, and `tarballsAsked`
    is unchanged.
  - `the cache holds only version, integrity and the two flags`: each record's keys deep-equal
    `['integrity', 'needsDecision', 'security', 'version']`.
  - `a cache that cannot be read is no cache`: garbage in the file → downloads, then the file parses.
  - `writeCache false leaves the file as it was`.
  - `two readers at once keep both declarations` (Review Focus 5): two versions, read with `Promise.all` → both cached.
  - `the cache keeps the newest 64`.

- [ ] **Step 3: Run them, and see them fail**

  Run: `cd packages/core && node --experimental-strip-types --test test/release-tarball.test.ts test/release-declarations.test.ts`
  Expected: FAIL, `Cannot find module '../src/release-tarball.ts'`.

- [ ] **Step 4: Implement `release-tarball.ts`**
  - Fetch with `redirect: 'manual'` and `AbortSignal.timeout(timeoutMs)`, once for each location. Read the body as a
    stream, counting bytes. No `accept-encoding` or credential header.
  - Gunzip with `gunzipSync(bytes, { maxOutputLength: UNPACKED_MAX_BYTES })`, mapping its `RangeError` to `gzip`.
  - The ustar walk: 512-byte headers. Checksum = the header's byte sum with bytes 148–155 read as spaces, against the
    octal at 148. The size is octal at 124 (a high-bit base-256 size is `archive`). The name is prefix (345) plus `/`
    plus name (0), when the magic is `ustar`.
  - Stop at the first all-zero block. The rules in gap 12 apply.

- [ ] **Step 5: Implement `release-declarations.ts`**
  - Read the cache: on a hit, return `from: 'cache'`.
  - Otherwise `downloadVerifiedTarball` → `tarballManifest` → name and version equal the provenance's →
    `releaseDeclaration(manifest)`. Write the cache best-effort (a failure to write never changes the answer), and
    return `from: 'tarball'`.

- [ ] **Step 6: Add the fixtures**
  - The tarball builder, `release-world.ts`, and the provenance-fixture changes listed under Files.
  - Wire `tarballs: fixtureTarballs` into the seven helper sites. Nothing reads it until Task 8, so behaviour is
    unchanged.
  - Add `DECLARATION_UNREAD`, the `Packument` field and the `UpdateDeps.tarballs` field.
  - Change core's test script to
    `node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --test "test/**/*.test.ts"`.

- [ ] **Step 7: Run the new tests, then core's whole suite under the seal**

  Run: `cd packages/core && node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --test test/release-tarball.test.ts test/release-declarations.test.ts`
  Expected: PASS.

  Run: `pnpm --filter @agentcomms/core test && pnpm --filter @agentcomms/core typecheck && pnpm lint`
  Expected: PASS. A test the seal breaks was reaching off-loopback: give it a stand-in in this task, and name it in
  the report.

- [ ] **Step 8: Mutants, by hand.** Each one should turn its named test red:
  - drop the redirect count;
  - compare the digest to the registry's integrity instead of the verified one;
  - take the first `package/package.json` and skip the duplicate check;
  - let `tarballManifest` ignore a pax `path`;
  - cache an unknown declaration.

  Then revert each.

- [ ] **Step 9: Commit**

  ```bash
  git add packages/core/src/release-tarball.ts packages/core/src/release-declarations.ts packages/core/src/update-words.ts \
    packages/core/src/update-release.ts packages/core/src/operations/update.ts packages/core/package.json \
    packages/core/test/release-tarball.test.ts packages/core/test/release-declarations.test.ts packages/core/test/helpers \
    packages/core/test/update.test.ts packages/core/test/update-gate.test.ts packages/core/test/launcher-update.test.ts \
    packages/core/test/wording-identity.test.ts packages/core/test/fixtures/verified-core-cli.ts packages/core/test/fixtures/verified-core-server.ts
  git commit -m "feat(core): a release's declaration is read from its verified tarball, and cached per integrity" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 2: Rekor's signed time, and a machine's first sight

**Files:**
- Create: `packages/core/src/release-first-seen.ts`.
- Modify:
  - `packages/core/src/update-provenance.ts` (`VerifiedProvenance`, `BundleVerifier`, `SigstoreModules`,
    `sigstoreBundleVerifier`, `verifyProvenance`);
  - `packages/core/test/helpers/provenance-fixture.ts` (`ProvenanceShape`, `provenanceBundle` only).
- Test: `packages/core/test/update-provenance.test.ts` (append), `packages/core/test/release-first-seen.test.ts`.

**Interfaces:**
- Consumes: `withFileLock`, `writeFileAtomic`.
- Produces:
  ```ts
  // update-provenance.ts
  export interface BundleFacts { /** Rekor's integrated time, ISO: one tlog entry whose inclusion promise sigstore-js verified. */ signedAt: string | null }
  export type BundleVerifier = (bundle: unknown, policy: BundlePolicy) => Promise<BundleFacts | undefined | void>;
  // VerifiedProvenance gains:
  signedAt: string | null;     // from the bundle verifier's facts; null when it says nothing
  /** The signed time of an entity sigstore-js has just verified: exactly one tlogEntries[0] with an inclusionPromise, a positive integratedTime. */
  export function signedTimeOf(entity: unknown): string | null;

  // test fixture
  export type TlogShape = 'promise' | 'both' | 'proof' | 'two' | 'bad-promise' | 'none';
  // ProvenanceShape gains, per release (§4 P4: "ProvenanceShape gains a per-release signedAt"):
  //   signedAt?: Date      (the bundle's signing and integrated time; wins over provenanceBundle's second parameter)
  //   tlog?: TlogShape     (default 'promise', today's bundle)

  // release-first-seen.ts
  export const FIRST_SEEN_FILE = 'release-first-seen.json';
  export interface SeenRelease { package: string; version: string; integrity: string }
  /**
   * When this machine first saw each release, by `${package}@${version}`. One never seen is recorded at `now`, the
   * machine's own clock. A record more than 5 minutes ahead of `now` is recorded again as `now`. With
   * `record: false`, nothing is written, and an unseen release reads as `now`.
   */
  export function firstSeenTimes(stateDir: string, releases: readonly SeenRelease[], now: Date,
    options?: { record?: boolean }): Promise<Map<string, Date>>;
  ```
- The file is `{ "seen": [{ "package", "version", "integrity", "at" }] }`, the newest 128, written under
  `<state>/.release-first-seen.lock`.
- The bundle shapes:
  - `'proof'` is a v0.2 bundle (`application/vnd.dev.sigstore.bundle+json;version=0.2`), since v0.1 requires a
    promise: a tree of size 1, `rootHash = sha256(0x00 ‖ canonicalizedBody)`, `hashes: []`, `logIndex: 0`, and a
    checkpoint note signed by the test tlog key (key hint = the first 4 bytes of its key id).
  - `'both'` is npm's real shape, a promise and a proof.
  - `'two'` is two entries with different `logIndex` and `integratedTime`, each with a valid promise.
  - `'bad-promise'` flips one byte of the SET.

- [ ] **Step 1: Confirm the reading.** Open `@sigstore/verify` 2.1.1 in this worktree's `node_modules`
  (`dist/timestamp/index.js`, `dist/timestamp/set.js`, `dist/verifier.js`) and confirm gap 2's reading. Record it in
  `update-provenance.ts`'s header comment. If 2.1.1 there differs, stop and report: core would then verify the SET
  itself.

- [ ] **Step 2: Write the failing tests, `update-provenance.test.ts`**
  - `Rekor's integrated time is the signed time, from the one entry sigstore-js verified`: with `signedAt`
    `2026-10-10T12:00:00Z`, `provenance.signedAt === '2026-10-10T12:00:00.000Z'`.
  - `npm's shape — a promise and an inclusion proof — gives the signed time` (`tlog: 'both'`).
  - `an entry with an inclusion proof and no promise verifies, with no signed time` (`'proof'`): `ok`, `signedAt:
    null`.
  - `two entries verify, with no signed time` (`'two'`).
  - `a promise that does not verify refuses the release` (`'bad-promise'`): `field: 'signature'`, and the reason
    matches `/\(TLOG_INCLUSION_PROMISE_ERROR\)/`.
  - `a bundle with no tlog entry is refused` (`'none'`): `field: 'signature'`.
  - `a bundle verifier that says nothing gives no signed time` (`async () => undefined`): `signedAt: null`.

- [ ] **Step 3: Write the failing tests, `release-first-seen.test.ts`**
  - `a release first seen is recorded at the machine's clock, and read back unchanged`.
  - `a recorded first sight is never moved earlier, whatever clock asks`: asked again with an earlier `now`, the same
    time comes back.
  - `a first sight recorded more than five minutes ahead of the clock is recorded again as now` (Review Focus 4).
  - `another integrity for the same version is another sight`.
  - `record false writes nothing, and an unseen release reads as now`.
  - `a file that cannot be read is treated as empty and written afresh; one that cannot be written gives now`. The
    unwritable case uses a state folder made read-only. Skip it on Windows, which has no POSIX modes.
  - `two runs at once keep both sights` (Review Focus 5).
  - `only package, version, integrity and at are kept, the newest 128`.

- [ ] **Step 4: Run them, and see them fail**

  Run: `cd packages/core && node --experimental-strip-types --test test/update-provenance.test.ts test/release-first-seen.test.ts`
  Expected: FAIL. `signedAt` is undefined, and `release-first-seen.ts` is missing.

- [ ] **Step 5: Implement it**
  - `SigstoreModules.verify.toSignedEntity` returns `unknown`. `sigstoreBundleVerifier` keeps the entity, calls
    `verifier.verify(entity, policy)`, then returns `{ signedAt: signedTimeOf(entity) }`.
  - `verifyProvenance` copies `signedAt` from the facts, or `null`.
  - `integratedTime` stays as it is: unverified, for display.
  - Build the fixture shapes as specified, and the first-seen module.

- [ ] **Step 6: Run the tests, and the provenance users**

  Run: `cd packages/core && node --experimental-strip-types --test test/update-provenance.test.ts test/release-first-seen.test.ts test/update-background.test.ts test/install-provenance.test.ts && pnpm --filter @agentcomms/core typecheck`
  Expected: PASS.

- [ ] **Step 7: Mutants, by hand.** Each one should turn its named test red:
  - take `tlogEntries[0]` without the count check;
  - drop the `inclusionPromise` condition;
  - let `firstSeenTimes` keep a future time.

- [ ] **Step 8: Commit**

  ```bash
  git add packages/core/src/update-provenance.ts packages/core/src/release-first-seen.ts \
    packages/core/test/update-provenance.test.ts packages/core/test/release-first-seen.test.ts packages/core/test/helpers/provenance-fixture.ts
  git commit -m "feat(core): provenance carries the time Rekor signed, and a machine remembers when it first saw a release" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 3: The update-check lock waits per holder, and a person's record survives (R2)

**Files:**
- Modify:
  - `packages/core/src/update-state.ts` (`changeUpdateCheck`);
  - `packages/core/src/operations/update.ts` (`UpdateResult`, `recordFound`'s return and catch,
    `updateChange().apply`);
  - `packages/core/src/render.ts` (`renderUpdate`).
- Create: `packages/core/test/helpers/hold-lock.ts`.
- Test: `packages/core/test/update-gate.test.ts`.

**Interfaces:**
- Consumes: `LockOptions` (`lock.ts`).
- Produces:
  ```ts
  // update-state.ts
  export const UPDATE_CHECK_LOCK: LockOptions = Object.freeze({ timeoutPerHolder: true, timeoutMs: 2_000, maxWaitMs: 15_000 });
  // operations/update.ts
  export const RECORD_DEFERRED = 'the update was installed; its record will be corrected by the next check';
  // UpdateResult gains:
  /** Set when the record of an applied update could not be written, after one retry. */
  recordNote?: string | undefined;
  // recordFound (module-private) now returns:
  Promise<'written' | 'unchanged' | 'busy'>   // 'busy' only for LOCK_TIMEOUT; anything else is 'unchanged', as before
  // test/helpers/hold-lock.ts
  /** Holds `lockPath` as `withFileLock` writes it ({ pid, at, token }), one fresh token per hold, back to back, then removes it. */
  export function holdLock(lockPath: string, holds: readonly number[]): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests, `update-gate.test.ts`**
  - `a record lock handed on within its bound keeps a person's update record`. While `holdLock(<state>/.update-check.lock,
    [1500, 1500])` runs, apply an update through the server. Then `record.behind === false`, `record.current` names
    `core`, and there is no `recordNote`. This fails today: 2 s count from the start of the wait.
  - `a record lock held past its bound leaves the update installed, and says its record will be corrected`. Run
    `holdLock(..., [5000])`, which beats both 2 s tries. Then:
    - `status === 'updated'` and `recordNote === RECORD_DEFERRED`;
    - the record is unchanged;
    - `renderUpdate` includes the sentence;
    - the MCP result's `structuredContent.recordNote` is the sentence.
  - `changeUpdateCheck takes the lock per holder, 2 s each, 15 s in all`:
    `assert.deepEqual(UPDATE_CHECK_LOCK, { timeoutPerHolder: true, timeoutMs: 2_000, maxWaitMs: 15_000 })`, and
    holders `[1500, 1500, 1500]` are waited out.
  - Change `an update installed but not yet loaded: the notice says to restart the client, not to update` to hold the
    lock deterministically, with `holdLock(..., [1000, 1000])` across its apply. That is the Windows Node 22 flake's
    test.

- [ ] **Step 2: Run them, and see them fail**

  Run: `cd packages/core && node --experimental-strip-types --test test/update-gate.test.ts`
  Expected: FAIL. The record is not written (the 2 s budget is spent), and `UPDATE_CHECK_LOCK` is undefined.

- [ ] **Step 3: Implement it**
  - `changeUpdateCheck` passes `UPDATE_CHECK_LOCK`.
  - In `apply`, after `applyUpdate`: if `recordFound` returns `'busy'`, call it once more. If that is `'busy'` too,
    set `result.recordNote = RECORD_DEFERRED`.
  - `renderUpdate` prints `recordNote` on its own line, after `next`.

- [ ] **Step 4: Run them again**

  Run: `cd packages/core && node --experimental-strip-types --test test/update-gate.test.ts test/update.test.ts && pnpm --filter @agentcomms/core typecheck`
  Expected: PASS.

- [ ] **Step 5: Mutant, by hand.** Each one should turn its named test red:
  - drop the retry;
  - drop `timeoutPerHolder`.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/core/src/update-state.ts packages/core/src/operations/update.ts packages/core/src/render.ts \
    packages/core/test/update-gate.test.ts packages/core/test/helpers/hold-lock.ts
  git commit -m "fix(core): an update's record waits for each holder of the lock in turn, and is never silently lost" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 4: A channel hands its check to core's CLI (P2)

**Files:**
- Modify:
  - `packages/core/src/update-check.ts`, its regions in "Running this plan";
  - `packages/{gmail,slack,resend}/src/cli/program.ts`: `CliDeps.updateHandOff`, passed to `terminalUpdateHooks`;
  - `packages/{gmail,slack,resend}/src/mcp/server.ts`: `<Channel>McpOptions.updateHandOff`, passed to
    `checkForUpdates` in `refresh`;
  - `packages/whatsapp/test/update-gate.test.ts`: the list of names the bundle must not carry.
- Create: `packages/core/test/update-check-handoff.test.ts`, `test/channel-core-spawn.test.mjs`.
- Test: `packages/{gmail,slack,resend}/test/update-gate.test.ts` (append).

**Interfaces:**
- Consumes: `requireHandoffs`, `isCommand` (`handoffs.ts`); `PrintedCommand.words`; `updateCheckChildEnvironment`;
  `UPDATE_CHECK_LEASE_MS`.
- Produces:
  ```ts
  export interface CoreHandOff {
    /** Core's command for `update-check-child <claimedAt>`, as words; null when there is none. Default `coreUpdateCheckWords`. */
    locate?: ((core: Core, claimedAt: string) => readonly string[] | null) | undefined;
    /** Starts the words detached, with no shell, waiting until `deadline` at most; false when it could not start. Default `startCheckChild`. */
    start?: ((words: readonly string[], env: NodeJS.ProcessEnv, deadline: number) => Promise<boolean>) | undefined;
  }
  /**
   * `requireHandoffs(core).core([UPDATE_CHECK_CHILD_COMMAND, claimedAt], { downloads: true })`, as its words, when that
   * is a located command. Null for core's own process, a core opened without handoffs, or no command.
   */
  export function coreUpdateCheckWords(core: Core, claimedAt: string): readonly string[] | null;
  export function startCheckChild(words: readonly string[], env: NodeJS.ProcessEnv, deadline: number): Promise<boolean>;
  // UpdateCheckOptions gains: handOff?: CoreHandOff | undefined
  // terminalUpdateHooks options gain: handOff?: CoreHandOff | undefined
  // each channel's CliDeps and <Channel>McpOptions gain: updateHandOff?: CoreHandOff | undefined  (test seam; default {})
  ```
- `startUpdateCheckChild` becomes `startCheckChild(words, env, deadline)`. The own child's words are
  `[entry.command, ...entry.args, ...pathArgs, UPDATE_CHECK_CHILD_COMMAND, claimedAt]`, as today.
- A server waits until `Date.now() + UPDATE_CHECK_LEASE_MS`, a CLI until the notice's deadline.
- With `handOff` set:
  - **CLI:** claim → locate → start. If neither works, fall back to its own child, then to the in-process check.
  - **Server:** claim → locate → start. If neither works, fall back to `askUnderClaim` in process.

- [ ] **Step 1: Write the failing tests, `update-check-handoff.test.ts`**
  - `a channel's command hands the day's check to core's located CLI, under its claim`:
    - a core opened with a Gmail caller, from a checkout, so it is located as core's `src/cli.ts`;
    - a recording `start`;
    - the words end with `update-check-child`, `<claimedAt>`, they hold `--config-dir <configDir>`, and their entry is
      core's `src/cli.ts`;
    - `start` is called once.
  - `the server's check is handed on too, and waits no longer than the lease`: `deadline - now <=
    UPDATE_CHECK_LEASE_MS`.
  - `with no core located, the channel checks as before`: `locate` returns null → its own child's words, and the
    record's `release` is unchanged.
  - `a spawn that fails falls back to the channel's own check`: `start` returns false.
  - `a located core command that cannot be spawned without a shell falls back to the channel's own check` (Review
    Focus 2):
    - on Windows, a `.cmd` file written into a temporary folder whose name has a space, which Node refuses to spawn
      without a shell (`EINVAL`); elsewhere, a program that does not exist;
    - the real `startCheckChild` returns `false` and does not throw;
    - the channel's own child words are started next.
  - `core's own process never hands its check to itself`: `coreUpdateCheckWords(coreOpenedWithCoreCaller, …) ===
    null`.
  - `the hand-off's environment is the command's child environment`: `NODE_OPTIONS=--inspect-brk` is dropped.

- [ ] **Step 2: Write the failing channel tests** (Gmail, Slack, Resend, in each `update-gate.test.ts`)
  - `agent-<channel> hands the day's check to core's CLI`: run the CLI in process with `deps.updateHandOff = {
    start: recorder }`, the check on and due, and `npm_config_registry` at `http://127.0.0.1:9/`. The recorder sees
    core's words once.
  - `the <channel> server hands its check to core's CLI`: the same, through `create<Channel>McpServer({
    updateHandOff })` and one tool call.

- [ ] **Step 3: Write the failing guard, `test/channel-core-spawn.test.mjs`** (read from `REGISTRY`)
  - `only today's five files of the channels start a process`: the files of `packages/<channel>/src` (every channel
    and wrapper but core) that import `node:child_process` are exactly `gmail/src/cli/browser.ts`,
    `gmail/src/operations/signin.ts`, `slack/src/cli/browser.ts`, `slack/src/operations/signin.ts` and
    `whatsapp/src/cli/opener.ts`.
  - `no channel locates or starts core's update child itself`:
    - no channel source names `coreUpdateCheckWords` or `startCheckChild`;
    - none calls `.core(` with `UPDATE_CHECK_CHILD_COMMAND`;
    - in core, `startCheckChild(` and `coreUpdateCheckWords(` are called only in `src/update-check.ts`.
  - `updateHandOff reaches only the CLI programs and servers of Gmail, Slack and Resend`, never WhatsApp's.
  - Add `coreUpdateCheckWords`, `startCheckChild`, `readVerifiedDeclaration`, `downloadVerifiedTarball`,
    `installVerifiedGlobal` and `release-declarations.json` to `packages/whatsapp/test/update-gate.test.ts`'s list.

- [ ] **Step 4: Run them, and see them fail**

  Run: `cd packages/core && node --experimental-strip-types --test test/update-check-handoff.test.ts && cd ../.. && node --import ./test/helpers/loopback-seal-preload.mjs --test test/channel-core-spawn.test.mjs`
  Expected: FAIL, `coreUpdateCheckWords is not a function`. The guard fails on `updateHandOff` missing from the
  channels.

- [ ] **Step 5: Implement it, and wire the three channels**
  - CLI: `terminalUpdateHooks(core, env, { handOff: deps.updateHandOff ?? {} })`.
  - Server: `refresh: () => checkForUpdates(core, env, { handOff: options.updateHandOff ?? {} })`.

- [ ] **Step 6: Run them, and the channels' suites**

  Run: `pnpm --filter @agentcomms/core test && pnpm --filter @agentcomms/gmail test && pnpm --filter @agentcomms/slack test && pnpm --filter @agentcomms/resend test && pnpm --filter @agentcomms/whatsapp test && node --import ./test/helpers/loopback-seal-preload.mjs --test test/channel-core-spawn.test.mjs`
  Expected: PASS. WhatsApp's no-network tests still pass.

- [ ] **Step 7: Mutants, by hand.** Each one should turn its named test red:
  - hand the check to core from core's own process;
  - pass `shell: true`;
  - drop the fallback;
  - add a `node:child_process` import to a channel's `src/operations`.

- [ ] **Step 8: Commit**

  ```bash
  git add packages/core/src/update-check.ts packages/gmail/src packages/slack/src packages/resend/src \
    packages/core/test/update-check-handoff.test.ts packages/*/test/update-gate.test.ts test/channel-core-spawn.test.mjs
  git commit -m "feat(gmail,slack,resend): a channel's update check is handed to core's CLI at its own version, which verifies what a release declares" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 5: Release flags in the release checks (P1, declaring)

**Files:**
- Create: `scripts/release-flags.mjs`, `test/release-flags.test.mjs`.
- Modify:
  - `scripts/channels.mjs`: core's `agentcommsRelease` becomes `releaseFlags`, in the holds loop and `readHold`;
  - `scripts/release.mjs`: refuse on flag problems, before the failures are printed;
  - `.github/workflows/release.yml`: the tag gate step, after `release-ci.mjs notes "$tag"`;
  - the comments of `scripts/packages.mjs:12` and `scripts/channels.mjs:19`;
  - `test/channel-registry.test.mjs` (REL-c), `test/release-packages.test.mjs`.

**Interfaces:**
- Produces:
  ```js
  // scripts/channels.mjs: loadRegistry(root) also returns
  releaseFlags: { security: boolean, needsDecision: boolean }   // core's declaration; both false when it has none
  // scripts/release-flags.mjs
  export const SECURITY_MARKER = '**Security fix.**';
  export const DECISION_MARKER = '**Needs a decision before it installs.**';
  /** The lines after `## <version>` up to the next `## `; null when there is no such heading. */
  export function changelogSection(changelog: string, version: string): string | null;
  /** Each mismatch between `flags` and the section's markers, as a sentence; empty when they match. */
  export function releaseFlagProblems({ version, changelog, flags }:
    { version: string; changelog: string; flags: { security: boolean; needsDecision: boolean } }): string[];
  // CLI: `node scripts/release-flags.mjs <version>` reads CHANGELOG.md (RELEASE_CHANGELOG overrides it, as `notes` does)
  // and loadRegistry().releaseFlags, prints each problem as `::error::<problem>`, and exits 1 on any.
  ```
- A marker counts when a line of the section starts with it, with no indentation.
- The refusals core's declaration gets, each prefixed `packages/core/package.json: `:
  - `"agentcommsRelease" on core declares "security" and "needsDecision" only, each true or false`, for an unknown key
    or a non-boolean;
  - `"agentcommsRelease" on core declares neither "security" nor "needsDecision"`, for `{}`;
  - the existing `core cannot be held back from a release…`, for `hold`.
- The problem sentences, with `<v>` the version:
  - `packages/core/package.json declares "security": true, but the ## <v> section of CHANGELOG.md has no line starting
    **Security fix.**`;
  - `the ## <v> section of CHANGELOG.md has a line starting **Security fix.**, but packages/core/package.json does not
    declare "security": true`;
  - the same two for `needsDecision` and its marker;
  - `CHANGELOG.md has no "## <v>" section`.

- [ ] **Step 1: Write the failing tests**
  - `test/release-flags.test.mjs`:
    - `flags and markers must match, both ways, for both flags`: eight cases (each flag on or off × its marker present
      or absent), with exactly the mismatches named;
    - `a marker counts only at the start of a line of the version's own section`: an indented marker, or one under
      another version's heading, counts for nothing;
    - `no section is a problem`;
    - `the CLI exits 1 and prints ::error:: for each problem, 0 when they match`.
  - `test/channel-registry.test.mjs`:
    - REL-c keeps `core cannot be held back` for `hold` on core;
    - a new test `REL-d: core declares a security fix or a needed decision, as booleans and nothing else`:
      `{ security: true }` and `{ needsDecision: true, security: false }` are accepted, and `releaseFlags` reads them;
      `{}`, `{ security: 'yes' }`, `{ security: true, until: 1 }` and `{ security: true, hold: 'x' }` are each refused
      with the messages above;
    - a channel's `{ security: true }` is still `has unknown key "security"`.
  - `test/release-packages.test.mjs`:
    - `the tag gate checks the release flags before anything is sent`: the gate step runs
      `node scripts/release-flags.mjs "$tag"` after `release-ci.mjs notes "$tag"` and before the OIDC preflight;
    - `scripts/release.mjs refuses flags that do not match the changelog`: it imports `releaseFlagProblems`.

- [ ] **Step 2: Run them, and see them fail**

  Run: `node --import ./test/helpers/loopback-seal-preload.mjs --test test/release-flags.test.mjs test/channel-registry.test.mjs test/release-packages.test.mjs`
  Expected: FAIL. `scripts/release-flags.mjs` is missing, and core's `{ security: true }` is refused as a hold.

- [ ] **Step 3: Implement it**, as the interfaces say. The workflow step keeps its `if:` (tags only). Add a comment
  saying why the check is there: flags left from the last release would otherwise apply to the next.

- [ ] **Step 4: Run them again, and the registry's users**

  Run: `node --import ./test/helpers/loopback-seal-preload.mjs --test "test/**/*.test.mjs" && pnpm verify:channels`
  Expected: PASS.

- [ ] **Step 5: Mutant, by hand.** Each one should turn its named test red:
  - check only one direction of each flag;
  - accept `hold` on core.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/release-flags.mjs scripts/channels.mjs scripts/release.mjs scripts/packages.mjs .github/workflows/release.yml \
    test/release-flags.test.mjs test/channel-registry.test.mjs test/release-packages.test.mjs
  git commit -m "feat(release): core may declare a security fix or a needed decision, and the release refuses one its changelog does not say" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 6: The desktop release scripts run with `--confirm` (R1)

**Files:**
- Modify: `apps/desktop/scripts/release-desktop.sh`, `apps/desktop/scripts/publish-desktop.sh` (arguments, the checks
  that read a terminal, the install line, the header comments).
- Test: `apps/desktop/src/test/release.test.ts`.

**Interfaces:**
- Usage lines:
  - `apps/desktop/scripts/release-desktop.sh desktop-vX.Y.Z [--confirm X.Y.Z [--updater off]]`;
  - `apps/desktop/scripts/publish-desktop.sh desktop-vX.Y.Z [--confirm X.Y.Z]`.
- Arguments after the tag are parsed in a `while` loop. An unknown one is refused: `unknown argument: <arg>`.
- The refusals, in fixed words:
  - `the version given to --confirm does not match; nothing was built.` (`…nothing was published.` in publish);
  - `the updater is off: pass --updater off with --confirm to build it with the updater off.`;
  - `the updater is on: --updater off is refused.`;
  - `--updater off goes with --confirm: at a terminal, type off when asked.`.
- With `--confirm`, the `[ -t 0 ] && [ -t 1 ]` check and both `read -r` prompts are skipped. Every other refusal stays
  where it is.
- The install line becomes
  `CI=true pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'`.
- The header comment's "An agent never does" becomes: an agent may run it once the owner has said so, with
  `--confirm`, on the signing Mac. The signing identity, the notary profile and the updater key stay there.

- [ ] **Step 1: Write the failing tests** (in `describe("the owner's release scripts")`)
  - The harness, a helper in the test file:
    - a temporary git repository with `.gitignore` (`apps/desktop/src-tauri/target/`), the two real scripts copied
      to `apps/desktop/scripts/`, and `apps/desktop/src-tauri/tauri.conf.json` at `0.26.0`;
    - stub `updater-key.mjs` (prints `$TEST_UPDATER`), `third-party-licenses.mjs`, `release-notes.mjs` and
      `updater-manifest.mjs`;
    - committed, and tagged `desktop-v0.26.0`.
  - Stand-ins on `PATH`, each appending `<name> <args> CI=$CI` to a log:
    - `uname` (prints `Darwin`), `security` (prints the identity), `rustup`, `codesign`, `spctl` and `lipo` (prints
      `x86_64 arm64`);
    - `xcrun`: `notarytool submit` prints `{"status":"Accepted"}`;
    - `pnpm`: `tauri build` writes the app, the DMG, and, with the updater on, a real `tar -czf` archive and its
      `.sig`;
    - `gh`, answering what `publish-desktop.sh` asks;
    - `git`, which forwards to the real git, found before `PATH` changes, except `ls-remote`, which prints the tag's
      commit.
  - The tests run `spawnSync('bash', …)` with stdio pipes, so there is no terminal. Each is
    `it.skipIf(process.platform === 'win32')`, because Windows has no bash to run them.
  - `release-desktop.sh builds headless with --confirm against stand-ins, and installs under CI=true`:
    - exit 0, and the staged folder holds the DMG, `SHA256SUMS`, `.built-at-commit` and `.updater` (`off`, given
      `--updater off`);
    - the log's `pnpm install` line says `CI=true`;
    - no call reached anything but a stand-in.
  - `with the updater on, --confirm alone builds and stages the updater archive`.
  - `a wrong --confirm, a missing --updater off, or --updater off with the updater on is refused before anything is
    built`: three cases, each with its sentence, exit 1, and no `tauri build` in the log.
  - `without --confirm, the scripts still need a terminal`: exit 1, `run this in a terminal`.
  - `--updater off without --confirm is refused`.
  - `publish-desktop.sh publishes headless with --confirm against a stand-in gh, and a wrong one is refused`. It runs
    after the release in the same tree. Assert `gh release edit … --draft=false --latest=false` is in the log.
  - Update the existing static tests: the terminal check sits inside the no-`--confirm` branch, and the refusal order
    still puts every refusal before `. "$ENV_FILE"` and `tauri build`.

- [ ] **Step 2: Run them, and see them fail**

  Run: `pnpm --filter @agentcomms/desktop exec vitest run src/test/release.test.ts`
  Expected: FAIL. `--confirm` is read as a second tag (`the tag must be …`), and the install line has no `CI=true`.

- [ ] **Step 3: Implement it** in both scripts.

- [ ] **Step 4: Run them, the parse check and the E2 install fence**

  Run: `pnpm --filter @agentcomms/desktop exec vitest run src/test/release.test.ts && bash -n apps/desktop/scripts/release-desktop.sh && bash -n apps/desktop/scripts/publish-desktop.sh && pnpm verify:events-phase-e2`
  Expected: PASS. The fence still accepts the install line with `CI=true` in front. If it does not, the fence's parser
  is fixed in this task, without editing any anchored line.

- [ ] **Step 5: Mutant, by hand.** Each one should turn its named test red:
  - accept any `--confirm`;
  - skip the updater check under `--confirm`.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/desktop/scripts/release-desktop.sh apps/desktop/scripts/publish-desktop.sh apps/desktop/src/test/release.test.ts
  git commit -m "feat(desktop): the signed release and its publish run without a terminal when the version is confirmed on the command line" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 7: The E2 checker reads imports with TypeScript's tokenizer (R3)

**Files:**
- Modify:
  - `scripts/verify-events-phase-e2-tests.mjs`: `codeOnly` (`:701`), `valueImports` (`:1023`) and
    `codeImportSpecifiers` (`:1044`), now exported, with the import of TypeScript's scanner;
  - `packages/events-daemon/test/laya-mutations.test.ts`: one more case inside the existing test.
- Create: `test/e2-import-reading.test.mjs`.

**Interfaces:**
- Consumes: `createScanner` from `typescript/unstable/ast/scanner`, `SyntaxKind` from `typescript/unstable/ast` (the
  root's `typescript` 7.0.2).
- Produces:
  ```js
  /** Static `import … from`, `export … from`, a bare `import '…'`, `import('…')` and `require('…')`, read past comments,
   *  strings, regular expressions and templates. */
  export function codeImportSpecifiers(source: string): string[];
  /** The same, less `import type …` and `export type … from`; `import type from 'x'` (a default import named type) counts. */
  export function valueImports(source: string): string[];
  /** The source with every comment removed and everything else byte for byte. */
  export function codeOnly(source: string): string;
  ```
- The token walk scans with `createScanner(false, …)`.
  - A `/` or `/=` is re-scanned with `reScanSlashToken()` unless the last significant token ends an expression:
    an identifier, a literal, `)`, `]`, `}`, `this`, `super`, `true`, `false`, `null`, `++` or `--`.
  - A `}` that closes a template substitution is re-scanned with `reScanTemplateToken(false)`, tracked with a stack.
  - Specifiers are the next `StringLiteral`'s value after `from`, after `import`, or after `import (` / `require (`.
- Every call site keeps its shape. No frozen fragment's anchored line changes: the anchors are the `fail(…)` lines.

- [ ] **Step 1: Write the failing tests**
  - `test/e2-import-reading.test.mjs`:
    - `an apostrophe in a regular expression does not hide a later import`:
      `codeImportSpecifiers("const q = /'/;\nimport '@receptron/laya';\n")` includes `@receptron/laya`. This fails
      today;
    - `a comment, a string or a template's text that only mentions a package is not an import`;
    - `import type is not a value import; import(), require, export-from and import type from 'x' are`;
    - `codeOnly removes comments, and keeps a // inside a string or a regular expression`;
    - `the scanner this reads with is TypeScript's own`: `typeof createScanner === 'function'` from
      `typescript/unstable/ast/scanner`. A TypeScript upgrade that moves it fails here, by name.
  - `laya-mutations.test.ts`, inside `E2 static boundary: any file that imports the Laya runtime or its private package
    is refused`: a second `withCase` writes `scripts/laya-regex-runtime.mjs` = `"const quote = /'/;\nimport
    '@receptron/laya';\n"`, and `expectRejected(root, /laya-regex-runtime\.mjs imports @receptron\/laya/)`. No test is
    renamed, and no fragment or matrix row changes.

- [ ] **Step 2: Run them, and see them fail**

  Run: `node --import ./test/helpers/loopback-seal-preload.mjs --test test/e2-import-reading.test.mjs`
  Expected: FAIL. The functions are not exported, and once they are, the apostrophe case finds nothing.

- [ ] **Step 3: Implement it**, as the interfaces say.

- [ ] **Step 4: Run them, the checker and the strict runner**

  Run: `node --import ./test/helpers/loopback-seal-preload.mjs --test test/e2-import-reading.test.mjs && pnpm verify:events-phase-e2 && cd packages/events-daemon && node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-reporter=tap test/laya-mutations.test.ts`
  Expected: PASS, and `Phase E2 proof pairing: OK`.

- [ ] **Step 5: Mutant, by hand.** Restore the old character scanner in `codeImportSpecifiers`: both apostrophe tests
  fail. Then revert it.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/verify-events-phase-e2-tests.mjs test/e2-import-reading.test.mjs packages/events-daemon/test/laya-mutations.test.ts
  git commit -m "fix(scripts): the E2 checker reads imports with TypeScript's own tokenizer, so a quote in a regular expression hides none" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

## Wave 2

### Task 8: The daily check and the preview read flags from the verified tarball (P1, P2)

**Files:**
- Create: `packages/core/src/release-facts.ts`, `packages/core/test/fixtures/declared-core-cli.ts`.
- Modify:
  - `packages/core/src/update-release.ts`: remove `declaredSince`, `DeclaredSince` and `DecidingRelease`;
  - `packages/core/src/operations/update.ts`, its regions in "Running this plan";
  - `packages/core/src/update-check.ts`: `ask` and `runUpdateCheckChild`;
  - `packages/core/src/cli.ts:657-661`: `update-check-child` takes `deps.update` when given.
- Test: `packages/core/test/release-facts.test.ts`, and `packages/core/test/update.test.ts` (the release-facts table
  and the preview-decision tests).

**Interfaces:**
- Consumes: `readVerifiedDeclaration`, `tarballLocation`, `DECLARATION_UNREAD`, `releaseWorld`, `loopbackRegistry`
  (Task 1); `releasesBetween`, `releaseIntegrity` (`update-release.ts`).
- Produces:
  ```ts
  // release-facts.ts
  export interface DeclarationSources { registry: ReleaseRegistry; verify: ReleaseVerifier; stateDir: string; tarballs?: TarballFetch | undefined }
  export interface DeclaredSince {
    /** The latest's, from its verified tarball; null when it could not be read. */
    security: boolean | null;
    /** True when any release read says so; false when every one was read and none does; null otherwise. */
    needsDecision: boolean | null;
    /** The releases read that say they need a decision, oldest first. */
    deciding: string[];
    /** The releases whose declaration could not be read, oldest first: unverified, no integrity, or unknown. */
    unread: string[];
  }
  /** Every release after `from` up to `latest` (`latest` alone when `from` is null), each verified and its declaration read. Throws when the packument cannot be read. */
  export function declaredSince(sources: DeclarationSources, packageName: string, from: string | null, latest: string): Promise<DeclaredSince>;
  /** The record's facts: null unless both `security` and `needsDecision` are known. */
  export function factsOf(version: string, declared: DeclaredSince): ReleaseFacts | null;
  // operations/update.ts
  UpdateDeps.releaseFacts?: ((packageName: string, version: string, from?: string | null) => Promise<ReleaseDeclaration | null>) | null | undefined;
  /** Null for a stand-in `latestVersion` (as today), and for a process with no verifier (P2): it reads no facts. */
  export function releaseFactsReader(env: NodeJS.ProcessEnv,
    deps: Pick<UpdateDeps, 'registry' | 'latestVersion' | 'verifyRelease' | 'tarballs'>, stateDir: string):
    ((packageName: string, version: string, from?: string | null) => Promise<ReleaseDeclaration | null>) | null;
  // releaseOf (private): ReleaseFacts (read and known) | null (read and unknown) | undefined (not read here)
  // Planned.deciding: { deciding: string[]; unread: string[] }
  // runUpdateCheckChild options: { deps?: UpdateDeps | undefined }  (was { verifyRelease })
  ```
- `recordFound`'s own rule is unchanged, and now does what P2 says. An `undefined` `release` keeps a verified one for
  the same version, and otherwise writes `null`.
- `ask` leaves `release` out of `settle` when it is `undefined`.
- The preview's sentences:
  - deciding: `<v>, a release this update takes this machine past, says it needs a decision from you — a migration, or
    a changed safety default: read its release notes before you approve`;
  - unread: `<v>, a release this update takes this machine past: ${DECLARATION_UNREAD}, so whether it needs a decision
    from you is not known — read its release notes before you approve`.
  - `<v>` is `shownRelease(version)`. The "(its provenance could not be verified)" variant goes.
- `declared-core-cli.ts` builds `releaseWorld({ '@agentcomms/core': '99.0.0' }, [{ version: '99.0.0', declares: {
  security: true }, registrySays: {} }])`. It runs `main(argv, env, platform, { update: { verifyRelease:
  world.verifyRelease } })`, with the registry and the tarballs read over `npm_config_registry`, which the test points
  at `loopbackRegistry(world)`. Its tarball bytes are deterministic, so the test's world serves the same bytes.

- [ ] **Step 1: Write the failing tests, `release-facts.test.ts`**
  - `each flag is read from the verified tarball whose packument says the other, both ways`: four cases through
    `declaredSince`, and through `updateCheck` with a verifier, ending in `record.release`.
  - `a release in range that needs a decision is found from its tarball, though the registry says nothing`.
  - `an unread declaration makes no claim`:
    - the latest's tarball `serve: 'missing'` → `security: null` and `record.release === null`;
    - no security line from `securityNotice(...)` (`update-gate.ts`), and none in the server's notice.
  - `a release that does not verify is unread, never counted from the registry's word`.
  - `with no verifier, a check reads no declaration and keeps the verified one` (P2):
    - seed `release: { version: L, security: true, needsDecision: false }`;
    - a check through `releaseFactsReader` with no verifier: `releaseFactsReader(...) === null`, `tarballsAsked`
      empty, and `record.release` unchanged;
    - the same with a newer latest: `record.release === null`, never false flags.
  - `core's update-check-child writes the verified flags, and a channel's unverified check after it keeps them`:
    - claim the check;
    - spawn `process.execPath --experimental-strip-types test/fixtures/declared-core-cli.ts --config-dir … update-check-child <claim>`
      with `npm_config_registry` at the loopback;
    - `record.release` deep-equals `{ version: '99.0.0', security: true, needsDecision: false }`;
    - then make the check due and run an unverified `checkForUpdates`: `release` is unchanged.
- [ ] **Step 2: Update `update.test.ts`**
  - The release-facts table (`'98.0.0 needs a decision…'` … `'no verifier here'`) moves to `releaseWorld`, with
    `declares` in the tarball and `registrySays` the opposite.
  - `'no verifier here'` now expects `record.release === null`.
  - Add `the update preview says when a release's declaration could not be read, and is still shown`: a range
    release's tarball `serve: 'missing'` → the unread sentence, and `approvalRequired`.
  - The hostile-manifest preview test keeps asserting no registry text reaches the preview.

- [ ] **Step 3: Run them, and see them fail**

  Run: `cd packages/core && node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --test test/release-facts.test.ts test/update.test.ts`
  Expected: FAIL. The flags are the packument's, and `release-facts.ts` is missing.

- [ ] **Step 4: Implement it**
  - `declaredSince` reads the packument once. For each version: integrity → `sources.verify` → `readVerifiedDeclaration(
    verdict.provenance, tarballLocation(packument, version), { stateDir, fetch: tarballs })`.
  - `releaseFactsReader` caches packuments per call, as today.

- [ ] **Step 5: Run them, and every update suite**

  Run: `pnpm --filter @agentcomms/core test && pnpm --filter @agentcomms/core typecheck && pnpm --filter @agentcomms/gmail test`
  Expected: PASS. `wording-identity` and the other preview goldens are unchanged, since Task 1's fixture tarballs read
  as known.

- [ ] **Step 6: Mutant, by hand.** Each one should turn its named test red:
  - read `packument.versions[v].agentcommsRelease` in `declaredSince`;
  - write `{ security: false }` from a check with no verifier;
  - make `factsOf` ignore an unread range release.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/core/src/release-facts.ts packages/core/src/update-release.ts packages/core/src/operations/update.ts \
    packages/core/src/update-check.ts packages/core/src/cli.ts packages/core/test/release-facts.test.ts \
    packages/core/test/update.test.ts packages/core/test/fixtures/declared-core-cli.ts
  git commit -m "feat(core): a release's security fix or needed decision is believed only from its verified tarball, and a check that cannot verify erases nothing" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 9: A global package is installed from its verified file, and checked afterwards (P3)

**Files:**
- Create: `packages/core/src/global-install.ts`, `packages/core/test/helpers/global-stand-in.ts`.
- Modify:
  - `packages/core/src/npm.ts`: add `npmGlobalRoot`, and say in `npmInstallGlobal`'s doc that a spec may be a tarball
    file;
  - `packages/core/src/operations/update.ts`, its regions in "Running this plan";
  - the `installGlobal` stand-ins in `update.test.ts`, `update-gate.test.ts` (`deps`), `helpers/update-machine.ts`,
    `launcher-update.test.ts` and `wording-identity.test.ts`, and the global preview lines;
  - `test/fixtures/wording-0.6.0.json`, regenerated with `AGENTCOMMS_WRITE_WORDING=1`, and only its global lines may
    change.
- Test: `packages/core/test/update-global.test.ts`.

**Interfaces:**
- Consumes: `downloadVerifiedTarball`, `tarballEntries`, `tarballLocation` (Task 1); `releaseIntegrity`; `Planned.verified`;
  `handoffSentence`; `releaseWorld`, `loopbackRegistry`, `releaseTarball` (Task 1); `findNpmCli`.
- Produces:
  ```ts
  // npm.ts
  /** `npm root --global`, through the npm beside this Node: the folder global packages are installed in. */
  export function npmGlobalRoot(env: NodeJS.ProcessEnv): Promise<string>;
  // global-install.ts
  export const GLOBAL_MISMATCH = (packageName: string): string => `the global ${packageName} does not match its verified release`;
  export interface GlobalInstallDeps {
    install: (spec: string) => Promise<void>;    // npm install -g <spec>; the spec is the verified tarball's path
    root: () => Promise<string>;                  // npm root -g
    registry: ReleaseRegistry | null;
    verify: ReleaseVerifier | null;
    tarballs?: TarballFetch | undefined;
  }
  /** Downloads the verified tarball, installs exactly it, then checks what npm installed. Never uninstalls. */
  export function installVerifiedGlobal(
    request: { packageName: string; version: string; provenance: VerifiedProvenance },
    deps: GlobalInstallDeps,
    again: string,                                // "run <located core update> again", from handoffs
  ): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Why the package at `dir` is not its verified tarball, in fixed words, or null. */
  export function globalProblem(dir: string, release: TarballRelease & { bytes: Buffer },
    deps: Pick<GlobalInstallDeps, 'registry' | 'verify' | 'tarballs'>): Promise<string | null>;
  // UpdateDeps: installGlobal?: (spec: string) => Promise<void>   (the spec is now the tarball's path)
  //             globalRoot?: () => Promise<string>                (default npmGlobalRoot)
  // test/helpers/global-stand-in.ts
  export function globalStandIn(root: string, installed: Record<string, string>):
    Pick<UpdateDeps, 'installGlobal' | 'globalRoot'>;   // unpacks the file into root/<name>, records its version
  ```
- The step's details are in fixed words, with no file names:
  - `the verified tarball of <pkg>@<v> could not be downloaded, so nothing was installed`;
  - `a file of it differs from its verified release`, `a file of its verified release is missing`, `it holds a file
    its verified release does not`, `it is a link, not the installed package`,
    `<nested>@<v> in it could not be verified as built by this repository's release workflow`.
  - The step says `${GLOBAL_MISMATCH(pkg)} (<which>): ${again}`.
  - `again` is `handoffSentence(planned.handoffs.core(['update']), (command) => \`run ${command} again\`, { instead:
    "run core's update again" })`.
- The preview's global sentence: `updates the global <pkg> from <a> to <b>: installs its verified tarball with \`npm
  install -g\`, then checks what npm installed against it`.
- The walk:
  - `lstat` throughout, never following a link. The top-level `node_modules/` is excluded from the extra-file check.
  - Every `node_modules/@agentcomms/*` below it, at any depth, is verified against the registry's integrity for its
    `package.json` version, reusing `Planned.verified` when it matches. Its verified tarball is downloaded, and its
    files compared in the same way.

- [ ] **Step 1: Write the failing tests, `update-global.test.ts`**
  - Real npm (`findNpmCli()`), a temporary `npm_config_prefix`/`cache`/`userconfig`, and `loopbackRegistry(world)`
    with Gmail depending on core at the same version, as `install-provenance.test.ts` does. All three platforms.
  - `a global update installs the verified tarball, not what npm would resolve by name`:
    - `toNpm` serves npm another Gmail tarball by name;
    - the installed `dist/cli.mjs` holds the verified marker;
    - the step is `updated`, and `record.current.global` includes `gmail`.
  - `the verified tarball is written to a private file, removed afterwards`: an `installGlobal` wrapper sees mode
    `0o600`, in a folder of `0o700`, and the folder is gone after the step. POSIX only: Windows has no POSIX modes.
  - `a changed byte, a missing file, or an extra file outside node_modules fails the step, and current.global stays`:
    - three cases, each a wrapper around real `npm install -g` that changes the tree after npm;
    - `outcome: 'failed'`, and the detail starts `the global @agentcomms/gmail does not match its verified release`;
    - `record.current.global` lacks `gmail`.
  - `a nested @agentcomms/core whose release does not verify fails the step`: `world.change({ '@agentcomms/core':
    'missing' })` after the plan.
  - `npm's own files inside node_modules are not refused`.
  - `a verified tarball that cannot be downloaded installs nothing`: both locations serve other bytes → `failed`, and
    the wrapper is never called.
  - `a global package that is a link is a mismatch, and the link is not followed` (Review Focus 3): replace the
    installed folder with a link (`'junction'` on Windows) to a copy holding the right files → `it is a link`.
- [ ] **Step 2: Update the stand-in sites** to `globalStandIn`. Change `update.test.ts`'s global preview line and its
  `deps.globals` assertion to the file-based spec and the new sentence.

- [ ] **Step 3: Run them, and see them fail**

  Run: `cd packages/core && node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --test test/update-global.test.ts`
  Expected: FAIL. npm installs by name, and the swapped tarball is what lands.

- [ ] **Step 4: Implement it**
  - In `applyUpdate`'s global loop:
    `installVerifiedGlobal({ packageName, version: global.latest, provenance: planned.verified.get(packageName) }, {
    install, root, registry, verify, tarballs }, again)`.
  - A global with no verified provenance fails its step with `${packageName}@${version} was not verified before the
    preview`.

- [ ] **Step 5: Run them, every update suite, and the wording golden**

  Run: `pnpm --filter @agentcomms/core test && pnpm --filter @agentcomms/core typecheck && node --import ./test/helpers/loopback-seal-preload.mjs --test test/printed-command-construction.test.mjs`
  Expected: PASS. The golden's diff touches only the global lines.

- [ ] **Step 6: Mutant, by hand.** Each one should turn its named test red:
  - install `pkg@version` by name;
  - skip the nested walk;
  - follow links with `stat`;
  - drop the extra-file check.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/core/src/global-install.ts packages/core/src/npm.ts packages/core/src/operations/update.ts \
    packages/core/test/update-global.test.ts packages/core/test/helpers/global-stand-in.ts packages/core/test/update.test.ts \
    packages/core/test/update-gate.test.ts packages/core/test/helpers/update-machine.ts packages/core/test/launcher-update.test.ts \
    packages/core/test/wording-identity.test.ts packages/core/test/fixtures/wording-0.6.0.json
  git commit -m "feat(core): a global package is installed from its verified tarball, and what npm installed is checked against it" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 10: The background run believes the verified tarball and Rekor's time (P1, P4)

**Files:**
- Modify: `packages/core/src/update-background.ts` (`BackgroundDeps`, `BackgroundRunResult.release`, `decide`).
- Test: `packages/core/test/update-background.test.ts`. Its `registry`, `attestations` and `makeRuntime` helpers move
  to `releaseWorld`, with `world.integrity(...)` in the lockfiles.

**Interfaces:**
- Consumes: `readVerifiedDeclaration`, `tarballLocation`, `DECLARATION_UNREAD` (Task 1); `VerifiedProvenance.signedAt`,
  `firstSeenTimes` (Task 2); `releasesBetween`, `releaseIntegrity`.
- Produces:
  ```ts
  BackgroundDeps.tarballs?: TarballFetch | undefined;
  BackgroundRunResult.release: {
    version: string;
    /** When the hold counts from: the latest Rekor time of the set, or this machine's first sight. */
    publishedAt: string | null;
    heldFrom: 'signed' | 'first-seen' | null;
    security: boolean; needsDecision: string | null; holdHours: number; installableAt: string | null;
  };
  ```
- `decide`'s order:
  1. Settings, launchers and `latest`, as today. The packument-based pause check before verification goes.
  2. Verify core's latest. A refusal is `refused`, as today.
  3. Read its declaration from the verified tarball (`writeCache: !dryRun`). If it is unknown and paused → `paused`.
     If it is unknown and not paused → `unavailable` with
     `${core}@${latest}: ${DECLARATION_UNREAD}; the next run tries again`, and no notice.
  4. Paused and not `security` → `paused`.
  5. Downgrade, then major, as today.
  6. Every release in range: verify it and read its declaration. Any unverified or unknown → `unavailable`, as in
     step 3, naming that version (gap 5). Any `needsDecision` → `skipped` with the decision notice.
  7. Rolled-back holds, as today.
  8. Every package's document, and missing ones → `held`, as today.
  9. Every package of the set verified now (the loop moves up from after the hold). A refusal is `refused`.
  10. The hold: each package's `provenance.signedAt`, or else `firstSeenTimes(stateDir, …, run.now, { record:
      !dryRun })`. `last = max`. `heldFrom` is `'first-seen'` if any time came from first sight. `age = clock() -
      last`. The registry's `time` is not read.

- [ ] **Step 1: Write the failing tests**, in `update-background.test.ts`, after moving its helpers to `releaseWorld`:
  - `a security fix is the tarball's word, never the registry's, both ways`:
    - `registrySays: { security: true }` with no flag in the tarball, signed 30 h ago → `held`, `holdHours: 72`;
    - the tarball's flag with `registrySays: {}` → installed after 24 h.
  - `a needed decision is the tarball's word, never the registry's, both ways`, for the latest and for a release in
    range.
  - `an unread declaration skips this run, says why, and the next run tries again`:
    - the tarball `serve: 'missing'` → `outcome: 'unavailable'`, and the reason includes `DECLARATION_UNREAD`;
    - `notice: null`, and the audit reason includes it too;
    - the next run with the tarball served installs.
  - `an unreadable declaration is never silent: the run is unavailable, and the job's run is not recorded` (Review
    Focus 1): with `AGENT_COMMS_LAUNCHER=core` (the job), `recordUpdateJobRun` is not called, so `lastRun` is
    unchanged.
  - `a release in range whose declaration cannot be read holds the run back, and is not refused` (gap 5).
  - `while paused, core is verified and its declaration read before a security fix passes the pause`:
    - `registrySays: { security: true }` and no tarball flag → `paused`, with attestations asked;
    - the tarball's flag → past the pause.
  - `a cached declaration is not downloaded by the next run`.
  - `the hold counts from each release's own signed time: a registry time set back by days changes nothing`:
    - `publishedAt: hoursAgo(500)` with `signedAt: hoursAgo(10)` → `held`, `heldFrom: 'signed'`;
    - `signedAt: hoursAgo(80)` with `publishedAt` now → installed.
  - `the set's hold counts from the latest signed time among its packages`: core signed 80 h ago and Gmail 10 h ago →
    `held`.
  - `no signed time — an inclusion proof alone, or two entries — holds from this machine's first sight, which a
    registry time cannot shorten`:
    - `shape.tlog: 'proof'` with `publishedAt: hoursAgo(1000)` → `held`, `heldFrom: 'first-seen'`, recorded;
    - with `now` 73 h later → installed;
    - the same for `'two'`.
  - `a promise that does not verify refuses the release, and installs nothing` (`'bad-promise'`).
  - `a dry run records no first sight, and writes no cached declaration`.
  - `every package of the set is verified before the hold is decided`: Gmail's attestation is missing and its release
    young → `refused`, not `held`.
  - Every existing background test keeps its meaning. The ones that read `publishedAt` as the registry's time now set
    `signedAt` instead.

- [ ] **Step 2: Run them, and see them fail**

  Run: `cd packages/core && node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --test test/update-background.test.ts`
  Expected: FAIL. The flags and the holds are still the packument's.

- [ ] **Step 3: Implement it**, in the order above.

- [ ] **Step 4: Run them, and every suite that starts a run**

  Run: `pnpm --filter @agentcomms/core test && pnpm --filter @agentcomms/core typecheck`
  Expected: PASS, `update-job*`, `launcher-update` and `update-levels` included.

- [ ] **Step 5: Mutant, by hand.** Each one should turn its named test red:
  - read `packument.time` for the hold;
  - read `agentcommsRelease` from the packument;
  - make an unknown declaration `held`;
  - record first sight with `clock()`;
  - put the package-verify loop back after the hold.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/core/src/update-background.ts packages/core/test/update-background.test.ts
  git commit -m "feat(core): a background update believes only what a verified release declares, and holds it from the time Rekor signed" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

## Wave 3

### Task 11: No escape hatch, one test for each install path (P5)

**Files:**
- Create: `packages/core/test/no-escape-hatch.test.ts`.

**Interfaces:**
- Consumes: `updateChange` (by hand: runtimes, pointers, registrations, globals), `runBackgroundUpdate`,
  `serverInstallChange` and `gatedChange`, `installVerifiedGlobal`, `releaseWorld`, `fixtureTarballs`.
- `environmentNames()`, local to the test, is every name in `packages/core/src/**/*.ts` matched by
  `/\benv(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g`. To these it adds the values of
  `UPDATE_CHECK_ENV`, `UPDATES_ENV`, `UPDATE_STARTED_BY_ENV` and `LAUNCHER_ENV`, and `NODE_TLS_REJECT_UNAUTHORIZED`,
  `npm_config_provenance`, `npm_config_ignore_scripts` and `SIGSTORE_NO_VERIFY`. It leaves out the harness's own
  folders: `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PATH`, `AGENT_COMMS_*_DIR` and `npm_config_registry`.

- [ ] **Step 1: Write the tests**. Each one fails if any installer is called or any pointer moves.
  - `no environment variable installs a release that fails verification, by any path`:
    - for each value of `['1', 'true', 'on', 'off', '0', 'skip']`, set every name to it;
    - then run each path against a release whose attestation is `'missing'`;
    - by hand: `plan` throws `BAD_DATA`. First install: the same. Background: `outcome: 'refused'`. Global: `failed`,
      with npm not run.
  - `no flag or request installs one`: `updateChange` with `noVerify: true`; a first install with `force: true` and
    `launcher: 'managed'`; a background run with and without `dryRun`.
  - `no approval installs one`:
    - prepare an approval while the release verifies;
    - switch it to `'missing'` with `world.change`;
    - the claim re-plans and refuses, for an update and for a first install.
  - `no registry input installs one`: a hostile packument (any `agentcommsRelease`, another `dist.integrity`, a
    `dist.tarball` elsewhere, a `time` years back) never makes a release that fails verification install.
  - `a global whose tarball is not the verified digest runs no npm`.

- [ ] **Step 2: Run them**

  Run: `cd packages/core && node --import ../../test/helpers/loopback-seal-preload.mjs --experimental-strip-types --test test/no-escape-hatch.test.ts`
  Expected: PASS. They pin behaviour Tasks 8–10 built.

- [ ] **Step 3: Mutant, by hand.** Each one should turn this file red:
  - make `verifyReleaseSet` return early when `process.env.AGENT_COMMS_UPDATES === 'off'`;
  - let `noVerify` skip `verifyReleases`.

- [ ] **Step 4: Commit**

  ```bash
  git add packages/core/test/no-escape-hatch.test.ts
  git commit -m "test(core): nothing installs a release whose provenance fails, whatever the input, flag, variable or approval" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

### Task 12: Integration — changelog, security, releasing, docs, verify

**Files:**
- Modify:
  - `CHANGELOG.md`: a new `## Unreleased` above `## 0.25.0`;
  - `SECURITY.md`;
  - `docs/RELEASING.md`;
  - `docs/upgrading.md`;
  - `docs/superpowers/specs/2026-10-19-desktop-app-design.md` (DA8's "An agent never runs these scripts");
  - `README.md:110-118`, if a sentence there is no longer true;
  - `skills/comms-update/SKILL.md`, and its references if they say how a global package is updated;
  - `.claude/skills/release/SKILL.md`;
  - `test/release-packages.test.mjs`: the RELEASING and release-skill pins.

- [ ] **Step 1: The changelog.** Write `## Unreleased` in the existing voice: a bold lead, then **What changes when
  you update:** bullets. Cover §6's five points:
  - flags come from the verified release itself;
  - a channel's check no longer hides a security fix (the check goes to core);
  - a global package is installed from its verified file and checked afterwards, with the new failure sentence;
  - holds count from Rekor's signed time, or first sight;
  - the desktop release runs with `--confirm`.

  Then **What doesn't change**, and the small fixes: R2's lock and record, R3's import reader. Name CUE-495. No line
  starts with `**Security fix.**` or `**Needs a decision before it installs.**`, since 0.26.0 declares neither flag.

- [ ] **Step 2: `SECURITY.md`**
  - Rewrite "What a release declares is the registry's word…" (G1): flags are believed only from the verified
    tarball, and what that cannot catch (a compromised release workflow, §2).
  - Rewrite the global sentence in "An update verifies this project's packages…" (G3): what is now checked, and what
    is not (non-`@agentcomms` dependencies).
  - Add P5: no override, code or flag; a broken release is replaced by a new verified one.
  - Add the hold's start: Rekor's signed time, or first sight.
  - Add that a channel's check hands itself to core.

- [ ] **Step 3: `docs/RELEASING.md`**
  - A section **Declaring a security fix or a needed decision**: the field and its two keys, the two changelog markers
    and the both-ways match, that leftover flags refuse the next release, and that 0.26.0 declares none.
  - In "The desktop app", replace "No agent runs these scripts" with: an agent may run them once the owner has said
    so, with `--confirm X.Y.Z` (and `--updater off` when the updater is off). The signing identity, notary profile and
    updater key stay on the signing Mac.
  - Add the headless form of step 6. Keep every `pnpm install` with `--filter '!@agentcomms/events-laya-runtime'`.
  - In the release skill, add one paragraph on the flags and their markers. Pin both docs in
    `test/release-packages.test.mjs`: the RELEASING section names `"agentcommsRelease": { "security": true` and both
    markers, and the skill names `**Security fix.**`.

- [ ] **Step 4: User docs**
  - `docs/upgrading.md`:
    - the security-fix and needs-a-decision paragraphs say the verified release declares them;
    - the hold says 72/24 hours from when Sigstore's transparency log recorded the release (or first sight);
    - the global step says it installs the verified tarball and checks it;
    - add the `recordNote` sentence.
  - `skills/comms-update/SKILL.md`: what to tell the person when a global step fails with the mismatch sentence (run
    the update again), and when the result carries `recordNote` (nothing to do). Then `pnpm sync:skills`.
  - `DA8`: the new rule, as RELEASING says it.

- [ ] **Step 5: Verify everything**

  Run: `pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime' && pnpm verify`
  Expected: PASS. Record the result for the PR. Then, at the root, `pnpm test` once more before pushing.

- [ ] **Step 6: The cloud dry run (the lead).**
  - Push `feat/0.26`, then `gh workflow run release.yml --ref feat/0.26 -f dry-run=true`.
  - It must show the six verify legs, `old-node`, `browser` and `laya` green. P3's real-npm test and R1's script tests
    run on every leg; R1 is skipped on Windows.
  - Before the tag, the lead may check, read-only, that every `@agentcomms/core` release from 0.20.0 to 0.25.0 has
    its SLSA attestation and a tarball whose declaration reads. Otherwise a machine whose launchers lag behind such a
    release would be `unavailable` until it passes it (gap 5).

- [ ] **Step 7: Commit**

  ```bash
  git add CHANGELOG.md SECURITY.md docs/RELEASING.md docs/upgrading.md docs/superpowers/specs/2026-10-19-desktop-app-design.md \
    README.md skills .claude/skills/release/SKILL.md test/release-packages.test.mjs
  git commit -m "docs: 0.26.0 — update provenance, hardened: what a release declares, globals, holds and the desktop release, said where people read" \
    -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

## Self-review (done while writing)

- **Spec coverage:**
  - G1/P1 → 1, 5, 8, 10;
  - G2/P2 → 4, 8;
  - G3/P3 → 9;
  - G4/P4 → 2, 10;
  - P5 → 11, 12;
  - R1 → 6, 12;
  - R2 → 3;
  - R3 → 7;
  - §4's lists → the tests named in each task;
  - §4's mutants → each task's mutant step;
  - §4's CI → 12, step 6;
  - §6 → 12, step 1;
  - §7.1 → 1 (gaps 1, 8); §7.2 → 2, 10 (gaps 2, 7); §7.3 → Global Constraints and 12.
- **Types used across tasks:**
  - `TarballFetch` is Task 1's everywhere.
  - `readVerifiedDeclaration(provenance, location, { stateDir, fetch, writeCache })` is used the same in 8 and 10.
  - `VerifiedProvenance.signedAt` is Task 2's, read in 10.
  - `firstSeenTimes` is Task 2's, read in 10.
  - `CoreHandOff` is Task 4's.
  - `DECLARATION_UNREAD` is Task 1's, read in 8 and 10.
  - `UPDATE_CHECK_LOCK` and `RECORD_DEFERRED` are Task 3's.
  - `GLOBAL_MISMATCH` and `installVerifiedGlobal` are Task 9's, read in 11.
- **Review Focus:** each of the five lines has its test in its owning task (1, 2, 4, 9, 10).
