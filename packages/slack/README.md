# @agentcomms/slack

Slack for coding agents. Read channels, threads, search, people and files across one or more workspaces — and
draft messages that **nothing posts without a person's approval of exactly what goes out**.

```sh
npm install -g @agentcomms/slack    # or run it with npx @agentcomms/slack <command>
```

## What makes this different from a Slack integration

**Read-only means read-only, and Slack enforces it.** Slack's read and write scopes are genuinely disjoint: a
token holding only `*:history` and `*:read` cannot call `chat.postMessage` at all, and the consent screen says
so. Install a workspace in the default `read` mode and no bug in this software can post from it.

Be exact about what that buys. It is **"this package cannot post"**, not "nothing on this machine can post" — a
second Slack server holding a write token for the same workspace posts without going near this one. Look in your
agent's MCP server list for another Slack entry, and remove it if you want the guarantee to mean anything.

**Nothing is posted without a person.** Even in `send` mode, an agent prepares and a person approves that exact
content — by saying yes in the conversation under the workspace's `chat` policy, or by typing a code at their own
terminal under `confirm`; under `never` nothing posts. A broadcast or a large room needs the terminal whatever the
policy says. The preview shows what the recipient will read and **how many people it interrupts** — `@channel` is
eight characters whether the room holds three people or four hundred.

**You bring your own Slack app.** There is no shared app to install. `agent-slack manifest` prints one to create
in your own workspace, so the scopes are visible before anything is granted and your admins keep control. No
client secret is stored anywhere: the sign-in is PKCE, and the verifier never leaves your machine.

## Getting started

```sh
agent-slack manifest --mode read --port 51234      # the app to create, and how
agent-slack workspace add acme/slack --client-id <id> --port 51234
agent-slack doctor
agent-slack mcp install --client claude-code         # connect it to your agent, once you approve it
```

The port must be the same number in both commands — Slack stores redirect URLs on the app and matches them
exactly.

## Changing a workspace, and who approves it

Connecting a workspace, signing it in again, moving it between `read` and `send`, setting its policies and removing
it work from a terminal and from a chat alike, and ask the same way. Anything that loosens what a workspace may do —
connecting it in `send`, moving it to `send`, loosening a policy — or that cannot be taken back — removing it — is a
**change approval**: you are shown a preview of exactly what changes, and nothing happens until you agree to it.
Tightening applies at once.

```sh
agent-slack workspace mode acme/slack send                 # the app's send manifest, and the link to its page, first
agent-slack workspace mode acme/slack send --app-updated   # then the change: a preview, your yes, and the sign-in
agent-slack workspace policy acme/slack --send confirm     # tightening: applied at once
agent-slack workspace remove acme/slack                    # a preview, then your yes
```

How you agree is the workspace's **change policy**. Under `chat`, the default, a yes — in the conversation, or typed
at the terminal running the command. Under `confirm`, a code typed at your own terminal: the command asks for it, and
an agent hands you the approve command the result gives, to run exactly as given — this installation's own, its
folders pinned, whether core is installed beside Slack or only inside it.
`agent-slack workspace policy <name> --change confirm` switches to that; moving back to `chat` is itself approved
under `confirm`. An agent that runs the command without your approval gets the preview and an approval id, exits 10,
and runs it again with `--approval <id>` once you have agreed.

Every sign-in stops at Slack's own consent screen, which is yours to approve, and the app's manifest is yours to
change.

## Changing the app from the CLI

Pasting the manifest on the app's page is the default. With an **app configuration token** — generated at
https://api.slack.com/apps under "Your App Configuration Tokens", valid for twelve hours — the CLI can do that step
itself:

```sh
agent-slack app create acme/slack --mode read --port 51234   # a new app; prints its Client ID and what to run next
agent-slack app update acme/slack --mode send                # the app acme/slack signed in through, to the send manifest
```

Both ask Slack to validate the manifest first, and a refusal changes nothing. `app update` replaces the app's whole
configuration with the manifest `agent-slack manifest` prints — a hand-set name or description included — and
changes no token: a workspace updated to `send` still cannot post until you run `agent-slack workspace mode <name>
send --app-updated` and approve the change and the sign-in, which it prints. `app create` keeps only the app id and Client ID from Slack's reply; the client secret and
signing secret it also returns are dropped unseen, because the PKCE sign-in needs neither.

