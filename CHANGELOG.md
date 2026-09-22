# Changelog

All notable changes to this project are recorded here, newest first. Every package in this repository is released
together under one version.

## Unreleased

**Accounts are named `organisation/platform` now, and `agentcomms names migrate` renames yours.** A mailbox is
`cue/gmail`, a second one for the same organisation is `cue/gmail-tech`, a Slack workspace is `cue/slack`. The
command shows the whole mapping before it touches anything — `--dry-run` shows it and stops — proposes
`<old name>/<platform>` for each account, takes `--rename old=new` for the ones you want to name yourself, and
lists every problem at once rather than one per run. It needs `--yes`, or a person at a terminal to answer.

Afterwards the old names stop working, and anything that uses one is told what it is called now rather than that
it does not exist. That refusal is permanent: a name that was replaced can never be given to another account,
because the two would be impossible to tell apart later.

**A new config is created in the new format.** Connecting a first mailbox now asks for a name like `acme/gmail`;
`work` is refused, with an example. An existing config stays exactly as it is until you migrate it — no command
changes a config's version except the migration.

**Before you migrate, every program that shares the config must be on 0.2.0 or later** — the release that could
read this format without writing it. An older one refuses the file outright, and one config is shared by
everything on a machine.

## 0.2.0

**This release can read the next config format, and never writes it.** Accounts are about to be named
`organisation/platform` — `cue/gmail`, `cue/slack`, `wf/gmail-tech` — in version 2 of the config file, which
also remembers the names it replaced, so an old name is refused with the new one rather than reported as unknown.
Nothing creates or migrates to version 2 yet. It arrives in two steps on purpose: first a release that can read
it, installed everywhere, and only then one that writes it. An older release refuses a version-2 file outright,
and one config file is shared by everything on a machine — an MCP server started last week reads the file a CLI
updated today.

**Every Gmail command understands organisation/platform names**, ready for the release that introduces them: a
mailbox called `acme/gmail` reads, searches, drafts, downloads into `downloads/acme/gmail/`, and is named in
`doctor`. A name that was replaced is refused with the one it is called now, wherever a mailbox name is typed —
including `mcp install --inbox`, which now checks the name even with `--no-verify`.

**Removing, re-authorising and adding a mailbox no longer strand or lose a token.** A config write can fail
*after* it has been written, when the lock around it cannot be released, and three paths assumed otherwise:
removal skipped deleting a token nothing referenced any more; adding deleted the token of a mailbox that had in
fact been connected, and swallowed a failed deletion without saying so; and a re-authorisation racing a removal
could write the removed mailbox's token back. Each now reads the config again and acts on what it finds, keeps a
token when nobody can tell, and names any reference it could not clean up. Removal and re-authorisation now hold
the same lock as `secrets migrate`. `doctor` checks every recorded leftover token against the config before
suggesting it be deleted, so it can no longer advise deleting a mailbox's live credential.

**`inbox import --rename <legacy-name>=<name>`** imports a mailbox under a name of your choosing, and every bad name
is reported together before anything is written. An import under a client name another Google project already
uses is refused rather than overwriting that project's secret.

**Registering an OAuth client is now as careful as connecting a mailbox.** `client add` and `client remove` hold
the same lock as everything else that touches stored credentials, so an import and a `client add` racing for one
name can no longer overwrite each other's secret; a replacement is refused once mailboxes depend on the client;
and a write that did not land puts the secret store back exactly as it was. Where an outcome cannot be confirmed —
a keychain that timed out and then refuses to answer — nothing is undone and what is unknown is said, with the
reference and the command to run.

**Writing rules follow a mailbox that is renamed.** A per-mailbox writing profile lives in a file named after the
mailbox, so a rename would have left the rules you wrote behind. They keep applying until you write new ones, and
`doctor` mentions downloads still sitting under a former name without moving anything.

**The generated CLI reference is right again.** It is built from the real `--help` output, and long descriptions
wrap — which the generator read as new rows, inventing commands such as `agent-gmail draft would` and cutting
option defaults in half. It now joins them back together.

**The page at the end of a sign-in now says what it was for.** It read "Signed in — you can close this tab" and
nothing else, so connecting six mailboxes in a row showed the same six words six times, with no way to tell which
one you had just approved. It now carries the package's name, the mailbox being connected, the address the flow
requires it to be, and the access that was asked for.

