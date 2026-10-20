#!/bin/bash
set -euo pipefail
umask 077
#
# Agent Comms for macOS, signed: a universal build, signed with the Developer ID in the login keychain, the app and
# the DMG notarised and stapled, and the updater's signed archive when the updater is on, staged for
# publish-desktop.sh (desktop design DA8, DA16).
#
#   apps/desktop/scripts/release-desktop.sh desktop-vX.Y.Z
#
# **The owner runs this, on the signing Mac, in a terminal, from a clean checkout of the tag. An agent never does.**
# docs/RELEASING.md, "The desktop app", has the steps around it.
#
# QuotaMate's scripts/release-menubar.sh (cueplusplus/quotamate), with its checks kept, and changed here:
# - it refuses a tag other than desktop-v plus the tauri.conf.json version, a HEAD other than the tag's commit, and a
#   stdin or stdout that is not a terminal, and asks for the version to be typed back;
# - the updater is decided first, before the signing environment is read: with plugins.updater.pubkey committed, the
#   updater key ${AGENTCOMMS_UPDATER_KEY_FILE:-~/.agentcomms/tauri-updater.key} must be there, mode 600, its .pub that
#   pubkey (apps/desktop/scripts/updater-key.mjs); with it empty, the release is still built, signed and notarised,
#   with its updater OFF and no updater artefacts, which this says loudly and asks to be confirmed;
# - the signing environment is ${AGENTCOMMS_DESKTOP_RELEASE_ENV_FILE:-.env.desktop-release.local}, which git ignores;
# - the DMG is notarised with the notarytool keychain profile ${AGENTCOMMS_NOTARY_PROFILE:-agentcomms-notary}
#   (`xcrun notarytool store-credentials`), so no password is ever on a command line;
# - no token is read or baked in: the repository is public, so the app reads its releases without one;
# - QuotaMate's check:monitor and verify-updater steps are gone (this repository has no such crate), and the app's
#   licence notices and bundle check run instead;
# - updater artefacts are switched on here, with --config, and nowhere else.
#
# The signing environment holds APPLE_SIGNING_IDENTITY ("Developer ID Application: …"), and APPLE_ID, APPLE_TEAM_ID
# and APPLE_PASSWORD (an app-specific password; APPLE_ID_PASSWORD is read too), which Tauri reads from its environment
# to notarise the app; and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, if the updater key has one. Nothing here prints any of
# them, or the key.

cd "$(dirname "$0")/../../.."
refuse() {
  printf 'release-desktop: %s\n' "$1" >&2
  exit 1
}
mode() { stat -f '%Lp' "$1"; }

TAG="${1:?usage: apps/desktop/scripts/release-desktop.sh desktop-vX.Y.Z}"
VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
[ "$TAG" = "desktop-v$VERSION" ] || refuse "the tag must be desktop-v$VERSION, the version in apps/desktop/src-tauri/tauri.conf.json."
[ "$(uname -s)" = Darwin ] || refuse 'the signed release is built on a Mac.'
[ -t 0 ] && [ -t 1 ] || refuse 'run this in a terminal: it asks for the version to be typed back.'
[ -z "$(git status --porcelain)" ] || refuse 'the working tree is not clean: commit or remove what git status lists.'
TAG_COMMIT="$(git rev-parse --verify --quiet "$TAG^{commit}")" || refuse "there is no tag $TAG here: tag the vX.Y.Z commit, or fetch the tag."
[ "$TAG_COMMIT" = "$(git rev-parse HEAD)" ] || refuse "HEAD is not the commit $TAG names: check out $TAG."
COMMIT="$TAG_COMMIT"
printf 'This builds, signs and notarises Agent Comms %s from %s.\nType the version to go on: ' "$VERSION" "${COMMIT:0:12}"
read -r TYPED
[ "$TYPED" = "$VERSION" ] || refuse 'the version typed back does not match; nothing was built.'

# ── The updater key, before anything else is read ────────────────────────────────────────────────────────────────
# on: the pubkey is committed, and the key beside it is there, mode 600, and its .pub is that pubkey. off: no pubkey
# is committed; the helper says so loudly, with how to turn it on. Anything else is refused here, before the signing
# environment is read or anything is built.
KEY_FILE="${AGENTCOMMS_UPDATER_KEY_FILE:-$HOME/.agentcomms/tauri-updater.key}"
UPDATER="$(node apps/desktop/scripts/updater-key.mjs "$KEY_FILE")" || refuse 'the updater key does not match the app: see above.'
case "$UPDATER" in on | off) ;; *) refuse "the updater is neither on nor off: $UPDATER" ;; esac
if [ "$UPDATER" = off ]; then
  printf 'Type off to build Agent Comms %s with its updater off: ' "$VERSION"
  read -r OFF
  [ "$OFF" = off ] || refuse 'nothing was built: commit the updater key first, as above, or type off.'
fi

# ── The signing environment ──────────────────────────────────────────────────────────────────────────────────────
ENV_FILE="${AGENTCOMMS_DESKTOP_RELEASE_ENV_FILE:-.env.desktop-release.local}"
if [ -f "$ENV_FILE" ]; then
  if git ls-files --error-unmatch -- "$ENV_FILE" > /dev/null 2>&1; then
    refuse "$ENV_FILE is tracked by git: remove it from the repository; it must stay ignored."
  fi
  case "$(mode "$ENV_FILE")" in 600 | 400) ;; *) refuse "$ENV_FILE must be readable by you alone: chmod 600 it." ;; esac
  set -a
  # shellcheck disable=SC1090 # the owner's file, outside the repository's history
  . "$ENV_FILE"
  set +a
