# CUE-403 — runnable CLI handoffs from the running installation — design

Status: **proposed for 0.13.1; revised after round 14 (1 P2), 2026-10-05. No implementation is in
this change.**

## 1. What is being fixed

A runtime result can require a person to approve or repair something at a terminal, then print `agentcomms` or an
`agent-*` binary which is not on that person's `PATH`. Gmail send preparation and the shared change flow do that now
(`packages/gmail/src/operations/send.ts:386-455`, `packages/core/src/changes.ts:73-98`,
`packages/core/src/changes.ts:265-283`). Terminal approval deliberately has no MCP capability under `confirm`
(`docs/superpowers/specs/2026-09-25-cli-mcp-parity-design.md:148-152`).

The 0.13.1 acceptance criterion is:

> Every new terminal handoff has one of three accepted outcomes: a pasteable command which does not require an
> agent-communications binary on `PATH` and pins every agent-communications directory it uses; on the rare Windows
> path which the safe renderer refuses, the exact argv as inert JSON with an instruction to enter those words
> manually; or no command, with the target product and required version and an explanation that it is **not locatable
> here** and must be installed or updated through the person's usual route. It never prints a bare suite binary,
> invents a repair command or sends a person to an MCP tool for terminal approval.

This fixes approvals and reruns, and makes an unlocatable cross-product handoff honest. It does not publish shims,
edit `PATH` or profiles, install or update another product, or change approval, sending or change-policy semantics.

## 2. Facts the design relies on

- Managed registrations use an absolute Node command and a versioned runtime entry
  (`packages/core/src/mcp-install.ts:299-320`, `packages/core/src/mcp-install.ts:566-580`). Registered-server scans
  retain command, arguments, package and environment, and distinguish unreadable client configs
  (`packages/core/src/mcp-clients.ts:30-63`, `packages/core/src/mcp-clients.ts:376-450`). Product and pinned-version
  recognition already derive from package, binary and entry facts (`packages/core/src/mcp-install.ts:338-390`).
- A checkout launcher currently searches source and built entries, which permits a stale `dist` fallback
  (`packages/core/src/mcp-install.ts:523-559`, `packages/core/src/mcp-install.ts:583-603`). Each published manifest maps
  its primary binary to `dist/cli.mjs`, for example Gmail (`packages/gmail/package.json:24-25`).
- `resolvePaths` makes relative overrides absolute and otherwise consults XDG, `HOME`/`USERPROFILE`, `APPDATA` and
  `LOCALAPPDATA` while deriving config, state, secrets, data and default downloads directories
  (`packages/core/src/paths.ts:37-66`). A registered server's minimal environment currently fixes only the config
  directory (`packages/core/src/mcp-install.ts:266-280`).
- MCP-client configuration is a separate path class: Claude, Codex and the other clients are found from the runner's
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, home and platform application-data environment
  (`packages/core/src/mcp-clients.ts:65-95`).
- Every channel declares its binary and package facts in `package.json`; the tooling discovers that data rather than
  keeping a channel list (`docs/superpowers/specs/2026-09-26-channel-plugins-design.md:24-52`,
  `scripts/channels.mjs:27-59`, `scripts/channels.mjs:114-150`).
- The current Windows renderer accepts only the intersection safely understood by cmd.exe and both PowerShell eras,
  and otherwise emits inert JSON (`packages/core/src/cli-runtime.ts:67-129`,
  `packages/core/src/cli-runtime.ts:136-191`).

## 3. Decisions

### D1. One structured locator; lockstep resolution in every direction

Core owns `locateCliCommand`. A request supplies the calling package's resolver URL, the target manifest, argument
words, the resolved-directory uses of the target command, and the output platform. Success is a `PrintedCommand`
(D5); failure contains no command and names the reason, product, package and required version. Callers never supply
word zero or quote a line.

The interpreter rule is one rule: every printed command runs under `process.execPath` — the running package's own
CLI, channel→core and every cross-product command alike. **No interpreter named by a registration or a client
configuration is ever executed**, not even to probe its version: a scanned registration carries no installer
provenance (`packages/core/src/mcp-clients.ts:30`, `packages/core/src/operations/servers.ts:575`), so none can be
trusted to run. `process.execPath` must satisfy the **target** package's `engines.node` range, checked against
`process.version`; outside the range the result has no command and the reason names the required Node range. Lockstep packages do not share one floor — core accepts Node `>=22.12.0` while WhatsApp needs
`>=22.16.0` and checks it before every action (`packages/core/package.json:8-10`, `packages/whatsapp/package.json:8-10`,
`packages/whatsapp/src/cli/program.ts:200, 477`). The Node flags are decided by the **selected entry**, not inherited: any `.ts` entry (a checkout's `src/cli.ts`, for
the running package or a cross-product `local` registration alike) always gets `--experimental-strip-types`, as the
existing local launcher already does for a `.ts` entry (`packages/core/src/mcp-install.ts:546-556`) — Node 22.12–22.17
needs it, and later versions accept it; `--experimental-transform-types` is added only when the running source
invocation used it and the entry is `.ts`. A built `.mjs` entry gets no flags. No other `process.execArgv` flag is ever
copied: debug, test, eval, preload/loader, condition, warning, source-map, title and memory flags are not CLI
requirements.

Resolution is directional:

1. **The calling product's own CLI.** Walk from the resolver URL to the package manifest and verify its name. If the
   resolver URL itself ends in `.ts`, select exactly `<package-root>/src/cli.ts`; do not inspect `dist`. Otherwise
   select the manifest's `bin[agentcomms.binary]`. This makes a checkout with no build and one with a stale build both
   run source. A valid running product therefore locates its own CLI from itself and never needs a registration.
