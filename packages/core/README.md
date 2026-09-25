# @agentcomms/core

The provider-neutral core of [agent-communications](https://github.com/crissmoldovan/agent-communications): the
config and inbox registry, the secret store (OS keychain or owner-only files), the send-approval engine, the audit
log, path jails, and the untrusted-content envelope and HTML sanitiser that keep what a sender wrote — an email or
a Slack message — from steering an agent.

Most people want a platform package instead: `npx @agentcomms/gmail --help` or `npx @agentcomms/slack --help` — or
this package's MCP server, which installs those for an agent.

## The `agentcomms` command

```sh
npx @agentcomms/core paths      # where config, state and downloads live
npx @agentcomms/core doctor     # Node version, directory permissions, secret store
npx @agentcomms/core audit tail # every mailbox write and Slack prepare or post, newest last (no bodies, no secrets)
npx @agentcomms/core approvals list
npx @agentcomms/core approve <id>  # approve a settings change an agent prepared: read it, type the code it shows
npx @agentcomms/core policy        # the change policy: how a loosening is approved — chat or confirm
npx @agentcomms/core channels      # which servers exist, which are installed, and where each is registered
npx @agentcomms/core mcp install --client claude-code   # register the core MCP server
```

Every command takes `--json` and prints `{ "ok": true, "schemaVersion": 1, "data": … }` or
`{ "ok": false, "schemaVersion": 1, "error": { "code", "message", "hint" } }`.

A command that changes something — `policy chat|confirm`, `mcp install`, `mcp prune`, `secrets migrate`,
`names migrate` — shows the change first. At a terminal you approve it there; anything else gets the preview and an
approval id and exits `10`, and runs the same command again with `--approval <id>` once the person has agreed.

## The core MCP server

`agentcomms mcp` runs it on stdio; `agentcomms mcp install --client <client>` registers it, from a terminal, since it
is the one registration that cannot come from chat. After a restart of the client, an agent can do the rest:

| Tool | What it does |
|---|---|
| `comms_channels_available` | which servers exist — core, Gmail, Slack — which are installed and at which version, and which clients start each |
| `comms_server_install` | register the Gmail, Slack or core server with a client; the server appears once the client restarts |
| `comms_server_prune` | remove the managed runtimes old releases left behind; `dryRun` lists them |
| `comms_change_policy` | report or set the change policy of the defaults, a mailbox or a workspace |
| `comms_names_migrate` | rename every account to `organisation/platform`; `dryRun` shows the mapping |
| `comms_secrets_migrate` | move every credential between the keychain and files |
| `comms_paths`, `comms_doctor`, `comms_audit_tail` | as `paths`, `doctor` and `audit tail` |
| `comms_approvals_list`, `comms_approval_revoke` | as `approvals list` and `approvals revoke` |

Every change is shown to a person before it happens: the first call returns a preview and an approval id, and the
same tool called again with that id applies it — after the person's yes in the conversation under the `chat` change
policy, or after they run `agentcomms approve <id>` under `confirm`. No tool approves a change, and none applies a
change it did not plan itself.

## Licence

MIT
