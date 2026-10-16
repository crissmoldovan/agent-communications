# Upgrading, and bringing another computer up to date

One person's accounts are usually spread over more than one computer, and each computer keeps its own
configuration, its own tokens and its own MCP registrations. Nothing is shared between them, so each one is
brought up to date on its own, with the sequence below. It works from any earlier release: a computer still on
0.1.x with the old flat names (`work`, `personal`) ends on the current release with organisation/platform names
(`acme/gmail`, `acme/slack`) and its MCP servers — Gmail, Slack and, from 0.5.0, the core server; from 0.7.0 Resend
and WhatsApp too, where this computer uses them — registered.

Why the order matters:

- **The rename is permanent.** An old name becomes a tombstone: it is refused from then on, with the name it has
  now, and never reused. `--dry-run` first is not optional.
- **A release older than 0.2.0 cannot read the renamed configuration at all**, and a server that started before
  the rename still offers the old names. So every agent client is closed before the rename and reopened after the
  new servers are registered, never the other way round.
- **Each registration pins an exact version.** A new release reaches a client only when it is registered again,
  which is what `mcp install --force` does.

## The short way: `agentcomms update`

From the release that adds `agentcomms update`, a computer whose accounts already have organisation/platform names is
brought to the latest release by one command — or from a chat, by the core server's `comms_update`:

```bash
npx -y @agentcomms/core@latest update --check   # what is behind the latest release; changes nothing
npx -y @agentcomms/core@latest update           # one change for every step, approved before any of it happens
```

`--check` (`check: true` from a chat) reads the npm registry and this computer and asks nobody. It lists every client
registration of the core's, every channel's server — Gmail, Slack, Resend and WhatsApp — and the events service,
pinned to an older release, the managed runtimes those will need, and the `@agentcomms` packages installed globally,
each with the version it has and the latest. It asks the registry only about the packages this computer uses.

Without `--check` it prepares one change and shows every step of it: each registration registered again at the latest
release under the name, client, scope, launcher and pins it has now; each runtime it installs; each
`npm install -g <package>@<version>`. Nothing happens until you approve it, as for any other change: at a terminal you
type `yes` (or, under the `confirm` change policy, the code it shows); an agent gets the preview and an approval id,
and calls again with it — `--approval <id>`, or `approvalId` — once you have agreed. The approval is for those steps at
those versions: a release published in between is a different change, and is refused. With nothing behind, it says
so and prepares nothing.

**Every release it would install is verified first**, before the preview is made and again when the approval is
claimed, against the same pins as the background run (below): each runtime it installs, each launcher it switches, each
registration it writes — a managed one's runtime, and an npx one's package, which its client fetches from npm — and
each global package. The preview ends with one line a package: `@agentcomms/gmail@<version> was verified before this
preview: built by this repository's release workflow …`. One release with no attestation, or one that names anything
else, refuses the whole update with `BAD_DATA` — `nothing was installed or changed: <package>@<version> could not be
verified as built by this repository's release workflow`, and which pin failed — and nothing is prepared to approve.
No flag or setting skips it. After installing, each runtime must hold the very tarball that was verified, as npm's
lockfile in it records: one that does not, whether installed then or found on disk, is neither switched to nor
registered on, and its step says so.

Each managed registration also writes that package's CLI shim in `~/.local/bin` on macOS and Linux, pointing at the
same locator-resolved Node and runtime entry. An update repoints a shim this installation owns and leaves any foreign
file unchanged. A symlinked bin directory works; if it is redirected while an operation is in progress, the mutation
is refused. If the directory is not on `PATH`, the result gives a line for the current shell; it never edits a shell
profile. `doctor` reports a missing, stale or foreign shim, and prune removes an unchanged owned shim when it removes
the runtime it starts. Windows shims are not offered yet because `.cmd` forwarding makes `cmd.exe` re-parse arguments;
use the full-path command or labelled PowerShell `&` line the result provides.

It never widens an entry. The pins it keeps are exactly the ones the entry has; an entry whose pins it cannot carry
over as they are — one registered for a single project, one written by hand, one pinned to an account since renamed,
one whose client's own command is not on `PATH` — is left as it was and listed with what to run instead. It reports
each step as it went, then says which clients to restart. Restart them, then prune the old runtimes from the restarted
server, as in step 7.

