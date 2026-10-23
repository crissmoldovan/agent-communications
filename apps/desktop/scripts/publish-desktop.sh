#!/bin/bash
set -euo pipefail
umask 077
#
# Publishes the signed macOS build release-desktop.sh staged as the GitHub release desktop-vX.Y.Z of this repository,
# with the updater's latest.json when that build has the updater on, and never as Latest (desktop design DA8, DA15,
# DA16).
#
#   apps/desktop/scripts/publish-desktop.sh desktop-vX.Y.Z [--confirm X.Y.Z]
#
# **It runs on the signing Mac after release-desktop.sh, from the same clean checkout of the tag.** The owner runs it
# in a terminal, and types the version back. An agent may run it once the owner has said so, with --confirm X.Y.Z, the
# app's version, in place of typing it (0.26.0 design R1); then it needs no terminal. docs/RELEASING.md, "The desktop
# app", has the steps around it. It needs `gh` signed in with push rights to this repository.
#
# QuotaMate's scripts/publish-menubar.sh (cueplusplus/quotamate), changed here:
# - the same tag, clean-tree, commit and terminal checks as release-desktop.sh, and the version typed back, or given
#   with --confirm;
# - the repository is public, so the archive's address is its public download and the app needs no token;
# - a release already published is refused, whatever it holds: only a draft is ever written to. The draft the Desktop
#   release workflow made is used, or a draft is made (--verify-tag --draft --latest=false);
# - a build release-desktop.sh made with its updater off is published without latest.json, and this says the updater
#   stays off until the owner commits the updater key and releases the next version;
# - the draft is published only once the Windows and Linux files that workflow attaches are there, since the notes
#   name them; run this again when they are;
# - it never takes Latest, which is the CLI's (release.yml), and never makes a prerelease, which the updater skips.

cd "$(dirname "$0")/../../.."
refuse() {
  printf 'publish-desktop: %s\n' "$1" >&2
  exit 1
}

USAGE='usage: apps/desktop/scripts/publish-desktop.sh desktop-vX.Y.Z [--confirm X.Y.Z]'
TAG="${1:?$USAGE}"
shift
# --confirm X.Y.Z stands for typing the version back: no terminal is needed.
CONFIRM=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      [ -n "${2:-}" ] || refuse "--confirm takes the version: $USAGE"
      CONFIRM="$2"
      shift 2
      ;;
    *) refuse "unknown argument: $1" ;;
  esac
done

REPO='crissmoldovan/agent-communications'
VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
[ "$TAG" = "desktop-v$VERSION" ] || refuse "the tag must be desktop-v$VERSION, the version in apps/desktop/src-tauri/tauri.conf.json."
if [ -z "$CONFIRM" ]; then
  [ -t 0 ] && [ -t 1 ] || refuse 'run this in a terminal: it asks for the version to be typed back.'
fi
[ -z "$(git status --porcelain)" ] || refuse 'the working tree is not clean: commit or remove what git status lists.'
TAG_COMMIT="$(git rev-parse --verify --quiet "$TAG^{commit}")" || refuse "there is no tag $TAG here: fetch it."

OUT="apps/desktop/src-tauri/target/desktop-release/$VERSION"
ARCHIVE='Agent.Comms.app.tar.gz'
DMG="Agent.Comms_${VERSION}_universal.dmg"
for f in "$DMG" SHA256SUMS .built-at-commit .updater; do
  [ -s "$OUT/$f" ] || refuse "$OUT/$f is missing: run apps/desktop/scripts/release-desktop.sh $TAG first."
done
UPDATER="$(cat "$OUT/.updater")"
case "$UPDATER" in on | off) ;; *) refuse "$OUT/.updater says neither on nor off: run release-desktop.sh again." ;; esac
if [ "$UPDATER" = on ]; then
  for f in "$ARCHIVE" "$ARCHIVE.sig"; do
    [ -s "$OUT/$f" ] || refuse "$OUT/$f is missing: run apps/desktop/scripts/release-desktop.sh $TAG first."
  done
fi
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

if [ "$UPDATER" = on ]; then WITH='the signed DMG and the updater manifest'; else WITH='the signed DMG, and its updater OFF'; fi
if [ -n "$CONFIRM" ]; then
  [ "$CONFIRM" = "$VERSION" ] || refuse 'the version given to --confirm does not match; nothing was published.'
  printf 'This publishes Agent Comms %s as %s on %s, with %s: confirmed with --confirm.\n' "$VERSION" "$TAG" "$REPO" "$WITH"
else
  printf 'This publishes Agent Comms %s as %s on %s, with %s.\nType the version to go on: ' "$VERSION" "$TAG" "$REPO" "$WITH"
  read -r TYPED
  [ "$TYPED" = "$VERSION" ] || refuse 'the version typed back does not match; nothing was published.'
fi

TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

# ── The release: CI's draft, or a new draft; never one already shipped ───────────────────────────────────────────
if gh release view "$TAG" --repo "$REPO" > /dev/null 2>&1; then
  [ "$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)" = true ] \
    || refuse "$TAG is already published: bump the version; a shipped release is never written to again."
else
  node apps/desktop/scripts/release-notes.mjs "$VERSION" > "$TEMP/notes.md"
  gh release create "$TAG" --repo "$REPO" --verify-tag --draft --latest=false --title "Agent Comms $VERSION" --notes-file "$TEMP/notes.md"
fi

# ── The signed files, then the manifest that points at them, then the release ───────────────────────────────────
if [ "$UPDATER" = on ]; then
  gh release upload "$TAG" --repo "$REPO" --clobber "$OUT/$DMG" "$OUT/$ARCHIVE" "$OUT/$ARCHIVE.sig" "$OUT/SHA256SUMS" apps/desktop/THIRD_PARTY_LICENSES
else
  gh release upload "$TAG" --repo "$REPO" --clobber "$OUT/$DMG" "$OUT/SHA256SUMS" apps/desktop/THIRD_PARTY_LICENSES
fi
# GitHub lets two drafts share a tag; the files must all be on one release.
IDS="$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\") | .id")"
case "$IDS" in '' | *[!0-9]*) refuse "expected exactly one release for $TAG; delete the empty draft on GitHub and run this again." ;; esac
gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' > "$TEMP/assets"
for f in "Agent.Comms_${VERSION}_x64-setup.exe" "Agent.Comms_${VERSION}_amd64.AppImage" "Agent.Comms_${VERSION}_amd64.deb"; do
  grep -Fqx -- "$f" "$TEMP/assets" \
    || refuse "$f is not attached yet: wait for the Desktop release run for $TAG to pass, then run this again."
done
if [ "$UPDATER" = on ]; then
  node apps/desktop/scripts/updater-manifest.mjs "$REPO" "$TAG" "$OUT/$ARCHIVE.sig" > "$OUT/latest.json"
  gh release upload "$TAG" --repo "$REPO" --clobber "$OUT/latest.json"
else
  # No latest.json: the app finds only releases that carry one, and this build's own copies have the updater off.
  printf '%s\n' \
    'The updater stays off: this release has no latest.json, and the app it installs never updates itself.' \
    'To turn it on, commit the updater key (docs/RELEASING.md, "The desktop app") and release the next version.' >&2
fi
# Published only once every file and the manifest are there, so the app is never offered a release half uploaded.
gh release edit "$TAG" --repo "$REPO" --draft=false --latest=false
gh release view "$TAG" --repo "$REPO" --json url,isDraft,isPrerelease,assets --jq '{url, isDraft, isPrerelease, assets: [.assets[].name]}'
