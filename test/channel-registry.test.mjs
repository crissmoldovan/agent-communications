import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadRegistry, REGISTRY } from '../scripts/channels.mjs';
import { snapshotSource } from '../scripts/sync-channels.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

/**
 * One registry of channels for every tool in this repository (design 2026-09-26, step 2).
 *
 * Which channels exist was written down about eleven times — the publish list, the licence script, the parity
 * surfaces and drivers, the reference generator, the version sync, the skill contracts and four tests — and a new
 * channel had to be added to each by hand, or was silently not checked. They all read `scripts/channels.mjs` now,
 * which derives the list from each channel's own manifest. This proves it the way it would fail: a channel package
 * nobody has told any of them about is dropped into a copy of the repository, and every consumer finds it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);

/** A channel as a new package would declare it — the manifest a Resend or WhatsApp package adds, and nothing else. */
function newcomerManifest(version) {
  return {
    name: '@agentcomms/newcomer',
    version,
    type: 'module',
    license: 'MIT',
    bin: { 'agent-newcomer': './dist/cli.mjs' },
    dependencies: { '@agentcomms/core': 'workspace:*' },
    agentcomms: {
      contract: 1,
      channel: 'newcomer',
      label: 'Newcomer',
      binary: 'agent-newcomer',
      server: { defaultName: 'newcomer', npxPackage: '@agentcomms/newcomer', npxArgs: ['mcp'] },
      accounts: {
        map: 'accounts',
        noun: 'account',
        modes: ['read', 'send'],
        guarantee: { ceiling: 'grant', floor: 'code', why: 'The platform has no read-only credential.' },
      },
      narrowing: [{ option: 'account', flag: '--account', kind: 'pin' }],
      rivals: { word: 'newcomer', can: 'send through Newcomer' },
      hosts: ['api.newcomer.test'],
      approve: 'agent-newcomer approve',
      skills: { prefix: 'newcomer-', contract: 'skills/_shared/contract-newcomer.md' },
    },
  };
}

/**
 * A library as a new one would declare itself (design 2026-10-05, D14): published, so not private, and nothing but the
 * declaration — no channel manifest, no command, no server. `extra` adds or replaces fields.
 */
function libraryManifest(version, extra = {}) {
  return {
    name: '@agentcomms/shelf',
    version,
    type: 'module',
    license: 'MIT',
    agentcommsPackage: { kind: 'library' },
    ...extra,
  };
}

/** A copy of the repository's tooling, manifests and skills — no source, no dependencies. */
async function repositoryCopy(prefix) {
  const root = await tempDir(prefix);
  for (const path of [
    'package.json',
    'README.md',
    'scripts',
    'skills',
    '.claude-plugin',
    'gemini-extension.json',
    'bin',
  ]) {
    await cp(join(ROOT, path), join(root, path), { recursive: true });
  }
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await mkdir(join(root, 'packages', entry.name), { recursive: true });
    await cp(join(ROOT, 'packages', entry.name, 'package.json'), join(root, 'packages', entry.name, 'package.json'));
  }
  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  return { root, version };
}

/** The repository copy with a library, `packages/shelf`, dropped into it — held back from release when `held`. */
async function treeWithLibrary({ held = false, extra = {} } = {}) {
  const { root, version } = await repositoryCopy('library-registry-');
  const hold = held ? { agentcommsRelease: { hold: 'Held until something depends on it.' } } : {};
  await mkdir(join(root, 'packages', 'shelf'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'shelf', 'package.json'),
    `${JSON.stringify(libraryManifest(version, { ...hold, ...extra }), null, 2)}\n`,
  );
  return { root, version };
}

/** The repository copy with a newcomer channel in it. */
async function treeWithNewcomer() {
  const { root, version } = await repositoryCopy('channel-registry-');
  await mkdir(join(root, 'packages', 'newcomer'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'newcomer', 'package.json'),
    `${JSON.stringify(newcomerManifest(version), null, 2)}\n`,
  );
  await writeFile(
    join(root, 'skills', '_shared', 'contract-newcomer.md'),
    '# Newcomer contract\n\nName the account.\n',
  );
  await mkdir(join(root, 'skills', 'newcomer-reading', 'references'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'newcomer-reading', 'SKILL.md'),
    `---\nname: newcomer-reading\ndescription: "Read a Newcomer account. Symptoms: what came in."\ncompatibility: "@agentcomms/newcomer@${version}"\n---\n`,
  );
  return { root, version };
}

const run = async (root, script, args = []) => {
  const { stdout } = await exec(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root });
  return stdout;
};

