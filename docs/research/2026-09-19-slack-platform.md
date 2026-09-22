# Slack platform research

**Date of research: 19 September 2026.** Everything below was read from the cited URL on that
date. Slack moved its developer documentation from `api.slack.com` to `docs.slack.dev` during
2025; old `api.slack.com` paths now 302-redirect, and a few deep reference pages serve a
client-side shell to naive fetchers, which is noted where it limited what could be verified.

Purpose: to decide how `agent-communications` adds Slack as a second platform behind the
provider-neutral core, and in particular whether the send gate that Gmail needs can be built the
same way here.

Where something could not be established from a primary source, it says **not verified**. Those
gaps are real and should not be papered over when the spec is written.

---

## 1. Auth and app model

### 1.1 The app model in 2026

A Slack app is a configuration record owned by a developer account. It is created either in the
web UI at `https://api.slack.com/apps` ("Your Apps" → **Create New App**), where you choose
between "from a manifest" and a blank app, or through the Slack CLI.
Source: <https://docs.slack.dev/app-manifests/>, <https://docs.slack.dev/tools/slack-cli/>

The **app manifest** is the portable form of that configuration — "designed to make an app's
configuration 'portable'" — and can be authored as JSON or YAML, kept in version control, and
pasted into another workspace to recreate the same app.
Source: <https://docs.slack.dev/app-manifests/>

The manifest schema has four top-level sections: `display_information`, `features`,
`oauth_config` and `settings`. Scopes are declared at `oauth_config.scopes.bot` ("An array of
strings containing bot scopes to request upon app installation") and `oauth_config.scopes.user`.
Relevant `settings` keys include `socket_mode_enabled`, `event_subscriptions`,
`org_deploy_enabled` and `token_rotation_enabled`.
Source: <https://docs.slack.dev/reference/app-manifest>

**Optional scopes** landed on 16 March 2026. Scopes can be marked optional via
`oauth_config.scopes.bot_optional` and `user_optional` (a scope listed as optional must also
appear in the corresponding non-optional array). At install time "optional scopes are presented
separately during installation and users can choose which ones to grant", and workspace admins
can pre-approve which optional permissions their members may grant.
Sources: <https://docs.slack.dev/changelog/2026/03/16/optional-scopes/>,
<https://docs.slack.dev/reference/app-manifest>

### 1.2 What "install to workspace" means

Two distinct paths, and the difference matters for us:

- **Single-workspace app (undistributed).** The app lives only in its development workspace.
  There is an **"Install to Workspace" button** in app settings: "A one-click installation for
  single-workspace apps that automatically generates an access token. This simplified process
  doesn't require OAuth handling." OAuth is *not* required "if they only interact within their
  associated workspace"; it becomes required if the app needs to act "on behalf of other users".
  Source: <https://docs.slack.dev/distribution/>
- **Distributed app.** Uses OAuth 2.0 to mint a token per workspace and per user. Two flavours:
  *unlisted* (installable by direct URL, good for pilots) and *listed* (published to the Slack
  Marketplace after review). Enabling distribution requires OAuth 2.0, SSL on every redirect and
  request URL, a scalable onboarding flow, and minimal scope requests because admins review the
  scope list when approving.
  Source: <https://docs.slack.dev/distribution/>

For our use case — one person, their own workspace, a local agent — the single-workspace
"Install to Workspace" path is sufficient and avoids needing any hosted redirect URL.

### 1.3 Bot tokens (`xoxb`) vs user tokens (`xoxp`)

| | Bot token `xoxb` | User token `xoxp` |
|---|---|---|
| Represents | The app's bot user | A specific human member |
| Tied to identity | No — "they're not tied to a user's identity—they're only tied to your app" | Yes |
| Survives installer leaving | Yes — "apps remain installed even if the installing user is deactivated" | No |
| Messages appear as | The app | The person |
| Reach | Only conversations the bot has been added to | What the person can see |

Source: <https://docs.slack.dev/authentication/tokens>

The reach difference is the decisive one. From the `conversations.history` reference:

- With a **bot token**, access is limited to "any conversation the relevant bot is a member of",
  and the `not_in_channel` error fires otherwise.
- With a **user token**, access extends to "any private conversation the user is a member of, and
  all public conversations" — and "Only user tokens can access public channels they are not in."

Source: <https://docs.slack.dev/reference/methods/conversations.history>

**Which is right for an agent acting on behalf of one person: a user token.** A bot token cannot
see the person's DMs (only DMs the app itself is a party to — `im:history` grants "View messages
and other content in direct messages that your Slack app has been added to"), cannot read
channels it has not been invited to, and cannot use the classic search methods at all (`search:read`
is "compatible exclusively with user tokens"). A bot token *can* search via the Real-time Search
API, but only in response to a user interaction, because every bot-token call needs an
`action_token` delivered in a message or mention event — see §3.4. A read-focused assistant on a
bot token would be blind to most of what the person actually cares about.
Sources: <https://docs.slack.dev/reference/scopes/im.history>,
<https://docs.slack.dev/reference/scopes/search.read>,
<https://docs.slack.dev/reference/methods/assistant.search.context>

The cost of a user token is that it carries the person's full reach. A user token with
`channels:history` can read **every public channel in the workspace**, including ones the person
has never opened. That is a much larger read surface than a Gmail mailbox and must be treated as
one.

There is also an **app-level token** (`xapp`), which "represent[s] your app across organizations"
and is used for app-wide concerns — in practice, Socket Mode — and **configuration tokens**, which
are for managing app settings through the App Manifest API and are "unique to a user and a
workspace, but not an app".
Source: <https://docs.slack.dev/authentication/tokens>

### 1.4 The OAuth flow

Authorisation URL: `https://slack.com/oauth/v2/authorize` with `client_id`, `scope` (bot scopes),
`user_scope` (user scopes), `redirect_uri` and optional `state`. Slack redirects back with a
temporary `code`, which the backend exchanges at `oauth.v2.access` using
`client_id` + `client_secret`.

> **Correction, 2026-09-22.** This section originally said `redirect_uri` "must be HTTPS". That is
> true for the confidential-client flow described here and **false in general** — see §1.4a. The
> error was load-bearing: it was read as meaning a local CLI cannot receive a redirect at all,
> which is the opposite of what the platform supports, and it nearly put a token paste at the
> centre of the Slack design.

The response contains `access_token` (the **bot** token), `bot_user_id`, `scope`, `team`,
`enterprise` (if applicable), and an `authed_user` object which carries the **user** token and its
own separate scope list.
Source: <https://docs.slack.dev/authentication/installing-with-oauth>

Note the asymmetry: bot scopes go in `scope`, user scopes go in `user_scope`, and the resulting
user token is nested under `authed_user`. An app can request *only* user scopes; the bot token
half of the response is then empty. This is directly relevant to §2.

For a single-workspace app installed by its own developer, none of this is needed — the token is
issued by the "Install to Workspace" button and read out of app settings.
Source: <https://docs.slack.dev/distribution/>

### 1.4a PKCE, and why a local CLI *can* take the redirect

**A PKCE-enabled app may redirect to `http://localhost`.** Verbatim: "Redirects to `localhost`
(e.g. `http://localhost:8080/auth`) are treated as desktop redirects if the app has opted into
PKCE." So the loopback pattern the Gmail side uses is available here too, and the HTTPS
requirement in §1.4 does not apply to it.

**No client secret.** For the PKCE exchange the client "should call the `oauth.v2.access` API
method, but should not include `client_secret` in the parameters." That removes the thing a local
install should never have been asked to hold: nothing secret is distributed, and the only value a
person pastes is the app's **Client ID**, which is not a secret.

**The authorisation request** goes to the same `https://slack.com/oauth/v2/authorize`, with
`client_id`, `user_scope`, `redirect_uri`, `code_challenge` and `code_challenge_method`. "The only
supported hashing algorithm for now is SHA-256", and the challenge is that hash in "URL-Safe
Base64 format (RFC 4648 §5)" — so `code_challenge_method` is `S256`.

**Bot scopes are excluded from this route:** "Desktop redirects are not allowed to request bot
scopes." That is a constraint the design already meets rather than a problem, because §1.3
concluded a user token is the right one for an agent acting on one person's behalf.

**Two token endpoints are documented and both accept `code_verifier`:** `oauth.v2.access` (named
by the PKCE page) and `oauth.v2.user.access`, which is "used to initiate the OAuth flow using just
user scopes (no bot scopes)" and also takes `refresh_token`. Which of the two to call for a
user-scope-only PKCE app is **not settled by the documentation alone** and must be confirmed
against a real workspace before anything depends on it.

**Refresh tokens expire after 30 days on a PKCE app.** Verbatim: "all refresh tokens issued to your app will
expire in 30 days instead of lasting indefinitely." This is *not* the 12-hour access-token expiry of §1.5; it is
the refresh token itself. A workspace nothing has touched for a month therefore needs a new authorisation, and
the design has to say so before the month passes rather than after.

**`localhost`, not `127.0.0.1`.** The promise is made about one spelling: "Redirects to `localhost` (e.g.
`http://localhost:8080/auth`) are treated as desktop redirects". Nothing on the page extends it to the literal
address. This matters because the Gmail side deliberately uses `127.0.0.1` — `localhost` can resolve to whatever
a name service says, which is the reason to avoid it — so the two packages will differ here, and the reason is
that Slack documents one and not the other. Verify against a real workspace before the manifests are fixed.

**How an app opts into PKCE: `oauth_config.pkce_enabled`.** *Corrected 2026-09-22.* An earlier pass over
this page concluded the switch was undocumented and recorded it as the phase's one real unknown. It is
documented in two places. The PKCE guide gives `"pkce_enabled": true` under `oauth_config` and says the
same setting is in the app settings UI, "under the **OAuth & Permissions** sidebar section"; the app
manifest reference lists `pkce_enabled` as "A boolean that specifies whether or not PKCE is enabled for
the OAuth flow", under `oauth_config` alongside `redirect_urls`, `scopes` and `token_management_enabled`.

What its absence costs is stated outright, and is why this matters more than a missing nicety: "If the
app has never enabled PKCE, [localhost redirects] will be treated like a server redirect." An app built
without it cannot complete a single sign-in through this package.

The lesson is about the record rather than the API: "no source found says where that switch is" is a
claim about a search, and it was written down as though it were a claim about Slack. The S2 manifest
now sets it, and a test fails if it is ever turned off.

> **The remaining unknowns have a checklist.**
> [`2026-09-22-slack-live-verification.md`](2026-09-22-slack-live-verification.md) says what to run,
> what each outcome means and which line to change for each answer. Update this section with what was
> observed, and the date, once it has been run.

Sources: <https://docs.slack.dev/authentication/using-pkce/>,
<https://docs.slack.dev/reference/methods/oauth.v2.user.access/>

### 1.5 Token rotation

**Optional to turn on, irreversible once on.** "Token rotation may not be turned off once it's
turned on."

- Enable it, then exchange the long-lived token via `oauth.v2.exchange` for an expiring access
  token plus a refresh token.
- Refresh by calling `oauth.v2.access` with the refresh token as `grant_type`.
- Access tokens expire in **43,200 seconds (12 hours)**; `expires_in` always reports that.
- **Refresh tokens are single-use**: "After calling `oauth.v2.access`, the refresh token you used
  is revoked after a short grace period."
