# Changelog

All notable changes to this project are recorded here, newest first. Every package in this repository is released
together under one version.

## Unreleased

**Slack: edit or delete a message this account posted, through the gate a post goes through.** An agent that posted
a typo, the wrong figure or to the wrong thread could only ask you to fix it in Slack. Now:
- **`slack_edit_prepare` and `slack_edit_send`** — `agent-slack edit prepare --draft <id> --ts <ts>` and `edit send` —
  change a message's words. The preview shows the words it has now and the words it will have, and counts who sees
  them as a post's does: an `@channel`, `@here` or a room of 50 or more needs your terminal whatever the policy.
  The edit is sent as text alone, so Slack marks the message edited, and it works on a message typed in Slack too.
- **`slack_delete_prepare` and `slack_delete_send`** — `agent-slack delete prepare --channel <id> --ts <ts>` and
  `delete send` — delete one. The preview shows the message, and the replies and files that are not deleted with it.
  A deletion is at the workspace's own policy, like a post.
- **Only your own messages.** Both read the message from Slack first and refuse one the connected account did not
  write, before any preview — a deletion too, even where Slack would let an admin's account delete anybody's.
- **What you approved is what happens.** The approval binds the message as it was read: one edited in Slack after the
  preview, or a deletion's thread that gained a reply, voids it. `approve` shows an edit's and a deletion's preview
  and reads the message again first. Outcomes are recorded as a post's are; a deletion Slack answers
  `message_not_found` is done, with a note saying there was nothing left to delete.
- Replacing a message's files is not offered yet: Slack does not document what happens to the files already on it
  (design 2026-10-06 §5). No new scope is needed: both use `chat:write`, which `send` mode already has.

## 0.14.1

**Connecting Slack through your organisation's app works when your browser is in another workspace.** An
organisation's Slack app is made in its own workspace and is not distributed, so Slack will sign you in to it only
there. The sign-in link did not say which workspace that was, so Slack used whichever one your browser was last in:
someone also signed in to a second workspace got "Something went wrong when authorizing this app" with
`invalid_team_for_non_distributed_app` on Slack's page, and the sign-in never came back. Now:
- **The link names the workspace.** A sign-in through an organisation profile, and every `workspace reauth`, carries
  the workspace's id (`team=T…`), so a browser already signed in to it goes straight there. Connecting your own app for
  the first time is unchanged: which workspace it belongs to is only known once Slack answers.
- **A sign-in that never comes back says why it may not have.** When a profile sign-in times out, the message now
  says that if Slack's page showed `invalid_team_for_non_distributed_app`, the browser was in another workspace: sign
  in to the one the profile names, in that browser, and start again. Before, it said only to ask an administrator.
- If you are not signed in to that workspace in the browser at all, Slack asks you to choose one and ignores the
  link's: choose your organisation's. `docs/troubleshooting.md` has the steps.

## 0.14.0

**Approving a send no longer races the clock.** One email to a colleague, from Claude Code, took four attempts and
twenty minutes and never went: approved at the terminal, it expired unused four minutes later because nothing told the
agent, and the send then asked for the approval just given (CUE-404). Now:
- **An approval lasts as long as its route needs.** A send or change that a yes in the chat approves still waits ten
  minutes. One that needs you outside the chat — the `confirm` policy, or a send raised to it — waits thirty minutes
  for you, and once you approve it at your terminal or in a form the agent has 24 hours to use it, once. A download's
  question keeps its thirty minutes.
- **The agent learns that you approved by waiting.** `gmail_send_wait`, `slack_approval_wait`, `resend_send_wait` and
  `comms_approval_wait` — `agent-gmail send wait`, `agent-slack approval wait`, `agent-resend send wait` and
  `agentcomms approval wait` at a terminal — say where an approval stands: 30 seconds by default, 300 at most,
  `--wait-seconds 0` for the status now. They never approve, claim or send. Every refusal that sends you to a terminal
  names the wait beside the command, and the skills wait rather than ask you to say you have approved.
- **Every send, status and list says where its approval stands.** Results and refusals carry `approval`: its
  `state`, whether it can be used now (`claimable`), its route and its times. An expired one says "this approval
  expired; nothing was sent with it", with when it was prepared or approved and when it expired — on the send too,
  where it used to come back as `APPROVAL_VOID`, or as `APPROVAL_REQUIRED` asking for the approval again.
- **A send says only what it knows.** When the provider's answer is lost, the send is `SEND_OUTCOME_UNKNOWN` at once:
  it may have gone, so check Sent or the channel before anything else. A send another call is making is "being sent
  by another call since …; wait for it". One the provider accepted without an id is "sent; the provider returned no
  id" — for a scheduled Resend email, "accepted (scheduled); the provider returned no id" — never an empty id. A send
  holds a two-minute lease, renewed every thirty seconds and checked before each provider step, so a long Slack upload
  stays `sending` and a sender that lost its lease sends nothing.
- **"Did it go?" has an answer.** `agent-gmail send list` (`gmail_send_list`) adds `unsent`: drafts whose approval
  expired in the last seven days, said only as far as the records read prove — "not sent with any approval in the
  last 90 days", "not sent with any of the 500 most recently changed approval records", or "indeterminate (…)" — with
  whether Gmail has the draft "still in Drafts". `draft show`, `draft list` and `doctor` say the same, and Slack's
  `draft list` says it of each draft's current revision. None of them sends anything or touches a draft.
- **One decision on the confirmation route.** A client you have not trusted with forms gets "This needs your approval
  outside the chat: run … in a terminal, and I will wait with gmail_send_wait." Declining a form revokes the approval;
  cancelling one decides nothing and leaves it waiting. The trusted-client tools speak of clients "the person chose to
  trust", and nothing says a client is known to reach a person.
- **A colleague on your own domain is not escalated by the domain alone.** An address seen in mail read this week
  still raises a send to `confirm` unless this mailbox has written to it; a domain seen there now does so only for a
  recipient outside the mailbox's own domains. "Written to" reads up to 50 matches in Sent (it read five) within 200
  requests a prepare, kept ten minutes so the terminal approval does not ask Gmail again, and the preview says why an
  address escalated using only what was recorded.

