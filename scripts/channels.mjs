#!/usr/bin/env node
/**
 * The channel registry: the one list of channels this repository's tooling reads, derived from the one place each
 * channel says what it is — the `"agentcomms"` field of its `package.json` (design 2026-09-26).
 *
 * The 2026-09-20 skills design promised this list, and it was never built: which channels exist was written down
 * about eleven times instead — the publish list, the licence script, the parity surfaces and drivers, the reference
 * generator, the version sync, the skill contracts and four tests — and each copy was one more place a new channel
 * had to be added by hand, or would silently not be checked. Every one of those now reads `REGISTRY`, a view of this
 * derivation, so a new `packages/<channel>` with the field is discovered by all of them without an edit.
 *
 * **Libraries** (design 2026-10-05, D14). A package that is not a channel declares itself with a separate field,
 * `"agentcommsPackage": { "kind": "library" }`, read in the same walk; `"agentcomms"` still means a channel and
 * nothing else. A library is published — it joins `packages`, in dependency order, so it is built, version-synced,
 * licence-checked and consumer-checked like every other package — and it has no surface: no CLI, no server, no
 * reference pages, no skills and no accounts, so it is in none of the views that need one. `"service"`, the other kind
 * D14 names, is read from phase B1 of that design; until then it is refused here.
 *
 * **Holds** (events phase A plan, decision 1). A published package can be held back from a tag's publish with
 * `"agentcommsRelease": { "hold": "<why, one sentence>" }` in its own `package.json`. It lands in `held`, and
 * `scripts/packages.mjs` leaves it out of what a tag publishes while every check still walks it. Core is never held,
 * and a hold on a package no release would publish anyway — a private one, or one that declares nothing — is refused.
 *
 * Plain JavaScript with no dependencies, on purpose: the release workflow runs `node scripts/packages.mjs` — which
 * reads this — in a job that installs nothing. So this only *reads* the channel manifests. They are *checked*, against
 * core's zod schema and against each other, by `scripts/sync-channels.mjs`, which `pnpm verify` runs; and core's
 * snapshot of them is written there too. The library declaration and the hold are small enough to check here, by
 * hand, with the same refusal for every reader.
 *
 *   node scripts/channels.mjs      # prints the channel words, e.g. core gmail resend slack whatsapp
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const SCOPE = '@agentcomms';

/**
 * Every package under `root/packages`, read once and sorted by what it declares:
 *
 * - `channels`: each package with an `"agentcomms"` field, as `{ directory, packageName, manifest, packageJson }` —
 *   the core first, then the rest by their channel word;
 * - `libraries`: each package with `"agentcommsPackage": { "kind": "library" }`, as
 *   `{ directory, packageName, declaration, packageJson }`, by directory;
 * - `held`: each package held back from release, as `{ directory, packageName, reason }`, by directory;
 * - `undeclared`: each package that is not private and declares neither, as `{ directory, packageName }` — except a
 *   server-only package a channel runs its server through, which is that channel's.
 *
 * A directory is found by being there. There is no list to add a channel or a library to — a new `packages/<name>`
 * with its field is one for every tool that reads this. A package's word is its directory's name, as a package's
 * directory is its unscoped name, so the two cannot drift apart. Whatever cannot be read is refused, naming the file.
 */
export function readDeclarations(root = ROOT) {
  const channels = [];
  const libraries = [];
  const holds = [];
  const plain = [];
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageJson = readPackageJson(root, entry.name);
    if (packageJson === null) continue;
    const where = `packages/${entry.name}/package.json`;
    const manifest = packageJson.agentcomms;
    const declaration = packageJson.agentcommsPackage;
    if (manifest !== undefined && declaration !== undefined) {
      throw new Error(
        `${where}: declares both "agentcomms" and "agentcommsPackage"; a channel declares the first, a library the second`,
      );
    }
    if (manifest !== undefined) channels.push(readChannel(entry.name, packageJson));
    else if (declaration !== undefined) libraries.push(readLibrary(entry.name, packageJson));
    else if (packageJson.private !== true) plain.push({ directory: entry.name, packageName: packageJson.name });
    if (packageJson.agentcommsRelease !== undefined) holds.push({ directory: entry.name, packageJson });
  }
  channels.sort((a, b) =>
    a.directory === 'core' ? -1 : b.directory === 'core' ? 1 : a.directory < b.directory ? -1 : 1,
  );
  libraries.sort(byDirectory);
  const wrappers = wrappersOf(channels);
  const undeclared = plain.filter(({ directory }) => !Object.hasOwn(wrappers, directory)).sort(byDirectory);
  const held = holds
    .map(({ directory, packageJson }) => readHold(directory, packageJson, undeclared))
    .sort(byDirectory);
  return { channels, libraries, held, undeclared };
}

