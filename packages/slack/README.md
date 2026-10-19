# @agentcomms/slack

Slack for coding agents. Read channels, threads, search, people and files across one or more workspaces — and
draft messages that **nothing posts without a person's approval of exactly what goes out**.

```sh
npm install -g @agentcomms/slack    # or run it with npx @agentcomms/slack <command>
```

The local event daemon, [`@agentcomms/events-daemon`](../events-daemon/README.md), may call this package's internal
read-only event operation. It adds no Slack command
or MCP tool, and it cannot post.

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
agent-slack manifest --mode read                     # the app to create, the steps, and its port
agent-slack workspace add acme/slack --client-id <id> --port <port>   # the command it printed, port and all
agent-slack doctor
agent-slack mcp install --client claude-code         # connect it to your agent, once you approve it
```

You do not choose the port. Slack stores the redirect URL on the app and matches it exactly, so the port is settled
when the manifest is printed: `manifest` for a new app asks the system for a free loopback port, skips any another
workspace here already uses, and puts it in both the manifest and the `workspace add` command it prints. That port is
then the app's, and every later sign-in reuses it. `--port` still sets one yourself. If a sign-in finds the port held
by another program, it says so: close whatever uses it, or run `manifest` again for a new app.

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

### Labelling what an agent sends

Someone who reads a message an agent sent through this package can tell, without opening anything, that it came
from your agent and not from you — unless you chose otherwise for that message. The preview's first line, the
`From:`, says which before anything is sent, and the approval binds it ([design](../../docs/superpowers/specs/2026-10-15-agent-label-design.md)).

- **As the app, named after you.** Once the workspace has its app's bot token (below), and where the app can post —
  a public channel not shared with another organisation, or a private or shared one its bot user has joined — the
  message goes out as the app, with the name
  `Jo Example (agent)` and Slack's APP badge beside it. The name is your Slack display name, else your real name, else
  the name set with the core's `label name`; the word is the one set with `label word` — `agent` by default, or
  `assistant`, `twin`, `minion`, `bot`, `fake` or `AI`. A name that cannot make a label of at most 80 characters is
  refused, never cut short. The icon is your agent emoji when one is recorded for the workspace, else your Slack
  photo. Nobody passes a name, an icon or blocks: they come from your profile and settings, read at prepare.
- **As you, labelled.** Where the app cannot post — a direct message, a group DM, your own DM, a room the app is not
  in or whose membership could not be checked, every post with files, and every workspace with no app bot token
  stored — the message goes out with your own token, labelled in it: its words begin `Jo Example (agent): `, and so
  does the text a notification shows, so the two agree and a reader sees one message, not two that differ. A file
  post's comment starts the same way. The preview names the reason.
- **As you, with no label**, only when you say so for that message: `--as me` on `post prepare`, `react` and
  `edit prepare`, or `as: "me"` on their tools. The preview's first line then reads `Sent as you, with no label: it
  will look as if you wrote it yourself`. Rules for an account, a conversation or a kind of act are the core's
  `label rule`; an agent passes `me` only when you said so for this one message.

The route is chosen before the preview and never changed after it. An app post Slack refuses — the app removed from
the room meanwhile — is a refused send: nothing is posted as you instead, because that would be a different message
needing a new yes.

**Edits and deletions use the token that posted.** A message you posted, by hand or labelled, is edited with your
token; an agent's edit of it puts `Jo Example (agent): ` at the front of its new words. An app message is edited or
deleted with the app's token, and only when this machine's own record of what this workspace's app posted holds it:
others who installed the same app post as the same bot, and theirs are refused before any preview. **A reaction** is
the app's where the app can post, and yours elsewhere — and since a reaction carries no words, the preview says it
goes unlabelled.

**Labelled posts in place of the app, per workspace.** Slack adds its APP tag to every app post, and nobody can hide or
rename it. If you would rather an agent's messages in a workspace read as yours, labelled, choose it with the core's
`label style <workspace> labelled` (MCP `comms_label` with `style`), which you approve. From then on, every agent post,
reply and file there goes out as you, its words and its notification beginning `Jo Example (agent): `, even in a
channel the app could post in. The preview's first line ends `you chose labelled posts for this workspace`. Reactions
are yours, unlabelled, as everywhere the app cannot post. A message the app posted before stays the app's to edit or
delete. `label style <workspace> app` goes back at once, and `label` shows each workspace's style. `doctor` says the
workspace posts as you, labelled, by your choice, and offers no step to a bot token there. Weigh the trade before
choosing it: nobody can fake Slack's APP tag, but anyone can type words at the start of a message.

**Your agent emoji.** The icon is your Slack photo until you set an emoji: make one from your photo with a small robot
badge with the Slack CLI's `icon make` (MCP `slack_icon_make`), upload it at your workspace's emoji page, and record
its name with the core's `label icon <workspace> :name:` (MCP `comms_label`), which you approve. Nothing is published outside Slack.

#### Giving a workspace its app's bot token

The ordinary sign-in is PKCE, and Slack does not let a PKCE sign-in on `localhost` ask for bot scopes ("Desktop
redirects are not allowed to request bot scopes"). So a `send` workspace is in one of three states, and
`agent-slack doctor` says which:

1. **No bot token** — every workspace after its first sign-in, and every one connected before this release. It keeps
   working: its agent's messages go out as you, labelled. Nothing needs doing unless you want them to appear as the
   app.
2. **Pasted once.** The send manifest declares the app's bot user and its four scopes, so after updating the app from
   it (`agent-slack app update <name> --mode send`, or paste `agent-slack manifest --workspace <name> --mode send` on
   its App Manifest page), press **Install to Workspace** on the app's **OAuth & Permissions** page and copy the **Bot
   User OAuth Token** (`xoxb-…`). Then, at your own terminal:

   ```sh
   agent-slack workspace bot acme/slack     # asks for the token without showing it, checks it with Slack, keeps it
   ```

   It checks the token with Slack before keeping it: a bot token, of this workspace's team, with exactly
   `chat:write`, `chat:write.customize`, `chat:write.public` and `reactions:write`. It refuses a user token, and a
   token that rotates (`xoxe.…`), which would stop working within twelve hours with nothing here able to renew it. An
   app made from this package's manifest has token rotation on, and Slack never turns rotation off once it is on — so
   for such an app use the third way. The command is a person's only: it refuses an agent, and has no tool, because a
   token typed into a chat stays in the transcript.
3. **Signed in with the app's client secret.** For an app that has never enabled PKCE — which Slack says cannot be
   switched off on an existing app, so this is a new app, made from the manifest
   `agent-slack manifest --mode send --with-client-secret` prints (PKCE off; `slack_manifest` with `pkce: false`). It
   prints three steps: create the new app from the manifest; on **Basic Information**, copy the Client ID and keep the
   Client Secret to hand, to type once at a hidden prompt and never paste into a chat; then connect it with the command
   it prints, which carries `--with-client-secret` and the port it chose. Its sign-in asks for the four bot scopes as
   well as yours, and both tokens come back from it:

   ```sh
   agent-slack workspace add acme/slack --mode send --client-id <id> --port <port> --with-client-secret
   ```

   **One connection per person per workspace.** If you are already connected to that workspace through another app,
   the new sign-in stops with "already connected", and `workspace reauth` keeps the app a workspace already has. So
   remove the old connection first (`agent-slack workspace remove acme/slack`), then add the new app under the same
   name. On Slack's free plan a workspace holds at most 10 apps, and this new one counts toward them: if Slack says the
   limit is reached, remove an app you no longer use, in **Tools & settings → Manage apps**.

   **A workspace connected through an organisation's profile** cannot use either way above: the organisation's
   shared app has PKCE on and rotating tokens. Its agent's messages go out as you, labelled — unless the organisation
   sets up an agent app, below.

   It asks for the client secret (the app's **Basic Information** page, under **App Credentials**) at a hidden prompt —
   a person's, at a terminal, as for `workspace bot` — keeps it in the secret store by the app's id, sends it only to
   Slack's token exchange, and renews both tokens with it. A later `workspace reauth` of the workspace uses the kept
   secret without asking. Slack's OAuth page says a redirect URL "must use HTTPS"; whether Slack takes this sign-in's
   `http://localhost` one is not yet confirmed. If Slack refuses it (`bad_redirect_uri`), sign in the ordinary way and
   paste the bot token instead.

