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

This project reads and writes people's email. In scope, among others:

- **Sending without approval** — any way to make Gmail transmit a message without the approval flow described in the
  safety model (`docs/safety-model.md`), under any send policy.
- **Token and credential exposure** — OAuth refresh tokens, client secrets or approval keys leaking into logs, output,
  files with loose permissions, or model context.
- **Prompt injection through email content** — a crafted message that escapes the untrusted-content envelope, hides
  text from the sanitiser, or makes a tool act on instructions found in mail.
- **Path traversal** — attachment downloads or exports writing outside their directory, or attachments being read
  from outside the allowed roots.
- **Installation and supply chain** — unsafe installation instructions, CI compromise, or published packages that do
  not match the repository.

## What the safety model does not claim

The send gate protects against a mistaken or prompt-injected agent that uses this project's tools. Stated plainly:

- **An agent with a shell is outside the boundary.** A program that runs as your user with shell or file access can
  read the stored tokens and call Gmail directly, and can make any command believe it runs in a terminal. Terminal
  approval and the agent-marker checks are speed bumps against that, not walls. For coding agents, use the `confirm`
  policy with a client whose approval form you have verified, or the `never` policy and send from Gmail.
- **Under the default `chat` policy, a message that asks you to reply to its own sender with private data** is
  caught only by you reading the preview. Risk escalation covers being told by a message to write to *someone
  else*; `confirm` covers both.
- **An MCP client's name is self-reported.** One name (`claude-code`) covers the interactive CLI, SDK-hosted agents
  and Claude Cowork. That is why approval forms are trusted only for clients you have added after a probe.

Reports that restate these documented limits are welcome as documentation improvements, not as vulnerabilities.
