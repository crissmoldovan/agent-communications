import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { REGISTRY } from '../scripts/channels.mjs';
import { HELD, PACKAGES, PUBLISHABLE } from '../scripts/packages.mjs';
import { isVisible } from '../scripts/release-confirm.mjs';
import { workspaceClosure } from '../scripts/verify-package.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

/** Text matched literally inside a RegExp: every character that means something there, backslash included. */
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/**
 * Every publishable package is released, by every path that releases, in an order that installs.
 *
 * The release publishes from an explicit, ordered list, and the order is load-bearing: a consumer installing `gmail`
 * must find the exact `core` it pins already on the registry. So the list cannot simply be derived — but it can be
 * *checked*, and it has to be, because it was not: 0.4.0 published three packages and reported success while
 * `@agentcomms/slack` — added in that very release — was missing from the loop. Then, with the workflow fixed,
 * `scripts/release.mjs` still carried its own copy that said three.
 *
 * That was the fifth time in one change that a hand-written list of things went stale: `sync-skills.mjs` and the
 * plugin-manifest test both enumerated skills by a `gmail-` prefix, `sync-versions.mjs` did the same for
 * compatibility lines, and the release made the same shape of mistake twice with packages. The pattern that works is
 * one explicit list, a test that it is complete, and a test that everything which walks the packages reads it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);

/** Runs a script and returns its exit status and output; a refusal is an answer, not a thrown error. */
async function runScript(script, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { encoding: 'utf8', ...options });
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { status: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** Every non-private package under `root/packages`, by directory, each checked to be `@agentcomms/<directory>`. */
async function manifests(root = ROOT) {
  const dirs = (await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const found = new Map();
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', dir, 'package.json'), 'utf8'));
    if (manifest.private === true) continue;
    assert.ok(manifest.name?.startsWith('@agentcomms/'), `${dir} has an unexpected package name`);
    assert.equal(manifest.name, `@agentcomms/${dir}`, 'the list names directories, so each must match its package');
    found.set(dir, manifest);
  }
  return found;
}

/**
 * A copy of the release's scripts and every package manifest — what the release path reads, and nothing else — with
 * a library, `packages/shelf`, dropped in: held back from release unless `held` is false, and depended on at runtime
 * by each package in `dependents`. `full` adds what the version sync reads besides: the root manifest, the skills,
 * the plugin files and the launcher.
 */
async function treeWithShelf({ held = true, dependents = [], extra = {}, full = false } = {}) {
  const root = await tempDir('release-held-');
  await cp(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  // What the version sync reads besides the manifests, when the test runs it.
  const besides = full ? ['package.json', 'skills', '.claude-plugin', 'gemini-extension.json', 'bin'] : [];
  for (const path of besides) await cp(join(ROOT, path), join(root, path), { recursive: true });
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await mkdir(join(root, 'packages', entry.name), { recursive: true });
    await cp(join(ROOT, 'packages', entry.name, 'package.json'), join(root, 'packages', entry.name, 'package.json'));
    const manifest = JSON.parse(await readFile(join(ROOT, 'packages', entry.name, 'package.json'), 'utf8'));
    const declaration = manifest.agentcommsPackage;
    if (declaration?.kind === 'service') {
      for (const path of [declaration.server.entry, declaration.operations]) {
        const target = join(root, 'packages', entry.name, path);
        await mkdir(dirname(target), { recursive: true });
        await cp(join(ROOT, 'packages', entry.name, path), target, { recursive: true });
      }
    }
  }
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const shelf = {
    name: '@agentcomms/shelf',
    version,
    type: 'module',
    license: 'MIT',
    agentcommsPackage: { kind: 'library' },
    ...(held ? { agentcommsRelease: { hold: 'Held until the first package that depends on it ships.' } } : {}),
    ...extra,
  };
  await mkdir(join(root, 'packages', 'shelf'), { recursive: true });
  await writeFile(join(root, 'packages', 'shelf', 'package.json'), `${JSON.stringify(shelf, null, 2)}\n`);
  for (const dependent of dependents) {
    const path = join(root, 'packages', dependent, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.dependencies = { ...manifest.dependencies, '@agentcomms/shelf': 'workspace:*' };
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return root;
}

/** A held D14 service with a deliberately non-default operations directory. */
async function treeWithService() {
  const root = await treeWithShelf();
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const directory = join(root, 'packages', 'service-fixture');
  await mkdir(join(directory, 'src', 'mcp'), { recursive: true });
  await mkdir(join(directory, 'src', 'actions'), { recursive: true });
  await writeFile(
    join(directory, 'src', 'mcp', 'server.ts'),
    'export async function createServiceFixtureMcpServer() { return {}; }\n',
  );
  await writeFile(join(directory, 'src', 'actions', 'status.ts'), 'export {}\n');
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: '@agentcomms/service-fixture',
        version,
        type: 'module',
        license: 'MIT',
        bin: { 'service-fixture': './dist/cli.mjs' },
        agentcommsPackage: {
          kind: 'service',
          binary: 'service-fixture',
          server: {
            defaultName: 'service-fixture',
            entry: 'src/mcp/server.ts',
            factory: 'createServiceFixtureMcpServer',
          },
          operations: 'src/actions',
        },
        agentcommsRelease: { hold: 'Held until its first complete release.' },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

/** The three lists of the tree at `root`, read through its own `scripts/packages.mjs`. */
async function listsOf(root) {
  if (root === ROOT) return { PUBLISHABLE, HELD, PACKAGES };
  const {
    PUBLISHABLE: publishable,
    HELD: held,
    PACKAGES: packages,
  } = await import(pathToFileURL(join(root, 'scripts', 'packages.mjs')).href);
  return { PUBLISHABLE: publishable, HELD: held, PACKAGES: packages };
}

test('D14-c: PUBLISHABLE names every non-private package, and nothing else; PACKAGES is it less the held ones, in the same order', async () => {
  // This checkout, a held library and a held service: the lists must be right for the package the registry learns
  // about next, not only for the ones it already knows.
  for (const root of [ROOT, await treeWithShelf(), await treeWithService()]) {
    const lists = await listsOf(root);
    const publishable = [...(await manifests(root)).keys()];
    assert.ok(publishable.length > 0, 'no publishable packages found — the discovery is wrong');
    for (const name of publishable) {
      assert.ok(
        lists.PUBLISHABLE.includes(name),
        `@agentcomms/${name} is publishable but scripts/packages.mjs never names it`,
      );
    }
    // Nothing in the list that is not a real package, which would make the confirm step hang on a 404.
    for (const name of lists.PUBLISHABLE) {
      assert.ok(
        publishable.includes(name),
        `scripts/packages.mjs names @agentcomms/${name}, which is not a package here`,
      );
    }
    assert.equal(new Set(lists.PUBLISHABLE).size, lists.PUBLISHABLE.length, 'a package listed twice');
    // What a tag publishes: the same order, less exactly the held packages.
    for (const name of Object.keys(lists.HELD)) assert.ok(lists.PUBLISHABLE.includes(name), `held ${name} is unknown`);
    assert.deepEqual(
      lists.PACKAGES,
      lists.PUBLISHABLE.filter((name) => !Object.hasOwn(lists.HELD, name)),
    );
  }
  // In the copies, a library and a service are each publishable and held, so a tag leaves them out.
  const copy = await listsOf(await treeWithShelf());
  assert.ok(copy.PUBLISHABLE.includes('shelf'));
  assert.ok(Object.hasOwn(copy.HELD, 'shelf'));
  assert.ok(!copy.PACKAGES.includes('shelf'));
  assert.deepEqual(copy.PACKAGES, PACKAGES, 'the copy publishes exactly what this checkout does');
  const service = await listsOf(await treeWithService());
  assert.ok(service.PUBLISHABLE.includes('service-fixture'));
  assert.ok(Object.hasOwn(service.HELD, 'service-fixture'));
  assert.ok(!service.PACKAGES.includes('service-fixture'));
});

test('PKG-a: every publishable package comes after what it depends on, a library too', async () => {
  // A library depending on the channel last in name order, so its place is computed rather than alphabetical.
  const copy = await treeWithShelf({ extra: { dependencies: { '@agentcomms/whatsapp': 'workspace:*' } } });
  for (const root of [ROOT, copy]) {
    const found = await manifests(root);
    const { PUBLISHABLE: order } = await listsOf(root);
    for (const [index, name] of order.entries()) {
      const manifest = found.get(name);
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          if (!dependency.startsWith('@agentcomms/')) continue;
          const at = order.indexOf(dependency.slice('@agentcomms/'.length));
          assert.ok(at !== -1 && at < index, `@agentcomms/${name} depends on ${dependency}, so it must come after it`);
        }
      }
    }
  }
  const { PUBLISHABLE: order } = await listsOf(copy);
  assert.ok(order.indexOf('shelf') > order.indexOf('whatsapp'), order.join(' '));
});

/**
 * What a tag would publish that cannot install: a package on its list depending at runtime on a held one, which the
 * registry would never have — and core held, which every channel needs. As sentences, one per problem.
 */
async function heldEdgeProblems(root) {
  const lists = await listsOf(root);
  const problems = [];
  if (Object.hasOwn(lists.HELD, 'core')) problems.push('@agentcomms/core is held, and every channel depends on it');
  for (const name of lists.PACKAGES) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        const directory = dependency.startsWith('@agentcomms/') ? dependency.slice('@agentcomms/'.length) : null;
        if (directory !== null && Object.hasOwn(lists.HELD, directory)) {
          problems.push(`@agentcomms/${name} depends on ${dependency} in ${field}, and ${dependency} is held back`);
        }
      }
    }
  }
  return problems;
}

test('REL-c: no package a tag publishes depends at runtime on a held one, and core is never held', async () => {
  assert.deepEqual(await heldEdgeProblems(ROOT), []);
  assert.ok(!Object.hasOwn(HELD, 'core'), 'core is held');
  // A released channel that depends on the held library: its release would install nothing, so it fails here. This is
  // what makes the release of the first package depending on a held one lift the hold in its own version commit.
  assert.deepEqual(await heldEdgeProblems(await treeWithShelf({ dependents: ['whatsapp'] })), [
    '@agentcomms/whatsapp depends on @agentcomms/shelf in dependencies, and @agentcomms/shelf is held back',
  ]);
  // Not held, the same edge is an ordinary one.
  assert.deepEqual(await heldEdgeProblems(await treeWithShelf({ held: false, dependents: ['whatsapp'] })), []);
});

