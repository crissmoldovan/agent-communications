import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const checker = new URL('../scripts/verify-desktop-mutations.mjs', import.meta.url);
const fixture = new URL('./fixtures/desktop-mutation-marker-scan/', import.meta.url);
const marker =
  'desktop-rust-mutation: fixture-stop-race | cargo --test supervisor_lifecycle | stop_epoch_prevents_clearing_newer_owner';

async function copiedFixture() {
  const temp = await mkdtemp(join(tmpdir(), 'desktop-mutation-markers-'));
  await cp(fixture, temp, { recursive: true });
  for (const path of [
    'apps/desktop/src-tauri/src/supervisor.rs',
    'apps/desktop/src-tauri/tests/supervisor_lifecycle.rs',
    'apps/desktop/test/supervisor.test.mjs',
  ]) {
    await rename(join(temp, `${path}.fixture`), join(temp, path));
  }
  return temp;
}

function verifyFixture(temp) {
  return spawnSync(process.execPath, [checker.pathname, '--root', temp], {
    cwd: root,
    encoding: 'utf8',
  });
}

// desktop-mutation: desktop-mutation-marker-global-scan
test('a copied fixture rejects unknown, duplicate, and mismatched mutation markers', async () => {
  const conflicts = [
    {
      expected: /Unknown-Fixture: marker has no manifest case/,
      apply: async (temp) => {
        await writeFile(
          join(temp, 'apps/desktop/src-tauri/src/unknown.rs'),
          `// desktop-rust-mutation: Unknown-Fixture | cargo --test supervisor_lifecycle | stop_epoch_prevents_clearing_newer_owner\n`,
        );
      },
    },
    {
      expected: /fixture-stop-race: mutation marker is duplicated/,
      apply: async (temp) => {
        await writeFile(join(temp, 'apps/desktop/src-tauri/src/duplicate.rs'), `// ${marker}\n`);
      },
    },
    {
      expected: /fixture-stop-race: marker test differs from the manifest declaration/,
      apply: async (temp) => {
        const path = join(temp, 'apps/desktop/src-tauri/tests/supervisor_lifecycle.rs');
        const source = await readFile(path, 'utf8');
        await writeFile(path, source.replace('stop_epoch_prevents_clearing_newer_owner', 'a_different_test'));
      },
    },
    {
      expected: /fixture-nested-build: marker has no manifest case/,
      apply: async (temp) => {
        const directory = join(temp, 'apps/desktop/src/build');
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, 'tracked-source.rs'),
          `// desktop-rust-mutation: fixture-nested-build | cargo --test supervisor_lifecycle | stop_epoch_prevents_clearing_newer_owner\n`,
        );
      },
    },
  ];

  for (const conflict of conflicts) {
    const temp = await copiedFixture();
    try {
      assert.equal(verifyFixture(temp).status, 0);
      await conflict.apply(temp);
      const result = verifyFixture(temp);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, conflict.expected);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});
