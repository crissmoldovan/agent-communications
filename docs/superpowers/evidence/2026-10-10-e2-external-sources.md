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

### hf-laya-origin-weights

- id: `hf-laya-origin-weights`
- url: `https://huggingface.co/api/models/convaiinnovations/laya/paths-info/7b928d828b7b0e022f929d9bd2e44165aa270148`
- fetchedAt: `2026-10-10T22:07:11Z`
- immutable: `891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c`
- fact: `convaiinnovations/laya model.safetensors is 842609210 bytes with SHA-256 891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c; it was last changed by commit 00c37c405e3c3ad73ee070227614c89cda06b99e on 2026-09-18 ("Initial release of Laya fine-tuned System 1 decision model"), before receptron/laya-onnx's export at revision 68f27dfe5a27a54fb2b1fefc432f43f972e90868 (2026-09-19); the repository is licensed apache-2.0 and its later commits up to 7b928d828b7b0e022f929d9bd2e44165aa270148 changed only the README, assets and a root config.json`
- reviewer: `coordinator`

This is the manifest's `weights.originSha256`. It also answers part of E2-H: the weights-source revision the export was
made from is `00c37c405e3c3ad73ee070227614c89cda06b99e`. The Python reference and invocation are still to be recorded.

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

### npm-laya-runtime-closure

- id: `npm-laya-runtime-closure`
- url: `https://registry.npmjs.org/`
- fetchedAt: `2026-10-10T22:38:05Z`
- immutable: `5e23d92819feccb28ab2be114fa0a26613ec61d6dc5373c5d462a560f23bd181`
- fact: `the private @agentcomms/events-laya-runtime importer's closure in pnpm-lock.yaml is exactly the 19 packages tabled below; for each, the coordinator fetched https://registry.npmjs.org/<name>/<version> and the registry's dist.integrity equals the lockfile's and its tarball is the canonical registry URL; only onnxruntime-node declares an install-time script (postinstall), which never runs`
- reviewer: `coordinator`

The `immutable` value is the SHA-256 of the canonical JSON of this table (keys sorted: installScripts, integrity,
licence, package, tarball), so a change to any row changes it.

