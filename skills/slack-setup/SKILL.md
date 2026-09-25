---
name: slack-setup
description: "Connect a Slack workspace to agent-slack: the app manifest, the PKCE sign-in, read and send modes, and what doctor reports. Symptoms: 'connect my Slack', 'set up agent-slack', 'why can't it post', 'move this workspace to send mode', 'agent-slack doctor says something is wrong'. Not for reading or posting once it works — slack-reading and slack-posting do those."
license: MIT
compatibility: "@agentcomms/slack@0.4.2"
metadata:
  group: communications
  lifecycle: release
---

# Connecting a Slack workspace

Slack gives this package something Gmail cannot: **read and write scopes that are genuinely disjoint**. A token
holding only `*:history` and `*:read` cannot call `chat.postMessage` at all, and Slack's own consent screen says
so. That is why there are two install modes and why the default is the narrow one.

Be precise about what the narrow mode promises. It is **"this package cannot post"**, not "nothing on this
machine can post". A second Slack MCP server holding a write token for the same workspace lets an agent post
without going near this one, and the Gmail release found exactly that shape on the author's own machine.
Check the client's MCP server list for other Slack servers, and never state the promise more broadly than the
sentence above.

## The two modes

| Mode | What the token can do | Who enforces it |
|---|---|---|
| `read` (default) | history, read, users, files, search | **Slack.** The token physically cannot post |
| `send` | the above plus `chat:write`, `files:write`, `reactions:write` | **This package's gate**, as for Gmail |

`send` is not a lesser product with a worse guarantee — it is the same guarantee Gmail gives. Say which is which
rather than implying one sentence covers both.

## Bring your own Slack app

There is no shared app to install. A person creates one in their own workspace from a manifest this package
prints, which means the scopes are visible to them before anything is granted and the workspace's admins keep
control of it.

```sh
agent-slack manifest --mode read --port 51234
```

The **port matters and is chosen before the sign-in**, not by the operating system. Slack stores redirect URLs on
the app and matches them exactly, so the port in the manifest and the port in `workspace add` must be the same
number. This is the one place the package deliberately diverges from Gmail, which takes whatever port it is
handed.

For a workspace already connected, name it: `agent-slack manifest --workspace acme/slack --mode send` (over MCP,
`slack_manifest` with `workspace`) uses the port it signed in with and returns the direct link to its own app's
manifest page, `https://api.slack.com/apps/<appId>/app-manifest`. Pasting the JSON there and saving is still the
person's to do — hand them the link and the JSON. A workspace connected before its app id was recorded gets no
link, and the person finds the app at https://api.slack.com/apps instead.

Two fields in that manifest are load-bearing: `oauth_config.pkce_enabled` and `token_rotation_enabled`. Without
PKCE, Slack treats a loopback redirect like a server redirect and no sign-in can complete. Both were verified
against a real workspace on 2026-09-22.

### Or let the CLI make the app

With an **app configuration token**, the CLI sends the same manifest to Slack itself, and nobody pastes JSON:

```sh
agent-slack app create acme/slack --mode read --port 51234
```

It asks Slack to validate the manifest first (a refusal changes nothing), creates the app, and prints its app id,
its Client ID and the exact `workspace add` command to run next. Slack returns the app's client secret and signing
secret with it; neither is kept or shown, because the PKCE sign-in needs neither.

The token is a person's to give, at a terminal. They generate it at https://api.slack.com/apps under **Your App
Configuration Tokens** (it lasts twelve hours), then type it at the hidden prompt or set `SLACK_APP_CONFIG_TOKEN` for
that one command. It is used for that command's calls and never stored, logged or printed; no option takes it, and
no MCP tool does. **Never ask the user to paste it into the chat**: the transcript would keep a credential that can
rewrite every Slack app they own. Give them the command to run themselves; without a terminal or the variable it
refuses.

## Connecting

```sh
agent-slack workspace add acme/slack --client-id <id> --port 51234
agent-slack workspace list
agent-slack doctor
```

The name is `organisation/platform` — `acme/slack`, `rgc/slack`. A flat name is refused with an example.

From a chat, `slack_workspace_add` (with `workspace`, `clientId` and `port`) starts the same sign-in and returns the
link; give it to the person, who approves in Slack, then call `slack_workspace_finish` with the `flowId`. At a
terminal, `--start` returns the link the same way and `workspace add --finish <flowId>` completes it. Slack's consent
screen is the person's: nothing here clicks it. Connecting in `read` starts at once; connecting with `--mode send`
(`mode: "send"`) is a change the person approves first — see "How a change is approved".

No client secret is stored anywhere, ever. PKCE is what proves the exchange, and the verifier never leaves the
machine that generated it.

## How a change is approved

Anything that loosens what a workspace may do — connecting it in `send`, moving it to `send`, loosening its send or
change policy — or that cannot be taken back — removing it — is a **change approval**, the same shape as a post.
Tightening — renewing a grant, narrowing, a stricter policy — applies at once and asks nobody.

