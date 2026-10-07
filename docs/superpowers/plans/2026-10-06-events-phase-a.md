# Local event emission, phase A — `@agentcomms/events` implementation plan

Spec: [2026-10-05-local-event-emission-design.md](../specs/2026-10-05-local-event-emission-design.md), at `225d7855`,
which passed review round 22 (ready to plan) unchanged. Phase A is §4's row A (spec line 2821). The sections that
define it are §2, D1, D3, D5, D6, D14, the Phase A rows of §5 and Appendix A, which is normative. Read the channel-plugins
design ([2026-09-26-channel-plugins-design.md](../specs/2026-09-26-channel-plugins-design.md)) as well: §2 and §4
there are what the `agentcommsPackage` declaration has to stay consistent with.

This plan re-decides nothing the spec decides. Where the spec is silent or contradicts itself, the decision is made
once below and the tasks refer to it by number. Base: `feat/events-a` at `225d7855`, which is `main`. Target: no
release. Phase A merges to `main` with `@agentcomms/events` **held back from publication** (decision 1), so the next
`v*` tag publishes exactly the six packages it publishes today.

**If the spec changes later**, Task 10's extraction test fails on the first Appendix A constraint that moved, by
design: re-extract, re-transcribe and continue. A change to D5, D6 or D14 means re-reading the decisions below before
starting the task that implements that section.

**How to use this plan.** Each numbered task is one reviewable commit, or the short named series its heading gives.
Every task writes its tests first and watches them fail for the right reason, then writes the code. Every guard is
mutation-tested: break the guarded condition, watch the named test fail, restore it, and record the mutation and the
failing test in the commit body. Every task leaves the full `pnpm verify` green before its commit, and every batch
ends with the full `pnpm verify` run again on `feat/events-a` after its merges (AGENTS.md). From Task 3c on, every
task that adds or changes a vector family also runs `pnpm verify:browser` before its commit, and every batch ends with
it too (decision 3). It is not part of `pnpm verify`, because it needs Playwright's Chromium and WebKit on the
machine. No task pushes, tags or publishes; `feat/events-a` reaches `main` when the owner says so.

Test titles carry the label of the §5 row or plan obligation they cover (`CND-h: omitted caseSensitive …`), so the
ownership table at the end can be audited with
`grep -rhoE "\b(CAT|CND|MAP|TNT|PKG|REL|D14|A8|D3|D5|UNI|ISO|BRW|CJ)-[a-z0-9]+\b" test packages/events/test packages/events/scripts | sort -u`.

**Parallel work.** Batches run in order. Inside a batch, tracks marked parallel run in separate worktrees, each on
its own branch from the batch's starting point:

```bash
git worktree add ../.agentcomms-wt/events-a-<track> -b feat/events-a-<track> feat/events-a
# … the track's tasks, each a commit …
git -C ../.agentcomms-wt/events-a merge --no-ff feat/events-a-<track>   # from the events-a worktree, track by track
```

Parallel tasks touch the same few files only in append-only places: one `export * from` line each in
`packages/events/src/index.ts`, one line each in `packages/events/test/realm/runners/index.ts`, and one delimited block
each at the end of `packages/events/test/consumer-check.mjs`. Resolve those conflicts by keeping both sides.

| Batch | Tasks | Parallel tracks |
|---|---|---|
| 1 — release safety | 1 → 2 | none |
| 2 — the package | 3a → 3b → 3c | none |
| 3 — foundations | U: 4 → 5 → 6 → 7; S: 8 → 9; T: 10 | U, S and T in three worktrees |
| 4 — the catalogue | 11 | none |
| 5 — conditions, mapping, wire | C: 12; M: 13 → 14 | C and M in two worktrees |
| 6 — integration | 15 | none |

**AGENTS.md, as it applies here.**

- **Phase A makes no provider request of any kind.** Nothing in it talks to Gmail, Slack, Resend or WhatsApp; no
  fake transport is needed because no task reaches a transport. The only network access in the whole phase is
  Task 4's one-time `--fetch` of the pinned Unicode files from unicode.org, run by hand, and Playwright's one-time
  download of Chromium and WebKit (Task 3c). No test fetches anything: `pnpm verify:browser` serves its page from a
  loopback listener and the page's CSP allows nothing else.
- **Fixtures are synthetic.** Addresses use `example.com`, `example.org` or `*.test`; Slack ids are obviously fake
  (`T00000000`, `C00000000`, `U00000000`); WhatsApp numbers are in the UK's drama range (`447700900000`–`447700900999`).
  No vector file has a key named `token`, `secret`, `password` or `api_key` with an eight-character value, because
  `scripts/verify-skills.mjs:54-74` scans every `.json` and `.ts` file for those shapes.
- **No secret exists in this phase.** Nothing reads, stores or prints one.
- **Sender-controlled prose stays enveloped.** The library never builds an envelope itself (decision 18): it reports
  which output pointers are untrusted, and the daemon (phase B1) applies core's `wrapUntrusted`.
- **CLI–MCP parity.** `@agentcomms/events` is a library: no command, no tool, no `capabilities.json` row. Task 2 makes
  the parity test say so.

**The risky tasks are marked Risky.** Tasks 1 and 2 change what a `v*` tag publishes and which checks see which
package: review every list a release step reads. Task 3c adds a job the release's publish depends on. Task 3b defines
event identity. Task 4 carries a licence obligation. Task 6 decides what `domainIs`
matches, which is a disclosure filter. Tasks 11, 13 and 14 define the normative contract, what is marked untrusted and
the exact bytes a target receives.

## Decisions the spec leaves to the plan

The four the coordinator asked for come first. The rest fill gaps or resolve contradictions the tasks would otherwise
each resolve differently; the ambiguous spec lines are named in each.

### 1. Release safety: `@agentcomms/events` merges held back, and its first publish waits for its first consumer

**The problem.** The release test enumerates every non-private `packages/*/package.json` and fails any that the shared
list omits (`test/release-packages.test.mjs:48-77`). Phase A must therefore put `events` in the list, and every
`v*` tag after that would try to publish it. A package's first version cannot come from the workflow: npm cannot hold
a trusted publisher for a package that does not exist, so the OIDC preflight stops the run, prints the hand publish and
sends nothing (`scripts/release-ci.mjs:129-206`, `docs/RELEASING.md:62-103`). The next tag after Phase A — possibly an
unrelated patch, possibly cut between two Phase A merges with half a catalogue — would stop and ask the owner for an
OTP to publish a library nothing yet uses, as a public 0.x API.

**The decision.** A package can say it is held back: `"agentcommsRelease": { "hold": "<why, one sentence>" }` in its
own `package.json`. The registry reads it in the same package walk as the declarations (Task 1). `scripts/packages.mjs`
then exports three things:

- `PUBLISHABLE` — every package the registry publishes (the channels, the server-only wrapper a channel names, and
  the declared libraries), in publish order.
  It is what is built, version-synced, licence-checked and consumer-checked. `scripts/sync-versions.mjs`,
  `scripts/verify-package.mjs --all` and `scripts/third-party-licenses.mjs` walk it (Task 2).
- `HELD` — the held packages and why.
- `PACKAGES` — `PUBLISHABLE` less `HELD`, in the same order: what a tag publishes. `node scripts/packages.mjs` prints
  it, so the workflow's confirm loop, `scripts/release.mjs` and `scripts/release-ci.mjs` (`pending`, `preflight`) keep
  reading exactly what they read today, **with no change to their code**. The irreversible path is untouched.

**Why not publish at once:** the reasons above. **Why not `"private": true`:** D14 says neither package is staged as
private (line 2749), and a private package escapes the release enumeration, `verify:packages`, the version sync and
the licence notices — the very checks that prove it is publishable. A held package passes every one of them on every
`pnpm verify`. **Why in the package's own `package.json` and not a list in a script:** the registry derives everything
else from manifests, a fixture tree can declare a held package without editing a script, and lifting the hold is a
one-line deletion in a file the package already owns. D14's declaration stays byte-for-byte `{ "kind": "library" }`.

**What the tests prove** (Tasks 1 and 2): a held fixture library in a copy of the repository is absent from
`node scripts/packages.mjs`, and `release-ci.mjs pending` and `preflight`, run against the fake registry, never read
its packument or exchange a token for it; the same library is still version-synced by `sync-versions.mjs`, and
`verify-package.mjs --all`, the licence script and the parity test walk it; no package in `PACKAGES` may depend at
runtime (`dependencies`, `optionalDependencies`, `peerDependencies`) on a held one; core can never be held; a hold on
a private or undeclared package is refused.

**What the owner does, and when.**

- **At merge: nothing.** Every release until the hold is lifted publishes the same six packages, and
  `node scripts/packages.mjs` still prints `core gmail gmail-mcp resend slack whatsapp`.
- **When: in the version commit of the first release that ships a package depending on `@agentcomms/events` at
  runtime** — phase B1's daemon pins it exactly — or earlier, if the owner decides to publish the library on its
  own.
  The "no released package depends on a held one" test makes the daemon's release fail `pnpm verify` until the hold
  is lifted, so it cannot be forgotten.
- **How:**
  1. In that release's version commit, delete `agentcommsRelease` from `packages/events/package.json` and say in the
     changelog entry what the library is.
  2. Tag and push as usual. After every verify leg passes, the OIDC preflight stops with
     `✗ @agentcomms/events: never published`, prints the hand-publish command for the tagged commit and sends nothing.
  3. The owner runs that command in a terminal, in a checkout of the tag after
     `pnpm install --frozen-lockfile && pnpm build` (npm asks for a one-time password to create a package):
     `pnpm --config.pnpmfile=scripts/record-git-head.cjs --filter @agentcomms/events publish --access public --no-git-checks --tag latest`.
  4. The owner adds the package's trusted publisher on npmjs.com → `@agentcomms/events` → Settings → Trusted
     publishing: repository `crissmoldovan/agent-communications`, workflow `release.yml`, environment `release`.
  5. Re-run the failed job. It finds `events` at that version from the tagged commit, skips it, publishes the rest,
     confirms all of them and makes the release page.

  Steps 3 and 4 need the owner's npm account; no agent can do them. `events` depends on no other package of this
  suite, so its hand publish never waits for core.

### 2. Unicode 15.1 data: vendored, pinned by SHA-256, generated into the package, and regenerated by every verify

**Source.** The Unicode Consortium's own files at version 15.1.0, from `https://www.unicode.org/Public/15.1.0/ucd/`
and `https://www.unicode.org/Public/idna/15.1.0/`. They were downloaded and hashed while writing this plan
(2026-10-06); Task 4 downloads them again and must get the same bytes, or stops and reports.

| File | Path under `unicode.org/Public/` | Bytes | SHA-256 of the file as published | Used for |
|---|---|---:|---|---|
| `CaseFolding.txt` | `15.1.0/ucd/` | 84 870 | `4e55acfdc32825a22e87670e9056a3bf94ad7c5400065778e9e10f8314372bcf` | full case folding (C and F, never T) |
| `UnicodeData.txt` | `15.1.0/ucd/` | 1 914 200 | `2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86` | canonical decompositions, combining classes, General_Category Mark, Virama (ccc 9), Bidi_Class |
| `CompositionExclusions.txt` | `15.1.0/ucd/` | 8 888 | `59d2d9e3dfdf0a999cf9dae11d594f053631222679a2f5710315ea07f7fe82af` | NFC composition exclusions |
| `DerivedJoiningType.txt` | `15.1.0/ucd/extracted/` | 39 057 | `2e0ed3733272299007cf0b76e84a8a653192d99a4429d2232fffcabccfd2d462` | UTS #46 CheckJoiners (RFC 5892 ContextJ) |
| `IdnaMappingTable.txt` | `idna/15.1.0/` | 874 566 | `402cbd285f1f952fcd0834b63541d54f69d3d8f1b8f8599bf71a1a14935f82c4` | UTS #46 revision 31 mapping and status |
| `NormalizationTest.txt` | `15.1.0/ucd/` | 2 625 136 | `871238e37e3be0696ec2bd0891119a041b052da1a84485eda05a5438724b223e` | tests only |
| `IdnaTestV2.txt` | `idna/15.1.0/` | 749 716 | `d668c4ea58d60fe04e6c011df98e0b317da6abaa1273d58f42b581eb0dd7adda` | tests only |
| `license.txt` (vendored as `LICENSE`) | `https://www.unicode.org/license.txt` | 1 995 | `e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96` | the notice |

**NFC is bundled too.** D5 bundles case folding and UTS #46 but says only "applies NFC" (line 1032), and UTS #46's
own step 2 normalises to NFC. `String.prototype.normalize` follows the host's ICU: this machine's Node reports
Unicode 17.0, and a webview has its own. A host NFC would make Node and the app disagree on any character assigned
after 15.1, which is exactly what pinning prevents (§2, line 90). So NFC comes from the same 15.1 files and is held to
`NormalizationTest.txt`.

**Licence and notice.** The data files are under the Unicode License v3 (SPDX `Unicode-3.0`); their headers point to
`https://www.unicode.org/terms_of_use.html`, and `license.txt` is that licence's text. It permits use, modification and
redistribution provided "this copyright and permission notice appear with all copies of the Data Files or Software".
Two copies therefore carry it:

- **In the repository**, `packages/events/vendor/unicode-15.1.0/LICENSE` sits beside the vendored sources, with
  `NOTICE.json` (`{ "name": "unicode-character-database", "version": "15.1.0", "license": "Unicode-3.0", "homepage":
  "https://www.unicode.org/" }`).
- **In the npm tarball**, `THIRD_PARTY_LICENSES` carries `unicode-character-database@15.1.0 — Unicode-3.0` with the
  full text. It is not written by hand: `scripts/third-party-licenses.mjs` learns a fourth owner kind, **vendored**
  (any module under `packages/<package>/vendor/<id>/`, named by that directory's `NOTICE.json` and licensed by its
  `LICENSE`), so the notice is present exactly when the bundler put the generated tables into the build — the same
  rule the script already applies to `node_modules` (Task 4).

**Generation.** `packages/events/scripts/unicode.mjs`, a Node script that is not part of the published package:

- `pnpm sync:unicode` reads the vendored sources, checks each one's byte size and SHA-256 against
  `vendor/unicode-15.1.0/SOURCES.json` (URL, bytes, SHA-256 per file), refuses on any mismatch, and writes
  `vendor/unicode-15.1.0/generated/*.ts`.
- `pnpm verify:unicode` (`--check`) regenerates in memory, compares every generated file byte for byte, and fails on a
  changed source, a changed table, or a missing or extra file. It joins `pnpm verify` right after
  `pnpm verify:channels`, following the arrangement the channel snapshot and the reference pages already use.
- `--fetch` downloads every pinned URL, verifies it against `SOURCES.json` and only then writes it. It is run by hand
  once, in Task 4, and never by a test.

**Committed output.** The sources are committed gzip-compressed, as `sources/<name>.txt.gz`: about 945 KB instead of
6.3 MB, while the pin is on the decompressed bytes, which are exactly unicode.org's. A reviewer re-checks them with
`--fetch` or by downloading and hashing. The generated tables are committed TypeScript modules holding **integer
arrays only** — never base64 or other packed strings, which are unreadable and could trip the secret scanner's
token patterns. They are decoded lazily on first use, so importing the package does no work (`sideEffects: false`).
Each starts with a header naming the generator, the Unicode version and every source's SHA-256, and "Do not edit; run
`pnpm sync:unicode`". Biome does not format them (`biome.json` excludes `packages/events/vendor/*/generated`); their
correctness is the generator check's job, and the isomorphism guard (decision 3) still parses them.

**What proves the tables match the pinned source.** Three things, at different depths:

1. `pnpm verify:unicode`: the committed tables are byte-identical to what the generator makes from sources whose bytes
   match the pins.
2. A generator unit test on small synthetic UCD fragments, with hand-computed expected tables, so a generator bug
   cannot hide by being reproduced in both generation and check.
3. Conformance against Unicode's own test files, in Node, in the bare realm and in Chromium and WebKit (decision 3):
   every line of `NormalizationTest.txt` (its NFC invariants, and identity for every assigned code point not in
   Part 1), every line of `IdnaTestV2.txt` (the `toAsciiN` value and status set), and every `C` and `F` line of
   `CaseFolding.txt`. A
   host-divergence vector proves no host conversion is used: U+A7CB, assigned in Unicode 16, folds to itself under
   15.1, while this machine's `"\uA7CB".toLowerCase()` gives U+0264.

### 3. "Isomorphic, no I/O and no `node:` imports": five layers, ending in real Chromium and WebKit

**Enforcement**, each layer catching what the one before cannot:

1. **The compiler.** `packages/events/tsconfig.json` compiles `src/` and the generated tables with `"types": []` and
   `"lib": ["ES2023"]`: no Node types, no DOM types. `process`, `Buffer`, `require`, `fetch`, `URL`, `TextEncoder`
   and `console` do not exist there, and an import of `node:fs` does not resolve. Tests have their own
   `test/tsconfig.json` with Node types. A test asserts the source tsconfig keeps exactly those two settings.
