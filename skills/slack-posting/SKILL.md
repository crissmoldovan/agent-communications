---
name: slack-posting
description: "Draft a Slack message, with local files if asked, and take it through the approval gate, including how many people a post would interrupt — or edit or delete a message this account posted, through the same gate. Symptoms: 'post this to #engineering', 'reply in that thread', 'let the team know', 'send the report to the channel', 'share this file in Slack', 'react to that message', 'fix the typo in what you posted', 'delete that message'. Not for reading — slack-reading does that; not for connecting a workspace — slack-setup does."
license: MIT
compatibility: "@agentcomms/slack@0.14.1"
metadata:
  group: communications
  lifecycle: release
---

# Posting to Slack

**Nothing reaches Slack unless a person approved that exact content.** Preparing writes a local draft and returns
a preview with an approval id; nothing is posted at that point. What counts as the person's approval is the
workspace's send policy, and it is not yours to choose or to give. On a `read` workspace none of this applies: the
token cannot post at all, and Slack enforces that rather than this code.

```sh
agent-slack draft create --workspace acme/slack --channel C024BE7LR --text 'ready when you are'
agent-slack post prepare --workspace acme/slack --draft <draftId>   # prints the preview, posts nothing
agent-slack post send --workspace acme/slack --draft <draftId> --approval <approvalId> --expect-channel C024BE7LR
```

With the MCP server connected, `slack_post_prepare` does the first two steps in one call and returns the same
preview, and `slack_post_send` is the third. Both surfaces run one operation, so they refuse the same things.

| MCP tool | CLI |
|---|---|
| `slack_post_prepare` | `agent-slack draft create`, then `agent-slack post prepare` |
| `slack_post_send` | `agent-slack post send` |
| `slack_react` | `agent-slack react` |
| `slack_react_send` | `agent-slack react --approval <approvalId>` |
| `slack_edit_prepare` | `agent-slack draft create`, then `agent-slack edit prepare --draft <draftId> --ts <ts>` |
| `slack_edit_send` | `agent-slack edit send` |
| `slack_delete_prepare` | `agent-slack delete prepare --channel <id> --ts <ts>` |
| `slack_delete_send` | `agent-slack delete send` |
| `slack_draft_create` | `agent-slack draft create` — writes a draft and prepares nothing; prepare it by id |
| `slack_draft_update` | `agent-slack draft update <draftId>` — changes a draft; any approval it had no longer holds |
| `slack_draft_list` | `agent-slack draft list` — and, for each draft's current revision, what its approvals say |
| `slack_draft_get` | `agent-slack draft show <draftId>` |
| `slack_draft_delete` | `agent-slack draft delete <draftId>` |
| `slack_approval_wait` | `agent-slack approval wait <approvalId>` — where an approval stands; it only looks |

Every prepare leaves a draft behind, so clear up the ones that will not be posted.

`slack_draft_get` and `agent-slack draft show` give a draft as it would post: `text` is what the channel would read.
A draft whose file was changed outside agent-slack is refused there as the gate refuses it, or carries a `problem`
(`BAD_DATA`), in `slack_draft_list` too. Do not prepare it; say so, and delete it.

There is no tool that approves, and there will not be one. Under `confirm`, Slack's `approve` is a person's
command at their own terminal — the one the result gives, handed over as given: that is what the policy means, and
it is refused to an agent.

## Which approval counts

| Policy | What the person does | What you do then |
|---|---|---|
| `chat` | Says yes, in this conversation, to the whole preview you showed, within ten minutes | `slack_post_send` (or `post send`), once |
| `confirm` | Runs the approve command the result gives in their own terminal and types the code it shows, within thirty minutes | Wait for it with `slack_approval_wait`, then call the same `slack_post_send` again, within 24 hours |
| `never` | Nothing: posting is off for this workspace | Offer the text to paste; do not ask for a policy change |

An `@here`, `@channel` or `@everyone`, or any post reaching fifty people or more, is held as `confirm` whatever the
workspace says: the people it interrupts are not in the conversation to object. The preview's last line says
which applies, and the result's `approval` says it too: `claimable: true` means a yes in this chat posts it;
`false` means it waits for the person's terminal.

When the person says no, revoke it at once, with the core server's `comms_approval_revoke` (CLI: `agentcomms
approvals revoke <approvalId>`). The server cannot hear a "no": until it is revoked, a post on the chat route can
still be sent for the rest of its ten minutes.

## Show the whole preview, and wait for a yes

The preview is what the person is agreeing to. Show it in full, then wait. Do not summarise it, do not prepare a
second one "to be safe", do not post before they answer, and do not retry a refusal.

It carries something a mail preview does not: **how many people this interrupts.**

```text
#engineering · posting as Jo Example (U024BE7LH) · acme/slack
@channel — about 412 people

  shipping the rename in ten minutes

