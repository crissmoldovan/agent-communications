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
npx @agentcomms/core channels      # which servers exist, which are installed, where each is registered, and what each takes as a connection's part
npx @agentcomms/core mcp install --client claude-code   # register the core MCP server
npx @agentcomms/core mcp install --server events --client claude-code   # register the events MCP server
npx @agentcomms/core mcp uninstall --client cursor --server gmail   # take one server out of one client, at once
npx @agentcomms/core activity sessions   # the agent windows that read or sent anything, newest first
npx @agentcomms/core activity items --json   # every call that names a message, grouped by the message
npx @agentcomms/core search status   # Search on this machine: on or off, what is kept by count, the model, backups
npx @agentcomms/core search query -- what did David ask about invoices   # by words, and by meaning with a local model
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
either kind. Given `--app-approval` it is refused and nothing is applied: from the attested app on macOS with `USAGE`
(exit 64), since the change needs none; from anywhere else — an agent, an MCP server's process, a parent that is not
the app, Windows or Linux — the origin is checked first, so it is refused as any other app approval there is, with
`APPROVAL_REQUIRED` (exit 10). On macOS core checks that the app started this
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

- `agentcomms activity sessions` lists the agent windows, newest first — each with the MCP connection it was last
  used through (`connection`, by id and name, from 0.35.0) — and `agentcomms activity show <session>` lists what one
  did.
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

## Search on this machine

`agentcomms search status`, `search query` and the other `search` commands keep the words of the messages agents read, for the accounts the person chose, so they can find
what each person asked (design 2026-10-26-local-search). Off by default; `search on`, `search accounts add` and
`search model set` are loosenings, approved at a terminal or in the attested app with `--app-approval`; `search off`,
`accounts remove`, `model none` and `delete --all --confirm` apply at once; Delete everything, which cannot be undone,
is the person's alone, refused to an agent as their searches are.

- **Capture:** a channel hands `captureForSearch(core, account, captures)` what an ok call had in hand; core keeps it
  only while Search keeps that account, never from the account's own handles, as one sealed line in
  `<state>/search/inbox/<UTC day>-<pid>.jsonl`. It never throws and never changes a result.
- **The store:** `<state>/search/search.sqlite` through `node:sqlite`, opened only by the person's search commands —
  the indexer is its one writer, run by `search index`, before every search for two seconds, and by the app. Full-text
  search is probed (FTS5, contentless, deleting), so a Node without it — before 22.18 — says so and keeps nothing.
  Text, subject, sender's name and a person's label are AES-256-GCM sealed under `search-index` in the configured
  secret store. The words index holds no word: each word, folded, is an HMAC under a subkey of that key, with no
  position kept. The vectors and the handles are not encrypted.
- **Meaning:** a loopback Ollama only, a reviewed model only (`qwen3-embedding:0.6b`, `embeddinggemma`, `bge-m3`),
  checked against `/api/tags` before any word is sent; words only without one.
- **Who reads it:** the person alone. Every command but `status` and the tightenings is refused inside an MCP
  server's process and under an agent's marker, and there is no MCP tool; doctor's `search` check is content-free.
  Every sender-derived field of a hit comes back in the untrusted-content envelope, and a search writes one activity
  line with its words and a count, and no items.

## Which session answers a message: taking messages

When several agent windows read the same account, one session takes a message before it acts on it, and the others
leave it. A session takes a message with its channel's take tool — `gmail_take`, `slack_take`, `resend_take` — or the
channel's `take` command, hands it back when it is not its own (with a closed reason: `not-mine`, `wrong-account`,
`needs-the-person`, `duplicate` or `other`, and a note for you alone), or marks it done. Which session is taking is
worked out by the server or the command from the process it runs in — the activity session, and Claude Code's session
id — never from an argument. A take lapses an hour after the session's last act on the message, or as soon as its agent
window has ended, unless a send it prepared still waits for your yes.

Each account says whether a session must take a message before it acts on it. Off by default, so nothing changes until
you turn it on:

```sh
npx @agentcomms/core taking                                  # every account: required or not, and what a take says
npx @agentcomms/core taking acme/slack --require on          # a session must take a message first (applies at once)
npx @agentcomms/core taking acme/slack --require off         # sessions may act without taking (you approve it)
npx @agentcomms/core taking acme/slack --unclaimed 30        # a message nobody takes in 30 minutes counts as not taken
npx @agentcomms/core taking acme/slack --notify off          # no reminder: it waits under Not taken (you approve it)
```

A shorter wait and a reminder apply at once; a longer wait, like no reminder, lets a message nobody took go unnoticed
for longer, so you approve it, as every loosening.

With it on, an act that answers a message — a reply, a reaction, an acknowledgement — is refused without the take,
`TAKE_REQUIRED` (exit `10`), before any preview or approval and again just before it is sent. A message another session
has is refused with `TAKEN_ELSEWHERE` (exit `10`) whether or not a take is required. A new message, a post at the top of
a channel, and an edit of your own answer nobody's message, and need no take. `--acknowledge eyes` (Slack only, approved
first) records that a take may say so to the sender with 👀 under a standing approval you made; this release does not
post that 👀 yet. Over MCP, `comms_taking` is `taking`: with no change it only reports.

Who has each message is yours to see and to change, at your terminal or in the app:

```sh
npx @agentcomms/core takes list --json                       # every take, offer, hand-back and done, with notes
npx @agentcomms/core takes release acme/slack C0123/1729936800.000100   # nobody has it now
npx @agentcomms/core takes give acme/slack C0123/1729936800.000100 --window <id>   # offered to one window for 15 min
npx @agentcomms/core takes keep acme/slack C0123/1729936800.000100      # you handle it: every session leaves it
```

