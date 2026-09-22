# Organisation/platform names

**Status:** revised after design review · **Date:** 2026-09-22 · **Touches:** `@agentcomms/core`,
`@agentcomms/gmail`, `@agentcomms/gmail-mcp`, `@agentcomms/slack`, skills and docs

Every connected account gets a name of the form **`<organisation>/<platform>[-<qualifier>]`**, and the config
schema requires it. `cue/gmail` is the CUE++ mailbox, `cue/slack` the CUE++ workspace, `wf/gmail-tech` the second
Wherefrom mailbox. A name says which organisation an account belongs to and what it is, and the schema makes sure
the second half is true.

> **Revised twice on 2026-09-22 after design reviews.** The first found nine P1s and three P2s; the second, five
> P1s and four P2s. The shape of the design is unchanged; what changed is everything that has to be true for it to
> be safe: separate schemas per config version, a whole-config check between preview and apply, per-kind permanent
> tombstones, credential writes that survive a write committing and then reporting failure, every creation and
> lookup path by name, and **two releases** — readers first, the writer only once every reader is installed.

## Why

Today a name is one word, and mailboxes and Slack workspaces share one namespace. Connecting the CUE++ Slack
workspace as `cue` was refused, because `cue` is already the CUE++ *mailbox*. With more platforms and more
organisations coming, one flat word per account either collides or stops saying anything — this machine already
has Slack workspaces called `live` and `slack-2`. Two halves — who it belongs to, and what it is — fix both.

## Decisions taken by the owner

- **D1 — Shape, required.** `org/platform[-qualifier]`. A qualifier distinguishes two accounts of one
  organisation on one platform: `wf/gmail`, `wf/gmail-tech`.
- **D2 — The personal mailbox** is `personal/gmail`.
- **D3 — Migrate once, then refuse.** One command renames everything, with a preview. Afterwards an old name is
  refused with an error naming its replacement.

## The grammar

```
name       = org "/" platform [ "-" qualifier ]
org        = alnum [ [a-z0-9-]{0,30} alnum ]          ; 1–32, no leading or trailing hyphen
platform   = [a-z] [a-z0-9]{0,15}
qualifier  = alnum [ [a-z0-9-]{0,14} alnum ]          ; 1–16, no leading or trailing hyphen
alnum      = [a-z0-9]
```

- **The platform segment must match what the account is.** An inbox's name ends `/gmail` (its `provider`); a
  Slack account's ends `/slack` (its `platform`). Enforced by the schema, so `cue/slack` cannot name a mailbox.
- **Windows-reserved organisation names are refused** — `con`, `prn`, `aux`, `nul`, `com1`–`com9`,
  `lpt1`–`lpt9` — because the organisation becomes a directory (see downloads) and those cannot be one on
  Windows. `personal` and every real organisation here are unaffected.
- Lower case only; exactly one `/`; no `.`, so no `..`; no whitespace, controls or confusables — the character set
  is `[a-z0-9-/]` and nothing else.
- **Names are unique across `inboxes` and `accounts`** in version 2 (see below). `all` stays reserved; it cannot
  match the grammar anyway.

**Not renamed: OAuth client names** (`clients`, e.g. `desktop`). One client is shared by mailboxes across
organisations — all six here sign in through one — so an organisation prefix would be wrong. They keep the existing
plain-name rule in both versions.

## Config versions

The file carries `version`. The codebase keeps version 1 strictly additive, because a CLI installed today and an MCP
server started last week share the file.

- **Two schemas, one union.** `ConfigV1` is today's schema, preserved *exactly* — including its tolerance of the
  same alias in both `inboxes` and `accounts`, which older writers can produce. `ConfigV2` enforces the grammar,
  the platform match and cross-map uniqueness, and adds `formerNames`. `Config = ConfigV1 | ConfigV2`, and
  `parseConfig` switches explicitly on `version`.
- **A brand-new config is version 2.** A missing file becomes a v2 config, so a fresh install never accepts plain
  names. (Before N4 ships, new configs stay v1 — see **Phases**.)
- **An existing version-1 file stays version 1** until the migration. Every ordinary command reads and writes it
  under the v1 rules, unchanged. `doctor` says once that names can be migrated.