2. **Channel to core.** Resolve the channel's installed `@agentcomms/core` runtime dependency from the caller and
   verify the channel and core versions are equal. Select core's `src/cli.ts` only when **both** the caller's module URL
   ends in `.ts` and the resolved core package root, after `realpath`, is a workspace package inside the same realpath
   repository checkout as the caller. Otherwise select core's manifest bin. The decision is made from the caller's
   source status, the two real package roots, workspace membership and repository identity — not from core's exported
   module URL, which points at `dist/index.mjs`, or merely from the final candidate path
   (`packages/core/package.json:16-25`). Every channel moves `@agentcomms/core` from `devDependencies` to
   `dependencies`; those edges are currently development-only
   (`packages/gmail/package.json:44-45`, `packages/slack/package.json:41-42`,
   `packages/resend/package.json:41-42`, `packages/whatsapp/package.json:41-42`). Gmail's server-only wrapper still
   supplies a resolver URL from its Gmail dependency (`packages/gmail-mcp/package.json:41-43`).
3. **Any product to another product.** Core and every channel use the same core registration scanner; a channel can do
   so because it has the D4 runtime dependency on core. The scanner filters with the existing product recogniser and
   resolves the registration's version. It may print that product's command **only when that version equals the
   printing package's own version**. A different or unknown version is unusable: in particular 0.13.0 rejects the new
   path options in core's strict parser and Gmail's program (`packages/core/src/cli.ts:157-168`,
   `packages/gmail/src/cli/program.ts:159-173`). npx registrations are not candidates (below). Among matching
   registrations the priority is a managed runtime entry, then another checked file entry; within a class sort by
   client, config path, server name, command and arguments. The recogniser is given the registration's words with the
   operands of the five path options (`--x value` and `--x=value`, before any `--`) removed, so a pinned directory such
   as `/tmp/@agentcomms/slack` can never make a Gmail registration read as Slack (today's recogniser searches every
   argument for package-like text — `packages/core/src/mcp-clients.ts:453`, `packages/core/src/mcp-install.ts:371`).

   A managed registration supplies its checked runtime CLI entry; another file-backed registration supplies the
   checked package CLI entry resolved from its absolute command or entry. This includes an installer-written `local`
   registration and a separately installed global package; `global` is not an installer launcher. Both drop server-only
   `mcp` and narrowing arguments. An **npx registration is never used for a cross-product command**: the pasted `npx`
   would pick its own Node from the person's PATH, and the target's `engines.node` range is unknown when the npx cache
   has been evicted, so neither the interpreter nor the range can be validated at print time; it is treated as not
   locatable (below). (A process's *own* commands, printed by an npx-launched server, are unaffected: they use that
   process's own Node and its own package entry.) An absent entry, unpinned
   spec, unreadable command, unrecognised launcher or version mismatch is never used. When no same-version registration
   resolves, the result contains **no
   command**. It names the product and the printing package's exact version and says that version is not locatable
   here; install or update it through the person's usual route, then retry. It does not guess which client, package
   manager or installation owns the product, and does not print `update`, `server install`, an MCP tool or any other
   repair. Managed and npx registrations already expose the version evidence used to accept or reject them
   (`packages/core/src/mcp-install.ts:338-350`, `packages/core/src/operations/servers.ts:575-612`).

   On Windows, the registration scanner compares executable stems and every candidate package-entry path segment
   case-insensitively; POSIX remains case-sensitive. The existing recogniser currently compares both exactly
   (`packages/core/src/mcp-install.ts:371-372`, `packages/core/src/mcp-install.ts:382-388`).

Before any file entry is returned, the locator `realpath`s both package root and entry, requires a readable regular
file, and checks containment by path segments after realpath. A missing manifest binary, a mismatch between
`agentcomms.binary` and `bin`, a symlink escape, a directory or unreadable target, a non-absolute interpreter, or a
version mismatch returns no command. Only the interpreter and a file entry are necessarily absolute; subcommands,
flags, ids and an npx package spec are ordinary argument words.

The same scan defines channel→another-channel approval-kind corrections. Each channel manifest gets one alternative:
its absolute approve command when a same-version registration resolves, otherwise the no-command result naming the
product and exact version it needs. The fallback does not claim to know an installation route, originating or
approving MCP tool: send approval records carry no origin channel, and approval under `confirm` is deliberately
terminal-only
(`packages/core/src/approvals.ts:302-316`,
`docs/superpowers/specs/2026-09-25-cli-mcp-parity-design.md:148-152`). The current corrections instead concatenate
every manifest's bare approve string (`packages/core/src/channel-words.ts:39-52`,
`packages/core/src/changes.ts:314-332`, `packages/core/src/approvals.ts:644-655`).

### D2. Resolved paths travel as global options, never environment assignments

Every CLI gains these global options in the shared CLI runtime:

```
--config-dir <dir>  --state-dir <dir>  --data-dir <dir>  --secrets-dir <dir>  --downloads-dir <dir>
```

They are parsed before a core/channel context is opened. Each non-empty option is made absolute with `resolve()` and
pins exactly its named effective directory after normal environment, configuration and default resolution; it neither
sets an environment variable nor changes how another directory is derived. In particular, `--downloads-dir` wins over
the configured downloads root without changing `config.json` (`packages/gmail/src/operations/attachments.ts:352-356`,
`packages/resend/src/operations/read.ts:514-517`). This independence is essential on Windows: setting
`AGENT_COMMS_CONFIG_DIR` makes `localRoot` equal the config directory and therefore moves `secretsDir`, while
`--config-dir` fixes only `configDir` and `--secrets-dir` fixes only `secretsDir`
(`packages/core/src/paths.ts:42-56`).

