# @agentcomms/core

The provider-neutral core of [agent-communications](https://github.com/crissmoldovan/agent-communications): the
config and inbox registry, the secret store (OS keychain or owner-only files), the send-approval engine, the audit
log, path jails, and the untrusted-content envelope and HTML sanitiser that keep what a sender wrote — an email or
a Slack message — from steering an agent.

Most people want a platform package instead: `npx @agentcomms/gmail --help` or `npx @agentcomms/slack --help`.

## The `agentcomms` command

```sh
npx @agentcomms/core paths      # where config, state and downloads live
npx @agentcomms/core doctor     # Node version, directory permissions, secret store
npx @agentcomms/core audit tail # every mailbox write and Slack prepare or post, newest last (no bodies, no secrets)
npx @agentcomms/core approvals list
npx @agentcomms/core approve <id>  # approve a settings change an agent prepared: read it, type the code it shows
```

Every command takes `--json` and prints `{ "ok": true, "schemaVersion": 1, "data": … }` or
`{ "ok": false, "schemaVersion": 1, "error": { "code", "message", "hint" } }`.

## Licence

MIT
