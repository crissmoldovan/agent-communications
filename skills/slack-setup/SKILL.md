---
name: slack-setup
description: "Connect a Slack workspace to agent-slack: the app manifest, the PKCE sign-in, read and send modes, and what doctor reports. Symptoms: 'connect my Slack', 'set up agent-slack', 'why can't it post', 'move this workspace to send mode', 'agent-slack doctor says something is wrong'. Not for reading or posting once it works — slack-reading and slack-posting do those."
license: MIT
compatibility: "@agentcomms/slack@0.4.0"
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

Two fields in that manifest are load-bearing: `oauth_config.pkce_enabled` and `token_rotation_enabled`. Without
PKCE, Slack treats a loopback redirect like a server redirect and no sign-in can complete. Both were verified
against a real workspace on 2026-09-22.

## Connecting

```sh
agent-slack workspace add acme/slack --client-id <id> --port 51234
agent-slack workspace list
agent-slack doctor
```

The name is `organisation/platform` — `acme/slack`, `rgc/slack`. A flat name is refused with an example.

No client secret is stored anywhere, ever. PKCE is what proves the exchange, and the verifier never leaves the
machine that generated it.

## Connecting it to your agent

The workspace is connected; the agent is not, until the MCP server is registered with its client:

```sh
agent-slack mcp install --client claude-code
agent-slack mcp install --client cursor --workspace acme/slack   # pinned to one workspace
```

`--client` also takes `codex`, `claude-desktop`, `gemini`, `vscode` and `json` (print the entry to paste by hand).
The entry pins the exact version it was installed from, so a newer release reaches the agent only when it is
registered again with `--force`; restart the client afterwards. Each version installs its own runtime, and the old
one stays; `agent-slack mcp prune` removes those no client registers and no process is running (`--dry-run` lists
them first). Without the server the skills still work, through `agent-slack … --json`.

What the agent gets is reading, drafting and preparing — never posting:

| MCP tool | CLI |
|---|---|
| `slack_workspaces_list` | `agent-slack workspace list` |
| `slack_mode`, `slack_mode_request_send`, `slack_mode_narrow` | `agent-slack workspace mode <name> [send\|read]` |
| `slack_channels`, `slack_read`, `slack_thread`, `slack_search`, `slack_people`, `slack_files` | the commands of the same name — see `slack-reading` |
| `slack_post_prepare`, `slack_draft_list`, `slack_draft_get`, `slack_draft_delete` | `agent-slack draft …` and `agent-slack post prepare` — see `slack-posting` |

`slack_mode_request_send` and `slack_mode_narrow` return steps for a person and change nothing.

## Moving a workspace to `send`

This is a **widening**, and an agent never does it. It takes two steps, in this order:

1. Update the existing app's manifest at api.slack.com to the `send` one:
   `agent-slack manifest --mode send --port <port>`. Edit the app you already have — do not create another, which
   changes no installation.
2. `agent-slack workspace reauth <name> --mode send --port <port>`, which asks a person to type a challenge.

`agent-slack workspace mode <name>` reports where a workspace stands and prints these steps.

## Going back to `read`

Slack **adds** scopes to a token and never removes one. `auth.revoke` leaves the installation intact under token
rotation, and only `apps.uninstall` resets it — which needs the client secret this package never stores. So going
back is a person's procedure, not a command:

1. Replace the app's manifest with the `read` one.
2. In Slack: **Workspace settings → Manage apps → the app → Remove app.** This is the step that actually resets
   the scopes.
3. `agent-slack workspace reauth <name> --mode read --port <port>` — `reauth`, not `add`, so the name and its
   history are kept.

`agent-slack workspace mode <name> read` prints exactly this and changes nothing.

## What `doctor` checks

- the stored credential's state, and whether a refresh is due or was interrupted;
- the granted scopes against the mode, measured from what **Slack reports**, not from what was recorded at
  sign-in;
- who the token actually is, via `auth.test` — the only check that can tell a revoked token from a working one,
  because everything else reads files this package wrote;
- other Slack MCP servers registered on this machine. Where it says *not checked*, it could not look, and that is
  not the same as "none": open the client's MCP server list and look for another Slack entry yourself.

`--offline` skips the one network call, so a person diagnosing a machine with no network still gets everything
the files can say.

## Pitfalls

- **A port mismatch between the manifest and `workspace add`.** The sign-in completes at Slack and then fails to
  return. Check both numbers say the same thing.
- **Creating a second app instead of editing the first.** A new app is a new installation; the old one still has
  the old scopes and the workspace still behaves as it did.
- **Reading `read` mode as a guarantee about the machine.** It is a guarantee about this package's token.
- **Assuming a scope came back after a narrowing reauth.** It did not, unless the app's installation was removed
  in Slack first. That step is not optional and is the one people skip.
