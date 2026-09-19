# Setup failures, by what the user sees

Open this when connecting or re-connecting a mailbox goes wrong, when a mailbox that worked has
stopped, or when an MCP client cannot see the Gmail tools. It is keyed by the thing on the user's
screen rather than by the code in the log, because the two rarely match: `invalid_grant` is a Google
string, "it stopped working after a week" is what the user says, and they are the same fault.

Run `agent-gmail doctor --json` first, every time. It changes nothing, costs no quota beyond one
token refresh and one profile call per mailbox, and each check carries a `fix` line. Read `healthy`
and the `fail` count, not the exit status — a failing check still exits `0`, because a finding is
not a crash.

## The screen says "Access blocked", or the flow returns `access_denied`

**Cause.** Either the user pressed Cancel, or the app is still in **Testing** and the account
signing in is not on its test-user list. Google reports both as `access_denied`; the wording on the
screen tells them apart ("Access blocked" is the second).

**Fix.** Publish the app: Google Cloud → Google Auth Platform → **Audience → Publish app**. Then run
the sign-in again:

```bash
agent-gmail inbox add <alias> --email <address> --tier organize --start
agent-gmail inbox add --finish <flowId> --wait 60
```

**Do not** add the account as a test user instead. It works, and then fails seven days later for a
reason nobody will connect to this moment.

## The screen says the app is not verified

**Not a failure.** This is the expected screen for an OAuth client the user made in their own
project and published without review. The route through it is **Advanced → "Go to \<app name\>
(unsafe)"**. Say this *before* they meet it; met without warning, it reads as a reason to stop.

Uploading a logo in Branding is what pushes an app into the verification review, which takes weeks
and changes nothing here. Leave the logo empty.

## `admin_policy_enforced`

**Cause.** A Google Workspace administrator restricts which third-party apps may hold these scopes,
and this client id is not among them.

**Fix.** Only an administrator can do it, under Admin console → Security → API controls → **Manage
third-party app access**, by trusting the client id. Give them the client id from `agent-gmail
client list` — it is not a secret. Nothing in the CLI works around this.

The same policy can also appear later, on an ordinary call, as a 403 with reason `domainPolicy`;
this package reports it as `AUTH_REQUIRED` (exit 77) with the same console path in the hint.

## `org_internal`

**Cause.** The OAuth client's audience is **Internal**, so it accepts only accounts in the
organisation that owns the Cloud project. A personal account, or an account in another Workspace, is
refused.

**Fix.** Google Auth Platform → **Audience** → set the user type to **External**, then sign in
again. Nothing needs re-downloading; the client id and secret are unchanged.

## `redirect_uri_mismatch`

**Cause.** The OAuth client is a **Web application** client. Only a Desktop ("installed") client has
the loopback redirect this sign-in uses.

**Fix.** Create a new client of type **Desktop app**, download its JSON in the creation dialog, and
register it:

```bash
agent-gmail client add ~/Downloads/client_secret_*.json --move --name desktop
agent-gmail inbox reauth <alias> --client desktop --start
```

`agent-gmail client add` refuses a Web client's JSON by name, before anything is stored, so this
error only appears for a client registered by other means.

## `invalid_client`, `deleted_client`, `unauthorized_client`

**Cause.** Google does not accept the client at all: it was deleted in the console, or its secret
was rotated there and the stored one is stale.

**Fix.** If the client still exists and only the secret changed, add a new secret to it in the
console, download the JSON, and rotate:

```bash
agent-gmail client add ~/Downloads/client_secret_*.json --replace
```

If it was deleted, create a new Desktop client, register it under a new name, and re-authorise every
mailbox onto it with `agent-gmail inbox reauth <alias> --client <name> --start`. `client add
--replace` refuses to point an existing name at a *different* client id while mailboxes use it, and
names the mailboxes it would break.

## `invalid_grant`, at sign-in or on a refresh

**Cause.** Google refused the grant. The same string covers several situations, and the age of the
mailbox usually decides which:

| When it happens | What it almost always is |
|---|---|
| About 6–9 days after the mailbox was connected | The app is still in **Testing**, which issues seven-day refresh tokens |
| Long after, on a mailbox that was idle | The grant expired unused. Google drops a refresh token unused for six months |
| At any time, right after the user tidied their account | The grant was revoked, at the Google account's connections page, or by `inbox remove --revoke` on a token that shared the grant |
| On a fresh sign-in | The authorisation code was already used, or it belongs to another flow |

**Fix.** Publish the app if it is the first case, then in every case:

```bash
agent-gmail inbox reauth <alias> --start
agent-gmail inbox reauth --finish <flowId> --wait 60
```

## "Google will not refresh the token for \<alias\>"

This is the same fault as above, seen from the other side: the stored refresh token no longer works,
so nothing the mailbox does can succeed. It is `doctor`'s `inbox-token` check failing, and it is
`AUTH_REQUIRED` (exit 77) on every call.

