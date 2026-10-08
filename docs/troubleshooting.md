# Troubleshooting

Run this first. It checks everything that has to work and prints the commands or actions that fix each thing that
does not, one command per line when several are needed. Slack has its own — see [Slack](#slack) at the end.

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

`--start` returns as soon as its listener is ready — normally about a second, at most thirty — and prints a
`--finish` command; the listener runs in a detached process. If it is
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

If the mailbox should move onto an organisation profile's client, read the active generation with `agentcomms org
show <organisation>` and make it explicit: `agent-gmail inbox reauth <name> --client <organisation>-1 --start`.
Use the generation name that `org show` reports.

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

A **send** that Gmail rate-limits is tried again by `send execute` itself: Gmail's answer proves nothing was sent, so
it waits the time Gmail gives, reads the draft again and tries up to three more times within 45 seconds. Resend sends do
the same on Resend's `rate_limit_exceeded`. Only when that runs out does the send stop, with "nothing was sent: Google is
rate-limiting this account (tried 4 times)" and the time to try after. Prepare it again then. Two limits are never
waited on, because they last hours:

- **"Gmail's sending limit for this account is reached"** (exit `75`): the account's daily sending limit, shared with
  every other client of the mailbox. The hint says when Google accepts mail again. It cannot be raised from here.
- **"this Google Cloud project's daily Gmail API quota is used up"** (exit `78`): the OAuth client's project, not the
  mailbox. Raise it in the Google Cloud console (APIs & Services → Gmail API → Quotas). Signing in again changes
  nothing; up to 0.15.0 this was wrongly reported as an authorisation problem.
- For Resend, **the team's daily sending quota** resets at midnight UTC and **the monthly quota** needs a larger plan;
  both stop at once and say so.

## Sending

### `approval required`

Working as intended. Exit `10`. A send needs `send prepare`, then your approval, then `send execute`. Under `confirm`
the approval is yours, outside the chat: "This needs your approval outside the chat: run … in a terminal, and I will
wait with gmail_send_wait." Run the command it gives, exactly as given, within thirty minutes; the agent learns that
you have by waiting, and sends — you never need to tell it. See [Sending and approvals](sending.md).

### `this approval expired; nothing was sent with it`

Nothing was sent. An approval waits ten minutes for a yes in the chat and thirty for you at a terminal, and once you
approve it there it holds for 24 hours; the message says when it was prepared — or approved — and when it expired.
Prepare it again; the preview is the full one. If it says "the clock moved backwards", the computer's clock went back
past the approval, and it was expired to be safe.

### `SEND_OUTCOME_UNKNOWN`

Exit `10`, and never retried: Gmail's (or Slack's, or Resend's) answer to the send was lost — a dropped connection, a
timeout, a server error — so it **may have gone**. Look in Sent (the channel, for Slack; `agent-resend send status
<approvalId>` and the Resend dashboard, for Resend) before anything else. Its approval reads `sending`, then
`unknown` once its two-minute lease runs out, and the process that sent it may still record a late result. Do not
prepare it again until you know it did not go: a second prepare is a second message.

### `being sent by another call since …; wait for it`

Another process is sending that approval right now, renewing its lease every thirty seconds — a Slack post with large
files can take many minutes. Wait: `agent-gmail send wait <approvalId>` (or the channel's own wait) says when it has
finished, as `used`, `failed` or `unknown`. Do not prepare it again meanwhile.

### `sent; the provider returned no id`

The provider accepted the send but gave no id for it, so there is no message id to quote and nothing is made up. The
approval stays `sending`, then reads `unknown`; look in Sent, or the channel, to see the message. For a scheduled
Resend email the words are "accepted (scheduled); the provider returned no id".

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

### A command a result gave you is not found

From 0.13.1, every command a result hands you to run — an `approve`, a change run again with `--approval`, a
repair — names the Node and the file of the installation that printed it, with the suite folders that command uses
pinned: `--config-dir`, `--state-dir`, `--data-dir` and `--secrets-dir`, and `--downloads-dir` for one that saves
files. It runs as pasted, from any folder, with nothing of this suite on your `PATH`. Two cases say so themselves:

- **Words to type.** Where one of its words cannot be written the same way for cmd.exe and both PowerShells, the
  command comes as words to type: its words in JSON, with what to do — type them, each quoted for your shell. On
  Windows that is the usual case when Node is installed under `C:\Program Files`, the default, because that path
  needs quotes; Node from nvm-windows, Volta or a tool cache gives a line to paste.
- **None here.** A command of another product — Slack's, from core, say — is found among the servers registered
  with your MCP clients, at exactly this release, and never through npx. With no such registration there is no
  command: the result names the product and the release it needs, and says it is not locatable here. Install or
  update that product the way you usually do, then try again.

0.13.0 and earlier printed bare names — `agentcomms approve <id>`, `agent-gmail approve <id>` — which run only where
that package is installed globally. Those releases cannot be changed now; updating is the fix. Until then there are
two ways round, both best effort:

1. **A managed registration**, the one `mcp install` writes by default: your client's configuration names an
   absolute Node and an entry under the data folder,
   `<data dir>/runtime/0.13.0-<product>/node_modules/@agentcomms/<product>/dist/cli.mjs`. Run that Node with that
   entry, then the words after the bare name:

   ```bash
   "<the node your client's configuration names>" "<data dir>/runtime/0.13.0-<product>/node_modules/@agentcomms/<product>/dist/cli.mjs" approve <id>
   ```

   This does not cover a global install or a checkout: there, find your own Node and the package's `dist/cli.mjs`
   (`src/cli.ts`, with `--experimental-strip-types`, in a checkout).
2. **Where npx is installed**, the exact package and release that printed it, never a newer one:

   ```bash
   npx -y @agentcomms/<product>@0.13.0 approve <id>
   ```

Neither can recover the folders the printing process used. `agentcomms paths` and `comms_paths` show the folders a
process resolved, and cannot show the variables or relative values that produced them: if you ran with
`AGENT_COMMS_CONFIG_DIR`, `AGENT_COMMS_STATE_DIR` or `AGENT_COMMS_DATA_DIR` set, set the same values for this
command, quoted for your shell. npx may not be installed; an old result may not name its Node; and skills are
installed separately from the servers, so an agent's skills may still describe the old way.

PATH shims — putting `agentcomms` and the `agent-*` commands on your `PATH` — are a separate follow-up. 0.13.1
creates, changes and checks none.

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

Registering is a change you approve. At a terminal it shows what it will register and asks you to type `yes`. An
agent running it gets exit `10`, `APPROVAL_PENDING`, the preview and an approval id; it shows you the preview and,
after your yes, runs the same command again with `--approval <id>`. A rerun with different flags is refused and
writes nothing: the approval is for the registration it previewed. `--print` and `--client json` write nothing and
ask nobody.

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

Checks are selected by `id`, which is stable; `title` is wording and can change. A `warn` whose detail starts
"none registered" means no client's config file starts the server at all — one a plugin or an extension starts is
not visible from there — and its `fix` is `mcp install --client <client>`. Otherwise a `warn` names each stale entry,
and its `fix` is the command that re-registers that entry as it is — keeping its `--name`, `--inbox` and
`--read-only` — rather than a default one. Run that fix with the new version:

```bash
npx -y @agentcomms/gmail@latest mcp install --client claude-code --force    # plus the flags doctor's fix carries
npx -y @agentcomms/slack@latest mcp install --client claude-code --force    # the Slack server, the same way
```

Each asks you to approve the registration it shows — `yes` at a terminal; from an agent, exit `10` and the same
command again with `--approval <id>` after your yes. `--force` removes the existing entry of that name first; Claude Code refuses to add a server whose name is already
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

A dry run changes nothing and asks nobody. Removing is a change you approve, as the list of runtimes it would delete —
a deleted runtime cannot be taken back — and it removes no more than that list, even if another becomes unused
meanwhile. From an agent it exits `10` with the list and an approval id, for `mcp prune --approval <id>` after your
yes.

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
for it, which carries every one of them. Like any registration it asks you to approve what it will write first.

### `… has version 3; this release reads versions 1 and 2`

A server or command of 0.13 or earlier, after 0.14.0 moved the shared configuration to version 3 — which it does the
first time it prepares, approves or sends anything, or changes a send policy. Every call the old server starts fails
this way until its client is restarted on 0.14. Restart the client (`claude --continue` resumes a Claude Code
conversation); if it still says so, register the server again at the current release, as in
[the server is running an old version](#the-server-is-running-an-old-version). Approvals the old release prepared and
nobody used were retired at the conversion: prepare them again. See [Upgrading](upgrading.md#0140-the-configuration-moves-to-version-3).

### `records from an earlier release are still being retired`

After the conversion above, the approvals 0.13 prepared are revoked one by one. Until every one is, and ten minutes
have passed since the conversion, no send policy can be loosened. The next send prepare, claim or approval retries them;
`agentcomms doctor` lists what is still open under "earlier-release approvals". Tightening is never held up.

### An agent asks for approval in a form instead of the terminal

That mailbox is on `confirm`, and the client has been trusted to show forms to a person. Declining the form revokes
the approval; cancelling it decides nothing, and it stays pending. If you did not trust that client:

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

### Slack is rate-limiting this workspace

A post, file post, reaction, edit or deletion that Slack rate-limits is tried again by itself: Slack answers before it
acts, so nothing was posted, and the act waits the `Retry-After` Slack gives (or backs off) and tries up to three more
times within 45 seconds, repeating its checks first — an edit and a deletion read the message again. A file post's
files are not uploaded twice. Only when that runs out does it stop, with "Slack is rate-limiting this workspace (tried
4 times)", "Nothing was posted" and the time to try after. Prepare it again then.

### The sign-in completes at Slack and never comes back

The port in the app's manifest and the port given to `workspace add` differ. Slack matches redirect URLs exactly,
so they must be the same number: `agent-slack manifest --port 51234` and
`agent-slack workspace add acme/slack --client-id <id> --port 51234`.

### Slack says `invalid_team_for_non_distributed_app`

Slack's page says "Something went wrong when authorizing this app", and the sign-in never comes back. The app was
made in one workspace and is not distributed, so Slack authorises it there only — and the browser was signed in to a
different one. It happens most with an organisation's app, for someone signed in to several workspaces.

A sign-in through an organisation profile, and every `workspace reauth`, puts the workspace's id in the link
(`team=T…`), which takes a browser already signed in to that workspace straight to it. Up to 0.14.0 the link carried
none, so update first. Then sign in to that workspace in the same browser — the profile names it, and so does the
error when the sign-in times out — and start the sign-in again. An own app's first sign-in names no workspace, so
pick the one you made the app in on Slack's page.

### The agent has no `slack_*` tools

The workspace is connected but the server is not registered with the client:

```bash
agent-slack mcp install --client claude-code
```

It shows what it will register and asks for your yes; run by an agent, it exits `10` with the preview and runs again
with `--approval <id>` once you have agreed. Then restart the client. Without the server the Slack skills fall back
to `agent-slack … --json`.

### It will not post

That is usually correct. A workspace in `read` mode holds a token Slack will not let post; no setting here changes
that. `agent-slack workspace mode <name>` says which mode a workspace is in and prints the steps to move it: the app's
manifest first, which is the person's to change, then `workspace mode <name> send --app-updated` (`slack_mode_set`
from a chat), a change the person approves before a new sign-in starts. In `send` mode a post goes out only once its approval allows it: `slack_post_prepare` returns a
preview, and `slack_post_send` (or `agent-slack post send`) posts it after a yes under `chat`. Under `confirm`, and for
any broadcast or room of fifty or more, it waits with `APPROVAL_PENDING` until the person runs the approve command it
gives, in their own terminal. Under `never` nothing posts.

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
