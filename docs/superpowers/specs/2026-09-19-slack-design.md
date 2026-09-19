# Slack for agent-communications — design

**Status:** specified, not started. Gmail v0.1.0 ships first.
**Research:** [`docs/research/2026-09-19-slack-platform.md`](../../research/2026-09-19-slack-platform.md) — every
platform claim below is sourced there, and where the research says "not verified" this spec treats it as unknown
rather than true.

## 1. What this is

Slack as a second platform beside Gmail, reusing `@cloudpixel/comms-core` unchanged where it already fits and
extending it where a mail-shaped assumption does not survive contact with a chat platform.

The same promise: **an agent can read, search, analyse and draft, and cannot post without the person's approval.**

The same shape: `@cloudpixel/slack` (CLI `agent-slack`, library, MCP factory), `@cloudpixel/slack-mcp` (thin),
skills that teach an agent how to use it and where to stop.

## 2. The one big difference, and what to do with it

Gmail's central difficulty is that the permission which lets an agent write a draft also lets it send. "May draft,
may not send" cannot be expressed as a Google scope, so it is expressed in our code, and the honest statement of
what that buys is narrow.

**Slack does not have that problem.** Its read and write scopes are disjoint: a token holding only `*:history`
and `*:read` cannot call `chat.postMessage` at all, and the consent screen says so. So Slack can offer something
Gmail cannot — an installation where the promise is enforced by Slack rather than by us, and where a bug in our
code cannot post.

That produces the central design decision:

### D1 — Two install modes, read-only by default

| Mode | Scopes | Who enforces "cannot post" | What the agent can do |
|---|---|---|---|
| **`read`** (default) | history, read, `users:read`, `files:read`, `search:read` | **Slack.** The token physically cannot post | Read, search, analyse, and compose drafts held locally. To send, the person copies from the preview, or re-installs in `send` mode |
| **`send`** | the above plus `chat:write` | **Us**, exactly as for Gmail | Everything, with the approval gate between a draft and `chat.postMessage` |

`agent-slack workspace add --mode read` is the default and what the setup skill recommends. Moving a workspace
from `read` to `send` is a **re-installation** — a new OAuth grant a person must approve in Slack's own UI, which
is a better gate than anything we could write, and it is also a config loosening in the sense
`comms-core/config.ts` already understands, so it needs the typed challenge too.

**`send` mode is not a lesser product with a worse guarantee.** It is the same guarantee Gmail gives, and the
documentation must say which is which rather than implying one number covers both.

### D2 — `chat:write` is not the only way to post, so the gate has four doors

The research enumerates four write paths that do not need `chat:write`:

| Path | Scope | What it does | Our decision |
|---|---|---|---|
| `files.completeUploadExternal` with `channels` | `files:write` | Publishes a file into a channel with an `initial_comment` — a visible message | **Behind the gate.** A file share is a post |
| `reactions.add` | `reactions:write` | A public, notifying act attributed to the person | **Behind the gate**, at a lower ceremony (see D6) |
| Incoming webhooks | `incoming-webhook` | Posts with no `chat:write` anywhere | **Never requested.** Not in any manifest we ship |
| `conversations.mark` | `im:write` | Mutates the person's read state | **Never requested** in v1. Marking things read is not worth a write scope |

So `send` mode requests `chat:write` and `files:write` only, and the transport guard — the Gmail one, which
refuses any request to a path ending in `/send` without a permit — becomes a **method allowlist**: any Slack
method in a `WRITES` set requires an open permit naming the approval it belongs to. The set is written down once
and a test asserts every method the transport can reach is classified.

### D3 — A draft is a local artefact

Slack has no server-side draft. The client's `drafts.*` endpoints are undocumented, need browser-session
credentials, and are not supported.

So a Slack draft lives in our state directory: `<state>/slack/drafts/<draftId>.json`, holding the composed
payload exactly as it would be posted — `text`, `blocks`, `thread_ts`, `unfurl_links: false`, attachments by
local path — plus where it is going and when it was written. The approval digest covers that payload, so
"approve this" and "post this" are the same bytes.

This is better than Gmail in one way and worse in another, and both should be said plainly in the skill:

- **Better:** nothing exists in Slack until the person says yes. A Gmail draft is already in the mailbox, visible
  to anything else with access to that account.