/** Every package under `root/packages` that declares a channel: `readDeclarations(root).channels`. */
export function readChannels(root = ROOT) {
  return readDeclarations(root).channels;
}

const byDirectory = (a, b) => (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0);

/** One channel's entry, from a package whose `"agentcomms"` field is set. */
function readChannel(directory, packageJson) {
  const where = `packages/${directory}/package.json`;
  const manifest = packageJson.agentcomms;
  // `"agentcomms"` means a channel (channel-plugins design §2; D14): a kind there is a library or a service that
  // reached for the wrong field, and would otherwise be read as a broken channel.
  if (manifest !== null && typeof manifest === 'object' && Object.hasOwn(manifest, 'kind')) {
    throw new Error(
      `${where}: "agentcomms" declares a channel and has no "kind"; a library declares "agentcommsPackage": { "kind": "library" } instead`,
    );
  }
  if (manifest === null || typeof manifest !== 'object' || typeof manifest.channel !== 'string') {
    throw new Error(`${where}: "agentcomms" has no channel`);
  }
  if (manifest.channel !== directory) {
    throw new Error(`${where}: declares channel "${manifest.channel}", but a channel's word is its directory's name`);
  }
  if (packageJson.name !== `${SCOPE}/${directory}`) {
    throw new Error(`${where}: a channel's package is ${SCOPE}/${directory}`);
  }
  return { directory, packageName: packageJson.name, manifest, packageJson };
}

/**
 * One library's entry, from a package whose `"agentcommsPackage"` field is set: exactly `{ "kind": "library" }`, on a
 * published package named for its directory, with no command — a package with one is a channel or a service.
 */
function readLibrary(directory, packageJson) {
  const where = `packages/${directory}/package.json`;
  const declaration = packageJson.agentcommsPackage;
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new Error(`${where}: "agentcommsPackage" must be an object, { "kind": "library" }`);
  }
  const unknown = Object.keys(declaration).find((key) => key !== 'kind');
  if (unknown !== undefined) {
    throw new Error(
      `${where}: "agentcommsPackage" has unknown key "${unknown}"; a library declares { "kind": "library" } and nothing else`,
    );
  }
  if (!Object.hasOwn(declaration, 'kind')) {
    throw new Error(`${where}: "agentcommsPackage" has no "kind"; this registry reads { "kind": "library" }`);
  }
  if (declaration.kind === 'service') {
    throw new Error(
      `${where}: "agentcommsPackage".kind "service" is not read yet: this registry reads "library"; "service" arrives with phase B1 of the event-emission design`,
    );
  }
  if (declaration.kind !== 'library') {
    throw new Error(
      `${where}: "agentcommsPackage".kind ${JSON.stringify(declaration.kind)} is unknown; this registry reads "library"`,
    );
  }
  if (packageJson.private === true) {
    throw new Error(`${where}: a library is published, so it cannot be "private": true`);
  }
  if (packageJson.bin !== undefined) {
    throw new Error(`${where}: a library has no "bin"; a package with a command is a channel or a service`);
  }
  if (packageJson.name !== `${SCOPE}/${directory}`) {
    throw new Error(`${where}: a library's package is ${SCOPE}/${directory}`);
  }
  return { directory, packageName: packageJson.name, declaration, packageJson };
}

/**
 * One hold, from a package whose `"agentcommsRelease"` field is set: exactly `{ "hold": "<why, one line>" }`, on a
 * package a release would otherwise publish, and never on core.
 */
function readHold(directory, packageJson, undeclared) {
  const where = `packages/${directory}/package.json`;
  if (directory === 'core') {
    throw new Error(
      `${where}: core cannot be held back from a release: every channel depends on it at exactly its own version, so a release without it installs nothing`,
    );
  }
  if (packageJson.private === true) {
    throw new Error(`${where}: "agentcommsRelease" on a private package, which no release publishes anyway`);
  }
  if (undeclared.some((entry) => entry.directory === directory)) {
    throw new Error(
      `${where}: "agentcommsRelease" on a package that declares neither "agentcomms" nor "agentcommsPackage", which no release publishes`,
    );
  }
  const release = packageJson.agentcommsRelease;
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error(`${where}: "agentcommsRelease" must be { "hold": "<why, one sentence>" }`);
  }
  const unknown = Object.keys(release).find((key) => key !== 'hold');
  if (unknown !== undefined) {
    throw new Error(
      `${where}: "agentcommsRelease" has unknown key "${unknown}"; it is { "hold": "<why, one sentence>" } and nothing else`,
    );
  }
  const reason = release.hold;
  if (typeof reason !== 'string' || reason.trim() === '' || /[\r\n]/.test(reason)) {
    throw new Error(`${where}: "agentcommsRelease".hold says why, in one line, and is not empty`);
  }
  return { directory, packageName: packageJson.name, reason };
}