### The daily check, and its notice

Once a day — at most, for the whole machine — the first server or command to run asks npm for the latest release of
`@agentcomms/core`, runs the same "what is behind" check as `update --check`, and records what it found in
`update-check.json` in the state directory.

**From 0.20.0, nothing is stopped for being behind.** When a newer release is out:

- **a server's first tool result of its process** carries one line beside the result — an `update` field, and a text
  block of its own — and that process never repeats it: `agent-communications 0.20.0 is out; say "update" when it
  suits you.` When every registration of that server on this machine already names the latest release, and only the
  running server is old, it says `agent-communications 0.20.0 is installed; restart the client (in Claude Code, /mcp →
  Reconnect) to use it.` instead. The Claude Code plugin's Gmail server and the Gemini extension's servers are told to
  update where they were installed, because restarting starts the release the plugin or the extension pins. A tool's
  output schema is published with room for the `update` field, so a client that checks results against it takes the
  one carrying it. `comms_update`, `comms_doctor`, `comms_paths` and each channel's doctor never carry it;
- **a command** prints the same line once on stderr — never on stdout, where its result and `--json` are — at most
  once a day for the machine, and runs. It names this installation's own `update` command, located as every printed
  command is. `update`, `doctor`, `paths`, `approve`, `approvals`, `mcp` on its own, the listener a sign-in starts, the
  hidden `update-check-child` and WhatsApp's `status` never print it.

The same one line also carries, by the same rules of level and pause:

- **what the last background run left** — the release it installed and that a restart picks up, a release it refused
  because its provenance did not verify, a major release or one needing a decision that it left for you, the job an
  organisation turned off. It is said by the first server or command it applies to, and then cleared; "installed" is
  said only by a process running a release before it.
- **the offer of the background job**, on `auto` while it is not set up, where it could be: `comms_update` with
  `backgroundJob: "on"` (or the located `update --background-job on`) shows the job, when it runs and how to remove
  it, and sets nothing up without your yes.
- **the move to the stable launcher**, while any managed registration still names a versioned runtime: one approved
  update moves each, the last update that edits a client's configuration. With nothing newer out, the move alone is
  worth the line. The check records how many are left (`moves` in `update-check.json`).

The `UPDATE_REQUIRED` error and exit status `11` are retired. A client that still sees one is talking to a server
older than 0.20.0, and a script that branched on `11` can drop that branch.

**Levels.** `defaults.updates` in `config.json` is one of three, and `agentcomms update --level <level>` (or
`comms_update` with `level`) sets it:

| Level | Checks | Notices |
|---|---|---|
| `auto` (the default) | daily | until background updates are set up, a daily check with a notice; after, only what needs the person — a restart, a major release, a release needing a decision |
| `every-14-days` | at most once every 14 days | at most once every 14 days |
| `never` | never: no registry request | none |

A level that updates less (`auto` → `every-14-days` → `never`) is a change the person approves, and its preview says
what stops happening; moving back applies at once. 0.18's `updateCheck` reads as a level until one is set — `on` as
`auto`, `off` as `never` — and every level written keeps `updateCheck` beside it in step, so an earlier release sharing
the file checks, or does not, as the person chose. `CI`, `AGENT_COMMS_UPDATE_CHECK=off` and `AGENT_COMMS_UPDATES=never`
switch it all off for one process.

**A pause.** `agentcomms update --pause [1|7|14]` (or `comms_update` with `pause`) holds every notice on this machine
for that many days, 7 when no length is given. It is a plain answer with no approval: nothing is stopped any more, so a
pause clears nothing. A new pause replaces the old one, and none lasts longer than 14 days from when it was asked,
however the clock jumps. `--resume` (`resume: true`) ends it at once. `doctor` says when it ends.

**A security fix.** A release whose core manifest declares `agentcommsRelease.security: true` is said at once on
`every-14-days`, on `never` (when a check by hand found it), and on `auto` while its background job is not set up —
whatever the pause or the 14-day spacing, and with when the pause ends. There, too, the next Gmail or Resend send
preview, or Slack post preview, opens with one line — `A security fix is out (0.20.1): update first, or approve to
send anyway` (`… to post anyway` on Slack) — asked once on the machine. The person's yes to that preview is the answer:
the line is shown, never part of what the approval binds.

