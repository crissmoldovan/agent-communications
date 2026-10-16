# @agentcomms/core

The provider-neutral core of [agent-communications](https://github.com/crissmoldovan/agent-communications): the
config and inbox registry, the secret store (OS keychain or owner-only files), the approval engine for sends, posts
and configuration changes, the audit log, path jails, and the untrusted-content envelope and HTML sanitiser that
keep what a sender wrote — an email or a Slack message — from steering an agent.

Most people want a platform package instead: `npx @agentcomms/gmail --help` or `npx @agentcomms/slack --help` — or
this package's MCP server, which installs those for an agent.

## The `agentcomms` command

```sh
npx @agentcomms/core paths      # where config, state and downloads live
npx @agentcomms/core doctor     # Node version, directories, secret store, registrations and managed CLI shims
npx @agentcomms/core audit tail # mailbox writes, Slack prepares and posts, and every step of a change, newest last (no bodies, no secrets)
npx @agentcomms/core approvals list
npx @agentcomms/core approve <id>  # approve a change at your terminal: run the command the result gives, as given
npx @agentcomms/core policy        # the change policy: how a loosening is approved — chat or confirm
npx @agentcomms/core attach        # which files may be attached: the folders, your deny entries, the built-in list
npx @agentcomms/core attach roots add ~/Documents/outgoing  # allow another folder (a change you approve)
npx @agentcomms/core label         # how what an agent sends is labelled — "Jo Example (agent)" — on each account
npx @agentcomms/core label word twin   # the word after your name: agent, assistant, twin, minion, bot, fake or AI (you approve it)
npx @agentcomms/core label name "Jo Example"  # your name, for where a channel has none of its own (you approve it)
npx @agentcomms/core label rule add acme/slack --kinds reaction --as me  # reactions sent as you, unlabelled (you approve it)
npx @agentcomms/core label icon acme/slack :jo-agent:  # the workspace emoji the app's Slack posts show (you approve it)
npx @agentcomms/core channels      # which servers exist, which are installed, and where each is registered
npx @agentcomms/core mcp install --client claude-code   # register the core MCP server
npx @agentcomms/core mcp install --server events --client claude-code   # register the events MCP server
npx @agentcomms/core update --check  # what is behind the latest release; `update` brings it there, as one change
npx @agentcomms/core update --later  # not now: no notice of the update until midnight (a change you approve)
npx @agentcomms/core update --auto off  # no daily update check on this machine (a change you approve); --auto on
```

**Once a day this machine asks npm whether a newer release is out.** Nothing is ever stopped for it. When one is, a
server's first tool result carries one line beside it (an `update` field), and a command prints the same line once on
stderr, at most once a day for the machine, and runs. `update`, `doctor`, `paths`, `approve`, `approvals` and `mcp` on
its own never print it. A registry that cannot be reached changes nothing. The check is skipped when `CI` is set, or
`AGENT_COMMS_UPDATE_CHECK=off`; `doctor` shows it on one line.

Every command takes `--json` and prints `{ "ok": true, "schemaVersion": 1, "data": … }` or
`{ "ok": false, "schemaVersion": 1, "error": { "code", "message", "hint" } }`.

A command that loosens something or cannot be undone — `policy chat`, `attach roots add`, `attach deny remove`,
`label word`, `label name`, `label icon`, `label rule add --as me`, `label rule remove --as agent`, `mcp install`,
`mcp prune`, `update`, `secrets migrate`, `names migrate` — shows the change first (`policy confirm`,
`attach roots remove`, `attach deny add`, `label rule add --as agent` and `label rule remove --as me` tighten, so they
apply at once). At a terminal you approve it there; anything else gets the preview and an
approval id and exits `10`, and runs the same command again with `--approval <id>` once the person has agreed.
Every channel CLI, and the declared events service through core, registers and prunes its server through the same change, so an approval
`comms_server_install` or `comms_server_prune` prepared is claimed by their `mcp install` or `mcp prune` for the same
request, and the other way round.

A managed install also writes the package's CLI shim in `~/.local/bin` on macOS/Linux. It starts that managed runtime
with the locator's Node and entry. Updates repoint an owned shim, prune removes it with the runtime, and `doctor`
reports one that is missing, stale or foreign. A foreign file is never overwritten or removed; a symlinked bin
directory works, but a directory redirected during an operation is refused before the mutation. If the directory is
not on `PATH`, the install result shows how to prepend it for the current shell without editing a profile. Windows
shims are not offered yet because `.cmd` forwarding makes `cmd.exe` re-parse caller arguments; use the full-path
command or the labelled PowerShell `&` line the result provides.

## The core MCP server

`agentcomms mcp` runs it on stdio; `agentcomms mcp install --client <client>` registers it, from a terminal, since it
is the one registration that cannot come from chat. After a restart of the client, an agent can do the rest:

| Tool | What it does |
|---|---|
| `comms_channels_available` | which declared servers exist — core, Gmail, Resend, Slack, WhatsApp and events — which are installed and at which version, and which clients start each |
| `comms_server_install` | register a declared channel or service server with a client; the server appears once the client restarts |
| `comms_server_prune` | remove the managed runtimes old releases left behind; `dryRun` lists them |
| `comms_update` | what is behind the latest release (`check`), and bringing every registration, runtime and global package there as one change; `later` puts the daily check's stop off until midnight, `auto` turns the check on or off |
| `comms_change_policy` | report or set the change policy of the defaults, a mailbox or a workspace |
| `comms_attach` | which files may be attached, as `attach`; `rootsAdd` allows another folder once the person approves, and `rootsRemove`, `denyAdd` and `denyRemove` change the rest |
| `comms_label` | how what an agent sends is labelled, as `label`; `word`, `name`, `icon`, `addRule` with `as: "me"` and `removeRule` of an `agent` rule are approved first, and the other rule changes apply at once |
| `comms_names_migrate` | rename every account to `organisation/platform`; `dryRun` shows the mapping |
| `comms_secrets_migrate` | move every credential between the keychain and files |
| `comms_paths`, `comms_doctor`, `comms_audit_tail` | as `paths`, `doctor` and `audit tail` |
| `comms_approvals_list`, `comms_approval_revoke` | as `approvals list` and `approvals revoke` |
| `comms_approval_wait` | as `approval wait`: where an approval stands, now or once it changes — it only looks |

Every change is shown to a person before it happens: the first call returns a preview and an approval id, and the same
tool called again with that id applies it — after the person's yes in the conversation under the `chat` change policy,
or after they run the approve command the result gives under `confirm`. No tool approves a change, and none applies a
change it did not plan itself.

## Licence

MIT