nothing has been posted · draft dft_… · approval ap_…
this needs a person to approve it at a terminal before it posts
```

`@channel` is eight characters whether the room holds three people or four hundred, and a person approving the
four-hundred case is agreeing to something quite different. If the count could not be read, the preview says so —
**never present a missing count as a small one.** Slack's `approve` reads the room again and shows the same
channel and count; if either has changed since the preview it refuses, and the post has to be prepared again. If
the room cannot be read at that moment it says so and approves nothing, and the approval is still there to retry.

When you post, pass the channel you believe it goes to (`expectChannel`, `--expect-channel`), from the preview. If
it is not the draft's channel, nothing is posted.

**Where a post can go.** A post goes to a conversation id: a channel's `C…` or `G…`, or a direct message's `D…`. A
user id (`U…`, `W…`) is refused as a destination; for a direct message, find the DM's own id with `slack_channels`
(`agent-slack channels --workspace <name>`). And it goes only to a room this account has joined: a post to a channel
it is not a member of is refused before any preview — and again at Slack's `approve` and at send, before the
approval is spent. Ask the person to join it in Slack themselves, then prepare again; nothing here joins a channel. A
DM or a group DM is never refused for this. If the room could not be read, the preview says membership could not be
checked; say so when you show it.

## Sending files

Files go through the same gate as words, in the same post. Name each one by its local path: `files` on
`slack_draft_create` or `slack_post_prepare`, `--file` on `agent-slack draft create`. With files the text is
optional; when there is some, it is posted as the files' message, so the two arrive as one post.

```sh
agent-slack draft create --workspace acme/slack --channel C024BE7LR --text 'the Q3 numbers' --file ~/reports/q3.pdf ~/reports/q3.csv
agent-slack draft update <draftId> --workspace acme/slack --add-file ~/reports/q3-chart.png
```

`slack_draft_update` (`agent-slack draft update`) changes a draft: `files` (`--file`) replaces its files, `addFiles`
(`--add-file`) adds to them, `files: []` (`--no-files`) takes them all off, and every change is a new revision, so
prepare it again and show the new preview.

**Which files.** The rule Gmail's attachments follow: a regular file under the home folder, and not in one of its
hidden folders (`~/.ssh`, `~/.config` and the like), a `.git` folder, or a `.env` file. A file anywhere else — `/tmp`
included — is refused, and the refusal says so: ask the person to copy it under their home folder, then name the
copy, or to allow its folder with core's `attach roots add`, as the refusal gives it, which needs their approval. Do not copy it
yourself without saying so. A link is refused too; name the file it points to.

**Limits.** At most ten files a post, each at most 100 MiB, and none empty. Above either limit the draft is refused,
naming the limit.

**The preview lists every file** — the name Slack will show, its size, its type, its SHA-256, and the path it is read
from — before the channel's reach and the words. It warns about a file over 10 MiB, and about one Slack shows in the
channel itself (an image, a PDF, any kind of text), since everyone in the room will see what is in it. Show it in
full, as for any post.

**A link in a file post's words may unfurl.** A message is posted with link previews turned off. A post with files
cannot be: Slack offers no way to turn them off for files, so it may fetch a link in the files' words and show that
page's preview to everyone in the channel. For such a post the preview lists every link in the words — a bare
`https://…` as well as a formatted one — flags the approval `link-may-unfurl`, and warns. Show the warning, and offer
what it suggests: post the link as a message of its own, which does not unfurl. Do not take the link out on your own.

**The approval is bound to each file's hash.** A draft records each file's size and hash when it is written. The
file is read again when it is prepared and refused if it changed since; and when it is sent every file is read and
checked again before anything is uploaded, then the bytes just checked are the ones sent. A file edited, replaced or
moved after the preview voids the approval, and nothing is sent.

**What comes back.** `slack_post_send` (`agent-slack post send`) returns each file's id in Slack and the message's
`ts`. Slack's own answer carries no message, so the `ts` is read back afterwards, and may be `null` with a `note`
when Slack had not attached the files to a message yet. Say that; never guess a `ts`. If something fails before the
post, it says "nothing was posted", and names any file that had been uploaded — Slack discards those. A long file
post holds its approval `sending` for as long as it takes, renewing it as it goes.

**The workspace has to be able to.** Sending a file needs a workspace in `send` mode granted `files:write`. Otherwise
the prepare is refused with `SCOPE_MISSING` and the command that fixes it, which is the person's to run — see
`slack-setup`.