function readPackageJson(root, directory) {
  try {
    return JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`packages/${directory}/package.json: ${error.message}`);
  }
}

/**
 * The server-only packages the channels run their servers through (`server.npxPackage` naming another package of
 * this suite, as Gmail's names `gmail-mcp`), each to the channel it wraps.
 */
function wrappersOf(channels) {
  const wrappers = {};
  for (const { directory, packageName, manifest } of channels) {
    const npx = manifest.server?.npxPackage;
    if (typeof npx === 'string' && npx !== packageName && npx.startsWith(`${SCOPE}/`)) {
      wrappers[npx.slice(SCOPE.length + 1)] = directory;
    }
  }
  return wrappers;
}

/**
 * The order packages are published in: each after every package of this suite it depends on, and otherwise by name.
 *
 * Load-bearing — a consumer installing `gmail` must find the exact `core` it pins already on the registry — so it is
 * computed from the dependencies rather than trusted, and `test/release-packages.test.mjs` still checks the result.
 */
function publishOrder(root, names) {
  const depends = new Map(
    names.map((name) => {
      const manifest = readPackageJson(root, name);
      if (manifest === null) throw new Error(`a channel names ${SCOPE}/${name}, and there is no packages/${name}`);
      const fields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
      const own = fields.flatMap((field) => Object.keys(manifest[field] ?? {}));
      return [name, own.filter((d) => d.startsWith(`${SCOPE}/`)).map((d) => d.slice(SCOPE.length + 1))];
    }),
  );
  const ordered = [];
  const pending = new Set(names);
  while (pending.size > 0) {
    const ready = [...pending].filter((name) => depends.get(name).every((d) => !pending.has(d))).sort();
    if (ready.length === 0)
      throw new Error(`these packages depend on each other in a circle: ${[...pending].join(', ')}`);
    ordered.push(ready[0]);
    pending.delete(ready[0]);
  }
  return ordered;
}

/**
 * Gmail's reference pages kept the names they had before there was a second channel: they are linked from outside
 * this repository. Every channel after it gets `docs/reference/<channel>-cli.md` and `<channel>-mcp-tools.md`.
 */
const REFERENCE_NAMES = Object.freeze({
  gmail: { cli: 'docs/reference/cli.md', mcp: 'docs/reference/mcp-tools.md' },
});

/** `Gmail` → `Gmail`, `WhatsApp` → `WhatsApp`: the middle of a server factory's name, `create<Name>McpServer`. */
const pascal = (label) => {
  const letters = label.replace(/[^A-Za-z0-9]/g, '');
  return letters.charAt(0).toUpperCase() + letters.slice(1);
};

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/**
 * Everything the tooling knows about the channels under `root`, derived from their manifests.
 *
 * - `channels`: the entries `readChannels` returns.
 * - `libraries`, `held` and `undeclared`: the entries `readDeclarations` returns. A library feeds `packages` and
 *   nothing else here: every other view is of a surface, and a library has none (D14).
 * - `packages`: every package to publish, in publish order — each channel, any package a channel's server is run
 *   through (`server.npxPackage`, Gmail's `gmail-mcp`), and each library. Held packages are among them: what a tag
 *   leaves out is `scripts/packages.mjs`'s to say.
 * - `wrappers`: those server-only packages, and the channel each wraps.
 * - `surfaces`: how each CLI and server is read (`registries.mjs`); `drivers`: how each is driven (`operations.mjs`).
 *   A channel's CLI is `src/cli.ts`, its Commander program `src/cli/program.ts` exporting `run`, and its server
 *   `src/mcp/server.ts` exporting `create<Label>McpServer`. The core's CLI is a usage table, and `main`.
 * - `reference`: each channel's generated reference pages. `products`: what `tool-drift` checks.
 * - `skillFamilies`: each channel's skill prefix and contract, with the words of every *other* channel its skills
 *   must never use (`foreign`). The core's `comms-` skills manage every channel, so theirs is empty.
 * - `platforms`: the platform words accounts are named with (`cue/<platform>`).
 */
