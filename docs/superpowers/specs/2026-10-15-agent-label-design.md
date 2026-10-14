# Labelling what an agent sends — design

2026-10-15. Builds on the Slack design ([2026-09-19](2026-09-19-slack-design.md)), the parity design
([2026-09-25](2026-09-25-cli-mcp-parity-design.md)), the channel plugins design
([2026-09-26](2026-09-26-channel-plugins-design.md)) and Slack edit and delete
([2026-10-06](2026-10-06-slack-edit-delete-design.md)). Where this document says nothing, they hold unchanged. **It
reverses one decision of the Slack design, D7's "We never request `chat:write.customize`"** (§4).

## 1. What was asked

The owner, 2026-10-15: "Right now, when I'm sending messages, people that receive my message see it in my name. How
would it be possible for them to know that the messages that are sent are sent from my agent? Instead of having my
name, it should have my name and a little thing next to it saying 'agent' or 'minion' or 'twin'." And: "The goal is
that this one will not impersonate me." Agents reading Slack "send acknowledgments back and then send responses back,
but they send them as me". The ask is to make that visible to the people who receive them.

They decided, the same day:

- **Slack posts as the app, named after the person.** "I would prefer the bot token version": the message carries
  their name, the word in parentheses, and the APP badge that Slack adds to every app message.
- **Where the app cannot post, the message goes out as the person, labelled in its text.** This covers a direct
  message between two people, and a private channel the app is not in. The preview says that this is the fallback.
- **Gmail and Resend show the name and the word in the From line:** "Cristian Moldovan (agent)".
- **The word is the person's to choose:** "agent, twin, minion, or whatever they want". The default is `agent`.
- **The label is on for every account unless switched off.** Switching it off for one account loosens a safety
  setting, so it shows a preview and needs a yes. Switching it back on applies at once.

Success: someone who receives a message an agent sent through these tools can tell, without opening anything, that
the person's agent sent it and not the person, in every place the message appears.

## 2. What is true about the platforms

The sources were read on 2026-10-15.

