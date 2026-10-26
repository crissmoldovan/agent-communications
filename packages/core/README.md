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
npx @agentcomms/core label style acme/slack labelled  # every agent message there as you, labelled, not as the app (you approve it)
npx @agentcomms/core channels      # which servers exist, which are installed, and where each is registered
npx @agentcomms/core mcp install --client claude-code   # register the core MCP server
npx @agentcomms/core mcp install --server events --client claude-code   # register the events MCP server
npx @agentcomms/core mcp uninstall --client cursor --server gmail   # take one server out of one client, at once
npx @agentcomms/core activity sessions   # the agent windows that read or sent anything, newest first
npx @agentcomms/core activity items --json   # every call that names a message, grouped by the message
npx @agentcomms/core update --check  # what is behind the latest release; `update` brings it there, as one change
npx @agentcomms/core update --status  # where updates stand here: level, pause, last check, versions, background job; asks npm nothing
npx @agentcomms/core update --pause 7  # hold update notices for 1, 7 or 14 days (no approval); --resume ends it
npx @agentcomms/core update --level every-14-days  # auto, every-14-days or never; updating less is approved first
```

**On `auto`, the default, this machine asks npm once a day whether a newer release is out** — at most once every 14
days on `every-14-days`, and never on `never`. Nothing is ever stopped for it. When one is, a
server's first tool result carries one line beside it (an `update` field), and a command prints the same line once on
stderr, at most once a day for the machine, and runs. `update`, `doctor`, `paths`, `approve`, `approvals` and `mcp` on
its own never print it. A pause holds the notice for 1, 7 or 14 days, and never one of a security fix. A registry that
cannot be reached changes nothing. The check is skipped when `CI` is set, `AGENT_COMMS_UPDATE_CHECK=off` or
`AGENT_COMMS_UPDATES=never`; `doctor` shows it on one line.

Every command takes `--json` and prints `{ "ok": true, "schemaVersion": 1, "data": … }` or
`{ "ok": false, "schemaVersion": 1, "error": { "code", "message", "hint" } }`. `doctor --json` prints its report as that
one `ok` envelope even when a check fails, as the channels' doctors do: read `data.ok`, which is false then, and the
exit status, `78`.

A command that loosens something or cannot be undone — `policy chat`, `attach roots add`, `attach deny remove`,
`label word`, `label name`, `label icon`, `label rule add --as me`, `label rule remove --as agent`,
`label style … labelled`, a `behaviour allow` or `behaviour clear` that lets an agent do more, `mcp install`,
`mcp prune`, `update`, `secrets migrate`, `names migrate` — shows the change first (`policy confirm`,
`attach roots remove`, `attach deny add`, `label rule add --as agent`, `label rule remove --as me`,
`label style … app`, `mcp uninstall` and a `behaviour allow` that only narrows tighten, so they apply at once). At a terminal you approve it there; anything else gets the preview and an
approval id and exits `10`, and runs the same command again with `--approval <id>` once the person has agreed.
Every channel CLI, and the declared events service through core, registers and prunes its server through the same change, so an approval
`comms_server_install` or `comms_server_prune` prepared is claimed by their `mcp install` or `mcp prune` for the same
request, and the other way round.

`mcp install --server <a,b,…>` adds several servers to one client as one change (0.34.0): one preview naming every
server and what each reaches, one approval, then each registered in the order given. The first that fails stops the
rest; the error says which were registered and which were not, and the approval, spent on that attempt, is not used
again. `--name` and the pins (`--account`, `--inbox`, `--workspace`, `--read-only`) are for one server on its own.
`comms_server_install` takes the same list as `servers`, in place of `channel`.

Some of these changes are also approved in the desktop app, as the person's own act: `mcp install` (0.32.0, when the
app adds servers to an app), and from 0.34.0 `label word`, `label name`, `label rule add|remove`, `label icon`,
`label style`, `behaviour allow|clear` and `update`. The app shows core's preview, and once the person presses its
confirm it runs the same command with `--app-approval <id>`. That plans the change first, checks the approval is a
waiting one for exactly that change, and only then approves it through the app channel (`approvedVia: app`) and
applies it; an approval for anything else, or a plan that refuses, approves nothing. A tightening — `label rule add
--as agent`, `label style … app`, a `behaviour allow` that only narrows — applies at once and takes no approval of
either kind: given one, it is refused (exit 64) and nothing is applied. On macOS core checks that the app started this
process: a speed bump against agents, not a boundary against code running as you, which can approve in-process anyway.
`desktopAppOrigin` has codesign verify the running parent, by its pid: the release, signed by the owner's team,
audited `approvedBy: desktop-app`; or the local test build, ad-hoc signed, only for a test profile — a config folder
holding `.agentcomms-test-profile`, which `scripts/local-test-release.sh` writes, and not your real, default one, found
from your account's own home whatever `HOME` or `XDG_CONFIG_HOME` say — and only when every other folder the command
touches is inside that profile: its state, data and secrets folders, and for `mcp install` and `update` the home folder
the apps' configs are in (and for `update`, npm's global folder). Its approvals are audited `desktop-app (test build)`.
Windows and Linux check nothing, so there the change is approved at your terminal:
`--app-approval` from an origin nothing attests is refused with `APPROVAL_REQUIRED` (exit 10, reason
`ORIGIN_UNATTESTED`) and a hint naming the command to run there, the refusal is audited as `desktop-app
(unattested)`, the approval still waits, and the app offers Approve in Terminal instead. `approvedVia: app` therefore
means the attested app. `--app-approval` is always refused to an agent's shell and inside an MCP server's process,
takes no `--approval`, and no MCP tool has it. Standing approvals are never approved in the app: they are approved at
a terminal, with their code.

`label style <workspace> app|labelled` chooses how an agent's messages look in one Slack workspace. `app`, the default,
posts as the app with Slack's APP tag where it can, and as you, labelled, elsewhere. `labelled` posts every one as you,
labelled in its words, even where the app could post. Choosing `labelled` waits for your yes, because it trades Slack's
own tag, which no one can fake, for words in the message; going back to `app` applies at once.

A managed install also writes the package's CLI shim in `~/.local/bin` on macOS/Linux. It starts that managed runtime
with the locator's Node and entry. Updates repoint an owned shim, prune removes it with the runtime, and `doctor`
reports one that is missing, stale or foreign. A foreign file is never overwritten or removed; a symlinked bin
directory works, but a directory redirected during an operation is refused before the mutation. If the directory is
not on `PATH`, the install result shows how to prepend it for the current shell without editing a profile. Windows
shims are not offered yet because `.cmd` forwarding makes `cmd.exe` re-parse caller arguments; use the full-path
command or the labelled PowerShell `&` line the result provides.

## What your agents did: activity

Core keeps a private log of what each agent window read, did and sent: `<state>/activity/`, a file a day, kept 30
days. It holds ids, subjects, senders and file names, and never a message body, an attachment or a secret.

- `agentcomms activity sessions` lists the agent windows, newest first; `agentcomms activity show <session>` lists
  what one did.
- `agentcomms activity items [--since <ms>] [--ids <id,…>] --json` lists every call that names an item, grouped by
  the item: a Gmail message by its id, a Slack message as `<channelId>/<ts>`. Each line names the window (its key,
  folder and client), the operation, when, and how it ended. A reply also links to what it answers: a Gmail reply
  draft and its send's prepare carry `replyTo`, a send carries its `draftId` and `threadId`, a Slack post its
  `thread` (null for a new message), and a Slack acknowledgement its `act`: `reply` or `reaction`. That is how the app
  tells which message an agent read, answered or only marked seen. Subjects and senders are the sender's words, inside
  the untrusted-content envelope. It is your view: refused inside an MCP server's process, with exit `10`, and has no
  tool, as `agentcomms activity show` has none. Every MCP server of this suite marks its own process as it starts
  (`AGENTCOMMS_MCP_SERVER`) — core's, each channel's and the event service's — so the refusal holds in any program one
  of them starts.
- An agent sees only its own window, through `comms_activity` (or `agentcomms activity mine`).

## What an agent may do, and how it writes

**What an agent may do is enforced.** A behaviour rule lets an agent start only some acts on an account, or in one
conversation — `post`, `reply`, `reaction`, `edit`, `delete` and `file` on Slack; `send` and `reply` on Gmail; `send`
on Resend — and the tools refuse any other before a preview, an approval or a send, and again at send if the rule was
narrowed after the person's yes: `ACT_NOT_ALLOWED`, exit `10`. With no rule, everything is allowed, as before. The
most specific rule wins — a conversation over its account, and for mail an address over the longest `@domain` that
covers it — and every recipient of a message is held to the rule for them. An address rule holds the address with any
`+tag` (`ceo+x@client.test` is `ceo@client.test`), and at Gmail with or without dots and at `gmail.com` or
`googlemail.com` alike; an `@domain` rule holds its subdomains too, and a rule for a subdomain wins over its parent's
(`@eu.client.test` over `@client.test`). A Gmail message is a `reply` only to the people on the message it answers —
its From, Reply-To, To and Cc, held in this mailbox outside Spam and Trash — and a `send` to anyone else. A Slack
destination must be a conversation id (`C…`, `G…`, `D…`); beneath that check, a place that is not one is held to every
rule of its account. Every preview says what holds, in a line such as
`Allowed here: reply, reaction (rule: acme/slack, #general)`.

```sh
npx @agentcomms/core behaviour     # every rule, and what each account allows, per conversation too
npx @agentcomms/core behaviour allow acme/slack reply,reaction  # only reply and react there (narrowing applies at once)
npx @agentcomms/core behaviour allow acme/gmail none --conversation @client.test  # never send to anyone there
npx @agentcomms/core behaviour clear acme/slack  # take the rule away, so the wider one holds (you approve it)
```

A rule that only narrows applies at once; one that lets an agent do more — an act added, a rule removed whose fallback
is wider, a conversation allowed more than its account — is approved first. A rule binds to its account's id, so a
rename keeps it — and so does `names migrate` — and one this release cannot read makes its account allow nothing. One
naming an account no account here could ever have (`*`, a name in capitals, a former name whose account is gone) makes
every account allow nothing; one naming a former name holds the account it names now. A server started before 0.22.0
holds no rule until its client restarts it: the first rule's result says so, and `doctor` names any such server.

**How it writes is guidance.** A writing profile is Markdown the person keeps in `compose/` in the config directory, in
five layers, each refining the one before: `default.md`, `user.md`, the platform's (`gmail.md`, `slack.md`,
`resend.md`), the account's (`inbox-acme__slack.md`) and each conversation's (`conversation-acme__slack__C0123ABC.md`,
`conversation-acme__gmail__@client.test.md`). An agent reads it before it writes, so the first preview is already
written to it. Nothing in it is ever sent, and nothing checks a message against it.

