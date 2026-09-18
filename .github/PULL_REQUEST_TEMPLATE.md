## What changes for the person using it

<!-- The user-visible outcome, not the implementation. -->

## How

<!-- The approach, and anything a reviewer should look at first. -->

## Checks

- [ ] `pnpm verify` passes locally
- [ ] Tests cover the change (the send gate, path jails and untrusted-content handling always need tests)
- [ ] No real email, address, token or client secret in code, fixtures or docs
- [ ] Docs and skills updated where a command, tool or behaviour changed
- [ ] `CHANGELOG.md` updated under `## Unreleased` when users will notice
