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
but they send them as me". The ask is to make that visible to the people who receive them, and to let the person
decide when an agent speaks as itself and when as them: "I should be able to tell the agent to behave one way or
another."

They decided, the same day:

- **Slack posts as the app, named after the person.** "I would prefer the bot token version": the message carries
  their name, the word in parentheses, and the APP badge that Slack adds to every app message.
- **The icon is their own photo with a small robot badge on it.**
- **The app also reacts where it can post,** and **an agent's edit of a message the person typed is labelled**.
- **Where the app cannot post, the message goes out as the person, labelled in its text.** This covers a direct
  message between two people, and a private channel the app is not in. The preview says that this is the fallback.
  Files always take this route in this release.
- **Gmail and Resend show the name and the word in the From line:** "Cristian Moldovan (agent)".
- **The word comes from a fixed list:** `agent` (the default), `assistant`, `twin`, `minion`, `bot`, `fake`, `AI`.
  Nobody types their own word.
- **The person chooses who a message appears to come from, at four levels:**
  - per message;
  - per account;
  - per conversation;
  - by kind of message (a reaction, a reply, a new post…).

  Whatever the level, the preview shows the result before anything is sent.
- **A change that could make any message unlabelled, and any change of word or name, applies only after the person
  confirms it.** The change flow shows a preview first. A change that only adds labelling applies at once.

Success:
- someone who receives a message an agent sent through these tools can tell, without opening anything, that the
  person's agent sent it and not the person, unless the person chose otherwise for that message;
- the person can always see, before it is sent, which of the two it will be.

### Out of this document, in this order

The owner also asked for rules on how an agent behaves. Each gets its own design, after this one:

1. **Behaviour rules:**
   - how it writes: tone, language, length, sign-off, always in the thread. This builds on the compose profiles the
     core already has;
   - what it may do at all: for example, react and reply, but never start a conversation, edit or delete.
2. **Sending some messages without asking**, for example acknowledgements. It changes the rule that nothing is sent
   without the person's yes to its exact content, so it needs a threat model of its own. It is not designed here, and
   nothing here weakens that rule.

## 2. What is true about the platforms

The sources were read on 2026-10-15.