2. **A syntax-tree guard** (`packages/events/test/isomorphic.test.ts`), using the same TypeScript 7 API
   `test/helpers/printed-command-guard.mjs` uses (`typescript/unstable/ast`, `/sync`, `/fs`, a virtual tree,
   `allowJs` for `.mjs`). It parses `src/**/*.ts`, `vendor/*/generated/*.ts`, `dist/**/*.mjs` and `dist/**/*.d.mts`,
   and refuses:
   - any import, export-from, dynamic `import()` or `require()` whose specifier is neither relative nor `zod`;
   - `import.meta`;
   - identifiers in expression position named `process`, `Buffer`, `global`, `globalThis`, `require`, `module`,
     `exports`, `__dirname`, `__filename`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `fetch`,
     `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`, `window`, `document`, `self`, `crypto`,
     `performance`, `console`, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `structuredClone`, `atob`,
     `btoa`, `Intl`, `WebAssembly`, `SharedArrayBuffer`, `Atomics`, `eval`, `Function` and `Date` (instants are parsed
     exactly, never through `Date`; decision 14);
   - the host-Unicode and nondeterministic members `toLowerCase`, `toUpperCase`, `toLocaleLowerCase`,
     `toLocaleUpperCase`, `toLocaleString`, `localeCompare`, `normalize` and `Math.random`;
   - a regular expression with the `i` flag or a `\p{`/`\P{` property escape, and `new RegExp` with a non-literal
     argument — all of these depend on the engine's Unicode version or case tables;
   - `/// <reference types="node" />` or an `import("node:…")` type in the declarations, so a browser project needs no
     `@types/node` to use it.

   There is one exemption: `src/identity/sha256.ts` may reach exactly `globalThis.crypto.subtle.digest`, the WebCrypto
   SHA-256 that Node 22 and every browser's secure context provide (decision 23). The same chain anywhere else, and any
   other use of `globalThis` or `crypto` in that file, are still refused. Fixtures under
   `packages/events/test/fixtures/isomorphic/` hold one refused and one accepted example per rule, the exemption
   included.
3. **A bare ECMAScript realm.** The shared conformance vectors run twice: in Node against `src/`, and in a `node:vm`
   context created with no globals but ECMAScript's own and with
   `codeGeneration: { strings: false, wasm: false }`. Into it goes a browser-platform IIFE bundle of the library,
   zod included, built in memory by tsdown's `build({ write: false })` — the way `scripts/third-party-licenses.mjs`
   builds its graphs — from `test/realm/entry.ts`. The realm has ECMAScript's built-ins (including `Intl`, which the
   guard keeps the source from using) and nothing of Node's or the web's: no `process`, `require`, `Buffer`, timers,
   `fetch`, `URL`, `TextEncoder` or `console`. It is given exactly one host capability: a `crypto` whose only member
   is `subtle.digest`, bound to Node's WebCrypto, so the event-identity family runs there too. Both runs must return
   byte-identical results and no failures.
4. **Real Chromium and WebKit.** `pnpm verify:browser` (Task 3c) drives the same vector files, through the same
   runners, in Playwright's Chromium and WebKit:
   - WebKit is JavaScriptCore, the engine of the macOS webview (WKWebView) the desktop app will use, and of WebKitGTK;
     Chromium is the engine of Windows' WebView2.
   - The page is served from a loopback listener with D13's exact production CSP (`default-src 'self'; script-src
     'self'; … connect-src ipc: http://ipc.localhost; …`, spec line 2631), and loads the browser-platform IIFE
     bundle as a same-origin script. So the run also proves the library works where `eval` is refused and nothing can
     be fetched.
   - `http://127.0.0.1` is a secure context, so `crypto.subtle` is there, as it is in the app's own origin.
   - Every family must return zero failures, with results byte-identical to Node's and the realm's.
5. **The consumer check**, in the installed tarball, imports the package and scans every `dist` file for `node:`
   specifiers and `require(`.

**Where each layer runs.**

- **Layers 1, 2, 3 and 5** run in every `pnpm verify`, locally and on all six release legs.
- **Layer 4** needs a few hundred MB of browsers, so it stays out of the `pnpm verify` every developer runs before
  every push. It is `pnpm verify:browser`.
  - **In the release workflow**, a job named `browser`, on `macos-latest`, installs only Chromium and WebKit and runs
    it. The `publish` job needs it as it needs `old-node`, and Task 3c's release test holds the workflow to that shape.
  - **Locally**, without the browsers, `pnpm verify:browser` stops with one message: install them once with
    `pnpm --filter @agentcomms/events exec playwright install chromium webkit` (adding `--with-deps` on Linux), then
    run it again; `pnpm verify` does not run it.
  - Every phase A task that adds or changes a vector family runs it before its commit, and every batch ends with it,
    so the held package never reaches B1's release without a browser run.
- **Phase C** can still run the same vector files in the app's own webviews. It is no longer the first browser run.

**Why both a realm and browsers.** The bare realm is the fast layer every push gets. It needs nothing, is
deterministic on Linux, macOS and Windows, and is stricter than a browser: it has no Web APIs at all, and its
`codeGeneration` setting reproduces the app's CSP, which has no `'unsafe-eval'` (D13), so it proves zod's eval-free
path. What it cannot see is a difference between JavaScript engines, and §4 row A and §5 ("in Node and a browser",
line 2857) require that the vectors run in one. The browsers are what see it.

jsdom or happy-dom would prove neither, because they run inside Node, with `process` and `require` still present.
Firefox is not installed: no webview the app targets uses its engine.

### 4. The package: build, exports, typed API surface and its declaration

**Declaration.** `"agentcommsPackage": { "kind": "library" }`, exactly D14's (line 2692), beside
`"agentcommsRelease": { "hold": … }` (decision 1). It has no `"agentcomms"` field, which still means a channel only
(channel-plugins design §2; D14 line 2688). It has no `bin`, no `src/cli.ts`, no `src/mcp/` and no
`capabilities.json` row.

**Manifest.** `name` `@agentcomms/events`, the suite's version (lockstep, synced), `"type": "module"`, MIT,
`"engines": { "node": ">=22.12.0" }` like core, `"sideEffects": false`, `repository.directory` `packages/events`,
`publishConfig.access: public`, `files: ["dist", "README.md", "LICENSE", "THIRD_PARTY_LICENSES"]`.
`dependencies: { "zod": "catalog:" }` — external, not inlined, because `EventDefinition.schema` is a `z.ZodType`
(D3) and a consumer must share one zod with it. `devDependencies`: `ajv` (exact, Task 8), `playwright` (exact,
Task 3c; its browsers are never installed by `pnpm install`, and `allowBuilds` stays empty), and `tsdown` and
`typescript` (`catalog:`), so the tests do not rely on hoisting.

**Build.** `tsdown.config.ts`: `entry: { index: 'src/index.ts' }`, `format: 'esm'`, `platform: 'neutral'` (no Node
resolution or shims), `target: 'es2023'`, `dts: true`, `clean: true`, no `noExternal`. One output,
`dist/index.mjs` with `dist/index.d.mts`, used by Node and by browser bundlers alike. The browser bundle exists only for
the realm and `pnpm verify:browser` (decision 3), built in memory and never published, so `THIRD_PARTY_LICENSES` lists
only what the published build inlines: the Unicode tables.

**Exports.** `".": { "types": "./dist/index.d.mts", "import": "./dist/index.mjs" }`, as core does, plus `main` and
`types`. One barrel; internal modules are not reachable. Task 15 freezes the export list in `test/api-surface.json`.

