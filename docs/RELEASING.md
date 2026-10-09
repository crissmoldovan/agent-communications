# Releasing

What a release takes, in the order it takes it, with the reasoning attached so a future release does not have to
rediscover it.

The mechanism is `scripts/release.mjs`; the working instructions are `.claude/skills/release/SKILL.md`. This page is
the why.

## Releases run in CI, and pushing the tag publishes them

Pushing a `v*` tag verifies the tagged commit on six platform legs and then publishes it. Nobody approves it in
between.

A required reviewer sat in front of that for one release and was removed. Not because the risk it named was
imaginary — **anything that can push a tag to this repository can publish to npm**, and this repository's own
software reads attacker-controlled email — but because the gate was opened on instruction every time it appeared.
A control that is always waved through is worse than no control: it reports a check nobody is performing, and the
documentation ends up describing a human in a loop they are not in.

What guards the release instead is stated rather than implied: the environment accepts `v*` tags and nothing else,
the tag must match the declared version and still name the commit the run started from, six platform legs must pass
before the publish job starts — and so must one more on exactly Node 22.12.0, the oldest the packages claim, which
runs the printed commands a source checkout's registration needs there and the held event service's built status
command through Node's SQLite module, and one on macOS that runs the event library's vectors plus loopback daemon
SSE/CORS in Chromium and WebKit (`pnpm verify:browser`) — and every version carries provenance naming the commit and
the workflow run that built it. If a bad version ever went out, that attestation is what makes it traceable.

Restoring the reviewer is one API call, and worth doing the day this repository has more than one maintainer or the
day an agent here starts acting on mail it did not fetch deliberately.

**No credential exists in this repository.** npm trusted publishing mints a short-lived one from the workflow's own
identity, so there is nothing to leak and nothing to rotate. **Do not replace it with a token.** A long-lived npm
token in a public repository is a standing risk nobody rotates, and it would also remove the reason CI is allowed
to publish at all.

### Why this was not always so

