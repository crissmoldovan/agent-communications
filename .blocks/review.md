# What to check when reviewing this repository

## Run the suite. The environment can.

`.blocks/post-clone.sh` has installed dependencies, so this works:

```
pnpm verify
```

The suite needs Node 22.18 or newer (the published packages run on 22.12, but the build tool does not). If the
sandbox's Node was older, post-clone fetched Node 24 and wrote `.blocks/env.sh`: run `source .blocks/env.sh` first.
A failure that only appears below 22.18 is an environment problem, not a finding — but say which Node you used.

That is Biome, the type checks, the test suites (root `node --test` plus each package's), the builds and
`scripts/verify-skills.mjs`. It should finish green. **If post-clone reported a failure, say in your verdict
that the tests were not run and why.**

## Say what you dropped

Inline comments below severity 7 are dropped before they reach the pull request. Put sub-threshold observations in
the summary comment instead — one line each: severity, file, what you saw. If there were none, say "no
sub-threshold observations" explicitly.

## What this repository is, and where it breaks

It gives agents access to people's email. The failures that matter most are silent:

- **A send that bypasses approval.** Only `send.execute` may call Gmail's `drafts.send` or `messages.send`, and only
  with an approval record whose digest matches the live draft. Any new path, or any check relaxed, is a finding.
- **Untrusted content escaping its envelope** — sender-controlled text reaching a result outside the envelope or
  before the HTML sanitiser.
- **Files outside their jail** — downloads or exports written outside the downloads root; attachments read from
  outside the allowed roots or from the deny list.
- **Secrets leaking** — tokens or client secrets in logs, errors, results or files with loose permissions.

When reviewing any new pattern, list or phrase match, ask: **what turns red when the thing it describes changes?**
If nothing does, raise it even below the severity bar.