- **Slack has no agent marker for a message posted with a user token.** Such a message "is attributed to the user and
  shows their profile photo"
  ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)). The "Sent using @Claude" line people
  see is plain text that Slack's MCP server appends
  ([slackapi/slack-skills-plugin#25](https://github.com/slackapi/slack-skills-plugin/issues/25)). It is not a
  platform feature that an app could use.
- **An app's bot token with `chat:write.customize` sets `username` and `icon_url` for each message.** Slack asks that
  this be done only "in response to an inciting user action", never as something "unexpected or surprising"
  ([chat:write.customize](https://docs.slack.dev/reference/scopes/chat.write.customize)). Its developer policy forbids
  "allowing impersonation of Users or otherwise allowing for false representations"
  ([developer policy](https://docs.slack.dev/developer-policy)).
  - A customised app message still shows Slack's APP badge after the name. Only a third party
    ([Push Security, 2023-10-24](https://pushsecurity.com/blog/phishing-slack-persistence)) states this, so the live
    check in §9 must see it.
- **"Bot users cannot post to a direct message conversation between two users"**
  ([conversations.open](https://docs.slack.dev/reference/methods/conversations.open)).
  - With `chat:write.public` an app posts in any public channel without joining it.
  - In a private channel, or a channel shared with another organisation, it posts only once it is a member.
- **A notification shows a message's `text`, not its blocks.** `text` is "used as a fallback string to display in
  notifications" ([context block](https://docs.slack.dev/reference/block-kit/blocks/context-block)), so a label shown
  only in a block is missing from the notification.
- **Resend's From is free-form**, `Name <address>` on a verified domain
  ([send email](https://resend.com/docs/api-reference/emails/send-email)).
- **Gmail does not document what it does with a From display name sent through the API.**
  - Reports say it rewrites only an address the account does not own and leaves the name as written
    ([2012](https://lee-phillips.org/gmailRewriting/)).
  - A From with no name goes out with no name: Gmail does not add the send-as name
    ([gogcli#436](https://github.com/steipete/gogcli/issues/436), 2026-03).
  - Unconfirmed until §9's live check.
- **No header that mail clients display marks a message as sent by an agent.**
  - RFC 3834's `Auto-Submitted: auto-generated` "MUST NOT be used on manually generated messages", and it stops
    out-of-office replies ([RFC 3834](https://www.rfc-editor.org/rfc/rfc3834.html)). A message a person approved is
    not auto-generated, so it is not used here.
- **WhatsApp cannot change the sender's name per message.** These tools do not send WhatsApp messages in any case: a
  WhatsApp draft is a click-to-chat link that the person sends themselves (`packages/whatsapp/src/operations/draft.ts`).
  WhatsApp is out of scope (§8).

What these tools do today:

- **Slack:** the app requests user scopes only (`packages/slack/src/manifest.ts`). Sign-in refuses any reply that
  carries a bot token (`packages/slack/src/auth/authorize.ts`).
- **Gmail:** From is the bare address, `formatAddress({ name: '', address })`, at create, reply and update
  (`packages/gmail/src/operations/drafts.ts`). The approval binds the From address but not a display name
  (`packages/gmail/src/domain/outbound.ts`).
- **Resend:** the caller supplies From, name included, on every send, and the approval binds all of it.
- **Core:** nothing records the person's name.

## 3. The label

### L1 — One phrase, the same everywhere: `<name> (<word>)`

The **word** is one setting for the person, default `agent`. The **name** comes from the channel itself where the
channel has one:
- Slack: the signed-in user's display name, or their real name when they have none, read with `users.info`.
- Gmail: the send-as display name of the From address.
- Resend: the name the caller put in From.

Where the channel has no name, a **name** setting in the core fills the gap. Nothing guesses one: with neither, the
prepare is refused and says how to set it (`agentcomms label name …`). A channel's own name beats the setting, so a
Resend sender named for a product ("Acme Billing") is labelled "Acme Billing (agent)", not with the person's name.

If the name already ends with ` (<word>)`, it is not labelled twice.

### L2 — What a word may be

The word is 1 to 24 characters: letters, digits, spaces, `-` and `'`, with no space at either end. It may not contain
parentheses, `<>"@,;:\`, or any control, bidirectional or invisible character (the core's `isDangerous`). The whole
phrase must fit each platform: 80 characters for a Slack `username`, and 100 for a Resend name
(`packages/resend/src/compose/message.ts`). A phrase that does not fit is refused at prepare, naming the limit, and is
never cut short.

### L3 — Settings, and who may change them

The core owns the label, because the channel plugins design lets no channel add a safety setting of its own
(`packages/core/src/config.ts`, the comment on `AccountConfig`).

- `agentLabel: { word?, name? }` sits at the top of `config.json`. An absent `word` means `agent`.
- `agentLabel: 'off'` may be set on one Gmail inbox, or on one account on any other platform. Anything else, and
  absence, means the label is on.

`classifyChange` judges all three:
- **Switching an account's label off is a loosening.**
- **Changing the word or the name is a loosening.** The word is the disclosure: a new word could weaken it ("me",
  "personally"), and a new name could be somebody else's. The preview shows the phrase exactly as recipients will
  see it, on each connected channel.
- **Switching an account's label back on is a tightening**, and applies at once, even beside a change that waits.

Each change goes through the existing change flow (`GatedChange`) under the person's change policy. An agent cannot
approve one under `confirm`.

**When an older release meets these keys.** Every config schema is a `looseObject`, so releases before this one read
the keys and ignore them. If an older release drops them when it writes, an `off` account goes back to on and a
chosen word goes back to `agent`: tightenings, both. Older runtimes still send unlabelled; `agentcomms update` brings
every client to the release that labels (§10).

### L4 — The CLI and the MCP tool

The core gains one capability. The CLI is `agentcomms label` and the MCP tool is `comms_label`; both run the same
operation, `packages/core/src/operations/label.ts`, with a row in `capabilities.json`.

- With no change, it shows the word, the name, every account and whether its label is on, and the phrase each
  account's messages would carry. Reading needs nobody.
- `word <word>`, `name <name>`, `off <account>` and `on <account>` each change one thing, through §L3.

## 4. Slack

### S1 — The send app gets a bot user with posting scopes only, and the read app none

The `send` manifest adds a bot user and exactly these bot scopes:
- `chat:write`;
- `chat:write.customize`;
- `chat:write.public`;
- `reactions:write`, for S6's reactions. It is dropped if §11's second question is answered the other way.

It asks for no bot scope that reads or uploads. The `read` manifest is unchanged, and has no bot user.

Sign-in changes to match:
- A `send` app's exchange must return a bot token, `token_type` `bot`, with exactly those scopes. It is refused with
  anything more or less, and it is stored beside the user token in the core's secret store, under
  `slack/bot-token/<accountId>`.
- A `read` app's exchange still refuses any bot token. The read-mode guarantee stays as it was: on this machine, no
  stored token for a read workspace can post.

**This reverses D7's first bullet.** It said: "We never request `chat:write.customize`. Our messages go out as the
person, with their own name." D7 was written against a different risk: an app choosing any name and avatar, so that
a person in the channel cannot tell a message is not theirs. Here the code never takes a name from a caller. The
`username` is always §L1's phrase, which carries the word, and Slack adds its APP badge, so the customisation
discloses the agent rather than hiding one. D7's reading rules are unchanged: attribution comes from `bot_id` and
`user`, and a `username` is shown only as a display name the app chose. D7 in the Slack design gets a note pointing
here.

**An existing `send` workspace keeps working with no new sign-in.** Until the person updates their app from the new
manifest and signs in again, every post takes the labelled fallback (S3), and `doctor` says how to switch to the
app's identity. Nothing is silently left unlabelled.

### S2 — The route is chosen before the preview, and never changed after it

Before the preview, prepare decides who posts:
- **The app posts** in a public channel not shared with another organisation, and in a private or shared channel
  whose members include the app's bot user. Membership is checked with the person's token,
  `conversations.members`, paged until the bot is found and capped at ten pages.
- **The person posts, labelled (S3)** in a direct message, a group direct message, the person's own DM with
  themselves, a channel the app is not in, and any channel where the membership could not be settled.

The route is part of what the approval binds. At send, a refusal from Slack such as `not_in_channel`, from an app
removed meanwhile, ends that send as refused, and nothing is posted under the other identity. A switch from the app
to the person is a different message, so it needs a new preview and a new yes.

### S3 — The labelled fallback

When the person's token posts, the label is in the message itself, in both places a reader can meet it:
- `blocks`: a context block, `Sent by <name> (<word>)`, above the message's own section;
- `text`, which notifications show: `<name> (<word>): <message>`.

A file post carries the same prefix in its `initial_comment`. An edit keeps the prefix in its new text. An edit sends
`text` only, because Slack shows "(edited)" only on a text update (the edit design, §2).

### S4 — The app's message: name, avatar, and nothing caller-supplied

An app post is `chat.postMessage` with the bot token and:
- `username`: §L1's phrase;
- `icon_url`: the person's Slack avatar (`profile.image_192`).

The text and blocks are the ones the composer makes today. Callers still cannot pass blocks, and nobody can pass a
`username` or an icon. Both come from the account's own profile, read at prepare, and the approval binds them with
the rest of the payload.

### S5 — Edits and deletes use the identity that posted

`chat.update` and `chat.delete` edit only the caller's own messages, so an edit goes out with the token that
posted.
- An app message may be edited or deleted only when **this account's own send record** holds its channel and `ts`.
  The bot token is the workspace's, and other people who installed the same organisation app hold it too. Slack
  cannot tell one person's agent from another's, so the local record decides, and an app message this account did
  not post is refused before the preview.
- A message posted as the person, whether typed by hand or posted through the fallback, is edited with the user
  token. While the label is on, the new text carries S3's prefix, because an agent wrote the change.

### S6 — Reactions and files

**Reactions** go through the route of S2:
- The app reacts where it can post (which needs one more bot scope, `reactions:write`; see §11).
- Elsewhere the person reacts, unlabelled, because a reaction has no text to carry a label. The preview says so.

**Files** always take the fallback in this release. An app's file upload carries the app's own bot name and cannot
set `username`, so the person posts the file with S3's prefix in its comment.

### S7 — The preview says who will appear to post

The `From:` line names the identity exactly:
- for an app post: `Cristian Moldovan (agent) · posted by the app <the app's name in Slack>`;
- for a fallback: `Cristian Moldovan · labelled "Sent by Cristian Moldovan (agent)" · the app cannot post in a direct
  message between two people`.

Each fallback gives its reason in those words.

## 5. Gmail

### G1 — A draft is labelled when it is written

With the label on, `draft create`, `draft reply` and `draft update` write From as `"<name> (<word>)" <address>`, with
the name from §L1. With it off, From stays as it is today. The display name is encoded by the composer's own address
formatter, so a word with non-ASCII letters goes out as an RFC 2047 encoded word.

### G2 — A draft written elsewhere is relabelled at prepare, header only

A draft can reach `send prepare` with an unlabelled From while the label is on: one written in Gmail, or before the
upgrade. Prepare then rewrites only its From header, and replaces the draft with the result. Every other byte of the
raw message is unchanged, and a test proves it on plain, HTML and attachment drafts. The preview shows the new From
and says it was relabelled. A From whose address is not one the inbox may send as is refused exactly as now.

### G3 — The approval binds the whole From

The digest stores the From address and not its display name (`outbound.ts`), so a name could change between preview
and send unnoticed. The digest now binds the From header as the preview shows it, and `send.execute` refuses a draft
whose From differs. This is still the only path to Gmail's send endpoints.

## 6. Resend

R1 — With the label on, prepare composes From from §L1: the caller's name, or the core's name setting when the caller
gave only an address, followed by ` (<word>)`. The preview shows it, and the approval already binds the whole From.
`executeSend` is unchanged and still the only path to Resend's send endpoint.

## 7. What does not change

- Nothing sends without a person's yes to its exact content. The label is part of that content, not added after it.
- Anything a sender controls still passes through the sanitiser and the envelope.
- Reading is unchanged. A Slack message posted by this account's app reads back with `bot_id` set, labelled as an
  app's, with its `username` shown as a display name the app chose (D7).
- The events daemon sends nothing to recipients (`packages/events-daemon/README.md`), so it has nothing to label.
- No `Auto-Submitted` or custom header is added. No client shows one, and the first would be untrue (§2).

## 8. Out of scope

- **WhatsApp.** These tools draft a link; the person presses send. If they later send WhatsApp messages themselves,
  the label would be a text prefix, the only place WhatsApp allows.
- **A footer in mail bodies.** It is not needed if Gmail keeps the From name (§9). If the live check shows it does
  not, a body footer is added before release, and this document is amended first.
- **An app identity for files** (§S6).

## 9. Tests, and the live checks

Every test runs against the fakes: Slack's loopback (`packages/slack/test/support/fake-slack.ts`), Gmail's transport
(`packages/gmail/test`) and Resend's loopback. Nothing reaches a real service.

- **Slack's fake learns:**
  - bot tokens and `chat:write.customize`'s `username` and `icon_url`;
  - `not_in_channel` for a private channel the bot is not in;
  - the refusal of a bot post into a DM or group DM;
  - membership paging.
- **Tests cover:**
  - every route of S2, and that the route is bound;
  - no fallback after a refused app post;
  - S3's label in both `text` and `blocks`;
  - S5's own-record rule for app messages;
  - sign-in refusing a bot token with the wrong scopes, and a read app refusing any bot token;
  - G2's byte-for-byte relabel, and G3's binding;
  - R1's composition;
  - §L2's validation;
  - §L3's classification of each change.
- **The parity drive** runs `label` on both sides.

Live checks, each only with the owner's yes to the exact preview:
1. The owner updates their `send` Slack app from the new manifest and signs in again.
2. An app post in a test channel: the name, avatar and APP badge appear as S4 says.
3. A fallback post in the owner's own DM.
4. A Gmail send from an inbox the owner allows to send, to their own address: the From name arrives as G1 writes it.
   This settles §8's footer question.

Resend gets no live check: no real key is used while developing.

## 10. Release

A minor release: a new capability, and a change in what recipients see by default.

The changelog's **Upgrading** section must say so plainly:
- after updating, every message an agent sends is labelled;
- a Slack send app needs updating from the new manifest, and a new sign-in, to post as the app; until then it posts
  as the person, labelled;
- older runtimes still running in other clients send unlabelled until `agentcomms update` reaches them.

## 11. For the owner's review

These are choices the owner has not yet made. The recommended answer is written into the sections above, and any can
be changed before planning:

1. **The avatar (S4):** the person's own photo (recommended, since it is "my name and a little thing next to it"), or
   the app's icon, which sets the message further apart.
2. **Reactions (S6):** the app reacts where it can (recommended: an acknowledgement like 👀 from the person reads as
   "they have seen it"), which adds the scope `reactions:write` to S1. The alternative is that reactions stay the
   person's.
3. **An agent's edit of a message the person typed (S5):** it gains the label (recommended), or it is edited as
   theirs.
4. **Changing the word or name needs a yes (§L3):** recommended, because the word is the disclosure. The alternative
   is that the word changes freely and only switching the label off asks.
5. **Files take the fallback in this release (S6).**
