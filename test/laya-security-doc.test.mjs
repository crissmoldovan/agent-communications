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
import { assertLoopbackSeal } from './helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

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
  // Beside D2's two bullets, SECURITY.md's own bullet on what the macOS profile denies beyond the network (E2 review
  // round 1, A1), in scope after D2's network bullet: one Laya more, and no other.
  const profile = lines.filter((line) => line.startsWith('- **The Laya worker acting outside its profile** — '));
  assert.equal(profile.length, 1, "SECURITY.md's own profile bullet, exactly once");
  assert.ok(section(security, '## Scope').includes(`\n${NETWORK}\n${profile[0]}\n`), 'right after the network bullet');
  assert.equal(security.split('Laya').length - 1, 9, 'and no other Laya wording beside them');
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
  // The entry of the release that ships Laya dormant: 0.25.0's once released, `## Unreleased` until then. It says what
  // changes when you update (review round 1, B2), so it no longer claims that nothing does.
  const heading = changelog.includes('\n## 0.25.0\n') ? '\n## 0.25.0\n' : '\n## Unreleased\n';
  const start = changelog.indexOf(heading);
  assert.ok(start > -1, 'the changelog has the entry that ships Laya dormant');
  const unreleased = flat(changelog.slice(start, changelog.indexOf('\n## ', start + heading.length)));
  for (const fact of [
    /Laya/,
    /macOS/,
    /English/,
    /never leaves (?:this|your) Mac/,
    /E2_EXTERNAL_REFERENCE_BLOCKED/,
    /schema 23/,
  ]) {
    assert.match(unreleased, fact, `the changelog's Laya entry says ${fact}`);
  }
  assert.doesNotMatch(unreleased, /nothing changes when you update/i, 'the entry does not claim that nothing changes');
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
    /macos-boundary-v2\.json/,
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

test('E2 review round 1: the documents claim only the checks that run, and keep the corpus key off the gate Mac', async () => {
  const [runtimeReadme, releasing, gateWorkflow] = await Promise.all([
    readFile(join(ROOT, 'packages/events-laya-runtime/README.md'), 'utf8'),
    readFile(join(ROOT, 'docs/RELEASING.md'), 'utf8'),
    readFile(join(ROOT, '.github/workflows/laya-quality-gate.yml'), 'utf8'),
  ]);
  const flat = (text) => text.replace(/\s+/g, ' ');
  // B9: `pnpm verify` runs the cold-store probe's self-test; the cold-store install itself runs in no workflow.
  const runtime = flat(runtimeReadme);
  assert.doesNotMatch(runtime, /proves from a cold store/);
  assert.match(runtime, /The cold-store install itself .* runs in no workflow; it is a check to run by hand/);
  // A4 and B9: the egress step checks TCP 443 to three addresses and nothing else, and the key is a secret.
  const procedure = flat(section(releasing, '## Laya: the local model judge'));
  assert.match(procedure, /checks only that a TCP connection to each of three public addresses on port 443/);
  assert.match(procedure, /it does not check DNS, another port or another address/);
  assert.doesNotMatch(procedure, /fails if it can reach an outside address|no secret or registry credential/);
  assert.match(procedure, /`AGENTCOMMS_LAYA_GATE_CORPUS_KEY` secret of the `laya-quality-gate` environment/);
  assert.doesNotMatch(procedure, /AGENTCOMMS_LAYA_GATE_KEY_FILE/);
  assert.doesNotMatch(flat(gateWorkflow), /no secret,|the egress step proves a connection elsewhere fails/);
});
