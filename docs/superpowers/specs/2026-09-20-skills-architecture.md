# The skills architecture across platforms

*Status: decided. This supersedes the single `S6` row in `docs/superpowers/specs/2026-09-19-slack-design.md` ("The skills, sharing the contract; the drift test extended"), which named the work without designing it. Suggested home: `docs/skills-architecture.md`, linked from `docs/architecture.md` and `docs/skills.md`.*

---

## 1. The decision

**Each platform ships a complete, independently installable skill pack under its own name prefix — `gmail-*` (twelve, keeping their names), `slack-*` (ten, new), `imap-*` (only if that package is ever built) — and no SKILL.md is ever shared between two platforms.** What is shared is generated into each pack by the copier that already exists: a neutral contract core plus a per-platform annex composed into every skill's `references/contract.md`, and a small `skills/_shared/carried/` library of genuinely platform-free reference files, all string-checked by `scripts/sync-skills.mjs --check` exactly as the contract is today. The three literal `startsWith('gmail-')` filters (`scripts/sync-versions.mjs:58`, `scripts/sync-skills.mjs:60`, `test/manifests.test.mjs:29`) — plus `test/tool-drift.test.mjs:21`, which hardcodes Gmail differently, by matching `gmail_*` tool names with a regex — collapse into one `skills/_shared/platforms.json` registry that every generator and both tests read. The reason for choosing this over one merged set of job-shaped skills is not file count: it is that the guarantees genuinely differ between platforms, and a document that has to write "depending on the platform, the approval is bound to either a draft id or a content digest, and there may or may not be somewhere for the user to go" is the document an agent under pressure resolves in the reassuring direction. A per-platform skill states one truth and has no other branch to fall into.

**For someone installing today, nothing changes and nothing breaks.** The twelve Gmail skills keep their directory names, their frontmatter `name`, their sibling cross-references and their `compatibility: "@agentcomms/gmail@<version>"` pins. Re-running `npx skills add crissmoldovan/agent-communications --skill '*'` overwrites the same twelve directories in place. What a user sees change: `references/contract.md` becomes a neutral core plus a Gmail annex rather than one Gmail-worded file; four skills' reference files become generated copies of shared sources; every Contract block gains about three lines of clause slugs; and **one** description changes — `gmail-attachments` gains a platform noun, which also regenerates that one skill's `references/fit.json`. The other eleven descriptions and fit files are untouched. §7 is the exact list. There are no orphaned skill directories, because nothing is renamed — which is the single largest practical difference between this design and the two that proposed neutral `comms-*` names. The skills CLI installs flat by name, overwrites only on an exact name match, and has no prune-on-add; a rename would leave every existing user holding twelve stale `gmail-*` directories whose `gmail-send` still names `gmail_draft_send`, a still-registered tool, and therefore still works — a live send path frozen at 0.1.2, bypassing every guarantee the new skills add.

---

## 2. Skill layout

**Only the twelve `gmail-*` directories and `_shared/contract.md` exist today.** Everything else below —
`_shared/platforms.json`, `_shared/contract/`, `_shared/carried/`, and every `slack-*` directory and its
reference files — is what this design proposes, not what is on disk. The Slack pack in particular is drawn
from `docs/superpowers/specs/2026-09-19-slack-design.md`; no Slack skill, manifest, scope set or description
exists to check it against, so its ten names, its reference filenames and its ~3,500-character description
budget are all estimates that the S6 phase will settle.

```
skills/
  _shared/
    platforms.json               # the registry: one row per platform
    contract/
      core.md                    # ~85 lines, neutral, nine clauses
      gmail.md                   # ~35 lines
      slack.md                   # ~45 lines
      imap.md                    # only if @agentcomms/imap is built
    carried/                     # platform-free reference files with more than one consumer
      jail.md                    # from gmail-attachments (201 lines)
      risk-flags.md              # from gmail-attachments (130)
      downloads-root.md          # from gmail-export (144)
      disambiguation.md          # from gmail-contacts (112)
      injection.md               # from gmail-security, doctrine half (~200 of 309)
    carried.json                 # { "jail.md": ["gmail-attachments", "slack-files"], … }

  gmail-setup/  gmail-search/  gmail-thread-analysis/  gmail-attachments/
  gmail-compose/  gmail-send/  gmail-contacts/  gmail-organize/
  gmail-triage/  gmail-follow-ups/  gmail-export/  gmail-security/

  slack-setup/           references: app-manifest.md, oauth-scopes.md, troubleshooting.md
  slack-search/          references: query-syntax.md, body-pipeline.md
  slack-thread-analysis/ references: timeline.md, reading-messages.md
  slack-triage/          references: buckets.md, windows.md
  slack-people/          references: sources.md, disambiguation.md (carried)
  slack-files/           references: jail.md (carried), risk-flags.md (carried)
  slack-security/        references: injection.md (carried), concealment.md, identity.md
  slack-export/          references: export-formats.md, downloads-root.md (carried)
  slack-compose/         references: profile.md, reach.md
  slack-send/            references: policies.md, bindings.md, troubleshooting.md
```

Every skill also carries the generated `references/contract.md` and `references/fit.json`, as now.

