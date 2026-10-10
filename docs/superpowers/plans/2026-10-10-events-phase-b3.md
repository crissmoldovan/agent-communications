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
| B1 PR #59 / commits `355bd076`, `ccf201e1`. | The B3 caller of `rotateAndReencrypt` quiesces writers and cannot destroy a referenced retired master. |
| B2 private reset recovery; B3 owns human target resume. | Resume creates a new notice, never redrives the old dead letter or offers MCP escape. |
| B2 post-await fences and Phase-D WhatsApp composition. | Reads/resume re-enter the live fence/visibility gate after every await; no B3 bypass. |
| D stable IDs, source-owned vocabulary, source-scope fences. | Every raw/external identity write is account/source scoped; B3 imports channel vocabulary. |
| B2 sealed transport and D injectable adapters. | Tests use injected fakes or loopback under `test/helpers/loopback-seal-preload.mjs`; never real providers. |

The daemon and `@agentcomms/events` remain held. B3 neither removes an
`agentcommsRelease.hold` nor adds a send API, real address, secret, message,
URL, or token to tests or fixtures.

## Decisions the spec leaves to the plan

### B3-1 — one owner operation is the only implementation path

Every B3 command and tool calls one exported function in
`packages/events-daemon/src/operations/`. That function only uses
`EventControlClient`; it never opens SQLite, a secret backend, a provider, or a
target itself. The authenticated owner routes the request to a typed runtime
service, so CLI, MCP, and later desktop receive the same validation,
transaction, error code, and content-free result.

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
for an immutable target/subscriber/judge slot or reset barrier: B3 never
silently selects “latest”. `—` means `mcp: null`, `status: "exception"`.

