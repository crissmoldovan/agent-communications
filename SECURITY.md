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

The send gate protects against a mistaken or prompt-injected agent that uses this project's tools. It does **not**
protect against a program that runs as your user with shell or file access: such a program can read the stored
tokens and call Gmail directly. Reports that restate this documented limit are welcome as documentation
improvements, not as vulnerabilities.
