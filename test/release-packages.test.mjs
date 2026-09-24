import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every publishable package is named in the release workflow.
 *
 * The workflow publishes from an explicit, ordered list, and the order is load-bearing: a consumer installing
 * `gmail` must find the exact `core` it pins already on the registry. So the list cannot simply be derived — but
 * it can be *checked*, and it has to be, because it was not: 0.4.0 published three packages and reported success
 * while `@agentcomms/slack` — added in that very release — was missing from the loop.
 *
 * That was the fourth time in one change that a hand-written list of things went stale: `sync-skills.mjs` and the
 * plugin-manifest test both enumerated skills by a `gmail-` prefix, and this made the same shape of mistake with
 * packages. The pattern that works is an explicit list plus a test that it is complete.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the release workflow publishes every package that is meant to be published', async () => {
  const dirs = (await readdir(join(ROOT, 'packages'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const publishable = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(join(ROOT, 'packages', dir, 'package.json'), 'utf8'));
    if (manifest.private === true) continue;
    assert.ok(manifest.name?.startsWith('@agentcomms/'), `${dir} has an unexpected package name`);
    publishable.push(manifest.name.slice('@agentcomms/'.length));
  }
  assert.ok(publishable.length > 0, 'no publishable packages found — the discovery is wrong');

  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const loop = /for package in ([^;]+); do/.exec(workflow)?.[1]?.trim().split(/\s+/) ?? [];
  const confirmed = /missing="([^"]+)"/.exec(workflow)?.[1]?.trim().split(/\s+/) ?? [];

  for (const name of publishable) {
    assert.ok(loop.includes(name), `@agentcomms/${name} is publishable but the release workflow never publishes it`);
    assert.ok(confirmed.includes(name), `@agentcomms/${name} is published but never confirmed against the registry`);
  }
  // And nothing in the lists that is not a real package, which would make the confirm step hang on a 404.
  for (const name of loop) {
    assert.ok(publishable.includes(name), `the workflow publishes @agentcomms/${name}, which is not a package here`);
  }
});