**An organisation's caps.** An organisation can only make its members' updates stricter, in a file beside its
profile — `acme.agentcomms.updates.json` beside `acme.agentcomms.json` — holding
`{ "organisation": "acme", "max": "every-14-days" | "never", "background": false }`, each cap optional. It is not in the
profile itself: every release from 0.13.0 to 0.19.0 refuses a profile with a key it does not know, at every level, and a
member not yet on 0.20.0 would lose `org update` for the whole profile. Those releases never open the file beside it.
`org add` and `org update` read it with the profile and bind its SHA-256 in the same approval: a new, changed or removed
file is approved first even when the profile's bytes are unchanged, and a record edited by hand is put back at once. A
member's level is capped at `max`, whatever they set; `background: false` keeps `auto` a daily check with a notice. A
`max` other than those two words is refused. `doctor` names the cap and the profile it comes from.

`--later` and `--auto on|off` (`later` and `auto`) are retired: each is refused, naming what replaced it.

It never gets in the way of a machine that cannot reach npm: an ask that fails keeps the last result and is not tried
again that day. A prerelease never counts as an update. A command at a terminal waits about three seconds for the
answer at most, then goes on while the ask finishes beside it, so a slow registry is still heard from; a server never
waits for it. The ask that goes on is handed to a detached process of its own, which holds none of the command's
output, so the command's process ends when the command does: on the day's first run a script's `$(…)`, a pipe into
`jq` or an agent's shell tool waits at most about three seconds longer than usual, and never for npm's registry or
`npm ls` behind it. The check reads the latest release's own document too, for what its manifest declares. Where that process cannot be started, the command asks in its own process, as before, and ends
once the ask has. An ask cut short — a process ended part-way — does not use up the day: another process asks a couple
of minutes later. WhatsApp's server and command, which never reach the network, do not ask npm themselves; they give
the notice once any other server or command on the machine has found an update. The check is skipped entirely when
`CI` is set, when `AGENT_COMMS_UPDATE_CHECK=off`, or when `AGENT_COMMS_UPDATES=never`.

### The background update job

`agentcomms update --background-job on` (or `comms_update` with `backgroundJob: "on"`) sets up a job of your own that
runs once a day and installs a verified release in the background. It needs no administrator, and it never sends, posts
or approves anything. Setting it up is a change you approve: the preview names the job's file and what it runs, when it
runs, what macOS shows, and how to remove it.