1. The tool returns `approvalRequired` with a `preview` and an `approvalId`, and changes nothing. At a terminal, an
   agent gets the same as `APPROVAL_PENDING` (exit 10), with the command to run again.
2. Show the preview in full: what loosens, from what to what, and what it does outside the configuration — "signs
   in to Slack again as acme/slack and stores a token that can post, upload and react". Ask.
3. What counts as the person's approval is the workspace's **change policy**:
   - `chat` (the default): their yes in this conversation. Call the same tool again with `approvalId` (at a
     terminal, the same command with `--approval <approvalId>`).
   - `confirm`: they run `agentcomms approve <approvalId>` in their own terminal — `npx -y @agentcomms/core approve
     <approvalId>` where only `@agentcomms/slack` is installed — and type the code it shows. You cannot approve it
     yourself; call the tool again with `approvalId` once they say they have.
4. The approval is single use, lasts ten minutes, and is bound to exactly the change shown. If the workspace changed
   in between, it is refused and has to be asked for again.

A person running the command at a terminal approves there and then: a `yes` under `chat`, the typed code under
`confirm`.

`agent-slack workspace policy <name>` (`slack_workspace_policy`) reports both policies — the send policy, which
decides how a post is approved, and the change policy — and sets them with `--send chat|confirm|never` and
`--change chat|confirm`. Moving the change policy off `confirm` is itself approved under `confirm`, at a terminal,
so a policy never approves its own relaxation. Never loosen a policy the person did not ask to loosen.

## Connecting it to your agent

The workspace is connected; the agent is not, until the MCP server is registered with its client:

```sh
agent-slack mcp install --client claude-code
agent-slack mcp install --client cursor --workspace acme/slack   # pinned to one workspace
```

`--client` also takes `codex`, `claude-desktop`, `gemini`, `vscode` and `json` (print the entry to paste by hand).
The entry pins the exact version it was installed from, so a newer release reaches the agent only when it is
registered again with `--force`; restart the client afterwards. Each version installs its own runtime, and the old
one stays; `agent-slack mcp prune` removes those it can show are unused — named in no client config it reads, never
printed as an entry to paste, and not running — and nothing at all when one of those configs cannot be read. It
does not read a workspace's own `.vscode/mcp.json` or `.cursor/mcp.json`, so run `--dry-run` first and tell the
user what it lists. Without the server the skills still work, through `agent-slack … --json`.

From a chat with the core server connected, `comms_server_install` and `comms_server_prune` with
`channel: "slack"` do the same. Each returns a preview and an approval id first: show the preview, and call again
with the id once the user agrees. The server appears after the client is restarted.

What the agent gets is everything the CLI does except approving, and changing the Slack app itself. Posting and
reacting go through the same approval gate as the CLI: under `chat` the person's yes in the conversation is the
approval, under `confirm` they approve at their own terminal with `agent-slack approve`, and under `never` nothing
posts — see `slack-posting`. Changing a workspace goes through a change approval, as above.

| MCP tool | CLI |
|---|---|
| `slack_workspaces_list`, `slack_workspace_show` | `agent-slack workspace list`, `agent-slack workspace show <name>` |
| `slack_workspace_add`, `slack_workspace_finish` | `agent-slack workspace add`, with `--start` and `--finish` |
| `slack_workspace_reauth` | `agent-slack workspace reauth <name>` |
| `slack_workspace_remove` | `agent-slack workspace remove <name>` |
| `slack_workspace_policy` | `agent-slack workspace policy <name>` |
| `slack_mode_set` | `agent-slack workspace mode <name> send\|read` |
| `slack_mode`, `slack_mode_request_send`, `slack_mode_narrow` | `agent-slack workspace mode <name>`, and the steps each way |
| `slack_doctor` | `agent-slack doctor` |
| `slack_manifest` | `agent-slack manifest` |
| `slack_channels`, `slack_read`, `slack_thread`, `slack_search`, `slack_people`, `slack_files` | the commands of the same name — see `slack-reading` |
| `slack_post_prepare`, `slack_draft_list`, `slack_draft_get`, `slack_draft_delete` | `agent-slack draft …` and `agent-slack post prepare` — see `slack-posting` |
| `slack_post_send`, `slack_react`, `slack_react_send` | `agent-slack post send`, `agent-slack react` — see `slack-posting` |

`slack_mode_request_send`, `slack_mode_narrow` and `slack_manifest` return steps and change nothing. A server
pinned to one workspace offers no `slack_workspace_add` or `slack_workspace_remove`: it reaches that workspace and no
other. `app create` and `app update` have no tool, and neither do `agent-slack approve` and `agentcomms approve`: under
`confirm`, approving a post or a change is a person at their own terminal.

## Moving a workspace to `send`