test('the release documents say every channel pins the same-version core, so core goes out before every channel', async () => {
  /*
   * A channel used to bundle core and depend on it only for development, and RELEASING.md drew a permission from
   * that: a channel's first version "can go out before the rest of the release". Every channel now depends on core at
   * runtime, pinned to its own version (design 2026-10-04, D4), so a channel out before its core is a channel nobody
   * can install. The page says so, and the list the release walks agrees with it.
   */
  const text = (await readFile(join(ROOT, 'docs', 'RELEASING.md'), 'utf8')).replace(/\s+/g, ' ');
  assert.match(
    text,
    /every channel depends at runtime on exactly the same-version `@agentcomms\/core`/i,
    'RELEASING.md does not say each channel pins the core of its own version',
  );
  assert.match(text, /core is packed and published before every channel/i, 'RELEASING.md does not put core first');
  assert.doesNotMatch(text, /depends at runtime on nothing else of this suite/i, 'the old runtime claim is back');
  assert.doesNotMatch(
    text,
    /first version can go out before the rest of the release/i,
    'RELEASING.md still lets a channel go out before its core',
  );
  assert.equal(PACKAGES.indexOf('core'), 0, 'core is not the first package published');
  const channels = REGISTRY.channels.filter((channel) => channel.directory !== 'core');
  assert.ok(channels.length > 0, 'no channel found — the discovery is wrong');
  for (const { directory } of channels) {
    assert.ok(PACKAGES.indexOf(directory) > 0, `@agentcomms/${directory} is not published after core`);
  }
});

test('running the list prints it, which is how the workflow reads it', async () => {
  const { status, stdout } = await runScript(join(ROOT, 'scripts', 'packages.mjs'), []);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), PACKAGES.join(' '));
});

/*
 * Every consumer reads the list rather than keeping a copy.
 *
 * Checked as text, because the consumers are a workflow and scripts that publish: neither can be run here. What is
 * asserted is the property that failed twice — a literal list of package names — together with the line that proves
 * the file reads the shared one instead.
 */
// Any two of the publishable packages side by side, quoted or as shell words. The names come from the shared list
// itself — the wide one, so a held package's name counts too: a pattern that knew only `core` and `gmail` let
// `'core', 'resend'` through.
const PACKAGE_WORD = `(?:${[...PUBLISHABLE].sort((a, b) => b.length - a.length).join('|')})`;
const LITERAL_LIST = new RegExp(
  String.raw`['"]${PACKAGE_WORD}['"]\s*,\s*['"]${PACKAGE_WORD}['"]|\b${PACKAGE_WORD}[ \t]+${PACKAGE_WORD}\b`,
);

test('the release workflow reads the shared list in every loop', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.doesNotMatch(workflow, LITERAL_LIST, 'the workflow carries its own package list again');

  const loops = [...workflow.matchAll(/for package in ([^;]+); do/g)].map((match) => match[1].trim());
  assert.ok(loops.length >= 2, 'expected a publish loop and a confirm loop');
  for (const loop of loops) {
    assert.match(loop, /^\$(pending|missing)$/, `a loop iterates something other than the shared list: ${loop}`);
  }
  // The publish loop walks what `release-ci.mjs pending` prints: the shared list, less what this commit has already
  // published. That script's own reading of the list is checked below.
  assert.match(
    workflow,
    /pending=\$\(node scripts\/release-ci\.mjs pending "\$version" "\$GITHUB_SHA"\)/,
    'the publish loop reads the shared list through the commit check',
  );
  assert.match(workflow, /missing=\$\(node scripts\/packages\.mjs\)/, 'the confirm loop reads the shared list');
  // An empty print would loop zero times and finish green, so the confirm loop refuses an empty list. The publish
  // loop's may rightly be empty — every package already out from this commit — and the confirm step after it still
  // asks the registry for every package in the list.
  assert.equal(
    [...workflow.matchAll(/\[ -n "\$missing" \] \|\| \{/g)].length,
    1,
    'the confirm loop refuses an empty list',
  );
});

test('REL-b: the version sync, the package verifier and the licence notices walk PUBLISHABLE; the release script and release-ci.mjs walk PACKAGES', async () => {
  /*
   * Two widths of one list (events phase A plan, decision 1). What proves a package publishable walks every package,
   * held or not, so a held one is still built, synced, licensed and consumer-checked; what publishes walks only what a
   * tag sends, so a held one is never read from the registry, proven or sent. A walker reading the wrong width either
   * stops checking the held package or starts publishing it.
   */
  const walkers = {
    'sync-versions.mjs': /for \(const name of PUBLISHABLE\)/,
    'verify-package.mjs': /for \(const name of PUBLISHABLE\)/,
    'third-party-licenses.mjs': /for \(const name of PUBLISHABLE\)/,
  };
  for (const [script, loop] of Object.entries(walkers)) {
    const source = await readFile(join(ROOT, 'scripts', script), 'utf8');
    assert.match(
      source,
      /import \{[^}]*\bPUBLISHABLE\b[^}]*\} from '\.\/packages\.mjs'/,
      `scripts/${script} does not import PUBLISHABLE`,
    );
    assert.match(source, loop, `scripts/${script} does not walk PUBLISHABLE`);
    assert.doesNotMatch(source, /\bPACKAGES\b/, `scripts/${script} reads the release's narrower list`);
    assert.doesNotMatch(source, LITERAL_LIST, `scripts/${script} carries its own package list`);
  }
  for (const script of ['release.mjs', 'release-ci.mjs']) {
    const source = await readFile(join(ROOT, 'scripts', script), 'utf8');
    assert.match(
      source,
      /import \{[^}]*\bPACKAGES\b[^}]*\} from '\.\/packages\.mjs'/,
      `scripts/${script} does not import PACKAGES`,
    );
    assert.match(source, /for \(const name of PACKAGES\)/, `scripts/${script} does not walk PACKAGES`);
    assert.doesNotMatch(source, /\bPUBLISHABLE\b/, `scripts/${script} reads the wide list, held packages and all`);
    assert.doesNotMatch(source, LITERAL_LIST, `scripts/${script} carries its own package list`);
  }
  // The shapes the copies took, with the last package published as well as the first two. Built from the list, since
  // this file is itself held to not writing one out (`test/channel-registry.test.mjs`).
  const [first, second] = PUBLISHABLE;
  const last = PUBLISHABLE.at(-1);
  for (const copy of [
    `const PACKAGES = ['${first}', '${second}'];`,
    `['${first}', '${last}']`,
    `for p in ${first} ${last}; do`,
  ]) {
    assert.match(copy, LITERAL_LIST, copy);
  }
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(root.scripts['verify:packages'], 'node scripts/verify-package.mjs --all');
});

