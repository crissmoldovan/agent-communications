import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL = 'skills/agentcomms-events/SKILL.md';

async function skillFixture() {
  const root = await tempDir('events-skill-safety-');
  await cp(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  await cp(join(ROOT, 'skills'), join(root, 'skills'), { recursive: true });
  await cp(join(ROOT, 'README.md'), join(root, 'README.md'));
  await cp(join(ROOT, 'capabilities.json'), join(root, 'capabilities.json'));
  await mkdir(join(root, 'packages'), { recursive: true });

  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(ROOT, 'packages', entry.name);
    const target = join(root, 'packages', entry.name);
    await mkdir(target, { recursive: true });
    await cp(join(source, 'package.json'), join(target, 'package.json'));
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const service = manifest.agentcommsPackage?.kind === 'service' ? manifest.agentcommsPackage : null;
    if (service !== null) {
      for (const path of [service.server.entry, service.operations]) {
        const destination = join(target, path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(source, path), destination, { recursive: true });
      }
    }
  }
  return root;
}

async function verify(root) {
  return new Promise((resolve, reject) => {
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
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function mutateSkill(replace) {
  const root = await skillFixture();
  const path = join(root, SKILL);
  const source = await readFile(path, 'utf8');
  const changed = replace(source);
  assert.notEqual(changed, source, 'the named mutant must change the production skill fixture');
  await writeFile(path, changed);
  return { root, result: await verify(root) };
}

test('B3-10: the declared event skill passes the production safety verifier', async () => {
  const result = await verify(ROOT);
  assert.equal(result.status, 0, result.stderr);
});

test('B3-10: the skill verifier refuses a missing safe workflow', async () => {
  const { result } = await mutateSkill((source) => source.replace('## Safe workflow', '## Workflow'));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*safe workflow/i);
});

test('B3-10: the skill verifier refuses a secret-request instruction', async () => {
  // Mutation: add a request for secret material. This must fail in the production verifier, not a test-local parser.
  const { result } = await mutateSkill((source) => `${source}\nAsk the person to paste a secret here.\n`);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*secret.*instruction/i);
});

test('B3-10: the skill verifier refuses a human-only command instruction', async () => {
  const { result } = await mutateSkill((source) => `${source}\nRun \`agent-events target resume\` now.\n`);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*human-only/i);
});

test('B3-10: the skill verifier requires every exact human-only handoff', async () => {
  const { result } = await mutateSkill((source) =>
    source.replace(
      'A person, not model context, decides to reopen a degraded target reset barrier.',
      'A person decides whether to resume the target.',
    ),
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*exact human-only handoff/i);
});

test('B3-10: the skill verifier requires the dry-run show handoff, not the retained rule test wording', async () => {
  const { result } = await mutateSkill((source) =>
    source.replace(
      'Retained sender content may be rendered only for a person at an interactive terminal/app, never in model context.',
      'Retained sender content may be selected only by a person outside model context.',
    ),
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*exact human-only handoff: Retained sender content may be rendered/i);
});

test('B3-10: the skill verifier derives every human-only handoff from the capability rows', async () => {
  // Mutation: reword one human-only row. A hard-coded handoff list would still pass the unchanged skill.
  const root = await skillFixture();
  const path = join(root, 'capabilities.json');
  const capabilities = JSON.parse(await readFile(path, 'utf8'));
  const row = capabilities.capabilities.find((entry) => entry.id === 'events-daemon.held.decide');
  assert.ok(row, 'the held-decide exception row exists');
  row.reason = 'A held model decision is resolved only by a person at the terminal or app.';
  await writeFile(path, `${JSON.stringify(capabilities, null, 2)}\n`);
  const result = await verify(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*exact human-only handoff: A held model decision is resolved only/i);
});

test('B3-10: the skill verifier refuses a stale event tool', async () => {
  // Mutation: name a tool that the service has not registered.
  const { result } = await mutateSkill((source) => `${source}\nCall \`events_stale_tool\` now.\n`);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*not a registered MCP tool/i);
});

test('B3-10: the skill verifier requires the plain and enveloped explanation', async () => {
  const { result } = await mutateSkill((source) =>
    source.replace('leaves each sanitised string as it is', 'changes strings'),
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*plain.*enveloped/i);
});

test('B3-10: the skill verifier requires the judge-off and approval handoffs', async () => {
  const { result } = await mutateSkill((source) =>
    source
      .replace('Every judge kind is off until a person enables it.', 'Judge status is available.')
      .replace('## Approval handoff', '## Approval'),
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /agentcomms-events.*judge.*off/i);
  assert.match(result.stderr, /agentcomms-events.*approval handoff/i);
});
