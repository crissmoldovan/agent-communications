# Instructions for coding agents working on this repository

- Read `docs/superpowers/specs/2026-09-18-agent-communications-design.md` before changing behaviour. It is the
  source of truth for the send gate, untrusted-content handling, the CLI and MCP surfaces, and the skills. For
  change approvals, the change policy, the core MCP server and CLI–MCP parity, read
  `docs/superpowers/specs/2026-09-25-cli-mcp-parity-design.md` too; where the two differ, it is the later word. Before
  adding or changing a channel, read `docs/superpowers/specs/2026-09-26-channel-plugins-design.md`: a channel is
  declared by the `"agentcomms"` field of its `package.json`, and the core and the tooling derive it from there.
- Before changing `packages/events`, read `docs/superpowers/specs/2026-10-05-local-event-emission-design.md`; its
  Appendix A is normative.
- Run `pnpm verify` before claiming anything works, and report its result.
- **Never send email while developing.** Tests use the fake transport in `packages/gmail/test`. Nothing in this
  repository's tests talks to Gmail.
- **Never post to Slack while developing.** Tests give the Slack client an injected `fetch`, or the loopback fake in
  `packages/slack/test/support/fake-slack.ts`; none of them should talk to Slack.
- **Never send through Resend while developing, and never use a real key.** Tests go through the loopback fake in
  `packages/resend/test/support/fake-resend.ts`, with fake keys; none of them should talk to Resend.
- **Never commit real mail, addresses, tokens or client secrets**, and never print a token or secret while debugging.
- Only `send.execute` may call Gmail's send endpoints, and only `executeSend` Resend's. Do not add another path.
- Anything a sender controls must pass through the HTML sanitiser and the untrusted-content envelope before it
  reaches a result.
- Keep CLI and MCP in parity: both call the same function in `packages/*/src/operations`, and every command and
  tool has a row in `capabilities.json` naming that function as its `operation` — see "Adding a capability" in
  `CONTRIBUTING.md`. `pnpm verify:parity` runs both sides of every row against stand-ins to check it.
