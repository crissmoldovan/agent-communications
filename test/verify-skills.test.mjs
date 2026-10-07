import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const root = await tempDir('verify-skills-');
  await cp(path.join(repository, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  // The scripts read which channels there are from their manifests (`scripts/channels.mjs`), so those come too, with
  // every package they name.
  for (const entry of await readdir(path.join(repository, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = entry.name;
    await mkdir(path.join(root, 'packages', directory), { recursive: true });
    await cp(
      path.join(repository, 'packages', directory, 'package.json'),
      path.join(root, 'packages', directory, 'package.json'),
    );
    // A service's declaration names its server entry and operations directory, and the registry checks both exist.
    const manifest = JSON.parse(await readFile(path.join(repository, 'packages', directory, 'package.json'), 'utf8'));
    const service = manifest.agentcommsPackage?.kind === 'service' ? manifest.agentcommsPackage : null;
    if (service !== null) {
      for (const declared of [service.server.entry, service.operations]) {
        await cp(
          path.join(repository, 'packages', directory, declared),
          path.join(root, 'packages', directory, declared),
          {
            recursive: true,
          },
        );
      }
    }
  }
  await mkdir(path.join(root, 'skills', 'valid-skill', 'references'), { recursive: true });
  await writeFile(
    path.join(root, 'skills', 'valid-skill', 'SKILL.md'),
    '---\nname: valid-skill\ndescription: Valid fixture\n---\n',
  );
  await writeFile(
    path.join(root, 'skills', 'valid-skill', 'references', 'fit.json'),
    `${JSON.stringify({ version: 1, kind: 'general', useWhen: 'a fixture' }, null, 2)}\n`,
  );
  return root;
}

function verify(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/verify-skills.mjs'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('verifier ignores generated and temporary directories', async () => {
  const root = await fixture();
  for (const directory of [
    '.cache',
    '.next',
    '.tmp',
    '.turbo',
    '.vite',
    '.wrangler',
    'build',
    'coverage',
    'dist',
    'out',
    'tmp',
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
    const assignment = ['to', 'ken'].join('');
    const generatedToken = ['generated', 'token', 'value', '1234567890'].join('-');
    await writeFile(path.join(root, directory, 'generated.txt'), `${assignment} = "${generatedToken}"\n`);
  }

  const result = await verify(root);

  assert.equal(result.status, 0, result.stderr);
});

test('verifier rejects public machine-specific absolute paths', async () => {
  const root = await fixture();
  const personalPath = ['', 'Users', 'alice', 'private', 'catalog'].join('/');
  await writeFile(path.join(root, 'README.md'), `Install from ${personalPath}.\n`);

  const result = await verify(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md: contains a machine-specific absolute path/);
});

test('verifier accepts neutral credential fixtures', async () => {
  const root = await fixture();
  const assignment = ['to', 'ken'].join('');
  const neutralToken = ['not', 'a', 'real', 'secret'].join('-');
  await writeFile(
    path.join(root, 'README.md'),
    `# Fixture\n\nValid fixture\n\nSet ${assignment} = "${neutralToken}" in your local environment.\n`,
  );

  const result = await verify(root);

  assert.equal(result.status, 0, result.stderr);
});

test('verifier rejects realistic quoted credentials', async () => {
  const root = await fixture();
  const assignment = ['to', 'ken'].join('');
  const realisticToken = ['prod', 'token', 'value', '1234567890'].join('-');
  await writeFile(path.join(root, 'README.md'), `${assignment} = "${realisticToken}"\n`);

  const result = await verify(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md: contains a likely secret/);
});

test('verifier rejects a bare carried-file token the skill does not carry', async () => {
  const root = await fixture();
  const skill = path.join(root, 'skills', 'valid-skill');
  await writeFile(
    path.join(skill, 'SKILL.md'),
    '---\nname: valid-skill\ndescription: Valid fixture\n---\n\nSee references/missing.md for detail.\n',
  );

  const result = await verify(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /names a carried file the skill does not carry: references\/missing\.md/);
});

test('verifier accepts a carried-file token when the skill carries that exact file', async () => {
  const root = await fixture();
  const skill = path.join(root, 'skills', 'valid-skill');
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await writeFile(path.join(skill, 'references', 'present.md'), '# Present\n');
  await writeFile(
    path.join(skill, 'SKILL.md'),
    '---\nname: valid-skill\ndescription: Valid fixture\n---\n\nSee references/present.md for detail.\n',
  );

  const result = await verify(root);

  assert.equal(result.status, 0, result.stderr);
});

// The catalogue's build enforces the portable spec's frontmatter limits; a skill that passed
// here once went there with a 523-character compatibility and broke its build.
test('verifier holds frontmatter to the portable spec limits, in characters, after folding', async () => {
  const root = await fixture();
  const skill = path.join(root, 'skills', 'valid-skill', 'SKILL.md');
  const withFields = (fields) => writeFile(skill, `---\nname: valid-skill\n${fields}\n---\n`);
  const x = (n) => 'x'.repeat(n);

  await withFields(`description: Valid fixture\ncompatibility: "${x(500)}"`);
  assert.equal((await verify(root)).status, 0, 'exactly 500 characters is allowed');

  await withFields(`description: Valid fixture\ncompatibility: "${'—'.repeat(500)}"`);
  assert.equal((await verify(root)).status, 0, '500 em dashes are 500 characters, not 1500 bytes');

  await withFields(`description: Valid fixture\ncompatibility: "${x(501)}"`);
  let result = await verify(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /compatibility is 501 characters; the portable spec allows 500/);

  // A folded block: two 251-character lines join with one space into 503.
  await withFields(`description: Valid fixture\ncompatibility: >-\n  ${x(251)}\n  ${x(251)}`);
  result = await verify(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /compatibility is 503 characters/);

  await withFields(`description: ${x(1025)}`);
  result = await verify(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /description is 1025 characters; the portable spec allows 1024/);
});

test('verifier caps the SKILL.md body at 484 lines and admits a body of exactly 484', async () => {
  const frontmatter = '---\nname: valid-skill\ndescription: Valid fixture\n---\n';
  const body = (lines) => `${'body line\n'.repeat(lines)}`;

  const atCap = await fixture();
  await writeFile(path.join(atCap, 'skills', 'valid-skill', 'SKILL.md'), frontmatter + body(484));
  const admitted = await verify(atCap);
  assert.equal(admitted.status, 0, admitted.stderr);

  const overCap = await fixture();
  await writeFile(path.join(overCap, 'skills', 'valid-skill', 'SKILL.md'), frontmatter + body(485));
  const rejected = await verify(overCap);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /body is 485 lines; the cap is 484/);
});

test('verifier requires every skill to declare where it fits', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'skills', 'unfit-skill'), { recursive: true });
  await writeFile(
    path.join(root, 'skills', 'unfit-skill', 'SKILL.md'),
    '---\nname: unfit-skill\ndescription: No fit\n---\n',
  );

  const result = await verify(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unfit-skill\/SKILL\.md: no references\/fit\.json/);
});

