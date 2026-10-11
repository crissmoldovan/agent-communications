import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REGISTRY, skillFamilyOf } from '../scripts/channels.mjs';

/**
 * Each skill carries its own platform's contract, and nothing from another platform's.
 *
 * The three Slack skills shipped with the Gmail contract copied into them word for word: an agent following
 * `slack-reading` was told to call `gmail_inboxes_list`, that only `gmail-send` sends, and to fall back to
 * `npx @agentcomms/gmail` when the Slack tools were missing. `sync-skills --check` passed, because the copies
 * matched their source — the source was simply the wrong one. This checks the thing that was wrong.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILLS = join(ROOT, 'skills');

/**
 * What one platform's skills must never name, because it belongs to another: every other channel's tools, commands,
 * packages and skills, derived from the channel registry — so a new channel's skills are checked against every other
 * channel's words, and every other channel's against its, without an entry here. The core's `comms-` skills manage
 * every channel, and may name any.
 */
const FOREIGN = Object.fromEntries(REGISTRY.skillFamilies.map((family) => [family.family, family.foreign]));

/**
 * Words beyond another channel's names that a platform's skills must not use: a Slack skill that says "mailbox" has
 * been copied from a Gmail one. Gmail's may say "workspace" — Google Workspace is a thing a mailbox belongs to.
 */
const ALSO_FOREIGN = { slack: [/\bmailbox(es)?\b/i] };

