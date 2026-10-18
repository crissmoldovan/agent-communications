# Organisation profile extensions — design

Status: **approved by the owner on 2026-10-19** for 0.21.0. Of three designs, the owner chose C, an `extensions`
section in the profile. The other two were A, a new file beside the profile for each feature, and B, a new profile
version for each feature. The owner also decided that an organisation tightening its update caps applies at once.

Tracked as CUE-494 (Linear, project agent-communications). This design amends §D2 and §D8 of the
[organisation profiles design](2026-10-02-organisation-profiles-design.md) and U8 of the
[smoother updates design](2026-10-16-smoother-updates-design.md). Where they differ, this design is the later word.

## 1. What was asked

> Every release from 0.13.0 to 0.19.0 refuses an organisation profile carrying any key it does not know, at every
> level. So any field an organisation adds breaks `org update` for every member still on an older release.

The issue asked for three things:
- an extension point that older releases tolerate;
- a rule for which future fields an older release may ignore and which it must refuse ("a field that loosens
  something must never be silently ignored");
- a migration note for admins.

## 2. What is true, and was checked (2026-10-18, at b5e7322e = v0.20.0)

- **Every profile object is strict.** That covers the root, `gmail`, `serves`, `slack`, `apps` and each app: `z.strictObject` in
  `packages/core/src/organisations.ts`. The schema blocks are identical in v0.13.0, v0.19.0 and v0.20.0.
- **An unknown key refuses the whole document** with `BAD_DATA`: `the organisation profile is not valid: the profile:
  "x" is not a key a profile has`. The hint is to ask the organisation for its current profile.
- **`version` is `z.literal(1)`.** A `version: 2` gets zod's `expected 1`, with the same hint. That hint is wrong
  for this case: the member's release is the old part.
- **Both companion files are strict too**, and a bad one fails the whole `org update`:
  - `<profile>.agent-app.json` has a kind and `version: 1`;
  - `<profile>.updates.json` has neither.
- **The repair rule.** When `org update` re-reads the same bytes from the same place, every difference between
  profile and record counts as drift, and is repaired at once with no approval
  (`packages/core/src/operations/organisations.ts`, the `!shaChanged && !input.sourceGiven` branch). That is right
  for what was already approved. It would be wrong for an entry an older release skipped, which nobody approved.
- **A change to the caps file always needs approval**, even a tightening (`needsApproval` includes `capsChanged`).
  Everywhere else in the product a tightening applies at once ([parity design](2026-09-25-cli-mcp-parity-design.md)).

## 3. Decisions

### X1. The shape

A version-1 profile may carry one more top-level key, `extensions`, an object:

```json
{
  "agentcomms": "organisation-profile",
  "version": 1,
  "organisation": "rgc",
  "label": "Really Good Culture",
  "slack": { "...": "as today" },
  "extensions": {
    "some-feature": { "required": true, "since": "0.23.0", "...": "the feature's own fields" },
    "a-display-hint": { "required": false, "since": "0.24.0", "...": "the feature's own fields" }
  }
}
```

- **Names:** at most 16 entries. Each name matches `^[a-z][a-z0-9-]{1,39}$`.
- **Every entry** is an object with two mandatory fields:
  - `required`, a boolean;
  - `since`, a plain `MAJOR.MINOR.PATCH` version: the first release that understands the entry.
- **Its other fields** belong to the extension.
- **The whole document** stays at most 64 KiB.
- **An entry is untrusted.** It is checked against its extension's own schema when this release knows that
  extension. Whatever is shown from it passes through `neutralise` and is flattened to one line, as §D2 requires
  of every string a profile gives.
- **Every other object keeps its strictness.** `extensions` is the only door.

### X2. The registry of known extensions

- **Core keeps one registry, in code.** Each entry gives:
  - the extension's name;
  - its schema;
  - whether a release may ignore it (`ignorable: true | false`);
  - a classifier that, given the before and after values, says whether a change tightens, loosens or changes who
    acts;
  - how it is applied to the record.
- **0.21.0 ships the mechanism with an empty registry.** Tests inject one. Later features add their entry in the same
  pull request as the feature.
- **The rule for `ignorable`:**
  - A field **may be ignored** when its absence leaves every other field meaning the same, and leaves this machine
    no looser.
  - A field **must be understood** when ignoring it would let the rest do more than intended. Examples are a limit on
    an app or a narrower `serves`. A field that changes who acts must be understood too.
  - Each registry entry's pull request states which applies, and why. That statement is a review item.
- **A known extension marked wrongly is refused.**
  - A profile that marks a must-understand extension `required: false` is refused with `BAD_DATA`. The message
    names the extension and says it must be marked required. The marker exists for older releases, so a release that
    knows the field holds the profile to it.
  - Marking an ignorable extension `required: true` is accepted: it is stricter than needed.

### X3. An entry this release does not know

**Optional (`required: false`):**
- It is not applied. The rest of the profile is.
- The record keeps it under `ignoredExtensions` as `{ "<name>": { "since": "<since>", "sha256": "<hex>" } }`. The
  SHA-256 is computed over the entry's canonical JSON: keys sorted, no whitespace.
- The preview, the result and `org show` each say `not applied here: <name> (needs <since> or later)`.
- When `since` is not later than the running release, the entry is one this release should know but does not, for
  example a typo or another fork. Then the words are `not applied here: <name> is not an extension this release
  knows`.

**Required (`required: true`):**
- Nothing from that profile is applied, and the last approved record stays exactly as it was.
- `org add` and `org update` refuse with a distinct error code and `exitCode` 1. The message reads:
  `<organisation>'s profile needs agent-communications <since> or later for "<name>": nothing was changed`.
- The hint says to update first, then run `org update` again. It names the update command through the handoff and
  locator, never a binary in a string.
- This is a refusal of that one command. No other tool is stopped (U1).

**`version` greater than 1:** from 0.21 this is refused with the same "update first" message, no longer zod's
`expected 1`. The hint says the release here is older than the profile, and does not say "ask your organisation".

**The hint for any other unknown key:** it now says that new fields go under `extensions`, and to ask the
organisation for its current profile.

### X4. A skipped entry is never applied as a repair

- When a later release understands an entry the record lists under `ignoredExtensions`, applying it is a **change**
  and never drift. This holds even when the profile's bytes and source are unchanged.
- The change is classified by the extension's own classifier:
  - a tightening applies at once;
  - a loosening, or a change of who acts, is approved first, and the preview shows it before → after.
- `ignoredExtensions` is kept in step with the profile:
  - an entry that disappears from the profile is dropped from it;
  - an entry whose SHA-256 changed is a changed profile, which needs approval anyway, because the bytes changed.
- In code: the unchanged-bytes branch that moves every change into `repairs` must leave out any change that comes
  from an entry the record lists as ignored.

### X5. The two companion files stay, frozen

- `<profile>.agent-app.json` and `<profile>.updates.json` keep their exact shapes, and are read as in 0.20.0.
- No new companion file is ever added: new fields go in `extensions`.
- A later release may fold them in as `extensions.agent-app` and `extensions.updates` once no member runs 0.20 or
  older. That is out of scope here.
- A profile must never carry both a companion file and the same setting as an extension. The release that folds them
  in refuses that.

### X6. A tighter update cap applies at once (owner, 2026-10-19)

**The order of `max`,** from tightest to loosest: `never`, then `every-14-days`, then no cap. `background: false` is
tighter than its absence.

**When `org update` finds the caps file changed:**
- **Only tighter** (a lower `max`, `background: false` added, or a new caps file that only adds caps): it applies at
  once, with its SHA-256 recorded, and needs no approval.
- **Beside a change that waits:** a tightening still applies at once, before the preview is returned, and the preview
  marks it done. This matches `--for-other-addresses off`.
- **Looser in any part** (a higher `max`, `background: false` removed, or the file removed): it is approved first, as
  today.
- **A mix of tighter and looser** counts as looser.

**`org add`** still approves everything, because it adds a profile.

**After a cap applies:** the member's level and background job follow it as U8 already says. A job the cap forbids
stops at its next run, with a notice.

### X7. What people see

- **`comms_org_add`, `comms_org_update` and `comms_org_show`** return, and their commands print,
  `extensions: { applied: string[], ignored: { name, since, reason }[] }`.
  - `reason` is `needs-newer` or `unknown`.
  - In 0.21 `applied` is always empty.
- **Doctor's organisation row** adds `<n> extension(s) not applied here: …` when the record lists any. That line is
  information: `ok` stays true.
- **No capability rows are added.** The `comms_org_*` rows in `capabilities.json` run again under
  `verify:parity --strict`.

### X8. Admins and members

**Admins:**
- Nothing to do now. Today's profiles are unchanged and stay valid.
- When a feature first needs an extension, its release notes say so.
- Members on 0.20.0 or older refuse **any** profile carrying `extensions`. They keep their last approved settings,
  and nothing stops, but they can't take the new profile until they update. So an admin should add an extension
  only once members run 0.21.0 or later.
- On the default `auto` level with background updates set up, members install a release about three days after it is
  published (U5).
- An admin who needs a member to have a field marks it `required: true`.

**Members:** a refused `org update` names the release to update to. After updating, they run `org update` again.

The organisation repository's README (§D10), `docs/upgrading.md`, `docs/getting-started.md` and the `comms-onboarding`
and `comms-update` skills each say this in their own words.

### X9. Amendments to the earlier designs

- **Organisation profiles, §D2:** a bullet after the companion-file bullet says that version 1 gained `extensions`
  from 0.21.0 under this design, and that every other object stays strict.
- **Organisation profiles, §D8:** two rows join the table:
  - "an entry listed as ignored is now understood": X4;
  - "the caps file only tightens": applied at once (X6).
- **Smoother updates, U8:** the last bullet ("This adds an optional field that older releases ignore") was never
  true. It is replaced with: the caps are in the companion file `<profile>.updates.json`, which releases before 0.20.0
  never open. A tighter cap applies at once, and a looser one is approved (this design, X6).

## 4. Tests

- **The 0.20.0 schema, frozen.** Add a fixture `packages/core/test/fixtures/profile-schema-0.20.0.ts`, as the 0.19.0
  one was made, covering the profile and both companion schemas. It must show two things:
  - a profile with `extensions` is refused by 0.20.0's schema (the one-generation cost, documented);
  - a profile without one is accepted by both releases.
- **Parsing:**
  - 17 entries are refused;
  - a bad name is refused;
  - an entry with no `required` or no `since` is refused;
  - a `since` that is not plain semver is refused;
  - an entry that is not an object is refused;
  - a document over 64 KiB is refused;
  - all of these with `BAD_DATA`, naming the field.
- **Unknown optional entries:**
  - the rest is applied;
  - `ignoredExtensions` is recorded with the right SHA-256;
  - the preview line appears, in both wordings (`needs-newer` and `unknown`).
- **Unknown required entries:**
  - nothing is written, and the configuration file is byte-identical afterwards;
  - the error code, message and hint match X3;
  - this is checked through both the CLI and MCP.
- **`version: 2`:** the "update first" wording appears, not zod's text.
- **A known extension marked wrongly** (an injected registry): refused. A required ignorable one: accepted.
- **The repair trap**, with injected registries standing for release N and release N+1:
  - release N approves a profile with an unknown optional entry;
  - release N+1, which knows it as loosening, gets approval required on `org update` with the same bytes, and nothing
    is applied before the yes;
  - with a tightening classifier it applies at once and is reported.
- **Caps:**
  - a tighter cap applies at once with no approval;
  - a tighter cap beside a waiting profile change is applied before the preview, which marks it done;
  - a looser cap, a removed file, and a mix all ask.
- **What must not change:** the existing companion-file and organisation tests pass unchanged, unless this design
  changes what they assert. Any change to an existing assertion is listed in the pull request.
- **Parity and guards:**
  - `pnpm verify:parity --strict`;
  - the root suite's guards: no binary named in a runtime string, and names through `lookupName`/`resolveName`.

## 5. Out of scope

- Any real extension, and folding in the companion files.
- Profiles fetched from a URL.
- Doctor remembering a required extension that was refused. The refusal itself tells the person, at the moment
  they run `org update`.

## 6. Risks

- **One generation pays once.** Members on 0.20.0 or older refuse a profile with `extensions`. It fails closed, keeps
  the record, and stops nothing. X8 tells admins to wait.
- **The registry has to be honest.** An extension wrongly declared ignorable could be skipped by an older release
  while it should restrict. X2 makes each declaration a review item. X4 means a skipped entry, once understood, is
  approved rather than slipped in.
- **The repair branch is where the trap would hide.** X4's test is the one that matters most. It must fail on the
  current code before the change.
