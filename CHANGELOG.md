# Changelog

All notable changes to this project are recorded here, newest first. Every package in this repository is released
together under one version.

## 0.5.1

**Tools refuse what they used to ignore.** Every MCP tool, in core, Gmail and Slack, now refuses an argument it
does not take, and an argument of the wrong kind, as `USAGE`, before it does anything. The message names the
argument and what the tool takes. An unknown argument used to be dropped without a word, so a call could quietly do
something other than what was asked. And a wrong type, a fraction or an unknown word came back as the MCP library's
plain-text error, with no code an agent could act on. A problem inside an object argument is named by its path —
`expect.to is required`, `undo[0].messageId` — rather than blamed on the whole argument. `tools/list` now publishes
`additionalProperties: false` for every tool, so a client can see the rule before it calls.

Why: the design has always said an unknown argument is refused. The MCP library dropped it instead. That is how
`gmail_inbox_add`, before 0.5.0 declared `client`, signed a mailbox in with the default OAuth client when an agent
had asked for another.

What it means for you: a patch, because only input that was already wrong behaves differently. A call that was
correct gets the same answer as before, and there is nothing to migrate. An agent or script passing a field a tool
does not declare now gets `USAGE` and the list of fields it takes, where it used to get a result that ignored the
field. To pick this up, register each server again with `--force` and restart your client.

**Slack `search` and `files` refuse a limit they cannot read.** Above 100 for `search` and 200 for `files`, the
limit is refused, as the Gmail tools have refused one since 0.5.0. Before, they read fewer and did not say so. The
limit is checked before the workspace is opened, so a bad one reads no credential and renews no token.

**A Slack draft is shown as what it would post.** `agent-slack draft show`, `draft list`, `slack_draft_get` and
`slack_draft_list` show the text the post gate would send, as the channel would read it, not the words kept in the
draft file. A draft the gate would refuse is refused by `show` too, in the gate's own words, so showing a draft and
posting it can no longer disagree about what it says. At the terminal, `draft show` and `draft list` show a hidden
character escaped (`<U+200B>`), as the post preview does; they used to drop it silently.

**An expired Gmail sign-in says how to start that one again.** It names `inbox reauth` for a re-sign-in and
`inbox add` for a new mailbox, and the mailbox it was for. Over MCP it names the tool, not a terminal command. Before,
every expiry said `agent-gmail inbox add <alias> --start`.

**`agent-gmail contacts --sources` and `gmail_contacts_search` refuse a source they do not know.** An unknown word
used to be dropped, and the search reported itself complete with fewer results or none. An empty list is refused the
same way. So is an empty `inboxes` for `gmail_search`, `gmail_attachments_find`, `gmail_contacts_search` and
`gmail_followups`, and an empty `messageIds` for `gmail_attachment_download`. Each used to search nothing, or save
nothing, and report the work done.

**`slack_draft_create` writes a draft without preparing it**, as `agent-slack draft create` does, with the same
mention and broadcast checks and no approval until `slack_post_prepare` is called with its id. Until now the command
had no tool of its own; the nearest was `slack_post_prepare`, which writes and prepares in one call. Slack's server
now has 27 tools.

**For contributors: the parity check proves each row is one operation.** Each row in `capabilities.json` names the
operation its command and its tool both run, and `pnpm verify` drives both sides against stand-ins to prove that each
reaches that operation first. Before, it checked only that the two named sides existed, so swapping two rows passed —
and so did the channel CLIs' `mcp install` in 0.5.0 without the approval its tool asked for, until a review found it.

## 0.5.0

**Changes are now approved in chat by default.** A change that loosens a setting, or cannot be undone — a looser
send policy, connecting Slack in `send` mode, moving credentials out of the keychain, removing an account,
registering an MCP server — is shown to you as a preview, and applied once you say yes in the conversation. In 0.4.x
the same changes needed a code typed at a terminal. A configuration from an earlier release reads as `chat`.

Why: in 0.4 an agent could read and draft from a conversation, but connecting an account, widening it or changing
how it is approved needed a terminal, and so did every Slack post. A person being set up from a conversation could
not finish there, and for someone watching their own agent the code protected little. So every command now has a
tool and every tool a command, both approved the same way — and terminal approval is one command away for anyone who
wants it.

What it means for you: this is the 0.x minor release, where this project puts breaking changes. All four packages
move to 0.5.0 together, on `latest`. Gmail and Slack each carry their own copy of core, so neither needs another
package installed; `@agentcomms/gmail-mcp` 0.5.0 requires `@agentcomms/gmail` 0.5.0. A registered server keeps running the release it was registered with until you register it again. Reading, searching
and drafting are unchanged from both surfaces. What breaks is listed under **Scripts** below, and the one change that
happens with no action on your side is the default above.

Under `chat` this software cannot tell your yes from an agent's. If an agent runs without you watching, go back to
terminal approval before you let it loose:

```sh
npx -y @agentcomms/core@0.5.0 policy confirm                 # every account
agent-gmail inbox policy <alias> --change confirm             # one mailbox
agent-slack workspace policy <name> --change confirm          # one workspace
```

From chat, `comms_change_policy`, `gmail_inbox_policy` and `slack_workspace_policy` do the same. Tightening applies at
once; going back to `chat` needs the terminal code. Under `confirm`, a change is approved with `agentcomms approve
<id>` — or `agent-gmail approve` / `agent-slack approve`, which now approve changes as well as sends.

**Everything the CLI does, an agent can do from chat, and the other way round.** Each change goes through the same
approval from both. Gmail's MCP server goes from 32 tools to 44 — show, rename and re-authorise a mailbox, import and
remove one, set its policies, and manage the OAuth clients and trusted confirm clients. Slack's goes from 14 to 26 —
connect, widen, re-authorise and remove a workspace, set its policies, run `doctor` and print the app manifest.
`capabilities.json` lists every command and the tool that mirrors it, and `pnpm verify` fails on a command without a
tool unless the file says why it has none.

