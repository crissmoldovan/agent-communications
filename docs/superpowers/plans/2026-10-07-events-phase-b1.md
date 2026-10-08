# Local event emission, phase B1 — @agentcomms/events-daemon implementation plan

This is the implementation plan for B1 only. It starts from main with the completed, held, isomorphic @agentcomms/events Phase A library. It creates no network target, makes no judge callable, adds no desktop application, and does not publish any npm package. Gmail tests use the existing injected Gmail transport and loopback fake only; no task sends email, Slack, Resend, or another message.

The work is deliberately ordered by safety invariant, not by screen: declare and prove the service before it can be missed by tooling; add the standing-authority and taint fences before any event may be released; make one encrypted, owner-only authority before adding sources; then make Gmail acquisition, evaluation, and the local dry-run destination durable. Each task is a commit-sized sitting for one builder, starts with tests, and names the mutation that must turn those tests red.

The implementation must read the local-event design, the CLI/MCP parity design, and the channel-plugin design before changing the relevant behaviour. Existing Phase A decisions, including its committee table K1–K3, are binding. In particular:

- K1: metadata patterns contribute no concrete pointer at a null at any position, including the terminal position.
- K2-1: only normaliseResendBody rejects unpaired surrogates; B1 must not tighten validateEvent.
- K2-3: Gmail hasAttachments and attachments remain adapter guidance, not a catalogue dependentRequired invariant.
- K3-1: the fixed synthetic message is exactly “agent-communications test event”; use the Phase A exported judge input and CloudEvent bytes rather than reconstructing them.
- K3-2 and K3-3 remain true for any Gmail materialisation/vector fixtures B1 adds.

`pnpm verify` is strict about capability parity. Consequently, the task which first exposes a daemon operation must, in that same commit, add its shared operation export, its CLI command and MCP tool or its documented human-only/CLI-only exception, and its non-pending `capabilities.json` row. No task may defer any of those parts to a later adapter pass.

Every batch ends with the full root verification command, pnpm verify. Any batch that changes @agentcomms/events also runs pnpm verify:browser before that final root command, even though B1 should consume rather than alter the Phase A library.

For every task’s Run paragraph, passing means each named focused command exits zero (node:test reports zero failures) and the batch-ending pnpm verify exits zero. A focused success never substitutes for the batch command.

**References land with their surfaces (review round 2).** Root `pnpm verify` runs `verify:reference`, so every task that adds or changes a CLI command or MCP tool runs `pnpm sync:reference` and commits the generated `docs/reference` pages in the same task; Task 14 only confirms they are current.

## Decisions the spec leaves to the plan

### 1. A held service package, foreground in B1

Create packages/events-daemon as @agentcomms/events-daemon. Its declaration is the D14 service declaration:

~~~json
{
  "agentcommsPackage": {
    "kind": "service",
    "binary": "agent-events",
    "server": {
      "defaultName": "events",
      "entry": "src/mcp/server.ts",
      "factory": "createEventsMcpServer"
    },
    "operations": "src/operations"
  }
}
~~~

It has the usual src/cli.ts, src/cli/program.ts, src/mcp/server.ts and src/operations layout; package.json.bin maps agent-events to the bundled CLI. It depends at runtime on the exact workspace versions of @agentcomms/core, @agentcomms/events and @agentcomms/gmail. Gmail remains the provider boundary: the daemon owns sessions but obtains its Gmail source adapter from packages/gmail/src/operations/events.ts, never calls Google directly.

B1 starts only as a foreground user process: agent-events run owns the state until its controlling terminal sends SIGINT or SIGTERM, and agent-events stop asks that owner to exit cleanly. It has no daemonising fork, launchd/systemd/Task Scheduler unit, autostart setting, tray owner, or desktop supervision. The process is therefore supervised by the terminal/process manager the person chose; an OS service has the separate future design required by D15. This is deliberately less convenient than silently creating a durable background process, but meets D12’s one-owner rule without inventing OS-install authority.

The package declares an agentcommsRelease hold with the same release semantics as events: it is built, version-synced, licence-checked, packed and consumer-checked, but excluded from tag publication. The one-line reason says that it is held until the owner elects to release the first daemon consumer, alongside @agentcomms/events.

Reasonable alternatives rejected for B1:

- A new channel manifest would be wrong: agentcomms means channel, while the daemon is a service.
- A separate events-mcp wrapper package is unnecessary because the service package owns both CLI and MCP.
- A detached background child or per-platform service would hide lifetime/identity decisions D15 expressly postpones.
- A package published immediately would violate the existing held-package release contract and force first-publish credentials into this phase.

### 2. SQLite is Node built-in, with incremental owned migrations

Use node:sqlite and DatabaseSync, not better-sqlite3, sqlite3, or another native module. A built-in driver avoids ABI-specific native binaries, package-manager install scripts, optional-platform omissions, and a new third-party closure in every release/consumer tarball.

**Amended during the build (B1-F, committee K4).** This paragraph first said “The repository’s public floor is Node 22.12, where node:sqlite is present … if node:sqlite is not usable there, B1 stops rather than quietly raising the package engine floor.” Its premise was false: Node 22.12 has node:sqlite only behind `--experimental-sqlite` (measured: `ERR_UNKNOWN_BUILTIN_MODULE` unflagged; unflagged from 22.13, complete from 22.16, as the WhatsApp channel already states). The daemon therefore declares `engines.node >=22.16.0`, the WhatsApp floor, loads node:sqlite lazily through one loader that refuses an older Node with a CONFIG error naming 22.16.0 (`NODE_TOO_OLD`), and never runs on an experimental flag. The raise is recorded, tested and documented, not quiet. The release workflow's old-node job runs the built daemon under 22.12.0 (it must answer `--help` and refuse `status` by name, never crash) and again under 22.16.0 (it must reach Node SQLite). Core's 22.12 floor is unchanged.

Use one database at <stateDir>/events/events.sqlite. Its 0700 parent, database, WAL, SHM, lock, socket directory, token, and file-store secret directory are owner-only: 0600 files on POSIX, and current-user owner-only ACL helpers on Windows. The helper refuses a symlink/reparse-point path and verifies permissions after creation. SQLite opens with foreign keys enabled, WAL journal mode, synchronous FULL, a bounded busy timeout, and explicit BEGIN IMMEDIATE transactions for serialised authority transitions.

Migration v1 creates every B1-owned table and index: meta; event_settings; immutable object/version and active-pointer/lineage tables; activation intents, points, baselines and Gmail replacement drains; Gmail cursors, staging and terminal-resolution tables; ingest, projections, decisions, deliveries, dryrun_log, leases/work attempts/cap charges; event-secret metadata/counters; and reset metadata/local-barrier state for dry-run only, plus content-free operational/audit state. It does not pre-create B2 network/SSE tables, D-source tables, or E/E2 judge-runtime tables solely because D8 names their eventual forms. Those arrive in ordered, transactional migrations when their phase owns their operational meaning. Meta records the schema version and installation/reset identity, while a schema_migrations ledger records the applied named migrations; an interrupted migration rolls back as one transaction.

This resolves the D8 full eventual schema list against the explicit phase rows: one database and one migration lineage now, not speculative tables with unimplemented fences. All encrypted-table primary keys are declared in the migration that creates that table, so the exact AAD order can never be inferred from an ad hoc query.

### 3. Encryption: installation masters are separate secrets; rows are AAD-bound

The daemon holds random versioned 256-bit installation master keys in an EventSecretStore selected in SQLite meta, independent of config.secrets.store. It reuses core’s hardened backend primitives only as an implementation dependency, never core’s selector, migration operation, lock, namespace, or references:

- default keychain namespace is keychainNamespace(resolvedConfigDir):events;
- file backend is <stateDir>/events/secrets, with hashed references and owner-only files;
- there is no fallback; an unsuccessful first keychain round trip requires an explicit file selection;
- events/secrets.lock serialises database-derived reference enumeration, creation, rotation, deletion and migration.

The database is the complete reference ledger. Keys never enter SQLite, control replies, logs, audit records, the CLI JSON envelope, or MCP. Migration copies/read-back verifies the database-derived set before atomically changing only the events selector; core migration demonstrably neither sees nor changes event secrets.

“Per-rule projection keys” means per-rule projection encryption, not a new undocumented per-rule master-key hierarchy. D8 fixes HKDF-SHA256 table subkeys from the selected installation master, with info agentcomms-events/<table>/v1. Each ingest_rules encryptedProjection is protected under that table key with exact AAD including eventId, ruleId, and ruleVersion; moving it to another projection fails authentication. All encrypted columns use D8’s packed v1 record, 96-bit CSPRNG nonce, key id, durable per-(keyId, table) invocation counter, and byte-for-byte AAD encoder. Rotation introduces a new master id and re-encrypts bounded transactional batches. A missing master or an authentication failure takes the prescribed unreadable/reset path; it never falls back to plaintext.

The alternatives are worse: putting the master in config.json exposes it to channel/config migration; reusing the core namespace permits reference collision; a per-rule derivation changes the normative D8 hierarchy; a native encrypted SQLite extension adds an install-script/native-release risk while obscuring AAD contracts.

### 4. Versioned local control is a Unix socket/named pipe client boundary

Use a pathname Unix-domain socket below the owner-only events directory on Unix, and a named pipe ACLed to the current SID on Windows. A random 32-byte control token lives in an owner-only token file; only its fingerprint is stored in the instance record. Unix also obtains and checks same-uid peer credentials. TCP loopback is rejected: it cannot provide the Unix peer-uid property and would turn the intended local boundary into a port-discovery problem.

Frames are D12 length-prefixed UTF-8 JSON. A client sends hello with supportedVersions, token and a bounded client descriptor. The owner chooses the highest mutually supported integer version or returns PROTOCOL_UNSUPPORTED; it then issues an in-memory session id. Requests and success/failure envelopes exactly follow D12. Unknown, expired, malformed, wrong-version, unauthenticated, oversized, and duplicate-request-id frames have stable typed errors and never leak a token or provider/target-controlled text. The MCP stdio server and CLI both construct an EventControlClient; they call the same operations over that client. Only run starts the owner and is a parity exception because an MCP tool cannot sensibly start its own server.

