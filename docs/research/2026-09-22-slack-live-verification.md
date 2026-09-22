# Slack S2: the four things only a real workspace can settle

**Status: not yet run.** Everything in `packages/slack` is built and tested against a fake Slack.
Four assumptions have never met the real one. This is the checklist that settles them, what each
outcome means, and what to change in the code for each answer.

It takes about ten minutes and needs a Slack workspace you can install an app into. Nothing here
posts a message, joins a channel, or changes anything in the workspace: the whole run is a sign-in
and a read of your own identity.

> **Why this blocks S3, not S2.** S2 is the sign-in machinery and it is complete and reviewed. S3
> is the first phase that *reads* Slack, and every read depends on holding a token this flow
> produced. Building S3 on four unverified assumptions means discovering them through S3's bugs.

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

### 1. How an app opts into PKCE — the real unknown

Slack's PKCE page says a `localhost` redirect works "if the app has opted into PKCE" and never says
where that switch is. The manifest this prints carries **no PKCE key**, because inventing one that
Slack silently ignores would produce an app that looks configured and is not.

| What happens at step 3 | What it means | What to do |
|---|---|---|
| The browser lands back and the CLI says `Connected "live"` | Opting in is implicit: sending `code_challenge` is enough | Nothing. Record it in the research. |
| Slack's page refuses the redirect URI before you approve | The app is not treated as a desktop client | Look for a PKCE or "public client" toggle in the app's OAuth settings. If one exists, the manifest needs a key for it — find its name in the manifest reference. |
| You approve, then the CLI says *Slack refused the sign-in* | The authorisation worked and the exchange did not | Read the error Slack gave; it is printed verbatim. Most likely the app still expects a client secret. |

### 2. `oauth.v2.access` or `oauth.v2.user.access`

Both are documented, both accept `code_verifier`, and the docs do not say which a user-scope-only
PKCE app should call. The code calls `oauth.v2.access`, which is the one Slack's own PKCE page
names.

A failure here shows up as *Slack refused the sign-in* with Slack's own error string. If that
string suggests the method is wrong, change the one line in
[`packages/slack/src/context.ts`](../../packages/slack/src/context.ts) (`postExchange`) and add
`oauth.v2.user.access` to the method registry's `auth` group.

### 3. Does `token_rotation_enabled` in the manifest actually work

**This one is new, and it is the most likely to fail.** The research describes token rotation as
something you *enable in app settings*; the manifest key may or may not do it.

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

## What `doctor` should say at step 4

```
ok    Sign-in for live: access token valid until <12 hours out>
ok    Slack's view of live: Slack agrees: U… in T…
ok    Permissions for live: read: 11 scopes, exactly as Slack reports them
?     Rate limit: expected Tier 3 for an internal app; not yet observed
?     Other Slack MCP servers: not checked on this machine
```

Three things to look at rather than skim past:

- **"exactly as Slack reports them"** rather than "as recorded at sign-in" means the
  `x-oauth-scopes` header was present, and the drift check is comparing against Slack rather than
  against itself. If it says "as recorded at sign-in", the header is not there and §6 of the
  review's scope-drift fix is weaker than intended.
- **`Slack agrees`** is the whole point of the identity probe. Anything else means the token does
  not act as the account the config names.
- The two `?` lines are correct. They mean nobody has looked, not that everything is fine.

---

## Afterwards

Update [`2026-09-19-slack-platform.md`](2026-09-19-slack-platform.md) §1.4a with what was actually
observed, replacing "must be confirmed against a real workspace" with the answer and the date.
Then remove the three-unknowns note from the phase table in
[the design spec](../superpowers/specs/2026-09-19-slack-design.md), and S3 can start.

Step 5 removes the workspace from this machine. It does **not** uninstall the Slack app — do that
in the workspace's own app settings if you do not want it sitting there.
