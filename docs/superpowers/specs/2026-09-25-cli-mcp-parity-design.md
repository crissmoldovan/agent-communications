# Every capability from both surfaces — CLI and MCP — design

Status: draft, 2026-09-25. Supersedes the terminal-only widening rule in
[`2026-09-23-slack-mode-switching-design.md`](2026-09-23-slack-mode-switching-design.md) §1 and §6; everything else
there stands.

## 1. What was asked

The owner, 2026-09-25: *"everything has to be done in both ways: via CLI and via chat. Throughout the whole stack,
all of these communication ports, like Gmail or Slack, should be able to be installed, manipulated, changed,
whatever, via both CLI and MCP."*

So parity is no longer about reading and sending. Installing a channel, connecting an account, switching its mode,
changing its policies, registering and pruning MCP servers, and the core's own maintenance all have to be reachable
from a chat with an agent as well as from a terminal. A command with no tool, or a tool with no command, is a
defect.

What does not change: nothing reaches another person — a sent mail, a Slack post, a reaction — without a person
approving that exact content. What changes is where a *loosening* may be approved: in chat as well as at a terminal.

## 2. Where it stands (0.4.2)

| Surface | In both | CLI only |
|---|---|---|
| Gmail | read, search, thread, timeline, attachments, contacts, follow-ups, export, drafts, send prepare/execute/list/cancel, organise and undo, trash, labels, send-as, whoami, doctor, setup, inbox add/finish | `client add/list/remove`, `inbox reauth/show/rename/policy/import/remove`, `approve`, `confirm-clients`, `mcp install/prune` |
| Slack | workspaces list, mode report and request, narrow steps, channels, read, thread, search, people, files, post prepare, drafts list/get/delete | `manifest`, `workspace add/show/reauth/remove`, `workspace mode … send` (the widening itself), `doctor`, `post send`, `react`, `approve`, `mcp install/prune` |
| Core (`agentcomms`) | — | `paths`, `doctor`, `audit tail`, `approvals list/revoke`, `secrets migrate`, `names migrate` — there is no core MCP server |

## 3. The approval model for changes

### 3.1 Classes of operation

| Class | Examples | Needs |
|---|---|---|
| Read | search, read, list, doctor, paths, audit tail, mode report | nothing |
| Local and reversible | drafts, labels, organise (undoable), prune `--dry-run` | nothing |
| Outward | send mail, post, react, upload | the existing gate: a prepared message, its preview, approval of that exact content (`chat`, `confirm` or `never` per account) — unchanged |
| Loosening | connect an account in `send`, widen a Slack workspace or a Gmail tier, loosen a send policy, add an internal domain, add an OAuth client, register an MCP server, loosen the change policy itself | a **change approval** (§3.2) |
| Tightening | narrow a mode, tighten a policy, remove an MCP registration | nothing; always allowed |
| Destructive | remove an account, prune runtimes, names migrate, secrets migrate | a change approval — not because they loosen anything, but because they cannot be taken back |

### 3.2 Change approvals

The same shape as a post, over a configuration change instead of a message:

1. **Prepare.** The tool or command computes the change without writing it: the config paths it loosens (core's
   `classifyChange`, which already finds every loosening), plus anything outside the config it will do (a sign-in,
   a registration, files removed). It stores an approval record bound to a digest of exactly that change, expiring
   in ten minutes, single use — `core.approvals`, the store posts already use.
