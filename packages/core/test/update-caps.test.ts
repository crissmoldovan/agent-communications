import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { type GatedChange, gatedChange } from '../src/change-flow.ts';
import type { Streams } from '../src/cli-runtime.ts';
import type { ConfigV2 } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { doctor } from '../src/operations/maintenance.ts';
import { orgAddChange, orgUpdateChange } from '../src/operations/organisations.ts';
import { updateLevelChange } from '../src/operations/update-settings.ts';
import { readProfileFile, shownPath, updatesPathFor } from '../src/organisations.ts';
import { checkForUpdates } from '../src/update-check.ts';
import { updateNoticeAtTerminal, updateToolNotice } from '../src/update-gate.ts';
import { effectiveUpdates } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { readAsReleased0190 } from './fixtures/profile-schema-0.19.0.ts';
import { deps, LATEST, type Machine, machine, markJobSetUp, seed } from './helpers/update-machine.ts';

/*
 * Organisations can only tighten (design 2026-10-16, U8): an organisation's caps — `max`, the most this machine may
 * update, and `background: false`, no background job — come in `<profile>.updates.json` beside its profile, never in
 * the profile itself. Every release from 0.13.0 to 0.19.0 refuses a profile carrying any key it does not know, so a key
 * there would break `org update` for every member not yet on 0.20.0; they never open the file beside it. It is read
 * with the profile, bound by its own SHA-256 under the same approval, and a member can never update past it.
 */

const PROFILE = {
  agentcomms: 'organisation-profile',
  version: 1,
  organisation: 'acme',
  label: 'Acme Test Org',
  slack: { workspace: 'TACME0001', workspaceName: 'Acme', redirectPort: 51234, apps: { read: { clientId: '1.2' } } },
};

interface Org {
  m: Machine;
  profile: string;
  updates: string;
}

function org(caps?: Record<string, unknown>, config: Record<string, unknown> = {}): Org {
  const m = machine({}, config);
  const dir = join(m.home, 'profiles');
  mkdirSync(dir, { recursive: true });
  const profile = join(dir, 'acme.agentcomms.json');
  writeFileSync(profile, `${JSON.stringify(PROFILE, null, 2)}\n`);
  const updates = join(dir, 'acme.agentcomms.updates.json');
  if (caps !== undefined) writeFileSync(updates, `${JSON.stringify({ organisation: 'acme', ...caps }, null, 2)}\n`);
  return { m, profile, updates };
}

const options = (m: Machine) => ({ env: m.env, platform: 'darwin' as const, surface: 'mcp' as const, keyring: null });

/** A change made as an agent makes it: the first call, and the call that brings the approval back if it asks. */
async function approved<T>(o: Org, build: (approvalId?: string) => GatedChange<T>) {
  const first = await gatedChange(o.m.core, build(), { channel: 'core', surface: 'mcp' });
  if (first.status === 'applied') return { prepared: null, result: first.result };
  const second = await gatedChange(o.m.core, build(first.prepared.approvalId), {
    channel: 'core',
    surface: 'mcp',
    approvalId: first.prepared.approvalId,
  });
  assert.equal(second.status, 'applied');
  return { prepared: first.prepared, result: (second as { result: T }).result };
}

const add = (o: Org) =>
  approved(o, (approvalId) => orgAddChange(o.m.core, { file: o.profile, approvalId }, options(o.m)));
const update = (o: Org) =>
  approved(o, (approvalId) => orgUpdateChange(o.m.core, { organisation: 'acme', approvalId }, options(o.m)));

const serverNotice = (m: Machine) =>
  updateToolNotice({ core: m.core, env: m.env, channel: 'core', running: VERSION, exempt: [] })('comms_audit_tail');

async function commandNotice(m: Machine): Promise<string> {
  let said = '';
  const stderr = new PassThrough();
  stderr.on('data', (chunk) => {
    said += String(chunk);
  });
  await updateNoticeAtTerminal({
    core: m.core,
    env: m.env,
    channel: 'core',
    running: VERSION,
    output: { json: true, color: false },
    streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr } as unknown as Streams,
  });
  return said;
}

// ── The profile stays as every release reads it ─────────────────────────────────────────────────────────────────