The token is read from a hidden prompt, or from `SLACK_APP_CONFIG_TOKEN` for that one command, and is used for that
command's calls only: never stored, logged or printed, and never accepted as an option, which would land in your
shell history. Without a terminal or the variable, the command refuses. No MCP tool takes the token or changes an
app — a token typed into a chat stays in the transcript — so an agent gives you the command to run instead.

## Reading

```sh
agent-slack channels --workspace acme/slack
agent-slack read C024BE7LR --workspace acme/slack --limit 50
agent-slack thread C024BE7LR 1700000000.000100 --workspace acme/slack
agent-slack search 'in:#engineering invoice' --workspace acme/slack
```

Every read is bounded and says so: `complete: false` means a page remained, and a short list is not a quiet
channel.

### Saving files

```sh
agent-slack files download --workspace acme/slack --file F07ABCDE123
agent-slack files download --workspace acme/slack --message C024BE7LR 1700000000.000100
agent-slack files download --workspace acme/slack --channel D024BE7LR --since 1700000000 --to ~/Invoices
```

By id, the files of one message, or a conversation's files — a channel, a DM or a group DM — uploaded from a
timestamp on (`--since` goes by upload time, to the second: a file uploaded earlier and shared later is left out).

**You say where they go.** Nothing is saved until you have: the command lists the files — each name, size, who
uploaded it and where — and asks whether to save them in `1` your Downloads folder, `2` the folder you ran it in, or
`3` a folder you name (absolute, or starting with `~`; it is made if missing). Both folders are shown by their exact
paths. Downloads is `defaults.downloadsDir` when you set one; otherwise the folder your system keeps — on Linux the XDG
one (`XDG_DOWNLOAD_DIR`, or `~/.config/user-dirs.dirs`), on Windows the Downloads known folder wherever it was moved,
else `~/Downloads`. At your own terminal you may also say it with `--to downloads`, `--to current` or `--to <folder>`
— only there: with no terminal, with `--json`, through a pipe, or run by an agent, the command saves nothing, prints
the question with a choice id and exits `10`, and `--to` needs the question's `--choice` beside it. Over MCP
`slack_file_download` asks the same way: its first call answers `destinationRequired: true` with the question and a
`choiceId`. A choice is for those files, under the names it showed, and no others; it is used once, and expires after
thirty minutes. A call with other arguments is refused, and the question stays open for the right one; a file renamed
on Slack after the question is refused rather than saved under a name you were not shown.

**Your answer follows the workspace's change policy.** Under `chat` (the default), the agent passes your answer back
— `saveTo` with the `choiceId`, or `--to <answer> --choice <id>`. Under `confirm` you answer it yourself, at your own
terminal: the approve command the result gives shows the question again and asks `1`, `2` or `3`. The agent then calls
again with the `choiceId` alone; an answer it passes in the arguments is refused, and the question is left open for
you.

**Some folders are never saved into, whoever answers.** A hidden folder anywhere, at any depth and on any disk —
`~/.ssh`, `~/.config`, a project's `.git`, `.github`, `.husky`, `.vscode` or `.claude` — except a checkout under
`.claude/worktrees/<name>`, which is a project like any other (a hidden folder inside it is still refused); a folder
programs load packages from, wherever it is — `node_modules`, `site-packages`, `dist-packages`, `__pycache__`, and any
folder inside a Python virtual environment, one with `pyvenv.cfg` in it or above it; any folder inside a Python
installation, one with `conda-meta`, `Lib/os.py` or `lib/python3.<minor>/os.py` in it or above it, such as
`~/miniconda3` or `C:\Python312` (your home and a disk's root are never taken for one); `~/Library`; this package's own
configuration, state, data and credentials folders; the system's folders (`/`, `/etc`, `/usr`, `/bin`, `/var`,
`/System`, …), though a home inside one, such as `/root`, is yours; and on Windows `AppData`, `%PROGRAMDATA%`, the
Windows folder, Program Files, PowerShell's profile folders (`Documents\PowerShell` and `Documents\WindowsPowerShell`,
wherever Windows says Documents is), a drive's root, a network share and a path with no drive — and on Linux the same
Windows folders reached through WSL, on a Windows drive wherever and however it is mounted (`/mnt/<letter>` by
default): the drive itself, and a folder on it named `Windows`, `Program Files`, `ProgramData` or `AppData`, or
PowerShell's profile folders, at any depth and in any case. A folder that leads to one through a link is refused
as that folder: a `hooks` link to `.husky` is `.husky`. In any of them a file would be something a program runs or loads
on its own — a hook, a package, a profile, a key, an approval — rather than a file you read. These are the folders every
machine of their kind has, or that a file in them makes plain; a folder a program was told to load whole — a zsh
completions folder, an application's plugin or startup folder — cannot be known from here, and saving into it is your
choice. Your home folder itself is fine. When the folder you ran the command in is one of these, option `2` is shown as
unavailable, with the reason. A folder that cannot be written in is refused too, before your answer is used up.

