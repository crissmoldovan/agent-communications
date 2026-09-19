# Releasing

What a release takes, in the order it takes it, with the reasoning attached so a future release does not have to
rediscover it.

The mechanism is `scripts/release.mjs`; the working instructions are `.claude/skills/release/SKILL.md`. This page is
the why.

## Releases are run from a person's machine

Not from CI. Pushing a tag runs the checks and nothing else: `.github/workflows/release.yml` has no publish step and
no credential, and should not be given one.

The reason is that publishing cannot be undone. npm keeps a version for ever — the 72-hour unpublish window is not a
fix once somebody has installed it, and the name and version are burned either way. A step like that belongs where a
person can watch it happen, not in something that fires when a tag appears.

**What this costs: provenance.** npm can only attest a package published by a supported CI runner, so versions
released this way carry no attestation. Nobody installing can cryptographically verify which commit and which
workflow built the tarball; they have the repository and the maintainer's word. That is a real loss for a package
whose central claim is that an agent cannot send mail without approval, and it is given up knowingly rather than
overlooked.

The tempting fix — put an npm token in repository secrets and publish from Actions — is a worse trade. A long-lived
credential in a public repository is a standing risk that nobody rotates, and it buys an attestation *about*
supply-chain integrity at the cost of a real hole *in* it. If this is ever revisited, the route is npm **trusted
publishing**, which mints a short-lived credential from the workflow's own identity and stores no secret at all. It
has one catch worth writing down, because learning it cost a wasted release attempt: npm will not configure a
trusted publisher for a package that does not exist yet, so it can never perform a package's *first* publish.

## The order, and why it is that order

```bash
# 1. The version, everywhere it is written down.
pnpm sync:versions          # three manifests, two plugin files, the launcher, twelve skills
pnpm licenses               # third-party notices that ship inside the bundles

# 2. The changelog entry, written by a person. `## Unreleased` becomes `## X.Y.Z`.

# 3. Commit and push. What is published must be what anyone else can read.

# 4. Rehearse, then publish.
pnpm release                # every check, then stops before sending anything
npm login                   # a credential action: a person does this, never a script
pnpm release:publish

# 5. Tag AFTER the publish succeeded.
git tag vX.Y.Z && git push origin vX.Y.Z
```

**The tag comes last.** A tag is a claim that a version was released. Tagging first produces a tag that may name a
release which never happened — and since the checks workflow keys on tags, it would advertise a green build for
something nobody can install.

**The packages publish in dependency order** — `comms-core`, then `gmail`, then `gmail-mcp` — because a consumer
installing `@agent-communications/gmail` must find the exact `comms-core` it pins already on the registry.

**`pnpm verify` runs build before typecheck, deliberately.** The `gmail` package typechecks against `comms-core`'s
emitted declarations. For a long time this ran the other way round, which passed on every machine that already had a
`dist` lying about and failed on a clean checkout with 235 `Cannot find module` errors. If you reorder it, you will
reintroduce that.

**The release asks the registry what arrived** rather than trusting the publish command's exit code. `pnpm --filter`
exits 0 when it matches nothing — "No projects matched the filters" is not an error — so a renamed package or a
changed scope would publish fewer packages than the hardcoded list claims and still finish green. The first person
to find out would be a consumer whose install of `gmail-mcp` cannot resolve the `gmail` it pins.

## If a publish fails part way through

The packages that already went out are on the registry permanently. **Do not retry the same version.** Bump it and
release again. The script prints which packages it managed to send at the point of failure, because that list is the
only record of which half of the release exists.

## What the verify actually proves

`pnpm verify` is lint → build → typecheck → test → skills → versions → licences → **packed-tarball consumer checks**.

That last stage is the one worth protecting. It packs each package exactly as it will be published, installs the
tarball into a fresh project with its own npm cache, and runs it there. It is the only thing that catches a missing
file, a wrong export map, an undeclared dependency or a broken bin — none of which the source tests can see, because
they import from `src/`.

## After publishing

- `npm view @agent-communications/gmail version` — confirm what actually went out.
- `npx -y @agent-communications/gmail@X.Y.Z --version`, then `doctor`, somewhere that is not this repository.
- `npx skills add crissmoldovan/agent-communications --skill '*'` in a scratch directory; check a skill brought its
  `references/` with it.
- Cut the GitHub release from the tag, with the changelog section as its body.

## Do not run agents in this checkout during a release

Subagents share the working tree. One reading history with `git checkout` will move the branch under you, and a
release that starts on `main` can finish somewhere else — this has happened. Give them worktree isolation, or wait
until the release is done.
