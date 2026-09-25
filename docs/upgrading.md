# Upgrading, and bringing another computer up to date

One person's accounts are usually spread over more than one computer, and each computer keeps its own
configuration, its own tokens and its own MCP registrations. Nothing is shared between them, so each one is
brought up to date on its own, with the sequence below. It works from any earlier release: a computer still on
0.1.x with the old flat names (`work`, `personal`) ends on the current release with organisation/platform names
(`acme/gmail`, `acme/slack`) and both MCP servers — Gmail and Slack — registered.

Why the order matters:

- **The rename is permanent.** An old name becomes a tombstone: it is refused from then on, with the name it has
  now, and never reused. `--dry-run` first is not optional.
- **A release older than 0.2.0 cannot read the renamed configuration at all**, and a server that started before
  the rename still offers the old names. So every agent client is closed before the rename and reopened after the
  new servers are registered, never the other way round.
- **Each registration pins an exact version.** A new release reaches a client only when it is registered again,
  which is what `mcp install --force` does.

## Before you start

- **Node 22.12 or newer**, first on `PATH` in the terminal you use: `node --version`. The registration records the
  absolute path of this Node, so it is the one your agents will run.
- **The client's own CLI on `PATH`** — `claude` for Claude Code, `codex` for Codex. `mcp install` registers through
  it; without it the install prints the entry for you to add by hand instead of registering it.
- **The release to install.** Every command below uses the same one, so a release published halfway through does
  not leave the two servers on different versions:

  ```bash
  V=$(npm view @agentcomms/gmail version); echo "$V"
  ```

  It must be 0.4.1 or later: 0.4.1 is the first release in which `agent-slack` has `mcp install`.

## 1. Close every agent client

Quit Claude Code (every window, and the VS Code extension), Codex, Cursor, Claude Desktop — whatever runs these
servers on this computer. A server that is still running keeps the version and the names it started with.

The one exception is an agent doing this for you from inside Claude Code: it cannot close its own window. That is
harmless — its Gmail and Slack servers go stale at the rename, refusing the old names or the new file, and nothing
they do can undo it — as long as the window is reopened in step 7. Close every other one.

Do not rename while a sign-in is waiting in a browser. If you started one in the last ten minutes, finish it first;
one that completes after the rename is refused.

## 2. See what the names would become

```bash
npx -y @agentcomms/core@$V names migrate --dry-run
```

Each account's default is `<old name>/<platform>`: `work` → `work/gmail`, `team` → `team/slack`. Where that is not
what you want, add a `--rename <old>=<new>` for it:

```bash
npx -y @agentcomms/core@$V names migrate --dry-run \
  --rename <old>=<organisation>/gmail \
  --rename <old>=<organisation>/slack
```

Write the list once, for every name on every computer, and run the same list everywhere. A `--rename` for a name
this computer does not have is shown under "Not applicable here" and changes nothing. Read that list: a misspelt
name lands there too, and the account it was meant for would take its default instead. If the same word is both
a mailbox and a Slack workspace, qualify it: `--rename inbox:<old>=…` or `--rename account:<old>=…`.

If it says the names are already organisation/platform, this computer was migrated before; go to step 4.

## 3. Rename

The same command without `--dry-run`. At a terminal it shows the mapping and asks; anything without a terminal —
an agent, a script — passes `--yes`:

```bash
npx -y @agentcomms/core@$V names migrate --yes \
  --rename <old>=<organisation>/gmail \
  --rename <old>=<organisation>/slack
```

It saves the configuration as it was beside itself first, as `config.json.before-names-migrate-<UTC time>`
(owner-only), and prints where. That copy is the only way back; keep it until everything works.

## 4. Register both servers

```bash
npx -y @agentcomms/gmail@$V mcp install --client claude-code --force
npx -y @agentcomms/slack@$V mcp install --client claude-code --force
```

For another client, change `--client` (`codex`, `cursor`, `claude-desktop`, `gemini`, `vscode`). `--force` replaces
the entry that is already there, which is how an upgrade reaches a registered client.

Each result should say the entry was registered and that the server started. If it only printed an entry, the
client's CLI was not found: see "Before you start".