**Names are parallel where the job is parallel, and absent where the job is not.** `slack-triage` rather than `slack-catch-up`, because the four buckets and the FYI-vs-Noise asymmetry are the shared asset and a different name for the same job makes the estate harder to reason about; the descriptions disambiguate by platform, not the names. Three deliberate absences, argued rather than mirrored:

- **No `slack-follow-ups`.** Slack has no per-channel `in:sent` equivalent, and "nobody answered" is a far weaker signal in a room than in a thread. The honest, weaker version lives inside `slack-triage` rather than as a skill whose name promises a row that means something.
- **No `slack-organize` in v1.** `conversations.mark` needs `im:write`, which the Slack design never requests. Pins and saved items alone do not make a job.
- **No `slack-authentication`.** `gmail-security/references/authentication.md` is 178 lines of SPF/DKIM/DMARC with no analogue, and it is not carried anywhere near the Slack pack.

`slack-triage` in v1 therefore produces a briefing and proposes nothing to apply. That is a capability the install lacks, and §4's three-state rule requires it to be reported as that rather than as a failure.

**`platforms.json` is the single registry.** One row per platform: `prefix`, `package`, `toolPrefix`, `cli`, `annex`, `server`, `program`, `launcher`, `noun`, `plugin`. Every site that hardcodes Gmail today reads it instead: `scripts/sync-skills.mjs` (the prefix filter and the contract composition), `scripts/sync-versions.mjs` (the `['core','gmail','gmail-mcp']` list at line 39, the prefix filter at line 58, and the `@agentcomms/gmail@` literal in the `compatibility:` rewriter), `scripts/sync-reference.mjs` (the CLI and MCP reference halves, and the hardcoded contract paragraph at ~328–330), `test/manifests.test.mjs:29`, `test/tool-drift.test.mjs`, `scripts/release.mjs`, `scripts/third-party-licenses.mjs`, and `package.json`'s `verify:packages`.

### The three-way split inside a pack

Each pack's reference files are named for how far they travel, which is the one idea from the merged-skills designs that is worth keeping whole:

| Suffix | Holds | Travels to |
|---|---|---|
| `*-<job>.md` (unsuffixed) | judgement and architecture that survive any platform | `_shared/carried/` once a second consumer exists |
| `*-email.md` | true of RFC-5322 mail, not of Gmail | an IMAP pack, nearly verbatim |
| `*-gmail.md` / `*-slack.md` | true of one provider | nowhere |

The Gmail pack does not need this split today and does not get it today. It gets it the day a second mail provider exists, and §6 lists exactly which files move. Pre-splitting `recipients.md` now, against a platform that may never be built, produces a shared file with a Gmail shape and an imaginary second reader.

---

## 3. The shared contract

