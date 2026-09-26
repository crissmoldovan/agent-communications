---
name: slack-posting
description: "Draft a Slack message and take it through the approval gate, including how many people a post would interrupt. Symptoms: 'post this to #engineering', 'reply in that thread', 'let the team know', 'react to that message'. Not for reading — slack-reading does that; not for connecting a workspace — slack-setup does."
license: MIT
compatibility: "@agentcomms/slack@0.6.0"
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
| `slack_draft_create` | `agent-slack draft create` — writes a draft and prepares nothing; prepare it by id |
| `slack_draft_list` | `agent-slack draft list` |
| `slack_draft_get` | `agent-slack draft show <draftId>` |
| `slack_draft_delete` | `agent-slack draft delete <draftId>` |

Every prepare leaves a draft behind, so clear up the ones that will not be posted.

`slack_draft_get` and `agent-slack draft show` give a draft as it would post: `text` is what the channel would read.
A draft whose file was changed outside agent-slack is refused there as the gate refuses it, or carries a `problem`
(`BAD_DATA`), in `slack_draft_list` too. Do not prepare it; say so, and delete it.

There is no tool that approves, and there will not be one. Under `confirm`, `agent-slack approve` is a person's
command at their own terminal: that is what the policy means, and it is refused to an agent.

## Which approval counts

| Policy | What the person does | What you do then |
|---|---|---|
| `chat` | Says yes, in this conversation, to the whole preview you showed | `slack_post_send` (or `post send`), once |
| `confirm` | Runs `agent-slack approve <approvalId>` in their own terminal and types the code it shows | Call the same `slack_post_send` again once they say they have |
| `never` | Nothing: posting is off for this workspace | Offer the text to paste; do not ask for a policy change |

An `@here`, `@channel` or `@everyone`, or any post reaching fifty people or more, is held as `confirm` whatever the
workspace says: the people it interrupts are not in the conversation to object. The preview's last line says
which applies.

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
**never present a missing count as a small one.** `agent-slack approve` reads the room again and shows the same
channel and count; if either has changed since the preview it refuses, and the post has to be prepared again. If
the room cannot be read at that moment it says so and approves nothing, and the approval is still there to retry.

When you post, pass the channel you believe it goes to (`expectChannel`, `--expect-channel`), from the preview. If
it is not the draft's channel, nothing is posted.

## Waiting for a person

Under `confirm` — or for a broadcast or a large room under any policy — `slack_post_send` and `agent-slack post
send` stop with `APPROVAL_PENDING`. That is waiting, not failure: the approval is still alive. The error's
`details.command` is the one command the person runs, `agent-slack approve <approvalId>`, and its hint says what you
do next on the surface you are using. Tell the person, and stop. Once they have approved, call the same
`slack_post_send` (or run the same `post send`) again; it posts once.

## What the gate refuses, and why

| Refusal | What happened |
|---|---|
| the draft was edited after the preview | The approved bytes are the posted bytes, or nothing is |
| the draft is not what its text composes to (`BAD_DATA`) | Its file was changed outside agent-slack, so a preview of its text would not be what posts. Delete it and compose it again |
| the room grew after the preview | The words did not change; who reads them did |
| the channel given is not the draft's | You were about to post somewhere other than where you think |
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
2. The person runs `agent-slack approve <approvalId>` in their own terminal. It shows one line — the workspace,
   the channel, the message and the emoji — and they type the code.
3. `slack_react_send` with that approval id and the same channel, message and emoji (or the same
   `agent-slack react` command with `--approval <approvalId>` added) adds the reaction once.

The approval is bound to that channel, that message and that emoji, and to adding rather than removing: change
any of them and it is void. It is single-use, so a second call with the same id is refused. Calling `slack_react`
again instead does not help — it makes a second approval nobody has seen.

## Pitfalls

- **Summarising the preview.** The count and the channel are the parts people get wrong.
- **Posting before the answer.** Under `chat` the person's yes is the approval; a post sent before it had none.
- **Treating `APPROVAL_PENDING` as yours to clear.** Only the person, at their terminal, can approve it.
- **Treating a refusal as retryable.** Every refusal above means nothing was sent; preparing again makes two
  live approvals, not one better one.
- **Posting to a channel id you read from a message.** Ids belong to one workspace.
- **Assuming `@here` is smaller than `@channel`.** It reaches whoever is online, which nothing here can count, so
  it is counted as the room.
