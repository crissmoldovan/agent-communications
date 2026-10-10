# Phase E2 external-source record

The coordinator fetched every source below on 2026-10-10 and recorded only the facts E2 relies on. Nothing here is a
corpus item, secret, token, address or downloaded artifact. Each entry gives the source id, its URL, the UTC time it
was fetched, the immutable revision or digest the fact is bound to, the fact relied on, and who accepted it. A later
change to any of these — a new revision, licence, host, origin, digest, field or behaviour — starts a new review and
blocks the dependent task until the changed fact is recorded here and accepted.

Accepted by: coordinator (Claude, agent-communications build session 5b36bfbc), 2026-10-10. The owner may re-review.

## Task 2 — model manifest (Hugging Face) and runtime packages (npm)

### hf-laya-onnx-tree

- id: `hf-laya-onnx-tree`
- url: `https://huggingface.co/api/models/receptron/laya-onnx/tree/68f27dfe5a27a54fb2b1fefc432f43f972e90868?recursive=true&expand=true`
- fetchedAt: `2026-10-10T17:30:25Z` (response SHA-256 `a2a9984e0060ab672b7455c323f8a8aa2c829ddcd44f688e2de908ec12f7eb19`)
- immutable: `68f27dfe5a27a54fb2b1fefc432f43f972e90868`
- fact: `receptron/laya-onnx at revision 68f27dfe5a27a54fb2b1fefc432f43f972e90868 holds exactly seven files: .gitattributes 1570 bytes; README.md 1388 bytes; laya.onnx 3807291 bytes sha256 a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e; laya.onnx.data 1685258240 bytes sha256 487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba; laya_config.json 369 bytes; tokenizer/tokenizer.json 3583228 bytes; tokenizer/tokenizer_config.json 308 bytes`
- reviewer: `coordinator`

The two large files' SHA-256 values are the API's LFS object ids. The small files are not LFS objects (the API gives
only git blob ids), so the coordinator downloaded each from `https://huggingface.co/receptron/laya-onnx/raw/68f27dfe5a27a54fb2b1fefc432f43f972e90868/<path>`
and hashed it: `.gitattributes` `c64a0936a4eb8b2633eae42e3a0dce445e84c9443e06d35b7262485f21a26e54`, `README.md`
`66f5b09344193c4fa3fb4b8072705cd40381273b249f2456791495174386b199`, `laya_config.json`
`5049005dc6ae3ca5e82cc7d85c421357d5c543817300c8e8c5281ddbc69bb561`, `tokenizer/tokenizer.json`
`6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30`, `tokenizer/tokenizer_config.json`
`50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12`. The repository is public and not gated; its
author is `receptron`; total size 1692652394 bytes.

### hf-laya-onnx-readme

- id: `hf-laya-onnx-readme`
- url: `https://huggingface.co/receptron/laya-onnx/raw/68f27dfe5a27a54fb2b1fefc432f43f972e90868/README.md`
- fetchedAt: `2026-10-10T17:30:25Z`
- immutable: `66f5b09344193c4fa3fb4b8072705cd40381273b249f2456791495174386b199`
- fact: `the ONNX export of convaiinnovations/laya (ModernBERT-large encoder plus Laya's decision head) is the English checkpoint, 421M parameters, fp32 weights; weights are Convai Innovations' under Apache-2.0 and the export code is MIT; inputs input_ids, attention_mask, marker_pos, marker_mask, qtype; outputs logits (uncalibrated) and act_probs; @receptron/laya's Laya.load() downloads this bundle on first use by default`
- reviewer: `coordinator`

Consequence for the build: the daemon never lets the runtime fetch anything. `Laya.load()`'s default download must
not be reachable; the worker loads only the daemon-verified local tree (Task 8 records the exact load signature from
the SRI-verified package bytes). The README does not pin the base model's revision (`convaiinnovations/laya` was at
`7b928d828b7b0e022f929d9bd2e44165aa270148`, last modified 2026-10-03, when fetched — after this export's 2026-09-19),
so the weights-source revision E2-H needs is still to be recorded before Task 9.