test('REL-b: a held library is version-synced, and --check fails when it is left behind', async () => {
  const root = await treeWithShelf({ full: true });
  const sync = join(root, 'scripts', 'sync-versions.mjs');
  const shelfPath = join(root, 'packages', 'shelf', 'package.json');
  const old = JSON.parse(await readFile(shelfPath, 'utf8')).version;
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ ...rootManifest, version: '9.9.9' }, null, 2)}\n`);

  const written = await runScript(sync, []);
  assert.equal(written.status, 0, written.stderr);
  const shelf = JSON.parse(await readFile(shelfPath, 'utf8'));
  assert.equal(shelf.version, '9.9.9', 'the held library moves with the rest');
  assert.deepEqual(shelf.agentcommsRelease, { hold: 'Held until the first package that depends on it ships.' });
  assert.equal((await runScript(sync, ['--check'])).status, 0);

  // Left behind, as a sync that walked only what a tag publishes would leave it.
  await writeFile(shelfPath, `${JSON.stringify({ ...shelf, version: old }, null, 2)}\n`);
  const check = await runScript(sync, ['--check']);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /packages\/shelf\/package\.json: version is out of date/);
});

// ── The package verifier's dependency closure ──────────────────────────────────────────────────────────────────────

/** A workspace of bare manifests, each `@agentcomms/<directory>` at 1.0.0 plus `fields`; returns a directory finder. */
async function workspaceOf(manifests) {
  const root = await tempDir('verify-closure-');
  for (const [directory, fields] of Object.entries(manifests)) {
    await mkdir(join(root, 'packages', directory), { recursive: true });
    await writeFile(
      join(root, 'packages', directory, 'package.json'),
      JSON.stringify({ name: `@agentcomms/${directory}`, version: '1.0.0', ...fields }),
    );
  }
  return (directory) => join(root, 'packages', directory);
}

const closureNames = (directory) => workspaceClosure(directory).map((entry) => entry.name);

test('the package verifier gives the consumer every workspace package beneath the candidate, once each, dependencies first', async () => {
  /*
   * A wrapper over two packages that both need the same base — `gmail-mcp` over Gmail over core, with a second route to
   * core. Only the direct edges used to be packed: the base, two levels down, was left to npm, which fetched the copy
   * the registry had from the last release, or failed for a version not out yet.
   */
  const at = await workspaceOf({
    base: { dependencies: { zod: '^4.0.0' } },
    left: { dependencies: { '@agentcomms/base': 'workspace:*' } },
    right: { optionalDependencies: { '@agentcomms/base': 'workspace:*' } },
    top: {
      dependencies: { '@agentcomms/right': 'workspace:*', '@agentcomms/left': 'workspace:*', commander: '^15.0.0' },
      // A development edge is not installed with the candidate, so nothing is packed for it.
      devDependencies: { '@agentcomms/tooling': 'workspace:*' },
    },
    tooling: {},
  });
  assert.deepEqual(closureNames(at('top')), ['@agentcomms/base', '@agentcomms/left', '@agentcomms/right']);
  assert.deepEqual(
    workspaceClosure(at('top')).map((entry) => entry.directory),
    [at('base'), at('left'), at('right')],
    'each is packed from its own directory',
  );
  assert.deepEqual(closureNames(at('left')), ['@agentcomms/base']);
  assert.deepEqual(closureNames(at('base')), []);
});

test('the package verifier refuses a workspace circle, and an edge whose directory holds another package', async () => {
  const circle = await workspaceOf({
    first: { dependencies: { '@agentcomms/second': 'workspace:*' } },
    second: { optionalDependencies: { '@agentcomms/first': 'workspace:*' } },
  });
  assert.throws(
    () => workspaceClosure(circle('first')),
    /@agentcomms\/first → @agentcomms\/second → @agentcomms\/first/,
  );
  const misnamed = await workspaceOf({
    top: { dependencies: { '@agentcomms/base': 'workspace:*' } },
    base: { name: '@agentcomms/other' },
  });
  assert.throws(() => workspaceClosure(misnamed('top')), /@agentcomms\/base.*@agentcomms\/other/);
});

test('verifying any package of this checkout packs core first, and a server-only package its channel too', () => {
  // Every publishable package, held or not: a held one is consumer-checked like the rest.
  const position = (name) => PUBLISHABLE.indexOf(name.slice('@agentcomms/'.length));
  const libraries = new Set(REGISTRY.libraries.map((library) => library.directory));
  for (const name of PUBLISHABLE) {
    const closure = closureNames(join(ROOT, 'packages', name));
    assert.equal(new Set(closure).size, closure.length, `${name}: a package packed twice`);
    assert.deepEqual(
      closure,
      [...closure].sort((a, b) => position(a) - position(b)),
      `${name}: not in publish order`,
    );
    if (name === 'core') assert.deepEqual(closure, []);
    else if (libraries.has(name)) {
      // A library needs no core: its closure is exactly the workspace packages it declares at runtime.
      const manifest = REGISTRY.libraries.find((library) => library.directory === name).packageJson;
      const declared = Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })
        .filter(([, range]) => String(range).startsWith('workspace:'))
        .map(([dependency]) => dependency);
      assert.deepEqual([...closure].sort(), declared.sort(), `${name}: packs other than what it declares`);
    } else assert.equal(closure[0], '@agentcomms/core', `${name}: core is not packed for it, or not first`);
  }
  const wrappers = Object.entries(REGISTRY.wrappers);
  assert.ok(wrappers.length > 0, 'no server-only package found — the discovery is wrong');
  for (const [wrapper, channel] of wrappers) {
    assert.deepEqual(closureNames(join(ROOT, 'packages', wrapper)), ['@agentcomms/core', `@agentcomms/${channel}`]);
  }
});

test('the package verifier installs the whole closure, and no @agentcomms package from a registry', async () => {
  // The run itself is `pnpm verify:packages`; this holds the script to the two lines that make it prove anything.
  const verifier = await readFile(join(ROOT, 'scripts', 'verify-package.mjs'), 'utf8');
  assert.match(verifier, /for \(const \{ name, directory \} of workspaceClosure\(packageDir\)\)/);
  assert.match(
    verifier,
    /`--\$\{SCOPE\}:registry=\$\{registry\.url\}`/,
    'the scope is not sent to the refusing registry',
  );
  // Both installs go through the one helper that names the refusing registry, the workspace closure before the
  // candidate: installed after it, a dependency that sorts later was asked of the registry.
  assert.match(verifier, /const install = \(tarballs\) =>/);
  assert.match(verifier, /`--\$\{SCOPE\}:registry=\$\{registry\.url\}`,\s*\.\.\.tarballs,/);
  assert.match(verifier, /await install\(dependencyTarballs\);\s*await install\(\[tarball\]\);/);
  assert.equal(verifier.match(/runAsync\(\s*'npm',\s*\[\s*'install'/g)?.length, 1, 'one npm install helper, no other');
});

// ── The publish job's shape ──────────────────────────────────────────────────────────────────────────────────────

/** A version, the tagged commit and another commit, for the fake registry and the scripts that read it. */
const VERSION = '1.2.3';
const COMMIT = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

/** Every package already at VERSION on the fake registry, recorded as published from `commit`. */
function allPublishedFrom(commit) {
  return Object.fromEntries(PACKAGES.map((name) => [`@agentcomms/${name}`, { [VERSION]: commit }]));
}

/** Where `marker` first appears in the workflow; failing, rather than returning -1, when it does not. */
function stepIndex(workflow, marker) {
  const at = workflow.indexOf(marker);
  assert.notEqual(at, -1, `no step matching ${marker}`);
  return at;
}

test('the OIDC preflight runs before anything is published', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const preflight = stepIndex(workflow, 'node scripts/release-ci.mjs preflight');
  const publish = stepIndex(workflow, '--filter "@agentcomms/$package" publish');
  assert.ok(preflight < publish, 'the preflight must come before the first publish, or it proves nothing in time');
  // It must be in the publish job, which alone holds `id-token: write` and the `release` environment the trusted
  // publishers name. In another job the exchange would fail for every package, or pass for the wrong identity.
  const publishJob = workflow.indexOf('\n  publish:\n');
  const nextJob = workflow.indexOf('\n  github-release:\n');
  assert.ok(publishJob < preflight && preflight < nextJob, 'the preflight runs inside the publish job');
});

test('the publish sends only what this commit has not already published, and asks before sending any', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const step = /- name: publish\n\s+run: \|\n([\s\S]*?)\n\n/.exec(workflow)?.[1] ?? '';
  const pending = step.indexOf('pending=$(node scripts/release-ci.mjs pending "$version" "$GITHUB_SHA")');
  const loop = step.indexOf('for package in $pending; do');
  const publish = step.indexOf('--filter "@agentcomms/$package" publish');
  assert.ok(pending !== -1, 'the publish no longer asks which packages this commit has already published');
  assert.ok(pending < loop && loop < publish, 'every package is checked before the first one is sent');
  // The skip this replaced passed any publish at the version, whichever commit it came from.
  assert.doesNotMatch(step, /npm view/, 'the publish decides a skip by the version alone again');
  // The preflight is told the same version and commit, so it proves trust for exactly what will be sent.
  assert.match(workflow, /node scripts\/release-ci\.mjs preflight "\$\{GITHUB_REF_NAME#v\}" "\$GITHUB_SHA"/);
});

// The publish job's steps are bash, and its scripts run on the ubuntu publish runner; the Windows verify legs never
// execute them, and cannot run the fake `git`, `npm` and `gh` below, which are shell scripts.
const bashOnly = { skip: process.platform === 'win32' };

/** One step's `run: |` block from the workflow, as the script bash runs, or '' when there is no such step. */
function stepScript(workflow, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(
    `- name: ${escaped}\\n(?:\\s+env:\\n(?:\\s{10}.*\\n)+)?\\s+run: \\|\\n([\\s\\S]*?)(?:\\n\\n|$)`,
  ).exec(workflow)?.[1];
  return body ? `${body.replace(/^ {10}/gm, '')}\n` : '';
}

/**
 * Runs a step's script under bash, returning its exit status and output. Bounded, so a step that loops for ever
 * fails here with a message rather than hanging the suite.
 */
async function runStepScript(script, options) {
  try {
    const { stdout, stderr } = await exec('bash', [script], { encoding: 'utf8', timeout: 60_000, ...options });
    return { status: 0, stdout, stderr };
  } catch (error) {
    assert.ok(!error.killed, `${script} was still running after a minute`);
    return { status: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** What `git ls-remote` prints for the release tag: a lightweight tag is the commit itself. */
function lightweightTag(commit) {
  return `${commit}\trefs/tags/v${VERSION}\n`;
}

/** An annotated tag is an object of its own, and the line after it, `^{}`, is the commit it points to. */
function annotatedTag(commit) {
  return `${'e'.repeat(40)}\trefs/tags/v${VERSION}\n${commit}\trefs/tags/v${VERSION}^{}\n`;
}

/**
 * A `git` in `dir` that answers every call with `answer` and exits with `status`, writing down what it was asked.
 *
 * The scripts under test run `git ls-remote origin`, and nothing here may ask the real origin, so this must come first
 * on the PATH of every test that reaches that call.
 */
async function fakeGit(dir, answer, { status = 0, stderr = '' } = {}) {
  const log = join(dir, 'git.log');
  const output = join(dir, 'git.out');
  const errors = join(dir, 'git.err');
  await writeFile(output, answer);
  await writeFile(errors, stderr);
  await writeFile(
    join(dir, 'git'),
    `#!/bin/sh\necho "$@" >> "${log}"\ncat "${output}"\ncat "${errors}" >&2\nexit ${status}\n`,
    { mode: 0o755 },
  );
  await rm(log, { force: true });
  return { calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

test(
  'the publish step sends nothing past a package from another commit, and only what is missing',
  bashOnly,
  async () => {
    const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const dir = await tempDir('publish-step-');
    await writeFile(join(dir, 'step.sh'), stepScript(workflow, 'publish'));
    // A pnpm that writes down what it was asked to publish instead of publishing it.
    const sent = join(dir, 'sent.log');
    await writeFile(join(dir, 'pnpm'), `#!/bin/sh\necho "$@" >> "${sent}"\n`, { mode: 0o755 });

    async function runStep(published, tag = lightweightTag(COMMIT)) {
      await rm(sent, { force: true });
      const git = await fakeGit(dir, tag);
      const fake = await fakeOidc({ published });
      try {
        const path = `${dir}${delimiter}${process.env.PATH}`;
        const env = { ...fake.env, PATH: path, GITHUB_REF_NAME: `v${VERSION}`, GITHUB_SHA: COMMIT };
        const { status, stderr } = await runStepScript(join(dir, 'step.sh'), { cwd: ROOT, env });
        const calls = await readFile(sent, 'utf8').catch(() => '');
        return { status, stderr, calls: calls.split('\n').filter(Boolean), asked: await git.calls() };
      } finally {
        await fake.close();
      }
    }

    // The tag moved to a fix while this run was verifying. Nothing is out yet, and this run sends none of it: the
    // packages would be built from the commit the tag no longer names, and the run for the fix refused afterwards.
    const retagged = await runStep({}, lightweightTag(OTHER));
    assert.notEqual(retagged.status, 0, 'a tag that no longer names this commit must stop the publish');
    assert.deepEqual(retagged.calls, [], 'and nothing may be published before it does');
    assert.match(retagged.stderr, new RegExp(`v1\\.2\\.3 now names ${OTHER}, not ${COMMIT}`));
    assert.deepEqual(retagged.asked, [`ls-remote origin refs/tags/v${VERSION} refs/tags/v${VERSION}^{}`]);

    // The moved tag: core and gmail are out from another commit. The step fails, and pnpm is never called.
    const moved = await runStep({
      '@agentcomms/core': { [VERSION]: OTHER },
      '@agentcomms/gmail': { [VERSION]: OTHER },
    });
    assert.notEqual(moved.status, 0, 'a package out from another commit must fail the step');
    assert.deepEqual(moved.calls, [], 'and nothing may be published before it does');

    // The re-run: core and gmail are out from this commit, so only the rest go, each recording its commit.
    const rerun = await runStep({
      '@agentcomms/core': { [VERSION]: COMMIT },
      '@agentcomms/gmail': { [VERSION]: COMMIT },
    });
    assert.equal(rerun.status, 0);
    assert.deepEqual(
      rerun.calls.map((call) => /--filter @agentcomms\/([\w-]+) publish/.exec(call)?.[1]),
      PACKAGES.filter((name) => name !== 'core' && name !== 'gmail'),
    );
    assert.ok(rerun.calls.every((call) => call.startsWith('--config.pnpmfile=scripts/record-git-head.cjs ')));

    // The tag after a local release: everything is out from this commit, and nothing is sent.
    const local = await runStep(allPublishedFrom(COMMIT));
    assert.equal(local.status, 0);
    assert.deepEqual(local.calls, []);
  },
);

test('a run asks where its tag points now before the preflight, before the first publish and before the release page', async () => {
  // A run builds the commit its tag named when it started. Moved to a fix while the verify legs ran, the tag left
  // that run to publish every package from the old commit and then hang the release page on the new one, green.
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const check = 'node scripts/release-ci.mjs tag "$GITHUB_REF_NAME" "$GITHUB_SHA"';

  // The step just before the preflight is the check, with only the preflight's comments between them.
  const beforePreflight = new RegExp(
    `run: ${check.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(?:[ \\t]*(?:#.*)?\\n)*\\s+- name: every package still to publish trusts this workflow`,
  );
  assert.match(workflow, beforePreflight, 'the tag is not checked immediately before the OIDC preflight');

  // Again in the publish step, after `pending` has read the registry and immediately before the loop that sends.
  const publish = stepScript(workflow, 'publish');
  const at = publish.indexOf(check);
  assert.ok(at > publish.indexOf('pending=$(node scripts/release-ci.mjs pending'), 'checked after pending');
  const loop = publish.indexOf('for package in $pending; do');
  assert.ok(at !== -1 && at < loop, 'the tag is not checked again before the first publish');
  assert.doesNotMatch(
    publish.slice(at + check.length, loop),
    /\n\s*[^\s#]/,
    'nothing runs between the check and the loop',
  );

  // And before the release page is made, which `--verify-tag` hangs on wherever the tag points by then.
  const release = stepScript(workflow, 'create the release from the changelog');
  const beforeRelease = release.indexOf(check);
  assert.ok(beforeRelease !== -1 && beforeRelease < release.indexOf('gh release create'));
});

test('two runs for one tag never reach the publish together', async () => {
  // Moving a tag starts a second run for it. Queued behind the first, it cannot race it to the registry; the first,
  // asked where the tag points now, stops before publishing. Not cancelled, because a run cancelled part way through
  // its publish loop leaves a version half out.
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false\n/m);
});

test('the GitHub release is not made on a tag that has moved since the run started', bashOnly, async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const dir = await tempDir('release-step-');
  await writeFile(join(dir, 'step.sh'), stepScript(workflow, 'create the release from the changelog'));
  const changelog = join(dir, 'CHANGELOG.md');
  await writeFile(changelog, `# Changelog\n\n## ${VERSION}\n\nA thing.\n`);
  // A gh with no release for the tag yet, which writes down what it was asked to create.
  const made = join(dir, 'gh.log');
  await writeFile(join(dir, 'gh'), `#!/bin/sh\n[ "$1 $2" = "release view" ] && exit 1\necho "$@" >> "${made}"\n`, {
    mode: 0o755,
  });

  async function runStep(tag) {
    await rm(made, { force: true });
    await fakeGit(dir, tag);
    const env = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      GITHUB_REF_NAME: `v${VERSION}`,
      GITHUB_SHA: COMMIT,
      GITHUB_REPOSITORY: 'example/agent-communications',
      RUNNER_TEMP: dir,
      RELEASE_CHANGELOG: changelog,
    };
    const { status, stderr } = await runStepScript(join(dir, 'step.sh'), { cwd: ROOT, env });
    const calls = (await readFile(made, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return { status, stderr, calls };
  }

  const still = await runStep(annotatedTag(COMMIT));
  assert.equal(still.status, 0, still.stderr);
  assert.equal(still.calls.length, 1);
  assert.match(still.calls[0], /^release create v1\.2\.3 .*--verify-tag/);

  // The packages went out from this commit, then the tag moved: a page on the new commit would name a build that
  // is not the one on npm. The run fails instead, and the moved tag's own run says to put it back.
  const moved = await runStep(annotatedTag(OTHER));
  assert.notEqual(moved.status, 0);
  assert.deepEqual(moved.calls, [], 'no release page for a tag that no longer names what was published');
  assert.match(moved.stderr, new RegExp(`v1\\.2\\.3 now names ${OTHER}, not ${COMMIT}`));
});

test('the confirm step passes only what the registry records as published from this commit', bashOnly, async () => {
  // It is what the GitHub release waits for. Counting a version by its number alone, it passed one from any commit.
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const dir = await tempDir('confirm-step-');
  await writeFile(join(dir, 'step.sh'), stepScript(workflow, 'confirm what reached the registry'));
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const registry = join(dir, 'registry');
  const late = join(dir, 'late');
  // An npm that answers `npm view <package>@<version> gitHead` from `registry/`, and only that; and a sleep that
  // makes whatever is in `late/` visible instead of waiting, so a retry costs nothing here.
  await writeFile(
    join(dir, 'npm'),
    '#!/bin/sh\n' +
      `[ "$1" = view ] && [ "$3" = gitHead ] || { echo "unexpected npm $*" >&2; exit 2; }\n` +
      `answer="${registry}/$(printf %s "$2" | tr / _)"\n` +
      '[ -f "$answer" ] || { echo "npm error code E404" >&2; exit 1; }\n' +
      'cat "$answer"\n',
    { mode: 0o755 },
  );
  const waits = join(dir, 'sleep.log');
  await writeFile(
    join(dir, 'sleep'),
    `#!/bin/sh\necho "$@" >> "${waits}"\nfor f in "${late}"/*; do [ -e "$f" ] && mv "$f" "${registry}/"; done\nexit 0\n`,
    { mode: 0o755 },
  );

  /** `now` and `later` map a package to the commit its version records; `later` appears after the first wait. */
  async function confirm({ now = {}, later = {} }) {
    for (const path of [registry, late, waits]) await rm(path, { recursive: true, force: true });
    await mkdir(registry);
    await mkdir(late);
    for (const [into, answers] of [
      [registry, now],
      [late, later],
    ]) {
      for (const [name, head] of Object.entries(answers)) {
        await writeFile(join(into, `@agentcomms_${name}@${version}`), `${head}\n`);
      }
    }
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GITHUB_SHA: COMMIT };
    const result = await runStepScript(join(dir, 'step.sh'), { cwd: ROOT, env });
    const slept = (await readFile(waits, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    return { ...result, slept };
  }

  const everyPackage = (head) => Object.fromEntries(PACKAGES.map((name) => [name, head]));

  const done = await confirm({ now: everyPackage(COMMIT) });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /All confirmed/);
  assert.equal(done.slept, 0);

  // Not visible yet is still waited for, as before: confirmed once it arrives, and a failure if it never does.
  const [first, ...rest] = PACKAGES;
  const others = Object.fromEntries(rest.map((name) => [name, COMMIT]));
  const arrived = await confirm({ now: others, later: { [first]: COMMIT } });
  assert.equal(arrived.status, 0, arrived.stderr);
  assert.equal(arrived.slept, 1, 'one that arrives after a wait is confirmed then');
  const never = await confirm({ now: others });
  assert.equal(never.status, 1, 'a package that never arrives is not a pass');
  assert.match(never.stderr, new RegExp(`after retrying:\\s*${first}\\b`));

  // At the version, from another commit: it fails at once, since a published version never changes, naming it —
  // and the GitHub release, which needs this job, is not made.
  const foreign = await confirm({ now: { ...everyPackage(COMMIT), [PACKAGES.at(-1)]: OTHER } });
  assert.equal(foreign.status, 1);
  assert.equal(foreign.slept, 0, 'nothing to wait for: the commit a version records cannot change');
  assert.match(
    foreign.stderr,
    new RegExp(`@agentcomms/${PACKAGES.at(-1)}@${escapeRegExp(version)} was published from ${OTHER}`),
  );
});

test('every publish records the commit it came from, which pnpm does not do on its own', async () => {
  // `npm publish` writes `gitHead` into the published manifest; pnpm 11 publishes the manifest from package.json
  // and adds nothing, so without this hook the registry cannot say which commit a version came from, and the check
  // above would refuse every package already out.
  const { hooks } = createRequire(import.meta.url)(join(ROOT, 'scripts', 'record-git-head.cjs'));
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })).stdout.trim();
  const manifest = { name: '@agentcomms/core', version: '1.2.3', dependencies: { zod: '^4.0.0' } };
  assert.deepEqual(await hooks.beforePacking(manifest, join(ROOT, 'packages', 'core')), { ...manifest, gitHead: head });

  // Both publishes pass it, and the package verifier packs with it and reads the field back — which is what proves
  // the pinned pnpm still applies it, before anything is sent.
  const flag = '--config.pnpmfile=scripts/record-git-head.cjs';
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(workflow.includes(`pnpm ${flag} --filter "@agentcomms/$package" publish`), 'the workflow publish');
  const script = await readFile(join(ROOT, 'scripts', 'release.mjs'), 'utf8');
  const publish = /runLoud\('pnpm', \[([^\]]*'publish'[^\]]*)\]\)/.exec(script)?.[1] ?? '';
  assert.ok(publish.includes(`'${flag}'`), 'the local publish');
  const verifier = await readFile(join(ROOT, 'scripts', 'verify-package.mjs'), 'utf8');
  assert.match(verifier, /'record-git-head\.cjs'/, 'the package verifier packs as the publish does');
  assert.match(verifier, /packedManifest\.gitHead !== head/, 'and refuses a tarball that does not name the commit');
});

