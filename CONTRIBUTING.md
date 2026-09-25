# Contributing

Thanks for helping make email safe to hand to an agent.

## Ground rules

- **Never commit real mail.** No real addresses, message bodies, subjects, attachment names, tokens, client secrets
  or `client_secret_*.json` files — not in code, fixtures, docs, issues or screenshots. Fixtures are synthetic and use
  `example.com`, `example.org` or `*.test` addresses. `scripts/verify-skills.mjs` scans the whole tree for likely
  secrets and machine-specific paths, and CI fails on either.
- **Sending is gated in one place.** Only `send.execute` in `packages/gmail` may call Gmail's `drafts.send` or
  `messages.send`, and a test enforces it. A change that adds another path, or weakens the approval checks, needs a
  design discussion in an issue first.
- **Email content is untrusted.** Anything a sender controls reaches the model only inside the untrusted-content
  envelope, after the HTML sanitiser. Keep it that way.

## Layout

```text
packages/core   @agentcomms/core   provider-neutral core (config, secrets, approvals, envelopes)
packages/gmail        @agentcomms/gmail        Gmail provider, CLI (agent-gmail) and MCP server factory
packages/gmail-mcp    @agentcomms/gmail-mcp    the MCP server as its own package (agent-gmail-mcp)
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

`pnpm verify` runs Biome, the type checks, every test suite, the builds and the skill verifier. CI runs the same
command on Linux, macOS and Windows. It must pass before you open a pull request.

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

It also runs both sides of every `both` row, and fails unless each reaches the row's `operation` before any operation
another row names. Nothing real happens: in a process of its own (`scripts/operations.mjs`), with a temporary home,
the file secret store and no network, keychain or child processes, every function a command or a server imports from
an `operations/` module is a stand-in that records the call and does nothing. So a row whose command and tool run
different operations fails, and so does a row that names a helper everything calls; the message says what each side
reached instead. A row may add:

- a list for `operation`, when the command is several operations; each side has to reach all of them. A name is
  looked up in the row's own package, then in the core's — a channel's `mcp install` runs the core's
  `serverInstallChange`.
- `argv` and `args` — words added to the command, arguments given to the tool — when the smallest call does not reach
  the operation. The check already supplies whatever Commander or the tool's schema requires; `argv` is for the rest,
  such as `["--finish", "parity"]` for the half of `inbox add` that finishes a sign-in, or
  `["--client", "claude-code"]` for `mcp install`.
- `via`, naming another row's operation that a side passes through on its way, when the command really does that:
  `setup` reads the state (`setupState`) before it starts a sign-in.
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

## Pull requests

- Keep each pull request focused, and say what changes for the person using it.
- Add tests with the change. The send gate, path jails and untrusted-content handling always need them.
- Update docs and skills when a command, tool or behaviour changes; a test fails when a skill names a tool or command
  that does not exist.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md), never
  in a public issue.

## Releasing

See [`docs/RELEASING.md`](docs/RELEASING.md) — the order, the one-time npm setup, and what the dry run is for.
