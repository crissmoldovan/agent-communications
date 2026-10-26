#!/bin/sh
# A local test release: build a commit of this repository on this Mac and install it as a separate TEST PROFILE, with
# its own app, "Agent Comms Test", so the owner can try a change in minutes before any public release.
#
# Nothing of the real installation is touched:
#   - its folders (~/.config/agent-communications, ~/.local/share/agent-communications), launchers and accounts;
#   - its verified updates (0.26.0: only releases proven to come from the release workflow are installed there);
#   - its app, Agent Comms, whose identifier, settings and agentcomms:// links stay its own.
# The test profile lives in ~/.agentcomms-test (AGENTCOMMS_TEST_PROFILE to move it). Its launchers run this Mac's
# build, unverified: that is what a test is, and why it is kept apart.
#
# Usage: scripts/local-test-release.sh [<git ref>]     (default: HEAD of the checkout it is run from)
# Remove everything it made: scripts/local-test-release.sh --remove
set -eu

home=${HOME:?HOME is not set}
profile=${AGENTCOMMS_TEST_PROFILE:-$home/.agentcomms-test}
identifier=com.cueplusplus.agentcomms.test
app_name='Agent Comms Test'
app_dest="$home/Applications/$app_name.app"
app_config="$home/Library/Application Support/$identifier"
main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
work="$(dirname "$main")/.agentcomms-wt/local-test"

# What the test app's band names (0.32.0): AGENTCOMMS_BUILD_COMMIT, the short commit of $1 and then the branch pointing
# at it, if one does (the branch $2 names, or HEAD's, before any other), and AGENTCOMMS_BUILD_TIME, now in UTC. The app
# compiles both in (apps/desktop/src-tauri/src/build_info.rs).
build_stamp() {
  short=$(git rev-parse --short "$1")
  branch=
  if [ "$2" = HEAD ]; then
    branch=$(git symbolic-ref --short -q HEAD || true)
  elif git show-ref --verify --quiet "refs/heads/$2"; then
    branch=$2
  fi
  [ -n "$branch" ] || branch=$(git for-each-ref --points-at "$1" --format='%(refname:short)' refs/heads | head -n 1)
  AGENTCOMMS_BUILD_COMMIT="$short${branch:+ $branch}"
  AGENTCOMMS_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  export AGENTCOMMS_BUILD_COMMIT AGENTCOMMS_BUILD_TIME
}

if [ "${1:-}" = --remove ]; then
  osascript -e "quit app \"$app_name\"" >/dev/null 2>&1 || true
  "$profile/data/launch/events-daemon" stop --config-dir "$profile/config" --state-dir "$profile/state" \
    --data-dir "$profile/data" >/dev/null 2>&1 || true
  rm -rf "$profile" "$app_dest" "$app_config"
  git -C "$main" worktree remove --force "$work" 2>/dev/null || true
  echo "The test profile, Agent Comms Test and its build are removed. The real installation was not touched."
  exit 0
fi

ref=${1:-HEAD}
commit=$(git rev-parse --verify "$ref^{commit}")
node=$(command -v node) || { echo "node is not on PATH" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is not on PATH" >&2; exit 1; }

echo "1/5 Checking out $commit in $work"
if [ -d "$work" ]; then
  git -C "$work" checkout -q --detach "$commit"
else
  git -C "$main" worktree add -q --detach "$work" "$commit"
fi

echo "2/5 Installing and building (a few minutes)"
(cd "$work" && pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime' >/dev/null && pnpm build >/dev/null)

echo "3/5 Writing the test profile in $profile"
mkdir -p "$profile/config" "$profile/state" "$profile/data/launch" "$profile/bin"
chmod 700 "$profile" "$profile/config" "$profile/state" "$profile/data" "$profile/data/launch"
# The test profile's mark, in its config folder and nowhere else: the test app's approvals speak only for a folder that
# holds it (core's desktopAppOrigin), never for the real installation's.
: > "$profile/config/.agentcomms-test-profile"
pins="--config-dir '$profile/config' --state-dir '$profile/state' --data-dir '$profile/data' --secrets-dir '$profile/config/secrets'"
for entry in core:core:agentcomms gmail:gmail:agent-gmail slack:slack:agent-slack resend:resend:agent-resend \
  whatsapp:whatsapp:agent-whatsapp events-daemon:events-daemon:agent-events; do
  product=${entry%%:*}; rest=${entry#*:}; package=${rest%%:*}; command=${rest#*:}
  cli="$work/packages/$package/dist/cli.mjs"
  launcher="$profile/data/launch/$product"
  cat > "$launcher" <<EOF
#!/bin/sh
# A launcher of the LOCAL TEST PROFILE ($commit): it runs this Mac's build of $package, unverified.
AGENT_COMMS_LAUNCHER='$product'
export AGENT_COMMS_LAUNCHER
exec '$node' '$cli' "\$@"
EOF
  chmod 755 "$launcher"
  # A command for the person, with the test profile's folders pinned, so a test never reaches the real one.
  cat > "$profile/bin/$command" <<EOF
#!/bin/sh
case "\${1:-}" in --version|-V|--help|-h) exec '$launcher' "\$@" ;; esac
exec '$launcher' "\$@" $pins
EOF
  chmod 755 "$profile/bin/$command"
done
version=$("$node" -p "require('$work/packages/events-daemon/package.json').version")
printf 'current=%s-events-daemon\n' "$version" > "$profile/data/launch/events-daemon.current"

echo "4/5 Building Agent Comms Test (its own identifier, no updater, unsigned)"
build_stamp "$commit" "$ref"
config=$(printf '{"identifier":"%s","productName":"%s","plugins":{"updater":{"pubkey":""},"deep-link":{"desktop":{"schemes":["agentcomms-test"]}}},"bundle":{"createUpdaterArtifacts":false}}' "$identifier" "$app_name")
(cd "$work/apps/desktop" && pnpm exec tauri build --bundles app --config "$config" >/dev/null)
built="$work/apps/desktop/src-tauri/target/release/bundle/macos/$app_name.app"
[ -d "$built" ] || { echo "the app was not built at $built" >&2; exit 1; }
osascript -e "quit app \"$app_name\"" >/dev/null 2>&1 || true
mkdir -p "$home/Applications"
rm -rf "$app_dest"
cp -R "$built" "$app_dest"
# Sealed with an ad-hoc signature, so the test profile's CLIs can verify that their approvals in the app come from this
# app (core's desktopAppOrigin): an unsealed bundle does not pass codesign --verify --strict.
codesign --force --deep --sign - "$app_dest" >/dev/null 2>&1 || { echo "the app could not be ad-hoc signed" >&2; exit 1; }

echo "5/5 Pointing Agent Comms Test at the test profile"
mkdir -p "$app_config"
printf '{"folders":{"configDir":"%s","stateDir":"%s","dataDir":"%s"}}\n' \
  "$profile/config" "$profile/state" "$profile/data" > "$app_config/settings.json"
chmod 600 "$app_config/settings.json"

cat <<EOF

Done: commit $commit, version $version, as a local test.
  App:      $app_dest  (open it; your real Agent Comms is untouched, and each runs its own event service.)
  Profile:  $profile  (no accounts yet: add a test one with $profile/bin/agent-gmail or agent-slack)
  Commands: $profile/bin/agentcomms, agent-events, agent-gmail, agent-slack, agent-resend, agent-whatsapp
  Remove:   scripts/local-test-release.sh --remove
EOF
