# Slack for agent-communications — design

**Status:** specified and decided, not started. Gmail v0.1.0 is published (`@agentcomms/gmail`, 19 September 2026),
which was the condition the author set for starting this. The decisions in §8 exist so implementation can begin
without another round of questions; §10 folds in what the Gmail release's audits found, most of which applies
here with the details changed.
**Research:** [`docs/research/2026-09-19-slack-platform.md`](../../research/2026-09-19-slack-platform.md) — every
platform claim below is sourced there, and where the research says "not verified" this spec treats it as unknown
rather than true.

## 1. What this is

Slack as a second platform beside Gmail, reusing `@agentcomms/core` unchanged where it already fits and
extending it where a mail-shaped assumption does not survive contact with a chat platform.

The same promise: **an agent can read, search, analyse and draft, and cannot post without the person's approval.**

The same shape: `@agentcomms/slack` (CLI `agent-slack`, library, MCP factory), `@agentcomms/slack-mcp` (thin),
skills that teach an agent how to use it and where to stop.

## 2. The one big difference, and what to do with it

Gmail's central difficulty is that the permission which lets an agent write a draft also lets it send. "May draft,
may not send" cannot be expressed as a Google scope, so it is expressed in our code, and the honest statement of
what that buys is narrow.

**Slack does not have that problem.** Its read and write scopes are disjoint: a token holding only `*:history`
and `*:read` cannot call `chat.postMessage` at all, and the consent screen says so. So Slack can offer something
Gmail cannot — an installation where the promise is enforced by Slack rather than by us, and where a bug in our
code cannot post.

That guarantee is about *this package's* token, not about the machine. A second Slack MCP server holding a write
token for the same workspace lets an agent post without going near ours, and the Gmail release found exactly that
shape on the author's own machine. §10 says what `doctor` does about it; the documentation must never state the
`read` guarantee more broadly than "this package cannot post".

That produces the central design decision:

### D1 — Two install modes, read-only by default

| Mode | Scopes | Who enforces "cannot post" | What the agent can do |
|---|---|---|---|
| **`read`** (default) | history, read, `users:read`, `files:read`, `search:read` | **Slack.** The token physically cannot post | Read, search, analyse, and compose drafts held locally. To send, the person copies from the preview, or re-installs in `send` mode |
| **`send`** | the above plus `chat:write`, `files:write`, `reactions:write` | **Us**, exactly as for Gmail | Everything, with the approval gate between a draft and `chat.postMessage` |

`agent-slack workspace add --mode read` is the default and what the setup skill recommends. Moving a workspace
from `read` to `send` is a **re-installation** — a new OAuth grant a person must approve in Slack's own UI, which
is a better gate than anything we could write, and it is also a config loosening in the sense
`core/config.ts` already understands, so it needs the typed challenge too.

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
- **The preview shows what the recipient's client will show — decoded, and deliberately not neutralised.** The
  Gmail release's most serious defect was here: the approver was shown `=?UTF-8?Q?Caf=C3=A9_plan?=` for a subject the
  recipient read as `Café plan`, because nothing decoded what the composer itself had encoded. A person cannot
  approve what they cannot read. For Slack the same rule means `<@U123>` is shown as the name it will render as and
  `&amp;` as `&`. And it is not neutralised, because this is the person's own outgoing text and defusing a
  `Human:` in it would make the preview differ from the post again — the same bug wearing a safety hat. The
  terminal is protected by `escapeForDisplay` instead, and the digest is taken over the decoded form so the
  approval binds what was actually read.

When *reading*, a message whose `text` and rendered `blocks` differ beyond whitespace is **reported as a
mismatch**, the same way the Gmail body pipeline reports a plain/HTML mismatch. That is a signal, not an error.

### D5 — Everything the Gmail sanitiser does, minus HTML, plus five Slack-shaped things

The core package's sanitiser is provider-neutral in the parts that matter: invisible-character stripping, the
untrusted-content envelope with its per-call boundary, chat-template token neutralisation, link analysis,
punycode and lookalike-domain detection. All of it applies.

Five additions:

1. **Unfurls are third-party content inside somebody else's message.** An unfurl attaches Block Kit content that
   the message author never wrote. When reading, unfurled content is **labelled as unfurled** and attributed to
   the URL it came from, never merged into the author's text.
2. **`unfurl_links: false` and `unfurl_media: false` on everything we post.** They default to `true`. Slack's own
   security guidance says to disable them when an LLM may have generated the URL, and that is exactly our case.
3. **Invisible characters in `mrkdwn`.** Slack is not documented to normalise them. We do, on the way in, and
   count what we removed. Since the Gmail release this happens *inside* `neutralise` rather than beside it, so a
   caller cannot run the two in the wrong order — the Gmail build found `<​/untrusted-email-content>` passing a
   pattern that `\s` could not see through, on every path that neutralised a header without stripping first.
4. **Decode Slack's escaping before neutralising, never after.** Slack escapes `&`, `<` and `>` as `&amp;`,
   `&lt;` and `&gt;` in message text, and encodes mentions and links as `<@U123>`, `<#C123|name>` and
   `<https://url|label>`. A `neutralise` run on the escaped form sees nothing to defuse in
   `&lt;/untrusted-email-content&gt;`, and the decode that follows hands a live closing tag to whatever reads it.
   This is exactly the RFC 2047 bug the Gmail audit found in subject lines, in a different encoding, and the fix is
   the same order: **decode, then cut, then neutralise.** Cutting before decoding can split an entity or a
   `<…|…>` span in half.
5. **Every sender-controlled field, not only the message text.** The Gmail audit's worst cluster was three read
   paths — attachments, contacts, follow-ups — that returned a subject, a filename or a display name as a bare
   string beside a carefully enveloped body, with no `neutralise` at all. Slack has more such fields than mail
   does, and several are editable by anyone in the workspace at any time: display name, real name, **status text
   and status emoji**, channel name and **topic and purpose**, file names, bot names, and the label half of a
   `<url|label>` link. Each is neutralised at the one place its values funnel through, not at each call site where
   the next field added would miss it. A test feeds a hostile value through every tool that returns one — the
   Gmail suite was green precisely because that test did not exist for the three paths that were wrong.

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
their own app from it — three screens and one paste. The manifest exists in two forms, `read` and `send`, and the
skill shows which scopes each asks for and what each one permits.

**The paste is the app's Client ID, which is not a secret, and that is the whole of it.** The token arrives
through a real OAuth flow: the manifests opt into **PKCE**, which lets the authorisation redirect land on
`http://127.0.0.1:<port>/` — "Redirects to `localhost` … are treated as desktop redirects if the app has opted
into PKCE" — and the exchange then carries no `client_secret` at all.

> **Corrected 2026-09-22, before S2 was written.** This section previously implied the person pastes a *token*,
> because the research said a redirect URI "must be HTTPS" and that was read as ruling out a local listener. It
> does not: it is true of the confidential-client flow and false for PKCE. The design review caught it while S2
> was still a plan. A token paste would have been a worse install — the token on a web page, through the
> clipboard — and would have put a client secret on disk for the rotation exchange. Neither is needed.
> See research §1.4a.

Consequences to document rather than hide:

- A corporate workspace may require admin approval to install any app. The setup skill says so up front, because
  finding out at step nine is worse.
- Slack has twice announced and twice silently withdrawn a date for sweeping existing installs into the rate cap.
  `doctor` reports the tier as **expected versus observed**: expected Tier 3, because an internal customer-built
  app is exempt, and observed from evidence ordinary reads have already produced — a 429 with its `Retry-After`,
  or a page that came back smaller than the `limit` asked for. It does **not** probe for it. Slack publishes no
  remaining/limit headers and states burst tolerance deliberately loosely, so the only way to observe the cap is
  to spend the budget being measured, and a diagnostic that degrades the thing it diagnoses is worse than one
  that says "not yet observed". The evidence is collected by the transport from S3 onwards.

### D9 — Socket Mode for events, polling as the fallback

Socket Mode answers the local-agent question: an `xapp-` token with `connections:write` opens an outbound
WebSocket, so an agent on a laptop behind NAT receives events with no public URL.