| Platform | The job | When it runs |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.agentcomms.update.plist`, loaded with `launchctl bootstrap gui/<uid>` | daily at 10:00 local time and a minute chosen at random when it is set up; at the next wake if the Mac was asleep |
| Linux | `~/.config/systemd/user/agentcomms-update.service` and `.timer`, enabled with `systemctl --user enable --now` | daily, at a random moment in the hour after midnight; at the next start if the computer was off |
| Windows | the task `agentcomms-update` in Task Scheduler, registered without elevation | daily at 10:00 local time, after a random delay of up to an hour; as soon as it can after a missed start, on battery too |

It runs the stable core launcher, `<data>/launch/core`, with `update --background` and this installation's four folders
pinned, so it reads the same configuration whatever the environment it starts in. Setting it up writes
`update-job.json` in the state directory; removing it deletes that file. On macOS 13 and later, macOS shows
"Background Items Added" once and lists the job under System Settings → General → Login Items, where it can be switched
off.

`agentcomms update --background-job off` (or `backgroundJob: "off"`) removes it at once, and so does choosing a level
at which nothing installs in the background, `update --level every-14-days` or `--level never`. Run it before you uninstall: npm runs no script of a package as it removes it. A job at
the same place that this installation did not write is never changed or removed by it. Setting the job up is refused
when an organisation profile here turns background updates off, and a job set up before such a profile arrived is
removed by its next run. `doctor` reports the job as installed, missing, foreign or stale, with what fixes each; on a
machine that never set one up it says nothing.

### What one background run does

`agentcomms update --background` is what the job runs. It never sends, posts or approves anything, and it installs
nothing unless all of this holds:

- **The level in force is `auto`** — the level set, under any organisation profile's `max` — and no organisation
  profile turns background updates off; otherwise it stops, and removes a job such a profile forbids. A pause asked
  for with `update --pause` holds it, but never for a security fix. `CI`, `AGENT_COMMS_UPDATE_CHECK=off` and
  `AGENT_COMMS_UPDATES=never` turn it off for that process.
- **The release waits for nobody.** A major version, a release whose core manifest declares
  `agentcommsRelease.needsDecision`, and a downgrade are never installed in the background; each leaves a notice. A
  release you rolled back from with `update --rollback` is held until a newer one is out (`update-held.json` in the
  state directory).
- **It is past its hold**: 72 hours after the last of its packages was published, or 24 for one whose core manifest
  declares `agentcommsRelease.security: true`. The clock is the earlier of this machine's and the registry's, so a clock
  set ahead skips no hold and ends no pause early.
- **Its provenance verifies**, for every package it would install: npm's SLSA provenance attestation, verified with
  sigstore-js (its verifier's parts, `@sigstore/verify` and the rest at sigstore-js 3.1.0's versions, are dependencies of
  `@agentcomms/core`) — must be issued by `https://token.actions.githubusercontent.com`
  for exactly `https://github.com/crissmoldovan/agent-communications/.github/workflows/release.yml@refs/tags/v<version>`,
  built on a `github-hosted` runner from this repository at that tag, and sign the very tarball the registry names. A
  version with no attestation, or any other identity, is refused, and nothing at all is installed.

Core's latest release is verified first, before anything the registry says of it is acted on or made a notice — a
security fix's shorter hold and its way past a pause, a needed decision, a major release, a downgrade. Until then the
registry's word can only hold a release back: a pause holds one that does not say it is a security fix. A release that
does not verify is only refused, and its notice says only that.

Then it installs each package into a runtime of its own, checks that npm installed the tarball whose provenance was
verified, that its CLI says the release's version, and that its server answers MCP `initialize` with no account to
reach — and only once every package has passed does it switch each stable launcher's pointer. A run that fails part-way
switches nothing. It records one line in the audit log (`comms_audit_tail`), removes the runtimes older than each
launcher's previous one that nothing uses, and leaves the next session a notice: `<version> is installed; restart …`,
or why it was not. `--dry-run` says what it would do and why, with the provenance it verified, and changes nothing.

A background run and a person's update or rollback never overlap: each holds one lock for the machine,
`.update.lock` in the state directory, while it installs, switches or prunes. A run that finds it held does nothing
that day; `agentcomms update` and `comms_update` that find it held are refused at once — before any approval is
prepared — saying a background run is under way, to try again in a few minutes.

## 0.14.0: the configuration moves to version 3

0.14.0 adds a send epoch to the shared configuration — the counter that makes turning sending off (`never`) final for
every approval prepared before it, whatever the policy is set to later — and that needs **configuration version 3**.
0.13 reads versions 1 and 2 and refuses any other before it does anything, so the first 0.14 server or command that
prepares, approves or sends anything, or changes a send policy, converts the configuration in one write. From then on:

- **A server still running 0.13 fails every call it starts**, with "`<path>` has version 3; this release reads
  versions 1 and 2" and "Upgrade agent-communications, or restore a config written by this version". Restart every
  client after the update — the update already asks for that — so it starts its servers on 0.14. Nothing in the
  configuration is lost; it gains `sendEpochs`, and `legacyDrain` while the step below runs. This breaks, on purpose,
  the usual rule that a release reads a configuration version before any release writes it: a 0.13 process that
  kept going could still use an approval prepared before sending was turned off.
- **What 0.13 prepared is retired.** Each send it prepared that is still waiting or approved is revoked with
  "prepared by an earlier release; prepare it again" — 0.14 could never use one anyway — and the call that converted
  lists them (`legacyDrain`). Prepare them again. A 0.13 send that had already taken its record when the conversion
  came is not stopped; it is listed by id, so it is never silent. `agentcomms doctor` shows "earlier-release
  approvals" until every one is retired.
