#!/usr/bin/env bash
# Blocks runs this after cloning, before the review agent starts.
#
# Its job is to make `pnpm verify` possible. This repository is mostly executable logic
# — a send gate, an HTML sanitiser, path jails, OAuth flows — with test suites behind
# each; a reviewer who can only read the diff misses what running the code finds.
# Nothing private is needed: every dependency is public.
set -uo pipefail

say() { printf '[post-clone] %s\n' "$*"; }

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