test('the local release script publishes a prerelease under next, as the workflow does', async () => {
  const script = await readFile(join(ROOT, 'scripts', 'release.mjs'), 'utf8');
  const rule = /const distTag = version\.includes\('-'\) \? 'next' : 'latest';/.exec(script);
  assert.ok(rule, 'the script no longer chooses the dist-tag from the version');
  const publish = /runLoud\('pnpm', \[([^\]]*'publish'[^\]]*)\]\)/.exec(script)?.[1] ?? '';
  assert.match(publish, /'--tag',\s*distTag/, 'every publish must name the tag, or npm moves `latest`');
  assert.ok(rule.index < script.indexOf(publish), 'the tag is decided before anything is sent');
});

test('the local release confirms a prerelease it published under next, not only a stable one', async () => {
  // What `npm dist-tag ls` printed after a `-rc.1` went out under `next`: `latest` still names the previous stable
  // version. Reading only the `latest` line made every attempt report the release as not visible, and the script
  // exited 1 after a publish that had succeeded.
  const registry =
    ({ tags, viewed = null }) =>
    (npmArgs) =>
      npmArgs[0] === 'dist-tag' ? tags : viewed;
  const name = '@agentcomms/core';

  const prerelease = registry({ tags: 'latest: 0.4.0\nnext: 0.4.1-rc.1' });
  assert.equal(isVisible({ name, version: '0.4.1-rc.1', distTag: 'next', npm: prerelease }), true);

  const stable = registry({ tags: 'latest: 0.4.1\nnext: 0.4.1-rc.1' });
  assert.equal(isVisible({ name, version: '0.4.1', distTag: 'latest', npm: stable }), true);

  // Not there yet, by either path: the caller retries rather than reporting success.
  const early = registry({ tags: 'latest: 0.4.0' });
  assert.equal(isVisible({ name, version: '0.4.1', distTag: 'latest', npm: early }), false);

  // The tag endpoint behind the packument, or unreachable: the exact version on the packument is still an answer.
  const lagging = registry({ tags: 'latest: 0.4.0', viewed: '0.4.1' });
  assert.equal(isVisible({ name, version: '0.4.1', distTag: 'latest', npm: lagging }), true);
  const unreachable = registry({ tags: null, viewed: '0.4.1-rc.1' });
  assert.equal(isVisible({ name, version: '0.4.1-rc.1', distTag: 'next', npm: unreachable }), true);

  // And the script asks about the tag it published under, not a fixed one.
  const script = await readFile(join(ROOT, 'scripts', 'release.mjs'), 'utf8');
  // The variable itself, by shorthand: `distTag: 'latest'` also contains the word, and asked a prerelease's
  // confirmation about the wrong tag.
  const call = /isVisible\(\{(.*)\}\)/.exec(script)?.[1] ?? '';
  assert.match(
    call,
    /(^|,)\s*distTag\s*(,|$)/,
    `the confirmation must be told the tag it was published under: ${call}`,
  );
  // …and the tag it tells a person to push names the commit that was published, not whatever HEAD is by then.
  assert.match(script, /git tag v\$\{version\} \$\{local \?\? 'HEAD'\}/);
  assert.match(script, /^const local = quiet\(\(\) => run\('git', \['rev-parse', 'HEAD'\]\)\);$/m);
});

