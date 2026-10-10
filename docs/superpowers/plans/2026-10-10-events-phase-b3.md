# Local event emission, Phase B3 — implementation plan

**Goal:** complete the held `@agentcomms/events-daemon` control plane promised by
Phase B3: the D10 CLI/MCP surface and parity records, deliberately unequal
human-only paths, secret completion and migration, safe retained-content reads
and reset recovery, a content-free `doctor`, and the `agentcomms-events` skill.
It builds on the converged B2 + Phase D tree at `556feb64`, not `main`, and
does not implement desktop C, judge execution/holds/budgets E, or a new source.

Safety invariants, rather than command-group order, determine the batches.
First make parity and mutation evidence able to describe exceptions honestly.
Then build secret and retained-content fences before exposing human commands.
Every task is a builder-sized sitting: tests first, a narrow P1-only review
before a dependent task, and the complete root `pnpm verify` at its end.
Planning runs no provider, host, or send path.

## Scope, inherited decisions, and non-goals

This plan adopts every decision in the B1, B2, and D plans' **“Decisions made
during the build”** tables. The material inherited constraints are:

| Inherited decision | B3 consequence |
|---|---|
| B1-F: Node >=22.16, built-in SQLite, owned additive migrations. | Use one forward daemon migration; preserve named old-Node refusal, no experimental fallback. |
| B1-G: owner-only Unix control paths and Windows refusal. | Extend the authenticated protocol only; add no TCP/HTTP administration endpoint or Windows weakening. |
| B1 exact-version/account-removal/disable semantics. | Retry, resume, read, remove, and purge use stored exact versions and live account/switch fences; superseded is not revoked. |
| B1 PR #59 / commits `355bd076`, `ccf201e1`. | The B3 caller of `rotateAndReencrypt` quiesces every writer before rekey and cannot destroy a referenced retired master. |
| B1 K6, re-added stable account. | `doctor` reports an explicit dark `awaitingReapproval` account/scope state; no source poll or backfill resumes until a fresh approved activation takes a new point. |
| B2 private reset recovery; B3 owns human target resume. | Resume creates a new notice, never redrives the old dead letter or offers MCP escape. |
| B2 post-await fences and Phase-D WhatsApp composition. | Reads/resume re-enter the live fence/visibility gate after every await; no B3 bypass. |
| D stable IDs, source-owned vocabulary, source-scope fences. | Every raw/external identity write is account/source scoped; B3 imports channel vocabulary. |
| B2 sealed transport and D injectable adapters. | Tests use injected fakes or loopback under `test/helpers/loopback-seal-preload.mjs`; never real providers. |

The daemon and `@agentcomms/events` remain held. B3 neither removes an
`agentcommsRelease.hold` nor adds a send API, real address, secret, message,
URL, or token to tests or fixtures.

## Plan review decisions (2026-10-10)

The coordinator resolved the owner questions, the review repairs, and the
cross-phase hand-off below. These are implementation decisions for this plan;
they are not deferred requests for an implementer to reinterpret.

| Question | Decision | Reason |
|---|---|---|
| B3-A — how is master rotation exposed? | Add no public master-rotation command. The private rekey is mandatory inside exactly `target secret rotate`, `subscriber token rotate`, and `judge key rotate`, while the exclusive owner-wide writer quiescer is held. | D2 closes the public secret set and B1 PR #59 assigns the missing caller and old-key race fix to B3. |
| B3-B — how can a secret URL create an immutable target? | One transactional new-version factory accepts an explicit predecessor version or inert draft and a new, non-existent version. Hidden URL input derives the descriptor, writes/read-back-verifies the secret, and inserts the immutable version as one compensated transaction. | An existing slot cannot be overwritten and no selection may infer `latest`. |
| B3-C — are judge controls deferred? | Publish real operations and capability rows now; before E every judge/budget/kind operation returns a typed zero-network unavailable result. | C needs a stable surface, while the phase gate forbids a callable judge before E. |
| B3-D — how is held decision resolution represented? | Keep `held decide` as a terminal/app-only exception row with its stable held-decision reason; MCP refuses it. | D10 expressly reserves held-decision resolution for a person. |
| B3-E — what identifies retained testing? | Require `eventId` plus exact `ruleId` and immutable `ruleVersion`, with no account argument; read only a saved, live retained projection. | This prevents active-pointer inference and arbitrary pending-document reads. |
| B3-F — how is pending-target testing selected? | Build the owner-side pending activation-context selector in B3. It is usable only by the interactive terminal approval flow and the app approval screen, never by MCP or ordinary CLI. | D10 gives this exact pending-activation exception, and C must call the same authority rather than create another path. |
| B3-G — how is the event skill discovered? | Extend the strict `agentcommsPackage.kind: "service"` declaration with a validated optional `skills` field feeding the existing registry; add no non-channel `agentcomms` kind. | This preserves the channel-plugin model while allowing a daemon service skill family. |
| B3-H — what may doctor disclose? | Check in a versioned, content-free doctor schema with only stable IDs, status enums, counts, times, and enum codes; include `awaitingReapproval`. | Consumers need stable rendering without refs, fingerprints, aliases, URLs, tuples, payloads, provider responses, or stacks. |
| P1 — where does incomplete secret readiness live? | Task 2 owns one `assertObjectSecretReady` predicate for target, subscriber, and hosted-judge versions and invokes it at prepare, claim, activation, and delivery boundaries. | “MCP preparation only” does not prevent an incomplete object from becoming effective later. |
| P1 — how is mutation evidence made probative? | The runner copies the complete source/test import closure into an overlay, proves the named mutant module loaded, then requires the exact named case to fail. | Copying just one source file can test normal checked-in code or fail before loading the mutant. |
| P1 — what proves local rule-test output safety? | `b3-rule-test.test.ts` sends hostile catalogue examples and mapped values through CLI and MCP and requires sanitisation plus exactly one required untrusted envelope. | D10 protects output independently of the target representation. |
| P1 — what proves secrets never persist in metadata? | Every secret operation and migration uses deterministic synthetic sentinels and scans event SQLite, WAL, and free pages as well as output/audit/log sinks; the designated secret backend is excluded. | A content-free receipt is insufficient if a raw secret leaked into SQLite metadata. |
| P1 — which tasks may share the README? | Tasks 8 and 9 are serial; Task 8 completes its generated README update before Task 9 adds the compatibility section. | Both tasks touch `packages/events-daemon/README.md`, so their former parallel claim was false. |
| C↔B3 1 — how do desktop and daemon share types? | B3 checks in a language-neutral, versioned JSON Schema plus request/result/error vectors for every desktop-callable D10 operation, generated from or checked against TypeScript operation types. | C can generate or validate Rust types and mutation-test schema/operation drift without reverse-engineering TypeScript. |
| C↔B3 2 — how does a person receive an approval preview? | Add paired `approval view { approvalId, digest }`, returning the authoritative structured preview and daemon-issued challenge with stale/digest/challenge vectors; `approve` still re-plans at its final fence. | Previewing must not turn an earlier plan into an approval bypass. |
| C↔B3 3 — how are previews rendered consistently? | Check in shared preview fixtures; B3’s TypeScript terminal renderer consumes them and C’s future Rust renderer consumes the identical set. | The app and terminal must not diverge on an approval preview. |
| C↔B3 4 — when may an app submit a secret? | Until C supplies an owner-verified, non-forgeable Rust-to-daemon secret-window capability, B3 accepts secret operations only from `interactive-terminal` and returns stable unavailable for every app/window label, including a forged raw-control label. | The current caller-selected client name is not a capability. |
| C↔B3 5 — what happens before E/E2? | Pre-E judge controls return typed zero-network unavailable results; `laya` kind/model status/remove return `E2_REQUIRED` with no pointer, approval, download, worker, or network; holds are typed empty. | C can render stable variants while E/E2 later become their producers. |
| C↔B3 6 — where is the E build/ship dependency proven? | B3 exports only the data-only contract and a consumer-fixture test. E imports its real code, lands its build/ship gate before registration or any callable judge, and requires B3 merged. | A temporary B3 package cannot prove a future E implementation actually depends on the contract. |
| C↔B3 7 — who owns pending target testing? | B3 owns the pending-target owner operation and its activation-context selector; C invokes it from the approval screen only. | This keeps one approval-bound authority and rejects MCP and ordinary CLI. |

## Decisions the spec leaves to the plan

### B3-1 — one owner operation is the only implementation path

Every B3 command and tool calls one exported function in
`packages/events-daemon/src/operations/`. That function only uses
`EventControlClient`; it never opens SQLite, a secret backend, a provider, or a
target itself. The authenticated owner routes the request to a typed runtime
service, so CLI, MCP, and later desktop receive the same validation,
transaction, error code, and content-free result.

`approvalView({ approvalId, digest })` is also one such operation. It returns
the daemon's authoritative structured preview plus a daemon-issued challenge
whose typed result distinguishes `READY`, `STALE_APPROVAL`, `DIGEST_MISMATCH`,
and `CHALLENGE_EXPIRED`. The terminal approval renderer and the future app use
that view; `approve` always re-plans under its final activation lock and never
treats a previously returned preview or challenge as a claim.

An exception row also records its operation. B3 extends `scripts/parity.mjs`:
an exception with a CLI side is driven through that CLI side and must reach its
operation; its absent MCP side is asserted. Existing B1 exceptions are
backfilled where possible (`approve`, `dryrunList`, `dryrunShow`, `run`);
`mcp` remains an explicit `unchecked` server-start exception. Thus
`pnpm verify:parity --strict` proves deliberate absence as well as parity.

Direct CLI/MCP calls into runtime classes would create a second authority path,
bypass stale-owner recovery/audit, and give C a different behavior; reject it.
Leaving exception rows unchecked repeats the drift D10 forbids; reject that too.

### B3-2 — capability matrix, operation, and parity proof

The table is the complete B3 delta. `<document>` means canonical JSON through
the current CLI parser. Every selector is non-secret. `--version` is required
for an existing immutable target/subscriber/judge slot or reset barrier; the
secret-URL factory instead requires its explicit non-existent `--new-version`:
B3 never silently selects “latest”. `—` means `mcp: null`,
`status: "exception"`.