Each file is saved under the name its uploader gave it, made safe — no path in it, no leading dot, no control or bidi
characters, no Windows device name — and never over a file already there: the new one is saved beside it as `-2`.
Nothing else is written in the folder. The name, the title and the uploader's name come back inside the
untrusted-content envelope, and so does the name the file was saved under, and its path, unless that name is plainly a
file name. The type comes back inside it too, unless it is a plain MIME type such as `application/pdf`, and any risk
flags beside it. Nothing is opened or run.

**A file is saved under a name nothing runs it by.** It keeps its extension only when that is a kind of file a viewer
opens and no program is known to run or load by its name: a document (`pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`,
`pptx`, `odt`, `ods`, `odp`, `rtf`, `txt`, `csv`, `tsv`), an image (`png`, `jpg`, `jpeg`, `gif`, `webp`, `heic`, `heif`,
`bmp`, `tif`, `tiff`), sound or video (`mp3`, `m4a`, `wav`, `aac`, `flac`, `ogg`, `mp4`, `mov`, `m4v`, `webm`, `avi`,
`mkv`), an archive (`zip`, `tar`, `gz`, `tgz`, `bz2`, `xz`, `7z`, `rar`), a calendar, contact or mail file (`ics`,
`vcf`, `eml`), or an Apple document (`pages`, `numbers`, `key`). Anything else — an executable, a script, configuration
(`json`, `yaml`, `toml`, `ini`, `md`, …), a macro document, HTML or SVG, a `.pth`, `.plist` or `.lnk`, a name with no
extension — and the few names a tool reads although their extension is on that list (`CMakeLists.txt`,
`requirements.txt` whatever a project calls it — `dev-requirements.txt` too — `conanfile.txt`, `apt.txt`, `runtime.txt`,
`python312.zip`) are saved with `.download` after the whole name: `setup.exe` as `setup.exe.download`, `CLAUDE.md` as
`CLAUDE.md.download`, `Makefile` as `Makefile.download`. A program that loads a file by its extension or by a name it
knows — Python's `.pth`, git's hooks, an agent's `CLAUDE.md` — passes such a file by until you rename it yourself; one
that loads every file in a folder whatever it is called is not stopped by a name, which is why the folder is yours to
choose. Such a file is flagged `saved-as-download` (and `auto-read` when tools read it by name). The question names each
one before you answer — "setup.exe (executable) will be saved as setup.exe.download — a type that could run; rename it
yourself if you trust it" — with every other risk flag, and the result says it again, in `warnings`.

`doc`, `xls`, `ppt`, `odt`, `ods` and `odp` keep their names, since you open them as you open a `docx`, but unlike a
`docx` each can hold macros. Each is flagged `macro-capable`, and the question and the result say so in words:
"report.xls can hold macros — open it only if you trust the sender".

**Every saved file is marked as downloaded from the internet**, as a browser marks one — the moment it is made,
before its bytes are written, so nothing watching the folder finds it unmarked: on macOS with the
`com.apple.quarantine` attribute, so Gatekeeper asks before it first runs, and on Windows with a `Zone.Identifier`
stream for the Internet zone, so SmartScreen asks and Office opens it in Protected View. Linux keeps no such mark, and
neither does a file WSL saves onto a Windows drive. Each file's `marked` says which it carries; a file that could not be
marked is still saved, and `warnings` says so.

