# @agentcomms/events-daemon

`@agentcomms/events-daemon` is the held local service package for agent-communications event emission. B1 has a
**foreground owner only**: it owns local state while the controlling terminal runs it, and it stops cleanly on request
or terminal shutdown. It has no background fork, OS service, autostart, tray owner, or network listener.

The package runs on **macOS and Linux only**. Windows refuses in B1 because Node cannot yet create a control pipe that
only the current account can open. It needs **Node 22.16.0 or newer**, the first Node release with complete built-in
SQLite support without a flag; an older Node is refused with what to install. Its control socket lives under the state
directory, and a state directory deep enough to make that path longer than the system allows (103 bytes on macOS,
107 on Linux) is refused with a hint to pin a shorter one.

B1 accepts only the local **dry-run target**. It creates no network delivery target and does not send mail or messages.
Dry-run reads are terminal-only: MCP never receives retained content, JSON output cannot select it, and an interactive
human terminal renders it through the untrusted-content envelope after the live disclosure fence passes.

Both this package and `@agentcomms/events` are held from publication. A B1 merge publishes neither package. When the
owner elects to make the first release from one checked tag, they publish `@agentcomms/events` first and then
`@agentcomms/events-daemon`, because the daemon has an exact runtime dependency on the library. See the [release
guide](../../docs/RELEASING.md#the-held-event-library-and-daemon).

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
