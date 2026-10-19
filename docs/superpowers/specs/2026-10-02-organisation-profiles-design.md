# Organisation profiles — design

Status: proposed 2026-10-02 by the owner; not yet implemented. **Codex design review: READY-TO-IMPLEMENT at round 7**
(2026-10-03), after revisions for every finding of rounds 1–6 (round 1:
10 P1, 12 P2; round 2: 6 P1, 2 P2; round 3: 7 P1, 2 P2; round 4: 6 P1, 1 P2; round 5: 3 P1, 2 P2; round 6: 3 P1, 1 P2 — all addressed here). Tracked in Linear, project agent-communications (Cueplusplus). **Amended
2026-10-04** (Codex amendment review round 1: NEEDS-REVISION, 4 P1, 2 P2, 1 P3; round 2: 1 P1, 2 P2; round 3: 2 P2; round 4: 2 P2; round 5: 1 P2; round 6: 1 P2; round 7: 2 P2; round 8: 2 P1, 1 P2 — answered by dropping the stored timeout record, see §D7; all addressed): phase 3 no longer
waits for phase 0. What Slack documents is recorded in §2, and §D7 is made correct
under every answer phase 0 could give to what the documents leave open (§4). Nothing in it
changes the [parity design](2026-09-25-cli-mcp-parity-design.md): every capability is a command and a tool running one
operation.

## 1. What was asked

A teammate at RGC installed agent-communications and asked for the organisation's OAuth client rather than making his
own. The owner asked for the general answer: an organisation creates its apps once — a Google OAuth client, and a
Slack app for reading and one for posting — and every member installs agent-communications with them in place, with
no Google Cloud console and no Slack app to make. Two shapes:

1. **A mechanism in agent-communications that imports an organisation's profile** — a small document the
   organisation provides naming its apps — a file in version 1 (§D3).
2. **A thin repository per organisation** (RGC first) carrying its profile, so installing from it is a few commands.

