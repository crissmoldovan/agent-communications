# @agentcomms/events

The library behind agent-communications' local event emission: the version-1 event catalogue, its pointer patterns,
deterministic conditions, mapping templates and the CloudEvents wire format, as the
[event-emission design](../../docs/superpowers/specs/2026-10-05-local-event-emission-design.md) specifies them. Its
Appendix A is the contract.

**Isomorphic, with no I/O.** The same build runs in Node and in a browser's webview. It imports nothing but zod: no
`node:` module, no network, no file, no clock, no randomness and no host Unicode tables. Sanitising, enveloping,
signing and every other I/O operation stay in the daemon that uses it.

**Not released yet.** It is held back from release until the first package that depends on it ships; its first
version is then published by hand (`docs/RELEASING.md`, "A package held back from release").

## What it has so far

- `canonicalJson(value)`: deterministic JSON, byte-identical to `@agentcomms/core`'s — object keys sorted by UTF-16
  code units, `undefined` members dropped — refusing anything that is not JSON.
- `isJsonValue`, `compareUtf8`, `utf8ByteLength`, `codePointLength` and `isWellFormed`.
- `Result`, `Issue`, `IssueCode` and `EventsError`, the shapes every validator and evaluator here reports with.

## Licence

MIT. See `THIRD_PARTY_LICENSES` for anything the build inlines.