**Agents can post and react in Slack.** `slack_post_send` posts a draft that `slack_post_prepare` made, and
`slack_react` / `slack_react_send` add a reaction, after your yes under a workspace's `chat` policy, or after
`agent-slack approve` under `confirm`. `@here` now always needs terminal approval, like `@channel` and a room of 50 or
more: it reaches whoever is online, which nothing here can count. So does a mention the preview cannot count, such as
a user group. `--broadcast` accepts only `here`, `channel` and `everyone`, and a `--mention` must be a user id: either
could be made to carry a user-group mention that the preview counted as nobody, so a post that interrupted a whole
group was approved as one that interrupted no one.

**What is approved is what is posted.** A Slack draft was previewed from its text and posted as its blocks, so a draft
file rewritten on disk — by anything that can write to it — could be approved as one message and post another. A draft
whose blocks are not exactly what its text composes to is now refused, at every step that reads it, and what is posted
is the payload the approval was taken over.

**A core MCP server sets up the others.** `npx -y @agentcomms/core mcp install --client <client>` registers it once;
from then on an agent can list which channels are available, register or prune the Gmail and Slack servers, set the
change policy, migrate names and secrets, read the audit log and list or revoke approvals — 11 tools. It registers
servers at its own version, so to upgrade, re-register the core server first. At a terminal the same commands are
`agentcomms approve`, `policy`, `channels`, `mcp install` and `mcp prune`. The new `comms-onboarding` skill walks a
person through the whole setup from a conversation; there are now sixteen skills.

**A server pinned to one mailbox or workspace keeps to it.** Given another account's approval id, a pinned server
voided it — so an agent talking to the `work` server could cancel an approval waiting for `home`. It is now refused
before it is touched. A pinned `gmail_doctor` answers for its own mailbox only, and a pinned `gmail_send_list`
refuses another mailbox instead of answering for its own, as do the tools that take `inboxes` — `gmail_search`,
`gmail_attachments_find`, `gmail_contacts_search` and `gmail_followups` used to search the pinned mailbox whatever
they were asked. A Slack workspace keeps its id when it signs in again, so a
server pinned to it no longer stops working after `workspace reauth`; drafts and approvals waiting on it survive the
reauth too.

**A mismatched credential store is refused.** On a computer with Slack credentials in the keychain but no store
recorded, `agent-gmail client add --store file` was approved as "credentials will move", moved nothing, and left every
Slack workspace signed out. A `--store` other than where credentials already are is now refused, with the command
that moves them (`agentcomms secrets migrate`).

**What a change approval binds.** An approval now binds every setting the change writes, tightenings included, so a
claim cannot drop part of what the person was shown. Tightening the default change policy to `confirm` lists every
mailbox or workspace still set to `chat`, with the command that tightens it.

**Slack apps can be updated from the terminal.** `agent-slack app update` writes a workspace's manifest into its
Slack app, and `app create` makes the app, with a Slack app configuration token read from a hidden prompt or
`SLACK_APP_CONFIG_TOKEN`. The token is never stored and has no MCP tool, so it never passes through a conversation.

**Scripts: a command that changes something may now stop for approval.** Without a person at a terminal, these exit
10 (`APPROVAL_PENDING`) with the preview and an approval id, and run again with `--approval <id>` after the yes:

- `agent-gmail client add|remove`, `inbox import|remove`, `confirm-clients add`, `inbox reauth` asking for more access,
  `setup --client-json`, and `setup --mcp-client`
- `agent-slack workspace remove`, `workspace add|reauth --mode send`
- `agent-gmail mcp install|prune`, `agent-slack mcp install|prune`, `agentcomms mcp install|prune`
- `agentcomms secrets migrate`, in both directions
- any looser send, post or change policy

A server name must be 1–64 letters, digits, `.`, `_` or `-`: the name is quoted in the preview you approve, and a
name with quotes in it could make an unpinned server read as a pinned one. Headless `agent-gmail setup --mcp-client`
stops at the registration and carries its approval with `--mcp-approval <id>`, since `--approval` is already the
OAuth client's.

`agent-gmail draft update` keeps a draft's body unless you give a new one with `--text` or `--file` (`--file -` reads
standard input). It used to read standard input whenever it was not a terminal, so from an agent's shell it either
exited "the message body was empty" or waited for ever.

A word a tool does not know — a policy, a store, a kind, a direction, a format, a mode — is refused as `USAGE` with
the words it takes, as the command refuses it, rather than with the MCP library's uncoded error. `agent-gmail export`
and `gmail_export` refuse a format other than `md`, `json` or `eml`; another word used to write Markdown under that
extension. `--wait` takes whole seconds from 0 to 600 (`--wait abc` waited for ever), and a wait that outlives the
sign-in stops when the sign-in expires, as `gmail_inbox_finish` does, instead of saying the link was still good.

Every number option on the three CLIs takes a whole number written in digits, in its range, and anything else is
refused as `USAGE` naming the option and the range: `--limit 1e2` used to be read as 1, `--port abc` started a
sign-in on a random port, and `followups --older-than 3d` was read as 3. The Gmail tools refuse an out-of-range number
the same way, where they used to clamp it — `gmail_search` with `limit: 500` searched 50 without saying so.

`agentcomms names migrate --yes` is refused (exit 64): the rename is shown and approved like any other change.
`agent-slack workspace mode <name> send` now stops at the Slack app step until you pass `--app-updated`, so a
sign-in never asks for scopes the app does not have.

Under `confirm`, a change started from the Gmail or Slack CLI or server names `agent-gmail approve` or `agent-slack
approve` — the command installed with it — rather than `agentcomms approve`. The tools return what the matching
command's `--json` prints, and the sign-in tools take everything their commands do: `gmail_inbox_add` its client, port
and domain, and both finish tools a pasted `url`, for a browser on another machine. The Slack MCP greeting fits in the
2 KB a client keeps; the lines saying an agent cannot approve a post itself had been cut off.