Two constraints from the owner: **members may connect accounts outside the organisation** (a personal gmail.com,
another company's address), so an organisation's apps are added *alongside* what a person has, never in place of it;
and **the organisation's client should serve those other addresses too** when the member wants it — the owner will
move his own second computer onto RGC's client.

## 2. What is true, and was checked

| Fact | Source |
|---|---|
| A Google *Desktop app* client's secret is not confidential: "…a client secret, which you embed in the source code of your application. (In this context, the client secret is obviously not treated as a secret.)" The code still sends it at exchange and keeps it only in the secret store, and that stays so. | developers.google.com/identity/protocols/oauth2 "Installed applications" (read 2026-10-02); `packages/gmail/src/auth/oauth.ts` |
| An *Internal* app is "not subject to the unverified app screen or the 100-user cap", but only users of that Workspace organisation can use it. An unverified *External* app works for any Google account, shows the unverified-app screen, and stops at 100 users over its lifetime. | support.google.com/cloud/answer/13464323 (read 2026-10-02) |
| Slack sign-in is PKCE on `http://localhost:<port>/slack/callback` and sends no client secret; Slack matches the redirect URL exactly. | `packages/slack/src/auth/pkce.ts`, `authorize.ts` |
| One machine holds several Gmail clients (`config.clients`); each mailbox records one (`inbox.client`); `inbox reauth <name> --client <c>` moves a mailbox onto `c` and records it. | `packages/core/src/config.ts`; `packages/gmail/src/operations/signin.ts:116`, `consent.ts` (`client: flow.clientName`) |
| The client is chosen **before** the consent link is built and stored in the flow; without `--email` the address is known only after the code exchange. | `signin.ts:140`, `packages/gmail/src/auth/flows.ts` |
| `client add` refuses any occupied client name unless `--replace`, and refuses replacing a client mailboxes use with a different id. | `packages/gmail/src/operations/clients.ts:116` |
| A Slack account is bound to one app: a reauth through another client id, or a token naming another app id, is refused. A safe reauth stages the new secret, switches the config atomically, then deletes the old local credential. | `packages/slack/src/operations/workspaces.ts` (both checks), `signin.ts` |
| Moving a Slack account `read → send` today means editing that account's own app manifest, then signing in again; `send → read` also asks for the installation to be removed by hand. Wrong for an app a whole organisation shares. | `packages/slack/src/operations/mode.ts` |
| `auth.revoke` is not in the Slack transport's method allowlist. | `packages/slack/src/api/methods.ts` |
| Sign-in exchanges the code at `oauth.v2.access`, whose documented answer carries the app id (`app_id`) and workspace id (`team.id`) at the top level and the user token under `authed_user`. | docs.slack.dev/reference/methods/oauth.v2.access (read 2026-10-04); `packages/slack/src/auth/authorize.ts:138-241` |
| A PKCE client with token rotation on gets a refresh token (with a custom-URI redirect rotation is always on; with a web or localhost redirect it must be enabled, and the manifests this project generates enable both PKCE and rotation); every refresh replaces the refresh token; refresh tokens of PKCE apps expire after 30 days. | docs.slack.dev/authentication/using-pkce, …/using-token-rotation, changelog 2026-03-30 (read 2026-10-04); `packages/slack/src/manifest.ts:135` |
| With rotation, `auth.revoke` revokes "a single token" — "a refresh token, a bot access token … or a user access token" — "without changing the underlying installation". Its answer carries a `revoked` boolean; `invalid_auth` is also documented for a request from a disallowed IP address. Nothing documents revoking one of a pair as revoking the other. Which error a second revoke of the same token returns is not documented. | api.slack.com/authentication/rotation; docs.slack.dev/reference/methods/auth.revoke (read 2026-10-04) |
| Where a workspace requires app approval, members "can request installation via a guided interface". Whether the browser then ever returns to the redirect URL, and with which `error`, is not documented; `access_denied` is documented only for a person declining. | docs.slack.dev/app-management/distribution; docs.slack.dev/concepts/security (read 2026-10-04) |
| The sign-in listener ends a sign-in as `denied` (with Slack's `error` and description) or `timeout` (10 minutes by default). | `packages/slack/src/auth/listener.ts:27-28, 146` |
| `configV2Schema`'s root is a `looseObject`, and `ConfigStore.update` writes back what it parsed, so a v2-capable release keeps an unknown top-level key through its writes. Releases before v2 refuse a v2 file outright; ordinary writes never change `version`. | `config.ts:379`, `config.ts:711`, `config.ts:720`, `config.ts:646` |
| The approval system binds safety settings and the plan's `effects` lines; `changedSettings` deliberately ignores clients, ids and other records. | `config.ts:1375`; `packages/core/src/changes.ts:160` |
| The core package does not depend on the Gmail package; Gmail depends on core. Client parsing, probing and registration live in Gmail. | `packages/core/package.json`, `packages/gmail/package.json`, `clients.ts` |
| The organisation word of a name is a private sub-expression of the name grammar. | `packages/core/src/name-grammar.ts:25` |

**RGC's apps exist** (made 2026-10-02): an External, published Desktop client in the Cloud project `rgc-agent-comms`
(organisation wherefrom.org), marked for AI agents, trusted in that Workspace; and two Slack apps in the Really Good
Culture workspace (`TJYMH92Q2`), `RGC agent-comms (read)` and `(send)`, redirect port 51234, not installed by an admin.

## 3. Decisions

### D1. A profile is data, never code

One JSON document validated by a strict schema in the core (`organisationProfileSchema`): an unknown key is an error.
Nothing in it is executed or used as a command line. It names apps and nothing else — **version 1 carries no settings**
(no defaults, no policies; added only if a need appears, as a tightening).

### D2. What a profile holds

```json
{
  "agentcomms": "organisation-profile",
  "version": 1,
  "organisation": "rgc",
  "label": "Really Good Culture",
  "gmail": {
    "clientId": "332711690878-….apps.googleusercontent.com",
    "clientSecret": "…",
    "projectId": "rgc-agent-comms",
    "serves": "any"
  },
  "slack": {
    "workspace": "TJYMH92Q2",
    "workspaceName": "Really Good Culture",
    "redirectPort": 51234,
    "apps": {
      "read": { "clientId": "644731308818.12217799032274" },
      "send": { "clientId": "644731308818.12202583796839" }
    }
  }
}
```

- `organisation` is checked by an organisation parser **exported from `name-grammar.ts`** (one source of the rule,
  Windows-reserved words included), not a copy of the expression — and, for a profile, at most **28 characters**, so
  that its client names (`<organisation>-<n>`, n up to 999) fit the 32-character client-name limit
  (`ALIAS_PATTERN`, `config.ts`).
- `gmail` holds normalised fields, not Google's download: `clientId` must look like a Google client id, `clientSecret`
  is non-empty, `projectId` optional. They are the three values in Google's download (`installed.client_id`,
  `installed.client_secret`, `installed.project_id`); the organisation's README says so. A helper that builds a
  profile from Google's file is out of scope (§6).
- `gmail.serves` is the administrator's statement of who may use the client: `"any"` (External) or
  `{ "domains": ["reallygoodculture.com", …] }` (Internal; lower-cased, exact match on the address's domain). It is a
  routing assertion, not proof of how Google is configured; a wrong one shows up as Google's own refusal.
- `slack.apps.read` / `.send`: either may be absent. Each may carry `appId`; when it does, a token naming another app
  is refused. When it does not, the first sign-in records the app id Slack returns, and later ones must match it.
- Either `gmail` or `slack` may be absent. The whole document is at most 64 KiB.
- **The agent app is named beside the profile, not in it** (amended 2026-10-16, CUE-493, for 0.20.0). An organisation
  may have one bot-only Slack agent app, whose token members paste with `workspace bot`. Its id goes in a companion
  file in the same folder, the profile's name with `.agent-app.json` for its `.json`: `{"agentcomms":
  "organisation-agent-app", "version": 1, "organisation", "slack": {"workspace", "appId"}}`, strict, at most 64 KiB,
  its organisation and workspace the profile's. Every object of a version-1 profile is strict in every release since
  0.13.0, so a new key in the profile would make a member still on one of them refuse the whole document at `org
  update`; they never open the companion file. Read with the profile by `org add` and `org update`, it is bound by its
  own SHA-256 in the same approval — another file, or none where there was one, is a change approved first even with
  the profile's bytes unchanged — and recorded as `slack.apps.agent: { appId, sha256 }`, which the configuration's
  loose schema keeps through older releases' ordinary writes (an older `org update` rebuilds `apps` and drops it; the
  next update by this release names it again, approved).
- **Version 1 gained `extensions`** (amended 2026-10-19, CUE-494, for 0.21.0, under the
  [extensions design](2026-10-19-organisation-profile-extensions-design.md)): one more top-level key, an object of at
  most 16 named entries, each carrying `required` and `since` beside the extension's own fields. It is the only door
  for what later releases add; every other object of the profile stays strict, and no new companion file is added.
- **Every field comes from whoever wrote the profile**, and is checked as untrusted, so each has a grammar and a bound,
  and the schema refuses anything else:

  | Field | Rule |
  |---|---|
  | `organisation` | the exported organisation parser, at most 28 characters |
  | `label` | 1–64 characters, one line: no line or paragraph separator, tab or other control character |
  | `gmail.clientId` | `^[0-9]{1,30}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$` |
  | `gmail.clientSecret` | 1–256 printable ASCII characters; never shown anywhere |
  | `gmail.projectId` | Google's project id form, `^[a-z][a-z0-9-]{4,28}[a-z0-9]$` |
  | `gmail.serves.domains` | 1–50 lower-case host names, each at most 253 characters, letters, digits, hyphens and dots only |
  | `slack.workspace` | `^T[A-Z0-9]{2,20}$` |
  | `slack.workspaceName` | 1–80 characters, one line, as `label` |
  | `slack.apps.*.clientId` | `^[0-9]{1,20}\.[0-9]{1,20}$` |
  | `slack.apps.*.appId` | `^A[A-Z0-9]{2,20}$` |
  | `slack.redirectPort` | an integer from 1024 to 65535 |

  On top of the grammar, the two free-text fields are untrusted text as the base design treats every outside string
  (§9 of [the base design](2026-09-18-agent-communications-design.md)): wherever they are shown — previews, effects,
  errors, CLI output and MCP results — they pass through the core's `neutralise` (`packages/core/src/untrusted.ts`)
  *and* are flattened to one line, because `neutralise` keeps line feeds and tabs (`chars.ts`); Slack's CLI already
  flattens for this reason (`packages/slack/src/cli/render.ts`). Any other profile-originated string that is shown is
  flattened the same way.

### D3. Where a profile comes from — a file, in version 1

`agentcomms org add ./rgc.agentcomms.json`: the organisation's repository is cloned, or the file is handed over inside
the organisation (§D10). The path is resolved to an absolute, normalised path when the command runs, as `client add`
does with its file (`clients.ts`), and that path is read again on each update, whatever the working directory then.
The record keeps the path, the SHA-256 of the bytes and when they were read; the bytes are not kept.

**URL sources are left out of version 1.** The review found that a URL's path, not only its query, can be a bearer
credential (the core already hides MCP server URL paths for that reason, `packages/core/src/mcp-clients.ts`), so a
stored or displayed URL leaks it; and a profile fetched by the core is an outbound request needing SSRF hardening. An
External client's profile should stay private anyway (§D10). A later version can add URLs with: the whole URL kept in
the secret store and only its origin shown; HTTPS only; DNS pinned; loopback, private, link-local, multicast,
unspecified and reserved addresses refused; at most 3 same-origin redirects; one 10-second limit; a 2xx status; the
decompressed body cut at 64 KiB; and the MCP tool marked open-world. Without fetching, the core makes no new outbound
request, and the channel manifest's `hosts` contract ("the core connects no account") is untouched.

### D4. Records, ownership and generations

Requires a **version-2 configuration**: on version 1, `org add` refuses with `agentcomms names migrate` as the fix,
because profile-made names are `organisation/platform` and v1 cannot hold them.

A new additive top-level key, `organisations` (absent reads as `{}`):

```json
"organisations": {
  "rgc": {
    "label": "Really Good Culture",
    "source": { "kind": "file", "path": "…/rgc.agentcomms.json" },
    "sha256": "…", "readAt": "…", "addedAt": "…",
    "forOtherAddresses": false,
    "gmail": {
      "active": "rgc-1",
      "generations": [
        { "name": "rgc-1", "clientId": "332711690878-…", "projectId": "rgc-agent-comms",
          "ownership": "owned", "serves": "any", "addedAt": "…" }
      ]
    },
    "slack": { "workspace": "TJYMH92Q2", "workspaceName": "…", "redirectPort": 51234,
               "apps": { "read": { "clientId": "…", "appId": "…" }, "send": { "clientId": "…" } } }
  }
}
```

- **Generations.** Each Google client a profile brings is a *generation*: a record holding its client name, client
  id, ownership and its own `serves`, because `serves` is a fact about one client, not about the organisation. An
  owned generation's client is registered under `<organisation>-<n>` (`rgc-1`, `rgc-2`…), the lowest `n` whose name is
  free. `gmail.active` names the generation new mailboxes get; an explicit `--client rgc-1` on a retained generation
  is checked against *that* generation's `serves`. Mailboxes keep the client they signed in through.
- **Ownership.** An owned generation's client row also carries `organisation: "rgc"` (additive). A client row is
  associated with at most one organisation; a profile that would claim a row another profile holds is refused.
- **Adoption.** When the profile's client id is already registered here under some other name (the person ran
  `client add` with the organisation's file), that row is adopted: a generation with `ownership: "adopted"` naming it.
  Its row and secret are never changed or removed by any `org` command. More than one row with that client id is
  ambiguous and refused, naming the rows, unless `--adopt <client>` (MCP argument `adopt`) names one. Nothing is ever
  overwritten.
- **One resolver, for `org add` and `org update` alike**, decides which generation the profile's Gmail client is:
  (1) a retained generation of this organisation with the same client id is made active again — **only if it is
  usable**: an adopted one whose live row still has that client id and is held by no other organisation, or an owned
  one, whose row the profile can rebuild because the profile carries that client's secret (A → B → A returns to A's
  generation); else (2) a row with that client id that no organisation holds is adopted — the one named by `--adopt`,
  or the only one; else (3) a new owned generation is created. The same resolver handles Gmail added to a
  profile that had none, and re-added after being removed. Its choice is an effect line of the approval, and is
  checked again under the credentials lock (the adopted row must still have that client id and still be free).
- **Owned rows are the profile's to change.** In this release, `client add --replace` and `client remove` refuse a
  row that carries `organisation` and point at `org update` or `org remove`. Adopted rows stay the person's: they may
  replace or remove them, and the record then reports the generation as gone.
- **Same id, new secret** (Google rotation) on an owned generation: the secret is replaced under the same reference,
  because the Gmail session derives a client's secret reference from its name (`clientSecretRef(inbox.client)`,
  `packages/gmail/src/auth/session.ts`).
- **Every secret write for an owned generation — a new name, a repair, a rotation — uses the procedure registration
  uses today** (`clients.ts`): read and keep whatever the target reference holds (a name free in the configuration
  does not prove its reference is empty), write the new secret, write the config, and on failure restore exactly what
  was there — with `writeOutcome` deciding a write whose commit is uncertain. An adopted generation's secret is never
  changed; the result says to run `client add --replace` on it.
- **Slack provenance.** An account connected *from the profile* records `organisation: "rgc"` and `profileApp: "read"
  | "send"` (additive keys). An account connected with an explicit `--client-id` records neither and is never treated
  as the profile's, even if the id coincides.
- **Older releases** sharing the file keep `organisations` through their writes (loose root), but do not know its
  rules: one could `client remove` an owned row. This is accepted rather than moved to a version 3. The daily update
  check makes mixed releases short-lived, but it is **best effort** — it can be turned off, and is off under CI or
  `AGENT_COMMS_UPDATE_CHECK=off` (`update-state.ts`) — so the new code never assumes the record is intact: `org show`
  and `doctor` report drift, and `org update` repairs what it can (§D8). Only the **active** generation can be repaired,
  because the profile holds only its secret; a missing inactive generation is reported as unrecoverable without its old
  client file, with the command to move its mailboxes onto the active one. Cross-version tests write with the last
  release before this one and read with this one.

### D5. Adding a profile is one approved change, applied atomically

`agentcomms org add <file> [--for-other-addresses] [--adopt <client>] [--store keychain|file]` (`comms_org_add`)
is a gated change. Its approval is **bound
to the exact profile**: the plan's `effects` are deterministic lines derived from the normalised profile, listing the
organisation and label, the source and SHA-256, the Google client id, project and `serves`, the name it will get
(`rgc-1`) or the client it adopts, `forOtherAddresses`, the Slack workspace id and name, each app's client id (and app
id) and the port. The secret is never shown — "client secret: included". On the claiming call the source is read
again; a different SHA-256 refuses the claim ("the profile changed since it was approved; prepare it again"). Those
exact bytes are what is applied.

The core owns the operation. The Google parts it needs move from Gmail into a lower-level core module
(`oauth-client-records.ts`): validating a client id, staging a client secret in the configured store, and writing a
client row — the pieces `client add` also uses, which Gmail then imports from core. Applying is one transaction under
the credentials lock: write the secret (none for an adoption) by the snapshot-and-restore procedure of §D4; write the
client row, the `organisations` record and nothing else in **one** config update; on a failed write, restore the
reference to what it held, verifying as `clients.ts` does today.

**Where the secret goes.** Only when the resolver will write an owned Gmail secret — never for a Slack-only profile,
an adoption, or an update that writes no secret — `org add` and `org update` choose a store, and only then is
`secrets.store` written. A `--store` given when nothing will be written is refused as not applicable. They take
`--store keychain|file` (MCP `store`), with exactly the existing chooser (`secretsStoreFor`, `config.ts`): the store the configuration already uses wins and a different one
is refused; when nothing is stored yet, the keychain is probed and `--store file` is the fix if it cannot be used. The
chosen store is an effect line of the approval and is checked again under the lock. No credential probe against Google at add time (the core makes no account traffic); Gmail
probes on first use, and `doctor` reports a client Google refuses.

Refused: an organisation word that already has a record (`org update` is the way); a v1 configuration; a profile that
is not valid; an organisation word over 28 characters; an ambiguous adoption (§D4). An account of the same
organisation word already connected to `slack.workspace` through the person's own app is **reported, not refused**,
and left exactly as it is (no provenance): early members connected that way before profiles existed, and adding the
profile must not make them disconnect Slack first (decided in implementation, 2026-10-03).

Every secret write, for a new name too, uses the snapshot-and-restore procedure of §D4.

### D6. Which Gmail client a new mailbox uses — decided before consent

When a mailbox is added (`inbox add`, `setup`, `gmail_inbox_add`), the client is chosen before the link is built.
Every organisation client the table picks is first checked by **one live-generation validator**: the active
generation's row must exist and match the generation — provider `gmail`, the client id, this organisation's marker (or,
for an adopted one, the adopted row still having that client id and no other organisation's marker) and the canonical
secret reference. A row that fails is not used — the add is refused with `org update <organisation>` as the fix,
because the configuration has drifted from the profile (a client name reused by an older release, say). The flow
records the expected client id and generation, and the completion checks them again before anything is saved, as it
already checks that the client row did not change during the flow (`consent.ts`).

| Given | Client |
|---|---|
| `--client <name>` | that one, as today |
| the name's organisation word has a profile with a Gmail client | its active client — if `serves` is domains and `--email` is given, the address must be in them or the add is refused before consent |
| otherwise, exactly one profile has `forOtherAddresses: true` (set only when the member asked, §D5) **and an active Gmail generation** | its active client; two or more such profiles: refused, asking for `--client` |
| otherwise | today's rule, **among clients no organisation is associated with**; if there is none, `inbox add` refuses with the three ways on (`--client rgc-1`, `org update rgc --for-other-addresses on`, or `setup` to make a client of one's own), and `setup` walks the Google Cloud steps for a client of one's own |

After consent, the address that came back is checked against the chosen client's `serves`. A mismatch (only possible
with a domains client and no `--email`) revokes the new grant at Google's revoke endpoint, best effort, stores
nothing, and refuses with the command to retry through the right client. Results and `inbox list` name the client used
and, for an owned or adopted client, its organisation.

`inbox import` (another server's tokens) never applies this: its refresh tokens are bound to the client they came
with, and its existing same-id reuse stands.

**`setup`**: "a client is registered" no longer means "the client step is done" (`setup.ts` today counts any client).
The client step is done for the name being added when the table above picks a client for it. With a profile client
picked, the Google Cloud walk is skipped and setup says
why ("Your organisation, Really Good Culture, provides the Google client"); the "there is no shared one to borrow"
text changes to say an organisation may provide one. `setup --profile <file>` runs `org add` first — its own
approval — then continues; headless it stops at that approval with exit 10, and `--org-approval <id>` claims it, as
`--approval` does for a client today.

**Moving an existing mailbox** onto the organisation's client is today's `inbox reauth <name> --client rgc-1`,
documented for this case.

### D7. Slack through the organisation's apps

- `workspace add rgc/slack` with no `--client-id` uses the profile of organisation word `rgc`: the `read` app, or
  `send` with `--mode send` (a widening, approved as today), and the profile's port. The flow records the expected
  workspace, client id, app id (if known), the profile's SHA-256 and the app role. `validateExchange` refuses, before
  anything is stored, a token for another workspace or another app. An explicit `--client-id` keeps today's
  behaviour and is unmanaged; it requires `--port` as today.
- **Mode as a move between the two apps.** For an account with `organisation` provenance, `workspace mode <name>
  send|read` signs in through the profile's *other* app instead of asking for an app to be edited. The flow snapshots
  the source account's id and `secretRef` and the exact target (workspace, client id, app id, port, profile SHA-256);
  the client-id and app-id checks allow exactly that transition, and a profile updated during the flow invalidates
  it. `read → send` is a widening, approved as today; `send → read` applies at once, as narrowing does.
- **Revocation, in this order.** (1) Stage the new token bundle under a new secret reference. (2) In one config update
  under the credentials lock: switch the account to the new reference, client id, app id, mode and `profileApp`; and
  add to `pendingRevocations` (below) an entry naming the *old* reference and a status per token — access, and refresh
  where the old bundle has one — each `pending`. The old bundle stays in the secret store, now reachable only through
  that entry. (3) Call `auth.revoke` for each pending token — under the one-shot grant below — and mark each token's
  status in the config by the rules of "What counts as revoked"; Slack treats each rotating access or refresh token as
  a separate token. (4) Only when every token is conclusively finished (`revoked` or `expired`), delete the old bundle
  and the entry. A token not yet finished leaves the record and the bundle; `doctor` retries, after a restart too, and
  the result says plainly what is revoked, expired and still pending. Revocation does not
  remove the app's installation, and nothing says it does. Revoking the account's *own* superseded token is cleanup of
  a change already approved (or of a narrowing), not a separate approval.
- **One pending store, outside the accounts.** Pending revocations live in a top-level, additive
  `pendingRevocations` list — `{ ref, store, platform, workspace, createdAt, tokens: { access, refresh } }`, each token
  `{ status, deadline }` — not on the account, so
  removing or moving the account again cannot erase the only reference to a live token. `secretRefsOf` and every scan
  of referenced secrets (secrets migration, doctor's orphan checks) include these references, so a migration moves the
  pending bundle with everything else. Each entry also records the **store it was written to**, and revocation reads
  it from that store, not from the configuration's current one: an older release's `secrets migrate`, which knows
  nothing of the list, can switch the store without copying the bundle, and the entry still finds it. A migration by
  this release moves the bundle and updates the entry's `store` in the same step. A second mode move while one is pending simply adds an entry.
  `workspace remove` tries to complete the account's pending revocations first; what it cannot complete stays in the
  list for `doctor`, and the result says so.
- **Learning an app id.** When a profile app carries no `appId`, the first successful sign-in through it writes the
  returned app id into `organisations.<org>.slack.apps.<role>.appId` **in the same locked config update** as the
  account, with a compare-and-set inside the lock: if another sign-in recorded a different app id first, this one is
  refused and its staged token removed. A learned app id is kept only while the workspace, role and client id stay the
  same; it is cleared when the role's client id changes. An `appId` the profile states replaces a learned one, and
  accounts whose recorded app id differs are reported.
- **The app id comes from the exchange.** `oauth.v2.access` documents `app_id` in its answer (§2), so the first
  sign-in through a profile app learns it from there. For a *profile* flow, an answer whose `app_id` is missing or
  does not match the profile grammar (`^A[A-Z0-9]{2,20}$`, §D2) is refused before anything is staged or learned,
  because without it the app check above could not be made. A sign-in through a person's own app (`--client-id`) keeps
  accepting an answer without `app_id`, exactly as today.
- **What counts as revoked.** Slack revokes one token per call and documents no cascade, so each pending token is
  revoked on its own, the refresh token included. A token is marked:
  - `revoked` when Slack answers `ok: true` **and** `revoked: true`, or with `token_revoked` or `token_expired`, which
    each say that this token is dead;
  - `expired` when the deadline recorded for it in the entry has passed. The deadline is fixed when the entry is
    created, as an absolute time, from the old bundle (`packages/slack/src/auth/bundle.ts`): its `accessExpiresAt`
    for the access token and `refreshExpiresAt` for the refresh token when each parses as a time; otherwise — absent,
    or present but unreadable, as `doctor` already finds (`packages/slack/src/operations/doctor.ts:231`) — 30 days
    after the entry is created, the documented life of a PKCE app's refresh token (§2), which bounds its access token
    too, since every bundle these entries hold comes from a profile app whose manifest has rotation on. A token past its
    deadline cannot be used by anyone, so a revocation that can never be confirmed (a cascade from its pair, or a
    revoke Slack acted on whose answer was lost, after which a second revoke's answer is undocumented) ends there,
    and no entry can be retried forever. The result shows each deadline;
  - otherwise `pending`: `ok: true` with `revoked` false or absent, `invalid_auth` (Slack documents it for a request
    from a disallowed IP address too, so it does not prove the token dead), `account_inactive` (documented for bot
    tokens; these are user tokens), `ratelimited`, a 5xx, a dropped connection, and any error not named here.
  The result names each token's state.
- **A one-shot grant for each revoke.** `auth.revoke` is not added to the transport's allowlist as an ordinary
  method. The guard (`packages/slack/src/api/guard.ts`) gains a dedicated grant, as `configure` and `write` have: it
  is bound to one `pendingRevocations` entry, one token kind (access or refresh) and the SHA-256 of that exact token,
  allows exactly one `auth.revoke` call carrying that token, and is consumed by it. The operation loads the token from
  the bundle the entry names, in the store the entry records, never from a caller; after Slack answers, it updates
  that token's status by compare-and-set on the same entry, kind and `pending` status under the credentials lock, so a
  wrong reference, another bundle, or an access/refresh swap cannot advance a status or revoke anything else.
- **A profile sign-in that fails before storing anything.** In a workspace that requires app approval, a member may be
  shown Slack's request page and never come back; Slack does not document what the sign-in then receives (§2). So
  every way a profile-app sign-in can end before a token is stored — the listener's timeout, a callback with any
  `error` (`access_denied` included), and an exchange Slack refuses — reports Slack's own `error` and description where there is one (flattened and neutralised, §D2) and says
  that the sign-in did not complete, that the person may have declined or the workspace may require an administrator
  to approve the app, and names the organisation's label, the workspace name and id, and the app's role and client id.
  It never says the person declined. Those display fields are snapshotted, flattened and neutralised, into the flow
  when it starts, so the message does not depend on the profile still being there.
  **No new stored state for a timeout.** The flow store is unchanged: the detached listener still deletes the flow at
  its timeout, which is the flow's own expiry (`packages/slack/src/operations/signin.ts:215`,
  `packages/slack/src/auth/flow.ts:23`), and every expiry path discards it as today. The message is given where the
  sign-in is known to have been a profile one, without remembering anything: a foreground sign-in's own listener
  timing out, and a finish (`--finish`, `slack_workspace_finish`) already waiting on a profile flow — it has read the
  flow, display fields included — that sees the flow end at its deadline with no outcome, report it as above. A finish
  that finds no flow at all keeps today's "not found" answer and, when the account name's organisation word has a
  profile with a Slack part, adds one cautious line: if a sign-in through the organisation's app never came back, the
  workspace may require an administrator to approve the app (naming the label and workspace from the profile as it is
  now). A browser simply abandoned ends as the timeout. Nothing is stored in any of these cases. A profile updated or
  removed during the wait invalidates the flow, as above, and that is what is reported. (Rounds 4–8 of the amendment
  review designed a stored timed-out flow instead, with a post-deadline claim, takeover of stale claims and fencing;
  each round found another race in it, and it bought only a better word than "not found" for a later finish, so it was
  dropped for this. A completer that crashes after claiming a flow is an existing property of every sign-in, own-app
  ones included, and is not changed here.)
- **Cancelling a wait on a detached sign-in ends only the wait.** When an MCP client cancels a waiting
  `slack_workspace_finish`, the tool honours the request's cancellation signal (passed as the Gmail finish tool already
  does), stops waiting, and says the sign-in is still open and how to finish it. When the person interrupts a waiting
  `workspace add … --finish` (or `reauth … --finish`) in a terminal, the command exits as every CLI action does today
  (`exitAfterRefreshes` settles refreshes and re-delivers the signal, `packages/slack/src/auth/exit.ts:84`), with no
  message of its own. Either way the flow and its detached listener — a separate process — go on, so a sign-in the
  person completes in the browser afterwards is collected by the next `--finish`, as today. Cancelling is not a failure and
  stores nothing by itself. A sign-in run in the foreground (no `--start`), whose listener lives in the command's own
  process (`packages/slack/src/cli/program.ts:499, 1406`), keeps today's behaviour: interrupting it ends the process
  and its listener (`packages/slack/src/auth/exit.ts:77`), and nothing is stored.
- An account connected through a person's own app keeps today's procedure unchanged.

### D8. Updating, removing, reading

`agentcomms org update <organisation> [--source <file>] [--for-other-addresses on|off] [--adopt <client>]
[--store keychain|file]` re-reads the source and
does two things: applies what changed in the profile, and **reconciles** the record with the configuration — which it
does even when the bytes are unchanged, because drift (§D4) does not change the profile's hash. What needs approval:
any change to the profile's contents, a new `--source`, and `--for-other-addresses on` — each bound like §D5, its
effects listing each change before → after ("secret changed" for a secret). What applies at once: a reconciliation that
only repairs drift (it brings the configuration back to what was already approved), and `--for-other-addresses off`.

| Change | What happens |
|---|---|
| `organisation` differs from the record's | refused: it is a different profile, added with `org add` |
| `--source` given | the new file is read and recorded; approved like any other change, even with identical bytes, because it decides where later updates come from |
| `--for-other-addresses on` / `off` | on: approved (it lets the client serve the member's other addresses), and refused while the profile has no active Gmail generation; off: at once |
| Gmail client id changed | the resolver (§D4) decides: a usable earlier generation reactivated, a free matching row adopted, or a new owned generation (`rgc-2`) made; it becomes active; older generations are kept, and their mailboxes stay on them until moved with `inbox reauth --client` |
| Gmail secret changed, same id | rotation of the active owned generation, by snapshot and restore (§D4); an adopted one is reported, not changed |
| Gmail `serves` changed, same id | the active generation's `serves` is updated |
| Gmail `projectId` changed, same id | the active generation's `projectId` is updated, and an owned generation's live row with it; an adopted row is left as it is, and the result says so |
| Gmail added, re-added, or changed back to an earlier client | the same resolver |
| `gmail` removed | no active generation; every generation is kept, with its ownership; mailboxes keep working; new mailboxes no longer get it; `forOtherAddresses` stays as the member set it but routes nothing until a generation is active again, and `org show` says so |
| Slack `workspace` changed | refused while any account carries this organisation's provenance; otherwise applied |
| a Slack app's client id changed for a role | no account is moved by the update; each account on the old app is reported, and `workspace reauth <name>` for an account with this organisation's provenance signs in through the role's *current* app — the same snapshot, checks and ordered revocation as the mode move (§D7) |
| a Slack app role removed | accounts on it are reported with two ways on: `workspace mode` to the remaining role (if the profile still has one), or `workspace remove`; a move to the removed role is unavailable |
| Slack `redirectPort` changed | later sign-ins use the new port |
| `slack` removed | the Slack part is cleared; accounts keep working, are reported as no longer listed, and lose the mode move |
| an entry listed as ignored is now understood | a change, never drift, even with unchanged bytes and source: classified by the extension's own classifier — a tightening applies at once, a loosening or a change of who acts is approved first, before → after ([extensions design](2026-10-19-organisation-profile-extensions-design.md), X4; amended 2026-10-19) |
| the caps file only tightens | applied at once with its SHA-256 recorded, even beside a change that waits, and the preview marks it done; looser in any part, a file removed, or a mix is approved first ([extensions design](2026-10-19-organisation-profile-extensions-design.md), X6; amended 2026-10-19) |
| unchanged bytes, drift found | reconciled under the credentials lock, row by row: **(a′)** an owned generation's row holding the *same* client id with no organisation's mark — what an older release's `client add --replace` leaves — is marked again in place (the active one's secret is then held to the profile's; an earlier one's is left alone), not counted as a reused name; **(a)** the active owned generation's row missing — recreated from the profile under its name, or under the next free name if a different row holds that name now; **(b)** a row marked with this organisation that has the generation's client id but is otherwise altered (another project id, a secret reference that is not `clientSecretRef(name)`) — rewritten from the profile when it is the active generation, by snapshot and restore; **(c)** a row marked with this organisation whose client id is no longer the generation's — its marker alone is cleared, leaving the row and its secret as they are (it becomes an ordinary client of the person's, which `client` commands can manage), and, if it was the active generation, a new one is built under a free name; **(d)** a missing inactive generation — reported as unrecoverable (§D4); **(e)** an *inactive* generation's row, still marked, with the generation's client id but altered (a secret reference that is not `clientSecretRef(name)`, another project id) — it cannot be rebuilt, because the profile holds only the active client's secret, so its marker alone is cleared, the row and secret are left as they are, and it is reported as no longer managed. Nothing is deleted; every repair is listed in the result |

`agentcomms org remove <organisation>` is refused while any mailbox uses a client of any of its generations or any
account carries its provenance, and lists them. It is also refused — and the record kept — while a row carries this
organisation's marker but no longer matches its generation (another client id, another secret reference): left behind
without a record, such a row would be one no command could change, because `client remove` and `client add --replace`
refuse marked rows. The refusal names the row and says to run `org update`, whose reconciliation (rows (b), (c) and
(e) of the table above) either repairs it or clears its marker; after that, removal skips any unmarked row. No marked
row is left with no command that can change it. Otherwise it removes
the record and, for each *owned* generation, the live client row and its secret (`clientSecretRef(name)`); adopted rows
are never touched. The final check of identity and use, the config write and the secret deletion all happen under the
credentials lock, as `client remove` does (`clients.ts`). The approval is bound to the stored SHA-256 and to the exact
rows it will remove.

`org list` and `org show` read only and never return a secret or the raw profile. Nothing refreshes a profile on its
own: not the daily update check, not a server start. **Redaction everywhere:** previews, diffs, errors, audit records
and MCP results never contain the client secret or the profile's bytes.

### D9. Parity

Five operations, each with one shared operation, a CLI command, an MCP tool, a `capabilities.json` row, approval
arguments and annotations, and generated reference pages (`pnpm sync:reference`): `org add` / `comms_org_add`,
`org list` / `comms_orgs_list`, `org show` / `comms_org_show`, `org update` / `comms_org_update`, `org remove` /
`comms_org_remove`. `org add` and `org update` take `--adopt <client>` (`adopt`) and `--store keychain|file` (`store`); `org add` takes
`--for-other-addresses` (`forOtherAddresses`); `org update` also takes `--source` (`source`) and
`--for-other-addresses on|off`. The core CLI's approval and update-gate routing learns them. `setup --profile` is a `via` row
(it runs `org add`). `workspace add`'s profile path and the mode move change existing rows' descriptions only.
Skills: `skills/comms-onboarding`, `skills/gmail-setup` and `skills/slack-setup` (which today teaches editing your
own app) — shared contracts first, then `pnpm sync:skills`.

### D10. The organisation's repository

Outside this repository: for RGC, a private repository under RGC-LABS holding `rgc.agentcomms.json`, a README for
members in plain words, and:

```sh
npx -y @agentcomms/core org add ./rgc.agentcomms.json        # add --for-other-addresses to use it for any address
npx -y @agentcomms/gmail setup
npx -y @agentcomms/slack workspace add rgc/slack              # or --mode send
```

It wraps; it does not fork: agent-communications comes from npm, so releases reach the organisation unchanged.
Updating is `git pull` and `agentcomms org update rgc`. Private, because an External client's 100-account lifetime cap
is the one thing a leaked file can use up.

## 4. Phases

0. **RGC acceptance, no longer a gate (amended 2026-10-04).** First written as a spike before any code: Mateo
   connects with RGC's apps by hand and settles four questions before phase 3. The owner is holding that message, so
   phase 3 is built without it. Two of the four are answered by Slack's documents (§2): the app id and workspace id
   come back from the exchange, and a PKCE client's refresh token rotates. The other two are left open by the
   documents, and §D7 is written to be right under either answer: a revoke that cannot be confirmed stays pending and
   is retried, and a sign-in that never returns says an admin's approval may be missing. The live checks — a
   non-admin authorising an app no admin installed (and Slack's exact wording if not), rotation past the first
   refresh, and what revoking one token of a pair does to the other, on a throwaway token — happen when RGC's members
   connect in phase 4, and are recorded here with the date then.
1. **Core: profiles.** Exported organisation parser; schema; the `organisations` record, generations,
   ownership and adoption; the shared client-record module (and Gmail switched to import it); `org add | list | show
   | update | remove` with bound approvals; drift reporting in `doctor`; parity, reference and skills for these.
2. **Gmail: using it.** Client choice before consent (§D6), the post-consent check and revoke, `setup` skipping the
   walk, `setup --profile` with `--org-approval`, the move-a-mailbox documentation.
3. **Slack: using it.** Profile-driven `workspace add` with the workspace/app checks; provenance; the mode move with
   its snapshot, the relaxed checks for exactly that move, and ordered revocation with a pending record; the revoke
   outcomes and the approval-pending message of §D7; `skills/slack-setup` rewritten.
4. **RGC.** The RGC repository and its README (how to fill a profile from Google's file); RGC's members moved onto
   it, with phase 0's live checks recorded as they connect; release notes.

Each phase is one branch, one Codex review, one Blocks loop where the repository uses it, one release.

## 5. Tests the phases owe

Each guard watched failing under a mutation. Matrices, not single cases: v1 refusal and v2; writes by the previous
release preserving `organisations`; ownership, adoption, ambiguous adoption with and without `--adopt`, and same-id
collisions; the resolver (reactivation, A → B → A, Gmail added and re-added); `client add --replace` and `client
remove` refusing owned rows; `org remove` skipping an *unmarked* reused or altered row and refusing a *marked*
mismatched one, and succeeding after `org update` reconciles it (rows (b), (c) and (e)); a secrets migration that wins between
planning and the credentials lock (the store re-checked); `--store` refused when nothing is written; a URL given as the source refused (version 1 reads files only); every field's grammar at and past its bound; a relative source path updated from another
directory; `forOtherAddresses` with no active generation; a row claimed by two
profiles; generation numbering at the 28-character limit; generation-specific `serves` on an explicit `--client`;
rotation with snapshot and restore, including a write whose commit is uncertain; secret staging rollback on a failed
write; every row of the §D8 table, and same-hash repair (missing owned row; name reused by another row);
the profile-only fallback (no organisation-free client) in `inbox add` and `setup`; concurrent add/update/remove; a relative and an absolute file path, and a file changed between prepare and claim;
approval drift (bytes changed between prepare and claim); `--store` on a first secret and a refused second store;
snapshot and restore over a pre-existing unreferenced secret on a new name; reactivation of an adopted generation whose
row is gone; `org remove` refused for a marked, mismatched row, active or inactive, and succeeding after `org update` (rows (b), (c),
(e)); the live-generation validator refusing a missing or reused active row through organisation-name routing and
through `forOtherAddresses`, and the flow's re-check of the expected client id at completion; a drift-only `org update`
applying without an approval while a content change asks for one; a `projectId`-only change; `label` and `workspaceName`
with control tokens, bidirectional and invisible characters, newlines and over-long values; Gmail choice with and without `--email`, each row of §D6;
post-consent mismatch revocation; import untouched; Slack add, workspace/app mismatch, the mode move's races and
snapshot, revocation order, a failed revoke left pending and retried after a restart, an already-invalid token, a
pending entry surviving `workspace remove`, a second move, each `auth.revoke` answer of §D7 (`ok` with `revoked`
true, false and absent, `token_revoked`, `token_expired`, `invalid_auth`, `account_inactive`, `ratelimited`, a 5xx, a
dropped connection, an unnamed error), the refresh token revoked on its own, a cascade (the second token's revoke
answering each of those) and no cascade, a crash after Slack acted but before the status was written, and expiry ending
a pending token (access, refresh, and a refresh bundle with no recorded expiry); the one-shot grant refusing a wrong
reference, another bundle and an access/refresh swap, and being consumed by one call; an exchange without `app_id`,
or with one outside the grammar, refused before staging on a profile flow and still accepted on an own-app flow; a
profile-app sign-in ending in the detached listener's real timeout (with a short injected timeout, not `--wait`), in
a callback `error` (`access_denied`, an approval-like one, an unknown one)
and in an exchange refusal (the same three), each saying what §D7 says, never that the person declined, and storing
nothing; a finish already waiting on a profile flow that expires reporting the timeout with the approval line, and a
finish finding no flow adding that line only when the name's organisation has a Slack profile; a cancelled wait on a
detached sign-in (MCP cancellation saying it is still open; a CLI interrupt of `--finish` exiting as today) leaving the
flow open and a later `--finish` collecting a sign-in completed after it, and a foreground sign-in interrupted storing
nothing as today; a pending entry's deadlines from valid, absent and unreadable expiry fields; the flow store's
expiry behaviour unchanged for every flow; a profile updated or removed during the wait; a secrets migration by this release, and one by the release
before it (the bundle read from its recorded store); same-role reauth after an app
replacement; the app id learned once under two simultaneous first sign-ins, cleared on a new client id; redaction snapshots of every surface; CLI/MCP
parity; and the repository's full `pnpm verify` (`verify:channels`, `verify:skills`, `verify:reference`,
`verify:parity -- --strict`).

## 6. Out of scope

URL sources (designed in §D3 for a later version); settings in a profile; a helper that builds a profile from
Google's file; signed profiles and a discovery convention (`.well-known`); refreshing profiles automatically;
Google verification past 100 users; Slack Enterprise Grid; Resend and WhatsApp, which have no shared app to describe;
a config version 3.

## 7. Risks

1. **A profile decides where tokens go.** Answered by the bound approval (§D5), the hash checked at claim and on every
   update, the workspace and app checks (§D7), and Google's and Slack's own consent screens naming the app.
2. **The 100-account cap** on an External, unverified client: profiles for such clients stay private (§D10);
   `forOtherAddresses` is off unless the member asks for it, so personal addresses use the cap only by choice.
3. **Slack app approval** in workspaces that require it: Slack's documents do not say whether the sign-in ever
   returns, so a profile-app sign-in that times out, or fails before storing a token, says an admin's approval may be
   missing (§D7); cancelling a wait is not a failure and leaves the sign-in open;
   RGC's live behaviour is recorded when its members connect (§4, phase 0).
4. **Port collisions:** every member signs in on the profile's port; a busy port fails with a message naming it.
5. **Older releases** editing owned records: made short-lived by the daily update gate where it is on, and in every
   case reported as drift and repaired by `org update` (§D4, §D8).
