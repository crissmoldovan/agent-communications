# @cloudpixel/comms-core

The provider-neutral core of [agent-communications](https://github.com/crissmoldovan/agent-communications): the
config and inbox registry, the secret store (OS keychain or owner-only files), the send-approval engine, the audit
log, path jails, and the untrusted-content envelope and HTML sanitiser that keep email content from steering an
agent.

Most people want the Gmail package instead: `npx @cloudpixel/gmail --help`.

## The `agentcomms` command

```sh
npx @cloudpixel/comms-core paths      # where config, state and downloads live
npx @cloudpixel/comms-core doctor     # Node version, directory permissions, secret store
npx @cloudpixel/comms-core audit tail # every mailbox write, newest last (no bodies, no secrets)
npx @cloudpixel/comms-core approvals list
```

Every command takes `--json` and prints `{ "ok": true, "schemaVersion": 1, "data": … }` or
`{ "ok": false, "schemaVersion": 1, "error": { "code", "message", "hint" } }`.

## Licence

MIT
