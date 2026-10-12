import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { HELD, PACKAGES, PUBLISHABLE } from '../scripts/packages.mjs';

// Held declaration: ../packages/events-daemon/package.json
// desktop-mutation: desktop-release-hold
test('desktop-release-hold: desktop evidence cannot lift npm holds or change release selection', async () => {
  for (const name of ['events', 'events-daemon']) {
    assert.ok(HELD[name], `${name} hold removed`);
    assert.ok(PUBLISHABLE.includes(name));
    assert.ok(!PACKAGES.includes(name));
  }
  assert.ok(!PUBLISHABLE.includes('desktop'));
  const desktop = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
  assert.equal(desktop.private, true);
  const selector = await readFile(new URL('../scripts/packages.mjs', import.meta.url));
  assert.equal(
    createHash('sha256').update(selector).digest('hex'),
    '9c3cc40b777f0eb5baa190063d3a2cbf1e8f885a1ae643d639b481085cdedf5b',
  );
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const [readme, notes, releasing] = await Promise.all([
    read('../apps/desktop/README.md'),
    read('../apps/desktop/RELEASE_NOTES.md'),
    read('../docs/RELEASING.md'),
  ]);
  assert.doesNotMatch(notes, /inert Settings|attachment arrives/);
  const launch = (text) =>
    text.slice(text.indexOf('## macOS first launch'), text.indexOf('## Version 1 distribution limits')).trim();
  assert.ok(launch(readme));
  assert.equal(launch(notes), launch(readme));
  assert.ok(releasing.includes('full-production'));
  const workflow = JSON.parse(await read('../.github/workflows/desktop.yml'));
  const steps = workflow.jobs.verify.steps;
  const full = steps.find((step) => step.name === 'Full production evidence');
  assert.ok(full, 'missing three-platform full-production workflow gate');
  assert.match(full.run, /test:e2e -- --case full-production/);
  const mutations = steps.find((step) => step.name === 'Complete desktop mutation gate');
  assert.match(mutations?.run ?? '', /mutations\/run\.mjs --all/);
  assert.equal(mutations.if, undefined);
  const archive = steps.find((step) => step.name === 'Synthetic failure evidence');
  assert.equal(archive?.if, 'failure()');
  assert.equal(archive.with.path, 'apps/desktop/test/evidence/*.json');
  const release = JSON.parse(await read('../.github/workflows/desktop-release.yml'));
  assert.equal(release.jobs.verify.uses, './.github/workflows/desktop.yml');
});
