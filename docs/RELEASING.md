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

Only needed before the first publish of each package — and it does **not** run in the order you would guess.

The steady state is trusted publishing: npm mints a short-lived credential from the workflow's own identity, so no
long-lived token sits in repository secrets to leak or to go unrotated. But a trusted publisher is configured *on a
package*, and npm will not configure one for a package that does not exist yet. A brand-new scope therefore cannot
start at the steady state. The v0.1.0 attempt found this out the expensive way: the run reported
`Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE … 404`, then `E404 PUT /@cloudpixel%2fcomms-core`, which reads like a
misconfigured publisher and is in fact npm saying there is nothing here to publish *to*.

So the first publish is a bootstrap, and the token that does it is meant to be thrown away:

1. On npmjs.com, create the **`@cloudpixel`** organisation. Free tier covers unlimited public packages.
2. Generate a **granular access token** scoped to the `@cloudpixel` scope, permission *read and write*, with the
   shortest expiry offered. It has one job.
3. Add it as the repository secret **`NPM_TOKEN`** (Settings → Secrets and variables → Actions). The publish step
   already maps it to `NODE_AUTH_TOKEN`, and `setup-node`'s `registry-url` has already written the `.npmrc` that
   reads it.
4. Release as below. Provenance is unaffected by authenticating with a token — it comes from `id-token: write`.
5. **Now** configure trusted publishing on each of `@cloudpixel/comms-core`, `@cloudpixel/gmail`,
   `@cloudpixel/gmail-mcp`: repository `crissmoldovan/agent-communications`, workflow `release.yml`, environment
   `release`. npm does not validate any of those four strings when you save them — a typo surfaces only as a failed
   publish months later, so read them back.
6. Delete the `env:` block from the publish step and revoke the token. From the next version on there is no npm
   credential in this repository at all.

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

### When the publish fails and the fix is in `release.yml`

`gh run rerun` is the wrong tool, and it fails in the quiet direction: a re-run deliberately reuses the commit and
ref of the original event, so it re-reads the workflow file *from the tag*, not from `main`. Fix the workflow, watch
the re-run reproduce the identical failure, and the natural conclusion is that the fix was wrong.

Move the tag onto the commit that carries the fix instead — `git tag -f vX.Y.Z && git push --force origin vX.Y.Z` —
which is a fresh `push: tags` event and reads the new file. Force-moving a tag is only acceptable while nothing has
consumed it: before the first successful publish, with the GitHub release still a draft, nothing has. After a
version is on npm the tag is immutable evidence of what produced it; from then on, a broken release is fixed by
releasing X.Y.Z+1, never by moving X.Y.Z.

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
