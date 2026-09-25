---
name: release
description: Use when publishing this repository's packages to npm, cutting a version, or asked to "do a release" — pushing a v* tag publishes from CI with provenance, and that push is the irreversible step
---

# Releasing agent-communications

Every package in `scripts/packages.mjs` goes to npm together, in that order — today `@agentcomms/core`,
`@agentcomms/gmail`, `@agentcomms/gmail-mcp` and `@agentcomms/slack`. That file is the one list: the workflow, the
local script, `sync-versions` and `verify:packages` all read it, and a test fails if a publishable package is missing.
**Pushing a `v*` tag publishes them.** That push is the irreversible act; there is no confirmation after it.

## The one thing to understand first

**npm keeps a published version for ever.** The 72-hour unpublish window is not a fix once somebody has installed
it, and the name and version are burned either way. There is no rollback. A bad release is corrected by publishing
a *higher* version, never by replacing the one that went out.

Everything below follows from that.

## Who publishes, and what can start it

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
workflow could have done the first publish. From 0.1.1 CI is the publisher for core, gmail and gmail-mcp.
`@agentcomms/slack` was first published by hand at 0.4.0 and needs its own trusted publisher, which only the package
owner can add (npmjs.com → the package → Settings → Trusted publishing: this repository, `release.yml`, environment
`release`). An agent cannot check or add it; the workflow's preflight is what finds out.

## Procedure

1. **Check nothing is already published at this version.** `scripts/release.mjs` does it, but knowing early is
   worth more than being told late.
   **Complete when:** `npm view @agentcomms/<name>@<version> version` returns nothing for every name in
   `scripts/packages.mjs`.

2. **Get the version right everywhere.** Edit the root `package.json`, then `pnpm sync:versions` — it writes every
   package manifest, two plugin files, the launcher and every skill's `compatibility:` line, Gmail and Slack alike. `pnpm run licenses` regenerates the third-party notices
   that ship inside the bundles.
   **Complete when:** `pnpm verify:versions` and `pnpm verify:licenses` both pass.

3. **Write the changelog entry yourself.** `## Unreleased` becomes `## X.Y.Z`. This is the one artefact a person
   writes, because it is the only one addressed to a reader rather than a machine.
   **Complete when:** the entry says what changed in terms a user would recognise, not in terms of commits. The tag
   gate refuses a version with no `## X.Y.Z` section, and the GitHub release is made from that section.

4. **Commit and push, on `main`.** What is published must be what anyone else can read.
   **Complete when:** `git status` is clean and local `main` and `origin/main` are the same commit.

5. **Rehearse locally.** `pnpm release` runs every check and stops before sending anything. A minute here beats ten
   in CI.
   **Complete when:** it prints that everything a release checks has passed.

6. **Tag, and push the tag. This publishes.** `git tag vX.Y.Z && git push origin vX.Y.Z`. Six verify legs run
   first and the publish is skipped if any fails, but nothing asks for confirmation after the push. Before the first
   package is sent, the **OIDC preflight** exchanges an ID token for every package, exactly as the publish will; if
   any package has no trusted publisher for this workflow, the run fails there, naming it, with nothing published.
   **Complete when:** the run's own registry check reports every package in `scripts/packages.mjs` at the new
   version, and the `GitHub release` job has made the release page. It asks the registry what arrived rather than
   trusting the publish command, because `pnpm --filter` exits 0 when it matches nothing.

   **If the preflight names a package**, nothing was published. Tell the owner which package needs a trusted
   publisher; once they have added it, re-run the failed job. Do not bump the version: nothing was spent.

   **If a publish fails part way**, fix the cause and re-run the failed job at the same version. The loop skips every
   package already on the registry at that version, so the re-run finishes the release instead of stopping at
   `core`.

   **If a leg fails, nothing is published** and the tag names a release that did not happen — move it to the fix
   rather than leaving it. v0.1.2 did exactly this: green on macOS and Linux, broken on Windows by an absolute
   path handed to a dynamic `import`, which only the tag workflow could catch.

   **If it says a package "is not visible yet", do not bump the version.** `npm view` reads a CDN-cached document
   that can lag minutes behind a successful publish. Run `npm dist-tag ls @agentcomms/<name>`, which goes to the
   authenticated path. If that reports the version, the publish landed.

7. **Prove it from outside.** `npx -y @agentcomms/gmail@X.Y.Z --version`, then `doctor`, in a directory that is not
   this repository. Then `npx skills add crissmoldovan/agent-communications --skill '*'` in a scratch directory and
   check a skill brought its `references/` with it.
   **Complete when:** the published artefact has been run by something that did not build it.

8. **Check the GitHub release** the workflow made from the changelog section. It is automatic now — every release
   up to 0.4.0 was made by hand, and 0.3.2's was forgotten for a day. The body is the changelog section verbatim, so
   development-phase notes that say "nothing to install yet" belong out of the entry, not edited out of the page.
   **Complete when:** `gh release view vX.Y.Z` shows the release, made by `github-actions[bot]`.

## What the workflow refuses, and why

| Refusal | Why it matters |
|---|---|
| The tag does not match the declared version | a half-renamed release is discovered by consumers |
| `sync-versions --check` fails | the version is written in more than twenty places and they must agree |
| CHANGELOG.md has no section for the version | the GitHub release is made from it, after the packages are out |
| A package has no trusted publisher for this workflow | found before anything is published, not after the packages before it went out |
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

The packages that went out are **on the registry for good**.

- **In CI:** re-run the failed job at the same version. The publish loop skips what is already there.
- **With the local script:** bump the version and release again. The script refuses a version any package already
  has, says so at the point of failure and lists what it managed to send, because that list is the only thing that
  tells you which half of the release exists.

## Pitfalls

- **Treating the tag as the release.** The tag starts the workflow; the publish happens only if every verify leg
  and the preflight pass. A tag whose run published nothing names a release that did not happen — move it to the
  fix rather than leave it implying otherwise.
- **Bumping the version after a partial CI failure.** Re-run the job instead; it skips what is already out. Bumping
  is for the local script, which does not.
- **Reading a preflight failure as a failed release.** Nothing was published; the fix is the owner adding a trusted
  publisher, then a re-run.
- **Trusting the publish command's exit code.** Ask the registry, and give it time to answer.
- **Adding an npm token so CI "just publishes".** It already publishes, through OIDC, with nothing stored. A token
  would add a standing credential to a public repository — one that publishes from anywhere, not only from this
  workflow on a `v*` tag.
- **Reading "not visible yet" as a failed publish.** It is usually CDN lag. Check `npm dist-tag ls` first.
- **Running the release while agents are working in this checkout.** They share the working tree and can change
  branches under you. Give them worktree isolation, or do not run them during a release.

## Verification

- [ ] The changelog entry was written by a person.
- [ ] `pnpm release` passed locally before the tag was pushed.
- [ ] `pnpm verify` passed locally, on this platform, before the tag was pushed — knowing that green here is not green on Windows.
- [ ] The run confirms every package in `scripts/packages.mjs` at the new version — not "all three": 0.4.0 passed
      that check with Slack missing.
- [ ] The GitHub release exists for the tag, with the changelog section as its body.
- [ ] The tag names the commit the workflow actually published.
- [ ] The published package was installed and run somewhere that is not this repository.
