---
name: slack-setup
description: "Connect a Slack workspace to agent-slack: the app manifest, the PKCE sign-in, read and send modes, and what doctor reports. Symptoms: 'connect my Slack', 'set up agent-slack', 'why can't it post', 'move this workspace to send mode', 'agent-slack doctor says something is wrong'. Not for reading or posting once it works — slack-reading and slack-posting do those."
license: MIT
compatibility: "@agentcomms/slack@0.15.2"
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

## Choose the profile app or your own app

**First, is there an organisation profile?** An organisation may already have made its apps — one for reading,
one for posting — and handed its members a profile, a small `.agentcomms.json` file. `agentcomms org add <file>`
(`comms_org_add` from a chat) records those apps here; `agentcomms org show <organisation>` (`comms_org_show`)
lists them. With a profile, **do not create an app**: `workspace add rgc/slack` automatically selects the
profile's read app and port, or its send app with `--mode send`. A mode change signs in through the other
profile app. Do not edit or uninstall either organisation app.

**For a person's own app**, there is no profile app to select. The person creates one in their workspace from a manifest
this package prints, which means the scopes are visible to them before anything is granted and the workspace's
admins keep control of it.

```sh
agent-slack manifest --mode read --port 51234
```

The **port matters and is chosen before the sign-in**, not by the operating system. Slack stores redirect URLs on
the app and matches them exactly, so the port in the manifest and the port in `workspace add` must be the same
number. This is the one place the package deliberately diverges from Gmail, which takes whatever port it is
handed.

For a workspace connected through a person's own app, name it: `agent-slack manifest --workspace acme/slack --mode send` (over MCP,
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

With an organisation profile:

```sh
agent-slack workspace add rgc/slack --start
agent-slack workspace add --finish <flowId>
```

From a chat, `slack_workspace_add` with `workspace: "rgc/slack"` selects the profile's read app and
port automatically. Use `mode: "send"` (CLI: `--mode send`) to select its send app; neither path needs
`clientId` or `port`. The profile's workspace and app are checked before a token is stored.

With a person's own app, use the Client ID and the port from its manifest:

```sh
agent-slack workspace add acme/slack --client-id <id> --port 51234
agent-slack workspace list
agent-slack doctor
```

The name is `organisation/platform` — `acme/slack`, `rgc/slack`. A flat name is refused with an example.

For an own app, `slack_workspace_add` takes `workspace`, `clientId` and `port`. Either path starts a
sign-in and returns a link; give it to the person, who approves in Slack, then call
`slack_workspace_finish` with the `flowId`. At a terminal, `--start` returns the link the same way
and `workspace add --finish <flowId>` completes it. Slack's consent screen is the person's: nothing
here clicks it. Connecting in `read` starts at once; connecting with `--mode send` (`mode: "send"`)
is a change the person approves first — see "How a change is approved".

If a profile sign-in ends before a token is stored, report Slack's error and description when
available and say the sign-in did not complete. The person may have declined, or the workspace may
require an administrator to approve the app; never state that the person declined as a fact. Name
the organisation, workspace name and id, and the profile app's role and Client ID from the result.
If the person says Slack's page showed `invalid_team_for_non_distributed_app`, their browser was
signed in to another workspace: ask them to sign in to the workspace the profile names in that
browser, then start the sign-in again — not to ask an administrator.
If an MCP client cancels a waiting `slack_workspace_finish`, the detached sign-in stays open and can
be finished later. Interrupting a detached CLI `workspace add --finish` or `reauth --finish` also
leaves the flow open: after consent, run `--finish` again. Interrupting a foreground sign-in ends its
listener, so start a new flow in that case.

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
   - `confirm`: they run the approve command the result gives in their own terminal — this installation's own,
     its folders pinned, whether core is installed beside Slack or only inside it; hand it over exactly as given —
     and type the code it shows. You cannot approve it yourself; learn when they have with `slack_approval_wait`
     (`agent-slack approval wait <approvalId>`), in repeated default-length waits, then call the tool again with
     `approvalId`.