The bytes come from `files.slack.com` alone, with the workspace's token, and only at the address of the file just
looked up: a file held outside Slack, a redirect or Slack's sign-in page is refused, and no file may be over 100 MiB
or a run over 500 MiB. A download is given up on when `files.slack.com` sends nothing for 30 seconds, or when the
whole file takes longer than its size allows — its size at 128 KiB a second, and two minutes at least, so 800 seconds
for 100 MiB; the reason under `skipped` says which. An HTML file is refused too, always: Slack answers with a web page when the token cannot read a
file, and an HTML file is a web page, so the two cannot be told apart. It is listed under `skipped` as
indistinguishable from the sign-in page; open it in Slack instead. A file that cannot be fetched is listed under
`skipped` with the reason while the rest are saved; a manifest under this package's own state directory — never in
your folder — lists what was saved, and the download goes in the audit log, naming the folder. A run that stops
part-way — a disk that fills — ends in an error that says what was saved, and its manifest lists the files it stopped
before under `skipped`, as `stopped`. It is a read, so it works in `read` mode; where it saves is yours to say, and
nothing else about it needs approving.

Everything a sender controls arrives inside an `<untrusted-content>` envelope — the message, the notification
half when it disagrees, attachments, and anything Slack unfurled, each labelled with what it is and whose page it
came from. Two flags are worth acting on:

- **`mismatch`** — the message says one thing in the channel and another in its notification text. Slack does not
  make the two agree, and that gap is how an instruction reaches a model that nobody in the room can see.
- **`unrenderable`** — part of the message could not be shown.

Attribution comes from `bot_id` and `user`, which an app cannot choose. A display name it picked for a message is
reported as the name it wore, never as identity.

## Posting

```sh
agent-slack draft create --workspace acme/slack --channel C024BE7LR --text 'ready when you are'
agent-slack post prepare --workspace acme/slack --draft <draftId>   # prints the preview, posts nothing
agent-slack approve <approvalId>                                    # under `confirm`: the command the result gives
agent-slack post send --workspace acme/slack --draft <draftId> --approval <approvalId> --expect-channel C024BE7LR
```

A draft is a local file, because Slack has no server-side draft. That is better in one way — nothing exists in
Slack until you say yes — and worse in another: you cannot open it in Slack and finish it yourself, so the
preview is written to be pasteable.

The approval binds the exact bytes. Editing the draft voids it; so does the room growing between the preview and
the post, because the words did not change but who reads them did.

A post goes to a conversation id — a channel's `C…` or `G…`, or a direct message's `D…`, which `agent-slack channels`
lists. A user id (`U…`, `W…`) is refused as the destination; mentions still take one. And it goes only to a room you
have joined: a post to a channel you are not a member of is refused (`SCOPE_MISSING`) before any preview, and again at
`approve` and at `post send`, before the approval is spent — join the channel in Slack yourself, then prepare it
again. Direct messages and group DMs are exempt. When the room cannot be read, the preview says membership could not
be checked.

### Files

A post can carry up to ten local files, each up to 100 MiB, with or without words: `--file` on `draft create`, and
`draft update <draftId>` with `--file` to replace them, `--add-file` to add more or `--no-files` to take them all off.

```sh
agent-slack draft create --workspace acme/slack --channel C024BE7LR --text 'the Q3 numbers' --file ~/reports/q3.pdf
agent-slack draft update <draftId> --workspace acme/slack --add-file ~/reports/q3.csv
```

Which files may be sent is the rule Gmail's attachments follow: regular files under your home folder, and none from
its hidden folders, a `.git` folder or a `.env` file. A file in `/tmp` or anywhere else is refused — copy it under your
home folder first. A draft records each file's real path, the name Slack will show, its size, its type and its
SHA-256, never its bytes.