| Package | Licence | Tarball | Integrity (sha512) | Install-time script |
| --- | --- | --- | --- | --- |
| `@huggingface/tokenizers@0.2.0` | Apache-2.0 | `https://registry.npmjs.org/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz` | `sha512-LidMHe1FpcSYH4vcSjXooda34pC0M8m1gmDOv7SQi6Iv+ib1zX7J3sHBCC9/3FPCkn2k1b55FneVqMRxrr99pg==` | none |
| `@receptron/laya@0.1.2` | MIT | `https://registry.npmjs.org/@receptron/laya/-/laya-0.1.2.tgz` | `sha512-cTqQC4DEY/wDAHY44EQhbW8wlrO7mZyLVWOy512783LUq55a7nLGGu16wXVi6oi4uNRfR0cLctKcQAxdXCXQfA==` | none |
| `adm-zip@0.6.1` | MIT | `https://registry.npmjs.org/adm-zip/-/adm-zip-0.6.1.tgz` | `sha512-Xwrja8nx9e5o2N1my4DsKCeKpdrnACyr1wtbPxBDgGzKzKyE9kRtBFA8mWldI+RVlD7CBZNWY/wQ2+ydwOR6kQ==` | none |
| `define-data-property@1.1.4` | MIT | `https://registry.npmjs.org/define-data-property/-/define-data-property-1.1.4.tgz` | `sha512-rBMvIzlpA8v6E+SJZoo++HAYqsLrkg7MSfIinMPFhmkorw7X+dOXVJQs+QT69zGkzMyfDnIMN2Wid1+NbL3T+A==` | none |
| `define-properties@1.2.1` | MIT | `https://registry.npmjs.org/define-properties/-/define-properties-1.2.1.tgz` | `sha512-8QmQKqEASLd5nx0U1B1okLElbUuuttJ/AnYmRXbbbGDWh6uS208EjD4Xqq/I9wK7u0v6O08XhTWnt5XtEbR6Dg==` | none |
| `es-define-property@1.0.1` | MIT | `https://registry.npmjs.org/es-define-property/-/es-define-property-1.0.1.tgz` | `sha512-e3nRfgfUZ4rNGL232gUgX06QNyyez04KdjFrF+LTRoOXmrOgFKDg4BCdsjW8EnT69eqdYGmRpJwiPVYNrCaW3g==` | none |
| `es-errors@1.3.0` | MIT | `https://registry.npmjs.org/es-errors/-/es-errors-1.3.0.tgz` | `sha512-Zf5H2Kxt2xjTvbJvP2ZWLEICxA6j+hAmMzIlypy4xcBg1vKVnx89Wy0GbS+kf5cwCVFFzdCFh2XSCFNULS6csw==` | none |
| `escape-string-regexp@4.0.0` | MIT | `https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-4.0.0.tgz` | `sha512-TtpcNJ3XAzx3Gq8sWRzJaVajRs0uVxA2YAkdb1jm2YkPz4G6egUFAyA3n5vtEIZefPk5Wa4UXbKuS5fKkJWdgA==` | none |
| `global-agent@4.1.3` | BSD-3-Clause | `https://registry.npmjs.org/global-agent/-/global-agent-4.1.3.tgz` | `sha512-KUJEViiuFT3I97t+GYMikLPJS2Lfo/S2F+DQuBWzuzaMPnvt5yyZePzArx36fBzpGTxZjIpDbXLeySLgh+k76g==` | none |
| `globalthis@1.0.4` | MIT | `https://registry.npmjs.org/globalthis/-/globalthis-1.0.4.tgz` | `sha512-DpLKbNU4WylpxJykQujfCcwYWiV/Jhm50Goo0wrVILAv5jOr9d+H+UR3PhSCD2rCCEIg0uc+G+muBTwD54JhDQ==` | none |
| `gopd@1.2.0` | MIT | `https://registry.npmjs.org/gopd/-/gopd-1.2.0.tgz` | `sha512-ZUKRh6/kUFoAiTAtTYPZJ3hw9wNxx+BIBOijnlG9PnrJsCcSjs1wyyD6vJpaYtgnzDrKYRSqf3OO6Rfa93xsRg==` | none |
| `has-property-descriptors@1.0.2` | MIT | `https://registry.npmjs.org/has-property-descriptors/-/has-property-descriptors-1.0.2.tgz` | `sha512-55JNKuIW+vq4Ke1BjOTjM2YctQIvCT7GFzHwmfZPGo5wnrgkid0YQtnAleFSqumZm4az3n2BS+erby5ipJdgrg==` | none |
| `matcher@4.0.0` | MIT | `https://registry.npmjs.org/matcher/-/matcher-4.0.0.tgz` | `sha512-S6x5wmcDmsDRRU/c2dkccDwQPXoFczc5+HpQ2lON8pnvHlnvHAHj5WlLVvw6n6vNyHuVugYrFohYxbS+pvFpKQ==` | none |
| `object-keys@1.1.1` | MIT | `https://registry.npmjs.org/object-keys/-/object-keys-1.1.1.tgz` | `sha512-NuAESUOUMrlIXOfHKzD6bpPu3tYt3xvjNdRIQ+FeT0lNb4K8WR70CaDxhuNguS2XG+GjkyMwOzsN5ZktImfhLA==` | none |
| `onnxruntime-common@1.30.0` | MIT | `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.30.0.tgz` | `sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==` | none |
| `onnxruntime-node@1.30.0` | MIT | `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz` | `sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==` | `postinstall: node ./script/install` |
| `semver@7.8.5` | ISC | `https://registry.npmjs.org/semver/-/semver-7.8.5.tgz` | `sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==` | none |
| `serialize-error@8.1.0` | MIT | `https://registry.npmjs.org/serialize-error/-/serialize-error-8.1.0.tgz` | `sha512-3NnuWfM6vBYoy5gZFvHiYsVbafvI9vZv/+jlIigFn4oP4zjNPK3LhcY0xSCgeb1a5L8jO71Mit9LlNoi2UfDDQ==` | none |
| `type-fest@0.20.2` | (MIT OR CC0-1.0) | `https://registry.npmjs.org/type-fest/-/type-fest-0.20.2.tgz` | `sha512-Ne+eE4r0/iWnpAxD852z3A+N0Bt5RN//NjJwRd2VFHEmrywxf5vsZlh4R6lixl6B+wz/8d+maTSAkN1FIkI3LQ==` | none |