Their scope is only agent-communications' own config, state, data, secrets and downloads directories. They do **not**
pin Claude, Codex, Cursor, Gemini, VS Code or other MCP-client configuration files. `knownClientConfigs` deliberately
finds those from the environment of whoever runs the CLI — including `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, home and
platform application-data variables — exactly as when the person types the command directly
(`packages/core/src/mcp-clients.ts:68-95`). A handoff which scans, installs, updates or removes client registrations
therefore acts on that person's own clients by design.

The locator does not reproduce the printing environment. It first removes every existing path option from supplied or
registered argument words, at any position **before a `--` end-of-options word**: both `--x value` and `--x=value`
forms for all five names. Option recognition stops at the first `--`; that word and everything after it are positional
data and are kept exactly. A spaced form with no value before `--` (or at the end) is an installation error and yields
no command. It then inserts,
between the entry/package word and the subcommand, exactly one canonical absolute option for every
**agent-communications** directory the target command uses: config, state, data, secrets and, for a handoff which reads
or writes downloads, downloads. It emits none for a suite directory the target does not use. Thus caller ordering,
duplicate or relative values, and the cwd where a registered or retry command is later run cannot override the pins.
Gmail's raw-argv retry builder goes through this same normalization after removing approval flags
(`packages/gmail/src/cli/program.ts:369-388`); that approval removal also stops at the first `--`, and every generated
approval option — `--approval` and `--mcp-approval` alike — (`gatedChangeAtTerminal` today appends it at the end — `packages/core/src/change-flow.ts:217`,
`packages/core/src/cli-runtime.ts:131`) is inserted immediately **before** an existing `--`, never after it, so the
retry still claims its approval and every positional word after the sentinel survives. The independent pins override conflicting variables and defaults in the
target shell for the named suite directories; they intentionally do not reproduce or override the environment used to
find the person's MCP clients. No environment assignment is printed on any platform.

Registrations preserve the same identity. The installer writes resolved absolute `--config-dir`, `--state-dir`,
`--data-dir` and `--secrets-dir` values into every supported installer launcher: `managed`, `npx` and `local`
(`packages/core/src/mcp-install.ts:101`, `packages/core/src/operations/servers.ts:78`). `buildEntry` gives all three the
same pinned argument construction before its launcher branches, including `local`; it no longer relies on only
`AGENT_COMMS_CONFIG_DIR`
(`packages/core/src/mcp-install.ts:266-280`, `packages/core/src/mcp-install.ts:532-546`). This also fixes the existing
Windows split-root file-secret bug: an explicit config directory currently changes `localRoot`, so a server registered
from split `APPDATA`/`LOCALAPPDATA` can look for secrets under a different root from the installer
(`packages/core/src/paths.ts:50-56`). Downloads remain a per-handoff pin when the operation uses them, not a server
registration pin.

Every core and channel server entry accepts those four options and applies them before resolving a context, path,
config, state or secret. CLI-backed registrations place them before the `mcp` subcommand; a server-only wrapper takes
them directly. That includes the separately published Gmail wrapper, whose parser currently starts from raw argv and
whose help points back to a bare Gmail CLI (`packages/gmail-mcp/src/server.ts:13-19`,
`packages/gmail-mcp/src/server.ts:22-41`). An existing registration is not mutated silently: its next approved server
update or install rewrites it with all four pins, and doctor reports a suite registration which lacks the complete
pinned set and offers that approved update/install repair.

These options are flags, not capabilities. They add no row to `capabilities.json`, whose rows describe a CLI command,
MCP tool and shared operation (`capabilities.json:1-2`). The parity check continues to enumerate command paths and
tool names, not global flags (`scripts/parity.mjs:317-333`); its CLI driver must exercise every row once with the path
flags to prove parsing precedes operation dispatch.

The detached update-check re-exec is another CLI handoff. The parent appends its already-resolved canonical directory
options to the hidden command's arguments, and the child applies them before resolving a context, state, configuration
or any other path. It does not reconstruct them from the inherited environment: the current entry retains only Node
flags and the script, and the spawn otherwise passes only the hidden command and claim time
(`packages/core/src/update-check.ts:191-203`, `packages/core/src/update-check.ts:333-345`).

### D3. Keep the existing tested Windows rendering contract

POSIX keeps its single-quote renderer. Windows uses the existing `shellCommand` rules: emit one line only when the
same line delivers the same words through cmd.exe, Windows PowerShell 5.1, PowerShell 7 and `.cmd` re-parsing;
otherwise emit the inert JSON word array plus the instruction to type it with quoting for the person's shell. That
contract already models legacy empty-argument/trailing-backslash behaviour and cmd delayed expansion
(`packages/core/src/cli-runtime.ts:93-121`, `packages/core/test/cli.test.ts:1342-1419`). There are no new
PowerShell- or cmd-specific renderers.

Resolved directory option values have redundant trailing separators removed before rendering (a filesystem root
keeps its root separator). A legal Windows path can still have no common-shell line when it contains `$`, `%`, `!`,
a backtick, a curly double quote, a Unicode control/format character, or an unspaced `&`, `^`, `(` or `)`; the same
refusal covers argument words containing `|`, `<` or `>` in that position. Empty words, words that need quoting
**and** end in `\`, and words containing a straight double quote are also refused; a bare-safe word ending in `\`
(such as `C:\Profiles\`) is printed unquoted, as today (`packages/core/src/cli-runtime.ts:144-150`,
`packages/core/test/cli.test.ts:1384-1386`). The person sees the exact argv as non-runnable JSON and
the manual-typing instruction, not a partial command
(`packages/core/src/cli-runtime.ts:136-191`).

This inert-JSON/manual-entry result is the acceptance criterion's second outcome. It is deliberately preferred to a
wrong-but-runnable line, which could approve, overwrite or remove the wrong thing. For argument words it is rare: only
Windows handoffs with one of the refused word shapes take it; ordinary paths remain pasteable.

**Amendment (build, 2026-10-05): the program word.** The rules above were written for program words such as
`agentcomms`, which never need quotes. Every printed command now starts with `process.execPath`, and a quoted first
word is a string expression to PowerShell, not a command: it runs one only after `&`, which cmd.exe does not accept. So
a Windows command whose program path needs quotes — `C:\Program Files\nodejs\node.exe`, the default Node install —
has no line, and its JSON form says why and names PowerShell's `&`. On a default Windows install this makes the second
outcome the usual one rather than a rare one; installs whose Node path needs no quotes (nvm-windows, Volta, a tool
cache) keep pasteable lines. A form that both shells run with a spaced program path is a renderer change, left to the
D8 follow-up, where a shim on `PATH` removes the problem.

**CUE-410 amendment (2026-10-14): a labelled PowerShell line.** When only the program word prevents the common
cmd.exe/PowerShell form, the renderer may instead prove a PowerShell-only form: the call operator `&`, followed by
every word as a PowerShell single-quoted literal (an inner single quote is doubled). The result explicitly labels the
line “PowerShell”. Empty words, trailing backslashes, double quotes and control or formatting characters are not
proven safe through the native-program boundary and retain the inert JSON form. An unsafe argument beside a common-shell program also
retains inert JSON; this is a narrow fallback for an absolute program such as the default
`C:\Program Files\nodejs\node.exe`, not a general weakening of the common-shell rule.

**Amendment (build, 2026-10-05): a registration from before 0.13.1.** It still starts and finds its folders as it
always did, so the doctor reports it as a warning with the re-register command, not as a failure: a failure would turn
every existing install red on upgrade. An entry that is unpinned *and* cannot start is one failed row naming both
problems, repaired by the one command.

### D4. Packaging follows the runtime edge

Every manifest-discovered **non-core** channel declares `@agentcomms/core` under `dependencies`, never only
`devDependencies`, and the packed package pins core to the channel's exact lockstep version. The workspace source may
use `workspace:*`; the publish/pack result must be the exact version, not a range. Their bundles may still inline core
for startup, but comments may no longer claim that installing a channel has no dependency tree; those claims exist in
every channel bundler config (`packages/gmail/tsdown.config.ts:3-5`,
`packages/slack/tsdown.config.ts:3-5`, `packages/resend/tsdown.config.ts:3-5`,
`packages/whatsapp/tsdown.config.ts:3-6`).

The code change also amends both instructions a future channel follows: the channel-plugins design's “Adding a
channel” package rule, which currently says `workspace:*` **dev** dependency
(`docs/superpowers/specs/2026-09-26-channel-plugins-design.md:203-210`), and `CONTRIBUTING.md`'s matching rule
(`CONTRIBUTING.md:139-145`), will instead require the exact-lockstep runtime dependency above. A registry/package
validation test explicitly excludes the core entry — `readChannels()` returns core first, but core cannot depend on
itself (`scripts/channels.mjs:27-58`) — and fails for any non-core channel if core is absent from `dependencies`, is
also declared in an incompatible dependency field, or packs to anything other than the channel's exact version. The
same test injects a synthetic non-core channel, so the policy cannot pass only because today's four packages are named
in it.

The migration also corrects the governing communications design's claims that npx installs no dependency tree and
Gmail has no runtime dependencies (`docs/superpowers/specs/2026-09-18-agent-communications-design.md:79`,
`docs/superpowers/specs/2026-09-18-agent-communications-design.md:112-116`), plus the matching library-entry comments
for Gmail, Slack and Resend (`packages/gmail/src/index.ts:4-6`, `packages/slack/src/index.ts:4-6`,
`packages/resend/src/index.ts:4-5`). A consistency test holds those instructions and comments to the runtime-edge rule.

`scripts/verify-package.mjs` recursively packs the candidate's transitive workspace `dependencies` and
`optionalDependencies`, deduplicates them, and gives every tarball to the isolated npm install in dependency order.
It currently packs only direct workspace edges (`scripts/verify-package.mjs:96-108`) before the consumer install
(`scripts/verify-package.mjs:135-150`). Thus verifying `gmail-mcp` packs Gmail and Gmail's local core tarball rather
than asking the registry for an unpublished core.

### D5. Every runtime handoff migrates; command-bearing output is branded

The implementation keeps the following table-driven inventory as migration documentation and a review checklist, not
as the completeness mechanism. The audited groups are:

- **Core:** approvals, change flow, save-destination questions, update, policy, attachment, organisation, secrets,
  registration and doctor handoffs (`packages/core/src/changes.ts:73-98`,
  `packages/core/src/changes.ts:265-332`, `packages/core/src/changes.ts:461-465`,
  `packages/core/src/approvals.ts:635-655`, `packages/core/src/approvals.ts:889-897`,
  `packages/core/src/change-flow.ts:272-302`, `packages/core/src/save-destination.ts:648-676`,
  `packages/core/src/save-destination.ts:744-756`, `packages/core/src/update-state.ts:305-347`,
  `packages/core/src/update-gate.ts:340-414`, `packages/core/src/update-check.ts:191-203`,
  `packages/core/src/update-check.ts:333-445`,
  `packages/core/src/operations/update.ts:843-900`, `packages/core/src/render.ts:432-479`,
  `packages/core/src/config.ts:722-1074`,
  `packages/core/src/organisations.ts:243-244`, `packages/core/src/organisations.ts:506`,
  `packages/core/src/organisations.ts:698-718`, `packages/core/src/organisations.ts:870`,
  `packages/core/src/operations/attach-settings.ts:304-348`,
  `packages/core/src/operations/maintenance.ts:143-162`,
  `packages/core/src/operations/maintenance.ts:217-220`,
  `packages/core/src/operations/maintenance.ts:238-265`,
  `packages/core/src/operations/maintenance.ts:327-360`,
  `packages/core/src/operations/organisations.ts:205-407`,
  `packages/core/src/operations/organisations.ts:578-730`,
  `packages/core/src/operations/organisations.ts:1152-1376`,
  `packages/core/src/operations/secrets-migrate.ts:250-376`,
  `packages/core/src/operations/change-policy.ts:135-145`, `packages/core/src/jail.ts:199-205`,
  `packages/core/src/secrets.ts:73-74`, `packages/core/src/channel-words.ts:39-52`,
  `packages/core/src/cli.ts:153-154`, `packages/core/src/cli.ts:285-290`,
  `packages/core/src/cli.ts:456-787`,
  `packages/core/src/cli.ts:863-900`, `packages/core/src/cli.ts:948-950`).
- **Gmail:** send, sign-in, client/inbox/consent repair, setup, doctor and rendering handoffs
  (`packages/gmail/src/operations/send.ts:325-612`, `packages/gmail/src/operations/attachments.ts:374-375`,
  `packages/gmail/src/operations/inboxes.ts:350-370`, `packages/gmail/src/operations/client-choice.ts:95-254`,
  `packages/gmail/src/operations/clients.ts:134-511`, `packages/gmail/src/operations/consent.ts:91-610`,
  `packages/gmail/src/operations/signin.ts:213-681`, `packages/gmail/src/operations/doctor.ts:269-565`,
  `packages/gmail/src/operations/import-legacy.ts:505-539`, `packages/gmail/src/operations/search.ts:296-302`,
  `packages/gmail/src/operations/inbox-names.ts:23`, `packages/gmail/src/auth/flows.ts:101-215`,
  `packages/gmail/src/auth/oauth.ts:101-104`,
  `packages/gmail/src/auth/scopes.ts:85-88`, `packages/gmail/src/auth/session.ts:104-176`,
  `packages/gmail/src/gmail-api/errors.ts:140-156`, `packages/gmail/src/context.ts:89`,
  `packages/gmail/src/cli/tui.ts:64`, `packages/gmail/src/cli/render.ts:48-211`,
  `packages/gmail/src/cli/render.ts:661-927`, `packages/gmail/src/cli/program.ts:388-2422`,
  `packages/gmail/src/mcp/server.ts:160-162`,
  `packages/gmail/src/mcp/server.ts:997`, `packages/gmail/src/mcp/server.ts:1388`,
  `packages/gmail/src/mcp/server.ts:2381-2393`, `packages/gmail/src/mcp/server.ts:2481-2487`).
- **Slack:** post/reaction, workspace, app, manifest, draft, destination, file, auth and doctor handoffs
  (`packages/slack/src/auth/authorize.ts:252-255`, `packages/slack/src/auth/bundle.ts:109-125`,
  `packages/slack/src/auth/flow.ts:208-303`, `packages/slack/src/auth/refresh.ts:168-773`,
  `packages/slack/src/operations/send.ts:169-410`, `packages/slack/src/operations/send.ts:573-605`,
  `packages/slack/src/operations/send.ts:1256`, `packages/slack/src/operations/changes.ts:70-494`,
  `packages/slack/src/operations/changes.ts:692`, `packages/slack/src/operations/workspaces.ts:105-542`,
  `packages/slack/src/operations/signin.ts:120-1064`, `packages/slack/src/operations/mode.ts:68-132`,
  `packages/slack/src/operations/app.ts:266-441`, `packages/slack/src/operations/doctor.ts:138-760`,
  `packages/slack/src/compose/drafts.ts:185-274`, `packages/slack/src/operations/drafts.ts:222`,
  `packages/slack/src/operations/destination.ts:20`, `packages/slack/src/operations/files.ts:100`,
  `packages/slack/src/operations/files.ts:428`, `packages/slack/src/operations/session.ts:144`,
  `packages/slack/src/mcp/server.ts:1136-1151`, `packages/slack/src/mcp/server.ts:1318`,
  `packages/slack/src/cli/render.ts:63-598`, `packages/slack/src/cli/program.ts:464-1622`).
- **Resend:** account, send/status, domain/read, scheduled and doctor handoffs
  (`packages/resend/src/accounts.ts:101-167`, `packages/resend/src/api/client.ts:61`,
  `packages/resend/src/context.ts:106`, `packages/resend/src/operations/accounts.ts:178-483`,
  `packages/resend/src/operations/send.ts:100-365`, `packages/resend/src/operations/send.ts:516-565`,
  `packages/resend/src/operations/send.ts:669-675`, `packages/resend/src/operations/read.ts:145-160`,
  `packages/resend/src/operations/doctor.ts:53-58`, `packages/resend/src/operations/doctor.ts:144`,
  `packages/resend/src/cli/render.ts:29`, `packages/resend/src/cli/program.ts:279-770`,
  `packages/resend/src/mcp/server.ts:98`, `packages/resend/src/mcp/server.ts:514`).
- **WhatsApp:** account, sync/index, config, chat-list, approval and permission handoffs
  (`packages/whatsapp/src/operations/accounts.ts:39-133`, `packages/whatsapp/src/config.ts:114-169`,
  `packages/whatsapp/src/index-db.ts:310-322`, `packages/whatsapp/src/operations/chat-lists.ts:99-119`,
  `packages/whatsapp/src/operations/status.ts:144`, `packages/whatsapp/src/operations/sync.ts:25-28`,
  `packages/whatsapp/src/source/snapshot.ts:120-125`, `packages/whatsapp/src/cli/render.ts:73`,
  `packages/whatsapp/src/cli/program.ts:416-621`, `packages/whatsapp/src/mcp/server.ts:70`).

The inventory also includes the core MCP instructions (`packages/core/src/mcp/server.ts:114`) and every MCP tool
description that tells a person what to run. Instructions and descriptions say this generically — for example, "run
the approve command each result gives" — rather than naming a bare CLI.

The search also found incomplete argument-only `shellCommand` values. The fragments at
`packages/core/src/operations/organisations.ts:394`, `packages/core/src/operations/organisations.ts:578-582`,
`packages/gmail/src/operations/clients.ts:353-356` and `packages/core/src/cli.ts:896-903` become prose about options
or words appended to a complete located command; they are never rendered as commands themselves.

`PrintedCommand` is an opaque branded type whose constructor and brand stay private to the locator module. The only
other command type is opaque `ExternalCommand`, made by the reviewed `externalCommand(words, reason)` constructor for
non-suite programs. Its reviewed sites include `chmod`, the install/read-back `claude mcp` and `codex mcp` calls, and
the rival-server `claude mcp remove` / `codex mcp remove` commands
(`packages/gmail/src/operations/doctor.ts:221-227`,
`packages/core/src/operations/maintenance.ts:82-96`, `packages/core/src/mcp-install.ts:808-817`,
`packages/core/src/mcp-install.ts:1215-1222`, `packages/core/src/other-servers.ts:61-72`). The required reason records
why that external executable is legitimate. The constructor refuses a word list when any word contains a manifest
binary, an `@agentcomms/` package specifier, or a path within the realpath of any agent-communications package root.
That rejects direct launches, `node <suite-entry>`, `npx @agentcomms/<product>` and wrapper payloads rather than
checking only word zero. Manifest-binary comparisons in both this constructor and the source check use
case-insensitive executable names on Windows.

Every output variant which tells a person what to run types its command-bearing field — `hint`, `fix`, `nextStep`,
`command`, or any other name found during migration — as `PrintedCommand | ExternalCommand`, never `string`. Prose
around it is a separate prose field or a fixed renderer. `inlineCommand` and `commandText` accept that union. Thus a
typed command-bearing field cannot accept a plain literal, template or argument fragment.

A syntax-tree test scans user-visible strings and templates in runtime source rather than relying on field names. At a
shell-token boundary it rejects a manifest binary appearing alone or followed by any argument, including an option
such as `agent-gmail --help`; it also rejects a manifest-derived binary interpolated into either shape. Direct
`process.stdout`/`process.stderr` and injected-stream writes are sinks alongside result fields, `CommsError` hints,
MCP instructions and tool descriptions. The locator's structured inputs and protocol identities remain non-output
exceptions; negative fixtures cover a newly named result field, bare and option-only binaries, each direct-output
sink, mixed-case Windows names, `node <suite-entry>`, `npx @agentcomms/<product>` and a wrapper payload. The reviewed
external commands, including `other-servers.ts`, are positive fixtures.

The current direct `agent-gmail --help`, `agent-slack --help`, `agent-resend --help` and `agent-whatsapp --help`
handoffs move to located commands (`packages/gmail/src/cli/program.ts:2488`,
`packages/slack/src/cli/program.ts:1631`, `packages/resend/src/cli/program.ts:805`,
`packages/whatsapp/src/cli/program.ts:629`). So does the Gmail wrapper's bare `agent-gmail` handoff
(`packages/gmail-mcp/src/server.ts:31`). Each emits a `PrintedCommand` or the locator's no-command result.

This closes literal and constructor-mediated escapes, not arbitrary program semantics. A command assembled entirely
from variables and routed around both branded constructors has no manifest-binary occurrence for the scan to
recognise; repository review and the inventory above are the remaining control. The design therefore does not claim
that no newly named field can ever bypass the guard.

Protocol identities are outside those types: MCP server names and `package.json` bin names remain ordinary identity
fields and cannot flow into a command-bearing result field without the brand. There is no file allowlist; identity is
excluded by construction, not by filename.

### D6. The guarantee is time-of-print identity, not immutability

For a file launch, the printed command names the installation found at print time and the entry has passed the
realpath/file/containment checks then. It does not make that path durable. A command printed by an npx-launched
process for itself names its entry inside the npx cache; if that cache is evicted before the person runs it, the
command fails cleanly with a missing file. If a global installation or checkout is changed in place,
the command fails cleanly or runs the code then at that path. Approval is data-only, so a newer compatible CLI
approving the stored id is harmless; all normal digest, kind, expiry and policy checks still run.

The command does not neutralise `NODE_OPTIONS`, preloaders, shell functions or later same-user replacement. Those are
inside the person's ambient shell and the documented same-OS-user boundary (`SECURITY.md:51-59`).

No secondary bare-name command is printed. The result may say that an installation changed or disappeared, but it
never silently resolves a different suite binary from `PATH`.

### D7. The 0.13.0 fallback remains explicitly best effort

0.13.0 and affected earlier releases still print bare names and cannot be changed in place. `comms_paths` and
`agentcomms paths` return resolved directories, not the environment or relative values which produced them
(`packages/core/src/operations/maintenance.ts:27-39`). The 0.13.1 troubleshooting guide gives two limited routes:

1. For a **managed** registration, read its absolute Node command and runtime entry and run that entry. The managed
   layout is derived centrally (`packages/core/src/mcp-install.ts:299-320`,
   `packages/core/src/mcp-install.ts:566-580`). This route does not cover global or checkout 0.13.0 installs; those
   users must locate their own Node and package entry.
2. Where npx exists, run the exact package and release which printed the result, never `latest`:
   `npx -y @agentcomms/<product>@0.13.0 …`.

Neither route can reconstruct the original path environment from `comms_paths`. A custom-path user must supply the
known old-release `AGENT_COMMS_*` overrides and quote them for their shell. Skills are installed separately from the
runtime (`docs/superpowers/specs/2026-09-18-agent-communications-design.md:979-984`), npx may be absent, and an old
result may not identify Node. New 0.13.1 results use D1-D3 instead.

### D8. PATH shims stay a follow-up

0.13.1 creates, changes and diagnoses no shim, profile, registry entry or durable shim preference. A later design must
cover ownership/modes/ACLs (including macOS extended ACLs), receipts and startup validation, prune and opt-out,
authoritative data roots, and CLI-MCP parity for the preference.

### D8 amendment — CUE-406 managed-install PATH shims (2026-10-14)

The follow-up is now part of the managed launcher on macOS and Linux. After a managed install or registration update,
core writes the declared package binary's shim — `agentcomms`, `agent-gmail`, `agent-slack`, `agent-resend`,
`agent-whatsapp` or `agent-events` — to `$HOME/.local/bin`. The shim executes the program and managed-runtime entry
returned by D1's locator for that installed product, then forwards the caller's arguments. Updating rewrites that
owned shim to the new runtime.

This release offers no Windows shim. A `.cmd` shim must forward with `%*`, which makes `cmd.exe` parse caller-controlled
words again: an argument such as `x&whoami` can become another command, and `%VAR%` and `^` have the same class of
problem. Managed installs therefore write no shim on Windows. The install result and `doctor` say plainly why, and
continue to provide D1's full-path command (CUE-403) or its labelled PowerShell `&` line (CUE-410).

Ownership is installation-local and content-bound. A receipt under the resolved data root records each shim path and
the SHA-256 of the bytes this installation wrote. Core overwrites or removes a path only while it matches that receipt
and digest; a pre-existing path, a receipt for another path or a file changed since writing is foreign and is never
replaced or deleted. Pruning a runtime removes only matching owned shims that point into that runtime. `doctor`
reports a managed CLI's missing, stale or foreign shim and the repair. Tests use temporary homes and data roots only.

Every shim operation pins the directory before it acts: it resolves `$HOME/.local/bin` to its real directory at the
start, performs every write, rename and deletion within that resolved directory, and immediately before each mutation
refuses without changing anything if the public directory now resolves somewhere else. `$HOME/.local/bin` itself may
normally be a symlink to a real directory; the pinned real directory is what makes that setup safe. The receipt and
digest rule still protects a foreign file within it.

The boundary is the repository's existing same-user boundary. A hostile process running as the same OS user and able
to rewrite the person's home directory is outside this design's protection, as the event design says for its own
boundary (`2026-10-05-local-event-emission-design.md` §7 and `SECURITY.md:51-63`). The real-directory pin prevents an
accidental or concurrent parent-symlink swap from redirecting a later mutation; it is not a defence against a
same-user process with continuing authority to replace both paths and files.

Install results name the shim and say when its directory is absent from `PATH`, with a current-shell command for
prepending it in a POSIX shell. No command edits a shell profile, user environment, registry value or machine-wide
directory. This is a convenience path to the same locator-resolved program and entry; D1 handoffs continue
to locate and pin their installation directly and never trust a bare PATH command.

## 4. Tests

0000. **Round-14 case:** a built `.mjs` caller on Node 22.12–22.17 resolving a cross-product `local` registration with
      only `src/cli.ts` prints a command with `--experimental-strip-types`, and that command runs.
000. **Round-12/13 cases:** same-version npx registrations (including an absolute `npx.cmd`) are never cross-product
     candidates, cache present or absent; a managed Gmail registration whose pinned directories end in
     `@agentcomms/slack`, in both spaced and `--x=value` forms (POSIX and Windows), is recognised as Gmail; a
     managed-shaped hand-written registration and a genuine managed registration with a changed interpreter are both
     used, if at all, only under `process.execPath`, and neither registration command is ever executed (a spy asserts no
     spawn); `process.execPath` below a target's `engines.node` yields no command; `--mcp-approval` is inserted before an
     existing `--`.
00. **Round-11 cases:** a core process with only an npx registration of a channel prints no cross-product command and
    says why, with the npx cache present and evicted and with caller, registration-environment and paste-shell Node
    versions all different; `client add -- --approval` and `-- --approval=x` keep the positional words exactly while the
    generated retry (approval option inserted before `--`) applies the prepared change end to end.
0. **Round-10 cases:** a core process on Node 22.12–22.15 resolving a same-version WhatsApp registration (global and
   managed) prints no command and names Node `>=22.16.0`, whatever interpreter the registration names; raw retry argv containing `-- --config-dir` and `-- --config-dir=value` keeps
   every word after `--` exactly, and a dangling spaced `--config-dir` before `--` yields no command; `C:\Profiles\` is
   printed bare while a quote-requiring word ending in `\` is refused.
1. **Own locator matrix:** installer-written managed, npx and local registrations, plus global and direct-checkout
   installations, on POSIX and Windows; only the two allowed Node flags survive. Checkout fixtures have no `dist`, then
   a stale `dist`, and both select `src/cli.ts`. Gmail's wrapper resolves Gmail. Manifest/bin mismatch, missing,
   unreadable and non-file targets fail with no bare fallback.
2. **Direction, source and version matrix:** channel→core asserts the decision inputs — caller module suffix, real
   caller and core roots, workspace membership, same-checkout identity and versions — as well as the selected path.
   A source caller with sibling workspace core selects `src/cli.ts` with core `dist` absent and stale; a built caller,
   an external installed core and a core in another checkout select the manifest bin. Core→channel and
   channel→another-channel cover only an old registration, mixed old/current registrations, every launcher class and
   deterministic tie-breaks. Windows includes an absolute npm `.cmd` global registration with matching, mismatched and
   unreadable package/version entries. Only the same-version entries yield commands. Older-only, unknown-version,
   unreadable and absent registrations yield no command and name the target product and required exact version as
   “not locatable here”, with the usual-route install/update instruction and no repair or MCP approval route.
   Through D1's scanner, Windows fixtures accept mixed-case executable stems and package-entry path segments; the same
   POSIX fixtures remain case-sensitive.
3. **Paths:** every CLI accepts all five independent global options before dispatch. Execute a handoff in a fresh shell
   with conflicting `AGENT_COMMS_*`, XDG, home/AppData values and another cwd; it reports every printing-process
   **agent-communications** directory the target uses and no other path option. Relative option values become resolved
   absolutes. On Windows set `APPDATA` and `LOCALAPPDATA` to different roots and use the file secret store; a pasted
   secret-reading handoff must use exactly the printing process's `secretsDir`, even with `--config-dir` present.
   Download handoffs preserve `downloadsDir`; non-download handoffs omit it. Runtime/install/prune/update, doctor,
   channels and setup handoffs have explicit suite-directory-use fixtures. Separate client-registration fixtures vary
   `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HOME` and `APPDATA` at execution time and assert that the CLI targets the
   executing person's client files while all five pinned suite directories stay unchanged. No output contains an
   environment assignment. Locator normalization covers duplicate path options in spaced and `=` forms, reversed
   ordering, relative values and a changed cwd, through both registered argv and Gmail's raw retry argv; each used
   directory appears exactly once with its canonical absolute value. A due detached update check started by a
   flag-pinned command under conflicting ambient paths reads and writes only the parent's pinned directories. An
   end-to-end registration test launches installer-written managed, npx and local registrations with custom state and
   data roots and, on Windows, split `APPDATA`/`LOCALAPPDATA` plus the file secret store. Through each running server,
   prepare a harmless change and execute its terminal approval; the server and CLI must use the identical registered
   config, state, data and secrets roots. Every server entry, including `agent-gmail-mcp`, has an option/apply-order
   fixture. Doctor diagnoses an old registration without pins, and its next approved update/install rewrites it.
4. **Rendering:** exercise the existing Windows contract through Windows PowerShell 5.1 and PowerShell 7 against both
   `node.exe` and absolute `npx.cmd`, and through cmd.exe with delayed expansion enabled. Cover empty arguments,
   trailing backslashes, `%`, `!`, directory-separator normalisation and safe lines. A valid Windows path that the
   renderer refuses must produce the exact inert JSON words and manual-entry instruction and satisfy the second
   accepted outcome byte for byte. POSIX quoting remains byte-exact. Shell runs leave sentinel parent/session
   environment variables unchanged, including on failure.
5. **Containment and mutation:** lexical and realpath symlink escapes, root-prefix siblings and post-print replacement.
   Delete the npx cache behind an npx-launched process's own printed command and assert a clean missing-file failure.
   Upgrade a fake global
   install in place and assert the newer fixture runs. A hostile test `NODE_OPTIONS` preloader demonstrates the
   documented same-user boundary without changing path selection.
6. **Packaging and channel policy:** the verifier's transitive closure is deduplicated and ordered. The packed
   `gmail-mcp` consumer is installed with local Gmail and core tarballs in an isolated cache and performs its existing
   handshake without a registry copy of the candidate release. Registry validation excludes core and checks every
   discovered non-core channel, including a synthetic newcomer: core is in runtime `dependencies`, its source
   workspace edge resolves to the same version, and its packed manifest pins exactly that version. Missing, dev-only,
   ranged and mismatched fixtures fail. A consistency fixture checks the governing design, channel instructions and
   Gmail/Slack/Resend library-entry comments against that rule.
7. **Types and construction:** compile-time fixtures reject strings in the known command-bearing fields.
   `externalCommand` negative fixtures cover any word containing a manifest binary or `@agentcomms/` specifier, direct
   and symlinked paths inside a suite package root, `node <suite-entry>`, `npx @agentcomms/<product>` and wrapper
   payloads. The runtime-source scan rejects a literal manifest binary alone or with any following argument, including
   in a newly named result field, `CommsError` hints, MCP instructions, tool descriptions and direct stdout/stderr
   writes; it also rejects a manifest-derived binary interpolation. Per-product fixtures cover a bare binary and an
   option-only command, including each existing `--help` site and the Gmail wrapper, with mixed-case Windows
   executable names. Positive fixtures preserve the locator's own inputs, protocol identities and reviewed external
   commands: `chmod 700`, install/read-back `claude mcp` / `codex mcp`, and `other-servers.ts`'s `claude mcp remove` /
   `codex mcp remove`.
8. **Managed shims:** on POSIX, a normal directory and a `$HOME/.local/bin` symlink both install and update the
   locator-resolved program and entry exactly. Swapping that parent symlink between the check and a write, rename or
   delete is refused with neither the original nor redirected directory changed. A pre-existing or modified foreign
   file is never written or removed. On Windows, install, update, prune and doctor create no shim and explain the
   `.cmd` argument-reparsing reason while preserving the full-path or labelled PowerShell handoff.
9. **End to end:** prepare harmless change approvals through CLI and MCP, execute each own-product or same-version
   cross-product command in a real shell with no suite binary on `PATH`, and observe the same temporary approval store.
   Unlocatable cross-product fixtures assert that no executable words are returned. Run POSIX on POSIX and PowerShell
   plus the available cmd alternative on Windows. No provider transport is called.
10. Run full `pnpm verify`. No test sends email, posts to Slack, calls Resend, uses a real key, writes the real home, or
   contains a real address, token or client secret.

## 5. Departure from the ticket

CUE-403's title asks for CLIs on `PATH`. 0.13.1 instead fixed the blocking handoff with commands tied to the
installation available at print time and with explicit path options. The CUE-406 amendment to D8 now adds owned
managed-install shims without changing that handoff trust boundary. The original D3 amendment made Windows handoffs
under `C:\Program Files` words to type; the CUE-410 amendment above supersedes that outcome with a labelled
PowerShell line wherever its stricter renderer proves one.