**Typed API surface.** Validators return `Result<T> = { ok: true; value: T } | { ok: false; issues: readonly Issue[] }`,
`Issue = { code: IssueCode; pointer?: string; message: string; detail?: readonly string[] }` with a closed `IssueCode`
union. Evaluators take values that already validated and throw `EventsError` only on misuse. The library never imports
core (core's envelope and digest import `node:crypto`, §2 line 61); the daemon maps issue codes to `CommsError`, and
`EVENT_TYPE_NOT_SELECTABLE` is spelled exactly as D10 spells it.

| Area | Exports |
|---|---|
| JSON and text | `JsonValue`, `JsonObject`, `isJsonValue`, `canonicalJson`, `compareUtf8`, `utf8Encode`, `utf8ByteLength`, `codePointLength`, `isWellFormed`, `percentEncodeComponent` |
| Errors | `Result`, `Issue`, `IssueCode`, `EventsError` |
| Event identity | `EventIdentityInput`, `eventIdPreimage`, `eventId`, `EventIdentity`, `compareEventIdentities` |
| Unicode | `UNICODE_VERSION` (`'15.1.0'`), `nfc`, `caseFold`, `foldForComparison` |
| Domains and formats | `toAsciiDomain`, `canonicalEmail`, `SemanticFormat`, `isFormat`, `isInstant`, `compareInstants` |
| Pointers | `parsePointer`, `formatPointer`, `getPointer`, `relatePointers`, `PointerPattern`, `PointerPatternToken`, `expandPattern`, `matchesPattern` |
| Catalogue | the seven event interfaces and their shared types (`AddressV1`, `RiskFlagV1`, `ResendStatusV1`, `WhatsAppMessageKindV1`, …), `CatalogueEventV1`, `EventTypeV1`, `EventDefinition`, `AnyEventDefinition`, the seven definitions (`gmailMessageReceivedV1` … `whatsappMessageReceivedV1`), `CATALOGUE`, `catalogueEntry`, `validateEvent`, `sourceSchema`, `checkDefinition`, `describeFields`, `FieldInfo`, `whatsappMessageKey`, `canonicalRiskFlags`, `normaliseResendBody`, `RESEND_BODY_MAX_CODE_POINTS` |
| Conditions | `Scalar`, `CanonicalCondition`, `AuthoringCondition`, `canonicaliseCondition`, `evaluateCondition`, `describeCondition`, `conditionPointers`, `CONDITION_LIMITS`, `AgenticConditionV1`, `canonicaliseAgenticCondition` |
| Mapping | `MappingTemplate`, `MissingPolicy`, `CompiledMapping`, `MappedValue`, `Provenance`, `compileMapping`, `evaluateMapping`, `classifyMapped`, `Representation`, `applyRepresentation`, `checkMappedSize`, `MAPPING_LIMITS`, `deliverySchema`, `deliverySchemaId`, `JsonSchema` |
| Wire | `CloudEventV1`, `CLOUDEVENTS_CONTENT_TYPE`, `buildCloudEvent`, `cloudEventBytes`, `defaultCloudEventType`, `validateCloudEventType`, `encodeUntrustedExtension`, `TEST_CLOUD_EVENT`, `TEST_CLOUD_EVENT_BYTES`, `JUDGE_TEST_INPUT` |

### 5. One schema description per event, compiled to Zod and to JSON Schema

D3 wants Zod schemas and generated JSON Schema; §5 wants the JSON Schema byte-equal to a transcription of Appendix A.
Zod's own `toJSONSchema` cannot be that source. Its output shape is zod's to change (the catalog pins `^4.6.5`, so a
minor bump could break the byte comparison for no reason of ours). It writes `type: "integer"` where A.1 requires
`number` with `multipleOf: 1`. Zod's string `max` counts UTF-16 code units, where A.1 counts code points. And pointer
validation, operator legality and delivery-schema generation all need to ask "what is at this pointer", which zod
answers poorly. So each event is described once in a small internal schema description
(`packages/events/src/schema/`), and three things are compiled from it: the Zod schema, the JSON Schema, and the
type-at-pointer resolver. `ajv` (2020-12 draft) is a test-only oracle: everything zod accepts or refuses, ajv must
too, except the named invariants of decision 7.

### 6. Appendix A's notation, as exact JSON Schema

A.1 (lines 3511-3525) maps the notation "mechanically" to JSON Schema but leaves the exact shape open, and §5 compares
bytes. Task 10 transcribes and Task 11 generates by these rules, and no others:

- **Root:** `{ "$schema": "https://json-schema.org/draft/2020-12/schema", "$id":
  "urn:agentcomms:schema:source:<type>:v1", "type": "object", "properties", "required", "additionalProperties":
  false }`, with the common fields and the body flattened into it, plus A.5's `dependentRequired`.
- **Object:** `{ "type": "object", "properties", "required", "additionalProperties": false }`. `required` lists
  every non-`?` property, sorted by raw UTF-8 bytes, and is present even when empty.
- **Strings:** `{ "type": "string" }`; `NonEmptyString` adds `"minLength": 1`; a pattern type adds `"pattern"`; a
  format adds `"format"` (`date-time`, `email`, `uuid`, `uri`, or the custom `domain`); A.5's body adds
  `"maxLength": 20000`. All lengths count code points.
- **`integer(minimum: 0)`:** `{ "type": "number", "multipleOf": 1, "minimum": 0 }`.
- **Booleans:** `{ "type": "boolean" }`.
- **Literals** — `type`, `version`, `account.channel`, `fromMe`: `{ "const": <value> }`, with no `type` keyword.
- **Enums:** `{ "type": "string", "enum": [ … ] }`, in Appendix A's order.
- **`T | null`:** `{ "anyOf": [ <T>, { "type": "null" } ] }`, for scalars and objects alike.
- **Arrays:** `{ "type": "array", "items": <T> }`, plus `"uniqueItems": true` where Appendix A says duplicate-free.
  Slack `mentions` is duplicate-free because A.4 removes exact duplicate tuples.
- **`WhatsAppMessageKindV1`:** `{ "anyOf": [ { "type": "string", "enum": [ the 19 ] }, { "type": "string",
  "pattern": "^unknown:[0-9]+$" } ] }`, for both `kind` and `media.type`.
- **No `$defs`, `$ref`, `title` or `description`.** Every node is inline, so the comparison is literal.

### 7. What JSON Schema cannot say is a named invariant, enforced by `validateEvent`

Appendix A states rules no 2020-12 keyword expresses: canonical sort order, same instant, identity, at least one
non-empty, disjointness, a length equal to a count, inequality. Each becomes a **named invariant** in the definition
and in the transcription fixture, enforced by `validateEvent` after zod and refused by ajv's oracle only where a
keyword exists. Each invariant is tied to the spec sentence or comment that states it, quoted verbatim, by Task 10's
prose-rule file. No invariant exists without a quote, and no constraint-bearing sentence goes unaccounted for. The
closed vocabulary:

| Rule | Meaning |
|---|---|
| `sorted-utf8` (pattern) | the array at the pattern is sorted by raw UTF-8 bytes; duplicates are `uniqueItems`' job |
| `same-instant` (two pointers) | both RFC 3339 values denote the same instant (decision 14) |
| `identical` (two pointers) | the two JSON values are equal |
| `slack-ts-instant` (`/ts`, `/occurredAt`) | the decimal Slack timestamp denotes exactly that instant (A.1, line 3573) |
| `non-empty-either` (two pointers) | at least one of the two arrays is non-empty |
| `disjoint` (two pointers) | no value occurs in both arrays |
| `length-equals` (array, count) | when the array is present, its length equals the count |
| `differs` (two pointers) | the two values are not equal |

Per type: Gmail received and sent — `sorted-utf8` on `labels`, `attachments.*.riskFlags` and
`warnings.replyToDomains`, and `same-instant` on `/date` and `/occurredAt`. Gmail labelled — `sorted-utf8` on `added`
and `removed`, `non-empty-either`, `disjoint`, and `identical` on `/occurredAt` and `/observedAt`. Slack —
`slack-ts-instant`. Resend received — `sorted-utf8` on `attachments.*.riskFlags`, `same-instant` on `/receivedAt` and
`/occurredAt`, and `length-equals` on `/attachments` and `/attachmentCount`. Resend status — `differs` on `/previous`
and `/current`, and `identical` on `/at` and `/occurredAt` and on `/occurredAt` and `/observedAt`. WhatsApp —
`same-instant` on `/at` and `/occurredAt`, and `identical` on `/workspaceId` and `/account/id`.

### 8. Unpaired surrogates are refused only where Appendix A says so

A.5 forbids an unpaired surrogate in the Resend body (lines 3828-3831), and that is the only place the catalogue
refuses one. A library-wide rule would be a contract Appendix A does not state, so it is raised with the owner instead
(see "Spec amendments to raise with the owner").

Event identity does not need it. Canonical JSON writes an unpaired surrogate as an escape sequence (`JSON.stringify`'s
well-formed output), so the bytes an event id hashes are always well-formed UTF-8 (decision 23).
`percentEncodeComponent` does refuse one, because RFC 3986 encodes UTF-8 bytes and an unpaired surrogate has none. That
is an encoding impossibility rather than a contract rule, and it reaches only a component the library is asked to
encode.

### 9. `dedupeKey` takes the staging identity Appendix A needs

D3's interface is `dedupeKey(event: T)` (line 556), but A.2 and A.3 build Gmail keys from `historyRecordId`, which is
"source-staging identity and is deliberately not a disclosed field" (lines 3674-3676, 3699-3700) — it is not in `T`.
So `EventDefinition<T, S>` has `dedupeKey(event: T, staging: S): string`, where `S` is `{ historyRecordId: string }`
(an unsigned decimal) for the three Gmail types and `Record<string, never>` for the rest. `subject(event: T)` keeps
D3's signature.

### 10. `uuid` is a semantic format

D3's union is `'email' | 'domain' | 'date-time' | 'uri'` (line 553), while A.1 names `uuid` (line 3518) and A.5 and A.6
declare it (lines 3853, 3906). Appendix A is normative, so `SemanticFormat` includes `'uuid'`. Like `uri`, it carries no
domain or date semantics in conditions.

### 11. Canonical JSON is the library's own, byte-identical to core's

The library cannot import core. `canonicalJson` reimplements `packages/core/src/digest.ts:117-127` exactly: object
keys sorted by **UTF-16 code-unit** order (`a < b`), `undefined` members dropped, scalars through `JSON.stringify`. It
refuses non-JSON input (`undefined` in an array, a non-finite number, a non-plain object), where core would emit
something. A root test compares it with core's own `canonicalJson`, over the vector file, through both built dists.
Arrays Appendix A or D6 call "sorted by raw UTF-8 bytes" — labels, risk flags, `agentcommsuntrusted` — use
`compareUtf8` (code-point order, which is UTF-8 byte order). The two orders differ only between a BMP character at
U+E000 or above and an astral one, and a vector pins that case.

### 12. A canonical email keeps its local part and lower-cases its domain

A.1 says "canonical address, lower-case IDNA-ASCII domain" (line 3541) and does not define "canonical address". Core's
`normaliseAddress` lower-cases the whole address, but A.1 names only the domain, and "values as they are" (D6) argues
for keeping the local part. The format accepts `local@domain` where the local part is an RFC 5321 Dot-string or
Quoted-string in ASCII, kept exactly as given, and the domain is the UTS #46 ToASCII result of itself (decision 13).
Address literals (`[192.0.2.1]`) and non-ASCII local parts are refused. `canonicalEmail` maps a raw address to that
form for phase D's adapters. See ambiguity E.

### 13. A canonical domain has no trailing root dot

`toAsciiDomain` runs UTS #46 revision 31 exactly as D5 specifies: non-transitional, `UseSTD3ASCIIRules`,
`CheckHyphens`, `CheckBidi`, `CheckJoiners` and `VerifyDnsLength`, all true. It then refuses an input ending in `.`
(the root label), so `example.com.` is not a second spelling of `example.com`. The `domain` format accepts a string
exactly when `toAsciiDomain` accepts it and returns it unchanged.

### 14. Instants are compared exactly, without `Date`

`date-time` is RFC 3339 `date-time` as JSON Schema 2020-12 reads it: `T` and `Z` in either case, an offset required,
any number of fraction digits, real calendar days, and a leap second only at 23:59:60 UTC-equivalent.
`compareInstants` normalises to UTC and compares days, seconds and fraction digits exactly, so a Slack `ts` with six
fraction digits keeps its microseconds. A leap second sorts after 23:59:59.999… and before the next midnight.

### 15. Condition details D5 leaves open (lines 1003-1044)

- **`Scalar`** is `string | number | boolean | null`. `null` is a legal operand of `equals`, `notEquals` and `in`
  only where the field admits null.
- **An operand must validate against the field's own schema node** for `equals`, `notEquals` and `in`: its type,
  enum or const, pattern and format, but not its length limits. For `contains`, `startsWith` and `endsWith` it must
  be a string, or an array element of the element's type. For `gt`, `gte`, `lt` and `lte` it must be a finite number,
  or an RFC 3339 instant on a `date-time` field. "Values must have the schema's exact type" (line 1018) is read as
  that.
- **`date-time` fields** take `exists`, `equals`, `notEquals`, `in`, `gt`, `gte`, `lt` and `lte`, all compared as
  instants. `contains`, `startsWith`, `endsWith` and `caseSensitive: true` are refused on them.
- **Case-sensitive comparison is exact code-unit equality, with no NFC.** D5 applies NFC and folding only to the
  case-insensitive form (line 1032).
- **`exists` is own-property presence**, so a present `null` exists. A leaf whose path is missing — absent, or
  through a null or absent parent — is false (line 1019). So is a leaf whose runtime value has the wrong type for the
  operator, such as `null` under `contains`.
- **The prefilter rule** (D5, line 1051) is met by a leaf whose concrete path matches one of the type's `content`
  patterns exactly — not an ancestor — anywhere in the tree, under `not` included.
- **Limits** (line 1041): a lone leaf has depth 1 and the maximum is 8; at most 64 nodes counting combinators;
  "scalar value 1 KB" is a string operand of at most 1024 UTF-8 bytes; `in` takes 1 to 256 values, kept in the given
  order with any duplicates as given, because D5 says nothing more. Canonicalisation adds `caseSensitive: false` where
  it was omitted, and nothing else.

### 16. Mapping details D6 leaves open (lines 1105-1130)

- A template is JSON. An object with a `$path` key is a reference, and may carry only `missing` beside it. An object
  with `$path` and any other key is refused, because under D6's grammar it is neither a reference nor an object
  template. Every other key, `$`-prefixed or not, is an output key: reserving `$` keys is raised with the owner
  instead. Every scalar constant, every reference and every empty object or array counts as one of the 200 leaves.
  "4 KB per constant" is 4096 UTF-8 bytes of the constant's canonical JSON.
- "256 KB per mapped event" is 262 144 UTF-8 bytes of the canonical JSON of `data`. `evaluateMapping` checks the plain
  value, and `checkMappedSize` lets the daemon check again after the envelope is applied.
- A missing `reject` path is the runtime issue `MAPPING_PATH_MISSING`, naming the output and source pointers. What
  decision that becomes is phase B1's.
- `agentcommsuntrusted` lists only pointers whose value in `data` is a string: a copied `null` holds no prose.
- A pointer is percent-encoded per byte of its UTF-8 form. Everything except RFC 3986's unreserved set
  (`A–Z a–z 0–9 - . _ ~`) is encoded, with uppercase hex, so `/` becomes `%2F`, `,` becomes `%2C`, and `!'()*`, which
  `encodeURIComponent` leaves alone, are encoded too. `agentcommsuntrusted` sorts the raw pointers by UTF-8 bytes and
  then encodes each (line 1152).

### 17. The delivery schema marks untrusted strings with an annotation

D3 says the delivery schema "describes the actual delivered representation, including envelope strings when
selected" (line 681) but not how. Every untrusted string position gets `"x-agentcomms-untrusted": "plain"` or
`"enveloped"`, a 2020-12 annotation keyword. Under `enveloped` the node becomes
`{ "type": "string", "x-agentcomms-untrusted": "enveloped" }`, its source `minLength`, `maxLength`, `pattern`,
`format`, `enum` and `const` dropped, because an envelope satisfies none of them (wrapped inside `anyOf` with null where
the source was nullable). Under `plain` the source node is kept and annotated. A missing policy changes the leaf:
`reject` makes it required, `null` makes it nullable, and `omit` makes the property optional. An array template is a
fixed tuple: `prefixItems`, `items: false` and equal `minItems` and `maxItems`.

### 18. The library never builds an envelope

`applyRepresentation` takes `{ kind: 'plain' }` or `{ kind: 'enveloped', envelope: (text, pointer) => string }`. Core's
`wrapUntrusted` draws a random boundary from `node:crypto` (`packages/core/src/untrusted.ts:1, 99-120`), so it stays in
the daemon, which also chooses a boundary that keeps a delivery's bytes stable across retries (phase B1). Library
vectors use a fixed, clearly synthetic stand-in envelope.

### 19. The CloudEvents envelope builder is in phase A

Row A (line 2821) does not name it. But D1 puts "wire-format types" in the library (line 130), D6 says "D3 supplies one
exact full-envelope byte vector for every catalogue type" (line 1158), and §5 owes those vectors with the catalogue
(lines 2926-2929). `buildCloudEvent` therefore takes the definition and the validated event and derives `subject` and
`time` itself, so neither can be passed in or overridden (D6). `source` uses the event's account **id**, which is
stable, rather than its name — D6's `<account>` does not say which (ambiguity S).

`validateCloudEventType` checks exactly what D6 says (lines 1139-1142): the value is a string, it is not empty, and it
is used exactly as given, with no prefix, suffix, trimming or normalisation. Nothing else is refused. Possible safety
rules — a reserved `io.agentcomms.` prefix, a character set, a length bound, well-formed Unicode — are raised with
the owner, not implemented (see "Spec amendments to raise with the owner"). The installation-reset notice is phase B2's,
not here.

### 20. The agentic condition's static form is in phase A; its execution is phase E's

The canonical rule document (B1) embeds the agentic condition, and its save-time checks are pure and need the
catalogue's `content` patterns. `canonicaliseAgenticCondition` checks `{ judgeId, judgeVersion, question, inputs,
threshold, onUncertain }` against what D5 and D2 state and nothing more:
- `judgeId` is a string and `judgeVersion` a positive integer, as every object version is;
- `question` is a string;
- `inputs` is an array of concrete JSON Pointers, each valid for the selected event schema;
- `threshold` is a finite number in `[0, 1]`;
- `onUncertain` is `no-match` (the default, added on canonicalisation) or `hold`;
- and the prefilter rule holds (decision 15).

Non-empty `question` or `inputs`, and unique `inputs`, are raised with the owner, not enforced. The uncertain band,
provider outputs, budgets and every judge kind are phase E's.

### 21. Resend body and risk-flag helpers live in the catalogue; the real `readBody` path is phase D's

§5 gives phase A "named Resend schema fixtures" whose wording describes normalisation (lines 2847-2854), and gives
phase D the same fixtures against the real read (lines 3195-3200). Phase A ships the pure parts and their fixtures:

- `normaliseResendBody({ text, truncated })`, for text already unwrapped from core's envelope. It drops one trailing
  unpaired high surrogate, refuses any other unpaired surrogate, refuses more than 20 000 code points and keeps
  `bodyTruncated` exactly equal to `truncated`.
- `canonicalRiskFlags`, which de-duplicates, sorts by UTF-8 bytes and refuses an unknown flag.

Phase D unwraps the envelope, runs the real `readBody` and calls these.

### 22. Smaller choices

- **Workspace patterns contain no `any` token** (every Appendix A one is `['workspaceId']`). `checkDefinition`
  refuses otherwise, so a handle's workspace is always one value.
- **Each catalogue type has at least two examples**: one minimal (every optional absent, every nullable null) and one
  maximal. Phase A's Resend fixtures are separate files.
- **No CHANGELOG entry in phase A**: nothing a person can install changes while the package is held. The release that
  lifts the hold writes it (decision 1).
- **The isomorphism guard is the package's own test** (`packages/events/test/isomorphic.test.ts`), not a rule for
  every library. D14 does not say every library is isomorphic; this one is.
- **Gmail's `hasAttachments` and `attachments` get no `dependentRequired`.** A.1 lists them among the lazy fields but
  pairs only Resend's body fields (line 3578), and A.5 alone gives the keyword (lines 3803-3820). The transcription
  follows the text (ambiguity D).

### 23. Event identity is phase A's, through WebCrypto; only the daemon's reaction to a collision is B1's

§5's catalogue paragraph owes the event-id vectors (lines 2842-2843), and D3 defines the id exactly (lines 571-578).
B1's row lists "deterministic event ids" (line 2822) because the daemon computes them at ingest, but the function is
pure, so it is phase A's:

- `eventIdPreimage({ installationId, accountId, eventType, typeVersion, dedupeKey })` returns the canonical JSON
  (decision 11) of `["agentcomms-event-v1", installationId, accountId, eventType, typeVersion, dedupeKey]`, with
  `typeVersion` a JSON integer.
- `eventId(input, { digest? })` resolves to the first 32 lowercase hexadecimal characters of SHA-256 over that
  preimage's UTF-8 bytes. The UTF-8 encoding is the library's own (`utf8Encode`).
  - SHA-256 comes from `globalThis.crypto.subtle.digest('SHA-256', …)`, which Node 22 and every browser's secure
    context provide, so the library still has no `node:` import. That is why the function is asynchronous.
  - `digest` is injectable, for tests only.
- `compareEventIdentities(stored, incoming)` takes two `{ eventId, preimage }` and returns:
  - `same-occurrence` when the preimages are equal;
  - `distinct` when the ids differ;
  - `collision` when the ids are equal and the preimages are not.

  That last outcome is the pure half of "D8 detects and stops on the theoretical truncated-hash collision" (line 577).
  Stopping without advancing the cursor is B1's.

## Spec amendments to raise with the owner

Phase A implements exactly what the spec states. These restrictions might be worth having for safety or clarity, but
they would be contracts the spec does not state, so none is implemented. Each is the owner's to add to the spec, or
to decline:

1. **`cloudEventType`** (D6, lines 1139-1142):
   - **Refuse the `io.agentcomms.` prefix**, so a rule cannot emit a CloudEvent typed like the installation-reset
     notice or the test event, which consumers may treat specially.
   - **Require well-formed Unicode.** The daemon encodes the envelope as UTF-8, and an unpaired surrogate there would
     be sent as U+FFFD, so the bytes would not be the approved value.
   - **A length bound and a character set** (CloudEvents recommends a reverse-DNS form).
2. **Every catalogue string well-formed Unicode**, not only the Resend body (A.5, lines 3828-3831). Phase D's adapters
   would replace an unpaired surrogate with U+FFFD.
3. **Reserve `$`-prefixed keys in mapping templates** (D6, lines 1105-1126), so a future operator cannot collide with
   an output key.
4. **Duplicate values in `in`, an empty `question`, and empty or repeated judge `inputs`** (D5, lines 1012,
   1048-1067), all currently allowed.
5. **Confirm the readings** of decision 12 (canonical email keeps the local part), decision 13 (no trailing root dot),
   and decision 15 (an operand validates against its field's enum, pattern and format, as "the schema's exact type").

- **A-K2-1 (committee K2-1, 2–1):** should `validateEvent` itself refuse an unpaired surrogate in a Resend `body` (a new
  invariant), so that a phase D adapter that skipped `normaliseResendBody` cannot emit one? Not implemented; the spec
  places the rule in normalisation only (A.5, 3825-3830).

## Where the spec is ambiguous or contradicts itself, for phase A

Each is resolved by the decision named. Line numbers are the spec's at `225d7855`.

| | Lines | What | Resolved by |
|---|---|---|---|
| A | 556 against 3674-3676, 3699-3700 | `dedupeKey(event: T)`, but Gmail's key needs `historyRecordId`, which is not an event field | decision 9 |
| B | 553 against 3518, 3853, 3906 | D3's format union has no `uuid`; Appendix A uses it | decision 10 |
| C | 3511-3525 against 2836-2839, 4068-4071 | A.1's "mechanical" mapping leaves the exact JSON Schema shape open (nullable form, literals, `$ref`, `required` order) and maps none of the comment-level rules (3607, 3614, 3634, 3684-3689, 3740, 3822, 3894, 3931), while §5 and A.8 compare bytes | decisions 6 and 7 |
| D | 3577-3582 against 3803-3820 | Gmail's lazy attachment fields read like a pair, but only Resend's are given `dependentRequired` | decision 22 |
| E | 3541 | "canonical address" is undefined; core lower-cases a whole address | decision 12 |
| F | 1032 against 90 | NFC is not said to be bundled, though host NFC varies and UTS #46 needs it | decision 2 |
| G | 1043-1044 against 2856-2857 | "a real browser build" against "run … in a browser" | decision 3: both — the browser-platform build, run in real Chromium and WebKit |
| H | 1008-1023, 1032-1035 | `Scalar` is undefined; null operands, case-sensitive normalisation, `equals` on dates, `exists` on null and a wrongly typed runtime value are not said | decision 15 |
| I | 1041, 1125-1126 | "1 KB", "4 KB", "256 KB" and "depth 8" have no unit or counting rule | decisions 15 and 16 |
| J | 681-686 | the delivery schema must describe envelope strings, but not how | decision 17 |
| K | 2847-2854 against 3195-3200 | phase A's "schema fixtures" describe normalisation (capping, surrogate repair, "canonicalises the exact order") that phase D also owns | decision 21 |
| L | 2749 | "neither package is staged as private", against a first publish only the owner can make | decision 1 |
| M | 2733-2737, 2745-2748 against §2 line 60 | B1 is given the declaration-aware parity work, but a publishable library fails `test/parity.test.mjs:99-113` in phase A | Task 2 takes the library half |
| N | 2821 against 130, 1158-1161, 2926-2929 | row A omits the CloudEvents builder whose per-type vectors D6 and §5 put with the catalogue | decision 19 |
| O | 1152-1155 | `agentcommsuntrusted` sorts "by raw UTF-8 bytes" and percent-encodes, without saying which first | decision 16 |
| P | 2836-2843 against 2822 | event-id vectors sit in phase A's catalogue paragraph, while B1's row lists "deterministic event ids" | decision 23: the function and its vectors are phase A's; the cursor stop on a collision is B1's |
| Q | 3571-3575 | whether "Slack `ts` must decode to the same instant" is checked by the catalogue or only by the adapter | decision 7 |
| R | 1050-1051 | "reference a catalogue `content` field": exactly, or also through an ancestor | decision 15 |
| S | 1137-1138 | `source`'s `<account>`: the name or the id | decision 19 |
| T | 259 against 1139-1142 | D2 binds "D6 validation" of `cloudEventType`; D6 says only an exact non-empty value | decision 19: exactly that; anything more is amendment 1 |
| U | 3828-3831 | unpaired surrogates are refused in the Resend body only | decision 8: only there; amendment 2 |
| V | 1024-1027 | canonicalisation names only `caseSensitive`; `in` order and duplicates, and `onUncertain`'s default form, are unsaid | decisions 15 and 20; amendment 4 |
| W | 3504-3507, 3511-3525 | Appendix A is normative, but several of its constraints are stated in comments and prose, not in the notation A.1 maps | Task 10's extraction and prose-rule file |

## Decisions made during the build (committee)

Points the plan and spec left open that came up while building. Each was argued by a three-member committee (the spec's
literal words; safety and downstream consumers; a devil's advocate for the other reading), then decided.

| # | Raised in | Question | Decision | Why |
|---|---|---|---|---|
| K1 | Task 9 (track S) | A metadata pointer pattern reaching a `null` at the END of its path: does it contribute a concrete pointer? | **No.** A `null` at any position, terminal included, contributes no pointer (as `pattern.ts` implements). | A.1 (spec 3589-3590) says an optional property "contributes no concrete pointer when absent or null" and that every terminal a pattern names has "the declared non-null scalar type", so a pointer to `null` would break that guarantee. No requirement needs the other reading: conditions and mappings use concrete paths, not metadata patterns (1017, 1122); a `null` carries no sender content (670-679); formats apply only to non-null scalars. The other reading would make every later consumer filter `null` itself. Unanimous. |
| K2-1 | Task 10 (track T), prose entries 19-20 | Resend `body`: does `validateEvent` refuse an unpaired surrogate, or only `normaliseResendBody`? | **Only `normaliseResendBody`** (as built). Added to "Spec amendments to raise with the owner" as A-K2-1. | 2–1. A.5 (spec 3825-3830) places the rule under "Normalisation from the existing read" and calls the failure "a malformed materialisation response under D3"; the schema block (3806-3814) states only `maxLength`, and decision 7 requires each invariant to quote a spec sentence. Dissent (safety): a phase D adapter that skipped the normaliser could emit a body the daemon's UTF-8 envelope turns into U+FFFD, so delivered text would differ from the hashed payload — raised with the owner rather than invented here. |
| K2-2 | Task 10 (track T), prose entries 28-29 | WhatsApp `messageId`: opaque string, or an invariant tying it to the protocol key? | **An invariant, `whatsapp-message-key`** (new name in decision 7's vocabulary): `messageId` parses as core-canonical JSON of exactly four non-empty strings, re-serialises canonically to the identical string, its first element is `"wa-msg"`, and its third element equals `sender.id`. Nothing about `chat.id` (the spec never says `chat.id` is `chatJid`). | 2–1. A.7: "The event `messageId` is exactly D4's canonical raw protocol message key: `["wa-msg", chatJid, senderJidRaw, stanzaId]`" (3977-3978) and "`sender.id` is the same exact raw `senderJidRaw`" (3981); D4 line 755; empty elements are skipped (3982). `messageId` is the identity and dedupe basis, so a wrongly built one must not validate. Dissent (devil's advocate): the validator cannot see `chatJid`/`stanzaId`, so protection is partial — accepted: the adapter (phase D) still owns full derivation, and consumers must not parse `messageId` (it stays an opaque identity on the wire). |
| K2-3 | Task 10 (track T), prose entry 6 | Gmail `hasAttachments` vs `attachments`: invariant or adapter guidance? | **Adapter guidance only** (as built; no invariant, no `dependentRequired`). | Unanimous. A.1 (3577-3582) makes both separately lazy and the sentence describes what an adapter writes when it fetches; only Resend has `dependentRequired` (3812-3820); a projection may ask for the boolean alone (3579-3580). |

Follow-ups owed by Task 11: (K1) assert that no metadata pattern in any of the seven definitions ends on a `T | null`
field (the guarantee in A.1 must hold, not be assumed); (K2-2) add the `whatsapp-message-key` invariant to the WhatsApp
definition and to decision 7's vocabulary, move prose entries 28-29 from "informational" to that invariant in
`appendix-prose-rules.json` and `catalogue-v1.json` together, and add strict probes (wrong first element, empty element,
non-canonical spacing, third element ≠ `sender.id`) and a permissive probe (a valid key); and (K1) record as an erratum candidate for the spec's next revision that 3589
should read "absent or null at any position, terminal included".

## Batch 1 — release safety

1. **Risky — The registry reads library declarations and release holds; `PACKAGES` becomes "what a tag publishes".**

   **Files.** Change `scripts/channels.mjs` and `scripts/packages.mjs`; change `test/channel-registry.test.mjs` and
   `test/release-packages.test.mjs`.

   **Tests first.** Cover PKG-a, PKG-c, D14-a, D14-c, REL-a and REL-c.

   - In `test/channel-registry.test.mjs`, a `libraryManifest(version, extra)` beside `newcomerManifest`, and a
     `treeWithLibrary({ held })` that drops `packages/shelf` (`@agentcomms/shelf`,
     `"agentcommsPackage": { "kind": "library" }`) into the repository copy:
     - **"D14-a: a declared library is discovered in the same walk, and is publishable but surface-free".**
       `loadRegistry(root).libraries` names `shelf`; `packages` contains it after every package it depends on; it is
       in no `surfaces`, `drivers`, `products`, `reference`, `skillFamilies` or `platforms` entry, and
       `channels.mjs`, run directly, still prints only channel words.
     - **"D14-a: a malformed library declaration is refused, naming the package".** One fixture each: `kind`
       missing; `kind: "service"` (the message says this registry reads `library`; `service` arrives with phase
       B1); an extra key; a non-object; both `"agentcomms"` and `"agentcommsPackage"`; the declaration on a
       `"private": true` package; a library with `bin`; a library named other than `@agentcomms/<directory>`.
     - **"PKG-c: `"agentcomms"` means a channel".** An `"agentcomms"` field carrying `kind` is refused with a message
       naming `agentcommsPackage`.
     - **"D14-a: a non-private package that declares nothing is listed as undeclared".** `loadRegistry(root).undeclared`
       names it; the server-only wrapper (`gmail-mcp`) is never undeclared.
     - **"REL-c: a hold is read from the package, and refused where it cannot apply".**
       `"agentcommsRelease": { "hold": "…" }` lands in `held` with its reason. Refused: on core; on a private or
       undeclared package; an empty or multi-line reason; any key but `hold`.
   - In `test/release-packages.test.mjs`, the list tests (63-91) become:
     - **"D14-c: `PUBLISHABLE` names every non-private package, and nothing else; `PACKAGES` is it less the held
       ones, in the same order"**, over `manifests()`, with the existing duplicate and nonexistent-package checks.
     - **"PKG-a: every publishable package comes after what it depends on"**, over `PUBLISHABLE`. It holds for a
       library too.
     - **"REL-c: no package a tag publishes depends at runtime on a held one, and core is never held"**: over this
       checkout, and over a tree copy whose released fixture channel depends on the held `shelf`, which must fail.
     - **"REL-a: a held package is never read, proven, sent or confirmed by a release"**, the decisive one. In a tree
       copy with `shelf` held (`cp` of `scripts/` and every `packages/*/package.json`, as the empty-list test at
       979-996 does):
       - `node scripts/packages.mjs` prints the copy's six-package list, without `shelf`;
       - `release-ci.mjs pending` and `preflight`, run against `fakeOidc`, never read `@agentcomms/shelf`'s packument
         (`fake.reads`) and never exchange for it (`fake.exchanges`);
       - with the hold removed from `shelf`'s manifest, the same `preflight` names it `never published` and prints
         its hand publish. That is the path decision 1 sends the owner down.
     - "running the list prints it" (121-125) and "the workflow reads the shared list in every loop" (141-166) stay as
       they are: `PACKAGES` is still what `node scripts/packages.mjs` prints.
   - "this checkout's registry is the five channels and six packages it ships" (604-611) gains
     `libraries: []`, `held: []` and `undeclared: []`. Task 3a changes it again when `events` arrives.

   **Then the code.**

   - `scripts/channels.mjs`:
     - `readDeclarations(root)` is one walk returning `{ channels, libraries, held, undeclared }`. It validates the
       library declaration and the hold by hand, with no dependencies (the file's header explains why: the release
       job installs nothing), and refuses with `packages/<dir>/package.json: …` sentences.
     - `readChannels(root)` returns `readDeclarations(root).channels`, so `sync-channels.mjs` and
       `test/helpers/real-shell.mjs` are unchanged.
     - `loadRegistry` adds `libraries`, `held` and `undeclared`, and puts libraries into `publishOrder` beside the
       channels and wrappers.
     - The module comment says what a library is, and that it feeds publication and ordering and nothing that needs a
       surface (D14, lines 2720-2722).
   - `scripts/packages.mjs` exports `PUBLISHABLE`, `HELD` and `PACKAGES` (decision 1), keeps `SCOPE`, and still prints
     `PACKAGES`. Its header says which list each consumer reads and why the release path reads the narrower one.
     Keep `PUBLISHABLE` the first `Object.freeze([…])` in the file: the empty-list test's regex (989) empties the
     first one, which still empties `PACKAGES`.

   **Mutations.**

   - Make `PACKAGES` equal `PUBLISHABLE`: REL-a must fail on the printed list and on `fake.reads`.
   - Accept `kind: "service"`: the malformed-declaration test must fail.
   - Let core be held: REL-c must fail.
   - Drop libraries from `publishOrder`: D14-c must fail.

   **Run.** `node --test test/channel-registry.test.mjs test/release-packages.test.mjs` should end with `# fail 0`,
   and `node scripts/packages.mjs` should print `core gmail gmail-mcp resend slack whatsapp`. Then `pnpm verify` must
   exit 0.

   **Commit.** `feat(tooling): libraries declare themselves, and a package can be held back from a release (events
   phase A, task 1)`, with the mutations in the body.

   **Done when.** The registry knows libraries and holds, the release path's code is unchanged and still publishes
   exactly the six packages, and a held package provably never reaches `pending`, the preflight, the publish or the
   confirm.

2. **Risky — Every walker reads the list it should; the parity test exempts declared libraries; the release documents
   say what a hold is.**

   **Files.** Change `scripts/sync-versions.mjs`, `scripts/verify-package.mjs`, `scripts/third-party-licenses.mjs`,
   `scripts/registries.mjs`, `test/parity.test.mjs`, `test/channel-registry.test.mjs`,
   `test/release-packages.test.mjs`, `test/manifests.test.mjs` and `test/install-docs.test.mjs`. Change
   `docs/RELEASING.md`, `.claude/skills/release/SKILL.md` and `CONTRIBUTING.md`.

   **Tests first.** Cover PKG-b, D14-b, REL-b and REL-d.

   - **"REL-b: the version sync, the package verifier and the licence notices walk `PUBLISHABLE`; the release script
     and `release-ci.mjs` walk `PACKAGES`"** replaces the consumers test (168-194). It checks the text: the first three
     import `PUBLISHABLE` and loop over it; `release.mjs` and `release-ci.mjs` import `PACKAGES` and never
     `PUBLISHABLE`. Neither kind keeps a literal list; `PACKAGE_WORD` (136) is built from `PUBLISHABLE`.
   - **"REL-b: a held library is version-synced"**: in the tree copy, `sync-versions.mjs` bumps `shelf` to `9.9.9`, and
     `--check` fails when it is left behind.
   - **"D14-b: a library dropped into the tree is published in order, synced, consumer-checked, licensed and exempt
     from parity, with no list edited"**: `PUBLISHABLE`, the sync and the parity exemption, as above.
     `verify-package.mjs --all` and the licence script are held to their lists by text, as today; running them would
     need a build.
   - **"PKG-b: only a declared library is a surface-free published package"**: `test/parity.test.mjs:99-113` iterates
     `PUBLISHABLE`, and a package that is neither a surface nor a wrapper passes only if it is in
     `REGISTRY.libraries`. A declared library must have no `bin`, no `src/cli.ts`, no `src/mcp/` and no
     `capabilities.json` row; a fixture library with `bin` (or a row) fails.
   - "verifying any package of this checkout packs core first" (256-274) iterates `PUBLISHABLE`. A channel's or
     wrapper's closure starts with core, and a library's closure is exactly its declared workspace runtime
     dependencies (none, for `events`).
   - `test/manifests.test.mjs:219` and `test/release-packages.test.mjs:1195` copy every `PUBLISHABLE` manifest into
     their scratch trees, because the sync now walks them all.
   - `test/install-docs.test.mjs:45` reads every `PUBLISHABLE` README.
   - `CONSUMERS` in `test/channel-registry.test.mjs:492-515`:
     - `sync-versions.mjs` reads `/from '\.\/packages\.mjs'/`, `/of PUBLISHABLE\b/` and `/PINNED = new RegExp/`;
     - `third-party-licenses.mjs` reads `/import \{ PUBLISHABLE \} from '\.\/packages\.mjs'/`;
     - `registries.mjs` gains `/REGISTRY\.libraries/`;
     - `parity.test.mjs` reads `/PUBLISHABLE/` and `/LIBRARIES/`.
   - **"REL-d: the release documents say what a hold is, and how it is lifted"**. `docs/RELEASING.md` names
     `agentcommsRelease`, says a held package is checked by every verify but left out of the tag's publish, and sends
     its first release to "A new package's first version". `.claude/skills/release/SKILL.md` says the same in one
     paragraph. Neither may say "does not publish" or "a person approves": the existing test (701-711) refuses those
     phrases in both files, so write "is left out of the release".

   **Then the code.**

   - The three walkers switch to `PUBLISHABLE`.
   - `registries.mjs` exports `LIBRARIES`.
   - Documents:
     - **RELEASING.md** gains "A package held back from release", which says what, why, where it is declared, what
       still checks it, and the five steps of decision 1. "The packages" says the publish list is `PACKAGES` and the
       checked list is `PUBLISHABLE`.
     - **The release skill** gains its paragraph.
     - **CONTRIBUTING.md** gains "Adding a library": the declaration, `@agentcomms/<dir>`, lockstep version, no `bin`,
       no row, README, LICENSE, `THIRD_PARTY_LICENSES` in `"files"`, `test/consumer-check.mjs`, and held until its
       first release.

   **Mutations.**

   - Point `sync-versions.mjs` at `PACKAGES`: REL-b's sync case must fail.
   - Drop the library exemption from the parity test while a fixture library is present: PKG-b must fail.
   - Remove the hold paragraph from RELEASING.md: REL-d must fail.

   **Run.** `node --test test/*.test.mjs` should end with `# fail 0`. `pnpm verify` must exit 0.

   **Commit.** `feat(tooling): the version sync, the package checks and the licences walk every publishable package;
   the release walks only what it publishes (events phase A, task 2)`.

   **Done when.** Each walker reads the right list, as a test asserts; the parity test knows a library; and a person
   releasing finds the hold in both release documents.

**Batch 1 ends** with `pnpm verify` on `feat/events-a`. It must exit 0, and `node scripts/packages.mjs` must still
print the six packages.

## Batch 2 — the package

3. **The package, in a series of three commits:**
   - **3a** — the package and its first isomorphism layers;
   - **3b** — event identity;
   - **3c** — real Chromium and WebKit, and the release job.

   They run in order in one worktree.

   **3a — `packages/events`: manifest, build, canonical JSON, the isomorphism guard, the bare realm and the consumer
   check.**

   **Files.**

   - Create in `packages/events/`:
     - `package.json` (decision 4: `agentcommsPackage` and `agentcommsRelease.hold`, whose reason reads "Held until
       the first package that depends on it ships; its first version is then published by hand (docs/RELEASING.md, A
       package held back from release).");
     - `README.md`, `LICENSE` (a copy of the root's), `THIRD_PARTY_LICENSES` (generated), `tsconfig.json`,
       `test/tsconfig.json` and `tsdown.config.ts`, with a comment saying why it is `neutral` and leaves zod external;
     - `src/index.ts`, `src/json.ts`, `src/text.ts` and `src/result.ts`;
     - `test/json.test.ts`, `test/isomorphic.test.ts`, `test/fixtures/isomorphic/*` and `test/conformance.test.ts`;
     - `test/support/realm.ts`, `test/realm/entry.ts`, `test/realm/runners/index.ts` and
       `test/realm/runners/canonical-json.ts`;
     - `test/vectors/canonical-json.json` and `test/consumer-check.mjs`.
   - Create `test/events-canonical-json.test.mjs` at the root.
   - Change `pnpm-lock.yaml` (`pnpm install`), and CONTRIBUTING.md's layout table (one row).
   - Change `AGENTS.md`: one line — before changing `packages/events`, read the event-emission design; its Appendix A
     is normative.
   - Change `test/channel-registry.test.mjs`'s checkout test: packages
     `['core', 'events', 'gmail', 'gmail-mcp', 'resend', 'slack', 'whatsapp']`, `libraries: ['events']` and
     `held: ['events']`.

   **Tests first.** Cover PKG-d, ISO-a, ISO-b and CJ-a.

   - **"CJ-a: canonical JSON is core's, byte for byte"** (root test, both built dists). The vectors cover nested
     objects, key order by UTF-16 code units (the vector `{"\uFF61": 1, "\u{1F600}": 2}`, whose order differs from
     UTF-8's), `undefined` members dropped, escapes, `-0`, large integers, lone-surrogate escaping, and empty arrays
     and objects. In `test/json.test.ts`, refusals: `undefined` in an array, `NaN`, `Infinity`, a `Map`, and an object
     with a prototype. Also `compareUtf8` against byte comparison of UTF-8 encodings over a generated corpus, and
     `utf8ByteLength`, `codePointLength` and `isWellFormed` boundaries.
   - **"ISO-a: the source compiles with no Node and no DOM types"**: reads `tsconfig.json` and asserts
     `"types": []` and `"lib": ["ES2023"]`.
   - **"ISO-a: the source, the generated tables and the built output reach nothing but ECMAScript and zod"**: the
     guard of decision 3 over `src/`, `vendor/*/generated/` (empty for now) and `dist/`, plus one refused and one
     accepted fixture per rule. A missing `dist` fails with "run `pnpm build`". If tsdown's own runtime helper
     (`\0rolldown/runtime.js`) ever trips a rule in `dist`, report it rather than exempting it quietly; an accepted
     exemption names that helper's exact text, never a file or a rule. Core's `dist` shows such globals only from
     inlined third-party code, which this package does not inline.
   - **"ISO-b: the bare realm has no host"**: the realm built by `test/support/realm.ts` reports
     `typeof process`, `require`, `Buffer`, `setTimeout`, `fetch`, `URL`, `TextEncoder` and `console` as
     `"undefined"`, and `new Function('')` throws `EvalError`.
   - **"ISO-b: every vector family runs identically in Node and in the bare realm"** (`test/conformance.test.ts`): for
     each `test/vectors/*.json` (each declares its `family`), run the family's runner in Node against `src/` and in
     the realm. Both must return zero failures and byte-identical result JSON. A vector file whose family has no
     runner fails, so no file is silently skipped.
   - **"PKG-d: the installed package imports in a fresh project and reaches no Node module"**
     (`test/consumer-check.mjs`): import the package, check the canonical-JSON vectors, scan every installed
     `dist` file for `node:` and `require(`, check there is no `bin`, and print
     `events consumer check: … OK`.

   **Then the code.**

   - The JSON and text helpers, and the `Result`, `Issue` and `EventsError` types.
   - The realm harness, using tsdown's in-memory build:
     - the entry is `test/realm/entry.ts`, which imports `../../src/index.ts` and the runner registry and assigns
       `run(family, vectorsJson): string`;
     - `format: 'iife'`, `globalName: 'AgentcommsEventsRealm'`, `platform: 'browser'`, `target: 'es2023'`,
       `noExternal: [/.*/]`, `write: false`, `dts: false`, the package's own config ignored;
     - it is evaluated in `vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })`, and only
       strings cross the boundary.
   - Runners are plain ECMAScript modules that take the library's namespace and a parsed vector file and return
     `{ results, failures }`. Node imports the same files.
   - `pnpm install` to add the workspace package. `pnpm licenses` writes the "inlines no third-party code" notice.

   **Mutations.**

   - Add `import { createHash } from 'node:crypto'` to `src/json.ts`: the compiler and the guard must each fail.
   - Swap the key comparison to `compareUtf8`: CJ-a must fail on the UTF-16-order vector.
   - Let the realm keep Node's globals: ISO-b's host test must fail.

   **Run.** `pnpm --filter @agentcomms/events build && pnpm --filter @agentcomms/events typecheck && pnpm --filter
   @agentcomms/events test` should end with `# fail 0`. `pnpm verify` must exit 0, its last stage printing
   `package verification OK: @agentcomms/events (…)` among the others. `node scripts/packages.mjs` must still print
   the six packages, without `events`.

   **Commit.** `feat(events): the @agentcomms/events package, held back from release: canonical JSON, a guard against
   anything but ECMAScript, and a realm with no host to run its vectors in (events phase A, task 3a)`.

   **Done when.** The library exists, is fully verified and is consumer-checked, is not in the release list, and has the
   isomorphism layers every later task's code passes through.

   **3b — Risky — Event identity: the preimage, the id through WebCrypto, and collision classification
   (decision 23).**

   **Files.**

   - Create `packages/events/src/identity/{event-id,sha256}.ts`, `packages/events/test/identity.test.ts`,
     `packages/events/test/vectors/event-id.json` and `packages/events/test/realm/runners/event-id.ts`.
   - Create `test/events-identity.test.mjs` at the root.
   - Change `src/text.ts` (`utf8Encode`), `src/index.ts`, `runners/index.ts`, `test/consumer-check.mjs`,
     `test/support/realm.ts` (the injected `crypto`) and `test/isomorphic.test.ts`, with the exemption's fixtures.

   **Tests first.** Cover CAT-j, CAT-k and ISO-d.

   - **"CAT-j: event ids are D3's, stable, and change with every tuple component"**, in `event-id.json`:
     - each vector's exact preimage bytes, the full SHA-256 and the 32-character id;
     - the same input twice gives the same id;
     - the same `dedupeKey` under two accounts gives two ids;
     - changing each of `installationId`, `accountId`, `eventType`, `typeVersion` and `dedupeKey` alone changes the
       id;
     - a dedupe key holding an unpaired surrogate, `"`, `\`, `é` and an astral character hashes its escaped canonical
       JSON;
     - `typeVersion` is written as the JSON integer `1`, never the string `"1"`, and `eventIdPreimage` refuses a
       non-integer `typeVersion` (D3 types it as the event's integer `version`);
     - the real Gmail, Slack, Resend and WhatsApp dedupe-key shapes of A.2–A.7 appear as inputs, written as literal
       strings here, because Task 11 computes them.
   - **The root test is the independent oracle.** It checks each vector's committed preimage and id against **core's**
     `canonicalJson` and `sha256Hex` from core's built dist (`node:crypto`), and the library's `eventId` against the
     same values.
   - **"CAT-k: an injected SHA-256 collision is data, and is classified as a collision"**. A vector names two different
     tuples and one 64-character digest. Through the injected `digest`, both yield the same 32-character id, and
     `compareEventIdentities` returns `collision`. The same tuple twice is `same-occurrence`; two different ids are
     `distinct`. The vector says, in its description, that stopping the cursor is B1's.
   - **"ISO-d: only `src/identity/sha256.ts` reaches WebCrypto"**: the exemption's accepted fixture, plus refused
     fixtures for `globalThis.crypto.subtle.digest` in any other file, and for `globalThis.crypto.getRandomValues` and
     `crypto.subtle.encrypt` in that file.
   - The realm runs the family through its one injected capability. ISO-d also asserts that the realm's `crypto` has no
     member but `subtle`, and that `subtle` has no member but `digest`.

   **Then the code.** `utf8Encode`, the preimage, the digest call, hex, the truncation and the classification.
   Runners may now be asynchronous: `run(family, vectorsJson)` returns a promise of the result string, in Node, in
   the realm and, from 3c, in the browsers.

   **Mutations.**

   - Hash the JSON text with UTF-16 code units: CAT-j must fail.
   - Truncate to 31 characters: CAT-j must fail.
   - Make `compareEventIdentities` compare ids only: CAT-k must fail.

   **Run.** `pnpm --filter @agentcomms/events test` and `node --test test/events-identity.test.mjs` should both end
   with `# fail 0`; `pnpm verify` must exit 0.

   **Commit.** `feat(events): event ids exactly as D3 defines them, through WebCrypto, with a collision told apart from
   a repeat (events phase A, task 3b)`.

   **Done when.** Event ids are portable, proven against core's hashing, and a collision is data the daemon can act on.

   **3c — Risky — Real Chromium and WebKit: `pnpm verify:browser`, and a release job the publish depends on.**

   **Files.**

   - Create `packages/events/scripts/verify-browser.mjs` and `packages/events/test/browser/{index.html,boot.js}`.
   - Change `packages/events/package.json` (`playwright`, exact, as a devDependency; the script `verify:browser`) and
     `pnpm-lock.yaml`.
   - Change the root `package.json`: `"verify:browser": "pnpm --filter @agentcomms/events run verify:browser"`,
     deliberately absent from `verify`.
   - Change `.github/workflows/release.yml`: a `browser` job, and `publish`'s `needs`.
   - Change `test/release-packages.test.mjs`, `docs/RELEASING.md` and `CONTRIBUTING.md`.

   **Tests first.** Cover BRW-a, BRW-b and BRW-c.

   - **"BRW-a: every vector family runs in Chromium and WebKit, byte-identical to Node and the realm"**. This is the
     script's own assertion, run by `pnpm verify:browser`, and it prints one line per family and browser. It:
     - builds the same browser-platform IIFE bundle in memory as the realm does;
     - serves it from a `node:http` loopback listener on `127.0.0.1` with `index.html`, whose response carries D13's
       production CSP exactly (spec line 2631);
     - opens the page in Chromium, then in WebKit;
     - for each `test/vectors/*.json` family, and the derived `NormalizationTest` and `IdnaTestV2` cases read from
       their `.gz` sources, calls `AgentcommsEventsRealm.run` in the page.

     It requires zero failures, and result JSON byte-identical to the same family's Node and realm results, computed in
     the same process. It also asserts that the page made no request but the page, `boot.js` and the bundle, and that
     the CSP held: the page's own same-origin `boot.js` tries `new Function('')` and records that it threw. That is
     checked by the page's code rather than by injected code, because Playwright's `evaluate` is not the page's script.
   - **"BRW-b: the release cannot publish without the browser run"**. In `test/release-packages.test.mjs`, the test at
     1243-1284 now expects `publish`'s `needs` to be exactly `['browser', 'old-node', 'verify']`. A new test holds
     the `browser` job to its shape:
     - `runs-on: macos-latest`, with `contents: read` only;
     - checkout without persisted credentials, then pnpm, Node 22.18.0 and `pnpm install --frozen-lockfile`;
     - exactly `pnpm --filter @agentcomms/events exec playwright install chromium webkit`, with no other browser, no
       bare `playwright install` and no `--with-deps`;
     - `pnpm build`, then `pnpm verify:browser`, with no other test or verify.

     It also holds the rest: the `verify` matrix installs no browser, and the root `verify` script does not contain
     `verify:browser`.
   - **"BRW-c: without the browsers, the script says how to get them"**. Run against an empty `PLAYWRIGHT_BROWSERS_PATH`
     (a temporary directory), `verify-browser.mjs` exits 1. Its output names the install command, `--with-deps` for
     Linux, and that `pnpm verify` does not run it. No browser is launched and nothing is downloaded.

   **Then the code.**

   - **The script.** Launch with `chromium.launch()` and `webkit.launch()`, headless. Hand each family's vectors to the
     page as a string argument of `page.evaluate`, which Playwright injects outside the page's CSP. Record every
     request through `page.on('request')`. Before launching, check `executablePath()` for both browsers, which is
     BRW-c's message.
   - **The workflow job**, as BRW-b describes, with a comment that WebKit is the engine of the macOS webview the
     desktop app uses and Chromium that of Windows' WebView2, and that it is kept out of the six verify legs for its
     download.
   - **RELEASING.md**: what the release verifies before the publish gains "and the event library's vectors in Chromium
     and WebKit".
   - **CONTRIBUTING.md**: a change to `packages/events` runs `pnpm verify:browser` too, with the one-time install.

   **Mutations.**

   - Drop `browser` from `publish`'s `needs`: BRW-b must fail.
   - Add `pnpm verify:browser` to the root `verify`: BRW-b must fail.
   - Return a different result for one vector in the page only (a `globalThis` flag the runner checks, set only by
     `index.html`, in a temporary copy): BRW-a must fail, naming the family and the browser.

   **Run.**

   - Once: `pnpm --filter @agentcomms/events exec playwright install chromium webkit`.
   - `pnpm verify:browser` should print a pass line for `canonical-json` and `event-id` in both browsers.
   - `node --test test/release-packages.test.mjs` should end with `# fail 0`.
   - `pnpm verify` must exit 0, without launching a browser.

   **Commit.** `feat(events): the event vectors in real Chromium and WebKit, and a release job the publish waits for
   (events phase A, task 3c)`.

   **Done when.** Every later vector family is proven in two real engines before each commit and each batch end, and no
   tag can publish without that run.

