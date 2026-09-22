import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigStore, emptyConfig, NEW_CONFIG_VERSION } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { migrateNames, planNamesMigration } from '../src/names.ts';
import { tempDir } from './helpers/temp.ts';

/**
 * This release reads version 2 and writes nothing at it — not by a command, and not through the library.
 *
 * A file of its own, so it runs in its own process: `names.test.ts` switches the gate on to exercise the transition,
 * and that must not leak into the one test that proves the default.
 */

test('this release creates version 1 and refuses to migrate anything to version 2', async () => {
  assert.equal(NEW_CONFIG_VERSION, 1);
  assert.equal(emptyConfig().version, 1);

  const dir = tempDir('comms-gate-');
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ version: 1 })}\n`);
  const store = new ConfigStore(dir);
  const plan = planNamesMigration(await store.load());
  assert.equal(plan.status, 'ready');
  if (plan.status !== 'ready') return;
  await assert.rejects(
    migrateNames(store, plan),
    (error: unknown) =>
      error instanceof CommsError && error.code === 'CONFIG' && /does not write it/.test(error.message),
  );
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).version, 1);
});
