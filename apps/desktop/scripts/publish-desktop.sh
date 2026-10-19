#!/bin/bash
set -euo pipefail
umask 077
#
# Publishes the signed macOS build release-desktop.sh staged as the GitHub release desktop-vX.Y.Z of this repository,
# with the updater's latest.json, and never as Latest (desktop design DA8, DA15).
#
#   apps/desktop/scripts/publish-desktop.sh desktop-vX.Y.Z
#
# **The owner runs this, in a terminal, after release-desktop.sh, from the same clean checkout of the tag. An agent
# never does.** docs/RELEASING.md, "The desktop app", has the steps around it. It needs `gh` signed in with push
# rights to this repository.
#
# QuotaMate's scripts/publish-menubar.sh (cueplusplus/quotamate), changed here:
# - the same tag, clean-tree, commit and terminal checks as release-desktop.sh, and the version typed back;
# - the repository is public, so the archive's address is its public download and the app needs no token;
# - a release already published with its DMG is refused; otherwise the draft the Desktop release workflow made is
#   used, or a draft is made (--verify-tag --draft --latest=false);
# - the draft is published only once the Windows and Linux files that workflow attaches are there, since the notes
#   name them; run this again when they are;
# - it never takes Latest, which is the CLI's (release.yml), and never makes a prerelease, which the updater skips.

cd "$(dirname "$0")/../../.."
refuse() {
  printf 'publish-desktop: %s\n' "$1" >&2
  exit 1
}

TAG="${1:?usage: apps/desktop/scripts/publish-desktop.sh desktop-vX.Y.Z}"
REPO='crissmoldovan/agent-communications'
VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
[ "$TAG" = "desktop-v$VERSION" ] || refuse "the tag must be desktop-v$VERSION, the version in apps/desktop/src-tauri/tauri.conf.json."
[ -t 0 ] && [ -t 1 ] || refuse 'run this in a terminal: it asks for the version to be typed back.'
[ -z "$(git status --porcelain)" ] || refuse 'the working tree is not clean: commit or remove what git status lists.'
TAG_COMMIT="$(git rev-parse --verify --quiet "$TAG^{commit}")" || refuse "there is no tag $TAG here: fetch it."

OUT="apps/desktop/src-tauri/target/desktop-release/$VERSION"
ARCHIVE='Agent.Comms.app.tar.gz'
DMG="Agent.Comms_${VERSION}_universal.dmg"
for f in "$ARCHIVE" "$ARCHIVE.sig" "$DMG" SHA256SUMS .built-at-commit; do
  [ -s "$OUT/$f" ] || refuse "$OUT/$f is missing: run apps/desktop/scripts/release-desktop.sh $TAG first."
done
BUILT="$(cat "$OUT/.built-at-commit")"
[ "$BUILT" = "$(git rev-parse HEAD)" ] || refuse 'HEAD is not the commit the signed build was made from.'
[ "$BUILT" = "$TAG_COMMIT" ] || refuse "$TAG does not name the commit the signed build was made from."
(cd "$OUT" && shasum -a 256 -c SHA256SUMS)

[ "$(gh repo view "$REPO" --json isPrivate --jq .isPrivate)" = false ] \
  || refuse "$REPO must be public: the app reads its releases without a token."
gh api "repos/$REPO/commits/$BUILT" --silent || refuse "$BUILT is not on GitHub: push it first."
REMOTE="$(git ls-remote "https://github.com/$REPO.git" "refs/tags/$TAG" "refs/tags/$TAG^{}" \
  | awk -v tag="refs/tags/$TAG" '$2 == tag { direct = $1 } $2 == tag "^{}" { peeled = $1 } END { print peeled ? peeled : direct }')"
[ "$REMOTE" = "$BUILT" ] || refuse "$TAG on GitHub must name $BUILT: push the tag."

printf 'This publishes Agent Comms %s as %s on %s, with the signed DMG and the updater manifest.\nType the version to go on: ' "$VERSION" "$TAG" "$REPO"
read -r TYPED
[ "$TYPED" = "$VERSION" ] || refuse 'the version typed back does not match; nothing was published.'

TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

# ── The release: CI's draft, or a new draft; never one already shipped ───────────────────────────────────────────
if gh release view "$TAG" --repo "$REPO" --json isDraft,assets > "$TEMP/release.json" 2> /dev/null; then
  RELEASE="$TEMP/release.json" DMG="$DMG" node --input-type=module - <<'JS' \
    || refuse "$TAG is already published with its DMG: bump the version; a shipped release is never overwritten."
import fs from 'node:fs'
const release = JSON.parse(fs.readFileSync(process.env.RELEASE, 'utf8'))
if (!release.isDraft && release.assets.some((asset) => asset.name === process.env.DMG)) process.exit(1)
JS
else
  node apps/desktop/scripts/release-notes.mjs "$VERSION" > "$TEMP/notes.md"
  gh release create "$TAG" --repo "$REPO" --verify-tag --draft --latest=false --title "Agent Comms $VERSION" --notes-file "$TEMP/notes.md"
fi

# ── The signed files, then the manifest that points at them, then the release ───────────────────────────────────
gh release upload "$TAG" --repo "$REPO" --clobber "$OUT/$DMG" "$OUT/$ARCHIVE" "$OUT/$ARCHIVE.sig" "$OUT/SHA256SUMS" apps/desktop/THIRD_PARTY_LICENSES
# GitHub lets two drafts share a tag; the files must all be on one release.
IDS="$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\") | .id")"
case "$IDS" in '' | *[!0-9]*) refuse "expected exactly one release for $TAG; delete the empty draft on GitHub and run this again." ;; esac
gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' > "$TEMP/assets"
for f in "Agent.Comms_${VERSION}_x64-setup.exe" "Agent.Comms_${VERSION}_amd64.AppImage" "Agent.Comms_${VERSION}_amd64.deb"; do
  grep -Fqx -- "$f" "$TEMP/assets" \
    || refuse "$f is not attached yet: wait for the Desktop release run for $TAG to pass, then run this again."
done
node apps/desktop/scripts/updater-manifest.mjs "$REPO" "$TAG" "$OUT/$ARCHIVE.sig" > "$OUT/latest.json"
gh release upload "$TAG" --repo "$REPO" --clobber "$OUT/latest.json"
# Published only once every file and the manifest are there, so the app is never offered a release half uploaded.
gh release edit "$TAG" --repo "$REPO" --draft=false --latest=false
gh release view "$TAG" --repo "$REPO" --json url,isDraft,isPrerelease,assets --jq '{url, isDraft, isPrerelease, assets: [.assets[].name]}'
