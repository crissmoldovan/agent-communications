# The Google Cloud console, step by step

Open this when a user has no OAuth client yet, when `doctor` reports `oauth-client` as failing, or
when a client exists and something about it turns out to be wrong — the wrong type, the wrong
audience, a secret nobody saved. `SKILL.md` summarises the sequence in six lines; this is the same
sequence with what to click, what to type, what each choice costs later, and what the user will see
on screen so they are not surprised by it.

Almost every setup failure is decided here and surfaces somewhere else, minutes or days later. Four
choices account for nearly all of them: the client type, the audience, whether the app was
published, and whether the JSON was downloaded while the dialog was open.

## Before you start

- **A Google account, and a Cloud project the user may edit.** There is no shared client to borrow.
  One External, published Desktop client serves every mailbox the user connects, on any domain — but
  a Cloud project has a lifetime cap of 100 users for an unverified app, which makes a single client
  unsuitable for a whole company and fine for one person's mailboxes.
- **A browser the user controls.** Consent happens there. No flag makes it headless; `--url` only
  lets somebody paste the address bar back from a machine that has no browser of its own.
- **Node 22.12 or newer**, or the package will not run at all.

The console renames these pages every few months. The sequence has been stable; the page names in
this file are the ones in use at the time of writing, under **Google Auth Platform**.

## 1. Project

Create a project, or pick one the user already has. Then enable the APIs:

- **Gmail API** — always.
- **People API** — only if contact search is wanted. It is on by default at sign-in; `--no-contacts`
  turns it off for a mailbox.

If `gcloud` is installed and signed in, this is two commands (confirm the first with the user before
running it, because it creates something in their account):

```bash
gcloud projects create <project-id>
gcloud services enable gmail.googleapis.com people.googleapis.com --project <project-id>
```

Otherwise the console does it. **What it costs later:** an API that was never enabled surfaces as a
403 with reason `accessNotConfigured` or `SERVICE_DISABLED`, which this package reports as `CONFIG`
(exit 78) with Google's own activation URL in the hint. It does not surface at consent time, so a
mailbox can connect perfectly and then fail on its first search.

## 2. Branding

Under **Google Auth Platform → Branding**.

| Field | What to type | Why |
|---|---|---|
| App name | Anything that does not contain "Google" or "Gmail" | Google rejects those words in an app name |
| Support email | The user's own address | Shown on the consent screen |
| Logo | **Leave it empty** | Uploading a logo triggers the verification review: weeks of waiting, and it buys nothing for a client the user made for their own mailboxes |
| Audience / user type | **External** | Internal restricts the client to one Workspace organisation, and any outside account is refused with `org_internal` |

**What it costs later:** an Internal client works for the organisation that owns the project and
refuses everything else, including the user's own personal account. The error arrives at the consent
screen, not at creation.

## 3. Data access — the scopes

Under **Google Auth Platform → Data access**, add the scopes for the tier the user will connect at.
For an unverified personal app this step is optional — the consent screen lists whatever the sign-in
asks for — but listing them here makes the screen honest and the project self-documenting.

Every tier also asks for `openid` and `.../auth/userinfo.email`. Those are not sensitive, and they
are what gives the stable account id (`sub`) used to key the mailbox and to catch a sign-in that
returned the wrong account.

| Tier | Scopes requested | What the mailbox can then do |
|---|---|---|
| `read` | `openid`, `.../auth/userinfo.email`, `.../auth/gmail.readonly` | search, read messages and threads, timelines, attachments, export, follow-ups, list labels and send-as |
| `draft` | the two above, plus `.../auth/gmail.readonly` and `.../auth/gmail.compose` | everything in `read`, plus creating and editing drafts — and sending, which is gated by policy, not by scope |
| `organize` (the default) | `openid`, `.../auth/userinfo.email`, `.../auth/gmail.modify` | everything above, plus labelling, archiving, starring, read state and the bin |
| add-on `contacts` (on unless `--no-contacts`) | `.../auth/contacts.readonly`, `.../auth/contacts.other.readonly` | contact search through the People API |

Two things about this table are easy to misread:

- **`organize` does not ask for `gmail.readonly`.** It asks for `gmail.modify`, which already allows
  reading. A mailbox connected at `organize` has no `gmail.readonly` in its granted scopes and can
  still read everything.
- **No scope separates drafting from sending.** Both `gmail.compose` and `gmail.modify` allow the
  Gmail send call. The send gate in this package is code, not a grant, which is why another Gmail
  MCP server using the same account can send with nothing gating it.

Incremental authorisation is not available to installed apps, so changing tier later is a full fresh
consent for the union of scopes — `agent-gmail inbox reauth <alias> --tier <tier> --start`, not a
top-up.

## 4. Audience — publish the app

Under **Google Auth Platform → Audience**, press **Publish app**.

This is the step that is most often got wrong, and the failure it causes is dated a week out.

Leaving the app in **Testing** and adding the user as a test user *appears* to work. Consent
completes, the mailbox connects, searches run, drafts are written. Then, about seven days after the
sign-in, every call starts failing with `invalid_grant`, because a Testing app issues refresh tokens
that expire in seven days. By then nobody connects the two events, and it reads as the tool breaking
by itself. It is the whole of the "it stopped working after a week" report.

`TokenSource` recognises the shape: when a refresh fails with `invalid_grant` between six and nine
days after the mailbox was created, the hint it produces names the Testing app and the Publish
button rather than the generic "sign in again".

So: **adding test users is not the smaller, safer version of publishing.** It is the version with a
hidden timer. Publishing an unverified app is fine for a user's own mailboxes — the only consequence
is the warning screen in §6, and the 100-user lifetime cap.

If the user declines to publish, that is their call. Say the seven-day expiry out loud, in those
words, so the failure is expected rather than discovered.

## 5. Clients — create the Desktop client

Under **Google Auth Platform → Clients → Create client**.

| Field | Choose | Why |
|---|---|---|
| Application type | **Desktop app** | The sign-in redirects to `http://127.0.0.1:<random port>/`. A **Web application** client has no loopback redirect registered and fails at the consent screen with `redirect_uri_mismatch`, which reads like a bug in the tool |
| Name | Anything | Only ever seen in the console |

Then, **in the creation dialog, download the JSON**. Google shows the client secret exactly once. A
client whose JSON was not saved at that moment needs a new secret added to it, or a new client
altogether; nothing in the console will show the old one again.

The file lands wherever the browser puts downloads, typically as `~/Downloads/client_secret_*.json`.
Its useful contents are an `installed` object holding `client_id`, `client_secret` and `project_id`.
A Web client's JSON has a `web` object instead, and `agent-gmail client add` rejects it **by name**
("this is a Web application client; a Desktop app client is needed") rather than letting the user
discover it at the consent screen.

## 6. Hand the file to the CLI

```bash
agent-gmail client add ~/Downloads/client_secret_*.json --move
```

What that command does, in order:

1. Reads and validates the file: only an `installed` client is accepted, its client id must end in
   `.apps.googleusercontent.com`, and it must carry a secret. A missing secret is refused with the
   hint that Google shows it only at creation.
2. Chooses the secret store, once per configuration directory: the system keychain by default,
   probed first; `--store file` keeps owner-only files instead, which is what a headless Linux box
   needs. Both stores cannot be mixed — changing later is `agentcomms secrets migrate --to …`.
   A machine where Slack is already connected has chosen already, though nothing records it: its
   tokens are in the keychain, so `--store file` there is refused and names that command.
3. Checks the credentials with Google before storing them, by redeeming a code that cannot work. A
   live client answers `invalid_grant` ("that code is not real"), which counts as success; a deleted
   client or a wrong secret answers `invalid_client`, and the command refuses to store it. With no
   network, the check is skipped and the command says so. `--no-probe` skips it deliberately.
4. Writes the secret to the store, reads it back, and refuses if the two differ.
5. Writes the client id (and project id) into `config.json`. **The secret is never written to
   config, and never printed.**
6. With `--move`, and only after all of the above, deletes the downloaded file.