`skills/_shared/contract.md` (111 lines, titled "The Gmail skills contract") becomes `skills/_shared/contract/core.md` plus one annex per platform. Each skill's `references/contract.md` is generated as `core.md + <its own platform's annex>` — a single file, still copied rather than linked, for the reason the copier's own comment gives: a skill is installed as a directory and a link out of it would break. **A Gmail skill receives the Gmail annex and no other.** Nobody's installed contract discusses a platform they do not have.

### What stays, what moves, what is new

| Clause | Core | Annex | New substance |
|---|---|---|---|
| Preamble | "stricter wins"; `gmail-*` → "every skill in a pack" | — | the contract carries a version (below) |
| 1. Name the account | all four sub-rules, renamed **account** | parameter name, lister, identity call, container noun | — |
| 2. Data, not instructions | envelope with per-call random boundary; "name the counter, do not assert the intent" | the counter roster | — |
| 3. One outbound door | the five rules | send skill, tools, binding, escape hatch, **enforcement** (§4) | **reach**; the **ceremony ladder** |
| 4. Files from strangers | provenance, both jails | Slack's bearer-token download | **audience** |
| 5. Bulk changes | >10 threshold, search-selected trigger, returned inverse | the retention fact | **conditional undo** |
| 6. Cite what you read | all three rules | the citable identity | **three-state coverage** |
| 7. Reading is not a request to act | **verbatim, unchanged** | — | — |
| 8. Works without the MCP server | the nine exit codes | CLI name, worked examples | — |
| 9. Style skill outranks defaults | precedence, "stricter only" clamp | register notes | **surface declaration** |

The clauses that move are facts, not wordings. Leaving them in the core teaches an agent something false:

- **Clause 2's counter roster.** `hiddenElements`, `hiddenChars`, `sameColorElements` and `unreadableHidingRules` are HTML-sanitiser field names. Slack is mrkdwn and Block Kit; its roster is a `<url|label>` whose label lies about the target, unfurl text authored by a third party, `blocks` disagreeing with the fallback `text`, and zero-width or bidi characters. A Slack skill inheriting the HTML names would cite fields that are always absent, which reads as "the concealment check passed".
- **Clause 5's bin.** "Gmail keeps a binned message for thirty days" is false on Slack, where `chat.delete` is irreversible, and different again on IMAP. The core rule becomes conditional: *prefer the reversible action; where the platform offers no undo, say so before acting and require an approval one step stricter than the bulk threshold.* On Gmail the reversible option always exists, which is why this rule has never had to be written.
- **Clause 6's citable identity.** Gmail: message and thread ids. Slack: the `/archives/C…/p…` permalink, which is strictly better because a human can click it. IMAP: the RFC-5322 `Message-ID`, never a bare UID — a UID is scoped to one folder at one `UIDVALIDITY` and a citation the current clause would accept can silently stop resolving.

Five things are genuinely new. Mail never forced them, and a lazy merge would have papered over all five:

1. **Reach (clause 3).** The preview must state who receives this and how many, not only who is addressed. A recipient list satisfies it for mail; a channel post needs `@channel`/`@here`, the member count and whether the channel is public. `renderChannelPreview`, `describeNotifies` and `PreviewNotifies` already exist in `packages/core/src/render.ts`, and `LABEL_WIDTH = 10` is already sized for `Notifies:` — the code is ahead of the contract here.
2. **The ceremony ladder (clause 3).** The contract is binary today. Core now defines exactly two rungs and the test for the lower one; an annex may name which of its writes it claims, and may never invent a third rung. A **named write** must satisfy all three: it carries no author-supplied text, it is attributed to the person, and this package can reverse it with one call. It is performed only when the user asks for it by name — clause 7 still holds — it is audited, and the annex must state how it can be misread. Slack's reactions pass, with the misreading stated out loud: a checkmark on a deploy request is routinely read as assent. Incoming webhooks and `chat:write.customize` fail the attribution test and are never requested at all. This construction is what keeps "an annex may only tighten" true: core owns the ladder and the test, the annex owns only the list.
3. **Audience (clause 4).** The clause governs where a file came from and never who sees it leave. A channel upload is permanently visible to everyone in the channel.
4. **Three-state coverage (clause 6).** Keep apart: a platform with no connected account (not in the coverage line, not an error), a connected account that failed (named in `errors`, the answer is partial), and a connected account that lacks the capability asked for (reported as a capability the install lacks, never as a failure). The Slack design's §10 verification table already demands the third state for a `read`-mode workspace asked to post; `gmail-triage` already prints `all mailboxes returned` and sets `complete: false` with the failing mailbox named, so this is one new axis on vocabulary that exists.
5. **Surface declaration (clause 9).** A personal writing-style skill may declare the surfaces it governs. One that declares none governs every surface — the behaviour users have today — and where two apply, the stricter wins. A user's email register and their Slack register are different, and the contract currently cannot express that; changing the default instead would silently alter behaviour for every existing user with a style skill, which is not a change to make inside a generated file.

### Versioning

`core.md` becomes a mutable shared dependency of twenty-two skills spanning two independently released packages, and today nothing in the frontmatter would move when it changed. It gets a version: a `contract: "<n>"` line at the top of `core.md`, written by `sync-skills.mjs` into every skill's `metadata` map as `contract: "<n>"`, and checked by `verify-skills.mjs`. `metadata` is a string-to-string map — Codex 0.145 refuses a skill whose `metadata` is a single string — so this fits without changing its shape. The `compatibility:` pin keeps naming the provider package, because the tool names and CLI commands a skill tells an agent to call are the drift that line exists to expose.

### What enforces it

**Fully mechanical, and on more files than today.** `pnpm verify:skills` → `sync-skills.mjs --check` already string-compares every generated `references/contract.md` against its source, on five CI legs. Under this design it covers twenty-two composed files derived from three sources, plus every file copied out of `_shared/carried/`.

**Three new checks in `verify-skills.mjs`**, each the same shape as a check that already exists:

1. **A provider-token scan over `_shared/carried/` and `_shared/contract/core.md`.** No `gmail_*`, no `slack_*`, no `agent-gmail`/`agent-slack`, no "Gmail"/"Slack", no "mailbox" — **and no lowercase hyphenated skill names either**, because `risk-flags.md:83` already says `gmail-security` and `disambiguation.md:112` already says `gmail-*`, so a deny-list written only against the forms above would pass both files while they still name a platform. Same mechanism as the existing secret and absolute-path scans. This makes neutralisation enforced rather than aspirational, which matters because it is not currently true of any candidate file: measured, `jail.md` has 8 provider-bound lines, `risk-flags.md` 5 (including a table of four `gmail_*` tool names), `downloads-root.md` 8, `disambiguation.md` 17 (including three `agent-gmail search` command lines), `injection.md` 14. Fifty-two lines across 896. Small, but not zero, and not optional.
2. **Clause slugs.** Every clause in `core.md` and each annex carries `<!-- clause: outbound-door binding: all -->`. Each SKILL.md's `## Contract` block declares the slugs it summarises. The check: declared slugs resolve, and every `binding: all` slug is declared by every skill in every pack. This closes a measured gap — today nothing enforces the Contract block at all, and `gmail-send` (15 lines), `gmail-follow-ups` (21) and `gmail-export` (23) are already under the spec's stated 25–40 floor with CI green, so a clause can reach all twelve copied files, appear in zero SKILL.md bodies, and pass. **It catches omission and nothing else.** A block that declares a slug and summarises it wrongly passes. No test will catch that.
3. **The platform noun.** A skill's description must contain its platform's `noun` from `platforms.json`. Eleven of the twelve Gmail descriptions already satisfy it; §7 names the one that does not.