- **`ConfigStore.update` refuses a change of version.** Only `ConfigStore.migrateNames` — a dedicated transition,
  used by the migration and nothing else — may turn v1 into v2.
- **Older releases refuse version 2** with the message they already print. A pinned MCP server fails at startup.
  An *unpinned* 0.1.4 server does not: it catches the config error, starts with instructions saying no mailbox is
  connected, and refuses only when a data tool is called. That old behaviour cannot be changed now; the rollout
  accounts for it.

## Former names

Version 2 carries **per-kind tombstones**:

```ts
formerNames: {
  inboxes:  Record<string, { name: string; id: string }>;
  accounts: Record<string, { name: string; id: string }>;
}
```

- **Per kind,** because version 1 permits the same alias in both maps: `work` the mailbox and `work` the workspace
  become `work/gmail` and `work/slack`, and one flat record could not say which is which.
- **With the immutable id,** so a hint can never point at a different account than the one that was renamed. If
  the id no longer exists — the account was removed after its rename — the hint says so rather than naming
  something unrelated.
- **Permanent, and never reusable.** No add, rename, import or migration may take a tombstoned name as its target.
  Checked when the name is proposed and again inside the config lock. Without this, renaming `cue/gmail` would free
  a grammar-valid name for a later account, and a lookup of it would silently act on the wrong mailbox.
- **Chains collapse.** `cue` → `cue/gmail` → `cue/gmail-main` leaves `cue` pointing at `cue/gmail-main`, never at
  another tombstone.

### Refusing a former name

Every lookup by name goes through two core helpers, **`resolveName(config, kind, name)`** and
**`nameAvailable(config, kind, name)`**, and nothing else looks names up directly. `kind` is `inbox` or
`account`. `resolveName` returns the account, or refuses:

> error: `cue` was renamed to `cue/gmail`
> hint: Use `cue/gmail`.

`NOT_FOUND`, with the replacement in `details`. It is not an alias: nothing runs under the old name.

The callers, all of which must be moved onto the helpers:

- core CLI: `audit tail --inbox`, `approvals list --inbox`
- Gmail: `requireInbox` and `GmailContext.inbox`; `resolveInboxes` (multi-inbox search, contacts, follow-ups,
  attachment finding); `doctor --inbox`; approval filtering in `send`; the CLI policy preflight; the MCP
  send-confirmation preflight; every MCP tool's `inbox` parameter; `mcp --inbox` at server start; `mcp install
  --inbox`, including `--no-verify`
- Slack: `requireWorkspace`, and through it `workspace show`, `reauth`, `remove`, and `--finish`'s alias binding

Tested table-driven, one row per path. A table only covers the paths somebody listed, so it is backed by an
**architecture test**: it scans every package's `src/` and fails on an indexed read of `.inboxes[` or `.accounts[`
outside a short allowlist in core. That catches the common shape of a new direct lookup, not every shape — a
`find` over `Object.entries` still gets through, and review has to catch that.

`nameAvailable` keeps each version's existing rule, because version 1's rules differ by kind today:

| | inbox | account |
|---|---|---|
| **v1** | valid v1 alias; free in `inboxes` (what Gmail checks now) | valid v1 alias; free in both maps (what Slack checks now) |
| **v2** | the grammar; ends `/gmail`; free in both maps; not a former name of either kind | the grammar; ends `/slack`; free in both maps; not a former name of either kind |

## The migration

`agentcomms names migrate [--rename <source>=<name> ...] [--dry-run] [--yes]`, in the core CLI, because core owns
the config and both maps live in it.

1. **Proposal.** Each plain name gets a default, `<old>/<platform>`: `cue` → `cue/gmail`, `live` → `live/slack`.
   `--rename` overrides one. A source may be qualified — `inbox:work=…`, `account:work=…` — and an unqualified
   source that is ambiguous (the same name in both maps) is refused with both qualified forms in the hint. Every
   target is checked against the grammar, the platform match, every other target, and the tombstones. The command
   refuses and lists *every* problem at once; it never applies part of a rename.
2. **Preview.** The full mapping is printed, with a **fingerprint** of what it was computed from: a hash of the
   whole configuration in canonical form — every key, including ones this version does not know, since the schema
   keeps them. A narrower fingerprint would let a change to a policy, a domain list or a client pass unnoticed
   between preview and apply. Without `--yes`, a person at a terminal confirms; an agent
   or a non-TTY run needs `--yes`. A rename changes no access, so there is no typed challenge — and the classifier
   agrees: it matches rows by immutable id, so a pure key rename is not a loosening.
3. **Apply,** under the credentials lock and then the config lock. The configuration is **re-read and
   fingerprinted inside the locks**, and version 2 is built from that locked snapshot and nothing else. If anything
   changed since the preview — a sign-in, a removal, a rename, an old writer — it refuses with `TRANSIENT` and asks for a fresh preview. The lock is never held while waiting for
   confirmation. Then one write: every key renamed, `version` set to 2, tombstones filled. Secrets are untouched;
   they are stored under immutable ids.
4. **Idempotent,** and safe to retry after a lock-release failure. On version 2 it reports "already migrated". If
   the write committed but releasing the lock failed — the rejection that can follow a committed write — a retry
   finds version 2 and says so; a test covers that outcome.

For this machine:

```
agentcomms names migrate \
  --rename gmail=personal/gmail \
  --rename wf-tech=wf/gmail-tech \
  --rename live=cue/slack \
  --rename slack-2=rgc/slack
```

| Now | Becomes |
|---|---|
| `gmail` | `personal/gmail` |
| `cue` | `cue/gmail` |
| `rgc` | `rgc/gmail` |
| `wf` | `wf/gmail` |
| `wf-tech` | `wf/gmail-tech` |
| `beamtech` | `beamtech/gmail` |
| `live` (Slack, CUE++) | `cue/slack` |
| `slack-2` (Slack, RGC) | `rgc/slack` |

## Locks, and what races with what

**Lock order, everywhere: the credentials lock, then the config lock.** Nothing takes them in the other order.

- **The migration** takes both, so it serialises with every removal and with `secrets migrate`.
- **Gmail removal takes the credentials lock** — new. Today it resolves a name, deletes `inboxes[name]` by key and
  then deletes the secret, outside any credentials lock. A migration landing in between renames the row, the
  deletion by key removes nothing, and the secret is deleted from under a renamed account that stays configured.
  The same race exists today against `secrets migrate`. So: credentials lock from the fresh config read through the
  config mutation and the secret deletion, and the mutation **matches the row by immutable id**, not by the name
  it started with.

  The row still goes first and the secret second — the other order leaves a configured account with no credential.
  But `ConfigStore.update` can reject *after* its write committed, when releasing the lock fails, and today that
  skips the secret deletion and strands a live token that nothing records. So on an update error, removal re-reads
  the config, still under the credentials lock, and looks for the row by id: **gone** — the write committed, carry
  on and delete the secret; **present** — nothing was written, rethrow; **unreadable** — record the reference in the
  orphaned-secrets file `doctor` already reads, and say so.
- **Slack removal** already takes the credentials lock and reads the config inside it, so it serialises with the
  migration. Its mutation looks the row up *by name* and then checks the id — correct only because nothing else
  renames an account while that lock is held. Both removals find the row **by immutable id**, through one shared
  core helper, so neither depends on that staying true.
- **Sign-ins do not take the credentials lock**, deliberately — waiting on it would spend a one-shot authorisation
  code on a timeout. Instead, both packages re-check the name **inside the final config mutation**, under whichever
  version the file is then: a flow started against v1 with a plain name, finishing after the migration, is refused
  there, and its staged credential withdrawn.
- **Gmail add reconciles before it withdraws.** Today any config error deletes the new secret — including an error
  that followed a committed write, which leaves a connected mailbox with no credential — and a failed deletion is
  swallowed. Under this change it does what Slack's sign-in does: on an update error it re-reads the config and
  looks for the new inbox id. **Committed** — keep the secret, report the lock problem; **absent** — withdraw the
  secret, and **report** it if that fails; **unknown** — keep the secret and say which reference may be stranded.
- **Gmail reauth writes the row it found, by id.** It currently writes back `inboxes[<name it started with>]`, so a
  rename between starting and finishing a reauth would put the old name back beside the new one. It finds the row
  by the flow's inbox id inside the mutation and writes it under whatever key it holds then.

  It still overwrites the live refresh token *before* the config write, under the same reference. That is the
  existing reauth race, and it is **not** fixed here: staging under a fresh reference means changing how the token
  session finds its secret (`session.ts` derives the reference from the inbox id and re-reads it to pick up a
  concurrent reauth), which is a token-refresh change, not a naming one. It is also not unsafe: identity is checked
  before the write, so the overwritten token is a valid one for the same account, and a config write that then
  fails leaves the row describing a grant no wider than the token.

## Every path that creates or renames an account

Under version 2 each of these proposes, validates and re-checks a v2 name; under version 1 each keeps today's rules:

- `agent-gmail inbox add` and `inbox reauth`; the MCP `gmail_inbox_add` / `gmail_inbox_finish` tools, whose
  descriptions stop suggesting `work`
- `agent-gmail setup` and its MCP twin, which today propose `work` — before the address is known, so no name can
  be derived from it. Under v2 there is **no default**: the prompt shows `acme/gmail` as a placeholder and the name
  is required
- `agent-gmail inbox rename` — records a tombstone
- **`agent-gmail inbox import`** (legacy import): today it derives plain names, and writes both the OAuth client
  secret and each mailbox's token before the config row that names them, with no rollback. Under v2 it proposes
  `<legacy-name>/gmail` for each file, takes `--rename <legacy-name>=<name>` (repeatable) to override one, and
  `--dry-run` prints the mapping. Every target is checked against live names and tombstones before anything is
  written. Each secret write — the client's and each mailbox's — is followed by the same committed / absent /
  unknown reconciliation as Gmail add
- `agent-slack workspace add` and `reauth`

The error for an invalid name explains the shape — organisation, `/`, platform, optional qualifier — and gives an
example ending in the right platform.

## Where a name reaches something other than a lookup

- **Secrets and state** are keyed by immutable ids. A rename cannot orphan a credential.
- **Downloads and exports** use the name as a directory, `join(name, …)`. A new-shape name becomes two
  directories, `downloads/cue/gmail/…` — one folder per organisation. The jail (`resolveInsideRoot`) already does
  lexical containment and an existing-ancestor realpath check, and `relativeSubpath` refuses absolute paths and
  `..`. Windows device names are excluded by the grammar. **Existing files are not moved**; `doctor` mentions an
  old folder once.
- **Audit records** keep the name they were written with. That is history.
- **Search cursors** compare a comma-joined list of names; names contain no commas.
- **OAuth completion pages** render names as escaped HTML. Names never reach a URL.
- **`/` is ordinary** in JSON, MCP string parameters and shell arguments.

## The classifier

`classifyChange` matches rows by immutable id first, so a key rename is not a loosening, and a policy change made
in the same write is still caught, under the new key. Slack's alias fallback — which exists because reauth rotates
the account id — must also find the previous row when the key changes in the same write: it looks for the same
platform, workspace and user **across every previous key**, not only under the same name.

Regression cases: Gmail rename alone (no loosening); Gmail rename plus a policy or internal-domain widening
(reported under the new key); Slack rename alone (no loosening); Slack rename plus a mode or policy widening
(reported); Slack rename plus an id rotation (classified correctly).

## Phases

Each phase is safe to release on its own, and **there are two releases, not one**: a reader release, installed
everywhere, and only then a writer release. One release carrying both would not be safe even if every phase were:
`scripts/release.mjs` publishes core first and can stop part-way — deliberately, since a published version cannot
be taken back — so a failed Gmail publish would leave a public core that creates and migrates version 2 while the
only Gmail on npm is 0.1.4, which cannot read it.

| Phase | Branch | What |
|---|---|---|
| N1 | `feat/names-core` | `ConfigV1`/`ConfigV2`, the union, `parseConfig` by version, the grammar, `resolveName`/`nameAvailable`, tombstones, `ConfigStore.migrateNames`, the classifier fallback, the shared by-id helper, the architecture test. **Still creates v1 configs; no command writes v2.** |
| N2 | `feat/names-gmail` | Every Gmail lookup and creation path on the helpers; removal under the credentials lock with reconciliation; add reconciliation; reauth by id; import; nested downloads — all v2-ready. **No public v2 writer.** |
| N3 | `feat/names-slack` | Every Slack path on the helpers; removal by id; v2-ready. **No public v2 writer.** |
| R1 | — | **Reader release, 0.2.0:** core, gmail and gmail-mcp through `scripts/release.mjs`, the owner confirming the publish. Reads v1 and v2, writes v1, has no migrate command. A partial publish is harmless: nothing in it writes v2. |
| N4 | `feat/names-flip` | New configs start at v2; `agentcomms names migrate` is exposed; skills, docs and the generated reference use the new names; the setup prompt for a second computer is updated. |
| R2 | — | **Writer release, 0.3.0,** once every reader on every machine is at 0.2.0 or later. A partial publish is harmless here too: every reader it could reach already reads v2. Then the rollout. |

## Rollout

Slack is a private package run from this checkout; it is updated by pulling `main`, not by the release script.
Each machine has its own config and migrates on its own: the second computer stays on version 1 until it
installs 0.3.0 and runs the migration there.

After **R1**:

1. **Install the reader everywhere:** update the Gmail managed runtime and every MCP registration to 0.2.0 on each
   machine, pull and build Slack, and restart clients so no 0.1.x server is left running.

After **R2**, on each machine:

2. **Inventory** every MCP registration (all clients) and every pinned or exact-version fallback in installed
   skills.
3. **Stop** every MCP client and server process, then **wait ten minutes** — the lifetime of a sign-in flow in both
   packages (`FLOW_TTL_MS`). A flow that finishes after the migration is refused anyway, by the re-check inside the
   final config mutation, and its credential withdrawn; the wait only spares someone that confusing failure.
   Stopping clients does not stop a detached OAuth listener, but a listener only captures a code — the exchange and
   the config write happen in `--finish`, which meets the re-check.
4. **Migrate:** `--dry-run`, then for real.
5. **Rewrite** any registration pinned to an old name, using the migration's map.
6. **Reinstall** skills and registrations at 0.3.0.
7. **Restart clients after migrating**, so their instructions list the new names. A 0.2.0 server started before the
   migration caches the old names in its instructions; one pinned to an old name stops working once it is renamed.
8. **Smoke-test a real data tool,** `doctor`, and Slack — not only MCP `initialize` and `tools/list`, which an
   unpinned old server passes while being unable to read anything.

## Tests that must exist

- **Grammar:** accepted and refused examples — `cue`, `cue/`, `/gmail`, `cue//gmail`, `cue/gmail/`, `Cue/gmail`,
  `cue/gm ail`, `../gmail`, `cue./gmail`, `cue-/gmail`, `cue/gmail-`, `con/gmail`, `lpt1/gmail`, and each length
  limit on each side.
- **Platform match** both ways.
- **Versions:** missing file → v2 (after N4; v1 before); v1 → ordinary update → still v1, byte-for-byte on
  unrelated keys; `update` refusing a version change; v2 → a 0.1.4 reader refusing it with its message.
- **Migration:** default proposal; overrides; qualified sources; an ambiguous unqualified source refused; every
  failure listed with nothing applied; agent without `--yes` refused; a config changed between preview and apply
  refused with nothing applied — a renamed row, and separately a change to nothing but a policy or a domain list; idempotent on v2; retry after a committed write whose lock release failed; secrets
  untouched.
- **Tombstones:** a former name refused with its replacement on every lookup path, table-driven; reuse refused on
  add, rename, import and migration; chains collapsed; a removed account's tombstone not pointing elsewhere.
- **Concurrency:** migration against Gmail removal, Slack removal, Gmail add and reauth, Slack add and reauth,
  `secrets migrate`, and an old v1 writer.
- **Committed-then-rejected writes:** for Gmail removal, Gmail add and each import write — a rejection before the
  write, a rejection after it committed (lock release failing), and a failed secret cleanup, each reported rather
  than swallowed.
- **`nameAvailable`** across the v1/v2 × inbox/account matrix.
- **Architecture:** the scan finds a planted `.inboxes[name]` read outside the allowlist.
- **Downloads and exports** under nested names, through a symlinked ancestor, and beside an old folder.
- **Classifier** regression cases above.

## Out of scope

- Renaming OAuth clients.
- Moving previously downloaded files.
- Aliases that keep working after the migration (D3 chose refusal).
- Any change to what an account can do. This is names only.
- Staging Gmail reauth under a fresh secret reference (see **Locks**): a token-refresh change, tracked separately.
- List or cancel commands for pending sign-in flows: the in-mutation re-check makes a late flow safe, and the
  rollout waits out their lifetime.