Narrowing to `read` or removing the workspace deletes this machine's copy of the bot token, and never revokes it.

#### An organisation's agent app

Members connected through an organisation's profile can post as an app too, through one extra **bot-only agent app**
that the organisation's administrator sets up once. Nobody's connection changes: each member keeps reading and posting
through the organisation's own apps, and only adds the agent app's bot token. A member who does nothing keeps the
labelled fallback.

For members, it is one command, at your own terminal, with the token your administrator gave you:

```sh
agent-slack workspace bot rgc/slack     # asks for the token without showing it, checks it with Slack, keeps it
```

It checks the token as for any app: a bot token of the workspace's team, with exactly the four posting scopes, and not
one that rotates. When the organisation's profile names its agent app, it also asks Slack (`bots.info`, with your own
token) which app the token's bot belongs to, and refuses another app's token, naming it. Until you paste it,
`agent-slack doctor` says "ask your organisation's admin for the agent app's token, then `workspace bot <name>`" when
the profile names the app. Otherwise it notes that posts go out as you, labelled, and that posting as an app becomes
possible once your organisation's admin adds an agent app to its profile.

##### For administrators

1. **Create the app.** `agent-slack manifest --mode agent` (or `slack_manifest` with `mode: "agent"`) prints a bot-only
   manifest — a bot user and `chat:write`, `chat:write.customize`, `chat:write.public` and `reactions:write`, no user
   scope, no redirect, and token rotation off — with these steps. At <https://api.slack.com/apps> choose **Create New
   App → From a manifest**, pick the organisation's workspace, paste it, and give it the organisation's name, such as
   "RGC agent". Rotation has to stay off: Slack never turns it off once it is on, and a pasted token that rotates stops
   working within twelve hours.