What it deliberately does *not* say is "signed in as \<address\>". That page is served the moment Google
redirects, before the authorization code has been exchanged for anything, so the account that was actually granted
is not known at that point — and a person can pick a different one on the consent screen, which is the whole
reason `--email` exists. So it says what was asked for, says plainly that nothing is stored yet, and says that a
different account will be refused. The terminal or the agent names the account once it knows.

A request that arrives without the expected `state` — a stray tab, another process finding an open port — is told
none of it.

## 0.1.4

**Setting this up was a diagnostic, and now it is a command.** The first thing a new install told you to do was
run `doctor` — which answers "what is broken" for a setup that used to work, and so handed somebody with an empty
machine a repair instruction naming a downloaded file they did not have and could not get without leaving the
terminal. Repair notes, given to somebody who had not built the thing yet.

`agent-gmail setup` inverts it. It reports what is **next**, not what is wrong, and an empty machine is the
expected starting state rather than a fault. It walks the five Google Cloud screens with a direct link to each
and says what to type in every field — including the two where the wrong answer looks more correct than the right
one: a "Web application" client reads as the modern choice and is refused, and leaving the app in Testing reads as
the cautious one and stops every sign-in working seven days later.

It runs the same way whoever is driving. At a terminal it draws a list you move through with the cursor keys;
behind `--no-tui` it asks the same questions one line at a time; and where nobody can answer one — `--json`,
`--no-input`, CI, or either end of the pipe redirected — it asks nothing and acts on the flags it was given.
Every prompt goes to stderr, so the document `--json` puts on stdout stays parseable.

**An agent can now drive all of it except the grant itself.** `setup --client-json <path> --inbox work
--mcp-client claude-code --json` runs each step that has what it needs and stops at the first that does not,
naming the flag that would have let it continue. The one step it does not finish is the grant: it produces the
sign-in link and the command that completes it, and hands both back, because it does not drive browsers.

**And the same onboarding is available over MCP**, so an agent asked to "set up Gmail" is no longer reduced to
telling you to go and run a CLI. `gmail_setup` says what is missing and changes nothing. `gmail_inbox_add`
produces the sign-in link and stops. `gmail_inbox_finish` completes the sign-in once Google has returned a grant for it.

This is a deliberate exception to a rule this project had: no MCP tool adds an inbox. The rule was written before
there was any way to do this from a conversation, and the cost was paid by everyone. What the exception buys is
bounded, and the code enforces the bounds: a `--read-only` server does not offer the two writers at all; a server
pinned with `--inbox <alias>` does not either, and its `gmail_setup` reports only that mailbox, only the client
behind it, and no file paths; neither tool changes a policy or a tier; and there is still no MCP tool that
registers an OAuth client.

**The guarantee, stated at its real width.** This code cannot mint a credential for itself — the token comes from
Google, to whoever is signed in at that browser, after Google's own consent screen. It is *not* a human-presence
check, and nothing here enforces one: an agent already driving an authenticated browser can click through the
consent screen itself. That is outside the threat model on purpose, because such an agent is holding a logged-in
Gmail session and can already read and send through it directly. If your threat model includes that, run the
server `--read-only` or pinned and add mailboxes from the CLI.

### Fixes

- **Connecting one mailbox closed the door on the rest.** `setup` treated "a mailbox" as a step in a sequence, so
  the first one marked it done for good and a second run skipped past it — wrong for a tool whose whole shape is
  many mailboxes at once. It now asks whether to connect another, and a setup that is already complete offers
  what somebody running it again actually wants.
- **`setup` offered the wrong file.** It sorted `client_secret*.json` by date without ever opening one, so it
  suggested a *Web application* client — refused a moment later, correctly, with a complaint about a type the
  person never chose. Files are read rather than guessed at from their names, Desktop sorts first whatever the
  dates say, and every candidate is listed with its kind and when it was downloaded, because three files named
  `client_secret_<digits>.apps.googleusercontent.com.json` cannot be told apart any other way.
- **A client file is now read once, through one handle, with a ceiling.** `stat(path)` then `readFile(path)`
  describes whatever that name pointed at each time, and what this reads is a client secret. Both readers — the
  download scan and `client add` — go through one bounded open that refuses a symlink, refuses anything that is
  not a regular file, does not block on a FIFO, and stops at 64KB. `agent-gmail client add /dev/zero` used to
  read until the process died, and `setup --client-json` reaches the same code.
- **The symlink refusal did nothing on Windows.** `O_NOFOLLOW` has no Windows equivalent, so the guard was
  silently absent on one of the three platforms this ships to. It is now enforced everywhere.
