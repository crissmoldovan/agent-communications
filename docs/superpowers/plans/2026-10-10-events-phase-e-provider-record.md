# Phase E provider record — judge wire facts, fetched 2026-10-10

The coordinator fetched these pages on 2026-10-10, the ones the specification's sources table cites, so that Phase E's
transport task builds its vectors from published facts rather than inferred ones. Each entry was read through a
summarising fetch tool, not copied byte for byte: field names and shapes below are as the pages state them, and
anything a page does not state is marked **not stated**. The transport must treat every not-stated case fail-closed:
bounded parsing, refusal of unknown fields and headers, and any non-2xx or malformed answer as a failed judge call.

## TypeSafe — hosted Jev through System One

Source: <https://docs.typesafe.ai/introduction/quickstart> (read 2026-10-10)

- Endpoint: `POST https://api.typesafe.ai/v1/systemone` (the spec's fixed endpoint, D11).
- Request headers: `Authorization: Bearer <API_KEY>`; `Content-Type: application/json`.
- Request body: `state` (string, the text judged); `model` (string, e.g. `jev-latest`); `questions` (object keyed by a
  question name; each `{ type: "noul" | "choice" | "score", instructions: string, criteria: … }` — `criteria` is for
  `choice` and `score`).
- Response body: `model` (string, e.g. `jev-1.13.0`); `answers` (object keyed by the question names; for a `noul`
  question the answer carries `type` and a numeric `noul`, e.g. `"noul": 1.0`); `usage` (`input_tokens`,
  `output_tokens`).
- Size limits, timeouts, error status codes and the error body: **not stated** on this page.

Source: <https://docs.typesafe.ai/models> (read 2026-10-10)

- Model identifiers: `jev-1.13.0`; aliases `jev-latest` and `jev-preview`, both pointing to `jev-1.13.0`. An approved
  judge document should name the concrete version, not a moving alias.
- Context: "64k tokens per request; 32k tokens for `state` plus the longest question".
- Maximum output tokens: **not stated**. Prompt-template identifiers: **not stated** (so the spec's template version
  stays an approved document value; the adapter cannot validate it against the provider).
- Rate limits: "100K tokens per second / 80 requests per second" for Jev 1.13, "adjusting dynamically" and "can change
  without notice".
- Pricing: output tokens are free.

## Ollama — local System One (the `local-endpoint` judge's `noul` protocol)

Source: <https://docs.ollama.com/capabilities/decision> (read 2026-10-10)

- Endpoint: `POST http://localhost:11434/v1/systemone` (literal loopback, B2's only HTTP exception).
- Request headers: `Content-Type: application/json` (no authorization stated).
- Request body: `model` (string, e.g. `nimble`, `clef`, `clef-flash`); `state` (string or object); `images` (optional
  array, base64 PNG/JPEG/WebP, Clef models only); `questions` (object of named questions, each
  `{ type: "choice" | "noul" | "score", instructions, criteria }`).
- Response body: `model`; `answers` keyed by question name — for `noul`, `noul` is a number from 0 to 1, the probability
  that the answer is true; `usage` (`input_tokens`, `output_tokens`).
- Supported models named: Nimble, Tev1, Clef, Clef Flash. Limits and timeouts: **not stated**.

## What the transport task takes from this record

- One `noul` question per call; the daemon reads exactly `answers.<name>.noul` as an untrusted number and validates it
  as finite and within 0–1; any other field is ignored for the decision.
- The header allow-list for TypeSafe is exactly `Authorization` and `Content-Type` (plus the transport's own `Host` and
  framing); for the local endpoint, `Content-Type` only.
- Every limit not stated above comes from the plan's approved maxima (`maxInputTokens`, `maxOutputTokens`, the 64 KiB
  byte caps and B2's 20-second deadline), enforced before any byte leaves the machine.
