## What changes for the person using it

<!-- The user-visible outcome, not the implementation. -->

## How

<!-- The approach, and anything a reviewer should look at first: the riskiest part, the design decisions by number. -->

## Proposed version

<!--
The version this change would ship in, as X.Y.Z-<branch-slug>, where the slug is your branch's last segment:
branch feat/slack-edit-delete on 0.14.1 → 0.15.0-slack-edit-delete. Say why it is a patch (a fix, nobody's use
changes), a minor (something new, nothing breaks) or a major (something people rely on changes or goes). The final
number is fixed when the release is cut; this is your proposal and the reason for it.
-->

## Provenance

<!--
Where this came from and what it rests on, so a reviewer can check it and the next person can trust it.
Write "none" where nothing applies, and say why.
-->

- **Why:** <!-- the issue, report or conversation behind it, linked -->
- **Sources:** <!-- each doc, spec or reference this relies on, with the date you read it -->
- **Live testing:** <!-- anything run against a real Gmail, Slack, Resend or WhatsApp account: what, where, and what was cleaned up. Agree it with the maintainer first. -->
- **AI assistance:** <!-- the tool and model, and which parts it wrote -->

## Checks

- [ ] `pnpm verify` passes locally
- [ ] Tests cover the change, and I broke each guard on purpose to see its test fail (the send gate, path jails and untrusted-content handling always need tests)
- [ ] No real email, address, token, client secret or account id in code, fixtures or docs
- [ ] Docs and skills updated where a command, tool or behaviour changed
- [ ] `CHANGELOG.md` updated under `## Unreleased` when users will notice; otherwise a line `No changelog: <why>` above
