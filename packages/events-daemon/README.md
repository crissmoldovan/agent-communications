# @agentcomms/events-daemon

`@agentcomms/events-daemon` is the held local service package for agent-communications event emission. In this first
package it deliberately exposes only a content-free ownership status: no event is accepted, persisted, delivered or
sent, and the service never starts a background owner.

The `agent-events status` command and `events_status` MCP tool both report that the owner is not running. The package
uses Node's built-in SQLite support; it does not ship a native database dependency. It needs **Node 22.16 or newer**, the first
Node whose SQLite is complete without a flag; an older Node is refused with what to install. It runs on macOS and Linux:
on Windows it refuses for now, because Node cannot create a control pipe that only your account can open. Its control
socket lives under the state directory, and a state directory deep enough to make that path longer than the system allows
(103 bytes on macOS, 107 on Linux) is refused with a hint to pin a shorter one.

It is held from publication until the first daemon consumer is ready. See the [release guide](../../docs/RELEASING.md#A-package-held-back-from-release).

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