test('a channel package dropped into the tree is discovered by every consumer of the registry', async () => {
  const { root, version } = await treeWithNewcomer();

  // Every channel this checkout ships, and the newcomer among them in its place.
  const shipped = REGISTRY.channels.map((channel) => channel.directory);
  const every = ['core', ...[...shipped.filter((channel) => channel !== 'core'), 'newcomer'].sort()];
  const others = shipped.filter((channel) => channel !== 'core');

  // The registry itself, and the two scripts a shell reads it through.
  assert.equal((await run(root, 'channels.mjs')).trim(), every.join(' '));
  const published = (await run(root, 'packages.mjs')).trim().split(' ');
  assert.ok(published.includes('newcomer'), 'published');
  assert.ok(published.indexOf('newcomer') > published.indexOf('core'), 'after the core it depends on');

  // The parity check's surfaces and drivers, read by the scripts in that tree.
  const registries = await import(pathToFileURL(join(root, 'scripts', 'registries.mjs')).href);
  assert.deepEqual(
    registries.SURFACES.map((surface) => surface.package),
    every,
  );
  assert.deepEqual(
    registries.SURFACES.find((surface) => surface.package === 'newcomer'),
    {
      package: 'newcomer',
      binary: 'agent-newcomer',
      entry: 'packages/newcomer/src/cli.ts',
      program: 'packages/newcomer/src/cli/program.ts',
      cli: 'commander',
    },
  );
  assert.deepEqual(registries.WRAPPERS, { 'gmail-mcp': 'gmail' }, 'a channel that is its own server wraps nothing');
  const operations = await import(pathToFileURL(join(root, 'scripts', 'operations.mjs')).href);
  assert.deepEqual(Object.keys(operations.DRIVERS), every);
  assert.deepEqual(operations.DRIVERS.newcomer, {
    cli: 'packages/newcomer/src/cli/program.ts',
    run: 'run',
    server: 'packages/newcomer/src/mcp/server.ts',
    factory: 'createNewcomerMcpServer',
  });

  // The views the tests and the generators read: tool drift, the reference pages, skill commands and contracts,
  // install commands, and account names.
  const registry = loadRegistry(root);
  assert.deepEqual(
    registry.products.find((product) => product.channel === 'newcomer'),
    {
      channel: 'newcomer',
      tool: 'newcomer',
      binary: 'agent-newcomer',
      server: 'packages/newcomer/src/mcp/server.ts',
      reference: 'docs/reference/newcomer-mcp-tools.md',
      program: 'packages/newcomer/src/cli/program.ts',
    },
  );
  assert.deepEqual(registry.reference.newcomer, {
    cli: 'docs/reference/newcomer-cli.md',
    mcp: 'docs/reference/newcomer-mcp-tools.md',
  });
  assert.ok(registry.platforms.includes('newcomer'), 'account names on the new platform');
  const family = (name) => registry.skillFamilies.find((each) => each.family === name);
  assert.equal(family('newcomer').contract, 'skills/_shared/contract-newcomer.md');
  assert.equal(family('newcomer').readme, 'packages/newcomer/README.md');
  const words = (name) => family(name).foreign.map(String).join(' ');
  // Its skills may not borrow another channel's words, and no other channel's skills may borrow its.
  assert.match(words('newcomer'), /gmail_/);
  assert.match(words('newcomer'), /agent-slack/);
  for (const other of others) {
    assert.match(words(other), /newcomer_\[a-z_\]\+/);
    assert.match(words(other), /agent-newcomer/);
    assert.match(words(other), /@agentcomms\\\/newcomer/);
    assert.match(words(other), /newcomer-reading/);
  }
  assert.deepEqual(family('comms').foreign, [], 'the core’s skills manage every channel');

  // Core's snapshot: the manifest is validated against core's schema and built in.
  const snapshot = await snapshotSource(root);
  assert.match(snapshot, /packageName: '@agentcomms\/newcomer'/);
  assert.match(snapshot, /channel: 'newcomer'/);

  // The version sync bumps its manifest, and a pin of it anywhere the sync rewrites pins.
  const extension = JSON.parse(await readFile(join(root, 'gemini-extension.json'), 'utf8'));
  extension.mcpServers.newcomer = { command: 'npx', args: ['-y', `@agentcomms/newcomer@${version}`, 'mcp'] };
  await writeFile(join(root, 'gemini-extension.json'), `${JSON.stringify(extension, null, 2)}\n`);
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ ...rootManifest, version: '9.9.9' }, null, 2)}\n`);
  await run(root, 'sync-versions.mjs');
  assert.equal(JSON.parse(await readFile(join(root, 'packages', 'newcomer', 'package.json'), 'utf8')).version, '9.9.9');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'gemini-extension.json'), 'utf8')).mcpServers.newcomer.args, [
    '-y',
    '@agentcomms/newcomer@9.9.9',
    'mcp',
  ]);

  // The skills sync gives its skills the contract its manifest names.
  await run(root, 'sync-skills.mjs');
  assert.equal(
    await readFile(join(root, 'skills', 'newcomer-reading', 'references', 'contract.md'), 'utf8'),
    await readFile(join(root, 'skills', '_shared', 'contract-newcomer.md'), 'utf8'),
  );
});

test('a skill whose prefix no channel declares is refused, even with a contract file to match', async () => {
  const { root } = await treeWithNewcomer();
  // The old rule chose a contract by the name alone, so any `_shared/contract-<word>.md` made a family.
  await writeFile(join(root, 'skills', '_shared', 'contract-orphan.md'), '# Orphan\n');
  await mkdir(join(root, 'skills', 'orphan-skill', 'references'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'orphan-skill', 'SKILL.md'),
    '---\nname: orphan-skill\ndescription: "An orphan. Symptoms: none."\n---\n',
  );
  await assert.rejects(run(root, 'sync-skills.mjs', ['--check']), (error) => {
    assert.match(String(error.stderr), /skills\/orphan-skill: no channel's skills start "orphan-"/);
    return true;
  });
});

test('a channel whose word is not its directory, or whose package is not its own, is refused by the registry', async () => {
  const { root, version } = await treeWithNewcomer();
  const path = join(root, 'packages', 'newcomer', 'package.json');
  const manifest = newcomerManifest(version);
  await writeFile(path, JSON.stringify({ ...manifest, agentcomms: { ...manifest.agentcomms, channel: 'other' } }));
  assert.throws(() => loadRegistry(root), /declares channel "other", but a channel's word is its directory's name/);
  await writeFile(path, JSON.stringify({ ...manifest, name: '@someone/newcomer' }));
  assert.throws(() => loadRegistry(root), /a channel's package is @agentcomms\/newcomer/);
  // And the schema in core refuses what the plain reader lets through: a mode outside the vocabulary.
  await writeFile(
    path,
    JSON.stringify({
      ...manifest,
      agentcomms: { ...manifest.agentcomms, accounts: { ...manifest.agentcomms.accounts, modes: ['read', 'post'] } },
    }),
  );
  await assert.rejects(snapshotSource(root), /@agentcomms\/newcomer: agentcomms\.accounts\.modes/);
});

test('a new channel that borrows Gmail’s or Slack’s shapes, or a command outside agent-*, fails verify:channels', async () => {
  /*
   * `inboxes`, `--inbox` and `--read-only` are Gmail's, `--workspace` Slack's, kept because their entries already say
   * them; a channel after them keeps its accounts in `accounts`, is pinned by `--account` alone, and is started by an
   * `agent-*` command. A newcomer declaring otherwise used to be snapshotted into core as if it were a Gmail or a Slack.
   */
  const { root, version } = await treeWithNewcomer();
  const path = join(root, 'packages', 'newcomer', 'package.json');
  const manifest = newcomerManifest(version);
  const declare = (agentcomms) => writeFile(path, JSON.stringify({ ...manifest, agentcomms }));
  const { accounts } = manifest.agentcomms;

  await declare({ ...manifest.agentcomms, accounts: { ...accounts, map: 'inboxes' } });
  await assert.rejects(
    snapshotSource(root),
    /@agentcomms\/newcomer: agentcomms\.accounts\.map: `inboxes` is Gmail's alone/,
  );

  await declare({ ...manifest.agentcomms, narrowing: [{ option: 'workspace', flag: '--workspace', kind: 'pin' }] });
  await assert.rejects(
    snapshotSource(root),
    /@agentcomms\/newcomer: agentcomms\.narrowing: .*pinned by `account` \/ `--account` and nothing else/,
  );

  await declare({
    ...manifest.agentcomms,
    narrowing: [
      { option: 'inbox', flag: '--inbox', kind: 'pin' },
      { option: 'readOnly', flag: '--read-only', kind: 'switch' },
    ],
  });
  await assert.rejects(snapshotSource(root), /@agentcomms\/newcomer: agentcomms\.narrowing: .*and nothing else/);

  await declare({ ...manifest.agentcomms, binary: 'teams', approve: 'teams approve' });
  await assert.rejects(
    snapshotSource(root),
    /@agentcomms\/newcomer: agentcomms\.binary: a channel's command is `agent-<something>`/,
  );

  // As declared in the first place, it is accepted.
  await declare(manifest.agentcomms);
  assert.match(await snapshotSource(root), /channel: 'newcomer'/);
});

test('a new channel chooses how the unsent report groups its approvals in its own manifest, with no edit to core (R15f)', async () => {
  // Design 2026-10-05 §D9: the rule is data, read from the snapshot core is built with.
  const { root, version } = await treeWithNewcomer();
  const path = join(root, 'packages', 'newcomer', 'package.json');
  const manifest = newcomerManifest(version);
  const declare = (agentcomms) => writeFile(path, JSON.stringify({ ...manifest, agentcomms }));
  const entryOf = (snapshot) => {
    const start = snapshot.indexOf("packageName: '@agentcomms/newcomer'");
    const next = snapshot.indexOf('packageName:', start + 1);
    return snapshot.slice(start, next === -1 ? undefined : next);
  };

  for (const rule of ['draft', 'draft-revision-digest']) {
    await declare({ ...manifest.agentcomms, approvalGrouping: rule });
    assert.match(entryOf(await snapshotSource(root)), new RegExp(`approvalGrouping: '${rule}'`), rule);
  }
  await declare(manifest.agentcomms);
  assert.doesNotMatch(entryOf(await snapshotSource(root)), /approvalGrouping/, 'none declared, none snapshotted');
  await declare({ ...manifest.agentcomms, approvalGrouping: 'per-thread' });
  await assert.rejects(snapshotSource(root), /@agentcomms\/newcomer: agentcomms\.approvalGrouping: /);
});

// ── Libraries and release holds (design 2026-10-05, D14; events phase A plan, decision 1) ───────────────────────

test('D14-a: a declared library is discovered in the same walk, and is publishable but surface-free', async () => {
  // It depends on the channel last in name order, so its place among the packages is computed, not alphabetical.
  const { root } = await treeWithLibrary({
    extra: { dependencies: { '@agentcomms/whatsapp': 'workspace:*', zod: '^4.0.0' } },
  });
  const registry = loadRegistry(root);
  // The checkout's own libraries are there too; the fixture is the one added.
  const own = (entries) => entries.filter((entry) => !REGISTRY.libraries.some((l) => l.directory === entry.directory));
  assert.deepEqual(
    own(registry.libraries).map(({ directory, packageName, declaration }) => ({ directory, packageName, declaration })),
    [{ directory: 'shelf', packageName: '@agentcomms/shelf', declaration: { kind: 'library' } }],
  );
  assert.ok(registry.packages.includes('shelf'), 'a library is published');
  assert.ok(
    registry.packages.indexOf('shelf') > registry.packages.indexOf('whatsapp'),
    `it comes after what it depends on: ${registry.packages.join(' ')}`,
  );
  assert.deepEqual(registry.held, REGISTRY.held, 'not held: only the checkout’s own holds');
  assert.deepEqual(registry.undeclared, []);

  // Nothing that needs a surface: it has no CLI, no server, no reference, no skills and no accounts.
  assert.ok(!registry.channels.some((channel) => channel.directory === 'shelf'), 'not a channel');
  assert.ok(!registry.surfaces.some((surface) => surface.package === 'shelf'), 'no surface');
  assert.ok(!Object.hasOwn(registry.drivers, 'shelf'), 'no driver');
  assert.ok(!registry.products.some((product) => product.channel === 'shelf'), 'no product');
  assert.ok(!Object.hasOwn(registry.reference, 'shelf'), 'no reference pages');
  assert.ok(!registry.skillFamilies.some((family) => family.channel === 'shelf'), 'no skill family');
  assert.ok(!registry.platforms.includes('shelf'), 'no account platform');
  assert.ok(!Object.hasOwn(registry.wrappers, 'shelf'), 'not a wrapper');

  // Run directly, the registry still prints only the channel words; the publish list names the library.
  assert.equal(
    (await run(root, 'channels.mjs')).trim(),
    REGISTRY.channels.map((channel) => channel.directory).join(' '),
  );
  assert.ok((await run(root, 'packages.mjs')).trim().split(' ').includes('shelf'), 'on the publish list');
});

test('D14-b: a library dropped into the tree is published in order, synced, consumer-checked, licensed and exempt from parity, with no list edited', async () => {
  // Held, as a new library is until something depends on it: every check below still has to reach it.
  const { root } = await treeWithLibrary({ held: true, extra: { dependencies: { zod: '^4.0.0' } } });

  // Published in order: the wide list names it after what it depends on, the release's narrow list leaves it out.
  const lists = await import(pathToFileURL(join(root, 'scripts', 'packages.mjs')).href);
  assert.ok(lists.PUBLISHABLE.includes('shelf'), `not publishable: ${lists.PUBLISHABLE.join(' ')}`);
  assert.ok(!lists.PACKAGES.includes('shelf'), 'a held library is in what a tag publishes');
  assert.equal(lists.HELD.shelf, 'Held until something depends on it.');

  // Synced: the version sync moves it with every other package.
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ ...rootManifest, version: '9.9.9' }, null, 2)}\n`);
  await run(root, 'sync-versions.mjs');
  assert.equal(JSON.parse(await readFile(join(root, 'packages', 'shelf', 'package.json'), 'utf8')).version, '9.9.9');

  // Exempt from parity: the parity check's list of declared libraries names it, and it is read as no surface.
  const registries = await import(pathToFileURL(join(root, 'scripts', 'registries.mjs')).href);
  assert.deepEqual(registries.LIBRARIES, [...REGISTRY.libraries.map((library) => library.directory), 'shelf'].sort());
  assert.ok(!registries.SURFACES.some((surface) => surface.package === 'shelf'));
  assert.ok(!Object.hasOwn(registries.WRAPPERS, 'shelf'));

  // Consumer-checked and licensed: both walk the wide list. Running them would need a build, so they are held to it
  // by text, as `test/release-packages.test.mjs` holds them too.
  for (const script of ['verify-package.mjs', 'third-party-licenses.mjs']) {
    const source = await readFile(join(root, 'scripts', script), 'utf8');
    assert.match(source, /for \(const name of PUBLISHABLE\)/, `scripts/${script} does not walk PUBLISHABLE`);
  }
});