export function loadRegistry(root = ROOT) {
  const { channels, libraries, held, undeclared } = readDeclarations(root);
  const wrappers = wrappersOf(channels);
  const packages = publishOrder(root, [
    ...channels.map((c) => c.directory),
    ...Object.keys(wrappers),
    ...libraries.map((library) => library.directory),
  ]);

  const isCore = (directory) => directory === 'core';
  const surfaces = channels.map(({ directory, manifest }) =>
    isCore(directory)
      ? { package: directory, binary: manifest.binary, entry: `packages/${directory}/src/cli.ts`, cli: 'usage' }
      : {
          package: directory,
          binary: manifest.binary,
          entry: `packages/${directory}/src/cli.ts`,
          program: `packages/${directory}/src/cli/program.ts`,
          cli: 'commander',
        },
  );
  const drivers = Object.fromEntries(
    channels.map(({ directory, manifest }) => [
      directory,
      isCore(directory)
        ? {
            cli: `packages/${directory}/src/cli.ts`,
            run: 'main',
            server: `packages/${directory}/src/mcp/server.ts`,
            factory: 'createCoreMcpServer',
          }
        : {
            cli: `packages/${directory}/src/cli/program.ts`,
            run: 'run',
            server: `packages/${directory}/src/mcp/server.ts`,
            factory: `create${pascal(manifest.label)}McpServer`,
          },
    ]),
  );
  /** A channel's tool prefix is its word; the core's tools are `comms_…`. */
  const toolPrefix = (directory, manifest) => (isCore(directory) ? 'comms' : manifest.channel);
  const reference = Object.fromEntries(
    channels.map(({ directory }) => [
      directory,
      REFERENCE_NAMES[directory] ?? {
        cli: isCore(directory) ? null : `docs/reference/${directory}-cli.md`,
        mcp: `docs/reference/${directory}-mcp-tools.md`,
      },
    ]),
  );
  const products = channels.map(({ directory, manifest }) => {
    const surface = surfaces.find((s) => s.package === directory);
    return {
      channel: directory,
      tool: toolPrefix(directory, manifest),
      binary: manifest.binary,
      server: drivers[directory].server,
      reference: reference[directory].mcp,
      program: surface.program ?? surface.entry,
      ...(surface.cli === 'usage' ? { usage: true } : {}),
    };
  });

  const skillDirectories = (() => {
    try {
      return readdirSync(join(root, 'skills'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  })();
  /** What names a channel: its tools, its commands, its packages and its skills. */
  const wordsOf = ({ directory, packageName, manifest }) => [
    new RegExp(`\\b${escapeRegExp(toolPrefix(directory, manifest))}_[a-z_]+`),
    ...[manifest.binary, ...(manifest.server?.bins ?? [])].map((binary) => new RegExp(`\\b${escapeRegExp(binary)}\\b`)),
    ...[
      packageName,
      ...Object.entries(wrappers)
        .filter(([, of]) => of === directory)
        .map(([w]) => `${SCOPE}/${w}`),
    ].map((name) => new RegExp(`${escapeRegExp(name)}\\b`)),
    ...skillDirectories
      .filter((skill) => manifest.skills && skill.startsWith(manifest.skills.prefix))
      .map((skill) => new RegExp(`\\b${escapeRegExp(skill)}\\b`)),
  ];
  const skillFamilies = channels
    .filter(({ manifest }) => manifest.skills)
    .map((channel) => ({
      channel: channel.directory,
      family: channel.manifest.skills.prefix.slice(0, -1),
      prefix: channel.manifest.skills.prefix,
      contract: channel.manifest.skills.contract,
      readme: `packages/${channel.directory}/README.md`,
      foreign: isCore(channel.directory)
        ? []
        : channels.filter((other) => other !== channel && !isCore(other.directory)).flatMap(wordsOf),
    }));
  const platforms = channels.filter(({ manifest }) => manifest.accounts).map(({ manifest }) => manifest.channel);

  return {
    root,
    channels,
    libraries,
    held,
    undeclared,
    packages,
    wrappers,
    surfaces,
    drivers,
    reference,
    products,
    skillFamilies,
    platforms,
  };
}

/** The registry of this checkout. */
export const REGISTRY = loadRegistry();

/** The skill family a skill belongs to, by its name's prefix — or undefined, which every reader refuses. */
export function skillFamilyOf(registry, skill) {
  return registry.skillFamilies.find((family) => skill.startsWith(family.prefix));
}

// Run directly, print the channel words.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${REGISTRY.channels.map((channel) => channel.directory).join(' ')}\n`);
}