4. When the person says no, revoke it at once, with the core server's `comms_approval_revoke` (CLI: `agentcomms
   approvals revoke <approvalId>`): the server never hears a "no", and until it is revoked a change under `chat` can
   still be claimed for the rest of its ten minutes.
5. The approval is single use and bound to exactly the change shown. It waits ten minutes for a yes in chat, thirty
   for the terminal, and once approved there it can be used within 24 hours. If the workspace changed in between, it
   is refused and has to be asked for again.

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

Registering hands the agent a new set of tools, so it is a change approval, like the workspace changes above: run
by an agent, the first command exits `10` with the preview — which server, which client, under which name, pinned
to what — and an approval id, and registers nothing. Show the preview, and after the user's yes run the same
command with `--approval <id>`. `--print` and `--client json` write nothing and ask nobody.

`--client` also takes `codex`, `claude-desktop`, `gemini`, `vscode` and `json` (print the entry to paste by hand).
The entry pins the exact version it was installed from, so a newer release reaches the agent only when it is
registered again with `--force`; restart the client afterwards. Each version installs its own runtime, and the old
one stays; `agent-slack mcp prune` removes those it can show are unused — named in no client config it reads, never
printed as an entry to paste, and not running — once the user approves the list it shows, and nothing at all when
one of those configs cannot be read. It
does not read a workspace's own `.vscode/mcp.json` or `.cursor/mcp.json`, so run `--dry-run` first and tell the
user what it lists. Without the server the skills still work, through `agent-slack … --json`.

From a chat with the core server connected, `comms_server_install` and `comms_server_prune` with
`channel: "slack"` do the same — they are the same change, so an approval from either surface is good on the other
for the same request. A registration, and a prune that would remove something, returns a preview and an approval id
first: show the preview, and call again with the id once the user agrees. A prune dry run, or a prune with nothing to
remove, asks nobody. The server appears after the client is restarted.

What the agent gets is everything the CLI does except approving, and changing the Slack app itself. Posting and
reacting go through the same approval gate as the CLI: under `chat` the person's yes in the conversation is the
approval, under `confirm` they approve at their own terminal with the approve command the result gives — the agent
learns when with `slack_approval_wait` — and under `never` nothing posts — see `slack-posting`. Changing a workspace goes through a change approval, as above.

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
| `slack_file_download` | `agent-slack files download` — see `slack-reading` |
| `slack_post_prepare`, `slack_draft_list`, `slack_draft_get`, `slack_draft_delete` | `agent-slack draft …` and `agent-slack post prepare` — see `slack-posting` |
| `slack_post_send`, `slack_react`, `slack_react_send` | `agent-slack post send`, `agent-slack react` — see `slack-posting` |
| `slack_edit_prepare`, `slack_edit_send`, `slack_delete_prepare`, `slack_delete_send` | `agent-slack edit …` and `agent-slack delete …` — see `slack-posting` |

`slack_mode_request_send`, `slack_mode_narrow` and `slack_manifest` return steps and change nothing. A server
pinned to one workspace offers no `slack_workspace_add` or `slack_workspace_remove`: it reaches that workspace and no
other. `app create` and `app update` have no tool, and neither does `approve`, Slack's or core's: under `confirm`,
approving a post or a change is a person at their own terminal, with the command the result gives.

## Moving a workspace to `send`

This is a **widening**: a change the person approves. Do it when they ask for it, never on your own
initiative. For an account with organisation provenance, `agent-slack workspace mode <name> send`
(`slack_mode_set` with `mode: "send"`) signs in through the profile's send app after approval.
The person then grants Slack consent and finishes with `slack_workspace_finish` (CLI:
`agent-slack workspace reauth <name> --finish <flowId>`). No manifest edit, `app update`, or
`--app-updated` step applies to the organisation's apps.

For a person's own app, the two-step procedure remains, in this order:

1. **The app.** A token can only be granted what its app declares, so the app's manifest has to be the `send` one
   first. While the workspace's recorded grant has no posting scope, nothing on this machine can show the app was
   updated, so the command returns `appUpdateNeeded` with the manifest and the link to that app's own manifest page,
   `https://api.slack.com/apps/<appId>/app-manifest`, and starts nothing. Pasting it there and saving is the
   person's step — edit the app the workspace already uses, never a new one, which changes no installation. With an
   app configuration token they can do it at a terminal instead: `agent-slack app update <name> --mode send`, the
   `terminalAlternative` the result names. Never ask for that token in the chat.