test('D14-a: a malformed library declaration is refused, naming the package', async () => {
  const { root, version } = await treeWithLibrary();
  const path = join(root, 'packages', 'shelf', 'package.json');
  const library = libraryManifest(version);
  const refused = async (manifest, message) => {
    await writeFile(path, JSON.stringify(manifest));
    assert.throws(
      () => loadRegistry(root),
      (error) => {
        assert.match(error.message, /^packages\/shelf\/package\.json: /);
        assert.match(error.message, message);
        return true;
      },
      JSON.stringify(manifest),
    );
  };

  await refused({ ...library, agentcommsPackage: {} }, /"agentcommsPackage" has no "kind"/);
  // A service is the other kind D14 names; this registry does not read it until the daemon's phase.
  await refused(
    { ...library, agentcommsPackage: { kind: 'service' } },
    /this registry reads "library"; "service" arrives with phase B1/,
  );
  await refused({ ...library, agentcommsPackage: { kind: 'plugin' } }, /kind "plugin" is unknown/);
  await refused({ ...library, agentcommsPackage: { kind: 'library', binary: 'agent-shelf' } }, /unknown key "binary"/);
  for (const shape of ['library', null, ['library'], 1]) {
    await refused({ ...library, agentcommsPackage: shape }, /"agentcommsPackage" must be an object/);
  }
  await refused(
    { ...library, agentcomms: { contract: 1, channel: 'shelf' } },
    /declares both "agentcomms" and "agentcommsPackage"/,
  );
  await refused({ ...library, private: true }, /a library is published, so it cannot be "private": true/);
  await refused({ ...library, bin: { 'agent-shelf': './dist/cli.mjs' } }, /a library has no "bin"/);
  await refused({ ...library, name: '@agentcomms/other' }, /a library's package is @agentcomms\/shelf/);
  await refused({ ...library, name: '@someone/shelf' }, /a library's package is @agentcomms\/shelf/);

  // As declared in the first place, accepted.
  await writeFile(path, JSON.stringify(library));
  assert.ok(loadRegistry(root).libraries.some((entry) => entry.directory === 'shelf'));
});

test('PKG-c: "agentcomms" means a channel; one carrying a kind is refused, naming agentcommsPackage', async () => {
  const { root, version } = await treeWithLibrary();
  const path = join(root, 'packages', 'shelf', 'package.json');
  const { agentcommsPackage: _declaration, ...undeclared } = libraryManifest(version);
  for (const agentcomms of [{ kind: 'library' }, { channel: 'shelf', kind: 'service' }]) {
    await writeFile(path, JSON.stringify({ ...undeclared, agentcomms }));
    assert.throws(
      () => loadRegistry(root),
      /^Error: packages\/shelf\/package\.json: "agentcomms" declares a channel and has no "kind"; a library declares "agentcommsPackage": \{ "kind": "library" \} instead$/,
      JSON.stringify(agentcomms),
    );
  }
});

test('D14-a: a non-private package that declares nothing is listed as undeclared', async () => {
  const { root, version } = await treeWithLibrary();
  for (const [directory, fields] of [
    ['loose', {}],
    // Private: never published, so nothing to declare.
    ['quiet', { private: true }],
  ]) {
    await mkdir(join(root, 'packages', directory), { recursive: true });
    await writeFile(
      join(root, 'packages', directory, 'package.json'),
      JSON.stringify({ name: `@agentcomms/${directory}`, version, type: 'module', ...fields }),
    );
  }
  const registry = loadRegistry(root);
  assert.deepEqual(registry.undeclared, [{ directory: 'loose', packageName: '@agentcomms/loose' }]);
  assert.ok(!registry.packages.includes('loose'), 'the registry does not publish what it cannot name');
  // The server-only wrapper declares nothing of its own, and is a channel's: never undeclared.
  assert.equal(registry.wrappers['gmail-mcp'], 'gmail');
  assert.ok(!registry.undeclared.some((entry) => entry.directory === 'gmail-mcp'));
  assert.deepEqual(REGISTRY.undeclared, [], 'this checkout has none');
});

test('REL-c: a hold is read from the package, and refused where it cannot apply', async () => {
  const { root, version } = await treeWithLibrary({ held: true });
  const registry = loadRegistry(root);
  assert.deepEqual(
    registry.held.filter((entry) => entry.directory === 'shelf'),
    [{ directory: 'shelf', packageName: '@agentcomms/shelf', reason: 'Held until something depends on it.' }],
  );
  assert.equal(registry.held.length, REGISTRY.held.length + 1, 'the checkout’s own holds, and the fixture’s');
  assert.ok(registry.packages.includes('shelf'), 'held is still publishable: every check walks it');

  const write = (directory, manifest) =>
    writeFile(join(root, 'packages', directory, 'package.json'), JSON.stringify(manifest));
  const refused = async (directory, manifest, message) => {
    const path = join(root, 'packages', directory, 'package.json');
    const before = await readFile(path, 'utf8').catch(() => null);
    await mkdir(join(root, 'packages', directory), { recursive: true });
    await write(directory, manifest);
    try {
      assert.throws(
        () => loadRegistry(root),
        (error) => {
          assert.match(error.message, new RegExp(`^packages/${directory}/package\\.json: `));
          assert.match(error.message, message);
          return true;
        },
        JSON.stringify(manifest),
      );
    } finally {
      if (before === null) await rm(join(root, 'packages', directory), { recursive: true, force: true });
      else await writeFile(path, before);
    }
  };
  const hold = { agentcommsRelease: { hold: 'Not this release.' } };

  // Core: every channel depends on it, so a release without it installs nothing.
  const core = JSON.parse(await readFile(join(root, 'packages', 'core', 'package.json'), 'utf8'));
  await refused('core', { ...core, ...hold }, /core cannot be held back/);
  // Where no release would publish it anyway: a private package, and one that declares nothing.
  await refused('quiet', { name: '@agentcomms/quiet', version, private: true, ...hold }, /a private package/);
  await refused('loose', { name: '@agentcomms/loose', version, ...hold }, /declares neither "agentcomms" nor/);
  // The reason is one line that says why, and the field holds nothing else.
  for (const reason of ['', '   ', 'one\ntwo', 'one\r\ntwo', 42, null]) {
    await refused(
      'shelf',
      libraryManifest(version, { agentcommsRelease: { hold: reason } }),
      /"agentcommsRelease"\.hold says why, in one line/,
    );
  }
  await refused('shelf', libraryManifest(version, { agentcommsRelease: {} }), /"agentcommsRelease"\.hold says why/);
  await refused(
    'shelf',
    libraryManifest(version, { agentcommsRelease: { hold: 'Not yet.', until: '1.0.0' } }),
    /"agentcommsRelease" has unknown key "until"/,
  );
  for (const shape of ['held', null, ['held'], true]) {
    await refused(
      'shelf',
      libraryManifest(version, { agentcommsRelease: shape }),
      /"agentcommsRelease" must be \{ "hold": "<why, one sentence>" \}/,
    );
  }

  // A channel other than core may be held.
  const slack = JSON.parse(await readFile(join(root, 'packages', 'slack', 'package.json'), 'utf8'));
  await write('slack', { ...slack, ...hold });
  assert.deepEqual(
    loadRegistry(root)
      .held.map((entry) => entry.directory)
      .filter((directory) => !REGISTRY.held.some((entry) => entry.directory === directory)),
    ['shelf', 'slack'],
  );
});

/**
 * Every channel carries the core it was released with (design 2026-10-04, D4).
 *
 * A channel's bundle inlines core, and that used to be the whole story: core sat in `devDependencies`, and nothing of
 * it was installed beside a channel. A channel now finds core's own command through its installed package, so core is
 * a runtime dependency, pinned to the channel's exact version — what a channel prints must be the same release's
 * core, not whichever one npm chose. Checked for every channel the registry discovers, never a list of today's: core
 * itself excepted, since `readChannels` returns it first and it cannot depend on itself.
 *
 * Returns the packages checked and what is wrong with each, as sentences.
 */
export function coreEdgeProblems(registry) {
  const core = registry.channels.find((channel) => channel.directory === 'core');
  const checked = [];
  const problems = [];
  for (const { directory, packageName, packageJson } of registry.channels) {
    if (directory === 'core') continue;
    checked.push(packageName);
    const own = packageJson.version;
    for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (packageJson[field]?.[core.packageName] !== undefined) {
        problems.push(`${packageName}: declares ${core.packageName} in ${field}; it belongs in "dependencies" alone`);
      }
    }
    const specifier = packageJson.dependencies?.[core.packageName];
    if (specifier === undefined) {
      problems.push(`${packageName}: ${core.packageName} is not in its runtime "dependencies"`);
      continue;
    }
    if (!String(specifier).startsWith('workspace:')) {
      problems.push(`${packageName}: ${core.packageName} "${specifier}" is not this checkout's core (workspace:*)`);
    } else if (core.packageJson.version !== own) {
      problems.push(
        `${packageName} ${own}: its workspace edge resolves to ${core.packageName} ${core.packageJson.version}`,
      );
    }
    const packed = packedRange(String(specifier), core.packageJson.version);
    if (packed !== own) {
      problems.push(`${packageName}: ${core.packageName} "${specifier}" packs as "${packed}", not exactly ${own}`);
    }
  }
  return { checked, problems };
}

/** What pnpm writes for a dependency when it packs: `workspace:*` the exact version, `workspace:^` a caret range. */
function packedRange(specifier, version) {
  const range = /^workspace:(.*)$/.exec(specifier)?.[1];
  if (range === undefined) return specifier;
  if (range === '*') return version;
  if (range === '^' || range === '~') return `${range}${version}`;
  return range;
}

test('every channel this checkout ships depends on core at runtime, pinned to its own version', () => {
  const { checked, problems } = coreEdgeProblems(REGISTRY);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    checked,
    REGISTRY.channels.filter((channel) => channel.directory !== 'core').map((channel) => channel.packageName),
  );
  assert.ok(checked.length > 0, 'no channel found — the discovery is wrong');
});