The window's id is a Claude Code session id or an activity session key (`activity sessions` lists them). These four
have no tool, and refuse inside an MCP server's process and in a shell a coding agent marks, with exit `10`: no session
reads, ends or gives another's take. An agent sees only closed words — `you`, `another session`, `the person` — and the
reasons a message was handed back, never another session's folder, client or id, and never a note. The records are in
`<state>/takes/`, one owner-only file per message, holding ids and those words and nothing a sender wrote, each deleted
thirty days after it last changed.

A take allows nothing by itself: every act still needs the behaviour rules, the send policy and your yes. It keeps two
sessions from answering the same message. It is a speed bump against agents, not a boundary against code running as
you: a shell an agent marks nothing in runs these commands as you, and every process here runs as you.

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
| `comms_connections_list`, `comms_connection_show` | the MCP connections — each place an app uses Agent Comms, its parts, accounts and entry — never with a key; with no id inside a connection, `comms_connection_show` is that connection |
| `comms_connection_add`, `comms_connection_change`, `comms_connection_migrate` | add a connection, change its parts, or move an app's separate entries into one: approved first where it reaches more, at once where it only narrows; `comms_connection_change` changes the parts of the connection the server is a part of only — another's are the person's, at their terminal or in the app |
| `comms_connection_rename`, `comms_connection_key_replace`, `comms_connection_remove` | rename the connection the server is a part of, give it a new key (written into its entry, the old one stopping), or remove it: each at once — but a remove that lets agents in its folder reach more is approved first; another connection is the person's, at their terminal or in the app |
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

## MCP connections: one Agent Comms per place an app uses it

From 0.35.0 an app can start Agent Comms as **one** MCP server instead of one per channel: a *connection*. It is a
place an app uses Agent Comms — Claude Code in every folder, Claude Code in one project, another Claude profile, Codex,
Cursor, Claude Desktop, Gemini, VS Code, or a snippet you paste into any other app — with a name, the parts it reaches
(Agent Comms itself, Gmail, Slack, Resend, WhatsApp, Events), the one account each part is kept to or every one,
read-only where Gmail offers it, and a key of its own.

```bash
agentcomms connection add --app claude-code --name "Work — Claude Code" --parts core,gmail:acme/gmail:read-only,events
agentcomms connection list
agentcomms connection show <id>
agentcomms connection change <id> --parts core,gmail:acme/gmail,slack
agentcomms connection rename <id> "Acme — Claude Code"
agentcomms connection key replace <id>
agentcomms connection remove <id>
agentcomms connection migrate            # your app's separate entries into one connection; --undo <id> goes back
```

- **What the app starts** is `agentcomms mcp --connection <id>`, which starts each part as its own process — the same
  program its own entry starts — and passes their tools through under their own names. One part that crashes or hangs
  holds up none of the others. The app shows the tools as `mcp__agentcomms__gmail_search` rather than
  `mcp__gmail__gmail_search`, so permission rules that named the old servers need allowing again after a migration.
- **Adding a connection, or letting one reach more** — a part added, an account let go or moved, read-only off — is
  shown first and approved, at your terminal, in the app (`--app-approval`, macOS), or in a chat under the `chat` change
  policy. **Taking away applies at once**: a part removed, kept to one account, read-only on, the connection removed.
  Except one removal: a one-project connection over the app's Agent Comms for every folder — its entry shadows that
  one, so once it is gone the agents in that folder use the wider one. That remove waits for you like a loosening,
  and its preview says what they would use instead. Renaming it and replacing its key give an agent nothing more, and
  apply at once too. An agent — over MCP, or from
  its shell — renames, re-keys and removes only the connection it is a part of; any other is yours, at your terminal
  or in the app.
- **The key** is not a password: apps on this Mac start Agent Comms as you, so it keeps out no program running as you —
  such a program can read the app's config, or start a channel's server itself, as it always could. What it does: it
  says which connection a call came through, so Activity says "used by <name>", and removing the connection or
  replacing its key stops every copy of it at once. Agent Comms keeps only its hash, writes it into the app's entry
  (in the entry's environment, never its arguments), and shows it only for a Manual snippet, once — at your terminal
  or in the app, never to an agent. The gateway takes it out of its own environment once it has checked it, and no
  part is given it; but the environment a process started with stays readable while it runs, so `ps eww` shows the
  key to programs running as you for as long as that gateway runs — accepted, since such a program can read the app's
  config anyway. If Agent Comms is ever reachable over a network, the key becomes a real secret.
- **One project** is Claude Code's own local scope, kept in `~/.claude.json` and never in a `.mcp.json`, which is
  often committed and would carry the key into the repository.
- **Your existing separate entries keep working**: nothing moves until you run `connection migrate`, which makes one
  connection per app reaching exactly what those entries reached, saves each entry it removes, and can be undone.
  `connection list --json` says which connections a migration made (`migratedFrom`, with the entries it replaced), and
  `connection migrate --undo` refuses any other: one you added replaced nothing, so there is nothing to put back.
- `connection` commands are `comms_connections_list`, `comms_connection_show`, `comms_connection_add`,
  `comms_connection_change`, `comms_connection_rename`, `comms_connection_key_replace`, `comms_connection_remove` and
  `comms_connection_migrate` over MCP; a Manual connection is the one thing they do not do. Inside a connection,
  `comms_connection_show` with no id says which connection this is.

The design: [docs/superpowers/specs/2026-10-26-single-server-design.md](../../docs/superpowers/specs/2026-10-26-single-server-design.md).

## Licence

MIT