**What rests on discipline, stated plainly:** whether `slack-send`'s Contract block *means* what `gmail-send`'s means. Three structural things carry it. The annex is small and adversarial by construction — every line in it exists because a core clause is false or incomplete on that platform, so writing one is a clause-by-clause checklist. The preamble's "stricter wins" means an annex can only tighten, and a platform that needs to loosen a core rule must express it through the branch core provides (clause 5's conditional undo) rather than as an exception. And the Slack design's §10 already requires an audit of every skill document against the code it describes before merge; per-platform packs make that audit tractable — ten Slack documents against the Slack package, read by someone holding the Slack code.

Two existing inconsistencies get fixed in the same change or they become lies about two platforms instead of one: the hardcoded literal at `scripts/sync-reference.mjs:328–330` ("All of them share one contract … never send outside `gmail-send`"), which `sync-reference.mjs` already applies to *every* non-underscore skill directory and which `verify:reference` only checks against itself; and the same sentence hand-copied at `README.md:175–179`.

---

## 4. The send guarantee, which is not one guarantee

This is the part that must not be flattened. There are **two independent axes**, and every existing document conflates them because Gmail above `read` only ever had one enforcer.

### Axis 1 — enforcement level: who is *able* to refuse

Two values, derived from the credential actually granted, never configured and never stored as an opinion:

| Account | Level | Established by | What a bug in our code can do |
|---|---|---|---|
| Gmail `read` tier | **`grant`** | `gmail.readonly` alone; `tierOf(grantedScopes) === 'read'` | nothing — the token has no write capability |
| Gmail `draft` tier | **`code`** | `gmail.compose` permits `drafts.send` | send |
| Gmail `organize` tier | **`code`** | `gmail.modify` permits `drafts.send` | send |
| Slack `read` mode | **`grant`** | no `chat:write`, no `files:write`, no `incoming-webhook`, no `im:write` | nothing — the token cannot post |
| Slack `send` mode | **`code`** | `chat:write` + `files:write` | post |
| IMAP/SMTP, any account | **`code`, always** | an app password grants IMAP *and* SMTP together and cannot be scoped | send |

The source of truth is `packages/gmail/src/auth/scopes.ts`, whose header states it outright: *"No scope separates drafting from sending: `gmail.compose` and `gmail.modify` both allow `drafts.send`. The send gate is therefore enforced in code, never by the grant."* `README.md:200–204` already ships this table for Gmail; the Slack design's D1 ships the equivalent for Slack and adds the sentence this design adopts: *"`send` mode is not a lesser product with a worse guarantee. It is the same guarantee Gmail gives, and the documentation must say which is which rather than implying one number covers both."*

Five rules follow, and they belong in core clause 3:

1. **Derived, per account, from the scopes actually granted** — not from the tier the user asked for. Users untick boxes on a consent screen; `capabilitiesOf()` and `tierOf()` exist precisely for that, and the account lister already returns `tier: tierOf(inbox.grantedScopes) ?? inbox.tier`. Nothing new is invented and no hand-maintained field can disagree with the grant.
2. **The lister reports it and the skill quotes it.** A skill never states a level stronger than the account it is acting on, and never describes another account's level while acting on this one.
3. **Two fixed sentences, and only these two.**
   - `grant`: "this package's credential for `<alias>` cannot send. Moving it to a sending tier is a re-authorisation you approve in the provider's own screen — a stronger gate than anything we could write."
   - `code`: "nothing leaves unless a prepare ran for exactly this content. What that does not guarantee is that anyone saw the preview. The server has no view of this conversation."
4. **Both are claims about this package's credential, not about the machine.** `grant` says *this package cannot send*, never *nothing can send*. The Gmail release found a rival MCP server with an ungated send path on the author's own machine; the Slack design records the identical shape for a second app holding `chat:write` in the same workspace. `doctor` reports a rival registered server as a failing check, not a warning, and with N platforms that becomes N checks — which is why each pack's `*-setup` skill owns its own and states the limit of its own `grant` claim.
5. **A policy never raises the level.** `chat`/`confirm`/`never` is axis 2.

### Axis 2 — approval policy: what this package *demands*

`chat` / `confirm` / `never`, per account, unchanged in meaning. On a `code` account, `never` is a code-enforced stop. On a `grant` account it is belt and braces. `confirm` adds a person on top of whatever the level is, and a person is the only thing that stops a `code` account when our code is wrong. The skill states both: *"`work` is `code`-enforced, policy `confirm`."* It never states one as though it were the other.

### The declaration each platform pack must make

Every annex opens with a fixed block, copied verbatim into that pack's `*-setup` SKILL.md by the same generator:

```
Guarantee declaration — <platform>
  levels offered:  grant (mode/tier <x>), code (mode/tier <y>)
  ceiling:         the strongest level any account on this platform can reach
  floor:           the weakest level any account on this platform can reach
  why:             one sentence of mechanism
```