test('the registry confirmation has room for the lag seen on real releases', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const attempts = Number(/for attempt in \$\(seq 1 (\d+)\)/.exec(workflow)?.[1]);
  const pause = Number(/sleep (\d+)\n\s+done/.exec(workflow)?.[1]);
  // 0.4.0's last package became visible after about four minutes; the budget must be well past that.
  assert.ok(attempts * pause >= 600, `the confirm step gives up after ${attempts * pause}s`);
});

test('a tag gets its GitHub release from the changelog, after the publish is confirmed', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const job = workflow.slice(stepIndex(workflow, '\n  github-release:\n'));
  assert.match(job, /needs: publish/, 'it must wait for the publish job, whose last step confirms the registry');
  assert.match(job, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(job, /contents: write/);
  assert.match(job, /node scripts\/release-ci\.mjs notes "\$version"/, 'the body is the changelog section');
  assert.match(job, /gh release view/, 'a re-run leaves an existing release alone');
  assert.match(job, /gh release create "\$GITHUB_REF_NAME"[^\n]*--verify-tag/);

  // And the tag gate reads the same section before anything is published, so a missing entry stops the release
  // with nothing sent rather than after the packages are out.
  const gate = workflow.indexOf('node scripts/release-ci.mjs notes "$tag"');
  assert.ok(gate !== -1 && gate < stepIndex(workflow, 'node scripts/release-ci.mjs preflight'));
});