## Task 9 (E2-H) — the Python reference, chosen by the owner

### hf-laya-python-reference

- id: `hf-laya-python-reference`
- url: `https://huggingface.co/convaiinnovations/laya/tree/55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851` (files
  `rl_agent_api.py`, `rl_common.py`, `rl_agent_config.json`, `tokenizer/`, `encoder/config.json`, `model.safetensors`)
- fetchedAt: `2026-10-11T04:03:09Z` (revision metadata, `rl_agent_api.py`, `rl_common.py`, the two tokenizer files and
  the weights' LFS id); `2026-10-11T18:44:29Z` (`rl_agent_config.json`)
- immutable: `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851`
- fact: `convaiinnovations/laya at revision 55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851 (last modified
  2026-09-24T05:39:22Z; licence apache-2.0; not gated) is the reference: rl_agent_api.py sha256
  be3b46819c9999c3ef88e0f2ecf6d3ab1cdfed1d9a8b466fc89811e34d44031b; rl_common.py sha256
  8d83611d480c971d640a7b7d3aa2f2219c5e8455e9cc2329fd073681bd8be23e; rl_agent_config.json sha256
  ae287b56bbcf5f8c4f4541ae9dfd00c914c4c48b940b8398c3058af37ba92bbd (encoder answerdotai/ModernBERT-large, max_len 512,
  head_max_len 192); model.safetensors 842609210 bytes sha256
  891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c (the manifest's weights.originSha256);
  tokenizer/tokenizer.json sha256 6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30 and
  tokenizer/tokenizer_config.json sha256 50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12, byte-identical
  to receptron/laya-onnx@68f27dfe5a27a54fb2b1fefc432f43f972e90868`
- invocation: `RLAgent(<snapshot of this revision>, device="cpu")`, then, per request, the path `system_one(state,
  questions)` takes: `_to_internal(question)` → `build_sequence(tokenizer, state, question, 512, 192)` →
  `collate_items([items], tokenizer.pad_token_id)` → `model(input_ids, attention_mask, marker_pos, marker_mask, qtype)`
  under `torch.no_grad()`. On CPU there is no autocast, so the forward pass is fp32. Question types map choice 0,
  score 1, noul 2. Compare `input_ids`, `attention_mask`, `marker_pos`, `marker_mask` and `qtype` exactly before any
  number; then the raw `logits` and `softmax(act)` against the ONNX outputs `logits` and `act_probs`. The reference
  applies its fitted temperatures only after these, so they are not part of the comparison.
- reviewer: `owner` (the choice, 2026-10-11: "okay with record A"); `coordinator` (every fact above, re-read from the
  fetched files)

Considered and not chosen, per the coordinator's research on 2026-10-11 (not relied on, so not re-verified here):
receptron's export script (`github.com/receptron/laya`, `export/export_onnx.py`), which is not a complete
implementation and only prints its check; and the `laya` package on PyPI (`github.com/NandhaKishorM/laya`), which
releases often and differs from the JavaScript port, so it would report false mismatches.

Not pinned by the source, so Task 9 pins it: the Python, torch and transformers versions of the locked reference
environment, recorded here when the gate first runs. The report-excluding candidate-subject digest is computed by
Task 9's verifier from the candidate's assets and source, as the plan says.

## Task 4 — HTTP redirects and ranges (RFC 9110) and Hugging Face downloads

Fetched by the coordinator on 2026-10-12. Signed CDN paths and query strings are short-lived credentials and are not
recorded; only their hosts are.

### rfc9110-redirect-range

- id: `rfc9110-redirect-range`
- url: `https://www.rfc-editor.org/rfc/rfc9110.txt`
- fetchedAt: `2026-10-12T18:33:46Z` (response SHA-256 `21c1cdce6ab0e5509b04d84a28000836c7a087cf786efe6f04877ebfff47232a`, 502941 bytes)
- immutable: RFC 9110 (STD 97, June 2022); a published RFC's text does not change
- fact: `§15.4.8: on a 307 a user agent MUST NOT change the request method if it redirects automatically; §15.4.3/§15.4.2: 302 and 301 may historically change POST to GET (GET is unaffected); §10.2.2: Location is a URI reference and may be relative; §14.2 Range and §14.1 range units ("bytes"); §14.4: Content-Range = range-unit SP (incl-range "/" (complete-length / "*") / "*/" complete-length), and a 206 or 416 carries it; §15.3.7: a client MUST inspect a 206 response's Content-Range to learn what part is enclosed and whether more requests are needed, and a server may send fewer bytes than asked; §15.5.17: 416 Range Not Satisfiable; §13.1.5: If-Range makes a server ignore Range unless the validator matches; §7.2: a user agent sends Host (or :authority).`
- reviewer: `coordinator`

### hf-laya-onnx-resolve-lfs

- id: `hf-laya-onnx-resolve-lfs`
- url: `https://huggingface.co/receptron/laya-onnx/resolve/68f27dfe5a27a54fb2b1fefc432f43f972e90868/laya.onnx.data`
- fetchedAt: `2026-10-12T18:33:46Z` (headers only; one 16-byte ranged read; no model download)
- immutable: `68f27dfe5a27a54fb2b1fefc432f43f972e90868`
- fact: `HEAD at the hub answers 302 with Location on host us.aws.cdn.hf.co (a signed, short-lived URL), x-repo-commit 68f27dfe5a27a54fb2b1fefc432f43f972e90868, x-linked-size 1685258240 and x-linked-etag "487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba" (the manifest's size and SHA-256), accept-ranges bytes. At the CDN target a GET with Range: bytes=0-15 answers 206 with content-range "bytes 0-15/1685258240", content-length 16 and accept-ranges bytes; a HEAD without Range answers 200 with content-length 1685258240. The CDN's own etag ("b06b05a0a887610c53a917603bb6986d8018400a2ec99158ac1cc944b55a24ed") is not the file's SHA-256.`
- reviewer: `coordinator`

What Task 4 relies on: the hub redirects a large file to a CDN host the source does not pin (observed `us.aws.cdn.hf.co`),
so integrity comes only from the manifest's SHA-256 over the bytes received, never from a host, an etag or a header;
resumption uses `Range` and checks each 206's `Content-Range` against the requested range and the manifest size.

### hf-laya-onnx-resolve-small

- id: `hf-laya-onnx-resolve-small`
- url: `https://huggingface.co/receptron/laya-onnx/resolve/68f27dfe5a27a54fb2b1fefc432f43f972e90868/laya_config.json`
- fetchedAt: `2026-10-12T18:33:46Z`
- immutable: `68f27dfe5a27a54fb2b1fefc432f43f972e90868`
- fact: `a non-LFS file answers 307 with a relative Location on the same host (/api/resolve-cache/models/receptron/laya-onnx/68f27dfe5a27a54fb2b1fefc432f43f972e90868/laya_config.json plus a query), then 200 with 369 bytes whose SHA-256 is 5049005dc6ae3ca5e82cc7d85c421357d5c543817300c8e8c5281ddbc69bb561 (the manifest's value).`
- reviewer: `coordinator`

## Not yet recorded (blocks the named task)

- Task 7: macOS `sandbox-exec` availability, deprecation and profile semantics; the owner-run real-mac proof.
- Task 8: the `@receptron/laya` package's load, request-rendering, output-parsing and token-counting source, from its
  SRI-verified bytes.
- Task 9: the locked reference environment's Python, torch and transformers versions, when the gate first runs (the
  reference itself is `hf-laya-python-reference` above).