async function skills() {
  return (await readdir(SKILLS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

test("every skill belongs to a declared family, and carries that family's contract", async () => {
  for (const name of await skills()) {
    // An unknown prefix used to be `?? []` below: a skill of a platform nobody listed was simply not checked.
    const family = skillFamilyOf(REGISTRY, name);
    assert.ok(family, `${name}: no declared family has skills starting "${name.split('-')[0]}-"`);
    const source = await readFile(join(ROOT, family.contract), 'utf8');
    const copy = await readFile(join(SKILLS, name, 'references', 'contract.md'), 'utf8');
    assert.equal(copy, source, `${name} should carry ${family.contract}`);
  }
});

test('the words each family must not use include every other channel’s tools, commands and packages', () => {
  const words = (family) => FOREIGN[family].map(String).join(' ');
  assert.match(words('gmail'), /slack_/);
  assert.match(words('gmail'), /agent-slack/);
  assert.match(words('slack'), /gmail_/);
  assert.match(words('slack'), /agent-gmail/);
  assert.match(words('slack'), /gmail-send/);
  assert.deepEqual(FOREIGN.comms, []);
});

test('no skill names another platform’s tools, commands or package', async () => {
  const offenders = [];
  for (const name of await skills()) {
    const platform = skillFamilyOf(REGISTRY, name)?.family;
    assert.ok(platform, `${name} belongs to no channel`);
    const directory = join(SKILLS, name);
    for (const file of await readdir(directory, { recursive: true })) {
      if (!file.endsWith('.md')) continue;
      const text = await readFile(join(directory, file), 'utf8');
      for (const pattern of [...FOREIGN[platform], ...(ALSO_FOREIGN[platform] ?? [])]) {
        const found = pattern.exec(text);
        if (found) offenders.push(`skills/${name}/${file}: ${found[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a skill that borrows another platform's words:\n${offenders.join('\n')}`);
});

test('the Gmail Cloud walkthrough acknowledges organisation-provided clients', async () => {
  const guide = await readFile(join(SKILLS, 'gmail-setup', 'references', 'google-cloud-setup.md'), 'utf8');
  assert.doesNotMatch(guide, /There is no shared client to borrow\./);
  assert.match(guide, /organisation.*provide.*client/is);
  assert.match(guide, /organisation profile/i);
});

test('Slack setup documents profile apps and own apps as distinct paths', async () => {
  const cases = [
    {
      file: '_shared/contract-comms.md',
      required: [
        /organisation profile.*read.*send.*apps/is,
        /own app.*manifest|own app.*api\.slack\.com/is,
        /do not ask.*edit or uninstall.*organisation apps/is,
      ],
    },
    {
      file: '_shared/contract-slack.md',
      required: [/organisation provenance.*signing.*other app.*profile/is, /own app.*manifest/is, /own app.*remov/is],
    },
    {
      file: 'comms-onboarding/SKILL.md',
      required: [
        /Gmail picks the eligible client before consent/,
        /Slack.*automatically.*profile.*read.*send/is,
        /slack_workspace_add.*rgc\/slack/is,
        /agent-slack workspace add rgc\/slack/,
      ],
    },
    {
      file: 'slack-setup/SKILL.md',
      required: [
        /profile.*read app.*send app/is,
        /read.*send.*profile.*sign.in/is,
        /send.*read.*profile.*sign.in/is,
        /own.app.*manifest/is,
        /own.app.*remov/is,
        /administrator.*approve.*app/is,
        /cancel.*finish/is,
        /pending.*access.*refresh/is,
        /doctor.*retr/is,
      ],
    },
  ];

  for (const { file, required } of cases) {
    const prose = await readFile(join(SKILLS, file), 'utf8');
    for (const pattern of required) assert.match(prose, pattern, `${file}: missing ${pattern}`);
    assert.doesNotMatch(
      prose,
      /not used by `slack_workspace_add` yet|comes in a later release|`workspace add` does not use the profile by itself/i,
      `${file}: stale release promise`,
    );
  }

  for (const file of ['comms-onboarding/SKILL.md', 'slack-setup/SKILL.md']) {
    const prose = await readFile(join(SKILLS, file), 'utf8');
    const profiles = [...prose.matchAll(/^.*agent-slack workspace add rgc\/slack.*$/gm)].map(([line]) => line);
    assert.ok(profiles.length > 0, `${file}: profile CLI example is missing`);
    for (const profile of profiles) {
      assert.doesNotMatch(profile, /--client-id|--port/, `${file}: profile CLI example must select its app and port`);
    }
    const ownApp = prose.match(/^.*agent-slack workspace add (?:acme\/slack|<name>).*--client-id.*$/m)?.[0];
    assert.ok(ownApp, `${file}: own-app CLI example is missing`);
    assert.match(ownApp, /--client-id\s+\S+.*--port\s+\S+/, `${file}: own-app example needs client id and port`);
  }
});

test('Slack mode guidance keeps each account path and consent step in its own section', async () => {
  const setup = await readFile(join(SKILLS, 'slack-setup', 'SKILL.md'), 'utf8');
  const onboarding = await readFile(join(SKILLS, 'comms-onboarding', 'SKILL.md'), 'utf8');

  function between(text, start, end, label) {
    const from = text.indexOf(start);
    assert.notEqual(from, -1, `${label}: start marker missing`);
    const to = text.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `${label}: end marker missing`);
    return text.slice(from + start.length, to);
  }

  const send = between(setup, '## Moving a workspace to `send`', '## Going back to `read`', 'send mode');
  const read = between(setup, '## Going back to `read`', '## Removing a workspace', 'read mode');
  const cases = [
    {
      label: 'profile read to send',
      text: between(send, 'For an account with organisation provenance', "For a person's own app", 'profile send'),
      required: [
        /profile's send app/i,
        /send app after approval/i,
        /Slack consent/i,
        /slack_workspace_finish/,
        /No manifest edit.*app update.*--app-updated/is,
      ],
    },
    {
      label: 'own-app read to send',
      text: between(send, "For a person's own app", 'If Slack grants no posting scope', 'own-app send'),
      required: [
        /manifest.*`send`/is,
        /--app-updated/,
        /change approval/i,
        /approves that in\s+Slack/i,
        /slack_workspace_finish/,
      ],
    },
    {
      label: 'profile send to read',
      text: between(read, 'For an account with organisation provenance', "For a person's own app", 'profile read'),
      required: [
        /starts immediately through the profile's read app/i,
        /Slack consent/i,
        /slack_workspace_finish/,
        /no\s+change approval, manifest replacement, or app removal/i,
      ],
    },
    {
      label: 'own-app send to read',
      text: between(read, "For a person's own app", 'For an own-app account', 'own-app read'),
      required: [
        /replace the app's manifest with the `read` one/i,
        /Remove app/i,
        /workspace reauth.*--mode read/i,
        /Slack consent/i,
      ],
    },
    {
      label: 'onboarding direct profile move',
      text: between(
        onboarding,
        '- **Slack, with an organisation profile added:**',
        '- **Slack, without one:**',
        'onboarding profile',
      ),
      required: [
        /moves the account\s+directly between the profile's read and send apps through another sign-in/i,
        /neither app is edited/i,
      ],
    },
  ];

  for (const { label, text, required } of cases) {
    for (const pattern of required) assert.match(text, pattern, `${label}: missing ${pattern}`);
  }
});

test('every channel contract says a command for a person is the one a result gives, or why there is none (CUE-403)', async () => {
  // From the registry: a new channel's contract has to say it from its first commit.
  for (const family of REGISTRY.skillFamilies.filter((family) => family.kind !== 'service')) {
    const prose = (await readFile(join(ROOT, family.contract), 'utf8')).replace(/\s+/g, ' ');
    const required = [
      /## \d+\. A command for a person is the one a result gives\./,
      // The first outcome: the command itself, handed over as given.
      /Hand it over exactly as given/,
      /Never write one yourself/,
      // The second: words to type, on Windows.
      /words as JSON/,
      /C:\\Program Files/,
      // The third: none here, said, and no command put in its place.
      /not locatable here/,
      /installs or updates it the way they usually do/,
    ];
    for (const pattern of required) assert.match(prose, pattern, `${family.contract}: missing ${pattern}`);
  }
});

test('WhatsApp’s person-only commands are handed over as words, never as a bare command line (CUE-403)', async () => {
  // `add`, `remove`, `allow`, `deny` and `clear` have no tool and refuse an agent: a person runs them with the WhatsApp
  // CLI as this installation has it. A skill gives the words, never `agent-whatsapp …` as a line to paste.
  const contract = await readFile(join(ROOT, 'skills', '_shared', 'contract-whatsapp.md'), 'utf8');
  const reading = await readFile(join(SKILLS, 'whatsapp-reading', 'SKILL.md'), 'utf8');
  for (const [name, text] of [
    ['contract-whatsapp.md', contract],
    ['whatsapp-reading', reading],
  ]) {
    assert.doesNotMatch(text, /agent-whatsapp (?:add|remove|allow|deny|clear)\b/, name);
    assert.match(text.replace(/\s+/g, ' '), /`deny \+15555550102 --account personal\/whatsapp`/, name);
  }
});

// ── What an approval asks of an agent (CUE-404) ──────────────────────────────────────────────────────────────────

/*
 * Design 2026-10-05 §D1–§D3 and §D8, and plan decision 10: there is no harness that runs an agent through a skill, so
 * what a skill must teach is held here as text. Each family's rules are derived, not listed: a channel whose manifest
 * names an `approve` hands a person approvals, so its skills say what to do with one; a channel whose accounts can
 * `send` also says what a send's outcome is. The tools come from `capabilities.json` — each channel's own wait and
 * revoke, or the core's where it has none — so a new channel is held to its own from its first commit.
 */

const CAPABILITIES = JSON.parse(readFileSync(join(ROOT, 'capabilities.json'), 'utf8')).capabilities;
const manifestOf = (family) => REGISTRY.channels.find((channel) => channel.directory === family.channel)?.manifest;
/** The tools of `channel`'s rows that run `operation`. */
const toolsOf = (operation, channel) =>
  CAPABILITIES.filter((row) => row.operation === operation && row.package === channel && row.mcp).map((row) => row.mcp);
/** The commands of the same rows, as a person or an agent writes them: `<binary> <words>`. */
const commandsOf = (operation, channel) => {
  const binary = REGISTRY.channels.find((each) => each.directory === channel)?.manifest.binary;
  return CAPABILITIES.filter((row) => row.operation === operation && row.package === channel && row.cli).map(
    (row) => `${binary} ${row.cli}`,
  );
};
/** A family's wait: its channel's own, or the core's for a channel with none (WhatsApp). */
const waitsOf = (family) =>
  toolsOf('waitForApproval', family.channel).length > 0
    ? toolsOf('waitForApproval', family.channel)
    : toolsOf('waitForApproval', 'core');
/** A family's revokes: the core's, which takes any kind, and its channel's own where it has one (Gmail's cancel). */
const revokesOf = (family) => [
  ...new Set([...toolsOf('revokeApproval', 'core'), ...toolsOf('revokeApproval', family.channel)]),
];

/** Every family whose channel hands a person approvals; and of those, every one whose accounts can send. */
const APPROVING = REGISTRY.skillFamilies.filter((family) => manifestOf(family)?.approve);
const SENDING = APPROVING.filter((family) => manifestOf(family)?.accounts?.modes?.includes('send'));

/** Prose wraps, so a rule is read across its line breaks. */
const flat = (text) => text.replace(/\s+/g, ' ');
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const named = (word) => new RegExp(`\`${escapeRegExp(word)}\``);

/** What every approving family's contract says of an approval: a no is revoked at once, waits, and how long. */
function approvalRules(family) {
  return [
    ['a no is revoked at once', /When the person says no, revoke it at once/],
    ['why: the server cannot hear a no', /cannot hear a "no"/],
    ...revokesOf(family).map((tool) => [`the revoke ${tool}`, named(tool)]),
    ['repeated default-length waits', /repeated default-length waits/],
    ...waitsOf(family).map((tool) => [`the wait ${tool}`, named(tool)]),
    ['`claimable`', /`claimable`/],
    ['ten minutes on the chat route', /ten minutes/],
    ['thirty minutes on the confirm route', /thirty minutes/],
    ['24 hours once approved', /24 hours/],
  ];
}

/** What a sending family's contract says of a send's outcome (§D2, §D8). */
const SEND_RULES = [
  ['never prepare while sending', /Never prepare again while a send is `sending`/],
  ['another call is sending it', /being sent by another call/],
  ['branch on SEND_OUTCOME_UNKNOWN', /branch on `SEND_OUTCOME_UNKNOWN`/],
  ['`unknown`', /`unknown`/],
  ['a late result is still possible', /late result/],
  ['check before anything else', /\bcheck\b[^.]*before anything else/i],
  ['never prepare automatically', /never prepare it again automatically/i],
  ['the no-id wording', /"sent; the provider returned no id"/],
  ['never a message id without an id', /Never say "sent, message id …" without an id/],
  ['`corrupt` is said', /`corrupt` is said, never skipped/],
];

/** What Resend's contract says of a scheduled send (§D2, §D8; §5 R23f). */
const RESEND_RULES = [
  ['the scheduled no-id wording', /"accepted \(scheduled\); the provider returned no id"/],
  ['scheduled is not sent', /Never call a scheduled email sent until Resend's own outcome says it went/],
  ['its outcome is attributed', /`outcome`/],
];

/** Every skill directory of `family`, with its rendered contract. */
async function renderedContracts(family) {
  const found = [];
  for (const skill of await skills()) {
    if (!skill.startsWith(family.prefix)) continue;
    found.push({ skill, prose: flat(await readFile(join(SKILLS, skill, 'references', 'contract.md'), 'utf8')) });
  }
  return found;
}

test('the families held to the approval rules are every channel’s that hands out approvals (CUE-404)', () => {
  // Every channel names an `approve`, so every skill family is held to the rules; and some can send.
  assert.equal(APPROVING.length, REGISTRY.skillFamilies.filter((family) => family.kind !== 'service').length);
  assert.ok(SENDING.length > 0, 'a sending family is read');
  const coreWait = toolsOf('waitForApproval', 'core');
  const coreRevoke = toolsOf('revokeApproval', 'core');
  assert.equal(coreWait.length, 1, "core's wait is a capability row");
  assert.equal(coreRevoke.length, 1, "core's revoke is a capability row");
  for (const family of APPROVING) {
    // A family's wait is its channel's own, or core's where it has none; its revokes are core's and its own.
    const own = toolsOf('waitForApproval', family.channel);
    assert.deepEqual(waitsOf(family), own.length > 0 ? own : coreWait, family.family);
    for (const tool of [...coreRevoke, ...toolsOf('revokeApproval', family.channel)]) {
      assert.ok(revokesOf(family).includes(tool), `${family.family}: ${tool}`);
    }
  }
  // Every sending family has a wait of its own: an agent waits on the surface that sent.
  for (const family of SENDING) assert.ok(toolsOf('waitForApproval', family.channel).length > 0, family.family);
});

test('every rendered contract of a family that hands out approvals says a no is revoked at once, how to wait, and how long an approval lasts (CUE-404, §5 D1rr-b)', async () => {
  const read = [];
  const missing = [];
  for (const family of APPROVING) {
    for (const { skill, prose } of await renderedContracts(family)) {
      read.push(skill);
      for (const [label, pattern] of approvalRules(family)) {
        if (!pattern.test(prose)) missing.push(`skills/${skill}/references/contract.md: ${label}`);
      }
    }
  }
  // The two setup skills hold change approvals; each carries its channel's rule through its rendered contract.
  for (const skill of ['gmail-setup', 'slack-setup', 'gmail-send', 'slack-posting', 'resend-sending', 'comms-update']) {
    assert.ok(read.includes(skill), `${skill}'s rendered contract is read`);
  }
  // Every skill that lacks a rule is named, so a contract missing one names gmail-setup or slack-setup among them.
  assert.deepEqual(missing, [], `a rendered contract without its approval rules:\n${missing.join('\n')}`);
});

test('every rendered contract of a sending family says what a send’s outcome is, and never to prepare it again on doubt (CUE-404, §5 D2pt-k, D2-i)', async () => {
  const missing = [];
  for (const family of SENDING) {
    const rules = family.family === 'resend' ? [...SEND_RULES, ...RESEND_RULES] : SEND_RULES;
    for (const { skill, prose } of await renderedContracts(family)) {
      for (const [label, pattern] of rules) {
        if (!pattern.test(prose)) missing.push(`skills/${skill}/references/contract.md: ${label}`);
      }
    }
  }
  assert.deepEqual(missing, [], `a rendered contract without its send rules:\n${missing.join('\n')}`);
});

/**
 * The skill of a sending family that sends, where a send's refusals are taught in a table: the one whose name, after
 * its family's prefix, starts with "send" or "post" (`gmail-send`, `resend-sending`, `slack-posting`). A sending
 * channel has exactly one, or the test fails.
 */
async function sendSkillOf(family) {
  const found = (await skills()).filter(
    (skill) => skill.startsWith(family.prefix) && /^(?:send|post)/.test(skill.slice(family.prefix.length)),
  );
  assert.equal(found.length, 1, `${family.family} sends: exactly one of its skills is named for sending or posting`);
  return found[0];
}

test('each send skill branches on SEND_OUTCOME_UNKNOWN, waits rather than asks, and revokes a no (CUE-404, §5 D2-i, D2pt-k, R23f)', async () => {
  for (const family of SENDING) {
    const skill = await sendSkillOf(family);
    const text = await readFile(join(SKILLS, skill, 'SKILL.md'), 'utf8');
    const prose = flat(text);
    const where = `skills/${skill}/SKILL.md`;
    // A row of the refusal table, keyed by the code, that never prepares again.
    assert.match(
      text,
      /^[ \t]*\|[ \t]*`SEND_OUTCOME_UNKNOWN`[^\n]*(?:never|do not) prepare/im,
      `${where}: SEND_OUTCOME_UNKNOWN row`,
    );
    assert.match(prose, /being sent by another call/, `${where}: the sending row`);
    assert.match(prose, /Never prepare again while a send is `sending`/, `${where}: never prepare while sending`);
    assert.match(prose, /"sent; the provider returned no id"/, `${where}: the no-id wording`);
    assert.match(prose, /When the person says no, revoke it at once/, `${where}: a no is revoked at once`);
    for (const tool of [...waitsOf(family), ...revokesOf(family)])
      assert.match(prose, named(tool), `${where}: ${tool}`);
    for (const command of commandsOf('waitForApproval', family.channel)) {
      assert.match(prose, new RegExp(escapeRegExp(command)), `${where}: ${command}`);
    }
    assert.match(prose, /repeated default-length waits/, `${where}: repeated default-length waits`);
    if (family.family === 'resend') {
      assert.match(
        prose,
        /"accepted \(scheduled\); the provider returned no id"/,
        `${where}: the scheduled no-id wording`,
      );
      assert.match(prose, /Never call a scheduled email sent until Resend's own outcome says it went/, where);
    }
  }
});

test('the setup skills’ change-approval procedures revoke a no at once, by tool and by command (CUE-404, plan task 25)', async () => {
  // The two skills whose own procedures hold change approvals, each read from its start marker to its end.
  const cases = [
    {
      skill: 'gmail-setup',
      start: "- **Safety settings need a person's yes.**",
      end: '- **Every skill works without the MCP server.**',
    },
    { skill: 'slack-setup', start: '## How a change is approved', end: '## Connecting it to your agent' },
  ];
  const coreRevoke = commandsOf('revokeApproval', 'core');
  assert.deepEqual(coreRevoke, ['agentcomms approvals revoke']);
  for (const { skill, start, end } of cases) {
    const family = skillFamilyOf(REGISTRY, skill);
    const file = `${skill}/SKILL.md`;
    const text = await readFile(join(SKILLS, file), 'utf8');
    const from = text.indexOf(start);
    assert.notEqual(from, -1, `${file}: the procedure is there`);
    const to = text.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `${file}: the procedure ends`);
    const procedure = flat(text.slice(from, to));
    assert.match(procedure, /When the person says no, revoke it at once/, `${file}: a no is revoked at once`);
    for (const tool of revokesOf(family)) assert.match(procedure, named(tool), `${file}: ${tool}`);
    for (const command of coreRevoke)
      assert.match(procedure, new RegExp(`${escapeRegExp(command)} <`), `${file}: ${command}`);
  }
});

test('no skill or guide says a client is known to reach a person: a client is one the person chose to trust (CUE-404, §D5)', async () => {
  const files = [];
  for (const entry of await readdir(SKILLS, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(entry.parentPath, entry.name));
  }
  for (const entry of await readdir(join(ROOT, 'docs'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(ROOT, 'docs', entry.name));
  }
  files.push(join(ROOT, 'README.md'), join(ROOT, 'SECURITY.md'));
  const wrong = [];
  for (const file of files) {
    const found = /known to reach a (?:person|human)/i.exec(flat(await readFile(file, 'utf8')));
    if (found) wrong.push(`${file.replace(ROOT, '')}: ${found[0]}`);
  }
  assert.deepEqual(wrong, [], `a client said to be known to reach a person:\n${wrong.join('\n')}`);
});