test('the release documents say a pushed tag publishes, and that it must not move once a package is out', async () => {
  // The required reviewer was removed, but RELEASING.md's procedure still said the tag push "does not publish", under
  // a heading saying a person approves releases, and the workflow's header said it waited for a human. That is the
  // part of the page people copy from, about the one step that cannot be undone.
  const documents = ['docs/RELEASING.md', '.claude/skills/release/SKILL.md', '.github/workflows/release.yml'];
  for (const path of documents) {
    const text = await readFile(join(ROOT, path), 'utf8');
    assert.doesNotMatch(text, /does not publish/i, `${path} says the tag push does not publish`);
    const approval = /a person approves|approve the publish|waits for a\s+(?:#\s*)?human/i;
    assert.doesNotMatch(text, approval, `${path} says somebody approves the release after the tag`);
  }
  // A re-run keeps the tagged commit, and a package out from another commit now stops the run, so the advice for a
  // partial failure that needs a fix is a new version — not the moved tag both documents used to lead to.
  for (const path of documents.slice(0, 2)) {
    const text = (await readFile(join(ROOT, path), 'utf8')).replace(/\s+/g, ' ');
    assert.match(text, /the tag must not move/, `${path} does not say the tag stays once a package is out`);
    assert.doesNotMatch(text, /fix the cause and re-run the failed job/i, `${path} still offers a re-run for a fix`);
  }
});

test('the release documents say what moving a tag does to a run still going', async () => {
  // Both said a tag "whose run published nothing" could be moved to the fix. A run still in its verify legs has
  // published nothing too, and moving its tag left it to publish the old commit. Now the run stops if its tag has
  // moved when it asks, but a move after its last ask is too late, so the advice is to cancel it or let it finish.
  for (const path of ['docs/RELEASING.md', '.claude/skills/release/SKILL.md']) {
    const text = (await readFile(join(ROOT, path), 'utf8')).replace(/\s+/g, ' ');
    assert.doesNotMatch(text, /whose run published nothing/i, `${path} still lets a tag move under a run in progress`);
    assert.match(text, /never move or delete a tag while its run is in progress/i, `${path}: moving a tag mid-run`);
    assert.match(
      text,
      /still names the commit (?:it|the run) started from/i,
      `${path} does not say what the run checks`,
    );
  }
});

test('REL-d: the release documents say what a hold is, and how it is lifted', async () => {
  /*
   * A held package is checked on every verify and left out of every tag's publish until its hold is lifted, in the
   * version commit of the first release that ships something depending on it. Whoever releases then is sent from both
   * documents to the hand publish every package's first version needs. Neither may say a tag "does not publish": the
   * test above refuses that phrase in both.
   */
  const releasing = (await readFile(join(ROOT, 'docs', 'RELEASING.md'), 'utf8')).replace(/\s+/g, ' ');
  const at = releasing.indexOf('## A package held back from release ');
  assert.notEqual(at, -1, 'RELEASING.md has no "A package held back from release" section');
  const next = releasing.indexOf(' ## ', at + 1);
  const section = releasing.slice(at, next === -1 ? undefined : next);
  assert.match(section, /"agentcommsRelease": \{ "hold": /, 'it does not say where a hold is declared');
  assert.match(section, /every `pnpm verify`/, 'it does not say what still checks a held package');
  assert.match(section, /is left out of the release/, 'it does not say a tag leaves the held package out');
  assert.match(section, /\(#a-new-packages-first-version\)/, 'it does not send the first release to the hand publish');
  // Decision 1's five steps, in order: lift the hold in the version commit, tag, publish by hand, trust, re-run.
  const steps = [
    /delete `agentcommsRelease`/,
    /Tag and push as usual/,
    /--filter @agentcomms\/<name> publish --access public --no-git-checks --tag latest/,
    /Trusted publishing/,
    /Re-run the failed job/,
  ].map((step) => {
    const found = step.exec(section);
    assert.ok(found, `the section has no step matching ${step}`);
    return found.index;
  });
  assert.deepEqual(
    steps,
    [...steps].sort((a, b) => a - b),
    'the steps are out of order',
  );
  // "The packages" names both widths of the list.
  const packages = releasing.slice(releasing.indexOf('## The packages '), releasing.indexOf('## The order, and why'));
  assert.match(packages, /`PACKAGES`/);
  assert.match(packages, /`PUBLISHABLE`/);

  const skill = (await readFile(join(ROOT, '.claude', 'skills', 'release', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
  assert.match(skill, /`agentcommsRelease`/, 'the release skill does not name the hold');
  assert.match(skill, /is left out of the release/, 'the release skill does not say a held package is left out');
  assert.match(skill, /every `pnpm verify`/, 'the release skill does not say what still checks it');
  assert.match(skill, /A new package's first version/, 'the release skill does not send its first release by hand');
});

// ── The OIDC preflight and the commit check, against a fake GitHub and a fake registry ───────────────────────────

test('REL-B1: B1 through Phase D stay held, while their eventual owner publish is events then events-daemon from one checked tag', async () => {
  assert.ok(PUBLISHABLE.includes('events'), '@agentcomms/events is consumer-checked while held');
  assert.ok(PUBLISHABLE.includes('events-daemon'), '@agentcomms/events-daemon is consumer-checked while held');
  assert.ok(Object.hasOwn(HELD, 'events'), '@agentcomms/events remains held for B1');
  assert.ok(Object.hasOwn(HELD, 'events-daemon'), '@agentcomms/events-daemon remains held for B1');
  assert.ok(!PACKAGES.includes('events'), '@agentcomms/events is absent from a B1 tag publish');
  assert.ok(!PACKAGES.includes('events-daemon'), '@agentcomms/events-daemon is absent from a B1 tag publish');

  const release = (await readFile(join(ROOT, 'docs', 'RELEASING.md'), 'utf8')).replace(/\s+/g, ' ');
  assert.match(release, /A B1, B2 or Phase D merge publishes neither package/i);
  assert.match(release, /same checked tag/i);
  assert.match(
    release,
    /owner first publishes `@agentcomms\/events`, then publishes `@agentcomms\/events-daemon`/i,
    'the daemon follows the library that it depends on',
  );
});

test('REL-B2: the held B2 and Phase-D runtime stays out of publication and the release browser gate proves loopback SSE/CORS', async () => {
  assert.ok(PUBLISHABLE.includes('events'), '@agentcomms/events remains consumer-checked for B2');
  assert.ok(PUBLISHABLE.includes('events-daemon'), '@agentcomms/events-daemon remains consumer-checked for B2');
  assert.ok(Object.hasOwn(HELD, 'events'), '@agentcomms/events remains held for B2');
  assert.ok(Object.hasOwn(HELD, 'events-daemon'), '@agentcomms/events-daemon remains held for B2');
  assert.ok(!PACKAGES.includes('events'), '@agentcomms/events is absent from a B2 tag publish');
  assert.ok(!PACKAGES.includes('events-daemon'), '@agentcomms/events-daemon is absent from a B2 tag publish');

  const [readme, release] = await Promise.all([
    readFile(join(ROOT, 'packages', 'events-daemon', 'README.md'), 'utf8'),
    readFile(join(ROOT, 'docs', 'RELEASING.md'), 'utf8'),
  ]);
  assert.match(readme, /B2 adds no command or MCP tool/i, 'B2 does not create a new public surface');
  assert.match(readme, /delivery retry, drop or hold/i, 'B3 delivery controls remain absent');
  assert.match(readme, /subscriber management/i, 'B3 subscriber controls remain absent');
  assert.match(readme, /named event-secret or migration operation/i, 'B3 secret operations remain absent');
  assert.match(
    release,
    /both held throughout B1, B2 and Phase D/i,
    'the release guide keeps both packages held through Phase D',
  );
  assert.match(
    readme,
    /held from publication throughout B1, B2 and Phase D/i,
    'the daemon README keeps both packages held through Phase D',
  );
  assert.match(release, /loopback daemon SSE\/CORS/i, 'the release browser gate includes B2 SSE/CORS verification');
});

/**
 * One loopback server playing both parts. GitHub hands out numbered ID tokens; the registry mints a publish token
 * for every package except those in `untrusted`, and records which ID token each exchange carried.
 *
 * The registry also serves each package's packument. `published` maps a package to the versions it has, each to the
 * commit recorded as its `gitHead` (null for none); a package it does not name is a 404, as on npm for a package that
 * has never been published, and `packumentStatus` makes every packument answer with that status instead.
 */
async function fakeOidc({ untrusted = [], emptyToken = [], published = {}, packumentStatus = 200 } = {}) {
  let issued = 0;
  const exchanges = [];
  const audiences = [];
  const reads = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/id-token') {
      assert.equal(request.headers.authorization, 'Bearer fake-request-token');
      audiences.push(url.searchParams.get('audience'));
      issued += 1;
      response.end(JSON.stringify({ value: `id-token-${issued}` }));
      return;
    }
    const match = /^\/-\/npm\/v1\/oidc\/token\/exchange\/package\/(.+)$/.exec(url.pathname);
    if (match && request.method === 'POST') {
      const name = decodeURIComponent(match[1]);
      exchanges.push({ name, raw: match[1], idToken: request.headers.authorization });
      if (untrusted.includes(name)) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: `no trusted publisher configured for ${name}` }));
        return;
      }
      const token = emptyToken.includes(name) ? '' : `minted-publish-token-${exchanges.length}`;
      response.end(JSON.stringify({ token }));
      return;
    }
    const packument = /^\/(@agentcomms%2f[\w-]+)$/.exec(url.pathname);
    if (packument && request.method === 'GET') {
      const name = decodeURIComponent(packument[1]);
      reads.push(name);
      const versions = published[name];
      if (packumentStatus !== 200 || !versions) {
        response.statusCode = packumentStatus !== 200 ? packumentStatus : 404;
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const manifests = Object.entries(versions).map(([version, gitHead]) => [
        version,
        { name, version, ...(gitHead ? { gitHead } : {}) },
      ]);
      response.end(JSON.stringify({ name, versions: Object.fromEntries(manifests) }));
      return;
    }
    response.statusCode = 500;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    exchanges,
    audiences,
    reads,
    env: {
      ...process.env,
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/id-token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-request-token',
      NPM_CONFIG_REGISTRY: `http://127.0.0.1:${port}/`,
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const CI = join(ROOT, 'scripts', 'release-ci.mjs');

/**
 * Every package on the registry at an earlier version, from another commit, merged with `extra`: each exists, so
 * whether it trusts this workflow is the question. A package the registry has never seen is another question, below.
 */
function allExist(extra = {}) {
  const published = Object.fromEntries(PACKAGES.map((name) => [`@agentcomms/${name}`, { '1.2.2': OTHER }]));
  for (const [name, versions] of Object.entries(extra)) published[name] = { ...published[name], ...versions };
  return published;
}

test('the preflight passes only when every package exchanges, and never prints a token', async () => {
  const fake = await fakeOidc({ published: allExist() });
  try {
    const result = await runScript(CI, ['preflight', VERSION, COMMIT], { env: fake.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fake.exchanges.map((exchange) => exchange.name),
      PACKAGES.map((name) => `@agentcomms/${name}`),
      'every package, in order, is asked',
    );
    // The name is escaped the way npm's own client escapes it, or the registry answers for a different path.
    assert.ok(fake.exchanges.every((exchange) => exchange.raw.startsWith('@agentcomms%2f')));
    // A fresh ID token per exchange: npm may refuse one it has seen, and the publish needs its own.
    assert.equal(new Set(fake.exchanges.map((exchange) => exchange.idToken)).size, PACKAGES.length);
    assert.ok(
      fake.audiences.every((audience) => audience === 'npm:127.0.0.1'),
      'the audience names the registry',
    );
    assert.doesNotMatch(result.stdout + result.stderr, /minted-publish-token|id-token-\d/);
  } finally {
    await fake.close();
  }
});

test('the preflight fails, naming the package, when one has no trusted publisher', async () => {
  const fake = await fakeOidc({ untrusted: ['@agentcomms/slack'], published: allExist() });
  try {
    const result = await runScript(CI, ['preflight', VERSION, COMMIT], { env: fake.env });
    assert.equal(result.status, 1, 'a package npm refuses must stop the release before any publish');
    assert.match(result.stderr, /@agentcomms\/slack has no trusted publisher for this workflow; nothing was published/);
    assert.match(result.stdout, /✗ @agentcomms\/slack: npm refused the exchange \(HTTP 404\): no trusted publisher/);
    assert.doesNotMatch(result.stderr, /@agentcomms\/core has/, 'only the package that failed is named');
    assert.doesNotMatch(result.stdout + result.stderr, /minted-publish-token/);
  } finally {
    await fake.close();
  }
});

test('the preflight does not count a 200 without a token as trust', async () => {
  const fake = await fakeOidc({ emptyToken: ['@agentcomms/gmail'], published: allExist() });
  try {
    const result = await runScript(CI, ['preflight', VERSION, COMMIT], { env: fake.env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✗ @agentcomms\/gmail: npm answered 200 without a token/);
  } finally {
    await fake.close();
  }
});

test('the preflight names a package npm has never seen, prints its first publish from this commit, and sends nothing', async () => {
  // npm keeps trusted publishers per package and will not hold one for a package that does not exist, so a new
  // package's first version cannot come from this workflow. The preflight used to tell the owner to add a trusted
  // publisher for it, which npm refuses; now it says the package was never published and how to send it once by hand.
  const unborn = ['@agentcomms/resend', '@agentcomms/whatsapp'];
  const published = allExist();
  for (const name of unborn) delete published[name];
  const fake = await fakeOidc({ published });
  try {
    const result = await runScript(CI, ['preflight', VERSION, COMMIT], { env: fake.env });
    assert.equal(result.status, 1, 'a package this workflow cannot publish must stop the release before any publish');
    // Not asked about: an exchange for a package that does not exist cannot succeed. The rest still are, so one run
    // reports everything that stands in the way.
    assert.deepEqual(
      fake.exchanges.map((exchange) => exchange.name),
      PACKAGES.map((name) => `@agentcomms/${name}`).filter((name) => !unborn.includes(name)),
    );
    for (const name of unborn) {
      assert.match(result.stdout, new RegExp(`✗ ${name}: never published — npm has no such package`));
      // The same publish the workflow runs, through the hook that records this commit, so the re-run skips it.
      assert.ok(
        result.stdout.includes(
          `  pnpm --config.pnpmfile=scripts/record-git-head.cjs --filter ${name} publish --access public --no-git-checks --tag latest\n`,
        ),
        result.stdout,
      );
    }
    assert.match(result.stdout, new RegExp(`First publish, by hand, from this commit \\(${COMMIT}\\)`));
    assert.match(
      result.stderr,
      /Nothing was published\. @agentcomms\/resend, @agentcomms\/whatsapp have never been published, and npm cannot hold a trusted publisher for a package that does not exist/,
    );
    assert.match(
      result.stderr,
      new RegExp(`the commands above, which record ${COMMIT} as its gitHead so this job skips it`),
    );
    assert.match(
      result.stderr,
      /add each one’s trusted publisher on npmjs\.com → the package → Settings → Trusted publishing/,
    );
    assert.match(result.stderr, /then re-run this job\./);
    assert.doesNotMatch(result.stderr, /has no trusted publisher/, 'a package that exists and trusts it is not blamed');
    assert.doesNotMatch(result.stdout + result.stderr, /minted-publish-token/);
  } finally {
    await fake.close();
  }

  // One never published and one without a trusted publisher: both named, in one run. A prerelease's first publish
  // goes under `next`, as the workflow's own publish of it would.
  const mixed = allExist();
  delete mixed['@agentcomms/whatsapp'];
  const both = await fakeOidc({ published: mixed, untrusted: ['@agentcomms/slack'] });
  try {
    const result = await runScript(CI, ['preflight', '1.2.3-rc.1', COMMIT], { env: both.env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /--filter @agentcomms\/whatsapp publish --access public --no-git-checks --tag next\n/);
    assert.match(result.stderr, /@agentcomms\/whatsapp has never been published/);
    assert.match(result.stderr, /Publish it once by hand from this commit with the command above/);
    assert.match(result.stderr, /add its trusted publisher on npmjs\.com/);
    assert.match(result.stderr, /@agentcomms\/slack has no trusted publisher for this workflow; nothing was published/);
  } finally {
    await both.close();
  }
});

test('the preflight refuses without the OIDC permission, since the publish could not work either', async () => {
  const env = { ...process.env };
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  // A port nothing listens on, so a regression that asked the registry first could never reach the real one.
  env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:9/';
  const result = await runScript(CI, ['preflight', VERSION, COMMIT], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /id-token: write/);
});

test('the preflight proves nothing for a package already out from this commit, so a tag after a local release passes', async () => {
  // The documented fallback: `pnpm release:publish` sends every package from a laptop, then the tag is pushed for
  // its GitHub release. A package with no trusted publisher is exactly when that fallback gets used, and the
  // preflight exchanged for it anyway — a red run and no release page, for a version that was on npm.
  const fake = await fakeOidc({ untrusted: ['@agentcomms/slack'], published: allPublishedFrom(COMMIT) });
  try {
    const result = await runScript(CI, ['preflight', VERSION, COMMIT], { env: fake.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fake.exchanges, [], 'nothing is left to publish, so no token is asked for');
    assert.match(result.stdout, /nothing to prove/);
  } finally {
    await fake.close();
  }

  // Part way: what is out from this commit is skipped, what is not is still proven, and a refusal still stops it.
  const outAlready = { '@agentcomms/core': { [VERSION]: COMMIT }, '@agentcomms/gmail': { [VERSION]: COMMIT } };
  const partial = await fakeOidc({ untrusted: ['@agentcomms/slack'], published: allExist(outAlready) });
  try {
    const result = await runScript(CI, ['preflight', VERSION, COMMIT], { env: partial.env });
    assert.equal(result.status, 1);
    // Everything but the two already out, in publish order.
    assert.deepEqual(
      partial.exchanges.map((exchange) => exchange.name),
      PACKAGES.map((name) => `@agentcomms/${name}`).filter((name) => !Object.hasOwn(outAlready, name)),
    );
    assert.match(result.stderr, /@agentcomms\/slack has no trusted publisher for this workflow/);
  } finally {
    await partial.close();
  }
});

test('an empty package list fails the run, rather than reading as everything already published', async () => {
  // The step used to refuse an empty list itself; now it asks `pending`, where "nothing left to send" is a real
  // answer. So `pending` is what must tell the two apart.
  const scratch = await tempDir('empty-list-');
  await mkdir(join(scratch, 'scripts'), { recursive: true });
  await cp(CI, join(scratch, 'scripts', 'release-ci.mjs'));
  // The list is derived from the channels under `packages/`, so the copy reads the registry from an empty tree.
  await cp(join(ROOT, 'scripts', 'channels.mjs'), join(scratch, 'scripts', 'channels.mjs'));
  await mkdir(join(scratch, 'packages'), { recursive: true });
  const shared = await readFile(join(ROOT, 'scripts', 'packages.mjs'), 'utf8');
  const emptied = shared.replace(/Object\.freeze\(\[[^\]]*\]\)/, 'Object.freeze([])');
  assert.notEqual(emptied, shared, 'the list is still declared as one frozen array');
  await writeFile(join(scratch, 'scripts', 'packages.mjs'), emptied);
  const result = await runScript(join(scratch, 'scripts', 'release-ci.mjs'), ['pending', VERSION, COMMIT]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /lists no packages/);
});

test('REL-a: a held package is never read, proven, sent or confirmed by a release', async () => {
  /*
   * Decision 1 of the events phase A plan: a package can be held back from a tag's publish while every check still
   * walks it. Held, `shelf` must be absent from what the workflow's loops read — the printed list (the confirm loop),
   * `pending` (the publish loop) and the preflight — and the registry must never be asked about it.
   */
  const root = await treeWithShelf();
  const scripts = join(root, 'scripts');
  const printed = await runScript(join(scripts, 'packages.mjs'), []);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.trim(), PACKAGES.join(' '), 'the copy prints the same six packages');
  assert.doesNotMatch(printed.stdout, /\bshelf\b/);

  const fake = await fakeOidc({ published: allExist() });
  try {
    const pending = await runScript(join(scripts, 'release-ci.mjs'), ['pending', VERSION, COMMIT], { env: fake.env });
    assert.equal(pending.status, 0, pending.stderr);
    assert.equal(pending.stdout.trim(), PACKAGES.join(' '), 'the publish loop is given exactly the released packages');
    const preflight = await runScript(join(scripts, 'release-ci.mjs'), ['preflight', VERSION, COMMIT], {
      env: fake.env,
    });
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.doesNotMatch(preflight.stdout + preflight.stderr, /shelf/);
    assert.ok(!fake.reads.includes('@agentcomms/shelf'), `its packument was read: ${fake.reads.join(', ')}`);
    assert.ok(
      !fake.exchanges.some((exchange) => exchange.name === '@agentcomms/shelf'),
      'a token was exchanged for it',
    );
    // Not vacuous: every released package was asked about, by both.
    for (const name of PACKAGES) {
      assert.ok(fake.reads.includes(`@agentcomms/${name}`), `${name} was not read`);
      assert.ok(
        fake.exchanges.some((exchange) => exchange.name === `@agentcomms/${name}`),
        `${name} was not proven`,
      );
    }
  } finally {
    await fake.close();
  }

  // The hold lifted, the same release reaches the library — and, never published, it stops for its first version by
  // hand: the path decision 1 sends the owner down.
  const path = join(root, 'packages', 'shelf', 'package.json');
  const { agentcommsRelease: _hold, ...lifted } = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, `${JSON.stringify(lifted, null, 2)}\n`);
  assert.match((await runScript(join(scripts, 'packages.mjs'), [])).stdout, /\bshelf\b/);
  const unheld = await fakeOidc({ published: allExist() });
  try {
    const preflight = await runScript(join(scripts, 'release-ci.mjs'), ['preflight', VERSION, COMMIT], {
      env: unheld.env,
    });
    assert.equal(preflight.status, 1);
    assert.match(preflight.stdout, /✗ @agentcomms\/shelf: never published/);
    assert.ok(
      preflight.stdout.includes(
        '  pnpm --config.pnpmfile=scripts/record-git-head.cjs --filter @agentcomms/shelf publish --access public --no-git-checks --tag latest\n',
      ),
      preflight.stdout,
    );
    assert.ok(unheld.reads.includes('@agentcomms/shelf'));
  } finally {
    await unheld.close();
  }
});

test('a package already at the version from another commit stops the release before anything is sent', async () => {
  // A moved tag: the first run published core and gmail from one commit, the tag moved to a fix, and the next run
  // skipped them as "already on the registry" and published the rest from the new one — one green version made of
  // two builds. Now it refuses, naming what is out and where it came from.
  const fake = await fakeOidc({
    published: { '@agentcomms/core': { [VERSION]: OTHER }, '@agentcomms/gmail': { [VERSION]: OTHER } },
  });
  try {
    const pending = await runScript(CI, ['pending', VERSION, COMMIT], { env: fake.env });
    assert.equal(pending.status, 1);
    assert.equal(pending.stdout, '', 'nothing for the publish loop to send');
    assert.match(pending.stderr, new RegExp(`@agentcomms/core@1\\.2\\.3 was published from ${OTHER}`));
    assert.match(pending.stderr, /@agentcomms\/gmail@1\.2\.3 was published from/);
    assert.match(pending.stderr, new RegExp(`not from this tag's commit, ${COMMIT}\\. Nothing was published`));

    const preflight = await runScript(CI, ['preflight', VERSION, COMMIT], { env: fake.env });
    assert.equal(preflight.status, 1);
    assert.deepEqual(fake.exchanges, [], 'it stops before proving anything');
  } finally {
    await fake.close();
  }

  // A version with no commit recorded, published by hand or by a pnpm that skipped the hook, cannot be matched to
  // this tag, so it is refused rather than assumed.
  const unrecorded = await fakeOidc({ published: { '@agentcomms/slack': { [VERSION]: null } } });
  try {
    const result = await runScript(CI, ['pending', VERSION, COMMIT], { env: unrecorded.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@agentcomms\/slack@1\.2\.3 has no commit recorded/);
  } finally {
    await unrecorded.close();
  }
});

test('pending prints what this commit still has to publish, in order, for the publish loop', async () => {
  const published = {
    '@agentcomms/core': { [VERSION]: COMMIT },
    '@agentcomms/gmail': { '0.4.0': OTHER, [VERSION]: COMMIT },
    // Another version, from anywhere, is not this one.
    '@agentcomms/slack': { '0.4.0': OTHER },
  };
  const fake = await fakeOidc({ published });
  try {
    const result = await runScript(CI, ['pending', VERSION, COMMIT], { env: fake.env });
    assert.equal(result.status, 0, result.stderr);
    // Every package but the two out from this commit — slack's other version does not count — in publish order.
    const fromThisCommit = (name) => published[`@agentcomms/${name}`]?.[VERSION] === COMMIT;
    assert.equal(result.stdout, `${PACKAGES.filter((name) => !fromThisCommit(name)).join(' ')}\n`);
    assert.match(result.stderr, /@agentcomms\/core@1\.2\.3 is already out from this commit/);
    assert.deepEqual(
      fake.reads,
      PACKAGES.map((name) => `@agentcomms/${name}`),
      'every package in the list is asked about',
    );
  } finally {
    await fake.close();
  }

  // Everything out from this commit — a re-run after the last package landed, or the tag after a local release.
  const done = await fakeOidc({ published: allPublishedFrom(COMMIT) });
  try {
    const result = await runScript(CI, ['pending', VERSION, COMMIT], { env: done.env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  } finally {
    await done.close();
  }
});

test('a registry that cannot answer stops the release, rather than reading as "not published"', async () => {
  const fake = await fakeOidc({ packumentStatus: 503 });
  try {
    const result = await runScript(CI, ['pending', VERSION, COMMIT], { env: fake.env });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /could not read @agentcomms\/core from the registry \(HTTP 503\)/);

    // And without a real commit to compare with, there is nothing to decide a skip by.
    for (const args of [[VERSION], [VERSION, 'main'], []]) {
      const refused = await runScript(CI, ['pending', ...args], { env: fake.env });
      assert.equal(refused.status, 1, `pending ${args.join(' ')} should refuse`);
      assert.match(refused.stderr, /usage: release-ci\.mjs pending <version> <commit>/);
    }
  } finally {
    await fake.close();
  }
});

// ── Where the tag points now, against a fake git ─────────────────────────────────────────────────────────────────

test(
  'the tag check passes only while the remote tag still names the commit the run started from',
  bashOnly,
  async () => {
    const dir = await tempDir('tag-check-');
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` };
    async function check(answer, options) {
      const git = await fakeGit(dir, answer, options);
      // Outside any repository, too: were the fake ever bypassed, the real git would find no origin to ask.
      const result = await runScript(CI, ['tag', `v${VERSION}`, COMMIT], { cwd: dir, env, timeout: 60_000 });
      return { ...result, asked: await git.calls() };
    }

    const lightweight = await check(lightweightTag(COMMIT));
    assert.equal(lightweight.status, 0, lightweight.stderr);
    // Both names, because `refs/tags/v1.2.3` alone does not match the peeled line an annotated tag adds.
    assert.deepEqual(lightweight.asked, [`ls-remote origin refs/tags/v${VERSION} refs/tags/v${VERSION}^{}`]);

    // An annotated tag's first line is the tag object, never the commit: the peeled line is the one compared.
    const annotated = await check(annotatedTag(COMMIT));
    assert.equal(annotated.status, 0, annotated.stderr);

    // Moved to a fix while this run was going: it stops, naming both commits.
    for (const moved of [lightweightTag(OTHER), annotatedTag(OTHER)]) {
      const result = await check(moved);
      assert.equal(result.status, 1, `a moved tag passed: ${moved}`);
      assert.match(result.stderr, new RegExp(`v1\\.2\\.3 now names ${OTHER}, not ${COMMIT}, the commit this run`));
    }

    // Deleted: stops too, rather than publishing a version whose tag is gone.
    const deleted = await check('');
    assert.equal(deleted.status, 1);
    assert.match(deleted.stderr, /v1\.2\.3 is no longer on origin/);

    // A ref that only ends like the tag is not the tag.
    const lookalike = await check(`${COMMIT}\trefs/heads/refs/tags/v${VERSION}\n`);
    assert.equal(lookalike.status, 1);

    // An answer it cannot get is not taken for "still there".
    const unreachable = await check('', {
      status: 128,
      stderr: "fatal: could not read Username for 'https://github.com'\nfatal: the remote end hung up\n",
    });
    assert.equal(unreachable.status, 1);
    assert.match(unreachable.stderr, /could not ask origin where v1\.2\.3 points/);
    // The reason is on git's first line; the last only says it stopped.
    assert.match(unreachable.stderr, /could not read Username .* \/ fatal: the remote end hung up/);

    // It cannot wait for ever: bounded, and never stopped by a prompt for credentials nobody will answer.
    const source = await readFile(CI, 'utf8');
    const body = /async function lsRemote\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? '';
    assert.match(body, /timeout: \d[\d_]*,/);
    assert.match(body, /GIT_TERMINAL_PROMPT: '0'/);

    // Without a real commit to compare with, there is nothing to check.
    for (const args of [[`v${VERSION}`], [`v${VERSION}`, 'main'], []]) {
      const refused = await runScript(CI, ['tag', ...args], { cwd: dir, env });
      assert.equal(refused.status, 1, `tag ${args.join(' ')} should refuse`);
      assert.match(refused.stderr, /usage: release-ci\.mjs tag <tag> <commit>/);
    }
  },
);

// ── The changelog section ────────────────────────────────────────────────────────────────────────────────────────

test('the release notes are the changelog section for the version, and a missing one refuses', async () => {
  const dir = await tempDir('release-notes-');
  const changelog = join(dir, 'CHANGELOG.md');
  await writeFile(
    changelog,
    '# Changelog\n\nIntro.\n\n## 1.2.0\n\n**New.** A thing.\n\n### Detail\n\nMore.\n\n## 1.1.0\n\nOlder.\n\n## 1.0.0\n',
  );
  const env = { ...process.env, RELEASE_CHANGELOG: changelog };

  const found = await runScript(CI, ['notes', '1.2.0'], { env });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, '**New.** A thing.\n\n### Detail\n\nMore.\n', 'a `###` heading is part of the section');

  const last = await runScript(CI, ['notes', '1.1.0'], { env });
  assert.equal(last.stdout, 'Older.\n');

  // `1.2` is a prefix of `1.2.0`: matching a heading by prefix would publish the wrong release's notes.
  const prefix = await runScript(CI, ['notes', '1.2'], { env });
  assert.equal(prefix.status, 1);

  const missing = await runScript(CI, ['notes', '9.9.9'], { env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no "## 9\.9\.9" section/);

  const empty = await runScript(CI, ['notes', '1.0.0'], { env });
  assert.equal(empty.status, 1, 'a heading with nothing under it is not an entry');
});

test('the repository changelog has a section for the version it declares', async () => {
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const result = await runScript(CI, ['notes', root.version]);
  // Before a release the new version's entry is written as the version is bumped, so both land in one commit.
  assert.equal(result.status, 0, `CHANGELOG.md has no section for ${root.version}: ${result.stderr}`);
});

// ── sync-versions, on a copy ─────────────────────────────────────────────────────────────────────────────────────

test('sync-versions bumps every skill, Slack included, and --check catches one left behind', async () => {
  const dir = await tempDir('sync-versions-');
  for (const path of ['package.json', 'skills', '.claude-plugin', 'gemini-extension.json', 'bin', 'scripts']) {
    await cp(join(ROOT, path), join(dir, path), { recursive: true });
  }
  // Every manifest the sync rewrites: each publishable package, held or not.
  for (const name of PUBLISHABLE) {
    await mkdir(join(dir, 'packages', name), { recursive: true });
    await cp(join(ROOT, 'packages', name, 'package.json'), join(dir, 'packages', name, 'package.json'));
  }
  for (const { directory, declaration } of REGISTRY.services) {
    for (const path of [declaration.server.entry, declaration.operations]) {
      const target = join(dir, 'packages', directory, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(ROOT, 'packages', directory, path), target, { recursive: true });
    }
  }
  const rootManifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const old = rootManifest.version;
  const next = `${old}-bump.1`;
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ ...rootManifest, version: next }, null, 2)}\n`);

  const sync = join(dir, 'scripts', 'sync-versions.mjs');
  const written = await runScript(sync, []);
  assert.equal(written.status, 0, written.stderr);

  const skills = (await readdir(join(dir, 'skills'), { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('_'),
  );
  assert.ok(
    skills.some((entry) => entry.name.startsWith('slack-')),
    'the fixture has no Slack skill to check',
  );
  for (const entry of skills) {
    const source = await readFile(join(dir, 'skills', entry.name, 'SKILL.md'), 'utf8');
    assert.match(source, new RegExp(`^compatibility: "@agentcomms/[\\w-]+@${escapeRegExp(next)}"$`, 'm'));
    assert.ok(!source.includes(`@${old}"`), `skills/${entry.name} still names ${old}`);
  }
  assert.equal((await runScript(sync, ['--check'])).status, 0);

  // Put one Slack skill back, as 0.4.1 would have left it: --check is what the tag gate runs, and it must refuse.
  const stale = join(dir, 'skills', 'slack-reading', 'SKILL.md');
  await writeFile(
    stale,
    (await readFile(stale, 'utf8')).replace(`@agentcomms/slack@${next}`, `@agentcomms/slack@${old}`),
  );
  const check = await runScript(sync, ['--check']);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /skills\/slack-reading\/SKILL\.md: the compatibility line is out of date/);
});

/** One job of the workflow, from its key to the next job's, or '' when there is none. */
function jobBlock(workflow, key) {
  const start = workflow.indexOf(`\n  ${key}:\n`);
  if (start < 0) return '';
  const next = /\n {2}[a-z][\w-]*:\n/g;
  next.lastIndex = start + 1;
  const end = next.exec(workflow)?.index ?? workflow.length;
  return workflow.slice(start, end);
}

test('the publish waits for the old-Node leg, which builds on the tooling Node and then runs its built-command tests', async () => {
  /*
   * Case 0000 of the CUE-403 design: a located command for a `.ts` entry runs on the oldest Node the packages claim.
   * The verify matrix starts at the repository's own tooling floor, 22.18.0, which strips types without being asked,
   * so it cannot see a missing `--experimental-strip-types`. One job builds there, switches to exactly 22.12.0 and runs
   * the built-package tests; the publish needs them as well as the matrix. The held event service is run again under
   * exactly 22.16.0, its own floor (events B1 plan amendment B1-F): below it the command must refuse, at it reach SQLite.
   */
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const job = jobBlock(workflow, 'old-node');
  assert.ok(job, 'there is an old-node job');
  assert.match(job, /\n {4}runs-on: ubuntu-latest\n/);
  const at = (marker) => {
    const index = job.indexOf(marker);
    assert.ok(index >= 0, `the old-node job has ${marker}`);
    return index;
  };
  const tooling = at('node-version: 22.18.0');
  const install = at('- run: pnpm install --frozen-lockfile');
  const build = at('- run: pnpm build');
  const old = at('node-version: 22.12.0\n');
  const run = at(
    '- run: node --test packages/core/test/cli-command-old-node.test.mjs packages/events-daemon/test/old-node.test.mjs\n',
  );
  const floor = at('node-version: 22.16.0\n');
  const service = at('- run: node --test packages/events-daemon/test/old-node.test.mjs\n');
  assert.ok(
    tooling < install && install < build && build < old && old < run && run < floor && floor < service,
    'built on 22.18.0, then run on 22.12.0, then the event service on 22.16.0',
  );
  assert.equal([...job.matchAll(/node-version: /g)].length, 3, 'three exact Node versions, and no range');
  assert.equal(
    [...job.matchAll(/node --test|pnpm (?:test|verify)\b/g)].length,
    2,
    'only the built-command tests run on the old Nodes',
  );
  // The publish needs it, and the ordinary verify matrix too.
  const publish = jobBlock(workflow, 'publish');
  const needs =
    /\n {4}needs: \[([^\]]*)\]\n/
      .exec(publish)?.[1]
      .split(',')
      .map((need) => need.trim()) ?? [];
  assert.deepEqual(needs.sort(), ['browser', 'old-node', 'verify']);
  assert.match(jobBlock(workflow, 'verify'), /node: \[22\.18\.0, 24\]/, 'the matrix keeps its own Node versions');
  // The test is there, and the repository's own tooling floor stays where it is.
  await readFile(join(ROOT, 'packages', 'core', 'test', 'cli-command-old-node.test.mjs'), 'utf8');
  const eventService = await readFile(join(ROOT, 'packages', 'events-daemon', 'test', 'old-node.test.mjs'), 'utf8');
  assert.match(eventService, /node:sqlite|Node SQLite/, 'the old-node service check reaches Node SQLite');
  assert.match(eventService, /needs Node 22\\.16\\.0 or newer/, 'and below the floor, checks the refusal by name');
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(root.engines.node, '>=22.18.0');
});

test('BRW-b: the release cannot publish without event vectors and loopback SSE CORS in Chromium and WebKit', async () => {
  /*
   * Events phase A plan, decision 3, layer 4: `pnpm verify:browser` runs the event library's vector families in real
   * Chromium and WebKit, the engines of the desktop app's webviews. It is kept out of `pnpm verify` and the six verify
   * legs, because it downloads two browsers, so the release has a job of its own for it, and the publish needs it as
   * it needs the Node 22.12.0 leg.
   */
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const publish = jobBlock(workflow, 'publish');
  const needs = /\n {4}needs: \[([^\]]*)\]\n/
    .exec(publish)?.[1]
    .split(',')
    .map((need) => need.trim());
  assert.deepEqual(needs?.sort(), ['browser', 'old-node', 'verify']);

  const job = jobBlock(workflow, 'browser');
  assert.ok(job, 'there is a browser job');
  assert.match(job, /name: event vectors and loopback SSE CORS in chromium and webkit/);
  assert.match(job, /\n {4}runs-on: macos-latest\n/);
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {4}steps:\n/, 'contents: read, and nothing else');
  const steps = [...job.matchAll(/\n {6}- (?:uses|run|name): .*/g)].map((match) => match[0].trim());
  const at = (marker) => {
    const index = steps.findIndex((step) => step.includes(marker));
    assert.ok(index >= 0, `the browser job has ${marker}`);
    return index;
  };
  const checkout = at('uses: actions/checkout@');
  assert.match(job, /- uses: actions\/checkout@v\d+\n {8}with:\n {10}persist-credentials: false\n/);
  const pnpm = at('uses: pnpm/action-setup@');
  const node = at('uses: actions/setup-node@');
  assert.match(job, /node-version: 22\.18\.0\n/);
  const install = at('run: pnpm install --frozen-lockfile');
  const browsers = at('run: pnpm --filter @agentcomms/events exec playwright install chromium webkit');
  const build = at('run: pnpm build');
  const run = at('run: pnpm verify:browser');
  assert.deepEqual(
    [checkout, pnpm, node, install, browsers, build, run],
    [0, 1, 2, 3, 4, 5, 6],
    `the steps, in order: ${steps.join(' | ')}`,
  );
  assert.equal(steps.length, 7, `nothing else runs: ${steps.join(' | ')}`);
  // Chromium and WebKit, and nothing else: no Firefox, no bare install of every browser, no system packages.
  const installs = [...job.matchAll(/playwright install[^\n]*/g)].map((match) => match[0]);
  assert.deepEqual(installs, ['playwright install chromium webkit']);
  assert.doesNotMatch(job, /--with-deps|firefox|msedge|chrome\b/);
  assert.equal([...job.matchAll(/node --test|pnpm (?:test|verify)(?![:\w-])/g)].length, 0, 'no other test or verify');

  // The rest stays as it is: the six verify legs install no browser, and `pnpm verify` does not run this.
  assert.doesNotMatch(jobBlock(workflow, 'verify'), /playwright|verify:browser/);
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.doesNotMatch(root.scripts.verify, /verify:browser/);
  assert.equal(root.scripts['verify:browser'], 'pnpm --filter @agentcomms/events run verify:browser');
  const browserScript = await readFile(join(ROOT, 'packages', 'events', 'scripts', 'verify-browser.mjs'), 'utf8');
  assert.match(browserScript, /packages\/events-daemon\/test\/sse-listener-browser\.test\.ts/);
  assert.match(browserScript, /loopback-seal-preload\.mjs/);
  const sseBrowser = await readFile(
    join(ROOT, 'packages', 'events-daemon', 'test', 'sse-listener-browser.test.ts'),
    'utf8',
  );
  assert.match(sseBrowser, /context\.route/);
  assert.match(sseBrowser, /credentials: 'omit'/);
  assert.match(sseBrowser, /credentials: 'include'/);
  assert.match(sseBrowser, /preflightCount\(\) > 0/);
});

test('BRW-c: without the browsers, the browser run says how to get them, launches nothing and downloads nothing', async () => {
  const empty = await tempDir('no-browsers-');
  const script = join(ROOT, 'packages', 'events', 'scripts', 'verify-browser.mjs');
  // Run as its package script runs it, with the flags that let it import the library's TypeScript.
  const result = await runScript('--experimental-strip-types', ['--disable-warning=ExperimentalWarning', script], {
    cwd: join(ROOT, 'packages', 'events'),
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
    timeout: 60_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const said = result.stdout + result.stderr;
  assert.ok(said.includes('pnpm --filter @agentcomms/events exec playwright install chromium webkit'), said);
  assert.match(said, /On Linux add --with-deps/);
  assert.match(said, /pnpm verify does not run this/);
  assert.doesNotMatch(said, /✓|in chromium:|in webkit:/, 'nothing was run');
  assert.deepEqual(await readdir(empty), [], 'nothing was downloaded');
});
