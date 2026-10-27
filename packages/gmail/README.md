# @agentcomms/gmail

Gmail for coding agents: search, read, analyse and draft across several mailboxes — with **sending gated by an
approval the user gives at that moment**.

This package is the `agent-gmail` command and the MCP server behind it. It is part of
[agent-communications](https://github.com/crissmoldovan/agent-communications).

The local event daemon, [`@agentcomms/events-daemon`](../events-daemon/README.md), may call this package's internal
read-only event operation. It adds no Gmail command
or MCP tool, and it cannot send.

## Why the sending rule exists

Every Gmail permission that lets an app write a draft also lets it send: there is no scope that separates the two.
So "the agent may draft but not send" cannot be enforced by the grant, and is enforced here instead — one code path
reaches Gmail's send endpoints, and it refuses without an approval that matches the exact message being sent.

## Who a message appears to come from

A draft an agent writes says so in its From line — `"Jo Example (agent)" <jo@example.com>` — so whoever receives it
can tell the person's agent sent it, not the person ([design](../../docs/superpowers/specs/2026-10-15-agent-label-design.md),
§5).

- **The name** is the one Gmail holds for that address under "Send mail as"; when it has none, or one the label
  cannot use, the label name set in the core (its CLI's `label name`, or `comms_label`); with neither, the draft is refused and says
  how to set one. **The word** is `agent`, unless the person chose `assistant`, `twin`, `minion`, `bot`, `fake` or
  `AI`.
- **`--as me`** on `draft new`, `draft reply`, `draft update` and `send prepare` (`as: "me"` on their tools) writes it
  as the person, unlabelled — for when they said so for that message. Their label rules decide otherwise, by mailbox,
  by who it goes to (an address or `@domain`, matching only when every recipient does) and by kind (`send` for a new
  message or a forward, `reply` for a reply); with no rule, a message is labelled.
- **`send prepare` settles it again.** A draft whose From does not say who it will appear to come from — written in
  Gmail, written before this release, or one a rule or `as` now places differently — has its From header rewritten
  and nothing else: every other byte is the one Gmail held, and the preview says the From was rewritten. A draft from
  an address the mailbox cannot send as is refused rather than relabelled.
- **The preview's first line** says which it will be — for `me`, `Sent as you, with no label: it will look as if you
  wrote it yourself` — and the approval binds the whole From, name and all: a From changed after the preview voids
  it.

Gmail does not document what it does with a From name sent through its API. Reports say it keeps the name as written;
the design's live check (§10) is what settles it.

## Install

```sh
npm install -g @agentcomms/gmail    # or run it with npx @agentcomms/gmail <command>
```

Node 22.12 or newer. Nothing else: the command ships as a single bundle.

## Connect a mailbox

```sh
npm i -g @agentcomms/gmail
agent-gmail setup
```

`setup` is the way in. You need an eligible OAuth client: one of your own, or one an organisation profile provides.
For your own, create it once in Google Cloud (type **Desktop app**) and publish it so its tokens do not expire after
a week — `setup` walks those five screens with a link to each and says what to type in every field. With a profile,
`setup --profile <file>` adds it through its own approval and skips the Cloud walk when the mailbox name selects its
active client. It then connects the mailbox and offers to register the MCP server. It skips whatever is already done,
so running it again adds another mailbox — and stopped partway, it offers to carry on from the last screen confirmed.

At a terminal it draws a list you move through with the cursor keys; `--no-tui` asks the same questions one line
at a time. Where nobody can answer one — `--json`, `--no-input`, CI, a redirected stream — it acts on the flags it
was given and names the flag that would have let it continue:

```sh
agent-gmail setup --client-json ~/Downloads/client_secret_*.json \
  --inbox acme/gmail --email you@example.com --mcp-client claude-code --json
```

The one step it cannot finish is the grant: it returns the sign-in link and the command that completes it, which
goes on to put Gmail into that app's MCP connection when `--mcp-client` came with the mailbox (`--standalone`
registers an entry of Gmail's own instead, as before 0.35.0). It asks for Gmail for every mailbox; where the app's
connection already has Gmail kept to one mailbox, or read-only, it leaves that as you chose it, asks nothing, and says
so with the `agentcomms connection change` that would let it reach the new mailbox too. Registering the OAuth client
and connecting the MCP server are changes you approve. Run by an agent, `setup` stops at each with the preview and an
approval id, and runs again with `--approval <id>` for the OAuth client or `--mcp-approval <id>` for the MCP server
once you have said yes; at a terminal it asks you there.

### By hand

The commands `setup` wraps are all still there:

```sh
agent-gmail client add ~/Downloads/client_secret_*.json --move
agent-gmail inbox add acme/gmail --email you@example.com --start   # prints a link
# open the link, choose the account, leave every permission ticked
agent-gmail inbox add --finish fl_… --wait 60
agent-gmail whoami --inbox acme/gmail
```

Adding a profile does not move mailboxes already connected. Read its active client from `agentcomms org show
<organisation>`, then move one with `agent-gmail inbox reauth <name> --client <organisation>-1 --start`, using the
generation name that `org show` reports.

`--start` and `--finish` are two commands because consent takes minutes and an agent's shell does not last that
long. On a terminal, plain `agent-gmail inbox add acme/gmail` waits for the browser itself.

## Commands

| Command | What it does |
|---|---|
| `setup` | the Google Cloud steps, the client, a mailbox and the agent connection, in one command |
| `client add\|list\|remove` | the Google Cloud OAuth client every mailbox signs in through |
| `inbox add\|list\|show\|reauth\|rename\|policy\|remove\|import` | connect and manage mailboxes |
| `whoami --inbox <name>` | what Google says about a mailbox |
| `doctor [--inbox <name>]` | check everything that has to work, and say how to fix what does not |
| `mcp` | run the MCP server on stdio |
| `mcp install --client claude-code\|claude-desktop\|codex\|cursor\|gemini\|vscode\|json` | register the server, and prove it starts (approved first) |
| `mcp prune [--dry-run]` | remove the runtimes old releases left behind (approved first) |

Every command takes `--json` and prints `{"ok":true,"schemaVersion":1,"data":…}` or, on failure,
`{"ok":false,"schemaVersion":1,"error":{"code","message","hint"}}` — with a documented exit code (`--help` lists
them). Data goes to stdout, messages to stderr.

### Saving attachments

```sh
agent-gmail attachments find --inbox acme/gmail --from sam@partner.test --filename pdf
agent-gmail attachments download 18f2c7a9e03b41d6 --inbox acme/gmail --part 1
```

**You say where they go.** Nothing is saved until you have: the command lists the files — each name, size and
sender — and asks whether to save them in `1` your Downloads folder, `2` the folder you ran it in, or `3` a folder you
name (absolute, or starting with `~`; it is made if missing). Both folders are shown by their exact paths. Downloads is
`defaults.downloadsDir` when you set one; otherwise the folder your system keeps — on Linux the XDG one
(`XDG_DOWNLOAD_DIR`, or `~/.config/user-dirs.dirs`, so `~/Téléchargements` on a French desktop), on Windows the
Downloads known folder wherever it was moved, else `~/Downloads`. At your own terminal you may also say it with
`--to downloads`, `--to current` or `--to <folder>` — only there: with no terminal, with `--json`, through a pipe, or
run by an agent, the command saves nothing, prints the question with a choice id and exits `10`, and `--to` needs the
question's `--choice` beside it. Over MCP `gmail_attachment_download` asks the same way: its first call answers
`destinationRequired: true` with the question and a `choiceId`. A choice is for those attachments, under the names it
showed, and no others; it is used once, and expires after thirty minutes. A call with other arguments is refused, and
the question stays open for the right one.

**Your answer follows the mailbox's change policy.** Under `chat` (the default), the agent passes your answer back —
`saveTo` with the `choiceId`, or `--to <answer> --choice <id>`. Under `confirm` you answer it yourself, where an agent
cannot: at your own terminal with the approve command the result gives, exactly as given, which shows the question
again and asks `1`, `2` or `3`, or in the form a client you trusted with `confirm-clients add` shows you. The agent
then calls again with the `choiceId` alone; an answer it passes in the arguments is refused, and the question is left
open for you.

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

Each file is saved under the name its sender gave it, made safe — no path in it, no leading dot (`.npmrc` is saved as
`npmrc.download`), no control or bidi characters, no Windows device name — and never over a file already there: the new
one is saved beside it as `-2`. The same file sent twice — the same name and the same bytes — is written once; the same
bytes under two names are two files. Nothing else is written in the folder; the download is recorded in the audit log
and in a manifest under this package's own state directory. A download that stops part-way records what it saved,
removes a file it wrote only part of, and says what was saved and what was not. What the sender called the file comes
back inside the untrusted-content envelope, and so does the name it was saved under, and its path, unless that name is
plainly a file name. Nothing is ever opened or run.

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

### Changes that need your approval

`client add` and `client remove`, `inbox import` and `inbox remove`, `confirm-clients add`, a looser `inbox policy`,
an `inbox reauth` that asks for more access than the mailbox has, `mcp install` (it hands a client a new set of tools)
and `mcp prune` (a deleted runtime cannot be taken back) each loosen something or cannot be undone, so each is
approved before it happens. At a terminal the command shows exactly what will change and asks you to type `yes` — or,
under the `confirm` change policy, the code shown by the approve command the result gives. Run by an agent, or with no
terminal, it prints the same preview with an approval id and exits `10`; once you have said yes, the same command with
`--approval <id>` makes the change. Tightening a policy never asks.

The MCP server offers each of these as a tool that asks the same way, and an approval prepared on one surface can be
claimed on the other: it is one change. Registering and pruning are the core server's `comms_server_install` and
`comms_server_prune` with `channel: "gmail"`, and the same holds between them and `mcp install` and `mcp prune`.
`mcp install --print`, `--client json` and `mcp prune --dry-run` change nothing, and ask nobody.

### Taking messages

When several agent sessions read the same mailbox, the first to take a message has it, and the others leave it. A
session takes a message before it replies to it, hands it back when it is not its own — saying why, in closed words —
or marks it done:

```sh
agent-gmail take 18c2f0a1b2c3d4e5 --inbox acme/gmail                    # this session has it now
agent-gmail take 18c2f0a1b2c3d4e5 --inbox acme/gmail --hand-back --reason not-mine --note "about billing"
agent-gmail take 18c2f0a1b2c3d4e5 --inbox acme/gmail --done
agent-gmail taken 18c2f0a1b2c3d4e5 --inbox acme/gmail                   # who has it
```

Over MCP these are `gmail_take` (`step`: `take`, `hand-back` or `done`) and `gmail_taken`. Which session is taking is
worked out by the server or the command from the process it runs in — never from an argument — and a take lapses an
hour after the session's last act on the message, or as soon as its agent window has ended, unless a send it prepared
is still waiting for your yes. Only mail that arrived can be taken: not a message this mailbox sent, and not a draft. A
reason is `not-mine`, `wrong-account`, `needs-the-person`, `duplicate` or `other`; a note is at most 200 characters and
is shown to you alone. A read-only server offers `gmail_taken` and not `gmail_take`.

What other sessions learn is closed words only: `you`, `another session` or `the person`, taken or done, offered, and
the reasons it was handed back — never which session, its folder or its client, and never a note. `read`, `thread`,
`search` and their tools say so on each message, as `taken`.

With `agentcomms taking acme/gmail --require on`, a session must take a message before it drafts a reply to it, and
before it prepares or sends a reply — one whose In-Reply-To names mail this mailbox received. Without the take the act
is refused with `TAKE_REQUIRED` (exit `10`), before any draft, preview or approval, and again just before the send: a
take released in between sends nothing, and the approval is as it was. A message another session has is refused with
`TAKEN_ELSEWHERE` (exit `10`) whether or not a take is required — and so are organising and binning it, which never
need a take. A new message, a forward and a follow-up to your own mail answer nobody's message, and need no take. At
your own terminal you are never held to taking: `agentcomms takes keep` holds a message for you, and `takes list`,
`release` and `give` are yours too, in core's README.

A take allows nothing by itself: every send still needs the behaviour rules, the send policy and your yes. It keeps two
sessions from answering the same message; it is not a boundary against a process running as you. Gmail has no 👀, so
a take says nothing to the sender.

## Coming from another Gmail MCP server

```sh
agent-gmail inbox import --dry-run    # says what it would take from ~/.gmail-mcp
agent-gmail inbox import
```

It copies; it never moves or deletes anything. Two things it cannot inherit: which Google account each mailbox is
(those tokens were issued without `openid`), and permission to label or archive. One `agent-gmail inbox reauth
<name> --start` per mailbox fixes both.

**It also tells you if the other server is still connected to an agent.** While it is, that server's send tools are
there too, and nothing in this package gates them.

## As an MCP server

```sh
agent-gmail mcp install --client claude-code
```

It shows what it will register and asks you to type `yes`; run by an agent, it exits `10` with that preview and an
approval id, and registers when run again with `--approval <id>` after your yes.

Or embed it:

```js
import { createGmailMcpServer } from '@agentcomms/gmail';

const server = await createGmailMcpServer({ inbox: 'acme/gmail' });
await server.connectStdio();
```

Tools are registered by process flags only, so the tool list never varies between connections; what each mailbox may
do is checked on every call against the configuration as it is at that moment. An inbox added or a policy tightened
while the server runs applies to the next call.

Every account command has its tool — `gmail_client_add`, `gmail_inbox_reauth`, `gmail_inbox_import`,
`gmail_inbox_remove`, `gmail_inbox_policy`, `gmail_confirm_client_add` and the rest — and a change that needs
approval returns `approvalRequired` with the preview and an `approvalId` instead of acting. The agent shows you the
preview and calls again with the id after your yes. `gmail_client_add` reads the client JSON from a path on your
machine; the file never passes through the conversation, and no tool returns its secret.

## Where things are kept

| What | Where |
|---|---|
| Configuration | `$XDG_CONFIG_HOME/agent-communications`, else `~/.config/agent-communications` (`%APPDATA%` on Windows) |
| Tokens and client secrets | the system keychain, or owner-only files (`--store file`) |
| Approvals, audit log, state | `<config>/state` |
| What each agent window read, did and sent: the activity log | `<config>/state/activity`, one file a day, kept 30 days: ids, subjects, senders, the words searched for, file names and sizes, a send's recipients — never a body or an attachment (`agentcomms activity sessions`) |
| Attachments you save | where you say each time: Downloads, the folder you ran the command in, or one you name |
| Exports | `~/Downloads/agent-communications`, or `defaults.downloadsDir` |

No secret is ever written to `config.json`, printed by a command, or put in a result.

## Licence

MIT
