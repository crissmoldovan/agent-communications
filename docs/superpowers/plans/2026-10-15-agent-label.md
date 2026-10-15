# Agent label implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Three tracks run in
> parallel, each in a git worktree of its own. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every message an agent sends through these tools reads as the person's agent, as "Cristian Moldovan (agent)",
unless the person chooses otherwise. The person decides the identity per message, per account, per conversation and by
kind of act, and the preview always says which identity a message will have.

**Architecture:** the core owns the label. Its contract is `packages/core/src/agent-label.ts`, done at 3d7c18d4: the
word list, the phrase, resolving the identity, and judging which changes loosen it. Track A wires it into the
configuration, `classifyChange` and a `label` capability. Tracks B (Slack) and C (mail) call the contract from their
prepare paths. Each track stays inside its own packages.

**Tech stack:** TypeScript on Node 22.18+/24, pnpm workspace, `node:test`. Tests talk only to the loopback fakes.

**Spec:** `docs/superpowers/specs/2026-10-15-agent-label-design.md`, approved by the owner on 2026-10-15. Read it
before anything else. Section and decision ids (L1–L6, S1–S7, G1–G3, R1) refer to it.

## Global constraints

Copied from the spec and AGENTS.md; every task includes them.

- The word list is exactly `agent`, `assistant`, `twin`, `minion`, `bot`, `fake`, `AI`, with `agent` the default
  (`AGENT_LABEL_WORDS`).
- The phrase is `<name> (<word>)`. It may be at most 80 characters as a Slack `username` and 100 as a Resend name. A
  phrase that does not fit is refused and never cut short (`labelPhrase`).
- The identity is `as`, then the most specific rule (`agent` wins a tie), then the default `agent`
  (`resolveIdentity`).