test('a channel added later is held to the same edge, and every way of getting it wrong is refused', async () => {
  const { root, version } = await treeWithNewcomer();
  const path = join(root, 'packages', 'newcomer', 'package.json');
  const manifest = newcomerManifest(version);
  const { dependencies, ...rest } = manifest;
  const problemsWith = async (fields) => {
    await writeFile(path, JSON.stringify({ ...rest, ...fields }));
    const { checked, problems } = coreEdgeProblems(loadRegistry(root));
    assert.ok(checked.includes('@agentcomms/newcomer'), 'the newcomer was not checked');
    // The shipped channels are the test above's; these fixtures are about the newcomer alone.
    return problems.filter((problem) => problem.startsWith('@agentcomms/newcomer'));
  };

  // As the instructions for a new channel declare it, accepted.
  assert.deepEqual(await problemsWith({ dependencies }), []);

  // Missing, and only for development, as every channel was before.
  assert.deepEqual(await problemsWith({}), [
    '@agentcomms/newcomer: @agentcomms/core is not in its runtime "dependencies"',
  ]);
  assert.deepEqual(await problemsWith({ devDependencies: dependencies }), [
    '@agentcomms/newcomer: declares @agentcomms/core in devDependencies; it belongs in "dependencies" alone',
    '@agentcomms/newcomer: @agentcomms/core is not in its runtime "dependencies"',
  ]);

  // In the runtime field and another besides, each refused on its own.
  for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.deepEqual(
      await problemsWith({ dependencies, [field]: dependencies }),
      [`@agentcomms/newcomer: declares @agentcomms/core in ${field}; it belongs in "dependencies" alone`],
      field,
    );
  }

  // Ranged: the workspace edge packs to a range, or a range is written out, and npm may then pick another core.
  assert.deepEqual(await problemsWith({ dependencies: { '@agentcomms/core': 'workspace:^' } }), [
    `@agentcomms/newcomer: @agentcomms/core "workspace:^" packs as "^${version}", not exactly ${version}`,
  ]);
  assert.deepEqual(await problemsWith({ dependencies: { '@agentcomms/core': `^${version}` } }), [
    `@agentcomms/newcomer: @agentcomms/core "^${version}" is not this checkout's core (workspace:*)`,
    `@agentcomms/newcomer: @agentcomms/core "^${version}" packs as "^${version}", not exactly ${version}`,
  ]);

  // Mismatched: a channel at another version than the core its edge resolves to.
  assert.deepEqual(await problemsWith({ dependencies, version: '0.0.1' }), [
    `@agentcomms/newcomer 0.0.1: its workspace edge resolves to @agentcomms/core ${version}`,
    `@agentcomms/newcomer: @agentcomms/core "workspace:*" packs as "${version}", not exactly 0.0.1`,
  ]);
  assert.deepEqual(await problemsWith({ dependencies: { '@agentcomms/core': '0.0.1' } }), [
    `@agentcomms/newcomer: @agentcomms/core "0.0.1" is not this checkout's core (workspace:*)`,
    `@agentcomms/newcomer: @agentcomms/core "0.0.1" packs as "0.0.1", not exactly ${version}`,
  ]);
});

