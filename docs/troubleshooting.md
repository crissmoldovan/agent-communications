# Troubleshooting

Run this first. It checks everything that has to work and prints the one command that fixes each thing that does
not. Slack has its own — see [Slack](#slack) at the end.

```bash
agent-gmail doctor
agent-gmail doctor --json | jq '.data.checks[] | select(.status != "ok")'
```

It exits `0` when nothing is broken and `78` when something is, so CI can gate on it. Warnings do not fail it.

## Setting up

### `no OAuth client registered`

Nothing has been connected yet. See [Getting started](getting-started.md), or if you already run another Gmail MCP
server, `agent-gmail inbox import` reuses its credentials with no browser step.

### `invalid_client` when finishing a sign-in

The client JSON is not the one the consent screen belongs to, or it is the wrong type. It must be an **OAuth client
ID** of type **Desktop app**, downloaded from the project whose consent screen lists you as a test user.

### `redirect_uri_mismatch`

The client is not a Desktop app — Web application clients require a registered redirect URI, and this signs in on a
loopback address. Create a Desktop client, then:

```bash
agent-gmail client add ~/Downloads/client_secret_*.json --name desktop
agent-gmail inbox reauth <alias> --client desktop --start
```

### The browser never comes back

`--start` returns immediately and prints a `--finish` command; the listener runs in a detached process. If it is
not being caught:

- **A blocked port.** The listener binds a loopback port; a firewall or VPN can stop the redirect reaching it.
  Paste the redirect URL instead: `agent-gmail inbox add <alias> --finish <flowId> --url '<the URL from the bar>'`.
- **The flow expired.** Flows are short-lived. Start again.

### `Access blocked: … has not completed the Google verification process`

Error 403, `access_denied`, at the sign-in screen — often noticed as "it will not let me use any address except
the one I built the project with".

Both are the same setting. While the app's publishing status is **Testing**, only the project owner and accounts
explicitly listed as test users may consent, and every other address is refused outright. Publishing lifts that,
and asks nothing of you:

Open [console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience) → **PUBLISH APP** →
confirm. The status then reads **In production**. Sign in again and it goes through.

Publishing submits nothing for review. Verification is a separate thing and only applies past 100 accounts. The
other consequence of leaving it in Testing is that any sign-in which *does* work expires seven days later.

### `that sign-in was <other address>`

Google's account chooser offered an account you were already signed into. Nothing was saved. Run it again choosing
the right account, or pass `--email you@example.com` so it refuses anything else.

## Day to day

### `no inbox called "x"`

`agent-gmail inbox list` shows the names. Exit code `66`.

### A mailbox stopped working after a few weeks

A refresh token can be revoked by a password change, by an admin, by six months of disuse, or by the OAuth client
being deleted. `doctor` says which mailbox and why.

```bash
agent-gmail inbox reauth <alias> --start
```

### `doctor` says `missing: openid, …/userinfo.email` on every mailbox

Those two come from a sign-in this tool performed. A mailbox brought over by `inbox import` carries whatever the
previous server asked for, and most legacy servers never asked for these. Nothing is broken: the mailbox still
resolves its own address from the Gmail profile, which is why every `Mailbox <alias>` check passes.

`agent-gmail inbox reauth <alias> --start` takes them, keeping the existing access tier.

### `SCOPE_MISSING`

The grant does not cover what was asked. The error names the scope and the fix. A mailbox connected without
address-book access can still search history — contact search just returns fewer sources, and says so.

```bash
agent-gmail inbox reauth <alias> --tier organize --start   # to label and archive
agent-gmail inbox reauth <alias> --contacts --start        # to search contacts
```

A re-consent keeps the mailbox's existing contacts setting unless you name `--contacts` or `--no-contacts`.

### `contacts` search returns `complete: false` and I have not lost anything

A mailbox without address-book access reports `SCOPE_MISSING` in `errors`, which makes `complete` false. That is a
mailbox that worked and was only allowed to search one of its three sources — not a mailbox that failed. Read the
code before calling it an outage.

### The secret store is unavailable

Exit `69`. On Linux the keychain is Secret Service, which needs a session keyring unlocked; over SSH or in a
container there may not be one. Either unlock it, or move to owner-only files:

```bash
agentcomms secrets migrate --to file
```

Moving credentials out of the keychain loosens how they are kept, so it shows what it will move and asks you to
approve it: at a terminal by typing `yes` (or the code it shows, under the `confirm` change policy). An agent gets the
preview and an approval id and exits `10`; after your yes it runs the same command with `--approval <id>`, or calls
`comms_secrets_migrate` again with it.

### Rate limits

Exit `75`. Gmail's per-user quota is generous but finite, and a wide search over many mailboxes spends it quickly.
The transport already backs off and retries. Narrow the query or the mailbox list.

## Sending

### `approval required`

Working as intended. Exit `10`. A send needs `send prepare`, then your approval, then `send execute`. See
[Sending and approvals](sending.md).

### `the draft changed since it was approved`

The approval is bound to the draft's Gmail message id, which changes on every save. Something edited the draft
after the preview. Prepare again and read the new preview — do not reuse the old approval, which is the point.

### `this mailbox is set to never send`

The policy for that mailbox is `never`. The draft is in Gmail; send it from the Gmail app. Changing the policy is a
loosening: it is prepared, shown to you, and made only once you approve it — in the conversation, or at a terminal
when the mailbox's change policy is `confirm`.

### An agent sent mail without asking me

Check this package's audit log first:

```bash
npx -y @agentcomms/core audit tail --inbox <alias>
```

A `send.execute` line means it went through this package: under the `chat` policy the agent's claim that you said
yes is all a send needs, and nothing here can check it. A `change.claim` line whose paths end in `sendPolicy` means
the mailbox's policy was loosened, and its reason says whether that was approved in chat or at a terminal. Under the
default `chat` change policy an agent can do that on its own claim too; `agentcomms policy confirm` puts it behind a
code you type.

If neither is there, something else sent it. Check for another Gmail MCP server:

```bash
agent-gmail doctor --json | jq '.data.checks[] | select(.id == "other-gmail-servers")'
```

Everything here assumes it owns the only route to Gmail's send endpoints. Another server with an ungated send tool
does not break that guarantee so much as stand beside it.

## Agents and MCP

### The client does not see the tools

Restart it. MCP clients read their server list at startup.

If it still has no Gmail tools, check whether the server is registered with that client, and whether it starts:

```bash
agent-gmail doctor --json | jq '.data.checks[] | select(.id == "mcp-command")'   # one per registered entry
agent-gmail mcp install --client claude-code   # when none of them is for that client
```

A plain `mcp install` is refused for a name that is already registered, and its hint is the command that replaces
the entry as it is. When an entry is there and broken, its check's `fix` is that command too: `mcp install` with
the entry's own `--name`, `--inbox` and `--read-only`, and `--force`. Run that `fix` as it is.

### `mcp install` fails on Windows

`agent-gmail mcp install --client claude-code` (and `--client codex`) appears not to work on Windows at all, for
any version. Both CLIs install there as `.cmd` files, and this package launches them without a shell, which
current Node refuses to do for a `.cmd`.

Register the server by hand instead — `mcp install --print` writes no config and prints exactly what to add:

```bash
agent-gmail mcp install --client claude-code --print
```

Then paste that entry into the client's own config, keeping the `env` block: it carries
`AGENT_COMMS_CONFIG_DIR`, and a server without it looks in the wrong directory and reports no mailboxes.

The `--client json` output is the same entry with no client assumed, if your client stores servers somewhere
else.

### The server is running an old version

`mcp install` pins the exact version into the path it registers, deliberately: upgrading the package elsewhere on
the machine cannot then change what your agents run underneath you. The cost is that publishing a new version does
nothing for an already-registered client until you re-register it.

Check what is registered against the release you are asking about. `doctor` compares with its own version, so run
the new one:

```bash
npx -y @agentcomms/gmail@latest doctor --json | jq '.data.checks[] | select(.id == "registered-server-version")'
```

Checks are selected by `id`, which is stable; `title` is wording and can change. A `warn` names each stale entry,
and its `fix` is the command that re-registers that entry as it is — keeping its `--name`, `--inbox` and
`--read-only` — rather than a default one. Run that fix with the new version:

```bash
npx -y @agentcomms/gmail@latest mcp install --client claude-code --force    # plus the flags doctor's fix carries
npx -y @agentcomms/slack@latest mcp install --client claude-code --force    # the Slack server, the same way
```

`--force` removes the existing entry of that name first; Claude Code refuses to add a server whose name is already
taken, so without it the upgrade stops at "already exists". It never widens the entry it replaces: a pin
(`--inbox`, `--workspace`) or `--read-only` that entry had and the command leaves out is kept, and the result says
so in a warning; one you pass instead wins. To register a wider server on purpose, remove the entry with the
client's own command (`claude mcp remove gmail --scope user`, say) and then install. Check that the result says
the entry was registered and the server verified: for Claude Code and Codex the entry is written through their own
CLI, and if `claude` or `codex` is not on `PATH` the install prints the entry for you to add instead of
registering it.

Restart the client afterwards — a running client keeps the server it started. Each version installs into its own
directory under `<data dir>/runtime/` (`npx -y @agentcomms/core@latest paths` shows the data dir):
`<version>-gmail/` and `<version>-slack/`, or plain `<version>/` for a Gmail runtime an earlier release installed.
`mcp prune` deletes the old ones, and only those it can show are unused. It keeps this release's; any runtime an
entry names in a client config it reads; any runtime it printed an entry for (`--client json`, `--print`, or a
client whose CLI was not on `PATH`), because it cannot see where that entry was pasted; and any runtime a running
process started from. The configs it reads are Claude Code's `.claude.json` (under `CLAUDE_CONFIG_DIR` when that
is set) and the `.mcp.json` of each project listed in it, Claude Desktop's config, codex's `config.toml` (under
`CODEX_HOME` when that is set), Cursor's `~/.cursor/mcp.json`, Gemini CLI's `~/.gemini/settings.json` and VS
Code's user `mcp.json` — and, beside those, every config `mcp install` recorded registering into or printing for,
as it resolved them then. So a second Claude account kept under its own `CLAUDE_CONFIG_DIR`, or codex under
another `CODEX_HOME`, is read even from a shell that does not set it, and a runtime kept for it says in which file.
The record starts with 0.4.1, so an entry an earlier release registered there is not in it until it is registered
again.
If any of those is there and cannot be read, or the processes cannot be listed, it removes nothing at all and says
which. A recorded config that is no longer there keeps nothing. What it cannot see is an entry you put by hand
anywhere else — a workspace `.vscode/mcp.json` or `.cursor/mcp.json`, say — or pasted from a `--print` that warned
it could not record the entry; check `--dry-run` first if you have one. A runtime kept only because its entry was
printed stays until you say that entry is gone: `mcp prune --include-printed` removes those too, and still keeps
anything a config it reads or a running process names. Run it once the clients have been restarted:

```bash
npx -y @agentcomms/gmail@latest mcp prune --dry-run
npx -y @agentcomms/gmail@latest mcp prune
npx -y @agentcomms/slack@latest mcp prune
```

### The server starts but every call fails

The server and the CLI share one config directory. If the CLI works and the server does not, the client is likely
starting it with a different `AGENT_COMMS_CONFIG_DIR` or a different `HOME`.

```bash
agent-gmail doctor          # as you
agent-gmail mcp install --client <name> --force   # rewrites the entry with the right paths
```

`--force` replaces only an entry this package wrote, and a plain `mcp install` is refused while one is there. It
keeps the `--inbox` and `--read-only` of the entry it replaces unless you pass others. If the entry was registered
under its own `--name`, pass that again — another name is another entry — or run the `fix` that `doctor` prints
for it, which carries every one of them.

### An agent asks for approval in a form instead of the terminal

That mailbox is on `confirm`, and the client has been trusted to show forms to a person. If you did not do that:

```bash
agent-gmail confirm-clients list
agent-gmail confirm-clients remove <name>
```

An agent can do the same from chat — `gmail_confirm_clients`, then `gmail_confirm_client_remove` — because
trusting fewer clients needs nobody's approval.

## Reading and reporting

### A message body looks shorter than it should