That the store comes before the probe has a consequence worth knowing. On a machine where the
keychain cannot be reached, `client add` fails with `SECRET_STORE_UNAVAILABLE` before it has asked
Google anything, so a deleted client or a stale secret stays hidden behind the store error. Run it
again with `--store file` and the probe finally happens — which is when `invalid_client` appears, a
step later than it looks as though it should. Read the first failure as being about the store alone,
and do not reach for `--no-probe`: the probe had not run.

Useful variants:

- `--name <name>` registers a second client alongside the first, for a user with more than one Cloud
  project.
- `--replace` rotates the secret of a client already registered under that name. If the client id is
  different and mailboxes already sign in through that name, the command refuses and names them:
  replacing it would break their sign-ins.
- `agent-gmail client remove <name>` refuses while any mailbox still points at it.

Never read the downloaded file to "check" it, never paste the secret into the conversation, and
never repeat it back after `--move` has removed the file.

## 7. What the user will actually see

Warn them about each of these *before* it appears, in this order.

1. **The account chooser.** The sign-in URL is built with `prompt=consent select_account`, so the
   chooser always appears rather than silently reusing whoever is signed in. When `--email` was
   given it also carries `login_hint`, which pre-selects that address — a hint, not a constraint. The
   user must pick the mailbox they mean. If they pick another one, the sign-in is refused after the
   fact and nothing is saved, which is the right outcome and looks like a failure if nobody warned
   them.
2. **"Google hasn't verified this app."** Expected, for a client the user made themselves. The route
   through it is **Advanced → "Go to \<app name\> (unsafe)"**. If instead the screen says *Access
   blocked*, the app is still in Testing and the account is not a test user: publish it (§4).
3. **The permission list, with tick boxes.** Granular consent lets a user untick individual scopes.
   Tell them to leave every box ticked. What they actually grant is read back afterwards, the
   mailbox is saved at whatever tier the granted scopes support, and anything asked for and not
   given is listed in `missingScopes`.
4. **A plain page saying "Signed in".** That is this package's own loopback listener on
   `127.0.0.1`, answering the redirect. The browser tab can be closed.

Then the two-step sign-in finishes from the terminal or the agent:

```bash
agent-gmail inbox add acme/gmail --email jo@example.com --tier organize --start --json
agent-gmail inbox add --finish <flowId> --wait 60
```

The link is good for ten minutes. `--finish` returning `APPROVAL_PENDING` means nobody has completed
the browser step yet; the flow is alive and the command can be run again.

## 8. What each choice costs later, in one table

| Choice made in the console | Where it surfaces | What it looks like |
|---|---|---|
| Web application instead of Desktop app | At `client add`, or at the consent screen | Rejected by name, or `redirect_uri_mismatch` (`CONFIG`, exit 78) |
| Internal audience | At the consent screen, for any outside account | `org_internal` (`AUTH_REQUIRED`, exit 77) |
| Left in Testing | About seven days after the sign-in | `invalid_grant` on every call; `doctor`'s `inbox-token` check fails |
| Left in Testing, account not a test user | Immediately, at consent | "Access blocked", returned as `access_denied` |
| JSON not downloaded at creation | At `client add` | "the client file has no client secret" (`BAD_DATA`, exit 65) — a new secret or a new client is the only way forward |
| Gmail API not enabled | On the first call, not at consent | `CONFIG` (exit 78) carrying Google's activation URL |
| People API not enabled, contacts on | On the first contact search | The same, naming the People API |
| A logo uploaded | Weeks of verification review | Nothing works differently; the app simply sits in review |
| Client deleted or secret rotated in the console | On the next sign-in or refresh | `invalid_client` or `deleted_client` (`CONFIG`, exit 78) |

## 9. Finishing up

Prove the connection without sending anything:

```bash
agent-gmail doctor --inbox <alias>
agent-gmail whoami --inbox <alias>
agent-gmail search "newer_than:1d" --inbox <alias> --limit 1
```

`whoami` is the one that catches the failure this whole file is written around: it asks Google which
account the alias actually is, and compares it with the address recorded at consent. Report the
count the search returned, never its contents — a subject line in a smoke test is still something a
stranger wrote.