| Capability id | CLI command | MCP tool | operation | status / reason |
|---|---|---|---|---|
| `events-daemon.rule.test` | `rule test <document> <catalogue-example>` | `events_rule_test` | `ruleTest` | both |
| `events-daemon.rule.test-retained` | `rule test-retained <event-id> --rule <rule-id> --version <n>` | — | `ruleTestRetained` | exception — retained sender content only a person may select outside model context |
| `events-daemon.target.test` | `target test <target-id> --version <n>` | `events_target_test` | `targetTest` | both |
| `events-daemon.target.resume` | `target resume <target-id> --version <n>` | — | `targetResume` | exception — only a person may reopen a degraded reset barrier |
| `events-daemon.subscribers.list` | `subscribers list` | `events_subscribers_list` | `subscribersList` | both |
| `events-daemon.subscriber.add` | `subscriber add <document>` | `events_subscriber_add` | `addSubscriber` | both |
| `events-daemon.subscriber.update` | `subscriber update <document>` | `events_subscriber_update` | `updateSubscriber` | both |
| `events-daemon.subscriber.remove` | `subscriber remove <subscriber-id>` | `events_subscriber_remove` | `removeSubscriber` | both |
| `events-daemon.judges.list` | `judges list` | `events_judges_list` | `judgesList` | both |
| `events-daemon.judge.add` | `judge add <document>` | `events_judge_add` | `addJudge` | both |
| `events-daemon.judge.update` | `judge update <document>` | `events_judge_update` | `updateJudge` | both |
| `events-daemon.judge.remove` | `judge remove <judge-id>` | `events_judge_remove` | `removeJudge` | both |
| `events-daemon.judge.test` | `judge test <judge-id> --version <n>` | `events_judge_test` | `judgeTest` | both; zero-network unavailable/disabled guard until E |
| `events-daemon.budget.show` | `budget show` | `events_budget_show` | `budgetShow` | both |
| `events-daemon.budget.update` | `budget update <document>` | `events_budget_update` | `updateBudget` | both; MCP prepares only |
| `events-daemon.judge-kinds.list` | `judge kinds list` | `events_judge_kinds_list` | `judgeKindsList` | both |
| `events-daemon.judge-kind.enable` | `judge kind enable <kind>` | `events_judge_kind_enable` | `enableJudgeKind` | both; MCP prepares only |
| `events-daemon.judge-kind.disable` | `judge kind disable <kind>` | `events_judge_kind_disable` | `disableJudgeKind` | both |
| `events-daemon.judge-model.status` | `judge model status` | `events_judge_model_status` | `judgeModelStatus` | both |
| `events-daemon.judge-model.remove` | `judge model remove` | `events_judge_model_remove` | `removeJudgeModel` | both |
| `events-daemon.deliveries.list` | `deliveries list` | `events_deliveries_list` | `deliveriesList` | both |
| `events-daemon.delivery.retry` | `delivery retry <delivery-id>` | `events_delivery_retry` | `retryDelivery` | both |
| `events-daemon.delivery.drop` | `delivery drop <delivery-id>` | `events_delivery_drop` | `dropDelivery` | both |
| `events-daemon.held.list` | `held list` | `events_held_list` | `heldList` | both |
| `events-daemon.held.decide` | `held decide <decision-id> <accept\|reject>` | — | `decideHeld` | exception — held decision only terminal/app person may resolve |
| `events-daemon.target-secret.create` | `target secret create <target-id> --version <n>` | — | `targetSecretCreate` | secret exception |
| `events-daemon.target-secret.rotate` | `target secret rotate <target-id> --version <n>` | — | `targetSecretRotate` | secret exception |
| `events-daemon.target-url.set` | `target url set <target-id> --version <n>` | — | `targetUrlSet` | secret exception |
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
permitting an unapproved request.


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
only. C later sends the same owner request from its labelled \`secrets\` window,
not a second secret-store API.

Testing only Commander absence from MCP would miss direct import, machine
output, and accidental echo. Allowing an MCP “sensitive” argument leaves a
durable transcript; both alternatives are rejected.

### B3-4 — slots, independent migration, and master rotation differ

\`EventSecretStore\` gains \`judge\` owner/\`judge-key\` purpose, retains target
signing/secret-URL/subscriber-bearer purposes, and derives its references only
from immutable versions, pending operations, and retained generations.

- Create/set verifies the exact slot empty; rotate verifies its exact current generation.
- Signing rotation retains current + previous; subscriber rotation invalidates prior generation and closes every old-generation stream; judge-key rotation atomically replaces its hosted-key generation.
- A secret URL is canonicalised in memory, stored only in a *new incomplete* target version, and returns only \`{ scheme, host, port, sha256 }\`; it never overwrites a slot or moves a rule.
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
| targetTest | approval/fence lookup, synthetic transport and settlement | exact approved target/rule context, cap bucket, target version/address set, current generation before charge/result |
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

### B3-7 — E owns judge execution; B3 owns its stable surface

B3 persists/reads inert immutable judge, budget, and kind documents, enforces
all kinds disabled, and gives each D10 command/tool a real operation/parity row.
It supplies validation, pending preview, removal/disable purge hooks, and
stable \`FEATURE_UNAVAILABLE\`/\`JUDGE_KIND_DISABLED\` failures. \`judge test\`
accepts no caller content, uses fixed synthetic identity, and makes zero
network calls because no judge is callable before E. \`held list\` may report
content-free metadata; human-only \`held decide\` returns \`HOLDS_UNAVAILABLE\`
until E installs decision semantics. MCP may prepare budget/kind enablement,
but cannot claim one.

E replaces unavailable internals behind the same functions, not new CLI/MCP
surfaces. Omitting them until E makes C/E depend on no API; executing a judge
early violates the phase gate. Both alternatives are rejected.

### B3-8 — doctor is content-free lineage and recovery state

\`doctor\` remains dual-surface and returns a versioned TypeScript schema:
protocol/owner health; switch/pause/generation; installation id; active approval
lineages/immutable activation id; current cutover plus exact selected
account/scope points; retained-work superseded versions; pending/claimed/
draining activation and enable-all completion; terminal audit code; source retry
age/count/last resolution/lag; lease/held/dead-letter/deadline/missing-secret
kind; judge kind/model/boundary state; and per-WhatsApp account list application
status/time. It never returns content, secret/ref/fingerprint, URL component,
provider response, raw tuple, account alias, or stack.

Structured fields, rather than prose-only doctor, allow C rendering and E
extension without parsing text.

### B3-9 — narrow C/E dependency contract

| Consumer | B3 surface it may call | Not supplied by B3 |
|---|---|---|
| C desktop | Authenticated operations above; shared approval preview/challenge/complete shape; dedicated-secrets-window origin for secret operations; safe dry-run/retained/resume/held/doctor schemas. | Tauri, Rust IPC, CSP/navigation, UI, and desktop secret transport. C must reuse B3 owner secret operations. |
| E judges | \`judge*\`, \`budget*\`, \`held*\`, \`judge kind*\` signatures/rows; disabled documents; purge hooks; doctor extension; data-only \`B3_HUMAN_SECRET_COMPLETION_CONTRACT\`. | Provider/local judge calls, holds/budget ledger, Laya runtime/model, or approval bypass. |

The export lists eight secret capability IDs, exact reason, owner operation,
and \`terminalOrSecretsWindow\` origin—never a value. E's build/ship gate stubs
or removes it and must fail, rather than grepping command strings.

### B3-10 — event skill is declared service skill family

Add \`skills/agentcomms-events/SKILL.md\`, generated contract/fit files, and
\`skills/_shared/contract-events.md\`. Extend strict
\`agentcommsPackage.kind: \"service\"\` tooling with validated optional
\`skills: { prefix: \"agentcomms-\", contract: \"skills/_shared/contract-events.md\" }\`.
\`scripts/channels.mjs\` exposes it through the same \`skillFamilies\` registry
used by skill sync/verify. It does not add an \`\"agentcomms\"\` channel manifest.

The skill teaches catalogue/source inspection, proposal of disabled secretless
documents, catalogue-example \`rule test\`, plain/enveloped representation,
judge kinds initially off, and handing approval id to a person. It explicitly
never requests/types secrets; never invokes dry-run, retained test, target
resume, held decision, approve, or secret operation; never claims activation.

Hard-coding \`agentcomms-events\` in \`sync-skills\` loses registry guarantees.
Making daemon a channel violates D14. The declared service-family route is the
smallest consistent choice.


## Spec amendments to raise with the owner

The plan proceeds conservatively, but these gaps need owner confirmation before
merge.

| Id | Lines | Ambiguity / contradiction | Plan assumption pending amendment |
|---|---:|---|---|
| B3-A | D2 471–500; D8 1731–33; D10 2016; B1 plan line 195 | D2 closes public secret operations, yet B1 says B3 human-secret operations invoke master rotation. | No public master command; private master rekey occurs during the three named credential rotate operations. Owner should make that caller normative or name another. |
| B3-B | D2 475–78; D10 2016; D9 1922–27 | Immutable versions own slots, but command text supplies target/judge id only and subscriber create supplies no id. | Require non-secret id and version; never choose latest. Owner should publish exact CLI grammar. |
| B3-C | D10 2013, 2035–47; §4 2825, 2828, 2832–33 | B3 promises full D10 including judge test/held controls, but E owns judges/holds and no judge runs before E. | Register safe zero-network unavailable controls; owner should say whether this is intended meaning of surface. |
| B3-D | D10 2014, 2049–57 | held decide is in the normal table but MCP cannot resolve held decisions; no exception reason provided. | Make terminal/app exception with B3-2 reason; owner should confirm wording/approval. |
| B3-E | D10 2029–33 | rule test-retained eventId does not identify rule/version or saved/pending form. | Require rule/version, saved exact version only. Owner should specify pending-screen behavior. |
| B3-F | D10 2035–47 | Pending target test is stated by analogy, without an approval-context grammar. | Public CLI/MCP tests active approved target only; C pending screen later uses internal context MCP/ordinary CLI reject. |
| B3-G | D10 2088–90; D14 2675–2713; §5 3326–31; current sync-skills | Required agentcomms-events has no current service-family discovery, while D14 forbids a non-channel agentcomms kind. | Add validated service skill family; owner should amend strict D14 service declaration shape. |
| B3-H | D10 2076–86 | Doctor has no stable response schema or leak-safe meaning of missing secret. | Versioned content-free schema; report kind/owner/version/status counts only. Owner may prescribe names. |

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

test/b3-guard-manifest.json names predicates per write.
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

The manifest fields are case, operation, productionEntry, test, mutation, and
mutationTest. The verifier fails if a B3 test lacks a mutation, a mutation lacks
a named test, a case uses a test model/default shared branch rather than the
actual EventControlClient/CLI/MCP/runtime operation, or named cases share a
default fixture. The runner copies only targeted source to a temporary
directory, applies the declared small textual mutation, runs the exact test
under loopback preload, and requires non-zero output naming that case. It never
changes the worktree or opens an external connection. Package test and root
verify invoke it, so it cannot be waived by omitting a focused command.

## Batch map and safe parallelism

There are **ten tasks in five batches**. After Task 1 establishes typed B3
dispatcher seams, Tasks 2–4 can proceed in three worktrees with disjoint
production ownership (Task 2 alone owns migrations). Tasks 8 and 9 can proceed
in parallel after Task 7. All other tasks are serial because they share
registries or consume a prior safety invariant.

| Batch | Tasks | Parallel group | Dependency rationale |
|---|---|---|---|
| 1 — proof substrate | 1 | none | Exception driving and mutation accounting precede every public B3 row. |
| 2 — private safety engines | 2, 3, 4 | 2 + 3 + 4 | Secret rotation/migration, retained-read/reset, and inert operator services are isolated modules. |
| 3 — public surface | 5 → 6 → 7 | none | Pair normal rows, then exceptions, then doctor over final state. |
| 4 — consumer contracts | 8 + 9 | 8 + 9 | Skill tooling and C/E data-contract work are independent after Task 7. |
| 5 — integration | 10 | none | References, strict parity, all mutants, package proof, and review need all surfaces. |
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
  packages/events-daemon/test/b3-guard-manifest.json,
  packages/events-daemon/test/support/b3-mutants.ts,
  scripts/verify-b3-guard-coverage.mjs, and scripts/verify-b3-sql-scope.mjs.
- Refactor registration seams only in packages/events-daemon/src/cli/program.ts,
  src/mcp/server.ts, src/runtime/owner.ts, and src/control/protocol.ts:
  introduce typed B3 registrar/owner-service interfaces, but register no B3
  command/tool in this task.

**Tests first, in order**

1. Add red parity fixtures: exception with CLI but no operation; exception whose
   CLI reaches another operation; exception with an MCP tool; all must fail
   strict parity.
2. Add red structural fixtures: unpaired B3 case/mutation, a mutation which
   leaves its named test green, raw unscoped SQL, copied channel vocabulary.
3. Add red contract test pinning all 33 future IDs, commands, tool/null,
   operations, exact secret reason, and C/E export shape.
4. Implement schema/driver, synthetic prompt seam, guard manifest/temp mutation
   runner, and typed registrar seams. Do not expose behavior yet.

**Commands / passing**

Run focused parity/guard tests, then pnpm verify:parity --strict, then pnpm
verify. Passing means exception operations and absences are driven, malformed
fixtures fail, and full root verification including skills/reference/packages is
green.

**Mutations**

Remove exception operation; register absent MCP; swap CLI recorder; omit
case/mutation; remove account scope annotation; replace an imported vocabulary.
Each maps one-to-one to a failing named test.

**Commit:** refactor(events-daemon): prepare B3 parity and guard evidence

**P1-only review:** parity field validation, operation driving, prompt seam
reachability, and temporary mutation runner/loopback seal. No behavioral
surface may land.

## Batch 2 — private safety engines

### Task 2 — secret slots, independent migration, and quiesced master rotation (highest risk)

**Files**

- Modify packages/events-daemon/src/store/event-secrets.ts, records.ts,
  migrations.ts, runtime/owner.ts, runtime/scheduler.ts, runtime/locks.ts, and
  runtime/subscriber-streams.ts for writer lease/quiescer injection.
- Add src/runtime/b3-secret-control.ts, src/operations/secrets.ts, and
  src/domain/human-secret.ts.
- Add test/b3-secrets.test.ts, test/b3-secret-migration.test.ts,
  test/b3-master-rotation.test.ts, and b3-purge-closure entries.

**Tests first, in order**

1. Enumerate all eight slot actions; prove no argv/stdin/JSON/MCP input;
   exercise create/rotate/set receipts, one reveal, signing overlap, old-token
   close, atomic judge key, secret-URL new version, audit/output scans.
2. Create every secret kind; pause create/rotation either side of migration
   snapshot; cover both directions, rollback, leftover retry, restart, and
   released-core migration independence.
3. Pause old-key write after final re-encryption pass; prove quiescer waits,
   writers resume after failure, and referenced retired master refuses delete.
4. Implement forward migration, slot protocol, writer lease/quiescer, rotation
   caller, destruction scan, and guard-manifest/mutations.

**Commands / passing**

Run all focused tests under loopback preload, pnpm verify:parity --strict, then
pnpm verify. Passing means every backend is fake/injected, no synthetic
material appears in output, old-key late write cannot land, and core selector
is untouched.

**Mutations**

Remove slot conditional; skip read-back; select before verify; omit rollback;
omit stream close; release writer lease early; delete master without packed-key
scan; serialize reference/audit material. Each fails its named test.

**Commit:** feat(events-daemon): add B3 human secret control engine

**P1-only review:** lock order, physical-store cleanup paths, lease lifetime
from crypto through write, old-master scan, and every output sink.

### Task 3 — fenced retained reads, local tests, and target resume (high risk)

**Files**

- Modify packages/events-daemon/src/targets/dry-run.ts, runtime/dispatcher.ts,
  runtime/reset.ts, runtime/system-reset-outbox.ts, and existing disclosure,
  account, WhatsApp visibility helpers through published interfaces only.
- Add runtime/b3-retained-control.ts, operations/rule-test.ts,
  operations/target-test.ts, and operations/target-resume.ts.
- Add test/b3-retained-read.test.ts, test/b3-rule-test.test.ts,
  test/b3-target-resume.test.ts, test/b3-target-test.test.ts, and ledger rows.

**Tests first, in order**

1. Retained-read matrix: revoked/stale/account-removed/expired/WhatsApp hidden
   or unreadable rows refuse after decrypt/render races; superseded non-revoked
   row succeeds; no read charges/creates delivery; hostile renderer only.
2. Rule-test matrix: catalogue examples only; reject retained IDs/account IDs
   and known/unknown agentcomms types; agentic node not-evaluated; zero
   provider/judge/target/cursor/decision I/O. Add terminal/agent/MCP refusal
   for retained test.
3. Resume matrix: dead-letter/reset/restart/degraded barrier; exact referenced
   unrevoked target only; new 20/24 notice; old notice terminal; no crossing
   before success; final reference purges. Target test accepts ten fixed
   synthetic attempts across versions, eleventh refuses before transport.
4. Implement shared read fence, local evaluator, target-test preflight, resume
   transaction/rechecks. Do not register CLI/MCP yet.

**Commands / passing**

Run focused tests, pnpm verify:parity --strict, then pnpm verify. Passing proves
actual B2/D dispatcher/visibility fence use, only fake/loopback transports, and
resume never redrives old work.

**Mutations**

Remove post-decrypt fence; eagerly decrypt list; test active pointer instead of
bound revocation; omit WhatsApp gate; accept event id in rule test; allow
unapproved network; make old reset retryable; omit final reference check; reset
attempt/deadline. Each fails named case.

**Commit:** feat(events-daemon): add fenced B3 retained and reset operations

**P1-only review:** every after-await recheck, superseded/revoked distinction,
raw tuple scope, safe renderer, and zero-network proof.

### Task 4 — inert operator controls and purge hooks

**Files**

- Add packages/events-daemon/src/runtime/b3-operator-control.ts,
  src/operations/subscribers.ts, src/operations/judges.ts, and
  src/operations/deliveries.ts.
- Modify src/domain/versions.ts, runtime/revocations.ts, runtime/deliveries.ts,
  and runtime/lifecycle.ts only for exact-version validation/purge hooks; no E
  execution loop.
- Add test/b3-operator-control.test.ts, test/b3-delivery-control.test.ts,
  test/b3-identity-scope.test.ts, and ledger rows.

**Tests first, in order**

1. Exercise immutable subscriber/judge/budget documents, disabled kinds,
   MCP-preparation-only behavior, no judge call, and E-facing unavailable
   errors through production owner.
2. Exercise delivery list metadata; retry's state/attempt/deadline/generation/
   account/object fence and only-nextAt change; drop's same-transaction purge;
   held list and human-only decide refusal.
3. Collide account/source/object identities; prove each remove/revoke cancels
   orphaned claim/retained rows but preserves unrelated valid superseded work.
4. Implement services/hooks, SQL annotations, structural checker inputs; defer
   CLI/MCP registration.

**Commands / passing**

Run focused tests, pnpm verify:parity --strict, then pnpm verify. Passing means
every B3 operator has real owner request path, no judge/provider call exists,
and mutations prove scope/purge closure.

**Mutations**

Drop account/source predicates; reuse alias after re-resolution; update beyond
nextAt; retry dead letter; drop without clear; let MCP decide hold; call judge
while disabled; omit removal cancellation. Each fails a named real-operation
test.

**Commit:** feat(events-daemon): add B3 operator control services

**P1-only review:** SQL predicates, exact-version selection, retained-work
preservation, unavailable boundary, and every cancellation transaction.


## Batch 3 — public surface

### Task 5 — paired CLI/MCP controls and strict parity

**Files**

- Modify packages/events-daemon/src/cli/program.ts, src/mcp/server.ts,
  src/runtime/owner.ts, src/control/protocol.ts, and operations modules only to
  wire Tasks 3/4.
- Modify root capabilities.json for all B3 both rows through held list, with
  concrete argv, args, and expect parity vectors.
- Add test/b3-cli-mcp-parity.test.ts; extend capability audit; regenerate
  docs/reference/events-daemon-cli.md and docs/reference/events-daemon-mcp-tools.md.

**Tests first, in order**

1. Snapshot every normal Commander/MCP registration and drive it through
   existing stand-ins: both sides reach exactly listed operation with same
   non-secret arguments.
2. Prove MCP budget/kind only prepares, target test is active/approved only,
   judge test remains unavailable, and openWorld annotation is exact.
3. Wire areas one at a time: rule/target; subscriber/delivery/held list;
   judge/budget/kind/model. Add each capability row in the same change as
   command/tool—never postponed to an audit task.

**Commands / passing**

Run pnpm sync:reference, focused surface tests, pnpm verify:reference,
pnpm verify:parity --strict, then pnpm verify. Passing means no unmapped
Commander leaf/tool; shared operations have distinct argument vectors; generated
references show no secret action.

**Mutations**

Delete command/tool/row/export; swap tools; make one side reach another
operation; loosen Zod schema; allow MCP claim; mark target test local. Each
fails its particular parity/semantic test.

**Commit:** feat(events-daemon): expose B3 paired control operations

**P1-only review:** CLI/MCP-to-operation identity, schemas, annotations, and
generated references only.

### Task 6 — terminal/app exceptions and complete secret surface (high risk)

**Files**

- Modify packages/events-daemon/src/cli/program.ts, runtime/owner.ts,
  control/protocol.ts, and Task 2/3 operations.
- Modify root capabilities.json for rule test-retained, target resume, held
  decide, all eight secret rows, and dryrun exception operation/reason rows.
- Add test/b3-human-only-surface.test.ts, test/b3-secret-cli.test.ts,
  test/b3-mcp-absence.test.ts, and generated reference updates.

**Tests first, in order**

1. Compare capability matrix, Commander leaves, MCP tools/list, schemas,
   descriptions, structured/text output, and source exports. Any omitted row or
   secret leakage fails.
2. Fake-TTY tests cover agent marker/non-TTY/redirected stdin/json, no-echo
   prompt, one-time controlling-TTY reveal, app-origin request, receipt-only
   audit/result/log, and secret-URL scans.
3. Retained/resume/held tests prove allowed CLI reaches named operation and
   prohibited MCP registration is absent.
4. Register only allowed CLI leaves/owner requests; add exception rows/reasons/
   operation fields; regenerate references; drive parity with synthetic prompt.

**Commands / passing**

Run focused tests, pnpm sync:reference, pnpm verify:skills,
pnpm verify:reference, pnpm verify:parity --strict, then pnpm verify. Passing
means no secret command/tool/reference/schema/output escapes, terminal checks
precede prompt/IPC, app reuses owner operation, and loopback seal sees no
external connection.

**Mutations**

Expose a secret tool/schema; change reason; accept secret argv/redirected input;
emit JSON/reveal twice; log URL/reference; omit TTY/agent check; direct-store
instead of owner path; expose resume over MCP. Each fails named test.

**Commit:** feat(events-daemon): add B3 human-only control surface

**P1-only review:** complete named exception set, all content sinks, prompt/
origin gates, and synthetic-secret parity driver.

### Task 7 — lineage and pending-completion doctor

**Files**

- Modify packages/events-daemon/src/operations/doctor.ts, runtime/owner.ts,
  runtime/activations.ts, runtime/recovery.ts, runtime/dispatcher.ts, and
  source status helpers only to read content-free state.
- Modify CLI/MCP doctor description/render and capability vectors if needed.
- Add test/b3-doctor.test.ts, test/b3-doctor-content-scan.test.ts, and
  generated reference output.

**Tests first, in order**

1. Build active, superseded-retained, pending, claimed, draining, failed,
   missing-secret, reset-degraded, source-retry, WhatsApp-list,
   lease/dead-letter/deadline, and unavailable-kind fixtures. Assert every D10
   field with stable id/count/time.
2. Scan CLI, MCP structured/text, audit, logs for encrypted/plain sender data,
   secret/ref/fingerprint, URL component, raw tuple, alias, provider response,
   or stack.
3. Implement schema/owner query; add result version to C/E contract test;
   regenerate references.

**Commands / passing**

Run focused doctor tests, pnpm sync:reference, pnpm verify:parity --strict, then
pnpm verify. Passing means one owner operation on both surfaces reports pending
completion/lineage without content.

**Mutations**

Omit cutover point; report active pointer instead of lineage; hide claimed
drain; omit missing-secret kind; stale WhatsApp state; serialize secret/encrypted
field. Each fails named test.

**Commit:** feat(events-daemon): report B3 lineage and recovery health

**P1-only review:** joins, data minimisation, schema completeness, content scan.

## Batch 4 — consumer contracts

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
   missing contract, and service accidentally treated as channel.
2. Add skill fixtures for missing safe workflow, secret request/invocation,
   human-only instruction, stale tool, missing plain/enveloped wording, and
   missing judge-off/approval handoff.
3. Implement strict declaration support; author compact skill/contract; sync.

**Commands / passing**

Run pnpm sync:skills, pnpm verify:skills, focused registry/skill tests, then
pnpm verify. Passing means generated copies/README current, skill request-only,
no non-channel manifest, and static safety scan blocks unsafe instruction.

**Mutations**

Hard-code prefix; remove declaration validation; make service channel; add
secret instruction; omit handoff; name absent tool. Each fails named test.

**Commit:** feat(skills): add safe local event-emission guidance

**P1-only review:** registry derivation, generated files, every imperative
skill sentence.

### Task 9 — C/E compatibility contract and phase-E absence gate

**Files**

- Modify packages/events-daemon/src/operations/b3-contract.ts and exports.
- Add test/b3-consumer-contract.test.ts and test/b3-phase-e-gate.test.ts.
- Update generated reference pages and a short B3 compatibility section in
  packages/events-daemon/README.md where generators permit.

**Tests first, in order**

1. C contract test imports data-only protocol/operation/result schema and proves
   secret operations only accept secrets-window origin; ordinary windows cannot
   name them.
2. E gate stubs/removes B3 contract in a temporary package build and expects
   B3_HUMAN_SECRET_COMPLETION_MISSING; it also compares IDs/reasons/operations
   with capabilities.json.
3. Export contract and docs without importing desktop or judge runtime.

**Commands / passing**

Run focused C/E tests, pnpm sync:reference, pnpm verify:reference,
pnpm verify:parity --strict, then pnpm verify. Passing means C/E compile against
content-free stable surface and E cannot build/ship if secret completion is
removed/stubbed.

**Mutations**

Remove secret capability/operation; change reason; export secret value/type;
allow ordinary origin; make E gate warning. Each fails named contract test.

**Commit:** test(events-daemon): lock B3 contracts for desktop and judges

**P1-only review:** export minimisation, E failure behavior, documentation drift.

## Batch 5 — release-quality integration

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
   must use production owner operation.
2. Run complete mutation ledger: quiesce, post-await, SQL scope, purge closure,
   secret exposure, parity swaps; structural scripts must fail for unpaired data.
3. Regenerate skills/references; verify packed tarballs and no browser node edge;
   make only integration repair required by a named failing test.

**Commands / passing**

Run, in order: pnpm sync:skills; pnpm sync:reference; focused B3 tests under
loopback preload; pnpm verify:skills; pnpm verify:reference; pnpm verify:parity
--strict; pnpm verify:browser; pnpm verify. Passing means complete root verifier,
including strict parity and packed consumers, is green. Browser verification
remains a B2 release requirement; B3 must not reintroduce a node edge.

**Mutations**

Run every Task 1 manifest mutation and remove one generated reference command,
capability row, operation export, exception reason, and consumer-contract entry.
The named check must fail for each.

**Commit:** test(events-daemon): verify Phase B3 control surface

**Task review:** narrow P1 integration review, then the parallel split below.
Each fix receives another narrow P1 review in its area before merge.

## End-of-phase parallel review split

Use separate review worktrees and read contributor code before execution. Each
reviewer reports P1 only; coordinator resolves overlaps then reruns full verify.

| Area | Covers |
|---|---|
| Secret boundary/rotation | Closed exceptions, TTY/app origin, all sinks, independent migration, cleanup, quiescer, retired-master refusal. |
| Stateful fences/purges | Every after-await recheck, resume, retained/WhatsApp visibility, retry/drop, identity scope, cancellation closure. |
| Surface/parity/tooling | Commander/MCP/capability identity, strict drivers, reference generation, mutation ledger. |
| Lineage/consumers | Doctor minimisation, pending completions/cutovers, C promise, E gate, no desktop/judge scope creep. |
| Skill/release/package | Service skill declaration, instruction safety, generated files, holds, dependency/consumer checks, PR evidence. |


## §5 coverage ownership

Every B3-owned §5 row has exactly one primary task. Other tasks may add a
regression fixture but do not own acceptance.

| §5 row / B3 clause | Primary task | Named proof |
|---|---:|---|
| Conditions/local tests: CLI/MCP catalogue-only rule test; retained test terminal/app; hostile renderer; unapproved judge/target zero network; fixed synthetic input/taint | 3 | b3-rule-test.test.ts; b3-retained-read.test.ts; b3-target-test.test.ts |
| Judges/budgets: surface preparation, disabled/no execution before E, no invented rule global fields | 4 | b3-operator-control.test.ts |
| Judge kinds: command/tool rows, MCP prepare-only, disabled refusal before E | 4 | b3-operator-control.test.ts |
| Tightening/account revocation: B3 secret/object purge closure and dark re-add | 4 | b3-purge-closure.test.ts |
| Delivery state/caps: retry/drop fence, superseded retention, target-test cap, degraded reset resume | 3 | b3-target-resume.test.ts; b3-target-test.test.ts |
| Delivery control surface and dual-surface drive | 5 | b3-cli-mcp-parity.test.ts |
| Encryption/reset: old-key re-encryption, late writer quiesce, referenced retired master, resume | 2 | b3-master-rotation.test.ts |
| Secrets: individual exceptions; no MCP/schema/output exposure; hidden/reveal; slots; migration/core isolation | 2 | b3-secrets.test.ts; b3-secret-migration.test.ts |
| WhatsApp list-change: dry-run read remains behind real live-list gate | 3 | b3-retained-read.test.ts |
| Control/storage/app: independent event selector/lock/store and content-free app contract | 2 | b3-secret-migration.test.ts |
| Parity/phases/packaging: every row/reason driven; resume/dryrun/secrets absent MCP; E gate | 10 | b3-e2e-surface.test.ts; b3-phase-e-gate.test.ts |
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
| D2 480–86 | TTY/agent gate, no non-TTY argv/stdin, no JSON, privileged reveal, MCP proposals incomplete | 6 | b3-human-only-surface.test.ts |
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
| D9 1839–50 | Daemon-owned event state/refs; stable account id/fresh core config | 2 | b3-secret-migration.test.ts |
| D9 1883–92 | Startup/control/read live-list application; unreadable hides reads | 3 | b3-retained-read.test.ts |
| D9 1901–11 | WhatsApp dryrun read has raw tuple/live-list gate | 3 | b3-retained-read.test.ts |
| D9 1913–20 | Independent selector/namespace/owner-only file/no fallback/core config | 2 | b3-secret-migration.test.ts |
| D9 1922–30 | Lock/SQLite-derived refs; verify-before-commit/removal order/reconcile | 2 | b3-secrets.test.ts |
| D9 1932–41 | Terminal/app migration lock/snapshot/copy/selector/rollback/leftover/core compatibility | 2 | b3-secret-migration.test.ts |
| D9 1943–52 | Account removal purge and late writer recheck | 4 | b3-purge-closure.test.ts |
| D10 2002–04 | Every operation/capability; both unless explicit exception | 5 | b3-cli-mcp-parity.test.ts |
| D10 2006–17 | Complete operation table | 10 | b3-e2e-surface.test.ts |
| D10 2019–23 | Rule test catalogue/local/deterministic/sanitised/enveloped | 3 | b3-rule-test.test.ts |
| D10 2025–27 | Provider source types only; reject every agentcomms type | 3 | b3-rule-test.test.ts |
| D10 2029–33 | Retained test exception/no account arg/network/live account/safe renderer | 6 | b3-human-only-surface.test.ts |
| D10 2035–47 | Judge/target test approval/synthetic/taint/cap/transport constraints | 3 | b3-target-test.test.ts; b3-operator-control.test.ts |
| D10 2049–60 | MCP limits; individual exceptions; same daemon op; run exception | 6 | b3-mcp-absence.test.ts |
| D10 2062–64 | Immutable pending budget; terminal/app activation; reject global/provider fields in rule | 4 | b3-operator-control.test.ts |
| D10 2066–69 | First activation response/repeated MCP cannot claim/terminal replan drift | 5 | b3-cli-mcp-parity.test.ts |
| D10 2071–75 | Kind prepare/terminal activate/disable/model surface | 4 | b3-operator-control.test.ts |
| D10 2076–86 | Complete content-free doctor | 7 | b3-doctor.test.ts |
| D10 2088–90 | Safe event skill | 8 | events-skill-safety.test.mjs |
| D11 2100–12, 2121–27 | Kinds off/no judge call until enabled; disable purge hook | 4 | b3-operator-control.test.ts |
| §5 2856–65 | Local/retained/judge/target test matrix | 3 | b3-rule-test.test.ts |
| §5 3045–71 | Retry/drop/dryrun/target-test/reset-resume matrix | 3 | b3-target-resume.test.ts |
| §5 3113–35 | Rotation/reset/resume proof | 2 | b3-master-rotation.test.ts |
| §5 3136–50 | Secret exception/exposure/slot/migration/core isolation | 2 | b3-secret-migration.test.ts |
| §5 3284–97 | WhatsApp hidden-row dryrun gate/restart | 3 | b3-retained-read.test.ts |
| §5 3326–36 | Strict parity/exceptions/service packaging/E gate | 9 | b3-phase-e-gate.test.ts |

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

docs(plan): local event emission — phase B3