Two details worth knowing before reaching for a fix:

- **It is not always a dead grant.** Another process may have re-authorised the mailbox a moment
  ago, so the token in memory is stale rather than revoked. The code already handles this: on
  `invalid_grant` it re-reads the stored token once and retries before giving up. If the message
  reached you, that retry has already happened.
- **The hint is date-aware.** Between six and nine days after the mailbox was created, the hint names
  the Testing app and the Publish button. Outside that window it says the grant is gone. Pass the
  hint on as it came — it is more specific than the generic advice.

**Fix.** `agent-gmail inbox reauth <alias> --start`, then `--finish`. If the hint named Testing,
publish the app first or the new token will die in another seven days.

## "Google returned no refresh token"

**Cause.** The account has already granted this client and Google declined to issue a new refresh
token for the same grant.

**Fix.** Remove the app from the Google account's connections page
(`myaccount.google.com/connections`), then sign in again with the two-step flow. The error's own
hint says exactly this.

## The browser never comes back

**Symptom.** The user opens the link, completes consent, and the terminal or the agent is still
waiting — or the command died long ago.

**Cause, most often.** The command was run without `--start`. In that form it holds the loopback
port open for up to ten minutes waiting for the redirect, which is right for a person at their own
terminal and wrong for anything an agent runs: an agent's shell is killed first (Claude Code's Bash
tool gives up at 120 seconds), the command never reports, and the flow is left half-finished.

**Fix.** Always use the two-step form from an agent:

```bash
agent-gmail inbox add <alias> --email <address> --tier organize --start --json
agent-gmail inbox add --finish <flowId> --wait 60
```

`--finish` returning `APPROVAL_PENDING` is not a failure: it means nobody has finished in the
browser yet. The flow lives ten minutes from `--start`; run `--finish` again. A flow is single-use
and claimed atomically, so two `--finish` calls cannot both consume it.

**Other causes.**

- *The listener could not start.* `--start` waits ten seconds for the detached listener to report
  the port it bound; if it does not, the flow is discarded and the error suggests running the
  sign-in on a terminal instead.
- *The port is blocked.* A network or firewall that refuses loopback binds on random ports:
  `--port <number>` pins one that is allowed.

## "Can't reach 127.0.0.1" in the browser

**Cause.** The listener is not there when the redirect arrives: the flow was started on a different
machine (an SSH session, a container), or the listener process was killed, or the flow already
expired.

**Fix.** The address bar still holds the answer. Copy the whole URL — everything after the question
mark included — and finish with it:

```bash
agent-gmail inbox add --finish <flowId> --url '<the whole address the browser ended at>'
```

The pasted URL is checked against the flow's `state`, so an address from a different sign-in is
refused rather than used. If the URL carries `error=` instead of `code=`, the OAuth error in it is
mapped to one of the sections above. If the flow has expired, start again — there is nothing to
recover.

## The wrong Google account got connected

**Symptom.** Everything reads correctly and it is all the wrong mailbox. Or: the sign-in was refused
with "that sign-in was \<one address\>, not \<another\>; nothing was saved".

**Cause.** Google's account chooser hands back whichever account is already signed in that browser.
The sign-in URL asks for the chooser explicitly and pre-selects the expected address when `--email`
was given, but the user can still pick another.

**The refusal is the good outcome.** With `--email`, a mismatch is refused after the token exchange
and **nothing is written** — no inbox row, no stored token. Without `--email` there is nothing to
compare against, so the wrong mailbox is saved under the right alias and reads correctly everywhere
afterwards. Always pass `--email`.

**Fix, if it was saved.** Confirm what the alias actually is, then repoint it:

```bash
agent-gmail whoami --inbox <alias>
agent-gmail inbox remove <alias>
agent-gmail inbox add <alias> --email <the right address> --start
```

On `inbox reauth` the account check is stricter and cannot be skipped: the new grant's account id
must equal the stored one (or, for a mailbox imported without an account id, the address Google
reports must equal the stored address). A mismatch writes nothing. An account already connected
under another alias is refused too, with the alias it is already under — a `CONFIG` error, because
two aliases sharing one grant would overwrite each other's tokens.

`doctor`'s `inbox-profile` check catches this later: it warns when Google reports a different address
than the one recorded.

## A mailbox that worked last week

Work through these in order; each is one `doctor` check.