v1 does not need events — reading is on demand. But the design reserves it, because "what needs my attention"
has no API and the alternative is polling, which is expensive. The research flags one thing to test before
building on it: whether user-perspective subscriptions deliver the person's own DMs over Socket Mode. Until
someone has verified that end to end, no feature depends on it.

## 6. What `@agentcomms/core` needs

Most of it already fits. The parts that do not:

| Piece | Today | Change |
|---|---|---|
| `CanonicalMessage` / `messageDigest` | Mail-shaped: from, to, cc, bcc, subject, references | Add a `channel` variant: workspace, channel id, thread ts, the exact payload hash. The digest function stays; the canonical form becomes a union |
| `ApprovalStore` | Already provider-neutral | Unchanged. `draftId` becomes "the local draft id", which it already is in spirit |
| `SendLedger`, caps | Per inbox id | Per *account* id, renamed. The concept is identical |
| `TaintStore` | Addresses and domains | Add Slack user ids and channel ids. An address seen in a message we read is the same idea |
| Attachment jail | Unchanged | Unchanged |
| `renderMessagePreview` | Recipients, subject, body | A second renderer for channel-shaped previews: workspace, channel, thread, who will be notified (`@here`, `@channel`, direct mentions), the body fenced, and the notification count — because "this will notify 240 people" is the Slack equivalent of a recipient list |
| Config | `inboxes` | `accounts` added beside `inboxes`, not replacing it — see the note below. `connectedAccounts()` returns one list across both |

**The one genuinely new idea:** a Slack preview must say **who will be notified**, resolved and counted. `@channel`
in a 400-person channel is the blast radius that has no email equivalent, and it belongs in the preview beside the
body, in the same position the recipient list occupies for mail.

### Where this diverges: the config is not renamed (decided during S1)

The table above originally called for `inboxes` to *become* `accounts`, as a one-off migration. It does not, and the
reason is a constraint the spec did not account for.

`config.ts` states its own invariant: within `version: 1` every change is additive, because an MCP server started
last week and a CLI installed today read and write the same file, and a reader that discarded what it did not
understand would silently undo the other's settings. Moving every mailbox out of `inboxes` is the opposite of
additive — to the already-released 0.1.2 it reads as a config with no mailboxes in it, and 0.1.2 is in the field.

Bumping to `version: 2` was the alternative. It fails louder rather than quieter — 0.1.2 refuses an unknown version
with a `CONFIG` error — but it still stops a running server dead the moment someone installs the new release.

So: `accounts` is a new key holding non-mail accounts, `inboxes` is untouched, and both share one alias namespace
that the schema enforces. This was checked against the published 0.1.2 rather than assumed: a config carrying an
unknown `accounts` key parses and round-trips through it intact, because the schema is a `looseObject`.

What the rename was *for* — one list of everything connected, whatever the platform — was never really a question
about the file. `connectedAccounts(config)` answers it, sorted by alias so which map an entry came from is not
visible to whoever reads the list. Callers that genuinely care about the difference read the map they mean.

The cost is honest: two maps, and a `SendLedger` keyed by two id shapes rather than a uniform `account id`. The
distinct `acc_` / `ibx_` prefixes mean an id alone still says which it is.

## 7. Phases

| Phase | Branch | What |
|---|---|---|
| S1 | `feat/slack-core` | `@agentcomms/core` changes: the canonical-message union, the additive `accounts` config, the channel preview renderer, taint for ids |
| S2 | `feat/slack-auth` | `@agentcomms/slack`: the two manifests, **PKCE loopback OAuth** (no client secret) with token rotation, scope validation before anything is stored, `workspace add/list/show/remove/reauth`, `doctor`, the CLI entry point, the transport with its method allowlist and Slack-origin check |
| S3 | `feat/slack-read` | Conversations, history, threads, search, users, files; the body pipeline with unfurl labelling and text/blocks reconciliation |
| S4 | `feat/slack-compose` | Local drafts, the block composer, the preview with its notification count |
| S5 | `feat/slack-send` | The gate: prepare, approve, post; the four guarded doors; reactions at lower ceremony |
| S6 | `feat/slack-skills` | The skills, sharing the contract; the drift test extended; and **an audit of every skill document against the code it describes** before merge (§10) |
| S7 | `release/slack` | Packaging and manifests, the package README and the generated CLI reference page, then the release through `scripts/release.mjs` and the repo's `release` skill — from a person's machine, not CI (§10) |