## Waiting for a person

Under `confirm` — or for a broadcast or a large room under any policy — `slack_post_send` and `agent-slack post
send` stop with `APPROVAL_PENDING`. That is waiting, not failure: the approval is still alive, for thirty minutes.
The error's `details.command` is the one command the person runs — Slack's approve as this installation runs it, its
folders pinned; hand it over exactly as given — and its hint names the wait. Tell the person, then learn when they
have approved with `slack_approval_wait` (CLI: `agent-slack approval wait <approvalId>`): repeated default-length
waits, calling again while it answers `pending` with `claimable: false` — never one long one, which a client may
move into the background, and never asking the person to tell you. Once it answers `approved` with
`claimable: true`, call the same `slack_post_send` (or run the same `post send`) again; it posts once, and the
approval lasts 24 hours.

## What a post said

Say a post as its result says it. A post Slack accepted without a `ts` is "sent; the provider returned no id": there
is no `ts` to quote, and its approval reads `sending`, then `unknown` — never `used`. Never say "sent, message id …"
without an id. Before saying anything about a post you did not just make, look: `slack_approval_wait` with
`waitSeconds: 0` (`--wait-seconds 0`) for its approval, or `slack_draft_list`, which says for each draft's current
revision what its approvals can prove — "not sent with any approval in the last 90 days", a narrower scope, or that
it was posted. Repeat those words. An approval that reads `corrupt` failed its integrity check: say so.

## What the gate refuses, and why

| Refusal | What happened |
|---|---|
| the draft was edited after the preview | The approved bytes are the posted bytes, or nothing is |
| a file is not the one the draft recorded, or the one approved | It changed, or was replaced, after it was named; nothing was sent |
| a file must come from an allowed folder | It is outside the allowed folders, or in a folder never sent from; ask the person to copy it under their home folder, or to allow its folder with core's `attach roots add`, as the refusal gives it (needs their approval) |
| the draft is not what its text composes to (`BAD_DATA`) | Its file was changed outside agent-slack, so a preview of its text would not be what posts. Delete it and compose it again |
| the room grew after the preview | The words did not change; who reads them did |
| not a member of the channel (`SCOPE_MISSING`, `not-a-member`) | This account has not joined that room. The person joins it in Slack themselves, then you prepare again; a DM or group DM is never refused for this |
| a user id is not a destination (`USAGE`) | A post goes to a conversation id. For a direct message use the DM's `D…` id, which `slack_channels` lists; mentions still take user ids |
| the channel given is not the draft's | You were about to post somewhere other than where you think |
| not written by this account (`SCOPE_MISSING`, `not-own-message`) | An edit or a deletion is only ever of this account's own message; anyone else's stays as they wrote it |
| the message changed after the preview | It was edited in Slack, or — for a deletion — its thread gained a reply; prepare it again and show the new preview |
| this approval is not for an edit, or a deletion, or not this message | You passed another act's approval, or another message's channel or ts; nothing was spent |
| already claimed | An approval is single-use, across processes |
| refused at Slack's `approve` | The draft or the room changed since the preview; the screen is only shown when it is still what the approval binds |
| prepared for a different account | Two accounts in one workspace are two different people speaking |
| policy `never` | Posting is off for this workspace; one turned off since the post was prepared revokes it for good |
| `APPROVAL_EXPIRED` | "this approval expired; nothing was sent with it": ten minutes on the chat route, thirty for a person, or 24 hours approved and unused |
| `APPROVAL_PENDING`, "being sent by another call since …; wait for it" | Another call is posting it. Wait with `slack_approval_wait` until it reads `used`, `failed` or `unknown`. Never prepare again while a send is `sending` |
| `SEND_OUTCOME_UNKNOWN` | Slack's answer was lost, so it **may have posted**; the approval reads `sending`, then `unknown`, and a late result is still possible. Check the channel before anything else; never prepare it again automatically |

A refusal means **nothing was sent** — except `SEND_OUTCOME_UNKNOWN`, which means nobody knows yet. Report it and
ask; do not prepare again to work around it. Branch on the code, not the words.

## Mentions are asked for, never typed

The author's text is escaped on the way out, so writing `<@U024BE7LH>` in a message posts those characters rather
than notifying anybody. A deliberate mention is passed separately, **by id** — a name is ambiguous, and resolving
one from a string somebody else controls is choosing who gets interrupted on their say-so.

A broadcast — `@here`, `@channel`, `@everyone` — always needs a person at a terminal, whatever the workspace
policy says, because the people who would be interrupted are not in the conversation to object.