### npm-receptron-laya-0.1.2

- id: `npm-receptron-laya-0.1.2`
- url: `https://registry.npmjs.org/%40receptron%2Flaya/0.1.2`
- fetchedAt: `2026-10-10T17:30:25Z` (response SHA-256 `8562afee9c34cf366bd8c8c60a71f4a2e5e778389fedc35f42ed8dd1f1cfaf8a`)
- immutable: `sha512-cTqQC4DEY/wDAHY44EQhbW8wlrO7mZyLVWOy512783LUq55a7nLGGu16wXVi6oi4uNRfR0cLctKcQAxdXCXQfA==`
- fact: `@receptron/laya 0.1.2 is MIT, source git+https://github.com/receptron/laya.git at gitHead 6478649e723122ca24bbf5fb69ed1010023c9750, published by snakajima; dependencies onnxruntime-node ^1.22.0 and @huggingface/tokenizers ^0.2.0; no preinstall, install, postinstall or prepare script; engines node >=20; tarball https://registry.npmjs.org/@receptron/laya/-/laya-0.1.2.tgz, 23 files, 52526 bytes unpacked; latest of versions 0.1.0, 0.1.1, 0.1.2`
- reviewer: `coordinator`

### npm-onnxruntime-node-1.30.0

- id: `npm-onnxruntime-node-1.30.0`
- url: `https://registry.npmjs.org/onnxruntime-node/1.30.0`
- fetchedAt: `2026-10-10T17:30:25Z` (response SHA-256 `4c00a3e687de8d8bd01b58bf75b5256f1d00cc5c67fdc20385776f8da26122e4`)
- immutable: `sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==`
- fact: `onnxruntime-node 1.30.0 is MIT, source git+https://github.com/Microsoft/onnxruntime.git, published by microsoft1es; dependencies adm-zip ^0.6.0, global-agent ^4.1.3 and onnxruntime-common 1.30.0; it declares a postinstall script "node ./script/install" (and a prepare script); os win32, darwin, linux; tarball https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz, 43 files, 301068136 bytes unpacked`
- reviewer: `coordinator`

Consequence for the build: the postinstall script — and with it `global-agent` and `adm-zip`, which exist for it — must
never run. The daemon installs from SRI-verified tarball bytes through its own strict extractor (Task 5) and runs no
package script; whether the macOS native binaries the worker needs are inside this tarball, rather than fetched by the
postinstall script, is a fact the release-only lock builder establishes from the verified bytes before Task 2's lock is
accepted.

### npm-huggingface-tokenizers-0.2.0

- id: `npm-huggingface-tokenizers-0.2.0`
- url: `https://registry.npmjs.org/%40huggingface%2Ftokenizers/0.2.0`
- fetchedAt: `2026-10-10T17:30:25Z` (response SHA-256 `c5dc8089b96afdaa5dda8010e584152a2780a4856a0c009deb71be86a3dc7e84`)
- immutable: `sha512-LidMHe1FpcSYH4vcSjXooda34pC0M8m1gmDOv7SQi6Iv+ib1zX7J3sHBCC9/3FPCkn2k1b55FneVqMRxrr99pg==`
- fact: `@huggingface/tokenizers 0.2.0 is Apache-2.0, source git+https://github.com/huggingface/tokenizers.js.git; no dependencies; no install-time script; tarball https://registry.npmjs.org/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz, 80 files, 360962 bytes unpacked`
- reviewer: `coordinator`

## Not yet recorded (blocks the named task)

- Task 4: RFC 9110 redirect, `Range`/`Content-Range` and request-header facts, and the Hugging Face download/API
  behaviour for the manifest's files.
- Task 7: macOS `sandbox-exec` availability, deprecation and profile semantics; the owner-run real-mac proof.
- Task 8: the `@receptron/laya` package's load, request-rendering, output-parsing and token-counting source, from its
  SRI-verified bytes.
- Task 9 (E2-H): the owner-selected Python reference repository, revision and invocation, and the weights-source
  revision of `convaiinnovations/laya` this export was made from.
