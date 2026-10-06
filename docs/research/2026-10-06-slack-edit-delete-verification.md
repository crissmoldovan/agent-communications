# Slack edits and deletions: the live verification, and how to run it

**Status: §3 run 2026-10-06; §1 and §2 not run yet.** Written with
[the design](../superpowers/specs/2026-10-06-slack-edit-delete-design.md), whose §4 lists what Slack's reference leaves
unsaid and how the code behaves meanwhile — always the way that is safe if the pessimistic answer is true. This page is
how to replace each unknown with an observation. §3 settled what `file_ids` does, and editing files was built on it
(design §5); §1 and §2 would settle the rest.

**This run posts, edits and deletes real messages**, so a person runs it, by hand, never an agent or a test: the
repository's rule is that nothing in development talks to Slack. Use a workspace you may test in, and a channel made
for it.

It takes about twenty minutes and needs:

- a workspace connected in `send` mode (`agent-slack workspace show <name>`);
- a private channel created for this, say `#edit-delete-test`, with its id from `agent-slack channels`;
- a **second person** — or a second account of yours — in that channel, with the Slack client open, to see what
  somebody who is not the author sees, and whether they are notified.

---

## §1 Edits

```bash
W=acme/slack; C=<the channel id>

# A message to edit, posted through the gate.
agent-slack draft create --workspace $W --channel $C --text 'first version, see https://example.com/notes'
agent-slack post prepare --workspace $W --draft <draftId>
agent-slack post send --workspace $W --draft <draftId> --approval <approvalId> --expect-channel $C   # note its ts

# The edit: a second draft with the new words, mentioning the second person by id.
agent-slack draft create --workspace $W --channel $C --text 'second version' --mention <their user id>
agent-slack edit prepare --workspace $W --draft <newDraftId> --ts <ts>
agent-slack edit send --workspace $W --draft <newDraftId> --approval <approvalId> --expect-channel $C --ts <ts>
```

| Question | What to look at | Record |
|---|---|---|
| Does a user token's edit, sent as text alone, show "(edited)"? | The message in the second person's client | Yes / no |
| Is someone mentioned only in an edit notified? | The second person's notifications and activity | Yes / no — if no, §E6 counts too many, which is the safe side |
| Does a link added by an edit unfurl? | Edit again to add `https://example.com` bare; look for a preview card | Yes / no |
| Does an edit of a message typed by hand in Slack work? | Type a message in the client, then edit it with its ts | Edited, or the error |
| Do a message's files survive an edit of its words? | Post a draft with `--file`, then edit its words | Files kept / gone |

## §2 Deletions

```bash
# A thread: a parent posted through the gate, and a reply typed by the second person in the client.
agent-slack delete prepare --workspace $W --channel $C --ts <the parent's ts>
agent-slack delete send --workspace $W --channel $C --ts <the parent's ts> --approval <approvalId>
```

| Question | What to look at | Record |
|---|---|---|
| What does a deleted parent leave in its thread? | The thread in both clients | Replies kept under "This message was deleted", or gone |
| Are a deleted message's files deleted too? | Post with `--file`, delete it, then `agent-slack files --workspace $W` | Files kept / gone |
| Is somebody else's message refused before any preview? | `delete prepare` with the second person's message's ts | `SCOPE_MISSING`, `not-own-message` |

## §3 What `chat.update` does with `file_ids` — run 2026-10-06

Run once, by a one-off script the workspace's owner approved, in their own DM with themselves, with the workspace's own token
read through this package and never printed. It posted a message of words alone (M1) and one with a file (M2, shared
as a post with files is), uploaded `probe-a.txt` and `probe-b.txt` with no channel, edited each message as below
reading it back every time, and then deleted both messages and all three files. Every call answered `ok`.

| Edit | `file_ids` sent | Files afterwards | Words afterwards |
|---|---|---|---|
| M1, words alone | `[A]` | A | the new words |
| M1, with A | `[B]` | **B only** | the new words |
| M1 | `[A, B]` | A, B — in that order | the new words |
| M1 | none, words only | A, B — kept | the new words |
| M1 | `[]` | none | the new words |
| M1 | `[A]`, no `text` | A | **none** — `text` was `""` |
| M2, posted with C | `[B]` | **B only** | the new words |
| M2 | none, words only | B — kept | the new words |

| Question | Observed |
|---|---|
| Does the message now show `a.txt` and `b.txt`, or `b.txt` alone? | **`b.txt` alone**: the list replaces the message's files |
| If `a.txt` is no longer on the message, is it still listed among the channel's files? | **No**: `files.info` lists no share for it, and it is not deleted |
| Does `chat.update` with `file_ids` and no `text` keep the message's words? | **No**: the words are removed |
| Is the message marked "(edited)"? | Slack's answer carried `edited` on every edit; how a client draws it is §1's to confirm |

A file uploaded and finished with no channel was shared nowhere until an edit attached it. Recorded so the next person
reading Slack's reference — which still says only "new file ids that will be sent with this message" — does not have
to find this out again; rerun it if Slack's behaviour is in doubt.