- **`setup` could not finish on a machine without a keychain.** `client add` defaults to the system keychain,
  probes it, and on a headless Linux box or a container tells you to run the command again with `--store file` —
  a flag `setup` did not accept. Correct advice, impossible to follow, in the one command that exists to be where
  a new install starts. `setup` now takes `--store`, `--move` and `--launcher`, the same three `client add` and
  `mcp install` have, and reports which store the secret actually went to rather than always claiming the
  keychain.
- **A prerelease would have become `latest`.** npm moves `latest` on every publish that does not name another tag,
  so a `v0.1.4-rc.1` tag would have made a release candidate the version `npm i @agentcomms/gmail` installs, for
  everybody, immediately. The release workflow reads the tag and passes `--tag next` for any version with a hyphen
  in it.

## 0.1.3

**The setup guide broke every new install after seven days.** It told you to add yourself as a *test user* and
said a test user could use the app indefinitely. Google's own documentation says the opposite: authorizations by
a test user expire seven days from consent, and the refresh token with them. Anyone who followed the guide had
every mailbox stop working after a week with `invalid_grant`, and the troubleshooting page listed four causes of
a dead refresh token without mentioning the one that would actually hit them.

The guide now says to publish the app — *Audience → Publish app*, status **In production** — and says why, and
what it costs: one unverified-app warning screen, and a ceiling of 100 accounts that will not matter for personal
use. Troubleshooting names the seven-day expiry as the first thing to check.

Every console screen the guide named had also moved. Google reorganised in 2025: *APIs & Services → OAuth consent
screen* and *Credentials* are now **Google Auth Platform**, with Branding, Audience and Clients. Every step is a
direct link to the page it means.

### Two bugs that predate this release

**Codex registrations have never carried their environment.** `codex mcp add` takes a repeatable `--env`; this
package never passed it. Every codex entry it has written is missing `AGENT_COMMS_CONFIG_DIR` and `PATH` — latent
while the configuration sits in the default place, and a server that starts and finds no mailboxes as soon as it
does not. Fixed, along with reading `env` back from codex's TOML in both spellings.

**`mcp install` does not work on Windows, and is not fixed here.** Claude Code and Codex install there as `.cmd`
files, and this package launches them without a shell, which current Node refuses to do for a `.cmd`. It appears
never to have worked. Doing it correctly means going through `cmd.exe` and hand-escaping an argument that is a
JSON document full of quotes — not work to do from a machine that cannot run Windows, and a subtle mistake writes
a malformed entry into a client's configuration. Documented instead: `agent-gmail mcp install --print` writes
nothing and prints the exact entry to paste, `env` block included.

### Upgrading

`mcp install` pins an exact version into the entry it registers, so that upgrading the package elsewhere cannot
change what your agents run underneath you. The cost is that a new release reaches an already-registered client
only when you re-register, and nothing said so — which is how an install can sit two versions behind while the bug
it is hitting is one you fixed.

```bash
npx -y @agentcomms/gmail@latest mcp install --client claude-code --force
```

`--force` is new and required, because the client CLIs refuse to overwrite an existing entry. It captures what is
registered before removing it and puts it back if the replacement fails; if the restore fails too it says so
rather than claiming otherwise. `agent-gmail doctor` now warns when what is registered is older than what you have
— for npx-pinned and managed installs alike — and its repair command preserves the name, mailbox, read-only
status and launcher of the entry it is repairing rather than replacing them with defaults.

### Also

- **The README no longer implies one send guarantee.** `read` is enforced by Google — that token cannot send.
  `draft` and `organize` are enforced only by this software, because `gmail.compose` and `gmail.modify` both
  permit `drafts.send`. Both are real; they are not the same thing, and you can now tell which you have.
- **Install is organised by which of three routes you are on.** Two involve no Google Cloud work at all: a
  Workspace admin registers one *Internal* client for everyone, and a migration reuses the client it already has.
  One client authorises many mailboxes and many people; nothing said so.
- `inbox add --start` no longer hangs when piped. The detached listener inherited stderr and held it open for as
  long as it waited for a browser, so `... --start | tee setup.log` hung on a command that had already printed
  everything and exited.
- `inbox import` cannot bring a permission the other server never asked for, which is why imported mailboxes
  report `openid` and `userinfo.email` missing. `reauth` takes them, keeping the existing tier.
- Why this is not IMAP with an app password: an app password cannot be scoped, so the `read` tier could not
  exist, and it cannot be revoked per application.

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
