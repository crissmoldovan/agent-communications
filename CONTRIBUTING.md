# Contributing

Thanks for helping make email safe to hand to an agent.

## Ground rules

- **Never commit real mail.** No real addresses, message bodies, subjects, attachment names, tokens, client secrets
  or `client_secret_*.json` files — not in code, fixtures, docs, issues or screenshots. Fixtures are synthetic and use
  `example.com`, `example.org` or `*.test` addresses. `scripts/verify-skills.mjs` scans the whole tree for likely
  secrets and machine-specific paths, and `pnpm verify` fails on either.
- **Sending is gated in one place.** Only `send.execute` in `packages/gmail` may call Gmail's `drafts.send` or
  `messages.send`, and only `executeSend` in `packages/resend` may call Resend's send endpoint; a test enforces
  each. A change that adds another path, or weakens the approval checks, needs a
  design discussion in an issue first.
- **Email content is untrusted.** Anything a sender controls reaches the model only inside the untrusted-content
  envelope, after the HTML sanitiser. Keep it that way.

## Layout

```text
packages/core         @agentcomms/core         provider-neutral core (config, secrets, approvals, envelopes), the
                                               agentcomms CLI and the core MCP server
packages/events       @agentcomms/events       the event catalogue, conditions and mapping: an isomorphic library,
                                               held back from release until something depends on it
packages/gmail        @agentcomms/gmail        Gmail channel: CLI (agent-gmail) and MCP server factory
packages/gmail-mcp    @agentcomms/gmail-mcp    the Gmail MCP server as its own package (agent-gmail-mcp)
packages/resend       @agentcomms/resend       Resend channel: CLI (agent-resend) and MCP server
packages/slack        @agentcomms/slack        Slack channel: CLI (agent-slack) and MCP server
packages/whatsapp     @agentcomms/whatsapp     WhatsApp channel, read-only: CLI (agent-whatsapp) and MCP server
skills/<name>/        Agent Skills (SKILL.md + references/)
docs/                 user and design documentation
scripts/              repository checks
```

The design lives in `docs/superpowers/specs/`, and the implementation plan in `docs/superpowers/plans/`.

## Local setup

Use Node.js 22.18 or newer and pnpm 11 (`npm install -g pnpm@11`, or `corepack enable` on Node 22/24). The build tool
needs 22.18; the published packages themselves run on Node 22.12 or newer.

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs Biome, the type checks, every test suite, the builds and the skill verifier. It must pass before you
push: nothing runs it for you on GitHub, because this repository has no CI for pushes or pull requests. `pnpm install`
sets up a pre-push hook (`.githooks/pre-push`) that runs it. The one workflow is the release: a `v*` tag runs
`pnpm verify` on Linux, macOS and Windows and publishes only if all pass, so a failure only Windows shows turns up
there — see [Releasing](docs/RELEASING.md).

## Skill contract

A skill lives at exactly `skills/<name>/SKILL.md` (no root `SKILL.md`). The directory name equals the frontmatter
`name`: lowercase letters, digits and single hyphens. Frontmatter carries `name`, a quoted `description`,
`license: MIT`, `compatibility`, `metadata` **as a map** (Codex refuses the single-string form) and `allowed-tools`.
Every skill carries `references/fit.json` and follows the section structure described in the design. Keep links
relative and inside the skill directory; the README must list each skill's exact description.

## Adding a capability

Everything the packages do can be done from a terminal and from a chat
([design](docs/superpowers/specs/2026-09-25-cli-mcp-parity-design.md)). A new capability is four things, in one pull
request:

1. **One operation** in `packages/<package>/src/operations/` that does the work: an exported function both surfaces
   call. Neither re-implements it.
2. **The command**, in the package's CLI (`src/cli/program.ts`; for the core, the usage table in `src/cli.ts`).
3. **The tool**, in the package's MCP server (`src/mcp/server.ts`).
4. **The row**, in `capabilities.json` at the root. `cli` is the command path without the binary, `mcp` the tool, and
   `operation` the function from step 1:

   ```json
   { "id": "gmail.label.create", "package": "gmail", "cli": "label", "mcp": "gmail_label_create", "status": "both", "operation": "createLabel" }
   ```

