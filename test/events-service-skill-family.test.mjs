import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REGISTRY, skillFamilyOf } from '../scripts/channels.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVENTS_SKILLS = {
  prefix: 'agentcomms-',
  contract: 'skills/_shared/contract-events.md',
};

/**
 * A manifest-only checkout exercises the production registry without importing a fixture model of it. Services need
 * their declared entry and operations paths because `readService` verifies both before any registry view is derived.
 */
async function registryFixture() {
  const root = await tempDir('events-service-skills-');
  await cp(join(ROOT, 'scripts', 'channels.mjs'), join(root, 'scripts', 'channels.mjs'));
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

  await mkdir(join(root, 'skills', '_shared'), { recursive: true });
  await writeFile(join(root, EVENTS_SKILLS.contract), '# Event service fixture contract\n');
  return root;
}

async function registryAt(root) {
  const url = pathToFileURL(join(root, 'scripts', 'channels.mjs')).href;
  return import(`${url}?fixture=${encodeURIComponent(`${Date.now()}-${Math.random()}`)}`);
}

async function registryScript(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/channels.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function eventsManifest(root) {
  const path = join(root, 'packages', 'events-daemon', 'package.json');
  return { path, manifest: JSON.parse(await readFile(path, 'utf8')) };
}

async function writeEventsSkills(root, skills) {
  const { path, manifest } = await eventsManifest(root);
  await writeFile(
    path,
    `${JSON.stringify({
      ...manifest,
      agentcommsPackage: { ...manifest.agentcommsPackage, skills },
    })}\n`,
  );
}

async function addService(root, { directory, prefix }) {
  const target = join(root, 'packages', directory);
  await mkdir(join(target, 'src', 'mcp'), { recursive: true });
  await mkdir(join(target, 'src', 'operations'), { recursive: true });
  await writeFile(join(target, 'src', 'mcp', 'server.ts'), 'export function createDuplicateMcpServer() {}\n');
  await writeFile(
    join(target, 'package.json'),
    `${JSON.stringify(
      {
        name: `@agentcomms/${directory}`,
        version: '0.0.0',
        bin: { [`agent-${directory}`]: './dist/cli.mjs' },
        agentcommsPackage: {
          kind: 'service',
          binary: `agent-${directory}`,
          server: {
            defaultName: directory,
            entry: 'src/mcp/server.ts',
            factory: 'createDuplicateMcpServer',
          },
          operations: 'src/operations',
          skills: { prefix, contract: 'skills/_shared/contract-duplicate.md' },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'skills', '_shared', 'contract-duplicate.md'), '# Duplicate fixture contract\n');
}

test('B3-10: the event service declares its skill family without becoming a channel', async () => {
  const service = REGISTRY.services.find((entry) => entry.directory === 'events-daemon');
  assert.deepEqual(service?.declaration.skills, EVENTS_SKILLS);

  const family = REGISTRY.skillFamilies.find((entry) => entry.package === 'events-daemon');
  assert.deepEqual(family, {
    kind: 'service',
    package: 'events-daemon',
    family: 'agentcomms',
    prefix: 'agentcomms-',
    contract: 'skills/_shared/contract-events.md',
    readme: 'packages/events-daemon/README.md',
    foreign: [],
  });
  assert.equal(skillFamilyOf(REGISTRY, 'agentcomms-events')?.package, 'events-daemon');
  assert.equal(skillFamilyOf(REGISTRY, 'not-declared-skill'), undefined);

  // Mutation: making this service a channel would leak it into every channel-only view and this assertion turns red.
  for (const view of [
    REGISTRY.channels.map((entry) => entry.directory),
    REGISTRY.products.map((entry) => entry.channel),
    REGISTRY.platforms,
  ]) {
    assert.ok(!view.includes('events-daemon'), `events-daemon is not a channel: ${view.join(', ')}`);
  }

  // Mutation: adding a channel declaration to this service must refuse rather than leak it into channel-only views.
  const collision = await registryFixture();
  const { path, manifest } = await eventsManifest(collision);
  await writeFile(path, `${JSON.stringify({ ...manifest, agentcomms: { channel: 'events-daemon' } })}\n`);
  const result = await registryScript(collision);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /declares both "agentcomms" and "agentcommsPackage"/);
});

test('B3-10: the skills index includes the service contract without presenting a service as a channel', async () => {
  const index = await readFile(join(ROOT, 'docs', 'skills.md'), 'utf8');
  assert.match(index, /\*\*Events daemon service\*\* \(\[`_shared\/contract-events\.md`\]/);
  assert.match(index, /request-only service skills do not fall back to a CLI/);
  assert.doesNotMatch(index, /Events daemon(?: channel| platform)/i);
});

test('B3-10: service skill declarations are strict, discovered by their prefix, and cannot collide', async () => {
  const root = await registryFixture();
  await writeEventsSkills(root, EVENTS_SKILLS);
  const channels = await registryAt(root);
  const registry = channels.loadRegistry(root);
  assert.equal(channels.skillFamilyOf(registry, 'agentcomms-events')?.contract, EVENTS_SKILLS.contract);

  // Mutation: hard-code the production prefix instead of deriving it from the declaration.
  const alternate = { prefix: 'local-events-', contract: 'skills/_shared/contract-local-events.md' };
  await writeFile(join(root, alternate.contract), '# Alternate fixture contract\n');
  await writeEventsSkills(root, alternate);
  const alternateChannels = await registryAt(root);
  const alternateRegistry = alternateChannels.loadRegistry(root);
  assert.equal(
    alternateChannels.skillFamilyOf(alternateRegistry, 'local-events-safety')?.prefix,
    'local-events-',
    'a manifest-selected prefix must survive a hard-code mutant',
  );

  const validation = await registryFixture();
  const check = async (skills, pattern) => {
    await writeEventsSkills(validation, EVENTS_SKILLS);
    const fixtureChannels = await registryAt(validation);
    await writeEventsSkills(validation, skills);
    assert.throws(() => fixtureChannels.loadRegistry(validation), pattern);
  };
  // Mutation: remove declaration validation. Each malformed optional declaration must be refused at the source.
  await check(null, /"agentcommsPackage"\.skills must be an object/);
  await check([], /"agentcommsPackage"\.skills must be an object/);
  await check({ prefix: 'agentcomms-' }, /\.skills has no "contract"/);
  await check({ contract: EVENTS_SKILLS.contract }, /\.skills has no "prefix"/);
  await check({ ...EVENTS_SKILLS, unknown: true }, /\.skills has unknown key "unknown"/);
  await check({ ...EVENTS_SKILLS, prefix: 'not a prefix' }, /\.skills\.prefix must be a skill-name prefix/);
  await check(
    { ...EVENTS_SKILLS, contract: 'skills/_shared/contract-missing-events.md' },
    /\.skills\.contract .* is not a file/,
  );

  // Mutation: put `skills` on a non-service. A library is intentionally surface- and skill-family-free.
  await writeEventsSkills(validation, EVENTS_SKILLS);
  const libraryChannels = await registryAt(validation);
  const libraryPath = join(validation, 'packages', 'events', 'package.json');
  const library = JSON.parse(await readFile(libraryPath, 'utf8'));
  await writeFile(
    libraryPath,
    `${JSON.stringify({ ...library, agentcommsPackage: { ...library.agentcommsPackage, skills: EVENTS_SKILLS } })}\n`,
  );
  assert.throws(() => libraryChannels.loadRegistry(validation), /a library cannot declare "skills"/);

  const duplicate = await registryFixture();
  await writeEventsSkills(duplicate, EVENTS_SKILLS);
  const duplicateChannels = await registryAt(duplicate);
  await addService(duplicate, { directory: 'duplicate-service', prefix: EVENTS_SKILLS.prefix });
  assert.throws(() => duplicateChannels.loadRegistry(duplicate), /skill prefix "agentcomms-" is already declared/);
});