```sh
npx @agentcomms/core profile acme/slack --conversation C0123ABC  # the joined profile for there, and every file it reads
npx @agentcomms/core profile init acme/slack  # start that account's file from a starter; never overwrites one
```

Over MCP, `comms_behaviour` is `behaviour` — with no change it only reports; `setRule` and `removeRule` change it —
and `comms_profile` is `profile`, and only reads. No tool writes a profile: `profile init` is the person's, at a
terminal, because something an agent read could otherwise change how every later message is written.

## Messages sent without asking

**A standing approval is your yes given in advance, for acknowledgements only.** With one, an agent may answer a Slack
message that has just arrived from another person — the newest from someone else in its thread or channel, within 15
minutes — with one of the contents you wrote: a standard emoji reaction (`eyes` when you name none), or a short fixed
reply of at most 200 characters. It covers the places you named, or the threads you posted in yourself in the last 14
days; by default once a thread, 10 an hour, 30 a day and 3 a day on any one person's messages (3, 30, 100 and 10 at
most); and it ends 7 days after you approve it, 30 at most. Each act goes 5 to 30 seconds after the agent asks for it. A reply goes in the thread as the app or labelled, a reaction only as the app, and every act raises a
notification on your screen, goes in the audit and shows in `standing list`. Mail, top-level posts, edits, deletions,
files and removing a reaction are never sent this way.