- If you refresh repeatedly before expiry, Slack enforces "a limit of 2 active tokens. If more
  than 2 tokens exist after the refresh, the oldest additional token will be revoked."
- Applies to both granular bot tokens and user tokens.

Source: <https://docs.slack.dev/authentication/using-token-rotation>

Operationally: a local CLI/MCP process must persist the refresh token, refresh on a schedule
comfortably inside 12 hours, and handle the single-use semantics safely across concurrent
processes — two processes refreshing at once will burn the token and can revoke each other. If
rotation is left off, the token is long-lived and the problem disappears, at the cost of a
credential on disk that never expires.

Whether token rotation is or will be **mandatory** for Marketplace-listed apps: **not verified.**
Search surfaced only that Marketplace apps *can* enable it via Published App Settings; no
mandatory-enforcement date was found.

### 1.6 What a person must do, and whether an admin gets in the way

To create a personal app: sign in at `https://api.slack.com/apps`, **Create New App**, from
scratch or from a manifest, add the scopes, then **Install to Workspace** and copy the token.
Source: <https://docs.slack.dev/app-manifests/>, <https://docs.slack.dev/distribution/>

**Is there an approval step?** It depends entirely on the workspace, and the answer for a typical
corporate workspace is usually yes.

- App approval is **not on by default**: "by default, members can install them without approval
  from a Workspace Owner." A Workspace Owner must turn it on.
- Once on, members cannot install a non-pre-approved app; they can only *request* it, and only if
  the owner has ticked "Allow members to request apps for approval".
- Approval can be delegated to appointed **app managers**.
- On Enterprise Grid: "If you're a Workspace Owner in an Enterprise organization, app approval
  will automatically be enabled for your workspace if an Org Owner has set an app management
  policy."

Source: <https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace>

So: on a personal or small workspace, self-install works in about two minutes. On a managed
corporate workspace, the person will likely have to submit a request that names every scope, and
an admin will read that scope list. This makes scope minimalism a *deployment* requirement, not
just a hygiene one — a request for `chat:write` will be read very differently from a request for
history scopes alone.

---

## 2. The scope model

This is the section the design turns on.

### 2.1 Scope reference

Every row below was read from that scope's own page under `https://docs.slack.dev/reference/scopes/`.
"Token types" is quoted from the page's *Supported token types* field.

**Read scopes**

| Scope | Permits (verbatim) | Token types | Unlocks |
|---|---|---|---|
| `channels:history` | "View messages and other content in public channels that your Slack app has been added to" | Bot, User, Legacy Bot | `conversations.history`, `conversations.replies` |
| `groups:history` | "View messages and other content in private channels that your Slack app has been added to" | Bot, User (per scope index) | `conversations.history`, `conversations.replies` |
| `im:history` | "View messages and other content in direct messages that your Slack app has been added to" | Bot, User, Legacy Bot | `conversations.history`, `conversations.replies` |
| `mpim:history` | "View messages and other content in group direct messages that your Slack app has been added to" | Bot, User (per scope index) | `conversations.history`, `conversations.replies` |
| `channels:read` | "View basic information about public channels in a workspace" | Bot, User, Legacy Bot | `conversations.info`, `conversations.list`, `conversations.members`, `conversations.open`, `users.conversations` |
| `users:read` | "View people in a workspace" | Bot, User, Legacy Bot | `bots.info`, `users.getPresence`, `users.info`, `users.list` |
| `users:read.email` | "View email addresses of people in a workspace" | (see note) | `users.lookupByEmail` |
| `files:read` | "View files shared in channels and conversations that your Slack app has been added to" | Bot, User, Legacy Bot | `files.info`, `files.list` |
| `search:read` | "Search a workspace's content" — flagged **legacy**, Slack recommends the Real-time Search API scopes instead | **User only** | `search.all`, `search.files`, `search.messages` |
| `search:read.public` | "Search a workspace's content in public channels" | Bot, User | `assistant.search.context`, `assistant.search.info` |
| `links:read` | lets an app read links posted in Slack | Bot (recommended) | `link_shared` event |

Sources: <https://docs.slack.dev/reference/scopes/channels.history>,
<https://docs.slack.dev/reference/scopes/im.history>,
<https://docs.slack.dev/reference/scopes/channels.read>,
<https://docs.slack.dev/reference/scopes/users.read>,
<https://docs.slack.dev/reference/scopes/files.read>,
<https://docs.slack.dev/reference/scopes/search.read>,
<https://docs.slack.dev/reference/scopes/search.read.public>,
<https://docs.slack.dev/reference/scopes>,
<https://docs.slack.dev/messaging/unfurling-links-in-messages>

Note on `users:read.email`: the scope index lists it as "View email addresses of people in a
workspace"; its individual page was not read directly, so its exact supported-token-type list is
**not verified**.

**Threads and DM plumbing**

| Scope | Permits (verbatim) | Token types | Unlocks |
|---|---|---|---|
| `im:write` | "Start direct messages with people" | Bot, User, Legacy Bot | `conversations.open`, `conversations.close`, `conversations.create`, `conversations.archive`, `conversations.unarchive`, `conversations.leave`, `conversations.kick`, `conversations.mark`, `conversations.rename` |

Source: <https://docs.slack.dev/reference/scopes/im.write>

`im:write` is a conversation-management scope, **not** a posting scope — it opens a DM channel but
does not let you say anything in it. Note that it *does* include `conversations.mark`, which
mutates read state.

**Write scopes**

| Scope | Permits (verbatim) | Token types | Unlocks |
|---|---|---|---|
| `chat:write` | "Send messages as your Slack app" | Bot **and** User | `chat.postMessage`, `chat.postEphemeral`, `chat.update`, `chat.delete`, `chat.scheduleMessage`, `chat.deleteScheduledMessage`, `chat.meMessage`, `assistant.threads.setStatus` |
| `chat:write.public` | "Send messages to channels your Slack app isn't a member of" — "To use this scope, your app must also request `chat:write`." | **Bot only** | `chat.postMessage` |
| `chat:write.customize` | "Send messages as your Slack app with a customized username and avatar" — also requires `chat:write` | **Bot only** | `chat.postMessage`, `files.completeUploadExternal` |
| `reactions:write` | "Add and edit emoji reactions" | Bot, User, Legacy Bot | `reactions.add`, `reactions.remove` |
| `files:write` | "Upload, edit, and delete files as your Slack app" | Bot, User | `files.getUploadURLExternal`, `files.completeUploadExternal`, `files.delete`, `files.comments.delete`, `files.revokePublicURL`, `files.sharedPublicURL`, `files.upload` |
| `incoming-webhook` | "Post messages to specific channels in Slack" | **Bot only** | a per-channel webhook URL chosen during install |

Sources: <https://docs.slack.dev/reference/scopes/chat.write>,
<https://docs.slack.dev/reference/scopes/chat.write.public>,
<https://docs.slack.dev/reference/scopes/chat.write.customize>,
<https://docs.slack.dev/reference/scopes/reactions.write>,
<https://docs.slack.dev/reference/scopes/files.write>,
<https://docs.slack.dev/reference/scopes/incoming-webhook>

### 2.2 The central question: is read-only achievable?

**Yes. Unlike Gmail, Slack's read permissions and write permissions are disjoint.**

This is the headline difference from the Gmail problem. Gmail's difficulty is that the scope which
lets an agent create a draft (`gmail.compose`) also lets it send, so "may draft, may not send"
cannot be expressed as a permission. In Slack there is no such coupling: every read path is
gated by a `*:history` / `*:read` scope, and every message-posting path is gated by `chat:write`
(or one of three narrow alternatives listed below). A token holding only history and read scopes
**cannot call `chat.postMessage` at all** — the method's required scope is `chat:write` for both
bot and user tokens.
Source: <https://docs.slack.dev/reference/methods/chat.postMessage>

So a genuinely read-only Slack token is constructible, and the OAuth consent screen will honestly
tell the person that the app cannot post.

**But the enumeration has to be complete, because `chat:write` is not the only way to make
something appear in a channel.** Four other write paths exist:

1. **`files:write` alone can post.** `files.completeUploadExternal` takes `channel_id` /
   `channels` (up to 100), `thread_ts` and `initial_comment`. With channels specified, "the file
   will be shared in Slack" as a visible message. Its required scope is `files:write` for both bot
   and user tokens — **`chat:write` is not required**. `chat:write.customize` is only needed to
   override the username/icon on that share.
   Source: <https://docs.slack.dev/reference/methods/files.completeUploadExternal>
2. **`reactions:write` posts a visible, notifying reaction.** Not a message, but it is an
   irreversible-in-practice public act attributed to the person.
   Source: <https://docs.slack.dev/reference/scopes/reactions.write>
3. **`incoming-webhook`** hands the app a webhook URL that posts to a chosen channel, with no
   `chat:write` anywhere. Bot-only, so it does not arise on a user-token design, but it must never
   be requested.
   Source: <https://docs.slack.dev/reference/scopes/incoming-webhook>
4. **`im:write` includes `conversations.mark`**, which mutates the person's read state. Not a
   post, but not read-only either.
   Source: <https://docs.slack.dev/reference/scopes/im.write>

Therefore the read-only scope set is: `channels:history`, `groups:history`, `im:history`,
`mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`,
`users:read.email`, `files:read`, plus search scopes — and **no** `chat:write`, **no**
`files:write`, **no** `reactions:write`, **no** `incoming-webhook`.

A design that wants send-with-approval needs `chat:write` in the token, at which point the scope
stops enforcing anything and the gate is once again ours to enforce in code — exactly as with
Gmail. The difference is that Slack lets us offer a **second, genuinely-enforced mode**: a
read-only installation where the gate is the OAuth grant itself, and where a bug in our code
cannot post. Gmail has no equivalent of that.

### 2.3 Does Slack have drafts?

**No public draft API.** The full Web API method index lists these `chat.*` methods:
`chat.appendStream`, `chat.delete`, `chat.deleteScheduledMessage`, `chat.getPermalink`,
`chat.meMessage`, `chat.postEphemeral`, `chat.postMessage`, `chat.scheduledMessages.list`,
`chat.scheduleMessage`, `chat.startStream`, `chat.stopStream`, `chat.unfurl`, `chat.update`.
There is **no** method beginning with `drafts.` anywhere in the public Web API.
Source: <https://docs.slack.dev/reference/methods>

Slack's own client does have `drafts.create` / `drafts.list` / `drafts.delete`, but these are
**undocumented internal endpoints** reachable only with browser-session credentials (`xoxc`/`xoxd`),
not with an OAuth token, and Slack does not support them. The confirmation of the internal
endpoints comes from third-party tooling rather than Slack documentation, so the precise behaviour
is **not verified** and the endpoints must be treated as unsupported and liable to change without
notice. They should not be built on.
Source (third-party, non-authoritative): <https://reduck.ai/explore/scripts/reduck/slack.com/create_draft>

This is the mirror image of the Gmail situation. Gmail has a real server-side draft but no scope
that stops it being sent. Slack has a scope that stops sending but no server-side draft. **A Slack
"draft" in our system has to be a local artefact** — stored by us, rendered by us, previewed by
us — and the send gate is the boundary between that artefact and `chat.postMessage`.

