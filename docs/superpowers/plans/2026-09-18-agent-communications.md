# agent-communications — implementation plan

- **Goal:** ship v0.1.0 of Gmail for coding agents — twelve skills, the `agent-gmail` CLI and an MCP server over one
  core — with sending gated by approval, as specified in
  [the design](../specs/2026-09-18-agent-communications-design.md).
- **Architecture:** `@cloudpixel/comms-core` (provider-neutral: config, secrets, approvals, envelopes, jails) →
  `@cloudpixel/gmail` (Gmail provider, operations, CLI, MCP server factory) → `@cloudpixel/gmail-mcp` (the server as
  its own package). CLI and MCP are thin adapters over one `operations/` layer.
- **Tech stack:** TypeScript 7, ESM, Node ≥ 22.12, pnpm 11 workspaces, tsdown, Biome, `node:test`;
  `@googleapis/gmail` 22, `@googleapis/people` 12, `google-auth-library` 11, `@modelcontextprotocol/server` 2.0,
  zod 4, nodemailer 10 (MailComposer), postal-mime 3, html-to-text 10, commander 15, optional `@napi-rs/keyring` 2.1.
- **Global constraints:**
  - Only `send.execute` may call Gmail's send endpoints; a test enforces it.
  - Sender-controlled text reaches results only through the sanitiser and the untrusted envelope.
  - No real mail, addresses, tokens or client secrets in the repository — fixtures are synthetic.
  - Every phase: one branch, one PR, codex (or the review panel while codex is out of quota) and Blocks until green,
    then merge; `pnpm verify` green on Linux, macOS and Windows.

## Phase 1 — foundation and core (`feat/foundation`)

Done in this branch:

- [x] Workspace, TypeScript 7, tsdown, Biome, CI matrix, OSS files, `.blocks/`, issue forms, PR template.
- [x] Skill verifier ported and extended (Google credential shapes, metadata map, no exemptions) + tests.
- [x] `comms-core`: errors and exit codes, envelope, paths, atomic owner-only writes, file locks.
- [x] Config (user intent only, locked writes, immutable inbox ids, duplicate detection, one secret backend).
- [x] Runtime state per inbox; audit log.
- [x] Secret store: keychain (pinned Secret Service on Linux, JS-level timeout, one call in flight, cache,
      namespaced by config dir) and file backends; probe; approval key.
- [x] Path jails, safe file names, attach allow/deny checks.
- [x] Untrusted envelope (random boundary, attribute allowlist, token neutralisation) with taint collection.
- [x] HTML sanitiser with a hidden-text corpus; link analysis; invisible-character stripping.
- [x] Approval engine: records bound to inbox id, sub, draft message id and digest; CAS state machine; approve voids
      on change; single-use claim; escalation; revoke; list.
- [x] Message digest (canonical form), plan tokens, send ledger with atomic reservations, taint store.
- [x] Safe preview renderer (§8.5).
- [x] `agentcomms` bin: paths, doctor, audit tail, approvals list/revoke, secrets migrate.
- [x] Packed-tarball consumer check for `comms-core` in `pnpm verify`.

Still to do before the PR:

- [x] Attach deny list extended to every dot-entry under home, `~/Library`, `%APPDATA%`, `.git` (§7.4).
- [x] Revision 3 core changes: specific error codes with one registry; hashed, attempt-limited challenges; O_EXCL
      claim marker; `unknown` state; digest version; loosening classification with consent; reserved alias and
      unique ids; one taint store across inboxes with a fail-closed collector; one dangerous-character table;
      outbound HTML analyser; address-list parsing; keychain fail-fast for unsettled calls; lock takeover hardening;
      condensed audit lines.
- [x] CHANGELOG `## Unreleased` entry.
- [ ] codex re-review of the spec and this phase's code once its quota resets (the review panel stood in for it).

## Phase 2 — auth, inbox lifecycle, surfaces (`feat/gmail-auth`)

- [ ] `@cloudpixel/gmail` package skeleton (tsdown: bundled `cli.mjs`, library `index.mjs`).
- [ ] Local fake Google server for tests (token endpoint, userinfo, Gmail profile/labels/list/get, People search).
- [ ] Transport over `@googleapis/gmail`/`people` with the retry layer (§7.11) and `AGENT_COMMS_GOOGLE_ROOT_URL`
      (loopback only).
