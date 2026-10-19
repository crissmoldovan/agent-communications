# Getting started

From nothing to reading mail, in about ten minutes. Most of that is Google's console. Slack is
[at the end](#slack).

You need Node 22.12 or newer and a Google account.

## The short version

```bash
npm i -g @agentcomms/gmail
agent-gmail setup
```

`setup` is this page as a command. It walks the same Google Cloud screens with a link to each and says what to
type in every field, finds the JSON you download at the end, connects a mailbox, and offers to register the MCP
server — skipping whatever is already done. If you stop it partway, the next run offers to carry on from the last
screen you confirmed, or to use the client file already in your downloads. If it works, you do not need the rest of
this page.

The rest of this page is here for three reasons: to explain *why* each screen is set the way it is, to be
readable before you run anything, and because the one step nothing can automate — approving the grant in your
own browser — is easier to meet if you have read about it first. Everything below is also what `setup` does, in
the same order.

An agent can drive the same steps over MCP with `gmail_setup`, `gmail_client_add`, `gmail_inbox_add` and
`gmail_inbox_finish`. The Google Cloud screens are still yours to click through, registering the client is a change
you approve, and the grant is yours to give in your own browser.

## 1. A Google OAuth client

Gmail's API needs an eligible OAuth client. You can create one yourself, or an organisation can provide one through
an organisation profile. Run `agent-gmail setup --profile <file>` to add that profile through its own approval;
setup chooses the active client from the mailbox's organisation name and skips the Cloud steps. Without a profile,
create the client below in a Google Cloud project you control.

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
Add `--move` to delete the download afterwards. It shows you which client it is about to register and asks you to
type `yes` first: every mailbox signs in through this client, so adding one is a change you approve. An agent that
runs it gets the same preview and an approval id, and runs it again with `--approval <id>` once you have said yes.

## 3. Connect a mailbox

> `agent-gmail setup` does steps 2 and 3 together, and then offers the MCP registration from
> [Using it from an agent](#using-it-from-an-agent). It does not run step 4 for you. Run it instead of the
> commands below if you would rather not do them one at a time.

```bash
npx -y @agentcomms/gmail inbox add acme/gmail --start
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

Every mailbox comes across with its existing OAuth client and refresh token. No browser, no re-consent — but the
import lists every mailbox it will connect and waits for your `yes` before it copies anything. An agent that runs it
gets the same list and an approval id, and runs it again with `--approval <id>` once you have said yes.

One thing an import cannot bring is a permission the other server never asked for. Most legacy servers do not
request `openid` or `userinfo.email`, so `doctor` will report those as missing on every imported mailbox. Nothing
is broken — the address is still resolved from the mailbox profile — but if you want a clean `doctor`, re-consent
each one, which takes the scopes the import could not:

```bash
agent-gmail inbox reauth <alias> --start
```

A re-consent keeps the mailbox's existing access tier. It does not widen anything.

To move an already-connected mailbox onto an organisation profile's active client, first read the generation from
`agentcomms org show <organisation>`, then run:

```bash
agent-gmail inbox reauth <name> --client <organisation>-1 --start
```

Use the generation name `org show` reports; `-1` is only the usual first generation.

## 4. Check it

```bash
npx -y @agentcomms/gmail doctor
```

`doctor` states what is wrong and the commands or actions that fix each thing, one command per line when several are
needed. It exits `0` when nothing is broken and `78` when something is, so a script can gate on it.

## 5. Read something

```bash
npx -y @agentcomms/gmail search 'newer_than:7d' --inbox acme/gmail --limit 5
npx -y @agentcomms/gmail thread <threadId> --inbox acme/gmail
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

Registering the server hands your agent a new set of tools, so it is a change you approve: the command shows what
it will register — which server, which client, under which name, pinned to what — and asks you to type `yes`. Run by
an agent, it exits `10` with that preview and an approval id instead, and the agent runs the same command again with
`--approval <id>` once you have agreed. Restart the client afterwards. The skills work with the MCP server and also
without it, falling back to the CLI.

Or register the core server instead, and let the agent install the rest from the conversation:

```bash
npx -y @agentcomms/core mcp install --client claude-code
```

After a restart it has `comms_server_install`, which registers the Gmail or Slack server with any client, and the rest
of the core's upkeep. Each of those changes comes back as a preview with an approval id for you to agree to — a yes in
the chat under the default `chat` change policy, the approve command the result gives, at your terminal, under
`confirm` — and a newly registered server appears after the client is restarted once more.

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

Each mailbox has a policy: `chat` (the default) needs your yes in the chat, within ten minutes; `confirm` needs a
code typed at a terminal, within thirty, and the agent then has 24 hours to send it; `never` means the draft waits in
Gmail for you to send yourself. Under `confirm` the agent hands you the command to run and waits for it
(`gmail_send_wait`) — you never have to tell it you approved. If you say no, it revokes the approval.

## What an agent may do, and how it writes

Every send waits for your yes. You can also decide ahead of time what an agent may start at all, per account and per
conversation, and how it should write.

**What it may do is a rule, and the tools hold it.** For example: let it reply and react in a Slack workspace, but
never start a conversation, edit or delete; or never send mail to anyone at a client's domain.

```bash
agentcomms behaviour allow acme/slack reply,reaction
agentcomms behaviour allow acme/gmail none --conversation @client.test
agentcomms behaviour      # every rule, and what each account allows
```

An act no rule allows is refused before any preview, and again at send if you narrowed the rule after saying yes. The
agent is told to say which rule stopped it and not to try again. A rule that only narrows applies at once; one that
lets an agent do more is shown to you first. With no rule, everything is allowed, as before. A server started before
0.22.0 holds no rule until its client restarts it, and `agentcomms doctor` names any that is.

**How it writes is your writing profile:** plain Markdown files in `compose/` in the configuration directory — for
every message, for a platform, for one account, or for one conversation. `agentcomms profile init acme/gmail` starts
one from a starter (tone, language, length, sign-off, threads) and never overwrites a file;
`agentcomms profile <mailbox> --conversation sam@partner.test --conversation @partner.test` shows what an agent would
read before writing to Sam from that mailbox, and which files it looked for. The agent reads it before it writes and follows it, and
what you ask in the conversation wins. No tool lets an agent change it.

## Slack

The Slack package is separate and needs no Google account. You make a Slack app in your own workspace from a
manifest it prints, so the scopes are visible before anything is granted, and no client secret is stored.

```bash
npm i -g @agentcomms/slack
agent-slack manifest --port 51234        # the app to create, with every field explained
agent-slack workspace add acme/slack --client-id <id> --port 51234
agent-slack doctor
agent-slack mcp install --client claude-code   # shows what it registers; you type yes
agent-slack channels --workspace acme/slack
```

The port must be the same number in the manifest and in `workspace add`. The default `read` mode gets a token
Slack itself will not let post. The `slack-setup` skill walks all of this, including moving a workspace to `send`.

### Messages sent without asking

Nothing is sent without your yes until you make a **standing approval**: your yes in advance to a few
acknowledgements, such as `eyes` or "Got it, I'll look at this and come back to you", on a Slack message that has
just arrived from another person, in the places, counts and days you set.

```bash
agent-slack standing add --workspace acme/slack --reactions eyes --places C024BE7LR --expires 7d
agentcomms standing list   # each one, its uses today and its last acts
agentcomms standing off    # end every one, at once
```

`standing add` shows each content, place, member count, limit and the expiry, and you approve it only with the code
it shows, typed at your terminal: never by a yes in chat. An agent then chooses only whether to acknowledge a message
that has just arrived, and with which of your contents. Every act goes out as your agent, and raises a notification on
your screen. Mail, top-level posts, edits, deletions and files are never sent this way. It holds against an agent
acting through the tools, not against one with a shell running as you; [SECURITY.md](../SECURITY.md) says what it
does not defend.

### An organisation's agent app, for administrators

Members connected through an organisation's profile post as themselves, labelled "Name (agent)", because the
organisation's shared send app has PKCE on and rotating tokens. To let their agents' posts appear as an app, the
administrator sets up one bot-only **agent app** for the organisation. Nobody's existing connection changes, and a
member who does nothing keeps the labelled posts.

1. `agent-slack manifest --mode agent` prints the app: a bot user with the four posting scopes, no user scope, no
   redirect, and token rotation off. Create it at <https://api.slack.com/apps> → **Create New App → From a manifest**,
   with the organisation's name, such as "RGC agent".
2. On **OAuth & Permissions**, press **Install to Workspace**, once.
3. Share the **Bot User OAuth Token** (`xoxb-…`) with members privately, as a password. Never in the profile's
   repository, and never in a chat with an agent.
4. Name the app beside the profile, in `<profile>.agent-app.json` — for `rgc.agentcomms.json`,
   `rgc.agentcomms.agent-app.json`:

   ```json
   { "agentcomms": "organisation-agent-app", "version": 1, "organisation": "rgc",
     "slack": { "workspace": "T0123456789", "appId": "A0123456789" } }
   ```

   With it, `agent-slack workspace bot` refuses any other app's token, and `doctor` tells members to ask you for this
   one. Members take it with `git pull` and `agentcomms org update rgc`, which asks before applying it. It is a separate
   file because releases before 0.20.0 refuse a profile with any key they do not know; they never open this one, so a
   member who has not updated keeps reading the profile.

Each member then runs `agent-slack workspace bot rgc/slack` once, in their own terminal, and pastes the token.

Weigh before sharing:

- **One token for everyone.** Slack lets it post under any name, with the APP badge. These tools always name a post
  after the member who approved it, but the token is not bound to anyone: share it only with members.
- **When someone leaves**, revoke the token on **OAuth & Permissions**, install the app again for a new one, and share
  that. In between, the first act a member's agent makes with the old token is refused, and nothing goes out under
  another identity; the old token is then removed from their machine, so their agent's posts go out as them, labelled,
  and `doctor` says when it was revoked, until they paste the new one.
- **Slack's free plan holds at most 10 apps per workspace**, and the agent app is one of them.

The [Slack README](../packages/slack/README.md#an-organisations-agent-app) has the details.

### When your organisation's profile changes

Run `git pull` in the organisation's repository, then `agentcomms org update <organisation>`. It shows what changed
and asks before applying it. A repair of what was approved before, a tighter update cap and
`--for-other-addresses off` apply at once.

From 0.21.0 a profile may carry an `extensions` section, where later releases add new fields. An entry your release
does not know is either skipped, and named as `not applied here`, or, when the organisation marks it required,
`org update` stops, says which release it needs, and changes nothing. Update first, then run `org update` again.

**For administrators:** nothing changes today. Members on 0.20.0 or older refuse any profile with `extensions`, and
keep their last approved settings until they update, so add an extension only once your members run 0.21.0 or later.
New fields go under `extensions`, never in another file beside the profile. [Upgrading](upgrading.md#0210-organisation-profiles-gain-extensions)
has the rules.

- [Sending and approvals](sending.md) — the gate in detail, and what it does not cover
- [CLI reference](reference/cli.md) — every command · [Slack](reference/slack-cli.md)
- [MCP tool reference](reference/mcp-tools.md) — every tool · [Slack](reference/slack-mcp-tools.md)
- [Troubleshooting](troubleshooting.md)
