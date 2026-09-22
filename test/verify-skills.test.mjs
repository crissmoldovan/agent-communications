import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const root = await tempDir('verify-skills-');
  await cp(path.join(repository, 'scripts'), path.join(root, 'scripts'), { recursive: true });
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
    // A version-1 alias is `[a-z0-9][a-z0-9-]{0,31}`: digits lead, and an English word is a legal name.
    ['an alias beginning with a digit', 'Run `agent-gmail search x --inbox 2024-archive`.'],
    ['an alias that is an English word', 'Run `agent-gmail search x --inbox and`.'],
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
    ['a spec, which records what was true then', '```sh\nagent-gmail inbox add work\n```'],
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