### 2.4 The closest equivalents to "prepare and let a human approve"

Four candidates, none of them a draft:

1. **A local draft plus our own gate.** The only option that actually reproduces the Gmail
   behaviour. Nothing appears in Slack until the person approves.
2. **`chat.scheduleMessage`.** Posts at a future `post_at`, up to **120 days** ahead
   (`time_too_far` beyond that), returns a `scheduled_message_id`, and can be cancelled before it
   fires with `chat.deleteScheduledMessage`. Tier 3. Caps at 30 scheduled messages posting within
   a 5-minute window to the same channel (`restricted_too_many`). **Gotcha: "Messages scheduled
   with `chat.scheduleMessage` will not post if the `metadata` parameter is used."**
   Source: <https://docs.slack.dev/reference/methods/chat.scheduleMessage>
   This is a *delayed send*, not a draft: it is fire-and-forget by default. It inverts the gate —
   the human must intervene to *stop* it. That is the wrong default for us, though it may be
   worth offering as an explicit "send in 10 minutes, cancellable" mode.
3. **`chat.postEphemeral`.** Posts a message visible only to one user, which does not persist:
   ephemeral messages "do not persist across reloads, between desktop and mobile apps, or across
   sessions" and **cannot be retrieved via APIs**. They also cannot be updated by `chat.update`.
   Source: <https://docs.slack.dev/messaging/>, <https://docs.slack.dev/reference/methods/chat.update>
   Tempting as a "preview in Slack" mechanism, but it requires `chat:write` — so using it as the
   preview surface forfeits the read-only guarantee to show a preview. It also cannot be read back,
   so it cannot be the system of record for what was approved.
4. **Post then edit/delete.** Slack is less final than email (§6.2), so an over-eager post can
   often be retracted. This is a mitigation, never a gate: the notification has already fired and
   anyone watching has already seen it.

### 2.5 `chat:write` vs `chat:write.public` vs `chat:write.customize`

- **`chat:write`** — "Send messages as your Slack app". Available on **both** bot and user tokens.
  It is the umbrella write scope: post, post-ephemeral, update, delete, schedule and unschedule
  all sit behind this one scope. There is no finer division. You cannot grant "may edit its own
  messages but may not post new ones", and you cannot grant "may post but may not delete".
  Source: <https://docs.slack.dev/reference/scopes/chat.write>
- **`chat:write.public`** — "Send messages to channels your Slack app isn't a member of".
  **Bot-only**, and requires `chat:write` alongside it. It exists because "New Slack apps do *not*
  begin life with the ability to post in all public channels."
  Sources: <https://docs.slack.dev/reference/scopes/chat.write.public>,
  <https://docs.slack.dev/reference/methods/chat.postMessage>
  It does not arise on a user token: a user token's reach is the person's reach, and the person
  can already post in public channels they are in. (Whether a user token can post to a public
  channel the person has not joined is **not verified**.)
- **`chat:write.customize`** — "Send messages as your Slack app with a customized username and
  avatar". **Bot-only**, requires `chat:write`. It is what unlocks the `username`, `icon_url` and
  `icon_emoji` parameters on `chat.postMessage`, and the same overrides on
  `files.completeUploadExternal`.
  Sources: <https://docs.slack.dev/reference/scopes/chat.write.customize>,
  <https://docs.slack.dev/reference/methods/chat.postMessage>

`chat:write.customize` deserves a flag in the spec: it is an **impersonation scope**. It lets an
app post under an arbitrary display name and arbitrary avatar. And per the `chat.postMessage`
reference, "Messages posted with customized authorship cannot be deleted using `chat.delete`" —
so a message posted under a false identity is also one the app cannot retract through the API. We
should never request it.
Source: <https://docs.slack.dev/reference/methods/chat.postMessage>

---

## 3. The APIs an agent would use

Each method page at `https://docs.slack.dev/reference/methods/<method>` carries YAML frontmatter
with `http_method`, `rate_limit` and separate `scopes.bot` / `scopes.user` blocks; that frontmatter
is the authoritative source for the table below and is what is cited throughout this section.

### 3.1 Method, scope and tier table

| Method | Verb | Bot scopes | User scopes | Tier |
|---|---|---|---|---|
| `conversations.list` | GET | `channels:read`, `groups:read`, `im:read`, `mpim:read` | same | 2 |
| `conversations.history` | GET | `channels:history`, `groups:history`, `im:history`, `mpim:history` | same | 3 — see §4.3 |
| `conversations.replies` | GET | same as history | same | 3 — see §4.3 |
| `conversations.info` | GET | `channels:read`, `groups:read`, `im:read`, `mpim:read` | same | 3 |
| `conversations.members` | GET | `channels:read`, `groups:read`, `im:read`, `mpim:read` | same | 4 |
| `conversations.open` | POST | `channels:manage`, `groups:write`, `im:write`, `mpim:write` | `channels:write`, `groups:write`, `im:write`, `mpim:write` | 3 |
| `conversations.join` | POST | `channels:join` | `channels:write` | 3 |
| `conversations.mark` | POST | `channels:manage`, `channels:write`, `groups:write`, `im:write`, `mpim:write` | `channels:write`, `groups:write`, `im:write`, `mpim:write` | 3 |
| `chat.postMessage` | POST | `chat:write` | `chat:write` | **Special** |
| `chat.postEphemeral` | POST | `chat:write` | `chat:write` | 4 |
| `chat.update` | POST | `chat:write` | `chat:write` | 3 |
| `chat.delete` | POST | `chat:write` | `chat:write` | 3 |
| `chat.scheduleMessage` | POST | `chat:write` | `chat:write` | 3 |
| `chat.scheduledMessages.list` | POST | *(none listed)* | *(none listed)* | 3 |
| `chat.deleteScheduledMessage` | POST | `chat:write` | `chat:write` | 3 |
| `chat.getPermalink` | GET | **none required** | **none required** | Special |
| `search.messages` / `.all` / `.files` | GET | **none — user token only** | `search:read` | 2 |
| `assistant.search.context` | POST | `search:read.public`, `search:read.files`, `search:read.users` | + `search:read.private`, `search:read.im`, `search:read.mpim` | Special |
| `assistant.search.info` | POST | `search:read.public` | `search:read.public` | 2 |
| `users.list` | GET | `users:read` | `users:read` | 2 |
| `users.info` | GET | `users:read` | `users:read` | 4 |
| `users.lookupByEmail` | GET | `users:read.email` | `users:read.email` | 3 |
| `users.conversations` | GET | `channels:read`, `groups:read`, `im:read`, `mpim:read` | same | 3 |
| `files.getUploadURLExternal` | POST | `files:write` | `files:write` | 4 |
| `files.completeUploadExternal` | POST | `files:write` | `files:write` | 4 |
| `files.upload` (deprecated) | POST | `files:write` | `files:write` | 2 |
| `files.info` | GET | `files:read` | `files:read` | 4 |
| `files.list` | GET | `files:read` | `files:read` | 3 |
| `reactions.add` | POST | `reactions:write` | `reactions:write` | 3 |
| `reactions.get` | GET | `reactions:read` | `reactions:read` | 3 |
| `reactions.list` | GET | `reactions:read` | `reactions:read` | 2 |

Sources: the individual method pages under <https://docs.slack.dev/reference/methods/>.

### 3.2 Conversations — returns and gotchas

**`conversations.list`** → `channels[]` (limited objects), `response_metadata.next_cursor`. `limit`
default 100, "Must be an integer under 1000." The trap:

> "When paginating, any filters used in the request are applied *after* retrieving a virtual
> page's `limit`. For example, using `exclude_archived=true` when `limit=20` on a virtual page that
> would contain 15 archived channels will return you the virtual page with only `5` results."

A near-empty page therefore does **not** mean the end of the collection.
Source: <https://docs.slack.dev/reference/methods/conversations.list>

**`conversations.history`** → `messages[]`, `has_more`, `pin_count`, `next_cursor`. `limit` default
100, maximum 999. Bot tokens see "Any conversation the relevant bot is a member of"; user tokens
see "Any private conversation the user is a member of, and all public conversations". `is_limited`
appears "only for free teams that have reached the free message limit". Single-message fetch:
`oldest=<ts>`, `inclusive=true`, `limit=1`.
Source: <https://docs.slack.dev/reference/methods/conversations.history>

**`conversations.replies`** → same envelope, but `limit` **defaults to 1000**, not 100. `channel`
and `ts` always required; with no replies it returns just the referenced message.
Source: <https://docs.slack.dev/reference/methods/conversations.replies>

**`conversations.info`** → a channel object; `include_num_members` adds `num_members`. Note:
"Some fields in the response, like `unread_count` and `unread_count_display`, are included for
**DM conversations only**."
Source: <https://docs.slack.dev/reference/methods/conversations.info>

**`conversations.members`** → `members[]` of **bare user-ID strings**, not user objects. Joining
against `users.info` / `users.list` is on us.
Source: <https://docs.slack.dev/reference/methods/conversations.members>

**`conversations.open`** → by default only `{"ok":true,"channel":{"id":"D..."}}`; pass
`return_im=true` for the full object. Takes 1–8 user IDs (1 → DM, more → MPIM), and "Don't include
the ID of the user you're calling `conversations.open` on behalf of – we do that for you."
Idempotent: repeat calls return the existing conversation (`already_open`, `no_op`).
Source: <https://docs.slack.dev/reference/methods/conversations.open>

**`conversations.join`** → conversation object; already a member returns `ok:true` with
`"warning": "already_in_channel"`, so it is safe to call blindly. Archived → `is_archived`. There
is no bot-token path to self-join a **private** channel; it must be invited.
Source: <https://docs.slack.dev/reference/methods/conversations.join>

### 3.3 chat.* — returns and gotchas

- **`chat.postMessage`** — Special tier; see §4.1 for the wording. Scope trap: "New Slack apps do
  *not* begin life with the ability to post in all public channels."
  Source: <https://docs.slack.dev/reference/methods/chat.postMessage>
- **`chat.postEphemeral`** — Tier 4. "Ephemeral message delivery is not guaranteed — the user must
  be currently active in Slack and a member of the specified `channel`." Cannot later be updated
  or deleted, and cannot be read back.
  Source: <https://docs.slack.dev/reference/methods/chat.postEphemeral>
- **`chat.update`** — Tier 3. Block-retention trap: "If you don't include `blocks`, the message's
  previous `blocks` will only be retained if the `text` argument is not provided. If the `text`
  argument is provided and `blocks` are not provided, the `blocks` will be removed."
  Source: <https://docs.slack.dev/reference/methods/chat.update>
- **`chat.delete`** — Tier 3. "When used with a bot token, this method may delete only messages
  posted by that bot."
  Source: <https://docs.slack.dev/reference/methods/chat.delete>
- **`chat.scheduleMessage`** — Tier 3 → `scheduled_message_id`, `post_at`, `channel`. 120-day
  ceiling (`time_too_far`); ≤30 messages posting within a 5-minute window to the same channel
  (`restricted_too_many`); **will not post at all if `metadata` is used**.
  Source: <https://docs.slack.dev/reference/methods/chat.scheduleMessage>
- **`chat.scheduledMessages.list`** — Tier 3, POST, cursor-paginated. "This method will only return
  messages that were scheduled via the `chat.scheduleMessage` API method with the same token. This
  method will not return messages scheduled via the UI."
  Source: <https://docs.slack.dev/reference/methods/chat.scheduledMessages.list>