2. **The change.** Once they say the app is saved, run it again with `--app-updated` (`appUpdated: true`). It is a
   change approval — show the preview and ask — and once approved it starts a sign-in: the person approves that in
   Slack, and `slack_workspace_finish` (at a terminal, `agent-slack workspace reauth <name> --finish <flowId>`)
   records the new token.

If Slack grants no posting scope to an own-app account at the end, its manifest was not updated after all — saved on another app, or
not saved — and nothing is recorded; the refusal says so and how to do step 1.
`agent-slack workspace reauth <name> --mode send` (`slack_workspace_reauth` with `mode: "send"`) is
the own-app change without step 1's check. For a provenance account, replacement reauth uses its
profile app for the requested mode; after the organisation updates a replaced app, reauthorise
through that app rather than editing it locally.

`agent-slack workspace mode <name>` (`slack_mode`) reports where a workspace stands and prints the
steps for its account type. An own-app workspace signed in with 0.4.1 or later remembers its port, so `--port` can be left out of `workspace reauth`,
`workspace mode` and `manifest --workspace`, which use the recorded one. `agent-slack manifest` without
`--workspace` names no workspace, so it has no recorded port to use and needs `--port` given. An older workspace
has none recorded either, so give `--port` there too: its steps print `<port>` until it is given one.

## Going back to `read`

For an account with organisation provenance, `agent-slack workspace mode <name> read`
(`slack_mode_set` with `mode: "read"`) starts immediately through the profile's read app, then the
person grants Slack consent and `slack_workspace_finish` completes it. This narrowing needs no
change approval, manifest replacement, or app removal. The old access and refresh tokens are
revoked separately after the new credential is stored; a pending revocation is reported and retried
by `doctor` until Slack confirms it or its fixed expiry deadline passes. Token revocation never
uninstalls an app.

For a person's own app, Slack **adds** scopes to a token and never removes one. `auth.revoke` leaves
the installation intact under token rotation, and only `apps.uninstall` resets it — which needs the
client secret this package never stores. So own-app narrowing remains the person's procedure:

1. Replace the app's manifest with the `read` one.
2. In Slack: **Workspace settings → Manage apps → the app → Remove app.** This is the step that actually resets
   the scopes.
3. `agent-slack workspace reauth <name> --mode read --port <port>` — the person grants Slack consent,
   then finishes the sign-in. Use `reauth`, not `add`, so the name and its history are kept.

For an own-app account, `agent-slack workspace mode <name> read` (`slack_mode_set` with
`mode: "read"`, or `slack_mode_narrow`) prints exactly this and changes nothing.

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

- **Starting an own-app widening before the app is updated.** Slack grants what the app declares, so a
  `send` sign-in through a `read` app comes back `read` and nothing is recorded. Do the own-app
  manifest step first; `workspace mode <name> send` enforces the order.
- **Claiming an approval the person did not give.** Under `chat` their yes is the approval, and nothing can tell it
  from yours; call the tool with `approvalId` only after they said yes to that preview. Under `confirm` you cannot
  claim it at all until they have run the approve command the result gave.

- **An own-app port mismatch between the manifest and `workspace add`.** The sign-in completes at Slack and then fails to
  return. Check both numbers say the same thing.
- **Creating a second own app instead of editing the first.** A new app is a new installation; the old one still has
  the old scopes and the workspace still behaves as it did. For a workspace already connected, that is `app
  update`, never `app create`.
- **Reading an updated own app as a widened workspace.** `app update --mode send` changes what the app may ask for,
  not what the workspace's token can do.
- **Forgetting that own-app `app update` replaces the app's whole configuration.** Slack's update writes the manifest as
  given, so a name or description somebody set by hand comes back as `agent-slack`.
- **Reading `read` mode as a guarantee about the machine.** It is a guarantee about this package's token.
- **Assuming an own-app scope came back after a narrowing reauth.** It did not, unless the app's
  installation was removed in Slack first. That step is not optional for an own-app account.
- **Reusing a replaced profile app without reauth.** After the organisation updates its profile,
  reauthorise through the replacement app for the account's current mode. Do not edit or remove the
  organisation's apps yourself.
- **Treating pending revocation as completed.** A profile app move stores the new grant before it
  attempts to revoke the old access and refresh tokens separately. An unconfirmed result stays
  pending with a fixed deadline; run `agent-slack doctor` (`slack_doctor`) to retry and report each
  token's state. Revoking tokens never uninstalls the old app.
