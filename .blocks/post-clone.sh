#!/usr/bin/env bash
# Blocks runs this after cloning, before the review agent starts.
#
# Its job is to make `pnpm verify` possible. This repository is mostly executable logic
# — a send gate, an HTML sanitiser, path jails, OAuth flows — with test suites behind
# each; a reviewer who can only read the diff misses what running the code finds.
# Nothing private is needed: every dependency is public.
set -uo pipefail

say() { printf '[post-clone] %s\n' "$*"; }

# Development needs Node 22.18 or newer (the build tool loads its TypeScript config natively). The published
# packages run on 22.12, but the suite does not. When the sandbox's Node is older, fetch Node 24 next to the clone
# and leave `.blocks/env.sh` for the reviewer to source.
NODE_VERSION=24.15.0
node_ok() {
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}
if ! node_ok; then
  say "Node $(node -v 2>/dev/null || echo 'missing') is older than 22.18; fetching Node ${NODE_VERSION}."
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) platform=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
    Darwin-arm64) platform=darwin-arm64 ;;
    Darwin-x86_64) platform=darwin-x64 ;;
    *) platform="" ;;
  esac
  dest="$PWD/.blocks/.node"
  if [ -n "$platform" ] && mkdir -p "$dest" &&
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${platform}.tar.gz" |
    tar -xz -C "$dest" --strip-components=1; then
    export PATH="$dest/bin:$PATH"
    printf 'export PATH="%s/bin:$PATH"\n' "$dest" >.blocks/env.sh
    say "Node $(node -v) installed. Run \`source .blocks/env.sh\` before \`pnpm verify\`."
  else
    say "COULD NOT FETCH NODE. The suite needs Node 22.18 or newer; say so in the review."
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then corepack enable >/dev/null 2>&1 || true; fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@11 >/dev/null 2>&1 || true
fi

if ! pnpm install --frozen-lockfile; then
  say "INSTALL FAILED. The suite cannot be run; say so in the review rather than"
  say "leaving a reader to infer it from a verdict that does not mention tests."
  exit 0
fi

say "Ready: dependencies installed. Run \`pnpm verify\`."