The preview lists every file with those five things, and warns about one over 10 MiB or one Slack shows in the
channel itself. The approval is bound to each file's hash: a file is read again when the post is prepared, and every
file is read and checked again when it is sent, before anything is uploaded — one that changed voids the approval
and nothing goes. Then each file goes to the upload URL Slack gives for it, and one call shares them all, with the
words as their message. `post send` prints each file's id in Slack and the message's `ts`, or says that Slack had not
attached them to a message yet: Slack's answer has no `ts`, and none is guessed. Each upload is allowed its size at
64 KiB a second, and five minutes at least.

A message is posted with link previews off. A post with files cannot be — Slack offers no way to turn them off for
files — so Slack may fetch a link in the files' words and show its preview to everyone in the channel. For such a post
the preview lists every link in the words, bare `https://…` ones included, the approval is flagged `link-may-unfurl`,
and a warning says to post the link as a message of its own if it should not unfurl.

Sending a file needs the workspace in `send` mode with `files:write` granted; without it the prepare is refused with
the command that fixes it.

### Editing and deleting

A message this account posted can be edited — its words, its files, or both — or deleted, through the same gate: a
preview first, then the act, once, after the same approval a post needs.

```sh
# New words: a draft with them, then the edit.
agent-slack draft create --workspace acme/slack --channel C024BE7LR --text 'ready at noon'
agent-slack edit prepare --workspace acme/slack --draft <draftId> --ts 1700000000.000100      # changes nothing
agent-slack edit send --workspace acme/slack --draft <draftId> --approval <approvalId> --expect-channel C024BE7LR --ts 1700000000.000100

# Replace a file and keep the words: a draft with the new file and no words, and the old file's id to take off.
agent-slack draft create --workspace acme/slack --channel C024BE7LR --file ~/reports/q3-chart-v2.png
agent-slack edit prepare --workspace acme/slack --draft <draftId> --ts 1700000000.000100 --remove-file F0C739JK4LE

agent-slack delete prepare --workspace acme/slack --channel C024BE7LR --ts 1700000000.000100  # deletes nothing
agent-slack delete send --workspace acme/slack --channel C024BE7LR --ts 1700000000.000100 --approval <approvalId>
```

Both read the message from Slack first, and refuse one this account did not write — a deletion too, even for an admin
whose account Slack would let delete anybody's. The preview shows the message as it is now: an edit's shows its words
now and after, the files it keeps, takes off and attaches, and counts who sees them as a post's does; a deletion's
shows the words, and the replies and files that are not deleted with it. The approval binds the message as it was
read, so one edited in Slack after the preview, or a deletion's thread that gained a reply, voids it.

An edit leaves a message where it is — a draft written as a reply in a thread is refused. Its words go as text, so
Slack marks the message edited; nobody who read the old words is told what changed. A draft with no words keeps the
message's exactly as they are, mentions included. New files are chosen, checked and bound by hash as a post's are, go
up shared nowhere, and are attached by the edit itself; the edit sends every file the message should end with, which
is how Slack's `chat.update` works (it replaces the message's files with the list it is given). A file taken off stays
in Slack, shared nowhere — delete it there if it should go. Changing files needs `files:write`. Mentions in an edit
are counted as if Slack notified them, and a link in one may unfurl: an edit has no switch to stop it. A deletion
cannot be undone.

## As an MCP server

Register it with your agent's client, which also starts it once to prove the entry works:

```sh
agent-slack mcp install --client claude-code                       # or codex, cursor, gemini, claude-desktop, vscode
agent-slack mcp install --client claude-code --workspace acme/slack # pinned to one workspace
```

Registering hands your agent a new set of tools, so it is a change you approve — the same change as the core
server's `comms_server_install` with `channel: "slack"`, and an approval from either is good on the other. At a
terminal it shows what it will register and asks you to type `yes`; run by an agent, it exits `10` with the preview
and an approval id, and registers when run again with `--approval <id>` after your yes. `--print` and `--client json`
write nothing and ask nobody.

The entry pins the exact version, so a newer release reaches the agent only when you register it again with
`--force`, then restart the client. `agent-slack mcp prune` then removes the runtimes old releases left behind, once
you approve the list it shows (`--dry-run` only lists them). `agent-slack mcp --workspace acme/slack` runs the server
on stdio directly.

