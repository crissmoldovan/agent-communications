# agent-communications

Gmail, Slack, Resend and WhatsApp for coding agents. Your agent can search, read, analyse, draft and
organise mail across as many mailboxes as you connect, read Slack workspaces and prepare posts, read a
Resend team's mail and prepare emails, and read the WhatsApp chats on your Mac — and **it cannot send
an email or post a message without your approval, and it cannot send a WhatsApp message at all.**

That last part is the whole design. Every Gmail permission that lets an agent write a draft also
lets it send one, so "may draft, may not send" cannot be enforced by the permission you grant. It is
enforced here instead: there is exactly one code path to Gmail's send endpoints, it runs the
approval checks, and a test fails the build if a second one ever appears. Slack has the same gate:
one path to each way of posting, from the CLI and the MCP server alike, and a workspace connected
read-only holds a token Slack itself will not let post. So has Resend: one path to its send endpoint,
and each email sent once. WhatsApp has no path at all: it reads the file WhatsApp for Mac keeps on
your Mac, has no network client, and a reply is a link you send.

[![npm](https://img.shields.io/npm/v/@agentcomms/gmail?color=1f883d&label=%40agentcomms%2Fgmail)](https://www.npmjs.com/package/@agentcomms/gmail)
[![npm](https://img.shields.io/npm/v/@agentcomms/slack?color=1f883d&label=%40agentcomms%2Fslack)](https://www.npmjs.com/package/@agentcomms/slack)
[![npm](https://img.shields.io/npm/v/@agentcomms/resend?color=1f883d&label=%40agentcomms%2Fresend)](https://www.npmjs.com/package/@agentcomms/resend)
[![npm](https://img.shields.io/npm/v/@agentcomms/whatsapp?color=1f883d&label=%40agentcomms%2Fwhatsapp)](https://www.npmjs.com/package/@agentcomms/whatsapp)
[![provenance](https://img.shields.io/badge/provenance-attested-1f883d)](https://docs.npmjs.com/generating-provenance-statements/)

Published, and every version from 0.1.1 carries an npm provenance attestation — `npm audit signatures`
verifies the tarball you installed was built from this repository by the workflow that published it.

## What you get

Six packages and twenty skills.

- **`@agentcomms/gmail`** — the CLI (`agent-gmail`) and the library. Everything works from a
  terminal, with `--json` for anything that consumes it.
- **`@agentcomms/gmail-mcp`** — the MCP server (`agent-gmail-mcp`), for Claude Code, Codex, Cursor,
  Claude Desktop, Gemini CLI and anything else that speaks MCP.
- **`@agentcomms/slack`** — the Slack CLI (`agent-slack`), its MCP server (`agent-slack mcp`) and the
  library. Reads channels, threads, search, people and files, and posts, reacts, and edits or
  deletes its own messages only with a person's approval of that exact content — in the
  conversation or at their terminal, as the workspace's policy says.
- **`@agentcomms/resend`** — the Resend CLI (`agent-resend`) and its MCP server (`agent-resend mcp`).
  Reads a team's domains, sent and received mail, metrics and suppressions, and sends an email only
  with a person's approval of exactly that email, once.
- **`@agentcomms/whatsapp`** — the WhatsApp CLI (`agent-whatsapp`), its MCP server
  (`agent-whatsapp mcp`) and the library. Read-only, on macOS: lists, reads and searches the chats
  WhatsApp for Mac keeps on the Mac, and drafts replies as links you open and send yourself. No
  network client, no WhatsApp session, nothing that sends.
- **`@agentcomms/core`** — the shared core: config, secrets, the approval engine, the
  sanitiser. Provider-neutral, so every channel shares it. Its `agentcomms` command and MCP
  server (`agentcomms mcp`) install and manage the others, from a terminal or from a chat.
- **Twenty skills** — twelve for Gmail, three for Slack, two for Resend, one for WhatsApp, one that sets it all up and one that updates it — that teach an agent how to use all of it
  well, and where to stop.

## How the send gate works

```
draft ──► send prepare ──► you read the preview ──► send execute ──► sent
             │                                          │
             │ binds an approval to this exact          │ re-reads the draft and refuses
             │ content and this draft version           │ if anything changed
```

Three policies, per mailbox:

| Policy | What it takes to send | Who can do it |
|---|---|---|
| `chat` (default) | You approve the preview in the chat, within ten minutes | You, in the chat |
| `confirm` | You type a code at a terminal, or in a form from a client you chose to trust, within thirty minutes; the agent then has 24 hours to send it | You, outside the agent |
| `never` | Nothing. The draft waits in Gmail | You, in Gmail |

Under `chat` the server cannot see your conversation, so what it guarantees is narrower and it says
so plainly: nothing is sent without a prepare step for **exactly** that content, within ten minutes,
once, with matching recipients and subject, under the rate caps, and audited. Whether the agent
actually showed you the preview — and revoked it when you said no — is between you and your agent,
which is why `confirm` exists. Under `confirm` the agent learns that you approved by waiting
(`gmail_send_wait`), never by asking, and every result says where its approval stands; a send whose
outcome Gmail never answered says so (`SEND_OUTCOME_UNKNOWN`) and is checked in Sent, never repeated. The same goes for
loosening a mailbox: under the default `chat` change policy your yes in the conversation approves it, and the software
cannot tell that yes from the agent's own, so for an agent you are not watching set `agentcomms policy confirm` too.

A `chat` mailbox raises itself to `confirm` on its own when something looks like exfiltration: a
recipient whose address arrived in mail that was read this week and whom you have never written to
(a domain alone never escalates a colleague on your own domain), an attachment going to a first-time
external address, a domain within two characters of one you know. [Sending and approvals](docs/sending.md)
has the whole of it.

## Install

### From a chat: the core server first

One command registers the core server with your agent. Everything after that can be done from the conversation,
except what only you can do: creating the Google Cloud OAuth client and the Slack app, each consent screen, and
restarting the client.

```bash
npx -y @agentcomms/core mcp install --client claude-code   # or codex, cursor, gemini, claude-desktop, vscode
```

At a terminal it shows what it will register and asks you to type `yes`. Restart the client, and ask your agent to
set things up: it can see which servers exist and where each is registered (`comms_channels_available`), register
the Gmail and Slack servers (`comms_server_install`), bring every server to the latest release (`comms_update`),
remove old runtimes (`comms_server_prune`), migrate names or secrets, and show or change the change policy
(`comms_change_policy`). Connecting a mailbox or a workspace still needs you in a browser for the consent screen, and
a server it registers appears only once the client is restarted.

**It keeps itself up to date.** Once a day the machine asks npm whether a newer release is out; when one is, every
server and command stops first — "Hang on a minute, there's an update. Let's update first." — and your agent asks
whether to update now (`comms_update`) or not until tomorrow (`comms_update` with `later`, which you approve). A
command at a terminal asks you there; anywhere else the stop names this installation's own `update` and
`update --later` commands, to run exactly as given (with core installed globally, `agentcomms update` and
`agentcomms update --later` are the same). A server this machine does not register itself — the Claude Code plugin's,
the Gemini extension's — is updated where it was installed. `agentcomms update --auto off` turns the check off for one
machine; `CI`, and `AGENT_COMMS_UPDATE_CHECK=off`, skip it. [Upgrading](docs/upgrading.md#the-daily-check) has the
details.

**Every change is shown to you before it happens.** The tool returns a preview and an approval id. Under the default
`chat` change policy your yes in the conversation approves it; under `confirm` you run, in your own terminal, the
approve command the result gives, and type the code it shows. Run it exactly as given: it names this installation's
own Node and CLI file, with its folders pinned, so it needs nothing on your PATH — and on Windows with Node under
`C:\Program Files` it comes as words to type, each quoted for your shell. `agentcomms policy confirm` (core installed
globally) sets that policy, and moving back to `chat` needs the code too. No tool approves a change, and none applies
a change it did not plan itself.
[Core MCP tool reference](docs/reference/core-mcp-tools.md).

### Or package by package

Three independent things ship besides the core server. Take one, or all of them.

First, the part everyone hits: **Gmail's API only accepts calls from a registered OAuth client.** You can register
one yourself, import the one your existing server used, or add an organisation profile whose client serves your
mailbox. Which route below you take decides how much console work you do.

| You are | What you do | Console work |
|---|---|---|
| **on a Google Workspace domain** | one admin registers **one Internal client** and shares the JSON | once, by one person, ever |
| **migrating from another Gmail MCP server** | `inbox import` reuses the client and tokens you already have | **none** |
| **an individual on consumer Gmail** | register your own client — [10-minute walkthrough](docs/getting-started.md#1-a-google-oauth-client) | once |

One client authorises as many mailboxes and as many people as you like. It is not per-mailbox and
not per-person.

> **If you register your own, set the audience to *In production*, not *Testing*.** A Testing app's
> refresh tokens expire **seven days** after consent, so every mailbox would stop working after a
> week. [Getting started](docs/getting-started.md#1-a-google-oauth-client) explains the setting and
> what it costs (one warning screen; a ceiling of 100 accounts you will never reach).

### A Gmail CLI

No agent, no MCP server, nothing else required.

```bash
npm i -g @agentcomms/gmail
agent-gmail setup            # the console steps, the client, a mailbox, and the agent connection
agent-gmail search 'newer_than:7d' --inbox acme/gmail
```

`setup` is the way in. It walks the five Google Cloud screens with a link to each and says what to type in
every field, finds the client JSON you downloaded, connects the first mailbox, and offers to register the MCP
server — stopping at whatever is already done rather than starting over. Stopped partway, the next run offers to
carry on from the last Google Cloud screen you confirmed, or to use a client file already in your downloads. Run it
again to add another mailbox.

At a terminal it draws a list you move through with the cursor keys; `--no-tui` asks the same questions one
line at a time. Where nobody can answer one — `--json`, `--no-input`, CI, or a redirected stream — it acts on
the flags it was given and names the flag that would have let it go further:

```bash
agent-gmail setup --client-json ~/Downloads/client_secret_*.json \
  --inbox acme/gmail --email you@example.com --mcp-client claude-code --json
```

The one step it cannot finish is the grant itself: it hands back the sign-in link and the command that
completes it, which goes on to register the MCP server when `--mcp-client` came with the mailbox. Registering the
OAuth client and registering the MCP server are each a change you approve: at a terminal you read what it will do
and type `yes`; run by an agent, it stops at that step with the preview and an approval id, and runs again with
`--approval <id>` (the OAuth client) or `--mcp-approval <id>` (the MCP server) once you have agreed. The individual commands it wraps — `client add`, `inbox add`, `mcp install` — are all still there if
you would rather drive them yourself.

24 commands, `--json` on all of them, documented exit codes. [CLI reference](docs/reference/cli.md).

### An MCP server, for agents

```bash
npx -y @agentcomms/gmail mcp install --client claude-code
```

Registering a server hands your agent a new set of tools, so it is a change you approve, the same one the core
server's `comms_server_install` makes: at a terminal it shows what it will register and asks you to type `yes`; an
agent running it gets the preview and an approval id (exit 10), and runs it again with `--approval <id>` once you have
agreed. `--print` and `--client json` only show the entry, and ask nobody.

44 tools over stdio — the same operations the CLI runs. Works with Claude Code, Codex, Cursor, Claude Desktop,
Gemini CLI and anything else that speaks MCP. [MCP tool reference](docs/reference/mcp-tools.md).

**Onboarding works over MCP too**, so an agent asked to "set up Gmail" is not reduced to telling you to go and
run a CLI. `gmail_setup` says what is missing and can add an organisation `profile` through its own approval;
`gmail_client_add` registers the OAuth client
from the path of the JSON you downloaded — the file never passes through the conversation, and no result carries
its secret; `gmail_inbox_add` returns a sign-in link and stops; `gmail_inbox_finish` completes it once Google
returns the grant. A server started `--read-only` does not offer any of the writers, nor does one pinned to a
single mailbox. [Why adding a mailbox from chat is safe](docs/superpowers/specs/2026-09-18-agent-communications-design.md).

**So does managing one — everything the CLI does to an account.** Showing, renaming, re-authorising
(`gmail_inbox_reauth`), importing from another Gmail server (`gmail_inbox_import`), removing (`gmail_inbox_remove`),
setting how sends and changes are approved (`gmail_inbox_policy`), removing an OAuth client (`gmail_client_remove`),
and trusting or no longer trusting a client's approval forms (`gmail_confirm_client_add`,
`gmail_confirm_client_remove`). Each calls the same operation as its command. Anything that loosens a safety setting
or cannot be taken back is a **change approval**, on both surfaces: the tool returns a preview and an approval id
instead of acting, the agent shows you the preview, and the change is made only when it calls again with that id after
your yes. At a terminal you type `yes` to the same preview; an agent running the command gets it with exit 10 and runs
it again with `--approval <id>`. Under the `confirm` change policy (`inbox policy <alias> --change confirm`) you
approve with the approve command the result gives, and a code, instead, and moving a mailbox off `confirm` is itself
approved that way ([the design](docs/superpowers/specs/2026-09-25-cli-mcp-parity-design.md)).

### Slack

```bash
npm i -g @agentcomms/slack
agent-slack manifest --port 51234                          # the Slack app to create, and how
agent-slack workspace add acme/slack --client-id <id> --port 51234
npx -y @agentcomms/slack mcp install --client claude-code  # connect it to your agent; you approve it
```

You bring your own Slack app, made from the manifest this prints, so the scopes are visible before anything is
granted; no client secret is stored anywhere. A workspace connected in the default `read` mode holds a token Slack
itself will not let post. In `send` mode nothing posts without a person's approval of that exact content:
`slack_post_prepare` returns a preview with how many people it would interrupt, and `slack_post_send` posts it after
the person says yes in the conversation under the `chat` policy, or after they approve it at their own terminal under
`confirm` — which any broadcast needs. A post can carry local files from your home folder, as a Gmail draft can: the
preview lists each with its hash, and each is read and checked against that hash again before it is sent. Connecting, widening, re-authorising, removing a workspace and setting its
policies work from chat too: whatever loosens a workspace or removes one is shown as a preview and applied only once
the person approves that change — in the conversation under the `chat` change policy, at their terminal under
`confirm`. 29 tools over stdio, none of which approves.
[Slack CLI reference](docs/reference/slack-cli.md) ·
[Slack MCP tool reference](docs/reference/slack-mcp-tools.md) · [the package](packages/slack/README.md).

### Resend

```bash
npx -y @agentcomms/resend account add acme/resend               # at your terminal: type the key when asked
npx -y @agentcomms/resend mcp install --client claude-code      # connect it to your agent; you approve it
```

One account is one Resend API key for one team, typed by you at a terminal — from a hidden prompt, or
`RESEND_API_KEY` in that terminal — and kept in the system keychain. No tool accepts a key, because a key typed
into a chat stays in its transcript. Your agent can then read the team's domains and their DNS records, what
happened to each sent email, received mail (with Resend's own SPF, DKIM and DMARC results, as untrusted content),
metrics and suppressions. An account in `send` mode sends nothing without your approval of that exact email:
`resend_send_prepare` returns a preview with every recipient, BCC included, the reach and the From domain, and
`resend_send_execute` sends it once after your yes in the conversation under the `chat` policy, or after you approve
it at your own terminal under `confirm` — which anything reaching more than ten people needs. A send whose outcome
is unknown is checked, never repeated.

**Read-only is this software's rule, not the key's.** Resend has no read-only key: a full-access key can also send,
delete domains and create keys, and an account in `read` mode is kept from sending by agent-resend's own code. A
sending-only key can only send, which Resend enforces, and can read nothing. `agent-resend doctor` says which you
have. [Resend CLI reference](docs/reference/resend-cli.md) ·
[Resend MCP tool reference](docs/reference/resend-mcp-tools.md) · [the package](packages/resend/README.md).

### WhatsApp (read-only, on a Mac)

```bash
npm i -g @agentcomms/whatsapp
agent-whatsapp add personal/whatsapp             # names WhatsApp for Mac's store; macOS may ask: choose Allow
agent-whatsapp sync --account personal/whatsapp  # a private copy, checked, indexed, then deleted
agent-whatsapp mcp install --client claude-code --account personal/whatsapp   # you approve it
```

Your agent can list, read and search your chats and draft a reply; the draft is a link that opens WhatsApp with the
text filled in, and **you press send**. Nothing here connects to WhatsApp or anywhere else, and nothing can send —
WhatsApp bans numbers it catches using unofficial clients or automation, so this never logs in as a device; it reads the
file WhatsApp for Mac already keeps on your Mac. Say plainly what that costs: **macOS will ask to let your terminal or
MCP client read WhatsApp's data** (or you grant Full Disk Access, which is much broader); **your messages are copied
into a local index, in plain text**, owner-only, and not protected the way WhatsApp's own folder is; and an agent reads
what other people send you, which you narrow with `agent-whatsapp deny` and `allow`. Adding an account and those lists
are yours, at a terminal — no tool changes them. Needs Node 22.16 or newer. 6 tools, none of which sends.
[WhatsApp CLI reference](docs/reference/whatsapp-cli.md) ·
[WhatsApp MCP tool reference](docs/reference/whatsapp-mcp-tools.md) · [the package](packages/whatsapp/README.md).

### Skills, so an agent uses it well

```bash
npx skills add crissmoldovan/agent-communications --skill '*'
```

Twenty skills, twelve for Gmail, three for Slack, two for Resend, one for WhatsApp, one for setting it all up and one for updating it: which tool to reach for, what a result means, and when to
stop and ask. They work with the MCP server and without it, falling back to the CLI. [The skills](docs/skills.md).

### Already running another Gmail MCP server?

```bash
npx -y @agentcomms/gmail inbox import --dry-run   # what it would bring over
npx -y @agentcomms/gmail inbox import             # do it, once you approve what it lists
```

Reuses the OAuth client and refresh tokens you already have. No browser, no re-consent. The import is a change you
approve: at a terminal you type `yes` to what it lists; run by an agent, it exits `10` with the preview and an
approval id, and runs again with `--approval <id>` after your yes.

`agent-gmail doctor` checks everything that has to work and prints the commands or actions that fix each thing that
does not. When a repair needs several commands, it prints them one per line. It exits `78` when something is broken,
so CI can gate on it.

### Upgrading

`mcp install` pins the exact version into the entry it registers, so upgrading the package elsewhere
on your machine cannot change what your agents run underneath you. The cost is that a new release
reaches an already-registered client only when you re-register it:

```bash
npx -y @agentcomms/gmail@latest mcp install --client claude-code --force
npx -y @agentcomms/slack@latest mcp install --client claude-code --force
npx -y @agentcomms/resend@latest mcp install --client claude-code --force
npx -y @agentcomms/whatsapp@latest mcp install --client claude-code --force   # keeps the account it is pinned to
npx -y @agentcomms/core@latest mcp install --client claude-code --force   # the core server, if you use it
```

Each is a change you approve: at a terminal, type `yes` to what it shows; run by an agent, it exits 10 with the
preview and an approval id, and the same command with `--approval <id>` registers it once you have agreed. From a
chat, `comms_server_install` with `force` registers the version of the core server that is running, so it cannot
upgrade anything past that core. Upgrade the core first at a terminal (the last command above), restart the
client, and then it can bring every channel to the same release. An approval from either surface is good on the
other for the same registration.

`--force` is required because the client CLIs refuse to overwrite an existing entry. It keeps the
pin (`--inbox`, `--workspace`, `--account`) and `--read-only` of the entry it replaces unless you pass others, and
says so, so an upgrade never widens what the server may reach. Restart the client afterwards.
`agent-gmail doctor` warns when the registered Gmail server is older than what you have.

Coming from an older release, or bringing another computer up to date — the rename to
organisation/platform names, both MCP servers, and a prompt an agent there can follow:
[Upgrading](docs/upgrading.md). From 0.14.0 the shared configuration moves to version 3, which 0.13
cannot read: restart every client after updating, so no server is left on 0.13.

> **Remove the other Gmail server once you have migrated.** Everything here assumes it owns the only route to
> Gmail's send endpoints. A second server with an ungated `send_email` tool does not break that guarantee so much
> as stand beside it — an agent simply uses the other one, and no approval is asked for. `doctor` lists any it
> finds.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | nothing to reading mail, including the Google Cloud part |
| [What is where](docs/architecture.md) | CLI, MCP server, library, skills — and why the CLI needs none of the others |
| [Sending and approvals](docs/sending.md) | how the gate works, and what it does not cover |
| [CLI reference](docs/reference/cli.md) · [Slack](docs/reference/slack-cli.md) · [Resend](docs/reference/resend-cli.md) · [WhatsApp](docs/reference/whatsapp-cli.md) | every command, option and exit code |
| [MCP tool reference](docs/reference/mcp-tools.md) · [Slack](docs/reference/slack-mcp-tools.md) · [Resend](docs/reference/resend-mcp-tools.md) · [WhatsApp](docs/reference/whatsapp-mcp-tools.md) · [Core](docs/reference/core-mcp-tools.md) | every tool and argument |
| [The skills](docs/skills.md) | what each is for, and when it fires |
| [Troubleshooting](docs/troubleshooting.md) | by symptom |
| [Upgrading](docs/upgrading.md) | from any earlier release, and on each of your other computers |
| [Releasing](docs/RELEASING.md) | for maintainers |

The reference pages are generated from the code by `pnpm sync:reference` and checked by `pnpm verify`, so they
cannot drift from what the software does.

## The skills

<!-- generated by scripts/sync-skills.mjs — edit the skills, not this table -->
| Skill | What it is for |
|---|---|
| [`comms-onboarding`](skills/comms-onboarding/SKILL.md) | Set a person up with agent-communications from chat: which channels and accounts, which mode each account should have, the servers registered, every sign-in started, and the steps only they can take named. Symptoms: 'set up my email and Slack', 'install agent-communications', 'connect Gmail and Slack to Claude', 'onboard me', 'set this up on my other computer'. Not for one account's settings once it works — gmail-setup and slack-setup do those. |
| [`comms-update`](skills/comms-update/SKILL.md) | Bring agent-communications on this computer up to the latest release from chat: see what is behind, update the servers, their runtimes and any global commands in one approved step, then restart and clear out the old versions. Symptoms: 'update my comms', 'update agentcomms', 'upgrade Gmail and Slack', 'is there a new version', 'my Gmail tools are out of date', a tool answering 'Hang on a minute, there's an update. Let's update first.' (UPDATE_REQUIRED), 'not now', 'stop asking me to update'. Not for first-time setup — comms-onboarding does that — nor for one account's settings. |
| [`gmail-attachments`](skills/gmail-attachments/SKILL.md) | Find files people sent, save them where the person says — Downloads, the current folder, or a folder they name — and attach a local file to a draft. Symptoms: 'find the invoice Sam sent', 'download the attachments from that thread', 'save those PDFs', 'attach the contract to that draft', 'why won't it attach that file'. Not for writing or sending the message — gmail-compose writes drafts and gmail-send sends them. |
| [`gmail-compose`](skills/gmail-compose/SKILL.md) | Write a message into Gmail Drafts — new, reply, reply-all or forward — and hand the draft id to gmail-send. Symptoms: 'draft a reply to Sam', 'write back to that email', 'forward this to accounts', 'make that draft shorter'. Not for sending — gmail-send does that. |
| [`gmail-contacts`](skills/gmail-contacts/SKILL.md) | Find somebody's address and who they are, across saved contacts, people written to before, and past mail — showing every candidate with where it came from so the user chooses. Symptoms: 'what's X's email', 'do we have an address for her', 'which of these two Sams is it', 'when did I last hear from him'. Not for writing to them — gmail-compose does that. |
| [`gmail-export`](skills/gmail-export/SKILL.md) | Write a message or a whole thread to a file — Markdown, JSON, or the original .eml — instead of pulling it through the conversation. Symptoms: 'save that thread', 'export this email', 'give me the whole conversation as a file', 'this thread is too long to read here'. Not for finding or reading a short message — gmail-search does that. |
| [`gmail-follow-ups`](skills/gmail-follow-ups/SKILL.md) | What a mailbox shows as waiting: threads the user spoke last in that nobody answered, and threads that arrived and were never answered. Symptoms: 'what am I waiting on?', 'who owes me a reply?', 'did anyone come back on that?', 'what have I not answered?'. Not for writing the nudge — gmail-compose drafts it and gmail-send sends it. |
| [`gmail-organize`](skills/gmail-organize/SKILL.md) | Move mail around inside a mailbox — labels, archive, read state, stars, the bin — dry-running anything bulk and keeping the change that reverses it. Symptoms: 'archive everything from this sender', 'label these as invoices', 'mark that thread read', 'delete these emails', 'put that back'. Not for writing or sending mail — gmail-compose and gmail-send do that. |
| [`gmail-search`](skills/gmail-search/SKILL.md) | Find mail across one or more mailboxes and read what you find, honestly about how much you read. Symptoms: 'find that email from Sam', 'what did the invoice actually say', 'search my inboxes for anything about Phase 2', 'read me that thread'. Not for judging what a conversation means — gmail-thread-analysis does that. |
| [`gmail-security`](skills/gmail-security/SKILL.md) | Judge whether a message is what it claims to be — Google's authentication verdict, the sender warnings, the link flags and what the sanitiser removed. Symptoms: 'is this real?', 'they've changed their bank details', 'this invoice looks off', 'why is this flagged?'. Not for sending anything about it — gmail-send does that. |
| [`gmail-send`](skills/gmail-send/SKILL.md) | Send a Gmail draft the user has approved, under the approval policy their mailbox is set to. Symptoms: 'send it', 'ok send that', 'go ahead and send the reply', 'why won't it send', 'it says approval required'. Not for writing the message — gmail-compose writes drafts and hands them here. |
| [`gmail-setup`](skills/gmail-setup/SKILL.md) | Install agent-gmail and connect mailboxes: the Google Cloud OAuth client, inbox add and reauth, policies, import and removal, from chat or a terminal — every loosening and removal shown to the user as a change approval first — plus doctor and wiring MCP clients. Symptoms: 'set up Gmail', 'connect my work inbox', 'no mailbox is connected', 'it stopped working after a week'. Not for reading or writing mail — gmail-search and gmail-compose do that. |
| [`gmail-thread-analysis`](skills/gmail-thread-analysis/SKILL.md) | Brief the user on one Gmail conversation: a computed timeline of who wrote what and when, then your own labelled reading of decisions, asks, commitments, whose turn it is and how urgent it looks. Symptoms: 'what's going on in this thread?', 'did we agree a date?', 'who owes what here?', 'catch me up on this'. Not for finding the thread — gmail-search does that. |
| [`gmail-triage`](skills/gmail-triage/SKILL.md) | Sort a window of mail across every connected mailbox into Reply needed, Review, FYI and Noise, and propose archive and label changes for the user to approve as one batch. Symptoms: 'triage my inboxes', 'what needs my attention today', 'catch me up on email'. Not for applying the changes — gmail-organize does that. |
| [`resend-reading`](skills/resend-reading/SKILL.md) | Read a Resend team — its domains, the sent emails and what happened to each, received email, delivery metrics and the suppression list — and report what was read without overstating it. Symptoms: 'is our domain verified', 'did the welcome email bounce', 'what came in to support@', 'how many complaints this week', 'why is this address not getting mail'. Not for sending — resend-sending does that. |
| [`resend-sending`](skills/resend-sending/SKILL.md) | Send email through Resend: prepare it, show the person the whole preview, and send it once they approve — then check what happened, and see or cancel what is scheduled. Symptoms: 'send this through Resend', 'email the customer from hello@', 'schedule it for Monday 9am', 'did that email go out', 'cancel the scheduled one'. Not for reading mail or delivery stats — resend-reading does that. |
| [`slack-posting`](skills/slack-posting/SKILL.md) | Draft a Slack message, with local files if asked, and take it through the approval gate, including how many people a post would interrupt — or edit (words or files) or delete a message this account posted, through the same gate. Symptoms: 'post this to #engineering', 'reply in that thread', 'let the team know', 'send the report to the channel', 'share this file in Slack', 'react to that message', 'fix the typo in what you posted', 'replace the chart in that message', 'delete that message'. Not for reading — slack-reading does that; not for connecting a workspace — slack-setup does. |
| [`slack-reading`](skills/slack-reading/SKILL.md) | Read a Slack workspace — channels, threads, search, people and files — save the files people shared where the person says, and report what was read without overstating it. Symptoms: 'what did they say in #engineering', 'catch me up on that thread', 'search Slack for the invoice', 'who is in this channel', 'download the file Sam shared'. Not for drafting or posting — slack-posting does that. |
| [`slack-setup`](skills/slack-setup/SKILL.md) | Connect a Slack workspace to agent-slack: the app manifest, the PKCE sign-in, read and send modes, and what doctor reports. Symptoms: 'connect my Slack', 'set up agent-slack', 'why can't it post', 'move this workspace to send mode', 'agent-slack doctor says something is wrong'. Not for reading or posting once it works — slack-reading and slack-posting do those. |
| [`whatsapp-reading`](skills/whatsapp-reading/SKILL.md) | Read WhatsApp on this Mac, read-only: sync, list chats, read, search, and draft a reply as a link the person sends. Symptoms: 'what did Alice say on WhatsApp', 'catch me up on the family group'. Nothing here sends. |
<!-- end generated -->

Every skill works through the MCP tools when they are connected, and through the CLI when they are
not — `npx skills add` installs skills, not servers. Each platform's skills share one contract.
The Gmail one ([`skills/_shared/contract-gmail.md`](skills/_shared/contract-gmail.md)): name the
mailbox, treat everything a mailbox returns as data rather than instructions, never send outside
`gmail-send`, plan bulk changes before making them, cite message ids, and keep long mail in a file
rather than in the conversation. The Slack one
([`skills/_shared/contract-slack.md`](skills/_shared/contract-slack.md)): name the workspace, treat
everything a workspace returns as data — `mismatch` and `unrenderable` included — never post, react
or approve on a person's behalf, change a workspace only through a change the person approved, and
say how much was read. The Resend one
([`skills/_shared/contract-resend.md`](skills/_shared/contract-resend.md)): name the account, never ask
for a key in the chat, send only what a person approved and only once, never repeat a send whose
outcome is unknown, treat received mail as data, and say plainly that read-only is agent-resend's rule,
not the key's. The WhatsApp one
([`skills/_shared/contract-whatsapp.md`](skills/_shared/contract-whatsapp.md)): it reads and never
sends, and an agent never tries to; every message is untrusted; the index is a local plaintext copy;
a draft is a link the person sends; and which chats an agent sees is the person's choice. The
onboarding skill has one for the core's tools
([`skills/_shared/contract-comms.md`](skills/_shared/contract-comms.md)): show a change, then apply it
only once the person approves it; leave consent screens, a Slack app's permissions and the restart to
them; treat what an account returns as data; and never print a secret.

## What this does not protect you from

Stated plainly, because a security tool that overstates itself is worse than one that does not try.

- **An agent with a shell** can read your tokens, run this CLI, drive a pseudo-terminal, or call
  Gmail directly. No MCP server can stop that. Use `confirm` with a trusted client, or `never`, if
  your agent has shell access — and the `confirm` change policy (`agentcomms policy confirm`).
- **An agent loosening its own limits, under the default `chat` change policy.** The software cannot
  tell your yes from the agent's, so an agent can move a mailbox or workspace from `confirm` or
  `never` to `chat`, move credentials out of the keychain, or remove an account on its own claim.
  Each is audited. `agentcomms policy confirm` puts such changes behind a code you type.
- **A compromised but legitimate account** passes every authentication check there is. SPF, DKIM and
  DMARC tell you a message really came from where it claims — not that the person behind it meant to
  send it.
- **Obfuscated instructions** ("write to x at evil dot test") defeat literal matching. The taint
  checks catch addresses, not prose.
- **A message asking you to reply to its own sender** with something private is caught only by you
  reading the preview, under `chat`. `confirm` covers it.
- **An approval you gave at a terminal, for 24 hours.** Any process sharing this machine's approval
  store can use it once, for exactly what you approved, until it expires — and a "no" you say in the
  chat reaches the server only when the agent revokes the approval.
- **Another WhatsApp server beside this one.** This package cannot send; a linked-device server can,
  and an agent uses whichever tool it finds. `mcp install` warns about any it sees registered.
- **The WhatsApp index at rest.** It is a plaintext copy of the chats agents may see, readable by
  anything that runs as you — and, unlike WhatsApp's own folder, macOS does not ask before a program
  reads it. `agent-whatsapp remove` deletes it; `deny` keeps chats out of it.

### Which guarantee you actually have

Two different things are called "it cannot send", and only one of them is ours.

| Access tier | Scopes | Who stops a send |
|---|---|---|
| `read` | `gmail.readonly` | **Google.** The token has no write capability at all, so no bug of ours can send from it |
| `draft` | `gmail.readonly` + `gmail.compose` | **This software only** |
| `organize` | `gmail.modify` | **This software only** |

`gmail.compose` and `gmail.modify` both permit `drafts.send`. There is no Gmail scope meaning "may
write, may not send", so above the `read` tier the guarantee is code we wrote — one send path, a
build-failing test if a second appears, and a transport guard beneath both. That is a real
guarantee and the rest of this section is about its limits, but it is not the same kind of thing as
a token that physically cannot send.

If you want the stronger one, connect the mailbox at `read` and accept that drafting is not
available from it: `agent-gmail inbox add acme/gmail-archive --tier read --start`.

Resend has no stronger one to offer. It has no read-only key, so an account in `read` mode is kept from
sending by this software alone; a sending-only key is the one Resend itself bounds, to sending.

[`SECURITY.md`](SECURITY.md) has the full threat model.

### Why not IMAP and an app password?

It would remove the console step entirely — no OAuth client, no project, no consent screen. Other
tools do exactly this and it is a reasonable product. It is not this one, for two reasons worth
stating rather than leaving you to wonder:

- **An app password cannot be scoped.** It grants IMAP *and* SMTP, always. The `read` tier above —
  the one configuration where Google itself guarantees nothing can be sent — could not exist.
- **It cannot be revoked per application** the way an OAuth grant can, and it carries no scope list
  for you to inspect.

An `@agentcomms/imap` sibling may come later for providers that have no API worth using — Fastmail,
Proton Bridge, self-hosted. That would be a different provider family with an honestly weaker
guarantee, not a shortcut around this one.

## Development

```bash
pnpm install
pnpm verify          # lint, typecheck, test, build, skills, packed-tarball consumer checks
```

Node 22.18 or newer to develop (the bundler needs it); the published packages run on 22.12, and
`@agentcomms/whatsapp` on 22.16 (it reads with Node's own SQLite).

## Contributing

Pull requests are welcome. Each one carries a proposed version (`X.Y.Z-<branch-slug>`, one semver step on from
`main`), tests, documentation, a changelog entry and its provenance — why it was made, what it relies on, anything
tested against a real account, and any AI assistance. A check on every pull request says what is missing, and a pull
request is merged once it carries all of it. [CONTRIBUTING.md](CONTRIBUTING.md) has the detail, and the
[Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere.

## Licence

[MIT](LICENSE)
