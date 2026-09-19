# Releasing

What a release takes, in the order it takes it, with the reasoning attached so a future release does not have to
rediscover it.

The mechanism is `scripts/release.mjs`; the working instructions are `.claude/skills/release/SKILL.md`. This page is
the why.

## Releases run in CI, and a person approves them

Pushing a `v*` tag verifies the tagged commit on six platform legs, then **waits**. The `release` environment
requires a named reviewer, so the publish job sits there until somebody approves it in GitHub. Pushing a tag is not
a release; approving one is.

That distinction carries weight here. An agent can push a tag. The package being published is the one promising
that an agent cannot act without the person, and it would be a poor advertisement if the thing making that promise
could ship itself.

**No credential exists in this repository.** npm trusted publishing mints a short-lived one from the workflow's own
identity, so there is nothing to leak and nothing to rotate. **Do not replace it with a token.** A long-lived npm
token in a public repository is a standing risk nobody rotates, and it would also remove the reason CI is allowed
to publish at all.

### Why this was not always so

The first release of each package happened from a maintainer's laptop, because npm will not configure a trusted
publisher for a package that does not exist — so no CI workflow could have performed a first publish. That
chicken-and-egg is spent: the registry now knows all three, each names this workflow as its trusted publisher, and
from 0.1.1 onward this is the publisher.

The local path still exists in `scripts/release.mjs` and still works. It is the fallback, for the day GitHub is
down or a release cannot wait. What it gives up is provenance: npm attests only what a supported CI runner
published, so anything released from a laptop carries no attestation, and 0.1.0 does not.

### What has to be true

| | |
|---|---|
| The repository is public | npm refuses a provenance attestation for a private source repository, with a 422 that arrives only after the tarball is uploaded |
| A GitHub-hosted runner | a self-hosted one cannot issue an OIDC token npm accepts |
| Each package names this workflow | npmjs.com → the package → Settings → Trusted publishing: repository, workflow file, environment. npm does not validate those strings when you save them, so read them back |
| `id-token: write` on the publish job | without it there is no OIDC token to exchange |

## The order, and why it is that order

```bash
# 1. The version, everywhere it is written down.
pnpm sync:versions          # three manifests, two plugin files, the launcher, twelve skills
pnpm run licenses               # third-party notices that ship inside the bundles

# 2. The changelog entry, written by a person. `## Unreleased` becomes `## X.Y.Z`.

# 3. Commit and push. What is published must be what anyone else can read.

# 4. Rehearse locally. Finding a problem here costs a minute; finding it in CI costs ten.
pnpm release                # every check, then stops before sending anything

# 5. Tag. This starts the workflow; it does not publish.
git tag vX.Y.Z && git push origin vX.Y.Z

# 6. Approve the waiting job in GitHub. That is the publish.
```

**The tag now comes before the publish, because it is what starts it** — the reverse of the local flow, where the
tag recorded something already done. The claim a tag makes is still only made true by the approval that follows, so
a tag whose job was never approved names a release that did not happen. If that occurs, delete the tag rather than
leaving it to imply otherwise.

**The packages publish in dependency order** — `core`, then `gmail`, then `gmail-mcp` — because a consumer
installing `@agentcomms/gmail` must find the exact `core` it pins already on the registry.

**`pnpm verify` runs build before typecheck, deliberately.** The `gmail` package typechecks against `core`'s
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

- `npm view @agentcomms/gmail version` — confirm what actually went out.
- `npx -y @agentcomms/gmail@X.Y.Z --version`, then `doctor`, somewhere that is not this repository.
- `npx skills add crissmoldovan/agent-communications --skill '*'` in a scratch directory; check a skill brought its
  `references/` with it.
- Cut the GitHub release from the tag, with the changelog section as its body.

## Do not run agents in this checkout during a release

Subagents share the working tree. One reading history with `git checkout` will move the branch under you, and a
release that starts on `main` can finish somewhere else — this has happened. Give them worktree isolation, or wait
until the release is done.
