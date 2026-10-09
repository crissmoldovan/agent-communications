# @agentcomms/whatsapp

WhatsApp for coding agents, **read-only**. An agent can list, read and search the chats WhatsApp for Mac already
keeps on your Mac, and draft a reply — which comes back as a link that opens WhatsApp with the text filled in.
**You press send.** The package has no network client, no WhatsApp session and no way to send anything.

```sh
npm install -g @agentcomms/whatsapp    # or run it with npx -y @agentcomms/whatsapp <command>
```

It needs **macOS with WhatsApp for Mac** installed and signed in, and **Node 22.16 or newer** (it reads with Node's
own SQLite, which is complete from 22.16; an older Node is refused with what to install).

Phase D's held local event daemon may call this package's internal read-only event operation over a checked local copy.
It adds no WhatsApp command or MCP tool, and it cannot send.

## What it does, and what it never does, in plain words

- **It reads only local files.** Nothing it does to read, search, draft or keep its lists connects to WhatsApp, or
  to anything: no socket, no HTTP, no DNS. Its manifest declares no host (`"hosts": []`). A test builds the published
  bundle and checks that no network module is anywhere in it; another runs those commands and every tool with the
  network cut off, and `mcp install` only with `--print`. Installing is the exception, and it reaches npm, never
  WhatsApp: `npm install`, and `mcp install`, which by default installs this package from npm into agentcomms' own
  runtime (with `--launcher npx`, the client fetches it from npm each time it starts the server).
- **It never sends, marks as read, reacts, or shows you as online or typing.** There is no code that could. A draft
  is a `whatsapp://send` or `https://wa.me/` link; WhatsApp fills in the message and waits for you.
- **It never writes to WhatsApp's files.** It copies the message store and its write-ahead log, reads the copy, and
  deletes it. A test checks WhatsApp's folder is byte-for-byte and mtime-for-mtime unchanged after a sync.
- **It reads one file.** Only `ChatStorage.sqlite` and its log are opened, by exact name. The same folder holds the
  encryption keys that make the Mac a linked device (`Axolotl.sqlite`), contacts and media; none is ever read.
- **Media is described, never opened**: type, size and file name.

**WhatsApp's terms.** WhatsApp forbids unofficial clients and automation, and bans numbers it catches — including
low-volume, reply-only use. The usual way to build this, a library that logs in as a linked device, is exactly that
kind of client (and a malicious copy of one, `lotusbail`, stole the sessions of 56,000 installs in December 2025). So
this does not do it: it reads a file the official app has already written to your Mac, and nothing it does reaches
WhatsApp's servers. That is a design choice, not legal advice. **Do not pair it with anything that sends** — another
WhatsApp MCP server, a script that types into WhatsApp — or the protection is gone; `mcp install` warns about any
other WhatsApp server it finds registered.

**What you give up, stated plainly.**

- **Your messages are copied into a local index**, in plain text, so an agent can search them. It is owner-only
  (0600 in a 0700 folder, put back if anything loosens it), holds only the chats your lists let agents see, and
  `remove` deletes it. It is **not encrypted**, and it does not have the protection WhatsApp's own folder has:
  macOS asks before an app reads WhatsApp's folder, and it does not ask before one reads this index. Anything that
  runs as you can read it. (Why not encrypted: Node's SQLite cannot open an encrypted database or load one from
  memory, so the index would have to be decrypted to disk for every read — a plaintext copy anyway — and the key
  would sit in a store every program running as you can read.)
- **macOS will ask for permission to read WhatsApp's data**, for the app this runs in — below. If you grant **Full
  Disk Access** instead, you grant it to your whole terminal or MCP client, which is far broader than WhatsApp.
- **An agent reads other people's messages to you.** Hide chats with `deny`, or allow only some with `allow`.
  Groups are visible unless you hide them, and a person you have denied is still visible in a group you have not:
  to keep a group from agents, deny the group.
- **Messages are untrusted.** Anyone with your number can send text meant for the agent. Every message, name and
  file name reaches it inside the untrusted-content envelope, with invisible and bidirectional characters removed
  and counted; the residual risk is a model following an instruction anyway — which is why sending stays with you.

## Getting started

In a terminal — these are yours to run, and each refuses an agent:

```sh
agent-whatsapp add personal/whatsapp             # names WhatsApp for Mac's store; macOS may ask: choose Allow
agent-whatsapp sync --account personal/whatsapp  # copy, check, index, delete the copy
agent-whatsapp status
agent-whatsapp deny +15555550102 --account personal/whatsapp   # optional: a chat agents never see
agent-whatsapp mcp install --client claude-code --account personal/whatsapp
```