Approval records carry `kind: "change"` or `"send"`, and the audit log records each change prepared, claimed, approved
and revoked, with the surface it came from.

To upgrade, re-register each server with `--force` and restart your client, as [Upgrading](docs/upgrading.md)
describes — and decide on `policy confirm` first.

## 0.4.2

**A home directory passed in the environment is used.** `openCore` and `resolvePaths` took the
home directory from the running process, whatever environment they were given, so a program
embedding `@agentcomms/core` with its own `HOME` still had data and downloads placed in the real
user's. They now read `HOME` from the environment given (`USERPROFILE` on Windows), which is where
Node itself looks for the running process, so the CLIs and MCP servers resolve exactly the
directories they did before. The same mistake had let this repository's own tests write backups
of fixture MCP entries into the maintainer's data directory; they now stay in their temporary
home.

Nothing else changed for anyone using the packages. A sign-in listener started by the Slack tests
no longer outlives the test that started it.

## 0.4.1

**`agent-slack mcp install` connects Slack to your agent**, the way `agent-gmail mcp install` connects Gmail — it is
the same installer now, shared through `@agentcomms/core`. `--workspace` pins the server to one workspace. Pins were
being dropped on the way: `agent-gmail mcp install --inbox` and `--read-only` registered an unpinned, full server,
because the option was read from the wrong command. Both now reach the entry. If you installed a pinned Gmail server
with 0.4.0, re-register it with the same flags and `--force`.

**`mcp install` never overwrites a server it did not write, and `--force` never widens one.** The default Slack name
is `slack`, which is also where other Slack MCP servers keep their bot token, and installing replaced that entry,
token and all. For codex it happened even without `--force`, when codex kept its config somewhere this did not look.
An entry this package did not write is now refused whatever `--force` says, with a `--name` to use instead. Codex is
asked what it has registered before anything is written there. And `--force` on our own entry keeps a pin to one
mailbox or workspace, or `--read-only`, that you leave out of the command: a server is widened only by removing it
yourself and installing again.

**A failed Slack token refresh no longer forces a new sign-in for a network blip.** Slack access tokens last twelve
hours, and each refresh token can be used once. Any failed refresh used to lock the workspace until somebody signed
in again, including a laptop that was offline for the first read of the day. Failures are now sorted before anything
is written. A request that never reached Slack — including a connection that timed out on one address and was
refused on another — leaves the workspace as it was. Only a token Slack says is dead, or an exchange whose outcome
cannot be known, asks for a new sign-in, and it says which. A renewed token the keychain refused to store is kept,
written again before the command or the MCP server exits, and named on stderr if it still cannot be. Ctrl-C during a
refresh waits for Slack's reply to be written, and then stops the command by the signal, so a script running it stops
too.

**Reactions can be approved.** In a workspace that asks before posting, a reaction's approval could never be given,
and every retry made a new one. `agent-slack react` now prepares it and prints the approval id; after `agent-slack
approve`, `react --approval <id>` adds it once, bound to that channel, message and emoji.

**The approval screen shows what is being approved.** It names the channel and how many people the post interrupts,
and an `@channel` or `@here` whose room Slack cannot count is never approved — the approval waits, to be tried
again. A post held for approval names `agent-slack`'s commands, not Gmail's.

**Agents can list, read and delete Slack drafts** (`slack_draft_list`, `slack_draft_get`, `slack_draft_delete`).
None of them reaches Slack. A damaged draft file no longer hides the rest, and can be deleted. Every
`slack_post_prepare` an agent makes is in the audit trail too; only the terminal's were before.

**A Slack workspace remembers the port its app redirects to.** Slack matches the redirect URL exactly. `workspace
reauth` and `workspace mode` asked for the port on every run, and the MCP mode tools guessed 51234, which sent anybody
on another port to a sign-in that failed on the way back. The port is recorded at sign-in and used by default; a
workspace connected before 0.4.1 records it at its next sign-in.

**`mcp prune` removes old runtimes, and only those it can show are unused.** Each release installs its own runtime and
the old ones stayed on disk. `agent-gmail mcp prune` and `agent-slack mcp prune` keep any runtime a client config
names — including a config with comments, a project's `.mcp.json`, and the configs an install recorded writing to
under another `CLAUDE_CONFIG_DIR` or `CODEX_HOME` — and any a running process uses. If a config or the process list
cannot be read, nothing is removed. A runtime whose entry was only printed is kept until `--include-printed` says
that entry is gone. `--dry-run` lists them first.

**Another server's address is shown by its host only.** Install warnings and `doctor` printed other MCP servers' URLs
whole, and some remote servers carry the user's key in the query or the path.

**One rename mapping works on every computer, and a backup is made first.** `agentcomms names migrate` refused the
whole plan if a `--rename` named an account that computer does not have, so a single mapping for several machines
failed everywhere but one. Such a rename is now listed as not applicable here and changes nothing, and the config is
copied to `config.json.before-names-migrate-<time>` before anything is renamed. [Upgrading](docs/upgrading.md)
walks a computer through the whole upgrade.

**A release publishes all four packages, from the tagged commit.** 0.4.0's workflow left `@agentcomms/slack` out.
Before anything is sent, the release now proves that npm will accept a publish of every package from this workflow.
A package already out at the version from another commit, or a tag moved or deleted while its run is going, stops
the run before anything more is published. Re-running a failed job finishes a partial release at the same version.
The GitHub release is made from this changelog, and a prerelease goes out under `next`, from the local fallback
script as well as from CI.

## 0.4.0

**Slack arrives.** `@agentcomms/slack` reads channels, threads, search, people and files across one or more
workspaces, drafts messages, and takes them through an approval gate — and nothing posts without a person.