Then `pnpm sync:reference` and `pnpm test`. `test/parity.test.mjs` reads every command from the CLI's own help and
every tool from a running server, and fails — naming what is missing — when either is in no row, when a row names
something that does not exist, or when a row's status and its sides disagree.

It also runs both sides of every `both` row to their end, and fails unless each reaches the row's `operation` before
any operation another row names, reaches nothing after it that the row does not name, and passes it the arguments the
row's `expect` gives. Nothing real happens: in a process of its own
(`scripts/operations.mjs`), with a temporary home, the file secret store and no network, keychain, child processes or
worker threads, every function a command or a server imports from an `operations/` module is a stand-in that records
the call and what it was given, and does nothing. So a row whose command and tool run
different operations fails, and so does a row that names a helper everything calls; the message says what each side
reached instead. A command and a tool that share a step on their way and part after it fail too, each naming what it
went on to: naming the shared step as the row's operation hides nothing. A row may add:

- a list for `operation`, when the command is several operations; each side has to reach all of them. A name is
  looked up in the row's own package, then in the core's — a channel's `mcp install` runs the core's
  `serverInstallChange`.
- `argv` and `args` — words added to the command, arguments given to the tool — when the smallest call does not reach
  the operation. The check already supplies whatever Commander or the tool's schema requires; `argv` is for the rest,
  such as `["--finish", "parity"]` for the half of `inbox add` that finishes a sign-in, or
  `["--client", "claude-code"]` for `mcp install`.
- `via`, naming another row's operation that a side passes through on its way, when the command really does that:
  `setup` reads the state (`setupState`) before it starts a sign-in.
- `after`, naming each operation a side goes on to after the row's own, with why — `{ "showWorkspace": "reads back
  what it changed, to say so" }` — when the command really does that. The check fails an `after` that neither side
  reaches after the operation.
- `expect`, when another row runs the same operation through another command and another tool: the four Slack mode
  rows all run `planModeSet`, and reaching it cannot tell them apart. `expect` says what the operation receives from
  both sides, by the name of its parameter or a path into one — `{ "wanted": "read" }`,
  `{ "request.channel": "gmail" }` — with `null` for an argument not given. The check records what each side passed
  and fails a side that passed anything else. It also fails two such rows unless their `expect` gives some argument a
  different value in each, so a tool moved from one row to the other brings its own value along and is caught. Rows
  that share a whole side need none: `gmail_inbox_finish` is behind both `inbox add --finish` and
  `inbox reauth --finish`, and exchanging their commands pairs nothing new. Leave `expect` out and the check says which
  arguments both of the row's sides pass that the other rows' do not.
- `unchecked` instead of `operation`, saying why, when the check cannot reach the operation cheaply or the two sides
  are knowingly not one operation yet. `pnpm verify:parity` lists every such row on every run; each is a debt, not a
  pass.

Leave `operation` out while writing a new row, and the check tells you which operations its two sides both reach.

When one side is missing, the row says why:

- `"status": "pending", "phase": "P4"` — the other side is still to be written. `pnpm verify` runs
  `pnpm verify:parity --strict`, which refuses any pending row, so a capability lands with both sides or with a
  stated exception — never half of one.
- `"status": "exception", "reason": "…"` — one side on purpose: `approve`, because under `confirm` approving is a
  person at a terminal; `mcp`, because it starts the server a tool would need already running. The reason is what a
  reviewer reads, so it says why rather than what.

A command that only groups others (`agent-gmail inbox`) has no row; one that groups and also acts (`agent-gmail mcp`)
does, and the test tells them apart from the CLI itself. One command can be several rows when its arguments choose
between operations (`agent-gmail inbox add` starts a sign-in, and with `--finish` completes one), and one tool can
back several commands (`comms_server_install` is `mcp install` in every package); `reason` on such a row says how the
two meet.

## Telling a person what to run