The first release of each package happened from a maintainer's laptop, because npm will not configure a trusted
publisher for a package that does not exist — so no CI workflow could have performed a first publish. For core,
gmail and gmail-mcp that was 0.1.0, and from 0.1.1 CI is the publisher. `@agentcomms/slack` was first published by
hand at 0.4.0, so it needs its own trusted publisher added once, by the package owner, before CI can publish it.
`@agentcomms/resend` and `@agentcomms/whatsapp` were first published by hand at 0.7.0 and are in the same position:
see [a new package's first version](#a-new-packages-first-version).

**Whether a package trusts this workflow cannot be read from outside.** npm's trust settings need an authenticated
owner (`npm trust list @agentcomms/<name>`, npm 11.15 or later, or npmjs.com → the package → Settings → Trusted
publishing), and the public packument only says how past versions were published. So the publish job proves it
instead — see [the preflight](#the-oidc-preflight) below.

The local path still exists in `scripts/release.mjs` and still works. It is the fallback, for the day GitHub is
down or a release cannot wait. What it gives up is provenance: npm attests only what a supported CI runner
published, so anything released from a laptop carries no attestation, and 0.1.0 does not.

### What has to be true

| | |
|---|---|
| The repository is public | npm refuses a provenance attestation for a private source repository, with a 422 that arrives only after the tarball is uploaded |
| A GitHub-hosted runner | a self-hosted one cannot issue an OIDC token npm accepts |
| Each package exists and names this workflow | npmjs.com → the package → Settings → Trusted publishing: repository, workflow file (`release.yml`), environment (`release`). npm does not validate those strings when you save them — the preflight is what reads them back. A package with no version yet cannot have one: [its first version is published by hand](#a-new-packages-first-version) |
| `id-token: write` on the publish job | without it there is no OIDC token to exchange |

### A new package's first version

npm keeps trusted publishers per package and will not configure one for a package that does not exist, so no
workflow can send a package's first version: a person does, once. The release finds out for you. When the registry
answers 404 for a package it is about to send, the OIDC preflight does not ask for an exchange that cannot work: it
prints `✗ @agentcomms/<name>: never published`, prints the command below for each such package with this run's commit,
and fails with nothing published. It still asks about every other package, so one run names everything in the way.

Let the tag's run get there. The preflight runs after all six verify legs have passed, so by then the commit is one
every platform accepted. Then:

1. **Publish the first version by hand, from the tagged commit.** In a checkout of exactly that commit, from the
   repository root, in a terminal — npm asks for a one-time password to create a package:

   ```bash
   git checkout vX.Y.Z
   pnpm install --frozen-lockfile && pnpm build
   pnpm --config.pnpmfile=scripts/record-git-head.cjs --filter @agentcomms/<name> publish --access public --no-git-checks --tag latest
   ```

   `--tag next` for a prerelease; the preflight's own line already says which. This version carries no provenance,
   because npm attests only what CI published. That is the cost of the first version, and of nothing after it.
2. **Add its trusted publisher**: npmjs.com → the package → Settings → Trusted publishing — this repository,
   `release.yml`, environment `release`.
3. **Re-run the failed job.** The hand-published version records the tagged commit as its `gitHead`, so the run skips
   it, proves and publishes the rest, confirms them all and makes the release page.

**Use that command, not `npm publish`.** It is the publish the workflow and `scripts/release.mjs` run, for one
package: pnpm rewrites the `workspace:` and `catalog:` specifiers, and the hook records the commit. `npm publish` in
`packages/<name>` leaves those specifiers in the published manifest, and records `gitHead` only where `.git` is a
directory, so from a git worktree it records nothing. The release refuses a version with no commit recorded, and a
version cannot be sent twice, so that one mistake would end the release at that version.

**Why not before the tag.** Published by hand first, the package is out before the Windows and Linux legs have run.
If one of them then fails, the fix is a new commit, the package is already out at that version from the old one, and
every package moves to the next version. After the preflight, nothing can fail the commit any more.

Every channel depends at runtime on exactly the same-version `@agentcomms/core` — pnpm packs its `workspace:*` edge to
that version — so core is packed and published before every channel: `scripts/packages.mjs` puts it first, and the
workflow, `scripts/release.mjs` and `pnpm verify:packages` all follow that order. No channel's version installs until
its core's is on the registry, a first version included: published by hand from the tagged commit, it waits, as
`gmail-mcp` waits for `gmail`, until the re-run has published core at that version. So re-run straight away.

## The packages

**One list, in `scripts/packages.mjs`, in two widths.** `PACKAGES` is what a tag publishes: `core`, `gmail`,
`gmail-mcp`, `resend`, `slack`, `whatsapp`, in that order, and what `node scripts/packages.mjs` prints. `PUBLISHABLE`
is every package this repository publishes, in the same order — `PACKAGES` and any package
[held back from release](#a-package-held-back-from-release). Both are derived from the packages' own manifests
(`scripts/channels.mjs`), in an order computed from their dependencies, so a new channel or library is on them by
being a package that declares itself. The workflow's publish and confirm loops, the OIDC preflight and
`scripts/release.mjs` read `PACKAGES`; `scripts/sync-versions.mjs`, `pnpm verify:packages` and the licence notices
walk `PUBLISHABLE`, so a held package is still proven publishable. `test/release-packages.test.mjs` fails if a
publishable package is missing, if the order puts a package before one it depends on, or if any of those stops
reading its list. There used to be a copy in each; 0.4.0 shipped without Slack because one of them said three.

## The order, and why it is that order

```bash
# 1. The version, everywhere it is written down.
pnpm sync:versions          # every package manifest, two plugin files, the launcher, every skill's compatibility line
pnpm build && pnpm run licenses # third-party notices, read from what each bundle actually contains

# 2. The changelog entry, written by a person. `## Unreleased` becomes `## X.Y.Z`. The tag gate refuses a version
#    with no section, and the GitHub release is made from it.

# 3. Commit and push. What is published must be what anyone else can read.

# 4. Rehearse locally. Finding a problem here costs a minute; finding it in CI costs ten.
pnpm release                # every check, then stops before sending anything

# 5. Tag, and push the tag. This publishes: once the six verify legs and the OIDC preflight pass, the packages go
#    out, and nothing asks first.
git tag vX.Y.Z && git push origin vX.Y.Z

# 6. Watch it. Six verify legs, the OIDC preflight, the publish, the registry check, then the GitHub release.
```

**The tag now comes before the publish, because it is what starts it** — the reverse of the local flow, where the
tag recorded something already done. A tag whose run has finished without publishing anything names a release that
did not happen; move it to the fix, or delete it, rather than leave it implying otherwise. That is not hypothetical:
v0.1.2 was tagged, failed on Windows, published nothing, and the tag had to move.

**Never move or delete a tag while its run is in progress.** Cancel the run first, or let it finish. A run builds the
commit its tag named when it started, however long ago that was, and a run still in its verify legs has published
nothing either — so a tag moved to a fix then used to leave that run to publish every package from the old commit and
make its GitHub release on the new one, green, while the run for the fix was refused afterwards. Now the run asks
origin whether the tag still names the commit it started from three times: just before the OIDC preflight, again just
before the first publish, and before making the GitHub release. At whichever finds the tag moved or gone, it stops,
naming both commits. The run the move started waits for it to end, because the workflow runs one release per tag at a
time. So a move while the verify legs run costs the first run and nothing else. A move after the last check before
the first publish is too late: the packages go out from the old commit, the run fails at the release page rather than
hang it on the new one, and the moved tag's own run refuses the version. The way out then is to put the tag back and
re-run the failed job.

**Once any package is out, the tag must not move.** What went out was built from the commit the tag names, and a
run on any other commit refuses to finish that version — see
[if a publish fails part way through](#if-a-publish-fails-part-way-through).

**A prerelease publishes under `next`, not `latest`.** npm moves `latest` on every publish that does not name
another tag, so a `v0.1.4-rc.1` tag would have made a release candidate the version `npm i @agentcomms/gmail`
installs — for everybody, immediately. The workflow reads the tag and passes `--tag next` for any version with a
hyphen in it. `scripts/release.mjs` has always accepted a prerelease string, so the two used to disagree about
what a `-rc.1` meant.

**The packages publish in dependency order** — the order of `scripts/packages.mjs` — because a consumer installing
`@agentcomms/gmail` must find the exact `core` it pins already on the registry.

### The OIDC preflight

Before anything is published, the publish job does for every package it is about to send what the publish itself
will do, minus the publish: it asks GitHub for an ID token with the audience `npm:registry.npmjs.org` and POSTs it to
`/-/npm/v1/oidc/token/exchange/package/@agentcomms%2f<name>`. npm answers with a short-lived publish token only if
that package names this repository, `release.yml` and the `release` environment as its trusted publisher. The token
is checked for and dropped — never printed, never kept — and nothing is sent. If any package is refused, the run
fails there, naming it, with nothing published. (`scripts/release-ci.mjs preflight`.)

A package already at this version from this commit is not asked about: it will not be sent again, so its trust
proves nothing. When every package is — a re-run after the last one landed, or the tag pushed after a local
`pnpm release:publish` — the preflight passes with nothing to prove. That matters most exactly when the local
fallback gets used: while a package has no trusted publisher yet, exchanging for it anyway failed the tag run and
skipped the GitHub release, for a version that was already on npm.

A package the registry has never heard of is not asked about either: npm cannot trust a workflow for it, so the
preflight says it was never published, prints its first publish, and fails — see
[a new package's first version](#a-new-packages-first-version).

Without it, a package with no trusted publisher fails late and quietly: pnpm prints only "Skipped OIDC", falls back
to a registry token this workflow does not have, and that one publish is refused — after the packages before it in
the list have gone out. Slack was last in the list at 0.4.0, so that is exactly how a first CI release of it would
have gone; at 0.7.0 `resend`, first published in that release, comes after three packages that would already have
been sent.

**`pnpm verify` runs build before typecheck, deliberately.** The `gmail` package typechecks against `core`'s
emitted declarations. For a long time this ran the other way round, which passed on every machine that already had a
`dist` lying about and failed on a clean checkout with 235 `Cannot find module` errors. If you reorder it, you will
reintroduce that.

**The release asks the registry what arrived** — for up to ten minutes, because the read path lagged four minutes
behind the publish at 0.4.0 and the old five-minute budget was nearly spent on releases that succeeded — rather than
trusting the publish command's exit code. `pnpm --filter`
exits 0 when it matches nothing — "No projects matched the filters" is not an error — so a renamed package or a
changed scope would publish fewer packages than the hardcoded list claims and still finish green. The first person
to find out would be a consumer whose install of `gmail-mcp` cannot resolve the `gmail` it pins. It asks for the
commit each version records, not only the version, because the GitHub release waits for it: a package at the right
version from any other commit fails the run there, at once, and gets no release page.

## A package held back from release

A package this repository publishes can be left out of the releases before its first one: it says so in its own
`package.json`, as `"agentcommsRelease": { "hold": "<why, one sentence>" }`. A new library arrives that way — the
event library of the [event-emission design](superpowers/specs/2026-10-05-local-event-emission-design.md) does —
because the first version of a package cannot come from the workflow: the next tag after it landed, perhaps an
unrelated patch, would stop for the owner to publish by hand a public API nothing yet uses.

**What still checks it.** A held package is still built, version-synced, licence-checked and consumer-checked by every
`pnpm verify`, on every release leg: it is in `PUBLISHABLE`, which those checks walk. It is left out of the release:
`PACKAGES`, which the workflow's publish and confirm loops, the OIDC preflight and `scripts/release.mjs` read, does not
name it, so a release never reads it from the registry, proves it, sends it or confirms it. The registry
(`scripts/channels.mjs`) refuses a hold on core, on a private package and on one that declares nothing, and
`test/release-packages.test.mjs` fails `pnpm verify` while a package a tag publishes depends at runtime on a held one.
So the release of the first package that does cannot go out with the hold still in place.

**Lifting the hold**, in the version commit of the first release that ships a package depending on it at runtime — or
earlier, if the owner decides to publish it on its own:

1. In that release's version commit, delete `agentcommsRelease` from the package's `package.json`, and say in the
   changelog entry what the package is.
2. Tag and push as usual. After every verify leg passes, the OIDC preflight stops with
   `✗ @agentcomms/<name>: never published`, prints the hand publish for the tagged commit, and sends nothing.
3. The owner runs it in a terminal, in a checkout of the tag after `pnpm install --frozen-lockfile && pnpm build`
   (npm asks for a one-time password to create a package):
   `pnpm --config.pnpmfile=scripts/record-git-head.cjs --filter @agentcomms/<name> publish --access public --no-git-checks --tag latest`.
4. The owner adds its trusted publisher on npmjs.com → the package → Settings → Trusted publishing: this repository,
   `release.yml`, environment `release`.
5. Re-run the failed job. It finds the package at that version from the tagged commit, skips it, publishes the rest,
   confirms all of them and makes the release page.

Steps 3 and 4 need the owner's npm account; an agent cannot do them. They are
[a new package's first version](#a-new-packages-first-version), reached by lifting the hold.

### The held event library and daemon

`@agentcomms/events` and `@agentcomms/events-daemon` are both held throughout B1 and B2. A B1 or B2 merge publishes
neither package: both remain in `PUBLISHABLE` for builds, licences, version synchronisation and packed-tarball consumer
checks, but neither is in `PACKAGES`, so the release preflight, publish and confirmation paths do not read their
packuments.

The B2 runtime's loopback daemon SSE/CORS check runs with the event-library browser vectors in the separate macOS
browser gate. It remains a release requirement while the packages are held; it is not a publish surface or a reason to
lift either hold.

When the owner decides to release the first daemon consumer, they remove both holds in one normal version/release
commit and tag it only after the complete release checks pass. From that same checked tag, the owner first publishes
`@agentcomms/events`, then publishes `@agentcomms/events-daemon` with the same checked tag and command form. The order
is required: the daemon pins its runtime dependency on the library to exactly that version. The owner then configures
trusted publishing for each package and re-runs the tagged release, as [a new package's first
version](#a-new-packages-first-version) describes. Use `next`, rather than `latest`, for a prerelease.

## If a publish fails part way through

The packages that already went out are on the registry permanently, and a version can never be replaced.

**In CI, when the cause was outside the repository, re-run the failed job at the same version.** An npm or network
error, or a trusted publisher the owner has since added: nothing in the commit has to change. A re-run keeps the
tagged commit, and the publish skips a package only when the registry records that it was published from that very
commit, so the re-run sends only what is missing, then confirms all of them and makes the GitHub release. This used
to be impossible — the re-run stopped at `core` with "cannot publish over previously published version" — and the
only way forward was to burn a version number.

**When the fix needs a commit, release a new version; the tag must not move.** A re-run cannot carry a fix: it runs
the commit and the workflow it started with. Moving the tag to the fix used to go green — the run skipped the
packages already out, built from the old commit, and published the rest from the new one, one version made of two
builds with provenance naming both. Now `scripts/release-ci.mjs pending` reads the commit the registry recorded for
each package at that version and refuses the run, naming each one and where it came from, before anything is sent.

The commit is the version's `gitHead`. `npm publish` records it; pnpm does not, so every publish, from CI or from
`scripts/release.mjs`, goes through `scripts/record-git-head.cjs`, which adds it, and `pnpm verify:packages` packs
with the same hook and fails if the field is missing. A version with no commit recorded — published by hand, say —
cannot be matched to the tag, so the run refuses it too.

**With the local script, bump the version.** `scripts/release.mjs` still refuses a version any package already has,
and prints which packages it managed to send at the point of failure, because that list is the only record of which
half of the release exists.

## What the verify actually proves

`pnpm verify` is lint → build → typecheck → test → skills → versions → licences → reference pages → CLI and MCP
parity → **packed-tarball consumer checks**.

That last stage is the one worth protecting. It packs each package exactly as it will be published, installs the
tarball into a fresh project with its own npm cache, and runs it there. It is the only thing that catches a missing
file, a wrong export map, an undeclared dependency or a broken bin — none of which the source tests can see, because
they import from `src/`.

## After publishing

- `npm view @agentcomms/<name> version` for each package in `scripts/packages.mjs` — confirm what actually went out.
- `npx -y @agentcomms/<name>@X.Y.Z --version` for `core`, `gmail`, `slack`, `resend` and `whatsapp`, then `doctor`
  for each but WhatsApp, and `status` for it, somewhere that is not this repository. `whatsapp` needs Node 22.16 or
  newer.
- `npx skills add crissmoldovan/agent-communications --skill '*'` in a scratch directory; check a skill brought its
  `references/` with it.
- The GitHub release is made by the workflow's `github-release` job, from the changelog section, once the registry
  has confirmed every package. A re-run leaves an existing release alone. After a local `pnpm release:publish`,
  push the tag on the commit it published — the script prints the command — and the run finds every package already
  out from that commit, publishes nothing, proves nothing, confirms and makes the release. On any other commit it
  refuses.

## Do not run agents in this checkout during a release

Subagents share the working tree. One reading history with `git checkout` will move the branch under you, and a
release that starts on `main` can finish somewhere else — this has happened. Give them worktree isolation, or wait
until the release is done.