Gmail: ceiling `grant` (the `read` tier), floor `code`, because `gmail.compose` and `gmail.modify` both permit `drafts.send`. Slack: ceiling `grant` (`read` mode), floor `code`, because its read and write scopes are disjoint. **IMAP: ceiling `code`.** An app password cannot be scoped — it grants IMAP and SMTP together, always — so an IMAP account can never reach `grant`. `README.md:223–224` already says this as the reason the package is not IMAP-first; the declaration block is what lets a pack say it in a machine-checkable way instead of a paragraph nobody diffs. **A platform declaring a lower ceiling is a supported outcome, not a defect**, and the design would rather ship an honest `code`-only pack than pretend uniformity.

### The binding, per platform

Four rows, because the three that the merged designs proposed omit the one that matters most:

| | Gmail | Slack | IMAP/SMTP (if built) |
|---|---|---|---|
| **What holds the ceiling up** | our code above `read`; Google at `read` | our code in `send` mode; Slack in `read` mode | our code, always — there is no other option |
| **What the approval is bound to** | the canonical field digest **plus** the draft's Gmail message id, which Gmail changes on every save, so a byte-identical restore still voids the approval | the payload digest alone, over a local draft; an identical re-save produces the same digest and the approval **survives** — the opposite of Gmail, stated here so nobody reasons from the mail case | a digest over the assembled RFC-5322 bytes; there is no server-side object to bind to |
| **Is there a copy the person can open?** | yes — it is in Gmail Drafts | **no.** Nothing exists in Slack until the person says yes | only if the package `APPEND`s one to `\Drafts` |
| **What `never` means** | a redirection: "the draft is in Gmail Drafts; send it from there" | a **stop**, with pasteable text — the escape hatch does not exist | a stop, unless the package created the drafts copy |

Each pack's send skill carries **only its own column**. `slack-send/SKILL.md` must never contain the sentence "the draft is in Gmail Drafts; send it from there", which is what makes `POLICY_NEVER` and `UNSENDABLE_HTML` acceptable answers in `gmail-send` rather than dead ends. Not every refusal ends there — `gmail-send/SKILL.md:131` routes `APPROVAL_VOID`, `APPROVAL_EXPIRED` and `RATE_CAPPED` elsewhere — but the ones that do are exactly the ones with no Slack counterpart. The **full table, all columns side by side, lives once in `docs/sending.md`**, because a human comparing platforms needs the difference visible in one place and an agent acting on one account needs the opposite. That division — comparison in the docs a person reads, one column in the file an agent loads — is how this design keeps the merged models' best property without their worst one.

One core string is Gmail-specific inside the neutral package and is actively wrong on chat: the `ApprovalStore` hint ending *"or to send it from Gmail."* It moves behind the same per-account indirection. Only that one string, though — `gmail-send/SKILL.md:131` shows `APPROVAL_VOID`, `APPROVAL_EXPIRED` and `RATE_CAPPED` already ending elsewhere, so this is one hint to reword, not a pattern running through every refusal path.

### Code that must land before `slack-send` ships

A skill may not describe a gate the code does not have. On `main` today:

| Gap | Where | Consequence for a chat account |
|---|---|---|
| `if (!/^ibx_[A-Z0-9]{16}$/.test(inboxId)) throw new Error(...)` | `packages/core/src/ledger.ts:44`, `packages/core/src/state.ts:28` | an `acc_` id throws a bare `Error`: no rate caps, no runtime state |
| `effectiveSendPolicy` reads `config.inboxes` only | `packages/core/src/config.ts:320` | a workspace set to `never` resolves to `defaults.sendPolicy`, which ships as `chat` |
| `Expectation {to, cc, bcc, subject}`, checked unconditionally by `claimForSend` | `packages/core/src/approvals.ts` | the last-mile check is a silent no-op for every channel post |
| `secrets migrate` omits `config.accounts[*].secretRef`, then deletes the sources | `packages/core/src/cli.ts:147` | a migrated config orphans every chat token |
| `inboxIdFor` resolves against `config.inboxes` only | `packages/core/src/cli.ts:50` | `agentcomms audit tail --inbox <slack-alias>` answers "no inbox called…" |
| `AuditRecord` has no workspace/channel/notify fields | `packages/core/src/audit.ts` | the permanent record cannot say what blast radius the approval was bound to |

The second is the worst: the loosening challenge was armed on `accounts.<alias>.sendPolicy` and nothing reads it back, so a `slack-send` quoting the account's policy would quote a policy the user did not set. None of these are caused by the naming model, and all of them are prerequisites for the Slack pack under any of the three designs considered.

---

## 5. Installing

The `skills` CLI resolves by directory, not by manifest: it walks for any directory containing a parseable `SKILL.md`, `--skill '*'` is a literal token meaning "everything discovered" rather than a glob, and named selection is exact-match. So `--skill 'gmail-*'` does not work, and the per-platform install story runs through the plugin manifest, which is where it works cleanly.

`.claude-plugin/marketplace.json` becomes two plugins under the one marketplace:

| Plugin | Skills | Server |
|---|---|---|
| `gmail` | the twelve `./skills/gmail-*` paths | `mcpServers.gmail` → `bin/agent-gmail-launch` |
| `slack` | the ten `./skills/slack-*` paths | `mcpServers.slack` → `bin/agent-slack-launch` |