> **S2 landed 2026-09-22.** Three things about it are worth carrying forward.
>
> **The port is chosen before the sign-in, not by the OS.** Slack stores redirect URLs on the app and matches
> them exactly, so `manifest --port` and `workspace add --port` must be the same number, and the manifest help
> prints the command that uses it. This is the one place the package deliberately diverges from Gmail, which
> takes whatever port it is handed.
>
> **A reauth stages the new credential under a new account id** rather than overwriting the old reference. The
> mode can change across a reauth, so an overwrite would open a window where the configuration says `read` while
> the credential behind it can post. The Gmail package overwrites, and has the same window; that is not fixed
> here.
>
> **Three things are still unverified against a real workspace**, and every one of them is a guess that reads
> like a fact until somebody signs in once: whether PKCE is opted into through the manifest or only through the
> app settings page; whether the exchange endpoint is `oauth.v2.access` or `oauth.v2.user.access`; and whether
> Slack accepts `127.0.0.1` as well as `localhost`. The code takes the documented answer in each case and says so
> at the point it does. A single real sign-in settles all three, and S3 cannot honestly start without it.
>
> `docs/reference/cli.md` is generated from `packages/gmail` only. Extending the generator to a second CLI is
> S7's, with the packaging — a reference page that tells people to install an unpublished package would be worse
> than one that does not mention it.
>
> **Three things the S2 review raised and S2 deliberately did not do.**
>
> *Wiring `accessTokenFor` into a transport* is S3's, because S3 is where the transport is. The rotation logic
> ships now because the credential shape it rotates ships now, and designing one a phase after the other is how
> you discover the shape is wrong.
>
> *Scanning client configurations for other Slack MCP servers* needs an MCP server to scan for, which arrives
> with the MCP surface. Until then `doctor` reports that check as not performed rather than as clear.
>
> *A durable transaction journal across the secret store and the config* was proposed for the window between
> writing a credential and pointing at it. Declined: the window is now closed by a compare-and-swap inside the
> config lock, the credential written into a failed attempt is deleted, and the one remaining leak — a keychain
> that refuses to delete a superseded token — expires on its own within thirty days. A journal would add a
> third durable thing to keep consistent with the other two, to shorten a bounded leak nobody has observed.

Each phase follows the Gmail pattern: a branch, tests, a review round, a squash-merge. One change to that pattern,
learned the hard way: **reviewers and auditors that are agents run in their own git worktree.** They share the
working tree otherwise, and during the Gmail release one of them ran `git checkout` and moved the branch under a
release that was in progress.

## 8. Decisions, and the unknowns designed around

The four questions the first draft left open are decided below. Each is reversible — a decision is not a claim
that no other answer was defensible, only that shipping needs one and waiting for certainty costs more than being
wrong here would.

### D10 — v1 ships both modes, defaulting to `read`

Read-only alone would be a smaller, honest first release, and the argument for it is real: the guarantee would be
Slack's rather than ours, and nothing we wrote could break it.

Against: a package that can only read is not the thing anybody asked for, and the send gate is the part that took
the longest to get right for Gmail. Shipping it unexercised, later, is worse than shipping it with everything we
learned still fresh. And the two modes are not equally risky — `read` is the default, and moving a workspace to
`send` is a re-installation the person approves in Slack's own UI, which is a stronger gate than any flag we could
offer.

So: both, `read` default, and the documentation states which guarantee each mode carries without implying one
number covers both.

### D11 — multi-workspace from the start

The Gmail build learned this the expensive way: an alias-to-account map added later touches every operation, every
tool schema and every skill. The config carries both maps keyed by alias, with `connectedAccounts()` over the pair
(§6), so the cost now is a lookup and the cost later is a migration.

### D12 — reactions in v1, at lower ceremony

