# @agentcomms/events-laya-runtime

This private workspace exists only to pin the reviewed Laya runtime roots in
the pnpm lockfile. It has no executable code, package script, export, binary,
or Agent Communications surface, and is never published: it is in neither
release list, and every release checks that it stays private and
dependency-only (`scripts/laya-release-gate.mjs`).

The daemon does not depend on this package, and no Laya or ONNX package is in
its published dependencies: every release refuses one, however it would be
reached. When a person enables Laya, the daemon installs the runtime itself
from the runtime lock it ships (`laya-runtime.json`), fetching each tarball by
its exact registry URL and SRI and extracting it with its own strict reader.
No package manager takes part, and `onnxruntime-node`'s postinstall script is
never run.

## Never installed by ordinary CI or setup

Every ordinary install — CI, `pnpm verify`, a contributor's setup, the review
bot — leaves this workspace out:

```bash
pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'
```

`scripts/verify-events-phase-e2-tests.mjs` refuses any install in a tracked
file that does not carry that filter. `pnpm verify` runs
`scripts/verify-laya-ci-install.mjs --self-test`, which checks that the
workspace stops pnpm from reinstalling unfiltered before a script and that its
store scanner finds a runtime package in a synthetic store. The cold-store
install itself — `node scripts/verify-laya-ci-install.mjs`, a filtered install
into an empty store, scanned for the runtime's three root packages — runs in
no workflow; it is a check to run by hand, and the coordinator ran it on
2026-10-10.

## Reviewed direct packages

- `@receptron/laya` 0.1.2 — MIT
- `onnxruntime-node` 1.30.0 — MIT
- `@huggingface/tokenizers` 0.2.0 — Apache-2.0

The recorded provenance of all 19 packages of the closure is in
`docs/superpowers/evidence/2026-10-10-e2-external-sources.md`.

## When a release offers Laya

Until the owner's three gates have passed, the daemon ships a fail-closed
placeholder lock and Laya is unavailable on every platform; every release
checks that this is so. A release that ships the real lock must first:

1. rebuild that lock from its exact registry origins and SRI, with the
   owner-only tarball acquirer (`scripts/fetch-laya-release-tarballs.mjs`),
   and match it byte for byte;
2. carry the aggregate quality report `gate/<manifestId>.json`, which
   `scripts/verify-laya-quality-gate.mjs` accepts, with every offered prompt
   template passing on Gmail and on Slack;
3. carry the real-Mac boundary evidence `gate/macos-boundary-v2.json` (schema
   `gate/macos-boundary-v2.schema.json`; version 1's schema is kept as it was
   written, and no evidence was ever made under it), which
   `scripts/verify-laya-boundary-gate.mjs` accepts, passing.

Steps 2 and 3 hold for every macOS architecture the lock offers, each with its
own evidence: arm64 evidence never stands for Intel. And for each, GitHub must
show that the results are exactly what the protected gate run the owner
recorded wrote (`scripts/verify-laya-gate-runs.mjs`). Any failure stops the
release with nothing published.

## The gate directory

`gate/` holds the schemas and, once the owner has run the gates, the two
results and the run record (`runs-v1.json`, the protected run each
architecture's results came from, which a release checks with GitHub) — and
nothing else. Both results are aggregate and content-free: no
message, subject, address, handle, event id, question, label, per-item value,
path or secret. They come only from the owner's protected Mac
(`.github/workflows/laya-quality-gate.yml`), over a corpus of the owner's and
colleagues' Gmail and Slack messages: each person's written consent stays with
the owner, and the corpus stays sealed in its encrypted container outside any
checkout, never uploaded anywhere. Only the owner commits the results, after
reading them. `docs/RELEASING.md` ("Laya: the local model judge") gives the
procedure.