/** The comments of a source file as one line of prose: each without its `//`, `/*` or leading `*`, then joined. */
function commentsOf(source) {
  return [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm)]
    .map(([comment]) => comment.replace(/^\/\/|^\/\*+|\*\/$/g, '').replace(/^\s*\*/gm, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** The text of a Markdown section, from its heading to the next heading of the same level or higher. */
function sectionOf(markdown, heading) {
  const start = markdown.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `no section "${heading}"`);
  const level = /^#+/.exec(heading)[0].length;
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
}

/** Claims a channel's comments made while core was only bundled, each false once core is installed beside it. */
const NO_DEPENDENCY_CLAIMS = [
  /no runtime dependenc/i,
  /no dependency tree/i,
  /zero runtime/i,
  /nothing to install/i,
  /installs? one package/i,
  /no runtime dependency of its own/i,
];

test('the instructions a new channel follows, the designs and every channel’s comments say core is a runtime dependency', async () => {
  const read = (path) => readFile(join(ROOT, path), 'utf8');

  // The two places a new channel's author reads the rule.
  for (const [path, heading] of [
    ['docs/superpowers/specs/2026-09-26-channel-plugins-design.md', '## 9. Adding a channel'],
    ['CONTRIBUTING.md', '## Adding a channel'],
  ]) {
    const rule = sectionOf(await read(path), heading);
    assert.doesNotMatch(rule, /dev dependency|devDependencies/i, `${path} still makes core a development dependency`);
    assert.match(
      rule,
      /`@agentcomms\/core` as a runtime dependency, in `dependencies`, as `workspace:\*`/,
      `${path} does not make core a runtime dependency`,
    );
    assert.match(rule, /packs to (?:the|its) exact version/, `${path} does not say the packed pin is exact`);
  }

  // The governing design no longer says npx installs nothing beside a channel, or that Gmail depends on nothing.
  const design = (await read('docs/superpowers/specs/2026-09-18-agent-communications-design.md')).replace(/\s+/g, ' ');
  for (const claim of [/installs no dependency tree/i, /zero runtime `dependencies`/i]) {
    assert.doesNotMatch(design, claim, `the communications design still says ${claim}`);
  }
  assert.match(design, /depends at runtime on `@agentcomms\/core` at exactly its own version/);

  // Every channel's bundler and library comments, found from the registry.
  const channels = REGISTRY.channels.filter((channel) => channel.directory !== 'core');
  assert.ok(channels.length > 0, 'no channel found — the discovery is wrong');
  for (const { directory } of channels) {
    for (const file of ['tsdown.config.ts', 'src/index.ts']) {
      const comments = commentsOf(await read(`packages/${directory}/${file}`));
      for (const claim of NO_DEPENDENCY_CLAIMS) {
        assert.doesNotMatch(comments, claim, `packages/${directory}/${file} still says ${claim}`);
      }
    }
    assert.match(
      commentsOf(await read(`packages/${directory}/tsdown.config.ts`)),
      /`@agentcomms\/core` is still installed beside it/,
      `packages/${directory}/tsdown.config.ts does not say core is a runtime dependency`,
    );
  }
});

/**
 * Everything that walks the channels reads the registry — directly, or through `packages.mjs` — rather than keeping a
 * list. Checked as text, as `release-packages.test.mjs` checks the release scripts: some of these cannot be run here
 * (the reference generator starts every server), and the property that failed eleven times is a literal list. Each
 * consumer names the view it must read, so one that imports the registry and then keeps its own list anyway fails.
 */
const CONSUMERS = {
  'scripts/packages.mjs': [/from '\.\/channels\.mjs'/, /REGISTRY\.packages/],
  'scripts/third-party-licenses.mjs': [/import \{ PUBLISHABLE \} from '\.\/packages\.mjs'/],
  'scripts/sync-versions.mjs': [/from '\.\/packages\.mjs'/, /of PUBLISHABLE\b/, /PINNED = new RegExp/],
  'scripts/registries.mjs': [/REGISTRY\.surfaces/, /REGISTRY\.wrappers/, /REGISTRY\.libraries/],
  'scripts/operations.mjs': [/REGISTRY\.drivers/, /REGISTRY\.platforms/],
  'scripts/sync-reference.mjs': [
    /const CLIS = REGISTRY\.surfaces/,
    /const SERVERS = REGISTRY\.channels/,
    /REGISTRY\.skillFamilies/,
  ],
  'scripts/sync-skills.mjs': [/skillFamilyOf\(REGISTRY, name\)/],
  'scripts/verify-skills.mjs': [/REGISTRY\.platforms/, /REGISTRY\.skillFamilies/, /REGISTRY\.channels\s*\.map/],
  'scripts/sync-channels.mjs': [/readChannels\(root\)/],
  'test/tool-drift.test.mjs': [/const PRODUCTS = REGISTRY\.products/],
  'test/skill-commands.test.mjs': [/const CLIS = REGISTRY\.surfaces/, /REGISTRY\.skillFamilies/],
  'test/install-docs.test.mjs': [/REGISTRY\.channels/, /PUBLISHABLE\.map/],
  'test/skill-contracts.test.mjs': [
    /const FOREIGN = Object\.fromEntries\(REGISTRY\.skillFamilies/,
    /skillFamilyOf\(REGISTRY/,
  ],
  'test/manifests.test.mjs': [/from '\.\.\/scripts\/packages\.mjs'/, /'scripts\/channels\.mjs'/],
  'test/parity.test.mjs': [/SURFACES/, /WRAPPERS/, /PUBLISHABLE/, /LIBRARIES/],
  'test/release-packages.test.mjs': [/'third-party-licenses\.mjs'/],
};

/** Files whose fixtures name channels on purpose — rows of a capabilities table — and are only held to what they read. */
const FIXTURE_FILES = new Set(['test/parity.test.mjs']);

/**
 * Channel words written out as a list, in the shapes the old copies took: an array of names, an alternation, an
 * object keyed by channel holding a list or a computed value, and a product entry naming one.
 *
 * The words are the registry's: every channel and every package it publishes. This pattern once named the three
 * words there were when it was written, so a list of the channels added since — `['core', 'resend', 'whatsapp']` —
 * passed it, and so would every channel after them. Read from the registry, a new channel's word is caught the day
 * its package declares itself.
 */
export function literalList(registry) {
  const words = [...new Set([...registry.channels.map((channel) => channel.directory), ...registry.packages])]
    // Longest first, so `gmail-mcp` is one word rather than `gmail` and a remainder.
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const word = `(?:${words.join('|')})`;
  return new RegExp(
    [
      String.raw`['"]${word}['"]\s*,\s*['"]${word}['"]`,
      String.raw`\b${word}\|${word}\b`,
      // Two keys at least: one channel's own extra rule (`{ slack: [/mailbox/] }`) is not a list of channels.
      String.raw`\b${word}:\s*(?:\[|await\b)[\s\S]{0,400}?\b${word}:\s*(?:\[|await\b)`,
      String.raw`\b(?:tool|package|channel):\s*['"]${word}['"]`,
      // A conditional choosing between channel words: `pkg === 'slack' ? 'slack' : 'gmail'`.
      String.raw`\?\s*['"]${word}['"]\s*:[^;\n]*?['"]${word}['"]`,
    ].join('|'),
  );
}
const LITERAL_LIST = literalList(REGISTRY);

test('every consumer reads the registry, and none keeps a list of channels of its own', async () => {
  const problems = [];
  for (const [file, reads] of Object.entries(CONSUMERS)) {
    const source = await readFile(join(ROOT, file), 'utf8');
    for (const pattern of reads) if (!pattern.test(source)) problems.push(`${file} does not read ${pattern}`);
    if (FIXTURE_FILES.has(file)) continue;
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const found = LITERAL_LIST.exec(code);
    if (found) problems.push(`${file} lists channels itself: ${found[0]}`);
  }
  assert.deepEqual(problems, []);
  // The pattern finds every list this replaced, and leaves one channel's own rule alone.
  assert.doesNotMatch('const ALSO_FOREIGN = { slack: [/\\bmailbox(es)?\\b/i] };', LITERAL_LIST);
  for (const old of [
    "const PACKAGES = ['core', 'gmail', 'gmail-mcp', 'slack'];",
    '/(agent-gmail|agent-slack|agentcomms|@agentcomms\\/(?:gmail|slack|core)(?:@\\S+)?) mcp install/g',
    '`agent-communications/(${ALIAS})/(?!(?:gmail|slack)(?:-[a-z0-9-]+)?/)`',
    'const FOREIGN = { gmail: [/\\bslack_[a-z_]+/], slack: [/\\bgmail_[a-z_]+/] };',
    "const known = { gmail: await installFlags('gmail'), slack: await installFlags('slack') };",
    "const PRODUCTS = [{ tool: 'gmail', binary: 'agent-gmail' }];",
    "export const SURFACES = Object.freeze([{ package: 'core', binary: 'agentcomms' }]);",
    "cli: binary.includes('slack') ? 'slack' : binary.includes('gmail') ? 'gmail' : 'core',",
    "return `parity/${pkg === 'slack' ? 'slack' : 'gmail'}`;",
  ]) {
    assert.match(old, LITERAL_LIST, old);
  }
  // The channels added since the lists above were written, in each shape: the pattern knew only the old three words,
  // so every one of these passed it.
  for (const since of [
    "const CHANNELS = ['core', 'resend', 'whatsapp'];",
    "const PACKAGES = ['gmail-mcp', 'resend'];",
    '/(agent-resend|agent-whatsapp|@agentcomms\\/(?:resend|whatsapp)) mcp install/g',
    "const known = { resend: await installFlags('resend'), whatsapp: await installFlags('whatsapp') };",
    "const PRODUCTS = [{ tool: 'whatsapp', binary: 'agent-whatsapp' }];",
    "const channel = pkg === 'whatsapp' ? 'whatsapp' : 'resend';",
  ]) {
    assert.match(since, LITERAL_LIST, since);
  }
});

test('the hand-written-list guard reads its words from the registry, so a channel added later is covered too', async () => {
  const { root } = await treeWithNewcomer();
  const guard = literalList(loadRegistry(root));
  assert.match("const CHANNELS = ['core', 'newcomer'];", guard);
  assert.match(
    "const known = { gmail: await installFlags('gmail'), newcomer: await installFlags('newcomer') };",
    guard,
  );
  assert.match("const PRODUCTS = [{ tool: 'newcomer', binary: 'agent-newcomer' }];", guard);
  assert.doesNotMatch("const CHANNELS = ['core', 'newcomer'];", LITERAL_LIST, 'this checkout has no newcomer');
  // One channel's own rule is still not a list.
  assert.doesNotMatch('const ALSO_FOREIGN = { newcomer: [/\\bmailbox(es)?\\b/i] };', guard);
});

test('this checkout’s registry is the five channels, one held library and seven packages it ships', () => {
  assert.deepEqual(
    REGISTRY.channels.map((channel) => channel.directory),
    ['core', 'gmail', 'resend', 'slack', 'whatsapp'],
  );
  assert.deepEqual(REGISTRY.packages, ['core', 'events', 'gmail', 'gmail-mcp', 'resend', 'slack', 'whatsapp']);
  assert.deepEqual(REGISTRY.platforms, ['gmail', 'resend', 'slack', 'whatsapp']);
  assert.deepEqual(
    REGISTRY.libraries.map((library) => library.directory),
    ['events'],
  );
  assert.deepEqual(
    REGISTRY.held.map((entry) => entry.directory),
    ['events'],
  );
  assert.deepEqual(REGISTRY.undeclared, []);
});
