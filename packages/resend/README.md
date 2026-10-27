# @agentcomms/resend

Resend for coding agents. Read a team's domains, sent and received mail, metrics and suppressions — and send email
that **nothing sends without a person's approval of exactly what goes out**, once.

```sh
npm install -g @agentcomms/resend    # or run it with npx @agentcomms/resend <command>
```

New in 0.7.0.

The local event daemon, [`@agentcomms/events-daemon`](../events-daemon/README.md), may call this package's internal
read-only event operation. It adds no Resend command
or MCP tool, and it cannot send.

## What it promises, and who enforces it

**Read-only is enforced by this package, not by the key.** Resend has no read-only API key. A full-access key can
read, send, delete domains and create keys; an account in `read` mode is kept from sending by this package's own
code, but the key itself would not stop anything else that held it. A sending-only key can only send — Resend
enforces that — and it cannot read anything, so reads with it are reported as unavailable. `agent-resend doctor`
says this on every run.

**Nothing is sent without a person.** A send is prepared, previewed — every recipient, BCC included, the reach (unique
recipients), the From domain and whether it is verified — and approved: a yes in the conversation under the account's
`chat` policy, or the approve command the result gives and a typed code under `confirm` — which the agent learns of
with `resend_send_wait`. Above ten recipients, or to an address that arrived in mail read here, a person at a terminal
approves, whatever the policy. The approval id is the request's `Idempotency-Key` and an `agentcomms_approval` tag; a
send whose outcome is unknown (`SEND_OUTCOME_UNKNOWN`) is never repeated, only checked, and a scheduled one is
"accepted", never "sent", until Resend's own last event for it says so.

**An agent's email says so in its From.** Prepare labels it `"Acme (agent)" <hello@acme.test>`: the name the From
gave, or, for a bare address, the label name the person set in the core (its CLI's `label name`, or `comms_label`), then their word —
`agent` unless they chose another ([design](../../docs/superpowers/specs/2026-10-15-agent-label-design.md), §6). With
neither name, or a label over Resend's 100 characters, prepare refuses. `--as me` (`as: "me"` on
`resend_send_prepare`) sends the From exactly as given, for when the person said so for that email; their label rules
decide otherwise, and with none an email is labelled. The preview's first line says which, and the approval binds the
whole From.

**The key is typed by a person, at a terminal.** `agent-resend account add` reads it from a hidden prompt, or from
`RESEND_API_KEY` in that terminal, and stores it in the system keychain. No MCP tool accepts a key: a key typed into
a chat stays in the transcript.

**Received mail is untrusted.** Bodies, subjects, names and attachment names arrive inside the untrusted-content
envelope with hidden text removed and counted, beside Resend's own SPF, DKIM and DMARC results. Attachments are
listed, and downloaded only when asked, into the downloads folder.

**It stays out of the way of the team's own mail.** Resend's rate limit is shared by every key of a team, and
Resend does not say which team a key belongs to, so this package asks at most twice a second from a computer in all,
whichever account asks, and a 429 through any account stops every account until Resend says it may ask again.

It never manages domains, API keys, webhooks, broadcasts, contacts or audiences, from any surface.

## Taking messages

When several agent sessions read the same received email, the first to **take** it has it, and the others leave it
([design](../../docs/superpowers/specs/2026-10-26-taking-messages-design.md)). `resend_take` (or `agent-resend take
<email>`) reads the email from Resend first — one this account did not receive, or one it sent, cannot be taken — and
keeps only its id and its Message-ID. A session that finds it is not its own hands it back (`step: "hand-back"`, or
`--hand-back`, with a reason: `not-mine`, `wrong-account`, `needs-the-person`, `duplicate` or `other`), and may mark
one done (`step: "done"`, `--done`). `resend_taken` (`agent-resend taken [<email>…]`) says who has each: `you`,
`another session` or `the person` — never which session, folder or app — and the received list and one received
email carry the same as `taken`.

- **A reply needs the take of the email it answers.** A send with an In-Reply-To answers the received email with that
  Message-ID. Another session's take refuses it with `TAKEN_ELSEWHERE` (exit `10`), whatever the setting; when the
  person turned **taking on** for the account (core's `agentcomms taking acme/resend --require on`, or
  `comms_taking`), a session that has not taken it is refused with `TAKE_REQUIRED` (exit `10`). Both are asked at
  prepare, before any preview or approval, and again before the send — so a take released in between sends nothing.
  A new email, with no In-Reply-To, answers nobody and is not held to it. When several received emails carry that
  Message-ID — the sender writes it, so a forged copy can carry another's — the reply answers each, and is refused
  while another session has any of them.
- **An In-Reply-To nobody has taken**, with taking on, is refused too: Resend cannot be asked which received email has
  a given Message-ID, so one naming the account's own earlier email cannot be told apart. Leave In-Reply-To out for a
  follow-up to your own mail, or let the person send it.