Slack's `agent-slack standing add` makes one, and it is approved only with the code it shows, typed at a terminal:
never a typed `yes`, a client's form or a yes in chat, whatever the change policy. An agent can prepare one, and its
preview then says so; nothing changes until you approve it.

```sh
npx @agentcomms/core standing list    # each one: its contents by digest, places, limits, uses today and its last 10 acts
npx @agentcomms/core standing narrow <id> --keep <digest> --per-hour 5   # keep less of it (applies at once)
npx @agentcomms/core standing revoke <id>   # end one, at once
npx @agentcomms/core standing off           # end every one, at once
```

Tightening the change policy ends every one too, and a send policy of `never`, or removing the account, ends that
account's; loosening again revives none. `doctor` lists the active ones and when each ends. Over MCP, `comms_standing`
reports them, and with `narrow`, `revoke` or `off` changes them; nothing in core creates or widens one.

Every use is counted in the account's acknowledgement ledger, `standing/<account id>.jsonl` in the state folder
(`agentcomms paths` shows where that is). If a line of it cannot be read — a disk that filled mid-write — none of that
account's standing approvals can be used, since what they have counted cannot be known, and `doctor` names the account,
the line and the file. To recover, end that account's standing approvals (`standing off`, or `standing revoke` for
each), then move the file aside; a new ledger starts empty, and you can make new standing approvals.