| Capability id | CLI command | MCP tool | operation | status / reason |
|---|---|---|---|---|
| `events-daemon.approval.view` | `approval view <approval-id> --digest <digest>` | `events_approval_view` | `approvalView` | both; structured preview plus challenge, never a claim |
| `events-daemon.rule.test` | `rule test <document> <catalogue-example>` | `events_rule_test` | `ruleTest` | both |
| `events-daemon.rule.test-retained` | `rule test-retained <event-id> --rule <rule-id> --version <n>` | — | `ruleTestRetained` | exception — retained sender content only a person may select outside model context |
| `events-daemon.target.test` | `target test <target-id> --version <n>` | `events_target_test` | `targetTest` | both |
| `events-daemon.target.resume` | `target resume <target-id> --version <n>` | — | `targetResume` | exception — only a person may reopen a degraded reset barrier |
| `events-daemon.subscribers.list` | `subscribers list` | `events_subscribers_list` | `subscribersList` | both |
| `events-daemon.subscriber.add` | `subscriber add <document>` | `events_subscriber_add` | `addSubscriber` | both |
| `events-daemon.subscriber.update` | `subscriber update <document>` | `events_subscriber_update` | `updateSubscriber` | both |
| `events-daemon.subscriber.remove` | `subscriber remove <subscriber-id>` | `events_subscriber_remove` | `removeSubscriber` | both |
| `events-daemon.judges.list` | `judges list` | `events_judges_list` | `judgesList` | both; typed `E_REQUIRED` until E |
| `events-daemon.judge.add` | `judge add <document>` | `events_judge_add` | `addJudge` | both; typed `E_REQUIRED` until E |
| `events-daemon.judge.update` | `judge update <document>` | `events_judge_update` | `updateJudge` | both; typed `E_REQUIRED` until E |
| `events-daemon.judge.remove` | `judge remove <judge-id>` | `events_judge_remove` | `removeJudge` | both; typed `E_REQUIRED` until E |
| `events-daemon.judge.test` | `judge test <judge-id> --version <n>` | `events_judge_test` | `judgeTest` | both; typed zero-network `E_REQUIRED` until E |
| `events-daemon.budget.show` | `budget show` | `events_budget_show` | `budgetShow` | both; typed `E_REQUIRED` until E |
| `events-daemon.budget.update` | `budget update <document>` | `events_budget_update` | `updateBudget` | both; typed `E_REQUIRED` until E |
| `events-daemon.judge-kinds.list` | `judge kinds list` | `events_judge_kinds_list` | `judgeKindsList` | both; typed `E_REQUIRED` until E |
| `events-daemon.judge-kind.enable` | `judge kind enable <kind>` | `events_judge_kind_enable` | `enableJudgeKind` | both; typed `E_REQUIRED` until E, `E2_REQUIRED` for `laya` |
| `events-daemon.judge-kind.disable` | `judge kind disable <kind>` | `events_judge_kind_disable` | `disableJudgeKind` | both; typed `E_REQUIRED` until E, `E2_REQUIRED` for `laya` |
| `events-daemon.judge-model.status` | `judge model status` | `events_judge_model_status` | `judgeModelStatus` | both; typed `E2_REQUIRED` until E2 |
| `events-daemon.judge-model.remove` | `judge model remove` | `events_judge_model_remove` | `removeJudgeModel` | both; typed `E2_REQUIRED` until E2 |
| `events-daemon.deliveries.list` | `deliveries list` | `events_deliveries_list` | `deliveriesList` | both |
| `events-daemon.delivery.retry` | `delivery retry <delivery-id>` | `events_delivery_retry` | `retryDelivery` | both |
| `events-daemon.delivery.drop` | `delivery drop <delivery-id>` | `events_delivery_drop` | `dropDelivery` | both |
| `events-daemon.held.list` | `held list` | `events_held_list` | `heldList` | both; typed empty until E |
| `events-daemon.held.decide` | `held decide <decision-id> <accept\|reject>` | — | `decideHeld` | exception — a held model decision can be resolved only by a person at terminal/app, never by model context |
| `events-daemon.target-secret.create` | `target secret create <target-id> --version <n>` | — | `targetSecretCreate` | secret exception |
| `events-daemon.target-secret.rotate` | `target secret rotate <target-id> --version <n>` | — | `targetSecretRotate` | secret exception |
| `events-daemon.target-url.set` | `target url set <target-id> (--predecessor-version <n> \| --draft <inert-target-document>) --new-version <n>` | — | `targetUrlSet` | secret exception; the new version must not exist |
| `events-daemon.subscriber-token.create` | `subscriber token create <subscriber-id> --version <n>` | — | `subscriberTokenCreate` | secret exception |
| `events-daemon.subscriber-token.rotate` | `subscriber token rotate <subscriber-id> --version <n>` | — | `subscriberTokenRotate` | secret exception |
| `events-daemon.judge-key.set` | `judge key set <judge-id> --version <n>` | — | `judgeKeySet` | secret exception |
| `events-daemon.judge-key.rotate` | `judge key rotate <judge-id> --version <n>` | — | `judgeKeyRotate` | secret exception |
| `events-daemon.secrets.migrate` | `secrets migrate --to keychain\|file` | — | `migrateSecrets` | exception — moves daemon credentials under daemon lock |

Existing `dryrun list/show` and `doctor` retain their B1 names/functions but
receive B3 semantics and strict exception/dual-surface checks. Existing normal catalogue,
source, rule mutation, target mutation, lifecycle, and daemon rows remain,
with generated references refreshed. `approve`, `run`, and `mcp` stay existing
exceptions. No secret operation has an MCP name, Zod schema, tool description,
structured result, or text result.

`targetTest` is `openWorldHint: true`; all other B3 MCP operations are local.
That describes an approved synthetic target request accurately without
permitting an unapproved request. The pending-activation form is deliberately
not a Commander flag or MCP schema: it is the approval-flow-only owner request
defined in B3-6.


#### Complete exception register after B3

This is the full exception register, not merely the new rows. It is a second
audit target for strict parity and tests.

| Capability | CLI operation | MCP | reason |
|---|---|---|---|
| events-daemon.run | run | absent | A tool cannot start the foreground owner and then use its control server. |
| events-daemon.mcp.serve | mcp server start, unchecked | absent | It starts the server a tool would need already running. |
| events-daemon.approve | approve | absent | Standing disclosure can be approved only by a person typing the challenge at an interactive terminal. |
| events-daemon.dryrun.list | dryrunList | absent | Retained sender content may be selected only by a person outside model context at an interactive terminal/app renderer. |
| events-daemon.dryrun.show | dryrunShow | absent | Retained sender content may be rendered only for a person at an interactive terminal/app, never in model context. |
| events-daemon.rule.test-retained | ruleTestRetained | absent | Retained sender content may be selected only by a person outside model context. |
| events-daemon.target.resume | targetResume | absent | A person, not model context, decides to reopen a degraded target reset barrier. |
| events-daemon.held.decide | decideHeld | absent | A held model decision can be resolved only by a person at terminal/app, never by model context. |
| eight individually named secret rows | targetSecretCreate, targetSecretRotate, targetUrlSet, subscriberTokenCreate, subscriberTokenRotate, judgeKeySet, judgeKeyRotate, migrateSecrets | absent | Secret material must never enter model input or output; the person completes this operation at the terminal or app. |

No generic group row replaces an individual secret row. The capability audit
checks exactly eight secret IDs and their exact reason, then checks every
non-secret exception above against its listed CLI path/operation and absent MCP.


### B3-3 — human-only is an independently enforced closed set

The eight secret rows use this byte-identical reason:

> secret material must never enter model input or output; the person completes
> this operation at the terminal or app.

