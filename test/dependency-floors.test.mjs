import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A library with a published advisory against the version this project used to ship must not come back below the
 * version that fixed it. Two places decide what a person runs:
 *
 * - **the declared range,** for a runtime dependency: npm resolves it on the person's machine, so its lowest version
 *   is one they can get;
 * - **the lockfile,** for a library a bundle inlines (a devDependency): the build copies whatever it resolved.
 *
 * Both are held to each floor here. A library no manifest names, one a dependency brings in, is held in the lockfile
 * alone (`transitive`). A floor is raised when an advisory lands, and never lowered.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const FLOORS = [
  {
    name: 'postal-mime',
    floor: '4.0.8',
    // Core reads every sender's address and encoded-word headers with it.
    advisories: ['GHSA-f2hq-32vh-53cc: quadratic CPU decoding a header of many joinable RFC 2047 words'],
  },
  {
    name: 'nodemailer',
    floor: '10.1.4',
    // Gmail's bundle builds every outgoing message with it, recipients included.
    advisories: [
      'GHSA-8c8m-p3m8-cjg8: a nested comment ends early in addressparser',
      'GHSA-85x2-q946-cp5h: a ">" inside a quoted local part ends an angle-addr early',
      'GHSA-m943-m63m-w62w: a ";" inside a quoted string or comment ends an address group early',
    ],
  },
  {
    name: 'zod',
    floor: '4.6.6',
    // Every MCP tool's input, and the desktop app's reading of each CLI answer, is validated with it.
    advisories: ['GHSA-mrhx-c7xc-m3w5: memory exhaustion validating oversized constrained collections'],
  },
  {
    name: '@sigstore/verify',
    floor: '3.1.1',
    // Core verifies every update's provenance with it. 2.1.1 had the same flaw, though the advisory names 3.1.0 alone.
    advisories: ['GHSA-xgjw-pm74-86q4: an unsigned integrated time was used to check the certificate'],
  },
  {
    name: '@sigstore/core',
    floor: '3.2.1',
    transitive: true,
    // @sigstore/verify's own dependency, for the DSSE envelope it checks.
    advisories: ['GHSA-jfc7-64v2-mr8c: a DSSE payloadType type-binding failure'],
  },
];

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function compare(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The lowest version a range admits, for the forms these manifests use: exact, `^`, `~` and `>=`. */
function lowest(range) {
  const match = /^(?:\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(range.trim());
  assert.ok(match, `the range ${JSON.stringify(range)} is not one this check reads; extend lowest() for it`);
  return match[1];
}

async function catalog() {
  const yaml = await readFile(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const block = /^catalog:\n((?: {2}.+\n)+)/m.exec(yaml);
  assert.ok(block, 'pnpm-workspace.yaml should have a catalog');
  return Object.fromEntries(
    block[1]
      .trimEnd()
      .split('\n')
      .map((line) => /^ {2}"?([^":]+)"?: (.+)$/.exec(line))
      .filter(Boolean)
      .map(([, name, range]) => [name, range.trim()]),
  );
}

async function manifests() {
  const found = [];
  for (const parent of ['packages', 'apps']) {
    for (const entry of await readdir(join(ROOT, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(parent, entry.name, 'package.json');
      try {
        found.push({ file, manifest: JSON.parse(await readFile(join(ROOT, file), 'utf8')) });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return found;
}

test('every declared range of a library with an advisory starts at or above its fixed version', async () => {
  const ranges = await catalog();
  const all = await manifests();
  for (const { name, floor, advisories, transitive } of FLOORS) {
    if (transitive) continue;
    let declared = 0;
    for (const { file, manifest } of all) {
      for (const section of SECTIONS) {
        const spec = manifest[section]?.[name];
        if (spec === undefined) continue;
        declared += 1;
        const range = spec === 'catalog:' ? ranges[name] : spec;
        assert.ok(range, `${file} takes ${name} from the catalog, which does not list it`);
        assert.ok(
          compare(lowest(range), floor) >= 0,
          `${file} ${section} admits ${name}@${lowest(range)}, below ${floor}, which fixed ${advisories.join('; ')}`,
        );
      }
    }
    assert.ok(declared > 0, `no manifest declares ${name}: drop its floor, or this check reads the wrong files`);
  }
});

test('every copy of a library with an advisory that the lockfile resolves is at or above its fixed version', async () => {
  const lock = await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  for (const { name, floor, advisories } of FLOORS) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const versions = [...lock.matchAll(new RegExp(`^ {2}'?${escaped}@(\\d+\\.\\d+\\.\\d+)[^:]*:`, 'gm'))].map(
      ([, version]) => version,
    );
    assert.ok(versions.length > 0, `the lockfile resolves no ${name}`);
    for (const version of versions) {
      assert.ok(
        compare(version, floor) >= 0,
        `the lockfile resolves ${name}@${version}, below ${floor}, which fixed ${advisories.join('; ')}`,
      );
    }
  }
});