This is a **widening**: a change the person approves, after their app has been updated. Do it when they ask for it,
never on your own initiative. It takes two steps, in this order, and `agent-slack workspace mode <name> send`
(`slack_mode_set` with `mode: "send"`) walks both:

1. **The app.** A token can only be granted what its app declares, so the app's manifest has to be the `send` one
   first. While the workspace's recorded grant has no posting scope, nothing on this machine can show the app was
   updated, so the command returns `appUpdateNeeded` with the manifest and the link to that app's own manifest page,
   `https://api.slack.com/apps/<appId>/app-manifest`, and starts nothing. Pasting it there and saving is the
   person's step — edit the app the workspace already uses, never a new one, which changes no installation. With an
   app configuration token they can do it at a terminal instead: `agent-slack app update <name> --mode send`, the
   `terminalAlternative` the result names. Never ask for that token in the chat.
2. **The change.** Once they say the app is saved, run it again with `--app-updated` (`appUpdated: true`). It is a
   change approval — show the preview and ask — and once approved it starts a sign-in: the person approves that in
   Slack, and `slack_workspace_finish` (or `--finish`) records the new token.

If Slack grants no posting scope at the end, the app's manifest was not updated after all — saved on another app, or
not saved — and nothing is recorded; the refusal says so and how to do step 1.
`agent-slack workspace reauth <name> --mode send` (`slack_workspace_reauth` with `mode: "send"`) is the same change
without step 1's check.

`agent-slack workspace mode <name>` (`slack_mode`) reports where a workspace stands and prints these steps. A
workspace signed in with 0.4.1 or later remembers its port, so `--port` can be left out of `workspace reauth`,
`workspace mode` and `manifest --workspace`, which use the recorded one. `agent-slack manifest` without
`--workspace` names no workspace, so it has no recorded port to use and needs `--port` given. An older workspace
has none recorded either, so give `--port` there too: its steps print `<port>` until it is given one.

## Going back to `read`

Slack **adds** scopes to a token and never removes one. `auth.revoke` leaves the installation intact under token
rotation, and only `apps.uninstall` resets it — which needs the client secret this package never stores. So going
back is a person's procedure, not a command:

1. Replace the app's manifest with the `read` one.
2. In Slack: **Workspace settings → Manage apps → the app → Remove app.** This is the step that actually resets
   the scopes.
3. `agent-slack workspace reauth <name> --mode read --port <port>` — `reauth`, not `add`, so the name and its
   history are kept.

`agent-slack workspace mode <name> read` (`slack_mode_set` with `mode: "read"`, or `slack_mode_narrow`) prints
exactly this and changes nothing.

## Removing a workspace

`agent-slack workspace remove <name>` (`slack_workspace_remove`) deletes its token from this machine and drops it
from the configuration. It cannot be taken back, so it is a change approval like a widening. The Slack app stays
installed in the workspace; removing it there is the person's step in Slack's settings.

## What `doctor` checks

- the stored credential's state, and whether a refresh is due or was interrupted;
- the granted scopes against the mode, measured from what **Slack reports**, not from what was recorded at
  sign-in;
- who the token actually is, via `auth.test` — the only check that can tell a revoked token from a working one,
  because everything else reads files this package wrote;
- other Slack MCP servers registered on this machine. Where it says *not checked*, it could not look, and that is
  not the same as "none": open the client's MCP server list and look for another Slack entry yourself.

`--offline` skips the one network call, so a person diagnosing a machine with no network still gets everything
the files can say, and `--workspace <name>` checks one workspace. `slack_doctor` runs the same checks and returns
the same JSON, with `offline` and `workspace`; on a server pinned to one workspace it reports that workspace only.

## Pitfalls

- **Starting a widening before the app is updated.** Slack grants what the app declares, so a `send` sign-in through
  a `read` app comes back `read` and nothing is recorded. Do the app step first; `workspace mode <name> send`
  enforces the order.
- **Claiming an approval the person did not give.** Under `chat` their yes is the approval, and nothing can tell it
  from yours; call the tool with `approvalId` only after they said yes to that preview. Under `confirm` you cannot
  claim it at all until they have run `agentcomms approve`.

- **A port mismatch between the manifest and `workspace add`.** The sign-in completes at Slack and then fails to
  return. Check both numbers say the same thing.
- **Creating a second app instead of editing the first.** A new app is a new installation; the old one still has
  the old scopes and the workspace still behaves as it did. For a workspace already connected, that is `app
  update`, never `app create`.
- **Reading an updated app as a widened workspace.** `app update --mode send` changes what the app may ask for,
  not what the workspace's token can do.
- **Forgetting that `app update` replaces the app's whole configuration.** Slack's update writes the manifest as
  given, so a name or description somebody set by hand comes back as `agent-slack`.
- **Reading `read` mode as a guarantee about the machine.** It is a guarantee about this package's token.
- **Assuming a scope came back after a narrowing reauth.** It did not, unless the app's installation was removed
  in Slack first. That step is not optional and is the one people skip.