- **Slack has no agent marker for a message posted with a user token.** Such a message "is attributed to the user and
  shows their profile photo" ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)). The
  "Sent using @Claude" line people see is plain text that Slack's MCP server appends
  ([slackapi/slack-skills-plugin#25](https://github.com/slackapi/slack-skills-plugin/issues/25)). It is not a
  platform feature that an app could use.
- **An app's bot token with `chat:write.customize` sets `username`, and `icon_url` or `icon_emoji`, per message.**
  `icon_emoji` overrides `icon_url`. Slack asks that customisation be used only "when the user themselves gives
  permission" and be signposted ([chat:write.customize](https://docs.slack.dev/reference/scopes/chat.write.customize)).
  Its developer policy forbids "allowing impersonation of Users or otherwise allowing for false representations"
  ([developer policy](https://docs.slack.dev/developer-policy)).
  - A customised app message still shows the APP badge after the name. Only a third party
    ([Push Security, 2023-10-24](https://pushsecurity.com/blog/phishing-slack-persistence)) states this, so §10's live
    check must see it.
- **Icons.**
  - `icon_url` must be an image anyone on the internet can fetch. Slack's image proxy fetches and caches it
    ([robots](https://api.slack.com/robots)), and its caching period is undocumented.
  - An app has one icon for everyone ([apps.icon.set](https://docs.slack.dev/reference/methods/apps.icon.set)), and
    organisation apps here are shared by several people, so the app icon cannot be one person's face.
  - A custom workspace emoji is hosted by Slack and published nowhere else: square, under 128 KB
    ([custom emoji](https://slack.com/help/articles/206870177-Add-custom-emoji-and-aliases-to-your-workspace)).
  - Whether `icon_emoji` accepts a *custom* emoji is not documented. §10 checks it.
- **"Bot users cannot post to a direct message conversation between two users"**
  ([conversations.open](https://docs.slack.dev/reference/methods/conversations.open)).
  - With `chat:write.public` an app posts in any public channel without joining it.
  - In a private channel, or a channel shared with another organisation, it posts only once it is a member.
- **A notification shows a message's `text`, not its blocks** — `text` is "used as a fallback string to display in
  notifications" ([context block](https://docs.slack.dev/reference/block-kit/blocks/context-block)). A label shown
  only in a block is missing from the notification.
- **Resend's From is free-form**, `Name <address>` on a verified domain
  ([send email](https://resend.com/docs/api-reference/emails/send-email)).
- **Gmail does not document what it does with a From display name sent through the API.**
  - Reports say it rewrites only an address the account does not own and leaves the name as written
    ([2012](https://lee-phillips.org/gmailRewriting/)).
  - A From with no name goes out with no name ([gogcli#436](https://github.com/steipete/gogcli/issues/436), 2026-03).
  - Unconfirmed until §10.
- **No header that mail clients display marks a message as sent by an agent.** RFC 3834's
  `Auto-Submitted: auto-generated` "MUST NOT be used on manually generated messages", and it stops out-of-office
  replies ([RFC 3834](https://www.rfc-editor.org/rfc/rfc3834.html)), so it is not used here.
- **WhatsApp cannot change the sender's name per message.** These tools only draft a click-to-chat link that the
  person sends themselves (`packages/whatsapp/src/operations/draft.ts`). It is out of scope.

What these tools do today:
- **Slack:** the app requests user scopes only (`packages/slack/src/manifest.ts`). Sign-in refuses a reply that
  carries a bot token (`packages/slack/src/auth/authorize.ts`).
- **Gmail:** From is the bare address (`packages/gmail/src/operations/drafts.ts`). The approval binds the address but
  not a display name (`packages/gmail/src/domain/outbound.ts`).
- **Resend:** the caller supplies From on every send, and the approval binds all of it.
- **Core:** nothing records the person's name, and a channel may not add a safety setting of its own
  (`packages/core/src/config.ts`, the comment on `AccountConfig`).

## 3. The label

### L1 — One phrase, the same everywhere: `<name> (<word>)`

The **word** is one setting for the person, from L2's list, and the default is `agent`. The **name** comes from the
channel itself where it has one:
- Slack: the signed-in user's display name, or their real name when they have none, read with `users.info`;
- Gmail: the send-as display name of the From address;
- Resend: the name the caller put in From.

Where the channel has no name, a **name** setting in the core fills the gap. Nothing guesses a name: with neither, the
prepare is refused and says how to set it. A channel's own name beats the setting, so a Resend sender named for a
product ("Acme Billing") reads "Acme Billing (agent)". A name that already ends with ` (<word>)` is not labelled twice.

### L2 — The word list

The words are `agent`, `assistant`, `twin`, `minion`, `bot`, `fake` and `AI`, written exactly so. The list lives in
the core's code, and adding a word is a code change with its own review. With the word fixed, the phrase's only free
part is the name. It must fit each platform: 80 characters for a Slack `username`, and 100 for a Resend name. A
phrase that does not fit is refused at prepare, naming the limit, and is never cut short. The name may not contain
parentheses, `<>"@,;:\`, or any control, bidirectional or invisible character (the core's `isDangerous`).

### L3 — Who a message appears to come from

Every outgoing act has an **identity**, one of two:
- **`agent`:** labelled. In Slack that is the app's post (S4), or the labelled fallback (S3) where the app cannot post.
  In mail it is the labelled From.
- **`me`:** as the person, unlabelled, as these tools sent everything before this release.

The identity is settled at prepare, in this order. The first that applies wins:
1. **The message itself.** The person tells the agent, and the agent passes `as: "me"` or `as: "agent"` to the
   prepare. `as: "agent"` is always allowed.
2. **The most specific rule that matches** (L4).
3. **The default, `agent`.**

The preview's first line states the result in plain words. For `me` it reads: `Sent as you, with no label: it will
look as if you wrote it yourself`. The approval binds the identity with the rest of the content, so nothing can change
it between the preview and the send. An unlabelled message therefore always rests on the person's yes to a preview
that says it is unlabelled, whether the identity came from the message or from a rule.

### L4 — Rules

A rule names an account, and optionally a conversation and the kinds of act it covers, and gives an identity:

| Field | Meaning |
|---|---|
| `account` | an account name, e.g. `cue/slack` or `cue/gmail` |
| `conversation` | Slack: a channel or DM id (`C…`, `G…`, `D…`) or a person (`U…`, for DMs with them). Mail: an address or `@domain`, matching when every recipient matches |
| `kinds` | some of `post`, `reply`, `reaction`, `edit`, `file`, `send`; absent means all |
| `as` | `agent` or `me` |

- **Matching.** A rule with a conversation and kinds is more specific than one with only a conversation, which is
  more specific than one with only kinds, which is more specific than the bare account rule.
- **Ties.** Between rules equally specific, `agent` wins.
- **The account-wide switch** the owner asked for is the bare rule `{account, as: "me"}`: "switch the label off for
  this account".

### L5 — Settings, and who may change them

`agentLabel: { word?, name?, rules?: [...], slackIcons?: {...} }` sits at the top of `config.json` and is judged by
the core's `classifyChange`:

- **Confirmed before it applies** (a loosening): adding a rule with `as: "me"`, removing a rule with `as: "agent"`,
  changing the word, changing the name, changing a Slack icon (S4). Each of these could make a message unlabelled, or
  change how the label looks.
- **At once** (a tightening): adding an `agent` rule, or removing a `me` rule.
- Each confirmed change goes through the change flow (`GatedChange`) under the person's change policy. Its preview
  shows the phrase exactly as recipients will see it, or the identity each affected kind of message will now have. An
  agent cannot approve one under `confirm`.

**When an older release meets these keys.** Every config schema is a `looseObject`, so releases before this one read
the keys and ignore them. If one drops them when it writes, every message goes back to `agent` with the word `agent`,
which is a tightening. Older runtimes still send unlabelled, until `agentcomms update` reaches them (§11).

### L6 — The CLI and the MCP tool

One capability in the core: `agentcomms label` on the CLI, and `comms_label` as an MCP tool. Both run one operation,
`packages/core/src/operations/label.ts`, with a row in `capabilities.json`.
- **With no change**, it shows the word, the name, every rule, and each account's identity per kind, as recipients
  would see it. Reading needs nobody.
- **A change** sets the word or the name, adds or removes a rule, or sets or clears a Slack icon, and each goes
  through L5.

Each prepare tool on Slack, Gmail and Resend gains an optional `as` parameter, and its CLI command gains `--as`.

## 4. Slack

### S1 — The send app gets a bot user with posting scopes only, and the read app none

The `send` manifest adds a bot user and exactly four bot scopes:
- `chat:write`;
- `chat:write.customize`;
- `chat:write.public`;
- `reactions:write`.

It asks for no bot scope that reads or uploads. The `read` manifest is unchanged, and has no bot user.

Sign-in:
- **A `send` app's exchange** must return a bot token, `token_type` `bot`, with exactly those scopes. It is refused
  with anything more or less, and it is stored beside the user token in the core's secret store, under
  `slack/bot-token/<accountId>`.
- **A `read` app's exchange** still refuses any bot token. The read-mode guarantee stays as it was: on this machine,
  no stored token for a read workspace can post.

**This reverses D7's first bullet,** which said: "We never request `chat:write.customize`. Our messages go out as the
person, with their own name." D7 was written against an app choosing any name and avatar, so that the channel cannot
tell. Here no caller supplies the name or icon. The `username` is always L1's phrase, with a word from L2's list, and
Slack adds its APP badge, so the customisation discloses the agent instead of hiding one. D7's reading rules are
unchanged: attribution comes from `bot_id` and `user`, and a `username` is shown only as a display name the app
chose. D7 gets a note pointing here.

**An existing `send` workspace keeps working without a new sign-in.** Until the person updates their app from the new
manifest and signs in again, an `agent` message takes the labelled fallback (S3), and `doctor` says how to switch to
the app's identity. Nothing is silently unlabelled.

### S2 — The route is chosen before the preview, and never changed after it

For identity `agent`, prepare decides who posts:
- **The app posts** in a public channel not shared with another organisation, and in a private or shared channel
  whose members include the app's bot user. Membership is checked with the person's token
  (`conversations.members`, paged until the bot is found, at most ten pages).
- **The person posts, labelled (S3)** in a direct message, a group direct message, the person's own DM, a channel the
  app is not in, any channel whose membership could not be settled, and for every file.

The route is part of what the approval binds. At send, a refusal such as `not_in_channel`, from an app removed
meanwhile, ends that send as refused. Nothing is posted under the other identity: posting it that way would be a
different message, so it needs a new preview and a new yes.

Identity `me` posts with the person's token, as before this release.

### S3 — The labelled fallback

When the person's token posts an `agent` message, the label is in the message, in both places a reader meets it, and
the same in both:
- `text`, which notifications show: `<name> (<word>): <message>`;
- `blocks`: the message's one section, whose text is that same `<name> (<word>): <message>`.

The two halves must agree. Reading compares the rendered blocks with `text` and reports a difference as `mismatch`
(Slack design, D4), the signal of a message that says one thing in the room and another in its notification. A
context block `Sent by <name> (<word>)` above the section, as this section first said, made every labelled post read
back as a mismatch, so every agent reading it would take our own label for a deception (amended 2026-10-15).

A file post carries the same prefix in its `initial_comment`; one with no words is labelled `Sent by <name> (<word>)`. An edit sends `text` only, because Slack shows
"(edited)" only on a text update (the edit design, §2), so the prefix goes in its new text.

### S4 — The app's message: the phrase, the icon, and nothing a caller supplies

An app post is `chat.postMessage` with the bot token, with `username` set to L1's phrase, and an icon chosen in this
order:

1. **`icon_emoji`: the person's own agent emoji,** when one is set for this account (`agentLabel.slackIcons`).
   - The Slack package makes it: `agent-slack icon make <workspace>` on the CLI, `slack_icon_make` as an MCP tool. It
     reads the person's Slack photo (`profile.image_512`) with their token, puts a small robot badge on the lower right
     corner, and writes a square PNG under 128 KB to the data directory. It changes nothing in Slack or in the
     configuration, so it asks nobody.
   - It prints the workspace's emoji page, `https://<team>.slack.com/customize/emoji`, and a suggested name such as
     `:criss-agent:`.
   - The person uploads it there once. Then `agentcomms label icon <account> :criss-agent:` (or `comms_label`)
     records the name in `slackIcons`, through L5.
   - Nothing is published outside Slack. The image is hosted by Slack as a workspace emoji, as any other emoji is.
2. **`icon_url`: the person's plain Slack photo** (`profile.image_192`), until an emoji is set. `doctor` says how to
   make one.

Nobody can pass a `username`, an icon or blocks to a tool. The phrase and the icon come from the account's own
profile and settings, read at prepare, and the approval binds them with the rest of the payload.

*The rejected alternative* was to host the composed image at a public URL (`icon_url`): an R2 bucket, a public
GitHub repository, or a Slack public file link. Each publishes the person's photo on the open internet, and the Slack
link depends on an admin setting.

### S5 — Edits and deletes use the identity that posted

`chat.update` and `chat.delete` act only on the caller's own messages, so an edit goes out with the token that
posted.
- **An app message** may be edited or deleted only when **this account's own send record** holds its channel and
  `ts`. The bot token belongs to the workspace, and others who installed the same organisation app hold it too.
  Slack cannot tell one person's agent from another's, so the local record decides. An app message this account did
  not post is refused before the preview.
- **A message posted as the person**, typed by hand or posted through the fallback, is edited with the user token.
  When the edit's identity (L3) is `agent`, its new text carries S3's prefix, because an agent wrote the change.

### S6 — Reactions

A reaction's identity comes from L3 like any other act's, with kind `reaction`:
- **`agent`:** the app reacts where S2 says it can post; elsewhere the person reacts.
- **`me`:** the person reacts.

When the person reacts for an `agent` reaction, the reaction is unlabelled, because a reaction has no text. Its
preview says so in plain words.

### S7 — The preview says who will appear to post

The first line names the identity exactly:
- an app post: `Cristian Moldovan (agent) · posted by the app <the app's name in Slack>`;
- the labelled fallback: `Cristian Moldovan · labelled "Cristian Moldovan (agent):" at the start of the message ·
  <the reason, e.g. the app cannot post in a direct message between two people>`;
- `me`: `Sent as you, with no label: it will look as if you wrote it yourself` (L3).

## 5. Gmail

### G1 — A draft is labelled when it is written

For identity `agent`, `draft create`, `draft reply` and `draft update` write From as `"<name> (<word>)" <address>`,
with the name from L1. For `me`, From stays as it is today. The composer's own address formatter encodes the display
name. The kind is `send` for a new message and `reply` for a reply.

### G2 — A draft whose From does not match its identity is rewritten at prepare, header only

A draft can reach `send prepare` with a From that does not fit its identity: one written in Gmail, one from before
the upgrade, or one whose identity a rule or `as` changed. Prepare then rewrites only its From header, and replaces
the draft with the result. Every other byte of the raw message is unchanged, and a test proves it on plain, HTML and
attachment drafts. The preview shows the new From and says it was rewritten. A From whose address the inbox may not
send as is refused exactly as now.

### G3 — The approval binds the whole From

The digest stores only the From address (`outbound.ts`), so a name could change between preview and send unnoticed.
It now binds the From header as the preview shows it, and `send.execute` refuses a draft whose From differs.
`send.execute` is still the only path to Gmail's send endpoints.

## 6. Resend

R1 — For identity `agent`, prepare composes From from L1: the caller's name, or the core's name setting when the
caller gave only an address, followed by ` (<word>)`. For `me`, From is as the caller gave it. The preview shows it,
and the approval already binds the whole From. `executeSend` is unchanged, and still the only path to Resend's send
endpoint.

## 7. What does not change

- Nothing is sent without a person's yes to its exact content. The identity and the label are part of that content,
  not something added after it.
- Anything a sender controls still passes through the sanitiser and the envelope.
- Reading is unchanged. A Slack message posted by this account's app reads back with `bot_id` set, labelled as an
  app's, with its `username` shown as a display name the app chose (D7).
- The events daemon sends nothing to recipients, so it has nothing to label.
- No `Auto-Submitted` or custom header is added (§2).

## 8. Out of scope

- **WhatsApp:** these tools draft a link, and the person presses send.
- **A footer in mail bodies.** It is not needed if Gmail keeps the From name (§10). If the live check shows Gmail
  does not keep it, this document is amended first and a body footer added before release.
- **An app identity for files** (S2).
- **The behaviour rules and the sending-without-asking design** (§1).

## 9. Tests

Every test runs against the fakes: Slack's loopback (`packages/slack/test/support/fake-slack.ts`), Gmail's transport
(`packages/gmail/test`) and Resend's loopback. Nothing reaches a real service.

- **Slack's fake learns:**
  - bot tokens;
  - `username`, `icon_emoji` and `icon_url`;
  - `not_in_channel` for a private channel the bot is not in;
  - the refusal of a bot post into a DM;
  - membership paging.
- **Tests cover:**
  - L3's order: `as` over rule over default;
  - L4's specificity and its tie rule;
  - L5's classification of every kind of change;
  - L2's list and the name's limits;
  - every route of S2, that the route is bound, and that no fallback follows a refused app post;
  - S3's label in both `text` and `blocks`;
  - S4's icon order and the emoji maker's output (square PNG, under 128 KB, with the badge);
  - S5's own-record rule;
  - S6;
  - sign-in refusing a bot token with the wrong scopes, and a read app refusing any;
  - G2's byte-for-byte rewrite, and G3's binding;
  - R1's composition.
- **The parity drive** runs `label` on both sides.

## 10. Live checks, each only with the owner's yes to the exact preview

1. The owner updates their `send` Slack app from the new manifest and signs in again.
2. They make their agent emoji with `agent-slack icon make`, upload it, and record its name with
   `agentcomms label icon`.
3. An app post in a test channel: the phrase, the emoji icon and the APP badge appear as S4 says. **This settles
   whether `icon_emoji` takes a custom emoji.** If it does not, S4 falls back to the plain photo, and this document
   is amended.
4. A labelled fallback post in the owner's own DM, and an `as: "me"` post with its preview.
5. A Gmail send from an inbox the owner allows to send, to their own address: the From name arrives as G1 writes it.

Resend gets no live check: no real key is used while developing.

## 11. Release

A minor release: a new capability, and a change in what recipients see by default.

The changelog's **Upgrading** section says plainly:
- after updating, every message an agent sends is labelled unless the person chooses otherwise;
- to post as the app, a Slack send app must be updated from the new manifest and signed in again; until then its
  messages go out as the person, labelled;
- older runtimes still running in other clients send unlabelled until `agentcomms update` reaches them.