## When the workspace is `read`, or the policy is `never`

There is no "send it from the app instead" escape hatch: Slack has no server-side draft, so the person cannot
open it in Slack and finish it. The equivalent is **"here is the text; paste it yourself"**, and the preview is
written to be pasteable. Offer it that way rather than pushing for a mode change.

If the person wants the workspace able to post, that is a change they approve, and it needs their own Slack app's
manifest updated first — see `slack-setup` (`slack_mode_set`). Never start it on your own to get a post out, and
never loosen a send policy of `never` (`slack_workspace_policy`) to get round it: both are the person's to ask for.

## Reactions

A reaction notifies somebody and is attributed to them, so it goes through the same permit. It is not a message,
though, so there is no preview: say which emoji on which message, in one line, and wait for a yes.

Under `chat`, `slack_react` (or `agent-slack react --workspace <name> --channel <id> --ts <ts> --emoji <name>`) then
adds it, once.

Under `confirm` it takes the same typed approval as a message, in the same two steps:

1. `slack_react` (or `agent-slack react …`) adds nothing. It makes an approval and stops with `APPROVAL_PENDING`,
   naming the approval id and, in `details.command`, the command the person runs. Tell them which emoji and which
   message, and stop.
2. The person runs that command in their own terminal, exactly as given. It shows one line — the workspace,
   the channel, the message and the emoji — and they type the code.
3. `slack_approval_wait` with that approval id learns when they have. Then `slack_react_send` with it and the
   same channel, message and emoji (or the same `agent-slack react` command with `--approval <approvalId>` added)
   adds the reaction once.

The approval is bound to that channel, that message and that emoji, and to adding rather than removing: change
any of them and it is void. It is single-use, so a second call with the same id is refused. Calling `slack_react`
again instead does not help — it makes a second approval nobody has seen.

## Editing and deleting a message

Only a message this account posted, and only through the gate. Each is two steps, like a post: a prepare that changes
nothing and returns a preview, then — after the same approval a post needs — the send, once. Slack is read first and
the message refused before any preview if this account did not write it: never offer to edit or delete anyone else's,
whatever the person's role in the workspace.

**An edit** changes only a message's words, where it is. `slack_edit_prepare` with the message's `ts`, its `channel`
and the new `text` (or `draftId` for a draft already written) returns a preview showing the words it has now and the
words it will have, and how many people see it. Show both, in full, and wait for a yes; then `slack_edit_send` with
the `draftId`, `approvalId`, `expectChannel` and `ts` from the preview. A draft written as a reply in a thread, or with
files, is refused: an edit cannot move a message, and replacing files is not offered — say so rather than deleting
and posting again.

Say what an edit does not do: nobody who read the old words is told what changed. Mentions in the new words are
counted as if Slack notified them, and an `@channel`, `@here` or a large room needs a person at a terminal, as for a
post. A link in an edit may unfurl — an edit has no switch to stop it — and the preview says so.

**A deletion** cannot be undone. `slack_delete_prepare` with the `channel` and `ts` returns a preview of the message as
it is now, with the replies and files that are **not** deleted with it. Show it in full and wait for a yes; then
`slack_delete_send` with the same `channel`, `ts` and the `approvalId`. If it says Slack found nothing left to delete,
repeat that: the message was already gone.

The approval binds the message as it was read. Edited in Slack after the preview — or, for a deletion, a reply added
to its thread — it is void, and the act has to be prepared again. Under `confirm` both wait for the person's
terminal as a post does, and `slack_approval_wait` learns when they have.

## Pitfalls

- **Summarising the preview.** The count and the channel are the parts people get wrong.
- **Posting before the answer.** Under `chat` the person's yes is the approval; a post sent before it had none.
- **Treating `APPROVAL_PENDING` as yours to clear.** Only the person, at their terminal, can approve it; you wait.
- **Leaving a "no" unrevoked.** The server never hears it. Revoke the approval at once.
- **Preparing again on doubt.** Not while it is `sending`, and not after `SEND_OUTCOME_UNKNOWN` until the person has
  looked in the channel: a second prepare is a second post.
- **Treating a refusal as retryable.** Every refusal above means nothing was sent; preparing again makes two
  live approvals, not one better one.
- **Posting to a channel id you read from a message.** Ids belong to one workspace.
- **Assuming `@here` is smaller than `@channel`.** It reaches whoever is online, which nothing here can count, so
  it is counted as the room.
- **Deleting and posting again to "edit".** It moves the message, loses its thread and notifies people afresh. Edit it,
  or say why it cannot be.
- **Showing only the new words of an edit.** The person is agreeing to the change; show what it says now as well.