**Gmail only.** Install the `gmail` plugin, or name the twelve skills. Twelve directories, one server, nothing Slack-shaped on disk, and no skill an agent loads mentions a platform the user does not have.

**Slack only.** Install the `slack` plugin. Ten directories, one server, and — the concrete payoff — no `authentication.md`, no `recipients.md`, no Gmail search-operator table: roughly 1,400 lines of mail mechanics that would otherwise be dead weight in the same directory tree.

**Both.** Install both plugins, or `--skill '*'` for all twenty-two. Two servers, one config file, one alias namespace (`accounts` beside `inboxes`, as S1 shipped).

**One plugin must never register two servers.** `doctor` treats an extra registered Gmail server as a failing check — though only by matching a known list (`findUngatedGmailServers`, `packages/gmail/src/operations/client-configs.ts:36`), so it would not today recognise a Slack server at all, and extending that matcher per platform is part of this work; a combined plugin that installs a Slack MCP server on a machine whose owner never authorised Slack would be the exact hazard the package already refuses to tolerate from third parties. Two plugins, one server each.

### The description budget, which is this model's hard ceiling

Skill selection is by description-skimming, and the spec's `[V]`-verified constraint is about 400 characters per description so that twelve fit inside Codex's 8,000-character fallback listing budget — not the 1,024-character `FIELD_LIMITS.description` in the verifier, which is a field sanity limit. Measured today: **3,995 characters across the twelve** (4,035 is their UTF-8 byte count; `scripts/verify-skills.mjs:271` counts code points), with `gmail-attachments` the longest at 387.

Because packs install per platform, **the budget scales with what a user actually installed, not with the catalogue**. A Gmail-only user carries ~3,995; a Slack-only user ~3,500; a both-platforms user ~7,495 today, or ~7,501 once `gmail-attachments` gains its platform noun — either way almost no room. **A third pack does not fit**, and the failure mode is a silently truncated listing — skills that stop being offered, with no error. So: `verify-skills.mjs` gains a per-plugin description sum that fails above 7,000 — it has no such check today, enforcing only a 484-line body cap and a 1,024-character per-description cap — and a third platform requires trimming the estate or introducing an index skill before it ships. That is a real limit and it is better to meet it as a failing check than as a skill that quietly stops being selected. The merged-skill designs do not escape it either: their neutral descriptions must name every platform in their symptom lists, so per-skill length grows as the catalogue shrinks.

### The namespace

The installer joins the agent's flat skills directory with the sanitised skill name and handles an existing directory by clearing and recreating it — a silent overwrite surfaced only as an `overwrites:` line. `~/.claude/skills/gmail-search` and `~/.claude/skills/slack-search` are distinct from each other and from any other repository's skills; `~/.claude/skills/search` would not be. The prefix **is** the namespace under this model, which is why the noun check in §3 turns the house convention into a rule.

---

## 6. Adding `@agentcomms/imap` later — the checklist

Not being built. This is what it would cost, so the door stays open without the design pre-committing to it.

1. **One row in `skills/_shared/platforms.json`** — prefix `imap-`, package `@agentcomms/imap`, tool prefix `imap_`, CLI `agent-imap`, annex `contract/imap.md`, server and program paths, launcher, noun `mail`, plugin `imap`. Every generator, both tests, the version rewriter and the release scripts pick it up with no further edit. This is the payoff for collapsing the four Gmail-hardcoded sites into a registry when Slack lands: the second platform pays, the third is nearly free at the tooling layer.
2. **One annex, `contract/imap.md`, ~40 lines.** The guarantee declaration with **ceiling `code`** and the app-password sentence. The account/container nouns kept distinct, and the word "mailbox" banned in this annex because IMAP uses it for the folder. The clause-2 counter roster reused from Gmail unchanged — an IMAP message is the same MIME/HTML. Clause 5's conditional-undo branch, because there is no bin: `\Deleted` + `EXPUNGE`, retention set by the server or by org policy. Clause 6's citable identity as the RFC-5322 `Message-ID`, never a bare UID.
3. **A plugin entry, a launcher, a `gemini-extension.json` server entry**, and the package added to the release and licence lists via the registry.
4. **Promote the mail-family files** — the first moment a second mail provider exists is the first moment `_shared/carried/` gains an `email/` subdirectory, under the same rule as everything else: a file moves when a second consumer appears, never on speculation. The candidates, with measured sizes: `recipients.md` (240 lines — `Reply-To` precedence, reply-all own-address filtering, `In-Reply-To`/`References`, the `Re:`/`Fw:`/`Fwd:`/`Aw:`/`Sv:`/`Vs:`/`Rv:` prefix strip, the 4,000-character quoted original), `authentication.md` (178 — SPF/DKIM/DMARC and the alignment table), `body-pipeline.md` steps 1–2 and §6 (MIME part-tree flattening, HTML-part-wins, charset override, quoted-history collapse and its markers), the `.eml` section of `export-formats.md`, the RFC 2047 filename-decoding paragraph, and the oldest-first budget section of `reading-bodies.md`.
5. **Two of those do not port as cleanly as their line counts suggest, and the annex must say so.**
   - `authentication.md` accepts a verdict only when the `Authentication-Results` authserv-id is exactly `mx.google.com`, and the file itself explains why: that header is one anyone can add, and RFC 8601 says a reader must trust only the instances added inside its own trust boundary. Generalising it is not a constant swap — it needs a per-account configured trust anchor and knowledge of the final hop, which is a security change with prose to match.
   - `recipients.md` builds the own-addresses list from the send-as addresses the Gmail API returns. SMTP has no send-as list, so reply-all's own-address filtering — whose failure that file calls the first thing to check — needs a different source or must be declared absent.