**Batch 2 ends** with `pnpm verify` and `pnpm verify:browser`. This is the first run with a real held package, and it
proves Batch 1 end to end.

## Batch 3 — foundations (tracks U, S and T in parallel)

### Track U — Unicode, domains and formats

4. **Risky — The Unicode 15.1 sources, their pins, the generator and the vendored notice.**

   **Files.**

   - Create in `packages/events/vendor/unicode-15.1.0/`: `NOTICE.json`, `LICENSE`, `SOURCES.json`, the seven
     `sources/*.txt.gz` files, and `generated/{version,case-folding,normalization,idna-mapping,bidi-class,joining-type,marks}.ts`.
   - Create `packages/events/scripts/unicode.mjs`, `packages/events/test/unicode-generator.test.ts` and
     `packages/events/test/fixtures/ucd/*` (synthetic fragments).
   - Change the root `package.json` (`sync:unicode`, `verify:unicode`, and `pnpm verify:unicode` in `verify` after
     `verify:channels`), `biome.json` (exclude `packages/events/vendor/*/generated`) and `.gitattributes`
     (`*.gz binary`).
   - Change `scripts/third-party-licenses.mjs` and `test/third-party-licenses.test.mjs`.
   - Change `packages/events/src/index.ts` (`export { UNICODE_VERSION } …`), `packages/events/tsconfig.json`
     (include the generated directory) and `packages/events/THIRD_PARTY_LICENSES`.

   **Tests first.** Cover UNI-a and UNI-d.

   - **"UNI-a: the generator makes the expected tables from synthetic fragments"**: tiny `CaseFolding`,
     `UnicodeData` (with a `<…, First>`/`<…, Last>` range), `CompositionExclusions`, `DerivedJoiningType` and
     `IdnaMappingTable` fragments, with expected integer tables written by hand.
   - **"UNI-a: the check refuses drift"**, against a temporary copy of the vendor directory: an edited generated file;
     a source whose bytes no longer match its pin; a missing source; an extra file in `generated/`; a pin whose size
     matches but hash does not. Each fails with a sentence naming the file.
   - **"UNI-a: the committed tables are what the pinned sources generate"**: `pnpm verify:unicode` passes on the tree.
   - **"UNI-d: a module under a package's vendor directory is that vendor's"**, in `test/third-party-licenses.test.mjs`:
     - `ownerOf('<root>/packages/events/vendor/unicode-15.1.0/generated/x.ts', at('events'))` is
       `{ kind: 'vendored', directory: … }`, while `packages/events/src/x.ts` is still `own`;
     - a vendor directory with no `NOTICE.json` is a problem naming it;
     - the notice header reads `unicode-character-database@15.1.0 — Unicode-3.0`, and `noticedIn` reads it back.
   - **"UNI-d: the events package's notices carry the Unicode licence because its build inlines the tables"**:
     `pnpm verify:licenses` passes with that notice in `packages/events/THIRD_PARTY_LICENSES`, and fails when the
     notice is deleted.

   **Then the code.**

   - `unicode.mjs --fetch` downloads, verifies and writes the `.gz` files and `LICENSE`. Run it once, by hand. **If any
     hash differs from decision 2's table, stop and report**, because the files changed at the source.
   - The generator emits sorted, merged range tables as integer arrays, and lazily decoded lookups. The joining types
     are `D`, `R`, `L`, `T`, `C` and `U`. The Bidi classes are those RFC 5893 names. The marks are General_Category
     `Mn`, `Mc` and `Me`, plus combining class 9. The NFC tables are canonical decompositions, combining classes, and
     Full_Composition_Exclusion derived from `CompositionExclusions.txt`, singletons and non-starter decompositions;
     Hangul is algorithmic. The case-folding table is `C` and `F` only.
   - `version.ts` exports `UNICODE_VERSION` and the source hashes.
   - `ownerOf` and `inlinedInto` gain the `vendored` kind: `NOTICE.json` is read as the manifest, and `LICENSE` as the
     text. The script's header comment says why vendored data is noticed from the bundle graph.

   **Mutations.**

   - Flip one byte in a decompressed source in a temporary copy: UNI-a's pin check must fail.
   - Delete the vendored branch of `ownerOf`: UNI-d must fail, with no notice in the events notices.

   **Run.** `pnpm verify:unicode` should print that the tables match their pinned sources;
   `node --test test/third-party-licenses.test.mjs` and `pnpm --filter @agentcomms/events test` should end with
   `# fail 0`. `pnpm verify` must exit 0.

   **Commit.** `feat(events): Unicode 15.1 sources pinned by SHA-256, tables generated from them, and their licence in
   the notices (events phase A, task 4)`.

   **Done when.** Every table is reproducible from pinned, licensed, vendored sources by every `pnpm verify`, and the
   tarball's notices carry the Unicode licence.