Every command this suite prints for a person — an approval, a change run again with `--approval`, a repair — names
this Node and a checked file of the installation that printed it, with its folders pinned, or says plainly that there
is none here ([design](docs/superpowers/specs/2026-10-04-cli-path-shims-design.md), D1–D6). A bare `agent-gmail …` or
`agentcomms …` is not on most people's PATH. So no package prints one, quotes a line itself, or builds a command from
words it pasted together: it asks core's handoffs (`packages/core/src/handoffs.ts`).

**1. Give core your caller, once, where your package opens core.** `url` is a module of your own package — the nearest
`package.json` above it must carry `packageName` — never core's, and never a wrapper's: Gmail's server-only package
locates Gmail from Gmail's exported `RESOLVER_URL`.

```ts
const core = openCore({ env, platform, pathOverrides, caller: { url: import.meta.url, packageName: PACKAGE_NAME } });
```

From then on core's own sentences — approvals, a change waiting at a terminal, a download's question, an update that
stops a command — name your commands, located, and `core.handoffs` (or `requireHandoffs(core)`, which throws if the
caller was left out) makes yours:

| Call | Runs |
|---|---|
| `handoffs.own(words, use?)` | your own CLI: `own(['inbox', 'reauth', alias])` |
| `handoffs.core(words, use?)` | core's CLI, through your installed dependency on it |
| `handoffs.of(channel, words, use?)` | another product's CLI, found only among the servers registered with this machine's MCP clients: `(await handoffs.registered()).of('slack', words)` |
| `handoffs.on(platform)` | the same, quoted for the shell your output is for (`context.platform`) |

`words` start after the program — never the binary, never a path. Each call returns a `Handoff`: a `PrintedCommand`, or
a `CliCommandNotLocated` whose `message` names the product, its package and the exact version it needs and says it is
not locatable here. `use` pins folders: the four every command opens by default (config, state, data, secrets);
`{ downloads: true }` for one that saves files; `{ uses: [] }` for one that opens none, such as `--help`.

**2. Render it with the helpers, never by interpolating words.**

- In a sentence: `handoffSentence(handoff, (command) => \`Run ${command} to …\`)`. With no command, the whole sentence
  is the not-locatable one — never the template with something else in the command's place.
- As a value of its own — a list's line, printed: `handoffText(handoff)`; in a result's field, the handoff itself (4).
- With words the agent fills in (`<folder>`): `handoffSentenceToFill(handoff, ['<folder>'], say)`, or as a value of its
  own, `handoffTextToFill(handoff, ['<folder>'])`.
