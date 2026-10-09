# @agentcomms/events-daemon

`@agentcomms/events-daemon` is the held local service package for agent-communications event emission. Its B1
**foreground owner only** owns local state while the controlling terminal runs it, and stops cleanly on request or
terminal shutdown. B2 keeps that lifecycle: there is no background fork, OS service, autostart, or tray owner.

The package runs on **macOS and Linux only**. Windows refuses in B1 because Node cannot yet create a control pipe that
only the current account can open. It needs **Node 22.16.0 or newer**, the first Node release with complete built-in
SQLite support without a flag; an older Node is refused with what to install. Its control socket lives under the state
directory, and a state directory deep enough to make that path longer than the system allows (103 bytes on macOS,
107 on Linux) is refused with a hint to pin a shorter one.

B1 accepts the local **dry-run target**. Dry-run reads are terminal-only: MCP never receives retained content, JSON
output cannot select it, and an interactive human terminal renders it through the untrusted-content envelope after the
live disclosure fence passes.

B2 adds internally fenced webhook delivery and a literal-loopback SSE listener, including browser CORS verification.
B2 adds no command or MCP tool: the existing B1 target-version and `doctor` surfaces remain the whole public boundary.
Delivery retry, drop or hold controls, subscriber management, named event-secret or migration operations, target
test/resume/replay controls, judges, and B3 doctor extensions are not present. The B2 runtime never sends mail or
messages through the channel packages.

Phase D puts the four local sources — Gmail, Slack, Resend and WhatsApp — behind that one owner. Slack scans history
and thread replies, and its reply barrier holds progress until both are covered. Resend resolves received mail through
its detail operation and observes sent-mail status; its text is Unicode-validated and bounded, and all its event reads
share the local throttle. WhatsApp reads the local checked copy only through the current live chat lists: a hidden chat
reaches no dry-run, stream or dead letter. Phase D adds no command or MCP tool beyond the `source show` rows for the
new sources. B2's stream and dead-letter handling is registered into Phase D's single list-change and retention
transaction. Every Phase D test uses fakes, never a real provider.

Both this package and `@agentcomms/events` are held from publication throughout B1, B2 and Phase D. A B1, B2 or Phase D
merge publishes neither package. When the owner elects to make the first release from one checked tag, they publish
`@agentcomms/events` first and then `@agentcomms/events-daemon`, because the daemon has an exact runtime dependency on
the library. See the [release guide](../../docs/RELEASING.md#the-held-event-library-and-daemon).

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