5. **NFC and full case folding, from 15.1 alone.**

   **Files.** Create `packages/events/src/unicode/{codepoints,nfc,fold}.ts`, `packages/events/test/unicode.test.ts`,
   `packages/events/test/vectors/unicode-folding.json` and `packages/events/test/realm/runners/unicode.ts`. Change
   `src/index.ts` (one line), `test/realm/runners/index.ts` (one line) and `test/consumer-check.mjs` (one block).

   **Tests first.** Cover UNI-b, UNI-e and CND-e.

   - **"UNI-b: NFC meets NormalizationTest 15.1"**: every Part 0–3 line satisfies `c2 == nfc(c1) == nfc(c2) ==
     nfc(c3)` and `c4 == nfc(c4) == nfc(c5)`, and every assigned code point outside Part 1 is its own NFC. It runs in
     Node, the realm, Chromium and WebKit, with the parsed lines handed in as JSON.
   - **"CND-e: full case folding is CaseFolding 15.1's C and F, never T"**: every `C` and `F` line maps exactly; `T`
     lines and `S`-only lines leave their code point to `C`/`F` or to itself; an unlisted code point folds to itself.
     Hand vectors in `unicode-folding.json`:
     - `ß` → `ss`;
     - `ẞ` → `ss`;
     - `İ` → `i̇` (`0069 0307`), never Turkic `i`;
     - `I` → `i`;
     - `Σ`, `σ` and `ς` → `σ`;
     - KELVIN SIGN → `k`;
     - ANGSTROM SIGN → `å`;
     - Cherokee small `ꭰ` → `Ꭰ` (folding goes to upper case there);
     - `ﬁ` → `fi`;
     - and `foldForComparison` equalities that need NFC first (`e` + U+0301 against `é`).
   - **"UNI-e: no host case mapping"**: `caseFold('\uA7CB') === '\uA7CB'`. Where the host's Unicode is 16 or later, the
     test also asserts `'\uA7CB'.toLowerCase() !== '\uA7CB'`, so the vector is known to discriminate; on an older host
     it says why it skips that half.

   **Then the code.** Canonical decomposition, canonical ordering, canonical composition with exclusions, and
   algorithmic Hangul. `caseFold` maps per code point by the table. `foldForComparison(s)` is `caseFold(nfc(s))`,
   exactly D5's order.

   **Mutations.** Include the `T` mappings: `İ` and `I` must fail. Skip the exclusions: NormalizationTest must fail.

   **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`, the conformance test reporting the
   `unicode` family in both in-process runs. `pnpm verify` must exit 0, and `pnpm verify:browser` must pass.

   **Commit.** `feat(events): NFC and full case folding from Unicode 15.1, the same in Node, a realm with no host and real
   browsers (events phase A, task 5)`.

   **Done when.** Normalisation and folding are proven against Unicode's own tests in Node, the realm and both
   browsers, and no host API is reached.

6. **Risky — UTS #46 revision 31 ToASCII, and the canonical domain.**

   **Files.** Create `packages/events/src/idna/{punycode,uts46,bidi,joiners,domain}.ts`,
   `packages/events/test/idna.test.ts`, `packages/events/test/vectors/idna.json` and
   `packages/events/test/realm/runners/idna.ts`. Change `src/index.ts`, `runners/index.ts` and
   `test/consumer-check.mjs` (one line or block each).

   **Tests first.** Cover UNI-c and CND-f.

   - **"UNI-c: ToASCII meets IdnaTestV2 15.1"**: every line, read by the file's own column rules (a blank `toAsciiN`
     means the `toUnicode` value; a blank status means the `toUnicodeStatus`). The non-transitional `toAsciiN` value
     and its status set match exactly, `U1` included because STD3 rules are on. Transitional columns are not tested,
     because D5 is non-transitional. It runs in Node, the realm, Chromium and WebKit.
   - **"CND-f: the profile D5 names, case by case"**, in `idna.json`:
     - mapping (`EXAMPLE.com` → `example.com`, fullwidth forms);
     - deviation characters kept under non-transitional processing (`faß.de` → `xn--fa-hia.de`; final sigma; ZWJ and
       ZWNJ in valid contexts);
     - STD3 refusals (`_`, a space);
     - `--` at positions 3–4, and a leading or trailing hyphen;
     - a label starting with a combining mark;
     - Bidi refusals (RTL mixed with an initial number), and the joiner contexts;
     - Punycode round trips, and an invalid `xn--` label;
     - a 63-octet label accepted and a 64-octet one refused, with the same at 253 and 254 for the whole name;
     - an empty label;
     - a trailing root dot refused (decision 13);
     - a character unassigned in 15.1 but assigned in Unicode 16 or later, refused.

   **Then the code.**

   - Processing: map by the table's status, NFC, split on U+002E, then decode and validate any `xn--` label.
   - Validity: NFC, hyphens, no leading mark, statuses, CheckJoiners by RFC 5892 A.1 and A.2 (Virama, Joining_Type),
     CheckBidi by RFC 5893.
   - ToASCII: Punycode-encode each non-ASCII label, then check DNS lengths.
   - `toAsciiDomain` returns a `Result` whose issue `detail` carries the status codes.

   **Mutations.** Turn transitional processing on: the `ß` and `ς` lines must fail. Skip CheckBidi: the `B` lines must
   fail. Accept a trailing dot: the trailing-dot case in `idna.json` must fail.

   **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`; `pnpm verify` must exit 0.

   **Commit.** `feat(events): UTS #46 revision 31 ToASCII, bundled and pinned, proven against IdnaTestV2 15.1 in Node,
   a hostless realm and real browsers (events phase A, task 6)`.

   **Done when.** Every IdnaTestV2 line passes in Node, the realm and both browsers, and a domain has exactly one
   canonical spelling.

