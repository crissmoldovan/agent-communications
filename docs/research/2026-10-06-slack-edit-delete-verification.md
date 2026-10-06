# Slack edits and deletions: the live verification, and how to run it

**Status: not run yet.** Written with [the design](../superpowers/specs/2026-10-06-slack-edit-delete-design.md), whose
§4 lists what Slack's reference leaves unsaid and how the code behaves meanwhile — always the way that is safe if the
pessimistic answer is true. This page is how to replace each unknown with an observation. §1 and §2 settle what this
release does; §3 is the gate on building phase 2, replacing a message's files.

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

## §3 Phase 2: what `chat.update` does with `file_ids`

Not reachable from this release: `chat.update` is only ever sent words. This needs a short script against the Web
API with the workspace's token, run by a person, to answer the one question phase 2 cannot be designed around:

1. Post a message with one file, `a.txt`.
2. Upload `b.txt` without sharing it: `files.getUploadURLExternal`, the bytes, then `files.completeUploadExternal`
   with no `channel_id`.
3. `chat.update` the message with `file_ids` set to `b.txt`'s id.

| Question | Record |
|---|---|
| Does the message now show `a.txt` and `b.txt`, or `b.txt` alone? | |
| If `a.txt` is no longer on the message, is it still listed among the channel's files? | |
| Does `chat.update` with `file_ids` and no `text` keep the message's words? | |
| Is the message marked "(edited)"? | |

Record what was seen here, with the date, and amend the design's §4 and §5 to say which unknowns are now known.
