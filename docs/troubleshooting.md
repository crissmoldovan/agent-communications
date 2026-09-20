# Troubleshooting

Run this first. It checks everything that has to work and prints the one command that fixes each thing that does
not.

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
loosening and needs a typed confirmation at a terminal.

### An agent sent mail without asking me

Then something else sent it. Check for another Gmail MCP server:

```bash
agent-gmail doctor --json | jq '.data.checks[] | select(.name | test("Other Gmail"))'
```

Everything here assumes it owns the only route to Gmail's send endpoints. Another server with an ungated send tool
does not break that guarantee so much as stand beside it.

## Agents and MCP

### The client does not see the tools

Restart it. MCP clients read their server list at startup.

```bash
agent-gmail mcp install --client claude-code   # re-register
agent-gmail mcp install --list                 # which clients were found
```

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

Check what is registered against what you have:

```bash
agent-gmail doctor --json | jq '.data.checks[] | select(.name | test("Registered server"))'
```

Re-registering is remove-then-install. `mcp install` refuses to overwrite an existing entry, so the remove is not
optional:

```bash
claude mcp remove gmail                                    # or the equivalent for your client
npx -y @agentcomms/gmail@latest mcp install --client claude-code
```

Restart the client afterwards. The old runtime stays on disk under `<data dir>/runtime/<version>/`; nothing
depends on it once the entry points elsewhere, and it can be deleted.

### The server starts but every call fails

The server and the CLI share one config directory. If the CLI works and the server does not, the client is likely
starting it with a different `AGENT_COMMS_CONFIG_DIR` or a different `HOME`.

```bash
agent-gmail doctor          # as you
agent-gmail mcp install --client <name>   # rewrites the entry with the right paths
```

### An agent asks for approval in a form instead of the terminal

That mailbox is on `confirm`, and the client has been trusted to show forms to a person. If you did not do that:

```bash
agent-gmail confirm-clients list
agent-gmail confirm-clients remove <name>
```

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

## Still stuck

`agent-gmail <command> --help` for any command, [the CLI reference](reference/cli.md) for all of them, and
`--json` on anything gives a structured error with a `code` and a `hint`.