7. **The semantic formats and exact instants.**

   **Files.** Create `packages/events/src/formats/{index,instant,uuid,uri,email}.ts`,
   `packages/events/test/formats.test.ts`, `packages/events/test/vectors/formats.json` and
   `packages/events/test/realm/runners/formats.ts`. Change the usual three append-only places.

   **Tests first.** Cover D5-v.

   - **"D5-v: every legal format"**, per format, with accepted and refused vectors:
     - `date-time` and instants (decision 14): offsets, `t` and `z` in lower case, fractions of 0–9 digits,
       February 29 in leap and common years, `23:59:60Z` and `23:59:60+01:00` against `12:00:60Z`, a missing offset,
       month 13, hour 24; `compareInstants` across offsets, across fraction lengths (`.1` against `.100000`), and a
       Slack-precision pair one microsecond apart;
     - `uuid`, in either case, refusing the wrong group lengths;
     - `uri`: RFC 3986 absolute URIs, refusing a relative reference, bad percent-encoding and non-ASCII;
     - `email` (decision 12): a dot-string, a quoted string, an upper-case local part kept, `xn--` domains, and
       refusals of an upper-case domain, an address literal, a non-ASCII local part, and a domain `toAsciiDomain`
       changes;
     - `domain` (decision 13).

     `isFormat` dispatches all five.

   **Then the code.** The parsers are exact and hand-written, with no regex `i` flag and no `Date`. `canonicalEmail`
   maps the domain through `toAsciiDomain` and keeps the local part.

   **Mutations.** Accept an offset-less date-time: D5-v must fail. Compare fractions as numbers: the microsecond pair
   must fail.

   **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`; `pnpm verify` must exit 0.

   **Commit.** `feat(events): the catalogue's five semantic formats and exact RFC 3339 instants (events phase A,
   task 7)`.

   **Done when.** Every format has accepted and refused vectors that pass in Node, the realm and both browsers.

### Track S — the schema description and pointers

8. **The schema description, compiled to Zod and to JSON Schema (decisions 5 and 6).**

   **Files.** Create `packages/events/src/schema/{describe,to-zod,to-json-schema,resolve}.ts` and
   `packages/events/test/schema.test.ts`. Change `packages/events/package.json` (an exact `ajv` devDependency) and
   `pnpm-lock.yaml`.

   **Tests first.**

   - Each node kind compiles to decision 6's exact JSON:
     - a nullable scalar, and a nullable object, as `anyOf`;
     - `integer(minimum: 0)` as `number`, `multipleOf: 1`, `minimum: 0`;
     - an object's `required`, sorted by UTF-8 bytes and present even when empty;
     - `uniqueItems`, the string-union `anyOf`, and `dependentRequired`.
   - **Differential checks against ajv** (2020-12; formats registered from a test stub until Task 7's are wired in
     Task 11; the annotation keyword `x-agentcomms-untrusted` registered). For a corpus of mutations — remove each
     required property, add an extra property at each object, put `null` where it is not allowed, change a type,
     step outside an enum, step one code point past a length limit, break a pattern — zod and ajv agree on every
     case.
   - Lengths count code points: a 3-character astral string passes `maxLength: 3`, and so does a BMP one;
     `minLength: 1` refuses `""`.
   - `resolve` returns the node at a token path and refuses an undeclared object key.

   **Then the code.** The description types; the Zod compiler (`strictObject`, code-point length checks, an injected
   `checkFormat`, a `sorted` array option that emits no JSON Schema keyword); the JSON Schema compiler; the resolver.

   **Mutations.** Emit `"type": "integer"`: the integer case must fail. Count length with `.length`: the astral case
   must fail.

   **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`; `pnpm verify` must exit 0.

   **Commit.** `feat(events): one schema description per event, compiled to Zod and to exact JSON Schema 2020-12
   (events phase A, task 8)`.

   **Done when.** Zod and the generated JSON Schema agree with ajv on every case, and the shape is decision 6's.

9. **JSON Pointers and pointer patterns.**

   **Files.** Create `packages/events/src/pointer.ts`, `packages/events/src/pattern.ts`,
   `packages/events/test/pointer.test.ts`, `packages/events/test/vectors/pointers.json` and
   `packages/events/test/realm/runners/pointers.ts`. Change the usual three.

   **Tests first.** Cover CAT-d, CAT-e, CAT-f and CAT-g.

   - **"CAT-e: RFC 6901, exactly"**:
     - `""` is the root;
     - `/` names the empty key;
     - `~0` and `~1` escape and round-trip (`/a~1b/~0c`);
     - `/0` is index 0, while leading zeros (`/01`) and `-` are refused **on an array** and are ordinary keys on an
       object (`"0"`, `"01"`, `"-"`);
     - `*` is a literal key;
     - a malformed escape (`~2`, a trailing `~`) is refused.
   - **"CAT-g: own properties only"**: `getPointer` on an object whose own keys are `__proto__`, `constructor` and
     `prototype` (built through `JSON.parse`) finds them as data, and finds nothing on an object that merely inherits
     them.
   - **"CAT-d: patterns are valid only on the schema's shape, and expand to every present index"**:
     - `{ any: true }` on an object, and a string token on an array, are refused against a schema description;
     - expansion escapes keys;
     - an absent optional, or a null parent, contributes nothing (A.1, line 3589);
     - nested `any` tokens expand in index order.
   - **"CAT-f: equal, ancestor, descendant or disjoint"**: `relatePointers` over the root, siblings that share a prefix
     (`/a/b` and `/a/bc`), escaped keys and indices.

   **Then the code.** Parsing, formatting, own-property access, schema-aware resolution (through Task 8's resolver),
   pattern validation, expansion and matching.

   **Mutations.** Use `in` instead of `Object.hasOwn`: CAT-g must fail. Compare pointers as string prefixes: the `/a/bc`
   case must fail.

   **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`; `pnpm verify` must exit 0.

   **Commit.** `feat(events): RFC 6901 pointers and the catalogue's pointer patterns, own properties only (events
   phase A, task 9)`.

   **Done when.** Every pointer and pattern vector passes in Node, the realm, Chromium and WebKit.

### Track T — the transcription

10. **Appendix A, read twice: every normative constraint extracted from the spec's text by machine, and a hand
    transcription that must equal it.**

    The point is that no single reading can bless an invented contract. The extraction reads the spec, the
    transcription is a person's reading, and the implementation (Task 11) is a third. Each is compared with the
    extraction, constraint by constraint, so a fixture and a definition that are wrong the same way still fail.

    **Files.** Create:
    - `packages/events/test/appendix/extract.ts` — the extractor: test code, written from A.1's rules and independent of
      `src/schema`;
    - `packages/events/test/appendix/records.ts` — the constraint record, and a reader that turns a decision-6 JSON
      Schema into records;
    - `packages/events/test/fixtures/catalogue-v1.json` — the transcription;
    - `packages/events/test/fixtures/appendix-prose-rules.json` — the prose rules;
    - `packages/events/test/appendix.test.ts`.

    **The constraint record.** One per field position, for each of the seven types, the path written with `*` for "any
    array item":

    - `optional` and `nullable`;
    - the kind (`string`, `number`, `boolean`, `object`, `array`, `const`, `enum`, `anyOf`);
    - `const`, and `enum` members in order;
    - `pattern` and `format`;
    - `minLength` and `maxLength`, in code points;
    - `minimum` and `multipleOf`;
    - for an array, its item record, `uniqueItems` and `sorted-utf8`;
    - for an object, `additionalProperties: false` and `dependentRequired`.

    Per type, the record set also carries the five metadata lists, the named invariants (decision 7), and `subject` and
    `dedupeKey` as descriptors.

    **What the extractor reads, and how.** It finds `## Appendix A` and `### A.1`–`### A.7` by prefix.

    - **A.1's notation rules** (lines 3511-3525) are the extractor's grammar:
      - objects are strict;
      - a property is required unless it ends in `?`;
      - `T | null` is the only nullable form;
      - `integer(minimum: 0)` is `number`, `multipleOf: 1`, `minimum: 0`;
      - the named formats, and the custom `domain`;
      - lengths count code points;
      - `NonEmptyString` is `minLength: 1`.

      The extractor quotes each rule's sentence and asserts it still appears verbatim, so a change to A.1 fails the
      test rather than silently changing the grammar.
    - **A.1's aliases.** `type X = string; // pattern …` gives a pattern, `// format …` a format, a union of string
      literals an enum in its order, and `AddressV1` an object. `CommonEventV1<TType, TChannel, TAccountId>` gives
      `type` and `account.channel` as constants of the instantiating type, `version` as `const 1`, and `account.id`
      with the alias's pattern.
    - **The type blocks of A.2–A.7.** Every property, with:
      - `?`;
      - alias names, `string`, `boolean` and `integer(minimum: 0)`;
      - string-literal unions;
      - `T | null`, `T[]`, inline `{ … }`, `{ … }[]` and `{ … } | null`;
      - intersections with `CommonEventV1<…>`;
      - `GmailMessageEventV1<T>` instantiated for received and sent.
    - **Trailing comments**, against a closed vocabulary that maps mechanically:
      - "duplicate-free" → `uniqueItems`;
      - "raw-UTF-8 sorted" and "canonical-sorted" → `sorted-utf8`;
      - "format uuid" → `format: "uuid"`;
      - "schema maxLength: 20000 Unicode code points" → `maxLength: 20000`;
      - "JSON integer const 1" and "JSON boolean const false" → `const`;
      - "[] is allowed" → no `minItems`;
      - `pattern …` → a pattern.

      **Any other comment text must be accounted for by an entry in the prose-rule file**, or the test fails with
      "unaccounted constraint comment", naming the type, the field and the text.
    - **A.5's fenced JSON fragment** (lines 3806-3816): `dependentRequired` and the body's `maxLength`.
    - **The WhatsApp kind**: the `WhatsAppMessageKindV1` union plus the `UnknownWhatsAppMessageKindV1` pattern alias give
      `anyOf: [enum of 19, pattern]`. The prose sentence that says so (lines 3957-3958) is a prose-rule entry
      confirming that shape.
    - **The metadata lists**, fenced or inline in backticks as A.3 writes them, read as JSON once the notation is
      quoted. Also A.1's rule that every type's `formats` starts with `occurredAt` and `observedAt`.

    **The rules no machine can extract**, and how they are transcribed and reviewed. Cross-field and prose
    constraints are not mechanical:
    - "the same instant used for `occurredAt`";
    - "At least one of `added` or `removed` is non-empty, and the same label id may not occur in both";
    - "When `attachments` is present its length equals `attachmentCount`";
    - "`previous !== current`";
    - "exactly `account.id`";
    - "Slack `ts` must decode to the same instant";
    - the `subject` and `dedupeKey` definitions.

    Each is an entry in `appendix-prose-rules.json`: `{ "types": […], "quote": "<verbatim text of Appendix A>",
    "becomes": … }`. `becomes` is one of:
    - a named invariant of decision 7;
    - a schema keyword at a path, when the prose states one, as the WhatsApp `anyOf` sentence does;
    - a `subject` or `dedupeKey` descriptor;
    - `{ "informational": "<why this is not a catalogue constraint>" }`, for sentences about adapter behaviour (phase D's
      normalisation, skipped rows, lazy fetching) or B1's identity handling.

    The test enforces the file in three ways:
    1. **Verbatim quotes.** Every `quote` appears verbatim in Appendix A, whitespace-normalised, so a spec edit fails
       the entry rather than leaving it stale.
    2. **A coverage sweep.** Every sentence of A.1–A.7's prose and every unrecognised comment that contains a word from
       a closed list is covered by some entry's quote. The list: `must`, `may not`, `only`, `exactly`, `at least`,
       `non-empty`, `equals`, `same`, `!==`, `duplicate`, `sorted`, `present`, `absent`, `required`, `never`,
       `skipped`, `identical`, `length`. So no constraint-bearing sentence is silently dropped.
    3. **One to one.** Every invariant the fixture names has exactly one entry, and every `invariant` entry is in the
       fixture.

    **Review.** Because entries are a person's reading, the task's reviewer reads every entry against its quote, and
    especially every `informational` one, which is where a real constraint could be waved away. The commit body
    lists the counts by kind, and every `informational` entry with its reason, so the review is of a short list.

    **Tests first.** Cover A8-a, A8-b, A8-c and A8-d.

    - **"A8-b: every normative constraint of Appendix A is extracted"**. The extractor's records for all seven types are
      checked against hand-picked expectations for one field of every kind:
      - `/id`'s pattern;
      - `/account/id`'s per-channel pattern;
      - `/labels` (`uniqueItems`, `sorted-utf8`, items `minLength: 1`);
      - `/authentication/ignoredHeaders` (`number`, `multipleOf: 1`, `minimum: 0`);
      - `/from` (`AddressV1 | null`);
      - `/body` in Resend (`maxLength: 20000`, `dependentRequired`);
      - `/fromMe` (`const false`);
      - `/kind` in WhatsApp (`anyOf`);
      - `/emailId` (`format: "uuid"`).

      Also: the extractor finds exactly seven types, and no comment or sentence is left unaccounted for.
    - **"A8-a: the fixture follows decision 6"**:
      - inline nodes only;
      - every object `additionalProperties: false` with a sorted `required`;
      - integers as `number` plus `multipleOf: 1`;
      - nullables as `anyOf`;
      - the `$id` pattern.
    - **"A8-c: the transcription equals the extraction"**. The fixture's schemas, read into records by `records.ts`,
      equal the extractor's records field for field and constraint for constraint, with nothing extra and nothing
      missing; its metadata lists equal the extracted lists. A difference names the type, the path and the constraint.
    - **"A8-d: every prose rule is quoted verbatim, every constraint-bearing sentence is covered, and invariants match
      one to one"**, as above.

    **Then the code.** The extractor, the record reader and the two fixtures. The transcription is written by hand
    from the spec, **never by running code**. For each type it holds:
    - `schema`, by decision 6's rules;
    - `metadata` in Appendix A's order;
    - `invariants`;
    - `subject` and `dedupeKey` descriptors: `{ "pointer": "/messageId" }`,
      `{ "join": "/", "pointers": ["/channel/id", "/ts"] }`, or
      `{ "canonicalJson": [ { "staging": "historyRecordId" }, { "pointer": "/messageId" }, "received" ] }`.

    **Mutations**, each run on a copy of the spec text the test is pointed at, or on a copy of a fixture:
    - rename a field, drop a `?`, change a pattern, delete "duplicate-free" from a comment, reorder an enum: A8-b and
      A8-c must each fail;
    - add an invented `maxLength` to the transcription: A8-c must fail, naming it;
    - delete one prose-rule entry: A8-d's coverage sweep must fail;
    - edit one word inside a quoted sentence of the spec copy: A8-d's verbatim check must fail.

    **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`; `pnpm verify` must exit 0.

    **Commit.** `test(events): every constraint of Appendix A extracted from the spec's text, and a hand transcription
    held to it (events phase A, task 10)`, with the prose-rule counts and the `informational` list in the body.

    **Done when.** Every normative constraint of Appendix A exists as a machine-extracted record or a reviewed,
    verbatim-quoted prose rule; the transcription equals them exactly; and Task 11 has both to compare against.

**Batch 3 ends** when tracks U, S and T are merged into `feat/events-a`, the append-only conflicts resolved, and
`pnpm verify` and `pnpm verify:browser` both pass.

## Batch 4 — the catalogue

11. **Risky — The seven version-1 definitions, exactly Appendix A.**

    **Files.**

    - Create `packages/events/src/catalogue/`:
      - `types.ts` (the hand-written interfaces of A.1–A.7);
      - `definitions/{gmail,slack,resend,whatsapp}.ts`;
      - `invariants.ts`, `keys.ts` (`subject`, `dedupeKey`, `whatsappMessageKey`), `resend.ts`
        (`normaliseResendBody`, `canonicalRiskFlags`), `fields.ts` (`describeFields`), `check.ts`
        (`checkDefinition`) and `index.ts` (`CATALOGUE`, `catalogueEntry`, `validateEvent`, `sourceSchema`).
    - Create `packages/events/test/catalogue.test.ts`, `packages/events/test/resend-fixtures.test.ts`,
      `packages/events/test/vectors/{catalogue,resend-body}.json` and `test/realm/runners/catalogue.ts`.
    - Change the usual three.

    **Tests first.** Cover CAT-a, CAT-a2, CAT-b, CAT-c, CAT-h, CAT-i, CAT-r1–CAT-r8 and D3-a.

    - **"CAT-a: the generated source schemas and metadata are the transcription, byte for byte"**: for each
      definition, `canonicalJson({ schema: sourceSchema(def), metadata, invariants })` equals the fixture's entry. A
      difference names the type and the first differing pointer.
    - **"CAT-a2: the generated JSON Schema and zod schema state every extracted constraint, and no other"**, against
      Task 10's extraction rather than the fixture, so that a fixture and a definition wrong in the same way still
      fail:
      - **The JSON Schema.** `sourceSchema(def)`, read into records by Task 10's reader, equals the extractor's records
        exactly.
      - **The zod schema, by strict probes.** For every extracted constraint, a value that breaks exactly that
        constraint, built from a valid example, must be refused by `validateEvent` and by ajv. Probes cover: a
        required property removed; an extra property at each object; `null` where not nullable; the wrong kind; a
        value outside `const` or `enum`; one code point past `maxLength` and short of `minLength`; a pattern or
        format broken; below `minimum`; a non-integer where `multipleOf: 1`; a duplicate where `uniqueItems`; an
        unsorted array where `sorted-utf8`; and an orphan under `dependentRequired`.
      - **The zod schema, by permissive probes**, which catch an invented constraint. For every position, each thing
        the extraction does not forbid must be accepted by `validateEvent` and by ajv:
        - an optional property absent, and `null` where nullable;
        - a 100 000-code-point string where no `maxLength` is extracted;
        - an empty string where no `minLength`;
        - any string where no pattern, format, `const` or `enum`;
        - a large integer where no maximum;
        - an empty array, and duplicates where not `uniqueItems`;
        - any order where not `sorted-utf8`.
      - **The invariants**: the definition's named invariants equal the `invariant` entries of the prose-rule file for
        that type, one to one.
    - **"CAT-b: every example is valid"**: every example passes `validateEvent` and ajv on `sourceSchema` (formats now
      Task 7's). The mutation corpus of Task 8, generated over each example, is refused by both. The invariant-only
      mutations — each `sorted-utf8` reversed, `date` one microsecond off, `added` and `removed` both empty or
      sharing a label, `attachments` length one off, `previous === current`, `workspaceId` differing — are refused by
      `validateEvent`, and accepted by ajv as expected.
    - **"CAT-c: every declaration is legal for the schema and reaches only its declared type"**: `checkDefinition`
      passes on all seven. Every `addresses` pattern reaches `email` strings; every `handles` pattern and workspace
      reaches non-empty strings, and workspaces have no `any`; every `formats` entry is the node's own `format`, and
      the reverse. A broken copy of each fails, naming the pattern.
    - **"D3-a: subject and dedupeKey are Appendix A's"**: for every example, the descriptor interpreter's result
      equals `def.subject` and `def.dedupeKey(example, staging)`. Gmail keys are canonical JSON of
      `[historyRecordId, messageId, "received" | "sent" | "labelled"]`. A Gmail call with a non-decimal
      `historyRecordId` throws. `whatsappMessageKey` is canonical JSON of `["wa-msg", chat, sender, stanza]`.
    - **"CAT-h: the library refuses every `agentcomms.*` type"**: `catalogueEntry` gives `EVENT_TYPE_NOT_SELECTABLE` for
      `agentcomms.source.degraded`, `.gap`, `.recovered`, `agentcomms.delivery.dead_lettered` and an unknown
      `agentcomms.anything`; `EVENT_TYPE_UNKNOWN` for an unknown type; `EVENT_VERSION_UNKNOWN` for version 2.
    - **"CAT-i: the reset notice and the test event are not event types"**: `catalogueEntry` refuses
      `io.agentcomms.test.v1` and `io.agentcomms.control.installation-reset.v1`, and neither is in `CATALOGUE`.
    - **The Resend fixtures (decision 21)**, as `resend-body.json` and `resend-fixtures.test.ts`, each also run
      through `validateEvent` and ajv:
      - **"CAT-r1"**: an attachment `safe.svg` with `riskFlags: ["html-or-svg"]` is accepted.
      - **"CAT-r2"**: `safe\u200B.svg` with `["hidden-characters-in-name", "html-or-svg"]` is accepted, the reverse
        order is refused, and `canonicalRiskFlags` turns the reverse into exactly that order.
      - **"CAT-r3"**: the generated schema has `maxLength: 20000`, and both validators count code points.
      - **"CAT-r4"**: `normaliseResendBody` given a 20 000-unit BMP slice of a 25 000-character text, with
        `truncated: true`, keeps 20 000 code points and `bodyTruncated: true`; a 20 001-code-point body is refused.
      - **"CAT-r5"**: exactly 20 000 code points with `truncated: false` gives `bodyTruncated: false`.
      - **"CAT-r6"**: 10 000 astral characters (20 000 code units) are 10 000 schema characters, and an astral body of
        20 000 code points (40 000 units) still validates.
      - **"CAT-r7"**: a 20 000-unit slice that ends in a lone high surrogate drops it, keeps `bodyTruncated: true`,
        has at most 20 000 code points and no unpaired surrogate; an unpaired surrogate anywhere else in the body is
        refused (A.5, lines 3828-3831).
      - **"CAT-r8"**: an absent body has an absent flag; `body` without `bodyTruncated`, and the reverse, are refused
        by the generated schema (`dependentRequired`) and by zod.
    - **Decision 8, the other way round**: an unpaired surrogate in any string other than the Resend body is accepted,
      as the permissive probes require, because Appendix A states no such rule.

    **Then the code.**

    - The seven definitions, written from the spec, never from the fixture or the extraction. Shared nodes for
      `CommonEventV1`, `AddressV1` and `RiskFlagV1`. At least two examples per type (decision 22), synthetic, using
      `example.com` addresses, `ibx_`/`acc_` ids of 16 upper-case characters, the fake Slack ids and the drama-range
      WhatsApp JIDs.
    - `validateEvent` is zod, then the invariants.
    - `describeFields` lists every pattern position with its kind, nullability, optionality, format and its
      untrusted, content, address and handle flags, for the app's builder and the daemon's `catalogue show`.

    **Mutations.**

    - Make one required field optional, in the definition and the fixture together: CAT-a passes, and CAT-a2 must fail
      at that pointer. That is the case CAT-a2 exists for.
    - Add a `maxLength` to an unlimited string in the definition: CAT-a2's permissive probe must fail.
    - Remove `sorted-utf8` from labels: the invariant mutation must pass where it must not.
    - Drop `historyRecordId` from the Gmail key: D3-a must fail.

    **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`; `pnpm verify` must exit 0.

    **Commit.** `feat(events): the version-1 catalogue — seven event types, exactly Appendix A, held to a hand
    transcription (events phase A, task 11)`.

    **Done when.** The generated contract equals the transcription byte for byte. Both the generated JSON Schema and
    the zod schema state exactly the constraints extracted from the spec. Every example, declaration and fixture
    passes in Node, the realm, Chromium and WebKit.