2. **Preview.** What a person reads before agreeing: before → after for each path, in words ("`rgc/slack`: read →
   send — it will be able to post, upload and react"), plus the outside effects.
3. **Approve**, per the **change policy** (§3.3): `chat` — the person says yes in the conversation and the agent
   claims the approval; `confirm` — the person runs `agentcomms approve <id>` and types the code shown, exactly as
   for posts.
4. **Apply.** Claiming the approval yields the `LooseningConsent` that `ConfigStore.update` already demands, scoped
   to the approved paths and digest. Any drift between preview and apply — a different path, a different value, the
   account changed underneath — refuses, and the change is prepared again. The audit trail records the surface, the
   policy and who claimed it.

Core stays the single enforcement point: a loosening without a consent is refused by `ConfigStore.update` whatever
surface wrote it, as today. The chat path is a second *source* of that consent, not a way around it.

### 3.3 The change policy

A new setting, `defaults.changePolicy: chat | confirm`, overridable per account.

- **Default `chat`**, per the owner's instruction. `confirm` keeps the terminal code for anyone who wants it.
- **It is a safety setting itself.** Moving it `confirm → chat` is a loosening and needs a change approval under the
  policy in force *before* the change — a terminal code. Moving it `chat → confirm` is tightening and needs nothing.
- **Upgrading changes nothing silently.** A config written before this release has no `changePolicy`; it reads as
  `chat` from then on, and the release note says so in its first line, with the one command to go back to `confirm`.

### 3.4 What `chat` trusts, stated plainly

Under `chat` the software cannot tell a person's "yes" from an agent that decided on its own. That is the same trust
`chat` already places in the agent for mail and posts, now extended to changes. The mitigations are the existing
ones: untrusted content arrives enveloped and is never instructions; every approval is bound to the exact change
the preview showed; each is single use and short-lived; everything is in the audit trail; and `confirm` is one
setting away.

## 4. What stays a person's, whatever the surface

- **Google's and Slack's consent screens.** A sign-in started from either surface returns a link and stops; the
  person clicks Allow in a browser; the other half finishes it (Gmail already works this way over MCP).
- **A Slack app's declared scopes.** Changing them needs either the api.slack.com page or an app configuration token,
  which can rewrite every app of that user. Default path: the tool returns the manifest and the direct link to that
  app's manifest page (`https://api.slack.com/apps/<appId>/app-manifest`) — one paste. Optional path (§6.4): the CLI
  updates the app itself with a configuration token read from a hidden prompt or an environment variable, used for
  one call and never stored. A token is never accepted through chat, because the transcript would keep it.
- **Restarting the client** after a server is registered: no MCP client loads a new server into a running session.

## 5. The core MCP server

`agentcomms mcp` — the generic server the owner expected, which installs and manages the others.

| Tool | Does |
|---|---|
| `comms_paths`, `comms_doctor` | as the CLI |
| `comms_audit_tail`, `comms_approvals_list`, `comms_approval_revoke` | as the CLI |
| `comms_channels_available` | which channel packages exist, which are installed, at which version, registered with which clients |
| `comms_server_install` | register a channel's MCP server with a client (change approval; returns "restart the client") |
| `comms_server_prune` | remove unused runtimes (dry-run free; removal needs a change approval) |
| `comms_names_migrate` | dry run free; applying it needs a change approval |
| `comms_secrets_migrate` | change approval |
| `comms_change_prepare`, `comms_change_claim` | the generic change-approval pair every channel's tools use underneath |

Bootstrapping: the first registration of anything has to come from outside MCP — `npx -y @agentcomms/core mcp
install --client claude-code`, one command, or the plugin. After that every other channel is installed from chat.

## 6. Channel parity

### 6.1 Gmail — new tools

`gmail_inbox_reauth` (tier changes; widening needs a change approval), `gmail_inbox_rename`, `gmail_inbox_policy`
(loosening needs a change approval), `gmail_inbox_import`, `gmail_inbox_remove` (change approval),
`gmail_clients_list`, `gmail_client_add` (change approval; the client JSON is read from a path, never pasted),
`gmail_client_remove`, `gmail_confirm_clients`.

### 6.2 Slack — new tools and commands

- `slack_workspace_add` / `slack_workspace_finish`: start and complete a sign-in in `read` or `send`; `send` needs a
  change approval before the sign-in starts.
- `slack_workspace_reauth`, `slack_workspace_remove` (change approval), `slack_workspace_show`.
- `slack_mode_set`: `read → send` by change approval — it checks the app's scopes first and, when the manifest has
  not been updated, returns the link and manifest instead of starting a sign-in that would grant read again;
  `send → read` returns the narrowing procedure (Slack never removes a scope from a token; §5 of the 23 Sep spec).
- `slack_post_send`, `slack_react` and `slack_react_send`: claim a prepared post or reaction under `chat`; under
  `confirm` they return the one terminal command, as the CLI does.
- `slack_doctor`, `slack_manifest`.
- CLI: `agent-slack workspace policy` (send policy and change policy), which does not exist yet.

### 6.3 Approving under `confirm`

`agentcomms approve`, `agent-gmail approve` and `agent-slack approve` stay terminal commands. A policy of `confirm`
means "a person at a terminal", and a tool that approved would make it mean nothing. Over MCP the equivalent returns
the command to run. This is the one deliberate asymmetry, and it exists only where the owner chose it.

### 6.4 Slack app automation (optional)

`agent-slack app update <workspace> --mode send` updates the app's manifest through `apps.manifest.update` with an
app configuration token from a hidden prompt or `SLACK_APP_CONFIG_TOKEN`, used for that one call and discarded.
`agent-slack app create` does the same for a new workspace, so connecting one needs no visit to api.slack.com.

## 7. Parity, enforced

A test derives the CLI command tree from each package's Commander program and the tool list from each MCP server's
registrations, and maps them through one capability table (`capabilities.json`: capability → CLI path → tool
name). It fails when a command or a tool is missing from the table, when either side of a row is missing, or when
the two sides of a row are not the same operation in `packages/*/src/operations` — the existing rule that both
surfaces call one function. The table carries its exceptions inline with the reason (`mcp` itself, the `approve`
commands of §6.3), so an exception is visible in review rather than implied by absence. Hand-written lists went
stale four times in this repository; this one is checked against both registries on every run.

## 8. Onboarding

A skill, `comms-onboarding`, and the core server's tools. The agent asks which channels and accounts, and for each
account the mode it should have. It installs and registers the servers, starts each sign-in and hands over the link,
prepares every change approval and asks for it in chat, returns the Slack manifest link where an app must change, and
ends with the one restart. Every step it cannot take is named as the person's, with the exact action.

## 9. Phases

| Phase | Scope | Depends on |
|---|---|---|
| P1 | Change approvals and `changePolicy` in core; consent from a claimed approval; audit | — |
| P2 | Core MCP server (§5), including the generic installer | P1 |
| P3 | Slack parity (§6.2), `workspace policy` | P1 |
| P4 | Gmail parity (§6.1) | P1 |
| P5 | The parity test (§7) and its capability table | P2–P4 |
| P6 | Onboarding skill (§8); Slack app automation (§6.4) | P2–P4 |

P3 and P4 run in parallel. Each phase lands with its tests failing first, every new guard mutation-tested, and CLI and
MCP calling one operation.

## 10. Decisions taken in this design

1. `changePolicy` defaults to `chat` (§3.3), per the owner; `confirm` remains.
2. Slack app configuration tokens are optional, CLI-only, and never stored or accepted through chat (§4, §6.4).
3. `approve` under `confirm` is terminal-only on purpose (§6.3).
