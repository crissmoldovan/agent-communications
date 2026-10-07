# What is where

Four platforms, Gmail, Slack, Resend and WhatsApp, each shipping the same things, independent of each other. You
can take one and ignore the rest. Each platform's column is its CLI, the MCP server that CLI starts, and its package.

```
                       ┌───────────────────────┬───────────────────────┬───────────────────────┬───────────────────────┐
  people, scripts ───► │ agent-gmail           │ agent-slack           │ agent-resend          │ agent-whatsapp        │
                       ├───────────────────────┼───────────────────────┼───────────────────────┼───────────────────────┤
  agents ────────────► │ MCP server (44 tools) │ MCP server (27 tools) │ MCP server (18 tools) │ MCP server (6 tools)  │
                       ├───────────────────────┼───────────────────────┼───────────────────────┼───────────────────────┤
                       │ @agentcomms/gmail     │ @agentcomms/slack     │ @agentcomms/resend    │ @agentcomms/whatsapp  │
                       ├───────────────────────┴───────────────────────┴───────────────────────┴───────────────────────┤
                       │ @agentcomms/core   (shared; its own CLI and MCP server, 12 tools)                             │
                       └───────────────────────────────────────────────────────────────────────────────────────────────┘
  agents ────────────►    skills/  — gmail-*, slack-*, resend-*, whatsapp-* and comms-*, instructions, not code
```

| | What it is | Install | Needs |
|---|---|---|---|
| **`agent-gmail`** | A CLI. 24 commands, `--json` on all of them, documented exit codes. | `@agentcomms/gmail` | nothing else |
| **MCP server** | The same operations over stdio, for agents. | `@agentcomms/gmail` (`agent-gmail mcp`) or `@agentcomms/gmail-mcp` | nothing else |
| **Library** | The TypeScript API both surfaces are built on. | `@agentcomms/gmail` | nothing else |
| **`agent-slack`** | The Slack CLI: connect a workspace, read it, draft, and post with a person's approval. | `@agentcomms/slack` | nothing else |
| **Slack MCP server** | The same operations over stdio. Posts only through the approval gate; no tool approves. | `@agentcomms/slack` (`agent-slack mcp`) | nothing else |
| **`agent-resend`** | The Resend CLI: a key a person types at a terminal, then a team's domains, sent and received mail, metrics and suppressions, and sending with a person's approval. | `@agentcomms/resend` | nothing else |
| **Resend MCP server** | The same operations over stdio, but adding a key. Sends only through the approval gate; no tool approves. | `@agentcomms/resend` (`agent-resend mcp`) | nothing else |
| **`agent-whatsapp`** | The WhatsApp CLI, read-only, on macOS: sync a local index of WhatsApp for Mac's own store, list, read and search it, and draft replies as links a person sends. | `@agentcomms/whatsapp` | WhatsApp for Mac, Node 22.16 |
| **WhatsApp MCP server** | The same reads over stdio. No tool sends, adds an account or changes which chats an agent sees. | `@agentcomms/whatsapp` (`agent-whatsapp mcp`) | the same |
| **Core MCP server** | Installs and manages the others from a chat — registers and prunes servers, reports what is installed, migrates names and secrets, sets the change policy. Every change is a preview a person approves. | `@agentcomms/core` (`agentcomms mcp`) | nothing else |
| **Skills** | Markdown instructions telling an agent how to use the above, and where to stop. | `npx skills add` | neither package |

## The CLI does not need the MCP server

This is the most common confusion, so plainly: installing `@agentcomms/gmail` gives you a working command-line Gmail
client. No agent, no MCP server, no skills.

```bash
npm i -g @agentcomms/gmail
agent-gmail search 'from:accounts newer_than:30d' --inbox acme/gmail --json | jq '.data.rows[].subject'
```

`agent-gmail mcp` starts an MCP server from that same package when you want one. `@agentcomms/gmail-mcp` is a thin
wrapper that starts the same server — it exists so a client config can name a package whose only job is being a
server, and installing it is optional.

## The skills are not the MCP server

