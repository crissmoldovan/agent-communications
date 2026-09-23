# Slack: switching a workspace between read and send — design

2026-09-23. Follows the organisation/platform rename (0.3.0), as the owner decided. Revised after the first design
review, which found that in-product narrowing cannot work and that widening already has an ungated route.

## 1. What was asked, and what was decided

The owner asked whether a person can be helped to move a Slack workspace from `read` to `send` and back, from the
CLI and from MCP. Two decisions were taken on 2026-09-22:

- **Timing:** after the rename lands. It has.
- **What an agent may do, once Slack has an MCP server:** report a workspace's mode; narrow it, `send` → `read`,
  without asking anybody, because tightening needs nobody's consent; and **request** a widening, which parks until
  the owner approves it at a terminal. An agent never widens directly.

## 2. What is true about Slack

Each of these was read from Slack's documentation on 2026-09-23, not inferred.

**The scopes live in two places.** The Slack *app* declares what may be asked for — its manifest, created from
`agent-slack manifest --mode …` — and the token holds what was granted. Changing the app's declared scopes does not
change any token already issued ([app lifecycle](https://docs.slack.dev/app-management/distribution/)). So `read` →
`send` takes two steps, the first of which only a person in a browser can do: update the app with the `send`
manifest, then re-authorise asking for `send`.

**Scopes accumulate, and cannot be taken back** ([installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)):

> Any subsequent time(s) you send that same user through the OAuth flow, any new scopes you request will be added
> to that initial set. … There is no way to remove scopes from an existing token without revoking it entirely.
> … It is not possible to downgrade an access token's scopes.

**Revoking one token does not reset the installation.** This app enables token rotation, and with rotation
([using token rotation](https://docs.slack.dev/authentication/using-token-rotation/)):

> auth.revoke will revoke a single token … without changing the underlying installation.

**Only an uninstall resets it, and that needs the client secret.** `apps.uninstall` "revokes *all* tokens associated
with a single installation", and requires `client_id` **and `client_secret`**
([apps.uninstall](https://docs.slack.dev/reference/methods/apps.uninstall/)). D8 signs in with PKCE precisely so
that no client secret is ever stored.

Together: **there is no way for this package to narrow a workspace by itself.** Narrowing needs the installation
removed, which needs either a credential the design deliberately does not hold or a person in Slack's settings.

## 3. What is wrong today

1. **Nothing in the product narrows a workspace, and the one refusal a person meets points the wrong way.**
   `workspace reauth <name> --mode read` comes back with Slack's union of scopes, and the exact-scope check refuses
   it — correctly: storing a token that can post under the label `read` is what D1 forbids. But the refusal says
   "Re-create it from `agent-slack manifest --mode read`", and a new app does not remove a scope from an existing
   installation.
2. **Widening has a route with no terminal challenge.** `workspace reauth --mode send` goes through
   `confirmWidening`. `workspace add --mode send` does not, `workspace remove` is ungated, and a newly added account
   is not a loosening in core's classifier. So an agent can remove a `read` workspace and add it back as `send`,
   with only Slack's consent screen between it and a token that can post. The owner's rule — an agent never widens
   — is broken today, independent of anything in this document.
3. **Nothing explains a mode.** `manifest --help` lists both choices, and `workspace show` reports the stored mode
   and scopes, but no output says what a mode means for posting, that the other exists, or what moving between them
   takes. The manifest help also only ever says to *create* an app, which for a workspace already connected is the
   wrong app.

## 4. M1 — the CLI

- **Close the widening route, at every layer, not only at the command.** This is a real gate change, and the only
  one here.
  - **Core:** a new account arriving as `send` is classified as loosening `accounts.<name>.mode`, measured against
    `read` — the floor every new account starts from. `ConfigStore.update` then refuses to record one without
    consent, whatever wrote it. (It used to read "choosing `send` when connecting is the decision itself": true of a
    person, and exactly the decision an agent may not make.)
  - **`startSignIn`** refuses a `send` add without consent for that name, before any flow exists.
  - **`completeSignIn`** refuses a consent-less `send` add flow before the code is exchanged — a flow started before
    this change, or by something other than the CLI — so Slack never issues the token.
  - **The CLI** asks first (`requirePerson`: agents refused, no terminal refused, a typed challenge otherwise), so an
    agent fails before any listener or network work.
  Tests at each layer: the classifier; the store; the operation; a planted legacy flow; and remove → add `--mode
  send` as an agent through the CLI.
- **`agent-slack workspace mode <name>`** reports the stored mode and whether the *recorded grant* contains any
  scope that lets it act outward — `chat:write`, `files:write` or `reactions:write`, D2's doors — worded as what
  was recorded, not as proof about a live token. It says what each direction takes. Read-only; agents may run it.
- **`agent-slack workspace mode <name> send --port <port>`** prints the two steps with the exact manifest command
  for that port, then runs the existing gated reauth. The port is required because neither step works without it
  and the configuration does not store it.
- **`agent-slack workspace mode <name> read --port <port>`** does not pretend. It prints the path that works (§5),
  with exact commands for that port, and exits without changing anything. Agents may run it: it grants nothing. A
  record from before workspaces remembered their app cannot be re-authorised in place, and gets remove → add instead,
  said as such.
- **The union refusal at sign-in** names `workspace mode <name> read --port <the flow's port>` — a command that
  works as printed — and says what happened — Slack adds scopes to what was granted before, and only
  removing the app's installation takes them away — and names §5's path instead of a new app.
- **`agent-slack manifest`** says which mode it printed and what the other one is for; for `send`, that the app has
  to be updated *before* the reauth; and that changing an existing workspace's mode means editing **its existing
  app's** manifest, not creating a new app.

## 5. Narrowing — a documented path, not a command

Decided on the evidence in §2: narrowing is a person's procedure, printed by `workspace mode <name> read` and by the
union refusal. It keeps the name, the client, and — through reauth's retargeting — every former name:

1. *(Recommended.)* Open the workspace's existing app at api.slack.com → App Manifest, and replace it with
   `agent-slack manifest --mode read --port <port>`, so the app itself can no longer offer `send`. The port need not
   be the old one, but this step and step 3 must use the same one.
2. Remove the app's installation from the workspace in Slack: **Workspace settings → Manage apps → the app →
   Remove app**. That revokes every token of the installation, which is the only thing that resets its scopes.
3. `agent-slack workspace reauth <name> --mode read --port <port>` — not `workspace add`, which refuses an existing
   name, would mint a new account id, and would leave the former-name records pointing at the removed one.

Storing a client secret so the package could call `apps.uninstall` itself was considered and declined: it reverses
D8, and it would revoke every token of the installation, not just this package's.

What stays unverified is the Slack UI wording in step 2, which changes more often than the API. The first person to
walk the path confirms it, and the text is corrected then.

## 6. M3 — the agent tools, with the Slack MCP server

Built with the MCP surface (S3 onwards), not before.

- `slack_workspace_mode` — report, as `workspace mode <name>`.
- `slack_workspace_narrow` — returns §5's path for that workspace. There is nothing for an agent to *do* beyond
  that; the owner's permission to narrow is honoured by saying exactly how.
- `slack_workspace_request_send` — records a pending request. **Grants nothing.** A request:
  - is bound to `workspaceId` + `userId` — the pair that survives a reauth, which mints a new `accountId` every
    time — and records the `accountId` it was made against for display. The name is display only, so a rename does
    not detach it and a reused name cannot inherit it. A reauth of either kind leaves pending requests in place;
    they still describe the same person in the same workspace.
  - has a random id (`rq_` + 26 characters from core's id alphabet), validated before it names a file, and lives in
    `<stateDir>/slack/requests/`, created 0700, each file 0600, written atomically. The path is built from the
    validated id only.
  - carries the agent's reason as untrusted text: at most 500 characters, passed through core's invisible- and
    control-character stripping, and rendered with every line prefixed `> ` so it cannot pass for this command's
    own output (fake headers, bidi overrides and zero-width text included).
  - at most 10 pending per workspace and person; an eleventh is refused, not rotated in. Pruning expired requests, counting
    and creating happen under one lock per workspace and person (`<stateDir>/slack/requests/<key>.lock`, the core file lock),
    so two agents asking at once cannot both see nine and make eleven. The key is the first 32 hex characters of
    SHA-256 over `workspaceId` + `userId`, never the raw id: the schema only promises a non-empty string, and a
    file name built from one could climb out of the directory.
  - expires 24 hours after its own recorded time; expired ones are removed whenever the directory is read.
  - is listed by `workspace mode <name> send` at a terminal, which clears **exactly the request ids it showed**, and
    only after that widening succeeds — so a request made while the person was confirming is still there afterwards.

  Nothing in the MCP surface can produce a `LooseningConsent` or start a `send` sign-in; a test asserts that every
  registered tool, called with any arguments, leaves both unproduced.

## 7. Out of scope

- Changing a Slack app's manifest from here: it needs an app configuration token, more power than anything this
  package holds.
- Revoking on `workspace remove`: `auth.revoke` would retire this package's token but, per §2, leave the
  installation and its scopes — so it would not do what a reader of "remove" would assume. Recorded, not built.

## 8. Tests

- **M1:** as an agent, remove → `add --mode send` is refused before any sign-in starts; `add --mode send` at a
  terminal with the challenge answered completes and records `send`; `mode send` at a terminal widens the named
  workspace as a reauth (bound to its account, so not refused as an existing name), and without a terminal is
  refused before any network call, naming a command — with `--port` — that works as printed; the command the union refusal prints, followed, prints §5; `workspace mode` reports outward capability from each of the three write scopes, and
  from none; `mode send` without `--port` is a usage error, and with it refuses an agent and a non-terminal before
  any network call; `mode read` prints §5 and changes nothing; the union refusal names §5 and no longer mentions
  re-creating the app; `manifest` output names both modes.
- **M3:** the request is inert (no consent, no send flow, from any tool); survives a rename and a read → read reauth
  (id rotation); is not inherited by a reused name; expires; is cleared only by a successful widening, and only the
  ids shown, with one created concurrently left in place. Negative tests: a traversal id, an oversized reason, an
  eleventh request, a traversal-shaped `workspaceId` (`../../x`) that must stay inside the directory, bidi /
  zero-width / fake-header reasons, file and directory permissions, and — starting from
  nine pending — two requests created at once, of which exactly one succeeds.
- Every guard mutated and a named test failing.