- **No send policy can be loosened meanwhile:** "records from an earlier release are still being retired, so no send
  policy can be loosened yet". Every send prepare, claim or approval retries the retiring. It ends no sooner than ten
  minutes after the conversion — the longest anything 0.13 prepared could still be waiting. Tightening is never held
  up.
- **What 0.14 prepares, 0.13 cannot use either:** its records are a new version, which 0.13 refuses with "the approval
  was prepared by a different version of agent-communications".

Everything below is the long way round — and the only way across the rename, which `update` does not do.

## Before you start

- **Node 22.12 or newer — 22.16 or newer for WhatsApp**, first on `PATH` in the terminal you use: `node --version`.
  The registration records the absolute path of this Node, so it is the one your agents will run. WhatsApp refuses
  an older one, naming the version it needs: it reads WhatsApp's store with Node's own SQLite.
- **The client's own CLI on `PATH`** — `claude` for Claude Code, `codex` for Codex. `mcp install` registers through
  it; without it the install prints the entry for you to add by hand instead of registering it.
- **The release to install.** Every command below uses the same one, so a release published halfway through does
  not leave the two servers on different versions:

  ```bash
  V=$(npm view @agentcomms/gmail version); echo "$V"
  ```

  It must be 0.5.0 or later: the steps below are written for it — the approvals in steps 3 and 4, and the core
  server, arrived in 0.5.0.

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

The same command without `--dry-run`. Renaming every account is a change a person approves. At a terminal it shows
the mapping and the change and asks you to type `yes` — or, under the `confirm` change policy, the code it shows.
Anything without a terminal — an agent, a script — gets the preview and an approval id instead, and exits `10`; once
you have agreed, it runs the same command again with `--approval <id>`:

```bash
npx -y @agentcomms/core@$V names migrate \
  --rename <old>=<organisation>/gmail \
  --rename <old>=<organisation>/slack
# without a terminal: exit 10, the preview and an approval id. Once you have said yes:
npx -y @agentcomms/core@$V names migrate --approval <id> \
  --rename <old>=<organisation>/gmail \
  --rename <old>=<organisation>/slack
```

The approval is for exactly the mapping shown: run again with a `--rename` left off, it is refused and nothing
changes. Releases before the core MCP server took `--yes` here instead; `npx -y @agentcomms/core@$V --help` says which
yours takes.

It saves the configuration as it was beside itself first, as `config.json.before-names-migrate-<UTC time>`
(owner-only), and prints where. That copy is the only way back; keep it until everything works.

## 4. Register the servers

**First, decide how changes are approved. From 0.5.0 a loosening is approved in chat by default.** A configuration
from an earlier release has no change policy, and reads as `chat`: a registration, a looser send policy or a removed
account is approved by a yes in the conversation, where 0.4.x asked for a code typed at a terminal — and the software
cannot tell your yes from an agent's. To keep terminal approval, run this before letting an agent loose on this
computer. It applies at once; going back needs the code:

```bash
npx -y @agentcomms/core@$V policy confirm
```

Then register the servers:

```bash
npx -y @agentcomms/gmail@$V mcp install --client claude-code --force
npx -y @agentcomms/slack@$V mcp install --client claude-code --force
npx -y @agentcomms/resend@$V mcp install --client claude-code --force     # from 0.7.0, if you use it
npx -y @agentcomms/whatsapp@$V mcp install --client claude-code --force   # from 0.7.0, if you use it
npx -y @agentcomms/core@$V mcp install --client claude-code --force       # the core server, if you use it
```

Each registration is a change a person approves, as the rename is: at a terminal it shows what it will register —
which server, which client, under which name, pinned to what, replacing what — and you type `yes` (or, under the
`confirm` change policy, the code it shows). Anything without a terminal — an agent, a script — gets that preview and
an approval id instead, exits `10`, and runs the same command again with `--approval <id>` once you have agreed:

```bash
npx -y @agentcomms/gmail@$V mcp install --client claude-code --force
# without a terminal: exit 10, the preview and an approval id. Once you have said yes:
npx -y @agentcomms/gmail@$V mcp install --client claude-code --force --approval <id>
```