`mcp install` registers the server with your client, pinned to that account, as a change you approve: at a terminal
you type `yes` to what it shows; run by an agent it exits `10` with a preview and an approval id, and the same command
with `--approval <id>` registers it after your yes. Under the `confirm` change policy you approve with
the approve command the result gives, and a code, instead. Restart the client afterwards. From a chat, the core server's
`comms_server_install` with `channel: "whatsapp"` and `account` is the same change.

For WhatsApp Business, add its store with
`--source ~/Library/Group\ Containers/group.net.whatsapp.WhatsAppSMB.shared/ChatStorage.sqlite`.

## macOS permission

macOS protects other apps' data. On recent versions (reported for group containers from macOS 15.2), the first time a
process reads WhatsApp's folder macOS asks **"<app> would like to access data from other apps"** — where `<app>` is the
one responsible for the process: the terminal you run the command in, or the MCP client that started the server —
never Node itself. Until someone answers, the read waits. Older versions may not ask at all, and either allow the read or
refuse it.

- **Allow** fixes it for that app's session. A background MCP server cannot click it, and the answer does not always
  persist for background processes — so run `add` and the first `sync` in a terminal.
- **Full Disk Access** makes it stick: System Settings → Privacy & Security → Full Disk Access, add the terminal (or the
  MCP client), then quit and reopen it. It is much broader than WhatsApp; revoke it when you no longer need it.

The package says which: a refusal comes back as exit `77` / `AUTH_REQUIRED` with the steps and, when the environment
says which app it is, its name; a dialog nobody answers fails after 12 seconds as exit `75` with "look for the dialog"
instead of hanging; a missing store says WhatsApp for Mac may not be installed.

Only `add` and `sync` (and `status`, unless `--no-check`) touch WhatsApp's folder. `chats`, `read` and `search` open
only the index — so they cannot raise a dialog, and they keep working, on what was last synced, if WhatsApp is closed,
updating or gone.

## Commands and tools

| Command | MCP tool | What it does |
|---|---|---|
| `add <org/whatsapp> [--source]` | — | a person names the store; the first read, when macOS asks |
| `remove <org/whatsapp>` | — | forget it, its chat lists and its index; WhatsApp's own store is not touched |
| `allow <chat> --account` | — | let agents see this chat; once any is allowed, only allowed chats are visible |
| `deny <chat> --account` | — | hide this chat from agents entirely |
| `clear [chat] --account` | — | take a chat off both lists, or with no chat empty them |
| `status [--account] [--no-check]` | `whatsapp_status` | what is set up, whether it can be read, what the index holds |
| `sync --account` | `whatsapp_sync` | copy, check, index, delete the copy |
| `chats --account [--kind] [--limit]` | `whatsapp_chats` | chats, newest first; status updates only with `--kind status` |
| `read <chat> --account [--before] [--limit]` | `whatsapp_read` | one chat, newest first |
| `search <words> --account [--chat] [--sender] [--kind] [--limit]` | `whatsapp_search` | full-text: text, captions, file names, sender and chat names |
| `draft <to> <text> [--account] [--open]` | `whatsapp_draft` | a `whatsapp://send` and a `https://wa.me/` link; the person sends |
| `approve <id>` | — | approve a change — registering or pruning this server — at a terminal |
| `mcp [--account]` | — | the MCP server on stdio, pinned to one account when `--account` is given |
| `mcp install`, `mcp prune` | `comms_server_install`, `comms_server_prune` (core) | register the server with a client; remove old runtimes |

Each command and its tool run the same operation, and `capabilities.json` holds them to it. The commands with no
tool are the person's on purpose: which file on the Mac an agent reads, and which chats in it, are not an agent's to
decide, in either direction — `add`, `remove`, `allow`, `deny` and `clear` also refuse an agent at the command line.
`draft --open` is refused to an agent too: a filled-in message box landing on the screen of someone typing elsewhere
is one Enter away from sent.

`draft` takes a phone number or any id `chats` and `read` print. A group has no number, so its draft comes back as text
to paste, with the reason; so does a chat with someone who hides their number (`@lid`), a broadcast list and a channel.
A status update is not a chat anyone writes to, and is refused.

A draft cannot be used to find out which chats you hid. While your lists hide anything, a draft goes only to a chat
an agent could read — in the index, and visible — and a hidden one is refused with the same `NOT_FOUND` as a chat that
is not there; while they hide nothing, any number is drafted to. With no account named, every account's lists apply.
And every account's **deny** list applies to every draft, named account or not: a draft is a link to a number, not to
an account, so a number you denied on one is not drafted to by naming another. A pinned server consults its own
account's lists only.

**A pinned server** (`agent-whatsapp mcp --account personal/whatsapp`, which `mcp install --account` writes) acts on
that account whether or not a call names it, refuses any other, and names no other account — not in its greeting,
not in `whatsapp_status`. The pin follows the account through a rename.