**Batch 4 ends** with `pnpm verify` and `pnpm verify:browser`.

## Batch 5 — conditions, mapping and wire (tracks C and M in parallel)

### Track C

12. **Conditions: the deterministic tree, its sentence, and the agentic condition's static form.**

    **Files.** Create `packages/events/src/conditions/{types,canonicalise,legality,evaluate,describe,agentic}.ts`,
    `packages/events/test/conditions.test.ts`, `packages/events/test/vectors/conditions.json` and
    `test/realm/runners/conditions.ts`. Change the usual three.

    **Tests first.** Cover CND-a, CND-b, CND-c, CND-d, CND-g and CND-h.

    - **"CND-a: every operator on every legal type"**: a committed legality table (`conditions.json`, `legality`) of
      operator × field kind × format, from decision 15, checked against `canonicaliseCondition` over every concrete
      path of every catalogue type (one index per `any`). Every legal pair is evaluated true and false on an example
      or a mutation of one.
    - **"CND-b: every refused pairing"** from the same table, each with its issue code:
      - `domainIs` on a non-email and non-domain field;
      - an ordering comparison on a non-number, non-date field;
      - a string operator on a `date-time` field;
      - `contains` on an array of objects;
      - `caseSensitive: true` on a non-string or `date-time` field;
      - an operand outside its enum;
      - `null` on a non-nullable field;
      - an undeclared key, and an index token on an object.
    - **"CND-c: empty `all`, `any` and `in` are refused"**, and so are `in` with 257 values, depth 9, 65 nodes, and a
      1025-byte string operand. Each limit is also accepted at its exact bound. An `in` with a repeated value is
      accepted and kept as given (decision 15; amendment 4).
    - **"CND-d: a missing leaf is false, `not` is plain negation, `exists` is presence"**:
      - every operator on an absent optional field, and through a null parent, is false;
      - `not(equals(missing, x))` is true;
      - `exists` on a present `null` is true;
      - `contains` on a runtime `null` is false.
    - **"CND-g: invalid dates and subdomains"**:
      - a non-RFC 3339 date operand, and an operand with no offset, are refused at canonicalisation;
      - `domainIs` canonicalises `Bücher.Example` to `xn--bcher-kva.example`;
      - an invalid domain operand is refused;
      - `example.com` with `includeSubdomains: false` matches only `example.com`; with `true` it also matches
        `a.b.example.com` but never `badexample.com` or `example.com.evil.test`;
      - on an email field, it compares the domain part.
    - **"CND-h: omitted `caseSensitive` is explicit `false`"**: golden canonical JSON bytes for an authoring tree that
      omits it equal those for an explicit `false`, byte for byte, and differ from `true`. They run in Node, the realm,
      Chromium and WebKit.
    - Folding: an equality with `caseSensitive: false` compares `foldForComparison` (`STRASSE` equals `straße`); with
      `true` it is exact, without NFC (decision 15).
    - `describeCondition` sentences are golden for every operator. Operand text is rendered as canonical JSON, so a
      hostile operand cannot break the sentence.
    - `canonicaliseAgenticCondition` (decision 20):
      - It refuses a threshold that is a string, `NaN`, ±∞, `-0.01` or `1.01`; an input that is not a valid concrete
        pointer for the schema; a non-integer or non-positive `judgeVersion`; an `onUncertain` other than its two
        values; and a prefilter whose only leaves are account or type checks.
      - It accepts a `contains` leaf on `/subject`, adds `onUncertain: "no-match"`, and accepts thresholds 0 and 1.
      - As D5 states nothing more, it also accepts an empty `question`, an empty `inputs` and a repeated input
        (amendment 4).

    **Then the code.** The types, the canonicaliser (schema-aware through Task 9, formats through Task 7, folding
    through Task 5, domains through Task 6), the evaluator, the sentence and the agentic checks.

    **Mutations.** Propagate "missing" through `not`: CND-d must fail. Drop the default: CND-h must fail. Match a
    subdomain with `endsWith` and no dot: the `badexample.com` case must fail.

    **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`; `pnpm verify` must exit 0.

    **Commit.** `feat(events): deterministic conditions over the catalogue — pinned folding, exact instants, canonical
    domains — and the agentic condition's static checks (events phase A, task 12)`.

    **Done when.** The whole operator matrix, every refusal and every golden byte vector pass in Node, the realm,
    Chromium and WebKit.

### Track M

13. **Risky — Mapping, provenance, taint classification, representation and delivery schemas.**

    **Files.** Create `packages/events/src/mapping/{types,compile,evaluate,provenance,represent,delivery-schema}.ts`,
    `packages/events/test/mapping.test.ts`, `packages/events/test/vectors/mapping.json` and
    `test/realm/runners/mapping.ts`. Change the usual three.

    **Tests first.** Cover MAP-a, MAP-b, MAP-c, MAP-d, MAP-e, TNT-a and D3-c.

    - **"MAP-a: constants, objects, arrays and every missing policy"**:
      - nested templates;
      - a reference at the root, at an object property and at an array element;
      - each of `reject`, `null` and `omit` against present, absent-optional and null-parent paths;
      - a copied whole object and a copied array, with no aliasing (a mutation of the output never reaches the input);
      - refusals: `omit` at the root and at an array element; a `$path` object with a key other than `missing`; an
        unknown `missing`; an unresolvable pointer. Acceptance: an output key such as `$type`, which is an ordinary key
        (decision 16; amendment 3);
      - every limit at its bound and one past it: 200 leaves, a 4096-byte constant, a 262 144-byte result.
    - **"MAP-d: `omit` removes an object property and is refused at an array element and at the root; `reject` and
      `null` behave the same at all three"**, as golden vectors run in Node, the realm, Chromium and WebKit.
    - **"MAP-e: provenance through parent, object and array copies"**: copying `/from`, `/to`, `/to/0` and the root
      records the exact source pointer of each copy root, and expands to every descendant output pointer. Constants
      are `constant`; `missing: null` is `missing-null`.
    - **"TNT-a: addresses and handles follow their values, with the workspace"**. `classifyMapped`:
      - Gmail `/from/address` copied as a scalar, `/from` copied as a parent object, and `/to` as an array give every
        address at its exact output pointer;
      - Slack `/author/userId`, `/mentions` and the root give each handle with `workspace` taken from `/workspaceId`,
        even when `/workspaceId` was not copied;
      - untrusted strings come back with their text, for phase B1's free-text scan;
      - a constant inherits nothing;
      - a pattern that is an ancestor of the copy marks the whole copy.
    - **"MAP-b: both representations"**: `applyRepresentation` with `plain` leaves every value; with the synthetic
      envelope it replaces exactly the untrusted strings and nothing else (not addresses, not ids, not a `null`).
    - **"MAP-c: delivery schemas"**: golden schemas for a scalar map, a parent copy, a tuple array and each missing
      policy, under `plain` and `enveloped` (decision 17). Every example's mapped and represented `data` validates
      against its schema in ajv, and a value violating each generated keyword is refused.
    - **"D3-c: the delivery schema's `$id`"**: `deliverySchemaId` for ordinary and hostile ids
      (`rule:1/é`, spaces, `@`, `,`, an astral character) is
      `urn:agentcomms:schema:delivery:<pct>:v<n>:<pct>:v<n>`, with uppercase hex.

    **Then the code.** Compile, evaluate, provenance, classification, representation, the size check, the schema
    generator and the id.

    **Mutations.**

    - Intersect only exact pointers: a parent copy must lose its untrusted descendants, and TNT-a must fail.
    - Envelope a `null`: MAP-b must fail.
    - Let `omit` pass at an array element: MAP-d must fail.

    **Run.** `pnpm --filter @agentcomms/events test` should end with `# fail 0`; `pnpm verify` must exit 0.

    **Commit.** `feat(events): mapping templates with exact provenance, untrusted and address classification,
    both representations and delivery schemas (events phase A, task 13)`.

    **Done when.** Every copy's taint lands at its exact output pointer, and every vector passes in Node, the realm,
    Chromium and WebKit.

