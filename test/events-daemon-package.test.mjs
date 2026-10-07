import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  assert.equal(manifest.engines.node, '>=22.12.0');
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
  assert.match(statusSource, /from 'node:sqlite'/, 'the Node SQLite boundary is explicit');
});
