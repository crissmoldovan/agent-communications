# Slack: editing and deleting a message — design

2026-10-06. Proposed in a pull request from a contributor; nothing here is decided until the owner reviews it. Builds on
the Slack design ([2026-09-19](2026-09-19-slack-design.md)), the parity design
([2026-09-25](2026-09-25-cli-mcp-parity-design.md)) and approval smoothness
([2026-10-05](2026-10-05-approval-smoothness-design.md)); where this document says nothing, they hold unchanged.

## 1. What was asked

An agent that posted a message with a typo, to the wrong thread, or with the wrong figure or chart, has no way to put
it right: the person has to open Slack and do it by hand. The ask is that an agent can **edit** a message — change its
words, and add, remove or replace its files — and **delete** one, through the same gate a post goes through.

Editing files was first left out: Slack's reference does not say what `chat.update`'s `file_ids` does to the files a
message already has, and a preview cannot honestly describe an act nobody has seen. It was settled by observing it
against a real workspace on 2026-10-06 (§5) and built on what was seen.

The Slack design already names both methods. `chat.update` and `chat.delete` are classified `write` in
`api/methods.ts`, so no path reaches them today, and §9 of that design lists "retraction is not a gate" among what it
does not protect against. This document makes them reachable, through the gate, and only that way.

## 2. What is true about Slack