**Read-only means read-only, and Slack enforces it.** Slack's read and write scopes are disjoint: a token holding
only history and read scopes cannot call `chat.postMessage` at all. A workspace connected in the default `read`
mode cannot post even if this software has a bug. That promise is exactly "this package cannot post" — a second
Slack server holding a write token posts without going near this one, and `doctor` reports the ones it can see.

**You bring your own Slack app.** `agent-slack manifest` prints one to create in your own workspace, so the scopes
are visible before anything is granted and your admins keep control. No client secret is stored anywhere: the
sign-in is PKCE and the verifier never leaves your machine.

**Nothing posts without a person.** An agent prepares; a person approves at a terminal. The preview shows what the
recipient will read and **how many people it interrupts** — `@channel` is eight characters whether the room holds
three people or four hundred, and that number is inside the approval. If the room grows between the preview and
the post, the words did not change but who reads them did, and the approval is void.

**Everything a sender controls arrives inside an envelope**, and the tag no longer says "email": it is
`untrusted-content`, because Slack messages were being announced to a model as mail. Mail already in a mailbox
predates the rename, so the old form is still defused.

Two flags are worth acting on when reading. `mismatch` means the message says one thing in the channel and
another in its notification text — the gap through which an instruction reaches a model that nobody in the room
can see. `unrenderable` means part of the message could not be shown.

**Attribution comes from what an app cannot choose.** `chat:write.customize` lets an app post under any name it
likes; the payload still carries `bot_id` and `user`. A name an app picked for a message is reported as the name
it wore, never as identity.

**Three new skills** — `slack-setup`, `slack-reading`, `slack-posting` — and a Slack MCP server whose tools cannot
post. An agent may report a workspace's mode and may ask to widen it, and gets back the steps a person must take,
with nothing changed.

## 0.3.2

**A Slack workspace cannot be connected in `send` mode without a person saying so.** The config store now counts a
new account arriving in `send` as loosening `accounts.<name>.mode`, measured from `read`, and will not record one
unless a person consented at a terminal — whatever wrote it. Re-authorising a workspace into `send` was already
gated; connecting one was not, so removing a read-only workspace and adding it back with `--mode send` reached a
token that can post with only Slack's own consent screen in the way. That route is closed at every step: before a
sign-in starts, before Slack's code is exchanged for a token, and in the store.

**`agent-slack workspace mode <name>` says what a workspace can do.** It reports the mode and whether the grant
Slack recorded can post, upload or react. `mode <name> send --port <port>` prints the two steps a widening takes —
edit the existing Slack app's manifest first, then a re-authorisation a person confirms — and runs the second.
`mode <name> read --port <port>` changes nothing and says why: Slack adds scopes to a token and never removes one,
so going back to read-only means removing the app's installation in Slack yourself and re-authorising in `read`,
and the command prints exactly that path. (The port is the loopback port in the app's manifest; both paths name
it.) The manifest's help names both modes and says to edit the existing app rather than create another.

## 0.3.1

**Four elements a browser never shows no longer reach the model.** `<noembed>`, `<noframes>`, `<datalist>` and
`<rp>` are hidden by every mail client's default stylesheet, and their text was handed to the model anyway — the
channel the sanitiser exists to close: an instruction aimed at an assistant that the person reading the mail never
sees. They are now removed and counted as hidden content, in received mail and in drafts.

**The HTML parser under the sanitiser follows the HTML spec.** htmlparser2 12, domhandler 6 and dom-serializer 3.
One behaviour changed, and it is a correction: a comment closed by `--!>` now ends there, as it does in every
browser, so text after it that a person can see is no longer missing from what the model reads.

**`agentcomms secrets migrate --to file` works.** On any install using the system keychain it used to copy every
credential and then refuse — always — while `doctor` recommended exactly this command when the keychain is
unavailable. It now asks the person at the terminal to confirm (an agent cannot), checks again under its lock
before touching a store, and records the move in the audit log.

**`--finish` finishes only what the command names.** `agent-gmail inbox reauth <name> --finish <id>` used to
finish whatever the flow was, ignoring the name; it now refuses a flow for another mailbox and follows a mailbox
renamed since the sign-in began. `inbox add --finish` cannot complete a reauth, or the other way round.

**Smaller fixes.** A sign-in could be reported as failed while its listener was running normally, on a busy
machine. A pinned MCP server refuses to start rather than silently skipping its mailbox check if a future SDK
changes how tools are registered. `doctor` counts a token recorded twice as one. Gmail's sign-in ids are drawn
evenly.

## 0.3.0

**Accounts are named `organisation/platform` now, and `agentcomms names migrate` renames yours.** A mailbox is
`cue/gmail`, a second one for the same organisation is `cue/gmail-tech`, a Slack workspace is `cue/slack`. The
command shows the whole mapping before it touches anything — `--dry-run` shows it and stops — proposes
`<old name>/<platform>` for each account, takes `--rename old=new` for the ones you want to name yourself, and
lists every problem at once rather than one per run. It needs `--yes`, or a person at a terminal to answer.

Afterwards the old names stop working, and anything that uses one is told what it is called now rather than that
it does not exist. That refusal is permanent: a name that was replaced can never be given to another account,
because the two would be impossible to tell apart later.

**`doctor` says so once.** A version-1 config is not a problem and is never reported as one, but `agentcomms
doctor` names the command that would rename it, and the release everything sharing that config has to be on
first. It stops saying it once the names have been migrated, and says nothing about the names of a config it
could not read.

**A new config is created in the new format.** Connecting a first mailbox now asks for a name like `acme/gmail`;
`work` is refused, with an example. An existing config stays exactly as it is until you migrate it — no command
changes a config's version except the migration.

**Before you migrate, every program that shares the config must be on 0.2.0 or later** — the release that could
read this format without writing it. An older one refuses the file outright, and one config is shared by
everything on a machine.