They are the smallest useful write, and that is exactly why they belong in the first release: the gate gets
exercised on something where a mistake costs embarrassment rather than money, before anybody trusts it with a
message. Under `chat`, naming the emoji and the message and waiting for a yes is proportionate. Under `confirm`,
the same typed approval as a message — because a reaction from the user's account is still the user speaking.

### D14 — keyword search on the legacy scope, knowingly

Slack labels `search:read` **legacy** and points AI-enabled apps at Real-time Search — `assistant.search.context`
with granular `search:read.public`, `search:read.private`, `search:read.im`, `search:read.mpim` scopes. Internal
customer-built apps, which is what D8 makes this, are eligible for it.

v1 keeps `search:read` anyway, and this is a decision rather than an oversight. Three reasons:

1. **The two return different things.** `search.messages` returns messages, which is the shape every downstream
   piece of this design is written against — S3's search, the citation rules, the skills. `assistant.search.context`
   returns assistant *context*. Adopting it is not a manifest edit; it is a different S3.
2. **The research could not verify its behaviour end to end**, and §3.4 records a bot-token `action_token`
   requirement whose user-token equivalent is unestablished. D13 refused to build on an unverified subscription
   for exactly this reason; the same restraint applies here.
3. **Legacy is not withdrawn.** It is documented and working, and the cost of being wrong is bounded: one
   re-authorisation, which `doctor` can warn about before it is forced.

The cost is stated rather than discovered: **changing this later forces every connected workspace to
re-authorise**, because the scope set lives in the manifest the person installed. That is the price of picking
either one now, and it is why this is settled in S2 rather than deferred to S3.

### D13 — no Socket Mode in v1

Reading is on demand, so nothing in v1 needs events. The one feature that would want them — "what needs my
attention" — has no API and would be built on a subscription whose behaviour the research could not verify. Adding
a persistent connection for a feature we cannot yet specify is how a v1 acquires a component nobody can debug.

The design reserves it (§5, D9) and the verification below is the gate on building it.

### The six unknowns, and how v1 behaves without answering them

The research marked six things as unverified. None of them blocks v1, because each is designed around rather than
guessed at — the rule being that where the answer is unknown, the behaviour that is safe if the pessimistic answer
is true is the one we ship.

| Unknown | How v1 behaves | What to test before relying on it |
|---|---|---|
| Whether user-perspective subscriptions deliver the person's own DMs over Socket Mode | No feature depends on events at all | Install a `read` app, subscribe, send yourself a DM, and see whether it arrives. Until it does, "what needs my attention" is a search, not a subscription |
| Whether a user-token `chat.update` shows "(edited)" | The preview says an edit **may** be visible to anyone who saw the original, and never promises a silent correction | Post, edit, and look at another account's client |
| Whether `files.upload` is hard-disabled past its sunset | Only the current three-step external upload flow is implemented; the old one is not called at all | Nothing — we do not depend on it either way |
| Whether the API can read the 90-day band free workspaces hide | A search that returns nothing says "nothing in what this workspace lets the API see", never "nothing exists" | Search a free workspace for a message older than 90 days |
| Whether a user token can post to a public channel the person has not joined | The preview names the channel **and whether the person is a member of it**, and a non-member post is refused by us regardless of whether Slack allows it | Attempt one, and see |
| The exact body of a 429 | The retry reads `Retry-After` from the header, which is documented, and treats a missing one as sixty seconds | Trip one deliberately and record the body |

Two of those — the edit label and the non-member post — are the ones that could mislead a person about what their
approval meant, and both are handled by the preview saying less rather than by assuming more.

## 9. What this design does not protect against

The same list as Gmail's, plus:

- **An agent with a shell** can read the token and call Slack directly. Unchanged, and the `read` install is the
  real mitigation: there is nothing to steal that can post.
- **A message edited after you read it.** Slack messages can be edited in place; a summary is of what was there
  when it was read. The timestamp we cite is the handle to check against.
- **Retraction is not a gate.** `chat.update` and `chat.delete` exist, but the edit window is a workspace setting
  an owner controls and deletion may be restricted to admins. The notification has already fired regardless.
- **Unfurled content** is written by whoever controls the URL, not by the message author.

## 10. What the Gmail release taught, and where it lands here