test('verifier rejects a fit.json that does not parse, names an unknown kind, or declares no signal', async () => {
  const cases = [
    ['broken', '{ not json', /does not parse/],
    ['wrong-kind', JSON.stringify({ version: 1, kind: 'sometimes', useWhen: 'x' }), /kind must be one of/],
    ['no-use-when', JSON.stringify({ version: 1, kind: 'general' }), /needs a useWhen line/],
    [
      'empty-signals',
      JSON.stringify({ version: 1, kind: 'signals', useWhen: 'x', anyOf: [] }),
      /needs a non-empty anyOf or allOf/,
    ],
    [
      'unreadable-signal',
      JSON.stringify({ version: 1, kind: 'signals', useWhen: 'x', anyOf: [{ repo: { vibes: 'good' } }] }),
      /cannot read/,
    ],
  ];
  for (const [name, body, expected] of cases) {
    const root = await fixture();
    await mkdir(path.join(root, 'skills', name, 'references'), { recursive: true });
    await writeFile(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n`);
    await writeFile(path.join(root, 'skills', name, 'references', 'fit.json'), body);

    const result = await verify(root);

    assert.equal(result.status, 1, `${name} passed verification`);
    assert.match(result.stderr, expected);
  }
});

// --- Extensions for a repository that handles Google OAuth material ------------------------------------------

// The original pattern only matched `token = "…"`; in JSON the quote between key and colon defeated it, and those
// are exactly the shapes of a downloaded OAuth client file and a stored token file.
test('verifier rejects JSON-shaped Google credentials and Google token prefixes', async () => {
  const cases = [
    [
      'client-secret.json',
      `{"installed":{"${['client', 'secret'].join('_')}":"${['GOCSPX', 'x'.repeat(28)].join('-')}"}}\n`,
    ],
    ['refresh.json', `{"${['refresh', 'token'].join('_')}":"${['1', '', '0'].join('/')}${'A'.repeat(40)}"}\n`],
    ['access.md', `Authorization: Bearer ${['ya29', 'a'.repeat(40)].join('.')}\n`],
    ['api-key.md', `key=${'AI' + 'za'}${'B'.repeat(35)}\n`],
    ['quoted-secret.json', `{"${['client', 'secret'].join('_')}": "${'q'.repeat(24)}"}\n`],
  ];
  for (const [name, body] of cases) {
    const root = await fixture();
    await writeFile(path.join(root, name), body);

    const result = await verify(root);

    assert.equal(result.status, 1, `${name} passed verification`);
    assert.match(result.stderr, new RegExp(`${name.replace('.', '\\.')}: contains a likely secret`));
  }
});

test('verifier accepts placeholder values in JSON-shaped credentials', async () => {
  const root = await fixture();
  const key = ['client', 'secret'].join('_');
  const refresh = ['refresh', 'token'].join('_');
  await writeFile(
    path.join(root, 'fixture.json'),
    `${JSON.stringify({ [key]: 'not-a-real-secret', [refresh]: 'fake-refresh-token-1', other: '<your-client-secret>' })}\n`,
  );

  const result = await verify(root);

  assert.equal(result.status, 0, result.stderr);
});

// Codex refuses to load a skill whose metadata is a single string ("expected struct SkillFrontmatterMetadata").
test('verifier requires metadata to be a map of quoted-where-needed strings', async () => {
  const skill = async (metadata) => {
    const root = await fixture();
    await writeFile(
      path.join(root, 'skills', 'valid-skill', 'SKILL.md'),
      `---\nname: valid-skill\ndescription: Valid fixture\n${metadata}\n---\n`,
    );
    return verify(root);
  };

  let result = await skill('metadata: "group=communications; version=1.0.0"');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /metadata must be a YAML map/);

  result = await skill('metadata:\n  group: communications\n  version: 1.0');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /metadata\.version must be quoted/);

  result = await skill('metadata:\n  group: communications\n  version: "1.0.0"\n  author: someone');
  assert.equal(result.status, 0, result.stderr);

  result = await skill('metadata:\n  group: communications\n  version: 1.0.0');
  assert.equal(result.status, 0, 'a dotted version with two dots is read as a string by YAML');
});

test('verifier scans every package; no directory is exempt', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'packages', 'agent-lifecycle', 'src'), { recursive: true });
  const assignment = ['to', 'ken'].join('');
  await writeFile(
    path.join(root, 'packages', 'agent-lifecycle', 'src', 'leak.ts'),
    `const ${assignment} = "${['live', 'value', '1234567890'].join('-')}";\n`,
  );

  const result = await verify(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /leak\.ts: contains a likely secret/);
});

/*
 * Account names in the material a reader copies from.
 *
 * Both halves matter and they pull against each other: a flat name in a command is a command that cannot work on a
 * configuration made today, and a false positive on ordinary English would make the check something people turn off.
 * So the fixtures come in pairs, and the prose cases are the ones that were actually getting flagged.
 */
test('verifier rejects a flat account name in every position a reader would copy', async () => {
  const cases = [
    ['a command flag', 'Run `agent-gmail search x --inbox work`.'],
    ['a subcommand in a fenced block', '```sh\nagent-gmail inbox add work --email jo@example.test\n```'],
    ['a JSON field', '```json\n{ "inbox": "work" }\n```'],
    ['an argument object', "```js\ncreateGmailMcpServer({ inbox: 'work' })\n```"],
    ['an output row', '```text\nMESSAGE PREVIEW · inbox work · draft r_88 · nothing has been sent\n```'],
    ['a quoted name', '```text\nWrote it. Thread 18f2c9a0b1d4e5f6 in "work".\n```'],
    ['a compose profile file name', 'A mailbox reads `compose/inbox-work.md`.'],
    ['a nested download path', '```text\n~/Downloads/agent-communications/work/exports/plan.md\n```'],
    // Fences a simpler extractor missed: tildes, a longer outer fence, and an indented block.
    ['a tilde fence', '~~~sh\nagent-gmail inbox add work --email jo@example.test\n~~~'],
    ['a longer fence around a shorter one', '````md\n```sh\nagent-gmail inbox reauth work\n```\n````'],
    ['an indented block', 'Then:\n\n    agent-gmail inbox add work --email jo@example.test\n'],
    ['a two-backtick inline span', 'Run ``agent-gmail inbox add work`` to connect it.'],
    // Forms round 5 found still escaping: a fence on a list line, one indented inside a list, an indented block
    // past its first line, and a span that runs over a line break.
    ['a fence on a list-item line', '- Do this:\n\n  ```sh\n  agent-gmail inbox add work\n  ```\n'],
    ['a fence indented inside a list', '1. Then:\n\n    ```sh\n    agent-gmail inbox reauth work\n    ```\n'],
    ['the second line of an indented block', 'Then:\n\n    agent-gmail doctor\n    agent-gmail inbox add work\n'],
    [
      'an indented block continuing past a blank line',
      'Then:\n\n    agent-gmail doctor\n\n    agent-gmail inbox add work\n',
    ],
    ['a code span broken over a line', 'Run `agent-gmail\ninbox add work` to connect it.'],
    ['an unclosed fence', '```sh\nagent-gmail inbox add work\n'],
    // A version-1 alias is `[a-z0-9][a-z0-9-]{0,31}`: digits lead, and an English word is a legal name.
    ['an alias beginning with a digit', 'Run `agent-gmail search x --inbox 2024-archive`.'],
    ['an alias that is an English word', 'Run `agent-gmail search x --inbox and`.'],
    // The channels after Gmail and Slack name an account with `--account`, and manage it with `account add` (Resend)
    // or straight after the binary (WhatsApp). None of these was read, so `--account acme` passed.
    ['an account flag', 'Run `agent-resend domains --account acme`.'],
    ['an account flag with an equals sign', 'Run `agent-whatsapp chats --account=personal`.'],
    ['an account subcommand', '```sh\nagent-resend account add acme\n```'],
    ['an account shown by a flat name', '```sh\nagent-resend account policy acme --send-policy confirm\n```'],
    ['an account added straight after the binary', '```sh\nagent-whatsapp add personal\n```'],
    ['an account field', '```json\n{ "account": "acme" }\n```'],
    ['an account output row', '```text\nSEND PREVIEW · account acme · to jo@example.test\n```'],
  ];
  for (const [label, body] of cases) {
    const root = await fixture();
    await writeFile(path.join(root, 'skills', 'valid-skill', 'references', 'names.md'), `${body}\n`);
    const result = await verify(root);
    assert.equal(result.status, 1, `${label}: expected a failure\n${result.stdout}`);
    assert.match(result.stderr, /is a flat account name/, label);
  }
});

test('verifier passes organisation/platform names, and the prose that imitates a command', async () => {
  const cases = [
    ['a qualified name in a command', 'Run `agent-gmail search x --inbox acme/gmail-tech`.'],
    ['a qualified name in JSON', '```json\n{ "inbox": "acme/gmail" }\n```'],
    ['a nested download path', '```text\n~/Downloads/agent-communications/acme/gmail/exports/plan.md\n```'],
    ['an encoded profile file name', 'A mailbox reads `compose/inbox-acme__gmail.md`.'],
    ['a placeholder', 'Run `agent-gmail inbox add <organisation>/gmail --email <address>`.'],
    // The three that were flagged while this check was being written, all of them ordinary English.
    ['prose naming two subcommands', 'This skill covers the OAuth client, inbox add and reauth, and doctor.'],
    ['prose about a failure', 'When inbox add failed, read the flow id it printed.'],
    ['a risk flag that shares a word with an alias', 'Flags are `markup`, `archive` and `disk-image`.'],
    [
      'a list continuation, which is indented like code',
      '- A step.\n\n    When inbox add and reauth both fail, stop.\n',
    ],
    ['triple backticks quoted in prose', 'Write it as ``` ```sh ``` at the top.'],
    ['a span that would only match across a blank line', 'A stray ` here.\n\nAnd inbox add and reauth ` there.'],
    ['a spec, which records what was true then', '```sh\nagent-gmail inbox add work\n```'],
    ['a qualified account', 'Run `agent-resend domains --account acme/resend`.'],
    [
      'a qualified account added',
      '```sh\nagent-whatsapp add personal/whatsapp\nagent-resend account add acme/resend\n```',
    ],
    ['an account placeholder', 'Run `agent-resend account add <organisation>/resend`.'],
    ['prose about accounts', 'When account add fails, and account remove too, read what it printed.'],
  ];
  for (const [label, body] of cases) {
    const root = await fixture();
    const file =
      label === 'a spec, which records what was true then'
        ? path.join(root, 'docs', 'superpowers', 'specs', 'old.md')
        : path.join(root, 'skills', 'valid-skill', 'references', 'names.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${body}\n`);
    const result = await verify(root);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  }
});

/**
 * A channel's skills name that channel's accounts. `--account acme/gmail` in a Resend skill is a command that cannot
 * work — Resend refuses an account of another platform — and a reader copies it before finding out. Every channel's
 * skill family is checked against its own platform word, from the registry; the core's `comms-` skills manage every
 * channel, so they may name any.
 */
async function familySkill(root, name, body) {
  const skill = path.join(root, 'skills', name);
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n\n${body}\n`);
  await writeFile(
    path.join(skill, 'references', 'fit.json'),
    `${JSON.stringify({ version: 1, kind: 'general', useWhen: 'a fixture' }, null, 2)}\n`,
  );
}

test('verifier rejects an account of another platform in a channel skill', async () => {
  const cases = [
    ['a Gmail account in a Resend skill', 'resend-fixture', '```bash\nagent-resend domains --account acme/gmail\n```'],
    ['a suffixed one', 'resend-fixture', 'Run `agent-resend account add acme/gmail-tech`.'],
    [
      'a placeholder of another platform',
      'resend-fixture',
      'Run `agent-resend domains --account <organisation>/gmail`.',
    ],
    ['a JSON field', 'resend-fixture', '```json\n{ "account": "acme/slack" }\n```'],
    [
      'a Resend account in a WhatsApp skill',
      'whatsapp-fixture',
      '```bash\nagent-whatsapp chats --account personal/resend\n```',
    ],
    ['a WhatsApp add of another platform', 'whatsapp-fixture', '```bash\nagent-whatsapp add personal/resend\n```'],
    ['a Slack workspace in a Gmail skill', 'gmail-fixture', 'Run `agent-gmail search x --workspace acme/slack`.'],
    ['a word that is no platform at all', 'resend-fixture', 'Run `agent-resend domains --account acme/mail`.'],
  ];
  for (const [label, skill, body] of cases) {
    const root = await fixture();
    await familySkill(root, skill, body);
    const result = await verify(root);
    assert.equal(result.status, 1, `${label}: expected a failure\n${result.stdout}`);
    assert.match(
      result.stderr,
      new RegExp(`skills/${skill}/SKILL\\.md: ".+" is not a ${skill.split('-')[0]} account`),
      label,
    );
  }
  // The contract every skill of a family carries is the family's too.
  const root = await fixture();
  await mkdir(path.join(root, 'skills', '_shared'), { recursive: true });
  await writeFile(
    path.join(root, 'skills', '_shared', 'contract-resend.md'),
    '# Contract\n\nRun `agent-resend domains --account acme/whatsapp`.\n',
  );
  const result = await verify(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /skills\/_shared\/contract-resend\.md: "acme\/whatsapp" is not a resend account/);
});

test('verifier passes a channel skill’s own accounts, and any platform in the core’s skills', async () => {
  const cases = [
    ['its own account', 'resend-fixture', 'Run `agent-resend domains --account acme/resend`.'],
    ['its own, suffixed', 'resend-fixture', 'Run `agent-resend account add acme/resend-marketing`.'],
    ['its own placeholder', 'resend-fixture', 'Run `agent-resend account add <organisation>/resend`.'],
    ['a WhatsApp add', 'whatsapp-fixture', '```bash\nagent-whatsapp add personal/whatsapp\n```'],
    [
      'the core names every channel',
      'comms-fixture',
      'Pin one with `--account acme/gmail` or `--account acme/resend`.',
    ],
  ];
  for (const [label, skill, body] of cases) {
    const root = await fixture();
    await familySkill(root, skill, body);
    const result = await verify(root);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  }
});