2. **Install it once.** On **OAuth & Permissions**, press **Install to Workspace**. Members do not install it.
3. **Share its token privately.** Copy the **Bot User OAuth Token** (`xoxb-…`) and give it to members the way you
   would a password — a password manager, or a direct message you delete afterwards. Never put it in the profile's
   repository, and never paste it into a chat with an agent: the transcript keeps it.
4. **Name it in the profile**, so `workspace bot` refuses any other app's token and `doctor` tells members whom to
   ask. Beside the profile, add a file with the profile's name and `.agent-app.json` for its `.json` — for
   `rgc.agentcomms.json`, `rgc.agentcomms.agent-app.json` — holding the app's **App ID** from **Basic Information**:

   ```json
   {
     "agentcomms": "organisation-agent-app",
     "version": 1,
     "organisation": "rgc",
     "slack": { "workspace": "T0123456789", "appId": "A0123456789" }
   }
   ```

   Its organisation and workspace must be the profile's. It holds no secret. Members pick it up with `git pull` and
   `agentcomms org update rgc`, which shows the app id and the file's SHA-256 and asks before applying, as any change
   to the profile does. A token a member pasted before the file was added was checked against no app, so `doctor`
   checks the stored token as the paste does — `auth.test` with it, `bots.info` with the member's own token — and warns
   when it is another app's. It is a file of its own, not a key in the profile, because every release before 0.20.0 refuses
   a profile with a key it does not know: a member who has not updated yet keeps reading the profile as it is, and
   never opens this file.