**What it can still leak.** An agent misled by something it read still chooses which arriving messages to acknowledge,
with which content, and when, and anyone watching the acts can read those choices: at the defaults, tens of bits an
hour. A pause of 5 to 30 seconds before each act, and at most 3 acts a day on any one person's messages, narrow that;
they do not close it. Do not make a standing approval for an agent that also reads sensitive mail, files or secrets in
the same session.

**What it does not defend.** It holds against an agent acting through the MCP tools. An agent with an unrestricted
shell, running as you, is out of its reach: it can already get past the terminal check, edit the configuration and run
these commands as you — and so can anyone who can write to the configuration directory. Under the `chat` send policy
the tools already act on an agent's word, so there a standing approval adds limits rather than freedom.

## The core MCP server

`agentcomms mcp` runs it on stdio; `agentcomms mcp install --client <client>` registers it, from a terminal, since it
is the one registration that cannot come from chat. After a restart of the client, an agent can do the rest:

| Tool | What it does |
|---|---|
| `comms_channels_available` | which declared servers exist — core, Gmail, Resend, Slack, WhatsApp and events — which are installed and at which version, and which clients start each |
| `comms_server_install` | register a declared channel or service server with a client; the server appears once the client restarts |
| `comms_server_prune` | remove the managed runtimes old releases left behind: every managed server's, listed by server, or one `channel`'s; `dryRun` lists them |
| `comms_server_uninstall` | take one `channel`'s server out of one `client`, at once, as `mcp uninstall`: every user-scope entry of it there, saved first; a project's own entry is left, and said |
| `comms_update` | what is behind the latest release (`check`), and bringing every registration, runtime and global package there as one change; `level` sets how this machine updates (`auto`, `every-14-days`, `never`), `pause` holds the notice for 1, 7 or 14 days and `resume` ends a pause |
| `comms_change_policy` | report or set the change policy of the defaults, a mailbox or a workspace |
| `comms_attach` | which files may be attached, as `attach`; `rootsAdd` allows another folder once the person approves, and `rootsRemove`, `denyAdd` and `denyRemove` change the rest |
| `comms_label` | how what an agent sends is labelled, as `label`, with each Slack workspace's style; `word`, `name`, `icon`, `addRule` with `as: "me"`, `removeRule` of an `agent` rule and `style` set to `labelled` are approved first, and the other rule changes and `style` back to `app` apply at once |
| `comms_behaviour`, `comms_profile` | what an agent may do, and how it writes: see above |
| `comms_standing` | the standing approvals, as `standing list`: what an agent may send without asking, each one's uses and last acts; `narrow`, `revoke` and `off` only take away, so each applies at once, and `off` ends every one. Creating or widening one is Slack's, approved only with the code at a terminal |
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