- **Who a session is** is worked out by the server or the command from its own process, never passed in. The person
  at their own terminal is never held to taking: they keep an email with core's `agentcomms takes keep`, and end
  or move a session's take with `agentcomms takes release` or `agentcomms takes give`.
- **A speed bump, not a boundary.** It keeps two sessions from answering one email; the send gate, the behaviour rules
  and the person's approval still decide what is sent. Every process here runs as the person.

## Getting started

A person connects an account at their own terminal, then registers the server with their agent:

```sh
npx -y @agentcomms/resend account add acme/resend               # type the key when asked; read mode by default
npx -y @agentcomms/resend mcp install --client claude-code      # a registration you approve
```

`--client` also takes `codex`, `cursor`, `gemini`, `claude-desktop`, `vscode` and `json`. Add `--account
acme/resend` to pin the server to one account. From a chat with the core server connected, `comms_server_install`
with `channel: "resend"` makes the same registration, and either one's approval is good for the other.

```sh
agent-resend doctor
agent-resend domains --account acme/resend
agent-resend received list --account acme/resend
agent-resend account policy acme/resend --mode send   # a change a person approves
agent-resend send prepare --account acme/resend --from "Acme <hello@acme.test>" --to sam@partner.test \
  --subject "Hello" --text "Hi Sam"
```

## Accounts

An account is one Resend API key for one team, named `organisation/resend`. It lives in the one agent-communications
configuration beside every mailbox and workspace, so `agentcomms names migrate`, `agentcomms secrets migrate` and
`agentcomms policy --account <name>` treat it like any other; its key is in the one secret store under
`resend:key:<id>`.

Its mode is `read` or `send`. Moving it to `send`, loosening its send policy (`chat`, `confirm`, `never`) or its
change policy (`chat`, `confirm`), and removing it are **change approvals**: a preview, and nothing until a person
agrees — in the conversation under the `chat` change policy, at their own terminal under `confirm`. Tightening
applies at once.

## Commands and tools

Every command has an MCP tool running the same operation, except three: `account add` (a key is typed at a
terminal), `approve` (under `confirm`, a person at a terminal) and `mcp` (it starts the server).

| Command | MCP tool |
|---|---|
| `agent-resend account add <name>` | — typed at a terminal |
| `agent-resend account list` | `resend_accounts_list` |
| `agent-resend account show <name>` | `resend_account_show` |
| `agent-resend account policy <name>` | `resend_account_policy` |
| `agent-resend account remove <name>` | `resend_account_remove` |
| `agent-resend doctor` | `resend_doctor` |
| `agent-resend domains` | `resend_domains` |
| `agent-resend emails list` | `resend_emails_list` |
| `agent-resend emails show <id>` | `resend_email_show` |
| `agent-resend received list` | `resend_received_list` |
| `agent-resend received show <id>` | `resend_received_show` |
| `agent-resend received download <id>` | `resend_received_download` |
| `agent-resend take <email>` | `resend_take` |
| `agent-resend taken [<email>…]` | `resend_taken` |
| `agent-resend metrics` | `resend_metrics` |
| `agent-resend suppressions` | `resend_suppressions` |
| `agent-resend send prepare` | `resend_send_prepare` |
| `agent-resend send execute <approvalId>` | `resend_send_execute` |
| `agent-resend send status <approvalId>` | `resend_send_status` |
| `agent-resend send wait <approvalId>` | `resend_send_wait` |
| `agent-resend scheduled list` | `resend_scheduled_list` |
| `agent-resend scheduled cancel <id>` | `resend_scheduled_cancel` |
| `agent-resend approve <approvalId>` | — a person at a terminal, with the command the result gives |
| `agent-resend mcp` | — it starts the server |
| `agent-resend mcp install --client <client>` | `comms_connection_change` with `add` and `app` (core): Resend into the app's connection |
| `agent-resend mcp install --client <client> --standalone` | `comms_server_install` (core): an entry of its own |
| `agent-resend mcp prune` | `comms_server_prune` (core) |

Every command that reads or changes an account — all but `account`, `doctor`, `send wait`, `approve` and `mcp` — is
recorded in core's private activity log, the same from a command and a tool: the email ids, subjects and senders it
touched, a download's file names and sizes, a send's recipients and approval, and how it ended. Never a body or an
attachment's bytes. `agentcomms activity sessions` shows it, and `agentcomms activity record off` stops it.

Every command takes `--json` for the whole result, with stable exit codes: `0` ok, `10` a send or a change was
refused or needs approval, `64` usage, `65` bad data, `66` not found, `69` Resend or the secret store unavailable,
`75` temporary, `77` key or permission needed, `78` configuration problem.

The skills `resend-reading` and `resend-sending` teach an agent to use them. Everything else — the other channels,
the design and the reference pages for every command and tool — is in
[the repository](https://github.com/crissmoldovan/agent-communications).