**When someone leaves**, revoke the token on the app's **OAuth & Permissions** page and press **Install to Workspace**
again for a new one, then share it; each member runs `workspace bot` again with it. In between, the first post,
reaction, edit or deletion a member's agent makes with the old token comes back from Slack as `token_revoked`,
`invalid_auth` or `account_inactive`. That act is refused — nothing goes out, and never under another identity, which
would need its own preview — and the old token is removed from that member's machine, as narrowing or removal removes
it. From the next prepare on, their agent's posts go out as them, labelled, and `doctor` says when the token was revoked
and to ask you for the new one. Editing or deleting a message the app posted waits for the new token: only the app can
change its own messages. Any other refusal keeps the token. Only the token the refused act carried is removed,
compared by its SHA-256: a new one pasted while that act was out is kept, and the next prepare posts as the app with
it.

**What one shared token means.** Everyone who pastes it holds the same token, and Slack lets it post under any name,
with the APP badge beside it. These tools always name a post after the member who approved it, and an app message can
be edited or deleted only from the machine whose own send record holds it — but the token itself is not bound to
anyone, so share it only with members. On Slack's free plan a workspace holds at most 10 apps, and the agent app is one
of them.

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
agent-slack edit prepare --workspace acme/slack --draft <draftId> --ts 1700000000.000100 --remove-file F0EXAMPLE01

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

### Messages sent without asking

A standing approval is your yes given in advance to a few acknowledgements: standard emoji reactions (`eyes` when you
name none; custom workspace emoji never), or short fixed replies you write, one a line, at most 200 characters, with
no links, mentions, formatting or emoji. With one, an agent may acknowledge a message that has just arrived from another
person without asking — and only that: the newest message from someone else in its thread or channel, within 15
minutes, in a place the approval names, and not one already acknowledged. It never writes the words, and it cannot
pick an old message, one among many, or a new place.

```sh
agent-slack standing add --workspace acme/slack --reactions eyes --replies-file ~/acks.txt --places C024BE7LR --expires 7d
agent-slack approve <approvalId>    # the command the result gives, and the code it shows: never a typed yes
agent-slack ack --workspace acme/slack --standing <id> --channel C024BE7LR --ts <ts> --content <digest>
```

`--places` takes exact channel and DM ids, or `threads-i-am-in`: threads you posted in yourself in the last 14 days,
where a message this product sent for you does not count. The preview shows each content in full with its digest,
warning for an emoji that can read as approval, such as ✅, or a reply that says "OK", "Done" or the like; each place with its member count and whether another
organisation shares it; the limits (`--per-thread`, `--per-hour`, `--per-day`); and the expiry. A place of 50 members
or more, or one with someone from another organisation in it, is allowed only when named exactly, and one that has
grown to 50 or changed who shares it since is refused until you approve it again. `--replaces <id>` widens one, and
asks again; a replacement that only narrows applies at once.

Every act goes out as your agent: a reply in the thread, as the app or labelled `Jo Example (agent):`, even under a
`me` rule; a reaction only as the app, and only where the app is a member, so never in a DM, a group DM, a room the
app is not in, or a `labelled` workspace. Each act raises a notification on your screen — what was sent, where, and
under which standing approval — and goes in the audit, with the acknowledged message's digest and whether it had been
edited. A refusal is `STANDING_REFUSED` with its reason, or `STANDING_LIMIT` with when the limit frees (exit `10`):
nothing was sent.

The core lists, narrows and ends them: `agentcomms standing list`, `agentcomms standing revoke <id>`, and
`agentcomms standing off`, which ends every one at once. What a standing approval does not defend — an agent with a
shell, running as you — is in the core's README and the repository's SECURITY.md.

## Your agent's emoji

When your agent posts as the Slack app, its messages can carry your own picture with a small robot badge on it, so
anyone can see at a glance that it is your agent and not you. Make the picture once per workspace:

```sh
agent-slack icon make acme/slack
```