## 0.2.0

**This release can read the next config format, and never writes it.** Accounts are about to be named
`organisation/platform` — `cue/gmail`, `cue/slack`, `wf/gmail-tech` — in version 2 of the config file, which
also remembers the names it replaced, so an old name is refused with the new one rather than reported as unknown.
Nothing creates or migrates to version 2 yet. It arrives in two steps on purpose: first a release that can read
it, installed everywhere, and only then one that writes it. An older release refuses a version-2 file outright,
and one config file is shared by everything on a machine — an MCP server started last week reads the file a CLI
updated today.

**Every Gmail command understands organisation/platform names**, ready for the release that introduces them: a
mailbox called `acme/gmail` reads, searches, drafts, downloads into `downloads/acme/gmail/`, and is named in
`doctor`. A name that was replaced is refused with the one it is called now, wherever a mailbox name is typed —
including `mcp install --inbox`, which now checks the name even with `--no-verify`.

**Removing, re-authorising and adding a mailbox no longer strand or lose a token.** A config write can fail
*after* it has been written, when the lock around it cannot be released, and three paths assumed otherwise:
removal skipped deleting a token nothing referenced any more; adding deleted the token of a mailbox that had in
fact been connected, and swallowed a failed deletion without saying so; and a re-authorisation racing a removal
could write the removed mailbox's token back. Each now reads the config again and acts on what it finds, keeps a
token when nobody can tell, and names any reference it could not clean up. Removal and re-authorisation now hold
the same lock as `secrets migrate`. `doctor` checks every recorded leftover token against the config before
suggesting it be deleted, so it can no longer advise deleting a mailbox's live credential.

**`inbox import --rename <legacy-name>=<name>`** imports a mailbox under a name of your choosing, and every bad name
is reported together before anything is written. An import under a client name another Google project already
uses is refused rather than overwriting that project's secret.

**Registering an OAuth client is now as careful as connecting a mailbox.** `client add` and `client remove` hold
the same lock as everything else that touches stored credentials, so an import and a `client add` racing for one
name can no longer overwrite each other's secret; a replacement is refused once mailboxes depend on the client;
and a write that did not land puts the secret store back exactly as it was. Where an outcome cannot be confirmed —
a keychain that timed out and then refuses to answer — nothing is undone and what is unknown is said, with the
reference and the command to run.

**Writing rules follow a mailbox that is renamed.** A per-mailbox writing profile lives in a file named after the
mailbox, so a rename would have left the rules you wrote behind. They keep applying until you write new ones, and
`doctor` mentions downloads still sitting under a former name without moving anything.

**The generated CLI reference is right again.** It is built from the real `--help` output, and long descriptions
wrap — which the generator read as new rows, inventing commands such as `agent-gmail draft would` and cutting
option defaults in half. It now joins them back together.

**The page at the end of a sign-in now says what it was for.** It read "Signed in — you can close this tab" and
nothing else, so connecting six mailboxes in a row showed the same six words six times, with no way to tell which
one you had just approved. It now carries the package's name, the mailbox being connected, the address the flow
requires it to be, and the access that was asked for.

What it deliberately does *not* say is "signed in as \<address\>". That page is served the moment Google
redirects, before the authorization code has been exchanged for anything, so the account that was actually granted
is not known at that point — and a person can pick a different one on the consent screen, which is the whole
reason `--email` exists. So it says what was asked for, says plainly that nothing is stored yet, and says that a
different account will be refused. The terminal or the agent names the account once it knows.

A request that arrives without the expected `state` — a stray tab, another process finding an open port — is told
none of it.

## 0.1.4

**Setting this up was a diagnostic, and now it is a command.** The first thing a new install told you to do was
run `doctor` — which answers "what is broken" for a setup that used to work, and so handed somebody with an empty
machine a repair instruction naming a downloaded file they did not have and could not get without leaving the
terminal. Repair notes, given to somebody who had not built the thing yet.

`agent-gmail setup` inverts it. It reports what is **next**, not what is wrong, and an empty machine is the
expected starting state rather than a fault. It walks the five Google Cloud screens with a direct link to each
and says what to type in every field — including the two where the wrong answer looks more correct than the right
one: a "Web application" client reads as the modern choice and is refused, and leaving the app in Testing reads as
the cautious one and stops every sign-in working seven days later.

It runs the same way whoever is driving. At a terminal it draws a list you move through with the cursor keys;
behind `--no-tui` it asks the same questions one line at a time; and where nobody can answer one — `--json`,
`--no-input`, CI, or either end of the pipe redirected — it asks nothing and acts on the flags it was given.
Every prompt goes to stderr, so the document `--json` puts on stdout stays parseable.

**An agent can now drive all of it except the grant itself.** `setup --client-json <path> --inbox work
--mcp-client claude-code --json` runs each step that has what it needs and stops at the first that does not,
naming the flag that would have let it continue. The one step it does not finish is the grant: it produces the
sign-in link and the command that completes it, and hands both back, because it does not drive browsers.

**And the same onboarding is available over MCP**, so an agent asked to "set up Gmail" is no longer reduced to
telling you to go and run a CLI. `gmail_setup` says what is missing and changes nothing. `gmail_inbox_add`
produces the sign-in link and stops. `gmail_inbox_finish` completes the sign-in once Google has returned a grant for it.

This is a deliberate exception to a rule this project had: no MCP tool adds an inbox. The rule was written before
there was any way to do this from a conversation, and the cost was paid by everyone. What the exception buys is
bounded, and the code enforces the bounds: a `--read-only` server does not offer the two writers at all; a server
pinned with `--inbox <alias>` does not either, and its `gmail_setup` reports only that mailbox, only the client
behind it, and no file paths; neither tool changes a policy or a tier; and there is still no MCP tool that
registers an OAuth client.

