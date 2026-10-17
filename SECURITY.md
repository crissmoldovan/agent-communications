# Security Policy

## Supported versions

Security fixes are applied to the current `main` branch before the first release, and to the latest published release afterward.

## Reporting a vulnerability

Please do **not** open a public issue for vulnerabilities, exposed credentials, or suspected sensitive content.

Report privately through GitHub's private vulnerability reporting for this repository. If private reporting is unavailable, contact the repository owner through their verified GitHub profile and include:

- a concise description of the issue;
- affected packages, file paths or revisions;
- reproduction or validation steps; and
- whether any secret, token or email content may be exposed.

We will acknowledge a report within 7 days and provide status updates while it is triaged.

## Scope

This project reads and writes people's email and Slack workspaces. In scope, among others:

- **Sending without approval** — any way to make Gmail transmit a message without the approval flow described in
  [Sending and approvals](docs/sending.md), under any send policy.
- **Posting without approval** — any way to make Slack post a message, share a file, add a reaction, or edit or
  delete a message through this project without the approval of that exact content, under any policy — or to edit or
  delete a message the connected account did not write.
- **Loosening without a change approval** — any way to loosen a safety setting (a send or change policy, a
  workspace's mode, a mailbox's access, where credentials are kept, a trusted client), register a server, or remove
  an account without an approval bound to that exact change, or to claim one under the `confirm` change policy that
  no person approved at a terminal.
- **Token and credential exposure** — OAuth refresh tokens, client secrets or approval keys leaking into logs, output,
  files with loose permissions, or model context.
- **Prompt injection through email content** — a crafted message that escapes the untrusted-content envelope, hides
  text from the sanitiser, or makes a tool act on instructions found in mail.
- **Disclosure without a standing authorisation** — any webhook or subscriber stream receiving event-derived content, or any hosted or local judge being invoked with it, without an active, digest-bound standing disclosure authorisation for exact approved versions, or versions derived from them by a whitelisted tightening, including the complete validated derivation lineage for the exact effective rule, target, subscriber and judge versions; after that authorisation is revoked; while the judge's kind is not enabled; outside its approved mapping, retention or delivery rate cap; or without successful taint recording before disclosure.
- **A standing disclosure authorisation is not approval of each event.** Once a person enables one at the terminal or in the app, future unseen content that matches its approved rule may leave automatically through its approved target or be evaluated by its approved judge. agent-events doctor and the app list every active authorisation. Disabling or removing any bound rule, target, subscriber or judge, or disabling a judge kind, revokes it immediately; content already in a network operation cannot be recalled.
- **An unlabelled send nobody chose** — any way to make a Slack post, reaction, edit or file, a Gmail send or a
  Resend send go out as the person, with no agent label, when neither the person's word for that message (`as`) nor
  one of their confirmed label rules said so. Also in scope: any way to get the label's word, name or Slack icon
  changed without an approval of that exact change, or to make the preview's first line state a different identity
  from the one that is sent.
- **An update that installs what it should not** — any way to make the background update job, `comms_update` or
  `agentcomms update` install, register or switch to a package that was not built by this repository's `release.yml`
  from the tag of its own version on a GitHub-hosted runner, as its Sigstore provenance proves, or to a runtime that
  does not hold the tarball that was verified; to skip the release hold, a major version's or a needs-decision
  release's wait for the person, a rollback's hold, or an organisation's cap; or to switch a runtime a running server
  is using.
