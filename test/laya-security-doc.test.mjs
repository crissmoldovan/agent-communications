/**
 * Laya's security and documentation contract (events E2 Task 10): SECURITY.md carries D2's two Laya bullets word for
 * word, and the documents a person reads say what Laya is, where it runs, its limits, and that it is not offered yet,
 * without promising a protection the design does not give.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers/laya-release-fixture.mjs';

const SPEC = 'docs/superpowers/specs/2026-10-05-local-event-emission-design.md';

/** D2's own words: the vulnerability bullet, and the bullet under "What the safety model does not claim". */
const NETWORK =
  "- **Network access by the Laya worker** — on macOS, the only platform where this version offers Laya, any network connection the Laya worker process makes, a Unix-domain socket connection included; the Laya runtime or model being loaded before the `sandbox-exec` boundary has passed its start-up check; or any runtime or model file being loaded that does not match the release's runtime lock and model manifest.";
const OFFLINE =
  "- **Laya is kept off the network by the operating system, and only where stated.** On macOS the boundary is a `sandbox-exec` profile that denies all network access, Unix-domain sockets included, and Apple marks `sandbox-exec` deprecated; if it stops applying, Laya is not offered. Laya is not available on Linux or Windows in this version. Code inside the worker that refuses network calls is defence in depth, not the boundary. The boundary does not protect against another process of the same user, and the daemon's one-time downloads of the Laya runtime and model are ordinary network traffic.";

/** A quoted spec bullet, unwrapped: its `> - ` line and every `>   ` continuation, joined by single spaces. */
function specBullet(spec, opening) {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`> - ${opening}`));
  assert.notEqual(start, -1, `the spec quotes ${opening}`);
  const parts = [lines[start].slice(2)];
  for (let index = start + 1; lines[index]?.startsWith('>   '); index += 1) parts.push(lines[index].slice(4));
  return parts.map((part) => part.trim()).join(' ');
}

/** The section of a Markdown document under `heading`, up to the next heading of the same level. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `there is a ${heading} section`);
  const level = heading.split(' ')[0];
  const end = text.indexOf(`\n${level} `, start + heading.length + 2);
  return text.slice(start, end === -1 ? undefined : end);
}

test("E2 SECURITY Laya wording: SECURITY.md carries D2's two Laya bullets, word for word, once each", async () => {
  const [security, spec] = await Promise.all([
    readFile(join(ROOT, 'SECURITY.md'), 'utf8'),
    readFile(join(ROOT, SPEC), 'utf8'),
  ]);
  assert.equal(specBullet(spec, '**Network access by the Laya worker**'), NETWORK, 'D2 still says this');
  assert.equal(
    specBullet(spec, '**Laya is kept off the network by the operating system, and only where stated.**'),
    OFFLINE,
    'D2 still says this',
  );
  const lines = security.split('\n');
  assert.equal(lines.filter((line) => line === NETWORK).length, 1, 'the vulnerability bullet, exactly once');
  assert.equal(lines.filter((line) => line === OFFLINE).length, 1, 'the safety-model bullet, exactly once');
  // Where D2 puts them: a vulnerability is in scope, and the limit is something the safety model does not claim.
  assert.ok(section(security, '## Scope').includes(`\n${NETWORK}\n`), 'the network bullet is in scope');
  assert.ok(
    section(security, '## What the safety model does not claim').includes(`\n${OFFLINE}\n`),
    'the limit is under what the safety model does not claim',
  );
  assert.equal(security.split('Laya').length - 1, 8, 'and no other Laya wording beside them');
});

test('E2 SECURITY Laya wording: the documents state the limits, and promise no protection from the same user', async () => {
  const [daemonReadme, runtimeReadme, releasing, changelog] = await Promise.all([
    readFile(join(ROOT, 'packages/events-daemon/README.md'), 'utf8'),
    readFile(join(ROOT, 'packages/events-laya-runtime/README.md'), 'utf8'),
    readFile(join(ROOT, 'docs/RELEASING.md'), 'utf8'),
    readFile(join(ROOT, 'CHANGELOG.md'), 'utf8'),
  ]);
  const flat = (text) => text.replace(/\s+/g, ' ');
  const laya = flat(daemonReadme.slice(daemonReadme.indexOf('The third kind, **`laya`**')).split('\n\n')[0]);
  for (const fact of [
    /This release does not offer it yet/,
    /macOS/,
    /English/,
    /CPU/,
    /`sandbox-exec`/,
    /ordinary network traffic/,
    /quality gate/,
    /E2_EXTERNAL_REFERENCE_BLOCKED/,
  ]) {
    assert.match(laya, fact, `the daemon README's Laya paragraph says ${fact}`);
  }
  const unreleased = flat(changelog.slice(changelog.indexOf('## Unreleased'), changelog.indexOf('\n## 0.')));
  for (const fact of [/Laya/, /nothing changes/i, /macOS/, /English/, /never leaves (?:this|your) Mac/]) {
    assert.match(unreleased, fact, `the changelog's Unreleased entry says ${fact}`);
  }
  const runtime = flat(runtimeReadme);
  for (const fact of [
    /never published/,
    /--filter '!@agentcomms\/events-laya-runtime'/,
    /written consent/,
    /encrypted/,
    /aggregate/,
    /protected/,
  ]) {
    assert.match(runtime, fact, `the private runtime README says ${fact}`);
  }
  const procedure = flat(section(releasing, '## Laya: the local model judge'));
  for (const fact of [
    /consent/,
    /encrypted/i,
    /aggregate/i,
    /no provider/i,
    /protected/,
    /Rosetta/,
    /laya-candidate-/,
    /macos-boundary-v1\.json/,
  ]) {
    assert.match(procedure, fact, `RELEASING.md's Laya section says ${fact}`);
  }
  // Same-user protection is a stated non-goal (D2): no document may promise it.
  for (const [name, text] of [
    ['the daemon README', daemonReadme],
    ['the runtime README', runtimeReadme],
    ['RELEASING.md', releasing],
    ['the changelog entry', unreleased],
  ]) {
    assert.doesNotMatch(
      flat(text),
      /(?<!not |never |nor )protects? (?:it |Laya |you )?(?:from|against) (?:another|other) (?:process|program)/i,
      `${name} promises protection from another process of the same user`,
    );
  }
});