They are separate things that are easy to confuse because both are "for agents".

- The **MCP server** gives an agent *capability*: tools it can call.
- The **skills** give an agent *judgement*: which tool to reach for, what the result actually means, what to tell
  you, and when to stop and ask.

`npx skills add` installs skills, not servers. Skills work either way: when the MCP tools are connected they use
them, and when they are not they fall back to the CLI. You can install skills with no server, a server with no
skills, or both.

There are twenty, one per job. Twelve for Gmail — searching, triage, composing, sending, organising, attachments,
contacts, thread analysis, follow-ups, export, security, setup — three for Slack: setup, reading and posting — two
for Resend: reading and sending — one for WhatsApp, reading — and two through the core server: `comms-onboarding`,
which sets them up, and `comms-update`, which brings them to the latest release. Each is a `SKILL.md` plus reference
pages, including the contract its platform's skills share; the two `comms-` skills share their own, for the core's
tools. See [the skills index](skills.md).

The platform skills are named `gmail-*`, `slack-*`, `resend-*` and `whatsapp-*` because a skill states one platform's truth and has no other
branch to fall into. `comms-onboarding` is the one that spans both, and only to install and connect them: once an
account works, it hands over to `gmail-setup` and `slack-setup`. Slack ships its own pack, and its own contract,
rather than the Gmail skills becoming platform-neutral, and the reason is that the guarantees genuinely differ: on
some accounts the credential itself cannot send, on others only this software stops it. A skill that had to say
"depending on the platform" is one an agent under pressure resolves in the reassuring direction.
[The skills architecture across platforms](superpowers/specs/2026-09-20-skills-architecture.md) is the full design,
including what adding an IMAP pack later would take.

## `@agentcomms/core` is shared, not Gmail

Config, the secret store, the approval engine, the sanitiser, the untrusted-content envelope, path jails, the audit
log, and the `agentcomms` command and its MCP server for the parts that are not about any one provider — including
installing every channel's server itself, which is why `agentcomms mcp install --client <client>` is the one
registration a person runs at a terminal before everything else can be done from chat.

It is separate because the approval gate and the sanitiser are not mail-specific. The Slack and Resend packages use
the same core, the same approval records, the same audit log — and, for Slack's workspaces and Resend's accounts,
the same generic account record in the one configuration file. So does WhatsApp's, for its accounts, with its
untrusted-content envelope, its name lookups and its change flow for registering the server — and, having no
credential, never its secret store.

Every channel package depends on it, so it arrives with any of them. You run it directly for its
command and its MCP server — `npx -y @agentcomms/core mcp install --client <client>` is the first step of the
install from a chat.

## How a send is gated

The one design decision everything else follows from.

Every Gmail permission that lets an agent write a draft also lets it send one. `gmail.compose` and `gmail.modify`
both allow `drafts.send`, so "may draft, may not send" cannot be expressed as a scope you grant. It is enforced in
code instead:

- **One path.** Exactly one function calls Gmail's send endpoint. A test fails the build if a second appears.
- **A second guard beneath it.** The HTTP client refuses any request to a path ending `/send` without a one-shot
  permit naming that draft, so a send added anywhere in the package fails at the request rather than at review.
- **An approval bound to the bytes.** The record covers a digest of everything a recipient would see and the
  draft's Gmail message id, which changes on every save. Edit the draft and the approval is void.
- **An approval bound to its route.** The record also binds how it may be approved — a yes in the chat, or a person
  outside it — and so how long it lasts: ten minutes on the chat route, thirty for a person, 24 hours once they
  approved. Every send, status and list says where it stands (`state`, `claimable`), an agent learns of an approval
  with a wait that only looks, and a send whose answer was lost is `SEND_OUTCOME_UNKNOWN`, never retried.
- **A fence before the provider.** A claimed send holds a two-minute lease it renews every thirty seconds, and checks
  it immediately before Gmail is asked; a claimant that lost it sends nothing. Turning sending off (`never`) moves the
  mailbox's send epoch, so nothing prepared before it can send again, whatever the policy becomes.

