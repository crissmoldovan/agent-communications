# What is where

Two platforms, Gmail and Slack, each shipping the same four things, independent of each other. You can take one
and ignore the rest.

```
                       ┌──────────────────────────────────┬───────────────────────────────────┐
  people, scripts ───► │  agent-gmail        (the CLI)    │  agent-slack        (the CLI)     │
                       ├──────────────────────────────────┼───────────────────────────────────┤
  agents ────────────► │  MCP server         (38 tools)   │  MCP server         (20 tools)    │
                       ├──────────────────────────────────┼───────────────────────────────────┤
                       │  @agentcomms/gmail  (library)    │  @agentcomms/slack  (library)     │
                       ├──────────────────────────────────┴───────────────────────────────────┤
                       │  @agentcomms/core   (shared)                                         │
                       └──────────────────────────────────────────────────────────────────────┘
  agents ────────────►    skills/  — gmail-* and slack-*, instructions, not code
```

| | What it is | Install | Needs |
|---|---|---|---|
| **`agent-gmail`** | A CLI. 24 commands, `--json` on all of them, documented exit codes. | `@agentcomms/gmail` | nothing else |
| **MCP server** | The same operations over stdio, for agents. | `@agentcomms/gmail` (`agent-gmail mcp`) or `@agentcomms/gmail-mcp` | nothing else |
| **Library** | The TypeScript API both surfaces are built on. | `@agentcomms/gmail` | nothing else |
| **`agent-slack`** | The Slack CLI: connect a workspace, read it, draft, and post with a person's approval. | `@agentcomms/slack` | nothing else |
| **Slack MCP server** | The same operations over stdio. Posts only through the approval gate; no tool approves. | `@agentcomms/slack` (`agent-slack mcp`) | nothing else |
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

There are fifteen, one per job. Twelve for Gmail — searching, triage, composing, sending, organising, attachments,
contacts, thread analysis, follow-ups, export, security, setup — and three for Slack: setup, reading and posting.
Each is a `SKILL.md` plus reference pages, including the contract its platform's skills share.
See [the skills index](skills.md).

They are named `gmail-*` and `slack-*` because a skill states one platform's truth and has no other branch to fall
into. Slack ships its own pack, and its own contract, rather than the Gmail skills becoming platform-neutral, and
the reason is that the guarantees genuinely differ: on some accounts the credential itself cannot send, on others only this
software stops it. A skill that had to say "depending on the platform" is one an agent under pressure resolves in
the reassuring direction. [The skills architecture across platforms](superpowers/specs/2026-09-20-skills-architecture.md)
is the full design, including what adding an IMAP pack later would take.

## `@agentcomms/core` is shared, not Gmail

Config, the secret store, the approval engine, the sanitiser, the untrusted-content envelope, path jails, the audit
log, and the `agentcomms` command for the parts that are not about any one provider.

It is separate because the approval gate and the sanitiser are not mail-specific. The Slack package uses the same
core, the same approval records and the same audit log.

You rarely install it directly — `@agentcomms/gmail` and `@agentcomms/slack` depend on it.

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

What that buys, stated narrowly: an agent using this package cannot send without an approval. It does not stop an
agent with a shell, and it does not stop a different Gmail server installed beside it. See
[Sending and approvals](sending.md).

## How a Slack post is gated

Slack's read and write scopes are disjoint, so the default `read` mode is a token Slack itself will not let post —
no bug here can change that. In `send` mode the gate is the same shape as Gmail's, with two differences that come
from Slack: every way of putting something in front of people (`chat.postMessage`, a file share's comment, a
reaction) is behind the one permit, and the approval covers how many people the post reaches, so a room that grew
after the preview voids it. Both surfaces post through that one gate: `slack_post_prepare` returns the preview, and
`slack_post_send` (or `agent-slack post send`) posts it once the approval allows — a yes in the conversation under
`chat`, `agent-slack approve` at the person's own terminal under `confirm`, which no tool can run.
