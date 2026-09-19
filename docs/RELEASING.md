# Releasing

What a release takes, in the order it takes it, with the reasoning attached so a future release does not have to
rediscover it. Written after v0.1.0 was staged and the last three steps turned out to need credentials.

## Before anything

`main` must be green. The workflow re-verifies from scratch anyway, but finding out locally costs a minute and
finding out in CI costs ten:

```bash
pnpm verify
```

That runs lint → build → typecheck → test → skills → versions → licences → packed-tarball consumer checks.
**Build comes before typecheck deliberately:** the `gmail` package typechecks against `comms-core`'s emitted
declarations, and for a long time this ran the other way round — which passed on every machine that already had a
`dist` lying about and failed on a clean checkout with 235 `Cannot find module` errors. If you reorder it, you will
reintroduce that.

## One-time setup, per package

Only needed before the first publish of each package.

1. On npmjs.com, create the **`@cloudpixel`** organisation if it does not exist.
2. For each of `@cloudpixel/comms-core`, `@cloudpixel/gmail`, `@cloudpixel/gmail-mcp`, configure **trusted
   publishing**: repository `crissmoldovan/agent-communications`, workflow `release.yml`, environment `release`.

Trusted publishing rather than a token, because a long-lived npm token in repository secrets is a credential that
can leak and that nobody rotates. With this, npm mints a short-lived one from the workflow's own identity and every
published version carries provenance back to the run that built it.

## The release

```bash
# 1. The version, everywhere it is written down.
#    Edit the root package.json version, then:
pnpm sync:versions          # three manifests, two plugin files, the launcher, twelve skills
pnpm licenses               # regenerate THIRD_PARTY_LICENSES for the bundles
pnpm verify                 # --check runs of both are part of this

# 2. The changelog entry, written by a person. `## Unreleased` becomes `## X.Y.Z`.

# 3. Commit, then tag. The tag is what publishes.
git commit -am "release: vX.Y.Z"
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

The workflow then: verifies on six matrix legs (Ubuntu, macOS and Windows × Node 22.18 and 24), refuses if the tag
does not match the version the repository declares or if `sync-versions --check` fails, builds, runs the
packed-tarball consumer checks, and publishes the three packages **in dependency order** — a consumer installing
`@cloudpixel/gmail` must find the exact `comms-core` it pins already on the registry.

## Rehearsing without publishing

```bash
gh workflow run release.yml -f dry-run=true
```

Everything except the publish. Worth running before every release, and worth running after any change to the build:
it is the only thing here that installs from a genuinely clean checkout, and it has found four real bugs that
nothing else could — the build-order one above, a consumer check that parsed a half-written line when a response
spanned pipe chunks, a test running `/bin/sh` on Windows, and one asking whether a path contained `/` when it meant
"is absolute".

## After publishing

- `npm view @cloudpixel/gmail version` — confirm what actually went out.
- Install it somewhere clean and run it: `npx -y @cloudpixel/gmail@X.Y.Z --version`, then `doctor`.
- `npx skills add crissmoldovan/agent-communications --skill '*'` in a scratch directory, and check a skill carries
  its `references/`.
- Cut the GitHub release from the tag, with the changelog section as its body.

## What cannot be undone

npm keeps a published version for ever. The 72-hour unpublish window is not a fix once somebody has installed it,
and the name and version are burned either way. That is why the tag is the trigger rather than a push to `main`,
why the workflow re-verifies from a clean checkout rather than trusting the one that made the tag, and why the
dry run exists.