| Tools | What they do |
|---|---|
| `slack_workspaces_list`, `slack_workspace_show`, `slack_mode` | which workspaces are connected, and what each may do |
| `slack_workspace_add`, `slack_workspace_finish` | connect a workspace: start the sign-in and return its link, then finish it — `send` is approved first |
| `slack_workspace_reauth` | sign one in again — widening to `send` is approved first |
| `slack_mode_set` | move one to `send` (the app's manifest first, then an approved change) or back to `read` (the steps) |
| `slack_workspace_policy` | report or set how its posts and its changes are approved — loosening is approved first |
| `slack_workspace_remove` | disconnect one and delete its token — approved first |
| `slack_doctor` | what `agent-slack doctor` checks, as the same JSON |
| `slack_manifest` | the app manifest, and for a connected workspace the link to its own app's manifest page — changes nothing |
| `slack_channels`, `slack_read`, `slack_thread`, `slack_search`, `slack_people`, `slack_files` | read, bounded |
| `slack_file_download` | save files where the person says — asks first; by id, from one message, or from a conversation; opens nothing |
| `slack_post_prepare` | compose a draft, with local files if given, and return the preview a person must approve — posts nothing |
| `slack_post_send` | post a prepared draft once its approval allows it, reading every file again first — the operation `agent-slack post send` runs |
| `slack_react`, `slack_react_send` | add or remove a reaction through the same gate — `agent-slack react` |
| `slack_edit_prepare`, `slack_edit_send` | change the words or files of a message this account posted, through the same gate — `agent-slack edit prepare` and `edit send` |
| `slack_delete_prepare`, `slack_delete_send` | delete a message this account posted, through the same gate — `agent-slack delete prepare` and `delete send` |
| `slack_approval_wait` | where an approval stands, now or once a person approves it — only looks; `agent-slack approval wait` |
| `slack_draft_create`, `slack_draft_update` | write a draft, or change one — words, channel, thread, mentions or files — without preparing it |
| `slack_draft_list`, `slack_draft_get`, `slack_draft_delete` | the drafts prepares leave behind |
| `slack_mode_request_send`, `slack_mode_narrow` | the steps to change a workspace's mode, as text — changes nothing |

Every one that acts on a workspace takes `workspace`. The full list, with arguments, is `docs/reference/slack-mcp-tools.md` in
[the repository](https://github.com/crissmoldovan/agent-communications).

Or embed it:

```js
import { createSlackMcpServer } from '@agentcomms/slack';

const server = await createSlackMcpServer({ workspace: 'acme/slack' });
await server.connectStdio();
```

No tool approves. `slack_post_send`, the reaction tools and the edit and delete sends claim an approval through the
gate the CLI uses: under `chat` your yes in the conversation is the approval; under `confirm` they return
`APPROVAL_PENDING` with the approve command for you to run — this installation's own, its folders pinned — and `slack_approval_wait`, with which the agent
learns that you have; they post only after you have, within 24 hours; under `never` they refuse. A post whose outcome
Slack never answered is `SEND_OUTCOME_UNKNOWN`: it may have posted, and is checked in the channel, never repeated. The tools that change a workspace return a preview and an approval id first, whenever the change loosens
it or removes it, and apply it only when called again with that id — after your yes under the `chat` change policy,
after the approve command the result gives, at your terminal, under `confirm`. A server pinned to one workspace
connects and removes none. No tool changes the Slack app itself: that needs an app configuration token, and a chat's
transcript would keep it.

## Modes

| Mode | What the token can do | Who enforces it |
|---|---|---|
| `read` (default) | history, read, users, files, search | **Slack** |
| `send` | the above plus `chat:write`, `files:write`, `reactions:write` | this package's approval gate |

Moving to `send` means editing your app's manifest — on its page, or with `agent-slack app update <name> --mode
send` — and then approving the change and re-authorising: a new grant you approve in Slack's own UI.
`agent-slack workspace mode <name> send` walks both, from a terminal or, as `slack_mode_set`, from a chat. Going
back means removing the app's installation in Slack first: Slack adds scopes to a token and never removes one.
`agent-slack workspace mode <name>` prints either path.

## Licence

MIT.