14. **Risky — The CloudEvents envelope, byte for byte, and the fixed test event.**

    **Files.** Create `packages/events/src/wire/{cloudevent,percent,untrusted-extension,test-event}.ts`,
    `packages/events/test/wire.test.ts`, `packages/events/test/vectors/envelopes.json`,
    `test/realm/runners/envelopes.ts` and the root `test/events-envelopes.test.mjs`. Change the usual three.

    **Tests first.** Cover MAP-f, MAP-g, MAP-h, MAP-i and D3-b.

    - **"MAP-h: one full-envelope byte vector for each of the seven types"**. Each vector names a catalogue example, a
      small template that copies at least one untrusted, one address and one id field, `plain` representation, a
      fixed delivery id, a synthetic installation id, a rule id and version, and a target id and version. It holds the
      expected envelope **as a hand-written JSON object** — `specversion` `"1.0"`; `id`; `source`
      `urn:agentcomms:<inst>:<account id>`; `type` `com.agentcomms.<type>.v1`; `time` exactly the example's
      `occurredAt`; `datacontenttype` `application/json`; `dataschema` the D3 id; the per-type `subject`;
      `agentcommsrule`; `agentcommsuntrusted` or its omission — and its exact canonical string.
      - The root test checks the string equals **core's** `canonicalJson` of the hand-written object, an independent
        oracle.
      - The package test checks `cloudEventBytes(buildCloudEvent(…))` equals the string, in Node, the realm,
        Chromium and WebKit.
      - A second string holds the UTF-8 hex, to catch an encoding slip.
    - **"MAP-i: a rule-defined type"**: `cloudEventType: "com.example.invoice.received"` replaces `type` exactly, with
      no prefix or suffix.
      - `validateCloudEventType` checks only what D6 says (decision 19). It refuses `""` and a non-string, and nothing
        else.
      - These values are accepted and each lands in `type` byte for byte: a single space, `é`, an astral character,
        1000 characters, `io.agentcomms.control.installation-reset.v1`, and a value with leading and trailing spaces,
        which is not trimmed.
      - Whatever amendment 1 might later add is not here.
    - **"MAP-f: `agentcommsuntrusted` is canonical"**:
      - several pointers are sorted by raw UTF-8 bytes, then percent-encoded and joined by commas;
      - a pointer holding `,`, `/`, `~1`, `é` or an astral character is encoded;
      - when `data` is itself an untrusted string, the extension is `""`;
      - with no untrusted pointer, the attribute is absent;
      - a pointer not in `data`, or not a string there, is refused.
    - **"MAP-g: source components are URI-escaped"**: `source` with an installation and an account id holding `:`,
      `/`, `%`, a space, `é` and an astral character, and `agentcommsrule` with a hostile rule id, use uppercase hex
      and RFC 3986's unreserved set exactly (decision 16). An unpaired surrogate is refused.
    - **"D3-b: the fixed test event"**: `TEST_CLOUD_EVENT_BYTES` is exactly
      `{"data":{"message":"agentcomms test event","synthetic":true},"datacontenttype":"application/json","id":"agentcomms-test-v1","source":"urn:agentcomms:test","specversion":"1.0","time":"2000-01-01T00:00:00Z","type":"io.agentcomms.test.v1"}`,
      which is the canonical JSON of D3's object (line 622). `JUDGE_TEST_INPUT` is
      `{ "synthetic": true, "message": "agentcomms test event" }`. Neither can be built through `buildCloudEvent`,
      because its type is refused.

    **Then the code.** `buildCloudEvent` validates its inputs (non-empty ids, positive integer versions, pointers
    present in `data`), derives `subject` and `time` from the event (decision 19), and returns the event;
    `cloudEventBytes` is `canonicalJson` of it.

    **Mutations.**

    - Take `time` from `observedAt`: the labelled vector still passes (they are equal) while every other one fails. The
      vectors must include both cases.
    - Sort after encoding: MAP-f must fail.
    - Use `encodeURIComponent`: MAP-g must fail on `!'()*`.
    - Trim `cloudEventType`, or refuse the `io.agentcomms.` value: MAP-i must fail.

    **Run.** `pnpm --filter @agentcomms/events test` and `node --test test/events-envelopes.test.mjs` should both end
    with `# fail 0`; `pnpm verify` must exit 0.

    **Commit.** `feat(events): the CloudEvents structured envelope, one exact byte vector per catalogue type, and the
    fixed test event (events phase A, task 14)`.

    **Done when.** The seven byte vectors pass against two independent canonicalisers, in Node, the realm, Chromium
    and WebKit.

**Batch 5 ends** when tracks C and M are merged and `pnpm verify` and `pnpm verify:browser` both pass.

## Batch 6 — integration

15. **The vector index, the API surface, the README and the last verify.**

    **Files.** Create `packages/events/test/api-surface.json` and `packages/events/test/api-surface.test.ts`. Change
    `packages/events/README.md`, `packages/events/test/consumer-check.mjs`, `packages/events/test/conformance.test.ts`
    and `packages/events/scripts/verify-browser.mjs`.

    **Tests first.** Cover ISO-c and BRW-d.

    - **"ISO-c: every family runs in Node and the realm"**: the conformance test lists the families it ran —
      `canonical-json`, `event-id`, `unicode`, `idna`, `formats`, `pointers`, `catalogue`, `resend-body`, `conditions`,
      `mapping` and `envelopes` — and fails if a vector file or a runner is unpaired.
    - **"BRW-d: every family runs in Chromium and WebKit"**: `verify-browser.mjs` checks the same eleven families, and
      the two Unicode conformance files, against that list, so a family added later cannot skip the browsers.
    - **"the export list is frozen"**: the sorted export names of `src/index.ts`, and of `dist/index.d.mts` after a
      build, equal `api-surface.json`, which is decision 4's table, flattened. A new export is a deliberate edit of that
      file.
    - The consumer check gains one assertion per area, in the installed tarball:
      - `caseFold('\uA7CB')`;
      - `toAsciiDomain('Bücher.example')`;
      - `CATALOGUE.length === 7`;
      - a canonicalised condition's bytes;
      - a mapping's untrusted pointers;
      - one envelope's bytes;
      - one event id, through the installed package's WebCrypto call;
      - `THIRD_PARTY_LICENSES` naming the Unicode licence.

    **Then the code.** The README: what the package is and is not (no I/O, no `node:`); the areas of the API with one
    example each; the pinned Unicode version and how to regenerate (`pnpm sync:unicode`); the data licence; Appendix A
    as the contract. It uses no flat account names (`scripts/verify-skills.mjs:418-440`).

    **Run.**

    - `pnpm verify` must exit 0, with `package verification OK: @agentcomms/events (…)` in its last stage.
    - `pnpm verify:browser` must print a pass line for every family in both browsers.
    - `node scripts/packages.mjs` must still print `core gmail gmail-mcp resend slack whatsapp`.
    - The grep from "How to use this plan" must list exactly the labels in the table below.

    **Commit.** `test(events): every vector family in Node, the realm, Chromium and WebKit, the export list frozen, and
    the README (events phase A, task 15)`.

    **Done when.**

    - Phase A's §5 rows are each covered by the task the table names.
    - `@agentcomms/events` is fully verified, and held.
    - Nothing was published or pushed.
    - The coordinator has the branch ready for review.

**Batch 6 ends** with the final `pnpm verify` and `pnpm verify:browser`.

## §5 coverage ownership

Each row is owned by exactly one task. A compound §5 bullet is split where its parts land in different tasks, or where
part of it belongs to another phase. Labels:

| Prefix | §5 item or source |
|---|---|
| `CAT` | "Catalogue, identity and pointer grammar" |
| `CND` | "Conditions and local tests" |
| `MAP` | "Mapping and wire" |
| `TNT` | "Taint" |
| `PKG` | "Parity, phases and packaging" |

The second table holds the obligations phase A owns outside §5:

| Prefix | Source |
|---|---|
| `D3`, `D5`, `D14` | the spec's sections |
| `A8` | Appendix A.8 |
| `REL` | decision 1 |
| `UNI` | decision 2 |
| `ISO`, `BRW` | decision 3 (and 23 for the WebCrypto exemption) |
| `CJ` | decision 11 |

| §5 item | Case owned | Task |
|---|---|---:|
| CAT-a | Generated JSON Schema for all seven definitions, canonical and key-sorted, equals the hand transcription of Appendix A byte for byte: required lists, null unions, enums, formats, `additionalProperties: false`, every metadata pattern | 11 |
| CAT-a2 | The generated JSON Schema and the zod schema state exactly the constraints extracted from the spec's text — strict probes for each, permissive probes against any invented one — so no fixture or implementation can bless an invented contract | 11 |
| CAT-b | Every example checked | 11 |
| CAT-c | Every semantic-format, address and handle declaration checked: legal for the schema, expanding only to the declared type | 11 |
| CAT-d | Pattern validation and expansion | 9 |
| CAT-e | `~0`, `~1`, root `""`, empty keys, numeric array indices, refused leading zeros and `-`, literal `*` | 9 |
| CAT-f | Copied parents, ancestors and descendants: the pointer relations provenance uses | 9 |
| CAT-g | Own-property handling of `__proto__`, `constructor` and `prototype` | 9 |
| CAT-h | Every known and unknown `agentcomms.*` type refused — at the library's catalogue lookup | 11 |
| CAT-i | The reset notice and `io.agentcomms.test.v1` are nonselectable control inputs — at the library's lookup | 11 |
| CAT-j | Event-id vectors: stable repeats, the same dedupe key in different accounts, every tuple component, exact preimages and ids, proven against core's hashing | 3b |
| CAT-k | The injected SHA-256 collision, as data, classified `collision` by the pure comparison (the daemon's cursor stop is B1's) | 3b |
| CAT-r1 | `safe.svg` accepts exactly `riskFlags: ["html-or-svg"]` | 11 |
| CAT-r2 | `safe\u200B.svg` keeps `hidden-characters-in-name` and canonicalises to `["hidden-characters-in-name", "html-or-svg"]` | 11 |
| CAT-r3 | `maxLength: 20000` asserted in Unicode code points | 11 |
| CAT-r4 | An over-20 000-code-point BMP body is capped with `bodyTruncated: true` | 11 |
| CAT-r5 | An exactly-20 000-code-point body has `bodyTruncated: false` | 11 |
| CAT-r6 | Astral-only input: two UTF-16 code units count as one schema character | 11 |
| CAT-r7 | A surrogate pair straddling the limit loses the trailing lone high surrogate, keeps `bodyTruncated`, meets the limit and emits no unpaired surrogate | 11 |
| CAT-r8 | An absent body has an absent flag; an orphan `body` or orphan `bodyTruncated` is rejected by the generated schema | 11 |
| CND-a | Every operator × legal schema type | 12 |
| CND-b | Every refused format and type pairing | 12 |
| CND-c | Empty `all`, `any` and `in` | 12 |
| CND-d | Every missing leaf false, plain `not`, and `exists` | 12 |
| CND-e | Unicode 15.1 folding vectors run in Node, the bare realm, Chromium and WebKit | 5 |
| CND-f | UTS #46 vectors run in Node, the bare realm, Chromium and WebKit | 6 |
| CND-g | Invalid dates and subdomains | 12 |
| CND-h | Golden vectors, run in Node, the bare realm, Chromium and WebKit: omitted `caseSensitive` canonicalises to explicit `false`, equals it byte for byte, and differs from `true` | 12 |
| MAP-a | Constants, objects and arrays, and every missing policy | 13 |
| MAP-b | Both representations | 13 |
| MAP-c | Generated delivery schemas | 13 |
| MAP-d | Golden vectors, run in Node, the bare realm, Chromium and WebKit: `omit` removes an object property and is refused at an array element and at the root; `reject` and `null` behave the same at all three | 13 |
| MAP-e | Provenance through parent, object and array copies | 13 |
| MAP-f | Canonical `agentcommsuntrusted`, including root | 14 |
| MAP-g | URI-escaped source components | 14 |
| MAP-h | Exactly one full-envelope byte vector for each of the seven catalogue types, asserting `specversion`, delivery id, source, the default type, `occurredAt` time, `application/json`, the D3 schema id, the per-type subject and the extension's omission or value | 14 |
| MAP-i | A separate rule-defined-type vector | 14 |
| TNT-a | Structured address and Slack-handle provenance through scalar, parent and object mappings, with workspace scope kept — the library's classification | 13 |
| PKG-a | Libraries publish in dependency order (the library half of "both kinds"; the service half is B1's) | 1 |
| PKG-b | An explicit library is the only surface-free published kind | 2 |
| PKG-c | No `"agentcomms"` non-channel kind | 1 |
| PKG-d | Browser import has no `node:` edge | 3a |

| Other obligation | Case owned | Task |
|---|---|---:|
| A8-a | The canonical machine-readable transcription of A.1–A.7 (A.8, line 4068), in decision 6's shape | 10 |
| A8-b | Every normative constraint of A.1–A.7 extracted by machine from the spec's text, with every comment and constraint-bearing sentence accounted for (A.8, line 4070) | 10 |
| A8-c | The transcription equals the extraction, constraint for constraint, with nothing extra and nothing missing | 10 |
| A8-d | The prose rules: every quote verbatim in the spec, every constraint-bearing sentence covered, invariants one to one, `informational` entries reviewed | 10 |
| D3-a | `subject` and `dedupeKey` per type, as Appendix A gives them, with Gmail's staging identity (decision 9) | 11 |
| D3-b | The exact `io.agentcomms.test.v1` bytes and the judge test input (D3, lines 620-623) | 14 |
| D3-c | The delivery schema `$id`, with percent-encoded ids (D3, lines 681-686) | 13 |
| D5-v | Conformance vectors for every legal format (D5, lines 1042-1044) | 7 |
| D14-a | Strict `kind: "library"` discovery; malformed declarations refused | 1 |
| D14-b | A library dropped into a repository copy is published in order, synced, consumer-checked, licensed and exempt from parity, with no list edited | 2 |
| D14-c | The release tests extended before `@agentcomms/events` becomes publishable (D14, lines 2740-2745) | 1 |
| REL-a | A held package is never read, proven, sent or confirmed by `pending`, the preflight, the publish or the confirm | 1 |
| REL-b | A held package is still version-synced, consumer-checked and licence-checked | 2 |
| REL-c | No released package depends at runtime on a held one; core is never held; malformed holds refused | 1 |
| REL-d | RELEASING.md and the release skill say what a hold is and how it is lifted | 2 |
| UNI-a | The generated tables are byte-identical to what pinned, size- and SHA-256-checked sources generate; drift refused | 4 |
| UNI-b | NormalizationTest 15.1, in Node, the realm, Chromium and WebKit | 5 |
| UNI-c | IdnaTestV2 15.1 `toAsciiN`, in Node, the realm, Chromium and WebKit | 6 |
| UNI-d | The Unicode licence in `THIRD_PARTY_LICENSES`, derived from the bundle graph | 4 |
| UNI-e | The host-divergence vector (U+A7CB) | 5 |
| ISO-a | No Node or DOM types; the syntax-tree guard over source, generated tables and `dist` | 3a |
| ISO-b | The bare realm (no host globals, no code generation) runs each vector family present identically to Node, and refuses an unpaired vector file | 3a |
| ISO-c | The final audit: the eleven families of phase A each run in Node and the realm | 15 |
| ISO-d | Only `src/identity/sha256.ts` reaches WebCrypto, and only `crypto.subtle.digest`; the realm is given nothing more | 3b |
| BRW-a | `pnpm verify:browser` runs every vector family in real Chromium and WebKit, under D13's production CSP from a loopback origin, with zero failures and results byte-identical to Node and the realm | 3c |
| BRW-b | The release's `publish` needs the `browser` job (`macos-latest`, Chromium and WebKit only, `pnpm verify:browser` only); the root `verify` does not run it | 3c |
| BRW-c | Without the browsers, `pnpm verify:browser` says how to install them once, and downloads nothing | 3c |
| BRW-d | The final audit: the eleven families and both Unicode conformance files each run in both browsers | 15 |
| CJ-a | Canonical JSON byte-identical to core's | 3a |

**§5 items next to phase A that it does not own.** Listed so the boundary can be audited:

| Item | Owner | Why |
|---|---|---|
| On a detected event-id collision, stopping without advancing the cursor | B1 | the function, its vectors and the collision's classification are phase A's (CAT-j, CAT-k, decision 23); what the daemon then does with its cursor is B1's |
| Rule `create`, `update` and `test` refusing `agentcomms.*` types | B1, B3 | they are operations; CAT-h is the library half |
| Operational records visible in doctor and the app, but creating nothing | B1 | |
| `rule test`, `rule test-retained`, `judge test`, `target test` | B3, E, B2 | |
| Exact `targetKey`s, SSE keys, Standard Webhooks and the `Content-Type` header | B1, B2 | |
| Recording taint, the origins sidecar, free-text address extraction | B1 | |
| Judge-input provenance | E | it reuses `classifyMapped` |
| Resend normalisation through the real `readBody` | D | it reuses Task 11's helpers |
| `kind: "service"`, `SURFACES`/`DRIVERS`, generated references, the fixture service | B1 | |
| The root verify's desktop side, and runs of the vectors inside the app's own webviews | C | phase A already runs them in Chromium and WebKit (BRW-a); C may add the app's webviews themselves |
| Retention defaults, digests, approvals, activation | B1 | |