| `doctor` check | What it means | The command |
|---|---|---|
| `inbox-token` fails | The grant is gone — Testing expiry, six months idle, or revoked | `agent-gmail inbox reauth <alias> --start` |
| `inbox-profile` warns | Google reports a different address than the one stored | `agent-gmail inbox reauth <alias> --start` |
| `inbox-client` fails | The mailbox points at an OAuth client that is no longer registered | `agent-gmail client add <client_secret.json>` |
| `inbox-scopes` warns | The grant is missing scopes the recorded tier needs | `agent-gmail inbox reauth <alias> --start` |
| `inbox-idle` warns | Unused for 150 days; Google drops a token unused for six months | `agent-gmail whoami --inbox <alias>` |
| `secret-store` fails | The system keychain cannot be reached — common on a headless Linux box | `agentcomms secrets migrate --to file` |
| `oauth-client` fails | No OAuth client is registered at all | `agent-gmail client add ~/Downloads/client_secret_*.json --move` |
| `orphaned-secrets` warns | A stored token could not be deleted when a mailbox was removed | Remove it from the keychain by hand, then delete the file the check names |

If instead the failure is a 403 naming an API, the project lost the API rather than the mailbox
losing the grant: the error is reported as `CONFIG` (exit 78) and carries Google's own activation
URL. Enable the Gmail API — or the People API, if it was a contact search — and retry.

## A permission is missing after re-consent

**Symptom.** A call fails with `SCOPE_MISSING` (exit 77), or a mailbox that should be able to label
and archive cannot, even though the user just signed in again.

**Cause.** Granular consent: the permission list on the consent screen has tick boxes, and anything
unticked is not granted. The sign-in still succeeds as long as the read scope survived, and the
mailbox is saved at whatever tier the granted scopes actually support. The result's `missingScopes`
lists what was asked for and not given — read it, every time, and say what was lost rather than
reporting a clean connection.

If even reading was refused, nothing is saved at all, with the message "permission to read the
mailbox was not granted, so nothing was saved".

**Fix.** Re-consent for the tier that is wanted, and tell the user to leave every box ticked:

```bash
agent-gmail inbox reauth <alias> --tier organize --start
agent-gmail inbox reauth --finish <flowId> --wait 60
```

Contacts access is asked for by default; a re-consent reuses whatever the mailbox is currently set
to unless `--no-contacts` turns it off. There is no incremental grant for an installed app: each
re-consent asks for the whole union again.

One wrinkle to know rather than to repeat: a `SCOPE_MISSING` about contacts prints a hint naming a
`--contacts` flag, and the CLI only declares `--no-contacts`. Re-consenting a mailbox that already
has contacts on is enough; if it was turned off, say so and let the user decide.

The same applies to a mailbox carried over from another server. An imported `readonly`+`compose`
grant can read and draft but cannot label or archive, and it carries no account id at all — one
`inbox reauth` per mailbox fixes both. The import saves the setup, not the consent.

## An MCP client will not start the server

**Symptom.** The client shows no Gmail tools, or an error at start-up.

**First, read what `mcp install` reported.** It does not just write a config entry: it starts the
server through exactly the entry it wrote and completes an `initialize` and `tools/list`. A result
with `verified: true` and a tool count means the entry runs. `verified: false` carries the reason in
`verifyDetail`, and an entry that looks right but does not start is the failure people actually hit.

```bash
agent-gmail mcp install --client claude-code
agent-gmail mcp install --client claude-code --print   # see what would be written, write nothing
```

Supported clients are `claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini`, `vscode`, and
`json` to print the snippet for anything else. Add `--inbox <alias>` to pin the server to one
mailbox, and `--read-only` to register only the tools that cannot change anything.

**Then, the usual causes.**

| What happened | Why | Fix |
|---|---|---|
| The client starts the server and it exits immediately | Clients start servers with a minimal `PATH`, so `node` by bare name is not found | Re-run `mcp install`; every entry it writes uses an absolute interpreter path and an explicit `PATH` |
| The server starts but reports no mailboxes | It is reading a different configuration directory | The written entry sets `AGENT_COMMS_CONFIG_DIR` explicitly; re-run `mcp install` rather than hand-editing |
| The server starts but cannot read its secrets | A keychain item written by one Node build is not always readable by another, and on Linux a background process needs the session bus | Re-run `mcp install` (it prefers the `node` on `PATH` and forwards `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` on Linux); or `agentcomms secrets migrate --to file` |
| It worked, then stopped after an upgrade | The registered command path no longer exists — `doctor`'s `mcp-command` check | `agent-gmail mcp install --client <client>` |
| The client's config file is not valid JSON | Something else wrote it badly; the installer refuses to touch it rather than rewriting the file | Fix the file, or add the printed snippet by hand |
| Tools appear but nothing has changed | The client has not been restarted | Restart it |
| Nothing can reach npm to install the runtime | The default `managed` launcher installs the exact running version into its own directory | `--launcher npx` runs the published package directly instead |

**And the one that is not a start-up problem at all.** If `doctor` reports `other-gmail-servers` as
failing, another Gmail MCP server with send tools is registered with the user's client. It is a
failure, not a warning, and the reason is specific: while it is connected, an agent can send mail
with none of the approval steps in this package gating it. The check prints the exact removal
command. Pass it on in those words, and do not treat the presence of Gmail tools from that server as
evidence that setup is finished.