fi
: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY in the signing environment.}"
case "$APPLE_SIGNING_IDENTITY" in 'Developer ID Application:'*) ;; *) refuse 'APPLE_SIGNING_IDENTITY must be a Developer ID Application identity.' ;; esac
security find-identity -v -p codesigning | grep -F -- "$APPLE_SIGNING_IDENTITY" > /dev/null \
  || refuse 'that Developer ID Application identity is not in the login keychain.'
: "${APPLE_ID:?Set APPLE_ID in the signing environment.}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID in the signing environment.}"
export APPLE_PASSWORD="${APPLE_PASSWORD:-${APPLE_ID_PASSWORD:?Set APPLE_PASSWORD, an app-specific password, in the signing environment.}}"
export APPLE_SIGNING_IDENTITY APPLE_ID APPLE_TEAM_ID
# The DMG's notarisation reads its credentials from this notarytool keychain profile, never from a command line.
NOTARY_PROFILE="${AGENTCOMMS_NOTARY_PROFILE:-agentcomms-notary}"
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --output-format json > /dev/null 2>&1 \
  || refuse "the notarytool keychain profile $NOTARY_PROFILE does not answer: create it with xcrun notarytool store-credentials $NOTARY_PROFILE (docs/RELEASING.md)."

# ── What the build is given of the updater key ───────────────────────────────────────────────────────────────────
if [ "$UPDATER" = on ]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
  export TAURI_SIGNING_PRIVATE_KEY
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  UPDATER_CONFIG='{"bundle":{"createUpdaterArtifacts":true}}'
else
  # Nothing of a key reaches the build, whatever the signing environment held: build.rs then builds the app with its
  # updater off, which Settings says.
  unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  UPDATER_CONFIG='{"bundle":{"createUpdaterArtifacts":false}}'
fi

# ── Build ────────────────────────────────────────────────────────────────────────────────────────────────────────
pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'
node apps/desktop/scripts/third-party-licenses.mjs --check
(cd apps/desktop/src-tauri && rustup target add aarch64-apple-darwin x86_64-apple-darwin)
# Finder's installer-window styling needs desktop automation consent; CI mode builds the same signed DMG without that
# optional AppleScript step. No token is in the build's environment, so none can be baked into the app.
env -u GH_TOKEN -u GITHUB_TOKEN -u SSL_CERT_FILE -u REQUESTS_CA_BUNDLE -u NODE_EXTRA_CA_CERTS -u TAURI_BUNDLER_DMG_IGNORE_CI CI=true \
  pnpm --filter @agentcomms/desktop tauri build --ci --target universal-apple-darwin --bundles app,dmg --config "$UPDATER_CONFIG"
pnpm --filter @agentcomms/desktop check:bundle

BUNDLE='apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle'
APP="$BUNDLE/macos/Agent Comms.app"
ARCHIVE="$BUNDLE/macos/Agent Comms.app.tar.gz"
DMG="$BUNDLE/dmg/Agent Comms_${VERSION}_universal.dmg"
[ -f "$DMG" ] || refuse "a build artefact is missing: $DMG"
if [ "$UPDATER" = on ]; then
  for f in "$ARCHIVE" "$ARCHIVE.sig"; do [ -f "$f" ] || refuse "a build artefact is missing: $f"; done
fi

# ── Verify the signatures and the notarisation ───────────────────────────────────────────────────────────────────
ARCHS="$(lipo -archs "$APP/Contents/MacOS/agentcomms-desktop")"
case "$ARCHS" in *arm64*) ;; *) refuse 'the Apple silicon slice is missing.' ;; esac
case "$ARCHS" in *x86_64*) ;; *) refuse 'the Intel slice is missing.' ;; esac
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose=2 "$APP"
xcrun stapler validate "$APP"
if [ "$UPDATER" = on ]; then
  EXTRACTED="$(mktemp -d)"
  trap 'rm -rf "$EXTRACTED"' EXIT
  tar -xzf "$ARCHIVE" -C "$EXTRACTED"
  codesign --verify --deep --strict "$EXTRACTED/Agent Comms.app"
  xcrun stapler validate "$EXTRACTED/Agent Comms.app"
fi
# Notarise the DMG as well, with the keychain profile's credentials.
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$BUNDLE/dmg/notarization.json"
node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (r.status !== "Accepted") { console.error("the DMG was not accepted for notarisation: " + r.status); process.exit(1) }' "$BUNDLE/dmg/notarization.json"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
[ "$COMMIT" = "$(git rev-parse HEAD)" ] && [ -z "$(git status --porcelain)" ] || refuse 'the source changed during the build: build again before publishing.'

# ── Stage ────────────────────────────────────────────────────────────────────────────────────────────────────────
OUT="apps/desktop/src-tauri/target/desktop-release/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$DMG" "$OUT/Agent.Comms_${VERSION}_universal.dmg"
if [ "$UPDATER" = on ]; then
  cp "$ARCHIVE" "$OUT/Agent.Comms.app.tar.gz"
  cp "$ARCHIVE.sig" "$OUT/Agent.Comms.app.tar.gz.sig"
  (cd "$OUT" && shasum -a 256 Agent.Comms.app.tar.gz "Agent.Comms_${VERSION}_universal.dmg" > SHA256SUMS)
else
  (cd "$OUT" && shasum -a 256 "Agent.Comms_${VERSION}_universal.dmg" > SHA256SUMS)
fi
printf '%s\n' "$COMMIT" > "$OUT/.built-at-commit"
printf '%s\n' "$UPDATER" > "$OUT/.updater"
echo "Signed and notarised Agent Comms $VERSION, its updater $UPDATER: $OUT"
[ "$UPDATER" = on ] || echo 'THE UPDATER IS OFF: this release carries no updater artefacts, and its app never updates itself.'
echo "Publish it with apps/desktop/scripts/publish-desktop.sh $TAG"