- **Worse:** the person cannot open it in Slack and finish it themselves. The "send it from the app instead"
  escape hatch that `never` mode relies on for Gmail does not exist, so for Slack the equivalent is "here is the
  text; paste it yourself", and the preview is written to be pasteable.

## 3. Reading, and the ways Slack is not email

### D4 — The preview and the post are one payload, always

Slack's `text` and `blocks` can say different things: `blocks` is what a person sees, `text` is the notification
fallback and what a naive API reader takes first. That divergence is hazardous in both directions — a message
that reads one way to the agent and another to the human.

So, exactly as the Gmail composer generates the HTML part from the author's plain text:

- **We generate `blocks` from the author's text.** A caller supplies text; the composer renders the blocks. No
  tool accepts caller-supplied `blocks`, for the same reason no Gmail tool accepts caller-supplied HTML.
- **`text` is derived from the same source**, so the notification and the message cannot disagree.
- The preview renders **from the payload that will be posted**, not from the input that produced it.

When *reading*, a message whose `text` and rendered `blocks` differ beyond whitespace is **reported as a
mismatch**, the same way the Gmail body pipeline reports a plain/HTML mismatch. That is a signal, not an error.

### D5 — Everything the Gmail sanitiser does, minus HTML, plus three Slack-shaped things

`comms-core`'s sanitiser is provider-neutral in the parts that matter: invisible-character stripping, the
untrusted-content envelope with its per-call boundary, chat-template token neutralisation, link analysis,
punycode and lookalike-domain detection. All of it applies.

Three additions:

1. **Unfurls are third-party content inside somebody else's message.** An unfurl attaches Block Kit content that
   the message author never wrote. When reading, unfurled content is **labelled as unfurled** and attributed to
   the URL it came from, never merged into the author's text.
2. **`unfurl_links: false` and `unfurl_media: false` on everything we post.** They default to `true`. Slack's own
   security guidance says to disable them when an LLM may have generated the URL, and that is exactly our case.
3. **Invisible characters in `mrkdwn`.** Slack is not documented to normalise them. We do, on the way in, and
   count what we removed — the existing `stripInvisible` does this already.

### D6 — Reactions are a post, with less ceremony

Adding a reaction notifies a person and is attributed to the user. It is not a message, and treating it with the
full preview-and-approve flow would make the feature useless and train people to approve without reading.

So: reactions are behind the gate but at a **lower ceremony** — under `chat` policy an agent may add a reaction
after saying which emoji and where, in one line, and waiting for a yes. Under `confirm` they need the same typed
approval as a message. Under `read` mode the scope is absent and the question does not arise.

## 4. Identity, and who said what

### D7 — Attribution comes from `bot_id` and `user`, never from `username`

With `chat:write.customize` an app sets any display name and avatar it likes. A human skimming a channel sees
the impersonation; the payload tells the truth to anything that looks.

- We never request `chat:write.customize`. Our messages go out as the person, with their own name.
- When reading, the attribution we show is derived from `bot_id`/`bot_profile` and `user`, and an app-posted
  message is labelled as one. A `username` override is shown *as well*, marked as a display name the app chose —
  because that is what the human in the channel saw, and the difference between the two is itself worth reporting.
- External participants in Slack Connect channels are identified from `is_stranger` and `team_id` together, as
  the research requires; `username` is never a key.

## 5. Installation, because the platform forces our hand

### D8 — Bring your own Slack app

A commercially distributed non-Marketplace app gets `conversations.history` at one request per minute and fifteen
messages per request, which is unusable. Marketplace approval restores Tier 3 but forbids Socket Mode and now
requires ten installs before review. **Internal customer-built apps are exempt** and may use Socket Mode.

So we do not distribute a Slack app. We ship a **manifest** and the setup skill walks a person through creating
their own app from it — which is three screens and a paste. The manifest exists in two forms, `read` and `send`,
and the skill shows which scopes each asks for and what each one permits.

Consequences to document rather than hide:

- A corporate workspace may require admin approval to install any app. The setup skill says so up front, because
  finding out at step nine is worse.
- Slack has twice announced and twice silently withdrawn a date for sweeping existing installs into the rate cap.
  The doctor command checks the observed rate-limit tier and says if it has changed.

