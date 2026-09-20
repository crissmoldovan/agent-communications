---
name: release
description: Use when publishing this repository's packages to npm, cutting a version, or asked to "do a release" — pushing a v* tag publishes from CI with provenance, and that push is the irreversible step
---

# Releasing agent-communications

Three packages go to npm together: `@agentcomms/core`, `@agentcomms/gmail`, `@agentcomms/gmail-mcp`, in dependency
order. **Pushing a `v*` tag publishes them.** That push is the irreversible act; there is no confirmation after it.

## The one thing to understand first

**npm keeps a published version for ever.** The 72-hour unpublish window is not a fix once somebody has installed
it, and the name and version are burned either way. There is no rollback. A bad release is corrected by publishing
a *higher* version, never by replacing the one that went out.

Everything below follows from that.

## Who publishes, and what approves it

CI, via npm trusted publishing — a short-lived credential minted from the workflow's own identity. No token is
stored anywhere, and none should be added: a long-lived npm token in a public repository is a standing risk nobody
rotates.

The publish job runs in the `release` environment, which accepts `v*` tags and nothing else. A required reviewer
sat in front of it for one release and was removed: it was opened on instruction every time, and a gate that is
always waved through reports a check nobody performs. **Anything that can push a tag here can publish to npm** —
that is the trade, and it is written down in `docs/RELEASING.md` rather than implied.

**`scripts/release.mjs` still works and is the fallback**, for when GitHub is down or a release cannot wait. What it
gives up is provenance: npm attests only what a supported CI runner published. 0.1.0 went out that way and carries
no attestation, because npm will not configure a trusted publisher for a package that does not exist — so no
workflow could have done the first publish. That is spent; from 0.1.1 CI is the publisher.

## Procedure

1. **Check nothing is already published at this version.** `scripts/release.mjs` does it, but knowing early is
   worth more than being told late.
   **Complete when:** `npm view @agentcomms/gmail@<version> version` returns nothing for the version you intend.

2. **Get the version right everywhere.** Edit the root `package.json`, then `pnpm sync:versions` — it writes three
   manifests, two plugin files, the launcher and twelve skills. `pnpm run licenses` regenerates the third-party notices
   that ship inside the bundles.
   **Complete when:** `pnpm verify:versions` and `pnpm verify:licenses` both pass.

3. **Write the changelog entry yourself.** `## Unreleased` becomes `## X.Y.Z`. This is the one artefact a person
   writes, because it is the only one addressed to a reader rather than a machine.
   **Complete when:** the entry says what changed in terms a user would recognise, not in terms of commits.

4. **Commit and push, on `main`.** What is published must be what anyone else can read.
   **Complete when:** `git status` is clean and local `main` and `origin/main` are the same commit.

5. **Rehearse locally.** `pnpm release` runs every check and stops before sending anything. A minute here beats ten
   in CI.
   **Complete when:** it prints that everything a release checks has passed.

6. **Tag, and push the tag. This publishes.** `git tag vX.Y.Z && git push origin vX.Y.Z`. Six verify legs run
   first and the publish is skipped if any fails, but nothing asks for confirmation after the push.
   **Complete when:** the run's own registry check reports all three at the new version. It asks the registry what
   arrived rather than trusting the publish command, because `pnpm --filter` exits 0 when it matches nothing.

   **If a leg fails, nothing is published** and the tag names a release that did not happen — move it to the fix
   rather than leaving it. v0.1.2 did exactly this: green on macOS and Linux, broken on Windows by an absolute
   path handed to a dynamic `import`, which only the tag workflow could catch.

   **If it says a package "is not visible yet", do not bump the version.** `npm view` reads a CDN-cached document
   that can lag minutes behind a successful publish. Run `npm dist-tag ls @agentcomms/<name>`, which goes to the
   authenticated path. If that reports the version, the publish landed.

8. **Prove it from outside.** `npx -y @agentcomms/gmail@X.Y.Z --version`, then `doctor`, in a directory that is not
   this repository. Then `npx skills add crissmoldovan/agent-communications --skill '*'` in a scratch directory and
   check a skill brought its `references/` with it.
   **Complete when:** the published artefact has been run by something that did not build it.

9. **Cut the GitHub release** from the tag, with the changelog section as its body. Leave the development-phase
   notes out: two of them say "nothing to install yet", which is false in a release announcement.

## What the workflow refuses, and why

| Refusal | Why it matters |
|---|---|
| The tag does not match the declared version | a half-renamed release is discovered by consumers |
| `sync-versions --check` fails | the version is written in fourteen places and they must agree |
| The repository is private | npm rejects a provenance attestation for a private source repo, with a 422 that arrives after the upload |
| A package is not visible after publishing | `pnpm --filter` exits 0 when it matches nothing |

## What the fallback script refuses, and why

Only relevant when releasing locally with `scripts/release.mjs`.

| Refusal | Why it matters |
|---|---|
| Uncommitted changes | A release must be a commit that exists, not a state of somebody's disk. |
| Not on `main` | The published tree should be the one people can read. |
| Local `main` ≠ `origin/main` | Otherwise what was published cannot be reconstructed from the repository. |
| A manifest version disagreeing with the root | Half-renamed releases are discovered by consumers. |
| Not logged in to npm | Naming the failure beats a 401 from three publishes in a row. |
| The version already on the registry | Finding this now is far better than finding it after one package has gone. |

`--skip-verify` exists for the case where `pnpm verify` has *just* passed in this same tree. Reach for it rarely:
the verify is the only step that installs each packed tarball into a throwaway project and runs it, which is what
catches a missing file, a wrong export, an undeclared dependency or a broken bin — none of which the source tests
can see.

## If a publish fails part way through

The packages that went out are **on the registry for good**. Do not retry the same version: bump it and release
again. The script says so at the point of failure and lists what it managed to send, because that list is the only
thing that tells you which half of the release exists.

## Pitfalls

- **Treating the tag as the release.** The tag starts the workflow; the approval publishes. A tag whose job was
  never approved names a release that did not happen — delete it rather than leave it implying otherwise.
- **Retrying a failed release at the same version.** The successful half cannot be replaced.
- **Trusting the publish command's exit code.** Ask the registry, and give it time to answer.
- **Adding an npm token so CI "just publishes".** It already publishes, through OIDC, with nothing stored. A token
  would add a standing credential to a public repository *and* remove the approval that keeps a person in the loop.
- **Reading "not visible yet" as a failed publish.** It is usually CDN lag. Check `npm dist-tag ls` first.
- **Running the release while agents are working in this checkout.** They share the working tree and can change
  branches under you. Give them worktree isolation, or do not run them during a release.

## Verification

- [ ] The changelog entry was written by a person.
- [ ] `pnpm release` passed locally before the tag was pushed.
- [ ] `pnpm verify` passed locally, on this platform, before the tag was pushed — knowing that green here is not green on Windows.
- [ ] The registry confirms all three packages at the new version.
- [ ] The tag names the commit the workflow actually published.
- [ ] The published package was installed and run somewhere that is not this repository.