It reads your Slack profile photo with the workspace's token, puts the robot badge on its lower right, and saves a
128 × 128 PNG — under the 128 KB Slack allows an emoji — in this machine's data folder, as
`slack/agent-icons/<account id>.png`. It prints the workspace's emoji page,
`https://<workspace>.slack.com/customize/emoji`, and a name for the emoji made from your handle, such as
`:sam-agent:`. Upload the file there under that name yourself, then record the name for the account with core's
`label icon <account> :sam-agent:` (MCP `comms_label`), so the app's posts for your agent show it.

It uploads nothing and changes nothing in Slack or in the configuration, so it asks nobody, and it works in `read`
mode. The photo is fetched from Slack's photo host, `avatars.slack-edge.com`, with no token on the request. A photo
kept anywhere else — a Gravatar, or Slack's default picture — is not fetched, and it asks you to add a profile photo
in Slack first. Only a PNG or a JPEG of at most 5 MiB is read; anything else is refused and nothing is saved. From a
chat, `slack_icon_make` does the same.

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
| `slack_manifest` | the app manifest with its steps — a free port chosen for a new app given none — and for a connected workspace the link to its own app's manifest page; changes nothing |
| `slack_channels`, `slack_read`, `slack_thread`, `slack_search`, `slack_people`, `slack_files` | read, bounded |
| `slack_icon_make` | make your agent emoji — your Slack photo with a robot badge — as a PNG to upload yourself; changes nothing in Slack |
| `slack_file_download` | save files where the person says — asks first; by id, from one message, or from a conversation; opens nothing |
| `slack_post_prepare` | compose a draft, with local files if given, and return the preview a person must approve — posts nothing |
| `slack_post_send` | post a prepared draft once its approval allows it, reading every file again first — the operation `agent-slack post send` runs |
| `slack_react`, `slack_react_send` | add or remove a reaction through the same gate — `agent-slack react` |
| `slack_edit_prepare`, `slack_edit_send` | change the words or files of a message this account posted, through the same gate — `agent-slack edit prepare` and `edit send` |
| `slack_delete_prepare`, `slack_delete_send` | delete a message this account posted, through the same gate — `agent-slack delete prepare` and `delete send` |
| `slack_standing_add` | prepare a standing approval — fixed reactions or replies, places, limits and an expiry — for the person to approve at their terminal with its code; approves nothing — `agent-slack standing add` |
| `slack_ack` | acknowledge, without asking, a message that just arrived, with a content a standing approval holds, by its digest; as the agent, never as you — `agent-slack ack` |
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
| `send` | the above plus `chat:write`, `files:write`, `reactions:write`; and the app's bot user, with exactly `chat:write`, `chat:write.customize`, `chat:write.public` and `reactions:write` | this package's approval gate |

The send app's bot user is what lets an agent's message appear as the app, named after you — see
[Labelling what an agent sends](#labelling-what-an-agent-sends). The ordinary sign-in asks for user scopes only; the bot
token is pasted once or comes with the client-secret sign-in ([giving a workspace its app's bot
token](#giving-a-workspace-its-apps-bot-token)), and is kept only with exactly those four scopes. It is kept beside
your own, under `slack/bot-token/<accountId>` in the secret store; it is the workspace's, not yours — everyone who
installed the same organisation app holds it — so narrowing to `read` or removing the workspace deletes this machine's
copy and never revokes it. The read app has no bot user, so no token a read workspace holds can post.

Moving to `send` means editing your app's manifest — on its page, or with `agent-slack app update <name> --mode
send` — and then approving the change and re-authorising: a new grant you approve in Slack's own UI.
`agent-slack workspace mode <name> send` walks both, from a terminal or, as `slack_mode_set`, from a chat. Going
back means removing the app's installation in Slack first: Slack adds scopes to a token and never removes one.
`agent-slack workspace mode <name>` prints either path.

## Licence

MIT.