6. **Write fresh, and it is not small.** `query-imap.md` (IMAP SEARCH has no equivalent to the 23-row Gmail operator table or the 208 lines of `query-syntax.md`); `containers-imap.md` (folders, not labels; no `Parent/Child` naming-as-nesting; `\Deleted` semantics); `connect-imap.md` (hosts, ports, STARTTLS vs implicit TLS, app passwords vs XOAUTH2 per provider, and a "stopped working after a week" story with a different cause than Google's seven-day Testing refresh token).
7. **Capabilities that are simply absent, named rather than degraded.** No `resultSizeEstimate`, so the coverage line loses its estimate — arguably an improvement, since `gmail-search` already warns the estimate is wrong in both directions and `hasMore` is the only reliable field. No People API, so `imap-people` has two sources rather than three. No server-side thread model, so a thread is reconstructed from `References` and the skill must say the reconstruction can be wrong. No Drafts API, so the binding is the byte digest alone, there is no post-send read-back — `gmail-send` step 6 quotes back the labels Gmail filed it under and the conversation it joined — and there is no provider-side audit trail. **The post-send uncertainty story gets strictly worse, not better**, and the never-retry doctrine matters more there than anywhere.
8. **The decision that would block it.** Everything on this list is writing except one thing: whether an always-`code` ceiling plus a worse post-send story is acceptable for a package whose headline is an enforced send gate. That should be decided before the first line of `packages/imap/` exists, not during it. The design's position is that a pack declaring a lower ceiling honestly is a supported outcome — but `README.md` currently offers the `read` tier as the answer to "I want the stronger one", and IMAP would be the first pack with no such answer to give.

---

## 7. What this costs the twelve shipped Gmail skills

**Unchanged, all twelve:** directory names; frontmatter `name`; `compatibility: "@agentcomms/gmail@<version>"`; every sibling cross-reference (`"Not for sending — gmail-send does that"` stays true because `gmail-send` still exists under that name); and the opening sentence of every Contract block, which stays literally true. Bodies have room: `bodyLineCount()` puts them at **256–371 lines** today (the whole files are 267–382), leaving 113–228 against the 484-line cap.

**Eleven descriptions are unchanged, not twelve.** `gmail-attachments` gains a platform noun — see the hand-edit list below — and because `useWhenFor()` derives fit data from the description (`scripts/sync-skills.mjs:53`), that one skill's `references/fit.json` changes with it. The other eleven regenerate byte-identical.

**Regenerated, not hand-edited — twelve files:** `references/contract.md`, now composed from `core.md` + `contract/gmail.md`, expected ~120–130 lines against today's 111.

**Hand-edited — an exact list:**

| Change | Files | Size |
|---|---|---|
| Neutralise the five promoted reference files | `jail.md`, `risk-flags.md`, `downloads-root.md`, `disambiguation.md`, `injection.md` | **~52 provider-bound lines out of 896** — the 896 is exact; the 8 / 5 / 8 / 17 / 14 split is a manual estimate with no counting script behind it, and the neutralisation task must define its own rule |
| Split `injection.md`'s mail-shaped worked examples out | new `gmail-security/references/concealment.md` | ~110 lines moved; the doctrine and envelope design stay in the carried file |
| Add a platform noun to the one description that lacks it | `gmail-attachments` — "Find files people sent…" has no platform noun and would sit indistinguishably beside `slack-files` | one word. At 387 characters, adding `"Gmail "` reaches 393 — still inside the ~400 budget, so nothing else has to shorten |
| Declare clause slugs in the Contract block | all twelve | ~3 lines each, mechanical |
| Touch any Contract block quoting the thirty-day bin | at least `gmail-organize`; grep rather than assume | one line each |

**That last set is the correction to make out loud:** promoting a file into `_shared/carried/` is **not** byte-identical and **not** zero prose edits, as the per-platform design originally claimed. It changes committed content inside four shipped skills. Fifty-two lines is a small, boring number — and it is a real number, which is why the token scan in §3 exists: without it, the alternative is shipping `slack-files` with a table of `gmail_*` tool names in it, and `slack-people` telling an agent to run `agent-gmail search`.

**Is it breaking for existing users?** No. Nothing is renamed, so nothing is orphaned. Re-running the install command overwrites the same twelve directories. An agent that had `gmail-search` yesterday has `gmail-search` today, with the same name, the same description and the same tools. The one behavioural change a user could notice is the contract text — the bin fact moves from a numbered clause into the Gmail annex of the same file, and clause 3 gains the enforcement level and reach — and none of it loosens a rule.

**Tooling that must land in the same commit as the first `slack-*` directory**, because CI goes red the moment one exists and the error is self-contradictory: `sync-skills.mjs --check` exits 0 having filtered the new directory out, then `verify-skills.mjs` exits 1 demanding a `references/fit.json` that only `sync-skills.mjs` generates, and running the remedy the message names fixes neither. In dependency order: the registry replacing the filter in `sync-skills.mjs`, contract composition and `carried.json` copying; `sync-versions.mjs`'s package list and prefix filter and the `@agentcomms/gmail@` literal in its `compatibility:` rewriter (without which a `slack-*` skill's pin silently stops being bumped and `verify:versions` never flags it); `test/manifests.test.mjs:29` from a `deepEqual` against the `gmail-*` directories to a per-plugin assertion — which also resolves today's catch-22, where adding a non-Gmail path to the manifest fails the test and leaving it out makes the plugin route and the `npx skills` route install different sets; `test/tool-drift.test.mjs`, which today reads only `packages/gmail/src/mcp/server.ts` and `packages/gmail/src/cli/program.ts` and matches `/gmail_[a-z_]+/` — leaving it single-provider means the new pack ships unchecked in both directions, and the release's own §10 audit found 68 skill documents contradicting the code, one telling an agent to re-inbox mail the user had archived; `sync-reference.mjs`'s hardcoded contract paragraph and its per-package CLI and MCP halves; the three hand-written `['core','gmail','gmail-mcp']` lists; the ungenerated counts in `README.md` ("Twelve skills:") and `docs/architecture.md` ("There are twelve, one per job") which no check compares against the generated pages; and clearing any leftover `packages/slack/` build output from S2 work — nothing there is tracked by git, it is gitignored so `git status` stays clean, and with no `package.json` `pnpm -r` already ignores it. Housekeeping on one machine, not a workspace fault.