- Several that could each do it (each sending channel's `approve`): `handoffChoices(handoffs, none)`.
- Where something else does it with no command — a tool from a chat — say so for when there is none:
  `handoffSentence(handoff, say, { instead: 'Call gmail_inbox_reauth from a chat.' })` says that, then why.

**3. A command run again with its approval.** Give `gatedChangeAtTerminal` and `downloadAtTerminal` the words of the
command after its program as `rerun`; the approval goes in before any `--`. There is no other way to name it: the
bare-name bridge for a package without its caller, and every `command` and `approveCommand` input it served, are gone
(CUE-403 task 15).

**4. A result's command is the command itself; on every surface it is the same text.** A field whose value is a command
— a `command`, a `next`, a `finish`, a `claim` — is typed `Handoff` (or `PrintedCommand | ExternalCommand`) and holds
the handoff, never its text: a string, a template or an argument fragment does not compile there. A field that mixes
commands and words — a doctor's `fix`, a list of next steps, a rival's `removal` — is a `Remedy`, made only by
`remedy(…)` from handoffs and words, a line per argument (`remedy([remove, ', then add it again'])`). A command is
rendered where it leaves the process: the human renderers call `handoffText`; `--json` and MCP `structuredContent` are
JSON, where a command writes itself out as the text the field always carried — its line, or its words as JSON with what
to do when no Windows line is safe, or the not-locatable sentence (`toJSON`). So every server's `reply` and `fail` pass
their result through `JSON.stringify` before it leaves. A command is never interpolated: one in a template throws.
`test/printed-command-types.test.mjs` compiles fixtures that hold each of these fields to it.

**5. Core functions that print for you take your handoffs.** Where one took the `platform` its hint is quoted for, it
takes your `CliHandoffs`, already `.on(context.platform)` — they carry their platform (`secretsStoreFor`,
`profileSourcePath`, `requireLiveOrganisationGeneration`, `resolveProfileSlackTarget`, `learnProfileSlackAppId`,
`organisationDrift`, `changePolicyReport`, `probeKeychain`). An options bag takes `handoffs` (`chooseSecretStore`,
`checkAttachable`'s `AttachPolicy`). The configuration store, the secret stores and the approval store get
`core.handoffs` from `openCore` themselves. A core opened without its caller has none, and there is no bare name to
print in their place: a refusal that has to name a command is then the programming error `requireHandoffs` throws.

**6. Never put a command where an approval binds it.** A change's `summary`, `effects` and `preview` are digested: the
process that claims an approval must make the same bytes as the one that prepared it, and a located command is each
process's own. Commands go in `hint`, `next`, a note or a result field, which are not digested.

**7. Another product's command is found, never guessed.** `of(channel)` without registrations is the not-locatable
result. `registered()` reads every MCP client's configuration, so read it where the command is needed — an error path,
a report that names one — not on every call.

**8. Name a program by its product, never its binary.** A string a person reads never names one of this suite's
binaries — not as a command, not as a product (`this agent-slack is …`), not as a program in a page's title. Say "the
Slack CLI", "the core server", "this package", "the command": a bare binary is no command most people can run, and
any sentence that names one reads as one. A `--help` example block shows the CLI's own words after "run these with
this CLI" (`  post prepare --workspace <org>/slack …`). Identities stay what they are: an MCP server's `name`,
Commander's `.name()` — whose `Usage:` line is the protocol's — a gate's `binary`, a manifest's fields.
`test/printed-command-construction.test.mjs` holds every runtime package to this with a syntax-tree scan derived
from `capabilities.json` and the channel registry: a binary at a word's edge in any string or template, a manifest's
`binary` or `approve` interpolated or written whole into a hint, an MCP instruction or description, a stream or a
result's field, `node` before a suite entry, `npx` before a suite package, a shell whose payload starts a product. It
leaves comments, types, regular expressions and identity positions alone by their syntax, never by file — see
`test/helpers/printed-command-guard.mjs` — and its fixtures in `test/fixtures/printed-commands/` show what it refuses
and what it accepts. A client's own CLI is never called `binary` there (`cliPath`).

**9. An approval handed to a person names the agent's wait beside it.** A person approves at their terminal; the
agent learns that they have by waiting, never by asking ([design](docs/superpowers/specs/2026-10-05-approval-smoothness-design.md),
D3 and D7). So a refusal or a next step that sends a person to `approve` is made with the helpers in
`packages/core/src/approval-handoffs.ts`, which core exports, never by putting a wait's name in a template:

| Helper | Says |
|---|---|
| `approveAndWaitSentence(handoffs, surface, approvalId, (approve, wait) => …)` | the person's located `approve`, and the agent's wait: its tool over MCP (`surface: 'mcp'`), its located command at the command line |
| `waitSentence(handoffs, surface, approvalId, (wait) => …)` | the wait alone — a timeout's "wait again", a download question's "wait for their answer" |
| `changePendingHint(handoffs, surface, approvalId)` | a change waiting for a person at a terminal: run `approve`, learn when with the wait, then try again |
| `approveRefusedHint(handoffs, approvalId)` | an `approve` an agent ran itself, refused: the person runs it, and the wait says when |

The wait is the printing package's own — `APPROVAL_WAITS`, by manifest channel: `gmail_send_wait` and
`send wait`, `slack_approval_wait` and `approval wait`, `resend_send_wait` and `send wait`, and core's
`comms_approval_wait` and `approval wait` for a channel with none — located through the same handoffs as its
`approve`, so both reach the same folders. A channel that adds a wait adds its row to `APPROVAL_WAITS` and a
`capabilities.json` row whose operation is `waitForApproval`; `test/parity.test.mjs` holds the two to each other, and
`test/tool-drift.test.mjs` holds each to a tool its server registers and a command its CLI defines. With no command
here, a sentence says why, as every handoff does.

Before — the 0.13.0 way, which no longer compiles: `shellCommand` is not exported, and `commandText` takes only a located
or an external command:

```ts
fix: commandText(shellCommand(['agent-gmail', 'inbox', 'reauth', alias], context.platform)),
hint: `Run ${inlineCommand(shellCommand(['agent-gmail', 'whoami', '--inbox', alias], platform))} to check it.`,
```

After:

```ts
const handoffs = requireHandoffs(context.core).on(context.platform);
fix: remedy(handoffs.own(['inbox', 'reauth', alias])),
hint: handoffSentence(handoffs.own(['whoami', '--inbox', alias]), (command) => `Run ${command} to check it.`),
```

Tests build the expected command the same way rather than by hand: `packages/core/test/helpers/handoffs.ts`
(`coreHandoffs`, `coreCommand`, `locatedCoreLine`, `assertNoBareCommand`) and the package fixtures in
`packages/core/test/fixtures/cli-command/`. A channel's tests import core from its build, so run
`pnpm --filter @agentcomms/core build` after changing core.

**And paste one.** A command that looks right can still miss the folders it needs once it leaves the process that
printed it. `test/helpers/real-shell.mjs` is the person who pastes it: a fresh shell with no suite command on its PATH,
every `AGENT_COMMS_*`, XDG, home and AppData folder a decoy, another working folder, a seal that refuses the keychain
and every connection off the machine (`seal-process.mjs`), and a terminal for a person's own `approve`, its code typed
back (`terminal.py`). `test/real-shell-handoffs.test.mjs` runs core's and Gmail's built CLIs that way, and each
sending channel's `test/real-shell.test.ts` its own approval; a new channel's approval belongs beside them. `approve`
needs a terminal no test can give on Windows, so there the refusal it gives for want of one is checked against the
printing process's store instead.

## Adding a channel

A channel is a package that says what it is; nothing in the core or the tooling is edited to add one
([design](docs/superpowers/specs/2026-09-26-channel-plugins-design.md)). Channels are first-party only: they live in
this repository and are released with the core, because a channel's process can read every channel's credentials in
the shared keychain namespace, so it is trusted exactly as far as it is reviewed here.

1. **The package**, `packages/<channel>`, named `@agentcomms/<channel>` and at the same version as the rest, with
   `@agentcomms/core` as a runtime dependency, in `dependencies`, as `workspace:*`, and in no other dependency field.
   That packs to the exact version, so a published channel installs the core of its own release: the bundle still
   inlines core's code, and the installed package is how the channel finds core's own command
   ([design](docs/superpowers/specs/2026-10-04-cli-path-shims-design.md), D4). `test/channel-registry.test.mjs`
   refuses a channel that declares core any other way. Its CLI at `src/cli.ts` with a Commander program at
   `src/cli/program.ts` exporting `run`, its MCP server at `src/mcp/server.ts` exporting `create<Label>McpServer`, a
   README, and `THIRD_PARTY_LICENSES` in its `"files"`. And **`test/consumer-check.mjs`**: `pnpm verify:packages`
   packs the package, installs the tarball into a throwaway project and runs that file there, so it is the only test
   of what is actually published — the bin starting, the exports resolving, nothing missing from `"files"`. A package
   without one fails the verify.
2. **Its manifest**, the `"agentcomms"` field of that `package.json`: `contract: 1`, `channel` (the directory's name;
   also the platform word in account names and the tool prefix), `label`, `binary` (`agent-<something>`), `server`,
   `accounts` (`map: "accounts"`, `noun`, `modes` from `read` and `send`, and an honest `guarantee`), `narrowing`
   (exactly `[{ "option": "account", "flag": "--account", "kind": "pin" }]`), `rivals`, `hosts` (`[]` when it talks to
   no host), `approve` and `skills`. A channel that sends drafts also says how the unsent report groups its approvals,
   `approvalGrouping`: `"draft"` (account and draft, as Gmail and Resend) or `"draft-revision-digest"` (and the exact
   revision and content digest, as Slack); without it, its approvals take no part in the report. The schema is
   `channelManifestSchema` in `packages/core/src/channel-manifest.ts`, and it refuses Gmail's `inboxes`, `--inbox` and
   `--read-only`, and Slack's `--workspace`, to any other channel.
3. `pnpm sync:channels`, which validates every manifest and writes the core's snapshot of them. From it the core knows
   the channel: the installer, `comms_server_install`'s `channel`, the update, and the words of every preview.
4. **Its accounts** in the config's `accounts` map: `platform` is the channel word, `mode` is `read` or `send` and
   nothing else, and credentials go through the core's secret store under `<channel>:` references. It adds no safety
   setting of its own: only `sendPolicy`, `changePolicy` and `mode` are judged when a change loosens something.
5. **Its capabilities**, a row per command and tool in `capabilities.json` (above), and **its skills**,
   `skills/<prefix>*/` with `skills/_shared/contract-<family>.md`.
6. `pnpm sync:skills`, `pnpm sync:reference`, and `pnpm build && pnpm licenses` — the notices are read from what the
   bundle actually contains, core and everything core inlines included — then `pnpm verify`.
7. **Its first release.** npm cannot hold a trusted publisher for a package that does not exist, so a new channel's
   first version is published by hand, once, from the tagged commit; the release's preflight stops the run with
   nothing sent and prints the exact command. See
   [a new package's first version](docs/RELEASING.md#a-new-packages-first-version).

Everything else reads the channel registry (`scripts/channels.mjs`), so the release, the version sync, the parity
check, the reference pages and the skill and name tests pick the channel up from its manifest.
`test/channel-registry.test.mjs` fails if one of them stops doing so.

## Adding a library

A library is a package with no command, no server and no skills: code the other packages, the daemon or the app
import ([design](docs/superpowers/specs/2026-10-05-local-event-emission-design.md), D14). Like a channel, it says what
it is in its own `package.json`, and the tooling derives the rest.

1. **The package**, `packages/<name>`, named `@agentcomms/<name>`, at the same version as the rest (the version sync
   keeps it there), and not private.
2. **Its declaration**, exactly `"agentcommsPackage": { "kind": "library" }` — never the `"agentcomms"` field, which
   means a channel. `scripts/channels.mjs` refuses any other kind or key. It has no `bin` and no row in
   `capabilities.json`: `test/parity.test.mjs` exempts a declared library, and only one, from having a surface, and
   refuses one with a command, a `src/cli.ts`, a `src/mcp/` or a row.
3. **What every published package has**: a README, a `LICENSE`, `THIRD_PARTY_LICENSES` in its `"files"`
   (`pnpm build && pnpm licenses` writes it), and a **`test/consumer-check.mjs`**, which `pnpm verify:packages` runs in
   a throwaway project with the packed tarball installed, ending with a `<name> consumer check: … OK` line.
4. **Held until its first release.** Add `"agentcommsRelease": { "hold": "<why, one sentence>" }` beside the
   declaration, so the next tag does not stop for a hand publish of a package nothing uses yet. It is checked by every
   `pnpm verify` all the same, and its hold is lifted in the version commit of the first release that ships something
   depending on it — see [a package held back from release](docs/RELEASING.md#a-package-held-back-from-release).

Then `pnpm verify`. The release, the version sync, the package checks, the licence notices and the parity exemption
pick the library up from its declaration; `test/channel-registry.test.mjs` fails if one of them stops doing so.

## Pull requests

- Keep each pull request focused, and say what changes for the person using it.
- Add tests with the change. The send gate, path jails and untrusted-content handling always need them.
- Update docs and skills when a command, tool or behaviour changes; a test fails when a skill names a tool or command
  that does not exist.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md), never
  in a public issue.

## Releasing

See [`docs/RELEASING.md`](docs/RELEASING.md) — the order, the one-time npm setup, and what the dry run is for.