The sanitiser removes what a reader would not see and counts what it removed. The counters are in every read
result:

| Counter | What it means |
|---|---|
| `hiddenChars` | text that was removed |
| `invisibleCharsRemoved` | zero-width and bidi characters, removed |
| `sameColorElements` | text whose colour matched its background — **kept**, not removed |
| `unreadableHidingRules` | a rule the parser could not resolve; may mean hidden text remains, or may be ordinary CSS |
| `tokensNeutralised` | chat-template tokens defused, counted for every body |

A message with any of these above zero was doing something worth mentioning. Only the first two mean text was
withheld.

### `truncated: true` on a thread

Either the budget ran out across messages, or one message's body was cut. The flag does not distinguish the two:
compare `messageCount` against the messages returned, and check each message's own `body.truncated`. Use
`agent-gmail export` to write the whole thing to a file instead of pulling it through a conversation.

## Slack

`agent-slack doctor` is the Slack equivalent, and exits `78` the same way. `--offline` skips the one call it makes
to Slack.

### The sign-in completes at Slack and never comes back

The port in the app's manifest and the port given to `workspace add` differ. Slack matches redirect URLs exactly,
so they must be the same number: `agent-slack manifest --port 51234` and
`agent-slack workspace add acme/slack --client-id <id> --port 51234`.

### The agent has no `slack_*` tools

The workspace is connected but the server is not registered with the client:

```bash
agent-slack mcp install --client claude-code
```

Then restart the client. Without the server the Slack skills fall back to `agent-slack … --json`.

### It will not post

That is usually correct. A workspace in `read` mode holds a token Slack will not let post; no setting here changes
that. `agent-slack workspace mode <name>` says which mode a workspace is in and prints the steps to move it: the app's
manifest first, which is the person's to change, then `workspace mode <name> send --app-updated` (`slack_mode_set`
from a chat), a change the person approves before a new sign-in starts. In `send` mode a post goes out only once its approval allows it: `slack_post_prepare` returns a
preview, and `slack_post_send` (or `agent-slack post send`) posts it after a yes under `chat`. Under `confirm`, and for
any broadcast or room of fifty or more, it waits with `APPROVAL_PENDING` until the person runs `agent-slack approve`
in their own terminal. Under `never` nothing posts.

### A prepared post was refused because the room grew

The words did not change, but who reads them did, so the approval is void and nothing was posted. Prepare it again
and read the new count.

### Drafts are piling up

Every prepare leaves a local draft. `agent-slack draft list --workspace <name>` shows them and
`agent-slack draft delete <draftId> --workspace <name>` removes one; over MCP, `slack_draft_list` and
`slack_draft_delete`.

## Still stuck

`agent-gmail <command> --help` for any command, [the CLI reference](reference/cli.md) for all of them, and
`--json` on anything gives a structured error with a `code` and a `hint`.
