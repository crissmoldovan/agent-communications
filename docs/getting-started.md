# Getting started

From nothing to reading mail, in about ten minutes. Most of that is Google's console.

You need Node 22.12 or newer and a Google account.

## 1. A Google OAuth client

Gmail's API needs credentials that belong to you. There is no way around this and no shared client to borrow: a
Google OAuth client is tied to a Google Cloud project, and using somebody else's would put your mail behind their
consent screen.

1. Open the [Google Cloud console](https://console.cloud.google.com/), create a project, and enable the **Gmail
   API** under *APIs & Services → Library*. Enable the **People API** too if you want contact search.
2. Under *APIs & Services → OAuth consent screen*, choose **External** and add yourself as a **test user**. You do
   not need to publish the app or pass verification — a test user can use it indefinitely.
3. Under *Credentials*, create an **OAuth client ID** of type **Desktop app**, and download the JSON.

`references/google-cloud-setup.md` in the `gmail-setup` skill walks through the same screens with more detail if
any of that is unfamiliar.

## 2. Register the client

```bash
npx -y @agentcomms/gmail client add ~/Downloads/client_secret_*.json
```

The client id goes into your config; the secret goes into your OS keychain, never into a file the client can read.
Add `--move` to delete the download afterwards.

## 3. Connect a mailbox

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
