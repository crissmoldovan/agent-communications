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
packages/core   @agent-communications/core   provider-neutral core (config, secrets, approvals, envelopes)
packages/gmail        @agent-communications/gmail        Gmail provider, CLI (agent-gmail) and MCP server factory
packages/gmail-mcp    @agent-communications/gmail-mcp    the MCP server as its own package (agent-gmail-mcp)
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

## Pull requests

- Keep each pull request focused, and say what changes for the person using it.
- Add tests with the change. The send gate, path jails and untrusted-content handling always need them.
- Update docs and skills when a command, tool or behaviour changes; a test fails when a skill names a tool or command
  that does not exist.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md), never
  in a public issue.

## Releasing

See [`docs/RELEASING.md`](docs/RELEASING.md) — the order, the one-time npm setup, and what the dry run is for.
