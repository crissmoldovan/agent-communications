# @agentcomms/events-daemon

`@agentcomms/events-daemon` is the held local service package for agent-communications event emission. In this first
package it deliberately exposes only a content-free ownership status: no event is accepted, persisted, delivered or
sent, and the service never starts a background owner.

The `agent-events status` command and `events_status` MCP tool both report that the owner is not running. The package
uses Node's built-in SQLite support; it does not ship a native database dependency.

It is held from publication until the first daemon consumer is ready. See the [release guide](../../docs/RELEASING.md#A-package-held-back-from-release).

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