- **`chat.deleteScheduledMessage`** — Tier 3. "You cannot delete scheduled messages that have
  already been posted … or that will be posted to Slack within **60 seconds** of the delete
  request" → `invalid_scheduled_message_id`. **This is the cancellation window, and it is why a
  scheduled message is not a safe substitute for a draft.**
  Source: <https://docs.slack.dev/reference/methods/chat.deleteScheduledMessage>
- **`chat.getPermalink`** — Special tier, **no scopes required**, GET with `channel` +
  `message_ts`. Useful in previews and audit records at zero permission cost.
  Source: <https://docs.slack.dev/reference/methods/chat.getPermalink>

### 3.4 search.messages — token type, and the fact that it is now legacy

`search.messages`, `search.all` and `search.files` are **user-token-only**. Their frontmatter
carries a `user:` scope block and **no `bot:` block at all**; the rendered page lists only
"User token: `search:read`". Tier 2.
Sources: <https://docs.slack.dev/reference/methods/search.messages>,
<https://docs.slack.dev/reference/methods/search.all>,
<https://docs.slack.dev/reference/methods/search.files>

All three now carry a banner: "This is a legacy method. We recommend using the Real-time Search
API (`assistant.search.context` method) instead."

Pagination is **classic page/count, not cursor**: `count` default 20 / max 100, `page` default 1,
max 100 — a hard ceiling of about 10,000 results. Also: "When using a user token with this method,
search results will be affected by the search filters set in the Slack UI" — the person's own UI
filters silently change what the API returns.

**The Real-time Search API** (`assistant.search.context`, `assistant.search.info`) is the
replacement, announced 17 February 2026 alongside Slack's own MCP server. It is the only
documented way to search with a **bot** token, but:

- "All API calls made using a bot token require an `action_token`. API calls made using a user
  token do not require an `action_token`." The `action_token` arrives inside a `message.*` or
  `app_mention` event payload, so **bot-token search is only reachable in response to a user
  interaction**, never on a schedule.
- "The RTS API is available for **directory-published apps and internal apps only**" — unlisted
  distributed apps cannot use it.
- Private, DM and MPIM content needs a **user** token plus the granular scopes.
- Max 20 results per page; `next_cursor` empty string when done.
- Returns `results.{messages,files,channels}` with `permalink`, `is_author_bot`, and
  `context_messages.{before,after}`.

Sources: <https://docs.slack.dev/reference/methods/assistant.search.context>,
<https://docs.slack.dev/apis/web-api/real-time-search-api>,
<https://docs.slack.dev/changelog/2026/02/17/slack-mcp>

### 3.5 users.*

- **`users.list`** — Tier 2, cursor → `members[]`, `cache_ts`. "includes both invited users and
  deleted/deactivated users." Warning: "Providing no `limit` value will result in Slack attempting
  to deliver you the entire result set. If the collection is too large you may experience
  `limit_required` or **HTTP 500** errors."
- **`users.info`** — Tier 4 → a user object.
- **`users.lookupByEmail`** — Tier 3, `users:read.email`. Two gotchas: "**Custom bot users cannot
  use this method**", and "If the user has been deactivated, `users_not_found` will be returned
  instead of a user object" — fall back to `users.list` and filter.
- **Email rule:** "`users:read` is no longer a sufficient scope for this data field"; apps created
  after 4 January 2017 must request **both** `users:read` and `users:read.email`.
- **`users.conversations`** — Tier 3, cursor, `limit` max 999. "We omit the `is_member` and
  `num_members` fields in this method's response."

Sources: <https://docs.slack.dev/reference/methods/users.list>,
<https://docs.slack.dev/reference/methods/users.info>,
<https://docs.slack.dev/reference/methods/users.lookupByEmail>,
<https://docs.slack.dev/reference/methods/users.conversations>

### 3.6 files.* — the upload flow changed

**`files.upload` is deprecated.** From the changelog of 9 April 2024: newly-created Slack apps
lost access to `files.upload` on **16 May 2024**, and the sunset date moved from 11 March 2025 to
**12 November 2025**. The method page still says: "The `files.upload` API method has been
deprecated. It will stop functioning and be officially sunset on November 12, 2025."
Sources: <https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay>,
<https://docs.slack.dev/reference/methods/files.upload>

That sentence is written in the future tense about a date ten months past, no post-sunset changelog
entry exists, and the method is still listed in the index. Whether `files.upload` is actually hard
-disabled today is **not verified**. Design as though it is gone.

**Current three-step flow:**

1. `files.getUploadURLExternal` (POST, Tier 4, `files:write`) → `{"ok":true,"upload_url":"...","file_id":"F..."}`
2. POST the bytes to `upload_url` — "Files can be sent as raw bytes or can be multipart form
   encoded. Slack will return HTTP 200 if the upload is successful."
3. `files.completeUploadExternal` (POST, Tier 4, `files:write`) → `{"ok":true,"files":[...]}`

Gotchas: "If `files.completeUploadExternal` is not called, the upload will be aborted"; "the
uploaded file and associated metadata will be discarded"; "**This method can only be called
once**"; "If the `channel_id` is not specified, the file will remain private."

**That last clause is the safety-relevant one.** Step 3 with no `channel_id` uploads without
publishing; step 3 *with* `channel_id` / `channels` / `initial_comment` publishes a visible
message. The split between "prepared" and "posted" already exists inside this one method, and it
is on the wrong side of our gate by default.
Sources: <https://docs.slack.dev/reference/methods/files.getUploadURLExternal>,
<https://docs.slack.dev/reference/methods/files.completeUploadExternal>