If an existing entry was registered with its own flags — a different `--name`, `--read-only`, or pinned to one
mailbox or workspace — pass the same flags again, with the pinned account's **new** name. `agent-gmail doctor`
prints the exact command for each stale Gmail entry; see
[Troubleshooting](troubleshooting.md#the-server-is-running-an-old-version).

## 5. Upgrade the global commands, where there are any

Only if you installed them globally before (`npm ls -g --depth=0 | grep @agentcomms`):

```bash
npm install -g @agentcomms/gmail@$V @agentcomms/slack@$V @agentcomms/core@$V   # only the ones listed
```

## 6. Check it

```bash
npx -y @agentcomms/gmail@$V doctor
npx -y @agentcomms/gmail@$V inbox list
npx -y @agentcomms/gmail@$V whoami --inbox <organisation>/gmail        # once for each mailbox
npx -y @agentcomms/gmail@$V whoami --inbox <an old name>              # refused, with its new name
npx -y @agentcomms/slack@$V workspace list
npx -y @agentcomms/slack@$V doctor --offline
```

## 7. Reopen the clients

Reopen them, and check that the Gmail and Slack tools are there. The old servers' runtimes stay on disk until you
delete them (see [Troubleshooting](troubleshooting.md#the-server-is-running-an-old-version)).

## Accounts this computer does not have yet

Nothing copies an account between computers: a sign-in is per computer, and it needs you in a browser.

```bash
npx -y @agentcomms/gmail@$V inbox add <organisation>/gmail
npx -y @agentcomms/slack@$V workspace add <organisation>/slack --client-id <the app's Client ID> --port <its port>
```

For a Slack workspace connected on another computer, `agent-slack workspace show <organisation>/slack` there gives
the Client ID and port to use — the app is the same one.

## Example: one person's mapping

For illustration only — these are one owner's accounts, not names to copy. Six mailboxes and two Slack workspaces,
spread over several computers:

| Old name | New name | Needs a `--rename`? |
|---|---|---|
| `gmail` | `personal/gmail` | yes |
| `cue` | `cue/gmail` | no, the default |
| `rgc` | `rgc/gmail` | no, the default |
| `wf` | `wf/gmail` | no, the default |
| `wf-tech` | `wf/gmail-tech` | yes |
| `beamtech` | `beamtech/gmail` | no, the default |
| `live` (Slack) | `cue/slack` | yes |
| `slack-2` (Slack) | `rgc/slack` | yes |

So the list run on every one of those computers is four flags — `--rename gmail=personal/gmail`,
`--rename wf-tech=wf/gmail-tech`, `--rename live=cue/slack` and `--rename slack-2=rgc/slack` — and a computer that
has only some of those accounts lists the renames it has no account for as not applicable.

## A prompt for an agent on the other computer

Paste this into Claude Code on the computer being upgraded, with your own list in place of `<RENAMES>` — the
`--rename` flags from step 2 — and your full set of new names in place of `<ALL NEW NAMES>`. Claude Code cannot
restart itself, so it does everything up to step 7 and then tells you to.

```text
Bring agent-communications on this computer up to the current release: rename accounts to organisation/platform
names, and register the Gmail and Slack MCP servers with Claude Code. Follow docs/upgrading.md from
https://github.com/crissmoldovan/agent-communications exactly, in its order.

Rules:
- Never send mail, post to Slack, or start a sign-in. Never print a token, a secret, or an env value.
- Stop and tell me, changing nothing further, if any command fails or any of these is true:
  - `node --version` is older than 22.12, or `claude` is not on PATH;
  - the release (V=$(npm view @agentcomms/gmail version)) is older than 0.4.1;
  - an existing gmail or slack entry in Claude Code is not @agentcomms (another vendor's server with that name);
  - an @agentcomms server is registered under another name, or its entry carries any of the flags --inbox,
    --workspace, --read-only (tell me which, so they can be carried over);
  - the dry run renames an account to a name that is not in <ALL NEW NAMES>.
- Use these renames on every run: <RENAMES>
- Run the dry run first and show me its output, including anything "Not applicable here". Then run it with --yes.
  Tell me the backup path it prints.
- Register both servers with --client claude-code --force, using the same V for both. Each result must say
  registered and verified; if not, stop and show it.
- Upgrade global @agentcomms commands only if they are already installed globally.
- Run the checks in step 6. For each name in <ALL NEW NAMES> that this computer does not have, give me the one
  command that connects it, without running it.
- Close nothing yourself. Finally, tell me to quit and reopen every Claude Code window, this one included.
```