### D9 — Socket Mode for events, polling as the fallback

Socket Mode answers the local-agent question: an `xapp-` token with `connections:write` opens an outbound
WebSocket, so an agent on a laptop behind NAT receives events with no public URL.

v1 does not need events — reading is on demand. But the design reserves it, because "what needs my attention"
has no API and the alternative is polling, which is expensive. The research flags one thing to test before
building on it: whether user-perspective subscriptions deliver the person's own DMs over Socket Mode. Until
someone has verified that end to end, no feature depends on it.

## 6. What `comms-core` needs

Most of it already fits. The parts that do not:

| Piece | Today | Change |
|---|---|---|
| `CanonicalMessage` / `messageDigest` | Mail-shaped: from, to, cc, bcc, subject, references | Add a `channel` variant: workspace, channel id, thread ts, the exact payload hash. The digest function stays; the canonical form becomes a union |
| `ApprovalStore` | Already provider-neutral | Unchanged. `draftId` becomes "the local draft id", which it already is in spirit |
| `SendLedger`, caps | Per inbox id | Per *account* id, renamed. The concept is identical |
| `TaintStore` | Addresses and domains | Add Slack user ids and channel ids. An address seen in a message we read is the same idea |
| Attachment jail | Unchanged | Unchanged |
| `renderMessagePreview` | Recipients, subject, body | A second renderer for channel-shaped previews: workspace, channel, thread, who will be notified (`@here`, `@channel`, direct mentions), the body fenced, and the notification count — because "this will notify 240 people" is the Slack equivalent of a recipient list |
| Config | `inboxes` | `accounts`, with a `provider` discriminator. A migration, done once, with the same loosening classification |

**The one genuinely new idea:** a Slack preview must say **who will be notified**, resolved and counted. `@channel`
in a 400-person channel is the blast radius that has no email equivalent, and it belongs in the preview beside the
body, in the same position the recipient list occupies for mail.

## 7. Phases

| Phase | Branch | What |
|---|---|---|
| S1 | `feat/slack-core` | `comms-core` changes: the canonical-message union, `accounts` config with migration, the channel preview renderer, taint for ids |
| S2 | `feat/slack-auth` | `@cloudpixel/slack`: the two manifests, OAuth with token rotation, `workspace add/list/show/remove/reauth`, `doctor`, the transport with its method allowlist |
| S3 | `feat/slack-read` | Conversations, history, threads, search, users, files; the body pipeline with unfurl labelling and text/blocks reconciliation |
| S4 | `feat/slack-compose` | Local drafts, the block composer, the preview with its notification count |
| S5 | `feat/slack-send` | The gate: prepare, approve, post; the four guarded doors; reactions at lower ceremony |
| S6 | `feat/slack-skills` | The skills, sharing the contract; the drift test extended |
| S7 | `release/slack` | Packaging, manifests, release |

Each phase follows the Gmail pattern: a branch, tests, a review round, a squash-merge.

## 8. Open questions for the author

1. **Is `read` mode the default, or the only mode in v1?** Shipping read-only first would mean the first Slack
   release has a guarantee we cannot break. My recommendation: ship both, default to `read`, and make `send`
   require the re-install — the gate is stronger that way than any flag.
2. **Which workspaces?** The Gmail build learned that multi-account is easier designed in than added. Same
   assumption here unless you say otherwise.
3. **Reactions in v1?** They are the smallest useful write and the best way to test the gate on something
   low-stakes. My recommendation: yes, at lower ceremony.
4. **Socket Mode in v1?** My recommendation: no. Reserve it, verify the DM question first.

## 9. What this design does not protect against

The same list as Gmail's, plus:

- **An agent with a shell** can read the token and call Slack directly. Unchanged, and the `read` install is the
  real mitigation: there is nothing to steal that can post.
- **A message edited after you read it.** Slack messages can be edited in place; a summary is of what was there
  when it was read. The timestamp we cite is the handle to check against.
- **Retraction is not a gate.** `chat.update` and `chat.delete` exist, but the edit window is a workspace setting
  an owner controls and deletion may be restricted to admins. The notification has already fired regardless.
- **Unfurled content** is written by whoever controls the URL, not by the message author.
