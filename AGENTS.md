# Instructions for coding agents working on this repository

- Read `docs/superpowers/specs/2026-09-18-agent-communications-design.md` before changing behaviour. It is the
  source of truth for the send gate, untrusted-content handling, the CLI and MCP surfaces, and the skills.
- Run `pnpm verify` before claiming anything works, and report its result.
- **Never send email while developing.** Tests use the fake transport in `packages/gmail/test`. Nothing in this
  repository's tests talks to Gmail.
- **Never commit real mail, addresses, tokens or client secrets**, and never print a token or secret while debugging.
- Only `send.execute` may call Gmail's send endpoints. Do not add another path.
- Anything a sender controls must pass through the HTML sanitiser and the untrusted-content envelope before it
  reaches a result.
- Keep CLI and MCP in parity: both call the same function in `packages/gmail/src/operations`.