The approval is for exactly the registration shown: run again with another flag, it is refused and nothing is
written. Releases before this one registered the Gmail and Slack servers without asking and have no `--approval`
there; `--help` on that command says which yours is. The core server exists from the release
that adds `agentcomms mcp`; `npx -y @agentcomms/core@$V --help` lists it.

For another client, change `--client` (`codex`, `cursor`, `claude-desktop`, `gemini`, `vscode`). `--force` replaces
the entry that is already there, which is how an upgrade reaches a registered client.

Each result should say the entry was registered and that the server started. If it only printed an entry, the
client's CLI was not found: see "Before you start".

`--force` never widens the entry it replaces: a pin to one mailbox or workspace, or `--read-only`, that the entry
had and the command leaves out is kept, and the result says so in a warning. The pin it keeps is the name the
entry was registered with, though, and after the rename that is the **old** one, which is refused. So if an
existing entry was registered with its own flags — a different `--name`, `--read-only`, or pinned to one mailbox
or workspace — pass the same flags again, with the pinned account's **new** name. `agent-gmail doctor` prints the
exact command for each stale Gmail entry; see
[Troubleshooting](troubleshooting.md#the-server-is-running-an-old-version). To register a wider server on
purpose, remove the entry with the client's own command (`claude mcp remove gmail --scope user`) and install again.

## 5. Upgrade the global commands, where there are any

Only if you installed them globally before (`npm ls -g --depth=0 | grep @agentcomms`):

```bash
npm install -g @agentcomms/gmail@$V @agentcomms/slack@$V @agentcomms/core@$V   # only the ones listed
npm install -g @agentcomms/resend@$V @agentcomms/whatsapp@$V                   # likewise, from 0.7.0
```

## 6. Check it

```bash
npx -y @agentcomms/gmail@$V doctor
npx -y @agentcomms/gmail@$V inbox list
npx -y @agentcomms/gmail@$V whoami --inbox <organisation>/gmail        # once for each mailbox
npx -y @agentcomms/gmail@$V whoami --inbox <an old name>              # refused, with its new name
npx -y @agentcomms/slack@$V workspace list
npx -y @agentcomms/slack@$V doctor --offline
npx -y @agentcomms/resend@$V doctor                                    # from 0.7.0, where you use them
npx -y @agentcomms/resend@$V account list
npx -y @agentcomms/whatsapp@$V status
```

## 7. Reopen the clients

Reopen them, and check that the tools of every server you registered are there — Gmail's and Slack's, and Resend's
and WhatsApp's where you use them. Then remove the old servers' runtimes, which stay on disk otherwise. `prune` keeps a runtime named in any client config it reads, one it printed an entry for, and one
a running process uses, and it removes nothing if one of those configs cannot be read. The configs it reads include
every one `mcp install` recorded registering into, so a Claude Code account under another `CLAUDE_CONFIG_DIR`, or
codex under another `CODEX_HOME`, counts even when this shell does not set it; a recorded config that has since been
deleted keeps nothing. That record starts with 0.4.1: an entry an earlier release registered under another
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` is known only once it has been registered again, so do step 4 for every such
account before running `prune`, or run it from a shell with that variable set. It does not read a workspace's own
`.vscode/mcp.json` or `.cursor/mcp.json`, so if you registered a runtime there by hand, look at
`mcp prune --dry-run` first. Run it after the clients are back:

```bash
npx -y @agentcomms/gmail@$V mcp prune
npx -y @agentcomms/slack@$V mcp prune
npx -y @agentcomms/resend@$V mcp prune     # from 0.7.0, if you use it
npx -y @agentcomms/whatsapp@$V mcp prune   # from 0.7.0, if you use it
npx -y @agentcomms/core@$V mcp prune
```

Each asks you to approve the runtimes it lists before it deletes them, the way step 4 asks, and removes no more than
that list; without a terminal it exits `10` with the list and an approval id, for `mcp prune --approval <id>`.

## Accounts this computer does not have yet

Nothing copies an account between computers: a sign-in is per computer, and it needs you in a browser.

```bash
npx -y @agentcomms/gmail@$V inbox add <organisation>/gmail
npx -y @agentcomms/slack@$V workspace add <organisation>/slack --client-id <the app's Client ID> --port <its port>
npx -y @agentcomms/resend@$V account add <organisation>/resend   # type the API key when asked
```

For a Slack workspace connected on another computer, use the same app: on that computer,
`agent-slack workspace show <organisation>/slack --json` gives its Client ID (`oauthClientId`), and
`agent-slack manifest --workspace <organisation>/slack --json` its port (`port`).

A Resend key is typed by a person at this computer's terminal (or given as `RESEND_API_KEY`), never read from a
chat. Use the same key, or create one for this computer in Resend's dashboard, and pass the same `--mode` and
`--send` the account has elsewhere. Register its server with
`npx -y @agentcomms/resend@$V mcp install --client claude-code`, adding `--account <organisation>/resend` to pin it.
A WhatsApp account is per Mac: see the next section.

## WhatsApp, and the spike before it

WhatsApp reads a file on the Mac it runs on, so an account is added on each Mac, at its own terminal — macOS asks
there for permission to read WhatsApp's data:

```bash
npx -y @agentcomms/whatsapp@$V add <organisation>/whatsapp
npx -y @agentcomms/whatsapp@$V sync --account <organisation>/whatsapp
npx -y @agentcomms/whatsapp@$V mcp install --client claude-code --account <organisation>/whatsapp
```

A Mac that ran the unpublished spike has its accounts in `whatsapp-spike.json`. The first `agent-whatsapp` command, or
the first start of its server, moves them into `config.json` once — same account ids, so the index is read as it is
with no new sync, and the chat lists come too — and keeps the old file as `whatsapp-spike.json.migrated-<time>`. It
opens neither WhatsApp's store nor the spike's index to do it. A server the spike's checkout registered by hand is not
one this release updates: register the published one with `mcp install` as above, and remove the old entry from the
client.

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
names, and register the Gmail, Slack and core MCP servers with Claude Code. Follow docs/upgrading.md from
https://github.com/crissmoldovan/agent-communications exactly, in its order.

Rules:
- Never send mail, post to Slack, or start a sign-in. Never print a token, a secret, or an env value.
- Before registering any server, tell me that from 0.5.0 a change is approved by my yes in chat unless the change
  policy is confirm, and ask me whether to run `npx -y @agentcomms/core@$V policy confirm`. Run it only if I say so.
- When a preview says its policy is confirm, give me the approve command the result gives, exactly as given, to run
  in my own terminal, and wait until I say it is done before running the command again with --approval <id>. Never
  run approve yourself, and never write one yourself.
- Stop and tell me, changing nothing further, if any command fails or any of these is true:
  - `node --version` is older than 22.12, or `claude` is not on PATH;
  - the release (V=$(npm view @agentcomms/gmail version)) is older than 0.5.0;
  - an existing gmail or slack entry in Claude Code is not @agentcomms (another vendor's server with that name);
  - an @agentcomms server is registered under another name, or its entry carries any of the flags --inbox,
    --workspace, --read-only (tell me which, so they can be carried over);
  - the dry run renames an account to a name that is not in <ALL NEW NAMES>.
- Use these renames on every run: <RENAMES>
- Run the dry run first and show me its output, including anything "Not applicable here". Then run it without
  --dry-run: it exits 10 with a preview and an approval id. Show me the preview and wait for my yes, then run the
  same command again with --approval <id>. Tell me the backup path it prints.
- Register the Gmail, Slack and core servers with --client claude-code --force, using the same V for all three. Each
  one exits 10 with a preview and an approval id first, having registered nothing: show me that preview exactly as
  it is and wait for my yes, then run the same command again with --approval <id>. Never pass an --approval I have
  not agreed to, and if a rerun is refused, show me the new preview rather than retrying. Each result must say
  registered and verified; if not, stop and show it.
- Upgrade global @agentcomms commands only if they are already installed globally.
- Run the checks in step 6. For each name in <ALL NEW NAMES> that this computer does not have, give me the one
  command that connects it, without running it.
- Close nothing yourself. Finally, tell me to quit and reopen every Claude Code window, this one included.
```
