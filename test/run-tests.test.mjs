import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm test` runs every suite whatever failed before it (`scripts/run-tests.mjs`): a failing root test used to hide
 * every package's result, and `pnpm -r` stopped at the first failing package, so each failure cost a run of its own.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('pnpm test runs the root suite and then every package suite, without stopping at a failure', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.test, 'node scripts/run-tests.mjs');
  assert.ok(manifest.scripts.verify.includes('pnpm test'), 'pnpm verify still runs every test');

  const runner = await readFile(join(ROOT, 'scripts', 'run-tests.mjs'), 'utf8');
  // The root suite under the loopback seal, as before.
  assert.match(
    runner,
    /'--import', '\.\/test\/helpers\/loopback-seal-preload\.mjs', '--test', 'test\/\*\*\/\*\.test\.mjs'/,
  );
  // Every package and the app, none skipped after a failure.
  assert.match(
    runner,
    /'-r', '--no-bail', '--filter', '\.\/packages\/\*\*', '--filter', '\.\/apps\/\*\*', 'run', 'test'/,
  );
  // Both run whatever the other did: the packages' suites are added at the top level, behind no condition on the first.
  assert.match(runner, /\nconst suites = \[\n {2}\{\n {4}name: 'the root suite',/);
  assert.match(runner, /\nsuites\.push\(\{\n {2}name: "the packages' suites",/);
  assert.match(runner, /process\.exit\(failed\.length === 0 \? 0 : 1\)/, 'a failure anywhere still fails the run');
});

test('off CI, every suite of a run keeps its temporary folders in one folder of its own, removed at the end', async () => {
  const runner = await readFile(join(ROOT, 'scripts', 'run-tests.mjs'), 'utf8');
  // Short on POSIX, under /tmp, so a Unix socket below it has more room than under macOS's per-user folder.
  assert.match(runner, /mkdtempSync\(join\(process\.platform === 'win32' \? tmpdir\(\) : '\/tmp', 'ac-tests-'\)\)/);
  assert.match(runner, /const scratch = process\.env\.CI\n\s+\? undefined/, 'a CI runner keeps its own');
  assert.match(runner, /\{ \.\.\.process\.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch \}/);
  // Both suites get it.
  assert.equal(
    runner.match(/\{ cwd: ROOT, env, stdio: 'inherit'/g)?.length,
    4,
    'the root suite, and pnpm each of three ways',
  );
  assert.match(runner, /rmSync\(scratch, \{ recursive: true, force: true, maxRetries: 10, retryDelay: 200 \}\)/);
});