- [ ] OAuth: loopback + PKCE + state; detached two-step flow (`--start`/`--finish --wait`); post-consent checks
      (scopes, identity); reauth identity binding; token refresh persistence.
- [ ] `client add|list|remove`, `inbox add|list|show|reauth|rename|policy|remove`, `inbox import artymclabin`
      (with the legacy-server scan), `whoami`, `doctor`.
- [ ] CLI skeleton (commander), shared envelope and exit codes, coercion rules.
- [ ] MCP server skeleton on SDK v2: handshake verified with Claude Code and Codex; `gmail_inboxes_list`,
      `gmail_whoami`, `gmail_doctor`; per-call config re-check; elicitation round trip with the SDK v2 client.
- [ ] `mcp install --client …` (managed launcher), `@cloudpixel/gmail-mcp`, package checks for both.
- [ ] **Live check (needs the author):** fresh two-step `inbox add` of one inbox; doctor; whoami;
      `import artymclabin --dry-run`.

## Phase 3 — read and analyse (`feat/gmail-read`)

- [ ] Search with the validated cross-inbox cursor; message and thread read with the body pipeline (HTML
      authoritative, plain/HTML mismatch); timeline; attachments find/download; export; contacts; follow-ups;
      labels/sendAs/drafts list — operations, CLI, MCP, tests.
- [ ] **Live check:** read-only calls on the P2 inbox.

## Phase 4 — compose and organise (`feat/gmail-compose`)

- [ ] MIME (multipart, markdown without raw HTML or images), reply/reply-all/forward composition and validation,
      signatures with the Gmail marker, draft update read-modify-write, media-upload transport, outbound HTML analyser,
      organise with plans and undo, label create, trash/untrash.
- [ ] **Live check:** drafts created, updated, opened once in Gmail web, deleted; organise on a test label.

## Phase 5 — send gate (`feat/gmail-send`)

- [ ] prepare/approve/execute under chat/confirm/never; preview renderer; elicitation (allowlist, probe); terminal
      approval; risk escalation; caps; readback; the `drafts.send`-with-raw spike.
- [ ] **Live check (after the legacy servers are disconnected):** one self-addressed send under chat and one under
      confirm, each only with the author's explicit approval at that moment.

## Phase 6 — skills, docs, manifests (`feat/skills`)

- [ ] Twelve skills with references, the shared contract and trigger evaluations; README; docs; plugin manifests;
      launcher; drift tests.

## Phase 7 — release (`release/v0.1.0`)

- [ ] Package checks for all packages, release workflow with trusted publishing, sync-versions,
      THIRD_PARTY_LICENSES, CodeQL, CHANGELOG 0.1.0.
- [ ] **With the author:** `npm login` as `cloudpixel`, stub publish, `npm trust`, history check, flip to public,
      publish 0.1.0.

## Review findings rated P2 — to consider in the phase that touches them

From the revision-1 design review (§19 of the spec). Each is weighed when its phase is built; the PR description says
which were applied.