\`operations/secrets.ts\` is not imported by the MCP server. A registration test
compares \`tools/list\`, server metadata, every Zod schema, structured content,
and text output with the closed matrix. It fails for a missing listed exception
as well as a newly added secret-looking command. No generic “execute control
request” MCP tool exists.

The CLI calls \`assertHumanTerminal\` before prompt or owner connection: agent
marker, non-TTY, redirected stdin, and \`--json\` all refuse. A no-echo TTY
reader is the only production secret input—no \`--secret\`, environment, JSON,
document, stdin-pipe, or fallback. A test-only injected reader provides only
synthetic material to strict parity and is unavailable in production deps or
environment. Generated signing secrets/tokens are branded in-memory results
which only the controlling TTY renderer can consume; URL/key set returns a
content-free receipt. Audit/log/error/result serializers accept receipt shapes
only. In B3 the owner accepts these operations only with the authenticated
\`interactive-terminal\` origin. Every \`app\`, \`window\`, or \`secrets\` label,
including a forged label on a raw authenticated control client, returns the
stable \`APP_SECRET_CAPABILITY_UNAVAILABLE\` result before a prompt,
secret-store read, or write. C may later send this same owner request only
after it supplies and B3 verifies C's non-forgeable Rust-held secret-window
capability; it must not add a second secret-store API.

Testing only Commander absence from MCP would miss direct import, machine
output, and accidental echo. Allowing an MCP “sensitive” argument leaves a
durable transcript; both alternatives are rejected.

### B3-4 — slots, independent migration, and master rotation differ

\`EventSecretStore\` gains \`judge\` owner/\`judge-key\` purpose, retains target
signing/secret-URL/subscriber-bearer purposes, and derives its references only
from immutable versions, pending operations, and retained generations.

- Create/set verifies the exact slot empty; rotate verifies its exact current generation.
- Signing rotation retains current + previous; subscriber rotation invalidates prior generation and closes every old-generation stream; judge-key rotation atomically replaces its hosted-key generation.
- \`createSecretUrlTargetVersion\` takes \`{ targetId, predecessor: { version } | { inertDraft }, newVersion, hiddenUrl }\`. It rejects a missing predecessor/draft, a draft with an identity, an existing \`newVersion\`, and any implicit-current lookup. Under \`events/secrets.lock\` it derives the descriptor from hidden input, writes/read-back-verifies the secret, and inserts one new incomplete immutable target version plus its encrypted reference in the same compensated transaction; failure removes/restores the physical value and commits no version, activation, or rule reference. It returns only \`{ scheme, host, port, sha256 }\` and never overwrites a slot or moves a rule.
- Every mutation holds \`events/secrets.lock\`, physical-write/read-back-verifies, conditionally commits its SQLite row, restores/deletes on failure, and writes only a content-free audit receipt.

\`migrateSecrets\` derives the sorted reference snapshot under the events lock,
copies/read-back verifies every value, atomically flips only
\`meta.event_secret_store\`, then deletes old copies. Before selector commit it
rolls back target copies; after it a named opaque leftover is harmless and a
retry cleans it. It never takes the core credentials lock, changes
\`config.secrets.store\`, or enters core's namespace/directory. A compatibility
test executes prior released-core migration both ways after every B3 event
secret kind exists and proves event selector, namespace, files, and readability
unchanged.

**Master rotation choice:** D10 closes public secret names, so add no
\`secrets master rotate\` command. Each human credential **rotate** operation
(\`target secret rotate\`, \`subscriber token rotate\`, \`judge key rotate\`) invokes
private \`rotateAndReencrypt\` before changing its own slot. These rare human
operations provide B1's owed caller without exposing a new destructive secret
verb. Create/set, secret-URL new version, and backend migration do not rekey.

A separate terminal-only master command is clearer but violates the closed D2
set without amendment. Automatic rekey during arbitrary encryption cannot take
the global writer barrier at every call and could block delivery unpredictably.
Both are rejected.

### B3-5 — master rotation has an owner-wide writer quiescence lease

Before \`EventRecordCipher.rotateAndReencrypt()\` calls \`rotateMaster\`, an
in-memory \`WriterQuiescer\` exclusive lease stops new poll/evaluation/expiry/
dispatcher/SSE/reset/control writes, waits for active tick and all claimed
writer leases, then runs bounded keyset batches. Every writer holds a shared
lease from encrypt/decrypt through its own commit/purge transaction:

| Shared-lease writers | Await/recheck before own write |
|---|---|
| \`runtime/activations.ts\` | Provider baseline/profile and encryption; recheck account, intent, generation, pointer before baseline/finalisation. |
| \`runtime/scheduler.ts\`, \`sources/source-worker.ts\`, \`sources/slack*.ts\`, \`sources/resend*.ts\`, \`runtime/source-owner-work.ts\` | Provider/list/snapshot/materialisation and stage crypto; recheck source/account/scope, switch, baseline/drain, exact row. |
| \`runtime/projections.ts\`, \`runtime/decisions.ts\`, \`runtime/deliveries.ts\` | Mapping/taint/encryption; recheck projection/debt/decision/target version, account, switch, claim. |
| \`runtime/dispatcher.ts\`, \`runtime/webhook-dispatcher.ts\`, \`runtime/sse-dispatcher.ts\`, \`runtime/system-reset-outbox.ts\` | Decrypt, visibility/config/fence/network result, re-encrypt; recheck claim, versions, account, generation, barrier, deadline, state. |
| \`runtime/expiry.ts\`, \`runtime/revocations.ts\`, \`runtime/recovery.ts\`, \`runtime/reset.ts\` | Decrypt/cleanup; recheck exact version/account/barrier/lease row before terminal/purge/reset write. |
| \`store/event-secrets.ts\` and B3 secret services | Store set/get/delete, randomness, reference crypto; recheck selector, owner/version/purpose/generation, slot, reference set. |

The inventory is an exact, checked manifest rather than the groups above: it
names `runtime/activations.ts`, `runtime/scheduler.ts`,
`runtime/source-owner-work.ts`, `runtime/projections.ts`,
`runtime/decisions.ts`, `runtime/deliveries.ts`, `runtime/dispatcher.ts`,
`runtime/webhook-dispatcher.ts`, `runtime/sse-dispatcher.ts`,
`runtime/system-reset-outbox.ts`, `runtime/expiry.ts`,
`runtime/revocations.ts`, `runtime/recovery.ts`, `runtime/reset.ts`,
`sources/source-worker.ts`, `sources/gmail.ts`, `sources/materialise.ts`,
`sources/resend.ts`, `sources/resend-status.ts`, `sources/slack.ts`,
`sources/slack-replies.ts`, `sources/whatsapp.ts`, and
`store/event-secrets.ts` and `store/records.ts`. It also names the composition entries
`runtime/owner.ts`, `runtime/sse-server.ts`, and `runtime/stream-replay.ts`,
so a future indirect cipher or secret-store writer cannot bypass the lease.
`scripts/verify-b3-writer-inventory.mjs` derives the actual cipher/secret-store
call graph and fails for either an unlisted writer or a listed entrypoint that
does not acquire the shared lease.

\`withEventWriterLease\` is required at named runtime entrypoints. A structural
test rejects \`cipher.encrypt\`, \`cipher.decrypt\`, secret backend writes, or
provider/IPC awaits in this writer inventory outside a lease. The race test
pauses an old-master encrypt after the last pass: rotation waits, so the old
write cannot land. Failure releases exclusive lease in \`finally\` without
changing persistent pause state.

Before deletion, \`destroyRetiredMaster\` scans every \`RECORD_LAYOUTS\` packed key
id and derived secret references while exclusive lease and \`secrets.lock\` remain
held. Any reference returns \`RETIRED_MASTER_REFERENCED\`; only zero permits
backend/ledger deletion. Never best-effort cleanup.

`assertObjectSecretReady(owner, version)` is the single owner-side predicate
for secret-bearing target, subscriber, and hosted-judge versions. It returns
the content-free `OBJECT_SECRET_INCOMPLETE` code until every exact required
slot/reference is complete. The owner calls it before preparing an activation,
before claiming it, inside activation finalisation, and at every relevant
delivery/judge boundary; these callers must not accept an MCP-proposed version
merely because its non-secret document is otherwise valid. Completion, slot
rotation, removal, and the final boundary all re-read the exact version and
slot generation in their own transaction.


**B3-specific after-await write ledger.** The guard manifest carries the following
separate entries; “none” means the owner implementation is synchronous inside
one immediate transaction, not that the operation is exempt from identity scope.

| Write | Await before write | Recheck in its own transaction |
|---|---|---|
| targetSecretCreate | secret backend set/read-back; reference encryption | target exact id/version/digest/lifecycle, empty slot, selector, live reference set |
| targetSecretRotate | quiesce wait, master batches, backend set/read-back, reference encryption | exact current generation/overlap, target still live, selector/reference set, writer epoch |
| targetUrlSet | hidden TTY/app input, backend set/read-back, reference encryption | selected incomplete version unchanged, empty URL slot, canonical authority/fingerprint, no active pointer moved |
| subscriberTokenCreate/Rotate | backend set/read-back, reference encryption, old-stream close | subscriber exact version/lifecycle, empty/current generation, selector/reference set; rotate confirms old generation remains invalid |
| judgeKeySet/Rotate | hidden input, backend set/read-back, reference encryption; rotate quiesce/master batches | judge exact hosted version/endpoint/model/digest, empty/current slot, selector/reference set, writer epoch |
| migrateSecrets | every source get, target set/read-back/delete | lock-held database-derived reference set before selector flip; selector still source; leftover deletion only unreferenced |
| reencrypt/destroy master | every decrypt/encrypt/batch and backend delete | exclusive writer epoch; packed-row old key/byte CAS; no old key/reference before master delete |
| targetResume | reset-record encryption | exact degraded barrier/epoch/notice, live exact reference/lineage/account/switch, no existing resume |
| targetTest | approval/fence lookup, synthetic transport and settlement | exact approved target/rule context, or exact still-pending activation/target version plus live daemon challenge and approval-screen origin; cap bucket, address set, readiness, and current generation before charge/result |
| retryDelivery | no runtime await after owner dispatch | exact delivery/account/source and retryable state, attempts/deadline, versions/lineage/switch; update only nextAt |
| dropDelivery | no runtime await after owner dispatch | exact delivery/account/source; terminalise and purge retained payload in same transaction |
| add/update/remove subscriber/judge/budget/kind | no runtime await after owner dispatch | exact immutable version or affected live rows; all delete/update predicates include account/source through bound work joins |
| heldDecide | no B3 decision runner; future E hook may await | current held row/version/switch/lineage before any E mutation; B3 currently refuses without writing |

This ledger is separate from the B2/D writer inventory above: the structural
runner fails if a B3 writer is missing from either its B3 entry or, when it uses
the cipher, the shared-writer lease inventory.


### B3-6 — retained reads and target resume repeat delivery fences

\`dryrun list\`, \`dryrun show\`, and \`rule test-retained\` can disclose content,
so use one \`readRetainedForHuman\` service. After every await/decrypt/render it
re-enters an immediate transaction checking row identity, expiry, enabled
switch generation, unrevoked bound rule/target/subscriber/judge versions,
exact-or-derived lineage, live stable account, and WhatsApp live-list/raw tuple.
Only then does it return D3 sanitised terminal/app representation. List remains
content-free until per-row fence/render; no read charges a cap or creates work.

\`targetResume\` accepts an exact target version only under target reference/
lineage/live-account/revocation fencing. Its transaction verifies a still-live
active reference or authorised retained superseded reference, same degraded
epoch/version, and no live resume; after reset encryption it rechecks them and
inserts a new 20-attempt/24-hour control delivery with barrier still closed. It
never changes old dead letter, ordinary attempts/deadline/cap, target pointer,
or rule version. Revocation cancels barrier, reset notice, waiting payloads.

\`ruleTestRetained\` takes exactly \`{ eventId, ruleId, ruleVersion }\`, no account
argument. It finds only a saved, still-live retained projection bound to that
exact immutable rule version; it never follows an active pointer and never
accepts a pending document. It uses the same renderer/fences as \`dryrun show\`.

\`targetTest\` has two selectors. The paired CLI/MCP selector is the existing
approved \`{ targetId, targetVersion }\` form. The owner-only pending selector is
\`{ kind: "pending-activation", activationId, ruleId, ruleVersion, targetId,
targetVersion, approvalId, digest, challenge }\`. The owner verifies that the
activation is still pending, its exact activation document names that exact
rule and target version, the view digest and daemon-issued challenge are still
live, and the caller is the interactive terminal approval flow or app approval
screen. The ordinary \`target test\` command cannot construct this selector and
the MCP schema omits it. It sends only the fixed synthetic bytes through the
normal taint, target readiness, cap, address-set, and post-await settlement
fences; caller content, a field override, a target URL, and an unbound pending
document are all refused.

### B3-7 — E/E2 own execution; B3 owns stable unavailable variants

B3 gives every D10 judge, budget, and kind command/tool a real owner operation
and parity row, but it creates no judge/budget/kind pointer, approval, pending
document, worker, model download, provider request, local endpoint request, or
network call. Before E, each of \`judges*\`, \`judgeTest\`, \`budgetShow\`,
\`updateBudget\`, \`judgeKindsList\`, \`enableJudgeKind\`, and \`disableJudgeKind\`
returns the checked \`JudgeUnavailableV1\` result \`{ kind: "unavailable",
code: "E_REQUIRED", phase: "E" }\`; that is a result, not a missing command.
For \`laya\`, \`judge kind enable|disable laya\`, \`judge model status\`, and
\`judge model remove\` instead return \`{ kind: "unavailable", code: "E2_REQUIRED",
phase: "E2" }\` and make no pointer, approval, download, worker, or network
attempt. \`held list\` returns the typed content-free \`HeldListV1\` empty variant
and terminal/app-only \`held decide\` returns \`HOLDS_UNAVAILABLE\` without a
write.

E and E2 replace these unavailable producers behind the same functions, never
new CLI/MCP surfaces. Omitting them until E makes C depend on no API; allowing
even a prepared document or call early violates the phase gate. Both
alternatives are rejected. C renders only these checked discriminants; E/E2
change the producer behind the contract, not C's result grammar.

### B3-8 — doctor is versioned, content-free lineage and recovery state

\`doctor\` remains dual-surface and checks in \`DoctorReportV1\` JSON Schema plus
matching TypeScript type. Its closed field set contains only \`schemaVersion\`,
stable IDs, status enums, counts, timestamps, and enum/audit codes: protocol
and owner health; switch/pause/generation; installation id; active approval
lineages/immutable activation id; current cutover plus exact selected
account/scope point state; retained-work superseded version IDs; pending,
claimed, draining, failed, and enable-all completion state; source retry
age/count/resolution/lag; lease/held/dead-letter/deadline/missing-secret state;
the typed E/E2 judge boundary; and WhatsApp-list application state/time.

An account/scope that was removed and then re-added without a fresh point is
explicitly \`{ status: "awaitingReapproval" }\`, with its stable account and scope
IDs and no cursor, alias, tuple, or source data. Schema \`additionalProperties:
false\` and response scans forbid refs, fingerprints, aliases, URL components,
tuples, payloads, provider responses, and stacks. Structured fields, rather
than prose-only doctor, allow C rendering and E extension without parsing text.

### B3-9 — narrow C/E dependency contract

| Consumer | B3 surface it may call | Not supplied by B3 |
|---|---|---|
| C desktop | Versioned data-only D10 JSON Schema and request/result/error vectors; `approvalView` preview/challenge result; shared preview fixtures; safe dry-run/retained/resume/held/doctor schemas; the pending activation-context target-test request. | Tauri, Rust IPC, CSP/navigation, UI, secret transport, or a second owner operation. C generates or validates Rust types from the checked-in artifact and mutation-tests schema/operation drift. |
| E judges | \`judge*\`, \`budget*\`, \`held*\`, and \`judge kind*\` signatures/rows with typed E/E2 unavailable variants; doctor extension; data-only contract and consumer fixture. | Provider/local judge calls, holds/budget ledger, Laya runtime/model, approval bypass, or B3's future build/ship gate. |

`packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json`
is language-neutral and versioned. It covers every D10 operation desktop may
call, including request/result/error discriminants, and is generated from or
checked against the exported TypeScript operation types. The checked-in vector
set covers success, stale approval, digest mismatch, challenge expiry, E/E2
unavailable, typed empty holds, terminal-only pending-target context, and every
stable error. `test/fixtures/b3-approval-preview-v1/` is the shared fixture
set: B3's TypeScript terminal renderer consumes it now and C's Rust renderer
must consume and test the identical files.

The export lists eight secret capability IDs, exact reason, owner operation,
and only the currently accepted \`interactive-terminal\` origin—never a value.
Every app/window origin gets \`APP_SECRET_CAPABILITY_UNAVAILABLE\` until C's
verified capability exists; a caller-supplied window label is not proof. B3
does not contain an E build/ship gate. E must import this data-only contract
into its real code, add the negative gate before any judge registration or
callable operation, and require B3 merged.

### B3-10 — event skill is declared service skill family

Add \`skills/agentcomms-events/SKILL.md\`, generated contract/fit files, and
\`skills/_shared/contract-events.md\`. Extend strict
\`agentcommsPackage.kind: \"service\"\` tooling with validated optional
\`skills: { prefix: \"agentcomms-\", contract: \"skills/_shared/contract-events.md\" }\`.
\`scripts/channels.mjs\` exposes it through the same \`skillFamilies\` registry
used by skill sync/verify. It does not add an \`\"agentcomms\"\` channel manifest.

The skill teaches catalogue/source inspection, proposal of disabled secretless
documents, catalogue-example \`rule test\`, plain/enveloped representation,
the typed judge boundary (unavailable until E/E2, then every kind initially off
until the person enables it), and handing approval id to a person. It explicitly
never requests/types secrets; never invokes dry-run, retained test, target
resume, held decision, approve, or secret operation; never claims activation.

Hard-coding \`agentcomms-events\` in \`sync-skills\` loses registry guarantees.
Making daemon a channel violates D14. The declared service-family route is the
smallest consistent choice.


## Defect classes designed out automatically

Reviewer attention is not the guard. Task 1 creates a manifest and runner; later
tasks add cases before implementation.

### 1. Write after await

packages/events-daemon/test/b3-write-after-await.test.ts pauses every B3
operation at each await: physical secret set/read-back, generation/reference
crypto, stream close, migration copy/read-back/selector/cleanup, master
rotation batch, retained decrypt/render, target-resume encryption, target-test
preflight/settlement, delivery retry/drop, and operator-document mutation. It
changes live state and proves the operation's own immediate transaction
refuses/no-ops.

The verifier glob-loads one immutable-owner manifest per area from
`test/b3-guard-manifests/*.json`; a task adds only its own file, so parallel
tasks never edit a shared ledger. Each manifest names predicates per write.
scripts/verify-b3-guard-coverage.mjs compares annotations/source with the
manifest and invokes mutations removing switch, enabled/pause, account/source,
object version, intent claim, row identity, reference set, and writer lease.
Each named production-path test must fail.

### 2. Identity and scope

b3-identity-scope.test.ts creates colliding raw IDs across accounts/sources:
same WhatsApp message id, target/subscriber/judge version collisions, and
re-added account. It proves retry/drop/read/resume/remove cannot touch the
other row and alias-bound readers compare the resolved stable id after await.

scripts/verify-b3-sql-scope.mjs rejects B3 UPDATE/DELETE keyed by raw or
external identity unless its entry names account and source scope, or a
primary-key subquery proves those fields. It rejects copied channel vocabulary.
Mutants remove account/source conditions or replace imported vocabulary, making
their named test red.

### 3. Every purge cancels what it orphans

b3-purge-closure.test.ts covers target remove/revoke, subscriber remove/token
rotation, judge remove/key rotation, kind disable, account removal/re-add,
failed secret-URL creation, final reset-reference removal, migration rollback,
and target-resume replacement. For every path it proves claimed/pre-bound work,
reset notices, stream clients, dryrun/stream/dead-letter payloads, pending
activation, and secret generations are either retained by an exact still-live
reference or cancelled/purged together. It invokes the real owner operation,
not test-local tables. Each row has a mutation skipping its cancellation/purge.

### 4. Tests that bite

The manifest fields are case, operation, productionEntry, test, mutation,
mutationTest, and loadedMarker. The verifier fails if a B3 test lacks a
mutation, a mutation lacks a named test, a case uses a test model/default
shared branch rather than the actual EventControlClient/CLI/MCP/runtime
operation, or named cases share a default fixture. For each mutation it traces
and copies the complete resolved source-and-test import closure (static imports
and every declared dynamic test import) plus required package metadata into a
temporary overlay, rewrites only closure-local imports, and applies the small
textual mutation there. A preload observer requires the
mutated module to publish its descriptor's `loadedMarker`; the runner then runs
only `node --test --test-name-pattern <named-case>` under loopback preload and
requires both `B3_MUTANT_LOADED:<loadedMarker>` and the named case's non-zero
failure. A test that fails before the mutant loads, or that loads checked-in
source, is rejected. The runner never changes the worktree or opens an
external connection. Package test and root verify invoke it, so it cannot be
waived by omitting a focused command.

## Batch map and safe parallelism

There are **ten tasks in eight batches**. Task 2 is a serial prerequisite: it
owns the complete writer inventory and proves the old-key-after-final-pass race
before it creates any slot or rotation caller. Only after it completes may the
disjoint retained and operator work begin. Tasks 8 and 9 are serial because
both update the daemon README. All other serialization is deliberate where
registries or safety invariants overlap.

| Batch | Tasks | Parallel group | Dependency rationale |
|---|---|---|---|
| 1 — proof substrate | 1 | none | Exception driving and mutation accounting precede every public B3 row. |
| 2 — writer prerequisite and secret engine | 2 | none | Complete lease inventory, old-key race proof, readiness predicate, slots, migration, and private rekey share the same owner boundary. |
| 3 — fenced runtime controls | 3 + 4 | 3 + 4 | Retained/target controls and typed unavailable operator controls consume Task 2 ports and modify disjoint new modules/tests. |
| 4 — paired surface | 5 | none | Public schemas, approval view, and parity consume both runtime-control families. |
| 5 — exceptions | 6 | none | Human-only CLI paths consume the completed paired/secret/retained contracts. |
| 6 — health | 7 | none | Doctor reads final state and typed unavailable variants. |
| 7 — consumers | 8 → 9 | none | Task 8 owns the generated README update; Task 9 follows it with the data-contract compatibility section. |
| 8 — integration | 10 | none | References, strict parity, all mutants, package proof, and review need all surfaces. |

The only parallel group is Task 3 + Task 4. Task 3 owns
`b3-retained-control`, `b3-target-test-control`,
`b3-pending-activation-context`, the rule/target/resume operations and their
tests, and `b3-guard-manifests/retained.json`; Task 4 owns
`b3-operator-control`, `b3-judge-unavailable`, the subscriber/judge/delivery
operations and their tests, and `b3-guard-manifests/operators.json`. Task 1's
scripts glob-read those manifests; neither parallel task edits a shared source,
test, registry, capability, generated-reference, or README file.

## Batch 1 — proof substrate

### Task 1 — exception-aware parity and B3 evidence ledger (high risk)

**Files**

- Modify scripts/parity.mjs, scripts/operations.mjs, scripts/registries.mjs,
  test/parity.test.mjs, and root capabilities.json only for
  exception-operation schema/backfill.
- Add packages/events-daemon/src/operations/b3-contract.ts,
  packages/events-daemon/test/b3-capability-contract.test.ts,
  packages/events-daemon/test/b3-guard-coverage.test.ts,
  packages/events-daemon/test/b3-mutation-runner.test.ts,
  packages/events-daemon/test/b3-guard-manifests/proof-substrate.json,
  packages/events-daemon/test/support/b3-mutants.ts,
  scripts/verify-b3-guard-coverage.mjs, scripts/verify-b3-sql-scope.mjs, and
  scripts/verify-b3-writer-inventory.mjs.
- Refactor registration seams only in packages/events-daemon/src/cli/program.ts,
  src/mcp/server.ts, src/runtime/owner.ts, and src/control/protocol.ts:
  introduce typed B3 registrar/owner-service interfaces, but register no B3
  command/tool in this task.

**Tests first, in order**

1. Add red parity fixtures: exception with CLI but no operation; exception whose
   CLI reaches another operation; exception with an MCP tool; all must fail
   strict parity.
2. Add red structural fixtures: unpaired B3 case/mutation, a mutant whose
   named case is green, a mutant whose source module was never loaded, raw
   unscoped SQL, copied channel vocabulary, and a cipher/secret writer absent
   from the explicit lease inventory.
3. Add red contract tests pinning every B3-2 capability ID, command, tool/null,
   operation, exact exception reason, `approvalView` vectors, and C/E
   data-contract export shape.
4. Implement exception schema/driver, synthetic prompt seam, full-closure
   mutation overlay plus loaded-marker observer, per-area guard-manifest glob,
   writer-inventory verifier, and typed registrar seams. Do not expose behavior
   yet.

**Commands / passing**

Run focused parity/guard tests, then pnpm verify:parity --strict, then pnpm
verify. Passing means exception operations and absences are driven, malformed
fixtures fail, and full root verification including skills/reference/packages is
green.

**Mutations**

Remove exception operation; register absent MCP; swap CLI recorder; omit
case/mutation; force a normal-source import instead of the mutant; suppress the
loaded marker; remove account scope annotation; replace imported vocabulary;
and remove a writer from the inventory. Each maps one-to-one to a failing named
test.

**Commit:** refactor(events-daemon): prepare B3 parity and guard evidence

**P1-only review:** parity field validation, operation driving, prompt seam
reachability, full-closure mutant loading evidence, and loopback seal. No
behavioral surface may land.

## Batch 2 — serial writer prerequisite and secret engine

### Task 2 — serial writer quiescence prerequisite, secret engine, and readiness (highest risk)

**Files**

- Modify the complete writer inventory, and no later parallel task may modify
  it: `packages/events-daemon/src/runtime/activations.ts`, `scheduler.ts`,
  `source-owner-work.ts`, `projections.ts`, `decisions.ts`, `deliveries.ts`,
  `dispatcher.ts`, `webhook-dispatcher.ts`, `sse-dispatcher.ts`,
  `system-reset-outbox.ts`, `expiry.ts`, `revocations.ts`, `recovery.ts`,
  `reset.ts`, `owner.ts`, `sse-server.ts`, and `stream-replay.ts`;
  `packages/events-daemon/src/sources/source-worker.ts`, `gmail.ts`,
  `materialise.ts`, `resend.ts`, `resend-status.ts`, `slack.ts`,
  `slack-replies.ts`, and `whatsapp.ts`; and
  `packages/events-daemon/src/store/event-secrets.ts`, `records.ts`, and
  `migrations.ts`.
- Modify `runtime/locks.ts` and `runtime/subscriber-streams.ts`; add
  `runtime/writer-quiescer.ts`, `runtime/b3-control-ports.ts`,
  `runtime/b3-secret-control.ts`, `runtime/object-secret-readiness.ts`,
  `operations/secrets.ts`, and `domain/human-secret.ts`.
- Add `test/b3-writer-quiescer.test.ts`, `test/b3-secrets.test.ts`,
  `test/b3-secret-migration.test.ts`, `test/b3-master-rotation.test.ts`,
  `test/b3-object-readiness.test.ts`, `test/b3-secret-metadata-scan.test.ts`,
  and `test/b3-guard-manifests/secrets.json`.

**Produces for Tasks 3 and 4**

`WriterQuiescer`, `withEventWriterLease`, `B3ControlPorts`, and
`assertObjectSecretReady` are the only runtime-entry interfaces Tasks 3 and 4
may use. Their production files are new B3 modules and operations; they do not
edit the inventory above. The quiescer's exclusive lease is the only route to
`rotateAndReencrypt`.

**Tests first, in order**

1. Write the red exact-inventory test before any slot work. It derives every
   cipher/secret-store writer from the source call graph, requires the shared
   lease at every listed entrypoint, and pauses an old-master encrypt after
   the final re-encryption pass. Assert the exclusive lease waits for that
   writer, the old-key write cannot land, failure releases writers in `finally`,
   and a referenced retired master returns `RETIRED_MASTER_REFERENCED`.
2. Implement and pass the quiescer/inventory gate, including the control ports
   through which later tasks request retained reads, resume, synthetic target
   tests, delivery controls, and live fences. Do not add a slot, migration, or
   rotation caller until this command is green:
   `pnpm --filter @agentcomms/events-daemon test -- b3-writer-quiescer b3-master-rotation`.
3. Write red slot/factory/readiness tests. Enumerate all eight named secret
   operations;
   prove no argv/stdin/JSON/MCP bytes; exercise receipts, one reveal, signing
   overlap, old-token close, atomic judge key, and the predecessor-or-inert-
   draft/new-version secret-URL factory. Assert rollback after each physical/
   SQLite crash point, no mutation of an existing version, no implicit latest,
   and no activation/reference before the new version commits. For an
   MCP-proposed target, subscriber, and hosted judge, prove incomplete means
   disabled at prepare, claim, activation finalisation, and delivery/judge
   boundary, including completion and rotation races.
4. Write red independent-migration and persistence-leak tests. Create every
   secret kind with a deterministic synthetic sentinel; pause creation/rotation
   on both sides of the migration snapshot; cover both directions, rollback,
   leftover retry, restart, and prior-released-core migration independence.
   For every operation and migration outcome scan CLI/control receipt output, audit,
   logs, the event SQLite database, its WAL, and its free pages for the
   sentinel. Exclude only the selected fake secret backend. The raw-secret
   SQLite-metadata mutant must make `b3-secret-metadata-scan.test.ts` fail.
5. Implement the forward migration, `assertObjectSecretReady`, slot protocol,
   transactional target-version factory, private rekey caller in exactly the
   three rotate operations, destruction scan, persistence scan helper, and all
   named guard mutations.

**Commands / passing**

Run all focused tests under loopback preload, then `pnpm verify:parity --strict`,
then `pnpm verify`. Passing means every backend is fake/injected; no synthetic
sentinel appears outside the designated backend; all incomplete objects are
disabled at each owner boundary; the old-key late write cannot land; and the
core selector/namespace is untouched.

**Mutations**

Remove a writer lease from each inventory group; release it before its commit;
allow the old-key write after the last pass; delete a retired master without a
packed-key/reference scan; remove the readiness predicate at prepare, claim,
activation, or delivery; accept implicit latest or an existing URL version;
skip slot conditional/read-back/rollback/stream close; serialize a raw
sentinel into SQLite metadata; and serialize a reference/audit value. Each has
one named guard case and must fail only after its mutant-loaded marker appears.

**Commit:** feat(events-daemon): add B3 quiesced human secret control engine

**P1-only review:** complete writer manifest and lock order, exclusive/shared
lease lifetime through commit/purge, old-master race and destruction scan,
factory atomicity, readiness at every owner boundary, physical-store cleanup,
and all persistent/output sinks.

## Batch 3 — disjoint fenced runtime controls

### Task 3 — fenced retained reads, local/pending target tests, and target resume (high risk)

**Files**

- Add `packages/events-daemon/src/runtime/b3-retained-control.ts`,
  `runtime/b3-target-test-control.ts`, and
  `runtime/b3-pending-activation-context.ts`; add `operations/rule-test.ts`,
  `operations/target-test.ts`, and `operations/target-resume.ts`. These consume
  Task 2 `B3ControlPorts`; they do not modify Task 2's writer inventory.
- Add test/b3-retained-read.test.ts, test/b3-rule-test.test.ts,
  test/b3-target-resume.test.ts, test/b3-target-test.test.ts,
  test/b3-pending-target-context.test.ts, and
  `test/b3-guard-manifests/retained.json`.

**Tests first, in order**

1. Retained-read matrix: revoked/stale/account-removed/expired/WhatsApp hidden
   or unreadable rows refuse after decrypt/render races; superseded non-revoked
   row succeeds; no read charges/creates delivery; hostile renderer only.
2. Rule-test matrix: catalogue examples only; reject retained IDs/account IDs
   and known/unknown agentcomms types; agentic node not-evaluated; zero
   provider/judge/target/cursor/decision I/O. On both CLI and MCP send hostile
   catalogue examples and hostile mapped values and assert they are sanitised
   and wrapped in exactly the required untrusted-content envelope, regardless
   of target representation. Add non-TTY/agent/MCP refusal for retained test.
3. Resume matrix: dead-letter/reset/restart/degraded barrier; exact referenced
   unrevoked target only; new 20/24 notice; old notice terminal; no crossing
   before success; final reference purges. Target test accepts ten fixed
   synthetic attempts across versions, eleventh refuses before transport. For
   retained testing, require event id plus exact rule id/version, no account
   argument, a saved live projection, and no active-pointer or pending-document
   inference.
4. Pending-target matrix: obtain an `approvalView` challenge, then bind the
   exact pending activation, rule, and target version. The interactive terminal
   approval flow and app approval-screen origin may send only fixed synthetic
   bytes; ordinary `target test`, MCP, stale/digest-mismatched/expired challenge,
   wrong activation, wrong target/version, caller content, taint failure, cap
   exhaustion, and every post-await drift all refuse before/at the relevant
   fence. No alternate C implementation path is permitted.
5. Implement the shared read fence, local evaluator, exact retained selector,
   pending activation-context verifier, target-test preflight, and resume
   transaction/rechecks. Do not register the paired CLI/MCP leaves yet; only
   the existing terminal approval flow can construct the pending selector.

**Commands / passing**

Run focused tests, pnpm verify:parity --strict, then pnpm verify. Passing proves
actual B2/D dispatcher/visibility fence use, only fake/loopback transports, and
resume never redrives old work.

**Mutations**

Remove post-decrypt fence; eagerly decrypt list; test active pointer instead of
bound revocation; omit WhatsApp gate; accept an event id/account id in the
wrong rule-test form; omit sanitisation; omit or double-wrap the envelope;
allow unapproved network; accept a normal CLI/MCP pending selector or an
unbound/stale challenge; make old reset retryable; omit final reference check;
or reset attempt/deadline. Each fails its named case.

**Commit:** feat(events-daemon): add fenced B3 retained and reset operations

**P1-only review:** every after-await recheck, exact saved versus pending
selector, approval-context/origin binding, superseded/revoked distinction, raw
tuple scope, sanitisation plus one envelope, safe renderer, and zero-network
proof.

### Task 4 — delivery controls and typed E/E2 unavailable operators

**Files**

- Add `packages/events-daemon/src/runtime/b3-operator-control.ts`,
  `runtime/b3-judge-unavailable.ts`, `operations/subscribers.ts`,
  `operations/judges.ts`, and `operations/deliveries.ts`. These use Task 2
  `B3ControlPorts`; they do not modify Task 2's writer inventory.
- Add test/b3-operator-control.test.ts, test/b3-delivery-control.test.ts,
  test/b3-identity-scope.test.ts, test/b3-purge-closure.test.ts,
  test/b3-e-phase-contract.test.ts, and ledger file
  `test/b3-guard-manifests/operators.json`.

**Tests first, in order**

1. Exercise immutable subscriber documents through the production owner. For
   every judge/budget/kind operation, assert a real owner request returns the
   typed `E_REQUIRED` unavailable result with zero SQLite configuration
   mutation, approval, pointer, worker, provider, local-endpoint, or network
   call. For `laya` enable/disable/model status/model remove assert `E2_REQUIRED`
   and additionally no download/runtime/model action. `held list` is the typed
   content-free empty variant; `held decide` is unavailable without a write.
2. Exercise delivery list metadata; retry's state/attempt/deadline/generation/
   account/object fence and only-nextAt change; drop's same-transaction purge;
   held list and human-only decide refusal.
3. Collide account/source/object identities; prove each remove/revoke cancels
   orphaned claim/retained rows but preserves unrelated valid superseded work.
4. Implement services, Task 2 port calls, SQL annotations, structural-checker
   inputs, and the stable E/E2/empty result discriminants; defer CLI/MCP
   registration. Do not create an inert judge/budget/kind document before E.

**Commands / passing**

Run focused tests, pnpm verify:parity --strict, then pnpm verify. Passing means
every B3 operator has a real owner request path, unavailable operations have
zero network and zero producer state, and mutations prove scope/purge closure.

**Mutations**

Drop account/source predicates; reuse alias after re-resolution; update beyond
nextAt; retry dead letter; drop without clear; let MCP decide hold; replace an
E/E2 unavailable result with a document/pointer/approval/worker/download or
network call; or omit removal cancellation. Each fails a named real-operation
test.

**Commit:** feat(events-daemon): add B3 operator control services

**P1-only review:** SQL predicates, exact-version selection, retained-work
preservation, typed E/E2/empty boundary, zero-producer-state proof, and every
cancellation transaction.


## Batch 4 — paired public surface

### Task 5 — paired CLI/MCP controls and strict parity

**Files**

- Modify packages/events-daemon/src/cli/program.ts, src/mcp/server.ts,
  src/runtime/owner.ts, src/control/protocol.ts, and operations modules only to
  wire Tasks 3/4 and add `operations/approval-view.ts`.
- Modify root capabilities.json for all B3 both rows through held list, with
  concrete argv, args, and expect parity vectors.
- Add test/b3-cli-mcp-parity.test.ts; extend capability audit; regenerate
  docs/reference/events-daemon-cli.md and docs/reference/events-daemon-mcp-tools.md.

**Tests first, in order**

1. Snapshot every normal Commander/MCP registration, including `approval view`,
   and drive it through existing stand-ins: both sides reach exactly the listed
   operation with the same non-secret arguments. `approvalView` vectors prove
   authoritative preview, stale id, digest mismatch, daemon challenge, expiry,
   and that `approve` still re-plans at its final fence.
2. Prove the paired target-test selector is active/approved only and has no
   pending-context field; judge/budget/kind commands return their typed E/E2
   unavailable results with zero network; typed empty holds are exact; and the
   `targetTest` openWorld annotation is exact.
3. Wire areas one at a time: approval/rule/target; subscriber/delivery/held
   list; judge/budget/kind/model. Add each capability row in the same change as
   command/tool—never postponed to an audit task.

**Commands / passing**

Run pnpm sync:reference, focused surface tests, pnpm verify:reference,
pnpm verify:parity --strict, then pnpm verify. Passing means no unmapped
Commander leaf/tool; shared operations have distinct argument vectors; generated
references show no secret action.

**Mutations**

Delete command/tool/row/export; swap tools; make one side reach another
operation; loosen a Zod schema; accept a pending selector on paired CLI/MCP;
accept stale/digest-mismatched `approvalView`; let an unavailable operation
produce state or network; allow MCP claim; or mark target test local. Each
fails its particular parity/semantic test.

**Commit:** feat(events-daemon): expose B3 paired control operations

**P1-only review:** CLI/MCP-to-operation identity, approval-view challenge and
final re-plan behavior, absent pending selector, schemas, E/E2 results,
annotations, and generated references only.

## Batch 5 — human-only exceptions

### Task 6 — terminal/app exceptions and complete secret surface (high risk)

**Files**

- Modify packages/events-daemon/src/cli/program.ts, runtime/owner.ts,
  control/protocol.ts, and Task 2/3 operations.
- Modify root capabilities.json for rule test-retained, target resume, held
  decide, all eight secret rows, and dryrun exception operation/reason rows.
- Add test/b3-human-only-surface.test.ts, test/b3-secret-cli.test.ts,
  test/b3-mcp-absence.test.ts, test/b3-secret-origin.test.ts, and generated
  reference updates.

**Tests first, in order**

1. Compare capability matrix, Commander leaves, MCP tools/list, schemas,
   descriptions, structured/text output, and source exports. Any omitted row or
   secret leakage fails.
2. Fake-TTY tests cover agent marker/non-TTY/redirected stdin/json, no-echo
   prompt, one-time controlling-TTY reveal, receipt-only audit/result/log, and
   secret-URL scans. A raw authenticated control client that labels itself
   `app`, `window`, or `secrets` must receive
   `APP_SECRET_CAPABILITY_UNAVAILABLE` before prompt/store activity; only
   `interactive-terminal` reaches the Task 2 owner operation. This test does
   not pretend a caller-selected label is C's future capability.
3. Retained/resume/held tests prove allowed CLI reaches named operation and
   prohibited MCP registration is absent. The pending target-test request is
   reachable only inside the terminal approval flow, not as an ordinary CLI
   leaf or MCP registration.
4. Register only allowed CLI leaves/owner requests; add exception rows/reasons/
   operation fields; regenerate references; drive parity with synthetic prompt.

**Commands / passing**

Run focused tests, pnpm sync:reference, pnpm verify:skills,
pnpm verify:reference, pnpm verify:parity --strict, then pnpm verify. Passing
means no secret command/tool/reference/schema/output escapes, terminal checks
precede prompt/IPC, forged app/window labels refuse with the stable code, and
loopback seal sees no external connection.

**Mutations**

Expose a secret tool/schema; change reason; accept secret argv/redirected input;
emit JSON/reveal twice; log URL/reference; omit TTY/agent check; direct-store
instead of owner path; accept a forged app/window label; expose resume or a
pending-target selector over MCP. Each fails named test.

**Commit:** feat(events-daemon): add B3 human-only control surface

**P1-only review:** complete named exception set, all content sinks, prompt/
origin gates, forged-label refusal, pending-flow-only selection, and
synthetic-secret parity driver.

## Batch 6 — health

### Task 7 — lineage and pending-completion doctor

**Files**

- Modify `packages/events-daemon/src/operations/doctor.ts` and its Task 5
  owner registration only; add `runtime/b3-doctor-projection.ts` that reads
  Task 2 control ports without editing a writer entrypoint.
- Add `src/operations/contracts/doctor-v1.schema.json` and its checked
  TypeScript `DoctorReportV1` binding.
- Modify CLI/MCP doctor description/render and capability vectors if needed.
- Add test/b3-doctor.test.ts, test/b3-doctor-content-scan.test.ts, and
  test/b3-doctor-awaiting-reapproval.test.ts, and generated reference output.

**Tests first, in order**

1. Build active, superseded-retained, pending, claimed, draining, failed,
   missing-secret, reset-degraded, source-retry, WhatsApp-list,
   lease/dead-letter/deadline, typed E/E2 unavailable, and
   `awaitingReapproval` fixtures. Assert every closed-schema field is a stable
   id/status/count/time/enum code, and reject an additional property.
2. Remove and re-add a stable account, restart the daemon, and prove doctor
   reports the exact account/scope as `awaitingReapproval`; no poll, cursor
   install, backfill, judge, or delivery runs until a newly approved activation
   creates a fresh point, after which the state changes through the schema.
3. Scan CLI, MCP structured/text, audit, logs for encrypted/plain sender data,
   secret/ref/fingerprint, URL component, raw tuple, alias, provider response,
   or stack.
4. Implement schema/owner query; add result version to C/E contract test;
   regenerate references.

**Commands / passing**

Run focused doctor tests, pnpm sync:reference, pnpm verify:parity --strict, then
pnpm verify. Passing means one owner operation on both surfaces reports pending
completion/lineage without content.

**Mutations**

Omit cutover point; report active pointer instead of lineage; hide claimed
drain; omit missing-secret kind; collapse `awaitingReapproval` into absence;
poll/backfill after restart without a fresh activation; stale WhatsApp state;
add an unrecognised schema property; or serialize a forbidden field. Each fails
its named test.

**Commit:** feat(events-daemon): report B3 lineage and recovery health

**P1-only review:** joins, K6 restart behavior, closed schema/data
minimisation, content scan, and no writer-entrypoint bypass.

## Batch 7 — serial consumer contracts

### Task 8 — declared service skill family and agentcomms-events

**Files**

- Modify packages/events-daemon/package.json, scripts/channels.mjs,
  scripts/sync-skills.mjs, scripts/verify-skills.mjs, and registry/skill tests.
- Add skills/_shared/contract-events.md and skills/agentcomms-events/SKILL.md;
  generate its references/contract.md and references/fit.json; update README
  via pnpm sync:skills.
- Add test/events-service-skill-family.test.mjs and
  test/events-skill-safety.test.mjs.

**Tests first, in order**

1. Add registry fixtures for service family discovery, unknown/duplicate prefix,
   missing contract, malformed optional `skills`, `skills` on a non-service,
   and service accidentally treated as a channel.
2. Add skill fixtures for missing safe workflow, secret request/invocation,
   human-only instruction, stale tool, missing plain/enveloped wording, and
   missing judge-off/approval handoff.
3. Implement strict declaration support; author compact skill/contract; sync.

**Commands / passing**

Run pnpm sync:skills, pnpm verify:skills, focused registry/skill tests, then
pnpm verify. Commit the generated README update before beginning Task 9. Passing
means generated copies/README current, skill request-only, no non-channel
manifest, and static safety scan blocks unsafe instruction.

**Mutations**

Hard-code prefix; remove declaration validation; put `skills` on a non-service;
make service a channel; add secret instruction; omit handoff; or name absent
tool. Each fails named test.

**Commit:** feat(skills): add safe local event-emission guidance

**P1-only review:** registry derivation, generated files, every imperative
skill sentence.

### Task 9 — versioned C/E compatibility contract (after Task 8 README sync)

**Files**

- Modify `packages/events-daemon/src/operations/b3-contract.ts` and exports;
  add `src/operations/contracts/b3-control-v1.schema.json`, checked-in
  `test/fixtures/b3-control-contract-v1/` request/result/error vectors, and
  `test/fixtures/b3-approval-preview-v1/` shared renderer fixtures.
- Add `test/b3-consumer-contract.test.ts`,
  `test/b3-contract-type-drift.test.ts`, and
  `test/b3-preview-fixtures.test.ts`; do not add a B3 phase-E gate test.
- After Task 8's `pnpm sync:skills` README update is committed, update
  generated reference pages and the short B3 compatibility section in
  `packages/events-daemon/README.md`.

**Tests first, in order**

1. Generate or validate the JSON Schema against the exported TypeScript
   operation types, then validate every checked-in request/result/error vector:
   every desktop-callable D10 row, `approvalView` success/stale/digest/challenge
   variants, E/E2 unavailable variants, typed empty holds, and stable errors.
   A deliberate TypeScript/schema/operation discriminator drift must fail.
2. Feed every `b3-approval-preview-v1` fixture to the B3 TypeScript terminal
   renderer and compare the structured preview/challenge result. Keep the
   fixture files language-neutral and content-free; C's Rust renderer consumes
   these exact files and either generates or validates Rust types from the same
   schema in Phase C.
3. Assert the data-only consumer fixture has no desktop or judge-runtime import,
   secret operations accept only `interactive-terminal`, every raw app/window
   label gets `APP_SECRET_CAPABILITY_UNAVAILABLE`, and the approval-screen-only
   pending selector is absent from ordinary CLI/MCP vectors.
4. Export contract and docs without importing desktop or judge runtime. Record
   the successor requirement: E imports its real code and this contract, lands
   the build/ship negative gate before any owner registration/callable judge,
   and requires B3 merged.

**Commands / passing**

Run focused consumer/contract tests, pnpm sync:reference, pnpm verify:reference,
pnpm verify:parity --strict, then pnpm verify. Passing means the data-only
surface is schema/type/vector-stable, preview fixtures render in TypeScript,
and B3 makes no claim to have proved E's future build/ship gate.

**Mutations**

Remove a capability/operation/vector; change a reason or discriminator; make
schema and TypeScript disagree; export a secret value/type; allow an ordinary
app/window origin; put a pending selector in ordinary CLI/MCP; or change a
shared preview fixture's expected rendering. Each fails its named contract
test.

**Commit:** test(events-daemon): lock B3 contracts for desktop and judges

**P1-only review:** schema/type/vector equivalence, fixture neutrality and
renderer use, terminal-only secret origin, successor E-gate ownership, and
documentation drift.

## Batch 8 — release-quality integration

### Task 10 — whole-phase proof, reference reconciliation, and review split (high risk)

**Files**

- Reconcile only Task 1–9 files, root capabilities.json, generated event
  references, generated skill files/README, and CHANGELOG.md if policy needs it.
- Add packages/events-daemon/test/b3-e2e-surface.test.ts; extend
  test/built-surfaces.test.ts, test/capability-audit.test.ts,
  test/consumer-check.mjs, and parity mutation coverage.
- Add no feature except a narrowly evidenced integration repair.

**Tests first, in order**

1. Start sealed foreground owner; drive every both row from CLI and MCP, every
   exception from permitted fake-TTY route, and each forbidden MCP route. All
   must use production owner operation. Drive `approvalView` stale/digest/
   challenge cases, prove its terminal approval re-plans, exercise the pending
   target test only through the approval-flow context, and prove forged secret
   window labels refuse.
2. Run complete mutation ledger: quiesce, post-await, SQL scope, purge closure,
   secret exposure including SQLite/WAL/free-page sentinels, schema/type drift,
   full-closure mutant loading, and parity swaps; structural scripts must fail
   for unpaired data.
3. Regenerate skills/references; verify packed tarballs and no browser node edge;
   make only integration repair required by a named failing test.

**Commands / passing**

Run, in order: pnpm sync:skills; pnpm sync:reference; focused B3 tests under
loopback preload; pnpm verify:skills; pnpm verify:reference; pnpm verify:parity
--strict; pnpm verify:browser; pnpm verify. Passing means complete root verifier,
including strict parity and packed consumers, is green. Browser verification
remains a B2 release requirement; B3 must not reintroduce a node edge.

**Mutations**

Run every guard-manifest mutation and remove one generated reference command,
capability row, operation export, exception reason, and consumer-contract entry.
Also mutate the E/E2 unavailable discriminator, pending-context binding,
sanitisation/envelope step, and `awaitingReapproval` restart fence. The named
check must fail for each.

**Commit:** test(events-daemon): verify Phase B3 control surface

**Task review:** narrow P1 integration review, then the parallel split below.
Each fix receives another narrow P1 review in its area before merge.

## End-of-phase parallel review split

Use separate review worktrees and read contributor code before execution. Each
reviewer reports P1 only; coordinator resolves overlaps then reruns full verify.

| Area | Covers |
|---|---|
| Secret boundary/rotation | Closed exceptions, terminal-only B3 origin and forged-window refusal, all sinks including SQLite/WAL/free pages, independent migration, cleanup, quiescer, retired-master refusal. |
| Stateful fences/purges | Every after-await recheck, readiness predicate, pending activation-context selector, resume, retained/WhatsApp visibility, retry/drop, identity scope, cancellation closure. |
| Surface/parity/tooling | Commander/MCP/capability identity, approval-view challenge/re-plan, strict drivers, reference generation, full-closure mutation ledger. |
| Lineage/consumers | Doctor closed schema and K6 restart state, pending completions/cutovers, shared preview fixtures, C promise, E-gate successor ownership, no desktop/judge scope creep. |
| Skill/release/package | Service skill declaration, instruction safety, generated files, holds, dependency/consumer checks, PR evidence. |


## §5 coverage ownership

Every B3-owned §5 row has exactly one primary task. Other tasks may add a
regression fixture but do not own acceptance.

| §5 row / B3 clause | Primary task | Named proof |
|---|---:|---|
| Conditions/local tests: CLI/MCP catalogue-only rule test; retained exact saved version; hostile sanitised/enveloped output; pending target approval context; fixed synthetic input/taint | 3 | b3-rule-test.test.ts; b3-retained-read.test.ts; b3-target-test.test.ts; b3-pending-target-context.test.ts |
| Judges/budgets: real surface with typed zero-network E unavailable result, no invented rule global fields | 4 | b3-e-phase-contract.test.ts |
| Judge kinds/Laya: E unavailable and E2-required variants, no pointer/download/worker/network before their phase | 4 | b3-e-phase-contract.test.ts |
| Tightening/account revocation: B3 secret/object purge closure | 4 | b3-purge-closure.test.ts |
| K6 re-added account: explicit doctor dark state and no restart poll/backfill before fresh activation | 7 | b3-doctor-awaiting-reapproval.test.ts |
| Delivery state/caps: retry/drop fence, superseded retention, target-test cap, degraded reset resume | 3 | b3-target-resume.test.ts; b3-target-test.test.ts |
| Delivery control surface and dual-surface drive | 5 | b3-cli-mcp-parity.test.ts |
| Encryption/reset: old-key re-encryption, late writer quiesce, referenced retired master, resume | 2 | b3-master-rotation.test.ts |
| Secrets engine: slots/readiness, private rotate rekey, migration/core isolation, and persistent-metadata leak scan | 2 | b3-secrets.test.ts; b3-secret-migration.test.ts; b3-secret-metadata-scan.test.ts |
| Secrets surface: individual exceptions; no MCP/schema/output exposure; hidden/reveal; terminal-only B3 origin | 6 | b3-mcp-absence.test.ts; b3-secret-origin.test.ts |
| WhatsApp list-change: dry-run read remains behind real live-list gate | 3 | b3-retained-read.test.ts |
| Control/storage/app: independent event selector/lock/store and content-free app contract | 2 | b3-secret-migration.test.ts |
| Parity/phases/packaging: every row/reason driven; resume/dryrun/secrets absent MCP; data-only C/E fixture (actual E gate is E-owned) | 9 | b3-consumer-contract.test.ts; b3-contract-type-drift.test.ts |
| D10 doctor completeness | 7 | b3-doctor.test.ts |
| D10 event skill | 8 | events-skill-safety.test.mjs |

## Spec traceability

The table maps every normative B3 requirement to one task and named proof.
Where B3 creates a new path through B1/B2/D fencing, the inherited normative
sentence is included so the surface cannot bypass it.

| Spec lines | Requirement | Task | Named proof |
|---|---|---:|---|
| §4 2825 | Full D10 surface, exceptions, named secrets/migration, reads/resume, doctor, skill | 10 | b3-e2e-surface.test.ts |
| D2 462–69 | Read/retry/disclosure checks exact non-revoked versions, lineage, switch, account, WhatsApp; superseded passes | 3 | b3-retained-read.test.ts |
| D2 471 | Secrets never enter model context; named set is closed | 6 | b3-mcp-absence.test.ts |
| D2 475 | Signing create/rotate empty/current, generated reveal, overlap, no caller bytes | 2 | b3-secrets.test.ts |
| D2 476 | Hidden secret URL makes incomplete version; authority/fingerprint only; no slot replace | 2 | b3-secrets.test.ts |
| D2 477 | Subscriber selector/create/rotate, reveal, invalidation and stream close | 2 | b3-secrets.test.ts |
| D2 478 | Judge key empty/current slot, hidden input, atomic replace/no echo | 2 | b3-secrets.test.ts |
| D2 480–86 | MCP-proposed target/subscriber/hosted-judge versions stay disabled until exact secret readiness at prepare/claim/activation/delivery | 2 | b3-object-readiness.test.ts |
| D2 480–86 | TTY/agent gate, no non-TTY argv/stdin, no JSON, privileged reveal, and no MCP secret surface | 6 | b3-human-only-surface.test.ts; b3-secret-origin.test.ts |
| D2 488–93 | Slot generation versus URL version and content-free secret audit | 2 | b3-secrets.test.ts |
| D2 495–501 | Per-secret exception rows/exact reason; no MCP names/schemas/results/text | 6 | b3-mcp-absence.test.ts |
| D7 1210–14 | Plain/secret URL separation/canonical fingerprint/no output leak | 2 | b3-secrets.test.ts |
| D7 1218 | Dryrun terminal/app renderer and WhatsApp show visibility gate | 3 | b3-retained-read.test.ts |
| D7 1227–33 | Reads consume no cap and obey retention | 3 | b3-retained-read.test.ts |
| D7 1244–55 | Retry/drop/purge terminal retention semantics | 4 | b3-delivery-control.test.ts |
| D7 1257–65 | Retry exact fence/only nextAt; dead letter not redriven; drop purges | 4 | b3-delivery-control.test.ts |
| D7 1267–82 | Reset barrier shape/reference lifetime/final-reference cancellation | 3 | b3-target-resume.test.ts |
| D7 1284–95 | Terminal/app degraded resume creates fixed new notice; no MCP/old redrive | 3 | b3-target-resume.test.ts |
| D8 1723–38 | Versioned master, bounded reencrypt, retain old until no record names it | 2 | b3-master-rotation.test.ts |
| D8 1740–53 | Reset blocks later content until human resume; doctor records reset | 3 | b3-target-resume.test.ts |
| D8 1755–57 | Rule test zero provider network/no fresh read | 3 | b3-rule-test.test.ts |
| D8 1762–69 | Pre-I/O live fence/barrier/deadline; superseded allowed | 3 | b3-target-resume.test.ts |
| D8 1771–80 | Dryrun read fence and subscriber rotation behavior | 2 | b3-secrets.test.ts |
| D8 1782–86 | Async commits compare generation | 1 | b3-write-after-await.test.ts |
| D9 1839–50 | Daemon-owned event state/refs; stable account id/fresh core config; no secret sentinel in SQLite metadata/WAL/free pages | 2 | b3-secret-migration.test.ts; b3-secret-metadata-scan.test.ts |
| D9 1883–92 | Startup/control/read live-list application; unreadable hides reads | 3 | b3-retained-read.test.ts |
| D9 1901–11 | WhatsApp dryrun read has raw tuple/live-list gate | 3 | b3-retained-read.test.ts |
| D9 1913–20 | Independent selector/namespace/owner-only file/no fallback/core config | 2 | b3-secret-migration.test.ts |
| D9 1922–30 | Lock/SQLite-derived refs; verify-before-commit/removal order/reconcile | 2 | b3-secrets.test.ts |
| D9 1932–41 | Terminal/app migration lock/snapshot/copy/selector/rollback/leftover/core compatibility | 2 | b3-secret-migration.test.ts |
| D9 1943–52 | Account removal purge and late writer recheck | 4 | b3-purge-closure.test.ts |
| B1 K6 | Re-added stable account remains visibly dark through restart until a new approved activation takes a fresh point | 7 | b3-doctor-awaiting-reapproval.test.ts |
| D10 2002–04 | Every operation/capability; both unless explicit exception | 5 | b3-cli-mcp-parity.test.ts |
| D10 2006–17 | Complete operation table | 10 | b3-e2e-surface.test.ts |
| D10 2019–23 | Rule test catalogue/local/deterministic/sanitised/enveloped | 3 | b3-rule-test.test.ts |
| D10 2025–27 | Provider source types only; reject every agentcomms type | 3 | b3-rule-test.test.ts |
| D10 2029–33 | Retained test exception/no account arg/exact saved rule version/network/live account/safe renderer | 3 | b3-retained-read.test.ts; b3-rule-test.test.ts |
| D10 2035–47 | Target test approval/synthetic/taint/cap/transport plus exact pending approval-screen context; no MCP/ordinary CLI context | 3 | b3-target-test.test.ts; b3-pending-target-context.test.ts |
| D10 2035–47; cross-plan 5 | Judge controls remain typed E/E2 unavailable with zero network before their producer phase | 4 | b3-e-phase-contract.test.ts |
| D10 2049–60 | MCP limits; individual exceptions; same daemon op; run exception | 6 | b3-mcp-absence.test.ts |
| D10 2062–64; cross-plan 5 | Budget surface returns typed E unavailable before E; no pending document/pointer/approval exists in B3 | 4 | b3-e-phase-contract.test.ts |
| D10 2066–69 | First activation response/repeated MCP cannot claim/terminal replan drift | 5 | b3-cli-mcp-parity.test.ts |
| D10 2071–75; cross-plan 5 | Kind/model surface returns typed E/E2 unavailable variants before E/E2 | 4 | b3-e-phase-contract.test.ts |
| D10 2076–86 | Complete content-free doctor | 7 | b3-doctor.test.ts |
| D10 2088–90 | Safe event skill | 8 | events-skill-safety.test.mjs |
| D11 2100–12, 2121–27 | Kinds off/no judge call until enabled; disable purge hook | 4 | b3-operator-control.test.ts |
| §5 2856–65 | Local/retained/judge/target test matrix | 3 | b3-rule-test.test.ts |
| §5 3045–71 | Retry/drop/dryrun/target-test/reset-resume matrix | 3 | b3-target-resume.test.ts |
| §5 3113–35 | Rotation/reset/resume proof | 2 | b3-master-rotation.test.ts |
| §5 3136–50 | Secret exception/exposure/slot/migration/core isolation | 2 | b3-secret-migration.test.ts |
| §5 3284–97 | WhatsApp hidden-row dryrun gate/restart | 3 | b3-retained-read.test.ts |
| §5 3326–36; cross-plan 1–7 | Strict parity/exceptions/service packaging plus data-only C/E schema/vectors/fixtures; real E build/ship gate is E-owned | 9 | b3-consumer-contract.test.ts; b3-contract-type-drift.test.ts; b3-preview-fixtures.test.ts |
| Cross-plan 2 | Paired approval view returns authoritative preview/challenge and approval re-plans at final fence | 5 | b3-cli-mcp-parity.test.ts |

## Release and pull-request evidence

The B3 PR remains a held-package change. Proposed lockstep version:
**0.16.0-events-b3** — a minor prerelease because it adds the documented
CLI/MCP control surface and skill, while the suffix keeps it off normal release.
It does not lift either hold or publish a package.

The PR carries every CONTRIBUTING requirement: person-facing change/how;
proposed version and semver reason; focused tests plus pnpm verify,
pnpm verify:parity --strict, pnpm verify:skills, pnpm verify:reference, and
pnpm verify:browser; docs/reference/skill changes; changelog line or
“No changelog: held Phase B3 has no released artifact” if maintainer selects
that policy; provenance explaining the spec/design sources read on 2026-10-10,
no live provider test, sealed fakes/synthetic data only, and AI assistance;
and an explicit no-real-data/no-secret statement. It never sends email, Slack,
Resend, webhook traffic, or any provider message.

## Commit sequence

1. refactor(events-daemon): prepare B3 parity and guard evidence
2. feat(events-daemon): add B3 human secret control engine
3. feat(events-daemon): add fenced B3 retained and reset operations
4. feat(events-daemon): add B3 operator control services
5. feat(events-daemon): expose B3 paired control operations
6. feat(events-daemon): add B3 human-only control surface
7. feat(events-daemon): report B3 lineage and recovery health
8. feat(skills): add safe local event-emission guidance
9. test(events-daemon): lock B3 contracts for desktop and judges
10. test(events-daemon): verify Phase B3 control surface

The commit message for this plan document is:

docs(plan): phase B3 — apply plan review
