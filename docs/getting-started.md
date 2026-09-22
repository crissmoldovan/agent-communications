# Getting started

From nothing to reading mail, in about ten minutes. Most of that is Google's console.

You need Node 22.12 or newer and a Google account.

## The short version

```bash
npm i -g @agentcomms/gmail
agent-gmail setup
```

`setup` is this page as a command. It walks the same Google Cloud screens with a link to each and says what to
type in every field, finds the JSON you download at the end, connects a mailbox, and offers to register the MCP
server — skipping whatever is already done. If it works, you do not need the rest of this page.

The rest of this page is here for three reasons: to explain *why* each screen is set the way it is, to be
readable before you run anything, and because the one step nothing can automate — approving the grant in your
own browser — is easier to meet if you have read about it first. Everything below is also what `setup` does, in
the same order.

An agent can drive the same steps over MCP with `gmail_setup`, `gmail_inbox_add` and `gmail_inbox_finish`; the
grant is still yours to approve.

## 1. A Google OAuth client

Gmail's API needs credentials that belong to you. There is no way around this and no shared client to borrow: a
Google OAuth client is tied to a Google Cloud project, and using somebody else's would put your mail behind their
consent screen.

**One client covers every mailbox you connect, and everyone you share it with.** This is a once-per-person job, and
for a team it is a once-per-team job — see [one client, many people](#one-client-many-people) below.

Google renamed these screens in 2025. What used to be *APIs & Services → OAuth consent screen* is now **Google Auth
Platform**, with *Branding*, *Audience*, *Data access* and *Clients*. The links below go straight to the right page.

1. **Create a project** at [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate).
2. **Enable the Gmail API** —
   [console.cloud.google.com/apis/library/gmail.googleapis.com](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
   Enable the [People API](https://console.cloud.google.com/apis/library/people.googleapis.com) too if you want
   contact search.
3. **Branding** — [console.cloud.google.com/auth/branding](https://console.cloud.google.com/auth/branding). An app
   name and your own address as the support email is enough.
4. **Audience** — [console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience). Choose
   **External**, then press **Publish app** so the status reads **In production**.
5. **Clients** — [console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients) → *Create
   client* → application type **Desktop app** → **Download JSON**.

> ### Do not leave it in *Testing*
>
> This is the one step people get wrong, and it fails a week later rather than immediately.
>
> While the audience is **Testing**, Google says: *"Authorizations by a test user will expire seven days from the
> time of consent. If your OAuth client requests an `offline` access type and receives a refresh token, that token
> will also expire."* Every mailbox you connect would stop working after seven days with `invalid_grant`, and you
> would reconnect them every week forever.
>
> **In production** with no verification is the right setting for personal use. You are not publishing anything to
> anyone: it means your own grants stop expiring. The costs are a one-off warning screen the first time you sign in
> (*Advanced → "Go to … (unsafe)"*, expected for a client you made yourself) and a ceiling of 100 Google accounts
> that may ever authorise this client — irrelevant unless you are handing it to a large team.
>
> Verification and its security assessment are only needed to go **beyond** those 100 accounts. Nothing here asks
> you to do that.

`references/google-cloud-setup.md` in the `gmail-setup` skill walks through the same screens with more detail if
any of that is unfamiliar.

### One client, many people

The client you just made is not per-mailbox and not per-person. The same `client_secret.json` authorises as many
Gmail accounts as you like, and can be handed to colleagues, who each sign in as themselves — their mail never
touches your account, only your *client registration*.

**If everyone is on the same Google Workspace domain**, set the audience to **Internal** rather than External at
step 4. An internal app has no seven-day expiry, no 100-account ceiling, and no unverified-app warning, because
Google already trusts it within your own organisation. One admin does steps 1–5 once, shares the JSON, and nobody
else opens the console at all.

## 2. Register the client

```bash
npx -y @agentcomms/gmail client add ~/Downloads/client_secret_*.json
```

The client id goes into your config; the secret goes into your OS keychain, never into a file the client can read.
Add `--move` to delete the download afterwards.

## 3. Connect a mailbox

> `agent-gmail setup` does steps 2 and 3 together, and offers step 4 as well. Run it instead of the commands
> below if you would rather not do them one at a time.

```bash
npx -y @agentcomms/gmail inbox add work --start
```

This prints a Google sign-in link and a `--finish` command, then returns. Open the link, choose the account, leave
every box ticked, and run the `--finish` command it printed.

Two steps rather than one because an agent cannot sit and wait for a browser: its shell is usually gone long before
a person has read a consent screen. At a terminal you can drop `--start` and it will wait.

> **Choose the account carefully.** Google's account chooser offers whoever is already signed in, and a grant made
> as the wrong account is a mailbox connected under a name that does not describe it. Pass `--email you@example.com`
> and it will refuse a sign-in as anybody else.

### Coming from another Gmail MCP server?

Skip steps 1 to 3. If you already have a working `@artymclabin/gmail-mcp` or similar setup, its credentials can be
reused directly:

```bash
npx -y @agentcomms/gmail inbox import --dry-run   # what it would bring over
npx -y @agentcomms/gmail inbox import             # do it
```

Every mailbox comes across with its existing OAuth client and refresh token. No browser, no re-consent.

One thing an import cannot bring is a permission the other server never asked for. Most legacy servers do not
request `openid` or `userinfo.email`, so `doctor` will report those as missing on every imported mailbox. Nothing
is broken — the address is still resolved from the mailbox profile — but if you want a clean `doctor`, re-consent
each one, which takes the scopes the import could not:

```bash
agent-gmail inbox reauth <alias> --start
```

A re-consent keeps the mailbox's existing access tier. It does not widen anything.

## 4. Check it

```bash
npx -y @agentcomms/gmail doctor
```

`doctor` states what is wrong and the one command that fixes each thing. It exits `0` when nothing is broken and
`78` when something is, so a script can gate on it.

## 5. Read something

```bash
npx -y @agentcomms/gmail search 'newer_than:7d' --inbox work --limit 5
npx -y @agentcomms/gmail thread <threadId> --inbox work
```

That is the whole loop. Everything else — drafting, organising, attachments, sending — builds on it.

## Using it from an agent

The steps above give you a CLI. To let an agent use the same mailboxes:

```bash
# The MCP server, for Claude Code, Cursor, Codex, Claude Desktop, Gemini CLI
npx -y @agentcomms/gmail mcp install --client claude-code

# The skills, which teach an agent how to use it well and where to stop
npx skills add crissmoldovan/agent-communications --skill '*'
```

Restart the client afterwards. The skills work with the MCP server and also without it, falling back to the CLI.

> **Remove any other Gmail MCP server once this one works.** Everything here assumes it owns the only route to
> Gmail's send endpoints. A second server with an ungated send tool does not break that guarantee so much as stand
> beside it: an agent simply uses the other one and nothing asks you first. `doctor` lists any it can find.

## What happens when an agent tries to send

Nothing, until you say so.

```
draft ──► send prepare ──► you read the preview ──► send execute ──► sent
```

`send prepare` records an approval bound to a digest of everything a recipient would see, and to the draft's Gmail
message id, which changes whenever the draft is edited. `send execute` re-reads the draft and refuses if either has
moved. The approval is single-use.

Each mailbox has a policy: `chat` (the default) needs your yes in the conversation, `confirm` needs a code typed at
a terminal, `never` means the draft waits in Gmail for you to send yourself.

- [Sending and approvals](sending.md) — the gate in detail, and what it does not cover
- [CLI reference](reference/cli.md) — every command
- [MCP tool reference](reference/mcp-tools.md) — every tool
- [Troubleshooting](troubleshooting.md)
