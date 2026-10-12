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

Every socket and server the owner holds — webhook connections, the control socket and its server, the SSE listener and
its streams — keeps an error listener for its whole life, so a peer that resets a connection ends that connection,
never the owner.

Phase D puts the four local sources — Gmail, Slack, Resend and WhatsApp — behind that one owner. Slack scans history
and thread replies, and its reply barrier holds progress until both are covered. Resend resolves received mail through
its detail operation and observes sent-mail status; its text is Unicode-validated and bounded, and all its event reads
share the local throttle. WhatsApp reads the local checked copy only through the current live chat lists: a hidden chat
reaches no dry-run, stream or dead letter. Phase D adds no command or MCP tool beyond the `source show` rows for the
new sources. B2's stream and dead-letter handling is registered into Phase D's single list-change and retention
transaction. Every Phase D test uses fakes, never a real provider.

## B3 compatibility contract

The data-only B3 control contract is published as
[`b3-control-v1.schema.json`](src/operations/contracts/b3-control-v1.schema.json), with language-neutral,
content-free request/result/error vectors in
[`test/fixtures/b3-control-contract-v1`](test/fixtures/b3-control-contract-v1) and shared terminal approval-preview
vectors in [`test/fixtures/b3-approval-preview-v1`](test/fixtures/b3-approval-preview-v1). It covers every
desktop-callable `events-daemon` capability in `capabilities.json`—including lifecycle, catalogue, sources, rules,
targets, subscribers, dry-run and B3 controls—while deliberately excluding process entry points such as `run` and
the MCP server. Capability function names are mapped through the owner dispatcher’s exported registry, so the schema
and vectors carry the exact authenticated control wire names (for example, `disable-all`). Every such wire has a
closed result branch and at least one Ajv-validated result vector. Its doctor result is a `$ref` to the existing closed
[`doctor-v1.schema.json`](src/operations/contracts/doctor-v1.schema.json), not a copy that could drift.
Successful vectors carrying a rule, target, subscriber, judge, or approval-preview document are also accepted by the
daemon's canonical document validators.

`ordinary-results.json` is regenerated from the real owner; the ten seeded-state result vectors are deliberately
synthetic, hand-corrected and schema-validated, while `rules-list`, `rule-show`, `targets-list`, `subscribersList`,
`deliveriesList`, `dryrun-list`, and `sources-list` accounts retain open JSON items. Reusing an existing version number for an
update still surfaces B1's `UNEXPECTED`; that follow-up is not changed by this contract.

The contract never contains a secret value. Secret controls accept only the `interactive-terminal` origin; app and
approval-screen callers receive `APP_SECRET_CAPABILITY_UNAVAILABLE`. A ready `approvalView` result carries one
owner-built pending-target selector for each pending rule target (and none for other activation kinds); the terminal
approval flow and an app approval screen pass that selector unchanged. The pending target selector belongs only to the
approval flow, never an ordinary CLI/MCP target test.

Phase E imports its real code and this contract, lands the build/ship negative gate before any owner registration or
callable judge, and requires B3 merged.

Both this package and `@agentcomms/events` are held from publication throughout B1, B2 and Phase D. A B1, B2 or Phase D
merge publishes neither package. When the owner elects to make the first release from one checked tag, they publish
`@agentcomms/events` first and then `@agentcomms/events-daemon`, because the daemon has an exact runtime dependency on
the library. See the [release guide](../../docs/RELEASING.md#the-held-event-library-and-daemon).

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