One decision that must be taken before S3 rather than during it, because it is a breaking change to a documented string: `UNTRUSTED_TAG = 'untrusted-email-content'` and a notice reading *"written by an email sender"* would wrap Slack content verbatim. It becomes `untrusted-content` with a neutral notice, in the same release as the contract split, with the worked examples in the Gmail skills updated in the same change. Keeping it means telling a model that a Slack status line was written by an email sender.

---

## 8. What is explicitly not being done

- **No neutral `comms-*` rename.** Two of the three designs considered proposed it, and it is the highest-cost, highest-risk option available: twelve renamed directories, twelve rewritten descriptions, twelve rewritten "what this skill does not own" tables, twelve `compatibility` pins with no honest single value — and, because the installer has no prune-on-add, twelve permanently installed zombie directories on every existing 0.1.2 machine, including a working `gmail-send` that still calls a registered tool and still outranks a neutral sibling on any query containing the word "Gmail". The compensating benefit — one description per job — is real but smaller than claimed: descriptions that must name every platform in their symptom lists are not obviously better routing targets than descriptions that name one.
- **No merged skills, and specifically no merged `comms-send`.** The strongest argument for merging is that a single document makes the weakening between platforms legible. That argument is accepted and satisfied in `docs/sending.md`, where the full four-row table sits side by side for a human. It is refused in the skill an agent loads, where one column is the whole point.
- **No shared `policies.md`.** Two copies at roughly 75% overlap that must agree about the gate's architecture — the ladder, the ten-minute single-use approval claimed with an `O_EXCL` marker, `stricter(live, requiredPolicy)`, the eight-state record machine, the never-retry doctrine, "the terminal check is a speed bump, not a boundary" — while disagreeing about binding and escape hatch. Forcing them into one source produces a file with two modes, which is the merged-skill failure in miniature. This is named as the file most likely to rot, and it is the first file the S6 audit reads. That is a mitigation, not a solution.
- **No speculative promotion into `_shared/carried/`.** A file moves the first time a second consumer exists. Nothing moves for a platform that might be built.
- **No IMAP or SMTP now.** §6 is a checklist, not a plan, and the ceiling question in item 8 is unresolved on purpose.
- **No cross-platform operations in v1.** "Triage everything waiting on me" across Gmail and Slack means an agent invoking two skills and reconciling two briefings itself, with nothing guaranteeing that `slack-triage`'s Noise means what `gmail-triage`'s Noise means. That is a real loss and it is **the condition under which this decision should be revisited**: if cross-platform triage becomes the product rather than a nice-to-have, a merged triage skill with per-platform evidence sources becomes the right shape and this model is the wrong one.
- **No `slack-organize`, `slack-follow-ups` or `slack-authentication`** — §2 gives the reason for each. Catalogues are sized to the platform, not mirrored from Gmail.
- **No `incoming-webhook`, no `chat:write.customize`, no `im:write`** in any manifest we ship. The first two fail the ceremony ladder's attribution test; the third is not worth a write scope for marking things read.
- **No linking instead of copying.** `verify-skills.mjs` fails a local link that escapes its skill directory, and the copier's comment gives the reason: a skill is installed as a directory. Composition, not indirection.
- **No third platform pack until the description budget is fixed.** §5 states the arithmetic: two packs installed together sit at roughly 7,500 characters against a verified 8,000-character listing budget. The proposed per-plugin check would fail at 7,000 so that the limit is met as a build failure rather than as skills that silently stop being offered; `verify-skills.mjs` has no such check today.