- A preview's first line states the identity. For `me` it reads exactly: `Sent as you, with no label: it will look as
  if you wrote it yourself` (`UNLABELLED_PREVIEW_LINE`).
- The approval binds the identity, the route, the phrase and the icon. Nothing changes them between preview and send.
- **Never send email, post to Slack or send through Resend while developing.** Tests use
  `packages/gmail/test`'s fake transport, `packages/slack/test/support/fake-slack.ts` and
  `packages/resend/test/support/fake-resend.ts`.
- Only `send.execute` calls Gmail's send endpoints, and only `executeSend` Resend's. Slack posts go only through the
  existing gate (`spendOn`). Add no other path.
- Anything a sender controls still passes through the sanitiser and the envelope.
- CLI and MCP parity: every new command and tool has a row in `capabilities.json` naming its operation in
  `packages/*/src/operations` (CONTRIBUTING.md, "Adding a capability").
- No runtime string names a suite binary (`agent-slack`, `agentcomms`, …). The root guard
  `printed-command-construction` refuses it; name the subcommand, or go through the locator.
- No real mail, address, token or secret in code, fixtures or docs.
- Each track updates the docs it touches: README, reference page, skill. Nobody edits `CHANGELOG.md`; the integrator
  writes it.

## Review focus

Inputs the spec implies but no task names directly, most likely to bite first. Each one's test goes in the task that
owns the code.

1. **A Slack workspace connected before this release** has no bot token. Its `agent` posts must take the labelled
   fallback and must never fail or go out unlabelled (B3).
2. **A rule names an account alias that is later renamed or removed.** The rule simply stops matching: it never throws
   and never applies to another account (A2 test).
3. **A Gmail draft written in Gmail with an encoded From** (`=?UTF-8?…?=`, or a folded header line). The header-only
   rewrite keeps every other byte (C2).
4. **The person's Slack display name is empty, or longer than 80 characters with the label.** The first falls back
   to the real name; the second refuses with how to set `label name` (B3).
5. **An `as: "me"` request on a workspace whose send policy is `confirm`.** The preview's first line still states
   it, and the terminal approval binds it (B3, C1).

---

## Track A — core (worktree `label-core`, branch `feat/agent-label-core`)

### Task A1: the configuration carries `agentLabel`, and `classifyChange` judges it

**Files:**
- Modify: `packages/core/src/config.ts` (the `ConfigBody` type gains `agentLabel?: unknown`; `classifyChange`)
- Test: `packages/core/test/agent-label-config.test.ts`

**Interfaces:**
- Consumes: `agentLabelOf`, `classifyAgentLabelChange` from `./agent-label.ts`.
- Produces: `classifyChange(before, after)` lists each `AgentLabelLoosening` as a `Loosening` with its `path`. Its
  `was` and `now` are rendered as the existing setting values are.

- [ ] Write the failing tests:
  - a config whose top level has `agentLabel: { word: 'twin', rules: [...] }` survives a `ConfigStore` read and write
    unchanged;
  - `classifyChange` lists `agentLabel.rules` when a `me` rule is added;
  - adding an `agent` rule lists nothing;
  - `ConfigStore.update` refuses with `LOOSENING_REFUSED` when a `me` rule is added without consent;
  - the same update passes when an `agent` rule is added;
  - a rule naming an alias that no longer exists is kept and ignored (Review focus 2).
- [ ] Run them and see them fail.
- [ ] Implement:
  - in `classifyChange`, call `classifyAgentLabelChange(agentLabelOf(before), agentLabelOf(after))` and pass each
    result to the function's `loosen(...)`;
  - keep `agentLabel` through every write path. The schemas are `looseObject`, so check the writers that rebuild
    objects.
- [ ] Run the core suite's affected files, typecheck and lint, then commit.

### Task A2: the `label` capability: `agentcomms label` and `comms_label`

**Files:**
- Create: `packages/core/src/operations/label.ts`
- Modify:
  - the core CLI program (find where `change-policy` and `org` commands are defined);
  - the core MCP server (`packages/core/src/mcp/`);
  - `capabilities.json`;
  - `docs/reference/core-cli.md` and `docs/reference/core-mcp-tools.md` (check the exact names);
  - the core skill, if it lists tools.
- Test: `packages/core/test/label-operation.test.ts`, plus the parity drive (`pnpm verify:parity --strict`)

**Interfaces:**
- Consumes:
  - A1;
  - `GatedChange`, the shared change flow (`packages/core/src/change-flow.ts`). `comms_org_update` and
    `comms_change_policy` use it; copy their shape.
- Produces:
  - `label(core, input)`, where `input` is one of:
    - `{}`, to show;
    - `{ word }`;
    - `{ name }` (or `null` to clear);
    - `{ addRule: AgentLabelRule }`;
    - `{ removeRule: AgentLabelRule }`;
    - `{ icon: { account, emoji: string | null } }`.
  - Every input also takes `approvalId?`.
  - It returns the shown state, or the change flow's `approvalRequired` with `preview` and `approvalId`, or the
    applied result.
  - CLI: `agentcomms label`, `label word <word>`, `label name <name>|--clear`,
    `label rule add|remove <account> [--conversation <id>] [--kinds a,b] --as agent|me`,
    `label icon <account> <:emoji:>|--clear`.
  - MCP: `comms_label`.

- [ ] Write the failing tests:
  - Show: with no input, it asks nobody, and lists the word, the name, every rule, and for each account and kind the
    identity and phrase recipients would see.
  - Word: `{ word: 'twin' }` returns `approvalRequired`. Its preview contains the resulting phrase for at least one
    connected account (use a fixture account and the name setting).
  - Applying with the `approvalId` writes `agentLabel.word`.
  - `{ word: 'human' }` is refused with `USAGE`, listing the seven words.
  - A tightening change applies at once with no approval: `{ addRule: {…, as: 'agent'} }`, or `{ removeRule }` of a
    `me` rule.
  - `{ icon: { account, emoji: 'no-colons' } }` is refused.
  - Each change appears in the audit as other changes do.
- [ ] Run them and see them fail.
- [ ] Implement the operation on `GatedChange`. Add the CLI command and the MCP tool, calling the same function, the
  `capabilities.json` row, and the reference docs. Mention `comms_label` in the core MCP server's instructions.
- [ ] Run the tests, `pnpm verify:parity --strict`, `pnpm verify:reference`, typecheck and lint, then commit.

---

## Track B — Slack (worktree `label-slack`, branch `feat/agent-label-slack`)

Read the Slack design (`2026-09-19-slack-design.md`, D7) and the edit design (`2026-10-06-slack-edit-delete-design.md`)
too. Settings come from `agentLabelOf(core.config)`; Track A adds nothing this track needs. The name for the phrase is
the signed-in user's `profile.display_name`, else `profile.real_name`, else `agentLabelOf(config).name`, else refuse
(L1). Read it with `users.info` and the user token.

### Task B1: the send manifest has a bot user and four bot scopes; sign-in takes and keeps its bot token

**Files:**
- Modify:
  - `packages/slack/src/manifest.ts`;
  - `packages/slack/src/auth/authorize.ts`;
  - the workspace operations that store the token (`operations/workspaces.ts`);
  - narrowing and removal paths.
- Test: the manifest and authorize tests in `packages/slack/test`, and the fake-slack OAuth exchange

- [ ] Write the failing tests:
  - The `send` manifest has `features.bot_user` and `oauth_config.scopes.bot` exactly
    `['chat:write', 'chat:write.customize', 'chat:write.public', 'reactions:write']`.
  - The `read` manifest has neither.
  - A `send` exchange without a bot token, or with any other bot scope set, is refused with `AUTH_REQUIRED`.
  - A `read` exchange carrying a bot token is still refused.
  - A good `send` exchange stores the bot token under `slack/bot-token/<accountId>`, and `bot_user_id` as the
    account's own key `botUserId`.
  - `narrow` to read, and `workspace remove`, delete the local bot token and never call `auth.revoke` with it: the
    token belongs to the workspace.
  - No test prints a token.
- [ ] Implement it, update the README's setup section and `slack_manifest` output docs, then commit.

### Task B2: identity and route at prepare, bound into the approval

**Files:**
- Modify:
  - `packages/slack/src/operations/send.ts` (prepare: `viewPost` and the digest material);
  - `operations/amend.ts`;
  - reactions;
  - `operations/gate.ts`;
  - `compose/preview.ts`;
  - the MCP schemas and CLI flags for `as`.
- Test: new `packages/slack/test/agent-label-route.test.ts`

**Interfaces:**
- Consumes: `resolveIdentity`, `labelPhrase`, `fallbackLabelLine`, `fallbackTextPrefix`, `UNLABELLED_PREVIEW_LINE`,
  `agentLabelOf` from `@agentcomms/core`.
- Produces: a prepared Slack act carries
  `{ identity: 'agent' | 'me', route: 'app' | 'fallback' | 'person', phrase?: string, icon?: { emoji } | { url }, reason?: string }`
  in its digest material.

- [ ] Write the failing tests, one per S2 route:
  - **The app route:**
    - a public, non-shared channel goes to the app;
    - a private channel whose members include `botUserId` (paged with the fake's `conversations.members` cursor)
      goes to the app;
    - the same channel without it takes the fallback, with the reason.
  - **The fallback route:**
    - an `im`, an `mpim` and the self-DM take the fallback, with the reason;
    - a file always takes the fallback;
    - a workspace with no bot token (Review focus 1) takes the fallback, and `doctor` warns how to update the app.
  - **Identity:**
    - `as: 'me'` takes the person route, with the first preview line `UNLABELLED_PREVIEW_LINE`, also under a
      `confirm` policy (Review focus 5);
    - a rule for the channel's `dmWith` user changes the identity.
  - **Binding:**
    - the identity, route, phrase and icon are in the digest, so changing any one of them after prepare makes the
      send refuse;
    - the preview's first lines match S7.
  - **The name:**
    - an empty display name uses the real name;
    - an 81-character phrase is refused, naming `label name` (Review focus 4).
- [ ] Implement it, add `as` to `slack_post_prepare`, `slack_react` and `slack_edit_prepare` (and `--as` on their
  CLI commands), then commit.

### Task B3: posting as the app, the labelled fallback, edits, deletes and reactions

**Files:**
- Modify:
  - `operations/send.ts` (the `chat.postMessage` call, the file upload);
  - `operations/amend.ts` (`chat.update`, `chat.delete`);
  - the reaction send;
  - `api/methods.ts`, where a method's token kind needs saying;
  - `packages/slack/test/support/fake-slack.ts`.
- Test: new `packages/slack/test/agent-label-send.test.ts`

- [ ] Extend the fake:
  - bot tokens;
  - `username`, `icon_emoji` and `icon_url` recorded on each message;
  - `not_in_channel` for a bot posting to a private channel it is not in;
  - `channel_not_found` for a bot posting to an `im` or `mpim`;
  - `bot_id` on the bot's own messages.
- [ ] Write the failing tests:
  - **The app post:**
    - it uses the bot token, `username` = the phrase, and `icon_emoji` = `slackIcons[accountId]` when set, else
      `icon_url` = `profile.image_192`;
    - its text and blocks are the composer's;
    - a refused app post (`not_in_channel`) is a refused send, and **no** fallback post follows.
  - **The fallback:**
    - its blocks start with the context block `fallbackLabelLine(phrase)`, and its `text` starts with
      `fallbackTextPrefix(phrase)`;
    - a file's `initial_comment` starts with the prefix.
  - **Edits and deletes:**
    - an edit of a fallback or person message with identity `agent` gets the prefix in its new `text`;
    - an edit of an app message uses the bot token, and only when this account's send record holds its channel and
      `ts`;
    - an app message not in the record is refused before the preview;
    - deletes follow the same token rule.
  - **Reactions:**
    - an `agent` reaction where the app can post uses the bot token;
    - in a DM, the person reacts, and the preview says it is unlabelled.
- [ ] Implement it, then commit.

### Task B4: the agent emoji maker

**Files:**
- Create:
  - `packages/slack/src/operations/icon.ts`;
  - a robot badge asset (an original PNG made for this, not copied from anywhere);
  - the CLI command `icon make <workspace>`;
  - the MCP tool `slack_icon_make`.
- Modify: `capabilities.json`, the Slack reference docs, the Slack README.
- Test: new `packages/slack/test/agent-label-icon.test.ts`

- [ ] Choose the image library:
  - prefer a small pure-JS decoder and encoder pair, e.g. `pngjs` + `jpeg-js` (no native build);
  - check its licence fits `pnpm run licenses` and the bundle;
  - give the reason in the commit.
- [ ] Write the failing tests, against the fake's `users.info` returning a test image URL served by the loopback:
  - the output is a square PNG under 131,072 bytes;
  - the lower-right corner holds the badge's pixels;
  - it is written under the data directory;
  - the result names `https://<team>.slack.com/customize/emoji` and a suggested `:<handle>-agent:` name;
  - nothing is changed in Slack or in the configuration (no approval);
  - a non-image response is refused.
- [ ] Implement it, add the capability row and the docs, then commit.

### Task B5: docs and D7

- [ ] Add a note under D7 in `docs/superpowers/specs/2026-09-19-slack-design.md` pointing to the label design.
- [ ] Update the Slack README:
  - posting as the app;
  - the fallback;
  - `as`;
  - the emoji;
  - updating an existing app from the new manifest.
- [ ] Update the reference pages and the Slack skills, so an agent passes `as: "me"` only when the person said so for
  that message.
- [ ] Commit.

---

## Track C — mail (worktree `label-mail`, branch `feat/agent-label-mail`)

### Task C1: Gmail drafts are labelled when written (G1)

**Files:**
- Modify:
  - `packages/gmail/src/operations/drafts.ts` (create about :200, reply about :429, update about :655);
  - their MCP schemas and CLI flags (`as`).
- Test: new `packages/gmail/test/agent-label-drafts.test.ts`, with the fake transport

- [ ] Write the failing tests:
  - **Identity `agent`:**
    - From is `"<name> (<word>)" <address>`, with the name from the send-as `displayName`, else
      `agentLabelOf(config).name`, else a refusal naming `label name`;
    - a non-ASCII name is encoded by the composer (RFC 2047).
  - **Identity `me`:** From stays the bare address, as today.
  - **Rules and kinds:**
    - kind is `send` for create and update, and `reply` for reply;
    - a rule on `@domain` applies only when every recipient matches.
- [ ] Implement it, then commit.

### Task C2: header-only From rewrite at prepare (G2)

**Files:**
- Modify: `packages/gmail/src/operations/send.ts` (prepare), `packages/gmail/src/domain/outbound.ts`
- Test: `packages/gmail/test/agent-label-rewrite.test.ts`

- [ ] Write the failing tests:
  - A draft whose From does not fit its identity is rewritten in the From header only, and the draft is replaced.
  - Every other byte is unchanged on a plain draft, an HTML draft, an attachment draft, and one with an encoded or
    folded From (Review focus 3). Assert this by comparing the raw bytes outside the header.
  - The preview says the From was rewritten.
  - An address the inbox may not send as is refused as today.
- [ ] Implement it, then commit.

### Task C3: the approval binds the whole From (G3)

**Files:**
- Modify: `packages/gmail/src/domain/outbound.ts` (digest material, about :246), `operations/send.ts` (`send.execute`)
- Test: extend the send-gate tests

- [ ] Write the failing tests:
  - A From display name changed after prepare makes `send.execute` refuse, and nothing is sent.
  - Break the new check on purpose and see the test fail.
- [ ] Implement it, then commit.

### Task C4: Resend From (R1)

**Files:**
- Modify: `packages/resend/src/operations/send.ts` (prepare), `compose/message.ts`, the MCP and CLI `as` flag
- Test: `packages/resend/test/agent-label.test.ts`, with the loopback fake

- [ ] Write the failing tests:
  - For `agent`: the caller's name gets ` (<word>)`, or the core name when the caller gave only an address, and a
    phrase over 100 characters is refused.
  - For `me`: From is as given.
  - The preview shows the From, and the digest binds it.
- [ ] Implement it, update the Gmail and Resend READMEs, reference pages and skills, then commit.

---

## Integration (the lead, in `agent-label`)

- [ ] Merge `feat/agent-label-core`, then `-mail`, then `-slack` into `feat/agent-label`. Resolve
  `capabilities.json`, the docs and the MCP instructions.
- [ ] Write the CHANGELOG `## 0.19.0` section: the What, the Why, and an **Upgrading** paragraph per spec §11. Bump to
  0.19.0 with `sync:versions`, `build` and `licenses`.
- [ ] Add a `SECURITY.md` note: the send app's bot token can set any `username`; it is the workspace's, and other
  members of an organisation app hold it.
- [ ] Run the root suite once and the static checks, push, start the six-leg dry run, and ask
  `@blocks review this pull request`.
- [ ] Live checks (spec §10), each with the owner's yes, from a local build of the branch. Settle `icon_emoji` and
  the Gmail From name, then amend the spec if either fails.
- [ ] Merge pinned, tag `v0.19.0`, and verify from outside.

## Running tests

- **One suite at a time in a worktree.** Mutation runners and fixtures write inside packages. Running a suite twice
  at once made a test fail with ENOENT before.
- **Run your package's changed test files with the package's own runner** (each package's `test` script; Slack's
  uses no loopback-seal preload). Then typecheck and lint.
- **Run the root suite once at the end:**
  `node --import ./test/helpers/loopback-seal-preload.mjs --test "test/**/*.test.mjs"`.
  It holds the cross-package guards.
- **Do not run full package suites locally.** The machine is heavily loaded; the cloud dry run is the full check.
- **Read `# fail` / `ℹ fail` counts from the output.** Never trust a wrapper's exit code.
