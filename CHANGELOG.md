# Changelog

All notable changes to this project are recorded here, newest first. Every package in this repository is released
together under one version.

## Unreleased

## 0.1.2

**`agent-gmail doctor` now exits non-zero when something is broken.** It printed "1 broken" and exited `0`, so
anything gating on it — a setup script, CI, a shell `&&` — read a broken install as a healthy one. It now exits
`78`, the documented code for a configuration problem, and `agentcomms doctor` has always behaved that way, so the
two halves of the product no longer disagree about the same word.

Warnings are not failures: a setup with six things to look at and nothing broken still exits `0`.

If you script around `doctor` and relied on it always succeeding, this will change behaviour — which is the point.

### Documentation

Seven pages, at [`docs/`](https://github.com/crissmoldovan/agent-communications/tree/main/docs):

- **[Getting started](https://github.com/crissmoldovan/agent-communications/blob/main/docs/getting-started.md)** —
  nothing to reading mail, including the Google Cloud part, and the import path if you already run another Gmail
  MCP server.
- **[What is where](https://github.com/crissmoldovan/agent-communications/blob/main/docs/architecture.md)** — the
  CLI needs no MCP server, no agent and no skills. That was not written down anywhere before.
- **[Sending and approvals](https://github.com/crissmoldovan/agent-communications/blob/main/docs/sending.md)**,
  **[CLI reference](https://github.com/crissmoldovan/agent-communications/blob/main/docs/reference/cli.md)** (23
  commands), **[MCP tools](https://github.com/crissmoldovan/agent-communications/blob/main/docs/reference/mcp-tools.md)**
  (29 tools), **[the skills](https://github.com/crissmoldovan/agent-communications/blob/main/docs/skills.md)**, and
  **[troubleshooting](https://github.com/crissmoldovan/agent-communications/blob/main/docs/troubleshooting.md)** by
  symptom.

The three reference pages are generated from the code and checked by `pnpm verify`, so they cannot describe a
command or a tool that does not exist.

## 0.1.1

**If you followed the migration instructions in 0.1.0, they could not work.** `agent-gmail inbox import` — the
documented route off another Gmail MCP server — skipped every mailbox with "this grant cannot read the mailbox",
on grants that could read perfectly well.

The other server records which permissions it was granted using Google's shorthand, `gmail.readonly`, while
Google's own token responses use the full URL, `https://www.googleapis.com/auth/gmail.readonly`. This package
compared one against the other, matched nothing, and concluded the mailbox had no permissions at all. A real
six-mailbox migration imported none of them. Shorthand is now expanded before anything is compared, and a test
uses the exact shape the other server writes.

Nothing else about your mailboxes changes, and nothing needs re-authorising.

### Under the hood

- **Releases are published by CI now, and carry provenance.** A tag starts the workflow and a named reviewer
  approves the publish, so nothing reaches the registry without a person. npm attests only what a supported CI
  runner published, so **0.1.0 has no provenance and every version from here does**. No credential is stored
  anywhere: the workflow authenticates with a short-lived token minted from its own identity.
- The release script now asks the registry what actually arrived, retrying rather than concluding from one empty
  answer — the first release's check declared a publish that had in fact succeeded a total failure.

## 0.1.0

> **Published under `@agentcomms/*`.** For a few minutes on 19 September 2026 these same packages were
> live as `@cloudpixel/comms-core`, `@cloudpixel/gmail` and `@cloudpixel/gmail-mcp`. Those names were withdrawn
> inside npm's unpublish window, before anything depended on them, because they did not say what they belonged
> to: `@cloudpixel/gmail` reads as a general-purpose Gmail library, not as one provider inside a larger tool — and
> Slack, the next provider, would have arrived as an unrelated-looking `@cloudpixel/slack`. Under one product scope
> the providers are plainly siblings, and the scope matches the `agentcomms` command the core package already
> installs — so what you type to install it is what you type to run it. Install from `@agentcomms/*`; the
> `@cloudpixel` names will not return.

The first release. Email for coding agents, across as many mailboxes as you connect — and an agent cannot send
anything without your approval.

### The send gate

Sending is the one thing here that cannot be undone, and every Gmail permission that lets an agent write a draft
also lets it send one. So "may draft, may not send" is enforced in code rather than by the grant:

- **one path.** `send prepare` reads the draft, refuses it outright if an agent could not have written it, and
  records an approval bound to a digest of everything a recipient would see and to the draft's Gmail message id,
  which changes on every save. `send execute` re-reads the draft, checks it against that record, and calls Gmail
  once — never retried at any layer, because a retried send may deliver twice and nothing here could tell;
- **two guards on that path.** A test fails the build if `transport.sendDraft` is called from anywhere but
  `operations/send.ts`, and the auth client refuses any request to a path ending in `/send` that is not inside that
  one call — so a `messages.send` added anywhere in the package fails at the request rather than at review;
- **three policies per mailbox.** `chat` (the default) needs your yes in the conversation, and the guarantee is
  stated narrowly because the server cannot see that conversation. `confirm` needs a code typed at a terminal, or
  into a form from a client that has proved its forms reach a person. `never` means the draft waits in Gmail;
- **risk escalation** raises a `chat` send to `confirm` by itself when a recipient's address arrived in mail read
  this week and has never been written to, when an attachment is going to a first-time external recipient, or when
  a domain is within two characters of one this mailbox writes to.

### Reading mail safely

Everything a mailbox returns is treated as data. Message bodies arrive inside an untrusted-content envelope with a
per-call random boundary; the sanitiser removes what a human reader would not see — hidden text, off-screen
elements, zero-size fonts, CSS that hides through a stylesheet, an at-rule, a pseudo-class, a percentage opacity
or a `calc()` — and **reports what it removed and what it could not read**, so a message that was trying something
says so rather than arriving clean. Text whose colour merely matches its background is counted and *kept*, because
it may be perfectly visible against a different backdrop; the count says it is worth mentioning, not that the text
was withheld.

### What you get

- `@agentcomms/gmail` — the `agent-gmail` CLI and the library: search across mailboxes, read messages and threads,
  thread timelines, attachments, contacts, follow-ups, export, drafts, labels and the bin;
- `@agentcomms/gmail-mcp` — the MCP server, 29 tools, for Claude Code, Codex, Cursor, Claude Desktop and Gemini CLI;
- `@agentcomms/core` — config, secrets, the approval engine, the sanitiser. Provider-neutral;
- **twelve skills** teaching an agent how to use all of it and where to stop, each with the depth behind it in
  `references/`, sharing one contract;
- a plugin manifest, a Gemini extension, and a launcher that finds Node where Node actually lives.


### How 0.1.0 was built

The two entries below were written during development, one per phase, and are kept as a record of the order
things were built in and why. They describe the repository at the time: their test counts predate the fixes that
landed before release, `comms-core` is what the core package was called then, and "nothing to install yet" was
true when it was written and is not now.

### Phase 2 — signing in, the inbox lifecycle, and both surfaces

**What.** `@agentcomms/gmail` — the `agent-gmail` command and the MCP server — and
`@agentcomms/gmail-mcp`, the server as its own package:

- signing a mailbox in: loopback redirect on 127.0.0.1 with PKCE, and a **two-step flow** (`inbox add --start`
  prints the link and leaves a detached listener; `inbox add --finish` collects the result) because consent takes
  minutes and an agent's shell does not last that long;
- checks that run after consent and before anything is stored: what was actually granted (people can untick boxes),
  and which account it turned out to be — a sign-in as the wrong account, or one that cannot read, writes nothing;
- `client add|list|remove` (Desktop clients only, credentials checked with Google before they are stored),
  `inbox add|list|show|reauth|rename|policy|remove|import`, `whoami`, `doctor`, `mcp`, `mcp install`;
- `inbox import` copies mailboxes out of another Gmail MCP server, and says plainly that while that server is still
  connected an agent can send mail with none of the approval steps here;
- `doctor` checks Node, directory permissions, the secret store, every mailbox's sign-in and permissions — and
  **other Gmail MCP servers registered on this machine**, each with the command that fixes it;
- the MCP server: `gmail_inboxes_list`, `gmail_whoami`, `gmail_doctor`, a tool list that never varies between
  connections, permission checks that re-run on every call, and results carried in both `structuredContent` and one
  text block so every client sees them;
- `mcp install` writes the entry with an absolute interpreter path and an explicit environment (clients start
  servers with a minimal PATH), then starts the server through that exact entry to prove it works;
- settings written by a newer version are preserved rather than dropped when an older one writes the file, so two
  versions sharing a machine cannot silently undo each other;
- on Windows, tokens, approvals and the audit log move out of the roaming profile (`%APPDATA%`) into
  `%LOCALAPPDATA%`, which a domain does not copy between machines.

**Why.** Everything else in this project needs a mailbox connected and a way for an agent to reach it. The parts
that took the most care are the ones that fail quietly: the account you did not mean to authorise, the permission
you did not notice was missing, and the second Gmail server that can send mail without asking.

**Impact.** **Nothing to install yet.** No package is published. Developing in this repository needs Node 22.18 or
newer; the packages themselves will run on 22.12 or newer.
- **Tests:** `pnpm verify` — root 16 (including a guard that mail can leave from exactly one place, in from the
  phase before sending exists), comms-core 138, gmail 54, gmail-mcp 3, and a packed-tarball consumer check per
  package (the MCP one completes a real `initialize` and `tools/list` over stdio).

### Phase 1 — the foundation and the core

**What.** The foundation for 0.1.0: the design (`docs/superpowers/specs/2026-09-18-agent-communications-design.md`)
and the implementation plan, the repository scaffolding (pnpm workspace, TypeScript 7, tsdown, Biome, CI on Linux,
macOS and Windows, security policy, contribution guide, issue forms, Blocks review config), a skill verifier, and
`@agentcomms/core` — the provider-neutral core every other package builds on:

- config with immutable inbox ids, locked writes and user intent kept apart from runtime state;
- one secret backend per config directory: the OS keychain (Linux pinned to Secret Service; a call that an OS
  prompt holds up fails after 12 seconds instead of hanging a background server) or owner-only files;
- the approval engine that will gate every send: records bound to the inbox, the account, the draft's message id
  and a content digest; a compare-and-swap state machine plus an exclusive claim file, so an approval is used at most
  once across processes; any edit to the draft voids it; challenges a human types are stored only as hashes;
- a config store that refuses any change loosening a safety setting unless a person consented at a terminal;
- a shared send ledger for rate caps, single-use plan tokens for bulk changes, and a taint store for recipients
  that appeared only in email content;
- the untrusted-content envelope and an HTML sanitiser that removes what a mail client would not show (and reports
  it), plus a preview renderer that stops a draft from forging the recipient lines a human approves;
- path jails for downloads and attachments; the audit log; the `agentcomms` command.

**Why.** Every Gmail scope that allows drafting also allows sending, so "never send without approval" has to be
enforced in code, in one place, before any Gmail code exists.

**Impact.** **Nothing to install yet.** No package is published. Developing in this repository needs Node 22.18 or
newer; the packages themselves will run on 22.12 or newer.
- **Tests:** `pnpm verify` — root 14 passing, comms-core 164 passing, and a packed-tarball consumer check.
