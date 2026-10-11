# @agentcomms/events-laya-runtime

This private workspace exists only to pin the reviewed Laya runtime roots in
the pnpm lockfile. It has no executable code, package script, export, binary,
or Agent Communications surface, and is never published.

The daemon does not depend on this package. A release-only supply-chain gate
acquires the runtime tarballs by their exact SRI and extracts them without
running a package-manager script. In particular, `onnxruntime-node`'s
postinstall script is never run.

## Reviewed direct packages

- `@receptron/laya` 0.1.2 — MIT
- `onnxruntime-node` 1.30.0 — MIT
- `@huggingface/tokenizers` 0.2.0 — Apache-2.0

The recorded provenance is in
`docs/superpowers/evidence/2026-10-10-e2-external-sources.md`.