The instance record includes pid, process-start identity, endpoint and token fingerprint. A new run performs an authenticated probe. It recovers stale files only after a dead pid and failed authenticated probe; a live pid, live socket, identity mismatch, ownership mismatch, or successful hello refuses recovery. Recovery and shutdown remove endpoint/token/instance records only if their instance id still matches.

### 5. Core disclosure is a discriminated approval member, not a change approval

Extend core with the fourth ApprovalKind, disclosure, as a true discriminated stored/public union, preserving old send/change/download decoding. The disclosure member contains only D2’s common approval fields and DisclosureBinding; it does not acquire inbox, draft, send-policy, risk, change, or download fields by optionality. Canonical activation documents are built and re-derived by the daemon; versions are sorted and cannot be caller supplied.

createDisclosure only creates pending. approveDisclosure accepts terminal or app only and only pending to approved. claimForDisclosure accepts approved only, creates the existing exclusive claim marker, atomically writes immutable usedAt, and returns the exact persisted timestamp. Chat/MCP may prepare/explain a request but cannot approve or claim. Every kind dispatcher, public view, list/revoke path, refusal, cancellation, mismatch and parsing branch becomes exhaustive; no unknown kind defaults to send. Existing terminal approval semantics stay unchanged.

Audit gains surface app|daemon and an origin field; autonomous daemon work says daemon/daemon and work requested by CLI/MCP/app says daemon with the requesting origin. The taint base source remains header|body. Event-versus-read origin lives only in the owner-only origins.json sidecar, with sidecar-lock then base-taint-lock ordering held across both atomic writes. Missing sidecar entries read as read, and an old core writer cannot erase event provenance.

Task 3 inserts these exact B1 SECURITY.md bullets, with no Laya wording:

> - **Disclosure without a standing authorisation** — any webhook or subscriber stream receiving event-derived content, or any hosted or local judge being invoked with it, without an active, digest-bound standing disclosure authorisation for exact approved versions, or versions derived from them by a whitelisted tightening, including the complete validated derivation lineage for the exact effective rule, target, subscriber and judge versions; after that authorisation is revoked; while the judge's kind is not enabled; outside its approved mapping, retention or delivery rate cap; or without successful taint recording before disclosure.
>
> - **A standing disclosure authorisation is not approval of each event.** Once a person enables one at the terminal or in the app, future unseen content that matches its approved rule may leave automatically through its approved target or be evaluated by its approved judge. agent-events doctor and the app list every active authorisation. Disabling or removing any bound rule, target, subscriber or judge, or disabling a judge kind, revokes it immediately; content already in a network operation cannot be recalled.

### 5a. One shared live-disclosure fence

`assertDisclosable` is the one daemon-owned live fence. It accepts the exact bound rule/target/subscriber/judge versions, account, switch generation and intended boundary, and returns only a content-free authorisation snapshot or a stable refusal. It is called before a source worker admits or projects content, before activation/recovery resumes work, before evaluation/dispatch appends a delivery, and before a terminal dry-run read decrypts a row. No caller may replace it with an active-pointer lookup, a lifecycle-only check, or a cached result.

For an exact activation, the fence verifies the bound rule version’s immutable approval and authorisation-activation ids against the used core disclosure record and its exact canonical activation document: activation kind, digest, sorted version list and the persisted digest of every named immutable version must agree. For a derived tightening, it starts at that rule version and walks `derived_authorizations` to that exact activation, refusing a missing or malformed edge, a repeated version, an incorrect parent rule/version or approval, a non-whitelisted/non-tightening edit, a canonical-document or binding-digest mismatch, or a chain which does not end at the bound used approval. It verifies rule lifecycle, every bound-object revocation, enabled generation and live account at the same boundary. A superseded version with retained work may pass only through its own valid immutable lineage; a revoked version never does.

The helper is deliberately used on recovery as well as live worker paths: restart cannot turn a formerly accepted, malformed or later-revoked lineage into a release. Tests inject malformed, cyclic, wrong-parent, digest-mismatched and revoked chains into the database at both dry-run append and read boundaries; each must refuse before source admission, decrypt, append or content rendering.

### 6. B1’s control surface is the smallest usable service slice

B1 needs real, parity-tested operations to create inert versions, prepare/approve/complete a Gmail-to-dry-run activation, observe health, and shut work down safely. Its capability rows are:

| Area | B1 operation set | Surface |
|---|---|---|
| Catalogue/source health | catalogue list/show; sources list; source show; status; doctor | CLI and MCP |
| Rule/target versions | rules list; rule show/create/update/enable/disable/remove; targets list; target add/update/remove | CLI and MCP |
| Runtime | pause/resume; disable-all/enable-all; stop | CLI and MCP |
| Authority/read | approve; dryrun list/show; run | explicit CLI-only exceptions |

Rule enable prepares or resumes the immutable activation intent; terminal approve completes the D2 challenge/claim path. The only B1 target shape is dry-run. The CLI always talks to the control client except run. MCP never reads a dry-run row, approves/claims disclosure, starts a daemon, or receives content-bearing data. The terminal dry-run renderer decrypts only after every live fence passes and renders strings through the untrusted renderer; JSON output for dry-run content is refused.

This is intentionally not the whole D10 list. B3 adds rule test/test-retained, target test, delivery/hold controls, subscribers, all secret operations, judges/budgets, and the rest of the reference surface. It also adds `target resume` as a terminal/app-only exception: MCP has no tool or schema for it. The source/operation names are exported functions under packages/events-daemon/src/operations, and every B1 command/tool pair has a capabilities.json operation row driven by pnpm verify:parity --strict.

The exposure order is part of the safety plan: Task 4 lands `status` with a `both` row; Task 6 lands `run` as an exception and `stop`, pause/resume, disable-all/enable-all and `doctor` as `both` rows; Task 9 lands catalogue/source/rule/target operations as `both` rows and terminal `approve` as an exception; and Task 13 lands terminal dry-run list/show as exceptions. Each task drives its new rows through the sealed parity harness before its required root verification. Task 14 may audit those rows and regenerate references, but may not be the first task to expose an operation or add a row.

The spec’s B1 “human-only safe reads” and B3 “dry-run reads” wording conflict. This plan implements the B1 requirement now and treats B3 as expanding/auditing the exception catalog, not first introducing reads; the round-1 phase-allocation decision below adopts that interpretation unless the owner overrules it.

### 7. Gmail B1 is history.list plus only necessary reading

Add a Gmail event-source adapter in packages/gmail/src/operations/events.ts. Extend only GmailTransport and its existing loopback fake with users.history.list, metadata reads usable for event classification, and the exact full-message/lazy attachment reads already guarded by the Gmail adapter. The daemon never constructs a Google client or bypasses GmailTransport.

For each account, the adapter keeps exactly one unfiltered mailbox cursor. It follows every history page before final cursor commit; it uses messagesAdded, labelsAdded and labelsRemoved instead of generic messages and de-duplicates specific changes. For messagesAdded it reads observation-time metadata, skips DRAFT, classifies SENT as sent and the remaining eligible item as received, then applies the rule’s explicit label selector and includeSpamTrash. labels any never bypasses the DRAFT rule. Labelled events are built from their own label-change record and preserve the first durable observedAt. A history 404 re-baselines at getProfile historyId and writes a content-free source gap; it does not backfill.

The source stages only sanitised, typed source values. It fetches a body/attachment only for an otherwise eligible active per-rule projection that needs it. A 404 yields the content-free vanished resolution; another read/decode/sanitise/schema failure retains encrypted retry state from the first failure, with capped backoff until the earlier of 24 hours and stage expiry, then unresolvable or retention-expired as D3 requires. A metadata-only projection may complete while a body projection reaches a terminal resolution. The cursor advances only with the final durable result. K2-3 remains adapter guidance: attachment boolean-only projections do not force materialisation.

### 8. B1 merge and first hand publish

B1 merges with both @agentcomms/events and @agentcomms/events-daemon held. Normal CI, package verification, tarball consumer tests, licence generation, version synchronisation and the browser vector job all run; scripts/packages.mjs omits both held packages from the tag publish list. No B1 task runs npm publish or adds a registry credential.

When the owner decides a released daemon is wanted, they make a normal lockstep version/release commit that removes both holds. They tag it only after the complete release checks pass. From that exact checked-out tag the owner:

1. runs pnpm install --frozen-lockfile and pnpm build;
2. hand publishes @agentcomms/events first with pnpm --config.pnpmfile=scripts/record-git-head.cjs --filter @agentcomms/events publish --access public --no-git-checks --tag latest;
3. configures the repository release workflow as trusted publisher for @agentcomms/events;
4. hand publishes @agentcomms/events-daemon from the same tag with the same command form and adds its trusted publisher; and
5. pushes/reruns the tag release after its OIDC preflight can prove both packages trust the workflow.

Events must precede the daemon because the daemon has an exact runtime dependency on it. The owner does this only when the daemon’s first real consumer release is intended, not when B1 merges. If that release is a prerelease, use next rather than latest as docs/RELEASING.md prescribes.

## Decisions on the phase-allocation amendments (review round 1)

The review judged B1-A, B1-C, B1-D and B1-E safe plan decisions: none weakens a safety invariant. B1-B is adopted with the correction below. The owner may overrule any of these decisions.

| Id | Lines | Issue | Proposed amendment |
|---|---:|---|---|
| B1-A — adopted | 2823, 2825, 2049-2057 | B1 explicitly owes human-only safe dry-run reads, while B3 says it adds dry-run reads and all exception rows. | B1 introduces terminal-only dry-run list/show and their exception rows; B3 broadens/completes D10 and audits them, without duplicating the feature. |
| B1-B — adopted as corrected | 1740-1750, 2824-2825 | D8 requires reset/barrier semantics when a key is lost, but B2’s phase row assigns durable reset barriers/degraded resume. | B1 creates and enforces the local dry-run reset append barrier. B2 adds the network-target barriers and degraded network behaviour. B3 keeps `target resume` terminal/app-only, with MCP excluded; neither B1 nor B2 exposes it. |
| B1-C — adopted | 1404-1558, 2823, 2827-2829 | D8 enumerates all future-source, SSE and judge tables as one database while B1 owns Gmail/dry-run only. | v1 creates B1 tables and future phases add their listed tables with forward-only migrations; the database and migration authority remain one. Before any future source is enabled, its migration must create D8’s exact schemas and AAD contracts for the tables it uses. |
| B1-D — adopted | 2823 versus 2827 | B1 says activation points “for every source” while B1 explicitly builds Gmail only and D is the other-source phase. | B1 provides generic activation-point schema and lifecycle, but only Gmail has a runnable acquisition/baseline adapter; other source activations are refused until their phase. |
| B1-E — adopted | 1913-1941, 2016, 2823, 2825 | B1 names an independent event secret store/migration, while B3 names the public terminal/app secret-operation set and migration. | B1 implements and tests the independent backend/migration engine and selector; B3 exposes the terminal/app command/exception row. No B1 model-facing secret operation exists, and a failed keychain selection remains fail-closed. |