**Turning sending off is final for what was waiting.** Setting a send policy to `never` revokes every send waiting on
that mailbox, account or workspace, and setting it back later revives none of them ("sending was turned off since this
was prepared (policy: never)"); the change lists what it revoked, what was already being sent, and what it could not
revoke. A terminal or form approval under `never` revokes instead of approving. A removed mailbox's or account's
approvals read revoked ("its mailbox or account was removed").

**The configuration moves to version 3, which 0.13 cannot read.** That is what holds the rule above against a 0.13
process still running. The first 0.14 server or command that prepares, approves or sends anything, or changes a send
policy, converts it; from then on a server still on 0.13 fails every call it starts with "this release reads versions
1 and 2". **Restart every client after updating.** Sends 0.13 prepared and nobody used are retired ("prepared by an
earlier release; prepare it again"), and until they are — no sooner than ten minutes after the conversion — no send
policy can be loosened; `doctor` shows them under "earlier-release approvals", with any send 0.13 was already making,
which is left to finish. This breaks the usual rule that a release reads a configuration version before any release
writes it, on purpose: a 0.13 process that kept going could still send with an approval prepared before sending was
turned off.

**Approval records are kept 90 days.** A finished approval is deleted 90 days after it finished, in one bounded batch
a day, with an `approval.retained` line in the audit log first. A record that cannot be read, or fails its integrity
check, is shown as `corrupt` — never skipped, never used — and `doctor` counts them.

What it means for you: a minor release, with changes you will see and some a script will notice.
- **Restart every client after updating.** Configuration version 3 locks out 0.13: a server still running it fails
  every call until its client restarts it on 0.14. Approvals prepared before the update are retired — prepare them
  again — and 0.13 cannot use what 0.14 prepares.
- `agent-gmail send list --json` and `gmail_send_list` now return `{ approvals, unsent }` instead of an array, and
  `gmail_send_list` reads Drafts.
- The entries of `agentcomms approvals list --json`, `comms_approvals_list` and Gmail's list are now each approval's
  public object — `approvalId`, `state`, `claimable`, `route`, its times and reason, what a sender wrote inside the
  untrusted-content envelope. The stored fields, `policy`, `requiredPolicy`, `riskFlags` and the rest, are gone.
  `--state corrupt` lists the records that cannot be used.
- What `agentcomms approvals revoke --json`, `comms_approval_revoke` and `agent-gmail send cancel --json` return, and
  the `approval` in `agent-resend send status --json` and `resend_send_status`, is that same public object instead of
  the stored record: the recipients, the subject and a question's file names come only inside the envelope.
- An approval id of the wrong kind or channel — a send's given to a change, or a Slack post's to `agent-gmail approve`,
  say — now gets the same `NOT_FOUND` as an id nobody prepared, with no hint pointing at another command. Every
  approval `NOT_FOUND` now reads alike, "nothing was sent: no approval <id>" (or changed, or saved), pinned servers
  included: "no approval "x" for the "work" mailbox" is gone.
- An uncertain provider outcome is `SEND_OUTCOME_UNKNOWN` (exit `10`, never retryable) instead of `TRANSIENT` (exit
  `75`), for Gmail, Slack and Resend alike. An expired approval is `APPROVAL_EXPIRED` everywhere; `APPROVAL_REQUIRED`
  now means only that a person's approval is missing; a used approval is `APPROVAL_VOID`, and one being sent is a
  retryable `APPROVAL_PENDING`. Branch on the code.
- New commands and tools: the four waits above.
- `sentMessageId` (Gmail), `ts` (Slack) and `resendId` (Resend) are absent when the provider returned no id, and each
  send result says what happened in `said`.
- Resend's `send status` says what Resend's own last event reports, attributed to it and about the whole email —
  "sent (Resend reports delivered)", "Resend reports a bounce", "scheduled for <time>, not yet sent", "Resend reports
  it cancelled" — in a new `outcome` and its `verdict`. With a sending-only key it says "current outcome unavailable"
  rather than "sent". A scheduled email is "accepted by Resend, scheduled for <time>", never "sent" because its time
  has passed. A cancellation Resend confirmed stays a success even when this machine could not record it. An approval
  used already is refused as "accepted by Resend at <time>", never as sent.
- Setting a send policy — `agent-gmail inbox policy`, `agent-slack workspace policy`, `agent-resend account policy` and
  their tools — returns `fenced`: `{ revoked, alreadySending, couldNotRevoke }`, which the CLI prints.
- A Slack file post that fails says "nothing was posted", naming any file that went up first.
- Finished approval records are deleted 90 days after they finished. The pruning runs at most once a day, at most 200
  records, when something next uses approvals: a call may take up to 5 seconds once a day.
- To get 0.14.0: your servers will say an update is out. Say "update my comms" in a chat, or run the update command
  the stop gives, then restart every client.

## 0.13.1

**A command you are told to run now runs where you paste it.** When an approval waits for you at your terminal, a
change has to be run again with its approval, or `doctor` names a repair, the command shown was a bare name —
`agentcomms approve <id>`, `agent-gmail approve <id>` — which runs only where that package is installed globally.
Installed the default way, through your MCP client, or with npx or from a checkout, you had nothing by that name on
your PATH, so the one step only you can take failed with "command not found". Every such command now names the
installation that printed it: its own Node and the file of its CLI, by full path, with the folders it keeps its
configuration, state, data and secrets in — and, for a command that saves files, its downloads folder — given as
options (`--config-dir` and the rest). It runs as pasted, from any folder, and reaches the same approval the agent is
waiting on (CUE-403).
- Where one of its words cannot be written the same way for cmd.exe and both PowerShells, the command is shown as
  its words in JSON, with what to do: type them, quoted for your shell. On Windows this is the usual case when Node
  is installed under `C:\Program Files`, the default, because that path needs quotes; Node from nvm-windows, Volta
  or a tool cache gives a line to paste.
- A command that belongs to another product — Gmail's, when core is the one printing — is found among the servers
  registered with your MCP clients, at exactly this release, and is never run through npx. When there is none,
  there is no command: the message names the product and the release it needs, says it is not locatable here, and
  asks you to install or update it the way you usually do. It never guesses one.
- Every CLI takes `--config-dir`, `--state-dir`, `--data-dir`, `--secrets-dir` and `--downloads-dir`, and every
  server the first four. Each pins that one folder for that run and nothing else; `AGENT_COMMS_CONFIG_DIR` moves the
  state and secrets folders with it, and these do not.

**A server registered by `mcp install` now carries its folders.** The entry written for a client — managed, npx or
local — names the configuration, state, data and secrets folders it was installed with, so the server, and the
approvals it hands you, use the same ones whatever environment the client starts it in. On Windows this also stops
a server registered with roaming and local AppData apart from looking for its file secrets in the wrong one. An entry
from an earlier release keeps working as it did: `doctor` reports it as a warning with the command that registers it
again with its folders, and the next `update` or `mcp install --force` you approve rewrites it.

**The daily update check works in the folders it was started with.** A check started by a command run with path
options reads and writes only those folders, wherever its environment points.

**Skills hand you the command a result gives.** They no longer tell an agent to write out `… approve <id>` itself:
they pass on the command the result gives, as it is, or say why there is none.

What it means for you: a patch release. Nothing changes in how sends, posts or changes are approved, and no command,
flag or tool was removed.
- Commands printed for you are longer, because they name the Node, the file and the folders. Paste them as they are.
- Each channel package now depends on `@agentcomms/core` of exactly the same version, which npm installs with it.
- On Windows with Node under `C:\Program Files`, approvals and repairs come as words to type rather than a line to
  paste. Putting `agentcomms` and the `agent-*` commands on your PATH is a separate follow-up: 0.13.1 adds, changes
  and checks nothing on your PATH.
- A command 0.13.0 or earlier printed by its bare name still needs that name on your PATH. Troubleshooting, "A
  command a result gave you is not found", gives two best-effort ways round it: the managed registration's own Node
  and runtime file, or `npx -y @agentcomms/<product>@0.13.0 …` — that exact release, never `latest` — with any
  `AGENT_COMMS_*` folders you used set again. Neither works for every installation, which is why updating is the fix.
- To get 0.13.1: your servers will say an update is out. Say "update my comms" in a chat, or run the update command
  the stop gives, then restart your client.

## 0.13.0

**An organisation can now set up its Google and Slack apps once, for every member.** Until now each person connecting
Gmail made their own Google Cloud project and OAuth client, and each person connecting Slack made their own Slack app.
An organisation can now describe its shared apps — one Google client, and a Slack app for reading and one for posting —
in a small file, an *organisation profile*, and every member adds it with one command:
`agentcomms org add ./<organisation>.agentcomms.json` (or `comms_org_add` from a chat). After that, connecting a
mailbox or the organisation's Slack needs no Cloud console and no app of your own. Members' other accounts — a
personal gmail.com, another company's address — keep working on their own clients and apps; the organisation's are
added beside them, never in place of them (CUE-387, CUE-389).
- A profile is data, never code, checked by a strict schema; adding, updating and removing one is a change you approve,
  bound to the file's exact contents, and the client secret is never shown.
- `agentcomms org list | show | update | remove` (and `comms_orgs_list`, `comms_org_show`, `comms_org_update`,
  `comms_org_remove`). `org update` re-reads the file and repairs the configuration if an older release or a manual
  edit drifted from it; `doctor` reports drift with the command that repairs it.

**Gmail uses the organisation's client without asking.** `inbox add`, `setup` and `gmail_inbox_add` choose the Google
client before the consent link is made: an organisation's mailbox name (`rgc/gmail`) gets that organisation's client;
`--for-other-addresses` lets it serve your other addresses too, if you asked for that. `setup` skips the Google Cloud
steps when the organisation provides the client, and `setup --profile <file>` adds the profile first. Every check is
made again when Google answers, and a sign-in that no longer fits is stopped and its grant revoked. A machine with no
organisation profile behaves exactly as before (CUE-390).

**Slack through the organisation's apps.** `agent-slack workspace add <organisation>/slack` signs in through the
profile's read app (or its send app with `--mode send`), checks the sign-in is for the right workspace and app before
storing anything, and `workspace mode` moves an account between the two apps instead of asking you to edit one. The
token it replaces is revoked — only when Slack confirms it, or says the token is dead — and anything Slack has not
confirmed is kept and retried by `doctor`, even across a restart, until the token's own expiry. `workspace remove`
finishes what revocations it can first and leaves the rest for `doctor`. A sign-in that does not finish, for example
because the workspace requires an administrator to approve the app, says so without guessing why, and never says you
declined. One stopped with Ctrl-C just as it saves keeps the account it saved and says so, rather than reporting that
nothing happened (CUE-391).

What it means for you: a minor release; nothing changes unless you add an organisation profile.
- Profiles need the version-2 account names (`organisation/platform`); `agentcomms names migrate` moves an older
  configuration, and `org add` says so if it is needed.
- The configuration gains two keys, `organisations` and `pendingRevocations`. Releases before 0.13.0 keep them but do
  not know their rules: update every machine that shares a configuration.
- `client add --replace` and `client remove` now refuse a client an organisation's profile owns, and point at
  `org update` and `org remove`.
- With an organisation's Gmail client installed, `setup` asks which mailbox it is setting up before it decides which
  client to use (headless, pass `--inbox`); without one, `setup` asks and answers exactly as before.
- To get 0.13.0: your servers will say an update is out. Run `agentcomms update` (or say "update my comms"), then
  restart your client.

## 0.12.3

**A command printed for you to paste can no longer run something an email's sender chose.** After `agent-gmail send
prepare`, the CLI printed the command to send the draft with its subject in JSON's double quotes. Those are not shell
quotes: inside them, macOS's and Linux's shells and PowerShell run `$(…)` and backticks, and Windows' cmd.exe expands
`%NAME%`. A reply's subject comes from the email being answered, so whoever wrote that email chose it, and pasting the
printed line could have run their command. Every command the Gmail, Slack, Resend and WhatsApp CLIs and servers print
for you to run is now built as separate words and quoted for the shell it will be pasted into, by the rule
`agentcomms` commands have used since 0.12.2. Where a word cannot be written safely for every Windows shell, no line
is printed: the command is shown as its words in JSON for you to type. The printed send command also carries
`--expect-cc` and `--expect-bcc`, which it had left out, so a draft with Cc or Bcc failed its own check when you ran
it (CUE-398).

**Blind-copied recipients now receive drafts sent through agent-gmail.** A draft made with `agent-gmail draft create`
or `gmail_draft_create` (or a reply or update) with `--bcc` lost its Bcc recipients before Gmail ever saw it: the
library that writes the message strips the Bcc header by default, because a mail server normally takes the blind
recipients from elsewhere, and Gmail takes them from that header. So those recipients were never sent the email, and
nothing said so. The header is now kept. Gmail sends to everyone in To, Cc and Bcc and, as it always does, does not
show the Bcc addresses to anyone else. Drafts written in Gmail itself were never affected. If you have relied on
`--bcc`, the people you blind-copied may not have received those emails (CUE-402).

**An email or reaction that may have gone out is no longer recorded as failed.** 0.12.2 did this for Slack posts; now
Gmail, Resend and Slack reactions work the same way. A send is recorded as *failed* only when the provider's answer is
one it documents as given before it acts: a malformed request, a refused key or permission, something not found, or a
rate limit. If the connection drops after the request left, a server error comes back, or the answer can't be read,
the approval now reads *unknown*, and the message says where to look before trying again: Gmail's Sent folder, the
Resend dashboard, or the message in Slack. Before, these read *failed*, which said nothing had gone out when it might
have, and invited sending the same email again (CUE-395, CUE-396).
- On Resend, an idempotency conflict (409) is *unknown*, not *failed*, because the conflicting request may be the very
  email being sent.
- A send or reaction the provider accepted is never recorded as failed, even if writing it down afterwards goes
  wrong. That failure is added to the result as a `note` instead.

**A send that stops before reaching Gmail or Resend always frees its slot and says why.** Between claiming the
approval and asking the provider to send, several things can fail: reading the draft one last time, the draft having
changed, writing the attempt down. Each step that tidies up after such a failure — freeing the send-limit slot,
marking the approval failed, writing the record and the audit entry — is now tried on its own, so one failing no
longer skips the rest, and the error you see is still the one that stopped the send, with anything that could not be
tidied up added to its hint. Before, one failed step could leave a slot taken until the hour passed, or an approval
reading *unknown* when nothing had been sent (CUE-395).

**Reactions that are already how you asked count as done.** Adding a reaction you had already added
(`already_reacted`), or removing one of yours that isn't there (`no_reaction`), now succeeds with a note saying so,
instead of failing. Removing a reaction only ever removes *yours*; other people's stay, and the note says that too
(CUE-396).

**Cancelling a Gmail attachment download stops it.** If you cancel `gmail_attachment_download` in your client, the
transfer now stops; files already saved in full are kept, and no part-written file is left. Cancelled while it is
still settling where to save, it leaves your answer unused (CUE-397).

**Also**
- `doctor`'s repair for a problem that needs more than one command now lists each command on its own line, ready to
  paste one at a time, instead of joining them with `&&`, which Windows PowerShell 5.1 does not accept.
- Where `doctor` used to print a repair with a `<client>` placeholder to fill in, it now prints `mcp install --help`,
  which runs as shown and lists the clients to choose from.
- `--expect-subject none` on `agent-gmail send execute` now also matches a draft whose subject is literally "none"
  (or only spaces), not just an empty one. It meant "an empty subject" before, so such a draft could not be sent from
  the CLI at all.
- A send stopped by the hourly or daily limit now leaves an audit entry, and its approval records the limit's own
  message.

What it means for you: a patch release, and the first item is a security fix.
- Update if you use the Gmail CLI to send, if you send from Gmail or Resend, or if you react in Slack.
- Nothing changes in how sends are approved, and no command, flag or tool was removed. Results gained an optional
  `note`. On macOS and Linux most printed commands read as before; WhatsApp's handoff hints now include the source,
  chat and account arguments they had been missing. On Windows, a word such as a port number is now in double quotes.
- For code that uses the packages directly: the operation contexts take an optional `platform`, and core's
  `DownloadAtTerminalOptions.command` also accepts a `ShellCommand`. Existing callers are unchanged.
- To get 0.12.3: your servers will say an update is out. Run `agentcomms update` (or say "update my comms"), then
  restart your client.

## 0.12.2

**Using several Resend accounts on a busy machine no longer gets requests refused.** Every Resend request on a machine
waits its turn on one rate-limit lock. The wait was capped at five seconds in total. So when several accounts asked at
once on a heavily loaded computer, the last one in line gave up with "another agent-communications process is holding
…", although the lock was being passed on normally. Now the five seconds count from the last time the lock changed
hands. A request waits its turn, and gives up only if one holder keeps the lock for five seconds, or the whole wait
reaches 30 seconds (CUE-307).

**Gmail attachment downloads can no longer hang.** A download now stops if Gmail sends nothing for 30 seconds, or if
the file takes longer than its size allows: at least two minutes, and about two and a half minutes for 15 MiB. The
error says which limit stopped it, and names the message and part. Before, a stalled connection kept the call open
for ever, and the agent waiting on it. A reply that turns out not to be the attachment is now refused, instead of
being saved as an empty file (CUE-304).

**Cancelling a Slack download or post stops it.** If you cancel `slack_file_download` or `slack_post_send` in your
client, the transfer now stops; files already saved in full are kept. A post cancelled before Slack has it posts
nothing, and its approval is still yours to use. Once the post is on its way it is not abandoned, and the result
says the cancellation came too late (CUE-305).

**A Slack post is no longer recorded as failed when it may have gone out.** If the connection drops after the post
was sent, or Slack answers with an error that doesn't certainly mean nothing was posted, the approval now reads
*unknown* rather than *failed*, and the message says to look in the channel before posting again. A post Slack
accepted is never recorded as failed, even if recording it afterwards goes wrong.

**Also**
- **On Windows, commands printed for you to copy now run the same in cmd.exe, Windows PowerShell and PowerShell 7**,
  so a folder with a space in its name works as shown. When a value can't be written safely for all three, no
  runnable line is printed: the command is shown as its words in JSON, for you to type with that value quoted for
  your shell (CUE-306).
- **An approval handed to `comms_update` that is no longer needed is reported as such.** When nothing is behind any
  more, it says there is nothing to apply, that the approval was not used, and what had become of it. Before, it told
  you to call again and the change would apply at once (CUE-303).
- **Two kinds of test that could fail a release on a busy machine are fixed.** Slack's sign-in tests no longer race
  the two `localhost` addresses. Slack's test files get ten minutes each, as Resend's and WhatsApp's do (CUE-302,
  CUE-383).

What it means for you: a patch release.
- If you use several Resend accounts, or download large Gmail attachments, update.
- Nothing changes in how sends or changes are approved. A Slack post whose outcome is uncertain now reads *unknown*:
  look in the channel before posting it again.
- To get 0.12.2: your servers will say an update is out. Run `agentcomms update` (or say "update my comms"), then
  restart your client.

## 0.12.1

**`agent-gmail setup` finds the client file you just downloaded.** The last Google Cloud step is downloading the client
JSON, but setup looked for it in your downloads before that step, as the command started. So the first time through it
never found the file, asked you to type the path, and had no way to look again. Running setup a second time found the
file at once. Now setup looks when it reaches the client file step, and both prompts can look again: **Look again**
in the list of files, or Enter on an empty path. The prompt also says where it looked (`~/Downloads`, or
`XDG_DOWNLOAD_DIR`).

**Stopped partway, setup no longer starts the Google Cloud steps from 1/5.** Those five steps happen in your browser and
left nothing on the machine, so until a client was registered every run walked all five again. Setup now remembers the
last step you confirmed, and the next run offers to carry on from the step after it, or to start over. If a Desktop
client file is already in your downloads, it offers to use that file and skip the walk. `--client-json` skips the walk
too, since the file is already in hand. The record is removed once a client is registered, and nothing on the machine
changes whichever you choose.

What it means for you: a patch release, and only `agent-gmail setup` at a terminal behaves differently. `--json`,
`--no-input` and the MCP `gmail_setup` tool are unchanged; `gmail_setup` already looked again on every call.
- If you are setting up Gmail for the first time, or helping someone who is, use 0.12.1.
- To get 0.12.1: your servers will say an update is out. Run `agentcomms update` (or say "update my comms"), then
  restart your client. A new install with `npx -y @agentcomms/gmail setup` gets it already.

## 0.12.0

**You can see, and change, which folders a file may be attached from.** `agentcomms attach` (and `comms_attach` from
chat) lists the folders Gmail attachments, Resend attachments and Slack files may come from, your own entries they may
never come from, and the built-in list. `agentcomms attach roots add <folder>` and `attach deny remove <path>` widen
what can be sent, so they show a preview and wait for your approval — the preview says where a folder leads when a link
takes it somewhere else. `attach roots remove` and `attach deny add` narrow it, and apply at once. Until now the only
way to allow another folder was to edit the configuration by hand, with no approval and no audit line (#45).
- A folder is written in full or from `~`; on Windows with its drive or share (`C:\outgoing`, `\\server\share`), since
  `\outgoing` is on whichever drive happens to be current.
- A folder in your configuration that does not say where it is — a relative one, or one without a drive on Windows,
  written by hand before this release — now allows nothing. `agentcomms attach` lists it apart, in quotes, and
  `attach roots remove` takes it out exactly as written.
- The refusal for a file outside the allowed folders names the command, and that it needs your approval.

**Slack refuses a post to a channel you have not joined — before anything is spent** (#43). The preview is refused,
the approval screen refuses it, and so does the send, before the approval is claimed and before any file is uploaded;
join the channel in Slack yourself, then prepare the post again. Direct messages and group DMs are unaffected. When
the channel cannot be read, the preview says membership could not be checked. Before, the approval was used up — and
every file uploaded — before Slack refused the post.
- **A user id is no longer a place a post goes.** `U…` or `W…` as a draft's channel is refused when the draft is
  written, when it is prepared and when it is sent — a draft stored by an earlier release too. For a direct message use
  the DM's `D…` id, which `agent-slack channels` and `slack_channels` list. Mentions still take user ids.
- **A file post warns about its links** (#44). Slack may fetch a link in a file post's words and show its preview to
  the whole channel, and offers no way to turn that off for files. The preview now lists every link in the words,
  plain `https://…` ones included, and says so; to keep a link from unfurling, post it as a message of its own. Posts
  of text alone are unchanged.

**Large Slack files no longer fail on a slow connection** (#49). A download stopped at two minutes whatever its size,
so a 100 MiB file needed about 7 Mbit/s, and "try again" failed the same way every time. Now a download stops if Slack
sends nothing for 30 seconds, or if the whole file takes longer than its size allows — at least two minutes, 800
seconds for 100 MiB — and the error says which. An upload gets time in proportion to its size too, at least five
minutes.

**The day's first command no longer outlives its output** (#48). On the first command of the day the update check kept
the process running after the command had finished — up to about 70 seconds, not the ten 0.9.0 said — so `$(…)`, a
pipe or an agent's shell waited for it. The check now finishes in a background process of its own, detached from the
command's input and output; a fast answer still stops the command, and if the background process cannot start the
command asks npm itself, as before. A debugger the command was started with (`--inspect…`, in its flags or in
`NODE_OPTIONS`) is not passed on to it. MCP servers and WhatsApp are unchanged.

**Also**
- **A server-install approval says where the entry goes and what it starts** (#46): "the entry goes in
  ~/.claude.json, and claude-code will start it with …". A claim from an environment that resolves another config file
  or another command is refused with nothing written, and an npx entry starts npx by its full path, never the bare word.
  `agentcomms update` says the same for each registration it renews.
- **`setup --replace-server` serves the mailbox you just connected** (#47). Replacing an entry pinned to another
  mailbox kept that pin, so the new mailbox was reachable by no server while the finish reported success. The
  replacement is now pinned to the new mailbox, and the preview says which mailbox the old entry served. Without
  `--replace-server`, the refusal suggests a second entry (`--name gmail-<org> --inbox <new>`).

What it means for you: a minor release.
- A Slack post to a channel you are not in, or to a person's user id, that went through before is now refused with what
  to do instead.
- A hand-written attachment folder with no drive (Windows) or a relative path now allows nothing; `agentcomms attach`
  shows it, and `attach roots add` adds it properly with your approval.
- An install's preview names the config file and the command, so a preview approved in one place and claimed from a
  differently set-up terminal is refused rather than written somewhere else.
- To get 0.12.0: your servers will say an update is out; run `agentcomms update` (or say "update my comms"), then
  restart your client.

## 0.11.0

**Slack posts can carry files, behind the same preview and approval as a message.** Name up to ten local files, each
up to 100 MiB, on a draft — `files` on `slack_draft_create` and `slack_post_prepare`, `--file` on
`agent-slack draft create` — with or without words; the words become the files' message, so they arrive as one post,
in a thread when the draft replies in one.
- **Which files:** the rule Gmail's attachments follow. A regular file under your home folder, and none from its
  hidden folders, a `.git` folder or a `.env` file. A file in `/tmp`, or anywhere else, is refused: copy it under your
  home folder first. A link at the name you give is refused too.
- **What the draft keeps:** each file's real path, the name Slack will show, its size, its type and its SHA-256 —
  never its bytes. An empty file, an eleventh file or one over 100 MiB is refused, naming the limit.
- **What you are shown:** the preview lists every file with those five things, after the channel and before the
  words, and warns about a file over 10 MiB or one Slack shows in the channel itself — an image, a PDF, any text.
- **What you approve:** those bytes. The approval is bound to each file's hash. Each file is read again when the post
  is prepared, and again when it is sent — every one of them, before anything is uploaded — and a file that changed,
  was replaced by a link or moved voids the approval, and nothing is sent. Then each file goes to the upload URL Slack
  gives for it, and one call shares them all. Nothing else reaches Slack's files host but a download.
- **What comes back:** each file's id in Slack, and the message's `ts` — or `null`, with a note saying so, when Slack
  had not attached the files to a message yet. Slack's answer carries no `ts`, and none is guessed.
- **What it needs:** a workspace in `send` mode granted `files:write`. Otherwise the prepare is refused with
  `SCOPE_MISSING` and the command that fixes it, and the same check is made again at send.

**A draft can be changed.** `agent-slack draft update <draftId>` and `slack_draft_update` change any of a draft's
words, channel, thread, mentions and files, and keep the rest: `--file` / `files` replaces its files, `--add-file` /
`addFiles` adds to them, and `--no-files` / `files: []` takes them all off. Every change is a new revision, so any
approval the draft had no longer holds.

**Also**
- **The doctor says whether each workspace can send files:** yes in `send` mode with `files:write`; not in `read`
  mode, by choice; and a `send` workspace without `files:write` fails, with the sign-in that brings the scope back.
- **An attachment from outside the allowed folders is refused with advice you can follow.** The refusal, for a Gmail
  attachment and a Slack file alike, named a command for widening the folders that does not exist. It now says to
  copy the file under your home folder, not into one of its hidden folders.
- **A post of text alone is previewed and approved exactly as before**, so an approval outstanding across the upgrade
  still holds.

What it means for you: a minor release; nothing that worked changes.
- A workspace already in `send` mode was granted `files:write` when it signed in, so it can send files at once — no
  new sign-in.
- An agent that wrote its file under `/tmp` or another scratch folder copies it under your home folder first.
- A link in the words of a file post can show its preview in Slack: Slack's upload has no switch to turn that off,
  as a text post does.
- To get 0.11.0: your servers will say an update is out; run `agentcomms update` (or say "update my comms"), then
  restart your client.

## 0.10.0

**A download asks you where to save, and saves under the files' own names.** A Gmail attachment
(`gmail_attachment_download`, `agent-gmail attachments download`) or a Slack file (`slack_file_download`,
`agent-slack files download`) is no longer saved into a folder the tool chose. The first call saves nothing: it lists
the files, each with its name and size, and asks where to put them:
1. your Downloads folder: `~/Downloads`, or the one your system names (Linux's user folders, a redirected Windows
   Downloads), or the folder you set as your downloads folder. This is the default.
2. the current folder: the one your client was started in, which for Claude Code is your project.
3. another folder you name, absolute or starting with `~`. It is created if it does not exist.

The question shows the exact path of each. Files are saved there under the names their senders gave them, made safe:
- no folders, `..`, or invisible characters;
- no leading dot or hyphen;
- no names Windows reserves.

Nothing is overwritten: a name that is taken gets `-2`. Nothing else is written into your folder. The record of the
download stays with agentcomms, and the result says where each file went.

**A file that could run is saved so that nothing runs it.** A file keeps its extension only when it is a type that is
opened, never run:
- documents (PDF, Word, Excel, PowerPoint, OpenDocument, Pages, Numbers, Keynote, text, CSV);
- images, audio and video;
- archives, calendar files, contacts and mail.

Anything else gets `.download` added — `setup.exe` is saved as `setup.exe.download`, `evil.pth` as `evil.pth.download`
— and so does a file named like one that tools read on their own (`CLAUDE.md`, `Makefile`, `package.json`,
`requirements.txt` and the like). The question tells you before you answer, and so do these flags:
- **Macros:** it warns that a Word, Excel or PowerPoint file in the older formats, or an OpenDocument file, can hold
  macros.
- **Rename to use it:** if you trust a `.download` file, rename it yourself.

Every saved file is also marked as downloaded from the internet — the quarantine mark on macOS, `Zone.Identifier` on
Windows — before a byte of it is written, so Gatekeeper, SmartScreen and Office's own protections still apply.

**Some places are never saved into, whoever answers:**
- hidden folders, anywhere (a Claude Code worktree is still allowed);
- `node_modules`, Python's `site-packages` and virtual environments, and Python installations (conda and the like);
- `~/Library`;
- agentcomms' own folders;
- system folders;
- on Windows: AppData, Program Files (x86 and Arm too), ProgramData, the drive root, the PowerShell profile folders,
  and network paths. A folder written by its short name (`PROGRA~1`) is judged by the long name Windows gives it, so
  `C:\PROGRA~1` is refused as Program Files and your own folder reached by a short name is still yours;
- from WSL, on a Windows drive wherever and however it is mounted, a bind of one of its folders included: the same
  folders, refused by name wherever they sit on the drive, and any folder written by a short name, which Linux cannot
  turn back into the long one. A folder of your own there named `Windows` or `AppData` is refused with them, and the
  reason says why. A Windows drive whose mount does not say plainly which folder it shows is refused whole. A disk
  that is not a Windows drive — `/mnt/c` on an ordinary Linux, or a Linux disk mounted inside `/mnt/c` — is left
  alone.

A folder that cannot be written in is refused before your answer is used, and a choice that is not available is shown
as unavailable. A folder that loads every file whatever its name — a shell's completions folder, say — is still yours
to choose: `.download` stops what loads by extension or by a known name, not that.

**Who answers:**
- **With your change policy at `chat` (the default)**, your reply in chat is the answer, as for every other approval
  here. The agent must show you the question and wait: saving needs that question's `choiceId`, which works once, for
  those files, for thirty minutes. A mistake in the agent's second call is refused and leaves the question open.
- **With `confirm`**, the answer has to come from you where the agent cannot answer: at your terminal
  (`agent-gmail approve <id>` / `agent-slack approve <id>`), or in the form a trusted client shows you.
- **At a terminal**, the command asks you: Enter or 1, 2 or 3.
- **A script you run** at your terminal can pass `--to downloads|current|<folder>`. Without a terminal, the command
  prints the question, exits 10, and takes `--to <answer> --choice <id>` on the next run.

Why: you could not tell what was downloaded or where it went — files landed in
`~/Downloads/agent-communications/<account>/<date>_<id>/` under neutral names — and the tool, not you, chose the
place.

**Also**
- **A Gmail download that stops part-way** now records what it saved and removes a partly written file, as Slack's
  does.
- **Two files with the same contents but different names** are each saved under their own name.
- **Windows: a Google sign-in or WhatsApp draft link is opened whole.** It went through `cmd`, which cut it at its
  first `&` and tried the rest as commands. Every program agentcomms starts on Windows is now started by its full
  path.

What it means for you: a minor release that changes how downloads behave.
- `out` / `--out` are gone. A call that passes them is refused with a hint naming `saveTo` / `--to`.
- Every download now takes two steps: the question, then your answer.
- `--to` without the question's `--choice` works only when you are at the terminal.
- A file's name on disk is now the sender's, made safe, and may end in `.download`. A result shows a name as plain
  text only when it is plainly a file name; otherwise it comes back marked as untrusted, like everything else a sender
  wrote.
- To get 0.10.0: your servers will say an update is out (from 0.9.0 on); run `agentcomms update` (or say "update my
  comms"), then restart your client.

## 0.9.0

**Every server and command stops for an update, once a day.** When a newer release is out, a request is not carried
out. It gets "Hang on a minute, there's an update. Let's update first.", the version running and the one that is out,
and the two ways on: update, or not now.
- The machine asks npm at most once a day, for every server and command on it, and only about the packages it uses.
  A server asks in the background and never slows a call. A command waits about three seconds at most and then goes
  on. Offline, or when npm does not answer, nothing is stopped, and a prerelease never counts as an update.
- Update from chat with `comms_update` (say "update my comms"), or at a terminal with `agentcomms update`
  (`npx -y @agentcomms/core@latest update` where `agentcomms` is not installed).
- Not now is your decision, not the agent's: `comms_update` with `later: true`, or `agentcomms update --later`, is a
  change you approve like any other. It lasts until midnight, for the whole machine, and the next day it asks again.
- At a terminal with you at it, a command asks: update now, later today, or cancel. Without a terminal (a script, an
  agent's shell, `--json`) it does nothing and exits 11 (`UPDATE_REQUIRED`), naming both commands.
- Never stopped: updating itself, doctor, `paths`, `approve` and `approvals`, the listener a sign-in starts, and a
  call that uses an approval you already gave that is still waiting — something you approved is finished first.
- When the update is installed but the client still runs the old server, the reply says to restart the client
  instead. The Claude Code plugin's Gmail server and the Gemini extension's servers are always told to update where
  they were installed, because restarting them starts the release they pin.
- WhatsApp still makes no network request: its server and command stop once any other server or command on the
  machine has found an update.

**On by default; one switch per machine.** `agentcomms update --auto off` (or `comms_update` with `auto: "off"`)
turns the check off for this machine and needs your yes; `--auto on` turns it back on at once. `agentcomms doctor`
shows the check on one line: on or off, when it last asked, the latest release and the one running. It is skipped
whenever `CI` is set, and `AGENT_COMMS_UPDATE_CHECK=off` switches it off for a process.

Why: a second Mac sat a release behind with a bug that made installs from chat register nothing while saying they
had, and nobody knew it was behind.

**Also in this release**
- **An approval id is refused where it would not be used.** A command or tool that takes `--approval` (or
  `approvalId`) only to claim a change now refuses one on a path that claims nothing — a report, a dry run, a
  `--finish`, and any command that takes no approval at all — instead of ignoring it.
- **Slack file downloads say more when they stop.** A `--channel` download stops looking up where files were shared
  at Slack's first rate limit or permission error, and says why a file was saved as undated. A run that stops
  part-way says `complete: false` and names every file it did not save, including a part-written file it could not
  remove. An HTML file is never downloaded: it is reported as indistinguishable from Slack's sign-in page.

What it means for you: a minor release, and a behaviour change — a request can now be answered with "update first"
instead of being done.
- A script that runs these commands without a terminal exits 11 on its first run after a release until the machine
  is updated or the update is put off for the day. Set `AGENT_COMMS_UPDATE_CHECK=off` for it, or turn the check off
  with `--auto off`.
- On the day's first run, a command's output can appear after about three seconds while its process lives up to ten
  seconds more, until npm answers. Anything that waits for the command to exit — `$(…)`, a pipe, an agent's shell
  tool — waits that long too, once a day.
- A command given `--approval` where it takes none, or on a path that uses none (a report, a dry run, a `--finish`),
  now fails with a usage error instead of ignoring it. `agent-gmail setup --mcp-approval` now also needs
  `--mcp-client`.
- To get 0.9.0, run `agentcomms update` (or say "update my comms" in chat), then restart your client. From 0.9.0 on,
  the next release will tell you itself.

## 0.8.0

**Slack files can be downloaded.** `agent-slack files download`, and `slack_file_download` from chat, save a file an
agent can see to disk, without a person fetching it by hand:
- `--file <id>…` for files by id; `--message <channel> <ts>` for every file on one message; `--channel <id>
  [--since <ts>]` for the files in a conversation, uploaded at or after a time. Public and private channels, DMs and
  group DMs, as far as your Slack account can see them.
- Saved under your downloads folder at `<workspace>/<out>/<date>_<channel>-<ts>/<file id>[.ext]`, one folder per
  message (`undated_<file id>` when no message is known). `--out` is a folder inside it, never an absolute path, and
  nothing is overwritten.
- What the sender chose (the file's name, title and uploader) comes back marked as untrusted, with risk flags such as
  an archive or an executable; the file on disk has a neutral name.
- A file that cannot be fetched is listed with the reason, and the rest are saved. Every run writes a manifest and an
  audit record, and says what it saved even when one of those cannot be written. This is the first Slack read that is
  audited.
- Up to 50 files a run by default (`--max-files`, at most 200), 100 MiB a file and 500 MiB a run, two minutes a file.
- It is a read: it works in read mode and asks for no approval, as Gmail's download does.

Why: an agent could list a Slack file and see its link, but fetching it needs your Slack token, which an agent must
never hold. It had to stop and ask a person to download two zips by hand.

How the token is kept safe: it now goes to one more place, `https://files.slack.com`, Slack's own file host, which
Slack requires for a file's bytes, and only for one `GET` of the path of one file just looked up. A link Slack returns
is checked against that path and rebuilt, never followed as given. A file stored outside Slack (Google Drive, Dropbox
and the like) is refused, redirects are refused, and a Slack sign-in page returned instead of the file is reported as
a file the token cannot read. For a file that is itself HTML, the two cannot be told apart, and the reason says so.

What it means for you: a minor release; nothing that worked changes. A workspace connected in read mode already has
the `files:read` scope this needs. To get 0.8.0, run `agentcomms update` (or say "update my comms" in chat), then
restart your client.

## 0.7.2

**Installing a server from chat works where Homebrew put Claude Code, and says so when it does not.** An MCP server
runs with a short, fixed PATH. On an Apple Silicon Mac where Claude Code came from Homebrew, `claude` is in
`/opt/homebrew/bin`, which is not on it. So `comms_server_install`, and a channel's install run from chat, found no
client, registered nothing, and still answered `applied: true`: the person restarted Claude Code for tools that never
came.
- The client's own command is now also looked for in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.
- An install from chat that registers nothing, or whose server does not start, is an error (`PROVIDER_UNAVAILABLE`).
  It says why and carries the entry to add by hand, as the command line has always done with its exit status.
  `print: true` is still a success.

**The doctors look at what is registered.**
- `agentcomms doctor` (and `comms_doctor`) checks each channel's registrations. A registered server whose files are
  gone fails. A channel with accounts on this machine that no client starts is flagged to look at. A client
  configuration it cannot read is reported, not taken as empty.
- `agent-gmail doctor` and `agent-slack doctor` said "Registered server version: this release" when no client had
  the server at all. They now say "none registered", to look at.

**`agent-gmail setup --mcp-client` finishes what it was asked.** With `--inbox` and no browser at hand, setup starts
the sign-in and hands you a `--finish` command, and the registration asked for with `--mcp-client` was forgotten.
The sign-in now carries it:
- The hand-off says that finishing will also register the Gmail server.
- `agent-gmail inbox add --finish` registers it once you approve: at a terminal there and then; otherwise it
  returns the preview and the `agent-gmail mcp install … --approval <id>` command that claims it. It skips only
  when the client already has a Gmail server of ours that serves this mailbox and still starts, and
  `--replace-server` is carried through. The mailbox is connected either way.
- From chat, `gmail_inbox_finish` connects the mailbox and names the `comms_server_install` call that registers it.
- Every printed finish command waits 60 seconds; setup's said 120.
- A detached sign-in's listener, Gmail's and Slack's, has thirty seconds to start, not ten. On a busy or slow
  machine it took longer, and the sign-in was thrown away as failed.

Why: a report from a second Mac. A WhatsApp install from chat said it had succeeded, registered nothing, and every
check stayed green.

What it means for you: a patch; nothing that worked changes.
- From chat, an install that could not register is now an error rather than a success, so an agent that read only
  `applied` sees the failure.
- `doctor` may show new "to look at" lines, each with what to run.
- To get 0.7.2, run `agentcomms update` (or say "update my comms" in chat), then restart your client. On a Mac with
  Claude Code in `/opt/homebrew/bin` that is still on 0.7.1, run it from a terminal: 0.7.1's chat tools cannot find
  `claude` there.

## 0.7.1

**0.7.0, released in full.** 0.7.0 reached npm only as `@agentcomms/resend` and `@agentcomms/whatsapp`. The release
then stopped on Windows, where four of WhatsApp's test files ran past their 60-second limit: every test that
finished passed, and the rest of those four files was cut off. Core, both Gmail packages and Slack stayed at 0.6.0.
0.7.1 gives each WhatsApp and Resend test file ten minutes, still a limit so a hang ends, and is otherwise 0.7.0:
nothing any package runs has changed. Everything below is what 0.7.1 brings over 0.6.0.

What it means for you: a patch over 0.7.0, so if you installed Resend or WhatsApp at 0.7.0, `agentcomms update`
moves them to 0.7.1 with the rest and nothing else differs. From 0.6.0, read on.

**Two new channels: Resend and WhatsApp.** Channels are now separate packages that declare themselves to core, so a
new one needs no edits to core.

**Resend (`@agentcomms/resend`).** Covers the email your companies send from their own domains through Resend.
- **Reading:** an agent can read which domains are verified, whether an email was delivered, bounced or complained
  about, the replies Resend received, metrics and suppressions.
- **Sending:** it prepares an email and shows you the whole preview, with every recipient including BCC. It sends
  only after your approval, exactly once. The approval id goes to Resend as its idempotency key, and a send whose
  outcome is unknown is never retried.
- **When a code is required:** a send to more than 10 people, or to an address first seen in received mail, needs
  the code typed at your terminal, like `@channel` in Slack.
- **Your API key** is typed only at a terminal (`agent-resend account add <org/resend>`, from a hidden prompt or
  `RESEND_API_KEY`), is kept in the keychain, and has no chat tool.
- **Not in this release:** broadcasts, contacts and automations.

Why: Resend's own MCP server sends the moment a model calls it. This one puts your approval between the model and
the send, as the Gmail and Slack channels do.

What it means for you:
- **Read mode is enforced by our code, not by the key.** Resend has no read-only key, so this is weaker than
  Slack's, and `agent-resend doctor` says so.
- **Sending-only keys:** a key limited to sending can be locked to one domain, and that lock is enforced on the From
  address.
- **Setup:** `npx -y @agentcomms/resend mcp install --client claude-code`, then `account add` at a terminal.

**WhatsApp (`@agentcomms/whatsapp`), read-only.** Reads, lists and searches the chats WhatsApp for Mac keeps on this
Mac, and drafts a reply as a link that opens WhatsApp with the text filled in, for you to send.
- It has no network client at all and never talks to WhatsApp's servers.
- It never sends a message, marks one read or shows you online.

Why: WhatsApp has no official way to act as a personal account, and it bans numbers that use unofficial clients.
Reading the Mac app's own store is the one way to reach your history with no risk to the number.

What it means for you:
- **Plaintext copy:** the index is a second copy of your messages on this Mac, readable only by your user.
  `agent-whatsapp remove` deletes it.
- **What the agent sees:** it sees every chat unless you use `agent-whatsapp allow` / `deny`, which only you can set,
  at a terminal.
- **Permissions:** macOS may ask to allow access to another app's data, or need Full Disk Access for your terminal.
- **Lists:** a number on the allow or deny list is written with its country code (`+` or `00`); each entry shows the
  chat it matches, or warns that it matches none. A group is shown or hidden as a whole. A draft to a hidden chat is
  answered exactly as a draft to one that does not exist.
- **Node:** it needs Node 22.16 or newer.
- **If you ran the spike:** your `personal/whatsapp` from it is moved into the configuration the first time
  `agent-whatsapp` runs.

**For contributors: channels are now packages.** A channel declares itself with an `"agentcomms"` field in its
`package.json`. Core, `mcp install`, `update`, the release list, the licences and every parity and docs check find
it there, so a new channel needs no edits elsewhere. New channels keep their accounts in core's `accounts` map in
one general format.

The design, and what a channel must provide, is in
`docs/superpowers/specs/2026-09-26-channel-plugins-design.md` and CONTRIBUTING's "Adding a channel". For now,
channels are first-party only: every channel runs with access to every other channel's credentials on the machine.

**Fixes**
- **Gmail could not send a reply it had composed.** The quoted attribution line (`On … <sam@example.com> wrote:`) vanished
  from the HTML side of the check that compares what a recipient sees with the preview, so `send prepare` refused
  every such reply. It is fixed at the cause: markup written as entities now stays text when HTML is read.
- **HTML that shows the recipient something other than the preview is refused**, in Gmail drafts and Resend sends:
  style blocks and styles that add or reorder text, right-to-left overrides, SVG and embedded content, and images of
  any kind (Gmail keeps the verified signature). A remote load is anything but `data:`, `cid:` and the like —
  `file://` and `\\host` shares included.
- **What a sender wrote stays inside the untrusted-content envelope.** Downloaded attachments are saved under neutral
  names; their original names, types and the sender's address come back marked as untrusted — in Gmail too.
- **An account mode outside `read` and `send` now needs your approval.** Before, a mode word the classifier didn't
  know, or a mode on a platform it didn't know, widened an account without asking. Nothing shipped wrote one, but
  any new channel could have.
- **`agentcomms update` asks npm only about what this machine uses.** Before, it asked about every channel core
  knows, so one not yet on npm would have stopped the update everywhere.

What it means for you: a minor release, which in 0.x is where breaking changes go. Slack behaves as before. Gmail
changes in three ways a script may notice:
- Downloaded attachments are saved as `<date>_<message id>/part-<part id>[.ext]`, and the sender's file name comes
  back as a separate, wrapped `filename`.
- Exports are named by date and id, not by subject.
- An HTML body is refused if it contains an image (other than the verified signature) or a style that adds or
  reorders text.

Gmail's and Slack's approval previews are word for word as in 0.6.0; the only new sentences are refusal reasons. To
get 0.7.1, run `agentcomms update` (or say "update my comms" in chat), then restart your client.

## 0.7.0

Published only as the first versions of `@agentcomms/resend` and `@agentcomms/whatsapp`. The release stopped
before the other packages; everything 0.7.0 was to bring is under 0.7.1.

## 0.6.0

**`agentcomms update` and `comms_update` bring a computer up to the latest release, from a terminal or from a chat.**
It asks npm for the latest release, then lists what on this computer is behind: each registered server, the
runtime it runs from, and any command installed globally. It moves all of them in one step you approve. Each server
is registered again at the new version under the same name, for the same client, with the same pins; one whose pins
could not be kept exactly is left for you, not widened. Then restart your client and prune the old runtimes.
`--check` (`check: true` in chat) only reports. The new `comms-update` skill runs the whole thing when you say
"update my comms".

Why: until now, a chat could register servers only at the core server's own version, so an upgrade always meant a
terminal and a list of commands on every computer.

What it means for you: a minor release. It adds a command, a tool and a skill, and nothing that worked before
behaves differently. The update needs core 0.6.0, so on each computer the first time is one command in a terminal,
then a restart. After that, "update my comms" in chat does it.

```sh
npx -y @agentcomms/core@latest update
```

Some registrations are listed with the command to run instead: one registered for a single project, one written by
hand, one pinned to an account that has since been renamed, and one whose client command is not installed.
`comms_channels_available` also marks each registration older than the running core (`behindCore`), without
asking the network.

**For contributors: no CI runs on pushes or pull requests.** `pnpm install` sets up a pre-push hook that runs
`pnpm verify`. The release workflow still runs it on Linux, macOS and Windows before it publishes anything.

## 0.5.1

**Tools refuse what they used to ignore.** Every MCP tool, in core, Gmail and Slack, now refuses an argument it
does not take, and an argument of the wrong kind, as `USAGE`, before it does anything. The message names the
argument and what the tool takes. An unknown argument used to be dropped without a word, so a call could quietly do
something other than what was asked. And a wrong type, a fraction or an unknown word came back as the MCP library's
plain-text error, with no code an agent could act on. A problem inside an object argument is named by its path —
`expect.to is required`, `undo[0].messageId` — rather than blamed on the whole argument. `tools/list` now publishes
`additionalProperties: false` for every tool, so a client can see the rule before it calls.

Why: the design has always said an unknown argument is refused. The MCP library dropped it instead. That is how
`gmail_inbox_add`, before 0.5.0 declared `client`, signed a mailbox in with the default OAuth client when an agent
had asked for another.

What it means for you: a patch, because only input that was already wrong behaves differently. A call that was
correct gets the same answer as before, and there is nothing to migrate. An agent or script passing a field a tool
does not declare now gets `USAGE` and the list of fields it takes, where it used to get a result that ignored the
field. To pick this up, register each server again with `--force` and restart your client.

**Slack `search` and `files` refuse a limit they cannot read.** Above 100 for `search` and 200 for `files`, the
limit is refused, as the Gmail tools have refused one since 0.5.0. Before, they read fewer and did not say so. The
limit is checked before the workspace is opened, so a bad one reads no credential and renews no token.

**A Slack draft is shown as what it would post.** `agent-slack draft show`, `draft list`, `slack_draft_get` and
`slack_draft_list` show the text the post gate would send, as the channel would read it, not the words kept in the
draft file. A draft the gate would refuse is refused by `show` too, in the gate's own words, so showing a draft and
posting it can no longer disagree about what it says. At the terminal, `draft show` and `draft list` show a hidden
character escaped (`<U+200B>`), as the post preview does; they used to drop it silently.

**An expired Gmail sign-in says how to start that one again.** It names `inbox reauth` for a re-sign-in and
`inbox add` for a new mailbox, and the mailbox it was for. Over MCP it names the tool, not a terminal command. Before,
every expiry said `agent-gmail inbox add <alias> --start`.

**`agent-gmail contacts --sources` and `gmail_contacts_search` refuse a source they do not know.** An unknown word
used to be dropped, and the search reported itself complete with fewer results or none. An empty list is refused the
same way. So is an empty `inboxes` for `gmail_search`, `gmail_attachments_find`, `gmail_contacts_search` and
`gmail_followups`, and an empty `messageIds` for `gmail_attachment_download`. Each used to search nothing, or save
nothing, and report the work done.

**`slack_draft_create` writes a draft without preparing it**, as `agent-slack draft create` does, with the same
mention and broadcast checks and no approval until `slack_post_prepare` is called with its id. Until now the command
had no tool of its own; the nearest was `slack_post_prepare`, which writes and prepares in one call. Slack's server
now has 27 tools.

**For contributors: the parity check proves each row is one operation.** Each row in `capabilities.json` names the
operation its command and its tool both run, and `pnpm verify` drives both sides against stand-ins to prove that each
reaches that operation first. Rows that share an operation — the Slack mode rows, a reaction and its approval —
also say which arguments tell them apart (`expect`), and both sides must pass them. Before, it checked only that the two named sides existed, so swapping two rows passed —
and so did the channel CLIs' `mcp install` in 0.5.0 without the approval its tool asked for, until a review found it.

## 0.5.0

**Changes are now approved in chat by default.** A change that loosens a setting, or cannot be undone — a looser
send policy, connecting Slack in `send` mode, moving credentials out of the keychain, removing an account,
registering an MCP server — is shown to you as a preview, and applied once you say yes in the conversation. In 0.4.x
the same changes needed a code typed at a terminal. A configuration from an earlier release reads as `chat`.

Why: in 0.4 an agent could read and draft from a conversation, but connecting an account, widening it or changing
how it is approved needed a terminal, and so did every Slack post. A person being set up from a conversation could
not finish there, and for someone watching their own agent the code protected little. So every command now has a
tool and every tool a command, both approved the same way — and terminal approval is one command away for anyone who
wants it.

What it means for you: this is the 0.x minor release, where this project puts breaking changes. All four packages
move to 0.5.0 together, on `latest`. Gmail and Slack each carry their own copy of core, so neither needs another
package installed; `@agentcomms/gmail-mcp` 0.5.0 requires `@agentcomms/gmail` 0.5.0. A registered server keeps running the release it was registered with until you register it again. Reading, searching
and drafting are unchanged from both surfaces. What breaks is listed under **Scripts** below, and the one change that
happens with no action on your side is the default above.

Under `chat` this software cannot tell your yes from an agent's. If an agent runs without you watching, go back to
terminal approval before you let it loose:

```sh
npx -y @agentcomms/core@0.5.0 policy confirm                 # every account
agent-gmail inbox policy <alias> --change confirm             # one mailbox
agent-slack workspace policy <name> --change confirm          # one workspace
```

From chat, `comms_change_policy`, `gmail_inbox_policy` and `slack_workspace_policy` do the same. Tightening applies at
once; going back to `chat` needs the terminal code. Under `confirm`, a change is approved with `agentcomms approve
<id>` — or `agent-gmail approve` / `agent-slack approve`, which now approve changes as well as sends.

**Everything the CLI does, an agent can do from chat, and the other way round.** Each change goes through the same
approval from both. Gmail's MCP server goes from 32 tools to 44 — show, rename and re-authorise a mailbox, import and
remove one, set its policies, and manage the OAuth clients and trusted confirm clients. Slack's goes from 14 to 26 —
connect, widen, re-authorise and remove a workspace, set its policies, run `doctor` and print the app manifest.
`capabilities.json` lists every command and the tool that mirrors it, and `pnpm verify` fails on a command without a
tool unless the file says why it has none.

**Agents can post and react in Slack.** `slack_post_send` posts a draft that `slack_post_prepare` made, and
`slack_react` / `slack_react_send` add a reaction, after your yes under a workspace's `chat` policy, or after
`agent-slack approve` under `confirm`. `@here` now always needs terminal approval, like `@channel` and a room of 50 or
more: it reaches whoever is online, which nothing here can count. So does a mention the preview cannot count, such as
a user group. `--broadcast` accepts only `here`, `channel` and `everyone`, and a `--mention` must be a user id: either
could be made to carry a user-group mention that the preview counted as nobody, so a post that interrupted a whole
group was approved as one that interrupted no one.

**What is approved is what is posted.** A Slack draft was previewed from its text and posted as its blocks, so a draft
file rewritten on disk — by anything that can write to it — could be approved as one message and post another. A draft
whose blocks are not exactly what its text composes to is now refused, at every step that reads it, and what is posted
is the payload the approval was taken over.

**A core MCP server sets up the others.** `npx -y @agentcomms/core mcp install --client <client>` registers it once;
from then on an agent can list which channels are available, register or prune the Gmail and Slack servers, set the
change policy, migrate names and secrets, read the audit log and list or revoke approvals — 11 tools. It registers
servers at its own version, so to upgrade, re-register the core server first. At a terminal the same commands are
`agentcomms approve`, `policy`, `channels`, `mcp install` and `mcp prune`. The new `comms-onboarding` skill walks a
person through the whole setup from a conversation; there are now sixteen skills.

**A server pinned to one mailbox or workspace keeps to it.** Given another account's approval id, a pinned server
voided it — so an agent talking to the `work` server could cancel an approval waiting for `home`. It is now refused
before it is touched. A pinned `gmail_doctor` answers for its own mailbox only, and a pinned `gmail_send_list`
refuses another mailbox instead of answering for its own, as do the tools that take `inboxes` — `gmail_search`,
`gmail_attachments_find`, `gmail_contacts_search` and `gmail_followups` used to search the pinned mailbox whatever
they were asked. A Slack workspace keeps its id when it signs in again, so a
server pinned to it no longer stops working after `workspace reauth`; drafts and approvals waiting on it survive the
reauth too.

**A mismatched credential store is refused.** On a computer with Slack credentials in the keychain but no store
recorded, `agent-gmail client add --store file` was approved as "credentials will move", moved nothing, and left every
Slack workspace signed out. A `--store` other than where credentials already are is now refused, with the command
that moves them (`agentcomms secrets migrate`).

**What a change approval binds.** An approval now binds every setting the change writes, tightenings included, so a
claim cannot drop part of what the person was shown. Tightening the default change policy to `confirm` lists every
mailbox or workspace still set to `chat`, with the command that tightens it.

**Slack apps can be updated from the terminal.** `agent-slack app update` writes a workspace's manifest into its
Slack app, and `app create` makes the app, with a Slack app configuration token read from a hidden prompt or
`SLACK_APP_CONFIG_TOKEN`. The token is never stored and has no MCP tool, so it never passes through a conversation.

**Scripts: a command that changes something may now stop for approval.** Without a person at a terminal, these exit
10 (`APPROVAL_PENDING`) with the preview and an approval id, and run again with `--approval <id>` after the yes:

- `agent-gmail client add|remove`, `inbox import|remove`, `confirm-clients add`, `inbox reauth` asking for more access,
  `setup --client-json`, and `setup --mcp-client`
- `agent-slack workspace remove`, `workspace add|reauth --mode send`
- `agent-gmail mcp install|prune`, `agent-slack mcp install|prune`, `agentcomms mcp install|prune`
- `agentcomms secrets migrate`, in both directions
- any looser send, post or change policy

A server name must be 1–64 letters, digits, `.`, `_` or `-`: the name is quoted in the preview you approve, and a
name with quotes in it could make an unpinned server read as a pinned one. Headless `agent-gmail setup --mcp-client`
stops at the registration and carries its approval with `--mcp-approval <id>`, since `--approval` is already the
OAuth client's.

`agent-gmail draft update` keeps a draft's body unless you give a new one with `--text` or `--file` (`--file -` reads
standard input). It used to read standard input whenever it was not a terminal, so from an agent's shell it either
exited "the message body was empty" or waited for ever.

A word a tool does not know — a policy, a store, a kind, a direction, a format, a mode — is refused as `USAGE` with
the words it takes, as the command refuses it, rather than with the MCP library's uncoded error. `agent-gmail export`
and `gmail_export` refuse a format other than `md`, `json` or `eml`; another word used to write Markdown under that
extension. `--wait` takes whole seconds from 0 to 600 (`--wait abc` waited for ever), and a wait that outlives the
sign-in stops when the sign-in expires, as `gmail_inbox_finish` does, instead of saying the link was still good.

Every number option on the three CLIs takes a whole number written in digits, in its range, and anything else is
refused as `USAGE` naming the option and the range: `--limit 1e2` used to be read as 1, `--port abc` started a
sign-in on a random port, and `followups --older-than 3d` was read as 3. The Gmail tools refuse an out-of-range number
the same way, where they used to clamp it — `gmail_search` with `limit: 500` searched 50 without saying so.

`agentcomms names migrate --yes` is refused (exit 64): the rename is shown and approved like any other change.
`agent-slack workspace mode <name> send` now stops at the Slack app step until you pass `--app-updated`, so a
sign-in never asks for scopes the app does not have.

Under `confirm`, a change started from the Gmail or Slack CLI or server names `agent-gmail approve` or `agent-slack
approve` — the command installed with it — rather than `agentcomms approve`. The tools return what the matching
command's `--json` prints, and the sign-in tools take everything their commands do: `gmail_inbox_add` its client, port
and domain, and both finish tools a pasted `url`, for a browser on another machine. The Slack MCP greeting fits in the
2 KB a client keeps; the lines saying an agent cannot approve a post itself had been cut off.

Approval records carry `kind: "change"` or `"send"`, and the audit log records each change prepared, claimed, approved
and revoked, with the surface it came from.

To upgrade, re-register each server with `--force` and restart your client, as [Upgrading](docs/upgrading.md)
describes — and decide on `policy confirm` first.

## 0.4.2

**A home directory passed in the environment is used.** `openCore` and `resolvePaths` took the
home directory from the running process, whatever environment they were given, so a program
embedding `@agentcomms/core` with its own `HOME` still had data and downloads placed in the real
user's. They now read `HOME` from the environment given (`USERPROFILE` on Windows), which is where
Node itself looks for the running process, so the CLIs and MCP servers resolve exactly the
directories they did before. The same mistake had let this repository's own tests write backups
of fixture MCP entries into the maintainer's data directory; they now stay in their temporary
home.

Nothing else changed for anyone using the packages. A sign-in listener started by the Slack tests
no longer outlives the test that started it.

## 0.4.1

**`agent-slack mcp install` connects Slack to your agent**, the way `agent-gmail mcp install` connects Gmail — it is
the same installer now, shared through `@agentcomms/core`. `--workspace` pins the server to one workspace. Pins were
being dropped on the way: `agent-gmail mcp install --inbox` and `--read-only` registered an unpinned, full server,
because the option was read from the wrong command. Both now reach the entry. If you installed a pinned Gmail server
with 0.4.0, re-register it with the same flags and `--force`.

**`mcp install` never overwrites a server it did not write, and `--force` never widens one.** The default Slack name
is `slack`, which is also where other Slack MCP servers keep their bot token, and installing replaced that entry,
token and all. For codex it happened even without `--force`, when codex kept its config somewhere this did not look.
An entry this package did not write is now refused whatever `--force` says, with a `--name` to use instead. Codex is
asked what it has registered before anything is written there. And `--force` on our own entry keeps a pin to one
mailbox or workspace, or `--read-only`, that you leave out of the command: a server is widened only by removing it
yourself and installing again.

**A failed Slack token refresh no longer forces a new sign-in for a network blip.** Slack access tokens last twelve
hours, and each refresh token can be used once. Any failed refresh used to lock the workspace until somebody signed
in again, including a laptop that was offline for the first read of the day. Failures are now sorted before anything
is written. A request that never reached Slack — including a connection that timed out on one address and was
refused on another — leaves the workspace as it was. Only a token Slack says is dead, or an exchange whose outcome
cannot be known, asks for a new sign-in, and it says which. A renewed token the keychain refused to store is kept,
written again before the command or the MCP server exits, and named on stderr if it still cannot be. Ctrl-C during a
refresh waits for Slack's reply to be written, and then stops the command by the signal, so a script running it stops
too.

**Reactions can be approved.** In a workspace that asks before posting, a reaction's approval could never be given,
and every retry made a new one. `agent-slack react` now prepares it and prints the approval id; after `agent-slack
approve`, `react --approval <id>` adds it once, bound to that channel, message and emoji.

**The approval screen shows what is being approved.** It names the channel and how many people the post interrupts,
and an `@channel` or `@here` whose room Slack cannot count is never approved — the approval waits, to be tried
again. A post held for approval names `agent-slack`'s commands, not Gmail's.

**Agents can list, read and delete Slack drafts** (`slack_draft_list`, `slack_draft_get`, `slack_draft_delete`).
None of them reaches Slack. A damaged draft file no longer hides the rest, and can be deleted. Every
`slack_post_prepare` an agent makes is in the audit trail too; only the terminal's were before.

**A Slack workspace remembers the port its app redirects to.** Slack matches the redirect URL exactly. `workspace
reauth` and `workspace mode` asked for the port on every run, and the MCP mode tools guessed 51234, which sent anybody
on another port to a sign-in that failed on the way back. The port is recorded at sign-in and used by default; a
workspace connected before 0.4.1 records it at its next sign-in.

**`mcp prune` removes old runtimes, and only those it can show are unused.** Each release installs its own runtime and
the old ones stayed on disk. `agent-gmail mcp prune` and `agent-slack mcp prune` keep any runtime a client config
names — including a config with comments, a project's `.mcp.json`, and the configs an install recorded writing to
under another `CLAUDE_CONFIG_DIR` or `CODEX_HOME` — and any a running process uses. If a config or the process list
cannot be read, nothing is removed. A runtime whose entry was only printed is kept until `--include-printed` says
that entry is gone. `--dry-run` lists them first.

**Another server's address is shown by its host only.** Install warnings and `doctor` printed other MCP servers' URLs
whole, and some remote servers carry the user's key in the query or the path.

**One rename mapping works on every computer, and a backup is made first.** `agentcomms names migrate` refused the
whole plan if a `--rename` named an account that computer does not have, so a single mapping for several machines
failed everywhere but one. Such a rename is now listed as not applicable here and changes nothing, and the config is
copied to `config.json.before-names-migrate-<time>` before anything is renamed. [Upgrading](docs/upgrading.md)
walks a computer through the whole upgrade.

**A release publishes all four packages, from the tagged commit.** 0.4.0's workflow left `@agentcomms/slack` out.
Before anything is sent, the release now proves that npm will accept a publish of every package from this workflow.
A package already out at the version from another commit, or a tag moved or deleted while its run is going, stops
the run before anything more is published. Re-running a failed job finishes a partial release at the same version.
The GitHub release is made from this changelog, and a prerelease goes out under `next`, from the local fallback
script as well as from CI.

## 0.4.0

**Slack arrives.** `@agentcomms/slack` reads channels, threads, search, people and files across one or more
workspaces, drafts messages, and takes them through an approval gate — and nothing posts without a person.

**Read-only means read-only, and Slack enforces it.** Slack's read and write scopes are disjoint: a token holding
only history and read scopes cannot call `chat.postMessage` at all. A workspace connected in the default `read`
mode cannot post even if this software has a bug. That promise is exactly "this package cannot post" — a second
Slack server holding a write token posts without going near this one, and `doctor` reports the ones it can see.

**You bring your own Slack app.** `agent-slack manifest` prints one to create in your own workspace, so the scopes
are visible before anything is granted and your admins keep control. No client secret is stored anywhere: the
sign-in is PKCE and the verifier never leaves your machine.

**Nothing posts without a person.** An agent prepares; a person approves at a terminal. The preview shows what the
recipient will read and **how many people it interrupts** — `@channel` is eight characters whether the room holds
three people or four hundred, and that number is inside the approval. If the room grows between the preview and
the post, the words did not change but who reads them did, and the approval is void.

**Everything a sender controls arrives inside an envelope**, and the tag no longer says "email": it is
`untrusted-content`, because Slack messages were being announced to a model as mail. Mail already in a mailbox
predates the rename, so the old form is still defused.

Two flags are worth acting on when reading. `mismatch` means the message says one thing in the channel and
another in its notification text — the gap through which an instruction reaches a model that nobody in the room
can see. `unrenderable` means part of the message could not be shown.

**Attribution comes from what an app cannot choose.** `chat:write.customize` lets an app post under any name it
likes; the payload still carries `bot_id` and `user`. A name an app picked for a message is reported as the name
it wore, never as identity.

**Three new skills** — `slack-setup`, `slack-reading`, `slack-posting` — and a Slack MCP server whose tools cannot
post. An agent may report a workspace's mode and may ask to widen it, and gets back the steps a person must take,
with nothing changed.

## 0.3.2

**A Slack workspace cannot be connected in `send` mode without a person saying so.** The config store now counts a
new account arriving in `send` as loosening `accounts.<name>.mode`, measured from `read`, and will not record one
unless a person consented at a terminal — whatever wrote it. Re-authorising a workspace into `send` was already
gated; connecting one was not, so removing a read-only workspace and adding it back with `--mode send` reached a
token that can post with only Slack's own consent screen in the way. That route is closed at every step: before a
sign-in starts, before Slack's code is exchanged for a token, and in the store.

**`agent-slack workspace mode <name>` says what a workspace can do.** It reports the mode and whether the grant
Slack recorded can post, upload or react. `mode <name> send --port <port>` prints the two steps a widening takes —
edit the existing Slack app's manifest first, then a re-authorisation a person confirms — and runs the second.
`mode <name> read --port <port>` changes nothing and says why: Slack adds scopes to a token and never removes one,
so going back to read-only means removing the app's installation in Slack yourself and re-authorising in `read`,
and the command prints exactly that path. (The port is the loopback port in the app's manifest; both paths name
it.) The manifest's help names both modes and says to edit the existing app rather than create another.

## 0.3.1

**Four elements a browser never shows no longer reach the model.** `<noembed>`, `<noframes>`, `<datalist>` and
`<rp>` are hidden by every mail client's default stylesheet, and their text was handed to the model anyway — the
channel the sanitiser exists to close: an instruction aimed at an assistant that the person reading the mail never
sees. They are now removed and counted as hidden content, in received mail and in drafts.

**The HTML parser under the sanitiser follows the HTML spec.** htmlparser2 12, domhandler 6 and dom-serializer 3.
One behaviour changed, and it is a correction: a comment closed by `--!>` now ends there, as it does in every
browser, so text after it that a person can see is no longer missing from what the model reads.

**`agentcomms secrets migrate --to file` works.** On any install using the system keychain it used to copy every
credential and then refuse — always — while `doctor` recommended exactly this command when the keychain is
unavailable. It now asks the person at the terminal to confirm (an agent cannot), checks again under its lock
before touching a store, and records the move in the audit log.

**`--finish` finishes only what the command names.** `agent-gmail inbox reauth <name> --finish <id>` used to
finish whatever the flow was, ignoring the name; it now refuses a flow for another mailbox and follows a mailbox
renamed since the sign-in began. `inbox add --finish` cannot complete a reauth, or the other way round.

**Smaller fixes.** A sign-in could be reported as failed while its listener was running normally, on a busy
machine. A pinned MCP server refuses to start rather than silently skipping its mailbox check if a future SDK
changes how tools are registered. `doctor` counts a token recorded twice as one. Gmail's sign-in ids are drawn
evenly.

## 0.3.0

**Accounts are named `organisation/platform` now, and `agentcomms names migrate` renames yours.** A mailbox is
`cue/gmail`, a second one for the same organisation is `cue/gmail-tech`, a Slack workspace is `cue/slack`. The
command shows the whole mapping before it touches anything — `--dry-run` shows it and stops — proposes
`<old name>/<platform>` for each account, takes `--rename old=new` for the ones you want to name yourself, and
lists every problem at once rather than one per run. It needs `--yes`, or a person at a terminal to answer.

Afterwards the old names stop working, and anything that uses one is told what it is called now rather than that
it does not exist. That refusal is permanent: a name that was replaced can never be given to another account,
because the two would be impossible to tell apart later.

**`doctor` says so once.** A version-1 config is not a problem and is never reported as one, but `agentcomms
doctor` names the command that would rename it, and the release everything sharing that config has to be on
first. It stops saying it once the names have been migrated, and says nothing about the names of a config it
could not read.

**A new config is created in the new format.** Connecting a first mailbox now asks for a name like `acme/gmail`;
`work` is refused, with an example. An existing config stays exactly as it is until you migrate it — no command
changes a config's version except the migration.

**Before you migrate, every program that shares the config must be on 0.2.0 or later** — the release that could
read this format without writing it. An older one refuses the file outright, and one config is shared by
everything on a machine.

## 0.2.0

**This release can read the next config format, and never writes it.** Accounts are about to be named
`organisation/platform` — `cue/gmail`, `cue/slack`, `wf/gmail-tech` — in version 2 of the config file, which
also remembers the names it replaced, so an old name is refused with the new one rather than reported as unknown.
Nothing creates or migrates to version 2 yet. It arrives in two steps on purpose: first a release that can read
it, installed everywhere, and only then one that writes it. An older release refuses a version-2 file outright,
and one config file is shared by everything on a machine — an MCP server started last week reads the file a CLI
updated today.

**Every Gmail command understands organisation/platform names**, ready for the release that introduces them: a
mailbox called `acme/gmail` reads, searches, drafts, downloads into `downloads/acme/gmail/`, and is named in
`doctor`. A name that was replaced is refused with the one it is called now, wherever a mailbox name is typed —
including `mcp install --inbox`, which now checks the name even with `--no-verify`.

**Removing, re-authorising and adding a mailbox no longer strand or lose a token.** A config write can fail
*after* it has been written, when the lock around it cannot be released, and three paths assumed otherwise:
removal skipped deleting a token nothing referenced any more; adding deleted the token of a mailbox that had in
fact been connected, and swallowed a failed deletion without saying so; and a re-authorisation racing a removal
could write the removed mailbox's token back. Each now reads the config again and acts on what it finds, keeps a
token when nobody can tell, and names any reference it could not clean up. Removal and re-authorisation now hold
the same lock as `secrets migrate`. `doctor` checks every recorded leftover token against the config before
suggesting it be deleted, so it can no longer advise deleting a mailbox's live credential.

**`inbox import --rename <legacy-name>=<name>`** imports a mailbox under a name of your choosing, and every bad name
is reported together before anything is written. An import under a client name another Google project already
uses is refused rather than overwriting that project's secret.

**Registering an OAuth client is now as careful as connecting a mailbox.** `client add` and `client remove` hold
the same lock as everything else that touches stored credentials, so an import and a `client add` racing for one
name can no longer overwrite each other's secret; a replacement is refused once mailboxes depend on the client;
and a write that did not land puts the secret store back exactly as it was. Where an outcome cannot be confirmed —
a keychain that timed out and then refuses to answer — nothing is undone and what is unknown is said, with the
reference and the command to run.

**Writing rules follow a mailbox that is renamed.** A per-mailbox writing profile lives in a file named after the
mailbox, so a rename would have left the rules you wrote behind. They keep applying until you write new ones, and
`doctor` mentions downloads still sitting under a former name without moving anything.

**The generated CLI reference is right again.** It is built from the real `--help` output, and long descriptions
wrap — which the generator read as new rows, inventing commands such as `agent-gmail draft would` and cutting
option defaults in half. It now joins them back together.

**The page at the end of a sign-in now says what it was for.** It read "Signed in — you can close this tab" and
nothing else, so connecting six mailboxes in a row showed the same six words six times, with no way to tell which
one you had just approved. It now carries the package's name, the mailbox being connected, the address the flow
requires it to be, and the access that was asked for.

What it deliberately does *not* say is "signed in as \<address\>". That page is served the moment Google
redirects, before the authorization code has been exchanged for anything, so the account that was actually granted
is not known at that point — and a person can pick a different one on the consent screen, which is the whole
reason `--email` exists. So it says what was asked for, says plainly that nothing is stored yet, and says that a
different account will be refused. The terminal or the agent names the account once it knows.

A request that arrives without the expected `state` — a stray tab, another process finding an open port — is told
none of it.

## 0.1.4

**Setting this up was a diagnostic, and now it is a command.** The first thing a new install told you to do was
run `doctor` — which answers "what is broken" for a setup that used to work, and so handed somebody with an empty
machine a repair instruction naming a downloaded file they did not have and could not get without leaving the
terminal. Repair notes, given to somebody who had not built the thing yet.

`agent-gmail setup` inverts it. It reports what is **next**, not what is wrong, and an empty machine is the
expected starting state rather than a fault. It walks the five Google Cloud screens with a direct link to each
and says what to type in every field — including the two where the wrong answer looks more correct than the right
one: a "Web application" client reads as the modern choice and is refused, and leaving the app in Testing reads as
the cautious one and stops every sign-in working seven days later.

It runs the same way whoever is driving. At a terminal it draws a list you move through with the cursor keys;
behind `--no-tui` it asks the same questions one line at a time; and where nobody can answer one — `--json`,
`--no-input`, CI, or either end of the pipe redirected — it asks nothing and acts on the flags it was given.
Every prompt goes to stderr, so the document `--json` puts on stdout stays parseable.

**An agent can now drive all of it except the grant itself.** `setup --client-json <path> --inbox work
--mcp-client claude-code --json` runs each step that has what it needs and stops at the first that does not,
naming the flag that would have let it continue. The one step it does not finish is the grant: it produces the
sign-in link and the command that completes it, and hands both back, because it does not drive browsers.

**And the same onboarding is available over MCP**, so an agent asked to "set up Gmail" is no longer reduced to
telling you to go and run a CLI. `gmail_setup` says what is missing and changes nothing. `gmail_inbox_add`
produces the sign-in link and stops. `gmail_inbox_finish` completes the sign-in once Google has returned a grant for it.

This is a deliberate exception to a rule this project had: no MCP tool adds an inbox. The rule was written before
there was any way to do this from a conversation, and the cost was paid by everyone. What the exception buys is
bounded, and the code enforces the bounds: a `--read-only` server does not offer the two writers at all; a server
pinned with `--inbox <alias>` does not either, and its `gmail_setup` reports only that mailbox, only the client
behind it, and no file paths; neither tool changes a policy or a tier; and there is still no MCP tool that
registers an OAuth client.

**The guarantee, stated at its real width.** This code cannot mint a credential for itself — the token comes from
Google, to whoever is signed in at that browser, after Google's own consent screen. It is *not* a human-presence
check, and nothing here enforces one: an agent already driving an authenticated browser can click through the
consent screen itself. That is outside the threat model on purpose, because such an agent is holding a logged-in
Gmail session and can already read and send through it directly. If your threat model includes that, run the
server `--read-only` or pinned and add mailboxes from the CLI.

### Fixes

- **Connecting one mailbox closed the door on the rest.** `setup` treated "a mailbox" as a step in a sequence, so
  the first one marked it done for good and a second run skipped past it — wrong for a tool whose whole shape is
  many mailboxes at once. It now asks whether to connect another, and a setup that is already complete offers
  what somebody running it again actually wants.
- **`setup` offered the wrong file.** It sorted `client_secret*.json` by date without ever opening one, so it
  suggested a *Web application* client — refused a moment later, correctly, with a complaint about a type the
  person never chose. Files are read rather than guessed at from their names, Desktop sorts first whatever the
  dates say, and every candidate is listed with its kind and when it was downloaded, because three files named
  `client_secret_<digits>.apps.googleusercontent.com.json` cannot be told apart any other way.
- **A client file is now read once, through one handle, with a ceiling.** `stat(path)` then `readFile(path)`
  describes whatever that name pointed at each time, and what this reads is a client secret. Both readers — the
  download scan and `client add` — go through one bounded open that refuses a symlink, refuses anything that is
  not a regular file, does not block on a FIFO, and stops at 64KB. `agent-gmail client add /dev/zero` used to
  read until the process died, and `setup --client-json` reaches the same code.
- **The symlink refusal did nothing on Windows.** `O_NOFOLLOW` has no Windows equivalent, so the guard was
  silently absent on one of the three platforms this ships to. It is now enforced everywhere.
- **`setup` could not finish on a machine without a keychain.** `client add` defaults to the system keychain,
  probes it, and on a headless Linux box or a container tells you to run the command again with `--store file` —
  a flag `setup` did not accept. Correct advice, impossible to follow, in the one command that exists to be where
  a new install starts. `setup` now takes `--store`, `--move` and `--launcher`, the same three `client add` and
  `mcp install` have, and reports which store the secret actually went to rather than always claiming the
  keychain.
- **A prerelease would have become `latest`.** npm moves `latest` on every publish that does not name another tag,
  so a `v0.1.4-rc.1` tag would have made a release candidate the version `npm i @agentcomms/gmail` installs, for
  everybody, immediately. The release workflow reads the tag and passes `--tag next` for any version with a hyphen
  in it.

## 0.1.3

**The setup guide broke every new install after seven days.** It told you to add yourself as a *test user* and
said a test user could use the app indefinitely. Google's own documentation says the opposite: authorizations by
a test user expire seven days from consent, and the refresh token with them. Anyone who followed the guide had
every mailbox stop working after a week with `invalid_grant`, and the troubleshooting page listed four causes of
a dead refresh token without mentioning the one that would actually hit them.

The guide now says to publish the app — *Audience → Publish app*, status **In production** — and says why, and
what it costs: one unverified-app warning screen, and a ceiling of 100 accounts that will not matter for personal
use. Troubleshooting names the seven-day expiry as the first thing to check.

Every console screen the guide named had also moved. Google reorganised in 2025: *APIs & Services → OAuth consent
screen* and *Credentials* are now **Google Auth Platform**, with Branding, Audience and Clients. Every step is a
direct link to the page it means.

### Two bugs that predate this release

**Codex registrations have never carried their environment.** `codex mcp add` takes a repeatable `--env`; this
package never passed it. Every codex entry it has written is missing `AGENT_COMMS_CONFIG_DIR` and `PATH` — latent
while the configuration sits in the default place, and a server that starts and finds no mailboxes as soon as it
does not. Fixed, along with reading `env` back from codex's TOML in both spellings.

**`mcp install` does not work on Windows, and is not fixed here.** Claude Code and Codex install there as `.cmd`
files, and this package launches them without a shell, which current Node refuses to do for a `.cmd`. It appears
never to have worked. Doing it correctly means going through `cmd.exe` and hand-escaping an argument that is a
JSON document full of quotes — not work to do from a machine that cannot run Windows, and a subtle mistake writes
a malformed entry into a client's configuration. Documented instead: `agent-gmail mcp install --print` writes
nothing and prints the exact entry to paste, `env` block included.

### Upgrading

`mcp install` pins an exact version into the entry it registers, so that upgrading the package elsewhere cannot
change what your agents run underneath you. The cost is that a new release reaches an already-registered client
only when you re-register, and nothing said so — which is how an install can sit two versions behind while the bug
it is hitting is one you fixed.

```bash
npx -y @agentcomms/gmail@latest mcp install --client claude-code --force
```

`--force` is new and required, because the client CLIs refuse to overwrite an existing entry. It captures what is
registered before removing it and puts it back if the replacement fails; if the restore fails too it says so
rather than claiming otherwise. `agent-gmail doctor` now warns when what is registered is older than what you have
— for npx-pinned and managed installs alike — and its repair command preserves the name, mailbox, read-only
status and launcher of the entry it is repairing rather than replacing them with defaults.

### Also

- **The README no longer implies one send guarantee.** `read` is enforced by Google — that token cannot send.
  `draft` and `organize` are enforced only by this software, because `gmail.compose` and `gmail.modify` both
  permit `drafts.send`. Both are real; they are not the same thing, and you can now tell which you have.
- **Install is organised by which of three routes you are on.** Two involve no Google Cloud work at all: a
  Workspace admin registers one *Internal* client for everyone, and a migration reuses the client it already has.
  One client authorises many mailboxes and many people; nothing said so.
- `inbox add --start` no longer hangs when piped. The detached listener inherited stderr and held it open for as
  long as it waited for a browser, so `... --start | tee setup.log` hung on a command that had already printed
  everything and exited.
- `inbox import` cannot bring a permission the other server never asked for, which is why imported mailboxes
  report `openid` and `userinfo.email` missing. `reauth` takes them, keeping the existing tier.
- Why this is not IMAP with an app password: an app password cannot be scoped, so the `read` tier could not
  exist, and it cannot be revoked per application.

## 0.1.2

**`agent-gmail doctor` now exits non-zero when something is broken.** It printed "1 broken" and exited `0`, so
anything gating on it — a setup script, CI, a shell `&&` — read a broken install as a healthy one. It now exits
`78`, the documented code for a configuration problem, and `agentcomms doctor` has always behaved that way, so the
two halves of the product no longer disagree about the same word.

Warnings are not failures: a setup with six things to look at and nothing broken still exits `0`.

If you script around `doctor` and relied on it always succeeding, this will change behaviour — which is the point.

### Documentation

Seven pages, at [`docs/`](https://github.com/crissmoldovan/agent-communications/tree/main/docs):

- **[Getting started](https://github.com/crissmoldovan/agent-communications/blob/main/docs/getting-started.md)** —
  nothing to reading mail, including the Google Cloud part, and the import path if you already run another Gmail
  MCP server.
- **[What is where](https://github.com/crissmoldovan/agent-communications/blob/main/docs/architecture.md)** — the
  CLI needs no MCP server, no agent and no skills. That was not written down anywhere before.
- **[Sending and approvals](https://github.com/crissmoldovan/agent-communications/blob/main/docs/sending.md)**,
  **[CLI reference](https://github.com/crissmoldovan/agent-communications/blob/main/docs/reference/cli.md)** (23
  commands), **[MCP tools](https://github.com/crissmoldovan/agent-communications/blob/main/docs/reference/mcp-tools.md)**
  (29 tools), **[the skills](https://github.com/crissmoldovan/agent-communications/blob/main/docs/skills.md)**, and
  **[troubleshooting](https://github.com/crissmoldovan/agent-communications/blob/main/docs/troubleshooting.md)** by
  symptom.

The three reference pages are generated from the code and checked by `pnpm verify`, so they cannot describe a
command or a tool that does not exist.

## 0.1.1

**If you followed the migration instructions in 0.1.0, they could not work.** `agent-gmail inbox import` — the
documented route off another Gmail MCP server — skipped every mailbox with "this grant cannot read the mailbox",
on grants that could read perfectly well.

The other server records which permissions it was granted using Google's shorthand, `gmail.readonly`, while
Google's own token responses use the full URL, `https://www.googleapis.com/auth/gmail.readonly`. This package
compared one against the other, matched nothing, and concluded the mailbox had no permissions at all. A real
six-mailbox migration imported none of them. Shorthand is now expanded before anything is compared, and a test
uses the exact shape the other server writes.

Nothing else about your mailboxes changes, and nothing needs re-authorising.

### Under the hood

- **Releases are published by CI now, and carry provenance.** A tag starts the workflow and a named reviewer
  approves the publish, so nothing reaches the registry without a person. npm attests only what a supported CI
  runner published, so **0.1.0 has no provenance and every version from here does**. No credential is stored
  anywhere: the workflow authenticates with a short-lived token minted from its own identity.
- The release script now asks the registry what actually arrived, retrying rather than concluding from one empty
  answer — the first release's check declared a publish that had in fact succeeded a total failure.

## 0.1.0

> **Published under `@agentcomms/*`.** For a few minutes on 19 September 2026 these same packages were
> live as `@cloudpixel/comms-core`, `@cloudpixel/gmail` and `@cloudpixel/gmail-mcp`. Those names were withdrawn
> inside npm's unpublish window, before anything depended on them, because they did not say what they belonged
> to: `@cloudpixel/gmail` reads as a general-purpose Gmail library, not as one provider inside a larger tool — and
> Slack, the next provider, would have arrived as an unrelated-looking `@cloudpixel/slack`. Under one product scope
> the providers are plainly siblings, and the scope matches the `agentcomms` command the core package already
> installs — so what you type to install it is what you type to run it. Install from `@agentcomms/*`; the
> `@cloudpixel` names will not return.

The first release. Email for coding agents, across as many mailboxes as you connect — and an agent cannot send
anything without your approval.

### The send gate

Sending is the one thing here that cannot be undone, and every Gmail permission that lets an agent write a draft
also lets it send one. So "may draft, may not send" is enforced in code rather than by the grant:

- **one path.** `send prepare` reads the draft, refuses it outright if an agent could not have written it, and
  records an approval bound to a digest of everything a recipient would see and to the draft's Gmail message id,
  which changes on every save. `send execute` re-reads the draft, checks it against that record, and calls Gmail
  once — never retried at any layer, because a retried send may deliver twice and nothing here could tell;
- **two guards on that path.** A test fails the build if `transport.sendDraft` is called from anywhere but
  `operations/send.ts`, and the auth client refuses any request to a path ending in `/send` that is not inside that
  one call — so a `messages.send` added anywhere in the package fails at the request rather than at review;
- **three policies per mailbox.** `chat` (the default) needs your yes in the conversation, and the guarantee is
  stated narrowly because the server cannot see that conversation. `confirm` needs a code typed at a terminal, or
  into a form from a client that has proved its forms reach a person. `never` means the draft waits in Gmail;
- **risk escalation** raises a `chat` send to `confirm` by itself when a recipient's address arrived in mail read
  this week and has never been written to, when an attachment is going to a first-time external recipient, or when
  a domain is within two characters of one this mailbox writes to.

### Reading mail safely

Everything a mailbox returns is treated as data. Message bodies arrive inside an untrusted-content envelope with a
per-call random boundary; the sanitiser removes what a human reader would not see — hidden text, off-screen
elements, zero-size fonts, CSS that hides through a stylesheet, an at-rule, a pseudo-class, a percentage opacity
or a `calc()` — and **reports what it removed and what it could not read**, so a message that was trying something
says so rather than arriving clean. Text whose colour merely matches its background is counted and *kept*, because
it may be perfectly visible against a different backdrop; the count says it is worth mentioning, not that the text
was withheld.

### What you get

- `@agentcomms/gmail` — the `agent-gmail` CLI and the library: search across mailboxes, read messages and threads,
  thread timelines, attachments, contacts, follow-ups, export, drafts, labels and the bin;
- `@agentcomms/gmail-mcp` — the MCP server, 29 tools, for Claude Code, Codex, Cursor, Claude Desktop and Gemini CLI;
- `@agentcomms/core` — config, secrets, the approval engine, the sanitiser. Provider-neutral;
- **twelve skills** teaching an agent how to use all of it and where to stop, each with the depth behind it in
  `references/`, sharing one contract;
- a plugin manifest, a Gemini extension, and a launcher that finds Node where Node actually lives.


### How 0.1.0 was built

The two entries below were written during development, one per phase, and are kept as a record of the order
things were built in and why. They describe the repository at the time: their test counts predate the fixes that
landed before release, `comms-core` is what the core package was called then, and "nothing to install yet" was
true when it was written and is not now.

### Phase 2 — signing in, the inbox lifecycle, and both surfaces

**What.** `@agentcomms/gmail` — the `agent-gmail` command and the MCP server — and
`@agentcomms/gmail-mcp`, the server as its own package:

- signing a mailbox in: loopback redirect on 127.0.0.1 with PKCE, and a **two-step flow** (`inbox add --start`
  prints the link and leaves a detached listener; `inbox add --finish` collects the result) because consent takes
  minutes and an agent's shell does not last that long;
- checks that run after consent and before anything is stored: what was actually granted (people can untick boxes),
  and which account it turned out to be — a sign-in as the wrong account, or one that cannot read, writes nothing;
- `client add|list|remove` (Desktop clients only, credentials checked with Google before they are stored),
  `inbox add|list|show|reauth|rename|policy|remove|import`, `whoami`, `doctor`, `mcp`, `mcp install`;
- `inbox import` copies mailboxes out of another Gmail MCP server, and says plainly that while that server is still
  connected an agent can send mail with none of the approval steps here;
- `doctor` checks Node, directory permissions, the secret store, every mailbox's sign-in and permissions — and
  **other Gmail MCP servers registered on this machine**, each with the command that fixes it;
- the MCP server: `gmail_inboxes_list`, `gmail_whoami`, `gmail_doctor`, a tool list that never varies between
  connections, permission checks that re-run on every call, and results carried in both `structuredContent` and one
  text block so every client sees them;
- `mcp install` writes the entry with an absolute interpreter path and an explicit environment (clients start
  servers with a minimal PATH), then starts the server through that exact entry to prove it works;
- settings written by a newer version are preserved rather than dropped when an older one writes the file, so two
  versions sharing a machine cannot silently undo each other;
- on Windows, tokens, approvals and the audit log move out of the roaming profile (`%APPDATA%`) into
  `%LOCALAPPDATA%`, which a domain does not copy between machines.

**Why.** Everything else in this project needs a mailbox connected and a way for an agent to reach it. The parts
that took the most care are the ones that fail quietly: the account you did not mean to authorise, the permission
you did not notice was missing, and the second Gmail server that can send mail without asking.

**Impact.** **Nothing to install yet.** No package is published. Developing in this repository needs Node 22.18 or
newer; the packages themselves will run on 22.12 or newer.
- **Tests:** `pnpm verify` — root 16 (including a guard that mail can leave from exactly one place, in from the
  phase before sending exists), comms-core 138, gmail 54, gmail-mcp 3, and a packed-tarball consumer check per
  package (the MCP one completes a real `initialize` and `tools/list` over stdio).

### Phase 1 — the foundation and the core

**What.** The foundation for 0.1.0: the design (`docs/superpowers/specs/2026-09-18-agent-communications-design.md`)
and the implementation plan, the repository scaffolding (pnpm workspace, TypeScript 7, tsdown, Biome, CI on Linux,
macOS and Windows, security policy, contribution guide, issue forms, Blocks review config), a skill verifier, and
`@agentcomms/core` — the provider-neutral core every other package builds on:

- config with immutable inbox ids, locked writes and user intent kept apart from runtime state;
- one secret backend per config directory: the OS keychain (Linux pinned to Secret Service; a call that an OS
  prompt holds up fails after 12 seconds instead of hanging a background server) or owner-only files;
- the approval engine that will gate every send: records bound to the inbox, the account, the draft's message id
  and a content digest; a compare-and-swap state machine plus an exclusive claim file, so an approval is used at most
  once across processes; any edit to the draft voids it; challenges a human types are stored only as hashes;
- a config store that refuses any change loosening a safety setting unless a person consented at a terminal;
- a shared send ledger for rate caps, single-use plan tokens for bulk changes, and a taint store for recipients
  that appeared only in email content;
- the untrusted-content envelope and an HTML sanitiser that removes what a mail client would not show (and reports
  it), plus a preview renderer that stops a draft from forging the recipient lines a human approves;
- path jails for downloads and attachments; the audit log; the `agentcomms` command.

**Why.** Every Gmail scope that allows drafting also allows sending, so "never send without approval" has to be
enforced in code, in one place, before any Gmail code exists.

**Impact.** **Nothing to install yet.** No package is published. Developing in this repository needs Node 22.18 or
newer; the packages themselves will run on 22.12 or newer.
- **Tests:** `pnpm verify` — root 14 passing, comms-core 164 passing, and a packed-tarball consumer check.
