# Laya: the owner's supplemental macOS checklist

**This checklist is not release evidence, and it cannot satisfy the release gate.** A release may offer Laya only with
the machine-produced evidence E2 Task 10 requires: the content-free boundary evidence
`packages/events-laya-runtime/gate/macos-boundary-v2.json`, written on the gate Mac by
`scripts/run-laya-macos-boundary-gate.mjs` and validated by `scripts/verify-laya-boundary-gate.mjs`; the aggregate
quality report `packages/events-laya-runtime/gate/<manifestId>.json`; and the runtime lock rebuilt from the registry.
Each is required for every architecture the lock offers ([Releasing](../docs/RELEASING.md#laya-the-local-model-judge)).
No release check reads this file. Ticking every box here neither replaces nor excuses any of that evidence: a release
that carries this checklist and lacks the evidence is refused.

What this checklist adds is the owner's own look, by hand, at what the machine gate does not exercise (the daemon's
delete-and-reinstall repair, which downloads; a Mac whose sandbox does not apply) and at what a person should see.
Record each outcome as pass or fail, with the macOS and Node versions, and never a path, socket, process id, message,
address, token, key, question or model answer.

Run it on each gate Mac for one `laya-candidate-<n>` tag, from a clean checkout of that tag with the filtered install
(`pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'`, then `pnpm build`). `<data>` below is
the daemon's data directory on that Mac.

## 1. The gate Mac, for one job

- [ ] The gate Mac is not a standing runner. Dispatch the `Laya quality gate` workflow on the candidate tag, then on the
      gate Mac register an ephemeral runner labelled `agentcomms-laya-gate` (`./config.sh --ephemeral`, or a
      just-in-time runner), as "The protected gate" in `docs/RELEASING.md` says.
- [ ] Approve the run in the `laya-quality-gate` environment, then check in its log that the gate job is the one that
      ran on that runner. If any other job took it, treat the Mac as compromised: discard its trees and keys, and set
      it up again.
- [ ] The repository still requires approval before a fork's pull-request workflows run.
- [ ] The Mac denies outbound connections except to GitHub, the npm registry and the Node download; the job's egress
      step passed.

## 2. Availability on each architecture

- [ ] Apple silicon: with the candidate's lock, `agent-events judge kinds list` shows `laya` disabled, not unavailable.
- [ ] Intel, on a separate Intel Mac and never under Rosetta: the same, only if the lock carries an Intel file list. With
      an empty Intel list, `laya` is unavailable there.
- [ ] Under Rosetta (an x64 Node on Apple silicon), the boundary run and the workflow's candidate step refuse before
      either run starts.
- [ ] With this repository's shipped placeholder lock, every Mac shows `laya` unavailable with
      `E2_EXTERNAL_REFERENCE_BLOCKED`, and `agent-events judge kind enable laya` prepares nothing.

## 3. A sandbox that is absent or does not apply

- [ ] Start the candidate's owner already inside a sandbox, where a nested `sandbox-exec` cannot apply its profile
      (`sandbox-exec -p '(version 1) (allow default)' agent-events run`; on macOS 14.5 the nested apply fails with
      "Operation not permitted"). `agent-events judge kinds list` and `agent-events doctor` show `laya` unavailable
      with `LAYA_SANDBOX_UNAVAILABLE`, and `agent-events judge kind enable laya` is refused before any approval or
      download.
- [ ] If this Mac cannot be made to refuse its sandbox, record that. The automated tests then stand alone for this case
      (`E2 boundary: Linux and an unavailable macOS sandbox refuse before child startup`).

## 4. Network and process denial, with the pipes working

- [ ] The boundary run passed `spawn`, `tcp`, `fetch`, `udp`, `uds` and `pipes` on this architecture (read them in the
      workflow's artifact before committing it).
- [ ] By hand, from the repository root:
      `node --import ./test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-name-pattern 'E2 boundary: under the real profile the worker writes only in its own directory' packages/events-daemon/test/laya-boundary.test.ts`
      passes, and is not skipped: the worker's profile refuses a write outside its folder, a process start and a Mach
      service lookup on this Mac, and the worker still loads a synthetic runtime under it.
- [ ] By hand, from the repository root:
      `node --import ./test/helpers/loopback-seal-preload.mjs --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-name-pattern 'E2 boundary: a real macOS sandbox proves all four attempts while pipes remain live' packages/events-daemon/test/laya-boundary.test.ts`
      passes, and is not skipped.
- [ ] While a worker runs, Activity Monitor (or `lsof`, by process) shows it holding its three pipes and no socket.

## 5. The real runtime and model load

- [ ] Enable Laya in the candidate's daemon (`agent-events judge kind enable laya`, approved at the terminal).
      `agent-events judge model status` moves through `installing` and `downloading` to `ready`, with byte progress.
- [ ] With a Laya judge and a synthetic rule active, `agent-events judge test <judge-id> --version <n>` completes with a
      probability. One worker runs, as `node` under `sandbox-exec`, using about 2 GB of memory.
- [ ] The boundary run passed `nativeLoad`.

## 6. Timeout, crash and idle exit

- [ ] Crash: kill the idle worker (`kill -9`, by its process id). The next call starts a fresh, proven worker.
- [ ] Timeout: stop the worker (`kill -STOP`) while a call is in flight. After 30 seconds that event is no-match, the
      worker is killed, and the next call starts a fresh one.
- [ ] Idle: leave Laya idle for more than ten minutes. The worker exits; the next call starts a fresh one.
- [ ] The boundary run passed `crashRestart`, `timeoutRestart` and `idleRestart`.

## 7. An altered tree, and its repair

- [ ] With Laya enabled and ready, change one byte of one file in `<data>/events/laya/models/<manifestId>/`. The next
      call starts no worker; the daemon deletes that tree, downloads it again once, verifies it, and the call after that
      runs.
- [ ] Do the same in `<data>/events/laya/runtime/<lockDigest>/`, with the same result.
- [ ] Alter a tree again with the Mac offline, so the reinstall cannot download: `agent-events judge model status`
      shows `failed`, and no worker starts until you disable and enable Laya again.
- [ ] The boundary run passed `alteredTreeRefused` and `repairedTreeAccepted`.

## 8. The release lock, rebuilt from the registry

- [ ] On a machine that may reach the npm registry, from the candidate checkout:
      `AGENTCOMMS_LAYA_SUPPLY_CHAIN_GATE=1 node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/laya-release-gate.mjs`
      prints that the rebuilt lock, quality and boundary evidence all pass on every architecture the lock offers. It
      refuses until both evidence files are committed; that refusal is expected before step 9.
- [ ] Nothing but the 19 registry tarballs the lock names was downloaded.

## 9. The quality report, from the consented external corpus

- [ ] The corpus, its key and its consent ledger stayed outside every checkout, and nothing of them was uploaded to CI,
      a fixture, a log or an artifact.
- [ ] Read `gate/<manifestId>.json` before committing it. It holds aggregates only: no message, subject, address,
      account, path, token, question or answer. Its consent is `written-attested`, Gmail and Slack are reported
      separately for every offered template, and its architectures are the Macs that ran.
- [ ] `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-laya-quality-gate.mjs --architecture arm64`
      (and `--architecture x64` when Intel is offered) accepts it, and
      `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/verify-laya-boundary-gate.mjs --architecture arm64`
      accepts the boundary evidence.
- [ ] After the first run, the report's Python, torch, transformers and numpy versions are recorded in the source
      record.

## 10. Afterwards

- [ ] The ephemeral runner removed itself after its one job.
- [ ] `agent-events judge kind disable laya` stopped the worker at once and kept the verified trees, and
      `agent-events judge model remove` deleted them only once Laya was disabled.
- [ ] The outcomes above are recorded, content-free, beside the release. They are the owner's notes; the evidence files
      are what the release checks.