Before Gmail v0.1.0 went out, three audits of the tagged tree found 74 defects in the code and 68 places where a
shipped skill contradicted the code it described. Almost every one is a pattern, not a one-off, and a second
provider is the place a pattern repeats. This section maps each to its Slack form, so the lesson is designed in
rather than rediscovered by the next audit.

| What went wrong in Gmail | What it would be in Slack | Where it is handled |
|---|---|---|
| `neutralise` could be split by one zero-width space, because every pattern it uses is written in visible characters | A display name or status text carrying U+200B inside `<\|im_start\|>` | Fixed inside `neutralise` in the core package; inherited unchanged (D5.3) |
| Three read paths returned a subject, a filename or a display name with no `neutralise` at all | Slack has more such fields, and several — status, topic, purpose — anyone can edit at any time | Every sender-controlled field neutralised where its values funnel through, with a hostile-value test per tool (D5.5) |
| Decoding happened after neutralising, so an RFC 2047 encoded-word could carry a live closing envelope tag | Slack's `&lt;` / `&gt;` escaping and `<@U…>` / `<url\|label>` syntax | Decode, then cut, then neutralise (D5.4) |
| The approval preview showed an encoded subject the recipient would read decoded | A preview showing `<@U123>` or `&amp;` where the client shows a name and `&` | The preview renders what the client will render, decoded and not neutralised (D4) |
| `out` was joined to the alias with `path.join`, which cancelled the alias on `../other` and swallowed absolute paths | File downloads per workspace | `relativeSubpath` from the core package, refusing both before any join |
| `env.HOME ?? ''` resolved the attachment jail to the working directory on Windows | Any path the Slack package builds | `homeDirectory()` from the core package; nothing reads `HOME` directly |
| Risk flags came from different strings on different surfaces, and an encoded filename suppressed them all | Slack file names, which users set freely | `attachmentRisks`, which now normalises its own input |
| The transport cache was keyed by alias, so a reused alias was served by the previous mailbox | D11 makes this likelier: several workspaces, each with an alias a person can move | Transports keyed by workspace id, never alias |
| A reauth used the first OAuth client in config, not the inbox's own, and then did not record which it used | D8 means **one Slack app per workspace**, so "the first app" is wrong far more often | A reauth goes through the workspace's own app and records the one the token was issued to |
| `send_list` and `send_cancel` ignored the server's `--inbox` pin | An MCP server pinned to one workspace | Every tool honours the pin, list and cancel included, with a test that walks all of them |
| The Reply-To warning compared only the first address, while every address became a recipient | "Who will be notified" sampled rather than counted | The preview counts **all** of them — `@here`, `@channel`, each mention, and the thread's participants (§6) |
| A mailbox without contacts scope was reported as having *failed* | A `read`-mode workspace asked to do something only `send` mode can | A capability the install lacks is reported as that, never as a failure; `complete` and `errors` keep the two apart |
| Six other Gmail MCP servers on the author's own machine could send with no approval step | **Another Slack MCP server holding a write token** | `doctor` looks for them — see below |
| 68 skill documents contradicted the code, one telling an agent to re-inbox mail the user had archived | The Slack skills | An audit of every skill against the code before S6 merges |
| The release's own check read a CDN-cached page and reported a successful publish as failed | The Slack release | S7 goes through `scripts/release.mjs`, which asks the authenticated registry path |

### The one that changes a promise

D1 says a `read`-mode workspace is one where "a bug in our code cannot post", because the token cannot. That is
true, and it is less than it sounds. **It says nothing about other software.** `doctor` found six Gmail MCP servers
on the author's own machine, each with an ungated `send_email`, which quietly voided every guarantee the Gmail
package makes — not by breaking it, but by standing beside it. The Slack equivalent is a second Slack MCP server
holding a `chat:write` token for the same workspace. While one is connected, an agent can post through it without
going near ours, and a `read` install protects nothing.

So `agent-slack doctor` looks for other Slack MCP servers in every client configuration it can read, reports any
that expose a posting tool, and the setup skill treats removing them as a step rather than a suggestion. The
documentation states `read` mode's guarantee as what it is: *this package* cannot post. Whether *nothing* can
depends on what else is installed.