**The guarantee, stated at its real width.** This code cannot mint a credential for itself — the token comes from
Google, to whoever is signed in at that browser, after Google's own consent screen. It is *not* a human-presence
check, and nothing here enforces one: an agent already driving an authenticated browser can click through the
consent screen itself. That is outside the threat model on purpose, because such an agent is holding a logged-in
Gmail session and can already read and send through it directly. If your threat model includes that, run the
server `--read-only` or pinned and add mailboxes from the CLI.

### Fixes

- **Connecting one mailbox closed the door on the rest.** `setup` treated "a mailbox" as a step in a sequence, so
  the first one marked it done for good and a second run skipped past it — wrong for a tool whose whole shape is
  many mailboxes at once. It now asks whether to connect another, and a setup that is already complete offers
  what somebody running it again actually wants.
- **`setup` offered the wrong file.** It sorted `client_secret*.json` by date without ever opening one, so it
  suggested a *Web application* client — refused a moment later, correctly, with a complaint about a type the
  person never chose. Files are read rather than guessed at from their names, Desktop sorts first whatever the
  dates say, and every candidate is listed with its kind and when it was downloaded, because three files named
  `client_secret_<digits>.apps.googleusercontent.com.json` cannot be told apart any other way.
- **A client file is now read once, through one handle, with a ceiling.** `stat(path)` then `readFile(path)`
  describes whatever that name pointed at each time, and what this reads is a client secret. Both readers — the
  download scan and `client add` — go through one bounded open that refuses a symlink, refuses anything that is
  not a regular file, does not block on a FIFO, and stops at 64KB. `agent-gmail client add /dev/zero` used to
  read until the process died, and `setup --client-json` reaches the same code.
- **The symlink refusal did nothing on Windows.** `O_NOFOLLOW` has no Windows equivalent, so the guard was
  silently absent on one of the three platforms this ships to. It is now enforced everywhere.
- **`setup` could not finish on a machine without a keychain.** `client add` defaults to the system keychain,
  probes it, and on a headless Linux box or a container tells you to run the command again with `--store file` —
  a flag `setup` did not accept. Correct advice, impossible to follow, in the one command that exists to be where
  a new install starts. `setup` now takes `--store`, `--move` and `--launcher`, the same three `client add` and
  `mcp install` have, and reports which store the secret actually went to rather than always claiming the
  keychain.
- **A prerelease would have become `latest`.** npm moves `latest` on every publish that does not name another tag,
  so a `v0.1.4-rc.1` tag would have made a release candidate the version `npm i @agentcomms/gmail` installs, for
  everybody, immediately. The release workflow reads the tag and passes `--tag next` for any version with a hyphen
  in it.

## 0.1.3

**The setup guide broke every new install after seven days.** It told you to add yourself as a *test user* and
said a test user could use the app indefinitely. Google's own documentation says the opposite: authorizations by
a test user expire seven days from consent, and the refresh token with them. Anyone who followed the guide had
every mailbox stop working after a week with `invalid_grant`, and the troubleshooting page listed four causes of
a dead refresh token without mentioning the one that would actually hit them.

The guide now says to publish the app — *Audience → Publish app*, status **In production** — and says why, and
what it costs: one unverified-app warning screen, and a ceiling of 100 accounts that will not matter for personal
use. Troubleshooting names the seven-day expiry as the first thing to check.

Every console screen the guide named had also moved. Google reorganised in 2025: *APIs & Services → OAuth consent
screen* and *Credentials* are now **Google Auth Platform**, with Branding, Audience and Clients. Every step is a
direct link to the page it means.

### Two bugs that predate this release

**Codex registrations have never carried their environment.** `codex mcp add` takes a repeatable `--env`; this
package never passed it. Every codex entry it has written is missing `AGENT_COMMS_CONFIG_DIR` and `PATH` — latent
while the configuration sits in the default place, and a server that starts and finds no mailboxes as soon as it
does not. Fixed, along with reading `env` back from codex's TOML in both spellings.

**`mcp install` does not work on Windows, and is not fixed here.** Claude Code and Codex install there as `.cmd`
files, and this package launches them without a shell, which current Node refuses to do for a `.cmd`. It appears
never to have worked. Doing it correctly means going through `cmd.exe` and hand-escaping an argument that is a
JSON document full of quotes — not work to do from a machine that cannot run Windows, and a subtle mistake writes
a malformed entry into a client's configuration. Documented instead: `agent-gmail mcp install --print` writes
nothing and prints the exact entry to paste, `env` block included.

### Upgrading

`mcp install` pins an exact version into the entry it registers, so that upgrading the package elsewhere cannot
change what your agents run underneath you. The cost is that a new release reaches an already-registered client
only when you re-register, and nothing said so — which is how an install can sit two versions behind while the bug
it is hitting is one you fixed.

```bash
npx -y @agentcomms/gmail@latest mcp install --client claude-code --force
```

`--force` is new and required, because the client CLIs refuse to overwrite an existing entry. It captures what is
registered before removing it and puts it back if the replacement fails; if the restore fails too it says so
rather than claiming otherwise. `agent-gmail doctor` now warns when what is registered is older than what you have
— for npx-pinned and managed installs alike — and its repair command preserves the name, mailbox, read-only
status and launcher of the entry it is repairing rather than replacing them with defaults.

### Also

- **The README no longer implies one send guarantee.** `read` is enforced by Google — that token cannot send.
  `draft` and `organize` are enforced only by this software, because `gmail.compose` and `gmail.modify` both
  permit `drafts.send`. Both are real; they are not the same thing, and you can now tell which you have.
- **Install is organised by which of three routes you are on.** Two involve no Google Cloud work at all: a
  Workspace admin registers one *Internal* client for everyone, and a migration reuses the client it already has.
  One client authorises many mailboxes and many people; nothing said so.