`files.info` is Tier 4 and cursor-paginated (over the file's comments); `files.list` is Tier 3 and
uses **classic page-based `paging`**, not cursors.
Sources: <https://docs.slack.dev/reference/methods/files.info>,
<https://docs.slack.dev/reference/methods/files.list>

### 3.7 reactions.*

`reactions.add` (Tier 3, `reactions:write`) returns a bare `{"ok":true}`; re-adding returns
`already_reacted`. The `file` / `file_comment` arguments are deprecated — "Specify only `channel`
and `timestamp`." Skin tones as `thumbsup::skin-tone-6`. Emits a `reaction_added` event.
`reactions.get` is Tier 3; `reactions.list` (reactions made *by* a user) is Tier 2, cursor-paginated.
Sources: <https://docs.slack.dev/reference/methods/reactions.add>,
<https://docs.slack.dev/reference/methods/reactions.get>,
<https://docs.slack.dev/reference/methods/reactions.list>

### 3.8 "Unread" and "what needs my attention" — there is no such API

The complete Web API method index contains **no `activity.*` and no `mentions.*` endpoint**.
Filtering the index for `activity|mention|unread|mark|star|reminder` yields only
`admin.analytics.messages.activity` (an org-admin analytics export, not a per-user feed),
`conversations.mark`, `reminders.*`, `stars.*`, `search.*` and `assistant.*`.
Source: <https://docs.slack.dev/reference/methods>

What does exist, and its limits:

- **`conversations.mark`** (POST, Tier 3) *sets* the read cursor; it does not read it. It works
  with a bot token — the docs note drily, "We don't know why bot users would want to move their
  read cursor but it can be done" — and requires that "The associated user must be a member of the
  channel." This is a **write** that mutates the person's Slack state, and should be behind the
  gate or simply not offered.
  Source: <https://docs.slack.dev/reference/methods/conversations.mark>
- **`unread_count`, `unread_count_display`** on `conversations.info` and `conversations.list` are
  "included for **DM conversations only**". There is no per-channel unread count for regular
  channels. `last_read` appears in DM/IM payloads and on `conversations.replies` thread parents
  (alongside a thread-level `unread_count` and `subscribed`), but is not documented as a
  schema-guaranteed field.
  Sources: <https://docs.slack.dev/reference/methods/conversations.info>,
  <https://docs.slack.dev/reference/methods/conversations.list>
- All of this reflects **the token owner's** read state. A bot token has its own read cursor, which
  is not the person's.

So "what needs my attention" has to be derived by us, from events plus our own cursor — the same
shape as the existing `gmail-follow-ups` skill, which already computes a waiting-on view rather
than reading one from the provider.

---

## 4. Rate limits and pagination

### 4.1 The tier system

Limits are applied "per API method per workspace/team per app."

| Tier | Limit | Wording |
|---|---|---|
| Tier 1 | **1+ per minute** | "Access tier 1 methods infrequently. A small amount of burst behavior is tolerated." |
| Tier 2 | **20+ per minute** | "Most methods allow at least 20 requests per minute, while allowing for occasional bursts of more requests." |
| Tier 3 | **50+ per minute** | "Tier 3 methods allow a larger number of requests and are typically attached to methods with paginating collections of conversations or users. Sporadic bursts are welcome." |
| Tier 4 | **100+ per minute** | "Enjoy a large request quota for Tier 4 methods, including generous burst behavior." |
| Special | varies | "Rate limiting conditions are unique for methods with this tier." |

Other documented caps on the same page: posting messages 1/second ("Short bursts >1 allowed. If
you attempt bursts, there is no guarantee that messages will be stored or displayed to users");
incoming webhooks 1/second; Events API **30,000 deliveries per workspace/team per app per 60
minutes**; `users.profile.set` 10 updates/minute for one user and 30 profiles/minute per token;
`rtm.start`/`rtm.connect` no more than 1/minute.

Two lines worth building against:

> "We do recommend you design your apps with a limit of **1 request per second** for any given API
> call, knowing that we'll allow it to go over this limit as long as this is only a temporary
> burst."

> "For methods supporting cursored pagination, the rate limit given applies when you're *using*
> pagination. If you're not, you'll receive **stricter** rate limits."

Slack states outright that it does not publish precise burst ceilings, so those are **not
verified** and cannot be planned against.

`chat.postMessage`'s Special tier, verbatim: "generally allow an app to post 1 message per second
to a specific channel. There are limits governing your app's relationship with the entire
workspace above that, limiting posting to several hundred messages per minute. Generous burst
behavior is also granted."

Sources: <https://docs.slack.dev/apis/web-api/rate-limits>,
<https://docs.slack.dev/reference/methods/chat.postMessage>

### 4.2 What a 429 carries

> "Slack will return a `HTTP 429 Too Many Requests` error, and a `Retry-After` HTTP header
> containing the number of seconds until you can retry."

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
```

The penalty is scoped narrowly, and that is exploitable: the wait "instructs your app to wait 30
seconds before attempting to call `conversations.info` with any token awarded to your app from
this workspace… **Calls to other methods on behalf of this workspace are not restricted. Calls to
the same method for other workspaces for this app are also not restricted.**" So back off per
`(method, workspace)`, not globally.

Every method's error table lists `ratelimited` — "The request has been ratelimited. Refer to the
`Retry-After` header for when to retry the request." A related `accesslimited` ("Access to this
method is limited on the current network") also appears.

The exact JSON body accompanying a 429 is **not verified** — the docs show only the status line
and header. Branch on HTTP 429 plus `Retry-After`, not on a body shape.

Over the Events API cap, apps receive an **`app_rate_limited`** event:
`{"token":…,"type":"app_rate_limited","team_id":"T123456","minute_rate_limited":1518467820,"api_app_id":"A123456"}`.

Source: <https://docs.slack.dev/apis/web-api/rate-limits>

### 4.3 The `conversations.history` change — announced once, amended twice

This is the most version-dependent fact in this document, and most third-party write-ups (and
current web search results) still report a superseded version of it.

**Timeline, all verified:**

| Date | What changed | Source |
|---|---|---|
| 29 May 2025 | Announced. Tier 3 → **Tier 1** for commercially distributed non-Marketplace apps: **1 request/minute**, `limit` max *and* default cut to **15 objects**. Applied immediately to new apps and new installations. | <https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps> |
| 3 June 2025 | Clarified: "Any **internal customer-built apps** will maintain their existing rate limits and will not be subject to the new posted limits." | <https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity> |
| through ~Aug 2025 | Existing installs were to be swept in on **2 September 2025**. | Wayback captures `20250721142026`, `20250810123316` of the 29 May page |
| by 10 Sep 2025 | That date was struck through and replaced by **3 March 2026**. | Wayback `20250910113039`, `20251008170049`, `20260212015812` |
| between 12 Feb and 10 Mar 2026 | The deadline was **removed entirely**; the text became "The new rate limits **will not** be applied to existing installations…". | Wayback `20260212015812` (still 3 March) vs `20260310161620` (removed) |
| 19 Sep 2026 | Reversal still in force. | live fetch |

**Current state, verbatim from both method pages today:**

> "As of May 29, 2025, for new applications and installation commercially distributed outside of
> the Marketplace, this method is rate limited to **1 request per minute**. The maximum and default
> values for the `limit` parameter have both been reduced to **15 objects**. For Marketplace and
> internal customer-built applications, this method has **Tier 3** rate limits. **Existing
> installations of applications published and distributed outside the Slack Marketplace will not
> be subject to the new posted limits.**"

Sources: <https://docs.slack.dev/reference/methods/conversations.history>,
<https://docs.slack.dev/reference/methods/conversations.replies>,
<https://docs.slack.dev/apis/web-api/rate-limits>

**Who is affected:**

| App posture | `conversations.history` / `.replies` today |
|---|---|
| Internal customer-built (single workspace, not distributed) | **Tier 3**, 50+/min, `limit` max 999–1000. Explicitly exempt. |
| Marketplace-approved | **Tier 3**. Unaffected. |
| Commercially distributed, not Marketplace-approved — new app or new install | **Tier 1**: 1 req/min, `limit` max and default **15**. |
| Unlisted, pre-existing installation | Not subject — grandfathered, indefinitely, as of today. |

Three things not to get wrong:

1. **The trigger is commercial distribution, not newness.** An internal app built by a person for
   their own workspace keeps Tier 3 regardless of when it was created. Slack's stated rationale is
   anti-exfiltration: these methods "in the hands of unvetted applications … have the potential to
   exfiltrate large amounts of sensitive conversational data."
2. **1 req/min × 15 messages = 900 messages/hour, per app, across all channels.** Backfill is
   infeasible under that budget. Slack says as much and points elsewhere: "consider the other ways
   the platform may provide to get the kind of focused, contextual information an app typically
   requires, such as the Events API or the forthcoming Real-time Search API."
3. **The grandfathering is a reprieve, not a guarantee.** Slack twice set a sweep-in date and twice
   pulled it, **silently** — no changelog entry among all 41 of 2026's entries announces the
   reversal; it was edited into the May 2025 page in place. Instrument for a Tier 1 fallback.

A related obstacle for anyone planning to escape Tier 1 via the Marketplace: "As of July 2026, we
require that apps submitting to the Slack Marketplace have at least **10 installations on active
workspaces**… Your app needs to stay at 10 or more installed workspaces throughout the entire
duration of the review."
Source: <https://docs.slack.dev/changelog/2026/09/01/slack-marketplace-install-requirement>

And a separate, stricter limit applies when these methods are used to supplement search: "When
using the `conversations.history` method and the `conversations.replies` method to supplement
search with the user token, the rate limits will be limited **5 requests per minute with 100
messages per request**."
Source: <https://docs.slack.dev/reference/methods/assistant.search.context>

### 4.4 Free workspaces — retention, not rate limits

A separate mechanism, often conflated with the above. From Slack's help centre:

- "You can view and search messages and files from the **last 90 days**."
- Older content is hidden rather than immediately deleted: "Slack will start hiding messages and
  files older than 90 days to make room for new ones."
- Hard deletion now exists: "Messages and files more than **one year** old will be permanently
  deleted," and "Starting **August 26, 2024**, Customer Data — such as messages and file history —
  older than one year may be deleted on a rolling basis from workspaces on the free plan."

Source: <https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces>

Whether the API can reach the 90-day-to-1-year band that the client hides is **not verified**. The
only API signal is `is_limited` on `conversations.history`: "only included for free teams that have
reached the free message limit. If true, there are messages before the current result set, but
they are beyond the message limit."
Source: <https://docs.slack.dev/reference/methods/conversations.history>

### 4.5 Cursor pagination and its quirks

- "Cursor-paginated methods accept `cursor` and `limit` parameters."
- `response_metadata.next_cursor` appears "*when there are additional results to be retrieved*". An
  empty string, null, or absent `next_cursor` means done.
- `limit` is a **maximum**, not a target. Recommended 100–200; "The `limit` parameter maximum is
  `1000` and subject to change and may vary per method."
- **The headline quirk:** "It's possible to receive *fewer* results than your specified `limit`,
  even when there are additional results to retrieve. **Avoid the temptation to check the size of
  results against the limit to conclude the results have been completely returned.** Instead,
  check the `next_cursor` value…"
- **Encoding trap:** "Cursor strings typically end with the `=` character… When presenting this
  value as a URL or POST parameter, it *must* be encoded as `%3D`."
- **Expiry:** "Cursors expire and are meant to be used within a reasonable amount of time… do not
  persist cursors for hours or days." Stale or garbled → `invalid_cursor`, "the only error
  specific to pagination."
- "Invalid `limit` values are currently magically adjusted to something sensible."
- "Enhanced rate limiting conditions are provided when using cursor-based pagination."

Source: <https://docs.slack.dev/apis/web-api/pagination>

**Three pagination families coexist**: cursor-based; classic timeline (`oldest` / `latest` /
`inclusive`, as on `conversations.history`, which supports both simultaneously — "This form of
pagination can be used in conjunction with cursors"); and classic page/count (`search.*`,
`files.list`).

The pagination page's own list of cursor-supporting methods is stale — it omits
`users.conversations` and `chat.scheduledMessages.list`, both of which document `next_cursor` on
their own pages. That page states the rule that resolves this: "The individual documentation for
each API method is your source of truth for which pattern the method follows."

---

## 5. Events and real-time

### 5.1 The three things are not three peers

The Events API is the product; **Socket Mode** and **HTTP Request URLs** are its two delivery
transports. RTM is a separate, legacy WebSocket API.

> "The Events API is a streamlined way to build apps and bots that respond to activities in Slack.
> When you use the Events API, *Slack* calls *you*."

Source: <https://docs.slack.dev/apis/events-api>

**Neither the Events API nor Socket Mode is deprecated.** No deprecation language appears on either
page.

**RTM is effectively closed to new apps.**

- "New Slack apps may not use any Real Time Messaging API method." —
  <https://docs.slack.dev/reference/methods/rtm.connect/>
- "Granular permission Slack apps cannot use the RTM API." / "Classic apps can, but be warned that
  they may no longer be created and are soon to be deprecated." / "For most applications, Socket
  Mode is a better way to communicate with Slack." / "Many workspace administrators will not allow
  apps and integrations using the RTM API due to the overly permissive permission scopes required."
  — <https://docs.slack.dev/legacy/legacy-rtm-api/>

The dates, because most secondary sources get them wrong:

- **June 2024** — new classic apps and legacy custom-integration bot users can no longer be created.
- **31 March 2025** — announced date on which "legacy custom bots will no longer function".
- **16 November 2026** — announced date on which "classic apps will no longer function".
  Source for all three: <https://docs.slack.dev/changelog/2024-09-legacy-custom-bots-classic-apps-deprecation/>
- **8 December 2025 — that classic-app deprecation was paused.** "we have decided to pause this
  migration"; "Classic apps will continue to work for the foreseeable future but are still
  considered a legacy method"; "new classic apps cannot be created". No replacement date given.
  Source: <https://docs.slack.dev/changelog/2025/12/08/classic-apps-deprecation-paused/>

There is **no dated retirement notice for the RTM API itself**; it dies with classic apps, and that
timeline is currently paused. Any RTM-specific shutdown date is **not verified** because none
exists.

### 5.2 Socket Mode — yes, a local agent with no public URL can receive events

This is the answer to the central question in this group.

**Requirements:**

| Requirement | Detail |
|---|---|
| App-level token | `xapp-` prefix. "Your app-level token allows your app … to generate a WebSocket URL for communication with Slack via the `apps.connections.open` method." |
| Scope | `connections:write` — "Grants permission to generate websocket URIs and connect to Socket Mode". Token type: **App-level**. |
| App type | "Socket Mode is **only** available for apps using granular permissions" — i.e. modern apps, not classic. |
| Setup | Toggle "Enable Socket Mode", then Basic Information → App-level tokens → generate. |

Sources: <https://docs.slack.dev/apis/events-api/using-socket-mode>,
<https://docs.slack.dev/reference/scopes/connections.write/>

Call `apps.connections.open` with the app-level token **in the HTTP `Authorization` header**
("passing it as a POST parameter will result in an error"); it returns a temporary
`wss://wss-….slack.com/link/?ticket=…&app_id=…` URL. Tier 3.
Source: <https://docs.slack.dev/reference/methods/apps.connections.open/>

*Documentation inconsistency:* the `apps.connections.open` page says "Scopes: *No scopes
required*", while the `connections:write` page says that scope is what grants permission to call
it. The practical reading is that `connections:write` is attached to the app-level token at
generation time, and the method page's "no scopes" refers to OAuth scopes on bot/user tokens.

**No public URL needed:**

> "Socket Mode allows your app to use the Events API and interactive features—*without* exposing a
> public HTTP Request URL."
>
> "Socket Mode helps developers working behind a corporate firewall, or who have other security
> concerns that don't allow exposing a static HTTP endpoint."

> "We recommend using Socket Mode when developing your app and using it locally."

Sources: <https://docs.slack.dev/apis/events-api/using-socket-mode>,
<https://docs.slack.dev/apis/events-api/comparing-http-socket-mode>

The connection is outbound, so a laptop behind NAT works. Slack never uses the words "NAT" or
"localhost" on these pages — that specific phrasing is **not verified** — but the mechanism is
unambiguous.

**Limits and behaviour:**

- "Socket Mode allows your app to maintain **up to 10** open WebSocket connections at the same
  time." This is **per app**, which matters if one shared app is installed across many laptops; if
  each person creates their own internal app, each gets its own 10.
- "Connections refresh regularly." Slack sends a `refresh_requested` message and "You may receive a
  warning about 10 seconds before the disconnect." Rolling reconnect is required; Bolt handles it.
- Slack's own caveats: "Long-lived connections vulnerable to network disruptions"; "Occasional
  reliability issues from container recycling"; "To have the highest possible reliability for
  application connectivity, we recommend using HTTP for production applications."

Sources: <https://docs.slack.dev/apis/events-api/using-socket-mode>,
<https://docs.slack.dev/apis/events-api/comparing-http-socket-mode>

**The sharp edge — Marketplace incompatibility:**

> "Apps using Socket Mode are *not* currently allowed in the public Slack Marketplace."
>
> "If you intend to submit your app to be available for use in the Slack Marketplace, using HTTP is
> a requirement."

But distribution as such is fine: "Socket mode is fully supported for distributed apps."

Sources: <https://docs.slack.dev/apis/events-api/using-socket-mode>,
<https://docs.slack.dev/apis/events-api/comparing-http-socket-mode>

So an OAuth install link plus Socket Mode works; a Marketplace *listing* plus Socket Mode does not.
That collides directly with §4.3: Marketplace approval is what restores Tier 3
`conversations.history` for a distributed app. The way out of the collision is the third category —
**internal customer-built apps are exempt from the Tier 1 cap and can use Socket Mode** — which
points at a "bring your own Slack app" install model.

### 5.3 Events relevant to reading

| Event | Scope | Transport |
|---|---|---|
| `message` (generic) | one of `channels:history`, `groups:history`, `im:history`, `mpim:history` | Events API + RTM |
| `message.channels` | `channels:history` | Events API only |
| `message.im` | `im:history` | Events API |
| `message.groups` | `groups:history` | Events API |
| `message.mpim` | `mpim:history` | Events API |
| `app_mention` | `app_mentions.read` | Events API only |
| `reaction_added` | `reactions:read` | Events API and RTM |

Sources: <https://docs.slack.dev/reference/events/message/>,
<https://docs.slack.dev/reference/events/message.channels/>,
<https://docs.slack.dev/reference/events/message.im>,
<https://docs.slack.dev/reference/events/app_mention/>,
<https://docs.slack.dev/reference/events/reaction_added/>.
The dedicated pages for `message.groups` and `message.mpim` were not read individually; their
scopes are inferred from the generic `message` event page and are **not verified** at the
per-event-page level.

**Membership is required, effectively:**

> "Subscribe your Slack apps to events related to channels and direct messages **they are party to**."
>
> "You will only receive events that users who have authorized your app can 'see' on their
> workspace (that is, if a user authorizes access to private channel history, you'll only see the
> activity in private channels they are a member of, not all private channels across the
> workspace)."
>
> Bot events: "you'll only receive events perspectival to your bot user."

Also: "Some event types are not available in bot user subscriptions."

Source: <https://docs.slack.dev/apis/events-api/>

Delivery rules on the same page: respond within 3 seconds with HTTP 2xx; failed deliveries retry up
to 3 times with exponential backoff; at least a 5% response success rate per 60 minutes must be
maintained to avoid being disabled (exceptions under 1,000 events/hour); events older than 2 hours
are not delivered unless Delayed Events is enabled.

### 5.4 User-perspective events

Slack splits event subscriptions into two categories, and the first is the user-perspective one:

> **Workspace events**: require "a corresponding OAuth scope, and are perspectival to a member
> installing your application."
>
> **Bot events**: "subscribe to events on behalf of your application's bot user".

Source: <https://docs.slack.dev/apis/events-api/>

In the app config UI this is the "Subscribe to events on behalf of users" section, as opposed to
"Subscribe to bot events". So installing with **user** token scopes (`im:history`,
`channels:history`, `groups:history`, `mpim:history`) and subscribing under the user section should
deliver `message.im` and friends for the installing person's own conversations — the thing RTM with
a user token used to do, over the modern Events API.

Honesty markers, because this is load-bearing for the design:

- The two-category model and the perspectival wording are **verified** on the Events API page.
- An end-to-end official walkthrough of "receive a person's own DMs with a user token in 2026" was
  **not found — not verified.** Treat as high-confidence but unconfirmed and test empirically
  before the spec depends on it.
- Whether user-perspective events are guaranteed to be delivered over **Socket Mode specifically**
  is **not verified** (Socket Mode is documented as a transport for the Events API generally, which
  implies yes).

### 5.5 Is polling viable?

It depends entirely on the app posture from §4.3.

- **Internal app (each person creates their own).** `conversations.history` is Tier 3, 50+/min. One
  sweep of N channels costs N requests. 20 channels once a minute is about 40% of budget — workable
  but wasteful; 50 channels saturates it, leaving nothing for `conversations.replies`,
  `conversations.list` (Tier 2) or `users.info`. Threads multiply the cost, one
  `conversations.replies` per active thread.
- **Distributed, non-Marketplace.** 1 request/minute, 15 messages per request, total. A sweep of 30
  channels takes 30 minutes and cannot backfill anything busy. **Polling is not viable.**
- **Marketplace-approved.** Tier 3 restored — but Socket Mode is then unavailable.

Slack does not use the words "do not poll" anywhere that was found (**not verified**); the
discouragement is structural — the push model ("When you use the Events API, *Slack* calls *you*")
and the 1/min cap. For genuinely high volume the rate-limits page suggests leaving Slack entirely:
"Other services provide an interface for logging, searching, aggregating, and archiving messages at
higher throughputs. These include Papertrail, Loggly, Splunk and LogStash."
Sources: <https://docs.slack.dev/apis/events-api>, <https://docs.slack.dev/apis/web-api/rate-limits>

---

## 6. Safety-relevant specifics

### 6.1 What a message can carry

A message is a JSON object. The content-bearing fields are:

- **`text`** — plain or `mrkdwn`.
- **`blocks`** — Block Kit layout, up to **50 blocks per message** (100 in modals and Home tabs).
- **`attachments`** — legacy secondary content.

Sources: <https://docs.slack.dev/messaging/>, <https://docs.slack.dev/block-kit/>

**`mrkdwn`** is "Slack's custom text formatting syntax. It is inspired by markdown, but uses
different rules": `*bold*`, `_italic_`, `~strike~`, backtick code, triple-backtick blocks, `\n`
for line breaks. Three characters are control characters and must be HTML-escaped when they are
not meant to be parsed: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
Source: <https://docs.slack.dev/messaging/formatting-message-text>

The dangerous syntax in `mrkdwn`:

- **`<https://example.com|label text>`** — a link whose visible label is arbitrary and unrelated to
  its destination. This is the classic phishing primitive, and it is first-class syntax.
- **`<!here>`, `<!channel>`, `<!everyone>`** — broadcast pings. Slack's own docs warn about the
  interaction with untrusted input: "If this user text contained a string like `@everyone`, your
  app could unintentionally send a notification to the entire workspace", and recommend disabling
  automatic parsing and using explicit ID syntax instead.
- **`<@U012AB3CD>`**, **`<#C123ABC456>`**, **`<!subteam^SAZ94GDB8>`** — user, channel and
  user-group references by ID.

Source: <https://docs.slack.dev/messaging/formatting-message-text>

**Block Kit** blocks can carry interactive elements — "Elements include interactive components
such as buttons, menus and text inputs" — and require no additional scope: "There's no special
setup needed to start using blocks."
Source: <https://docs.slack.dev/block-kit/>

A `rich_text` block nests `rich_text_section`, `rich_text_list`, `rich_text_quote` and
`rich_text_preformatted` elements, which can be "deeply nested". A `rich_text_section` can contain
23 element types, including `link`, `broadcast`, `user`, `usergroup`, `channel`, `emoji`, `date`,
`color`, `team`, `file`, `canvas`, `citation`, `tag`, and various mention types.
Source: <https://docs.slack.dev/reference/block-kit/blocks/rich-text-block>

The `link` element carries **`url`** ("URL to link to") and a separate **`text`** ("The text to
link") — confirming at the structured level the same label/destination divergence that `mrkdwn`
allows. It also carries an `unsafe` boolean whose meaning is documented as "TODO: ?" — i.e.
Slack's own reference does not say what it does.
Source: <https://docs.slack.dev/tools/node-slack-sdk/reference/types/interfaces/RichTextLink/>

**Attachments are legacy.** "This feature is a legacy part of messaging functionality for Slack
apps. We recommend you stick with layout blocks, but if you still want to use attachments, read
our caveats" — and these legacy options "may be subject to reductions in visibility or
functionality". Attachment fields include `fallback`, `color`, `pretext`, `title`, `title_link`,
`text`, `fields`, `image_url` and `mrkdwn_in`.
Source: <https://docs.slack.dev/legacy/legacy-messaging/legacy-secondary-message-attachments/>

**What an agent must never construct blindly:** broadcast mentions, label/destination-divergent
links, and blocks containing interactive elements. An agent composing a message should emit plain
text through a sanitiser that escapes `&`, `<`, `>`, refuses `<!here|channel|everyone>` unless the
person asked for them by name, and either forbids blocks entirely or restricts them to a
whitelist of non-interactive types.

### 6.2 Can a posted message be edited or deleted?

Yes — and this is the one place Slack is materially less final than email.

- **`chat.update`** — scope `chat:write` (bot and user), **Tier 3**. "Only messages posted by the
  authenticated user are able to be updated using this method." An `edit_window_closed` error
  exists, governed by "team message edit settings".
  Source: <https://docs.slack.dev/reference/methods/chat.update>
- **`chat.delete`** — scope `chat:write` (bot and user), **Tier 3**. A user token can delete what
  that person could delete in the client; a bot token can only delete messages it posted. It "has
  no accommodations for impersonation". Errors include `cant_delete_message` and
  `message_not_found`. No time limit is documented on the method page.
  Source: <https://docs.slack.dev/reference/methods/chat.delete>

The window is a **workspace setting, not a fixed API rule**. Workspace Owners and Admins (and Org
Owners/Admins for a whole Grid org) choose "when to allow message editing: any time, never, or up
to a certain timeframe", and Workspace Owners decide which role types can delete their own
messages.
Source: <https://slack.com/help/articles/115004868646-Manage-permissions-for-message-editing-and-deletion>

Defaults: "by default, any member can edit their messages" and "By default, any member can delete
their messages, but owners can restrict this permission." Separately, the client's *unsend*
feature has a 15-second window, but that is a client affordance, not an API one.
Source: <https://slack.com/help/articles/202395258-Edit-or-delete-messages>

The exact list of selectable time windows (one minute / five minutes / thirty minutes / one hour /
24 hours / one week) comes from a third-party write-up, not from Slack's own article, and is
therefore **not verified**.

Two practical consequences:

- **We cannot assume a retraction will succeed.** A workspace can be configured so that edits are
  never permitted and deletes are admin-only. Retraction is a best-effort mitigation, never part
  of the safety argument.
- **An edit by an app leaves no visible trace.** Per `chat.update`, bot-posted messages do not
  display an "(edited)" label, while human-edited messages do. Whether that also holds for a
  *user*-token edit of the person's own message is **not verified** — worth testing, because if a
  user-token edit is silent, an agent could rewrite history under the person's name invisibly.

### 6.3 The hidden-text problem

Slack has several analogues of email's hidden-text problem, and one of them is worse.

**(a) `text` and `blocks` diverge.** When `blocks` are present, `text` is "used as a fallback
string to display in notifications". The rendered message a human sees is the blocks; the `text`
field is what a naive API consumer reads first. Slack's Block Kit guidance states the text field
"won't render in messages in Slack clients as long as `blocks` is also provided, but it will show
up as the fallback text in notifications", and that screen readers "will default to the top-level
`text` field ... and will not read the content of any interior blocks".
Sources: <https://docs.slack.dev/reference/methods/chat.postMessage> (fallback role, verbatim);
<https://api.slack.com/messaging/composing/layouts> (the non-rendering statement was read via
search result summary rather than the page itself, because the page serves a client-side shell —
treat the exact wording as **not verified**, though the substance is corroborated by the
`chat.postMessage` reference)

That divergence runs in both directions and both are hazardous:
*reading* — an attacker puts benign content in `text` and hostile instructions in `blocks`, or
vice versa, and the agent and the human see different messages;
*writing* — an agent-composed message could be previewed to the human as `text` while `blocks`
carry something else. Our preview must render exactly what will be posted, from the same payload.

**(b) Link unfurls inject third-party content into a message.** Slack "automatically crawls URLs
and displays previews using OpenGraph or X Card metadata", and app unfurls attach Block Kit
content to someone else's message via `chat.unfurl`. Content that was never written by the message
author therefore becomes part of the message a human sees and an agent reads.
Source: <https://docs.slack.dev/messaging/unfurling-links-in-messages>

**(c) Slack says this out loud for LLMs.** The unfurling page carries: "Consider disabling link
unfurls when working with messages from an LLM in your app." The security page is more explicit:

> "The risk of data exfiltration is significantly higher when an LLM is acting on behalf of a user
> within an AI-integrated app."

with these mitigations, verbatim:

> "Your app must be able to recognize messages originating from an LLM and enforce a strict policy
> on how it responds to them."
>
> "We recommend disabling link unfurling by default. When posting messages containing URLs that
> the LLM may have generated, explicitly disable link unfurling by setting the appropriate flag in
> the `chat.postMessage` API call."
>
> "Include explicit, non-negotiable instructions in your system prompt that prohibit: Ignoring
> previous instructions. Accessing or generating URLs with query parameters containing sensitive
> user/conversation data. Encoding/transmitting private data."

Sources: <https://docs.slack.dev/messaging/unfurling-links-in-messages>,
<https://docs.slack.dev/concepts/security>

Note that `unfurl_links` and `unfurl_media` **default to `true`**; suppressing unfurls is an
explicit opt-out on every call.
Source: <https://docs.slack.dev/messaging/unfurling-links-in-messages>

**(d) Invisible characters in `mrkdwn`.** Slack does not document any defence against zero-width
or bidirectional Unicode in message text, and no such guidance was found. Whether Slack strips or
normalises invisible characters is **not verified**; assume it does not, and normalise on our side
as the Gmail sanitiser already does.

Slack's security page also mentions **IP allowlisting** for tokens — "You can add up to 20 entries.
Each entry specifies either a CIDR range of IP addresses or a single IP address" — with unlisted
requests rejected as `{"ok": false, "error": "invalid_auth"}`. Not usable from a roaming laptop,
but worth noting for anyone running this on a fixed host.
Source: <https://docs.slack.dev/concepts/security>

### 6.4 Identity on a message, and how far to trust it

An app-posted message carries the `bot_message` subtype with `bot_id`, an optional `username`
override, optional `icons`, `text` and `ts` — and **no `user` field**, because bot messages have
"no associated user". "You can detect if a message was sent by a bot by the presence of the
`bot_id` and `bot_profile` fields in the event payload."
Source: <https://docs.slack.dev/reference/events/message/bot_message>

So the *mechanical* distinction between human and app is reliable: `bot_id` / `bot_profile`
present means an app posted it. The `user` field on an ordinary message is a Slack user ID and is
assigned by Slack.

The **display** is not reliable. With `chat:write.customize`, an app sets `username` and `icons`
freely, so a message can render with any name and avatar it likes while carrying a `bot_id` that
identifies the real author only to something inspecting the payload. A human skimming the channel
sees the impersonation; an agent reading the API sees the truth — provided it looks. Any
attribution our system shows a person must be derived from `bot_id`/`user`, never from `username`.

For external people in Slack Connect channels: "there is no single property to substantiate if the
user is external or not: you must deduce it from a combination of the `is_stranger` and the
`team_id` property." Channels carry `is_ext_shared`. External profiles omit locale information,
and `username` must not be used as a unique identifier for external users.
Source: <https://docs.slack.dev/apis/slack-connect>

### 6.5 Enterprise Grid

An Enterprise organisation is "a network of two or more Slack workspace instances", each with its
own ID, member directory, channels and files, and some channels shared between workspaces in the
org.
Source: <https://docs.slack.dev/enterprise-grid>

What changes:

- **Install scope.** Apps can be installed per workspace, or **org-wide**. Org-wide apps are
  "installed once at the organization level" and have "a single token that represents the
  permissions for the app on multiple workspaces"; "Org Admins can then add it to workspaces in
  the organization without further authorization."
  Source: <https://docs.slack.dev/enterprise/organization-ready-apps>
- **`is_enterprise_install`** appears in the OAuth response, indicating "whether the installation
  happened on an organization, as opposed to an individual workspace".
- **`enterprise_id`** appears alongside `team_id` in API methods and events.
- **User IDs** are global and may begin with `U` *or* `W`.
- **`team_id` becomes a required parameter** on 25+ methods for organisation-ready apps,
  including `conversations.list`, `users.list` and `search.messages`.
- **`context_team_id`** indicates which workspace a channel belongs to.
- `users.info` should be preferred over relying on `users.list`.
- Org Admins manage app deployment; individual users do not install independently at org level.

Source: <https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/>

For us this means: a Grid deployment cannot be assumed to be a single workspace, `team_id` must be
threaded through calls, user IDs must not be assumed to start with `U`, and the person may have no
ability to self-install at all. Whether a Grid member can still install a personal app to a single
workspace within the org depends on the Org Owner's app management policy — and if such a policy
is set, workspace-level approval is forced on.
Source: <https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace>

---

## 7. Prior art

### 7.1 There is an official Slack MCP server

Announced **17 February 2026**, alongside the Real-time Search API.
Source: <https://docs.slack.dev/changelog/2026/02/17/slack-mcp>

| Attribute | Detail |
|---|---|
| Endpoint | `https://mcp.slack.com/mcp` |
| Transport | "JSON-RPC 2.0 over Streamable HTTP." "We do not support SSE-based connections or Dynamic Client Registration at this time." |
| Auth | Confidential OAuth, **user tokens**. Authorise at `https://slack.com/oauth/v2_user/authorize`; token at `https://slack.com/api/oauth.v2.user.access`. Discovery at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. |
| Eligibility | "Only directory-published apps or internal apps may use MCP"; "unlisted apps are prohibited from using MCP." Requires a fixed app ID so admins can approve through the normal app-approval process. |
| Admin control | "Workspace admins can approve and manage all MCP client integrations." "Audit MCP activity with the associated audit logs." IP allowlists apply. |
| Known clients | Claude.ai, Claude Code, Perplexity, Cursor. |

Source: <https://docs.slack.dev/ai/slack-mcp-server/>

Its tool-to-scope matrix, as published: search messages/channels (`search:read.public`,
`search:read.private`, `search:read.mpim`, `search:read.im`); search files (`search:read.files`);
read files (`files:read`); search emoji (`emoji:read`); search users (`search:read.users`);
**send message (`chat:write`)**; read a channel/thread (`channels:history`, `groups:history`,
`mpim:history`, `im:history`); create conversation (`channels:write`, `groups:write`, `im:write`,
`mpim:write`); add reactions (`reactions:write`); canvases (`canvases:read`, `canvases:write`);
user profile/email (`users:read`, `users:read.email`); list channel members and user channels
(`*:read`); lists (`lists:read`, `lists:write`); upload a file (`files:write`).
Source: <https://docs.slack.dev/ai/slack-mcp-server>

**Does it gate sending? No enforced gate is documented.** Slack's own feature list contains both:

> "Send messages — send messages to any type of conversation in Slack."
>
> "**Draft messages — draft, format, and preview messages directly within AI clients.**"

Source: <https://docs.slack.dev/ai/slack-mcp-server/>

So Slack has named the draft-then-send shape — but the drafting is described as happening *within
the AI client*, and "Send message" remains an independently callable tool backed by `chat:write`.
No confirmation requirement, approval token, or draft→send state machine is described between
them. That a human must confirm before a send is **not verified** as existing; the reading here is
that it does not. The governance Slack does provide is coarser: admin approval of the whole MCP
integration, and audit logs after the fact.

Two consequences for us. First, the enforcement gap is real and unclaimed. Second, **the official
server is not available as a plumbing layer for an unlisted open-source app** — "unlisted apps are
prohibited from using MCP" — so we cannot simply wrap it.

### 7.2 The Anthropic reference server — archived

"This repository was archived by the owner on **29 May 2025**. It is now read-only." It moved to
`modelcontextprotocol/servers-archived`.

- Tools (8): `slack_list_channels`, `slack_post_message`, `slack_reply_to_thread`,
  `slack_add_reaction`, `slack_get_channel_history`, `slack_get_thread_replies`, `slack_get_users`,
  `slack_get_user_profile`.
- Bot scopes (6): `channels:history`, `channels:read`, `chat:write`, `reactions:write`,
  `users:read`, `users.profile:read`.
- **Gating: none.** `slack_post_message` takes a channel ID and message text and posts, with no
  intermediary review step.

Source: <https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack>

This is the ancestor of most community servers, which is why the no-gate pattern is so widespread.

### 7.3 `korotovsky/slack-mcp-server` — the most safety-conscious community server

Source: <https://github.com/korotovsky/slack-mcp-server>

- **Auth:** one of an `xoxp-` user token, an `xoxb-` bot token, or **`xoxc-` + `xoxd-` browser
  session tokens**, in priority order `xoxp > xoxb > xoxc/xoxd`. The session-token route requires
  no Slack app registration and no admin approval — its entire appeal, and its entire risk. With
  session tokens it calls Slack's internal edge API (e.g. `client.counts`).
- **Tools (~18).** Read: `conversations_history`, `conversations_replies`, `channels_list`,
  `conversations_search_messages`, `users_search`, `usergroups_list`, `conversations_unreads`,
  `saved_list`. Write: `conversations_add_message`, `reactions_add`, `reactions_remove`,
  `usergroups_*`, `conversations_mark`, `saved_update`, `saved_clear_completed`.
- **Gating: partial, and the best prior art — but a static config flag, not a per-send approval.**

> "The `conversations_add_message` tool is **disabled by default for safety**."

`SLACK_MCP_ADD_MESSAGE_TOOL` (default disabled) "Enable message posting via
`conversations_add_message` by setting it to `true` for all channels, a comma-separated list of
channel IDs to whitelist specific channels, or use `!` before a channel ID to allow all except
specified ones." Related flags: `SLACK_MCP_ADD_MESSAGE_MARK`, `SLACK_MCP_ADD_MESSAGE_UNFURLING`
(boolean or a domain whitelist), `SLACK_MCP_MARK_TOOL`, `SLACK_MCP_ATTACHMENT_TOOL`,
`SLACK_MCP_ENABLED_TOOLS`. Reaction tools "are not registered by default to prevent accidental
exposure."
Source: <https://github.com/korotovsky/slack-mcp-server/blob/master/docs/03-configuration-and-usage.md>

The distinction that matters: this is **ambient authority scoped by configuration**. Once the flag
is `true`, the model sends freely. A channel allowlist is not an approval loop.

Slack has also been observed invalidating `xoxc`/`xoxd` tokens when the server caches users
(<https://github.com/korotovsky/slack-mcp-server/issues/86> — issue title only; the thread was not
read, so the contents are **not verified**).

### 7.4 Other community servers

**`zencoderai/slack-mcp-server`** — an explicit fork of the archived Anthropic server, same 8
tools, same 6 bot scopes, stdio and Streamable HTTP transports. **Gating: none** — "No approval
mechanism exists."
Source: <https://github.com/zencoderai/slack-mcp-server>

**`ubie-oss/slack-mcp-server`** — 9 tools including `slack_search_messages`; requires both
`SLACK_BOT_TOKEN` and `SLACK_USER_TOKEN` (the user token for search). Exact scopes are not
enumerated in the README — **not verified**. **Gating: none for sends**, but it has one read-side
guardrail whose *posture* is exactly right: `SLACK_SAFE_SEARCH` "automatically excludes private
channels, DMs, and group DMs from search results. **This is enforced server-side and cannot be
overridden by clients.**" Applied only to search, never to posting.
Source: <https://github.com/ubie-oss/slack-mcp-server>

**`jtalk22/slack-mcp-server`** — the only one that engages with approval as a protocol concern.
Extracts the newest `xoxc-` token from Chrome's on-disk LevelDB plus cookies from the macOS
Keychain. 19 tools (the repo tagline says 21; the README body says 19 — unresolved discrepancy).
**Gating: client-delegated** — "every workspace write path carries an MCP **destructive
annotation** so compatible clients can put approval where it belongs."
Source: <https://github.com/jtalk22/slack-mcp-server>

This is the closest published idea to ours and the most instructive counter-example:
`destructiveHint` is advisory metadata. A client that ignores annotations, or a model running in an
auto-approve loop, sends anyway. The trust boundary is in the wrong place.

### 7.5 Aggregators

**Composio** — Slack toolkit write actions include "Send message", "Send ephemeral message",
"Schedule message" (120 days), "Share a me message in a channel". Scopes are "Exactly the ones
Slack lists on its consent screen when you connect", not enumerated — **not verified**.
**Gating: none at the platform layer**, and the docs say so plainly: "Keep an approval step in your
prompt for actions with side effects, such as sending or deleting, and have the agent draft first."
Composio also names the exact risk: the toolkit operates "under that account, so anything the agent
creates, sends, or changes shows up in Slack as done by you."
Source: <https://composio.dev/toolkits/slack>

A prompt-level approval step is not an enforcement mechanism. This is the clearest published
admission that the category has no real gate.

**Zapier MCP** — write actions include "Send Channel Message", "Send Direct Message", "Send Private
Channel Message", reactions, reminders, message edit/delete, profile updates. **Gating: none on
ordinary sends.** The only approval-bearing item is a *separate* Slack action, "Request Approval" —
"Sends a message requesting approval. Includes buttons to submit 'Approve' or 'Decline' responses.
Execution will be held until a submission is made." That is a workflow primitive you may choose to
call, not a gate in front of "Send Channel Message". Zapier's "AI Guardrails" page was surfaced by
search but not fetched — **not verified**.
Sources: <https://zapier.com/mcp/slack>,
<https://help.zapier.com/hc/en-us/articles/35891060646413-How-to-set-up-Slack-s-Request-Approval-action-in-Zapier>

**Arcade.dev** — 10 tools including `Slack.SendMessage` (channel, DM or MPIM). "This toolkit uses
OAuth 2.0 via the Slack provider. Arcade handles the authorization flow automatically." That is a
one-time consent checkpoint, not a per-send approval. Example scopes cited: `chat:write`,
`im:write`, `users.profile:read`, `users:read`; per-tool mapping **not verified**.
**Gating: none documented.**
Source: <https://docs.arcade.dev/en/resources/integrations/social/slack>

### 7.6 The state of the field

Of the nine implementations examined — Slack's own, Anthropic's archived reference, korotovsky,
zencoder, ubie-oss, jtalk22, Composio, Zapier MCP and Arcade — **not one enforces a human-approval
step before a message is sent, in its own code.** Four postures exist:

1. **No gate at all** — Anthropic (archived), zencoder, ubie-oss, Arcade, Zapier MCP, and the
   official Slack MCP server.
2. **Static config kill-switch** — korotovsky. Off by default, which is genuinely good, but binary.
3. **Advisory annotation, client-enforced** — jtalk22. Right instinct, wrong trust boundary.
4. **"Put it in your prompt"** — Composio, which states the absence outright.

Slack's own product has named the draft concept without enforcing it. That is both validation of
the idea and confirmation of the gap.

---

## What this means for the design

**1. The Gmail problem does not exist here — and read-only should ship as a real mode, not a
relief.** Slack's read and write permissions are disjoint. `chat.postMessage` requires `chat:write`
for both token types, and no read scope implies it, so a token holding only `*:history` and
`*:read` scopes provably cannot post. Slack can therefore offer what Gmail cannot: an install whose
send guarantee is the OAuth grant itself rather than our code, where a bug in our send path cannot
post a message. **But the enumeration has to be complete, because `chat:write` is not the only way
to post.** `files:write` alone lets `files.completeUploadExternal` publish a file into a channel
with an `initial_comment`; `reactions:write` performs a public, notifying act; `incoming-webhook`
posts with no `chat:write` at all; `im:write` carries `conversations.mark`, which mutates the
person's read state. The read-only scope set must exclude all four, and when a send gate does
exist it needs at least three guarded entry points — `chat.postMessage`,
`files.completeUploadExternal` with channels, and `reactions.add` — not the single choke point the
Gmail build has. Sources: §2.2, §3.6.

**2. There is no server-side draft, so the draft is ours and the preview must be byte-exact.**
Slack has no public `drafts.*` API; the client's `drafts.create` is an undocumented internal
endpoint reachable only with browser-session credentials and must not be built on. The approval
binding — content hash, recipients, expiry, one-shot — carries over from Gmail unchanged, but two
things do not. A `never` policy has nowhere to leave the draft except our own store, so "the draft
waits in Gmail" has no equivalent and needs its own answer. And because a message's rendered form
(`blocks`) and its API-readable form (`text`) can differ entirely, the preview must be rendered
from the exact payload that will be posted. `chat.scheduleMessage` is a tempting near-miss and
should not become the gate: it is a delayed send, fire-and-forget by default, needing the human to
intervene to *stop* it, with a cancellation window that closes 60 seconds before delivery and a
documented failure to post at all if `metadata` is set. Offer it as an explicit "send in N minutes,
cancellable" mode if at all; never as the default, and never described as a draft.
Sources: §2.3, §2.4, §3.3, §6.3.

**3. The install model is forced by a three-way collision, and "bring your own Slack app" is the
only corner that works.** A commercially distributed non-Marketplace app gets
`conversations.history` at **1 request per minute with 15 messages per request** — fatal for
reading anything. Marketplace approval restores Tier 3 but forbids Socket Mode, requires a public
HTTPS endpoint, and now requires 10 active installations before review. **Internal customer-built
apps are exempt from the cap and can use Socket Mode**, so setup should walk the person through
creating their own app from a manifest we ship — the direct analogue of the Google Cloud
client-secret step in the Gmail setup. That makes the manifest a product artefact, and
`oauth_config.scopes.user` inside it is where the read-only guarantee is actually expressed. Flag
in the spec that Slack has twice set and twice silently withdrawn a date for applying the cap to
existing installations, so a Tier 1 fallback path must exist. Socket Mode also answers the
local-agent question: an `xapp-` token with `connections:write` opens an outbound WebSocket, so a
laptop behind NAT receives events with no public URL. Sources: §4.3, §5.2, §1.2.

**4. A user token is the right choice, and it makes the gate matter more, not less.** A bot token
cannot see the person's DMs, cannot read channels it has not been invited to, and cannot search at
all. A user token sees what the person sees — which cuts both ways. The read surface is far wider
than a Gmail mailbox: a user token with `channels:history` can read **every public channel in the
workspace**, including ones the person has never opened, so read-side scoping is our problem and
ubie-oss's server-side-enforced `SLACK_SAFE_SEARCH` is the right pattern to copy. And anything
posted is posted **as the person**, with no "sent by a bot" tell for colleagues — precisely the
case where an ungated send does the most damage. Sources: §1.3, §7.4.

**5. Slack is less final than email, but not reliably enough to lean on.** `chat.update` and
`chat.delete` both exist at Tier 3 behind `chat:write`. But the edit window is a **workspace
setting** — owners may permit edits "any time, never, or up to a certain timeframe" and may
restrict deletion to admins — so retraction can simply be unavailable. Treat it as a best-effort
mitigation offered after the fact, never as part of the safety argument. One thing to test before
relying on it: bot-posted messages carry no "(edited)" label, and whether a *user*-token edit of
the person's own message is similarly silent is **not verified**. If it is, an agent could rewrite
history under the person's name invisibly. Sources: §6.2.

**6. The injection surface is wider than email's, Slack says so itself, and nothing in the field
gates sending.** Link unfurls inject third-party content into messages the agent reads; `mrkdwn`'s
`<url|label>` and Block Kit's `link` element both let displayed text diverge from destination;
`<!channel>` and `<!everyone>` are one unescaped string away in any relayed content; and
`text` versus `blocks` gives every message two readings. Slack's own security page states that "The
risk of data exfiltration is significantly higher when an LLM is acting on behalf of a user",
recommends disabling link unfurling by default, and warns that automatic parsing of text containing
`@everyone` "could unintentionally send a notification to the entire workspace". Concretely:
`unfurl_links` and `unfurl_media` must be `false` on every call we make, since both default to
`true`; the Gmail sanitiser needs a Slack mode that escapes `&`, `<`, `>`, refuses broadcast
mentions unless explicitly requested, and either forbids `blocks` on composed messages or restricts
them to non-interactive types; attribution shown to a person must come from `bot_id` / `user`,
never from the freely-settable `username`; and `chat:write.customize` must never be requested.
Against that, of nine Slack MCP implementations examined — including Slack's own — **none enforces
approval before sending in its own process.** The best prior art is an environment variable that is
off by default; the most thoughtful delegates the gate to the client via MCP annotations a client
may ignore. Set `destructiveHint` too, as belt and braces, but the gate has to live in our process,
because that is the only place it holds regardless of which client is driving.
Sources: §6.1, §6.3, §6.4, §7.

### Open questions the spec should resolve by testing, not by reading

- Whether user-perspective event subscriptions deliver the person's own DMs over Socket Mode in
  2026. The two-category model is documented; the end-to-end recipe is **not verified**.
- Whether a user-token `chat.update` of the person's own message shows an "(edited)" label.
- Whether `files.upload` is in fact hard-disabled, ten months past its documented sunset.
- Whether the API can read the 90-day-to-one-year band that free workspaces hide in the client.
- Whether a user token can post to a public channel the person has not joined.
- The exact JSON body accompanying an HTTP 429 (only the status line and `Retry-After` are
  documented).
