# Slack S2: the live verification, and how to rerun it

**Status: run 2026-09-22, against a real workspace.** Sign-in, exchange, rotation and `doctor`'s identity
check all worked first time. It found one real bug — `doctor` reported the `identify` scope Slack adds to
every user token as drift — fixed in the same change that recorded these results. What was observed is in
§1.4a of [the platform research](2026-09-19-slack-platform.md); the checklist below stays, for the next
workspace or the next Slack change.

**What the run showed.** The manifest's `pkce_enabled` and `token_rotation_enabled` both take effect,
with nothing switched on by hand; `oauth.v2.access` is the right exchange endpoint; the grant held exactly
the scopes asked for, with a refresh token and a twelve-hour expiry; and `auth.test` confirmed the token's
identity and returned the scope header. Before the run there were four open questions — one of them, how an
app opts into PKCE, had been documented all along and was recorded as unknown only because a first search
missed it.

The rest of this page is kept as the procedure for the next workspace, or for the next time Slack changes
something: what to run, and what each possible outcome means.

It takes about ten minutes and needs a Slack workspace you can install an app into. Nothing here
posts a message, joins a channel, or changes anything in the workspace: the whole run is a sign-in
and a read of your own identity.

> **Why it mattered.** S3 is the first phase that *reads* Slack, and every read depends on holding a
> token this flow produced. Building S3 on unverified assumptions would have meant discovering them
> through S3's bugs. They are verified now, so S3 is not blocked on this.

---

## Before you start

You need a workspace where you can create an app. Many corporate workspaces require an owner to
approve installs — see §1.6 of [the platform research](2026-09-19-slack-platform.md). If yours
does, the request goes to an admin and the rest of this waits on them.

Pick a port nothing else on your machine uses. `51234` is as good as any. **The same number has to
appear in both commands below**, because Slack matches redirect URLs exactly.

---

## The run

```bash
# 1. Print the app to create, and the JSON to paste.
node --experimental-strip-types packages/slack/src/cli.ts manifest --port 51234

# 2. Follow what it prints: api.slack.com/apps → Create New App → From a manifest.
#    Paste the JSON. Create it. Copy the Client ID from Basic Information.

# 3. Connect.
node --experimental-strip-types packages/slack/src/cli.ts workspace add live \
  --client-id <the Client ID> --port 51234

# 4. Ask Slack whether the token is what we think it is.
node --experimental-strip-types packages/slack/src/cli.ts doctor

# 5. Put it back the way it was.
node --experimental-strip-types packages/slack/src/cli.ts workspace remove live
```

Step 3 opens a browser. Approve it, leaving every permission ticked — the code refuses a grant
that is narrower *or* wider than the mode asked for, so unticking a box fails the sign-in on
purpose.

---

## What each outcome settles

### 1. Does the manifest's `pkce_enabled` actually take effect

**Observed 2026-09-22: it does.** The manifest sets `oauth_config.pkce_enabled: true`, which both the PKCE
guide and the manifest reference document, and Slack applied it to an app created from the pasted manifest:
the `localhost` redirect was accepted and the exchange succeeded with no client secret. The table is what a
rerun should do if that ever stops being true.

Worth two seconds at step 2: after creating the app, open **OAuth & Permissions** and check the PKCE
setting is on. The guide says that is where the same switch lives for standard apps.

| What happens at step 3 | What it means | What to do |
|---|---|---|
| The browser lands back and the CLI says `Connected "live"` | The manifest field took effect | Nothing. Record it. |
| Slack's page refuses the redirect URI before you approve | PKCE is not on, so `localhost` is being treated as a server redirect | Turn it on under **OAuth & Permissions** and try again — then say so here, because it means the manifest field is not enough and the `manifest` command needs to tell people to check. |
| You approve, then the CLI says *Slack refused the sign-in* | The authorisation worked and the exchange did not | Read the error Slack gave; it is printed verbatim. Most likely the app still expects a client secret. |

### 2. `oauth.v2.access` or `oauth.v2.user.access`

**Observed 2026-09-22: `oauth.v2.access` works** for a user-scope-only PKCE app. Both methods are documented
and both accept `code_verifier`; the code calls the one Slack's own PKCE page names, and it returned a user
token under `authed_user` and no bot token.

If a later run fails here, it shows up as *Slack refused the sign-in* with Slack's own error string. If that
string suggests the method is wrong, change the one line in
[`packages/slack/src/context.ts`](../../packages/slack/src/context.ts) (`postExchange`) and add
`oauth.v2.user.access` to the method registry's `auth` group.

### 3. Does `token_rotation_enabled` in the manifest actually work

**Observed 2026-09-22: the manifest key is enough.** The research described token rotation as something
you *enable in app settings*, and it was the likeliest of the four to fail. It did not: the grant carried a
refresh token and a twelve-hour `expires_in`. The rest of this section is what a rerun will see if that
changes.

The code refuses a grant with no refresh token rather than storing one, so you will know
immediately:

> **error:** Slack issued a token that cannot be renewed
> **hint:** The app must have token rotation enabled — check it at https://api.slack.com/apps …

If you see that: turn rotation on in the app's settings, remove the half-made app or start a fresh
sign-in, and try again. Then record whether the manifest key worked, because if it does not, the
manifest is misleading and the `manifest` command's instructions need a step 4.

The alternative — storing a token that quietly stops working in twelve hours with nothing able to
renew it — is why this is a hard failure rather than a warning.

### 4. `localhost` versus `127.0.0.1`

Not load-bearing: the code uses `localhost`, which is the spelling Slack documents. This is only
worth noting if you happen to see evidence either way, because the Gmail package deliberately uses
the literal address for a good reason and the two packages differing is a thing someone will ask
about.

---

## What `doctor` said at step 4

```
ok    Sign-in for live: access token valid until <12 hours out>
ok    Slack's view of live: Slack agrees: U… in T…
ok    Permissions for live: read: the 11 scopes it asked for, as Slack reports them (plus identify, which Slack adds to every user token)
?     Rate limit: expected Tier 3 for an internal app; not yet observed
?     Other Slack MCP servers: not checked on this machine
```

Three things to look at rather than skim past:

- **"as Slack reports them"** rather than "as recorded at sign-in" means the `x-oauth-scopes` header was
  present, and the drift check is comparing against Slack rather than against itself. It was present.
- **`identify`** is not in the manifest, and Slack adds it to every user token anyway. The first run
  reported it as drift; `IMPLICIT_USER_SCOPES` exists because of that. Any *other* extra scope is real
  drift.
- **`Slack agrees`** is the whole point of the identity probe. Anything else means the token does
  not act as the account the config names.
- The two `?` lines are correct. They mean nobody has looked, not that everything is fine.

---

## Afterwards

The 2026-09-22 results are recorded in §1.4a of
[the platform research](2026-09-19-slack-platform.md) and in the phase note of
[the design spec](../superpowers/specs/2026-09-19-slack-design.md). A later run that disagrees with them
should update both, with the date.

Step 5 removes the workspace from this machine. It does **not** uninstall the Slack app — do that
in the workspace's own app settings if you do not want it sitting there.