test('an organisation that caps updates publishes a profile 0.19.0 still reads, and this release reads the caps beside it', async () => {
  const o = org({ max: 'every-14-days', background: false });
  // The bytes a member on 0.19.0 — or any release since 0.13.0 — reads at `org update`: accepted, unchanged.
  assert.deepEqual(readAsReleased0190(readFileSync(o.profile, 'utf8')), { ok: true });
  // The same caps inside the profile would be refused there, for the whole document: so they are not put there.
  const inside = readAsReleased0190(JSON.stringify({ ...PROFILE, updates: { max: 'never' } }));
  assert.equal(inside.ok, false);
  assert.match(inside.ok ? '' : inside.issues.join('; '), /updates is not a key/);
  // This release reads the profile as before, and the caps from the file beside it.
  assert.equal(updatesPathFor(o.profile), o.updates);
  const read = await readProfileFile(o.profile);
  assert.equal(read.profile.organisation, 'acme');
  assert.deepEqual(
    [read.updates?.max, read.updates?.background, read.updates?.path],
    ['every-14-days', false, o.updates],
  );
  assert.match(read.updates?.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(read.updates?.sha256, read.sha256, 'each file is bound by its own SHA-256');
  // No file beside it: no caps, and the profile reads exactly as it did.
  const none = org();
  assert.equal((await readProfileFile(none.profile)).updates, undefined);
});

test('the caps file only tightens, names its own organisation, and is as strict as the profile', async () => {
  for (const [caps, words] of [
    [{ max: 'auto' }, /max/],
    [{ max: 'weekly' }, /max/],
    [{ background: true }, /background/],
    [{ max: 'never', extra: 1 }, /"extra" is not a key/],
    [{ organisation: 'other' }, /names the organisation other, not acme/],
  ] as const) {
    const o = org(caps as Record<string, unknown>);
    await assert.rejects(readProfileFile(o.profile), (error: unknown) => {
      assert.ok(error instanceof CommsError, String(error));
      assert.equal(error.code, 'BAD_DATA', JSON.stringify(caps));
      assert.match(
        error.message,
        new RegExp(`the updates file ${shownPath(o.updates).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
      assert.match(error.message, words, JSON.stringify(caps));
      return true;
    });
  }
});

test('a profile named through a symbolic link has its side files read beside the file it links to, not beside the link', {
  skip: process.platform === 'win32' ? 'a symbolic link needs Developer Mode on Windows' : false,
}, async () => {
  const o = org({ max: 'never', background: false });
  const agentApp = join(dirname(o.profile), 'acme.agentcomms.agent-app.json');
  writeFileSync(
    agentApp,
    `${JSON.stringify({
      agentcomms: 'organisation-agent-app',
      version: 1,
      organisation: 'acme',
      slack: { workspace: 'TACME0001', appId: 'A0AGENT0001' },
    })}\n`,
  );
  // The person keeps a link to the organisation's checkout, by a path relative to the link's folder.
  const elsewhere = join(o.m.home, 'elsewhere');
  mkdirSync(elsewhere);
  const link = join(elsewhere, 'acme.json');
  symlinkSync(relative(elsewhere, o.profile), link);
  // Beside the link is not where the organisation keeps its caps: a file there says nothing.
  writeFileSync(
    join(elsewhere, 'acme.updates.json'),
    `${JSON.stringify({ organisation: 'acme', max: 'every-14-days' })}\n`,
  );
  const read = await readProfileFile(link);
  assert.equal(read.path, link, 'the path the person chose is the one recorded, and read again');
  assert.deepEqual([read.updates?.max, read.updates?.background, read.updates?.path], ['never', false, o.updates]);
  assert.equal(read.agentApp?.appId, 'A0AGENT0001');
  assert.equal(read.agentApp?.path, agentApp);
  // A link to the link: followed to the file at the end.
  const chain = join(elsewhere, 'chain.json');
  symlinkSync(link, chain);
  assert.equal((await readProfileFile(chain)).updates?.path, o.updates);
  // Added through the link, the caps are in force, and where they come from is the file they were read from.
  await approved(o, (approvalId) => orgAddChange(o.m.core, { file: link, approvalId }, options(o.m)));
  const capped = await effectiveUpdates(o.m.core, o.m.env);
  assert.deepEqual([capped.level, capped.cap?.source, capped.backgroundOff?.source], ['never', o.updates, o.updates]);
});

// ── Adding and changing them ─────────────────────────────────────────────────────────────────────────────────────

test('caps are added with the profile, under its approval, and its preview says what they do', async () => {
  const o = org({ max: 'never' });
  const { prepared } = await add(o);
  assert.ok(prepared, 'adding a profile is approved first');
  assert.match(prepared.preview, /caps how this machine updates at never/);
  assert.match(
    prepared.preview,
    new RegExp(`read from ${shownPath(o.updates).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  const record = ((await o.m.core.config.load()) as ConfigV2).organisations?.acme;
  assert.equal(record?.updates?.max, 'never');
  assert.match(String(record?.updates?.sha256), /^[0-9a-f]{64}$/);
});

test('a changed caps file, or one gone, is approved first even with the profile unchanged; a hand-edited record is put back at once', async () => {
  const o = org({ max: 'every-14-days' });
  await add(o);
  // Changed: the organisation now says never.
  writeFileSync(o.updates, `${JSON.stringify({ organisation: 'acme', max: 'never' })}\n`);
  const changed = await update(o);
  assert.ok(changed.prepared, 'a changed caps file was applied without an approval');
  assert.match(changed.prepared.preview, /updates: at most every-14-days → at most never/);
  assert.equal(((await o.m.core.config.load()) as ConfigV2).organisations?.acme?.updates?.max, 'never');
  // Gone: the organisation lifts its caps, which is a change of what it says, approved first too.
  rmSync(o.updates);
  const gone = await update(o);
  assert.ok(gone.prepared, 'a caps file gone was applied without an approval');
  assert.match(gone.prepared.preview, /updates: at most never → no caps/);
  assert.equal(((await o.m.core.config.load()) as ConfigV2).organisations?.acme?.updates, undefined);
  // Hand-edited: the record says otherwise than the file it was read from. Put back at once.
  writeFileSync(o.updates, `${JSON.stringify({ organisation: 'acme', max: 'never' })}\n`);
  await update(o);
  const path = o.m.configPath;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ConfigV2;
  const acme = raw.organisations?.acme as { updates?: { max?: string } };
  acme.updates = { ...acme.updates, max: 'every-14-days' };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  const repaired = await update(o);
  assert.equal(repaired.prepared, null, 'putting the record back asked for an approval');
  assert.equal(((await o.m.core.config.load()) as ConfigV2).organisations?.acme?.updates?.max, 'never');
});

// ── What the caps do ─────────────────────────────────────────────────────────────────────────────────────────────

test('a member’s level is capped at max: every-14-days spaces the check and the notice; never asks nobody', async () => {
  const spaced = org({ max: 'every-14-days' });
  await add(spaced);
  const capped = await effectiveUpdates(spaced.m.core, spaced.m.env);
  assert.deepEqual(
    [capped.level, capped.set, capped.cap?.organisation, capped.cap?.level],
    ['every-14-days', 'auto', 'acme', 'every-14-days'],
  );
  // The member asks for auto: it is set, the result says the cap stands, and it does — never past the profile.
  const chosen = await gatedChange(spaced.m.core, updateLevelChange(spaced.m.core, 'auto'), {
    channel: 'core',
    surface: 'mcp',
  });
  assert.deepEqual((chosen as { result: { cappedAt?: unknown } }).result.cappedAt, {
    level: 'every-14-days',
    organisation: 'acme',
  });
  assert.equal((await effectiveUpdates(spaced.m.core, spaced.m.env)).level, 'every-14-days');

  const never = org({ max: 'never' });
  await add(never);
  const asked: string[] = [];
  const outcome = await checkForUpdates(never.m.core, never.m.env, {
    deps: deps(async (name) => {
      asked.push(name);
      return LATEST;
    }),
  });
  assert.equal(outcome.asked, false);
  assert.deepEqual(asked, [], 'a member capped at never asked the registry');
  await seed(never.m, { latest: LATEST, behind: true });
  assert.equal(await serverNotice(never.m), null);
  assert.equal(await commandNotice(never.m), '');
});

test('background: false turns auto into a daily check with a notice, even with the job set up', async () => {
  const o = org({ background: false });
  await add(o);
  markJobSetUp(o.m);
  const updates = await effectiveUpdates(o.m.core, o.m.env);
  assert.deepEqual([updates.level, updates.background, updates.backgroundOff?.organisation], ['auto', false, 'acme']);
  // A minor release the job would have installed: with the job held off, it is the notice.
  const running = VERSION.split('.').map(Number) as [number, number, number];
  await seed(o.m, { latest: `${running[0]}.${running[1] + 1}.0`, behind: true });
  assert.match(String(await serverNotice(o.m)), /is out; say "update"/);
});

test('the doctor names the cap and where it comes from', async () => {
  const o = org({ max: 'every-14-days', background: false });
  await add(o);
  const report = await doctor(o.m.core, o.m.env, { keyring: null, platform: 'darwin' });
  const line = report.checks.find((check) => check.name === 'update check');
  assert.match(String(line?.detail), /^every-14-days \(capped by acme’s profile, .*acme\.agentcomms\.updates\.json\)/);
  assert.match(String(line?.detail), /background updates off by acme’s profile/);
});

/** config.json made unreadable as this release reads it: still JSON, and refused by its schema. */
function breakConfig(o: Org): void {
  const raw = JSON.parse(readFileSync(o.m.configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(o.m.configPath, `${JSON.stringify({ ...raw, accounts: 'not a map' }, null, 2)}\n`);
}

test('an unreadable config.json fails closed for the cap: the strictest cap of the organisation files still readable holds', async () => {
  const o = org({ max: 'never', background: false });
  await add(o);
  breakConfig(o);
  await assert.rejects(o.m.core.config.load(), 'the configuration is unreadable, as the test means it to be');
  const updates = await effectiveUpdates(o.m.core, o.m.env);
  assert.deepEqual(
    [
      updates.level,
      updates.cap?.organisation,
      updates.cap?.source,
      updates.backgroundOff?.organisation,
      updates.background,
    ],
    ['never', 'acme', o.updates, 'acme', false],
  );
  assert.match(String(updates.unreadableConfig?.reason), /config\.json/);
  // never asks nobody, as with the configuration read.
  const asked: string[] = [];
  const outcome = await checkForUpdates(o.m.core, o.m.env, {
    deps: deps(async (name) => {
      asked.push(name);
      return LATEST;
    }),
  });
  assert.equal(outcome.asked, false);
  assert.deepEqual(asked, [], 'a member capped at never asked the registry with config.json unreadable');
  await seed(o.m, { latest: LATEST, behind: true });
  assert.equal(await serverNotice(o.m), null);
  // The doctor says the configuration could not be read, and where the cap in force comes from instead.
  const report = await doctor(o.m.core, o.m.env, { keyring: null, platform: 'darwin' });
  const line = report.checks.find((check) => check.name === 'update check');
  assert.equal(line?.warn, true);
  assert.match(String(line?.detail), /^never \(capped by acme’s profile, .*acme\.agentcomms\.updates\.json\)/);
  assert.match(
    String(line?.detail),
    /config\.json could not be read, so the caps of the organisation files still readable hold/,
  );
});

test('with config.json unreadable, a caps file gone or broken still caps by what was recorded of it, and the strictest wins', async () => {
  // Gone since it was recorded: the record of it, read loosely from the file, still caps.
  const gone = org({ max: 'never' });
  await add(gone);
  rmSync(gone.updates);
  breakConfig(gone);
  assert.equal((await effectiveUpdates(gone.m.core, gone.m.env)).level, 'never');
  // Broken since: it cannot be read, and what was recorded of it stands.
  const broken = org({ max: 'every-14-days' });
  await add(broken);
  writeFileSync(broken.updates, '{ not json');
  breakConfig(broken);
  assert.equal((await effectiveUpdates(broken.m.core, broken.m.env)).level, 'every-14-days');
  // Changed since to stricter: the file, read again, is stricter than the record, and the stricter holds.
  const tighter = org({ max: 'every-14-days' });
  await add(tighter);
  writeFileSync(tighter.updates, `${JSON.stringify({ organisation: 'acme', max: 'never' })}\n`);
  breakConfig(tighter);
  assert.equal((await effectiveUpdates(tighter.m.core, tighter.m.env)).level, 'never');
  // Nothing to read in its place — not JSON at all, so no organisation can be found: the default, and the doctor says so.
  const lost = org({ max: 'never' });
  await add(lost);
  writeFileSync(lost.m.configPath, '{ not json');
  const updates = await effectiveUpdates(lost.m.core, lost.m.env);
  assert.deepEqual([updates.level, updates.cap, updates.background], ['auto', undefined, false]);
  const report = await doctor(lost.m.core, lost.m.env, { keyring: null, platform: 'darwin' });
  const line = report.checks.find((check) => check.name === 'update check');
  assert.equal(line?.warn, true);
  assert.match(String(line?.detail), /^auto \(a daily check with a notice\) · /);
  assert.match(
    String(line?.detail),
    /config\.json could not be read, and no organisation’s caps could be read in its place/,
  );
});

test('an organisation with no caps file changes nothing', async () => {
  const o = org();
  await add(o);
  const record = ((await o.m.core.config.load()) as ConfigV2).organisations?.acme;
  assert.equal(record?.updates, undefined);
  const updates = await effectiveUpdates(o.m.core, o.m.env);
  assert.deepEqual([updates.level, updates.cap, updates.backgroundOff], ['auto', undefined, undefined]);
});