**Kinds of chat.** From its id: `direct` (`…@s.whatsapp.net`), `hidden-number` (`…@lid`), `group` (`…@g.us`),
`channel` (`…@newsletter`), `broadcast` (`…@broadcast`) and `status` (WhatsApp's status feed, and one session per
contact's posts). Status updates are indexed, but `chats` and `search` leave them out unless asked for with
`--kind status`; one named by its id is read like any other chat. An id none of these match is `unknown`.

## Accounts, and the chats agents may see

An account is a record in agentcomms' own `config.json`, beside Gmail's mailboxes and Slack's workspaces, named
`organisation/whatsapp`. It is read-only by construction (`mode: "read"`, the only mode this channel has), names the
store by a stable id (`group.net.whatsapp.WhatsApp.shared` for WhatsApp for Mac), and holds no secret: its secret
reference is `whatsapp:none:<id>`, which names nothing, and `agentcomms secrets migrate` moves nothing for it. Because
it is core's record, a renamed account's old name is answered with its new one, and `comms_server_install` checks a
pin against it.

Each account can carry two lists, by chat id or phone number. A number on a list needs its country code, written with
`+` or `00` (`+1 555 555 0102`, `00 1 555 555 0102`): without one, `(555) 555-0102` could be a number in any country,
and an entry that matched no chat would hide nothing while saying it did, so it is refused. Each entry is looked up in
the index and the chat it names is shown; one that names no chat there is kept — you may hide a number before it
writes — and said to match none. (Anywhere a number is taken, `00` means `+`, and a number starting with a single `0`
is refused as national.)

- **deny** — chats an agent must never see. Not listed, searched, read, drafted to or counted; asking for one by id
  gets the same `NOT_FOUND`, word for word, as a chat that does not exist.
- **allow** — once anything is on it, the only chats an agent sees. Denied wins over allowed.

A phone number names a person rather than one chat: their one-to-one chat, their own status posts and, in the status
feed, the posts they wrote. A status post is checked against its author, so it needs one: a post WhatsApp recorded no
author for could be anyone's, including someone you denied, so while either list has anything on it, such a post is
hidden, and `status` says how many (`unattributedStatus`). Your own posts are always shown. An author WhatsApp recorded
under a hidden-number id (`…@lid`) is matched by that id, not by their number: deny the id as well.

A group is a chat, allowed or denied whole: denying someone does not take what they wrote out of a group an agent may
see, whether or not WhatsApp recorded them as the author. That is a decision, not an oversight. Hiding one person's
lines would leave the others' replies and quotes describing them; a member can appear under a hidden-number id their
number does not match; and a group on the allow list would lose everyone who is not on it too. To keep a group from
agents, deny the group.

The lists apply at once to every read on both surfaces, and `sync` applies them too, leaving what they hide out of
the index — as they are when it finishes: a list changed while a sync runs is read again just before the new index
replaces the old, and the index is built again if it changed. `status` reports how many chats each list holds, never which.

The lists are kept in `whatsapp-chats.json` beside `config.json`, by account id — not in `config.json`. Everything in
that file is kept through every write, but only a few settings are *judged* when a write loosens something, and a
deny list there could be emptied by any program that writes it with nobody asked. In a file of its own, written only
by the person's three commands, and read so that a file that cannot be read shows no chat rather than every chat,
they stay the person's.

## Moving from the spike

If you ran the unpublished spike, its accounts are in `whatsapp-spike.json`. The first command or server start of this
release moves them into `config.json`, once: the same account id, so the index the spike built is read as it is with no
new sync (each chat's kind taken from its id, so the spike's `unknown` status sessions read as status updates); the
chat lists moved before the account appears; a name that is already taken left unmoved and said so, with where its
index — a plaintext copy of its messages that nothing reads now — was left for you to delete; the
old file kept as `whatsapp-spike.json.migrated-<time>`; one line in the audit log (`agentcomms audit tail`) and one on
stderr. It reads neither WhatsApp's store nor the spike's index to do it. A configuration still on the old flat names
waits until `agentcomms names migrate` has run.

## How the store is read

WhatsApp for Mac keeps the store at `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`,
unencrypted on disk, and holds it open in SQLite's WAL mode while it runs: recent messages sit in
`ChatStorage.sqlite-wal` until the app folds them into the main file.

1. **Copy, don't open.** The store and its log are copied, byte for byte, into a private folder under agentcomms'
   state directory, owner-only. Nothing opens them with SQLite, takes a lock on them, or touches the app's `-shm`
   file. SQLite's `mode=ro` was rejected because a read-only connection still takes locks and writes read-marks into
   the app's `-shm` file; `immutable=1` because it ignores the log, missing the newest messages, and can read torn
   pages while the app writes.
2. **Open once, never through a link.** Each file is opened once, read-only, refusing a symbolic link, and every byte
   is copied from that open file — its name is never opened again, so a name swapped for a link to the key store
   between a check and the copy changes nothing. A file with a second name (a hard link, which could be the key
   store's) or that is not a regular file is refused. The cost: Node's copy, which clones on APFS, takes a name and
   would open it again, so the bytes are copied instead — the store's size on disk until the sync deletes it.
3. **Consistent, or not at all.** Each open file is fingerprinted (device, inode, links, size, nanosecond mtime)
   before and after the copy, and each name is looked at again for a file that came, went or was replaced; if
   WhatsApp wrote in between, the copy is discarded and taken again, up to five times, then refused. SQLite then
   checks the copy (`quick_check`).
4. **Check the layout before reading.** A missing required table or column refuses the whole sync by name (exit `65`),
   and the previous index is kept as it was. A missing optional part turns off one named feature and is reported.
5. **Index, then delete the copy.** The index is rebuilt in a new file and renamed into place, owner-only. The copy is
   deleted whatever happens; one a crash left behind is removed by the next sync. `remove` holds the same lock as
   `sync`: it waits for a sync that is running (up to a minute), then deletes the index that sync wrote with the rest,
   and a sync that was waiting behind it finds the account gone and writes nothing.

WhatsApp can change this layout without notice. The reader refuses rather than guess when a required part is gone;
the risk it cannot catch is a column that keeps its name and changes its meaning, so check a handful of chats by eye
after a WhatsApp update if anything looks wrong.

## Where the schema comes from

Nobody opened a real store to write this — not the owner's, not even for its layout. Every table and column the
reader uses is one that public, open-source readers of `ChatStorage.sqlite` query by name (commits pinned in
`src/source/schema.ts`):

| Source | What it establishes |
|---|---|
| [kenn-io/msgvault](https://github.com/kenn-io/msgvault) `internal/whatsapp/apple.go` | the **macOS** app: `ZWACHATSESSION` (`ZCONTACTJID`, `ZPARTNERNAME`, `ZSESSIONTYPE`, `ZLASTMESSAGEDATE`), `ZWAGROUPMEMBER` (`ZMEMBERJID`, `ZCONTACTNAME`, `ZFIRSTNAME`), `@lid` chats, Core Data seconds since 2001-01-01 |
| [raycast/extensions](https://github.com/raycast/extensions) `extensions/whatsapp/src/services/readLocalDatabase.ts` | the **macOS** path; `ZSESSIONTYPE = 0` for one-to-one chats |
| [KnugiHK/WhatsApp-Chat-Exporter](https://github.com/KnugiHK/WhatsApp-Chat-Exporter) `ios_handler.py` | `ZWAMESSAGE` (`ZISFROMME`, `ZMESSAGEDATE`, `ZTEXT`, `ZMESSAGETYPE`, `ZSTANZAID`, `ZGROUPMEMBER`), `ZWAMEDIAITEM`, `ZWAPROFILEPUSHNAME`; epoch 978307200 |
| [abrignoni/iLEAPP](https://github.com/abrignoni/iLEAPP) `scripts/artifacts/whatsApp.py` | `ZFROMJID`, `ZTOJID`, `ZMEDIAITEM`, `ZGROUPEVENTTYPE`; type 5 is a location |
| [sepinf-inc/IPED](https://github.com/sepinf-inc/IPED) `ExtractorIOS.java` | `ZWAMEDIAITEM.ZFILESIZE`; `ZTITLE` is missing from older stores |
| [ForensicWace](https://github.com/Alessiop01/ForensicWace-ServerEdition) `globalConstants.py`, [wa-explorer](https://github.com/ludufre/wa-explorer) `docs/IOS_STORAGE.md` | the `ZMESSAGETYPE` values; `ZVCARDSTRING` holding a media item's MIME type |

The macOS app is the iOS app built for the Mac, which is why the iOS readers apply; the first two read the Mac file
itself. Facts were taken from these projects, not code. Where the sources say nothing — most `ZMESSAGETYPE` numbers
— the reader reports `unknown:<n>` rather than guess.

**What counts as media.** WhatsApp keeps a `ZWAMEDIAITEM` row for much more than media: a reply's quoted message lives
in it (KnugiHK reads replies from its `ZMETADATA`; iLEAPP counts 1,350 such rows), and the first run against a real
store found one on most text messages and on every call, with no type, no size and no file. So a row alone is not
media. A message is media when its type is one ForensicWace and wa-explorer name as media — a photo not yet downloaded
has no file and is still a photo — or when its row names a stored file (`ZMEDIALOCALPATH`, the test KnugiHK and
iLEAPP use). Anything else — text, a call, a location — shows no media line and is not counted as media. A call is
shown as a call, without a duration: both KnugiHK and iLEAPP read call durations from `CallHistory.sqlite`, a separate
file this reader never opens.


## Licence

[MIT](LICENSE). The bundled dependencies' notices are in `THIRD_PARTY_LICENSES`.