Each of these was read from Slack's reference on 2026-10-06
([`chat.update`](https://docs.slack.dev/reference/methods/chat.update),
[`chat.delete`](https://docs.slack.dev/reference/methods/chat.delete)), not inferred.

- **Both need `chat:write`, and nothing else.** That scope is in the `send` manifest already and in no `read` one, so a
  workspace connected to read cannot edit or delete — Slack refuses it, as it refuses a post — and nobody has to sign
  in again for this.
- **`chat.update` edits only the caller's own messages.** "Only messages posted by the authenticated user are able to
  be updated using this method." Anything else is `cant_update_message`.
- **`chat.delete` does not stop at the caller's own.** With a user token it "may only delete messages that user
  themselves can delete in Slack" — and a workspace admin can delete other people's messages in Slack. So an agent
  acting for an admin could delete anybody's words. Slack does not stop that; §3 E2 does.
- **Sending `text` without `blocks` replaces the blocks, and shows "(edited)".** "If the text argument is provided and
  blocks are not provided, the blocks will be removed, and the provided text will be used for message rendering." And:
  "If blocks are used and a message is being updated, the edited flag will not be displayed on the message (the flag
  will be displayed on the message if using text)."
- **Rich-text blocks cannot be replaced by other blocks** (`block_mismatch`). A message a person typed in Slack carries
  `rich_text` blocks; the composer here writes a `section`. Sending the composer's blocks would refuse every edit of a
  message typed by hand.
- **`parse` defaults to `client` on an update, "unlike `chat.postMessage`"**, and an argument left out "will be
  overwritten with the default". A post goes out under `none`; an update that left `parse` out would be read under a
  different rule from the one its preview was written for.
- **`chat.update` has no unfurl switch.** `chat.postMessage` takes `unfurl_links` and `unfurl_media`; `chat.update`
  takes neither.
- **Each method lists its errors**, and each list says it is not exhaustive. As for the methods already behind the
  gate, only the errors whose own description places them before anything was changed are treated as a refusal (§3 E8).

## 3. Decisions

### E1 — Two more doors in the gate, and no new scope

`chat.update` and `chat.delete` join `PostingMethod`, each with its own allowlist of errors that mean "refused before
acting", read from its page as the four existing ones were. They are reached only through `spendOn`, inside a claimed
approval's lease, after a fence — exactly as `chat.postMessage` is. Nothing new is added to `methods.ts`: both were
classified `write` from the start, which is why nothing could call them until now.

### E2 — Only this account's own messages, checked before anything is shown

Before a preview is built, the message is read from Slack and refused unless its `user` is the account the workspace is
connected as (`SCOPE_MISSING`, `not-own-message`). Checked again on the approval screen and again before the claim.

For an edit this is Slack's rule too, so the check only moves the refusal earlier. For a deletion it is stricter than
Slack: an agent never deletes what somebody else wrote, whatever the account it acts for is allowed to do. An admin who
wants that does it in Slack.

The ts is never trusted to name a message: the caller passes the channel and the ts, and what the preview shows is what
Slack returned for them — `conversations.history`, and `conversations.replies` for a reply inside a thread.

### E3 — The message as it is now is shown, and bound

The preview shows the message being changed, decoded as the channel reads it. Its digest binds that message — its
author, its words, its files and, for a deletion, how many replies it has — as well as the act. So a message edited in
Slack between the preview and the claim, or a deletion's thread that gained a reply, is not the act the person agreed
to, and its approval is void.

> **The last look, added in review (#52).** Comparing at the claim was not enough. An edit with files spends its
> uploads between the claim and `chat.update`, and an edit sends the words and the file list it built from the reading
> the claim compared — so a message changed in Slack in that gap, which may be minutes long, would have been
> overwritten by an older one: the words put back, a file added since taken off. The message is now read once more
> immediately before every edit and every deletion — after any uploads, before the fence — and the act starts only if
> it is still exactly what was read. Otherwise nothing is changed and the approval, spent by its claim, is failed
> (`message-changed`), naming any files already up. Gone by then — the channel read, and no message at that ts in it or
> its thread — an edit has nothing to change (`NOT_FOUND`), and a deletion has what it asked for (`used`, as
> `message_not_found` from `chat.delete` is). Any other failed read refuses, with Slack's reason: a channel not found or
> archived since also reads as `NOT_FOUND` from `callSlack`, and taking that for a missing message would let a deletion
> report a success with the message still there (found in the same review).

The message's words are this account's own (E2), so they are treated as an outgoing post's are (D4): decoded, not
neutralised, and escaped for the terminal by the renderer. Unfurled content and attachments added by Slack are not
part of what is shown; the files are, by name.

### E4 — An edit's new words are a draft; what it replaces is bound in the approval

An edit is prepared from a draft — one already written, or one `slack_edit_prepare` writes from `text`, as
`slack_post_prepare` does — and the message it replaces is named when it is prepared. The draft stays an ordinary
draft: the same file, the same store, the same "a change to it voids the approval". What makes it an edit is the
approval, which binds the message's channel and ts and the message as it was read (E3).

Three other shapes were weighed:

- **The target inside the draft.** Every surface that reads a draft — `draft show`, `draft list`, `draft update`,
  `post prepare`, `post send`, the unsent report — would have to learn that some drafts are not posts, and an older
  release reading the field would ignore it and prepare the words as a new post.
- **A store of its own.** A second copy of the draft store's id, revision, shape and ownership checks, for words that
  are a draft in every respect but where they go.
- **No stored words at all, as a reaction has none.** A person approving at a terminal has to be shown the new words,
  and a reaction's record holds an emoji, not a message.

A draft written for an edit is still a draft: listed, editable, and preparable as a post — whose preview would say so.

A draft written as a reply in a thread is refused for an edit (`USAGE`): an edit leaves a message where it is. A draft's
files are the files the edit adds (§5); which of the message's own files go is named apart, by id, and bound in the
approval's expectation (`edits <ts>, reaches <n>, removes <id> …`), because it is part of the act, not of the words.

**A draft with no words keeps the message's.** They are sent back exactly as Slack holds them — escaped, with mentions
as spans — and previewed as unchanged. An edit that only swaps a file must not retype the words: typed again from a
read, a mention would come back as plain text, and the preview could not show the difference.

### E5 — An edit sends its text, under `parse: none`, and `file_ids` only when it changes the files

`chat.update` is sent `channel`, `ts`, `text` and `parse: none` — no `blocks`, no `link_names` — and `file_ids` when the
edit adds or takes off files (§5). `text` is always sent: observed, `file_ids` without it leaves a message with no words.
Three reasons for the rest, all from §2:

1. **Slack marks it "(edited)".** With blocks it does not, and a correction that nobody can see is a correction is the
   wrong default for words an agent changed after people had read them.
2. **It works on a message typed in Slack.** Blocks from the composer are refused against `rich_text` (`block_mismatch`).
3. **It is read under the rule the preview was written for.** A post goes out under `parse: none`; so does its edit.

D4 still holds: the preview renders the one string that is sent, and the digest is taken over exactly what is sent.
The composer's `section` block says the same thing as that string, so nothing a person approved is lost by not sending
it.

### E6 — An edit's reach and ceremony are a post's

An edit puts new words in front of everyone in the room, so it is previewed and counted as a post of those words is,
and raised to `confirm` by what raises a post: `@channel`, `@here`, a reach of 50 or more, or a reach nobody could
count. Whether Slack notifies someone mentioned only in an edit is not documented, so they are counted as if it does
— over-stating reach is the safe direction for a number somebody is about to approve — and the preview says the
count may be high.

Because `chat.update` takes no unfurl switch, an edit whose words hold a link is flagged `link-may-unfurl` and warned
about, as a post with files is (#44).

The preview also says what an edit does not do: nobody who read the old words is told what changed.

### E7 — A deletion is at the workspace's policy, like a post

A deletion cannot be undone. Neither can a post, and a post goes on a yes in the chat under `chat`; a deletion of the
account's own words reaches nobody new and notifies nobody, so it does not raise its own ceremony. The workspace's
policy decides: `chat` is the yes in the conversation, `confirm` a person at a terminal, `never` refuses.

It is two steps, not a reaction's one, because a person must see what is about to disappear: `delete prepare` reads the
message and returns its preview; `delete send` deletes it once approved. The preview shows the words, the files by
name, and the replies by count, with what happens to each (E3, and §6 for what is not yet verified). It is flagged
`deletes-message`, plus `has-replies` and `has-files` where they apply.

### E8 — What each outcome is recorded as

The post's rules, unchanged: a refusal from the allowlist is `failed`; any other answer leaves the approval `sending`, to
read `unknown`, never `failed`; an accepted act is `used` whatever the bookkeeping after it does. Two Slack answers need
a decision of their own:

- **`message_not_found` from `chat.delete`** is the state the approval asked for — the message is not there — so it is
  `used`, with a note saying Slack found nothing left to delete. The message was read moments before, under the same
  claim, so it did exist.
- **`message_not_found` from `chat.update`** is a refusal: nothing was changed.

Five Slack errors gain plain words in `callSlack`: `cant_update_message`, `cant_delete_message` and
`edit_window_closed` (`SCOPE_MISSING`, with what to do), and `is_inactive` (`NOT_FOUND`, as `is_archived` is).

### E9 — The surfaces

| Command | Tool | Operation |
|---|---|---|
| `edit prepare --draft <id> --ts <ts> [--remove-file <id>…]` | `slack_edit_prepare` (`ts`; `draftId`, or `channel` with any of `text` and `files`; `removeFiles`) | `prepareEdit` |
| `edit send --draft --approval --expect-channel --ts` | `slack_edit_send` | `sendEdit` |
| `delete prepare --channel --ts` | `slack_delete_prepare` | `prepareDelete` |
| `delete send --channel --ts --approval` | `slack_delete_send` | `sendDelete` |

The same shape as `post prepare` and `post send`, each pair one operation, each in `capabilities.json`. `approve` shows
an edit's preview and a deletion's preview, re-reading the message as it does the room for a post. `approval wait`,
`slack_approval_wait` and core's waits and lists need nothing: these are Slack send approvals like any other.

Audited as `slack.edit.prepare`, `slack.edit`, `slack.delete.prepare` and `slack.delete`.

### E10 — What an earlier release does with these approvals

Nothing an earlier release can run turns one into something else:

| Earlier release | An edit's approval | A deletion's approval |
|---|---|---|
| `approve` | Read as a post of its draft; the post's digest is not the edit's, so it is revoked (`integrity`) | Its draft id is not a draft id: refused |
| `post send` | The claim's digest is a post's, not the edit's: void | Its draft id is not a draft id: refused |
| The draft itself | An ordinary draft: preparable as a post, with a post's preview | — |

### E11 — What this does not do

- **Other people's messages**, for either act (E2).
- **Deleting files.** A file taken off a message stays in Slack, shared nowhere; deleting it is a person's act in
  Slack, and the preview says so. `files.delete` stays unreachable.
- **Moving a message**, into or out of a thread, or between channels. Slack offers neither.
- **Scheduled messages.** `chat.deleteScheduledMessage` stays unreachable.
- **Many at once.** One approval, one message.

## 4. Unknowns, and how this behaves without them

The rule from the Slack design: where the answer is unknown, ship the behaviour that is safe if the pessimistic answer
is true. [The verification checklist](../../research/2026-10-06-slack-edit-delete-verification.md) says how to settle each
one against a real workspace.

| Unknown | How this behaves |
|---|---|
| Whether Slack notifies people mentioned only in an edit | Counted as if it does (E6); the preview says the count may be high |
| Whether Slack unfurls a link added by an edit | Flagged and warned (E6) |
| Whether "(edited)" shows on a user token's edit sent as text alone | The preview never promises a silent correction or a visible one: it says nobody is told what changed |
| What a deleted parent leaves in its thread | The preview says the replies are not deleted with it, which is what is asked of Slack |
| What happens to a deleted message's files | The preview says the files are not deleted with it, which is what is asked of Slack |
| ~~What `file_ids` does to a message's files~~ | Observed 2026-10-06: see §5 |
| Whether `conversations.replies` finds a reply by its own ts | The message is looked for in `conversations.history` first, and a reply is found by identity among what `conversations.replies` returns; one that cannot be found is `NOT_FOUND`, never guessed at |

## 5. Editing a message's files

### What Slack does, observed

Slack's reference says only that `file_ids` is an "array of new file ids that will be sent with this message". So it was
observed, on 2026-10-06, against a real workspace, in the account's DM with itself, by a one-off script the owner of the
workspace approved (the checklist's §3): a message of words alone, then one posted with a file; files uploaded with no
channel; edits sending different lists, each read back; everything deleted afterwards.

| Sent to `chat.update` | What the message had afterwards |
|---|---|
| `file_ids: [A]`, on a message of words alone | A — so a file can be added to a message that had none |
| `file_ids: [B]`, on a message with A | **B alone**: the list replaces the message's files, it does not add to them |
| `file_ids: [A, B]` | A and B, in that order |
| `file_ids: []` | no files |
| words, and no `file_ids` | the files it had — so an edit of words leaves them alone, as E5 assumed |
| `file_ids`, and no `text` | its files, and **no words**: text has to be sent every time |
| `file_ids: [B]`, on a message posted with C (as a post with files is) | B alone, as for any message |

And of the files: one uploaded and finished with no channel is shared nowhere until an edit attaches it; one an edit
leaves out is no longer shared anywhere (`files.info` lists no share) but is not deleted; and every edit was marked
edited.

### What an edit of files does, then

- **It sends every id the message should end with.** The files it keeps, in the order the message has them, then the
  ones it adds, in the order the draft names them. Adding one keeps the rest; taking one off sends the others;
  replacing one is both, in one edit.
- **New files are a draft's files**, chosen and recorded exactly as a post's (the attachment jail, at most ten, each
  checked by size and hash). The preview lists each by name, size, type, SHA-256 and path, as a post's does, and the
  approval binds those bytes: a file changed since is refused before anything leaves the machine.
- **They go up unshared, after the claim.** Inside one permit for `files.completeUploadExternal`, as a post's: every
  file read again and checked, then for each an upload URL and the bytes just read, then one call finishing them all —
  naming no channel, so sharing them nowhere. Then a second permit, for `chat.update` with the ids. Each step starts
  after its own fence (fence sites 2–4, then 6); the guard is unchanged.
- **The preview says what the files will be:** `Keeps`, `Removes` and `Attach` lines, and the words as now and after —
  or once, as unchanged. A file taken off is said to stay in Slack, shared nowhere, to delete there if it should go.
- **What a failure leaves.** Before the files are finished, Slack discards any that went up, as for a post. Once
  finished, a file never attached stays in Slack, private to this account, and the failure says so, by name. Either
  way the message is unchanged, and the approval is failed — except an answer lost at the edit itself, which is
  `SEND_OUTCOME_UNKNOWN` like any other.
- **It needs `files:write`**, which `send` mode has, for any edit that adds or takes off files; and the errors
  `chat.update` documents for the files it names join its allowlist (`file_not_found`, `blocked_file_type`, …).

## 6. Tests

No test talks to Slack. Each act gets the post's and reaction's suites in its own shape: the gate (a refused,
uncertain and accepted answer, bookkeeping failures that cannot rewrite an outcome, a cancellation either side of the
claim), the allowlists against each method's documented errors, both surfaces through one operation, the terminal
approval of each kind, the fence before each step (`fence-sites.ts` gains sites 6 and 7, and an edit with two files
over sites 2, 3, 4 and 6), and every D2 row (`support/matrix.ts`, an edit with a file among them).