What that buys, stated narrowly: an agent using this package cannot send without an approval. It does not stop an
agent with a shell, and it does not stop a different Gmail server installed beside it. See
[Sending and approvals](sending.md).

## How a Slack post is gated

Slack's read and write scopes are disjoint, so the default `read` mode is a token Slack itself will not let post —
no bug here can change that. In `send` mode the gate is the same shape as Gmail's, with two differences that come
from Slack: every way of putting something in front of people (`chat.postMessage`, a file share's comment, a
reaction, an edit or a deletion of a message) is behind the one permit, and the approval covers how many people the
post reaches, so a room that grew after the preview voids it. Both surfaces post through that one gate:
`slack_post_prepare` returns the preview, and `slack_post_send` (or `agent-slack post send`) posts it once the
approval allows — a yes in the conversation under `chat`, the approve command the result gives, at the person's own
terminal under `confirm`, which no tool can run — the agent learns that it was with `slack_approval_wait`. Each step of a post — each upload, the share, the message, a
reaction, an edit, a deletion — starts only after a fence on the approval's lease, so a long file post stays
`sending` while it renews.

An edit or a deletion acts on a message this account posted, and on nobody else's: the message is read from Slack and
refused before any preview unless its author is the connected account, and the approval binds it as it was read, so
a message changed in Slack after the preview voids it ([design](superpowers/specs/2026-10-06-slack-edit-delete-design.md)).

A post can carry local files, chosen by the attachment jail Gmail uses (under the home folder, never from its hidden
folders). The draft records each by real path, name, size, type and SHA-256; the preview lists them and the digest
binds them. At send, after the approval is claimed and inside the one permit for `files.completeUploadExternal`, every
file is read and matched to its hash before anything is uploaded; each is then read and hashed once more and those
bytes go to the upload URL Slack returned, through a grant the guard opens only inside that permit, for one `POST`
to that exact URL on `files.slack.com`; and one call shares them all. No other request reaches the files host but a
download of a file just looked up.

## How a Resend email is gated

Resend has no read-only key, so unlike Slack's `read` mode, a Resend account's `read` mode is this software's rule and
not the key's: a full-access key could send, and only agent-resend's own code refuses to while the account is in
`read`. A sending-only key is the one Resend itself bounds — to sending, with no reads at all. In `send` mode the gate
is Gmail's shape for an API with no drafts: `resend_send_prepare` stores the email and returns a preview of every
recipient, BCC included, the reach and the From domain; `resend_send_execute` (or `agent-resend send execute`) is
the one function that may call Resend's send endpoint, claims the approval once, and sends with the approval id as
the `Idempotency-Key`. More than ten recipients, or an address first seen in mail read here, needs a person at a
terminal whatever the policy, and the agent learns of it with `resend_send_wait`. A send whose outcome is unknown is
`SEND_OUTCOME_UNKNOWN`, recorded as unknown and checked with `resend_send_status` — which says what Resend's own last
event reports, attributed to Resend — never repeated. The key is typed by a person at a terminal (`agent-resend account add`), and no
tool accepts one.

## How WhatsApp is kept read-only

There is nothing to gate, because there is nothing that sends. `@agentcomms/whatsapp` reads a copy of the message store
WhatsApp for Mac keeps on the Mac into a local index, and every tool reads that index. It has no network client — its
manifest declares no host, a test checks the published bundle imports no network module, and another runs its read,
draft and list commands and every tool with the network cut off (installing the server, which fetches the package from
npm, is the one step that reaches a network) — no WhatsApp session, and no send path. A draft is a link that opens
WhatsApp with the text filled in; the person presses send. That is also why it never logs in as a linked device:
WhatsApp bans numbers it catches using unofficial clients.

Its accounts are core's generic record (`mode: "read"`, the only mode it has), so a registration is pinned, renamed
and checked like any other channel's. Which store is read, and which chats an agent may see, are the person's: the
commands that set them have no tool and refuse an agent. The index is a plaintext copy, owner-only — the cost of
full-text search over a store no API offers — and [the package](../packages/whatsapp/README.md) says what that means.
