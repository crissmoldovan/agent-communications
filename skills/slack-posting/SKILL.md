---
name: slack-posting
description: "Draft a Slack message and take it through the approval gate, including how many people a post would interrupt. Symptoms: 'post this to #engineering', 'reply in that thread', 'let the team know', 'react to that message'. Not for reading — slack-reading does that; not for connecting a workspace — slack-setup does."
license: MIT
compatibility: "@agentcomms/slack@0.4.0"
metadata:
  group: communications
  lifecycle: release
---

# Posting to Slack

**Nothing you do here posts anything.** Preparing writes a local draft and returns a preview with an approval id.
A person posts it. That is not a formality to route around — it is the whole design, and on a `read` workspace it
is enforced by Slack rather than by this code: the token cannot post at all.

```sh
agent-slack draft create --workspace acme/slack --channel C024BE7LR --text 'ready when you are'
agent-slack post prepare --workspace acme/slack --draft <draftId>   # prints the preview, posts nothing
```

With the MCP server connected, `slack_post_prepare` does both steps in one call and returns the same preview. Every
prepare leaves a draft behind, so clear up the ones that will not be posted:

| MCP tool | CLI |
|---|---|
| `slack_post_prepare` | `agent-slack draft create`, then `agent-slack post prepare` |
| `slack_draft_list` | `agent-slack draft list` |
| `slack_draft_get` | `agent-slack draft show <draftId>` |
| `slack_draft_delete` | `agent-slack draft delete <draftId>` |

There is no tool that posts, reacts or approves, and there will not be one: those are `agent-slack post send`,
`agent-slack react` and `agent-slack approve`, at a terminal, under the rules below.

## Show the whole preview, and stop

The preview is what the person is agreeing to. Show it in full, then wait. Do not summarise it, do not prepare a
second one "to be safe", and do not retry a refusal.

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
**never present a missing count as a small one.** `agent-slack approve` reads the room again and shows the same
channel and count; if either has changed since the preview it refuses, and the post has to be prepared again. If
the room cannot be read at that moment it says so and approves nothing, and the approval is still there to retry.

Under `confirm`, `agent-slack post send` stops with `APPROVAL_PENDING` until the person has run
`agent-slack approve <approvalId>`. That is waiting, not failure: the approval is still alive. Run the same
`post send` again once they have.

## What the gate refuses, and why

| Refusal | What happened |
|---|---|
| the draft was edited after the preview | The approved bytes are the posted bytes, or nothing is |
| the room grew after the preview | The words did not change; who reads them did |
| already claimed | An approval is single-use, across processes |
| refused at `agent-slack approve` | The draft or the room changed since the preview; the screen is only shown when it is still what the approval binds |
| prepared for a different account | Two accounts in one workspace are two different people speaking |
| policy `never` | Posting is off for this workspace |

A refusal means **nothing was sent**. Report it and ask; do not prepare again to work around it.

## Mentions are asked for, never typed

The author's text is escaped on the way out, so writing `<@U024BE7LH>` in a message posts those characters rather
than notifying anybody. A deliberate mention is passed separately, **by id** — a name is ambiguous, and resolving
one from a string somebody else controls is choosing who gets interrupted on their say-so.

A broadcast — `@here`, `@channel`, `@everyone` — always needs a person at a terminal, whatever the workspace
policy says, because the people who would be interrupted are not in the conversation to object.

## When the workspace is `read`, or the policy is `never`

There is no "send it from the app instead" escape hatch: Slack has no server-side draft, so the person cannot
open it in Slack and finish it. The equivalent is **"here is the text; paste it yourself"**, and the preview is
written to be pasteable. Offer it that way rather than asking for a mode change.

Widening a workspace to `send` is a person's job and needs their own Slack app's manifest changed — see
`slack-setup`. You may *ask*; you may never do it.

## Reactions

A reaction notifies somebody and is attributed to them, so it goes through the same permit. It is not a message,
though, so under `chat` policy it takes one line — which emoji, on which message — and a yes, and then
`agent-slack react --workspace <name> --channel <id> --ts <ts> --emoji <name>` adds it.

Under `confirm` it takes the same typed approval as a message, in the same two steps:

1. `agent-slack react …` adds nothing. It makes an approval and stops with `APPROVAL_PENDING`, naming the
   approval id. Tell the person which emoji and which message, and stop.
2. The person runs `agent-slack approve <approvalId>` in their own terminal. It shows one line — the workspace,
   the channel, the message and the emoji — and they type the code.
3. Run the same `agent-slack react` command again with `--approval <approvalId>` added. It adds the reaction once.

The approval is bound to that channel, that message and that emoji, and to adding rather than removing: change
any of them and it is void. It is single-use, so a second run with the same id is refused. Running `react` again
*without* `--approval` does not help — it makes a second approval nobody has seen.

## Pitfalls

- **Summarising the preview.** The count and the channel are the parts people get wrong.
- **Treating a refusal as retryable.** Every refusal above means nothing was sent; preparing again makes two
  live approvals, not one better one.
- **Posting to a channel id you read from a message.** Ids belong to one workspace.
- **Assuming `@here` is smaller than `@channel`.** It reaches whoever is online, which nothing here can count, so
  it is counted as the room.
