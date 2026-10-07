import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_DIR = join(ROOT, 'packages', 'events-daemon');

test('PKG-B1-b: the local event daemon is a held service with its declared runtime boundaries', () => {
  assert.ok(existsSync(PACKAGE_DIR), 'packages/events-daemon is the Task 4 service package');
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));

  assert.equal(manifest.name, '@agentcomms/events-daemon');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.engines.node, '>=22.16.0', 'the floor where Node SQLite is complete (plan amendment B1-F)');
  assert.deepEqual(manifest.bin, { 'agent-events': './dist/cli.mjs' });
  assert.deepEqual(manifest.agentcommsPackage, {
    kind: 'service',
    binary: 'agent-events',
    server: {
      defaultName: 'events',
      entry: 'src/mcp/server.ts',
      factory: 'createEventsMcpServer',
    },
    operations: 'src/operations',
  });
  assert.match(manifest.agentcommsRelease.hold, /held/i);
  assert.deepEqual(manifest.dependencies, {
    '@agentcomms/core': 'workspace:*',
    '@agentcomms/events': 'workspace:*',
    '@agentcomms/gmail': 'workspace:*',
  });
  assert.deepEqual(manifest.files, ['dist', 'README.md', 'LICENSE', 'THIRD_PARTY_LICENSES']);
  assert.doesNotMatch(
    JSON.stringify({ ...manifest.dependencies, ...manifest.optionalDependencies }),
    /(?:better-sqlite3|sqlite3|node-sqlite3)/,
    'the service uses Node SQLite rather than a native dependency',
  );
  const statusSource = readFileSync(join(PACKAGE_DIR, 'src', 'operations', 'status.ts'), 'utf8');
  assert.match(statusSource, /loadSqlite\(\)/, 'the Node SQLite boundary is explicit');
  const loader = readFileSync(join(PACKAGE_DIR, 'src', 'runtime', 'sqlite.ts'), 'utf8');
  assert.match(loader, /await import\('node:sqlite'\)/, 'the one runtime import of Node SQLite is the lazy loader');
  assert.match(loader, /export const MIN_NODE = '22\.16\.0';/, 'the loader checks the floor engines states');
});

test('PKG-B1-b: nothing but the lazy loader imports Node SQLite at runtime, so an older Node is refused, not crashed', () => {
  // A value import anywhere in the bundle would load before `--help` runs: Node 22.12 has no unflagged module.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith('.ts') &&
        /^import (?!type\b)[^;]*from 'node:sqlite'/m.test(readFileSync(path, 'utf8'))
      ) {
        offenders.push(path);
      }
    }
  };
  walk(join(PACKAGE_DIR, 'src'));
  assert.deepEqual(offenders, []);
});