| Finding | Lens | Phase | Proposed fix (abridged) |
|---|---|---|---|
| `chat-guarantee-overclaimed` | send-safety | P5 | Reword §8.1: 'T1 under confirm: fully in scope. T1 under chat: mitigated only (risk escalation, caps, client permission prompts, audit); a lying agent can send prepared c… |
| `per-inbox-policy-vs-static-tools` | send-safety | P5 | Register the send tools unless every served inbox is `never` or below the `draft` tier at startup. Otherwise the tools refuse per inbox at call time with APPROVAL_REQUIRE… |
| `consume-atomicity-and-ambiguous-send` | send-safety | P5 | Define a record state machine: pending → approved → sending → sent / failed_definite / outcome_unknown. The move to `sending` is an atomic claim (O_EXCL lock or rename be… |
| `caps-and-taint-per-process` | send-safety | P5 | Keep one persistent ledger per state dir: sends.jsonl, where caps are computed from `sending`/`sent` records under the same lock as the claim, and taint.jsonl, appended s… |
| `plain-file-gating-state` | send-safety | P5 | MAC approval records, ledgers and a `policy` block (policies, riskEscalation, caps, attach jail) with the key already kept in the secret store for requestState. An invali… |
| `expect-incomplete-on-cli` | send-safety | P5 | Require `--expect-to`, `--expect-cc`, `--expect-bcc` and `--expect-subject` on the CLI, with `none` as the explicit empty value. In MCP, make all four expect fields requi… |
| `digest-header-coverage` | send-safety | P5 | Canonicalise every instance of From, Sender, Reply-To, To, Cc and Bcc, merged, together with Subject, In-Reply-To, References and threadId, and include all of them in the… |
| `audit-log-gaps` | send-safety | P5 | For send events, log full canonical recipient addresses, digest, draftMessageId, policy (as recorded and effective), channel (chat / elicitation / terminal), clientInfo, … |
| `l2-enforcement-is-a-grep` | send-safety | P5 | In GmailTransport, allowlist endpoints so that any path matching /send$ needs a module-private capability object that only send.execute can create, and test that the tran… |
| `requeststate-and-elicitation-details` | send-safety | P5 | requestState holds only {approvalId, round, nonce, digest, draftMessageId}. The challenge and its hash stay in the (MACed) server-side record and are compared in constant… |
| `preview-quoted-content-untrusted` | send-safety | P5 | In the preview, wrap quoted and forwarded original content (and any body section copied from a read message, detected by the quote collapser) in the §9 untrusted envelope… |
| `approval-engine-interface-unfixed-in-p1` | phasing | all | Specify `CanonicalMessageV1` in §8.3:  ``` { v: 1,   from:    {name, addr},   replyTo: [...],   to, cc, bcc: [{name (NFC), addr (lower-case)}] sorted by addr,   subject: … |
| `per-inbox-policy-vs-shared-tool-list` | phasing | all | Specify: - Registration is the union over the served inboxes (or the pinned inbox) at start-up. - Every call re-checks the target inbox's tier, capability and policy agai… |
| `elicitation-spike-too-late` | phasing | all | Move the elicitation probe into the P2 entry spike: - a form with a required challenge field; - accept, decline, cancel and timeout, each distinguishable; - Claude Code o… |
| `p3-p4-too-big` | phasing | all | Split the phases: - P3a: search, message/thread read with the body pipeline, labels/sendAs/drafts lists, taint recording. - P3b: timeline, follow-ups, contacts. - P3c: at… |
| `packaging-first-exercised-in-p6` | phasing | all | 1. Define `<data>`: `$XDG_DATA_HOME/agent-communications`, else `~/.local/share/agent-communications`; `%LOCALAPPDATA%` on Windows; override with `AGENT_COMMS_DATA_DIR`. … |
| `draft-format-decision-deferred-to-release` | phasing | all | Run gap-4's matrix as a P4 entry spike on the test account, before MIME compose is written: {plain, html, multipart} × {no signature, raw signature, wrapped signature} × … |
| `cross-version-state-contract-missing` | phasing | all | Add a compatibility contract to §5.2: - changes within `version: 1` are additive only; - readers use passthrough and preserve unknown keys on write; - writers bump the ve… |
| `underspecified-top-items` | phasing | all | Answer each in the spec: 1. `internalDomains` defaults to `[domain]` only for non-consumer domains, and to `[]` for gmail.com and googlemail.com. 2. Legacy `secretRef` is… |
| `operation-registry-and-orphaned-commands` | phasing | all | In P2, define:  ``` OperationSpec {   id,   cli:  {path, flags} / null,   mcp:  {tool, annotations} / null,   input, output (zod),   requires: {tier, contacts},   sendGat… |
| `codeql-red-on-private-repo` | phasing | all | Guard the job with `if: ${{ !github.event.repository.private }}`, or add `codeql.yml` in the flip-to-public step alongside `scorecard.yml`.… |
| `technical-docs-gap` | phasing | all | Add `docs/architecture.md`, `docs/troubleshooting.md` (the single source of the error table, copied into the skill by the build as `contract.md` is) and `docs/upgrading.m… |
| `agent-loopback-timeout` | oauth-lifecycle | P2 | In §6.2, have `inbox add/reauth --start` also start a detached listener (by default whenever the host has a browser) bound to 127.0.0.1 on the port in redirectUri and liv… |
| `windows-file-store-colons` | oauth-lifecycle | P2 | In §5.3, name file-backend secrets `<secrets>/<sha256(secretRef) hex>.json` and store the ref inside the JSON. Alternatively, restrict secretRef to `[A-Za-z0-9._-]` and u… |
| `keychain-namespace-collision` | oauth-lifecycle | P2 | In §5.3, the keychain service is `agent-communications` when the config dir is the default, and `agent-communications:<first 12 hex of sha256(realpath(configDir))>` other… |
| `client-rotation-migration` | oauth-lifecycle | P2 | Add `client add <path> --name <n> --replace`. It is allowed when client_id equals the stored one: it rotates the secret, keeps every inbox and needs no reauth. It is refu… |
| `config-version-skew` | oauth-lifecycle | P2 | In §5.2, all config zod objects use passthrough (they never reject unknown keys). Writers preserve unknown keys verbatim. `version` changes only for incompatible changes,… |
| `identity-request-and-validation` | oauth-lifecycle | P2 | Drop `hd` by default; `--hd <domain>` is opt-in. Rely on `login_hint`. Only an id_token from our own token-endpoint response is accepted. Decode it without signature veri… |
| `scope-diff-normalisation` | oauth-lifecycle | P2 | Normalise scope aliases (email, profile, openid, and the userinfo.* URLs) before any diff. Store `requestedTier` and a derived `capabilities[]` computed from the granted … |
| `token-response-handling` | oauth-lifecycle | P2 | Pass `access_type=offline` as well (harmless; the legacy tool uses it). Abort the add or reauth with exit 77 when the response has no refresh_token. When `refresh_token_e… |
| `platform-locations` | oauth-lifecycle | P2 | In §5.1: on Windows put state and file secrets under %LOCALAPPDATA%/agent-communications (config may stay in Roaming). Define `<data>` as $XDG_DATA_HOME/agent-communicati… |
| `client-add-move` | oauth-lifecycle | P2 | `client add` probes the credentials before storing them: POST to the hard-coded https://oauth2.googleapis.com/token with grant_type=authorization_code, a dummy code, redi… |
| `import-edge-cases` | oauth-lifecycle | P2 | Import dedupes clients by client_id and inboxes by (client_id, lowercased email), and reports 'already imported'. A `web` client is imported as `refreshOnly: true`; its r… |
| `remove-semantics` | oauth-lifecycle | P2 | Remove: first delete the row under the lock (the server stops serving the inbox on its next call), then delete the secret. A failed delete is recorded in `<state>/orphane… |
| `envelope-neutralisation-scope` | mcp-untrusted | P2/P3 | Run neutralisation as the very last step, after all decoding (HTML entities, QP/base64, RFC 2047/2231) and after NFKC folding. Match every case-insensitive `<\s*/?\s*untr… |
| `envelope-attribute-injection` | mcp-untrusted | P2/P3 | The opening tag carries only server-generated values: boundary, inbox alias and messageId. Sender identity and auth results go in structured fields outside the envelope (… |
| `auth-results-source` | mcp-untrusted | P2/P3 | Use only the topmost Authentication-Results header whose authserv-id is `mx.google.com` and ignore the rest (RFC 8601 §5). Report `dmarc` as the headline result, and repo… |
| `gmail-snippet-unsanitised` | mcp-untrusted | P2/P3 | Run the invisible-Unicode strip and the envelope on snippets. Label them `snippetSource:"gmail"` and say in the tool description that they may contain text hidden from th… |
| `envelope-layer-unspecified` | mcp-untrusted | P2/P3 | Define an `UntrustedText` branded type that only the domain body pipeline can produce. Both adapters render it: MCP and CLI --json as the envelope string, CLI human outpu… |
| `text-block-dropped-by-claude-code` | mcp-untrusted | P2/P3 | Rule: `content` is exactly one text block equal to JSON.stringify(structuredContent). Every model-facing string (preview, md/mermaid renderings, warnings, next-step hints… |
| `list-changed-and-empty-start` | mcp-untrusted | P2/P3 | On a registry change, recompute the union. If it changed, enable or disable the RegisteredTools (the SDK provides enable/disable) and call sendToolListChanged(), keeping … |
| `pinned-mode-semantics` | mcp-untrusted | P2/P3 | A pinned server rejects any `inbox` other than the pin, and restricts `inboxes` to the pin ('all' means the pin). Add `--inboxes a,b` and `--exclude-inboxes` to the multi… |
| `test-hook-contradiction` | mcp-untrusted | P2/P3 | Ship no environment hook. Export `createGmailMcpServer({ gmailTransport })` from the library entry, which already exists as dist/index.mjs. A test/harness.mjs imports the… |
| `css-hiding-coverage` | mcp-untrusted | P2/P3 | Parse `<style>` rules (class, id, element and attribute selectors, `!important`, media queries other than print) and apply them before computing visibility. Remove, not f… |
| `output-sizing` | mcp-untrusted | P2/P3 | Cap the serialized structuredContent (bytes, or estimated tokens with a CJK factor) at about 6k tokens per copy. Threads default to the latest N messages in full and olde… |
| `invisible-unicode-coverage` | mcp-untrusted | P2/P3 | Strip `\p{Default_Ignorable_Code_Point}` plus bidi controls. Keep ZWJ inside emoji sequences and ZWJ/ZWNJ between letters of scripts that use them. Report counts. Apply t… |
| `output-schema-strictness` | mcp-untrusted | P2/P3 | Use z.strictObject for output schemas, or send the parsed value. The adapter, not the handler, builds the text block from the same object. e2e validates every result agai… |
| `instructions-staleness-and-order` | mcp-untrusted | P2/P3 | Order the instructions: untrusted-content rule, then the send protocol, then 'call gmail_inboxes_list for current tiers and policies'. List aliases only, capped at N with… |
| `stdout-hygiene` | mcp-untrusted | P2/P3 | The MCP entry redirects console.log/info/debug to stderr before any other import. The launcher uses only `exec`, with diagnostics on stderr. e2e asserts that every stdout… |
| `raw-html-and-links` | mcp-untrusted | P2/P3 | Define --html (and the MCP equivalent) as sanitised HTML, enveloped, with the report still computed. Raw source is available only through `export --format eml` to a file.… |
| `envelope-markup-in-drafts` | mcp-untrusted | P2/P3 | Draft create and update detect envelope markup in agent-supplied subject, body and recipient names, strip it, and return a warning. Add a test.… |
| `multi-process-state` | mcp-untrusted | P2/P3 | Compute caps at execute time from the audit log or a locked counter file. Read taint from the state file at prepare and execute, append under a lock, and move approvals t… |
| `all-reserved-alias` | mcp-untrusted | P2/P3 | Reserve `all`, and any other keywords, in alias validation; `inbox add all` and `inbox rename x all` exit 64.… |
| `unscoped-bin-squat` | packaging-oss | P2/P7 | (1) Before the flip to public in P6, publish placeholder packages for the unscoped names `agent-gmail`, `agentcomms` and `agent-gmail-mcp`, next to the 0.0.0 stubs. Each … |
| `main-pins-unpublished-version` | packaging-oss | P2/P7 | Publish before the pins reach `main`. Tag and publish from the release branch, and fast-forward `main` only after `npm view @cloudpixel/gmail-mcp@X.Y.Z version` succeeds … |
| `library-entry-dependency-contract` | packaging-oss | P2/P7 | For v0.1, make the library entry minimal and self-typed. It exports only `createGmailMcpServer(options): { connectStdio(): Promise<void>; close(): Promise<void> }`, and n… |
| `plugin-launcher-portability` | packaging-oss | P2/P7 | Move the launcher to `scripts/agent-gmail-launch`, plus `scripts/agent-gmail-launch.cmd` with CRLF endings set in `.gitattributes`. Declare it as `"command": "sh", "args"… |
| `client-env-strips-config-dir` | packaging-oss | P2/P7 | `mcp install` always writes the resolved absolute config dir into the client entry, as `env.AGENT_COMMS_CONFIG_DIR` or a `--config-dir` arg, for every client. For the sta… |
| `publish-mechanics-unspecified` | packaging-oss | P2/P7 | Specify the steps. `pnpm pack` each package, which rewrites `workspace:*` to the exact version. Run the tarball-consumer tests on those files. Publish those same `.tgz` f… |
| `history-exposed-on-public-flip` | packaging-oss | P2/P7 | Add a P6 gate before the flip. Fetch every ref, `refs/pull/*` included, and run gitleaks or trufflehog plus the extended verifier regex over every commit. If anything mat… |
| `blocks-sandbox-toolchain` | packaging-oss | P2/P7 | Post-clone: check `node -v`. If Node is below 22.18, run the suite through `npx -y node@24` or say so loudly. Install with `npx -y pnpm@11.26.0 install --frozen-lockfile`… |
| `shared-contract-mechanics` | packaging-oss | P2/P7 | State that the copies and the inline blocks are generated between markers by `scripts/sync-contract.mjs` and committed. CI regenerates both and fails on any diff. Run the… |
| `verifier-port-collisions` | packaging-oss | P2/P7 | Specify neutral fixture roots, such as `/var/empty/home/u` and `D:\\home\\u`, or an explicit allowlist file for test paths. All credential fixtures use allowlisted placeh… |
| `description-budget-premise` | packaging-oss | P2/P7 | Drop the 'fits in 8,000' justification. Require each description's first 150 characters to hold the distinguishing trigger and the boundary, for example 'Sends an existin… |
| `licensing-artefacts` | packaging-oss | P2/P7 | Generate THIRD_PARTY_LICENSES from the bundler's module graph: every package path in the output chunks, with its license text and any NOTICE file. Emit it only for packag… |
| `ci-matrix-gaps` | packaging-oss | P2/P7 | Pin one ubuntu job to `node-version: 22.12.0` that runs the packed tarball e2e tests, like the house `journal-node-floor` job. The Linux job starts `dbus-run-session` wit… |
| `version-skew-and-duplicate-registration` | packaging-oss | P2/P7 | `gmail_whoami` and `gmail_doctor` return the server version, and every skill's Prerequisites compares it with its pin and tells the user to re-run `mcp install` on a mism… |
| `forward-and-parent-selection` | gmail-correctness | P3/P4 | Decide explicitly: a forward is a new conversation, with no threadId, no In-Reply-To or References, and subject 'Fwd: ' + the original subject. The timeline links it only… |
| `from-alias-contradiction` | gmail-correctness | P3/P4 | Reply: From = the accepted sendAs address found in the parent's To/Cc (then Delivered-To), else the inbox's default sendAs. New draft or forward: optional `fromAlias`, va… |
| `plain-text-default-rewrap` | gmail-correctness | P3/P4 | Default `format: auto` = multipart/alternative: the text part plus HTML generated from it (paragraphs, escaped links), with the HTML authoritative. `plain` only on explic… |
| `ambiguous-send-oracle` | gmail-correctness | P3/P4 | Before calling drafts.send, move the record atomically to `executing` (write-ahead); any execute on an `executing` or `used` record refuses. On timeout, 5xx or connection… |
| `direction-by-labels` | gmail-correctness | P3/P4 | One domain function classifies each message from labelIds: DRAFT → draft; SENT → out; TRASH or SPAM → excluded from timeline turns, follow-ups and row selection (reported… |
| `date-rewrite-coverage` | gmail-correctness | P3/P4 | Tokenise the query, respecting quotes, (), {} and leading `-`. Rewrite after/before/older/newer in YYYY/MM/DD, YYYY-MM-DD and MM/DD/YYYY forms to epoch seconds of local m… |
| `followups-scan` | gmail-correctness | P3/P4 | Compile awaiting-them to `in:sent older_than:<N>d newer_than:<lookback, default 30d>`, and awaiting-me to `in:inbox newer_than:<lookback> -category:{promotions social upd… |
| `contacts-search` | gmail-correctness | P3/P4 | (a) Warm up per inbox, not per process, and record `peopleWarmAt` per inbox in state. The MCP server warms every contacts-enabled inbox in the background at start. If the… |
| `retry-idempotency` | gmail-correctness | P3/P4 | Retry GET, list, modify, batchModify, trash, untrash and drafts.update; treat a 404 on a drafts.delete retry as done. Retry drafts.create only on 429 or 403 rate-limit er… |
| `organise-granularity-quota` | gmail-correctness | P3/P4 | Tools take `threadIds[]` or `messageIds[]` as distinct typed fields, never an ambiguous `ids` plus a flag. Skills use threadIds for thread-kind rows, and archive, read st… |
| `label-resolution` | gmail-correctness | P3/P4 | Resolution order: exact ID; then a system label by case-insensitive friendly name (inbox, starred, important, unread, spam, trash, category_*); then a user label by case-… |
| `download-path-components` | gmail-correctness | P3/P4 | Pass every path component (alias, sender, subject slug, filename) through one safe-name function. It strips Cc/Cf characters (including U+200B–U+200F, U+202A–U+202E, U+20… |
| `export-renderings` | gmail-correctness | P3/P4 | Thread plus eml produces mbox (one file) or a directory of .eml files, stated explicitly. md and json exports contain the sanitised pipeline output with a header marking … |
| `charset-guard` | gmail-correctness | P3/P4 | When the declared charset is a stateful 7-bit encoding and the bytes contain ESC (0x1B) or UTF-7 `+…-` runs, decode with the declared charset; otherwise decode UTF-8 firs… |