Phase A owner-facing amendments A-K2-1 and A-K3-1 are not reopened. B1 follows the established normaliser boundary and the amended synthetic fixed bytes.

## Decisions made during the build (committee)

Each was put to a committee of three (spec and plan fidelity; safety and the people who run it; devil's advocate), then decided by the coordinator. The owner may overrule any of them.

| Id | Found in | Question | Decision and reason |
|---|---|---|---|
| K4 → B1-F | Task 5 review | Node 22.12, the floor decision 2 assumed, has node:sqlite only behind `--experimental-sqlite`; Task 4's `status` imported it statically, so the built command crashed there even for `--help`, and the old-node test never opened a database. Raise the floor, keep 22.12 with the flag, or stop? | Unanimous: raise only the daemon to Node 22.16.0 with WhatsApp's pattern (lazy loader, named CONFIG refusal, `engines`), test both edges in the old-node job, and record it here. A flag in a process that holds the event keys, or a re-exec wrapper, is worse than a stated floor; the package is held, so no installed user is affected. Decision 2 and Task 4 are amended in place. |
| K5 → B1-G | Task 6 review | D12 says the daemon verifies peer credentials have the same uid, and on Windows uses a pipe whose ACL grants only the current user's SID. Node has no peer-credential call and cannot set a pipe ACL; the built adapter returned the server's own uid as the peer's (always true) and asserted a Windows ACL it never checked. | Unanimous. **Unix:** the kernel-enforced boundary replaces the call: the socket lives in a directory owned by this uid with mode 0700, under ancestors owned by this uid or root that others cannot write (or that are sticky), and the socket is this uid's with mode 0600. The owner re-proves the directory for every accepted connection; a client proves directory and socket before sending its token; the token stays the second check. Only this uid and root can reach it, and root defeats a peer-credential check too. A socket path longer than the platform's `sun_path` (macOS 103 bytes, Linux 107) is refused by name. **Windows:** the event service refuses in B1 (`WINDOWS_CONTROL_UNAVAILABLE`) and no Windows client sends a token, because the global pipe namespace lets another user squat the name and receive it; a later phase with an ACL-capable pipe owner lifts this. The pipe name is a full SHA-256 of the state path. D12's literal call is replaced, not met; the owner may overrule. |
| — (spec-literal) | Task 6 review | The built `disable-all` deleted decisions, deliveries, cursors, ingest and the delivery-cap charges, and cleared pause. | Coordinator, by D12's words: it cancels queued/retryable deliveries and marks disclosing ones `in-flight-at-disable`, purging each record (a terminal delivery's `encrypted_record` may now be NULL; queued, retryable and disclosing work may not); purges dead-letter payloads, dry-run rows, staging, projections and staged positions; cancels incomplete activations; keeps the content-free ingest, the mailbox cursor (D8: enable-all does not replace it), terminal decisions, resolutions and every cap charge; and leaves pause as it was. Each operation's own error code now crosses the control channel in D12's failure envelope. |
| — (spec-literal) | Task 7 review | The built rule document dropped D2's optional exact `cloudEventType` override, and a rule's embedded target, subscriber and judge copies were never compared with the stored versions they name. | Coordinator, by D2's words: the override is part of the canonical rule when present (validated by Phase A's `validateCloudEventType`, absent meaning the D6 default), and a test changes every leaf of a rule document to prove none is dropped from the digest. A rule may embed only stored versions, byte for byte in one canonical form, at save and again at prepare — otherwise an approval could show one retention or model while delivery used another. |
| — (spec-literal) | Task 9 review | (a) The daemon build inlined everything, so once it imported Gmail it carried core, Gmail and `@napi-rs/keyring`'s macOS arm64 native binary; the builder patched the licence script instead. (b) The derived-lineage check accepted any source-option change as a narrowing and never compared the rest of the rule, so a "lower the cap" edge could also add mapping fields or loosen the source. (c) The fence's refusals were untested. (d) Disabling a rule left its superseded versions authorised. | Coordinator, by D2/D12 and the existing packages: (a) core, events and Gmail stay installed runtime dependencies and the keychain module stays external, as `gmail-mcp` does; the licence script is unchanged and a test refuses any `.node` file in a bundle. (b) `isWhitelistedTightening`: each edge kind changes exactly its own field, strictly narrower (source by D4's classifier, mapping only by removing output-object properties), with the rest byte-identical; a derived row is its own lineage id under the root approval; enable-all recovery proves each listed rule's lineage. (c) A refusal matrix covers every exact-branch fact and a derived lineage. (d) Disable revokes every live version. `approve` stays CLI-only with core's terminal speed bumps; SECURITY.md already states an agent with a shell is outside the boundary. |
| — (spec-literal) | Task 10 review | (a) A scan interrupted by a pending occurrence re-listed from its cursor on the next scan, reused the staged page by index but took the final cursor from the fresh response — so mail arriving in between was committed past without ever being processed. (b) Labelled occurrences skipped the rule's selector and `includeSpamTrash`. (c) An absent or empty address display name came out as `""`. | Coordinator, by D4/D3: (a) an already staged page is resumed with its own next-page token and final cursor and is not asked for again; later mail is read from that cursor by the next scan (a test fails with the original logic); an aged-out cursor is then rebaselined on that next scan, after the drain. (b) A labelled occurrence is matched on the union of its own added and removed label ids, for the selector and spam/trash. (c) It is `null`, never synthesized. |
| — (spec-literal) | Task 11 review | The revocation purge took a rule id only, so a derived tightening of the active version, or removing a target bound only to an older superseded version, also purged work still authorised under the other live version. | Coordinator, by D2/D8 (superseded work stays deliverable through its own valid lineage; only revoked work may not cross a boundary): the purge takes the exact revoked versions — the displaced parent for a tightening, the bound versions for a target removal, every live version for a disable. A test fails with the rule-wide purge. |
| — (spec-literal) | Task 12 review | (a) The decision/outbox transaction re-checked nothing after the fence, so a disable-all, revocation or account removal during decryption, encryption or taint let the commit recreate purged work. (b) An expired projection waited behind the fence, so a refused authority held it — and the mailbox cursor — indefinitely. (c) A mapping that rejects an event (D6's default `reject`, or the size limit) threw out of evaluation, failing every scan of that mailbox. | Coordinator, by D12, D8 and D6: (a) the commit requires the projection to still exist and, for disclosing outcomes, the switch on at the fenced generation; a purged projection is terminal, a moved generation leaves it pending. (b) Expiry settles content-free before the fence. (c) A rejecting mapping is one terminal `mapping-rejected` decision with no delivery and no taint (the spec names no outcome; the cursor rule requires a terminal one). |
| — (spec-literal) | Task 13 review | (a) The delivery cap counted charges per rule version, so a tightening that lowers the cap started a fresh window (60 → 30 could deliver 90 in an hour). (b) The expiry sweep deleted expired projections without their content-free terminal outcome. | Coordinator, by D2 ("no new cap charge can exceed the lower rolling-window limit") and D8: (a) the rolling window belongs to the rule — every version's charges in the last hour count against the current version's cap; (b) the sweep records one `retention-expired` decision with the purge, in one transaction. Both have tests that fail without the fix. |
| — (spec-literal) | Task 15 review | Run outside the builder's sandbox, the end-to-end test failed: the owner opened core without a caller, so the Gmail source it was handed could not build its transport (every real activation would have failed); and, once past that, the owner's built Gmail ignored the loopback override — by design, only source honours it — and the token refresh reached Google's real token endpoint with the fake credentials (`invalid_client`; nothing sent, no data). | Coordinator: the Gmail source opens its own context, and so core with Gmail's caller, for the daemon's folders; `startEventOwner` takes an injected `gmailSourceFor` (production leaves it unset), and the test injects the fake-backed source. A loopback-only seal (`test/helpers/loopback-seal.mjs`) is installed before the test runs and is itself tested; with the injection removed, the test now fails at the seal instead of reaching Google. |
| — (spec-literal) | Code review round 1 | Five P1 integration gaps, each verified: (1) the owner ran no worker, evaluator or dispatch loop, so an enabled rule ingested nothing; (2) activation and derived tightening copied ciphertext across tables, so a cut-over point could not be decrypted at its own AAD; (3) a drained replacement was never finalised while the daemon ran; (4) a removed account's work was re-queued at dispatch rather than purged; (5) the lazy body fetch had no production caller, so body-dependent rules lost their events. | Coordinator, by D3, D8, D9 and D12: an owner scheduler (`runtime/scheduler.ts`) sweeps expiry, purges removed accounts and resumes claimed completions every tick, and — only while enabled and unpaused — polls each bound Gmail account and dispatches due local deliveries; every point is encrypted for its own row; an ACCOUNT_REMOVED refusal purges at every boundary; the worker materialises `body` for the rules that need it. In review of the fix the mailbox cursor now starts at the oldest active point (each rule still admits only what follows its own), an active version without a point admits nothing, and scheduler health rows stay bounded. The end-to-end test now drives the owner's own tick. |
| — (spec-literal) | Code review round 2 | (a) Startup lease recovery dispatched before the pause was checked, and the fence does not read pause, so pause–crash–restart appended dry-run content while paused. (b) No production pointer mutation joined a claimed completion, so a derived tightening could swap the pointer under a draining replacement; the replacement then could never resume or settle, its old version held the mailbox, and startup recovery threw. | Coordinator, by D12 ("the global pause stops … delivery claims"; "only revoking actions may cancel a completion fence"): the dispatcher refuses to claim, and releases at append, while paused; startup no longer recovers leases (the scheduler does, only while enabled and unpaused). Every rule-pointer mutation joins a claimed completion binding that rule, or any enable-all, as `ACTIVATION_COMPLETING`; a claimed completion whose binding no longer holds is settled — cancelled with its baselines and drain rows — at every tick and at startup, and one draining intent no longer holds back the others. |
| — (spec-literal) | Code review round 3 | Two writes after an await re-checked nothing: (a) a history page that returned after a disable-all (or an account removal) was staged anyway, recreating purged staging; (b) an activation baseline that returned after its intent was cancelled re-inserted its baseline and drain rows, which nothing then cleaned up. | Coordinator, by D12's post-provider generation fence (the same rule as Task 12's commit): a scan snapshots the switch and the account at its start, and every write it makes — the materialiser's included — re-checks that snapshot inside its own transaction and writes nothing once it has moved; a baseline is written only while its intent is still claimed at its planned generation. |
| — (spec-literal) | Code review round 4 | The same class, wider: (a) a removal from core's configuration reached the database only on the next tick, so a scan, an activation, a decision or a dry-run append in flight could still write for an account that was gone; (b) a projection insert after its encryption could recreate work a disable-all, a revocation or a stage purge had removed; (c) a page staged after its last rule version was revoked owed nobody and would never be resumed or purged; (d) a dry-run read fenced only before its decryption. Building the tests also found an account removal answered as an expired Gmail history, with a rebaseline call to the provider. | Coordinator, by D9 (the configuration is read at each boundary, never cached) and D12: core's configuration is read again immediately before each final write — staging, persisted resolutions, the cursor commit and rebaseline, the initial cursor, the baseline, the pointer transaction, the decision commit and the dry-run append — and a removal there purges the account's work and records the tombstone at once; a projection is inserted only while its stage, its rule version and the switch are still live; a page owes only the versions still live when it is written, and is not written for none; a read fences again after decryption and returns nothing once its record is gone; a removal is never re-baselined. Each check is mutation-tested; one (admission returning terminal for a projection not kept) is equivalent, since evaluation already settles a missing projection. |
| — (spec-literal) | Code review round 5 | D9's removal list was short: an account's activation points survived its removal, so a reconnect of the same stable id resumed from a cut-over taken before it and backfilled the mail received meanwhile; its source resolutions and undecided ingest records survived too, and a rule version only it bound stayed active. Four source commits (ingest identity, resolutions, lazy retry state, derived points) and the projection insert still checked only the tombstone; and a plain Gmail 404 still led to a `getProfile` call before the configuration was read. | Coordinator, by D9's list: the purge deletes the account's points and resolutions and revokes every live version whose source names only that account (its pointer goes; a multi-account version stays live for its other ids). D9 also says to purge its ingest records, but a terminal decision references its ingest row and D9 keeps that delivery's cancelled or in-flight outcome: undecided ingest rows are purged, and a decided one stays as that content-free decision's identity until the decision goes. Every source-worker write goes through one commit that reads the configuration first; every Gmail call (history, metadata, profile, lazy body) is preceded by it; the materialiser, the derived point copy (which also skips a parent point purged meanwhile) and the projection insert read it after their awaits. Mutation-tested; one (re-throwing a removal from the metadata catch) is equivalent, since the next commit throws it anyway. |
| K6 (committee: spec-literal, safety/consumers, devil's advocate — unanimous) | Code review round 6 | Round 5's purge deletes a removed account's points but keeps a multi-account version live for its other accounts. When the same stable id is added back, what happens for that version? It had no point, so no cursor and no polling, and a replacement waited for ever on a drain for an account the old version no longer polled — nor could it complete while the account was still removed. | Option A, stay dark until re-approved: the version never polls the re-added account again until an approved activation (a replacement or enable-all) takes a fresh cut-over for it. D9 says the version "can no longer poll, judge or disclose the missing one", every point comes from an approved activation (D2, lines 985–991), and enabling or widening needs approval outside the chat (lines 145–146); a stable id can also name a different mailbox after a re-authorisation, so resuming on the daemon's own would apply an approval to a mailbox the person never saw (Option B rejected); revoking the version for its other accounts contradicts D9 (Option C rejected). So an active version polls an account only where it holds a point at its current cut-over; a replacement plans the old version's accounts only where it still polls them (in the configuration and holding a point), and opens a drain only there; enable-all plans only accounts in the configuration, which re-samples a re-added one. Showing a dark account to the person ("awaiting re-approval") belongs to B3's lineage `doctor` and is owed there. |

Builders of later tasks must also know: `EventRecordCipher.encrypt()` reserves its nonce-counter invocation in its own `BEGIN IMMEDIATE` transaction and awaits the master, so it must run before, not inside, a caller's write transaction; a reservation whose write later rolls back only spends a counter, which is safe. Key rotation rewrites a row only if it still holds the bytes it read.

## Ambiguities resolved by this plan

| Lines | Ambiguity/contradiction | Resolution and reason |
|---:|---|---|
| 1399-1403, 1837-1850 | It says daemon-owned SQLite is authoritative but does not state initial switch state. | Initialise enabled = false and generation = 0. Collection needs an approved enable-all; this is the only fail-closed reading of standing authority. |
| 152-205, 206-247, 2823, 2828 | B1 needs all four documents and judge-kind bindings, while no judge kind is usable before E. | Persist/validate the judge-budget and judge-kind document shapes and refuse their activation/call paths with JUDGE_KIND_DISABLED. Deterministic rule activation is usable; this preserves digest compatibility without creating an early judge. |
| 1661-1738 | “Per-rule projection keys” could be read as requiring a new key per rule. | Use the normative installation-master to table-subkey hierarchy, with rule/version primary keys in AAD. Inventing a rule hierarchy would contradict the prescribed HKDF info. |
| 2352-2376, 2813-2814 | The daemon is described alongside later tray/CLI lifecycle but B1 has no desktop or OS-service design. | Foreground owner only, with authenticated stop and stale recovery. No auto-start/detach is implied. |
| 720, 595-605, 633-653 | Gmail history items can lack labels/content while observedAt must be stable. | Stage an occurrence before accepting it as observed only after the required metadata classification response; persist its sampled observedAt and reuse it for retries. |
| 503-529 | “Except the two Laya bullets” applies to two separate SECURITY.md sections. | B1 adds exactly the two disclosure bullets (506-511 and 519-523), leaving both Laya bullets to E2. |

## Execution map and safe parallelism

| Batch | Tasks | Parallel worktrees |
|---|---|---|
| 1 — authority and discoverability | 1, 2, 3 | Tasks 1 and 3 may start in separate worktrees; Task 2 is independent and may run in a third worktree. Integrate/rebase all three before the batch verification. |
| 2 — one protected owner | 4 → 5 → 6 | none |
| 3 — Gmail baseline and activation | 7 → 8 → 9 | none |
| 4 — Gmail acquisition and replacement completion | 10 → 11 | none |
| 5 — durable local disclosure | 12 → 13 | none |
| 6 — parity audit, references, packages and handoff | 14 → 15 | none |

Do not merge parallel worktree changes by copying generated files. Rebase the later task, rerun its named tests, then rerun the batch’s full pnpm verify. No task may weaken the sealed parity runner, use a real provider, or bypass the Gmail send gate.

## Batch 1 — authority and discoverability

1. **Riskiest tooling task — make service declarations first-class and parity-drivable.**

   **Files.** Change scripts/channels.mjs, scripts/packages.mjs, scripts/registries.mjs, scripts/operations.mjs, scripts/sync-reference.mjs, scripts/parity.mjs, test/channel-registry.test.mjs, test/release-packages.test.mjs, test/parity.test.mjs, test/manifests.test.mjs, test/install-docs.test.mjs and test/printed-command-construction.test.mjs.

   **Tests first.**

   - Add a copied-tree fixture service with exactly the D14 declaration, a bin, CLI program, MCP factory and operations directory. Prove it appears, without a registry list edit, in PUBLISHABLE, SURFACES, DRIVERS, reference paths and one executed both-surface parity row.
   - Prove a service is refused for missing/unknown declaration keys, a mismatched binary/bin key, bad server entry/factory, missing operations directory, private status, a channel field, or a service marked library.
   - Keep the existing library proof: libraries alone are published but surface-free. A service has no library exemption.
   - Prove services use declared CLI/program/server/factory/operations paths; operationsDir does not assume a channel layout; the sealed driver substitutes service operations before importing either surface.
   - Prove a held service is still PUBLISHABLE and consumer/licence/version checked but absent from PACKAGES and from release preflight/publish/confirm.

   **Then the implementation.**

   - Extend the declaration walk to return services separately from channels and libraries. Validate the closed service shape exactly; do not widen the core channel-manifest schema.
   - Feed services into publication order, surfaces, drivers, generated references and parity. A service’s manifest supplies its path/factory instead of package-name special cases.
   - Update registry and parity diagnostics to say service where appropriate. Make the synthetic service’s CLI and MCP adapters call its one stub operation so behaviour, not names, is tested.

   **Mutations.**

   - Remove services from SURFACES: the copied-tree automatic-discovery test fails.
   - Treat service as a library: parity must reject the surface-free service.
   - Hard-code events-daemon in a registry: the fixture discovery/no-list-edit test fails.
   - Let the service operation directory fall back to src/operations without the declaration: malformed-path tests fail.

   **Run.** node --test test/channel-registry.test.mjs test/release-packages.test.mjs test/parity.test.mjs; then pnpm verify.

   **Commit.** feat(tooling): discover service packages and drive their parity surfaces (events phase B1, task 1).

2. **Core disclosure approval is an isolated, exhaustive authority.**

   **Files.** Change packages/core/src/approvals.ts, approval-binding.ts, approval-stored.ts, approval-outcome.ts, approval-handoffs.ts, approval-validate.ts, approval-maintenance.ts, audit.ts, errors.ts and index.ts. Add/update packages/core/test/disclosure-approvals.test.ts, approval-binding.test.ts, approval-outcome.test.ts, approval-store-read.test.ts, approval-surfaces.test.ts and audit.test.ts.

   **Tests first.**

   - Golden binding vectors cover all four activation kinds, sorted versions, empty enable-all only in its allowed shape, digest drift, every cross-kind claim order and old stored-record compatibility.
   - Cover create pending only; terminal and app challenge approval only; approved-only single claim; immutable returned usedAt; expiry/revoke/drift/cancel/crash recovery; and concurrent claim exactly once.
   - Prove chat/MCP approval/claim is refused, no unknown kind is interpreted as send, public list/revoke views are discriminator-safe, and old terminal approval still behaves identically.
   - Audit vectors distinguish cli/mcp/app/daemon surface and origin without admitting content.

   **Then the implementation.**

   - Refactor storage decoding/encoding to the discriminated union before adding disclosure fields. Add DisclosureBinding canonical validation and its three methods.
   - Ensure every generic transition uses an exhaustive kind switch and no wrong-kind claim can mutate a record.
   - Add approvedVia app only to disclosure’s trusted app route; do not treat an MCP/client form as app.
   - Add audit surface/origin unions and use them in approval event records.

   **Mutations.**

   - Allow claim from pending: the pending-claim test fails.
   - Derive usedAt on read rather than persisting it in claim: crash/restart and byte-equality tests fail.
   - Delete disclosure from one dispatcher switch: typecheck or exhaustive mismatch tests fail.
   - Accept via mcp: terminal/app-only tests fail.

   **Run.** pnpm --filter @agentcomms/core test; pnpm --filter @agentcomms/core typecheck; then pnpm verify.

   **Commit.** feat(core): add standing disclosure approvals with immutable claims (events phase B1, task 2).

3. **Taint origin sidecar and the B1 SECURITY.md disclosure wording.**

   **Files.** Change packages/core/src/taint.ts, packages/core/src/index.ts, packages/core/test/gate-support.test.ts, packages/core/test/config-secrets.test.ts where lock/file helpers are shared, add packages/core/test/taint-origins.test.ts, and change SECURITY.md.

   **Tests first.**

   - Cover event/read origin merge, missing sidecar decoding as read, header-over-body priority, map caps, old-writer touch after event write, and sidecar-only crash residue.
   - Deterministically pause writer A after sidecar commit; writer B cannot get the sidecar lock or prune A’s row; resume both and require event provenance to remain.
   - Check ordering is sidecar lock then base lock, both locks live over both atomic commits, and a flush failure returns before a disclosure caller can proceed.
   - Assert SECURITY.md contains exactly the two non-Laya D2 bullets and not the deferred Laya bullets.

   **Then the implementation.**

   - Add origin-aware observations/collector APIs without changing TaintSource.
   - Implement taint/origins.json with canonical address/domain/handle keys and the dual-lock reader/writer/pruner protocol.
   - Append the exact disclosure vulnerability and safety-model bullets from D2. Do not edit its Laya text.

   **Mutations.**

   - Reverse lock order: the deterministic contention/deadlock test fails.
   - Store origin inside taint.json: old-writer compatibility fails.
   - Treat a missing sidecar as event: migration read tests fail.
   - Remove a required SECURITY.md sentence: wording test fails.

   **Run.** pnpm --filter @agentcomms/core test; then pnpm verify.

   **Commit.** feat(core): retain event taint origin without weakening old writers (events phase B1, task 3).

**Batch 1 ends** with pnpm verify. It must exit 0; the checkout has no events-daemon package yet unless Task 4 has been integrated.

## Batch 2 — one protected owner

4. **Package skeleton, owner-only paths, the Node SQLite floor proof (B1-F), and the first parity row.**

   **Files.** Create packages/events-daemon/package.json, README.md, LICENSE, THIRD_PARTY_LICENSES, tsconfig.json, tsdown.config.ts, src/index.ts, src/cli.ts, src/cli/program.ts, src/mcp/server.ts, src/operations/status.ts, src/runtime/paths.ts and test/consumer-check.mjs. Add package tests for manifest, paths, CLI/MCP bootstrap, status parity and consumer. Change capabilities.json, pnpm-lock.yaml, scripts/record-git-head.cjs only if package discovery requires it, test/release-packages.test.mjs, test/manifests.test.mjs, test/install-docs.test.mjs, .github/workflows/release.yml and CONTRIBUTING.md.

   **Tests first.**

   - Assert the manifest is a non-private held service with exact bin/service declaration, exact runtime workspace pins, package files and consumer import.
   - Verify owner-only parent/file creation and refusal of link/reparse-point or weak-permission paths on platform-specific test doubles.
   - Build the package, run agent-events --help and a minimal MCP tools/list probe in a temporary state root, and prove their stdout protocols remain clean.
   - Add the non-pending `events.status` `both` row and drive the real status command and status tool through the sealed operation stand-in, proving both call `status` and no other operation.
   - Extend the old-node release test to execute the built agent-events --help/status fixture under Node 22.12 (refused by name, never a crash) and under 22.16 (node:sqlite resolves without native installation) — B1-F.

   **Then the implementation.**

   - Add the held service package with a non-network `status` operation, paired CLI command and MCP tool, and its `capabilities.json` `both` row in the same commit as the exposed surface.
   - Add path/permission helpers shared only inside the daemon. No config event field is introduced.
   - Update package/release discovery assertions and documentation for a service’s README/consumer contract.

   **Mutations.**

   - Remove agentcommsRelease.hold: held-package test fails.
   - Replace node:sqlite with a native dependency: manifest/dependency closure test fails.
   - Make the events parent world-readable: permissions test fails.
   - Remove the Node 22.12 or 22.16 command invocation: release-shape test fails.

   **Run.** pnpm --filter @agentcomms/events-daemon build; pnpm --filter @agentcomms/events-daemon test; node --test test/release-packages.test.mjs; pnpm verify:parity --strict; pnpm sync:reference (commit the generated docs/reference changes with this task, so `verify:reference` inside `pnpm verify` passes); then pnpm verify.

   **Commit.** feat(events): scaffold the held local events service (events phase B1, task 4).

5. **Riskiest persistence task — migrations, encryption and an independent event secret store.**

   **Files.** Create packages/events-daemon/src/store/database.ts, migrations.ts, schema-v1.ts, crypto.ts, aad.ts, records.ts, event-secrets.ts, retention.ts and test support fixtures. Add packages/events-daemon/test/database.test.ts, migrations.test.ts, crypto.test.ts, event-secrets.test.ts, retention.test.ts and fixtures/aad-v1.json. Change package exports only as needed.

   **Tests first.**

   - Create/open/migrate a fresh database; inject failure in each migration statement and prove an all-or-nothing version/ledger result.
   - Assert foreign keys, WAL/synchronous settings, one writer transaction, strict table checks, database identity persistence and database/WAL/free-page scans containing no fixture plaintext.
   - Verify D8 packed-record and required AAD hex vectors; swapped table/column/key components and wrong SQLite storage class fail authentication; counter limit refuses before reuse.
   - Verify fresh 128-bit installation id, stable restart/backup id, master rotation, unknown key id/lost key reset state, and no plaintext fallback.
   - Verify independent keychain/file selection, no fallback, namespace separation, file permissions, database-derived migration with rollback/leftover cleanup, and a released-core migration fixture that never touches event values.
   - Verify every B1 deadline row is fixed at creation and the dry-run cap rejects a value above 24 hours.

   **Then the implementation.**

   - Implement the migration runner and B1 table set described in decision 2.
   - Implement exact AES-256-GCM packed records, AAD, HKDF table-key cache, nonce/counter/rotation rules and unreadable-record classification helpers.
   - Implement EventSecretStore selection/reference reconciliation under its own lock. Reuse backend primitives only behind the daemon-owned adapter.
   - Centralise deadline calculation and encrypted row purge helpers; no worker may calculate a replacement deadline ad hoc.

   **Mutations.**

   - Omit ruleVersion from projection AAD: row-swap test fails.
   - Store a nonce/tag in sibling columns: record-shape test fails.
   - Read config.secrets.store: independence test fails.
   - Start a migration outside BEGIN IMMEDIATE: interrupted-migration test fails.
   - Extend dry-run expiry during retry/read: fixed-deadline test fails.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="database|migration|crypto|secret|retention"; then pnpm verify.

   **Commit.** feat(events): make encrypted SQLite and event secrets the sole event authority (events phase B1, task 5).

6. **Riskiest control task — one owner, authenticated control, global fences, and their parity surfaces.**

   **Files.** Create packages/events-daemon/src/control/protocol.ts, client.ts, server.ts, session.ts, instance.ts, peer.ts and test support; create src/runtime/owner.ts, lifecycle.ts and locks.ts; expand cli/program.ts, mcp/server.ts and src/operations/status.ts, run.ts, stop.ts, pause.ts, disable-all.ts, enable-all.ts and doctor.ts. Change capabilities.json. Add packages/events-daemon/test/control.test.ts, owner.test.ts, stale-recovery.test.ts, global-switch.test.ts, protocol-compat.test.ts and runtime-operation-parity.test.ts.

   **Tests first.**

   - Test length framing, version overlap/no-overlap, token/peer authentication, session expiry, request-id correlation, error shape, malformed/oversized input and no token in error/log/audit output.
   - Test Unix same-uid and socket permissions with injectable peer facts; Windows named-pipe/ACL facts with an adapter. Test that TCP is not an offered transport.
   - Test second owner refusal, authenticated stale probe recovery only with a dead pid plus failed probe, live-pid/identity mismatch refusal, crash cleanup and graceful stop.
   - Test client CLI and stdio MCP both reach the same stand-in operation through EventControlClient; run is CLI-only.
   - Test pause retains state; disable-all increments generation and atomically cancels/purges B1 staging, projections, decisions, delivery payloads and dry-run rows; stale-generation commits cannot recreate work.
   - Add and drive this task’s non-pending rows: `stop`, pause/resume, disable-all/enable-all and `doctor` are `both`; `run` is an explicit CLI-only exception because a tool cannot start the owner it requires. The sealed driver proves each paired CLI/tool reaches its named operation and the exception has no MCP registration.

   **Then the implementation.**

   - Implement protocol v1, endpoint/token/instance lifecycle and foreground owner loop.
   - Keep all database/session opening in run; clients get no store handle.
   - Implement global pause and disabled switch as distinct durable states; initialise disabled, and make enable-all an operation shell whose disclosure path arrives in Batch 3.
   - Add those capability rows and the paired adapters in this task; do not create a `pending` row or leave a discovered command/tool unlisted.

   **Mutations.**

   - Accept a request before hello: AUTH_REQUIRED test fails.
   - Recover a socket from a live pid: stale-recovery test fails.
   - Let MCP call run: exception/parity test fails.
   - Delete switch-generation recheck at commit: disable race test fails.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="control|owner|stale|switch|runtime.*parity"; pnpm verify:parity --strict; pnpm sync:reference (commit the generated docs/reference changes with this task, so `verify:reference` inside `pnpm verify` passes); then pnpm verify.

   **Commit.** feat(events): run one authenticated local event daemon owner (events phase B1, task 6).

**Batch 2 ends** with pnpm verify. It must exit 0 and no process is left running after the test suite.

## Batch 3 — Gmail baseline and standing-authority activation

7. **Canonical documents, inert immutable versions, and classification.**

   **Files.** Create packages/events-daemon/src/domain/activation-documents.ts, versions.ts, source-options.ts, lifecycle.ts and disclosure-preview.ts. Add packages/events-daemon/test/activation-documents.test.ts, source-options.test.ts, version-lifecycle.test.ts and fixtures/activation-documents-v1.json.

   **Tests first.**

   - Golden vectors cover rule, judge-budget, judge-kind and enable-all documents; sort/version-list derivation; every one-field mutation named by D2, including Gmail labels, selector transitions, spam/trash, account ids, mapping/retention/target changes and only reordering enable-all rules.
   - Prove source options reject wrong channel, empty/duplicate/unsorted label arrays and unknown type; classify every Gmail narrowing/loosening precisely.
   - Prove target/subscriber/judge versions are inert; no standalone activation exists; all new judge kinds are disabled; a deterministic rule can be prepared while a rule referencing a disabled judge is refused JUDGE_KIND_DISABLED.
   - Prove operational agentcomms types and fixed test/reset controls are nonselectable.

   **Then the implementation.**

   - Canonicalise documents with core canonical JSON and derive DisclosureBinding versions from, not beside, the document.
   - Persist immutable pending versions and D8 lifecycle columns. Add canonical full rule validation for the B1 Gmail source and dry-run target only; retain well-typed document variants needed for future judge forms without enabling them.
   - Create preview data from canonical documents only; strings remain sanitised/untrusted-rendered at a surface, never treated as trusted markup.

   **Mutations.**

   - Let callers submit binding.versions: derivation/digest-drift test fails.
   - Sort labels lexically instead of raw UTF-8: non-ASCII source option vector fails.
   - Mark a target active by itself: inert-version test fails.
   - Accept agentcomms.source.gap as a rule type: nonselectable test fails.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="activation|source option|lifecycle"; then pnpm verify.

   **Commit.** feat(events): bind immutable event versions into disclosure documents (events phase B1, task 7).

8. **Establish the real Gmail baseline adapter and loopback fake before any activation.**

   **Files.** Change packages/gmail/src/gmail-api/transport.ts and index.ts; create packages/gmail/src/operations/events.ts; change packages/gmail/test/support/fake-google.ts; add packages/gmail/test/events-transport.test.ts and packages/gmail/test/events-source-contract.test.ts; update any fake transport helpers required by TypeScript.

   **Tests first.**

   - Prove GmailTransport has one history-list method that accepts historyId/pageToken and returns specific change arrays/final history id; test unfiltered request parameters, multi-page replies, 404 cursor expiry, and provider error mapping.
   - Prove its real event-source adapter exposes a fake-backed `getProfile` baseline method, separate from scan and lazy materialisation; record that activation can use this method without a history/body read, normalisation, projection or delivery.
   - Prove event metadata reads contain labels/internalDate/headers/attachment metadata but no body bytes, and full/lazy reads use existing transport pathways.
   - Extend only the loopback fake Google routes with history fixtures, profile baseline replies, page tokens, per-message metadata, deletion/404 and request recording. Assert every test endpoint is loopback and no send route is invoked.
   - Prove the new operations/events adapter constructs its transport via existing Gmail context and never imports Google client classes in the daemon.

   **Then the implementation.**

   - Extend the narrow GmailTransport interface/real adapter and fake; preserve the existing send permit guard unchanged.
   - Implement a structural Gmail event-source adapter that exposes scan, one baseline-only `getProfile` call and lazy-materialisation capabilities to the daemon without a runtime dependency from Gmail back to the daemon.

   **Mutations.**

   - Add labelId to the history request: unfiltered-history assertion fails.
   - Implement baseline by scanning history: baseline-only request-recording test fails.
   - Return body bytes from metadata: no-body/retention fixture fails.
   - Add another Gmail send caller: repository send-path guard fails.

   **Run.** pnpm --filter @agentcomms/gmail test -- --test-name-pattern="event|transport"; pnpm --filter @agentcomms/gmail typecheck; then pnpm verify.

   **Commit.** feat(gmail): expose bounded history and profile baselines for local events (events phase B1, task 8).

9. **Riskiest activation task — prepare/approve/claim, points, first activation, live lineage fence and enable-all recovery.**

   **Files.** Create packages/events-daemon/src/runtime/activations.ts, baseline.ts, recovery.ts, account-fence.ts and disclosure-fence.ts; add operations/catalogue.ts, sources.ts, rules.ts, targets.ts, approve.ts and enable-all.ts; expand cli/program.ts and mcp/server.ts; extend store schema/repository modules; change capabilities.json. Add packages/events-daemon/test/activation-recovery.test.ts, enable-all.test.ts, account-fence.test.ts, disclosure-fence.test.ts, lifecycle-operation-parity.test.ts and fixtures/activation-crashes.ts.

   **Tests first.**

   - Cover pending intent insert/attachment, disclosure create, terminal/app approve, core used/usedAt, SQLite claimedAt copy, baseline response persistence, first active-pointer commit and completed-intent mark at every crash point.
   - Prove no provider baseline call happens before used authority; claimedAt is byte-identical to core usedAt; downtime counts toward exactly one hour; expiry/failure writes content-free stable detail and never retries/reclaims.
   - Drive the real, fake-backed Task 8 adapter: cover one Gmail `getProfile` baseline per account reused across fixed point rows, disabled-state narrow baseline exception, first activation no backfill, enable-all pointer/generation drift refusal and global disable winning over completion. A provider baseline before core `used` or a history/body call in this baseline path fails.
   - Prove all active-pointer mutations join used intents, return ACTIVATION_COMPLETING or REPLACEMENT_PENDING as applicable, and only revoking actions may cancel a completion fence.
   - Cover account disappearance at every source/append/read boundary with direct ConfigStore.load, no daemon identity cache, and atomically purged account work.
   - Define `assertDisclosable` and prove its exact-activation branch rejects wrong approval kind/state, activation kind, document/binding digest, sorted version list, immutable version digest, lifecycle, object-revocation, account or generation fence. Prove recovery invokes that same helper before resuming a used intent.
   - Add and seal this task’s non-pending capability rows: catalogue list/show, sources list/source show, rules list/show/create/update/enable/disable/remove and targets list/add/update/remove are `both`; `approve` is a terminal-only exception. Drive every paired CLI/tool to its exported operation and prove the exception registers no MCP tool.

   **Then the implementation.**

   - Implement intent planning with fixed point and acquisition-call sets, core disclosure lifecycle integration, ordered locks and recovery before accepting control calls.
   - Implement first activation and enable-all finalisation through the Task 8 Gmail baseline adapter. Use direct ConfigStore.load at each required boundary.
   - Implement account-revocation and global-disable paths using the transaction/purge helpers from Task 5.
   - Implement `assertDisclosable` as the only source/recovery/evaluation/dispatch/read authority resolver; it validates an exact used approval binding or the complete acyclic, valid derived lineage, not a current pointer alone. Add the listed operations, both-surface adapters and exception row in this same task; no task may expose a command/tool without its row.

   **Mutations.**

   - Sample a fresh completion deadline after restart: downtime test fails.
   - Start a baseline before claim: provider-call ordering test fails.
   - Let pointer update ignore a used intent: mutation-fence test fails.
   - Cache account identity: removal race test fails.
   - Replace the shared fence with a current-pointer check: immutable approval/digest test fails.
   - Register `approve` in MCP or omit a rule/target surface row: exception/strict-parity test fails.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="activation|enable-all|account|disclosable|lifecycle.*parity"; pnpm verify:parity --strict; pnpm sync:reference (commit the generated docs/reference changes with this task, so `verify:reference` inside `pnpm verify` passes); then pnpm verify.

   **Commit.** feat(events): recover standing-authority activation without backfill (events phase B1, task 9).

**Batch 3 ends** with pnpm verify. It must exit 0; a real Gmail baseline adapter is present, but no Gmail cursor worker, judge transport or external target exists.

## Batch 4 — Gmail acquisition and replacement completion

10. **Riskiest source task — one Gmail cursor, observation classification, staging and terminal lazy resolution.**

   **Files.** Create packages/events-daemon/src/sources/gmail.ts, source-worker.ts, materialise.ts and mailbox-lock.ts; extend store repositories and runtime/baseline.ts. Add packages/events-daemon/test/gmail-source.test.ts, gmail-materialisation.test.ts, gmail-stage-deadline.test.ts, gmail-source-recovery.test.ts and mailbox-lock.test.ts.

   **Tests first.**

   - Cover one mailbox cursor per account, no event/rule cursor, every history page before final commit, 404 rebaseline/gap/no backfill, and deterministic event-id collision stopping cursor advancement and degrading the source.
   - Cover messagesAdded metadata classification at observation time: DRAFT skip, SENT versus received, labels inbox/explicit/any, includeSpamTrash, and labelsAdded/labelsRemoved event creation independent of generic entries.
   - Cover first durable observedAt/occurredAt samples, crash before/after durable staging, and exact activated Gmail profile point storage.
   - Cover lazy body/attachment fetch only when an eligible projection needs it; 404 vanished, retry failure/unresolvable, stage expiry/retention-expired, one source gap only for unresolvable, unaffected metadata projection success, and no retry/fetch after terminal resolution.
   - Cover before/at/after the shorter first-staging deadline, downtime startup expiry, and cursor advancement only after every affected occurrence/projection terminalises.
   - Prove the per-account mailbox lock serialises a page’s durable stage and final cursor commit against activation/replacement baseline work, and that source admission calls the shared `assertDisclosable` fence before it decrypts, projects or advances an occurrence.

   **Then the implementation.**

   - Persist encrypted raw-page/occurrence continuation and durable retry state. Normalise through existing Gmail sanitisation/body logic plus Phase A catalogue validation.
   - Compute the Phase A event identity at durable ingest and compare the full preimage on unique conflict.
   - Implement the account-scoped mailbox lock around stage/cursor transitions and use the Task 8 adapter for scan/materialisation. The source worker calls `assertDisclosable`; baseline/P completion remains Task 11.

   **Mutations.**

   - Commit final cursor before a body resolution: cursor-order test fails.
   - Treat labels any as permission to include DRAFT: classification test fails.
   - Resample observedAt on retry: CloudEvent identity/byte test fails.
   - Fetch full bodies for all history rows: lazy-fetch counting test fails.
   - Turn lazy 404 into a source gap: vanished test fails.
   - Stage or commit a page outside the mailbox lock: deterministic interleaving test fails.
   - Bypass `assertDisclosable` on source admission: rejected-lineage source test fails.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="gmail|stage"; then pnpm verify.

   **Commit.** feat(events): ingest Gmail history through one durable mailbox cursor (events phase B1, task 10).

11. **Complete exact replacement only against the real Gmail worker and its mailbox lock.**

   **Files.** Change packages/events-daemon/src/runtime/activations.ts, recovery.ts, lifecycle.ts, retention.ts, disclosure-fence.ts, sources/source-worker.ts and mailbox-lock.ts, and relevant store repositories; add packages/events-daemon/src/runtime/replacements.ts. Add packages/events-daemon/test/replacements.test.ts, replacement-worker-race.test.ts, tightening.test.ts, revocation.test.ts and lifecycle-recovery.test.ts.

   **Tests first.**

   - Drive the Task 8 fake-backed adapter and Task 10 worker together. Cover a Gmail exact replacement: fixed union scope, P persisted before the drain, old-version processing inclusive through P, after-P staging withheld, and one atomic old-superseded/new-active pointer swap.
   - With deterministic failpoints, race a first activation and an exact replacement against (a) a source page before durable stage, (b) after the page stages but before final cursor commit, and (c) immediately before cursor commit. The mailbox lock and restart matrix must prove every occurrence is either pre-point baseline or admitted exactly once by the correct version: no backfill, duplicate or skipped occurrence.
   - Crash at every durable P, drain, stage, cursor and swap edge; restart through the actual worker and prove the same one-occurrence result. Cover a second replacement refusal while pending/draining, one-hour failure with the old pointer active, and disable/remove/tightening cancellation winning.
   - Cover every whitelist tightening as a derived version: inherited points, immutable acyclic parent approval lineage, old version revoked, only shortened deadlines and no approval. Inject malformed, cyclic, wrong-parent, digest-mismatched and revoked lineage rows into recovery and source-fence paths; each blocks effectiveness before a cursor commit.
   - Cover active/superseded/revoked fences: superseded bound work remains readable/deliverable only through its immutable valid lineage, while revoked work cannot cross any boundary and purges matching dry-run rows.

   **Then the implementation.**

   - Add `replacement_drains` and `derived_authorizations` transactions and explicit lifecycle transitions. The derived edge must name the immediate eligible parent rule/version and its bound approval, store the validated edit kind, and be committed with the derived version/pointer or not at all.
   - Acquire the Task 10 mailbox lock for baseline P capture, page stage and final cursor commit; drain P through the actual worker before the atomic swap. Keep after-P work staged until that swap; never compute P or complete a drain against a test-only adapter.
   - Exercise the already-shared derived-lineage branch of `assertDisclosable` against committed `derived_authorizations`, and make recovery and source resumption use that same implementation. Make doctor/status report content-free nonterminal/failed/cancelled intent state without returning content.

   **Mutations.**

   - Swap pointers before the real worker drains P: replacement sequencing/race test fails.
   - Let baseline, page stage or cursor commit escape the mailbox lock: no-backfill/no-duplicate/no-skip interleaving test fails.
   - Treat superseded as revoked: retained-work test fails.
   - Recompute point sets after claim: drift/fixed-plan test fails.
   - Permit a second pending replacement or accept a cyclic/wrong/digest-mismatched parent: uniqueness/lineage tests fail.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="replacement|worker.*race|tightening|revocation|lifecycle"; then pnpm verify.

   **Commit.** feat(events): drain real Gmail replacements before their pointer swap (events phase B1, task 11).

**Batch 4 ends** with pnpm verify. It must exit 0; all Gmail tests run solely against fakes/injected transport.

## Batch 5 — durable local disclosure

12. **Riskiest pipeline task — evaluate exactly one projection and complete its local outbox atomically.**

   **Files.** Create packages/events-daemon/src/runtime/evaluate.ts, projections.ts, decisions.ts, deliveries.ts, mapping.ts and untrusted.ts; change disclosure-fence.ts; extend store repositories. Add packages/events-daemon/test/evaluation.test.ts, decision-outbox.test.ts, event-identity-ingest.test.ts, disclosure-fence-evaluation.test.ts, taint-before-dryrun.test.ts and fixtures/dryrun-cloud-events.json.

   **Tests first.**

   - Cover deterministic conditions, mapping/provenance, Phase A target-key format dryrun:<targetId>:<targetVersion>, CloudEvent exact bytes and sender-content representation. No agentic condition invokes a judge.
   - Cover equal identity repeat versus injected hash collision (fatal source degradation/cursor unchanged), one decision per event/rule/version, one delivery per decision/target key, and exact rule/target version binding.
   - Inject failures after terminal decision insert, each delivery insert, projection purge and pre-commit; prove no partial decision/outbox state, and after commit exactly the complete outcome set with projection purged.
   - Cover projection minimisation: metadata-only and body-requiring rules over one occurrence retain independently and do not share a recoverable full event.
   - Cover sanitisation before mapping, durable untrusted-envelope boundary reuse, provenance-derived header/body taint with origin event, and a taint flush failure causing no dry-run append.
   - Prove evaluation calls the shared `assertDisclosable` fence before it maps or writes a decision/outbox; a stale/revoked exact binding or derived lineage leaves the encrypted projection retained for its ordinary terminal handling and creates no decision/delivery.

   **Then the implementation.**

   - Build per-rule projections from catalogue metadata and use @agentcomms/events for condition/mapping/CloudEvent; do not duplicate Phase A semantic logic.
   - Persist a delivery-stable untrusted boundary in the encrypted record before it can be retried; envelope only where the approved target representation requires it.
   - Call `assertDisclosable` at the evaluation boundary and, in one SQLite transaction, terminalise the decision, create all dry-run deliveries, and purge the projection. Do not introduce webhooks, SSE or a judge transport.

   **Mutations.**

   - Write a decision before all outbox rows: crash-completeness test fails.
   - Store the full event beside every rule: projection-minimisation scan fails.
   - Generate a new envelope boundary on retry: byte-stability test fails.
   - Append before taint flush: taint ordering test fails.
   - Map before the shared disclosure fence: stale-lineage evaluation test fails.
   - Reimplement cloudEventBytes with JSON.stringify: byte-vector test fails.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="evaluation|outbox|identity|taint"; pnpm verify:browser; then pnpm verify.

   **Commit.** feat(events): evaluate authorised Gmail projections into a local outbox (events phase B1, task 12).

13. **Dry-run delivery/read, leases, cap charging, retention and local reset fences.**

   **Files.** Create packages/events-daemon/src/targets/dry-run.ts, runtime/dispatcher.ts and runtime/expiry.ts; change disclosure-fence.ts and cli/program.ts; extend operations/dryrun.ts and doctor.ts, store schema/repositories and capabilities.json. Add packages/events-daemon/test/dryrun.test.ts, dispatcher.test.ts, delivery-cap.test.ts, expiry.test.ts, reset.test.ts, disclosure-fence-boundaries.test.ts, dryrun-operation-parity.test.ts and content-purge.test.ts.

   **Tests first.**

   - Prove only dry-run target validation exists; its retention is positive and no more than 24 hours; no package imports an HTTP/SSE client or opens a network socket.
   - Validate the persisted, approval-bound delivery cap at the append boundary and cover a full rolling window: exhaustion leaves the delivery `queued`, does no local append and makes no `delivery_cap_charges` row; a later slot appends exactly once. A lease crash/recovery around the one append transaction cannot double-charge its delivery, and dry-run reads consume no charge.
   - Cover worker lease crash recovery, boundary recheck through `assertDisclosable` of enabled generation/rule lifecycle/exact-or-derived lineage/object revocation/account liveness, append plus `delivery_cap_charges` insert plus delivered mark in one transaction, and cancellation races with disable/remove/account removal.
   - At both append and dry-run read boundaries, inject malformed, cyclic, wrong-parent, digest-mismatched and revoked lineage records. Each refuses before decrypt/append/render; no append, delivery state change or charge occurs. Cover encrypted dryrun_log append/read/expiry/purge; terminal renderer untrusted output; CLI TTY/agent-marker/JSON refusal; MCP tools/list absence and direct invocation refusal.
   - Run one cross-boundary fixture through source admission, recovery, evaluation, append and terminal read, proving all five paths call the same `assertDisclosable` resolver rather than a pointer/lifecycle shortcut; each invalid lineage shape is rejected consistently, with the required direct injection at append and read.
   - Cover all B1 retention outcomes, start-up expiry before source/control/read, content-free terminal rows, database/WAL/free-page fixture-byte scans, and a shortened-retention derived rule.
   - Cover a queued delivery expiring behind a full cap: it purges encrypted content at its original deadline without an append or charge. Cover lost master/database reset: fresh identity, no backfill, local dry-run reset barrier/notice append before ordinary local delivery, and a closed barrier stops ordinary rows. Network-target barriers and degraded network behaviour remain B2; terminal/app-only `target resume`, with no MCP tool, remains B3.
   - Add and drive non-pending terminal-only exception rows for dryrun list/show in this task. The sealed driver proves neither command registers an MCP tool and no discovered CLI command/tool lacks a row.

   **Then the implementation.**

   - Implement local append as the delivery boundary, not a logger bypass. Under one `BEGIN IMMEDIATE` transaction, revalidate the approval-bound cap, insert the unique `delivery_cap_charges` row for this delivery, append the encrypted dry-run row and mark delivery delivered; a full cap leaves it queued and untouched. Reads run the same live fence, never insert a cap charge, and delete expired/unreadable rows before rendering.
   - Implement B1 expiry/lease sweeps and a local-only reset-barrier state using the generic D8 state; retain no plaintext diagnostic error. Do not expose network degradation or a resume operation in B1.
   - Wire dryrun list/show operations, their terminal-only exception rows, and the explicit MCP absence in this same task.

   **Mutations.**

   - Add a dry-run MCP tool: exception/capability test fails.
   - Allow a non-TTY or --json content read: human-only renderer test fails.
   - Mark delivery delivered outside the append transaction: crash test fails.
   - Insert a cap charge outside that transaction or retry it after a recovered lease: cap atomicity/double-charge test fails.
   - Append while the rolling cap is full or let expiry retain queued encrypted bytes: cap exhaustion/expiry-purge test fails.
   - Let an invalid derived chain pass append or read: lineage-boundary test fails.
   - Let a closed reset barrier append normal content: reset ordering test fails.
   - Leave bytes after expiry: database/WAL scan fails.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="dryrun|dispatcher|cap|expiry|reset|lineage|parity"; pnpm verify:parity --strict; pnpm sync:reference (commit the generated docs/reference changes with this task, so `verify:reference` inside `pnpm verify` passes); then pnpm verify.

   **Commit.** feat(events): deliver only encrypted local dry-run records (events phase B1, task 13).

**Batch 5 ends** with pnpm verify. It must exit 0; repository scans prove no test payload survives purges.

## Batch 6 — parity audit, references, packages and handoff

14. **Audit the already-exposed B1 capability contract and confirm its references are current.**

   **Files.** The reference pages docs/reference/events-daemon-cli.md and docs/reference/events-daemon-mcp-tools.md were generated and committed by the tasks that exposed each command and tool (4, 6, 9, 13); this task only confirms they are current. Add packages/events-daemon/test/capability-audit.test.ts; change test/parity.test.mjs only for an audit assertion that reads the completed B1 contract. Do not change packages/events-daemon/src/cli/program.ts, cli.ts, mcp/server.ts, operations, schemas or capabilities.json in this task.

   **Tests first.**

   - Read the final B1 operation inventory from decision 6 and assert it is already complete: exactly one non-pending row per B1 operation, every `both` row recorded as reaching its named shared operation from both surfaces, and `run`, `approve`, dryrun list/show having their stated exception/no-tool shape.
   - Re-run the sealed full parity drive against the actual accumulated surface, including CLI/MCP argument equality for every `both` row and tools/list absence for exceptions. Mutating any earlier row, command, tool or operation association must make the audit fail.
   - Generate references from that already-real surface and assert their command/tool lists exactly equal the registries; they name no B3 command, no `target resume`, and no content-bearing MCP result.

   **Then the implementation.**

   - Run `pnpm verify:reference`: it must pass with no changes. A difference means an earlier task skipped its `pnpm sync:reference`; repair that task, not this one. Commit only the audit test.
   - If the audit finds a missing row, adapter or exception, repair the task that first exposes that operation and rerun its focused test and `pnpm verify`; do not make Task 14 the delayed implementation site and do not add a pending row.

   **Mutations.**

   - Omit or duplicate an earlier B1 capability row: inventory/strict-parity audit fails.
   - Rename an already-exposed operation on only one surface: sealed drive/reference audit fails.
   - Mark dryrun show `both` or register its MCP tool: exception/MCP-absence audit fails.
   - Add `target resume` to a generated B1 reference: phase-allocation audit fails.

   **Run.** pnpm --filter @agentcomms/events-daemon test -- --test-name-pattern="capability.*audit"; pnpm verify:reference (must report no changes); pnpm verify:parity --strict; then pnpm verify.

   **Commit.** docs(events): audit B1 parity and regenerate daemon references (events phase B1, task 14).

15. **Release/documentation integration and end-to-end no-publish verification.**

   **Files.** Change packages/events-daemon/README.md, CONTRIBUTING.md and docs/RELEASING.md only where the new held service needs a named first-release example; change test/install-docs.test.mjs, test/release-packages.test.mjs, test/events-daemon-e2e.test.mjs and package consumer checks. Task 14 is the sole B1 reference-regeneration task.

   **Tests first.**

   - Packed-tarball consumer creates a temporary config/state, starts foreground owner, uses CLI and MCP clients, creates/activates a synthetic Gmail fake event to dry-run, safely reads it at a TTY simulation, stops it, and verifies no network request/no real credential.
   - Prove both events and events-daemon are in PUBLISHABLE/HELD but absent from scripts/packages.mjs’s printed tag list; release preflight/confirm does not touch their packuments while held.
   - Prove release documentation orders the owner’s eventual manual publish events then events-daemon from one checked tag and never tells a B1 merge to publish.
   - Ensure Task 14’s generated references name only B1’s public surface and no deferred B3 command.

   **Then the implementation.**

   - Consume the Task 14 generated references, write the service README’s foreground/safety/hold contract, and make release prose point to the existing held-package mechanics.
   - Add the minimal consumer fixture and make it fake-only. Do not add npm credentials, publishing code, an OS service, or a real Gmail fixture.

   **Mutations.**

   - Remove daemon hold: release-list test fails.
   - Publish a deferred B3 command in generated docs: reference/surface drift test fails.
   - Reverse first-publish dependency order in the docs: release wording test fails.
   - Replace fake Gmail with a real endpoint: sealed fake/network test fails.

   **Run.** pnpm build; node --test test/events-daemon-e2e.test.mjs test/release-packages.test.mjs test/install-docs.test.mjs; pnpm verify:parity --strict; pnpm verify:browser; then pnpm verify.

   **Commit.** docs(events): document the held B1 service and its local control boundary (events phase B1, task 15).

**Batch 6 ends** with pnpm verify. It must exit 0. B1 then merges with the two holds still present; no publish command has run.

## §5 coverage ownership

Each B1-owned portion of §5 has one accountable owner exactly once; supporting calls and integration assertions in other tasks do not create a second ownership row. Rows that belong to Phase A, B2, B3, C, D, E or E2 are intentionally absent.

| §5 item/case | Task |
|---|---:|
| CAT-B1-a: injected event-id collision stops Gmail cursor/source instead of merging identities | 10 |
| CAT-B1-b: operational agentcomms records and reset/test controls are nonselectable and do not ingest | 7 |
| CND-B1: deterministic condition evaluation inside authorised event processing; no agentic/judge call before E | 12 |
| JDG-B1: all judge kinds initially disabled; deterministic activation works; disabled judge rule activation refuses JUDGE_KIND_DISABLED | 7 |
| MAP-B1-a: exact dry-run targetKey and Phase A CloudEvent bytes in an actual local delivery | 12 |
| MAP-B1-b: delivery-stable untrusted envelope representation and provenance-derived taint | 12 |
| APR-B1-a: four activation-document golden vectors and exact derived version lists | 7 |
| APR-B1-b: core disclosure create/challenge terminal-or-app approval/claim, wrong-kind matrix and immutable usedAt | 2 |
| APR-B1-c: crash matrix through intent/core used/usedAt/baseline/pointer/completion; one-hour failure | 9 |
| APR-B1-d: exact Gmail first activation and enable-all staged points/recovery/no backfill | 9 |
| APR-B1-e: Gmail exact replacement P/drain/swap, real-worker/mailbox-lock race matrix and second replacement refusal | 11 |
| APR-B1-f: derived tightening lineage, inherited points, lifecycle and revocation | 11 |
| APR-B1-g: one `assertDisclosable` exact-or-derived, acyclic/digest/revocation fence across source, recovery, evaluation, append and terminal read | 13 |
| ING-B1-a: cursor/ingest/decision/delivery/dry-run crash atomicity and complete target set | 12 |
| ING-B1-b: independent metadata/body projections and lazy fetch-once/no-full-event retention | 12 |
| ING-B1-c: Gmail deleted-after-list, lazy 404 vanished, retry unresolvable, terminal cursor advance | 10 |
| STG-B1: Gmail staged-at/deadline before-at-after, retry-deadline composition, restart and content purge | 10 |
| TGT-B1: account removal, global disable, pause distinction and generation fences for Gmail/dry-run | 9 |
| DEL-B1: dry-run append/read state fences, lease recovery, cancellation and no MCP content read | 13 |
| CAP-B1: approved delivery-cap validation; atomic `delivery_cap_charges`/append/delivered mark; full-cap queue, recovery, read and expiry behaviour | 13 |
| RST-B1: B1 local dry-run reset append barrier and notice ordering; B2 network barriers/degraded behaviour and B3 terminal/app-only resume excluded | 13 |
| RET-B1: B1 retention table rows, fixed/shortenable deadlines, startup expiry and WAL/free-page scans | 13 |
| TNT-B1: two-lock taint origins, old-writer compatibility and taint-before-dry-run | 3 |
| SEC-B1: independent event store/selector/migration and old-core migration independence | 5 |
| CRY-B1: packed encryption/AAD vectors, key rotation/loss/unreadable behaviour and no plaintext | 5 |
| CTRL-B1: owner-only state, same-user/token protocol, negotiation, stale recovery and protocol compatibility | 6 |
| PKG-B1-a: strict service declaration, automatic publication/surface/driver/reference discovery | 1 |
| PKG-B1-b: held daemon packaging, Node 22.12 refusal and 22.16 SQLite legs (B1-F), consumer package shape | 4 |
| PAR-B1: every implemented B1 operation has exactly one capability row and is driven on both surfaces or its stated exception | 14 |
| REL-B1: B1 merges held; generated docs and consumer test prove no release path publishes either held package | 15 |

## Final verification and handoff

Before requesting review, run:

~~~text
pnpm verify:parity --strict
pnpm verify:browser
pnpm verify
git diff --check
git status --short
~~~

Passing means every package, including both held packages, builds/tests/packs as the repository requires; strict parity drives every B1 row; browser vectors still agree with Phase A; no consumer or release path reaches a held package; and no test reached a real provider. Do not commit from this worktree if its shared git directory blocks it. The commit message for the completed plan is:

docs(plan): local event emission — phase B1, revised for review round 1