- **Registry text reaching an agent** — any way to make an update's notice, refusal, preview or background run result
  repeat a string the npm registry or an unverified attestation wrote (a manifest's `needsDecision` words, a version's
  prerelease or build words, a certificate's identity, ref or runner), instead of this project's fixed words.
- **Path traversal** — attachment downloads or exports writing outside their directory, a download written into a
  folder its deny list refuses (a hidden folder anywhere outside `.claude/worktrees/<name>`, a package folder, a Python
  installation or virtual environment, `~/Library`, PowerShell's profile folders, this package's own folders, a system
  folder, or Windows's own folders reached from WSL on a Windows drive, wherever and however it is mounted), or
  attachments being read from outside the allowed roots.
- **A saved file that runs** — a Gmail or Slack download saved with an extension outside its inert list (documents,
  images, sound and video, archives, calendar, contact and mail files, Apple documents) instead of with `.download`
  after its name, a name a tool reads by name saved without the suffix, a `.doc`, `.xls`, `.ppt` or OpenDocument file
  saved without the question saying it can hold macros, a saved file left without its internet mark
  (`com.apple.quarantine` on macOS, `Zone.Identifier` on Windows) without the result saying so, or marked only after
  its bytes are written, a Windows program this package starts being taken from the current folder, or a link a
  browser opener hands to a shell.
- **Installation and supply chain** — unsafe installation instructions, CI compromise, or published packages that do
  not match the repository.

## What the safety model does not claim

The send gate protects against a mistaken or prompt-injected agent that uses this project's tools. Stated plainly:

- **An agent with a shell is outside the boundary.** A program that runs as your user with shell or file access can
  read the stored tokens and call Gmail directly, and can make any command believe it runs in a terminal. Terminal
  approval and the agent-marker checks are speed bumps against that, not walls. For coding agents, use the `confirm`
  policy with a client whose approval form you have verified, or the `never` policy and send from Gmail — and the
  `confirm` change policy (`agentcomms policy confirm`), so moving a mailbox back to `chat` needs the code too.
- **Under the default `chat` change policy the software cannot tell your yes from an agent's.** An agent can loosen
  a mailbox or workspace from `confirm` or `never` to `chat`, move credentials out of the keychain, or remove an
  account on its own claim. Each such change is audited. Set `agentcomms policy confirm` for an agent you do not
  watch.
- **An approval a person gave outside the chat can be used for 24 hours.** Once a send or change is approved at a
  terminal or in a form, any process that shares the approval store can claim it — once, for exactly what was
  approved — until 24 hours have passed; approvals are not bound to the process that prepared them. A hostile process
  running as you is already outside the boundary (above); inside it, the approval's binding means whoever claims it
  does exactly what was approved, and nothing else.
- **A "no" said in the chat is not seen.** The server cannot read the conversation. When the person says no, the
  skills tell the agent to revoke the approval at once; an agent that does not leaves an approval waiting for a yes in
  the chat usable for the rest of its ten minutes.
- **A plain address is syntax, not identity.** Prepare, send, approval and audit results leave an address outside the
  untrusted-content envelope only when it matches the channel's strict address grammar. This says that it is safe to
  display as an address; it does not say who owns it or that mail which supplied it was trustworthy. Subjects and
  every non-plain sender-controlled field are sanitised and enveloped.
- **A send whose provider never answered may have gone.** Its outcome is reported as unknown, and the process that
  claimed it may still record a late result; nothing reconciles it but looking in Sent or the channel.
- **Under the default `chat` policy, a message that asks you to reply to its own sender with private data** is
  caught only by you reading the preview. Risk escalation covers being told by a message to write to *someone
  else*; `confirm` covers both.
- **An MCP client's name is self-reported.** One name (`claude-code`) covers the interactive CLI, SDK-hosted agents
  and Claude Cowork. That is why approval forms are trusted only for clients you have added after a probe.
- **`.download` is not a guarantee against every folder.** It stops a program that loads a file by its extension or
  by a name it knows — Python's `.pth`, git's hooks, an agent's `CLAUDE.md`, Explorer's `.lnk`. It does not stop one
  that loads every file in a folder whatever it is called: a zsh completions folder, an application's plugin or
  startup folder, a watched import folder. The deny list refuses the folders every machine of its kind has, and those
  a file in them makes plain (a Python installation, a virtual environment); a folder some program was told to load
  whole cannot be known from here, and saving into it is the person's choice, made when they answer the question.
  Under WSL, a file saved onto a Windows drive carries no internet mark.

- **An update verifies this project's packages, not everyone's.** Every `@agentcomms` package an update installs or
  switches to is held to its Sigstore provenance, and so is every `@agentcomms` package npm puts in a runtime beside
  it. The packages of others that a runtime or a global package depends on are checked by npm alone, against the
  integrity the registry gives: nothing pins who builds them. No package's install script runs as an update installs
  (`--ignore-scripts`), so their code first runs when a server or command starts. A global package is verified before
  `npm install -g`, but npm keeps no lockfile for it, so what it installed is not checked afterwards; and an npx
  registration's client fetches its package from npm each time it starts, which only that client checks.
- **A first install is verified only when core makes it.** A managed `mcp install` through core's command or
  `comms_server_install` holds the runtime it fetches to the same provenance as an update. A channel's own command
  carries no Sigstore: it installs only the release it is running itself — the same package and version npx already
  fetched to run it, so nothing new runs — says in its preview and its result that it was not verified, and records
  `verified: false` in the runtime's `.agentcomms-install.json`; any other release it refuses, naming core's command.
  A runtime already on the machine is used as it is found, and `--launcher npx` registers a package its client fetches
  unverified each time it starts it, as above; the managed launcher's runtime, installed by core, is verified.
- **What a release declares is the registry's word for a verified release.** Provenance signs a release's tarball,
  not the registry's copy of its manifest: a release is verified before what it declares (`agentcommsRelease`) is
  acted on, but a registry or mirror that alters that field for a genuine release is not caught: it can move that
  release's hold between 72 and 24 hours, or make it wait for the person — or not wait, where its own release said it
  needs a decision. It cannot make anything but a release built by this repository's release workflow install.

Reports that restate these documented limits are welcome as documentation improvements, not as vulnerabilities.

- **A Slack app's bot token can post under any name.** Posting as the app needs `chat:write.customize`, which lets
  whoever holds the bot token choose any `username` and icon; Slack still shows its APP badge. This project only ever
  sets the label's phrase and the person's own icon, but the token belongs to the workspace's installation of the app:
  everyone who connected the same organisation app may hold it, and a program outside this project could use it to
  post under another member's name, badged as the app. The client secret of an app connected with
  `--with-client-secret` is kept in the secret store beside the tokens and is as sensitive as they are.