- `inbox add --start` no longer hangs when piped. The detached listener inherited stderr and held it open for as
  long as it waited for a browser, so `... --start | tee setup.log` hung on a command that had already printed
  everything and exited.
- `inbox import` cannot bring a permission the other server never asked for, which is why imported mailboxes
  report `openid` and `userinfo.email` missing. `reauth` takes them, keeping the existing tier.
- Why this is not IMAP with an app password: an app password cannot be scoped, so the `read` tier could not
  exist, and it cannot be revoked per application.

## 0.1.2

**`agent-gmail doctor` now exits non-zero when something is broken.** It printed "1 broken" and exited `0`, so
anything gating on it — a setup script, CI, a shell `&&` — read a broken install as a healthy one. It now exits
`78`, the documented code for a configuration problem, and `agentcomms doctor` has always behaved that way, so the
two halves of the product no longer disagree about the same word.

Warnings are not failures: a setup with six things to look at and nothing broken still exits `0`.

If you script around `doctor` and relied on it always succeeding, this will change behaviour — which is the point.

### Documentation

Seven pages, at [`docs/`](https://github.com/crissmoldovan/agent-communications/tree/main/docs):

- **[Getting started](https://github.com/crissmoldovan/agent-communications/blob/main/docs/getting-started.md)** —
  nothing to reading mail, including the Google Cloud part, and the import path if you already run another Gmail
  MCP server.
- **[What is where](https://github.com/crissmoldovan/agent-communications/blob/main/docs/architecture.md)** — the
  CLI needs no MCP server, no agent and no skills. That was not written down anywhere before.
- **[Sending and approvals](https://github.com/crissmoldovan/agent-communications/blob/main/docs/sending.md)**,
  **[CLI reference](https://github.com/crissmoldovan/agent-communications/blob/main/docs/reference/cli.md)** (23
  commands), **[MCP tools](https://github.com/crissmoldovan/agent-communications/blob/main/docs/reference/mcp-tools.md)**
  (29 tools), **[the skills](https://github.com/crissmoldovan/agent-communications/blob/main/docs/skills.md)**, and
  **[troubleshooting](https://github.com/crissmoldovan/agent-communications/blob/main/docs/troubleshooting.md)** by
  symptom.

The three reference pages are generated from the code and checked by `pnpm verify`, so they cannot describe a
command or a tool that does not exist.

## 0.1.1

**If you followed the migration instructions in 0.1.0, they could not work.** `agent-gmail inbox import` — the
documented route off another Gmail MCP server — skipped every mailbox with "this grant cannot read the mailbox",
on grants that could read perfectly well.

The other server records which permissions it was granted using Google's shorthand, `gmail.readonly`, while
Google's own token responses use the full URL, `https://www.googleapis.com/auth/gmail.readonly`. This package
compared one against the other, matched nothing, and concluded the mailbox had no permissions at all. A real
six-mailbox migration imported none of them. Shorthand is now expanded before anything is compared, and a test
uses the exact shape the other server writes.

Nothing else about your mailboxes changes, and nothing needs re-authorising.

### Under the hood

- **Releases are published by CI now, and carry provenance.** A tag starts the workflow and a named reviewer
  approves the publish, so nothing reaches the registry without a person. npm attests only what a supported CI
  runner published, so **0.1.0 has no provenance and every version from here does**. No credential is stored
  anywhere: the workflow authenticates with a short-lived token minted from its own identity.
- The release script now asks the registry what actually arrived, retrying rather than concluding from one empty
  answer — the first release's check declared a publish that had in fact succeeded a total failure.

## 0.1.0

> **Published under `@agentcomms/*`.** For a few minutes on 19 September 2026 these same packages were
> live as `@cloudpixel/comms-core`, `@cloudpixel/gmail` and `@cloudpixel/gmail-mcp`. Those names were withdrawn
> inside npm's unpublish window, before anything depended on them, because they did not say what they belonged
> to: `@cloudpixel/gmail` reads as a general-purpose Gmail library, not as one provider inside a larger tool — and
> Slack, the next provider, would have arrived as an unrelated-looking `@cloudpixel/slack`. Under one product scope
> the providers are plainly siblings, and the scope matches the `agentcomms` command the core package already
> installs — so what you type to install it is what you type to run it. Install from `@agentcomms/*`; the
> `@cloudpixel` names will not return.

The first release. Email for coding agents, across as many mailboxes as you connect — and an agent cannot send
anything without your approval.

### The send gate

Sending is the one thing here that cannot be undone, and every Gmail permission that lets an agent write a draft
also lets it send one. So "may draft, may not send" is enforced in code rather than by the grant:

- **one path.** `send prepare` reads the draft, refuses it outright if an agent could not have written it, and
  records an approval bound to a digest of everything a recipient would see and to the draft's Gmail message id,
  which changes on every save. `send execute` re-reads the draft, checks it against that record, and calls Gmail
  once — never retried at any layer, because a retried send may deliver twice and nothing here could tell;
- **two guards on that path.** A test fails the build if `transport.sendDraft` is called from anywhere but
  `operations/send.ts`, and the auth client refuses any request to a path ending in `/send` that is not inside that
  one call — so a `messages.send` added anywhere in the package fails at the request rather than at review;
- **three policies per mailbox.** `chat` (the default) needs your yes in the conversation, and the guarantee is
  stated narrowly because the server cannot see that conversation. `confirm` needs a code typed at a terminal, or
  into a form from a client that has proved its forms reach a person. `never` means the draft waits in Gmail;
- **risk escalation** raises a `chat` send to `confirm` by itself when a recipient's address arrived in mail read
  this week and has never been written to, when an attachment is going to a first-time external recipient, or when
  a domain is within two characters of one this mailbox writes to.

### Reading mail safely

Everything a mailbox returns is treated as data. Message bodies arrive inside an untrusted-content envelope with a
per-call random boundary; the sanitiser removes what a human reader would not see — hidden text, off-screen
elements, zero-size fonts, CSS that hides through a stylesheet, an at-rule, a pseudo-class, a percentage opacity
or a `calc()` — and **reports what it removed and what it could not read**, so a message that was trying something
says so rather than arriving clean. Text whose colour merely matches its background is counted and *kept*, because
it may be perfectly visible against a different backdrop; the count says it is worth mentioning, not that the text
was withheld.

### What you get

- `@agentcomms/gmail` — the `agent-gmail` CLI and the library: search across mailboxes, read messages and threads,
  thread timelines, attachments, contacts, follow-ups, export, drafts, labels and the bin;
- `@agentcomms/gmail-mcp` — the MCP server, 29 tools, for Claude Code, Codex, Cursor, Claude Desktop and Gemini CLI;
- `@agentcomms/core` — config, secrets, the approval engine, the sanitiser. Provider-neutral;
- **twelve skills** teaching an agent how to use all of it and where to stop, each with the depth behind it in
  `references/`, sharing one contract;
- a plugin manifest, a Gemini extension, and a launcher that finds Node where Node actually lives.


### How 0.1.0 was built

The two entries below were written during development, one per phase, and are kept as a record of the order
things were built in and why. They describe the repository at the time: their test counts predate the fixes that
landed before release, `comms-core` is what the core package was called then, and "nothing to install yet" was
true when it was written and is not now.

### Phase 2 — signing in, the inbox lifecycle, and both surfaces

**What.** `@agentcomms/gmail` — the `agent-gmail` command and the MCP server — and
`@agentcomms/gmail-mcp`, the server as its own package:

- signing a mailbox in: loopback redirect on 127.0.0.1 with PKCE, and a **two-step flow** (`inbox add --start`
  prints the link and leaves a detached listener; `inbox add --finish` collects the result) because consent takes
  minutes and an agent's shell does not last that long;
- checks that run after consent and before anything is stored: what was actually granted (people can untick boxes),
  and which account it turned out to be — a sign-in as the wrong account, or one that cannot read, writes nothing;
- `client add|list|remove` (Desktop clients only, credentials checked with Google before they are stored),
  `inbox add|list|show|reauth|rename|policy|remove|import`, `whoami`, `doctor`, `mcp`, `mcp install`;
- `inbox import` copies mailboxes out of another Gmail MCP server, and says plainly that while that server is still
  connected an agent can send mail with none of the approval steps here;
- `doctor` checks Node, directory permissions, the secret store, every mailbox's sign-in and permissions — and
  **other Gmail MCP servers registered on this machine**, each with the command that fixes it;
- the MCP server: `gmail_inboxes_list`, `gmail_whoami`, `gmail_doctor`, a tool list that never varies between
  connections, permission checks that re-run on every call, and results carried in both `structuredContent` and one
  text block so every client sees them;
- `mcp install` writes the entry with an absolute interpreter path and an explicit environment (clients start
  servers with a minimal PATH), then starts the server through that exact entry to prove it works;
- settings written by a newer version are preserved rather than dropped when an older one writes the file, so two
  versions sharing a machine cannot silently undo each other;
- on Windows, tokens, approvals and the audit log move out of the roaming profile (`%APPDATA%`) into
  `%LOCALAPPDATA%`, which a domain does not copy between machines.

**Why.** Everything else in this project needs a mailbox connected and a way for an agent to reach it. The parts
that took the most care are the ones that fail quietly: the account you did not mean to authorise, the permission
you did not notice was missing, and the second Gmail server that can send mail without asking.

**Impact.** **Nothing to install yet.** No package is published. Developing in this repository needs Node 22.18 or
newer; the packages themselves will run on 22.12 or newer.
- **Tests:** `pnpm verify` — root 16 (including a guard that mail can leave from exactly one place, in from the
  phase before sending exists), comms-core 138, gmail 54, gmail-mcp 3, and a packed-tarball consumer check per
  package (the MCP one completes a real `initialize` and `tools/list` over stdio).

### Phase 1 — the foundation and the core

**What.** The foundation for 0.1.0: the design (`docs/superpowers/specs/2026-09-18-agent-communications-design.md`)
and the implementation plan, the repository scaffolding (pnpm workspace, TypeScript 7, tsdown, Biome, CI on Linux,
macOS and Windows, security policy, contribution guide, issue forms, Blocks review config), a skill verifier, and
`@agentcomms/core` — the provider-neutral core every other package builds on:

- config with immutable inbox ids, locked writes and user intent kept apart from runtime state;
- one secret backend per config directory: the OS keychain (Linux pinned to Secret Service; a call that an OS
  prompt holds up fails after 12 seconds instead of hanging a background server) or owner-only files;
- the approval engine that will gate every send: records bound to the inbox, the account, the draft's message id
  and a content digest; a compare-and-swap state machine plus an exclusive claim file, so an approval is used at most
  once across processes; any edit to the draft voids it; challenges a human types are stored only as hashes;
- a config store that refuses any change loosening a safety setting unless a person consented at a terminal;
- a shared send ledger for rate caps, single-use plan tokens for bulk changes, and a taint store for recipients
  that appeared only in email content;
- the untrusted-content envelope and an HTML sanitiser that removes what a mail client would not show (and reports
  it), plus a preview renderer that stops a draft from forging the recipient lines a human approves;
- path jails for downloads and attachments; the audit log; the `agentcomms` command.

**Why.** Every Gmail scope that allows drafting also allows sending, so "never send without approval" has to be
enforced in code, in one place, before any Gmail code exists.

**Impact.** **Nothing to install yet.** No package is published. Developing in this repository needs Node 22.18 or
newer; the packages themselves will run on 22.12 or newer.
- **Tests:** `pnpm verify` — root 14 passing, comms-core 164 passing, and a packed-tarball consumer check.
